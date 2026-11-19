"""A boolean that goes wrong never takes the user's material with it.

Field report 995a4717 turned up two ways it could:

1. A Join onto a body an earlier cut had left invalid came back from the kernel
   EMPTY, with no error, and the empty shape was committed: the user's main
   body was gone. A union holds at least the biggest thing in it, so a Join
   that comes back smaller now fails, naming itself, and changes nothing.
2. `_serial_bool`'s tidy-up (ShapeUpgrade_UnifySameDomain) can throw part way
   ("Courbes non jointives") after it has already rewritten edges it was
   handed. Those edges belonged to the boolean's raw result, which shares them
   with the INPUT body, so the body before the boolean was damaged too. The
   tidy-up now works on a copy.

The kernel's misbehaviour is injected (it cannot be summoned on a small part);
everything else runs where the user's rebuild runs.

Run:  uv run python test_join_lost_material.py
"""

import builder
from builder import rebuild

PASS = "✓"


def _box_sketch(sid, x, w=10):
    return {"id": sid, "type": "sketch", "plane": "XY",
            "entities": [{"type": "rectangle", "width": w, "height": w, "x": x, "y": 0}]}


def _two_boxes_joined():
    return {"parameters": {}, "features": [
        _box_sketch("s1", 0), {"id": "x1", "type": "extrude", "sketch": "s1", "distance": 10,
                               "operation": "new"},
        _box_sketch("s2", 8), {"id": "x2", "type": "extrude", "sketch": "s2", "distance": 10,
                               "operation": "new"},
        {"id": "j", "type": "combine", "target": "body1", "tools": ["body2"],
         "operation": "join"},
    ]}


def _extrude_join():
    return {"parameters": {}, "features": [
        _box_sketch("s1", 0), {"id": "x1", "type": "extrude", "sketch": "s1", "distance": 10,
                               "operation": "new"},
        _box_sketch("s2", 8), {"id": "x2", "type": "extrude", "sketch": "s2", "distance": 10,
                               "operation": "join"},
    ]}


class _EmptyFuse:
    """`_serial_bool` with every FUSE coming back empty, as the kernel did."""

    def __enter__(self):
        self.real = builder._serial_bool

        def fake(base, tool, kind):
            if kind == "fuse":
                from build123d import Compound
                return Compound([])
            return self.real(base, tool, kind)

        builder._serial_bool = fake
        return self

    def __exit__(self, *exc):
        builder._serial_bool = self.real


def test_a_combine_join_that_comes_back_empty_fails_and_keeps_the_body():
    """RED before the fix: no error, and body1 committed with volume 0."""
    with _EmptyFuse():
        _, err, bodies = rebuild(_two_boxes_joined())
    e = next((e for e in err if e.get("feature_id") == "j"), None)
    assert e is not None, f"an emptied Join raised nothing: {[(b['id'], b['shape'].volume) for b in bodies]}"
    assert "could not merge" in str(e.get("message")), e
    vols = sorted(round(b["shape"].volume, 3) for b in bodies)
    assert vols == [1000.0, 1000.0], f"the failed Join must change nothing: {vols}"
    print(f"{PASS} an emptied Combine Join fails by name and both bodies survive")


def test_an_extrude_join_that_comes_back_empty_fails_and_keeps_the_body():
    with _EmptyFuse():
        _, err, bodies = rebuild(_extrude_join())
    e = next((e for e in err if e.get("feature_id") == "x2"), None)
    assert e is not None, f"an emptied extrude Join raised nothing: {[b['shape'].volume for b in bodies]}"
    assert "could not merge" in str(e.get("message")), e
    assert [round(b["shape"].volume, 3) for b in bodies] == [1000.0], bodies
    print(f"{PASS} an emptied extrude Join fails by name and the body survives")


def test_a_real_join_still_joins():
    _, err, bodies = rebuild(_two_boxes_joined())
    assert not err, err
    assert [round(b["shape"].volume, 3) for b in bodies] == [1800.0], bodies
    print(f"{PASS} an ordinary Join still merges: vol 1800")


def test_a_tidy_up_that_throws_half_way_leaves_the_input_body_alone():
    """RED before the fix: the input box's edges came back with the tolerance the
    failed tidy-up wrote into them."""
    import OCP.ShapeUpgrade as su
    from OCP.BRep import BRep_Builder, BRep_Tool
    from build123d import Box, Pos

    real = su.ShapeUpgrade_UnifySameDomain

    class Throws:
        def __init__(self, shape, *a):
            self.shape = shape

        def AllowInternalEdges(self, *a):
            pass

        def Build(self):
            from OCP.TopExp import TopExp_Explorer
            from OCP.TopAbs import TopAbs_EDGE
            from OCP.TopoDS import TopoDS
            ex = TopExp_Explorer(self.shape, TopAbs_EDGE)
            while ex.More():
                BRep_Builder().UpdateEdge(TopoDS.Edge_s(ex.Current()), 0.5)
                ex.Next()
            raise RuntimeError("Courbes non jointives")

    base = Box(10, 10, 10)
    tool = Pos(8, 0, 0) * Box(10, 2, 2)
    su.ShapeUpgrade_UnifySameDomain = Throws
    try:
        out = builder._serial_bool(builder._as_compound(base), builder._as_compound(tool), "cut")
    finally:
        su.ShapeUpgrade_UnifySameDomain = real
    worst = max(BRep_Tool.Tolerance_s(e.wrapped) for e in base.edges())
    assert worst < 1e-3, f"the failed tidy-up rewrote the INPUT body's edges: tol {worst}"
    assert out.volume > 0 and abs(out.volume - (1000 - 2 * 2 * 2)) < 1e-6, out.volume
    print(f"{PASS} a tidy-up that throws leaves the input body untouched (tol {worst:.0e})")


if __name__ == "__main__":
    test_a_combine_join_that_comes_back_empty_fails_and_keeps_the_body()
    test_an_extrude_join_that_comes_back_empty_fails_and_keeps_the_body()
    test_a_real_join_still_joins()
    test_a_tidy_up_that_throws_half_way_leaves_the_input_body_alone()
    print("\nall join lost-material tests passed")
