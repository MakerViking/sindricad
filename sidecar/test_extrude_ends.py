"""Extrude start/end conditions — `startOffset`, `upTo`, `upToPlane`, `upToOffset`.

GitHub issue #41 ("make extrude really, really powerful") and field report
ffab4ece. Press/pull already had this vocabulary; extrude did not.

Run:  uv run python test_extrude_ends.py

WHAT THESE TESTS ARE FOR, because the obvious assertions do not catch the
dangerous failure. The tempting implementation is a single scalar sweep —
measure the distance from the profile centre to the target plane and extrude by
it. Against a target PARALLEL to the sketch that is exactly right, and the volume
is exactly right too. Against a TILTED target it produces a flat-topped solid:
correct along the centre line and silently wrong everywhere else, with no error
raised. `test_tilted_target_lands_on_the_plane` is the one that sees it, and it
sees it by checking that every vertex of the new top face lies ON the target
plane — a volume assertion cannot, which is the whole lesson from the
press/pull version of this bug.
"""

import math

from builder import rebuild
from tessellate import bbox

TOL = 1e-6


def _sq(size=20.0, plane="XY", sid="s1"):
    """A `size` x `size` rectangle sketch centred on the origin of `plane`."""
    return {
        "id": sid,
        "type": "sketch",
        "plane": plane,
        "entities": [{"type": "rectangle", "width": size, "height": size, "x": 0, "y": 0}],
    }


def _build(features, parameters=None):
    doc = {"parameters": parameters or {}, "features": features}
    part, errors, bodies = rebuild(doc)
    return part, errors, bodies


def _expect_error(features, needle, what):
    """The rebuild must REFUSE, and say `needle`. A silent success is the bug."""
    _part, errors, _bodies = _build(features)
    assert errors, f"{what}: expected a refusal, got none"
    joined = " | ".join(str(e) for e in errors)
    assert needle.lower() in joined.lower(), f"{what}: wrong message: {joined}"


def test_up_to_base_plane():
    """`upToPlane` naming a base plane stops the sweep exactly there."""
    part, errors, _ = _build([
        # sketch on XY, extrude up to a datum 10 above it
        _sq(),
        {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 10},
        # distance is deliberately a LIE (1 mm): with a target it must not be read
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 1,
         "operation": "new", "upToPlane": "d1"},
    ])
    assert not errors, f"unexpected errors: {errors}"
    bb = bbox(part)
    assert abs(bb["min"][2] - 0.0) < 1e-4, f"bottom should sit on the sketch: {bb['min']}"
    assert abs(bb["max"][2] - 10.0) < 1e-4, f"top should land on the datum: {bb['max']}"
    assert abs(part.volume - 20 * 20 * 10) < 1e-3, f"volume: {part.volume}"


def test_up_to_offset_moves_the_landing():
    """`upToOffset` shifts where it stops — positive goes PAST the target."""
    part, errors, _ = _build([
        _sq(),
        {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 10},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 1,
         "operation": "new", "upToPlane": "d1", "upToOffset": 3},
    ])
    assert not errors, f"unexpected errors: {errors}"
    bb = bbox(part)
    assert abs(bb["max"][2] - 13.0) < 1e-4, f"offset should overshoot to 13: {bb['max']}"


def test_tilted_target_lands_on_the_plane():
    """THE ONE THAT MATTERS. A target tilted to the sketch must be reproduced as
    the new top FACE — not approximated by a flat top at the centre distance.

    A scalar sweep passes a volume check here and fails this one."""
    ang = math.radians(20.0)
    # a plane through (0,0,10), tilted `ang` about the Y axis
    normal = (math.sin(ang), 0.0, math.cos(ang))
    part, errors, _ = _build([
        _sq(),
        {"id": "d1", "type": "datumPlane",
         "plane": {"origin": [0, 0, 10], "normal": list(normal), "xdir": [math.cos(ang), 0, -math.sin(ang)]}},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 1,
         "operation": "new", "upToPlane": "d1"},
    ])
    assert not errors, f"unexpected errors: {errors}"

    # Find the face whose normal matches the target's, and require EVERY vertex of
    # it to satisfy the plane equation. A flat top would sit at a constant z and
    # fail for every vertex off the centre line.
    origin = (0.0, 0.0, 10.0)

    def on_plane(p):
        return abs(sum((p[i] - origin[i]) * normal[i] for i in range(3)))

    top = None
    for fc in part.faces():
        n = fc.normal_at()
        if abs(n.X * normal[0] + n.Y * normal[1] + n.Z * normal[2]) > 0.999:
            top = fc
            break
    assert top is not None, "no face parallel to the tilted target — the top was not built on it"
    worst = 0.0
    for v in top.vertices():
        worst = max(worst, on_plane((v.X, v.Y, v.Z)))
    assert worst < 1e-4, (
        f"top face is {worst:.4f} mm off the target plane — it was swept by a "
        "single scalar instead of trimmed on the plane"
    )
    # and the solid really is the wedge, not a box: a 20x20 profile tilted 20°
    # spans 20*tan(20°) in height across x, so the volume is the centre height.
    assert abs(part.volume - 20 * 20 * 10) < 1.0, f"volume: {part.volume}"


def test_start_offset_lifts_the_profile():
    """`startOffset` begins the sweep away from the sketch plane."""
    part, errors, _ = _build([
        _sq(),
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5,
         "operation": "new", "startOffset": 4},
    ])
    assert not errors, f"unexpected errors: {errors}"
    bb = bbox(part)
    assert abs(bb["min"][2] - 4.0) < 1e-4, f"should start at z=4: {bb['min']}"
    assert abs(bb["max"][2] - 9.0) < 1e-4, f"and end at z=9: {bb['max']}"
    assert abs(part.volume - 20 * 20 * 5) < 1e-3, f"volume: {part.volume}"


def test_start_offset_and_up_to_compose():
    """The start offset moves the profile BEFORE the target is measured, so the
    two ends are independent — the solid spans offset..target, not 0..target."""
    part, errors, _ = _build([
        _sq(),
        {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 12},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 1,
         "operation": "new", "startOffset": 4, "upToPlane": "d1"},
    ])
    assert not errors, f"unexpected errors: {errors}"
    bb = bbox(part)
    assert abs(bb["min"][2] - 4.0) < 1e-4, f"start: {bb['min']}"
    assert abs(bb["max"][2] - 12.0) < 1e-4, f"end: {bb['max']}"
    assert abs(part.volume - 20 * 20 * 8) < 1e-3, f"volume: {part.volume}"


def test_offset_without_a_target_is_refused():
    """Not silently dropped. Same class as a boolean that changes nothing: the
    number was typed, read, and thrown away."""
    _expect_error(
        [_sq(),
         {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5,
          "operation": "new", "upToOffset": 7}],
        "only means something with an 'up to' target",
        "upToOffset with no target",
    )


def test_both_targets_is_refused():
    _expect_error(
        [_sq(),
         {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 10},
         {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new",
          "upToPlane": "d1", "upTo": {"kind": "face", "by": "nearest", "point": [0, 0, 10]}}],
        "not both",
        "upTo and upToPlane together",
    )


def test_missing_datum_says_which_way_it_is_wrong():
    """The four-way diagnostic must reach extrude too, and must name EXTRUDE —
    a user told 'Press/Pull: ...' about an extrude goes looking at the wrong tool."""
    _part, errors, _b = _build([
        _sq(),
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5,
         "operation": "new", "upToPlane": "nope"},
    ])
    assert errors, "a dangling datum reference must refuse"
    joined = " | ".join(str(e) for e in errors)
    assert "extrude" in joined.lower(), f"should name Extrude, not Press/Pull: {joined}"


def test_coincident_target_is_refused():
    """A target level with the sketch makes nothing. Refuse rather than paint a
    green chip on a no-op — the same treatment the boolean no-op guards get."""
    _expect_error(
        [_sq(),
         {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 0},
         {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5,
          "operation": "new", "upToPlane": "d1"}],
        "already level",
        "coincident up-to target",
    )


def test_plain_extrude_is_unchanged():
    """The path with no start/end fields must be byte-for-byte the old one."""
    part, errors, _ = _build([
        _sq(),
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 7, "operation": "new"},
    ])
    assert not errors, f"unexpected errors: {errors}"
    assert abs(part.volume - 20 * 20 * 7) < 1e-3, f"volume: {part.volume}"
    # and zero distance is still refused when there is no target to decide it
    _expect_error(
        [_sq(),
         {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 0, "operation": "new"}],
        "must not be 0",
        "zero distance, no target",
    )


if __name__ == "__main__":
    test_up_to_base_plane()
    test_up_to_offset_moves_the_landing()
    test_tilted_target_lands_on_the_plane()
    test_start_offset_lifts_the_profile()
    test_start_offset_and_up_to_compose()
    test_offset_without_a_target_is_refused()
    test_both_targets_is_refused()
    test_missing_datum_says_which_way_it_is_wrong()
    test_coincident_target_is_refused()
    test_plain_extrude_is_unchanged()
    print("ALL PASS")
