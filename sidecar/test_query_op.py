"""The `query` op: resolve selectors, match predicates, return storable refs.

Run: uv run python test_query_op.py

The point of this op is that what it hands back can be PERSISTED and will still
mean the same thing after the model changes. So the load-bearing test is not
"does it find things" — it is the MUTATED ROUND TRIP: author a reference against
one model, change the model, and require the reference to still land on the same
feature. An unmutated round trip is non-discriminating, because a weak reference
and a strong one both resolve correctly when nothing has moved.
"""

import math
import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

from build123d import Box, Cylinder, Pos, Rot, Sphere  # noqa: E402

from builder import query_geometry, rebuild  # noqa: E402
from geom_select import _edge_radius, resolve_edges  # noqa: E402

PASS = "  ok"


def _doc(*features):
    return {"parameters": {}, "features": list(features)}


def _q(doc, *items):
    return query_geometry(doc, list(items))["results"]


BOX = _doc({"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20})
# A tube built the way the app builds one: solid extrude, then a cut. Primitives
# always make a NEW body, so two cylinders would be two bodies, not a tube.
TUBE = _doc(
    {"id": "s1", "type": "sketch", "plane": "XY",
     "entities": [{"id": "k1", "type": "circle", "radius": 10, "x": 0, "y": 0}]},
    {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
    {"id": "s2", "type": "sketch", "plane": "XY",
     "entities": [{"id": "k2", "type": "circle", "radius": 6, "x": 0, "y": 0}]},
    {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 20, "operation": "cut"},
)


def test_a_returned_reference_survives_a_mutation():
    """THE test. Author a reference to the OUTER rim of a tube, then rebuild the
    tube at a different size and require it to still resolve to the outer rim.

    Without the concentric rank the fingerprint carries, a scaled model resolves
    this to the INNER rim — a wrong reference written straight into the user's
    document. The unmutated case cannot show this: both the weak and the full
    fingerprint resolve to 10.0 when nothing has moved."""
    res = _q(TUBE, {"id": "q", "kind": "edge",
                    "where": {"curve": "circle", "radius": {"min": 9, "max": 11}}})[0]
    assert res["ok"], res
    assert res["count"] >= 1, res
    sel = res["entities"][0]["sel"]
    fp = sel["fp"]
    assert fp.get("radius_rank") is not None and fp.get("radius_group") == 2, \
        f"a concentric rim must carry its rank, or the mutation case fails: {fp}"

    # the SAME tube, scaled: outer 10 -> 13, inner 6 -> 7.8
    mutated = Cylinder(13, 20) - Cylinder(7.8, 20)
    got = resolve_edges(mutated, sel)
    assert len(got) == 1, got
    r = _edge_radius(got[0])
    assert abs(r - 13.0) < 0.01, \
        f"the stored reference resolved to r={r:.2f}; 7.8 is the INNER rim, so the " \
        "rank was lost and this reference would have been silently wrong"
    print(PASS, f"a returned reference still means the outer rim after a mutation (r={r:.1f})")


def test_normal_is_planarity_gated_and_uses_the_tuned_tolerance():
    """A lying-down cylinder's barrel reports "up" at one point on its surface.
    The legacy by:"normal" selector returned it, which is what made Shell fail
    with a bare OCCT error; this predicate must not reintroduce that."""
    from geom_select import query_entities, _face_normal, _face_surface
    from build123d import Vector

    lying = Rot(0, 90, 0) * Cylinder(5, 20)
    # the barrel DOES report +Z at its sampled point — that is the trap
    raw = [f for f in lying.faces() if _face_normal(f).dot(Vector(0, 0, 1)) > 0.99]
    assert any(_face_surface(f) != "plane" for f in raw), \
        "setup: expected a curved face to report +Z, or this proves nothing"

    hits = query_entities(lying, "face", {"normal": {"dir": [0, 0, 1]}})
    assert hits == [], f"a curved barrel matched a direction predicate: {len(hits)}"

    # a flat top still matches, and the tolerance is genuinely applied. The
    # direction must be OFF-AXIS to test this at all: [0,0,0.9] normalises to
    # exactly +Z, so no tolerance would ever reject it.
    res = _q(BOX, {"id": "q", "kind": "face", "where": {"normal": {"dir": [0, 0, 1]}}})[0]
    assert res["count"] == 1, res
    off = [0, 0.1, 1]  # ~5.7 degrees off +Z; 1-cos(5.7) ~ 0.005, inside ANG_TOL 0.02
    loose = _q(BOX, {"id": "q", "kind": "face", "where": {"normal": {"dir": off}}})[0]
    assert loose["count"] == 1, f"5.7 degrees off should be inside the default band: {loose}"
    tight = _q(BOX, {"id": "q", "kind": "face",
                     "where": {"normal": {"dir": off, "tol": 1e-9}}})[0]
    assert tight["count"] == 0, "an explicit tolerance must actually be applied"
    print(PASS, "the normal predicate is planar-only and honours its tolerance")


def test_predicates_compose_as_AND():
    """Dropping any one key must change the answer, or a key is being ignored."""
    both = _q(BOX, {"id": "q", "kind": "face",
                    "where": {"surface": "plane", "normal": {"dir": [0, 0, 1]}}})[0]
    only_surface = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"}})[0]
    assert both["count"] == 1 and only_surface["count"] == 6, (both, only_surface)

    area_only = _q(BOX, {"id": "q", "kind": "face",
                         "where": {"area": {"min": 399, "max": 401}}})[0]
    assert area_only["count"] == 6, area_only
    within = _q(BOX, {"id": "q", "kind": "face",
                      "where": {"within": {"min": [-1, -1, 5], "max": [1, 1, 15]}}})[0]
    assert within["count"] == 1, f"within should isolate the top face: {within['count']}"
    print(PASS, "predicates compose as AND; each one changes the answer")


def test_count_is_the_pre_limit_total_and_expect_judges_it():
    res = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"}, "limit": 2})[0]
    assert res["ok"] and res["count"] == 6 and len(res["entities"]) == 2, res

    ok = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"},
                  "limit": 2, "expect": 6})[0]
    assert ok["ok"], "expect is judged on the true count, not the truncated list"

    bad = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"}, "expect": 4})[0]
    assert not bad["ok"] and bad["code"] == "expectFailed", bad
    assert bad["count"] == 6, "a failed expectation must still report what it found"
    print(PASS, "count is the pre-limit total; expect is branchable and still reports")


def test_one_bad_item_never_fails_the_call():
    out = _q(BOX,
             {"id": "a", "kind": "face", "where": {"surface": "plane"}},
             {"id": "b", "kind": "face", "body": "nope", "where": {"surface": "plane"}},
             {"id": "c", "kind": "edge", "where": {"curve": "line"}})
    assert len(out) == 3, out
    assert out[0]["ok"] and out[2]["ok"], out
    assert not out[1]["ok"] and out[1]["error"], out[1]
    assert [r["index"] for r in out] == [0, 1, 2], "indices must stay aligned"
    print(PASS, "a bad item is contained; its neighbours still answer")


def test_edge_direction_is_sign_normalised():
    up = _q(BOX, {"id": "q", "kind": "edge", "where": {"dir": [0, 0, 1]}})[0]
    down = _q(BOX, {"id": "q", "kind": "edge", "where": {"dir": [0, 0, -1]}})[0]
    assert up["count"] == 4 and down["count"] == 4, (up["count"], down["count"])
    print(PASS, "+dir and -dir select the same edges (sign-normalised)")


def test_unknown_predicates_and_edge_createdBy_are_refused():
    bad = _q(BOX, {"id": "q", "kind": "face", "where": {"colour": "red"}})[0]
    assert not bad["ok"] and "colour" in bad["error"], bad
    assert bad["code"] == "badRequest", bad

    e = _q(BOX, {"id": "q", "kind": "edge", "where": {"createdBy": "f1"}})[0]
    assert not e["ok"] and e["code"] == "badRequest", e

    k = _q(BOX, {"id": "q", "kind": "vertex", "where": {}})[0]
    assert not k["ok"], k
    print(PASS, "unknown predicates, edge createdBy and bad kinds are all refused")


def test_a_lossy_match_is_reported_not_refused():
    """query is read-only inspection: "this reference went ambiguous, show me
    what it could mean" is one of its uses. It must NOT copy the projection
    path's refuse-on-lossy rule."""
    res = _q(BOX, {"id": "q", "kind": "face",
                   "sel": {"kind": "face", "by": "match",
                           "fp": {"centroid": [0, 0, 10], "normal": [0, 0, 1],
                                  "area": 400.0, "surface": "plane"}}})[0]
    assert res["ok"] and res["count"] == 1, res
    print(PASS, "a resolved selector answers, with any diagnostic alongside")


def test_totals_cap_bounds_the_whole_reply():
    """Per-item limits MULTIPLY. The total cap is what keeps a 64-item request
    from building a reply past the frame cap, which would close the socket."""
    from builder import _QUERY_MAX_TOTAL

    sphere = _doc({"id": "s", "type": "sphere", "radius": 10})
    items = [{"id": f"q{i}", "kind": "face", "where": {}, "limit": 5000}
             for i in range(8)]
    out = query_geometry(sphere, items)["results"]
    got = sum(len(r["entities"]) for r in out)
    assert got <= _QUERY_MAX_TOTAL, f"{got} entities exceeds the total cap"
    print(PASS, f"the whole reply is capped at {_QUERY_MAX_TOTAL} entities")


def main():
    print("Query-op tests")
    test_a_returned_reference_survives_a_mutation()
    test_normal_is_planarity_gated_and_uses_the_tuned_tolerance()
    test_predicates_compose_as_AND()
    test_count_is_the_pre_limit_total_and_expect_judges_it()
    test_one_bad_item_never_fails_the_call()
    test_edge_direction_is_sign_normalised()
    test_unknown_predicates_and_edge_createdBy_are_refused()
    test_a_lossy_match_is_reported_not_refused()
    test_totals_cap_bounds_the_whole_reply()
    print("ALL PASS")


if __name__ == "__main__":
    main()
