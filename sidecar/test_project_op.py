"""projectGeometry aux-op + projection math — _project_edge_to_plane exactness
(line/circle/arc vs sampled-poly fallback), _curve_close tolerance compare, and
project_geometry's strict per-source resolution (missing body / ambiguous
selector → error entries, never exceptions).

Run:  uv run python test_project_op.py
"""

from builder import (
    _curve_close,
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


def test_curve_close():
    """_curve_close: kind + all numbers within 1e-4; poly pointwise, length-strict."""
    a = {"kind": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0}
    assert _curve_close(a, {**a, "x2": 10.00005})
    assert not _curve_close(a, {**a, "x2": 10.001})
    assert not _curve_close(a, {"kind": "circle", "x": 0, "y": 0, "r": 5})
    p = {"kind": "poly", "pts": [[0, 0], [1, 1]]}
    assert _curve_close(p, {"kind": "poly", "pts": [[0, 0.00005], [1, 1]]})
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
    test_curve_close()
    print("ALL PASS")
