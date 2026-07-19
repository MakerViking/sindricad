"""Binary STL + plain 3MF writers for TEXTURED bodies — the only two export
formats that can carry a displaced mesh (STEP is BRep-only; see server.py's
_export_job, which keeps untextured bodies on the existing build123d BRep-native
exporters.export() path unchanged and only routes textured targets here).
"""

import struct
import zipfile

import numpy as np

from project3mf import CONTENT_TYPES, RELS, _mesh_xml


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
    project3mf.py for that variant). Reuses the SAME _mesh_xml vertex/triangle
    serialization as the Orca-project writer instead of forking it."""
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US"'
        ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
        ' <metadata name="Application">SindriCAD</metadata>\n'
        f' <resources><object id="1" type="model">{_mesh_xml(positions, indices)}</object></resources>\n'
        ' <build><item objectid="1" printable="1"/></build>\n'
        "</model>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", model)
    return path
