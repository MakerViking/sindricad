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

    taper, edge_count = texture._boundary_taper(pts_arr, tris, inset_mm=1.0)
    for idx in (vid(0, 0), vid(n - 1, 0), vid(0, n - 1), vid(n - 1, n - 1)):
        assert taper[idx] < 1e-9, f"boundary vertex {idx} should taper to exactly 0, got {taper[idx]}"
    center = vid(n // 2, n // 2)
    assert taper[center] > 0.99, f"interior vertex 2mm from every edge should reach full height, got {taper[center]}"
    print(PASS, "boundary taper is exactly zero at face-boundary vertices, full height in the interior")


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
    ent1 = server._body_payload(b, 0.1)
    b["_textures"] = [texture.validate_texture_spec(
        {"kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0}
    )]
    ent2 = server._body_payload(b, 0.1)

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

    # no body → require_active fallback lands on body2 (the last one built)
    part, errors, bodies = rebuild({"parameters": {}, "features": feats + [
        {"id": "tex", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0, "faces": sel}]})
    assert not errors, errors
    by_id = {b["id"]: b for b in bodies}
    assert by_id["body2"].get("_textures") and not by_id["body1"].get("_textures"), \
        "sanity: without `body`, the texture wrongly lands on the active (last) body"

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


def main():
    print("Surface-texture tests")
    test_validate_texture_spec_rejects_bad_input()
    test_whole_body_knurl_increases_triangles_and_bounds_displacement()
    test_selected_face_only_leaves_other_faces_unchanged()
    test_boundary_taper_to_zero_at_edge()
    test_manifold_check_flags_bad_edge_count()
    test_manifold_diagnostic_surfaces_from_displace_face()
    test_cache_key_changes_with_texture_params()
    test_height_field_kinds_in_zero_one_and_angle_rotates()
    test_height_field_image_bilinear()
    test_texture_selector_survives_downstream_fillet()
    test_texture_targets_bound_body_not_active_in_multibody()
    test_missing_image_is_feature_error_not_crash()
    print("ALL PASS")


if __name__ == "__main__":
    main()
