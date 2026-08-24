"""GLB (binary glTF) export + import tests.

Run: uv run python test_glb.py   (or .venv/bin/python test_glb.py)

Covers the things that are easy to get silently wrong in a mesh interchange
format, each of which produces a file that still LOADS:
  - container structure (chunk alignment, POSITION min/max) — validators reject
    a file missing accessor bounds, but viewers often don't,
  - orientation and unit, checked against the FILE's own contents rather than by
    round-tripping through our own reader (a Y-up or metre mistake made in both
    directions cancels out and a round trip passes),
  - normals: smooth within a curved face, sharp between faces,
  - per-body colour, one glTF material per body,
  - textured bodies exporting their DISPLACED mesh — displacement lives in the
    mesh, not in body["shape"], so the whole reason write_glb exists instead of
    OCCT's RWGltf_CafWriter is that the latter would silently drop it.
"""

import json
import os
import struct
import sys
import tempfile

os.environ.setdefault("SINDRI_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

import builder  # noqa: E402
import mesh_writers  # noqa: E402
from build123d import Box, Cylinder  # noqa: E402
from tessellate import tessellate  # noqa: E402

PASS = "  ok"

_GLB_MAGIC = 0x46546C67
_CHUNK_JSON = 0x4E4F534A
_CHUNK_BIN = 0x004E4942


def _entry(name, shape, color="#3050c8", tol=0.1):
    pos, idx, _fids = tessellate(shape, tolerance=tol)
    return {"name": name, "positions": pos, "indices": idx, "color": color}


def _read_glb_raw(path):
    """Parse a .glb into (json_doc, bin_bytes) without using our importer."""
    raw = open(path, "rb").read()
    magic, ver, total = struct.unpack("<III", raw[:12])
    assert magic == _GLB_MAGIC, "not a GLB"
    assert ver == 2, ver
    assert total == len(raw), f"header length {total} != file {len(raw)}"
    jlen, jtype = struct.unpack("<II", raw[12:20])
    assert jtype == _CHUNK_JSON and jlen % 4 == 0, "JSON chunk misaligned"
    doc = json.loads(raw[20:20 + jlen])
    blob = b""
    off = 20 + jlen
    if off < len(raw):
        blen, btype = struct.unpack("<II", raw[off:off + 8])
        assert btype == _CHUNK_BIN and blen % 4 == 0, "BIN chunk misaligned"
        blob = raw[off + 8:off + 8 + blen]
    return doc, blob


def _accessor_array(doc, blob, index):
    """Read accessor `index` out of the BIN chunk as a numpy array."""
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2"}[acc["componentType"]]
    ncomp = {"SCALAR": 1, "VEC3": 3}[acc["type"]]
    start = view["byteOffset"]
    data = np.frombuffer(blob[start:start + view["byteLength"]], dtype=dtype)
    return data.reshape(-1, ncomp) if ncomp > 1 else data


def test_container_is_structurally_valid():
    p = os.path.join(tempfile.mkdtemp(), "c.glb")
    mesh_writers.write_glb([_entry("B", Box(10, 20, 30))], p)
    doc, blob = _read_glb_raw(p)  # asserts magic/version/length/alignment

    assert doc["asset"]["version"] == "2.0", doc["asset"]
    assert doc["buffers"][0]["byteLength"] == len(blob), "buffer length != BIN chunk"
    pos_acc = doc["meshes"][0]["primitives"][0]["attributes"]["POSITION"]
    acc = doc["accessors"][pos_acc]
    # a validator REJECTS a POSITION accessor without bounds; most viewers don't
    assert "min" in acc and "max" in acc, f"POSITION accessor lacks min/max: {acc}"
    assert len(acc["min"]) == 3 and len(acc["max"]) == 3, acc
    print(PASS, "GLB container is structurally valid (chunks aligned, POSITION bounded)")


def test_orientation_and_unit_are_glTF_native():
    """Checked against the FILE, not via our own reader.

    A Y-up or metre error applied in BOTH writer and reader cancels out, so a
    round trip cannot catch it. Transform the accessor bounds by the root node
    matrix and assert the result is what a glTF consumer will actually see."""
    p = os.path.join(tempfile.mkdtemp(), "o.glb")
    # deliberately asymmetric: 40mm tall in Z, 10mm in X, 20mm in Y
    mesh_writers.write_glb([_entry("Tall", Box(10, 20, 40))], p)
    doc, blob = _read_glb_raw(p)

    m = doc["nodes"][0]["matrix"]  # column-major 4x4
    M = np.array(m, dtype=np.float64).reshape(4, 4).T
    pos = _accessor_array(doc, blob, doc["meshes"][0]["primitives"][0]["attributes"]["POSITION"])
    homo = np.hstack([pos.astype(np.float64), np.ones((pos.shape[0], 1))])
    world = (M @ homo.T).T[:, :3]
    ext = world.max(axis=0) - world.min(axis=0)

    # glTF is Y-up and metres: the 40mm dimension must land on Y as 0.040
    assert abs(ext[1] - 0.040) < 1e-6, f"Y extent {ext[1]} — expected 0.040 m (Y-up + metres)"
    assert abs(ext[0] - 0.010) < 1e-6, f"X extent {ext[0]} — expected 0.010 m"
    assert abs(ext[2] - 0.020) < 1e-6, f"Z extent {ext[2]} — expected 0.020 m"
    print(PASS, "orientation + unit are glTF-native (Y-up, metres) in the file itself")


def test_round_trip_preserves_size():
    p = os.path.join(tempfile.mkdtemp(), "rt.glb")
    mesh_writers.write_glb(
        [_entry("Tall", Box(10, 10, 40)), _entry("Round", Cylinder(6, 12))], p)
    shape = builder._read_glb(p)
    bb = shape.bounding_box()
    assert abs((bb.max.Z - bb.min.Z) - 40.0) < 1e-3, bb
    assert abs((bb.max.X - bb.min.X) - 12.0) < 1e-3, bb
    print(PASS, "round trip preserves millimetre size and Z-up orientation")


def test_normals_are_smooth_within_a_face_and_sharp_between():
    """The design claim behind having NO crease-angle parameter: tessellate never
    welds vertices across B-rep faces, so averaging can only run within one face."""
    pos, idx, _f = tessellate(Cylinder(10, 20), tolerance=0.05)
    P = np.asarray(pos).reshape(-1, 3)
    I = np.asarray(idx).reshape(-1, 3)
    N = mesh_writers._vertex_normals(P, I)

    r = np.linalg.norm(P[:, :2], axis=1)
    rim = r > 9.9  # lateral-surface vertices AND cap-border vertices share this ring
    nz = np.abs(N[rim][:, 2])
    lateral = int((nz < 0.05).sum())
    caps = int((nz > 0.95).sum())
    blurred = int(((nz >= 0.05) & (nz <= 0.95)).sum())
    assert lateral > 0 and caps > 0, (lateral, caps)
    assert blurred == 0, f"{blurred} rim vertices have a blended normal — the edge was rounded off"

    lat = rim & (np.abs(N[:, 2]) < 0.05)
    radial = (N[lat][:, 0] * P[lat][:, 0] + N[lat][:, 1] * P[lat][:, 1]) / r[lat]
    assert radial.min() > 0.99, f"lateral normals not radial (min {radial.min():.4f})"
    print(PASS, "normals: smooth around a curved face, sharp at face boundaries")


def test_one_material_per_body_with_its_palette_colour():
    p = os.path.join(tempfile.mkdtemp(), "col.glb")
    mesh_writers.write_glb([
        _entry("Red", Box(5, 5, 5), color="#d23b30"),
        _entry("Blue", Cylinder(3, 6), color="#3050c8"),
    ], p)
    doc, _blob = _read_glb_raw(p)
    assert len(doc["materials"]) == 2, doc["materials"]
    assert len(doc["meshes"]) == 2 and len(doc["nodes"]) == 3, "expected a root + 2 body nodes"
    assert [n["name"] for n in doc["nodes"][1:]] == ["Red", "Blue"], doc["nodes"]

    # #d23b30 -> sRGB (210,59,48) -> linear; assert R is the linearised value, not 210/255
    r = doc["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"][0]
    assert abs(r - mesh_writers._srgb_to_linear(210)) < 1e-5, r
    assert abs(r - (210 / 255)) > 0.1, "colour was written as sRGB, not linear"
    for mat in doc["materials"]:
        assert mat["pbrMetallicRoughness"]["baseColorFactor"][3] == 1.0, mat
    print(PASS, "one material per body, colours linearised for glTF")


def test_textured_body_exports_its_displaced_mesh():
    """The trap write_glb exists to avoid: texture displacement lives in the mesh,
    never in body["shape"], so any shape-based writer drops it silently."""
    plain = _entry("Plain", Box(20, 20, 5))
    smooth_tris = len(plain["indices"]) // 3

    doc = {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"id": "r1", "type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
        {"id": "t1", "type": "texture", "kind": "knurl", "faces": {"by": "all"},
         "depth": 0.4, "scale": 2.0},
    ]}
    _part, errors, bodies = builder.rebuild(doc)
    assert not errors, errors
    body = bodies[0]
    assert body.get("_textures"), "the fixture should be textured"

    import server
    pos, idx, _fids = server._export_mesh(body)  # third return is per-triangle face ids
    p = os.path.join(tempfile.mkdtemp(), "tex.glb")
    mesh_writers.write_glb([{"name": "Knurled", "positions": pos,
                             "indices": idx, "color": "#e8e8e8"}], p)
    gdoc, _blob = _read_glb_raw(p)
    ntri = gdoc["accessors"][gdoc["meshes"][0]["primitives"][0]["indices"]]["count"] // 3
    assert ntri > smooth_tris * 5, (
        f"only {ntri} triangles vs {smooth_tris} for the smooth box — the texture was dropped")
    print(PASS, f"textured body exports its displaced mesh ({ntri:,} triangles)")


def test_export_job_routes_glb_and_threads_colours():
    """The wiring: _export_job must route glb to the per-body writer (never through
    exporters.export, which serialises body["shape"]) and resolve palette slots."""
    import server

    doc = {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"id": "r1", "type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": "XY",
         "entities": [{"id": "c1", "type": "circle", "radius": 4, "x": 40, "y": 0}]},
        {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 8, "operation": "new"},
    ]}
    palette = [{"name": "White", "color": "#e8e8e8"}, {"name": "Red", "color": "#d23b30"}]
    p = os.path.join(tempfile.mkdtemp(), "wired.glb")
    res = server._export_job(doc, "glb", p, None, False, palette, {"body2": 1})
    assert "error" not in res, res

    gdoc, _blob = _read_glb_raw(p)
    assert [n.get("name") for n in gdoc["nodes"]] == ["SindriCAD", "Body1", "Body2"], gdoc["nodes"]
    got = [m["pbrMetallicRoughness"]["baseColorFactor"][0] for m in gdoc["materials"]]
    # body1 is unassigned -> slot 0 (white), body2 -> slot 1 (red), both linearised
    assert abs(got[0] - mesh_writers._srgb_to_linear(232)) < 1e-5, got
    assert abs(got[1] - mesh_writers._srgb_to_linear(210)) < 1e-5, got
    print(PASS, "_export_job routes glb per-body and resolves palette slots")


def test_import_recovers_a_solid_not_a_surface_body():
    """GLB import must reach parity with STL import.

    OCCT's glTF reader returns ONE triangulated FACE per mesh, so a box arrived as
    1 face / 0 solids — a surface body, "reference / section only" — where the
    identical STL imports as 6 faces and a real editable solid. The glb branch
    round-trips its triangles through the shared sew path to fix that."""
    d = tempfile.mkdtemp()
    pos, idx, _f = tessellate(Box(10, 10, 10), tolerance=0.5)

    glb = os.path.join(d, "one.glb")
    mesh_writers.write_glb([{"name": "B", "positions": pos, "indices": idx,
                             "color": "#D23B30"}], glb)
    got = builder.import_geometry(glb, "glb")

    stl = os.path.join(d, "one.stl")
    mesh_writers.write_stl(pos, idx, stl)
    want = builder.import_geometry(stl, "stl")

    assert got["solid"] is True, f"GLB imported as a surface body: {got}"
    assert got["faces"] == want["faces"], (got["faces"], want["faces"])
    print(PASS, f"GLB imports as a solid, at STL parity ({got['faces']} faces)")


def test_import_reads_the_dominant_material_colour():
    """Dominant = most triangles, not materials[0] — otherwise a tiny detail part
    dictates the colour of the whole import."""
    d = tempfile.mkdtemp()
    p = os.path.join(d, "two.glb")
    mesh_writers.write_glb([
        _entry("TinyRed", Box(2, 2, 2), color="#d23b30", tol=0.5),
        _entry("BigBlue", Cylinder(20, 40), color="#3050c8", tol=0.2),
    ], p)
    assert builder._glb_dominant_color(p) == "#3050C8", builder._glb_dominant_color(p)

    # and the sRGB -> linear -> sRGB round trip is lossless at 8-bit
    one = os.path.join(d, "one.glb")
    mesh_writers.write_glb([_entry("R", Box(4, 4, 4), color="#D23B30", tol=0.5)], one)
    assert builder._glb_dominant_color(one) == "#D23B30", builder._glb_dominant_color(one)

    # a file with no materials must yield None, not a default colour
    assert builder._glb_dominant_color(os.devnull) is None
    print(PASS, "import reads the dominant material colour, round-tripping exactly")


def test_glb_stays_unwelded_so_face_edges_stay_sharp():
    """GLB must NOT get the export weld the 3MF path uses.

    3MF and STL carry no normals, so sharing one index per position there is free
    and it is what stops a slicer calling the mesh non-manifold. glTF does carry
    normals, and mesh_writers._vertex_normals averages per VERTEX with no crease
    angle — it relies on tessellate() having given every face its own copy. Weld
    a cube and all 24 corner vertices become 8, each averaging three
    perpendicular faces, and every corner shades round."""
    import server

    doc = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20},
    ]}
    p = os.path.join(tempfile.mkdtemp(), "sharp.glb")
    res = server._export_job(doc, "glb", p)
    assert "error" not in res, res
    gdoc, _blob = _read_glb_raw(p)
    prim = gdoc["meshes"][0]["primitives"][0]
    n = gdoc["accessors"][prim["attributes"]["POSITION"]]["count"]
    assert n == 24, f"a cube must export 4 vertices per face, got {n} (welded to 8?)"
    print(PASS, "glb keeps per-face vertices (24 on a cube), so its corners stay sharp")


def main():
    print("GLB export/import tests")
    test_container_is_structurally_valid()
    test_orientation_and_unit_are_glTF_native()
    test_round_trip_preserves_size()
    test_normals_are_smooth_within_a_face_and_sharp_between()
    test_one_material_per_body_with_its_palette_colour()
    test_textured_body_exports_its_displaced_mesh()
    test_export_job_routes_glb_and_threads_colours()
    test_import_recovers_a_solid_not_a_surface_body()
    test_import_reads_the_dominant_material_colour()
    test_glb_stays_unwelded_so_face_edges_stay_sharp()
    print("ALL PASS")


if __name__ == "__main__":
    main()
