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
import time

import builder
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


def _tapered_box(width, height, depth, angle_deg):
    """Analytic volume of a tapered RECTANGULAR prism, by the prismatoid rule.

    `_frustum` above must not be used for this. h/3*(A1+A2+sqrt(A1*A2)) is only
    valid for SIMILAR cross-sections, and a non-square rectangle stops being
    similar to itself the moment it insets: on the 53.897 x 39.020 profile below
    it is 2.7% off the true volume, which is enough to hide a real regression.

    The section at height t is (w - 2t*tan0) x (h - 2t*tan0) — a QUADRATIC in t
    — so Simpson over the depth is exact, not approximate."""
    tan = math.tan(math.radians(angle_deg))

    def area(t):
        return (width - 2 * t * tan) * (height - 2 * t * tan)

    return depth / 6.0 * (area(0.0) + 4 * area(depth / 2.0) + area(depth))


def _reporter_profile(taper):
    """The document from field report afd4e10c, feature for feature: an
    off-centre 53.897 x 39.020 rectangle, extruded 30 mm from a 5 mm start
    offset with a 30 degree taper. Four straight edges, one wire — the simplest
    thing a taper can be asked for."""
    return [
        {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
            {"id": "e0", "type": "rectangle", "x": -4.8997177791013655,
             "y": -3.786145556578333, "width": 53.89689557011506,
             "height": 39.01957067720727},
        ]},
        {"id": "f2", "type": "datumPlane", "plane": "XY", "offset": 43.5},
        {"id": "f3", "type": "extrude", "sketch": "f1", "operation": "new",
         "distance": 30, "taper": taper, "startOffset": 5, "separateBodies": True,
         "regions": [[-4.8997177791013655, -3.786145556578333, 0]],
         "regionEntities": [["e0"]], "regionHoleEntities": [[]]},
    ]


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


def test_a_plain_rectangle_tapers_at_the_speed_of_an_untapered_extrude():
    """FIELD REPORT afd4e10c: 16.5 SECONDS to rebuild a three-feature document,
    and the taper angle appearing in the viewport 20 seconds after being typed.

    None of that was geometry. `_probe_tapers` forks a throwaway interpreter to
    catch the kernel HANG, and that child re-imports build123d, OCP, sklearn and
    IPython from cold — 1.6 s on this machine, ~16 s on the reporter's Windows
    laptop. The probe is cached per (profile, depth, angle), so every new value
    typed or dragged paid it again. The taper itself is about 6 ms.

    The assertion is deliberately RELATIVE, not a stopwatch constant: the same
    document with taper=0 is the yardstick, so a slow or loaded CI runner scales
    both sides. The gap it is looking for is three orders of magnitude — 0.003 s
    against 1.65 s here — so the 20x bound is nowhere near either number.

    It also pins the VOLUME, because the cheap way to pass a timing test is to
    stop doing the work."""
    plain = _reporter_profile(0)
    t0 = time.perf_counter()
    flat, errors, _ = _build(plain)
    untapered = time.perf_counter() - t0
    assert not errors, f"the untapered yardstick must build: {errors}"

    # A FRESH cache is the point: this is the state the reporter reached on every
    # keystroke, not a warm second rebuild.
    builder._TAPER_PROBE_CACHE.clear()
    t0 = time.perf_counter()
    part, errors, _ = _build(_reporter_profile(30))
    tapered = time.perf_counter() - t0
    assert not errors, f"unexpected errors: {errors}"

    want = _tapered_box(53.89689557011506, 39.01957067720727, 30.0, 30.0)
    assert abs(part.volume - want) < 0.01, f"got {part.volume}, want {want}"
    assert part.volume < flat.volume, "a positive taper must remove material"

    budget = max(0.5, untapered * 20.0)
    assert tapered < budget, (
        f"a 4-edge rectangle took {tapered:.3f}s to taper against {untapered:.3f}s "
        f"untapered (budget {budget:.3f}s) — something is forking a cold "
        f"interpreter again"
    )


def test_the_hang_probe_still_fires_on_the_profiles_it_was_built_for():
    """The speed above comes from SKIPPING the fork, so the skip must be narrow.

    `_probe_tapers` exists because glyph outlines were measured hanging OCCT for
    600 s while holding the GIL, which in a max_workers=1 pool costs the whole
    session. Those are spline-heavy, many-edged profiles. `_taper_needs_probing`
    has to keep saying yes to them while saying no to a rectangle."""
    from build123d import Circle, Rectangle, RegularPolygon
    from build123d import BuildLine, BuildSketch, Line, Spline, make_face

    rect = Rectangle(20, 12).faces()
    assert not builder._taper_needs_probing(rect), "4 straight edges need no fork"

    ring = (Circle(20) - Circle(8)).faces()
    assert not builder._taper_needs_probing(ring), "arcs need no fork either"

    with BuildSketch() as sk:
        with BuildLine():
            Spline((0, 0), (10, 6), (20, -4), (30, 2))
            Line((30, 2), (0, 0))
        make_face()
    assert builder._taper_needs_probing(sk.sketch.faces()), (
        "a spline outline is the measured hang class and must still be probed"
    )

    many = RegularPolygon(20, 40).faces()
    assert builder._taper_needs_probing(many), (
        "a 40-edge profile is complex enough to be worth a fork"
    )


def test_the_probe_subprocess_answers_both_ways():
    """The gate above means nothing in this file forks any more, so the probe
    itself needs its own cover — the ONE test here that pays a cold interpreter.

    It is not decoration. `_probe_tapers` reads its verdicts back over a pipe
    while waiting in slices and publishing liveness between them (a single
    blocking wait said nothing for up to 30 s against a 60 s stall reaper), and
    a plumbing mistake there is invisible: an empty read looks exactly like "no
    face cleared", which refuses every taper on a spline profile."""
    from build123d import Rectangle

    face = Rectangle(20, 20).faces()

    builder._TAPER_PROBE_CACHE.clear()
    assert builder._probe_tapers(face, 10, 10) == {0: True}, (
        "a 10 degree taper on a square builds; the child must say so and be heard"
    )

    builder._TAPER_PROBE_CACHE.clear()
    assert builder._probe_tapers(face, 10, 60) == {0: False}, (
        "60 degrees is past the apex on this profile — the child must refuse it"
    )
    # and the refusal is remembered, without a second interpreter
    t0 = time.perf_counter()
    assert builder._probe_tapers(face, 10, 60) == {0: False}
    assert time.perf_counter() - t0 < 0.25, "the second call must come from the cache"


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
    test_a_plain_rectangle_tapers_at_the_speed_of_an_untapered_extrude()
    test_the_hang_probe_still_fires_on_the_profiles_it_was_built_for()
    test_the_probe_subprocess_answers_both_ways()
    print("ALL PASS")
