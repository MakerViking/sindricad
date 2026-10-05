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
import time

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


# --- helix paths (Doug 30: internal threads for 3D printing) -----------------
#
# A sweep whose `helixCircle` names a circle in its path sketch winds the profile
# around that circle's axis. Two kernel traps, both SILENT, are what these pin:
#
#   1. The corrected-Frenet sweep mode every other sweep uses lets the profile
#      roll as it climbs: a valid solid, +11% volume on the bare M6 coil below.
#   2. The helix built as ONE multi-turn edge sweeps fine, but cutting it from a
#      block came back INVALID with more volume than the uncut block (raw OCCT),
#      which the Cut guard here then reports as removing nothing.
#
# The oracle is Pappus, per turn: a profile in a plane through the axis, carried
# by a screw motion, sweeps area * 2*pi*(centroid radius) per turn, and inside a
# slab of height h that the thread runs right through, h/pitch turns of it.

M6_PITCH = 1.0
M6_H = math.sqrt(3) / 2 * M6_PITCH            # ISO fundamental triangle height
M6_APEX = 3.0 + M6_H / 8                      # its apex, past the major radius
M6_MINOR = (6.0 - 1.082532 * M6_PITCH) / 2    # internal thread minor radius, D1/2
M6_TOOL_IN = 2.3                              # the tool reaches into the bore


def _m6_width(r):
    """The ISO 60 degree groove's width (along the axis) at radius r."""
    return (M6_APEX - r) * 2 * math.tan(math.radians(30))


def _trapezoid(r_in, r_out, z0):
    """The thread groove between radii r_in and r_out, centred on height z0, as
    (radius, height) corners."""
    return [(r_in, z0 - _m6_width(r_in) / 2), (r_out, z0 - _m6_width(r_out) / 2),
            (r_out, z0 + _m6_width(r_out) / 2), (r_in, z0 + _m6_width(r_in) / 2)]


def _area_and_centroid_r(pts):
    """Shoelace area and centroid radius of a (radius, height) polygon."""
    a = cx = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
    return abs(a / 2), cx / (3 * a)


def _thread_profile(z0, sid="thr"):
    """The M6x1 cutting tool on XZ (local x = radius, local y = height): the ISO
    groove from inside the bore out to the major radius, where it is truncated
    by H/8. Narrower than the pitch everywhere, so the turns never touch."""
    pts = _trapezoid(M6_TOOL_IN, 3.0, z0)
    return {"id": sid, "type": "sketch", "plane": "XZ", "entities": [
        _line(f"t{i}", pts[i], pts[(i + 1) % 4]) for i in range(4)]}


def _helix_sketch(sid="hx", circle_id="hc", radius=3.0, construction=True):
    entity = {"type": "circle", "id": circle_id, "radius": radius, "x": 0, "y": 0}
    if construction:
        entity["construction"] = True
    return {"id": sid, "type": "sketch", "plane": "XY", "entities": [entity]}


def _helix_sweep(turns, operation, **extra):
    return {"id": "sw", "type": "sweep", "profile": "thr", "path": "hx",
            "helixCircle": "hc", "pitch": M6_PITCH, "turns": turns,
            "operation": operation, **extra}


def _threaded_block_doc(height, turns, z0=-2.0):
    """A 12 x 12 block `height` tall on XY, bored through at the M6 minor
    diameter, with an M6x1 thread cut by a helix sweep that starts below the
    block and runs out above it."""
    return {"parameters": {}, "features": [
        {"id": "blk", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "id": "r", "width": 12, "height": 12}]},
        {"id": "e1", "type": "extrude", "sketch": "blk", "distance": height, "operation": "new"},
        {"id": "bore", "type": "sketch", "plane": "XY", "entities": [
            {"type": "circle", "id": "b", "radius": M6_MINOR}]},
        {"id": "e2", "type": "extrude", "sketch": "bore", "distance": height, "operation": "cut"},
        _thread_profile(z0),
        _helix_sketch(),
        _helix_sweep(turns, "cut"),
    ]}


def _analytic_thread(height):
    """The material an M6x1 internal thread removes from a slab `height` tall:
    only the part of the tool outside the bore cuts anything."""
    area, rbar = _area_and_centroid_r(_trapezoid(M6_MINOR, 3.0, 0.0))
    return area * 2 * math.pi * rbar * height / M6_PITCH


def _cut_thread(height, turns):
    """Rebuild the threaded block; returns (body, removed volume, seconds)."""
    t0 = time.perf_counter()
    part, err, bodies = rebuild(_threaded_block_doc(height, turns))
    seconds = time.perf_counter() - t0
    assert not err, err
    assert len(bodies) == 1, f"expected the one threaded block, got {len(bodies)} bodies"
    body = bodies[0]["shape"]
    bored = 12 * 12 * height - math.pi * M6_MINOR ** 2 * height
    return body, bored - body.volume, seconds


def test_a_helix_cuts_an_m6_thread_to_its_analytic_volume():
    """The whole point of the feature: an M6x1 internal thread cut into a block
    is a valid solid and the material it removes is the analytic thread.

    RED with the helix as one 14-turn edge (trap 2): the cut is refused as
    removing nothing. RED with the default sweep mode (trap 1): the rolling
    profile overlaps its neighbours and is refused, and with that check gone
    too the thread removed 69.0 mm3, +74%. The oracle is the REMOVED volume,
    not the body's: the whole thread is 3% of the block."""
    body, removed, seconds = _cut_thread(10.0, 14)
    want = _analytic_thread(10.0)
    rel = removed / want - 1
    assert body.is_valid, "the threaded block is not a valid solid"
    assert abs(rel) < 0.005, (
        f"the thread removed {removed:.4f} mm3, the analytic M6x1 thread is "
        f"{want:.4f} mm3 ({rel:+.2%})")
    print(f"{PASS} an M6x1 thread cuts to the analytic volume: removed "
          f"{removed:.4f} of {want:.4f} mm3 ({rel:+.1e}), valid, {seconds:.2f} s")


def test_a_twenty_turn_thread_cuts_within_the_heartbeat():
    """The sidecar reaps a worker whose heartbeat stalls for STALL_TIMEOUT, and
    the heartbeat ticks once per feature, so one sweep has that long at most.
    MEASURED 0.8 s for the sweep and the cut, plus the overlap check."""
    from server import STALL_TIMEOUT

    body, removed, seconds = _cut_thread(16.0, 20)
    want = _analytic_thread(16.0)
    assert body.is_valid, "the 20-turn threaded block is not a valid solid"
    assert abs(removed / want - 1) < 0.005, (
        f"the 20-turn thread removed {removed:.4f} mm3 of {want:.4f}")
    assert seconds < STALL_TIMEOUT, (
        f"a 20-turn thread took {seconds:.1f} s, past the {STALL_TIMEOUT:.0f} s "
        "heartbeat: the worker would be reaped mid-cut")
    print(f"{PASS} a 20-turn thread cuts in {seconds:.2f} s "
          f"(heartbeat {STALL_TIMEOUT:.0f} s), removed {removed:.4f} of {want:.4f}")


def _slab_volume(body, z0, z1):
    """How much of `body` lies between heights z0 and z1."""
    from build123d import Box, Pos

    got = body.intersect(Pos(0, 0, (z0 + z1) / 2) * Box(20, 20, z1 - z0))
    return sum(s.volume for s in got) if isinstance(got, list) else got.volume


def test_a_thread_cut_from_the_face_runs_out_of_both_ends():
    """A thread drawn the obvious way: the profile centred on the block's own
    face, the circle in a sketch on that face, turns = depth / pitch, and the
    feature exactly as the Sweep starter commits it (a Cut runs into the
    material, so it is flipped against the face's outward normal). From the top
    face and from the bottom one, so the run-out is checked running down the
    axis and up it.

    A helix Cut runs one turn past both ends, so the groove runs fully out of
    both faces: every pitch-tall slab of the block, the end ones included, has
    lost exactly one pitch of thread. RED without that: the end slabs each lost
    3.7158 of 3.9651 mm3, a 0.249 mm3 ledge in the screw's path at the entry and
    another at the far side, and the whole thread came to -1.26%."""
    height = 10.0
    turns = height / M6_PITCH
    bored = (12 * 12 - math.pi * M6_MINOR ** 2) * height
    want = _analytic_thread(height)
    per_pitch = _analytic_thread(M6_PITCH)
    ring = (12 * 12 - math.pi * M6_MINOR ** 2) * M6_PITCH
    for face_z, normal in ((height, 1), (0.0, -1)):
        doc = _threaded_block_doc(height, turns, z0=face_z)
        for f in doc["features"]:
            if f["id"] == "hx":
                f["plane"] = {"origin": [0, 0, face_z], "xdir": [1, 0, 0],
                              "normal": [0, 0, normal]}
            if f["id"] == "sw":
                f.update(flip=True, joinTouchingOnly=True, hiddenBodies=[])
        part, err, bodies = rebuild(doc)
        assert not err, err
        assert len(bodies) == 1, f"expected the one threaded block, got {len(bodies)} bodies"
        body = bodies[0]["shape"]
        assert body.is_valid and len(body.solids()) == 1, (
            f"the block threaded from z={face_z} is not one valid solid")
        rel = (bored - body.volume) / want - 1
        assert abs(rel) < 1e-4, (
            f"from z={face_z} the thread removed {bored - body.volume:.4f} mm3, the "
            f"analytic M6x1 thread is {want:.4f} mm3 ({rel:+.2%})")
        for z0 in (0.0, height - M6_PITCH):
            lost = ring - _slab_volume(body, z0, z0 + M6_PITCH)
            assert abs(lost / per_pitch - 1) < 1e-4, (
                f"from z={face_z}, the slab at z {z0:g}..{z0 + M6_PITCH:g} lost "
                f"{lost:.4f} mm3 to the thread, a full pitch is {per_pitch:.4f}: "
                f"a ledge of {per_pitch - lost:.4f} mm3 is left at that end")
        print(f"{PASS} a thread cut from the face at z={face_z:g} runs out of both "
              f"ends: removed {bored - body.volume:.4f} of {want:.4f} mm3 ({rel:+.1e})")


def _coil_doc(turns, **extra):
    """The thread profile swept on its own into a New Body: a coil."""
    return {"parameters": {}, "features": [
        _thread_profile(0.0), _helix_sketch(construction=False),
        _helix_sweep(turns, "new", **extra)]}


def test_a_helix_carries_the_profile_without_rolling_it():
    """Pappus on the bare coil, fractional turns, both hands: the profile turns
    with the helix and does not roll about it (trap 1: 43.06 mm3, +11%).
    Handedness is read off the geometry: a quarter turn in, a right-hand helix
    has carried the profile to +Y a quarter pitch up, a left-hand one is three
    quarters of a turn from there."""
    from build123d import Vector

    area, rbar = _area_and_centroid_r(_trapezoid(M6_TOOL_IN, 3.0, 0.0))
    want = area * 2 * math.pi * rbar * 6.5
    quarter = Vector(0, rbar, M6_PITCH / 4)
    for extra, hand in (({}, "right"), ({"leftHand": True}, "left")):
        part, err, bodies = rebuild(_coil_doc(6.5, **extra))
        assert not err, err
        coil = bodies[0]["shape"]
        assert coil.is_valid, f"the {hand}-hand coil is not a valid solid"
        assert abs(coil.volume / want - 1) < 1e-4, (
            f"the {hand}-hand coil swept {coil.volume:.4f} mm3, Pappus says "
            f"{want:.4f}: the profile rolled as it climbed")
        assert coil.is_inside(quarter) == (hand == "right"), (
            f"the {hand}-hand coil winds the wrong way")
        print(f"{PASS} a {hand}-hand coil of 6.5 turns sweeps {coil.volume:.4f} "
              f"of {want:.4f} mm3")


def test_flip_runs_the_helix_the_other_way_along_its_axis():
    """The helix climbs along the circle's sketch normal (+Z on XY), and Flip
    sends it the other way from the same profile."""
    half = _m6_width(M6_TOOL_IN) / 2
    for extra, lo, hi in (({}, -half, 4 + half), ({"flip": True}, -4 - half, half)):
        part, err, bodies = rebuild(_coil_doc(4, **extra))
        assert not err, err
        bb = bodies[0]["shape"].bounding_box()
        assert abs(bb.min.Z - lo) < 0.05 and abs(bb.max.Z - hi) < 0.05, (
            f"{extra or 'unflipped'}: the coil spans Z {bb.min.Z:.3f}..{bb.max.Z:.3f}, "
            f"expected {lo:.3f}..{hi:.3f}")
    print(f"{PASS} Flip runs the helix down the axis instead of up it")


def test_a_helix_around_a_projected_circle():
    """A circle projected from a body (the edge of a bore, say) is a helix
    circle like a drawn one."""
    doc = _coil_doc(3)
    doc["features"][1]["entities"] = [{
        "type": "projected", "id": "hc", "curve": {"kind": "circle", "x": 0, "y": 0, "r": 3},
        "source": {"kind": "edge", "body": "body1", "sel": {"kind": "edge", "by": "nearest", "point": [3, 0, 0]}},
        "construction": True}]
    part, err, bodies = rebuild(doc)
    assert not err, err
    area, rbar = _area_and_centroid_r(_trapezoid(M6_TOOL_IN, 3.0, 0.0))
    assert abs(bodies[0]["shape"].volume / (area * 2 * math.pi * rbar * 3) - 1) < 1e-4
    print(f"{PASS} a projected circle drives a helix")


def test_overlapping_turns_refuse_instead_of_cutting_garbage():
    """A profile taller than the pitch: every turn overlaps the next. OCCT
    sweeps that to a solid it calls VALID, at the volume of the overlapping
    turns counted twice, and cutting it from the block left a body of NEGATIVE
    volume that the Cut guard counted as material removed. It must refuse."""
    doc = _threaded_block_doc(10.0, 14)
    for f in doc["features"]:
        if f["id"] == "sw":
            f["pitch"] = 0.5  # the tool is 0.93 mm tall at the bore
    part, err, bodies = rebuild(doc)
    sweep_err = [e for e in err if e.get("feature_id") == "sw"]
    assert sweep_err, f"a helix whose turns overlap built without an error: {err}"
    assert "overlap" in sweep_err[0]["message"], sweep_err[0]["message"]
    print(f"{PASS} overlapping turns refuse: {sweep_err[0]['message'][:60]}...")


def test_a_helix_cut_that_runs_away_from_the_part_points_at_flip():
    """The way a wrong direction guess shows up: the helix climbs out of the
    part instead of into it and cuts nothing. The no-op guard must say so in
    the helix's own terms. The extrude's wording ("Drag the other way") names
    a drag a sweep does not have; the fix is the Flip direction toggle."""
    doc = _threaded_block_doc(10.0, 3)
    for f in doc["features"]:
        if f["id"] == "sw":
            f["flip"] = True  # from below the block, down and away from it
    part, err, bodies = rebuild(doc)
    sweep_err = [e for e in err if e.get("feature_id") == "sw"]
    assert sweep_err, f"a helix cut that misses the part built without an error: {err}"
    msg = sweep_err[0]["message"]
    assert "removed nothing" in msg and "Flip direction" in msg, msg
    assert "Drag" not in msg and "extrude" not in msg, msg
    print(f"{PASS} a helix cut that misses points at Flip direction")


def test_the_run_out_does_not_hide_a_helix_that_runs_away():
    """A Cut runs a turn past each end, so the turn added before a profile drawn
    just outside the face reaches back into the part. Whether the Cut misses is
    still decided on the turns as typed: running away from the face, it says to
    tick Flip direction and cuts nothing. Running into it, it threads as before.

    RED with the miss decided on the extended sweep: drawn 0.5, 0.7 and 1.0 mm
    above the face and unflipped, the Cut took 1.98, 1.19 and 0.25 mm3 off the
    top face and said nothing (all three said to flip before the run-out)."""
    height = 10.0
    bored = (12 * 12 - math.pi * M6_MINOR ** 2) * height
    for gap in (0.5, 0.7, 1.0):
        for flip in (False, True):
            doc = _threaded_block_doc(height, height / M6_PITCH, z0=height + gap)
            for f in doc["features"]:
                if f["id"] == "hx":
                    f["plane"] = {"origin": [0, 0, height], "xdir": [1, 0, 0],
                                  "normal": [0, 0, 1]}
                if f["id"] == "sw":
                    f.update(joinTouchingOnly=True, hiddenBodies=[])
                    if flip:
                        f["flip"] = True
            part, err, bodies = rebuild(doc)
            removed = bored - sum(b["shape"].volume for b in bodies)
            if flip:
                assert not err and removed > 35, (
                    f"drawn {gap} mm above the face and running into it, the thread "
                    f"removed {removed:.4f} mm3 with errors {err}")
                continue
            sweep_err = [e for e in err if e.get("feature_id") == "sw"]
            assert sweep_err and "Flip direction" in sweep_err[0]["message"], (
                f"drawn {gap} mm above the face and running away from it, the Cut "
                f"removed {removed:.4f} mm3 and said {err}")
            assert abs(removed) < 1e-6, (
                f"a Cut that says it removed nothing took {removed:.4f} mm3 off")
    print(f"{PASS} a helix running away from a face it is drawn just outside of "
          "still says to flip it")


def test_a_helix_whose_circle_is_gone_says_so():
    """The circle was deleted from the sketch after the sweep was made."""
    doc = _coil_doc(3)
    doc["features"][1]["entities"][0]["id"] = "somethingElse"
    part, err, bodies = rebuild(doc)
    assert err and "no longer in its sketch" in err[0]["message"], err
    print(f"{PASS} a helix whose circle is gone says so")


if __name__ == "__main__":
    test_a_rounding_gap_does_not_cut_the_path_short()
    test_a_closed_path_sweeps_to_a_real_solid()
    test_a_corner_in_an_open_path_keeps_its_volume()
    test_a_path_in_real_pieces_says_so()
    test_a_sweep_that_builds_nothing_refuses_loudly()
    test_a_helix_cuts_an_m6_thread_to_its_analytic_volume()
    test_a_twenty_turn_thread_cuts_within_the_heartbeat()
    test_a_thread_cut_from_the_face_runs_out_of_both_ends()
    test_a_helix_carries_the_profile_without_rolling_it()
    test_flip_runs_the_helix_the_other_way_along_its_axis()
    test_a_helix_around_a_projected_circle()
    test_overlapping_turns_refuse_instead_of_cutting_garbage()
    test_a_helix_cut_that_runs_away_from_the_part_points_at_flip()
    test_the_run_out_does_not_hide_a_helix_that_runs_away()
    test_a_helix_whose_circle_is_gone_says_so()
    print("\nall sweep-path tests passed")
