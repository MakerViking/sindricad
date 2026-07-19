"""Printed surface texture: knurl/hex/waves/ribs/voronoi/noise/image height fields,
displaced into a face's triangulation at tessellation/export time.

Two-phase design (mirrors selector-v2's own resolve-lazily pattern): builder.py's
_handle_texture validates the spec against the CURRENT shape (for red-timeline
feedback) and appends the raw spec to body["_textures"] — it never touches
body["shape"]. The actual face selectors are resolved lazily, ONCE, against the
FINAL shape by resolve_body_textures() below, called from tessellate.py right
before meshing. This sidesteps every downstream-feature topology change the same
way every other selector-based feature already does (best-effort nearest-match +
diagnostic on drift, never a hard failure).

Displacement never edits the BRep (no variable-offset API in OCCT for this); it
subdivides + displaces the MESH at tessellation time. See displace_face().
"""

import math

import numpy as np

TEXTURE_KINDS = {"knurl", "hex", "waves", "ribs", "voronoi", "noise", "image"}
_DIRECTIONS = {"out", "in", "both"}

# Export-tier safety net even when the caller passes density_cap=None — a
# pathologically fine scale/depth combo must not be able to allocate unbounded
# memory. server.py's EXPORT_DENSITY_CAP_PER_FACE is normally what applies.
_DEFAULT_DENSITY_CAP = 2_000_000

# Bump on ANY change to the displacement algorithm/output (subdivision, height
# fields, normals, taper): it participates in the persistent mesh-cache key, so
# a code update invalidates cached textured meshes instead of serving stale
# geometry built by the previous version.
CODE_VERSION = 3


def validate_texture_spec(f):
    """Validate a raw texture feature dict and return the CLEANED spec stored on
    body["_textures"]. Raises ValueError with a user-facing message — the same
    convention every other handler uses (see _handle_shell/_handle_draft)."""
    kind = f.get("kind")
    if kind not in TEXTURE_KINDS:
        raise ValueError(f"unknown texture kind: {kind!r}")
    depth = f.get("depth", 0.4)
    if not isinstance(depth, (int, float)) or depth <= 0:
        raise ValueError("texture depth must be a positive number")
    scale = f.get("scale", 2.0)
    if not isinstance(scale, (int, float)) or scale <= 0:
        raise ValueError("texture scale must be a positive number")
    direction = f.get("direction", "out")
    if direction not in _DIRECTIONS:
        raise ValueError(f"unknown texture direction: {direction!r}")
    image_path = f.get("imagePath")
    if kind == "image":
        if not image_path:
            raise ValueError("image texture needs an image path")
        try:
            from PIL import Image

            with Image.open(image_path) as im:
                im.verify()
        except Exception as ex:
            raise ValueError(f"can't read texture image {image_path!r}: {ex}") from ex
    spec = {
        "feature_id": f.get("id"),
        "kind": kind,
        "faces": f.get("faces") or {"by": "all"},
        "body": f.get("body"),
        "depth": float(depth),
        "scale": float(scale),
        "angle": float(f.get("angle", 0.0)),
        "offset": float(f.get("offset", 0.0)),
        "sharpness": float(f.get("sharpness", 0.5)),
        "direction": direction,
        "seed": int(f.get("seed") or 0),
        "octaves": max(1, min(int(f.get("octaves") or 3), 6)),
        "invert": bool(f.get("invert", False)),
        "boundaryInset": max(float(f.get("boundaryInset", 1.0)), 0.0),
    }
    if kind == "image":
        spec["imagePath"] = image_path
    return spec


def _resolve_texture_faces(shape, sel, diag=None, feature_id=None):
    """resolve_faces() (geom_select.py) only takes ONE selector dict; a texture's
    `faces` may be a list (like press-pull's multi-face `face`). Union + dedup by
    _face_fp, same pattern _handle_press_pull uses for its own sels loop."""
    from builder import _face_fp
    from geom_select import resolve_faces

    sels = sel if isinstance(sel, list) else [sel]
    seen = {}
    for s in sels:
        for face in resolve_faces(shape, s, diag=diag, feature_id=feature_id):
            seen.setdefault(_face_fp(face), face)
    return list(seen.values())


def resolve_body_textures(body, diag=None):
    """Lazily resolve every texture spec on `body` against its FINAL shape. Returns
    [(spec, [Face, ...]), ...] — specs whose selector now matches zero faces (the
    targeted face was fully consumed downstream) are dropped, same best-effort
    behavior as every other selector-based feature."""
    specs = body.get("_textures") or []
    if not specs:
        return []
    shape = body.get("shape")
    if shape is None:
        return []
    out = []
    for spec in specs:
        faces = _resolve_texture_faces(
            shape, spec.get("faces") or {"by": "all"}, diag, spec.get("feature_id")
        )
        if faces:
            out.append((spec, faces))
    return out


# --- height fields (kind -> vectorized numpy [0,1] "raggedness" field) -------


def _rotate(u, v, angle_deg):
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    return u * ca - v * sa, u * sa + v * ca


def _tri_wave(x, period):
    t = (x % period) / period
    return 1.0 - np.abs(2.0 * t - 1.0)


def _sharpen(h, sharpness):
    # sharpness in [0,1]; higher = crisper peaks/valleys, via a power curve.
    return h ** (1.0 + 4.0 * max(0.0, min(1.0, sharpness)))


def _height_knurl(u, v, scale, angle, sharpness):
    # crossed triangle-wave ridges (angle, angle+90) — classic diamond knurl.
    _, v1 = _rotate(u, v, angle)
    _, v2 = _rotate(u, v, angle + 90.0)
    h = _tri_wave(v1, scale) * _tri_wave(v2, scale)
    return _sharpen(h, sharpness)


def _height_hex(u, v, scale):
    # 3-direction cosine interference sum — a closed-form honeycomb pattern
    # (no lattice nearest-neighbor search needed), normalized to [0,1].
    root3 = math.sqrt(3.0)
    a = np.cos(2 * np.pi * u / scale)
    b = np.cos(2 * np.pi * (u * 0.5 - v * root3 * 0.5) / scale)
    c = np.cos(2 * np.pi * (u * 0.5 + v * root3 * 0.5) / scale)
    return np.clip((a + b + c) / 3.0 * 0.5 + 0.5, 0.0, 1.0)


def _height_waves(u, v, scale, angle, sharpness):
    u1, _ = _rotate(u, v, angle)
    h = 0.5 + 0.5 * np.sin(2 * np.pi * u1 / scale)
    return _sharpen(h, sharpness)


def _height_ribs(u, v, scale, angle, sharpness):
    u1, _ = _rotate(u, v, angle)
    return _sharpen(_tri_wave(u1, scale), sharpness)


def _height_voronoi(u, v, scale, seed):
    from scipy.spatial import cKDTree

    rng = np.random.default_rng(int(seed))
    umin, umax, vmin, vmax = u.min(), u.max(), v.min(), v.max()
    pad = scale
    nu = max(2, int((umax - umin + 2 * pad) / scale) + 2)
    nv = max(2, int((vmax - vmin + 2 * pad) / scale) + 2)
    iu, iv = np.meshgrid(np.arange(nu), np.arange(nv), indexing="ij")
    jitter = rng.uniform(0.2, 0.8, (nu, nv, 2))
    gu = umin - pad + scale * (iu + jitter[:, :, 0])
    gv = vmin - pad + scale * (iv + jitter[:, :, 1])
    pts = np.stack([gu.ravel(), gv.ravel()], axis=1)
    tree = cKDTree(pts)
    d, _ = tree.query(np.stack([u, v], axis=1))
    return np.clip(d / (scale * 0.5), 0.0, 1.0)


def _lerp(a, b, t):
    return a + t * (b - a)


def _perlin2(x, y, perm):
    """Vectorized 2D gradient noise (Perlin-style), 4-direction diagonal gradients —
    the standard cheap simplification (full 8/12-direction gradient sets buy
    smoothness we don't need for a bump texture)."""
    xi = np.floor(x).astype(np.int64) & 255
    yi = np.floor(y).astype(np.int64) & 255
    xf = x - np.floor(x)
    yf = y - np.floor(y)
    u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)  # quintic fade
    v = yf * yf * yf * (yf * (yf * 6 - 15) + 10)

    def grad(h, gx, gy):
        h = h & 3
        sx = np.where((h & 1) == 0, 1.0, -1.0)
        sy = np.where((h & 2) == 0, 1.0, -1.0)
        return sx * gx + sy * gy

    aa = perm[perm[xi] + yi]
    ba = perm[perm[xi + 1] + yi]
    ab = perm[perm[xi] + yi + 1]
    bb = perm[perm[xi + 1] + yi + 1]

    x1 = _lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u)
    x2 = _lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u)
    return _lerp(x1, x2, v)


def _height_noise(u, v, scale, seed, octaves):
    rng = np.random.default_rng(int(seed))
    p = rng.permutation(256).astype(np.int64)
    perm = np.concatenate([p, p])
    total = np.zeros_like(u)
    amp = 1.0
    freq = 1.0
    max_amp = 0.0
    for _ in range(octaves):
        total = total + amp * _perlin2(u / scale * freq, v / scale * freq, perm)
        max_amp += amp
        amp *= 0.5
        freq *= 2.0
    total = total / max_amp
    return np.clip(total * 0.5 + 0.5, 0.0, 1.0)


def _height_image(u, v, image_path, u_range, v_range):
    from PIL import Image

    with Image.open(image_path) as im:
        arr = np.asarray(im.convert("L"), dtype=np.float64) / 255.0
    h_img, w_img = arr.shape
    umin, umax = u_range
    vmin, vmax = v_range
    uu = np.clip((u - umin) / max(umax - umin, 1e-9), 0.0, 1.0)
    vv = np.clip((v - vmin) / max(vmax - vmin, 1e-9), 0.0, 1.0)
    fx = uu * (w_img - 1)
    fy = (1.0 - vv) * (h_img - 1)  # image row 0 is the TOP; v grows "up"
    x0 = np.floor(fx).astype(np.int64)
    x1 = np.clip(x0 + 1, 0, w_img - 1)
    y0 = np.floor(fy).astype(np.int64)
    y1 = np.clip(y0 + 1, 0, h_img - 1)
    tx = fx - x0
    ty = fy - y0
    top = arr[y0, x0] * (1 - tx) + arr[y0, x1] * tx
    bot = arr[y1, x0] * (1 - tx) + arr[y1, x1] * tx
    return top * (1 - ty) + bot * ty


def height_field(kind, spec, u_mm, v_mm, u_range=None, v_range=None):
    """Return a [0,1] "raggedness" field (0=valley, 1=peak) for the given kind, as a
    plain vectorized numpy computation over the u_mm/v_mm coordinate arrays."""
    scale = max(float(spec.get("scale", 2.0)), 0.05)
    angle = float(spec.get("angle", 0.0))
    sharpness = float(spec.get("sharpness", 0.5))
    if kind == "knurl":
        return _height_knurl(u_mm, v_mm, scale, angle, sharpness)
    if kind == "hex":
        return _height_hex(u_mm, v_mm, scale)
    if kind == "waves":
        return _height_waves(u_mm, v_mm, scale, angle, sharpness)
    if kind == "ribs":
        return _height_ribs(u_mm, v_mm, scale, angle, sharpness)
    if kind == "voronoi":
        return _height_voronoi(u_mm, v_mm, scale, spec.get("seed", 0))
    if kind == "noise":
        return _height_noise(u_mm, v_mm, scale, spec.get("seed", 0), spec.get("octaves", 3))
    if kind == "image":
        return _height_image(u_mm, v_mm, spec["imagePath"], u_range, v_range)
    raise ValueError(f"unknown texture kind: {kind}")


# --- UV -> mm (first fundamental form) ---------------------------------------


def _face_uv_to_mm(surf, u, v):
    """Convert native (u,v) surface parameters to a locally mm-consistent
    coordinate pair, so a periodic pattern (period = `scale` mm) looks the same
    size whether it's on a flat face or wrapped around a cylinder. Exact closed
    form for plane/cylinder/cone (verified against BRepAdaptor_Surface.D1 — see
    the module docstring's design notes); every other surface type (sphere,
    torus, bspline/freeform) gets a single-Jacobian-sample approximation at the
    face's UV centroid — a documented stretch/compression approximation on
    strongly curved freeform faces, not a printability defect (accepted v1
    limitation, see the plan's risk table)."""
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane
    from OCP.gp import gp_Pnt, gp_Vec

    t = surf.GetType()
    if t == GeomAbs_Plane:
        return u.copy(), v.copy()  # gp_Pln U,V params ARE mm distances
    if t == GeomAbs_Cylinder:
        r = surf.Cylinder().Radius()
        return u * r, v.copy()  # U is angle (rad); V is already axial mm
    if t == GeomAbs_Cone:
        cone = surf.Cone()
        r_at_v = cone.RefRadius() + v * math.sin(cone.SemiAngle())
        return u * r_at_v, v.copy()  # V is already slant-arc-length mm

    u0 = float(np.mean(u))
    v0 = float(np.mean(v))
    p, d1u, d1v = gp_Pnt(), gp_Vec(), gp_Vec()
    surf.D1(u0, v0, p, d1u, d1v)
    su = max(d1u.Magnitude(), 1e-9)
    sv = max(d1v.Magnitude(), 1e-9)
    return (u - u0) * su, (v - v0) * sv


# --- mesh refinement + displacement ------------------------------------------


def _points_in_polygon(pts, ring_a, ring_b, chunk=4096):
    """Even-odd ray-cast of 2D points against a polygon given as edge segment
    arrays (E,2)+(E,2) — handles multiple rings/holes for free since even-odd
    doesn't care about ring grouping. Chunked over points to bound the (C,E)
    broadcast."""
    inside = np.zeros(len(pts), dtype=bool)
    ay, by = ring_a[:, 1][None, :], ring_b[:, 1][None, :]
    ax, bx = ring_a[:, 0][None, :], ring_b[:, 0][None, :]
    dy = np.where(np.abs(by - ay) < 1e-30, 1e-30, by - ay)
    for s in range(0, len(pts), chunk):
        P = pts[s:s + chunk]
        py = P[:, 1][:, None]
        straddles = (ay <= py) != (by <= py)
        t = (py - ay) / dy
        xint = ax + t * (bx - ax)
        hits = straddles & (xint > P[:, 0][:, None])
        inside[s:s + chunk] = (hits.sum(axis=1) % 2).astype(bool)
    return inside


def _aligned_grid_triangulation(base_pts, base_uv, base_tris, u_mm, v_mm,
                                angle_deg, target_edge_mm, max_tris):
    """PLANAR faces: retessellate with a regular sample grid ROTATED to the
    pattern angle, instead of subdividing the axis-aligned base triangulation.
    A diagonal pattern sampled on an axis-aligned grid beats against it — the
    crest apex lands sometimes on a vertex, sometimes between two, so ridges
    come out visibly "roped" at practical densities. With the grid aligned to
    the pattern, crests run exactly along grid rows and are straight at the
    SAME triangle budget. Boundary ring vertices are kept verbatim (the
    crack-free zero-taper invariant needs them bit-identical); the interior
    grid + ring are Delaunay-triangulated in mm space and triangles whose
    centroid falls outside the face polygon are dropped (handles holes and
    concavity without a constrained triangulation). Raises on anything
    unexpected — the caller falls back to _refine_face_triangulation."""
    from scipy.spatial import Delaunay, cKDTree

    edge_count = _boundary_edges([tuple(t) for t in base_tris])
    boundary = [k for k, n in edge_count.items() if n == 1]
    if len(boundary) < 3:
        raise ValueError("degenerate boundary")
    P_mm = np.stack([np.asarray(u_mm), np.asarray(v_mm)], axis=1)
    ring_a = P_mm[[e[0] for e in boundary]]
    ring_b = P_mm[[e[1] for e in boundary]]

    # budget-aware spacing: the target sample step, widened if the face's area
    # can't afford it (the wavelength clamp downstream then keeps it clean)
    tri_idx = np.asarray(base_tris, dtype=np.int64)
    e1 = P_mm[tri_idx[:, 1]] - P_mm[tri_idx[:, 0]]
    e2 = P_mm[tri_idx[:, 2]] - P_mm[tri_idx[:, 0]]
    area = float(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum() * 0.5)
    spacing = max(target_edge_mm, math.sqrt(2.2 * area / max(max_tris, 100)))

    # rotated regular grid over the face bbox, kept strictly interior.
    # Pattern chart convention MUST match _rotate() in the height fields:
    # u1 = u·cosθ − v·sinθ (crest lines of waves/ribs run along constant u1),
    # so pattern coords = (u·c − v·s, u·s + v·c) and the grid is generated
    # regular in THAT frame, then mapped back with the inverse rotation.
    ang = math.radians(angle_deg)
    ca, sa = math.cos(ang), math.sin(ang)
    rp_u = P_mm[:, 0] * ca - P_mm[:, 1] * sa
    rp_v = P_mm[:, 0] * sa + P_mm[:, 1] * ca
    lo_u, hi_u = rp_u.min() - spacing, rp_u.max() + spacing
    lo_v, hi_v = rp_v.min() - spacing, rp_v.max() + spacing
    gx = np.arange(lo_u, hi_u, spacing)
    gy = np.arange(lo_v, hi_v, spacing)
    if len(gx) * len(gy) > 4 * max(max_tris, 100):
        raise ValueError("grid overshoots budget")
    GX, GY = np.meshgrid(gx, gy, indexing="ij")
    gu, gv = GX.ravel(), GY.ravel()
    G_all = np.stack([gu * ca + gv * sa, -gu * sa + gv * ca], axis=1)  # inverse rotation
    inside = _points_in_polygon(G_all, ring_a, ring_b)
    bnd_ids = np.unique(np.asarray(boundary, dtype=np.int64).ravel())
    d_bnd, _ = cKDTree(P_mm[bnd_ids]).query(G_all)
    ni, nj = len(gx), len(gy)
    kept = (inside & (d_bnd > 0.6 * spacing)).reshape(ni, nj)

    # STRUCTURED interior triangulation with one consistent diagonal per cell.
    # (Delaunay on a regular grid is co-circular — its arbitrary tie-break
    # flips diagonals cell to cell, and the between-row surface tents
    # differently per cell: visible "roped" beading along otherwise-straight
    # crests. A fixed diagonal removes that entirely.) Delaunay is only used
    # for the irregular band stitching the grid region to the boundary ring.
    n_ring = len(bnd_ids)
    gidx = np.full((ni, nj), -1, dtype=np.int64)
    gidx[kept] = n_ring + np.arange(int(kept.sum()))
    G = G_all.reshape(ni, nj, 2)[kept]

    full = kept[:-1, :-1] & kept[1:, :-1] & kept[1:, 1:] & kept[:-1, 1:]
    ii, jj = np.nonzero(full)
    a = gidx[ii, jj]; b_ = gidx[ii + 1, jj]; c = gidx[ii + 1, jj + 1]; d = gidx[ii, jj + 1]
    interior_tris = np.concatenate([np.stack([a, b_, c], axis=1), np.stack([a, c, d], axis=1)])

    # band = ring verts + kept grid points NOT fully surrounded by full cells
    # (a point with all 4 adjacent cells full is interior-only; everything else
    # participates in the stitching band)
    surrounded = np.zeros((ni, nj), dtype=bool)
    core = full[:-1, :-1] & full[1:, :-1] & full[1:, 1:] & full[:-1, 1:]
    surrounded[1:-1, 1:-1] = core
    band_mask = kept & ~surrounded
    band_ids = np.concatenate([np.arange(n_ring), gidx[band_mask]])

    V_mm = np.concatenate([P_mm[bnd_ids], G])
    if len(V_mm) < 4:
        raise ValueError("too few vertices")
    band_pts = V_mm[band_ids]
    band_tris_local = Delaunay(band_pts).simplices
    band_tris = band_ids[band_tris_local]
    cent = V_mm[band_tris].mean(axis=1)
    f1 = V_mm[band_tris[:, 1]] - V_mm[band_tris[:, 0]]
    f2 = V_mm[band_tris[:, 2]] - V_mm[band_tris[:, 0]]
    tri_area = f1[:, 0] * f2[:, 1] - f1[:, 1] * f2[:, 0]
    # drop band triangles outside the face, degenerate, or overlapping a FULL
    # grid cell (already triangulated above) — cell test in rotated grid coords
    cu = cent[:, 0] * ca - cent[:, 1] * sa
    cv = cent[:, 0] * sa + cent[:, 1] * ca
    ci = np.clip(((cu - lo_u) / spacing).astype(np.int64), 0, ni - 2)
    cj = np.clip(((cv - lo_v) / spacing).astype(np.int64), 0, nj - 2)
    keep = (_points_in_polygon(cent, ring_a, ring_b)
            & (np.abs(tri_area) > spacing * spacing * 1e-4)
            & ~full[ci, cj])
    tris = np.concatenate([interior_tris, band_tris[keep]])
    if len(tris) == 0:
        raise ValueError("empty after filtering")

    # map back: boundary verts keep their ORIGINAL uv/xyz verbatim; grid points
    # go through affine fits (exact on a plane — uv and xyz are both affine in
    # the mm chart), so no per-point OCCT evaluation is needed at all
    base_uv_arr = np.asarray(base_uv, dtype=np.float64)
    base_pts_arr = np.asarray(base_pts, dtype=np.float64)
    M = np.column_stack([P_mm, np.ones(len(P_mm))])
    A_uv, res_uv, _rk, _sv = np.linalg.lstsq(M, base_uv_arr, rcond=None)
    A_xyz, res_xyz, _rk2, _sv2 = np.linalg.lstsq(M, base_pts_arr, rcond=None)
    fit_err = np.abs(M @ A_xyz - base_pts_arr).max()
    if fit_err > max(1e-4, spacing * 1e-3):
        raise ValueError("non-affine chart (not a plane?)")
    GM = np.column_stack([G, np.ones(len(G))])
    uv_out = np.concatenate([base_uv_arr[bnd_ids], GM @ A_uv])
    pts_out = np.concatenate([base_pts_arr[bnd_ids], GM @ A_xyz])

    # winding: match the base triangulation's outward orientation
    n_ref = np.cross(base_pts_arr[tri_idx[0, 1]] - base_pts_arr[tri_idx[0, 0]],
                     base_pts_arr[tri_idx[0, 2]] - base_pts_arr[tri_idx[0, 0]])
    n_new = np.cross(pts_out[tris[:, 1]] - pts_out[tris[:, 0]],
                     pts_out[tris[:, 2]] - pts_out[tris[:, 0]])
    wrong = (n_new @ n_ref) < 0
    tris[wrong] = tris[wrong][:, [0, 2, 1]]

    return ([tuple(p) for p in pts_out], [tuple(p) for p in uv_out],
            [tuple(int(i) for i in t) for t in tris])


def _dist3(a, b):
    dx, dy, dz = a[0] - b[0], a[1] - b[1], a[2] - b[2]
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def _refine_face_triangulation(surf, pts, uv, tris, target_edge_mm, max_tris):
    """Uniform 1-to-4 subdivision: every triangle splits at its edge midpoints in
    the SAME pass, so neighbors always split identically — no T-junctions, by
    construction (a true adaptive/non-uniform quad-tree would need extra
    edge-balancing logic to avoid cracks; this trades a bit of triangle economy
    for guaranteed crack-freedom with much simpler code). Each new vertex lands
    on the TRUE surface via surf.Value(u,v) at the midpoint's UV — never a lerp
    of the coarse triangle, which is what keeps curved faces exact. Edge-key
    dedup means a shared edge is only evaluated once per pass."""
    pts = list(pts)
    uv = list(uv)
    tris = [tuple(t) for t in tris]
    while True:
        if len(tris) * 4 > max_tris:
            break
        max_edge = 0.0
        for a, b, c in tris:
            max_edge = max(
                max_edge, _dist3(pts[a], pts[b]), _dist3(pts[b], pts[c]), _dist3(pts[c], pts[a])
            )
        if max_edge <= target_edge_mm:
            break
        mid = {}

        def midpoint(i, j):
            key = (i, j) if i < j else (j, i)
            hit = mid.get(key)
            if hit is not None:
                return hit
            um = (uv[i][0] + uv[j][0]) * 0.5
            vm = (uv[i][1] + uv[j][1]) * 0.5
            p = surf.Value(um, vm)
            idx = len(pts)
            pts.append((p.X(), p.Y(), p.Z()))
            uv.append((um, vm))
            mid[key] = idx
            return idx

        new_tris = []
        for a, b, c in tris:
            ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
            new_tris.append((a, ab, ca))
            new_tris.append((ab, b, bc))
            new_tris.append((ca, bc, c))
            new_tris.append((ab, bc, ca))
        tris = new_tris
    return pts, uv, tris


def _smoothstep(t):
    return t * t * (3.0 - 2.0 * t)


def _boundary_edges(tris):
    from collections import Counter

    edge_count = Counter()
    for a, b, c in tris:
        for i, j in ((a, b), (b, c), (c, a)):
            key = (i, j) if i < j else (j, i)
            edge_count[key] += 1
    return edge_count


def _boundary_taper(pts_arr, tris, inset_mm):
    """0 at the face boundary, smoothstepping to 1 over `inset_mm` — this is what
    keeps boundary vertices bit-identical to the untextured mesh (zero
    displacement) so a neighboring untextured face needs no special handling and
    no crack can form at the seam.

    Distance is to the nearest boundary-edge ENDPOINT (cKDTree), not the exact
    segment: boundary edges are subdivided to ~the texture sample length, so the
    error is bounded by half a segment — invisible inside a 1mm smoothstep — and
    boundary vertices themselves are endpoints, so their distance (and taper) is
    EXACTLY zero, preserving the crack-free invariant. (The exact all-pairs
    point-to-segment pass this replaces was >90% of textured-tessellation time.)"""
    edge_count = _boundary_edges(tris)
    boundary = [k for k, n in edge_count.items() if n == 1]
    if not boundary:
        return np.ones(len(pts_arr)), edge_count
    from scipy.spatial import cKDTree

    endpoints = pts_arr[np.unique(np.asarray(boundary, dtype=np.int64).ravel())]
    d, _ = cKDTree(endpoints).query(pts_arr)
    if inset_mm <= 1e-9:
        return (d > 1e-9).astype(np.float64), edge_count
    return _smoothstep(np.clip(d / inset_mm, 0.0, 1.0)), edge_count


def _manifold_check(edge_count):
    """Every edge of a single face's local triangulation is either INTERIOR
    (shared by exactly 2 triangles) or on the face's outer boundary (exactly 1) —
    anything else means the subdivision/dedup logic produced a T-junction or
    degenerate triangle. Cheap edge-share count pass; never a hard failure, just
    a diagnostic (per the plan's risk table)."""
    bad = sum(1 for n in edge_count.values() if n not in (1, 2))
    return bad == 0, bad


def _face_frame(surf, uv_arr, flip):
    """Per-vertex surface frame: (normals, tu, tv) — exact normal plus UNIT
    tangents along the u/v parameter directions, all (N,3). The tangents feed
    the analytic displaced-normal gradient (shading), so orthogonality is only
    approximate on skewed freeform parameterizations — fine for lighting.

    Uses BRepLProp_SLProps (NOT GeomLProp_SLProps, which needs a raw
    untransformed Geom_Surface plus manual location correction; BRepLProp takes
    the already-transformed BRepAdaptor_Surface and gives world-space vectors,
    verified against face.normal_at() on rotated + translated faces). Sign-flip
    matches tessellate.py's REVERSED-face winding flip. A PLANE has a constant
    frame — evaluated once and broadcast, skipping the per-vertex Python loop
    entirely for the most common case."""
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane

    n = uv_arr.shape[0]
    normals = np.zeros((n, 3), dtype=np.float64)
    tu = np.zeros((n, 3), dtype=np.float64)
    tv = np.zeros((n, 3), dtype=np.float64)
    sign = -1.0 if flip else 1.0

    def eval_at(u, v):
        props = BRepLProp_SLProps(surf, float(u), float(v), 1, 1e-6)
        if not props.IsNormalDefined():
            return None
        nv = props.Normal()
        du = props.D1U()
        dv = props.D1V()
        lu = du.Magnitude() or 1.0
        lv = dv.Magnitude() or 1.0
        return (
            (nv.X() * sign, nv.Y() * sign, nv.Z() * sign),
            (du.X() / lu, du.Y() / lu, du.Z() / lu),
            (dv.X() / lv, dv.Y() / lv, dv.Z() / lv),
        )

    if surf.GetType() == GeomAbs_Plane:
        got = eval_at(uv_arr[:, 0].mean(), uv_arr[:, 1].mean())
        if got is not None:
            normals[:], tu[:], tv[:] = got
        return normals, tu, tv

    if surf.GetType() == GeomAbs_Cylinder:
        # closed form: S(u,v) = L + R(cos u·X + sin u·Y) + v·Z — radial normal,
        # tangents from the same frame, fully vectorized. One exact evaluation
        # at the centroid calibrates the normal's sign (Ax3 handedness +
        # REVERSED-face flip) instead of reasoning about orientation flags.
        got = eval_at(uv_arr[:, 0].mean(), uv_arr[:, 1].mean())
        if got is not None:
            ax = surf.Cylinder().Position()
            X = np.array([ax.XDirection().X(), ax.XDirection().Y(), ax.XDirection().Z()])
            Y = np.array([ax.YDirection().X(), ax.YDirection().Y(), ax.YDirection().Z()])
            Z = np.array([ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()])
            u = uv_arr[:, 0]
            cu, su = np.cos(u)[:, None], np.sin(u)[:, None]
            radial = cu * X + su * Y
            um = float(u.mean())
            n_ref = np.cos(um) * X + np.sin(um) * Y
            s = 1.0 if float(np.dot(np.asarray(got[0]), n_ref)) >= 0.0 else -1.0
            normals[:] = s * radial
            tu[:] = -su * X + cu * Y  # d/du direction (unit: R factor drops)
            tv[:] = Z
        return normals, tu, tv

    for i in range(n):
        try:
            got = eval_at(uv_arr[i, 0], uv_arr[i, 1])
            if got is not None:
                normals[i], tu[i], tv[i] = got
        except Exception:
            pass  # degenerate point (pole/singularity) — zero frame: no displacement
    return normals, tu, tv


def _face_normals(surf, uv_arr, flip):
    """Back-compat wrapper: normals only (see _face_frame)."""
    return _face_frame(surf, uv_arr, flip)[0]


# Displacement-geometry skeleton cache: while a texture param is scrubbed
# (depth/sharpness/seed/direction...), the face, its refined sampling grid,
# boundary taper and surface frame are all IDENTICAL — only the height field
# changes. Caching the skeleton turns a scrub tick's tessellation cost into a
# few vectorized height evaluations. Keyed on the face's TShape (same identity
# trick tessellate.py's _EDGE_MEMO uses) plus the base-triangulation counts +
# first node (a re-mesh at a different tolerance mutates the triangulation in
# place, which must miss) and every geometry-shaping param. Small LRU: entries
# hold a few MB of numpy arrays each.
_GEOM_CACHE = {}
_GEOM_CACHE_MAX = 8


def _geometry_key(face, tri, flip, scale, angle, inset_mm, cap):
    node1 = tri.Node(1)
    return (
        face.wrapped.TShape(), tri.NbNodes(), tri.NbTriangles(),
        round(node1.X(), 9), round(node1.Y(), 9), round(node1.Z(), 9),
        flip, round(scale, 6), round(angle, 6), round(inset_mm, 6), cap,
    )


def _displacement_geometry(face, tri, loc, ident, spec, scale, target_edge_mm, cap, flip):
    """The height-independent skeleton for one textured face: refined sampling
    mesh, mm chart, boundary taper, surface frame, manifold verdict."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane

    trsf = loc.Transformation()
    node = tri.Node
    uvnode = tri.UVNode
    n_nodes = tri.NbNodes()
    base_pts = []
    base_uv = []
    for i in range(1, n_nodes + 1):
        p = node(i)
        if not ident:
            p = p.Transformed(trsf)
        base_pts.append((p.X(), p.Y(), p.Z()))
        uvp = uvnode(i)
        base_uv.append((uvp.X(), uvp.Y()))

    get_tri = tri.Triangle
    ntri = tri.NbTriangles()
    base_tris = []
    for i in range(1, ntri + 1):
        a, b, c = get_tri(i).Get()
        a, b, c = a - 1, b - 1, c - 1
        if flip:
            b, c = c, b
        base_tris.append((a, b, c))

    surf = BRepAdaptor_Surface(face.wrapped)

    # planar faces get a pattern-ALIGNED regular grid — an axis-aligned grid
    # beats against a diagonal pattern (roped/beaded ridges); alignment gives
    # straight crests at the same triangle budget. Anything unexpected falls
    # back to the general subdivision path.
    pts = None
    if surf.GetType() == GeomAbs_Plane:
        try:
            base_uv_arr = np.asarray(base_uv, dtype=np.float64)
            bu_mm, bv_mm = _face_uv_to_mm(surf, base_uv_arr[:, 0], base_uv_arr[:, 1])
            pts, uv, tris = _aligned_grid_triangulation(
                base_pts, base_uv, base_tris, bu_mm, bv_mm,
                float(spec.get("angle", 0.0)), target_edge_mm, cap,
            )
        except Exception:
            pts = None
    if pts is None:
        pts, uv, tris = _refine_face_triangulation(surf, base_pts, base_uv, base_tris, target_edge_mm, cap)

    pts_arr = np.asarray(pts, dtype=np.float64)
    uv_arr = np.asarray(uv, dtype=np.float64)
    tris_arr = np.asarray(tris, dtype=np.int64)
    # median, not mean: the aligned-grid path stitches a sparse boundary ring
    # with a few long edges that would skew a mean and false-trigger the clamp
    mean_edge = float(np.median(np.linalg.norm(pts_arr[tris_arr[:, 0]] - pts_arr[tris_arr[:, 1]], axis=1)))

    u_mm, v_mm = _face_uv_to_mm(surf, uv_arr[:, 0], uv_arr[:, 1])

    inset_mm = max(float(spec.get("boundaryInset", 1.0)), 0.0)
    taper, edge_count = _boundary_taper(pts_arr, tris, inset_mm)
    manifold_ok, manifold_bad = _manifold_check(edge_count)

    normals, t_u, t_v = _face_frame(surf, uv_arr, flip)

    flat_indices = []
    for a, b, c in tris:
        flat_indices.append(a)
        flat_indices.append(b)
        flat_indices.append(c)

    return {
        "pts": pts_arr, "tris": len(tris), "flat_indices": flat_indices,
        "mean_edge": mean_edge, "u_mm": u_mm, "v_mm": v_mm,
        "taper": taper, "manifold_ok": manifold_ok, "manifold_bad": manifold_bad,
        "normals": normals, "t_u": t_u, "t_v": t_v,
    }


def displace_face(face, tri, loc, ident, spec, density_cap, diag=None, feature_id=None):
    """Return (positions, indices, normals) — a LOCAL (0-based) flat mesh for one
    textured face plus analytic per-vertex displaced normals, ready for the
    caller to offset and append into the global buffers (same convention
    tessellate()'s own per-face loop already uses)."""
    from OCP.TopAbs import TopAbs_Orientation

    flip = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
    kind = spec["kind"]
    scale = max(float(spec.get("scale", 2.0)), 0.05)
    target_edge_mm = max(scale / 4.0, 0.05)  # ~4 samples per pattern wavelength
    cap = density_cap if density_cap else _DEFAULT_DENSITY_CAP
    inset_mm = max(float(spec.get("boundaryInset", 1.0)), 0.0)

    key = _geometry_key(face, tri, flip, scale, float(spec.get("angle", 0.0)), inset_mm, cap)
    geom = _GEOM_CACHE.pop(key, None)
    if geom is None:
        geom = _displacement_geometry(face, tri, loc, ident, spec, scale, target_edge_mm, cap, flip)
    _GEOM_CACHE[key] = geom  # (re)insert = most-recently-used
    while len(_GEOM_CACHE) > _GEOM_CACHE_MAX:
        _GEOM_CACHE.pop(next(iter(_GEOM_CACHE)))

    pts_arr = geom["pts"]
    taper = geom["taper"]
    normals, t_u, t_v = geom["normals"], geom["t_u"], geom["t_v"]
    mean_edge = geom["mean_edge"]

    spec_h = spec
    if kind != "image" and mean_edge > target_edge_mm * 1.25:
        # the density cap stopped refinement short of the target sampling —
        # evaluating the pattern at its true frequency would alias into noise.
        # Clamp the wavelength to what this mesh can carry so an under-sampled
        # face shows a clean, coarser pattern; exports use a far larger cap.
        spec_h = dict(spec, scale=4.0 * mean_edge)
        if diag is not None:
            diag.append({
                "feature_id": feature_id, "kind": "texture",
                "resolved": geom["tris"], "confidence": 0.5, "lossy": True,
                "reason": "texture shown coarser than print detail (display mesh cap); exports keep full detail",
            })

    offset = float(spec.get("offset", 0.0))
    u_mm = geom["u_mm"] + offset if offset else geom["u_mm"]
    v_mm = geom["v_mm"]
    u_range = (float(u_mm.min()), float(u_mm.max()))
    v_range = (float(v_mm.min()), float(v_mm.max()))

    invert = bool(spec.get("invert"))
    direction = spec.get("direction", "out")

    def signed_at(du, dv):
        """The signed height field sampled at a (mm) offset from the vertices —
        one function so the finite-difference gradient below differentiates the
        SAME invert/direction-transformed field the displacement uses."""
        hh = height_field(kind, spec_h, u_mm + du, v_mm + dv, u_range, v_range)
        if invert:
            hh = 1.0 - hh
        if direction == "in":
            return hh - 1.0
        if direction == "both":
            return (hh - 0.5) * 2.0
        return hh

    signed = signed_at(0.0, 0.0)

    depth = float(spec.get("depth", 0.4))
    disp = pts_arr + normals * (depth * signed * taper)[:, None]

    # Analytic displaced normals (the whole reason coarse displacement can still
    # SHADE smoothly): n' ∝ n − depth·taper·∇h, with the tangent-plane gradient
    # from central differences of the signed field — generic across every kind,
    # image included, at the cost of four extra vectorized height evaluations.
    # (∇taper is ignored: it varies over boundaryInset ≫ one wavelength.)
    eps = max(float(spec_h.get("scale", 2.0)) / 16.0, 1e-3)
    dhdu = (signed_at(eps, 0.0) - signed_at(-eps, 0.0)) / (2.0 * eps)
    dhdv = (signed_at(0.0, eps) - signed_at(0.0, -eps)) / (2.0 * eps)
    grad = (t_u * dhdu[:, None] + t_v * dhdv[:, None]) * (depth * taper)[:, None]
    disp_normals = normals - grad
    ln = np.linalg.norm(disp_normals, axis=1)
    ln[ln < 1e-12] = 1.0
    disp_normals /= ln[:, None]

    if not geom["manifold_ok"] and diag is not None:
        diag.append({
            "feature_id": feature_id, "kind": "texture",
            "resolved": geom["tris"], "confidence": 0.0, "lossy": True,
            "reason": f"{geom['manifold_bad']} non-manifold edge(s) in textured region (mesh crack risk)",
        })

    return disp.ravel().tolist(), geom["flat_indices"], disp_normals.ravel().tolist()
