"""Two sketch shapes that draw the SAME edge must both own it.

Run: uv run python test_region_coincident_entities.py

Field report d7659f36 (0.1.186). The reporter drew a 145x127 rectangle with a
30x30 square tucked flush into each corner, picked seventeen areas and extruded
them, then aimed a 2 mm cut at one corner. Two symptoms, one cause: "it does not
effect on all selected areas" (the four corners never came up) and "it effects on
an other area" (the cut landed on a band the reporter never picked).

A square sitting FLUSH in the corner of a rectangle shares two whole edges with
it — not crossing it, lying on it. `_subdivide_faces` attributes each split edge
piece to the sketch entity it came from, and the splitter reports the one fused
piece for BOTH tool edges. The attribution was a plain assignment, so the last
writer won and the rectangle lost the piece every time: eight of the reporter's
sixty pieces were claimed twice, and the outer rectangle lost all eight. The four
corner cells then came out labelled without it.

The frontend tracer (src/sketch/region.ts) keeps a per-SEGMENT id, so it never
lost anything — it wrote {outer, inner, corner} into the document. The name tier
in `_region_cells_by_entities` demands the cell's label CONTAIN every stored id,
so the true cell was excluded and the pick drifted onto a neighbour.

The fixture below is the smallest shape with that coincidence in it: a 40x40
outer rectangle, a 30x30 inner one, and two 10x10 squares in opposite corners,
flush with the outer. `sqA`'s left and bottom edges lie exactly on the outer
rectangle's.

Both tests here are RED before the fix (`test_the_corner_cell_names_all_three`
labels the cell {inner, sqA}; `test_the_corner_extrudes_where_it_was_picked`
builds 550 mm3 of a band the pick never touched).
"""

import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

from builder import _build_sketch, rebuild  # noqa: E402

PASS = "  ok"

# outer 40x40 and inner 30x30 are concentric; sqA and sqB sit in opposite corners
# with two edges each lying ON the outer rectangle. That coincidence is the bug.
ENTITIES = [
    {"id": "outer", "type": "rectangle", "x": 0, "y": 0, "width": 40, "height": 40},
    {"id": "inner", "type": "rectangle", "x": 0, "y": 0, "width": 30, "height": 30},
    {"id": "sqA", "type": "rectangle", "x": -15, "y": -15, "width": 10, "height": 10},
    {"id": "sqB", "type": "rectangle", "x": 15, "y": 15, "width": 10, "height": 10},
]

SKETCH = {"id": "f1", "type": "sketch", "plane": "XY", "entities": ENTITIES}

# The corner L: sqA (100 mm2) minus the 5x5 it shares with the inner rectangle.
CORNER_AREA = 75.0
# What the pick drifted onto instead. The band along the bottom edge is bounded by
# BOTH squares, so its ids are a superset of the corner's and it passed the
# "contains every named id" tier while the corner itself was excluded.
BAND_AREA = 275.0

# One region, picked inside the corner L. The point and the three ids are not
# invented: `detectRegions` on this sketch returns exactly
# {75.000, ["inner","outer","sqA"], interior (-19.50, -19.50)} for that cell, so
# this is the reference the app writes when the user clicks there.
EXTRUDE = {
    "id": "f2", "type": "extrude", "sketch": "f1", "distance": 2,
    "operation": "new", "hiddenBodies": [],
    "regions": [[-19.5, -19.5, 0]],
    "regionEntities": [["outer", "inner", "sqA"]],
    "regionHoleEntities": [[]],
}


def _cells():
    """(area, label) for every arrangement cell of the fixture sketch."""
    built = _build_sketch(SKETCH, lambda v: v)
    labels = built["cellEntities"]
    faces = built["faces"]
    assert len(labels) == len(faces), (len(labels), len(faces))
    return [(round(f.area, 6), lbl) for f, lbl in zip(faces, labels)]


def test_the_corner_cell_names_all_three():
    """The identity itself, so a later point-based accident cannot make the
    volume test below pass while the name is still wrong.

    Both corners, not just the reporter's: which of the two claimants survived the
    old plain assignment was an accident of iteration order."""
    cells = _cells()
    corners = [lbl for area, lbl in cells if area == CORNER_AREA]
    assert len(corners) == 2, f"expected two {CORNER_AREA} mm2 cells, got {cells}"
    assert sorted(sorted(lbl or ()) for lbl in corners) == [
        ["inner", "outer", "sqA"], ["inner", "outer", "sqB"]
    ], f"a corner cell lost an entity that bounds it: {[sorted(l or ()) for l in corners]}"
    print(PASS, "a cell bounded by a shared edge names every entity that draws it")


def test_the_corner_extrudes_where_it_was_picked():
    """The report, in one number: extrude the corner area and you get the corner
    area, not a band somewhere else in the sketch."""
    part, errors, bodies = rebuild({"features": [SKETCH, EXTRUDE]})
    assert not errors, errors
    assert len(bodies) == 1, bodies
    assert abs(part.volume - CORNER_AREA * 2) < 1e-6, (
        f"extruded {part.volume:.3f} mm3; the picked corner is "
        f"{CORNER_AREA * 2:.3f} and the band it used to drift onto is "
        f"{BAND_AREA * 2:.3f}")
    print(PASS, "the picked corner area extrudes as itself")


def test_a_crossing_sketch_still_resolves():
    """Control: entities that merely CROSS were never mis-attributed, and the
    set-valued label must not disturb them. A line across the inner rectangle
    splits it into two halves that carry the same ids; picking one still gets
    that half and not the whole."""
    entities = [
        {"id": "r", "type": "rectangle", "x": 0, "y": 0, "width": 20, "height": 20},
        {"id": "cut", "type": "line", "x1": -20, "y1": 0, "x2": 20, "y2": 0},
    ]
    doc = {"features": [
        {"id": "f1", "type": "sketch", "plane": "XY", "entities": entities},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 1,
         "operation": "new", "hiddenBodies": [],
         "regions": [[0, 5, 0]], "regionEntities": [["r", "cut"]],
         "regionHoleEntities": [[]]},
    ]}
    part, errors, _bodies = rebuild(doc)
    assert not errors, errors
    assert abs(part.volume - 200.0) < 1e-6, part.volume  # the top half, 20x10x1
    print(PASS, "a crossing entity still selects its own half")


def main():
    print("Coincident sketch entities share an edge (field report d7659f36)")
    test_the_corner_cell_names_all_three()
    test_the_corner_extrudes_where_it_was_picked()
    test_a_crossing_sketch_still_resolves()
    print("ALL PASS")


if __name__ == "__main__":
    main()
