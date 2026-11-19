"""A sweep whose profile reaches past a bend in its path is refused, by name.

Field report 995a4717 (a table-saw miter head): a rail profile reached 3.01 mm
toward the inside of two 2.03 mm arcs in its path. Past the bend's centre line
the inner part of the profile comes back on itself, so the swept solid FOLDS,
and OCCT calls the folded solid valid. Nothing said a word until a later Join
left the body's top face with a crossed outline that could not be meshed: the
3MF came out with 671 open edges and PrusaSlicer called the part non-manifold.

Pinned by what the user gets back from a rebuild: the sweep's error and its
text, or a built body, never by which helper was called.

Run:  uv run python test_sweep_fold.py
"""

import math

from builder import rebuild

PASS = "✓"


def _line(eid, p, q):
    return {"id": eid, "type": "line", "x1": p[0], "y1": p[1], "x2": q[0], "y2": q[1]}


def _bend_path(radius):
    """On XY: 20 mm along +X, a quarter arc of `radius` turning LEFT (its centre
    on the +Y side), then 20 mm along +Y. The inside of the bend is +Y."""
    a = math.radians(-45)
    mid = (20 + radius * math.cos(a), radius + radius * math.sin(a))
    end = (20 + radius, radius)
    return {"id": "path", "type": "sketch", "plane": "XY", "entities": [
        _line("e1", (0, 0), (20, 0)),
        {"id": "e2", "type": "arc", "x1": 20, "y1": 0, "mx": mid[0], "my": mid[1],
         "x2": end[0], "y2": end[1]},
        _line("e3", end, (end[0], end[1] + 20))]}


def _band_profile(y0, y1):
    """A 2 mm tall band on YZ (the plane the path starts in) from world Y=y0 to
    Y=y1: how far it reaches toward the inside of the bend is max(y1, 0)."""
    return {"id": "prof", "type": "sketch", "plane": "YZ", "entities": [
        _line("p1", (y0, -1), (y1, -1)),
        _line("p2", (y1, -1), (y1, 1)),
        _line("p3", (y1, 1), (y0, 1)),
        _line("p4", (y0, 1), (y0, -1))]}


def _tip_profile(tip):
    """A triangle on YZ whose point reaches world Y=`tip` toward the inside of
    the bend, its flat side at Y=-1. A POINT reaching past the bend is the
    report's shape and the dangerous one: OCCT calls that fold valid, where a
    flat side reaching past it comes back invalid and was already refused."""
    return {"id": "prof", "type": "sketch", "plane": "YZ", "entities": [
        _line("p1", (-1, -1), (tip, 0)),
        _line("p2", (tip, 0), (-1, 1)),
        _line("p3", (-1, 1), (-1, -1))]}


def _doc(profile, path):
    return {"parameters": {}, "features": [
        profile, path,
        {"id": "sw", "type": "sweep", "profile": "prof", "path": "path",
         "operation": "new"}]}


def _sweep_error(err):
    return next((e for e in err if e.get("feature_id") == "sw"), None)


def test_a_profile_reaching_past_the_bend_is_refused_and_says_how_to_fix_it():
    """A point reaching 3 mm inside a 2 mm bend: the case from the report, small.

    RED before the fix: a body of volume 170.472 that OCCT calls valid, and no
    error at all."""
    part, err, bodies = rebuild(_doc(_tip_profile(3), _bend_path(2.0)))
    e = _sweep_error(err)
    assert e is not None, (
        f"a folding sweep built a body with no error: "
        f"{[(round(b['shape'].volume, 3), b['shape'].is_valid) for b in bodies]}")
    msg = str(e.get("message"))
    assert "fold" in msg, msg
    assert "3.00 mm" in msg and "2.00 mm bend" in msg, (
        f"the message must name the reach and the bend: {msg}")
    assert "more than 3.00 mm" in msg, f"the message must say what radius works: {msg}"
    assert not bodies, f"a refused sweep must not leave a body: {bodies}"
    print(f"{PASS} a point reaching 3 mm inside a 2 mm bend is refused: {msg[:90]}...")


def test_a_flat_side_reaching_past_the_bend_is_refused_the_same_way():
    """The kernel already rejected this one, with a message that named neither
    the bend nor a radius that would work."""
    part, err, bodies = rebuild(_doc(_band_profile(-1, 3), _bend_path(1.5)))
    msg = str((_sweep_error(err) or {}).get("message"))
    assert "1.50 mm bend" in msg and "more than 3.00 mm" in msg, msg
    print(f"{PASS} a flat side reaching past a 1.5 mm bend names the bend too")


def test_the_same_profile_round_a_wide_enough_bend_builds():
    part, err, bodies = rebuild(_doc(_tip_profile(3), _bend_path(3.5)))
    assert not err, err
    assert len(bodies) == 1 and bodies[0]["shape"].is_valid
    assert bodies[0]["shape"].volume > 2 * 40, bodies[0]["shape"].volume
    print(f"{PASS} the same profile round a 3.5 mm bend builds: vol "
          f"{bodies[0]['shape'].volume:.3f}")


def test_reaching_far_to_the_OUTSIDE_of_a_bend_is_not_a_fold():
    """3 mm out, 0.5 mm in, round a 1.5 mm bend: only the inside can fold."""
    part, err, bodies = rebuild(_doc(_band_profile(-3, 0.5), _bend_path(1.5)))
    assert not err, err
    assert len(bodies) == 1 and bodies[0]["shape"].is_valid
    print(f"{PASS} a profile wide on the outside of a tight bend still builds")


def test_a_path_of_straight_lines_is_never_refused():
    """Sharp corners are the transition's job (RIGHT mitres them), not a fold."""
    path = {"id": "path", "type": "sketch", "plane": "XY", "entities": [
        _line("e1", (0, 0), (20, 0)), _line("e2", (20, 0), (20, 20))]}
    part, err, bodies = rebuild(_doc(_band_profile(-1, 3), path))
    assert not _sweep_error(err), err
    assert len(bodies) == 1
    print(f"{PASS} a straight-line path with a sharp corner is not refused")


if __name__ == "__main__":
    test_a_profile_reaching_past_the_bend_is_refused_and_says_how_to_fix_it()
    test_a_flat_side_reaching_past_the_bend_is_refused_the_same_way()
    test_the_same_profile_round_a_wide_enough_bend_builds()
    test_reaching_far_to_the_OUTSIDE_of_a_bend_is_not_a_fold()
    test_a_path_of_straight_lines_is_never_refused()
    print("\nall sweep fold tests passed")
