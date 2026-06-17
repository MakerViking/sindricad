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


def bbox(shape):
    bb = shape.bounding_box()
    return {
        "min": [bb.min.X, bb.min.Y, bb.min.Z],
        "max": [bb.max.X, bb.max.Y, bb.max.Z],
    }
