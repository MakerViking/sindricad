"""Extrude TAPER — sloped walls (GitHub issue #41's "nice to have").

Run:  uv run python test_extrude_taper.py

WHY THIS FILE IS PARANOID. The OCCT path underneath (`extrude(..., taper=)`) is
the one place in this codebase measured to return CORRUPT GEOMETRY WITHOUT
RAISING: over 62 glyphs, two came back with volume 0.0 and IsValid() false, or a
NEGATIVE volume, and 'S'/'M'/'W' at 20 degrees returned entirely plausible
volumes on self-intersected sidewalls that only BRepCheck catches. It has also
been measured HANGING for 600 s while holding the GIL, which in a max_workers=1
pool costs the whole session.

So the tests here are not "does it make a shape". They check the shape against
the ANALYTIC frustum volume — a number OCCT cannot accidentally agree with — and
they check that the failure paths REFUSE rather than return something plausible.
"""

import math

from builder import rebuild


def _sq(size=20.0):
    return {
        "id": "s1",
        "type": "sketch",
        "plane": "XY",
        "entities": [{"type": "rectangle", "width": size, "height": size, "x": 0, "y": 0}],
    }


def _build(features):
    return rebuild({"parameters": {}, "features": features})


def _extrude(**kw):
    return [_sq(), {"id": "e1", "type": "extrude", "sketch": "s1", "operation": "new", **kw}]


def _frustum(a_side, depth, angle_deg):
    """Analytic volume of a square frustum: h/3 * (A1 + A2 + sqrt(A1*A2)).

    Independent of the kernel — this is the assertion OCCT cannot fake by
    returning a self-intersected solid that merely looks the right size."""
    inset = depth * math.tan(math.radians(angle_deg))
    b_side = a_side - 2 * inset
    a1, a2 = a_side * a_side, b_side * b_side
    return depth / 3.0 * (a1 + a2 + math.sqrt(a1 * a2))


def test_positive_taper_narrows_by_the_right_amount():
    part, errors, _ = _build(_extrude(distance=10, taper=10))
    assert not errors, f"unexpected errors: {errors}"
    want = _frustum(20.0, 10.0, 10.0)
    assert abs(part.volume - want) < 1.0, f"got {part.volume}, frustum says {want}"
    # and it really did narrow: the top is smaller than the bottom
    assert part.volume < 20 * 20 * 10, "a positive taper must remove material"


def test_negative_taper_widens_by_the_right_amount():
    part, errors, _ = _build(_extrude(distance=10, taper=-10))
    assert not errors, f"unexpected errors: {errors}"
    want = _frustum(20.0, 10.0, -10.0)
    assert abs(part.volume - want) < 1.0, f"got {part.volume}, frustum says {want}"
    assert part.volume > 20 * 20 * 10, "a negative taper must add material"


def test_zero_taper_is_the_plain_prism():
    """And, more importantly, takes the ORIGINAL code path — no probe, no fork."""
    part, errors, _ = _build(_extrude(distance=10, taper=0))
    assert not errors, f"unexpected errors: {errors}"
    assert abs(part.volume - 20 * 20 * 10) < 1e-6, f"volume: {part.volume}"

    plain, errors2, _ = _build(_extrude(distance=10))
    assert not errors2
    assert abs(part.volume - plain.volume) < 1e-9, "taper 0 must equal no taper"


def test_the_exact_pyramid_is_allowed():
    """20 mm square, 10 mm deep, 45 degrees insets by exactly the half-width, so
    the top closes to a point. That is a PYRAMID — a perfectly good solid — and
    it must build. The boundary is where the taper stops being buildable, not
    where it stops being a prism."""
    part, errors, _ = _build(_extrude(distance=10, taper=45))
    assert not errors, f"a 45 degree pyramid is legal: {errors}"
    assert abs(part.volume - (20 * 20 * 10) / 3.0) < 1.0, f"volume: {part.volume}"


def test_a_taper_past_the_apex_is_refused_not_truncated():
    """THE ONE THAT MATTERS, and the defect it guards is OCCT's, not ours.

    Ask for a taper steeper than the profile can carry over the requested depth
    and OCCT does not raise and does not return anything corrupt. It builds the
    pyramid and STOPS AT THE APEX — handing back a SHORTER extrude than asked
    for, as a valid solid with a plausible volume.

    Measured on this exact 20x20 profile swept 10 mm: 46 deg returned 1287.59
    mm³ and 50 deg returned 1118.80, which are exactly (1/3)·A·h for h = 9.657
    and 8.391 — the apex heights, not the 10 mm requested. Neither BRepCheck nor
    any volume bound can see that; only measuring the built height can."""
    for ang in (46, 50, 60):
        _part, errors, _ = _build(_extrude(distance=10, taper=ang))
        assert errors, f"a {ang} degree taper silently truncates and must refuse"
        joined = " | ".join(str(e) for e in errors)
        assert "taper" in joined.lower(), f"the message should name the taper: {joined}"


def test_a_fold_flat_angle_is_refused_by_name():
    _part, errors, _ = _build(_extrude(distance=10, taper=90))
    assert errors, "90 degrees must refuse"
    joined = " | ".join(str(e) for e in errors)
    assert "folds the wall flat" in joined, f"should say why: {joined}"
    # and the message must offer the range rather than just saying no
    assert "89" in joined, f"should name the usable range: {joined}"


def test_taper_composes_with_start_offset():
    """The start offset moves the profile; the taper slopes from there."""
    part, errors, _ = _build(_extrude(distance=10, taper=10, startOffset=5))
    assert not errors, f"unexpected errors: {errors}"
    from tessellate import bbox

    bb = bbox(part)
    assert abs(bb["min"][2] - 5.0) < 1e-4, f"should start at z=5: {bb['min']}"
    assert abs(bb["max"][2] - 15.0) < 1e-4, f"and end at z=15: {bb['max']}"
    want = _frustum(20.0, 10.0, 10.0)
    assert abs(part.volume - want) < 1.0, f"got {part.volume}, want {want}"


def test_taper_on_a_holed_profile_keeps_the_hole():
    """A ring. Two things at once: the hole must survive, and it must slope the
    RIGHT WAY.

    A taper slopes walls away from the MATERIAL, not in one world direction — so
    on a ring the outside narrows while the hole WIDENS. That is what makes a
    moulded or printed part release, and it is the opposite of what "both walls
    slope the same way" would predict. The analytic volume below distinguishes
    them: hole-widens gives 6056.3 and hole-narrows gives 6214.7, and the kernel
    returns 6056.398."""
    feats = [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [
            {"type": "circle", "radius": 20, "x": 0, "y": 0},
            {"type": "circle", "radius": 8, "x": 0, "y": 0},
        ]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "operation": "new",
         "distance": 6, "taper": 5,
         # the ANNULUS, not the inner disc: a point between the two circles
         "regions": [[14.0, 0.0, 0.0]]},
    ]
    part, errors, _ = _build(feats)
    assert not errors, f"unexpected errors: {errors}"
    d, a = 6.0, math.radians(5.0)
    inset = d * math.tan(a)

    def cone(r_lo, r_hi):
        return d / 3.0 * math.pi * (r_lo * r_lo + r_hi * r_hi + r_lo * r_hi)

    want = cone(20.0, 20.0 - inset) - cone(8.0, 8.0 + inset)  # hole OPENS OUT
    assert abs(part.volume - want) < 1.0, f"got {part.volume}, want ~{want}"
    # and be explicit that the wrong-way model is excluded, not merely untested
    wrong = cone(20.0, 20.0 - inset) - cone(8.0, 8.0 - inset)
    assert abs(part.volume - wrong) > 100.0, "hole sloped the wrong way"


def test_up_to_ignores_taper_rather_than_fighting_it():
    """With a target the end face IS the target plane. The taper field is not
    applied there, and that must be a clean no-op, not a build failure."""
    feats = [
        _sq(),
        {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 10},
        {"id": "e1", "type": "extrude", "sketch": "s1", "operation": "new",
         "distance": 1, "upToPlane": "d1", "taper": 10},
    ]
    part, errors, _ = _build(feats)
    assert not errors, f"unexpected errors: {errors}"
    assert abs(part.volume - 20 * 20 * 10) < 1e-3, (
        f"an up-to extrude must reach the plane straight-walled: {part.volume}"
    )


if __name__ == "__main__":
    test_positive_taper_narrows_by_the_right_amount()
    test_negative_taper_widens_by_the_right_amount()
    test_zero_taper_is_the_plain_prism()
    test_the_exact_pyramid_is_allowed()
    test_a_taper_past_the_apex_is_refused_not_truncated()
    test_a_fold_flat_angle_is_refused_by_name()
    test_taper_composes_with_start_offset()
    test_taper_on_a_holed_profile_keeps_the_hole()
    test_up_to_ignores_taper_rather_than_fighting_it()
    print("ALL PASS")
