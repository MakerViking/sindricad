"""Sweep paths: the whole path, and a solid at the end of it.

Field report 780bdbd0 ("I expected Sketch 3 to follow around the contour of
Sketch 2") was TWO silent defects stacked, both in the sweep path:

  1. `_path_wire` combined the path sketch's edges at build123d's default
     tol=1e-9, but the document stores projected curves rounded to 6 decimals
     (`_r6`), so two ends the kernel put at one point can sit 1e-6 apart. The
     reporter's closed 550.259 mm contour therefore combined into TWO open wires
     (252.879 + 297.380) and the sweep followed the longer one, in the wrong
     place, reporting no error.
  2. build123d's default `Transition.TRANSFORMED` collapses at path corners: a
     sweep along ANY closed path came out with zero volume, again with no error.

Both are pinned here by the EFFECT (the swept solid's volume, validity and
extent), not by which arguments the sweep call was handed.

Run:  uv run python test_sweep_path.py
"""

import math

from builder import rebuild

PASS = "✓"

# r2 circle profile: the analytic swept volume is pi*r^2 * path length, and the
# mitred corners RIGHT produces conserve it exactly (measured, not assumed).
PROFILE_AREA = math.pi * 4.0


def _circle_profile(sid="prof", at=(0, 0), radius=2):
    """An r2 circle on YZ, i.e. in the plane whose normal is +X. `at` is (Y, Z) in
    world terms. It has to sit ON the path: OCCT's MakePipeShell is handed the
    section WithContact=False, so the section's offset from the path is carried
    the whole way round rather than snapped to the start."""
    return {"id": sid, "type": "sketch", "plane": "YZ",
            "entities": [{"type": "circle", "radius": radius,
                          "x": at[0], "y": at[1]}]}


def _line(eid, p, q):
    return {"id": eid, "type": "line", "x1": p[0], "y1": p[1], "x2": q[0], "y2": q[1]}


def _rect_path(sid, w, h, gaps=()):
    """A w x h rectangle on XY as four separate line entities, walking
    bl -> br -> tr -> tl -> bl. Each corner name in `gaps` is nudged by +1e-6 in y
    on the OUTGOING line only, which is exactly what `_r6`'s 6 decimal rounding
    does to a projected contour: the two lines that met there no longer share a
    point, and Wire.combine at anything <= 1e-6 breaks the loop open there."""
    bl, br, tr, tl = (-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)
    corners = {"bl": bl, "br": br, "tr": tr, "tl": tl}

    def start(name):
        x, y = corners[name]
        return (x, y + 1e-6) if name in gaps else (x, y)

    return {"id": sid, "type": "sketch", "plane": "XY", "entities": [
        _line("e1", start("bl"), br),
        _line("e2", start("br"), tr),
        _line("e3", start("tr"), tl),
        _line("e4", start("tl"), bl)]}


def _sweep_doc(profile, path):
    return {"parameters": {}, "features": [
        profile, path,
        {"id": "sw", "type": "sweep", "profile": profile["id"],
         "path": path["id"], "operation": "new"}]}


def test_a_rounding_gap_does_not_cut_the_path_short():
    """The report's own mechanism, small: a closed path whose loop is broken in
    two places by a 1e-6 rounding gap must still sweep the WHOLE loop.

    RED before the fix: the 300 mm loop combined into a 250 mm piece and a 50 mm
    piece, so the sweep followed 250 mm of it and the body was both short and
    invalid."""
    path = _rect_path("path", 100, 50, gaps=("br", "tr"))
    # the profile sits on the middle of the rectangle's bottom edge
    part, err, bodies = rebuild(_sweep_doc(_circle_profile(at=(-25, 0)), path))
    assert not err, err
    assert len(bodies) == 1, f"expected one swept body, got {len(bodies)}"
    solid = bodies[0]["shape"]
    whole = PROFILE_AREA * 300.0  # 2*(100+50) mm of path

    assert solid.is_valid, "a sweep around a closed path must be a valid solid"
    assert abs(solid.volume - whole) < 1.0, (
        f"the sweep followed only part of the path: volume {solid.volume:.3f}, "
        f"expected {whole:.3f} for the whole 300 mm loop")

    # And it must reach all four sides, not just the three the longest piece had.
    bb = solid.bounding_box()
    for got, want, what in ((bb.min.X, -52, "left"), (bb.max.X, 52, "right"),
                            (bb.min.Y, -27, "bottom"), (bb.max.Y, 27, "top")):
        assert abs(got - want) < 0.5, (
            f"the swept body stops short on the {what}: {got:.3f}, expected "
            f"about {want}")
    print(f"{PASS} a 1e-6 rounding gap no longer cuts the path short: vol "
          f"{solid.volume:.3f} of {whole:.3f}, valid, spans the whole loop")


def test_a_closed_path_sweeps_to_a_real_solid():
    """The transition defect on its own: an EXACTLY closed path, no rounding gap
    anywhere.

    RED before the fix: volume 0.000, errors [] — a body committed with nothing
    in it."""
    part, err, bodies = rebuild(
        _sweep_doc(_circle_profile(at=(-25, 0)), _rect_path("path", 100, 50)))
    assert not err, err
    solid = bodies[0]["shape"]
    whole = PROFILE_AREA * 300.0
    assert solid.is_valid, "a sweep around a closed path must be a valid solid"
    assert abs(solid.volume - whole) < 1.0, (
        f"a sweep along a closed path came out with volume {solid.volume:.3f}, "
        f"expected {whole:.3f}")
    print(f"{PASS} an exactly closed path sweeps to a real solid: vol "
          f"{solid.volume:.3f}")


def test_a_corner_in_an_open_path_keeps_its_volume():
    """An L: one right-angle corner, open ends, nothing rounded.

    RED before the fix: 24000 against an analytic 48000, is_valid False."""
    prof = {"id": "prof", "type": "sketch", "plane": "YZ",
            "entities": [{"type": "rectangle", "width": 20, "height": 20}]}
    path = {"id": "path", "type": "sketch", "plane": "XY", "entities": [
        _line("e1", (0, 0), (60, 0)),
        _line("e2", (60, 0), (60, 60))]}
    part, err, bodies = rebuild(_sweep_doc(prof, path))
    assert not err, err
    solid = bodies[0]["shape"]
    assert solid.is_valid, "a sweep around one right-angle corner must be valid"
    assert abs(solid.volume - 48000) < 10, (
        f"an L path lost material at its corner: volume {solid.volume:.3f}, "
        f"expected 48000")
    print(f"{PASS} an open L path keeps its volume: {solid.volume:.3f}, valid")


def test_a_path_in_real_pieces_says_so():
    """A path sketch that is GENUINELY in two pieces (a 5 mm gap, far wider than
    any rounding) still sweeps the longest piece — but it must no longer do it
    silently. This is the half of the report nothing told the user about.

    RED before the fix: the rebuild returned no diagnostics at all."""
    path = {"id": "path", "type": "sketch", "plane": "XY", "entities": [
        _line("e1", (-50, 0), (50, 0)),            # 100 mm
        _line("e2", (-20, 5), (20, 5))]}           # 40 mm, 5 mm clear of it
    doc = _sweep_doc(_circle_profile(), path)
    diags = []
    part, err, bodies = rebuild(doc, diagnostics=diags)
    assert not err, err

    sweep_diags = [d for d in diags if d.get("feature_id") == "sw"]
    assert sweep_diags, (
        f"a path in two disconnected pieces must be reported; got {diags}")
    reason = sweep_diags[0]["reason"]
    assert "2 disconnected pieces" in reason, reason
    assert "100.000 mm of 140.000 mm" in reason, reason

    # and it followed the longest piece, as the diagnostic says
    solid = bodies[0]["shape"]
    assert abs(solid.volume - PROFILE_AREA * 100.0) < 1.0, (
        f"expected the 100 mm piece to be swept, got volume {solid.volume:.3f}")
    print(f"{PASS} a path in real pieces is reported: {reason!r}")


def test_a_sweep_that_builds_nothing_refuses_loudly():
    """A hairpin: two legs doubling back on each other at 1 degree, with a
    profile fat enough that the section has nowhere to go round the turn. OCCT
    builds a shape with nothing in it.

    RED before the fix: `errors` empty and a body committed at volume 0.0000 —
    an entry in the tree the user can select and never see."""
    prof = _circle_profile(at=(0, 0), radius=5)
    path = {"id": "path", "type": "sketch", "plane": "XY", "entities": [
        _line("e1", (0, 0), (50, 0)),
        _line("e2", (50, 0), (0, 1))]}
    part, err, bodies = rebuild(_sweep_doc(prof, path))

    if err:
        assert "Sweep" in err[0]["message"], err
        assert not bodies, f"a refused sweep must not leave a body: {bodies}"
        print(f"{PASS} an impossible sweep refuses loudly: {err[0]['message'][:64]}...")
        return
    # If some future kernel manages it, fine — but an empty body must never be
    # committed in silence, which is the thing this test exists to forbid.
    solid = bodies[0]["shape"]
    assert solid.is_valid and solid.volume > 1.0, (
        f"a sweep was committed with volume {solid.volume:.4f}, "
        f"valid {solid.is_valid}, and no error")
    print(f"{PASS} an impossible sweep built after all, and is a real solid: "
          f"vol {solid.volume:.3f}")


if __name__ == "__main__":
    test_a_rounding_gap_does_not_cut_the_path_short()
    test_a_closed_path_sweeps_to_a_real_solid()
    test_a_corner_in_an_open_path_keeps_its_volume()
    test_a_path_in_real_pieces_says_so()
    test_a_sweep_that_builds_nothing_refuses_loudly()
    print("\nall sweep-path tests passed")
