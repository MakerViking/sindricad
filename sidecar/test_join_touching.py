"""A join takes in only what it touches, and keeps every piece it was given. Run:
    cd sidecar && .venv/bin/python test_join_touching.py

Two field reports, one rule, stamped on new features as `joinTouchingOnly`:

- TA 8c510bd3 / GH #41: a lip joined under a lid took in the box it sits 0.2 mm
  inside, because Join picked its bodies by bounding box alone, and welded the
  lid onto the box. Now a Join or Intersect acts only on the bodies the solid
  really touches or overlaps.
- TA 9728490b: a Combine joined 135 ribs onto a knob and 66 of them, floating
  microns off it, were deleted as debris. Now a join keeps every piece it was
  given; one that touches nothing it joins stays in the body as a piece of its
  own, and a warning, `joinPiecesApart`, says how many.

A feature without the stamp, every feature in a document saved before this,
builds exactly as it did: wherever the stamp changes the result, a CONTROL
builds the same features unstamped and gets what the old rule gives. Entered
where the user enters: a rebuild of the features the app writes, judged on the
bodies it leaves and what the feature reports.
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

APART = "joinPiecesApart"
LEFT_OUT = "joinPiecesLeftOut"
BOX = 40 * 40 * 10  # 16,000 mm3; the debris rule's 0.1% of it is 16 mm3
PIN = math.pi * 1 ** 2 * 2  # r 1, h 2: 6.28 mm3, under that 0.1%


def rebuild(features):
    diag = []
    _part, errs, bodies = builder.rebuild({"parameters": {}, "features": features}, diagnostics=diag)
    return errs, bodies, diag


def coded(diag, code, fid=None):
    return [d for d in diag if d.get("code") == code and (fid is None or d.get("feature_id") == fid)]


def volume(body):
    return builder._as_compound(body["shape"]).volume


def solids(body):
    return len(builder._as_compound(body["shape"]).solids())


def z_span(body):
    bb = builder._as_compound(body["shape"]).bounding_box()
    return (round(bb.min.Z, 6), round(bb.max.Z, 6))


def stamp(f, on):
    return {**f, "joinTouchingOnly": True} if on else f


# --- fixtures -------------------------------------------------------------------
# Primitives are CENTRED: the 40 x 40 x 10 box spans z -5..5, a 2 mm tall pin
# spans z -1..1, so a pin moved up 6 stands exactly on the box's top face.

def box():
    return {"id": "bx", "type": "box", "length": 40, "width": 40, "height": 10}


def pin(fid, body, x, dz, radius=1, y=0):
    return [{"id": fid, "type": "cylinder", "radius": radius, "height": 2},
            {"id": f"m{fid}", "type": "move", "bodies": [body], "dx": x, "dy": y, "dz": dz,
             "rx": 0, "ry": 0, "rz": 0}]


def combine(fid, target, tools, on, op="join"):
    return stamp({"id": fid, "type": "combine", "operation": op, "target": target, "tools": tools}, on)


def sketch_at(fid, z, rects):
    return {"id": fid, "type": "sketch",
            "plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
            "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}
                         for (x, y, w, h) in rects]}


def extrude(fid, sketch, op, dist, on, **more):
    # What the extrude tool writes on a new feature (extrudeTool.ts commit).
    return stamp({"id": fid, "type": "extrude", "sketch": sketch, "distance": dist, "operation": op,
                  "hiddenBodies": [], "separateBodies": True, **more}, on)


# --- the reported case: a lid with a lip, from one sketch (TA 8c510bd3) ----------
# Box walls between 60 x 40 and 56 x 36, a lip ring between 55.6 x 35.6 and
# 51.6 x 31.6: 0.2 mm clear of the walls all round. Box: a 2 mm floor and walls
# to z 30, 15,552 mm3. Lid: 2 mm of the whole outline, 4,800 mm3. Lip: 2 mm of
# the ring, 697.6 mm3.

LID_RECTS = [(60, 40), (56, 36), (55.6, 35.6), (51.6, 31.6)]
WALL, GAP, LIP, INNER = [29, 0, 0], [27.9, 0, 0], [26.8, 0, 0], [0, 0, 0]


def lid_with_lip(lid_at, lip_at, on):
    return [{"id": "s1", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "id": f"r{i}", "width": w, "height": h, "x": 0, "y": 0}
                          for i, (w, h) in enumerate(LID_RECTS)]},
            extrude("floor", "s1", "new", 2, on, regions=[WALL, GAP, LIP, INNER]),
            extrude("walls", "s1", "join", 28, on, regions=[WALL], startOffset=2),
            extrude("lid", "s1", "new", 2, on, regions=[WALL, GAP, LIP, INNER], startOffset=lid_at),
            extrude("lip", "s1", "join", 2, on, regions=[LIP], startOffset=lip_at)]


def test_a_lip_joined_to_a_lid_leaves_the_box_alone():
    for label, lid_at, lip_at in (("seated on the box", 30, 28), ("floating over it", 32, 30)):
        errs, bodies, _ = rebuild(lid_with_lip(lid_at, lip_at, True))
        got = [(round(volume(b), 1), solids(b), z_span(b)) for b in bodies]
        check(f"lid {label}: the box and the lid with its lip are two bodies",
              not errs and got == [(15552.0, 1, (0.0, 30.0)), (5497.6, 1, (lip_at, lid_at + 2.0))],
              (errs, got))

        # CONTROL: the same features saved before the stamp. The lip's box
        # meets the box's, so the box is taken in: one body.
        errs, bodies, _ = rebuild(lid_with_lip(lid_at, lip_at, False))
        got = [(round(volume(b), 1), solids(b)) for b in bodies]
        check(f"control, lid {label}: unstamped, the box is welded in as it always was",
              not errs and got == [(21049.6, 1 if lid_at == 30 else 2)], (errs, got))


# --- the rule: touching or overlapping, nothing less, nothing more --------------

def test_a_join_that_bridges_two_bodies_still_merges_them():
    # Two boxes 10 mm apart, and a 30 x 10 bar sketched on their top faces.
    head = [box(), {"id": "b2", "type": "box", "length": 40, "width": 40, "height": 10},
            {"id": "m2", "type": "move", "bodies": ["body2"], "dx": 50, "dy": 0, "dz": 0,
             "rx": 0, "ry": 0, "rz": 0}]
    errs, bodies, diag = rebuild([*head, sketch_at("s", 5, [(25, 0, 30, 10)]),
                                  extrude("e", "s", "join", 3, True)])
    check("a bar standing on both boxes joins them into one solid",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 1
          and abs(volume(bodies[0]) - (2 * BOX + 900)) < 1e-6 and not coded(diag, APART),
          (errs, len(bodies), [solids(b) for b in bodies]))


def test_a_boss_on_a_face_joins_by_touching():
    errs, bodies, diag = rebuild([box(), sketch_at("s", 5, [(0, 0, 4, 4)]),
                                  extrude("e", "s", "join", 3, True)])
    check("a boss that only touches the face it stands on joins the body",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 1
          and abs(volume(bodies[0]) - (BOX + 48)) < 1e-6 and not coded(diag, APART),
          (errs, len(bodies)))


def test_a_tenth_of_a_micron_is_a_gap():
    # The ribs of 9728490b floated 0.1 to 14 microns off the knob. The same
    # lid, with a lip 0.1 micron clear of the walls instead of 0.2 mm: the lip
    # still does not touch the box, so the box stays out of the join.
    def rects(fid, sizes):
        return {"id": fid, "type": "sketch", "plane": "XY",
                "entities": [{"type": "rectangle", "width": w, "height": h, "x": 0, "y": 0} for w, h in sizes]}

    lip_outer = (55.9998, 35.9998)
    feats = [rects("sb", [(60, 40), (56, 36)]), rects("sl", [(60, 40)]), rects("sp", [lip_outer, (51.6, 31.6)]),
             extrude("floor", "sb", "new", 2, True, regions=[[29, 0, 0], [0, 0, 0]]),
             extrude("walls", "sb", "join", 28, True, regions=[[29, 0, 0]], startOffset=2),
             extrude("lid", "sl", "new", 2, True, startOffset=30)]
    lip = (lip_outer[0] * lip_outer[1] - 51.6 * 31.6) * 2
    for on in (True, False):
        errs, bodies, _ = rebuild([*feats, extrude("lip", "sp", "join", 2, on, regions=[[26.89995, 0, 0]],
                                                   startOffset=28)])
        got = [round(volume(b), 3) for b in bodies]
        want = [15552.0, round(4800 + lip, 3)] if on else [round(15552 + 4800 + lip, 3)]
        check("a lip 0.1 micron clear of the walls joins the lid alone" if on
              else "control: unstamped, the box is welded in", not errs and got == want, (errs, got, want))


def test_a_join_buried_in_a_body_is_still_refused():
    # Boundaries 3 mm apart and no contact, but the prism is INSIDE the box:
    # the kernel's distance is boundary to boundary and says 3.
    errs, bodies, _ = rebuild([box(), sketch_at("s", 0, [(0, 0, 4, 4)]),
                               extrude("e", "s", "join", 2, True)])
    check("a Join wholly inside the body says it added nothing, not a new body inside it",
          len(errs) == 1 and "already inside" in errs[0].get("message", "") and len(bodies) == 1,
          (errs, len(bodies)))


def test_a_body_the_join_swallows_is_joined():
    # A pin floating inside the space a boss extrude fills: no contact, but the
    # pin is inside the prism, so the join takes it in.
    errs, bodies, _ = rebuild([box(), *pin("p", "body2", 0, 7, radius=0.5),
                               sketch_at("s", 5, [(0, 0, 4, 4)]),
                               extrude("e", "s", "join", 5, True)])
    check("a body wholly inside the new solid becomes part of the join",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 1
          and abs(volume(bodies[0]) - (BOX + 80)) < 1e-6,
          (errs, len(bodies), [round(volume(b), 3) for b in bodies]))


def test_an_intersect_leaves_a_body_it_does_not_touch_alone():
    # A 10 x 10 column through the box, and a thin pin standing by its corner:
    # the pin's box meets the column's, the pin does not.
    head = [box(), *pin("p", "body2", 5.4, 0, radius=0.5, y=5.4),
            sketch_at("s", -10, [(0, 0, 10, 10)])]
    errs, bodies, _ = rebuild([*head, extrude("e", "s", "intersect", 30, True)])
    vols = sorted(round(volume(b), 3) for b in bodies)
    check("the box keeps only the column's part of it and the pin is untouched",
          not errs and vols == [round(math.pi * 0.25 * 2, 3), 1000.0], (errs, vols))

    # CONTROL: unstamped, the pin's box is enough to make it a target, and the
    # Intersect refuses because it would empty the pin.
    errs, bodies, _ = rebuild([*head, extrude("e", "s", "intersect", 30, False)])
    check("control: unstamped, the Intersect refuses over the pin it does not touch",
          len(errs) == 1 and "leave the body empty" in errs[0].get("message", ""), errs)


# --- every piece kept: the Combine of 9728490b, and a Join's far piece ----------

def test_a_combine_keeps_a_piece_that_does_not_touch():
    # One pin standing on the box, one 0.01 mm above it.
    feats = [box(), *pin("pa", "body2", -10, 6), *pin("pb", "body3", 10, 6.01)]
    errs, bodies, diag = rebuild([*feats, combine("j", "body1", ["body2", "body3"], True)])
    w = coded(diag, APART, "j")
    check("the floating pin stays in the body as a piece of its own, through the final pass",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 2
          and abs(volume(bodies[0]) - (BOX + 2 * PIN)) < 1e-6,
          (errs, len(bodies), [solids(b) for b in bodies]))
    check("one warning on the Combine: 1 piece of the join does not touch the rest of body1",
          len(w) == 1 and w[0]["count"] == 1 and w[0]["body_id"] == "body1" and w[0]["kind"] == APART
          and "{body}" in w[0]["reason"] and w[0]["subject"] == "Box" and w[0]["lossy"] is False
          and not coded(diag, LEFT_OUT), w)

    # CONTROL: unstamped, the old rule deletes it and says so (joinPiecesLeftOut).
    errs, bodies, diag = rebuild([*feats, combine("j", "body1", ["body2", "body3"], False)])
    check("control: unstamped, the floating pin is dropped as it always was, and that is said",
          not errs and solids(bodies[0]) == 1 and abs(volume(bodies[0]) - (BOX + PIN)) < 1e-6
          and len(coded(diag, LEFT_OUT, "j")) == 1 and not coded(diag, APART),
          (errs, solids(bodies[0]), coded(diag, LEFT_OUT)))

    # CONTROL: both pins standing. Nothing apart, nothing said.
    errs, bodies, diag = rebuild([box(), *pin("pa", "body2", -10, 6), *pin("pb", "body3", 10, 6),
                                  combine("j", "body1", ["body2", "body3"], True)])
    check("control: every piece touches, so one solid and no warning",
          not errs and solids(bodies[0]) == 1 and not coded(diag, APART), (errs, coded(diag, APART)))


def test_many_ribs_microns_off_are_all_kept():
    # The shape of 9728490b: 36 small ribs, each 0.01 mm off the box, in one
    # tool body, and 4 more standing on it.
    from build123d import Box, Compound, Pos

    ribs = Compound([Pos(-15 + 6 * i, -15 + 6 * j, 5.51) * Box(1, 3, 1) for i in range(6) for j in range(6)]
                    + [Pos(-18 + 12 * i, 18, 5.5) * Box(1, 3, 1) for i in range(4)])
    imp = {"id": "imp", "type": "import", "format": "step", "name": "Ribs",
           "brep": builder._shape_to_brep_b64(ribs), "explode": False}
    errs, bodies, diag = rebuild([box(), imp, combine("j", "body1", ["body2"], True)])
    w = coded(diag, APART, "j")
    check("every rib is kept: 40 ribs of 3 mm3, 36 of them pieces of their own",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 37
          and abs(volume(bodies[0]) - (BOX + 40 * 3)) < 1e-6,
          (errs, len(bodies), [solids(b) for b in bodies], [volume(b) for b in bodies]))
    check("...and the warning counts the 36 that do not touch",
          len(w) == 1 and w[0]["count"] == 36, w)


def test_a_small_target_and_a_tool_that_floats_off_it():
    # The target is the small one: a pin, joined with a box 15 mm over it.
    feats = [*pin("p", "body1", 0, 0), box(),
             {"id": "m", "type": "move", "bodies": ["body2"], "dx": 0, "dy": 0, "dz": 20,
              "rx": 0, "ry": 0, "rz": 0}]
    errs, bodies, diag = rebuild([*feats, combine("j", "body1", ["body2"], True)])
    w = coded(diag, APART, "j")
    check("the target pin is kept beside the box, in the body named after it",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 2
          and abs(volume(bodies[0]) - (BOX + PIN)) < 1e-6 and bodies[0]["name"] == "Cylinder",
          (errs, len(bodies), [solids(b) for b in bodies]))
    check("...and the box is the 1 piece that does not touch it", len(w) == 1 and w[0]["count"] == 1, w)


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


def test_a_chip_the_body_never_showed_does_not_come_back():
    # The cut leaves a chip in the box that the final pass has always hidden.
    # Keeping every piece must not bring it back, or count it.
    head = [box(), *tube_into("body1", 10, 2)]
    errs, bodies, _ = rebuild(head)
    check("precondition: the box shows one solid, the chip hidden",
          not errs and [solids(b) for b in bodies] == [1], (errs, [solids(b) for b in bodies]))
    errs, bodies, diag = rebuild([*head, *pin("pa", "body4", -10, 6), combine("j", "body1", ["body4"], True)])
    check("a stamped Combine onto it shows one solid and says nothing",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 1 and not coded(diag, APART),
          (errs, [solids(b) for b in bodies], coded(diag, APART)))
    errs, bodies, diag = rebuild([*head, sketch_at("s", 5, [(-10, 0, 4, 4)]),
                                  extrude("e", "s", "join", 3, True)])
    check("...and so does a stamped Join extrude",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 1 and not coded(diag, APART),
          (errs, [solids(b) for b in bodies], coded(diag, APART)))


def test_a_join_extrude_keeps_its_far_piece():
    # A 2 x 2 square on the box's top face and a 1 x 1 square beyond its edge:
    # the far cube touches nothing and is 1 mm3.
    feats = [box(), sketch_at("s", 5, [(0, 0, 2, 2), (30, 0, 1, 1)])]
    errs, bodies, diag = rebuild([*feats, extrude("e", "s", "join", 1, True)])
    w = coded(diag, APART, "e")
    check("the far cube stays in the joined body, through the final pass",
          not errs and len(bodies) == 1 and solids(bodies[0]) == 2
          and abs(volume(bodies[0]) - (BOX + 5)) < 1e-6, (errs, [solids(b) for b in bodies]))
    check("...and the extrude says 1 piece does not touch the rest of the body",
          len(w) == 1 and w[0]["count"] == 1 and w[0]["body_id"] == bodies[0]["id"]
          and not coded(diag, LEFT_OUT), w)

    errs, bodies, diag = rebuild([*feats, extrude("e", "s", "join", 1, False)])
    check("control: unstamped, the far cube is dropped as it always was",
          not errs and solids(bodies[0]) == 1 and len(coded(diag, LEFT_OUT, "e")) == 1,
          (errs, solids(bodies[0])))


def test_a_body_imported_whole_keeps_its_parts_and_says_nothing_of_them():
    from build123d import Box, Compound, Pos

    whole = Compound([Box(40, 40, 10), Pos(30, 0, 0) * Box(1.1, 1.1, 1.1)])
    imp = {"id": "imp", "type": "import", "format": "step", "name": "Cover",
           "brep": builder._shape_to_brep_b64(whole), "explode": False}
    errs, bodies, diag = rebuild([imp, *pin("pa", "body2", -10, 6), combine("j", "body1", ["body2"], True)])
    check("the import's own small part is kept and is not news",
          not errs and solids(bodies[0]) == 2 and not coded(diag, APART) and not coded(diag, LEFT_OUT),
          (errs, solids(bodies[0]), coded(diag, APART)))


# --- revolve, loft, sweep and thicken take the same stamp -------------------------

def test_a_revolve_join_leaves_a_body_in_its_hole_alone():
    # A tube (r 5..15, z -5..5) revolved under a box that stands on it, and a
    # pin in the tube's hole: the pin's box meets the tube's, the pin does not.
    feats = [box(), {"id": "mb", "type": "move", "bodies": ["body1"], "dx": 0, "dy": 0, "dz": 10,
                     "rx": 0, "ry": 0, "rz": 0},
             *pin("p", "body2", 0, 0),
             {"id": "rs", "type": "sketch", "plane": "XZ",
              "entities": [{"type": "rectangle", "width": 10, "height": 10, "x": 10}]}]
    rev = {"id": "rv", "type": "revolve", "sketch": "rs", "axis": "Z", "angle": 360, "operation": "join"}
    tube = math.pi * (15 ** 2 - 5 ** 2) * 10
    errs, bodies, _ = rebuild([*feats, stamp(rev, True)])
    vols = sorted(round(volume(b), 3) for b in bodies)
    check("the pin stays a body of its own; the tube joins the box it touches",
          not errs and vols == [round(PIN, 3), round(BOX + tube, 3)], (errs, vols))
    errs, bodies, _ = rebuild([*feats, stamp(rev, False)])
    check("control: unstamped, the pin is taken in and dropped as it always was",
          not errs and len(bodies) == 1 and abs(volume(bodies[0]) - (BOX + tube)) < 1e-3,
          (errs, len(bodies)))


def test_the_stamp_reaches_the_join_from_every_feature_that_joins():
    seen = []
    real = builder._boolean_into_bodies

    def spy(*a, **kw):
        seen.append(kw.get("touching_only"))
        return real(*a, **kw)

    base = [box()]
    top = {"kind": "face", "by": "normal", "dir": [0, 0, 1]}
    lb = {"id": "lb", "type": "sketch", "plane": "XY",
          "entities": [{"type": "rectangle", "width": 10, "height": 10}]}
    lt = sketch_at("lt", 10, [(0, 0, 5, 5)])
    cases = {
        "revolve": [{"id": "rs", "type": "sketch", "plane": "XZ",  # taller than the box
                     "entities": [{"type": "rectangle", "width": 10, "height": 30, "x": 10}]},
                    {"id": "f", "type": "revolve", "sketch": "rs", "axis": "Z", "angle": 360, "operation": "join"}],
        "loft": [lb, lt, {"id": "f", "type": "loft", "sketches": ["lb", "lt"], "operation": "join"}],
        "sweep": [{"id": "prof", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "radius": 2}]},
                  {"id": "path", "type": "sketch", "plane": "XZ", "entities": [
                      {"type": "arc", "x1": 0, "y1": 0, "mx": 5, "my": 12, "x2": 18, "y2": 18}]},
                  {"id": "f", "type": "sweep", "profile": "prof", "path": "path", "operation": "join"}],
        "thicken": [{"id": "f", "type": "thicken", "faces": top, "thickness": 2, "operation": "join"}],
        "extrude": [lb, {"id": "f", "type": "extrude", "sketch": "lb", "distance": 8, "operation": "join"}],
    }
    builder._boolean_into_bodies = spy
    try:
        for kind, feats in cases.items():
            for on in (True, False):
                seen.clear()
                errs, _bodies, _ = rebuild([*base, *feats[:-1], stamp(feats[-1], on)])
                check(f"{kind} {'stamped' if on else 'unstamped'}: builds, and its join is "
                      f"{'touching only' if on else 'the box rule'}",
                      not errs and seen == [on], (errs, seen))
    finally:
        builder._boolean_into_bodies = real


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
