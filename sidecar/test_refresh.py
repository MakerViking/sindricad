"""Associative projection refresh at rebuild time (step 4): _recompute_projections
runs in _handle_sketch when a `projections` accumulator is passed, emitting only
beyond-tolerance curve changes and stale TRANSITIONS (steady state emits
nothing), plus the rebuild_cached RESUME CAP that keeps a warm resume from
skipping past a projected sketch and letting a stale cached curve stick.

Run:  uv run python test_refresh.py   (or .venv/bin/python test_refresh.py)
"""

import copy
import os
import sys

os.environ.setdefault("SINDRI_DISK_CACHE", "0")  # RAM tier; the disk tier is monkeypatched
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402
from builder import project_geometry, rebuild, rebuild_cached, _curve_close  # noqa: E402

PASS = "  ok"

TOP = {"origin": [20, 15, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]}
WRONG = {"kind": "line", "x1": -99.0, "y1": -99.0, "x2": -98.0, "y2": -99.0}


def _base_features(w=40):
    return [
        {"id": "f1", "type": "sketch", "plane": "XY",
         "entities": [{"id": "r1", "type": "rectangle", "width": w, "height": 30,
                       "x": 20, "y": 15}]},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 10, "operation": "new"},
    ]


def _edge_source():
    """A REAL persisted source: pick the box's front top edge via the aux-op
    (exactly what the Project tool does) and keep the sidecar-authored fp."""
    prefix = {"parameters": {}, "features": _base_features()}
    r = project_geometry(prefix, TOP, [
        {"kind": "edge", "body": "body1",
         "sel": {"kind": "edge", "by": "nearest", "point": [20, 0, 10]}}])["results"][0]
    assert r["ok"], r
    fp = r["curves"][0]["fp"]
    true_curve = r["curves"][0]["curve"]
    src = {"kind": "edge", "body": "body1",
           "sel": {"kind": "edge", "by": "match", "fp": fp}}
    return src, true_curve


def _doc(cached, src, w=40, stale=False, tail=None):
    ent = {"id": "p1", "type": "projected", "source": src, "curve": cached}
    if stale:
        ent["stale"] = True
    feats = _base_features(w) + [
        {"id": "f3", "type": "sketch", "plane": TOP, "entities": [ent]},
    ]
    if tail:
        feats.extend(tail)
    return {"parameters": {}, "features": feats}


def test_wrong_cache_corrected():
    src, true_curve = _edge_source()
    p = []
    _part, err, _bodies = rebuild(_doc(WRONG, src), projections=p)
    assert not err, err
    assert len(p) == 1, p
    u = p[0]
    assert u["sketch"] == "f3" and u["entity"] == "p1" and u["stale"] is False, u
    assert _curve_close(u["curve"], true_curve, 1e-6), (u["curve"], true_curve)
    print(PASS, f"wrong cached curve corrected: {u['curve']}")
    return src, true_curve


def test_steady_state_quiet(src, true_curve):
    p = []
    _part, err, _bodies = rebuild(_doc(true_curve, src), projections=p)
    assert not err, err
    assert p == [], f"steady state must emit NOTHING, got {p}"
    print(PASS, "steady state emits no updates (convergence contract)")


def test_stale_transition_once(src, true_curve):
    # source body deleted (no extrude -> no body1): stale:true exactly ONCE
    doc = _doc(true_curve, src)
    doc["features"] = [f for f in doc["features"] if f["id"] != "f2"]
    p = []
    rebuild(doc, projections=p)
    assert p == [{"sketch": "f3", "entity": "p1", "stale": True}], p
    # the frontend applied it: entity now persists stale:true -> next rebuild quiet
    doc2 = copy.deepcopy(doc)
    doc2["features"][1]["entities"][0]["stale"] = True
    p2 = []
    rebuild(doc2, projections=p2)
    assert p2 == [], f"already-stale must not re-emit, got {p2}"
    print(PASS, "stale emitted once on the transition, silent while stale")


def test_stale_clears_when_source_returns(src, true_curve):
    # stale flag set but the source resolves again AND the curve is unchanged:
    # emit {curve, stale:false} so the frontend can clear the flag
    p = []
    rebuild(_doc(true_curve, src, stale=True), projections=p)
    assert len(p) == 1 and p[0]["stale"] is False, p
    assert _curve_close(p[0]["curve"], true_curve, 1e-6)
    print(PASS, "stale clears (stale:false emitted) when the source resolves again")


def test_upstream_change_moves_curve(src, true_curve):
    # widen the base rectangle: the projected front edge moves (y stays, x range
    # grows) -> exactly one update with the freshly-projected curve
    p = []
    _part, err, _bodies = rebuild(_doc(true_curve, src, w=60), projections=p)
    assert not err, err
    assert len(p) == 1 and p[0]["stale"] is False, p
    c = p[0]["curve"]
    assert c["kind"] == "line" and abs(abs(c["x2"] - c["x1"]) - 60) < 1e-6, c
    print(PASS, f"upstream width change refreshes the curve: {c}")


def test_sketch_curve_multi_edge_without_index_goes_stale():
    """A multi-edge source sibling WITHOUT a persisted source.index is
    unresolvable (the pick site has always written one): stale exactly once
    on the transition, silent while stale — never a positional guess."""
    def sk_doc(stale=False):
        ents = []
        for i in range(1, 5):
            e = {"id": f"e{i}", "type": "projected",
                 "source": {"kind": "sketchCurve", "sketch": "f1", "entity": "r1",
                            "group": "e1"},
                 "curve": dict(WRONG)}
            if stale:
                e["stale"] = True
            ents.append(e)
        return {"parameters": {}, "features": [
            {"id": "f1", "type": "sketch", "plane": "XY",
             "entities": [{"id": "r1", "type": "rectangle", "width": 20, "height": 10,
                           "x": 0, "y": 0}]},
            {"id": "f3", "type": "sketch", "plane": TOP, "entities": ents},
        ]}

    p = []
    rebuild(sk_doc(), projections=p)
    assert sorted((u["entity"], u["stale"]) for u in p) == \
        [(f"e{i}", True) for i in range(1, 5)], p
    p2 = []
    rebuild(sk_doc(stale=True), projections=p2)
    assert p2 == [], f"already-stale must not re-emit, got {p2}"
    print(PASS, "multi-edge sibling without an index goes stale (once)")


def test_sketch_curve_index_survives_deletion():
    """Persisted source.index (what the pick site writes) keeps per-edge
    identity even after a sibling was DELETED and the source later moves —
    the legacy surviving-sibling positional fallback would shift e3/e4 onto
    their dead sibling's edges."""
    def sk_doc(rect_x, ids, cached_by_id):
        ents = [
            {"id": eid, "type": "projected",
             "source": {"kind": "sketchCurve", "sketch": "f1", "entity": "r1",
                        "group": "e1", "index": i},
             "curve": cached_by_id[eid]}
            for i, eid in ids
        ]
        return {"parameters": {}, "features": [
            {"id": "f1", "type": "sketch", "plane": "XY",
             "entities": [{"id": "r1", "type": "rectangle", "width": 20, "height": 10,
                           "x": rect_x, "y": 0}]},
            {"id": "f3", "type": "sketch", "plane": TOP, "entities": ents},
        ]}

    all_ids = [(i - 1, f"e{i}") for i in range(1, 5)]
    garbage = {k: dict(WRONG) for k in ("e1", "e2", "e3", "e4")}
    p = []
    rebuild(sk_doc(0, all_ids, garbage), projections=p)
    seeded = {u["entity"]: u["curve"] for u in p}
    assert len(seeded) == 4, p
    # delete e2, THEN move the source: e3/e4 must track their OWN edges (2, 3)
    survivors = [(0, "e1"), (2, "e3"), (3, "e4")]
    p2 = []
    rebuild(sk_doc(5, survivors, seeded), projections=p2)
    assert len(p2) == 3, p2
    for u in p2:
        old, new = seeded[u["entity"]], u["curve"]
        for a, b in (("x1", "y1"), ("x2", "y2")):
            assert abs(new[a] - old[a] - 5) < 1e-6 and abs(new[b] - old[b]) < 1e-6, \
                f"{u['entity']}: {old} -> {new} (index correspondence broke after deletion)"
    print(PASS, "source.index keeps edge identity after a sibling deletion + move")


def test_chain_projection_of_projected_curve():
    """Chain projection: a committed sketch's PROJECTED line is itself a valid
    sketchCurve source — _entity_edges builds its cached curve like any native
    entity. Pick time resolves it (TOP -> TOP returns the curve verbatim), and
    the rebuild refresh tracks it instead of going permanently stale."""
    src, true_curve = _edge_source()
    doc = _doc(true_curve, src, tail=[
        {"id": "f4", "type": "sketch", "plane": TOP, "entities": [
            {"id": "q1", "type": "projected",
             "source": {"kind": "sketchCurve", "sketch": "f3", "entity": "p1"},
             "curve": dict(WRONG)}]},
    ])
    r = project_geometry(doc, TOP, [
        {"kind": "sketchCurve", "sketch": "f3", "entity": "p1"}])["results"][0]
    assert r["ok"], r
    assert len(r["curves"]) == 1
    assert _curve_close(r["curves"][0]["curve"], true_curve, 1e-6), \
        (r["curves"][0]["curve"], true_curve)
    # refresh: q1's wrong cache is corrected to p1's cached curve (f3 itself is
    # steady, so this is the only update)
    p = []
    _part, err, _bodies = rebuild(doc, projections=p)
    assert not err, err
    assert len(p) == 1, p
    u = p[0]
    assert u["sketch"] == "f4" and u["entity"] == "q1" and u["stale"] is False, u
    assert _curve_close(u["curve"], true_curve, 1e-6), (u["curve"], true_curve)
    print(PASS, "chain projection: projected curve re-projects and refreshes")


def test_resume_cap_ram_tier():
    """Warm rebuild_cached, then edit a feature DOWNSTREAM of the projected
    sketch. Without the cap the resume would start past the sketch and swallow
    the pending update; with it, the sketch handler re-runs and re-emits."""
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    src, _true_curve = _edge_source()
    tail = [{"id": "f4", "type": "fillet",
             "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 2}]
    doc = _doc(WRONG, src, tail=tail)
    p1 = []
    rebuild_cached(doc, projections=p1)  # cold: full build, update emitted (NOT applied)
    assert len(p1) == 1, p1
    d2 = copy.deepcopy(doc)
    d2["features"][3]["radius"] = 1.5  # downstream edit — prefix incl. f3 unchanged
    p2 = []
    rebuild_cached(d2, projections=p2)
    assert len(p2) == 1, \
        f"resume past the projected sketch swallowed the update (cap failed): {p2}"
    print(PASS, "RAM-tier resume capped at the projected sketch (update re-emitted)")


def test_resume_cap_disk_tier():
    """The disk tier receives a TRUNCATED chain-key list when a projections
    accumulator is active (keys[:cap] caps the deepest restorable checkpoint at
    the projected sketch); without an accumulator the full list is passed."""
    src, _tc = _edge_source()
    doc = _doc(WRONG, src)  # projected sketch at index 2 of 3 features
    seen = []
    orig_store, orig_restore = builder._disk_store, builder._restore_from_disk

    class _FakeStore:  # consulted only via the monkeypatched restore below
        pass

    builder._disk_store = lambda: _FakeStore()
    builder._restore_from_disk = lambda store, keys: (seen.append(len(keys)), None)[1]
    try:
        builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
        rebuild_cached(doc, projections=[])
        builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
        rebuild_cached(doc)  # no accumulator -> full-depth disk resume allowed
    finally:
        builder._disk_store, builder._restore_from_disk = orig_store, orig_restore
        builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    assert seen == [2, 3], f"expected capped [2] then full [3] key lists, got {seen}"
    print(PASS, "disk-tier chain keys truncated at the projected sketch")


def test_quiet_proof_deep_resume():
    """Perf escape: once a build's projection pass in this worker is QUIET
    (fresh == cached proven, nothing pending), a downstream edit with the
    prefix unchanged resumes PAST the projected sketch — its handler doesn't
    re-run. An emitting build re-arms the cap (test_resume_cap_ram_tier is the
    conservative side)."""
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    src, true_curve = _edge_source()
    tail = [{"id": "f4", "type": "fillet",
             "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 2}]
    doc = _doc(true_curve, src, tail=tail)  # cached curve is correct -> quiet
    p1 = []
    rebuild_cached(doc, projections=p1)
    assert p1 == [], f"expected a quiet first build, got {p1}"
    calls = []
    orig = builder._recompute_projections
    builder._recompute_projections = lambda f, ctx: (calls.append(f["id"]), orig(f, ctx))[1]
    try:
        d2 = copy.deepcopy(doc)
        d2["features"][3]["radius"] = 1.5  # downstream edit — prefix incl. f3 unchanged
        p2 = []
        rebuild_cached(d2, projections=p2)
    finally:
        builder._recompute_projections = orig
    assert p2 == [], p2
    assert calls == [], \
        f"quiet-proof deep resume should skip the projected sketch handler, got {calls}"
    print(PASS, "quiet previous build lets a downstream edit resume past the sketch")


def main():
    print("test_refresh:")
    src, true_curve = test_wrong_cache_corrected()
    test_steady_state_quiet(src, true_curve)
    test_stale_transition_once(src, true_curve)
    test_stale_clears_when_source_returns(src, true_curve)
    test_upstream_change_moves_curve(src, true_curve)
    test_sketch_curve_multi_edge_without_index_goes_stale()
    test_sketch_curve_index_survives_deletion()
    test_chain_projection_of_projected_curve()
    test_resume_cap_ram_tier()
    test_resume_cap_disk_tier()
    test_quiet_proof_deep_resume()
    print("ALL PASS")


if __name__ == "__main__":
    main()
