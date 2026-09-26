"""The rebuild must never send an open or absurd bounding box. Run:
    cd sidecar && .venv/bin/python test_open_bbox.py

What broke: BRepMesh leaves an unbounded face untriangulated, and for such a
face BRepBndLib.Add_s falls back to the face's geometric box, which is OPEN.
Bnd_Box.Get() then reads +/-1e100 on every axis, mesh_bbox passed that on, and
_union_bbox made it the whole document's box. The viewport framed it and put
the camera 5.2e100 mm away: an empty screen that Fit could not bring back. Seen
on 7 of the 340 bodies in a real Ender 3 assembly (STEP cone faces with V bounds
of +/-2e100); those files are third-party, so the fixture here builds the same
defect from scratch: a box whose shell also carries a natural-bounds cone face.

The fixture tests drive server._rebuild_job on an IMPORTED body, which is where a
user meets this, and the fixture is first shown to reproduce the failure with the
pre-fix algorithm, so a heal step that one day drops the cone face fails the
suite loudly instead of letting it pass on nothing.
"""

import math
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Cold, isolated stores BEFORE any sidecar module creates its singleton: a warm
# mesh artifact or checkpoint must not stand in for the code under test, and the
# import must not write into the developer's real cache.
_TMP = tempfile.mkdtemp(prefix="open_bbox_")
os.environ["SINDRI_BLOB_DIR"] = os.path.join(_TMP, "blobs")
os.environ["XDG_CACHE_HOME"] = os.path.join(_TMP, "cache")

FAILED = []

# The fixture box: 10 x 20 x 30, centred on (100, 0, 0).
BOX_MIN = [95.0, -10.0, -15.0]
BOX_MAX = [105.0, 10.0, 15.0]


def check(label, cond):
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        FAILED.append(label)


def _pre_fix_mesh_bbox(shape):
    """mesh_bbox as it was before this fix, kept as the CONTROL: it must return
    the +/-1e100 box on the fixture, or the fixture is not reproducing anything."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    bnd = Bnd_Box()
    BRepBndLib.Add_s(shape.wrapped, bnd, True)
    if bnd.IsVoid():
        return None
    xm, ym, zm, xM, yM, zM = bnd.Get()
    return {"min": [xm, ym, zm], "max": [xM, yM, zM]}


def _unbounded_cone_face():
    """A cone face with its natural bounds: V runs to +/-Precision::Infinite, the
    same 2e100 the Ender faces carry, and BRepMesh cannot triangulate it."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.Geom import Geom_ConicalSurface
    from OCP.gp import gp_Ax3, gp_Dir, gp_Pnt

    cone = Geom_ConicalSurface(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(30), 2.0)
    return BRepBuilderAPI_MakeFace(cone, 1e-7).Face()


def _box():
    from build123d import Box, Pos

    return Pos(100, 0, 0) * Box(10, 20, 30)


def _box_with_unbounded_face():
    """ONE solid whose shell holds the box's six faces plus the cone face, so the
    import keeps it as a single body, like the real ones: most of the body
    triangulates, one face does not."""
    from build123d import Solid
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

    b = BRep_Builder()
    shell = TopoDS_Shell()
    b.MakeShell(shell)
    for f in _box().faces():
        b.Add(shell, f.wrapped)
    b.Add(shell, _unbounded_cone_face())
    solid = TopoDS_Solid()
    b.MakeSolid(solid)
    b.Add(solid, shell)
    return Solid(solid)


def _import_doc(shape, name):
    """Write `shape` to a BREP file and turn it into a one-feature document
    through the same import_geometry the app's Import command uses."""
    import builder
    from build123d import export_brep

    path = os.path.join(_TMP, name + ".brep")
    export_brep(shape, path)
    out = builder.import_geometry(path, "brep")
    feat = {"id": "f1", "type": "import", "name": name}
    for k in ("brep", "geom", "solid", "faces", "nodes", "parts"):
        if k in out:
            feat[k] = out[k]
    return {"version": 1, "parameters": {}, "features": [feat]}


def _rebuild(doc):
    import server

    res = server._rebuild_job(doc, 0.1)
    assert "error" not in res, res
    return res


def _is_box(bb, lo, hi, slack):
    return all(abs(bb["min"][i] - lo[i]) <= slack and abs(bb["max"][i] - hi[i]) <= slack
               for i in range(3))


def _contains_positions(bb, positions):
    for i in range(3):
        coords = positions[i::3]
        if min(coords) < bb["min"][i] or max(coords) > bb["max"][i]:
            return False
    return True


def test_open_box_becomes_the_drawn_box():
    print("a body with an untriangulated unbounded face gets the box of what is drawn")
    import server

    res = _rebuild(_import_doc(_box_with_unbounded_face(), "Unbounded"))
    check("the import stays ONE body", len(res["bodies"]) == 1)
    body = res["bodies"][0]
    shape = server._MESH_CACHE[body["id"]]["shape"]  # the shape just tessellated

    # CONTROL: the fixture really is the bug. 7 faces, 6 of them meshed, and the
    # pre-fix box is OCCT's +/-1e100.
    old = _pre_fix_mesh_bbox(shape)
    check("fixture has the box's 6 faces plus the cone face", len(shape.faces()) == 7)
    check("only the box's faces are drawn (12 triangles)", len(body["faceIds"]) == 12)
    check("CONTROL: the pre-fix mesh_bbox returns +/-1e100 here",
          old is not None and old["min"] == [-1e100] * 3 and old["max"] == [1e100] * 3)

    bb = body["bbox"]
    check(f"body bbox is the box, not the universe: {bb}",
          bb is not None and _is_box(bb, BOX_MIN, BOX_MAX, 1e-3))
    check("body bbox contains every drawn vertex",
          bb is not None and _contains_positions(bb, body["positions"]))
    check(f"document bbox is the box: {res['bbox']}",
          res["bbox"] is not None and _is_box(res["bbox"], BOX_MIN, BOX_MAX, 1e-3))


def test_a_body_with_nothing_drawable_has_no_box():
    print("a body that is ONLY an unbounded face has no box, and the document skips it")
    from build123d import Compound, Face

    # Imported as a compound, the loose cone face becomes a body of its own.
    res = _rebuild(_import_doc(Compound(children=[_box(), Face(_unbounded_cone_face())]),
                               "LooseFace"))
    by_tris = sorted(res["bodies"], key=lambda b: len(b["faceIds"]))
    check("two bodies: the cone face alone, and the box",
          len(by_tris) == 2 and len(by_tris[0]["faceIds"]) == 0)
    check(f"the cone-only body has no bbox: {by_tris[0].get('bbox')}",
          by_tris[0].get("bbox") is None)
    check(f"document bbox is the box: {res['bbox']}",
          res["bbox"] is not None and _is_box(res["bbox"], BOX_MIN, BOX_MAX, 1e-3))


def test_a_normal_box_is_unchanged():
    print("a closed box comes back exactly as before")
    import server
    from build123d import Cylinder, Mode, fillet
    from tessellate import mesh_bbox, tessellate

    res = _rebuild(_import_doc(_box(), "PlainBox"))
    body = res["bodies"][0]
    shape = server._MESH_CACHE[body["id"]]["shape"]
    check("box: bbox identical to the pre-fix algorithm",
          body["bbox"] == _pre_fix_mesh_bbox(shape))
    check("box: document bbox is that same box", res["bbox"] == body["bbox"])

    # Curved too, where the triangulation box and the exact box differ (0.118mm
    # on this ring, see test_ws), so a changed code path would show.
    ring = fillet((Cylinder(30, 10) - Cylinder(25, 10, mode=Mode.SUBTRACT)).edges(), 1.0)
    tessellate(ring, 0.008, angular_tolerance=0.35, relative=True, force_remesh=True)
    check("filleted ring: bbox identical to the pre-fix algorithm",
          mesh_bbox(ring) == _pre_fix_mesh_bbox(ring))


def test_union_skips_unframeable_boxes():
    print("_union_bbox skips a box no camera can frame")
    import server

    good = {"min": [-5.0, 2.0, 0.0], "max": [-1.0, 9.0, 0.5]}
    other = {"min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0]}
    universe = {"min": [-1e100] * 3, "max": [1e100] * 3}
    nan = {"min": [0.0, float("nan"), 0.0], "max": [1.0, 1.0, 1.0]}
    inf = {"min": [0.0, 0.0, -math.inf], "max": [1.0, 1.0, 1.0]}

    check("+/-1e100, NaN, inf and None are all left out",
          server._union_bbox([good, universe, None, nan, inf, other])
          == {"min": [-5.0, 0.0, 0.0], "max": [1.0, 9.0, 1.0]})
    check("nothing framable left -> None, the legal empty reply",
          server._union_bbox([universe, None, nan]) is None)


def test_a_part_far_from_the_origin_keeps_its_box():
    # The gate is OCCT's unbounded SENTINEL, not a distance. A first version
    # refused any coordinate past 1e7 mm (10 km), which took the box away from a
    # real part placed in site coordinates: mesh_bbox None, document bbox None,
    # and the viewport's Fit could never reach it.
    print("a real part 20 km from the origin keeps its box")
    import server
    from build123d import Box, Pos
    from tessellate import mesh_bbox, tessellate

    far = Pos(2e7, 0, 0) * Box(1000, 1000, 1000)
    tessellate(far, 0.1)
    bb = mesh_bbox(far)
    lo, hi = [2e7 - 500, -500, -500], [2e7 + 500, 500, 500]
    check(f"mesh_bbox is the part's box: {bb}", bb is not None and _is_box(bb, lo, hi, 1e-3))
    check("_union_bbox keeps it", bb is not None and server._union_bbox([bb]) == bb)


if __name__ == "__main__":
    try:
        test_open_box_becomes_the_drawn_box()
        test_a_body_with_nothing_drawable_has_no_box()
        test_a_normal_box_is_unchanged()
        test_union_skips_unframeable_boxes()
        test_a_part_far_from_the_origin_keeps_its_box()
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)
    if FAILED:
        print(f"\n{len(FAILED)} FAILED")
        sys.exit(1)
    print("\nall open-bbox tests passed")
