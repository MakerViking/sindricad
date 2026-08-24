"""Surface-texture tests (sidecar): two-phase validate/resolve, UV displacement,
boundary crack-freedom, the mesh-cache texture-key fix, and per-kind height
fields. Run: uv run python test_texture.py  (or: uv run pytest test_texture.py)
"""

import os
import tempfile

import numpy as np

import server
import texture
from builder import rebuild
from tessellate import tessellate

PASS = "  ok"


def _box(idx, w, h, depth, x=0, y=0, op="new"):
    """Two features (sketch + extrude) that build a w×h×depth box at (x,y)."""
    s, e = f"s{idx}", f"e{idx}"
    return s, [
        {"id": s, "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]},
        {"id": e, "type": "extrude", "sketch": s, "distance": depth, "operation": op},
    ]


def test_validate_texture_spec_rejects_bad_input():
    try:
        texture.validate_texture_spec({"kind": "glitter"})
        assert False, "unknown kind should raise"
    except ValueError:
        pass
    try:
        texture.validate_texture_spec({"kind": "knurl", "depth": -1})
        assert False, "non-positive depth should raise"
    except ValueError:
        pass
    try:
        texture.validate_texture_spec({"kind": "waves", "direction": "sideways"})
        assert False, "unknown direction should raise"
    except ValueError:
        pass
    spec = texture.validate_texture_spec({"kind": "knurl", "depth": 0.4, "scale": 2.0})
    assert spec["kind"] == "knurl" and spec["faces"] == {"by": "all"}
    print(PASS, "validate_texture_spec rejects bad kind/depth/direction, defaults faces to 'all'")


def test_whole_body_knurl_increases_triangles_and_bounds_displacement():
    _s, feats = _box(1, 20, 20, 5)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "knurl", "faces": {"by": "all"},
         "depth": 0.4, "scale": 2.0},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = bodies[0]
    resolved = texture.resolve_body_textures(b)
    assert resolved and resolved[0][1], "the 'all' selector should resolve to every face"

    pos_plain, idx_plain, _ = tessellate(b["shape"], 0.1)
    pos_tex, idx_tex, _ = tessellate(b["shape"], 0.1, textures=resolved)
    assert len(idx_tex) > len(idx_plain), "textured mesh should gain triangles from subdivision"

    p = np.array(pos_tex).reshape(-1, 3)
    pp = np.array(pos_plain).reshape(-1, 3)
    # displacement is bounded by depth in every direction (plus float slack)
    assert (p.max(axis=0) - pp.max(axis=0) <= 0.4 + 1e-6).all(), "displacement exceeded depth"
    assert (pp.min(axis=0) - p.min(axis=0) <= 0.4 + 1e-6).all(), "displacement exceeded depth"
    print(PASS, f"whole-body knurl: {len(idx_plain)//3} -> {len(idx_tex)//3} tris, "
                f"displacement bounded by depth")


def test_selected_face_only_leaves_other_faces_unchanged():
    _s, feats = _box(1, 20, 20, 5)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "ribs",
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "depth": 0.3, "scale": 2.0},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = bodies[0]
    resolved = texture.resolve_body_textures(b)
    pos_p, idx_p, fid_p = tessellate(b["shape"], 0.1)
    pos_t, idx_t, fid_t = tessellate(b["shape"], 0.1, textures=resolved)

    def face_points(pos, idx, fids, target):
        P = np.array(pos).reshape(-1, 3)
        I = np.array(idx).reshape(-1, 3)
        tris = I[np.array(fids) == target]
        return set(map(tuple, np.round(P[tris.ravel()], 6))) if len(tris) else set()

    all_fids = sorted(set(fid_p) | set(fid_t))
    changed = [f for f in all_fids if face_points(pos_p, idx_p, fid_p, f) != face_points(pos_t, idx_t, fid_t, f)]
    assert len(changed) == 1, f"expected exactly 1 changed face, got {changed}"
    assert len(all_fids) - 1 == 5, all_fids
    print(PASS, f"texturing one selected face leaves the other {len(all_fids) - 1} faces byte-identical")


def test_boundary_taper_to_zero_at_edge():
    # a synthetic 5x5 grid over [0,4]x[0,4] (1mm cells) — no OCCT needed, since
    # _boundary_taper is a pure geometry function over (points, triangles). The
    # center sits 2mm from every edge, well past a 1mm inset, so it should reach
    # full height while every boundary vertex tapers to exactly zero.
    n = 5
    pts = [(i, j, 0.0) for j in range(n) for i in range(n)]
    pts_arr = np.array(pts, dtype=float)

    def vid(i, j):
        return j * n + i

    tris = []
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)
            tris.append((a, b, c))
            tris.append((a, c, d))

    taper, edge_count, _boundary = texture._boundary_taper(pts_arr, tris, inset_mm=1.0)
    for idx in (vid(0, 0), vid(n - 1, 0), vid(0, n - 1), vid(n - 1, n - 1)):
        assert taper[idx] < 1e-9, f"boundary vertex {idx} should taper to exactly 0, got {taper[idx]}"
    center = vid(n // 2, n // 2)
    assert taper[center] > 0.99, f"interior vertex 2mm from every edge should reach full height, got {taper[center]}"
    print(PASS, "boundary taper is exactly zero at face-boundary vertices, full height in the interior")


def test_a_face_only_a_cell_or_two_across_still_carries_the_pattern():
    """Text on a face leaves the ENCLOSED part of an 'A' or a 'D' as its own
    small face — 3.9 mm² and 8.5 mm² on the test7 document, about one and two
    cells at the default scale. Under the old PINNED boundary those came out as
    stitching: 40% and 29% of their vertices sat on the boundary and were held
    at zero, so only 27% and 31% of the face reached the pattern's flat top
    against 44% on the big face around them, and each cell read as shattered.

    A guard that left such a face smooth was tried and REVERTED. It silently
    overrode a face the user had explicitly clicked — the tool looked like it
    was ignoring the click — and it was fixing a symptom of the pinned boundary
    that `_skirt` had already removed in the same change. With the boundary at
    full height the same two faces reach 42% and 46% plateau, i.e. the same
    balance as the 9,210 mm² face they sit in. So: no size gate. Every face the
    user selects gets the pattern.

    This asserts the invariant on a 4x2mm top face — 8 mm², the size of the 'D'
    counter — measured against a 20x20 one built the same way, because the
    absolute plateau fraction depends on where the honeycomb happens to land and
    only the COMPARISON is meaningful."""

    def plateau_of(w, h):
        _s, feats = _box(1, w, h, 5)
        feats += [{"id": "tex", "type": "texture", "kind": "hex", "faces": {"by": "all"},
                   "depth": 0.4, "scale": 2.0}]
        _part, errors, bodies = rebuild({"parameters": {}, "features": feats})
        assert not errors, errors
        b = bodies[0]
        faces = list(b["shape"].faces())
        spec = texture.resolve_body_textures(b)[0][0]
        top = max(range(len(faces)), key=lambda i: faces[i].center().Z)
        pos, idx, fids = tessellate(b["shape"], 0.1, textures=[(spec, faces)])
        P = np.asarray(pos).reshape(-1, 3)
        I = np.asarray(idx).reshape(-1, 3)
        mine = I[np.asarray(fids) == top]
        z = P[np.unique(mine.ravel())][:, 2] - 5.0  # box height; 'out' displaces +Z
        return faces[top].area, len(mine), z

    area, ntri, z = plateau_of(4, 2)
    assert 7.0 < area < 9.0, f"expected a ~8 mm2 top face, got {area}"
    assert ntri > 50, \
        f"a two-cell face must still be retessellated for the pattern, got {ntri} triangles"
    assert z.max() > 0.39, f"the pattern must reach full depth, got {z.max():.4f}"
    assert z.min() > -1e-6, f"an 'out' pattern must not cut in, got {z.min():.4f}"

    small = float(np.mean(z > 0.36))
    _a, _n, zbig = plateau_of(20, 20)
    big = float(np.mean(zbig > 0.36))
    # THE regression guard. Pinning the boundary dragged the small face's flat
    # top to well under a third of the big face's; leaving it at full height
    # keeps the two within ~15% of each other.
    assert small > 0.6 * big, \
        f"the cell's flat top is being dragged to the floor: {small:.2f} against {big:.2f} on a big face"
    print(PASS, f"an 8 mm2 face carries the pattern like a 400 mm2 one "
                f"({small:.2f} vs {big:.2f} at the flat top)")


def test_manifold_check_flags_bad_edge_count():
    good = {(0, 1): 2, (1, 2): 2, (2, 0): 1, (0, 3): 1, (3, 1): 1}  # interior edges=2, boundary=1
    ok, bad = texture._manifold_check(good)
    assert ok and bad == 0, (ok, bad)

    broken = {(0, 1): 3, (1, 2): 2, (2, 0): 1}  # an edge shared by 3 triangles is a bug
    ok2, bad2 = texture._manifold_check(broken)
    assert not ok2 and bad2 == 1, (ok2, bad2)
    print(PASS, "manifold check accepts 1/2-shared edges and flags anything else")


def test_manifold_diagnostic_surfaces_from_displace_face():
    # a pathologically dense request (tiny scale) forces max subdivision against the
    # density cap; even so the SAME dedup logic keeps it manifold — the diagnostic
    # path itself is unit-tested above, so here we confirm displace_face never
    # raises and produces a closed, well-formed local mesh at the cap.
    _s, feats = _box(1, 10, 10, 5)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "noise", "faces": {"by": "all"},
         "depth": 0.2, "scale": 0.3, "seed": 1},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = bodies[0]
    resolved = texture.resolve_body_textures(b)
    diag = []
    pos, idx, fids = tessellate(b["shape"], 0.1, textures=resolved, density_cap=5000, diag=diag)
    assert len(idx) > 0
    # the cap-bound case legitimately emits a "shown coarser than print detail"
    # note (frequency clamped to what the mesh can carry) — only a MANIFOLD
    # diagnostic would mean the mesh itself is broken.
    bad_diags = [d for d in diag if d.get("kind") == "texture" and "non-manifold" in d.get("reason", "")]
    assert not bad_diags, f"dense-but-valid subdivision should stay manifold, got {bad_diags}"
    coarse = [d for d in diag if "coarser than print detail" in d.get("reason", "")]
    assert coarse, "cap-bound subdivision should surface the coarse-preview note"
    print(PASS, "dense texture stays manifold under the density cap (coarse-preview note surfaced)")


def test_cache_key_changes_with_texture_params():
    """Regression test for the server.py _body_payload fix: a texture-only spec edit
    on the SAME shape object (the case a downstream unrelated timeline tweak can't
    tell apart from a no-op) must still invalidate the mesh cache. Without folding
    the texture-spec hash into the cache key, this would incorrectly serve the
    stale pre-texture mesh (same shape identity, same tolerance)."""
    _s, feats = _box(1, 10, 10, 5)
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = dict(bodies[0])
    b["id"] = "texcache-test-1"
    server._MESH_CACHE.pop(b["id"], None)

    b["_textures"] = None
    # a small document keeps full quality — see server._viewport_profile
    profile = server._viewport_profile(1)
    ent1 = server._body_payload(b, 0.1, profile)
    b["_textures"] = [texture.validate_texture_spec(
        {"kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0}
    )]
    ent2 = server._body_payload(b, 0.1, profile)

    assert ent1["etag"] != ent2["etag"], "a texture-only edit must invalidate the cached mesh"
    assert len(ent2["payload"]["positions"]) > len(ent1["payload"]["positions"]), \
        "the re-tessellated mesh should reflect the new texture (more verts from subdivision)"
    server._MESH_CACHE.pop(b["id"], None)
    print(PASS, "texture-spec-only edit changes the mesh cache key/etag (server.py fix verified)")


def test_height_field_kinds_in_zero_one_and_angle_rotates():
    # 1D u/v arrays, matching real usage: displace_face always calls height_field
    # with flattened per-vertex coordinate arrays, never a 2D meshgrid.
    rng = np.random.default_rng(0)
    U = rng.uniform(-5, 5, 1200)
    V = rng.uniform(-3, 3, 1200)

    for kind in ("knurl", "hex", "waves", "ribs"):
        spec = {"scale": 2.0, "angle": 15.0, "sharpness": 0.5}
        h = texture.height_field(kind, spec, U, V)
        assert h.shape == U.shape
        assert h.min() >= -1e-9 and h.max() <= 1 + 1e-9, f"{kind} field out of [0,1]: {h.min()}..{h.max()}"

    hv = texture.height_field("voronoi", {"scale": 2.0, "seed": 7}, U, V)
    assert hv.min() >= -1e-9 and hv.max() <= 1 + 1e-9

    hn = texture.height_field("noise", {"scale": 2.0, "seed": 3, "octaves": 3}, U, V)
    assert hn.min() >= -1e-9 and hn.max() <= 1 + 1e-9

    # rotate(u,v,90) == (-v,u): a 90-degree wave pattern must equal the unrotated
    # pattern evaluated with u <- -v — an exact algebraic transpose check.
    spec0 = {"scale": 2.0, "angle": 0.0, "sharpness": 0.5}
    spec90 = {"scale": 2.0, "angle": 90.0, "sharpness": 0.5}
    lhs = texture.height_field("waves", spec90, U, V)
    rhs = texture.height_field("waves", spec0, -V, np.zeros_like(V))
    assert np.allclose(lhs, rhs, atol=1e-9), "90-degree rotation should be an exact axis swap"
    print(PASS, "height_field kinds stay in [0,1]; angle rotation is exact")


def test_height_field_image_bilinear():
    from PIL import Image

    d = tempfile.mkdtemp()
    p = os.path.join(d, "grad.png")
    im = Image.new("L", (2, 2), 0)
    im.putpixel((1, 0), 255)
    im.putpixel((1, 1), 255)
    im.save(p)
    im.close()

    u = np.array([0.0, 5.0, 10.0])
    v = np.array([0.0, 0.0, 0.0])
    h = texture.height_field("image", {"imagePath": p}, u, v, u_range=(0.0, 10.0), v_range=(-1.0, 1.0))
    assert h[0] < 0.1, f"left edge should sample near-black, got {h[0]}"
    assert h[-1] > 0.9, f"right edge should sample near-white, got {h[-1]}"
    assert 0.3 < h[1] < 0.7, f"midpoint should be mid-gray, got {h[1]}"
    print(PASS, "image texture bilinear-samples across the face's UV bbox")


def test_texture_selector_survives_downstream_fillet():
    _s, feats = _box(1, 20, 20, 10)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "knurl",
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "depth": 0.3, "scale": 2.0},
        {"id": "fl", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 1},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = bodies[0]
    assert b.get("_textures"), "the texture spec should survive onto the body dict"
    resolved = texture.resolve_body_textures(b)
    assert resolved and resolved[0][1], "the texture selector should still match a face after the fillet"
    pos, idx, fids = tessellate(b["shape"], 0.1, textures=resolved)
    assert len(idx) // 3 > 0
    print(PASS, "texture selector survives a downstream fillet edit")


def test_missing_image_is_feature_error_not_crash():
    _s, feats = _box(1, 10, 10, 5)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "image", "faces": {"by": "all"},
         "imagePath": "/nonexistent/path/does-not-exist.png", "depth": 0.3, "scale": 2.0},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert errors, "a missing image path should be a feature error, not a silent pass"
    assert errors[0]["feature_id"] == "tex", errors
    assert part is not None and part.volume > 0, "the prior box feature must still build (error containment)"
    print(PASS, "missing texture image is a contained feature error, not a crash")


def test_texture_targets_bound_body_not_active_in_multibody():
    # Regression: with >1 body, a texture that omits `body` falls back to the
    # ACTIVE (last-created) body and resolves its face selector against the wrong
    # shape — so it lands on a random face of the wrong body (field report). The
    # frontend now binds `body`; the sidecar must honor it over require_active.
    feats = _box(1, 20, 20, 5, x=0)[1] + _box(2, 20, 20, 5, x=100)[1]
    sel = {"kind": "face", "by": "nearest", "point": [0, 0, 5]}  # aimed at body1's top

    # no body → require_active fallback aims at body2 (the last one built), where
    # the point is 90mm away and several faces are exactly tied. That used to
    # texture a random face of the wrong body silently; the selector ambiguity
    # gate now refuses, so the feature red-chips and NOTHING is textured.
    part, errors, bodies = rebuild({"parameters": {}, "features": feats + [
        {"id": "tex", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0, "faces": sel}]})
    assert errors and "ambiguous face reference" in errors[0]["message"], errors
    by_id = {b["id"]: b for b in bodies}
    assert not by_id["body1"].get("_textures") and not by_id["body2"].get("_textures"), \
        "a refused selector must not texture ANY body"

    # body=body1 → honored, texture lands on the intended body
    part, errors, bodies = rebuild({"parameters": {}, "features": feats + [
        {"id": "tex", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0,
         "body": "body1", "faces": sel}]})
    assert not errors, errors
    by_id = {b["id"]: b for b in bodies}
    assert by_id["body1"].get("_textures") and not by_id["body2"].get("_textures"), \
        "with `body=body1`, the texture must land on body1, not the active body"
    resolved = texture.resolve_body_textures(by_id["body1"])
    assert resolved and resolved[0][1], "the bound-body selector must resolve to a face"
    print(PASS, "texture honors bound `body` over active-body fallback (multi-body)")


def test_faceted_profile_is_piecewise_planar():
    """The hard-surface claim, measured. A faceted profile puts ALL its curvature
    at the creases and none in between (median 2nd difference exactly 0); the
    round profile spreads curvature over the whole cell, which is what read as
    soft bumps. knurl's old field was tri*tri — a product of two linear ramps is
    a BILINEAR SADDLE, so every cell curved."""
    x = np.linspace(0.0, 6.0, 301)
    y = np.zeros_like(x)
    for kind in ("knurl", "waves", "ribs", "hex", "noise"):
        spec = {"scale": 2.0, "angle": 45.0, "sharpness": 0.3, "seed": 1, "octaves": 3}
        facet = np.asarray(texture.height_field(kind, dict(spec, profile="facet"), x, y), dtype=float)
        round_ = np.asarray(texture.height_field(kind, dict(spec, profile="round"), x, y), dtype=float)
        med_f = float(np.median(np.abs(np.diff(facet, 2))))
        med_r = float(np.median(np.abs(np.diff(round_, 2))))
        assert med_f < 1e-12, f"{kind} facet should be flat between creases, median |2nd| = {med_f}"
        assert med_r > 1e-9, f"{kind} round should be curved throughout, median |2nd| = {med_r}"
        assert np.abs(np.diff(facet, 2)).max() > 1e-6, f"{kind} facet has no creases at all"
    print(PASS, "faceted profiles are piecewise planar; round profiles are curved throughout")


def test_knurl_facet_is_min_of_grooves_not_bilinear_product():
    """Two crossed V-grooves cut a MIN, not a product. At the centre of a cell
    both grooves are at full height, so min() is 1 while the product is also 1 —
    the two disagree off-axis, where the product's saddle sags."""
    s = 2.0
    # A 2D grid, not a line: along v=0 both grooves collapse to the same value
    # and min() == product trivially. The two only separate where BOTH grooves
    # are partway down — e.g. (0.25s, 0.25s): min=0.5 but product=0.25.
    g = np.linspace(0.05, 0.95, 11) * s
    U, V = np.meshgrid(g, g)
    u, v = U.ravel(), V.ravel()
    facet = texture._height_knurl(u, v, s, 0.0, 0.0, facet=True)
    product = texture._height_knurl(u, v, s, 0.0, 0.0, facet=False)
    _, v1 = texture._rotate(u, v, 0.0)
    _, v2 = texture._rotate(u, v, 90.0)
    expect = np.minimum(texture._tri_wave(v1, s), texture._tri_wave(v2, s))
    assert np.allclose(facet, expect), f"facet knurl should be min-of-grooves, got {facet}"
    assert not np.allclose(facet, product), "facet and round knurl must differ"
    # the product SAGS below the true groove surface everywhere they differ —
    # that sag is the bilinear saddle that made this read as soft bumps
    assert np.all(product <= facet + 1e-12), "the bilinear product should never exceed min-of-grooves"
    assert (facet - product).max() > 0.2, "the saddle sag should be substantial"
    print(PASS, "faceted knurl is min-of-two-grooves, not the bilinear product")


def test_terrace_quantises_into_flat_levels():
    h = np.linspace(0.0, 1.0, 500)
    for steps in (2, 5, 12):
        levels = np.unique(np.round(texture._terrace(h, steps), 9))
        assert len(levels) == steps, f"{steps} steps should give {steps} levels, got {len(levels)}"
    # the Sharp slider drives the count for the continuous kinds
    assert texture._steps_from(0.0) == 2
    assert texture._steps_from(1.0) == 12
    print(PASS, "terracing quantises noise/image into exactly N flat levels")


def test_trapezoid_land_widens_the_flat_top():
    x = np.linspace(0.0, 2.0, 401)
    pure_v = texture._trapezoid(x, 2.0, 0.0)
    landed = texture._trapezoid(x, 2.0, 0.6)
    at_top = lambda h: int(np.sum(h > 0.999))
    assert at_top(pure_v) <= 2, "land=0 is a pure V: only the apex reaches full height"
    assert at_top(landed) > 10, "land>0 must produce a real flat crest"
    assert landed.max() <= 1.0 + 1e-12 and landed.min() >= -1e-12
    print(PASS, "trapezoid land widens the crest without leaving [0,1]")


def test_hard_edge_keeps_full_depth_to_the_boundary():
    """At inset=0 the boundary is NO LONGER pinned to zero.

    It used to be, to guarantee a crack-free seam, and this test asserted it.
    But pinning the boundary while the vertex one step inside carried full depth
    put a one-triangle cliff around every boundary — so a cell cut by a face
    edge, or by the outline of embossed text, had its flat top dragged down on
    one side and read as a mangled cell rather than part of the pattern. The
    pattern now runs at full height right up to the boundary and `_skirt` closes
    the step with a wall, which is what keeps the seam crack-free (see
    test_skirt_closes_the_step_without_moving_the_rim).

    `boundaryInset > 0` still selects the old smooth fade, and
    test_boundary_taper_to_zero_at_edge still covers it."""
    n = 5
    pts_arr = np.array([(i, j, 0.0) for j in range(n) for i in range(n)], dtype=float)
    vid = lambda i, j: j * n + i
    tris = []
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)
            tris += [(a, b, c), (a, c, d)]
    taper, _counts, boundary = texture._boundary_taper(pts_arr, tris, inset_mm=0.0)
    for idx in (vid(0, 0), vid(n - 1, 0), vid(0, n - 1), vid(2, 0)):
        assert taper[idx] == 1.0, f"boundary vertex {idx} must carry full depth, got {taper[idx]}"
    assert taper[vid(1, 1)] == 1.0, "the first interior sample should be at full depth, not faded"
    assert len(boundary) == 4 * (n - 1), f"expected the full rim, got {len(boundary)} edges"
    print(PASS, "hard edge: full depth right up to the boundary, no cliff")


def test_skirt_closes_the_step_without_moving_the_rim():
    """The crack-free invariant, now carried by the wall instead of by pinning.

    Two things must hold together: the wall's FOOT lands exactly on the original
    boundary (so a neighbouring untextured face still meets it bit-identically),
    and the wall's top reuses the displaced surface vertices (so no unshared
    edge is introduced — geometrically watertight but index-non-manifold is
    exactly what breaks a 3MF in some slicers)."""
    n = 5
    pts = np.array([(float(i), float(j), 0.0) for j in range(n) for i in range(n)])
    vid = lambda i, j: j * n + i
    tris = []
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)
            tris += [(a, b, c), (a, c, d)]
    _t, _c, boundary = texture._boundary_taper(pts, tris, inset_mm=0.0)
    disp = pts.copy()
    disp[:, 2] += 0.4  # the whole patch lifted, as a full-height pattern would
    out = texture._skirt(pts, disp, boundary)
    assert out is not None, "a lifted boundary must produce a wall"
    feet, _norms, wall = out

    assert np.abs(feet[:, 2]).max() < 1e-15, "the wall's foot must sit exactly on the rim"
    rim = {v for e in boundary for v in e}
    assert len(feet) == len(rim), f"one foot per rim vertex: {len(feet)} vs {len(rim)}"

    # every wall edge shared, except the new outer boundary (the feet ring)
    combined = np.concatenate([disp, feet])
    counts = texture._boundary_edges([tuple(t) for t in np.concatenate([np.asarray(tris), wall])])
    unshared = [k for k, c in counts.items() if c == 1]
    assert unshared, "the mesh must still have an outer boundary"
    for a, b in unshared:
        assert a >= len(disp) and b >= len(disp), \
            "the only unshared edges may be the feet ring — a displaced vertex is exposed"
        assert abs(combined[a][2]) < 1e-15 and abs(combined[b][2]) < 1e-15
    print(PASS, f"skirt: {len(wall)} wall triangles, rim exact, no exposed displaced edge")


def test_faceted_display_splits_creases_but_export_stays_indexed():
    """Hard shading needs unshared vertices (one vertex can carry one normal),
    but de-indexing the EXPORT mesh would leave a 3MF whose shared edges no
    longer share a vertex index — watertight, yet flagged non-manifold by some
    slicers. Display splits; export must not."""
    from tessellate import tessellate

    doc = {"parameters": {}, "features": [
        {"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
        {"id": "t", "type": "texture", "kind": "knurl",
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "depth": 0.4, "scale": 2.0, "angle": 45, "profile": "facet"}]}
    _p, errs, bodies = rebuild(doc)
    assert not errs, errs
    tex = texture.resolve_body_textures(bodies[0])

    norms = []
    d_pos, d_idx, _ = tessellate(bodies[0]["shape"], 0.05, textures=tex, normals_out=norms)
    e_pos, e_idx, _ = tessellate(bodies[0]["shape"], 0.05, textures=tex, normals_out=None)

    assert len(d_idx) == len(e_idx), "crease splitting must not change the TRIANGLE count"
    assert len(d_pos) > len(e_pos), "display should un-share vertices for flat shading"
    # export keeps vertices shared: far fewer than 3 per triangle
    assert len(e_pos) // 3 < len(e_idx), "export mesh must stay indexed for 3MF"
    print(PASS, f"display splits creases ({len(d_pos)//3} verts), export stays indexed ({len(e_pos)//3})")


def test_every_kind_meshes_cleanly_at_the_faceted_default():
    """No kind may crash, go non-manifold, or produce NaNs now that facet is the
    default for all of them."""
    from tessellate import tessellate

    for kind in ("knurl", "hex", "waves", "ribs", "voronoi", "noise"):
        doc = {"parameters": {}, "features": [
            {"id": "b", "type": "box", "length": 20, "width": 20, "height": 10},
            {"id": "t", "type": "texture", "kind": kind,
             "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
             "depth": 0.3, "scale": 2.0, "seed": 3}]}
        _p, errs, bodies = rebuild(doc)
        assert not errs, f"{kind}: {errs}"
        tex = texture.resolve_body_textures(bodies[0])
        assert tex, f"{kind}: texture did not resolve"
        diag = []
        pos, idx, _ = tessellate(bodies[0]["shape"], 0.05, textures=tex, diag=diag, normals_out=[])
        assert np.all(np.isfinite(np.asarray(pos, dtype=float))), f"{kind}: non-finite positions"
        assert len(idx) > 0, f"{kind}: no triangles"
        bad = [d for d in diag if "non-manifold" in str(d.get("reason", ""))]
        assert not bad, f"{kind}: {bad}"
    print(PASS, "every kind meshes cleanly, finite and manifold, at the faceted default")


def test_boundary_ring_is_dense_enough_to_carry_the_pattern():
    """The edge-band bug. _aligned_grid_triangulation used to keep the boundary
    ring VERBATIM from OCCT's base triangulation — on a real filleted part that
    was 20 vertices with an 18mm longest edge against a 2mm pattern period, so
    the strip along the rim had no vertices to undulate with and came out flat
    and smeared however fine the interior got.

    The ring is now subdivided to the sample spacing. The invariant that must
    hold alongside it: every ring vertex still lies EXACTLY on the real face
    (they are lerps along the existing boundary polyline), or the seam against
    the neighbouring face opens a crack."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopLoc import TopLoc_Location
    import OCP.gp as gp

    # a face with a long straight boundary edge, which is where it went wrong
    doc = {"parameters": {}, "features": [
        {"id": "b", "type": "box", "length": 40, "width": 40, "height": 10},
        {"id": "t", "type": "texture", "kind": "knurl",
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "depth": 0.4, "scale": 2.0, "angle": 30, "profile": "facet"}]}
    _p, errs, bodies = rebuild(doc)
    assert not errs, errs
    shape = bodies[0]["shape"]
    BRepMesh_IncrementalMesh(shape.wrapped, 0.05, False, 0.5, True)
    spec, faces = texture.resolve_body_textures(bodies[0])[0]
    face = faces[0]
    scale = float(spec["scale"])
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
    geom = texture._displacement_geometry(
        face, tri, loc, loc.IsIdentity(), spec, scale, max(scale / 4, 0.05),
        texture._DEFAULT_DENSITY_CAP, False,
    )
    pts = geom["pts"]
    idx = np.asarray(geom["flat_indices"]).reshape(-1, 3)
    ec = texture._boundary_edges([tuple(t_) for t_ in idx])
    bnd = [k for k, n in ec.items() if n == 1]
    seg = [float(np.linalg.norm(pts[a] - pts[b])) for a, b in bnd]
    too_long = [x for x in seg if x > scale / 2.0]
    assert not too_long, (
        f"{len(too_long)} boundary edges exceed half a period (longest {max(seg):.2f}mm "
        f"vs period {scale}mm) — the rim cannot carry the pattern"
    )
    # crack-free: the densified ring must stay ON the face, not cut corners
    ring = np.unique(np.asarray(bnd, dtype=np.int64).ravel())
    worst = max(face.distance_to(gp.gp_Pnt(*pts[i])) for i in ring)
    assert worst < 1e-9, f"ring vertex drifted {worst:.2e}mm off the face — that is a crack"
    print(PASS, f"boundary ring subdivided to {max(seg):.2f}mm (period {scale}), still exactly on the face")


def test_a_vanished_texture_face_says_so():
    """A texture spec whose selector stops resolving is still DROPPED — that is
    the same best-effort rule every selector feature follows — but it must now
    announce itself. Dropping it silently means the user gets a green timeline,
    no error, and a smooth STL they only discover after slicing.

    The control is the point: a spec that DOES resolve must record nothing, or
    the _push_diag head gate ("only lossy or low-confidence") has been weakened
    and every confident rebuild starts emitting noise."""
    from build123d import Box
    from texture import resolve_body_textures

    gone = {"feature_id": "tx1", "kind": "knurl",
            "faces": {"kind": "face", "by": "normal", "dir": [0.577, 0.577, 0.577]}}
    diag = []
    out = resolve_body_textures({"shape": Box(20, 20, 20), "name": "B", "_textures": [gone]}, diag)
    assert out == [], "an unresolvable spec is still dropped"
    assert len(diag) == 1, f"the drop must be recorded, got {diag}"
    assert diag[0]["feature_id"] == "tx1" and diag[0]["lossy"] is True, diag[0]
    assert diag[0]["resolved"] == 0, diag[0]

    live = {"feature_id": "tx2", "kind": "knurl",
            "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}
    diag2 = []
    out2 = resolve_body_textures({"shape": Box(20, 20, 20), "name": "B", "_textures": [live]}, diag2)
    assert len(out2) == 1, "a resolving spec must survive"
    assert diag2 == [], f"a resolving spec must stay silent, got {diag2}"
    print(PASS, "a texture whose face vanished records a diagnostic; a live one stays silent")


def _edge_share(positions, indices):
    """(one-sided, over-shared) edge counts for a whole body, welded by POSITION.

    The weld is the point: tessellate() gives every face its own vertex chunk, so
    an index-level count would call every face boundary open. A slicer welds the
    same way, which is why this — not texture._manifold_check, which only ever
    sees one face — is the check that predicts what Orca reports."""
    P = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    _uq, inv = np.unique(np.round(P, 7), axis=0, return_inverse=True)
    W = inv.ravel()[T]
    e = np.sort(np.stack([W[:, [0, 1]], W[:, [1, 2]], W[:, [2, 0]]], axis=1).reshape(-1, 2), axis=1)
    _u, counts = np.unique(e, axis=0, return_counts=True)
    return int((counts == 1).sum()), int((counts > 2).sum())


def _mesh_volume(positions, indices):
    """Divergence-theorem volume — sensitive to a single flipped winding."""
    P = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def test_textured_export_is_watertight():
    """The whole-body invariant a per-face manifold check cannot see.

    A textured face densifies its own boundary ring, so it stops sharing edges
    with the face on the other side and the export leaks T-junctions. Note the
    SINGLE-face case: this is not a textured-vs-textured problem, and a fix that
    only reconciled two textured faces would leave it broken."""
    from build123d import Box, Cylinder

    from tessellate import conform_shared_boundaries

    spec = texture.validate_texture_spec(
        {"id": "t", "kind": "hex", "scale": 2.0, "depth": 0.6, "profile": "facet"})
    cube, cyl = Box(20, 20, 20), Cylinder(10, 20)
    cases = [
        ("cube, every face", cube, list(cube.faces())),
        ("cube, one face", Box(20, 20, 20), [list(Box(20, 20, 20).faces())[0]]),
        ("cylinder, every face", cyl, list(cyl.faces())),
    ]
    for name, shape, faces in cases:
        pos, idx, fids = tessellate(shape, 0.1, textures=[(spec, faces)], density_cap=400_000)
        leaks, _ = _edge_share(pos, idx)
        assert leaks > 0, f"{name}: nothing to fix — has the boundary densification gone?"

        pos2, idx2, fids2 = conform_shared_boundaries(pos, idx, fids)
        after, over = _edge_share(pos2, idx2)
        assert after == 0, f"{name}: {after} one-sided edges survived (was {leaks})"
        assert over == 0, f"{name}: {over} edges shared by more than two triangles"
        assert len(fids2) == len(idx2) // 3, "one face id per triangle, after the split too"
        assert set(np.unique(fids2)) == set(np.unique(fids)), "no face lost its triangles"
        assert abs(_mesh_volume(pos2, idx2) - _mesh_volume(pos, idx)) < 1e-9, \
            f"{name}: the split moved geometry or flipped a winding"
        print(PASS, f"{name}: {leaks} one-sided edges -> 0, volume unchanged")


def test_hair_apart_boundary_vertices_are_merged():
    """Two faces can plant a crossing on the same shared edge a hair apart — the
    charts compute it independently, and 1e-7 mm was measured on a 110mm hex
    plate. Splitting alone can never reconcile that pair: each side inserts a
    copy of the other's point and both edges stay one-sided forever. Found only
    at a million triangles, so it is pinned here on a hand-built mesh instead."""
    from tessellate import conform_shared_boundaries

    hair = 1e-7
    # two fans meeting along x=0, the left one splitting the seam at y=0.5 and
    # the right one at y=0.5+hair
    pos = np.array([
        (0.0, 0.0, 0.0), (0.0, 1.0, 0.0), (-1.0, 0.5, 0.0), (0.0, 0.5, 0.0),
        (1.0, 0.5, 0.0), (0.0, 0.5 + hair, 0.0),
    ])
    idx = np.array([(0, 3, 2), (3, 1, 2), (0, 4, 5), (5, 4, 1)])
    fids = np.array([0, 0, 1, 1])
    before, _ = _edge_share(pos, idx)
    assert before == 8, f"the seam must start out unshared on both sides, got {before}"

    pos2, idx2, _f = conform_shared_boundaries(pos.ravel(), idx.ravel(), fids)
    after, over = _edge_share(pos2, idx2)
    assert over == 0, f"{over} edges shared by more than two triangles"
    assert after == 4, f"only the four outer edges may stay open, got {after}"
    ys = np.asarray(pos2).reshape(-1, 3)[:, 1]
    assert not np.any(np.abs(ys - (0.5 + hair)) < hair / 2), \
        "the hair-apart vertex must be snapped onto its twin, not just re-indexed"
    print(PASS, "boundary vertices 1e-7 apart are merged, not left as a hole")


def _indexed_edges(indices):
    """(one-sided, over-shared) counted on the RAW indices — no welding.

    The distinction this file's other export test missed. A mesh can be closed by
    position and still hand a slicer thousands of edges only one triangle
    references, because tessellate() gives every face its own vertex chunk.
    Orca reported 2986 non-manifold edges on a cube whose surface had no holes."""
    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    e = np.sort(np.stack([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]], axis=1).reshape(-1, 2), axis=1)
    _u, c = np.unique(e, axis=0, return_counts=True)
    return int((c == 1).sum()), int((c > 2).sum())


def test_export_is_manifold_by_index_not_only_by_position():
    """What actually reaches the slicer.

    conform_shared_boundaries closes the surface; weld_vertices makes the INDICES
    say so. Both are needed, and only the second is visible to a reader that does
    not weld on load."""
    from build123d import Box

    from tessellate import open_edge_count, weld_vertices

    spec = texture.validate_texture_spec(
        {"id": "t", "kind": "hex", "scale": 2.0, "depth": 0.6, "profile": "facet"})
    box = Box(20, 20, 20)
    pos, idx, fids = tessellate(box, 0.1, textures=[(spec, list(box.faces()))],
                                density_cap=400_000)
    from tessellate import conform_shared_boundaries
    pos, idx, fids = conform_shared_boundaries(pos, idx, fids)
    assert _edge_share(pos, idx) == (0, 0), "the surface should already be closed"
    before_open, _ = _indexed_edges(idx)
    assert before_open > 0, "nothing to fix — has tessellate started sharing indices?"

    wpos, widx, wfids = weld_vertices(pos, idx, fids)
    assert _indexed_edges(widx) == (0, 0), \
        f"{_indexed_edges(widx)[0]} edges still one-sided by index (was {before_open})"
    assert open_edge_count(widx) == 0, "the export-time check must agree"

    # ...and the model is the same model.
    assert len(widx) == len(idx), "welding must not drop a triangle here"
    assert len(wfids) == len(widx) // 3, "face ids stayed parallel to the triangles"
    assert abs(_mesh_volume(wpos, widx) - _mesh_volume(pos, idx)) < 1e-9, "volume moved"
    a, b = np.asarray(pos).reshape(-1, 3), np.asarray(wpos).reshape(-1, 3)
    assert np.allclose(a.min(0), b.min(0)) and np.allclose(a.max(0), b.max(0)), "bbox moved"
    print(PASS, f"index-level one-sided edges {before_open} -> 0, geometry unchanged")


def test_weld_never_fuses_two_touching_bodies():
    """Why the weld runs per BODY and never on the merged export soup.

    The plain STL/3MF path concatenates every body into one object. Welding after
    that would make two bodies sharing a face into a single shell — and hand the
    slicer edges with four triangles on them, which is a worse complaint than the
    one being fixed."""
    from build123d import Box, Pos

    from tessellate import weld_vertices

    a = Box(10, 10, 10)
    b = Pos(10, 0, 0) * Box(10, 10, 10)  # face-to-face at x = 5
    parts = []
    base = 0
    for solid in (a, b):
        pos, idx, _f = tessellate(solid, 0.1)
        wpos, widx, _w = weld_vertices(pos, idx)          # per body, as the export does
        parts.append((np.asarray(wpos).reshape(-1, 3), np.asarray(widx).reshape(-1, 3) + base))
        base += len(wpos) // 3
    P = np.concatenate([p for p, _ in parts])
    T = np.concatenate([t for _, t in parts])
    assert _indexed_edges(T) == (0, 0), "each body must be closed on its own indices"

    # the control: welding the MERGED soup is what we are avoiding
    _uq, inv = np.unique(np.round(P, 7), axis=0, return_inverse=True)
    fused_over = _indexed_edges(inv.ravel()[T])[1]
    assert fused_over > 0, \
        "the touching faces no longer overlap — pick a arrangement that does, or this proves nothing"
    print(PASS, f"per-body weld keeps two shells; welding the merge would make {fused_over} four-way edges")


def _flipped_edges(indices):
    """Shared edges traversed twice the SAME way — neighbours that disagree about
    which side is out. Orca counts one per triangle, so 478 of these read as 956
    non-manifold edges on a mesh with no holes."""
    from collections import Counter

    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    he = np.stack([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]], axis=1).reshape(-1, 2)
    c = Counter(map(tuple, he))
    return sum(1 for _k, n in c.items() if n >= 2)


def test_orientation_is_restored_from_a_known_good_mesh():
    """The algorithm, against a mesh whose right answer is known exactly.

    An untextured cube meshes consistently and encloses exactly 8000 mm3. Turn a
    third of its triangles inside out and both facts break; the pass has to put
    both back — the propagation for consistency, and the signed-volume rule for
    which way is out. A pass with only the first would happily settle on the
    perfectly consistent, perfectly inside-out answer."""
    from build123d import Box

    from tessellate import orient_consistently, weld_vertices

    pos, idx, _f = tessellate(Box(20, 20, 20), 0.1)
    pos, idx, _f = weld_vertices(pos, idx)
    good = np.asarray(idx, dtype=np.int64).reshape(-1, 3)
    assert _flipped_edges(good) == 0
    assert abs(_mesh_volume(pos, good) - 8000.0) < 1e-9, "the control is not a clean cube"

    rng = np.random.default_rng(7)
    broken = good.copy()
    sel = rng.random(len(broken)) < 0.34
    broken[sel] = broken[sel][:, [0, 2, 1]]
    assert _flipped_edges(broken) > 0, "the sabotage did not take"

    _p, fixed = orient_consistently(pos, broken)
    fixed = np.asarray(fixed, dtype=np.int64).reshape(-1, 3)
    assert _flipped_edges(fixed) == 0, "neighbours still disagree"
    assert abs(_mesh_volume(pos, fixed) - 8000.0) < 1e-9, \
        f"volume {_mesh_volume(pos, fixed):g} — consistent but inside-out"
    print(PASS, f"orientation restored from {int(sel.sum())} flipped triangles, +8000 mm3 again")


def test_orientation_leaves_positions_alone():
    """It reorders indices and nothing else — the shape cannot move."""
    from build123d import Box

    from tessellate import orient_consistently, weld_vertices

    pos, idx, _f = tessellate(Box(12, 8, 5), 0.1)
    pos, idx, _f = weld_vertices(pos, idx)
    out_pos, out_idx = orient_consistently(pos, idx)
    assert np.array_equal(np.asarray(out_pos), np.asarray(pos)), "vertices moved"
    assert sorted(np.asarray(out_idx).reshape(-1, 3).tolist()) != [], "sanity"
    a = np.sort(np.asarray(idx).reshape(-1, 3), axis=1)
    b = np.sort(np.asarray(out_idx).reshape(-1, 3), axis=1)
    assert np.array_equal(np.sort(a, axis=0), np.sort(b, axis=0)), \
        "the triangle SET changed — orientation may only reorder each triple"
    print(PASS, "orientation touches winding only: same vertices, same triangles")


def test_textured_export_has_no_disagreeing_neighbours():
    """The defect behind Orca's 956: texture.py orients each triangle against its
    OWN vertex normals, which says nothing about the neighbour. Measured 1911
    disagreeing edges out of tessellate on a cube that has none untextured."""
    from build123d import Box

    from tessellate import conform_shared_boundaries, orient_consistently, weld_vertices

    spec = texture.validate_texture_spec(
        {"id": "t", "kind": "hex", "scale": 2.0, "depth": 0.6, "profile": "facet"})
    box = Box(20, 20, 20)
    pos, idx, fids = tessellate(box, 0.1, textures=[(spec, list(box.faces()))],
                                density_cap=400_000)
    pos, idx, fids = conform_shared_boundaries(pos, idx, fids)
    pos, idx, fids = weld_vertices(pos, idx, fids)
    before = _flipped_edges(idx)
    assert before > 0, "nothing to fix — did texture.py start orienting by neighbour?"

    pos2, idx2 = orient_consistently(pos, idx)
    assert _flipped_edges(idx2) == 0, f"{_flipped_edges(idx2)} disagreeing edges left (was {before})"
    assert _edge_share(pos2, idx2) == (0, 0), "orientation must not open the surface"
    assert _mesh_volume(pos2, idx2) > 0, "the shell came out inside-out"
    print(PASS, f"disagreeing neighbour edges {before} -> 0 on a textured cube")


def test_conform_leaves_a_clean_mesh_alone():
    """The control. An untextured body is already watertight, and the pass must
    hand it back untouched rather than resample or reorder it."""
    from build123d import Box

    from tessellate import conform_shared_boundaries

    pos, idx, fids = tessellate(Box(20, 20, 20), 0.1)
    assert _edge_share(pos, idx) == (0, 0), "an untextured box is watertight to begin with"
    pos2, idx2, fids2 = conform_shared_boundaries(pos, idx, fids)
    assert np.array_equal(np.asarray(pos2).ravel(), np.asarray(pos, dtype=np.float64))
    assert np.array_equal(np.asarray(idx2).ravel(), np.asarray(idx, dtype=np.int64))
    assert np.array_equal(np.asarray(fids2), np.asarray(fids, dtype=np.int64))
    print(PASS, "a watertight mesh passes through unchanged")


def main():
    print("Surface-texture tests")
    test_validate_texture_spec_rejects_bad_input()
    test_whole_body_knurl_increases_triangles_and_bounds_displacement()
    test_selected_face_only_leaves_other_faces_unchanged()
    test_boundary_taper_to_zero_at_edge()
    test_a_face_only_a_cell_or_two_across_still_carries_the_pattern()
    test_manifold_check_flags_bad_edge_count()
    test_manifold_diagnostic_surfaces_from_displace_face()
    test_cache_key_changes_with_texture_params()
    test_height_field_kinds_in_zero_one_and_angle_rotates()
    test_height_field_image_bilinear()
    test_texture_selector_survives_downstream_fillet()
    test_texture_targets_bound_body_not_active_in_multibody()
    test_missing_image_is_feature_error_not_crash()
    test_faceted_profile_is_piecewise_planar()
    test_knurl_facet_is_min_of_grooves_not_bilinear_product()
    test_terrace_quantises_into_flat_levels()
    test_trapezoid_land_widens_the_flat_top()
    test_hard_edge_keeps_full_depth_to_the_boundary()
    test_skirt_closes_the_step_without_moving_the_rim()
    test_faceted_display_splits_creases_but_export_stays_indexed()
    test_every_kind_meshes_cleanly_at_the_faceted_default()
    test_boundary_ring_is_dense_enough_to_carry_the_pattern()
    test_a_vanished_texture_face_says_so()
    test_textured_export_is_watertight()
    test_hair_apart_boundary_vertices_are_merged()
    test_export_is_manifold_by_index_not_only_by_position()
    test_weld_never_fuses_two_touching_bodies()
    test_orientation_is_restored_from_a_known_good_mesh()
    test_orientation_leaves_positions_alone()
    test_textured_export_has_no_disagreeing_neighbours()
    test_conform_leaves_a_clean_mesh_alone()
    print("ALL PASS")


if __name__ == "__main__":
    main()
