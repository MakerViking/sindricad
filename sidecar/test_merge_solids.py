"""Merge Solids: one body's overlapping solids made one solid, never silently.
Also Separate's word about the loose surfaces it leaves out. Run:
    cd sidecar && .venv/bin/python test_merge_solids.py

Entered where the user enters: a rebuild of a document holding the exact
`mergeSolids` feature the app appends ({id, type, body}), judged on the EFFECT
(body ids, solids, volumes, what the feature reports). Multi-part bodies come in
as an import kept whole (`explode: false`), the way the field file's did.

The field case is Thomas's LCD cover, Skjermdeksel (11): 50 overlapping solids,
87 loose zero-thickness shells and 1 invalid sliver in one imported body, which
exported as a non-manifold STL. The real-file numbers are in the change's
notes; nothing from that file is committed here. Every guard below has a
CONTROL showing the case it catches gets through without it.
"""

import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("SINDRI_DISK_CACHE", "0")

FAILED = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILED.append(label)


import builder  # noqa: E402
from build123d import Box, Compound, Face, Pos, Solid  # noqa: E402
from OCP.BRep import BRep_Builder  # noqa: E402
from OCP.BRepCheck import BRepCheck_Analyzer  # noqa: E402
from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL  # noqa: E402
from OCP.TopExp import TopExp_Explorer  # noqa: E402
from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid  # noqa: E402


# --- fixtures -------------------------------------------------------------------

def box(x=0.0, s=10.0):
    """An s mm cube centred on (x, 0, 0)."""
    return (Pos(x, 0, 0) * Box(s, s, s)).solids()[0]


def top_face(x=0.0):
    """A loose copy of the top face of box(x): lying ON a solid's own face, like
    72 of the field file's 87 loose shells."""
    e = TopExp_Explorer(box(x).wrapped, TopAbs_FACE)
    while e.More():
        f = Face(e.Current())
        if f.center().Z > 4.9:
            return f
        e.Next()
    raise AssertionError("no top face")


def open_box_shell(x=0.0):
    """A 10 mm box with its top face missing, as a free SHELL."""
    bb = BRep_Builder()
    sh = TopoDS_Shell()
    bb.MakeShell(sh)
    e = TopExp_Explorer(box(x).wrapped, TopAbs_FACE)
    while e.More():
        if Face(e.Current()).center().Z < 4.9:
            bb.Add(sh, e.Current())
        e.Next()
    return sh


def overlapping_solid(x=0.0):
    """ONE solid holding two overlapping 10 mm cubes as two outer shells: invalid
    to BRepCheck, 2,000 mm3 by the kernel's own volume (test_split has the same)."""
    bb = BRep_Builder()
    so = TopoDS_Solid()
    bb.MakeSolid(so)
    for dx in (0.0, 3.0):
        e = TopExp_Explorer(box(x + dx).wrapped, TopAbs_SHELL)
        bb.Add(so, e.Current())
    return Solid(so)


def compound(*parts):
    """A compound of build123d shapes and raw TopoDS parts alike."""
    bb = BRep_Builder()
    from OCP.TopoDS import TopoDS_Compound

    c = TopoDS_Compound()
    bb.MakeCompound(c)
    for p in parts:
        bb.Add(c, getattr(p, "wrapped", p))
    return Compound(c)


def whole_import(shape, name="Cover", fid="imp"):
    """An import kept as ONE body (`explode: false`), as the field file's was."""
    return {"id": fid, "type": "import", "format": "step", "name": name,
            "brep": builder._shape_to_brep_b64(shape), "explode": False}


def merge(body="body1", fid="ms"):
    """Exactly what store.mergeSolids appends."""
    return {"id": fid, "type": "mergeSolids", "body": body}


def rebuild(features):
    diag = []
    _p, errs, bodies = builder.rebuild({"parameters": {}, "features": features}, diagnostics=diag)
    return errs, bodies, diag


def solids_of(b):
    return builder._as_compound(b["shape"]).solids()


def vol(b):
    return round(sum(s.volume for s in solids_of(b)), 6)


def valid(b):
    return BRepCheck_Analyzer(builder._as_compound(b["shape"]).wrapped).IsValid()


def codes(diag, fid="ms"):
    return sorted(d["code"] for d in diag if d.get("feature_id") == fid and d.get("reason"))


def warning(diag, code, fid="ms"):
    got = [d for d in diag if d.get("feature_id") == fid and d.get("code") == code]
    return got[0] if len(got) == 1 else None


# --- the merge ------------------------------------------------------------------

def test_overlaps_and_a_duplicate_become_one_solid():
    """The field file in miniature: two overlapping cubes, an exact duplicate of
    one, and a loose face lying on a cube's own top."""
    cover = compound(box(0), box(5), box(0), top_face(0))
    before = [{"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
              whole_import(cover),
              {"id": "c", "type": "box", "length": 10, "width": 10, "height": 10}]
    errs0, bodies0, _d = rebuild(before)
    check("control: before the merge the body is 3 solids summing 3000 mm3, not the 1500 mm3 of material",
          not errs0 and len(solids_of(bodies0[1])) == 3 and vol(bodies0[1]) == 3000.0,
          (errs0, vol(bodies0[1])))

    move = {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 50, "rx": 0, "ry": 0, "rz": 0,
            "bodies": ["body3"]}
    errs, bodies, diag = rebuild(before + [merge("body2"), move])
    b = bodies[1]
    check("the merge builds", not errs, errs)
    check("no body id or name moves: the merge is appended and the body stays in place",
          [(x["id"], x["name"]) for x in bodies] == [(x["id"], x["name"]) for x in bodies0],
          [(x["id"], x["name"]) for x in bodies])
    check("the body is ONE valid solid", len(solids_of(b)) == 1 and valid(b), len(solids_of(b)))
    check("its volume is the union, 1500 mm3", abs(vol(b) - 1500.0) < 1e-6, vol(b))
    check("the other bodies are untouched", vol(bodies[0]) == 1000.0 and vol(bodies[2]) == 1000.0)
    check("a later feature naming body3 still lands on body3",
          round(bodies[2]["shape"].bounding_box().min.Z, 6) == 45.0,
          bodies[2]["shape"].bounding_box().min.Z)
    w = warning(diag, "mergeDroppedSurfaces")
    check("it says it left the loose face out, counted, naming the body through {body}",
          w is not None and w["count"] == 1 and w["body_id"] == "body2" and w["subject"] == "Cover"
          and "{body}" in w["reason"] and w["lossy"] is False, w)
    check("...and the warning does not claim the result is complete",
          w is not None and "missing" in w["reason"], w and w["reason"])
    check("...and nothing else", codes(diag) == ["mergeDroppedSurfaces"], codes(diag))


def test_pieces_that_do_not_touch_are_all_kept():
    """Pieces that are still apart after the fuse stay in the body, and it says
    how many. The small one is 0.01% of the fused pair and floats clear of it:
    the final debris pass would delete it."""
    tiny = box(40, s=1)
    errs, bodies, diag = rebuild([whole_import(compound(box(0, s=20), box(5, s=20), tiny)), merge()])
    b = bodies[0]
    check("a merge that fuses two solids and leaves a third apart builds", not errs, errs)
    check("both pieces are kept, nothing lost", len(solids_of(b)) == 2 and vol(b) == 10001.0,
          (len(solids_of(b)), vol(b)))
    w = warning(diag, "mergeSeparatePieces")
    check("it says the body is 2 pieces that do not touch", w is not None and w["count"] == 2, w)
    check("control: the debris pass WOULD drop the small piece of a body that is not intact",
          len(builder._as_compound(builder._drop_debris(compound(box(0, s=25), tiny))).solids()) == 1)

    errs, bodies, diag = rebuild([whole_import(compound(box(0), box(5))), merge()])
    check("control: pieces that fuse into one give no pieces warning",
          not errs and len(solids_of(bodies[0])) == 1 and "mergeSeparatePieces" not in codes(diag),
          (errs, codes(diag)))


def test_no_piece_is_lost_to_the_debris_pass_after_a_merge():
    """The final debris pass drops a floating solid under 0.1% of the BIGGEST,
    and after a merge the biggest is a union larger than any solid that went
    in. A body that is not `_intact` (a Join whose fuse was refused hands one
    back; an import kept whole is `_intact`, so the import here has it taken
    off) must still keep every piece. A critic's case: 10 mm cubes at x=0 and
    9 beside a 1.1 mm cube, 1.331 mm3: over 0.1% of one cube, under 0.1% of
    their 1,900 mm3 union."""
    real_import = builder._FEATURE_HANDLERS["import"]
    real_merge = builder._FEATURE_HANDLERS["mergeSolids"]

    def import_not_intact(f, ctx):
        real_import(f, ctx)
        for b in ctx.bodies:
            b.pop("_intact", None)

    def merge_then_forget(f, ctx):  # the fix undone: the merged body loses `_intact`
        real_merge(f, ctx)
        for b in ctx.bodies:
            b.pop("_intact", None)

    head = [whole_import(compound(box(0), box(9), box(40, s=1.1)))]
    builder._FEATURE_HANDLERS["import"] = import_not_intact
    try:
        errs0, bodies0, _d = rebuild(head)
        errs, bodies, diag = rebuild(head + [merge()])
        builder._FEATURE_HANDLERS["mergeSolids"] = merge_then_forget
        errs1, bodies1, _d1 = rebuild(head + [merge()])
    finally:
        builder._FEATURE_HANDLERS["import"] = real_import
        builder._FEATURE_HANDLERS["mergeSolids"] = real_merge
    check("control: before the merge the debris pass keeps all 3 solids (1.331 > 0.1% of 1000)",
          not errs0 and len(solids_of(bodies0[0])) == 3, (errs0, len(solids_of(bodies0[0]))))
    check("after the merge the small piece is still there: 2 solids, 1901.331 mm3",
          not errs and len(solids_of(bodies[0])) == 2 and abs(vol(bodies[0]) - 1901.331) < 1e-6,
          (errs, len(solids_of(bodies[0])), vol(bodies[0])))
    w = warning(diag, "mergeSeparatePieces")
    check("...and the warning counts the 2 pieces the user sees", w is not None and w["count"] == 2, w)
    check("control: without `_intact` on the merged body the pass drops it in silence",
          not errs1 and len(solids_of(bodies1[0])) == 1 and abs(vol(bodies1[0]) - 1900.0) < 1e-6,
          (errs1, len(solids_of(bodies1[0])), vol(bodies1[0])))


def test_a_damaged_solid_is_left_out_and_said():
    bad = overlapping_solid(40)
    check("control: the fixture is invalid to BRepCheck", not BRepCheck_Analyzer(bad.wrapped).IsValid())
    doc = [whole_import(compound(box(0), box(5), bad)), merge()]
    errs, bodies, diag = rebuild(doc)
    b = bodies[0]
    check("a body with a damaged solid still merges", not errs, errs)
    check("the damaged solid is left out: one valid solid of 1500 mm3",
          len(solids_of(b)) == 1 and valid(b) and abs(vol(b) - 1500.0) < 1e-6, (len(solids_of(b)), vol(b)))
    w = warning(diag, "mergeDamagedLeftOut")
    check("it says so, counted", w is not None and w["count"] == 1 and "{body}" in w["reason"], w)

    real = builder._merge_screen
    builder._merge_screen = lambda s: builder._topods_volume(s)  # the screen OFF
    try:
        errs, bodies, diag = rebuild(doc)
    finally:
        builder._merge_screen = real
    same = (not errs and len(solids_of(bodies[0])) == 1 and abs(vol(bodies[0]) - 1500.0) < 1e-6
            and warning(diag, "mergeDamagedLeftOut") is not None)
    check("control: without the screen the damaged solid goes into the fuse and the result differs",
          not same, (errs, len(solids_of(bodies[0])), vol(bodies[0])))


def test_an_inside_out_solid_is_left_out():
    """BRepCheck calls an inside-out solid valid, and a fuse treats it as
    everything outside itself."""
    a, b = box(0), box(5)
    rev = Solid(b.wrapped.Reversed())
    check("control: BRepCheck calls the inside-out solid valid", BRepCheck_Analyzer(rev.wrapped).IsValid())
    raw, _alerts = builder._merge_fuse([a.wrapped, rev.wrapped])
    check("control: fused with it, a 1000 mm3 cube comes back 'valid' at -500 mm3",
          raw is not None and BRepCheck_Analyzer(raw).IsValid()
          and round(builder._topods_volume(raw), 6) == -500.0,
          raw is not None and builder._topods_volume(raw))

    doc = [whole_import(compound(a, rev)), merge()]
    errs, bodies, diag = rebuild(doc)
    check("the inside-out solid is left out: the cube alone, 1000 mm3",
          not errs and len(solids_of(bodies[0])) == 1 and vol(bodies[0]) == 1000.0,
          (errs, vol(bodies[0])))
    check("...and it is counted as damaged", codes(diag) == ["mergeDamagedLeftOut"], codes(diag))

    real = builder._merge_screen
    builder._merge_screen = lambda s: builder._topods_volume(s)
    try:
        errs, bodies, _diag = rebuild(doc)
    finally:
        builder._merge_screen = real
    check("control: without the volume screen the merge does not give the cube",
          errs or vol(bodies[0]) != 1000.0, (errs, vol(bodies[0])))


def test_nothing_to_merge_is_an_error_in_words():
    errs, bodies, _d = rebuild([whole_import(compound(box(0))), merge()])
    check("one clean solid is refused with mergeNothing",
          [e.get("code") for e in errs] == ["mergeNothing"], errs)
    e = errs[0] if errs else {}
    check("...naming the body through {body}, beside its id and name",
          "{body}" in e.get("message", "") and e.get("body_id") == "body1" and e.get("subject") == "Cover", e)
    check("...and the body is as it was", len(bodies) == 1 and vol(bodies[0]) == 1000.0)

    errs, bodies, diag = rebuild([whole_import(compound(box(0), top_face(0))), merge()])
    check("control: one solid WITH a loose face is not nothing: the face goes, and it says so",
          not errs and len(solids_of(bodies[0])) == 1 and codes(diag) == ["mergeDroppedSurfaces"],
          (errs, codes(diag)))
    shapes = builder._as_compound(bodies[0]["shape"])
    check("...and the loose face is really gone", len(shapes.faces()) == 6, len(shapes.faces()))


def test_solids_already_apart_are_an_error_in_words():
    """A body whose sound solids neither overlap nor touch, with nothing loose
    and nothing damaged, has nothing to fuse: the fuse hands back the same
    solids. That merge changes nothing, so it is refused in words, not built
    with an amber "is now N pieces". Seen live: a second Merge on the field
    file's cover (8 pieces after the first) built, and changed nothing."""
    errs, bodies, diag = rebuild([whole_import(compound(box(0), box(40))), merge()])
    check("two cubes that do not touch are refused with mergeNothingApart, counted",
          [(e.get("code"), e.get("count")) for e in errs] == [("mergeNothingApart", 2)], errs)
    e = errs[0] if errs else {}
    check("...naming the body through {body}, beside its id and name",
          "{body}" in e.get("message", "") and e.get("body_id") == "body1" and e.get("subject") == "Cover", e)
    check("...with no pieces warning beside the error", codes(diag) == [], codes(diag))
    check("...and the body is as it was", len(solids_of(bodies[0])) == 2 and vol(bodies[0]) == 2000.0)

    # Merging twice: the first fuses the overlapping pair and leaves the far
    # cube apart, the second has nothing left to do.
    head = [whole_import(compound(box(0), box(5), box(40)))]
    errs, bodies, diag = rebuild(head + [merge("body1", "m1")])
    check("control: a merge that fused something and left pieces apart builds, with its pieces warning",
          not errs and len(solids_of(bodies[0])) == 2 and codes(diag, "m1") == ["mergeSeparatePieces"],
          (errs, codes(diag, "m1")))
    errs, bodies, diag = rebuild(head + [merge("body1", "m1"), merge("body1", "m2")])
    check("the second merge is refused with mergeNothingApart",
          [(e.get("feature_id"), e.get("code"), e.get("count")) for e in errs] == [("m2", "mergeNothingApart", 2)],
          errs)
    check("...and the first one's result stands", len(solids_of(bodies[0])) == 2 and vol(bodies[0]) == 2500.0,
          vol(bodies[0]))

    errs, bodies, diag = rebuild([whole_import(compound(box(0), box(40), top_face(0))), merge()])
    check("control: solids apart WITH a loose face is not nothing: the face goes, and it says so",
          not errs and len(builder._as_compound(bodies[0]["shape"]).faces()) == 12
          and codes(diag) == ["mergeDroppedSurfaces", "mergeSeparatePieces"], (errs, codes(diag)))


# A critic's five near-coincident solids (offsets of 1 nm to 1 micron: the
# duplicate and contained-pair class the field file is made of). The one fuse
# hands back a BRepCheck-valid result of 2 solids and 2,263.794 mm3 with no
# error, while fusing them one at a time gives 2,595.869 mm3: 12.8% of the
# 45-degree box is gone.
def _lossy_five():
    from build123d import Cylinder, Rot

    return [(Pos(0.001, 0.001, 0.001) * Cylinder(5, 10)).solids()[0],
            (Pos(0, 5, 0) * Cylinder(5, 10)).solids()[0],
            (Pos(5, 5, 0) * Rot(0, 0, 45) * Box(10, 10, 10)).solids()[0],
            (Pos(10, 1e-6, 1e-6) * Box(10, 10, 10)).solids()[0],
            (Pos(0.001, 0, 0) * Cylinder(5, 10)).solids()[0]]


def test_a_fuse_that_loses_part_of_a_solid_is_refused():
    """The real kernel, no stand-in: a fuse that loses part of a solid with a
    valid result and no error. Three checks refuse it, each on its own: a point
    from strictly inside every solid must be strictly INSIDE the result (it
    used to accept ON, and this result reads ON at the lost box's centre), no
    part of any solid may lie outside the result (its own CUT), and every solid
    of the result must be sound (this one's second solid is empty, -0.0 mm3)."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_ON

    five = _lossy_five()
    doc = [whole_import(compound(*five)), merge()]
    union = five[0]
    for s in five[1:]:
        union = union.fuse(s)

    def merged_with(point=True, cut=True, sound=True):
        real = builder._interior_point, builder._merge_lost_volume, builder._merge_sound
        if not point:
            builder._interior_point = lambda s: None
        if not cut:
            builder._merge_lost_volume = lambda solids, r: 0.0
        if not sound:
            builder._merge_sound = lambda topods: True
        try:
            return rebuild(doc)
        finally:
            builder._interior_point, builder._merge_lost_volume, builder._merge_sound = real

    for label, kw in (("with all three checks", {}),
                      ("by the CUT alone", {"point": False, "sound": False}),
                      ("by the point alone", {"cut": False, "sound": False}),
                      ("by the soundness of the result alone", {"point": False, "cut": False})):
        errs, bodies, diag = merged_with(**kw)
        check(f"refused with mergeFailed {label}, naming the body",
              [(e.get("code"), e.get("body_id")) for e in errs] == [("mergeFailed", "body1")], errs)
        check(f"...and nothing was changed ({label})",
              len(solids_of(bodies[0])) == 5 and not codes(diag), (len(solids_of(bodies[0])), codes(diag)))

    errs, bodies, _d = merged_with(point=False, cut=False, sound=False)
    got = vol(bodies[0])
    check("control: with none of the three the loss is committed in silence, 2263.794 mm3 against a "
          "2595.869 mm3 union", not errs and round(got, 3) == 2263.794 and round(union.volume, 3) == 2595.869,
          (errs, got, union.volume))
    lost_box = five[2].wrapped
    outside = builder._merge_lost_volume([lost_box], builder._as_compound(bodies[0]["shape"]).wrapped)
    check("control: its CUT finds 332.075 mm3 of the 45-degree box outside that result",
          outside is not None and round(outside, 3) == 332.075, outside)
    p = builder._interior_point(lost_box)
    states = []
    for s in solids_of(bodies[0]):
        clf = BRepClass3d_SolidClassifier(s.wrapped)
        clf.Perform(p, 1e-7)
        states.append(clf.State())
    check("control: that result reads ON (not OUT) at the lost box's own interior point, so a "
          "check that took ON let it through", TopAbs_ON in states, states)


def test_a_body_with_no_sound_solid_is_an_error_in_words():
    errs, bodies, _d = rebuild([whole_import(compound(top_face(0), open_box_shell(20))), merge()])
    check("a body of loose surfaces only is refused with mergeNoSolid",
          [e.get("code") for e in errs] == ["mergeNoSolid"], errs)
    check("...in words that say why and what to do",
          errs and "only surfaces" in errs[0]["message"] and "Thicken" in errs[0]["message"], errs)
    check("...and the surfaces are all still there", len(builder._as_compound(bodies[0]["shape"]).faces()) == 6)

    errs, bodies, _d = rebuild([whole_import(compound(overlapping_solid(0), overlapping_solid(40))), merge()])
    check("a body whose every solid is damaged is refused with mergeAllDamaged, counted",
          [(e.get("code"), e.get("count")) for e in errs] == [("mergeAllDamaged", 2)], errs)

    errs, _b, _d = rebuild([whole_import(compound(box(0), box(5))), merge("body7")])
    check("a body that does not exist here is refused with mergeNoBody",
          [e.get("code") for e in errs] == ["mergeNoBody"], errs)


def test_a_fuse_that_loses_a_part_is_refused():
    """The check the volume bracket cannot make: the union is legitimately far
    below the sum, so a fuse that dropped a whole small part still lands inside
    it. A point from inside every solid that went in must be in the result,
    and none of any solid may lie outside it."""
    doc = [whole_import(compound(box(0), box(3), box(30, s=2))), merge()]
    real = builder._merge_fuse

    def drops_the_small_part(solids):
        raw, alerts = real(solids)
        keep = [s for s in builder._solids_of(raw) if builder._topods_volume(s) > 100]
        return compound(*keep).wrapped, alerts

    builder._merge_fuse = drops_the_small_part
    try:
        errs, bodies, _d = rebuild(doc)
        check("a fuse that lost a part is refused with mergeFailed, naming the body",
              [(e.get("code"), e.get("body_id")) for e in errs] == [("mergeFailed", "body1")], errs)
        check("...and nothing was changed", len(solids_of(bodies[0])) == 3 and vol(bodies[0]) == 2008.0,
              vol(bodies[0]))
        lost = builder._topods_volume(drops_the_small_part(
            [s.wrapped for s in (box(0), box(3), box(30, s=2))])[0])
        check("control: the result it lost the part from sits inside the volume bracket (1000..2008)",
              1000.0 <= lost <= 2008.0, lost)
        real_point, real_cut = builder._interior_point, builder._merge_lost_volume
        builder._interior_point = lambda s: None  # the point check OFF
        try:
            errs, bodies, _d = rebuild(doc)
            check("the CUT check refuses it on its own too",
                  [e.get("code") for e in errs] == ["mergeFailed"], errs)
            builder._merge_lost_volume = lambda solids, r: 0.0  # and the CUT check OFF
            errs, bodies, _d = rebuild(doc)
        finally:
            builder._interior_point, builder._merge_lost_volume = real_point, real_cut
        check("control: with neither check the lost part is committed in silence",
              not errs and round(vol(bodies[0]), 6) == 1300.0, (errs, vol(bodies[0])))
    finally:
        builder._merge_fuse = real


def test_a_fuse_that_invents_material_is_refused():
    """The union can hold no more than went in. A valid result that holds every
    solid and MORE passes the validity and point checks; only the volume
    bracket stops it."""
    doc = [whole_import(compound(box(0), box(3))), merge()]
    swollen = box(0, s=30)
    real = builder._merge_fuse
    builder._merge_fuse = lambda solids: (swollen.wrapped, [])
    try:
        errs, bodies, _d = rebuild(doc)
    finally:
        builder._merge_fuse = real
    check("a result bigger than the solids that went in is refused with mergeFailed",
          [e.get("code") for e in errs] == ["mergeFailed"], errs)
    check("...and the body is as it was", len(solids_of(bodies[0])) == 2 and vol(bodies[0]) == 2000.0)
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_IN

    clf = BRepClass3d_SolidClassifier(swollen.wrapped)
    held = []
    for s in (box(0), box(3)):
        clf.Perform(builder._interior_point(s.wrapped), 1e-6)
        held.append(clf.State() == TopAbs_IN)
    check("control: that result is valid and holds a point from inside every solid",
          BRepCheck_Analyzer(swollen.wrapped).IsValid() and all(held), held)


def test_an_invalid_fuse_is_refused_never_repaired():
    """A fuse can report success and hand back an invalid solid (memory: fuses of
    raw sliver-ridden solids). The result must be BRepCheck-valid; it is never
    repaired, and never handed to UnifySameDomain, which segfaults on it."""
    doc = [whole_import(compound(box(0), box(3))), merge()]
    bad = overlapping_solid(0)
    real = builder._merge_fuse
    builder._merge_fuse = lambda solids: (bad.wrapped, [])
    try:
        errs, bodies, _d = rebuild(doc)
    finally:
        builder._merge_fuse = real
    check("an invalid fuse result is refused with mergeFailed",
          [e.get("code") for e in errs] == ["mergeFailed"], errs)
    check("...and the body is as it was", len(solids_of(bodies[0])) == 2 and vol(bodies[0]) == 2000.0)
    check("control: that result is invalid, yet its volume (2000) sits inside the bracket (1000..2000)",
          not BRepCheck_Analyzer(bad.wrapped).IsValid() and 1000.0 <= bad.volume <= 2000.0 + 1e-6,
          bad.volume)


def test_a_face_merge_that_breaks_the_solid_is_not_taken():
    """UnifySameDomain tidies the coplanar faces the fuse leaves, and can report
    success with an invalid solid. The merge then keeps the fuse as it was."""
    import OCP.ShapeUpgrade as su

    doc = [whole_import(compound(box(0), box(5))), merge()]
    errs, bodies, _d = rebuild(doc)
    tidy = len(builder._as_compound(bodies[0]["shape"]).faces())
    raw, _a = builder._merge_fuse([box(0).wrapped, box(5).wrapped])
    raw_faces = len(builder._wrap_topods(raw).faces())
    check("control: the tidy-up really merges faces here", not errs and tidy == 6 and raw_faces > 6,
          (tidy, raw_faces))

    # Invalid, yet the same volume (1500) and solid count as the right answer,
    # so validity is the only thing that can tell them apart: one solid holding
    # two disjoint outer shells, a 10 mm cube and a 10 x 10 x 5 slab.
    bb = BRep_Builder()
    so = TopoDS_Solid()
    bb.MakeSolid(so)
    for shell_of in (box(0), (Pos(30, 0, 0) * Box(10, 10, 5)).solids()[0]):
        bb.Add(so, TopExp_Explorer(shell_of.wrapped, TopAbs_SHELL).Current())
    bad = Solid(so)

    class Breaks:
        def __init__(self, *a):
            pass

        def AllowInternalEdges(self, *a):
            pass

        def Build(self):
            pass

        def Shape(self):
            return bad.wrapped

    check("control: what the broken tidy-up returns is invalid, one solid of the right volume",
          not BRepCheck_Analyzer(bad.wrapped).IsValid() and len(builder._solids_of(bad.wrapped)) == 1
          and abs(builder._topods_volume(bad.wrapped) - 1500.0) < 1e-6, builder._topods_volume(bad.wrapped))
    real = su.ShapeUpgrade_UnifySameDomain
    su.ShapeUpgrade_UnifySameDomain = Breaks
    try:
        errs, bodies, _d = rebuild(doc)
    finally:
        su.ShapeUpgrade_UnifySameDomain = real
    b = bodies[0]
    check("a tidy-up that breaks the solid is not taken: the fuse is kept, valid",
          not errs and valid(b) and len(builder._as_compound(b["shape"]).faces()) == raw_faces
          and abs(vol(b) - 1500.0) < 1e-6, (errs, len(builder._as_compound(b["shape"]).faces())))


def test_an_inside_out_solid_in_the_result_is_refused():
    """A solid read inside-out holds everything OUTSIDE itself, so one in the
    result blinds every other check at once: each point from inside a solid
    that went in classifies as inside it, each CUT by the result comes back
    empty, and its negative volume pulls the total down inside the bracket.
    The real kernel did this on the field file's cover before its split (767
    sound solids in one fuse): 5 inside-out solids of -0.016 to -73.9 mm3 in a
    result BRepCheck calls valid, every old check passed, and a 20,000-point
    sample found points inside 11 of the solids that went in outside every
    solid of the result. Here a stand-in fuse hands back the right union of two
    cubes with the small far part dropped and a 1 mm3 inside-out cube beside
    it."""
    doc = [whole_import(compound(box(0), box(5), box(30, s=2))), merge()]
    union = (box(0).fuse(box(5))).solids()[0]
    rev = Solid(box(60, s=1).wrapped.Reversed())
    lossy = compound(union, rev).wrapped
    real_fuse, real_sound = builder._merge_fuse, builder._merge_sound
    builder._merge_fuse = lambda solids: (lossy, [])
    try:
        errs, bodies, diag = rebuild(doc)
        check("a result with an inside-out solid in it is refused with mergeFailed, naming the body",
              [(e.get("code"), e.get("body_id")) for e in errs] == [("mergeFailed", "body1")], errs)
        check("...and nothing was changed", len(solids_of(bodies[0])) == 3 and vol(bodies[0]) == 2008.0,
              (len(solids_of(bodies[0])), vol(bodies[0])))
        builder._merge_sound = lambda topods: True  # the check OFF
        errs, bodies, diag = rebuild(doc)
    finally:
        builder._merge_fuse, builder._merge_sound = real_fuse, real_sound
    check("control: BRepCheck calls that result valid", BRepCheck_Analyzer(lossy).IsValid())
    check("control: without the check the lost 8 mm3 part is committed past the point check, the CUT "
          "and the volume bracket (1499 mm3 inside 1000..2008), and the only note counts 2 pieces",
          not errs and round(vol(bodies[0]), 6) == 1499.0 and codes(diag) == ["mergeSeparatePieces"],
          (errs, vol(bodies[0]), codes(diag)))


def test_a_big_body_is_fused_in_batches_with_a_tick_between_kernel_calls():
    """Nothing can tick inside an OCCT call, and the server reaps a worker whose
    heartbeat stands still for 60 s. One fuse of the field file's 767 solids
    took 46 s on a fast desktop, so the merge fuses _MERGE_BATCH solids
    per call into the union so far, and ticks between every kernel call it
    makes, the checks' CUTs included. 70 cubes in a row, each overlapping the
    next by 1 mm, cross two batch boundaries and must still come out as ONE
    solid, the same as one fuse of all 70 makes."""
    n = builder._MERGE_BATCH
    row = [box(9.0 * i) for i in range(70)]
    doc = [whole_import(compound(*row)), merge()]
    want = 100.0 * (9 * 69 + 10)

    def run():
        events = []
        real_fuse, real_cut, real_tick = builder._merge_fuse, builder._merge_lost_volume, builder.on_feature_tick

        def fuse(solids):
            events.append(("fuse", len(solids)))
            return real_fuse(solids)

        def cut(solids, result):
            events.append(("cut", len(solids)))
            return real_cut(solids, result)

        builder._merge_fuse, builder._merge_lost_volume = fuse, cut
        builder.on_feature_tick = lambda i: events.append(("tick", i))
        try:
            errs, bodies, _d = rebuild(doc)
        finally:
            builder._merge_fuse, builder._merge_lost_volume, builder.on_feature_tick = real_fuse, real_cut, real_tick
        return errs, bodies, events

    errs, bodies, events = run()
    b = bodies[0]
    check("70 overlapping cubes merge into ONE valid solid of the union's volume",
          not errs and len(solids_of(b)) == 1 and valid(b) and abs(vol(b) - want) < 1e-6,
          (errs, len(solids_of(b)), vol(b)))
    fuses = [k for e, k in events if e == "fuse"]
    check(f"...in batches: no fuse takes more than {n} solids and the union so far",
          fuses == [n, n + 1, 70 - 2 * n + 1], fuses)
    calls = [i for i, (e, _k) in enumerate(events) if e in ("fuse", "cut")]
    untimed = [(a, c) for a, c in zip(calls, calls[1:]) if not any(e == "tick" for e, _k in events[a + 1:c])]
    check("...with a progress tick between every two kernel calls, fuses and CUTs alike",
          len(calls) > len(fuses) and not untimed, untimed)

    builder._MERGE_BATCH = 10 ** 6
    try:
        errs1, bodies1, events1 = run()
    finally:
        builder._MERGE_BATCH = n
    check("control: unbatched it is ONE fuse of all 70, and the same one solid",
          [k for e, k in events1 if e == "fuse"] == [70] and not errs1
          and abs(vol(bodies1[0]) - want) < 1e-6 and len(solids_of(bodies1[0])) == 1,
          ([k for e, k in events1 if e == "fuse"], errs1))


def test_no_cut_takes_more_than_its_share_of_solids():
    """The lost-part CUTs pay for the result each time AND for every solid in
    the group, so a body whose solids are mostly apart would put them all in
    one call: 625 overlapping cylinders took 19.8 s in a CUT of 128, 6.6 s in
    one of 32. Groups stop at _MERGE_BATCH, and the merge's CUTs keep to it."""
    most = builder._MERGE_BATCH
    apart = [box(3.0 * i, s=1).wrapped for i in range(100)]
    sizes = sorted(len(g) for g in builder._apart_groups(apart, most))
    check(f"100 solids that never touch make groups of at most {most}",
          sizes == [100 - 3 * most, most, most, most], sizes)
    check("control: uncapped they are one group of 100",
          [len(g) for g in builder._apart_groups(apart, 10 ** 6)] == [100])

    cut_sizes = []
    real = builder._merge_lost_volume

    def cut(solids, result):
        cut_sizes.append(len(solids))
        return real(solids, result)

    # 40 cubes on a line, 12 mm apart: none touches another, so they are one
    # apart-group, and a loose face beside them lets the merge go ahead.
    doc = [whole_import(compound(*[box(12.0 * i) for i in range(40)], top_face(0))), merge()]
    builder._merge_lost_volume = cut
    try:
        errs, bodies, _d = rebuild(doc)
    finally:
        builder._merge_lost_volume = real
    check(f"the merge's CUTs take at most {most} solids each, and all 40 between them",
          not errs and max(cut_sizes) <= most and sum(cut_sizes) == 40, (errs, cut_sizes))


def test_the_face_tidy_up_never_undoes_a_flat_text_or_its_colour():
    """A flat text is its letters imprinted INTO the face they sit on, on the
    same surface, which is exactly what the tidy-up (UnifySameDomain) merges
    back into one face: that would silently undo the text and drop the colour
    it gave its letters. With a flat text or a face colour on the body, the
    tidy-up is not taken when it would merge one of those faces away."""
    from build123d import Box as B3Box

    plate = B3Box(60, 30, 5).solids()[0]  # top face at z = 2.5
    doc_of = lambda slot: [  # noqa: E731
        whole_import(compound(plate, box(28))),  # a 10 mm cube overlapping the plate's end
        {"id": "t1", "type": "textOnFace", "face": {"kind": "face", "by": "nearest", "point": [0, 0, 2.5],
                                                    "body": "body1"},
         "pick": [0, 0, 2.5], "plane": {"origin": [0, 0, 2.5], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "text": "Bodo", "height": 6, "align": "center", "depth": 0.6, "operation": "flat",
         **({"colorSlot": slot} if slot is not None else {})},
        merge()]

    def top_faces(b):
        return len([fc for fc in builder._as_compound(b["shape"]).faces() if abs(fc.center().Z - 2.5) < 1e-6])

    def painted(b):
        return len([fc for fc in builder._as_compound(b["shape"]).faces()
                    if builder._face_fp(fc) in (b.get("_faceSlots") or {})])

    def merged(slot, fix=True):
        real = builder._merge_kept_faces
        if not fix:
            builder._merge_kept_faces = lambda b, features: frozenset()
        try:
            return rebuild(doc_of(slot))
        finally:
            builder._merge_kept_faces = real

    _e, before, _d = rebuild(doc_of(1)[:2])
    check("control: before the merge the text splits the plate's top into 10 faces, 4 of them coloured",
          top_faces(before[0]) == 10 and painted(before[0]) == 4, (top_faces(before[0]), painted(before[0])))
    for slot, label in ((1, "a coloured flat text"), (None, "a flat text with no colour of its own")):
        errs, bodies, _d = merged(slot)
        b = bodies[0]
        check(f"{label}: the merge builds one solid of 9650 mm3",
              not errs and len(solids_of(b)) == 1 and valid(b) and abs(vol(b) - 9650.0) < 1e-6, (errs, vol(b)))
        check(f"...and the letters are still there: 10 faces on the plate's top",
              top_faces(b) == 10, top_faces(b))
        errs0, bodies0, _d = merged(slot, fix=False)
        check(f"control ({label}): with the tidy-up taken anyway the top is ONE face again",
              not errs0 and top_faces(bodies0[0]) == 1, top_faces(bodies0[0]))
    errs, bodies, _d = merged(1)
    errs0, bodies0, _d = merged(1, fix=False)
    check("the coloured letters keep their colour: 4 painted faces", painted(bodies[0]) == 4, painted(bodies[0]))
    check("control: with the tidy-up taken anyway no face is painted", painted(bodies0[0]) == 0, painted(bodies0[0]))


def test_every_solid_gets_a_point_to_check_even_a_tube():
    """The lost-part check is only as good as the points it tests: a solid it
    finds no point in is not checked at all. A tube's centre, and the centroid
    of every one of its faces, lie on its axis in the hole (4 of the field
    file's 49 solids are tubes like this)."""
    from build123d import Cylinder
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_IN

    tube = (Cylinder(5, 10) - Cylinder(3, 10)).solids()[0]
    clf = BRepClass3d_SolidClassifier(tube.wrapped)
    clf.Perform(tube.center().to_pnt(), 1e-7)
    check("control: the tube's centre is not inside it", clf.State() != TopAbs_IN, clf.State())
    p = builder._interior_point(tube.wrapped)
    ok = p is not None
    if ok:
        clf.Perform(p, 1e-7)
        ok = clf.State() == TopAbs_IN
    check("a point inside the tube is found", ok, p)


def test_the_merge_does_not_write_into_the_bodies_it_reads():
    """The solids a merge fuses are the very shapes the rebuild cache holds for
    every feature before it. OCCT's boolean builders write into their arguments
    by default (on the field file a default fuse rewrote all 49 solids it was
    given); here two cubes overlapping by 1 micron are enough. Undo the merge
    (the cache resumes from the import) and the body must be exactly what a
    fresh build of the import gives."""
    import OCP.BOPAlgo as bop

    head = [whole_import(compound(box(0), box(10 - 1e-6)))]

    def brep(features):
        _p, _e, bodies = builder.rebuild({"parameters": {}, "features": features})
        return builder._shape_to_brep_b64(builder._as_compound(bodies[0]["shape"]))

    def undone():
        builder._CACHE.update({"feature_sigs": [], "snaps": [], "global_sig": None})
        builder.rebuild_cached({"parameters": {}, "features": head})
        _p, errs, _b = builder.rebuild_cached({"parameters": {}, "features": head + [merge()]})
        _p, _e, bodies = builder.rebuild_cached({"parameters": {}, "features": head})
        return errs, builder._shape_to_brep_b64(builder._as_compound(bodies[0]["shape"]))

    fresh = brep(head)
    errs, after = undone()
    check("the merge builds", not errs, errs)
    check("undoing it gives back the import exactly as a fresh build does", after == fresh)

    real = bop.BOPAlgo_BOP

    class Destructive(real):
        def SetNonDestructive(self, _flag):
            real.SetNonDestructive(self, False)

    bop.BOPAlgo_BOP = Destructive
    try:
        _errs, after = undone()
    finally:
        bop.BOPAlgo_BOP = real
        builder._CACHE.update({"feature_sigs": [], "snaps": [], "global_sig": None})
    check("control: a destructive fuse leaves the cached import changed", after != fresh)


def test_the_warnings_survive_a_warm_rebuild():
    """The app rebuilds through the prefix cache; the warning must come back on a
    rebuild that resumes past the merge, or the chip goes quiet."""
    doc = {"parameters": {}, "features": [whole_import(compound(box(0), box(5), top_face(0))), merge()]}
    for label in ("cold", "warm"):
        diag = []
        _p, errs, _b = builder.rebuild_cached(doc, diagnostics=diag)
        check(f"{label}: the dropped-surfaces warning is reported", not errs and codes(diag) == ["mergeDroppedSurfaces"],
              (errs, codes(diag)))


# --- Separate --------------------------------------------------------------------

def test_separate_says_what_it_leaves_out_and_makes_the_same_pieces():
    """Separate made one body per solid and dropped every loose shell and face
    without a word. It still makes exactly the same pieces (ids are positional:
    an existing document must rebuild into the same bodies), and now says so."""
    def pieces(bodies):
        return [(b["id"], b["name"], vol(b), len(builder._as_compound(b["shape"]).faces())) for b in bodies]

    sep = {"id": "sp", "type": "separate", "body": "body1"}
    errs0, clean, diag0 = rebuild([whole_import(compound(box(0), box(40))), sep])
    check("control: solids alone separate with no warning", not errs0 and len(clean) == 2 and not codes(diag0, "sp"),
          (errs0, codes(diag0, "sp")))
    errs, bodies, diag = rebuild([whole_import(compound(box(0), top_face(0), box(40), open_box_shell(80))), sep])
    check("with loose surfaces beside them it makes the very same pieces",
          not errs and pieces(bodies) == pieces(clean), (errs, pieces(bodies), pieces(clean)))
    w = warning(diag, "separateDroppedSurfaces", "sp")
    check("...and says it left the 2 loose surfaces out, naming the body, for having no thickness",
          w is not None and w["count"] == 2 and w["body_id"] == "body1" and "{body}" in w["reason"]
          and "no thickness" in w["reason"], w)

    errs, bodies, diag = rebuild([whole_import(compound(open_box_shell(0), open_box_shell(40), top_face(80))), sep])
    check("a surface body separates into its shells as before",
          not errs and len(bodies) == 2 and all(not solids_of(b) for b in bodies), (errs, len(bodies)))
    w = warning(diag, "separateDroppedFaces", "sp")
    check("...and says it left the bare face out, as a face in none of its surfaces",
          w is not None and w["count"] == 1 and w["body_id"] == "body1" and "{body}" in w["reason"]
          and "no thickness" not in w["reason"] and "not joined into any of them" in w["reason"], w)
    check("control: not in the words for loose surfaces beside solids, which have no thickness",
          warning(diag, "separateDroppedSurfaces", "sp") is None, codes(diag, "sp"))
    errs, bodies, diag = rebuild([whole_import(compound(open_box_shell(0), open_box_shell(40))), sep])
    check("control: shells alone separate with no warning", not errs and not codes(diag, "sp"), codes(diag, "sp"))


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
