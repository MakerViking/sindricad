"""B-rep -> render payload: mesh (positions + indices + per-triangle faceIds),
edge polylines, and bounding box.

Meshing runs through OpenCASCADE's **BRepMesh in parallel** — one call meshes the
whole solid's faces across the OCCT thread pool in C++ (no Python GIL, scales to
every core; see occt_smp.py). We then read each face's triangulation back and tag
every triangle with its face index, which gives the frontend clean `faceIds` (one
clicked triangle -> its whole CAD face) and a natural seam for per-face normals.

(The previous implementation called build123d's `face.tessellate()` in a serial
Python loop — single-threaded and GIL-bound. On a 6-sphere union @0.01mm that was
~670ms; the parallel path below is ~85ms on a 5900X.)
"""

from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopAbs import TopAbs_Orientation
from OCP.TopLoc import TopLoc_Location


def tessellate(shape, tolerance=0.1, angular_tolerance=0.5):
    """Return (positions, indices, face_ids).

    positions : flat [x,y,z, ...] floats
    indices   : flat [i,j,k, ...] triangle index triples
    face_ids  : [f0, f1, ...] one B-rep face id per triangle (len = len(indices)//3)
    """
    # Mesh the entire solid at once, in parallel (isInParallel=True). This fills an
    # incremental triangulation onto every TopoDS_Face, which we read back below.
    BRepMesh_IncrementalMesh(shape.wrapped, tolerance, False, angular_tolerance, True)

    positions = []
    indices = []
    face_ids = []

    for fid, face in enumerate(shape.faces()):
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
        if tri is None:
            continue  # degenerate face with no triangulation — skip it
        trsf = loc.Transformation()  # face-local -> world placement
        base = len(positions) // 3
        for i in range(1, tri.NbNodes() + 1):  # OCCT arrays are 1-based
            p = tri.Node(i).Transformed(trsf)
            positions.append(p.X())
            positions.append(p.Y())
            positions.append(p.Z())
        # A face flagged REVERSED has its triangles wound the opposite way; flip the
        # winding so client-side computeVertexNormals() yields outward normals.
        flip = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
        for i in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(i).Get()
            if flip:
                b, c = c, b
            indices.append(base + a - 1)
            indices.append(base + b - 1)
            indices.append(base + c - 1)
            face_ids.append(fid)

    return positions, indices, face_ids


def tessellate_bodies(bodies, tolerance=0.1):
    """Tessellate a list of bodies into ONE merged render payload, plus per-body
    metadata. Face ids stay globally unique across bodies (running offset) so the
    frontend can both highlight a clicked CAD face and map it back to its body.

    bodies   : [{"id", "name", "shape"}]  (shape may be None for an empty body)
    returns  : (positions, indices, face_ids, meta) where meta is
               [{"id", "name", "faceStart", "faceCount"}].
    """
    positions = []
    indices = []
    face_ids = []
    meta = []
    face_base = 0
    for b in bodies:
        sh = b.get("shape")
        if sh is None:
            continue
        pos, idx, fids = tessellate(sh, tolerance)
        vbase = len(positions) // 3
        positions.extend(pos)
        indices.extend(i + vbase for i in idx)
        n_faces = (max(fids) + 1) if fids else 0
        face_ids.extend(fid + face_base for fid in fids)
        meta.append(
            {"id": b["id"], "name": b["name"], "faceStart": face_base, "faceCount": n_faces}
        )
        face_base += n_faces
    return positions, indices, face_ids, meta


def edge_polylines(shape, n=24):
    """Sample each edge as a polyline of n+1 points spanning the WHOLE edge.

    `e @ t` (position_at by normalized parameter, t in [0,1]) walks start->end.
    NOTE: do NOT use position_mode=LENGTH with t in [0,1] — there the argument is
    an absolute arc length in mm, so it only samples the first 1mm of each edge.
    """
    out = []
    for i, e in enumerate(shape.edges()):
        pts = [[p.X, p.Y, p.Z] for p in (e @ (j / n) for j in range(n + 1))]
        out.append({"id": f"e{i}", "points": pts})
    return out


def _planar_face_normals(sh):
    """Map face-index -> analytic plane normal (cheap, exact) for PLANAR faces; None
    for curved faces. Plus the edge->faces ancestor map, so a single pass over edges
    can both seam-test and sample them. Returns (face_index_map, normals, edge_map)."""
    from OCP.TopExp import TopExp
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopTools import (
        TopTools_IndexedDataMapOfShapeListOfShape,
        TopTools_IndexedMapOfShape,
    )
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.TopoDS import TopoDS

    fmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(sh.wrapped, TopAbs_FACE, fmap)
    fnorm = {}
    for i in range(1, fmap.Extent() + 1):
        try:
            surf = BRepAdaptor_Surface(TopoDS.Face_s(fmap.FindKey(i)))
            if surf.GetType() == GeomAbs_Plane:
                d = surf.Plane().Axis().Direction()
                fnorm[i] = (d.X(), d.Y(), d.Z())
        except Exception:
            pass
    em = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(sh.wrapped, TopAbs_EDGE, TopAbs_FACE, em)
    return fmap, fnorm, em


def edge_polylines_by_body(bodies, n=24, hide_coplanar_seams=True):
    """Sample each body's edges as polylines tagged with the body id (so the frontend
    can hide a hidden body's WIREFRAME). Edges between two COPLANAR planar faces are a
    boolean's leftover seam — not a real edge — so they're dropped (Fusion-style),
    making a merged part read as one continuous face. One pass over the edge->face map:
    seam-test and sample together. Display-only; touches no geometry (can't hang)."""
    import math

    cos_tol = math.cos(math.radians(1.0))
    out = []
    k = 0
    for b in bodies:
        sh = b.get("shape")
        if sh is None:
            continue
        if not (hide_coplanar_seams and getattr(sh, "wrapped", None) is not None):
            for e in sh.edges():
                pts = [[p.X, p.Y, p.Z] for p in (e @ (j / n) for j in range(n + 1))]
                out.append({"id": f"e{k}", "points": pts, "body": b["id"]})
                k += 1
            continue
        from build123d import Edge

        fmap, fnorm, em = _planar_face_normals(sh)
        for i in range(1, em.Extent() + 1):
            faces = em.FindFromIndex(i)
            if faces.Extent() == 2:
                fl = list(faces)
                n0, n1 = fnorm.get(fmap.FindIndex(fl[0])), fnorm.get(fmap.FindIndex(fl[1]))
                if n0 and n1 and abs(n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) > cos_tol:
                    continue  # coplanar seam — don't draw it
            e = Edge(em.FindKey(i))
            pts = [[p.X, p.Y, p.Z] for p in (e @ (j / n) for j in range(n + 1))]
            out.append({"id": f"e{k}", "points": pts, "body": b["id"]})
            k += 1
    return out


def bbox(shape):
    bb = shape.bounding_box()
    return {
        "min": [bb.min.X, bb.min.Y, bb.min.Z],
        "max": [bb.max.X, bb.max.Y, bb.max.Z],
    }
