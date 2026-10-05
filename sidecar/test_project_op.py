"""projectGeometry aux-op + projection math — _project_edge_to_plane exactness
(line/circle/arc vs sampled-poly fallback), _curve_close tolerance compare, and
project_geometry's strict per-source resolution (missing body / ambiguous
selector → error entries, never exceptions).

Run:  uv run python test_project_op.py
"""

from builder import (
    _curve_close,
    _project_edge_to_plane,
    project_geometry,
)

BOX = {
    "parameters": {},
    "features": [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [
            {"id": "r1", "type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"},
    ],
}

CYL = {
    "parameters": {},
    "features": [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [
            {"id": "c1", "type": "circle", "radius": 10, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"},
    ],
}

# 30° tilt about X: |cyl axis (Z) · normal| = cos30 ≈ 0.866 → sampled poly
TILTED = {"origin": [0, 0, 0], "xdir": [1, 0, 0],
          "normal": [0, 0.5, 0.8660254037844386]}


def _one(doc, plane, source):
    res = project_geometry(doc, plane, [source])["results"]
    assert len(res) == 1
    return res[0]


def _seg_key(c):
    """Orientation-independent endpoint key for a projected line."""
    a, b = (c["x1"], c["y1"]), (c["x2"], c["y2"])
    return tuple(sorted([a, b]))


def test_box_top_boundary():
    """box(20,20,10) top-face boundary onto XY → exactly 4 exact lines matching
    the ±10 footprint, each with a sidecar-authored fingerprint."""
    r = _one(BOX, "XY", {"kind": "faceBoundary", "body": "body1",
                         "sel": {"kind": "face", "by": "nearest", "point": [0, 0, 10]}})
    assert r["ok"], r
    assert len(r["curves"]) == 4, f"expected 4 boundary lines, got {len(r['curves'])}"
    segs = set()
    for entry in r["curves"]:
        c = entry["curve"]
        assert c["kind"] == "line", c
        assert entry["fp"]["curve"] == "line"
        segs.add(_seg_key(c))
    want = {
        (((-10.0, -10.0)), ((10.0, -10.0))),
        (((-10.0, 10.0)), ((10.0, 10.0))),
        (((-10.0, -10.0)), ((-10.0, 10.0))),
        (((10.0, -10.0)), ((10.0, 10.0))),
    }
    want = {tuple(sorted(s)) for s in want}
    assert segs == want, f"footprint mismatch: {segs}"
    print("  box top boundary OK: 4 exact lines, ±10 footprint")


def test_cylinder_rim_exact_circle():
    """cylinder(r=10) top rim onto XY (axis ∥ normal) → the EXACT circle r=10."""
    r = _one(CYL, "XY", {"kind": "edge", "body": "body1",
                         "sel": {"kind": "edge", "by": "nearest", "point": [0, 0, 10.1]}})
    assert r["ok"], r
    assert len(r["curves"]) == 1
    c = r["curves"][0]["curve"]
    assert c == {"kind": "circle", "x": 0.0, "y": 0.0, "r": 10.0}, c
    assert r["curves"][0]["fp"]["curve"] == "circle"
    print("  cylinder rim OK: exact circle r=10")


def test_cylinder_rim_tilted_poly():
    """The same rim onto a 30°-tilted plane (axis NOT ∥ normal) → sampled poly:
    a closed ellipse-ish loop, x semi-axis exact 10, y compressed by cos30."""
    r = _one(CYL, TILTED, {"kind": "edge", "body": "body1",
                           "sel": {"kind": "edge", "by": "nearest", "point": [0, 0, 10.1]}})
    assert r["ok"], r
    c = r["curves"][0]["curve"]
    assert c["kind"] == "poly", c
    pts = c["pts"]
    # N = clamp(len/0.5, 16, 128) segments → N+1 points; rim len 2π·10 ≈ 62.8 → 125 segs
    assert 17 <= len(pts) <= 129, len(pts)
    assert pts[0] == pts[-1], "closed rim must close its poly"
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    assert abs(max(xs) - 10) < 0.02 and abs(min(xs) + 10) < 0.02
    # the tilted view compresses the rim's y SPAN to 2·r·cos(30°) ≈ 17.32 (its
    # CENTER shifts by the rim plane's z-offset — only the span says "ellipse")
    yspan = max(ys) - min(ys)
    assert abs(yspan - 2 * 10 * 0.8660254) < 0.05, f"tilted y span: {yspan}"
    print(f"  tilted rim OK: poly with {len(pts)} pts")


def test_degenerate_vertical_edge():
    """A box side edge viewed end-on (vertical line onto XY) projects to a point:
    poly fallback with coincident endpoints — never an error."""
    r = _one(BOX, "XY", {"kind": "edge", "body": "body1",
                         "sel": {"kind": "edge", "by": "nearest", "point": [10, 10, 5]}})
    assert r["ok"], r
    c = r["curves"][0]["curve"]
    assert c["kind"] == "poly" and len(c["pts"]) == 2, c
    assert c["pts"][0] == c["pts"][1] == [10.0, 10.0], c
    print("  degenerate vertical edge OK: 2-point poly at (10,10)")


def test_sketch_curve_cross_plane():
    """sketchCurve sources: a line and a circle drawn on XZ, projected onto XY.
    XZ local (u,v) sits at world (u,0,v): the line lands at y=0 with x preserved;
    the circle is seen edge-on → poly collapsed onto y=0, x spanning [1,5]."""
    doc = {"parameters": {}, "features": [
        {"id": "s0", "type": "sketch", "plane": "XZ", "entities": [
            {"id": "l1", "type": "line", "x1": 1, "y1": 2, "x2": 5, "y2": 2},
            {"id": "c1", "type": "circle", "radius": 2, "x": 3, "y": 4}]},
    ]}
    r = _one(doc, "XY", {"kind": "sketchCurve", "sketch": "s0", "entity": "l1"})
    assert r["ok"], r
    c = r["curves"][0]["curve"]
    assert c["kind"] == "line" and _seg_key(c) == ((1.0, 0.0), (5.0, 0.0)), c
    assert "fp" not in r["curves"][0], "sketch curves are tracked by id, not fingerprint"

    r = _one(doc, "XY", {"kind": "sketchCurve", "sketch": "s0", "entity": "c1"})
    assert r["ok"], r
    c = r["curves"][0]["curve"]
    assert c["kind"] == "poly", c
    xs = [p[0] for p in c["pts"]]
    assert all(abs(p[1]) < 1e-6 for p in c["pts"]), "edge-on circle must land on y=0"
    assert abs(min(xs) - 1) < 0.02 and abs(max(xs) - 5) < 0.02, (min(xs), max(xs))
    print("  sketchCurve cross-plane OK: line exact, edge-on circle → flat poly")


def test_sketch_curve_same_plane_exact():
    """A circle and an arc on XY projected onto XY come back EXACT (the axis-∥
    branch), byte-identical to their source numbers."""
    doc = {"parameters": {"rad": 4}, "features": [
        {"id": "s0", "type": "sketch", "plane": "XY", "entities": [
            {"id": "c1", "type": "circle", "radius": "rad", "x": 2, "y": 3},
            {"id": "a1", "type": "arc", "x1": 0, "y1": 0, "x2": 10, "y2": 0, "mx": 5, "my": 5}]},
    ]}
    r = _one(doc, "XY", {"kind": "sketchCurve", "sketch": "s0", "entity": "c1"})
    assert r["ok"] and r["curves"][0]["curve"] == {"kind": "circle", "x": 2.0, "y": 3.0, "r": 4.0}, r

    r = _one(doc, "XY", {"kind": "sketchCurve", "sketch": "s0", "entity": "a1"})
    assert r["ok"], r
    c = r["curves"][0]["curve"]
    assert c["kind"] == "arc", c
    assert _seg_key(c) == ((0.0, 0.0), (10.0, 0.0)), c
    assert (c["mx"], c["my"]) == (5.0, 5.0), c
    print("  sketchCurve same-plane OK: exact circle (param radius) + exact arc")


def test_multi_edge_sketch_source():
    """A rectangle sketch source emits N sibling curves (one per boundary edge)."""
    doc = {"parameters": {}, "features": [
        {"id": "s0", "type": "sketch", "plane": "XY", "entities": [
            {"id": "r1", "type": "rectangle", "width": 8, "height": 6, "x": 0, "y": 0}]},
    ]}
    r = _one(doc, "XY", {"kind": "sketchCurve", "sketch": "s0", "entity": "r1"})
    assert r["ok"], r
    assert len(r["curves"]) == 4 and all(e["curve"]["kind"] == "line" for e in r["curves"])
    print("  multi-edge sketch source OK: rectangle → 4 lines")


def test_error_entries():
    """Strict resolution: missing body / sketch / entity and an ambiguous
    fingerprint each yield ok:False error ENTRIES (the call itself succeeds)."""
    res = project_geometry(BOX, "XY", [
        {"kind": "edge", "body": "nope",
         "sel": {"kind": "edge", "by": "nearest", "point": [0, 0, 0]}},
        {"kind": "sketchCurve", "sketch": "nope", "entity": "x"},
        {"kind": "sketchCurve", "sketch": "s1", "entity": "nope"},
        {"kind": "edge", "body": "body1",
         "sel": {"kind": "edge", "by": "match",
                 "fp": {"mid": [999, 999, 999], "dir": [1, 0, 0], "length": 1, "curve": "line"}}},
        {"kind": "silhouette", "body": "nope"},
    ])["results"]
    assert [r["ok"] for r in res] == [False] * 5, res
    assert "created after this sketch" in res[0]["error"], res[0]
    assert "created after this sketch" in res[1]["error"], res[1]
    assert "no longer exists" in res[2]["error"], res[2]
    assert "ambiguous" in res[3]["error"], res[3]
    assert "not available here" in res[4]["error"], res[4]
    assert all(r["curves"] == [] for r in res)
    print("  error entries OK: missing body/sketch/entity, lossy match, silhouette body")


def test_vertex_point():
    """A body corner projects to a fixed POINT, anchored as one END of an edge:
    the pick names the edge (by:"nearest" at pick time only) and the corner it
    was picked at; the reply carries the edge's by:"match" fingerprint and the
    end index, and that persisted pair re-finds the same corner on its own."""
    top_front = {"kind": "edge", "by": "nearest", "point": [0, -10, 10]}
    got = {}
    for corner in ([10, -10, 10], [-10, -10, 10]):
        r = _one(BOX, "XY", {"kind": "vertex", "body": "body1", "sel": top_front, "point": corner})
        assert r["ok"], r
        (entry,) = r["curves"]
        assert entry["curve"] == {"kind": "point", "x": float(corner[0]), "y": float(corner[1])}, entry
        assert entry["fp"]["curve"] == "line" and entry["end"] in (0, 1), entry
        got[tuple(corner)] = entry
    a, b = got.values()
    assert (a["fp"], a["end"]) != (b["fp"], b["end"]), "the two corners of one edge must be kept apart"
    # the persisted form, as the frontend stores it: fingerprint + end, no point
    for corner, entry in got.items():
        persisted = {"kind": "vertex", "body": "body1",
                     "sel": {"kind": "edge", "by": "match", "fp": entry["fp"]}, "end": entry["end"]}
        r = _one(BOX, "XY", persisted)
        assert r["ok"] and r["curves"][0]["curve"] == entry["curve"], (corner, r)
    # onto a plane that is not the corner's own: the point is the corner seen
    # along the plane's normal (XZ local = world (x, z))
    r = _one(BOX, "XZ", {"kind": "vertex", "body": "body1", "sel": top_front, "point": [10, -10, 10]})
    assert r["ok"] and r["curves"][0]["curve"] == {"kind": "point", "x": 10.0, "y": 10.0}, r
    print("  vertex OK: corner -> point, fp + end re-find it, both corners distinct")


def test_vertex_is_kept_by_one_edge_whichever_was_picked():
    """One corner ends three edges of a box, and which one a click finds
    depends on the side the cursor comes from. Whichever it is, the corner is
    kept as the same (fingerprint, end), so the app can refuse the second
    click on it as already projected instead of stacking a copy."""
    picks = {  # three edges ending at the top front right corner (10, -10, 10)
        "top x-edge": [0, -10, 10],
        "top y-edge": [10, 0, 10],
        "vertical edge": [10, -10, 5],
    }
    kept = {}
    for name, mid in picks.items():
        r = _one(BOX, "XY", {"kind": "vertex", "body": "body1",
                             "sel": {"kind": "edge", "by": "nearest", "point": mid},
                             "point": [10, -10, 10]})
        assert r["ok"], (name, r)
        (entry,) = r["curves"]
        assert entry["curve"] == {"kind": "point", "x": 10.0, "y": -10.0}, (name, entry)
        kept[name] = (entry["fp"], entry["end"])
    assert len({repr(v) for v in kept.values()}) == 1, kept
    # and the bottom corner under it, which a view square onto the top face
    # shows on the same pixel, is kept as a different one
    r = _one(BOX, "XY", {"kind": "vertex", "body": "body1",
                         "sel": {"kind": "edge", "by": "nearest", "point": [10, -10, 5]},
                         "point": [10, -10, 0]})
    assert r["ok"] and (r["curves"][0]["fp"], r["curves"][0]["end"]) != kept["top x-edge"], r
    print("  vertex OK: one corner, one (fp, end), from any of its three edges")


def test_vertex_pick_refuses_a_point_off_the_edge():
    """A picked corner that is not an end of the edge the pick resolved to is
    refused, never bound to whichever end is nearer."""
    r = _one(BOX, "XY", {"kind": "vertex", "body": "body1",
                         "sel": {"kind": "edge", "by": "nearest", "point": [0, -10, 10]},
                         "point": [3, -10, 10]})
    assert not r["ok"] and "isn't an end of the edge" in r["error"], r
    r = _one(BOX, "XY", {"kind": "vertex", "body": "body1",
                         "sel": {"kind": "edge", "by": "nearest", "point": [0, -10, 10]}})
    assert not r["ok"] and "pick a corner" in r["error"], r
    print("  vertex refusals OK: off-end point, no point and no end")


def test_sketch_point():
    """A committed sketch's point projects by stable id + the dimRefPoints
    index: a sketch point (0), a line's end (1), an arc's centre (2)."""
    doc = {"parameters": {"px": 3}, "features": [
        {"id": "s0", "type": "sketch", "plane": "XZ", "entities": [
            {"id": "pt", "type": "point", "x": "px", "y": 4},
            {"id": "l1", "type": "line", "x1": 1, "y1": 2, "x2": 5, "y2": 6},
            {"id": "a1", "type": "arc", "x1": 0, "y1": 0, "x2": 10, "y2": 0, "mx": 5, "my": 5}]},
    ]}
    # XZ local (u, v) sits at world (u, 0, v); onto XY that is (u, 0)
    for entity, idx, want in (("pt", 0, (3.0, 0.0)), ("l1", 1, (5.0, 0.0)), ("a1", 2, (5.0, 0.0))):
        r = _one(doc, "XY", {"kind": "sketchPoint", "sketch": "s0", "entity": entity, "pointIndex": idx})
        assert r["ok"], (entity, r)
        (entry,) = r["curves"]
        assert entry["curve"] == {"kind": "point", "x": want[0], "y": want[1]}, (entity, entry)
        assert "fp" not in entry, "sketch points are tracked by id, not fingerprint"
    # onto its own plane: the point exactly
    r = _one(doc, "XZ", {"kind": "sketchPoint", "sketch": "s0", "entity": "l1", "pointIndex": 0})
    assert r["ok"] and r["curves"][0]["curve"] == {"kind": "point", "x": 1.0, "y": 2.0}, r
    res = project_geometry(doc, "XY", [
        {"kind": "sketchPoint", "sketch": "s0", "entity": "l1", "pointIndex": 2},
        {"kind": "sketchPoint", "sketch": "s0", "entity": "gone", "pointIndex": 0},
        {"kind": "sketchPoint", "sketch": "nope", "entity": "pt", "pointIndex": 0},
    ])["results"]
    assert [r["ok"] for r in res] == [False] * 3, res
    assert "can't be projected" in res[0]["error"], res[0]
    assert "no longer exists" in res[1]["error"], res[1]
    assert "created after this sketch" in res[2]["error"], res[2]
    print("  sketchPoint OK: point / line end / arc centre, refusals")


def test_smooth_flag_marks_sampled_polys_of_new_links_only():
    """A link made since smooth projection (source.smooth) marks a sampled poly
    smooth; one made before it gets exactly the poly it always got (byte-for-
    byte: no new key). Exact curves and the view-aligned point never carry it."""
    rim = {"kind": "edge", "by": "nearest", "point": [0, 0, 10.1]}
    old = _one(CYL, TILTED, {"kind": "edge", "body": "body1", "sel": rim})
    new = _one(CYL, TILTED, {"kind": "edge", "body": "body1", "sel": rim, "smooth": True})
    assert old["ok"] and new["ok"], (old, new)
    oc, nc = old["curves"][0]["curve"], new["curves"][0]["curve"]
    assert set(oc) == {"kind", "pts"}, oc.keys()
    assert nc["smooth"] is True and nc["pts"] == oc["pts"], "same samples, flag added"
    exact = _one(CYL, "XY", {"kind": "edge", "body": "body1", "sel": rim, "smooth": True})
    assert exact["curves"][0]["curve"] == {"kind": "circle", "x": 0.0, "y": 0.0, "r": 10.0}, exact
    end_on = _one(BOX, "XY", {"kind": "edge", "body": "body1", "smooth": True,
                              "sel": {"kind": "edge", "by": "nearest", "point": [10, 10, 5]}})
    assert "smooth" not in end_on["curves"][0]["curve"], end_on
    # a sketch-curve source and a silhouette carry it the same way
    doc = {"parameters": {}, "features": [
        {"id": "s0", "type": "sketch", "plane": "XY", "entities": [
            {"id": "c1", "type": "circle", "radius": 4, "x": 0, "y": 0}]}]}
    sk = _one(doc, TILTED, {"kind": "sketchCurve", "sketch": "s0", "entity": "c1", "smooth": True})
    assert sk["curves"][0]["curve"].get("smooth") is True, sk
    sil = _one(CYL, TILTED, {"kind": "silhouette", "body": "body1", "smooth": True})
    polys = [c["curve"] for c in sil["curves"] if c["curve"]["kind"] == "poly"]
    assert polys and all(c.get("smooth") is True for c in polys), sil
    sil_old = _one(CYL, TILTED, {"kind": "silhouette", "body": "body1"})
    assert all("smooth" not in c["curve"] for c in sil_old["curves"]), sil_old
    print("  smooth flag OK: new links only, sampled polys only")


def test_smooth_flag_skips_a_source_with_a_corner():
    """A source curve with a corner INSIDE one edge (C0 B-spline) stays faceted
    even on a smooth link: a spline through it would round the corner off."""
    from build123d import Edge, Plane
    from OCP.Geom import Geom_BSplineCurve
    from OCP.gp import gp_Pnt
    from OCP.TColgp import TColgp_Array1OfPnt
    from OCP.TColStd import TColStd_Array1OfInteger, TColStd_Array1OfReal
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge

    poles = TColgp_Array1OfPnt(1, 3)
    for i, (x, y) in enumerate(((0, 0), (10, 0), (10, 10)), 1):
        poles.SetValue(i, gp_Pnt(x, y, 0))
    knots = TColStd_Array1OfReal(1, 3)
    mults = TColStd_Array1OfInteger(1, 3)
    for i, (k, m) in enumerate(((0.0, 2), (0.5, 1), (1.0, 2)), 1):
        knots.SetValue(i, k)
        mults.SetValue(i, m)
    corner = Edge(BRepBuilderAPI_MakeEdge(Geom_BSplineCurve(poles, knots, mults, 1)).Edge())
    assert "smooth" not in _project_edge_to_plane(corner, Plane.XY, True), "C0 source must stay faceted"
    smooth = Edge.make_spline([(0, 0, 0), (5, 3, 1), (10, 0, 2)])
    assert _project_edge_to_plane(smooth, Plane.XY, True).get("smooth") is True
    print("  smooth flag OK: a C0 source stays faceted")


def test_curve_close():
    """_curve_close: kind + all numbers within 1e-4; poly pointwise, length-strict."""
    a = {"kind": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0}
    assert _curve_close(a, {**a, "x2": 10.00005})
    assert not _curve_close(a, {**a, "x2": 10.001})
    assert not _curve_close(a, {"kind": "circle", "x": 0, "y": 0, "r": 5})
    p = {"kind": "poly", "pts": [[0, 0], [1, 1]]}
    assert _curve_close(p, {"kind": "poly", "pts": [[0, 0.00005], [1, 1]]})
    assert not _curve_close(p, {**p, "smooth": True}), "the smooth flag is part of the curve"
    q = {"kind": "point", "x": 1, "y": 2}
    assert _curve_close(q, {**q, "y": 2.00005}) and not _curve_close(q, {**q, "y": 2.01})
    assert not _curve_close(p, {"kind": "poly", "pts": [[0, 0.01], [1, 1]]})
    assert not _curve_close(p, {"kind": "poly", "pts": [[0, 0], [1, 1], [2, 2]]})
    print("  _curve_close OK: tolerance + kind + poly-length compare")


if __name__ == "__main__":
    print("test_project_op:")
    test_box_top_boundary()
    test_cylinder_rim_exact_circle()
    test_cylinder_rim_tilted_poly()
    test_degenerate_vertical_edge()
    test_sketch_curve_cross_plane()
    test_sketch_curve_same_plane_exact()
    test_multi_edge_sketch_source()
    test_error_entries()
    test_vertex_point()
    test_vertex_is_kept_by_one_edge_whichever_was_picked()
    test_vertex_pick_refuses_a_point_off_the_edge()
    test_sketch_point()
    test_smooth_flag_marks_sampled_polys_of_new_links_only()
    test_smooth_flag_skips_a_source_with_a_corner()
    test_curve_close()
    print("ALL PASS")
