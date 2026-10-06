"""Mesh reference bodies: a triangle mesh that never becomes an OCCT shape.

A mesh past `builder.MAX_IMPORT_TRIANGLES` cannot be sewn into a B-rep: sew +
unify is what SIGSEGVs around 147k triangles, and even below that it costs
minutes. Refusing such a file left the user with nothing, where what they
usually want is a scan to model AGAINST: see it, snap to it, measure it.

So the triangles are read with numpy, welded to an indexed mesh, and stored in
the same content-addressed blob store as every imported B-rep, under the same
`.bbrep` file name. The Rust container is content-agnostic (it verifies the hash
and nothing else), so a saved document carries a mesh body with no change on
that side. What tells the two apart is the MAGIC below, and each reader refuses
the other's bytes in words.

A body built from one is `{"shape": None, "mesh": {"geom": <hash>, "xf": 4x4}}`.
`shape is None` is what every OCCT consumer already skips (payload, export,
checkpoint serialisation, mass properties), so the modelling tools cannot reach
it by construction. Move composes `xf` instead of rewriting the triangles, which
keeps the body JSON-sized for checkpoints and leaves the blob untouched.

Pure numpy. The only OCP use is reading ASCII STL (RWStl) and the lib3mf read
for 3MF, both of which build triangles, never topology.
"""

import struct

import numpy as np

MAGIC = b"SindriMesh v1\n"
_HEADER = struct.Struct("<II")  # vertex count, triangle count

IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]

# Blobs are immutable and content-addressed, so a hash maps to one mesh forever.
# Small, because a 1.3M-triangle scan is ~24 MB and a document rarely has more
# than one or two; the point is that a rebuild, its payload and an export do not
# each re-read and re-validate the same file.
_CACHE_MAX = 4
_cache = {}


def is_mesh_blob(data):
    return bytes(data[: len(MAGIC)]) == MAGIC


def pack(verts, idx):
    """Bytes for an indexed mesh: MAGIC, counts, f32 xyz, u32 triangle corners."""
    v = np.ascontiguousarray(verts, dtype="<f4").reshape(-1, 3)
    t = np.ascontiguousarray(idx, dtype="<u4").reshape(-1, 3)
    return MAGIC + _HEADER.pack(len(v), len(t)) + v.tobytes() + t.tobytes()


def unpack(data):
    """(verts (n,3) f32, idx (m,3) u32) from `pack` bytes.

    Validated like `_blob_to_shape`: the store's hash proves the bytes are the
    ones the container declared, not that they are benign, because whoever made
    a hostile `.sindri` chose both. So the sizes must add up exactly and every
    index must name a real vertex, or the viewport would read past its buffer."""
    if not is_mesh_blob(data):
        raise ValueError("stored geometry is not a SindriCAD mesh (bad header)")
    off = len(MAGIC)
    if len(data) < off + _HEADER.size:
        raise ValueError("stored mesh is truncated")
    nv, nt = _HEADER.unpack_from(data, off)
    off += _HEADER.size
    if len(data) != off + nv * 12 + nt * 12:
        raise ValueError("stored mesh has the wrong size for its counts")
    verts = np.frombuffer(data, dtype="<f4", count=nv * 3, offset=off).reshape(-1, 3)
    idx = np.frombuffer(data, dtype="<u4", count=nt * 3, offset=off + nv * 12).reshape(-1, 3)
    if nt == 0 or nv == 0:
        raise ValueError("stored mesh is empty")
    if int(idx.max()) >= nv:
        raise ValueError("stored mesh references vertices that do not exist")
    if not np.isfinite(verts).all():
        raise ValueError("stored mesh has non-finite coordinates")
    return verts, idx


def weld(soup):
    """Indexed mesh from a (m,3,3) triangle soup: exact-duplicate corners merged.

    Exact, not tolerance-based: a grid weld tears real meshes (measured on the
    House field file, boundary edges 700 -> 13,572), and the viewport only needs
    shared corners for smooth normals, which exact duplicates already give."""
    flat = np.ascontiguousarray(soup, dtype="<f4").reshape(-1, 3)
    verts, inverse = np.unique(flat, axis=0, return_inverse=True)
    return verts, inverse.reshape(-1, 3).astype("<u4")


def _read_binary_stl(path):
    raw = np.fromfile(path, dtype=np.uint8)
    if len(raw) < 84:
        raise ValueError("the STL file is truncated")
    n = int(raw[80:84].view("<u4")[0])
    if len(raw) < 84 + 50 * n:
        raise ValueError("the STL file is truncated")
    rec = np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    return np.frombuffer(raw[84:84 + 50 * n].tobytes(), dtype=rec)["v"]


def _read_3mf(path):
    """Triangles of every mesh object, like build123d's Mesher (which reads mesh
    objects and ignores build-item transforms), so a 3MF lands in the same place
    above and below the triangle cap."""
    from build123d import Mesher

    m = Mesher()
    reader = m.model.QueryReader("3mf")
    reader.ReadFromFile(str(path))
    it = m.model.GetMeshObjects()
    verts, tris, base = [], [], 0
    for _ in range(it.Count()):
        it.MoveNext()
        mesh = it.GetCurrentMeshObject()
        v = np.array([p.Coordinates[0:3] for p in mesh.GetVertices()], dtype="<f4")
        t = np.array([tr.Indices[0:3] for tr in mesh.GetTriangleIndices()], dtype="<u4")
        if len(v) and len(t):
            verts.append(v)
            tris.append(t + base)
            base += len(v)
    if not tris:
        raise ValueError("no geometry found in the mesh file")
    return np.concatenate(verts), np.concatenate(tris)


def read_mesh_file(path, fmt):
    """(verts, idx) for an STL / OBJ / 3MF, without building any topology."""
    import builder

    fmt = (fmt or "").lower()
    if fmt == "stl" and not builder._is_ascii_stl(path):
        soup = _read_binary_stl(path)
        if not len(soup):
            raise ValueError("no geometry found in the mesh file")
        return weld(soup)
    if fmt == "stl":
        pos, idx = builder._read_stl_triangles(path)
    elif fmt == "obj":
        pos, idx = builder._read_obj_triangles(path)
    elif fmt == "3mf":
        try:
            return _read_3mf(path)
        except Exception as e:
            # A coloured 3MF: lib3mf refuses the material extension outright.
            # Same recovery as the B-rep path (builder.import_geometry).
            if not builder._looks_like_lib3mf_refusal(e):
                raise
            import os
            import tempfile

            fd, tmp = tempfile.mkstemp(suffix=".3mf")
            os.close(fd)
            try:
                builder._3mf_without_colour(path, tmp)
                return _read_3mf(tmp)
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
    else:
        raise ValueError(f"cannot read {fmt} as a mesh")
    verts = np.asarray(pos, dtype="<f4").reshape(-1, 3)
    return verts, np.asarray(idx, dtype="<u4").reshape(-1, 3)


def store(verts, idx):
    """Put a mesh in the durable blob store; returns its content hash.

    Raises on failure for the reason `builder._shape_to_blob` does: the document
    carries no other copy, so a hash we could not store is an import we lost."""
    import blobstore

    try:
        return blobstore.default_store().put_bytes(pack(verts, idx))
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"could not store the imported mesh: {e}") from e


def load(digest):
    """(verts, idx) for a stored mesh, cached by hash. Raises in words when the
    blob is missing or is not a mesh."""
    hit = _cache.get(digest)
    if hit is not None:
        return hit
    import blobstore

    data = blobstore.default_store().get_bytes(digest)
    if data is None:
        raise ValueError(
            "the geometry for this imported scan is missing from local storage. "
            "Open the .sindri file it was saved in, or re-import the original file."
        )
    out = unpack(data)
    if len(_cache) >= _CACHE_MAX:
        _cache.pop(next(iter(_cache)))
    _cache[digest] = out
    return out


def compose(xf, m):
    """m @ xf, both 4x4 row-major lists. m is applied AFTER xf."""
    return (np.asarray(m, dtype=float) @ np.asarray(xf, dtype=float)).tolist()


def transformed(mesh):
    """(verts, idx) of a mesh body with its transform applied. Identity skips the
    multiply, so an unmoved scan hands out the cached arrays themselves; callers
    must never write into them."""
    verts, idx = load(mesh["geom"])
    xf = np.asarray(mesh.get("xf") or IDENTITY, dtype=float)
    if np.array_equal(xf, np.eye(4)):
        return verts, idx
    moved = verts.astype(float) @ xf[:3, :3].T + xf[:3, 3]
    return moved.astype("<f4"), idx


def bbox(verts):
    """Same shape as `tessellate.mesh_bbox`, so the document bbox union and the
    camera treat a scan like any other body."""
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    return {"min": [float(v) for v in lo], "max": [float(v) for v in hi]}
