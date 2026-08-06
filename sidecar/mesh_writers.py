"""Binary STL, plain 3MF and GLB writers for meshed bodies.

STL and 3MF exist because they are the printing formats that can carry a
TEXTURE-DISPLACED mesh (STEP is BRep-only; see server.py's _export_job, which
keeps untextured bodies on the build123d BRep-native exporters.export() path and
only routes textured targets here).

GLB is here for the same reason plus one more: displacement lives in the mesh, not
in body["shape"], so OCCT's own RWGltf_CafWriter — which serialises B-rep through
an XCAF document — would silently export a textured body untextured. Writing the
container by hand from the same (positions, indices) arrays makes the textured and
untextured paths identical, and is what lets each body keep its own colour.
"""

import json
import struct
import zipfile

import numpy as np

from project3mf import CONTENT_TYPES, RELS, _mesh_chunks


def write_stl(positions, indices, path):
    """Binary STL: 80-byte header, u32 triangle count, then 50 bytes/triangle
    (12 floats: normal + 3 vertices, + a 2-byte attribute count). Facet normals
    are computed here (STL has no shared-vertex normals) via numpy cross
    products — vectorized over all triangles at once, not a per-triangle loop."""
    pos = np.asarray(positions, dtype=np.float32).reshape(-1, 3)
    idx = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    ntri = idx.shape[0]

    v0 = pos[idx[:, 0]]
    v1 = pos[idx[:, 1]]
    v2 = pos[idx[:, 2]]
    normals = np.cross(v1 - v0, v2 - v0)
    lens = np.linalg.norm(normals, axis=1)
    lens = np.where(lens < 1e-12, 1.0, lens)  # degenerate triangle -> zero normal
    normals = (normals / lens[:, None]).astype(np.float32)

    with open(path, "wb") as fh:
        fh.write(b"\x00" * 80)
        fh.write(struct.pack("<I", ntri))
        # one packed write per triangle beats struct.pack-per-field*N in pure
        # Python — build the per-triangle 50-byte record via a structured array.
        rec = np.zeros(ntri, dtype=[
            ("n", "<f4", 3), ("v0", "<f4", 3), ("v1", "<f4", 3), ("v2", "<f4", 3),
            ("attr", "<u2"),
        ])
        rec["n"] = normals
        rec["v0"] = v0
        rec["v1"] = v1
        rec["v2"] = v2
        fh.write(rec.tobytes())
    return path


def write_plain_3mf(positions, indices, path):
    """A minimal single-object plain 3MF (no Orca project metadata — see
    project3mf.py for that variant). Reuses the SAME vertex/triangle
    serialization as the Orca-project writer instead of forking it.

    STREAMED, for the same reason write_project_3mf is: this is now the writer
    for EVERY stl/3mf export, textured or not, so materialising the model as one
    string would cost ~560 MB of peak for a 2M-triangle document (the join, the
    f-string interpolation and writestr's UTF-8 encode each hold a full copy) and
    ~2.8 GB at EXPORT_TRIANGLE_HARD_CAP. Chunked, peak is one 4096-vertex block.
    """
    head = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US"'
        ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
        ' <metadata name="Application">SindriCAD</metadata>\n'
        ' <resources><object id="1" type="model">'
    )
    tail = (
        "</object></resources>\n"
        ' <build><item objectid="1" printable="1"/></build>\n'
        "</model>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        with z.open("3D/3dmodel.model", "w") as fh:
            fh.write(head.encode("utf-8"))
            for chunk in _mesh_chunks(positions, indices):
                fh.write(chunk.encode("utf-8"))
            fh.write(tail.encode("utf-8"))
    return path


# glTF stores colour in LINEAR space; our palette is sRGB hex. Straight /255 would
# wash every colour out in a viewer.
def _srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _linear_to_srgb_hex(rgb):
    """glTF baseColorFactor (LINEAR 0-1) -> '#RRGGBB' sRGB. Inverse of
    _srgb_to_linear, used when reading a .glb back in."""
    out = []
    for c in rgb[:3]:
        c = max(0.0, min(1.0, float(c)))
        s = 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055
        out.append(max(0, min(255, int(round(s * 255)))))
    return "#%02X%02X%02X" % tuple(out)


def _base_color_factor(hex_color):
    """'#RRGGBB' -> glTF baseColorFactor [r, g, b, a] in LINEAR 0-1."""
    s = str(hex_color or "").strip().lstrip("#")
    if len(s) != 6:
        s = "808080"
    try:
        rgb = [int(s[i:i + 2], 16) for i in (0, 2, 4)]
    except ValueError:
        rgb = [128, 128, 128]
    return [round(_srgb_to_linear(v), 6) for v in rgb] + [1.0]


def _vertex_normals(pos, idx):
    """Area-weighted vertex normals for a shared-vertex triangle mesh.

    No crease angle, deliberately. tessellate() appends each B-rep face's nodes
    with a fresh base and never welds across faces, so vertices are ALREADY
    duplicated at every face boundary: averaging can only ever run within one
    face. That yields smooth curved surfaces and sharp face-to-face edges for
    free, and a crease threshold could only make it worse (too low rounds off a
    cube's corners). Winding is outward-correct upstream — tessellate flips
    REVERSED faces — so no sign correction is needed here.

    The cross product's magnitude is twice the triangle area, so summing raw
    (unnormalised) face normals area-weights the average for free. Accumulated
    with bincount rather than np.add.at, which is orders of magnitude slower on
    the million-triangle meshes a textured export produces.
    """
    nvert = pos.shape[0]
    v0, v1, v2 = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    nrm = np.zeros((nvert, 3), dtype=np.float64)
    for corner in range(3):
        col = idx[:, corner]
        for axis in range(3):
            nrm[:, axis] += np.bincount(col, weights=fn[:, axis], minlength=nvert)
    lens = np.linalg.norm(nrm, axis=1)
    lens = np.where(lens < 1e-12, 1.0, lens)  # isolated/degenerate vertex
    return (nrm / lens[:, None]).astype(np.float32)


# Root-node transform: Z-up millimetres (ours) -> Y-up METRES (glTF's).
#
# Both conversions ride in the node matrix rather than the vertex data: one place
# to be wrong, and the cached export arrays are never copied or mutated. glTF's
# unit IS the metre per spec, which is why the scale belongs here and not as an
# afterthought — emitting raw mm makes every model read 1000x too large to any
# spec-abiding consumer (including our own importer, which must assume metres so
# that third-party files load correctly).
#
# glTF matrices are COLUMN-major. These columns give (x,y,z)mm -> (x, z, -y)*0.001.
_MM = 0.001
_ROOT_MATRIX = [_MM, 0.0, 0.0, 0.0,
                0.0, 0.0, -_MM, 0.0,
                0.0, _MM, 0.0, 0.0,
                0.0, 0.0, 0.0, 1.0]

_GLB_MAGIC = 0x46546C67       # 'glTF'
_CHUNK_JSON = 0x4E4F534A      # 'JSON'
_CHUNK_BIN = 0x004E4942       # 'BIN\0'


def write_glb(meshes, path, generator="SindriCAD"):
    """Write a binary glTF 2.0 (.glb).

    meshes : [{"name": str, "positions": flat xyz floats, "indices": flat ints,
               "color": "#RRGGBB" or None}]  — ONE ENTRY PER BODY, kept separate
             so each becomes its own named, individually coloured node. (STL and
             3MF merge everything into one soup; glTF has no reason to.)

    Layout: 12-byte header, then a JSON chunk and a BIN chunk, each padded to a
    4-byte boundary (JSON with spaces, BIN with zeros) as the spec requires.
    """
    nodes, gl_meshes, materials, accessors, views = [], [], [], [], []
    blobs, offset = [], 0

    def _view(raw, target):
        nonlocal offset
        pad = (-len(raw)) % 4
        views.append({"buffer": 0, "byteOffset": offset,
                      "byteLength": len(raw), "target": target})
        blobs.append(raw)
        blobs.append(b"\x00" * pad)
        offset += len(raw) + pad
        return len(views) - 1

    for m in meshes:
        pos = np.asarray(m["positions"], dtype=np.float64).reshape(-1, 3)
        idx = np.asarray(m["indices"], dtype=np.int64).reshape(-1, 3)
        if pos.size == 0 or idx.size == 0:
            continue  # a body that meshed to nothing: skip, don't emit an empty node
        nrm = _vertex_normals(pos, idx)

        p_view = _view(pos.astype(np.float32).tobytes(), 34962)   # ARRAY_BUFFER
        n_view = _view(nrm.tobytes(), 34962)
        i_view = _view(idx.astype(np.uint32).ravel().tobytes(), 34963)  # ELEMENT_ARRAY

        # POSITION must carry min/max — validators reject the file without them.
        accessors.append({"bufferView": p_view, "componentType": 5126,
                          "count": int(pos.shape[0]), "type": "VEC3",
                          "min": [float(v) for v in pos.min(axis=0)],
                          "max": [float(v) for v in pos.max(axis=0)]})
        accessors.append({"bufferView": n_view, "componentType": 5126,
                          "count": int(nrm.shape[0]), "type": "VEC3"})
        accessors.append({"bufferView": i_view, "componentType": 5125,
                          "count": int(idx.size), "type": "SCALAR"})
        a = len(accessors) - 3

        name = str(m.get("name") or f"Body{len(gl_meshes) + 1}")
        materials.append({
            "name": f"{name} colour",
            "pbrMetallicRoughness": {
                "baseColorFactor": _base_color_factor(m.get("color")),
                "metallicFactor": 0.0,
                "roughnessFactor": 0.7,
            },
            "doubleSided": False,
        })
        gl_meshes.append({"name": name, "primitives": [{
            "attributes": {"POSITION": a, "NORMAL": a + 1},
            "indices": a + 2,
            "material": len(materials) - 1,
        }]})
        nodes.append({"name": name, "mesh": len(gl_meshes) - 1})

    # node 0 is the Z-up->Y-up root; every body hangs off it
    child_ids = list(range(1, len(nodes) + 1))
    nodes.insert(0, {"name": "SindriCAD", "matrix": _ROOT_MATRIX,
                     "children": child_ids})

    doc = {
        "asset": {"version": "2.0", "generator": generator},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
        "meshes": gl_meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": offset}],
    }
    if not gl_meshes:  # nothing meshed — keep the file structurally valid
        for k in ("meshes", "materials", "accessors", "bufferViews", "buffers"):
            doc.pop(k)

    raw_json = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    raw_json += b" " * ((-len(raw_json)) % 4)          # JSON pads with SPACES
    raw_bin = b"".join(blobs)                          # already zero-padded

    with open(path, "wb") as fh:
        total = 12 + 8 + len(raw_json) + (8 + len(raw_bin) if raw_bin else 0)
        fh.write(struct.pack("<III", _GLB_MAGIC, 2, total))
        fh.write(struct.pack("<II", len(raw_json), _CHUNK_JSON))
        fh.write(raw_json)
        if raw_bin:
            fh.write(struct.pack("<II", len(raw_bin), _CHUNK_BIN))
            fh.write(raw_bin)
    return path
