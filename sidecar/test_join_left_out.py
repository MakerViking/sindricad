"""A join that leaves some of the user's pieces out says so. Run:
    cd sidecar && .venv/bin/python test_join_left_out.py

Field report 9728490b: a Combine joined 135 small ribs onto a knob, 66 of them
floated 0.1 to 14 microns off it, and the debris pass in `_unify_body` deleted
those 66 with no word said (it drops a floating solid under 0.1% of the biggest
piece). The geometry is unchanged by this work; what is new is a WARNING
diagnostic, `joinPiecesLeftOut`, on the feature that did it, counting the pieces
the user could see go in (the target's and the tools' alike) that went. The reporter's own document is replayed in the change's
notes; nothing from it is committed here.

Entered where the user enters: a rebuild of a document holding the features
the app writes, judged on what the feature reports and on the bodies it left.
Every count has a CONTROL that the count could have got wrong.
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("SINDRI_DISK_CACHE", "0")

FAILED = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILED.append(label)


import builder  # noqa: E402

CODE = "joinPiecesLeftOut"
BOX = 40 * 40 * 10  # 16,000 mm3; the debris rule's 0.1% of it is 16 mm3
PIN = math.pi * 1 ** 2 * 2  # r 1, h 2: 6.28 mm3, under that 0.1%


def rebuild(features):
    diag = []
    _part, errs, bodies = builder.rebuild({"parameters": {}, "features": features}, diagnostics=diag)
    return errs, bodies, diag


def warnings(diag, fid=None):
    return [d for d in diag if d.get("code") == CODE and (fid is None or d.get("feature_id") == fid)]


def volume(body):
    return builder._as_compound(body["shape"]).volume


def solids(body):
    return len(builder._as_compound(body["shape"]).solids())


# --- fixtures -------------------------------------------------------------------
# Primitives are CENTRED: the 40 x 40 x 10 box spans z -5..5, a 2 mm tall pin
# spans z -1..1, so a pin moved up 6 stands exactly on the box's top face.

def box():
    return {"id": "bx", "type": "box", "length": 40, "width": 40, "height": 10}


def pin(fid, body, x, dz, radius=1, y=0):
    return [{"id": fid, "type": "cylinder", "radius": radius, "height": 2},
            {"id": f"m{fid}", "type": "move", "bodies": [body], "dx": x, "dy": y, "dz": dz,
             "rx": 0, "ry": 0, "rz": 0}]


def join(fid, target, tools):
    return {"id": fid, "type": "combine", "operation": "join", "target": target, "tools": tools}


# --- Combine ----------------------------------------------------------------------

def test_a_combine_says_how_many_pieces_it_left_out():
    # One pin standing on the box, one 0.01 mm above it: the floating one goes.
    errs, bodies, diag = rebuild([box(), *pin("pa", "body2", -10, 6), *pin("pb", "body3", 10, 6.01),
                                  join("j", "body1", ["body2", "body3"])])
    check("the join builds, into one body", not errs and len(bodies) == 1, (errs, len(bodies)))
    check("the floating pin is gone and the standing one joined (the geometry this change does not touch)",
          abs(volume(bodies[0]) - (BOX + PIN)) < 1e-6 and solids(bodies[0]) == 1,
          (volume(bodies[0]), solids(bodies[0])))
    w = warnings(diag, "j")
    check("one warning on the Combine, saying 1 piece was left out of body1",
          len(w) == 1 and w[0]["count"] == 1 and w[0]["body_id"] == "body1" and w[0]["kind"] == CODE, w)
    check("...a WARNING (it carries a reason, so the chip is amber) that says 'the joined body', never a name",
          w and "the joined body" in w[0]["reason"] and "does not touch it" in w[0]["reason"]
          and "{body}" not in w[0]["reason"] and "Box" not in w[0]["reason"]
          and w[0]["subject"] == "Box" and w[0]["lossy"] is False, w)

    # CONTROL: both pins standing on the box. Nothing is left out, nothing said.
    errs, bodies, diag = rebuild([box(), *pin("pa", "body2", -10, 6), *pin("pb", "body3", 10, 6),
                                  join("j", "body1", ["body2", "body3"])])
    check("control: every piece touches, so no warning",
          not errs and not warnings(diag) and abs(volume(bodies[0]) - (BOX + 2 * PIN)) < 1e-6,
          (errs, warnings(diag), volume(bodies[0])))


def test_it_counts_the_pieces_not_the_lumps_they_make():
    # Two floating pins that overlap EACH OTHER but not the box come out of the
    # fuse as ONE floating lump. The user joined two pieces and lost two.
    errs, bodies, diag = rebuild([box(), *pin("pa", "body2", 10, 6.5), *pin("pb", "body3", 11, 6.5),
                                  join("j", "body1", ["body2", "body3"])])
    w = warnings(diag, "j")
    check("two overlapping floating pins, one lump: 2 pieces left out",
          not errs and len(w) == 1 and w[0]["count"] == 2 and abs(volume(bodies[0]) - BOX) < 1e-6,
          (errs, w, volume(bodies[0])))


def test_a_chip_already_in_the_target_is_not_one_of_the_pieces():
    # A tube (r 2 around a r 0.5 bore) cut through the box leaves a 0.5 mm pin
    # of the box standing loose in the bore: a chip in the TARGET, 7.85 mm3.
    # The same debris pass the join runs drops it, and it is not a piece the
    # user was joining, so it must not be counted.
    seen = []
    real = builder._join_left_out_diag

    def spy(diag, feature_id, body, pieces, dropped):
        seen.append((feature_id, len(dropped)))
        return real(diag, feature_id, body, pieces, dropped)

    tube = [{"id": "c1", "type": "cylinder", "radius": 2, "height": 20},
            {"id": "c2", "type": "cylinder", "radius": 0.5, "height": 20},
            {"id": "t", "type": "combine", "operation": "cut", "target": "body2", "tools": ["body3"]},
            {"id": "mt", "type": "move", "bodies": ["body2"], "dx": 15, "dy": 15, "dz": 0,
             "rx": 0, "ry": 0, "rz": 0},
            {"id": "cut", "type": "combine", "operation": "cut", "target": "body1", "tools": ["body2"]}]
    builder._join_left_out_diag = spy
    try:
        errs, bodies, diag = rebuild([box(), *tube, *pin("pa", "body4", -10, 6),
                                      join("j", "body1", ["body4"])])
    finally:
        builder._join_left_out_diag = real
    check("precondition: the join's debris pass really dropped something (the chip)",
          ("j", 1) in seen, seen)
    check("...and the join says nothing: the chip was the target's, not a piece being joined",
          not errs and not warnings(diag), (errs, warnings(diag)))


def tube_into(target, at, n0):
    """A tube (r 2 around a r 0.5 bore) of bodies n0 and n0+1, cut through `target`
    at x = `at`: it leaves a 0.5 mm pin of the target loose in the bore, 7.85 mm3."""
    tube, bore = f"body{n0}", f"body{n0 + 1}"
    return [{"id": "c1", "type": "cylinder", "radius": 2, "height": 20},
            {"id": "c2", "type": "cylinder", "radius": 0.5, "height": 20},
            {"id": "t", "type": "combine", "operation": "cut", "target": tube, "tools": [bore]},
            {"id": "mt", "type": "move", "bodies": [tube], "dx": at, "dy": 0, "dz": 0,
             "rx": 0, "ry": 0, "rz": 0},
            {"id": "tc", "type": "combine", "operation": "cut", "target": target, "tools": [tube]}]


def test_a_chip_the_tool_body_never_showed_is_not_counted():
    # The same chip, in the TOOL this time: a second 40 x 40 x 10 box that
    # overlaps the first. 7.85 mm3 is under 0.1% of the tool's 16,000, so the
    # tool body never showed it, and the join drops it. Nothing the user saw
    # went, so nothing is said.
    head = [box(), {"id": "b2", "type": "box", "length": 40, "width": 40, "height": 10},
            {"id": "m2", "type": "move", "bodies": ["body2"], "dx": 30, "dy": 0, "dz": 0,
             "rx": 0, "ry": 0, "rz": 0}, *tube_into("body2", 40, 3)]
    errs, bodies, _diag = rebuild(head)
    check("precondition: the tool body shows one solid, the chip hidden",
          not errs and [solids(b) for b in bodies] == [1, 1], (errs, [solids(b) for b in bodies]))
    errs, bodies, diag = rebuild([*head, join("j", "body1", ["body2"])])
    check("a chip the tool body never showed is not counted",
          not errs and not warnings(diag) and len(bodies) == 1, (errs, warnings(diag), len(bodies)))

    # CONTROL: a 20 x 20 x 10 tool. 7.85 mm3 is over 0.1% of its 4,000, so the
    # tool body SHOWS the chip as a solid of its own, and the join drops it.
    head = [box(), {"id": "b2", "type": "box", "length": 20, "width": 20, "height": 10},
            {"id": "m2", "type": "move", "bodies": ["body2"], "dx": 25, "dy": 0, "dz": 0,
             "rx": 0, "ry": 0, "rz": 0}, *tube_into("body2", 30, 3)]
    errs, bodies, _diag = rebuild(head)
    check("control precondition: the small tool body shows the chip, 2 solids",
          not errs and [solids(b) for b in bodies] == [1, 2], (errs, [solids(b) for b in bodies]))
    errs, bodies, diag = rebuild([*head, join("j", "body1", ["body2"])])
    w = warnings(diag, "j")
    check("control: a chip the tool body showed, and the join dropped, is 1 piece left out",
          not errs and len(w) == 1 and w[0]["count"] == 1 and solids(bodies[0]) == 1, (errs, w))


def test_a_target_piece_that_goes_is_counted():
    # The target is the small one: a pin, joined with a box that floats 15 mm
    # over it. The pin is under 0.1% of the box, so the body named Cylinder
    # comes out as the box alone. The user's own target went.
    errs, bodies, diag = rebuild([*pin("p", "body1", 0, 0), box(),
                                  {"id": "m", "type": "move", "bodies": ["body2"], "dx": 0, "dy": 0,
                                   "dz": 20, "rx": 0, "ry": 0, "rz": 0},
                                  join("j", "body1", ["body2"])])
    w = warnings(diag, "j")
    check("the target pin went from its own body: 1 piece left out, on body1",
          not errs and len(bodies) == 1 and abs(volume(bodies[0]) - BOX) < 1e-6
          and len(w) == 1 and w[0]["count"] == 1 and w[0]["body_id"] == "body1",
          (errs, len(bodies), volume(bodies[0]) if bodies else None, w))
    # The result keeps the target's name, Cylinder: the very piece that went.
    # "does not touch Cylinder" told the user the pin did not touch itself.
    check("...and its sentence does not say the piece fails to touch the body named after it",
          w and w[0]["subject"] == "Cylinder" and "Cylinder" not in w[0]["reason"]
          and "{body}" not in w[0]["reason"] and "the joined body" in w[0]["reason"], w)


def test_a_part_of_a_body_imported_whole_is_counted():
    # An import kept whole keeps every solid it declared, however small, so the
    # final pass shows a 1.1 mm cube floating beside the box (1.331 mm3, under
    # 0.1%). The join's pass drops it. The user saw it, so it is counted, where
    # the same cube left by a cut would be a hidden chip and not counted.
    from build123d import Box, Compound, Pos

    whole = Compound([Box(40, 40, 10), Pos(30, 0, 0) * Box(1.1, 1.1, 1.1)])
    imp = {"id": "imp", "type": "import", "format": "step", "name": "Cover",
           "brep": builder._shape_to_brep_b64(whole), "explode": False}
    errs, bodies, _diag = rebuild([imp])
    check("precondition: the body imported whole shows both solids",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 2, (errs, [solids(b) for b in bodies]))
    errs, bodies, diag = rebuild([imp, *pin("pa", "body2", -10, 6), join("j", "body1", ["body2"])])
    w = warnings(diag, "j")
    check("the import's own small part went in the join: 1 piece left out",
          not errs and solids(bodies[0]) == 1 and len(w) == 1 and w[0]["count"] == 1,
          (errs, solids(bodies[0]) if bodies else None, w))


# --- the join-mode features (extrude here; revolve/sweep/loft/thicken share the path)

def sketch_on_top(fid, rects):
    return {"id": fid, "type": "sketch",
            "plane": {"origin": [0, 0, 5], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
            "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": 0}
                         for (x, w, h) in rects]}


def test_an_extrude_join_says_so_too():
    # A 2 x 2 square on the box's top face and a 1 x 1 square beyond its edge,
    # extruded 1 mm as a Join: the far cube touches nothing and is 1 mm3.
    errs, bodies, diag = rebuild([box(), sketch_on_top("s", [(0, 2, 2), (30, 1, 1)]),
                                  {"id": "e", "type": "extrude", "sketch": "s", "distance": 1,
                                   "operation": "join"}])
    w = warnings(diag, "e")
    check("an extrude Join that leaves its far square out says 1 piece, on the extrude",
          not errs and len(w) == 1 and w[0]["count"] == 1 and w[0]["body_id"] == bodies[0]["id"]
          and abs(volume(bodies[0]) - (BOX + 4)) < 1e-6, (errs, w, volume(bodies[0])))

    # CONTROL, the debris rule's own line: a 3 x 3 x 2 far block is 18 mm3, over
    # 0.1% of the box, so the join KEEPS it as a solid of its own. Not left out.
    errs, bodies, diag = rebuild([box(), sketch_on_top("s", [(0, 2, 2), (30, 3, 3)]),
                                  {"id": "e", "type": "extrude", "sketch": "s", "distance": 2,
                                   "operation": "join"}])
    check("control: a floating piece big enough to keep stays in the body, and nothing is said",
          not errs and not warnings(diag) and solids(bodies[0]) == 2, (errs, warnings(diag), solids(bodies[0])))


def test_an_extrude_join_that_takes_a_whole_body_says_so():
    # A pin body floats 0.3 mm over the box, between two squares extruded as
    # one Join. The prism's box overlaps the pin's, which is enough to fuse the
    # pin in; it touches nothing, so it goes, and a whole body leaves the
    # Browser.
    head = [box(), {"id": "p", "type": "cylinder", "radius": 0.5, "height": 2},
            {"id": "mp", "type": "move", "bodies": ["body2"], "dx": 0, "dy": 0, "dz": 6.3,
             "rx": 0, "ry": 0, "rz": 0}]
    errs, bodies, _diag = rebuild(head)
    check("precondition: the pin is a body of its own", not errs and len(bodies) == 2, (errs, len(bodies)))
    errs, bodies, diag = rebuild([*head, sketch_on_top("s", [(-10, 2, 2), (10, 2, 2)]),
                                  {"id": "e", "type": "extrude", "sketch": "s", "distance": 3,
                                   "operation": "join"}])
    w = warnings(diag, "e")
    check("the pin body went in the Join extrude, and it says 1 piece was left out",
          not errs and len(bodies) == 1 and abs(volume(bodies[0]) - (BOX + 24)) < 1e-6
          and len(w) == 1 and w[0]["count"] == 1 and w[0]["body_id"] == bodies[0]["id"],
          (errs, len(bodies), w))


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(name)
            fn()
    print()
    if FAILED:
        print(f"FAILED {len(FAILED)}:")
        for f in FAILED:
            print("  -", f)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
