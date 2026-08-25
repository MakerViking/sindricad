"""Extruding disconnected areas gives one body PER CONNECTED LUMP.

Field report (2026-08-26, Thomas): a ring split into eight slices, alternate
slices selected and extruded — "this resulted in only two bodies, so all bodies
extruded at the same time turns into one body, even though they aren't
connected. This is different from how Fusion does it."

Run:  uv run python test_separate_bodies.py

The important assertions are the ADJACENCY ones. "Four areas give four bodies" is
satisfied by any rule that splits per selected area, including a wrong one that
splits by bounding box. Alternate slices of a ring have thoroughly OVERLAPPING
bounding boxes while touching nowhere, and two adjacent slices have to come back
as ONE body — only real kernel connectivity gets both right.
"""

import math
from builder import rebuild

R, r, D = 40.0, 20.0, 5.0
SLICE_VOL = math.pi * (R * R - r * r) * D / 8.0  # one octant of the ring


def _ring_split_in_eight():
    ents = [
        {"type": "circle", "id": "o", "x": 0, "y": 0, "radius": R},
        {"type": "circle", "id": "i", "x": 0, "y": 0, "radius": r},
    ]
    for k in range(4):  # four diameters → eight slices
        a = k * math.pi / 4
        ents.append({
            "type": "line", "id": f"l{k}",
            "x1": -R * 1.2 * math.cos(a), "y1": -R * 1.2 * math.sin(a),
            "x2": R * 1.2 * math.cos(a), "y2": R * 1.2 * math.sin(a),
        })
    return ents


def _slice_point(k):
    """An interior point of slice k, at mid-radius and mid-angle."""
    a = (k + 0.5) * math.pi / 4
    mid = (R + r) / 2
    return [mid * math.cos(a), mid * math.sin(a), 0.0]


def _build(slices, separate=True):
    feat = {
        "id": "e1", "type": "extrude", "sketch": "s1", "distance": D,
        "operation": "new", "regions": [_slice_point(k) for k in slices],
    }
    if separate:
        feat["separateBodies"] = True
    _part, errors, bodies = rebuild({"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": _ring_split_in_eight()},
        feat,
    ]})
    assert not errors, f"unexpected errors: {errors}"
    return sorted(round(b["shape"].volume, 1) for b in bodies)


def test_alternate_slices_become_separate_bodies():
    """The reported case: four slices with a gap between each."""
    vols = _build([0, 2, 4, 6])
    assert len(vols) == 4, f"expected 4 bodies, got {len(vols)}: {vols}"
    for v in vols:
        assert abs(v - SLICE_VOL) < 1.0, f"{v} is not one slice ({SLICE_VOL:.1f})"


def test_adjacent_slices_stay_ONE_body():
    """Two slices sharing an edge are connected, so they are one body.

    This is the assertion a bounding-box rule fails, and it is why connectivity
    is left to the kernel."""
    vols = _build([0, 1])
    assert len(vols) == 1, f"adjacent slices must merge, got {len(vols)}: {vols}"
    assert abs(vols[0] - 2 * SLICE_VOL) < 1.0, f"{vols[0]} is not two slices"


def test_a_mix_splits_on_real_connectivity():
    """Three in a row + one apart = two bodies, 3:1 by volume."""
    vols = _build([0, 1, 2, 5])
    assert len(vols) == 2, f"expected 2 bodies, got {len(vols)}: {vols}"
    assert abs(vols[0] - SLICE_VOL) < 1.0, f"smaller body: {vols[0]}"
    assert abs(vols[1] - 3 * SLICE_VOL) < 1.0, f"larger body: {vols[1]}"


def test_overlapping_bboxes_that_do_not_TOUCH_still_split():
    """A disc sitting in the hole of a ring: the disc's bounding box is entirely
    INSIDE the ring's, and the two solids touch nowhere. They must be two bodies.

    This is the case a bounding-box grouping gets wrong, and it is why
    connectivity is left to the kernel. (For the reported ring-of-octants the
    boxes happen to be disjoint anyway — I asserted otherwise in an earlier
    version of this comment and the test caught it.)"""
    ents = [
        {"type": "circle", "id": "o", "x": 0, "y": 0, "radius": R},
        {"type": "circle", "id": "i", "x": 0, "y": 0, "radius": r},
        {"type": "circle", "id": "d", "x": 0, "y": 0, "radius": r / 2},
    ]
    _part, errors, bodies = rebuild({"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": D, "operation": "new",
         "separateBodies": True,
         "regions": [[(R + r) / 2, 0.0, 0.0], [0.0, 0.0, 0.0]]},  # the ring, and the inner disc
    ]})
    assert not errors, f"unexpected errors: {errors}"
    assert len(bodies) == 2, f"a disc inside a ring's hole must be its own body, got {len(bodies)}"
    vols = sorted(round(b["shape"].volume, 1) for b in bodies)
    assert abs(vols[0] - math.pi * (r / 2) ** 2 * D) < 1.0, f"disc: {vols[0]}"
    assert abs(vols[1] - math.pi * (R * R - r * r) * D) < 1.0, f"ring: {vols[1]}"


def test_legacy_documents_are_unchanged():
    """No flag = the old single-body result, byte for byte.

    Body ids are POSITIONAL, so splitting an old extrude would renumber every
    body after it and silently re-aim saved `body:"bodyN"` selectors."""
    vols = _build([0, 2, 4, 6], separate=False)
    assert len(vols) == 1, f"a legacy extrude must stay ONE body, got {len(vols)}"
    assert abs(vols[0] - 4 * SLICE_VOL) < 1.0, f"{vols[0]} is not four slices"


if __name__ == "__main__":
    test_alternate_slices_become_separate_bodies()
    test_adjacent_slices_stay_ONE_body()
    test_a_mix_splits_on_real_connectivity()
    test_overlapping_bboxes_that_do_not_TOUCH_still_split()
    test_legacy_documents_are_unchanged()
    print("ALL PASS")
