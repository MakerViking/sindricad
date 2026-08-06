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

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
from OCP.GeomAbs import GeomAbs_Line
from OCP.TopAbs import TopAbs_Orientation
from OCP.TopLoc import TopLoc_Location

# Bumped whenever this module's output changes shape or quality for the SAME
# inputs, so server.py can put it in the disk mesh-artifact key and a cache
# written by an older algorithm is never served. (Same trick texture.py uses.)
#   1 -> fixed 24-segment edge polylines, absolute-only surface deflection
#   2 -> deviation-bounded edge polylines + optional relative surface deflection
#   3 -> the cached payload carries the body's mesh bbox (see mesh_bbox)
CODE_VERSION = 3


def tessellate(shape, tolerance=0.1, angular_tolerance=0.5, textures=None, density_cap=None,
                diag=None, normals_out=None, relative=False, force_remesh=False):
    """Return (positions, indices, face_ids).

    positions : flat [x,y,z, ...] floats
    indices   : flat [i,j,k, ...] triangle index triples
    face_ids  : [f0, f1, ...] one B-rep face id per triangle (len = len(indices)//3)

    tolerance   : chord deflection. ABSOLUTE millimetres by default; when
                  `relative` is True it is a DIMENSIONLESS fraction of each
                  edge/face's own size (see below).
    relative    : OCCT's BRepMesh `isRelative` flag. False (absolute mm) is what
                  EXPORT must use — a printed part needs a deterministic chord
                  error in mm regardless of how big the part is. True is for the
                  interactive viewport: OCCT then sizes the deflection per
                  feature, so a 1mm fillet on a 60mm ring gets a proportionally
                  finer mesh than the ring's big flat faces, which is exactly
                  where faceting is visible. Callers must pass a tolerance in the
                  matching UNITS — see server._effective_tolerance.
    textures    : optional [(spec, [Face,...]), ...] from
                  texture.resolve_body_textures() — targeted faces get
                  texture.displace_face()'s denser, displaced chunk instead of
                  the plain one below (same faceId tags, so faceTriangles
                  grouping needs no changes for a subdivided textured face).
    density_cap : per-face triangle budget passed through to displace_face
                  (None = texture.py's own export-tier safety cap).
    normals_out : optional list — receives (vertex_base, flat_normals) chunks
                  for each TEXTURED face's analytic displaced normals, so the
                  viewport payload can shade coarse displacement smoothly
                  (untextured faces are absent: the caller derives theirs from
                  the triangles, same as the client always did).
    """
    # Mesh the entire solid at once, in parallel (isInParallel=True). This fills an
    # incremental triangulation onto every TopoDS_Face, which we read back below.
    # OCCT STORES THE TRIANGULATION ON THE SHAPE, and BRepMesh_IncrementalMesh
    # treats an existing FINER mesh as good enough for a coarser request. So
    # asking for 0.02 after something asked for 0.001 silently returns the 0.001
    # mesh: measured on a sphere, 201,198 triangles when 10,108 were requested.
    #
    # That makes a tolerance BACKOFF a no-op by default — it would return the
    # mesh that already blew the budget, and look like it had worked. Dropping
    # the stored triangulation first is the only way to get the coarser mesh.
    # Off by default because it forces a re-mesh: only callers that are
    # deliberately CHANGING tolerance need it.
    if force_remesh:
        from OCP.BRepTools import BRepTools
        BRepTools.Clean_s(shape.wrapped)
    BRepMesh_IncrementalMesh(shape.wrapped, tolerance, relative, angular_tolerance, True)

    positions = []
    indices = []
    face_ids = []

    face_specs = {}
    if textures:
        from builder import _face_fp
        # later texture feature wins a face both target (timeline order = most
        # recent edit takes effect, same intuition as any other re-applied op)
        for spec, faces in textures:
            for f in faces:
                face_specs[_face_fp(f)] = spec

    for fid, face in enumerate(shape.faces()):
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
        if tri is None:
            continue  # degenerate face with no triangulation — skip it

        if face_specs:
            from builder import _face_fp
            spec = face_specs.get(_face_fp(face))
            if spec is not None:
                from texture import displace_face
                try:
                    local_pos, local_idx, local_norm = displace_face(
                        face, tri, loc, loc.IsIdentity(), spec, density_cap,
                        diag=diag, feature_id=spec.get("feature_id"),
                        # normals_out is the viewport payload's channel, so it is
                        # also the signal that this is the DISPLAY tessellation —
                        # the only place crease-splitting is safe (see displace_face)
                        split_creases=normals_out is not None,
                    )
                    base = len(positions) // 3
                    positions.extend(local_pos)
                    indices.extend(i + base for i in local_idx)
                    face_ids.extend([fid] * (len(local_idx) // 3))
                    if normals_out is not None:
                        normals_out.append((base, local_norm))
                    continue
                except Exception:
                    pass  # never crash a rebuild on a texture bug — fall through
                    # to the plain untextured path below for this face

        trsf = loc.Transformation()  # face-local -> world placement
        base = len(positions) // 3
        # batched readback: bind lookups once and extend in one call per face —
        # the per-triangle Python cost was ~60 µs/tri, dominated by attribute
        # dispatch, and this loop runs for every freshly (re)built body
        node = tri.Node
        ident = loc.IsIdentity()  # skip the per-node Transformed() when unplaced
        if ident:
            pts = [node(i) for i in range(1, tri.NbNodes() + 1)]
        else:
            pts = [node(i).Transformed(trsf) for i in range(1, tri.NbNodes() + 1)]
        flat = []
        for p in pts:
            flat.append(p.X()); flat.append(p.Y()); flat.append(p.Z())
        positions.extend(flat)
        # A face flagged REVERSED has its triangles wound the opposite way; flip the
        # winding so client-side computeVertexNormals() yields outward normals.
        flip = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
        get_tri = tri.Triangle
        ntri = tri.NbTriangles()
        tri_flat = []
        for i in range(1, ntri + 1):
            a, b, c = get_tri(i).Get()
            if flip:
                b, c = c, b
            tri_flat.append(base + a - 1)
            tri_flat.append(base + b - 1)
            tri_flat.append(base + c - 1)
        indices.extend(tri_flat)
        face_ids.extend([fid] * ntri)

    return positions, indices, face_ids


def tessellate_bodies(bodies, tolerance=0.1, density_cap=None, diag=None):
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
    from builder import _face_fp  # same fingerprint the provenance owner-map uses
    import texture as _texture
    for b in bodies:
        sh = b.get("shape")
        if sh is None:
            continue
        textures = _texture.resolve_body_textures(b, diag) if b.get("_textures") else None
        pos, idx, fids = tessellate(sh, tolerance, textures=textures, density_cap=density_cap, diag=diag)
        vbase = len(positions) // 3
        positions.extend(pos)
        indices.extend(i + vbase for i in idx)
        n_faces = (max(fids) + 1) if fids else 0
        face_ids.extend(fid + face_base for fid in fids)
        # per-face owning feature id (indexed by local face id) so a picked face maps
        # back to the feature that created it — for click-a-face-then-delete.
        owners_map = b.get("owners") or {}
        face_owners = [owners_map.get(_face_fp(face)) for face in sh.faces()]
        meta.append(
            {"id": b["id"], "name": b["name"], "faceStart": face_base,
             "faceCount": n_faces, "faceOwners": face_owners}
        )
        face_base += n_faces
    return positions, indices, face_ids, meta


def vertex_normals(positions, indices):
    """Area-weighted per-vertex normals for a whole mesh (flat lists in/out) —
    the same accumulation three.js's computeVertexNormals does, run server-side
    so a textured body's payload can carry normals for ALL its vertices: plain
    faces get these, textured chunks are overwritten with texture.py's analytic
    displaced normals (smooth shading at coarse displacement density)."""
    import numpy as np

    P = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    I = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    fn = np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]])  # length ∝ area
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, I[:, k], fn)
    ln = np.linalg.norm(N, axis=1)
    ln[ln < 1e-12] = 1.0
    return (N / ln[:, None]).ravel().tolist()


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


# Chord-deviation target for edge polylines, in MILLIMETRES, and the clamps
# around it. Edges are what the user actually reads as "is this circle round?",
# and they cost a few floats each in the JSON reply — far cheaper per unit of
# perceived quality than triangles. The old fixed 24-segments-per-edge left a
# 60mm circle 0.257mm off true, which is plainly visible zoomed in on a 1mm
# fillet.
#
# GCPnts_QuasiUniformDeflection hits this target almost exactly — measured on
# the parts in this repo's bench, requesting 0.01 achieved a worst-case 0.00995
# — so this constant IS the worst-case deviation, not a knob that merely
# correlates with it. 0.01mm holds a 60mm circle under a pixel at any zoom
# someone would inspect a fillet at (~0.75px at 20mm-across / 1500px), and it
# also makes SMALL parts cheaper rather than dearer: a 6mm cube's 0.5mm fillet
# arcs go from 848 points to 240, because deviation-based sampling stops
# subdividing once an arc is already sub-micron.
#
# The clamps are belt and braces, not quality knobs: a curved edge always gets
# at least _EDGE_MIN_SEG segments (a tiny arc still reads as an arc), and never
# more than _EDGE_MAX_SEG, so a pathological spline can't hand the frontend an
# unbounded point list. 512 covers a ~1m-diameter circle at the deflection
# above; the worst real edge measured here needed 122. Both must stay EVEN, so
# every clamped polyline also has an odd point count (see _sample_by_deflection).
_EDGE_DEFLECTION = 0.01
_EDGE_MIN_SEG = 4
_EDGE_MAX_SEG = 512
# Only for the last-ditch path where the deflection sampler can't run at all
# (no usable 3-D curve); matches the historical fixed count so that fallback
# behaves exactly as it always did.
_EDGE_FALLBACK_SEG = 24


# Edge-polyline memo keyed by (edge TShape, sampling parameters). The TShape
# alone (identity-location only) fully determines the world-space curve, and
# booleans preserve the TShapes of untouched edges, so even the CHANGED body's
# polyline pass is mostly cache hits. The sampling parameters MUST be part of
# the key: memoising on the TShape alone meant whichever deflection was used
# first won for the life of the process and silently pinned every later caller
# to it.
_EDGE_MEMO = {}


def _uniform_param_points(ad, n):
    """n+1 points walked along an adaptor's raw CURVE PARAMETER (u0..u1)."""
    u0, u1 = ad.FirstParameter(), ad.LastParameter()
    if not (u1 > u0):
        return None
    pts = []
    for j in range(n + 1):
        p = ad.Value(u0 + (u1 - u0) * (j / n))
        pts.append([p.X(), p.Y(), p.Z()])
    return pts


def _sample_by_param(e, n):
    """Fallback sampler: walk the edge by its raw CURVE PARAMETER (u0..u1) via the
    OCCT adaptor, instead of build123d's `e @ t` (which parameterises by ARC LENGTH
    through GCPnts_AbscissaPoint and raises Standard_ConstructionError on degenerate
    curves — e.g. a sphere's seam meridian, or a cone/revolve pole edge). Parameter
    sampling never computes arc length, so it can't hit that failure. Returns None
    when the edge has no usable 3-D curve (a true point-edge at a pole).

    Also used by builder.py's projected-curve fallback — keep the signature."""
    w = getattr(e, "wrapped", None)
    if w is None:
        return None
    try:
        return _uniform_param_points(BRepAdaptor_Curve(w), n)
    except Exception:
        return None


def _sample_by_deflection(w, deflection, min_seg, max_seg):
    """Deviation-bounded polyline for one edge: GCPnts_QuasiUniformDeflection over
    a BRepAdaptor_Curve subdivides until the chord is within `deflection` mm of the
    true curve, whatever the curve type — so a 60mm circle and a 1mm fillet arc
    each get exactly the segment count they need instead of a shared fixed guess.

    Returns None when the edge has no usable 3-D curve (a degenerate pole edge) or
    the algorithm bails, so the caller can fall back."""
    if w is None:
        return None
    try:
        ad = BRepAdaptor_Curve(w)
        u0, u1 = ad.FirstParameter(), ad.LastParameter()
        if not (u1 > u0):
            return None
        alg = GCPnts_QuasiUniformDeflection(ad, deflection, u0, u1)
        if not alg.IsDone():
            return None
        n = alg.NbPoints()
        if n < 2:
            return None
        if n - 1 < min_seg:
            return _uniform_param_points(ad, min_seg)
        if n - 1 > max_seg:
            # decimate evenly over the computed points (both ends kept). The
            # result is coarser than requested, which is the point of the cap.
            # max_seg is even, so this stays an odd count — see below.
            picks = [1 + round(i * (n - 1) / max_seg) for i in range(max_seg + 1)]
        else:
            picks = range(1, n + 1)
        out = []
        for i in picks:
            p = alg.Value(i)
            out.append([p.X(), p.Y(), p.Z()])
        if len(out) % 2 == 0:
            # Keep the point count ODD, by splitting the middle chord.
            #
            # The frontend identifies an edge by the INDEX-MIDDLE point of this
            # polyline (viewport/edgeMatch.ts polylineMid = pts[floor(len/2)]),
            # and that point is stored in saved documents as a `nearest` edge
            # selector. With an odd point count the index-middle is the exact
            # parametric midpoint — which is what the old fixed-25-point sampler
            # always produced, so saved selectors keep matching. With an EVEN
            # count it lands half a chord off (measured up to 0.77mm on a
            # 30mm-radius arc, past the frontend's 0.5mm match tolerance).
            # Adding the on-curve point midway between the two central samples
            # restores it and can only make the polyline finer, never coarser.
            j = len(out) // 2
            umid = 0.5 * (alg.Parameter(picks[j - 1]) + alg.Parameter(picks[j]))
            p = ad.Value(umid)
            out.insert(j, [p.X(), p.Y(), p.Z()])
        return out
    except Exception:
        return None


def _line_endpoints(w):
    """The two endpoints of a straight edge, or None if it isn't a line. A line is
    exactly its endpoints, so sampling it any finer is pure waste — and glyph
    strokes (text booleans) are overwhelmingly straight, so skipping them roughly
    halves wireframe extraction on engraved/embossed text."""
    if w is None:
        return None
    try:
        ad = BRepAdaptor_Curve(w)
        if ad.GetType() != GeomAbs_Line:
            return None
        p0 = ad.Value(ad.FirstParameter())
        p1 = ad.Value(ad.LastParameter())
        return [[p0.X(), p0.Y(), p0.Z()], [p1.X(), p1.Y(), p1.Z()]]
    except Exception:
        return None


def _edge_points(e, deflection=_EDGE_DEFLECTION, min_seg=_EDGE_MIN_SEG,
                  max_seg=_EDGE_MAX_SEG):
    w = getattr(e, "wrapped", None)
    key = None
    if w is not None:
        try:
            if w.Location().IsIdentity():
                key = (w.TShape(), deflection, min_seg, max_seg)
                hit = _EDGE_MEMO.get(key)
                if hit is not None:
                    return hit
        except Exception:
            key = None
    pts = _line_endpoints(w)
    if pts is None:
        pts = _sample_by_deflection(w, deflection, min_seg, max_seg)
    if pts is None:
        # no usable deviation-bounded sampling (degenerate seam/pole edge) — walk
        # the raw parameter so a valid body still renders its wireframe instead
        # of the whole tessellation reply erroring out.
        pts = _sample_by_param(e, _EDGE_FALLBACK_SEG)
        if pts is None:
            return None
    if key is not None:
        if len(_EDGE_MEMO) > 200_000:
            _EDGE_MEMO.clear()
        _EDGE_MEMO[key] = pts
    return pts


def edge_polylines(shape, deflection=_EDGE_DEFLECTION):
    """Sample every edge of one shape as a deviation-bounded polyline (see
    _edge_points). Untagged/unfiltered — `edge_polylines_by_body` is what the
    viewport actually ships; this is the single-shape convenience form."""
    out = []
    for i, e in enumerate(shape.edges()):
        pts = _edge_points(e, deflection)
        if pts is None:
            continue  # degenerate point-edge (pole) — nothing to draw
        out.append({"id": f"e{i}", "points": pts})
    return out


def edge_polylines_by_body(bodies, deflection=_EDGE_DEFLECTION, hide_coplanar_seams=True):
    """Sample each body's edges as polylines tagged with the body id (so the frontend
    can hide a hidden body's WIREFRAME). Two classes of edge are NOT real and are
    dropped (MCAD-style), so a part reads the way it would in any other CAD:

      * edges between two COPLANAR planar faces — a boolean's leftover seam, which
        would otherwise draw a line across a merged face;
      * the UV SEAM of a closed periodic face. A cylinder/cone/sphere/torus wraps
        onto itself, and OCCT records that closure as a real topological edge at
        u = 0 = 2pi. It is pure parametrisation bookkeeping: no tangent break, no
        crease, nothing a printer reproduces. Drawn, it put a vertical line down
        the side of every plain cylinder. The coplanar test above cannot catch it,
        because a seam has ONE face listed twice rather than two faces.

    One pass over the edge->face map: both tests and sampling together.
    Display-only; touches no geometry (can't hang).

    `deflection` is the chord-deviation target in mm (see _EDGE_DEFLECTION)."""
    import math

    from OCP.BRep import BRep_Tool
    from OCP.TopoDS import TopoDS

    cos_tol = math.cos(math.radians(1.0))
    out = []
    k = 0
    for b in bodies:
        sh = b.get("shape")
        if sh is None:
            continue
        if not (hide_coplanar_seams and getattr(sh, "wrapped", None) is not None):
            # No ancestor map here, so neither filter can run. Unreachable for a
            # build123d body (they always carry .wrapped); kept as a raw fallback.
            for e in sh.edges():
                pts = _edge_points(e, deflection)
                if pts is None:
                    continue  # degenerate point-edge (pole) — nothing to draw
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
            ek = em.FindKey(i)
            # IsClosed(edge, face) is OCCT's own seam test: true only when the edge
            # carries TWO pcurves on that one face, which is what a wrap-around
            # seam is. An edge shared by two distinct faces is never closed on
            # either, so a fillet's cylindrical face (not closed) keeps all of its
            # edges — measured: 0 dropped on a box with every edge filleted.
            # Both arguments need the concrete TopoDS types; the map hands back
            # TopoDS_Shape, and the bare shape overload of IsClosed means
            # something else entirely.
            ke = TopoDS.Edge_s(ek)
            # A DEGENERATE edge collapses to a point (a sphere's poles, a cone's
            # apex). OCCT flags it outright; _edge_points does not catch them —
            # it happily returns 5 coincident points, which draw as zero-length
            # segments. Harmless on screen but pure waste in the payload.
            if BRep_Tool.Degenerated_s(ke):
                continue
            if any(BRep_Tool.IsClosed_s(ke, TopoDS.Face_s(f)) for f in faces):
                continue
            e = Edge(ek)
            pts = _edge_points(e, deflection)
            if pts is None:
                continue  # degenerate point-edge (pole) — nothing to draw
            out.append({"id": f"e{k}", "points": pts, "body": b["id"]})
            k += 1
    return out


def bbox(shape):
    bb = shape.bounding_box()
    return {
        "min": [bb.min.X, bb.min.Y, bb.min.Z],
        "max": [bb.max.X, bb.max.Y, bb.max.Z],
    }


def mesh_bbox(shape):
    """Bounding box of the shape's TRIANGULATION — what the viewport actually
    draws — rather than of its exact geometry. For a display bbox this is both
    the cheaper and the more honest number.

    `shape.bounding_box()` runs BRepBndLib.AddOptimal_s, and on a 60mm filleted
    ring that measures 44.84 ms against 0.053 ms here — 846x, which across the
    3,071 bodies of a large assembly is ~138 s versus ~0.2 s. It also calls
    BRepTools.Clean_s, DISCARDING the triangulation tessellate() just built;
    BRepBndLib.Add_s leaves it in place.

    Accuracy on that same ring: exact is +/-30.0, this is +/-30.118 (OCCT adds
    its gap tolerance), and `bounding_box(optimal=False)` — the obvious cheap
    alternative — is +/-32.472, i.e. 2.5mm out on a 60mm part. Slightly LARGER
    than exact is also the safe direction for a camera fit: it never clips.

    Requires a triangulation to be present, so call it AFTER tessellate();
    without one OCCT falls back to the loose poles-based box."""
    bnd = Bnd_Box()
    BRepBndLib.Add_s(shape.wrapped, bnd, True)
    if bnd.IsVoid():
        return None
    xm, ym, zm, xM, yM, zM = bnd.Get()
    return {"min": [xm, ym, zm], "max": [xM, yM, zM]}
