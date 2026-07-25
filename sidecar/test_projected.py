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


if __name__ == "__main__":
    print("test_projected:")
    test_projected_square_extrude()
    test_projected_circle_extrude()
    test_projected_poly_extrude()
    test_projected_degenerate_poly_skipped()
    test_projected_construction_excluded()
    print("ALL PASS")
