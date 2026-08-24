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


def conform_shared_boundaries(positions, indices, face_ids, tol=1e-6):
    """Split away the T-junctions a textured face leaves along its boundary, so
    the whole body meshes watertight.

    texture.py densifies a textured face's boundary ring — to the sample spacing,
    and again wherever a crease crosses the rim — by LERPING along the existing
    boundary polyline. No gap opens: every new point lies exactly on the segment
    the neighbouring face spans. But that neighbour still spans it with ONE long
    edge, so the two sides share no edges any more. Measured on a 20mm cube with
    a single hex-textured face: 286 edges used by exactly one triangle, 282 of
    them with their midpoint strictly inside another such edge. Slicers weld by
    position and then read those as holes (Orca: "non-manifold edges"), which is
    what a printed part cannot have.

    Every triangle owning an under-shared edge is re-fanned, with the other
    side's vertices inserted along that edge. The fan runs from the polygon's
    CENTROID, not from a corner: the polygon is convex, so the centroid is
    strictly interior, whereas a corner fan emits a zero-area triangle whenever
    both edges at the apex carry insertions.

    Inserted vertices are COPIED, never shared with the neighbouring face —
    tessellate() gives every B-rep face its own vertex chunk and mesh_writers'
    normals depend on it for sharp face-to-face edges. Welding is the slicer's
    job, and it does it by position.

    Geometry is untouched to within `tol` (1 nanometre): every new vertex lies on
    an existing edge or inside an existing triangle, and the only vertices that
    MOVE are near-duplicates snapped onto each other by that same tolerance, so
    volume and silhouette are unchanged (verified by divergence-theorem volume in
    test_texture.py). Triangles are reordered — kept ones first, then the fans —
    which every consumer tolerates because face_ids is per-triangle and moves
    with them.

    Returns (positions, indices, face_ids) as flat numpy arrays; a mesh with
    nothing under-shared is returned unchanged.
    """
    import numpy as np
    from scipy.spatial import cKDTree

    P = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    F = np.asarray(face_ids, dtype=np.int64)

    def unchanged():
        return P.reshape(-1), T.reshape(-1), F

    if not len(T):
        return unchanged()

    # Weld by POSITION, for the edge count only — faces never share a vertex
    # index, so counting over raw indices calls every face boundary open.
    uq, inv = np.unique(np.round(P, 7), axis=0, return_inverse=True)
    inv = inv.ravel()
    # welded id -> one ORIGINAL vertex, so every geometric test and every copied
    # vertex below uses the exact position rather than the rounded weld key
    rep = np.empty(len(uq), dtype=np.int64)
    rep[inv] = np.arange(len(P))

    def under_shared(inv):
        """(edge endpoints as welded ids, flat slots of the under-shared ones).

        A slot is `triangle * 3 + corner`, so it names the one triangle that owns
        an edge nothing else shares."""
        W = inv[T]
        ends = np.stack([W[:, [0, 1]], W[:, [1, 2]], W[:, [2, 0]]], axis=1).reshape(-1, 2)
        # one int64 per edge instead of np.unique(axis=0)'s lexsort — the export
        # tier runs this over millions of triangles
        key = (np.minimum(ends[:, 0], ends[:, 1]) * len(uq)
               + np.maximum(ends[:, 0], ends[:, 1]))
        _u, back, counts = np.unique(key, return_inverse=True, return_counts=True)
        back = back.ravel()
        owner = np.empty(len(counts), dtype=np.int64)
        owner[back] = np.arange(len(back))  # count == 1: exactly one writer
        return ends, owner[np.flatnonzero(counts == 1)]

    ends, flat = under_shared(inv)
    if not len(flat):
        return unchanged()

    # Two faces can plant a crossing on the same shared edge a HAIR apart — the
    # two charts compute it independently, and the measured gap on a 110mm hex
    # plate was 1e-7 mm, one bucket of the weld above. Splitting cannot reconcile
    # such a pair: each point sits within `tol` of the other edge's ENDPOINT, so
    # the interior guard below rightly refuses to insert it (that would only
    # trade a hole for a sliver), and both edges stay one-sided however many
    # passes run. Merge them instead, snapping the exported positions too, so the
    # slicer's own weld also sees one vertex.
    rim = np.unique(ends[flat].ravel())
    pairs = cKDTree(P[rep[rim]]).query_pairs(tol, output_type="ndarray")
    if len(pairs):
        merged_into = {}

        def survivor(x):
            while merged_into.get(x, x) != x:
                x = merged_into[x]
            return x

        for i, j in pairs:
            a, b = survivor(int(rim[i])), survivor(int(rim[j]))
            if a != b:
                merged_into[max(a, b)] = min(a, b)
        remap = np.arange(len(uq))
        for x in merged_into:
            remap[x] = survivor(x)
        gone = np.flatnonzero(remap != np.arange(len(uq)))
        moved = np.isin(inv, gone)
        P = P.copy()  # `positions` may be the caller's own array
        P[moved] = P[rep[remap[inv[moved]]]]
        inv = remap[inv]
        ends, flat = under_shared(inv)
        if not len(flat):
            return unchanged()

    owner_tri, owner_slot = flat // 3, flat % 3

    # only a vertex that sits on an under-shared edge can be a T-junction
    cand = np.unique(ends[flat].ravel())
    cpos = P[rep[cand]]
    A, B = P[rep[ends[flat, 0]]], P[rep[ends[flat, 1]]]
    d = B - A
    length = np.linalg.norm(d, axis=1)
    inserts = {}  # (triangle, corner) -> welded ids lying strictly inside it
    hits_per_edge = cKDTree(cpos).query_ball_point(
        (A + B) * 0.5, length * 0.5 + tol, workers=-1)
    for k, hits in enumerate(hits_per_edge):
        if not hits or length[k] <= 0.0:
            continue
        hits = np.asarray(hits)
        q = cpos[hits]
        t = ((q - A[k]) @ d[k]) / (length[k] * length[k])
        # strictly interior in DISTANCE, not in parameter: a parametric epsilon
        # on a 0.05mm edge admits a point a hair from the endpoint, and inserting
        # a near-copy of a corner is how a fan gets a degenerate triangle
        on = ((t * length[k] > tol) & ((1.0 - t) * length[k] > tol)
              & (np.linalg.norm(A[k] + d[k] * t[:, None] - q, axis=1) <= tol))
        if on.any():
            inserts[(int(owner_tri[k]), int(owner_slot[k]))] = cand[hits[on]]
    if not inserts:
        return unchanged()

    by_tri = {}
    for (ti, slot), ids in inserts.items():
        by_tri.setdefault(ti, {})[slot] = ids

    keep = np.ones(len(T), dtype=bool)
    extra, new_tris, new_fids = [], [], []
    n_verts = len(P)
    for ti, slots in by_tri.items():
        keep[ti] = False
        poly, poly_pos = [], []
        for s in range(3):
            i0, i1 = int(T[ti, s]), int(T[ti, (s + 1) % 3])
            poly.append(i0)
            poly_pos.append(P[i0])
            ids = slots.get(s)
            if ids is None:
                continue
            pts = P[rep[ids]]
            for j in np.argsort((pts - P[i0]) @ (P[i1] - P[i0])):
                poly.append(n_verts + len(extra))
                extra.append(pts[j])
                poly_pos.append(pts[j])
        centre = n_verts + len(extra)
        extra.append(np.mean(poly_pos, axis=0))
        fid = int(F[ti])
        for k in range(len(poly)):
            new_tris.append((centre, poly[k], poly[(k + 1) % len(poly)]))
            new_fids.append(fid)

    P = np.concatenate([P, np.asarray(extra, dtype=np.float64)])
    T = np.concatenate([T[keep], np.asarray(new_tris, dtype=np.int64)])
    F = np.concatenate([F[keep], np.asarray(new_fids, dtype=np.int64)])
    return P.reshape(-1), T.reshape(-1), F


def open_edge_count(indices):
    """Edges used by exactly one triangle, counted on the INDICES AS GIVEN.

    Takes no positions, deliberately — no welding. That is the point. A mesh can
    be watertight by position and still be full of one-sided edges by index, and
    a slicer reading the indexed form is entitled to call that broken.
    `conform_shared_boundaries` fixes the first kind; `weld_vertices` fixes the
    second; this is what tells them apart.
    """
    import numpy as np

    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    if not len(T):
        return 0
    n = int(T.max()) + 1
    a = np.minimum(T[:, [0, 1, 2]], T[:, [1, 2, 0]])
    b = np.maximum(T[:, [0, 1, 2]], T[:, [1, 2, 0]])
    _u, c = np.unique((a * n + b).ravel(), return_counts=True)
    return int((c == 1).sum())


def flipped_edge_count(indices):
    """Shared edges whose two triangles are wound the SAME way round.

    A closed, consistently oriented surface traverses every interior edge once in
    each direction. Two triangles that both go a->b disagree about which side is
    out, and a slicer counts that edge as non-manifold once per triangle — which
    is exactly how 478 of these read as "956 non-manifold edges" in Orca on a mesh
    with no holes at all.

    Counted on the indices as given, so run it on a WELDED mesh: unwelded, almost
    no edge is shared and it reports a contented zero."""
    import numpy as np

    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    if not len(T):
        return 0
    he = np.stack([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]], axis=1).reshape(-1, 2)
    n = int(T.max()) + 1
    _u, c = np.unique(he[:, 0] * n + he[:, 1], return_counts=True)
    return int((c > 1).sum())


def orient_consistently(positions, indices):
    """Wind every triangle to agree with its neighbours, and every closed shell
    outward. Run on a WELDED mesh — it needs shared indices to have neighbours.

    Why this is not already true: texture.py's `_orient_windings` checks each
    triangle against its OWN vertices' analytic normals. That is a per-triangle
    test, and on a faceted displacement the vertex normals on a steep facet can
    disagree with the facet itself, so some triangles get turned the wrong way.
    Measured on a hex-textured 40mm cube: 1911 disagreeing edges straight out of
    tessellate, against 0 on the same cube untextured.

    Fixed HERE rather than in texture.py on purpose. The viewport does not care —
    it shades from analytic normals and splits creases — while a change in there
    would mean a CODE_VERSION bump that invalidates every cached textured mesh
    for a defect only the exporter sees.

    Two passes, and the second is the safety net for the first:
      1. Propagate. Walk the triangle graph over shared edges and flip whatever
         disagrees with the neighbour it was reached from. That makes each shell
         self-consistent but says nothing about which way is out.
      2. Point it outward. Per connected shell, if the signed volume came out
         negative the whole shell is inside-out, so flip it. Applied only to
         shells that are actually CLOSED: an open shell's signed volume is
         meaningless, and flipping one on that basis would be a coin toss.
    """
    import numpy as np

    P = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    if len(T) < 2:
        return P.reshape(-1), T.reshape(-1)

    ntri = len(T)
    he = np.stack([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]], axis=1).reshape(-1, 2)
    nv = int(T.max()) + 1
    lo = np.minimum(he[:, 0], he[:, 1])
    hi = np.maximum(he[:, 0], he[:, 1])
    key = lo * nv + hi

    # Pair up the half-edges that share an undirected edge. Only edges with
    # EXACTLY two are adjacency: a one-sided edge has no neighbour to agree with,
    # and a >2 edge has no single right answer.
    order = np.argsort(key, kind="stable")
    ks = key[order]
    heads = np.flatnonzero(np.r_[True, ks[1:] != ks[:-1]])
    counts = np.diff(np.r_[heads, len(ks)])
    pair = heads[counts == 2]
    if not len(pair):
        return P.reshape(-1), T.reshape(-1)
    sa, sb = order[pair], order[pair + 1]
    ta, tb = sa // 3, sb // 3
    # Both half-edges pointing the same way means the two triangles disagree.
    disagree = he[sa, 0] == he[sb, 0]

    # CSR adjacency over triangles, built symmetrically so the walk can cross
    # each edge either way.
    src = np.concatenate([ta, tb])
    dst = np.concatenate([tb, ta])
    par = np.concatenate([disagree, disagree]).astype(np.int8)
    o = np.argsort(src, kind="stable")
    src, dst, par = src[o], dst[o], par[o]
    indptr = np.searchsorted(src, np.arange(ntri + 1))

    flip = np.zeros(ntri, dtype=bool)
    comp = np.full(ntri, -1, dtype=np.int64)
    seen = np.zeros(ntri, dtype=bool)
    ncomp = 0
    for root in range(ntri):
        if seen[root]:
            continue
        seen[root] = True
        comp[root] = ncomp
        stack = [root]
        while stack:
            t = stack.pop()
            for k in range(indptr[t], indptr[t + 1]):
                nb = dst[k]
                if seen[nb]:
                    continue
                seen[nb] = True
                comp[nb] = ncomp
                # agree with the triangle we arrived from
                flip[nb] = flip[t] ^ bool(par[k])
                stack.append(nb)
        ncomp += 1

    out = T.copy()
    out[flip] = out[flip][:, [0, 2, 1]]

    # Pass 2 — outward. Only for shells with no boundary: `counts == 1` marks a
    # one-sided edge, and a shell owning one is open.
    one_sided = heads[counts == 1]
    open_comps = set(comp[order[one_sided] // 3].tolist()) if len(one_sided) else set()
    a, b, c = P[out[:, 0]], P[out[:, 1]], P[out[:, 2]]
    vol6 = np.einsum("ij,ij->i", a, np.cross(b, c))
    per_comp = np.bincount(comp, weights=vol6, minlength=ncomp)
    inside_out = [i for i in range(ncomp) if per_comp[i] < 0 and i not in open_comps]
    if inside_out:
        sel = np.isin(comp, inside_out)
        out[sel] = out[sel][:, [0, 2, 1]]
    return P.reshape(-1), out.reshape(-1)


def weld_vertices(positions, indices, face_ids=None):
    """Share ONE index per distinct position. For the indexed export formats only.

    tessellate() gives every B-rep face its own vertex chunk and never shares an
    index across a face boundary, so a perfectly closed surface still exports
    with thousands of edges that only one triangle references. Measured on a
    textured cube Orca rejected: 4502 vertices for 3219 distinct positions, and
    2558 one-sided edges by index against 0 by position. Slicers do not all weld
    on load, and the ones that don't call that non-manifold and offer a "repair"
    that destroys a textured mesh.

    Geometry is untouched: this only makes two vertices that ALREADY sat at the
    same coordinates share a slot. On that same file — same 6434 triangles, same
    volume to the last digit, same bbox, nothing collapsed.

    NOT part of `conform_shared_boundaries`, and the two must not be merged:
    that pass deliberately COPIES vertices to keep the per-face chunking intact,
    because mesh_writers' glTF normals rely on it for sharp face-to-face edges
    (see its `_vertex_normals`). Welding is safe only where no normals travel
    with the file — 3MF and STL — and only per BODY. Welding a merged multi-body
    soup would fuse two touching bodies into one shell.

    Returns (positions, indices, face_ids) as flat numpy arrays, face_ids being
    None when none was passed. Triangles that collapse — two corners landing on
    one vertex — are dropped: they are zero-area, and leaving them in
    re-introduces the one-sided edges this exists to remove. `face_ids` rides
    along precisely so the painted-3MF writer's per-triangle array cannot fall
    out of step with the triangles when that happens.
    """
    import numpy as np

    P = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    F = None if face_ids is None else np.asarray(face_ids).reshape(-1)
    if not len(T):
        return P.reshape(-1), T.reshape(-1), F
    uq, inv = np.unique(np.round(P, 7), axis=0, return_inverse=True)
    inv = inv.ravel()
    # Keep an ORIGINAL coordinate per welded slot rather than the rounded key the
    # bucketing used — the survivor's own position, unmoved. Rounding every
    # vertex to 1e-7 would be invisible in a 3MF (%.6g) but it is still a nudge
    # applied to geometry that had no reason to move.
    rep = np.empty(len(uq), dtype=np.int64)
    rep[inv] = np.arange(len(P))
    W = inv[T]
    keep = (W[:, 0] != W[:, 1]) & (W[:, 1] != W[:, 2]) & (W[:, 2] != W[:, 0])
    return P[rep].reshape(-1), W[keep].reshape(-1), (None if F is None else F[keep])


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


def _list_shapes(lst):
    """Elements of an OCP shape list WITHOUT draining its Python iterator.

    Exhausting a pybind11-bound OCCT collection costs ~101us of FIXED cost when
    StopIteration fires, independent of length (measured on a 2-element
    TopTools_ListOfShape: iter + 2 next() = 0.9us, the third next() = 101us),
    while Extent() is 0.18us and First()/Last() together are 0.55us.

    edge_polylines_by_body used to drain each edge's ancestor list TWICE — once
    for the coplanar test, once for the seam test — so ~202us of every edge went
    on iterator teardown, dwarfing the ~1us to emit a straight line or ~82us to
    sample a circle. Almost every edge has one or two adjacent faces, so the
    drain now happens only in the non-manifold >2 case, which no shape in the
    fixtures produces at all. Measured on a cold open of the 356 MiB reference
    assembly: that pass went 85.7 s -> 7.7 s (11.1x), taking the whole cold open
    from 298 s to 220 s. Output is byte-identical — same 348,580 polylines, same
    1,726,523 points — which is why this needs no CODE_VERSION bump: the cached
    mesh artifacts stay valid, so the warm reopen path is untouched.

    First() on an EMPTY list raises Standard_NoSuchObject, and an edge with no
    adjacent face is reachable (a free wire on a compound body), so the count is
    checked before either accessor is touched. Returns a tuple, so callers can
    iterate it as many times as they like for free.

    builder.py keeps its own copy of this; tessellate deliberately does not
    import builder, which would drag build123d's whole import graph in here."""
    n = lst.Extent()
    if n == 0:
        return ()
    if n == 1:
        return (lst.First(),)
    if n == 2:
        return (lst.First(), lst.Last())
    return tuple(lst)  # non-manifold: rare, and correctness beats the microseconds


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
            faces = _list_shapes(em.FindFromIndex(i))
            if len(faces) == 2:
                n0, n1 = fnorm.get(fmap.FindIndex(faces[0])), fnorm.get(fmap.FindIndex(faces[1]))
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
            # A wrap-around seam is ONE face listed TWICE, so both entries of the
            # (already materialized, free to re-iterate) tuple get tested.
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
