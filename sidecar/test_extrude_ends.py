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



# --- start and end OBJECTS (GH #41 a and b) -------------------------------------
#
# An extrude can start from, or run up to, a point or a straight line, and start
# from a construction plane or a flat face. Each counts only as the plane
# PARALLEL TO THE SKETCH through it. Every reference names live geometry, so
# the tests that matter here are the ones that MOVE that geometry and check the
# extrude went with it: a reference that froze a coordinate passes every other
# assertion in this section.

from builder import _edge_end  # noqa: E402
from build123d import Edge  # noqa: E402
from geom_select import edge_fingerprint, face_fingerprint  # noqa: E402


def _ext(**kw):
    return {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5,
            "operation": "new", **kw}


def _ref_sketch(entities, plane="XZ", sid="s2"):
    """A second sketch holding nothing but reference geometry."""
    return {"id": sid, "type": "sketch", "plane": plane, "entities": entities}


def _body(bodies, bid):
    return next(b for b in bodies if b["id"] == bid)


def _box(height=15.0):
    """A 10 x 10 box at x=50, `height` tall: the geometry the body references
    below are taken off, as `body1`. Built from its own sketch, so the profile
    sketch `s1` is free to sit at the origin."""
    return [
        {"id": "s0", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 10, "height": 10, "x": 50, "y": 0}]},
        {"id": "e0", "type": "extrude", "sketch": "s0", "distance": height, "operation": "new"},
    ]


def _fp_edge(features, pred, body="body1"):
    """A by:"match" edge reference AUTHORED THE WAY THE APP AUTHORS IT: off the
    real kernel edge, by the same edge_fingerprint the query op returns."""
    _p, errors, bodies = _build(features)
    assert not errors, errors
    b = _body(bodies, body)
    hits = [e for e in b["shape"].edges() if pred(e)]
    assert len(hits) == 1, f"the test meant one edge, found {len(hits)}"
    return {"kind": "edge", "by": "match", "fp": edge_fingerprint(hits[0], b["shape"]), "body": body}


def _fp_face(features, pred, body="body1"):
    _p, errors, bodies = _build(features)
    assert not errors, errors
    b = _body(bodies, body)
    hits = [fc for fc in b["shape"].faces() if pred(fc)]
    assert len(hits) == 1, f"the test meant one face, found {len(hits)}"
    return {"kind": "face", "by": "match", "fp": face_fingerprint(hits[0], b["shape"]), "body": body}


def _zspan(bodies, bid):
    b = _body(bodies, bid)
    bb = b["shape"].bounding_box()
    return round(bb.min.Z, 6), round(bb.max.Z, 6)


def test_up_to_an_origin_plane():
    """XY / XZ / YZ were always accepted by id. The app never offered them as a
    target; it does now, so pin what they build."""
    s1 = {"id": "s1", "type": "sketch",
          "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
          "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]}
    part, errors, _ = _build([s1, _ext(upToPlane="XY")])
    assert not errors, errors
    lo, hi = _span(part, 2)
    assert abs(lo) < 1e-4 and abs(hi - 10) < 1e-4, f"span {lo}..{hi}"


def test_up_to_a_sketch_point_follows_the_point():
    """The plane through the point, parallel to the sketch. Move the point and
    the extrude goes with it: the reference is the entity, not a coordinate."""
    ref = {"kind": "sketchPoint", "sketch": "s2", "entity": "p1", "pointIndex": 0}
    for z in (12.0, 20.0):
        # on XZ, sketch y is world z
        pt = _ref_sketch([{"id": "p1", "type": "point", "x": 5, "y": z}])
        part, errors, _ = _build([_sq(), pt, _ext(upToRef=ref)])
        assert not errors, errors
        lo, hi = _span(part, 2)
        assert abs(lo) < 1e-4 and abs(hi - z) < 1e-4, f"point at z={z}: span {lo}..{hi}"


def test_sketch_point_indices_match_the_app():
    """Point indices are dimRefPoints' (src/sketch/entityDims.ts): a wrong index
    still builds, at the wrong point, so each kind is pinned by height."""
    ents = [
        {"id": "l1", "type": "line", "x1": -5, "y1": 3, "x2": 5, "y2": 7},
        # three-point arc through (0, 14): its centre is at (0, 9), radius 5
        {"id": "a1", "type": "arc", "x1": -5, "y1": 9, "x2": 5, "y2": 9, "mx": 0, "my": 14},
        {"id": "r1", "type": "rectangle", "x": 30, "y": 20, "width": 4, "height": 6},
        {"id": "c1", "type": "circle", "x": 0, "y": 30, "radius": 2},
    ]
    for entity, point, z in (("l1", 0, 3), ("l1", 1, 7), ("a1", 2, 9), ("a1", 1, 9),
                             ("r1", 0, 17), ("r1", 2, 23), ("c1", 0, 30)):
        ref = {"kind": "sketchPoint", "sketch": "s2", "entity": entity, "pointIndex": point}
        part, errors, _ = _build([_sq(), _ref_sketch(ents), _ext(upToRef=ref)])
        assert not errors, f"{entity}[{point}]: {errors}"
        lo, hi = _span(part, 2)
        assert abs(hi - z) < 1e-4, f"{entity}[{point}] should stop at z={z}, stopped at {hi}"


def test_shape_points_the_picker_offers_build():
    """The Extrude picker offers every point dimRefPoints lists, and those
    include a rectangle's centre (4), a polygon's corners (0..n-1, polygonPoints
    order) and centre (-1), and a slot's two centres. Each built only as a
    refusal before, 'isn't on its curve any more'. Pinned by height, as above:
    a wrong index still builds, at the wrong point."""
    ents = [
        {"id": "r1", "type": "rectangle", "x": 30, "y": 20, "width": 4, "height": 6},
        # corner k at 90 + 60k degrees round (0, 40), radius 4
        {"id": "h1", "type": "polygon", "x": 0, "y": 40, "radius": 4, "sides": 6, "angle": 90},
        {"id": "s1", "type": "slot", "x1": 10, "y1": 50, "x2": 20, "y2": 55, "width": 2},
    ]
    for entity, point, z in (("r1", 4, 20), ("h1", 0, 44), ("h1", 1, 42), ("h1", 3, 36), ("h1", -1, 40),
                             ("s1", 0, 50), ("s1", 1, 55)):
        ref = {"kind": "sketchPoint", "sketch": "s2", "entity": entity, "pointIndex": point}
        part, errors, _ = _build([_sq(), _ref_sketch(ents), _ext(upToRef=ref)])
        assert not errors, f"{entity}[{point}]: {errors}"
        assert abs(_span(part, 2)[1] - z) < 1e-4, f"{entity}[{point}] should stop at z={z}, stopped at {_span(part, 2)[1]}"
    for entity, point in (("r1", 5), ("h1", 6), ("h1", -2), ("s1", 2)):
        ref = {"kind": "sketchPoint", "sketch": "s2", "entity": entity, "pointIndex": point}
        _expect_error([_sq(), _ref_sketch(ents), _ext(upToRef=ref)], "isn't on its curve any more",
                      f"{entity}[{point}], a point the shape does not have")


def test_a_shape_side_is_a_line():
    """A side of a rectangle, polygon or slot, named `<shapeId>~<k>` the way
    the sketch's constraints name it (entityDims.lineOperand), is a line: one
    parallel to the sketch gives its height, a tilted one is refused like a
    tilted line, and a side the shape does not have is gone."""
    ents = [
        # corners (28,17) (32,17) (32,23) (28,23): side 0 the bottom, 1 the right
        {"id": "r1", "type": "rectangle", "x": 30, "y": 20, "width": 4, "height": 6},
        # corner k at 60k degrees round (0, 40): side 1 runs level across the top
        {"id": "h1", "type": "polygon", "x": 0, "y": 40, "radius": 4, "sides": 6, "angle": 0},
        # a level slot: side 0 on the left of its axis (above it), side 1 below
        {"id": "s1", "type": "slot", "x1": 10, "y1": 50, "x2": 20, "y2": 50, "width": 4},
    ]
    top = 40 + 4 * math.sin(math.radians(60))
    for entity, z in (("r1~0", 17), ("r1~2", 23), ("h1~1", top), ("h1~4", 80 - top),
                      ("s1~0", 52), ("s1~1", 48), ("s1~2", 50)):
        end = {"kind": "sketchLine", "sketch": "s2", "entity": entity}
        part, errors, _ = _build([_sq(), _ref_sketch(ents), _ext(upToRef=end)])
        assert not errors, f"{entity}: {errors}"
        assert abs(_span(part, 2)[1] - z) < 1e-4, f"{entity} should stop at z={z}, stopped at {_span(part, 2)[1]}"
    # as a START too, with the start offset riding on it
    start = {"kind": "sketchLine", "sketch": "s2", "entity": "r1~2"}
    part, errors, _ = _build([_sq(), _ref_sketch(ents), _ext(startFrom=start, startOffset=1)])
    assert not errors, errors
    lo, hi = _span(part, 2)
    assert abs(lo - 24) < 1e-4 and abs(hi - 29) < 1e-4, f"start from r1's top side + 1: {lo}..{hi}"
    for entity in ("r1~1", "h1~0"):
        _expect_error([_sq(), _ref_sketch(ents), _ext(upToRef={"kind": "sketchLine", "sketch": "s2", "entity": entity})],
                      "isn't parallel to the sketch", f"{entity}, a tilted side")
    # no such side, and a rectangle Explode turned into lines (its id stays on
    # its first line) without the reference being carried
    lines = [{"id": "r1", "type": "line", "x1": 28, "y1": 17, "x2": 32, "y2": 17}]
    for sketch, entity in ((ents, "r1~4"), (ents, "h1~6"), (ents, "s1~3"), (lines, "r1~2")):
        _expect_error([_sq(), _ref_sketch(sketch), _ext(upToRef={"kind": "sketchLine", "sketch": "s2", "entity": entity})],
                      "deleted from its sketch", f"{entity}, a side that is not there")


def test_up_to_a_line_parallel_to_the_sketch():
    """A line parallel to the sketch names one height. A tilted one does not, and
    is refused rather than read at one of its ends."""
    flat = _ref_sketch([{"id": "l1", "type": "line", "x1": -5, "y1": 15, "x2": 5, "y2": 15}])
    part, errors, _ = _build([_sq(), flat,
                              _ext(upToRef={"kind": "sketchLine", "sketch": "s2", "entity": "l1"})])
    assert not errors, errors
    assert abs(_span(part, 2)[1] - 15) < 1e-4
    tilted = _ref_sketch([{"id": "l1", "type": "line", "x1": -5, "y1": 10, "x2": 5, "y2": 20}])
    _expect_error([_sq(), tilted, _ext(upToRef={"kind": "sketchLine", "sketch": "s2", "entity": "l1"})],
                  "isn't parallel to the sketch", "tilted sketch line")
    arc = _ref_sketch([{"id": "a1", "type": "arc", "x1": -5, "y1": 9, "x2": 5, "y2": 9, "mx": 0, "my": 14}])
    _expect_error([_sq(), arc, _ext(upToRef={"kind": "sketchLine", "sketch": "s2", "entity": "a1"})],
                  "isn't a straight line", "an arc as a line")


def test_up_to_a_body_edge_follows_the_body():
    """A straight body edge parallel to the sketch, by:"match": the box grows
    and the extrude still stops on its top edge, not where the edge used to be."""
    feats = _box(15)
    sel = _fp_edge(feats, lambda e: e.geom_type.name == "LINE"
                   and abs(e.center().Z - 15) < 1e-6 and abs(e.center().Y + 5) < 1e-6)
    ref = {"kind": "edge", "edge": sel}
    for h in (15.0, 25.0):
        _p, errors, bodies = _build(_box(h) + [_sq(), _ext(upToRef=ref)])
        assert not errors, f"box {h}: {errors}"
        assert _zspan(bodies, "body2") == (0.0, h), f"box {h}: {_zspan(bodies, 'body2')}"
    # a vertical edge is not parallel to an XY sketch
    vert = _fp_edge(feats, lambda e: e.geom_type.name == "LINE"
                    and abs(e.center().X - 55) < 1e-6 and abs(e.center().Y - 5) < 1e-6)
    _expect_error(_box(15) + [_sq(), _ext(upToRef={"kind": "edge", "edge": vert})],
                  "isn't parallel to the sketch", "vertical edge")


def test_up_to_a_body_corner():
    """A corner is one END of a by:"match" edge. End 1 is the end further along
    the fingerprint's direction, so on a vertical edge it is the top."""
    feats = _box(15)
    vert = _fp_edge(feats, lambda e: e.geom_type.name == "LINE"
                    and abs(e.center().X - 55) < 1e-6 and abs(e.center().Y - 5) < 1e-6)
    assert vert["fp"]["dir"][2] > 0, "a vertical edge's fingerprint points up"
    for h in (15.0, 22.0):
        _p, errors, bodies = _build(_box(h) + [_sq(), _ext(upToRef={"kind": "vertex", "edge": vert, "end": 1})])
        assert not errors, errors
        assert _zspan(bodies, "body2") == (0.0, h), _zspan(bodies, "body2")
    # end 0 is the bottom corner, level with the sketch
    _expect_error(_box(15) + [_sq(), _ext(upToRef={"kind": "vertex", "edge": vert, "end": 0})],
                  "already level", "bottom corner")


def test_edge_end_ignores_the_kernels_orientation():
    """The same corner whichever way round the kernel built the edge."""
    up = Edge.make_line((0, 0, 0), (0, 0, 10))
    down = Edge.make_line((0, 0, 10), (0, 0, 0))
    for e in (up, down):
        assert abs(_edge_end(e, 1).Z - 10) < 1e-9 and abs(_edge_end(e, 0).Z) < 1e-9


def test_start_from_a_face_follows_the_face():
    """THE BOX AND LID. The lid profile sits in the box's sketch plane; it starts
    from the box's TOP FACE, and when the box gets taller the lid rides up with
    it. A start offset is measured from the face."""
    top = _fp_face(_box(15), lambda fc: abs(fc.center().Z - 15) < 1e-6)
    start = {"kind": "face", "face": top}
    for h in (15.0, 30.0):
        _p, errors, bodies = _build(_box(h) + [_sq(), _ext(distance=2, startFrom=start)])
        assert not errors, f"box {h}: {errors}"
        assert _zspan(bodies, "body2") == (h, h + 2), f"box {h}: {_zspan(bodies, 'body2')}"
    _p, errors, bodies = _build(_box(15) + [_sq(), _ext(distance=2, startFrom=start, startOffset=3)])
    assert not errors, errors
    assert _zspan(bodies, "body2") == (18.0, 20.0), _zspan(bodies, "body2")


def test_start_from_a_tilted_or_curved_face_is_refused():
    """Phase 1: only a face parallel to the sketch. Refused by name, never moved
    by the distance at one arbitrary point of the face."""
    side = _fp_face(_box(15), lambda fc: abs(fc.center().X - 55) < 1e-6)
    _expect_error(_box(15) + [_sq(), _ext(startFrom={"kind": "face", "face": side})],
                  "tilted to the sketch", "side face")
    cyl = [{"id": "s0", "type": "sketch", "plane": "XY",
            "entities": [{"type": "circle", "x": 50, "y": 0, "radius": 5}]},
           {"id": "e0", "type": "extrude", "sketch": "s0", "distance": 15, "operation": "new"}]
    barrel = _fp_face(cyl, lambda fc: fc.geom_type.name == "CYLINDER")
    _expect_error(cyl + [_sq(), _ext(startFrom={"kind": "face", "face": barrel})],
                  "is curved", "cylinder wall")


def test_start_from_a_plane():
    """A construction plane parallel to the sketch: the profile moves onto it.
    One tilted to the sketch, an origin plane included, is refused."""
    part, errors, _ = _build([_sq(), {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 7},
                              _ext(startFrom={"kind": "plane", "plane": "d1"})])
    assert not errors, errors
    lo, hi = _span(part, 2)
    assert abs(lo - 7) < 1e-4 and abs(hi - 12) < 1e-4, f"span {lo}..{hi}"
    _expect_error([_sq(), _ext(startFrom={"kind": "plane", "plane": "XZ"})],
                  "tilted to the sketch", "XZ start for an XY sketch")
    _expect_error([_sq(), _ext(startFrom={"kind": "plane", "plane": "gone"})],
                  "starts from was deleted", "a deleted start plane")


def test_start_from_a_point_and_up_to_a_line_compose():
    """Both ends objects: it spans start..end, the start offset rides on the
    start, and symmetric straddles the start plane."""
    ref = _ref_sketch([{"id": "p1", "type": "point", "x": 0, "y": 4},
                       {"id": "l1", "type": "line", "x1": -5, "y1": 15, "x2": 5, "y2": 15}])
    start = {"kind": "sketchPoint", "sketch": "s2", "entity": "p1", "pointIndex": 0}
    end = {"kind": "sketchLine", "sketch": "s2", "entity": "l1"}
    part, errors, _ = _build([_sq(), ref, _ext(startFrom=start, upToRef=end)])
    assert not errors, errors
    lo, hi = _span(part, 2)
    assert abs(lo - 4) < 1e-4 and abs(hi - 15) < 1e-4, f"span {lo}..{hi}"
    part, errors, _ = _build([_sq(), ref, _ext(startFrom=start, startOffset=1, upToRef=end, upToOffset=-2)])
    assert not errors, errors
    lo, hi = _span(part, 2)
    assert abs(lo - 5) < 1e-4 and abs(hi - 13) < 1e-4, f"span {lo}..{hi}"
    part, errors, _ = _build([_sq(), ref, _sym(distance=10, startFrom=start)])
    assert not errors, errors
    lo, hi = _span(part, 2)
    assert abs(lo + 1) < 1e-4 and abs(hi - 9) < 1e-4, f"symmetric about z=4: {lo}..{hi}"


def test_start_and_end_references_that_are_gone():
    """Each way a reference can break says which way, and names Extrude."""
    pt = {"kind": "sketchPoint", "sketch": "s2", "entity": "p1", "pointIndex": 0}
    _expect_error([_sq(), _ext(upToRef=pt)], "was deleted", "no such sketch")
    _expect_error([_sq(), _ref_sketch([]), _ext(upToRef=pt)], "deleted from its sketch", "no such point")
    _expect_error([_sq(), _ext(upToRef=pt), _ref_sketch([{"id": "p1", "type": "point", "x": 0, "y": 9}])],
                  "comes after this extrude", "a sketch later in the timeline")
    # The end a Trim removed from a line that kept its id: the app writes
    # TRIMMED_AWAY (-2, src/types.ts) so the extrude is refused, not moved onto
    # whatever end the shortened line has at the old index.
    trimmed = {"kind": "sketchPoint", "sketch": "s2", "entity": "l1", "pointIndex": -2}
    _expect_error([_sq(), _ref_sketch([{"id": "l1", "type": "line", "x1": -5, "y1": 3, "x2": 5, "y2": 7}]),
                   _ext(upToRef=trimmed)], "isn't on its curve any more", "a point a trim removed")
    sel = _fp_edge(_box(15), lambda e: e.geom_type.name == "LINE"
                   and abs(e.center().Z - 15) < 1e-6 and abs(e.center().Y + 5) < 1e-6)
    _expect_error([_sq(), _ext(upToRef={"kind": "edge", "edge": sel})],
                  "no longer exists", "an edge on a body that is not there")


def test_one_target_at_a_time():
    """A point or line target is exclusive with a face or plane target, and
    Press/Pull refuses one rather than ignore it."""
    end = {"kind": "sketchLine", "sketch": "s2", "entity": "l1"}
    line = _ref_sketch([{"id": "l1", "type": "line", "x1": -5, "y1": 15, "x2": 5, "y2": 15}])
    _expect_error([_sq(), line, {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": 10},
                   _ext(upToRef=end, upToPlane="d1")], "not two", "upToRef + upToPlane")
    _expect_error([_sq(), line, _sym(distance=5, upToRef=end)], "symmetric can't be combined",
                  "symmetric + upToRef")
    _expect_error(
        [_sq(), {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
         line,
         {"id": "pp", "type": "press-pull", "face": {"kind": "face", "by": "nearest", "point": [0, 0, 5]},
          "distance": 2, "operation": "join", "upToRef": end}],
        "an Extrude option", "press/pull with upToRef")



def test_the_app_authored_references_build_and_follow():
    """End to end in sidecar terms, the way the app makes these: a CLICK gives a
    by:"nearest" point on an edge or face, the `query` op turns it into the
    by:"match" reference that is stored (store.queryReferences), and the corner
    END is read off the returned fingerprint the way extrudeTool does it
    ((corner - mid) . dir > 0 is end 1). Then the box grows, and both the start
    face and the corner target must go with it."""
    import os
    os.environ.setdefault("SINDRI_DISK_CACHE", "0")
    from builder import query_geometry

    box = {"parameters": {}, "features": _box(15)}
    corner = (55.0, 5.0, 15.0)
    # the vertical edge at x=55, y=5: the viewport's selector is its polyline's
    # arc-length middle, with the body it belongs to
    edge = query_geometry(box, [{"kind": "edge", "body": "body1",
                                 "sel": {"kind": "edge", "by": "nearest", "point": [55, 5, 7.5], "body": "body1"}}],
                          prefix=True)["results"][0]
    assert edge["ok"], edge
    sel = {**edge["entities"][0]["sel"], "body": edge["entities"][0]["body"]}
    assert sel["by"] == "match", "a click must never be stored as a point"
    fp = sel["fp"]
    along = sum((corner[i] - fp["mid"][i]) * fp["dir"][i] for i in range(3))
    end = 1 if along > 0 else 0
    face = query_geometry(box, [{"kind": "face", "body": "body1",
                                 "sel": {"kind": "face", "by": "nearest", "point": [51, 2, 15], "body": "body1"}}],
                          prefix=True)["results"][0]
    assert face["ok"], face
    top = {**face["entities"][0]["sel"], "body": face["entities"][0]["body"]}
    # one extrude from the sketch up to the corner, one starting from the face
    for h in (15.0, 27.0):
        _p, errors, bodies = _build(_box(h) + [
            _sq(),
            _ext(upToRef={"kind": "vertex", "edge": sel, "end": end}),
            {"id": "e2", "type": "extrude", "sketch": "s1", "distance": 3, "operation": "new",
             "startFrom": {"kind": "face", "face": top}},
        ])
        assert not errors, f"box {h}: {errors}"
        assert _zspan(bodies, "body2") == (0.0, h), f"corner target, box {h}: {_zspan(bodies, 'body2')}"
        assert _zspan(bodies, "body3") == (h, h + 3), f"face start, box {h}: {_zspan(bodies, 'body3')}"


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
    test_up_to_an_origin_plane()
    test_up_to_a_sketch_point_follows_the_point()
    test_sketch_point_indices_match_the_app()
    test_shape_points_the_picker_offers_build()
    test_a_shape_side_is_a_line()
    test_up_to_a_line_parallel_to_the_sketch()
    test_up_to_a_body_edge_follows_the_body()
    test_up_to_a_body_corner()
    test_edge_end_ignores_the_kernels_orientation()
    test_start_from_a_face_follows_the_face()
    test_start_from_a_tilted_or_curved_face_is_refused()
    test_start_from_a_plane()
    test_start_from_a_point_and_up_to_a_line_compose()
    test_start_and_end_references_that_are_gone()
    test_one_target_at_a_time()
    test_the_app_authored_references_build_and_follow()
    print("ALL PASS")
