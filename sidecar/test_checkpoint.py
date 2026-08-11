"""Checkpoint correctness tests (RAM resume + disk-checkpoint invalidation).

Run: uv run python test_checkpoint.py   (or .venv/bin/python test_checkpoint.py)

Guards the checkpointing correctness/perf pass:
  - resume-from-cache must byte-match a full rebuild (the core checkpoint invariant),
  - a resume must replay DIAGNOSTICS, not just errors, on BOTH tiers — the frontend
    gates its "Re-pick face" repair on the ambiguity diagnostic, so dropping it
    silently removes a user-facing repair path,
  - every diagnostic shape must survive json.dumps (a checkpoint write that raises
    is swallowed, which would silently disable the disk cache),
  - _body_fingerprint carries exact edge/vertex counts (catches same-volume divergence),
  - _env_sig tracks selector_tuning.json bytes (tuning edits invalidate disk checkpoints).
"""

import json
import os
import shutil
import sys
import tempfile

os.environ.setdefault("SINDRI_DISK_CACHE", "0")  # these tests exercise the RAM path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402
from build123d import Box, Cylinder  # noqa: E402

PASS = "  ok"

DOC = {
    "parameters": {"w": 40, "h": 20, "t": 5},
    "features": [
        {"id": "f1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": "w", "height": "h", "x": 0, "y": 0}]},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": "t", "operation": "new"},
        {"id": "f3", "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "radius": 3, "x": -12, "y": 0}]},
        {"id": "f4", "type": "extrude", "sketch": "f3", "distance": "t", "operation": "cut"},
        {"id": "f5", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 2},
    ],
}

# A document whose PREFIX emits a diagnostic. The press/pull's stored point sits
# exactly on the shared edge of the top face (z=10) and the +X side face (x=20),
# so `by:"nearest"` is an exact tie: the ambiguity gate refuses it and records an
# `ambiguous nearest pick` diagnostic alongside the error. The fillet after it is
# what the resume test edits.
DIAG_DOC = {
    "parameters": {},
    "features": [
        {"id": "d1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 40, "height": 40, "x": 0, "y": 0}]},
        {"id": "d2", "type": "extrude", "sketch": "d1", "distance": 10, "operation": "new"},
        {"id": "d3", "type": "press-pull",
         "face": {"kind": "face", "by": "nearest", "point": [20, 0, 10]},
         "distance": 3, "operation": "join"},
        {"id": "d4", "type": "fillet",
         "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 2},
    ],
}

# A textured body with a feature AFTER the texture, so a resume can start past it.
# The texture spec lives on the body dict, not in its shape, which is exactly why
# it needs explicit persistence.
TEX_DOC = {
    "parameters": {},
    "features": [
        {"id": "t1", "type": "sketch", "plane": "XY",
         "entities": [{"id": "r1", "type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
        {"id": "t2", "type": "extrude", "sketch": "t1", "distance": 5, "operation": "new"},
        {"id": "t3", "type": "texture", "kind": "knurl", "faces": {"by": "all"},
         "depth": 0.4, "scale": 2.0},
        {"id": "t4", "type": "fillet",
         "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 1},
    ],
}


def _sig(res, diags=None):
    """The invariant signature a resume must reproduce exactly.

    Diagnostics belong in here, not just errors: the frontend gates the "Re-pick
    face" repair on the `ambiguous nearest pick` diagnostic, so a resume that
    replays the error but drops the diagnostic silently removes a user-facing
    repair path while every geometric assertion still passes."""
    part, errors, bodies = res
    return (
        len(part.faces()), round(part.volume, 6), len(errors),
        sorted(str(e.get("feature_id")) for e in errors),
        sorted(len(b.get("owners") or {}) for b in bodies),
        sorted((str(d.get("feature_id")), str(d.get("reason"))) for d in (diags or [])),
    )


def _edit_feature(doc, idx, field, value):
    import copy
    d = copy.deepcopy(doc)
    d["features"][idx][field] = value  # a FEATURE edit (not a param) -> RAM prefix resume
    return d


def test_resume_equals_full():
    # populate the RAM snapshot cache for the base doc, then edit a late feature so the
    # rebuild RESUMES from the cached prefix, and assert it matches a from-scratch build.
    builder.rebuild_cached(DOC)
    edited = _edit_feature(DOC, 4, "radius", 1.5)  # f5 fillet radius 2 -> 1.5
    dr, df = [], []
    resumed = builder.rebuild_cached(edited, diagnostics=dr)
    full = builder.rebuild(edited, diagnostics=df)  # bare, no cache: full rebuild from scratch
    assert _sig(resumed, dr) == _sig(full, df), \
        f"resume diverged from full:\n {_sig(resumed, dr)}\n {_sig(full, df)}"

    # also a mid-timeline edit (f2 extrude distance) — deeper resume
    builder.rebuild_cached(DOC)
    edited2 = _edit_feature(DOC, 1, "distance", 6)
    dr2, df2 = [], []
    assert (_sig(builder.rebuild_cached(edited2, diagnostics=dr2), dr2)
            == _sig(builder.rebuild(edited2, diagnostics=df2), df2)), "mid-edit resume diverged"
    print(PASS, "resume-from-cache byte-matches a full rebuild (late + mid edit)")


def test_diagnostics_survive_resume():
    """A resume must replay DIAGNOSTICS from the cached prefix, not just errors.

    DIAG_DOC's press/pull is refused by the ambiguity gate, which records both an
    error and an `ambiguous nearest pick` diagnostic. The edit targets the fillet
    AFTER it, so the resume restores that feature rather than re-running it — the
    exact case where the diagnostic used to vanish while the error survived, which
    left the "Re-pick face" toast action showing a bare "Show" instead."""
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    warm = []
    builder.rebuild_cached(DIAG_DOC, diagnostics=warm)
    assert any(d.get("reason") == "ambiguous nearest pick" for d in warm), \
        f"cold build must report the ambiguity in the first place: {warm}"

    edited = _edit_feature(DIAG_DOC, 3, "radius", 1.5)  # fillet radius; prefix is reused
    dr, df = [], []
    resumed = builder.rebuild_cached(edited, diagnostics=dr)
    full = builder.rebuild(edited, diagnostics=df)
    assert any(d.get("reason") == "ambiguous nearest pick" for d in dr), \
        f"the resumed build dropped the ambiguity diagnostic: {dr}"
    assert _sig(resumed, dr) == _sig(full, df), \
        f"resume diverged from full:\n {_sig(resumed, dr)}\n {_sig(full, df)}"
    print(PASS, "diagnostics survive a RAM resume (the ambiguity stays repairable)")


def test_diagnostics_survive_disk_resume():
    """The DISK tier must carry diagnostics too — and this is the tier that bites.

    RAM snapshots die with the worker; disk checkpoints are durable, so reopening
    a document the machine has built before always resumes from disk. Nothing else
    in the suite drives `_restore_from_disk`'s reconstruction end to end
    (test_refresh monkeypatches it to a forced miss, test_geomstore only round-trips
    an opaque state blob), so this covers the restored `errors` path as well.

    Checkpoint writes are debounced by build cost, and DIAG_DOC is far too cheap to
    trip the ~1 s budget — so drive `rebuild()` with a hand-built persist whose
    budget is 0, forcing a write after every feature. The write and the restore are
    both the production functions."""
    import geomstore

    tmp = tempfile.mkdtemp(prefix="sindri_ckpt_test_")
    orig_store = builder._disk_store
    try:
        store = geomstore.Store(root=tmp)
        builder._disk_store = lambda: store

        feats = DIAG_DOC["features"]
        keys = builder._chain_keys_scoped(DIAG_DOC, builder._feature_sigs(feats))
        cold = []
        builder.rebuild(
            DIAG_DOC, diagnostics=cold,
            persist={"store": store, "keys": keys, "mod": {},
                     "acc_ms": 0.0, "budget_ms": 0.0},
        )
        assert any(d.get("reason") == "ambiguous nearest pick" for d in cold), cold

        # the checkpoint must be restorable, and must carry the diagnostics
        hit = builder._restore_from_disk(store, keys)
        assert hit is not None, "no restorable checkpoint was written"
        start_i, snap, _mod = hit
        assert start_i > 0, start_i
        assert any(d.get("reason") == "ambiguous nearest pick"
                   for d in snap["diags_ref"][: snap["n_diags"]]), \
            f"the checkpoint dropped the diagnostic: {snap.get('diags_ref')}"

        # and the full production path: RAM cache cleared, so this resumes from disk
        builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
        warm = []
        builder.rebuild_cached(DIAG_DOC, diagnostics=warm)
        assert any(d.get("reason") == "ambiguous nearest pick" for d in warm), \
            f"a disk-resumed build dropped the ambiguity diagnostic: {warm}"
    finally:
        builder._disk_store = orig_store
        builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
        shutil.rmtree(tmp, ignore_errors=True)
    print(PASS, "diagnostics survive a DISK-checkpoint resume")


def test_every_diagnostic_shape_is_json_safe():
    """`_save_checkpoint` swallows exceptions, so a diagnostic carrying a value
    json can't encode (a numpy scalar, an OCCT handle) would not raise — it would
    silently stop writing checkpoints and make every rebuild cold. Assert the
    encode directly, over every producer's shape."""
    shapes = [
        # geom_select._push_diag, the ambiguity refusal (carries `at`/`candidates`)
        {"feature_id": "a", "kind": "face", "resolved": 0, "confidence": 0.0,
         "lossy": True, "reason": "ambiguous nearest pick",
         "at": [1.0, 2.0, 3.0], "candidates": ["a face at (0,0,0) area 1.0"]},
        # ...the same refusal with its machine-readable code and the structured
        # candidate fingerprints. These are AUTHORED FROM LIVE GEOMETRY, so this
        # is the shape most at risk of carrying an OCCT handle or a numpy scalar
        # that json cannot encode — which would not raise, it would silently
        # stop every checkpoint write and make every later rebuild cold.
        {"feature_id": "a2", "kind": "edge", "resolved": 0, "confidence": 0.01,
         "lossy": True, "reason": "ambiguous nearest pick",
         "code": "ambiguousReference", "at": [1.0, 2.0, 3.0],
         "candidates": ["an edge at (0,0,0) length 1.0"],
         "candidateFps": [
             {"fp": {"mid": [0.0, 0.0, 0.0], "dir": [0.0, 0.0, 1.0], "length": 20.0,
                     "curve": "line"}, "dist": 10.0},
             {"fp": {"mid": [1.0, 0.0, 0.0], "dir": [0.0, 0.0, 1.0], "length": 20.0,
                     "curve": "circle", "radius": 5.0, "center": [0.0, 0.0, 0.0],
                     "radius_rank": 0, "radius_group": 2}, "dist": 10.0},
         ]},
        # geom_select._push_diag, a plain low-confidence resolution
        {"feature_id": "b", "kind": "edge", "resolved": 1, "confidence": 0.4,
         "lossy": False, "reason": None},
        # builder._report_edge_failures
        {"feature_id": "c", "kind": "edgeOpFailed", "resolved": 2, "confidence": 0.0,
         "lossy": True, "reason": "per-edge", "failed": [{"mid": [1.0, 2.0, 3.0]}]},
        # builder._skip_feature
        {"feature_id": "d", "kind": "combine", "resolved": 0, "confidence": 0.0,
         "lossy": True, "reason": "target body already consumed or missing"},
        # texture.py
        {"feature_id": "e", "kind": "texture", "resolved": 1234, "confidence": 0.5,
         "lossy": True, "reason": "texture shown coarser than print detail"},
    ]
    json.dumps({"datums": {}, "errors": [], "diagnostics": shapes, "n": 0,
                "owners": {}, "fps": []})

    # and the shapes the live builder actually produces, not just hand-written ones
    real = []
    builder.rebuild(DIAG_DOC, diagnostics=real)
    assert real, "DIAG_DOC should produce at least one diagnostic"
    json.dumps(real)

    # DIAG_DOC cannot reach the ambiguity refusal (that path raises, so the
    # feature errors instead), and that is the one diagnostic whose payload is
    # authored FROM LIVE GEOMETRY — fingerprint floats straight off OCCT. A
    # hand-written copy of the shape proves nothing about the real thing's types.
    from build123d import Box
    from geom_select import resolve_faces

    live = []
    try:
        resolve_faces(Box(20, 20, 20), {"kind": "face", "by": "nearest", "point": [0, 0, 0]},
                      diag=live, feature_id="amb")
    except ValueError:
        pass
    amb = [d for d in live if d.get("candidateFps")]
    assert amb, "expected a live ambiguity diagnostic carrying candidateFps"
    json.dumps(amb)
    for rec in amb[0]["candidateFps"]:
        for v in rec["fp"].values():
            vals = v if isinstance(v, list) else [v]
            for x in vals:
                assert type(x) in (float, int, str), \
                    f"fingerprint carries a {type(x).__name__}, which json may not encode: {x!r}"
    print(PASS, "every diagnostic shape survives json.dumps (disk cache stays alive)")


def test_textures_survive_disk_resume():
    """A disk resume must keep a body's `_textures` spec list.

    `_handle_texture` never touches the body's OCCT shape — it appends the raw spec
    to `body["_textures"]` and displacement happens lazily at tessellation/export
    time. RAM snapshots keep the key for free (`_snapshot` does `dict(b)`), but the
    disk checkpoint serialises named fields only, so the spec used to vanish: a
    100% disk hit returned an UNTEXTURED body with no error, meaning reopening a
    textured document in a fresh session silently dropped the texture from what got
    rendered AND exported. `_owners` is the same kind of state and was already
    persisted; this is the one that was missed."""
    import geomstore

    tmp = tempfile.mkdtemp(prefix="sindri_tex_ckpt_")
    orig_store = builder._disk_store
    try:
        store = geomstore.Store(root=tmp)
        builder._disk_store = lambda: store
        feats = TEX_DOC["features"]
        keys = builder._chain_keys_scoped(TEX_DOC, builder._feature_sigs(feats))
        _p, errors, bodies = builder.rebuild(
            TEX_DOC,
            persist={"store": store, "keys": keys, "mod": {},
                     "acc_ms": 0.0, "budget_ms": 0.0},
        )
        assert not errors, errors
        cold = bodies[0].get("_textures")
        assert cold, "the cold build should carry the texture spec"

        hit = builder._restore_from_disk(store, keys)
        assert hit is not None, "no restorable checkpoint was written"
        restored = hit[1]["bodies"][0]
        assert restored.get("_textures") == cold, \
            f"the checkpoint dropped _textures: {restored.get('_textures')!r}"

        # production path: RAM cleared, so this resumes from disk
        builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
        _p2, _e2, b2 = builder.rebuild_cached(TEX_DOC)
        assert b2[0].get("_textures") == cold, \
            f"a disk-resumed build returned an untextured body: {b2[0].get('_textures')!r}"
    finally:
        builder._disk_store = orig_store
        builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
        shutil.rmtree(tmp, ignore_errors=True)
    print(PASS, "textures survive a DISK-checkpoint resume")


def test_body_fingerprint_carries_topology():
    fp = builder._body_fingerprint(Box(10, 10, 10))
    assert fp["f"] == 6 and fp["e"] == 12 and fp["vx"] == 8, fp
    # a topological change (drill a hole) moves edge/vertex counts, not just aggregates —
    # these fields close the same-volume/same-bbox collision the coarse fingerprint missed.
    holed = builder._body_fingerprint(Box(10, 10, 10) - Cylinder(2, 20))
    assert (holed["e"], holed["vx"]) != (12, 8), "edge/vertex counts must reflect topology"
    print(PASS, "_body_fingerprint carries exact edge/vertex counts")


def test_env_sig_tracks_tuning():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "selector_tuning.json")
    orig = open(p, "rb").read()
    builder._ENV_SIG = None
    s1 = builder._env_sig()
    try:
        open(p, "wb").write(orig + b"\n")  # byte-level change to the tuning file
        builder._ENV_SIG = None
        s2 = builder._env_sig()
    finally:
        open(p, "wb").write(orig)
        builder._ENV_SIG = None
    assert s1 != s2, "env_sig must change when selector_tuning.json changes (else stale disk resume)"
    print(PASS, "_env_sig invalidates on a selector_tuning.json edit")


def main():
    print("Checkpoint correctness tests")
    test_resume_equals_full()
    test_diagnostics_survive_resume()
    test_diagnostics_survive_disk_resume()
    test_textures_survive_disk_resume()
    test_every_diagnostic_shape_is_json_safe()
    test_body_fingerprint_carries_topology()
    test_env_sig_tracks_tuning()
    print("ALL PASS")


if __name__ == "__main__":
    main()
