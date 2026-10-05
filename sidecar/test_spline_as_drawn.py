"""A spline drawn since 2026-10 builds as exactly the curve the sketch draws.

Run: uv run python test_spline_as_drawn.py

TA 848b5ed1, decision A4. The sketch draws a spline as a Catmull-Rom curve
through its fit points (src/sketch/spline.ts), but the kernel built
Edge.make_spline (GeomAPI_Interpolate) through the same points: a different
curve, 24.75 mm off on the reporter's 577 mm spline and 17 degrees off at an
end. So the model was not the shape on screen, and a tangency set on screen
could not hold. A spline that carries `asDrawn` (every one drawn from now on)
builds each Catmull-Rom span as the cubic Bezier it is (_catmull_rom_edge); a
`closed` one wraps round with no kink. A spline WITHOUT the flag (every
document made before) still builds through make_spline, unchanged.

The oracle here is the frontend's own formula, re-stated below from
spline.ts: if the two ever drift, the model stops being the drawing again.
"""

import math
import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

from build123d import Edge  # noqa: E402

from builder import _catmull_rom_edge, _entity_edges, _sketch_ref_xy, rebuild  # noqa: E402

PASS = "  ok"


def _catmull(p0, p1, p2, p3, t):
    """spline.ts catmull(), verbatim"""
    t2, t3 = t * t, t * t * t

    def c(a, b, cc, d):
        return 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3)

    return c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])


def _drawn(pts, closed, segs=64):
    """(span, t, point) samples of the drawn curve: spline.ts splinePolyline"""
    n = len(pts)

    def at(k):
        return pts[k % n] if closed else pts[min(n - 1, max(0, k))]

    out = []
    for i in range(n if closed else n - 1):
        for s in range(segs):
            t = s / segs
            out.append((i, t, _catmull(at(i - 1), at(i), at(i + 1), at(i + 2), t)))
    return out


def _worst_gap(edge, pts, closed):
    """the farthest any drawn sample sits from the built curve at the same parameter"""
    from OCP.BRep import BRep_Tool
    c = BRep_Tool.Curve_s(edge.wrapped, 0.0, 1.0)
    worst = 0.0
    for i, t, (x, y) in _drawn(pts, closed):
        p = c.Value(i + t)
        worst = max(worst, math.hypot(p.X() - x, p.Y() - y))
    return worst


# Uneven spacing and a sharp turn: where make_spline strays furthest (3.84 mm
# measured on uneven spacing in the triage).
UNEVEN = [(0.0, 0.0), (4.0, 9.0), (30.0, 12.0), (33.0, -4.0), (60.0, 0.0)]


def _sp(pts, **flags):
    return {"type": "spline", "id": "sp", "points": [{"x": x, "y": y} for x, y in pts], **flags}


def test_an_as_drawn_spline_is_the_drawn_curve():
    for closed in (False, True):
        e = _catmull_rom_edge(UNEVEN, closed)
        gap = _worst_gap(e, UNEVEN, closed)
        assert gap < 1e-9, f"closed={closed}: built curve strays {gap:.3g} mm from the drawn one"
        assert e.is_closed == closed
    # and through _entity_edges, the one construction path every sketch uses
    built = _entity_edges(_sp(UNEVEN, asDrawn=True), lambda v: v)
    assert len(built) == 1 and _worst_gap(built[0], UNEVEN, False) < 1e-9
    print(PASS, "an as-drawn spline, open or closed, is the drawn Catmull-Rom curve to 1e-9 mm")


def test_the_old_build_was_a_different_curve():
    """Why the flag exists, measured rather than asserted from the triage: the
    interpolated spline is millimetres off the drawn one on the same points."""
    old = Edge.make_spline([(x, y, 0) for x, y in UNEVEN])
    worst = 0.0
    for _, _, (x, y) in _drawn(UNEVEN, False):
        q = old.wrapped
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
        from OCP.gp import gp_Pnt
        d = BRepExtrema_DistShapeShape(BRepBuilderAPI_MakeVertex(gp_Pnt(x, y, 0)).Vertex(), q)
        worst = max(worst, d.Value())
    assert worst > 0.5, f"make_spline came within {worst:.3f} mm of the drawn curve; the test points are too tame"
    print(PASS, f"the old interpolation strays {worst:.2f} mm from the drawn curve on the same points")


def test_an_old_spline_still_builds_the_old_way():
    """A spline with no flag is a document made before 2026-10: it must build
    exactly what it built, which is make_spline through its points."""
    ents = _entity_edges(_sp(UNEVEN), lambda v: v)
    ref = Edge.make_spline([(x, y, 0) for x, y in UNEVEN])
    assert len(ents) == 1
    a, b = ents[0], ref
    for k in range(0, 101):
        u = k / 100
        pa, pb = a.position_at(u), b.position_at(u)
        assert (pa - pb).length < 1e-12, f"an unflagged spline moved at u={u}"
    print(PASS, "an unflagged spline builds through make_spline, unchanged")


def _profile_doc(spline, extra=(), distance=5.0):
    return {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [spline, *extra]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": distance, "operation": "new"},
    ]}


def _cap_area(part):
    """The area the profile encloses, read off the extrusion's bottom caps.

    Not `part.volume / distance`: OCCT's volume integration is unreliable on
    an extruded B-spline side, whatever the spline (measured on BLOB: 3678 mm3
    at the default precision and 3291 at 1e-9 for a true 3663.33, and the same
    scatter for make_spline's own curves), while a planar cap integrates
    exactly at 1e-9 (732.6667 against 732.6667 by Green's theorem on the
    curve)."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    total = 0.0
    for f in part.faces():
        if f.geom_type.name == "PLANE" and f.normal_at().Z < -0.5:
            g = GProp_GProps()
            BRepGProp.SurfaceProperties_s(f.wrapped, g, 1e-9)
            total += g.Mass()
    return total


def _shoelace(pts):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))) / 2


BLOB = [(0.0, 0.0), (20.0, -4.0), (34.0, 8.0), (22.0, 22.0), (2.0, 16.0)]


def test_a_closed_spline_extrudes_to_one_smooth_side():
    part, err, _ = rebuild(_profile_doc(_sp(BLOB, asDrawn=True, closed=True)))
    assert not err, err
    assert part.is_valid
    # the area the sketch shades, sampled densely: the built face is that curve
    drawn = [p for _, _, p in _drawn(BLOB, True, segs=400)]
    area = _cap_area(part)
    assert abs(area - _shoelace(drawn)) / area < 1e-5, (area, _shoelace(drawn))
    # one periodic edge: two caps and ONE side, no seam face or kink
    assert len(part.faces()) == 3, f"expected caps + one smooth side, got {len(part.faces())} faces"
    edge = _catmull_rom_edge(BLOB, True)
    d0, d1 = edge.tangent_at(0.0), edge.tangent_at(1.0)
    assert (d0 - d1).length < 1e-9, "the closed spline kinks where it joins"
    print(PASS, f"a closed spline extrudes to one valid solid with one smooth side (area {area:.4f} mm2)")


def test_a_line_from_its_first_point_leaves_the_profile_whole():
    """The seam is a vertex lines can start from (the sketch snaps to it); the
    closed edge must still bound its own face, as region.ts shades it
    (splineClose.test.ts, the same case)."""
    line = {"id": "l", "type": "line", "x1": BLOB[0][0], "y1": BLOB[0][1], "x2": -20, "y2": -10}
    part, err, _ = rebuild(_profile_doc(_sp(BLOB, asDrawn=True, closed=True), [line]))
    assert not err, err
    drawn = [p for _, _, p in _drawn(BLOB, True, segs=400)]
    assert abs(_cap_area(part) - _shoelace(drawn)) / _shoelace(drawn) < 1e-5, _cap_area(part)
    print(PASS, "a line drawn from a closed spline's first point leaves its profile whole")


def test_a_flagged_spline_closes_a_profile_with_lines():
    """An open as-drawn spline in a loop with lines: the loop assembly and the
    region arrangement both take the new edge."""
    pts = [(0.0, 10.0), (4.0, 6.0), (-3.0, 3.0), (0.0, 0.0)]
    lines = [
        {"id": "l0", "type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0},
        {"id": "l1", "type": "line", "x1": 10, "y1": 0, "x2": 10, "y2": 10},
        {"id": "l2", "type": "line", "x1": 10, "y1": 10, "x2": 0, "y2": 10},
    ]
    part, err, _ = rebuild(_profile_doc(_sp(pts, asDrawn=True), lines))
    assert not err, err
    # the drawn samples run (0,10) -> (0,0); finish at (0,0), then the lines
    drawn = [p for _, _, p in _drawn(pts, False, segs=400)] + [pts[-1], (10.0, 0.0), (10.0, 10.0)]
    area = _cap_area(part)
    assert abs(area - _shoelace(drawn)) / area < 1e-5, (area, _shoelace(drawn))
    print(PASS, f"an as-drawn spline closes a profile with lines (area {area:.4f} mm2)")


def test_a_patterned_copy_builds_like_its_source():
    """_translate_entity / _rotate_entity must carry the flags, or every copy
    builds the OLD curve (and a closed one opens and builds nothing)."""
    sp = _sp(BLOB, asDrawn=True, closed=True)
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [sp],
         "patterns": [{"id": "pr", "type": "patternRect", "sources": ["sp"],
                       "countX": 2, "countY": 1, "spacingX": 60, "spacingY": 0}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"},
    ]}
    part, err, _ = rebuild(doc)
    assert not err, err
    one, err1, _ = rebuild(_profile_doc(sp))
    assert not err1, err1
    assert abs(_cap_area(part) - 2 * _cap_area(one)) < 1e-6 * _cap_area(one), (_cap_area(part), _cap_area(one))
    circ = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [sp],
         "patterns": [{"id": "pc", "type": "patternCircular", "sources": ["sp"],
                       "cx": -40, "cy": 0, "count": 2, "angle": 180}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"},
    ]}
    part2, err2, _ = rebuild(circ)
    assert not err2, err2
    assert abs(_cap_area(part2) - 2 * _cap_area(one)) < 1e-6 * _cap_area(one), (_cap_area(part2), _cap_area(one))
    print(PASS, "linear and circular pattern copies of a closed as-drawn spline build like it")


def test_a_closed_spline_is_guarded_like_an_open_one():
    def err_of(spline):
        _, err, _ = rebuild(_profile_doc(spline))
        return str(err or "")
    two = err_of(_sp([(0, 0), (10, 0)], asDrawn=True, closed=True))
    assert "fewer than 3 points" in two, two
    # the closing pair counts: a last point back on the first is a zero span
    back = err_of(_sp([(0, 0), (10, 0), (5, 8), (0, 0)], asDrawn=True, closed=True))
    assert "two points in the same place" in back, back
    print(PASS, "a closed spline with too few points, or its last on its first, names itself")


def test_a_closed_splines_only_point_is_its_first():
    """src/sketch/entityDims.ts dimRefPoints numbers a closed spline's points 0
    only; the sidecar's reference resolver must not invent a 1."""
    sp = _sp(BLOB, asDrawn=True, closed=True)
    assert _sketch_ref_xy(sp, 0, lambda v: v) == BLOB[0]
    assert _sketch_ref_xy(sp, 1, lambda v: v) is None
    assert _sketch_ref_xy(_sp(BLOB, asDrawn=True), 1, lambda v: v) == BLOB[-1]
    print(PASS, "a closed spline exposes only its first point")


def main():
    print("As-drawn spline tests (TA 848b5ed1, decision A4)")
    test_an_as_drawn_spline_is_the_drawn_curve()
    test_the_old_build_was_a_different_curve()
    test_an_old_spline_still_builds_the_old_way()
    test_a_closed_spline_extrudes_to_one_smooth_side()
    test_a_line_from_its_first_point_leaves_the_profile_whole()
    test_a_flagged_spline_closes_a_profile_with_lines()
    test_a_patterned_copy_builds_like_its_source()
    test_a_closed_spline_is_guarded_like_an_open_one()
    test_a_closed_splines_only_point_is_its_first()
    print("ALL PASS")


if __name__ == "__main__":
    main()
