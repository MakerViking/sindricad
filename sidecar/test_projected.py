"""Projected-entity build consumption — _build_sketch's "projected" branch turns
the CACHED curve into profile edges/faces exactly like hand-drawn geometry (no
ctx/bodies access; the cache refresh is a later step's rebuild handler).

Run:  uv run python test_projected.py
"""

import math

from builder import rebuild

# a plausible source reference; _build_sketch must never resolve it
SRC = {"kind": "edge", "body": "body1",
       "sel": {"kind": "edge", "by": "match", "fp": {"mid": [0, 0, 0], "dir": [1, 0, 0]}}}


def _pline(i, x1, y1, x2, y2):
    return {"id": f"p{i}", "type": "projected", "source": SRC,
            "curve": {"kind": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2}}


def test_projected_square_extrude():
    """4 projected lines forming a 20x20 square extrude to one 4000 mm^3 body."""
    ents = [_pline(0, 0, 0, 20, 0), _pline(1, 20, 0, 20, 20),
            _pline(2, 20, 20, 0, 20), _pline(3, 0, 20, 0, 0)]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1, f"expected 1 body, got {len(bodies)}"
    assert abs(part.volume - 4000) < 1, f"20x20x10 square = 4000, got {part.volume:.1f}"
    print(f"  projected square OK: 1 body, vol {part.volume:.0f}")


def test_projected_circle_extrude():
    """A projected circle extrudes to a cylinder (pi * r^2 * h)."""
    ents = [{"id": "pc", "type": "projected", "source": SRC,
             "curve": {"kind": "circle", "x": 0, "y": 0, "r": 5}}]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1
    want = math.pi * 25 * 10
    assert abs(part.volume - want) < 1, f"cylinder r5 h10 = {want:.1f}, got {part.volume:.1f}"
    print(f"  projected circle OK: cylinder vol {part.volume:.0f}")


def test_projected_poly_extrude():
    """A projected poly (sampled fallback) closes into a profile: a right
    triangle of area 50 extrudes to 500 mm^3."""
    ents = [{"id": "pp", "type": "projected", "source": SRC,
             "curve": {"kind": "poly", "pts": [[0, 0], [10, 0], [0, 10], [0, 0]]}}]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1
    assert abs(part.volume - 500) < 1, f"triangle 50 * 10 = 500, got {part.volume:.1f}"
    print(f"  projected poly OK: vol {part.volume:.0f}")


def test_projected_degenerate_poly_skipped():
    """A point-degenerate poly (a view-aligned source edge — coincident samples)
    is reference-only: it must never fail the sketch, and the square around it
    still extrudes."""
    ents = [_pline(0, 0, 0, 20, 0), _pline(1, 20, 0, 20, 20),
            _pline(2, 20, 20, 0, 20), _pline(3, 0, 20, 0, 0),
            {"id": "pp", "type": "projected", "source": SRC,
             "curve": {"kind": "poly", "pts": [[10.0, 10.0], [10.0, 10.0]]}}]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert abs(part.volume - 4000) < 1, f"degenerate poly must be a no-op: got {part.volume:.1f}"
    print(f"  projected degenerate poly OK: skipped, vol {part.volume:.0f}")


def test_projected_construction_excluded():
    """A CONSTRUCTION projected circle inside a projected square is reference-only:
    it must not subdivide the profile, so a region pick at the circle's center
    extrudes the WHOLE square (4000) — not just an inner disk (~785)."""
    ents = [_pline(0, 0, 0, 20, 0), _pline(1, 20, 0, 20, 20),
            _pline(2, 20, 20, 0, 20), _pline(3, 0, 20, 0, 0),
            {"id": "pc", "type": "projected", "source": SRC, "construction": True,
             "curve": {"kind": "circle", "x": 10, "y": 10, "r": 5}}]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new",
         "regions": [[10, 10, 0]]}]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1
    assert abs(part.volume - 4000) < 1, \
        f"construction circle must not carve the square: want 4000, got {part.volume:.1f}"
    print(f"  projected construction OK: excluded from profile, vol {part.volume:.0f}")


def _cap(curve):
    """Extrude one projected curve 10 mm: (face count, area of a planar cap)."""
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"id": "pe", "type": "projected", "source": SRC, "curve": curve}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}]}
    _part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1, bodies
    faces = bodies[0]["shape"].faces()
    caps = [f for f in faces if abs(abs(f.normal_at().Z) - 1) < 1e-9]
    return len(faces), caps[0].area


def test_projected_smooth_poly_is_one_spline():
    """A poly the projection marked smooth builds ONE spline through its
    samples, so a projected 20 x 8 ellipse extrudes to 3 faces with the true cap
    area (pi * 20 * 8, within 1e-4); without the flag (every link made before
    it) it stays the faceted 128-segment outline it always built. Cap AREAS,
    not volumes: build123d's volume of a spline prism under-reads."""
    from build123d import Edge, Plane

    from builder import _project_edge_to_plane

    exact = math.pi * 20 * 8
    poly = _project_edge_to_plane(Edge.make_ellipse(20, 8), Plane.XY)
    assert poly["kind"] == "poly" and "smooth" not in poly and len(poly["pts"]) == 129, poly.keys()
    n_faces, area = _cap(poly)
    assert n_faces == 130, f"an unflagged poly must stay faceted: {n_faces} faces"
    assert abs(area - exact) / exact > 1e-4, "the faceted outline is measurably short"
    n_faces, area = _cap({**poly, "smooth": True})
    assert n_faces == 3, f"one spline side face + two caps, got {n_faces}"
    assert abs(area - exact) / exact < 1e-4, f"cap {area:.4f} vs exact {exact:.4f}"
    print(f"  projected smooth poly OK: 3 faces, cap {area:.3f} (exact {exact:.3f})")


def test_projected_smooth_poly_tilted_circle():
    """A small circle tilted 85 degrees to the sketch, the coarsest sampling
    there is (16 segments) and samples nine times closer at the ends than at
    the sides: the spline still lands on the true ellipse area within 1e-3,
    where the faceted outline is 2.5e-2 short."""
    from build123d import Edge, Plane

    from builder import _project_edge_to_plane

    t = math.radians(85)
    plane = Plane(origin=(0, 0, 0), x_dir=(1, 0, 0), z_dir=(0, math.sin(t), math.cos(t)))
    poly = _project_edge_to_plane(Edge.make_circle(1), plane, smooth=True)
    assert poly.get("smooth") is True and len(poly["pts"]) == 17, poly
    exact = math.pi * math.cos(t)
    n_faces, area = _cap(poly)
    assert n_faces == 3 and abs(area - exact) / exact < 1e-3, (n_faces, area, exact)
    _n, faceted = _cap({"kind": "poly", "pts": poly["pts"]})
    assert abs(faceted - exact) / exact > 2e-2, faceted
    print(f"  projected smooth tilted circle OK: cap {area:.5f} (exact {exact:.5f})")


def test_projected_smooth_fold_stays_faceted():
    """A smooth-marked poly that FOLDS (a circle seen exactly edge-on runs out
    and back along one line) cannot be one spline: it builds what it always
    built instead of failing the sketch."""
    from builder import _smooth_poly_edge

    fold = [[math.cos(i / 16 * 2 * math.pi) * 5, 0.0] for i in range(17)]
    fold[-1] = fold[0]
    assert _smooth_poly_edge(fold) is None
    ents = [_pline(0, -8, -8, 8, -8), _pline(1, 8, -8, 8, 8),
            _pline(2, 8, 8, -8, 8), _pline(3, -8, 8, -8, -8),
            {"id": "pf", "type": "projected", "source": SRC,
             "curve": {"kind": "poly", "pts": fold, "smooth": True}}]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}]}
    part, err, _bodies = rebuild(doc)
    assert not err, err
    assert abs(part.volume - 2560) < 1, part.volume
    print("  projected smooth fold OK: faceted, square still extrudes")


def _ellipse_with_chord_line(smooth, x0):
    """A projected 20 x 8 ellipse and a line across it at x = x0 whose ends sit
    ON the chords between two samples: where the app's trim or extend to the
    curve puts them, since the app draws the poly as those chords."""
    from build123d import Edge, Plane

    from builder import _project_edge_to_plane

    poly = _project_edge_to_plane(Edge.make_ellipse(20, 8), Plane.XY, smooth=smooth)
    pts = poly["pts"]
    hits = []
    for a, b in zip(pts, pts[1:]):
        if (a[0] - x0) * (b[0] - x0) < 0:
            t = (x0 - a[0]) / (b[0] - a[0])
            hits.append(a[1] + t * (b[1] - a[1]))
    y1, y2 = sorted(hits)
    return [{"id": "pe", "type": "projected", "source": {**SRC, **({"smooth": True} if smooth else {})},
             "curve": poly},
            {"id": "ln", "type": "line", "x1": x0, "y1": y1, "x2": x0, "y2": y2}]


def test_projected_smooth_poly_a_line_ends_on():
    """A line trimmed to a smooth projected curve ends on a CHORD, short of the
    spline the kernel builds through the samples by up to the spline's bulge
    (2.5e-3 mm here). Built as a spline, the two areas the user sees on either
    side of the line were one, and an extrude of the small one took the whole
    ellipse without a word. Such a poly builds the faceted outline the app
    draws, so the extrude takes exactly the area that was picked; the same
    ellipse with nothing ending on it still builds as one spline."""
    for x0, small in ((5.3, 167.409), (17.3, 14.579), (19.7, 0.519)):
        ents = _ellipse_with_chord_line(True, x0)
        doc = {"parameters": {}, "features": [
            {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
            {"id": "e", "type": "extrude", "sketch": "s", "distance": 1, "operation": "new",
             "regions": [[(x0 + 20) / 2 if x0 < 19 else 19.85, 0, 0]], "regionEntities": [["pe", "ln"]]}]}
        _part, err, bodies = rebuild(doc)
        assert not err, err
        assert len(bodies) == 1 and abs(bodies[0]["shape"].volume - small) < 1e-2, \
            (x0, [b["shape"].volume for b in bodies])
    n_faces, _area = _cap(_ellipse_with_chord_line(True, 5.3)[0]["curve"])
    assert n_faces == 3, "with nothing ending on it the ellipse is still one spline"
    print("  projected smooth poly a line ends on OK: faceted there, the picked area extrudes")


def test_projected_smooth_silhouette_whole_outline():
    """A silhouette's rims and sides meet three curve ends at a point, and the
    loops of the whole sketch (what Revolve, Sweep and an extrude with no area
    picked use) are paired up there by edge order: one smooth spline where
    there were dozens of pieces turned a tilted cylinder's whole 270 mm2
    outline into one 96 mm2 piece of it. The loops come from the faceted
    pieces there, exactly as before, and the areas stay smooth."""
    from builder import project_geometry

    tilt = {"origin": [60, 0, 0], "xdir": [1, 0, 0], "normal": [0, 0.5, 0.8660254037844386]}
    top = {"origin": [0, 0, 40], "xdir": [1, 0, 0], "normal": [0, 0, 1]}
    base = [
        {"id": "f2", "type": "sketch", "plane": tilt, "entities": [
            {"id": "c0", "type": "circle", "x": 0, "y": 0, "radius": 8}]},
        {"id": "f3", "type": "extrude", "sketch": "f2", "distance": 12, "operation": "new"},
    ]
    sil = {"kind": "silhouette", "body": "body1", "smooth": True}
    (res,) = project_geometry({"parameters": {}, "features": base}, top, [sil])["results"]
    assert res["ok"] and any(c["curve"].get("smooth") for c in res["curves"]), res
    ents = [{"id": f"p{k}", "type": "projected", "source": sil, "curve": c["curve"]}
            for k, c in enumerate(res["curves"])]
    whole = {"id": "f5", "type": "extrude", "sketch": "f4", "distance": 5, "operation": "new"}
    # (60, -3) is under the top rim's ellipse, inside the 96 mm2 piece
    for extrude, want in ((whole, 269.988), ({**whole, "regions": [[60, -3, 40]]}, 96.0)):
        doc = {"parameters": {}, "features": base + [
            {"id": "f4", "type": "sketch", "plane": top, "entities": ents}, extrude]}
        _part, err, bodies = rebuild(doc)
        assert not err, err
        (made,) = [b for b in bodies if b["id"] != "body1"]
        caps = [f.area for f in made["shape"].faces() if abs(abs(f.normal_at().Z) - 1) < 1e-9]
        assert caps and all(abs(c - want) < 0.5 for c in caps), (extrude.get("regions"), caps)
        if "regions" in extrude:  # two caps, two sides, two rim splines
            assert len(made["shape"].faces()) == 6, len(made["shape"].faces())
    print("  projected smooth silhouette OK: whole outline kept, picked area smooth")


def test_projected_point_is_reference_only():
    """A projected POINT (a body corner, another sketch's point) has no curve:
    it never joins a profile and never fails the sketch."""
    ents = [_pline(0, 0, 0, 20, 0), _pline(1, 20, 0, 20, 20),
            _pline(2, 20, 20, 0, 20), _pline(3, 0, 20, 0, 0),
            {"id": "pt", "type": "projected", "source": SRC,
             "curve": {"kind": "point", "x": 10.0, "y": 10.0}}]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1 and abs(part.volume - 4000) < 1, part.volume
    print(f"  projected point OK: reference-only, vol {part.volume:.0f}")


if __name__ == "__main__":
    print("test_projected:")
    test_projected_square_extrude()
    test_projected_circle_extrude()
    test_projected_poly_extrude()
    test_projected_degenerate_poly_skipped()
    test_projected_construction_excluded()
    test_projected_smooth_poly_is_one_spline()
    test_projected_smooth_poly_tilted_circle()
    test_projected_smooth_fold_stays_faceted()
    test_projected_smooth_poly_a_line_ends_on()
    test_projected_smooth_silhouette_whole_outline()
    test_projected_point_is_reference_only()
    print("ALL PASS")
