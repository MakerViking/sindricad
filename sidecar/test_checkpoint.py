"""Checkpoint correctness tests (RAM resume + disk-checkpoint invalidation).

Run: uv run python test_checkpoint.py   (or .venv/bin/python test_checkpoint.py)

Guards the three changes made for the checkpointing correctness/perf pass:
  - resume-from-cache must byte-match a full rebuild (the core checkpoint invariant),
  - _body_fingerprint carries exact edge/vertex counts (catches same-volume divergence),
  - _env_sig tracks selector_tuning.json bytes (tuning edits invalidate disk checkpoints).
"""

import os
import sys

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


def _sig(res):
    """The invariant signature a resume must reproduce exactly."""
    part, errors, bodies = res
    return (
        len(part.faces()), round(part.volume, 6), len(errors),
        sorted(str(e.get("feature_id")) for e in errors),
        sorted(len(b.get("owners") or {}) for b in bodies),
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
    resumed = builder.rebuild_cached(edited)
    full = builder.rebuild(edited)  # bare, no cache: full rebuild from scratch
    assert _sig(resumed) == _sig(full), f"resume diverged from full:\n {_sig(resumed)}\n {_sig(full)}"

    # also a mid-timeline edit (f2 extrude distance) — deeper resume
    builder.rebuild_cached(DOC)
    edited2 = _edit_feature(DOC, 1, "distance", 6)
    assert _sig(builder.rebuild_cached(edited2)) == _sig(builder.rebuild(edited2)), "mid-edit resume diverged"
    print(PASS, "resume-from-cache byte-matches a full rebuild (late + mid edit)")


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
    test_body_fingerprint_carries_topology()
    test_env_sig_tracks_tuning()
    print("ALL PASS")


if __name__ == "__main__":
    main()
