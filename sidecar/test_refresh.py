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


def test_sketch_curve_index_on_a_source_that_became_one_edge():
    """A rectangle exploded into lines keeps its id on its FIRST line (the
    sketcher's explodeCompound, so an extrude's picked area keeps a foothold).
    Its projection elsewhere is four siblings with indices 0..3, and the source
    now yields one edge: index 0 follows that edge, the other three go stale.
    They used to take the one edge too, all three, and the projection collapsed
    onto the bottom side with nothing said."""
    def sk_doc(entities, cached):
        ents = [{"id": f"e{i + 1}", "type": "projected",
                 "source": {"kind": "sketchCurve", "sketch": "f1", "entity": "r1",
                            "group": "e1", "index": i},
                 "curve": cached[i]} for i in range(4)]
        return {"parameters": {}, "features": [
            {"id": "f1", "type": "sketch", "plane": "XY", "entities": entities},
            {"id": "f3", "type": "sketch", "plane": TOP, "entities": ents},
        ]}

    rect = [{"id": "r1", "type": "rectangle", "width": 20, "height": 10, "x": 0, "y": 0}]
    p = []
    rebuild(sk_doc(rect, [dict(WRONG)] * 4), projections=p)
    seeded = [u["curve"] for u in sorted(p, key=lambda u: u["entity"])]
    assert len(seeded) == 4, p
    exploded = [
        {"id": "r1", "type": "line", "x1": -10, "y1": -5, "x2": 10, "y2": -5},
        {"id": "a", "type": "line", "x1": 10, "y1": -5, "x2": 10, "y2": 5},
        {"id": "b", "type": "line", "x1": 10, "y1": 5, "x2": -10, "y2": 5},
        {"id": "c", "type": "line", "x1": -10, "y1": 5, "x2": -10, "y2": -5},
    ]
    p2 = []
    rebuild(sk_doc(exploded, seeded), projections=p2)
    assert sorted((u["entity"], u["stale"]) for u in p2) == \
        [("e2", True), ("e3", True), ("e4", True)], p2
    print(PASS, "a source down to one edge: index 0 follows it, the rest go stale")


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


def test_plate_edge_follows_a_shrink_past_a_joined_cylinder():
    """Field report 66d7eb71: a hole dimensioned 10 mm off a plate's projected
    left edge stayed put when the plate shrank, because the refresh rebound
    that LINE to the rim of the cylinder joined on top of the plate. The rim
    had about the edge's length and a midpoint nearer the stale one than the
    moved edge's, and the old match let a line fingerprint pick a circle.

    Same shape here: a 60x50 plate, an r=8 cylinder (circumference 50.3) on
    top of it, the plate's left edge projected, then the plate shrunk to 30
    about its centre so the cylinder overhangs the new edge. The edge must come
    back as the moved line at x=-15, not as the rim."""
    face = {"origin": [0, 0, 1], "normal": [0, 0, 1], "xdir": [1, 0, 0]}

    def plate(w):
        return [
            {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
                {"id": "r", "type": "rectangle", "width": w, "height": 50, "x": 0, "y": 0}]},
            {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 1, "operation": "new"},
            {"id": "f3", "type": "sketch", "plane": face, "entities": [
                {"id": "c", "type": "circle", "x": -12, "y": 0, "radius": 8}]},
            {"id": "f4", "type": "extrude", "sketch": "f3", "distance": 10, "operation": "join"},
        ]

    _p, err, bodies = rebuild({"parameters": {}, "features": plate(60)})
    assert not err and len(bodies) == 1, err
    body = bodies[0]["id"]
    r = project_geometry({"parameters": {}, "features": plate(60)}, face, [
        {"kind": "edge", "body": body,
         "sel": {"kind": "edge", "by": "nearest", "point": [-30, 0, 1]}}])["results"][0]
    assert r["ok"], r
    fp, curve = r["curves"][0]["fp"], r["curves"][0]["curve"]
    assert fp["curve"] == "line" and curve["kind"] == "line", (fp, curve)
    src = {"kind": "faceBoundary", "body": body, "group": "p",
           "sel": {"kind": "edge", "by": "match", "fp": fp}}
    doc = {"parameters": {}, "features": plate(30) + [
        {"id": "f5", "type": "sketch", "plane": face, "entities": [
            {"id": "p", "type": "projected", "source": src, "curve": curve}]}]}
    p = []
    _part, err, _bodies = rebuild(doc, projections=p)
    assert not err, err
    assert len(p) == 1 and p[0]["stale"] is False, p
    c = p[0]["curve"]
    assert c["kind"] == "line", f"the plate edge came back as {c}"
    assert abs(c["x1"] + 15) < 1e-6 and abs(c["x2"] + 15) < 1e-6, c
    assert abs(abs(c["y2"] - c["y1"]) - 50) < 1e-6, c
    print(PASS, f"a plate edge follows the shrink as a line: {c}")


def test_refresh_never_turns_a_line_round():
    """The backstop under the match rule: whatever the source resolves to, a
    projected line never comes back as a circle or an arc, nor a circle or arc
    as a line. That is a different curve, and every dimension on the entity
    would silently drop out of the solve; stale (keep the last shape, warn) is
    the truth. A circle that comes back as an arc is the same rim cut part-way
    and still follows."""
    line = {"kind": "line", "x1": 0.0, "y1": 0.0, "x2": 10.0, "y2": 0.0}
    circle = {"kind": "circle", "x": 0.0, "y": 0.0, "r": 5.0}
    src_ents = [
        {"id": "round", "type": "circle", "x": 0, "y": 0, "radius": 5},
        {"id": "straight", "type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0},
        {"id": "part", "type": "arc", "x1": 5, "y1": 0, "mx": 0, "my": 5, "x2": -5, "y2": 0},
    ]

    def proj(eid, entity, cached):
        return {"id": eid, "type": "projected", "curve": dict(cached),
                "source": {"kind": "sketchCurve", "sketch": "f1", "entity": entity}}

    doc = {"parameters": {}, "features": [
        {"id": "f1", "type": "sketch", "plane": "XY", "entities": src_ents},
        {"id": "f3", "type": "sketch", "plane": "XY", "entities": [
            proj("was_line", "round", line),
            proj("was_circle", "straight", circle),
            proj("rim", "part", circle),
        ]},
    ]}
    p = []
    _part, err, _bodies = rebuild(doc, projections=p)
    assert not err, err
    got = {u["entity"]: u for u in p}
    assert set(got) == {"was_line", "was_circle", "rim"}, p
    assert got["was_line"] == {"sketch": "f3", "entity": "was_line", "stale": True}, got
    assert got["was_circle"] == {"sketch": "f3", "entity": "was_circle", "stale": True}, got
    assert got["rim"]["stale"] is False and got["rim"]["curve"]["kind"] == "arc", got
    print(PASS, "a refresh never turns a projected line round (or back); circle -> arc follows")


def test_cut_placed_by_a_lost_projection_says_so():
    """Field report 66d7eb71's SAVED file: the plate's left edge was cached as
    the rim of the cylinder on top, under a straight-edge source, so it goes
    stale on open (test_refresh_never_turns_a_line_round) and the hole
    dimensioned 10 mm from it stays off the plate. Its Cut said "the extrude
    doesn't reach any body. Drag the other way, or use Join", which sent the
    user the wrong way. It now names the lost projection (cutLostProjection):
    on the first build, when the stale transition is only in this rebuild's
    `projections`, and once the app has landed the flag in the document.

    A second hole, also off the plate, hangs only off the plate's good bottom
    edge, which the first hole is dimensioned to as well. Its Cut keeps the
    plain message: the walk does not go on through a projected edge."""
    face = {"origin": [0, 0, 1], "normal": [0, 0, 1], "xdir": [1, 0, 0]}

    def plate(w):
        return [
            {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
                {"id": "r", "type": "rectangle", "width": w, "height": 50, "x": 0, "y": 0}]},
            {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 1, "operation": "new"},
            {"id": "f3", "type": "sketch", "plane": face, "entities": [
                {"id": "c", "type": "circle", "x": -12, "y": 0, "radius": 8}]},
            {"id": "f4", "type": "extrude", "sketch": "f3", "distance": 10, "operation": "join"},
        ]

    _p, err, bodies = rebuild({"parameters": {}, "features": plate(30)})
    assert not err and len(bodies) == 1, err
    body = bodies[0]["id"]  # the join's, not the plate's

    def pick(w, point):
        r = project_geometry({"parameters": {}, "features": plate(w)}, face, [
            {"kind": "edge", "body": body,
             "sel": {"kind": "edge", "by": "nearest", "point": point}}])["results"][0]
        assert r["ok"], r
        src = {"kind": "faceBoundary", "body": body, "group": "g",
               "sel": {"kind": "edge", "by": "match", "fp": r["curves"][0]["fp"]}}
        return src, r["curves"][0]["curve"]

    left, _line = pick(60, [-30, 0, 1])  # picked while the plate was wide
    bottom, bottom_curve = pick(30, [0, -25, 1])
    rim = {"kind": "circle", "x": -12.0, "y": 0.0, "r": 8.0}  # what the saved file holds
    sketch = {"id": "f5", "type": "sketch", "plane": face, "entities": [
        {"id": "left", "type": "projected", "source": left, "curve": rim},
        {"id": "bottom", "type": "projected", "source": bottom, "curve": bottom_curve},
        {"id": "h1", "type": "circle", "x": -27, "y": 10, "radius": 4},
        {"id": "h2", "type": "circle", "x": -27, "y": -10, "radius": 4},
    ], "constraints": [
        {"id": "c1", "type": "p2lDistance", "e": "h1", "p": 0, "line": "left", "value": 10},
        {"id": "c2", "type": "p2lDistance", "e": "h1", "p": 0, "line": "bottom", "value": 35},
        {"id": "c3", "type": "p2lDistance", "e": "h2", "p": 0, "line": "bottom", "value": 15},
    ]}

    def cut(fid, hole, y):
        return {"id": fid, "type": "extrude", "sketch": "f5", "distance": -5,
                "operation": "cut", "regions": [[-27, y, 1]], "regionEntities": [[hole]]}

    doc = {"parameters": {}, "features": plate(30) + [sketch, cut("f6", "h1", 10), cut("f7", "h2", -10)]}
    p = []
    _part, err, _bodies = rebuild(doc, projections=p)
    assert p == [{"sketch": "f5", "entity": "left", "stale": True}], p
    errs = {e["feature_id"]: e for e in err}
    assert set(errs) == {"f6", "f7"}, err
    assert errs["f6"].get("code") == "cutLostProjection", errs["f6"]
    assert "projected edge" in errs["f6"]["message"], errs["f6"]
    # reached is not proof, so the plain advice stays as the last sentence
    assert errs["f6"]["message"].endswith("drag the other way, or use Join."), errs["f6"]
    assert "code" not in errs["f7"] and "doesn't reach any body" in errs["f7"]["message"], errs["f7"]

    # the app lands the flag; the next build reads it from the document
    landed = copy.deepcopy(doc)
    landed["features"][4]["entities"][0]["stale"] = True
    _part, err, _bodies = rebuild(landed)
    errs = {e["feature_id"]: e for e in err}
    assert errs["f6"].get("code") == "cutLostProjection", errs["f6"]
    assert "code" not in errs["f7"], errs["f7"]
    print(PASS, "a Cut placed by a lost projection says so; one beside it does not")


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


def test_deeper_disk_tip_cannot_swallow_projection_updates():
    """A disk tip must not beat a RAM prefix across an unacknowledged projection.

    The saved geometry alone cannot prove that the frontend applied a previous
    refresh. Keep the real deeper checkpoint available while reverting a fillet,
    and require the projected sketch to emit its correction again.
    """
    import tempfile
    from unittest.mock import patch
    import geomstore

    src, true_curve = _edge_source()
    tail = [{"id": "f4", "type": "fillet",
             "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 2}]
    doc = _doc(WRONG, src, tail=tail)
    with tempfile.TemporaryDirectory(prefix="sindri_projection_checkpoint_") as tmp:
        store = geomstore.Store(root=tmp)
        try:
            with patch.object(builder, "_disk_store", lambda: store), patch.object(builder, "_CACHE", {
                "feature_sigs": [], "snaps": [], "global_sig": None,
            }):
                keys = builder._chain_keys_scoped(doc, builder._feature_sigs(doc["features"]))
                rebuild(doc, projections=[], persist={
                    "store": store, "keys": keys, "mod": {}, "acc_ms": 0.0, "budget_ms": 0.0,
                })
                assert store.find_checkpoint(keys)["feat_index"] == 3
                edited = copy.deepcopy(doc)
                edited["features"][-1]["radius"] = 1.5
                with patch.object(builder, "_disk_store", lambda: None):
                    updates = []
                    rebuild_cached(edited, projections=updates)
                assert len(updates) == 1, "setup must leave a pending projection update"
                updates = []
                _part, errors, _bodies = rebuild_cached(doc, projections=updates)
                assert not errors, errors
                assert len(updates) == 1, "deeper disk tip swallowed the pending update"
                assert _curve_close(updates[0]["curve"], true_curve, 1e-6)
        finally:
            store.db.close()
    print(PASS, "deeper disk checkpoint respects pending projection updates")


def main():
    print("test_refresh:")
    src, true_curve = test_wrong_cache_corrected()
    test_steady_state_quiet(src, true_curve)
    test_stale_transition_once(src, true_curve)
    test_stale_clears_when_source_returns(src, true_curve)
    test_upstream_change_moves_curve(src, true_curve)
    test_sketch_curve_multi_edge_without_index_goes_stale()
    test_sketch_curve_index_survives_deletion()
    test_sketch_curve_index_on_a_source_that_became_one_edge()
    test_chain_projection_of_projected_curve()
    test_plate_edge_follows_a_shrink_past_a_joined_cylinder()
    test_refresh_never_turns_a_line_round()
    test_cut_placed_by_a_lost_projection_says_so()
    test_resume_cap_ram_tier()
    test_resume_cap_disk_tier()
    test_quiet_proof_deep_resume()
    test_deeper_disk_tip_cannot_swallow_projection_updates()
    print("ALL PASS")


if __name__ == "__main__":
    main()
