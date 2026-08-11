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
# "facet" = hard-surface (planar facets, real creases — the default, because it
# is what a printer can actually resolve); "round" = the original smooth fields.
_PROFILES = {"facet", "round"}

# Export-tier safety net even when the caller passes density_cap=None — a
# pathologically fine scale/depth combo must not be able to allocate unbounded
# memory. server.py's EXPORT_DENSITY_CAP_PER_FACE is normally what applies.
_DEFAULT_DENSITY_CAP = 2_000_000

# Bump on ANY change to the displacement algorithm/output (subdivision, height
# fields, normals, taper): it participates in the persistent mesh-cache key, so
# a code update invalidates cached textured meshes instead of serving stale
# geometry built by the previous version.
# 5: crease-aligned lattices — vertices land ON the pattern's gradient
#    breakpoints instead of a uniform grid, so faceted kinds are exact.
# 6: seam-aware ring on closed faces — the UV-seam columns are densified with
#    the lattice's own on-seam points (not uniform steps), and the lattice is
#    no longer culled against them, so hex cells straddling the seam keep the
#    corners their creases need (was: ~half the seam cells crushed by up to
#    46% of depth, staggered by row).
# 7: consistent triangle winding — lattice Delaunay orientation is arbitrary
#    (measured: half a tube face wound inward), and a double-sided renderer
#    negates the shading normal on back-wound triangles, lighting half the
#    model inside-out; inconsistent winding also rides into STL/3MF exports.
#    Windings now oriented to agree with the analytic normals.
# 8: waves got its own faceted profile (a sine polyline). Under `facet` it had
#    returned the same _trapezoid as ribs, so the two kinds were byte-identical
#    for every user on the default profile; `sharpness` now picks its facet
#    count instead of a land width. Existing waves documents change shape.
# 9: texture cells are no longer flattened where they meet a boundary. The
#    boundary used to be pinned to zero height while the vertex one step inside
#    got the full pattern, so every cell cut by a face edge — or by the outline
#    of embossed text — had its flat top dragged down on one side and read as a
#    mangled cell rather than part of the pattern. The boundary now keeps full
#    height and a vertical skirt closes the step, so cells stay flat and the mesh
#    stays watertight. `boundaryInset` > 0 still selects the old soft fade.
#    Existing documents on the default inset (0) gain the skirt and change shape.
# 10: the band of mesh stitching a hex pattern to a face BOUNDARY is now
#    triangulated along the creases like the rest of it. Two things blinded it:
#    the honeycomb's creases are not a parallel line family, so nothing planted a
#    ring vertex where one met the boundary, and the crease-repair pass still
#    skipped every triangle touching the ring on the pre-9 assumption that the
#    taper pinned it flat. Both showed as shattered cells in a band around
#    embossed text, whose glyph outlines are internal rings of the textured face.
# 11: no size gate. A face only a cell or two across — the enclosed counter of
#    an "A" or a "D" — was briefly left SMOOTH, because under the pre-9 pinned
#    boundary it came out as stitching. That silently overrode a face the user
#    had clicked (the Texture tool simply looked like it was ignoring the
#    click), and 9's skirt had already fixed the stitching it was written for:
#    the same two counters now reach 42% and 46% of their area at the pattern's
#    flat top, against 44% on the 9,210 mm2 face around them. The gate is gone;
#    this version exists so meshes displaced by the interim build are not served
#    from the disk cache.
CODE_VERSION = 11


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
    profile = f.get("profile", "facet")
    if profile not in _PROFILES:
        raise ValueError(f"unknown texture profile: {profile!r} (expected facet or round)")
    inset = f.get("boundaryInset", 0.0)
    if not isinstance(inset, (int, float)) or inset < 0:
        raise ValueError("texture edge blend must be zero or a positive number")
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
        "profile": profile,
        "direction": direction,
        "seed": int(f.get("seed") or 0),
        "octaves": max(1, min(int(f.get("octaves") or 3), 6)),
        "invert": bool(f.get("invert", False)),
        "boundaryInset": max(float(inset), 0.0),
    }
    if kind == "image":
        spec["imagePath"] = image_path
    # Two-tone inlay: which palette slot the textured faces print in. Kept out
    # of the spec when unset so old docs hash identically (texture_key). Never
    # affects displaced geometry — do NOT bump CODE_VERSION for it.
    color_slot = f.get("colorSlot")
    if isinstance(color_slot, (int, float)) and not isinstance(color_slot, bool) and int(color_slot) >= 0:
        spec["colorSlot"] = int(color_slot)
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
    behavior as every other selector-based feature, but they now SAY SO via a
    lossy diagnostic. Dropping silently means a narrowed selector loses the
    texture entirely: green timeline, no error, and a smooth STL that the user
    only discovers after slicing it."""
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
        else:
            from geom_select import _push_diag

            _push_diag(diag, spec.get("feature_id"), "face", 0, 0.0, True,
                       "the textured face no longer resolves — re-pick the face")
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
    # ROUND profiles only: a power curve bends a piecewise-linear ramp into a
    # cubic, so applying it to a faceted profile is the single biggest
    # facet-destroyer in this file. Faceted kinds shape themselves instead.
    return h ** (1.0 + 4.0 * max(0.0, min(1.0, sharpness)))


def _is_facet(spec):
    """Hard-surface (faceted) profile is the DEFAULT: planar facets and real
    creases print far better than a sub-millimetre sinusoid, which a printer
    just rounds off. `profile: "round"` restores the original smooth fields."""
    return spec.get("profile", "facet") != "round"


def _trapezoid(x, period, land):
    """Triangle wave with a flat LAND of width `land` (0..1 of the half-period)
    at both the crest and the trough — the profile an actual knurling wheel or
    form tool leaves. land=0 is a pure V; land→1 is a square wave."""
    t = (x % period) / period
    tri = 1.0 - np.abs(2.0 * t - 1.0)  # 0..1..0
    k = max(0.0, min(0.98, float(land)))
    if k <= 1e-9:
        return tri
    # rescale the ramp so it saturates `k/2` in from each end, then clamp: the
    # ramps stay straight (still planar facets) and the ends go flat.
    return np.clip((tri - k * 0.5) / max(1.0 - k, 1e-9), 0.0, 1.0)


def _terrace(h, steps):
    """Quantise a continuous field into `steps` flat levels with vertical
    risers between them — how a smooth field (noise, an image heightmap)
    becomes hard-surface: plateaus a nozzle can actually lay down, instead of a
    slope it rounds into mush.

    The top bucket is clamped to steps-1 so h == 1.0 lands ON the top level
    rather than one past it — without that the result exceeds 1.0 and breaks the
    [0,1] contract every caller relies on."""
    n = max(2, int(round(steps)))
    q = np.minimum(np.floor(np.clip(h, 0.0, 1.0) * n), n - 1)
    return q / (n - 1.0)


def _steps_from(sharpness):
    """The Sharp slider doubles as the terrace count for the quantised kinds:
    0 → 2 coarse plateaus, 1 → 12 fine ones."""
    s = max(0.0, min(1.0, float(sharpness)))
    return int(round(2 + s * 10))


def _height_knurl(u, v, scale, angle, sharpness, facet=True):
    # crossed triangle-wave ridges (angle, angle+90) — classic diamond knurl.
    _, v1 = _rotate(u, v, angle)
    _, v2 = _rotate(u, v, angle + 90.0)
    if facet:
        # MIN of the two groove profiles, not their product. A product of two
        # linear ramps is a BILINEAR SADDLE — every cell curves, which is what
        # made this read as soft bumps instead of knurling. min() is what two
        # crossed V-grooves actually cut: planar facets, straight ridges.
        return np.minimum(_trapezoid(v1, scale, sharpness), _trapezoid(v2, scale, sharpness))
    h = _tri_wave(v1, scale) * _tri_wave(v2, scale)
    return _sharpen(h, sharpness)


# The honeycomb is the Voronoi diagram of a TRIANGULAR lattice, so a cell's six
# neighbour directions are its six half-plane constraints, and its six corners
# sit half a step round from them.
_HEX_DIRS = np.array([[math.cos(math.radians(60 * k)), math.sin(math.radians(60 * k))]
                      for k in range(6)])
_HEX_CORNERS = np.array([[math.cos(math.radians(30 + 60 * k)), math.sin(math.radians(30 + 60 * k))]
                         for k in range(6)])


def _hex_wall_width(scale, sharpness):
    """Wall width in mm, from the shared `sharpness` slider — crisper means a
    narrower wall and a broader flat top, matching what the slider does for every
    other kind. Expressed against the cell's inradius so it scales with `scale`.

    The floor is 0.14 of the inradius, not 0.10. Below roughly an eighth of the
    cell the wall stops being meshable exactly: two neighbouring flat tops end up
    closer to each other than to the groove between them, and an unconstrained
    Delaunay takes the short edge and bridges the crease (measured 0.24mm on a
    0.4mm texture at 0.10). It is not a real loss — a wall that narrow is a
    near-vertical cliff no nozzle resolves anyway."""
    s = max(0.0, min(1.0, float(sharpness)))
    return (0.14 + 0.31 * (1.0 - s)) * (scale * 0.5)


def _hex_nearest_site(u, v, a):
    """Nearest site of the triangular lattice site(i,j) = (i·a + j·a/2, j·a·√3/2),
    whose Voronoi cells ARE the honeycomb.

    The lattice's fundamental domain is a rhombus, so the nearest site to any
    point is one of that rhombus's four corners — checking those four is exact,
    not an approximation (the tests assert it by requiring every point to fall
    inside its own cell)."""
    root3 = math.sqrt(3.0)
    jf = v / (a * root3 * 0.5)
    i_f = u / a - jf * 0.5
    i0, j0 = np.floor(i_f), np.floor(jf)
    best_x = best_y = best_d = None
    for di in (0.0, 1.0):
        for dj in (0.0, 1.0):
            sx = (i0 + di) * a + (j0 + dj) * a * 0.5
            sy = (j0 + dj) * a * root3 * 0.5
            d2 = (u - sx) ** 2 + (v - sy) ** 2
            if best_d is None:
                best_x, best_y, best_d = sx, sy, d2
            else:
                m = d2 < best_d
                best_x = np.where(m, sx, best_x)
                best_y = np.where(m, sy, best_y)
                best_d = np.where(m, d2, best_d)
    return best_x, best_y


def _height_hex(u, v, scale, sharpness=0.5, facet=True):
    if not facet:
        # 3-direction cosine interference sum — a closed-form honeycomb pattern
        # (no lattice nearest-neighbor search needed), normalized to [0,1].
        root3 = math.sqrt(3.0)
        a = np.cos(2 * np.pi * u / scale)
        b = np.cos(2 * np.pi * (u * 0.5 - v * root3 * 0.5) / scale)
        c = np.cos(2 * np.pi * (u * 0.5 + v * root3 * 0.5) / scale)
        return np.clip((a + b + c) / 3.0 * 0.5 + 0.5, 0.0, 1.0)

    # FACETED: a real hexagonal mesa — flat top, six planar walls, creases along
    # the cell edges and along the six spokes where two walls meet.
    #
    # This replaces a clipped cosine sum. That version's walls followed a
    # COSINE level set, so they were curved: no arrangement of sample points can
    # reproduce them, and the mesh was measured 41% of the texture's own depth
    # off. Distance to the cell boundary is piecewise linear instead, which is
    # both exactly meshable and what the code always claimed to draw ("flat
    # topped mesas with straight walls").
    sx, sy = _hex_nearest_site(u, v, scale)
    du, dv = u - sx, v - sy
    # distance to each of the six bounding half-planes; the cell's inradius is
    # half the centre-to-centre step
    d_edge = (scale * 0.5
              - (du[..., None] * _HEX_DIRS[:, 0] + dv[..., None] * _HEX_DIRS[:, 1])).min(axis=-1)
    return np.clip(d_edge / max(_hex_wall_width(scale, sharpness), 1e-9), 0.0, 1.0)


# Joins per period in the faceted wave. Fixed, and 8 is not a taste call: the
# lattice plants a sample line per crease, so the facet count sets the grid's
# ASPECT against the free axis (one line per period). At 8 the cells are 1:8 and
# the assembly is exact everywhere; at 12 and 16 the seam strip on a cylinder
# starts handing Delaunay cells so slivered it bridges two crease columns at
# once (measured: 5 and 37 interior triangles off by up to 0.026mm, all within
# 1.2mm of the seam). Finer is also pointless for the printer — 16 facets on a
# 2mm wave is 0.125mm each, under any nozzle. So the slider shapes the profile
# BETWEEN these joins instead of adding more of them.
_WAVE_JOINS = 8


def _wave_levels():
    """The faceted wave's height at each of its `_WAVE_JOINS` joins.

    There is deliberately NO shape parameter. Every way of flattening or peaking
    a one-dimensional profile on this few joins lands back on the trapezoid /
    triangle family — which IS ribs, only phase-shifted — so a "roundness"
    slider would spend its travel walking waves back into the kind it exists to
    differ from. Tried and rejected: a gain about mid-height clipped the crest
    flat by slider position 0.21 and then did nothing for the remaining 80%. The
    sine is the distinction, and it has no free parameter; the panel hides the
    control for this kind rather than showing a dead one."""
    i = np.arange(_WAVE_JOINS)
    return 0.5 + 0.5 * np.sin(2 * np.pi * i / _WAVE_JOINS)


def _wave_phases():
    """Gradient breakpoints of the faceted wave, as fractions of one period.

    NOT every join: the sine is antisymmetric about its two INFLECTIONS, and the
    joins are symmetric about them too, so the chords either side share a slope
    and the polyline runs dead straight through. Those two turn no corner, and a
    line there would buy nothing but triangles — a quarter of them. Read off the
    levels rather than hardcoded, by comparing the slope arriving with the one
    leaving."""
    lv = _wave_levels()
    d = np.roll(lv, -1) - lv  # slope of the segment starting at join i
    return tuple(i / _WAVE_JOINS for i in range(_WAVE_JOINS)
                 if abs(float(d[i - 1] - d[i])) > 1e-12)


def _facet_wave(x, period):
    """The faceted wave: linear interpolation between `_wave_levels`.

    Faceted kinds must be piecewise linear to be MESHABLE EXACTLY — a curved
    level set cannot be reproduced by any arrangement of sample points, which is
    what left the old cosine-walled hex measured 41% of its own depth off. So
    the rounded look is built from real planar facets and real creases rather
    than approximated by sampling a curve."""
    lv = _wave_levels()
    n = len(lv)
    t = (x % period) / period * n
    i = np.floor(t)
    f = t - i
    i = i.astype(np.int64) % n
    lo = lv[i]
    return lo + (lv[(i + 1) % n] - lo) * f


def _height_waves(u, v, scale, angle, sharpness, facet=True):
    u1, _ = _rotate(u, v, angle)
    if facet:
        # a faceted SINE, not a trapezoid: rounded undulation against ribs' flat
        # -topped prisms. Both kinds used to return _trapezoid here, which made
        # them byte-identical under the default profile (measured max|w-r| = 0).
        # `sharpness` is deliberately unused — see _wave_levels.
        return _facet_wave(u1, scale)
    h = 0.5 + 0.5 * np.sin(2 * np.pi * u1 / scale)
    return _sharpen(h, sharpness)


def _height_ribs(u, v, scale, angle, sharpness, facet=True):
    u1, _ = _rotate(u, v, angle)
    if facet:
        return _trapezoid(u1, scale, sharpness)
    return _sharpen(_tri_wave(u1, scale), sharpness)


def _hash01(i, j, seed, salt):
    """Deterministic [0,1) value from a CELL INDEX, not from an array position.

    The sites used to be jittered with a single `default_rng(seed)` stream walked
    across a grid sized from the QUERY's own bounding box, which quietly made the
    pattern depend on which points you asked about: displace_face evaluates the
    field four extra times at +/-eps to get its shading gradient, and each of
    those has a slightly different extent, so it was differentiating a DIFFERENT
    pattern from the one it displaced. Hashing the cell index pins each site to
    its place on the plane instead."""
    h = ((i.astype(np.int64) * 73856093)
         ^ (j.astype(np.int64) * 19349663)
         ^ (np.int64(seed) * 83492791)
         ^ (np.int64(salt) * 2971215073))
    h = (h ^ (h >> 13)) * np.int64(1274126177)
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF) / float(0x1000000)


def _voronoi_sites(scale, seed, lo_u, hi_u, lo_v, hi_v):
    """One jittered site per `scale`-sized cell covering the box, anchored to the
    plane so the same region always yields the same sites."""
    i0, i1 = int(math.floor(lo_u / scale)) - 1, int(math.ceil(hi_u / scale)) + 1
    j0, j1 = int(math.floor(lo_v / scale)) - 1, int(math.ceil(hi_v / scale)) + 1
    ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1), indexing="ij")
    ii, jj = ii.ravel(), jj.ravel()
    ju = 0.2 + 0.6 * _hash01(ii, jj, seed, 1)
    jv = 0.2 + 0.6 * _hash01(ii, jj, seed, 2)
    return np.stack([(ii + ju) * scale, (jj + jv) * scale], axis=1)


def _height_voronoi(u, v, scale, seed, sharpness=0.5, facet=True):
    """Clipped distance to the nearest SITE: a flat plate with a conical dimple
    punched into each cell.

    NOT exactly meshable, and knowingly so. The cone is curved, so no arrangement
    of vertices reproduces it — measured 95% of the texture's own depth off, the
    worst of any kind. The fix is the same one hex got (distance to the cell
    BOUNDARY, which is a min of half-planes and therefore piecewise linear), but
    a Voronoi cell is irregular, and insetting an irregular convex polygon is not
    just "move every edge inward": edges vanish at different widths, and the
    straight skeleton grows nodes a naive inset puts in the wrong place. That
    needs a real straight-skeleton pass, so it is left for its own change rather
    than shipped half-done — a redefinition that changed every existing voronoi
    model without delivering exactness would be the worst of both."""
    from scipy.spatial import cKDTree

    sites = _voronoi_sites(scale, int(seed),
                           float(np.min(u)) - 3 * scale, float(np.max(u)) + 3 * scale,
                           float(np.min(v)) - 3 * scale, float(np.max(v)) + 3 * scale)
    P = np.stack([np.asarray(u).ravel(), np.asarray(v).ravel()], axis=1)
    d, _i = cKDTree(sites).query(P, workers=-1)
    h = np.clip(d / (scale * 0.5), 0.0, 1.0).reshape(np.shape(u))
    if not facet:
        return h
    k = 0.15 + 0.45 * (1.0 - max(0.0, min(1.0, sharpness)))
    return np.clip(h / max(k, 1e-9), 0.0, 1.0)


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
    plain vectorized numpy computation over the u_mm/v_mm coordinate arrays.

    `spec["profile"]` selects hard-surface (`"facet"`, the default — planar
    facets and real creases, which is what survives a 3D print) or the original
    smooth fields (`"round"`). `sharpness` is reused per profile rather than
    adding a control: under facet it is the flat-LAND fraction for the periodic
    kinds, the FACET COUNT for waves, the wall width for the cellular ones, and
    the terrace count for the continuous ones."""
    scale = max(float(spec.get("scale", 2.0)), 0.05)
    angle = float(spec.get("angle", 0.0))
    sharpness = float(spec.get("sharpness", 0.5))
    facet = _is_facet(spec)
    if kind == "knurl":
        return _height_knurl(u_mm, v_mm, scale, angle, sharpness, facet)
    if kind == "hex":
        return _height_hex(u_mm, v_mm, scale, sharpness, facet)
    if kind == "waves":
        return _height_waves(u_mm, v_mm, scale, angle, sharpness, facet)
    if kind == "ribs":
        return _height_ribs(u_mm, v_mm, scale, angle, sharpness, facet)
    if kind == "voronoi":
        return _height_voronoi(u_mm, v_mm, scale, spec.get("seed", 0), sharpness, facet)
    if kind == "noise":
        h = _height_noise(u_mm, v_mm, scale, spec.get("seed", 0), spec.get("octaves", 3))
        return _terrace(h, _steps_from(sharpness)) if facet else h
    if kind == "image":
        h = _height_image(u_mm, v_mm, spec["imagePath"], u_range, v_range)
        return _terrace(h, _steps_from(sharpness)) if facet else h
    raise ValueError(f"unknown texture kind: {kind}")


# --- UV -> mm (first fundamental form) ---------------------------------------


def _u_period(spec, scale):
    """The pattern's translation period ALONG U — what a full turn has to be a
    whole number of, for the pattern to meet itself at the seam.

    Rotating changes it. A rib pattern at angle θ repeats every `scale` across
    its crests, but travelling along u you cross a crest every `scale/cos θ`, so
    snapping the turn to whole `scale` units closes it only at θ = 0. Returns 0
    for "no constraint": at θ = 90° the crests run along u and the pattern is
    already invariant, so any turn closes.

    knurl and hex are 2D lattices and get `scale` regardless, which is exact only
    at multiples of 90°. Closing a rotated 2D lattice on a cylinder needs the
    turn to be a lattice vector in BOTH directions at once — possible only when
    tan θ is rational — so at a general angle they cannot close, and the seam
    carries a phase joint. That is geometry, not a defect to fix here."""
    if spec["kind"] not in ("ribs", "waves"):
        return scale
    c = abs(math.cos(math.radians(float(spec.get("angle", 0.0)))))
    return scale / c if c > 1e-6 else 0.0


def _revolved_reference_radius(surf):
    """The radius the pattern is sized at, taken from the FACE's own parameter
    bounds so it cannot drift between calls (the two callers pass different point
    sets, and a reference derived from those would give two different charts)."""
    from OCP.GeomAbs import GeomAbs_Cone

    if surf.GetType() == GeomAbs_Cone:
        cone = surf.Cone()
        v_mid = 0.5 * (surf.FirstVParameter() + surf.LastVParameter())
        return max(abs(cone.RefRadius() + v_mid * math.sin(cone.SemiAngle())), 1e-9)
    return max(surf.Cylinder().Radius(), 1e-9)


def _turn_mm(surf, period):
    """Arc length assigned to ONE FULL TURN of a cylinder or cone.

    Two fixes in one number, because they are the same change.

    ANCHORED to a fixed reference radius, not the local `r(v)`. The old chart
    used `u_mm = u * r(v)`, so a crest at constant u_mm sat at angle u_mm/r(v) —
    and r varies with height on a cone, so the crest SPIRALLED. The shear grew
    with distance from u=0: measured on a 30->20mm frustum, +1.9 degrees at the
    first crest and +57.3 by the thirtieth. Zero at the seam, worst at the far
    side, which is exactly the "starts nice, distorts as you go round" report.
    Anchoring makes a crest a true generator: dead vertical, everywhere.

    ROUNDED to a whole number of periods, so the pattern meets itself at the UV
    seam instead of colliding with a different phase. That also makes the seam
    weldable (see _weld_coincident): the columns at u=0 and u=2pi then carry
    IDENTICAL field values, so merging them cannot move the surface.

    The cost, which is geometry and not a bug: on a taper the cell width scales
    with radius. You cannot hold both constant width in mm and constant
    orientation on a cone — its circumference changes. Cells are `period` wide at
    the reference radius and vary from there. On a cylinder there is no cost at
    all: constant size, generator-aligned and seamless together."""
    circ = 2.0 * math.pi * _revolved_reference_radius(surf)
    if not period or period <= 0.0:
        return circ
    return max(1, int(round(circ / period))) * period


def _face_uv_to_mm(surf, u, v, period=None):
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
    if t in (GeomAbs_Cylinder, GeomAbs_Cone):
        # U is an angle; one full turn is _turn_mm of arc. V is already axial mm
        # on a cylinder and slant-arc-length mm on a cone.
        return u * (_turn_mm(surf, period) / (2.0 * math.pi)), v.copy()

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


def _hex_rings(spec, a, lo_u, hi_u, lo_v, hi_v):
    """The honeycomb's two corner rings over a padded bbox, as (outer, inner),
    each (S, 6, 2) in mm-chart coordinates.

    `outer` is the cell boundary (h = 0, the groove) and `inner` the flat top
    (h = 1); the wall between a matching pair is one planar facet, and the spoke
    joining them is the crease where two walls meet. Sites are the triangular
    lattice site(i,j) = (i·a + j·a/2, j·a·√3/2), whose Voronoi cells ARE the
    honeycomb."""
    root3 = math.sqrt(3.0)
    w = _hex_wall_width(a, spec.get("sharpness", 0.5))
    r_out = a / root3                      # circumradius of the cell
    r_in = max(a * 0.5 - w, 1e-6) * 2.0 / root3   # circumradius of the flat top
    # sites covering the bbox with a ring of margin, in lattice coordinates
    pad = a
    j0 = int(math.floor((lo_v - pad) / (a * root3 * 0.5)))
    j1 = int(math.ceil((hi_v + pad) / (a * root3 * 0.5)))
    rows = []
    for j in range(j0, j1 + 1):
        sy = j * a * root3 * 0.5
        i0 = int(math.floor((lo_u - pad) / a - j * 0.5))
        i1 = int(math.ceil((hi_u + pad) / a - j * 0.5))
        if i1 < i0:
            continue
        i = np.arange(i0, i1 + 1, dtype=np.float64)
        rows.append(np.column_stack([i * a + j * a * 0.5, np.full(len(i), sy)]))
    if not rows:
        return None
    sites = np.concatenate(rows)
    return (sites[:, None, :] + r_out * _HEX_CORNERS[None, :, :],
            sites[:, None, :] + r_in * _HEX_CORNERS[None, :, :])


def _cell_crease_segments(kind, spec, scale, lo_u, hi_u, lo_v, hi_v):
    """Every crease of a CELLULAR kind as an explicit segment set (S0, S1), each
    (E, 2) in mm-chart coordinates.

    `_cell_lattice_points` plants the vertices these segments run between, which
    is enough in the face's interior. It is NOT enough at a boundary: the ring is
    densified on its own uniform step, so a crease reaching the rim (or the
    outline of embossed text) generally meets it BETWEEN two ring vertices, and
    the band stitching the ring to the lattice then has no vertex to run the
    crease along. `_segment_crossings` solves exactly this for the kinds whose
    creases are parallel line families; a honeycomb's are not, so intersect the
    segments directly instead."""
    if kind != "hex":
        return None
    rings = _hex_rings(spec, scale, lo_u, hi_u, lo_v, hi_v)
    if rings is None:
        return None
    outer, inner = rings
    # cell edges (the groove), flat-top edges (the top of the wall), and the six
    # spokes joining them — the complete breakline set of `_height_hex`
    S0 = np.concatenate([outer.reshape(-1, 2), inner.reshape(-1, 2), outer.reshape(-1, 2)])
    S1 = np.concatenate([np.roll(outer, -1, axis=1).reshape(-1, 2),
                         np.roll(inner, -1, axis=1).reshape(-1, 2),
                         inner.reshape(-1, 2)])
    return S0, S1


def _cell_segment_crossings(p0, p1, creases, tree, radius):
    """Parameters t in (0,1) at which a boundary segment p0-p1 crosses a cellular
    crease. `tree`/`radius` prefilter the crease set by midpoint proximity, which
    is what keeps this near-linear in the number of boundary segments."""
    S0, S1 = creases
    near = tree.query_ball_point((p0 + p1) * 0.5,
                                 radius + float(np.hypot(*(p1 - p0))) * 0.5)
    if not near:
        return []
    S0, S1 = S0[near], S1[near]
    r, s = p1 - p0, S1 - S0
    den = r[0] * s[:, 1] - r[1] * s[:, 0]
    ok = np.abs(den) > 1e-12                 # parallel: no single crossing point
    if not ok.any():
        return []
    q, d, s = S0[ok] - p0, den[ok], s[ok]
    t = (q[:, 0] * s[:, 1] - q[:, 1] * s[:, 0]) / d
    on_crease = (q[:, 0] * r[1] - q[:, 1] * r[0]) / d
    hit = ((t > 1e-9) & (t < 1.0 - 1e-9)
           & (on_crease >= -1e-9) & (on_crease <= 1.0 + 1e-9))
    return list(t[hit])


def _cell_lattice_points(kind, spec, scale, lo_u, hi_u, lo_v, hi_v, wrap_u=None):
    """Explicit vertex set for the CELLULAR kinds, whose creases do not lie on
    families of parallel lines and so cannot be expressed as a line grid.

    Returned in mm-chart coordinates (the offset shift already applied by the
    caller's bbox), because hex and voronoi ignore `angle` — their lattice has
    its own orientation and `height_field` never rotates their input."""
    if kind != "hex":
        return None
    a = scale
    root3 = math.sqrt(3.0)
    w = _hex_wall_width(a, spec.get("sharpness", 0.5))
    r_out = a / root3                      # circumradius of the cell
    rings = _hex_rings(spec, a, lo_u, hi_u, lo_v, hi_v)
    if rings is None:
        return None
    outer, inner = rings
    outer_next = np.roll(outer, -1, axis=1)
    # POINTS ALONG EVERY CELL EDGE. The groove along a shared edge is the
    # sharpest crease in the pattern (h drops to 0 and rises again), and with
    # only its two endpoints present Delaunay joins one cell's flat top straight
    # to its neighbour's, bridging the groove and interpolating h=1 where the
    # truth is 0 — measured 0.36mm on a 0.4mm texture.
    #
    # A midpoint alone is not enough. The bridge forms near the CORNERS, where
    # three cells meet and two neighbouring flat-top corners sit only ~2w apart
    # while the groove between them is a thin wedge; Delaunay takes the short
    # edge. So also plant a groove vertex a wall-width in from each end, which
    # puts a competing point at the same scale as the bridge it has to beat.
    edge_len = r_out                       # a regular hexagon's edge == its circumradius
    frac = min(0.4, max(0.5 * w / max(edge_len, 1e-9), 0.015))
    step = outer_next - outer
    along = [outer + step * f for f in (frac, 0.5, 1.0 - frac)]
    pts = np.concatenate([outer.reshape(-1, 2), inner.reshape(-1, 2)]
                         + [p.reshape(-1, 2) for p in along])
    if wrap_u:
        # PERIODIC IN U — a closed cylinder or cone. The two sides of the UV seam
        # must carry an IDENTICAL vertex set, or they cannot weld and the seam
        # stays a mesh boundary that the taper pins flat. Clipping a padded box
        # does not give that: a cell corner just outside u=0 is culled while its
        # twin just inside u=turn survives (measured 56 vertices on one side of a
        # cone's seam against 64 on the other). Folding into [0, turn) and then
        # re-emitting both copies makes the set symmetric by construction.
        folded = pts.copy()
        folded[:, 0] = np.mod(folded[:, 0], wrap_u)
        folded = np.unique(np.round(folded, 9), axis=0)
        # BOTH neighbouring copies, then clip: emitting only [0, turn) and
        # [turn, 2*turn) leaves the padding below u=0 empty while the padding
        # above turn is populated, which is the same asymmetry by another route.
        pts = np.concatenate([folded - np.array([wrap_u, 0.0]), folded,
                              folded + np.array([wrap_u, 0.0])])
        pts = pts[(pts[:, 0] >= lo_u) & (pts[:, 0] <= hi_u)]
    return np.unique(np.round(pts, 9), axis=0)


def _crease_phases(land):
    """Gradient breakpoints of _trapezoid inside one period, as fractions of it.

    `tri = 1-|2t-1|` is clipped at BOTH ends. The lower clip flattens the trough,
    so the ramp only starts at t = k/4 and ends at t = 1-k/4; the upper clip
    flattens the crest into a real LAND spanning t = 0.5 -/+ k/4. That is FOUR
    corners per period, not two. Sampling that misses the upper pair rounds the
    crest off, which is most of why a "faceted" texture still read as soft — a
    uniform 4-samples-per-wavelength grid can only ever hit two of the four.

    Degenerates to the pure V (trough, crest) when there is no land."""
    k = max(0.0, min(0.98, float(land)))
    if k <= 1e-9:
        return (0.0, 0.5)
    return (k / 4.0, 0.5 - k / 4.0, 0.5 + k / 4.0, 1.0 - k / 4.0)


def _pattern_axes(kind, spec):
    """Sample-line phases per pattern axis: (pu_phases, pv_phases), or None when
    the kind has no lattice and must keep the uniformly sampled grid.

    An axis mapped to None carries no crease — the field does not vary along it,
    so any spacing there is exact and the caller picks one for mesh quality
    alone.

    Pattern-frame convention, verified against the height fields themselves:
    ribs/waves vary along pu (`u1` in _rotate terms), and knurl is a min() of two
    trapezoids along pv and pu, because `_rotate(u, v, angle+90)` maps its second
    groove direction (`v2`) back onto pu.

    Excluded on purpose: `round` profiles are smooth by design; hex and voronoi
    are curved fields today (a clipped cosine sum and a conical distance field),
    so no set of lines can make them exact; noise and image are not periodic."""
    if not _is_facet(spec):
        return None
    land = float(spec.get("sharpness", 0.5))
    if kind == "ribs":
        return (_crease_phases(land), None)
    if kind == "waves":
        # a faceted sine turns a corner at every join, not at four breakpoints —
        # so it needs its own, denser phase set. Sharing ribs' would chord across
        # the curve and lose the roundness it exists for. Land-independent.
        return (_wave_phases(), None)
    if kind == "knurl":
        # both grooves, so both axes carry the same breakpoints. The min() of the
        # two ALSO creases along a line inside each ramp-by-ramp cell; that one
        # is not a lattice line and is handled by choosing the cell's diagonal.
        return (_crease_phases(land), _crease_phases(land))
    if kind == "hex":
        # CELLULAR: creases run round hexagons and out along spokes, not along
        # parallel lines, so there are no axis phases — the vertex set comes
        # from _cell_lattice_points instead.
        return "cells"
    return None


def _axis_lines(phases, period, lo, hi):
    """Sample lines covering [lo, hi] along one pattern axis.

    With phases, one line per crease per period, so every facet corner is a mesh
    vertex and the linear interpolation between them IS the true surface. Without
    them (a crease-free axis), one line per period: the spacing is free
    geometrically, but not for the rim, where the taper ramps to zero and a
    triangle spanning the whole face would interpolate that ramp across it."""
    if phases is None:
        phases = (0.0,)
    n0 = int(math.floor(lo / period)) - 1
    n1 = int(math.ceil(hi / period)) + 1
    vals = np.array([(n + t) * period for n in range(n0, n1 + 1) for t in phases])
    vals = np.unique(np.round(vals, 9))
    return vals[(vals >= lo) & (vals <= hi)]


def _segment_crossings(a, b, phases, period):
    """Parameters t in (0,1) at which the pattern's crease lines cross a segment
    whose pattern coordinate runs affinely from `a` to `b`.

    Used to plant a ring vertex on every crease that reaches the face boundary,
    so the rim band is triangulated with the creases as edges instead of across
    them."""
    if phases is None or period <= 0.0:
        return []
    span = b - a
    if abs(span) < 1e-12:
        return []
    lo, hi = (a, b) if a < b else (b, a)
    out = []
    for n in range(int(math.floor(lo / period)) - 1, int(math.ceil(hi / period)) + 2):
        for ph in phases:
            c = (n + ph) * period
            if lo < c < hi:
                out.append((c - a) / span)
    return out


# Points strictly inside a triangle, in barycentric coordinates — the probe set
# used to decide whether a triangle reproduces the height field. Corner-ish and
# edge-ish samples as well as the centroid, because the failure being looked for
# is a facet cut off between the vertices, which the centroid can straddle.
_FLIP_BARY = np.array([
    [1 / 3, 1 / 3, 1 / 3],
    [0.60, 0.20, 0.20], [0.20, 0.60, 0.20], [0.20, 0.20, 0.60],
    [0.45, 0.45, 0.10], [0.10, 0.45, 0.45], [0.45, 0.10, 0.45],
])


def _force_cell_diagonals(tris, V_mm, quads, want_main):
    """Impose the KNOWN diagonal on each complete lattice cell.

    A square cell with no point inside it is triangulated by Delaunay with one of
    its two diagonals, chosen arbitrarily because the four corners are
    co-circular. Which one is right is not arbitrary: knurl is min() of two
    crossed trapezoids, and where both are on their ramps the min switches along
    exactly one of them. So flip the wrong ones deterministically instead of
    hoping an error-descent pass finds them — from a Delaunay start descent
    stalls in a local minimum (measured: 620 inexact triangles down to 40, and
    the rest unreachable by any single flip)."""
    tris = np.asarray(tris, dtype=np.int64).copy()
    where = {}
    for ti, (a, b, c) in enumerate(tris):
        for i, j in ((a, b), (b, c), (c, a)):
            where.setdefault((i, j) if i < j else (j, i), []).append(ti)
    for (a, b, c, d), main in zip(quads, want_main):
        have, want = ((b, d), (a, c)) if main else ((a, c), (b, d))
        if len(where.get((min(want), max(want)), ())) == 2:
            continue  # the diagonal we want is already there
        share = where.get((min(have), max(have)), ())
        if len(share) != 2:
            continue  # cell is not a clean two-triangle quad; leave it alone
        t0, t1 = share
        if sorted(set(tris[t0]) | set(tris[t1])) != sorted((a, b, c, d)):
            continue  # something else meets here
        tris[t0] = (want[0], want[1], have[0])
        tris[t1] = (want[0], want[1], have[1])
    return tris


def _segments_cross(P, p, q, r, s):
    """True when segment p-q properly crosses segment r-s, i.e. the quad p-r-q-s
    is convex and swapping its diagonal is a legal flip."""
    def side(a, b, c):
        return ((P[b][0] - P[a][0]) * (P[c][1] - P[a][1])
                - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]))
    return (side(p, q, r) * side(p, q, s) < 0) and (side(r, s, p) * side(r, s, q) < 0)


def _flip_to_creases(tris, V_mm, field, n_ring=0, tol=1e-9, max_passes=8,
                     ring_fixable=None):
    """Repair triangles that cut ACROSS a crease instead of running along it.

    Complete lattice cells get their diagonal imposed directly, but the band
    stitching the lattice to the boundary ring is an unconstrained Delaunay: it
    maximises the minimum angle and knows nothing about the field, so where a
    crease crosses the band it can bridge straight over. scipy has no constrained
    Delaunay, so repair instead of prevent — score each triangle against the true
    field and flip a shared edge wherever that strictly reduces the error.

    Triangles touching a RING vertex are excluded from scoring. Their outer
    corners are pinned at zero displacement by the boundary taper, so they can
    never match the raw field however they are triangulated; scoring them makes
    the pass chase an unreachable target and, worse, spend its one-flip-per-pair
    budget on pairs that cannot improve, blocking neighbours that could.

    `ring_fixable` (bool mask over the first n_ring vertices) marks ring
    vertices that DO displace with the field — the UV-seam columns, which the
    taper exempts. Triangles touching only those are scored and repaired like
    interior ones: the seam strip is where a spoke crease crosses the band with
    both flanks on the ring, and skipping it leaves the crease bridged (a
    0.195-of-depth notch on every hex row along the seam)."""
    tris = np.asarray(tris, dtype=np.int64).copy()
    hv = field(V_mm)
    fixable_full = None
    if ring_fixable is not None and n_ring:
        fixable_full = np.zeros(len(V_mm), dtype=bool)
        fixable_full[:n_ring] = ring_fixable

    def err_of(t):
        """Worst deviation at points strictly INSIDE each triangle. The centroid
        alone is not enough to score a flip by: a triangle bridging a crease can
        match exactly at its centre and be wrong either side of it, so a
        centroid-scored pass both misses real breaks and flips already-correct
        triangles into worse ones (measured: it broke ribs at 17 degrees, which
        the lattice had got right)."""
        pts = np.einsum("sb,tbc->tsc", _FLIP_BARY, V_mm[t]).reshape(-1, 2)
        interp = hv[t] @ _FLIP_BARY.T
        return np.abs(interp - field(pts).reshape(len(t), -1)).max(axis=1)

    for _ in range(max_passes):
        scored = err_of(tris)
        excluded = tris < n_ring  # pinned by the taper, not fixable
        if fixable_full is not None:
            excluded &= ~fixable_full[tris]
        scored[excluded.any(axis=1)] = 0.0
        bad = np.nonzero(scored > tol)[0]
        if not len(bad):
            break
        edges = {}
        for ti, (a, b, c) in enumerate(tris):
            for i, j in ((a, b), (b, c), (c, a)):
                edges.setdefault((i, j) if i < j else (j, i), []).append(ti)
        settled = set()
        flipped = False
        for ti in bad:
            if ti in settled:
                continue
            a, b, c = tris[ti]
            for i, j, opp in ((a, b, c), (b, c, a), (c, a, b)):
                share = edges.get((i, j) if i < j else (j, i), ())
                if len(share) != 2:
                    continue  # a boundary edge has nothing to flip against
                tj = share[0] if share[1] == ti else share[1]
                if tj in settled:
                    continue
                rest = [v for v in tris[tj] if v not in (i, j)]
                if len(rest) != 1 or not _segments_cross(V_mm, i, j, opp, rest[0]):
                    continue
                cand = np.array([[opp, rest[0], i], [rest[0], opp, j]], dtype=np.int64)
                if err_of(cand).sum() < err_of(tris[[ti, tj]]).sum() - 1e-15:
                    tris[ti], tris[tj] = cand[0], cand[1]
                    settled.add(ti)
                    settled.add(tj)
                    flipped = True
                    break
        if not flipped:
            break
    return tris


def _aligned_grid_triangulation(base_pts, base_uv, base_tris, u_mm, v_mm,
                                angle_deg, target_edge_mm, max_tris,
                                pattern_period=0.0, phases=None, offset=0.0, field=None,
                                unchart=None, cell_points=None, wrap_u=None,
                                cell_creases=None, pin_ring=True):
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

    # Lock the spacing to a whole number of samples per pattern PERIOD. Without
    # this the grid and the pattern beat against each other: a ridge lands at a
    # drifting phase between two samples and gets sliced off flat at whatever
    # height the samples happen to bracket, so crests come out uneven and
    # rounded. Snapping puts every crest and trough exactly ON a grid line.
    # Only when we can already afford >=2 samples per period — below that,
    # snapping would multiply the triangle count, and displace_face's wavelength
    # clamp already handles under-sampling by showing a coarser pattern.
    period = float(pattern_period or 0.0)
    if period > 0.0 and spacing <= period * 0.5:
        spacing = period / max(2, round(period / spacing))

    # Pattern chart convention MUST match _rotate() in the height fields:
    # u1 = u·cosθ − v·sinθ (crest lines of waves/ribs run along constant u1), so
    # pattern coords are ((u+offset)·c − v·s, (u+offset)·s + v·c).
    #
    # `offset` rides in the chart rather than being added afterwards, because it
    # is what phase-locks the lines to the pattern: displace_face evaluates the
    # field at u_mm + offset, so lines placed without it sit at a drifting phase
    # and slice the crests off exactly like an unaligned grid does.
    ang = math.radians(angle_deg)
    ca, sa = math.cos(ang), math.sin(ang)
    rp_u = (P_mm[:, 0] + offset) * ca - P_mm[:, 1] * sa
    rp_v = (P_mm[:, 0] + offset) * sa + P_mm[:, 1] * ca

    # DENSIFY THE BOUNDARY RING to the sample spacing. It used to be kept
    # verbatim from the base triangulation, which on a real part means a handful
    # of nodes: measured on a filleted body, 20 ring vertices with the longest
    # edge 18mm against a 2mm pattern period. Along an edge like that the mesh
    # has NO vertices to carry the pattern, so the strip between the rim and the
    # first interior grid row comes out flat and smeared no matter how fine the
    # interior is — the visible "band" around a textured face.
    #
    # With a lattice the ring additionally gets a vertex wherever a crease line
    # CROSSES the boundary. Without those the rim band is the one place the mesh
    # still cuts corners off the pattern, because the band is stitched by a
    # Delaunay pass that has no reason to respect a crease it has no vertex on.
    #
    # The crack-free invariant is preserved either way: every new point is a
    # linear interpolation along the EXISTING boundary polyline, so it lies
    # exactly on the segment the neighbouring face spans (and this chart is
    # affine — the fit_err check below enforces it — so lerping uv/xyz is exact,
    # not an approximation). They are still boundary vertices, so the taper
    # leaves them undisplaced and the seam stays flush.
    base_uv0 = np.asarray(base_uv, dtype=np.float64)
    base_xyz0 = np.asarray(base_pts, dtype=np.float64)
    bnd_ids = np.unique(np.asarray(boundary, dtype=np.int64).ravel())
    # originals first and verbatim (bit-identical, which the invariant needs)
    r_mm = [P_mm[bnd_ids]]
    r_uv = [base_uv0[bnd_ids]]
    r_xyz = [base_xyz0[bnd_ids]]
    cells_mode = cell_points is not None and len(cell_points) >= 4
    lattice = (phases is not None or cells_mode) and period > 0.0
    # On a closed face the seam columns are boundary only as an artifact of the
    # chart cut. Densifying them UNIFORMLY plants ring points at non-crease
    # heights, and the near-ring cull below then eats the lattice's own on-seam
    # corners — and a lost corner is a crushed cell no edge flip can rebuild
    # (the staggered half-broken seam cells the viewport showed on a hex
    # cylinder: whether a cell survived depended on the accidental alignment of
    # uniform ring steps with lattice heights). Densify seam segments with the
    # lattice's own on-seam points instead: those ARE the crease geometry, and
    # periodicity hands both columns an identical v-set so the two sides stay
    # coincident under displacement.
    seam_vs = None
    if cells_mode and wrap_u:
        cp = np.asarray(cell_points, dtype=np.float64)
        on_cut = (np.abs(cp[:, 0]) < 1e-9) | (np.abs(cp[:, 0] - wrap_u) < 1e-9)
        if on_cut.any():
            seam_vs = np.unique(cp[on_cut][:, 1])
    # Crease crossings for the CELLULAR kinds, whose creases are not a parallel
    # line family — prefilter tree over the segment midpoints, since every
    # boundary segment would otherwise be tested against the whole honeycomb.
    crease_tree = crease_radius = None
    if lattice and phases is None and cell_creases is not None:
        crease_tree = cKDTree((cell_creases[0] + cell_creases[1]) * 0.5)
        crease_radius = float(
            np.linalg.norm(cell_creases[1] - cell_creases[0], axis=1).max()) * 0.5
    for i0, i1 in boundary:
        u0p, u1p = P_mm[i0, 0], P_mm[i1, 0]
        seam_seg = (seam_vs is not None
                    and ((abs(u0p) < 1e-6 and abs(u1p) < 1e-6)
                         or (abs(u0p - wrap_u) < 1e-6 and abs(u1p - wrap_u) < 1e-6)))
        if seam_seg:
            va, vb = P_mm[i0, 1], P_mm[i1, 1]
            lo_s, hi_s = (va, vb) if va <= vb else (vb, va)
            vs = seam_vs[(seam_vs > lo_s + 1e-9) & (seam_vs < hi_s - 1e-9)]
            ts = list((vs - va) / (vb - va))
        else:
            seg_len = float(np.hypot(*(P_mm[i1] - P_mm[i0])))
            n_sub = int(math.ceil(seg_len / spacing))
            ts = list(np.arange(1, n_sub, dtype=np.float64) / n_sub) if n_sub >= 2 else []
            if lattice and phases is not None:
                ts += _segment_crossings(rp_u[i0], rp_u[i1], phases[0], period)
                ts += _segment_crossings(rp_v[i0], rp_v[i1], phases[1], period)
            elif crease_tree is not None:
                ts += _cell_segment_crossings(P_mm[i0], P_mm[i1], cell_creases,
                                              crease_tree, crease_radius)
        if not ts:
            continue  # already shorter than a sample step, and no crease crosses
        t = np.unique(np.round(np.asarray(ts, dtype=np.float64), 12))
        t = t[(t > 1e-12) & (t < 1.0 - 1e-12)][:, None]  # strictly interior
        if not len(t):
            continue
        r_mm.append(P_mm[i0] + (P_mm[i1] - P_mm[i0]) * t)
        r_uv.append(base_uv0[i0] + (base_uv0[i1] - base_uv0[i0]) * t)
        r_xyz.append(base_xyz0[i0] + (base_xyz0[i1] - base_xyz0[i0]) * t)
    ring_mm = np.concatenate(r_mm)
    ring_uv = np.concatenate(r_uv)
    ring_xyz = np.concatenate(r_xyz)

    # Sample lines over the face bbox, kept strictly interior.
    lo_u, hi_u = rp_u.min() - spacing, rp_u.max() + spacing
    lo_v, hi_v = rp_v.min() - spacing, rp_v.max() + spacing
    if cells_mode:
        # CELLULAR kinds bring their own vertex set, already in mm coordinates
        # (they ignore `angle`, so there is no pattern frame to map back from).
        G_all = np.asarray(cell_points, dtype=np.float64)
        if len(G_all) > 4 * max(max_tris, 100):
            raise ValueError("cell lattice overshoots budget")
        gx = gy = None
        ni = nj = 0
    else:
        if lattice:
            gx = _axis_lines(phases[0], period, lo_u, hi_u)
            gy = _axis_lines(phases[1], period, lo_v, hi_v)
        else:
            gx = np.arange(lo_u, hi_u, spacing)
            gy = np.arange(lo_v, hi_v, spacing)
        if len(gx) < 2 or len(gy) < 2:
            raise ValueError("too few sample lines")
        if len(gx) * len(gy) > 4 * max(max_tris, 100):
            raise ValueError("grid overshoots budget")
        GX, GY = np.meshgrid(gx, gy, indexing="ij")
        gu, gv = GX.ravel(), GY.ravel()
        # inverse rotation, undoing the offset shift applied above
        G_all = np.stack([gu * ca + gv * sa - offset, -gu * sa + gv * ca], axis=1)
        ni, nj = len(gx), len(gy)
    inside = _points_in_polygon(G_all, ring_a, ring_b)
    if wrap_u:
        # Points sitting exactly ON the UV seam are INSIDE — the seam is an
        # artificial cut, not an edge. Even-odd ray casting cannot tell: it fires
        # along +u, so a point on the u=0 edge crosses the far side and counts as
        # inside while its twin on the u=turn edge crosses nothing and counts as
        # outside. That drops one of the two columns, leaving the survivors on
        # the chart's hull with nothing to weld to, and the taper then pins them
        # flat — the seam stripe again, by a subtler route.
        v_lo, v_hi = ring_mm[:, 1].min(), ring_mm[:, 1].max()
        on_seam = ((np.abs(G_all[:, 0]) < 1e-6) | (np.abs(G_all[:, 0] - wrap_u) < 1e-6))
        if seam_vs is not None:
            # the on-seam lattice points ride in the RING now (seam-aware
            # densification above); keeping interior copies as well would hand
            # Delaunay duplicate points
            inside &= ~on_seam
        elif cells_mode:
            inside |= on_seam & (G_all[:, 1] > v_lo - 1e-9) & (G_all[:, 1] < v_hi + 1e-9)
    ring_cull_ref = ring_mm
    if seam_vs is not None:
        # the seam ring IS lattice geometry now; culling lattice points for
        # sitting near it would eat the very corners the seam strip needs.
        # Cull only against the real rims.
        ring_on_cut = (np.abs(ring_mm[:, 0]) < 1e-6) | (np.abs(ring_mm[:, 0] - wrap_u) < 1e-6)
        if (~ring_on_cut).any():
            ring_cull_ref = ring_mm[~ring_on_cut]
    d_bnd, _ = cKDTree(ring_cull_ref).query(G_all, workers=-1)
    # Cull grid points sitting essentially on the ring, which would make Delaunay
    # slivers. The lattice needs a far smaller margin than the sampled grid: its
    # points are not interchangeable samples but the pattern's own corners, and
    # dropping one costs a facet outright. Measured at 0.6: a knurl cell 0.277mm
    # from the rim lost the corner its crease needed, and NO edge flip could
    # recover it, because the vertex was simply not in the mesh.
    cull = 0.15 if lattice else 0.6
    keep_pt = inside & (d_bnd > cull * spacing)
    n_ring = len(ring_mm)
    if cells_mode:
        # an explicit cell vertex set has no (i, j) structure to index
        kept = gidx = None
        G = G_all[keep_pt]
    else:
        kept = keep_pt.reshape(ni, nj)
        gidx = np.full((ni, nj), -1, dtype=np.int64)
        gidx[kept] = n_ring + np.arange(int(kept.sum()))
        G = G_all.reshape(ni, nj, 2)[kept]
    V_mm = np.concatenate([ring_mm, G])
    if len(V_mm) < 4:
        raise ValueError("too few vertices")

    def _drop_outside(t, cells=None):
        """Keep triangles inside the face and non-degenerate (and, when the
        structured interior already tiled them, outside the full cells)."""
        c = V_mm[t].mean(axis=1)
        f1 = V_mm[t[:, 1]] - V_mm[t[:, 0]]
        f2 = V_mm[t[:, 2]] - V_mm[t[:, 0]]
        ok = (_points_in_polygon(c, ring_a, ring_b)
              & (np.abs(f1[:, 0] * f2[:, 1] - f1[:, 1] * f2[:, 0]) > spacing * spacing * 1e-4))
        if cells is not None:
            # cell test in pattern coords. searchsorted, not a division: the
            # lattice's lines are NOT evenly spaced, so the arithmetic index a
            # uniform grid allows would land in the wrong column.
            pu = (c[:, 0] + offset) * ca - c[:, 1] * sa
            pv = (c[:, 0] + offset) * sa + c[:, 1] * ca
            pi = np.clip(np.searchsorted(gx, pu) - 1, 0, ni - 2)
            pj = np.clip(np.searchsorted(gy, pv) - 1, 0, nj - 2)
            ok &= ~cells[pi, pj]
        return t[ok]

    if lattice:
        # ONE Delaunay over every vertex, for all lattice kinds. Tiling then
        # holds by construction — Delaunay covers its hull exactly once, so
        # neither overlap nor holes are possible. The structured interior +
        # stitched band it replaces cannot promise that: the band is an
        # unconstrained Delaunay that bridges concave notches in the full-cell
        # region, and the centroid test meant to catch that both over- and
        # under-fires. Measured 2mm^2 of double coverage on a 400mm^2 face one
        # way, and 0.65mm^2 of holes the other.
        #
        # What the structured path bought was a deliberate diagonal per cell.
        # That is imposed afterwards where it matters, which is strictly better:
        # the right diagonal is a property of the pattern, not of the grid.
        tris = _drop_outside(Delaunay(V_mm).simplices)
        if not cells_mode and phases[1] is not None:
            # both axes carry creases, so cells are square and min()'s switch
            # line IS a diagonal — see _force_cell_diagonals
            full = kept[:-1, :-1] & kept[1:, :-1] & kept[1:, 1:] & kept[:-1, 1:]
            ii, jj = np.nonzero(full)
            if len(ii):
                quads = np.stack([gidx[ii, jj], gidx[ii + 1, jj],
                                  gidx[ii + 1, jj + 1], gidx[ii, jj + 1]], axis=1)
                h = field(V_mm[quads.ravel()]).reshape(-1, 4)
                centre = field(V_mm[quads].mean(axis=1))
                # the cell centre lies on BOTH candidate diagonals, so the height
                # a diagonal implies there is the mean of its two endpoints
                want_main = np.abs((h[:, 0] + h[:, 2]) * 0.5 - centre) <= \
                    np.abs((h[:, 1] + h[:, 3]) * 0.5 - centre)
                tris = _force_cell_diagonals(tris, V_mm, quads, want_main)
        # mop up the rim band, where the stitching can still bridge a crease.
        # Seam ring vertices displace with the field (taper-exempt), so the
        # seam strip is scored and repaired too — see _flip_to_creases.
        #
        # `pin_ring` is false whenever `boundaryInset` is 0 (the DEFAULT), which
        # since the boundary skirt leaves EVERY ring vertex at full height. The
        # exclusion then has nothing left to protect and only blinds the pass to
        # the band it exists for — measured on a hex cylinder carrying embossed
        # text, whose eleven glyph outlines are all internal rings.
        tris = _flip_to_creases(
            tris, V_mm, field, n_ring=n_ring if pin_ring else 0,
            ring_fixable=((np.abs(ring_mm[:, 0]) < 1e-6)
                          | (np.abs(ring_mm[:, 0] - wrap_u) < 1e-6))
            if (wrap_u and pin_ring) else None)
    else:
        # STRUCTURED interior triangulation with one consistent diagonal per
        # cell. (Delaunay on a regular grid is co-circular — its arbitrary
        # tie-break flips diagonals cell to cell, and the between-row surface
        # tents differently per cell: visible "roped" beading along
        # otherwise-straight crests. A fixed diagonal removes that entirely.)
        # Delaunay is only used for the irregular band stitching the grid region
        # to the boundary ring. Cells here are near-square, which is the regime
        # the centroid-only overlap test is sound in.
        full = kept[:-1, :-1] & kept[1:, :-1] & kept[1:, 1:] & kept[:-1, 1:]
        ii, jj = np.nonzero(full)
        a = gidx[ii, jj]; b_ = gidx[ii + 1, jj]; c = gidx[ii + 1, jj + 1]; d = gidx[ii, jj + 1]
        interior_tris = np.concatenate([np.stack([a, b_, c], axis=1),
                                        np.stack([a, c, d], axis=1)])

        # band = ring verts + kept grid points NOT fully surrounded by full cells
        # (a point with all 4 adjacent cells full is interior-only; everything
        # else participates in the stitching band)
        surrounded = np.zeros((ni, nj), dtype=bool)
        core = full[:-1, :-1] & full[1:, :-1] & full[1:, 1:] & full[:-1, 1:]
        surrounded[1:-1, 1:-1] = core
        band_ids = np.concatenate([np.arange(n_ring), gidx[kept & ~surrounded]])
        band_tris = band_ids[Delaunay(V_mm[band_ids]).simplices]
        tris = np.concatenate([interior_tris, _drop_outside(band_tris, cells=full)])
    if len(tris) == 0:
        raise ValueError("empty after filtering")

    # Map back. Ring verts carry their exact on-edge uv/xyz either way (originals
    # verbatim, densified ones lerped along the same segments, which is what
    # keeps the seam flush).
    base_uv_arr = np.asarray(base_uv, dtype=np.float64)
    base_pts_arr = np.asarray(base_pts, dtype=np.float64)
    if unchart is None:
        # PLANE: uv and xyz are both affine in the mm chart, so one least-squares
        # fit places every grid point with no per-point OCCT evaluation at all.
        # The residual doubles as the planarity assertion.
        M = np.column_stack([P_mm, np.ones(len(P_mm))])
        A_uv, res_uv, _rk, _sv = np.linalg.lstsq(M, base_uv_arr, rcond=None)
        A_xyz, res_xyz, _rk2, _sv2 = np.linalg.lstsq(M, base_pts_arr, rcond=None)
        fit_err = np.abs(M @ A_xyz - base_pts_arr).max()
        if fit_err > max(1e-4, spacing * 1e-3):
            raise ValueError("non-affine chart (not a plane?)")
        GM = np.column_stack([G, np.ones(len(G))])
        grid_uv, grid_xyz = GM @ A_uv, GM @ A_xyz
    else:
        # CYLINDER / CONE: the chart is exact but curved, so invert it in closed
        # form and evaluate the surface directly. Only interior grid points go
        # through this — the ring deliberately does NOT, because its points must
        # stay on the neighbouring face's chords rather than on the true surface.
        grid_uv, grid_xyz = unchart(G)
    uv_out = np.concatenate([ring_uv, grid_uv])
    pts_out = np.concatenate([ring_xyz, grid_xyz])

    # winding: match the base triangulation's outward orientation
    n_ref = np.cross(base_pts_arr[tri_idx[0, 1]] - base_pts_arr[tri_idx[0, 0]],
                     base_pts_arr[tri_idx[0, 2]] - base_pts_arr[tri_idx[0, 0]])
    n_new = np.cross(pts_out[tris[:, 1]] - pts_out[tris[:, 0]],
                     pts_out[tris[:, 2]] - pts_out[tris[:, 0]])
    wrong = (n_new @ n_ref) < 0
    tris[wrong] = tris[wrong][:, [0, 2, 1]]

    return ([tuple(p) for p in pts_out], [tuple(p) for p in uv_out],
            [tuple(int(i) for i in t) for t in tris])


LATTICE_SURFACES = ("plane", "cylinder", "cone")


def _surface_kind(surf):
    """plane / cylinder / cone — the surfaces `_face_uv_to_mm` charts EXACTLY,
    and therefore the ones a lattice can be placed on. Everything else gets a
    single-Jacobian approximation of the chart, which is fine for sampling a
    field but not for claiming a vertex sits on a crease."""
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane

    t = surf.GetType()
    if t == GeomAbs_Plane:
        return "plane"
    if t == GeomAbs_Cylinder:
        return "cylinder"
    if t == GeomAbs_Cone:
        return "cone"
    return None


def _uncharter(surf, period=None):
    """Return `unchart(mm) -> (uv, xyz)`, the inverse of `_face_uv_to_mm` plus
    the surface evaluation, for the exactly-chartable surfaces.

    Closed form and vectorised rather than a per-point `surf.Value` call: a
    knurled cylinder places tens of thousands of lattice points, and OCCT
    evaluates one at a time. Both parametrisations are OCCT's own —
    P(u,v) = Loc + (R + v·sinA)·(cos u·X + sin u·Y) + v·cosA·Z, with A = 0 for a
    cylinder."""
    kind = _surface_kind(surf)
    if kind == "plane":
        return None  # affine in the mm chart; the caller's lstsq fit is exact

    if kind == "cylinder":
        cyl = surf.Cylinder()
        ax, radius, half = cyl.Position(), cyl.Radius(), 0.0
    else:
        cone = surf.Cone()
        ax, radius, half = cone.Position(), cone.RefRadius(), cone.SemiAngle()

    loc = np.array([ax.Location().X(), ax.Location().Y(), ax.Location().Z()])
    xd = np.array([ax.XDirection().X(), ax.XDirection().Y(), ax.XDirection().Z()])
    yd = np.array([ax.YDirection().X(), ax.YDirection().Y(), ax.YDirection().Z()])
    zd = np.array([ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()])
    sin_a, cos_a = math.sin(half), math.cos(half)
    per_turn = _turn_mm(surf, period)

    def unchart(mm):
        v = mm[:, 1]
        # invert the ANCHORED chart: u_mm is arc measured at the reference
        # radius, so the angle is a plain proportion of one full turn
        u = mm[:, 0] * (2.0 * math.pi) / per_turn
        # the POINT still sits at the surface's true local radius
        r = radius + v * sin_a
        xyz = (loc[None, :]
               + (r[:, None] * np.cos(u)[:, None]) * xd[None, :]
               + (r[:, None] * np.sin(u)[:, None]) * yd[None, :]
               + (v * cos_a)[:, None] * zd[None, :])
        return np.column_stack([u, v]), xyz

    return unchart


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
        # Which edges bound the face — recomputed each pass, since splitting a
        # boundary edge yields two more of them.
        counts = _boundary_edges(tris)
        on_boundary = {k for k, n in counts.items() if n == 1}

        def midpoint(i, j):
            key = (i, j) if i < j else (j, i)
            hit = mid.get(key)
            if hit is not None:
                return hit
            um = (uv[i][0] + uv[j][0]) * 0.5
            vm = (uv[i][1] + uv[j][1]) * 0.5
            if key in on_boundary:
                # CHORD, not the true surface. The neighbouring untextured face
                # still spans this edge as a straight segment, so putting the new
                # vertex on the real surface bulges this face off that segment by
                # up to the chord's sagitta and opens a seam. Measured on a
                # knurled r=10 cylinder: 4,032 of 4,224 boundary vertices adrift,
                # by up to 0.048mm, against a polyline the two faces otherwise
                # share bit-identically. Splitting the edge is still required —
                # leaving it unsplit while its neighbours divide would create a
                # T-junction, which cracks the mesh from the inside instead.
                p = ((pts[i][0] + pts[j][0]) * 0.5,
                     (pts[i][1] + pts[j][1]) * 0.5,
                     (pts[i][2] + pts[j][2]) * 0.5)
            else:
                pp = surf.Value(um, vm)
                p = (pp.X(), pp.Y(), pp.Z())
            idx = len(pts)
            pts.append(p)
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


def _boundary_taper(pts_arr, tris, inset_mm, exempt=None):
    """How much of the pattern's height each vertex is allowed, 0..1.

    `inset_mm > 0` smoothsteps from 0 at the face boundary to 1 over that
    distance, which keeps boundary vertices bit-identical to the untextured mesh
    so a neighbouring untextured face needs no special handling and no crack can
    form at the seam.

    `inset_mm == 0` (the DEFAULT) no longer pins the boundary. Pinning it while
    the vertex one step inside got full height put a one-triangle cliff around
    every boundary — so a cell cut by a face edge, or by the outline of embossed
    text, had its flat top dragged down to the base surface on one side and read
    as a mangled, stretched cell rather than part of the pattern. The boundary is
    now left at full height and `_skirt` closes the resulting step with a
    vertical wall, which keeps the cells flat AND the mesh watertight.

    Distance is to the nearest boundary-edge ENDPOINT (cKDTree), not the exact
    segment: boundary edges are subdivided to ~the texture sample length, so the
    error is bounded by half a segment — invisible inside a 1mm smoothstep — and
    boundary vertices themselves are endpoints, so their distance (and taper) is
    EXACTLY zero, preserving the crack-free invariant. (The exact all-pairs
    point-to-segment pass this replaces was >90% of textured-tessellation time.)"""
    edge_count = _boundary_edges(tris)
    boundary = [k for k, n in edge_count.items() if n == 1]
    if exempt is not None:
        # A closed surface's UV SEAM is an artificial cut, not an edge, and
        # pinning it leaves a flat stripe running the height of every textured
        # cylinder and cone (measured: 78 vertices in one line, all undisplaced).
        # Nothing is welded to achieve this — now that a full turn is a whole
        # number of pattern periods, the two sides evaluate the SAME field and
        # displace identically, so they stay coincident on their own. Leaving the
        # triangulation alone is what keeps the crease-exactness intact; welding
        # after the flip repair instead broke 1-5% of the triangles near the seam.
        boundary = [k for k in boundary if not (exempt[k[0]] and exempt[k[1]])]
    if not boundary or inset_mm <= 1e-9:
        return np.ones(len(pts_arr)), edge_count, boundary
    from scipy.spatial import cKDTree

    endpoints = pts_arr[np.unique(np.asarray(boundary, dtype=np.int64).ravel())]
    d, _ = cKDTree(endpoints).query(pts_arr, workers=-1)  # exact same results, all cores
    return _smoothstep(np.clip(d / inset_mm, 0.0, 1.0)), edge_count, boundary


def _skirt(base_pts, disp_pts, boundary):
    """Vertical wall closing the step between the DISPLACED pattern and the
    face's true, undisplaced boundary.

    Without it, leaving the boundary at full height would lift the edge of the
    textured face clear of its untextured neighbour and open a crack.

    The wall SHARES the surface mesh's boundary vertices for its top edge and
    one ring of new vertices for its foot, rather than emitting four fresh
    corners per quad. Fresh corners would shade a crisper rim, but they leave
    every wall edge unshared by index — geometrically watertight, and flagged
    non-manifold by some slicers, which is the same trade this file already
    resolves in favour of printing at the split_creases return. Measured: fresh
    corners added ~4,500 unshared edges to one textured cylinder. The viewport
    gets its crisp rim anyway, because split_creases de-indexes and re-derives
    per-triangle normals downstream.

    The foot ring lands exactly on the original boundary, so the face's outer
    edge stays bit-identical to the untextured mesh and neighbours still match.

    Returns (extra_pts, extra_normals, tris) with `tris` already indexed into the
    concatenation of the displaced vertices and `extra_pts`, or None if nothing
    moved."""
    if not boundary:
        return None
    e = np.asarray(boundary, dtype=np.int64)
    moved = np.linalg.norm(disp_pts - base_pts, axis=1) > 1e-6
    # A boundary vertex the pattern barely lifts gets no wall, so it must sit
    # EXACTLY on the polyline the neighbouring untextured face uses. Evaluating
    # the field there returns ~1e-9 rather than a true zero, and the old pinned
    # path hid that by multiplying the displacement by 0.0. Snap it back: every
    # boundary vertex is now either walled or bit-identical to the shared
    # polyline, with no third case that could leak a seam.
    still = np.unique(e)[~moved[np.unique(e)]]
    disp_pts[still] = base_pts[still]
    keep = moved[e[:, 0]] | moved[e[:, 1]]
    if not keep.any():
        return None
    e = e[keep]
    ring = np.unique(e)                      # boundary vertices needing a foot
    foot = {v: k for k, v in enumerate(ring)}  # original index -> foot slot
    n_disp = len(disp_pts)
    i, j = e[:, 0], e[:, 1]
    fi = np.array([foot[v] for v in i], dtype=np.int64) + n_disp
    fj = np.array([foot[v] for v in j], dtype=np.int64) + n_disp
    tris = np.concatenate([
        np.stack([i, j, fj], axis=1),
        np.stack([i, fj, fi], axis=1),
    ])
    # wall normal: along the edge x down the step, accumulated onto the feet it
    # touches. _orient_windings fixes winding afterwards, so only the AXIS matters.
    wn = np.cross(disp_pts[j] - disp_pts[i], base_pts[i] - disp_pts[i])
    acc = np.zeros((len(ring), 3))
    np.add.at(acc, fi - n_disp, wn)
    np.add.at(acc, fj - n_disp, wn)
    ln = np.linalg.norm(acc, axis=1)
    ln[ln < 1e-12] = 1.0
    return base_pts[ring], acc / ln[:, None], tris




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


def _geometry_key(face, tri, flip, spec, scale, angle, inset_mm, cap):
    """Cache key for the height-INDEPENDENT skeleton.

    It must carry every spec field the SAMPLING geometry depends on. Before
    crease-aligned lattices the skeleton was genuinely kind-independent (a
    uniform grid at scale/angle), so kind/sharpness/profile/offset were
    correctly absent. A lattice derives its vertex placement from the pattern
    itself, so all four now move vertices — leaving them out serves a knurl
    skeleton for a hex texture at the same scale and angle."""
    node1 = tri.Node(1)
    return (
        face.wrapped.TShape(), tri.NbNodes(), tri.NbTriangles(),
        round(node1.X(), 9), round(node1.Y(), 9), round(node1.Z(), 9),
        flip, round(scale, 6), round(angle, 6), round(inset_mm, 6), cap,
        spec["kind"], round(float(spec.get("sharpness", 0.5)), 6),
        spec.get("profile", "facet"), round(float(spec.get("offset", 0.0)), 6),
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

    # Three tiers, most exact first:
    #   1. CREASE-ALIGNED LATTICE — sample lines on the pattern's own gradient
    #      breakpoints, so the mesh reproduces the faceted profile exactly.
    #   2. uniform pattern-aligned grid — the sampled approximation. An
    #      axis-aligned grid beats against a diagonal pattern (roped/beaded
    #      ridges); alignment gives straight crests at the same triangle budget.
    #   3. general subdivision — anything the mm chart cannot place a line on.
    # Tier 2 is a real fallback, not a failure: a fine pattern on a large face
    # has a line count fixed by the pattern rather than the budget, and dropping
    # straight to tier 3 there would be far worse than a coarser grid.
    #
    # Tiers 1-2 now cover CYLINDERS and CONES as well as planes, which is where
    # the win is largest — a knurled knob is a cylinder, and the subdivision path
    # spent 834 triangles per pattern cell on one (against ~10 for a plane)
    # because it refines uniformly from a coarse base mesh with no idea where the
    # pattern is.
    pts = None
    lattice_used = False
    if _surface_kind(surf) is not None:
        base_uv_arr = np.asarray(base_uv, dtype=np.float64)
        u_period = _u_period(spec, scale)
        bu_mm, bv_mm = _face_uv_to_mm(surf, base_uv_arr[:, 0], base_uv_arr[:, 1], u_period)
        phases = _pattern_axes(spec["kind"], spec)
        tex_offset = float(spec.get("offset", 0.0))
        # a closed cylinder/cone is periodic in u: the seam is an artificial
        # cut. Every kind's assembly needs to know where it is — cellular kinds
        # to keep the lattice periodic, and ALL kinds so the crease-repair pass
        # may fix seam-strip triangles (their ring vertices displace with the
        # field, unlike a real rim's).
        wrap_u = None
        if _surface_kind(surf) in ("cylinder", "cone"):
            span = float(surf.LastUParameter() - surf.FirstUParameter())
            if abs(span - 2.0 * math.pi) < 1e-6:
                wrap_u = _turn_mm(surf, u_period)
        cell_points = None
        cell_creases = None
        if phases == "cells":
            # cellular kinds place their own vertices, in mm coordinates; the
            # offset shifts u exactly as it does for the field
            phases = None
            pad = max(scale, target_edge_mm)
            bbox = (float(bu_mm.min()) + tex_offset - pad,
                    float(bu_mm.max()) + tex_offset + pad,
                    float(bv_mm.min()) - pad, float(bv_mm.max()) + pad)
            cell_points = _cell_lattice_points(spec["kind"], spec, scale, *bbox,
                                               wrap_u=wrap_u)
            cell_creases = _cell_crease_segments(spec["kind"], spec, scale, *bbox)
            shift = np.array([tex_offset, 0.0])
            if cell_points is not None:
                cell_points = cell_points - shift
            if cell_creases is not None:
                cell_creases = (cell_creases[0] - shift, cell_creases[1] - shift)

        def _field(pts_mm):
            # the same field displace_face will evaluate, offset included, so a
            # diagonal chosen here is the one the displaced mesh actually needs
            return height_field(spec["kind"], spec,
                                pts_mm[:, 0] + tex_offset, pts_mm[:, 1])

        attempts = ((phases, cell_points, True), (None, None, False)) \
            if (phases or cell_points is not None) else ((None, None, False),)
        for want_phases, want_cells, is_lattice in attempts:
            try:
                pts, uv, tris = _aligned_grid_triangulation(
                    base_pts, base_uv, base_tris, bu_mm, bv_mm,
                    float(spec.get("angle", 0.0)), target_edge_mm, cap,
                    pattern_period=scale, phases=want_phases,
                    offset=tex_offset, field=_field if is_lattice else None,
                    unchart=_uncharter(surf, u_period), cell_points=want_cells,
                    wrap_u=wrap_u,
                    cell_creases=cell_creases if is_lattice else None,
                    # the skirt leaves the ring at full height unless an inset
                    # tapers it — see the _flip_to_creases call
                    pin_ring=float(spec.get("boundaryInset", 0.0)) > 1e-9,
                )
                lattice_used = is_lattice
                break
            except Exception:
                pts = None
    if pts is None:
        lattice_used = False
        pts, uv, tris = _refine_face_triangulation(surf, base_pts, base_uv, base_tris, target_edge_mm, cap)

    pts_arr = np.asarray(pts, dtype=np.float64)
    uv_arr = np.asarray(uv, dtype=np.float64)
    tris_arr = np.asarray(tris, dtype=np.int64)
    # median, not mean: the aligned-grid path stitches a sparse boundary ring
    # with a few long edges that would skew a mean and false-trigger the clamp
    mean_edge = float(np.median(np.linalg.norm(pts_arr[tris_arr[:, 0]] - pts_arr[tris_arr[:, 1]], axis=1)))

    u_mm, v_mm = _face_uv_to_mm(surf, uv_arr[:, 0], uv_arr[:, 1], _u_period(spec, scale))

    inset_mm = max(float(spec.get("boundaryInset", 0.0)), 0.0)
    # vertices sitting on a closed face's UV seam — an artificial cut, so they
    # must not be pinned like a real face boundary (see _boundary_taper)
    seam = None
    if _surface_kind(surf) in ("cylinder", "cone"):
        span = float(surf.LastUParameter() - surf.FirstUParameter())
        if abs(span - 2.0 * math.pi) < 1e-6:
            turn = _turn_mm(surf, _u_period(spec, scale))
            seam = (np.abs(u_mm) < 1e-6) | (np.abs(u_mm - turn) < 1e-6)
    taper, edge_count, boundary = _boundary_taper(pts_arr, tris, inset_mm, exempt=seam)
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
        "lattice": lattice_used,
        "taper": taper, "manifold_ok": manifold_ok, "manifold_bad": manifold_bad,
        "boundary": boundary,
        "normals": normals, "t_u": t_u, "t_v": t_v,
    }


def _orient_windings(P, I, normals):
    """Return I with every triangle wound to AGREE with its vertices' normals.

    The lattice assembly triangulates in the 2D chart with scipy's Delaunay,
    whose simplex orientation is NOT guaranteed consistent — measured on a
    reversed tube face: 40,062 triangles wound outward, 40,064 inward, split
    cleanly down two halves of the cylinder. The analytic normals were right,
    but a double-sided renderer decides front/back per PIXEL from the winding
    and NEGATES the shading normal on back faces, so the inward-wound half lit
    inside-out — a hard model-fixed light/dark split no lighting rig could
    remove (2026-08-02, the whole evening's "hard line"). Winding also rides
    into STL/3MF, where inconsistent orientation is a printability defect.

    An earlier patch flipped the emitted NORMAL to match the winding — exactly
    backwards under gl_FrontFacing negation. Orient the WINDING; normals are
    already correct."""
    e1 = P[I[:, 1]] - P[I[:, 0]]
    e2 = P[I[:, 2]] - P[I[:, 0]]
    gn = np.cross(e1, e2)
    ref = normals[I[:, 0]] + normals[I[:, 1]] + normals[I[:, 2]]
    flip = (gn * ref).sum(axis=1) < 0.0
    if flip.any():
        I = I.copy()
        I[flip, 1], I[flip, 2] = I[flip, 2], I[flip, 1].copy()
    return I


def displace_face(face, tri, loc, ident, spec, density_cap, diag=None, feature_id=None,
                  split_creases=False):
    """Return (positions, indices, normals) — a LOCAL (0-based) flat mesh for one
    textured face plus per-vertex displaced normals, ready for the caller to
    offset and append into the global buffers (same convention tessellate()'s
    own per-face loop already uses).

    `split_creases` (VIEWPORT ONLY — see the flat-shading note at the return)
    emits the face non-indexed with per-triangle normals, so a faceted profile
    reads as hard surface instead of being smoothed across its creases."""
    from OCP.TopAbs import TopAbs_Orientation

    kind = spec["kind"]
    scale = max(float(spec.get("scale", 2.0)), 0.05)
    flip = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
    target_edge_mm = max(scale / 4.0, 0.05)  # ~4 samples per pattern wavelength
    cap = density_cap if density_cap else _DEFAULT_DENSITY_CAP
    inset_mm = max(float(spec.get("boundaryInset", 0.0)), 0.0)

    key = _geometry_key(face, tri, flip, spec, scale, float(spec.get("angle", 0.0)), inset_mm, cap)
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
    if kind != "image" and not geom.get("lattice") and mean_edge > target_edge_mm * 1.25:
        # the density cap stopped refinement short of the target sampling —
        # evaluating the pattern at its true frequency would alias into noise.
        # Clamp the wavelength to what this mesh can carry so an under-sampled
        # face shows a clean, coarser pattern; exports use a far larger cap.
        #
        # A crease-aligned lattice is exempt: its edge length is set by the
        # PATTERN (a rib cell is one period long however coarse the budget), not
        # by a sampling rate, and it reproduces the profile exactly at any size.
        # Clamping it would coarsen a pattern that was never under-sampled.
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

    # The wall that lets the pattern keep full height at the boundary. Only
    # needed when the taper isn't already easing it to zero there.
    skirt = _skirt(pts_arr, disp, geom["boundary"]) if inset_mm <= 1e-9 else None

    if split_creases and _is_facet(spec):
        # HARD-SURFACE SHADING. A shared vertex can carry only ONE normal, so on
        # a creased surface it is forced to average the two facets that meet
        # there — which is exactly why sharp geometry still rendered soft. Emit
        # the face non-indexed (3 vertices per triangle) with each triangle's own
        # geometric normal.
        #
        # VIEWPORT ONLY, deliberately: positions/indices from here also feed
        # STL/3MF export, and de-indexing a 3MF means shared edges no longer
        # share a vertex index — geometrically watertight but flagged as
        # non-manifold by some slicers. Printing correctness beats shading, so
        # the export path keeps the indexed mesh (STL is non-indexed regardless).
        idx = _orient_windings(disp, np.asarray(geom["flat_indices"], dtype=np.int64).reshape(-1, 3),
                               disp_normals)
        tri_pts = disp[idx]  # (T, 3, 3)
        if skirt is not None:
            s_pts, s_norm, s_tris = skirt
            all_p = np.concatenate([disp, s_pts])
            all_n = np.concatenate([disp_normals, s_norm])
            tri_pts = np.concatenate([tri_pts, all_p[_orient_windings(all_p, s_tris, all_n)]])
        fn = np.cross(tri_pts[:, 1] - tri_pts[:, 0], tri_pts[:, 2] - tri_pts[:, 0])
        ln = np.linalg.norm(fn, axis=1)
        ln[ln < 1e-12] = 1.0
        fn /= ln[:, None]
        out_pts = tri_pts.reshape(-1, 3)
        return (
            out_pts.ravel().tolist(),
            list(range(len(out_pts))),
            np.repeat(fn, 3, axis=0).ravel().tolist(),
        )

    idx = _orient_windings(disp, np.asarray(geom["flat_indices"], dtype=np.int64).reshape(-1, 3),
                           disp_normals)
    if skirt is not None:
        s_pts, s_norm, s_tris = skirt
        disp = np.concatenate([disp, s_pts])
        disp_normals = np.concatenate([disp_normals, s_norm])
        idx = np.concatenate([idx, _orient_windings(disp, s_tris, disp_normals)])
    return disp.ravel().tolist(), idx.ravel().tolist(), disp_normals.ravel().tolist()