"""Split: cut part by part, never silently, compute-then-commit. Run:
    cd sidecar && .venv/bin/python test_split.py

Entered where the user enters: a rebuild of a document holding the exact
`split` feature the app writes, judged on the EFFECT (body count, ids,
volumes, what the feature reports). Multi-part bodies come in the way the field
file's did, as an import kept whole (`explode: false`).

The field case these stand in for is Thomas's 2026-09-26 report on the Ender 3
assembly (908 solids and 1,155 shells in one body, 141 solids invalid, a datum
lying exactly on the boundary between its parts). The real-file numbers are in
the change's notes; nothing from that third-party file is committed here.
"""

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
from build123d import Box, Compound, Cylinder, Face, GeomType, Polyline, Pos, Rot, Shell, Solid, Torus, Vector, Wire  # noqa: E402
from OCP.BRep import BRep_Builder  # noqa: E402
from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL  # noqa: E402
from OCP.TopExp import TopExp_Explorer  # noqa: E402
from OCP.TopoDS import TopoDS_CompSolid, TopoDS_Shell, TopoDS_Solid  # noqa: E402

XY0 = {"origin": [0, 0, 0], "normal": [0, 0, 1], "xdir": [1, 0, 0]}


def plane_z(z):
    return {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]}


def whole_import(shape, name="Asm", nodes=None):
    """An import kept as ONE body (`explode: false`), as the field file's was."""
    f = {"id": "imp", "type": "import", "format": "step", "name": name,
         "brep": builder._shape_to_brep_b64(shape), "explode": False}
    if nodes:
        f["nodes"] = nodes
    return f


def box_feats(idx, w, h, d, x=0, y=0):
    """sketch + extrude: a w x h x d box standing on z=0 at (x, y)."""
    s = f"s{idx}"
    return [{"id": s, "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]},
            {"id": f"e{idx}", "type": "extrude", "sketch": s, "distance": d, "operation": "new"}]


def rebuild(features, params=None, snapshots=None):
    diag = []
    _p, errs, bodies = builder.rebuild({"parameters": params or {}, "features": features},
                                       diagnostics=diag, snapshots_out=snapshots)
    return errs, bodies, diag


def solids_of(b):
    return builder._as_compound(b["shape"]).solids()


def vol(b):
    return round(sum(s.volume for s in solids_of(b)), 6)


def free_shells(b):
    return [p for p in builder._split_parts(builder._as_compound(b["shape"]).wrapped)
            if p.ShapeType() == TopAbs_SHELL]


def overlapping_solid(x=0.0):
    """ONE solid holding two overlapping 10 mm cubes as two outer shells: invalid
    to BRepCheck, 2,000 mm3 by the kernel's own volume. The shape of the field
    file's damaged parts (body201 is a compound of duplicate, overlapping,
    invalid solids). Measured: the splitter "succeeds" on it with 500 + 500 +
    1,000 mm3 — the volume adds up, and one of the three pieces still straddles
    the plane — so only the validity screen stops it."""
    bb = BRep_Builder()
    so = TopoDS_Solid()
    bb.MakeSolid(so)
    for dx in (0.0, 3.0):
        e = TopExp_Explorer((Pos(x + dx, 0, 0) * Box(10, 10, 10)).wrapped, TopAbs_SHELL)
        bb.Add(so, e.Current())
    return Solid(so)


def open_box_shell(x=0.0):
    """A 10 mm box with its top face missing, as a free SHELL (z -5..5)."""
    bb = BRep_Builder()
    sh = TopoDS_Shell()
    bb.MakeShell(sh)
    e = TopExp_Explorer((Pos(x, 0, 0) * Box(10, 10, 10)).wrapped, TopAbs_FACE)
    while e.More():
        if Face(e.Current()).center().Z < 4.9:  # every face but the top one
            bb.Add(sh, e.Current())
        e.Next()
    return sh


def test_plane_on_the_boundary_separates_and_says_so():
    """Thomas's Q1: a plane that cuts through no material SEPARATES the parts on
    each side and says so, as a warning, not an error."""
    stacked = Compound([Pos(0, 0, -5) * Box(10, 10, 10), Pos(0, 0, 5) * Box(10, 10, 10)])
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, diag = rebuild([whole_import(stacked), sp])
    check("Q1: a plane on the boundary between parts is not an error", not errs, errs)
    check("Q1: the parts on each side are separated", len(bodies) == 2, len(bodies))
    check("Q1: nothing is lost", round(sum(vol(b) for b in bodies), 6) == 2000.0,
          [vol(b) for b in bodies])
    warn = [d for d in diag if d.get("code") == "splitSeparated"]
    check("Q1: it says so, as a warning naming the body",
          len(warn) == 1 and warn[0]["body_id"] == "body1" and "{body}" in warn[0]["reason"]
          and warn[0]["subject"] == "Asm" and warn[0]["lossy"] is False, warn)
    check("Q1: the first piece keeps the id and name, the second is '<name> (2)'",
          [(b["id"], b["name"]) for b in bodies] == [("body1", "Asm"), ("body2", "Asm (2)")],
          [(b["id"], b["name"]) for b in bodies])


def test_damaged_parts_are_left_whole_with_a_warning():
    """Thomas's Q3: a damaged part the plane crosses is left whole, everything
    else is cut, and a warning names the body and the count. Never repaired."""
    body = Compound([Box(10, 10, 10), overlapping_solid(x=40)])
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, diag = rebuild([whole_import(body), sp])
    check("Q3: cutting the rest is not an error", not errs, errs)
    vols = sorted(round(s.volume, 6) for b in bodies for s in solids_of(b))
    check("Q3: the good part is cut in two, the damaged one is left WHOLE",
          vols == [500.0, 500.0, 2000.0], vols)
    warn = [d for d in diag if d.get("code") == "splitDamagedParts"]
    check("Q3: a warning names the body and how many parts were left uncut",
          len(warn) == 1 and warn[0]["body_id"] == "body1" and warn[0]["count"] == 1
          and "{body}" in warn[0]["reason"] and warn[0].get("subject") == "Asm", warn)

    # keep=top must not delete the damaged part for sitting below: it was not
    # cut, so it is kept whole rather than thrown away with the other side.
    low = Compound([Box(10, 10, 10), Pos(0, 0, -3) * overlapping_solid(x=40)])
    sp_top = dict(sp, keep="top")
    errs, bodies, _d = rebuild([whole_import(low), sp_top])
    vols = sorted(round(s.volume, 6) for b in bodies for s in solids_of(b))
    check("Q3: keep=top keeps a damaged part whole instead of dropping it",
          not errs and vols == [500.0, 2000.0], (errs, vols))

    # Only damaged parts cross: nothing would change, so it is an error in words.
    errs, bodies, _d = rebuild([whole_import(overlapping_solid()), sp])
    check("Q3: a split that can only reach damaged parts refuses in words",
          [e.get("code") for e in errs] == ["splitDamaged"] and errs[0]["body_id"] == "body1"
          and "{body}" in errs[0]["message"], errs)
    check("Q3: ...and leaves the body exactly as it was",
          len(bodies) == 1 and vol(bodies[0]) == 2000.0, [vol(b) for b in bodies])


def test_a_split_that_changes_nothing_says_so():
    """The no-op guard: the plane misses the body, or lies on one of its faces."""
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}
    above = box_feats(1, 10, 10, 10)  # z 0..10: its bottom face lies on z=0
    missed = [{"id": "s1", "type": "sketch", "plane": plane_z(20),
               "entities": [{"type": "rectangle", "width": 10, "height": 10}]},
              {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"}]
    errs, bodies, _d = rebuild(missed + [sp])
    check("a plane that misses the body is an error, not a green chip",
          [e.get("code") for e in errs] == ["splitMissed"] and errs[0]["body_id"] == "body1", errs)
    check("...and the body is untouched", len(bodies) == 1 and vol(bodies[0]) == 1000.0)
    errs, bodies, _d = rebuild(above + [sp])
    check("a plane lying on the body's face says so",
          [e.get("code") for e in errs] == ["splitOnFace"] and "{body}" in errs[0]["message"], errs)
    for e in errs:
        check("no kernel internals reach the user", "TopoDS" not in e["message"], e["message"])


def test_cut_all_leaves_uncut_bodies_exactly_as_they_were():
    """Thomas's Q2, second half: bodies the plane does not cut are left EXACTLY
    as they are. body73 of the field file, wholly below the plane, used to come
    apart into one body per solid."""
    below = Compound([Box(4, 4, 4), Pos(20, 0, 0) * Box(4, 4, 4)])  # z -2..2, two parts
    feats = box_feats(1, 20, 20, 20, x=-60) + [whole_import(below)]
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(10), "keep": "both",
          "bodies": ["body1", "body2"], "allVisible": True, "groupSides": True}
    snaps = []
    errs, bodies, diag = rebuild(feats + [sp], snapshots=snaps)
    check("cut-all with a missed body is not an error", not errs, errs)
    check("the crossing body is cut, the missed one is not broken up",
          [(b["id"], len(solids_of(b))) for b in bodies]
          == [("body1", 1), ("body2", 2), ("body3", 1)],
          [(b["id"], len(solids_of(b))) for b in bodies])
    before = {b["id"]: b["shape"] for b in dict(snaps)[len(feats) - 1]["bodies"]}
    after = {b["id"]: b["shape"] for b in dict(snaps)[len(feats)]["bodies"]}
    check("the missed body is the very same shape (not re-wrapped)", after["body2"] is before["body2"])
    rec = [d for d in diag if d.get("code") == "splitMissed"]
    check("the miss is recorded per body, as a record (no reason, so no amber chip)",
          len(rec) == 1 and rec[0]["body_id"] == "body2" and "reason" not in rec[0], rec)

    # A body listed twice is cut once, not twice from the same plan.
    errs, dup, _d = rebuild(feats + [dict(sp, bodies=["body1", "body1", "body2"])])
    check("a body listed twice is cut once",
          not errs and [(b["id"], vol(b)) for b in dup] == [(b["id"], vol(b)) for b in bodies],
          [(b["id"], vol(b)) for b in dup])

    # Nothing cut anywhere: an error, and the body list is untouched.
    sp2 = dict(sp, plane=plane_z(50))
    errs, bodies, _d = rebuild(feats + [sp2])
    check("a cut-all that cuts nothing is an error",
          [e.get("code") for e in errs] == ["splitMissedAll"], errs)
    check("...and changes nothing", [(b["id"], len(solids_of(b))) for b in bodies]
          == [("body1", 1), ("body2", 2)])


def test_a_failing_body_leaves_the_whole_cut_undone():
    """A2: compute everything, then commit. The field file's cut-all left the
    bodies before the failing one cut (65 to 69 stray pieces) and never reached
    the ones after it."""
    feats = box_feats(1, 10, 10, 20) + box_feats(2, 10, 10, 20, x=30) + box_feats(3, 10, 10, 20, x=60)
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(10), "keep": "both",
          "bodies": ["body1", "body2", "body3"], "groupSides": True}
    real = builder._split_body
    calls = []

    def flaky(shape, plane, tool):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("Standard_Failure")  # what a kernel exception looks like here
        return real(shape, plane, tool)

    builder._split_body = flaky
    try:
        errs, bodies, _d = rebuild(feats + [sp])
    finally:
        builder._split_body = real
    check("the failure is named, coded and in words",
          [e.get("code") for e in errs] == ["splitFailed"] and errs[0]["body_id"] == "body2"
          and "Standard_Failure" not in errs[0]["message"] and "{body}" in errs[0]["message"], errs)
    check("the body list is exactly as it was: nothing half cut",
          [(b["id"], vol(b)) for b in bodies] == [("body1", 2000.0), ("body2", 2000.0), ("body3", 2000.0)],
          [(b["id"], vol(b)) for b in bodies])


def test_shells_are_cut_and_kept():
    """A free shell crossing the plane is cut into shells, not dropped (the old
    split kept only solids) and not exploded into loose faces."""
    body = Compound([Box(10, 10, 10), Shell(open_box_shell(x=40))])
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, _d = rebuild([whole_import(body), sp])
    shells = [s for b in bodies for s in free_shells(b)]
    area = round(sum(builder.Shell(s).area for s in shells), 6)
    check("shells survive the cut", not errs and len(shells) == 2, (errs, len(shells)))
    check("the shell's whole area is still there (500 mm2)", area == 500.0, area)
    check("and the solid beside it is cut as usual",
          sorted(round(s.volume, 6) for b in bodies for s in solids_of(b)) == [500.0, 500.0])


def test_pieces_carry_the_bodys_state():
    """New pieces inherit node_ref, the debris exemption, textures and face
    colours, the way Separate's pieces do."""
    two = Compound([Box(10, 10, 10), Pos(40, 0, 0) * Box(10, 10, 10)])
    nodes = [{"name": "Case", "parent": None}]
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}
    snaps = []
    errs, bodies, _d = rebuild([whole_import(two, nodes=nodes), sp], snapshots=snaps)
    check("two parts cut through give four pieces", not errs and len(bodies) == 4, (errs, len(bodies)))
    check("every piece keeps the assembly node", {b.get("node_ref") for b in bodies} == {"imp/0"},
          [b.get("node_ref") for b in bodies])
    check("pieces are named after the body",
          [b["name"] for b in bodies] == ["Case", "Case (2)", "Case (3)", "Case (4)"],
          [b["name"] for b in bodies])
    last = dict(snaps)[1]["bodies"]
    check("every piece keeps the debris exemption", all(b.get("_intact") for b in last),
          [b.get("_intact") for b in last])
    check("every new piece says which body it came from, and its number",
          [b.get("piece_of") for b in bodies] == [None, ["body1", 2], ["body1", 3], ["body1", 4]],
          [b.get("piece_of") for b in bodies])


def test_a_pieces_lineage_reaches_the_app_and_survives_a_reopen():
    """The app names a piece of a renamed body "<rename> (n)" from its lineage,
    so the lineage has to be on the wire, on an unchanged stub too, and in the
    disk checkpoint a reopened assembly resumes from."""
    import shutil
    import tempfile

    import geomstore
    import server

    two = Compound([Box(10, 10, 10), Pos(40, 0, 0) * Box(10, 10, 10)])
    doc = {"parameters": {}, "features": [
        whole_import(two),
        {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}]}
    saved = builder._CACHE
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    try:
        res = server._rebuild_job(doc, 0.1)
        wire = [(b["id"], b.get("pieceOf")) for b in res["bodies"]]
        check("pieceOf is on the wire", wire[1:] == [("body2", ["body1", 2]), ("body3", ["body1", 3]), ("body4", ["body1", 4])]
              and wire[0] == ("body1", None), wire)
        known = {b["id"]: b["etag"] for b in res["bodies"]}
        res2 = server._rebuild_job(doc, 0.1, known=known)
        stubs = [(b.get("unchanged"), b.get("pieceOf")) for b in res2["bodies"]]
        check("...and on an unchanged stub", stubs[1] == (True, ["body1", 2]), stubs)
    finally:
        builder._CACHE = saved
    tmp = tempfile.mkdtemp(prefix="sindri_piece_of_")
    try:
        store = geomstore.Store(root=tmp)
        keys = builder._chain_keys_scoped(doc, builder._feature_sigs(doc["features"]))
        builder.rebuild(doc, diagnostics=[], persist={"store": store, "keys": keys, "mod": {},
                                                     "acc_ms": 0.0, "budget_ms": 0.0})
        hit = builder._restore_from_disk(store, keys)
        restored = [b.get("piece_of") for b in hit[1]["bodies"]] if hit else None
        check("a disk-checkpoint resume keeps every piece's lineage",
              restored == [None, ["body1", 2], ["body1", 3], ["body1", 4]], restored)
        store.db.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_the_cut_follows_its_face_and_offset():
    """A5: `face` anchors the plane to a face and re-derives it each rebuild;
    `offset` moves it along the normal. Moving the face moves the cut."""
    feats = [{"id": "s1", "type": "sketch", "plane": "XY",
              "entities": [{"type": "rectangle", "width": 20, "height": 20}]},
             {"id": "e1", "type": "extrude", "sketch": "s1", "distance": "h", "operation": "new"}]
    sp = {"id": "sp", "type": "split", "plane": plane_z(20), "keep": "top", "body": "body1",
          "face": {"kind": "face", "by": "nearest", "point": [5, 5, 20], "body": "body1"},
          "offset": -5}
    for h, want_z in ((20, 15.0), (30, 25.0)):
        errs, bodies, _d = rebuild(feats + [sp], params={"h": h})
        zmin = round(builder._as_compound(bodies[0]["shape"]).bounding_box().min.Z, 6)
        check(f"height {h}: the cut sits 5 mm under the top face (z={want_z})",
              not errs and zmin == want_z and vol(bodies[0]) == 2000.0, (errs, zmin, vol(bodies[0])))
    errs, _b, _d = rebuild(feats + [dict(sp, offset=0)], params={"h": 20})
    check("with no offset the plane lies on the face, and says so",
          [e.get("code") for e in errs] == ["splitOnFace"], errs)
    # An offset on a datum split (planeId), for the offset arrow on a datum.
    dat = [{"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 10}]
    sp2 = {"id": "sp", "type": "split", "planeId": "dp", "offset": 5, "keep": "top", "body": "body1"}
    errs, bodies, _d = rebuild(feats + dat + [sp2], params={"h": 20})
    zmin = round(builder._as_compound(bodies[0]["shape"]).bounding_box().min.Z, 6)
    check("an offset rides on a datum plane too", not errs and zmin == 15.0, (errs, zmin))


def test_a_long_cut_all_keeps_the_heartbeat_moving():
    """One tick per target body, so the 60 s stall watchdog never mistakes a big
    cut-all for a wedged worker (the field file's cut-all walks 328 bodies)."""
    feats = []
    for i in range(6):
        feats += box_feats(i + 1, 5, 5, 5 if i else 20, x=20 * i)
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(10), "keep": "both",
          "bodies": [f"body{i + 1}" for i in range(6)], "groupSides": True}
    ticks = []
    prev = builder.on_feature_tick
    builder.on_feature_tick = ticks.append
    try:
        errs, bodies, _d = rebuild(feats + [sp])
    finally:
        builder.on_feature_tick = prev
    idx = len(feats)
    first, last = ticks.index(idx), len(ticks) - 1 - ticks[::-1].index(idx)
    inside = [t for t in ticks[first:last] if t == builder.HB_KEEP_INDEX]
    check("the cut built", not errs and len(bodies) == 7, (errs, len(bodies)))
    check("at least one liveness tick per target body", len(inside) >= 6, len(inside))


def test_a_split_that_does_not_add_up_is_not_taken():
    """The volume backstop behind the validity screen: pieces that do not add
    back up to the part mean the kernel did not really split it. Field file: an
    invalid solid came back as a whole copy of itself plus its lower half."""
    real = builder._run_splitter

    def duplicating(w, tool):
        res = real(w, tool)
        lower = [p for p in builder._split_parts(res) if builder._wrap_topods(p).center().Z < 10]
        return Compound([Solid(w)] + [Solid(p) for p in lower]).wrapped

    builder._run_splitter = duplicating
    try:
        errs, bodies, _d = rebuild(box_feats(1, 10, 10, 20) + [
            {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(10), "keep": "both", "body": "body1",
             "groupSides": True}])
    finally:
        builder._run_splitter = real
    check("a split whose pieces duplicate material is refused, not committed",
          [e.get("code") for e in errs] == ["splitDamaged"], errs)
    check("...and the body is left whole", len(bodies) == 1 and vol(bodies[0]) == 2000.0,
          [vol(b) for b in bodies])


def test_a_split_crash_does_not_blame_a_fillet():
    """A worker that segfaults on a split used to be reported as "often a cut
    that runs exactly tangent to a fillet" (field report: body201, split whole,
    crashed the kernel). A split has no fillet; the advice sent the user after
    the wrong cause."""
    import server

    doc = {"features": [{"id": "bx", "type": "box"}, {"id": "sp", "type": "split", "name": "Split 1"}]}
    res = server._crash_feature({"error": {"message": "the geometry kernel crashed on this operation",
                                           "feature_index": 1}}, doc)
    msg = res["error"]["message"]
    check("a split crash names the split and gives split advice",
          res["error"].get("feature_id") == "sp" and "fillet" not in msg and "Split" in msg, msg)
    check("...coded, so the app shows it in the user's language",
          res["error"].get("code") == "splitCrashed", res["error"])
    # An old split still cuts each body whole, and that is where body201 died:
    # "on one of the parts it cuts" named the wrong place.
    check("...and does not claim the kernel died on a single part", "part" not in msg, msg)
    res = server._crash_feature({"error": {"message": "x", "feature_index": 0}}, doc)
    check("other features keep their crash message", "fillet" in res["error"]["message"],
          res["error"]["message"])


# --- old documents ---------------------------------------------------------------

def legacy(**kw):
    """A split as the app wrote it BEFORE the Split Body panel: no `offset`, no
    `face` (the panel always writes `offset`)."""
    return dict({"id": "sp", "type": "split", "keep": "both", "body": "body1"}, **kw)


def centre(b):
    c = builder._as_compound(b["shape"]).bounding_box().center()
    return (round(c.X, 3), round(c.Z, 3))


def test_an_old_split_puts_every_piece_where_it_always_was():
    """Body ids are positional, so an old document must get the same piece
    behind every id, not just the same number of them. The old code took the
    pieces in the order ONE whole-body kernel call returned them, which is not
    the parts' order: two boxes at x=0 and x=40 came back as (40 top, 0 top,
    40 bottom, 0 bottom). A later removeBody of body2 then deletes the TOP of
    the box at x=0, and must go on deleting exactly that."""
    two = Compound([Box(10, 10, 10), Pos(40, 0, 0) * Box(10, 10, 10)])
    feats = [whole_import(two), legacy(plane=XY0, groupSides=True),
             {"id": "rm", "type": "removeBody", "bodies": ["body2"]}]
    errs, bodies, _d = rebuild(feats)
    check("an old two-part split still builds", not errs, errs)
    check("the same pieces survive the removeBody as before (x=0 TOP is the one removed)",
          [(b["id"], centre(b), b["name"]) for b in bodies]
          == [("body1", (40.0, 2.5), "Asm"), ("body3", (40.0, -2.5), "Split"), ("body4", (0.0, -2.5), "Split")],
          [(b["id"], centre(b), b["name"]) for b in bodies])


def test_an_old_split_keeps_its_old_body_count():
    """What the old whole-body computation emitted, it still emits: only solids
    (a free shell beside them was dropped, so no extra body shifts every id
    after it), and parts that touch come back as ONE lump, because that kernel
    call imprinted them on each other."""
    body = Compound([Box(10, 10, 10), Shell(open_box_shell(x=40))])
    errs, bodies, _d = rebuild([whole_import(body), legacy(plane=XY0), {"id": "cy", "type": "cylinder", "radius": 3, "height": 5}])
    check("old keep=both beside a free shell: still two halves, then the cylinder as body3",
          not errs and [(b["id"], len(solids_of(b)), len(free_shells(b))) for b in bodies]
          == [("body1", 1, 0), ("body2", 1, 0), ("body3", 1, 0)],
          (errs, [(b["id"], len(solids_of(b)), len(free_shells(b))) for b in bodies]))
    errs, bodies, _d = rebuild([whole_import(pin_through_plate()), legacy(plane=plane_z(1), groupSides=True)])
    check("old groupSides: a pin touching its plate is one lump on each side, as before",
          not errs and sorted(len(solids_of(b)) for b in bodies) == [1, 1, 2, 2],
          (errs, [len(solids_of(b)) for b in bodies]))


def test_old_splits_get_the_new_guards_where_they_did_nothing():
    """The two changes the new rules may make to an old document: a split that
    changed nothing now says so, and a body the plane never reached is no
    longer broken up (body73 of the field file)."""
    errs, bodies, _d = rebuild(box_feats(1, 10, 10, 10) + [legacy(plane=plane_z(50))])
    check("an old split that missed its body is red now",
          [e.get("code") for e in errs] == ["splitMissed"] and len(bodies) == 1, errs)
    below = Compound([Pos(0, 0, -20) * Box(4, 4, 4), Pos(20, 0, -20) * Box(4, 4, 4)])
    feats = box_feats(1, 20, 20, 20, x=-60) + [whole_import(below)]
    errs, bodies, _d = rebuild(feats + [legacy(plane=plane_z(10), bodies=["body1", "body2"], groupSides=True)])
    check("an old cut-all no longer breaks up a body wholly below the plane",
          not errs and [(b["id"], len(solids_of(b))) for b in bodies]
          == [("body1", 1), ("body2", 2), ("body3", 1)],
          (errs, [(b["id"], len(solids_of(b))) for b in bodies]))


def open_solid(x=0.0):
    """A SOLID whose shell is the 10 mm box with its top face missing: invalid,
    and the kernel's volume for it is 800 mm3, not 1,000. Cut whole with a good
    box beside it (the old computation), the pieces come to 1,500 mm3 out of
    the 1,800 the body started with."""
    bb = BRep_Builder()
    so = TopoDS_Solid()
    bb.MakeSolid(so)
    bb.Add(so, open_box_shell(x))
    return Solid(so)


def test_an_old_split_that_was_red_stays_red():
    """An old split the old code REFUSED is not a silent no-op, so the new rules
    may not turn it into a cut: cut part by part it appends bodies, and every
    later body id in the old document moves with no word said. Measured before
    this rule: an open shell split at z=0, then a cylinder and a removeBody of
    body2; the split succeeded, the shell's lower half became body2, and the
    removeBody deleted half the surface instead of the cylinder."""
    feats = [whole_import(Compound([Shell(open_box_shell())]), name="Surf"),
             legacy(plane=XY0, groupSides=True),
             {"id": "cy", "type": "cylinder", "radius": 3, "height": 5},
             {"id": "rm", "type": "removeBody", "bodies": ["body2"]}]
    errs, bodies, _d = rebuild(feats)
    check("an old split the old code refused (a body of surfaces) is still red, coded",
          [(e.get("feature_id"), e.get("code"), e.get("body_id")) for e in errs]
          == [("sp", "splitLegacyFailed", "body1")] and "{body}" in errs[0]["message"], errs)
    check("...and the body list is the old one: the cylinder is body2, and is the body removed",
          [(b["id"], b["name"], len(free_shells(b))) for b in bodies] == [("body1", "Surf", 1)],
          [(b["id"], b["name"], len(free_shells(b))) for b in bodies])
    # Where the per-part path ALSO changes nothing, its own sentence is kept.
    errs, bodies, _d = rebuild(box_feats(1, 10, 10, 10) + [legacy(plane=plane_z(50), keep="top")])
    check("an old keep=top whose kept side is empty says the plane misses the body",
          [e.get("code") for e in errs] == ["splitMissed"] and len(bodies) == 1, errs)


def test_an_old_cut_all_stops_where_the_old_code_stopped():
    """The old code stopped at the first body that raised; the bodies after it
    were never computed. On the field file the next one computed the old way
    (body201, cut whole) KILLS THE WORKER, so reaching it turned a red chip into
    a crashed rebuild and a reopened document with no bodies. Stand-in for the
    kernel's "Null TopoDS_Shape object": the old computation raising on the
    second of three boxes."""
    feats = (box_feats(1, 10, 10, 10) + box_feats(2, 10, 10, 10, x=40) + box_feats(3, 10, 10, 10, x=80)
             + [legacy(plane=plane_z(5), bodies=["body1", "body2", "body3"], groupSides=True)])
    real = builder._legacy_split
    reached = []

    def null_on_the_second(shape, plane, keep):
        x = round(builder._as_compound(shape).bounding_box().center().X)
        reached.append(x)
        if x == 40:
            raise ValueError("Null TopoDS_Shape object")
        return real(shape, plane, keep)

    builder._legacy_split = null_on_the_second
    try:
        errs, bodies, _d = rebuild(feats)
    finally:
        builder._legacy_split = real
    check("the old cut-all is red on the body the old code failed on, in words",
          [(e.get("code"), e.get("body_id")) for e in errs] == [("splitLegacyFailed", "body2")]
          and "Null" not in errs[0]["message"], errs)
    check("...the bodies after it are never computed the old way", reached == [0, 40], reached)
    check("...and nothing was changed", [(b["id"], vol(b)) for b in bodies]
          == [("body1", 1000.0), ("body2", 1000.0), ("body3", 1000.0)], [(b["id"], vol(b)) for b in bodies])


def test_an_old_split_that_destroys_material_says_so():
    """The old computation cuts damaged solids as if they were whole, and on the
    field file that destroyed or duplicated material with no word (body36
    8,349.8 mm3 to 1.4). It is committed exactly as before, so no id moves, and
    said: an amber warning naming the body."""
    body = Compound([Box(10, 10, 10), Pos(40, 0, 0) * open_solid()])
    errs, bodies, diag = rebuild([whole_import(body), legacy(plane=XY0, groupSides=True)])
    check("the old split still builds, as before", not errs and len(bodies) == 3,
          (errs, [(b["id"], b["name"]) for b in bodies]))
    warn = [d for d in diag if d.get("code") == "splitLegacyVolume"]
    check("...and says the pieces do not add up, naming the body",
          len(warn) == 1 and warn[0]["body_id"] == "body1" and "{body}" in warn[0]["reason"]
          and warn[0]["subject"] == "Asm", warn)
    errs, _b, diag = rebuild([whole_import(Compound([Box(10, 10, 10)])), legacy(plane=XY0)])
    check("a sound old split says nothing", not errs and not [d for d in diag if d.get("reason")], (errs, diag))
    # The check is only a report: the kernel failing to MEASURE must not read as
    # the old computation failing, which would turn an old split that built red.
    real = builder._solid_volume

    def unmeasurable(w):
        raise RuntimeError("Standard_Failure")

    builder._solid_volume = unmeasurable
    try:
        errs, bodies, _d = rebuild([whole_import(Compound([Box(10, 10, 10)])), legacy(plane=XY0)])
    finally:
        builder._solid_volume = real
    check("...and a volume the kernel cannot measure leaves the old split building",
          not errs and len(bodies) == 2, (errs, len(bodies)))


def test_a_body_the_split_names_that_is_gone_is_said():
    """Ids the split names that are not there at its place in the timeline (an
    upstream edit removed their bodies; "All visible" freezes its ids at OK)
    were dropped without a word, and when none was left the error was the raw,
    untranslated "Split needs an existing body"."""
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(5), "keep": "both", "groupSides": True}
    errs, bodies, diag = rebuild(box_feats(1, 10, 10, 10) + [dict(sp, bodies=["body1", "body7", "body7"])])
    check("the bodies that are there are cut", not errs and len(bodies) == 2, errs)
    gone = [d for d in diag if d.get("code") == "splitBodiesGone"]
    check("...and the one that is gone is counted, in a warning",
          len(gone) == 1 and gone[0]["count"] == 1 and gone[0].get("reason"), gone)
    for missing in (dict(sp, body="body7"), dict(sp, bodies=["body7", "body8"])):
        errs, bodies, _d = rebuild(box_feats(1, 10, 10, 10) + [missing])
        check("nothing to cut at all: coded, and names no internal id",
              [e.get("code") for e in errs] == ["splitNoBody"] and "body7" not in errs[0]["message"]
              and len(bodies) == 1, errs)


# --- the same answer however the body got here --------------------------------

def test_a_part_lying_in_the_plane_goes_above_by_rule():
    """A part lying IN the plane has no side; its reach either way is float
    noise, and noise read off a triangulation changed once the body had been
    meshed (field file: 359 bodies when the split was made, 358 on a cold
    reopen). So it goes above by rule, even with slightly more of it below."""
    slab = Pos(40, 0, -0.0001) * Box(10, 10, 0.0006)  # z -0.0004 .. +0.0002: in the band
    body = Compound([Pos(0, 0, 5) * Box(10, 10, 10), Pos(0, 0, -5) * Box(10, 10, 10), slab])
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, _d = rebuild([whole_import(body), sp])
    check("the in-plane slab is sorted ABOVE (body2, between the upper box and the lower one)",
          not errs and [(b["id"], centre(b)) for b in bodies]
          == [("body1", (0.0, 5.0)), ("body2", (40.0, 0.0)), ("body3", (0.0, -5.0))],
          (errs, [(b["id"], centre(b)) for b in bodies]))


def in_plane_sliver():
    """A part lying IN the plane (z -0.4 .. +0.45 micron), with a flat bottom and
    a curved top: a sliver of a 1 m cylinder lying along X. ASYMMETRIC between
    the two boxes, the way the field file's in-plane solids were: the box read
    from the geometry puts slightly more of it ABOVE (lo+hi = +5.0e-05) and the
    box read from its triangulation slightly more BELOW (-4.4e-05, the mesh
    misses the crown of the arc). Measured with the mesh the test makes."""
    r, a, b = 1000.0, 0.0004, 0.00045
    arc = Pos(0, 0, b - r) * Rot(0, 90, 0) * Cylinder(r, 10)
    return Pos(40, 0, 0) * (arc & (Pos(0, 0, 50 - a) * Box(200, 200, 100)))


def test_a_cold_build_and_a_meshed_one_give_the_same_bodies():
    """The same document must give the same body list whether the bodies were
    ever displayed or not. Displaying meshes a body, and nothing that decides
    where a piece goes may read that mesh.

    Two rules hold it, and this fails only with BOTH broken: the in-plane
    sliver's side is read off a box NEVER built from the triangulation
    (_plane_extent), and a part lying in the plane goes above by rule whatever
    its box says (_split_side). Measured as the control: with
    `BRepBndLib.Add_s(local, bb, True)` in _plane_extent and the in-band rule
    removed, the meshed build puts the sliver BELOW, so it moves from body2 to
    body4 and every body between renumbers. With only the first rule broken the
    body list survives (the in-band rule masks it), so the last check reads the
    reach itself; the in-band rule alone is guarded by the test above."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh

    body = Compound([Pos(0, 0, 5) * Box(10, 10, 10), Pos(0, 0, -5) * Box(10, 10, 10), in_plane_sliver(),
                     Pos(80, 0, 0) * Cylinder(4, 10)])
    head = [whole_import(body)]
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}
    _e, cold, _d = rebuild(head + [sp])
    saved = builder._CACHE
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    try:
        _p, _e, shown = builder.rebuild_cached({"parameters": {}, "features": head})
        for b in shown:
            BRepMesh_IncrementalMesh(builder._as_compound(b["shape"]).wrapped, 0.05, False, 0.3, True)
        _p, _e, warm = builder.rebuild_cached({"parameters": {}, "features": head + [sp]})
    finally:
        builder._CACHE = saved
    summ = lambda bs: [(b["id"], len(solids_of(b)), round(vol(b), 3), centre(b)) for b in bs]
    check("cold and after-meshing give the same body list", summ(cold) == summ(warm),
          (summ(cold), summ(warm)))
    # The first rule on its own, which the in-band rule masks in the body list.
    from build123d import Plane

    sliver = in_plane_sliver().wrapped
    frame = builder._plane_frame(Plane.XY)
    before = builder._plane_extent(sliver, frame)
    BRepMesh_IncrementalMesh(sliver, 0.05, False, 0.3, True)
    after = builder._plane_extent(sliver, frame)
    check("a part's reach is read from its geometry, never from its mesh", after == before, (before, after))


# --- tilted planes ---------------------------------------------------------------

S2 = 2 ** -0.5
TILT = {"origin": [0, 0, 0], "normal": [S2, 0, S2], "xdir": [S2, 0, -S2]}


def test_a_tilted_plane_measures_reach_along_its_normal():
    """Reach along a tilted normal is measured in the plane's own frame. A world
    box projected onto it overstates by millimetres: a damaged part lying 4 mm
    clear read as crossing (and keep=bottom KEPT it though it sits above), and a
    0.2 mm3 sliver of a turned cube counted as a cut, a body of its own with no
    word said."""
    dmg = Pos(49 * S2, 0, -31 * S2) * Rot(0, 45, 0) * overlapping_solid()  # 4..14 mm above TILT
    body = Compound([Box(10, 10, 10), dmg])
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": TILT, "keep": "bottom", "body": "body1", "groupSides": True}
    errs, bodies, diag = rebuild([whole_import(body), sp])
    vols = sorted(round(s.volume, 3) for b in bodies for s in solids_of(b))
    check("keep=bottom drops a damaged part lying wholly above a tilted plane",
          not errs and vols == [500.0], (errs, vols))
    check("...and does not count it as a damaged part crossing the plane",
          not [d for d in diag if d.get("code") == "splitDamagedParts"], diag)
    errs, _b, _d = rebuild([whole_import(Compound([dmg])), dict(sp, keep="both")])
    check("alone, that damaged part is MISSED, not 'every part the plane crosses is damaged'",
          [e.get("code") for e in errs] == ["splitMissed"], errs)

    cube = Rot(30, 20, 0) * Box(20, 20, 20)
    top = max(cube.faces(), key=lambda fc: fc.normal_at().dot(Vector(0, 0, 1)))
    n, c = top.normal_at(), top.center()
    xd = (Vector(1, 0, 0) - n * Vector(1, 0, 0).dot(n)).normalized()
    plane = {"origin": list(tuple(c)), "normal": list(tuple(n)), "xdir": list(tuple(xd))}
    face = {"kind": "face", "by": "nearest", "point": list(tuple(c)), "body": "body1"}
    sliver = {"id": "sp", "type": "split", "plane": plane, "face": face, "offset": -0.0005,
              "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, _d = rebuild([whole_import(Compound([cube]), name="Blk"), sliver])
    check("a 0.5 micron cut into a turned cube is contact, not a cut: refused in words",
          [e.get("code") for e in errs] == ["splitOnFace"] and len(bodies) == 1,
          (errs, [vol(b) for b in bodies]))

    turned = Rot(0, 45, 0) * Box(20, 20, 20)
    reach = max(v.X * S2 + v.Z * S2 for v in turned.vertices())
    clear = dict(TILT, origin=[S2 * (reach + 3), 0, S2 * (reach + 3)])
    errs, _b, _d = rebuild([whole_import(Compound([turned]), name="Blk"),
                            {"id": "sp", "type": "split", "offset": 0, "plane": clear, "keep": "both",
                             "body": "body1", "groupSides": True}])
    check("a tilted plane 3 mm clear of the body MISSES it (not 'lies on a face')",
          [e.get("code") for e in errs] == ["splitMissed"], errs)


def test_a_surface_nearly_parallel_to_a_tilted_plane_is_cut():
    """One triangle 0.58 mm below to 1.73 mm above the plane x+y+z=0: its pieces
    were sorted by the midpoint of their WORLD boxes, both landed on one side,
    and the cut was thrown away as 'the plane lies on a face'."""
    k = 3 ** -0.5
    tri = Face(Wire(Polyline((-20, 10, 9), (10, -20, 11), (10, 10, -17), close=True).edges()))
    bb = BRep_Builder()
    sh = TopoDS_Shell()
    bb.MakeShell(sh)
    bb.Add(sh, tri.wrapped)
    plane = {"origin": [0, 0, 0], "normal": [k, k, k], "xdir": [S2, -S2, 0]}
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane, "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, _d = rebuild([whole_import(Compound([Shell(sh)]), name="Mesh"), sp])
    area = round(sum(fc.area for b in bodies for fc in builder._as_compound(b["shape"]).faces()), 6)
    check("the triangle is cut in two, and none of it is lost",
          not errs and len(bodies) == 2 and area == round(tri.area, 6), (errs, len(bodies), area))


# --- what a piece is ---------------------------------------------------------------

def pin_through_plate():
    """A plate with a hole and a pin filling it, touching along the hole's wall
    and nowhere sharing a vertex (the pin is turned, so its seam is elsewhere),
    plus a separate block."""
    plate = Box(40, 40, 4) - Cylinder(3, 10)
    pin = Rot(0, 0, 37) * Cylinder(3, 20)
    return Compound([plate, pin, Pos(30, 30, 0) * Box(4, 4, 4)])


def test_parts_that_touch_stay_one_body():
    """Keep Both gives one body per connected lump (Thomas, Q2). Split part by
    part, nothing imprints touching parts on each other, so they share no vertex;
    they are one lump because they touch. Field file: body314 gave 45 bodies
    where the old code gave 33."""
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(1), "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, _d = rebuild([whole_import(pin_through_plate()), sp])
    check("pin + plate is one body on each side, the block its own on each side",
          not errs and [len(solids_of(b)) for b in bodies] == [2, 1, 2, 1],
          (errs, [len(solids_of(b)) for b in bodies]))


def test_a_compsolid_is_cut_through():
    """A COMPSOLID came back from the splitter as one compsolid holding both
    halves, sorted to a single side, and was reported as 'the plane lies on a
    face' although the plane went straight through it."""
    bb = BRep_Builder()
    cs = TopoDS_CompSolid()
    bb.MakeCompSolid(cs)
    bb.Add(cs, Box(10, 10, 10).solids()[0].wrapped)
    bb.Add(cs, (Pos(0, 0, 10) * Box(10, 10, 10)).solids()[0].wrapped)
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(2), "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, _d = rebuild([whole_import(Compound(cs)), sp])
    check("a compsolid is cut, and nothing is lost",
          not errs and len(bodies) == 2 and round(sum(vol(b) for b in bodies), 6) == 2000.0
          and sorted(vol(b) for b in bodies) == [700.0, 1300.0],
          (errs, [vol(b) for b in bodies]))


def test_keeping_one_side_of_a_separation_says_what_it_removed():
    """With Above or Below, a plane lying between the parts DELETES the other
    side's parts. 'The plane only separated them' would tell the user they are
    still there."""
    stacked = Compound([Pos(0, 0, -5) * Box(10, 10, 10), Pos(0, 0, 5) * Box(10, 10, 10)])
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "top", "body": "body1", "groupSides": True}
    errs, bodies, diag = rebuild([whole_import(stacked), sp])
    check("keep=top keeps the upper part only", not errs and [vol(b) for b in bodies] == [1000.0]
          and centre(bodies[0]) == (0.0, 5.0), (errs, [vol(b) for b in bodies]))
    codes = [d.get("code") for d in diag if d.get("reason")]
    check("...and says it removed the other side's parts", codes == ["splitSeparatedKept"], diag)


# --- the plane -------------------------------------------------------------------

def test_a_face_anchored_split_reports_where_its_face_is():
    """Re-opened in the panel, a face-anchored split must start from where the
    face IS. Only the rebuild knows that, so it reports it in `planes`, as it
    does for face-anchored sketches and datums."""
    feats = [{"id": "s1", "type": "sketch", "plane": "XY",
              "entities": [{"type": "rectangle", "width": 20, "height": 20}]},
             {"id": "e1", "type": "extrude", "sketch": "s1", "distance": "h", "operation": "new"}]
    sp = {"id": "sp", "type": "split", "plane": plane_z(20), "keep": "top", "body": "body1",
          "face": {"kind": "face", "by": "nearest", "point": [5, 5, 20], "body": "body1"}, "offset": -5}
    planes = {}
    builder.rebuild({"parameters": {"h": 30}, "features": feats + [sp]}, diagnostics=[], planes=planes)
    got = planes.get("sp")
    check("the split's face plane comes back at the face (z=30), before the offset",
          got is not None and abs(got["origin"][2] - 30.0) < 1e-6, got)


def test_a_plane_that_is_not_there_yet_is_refused_in_words():
    """A datum made AFTER the split does not exist where the split runs. The
    raw 'unknown plane reference: dp' put an internal id in front of the user."""
    feats = box_feats(1, 10, 10, 20) + [
        {"id": "sp", "type": "split", "planeId": "dp", "offset": 0, "keep": "top", "body": "body1"},
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 10}]
    errs, _b, _d = rebuild(feats)
    check("a datum later in the timeline: coded, in words",
          [e.get("code") for e in errs] == ["splitNoPlane"] and "dp" not in errs[0]["message"], errs)
    face_only = box_feats(1, 10, 10, 20) + [
        {"id": "sp", "type": "split", "offset": 0, "keep": "top", "body": "body1",
         "face": {"kind": "face", "by": "nearest", "point": [0, 0, 20], "body": "body1"}}]
    errs, _b, _d = rebuild(face_only)
    check("a face anchor with no saved plane: the same coded refusal",
          [e.get("code") for e in errs] == ["splitNoPlane"], errs)


def test_a_face_whose_body_is_gone_says_it_is_the_planes_face():
    """A face-anchored split whose face belongs to a body that is not there at
    its place in the timeline (a removeBody upstream, an edit to fewer pieces).
    It raised the uncoded, untranslated "Split: the target body no longer
    exists", which reads as the body being SPLIT being gone, while that body
    is right there and it is the plane's face that went."""
    feats = box_feats(1, 10, 10, 20) + [
        {"id": "sp", "type": "split", "plane": plane_z(20), "offset": -5, "keep": "top", "body": "body1",
         "face": {"kind": "face", "by": "nearest", "point": [0, 0, 20], "body": "body9"}}]
    errs, bodies, _d = rebuild(feats)
    check("a split whose plane's face is gone: coded",
          [e.get("code") for e in errs] == ["splitFaceGone"], errs)
    check("...says it is the plane's face, not the body being split",
          errs and "face" in errs[0]["message"] and "target body" not in errs[0]["message"], errs)
    check("...and changes nothing", len(bodies) == 1 and vol(bodies[0]) == 2000.0, [vol(b) for b in bodies])


def test_an_explicit_pick_says_which_bodies_it_left_alone():
    """The contract with the panel: it writes `allVisible: true` only for "All
    visible bodies (N)". A body the user PICKED that the split leaves as it was
    (missed, or the plane only on its face) is said, naming it, as a warning.
    Only an all-visible cut, and an old "Cut all bodies" (a split with `bodies`
    saved before the panel: no offset, no face), keeps its misses quiet: a plane
    through an assembly misses most of it."""
    crossing = box_feats(1, 20, 20, 20, x=-60)                     # z 0..20: crosses z=10
    below = [whole_import(Compound([Box(4, 4, 4), Pos(20, 0, 0) * Box(4, 4, 4)]))]  # z -2..2
    on_face = box_feats(3, 10, 10, 10, x=60)                        # z 0..10: its top lies on z=10
    feats = crossing + below + on_face
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(10), "keep": "both",
          "bodies": ["body1", "body2", "body3"], "groupSides": True}

    def misses(diag):
        return [(d["body_id"], bool(d.get("reason"))) for d in diag if d.get("code") == "splitMissed"]

    errs, bodies, diag = rebuild(feats + [sp])
    check("an explicit pick cuts the body it crosses", not errs and len(bodies) == 4, (errs, len(bodies)))
    said = [d for d in diag if d.get("code") == "splitMissed"]
    check("...and warns about each picked body it left alone, naming it",
          misses(diag) == [("body2", True), ("body3", True)] and said[0].get("subject") == "Asm"
          and all("{body}" in d["reason"] for d in said), diag)
    check("...with the diagnostic's neutral shape (never lossy)",
          all(d["lossy"] is False and d["kind"] == "splitMissed" for d in diag if d.get("code") == "splitMissed"),
          diag)

    errs, _b, diag = rebuild(feats + [dict(sp, allVisible=True)])
    check("all visible bodies: the misses are records, no reason, so no chip",
          not errs and misses(diag) == [("body2", False), ("body3", False)], diag)

    old = {k: v for k, v in sp.items() if k != "offset"}
    errs, _b, diag = rebuild(feats + [old])
    check("an old 'Cut all bodies' (bodies, no offset, no face) stays as quiet as it was",
          not errs and [m[1] for m in misses(diag)] == [False, False], diag)


def test_a_cut_all_that_reaches_only_damaged_parts_names_the_body():
    """Q3: the damaged parts are named with their body and counted. A cut over
    several bodies whose only crossings are damaged parts changed nothing, so
    it is red, and the red message is all the user sees (a failed feature's
    warnings are not shown): it named no body and no count."""
    missed = box_feats(1, 10, 10, 10, x=-60)  # z 0..10, the plane is at z=20
    one = [whole_import(Compound([Pos(0, 0, 20) * overlapping_solid()]), name="Hinge")]
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(20), "keep": "both",
          "bodies": ["body1", "body2"], "allVisible": True, "groupSides": True}
    errs, bodies, _d = rebuild(missed + one + [sp])
    got = [(e.get("code"), e.get("body_id"), e.get("subject"), e.get("count")) for e in errs]
    check("one damaged body: the error names it and counts its parts",
          got == [("splitDamagedAll", "body2", "Hinge", 1)] and "{body}" in errs[0]["message"], errs)
    check("...and changes nothing", [(b["id"], vol(b)) for b in bodies] == [("body1", 1000.0), ("body2", 2000.0)],
          [(b["id"], vol(b)) for b in bodies])

    latch = dict(whole_import(Compound([Pos(40, 0, 20) * overlapping_solid(), Pos(80, 0, 20) * overlapping_solid()]),
                              name="Latch"), id="imp2")
    errs, _b, _d = rebuild(missed + one + [latch] + [dict(sp, bodies=["body1", "body2", "body3"])])
    got = [(e.get("code"), e.get("body_id"), e.get("count"), e.get("parts")) for e in errs]
    check("several damaged bodies: the first is named, with how many bodies and parts in all",
          got == [("splitDamagedAllMore", "body2", 2, 3)] and "{body}" in errs[0]["message"], errs)
    import server

    wire = server._err_entry(errs[0]) if errs else {}
    check("...and the numbers reach the app beside the code (the translation needs them)",
          (wire.get("count"), wire.get("parts")) == (2, 3), wire)


def brep_text(shape):
    """The body's B-rep as the kernel writes it: geometry, 2D curves and every
    tolerance, which is what a destructive kernel call writes into."""
    return builder._shape_to_brep_b64(builder._as_compound(shape))


def test_a_split_leaves_the_body_it_was_given_untouched():
    """OCCT's splitter is DESTRUCTIVE by default: it writes into the part it is
    handed. The part is the very TShape the RAM snapshots hold (they SHARE shape
    refs), so the next rebuild resuming from a snapshot cut a body the last one
    had already written into, the drift _legacy_split copies its body to avoid.
    Measured: a torus cut at z=0 (its seam circle lies in the plane) gains a 2D
    curve on the seam and the seam's tolerance grows from 1e-07 to
    1.00000000734788e-07 in the snapshot, run after run."""
    head = [whole_import(Compound([Torus(10, 3)]), name="Ring")]
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": XY0, "keep": "both", "body": "body1", "groupSides": True}
    saved = builder._CACHE
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    try:
        _p, _e, shown = builder.rebuild_cached({"parameters": {}, "features": head})
        before = brep_text(shown[0]["shape"])
        _p, e1, first = builder.rebuild_cached({"parameters": {}, "features": head + [sp]})
        after = brep_text(shown[0]["shape"])
        _p, e2, again = builder.rebuild_cached({"parameters": {}, "features": head + [dict(sp, name="Split again")]})
    finally:
        builder._CACHE = saved
    check("the torus is cut in two", not e1 and not e2 and len(first) == 2 and len(again) == 2, (e1, e2))
    check("the body the snapshot holds is exactly as it was before the split", after == before)
    check("the same split resumed from that snapshot gives the same pieces, byte for byte",
          [brep_text(b["shape"]) for b in first] == [brep_text(b["shape"]) for b in again])


def test_a_curved_surface_is_sided_by_where_it_is():
    """A free curved FACE (not in a shell) was sided by Face.center(), which on
    a curved face is the surface point at the middle of its UV box. For a piece
    of a cylinder cut on a slant that point is OFF the piece, on the far side
    of the plane: both pieces went above and the cut was thrown away as 'the
    plane lies on a face'. Measured: this cylinder's lower piece has its UV
    middle at (-10, 0, 9.5), 8.5 mm ABOVE the plane."""
    side = Cylinder(10, 20).faces().filter_by(GeomType.CYLINDER)[0]  # z -10..10
    k = 0.9
    n = Vector(-k, 0, 1).normalized()
    plane = {"origin": [0, 0, 0], "normal": list(tuple(n)), "xdir": list(tuple(Vector(1, 0, k).normalized()))}
    sp = {"id": "sp", "type": "split", "offset": 0, "plane": plane, "keep": "both", "body": "body1", "groupSides": True}
    errs, bodies, _d = rebuild([whole_import(Compound([side]), name="Sleeve"), sp])
    area = round(sum(fc.area for b in bodies for fc in builder._as_compound(b["shape"]).faces()), 6)
    check("a free cylindrical face cut on a slant gives two bodies, and none of it is lost",
          not errs and len(bodies) == 2 and area == round(side.area, 6), (errs, len(bodies), area))
    for b in bodies:
        lo, hi = builder._plane_extent(builder._as_compound(b["shape"]).wrapped,
                                       builder._plane_frame(builder._plane_of(plane, {})), optimal=True)
        check(f"{b['id']} lies on ONE side of the plane", hi < 1e-3 or lo > -1e-3, (lo, hi))


def test_every_kernel_phase_of_a_crossing_part_ticks_first():
    """One big part is one crossing part: the validity check, the splitter and
    the measures behind it each run seconds on a large import, back to back, and
    the heartbeat moved once for all of them. A tick between the phases is the
    only liveness the 60 s stall watchdog can see (OCCT holds the GIL inside a
    call, so nothing ticks WITHIN one)."""
    events = []
    real_split, real_vol, real_ext = builder._run_splitter, builder._solid_volume, builder._plane_extent

    def splitter(w, tool):
        events.append("split")
        return real_split(w, tool)

    def volume(w):
        events.append("volume")
        return real_vol(w)

    def extent(w, frame, optimal=False):
        if optimal:
            events.append("reach")
        return real_ext(w, frame, optimal)

    import OCP.BRepCheck as bc

    real_check = bc.BRepCheck_Analyzer

    def validity(w, *a):
        events.append("check")
        return real_check(w, *a)

    prev = builder.on_feature_tick
    builder.on_feature_tick = lambda i: events.append("tick")
    builder._run_splitter, builder._solid_volume, builder._plane_extent = splitter, volume, extent
    bc.BRepCheck_Analyzer = validity  # _split_body imports it at call time
    try:
        errs, bodies, _d = rebuild(box_feats(1, 10, 10, 20) + [
            {"id": "sp", "type": "split", "offset": 0, "plane": plane_z(10), "keep": "both", "body": "body1",
             "groupSides": True}])
    finally:
        bc.BRepCheck_Analyzer = real_check
        builder._run_splitter, builder._solid_volume, builder._plane_extent = real_split, real_vol, real_ext
        builder.on_feature_tick = prev
    check("the box is cut", not errs and len(bodies) == 2, errs)
    phases = [e for e in events if e != "tick"]
    # Collapse each phase to one entry, then ask whether a tick came between
    # the end of one phase and the start of the next.
    seq = [e for i, e in enumerate(events) if e == "tick" or i == 0 or events[i - 1] != e]
    s = seq.index("split")
    c = max(i for i in range(s) if seq[i] == "check")
    v = seq.index("volume", s)
    r = seq.index("reach", v)
    check("a tick between the validity check and the splitter", "tick" in seq[c + 1:s], seq)
    check("a tick between the splitter and the volume check", "tick" in seq[s + 1:v], seq)
    check("a tick between the volume check and the reach measures", "tick" in seq[v + 1:r], seq)
    check("(the phases ran: check, split, volume, reach)",
          {"check", "split", "volume", "reach"} <= set(phases), phases)


def main():
    test_plane_on_the_boundary_separates_and_says_so()
    test_damaged_parts_are_left_whole_with_a_warning()
    test_a_split_that_changes_nothing_says_so()
    test_cut_all_leaves_uncut_bodies_exactly_as_they_were()
    test_a_failing_body_leaves_the_whole_cut_undone()
    test_shells_are_cut_and_kept()
    test_pieces_carry_the_bodys_state()
    test_a_pieces_lineage_reaches_the_app_and_survives_a_reopen()
    test_the_cut_follows_its_face_and_offset()
    test_a_long_cut_all_keeps_the_heartbeat_moving()
    test_a_split_that_does_not_add_up_is_not_taken()
    test_a_split_crash_does_not_blame_a_fillet()
    test_an_old_split_puts_every_piece_where_it_always_was()
    test_an_old_split_keeps_its_old_body_count()
    test_old_splits_get_the_new_guards_where_they_did_nothing()
    test_an_old_split_that_was_red_stays_red()
    test_an_old_cut_all_stops_where_the_old_code_stopped()
    test_an_old_split_that_destroys_material_says_so()
    test_a_body_the_split_names_that_is_gone_is_said()
    test_a_part_lying_in_the_plane_goes_above_by_rule()
    test_a_cold_build_and_a_meshed_one_give_the_same_bodies()
    test_a_tilted_plane_measures_reach_along_its_normal()
    test_a_surface_nearly_parallel_to_a_tilted_plane_is_cut()
    test_parts_that_touch_stay_one_body()
    test_a_compsolid_is_cut_through()
    test_keeping_one_side_of_a_separation_says_what_it_removed()
    test_a_face_anchored_split_reports_where_its_face_is()
    test_a_plane_that_is_not_there_yet_is_refused_in_words()
    test_a_face_whose_body_is_gone_says_it_is_the_planes_face()
    test_an_explicit_pick_says_which_bodies_it_left_alone()
    test_a_cut_all_that_reaches_only_damaged_parts_names_the_body()
    test_a_split_leaves_the_body_it_was_given_untouched()
    test_a_curved_surface_is_sided_by_where_it_is()
    test_every_kernel_phase_of_a_crossing_part_ticks_first()
    print()
    if FAILED:
        print(f"FAILED {len(FAILED)}:")
        for f in FAILED:
            print("  -", f)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
