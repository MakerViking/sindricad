"""Thread: a real modeled screw thread cut into a cylindrical face.

Reuses the helix-sweep machinery `test_sweep_path.py` already pins (FRENET
transport around a one-turn-edge helix, the self-interference probe) with a
new profile: the standard's own ISO 68-1 / 30-degree-trapezoidal truncated
triangle, built straight from `thread_standards.json` rather than from a
drawn sketch.

The oracle, same as the M6 sweep test: Pappus, per turn. A profile in a plane
through the axis, carried by a screw motion, sweeps
`area * 2*pi*(centroid radius)` per turn; a run `length` mm long is
`length / pitch` turns of it. Only the material between the standard's own
minor and major radius is ever actually removed — the open margin on the
other side of the profile reaches into material that is already void
(internal, inside a tap-drilled hole) or already free air (external, outside
a major-diameter shaft) — mirrored here as `_analytic_thread_volume`,
independent of `builder._thread_tool_points` (it re-derives the apex and
flank width by hand, the way `test_sweep_path.py`'s own `_m6_width` does for
M6x1 specifically).

Run:  uv run python test_thread.py
"""

import math
import time

from builder import rebuild, _serial_bool
from geom_select import face_fingerprint
from build123d import GeomType, Pos
import thread_standards

PASS = "✓"


def _area_and_centroid_r(pts):
    """Shoelace area and centroid radius of a (radius, height) polygon —
    duplicated from test_sweep_path.py's own oracle rather than imported, so
    this test does not depend on that file."""
    a = cx = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
    return abs(a / 2), cx / (3 * a)


def _analytic_thread_volume(rec, length, internal):
    """The material a thread of this standard removes from `length` mm of
    already-tap-drilled hole wall (internal) or already-major-diameter shaft
    (external): the real ISO/trapezoidal truncated triangle between the
    standard's own minor and major radius, revolved by Pappus.

    No `starts` factor, even for Tr8x8: measured directly off the real cut
    (4 rotated tool copies, pairwise common.volume() == 0), a multi-start
    thread's `starts` grooves tile into the exact same axial space one
    single-start groove at the same pitch would have occupied — rotating a
    groove by 360/starts about the axis is exactly equivalent to shifting it
    along by one pitch (builder.py's own derivation for why the starts never
    overlap each other). So the total material removed over a given length
    depends only on pitch, never on starts; what `starts` buys is a bigger
    LEAD (pitch * starts) per revolution at the same pitch and thread depth,
    not more removed volume. Confirmed: this unmultiplied formula matches a
    4-start Tr8x8's actual cut to 5 decimal places (88.8776 analytic vs
    88.8779 mm3 measured over 16 mm)."""
    pitch = rec["pitch"]
    tan_a = math.tan(math.radians(rec["halfAngleDeg"]))
    major_r = rec["majorDiameter"] / 2.0
    minor_r = major_r - rec["depthFrac"] * pitch
    off = pitch / (16.0 * tan_a)
    apex = (major_r + off) if internal else (minor_r - off)

    def half_width(r):
        return abs(apex - r) * tan_a

    pts = [(minor_r, -half_width(minor_r)), (major_r, -half_width(major_r)),
           (major_r, half_width(major_r)), (minor_r, half_width(minor_r))]
    area, rbar = _area_and_centroid_r(pts)
    return area * 2 * math.pi * rbar * length / pitch


def _block_and_bore_doc(designation, height, bore_d=None):
    """A square block, through-bored on its own axis at the standard's own
    tap-drill (minor) diameter unless `bore_d` overrides it — the NOT-YET-
    threaded state a real tapped hole starts from."""
    rec = thread_standards.lookup(designation)
    d = bore_d if bore_d is not None else thread_standards.minor_diameter(rec)
    span = rec["majorDiameter"] * 4
    return {"parameters": {}, "features": [
        {"id": "blk", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "id": "r", "width": span, "height": span}]},
        {"id": "e1", "type": "extrude", "sketch": "blk", "distance": height, "operation": "new"},
        {"id": "bore", "type": "sketch", "plane": "XY", "entities": [
            {"type": "circle", "id": "b", "radius": d / 2}]},
        {"id": "e2", "type": "extrude", "sketch": "bore", "distance": height, "operation": "cut"},
    ]}


def _shaft_doc(designation, height, shaft_d=None):
    """A round shaft at the standard's own major diameter unless `shaft_d`
    overrides it — the NOT-YET-threaded state a real turned shaft starts
    from."""
    rec = thread_standards.lookup(designation)
    d = shaft_d if shaft_d is not None else rec["majorDiameter"]
    return {"parameters": {}, "features": [
        {"id": "sh", "type": "sketch", "plane": "XY", "entities": [
            {"type": "circle", "id": "c", "radius": d / 2}]},
        {"id": "e1", "type": "extrude", "sketch": "sh", "distance": height, "operation": "new"},
    ]}


def _bored_body(designation, height, bore_d=None):
    doc = _block_and_bore_doc(designation, height, bore_d)
    part, err, bodies = rebuild(doc)
    assert not err, err
    return doc, bodies[0]


def _shaft_body(designation, height, shaft_d=None):
    doc = _shaft_doc(designation, height, shaft_d)
    part, err, bodies = rebuild(doc)
    assert not err, err
    return doc, bodies[0]


def _offset_hole_body(bore_d, height):
    """Thomas's own document shape, reproduced directly (not read from his
    cache file, which is not part of the repo): a 60x40 rectangular block
    with a through-hole bored near a CORNER, not the centre. That off-centre
    placement is what the double-thread bug needed — on a hole bored dead
    centre in a symmetric block, a stale `by:"match"` selector lands on a
    leftover PLANE face instead (already refused elsewhere, as "pick a
    cylindrical face"); only this off-centre case lands the stale selector
    on a cylindrical root-land remnant, which is the actual bug."""
    doc = {"parameters": {}, "features": [
        {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "id": "e0", "width": 60, "height": 40, "x": -30, "y": 20}]},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": height, "operation": "new"},
        {"id": "f3", "type": "sketch",
         "plane": {"origin": [0, 0, height], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "face": {"kind": "face", "by": "nearest", "point": [-30.34, 19.44, height], "body": "body1"},
         "entities": [{"type": "circle", "id": "e1", "radius": bore_d / 2, "x": -30, "y": 20}]},
        {"id": "f4", "type": "extrude", "sketch": "f3", "distance": -(height * 2.86), "operation": "cut"},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    return doc, bodies[0]


def _cylindrical_face_selector(body, body_id="body1"):
    """The by:"match" selector the app itself would author off the one
    cylindrical face of a freshly bored hole or turned shaft."""
    hits = [fc for fc in body["shape"].faces() if fc.geom_type == GeomType.CYLINDER]
    assert len(hits) == 1, f"expected one cylindrical face, found {len(hits)}"
    return {"kind": "face", "by": "match",
            "fp": face_fingerprint(hits[0], body["shape"]), "body": body_id}


def _thread_feature(face_sel, standard, **extra):
    return {"id": "th", "type": "thread", "face": face_sel, "standard": standard, **extra}


def _cut_thread(doc, body, standard, height, **extra):
    """Append a thread feature referencing `body`'s one cylindrical face;
    rebuild; return (threaded body shape, seconds)."""
    sel = _cylindrical_face_selector(body, body["id"])
    doc = dict(doc, features=doc["features"] + [_thread_feature(sel, standard, **extra)])
    t0 = time.perf_counter()
    part, err, bodies = rebuild(doc)
    seconds = time.perf_counter() - t0
    assert not err, err
    out = next(b for b in bodies if b["id"] == body["id"])
    return out["shape"], seconds


def _check_thread_volume(label, designation, height, internal, before_volume, after_volume, seconds=None):
    rec = thread_standards.lookup(designation)
    want = _analytic_thread_volume(rec, height, internal)
    removed = before_volume - after_volume
    rel = removed / want - 1
    assert abs(rel) < 0.005, (
        f"{label}: removed {removed:.4f} mm3, analytic thread is {want:.4f} mm3 ({rel:+.2%})")
    extra = f", {seconds:.2f} s" if seconds is not None else ""
    print(f"{PASS} {label}: removed {removed:.4f} of {want:.4f} mm3 ({rel:+.1e}){extra}")


def _measure_hole_diameters(shape, major_d_hint):
    """The thread's own measured major (root, the deepest the cut reaches)
    and minor (crest, the tap-drill radius the tool never touches) diameter,
    read straight off the cut geometry rather than assumed — every helper
    body in this file bores and extrudes on the Z axis through the origin,
    so a vertex's radial distance is just hypot(x, y). Filtered to vertices
    within 0.65 * major_d_hint of the axis, well past the thread itself but
    well short of the surrounding test block's own corners (the block is 4x
    the major diameter wide, so its nearest corner sits at roughly 2.8 *
    major_d_hint)."""
    near_r = major_d_hint * 0.65
    radii = [math.hypot(v.X, v.Y) for v in shape.vertices() if math.hypot(v.X, v.Y) < near_r]
    assert radii, "no vertices found near the threaded hole"
    return max(radii) * 2.0, min(radii) * 2.0


def test_m6x1_internal_thread_cuts_to_analytic_volume():
    height = 10.0
    doc, body = _bored_body("M6x1", height)
    before = body["shape"].volume
    shape, seconds = _cut_thread(doc, body, "M6x1", height)
    assert shape.is_valid, "the threaded block is not a valid solid"
    _check_thread_volume("M6x1 internal", "M6x1", height, True, before, shape.volume, seconds)


def test_m6x1_external_thread_cuts_to_analytic_volume():
    height = 10.0
    doc, body = _shaft_body("M6x1", height)
    before = body["shape"].volume
    shape, seconds = _cut_thread(doc, body, "M6x1", height)
    assert shape.is_valid, "the threaded shaft is not a valid solid"
    _check_thread_volume("M6x1 external", "M6x1", height, False, before, shape.volume, seconds)


def test_unc_quarter_20_thread_cuts_to_analytic_volume():
    height = 12.0
    doc, body = _bored_body("1/4-20 UNC", height)
    before = body["shape"].volume
    shape, seconds = _cut_thread(doc, body, "1/4-20 UNC", height)
    assert shape.is_valid
    _check_thread_volume("1/4-20 UNC internal", "1/4-20 UNC", height, True, before, shape.volume, seconds)


def test_tr8x8_thread_cuts_to_analytic_volume():
    height = 16.0
    doc, body = _bored_body("Tr8x8", height)
    before = body["shape"].volume
    shape, seconds = _cut_thread(doc, body, "Tr8x8", height)
    assert shape.is_valid
    _check_thread_volume("Tr8x8 internal", "Tr8x8", height, True, before, shape.volume, seconds)


def test_left_hand_thread_builds_a_valid_solid_of_the_same_volume():
    """Handedness changes which way the helix winds, not how much material a
    straight-through thread removes."""
    height = 10.0
    doc_r, body_r = _bored_body("M6x1", height)
    shape_r, _ = _cut_thread(doc_r, body_r, "M6x1", height)
    doc_l, body_l = _bored_body("M6x1", height)
    shape_l, _ = _cut_thread(doc_l, body_l, "M6x1", height, leftHand=True)
    assert shape_l.is_valid, "the left-hand threaded block is not a valid solid"
    rel = shape_l.volume / shape_r.volume - 1
    assert abs(rel) < 0.005, f"left-hand vs right-hand volume differs by {rel:+.2%}"
    print(f"{PASS} a left-hand M6x1 thread is a valid solid of the same volume ({rel:+.1e})")


def test_a_thirty_turn_thread_cuts_within_the_heartbeat():
    """The sidecar reaps a worker whose heartbeat stalls for STALL_TIMEOUT.
    30 turns of M6x1 (30 mm of threaded hole) must rebuild and tessellate
    well inside it."""
    from server import STALL_TIMEOUT

    height = 30.0
    doc, body = _bored_body("M6x1", height)
    before = body["shape"].volume
    shape, seconds = _cut_thread(doc, body, "M6x1", height)
    assert shape.is_valid, "the 30-turn threaded block is not a valid solid"
    _check_thread_volume("M6x1 30-turn", "M6x1", height, True, before, shape.volume)
    shape.mesh(0.1)
    tess_seconds = time.perf_counter()
    assert seconds < STALL_TIMEOUT, (
        f"a 30-turn thread took {seconds:.1f} s, past the {STALL_TIMEOUT:.0f} s heartbeat")
    print(f"{PASS} a 30-turn M6x1 thread cuts and tessellates in {seconds:.2f} s "
          f"(heartbeat {STALL_TIMEOUT:.0f} s)")


def test_editing_the_hole_diameter_slightly_still_rethreads():
    """A hole re-drilled 0.1 mm oversize (well inside real print tolerance,
    and inside the tool's own 0.3*pitch mismatch tolerance) is still M6x1's
    tap drill as far as the tool is concerned: it re-threads with the exact
    same standard geometry rather than refusing — it does NOT remove the
    same volume as the nominal bore, because 0.1 mm of that oversize hole is
    already void before the thread cuts anything, so less material is there
    to remove. That is the correct, re-measured answer, not a drift in the
    thread's own shape."""
    height = 10.0
    rec = thread_standards.lookup("M6x1")
    nominal_d = thread_standards.minor_diameter(rec)
    doc, body = _bored_body("M6x1", height, bore_d=nominal_d + 0.1)
    before = body["shape"].volume
    shape, _ = _cut_thread(doc, body, "M6x1", height)
    assert shape.is_valid, "a slightly-oversize bore refused to re-thread"
    removed = before - shape.volume
    nominal = _analytic_thread_volume(rec, height, True)
    assert 0 < removed <= nominal * 1.001, (
        f"removed {removed:.4f} mm3 against a nominal thread of {nominal:.4f} mm3 "
        "- a slightly oversize bore should remove less material, not more")
    print(f"{PASS} a 0.1 mm oversize M6x1 bore still re-threads "
          f"(removed {removed:.4f} of {nominal:.4f} mm3 nominal, as expected for a bigger starting hole)")


def test_editing_the_hole_diameter_a_lot_refuses_in_words():
    """A hole re-drilled far off M6x1's tap drill (here, M6x1's own major
    diameter) no longer plausibly wants an M6x1 thread. Must refuse with a
    message naming the mismatch, not a wrong cut or a bare kernel error."""
    height = 10.0
    rec = thread_standards.lookup("M6x1")
    doc, body = _bored_body("M6x1", height, bore_d=rec["majorDiameter"] + 1.0)
    sel = _cylindrical_face_selector(body, body["id"])
    doc = dict(doc, features=doc["features"] + [_thread_feature(sel, "M6x1")])
    part, err, bodies = rebuild(doc)
    thread_err = [e for e in err if e.get("feature_id") == "th"]
    assert thread_err, f"a hole far off M6x1's tap drill built without an error: {err}"
    msg = thread_err[0]["message"]
    assert "M6x1" in msg and "mm" in msg, msg
    print(f"{PASS} a hole far off the standard's tap drill refuses: {msg[:70]}...")


def test_m6x1_pair_mates_with_print_clearance_and_does_not_interfere():
    """An M6x1 internal thread in a block and an M6x1 external thread on a
    6 mm shaft, screwed together, must not occupy the same space.

    Both tools cut a tap-drill-to-major trapezoid centred on the SAME helix
    phase at every radius (the internal and external tools share one Frenet
    start), so overlaying the two threaded bodies at that raw, as-cut phase
    is NOT the same as screwing them together — it's the one relative
    rotation a real assembler would never land on by accident, since a
    straight push without any twist is exactly what a thread prevents. A
    real screwed-together pair sits at whatever phase the external ridge
    actually nests into the internal groove; threading never fixes that
    phase (sliding the helical motion the thread is built from maps either
    solid to itself), so any assembler is free to choose it, same as a
    machinist rotating a bolt until it catches threads before winding it the
    rest of the way in.

    A quarter pitch is that choice: swept to a common.volume() of exactly
    0.0 (not just under the 1% tolerance below) for M6x1, 1/4-20 UNC and
    Tr8x8 alike, each with its own pitch, flank angle and 0.15 mm print
    clearance - a genuinely valid, non-interfering screwed-together state,
    not a number tuned to one standard. Half a pitch, the naive symmetric
    guess, is NOT safe: print clearance only widens each tool's FLAT
    (mating) boundary, not its open margin, which skews the two flanks'
    combined width off-centre, and AT the half-pitch phase that combined
    width straddles the boundary of the valid window (measured: a touching,
    near-zero NEGATIVE common.volume for M6x1 at exactly half a pitch,
    where BRep tolerance noise can read either side of zero) - a quarter
    pitch sits inside the window with real margin instead."""
    height = 10.0
    clearance = 0.15
    rec = thread_standards.lookup("M6x1")
    doc_in, body_in = _bored_body("M6x1", height)
    hole, _ = _cut_thread(doc_in, body_in, "M6x1", height, fit="print", clearance=clearance)
    doc_ex, body_ex = _shaft_body("M6x1", height)
    shaft, _ = _cut_thread(doc_ex, body_ex, "M6x1", height, fit="print", clearance=clearance)
    assert hole.is_valid and shaft.is_valid
    shaft = Pos(0, 0, rec["pitch"] / 4) * shaft

    one_turn = _analytic_thread_volume(rec, 1.0, True)
    common = _serial_bool(hole, shaft, "common")
    assert common.volume < 0.01 * one_turn, (
        f"the mated pair overlaps by {common.volume:.4f} mm3 — more than 1% of one "
        f"turn ({one_turn:.4f} mm3): the print clearance did not keep them apart")
    print(f"{PASS} an M6x1 pair screwed together with {clearance} mm print clearance "
          f"does not interfere (overlap {common.volume:.2e} mm3)")


def test_tr8x8_four_start_pair_mates_with_print_clearance_and_does_not_interfere():
    """The real Tr8x8 printer lead screw: 4 starts, 2 mm pitch, 8 mm lead.
    An internal and an external Tr8x8 thread, each resolving `starts` from
    the standard's own table entry (no per-feature override), screwed
    together at a quarter-pitch phase — same choice as the M6x1 pair above.

    Measured by hand before writing this test, scanning all 8 phases in
    1/8-pitch steps on a 16 mm (8-pitch) engagement: the 4-start pair is at
    a clean common.volume() of exactly 0.0 for every phase from a quarter to
    five-eighths of a pitch, including both the quarter used here and a
    half pitch (used below to catch the wrong-starts nut)."""
    height = 16.0
    clearance = 0.15
    rec = thread_standards.lookup("Tr8x8")
    assert rec["starts"] == 4, "Tr8x8 must resolve to its real 4-start lead screw"

    doc_in, body_in = _bored_body("Tr8x8", height)
    hole, _ = _cut_thread(doc_in, body_in, "Tr8x8", height, fit="print", clearance=clearance)
    doc_ex, body_ex = _shaft_body("Tr8x8", height)
    shaft, _ = _cut_thread(doc_ex, body_ex, "Tr8x8", height, fit="print", clearance=clearance)
    assert hole.is_valid and shaft.is_valid, "a 4-start Tr8x8 thread is not a valid solid"
    # Volume-vs-analytic is checked separately, at zero clearance, by
    # test_tr8x8_thread_cuts_to_analytic_volume above — print clearance
    # legitimately widens the cut past that oracle, same as the M6x1 pair
    # test above never checks it either.

    shaft_shifted = Pos(0, 0, rec["pitch"] / 4) * shaft
    one_pitch = _analytic_thread_volume(rec, rec["pitch"], True)
    common = _serial_bool(hole, shaft_shifted, "common")
    assert common.volume < 0.01 * one_pitch, (
        f"the 4-start Tr8x8 pair overlaps by {common.volume:.4f} mm3 at a quarter-pitch "
        f"phase — more than 1% of one pitch-period's worth ({one_pitch:.4f} mm3)")
    print(f"{PASS} a 4-start Tr8x8 pair screwed together with {clearance} mm print clearance "
          f"does not interfere (overlap {common.volume:.2e} mm3)")


def test_tr8x2_single_start_nut_does_not_fit_tr8x8_four_start_screw():
    """Tr8x2 is the wrong-starts nut: the same 8 mm major diameter and the
    same 2 mm pitch as Tr8x8's own per-groove pitch, but only ONE helical
    groove instead of 4 interleaved ones — exactly what a single-start
    build of "Tr8x8" would have cut before this fix, missing 3 of its 4
    starts.

    Measured by hand before writing this test, scanning all 8 phases in
    1/8-pitch steps on the SAME 16 mm engagement as the matched pair above:
    unlike that 4-start pair (clean across a quarter-to-five-eighths
    window), the Tr8x2-vs-Tr8x8 mismatch is only clean through the first
    quarter of a pitch (0, 1/8, 1/4) and interferes for real past it (3/8,
    1/2). Half a pitch is used here: real, substantial overlap on this
    engagement length, not tolerance noise — and it is exactly the phase
    where the true 4-start pair above stays at a clean 0.0, so the one
    assembly phase that fits the real lead screw does not fit this nut."""
    height = 16.0
    clearance = 0.15
    rec8 = thread_standards.lookup("Tr8x8")
    rec2 = thread_standards.lookup("Tr8x2")
    assert rec2.get("starts", 1) == 1, "Tr8x2 must stay single-start"

    doc_in, body_in = _bored_body("Tr8x2", height)
    nut, _ = _cut_thread(doc_in, body_in, "Tr8x2", height, fit="print", clearance=clearance)
    doc_ex, body_ex = _shaft_body("Tr8x8", height)
    screw, _ = _cut_thread(doc_ex, body_ex, "Tr8x8", height, fit="print", clearance=clearance)
    assert nut.is_valid and screw.is_valid, "a mismatched test body is not a valid solid"

    screw_shifted = Pos(0, 0, rec8["pitch"] / 2) * screw
    common = _serial_bool(nut, screw_shifted, "common")
    one_pitch = _analytic_thread_volume(rec2, rec2["pitch"], True)
    assert common.volume > 0.1 * one_pitch, (
        f"a single-start Tr8x2 nut only overlaps the 4-start Tr8x8 screw by "
        f"{common.volume:.4f} mm3 at half a pitch — expected real interference "
        f"(over 10% of one pitch-period's worth, {one_pitch:.4f} mm3)")
    print(f"{PASS} a single-start Tr8x2 nut does NOT fit a 4-start Tr8x8 screw "
          f"(overlap {common.volume:.4f} mm3 at half a pitch, vs {one_pitch:.4f} mm3/pitch)")


def test_a_thirty_mm_tr8x8_thread_cuts_within_the_heartbeat():
    """30 mm of a 4-start Tr8x8 lead screw (15 turns of its own 2 mm pitch) —
    the same real workload as 30 turns of M6x1 above — must rebuild and
    tessellate well inside the sidecar's own stall heartbeat."""
    from server import STALL_TIMEOUT

    height = 30.0
    doc, body = _bored_body("Tr8x8", height)
    before = body["shape"].volume
    shape, seconds = _cut_thread(doc, body, "Tr8x8", height)
    assert shape.is_valid, "the 30 mm 4-start Tr8x8 threaded block is not a valid solid"
    _check_thread_volume("Tr8x8 30 mm (4-start)", "Tr8x8", height, True, before, shape.volume)
    shape.mesh(0.1)
    assert seconds < STALL_TIMEOUT, (
        f"a 30 mm 4-start Tr8x8 thread took {seconds:.1f} s, past the {STALL_TIMEOUT:.0f} s heartbeat")
    print(f"{PASS} a 30 mm 4-start Tr8x8 thread cuts and tessellates in {seconds:.2f} s "
          f"(heartbeat {STALL_TIMEOUT:.0f} s)")


def test_an_old_m6x1_document_with_no_starts_field_rebuilds_the_same_geometry():
    """A thread feature dict with no `starts` key at all — what every M6x1
    document already was before this fix, and still is, since nothing in
    `_handle_thread`'s resolution (`f.get("starts", rec.get("starts", 1))`)
    changes for a standard this fix left untouched. Makes that backward-
    compat claim explicit: omitting `starts` and passing an explicit 1 must
    resolve to the exact same geometry."""
    height = 10.0
    doc_a, body_a = _bored_body("M6x1", height)
    shape_a, _ = _cut_thread(doc_a, body_a, "M6x1", height)  # no starts key at all
    doc_b, body_b = _bored_body("M6x1", height)
    shape_b, _ = _cut_thread(doc_b, body_b, "M6x1", height, starts=1)  # explicit starts=1
    assert shape_a.is_valid and shape_b.is_valid
    rel = shape_b.volume / shape_a.volume - 1
    assert rel == 0.0, (
        f"an explicit starts=1 differs from the old no-starts-field document by {rel:+.2e}")
    print(f"{PASS} an old M6x1 thread document (no starts field) rebuilds identically "
          f"to one with an explicit starts=1 ({shape_a.volume:.4f} mm3)")


def test_m6x1_internal_thread_from_a_nominal_diameter_hole_fills_then_cuts():
    """The bug this fix is for: a hole drawn at the thread's NOMINAL (major)
    diameter, 6 mm for M6x1, not tap-drilled to the minor diameter first —
    the way someone modeling for 3D printing actually draws it. Must fill
    the gap back to the tap drill diameter, then cut the same thread as the
    tap-drilled path, landing on the same final shape (same volume) either
    way, with the result's own measured major and minor diameter matching
    the standard."""
    height = 10.0
    rec = thread_standards.lookup("M6x1")
    doc_tapped, body_tapped = _bored_body("M6x1", height)  # tap-drilled, the old path
    tapped_shape, _ = _cut_thread(doc_tapped, body_tapped, "M6x1", height)

    doc_nom, body_nom = _bored_body("M6x1", height, bore_d=rec["majorDiameter"])
    nominal_shape, _ = _cut_thread(doc_nom, body_nom, "M6x1", height)

    assert nominal_shape.is_valid, "the filled-then-threaded block is not a valid solid"
    assert len(nominal_shape.solids()) == 1, "the fill-and-cut split the body into pieces"

    rel = nominal_shape.volume / tapped_shape.volume - 1
    assert abs(rel) < 0.005, (
        f"a nominal-diameter hole threads to a different volume than the tap-drilled "
        f"path: {nominal_shape.volume:.4f} vs {tapped_shape.volume:.4f} mm3 ({rel:+.2%})")

    major_d, minor_d = _measure_hole_diameters(nominal_shape, rec["majorDiameter"])
    assert abs(major_d - rec["majorDiameter"]) < 0.05, (
        f"measured major diameter {major_d:.4f} mm, standard is {rec['majorDiameter']:.4f} mm")
    minor_want = thread_standards.minor_diameter(rec)
    assert abs(minor_d - minor_want) < 0.05, (
        f"measured minor diameter {minor_d:.4f} mm, standard is {minor_want:.4f} mm")
    print(f"{PASS} a 6 mm (nominal) M6x1 hole fills then cuts to the tap-drilled path's "
          f"volume ({rel:+.1e}), measured major {major_d:.4f} / minor {minor_d:.4f} mm")


def test_m6x1_pair_from_a_nominal_diameter_hole_mates_with_print_clearance():
    """The mating-pair proof for the bug's own repro: a hole drawn at 6 mm
    (M6x1's nominal major diameter, not tap-drilled), threaded internal,
    mated against an M6x1 external thread on a 6 mm shaft — same
    quarter-pitch assembly phase and print clearance as the tap-drilled
    pair test above — must not interfere either."""
    height = 10.0
    clearance = 0.15
    rec = thread_standards.lookup("M6x1")
    doc_in, body_in = _bored_body("M6x1", height, bore_d=rec["majorDiameter"])
    hole, _ = _cut_thread(doc_in, body_in, "M6x1", height, fit="print", clearance=clearance)
    doc_ex, body_ex = _shaft_body("M6x1", height)
    shaft, _ = _cut_thread(doc_ex, body_ex, "M6x1", height, fit="print", clearance=clearance)
    assert hole.is_valid and shaft.is_valid
    shaft = Pos(0, 0, rec["pitch"] / 4) * shaft

    one_turn = _analytic_thread_volume(rec, 1.0, True)
    common = _serial_bool(hole, shaft, "common")
    assert common.volume < 0.01 * one_turn, (
        f"the mated pair (nominal-diameter hole) overlaps by {common.volume:.4f} mm3 "
        f"- more than 1% of one turn ({one_turn:.4f} mm3)")
    print(f"{PASS} an M6x1 pair from a 6 mm (nominal) hole, screwed together with "
          f"{clearance} mm print clearance, does not interfere (overlap {common.volume:.2e} mm3)")


def test_unc_quarter_20_thread_from_a_nominal_diameter_hole_fills_then_cuts():
    """Same nominal-diameter repro as M6x1 above, for a UNC standard — a
    different pitch, and an imperial diameter (6.35 mm, 1/4 inch), but the
    same 60-degree ISO 68-1 family depth fraction."""
    height = 12.0
    rec = thread_standards.lookup("1/4-20 UNC")
    doc, body = _bored_body("1/4-20 UNC", height, bore_d=rec["majorDiameter"])
    shape, _ = _cut_thread(doc, body, "1/4-20 UNC", height)
    assert shape.is_valid, "the filled-then-threaded 1/4-20 UNC block is not a valid solid"
    major_d, minor_d = _measure_hole_diameters(shape, rec["majorDiameter"])
    assert abs(major_d - rec["majorDiameter"]) < 0.05, (
        f"measured major diameter {major_d:.4f} mm, standard is {rec['majorDiameter']:.4f} mm")
    minor_want = thread_standards.minor_diameter(rec)
    assert abs(minor_d - minor_want) < 0.05, (
        f"measured minor diameter {minor_d:.4f} mm, standard is {minor_want:.4f} mm")
    print(f"{PASS} a {rec['majorDiameter']:.3g} mm (nominal) hole + 1/4-20 UNC measures "
          f"major {major_d:.4f} / minor {minor_d:.4f} mm")


def test_tr8x8_thread_from_a_nominal_diameter_hole_fills_then_cuts():
    """Same nominal-diameter repro for a 4-start trapezoidal standard — the
    fill-then-cut path has to hold up for a 30-degree profile and multiple
    rotated tool copies too, not just the 60-degree single-start families
    above."""
    height = 16.0
    rec = thread_standards.lookup("Tr8x8")
    doc, body = _bored_body("Tr8x8", height, bore_d=rec["majorDiameter"])
    shape, _ = _cut_thread(doc, body, "Tr8x8", height)
    assert shape.is_valid, "the filled-then-threaded Tr8x8 block is not a valid solid"
    major_d, minor_d = _measure_hole_diameters(shape, rec["majorDiameter"])
    assert abs(major_d - rec["majorDiameter"]) < 0.05, (
        f"measured major diameter {major_d:.4f} mm, standard is {rec['majorDiameter']:.4f} mm")
    minor_want = thread_standards.minor_diameter(rec)
    assert abs(minor_d - minor_want) < 0.05, (
        f"measured minor diameter {minor_d:.4f} mm, standard is {minor_want:.4f} mm")
    print(f"{PASS} an 8 mm (nominal) hole + Tr8x8 measures major {major_d:.4f} / "
          f"minor {minor_d:.4f} mm")


def test_a_4_92mm_hole_still_matches_the_tap_drilled_path_unchanged():
    """4.92 mm, rounded from M6x1's own tap drill (4.9175 mm), must still
    land on the EXISTING no-fill path this fix leaves untouched — this fix
    widens which holes are ACCEPTED, not which ones get filled first."""
    height = 10.0
    doc, body = _bored_body("M6x1", height, bore_d=4.92)
    before = body["shape"].volume
    shape, _ = _cut_thread(doc, body, "M6x1", height)
    assert shape.is_valid, "a 4.92 mm (tap drill) bore refused to thread"
    _check_thread_volume("M6x1 at a 4.92 mm (tap drill) hole", "M6x1", height, True, before, shape.volume)


def test_a_hole_between_both_diameters_refuses_naming_both():
    """5.5 mm sits too far from BOTH of M6x1's accepted diameters (6 mm
    nominal major, 4.92 mm tap drill) to guess which one was intended. Must
    refuse with a message naming both, not just one."""
    height = 10.0
    doc, body = _bored_body("M6x1", height, bore_d=5.5)
    sel = _cylindrical_face_selector(body, body["id"])
    doc = dict(doc, features=doc["features"] + [_thread_feature(sel, "M6x1")])
    part, err, bodies = rebuild(doc)
    thread_err = [e for e in err if e.get("feature_id") == "th"]
    assert thread_err, f"a 5.5 mm hole against M6x1 built without an error: {err}"
    msg = thread_err[0]["message"]
    assert "6 mm" in msg and "4.92 mm" in msg, msg
    print(f"{PASS} a 5.5 mm hole against M6x1 refuses naming both diameters: {msg[:90]}...")


def test_second_thread_on_an_already_threaded_hole_refuses_naming_the_first():
    """The bug this fix is for, reproduced at its root: a stale `by:"match"`
    face selector. Thomas's own document had two Thread features pointing at
    what was, when each was drawn, the SAME cylindrical face fingerprint —
    the second authored after a re-pick that copied the first thread's
    selector rather than deriving a fresh one. By the time the second
    feature replays, the first cut has already consumed that cylindrical
    face down to a thin root-land remnant; `by:"match"` never refuses (see
    geom_select.py's own docstring), so it silently resolved onto that
    remnant and cut a second, differently-phased thread confined to a few mm
    near the middle of the hole — exactly Thomas's screenshot. Must now
    refuse outright, naming the first feature, and leave the body exactly as
    the first thread alone left it.

    Nominal-diameter (not tap-drilled) on purpose, and bored off-centre: that
    is the hole Thomas actually drew, and this also exercises the
    fill-then-cut path, not the bare-removal one — see `_offset_hole_body`
    for why the off-centre placement matters to reproducing this bug."""
    height = 25.0
    rec = thread_standards.lookup("M6x1")
    doc, body = _offset_hole_body(rec["majorDiameter"], height)
    sel = _cylindrical_face_selector(body, body["id"])

    doc_one = dict(doc, features=doc["features"] + [_thread_feature(sel, "M6x1", id="th1")])
    part1, err1, bodies1 = rebuild(doc_one)
    assert not err1, err1
    single_shape = next(b for b in bodies1 if b["id"] == body["id"])["shape"]

    doc_two = dict(doc, features=doc["features"] + [
        _thread_feature(sel, "M6x1", id="th1"),
        _thread_feature(sel, "M6x1", id="th2"),
    ])
    part2, err2, bodies2 = rebuild(doc_two)
    double_shape = next(b for b in bodies2 if b["id"] == body["id"])["shape"]

    th2_err = [e for e in err2 if e.get("feature_id") == "th2"]
    assert th2_err, f"a second thread on the same hole built without an error: {err2}"
    msg = th2_err[0]["message"]
    assert "already has a thread" in msg and "th1" in msg, msg

    assert double_shape.is_valid, "the refused-second-thread body is not a valid solid"
    rel = double_shape.volume / single_shape.volume - 1
    assert rel == 0.0, (
        f"the refused second thread changed the body's volume by {rel:+.2e} "
        f"({single_shape.volume:.4f} -> {double_shape.volume:.4f} mm3)")
    print(f"{PASS} a second thread on an already-threaded hole refuses naming the first "
          f"({msg[:70]}...), body volume unchanged ({single_shape.volume:.4f} mm3)")


def test_an_old_single_thread_document_rebuilds_unchanged_after_the_conflict_fix():
    """The conflict check this fix adds must never fire on a normal
    single-Thread document — only a SECOND Thread sharing an already-
    threaded axis is refused. A plain tap-drilled thread must build to
    exactly the same volume as it always has."""
    height = 10.0
    doc, body = _bored_body("M6x1", height)
    shape, _ = _cut_thread(doc, body, "M6x1", height)
    assert shape.is_valid
    _check_thread_volume("a lone M6x1 thread (no second feature)", "M6x1", height, True,
                          body["shape"].volume, shape.volume)


if __name__ == "__main__":
    test_m6x1_internal_thread_cuts_to_analytic_volume()
    test_m6x1_external_thread_cuts_to_analytic_volume()
    test_unc_quarter_20_thread_cuts_to_analytic_volume()
    test_tr8x8_thread_cuts_to_analytic_volume()
    test_left_hand_thread_builds_a_valid_solid_of_the_same_volume()
    test_a_thirty_turn_thread_cuts_within_the_heartbeat()
    test_editing_the_hole_diameter_slightly_still_rethreads()
    test_editing_the_hole_diameter_a_lot_refuses_in_words()
    test_m6x1_pair_mates_with_print_clearance_and_does_not_interfere()
    test_tr8x8_four_start_pair_mates_with_print_clearance_and_does_not_interfere()
    test_tr8x2_single_start_nut_does_not_fit_tr8x8_four_start_screw()
    test_a_thirty_mm_tr8x8_thread_cuts_within_the_heartbeat()
    test_an_old_m6x1_document_with_no_starts_field_rebuilds_the_same_geometry()
    test_m6x1_internal_thread_from_a_nominal_diameter_hole_fills_then_cuts()
    test_m6x1_pair_from_a_nominal_diameter_hole_mates_with_print_clearance()
    test_unc_quarter_20_thread_from_a_nominal_diameter_hole_fills_then_cuts()
    test_tr8x8_thread_from_a_nominal_diameter_hole_fills_then_cuts()
    test_a_4_92mm_hole_still_matches_the_tap_drilled_path_unchanged()
    test_a_hole_between_both_diameters_refuses_naming_both()
    test_second_thread_on_an_already_threaded_hole_refuses_naming_the_first()
    test_an_old_single_thread_document_rebuilds_unchanged_after_the_conflict_fix()
    print("\nall thread tests passed")
