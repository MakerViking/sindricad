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


# --- symmetric (midplane) ------------------------------------------------------
#
# From a user with years of CAD behind them: "Extrude a circle 25 mm. Extrude
# symmetrical would result in 12.5 mm above and 12.5 mm below the sketch. In the
# case of the extrude being a Boolean subtraction this would save a couple steps."


def _sym(**kw):
    return {"id": "e1", "type": "extrude", "sketch": "s1", "operation": "new",
            "symmetric": True, **kw}


def _span(part, axis):
    bb = bbox(part)
    return bb["min"][axis], bb["max"][axis]


def test_symmetric_straddles_its_sketch():
    """Half each side, the SAME volume as the one-sided extrude (a midplane moves
    material, it neither adds nor removes any), and along the PROFILE's normal,
    so a sketch on XZ or YZ straddles its own plane, not world Z."""
    plain, errors, _ = _build([_sq(), {"id": "e1", "type": "extrude", "sketch": "s1",
                                       "distance": 25, "operation": "new"}])
    assert not errors, errors
    part, errors, _ = _build([_sq(), _sym(distance=25)])
    assert not errors, f"unexpected errors: {errors}"
    lo, hi = _span(part, 2)
    assert abs(lo + 12.5) < 1e-4 and abs(hi - 12.5) < 1e-4, f"did not straddle: {lo}..{hi}"
    assert abs(part.volume - plain.volume) < 1e-6, f"volume changed: {part.volume} vs {plain.volume}"
    for plane, axis in (("XZ", 1), ("YZ", 0)):
        part, errors, _ = _build([_sq(plane=plane), _sym(distance=25)])
        assert not errors, f"{plane}: {errors}"
        lo, hi = _span(part, axis)
        assert abs(lo + 12.5) < 1e-4 and abs(hi - 12.5) < 1e-4, f"{plane} straddled the wrong axis: {lo}..{hi}"
    # a negative distance still straddles: the sign must not double-apply
    part, errors, _ = _build([_sq(), _sym(distance=-25)])
    assert not errors, errors
    lo, hi = _span(part, 2)
    assert abs(lo + 12.5) < 1e-4 and abs(hi - 12.5) < 1e-4, f"negative symmetric: {lo}..{hi}"


def test_symmetric_straddles_the_start_offset():
    """With a start offset the MIDPLANE is the offset plane: 10 symmetric from a
    start of 4 spans -1..9. The branch this came from predated start offsets and
    built -5..5 there, throwing the offset away."""
    part, errors, _ = _build([_sq(), _sym(distance=10, startOffset=4)])
    assert not errors, f"unexpected errors: {errors}"
    lo, hi = _span(part, 2)
    assert abs(lo + 1.0) < 1e-4 and abs(hi - 9.0) < 1e-4, f"span: {lo}..{hi}"
    assert abs(part.volume - 20 * 20 * 10) < 1e-3, f"volume: {part.volume}"


def test_symmetric_with_a_target_is_refused():
    """Half each way means nothing when a target decides where it stops. Refused
    by name rather than one of the two silently ignored."""
    _expect_error(
        [_sq(),
         {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 10},
         _sym(distance=5, upToPlane="d1")],
        "symmetric can't be combined",
        "symmetric + upToPlane",
    )


def test_symmetric_taper_is_mirrored_about_the_midplane():
    """A tapered symmetric extrude narrows AWAY from the sketch in BOTH
    directions. The tempting implementation (shift the profile back, taper the
    one sweep) builds a one-way frustum with the sketch halfway up a sloped
    wall. Checked against the analytic frustum, twice: a volume OCCT cannot fake.
    And the widest section must be AT the sketch plane, which only the mirrored
    shape has."""
    part, errors, _ = _build([_sq(), _sym(distance=20, taper=10)])
    assert not errors, f"unexpected errors: {errors}"
    lo, hi = _span(part, 2)
    assert abs(lo + 10) < 1e-4 and abs(hi - 10) < 1e-4, f"span: {lo}..{hi}"
    inset = 10 * math.tan(math.radians(10))
    a, b = 20.0 * 20.0, (20.0 - 2 * inset) ** 2
    want = 2 * (10 / 3.0 * (a + b + math.sqrt(a * b)))
    assert abs(part.volume - want) < 1e-3, f"got {part.volume}, two frusta say {want}"
    assert len(part.solids()) == 1, f"the halves did not join: {len(part.solids())} solids"
    # the widest section is at z=0: both caps are the SMALL square
    for v in part.vertices():
        if abs(abs(v.Z) - 10) < 1e-6:
            assert abs(abs(v.X) - (10 - inset)) < 1e-4, f"a cap is not the narrow end: {v}"
    # and a taper past the apex of the HALF is still refused, not truncated
    _expect_error([_sq(), _sym(distance=20, taper=60)], "taper", "symmetric taper past the apex")


def test_symmetric_absent_is_the_old_extrude():
    """`symmetric: false` and no key at all build the same as before: old
    documents must not move."""
    old, errors, _ = _build([_sq(), {"id": "e1", "type": "extrude", "sketch": "s1",
                                     "distance": 7, "operation": "new", "startOffset": 2}])
    assert not errors, errors
    off, errors, _ = _build([_sq(), {"id": "e1", "type": "extrude", "sketch": "s1",
                                     "distance": 7, "operation": "new", "startOffset": 2,
                                     "symmetric": False}])
    assert not errors, errors
    assert _span(old, 2) == _span(off, 2) and abs(old.volume - off.volume) < 1e-9


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
    test_symmetric_straddles_its_sketch()
    test_symmetric_straddles_the_start_offset()
    test_symmetric_with_a_target_is_refused()
    test_symmetric_taper_is_mirrored_about_the_midplane()
    test_symmetric_absent_is_the_old_extrude()
    print("ALL PASS")
