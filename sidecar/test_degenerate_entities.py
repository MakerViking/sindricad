"""A degenerate line/arc/spline must name itself instead of failing as StdFail.

Run: uv run python test_degenerate_entities.py

Field report 88042d97 (0.1.150). The reporter saw one profile and two symptoms:
"This sketch appears to me to be a closed profile, but the error message says it
is incomplete" and "I cannot rotate it about the X". Both are the same bug: the
sketch never built, so all five revolves and the extrude reported only that
their sketch was missing — seven errors from one cause, and the one at the root
said *"sketch failed (StdFail_NotDone)"*, which names neither the entity nor
anything the reporter could do about it.

The entity was `e34`, a line whose two ends are the same point. It draws nothing
(its polyline is one point twice), so there was nothing wrong to see. The
document's own `regionEntities` proves the frontend had already excluded it from
the profile the reporter picked, so the two halves disagreed: the frontend shaded
a closed region the sidecar refused to build.

`_build_sketch` had a guard block for exactly this ("catch degenerate primitives
HERE, by name") that covered only circle and rectangle. The geometry below is the
reporter's own, verbatim from their document.

`test_the_kernels_own_boundaries` is the load-bearing test in this file: every
number the guard compares against is asserted there AGAINST THE KERNEL, so a
comment in builder.py that claims a measurement cannot drift away from the truth
without a failure here. A first cut of this guard asserted three such thresholds
in prose and got all three wrong; that test is the answer to it.
"""

import inspect
import math
import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

from build123d import Edge  # noqa: E402

from builder import _entity_edges, rebuild  # noqa: E402

PASS = "  ok"

# f1's entity list, verbatim from the reporter's document. e34 is the
# zero-length line; e43 is a 0x0 rectangle (already guarded, and the reason
# their document needs TWO deletions before it builds).
REPORTER_ENTITIES = [
    {'id': 'e8', 'x1': 1.561681435589968, 'x2': 23.825199999999995, 'y1': -153.98749999999995, 'y2': -153.98749999999998, 'type': 'line'},
    {'id': 'e9', 'x1': 25.4, 'x2': 25.4, 'y1': 0, 'y2': -152.41269999999997, 'type': 'line'},
    {'id': 'e10', 'x1': 25.4, 'x2': 27.8003, 'y1': 0, 'y2': 0, 'type': 'line'},
    {'id': 'e11', 'x1': 27.8003, 'x2': 27.80030000000001, 'y1': 0, 'y2': -152.4254, 'type': 'line'},
    {'id': 'e12', 'x1': 23.81250000000001, 'x2': 1.5621000000000156, 'y1': -156.4132, 'y2': -156.4132, 'type': 'line'},
    {'id': 'e30', 'x1': -2.4256999999999778, 'x2': -2.4256999999999844, 'y1': -38.75230351802513, 'y2': -152.4254, 'type': 'line'},
    {'id': 'e32', 'x1': -2.8869482409874028, 'x2': -5.139870323422605, 'y1': -37.63875175901256, 'y2': -35.38582967657735, 'type': 'line'},
    {'id': 'e33', 'x1': -5.60111856441003, 'x2': -5.60111856441003, 'y1': -31.749581435589928, 'y2': -34.27227791756478, 'type': 'line'},
    {'id': 'e34', 'x1': -5.60111856441003, 'x2': -5.60111856441003, 'y1': -31.749581435589928, 'y2': -31.749581435589928, 'type': 'line'},
    {'id': 'e37', 'x1': -5.60111856441003, 'x2': -2.4261185644100305, 'y1': -31.749581435589928, 'y2': -31.749581435589928, 'type': 'line'},
    {'id': 'e38', 'x1': -2.4261185644100305, 'x2': -2.42611856441003, 'y1': -31.749581435589928, 'y2': -25.39958143558993, 'type': 'line'},
    {'id': 'e40', 'x1': -0.013118564410030231, 'x2': -0.013118564410030231, 'y1': -25.39958143558993, 'y2': -152.41269999999994, 'type': 'line'},
    {'id': 'e42', 'x1': -2.42611856441003, 'x2': -0.013118564410030231, 'y1': -25.39958143558993, 'y2': -25.39958143558993, 'type': 'line'},
    {'x': -5, 'y': -35, 'id': 'e43', 'type': 'rectangle', 'width': 0, 'height': 0},
    {'id': 'e44', 'mx': -2.5455745122007363, 'my': -38.14965364873637, 'x1': -2.4256999999999778, 'x2': -2.8869482409874028, 'y1': -38.75230351802513, 'y2': -37.63875175901256, 'type': 'arc'},
    {'id': 'e45', 'mx': -5.481244052208842, 'my': -34.874927786853334, 'x1': -5.139870323422605, 'x2': -5.60111856441003, 'y1': -35.38582967657735, 'y2': -34.27227791756478, 'type': 'arc'},
    {'id': 'e46', 'mx': 0.4481296765787446, 'my': -153.5262517590114, 'x1': -0.013118564410030231, 'x2': 1.561681435589968, 'y1': -152.41269999999994, 'y2': -153.98749999999995, 'type': 'arc'},
    {'id': 'e47', 'mx': 24.93875175901015, 'my': -153.52625175900863, 'x1': 25.4, 'x2': 23.825199999999995, 'y1': -152.41269999999997, 'y2': -153.98749999999998, 'type': 'arc'},
    {'id': 'e48', 'mx': 26.632300422016066, 'my': -155.2452004220162, 'x1': 23.81250000000001, 'x2': 27.80030000000001, 'y1': -156.4132, 'y2': -152.4254, 'type': 'arc'},
    {'id': 'e49', 'mx': -1.2577004220156691, 'my': -155.24520042201578, 'x1': -2.4256999999999844, 'x2': 1.5621000000000156, 'y1': -152.4254, 'y2': -156.4132, 'type': 'arc'},
]

# The five revolves and the extrude that follow it, also verbatim.
REPORTER_DOWNSTREAM = [
    {'id': 'f2', 'axis': 'X', 'type': 'revolve', 'angle': 360, 'sketch': 'f1', 'operation': 'new'},
    {'id': 'f3', 'axis': 'X', 'type': 'revolve', 'angle': 360, 'sketch': 'f1', 'operation': 'new'},
    {'id': 'f4', 'axis': 'X', 'type': 'revolve', 'angle': 360, 'sketch': 'f1', 'operation': 'join'},
    {'id': 'f5', 'axis': 'X', 'type': 'revolve', 'angle': 360, 'sketch': 'f1', 'operation': 'new'},
    {'id': 'f6', 'axis': 'Y', 'type': 'revolve', 'angle': 360, 'sketch': 'f1', 'operation': 'new'},
    {'id': 'f7', 'type': 'extrude', 'sketch': 'f1', 'regions': [[-1.471262605825638, -34.16366660745166, 0]],
     'distance': 25.4, 'operation': 'new', 'hiddenBodies': [],
     'regionEntities': [['e10', 'e11', 'e12', 'e30', 'e32', 'e33', 'e37', 'e38', 'e40', 'e42',
                         'e44', 'e45', 'e46', 'e47', 'e48', 'e49', 'e8', 'e9']],
     'regionHoleEntities': [[['e43']]]},
]

# Every OCCT/build123d class name that has reached a user through this path. A
# message containing one of these is the bug, whatever else it says.
RAW_CLASSES = ("StdFail", "Standard_ConstructionError", "Standard_Failure",
               "BRep_API", "GC_Make")


def _doc(entities, downstream=()):
    return {"features": [{"id": "f1", "type": "sketch", "plane": "XY",
                          "entities": list(entities)}, *downstream]}


def _sketch_error(entities):
    """The message f1 reports, or None if the sketch built."""
    _part, errors, _bodies = rebuild(_doc(entities))
    for e in errors:
        if e.get("feature_id") == "f1":
            return e.get("message")
    return None


def _square(size=10.0, oid="s"):
    """Four lines that close a square — a profile that builds on its own, so any
    failure in a test below belongs to the entity added beside it."""
    h = size / 2
    c = [(-h, -h), (h, -h), (h, h), (-h, h)]
    return [{"type": "line", "id": f"{oid}{k}", "x1": c[k][0], "y1": c[k][1],
             "x2": c[(k + 1) % 4][0], "y2": c[(k + 1) % 4][1]} for k in range(4)]


def _kernel_builds_real_geometry(entity):
    """What OCCT does with one entity with no guard in front of it: True when it
    hands back edges that all have real extent.

    The oracle every threshold in the guard is judged against. An edge of length
    0.0 does NOT count as built: the kernel returns those silently (measured in
    test_the_kernels_own_boundaries), and they are exactly what the guard exists
    to name.
    """
    try:
        eds = _entity_edges(entity, lambda v: v)
    except Exception:
        return False
    return bool(eds) and all(ed.length > 0.0 for ed in eds)


def _expect_raise(fn, cls, what):
    """`fn()` must raise OCCT's `cls`. Returns the exception, for the callers
    that also care about its message."""
    try:
        fn()
    except Exception as ex:
        assert type(ex).__name__ == cls, f"{what}: expected {cls}, got {ex!r}"
        return ex
    raise AssertionError(f"{what}: expected {cls}, but it built")


# --------------------------------------------------------------------------
# the kernel's own boundaries — every number the guard uses is pinned here
# --------------------------------------------------------------------------

def test_the_kernels_own_boundaries():
    """Each threshold the guard compares against, measured against THIS kernel.

    Values come from a log sweep of 1e-3 → 0.0 on each shape plus a bisection of
    each boundary at five different sizes; the assertions below are that sweep's
    endpoints. If OCCT or build123d moves one of them, this fails before the
    guard starts refusing (or leaking) the wrong geometry.
    """
    # LINE. Above Precision::Confusion (1e-7) OCCT builds the line and the edge
    # has its real length. BELOW it OCCT does not refuse either — it accepts the
    # line and quietly hands back an edge whose length is exactly 0.0, all the
    # way down. It raises at only two points in the whole range: exactly at
    # Confusion, and exactly coincident (which is the reporter's own case —
    # their line's two ends are the SAME float). Bisected at x = 0.1, 1, 10, 100
    # and 1000 the flip lands on 1e-7 to seven figures every time, so this one
    # is an absolute distance and `<= 1e-7` covers every value the kernel will
    # not give extent.
    assert Edge.make_line((0, 0, 0), (1.1e-7, 0, 0)).length == 1.1e-7
    assert Edge.make_line((0, 0, 0), (9.9e-8, 0, 0)).length == 0.0
    assert Edge.make_line((0, 0, 0), (1e-12, 0, 0)).length == 0.0
    for L in (1e-7, 0.0):
        _expect_raise(lambda L=L: Edge.make_line((0, 0, 0), (L, 0, 0)),
                      "StdFail_NotDone", f"a line of length {L:g}")

    # SPLINE. The boundary is build123d's OWN default interpolation tolerance,
    # not an OCCT constant: a consecutive gap of exactly 1e-6 builds and
    # anything under it raises. Bisected at spans of 0.1 → 1000 mm it is the
    # same absolute 1e-6 every time, so it is a gap and not a ratio.
    assert inspect.signature(Edge.make_spline).parameters["tol"].default == 1e-6, \
        "build123d changed make_spline's default tol — _SPLINE_MIN_GAP must follow it"
    assert Edge.make_spline([(0, 0, 0), (1e-6, 0, 0), (10, 5, 0)]).length > 0
    for D in (9.9e-7, 5e-7, 1e-8, 0.0):
        ex = _expect_raise(lambda D=D: Edge.make_spline([(0, 0, 0), (D, 0, 0), (10, 5, 0)]),
                           "Standard_ConstructionError", f"a spline gap of {D:g}")
        # and this is why it was the worst of the three: no message at all
        assert str(ex).strip() == "", repr(str(ex))

    # ARC. Unlike the other two, this boundary is RELATIVE — a fixed fraction of
    # the chord — so no constant can express it. Bisected on chords of 0.1, 1,
    # 10, 100 and 1000 mm, the smallest sagitta that builds is 3.7252903e-9 *
    # chord to seven figures at every scale. That is why the guard does not try
    # to predict this one at all.
    for chord in (0.1, 1.0, 10.0, 100.0, 1000.0):
        built = Edge.make_three_point_arc(
            (0, 0, 0), (chord / 2, 4e-9 * chord, 0), (chord, 0, 0))
        assert math.isclose(built.length, chord, rel_tol=1e-6), (chord, built.length)
        _expect_raise(
            lambda chord=chord: Edge.make_three_point_arc(
                (0, 0, 0), (chord / 2, 3e-9 * chord, 0), (chord, 0, 0)),
            "StdFail_NotDone", f"sagitta 3e-9 * {chord:g}")
    print(PASS, "the kernel's line, spline and arc boundaries are where the guard says")


# --------------------------------------------------------------------------
# the field report
# --------------------------------------------------------------------------

def test_the_reporters_zero_length_line_names_itself():
    msg = _sketch_error(REPORTER_ENTITIES)
    assert msg, "the reporter's sketch is expected to fail — it has two degenerate entities"
    # what the reporter actually saw, and the whole reason they could see nothing wrong
    assert not any(c in msg for c in RAW_CLASSES), f"raw OCCT class reached the user: {msg!r}"
    assert "line" in msg, f"the message must name the entity kind: {msg!r}"
    # e34's own coordinates, so a user with 20 entities can find the invisible one
    assert "-5.60112" in msg and "-31.7496" in msg, \
        f"the message must locate the entity: {msg!r}"
    print(PASS, "the reporter's zero-length line names itself and its location")


def test_the_reporters_document_builds_once_every_message_is_followed():
    """The acceptance test for the whole report: do what each error says, in
    turn, and the document must reach a state where it builds.

    Naming the FIRST bad entity is not enough. The reporter would have deleted
    e34, hit the next error and been stuck again — that one is a 0x0 rectangle,
    just as invisible as the line, so it needs its location for exactly the same
    reason. Nothing here may be satisfied by a message the reporter cannot act
    on.
    """
    remaining = list(REPORTER_ENTITIES)
    followed = []
    for _step in range(4):
        msg = _sketch_error(remaining)
        if msg is None:
            break
        assert not any(c in msg for c in RAW_CLASSES), \
            f"after deleting {followed}, the next error is still raw: {msg!r}"
        # every message must be actionable on its own: kind, place, what to do
        assert any(k in msg for k in ("line", "arc", "spline", "circle", "rectangle")), msg
        assert "delete" in msg, f"no repair offered: {msg!r}"
        if "line" in msg:
            assert "-5.60112" in msg and "-31.7496" in msg, msg
            victim = "e34"
        elif "rectangle" in msg:
            # e43 sits at (-5, -35) and draws nothing; without those numbers the
            # message sends the reporter hunting through 19 other entities
            assert "-5" in msg and "-35" in msg, \
                f"the rectangle message must locate the entity: {msg!r}"
            victim = "e43"
        else:
            raise AssertionError(f"unexpected error in this document: {msg!r}")
        followed.append(victim)
        remaining = [e for e in remaining if e["id"] != victim]
    else:
        raise AssertionError(f"the document never stopped erroring (deleted {followed})")

    assert followed == ["e34", "e43"], followed
    print(PASS, f"following each message in turn ({' then '.join(followed)}) makes the sketch build")


def test_the_reporters_seven_errors_are_one_cause():
    """Every downstream failure was "your sketch did not build" — fix the sketch
    and all six come back. The reporter read that as a revolve bug ("I cannot
    rotate it about the X"); it was never a revolve bug."""
    _part, errors, _bodies = rebuild(_doc(REPORTER_ENTITIES, REPORTER_DOWNSTREAM))
    assert len(errors) == 7, f"expected the whole timeline to die with f1, got {errors}"
    assert all(e.get("feature_id") == "f1" or "did not build" in (e.get("message") or "")
               for e in errors), errors

    # delete the two degenerate entities and the same document builds: the three
    # X-axis revolves that make new bodies all succeed, and so does the extrude.
    healthy = [e for e in REPORTER_ENTITIES if e["id"] not in ("e34", "e43")]
    _part, errors, bodies = rebuild(_doc(healthy, REPORTER_DOWNSTREAM))
    assert len(bodies) == 4, f"expected 4 bodies, got {len(bodies)}: {errors}"
    # Two features still fail, and that is the point: they are the reporter's own
    # modelling problems (f4 joins into material that is already there, f6
    # revolves about Y and the profile crosses that axis), each with a message
    # that says so. Not one of them is the sketch cascade any more.
    assert {e["feature_id"] for e in errors} == {"f4", "f6"}, errors
    assert not any("did not build" in (e.get("message") or "") for e in errors), errors
    print(PASS, "seven errors are one cause: removing the two degenerate entities builds 4 bodies")


# --------------------------------------------------------------------------
# per-shape behaviour
# --------------------------------------------------------------------------

def test_a_degenerate_arc_names_itself():
    # collinear: OCCT has no circumcircle to build the arc on (measured on this
    # tree: GC_MakeArcOfCircle::Value() - no result)
    msg = _sketch_error([*_square(), {"type": "arc", "id": "a1", "x1": 20, "y1": 0,
                                      "mx": 25, "my": 0, "x2": 30, "y2": 0}])
    assert msg and not any(c in msg for c in RAW_CLASSES), f"collinear arc: {msg!r}"
    assert "arc" in msg and "20" in msg, f"collinear arc must name+locate itself: {msg!r}"

    # Ends in the same place with the through-point elsewhere: refused for a
    # different reason (there is no arc through it, only a whole circle).
    msg = _sketch_error([*_square(), {"type": "arc", "id": "a2", "x1": 20, "y1": 3,
                                      "mx": 25, "my": 8, "x2": 20, "y2": 3}])
    assert msg and not any(c in msg for c in RAW_CLASSES), f"coincident arc: {msg!r}"
    assert "arc" in msg and "20" in msg, f"coincident arc must name+locate itself: {msg!r}"

    # A BIG arc, because the kernel's boundary is a fraction of the chord and
    # not a constant: 1e-6 of bulge is comfortable on a 10 mm chord and refused
    # on a 1000 mm one. A fixed 1e-7 threshold let this exact case through as
    # "sketch failed (StdFail_NotDone)".
    msg = _sketch_error([*_square(size=4000), {"type": "arc", "id": "a3", "x1": 0, "y1": 0,
                                               "mx": 500, "my": 1e-6, "x2": 1000, "y2": 0}])
    assert msg and not any(c in msg for c in RAW_CLASSES), f"1000 mm chord arc: {msg!r}"
    assert "arc" in msg, f"1000 mm chord arc must name itself: {msg!r}"
    print(PASS, "a collinear, coincident-point or barely-bulging arc names itself at any scale")


def test_a_degenerate_spline_names_itself():
    # Standard_ConstructionError with an EMPTY message, so the user saw
    # "sketch failed (Standard_ConstructionError)" — worse than the line case.
    msg = _sketch_error([*_square(), {"type": "spline", "id": "sp1", "points": [
        {"x": 20, "y": 0}, {"x": 20, "y": 0}, {"x": 30, "y": 5}]}])
    assert msg and not any(c in msg for c in RAW_CLASSES), f"repeated spline point: {msg!r}"
    assert "spline" in msg and "20" in msg, f"spline must name+locate itself: {msg!r}"

    # 5e-7 apart: visually one point, and well inside the band the kernel
    # refuses (anything under 1e-6). A 1e-7 threshold missed this entirely.
    msg = _sketch_error([*_square(), {"type": "spline", "id": "sp2", "points": [
        {"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1 + 5e-7, "y": 0}, {"x": 5, "y": 2}]}])
    assert msg and not any(c in msg for c in RAW_CLASSES), f"5e-7 spline gap: {msg!r}"
    assert "spline" in msg, f"5e-7 spline gap must name itself: {msg!r}"
    print(PASS, "a spline with a repeated or near-repeated point names itself")


def test_the_guard_never_refuses_geometry_the_kernel_builds():
    """The control, as a differential test rather than a list of blessed values.

    A guard that refused everything would pass every test above. The rule this
    file holds it to instead: **if OCCT builds edges with real extent, the
    sketch must build; if it does not, the message must name the entity.** The
    fixtures walk each shape from a decade above its boundary to a decade below,
    at three different sizes for the arc, so a threshold on the wrong side of
    the kernel shows up here either as a refusal of geometry OCCT was happy with
    or as a raw class name.
    """
    fixtures = []
    for L in (1e-4, 1e-5, 1e-6, 2e-7, 1e-7, 9.9e-8, 1e-9, 0.0):
        fixtures.append((f"a line of length {L:g}",
                         {"type": "line", "id": "t", "x1": 20, "y1": 0,
                          "x2": 20 + L, "y2": 0}, 80.0))
    for chord in (1.0, 10.0, 1000.0):
        for mult in (1e3, 1e1, 1.0, 0.5, 1e-1, 0.0):  # multiples of the 3.7e-9 * chord boundary
            s = 3.7252903e-9 * chord * mult
            fixtures.append((f"an arc bulging {s:g} off a {chord:g} mm chord",
                             {"type": "arc", "id": "t", "x1": 0, "y1": 0, "mx": chord / 2,
                              "my": s, "x2": chord, "y2": 0}, chord * 4))
    for D in (1e-3, 1e-5, 2e-6, 1e-6, 9.9e-7, 1e-8, 0.0):
        fixtures.append((f"a spline whose points are {D:g} apart",
                         {"type": "spline", "id": "t", "points": [
                             {"x": 20, "y": 0}, {"x": 20 + D, "y": 0}, {"x": 30, "y": 5}]}, 80.0))
    # polygon and slot have no threshold of their own and never did; they are
    # here because the kernel-refusal backstop covers every kind, so the same
    # rule has to hold for them.
    #
    # NOT here: a polygon or slot small enough that every one of its edges comes
    # back with length 0.0 but the profile still builds (radius 1e-9, say). That
    # is the OPEN item in docs/EDGE-CASES.md §1 — the same thing an r=1e-9
    # circle does — and closing it means choosing a minimum-feature size, which
    # is a product decision this fix deliberately does not make.
    for r in (2.0, 0.0):
        fixtures.append((f"a hexagon of radius {r:g}",
                         {"type": "polygon", "id": "t", "x": 20, "y": 3,
                          "radius": r, "sides": 6}, 80.0))
    for w in (2.0, 0.0):
        fixtures.append((f"a slot {w:g} wide",
                         {"type": "slot", "id": "t", "x1": 20, "y1": 0,
                          "x2": 30, "y2": 0, "width": w}, 80.0))

    refused = []
    for label, entity, size in fixtures:
        msg = _sketch_error([*_square(size=size), entity])
        if _kernel_builds_real_geometry(entity):
            assert msg is None, f"{label} builds in OCCT but the guard refused it: {msg!r}"
        else:
            assert msg is not None, f"{label} does not build in OCCT but the sketch passed"
            assert not any(c in msg for c in RAW_CLASSES), \
                f"{label}: raw class reached the user: {msg!r}"
            # one dash, not two: the advice must read as a single sentence
            assert msg.count("—") == 1, f"{label}: message reads as two: {msg!r}"
            refused.append(label)
    # a floor, so a guard that quietly stopped firing cannot pass this test
    assert len(refused) >= 12, f"only {len(refused)} fixtures exercised the guard: {refused}"
    print(PASS, f"{len(fixtures) - len(refused)} kernel-buildable fixtures still build; "
                f"{len(refused)} degenerate ones are named, none raw")


def test_the_guard_leaves_the_rest_of_the_sketch_alone():
    ok = [
        # a spline may legitimately return to an earlier point (a closed loop);
        # only CONSECUTIVE repeats are what the kernel cannot interpolate
        ("a spline that revisits its first point",
         [{"type": "spline", "id": "t4", "points": [{"x": 20, "y": 0},
                                                    {"x": 30, "y": 5},
                                                    {"x": 20, "y": 0}]}]),
        # construction geometry never reaches the profile builder, so a
        # degenerate one must not fail the sketch either
        ("a zero-length CONSTRUCTION line",
         [{"type": "line", "id": "t5", "construction": True, "x1": 20, "y1": 0,
           "x2": 20, "y2": 0}]),
        # ordinary geometry, to prove the block is not simply refusing arcs
        ("a normal 5 mm arc",
         [{"type": "arc", "id": "t6", "x1": 20, "y1": 0, "mx": 22.5, "my": 2.5,
           "x2": 25, "y2": 0}]),
    ]
    for label, extra in ok:
        msg = _sketch_error([*_square(), *extra])
        assert msg is None, f"{label} must still build, got {msg!r}"
    print(PASS, "closed splines, construction geometry and ordinary arcs are untouched")


def main():
    print("Degenerate sketch-entity tests (field report 88042d97)")
    test_the_kernels_own_boundaries()
    test_the_reporters_zero_length_line_names_itself()
    test_the_reporters_document_builds_once_every_message_is_followed()
    test_the_reporters_seven_errors_are_one_cause()
    test_a_degenerate_arc_names_itself()
    test_a_degenerate_spline_names_itself()
    test_the_guard_never_refuses_geometry_the_kernel_builds()
    test_the_guard_leaves_the_rest_of_the_sketch_alone()
    print("ALL PASS")


if __name__ == "__main__":
    main()
