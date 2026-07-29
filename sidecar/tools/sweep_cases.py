"""Edge-case sweep for the SindriCAD geometry sidecar.

Runs ONE case per invocation, by name, and prints a single JSON line. The runner
(sweep_run.py) invokes this in a SUBPROCESS per case, because the failure mode we
most care about — an OCCT segfault — kills the interpreter outright and would
otherwise take the whole sweep with it. Exit 139 (SIGSEGV) is a RESULT here, not
an accident.

Usage:  PYTHONPATH=<sidecar> python sweep_cases.py <case-name>
        PYTHONPATH=<sidecar> python sweep_cases.py --list
"""
import json
import sys

# --- document builders -------------------------------------------------------


def box(bid="b", l=20, w=20, h=20):
    return {"id": bid, "type": "box", "length": l, "width": w, "height": h}


def cyl(bid="c", r=10, h=20):
    return {"id": bid, "type": "cylinder", "radius": r, "height": h}


def sk_circle(sid="s", r=10, plane="XY"):
    return {"id": sid, "type": "sketch", "plane": plane,
            "entities": [{"type": "circle", "id": "e1", "x": 0, "y": 0, "radius": r}]}


def sk_rect(sid="s", w=20, h=20, plane="XY"):
    return {"id": sid, "type": "sketch", "plane": plane,
            "entities": [{"type": "rectangle", "id": "e1", "width": w, "height": h, "x": 0, "y": 0}]}


def doc(*features):
    return {"parameters": {}, "features": list(features)}


# --- cases -------------------------------------------------------------------
# Each entry: name -> (document, note). The note records what the case is probing
# so a failure is self-explaining in the report.

CASES = {}


def case(name, note):
    def wrap(fn):
        CASES[name] = (fn, note)
        return fn
    return wrap


# --- primitives: degenerate dimensions ---
@case("box-zero-height", "a box with one dimension 0 — degenerate solid")
def _(): return doc(box(h=0))


@case("box-negative", "a box with a negative dimension")
def _(): return doc(box(l=-20))


@case("box-tiny", "0.001mm box — below typical OCCT tolerance (1e-7 m)")
def _(): return doc(box(l=0.001, w=0.001, h=0.001))


@case("box-huge", "10km box — far outside printable range")
def _(): return doc(box(l=10_000_000, w=10, h=10))


@case("cylinder-zero-radius", "zero-radius cylinder")
def _(): return doc(cyl(r=0))


@case("cylinder-negative-radius", "negative radius")
def _(): return doc(cyl(r=-5))


# --- fillet / chamfer: radius vs feature size ---
@case("fillet-radius-equals-half-edge", "fillet exactly half the edge — tangency")
def _(): return doc(box(l=20, w=20, h=20),
                    {"id": "f", "type": "fillet", "radius": 10,
                     "edges": {"kind": "edge", "by": "all"}})


@case("fillet-radius-too-big", "fillet larger than the body — impossible")
def _(): return doc(box(l=20, w=20, h=20),
                    {"id": "f", "type": "fillet", "radius": 50,
                     "edges": {"kind": "edge", "by": "all"}})


@case("fillet-zero", "zero-radius fillet — no-op or error?")
def _(): return doc(box(), {"id": "f", "type": "fillet", "radius": 0,
                            "edges": {"kind": "edge", "by": "all"}})


@case("fillet-negative", "negative fillet radius")
def _(): return doc(box(), {"id": "f", "type": "fillet", "radius": -3,
                            "edges": {"kind": "edge", "by": "all"}})


@case("fillet-then-fillet-same-edges", "filleting already-filleted edges")
def _(): return doc(box(),
                    {"id": "f1", "type": "fillet", "radius": 3, "edges": {"kind": "edge", "by": "all"}},
                    {"id": "f2", "type": "fillet", "radius": 1, "edges": {"kind": "edge", "by": "all"}})


@case("chamfer-too-big", "chamfer larger than the body")
def _(): return doc(box(), {"id": "c", "type": "chamfer", "distance": 40,
                            "edges": {"kind": "edge", "by": "all"}})


# --- shell ---
@case("shell-thickness-exceeds-body", "shell wall thicker than the solid")
def _(): return doc(box(), {"id": "s", "type": "shell", "thickness": 30})


@case("shell-zero", "zero wall thickness")
def _(): return doc(box(), {"id": "s", "type": "shell", "thickness": 0})


@case("shell-negative", "negative thickness — outward shell")
def _(): return doc(box(), {"id": "s", "type": "shell", "thickness": -2})


# --- extrude ---
@case("extrude-zero", "zero-distance extrude — degenerate")
def _(): return doc(sk_rect(), {"id": "e", "type": "extrude", "sketch": "s",
                                "distance": 0, "operation": "new"})


@case("extrude-missing-sketch", "extrude referencing a sketch that never built")
def _(): return doc({"id": "e", "type": "extrude", "sketch": "nope",
                     "distance": 10, "operation": "new"})


@case("extrude-cut-nothing", "cut where there is no material — no-op boolean")
def _(): return doc(box(), sk_rect("s", 5, 5),
                    {"id": "e", "type": "extrude", "sketch": "s", "distance": -0.0001,
                     "operation": "cut"})


# --- press/pull: the known crash family ---
@case("presspull-through-cut", "cut deeper than the material — through-cut")
def _(): return doc(box(l=20, w=20, h=10),
                    {"id": "p", "type": "press-pull", "distance": -50, "operation": "cut",
                     "face": {"kind": "face", "by": "nearest", "point": [0, 0, 5]}})


@case("presspull-cut-tangent-to-fillet", "cut ending exactly on a fillet tangency")
def _(): return doc(box(l=20, w=20, h=10),
                    {"id": "f", "type": "fillet", "radius": 3, "edges": {"kind": "edge", "by": "all"}},
                    {"id": "p", "type": "press-pull", "distance": -3, "operation": "cut",
                     "face": {"kind": "face", "by": "nearest", "point": [0, 0, 5]}})


@case("presspull-zero", "zero-distance press/pull")
def _(): return doc(box(),
                    {"id": "p", "type": "press-pull", "distance": 0, "operation": "cut",
                     "face": {"kind": "face", "by": "nearest", "point": [0, 0, 10]}})


# --- booleans ---
@case("combine-disjoint", "union of two bodies that do not touch")
def _(): return doc(box("b1", 10, 10, 10), box("b2", 10, 10, 10),
                    {"id": "m", "type": "move", "dx": 500},
                    {"id": "cb", "type": "combine", "operation": "join",
                     "bodies": ["body1", "body2"]})


@case("combine-identical", "union of two identical coincident bodies")
def _(): return doc(box("b1"), box("b2"),
                    {"id": "cb", "type": "combine", "operation": "join",
                     "bodies": ["body1", "body2"]})


@case("combine-subtract-self", "subtracting a body from itself")
def _(): return doc(box("b1"), box("b2"),
                    {"id": "cb", "type": "combine", "operation": "cut",
                     "bodies": ["body1", "body2"]})


# --- patterns / transforms ---
@case("pattern-count-zero", "rectangular pattern with count 0")
def _(): return doc(box(), {"id": "p", "type": "patternRect", "countX": 0, "countY": 1,
                            "spacingX": 30, "spacingY": 30})


@case("pattern-count-huge", "1000-instance pattern — resource blowup")
def _(): return doc(box(l=1, w=1, h=1),
                    {"id": "p", "type": "patternRect", "countX": 1000, "countY": 1,
                     "spacingX": 2, "spacingY": 2})


@case("pattern-overlapping", "pattern spacing smaller than the body — overlaps")
def _(): return doc(box(l=20, w=20, h=20),
                    {"id": "p", "type": "patternRect", "countX": 5, "countY": 1,
                     "spacingX": 1, "spacingY": 30})


@case("scale-zero", "scale factor 0 — collapse to a point")
def _(): return doc(box(), {"id": "s", "type": "scale", "factor": 0})


@case("scale-negative", "negative scale — mirror through origin")
def _(): return doc(box(), {"id": "s", "type": "scale", "factor": -1})


@case("mirror-on-own-plane", "mirroring a body across a plane it sits on")
def _(): return doc(box(), {"id": "m", "type": "mirror", "plane": "XY"})


# --- revolve ---
@case("revolve-360", "full revolution")
def _(): return doc(sk_rect("s", 5, 20, "XZ"),
                    {"id": "r", "type": "revolve", "sketch": "s", "angle": 360, "axis": "Z"})


@case("revolve-over-360", "angle greater than a full turn — self-overlap")
def _(): return doc(sk_rect("s", 5, 20, "XZ"),
                    {"id": "r", "type": "revolve", "sketch": "s", "angle": 720, "axis": "Z"})


@case("revolve-zero", "zero-angle revolve")
def _(): return doc(sk_rect("s", 5, 20, "XZ"),
                    {"id": "r", "type": "revolve", "sketch": "s", "angle": 0, "axis": "Z"})


@case("revolve-profile-crosses-axis", "profile straddling the axis — self-intersecting")
def _(): return doc(sk_rect("s", 40, 20, "XZ"),
                    {"id": "r", "type": "revolve", "sketch": "s", "angle": 360, "axis": "Z"})


# --- split / draft ---
@case("split-plane-misses-body", "split by a plane that does not intersect")
def _(): return doc(box(),
                    {"id": "d", "type": "datumPlane", "plane": "XY", "offset": 500},
                    {"id": "sp", "type": "split", "planeId": "d", "keep": "both"})


@case("draft-90-degrees", "90-degree draft — degenerate taper")
def _(): return doc(box(), {"id": "d", "type": "draft", "angle": 90, "axis": "Z",
                            "faces": {"kind": "face", "by": "normal", "dir": [1, 0, 0]}})


@case("draft-over-90", "draft beyond vertical")
def _(): return doc(box(), {"id": "d", "type": "draft", "angle": 120, "axis": "Z",
                            "faces": {"kind": "face", "by": "normal", "dir": [1, 0, 0]}})


# --- sketch pathologies ---
@case("sketch-self-intersecting", "figure-eight profile — self-intersecting wire")
def _(): return doc(
    {"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"type": "line", "id": "l1", "x1": 0, "y1": 0, "x2": 20, "y2": 20},
        {"type": "line", "id": "l2", "x1": 20, "y1": 20, "x2": 20, "y2": 0},
        {"type": "line", "id": "l3", "x1": 20, "y1": 0, "x2": 0, "y2": 20},
        {"type": "line", "id": "l4", "x1": 0, "y1": 20, "x2": 0, "y2": 0}]},
    {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"})


@case("sketch-zero-radius-circle", "a circle of radius 0")
def _(): return doc(sk_circle("s", 0),
                    {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"})


@case("sketch-duplicate-entities", "two identical coincident circles")
def _(): return doc(
    {"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"type": "circle", "id": "e1", "x": 0, "y": 0, "radius": 10},
        {"type": "circle", "id": "e2", "x": 0, "y": 0, "radius": 10}]},
    {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"})


@case("sketch-empty", "a sketch with no entities")
def _(): return doc({"id": "s", "type": "sketch", "plane": "XY", "entities": []},
                    {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"})


@case("sketch-nested-rings", "three concentric circles — nested holes")
def _(): return doc(
    {"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"type": "circle", "id": "e1", "x": 0, "y": 0, "radius": 30},
        {"type": "circle", "id": "e2", "x": 0, "y": 0, "radius": 20},
        {"type": "circle", "id": "e3", "x": 0, "y": 0, "radius": 10}]},
    {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"})


# --- thicken / offsetFace ---
@case("thicken-huge", "thicken far beyond the surface extent")
def _(): return doc(box(), {"id": "t", "type": "thicken", "thickness": 500})


@case("offsetface-inward-collapse", "offsetting a face inward past the body")
def _(): return doc(box(l=20, w=20, h=20),
                    {"id": "o", "type": "offsetFace", "distance": -30,
                     "faces": {"kind": "face", "by": "nearest", "point": [0, 0, 10]}})


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        for name, (_fn, note) in CASES.items():
            print(f"{name}\t{note}")
        return 0
    name = sys.argv[1]
    fn, note = CASES[name]
    from builder import rebuild
    d = fn()
    part, errs, bodies = rebuild(d)
    print(json.dumps({
        "case": name,
        "note": note,
        "errors": [e.get("message", "") for e in (errs or [])],
        "bodies": len(bodies) if bodies else 0,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
