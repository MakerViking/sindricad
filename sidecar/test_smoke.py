"""Backend smoke test — exercises rebuild/tessellate/selectors/export directly
(no WebSocket) so failures point straight at the geometry code.

Run:  uv run python test_smoke.py
"""

import os
import tempfile

from builder import rebuild, import_geometry
from tessellate import tessellate, tessellate_bodies, edge_polylines, bbox
from exporters import export

# The §2 example: a bracket with two holes and a filleted vertical edge.
EXAMPLE = {
    "parameters": {"width": 40, "height": 20, "thickness": 5, "hole_d": 6},
    "features": [
        {
            "id": "f1",
            "type": "sketch",
            "plane": "XY",
            "entities": [
                {"type": "rectangle", "width": "width", "height": "height", "x": 0, "y": 0}
            ],
        },
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": "thickness", "operation": "new"},
        {
            "id": "f3",
            "type": "sketch",
            "plane": "XY",
            "entities": [{"type": "circle", "radius": 3, "x": -12, "y": 0}],
        },
        {"id": "f4", "type": "extrude", "sketch": "f3", "distance": "thickness", "operation": "cut"},
        {"id": "f5", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 2},
    ],
}


def test_rebuild():
    part, errors, bodies = rebuild(EXAMPLE)
    assert not errors, f"unexpected errors: {errors}"
    assert part is not None
    assert len(bodies) == 1, f"expected one body, got {len(bodies)}"

    pos, idx, fids = tessellate(part, 0.1)
    assert len(pos) > 0 and len(pos) % 3 == 0, "positions malformed"
    assert len(idx) > 0 and len(idx) % 3 == 0, "indices malformed"
    assert len(fids) == len(idx) // 3, "one faceId per triangle expected"
    assert max(idx) < len(pos) // 3, "index out of range"

    edges = edge_polylines(part)
    assert len(edges) > 0
    bb = bbox(part)
    assert bb["max"][0] > bb["min"][0]
    print(f"  rebuild OK: {len(pos)//3} verts, {len(idx)//3} tris, "
          f"{len(set(fids))} faces, {len(edges)} edges")
    return part


def test_error_naming():
    """An over-large fillet radius must fail and name the offending feature."""
    doc = {
        "parameters": {},
        "features": [
            {"id": "s", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "width": 10, "height": 10}]},
            {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"},
            {"id": "bad", "type": "fillet",
             "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 100},
        ],
    }
    part, errors, _bodies = rebuild(doc)
    assert errors, "expected a fillet failure"
    assert errors[0]["feature_id"] == "bad", f"wrong feature flagged: {errors[0]}"
    print(f"  error-naming OK: flagged feature '{errors[0]['feature_id']}'")


def test_exports():
    part, errors, _bodies = rebuild(EXAMPLE)
    assert not errors
    d = tempfile.mkdtemp()
    for fmt in ("step", "stl", "3mf"):
        p = os.path.join(d, f"part.{fmt}")
        export(part, fmt, p)
        assert os.path.exists(p) and os.path.getsize(p) > 0, f"{fmt} export empty"
    print(f"  export OK: step/stl/3mf written to {d}")


def _box(idx, w, h, depth, x=0, y=0, op="new"):
    """Two features (sketch + extrude) that build a w×h×depth box at (x,y)."""
    s, e = f"s{idx}", f"e{idx}"
    return s, [
        {"id": s, "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]},
        {"id": e, "type": "extrude", "sketch": s, "distance": depth, "operation": op},
    ]


def test_import_roundtrip():
    """Export a box to STL/STEP, import_geometry it, and rebuild a document with an
    `import` feature — the imported body must survive the BREP round-trip."""
    _s, feats = _box(1, 20, 20, 10)
    part, _err, _b = rebuild({"parameters": {}, "features": feats})
    d = tempfile.mkdtemp()
    for fmt in ("stl", "step"):
        p = os.path.join(d, f"box.{fmt}")
        export(part, fmt, p)
        payload = import_geometry(p, fmt)
        assert "error" not in payload, payload
        assert payload["solid"], f"{fmt} import should yield a solid"
        assert payload["brep"], "no BREP produced"
        # a clean box must come back as 6 faces — proves coplanar-facet merging
        # (UnifySameDomain) recovers real editable faces, not a triangle soup.
        assert payload["faces"] == 6, f"{fmt} box should merge to 6 faces, got {payload['faces']}"
        doc = {"parameters": {}, "features": [
            {"id": "imp", "type": "import", "format": fmt, "name": payload["name"], "brep": payload["brep"]}
        ]}
        ipart, ierr, ibodies = rebuild(doc)
        assert not ierr, ierr
        assert ipart is not None and len(ibodies) == 1
        assert ipart.volume > 100, f"{fmt} imported body has no volume"
        print(f"  import OK ({fmt}): 1 body, vol {ipart.volume:.0f}, {payload['faces']} faces")


def test_split():
    """Split a 20×20×20 box (z=0..20) by a z=10 datum plane: both → two bodies,
    top → one half. (Plane.XY at z=0 only grazes the base, so we cut at mid-height.)"""
    mid = {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]}
    _s, feats = _box(1, 20, 20, 20)
    doc = {"parameters": {}, "features": feats + [
        {"id": "sp", "type": "split", "plane": mid, "keep": "both"}
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 2, f"split both should make 2 bodies, got {len(bodies)}"

    doc["features"][-1] = {"id": "sp", "type": "split", "plane": mid, "keep": "top"}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1
    assert 3500 < part.volume < 4500, f"top half should be ~4000 mm^3, got {part.volume:.0f}"
    print(f"  split OK: both→2 bodies, top→1 body vol {part.volume:.0f}")


def test_combine():
    """Two overlapping boxes combined via join / cut / intersect."""
    _s1, a = _box(1, 20, 20, 20)
    _s2, b = _box(2, 10, 10, 20)  # smaller box, fully inside A's footprint
    base = {"parameters": {}, "features": a + b}  # body1 (big) + body2 (small)
    results = {}
    for op in ("join", "cut", "intersect"):
        doc = {"parameters": {}, "features": a + b + [
            {"id": "cb", "type": "combine", "operation": op, "target": "body1", "tools": ["body2"]}
        ]}
        part, err, bodies = rebuild(doc)
        assert not err, f"{op}: {err}"
        assert len(bodies) == 1, f"{op}: tool body should be consumed, got {len(bodies)} bodies"
        results[op] = part.volume
    # big=8000, small=2000 inside it: join=8000, cut=6000, intersect=2000
    assert abs(results["intersect"] - 2000) < 200, results
    assert abs(results["cut"] - 6000) < 200, results
    assert results["join"] > results["cut"], results
    print(f"  combine OK: join {results['join']:.0f}, cut {results['cut']:.0f}, "
          f"intersect {results['intersect']:.0f}")


def test_datum_and_bodies_tessellation():
    """A datum plane is referenceable by a sketch; tessellate_bodies tags faces."""
    doc = {"parameters": {}, "features": [
        {"id": "dp", "type": "datumPlane", "plane": {
            "origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "name": "Datum1"},
        {"id": "s", "type": "sketch", "plane": "dp",
         "entities": [{"type": "rectangle", "width": 10, "height": 10}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert part is not None and len(bodies) == 1
    bb = bbox(part)
    assert bb["min"][2] > 9.5, f"sketch on datum z=10 should sit above z=10, got {bb['min'][2]}"
    pos, idx, fids, meta = tessellate_bodies(bodies)
    assert len(meta) == 1 and meta[0]["faceCount"] > 0
    assert len(fids) == len(idx) // 3
    print(f"  datum+tessellate OK: body on z=10 datum, {meta[0]['faceCount']} faces")


def test_datum_offset_and_split_by_id():
    """A datumPlane with an `offset` shifts along its normal; a split can cut by
    that datum via `planeId` (so editing the offset re-cuts the body)."""
    _s, feats = _box(1, 20, 20, 20)  # z = 0..20
    # XY base plane raised 10mm (offset), then split the box by the datum's id
    doc = {"parameters": {}, "features": feats + [
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 10},
        {"id": "sp", "type": "split", "planeId": "dp", "keep": "both"},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 2, f"offset-datum split both → 2 bodies, got {len(bodies)}"

    # raise the offset to 15 and keep the top: a thin 5mm slab (~2000 mm^3)
    doc["features"][-2]["offset"] = 15
    doc["features"][-1] = {"id": "sp", "type": "split", "planeId": "dp", "keep": "top"}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1
    assert 1500 < part.volume < 2500, f"top of z=15 cut should be ~2000 mm^3, got {part.volume:.0f}"
    print(f"  datum-offset + split-by-id OK: offset 10→2 bodies, 15/top vol {part.volume:.0f}")


def test_split_all_and_move_bodies():
    """`split.bodies` cuts each listed body ("cut all visible"); `move.bodies`
    translates only the listed bodies, leaving the rest put."""
    _s1, a = _box(1, 20, 20, 20)        # body1: z=0..20 at origin
    _s2, b = _box(2, 20, 20, 20, x=40)  # body2: z=0..20 at x=40 (separate)
    doc = {"parameters": {}, "features": a + b + [
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 10},
        {"id": "sp", "type": "split", "planeId": "dp", "keep": "both",
         "bodies": ["body1", "body2"]},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 4, f"cutting 2 bodies (keep both) → 4 bodies, got {len(bodies)}"

    # move ONLY body1 up +50 in Z; body2 must stay put
    doc2 = {"parameters": {}, "features": a + b + [
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 50,
         "rx": 0, "ry": 0, "rz": 0, "bodies": ["body1"]},
    ]}
    part, err, bodies = rebuild(doc2)
    assert not err, err
    assert len(bodies) == 2
    bb1 = bbox(next(x for x in bodies if x["id"] == "body1")["shape"])
    bb2 = bbox(next(x for x in bodies if x["id"] == "body2")["shape"])
    assert bb1["min"][2] > 49, f"moved body1 should sit above z=49, got {bb1['min'][2]}"
    assert bb2["min"][2] < 1, f"body2 should stay at z~0, got {bb2['min'][2]}"
    print(f"  split-all + move-bodies OK: 2 cuts→4 bodies; moved body1 z_min {bb1['min'][2]:.0f}")


def test_presspull_targets_owning_body():
    """press-pull modifies the body that OWNS the picked face (via `body`), not
    just the active (last-created) body."""
    _s1, a = _box(1, 20, 20, 10)        # body1: z=0..10 (NOT the active body)
    _s2, b = _box(2, 20, 20, 10, x=40)  # body2: z=0..10 at x=40, active (last)
    doc = {"parameters": {}, "features": a + b + [
        {"id": "pp", "type": "press-pull",
         "face": {"kind": "face", "by": "nearest", "point": [0, 0, 10]},
         "distance": 5, "operation": "join", "body": "body1"},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    bb1 = bbox(next(x for x in bodies if x["id"] == "body1")["shape"])
    bb2 = bbox(next(x for x in bodies if x["id"] == "body2")["shape"])
    assert bb1["max"][2] > 14, f"body1 should grow to z~15, got {bb1['max'][2]}"
    assert bb2["max"][2] < 11, f"body2 (active) must stay z~10, got {bb2['max'][2]}"
    print(f"  press-pull targets owning body OK: body1 z_max {bb1['max'][2]:.0f}, body2 {bb2['max'][2]:.0f}")


def test_primitives():
    """Box / Cylinder / Sphere create independent bodies; a cylinder cut into a box
    via Combine makes a hole (the primitive-as-tool-body workflow)."""
    doc = {"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "cy", "type": "cylinder", "radius": 5, "height": 30},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 2, f"box + cylinder = 2 bodies, got {len(bodies)}"
    doc["features"].append({"id": "cb", "type": "combine", "operation": "cut", "target": "body1", "tools": ["body2"]})
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1
    # 8000 box minus a r5×20-deep through-hole (~1571) ≈ 6429
    assert 6200 < part.volume < 6700, f"box with a drilled hole ≈ 6429, got {part.volume:.0f}"
    sp, serr, sb = rebuild({"parameters": {}, "features": [{"id": "s", "type": "sphere", "radius": 8}]})
    assert not serr and 2000 < sp.volume < 2300, f"sphere r8 ≈ 2145, got {sp.volume:.0f}"
    print(f"  primitives OK: box−cylinder hole vol {part.volume:.0f}, sphere vol {sp.volume:.0f}")


def test_modify_tools():
    """Shell (hollow), rectangular + circular pattern, and draft on a box."""
    _s, base = _box(1, 20, 20, 20)  # 20³ box, z=0..20
    # shell: open the top (+Z) face, 2mm wall -> hollow (< 8000)
    doc = {"parameters": {}, "features": base + [
        {"id": "sh", "type": "shell", "thickness": 2, "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}]}
    p, e, _ = rebuild(doc)
    assert not e, e
    assert 2500 < p.volume < 5000, f"shelled box should be hollow, got {p.volume:.0f}"
    shell_vol = p.volume
    # rectangular pattern: 3×1 of the box -> 3 disjoint solids
    doc = {"parameters": {}, "features": base + [
        {"id": "pr", "type": "patternRect", "countX": 3, "countY": 1, "spacingX": 40, "spacingY": 40}]}
    p, e, _ = rebuild(doc)
    assert not e, e
    assert len(p.solids()) == 3, f"3×1 pattern should give 3 solids, got {len(p.solids())}"
    # circular pattern: 4 offset cubes around Z
    _s2, off = _box(2, 4, 4, 8, x=12)
    doc = {"parameters": {}, "features": off + [
        {"id": "pc", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z"}]}
    p, e, _ = rebuild(doc)
    assert not e, e
    assert len(p.solids()) == 4, f"circular pattern of 4, got {len(p.solids())}"
    # draft: taper a +X side face by 10° -> volume changes, stays a valid solid
    doc = {"parameters": {}, "features": base + [
        {"id": "dr", "type": "draft", "angle": 10, "axis": "Z", "faces": {"kind": "face", "by": "normal", "dir": [1, 0, 0]}}]}
    p, e, _ = rebuild(doc)
    assert not e, e
    assert 6000 < p.volume < 8000 and len(p.faces()) == 6, f"drafted box: vol {p.volume:.0f}, faces {len(p.faces())}"
    print(f"  modify-tools OK: shell {shell_vol:.0f}, rect×3, circular×4, draft {p.volume:.0f}")


def test_simplify_mesh():
    """Importing a dense cylinder mesh then Simplify Mesh cuts the facet count
    (near-coplanar walls merge) while the volume is preserved within tolerance."""
    from build123d import Cylinder
    d = tempfile.mkdtemp()
    p = os.path.join(d, "cyl.stl")
    export(Cylinder(6, 20), "stl", p)
    payload = import_geometry(p, "stl")
    doc = {"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "cyl", "brep": payload["brep"]}]}
    base, e0, _ = rebuild(doc)
    f_before = len(base.faces())
    doc["features"].append({"id": "sm", "type": "simplifyMesh", "tolerance": 15})
    simp, e1, _ = rebuild(doc)
    f_after = len(simp.faces())
    assert not e0 and not e1, (e0, e1)
    assert f_after < f_before, f"simplify should reduce faces ({f_before}→{f_after})"
    assert abs(simp.volume - base.volume) / base.volume < 0.1, "volume should stay close"
    print(f"  simplify-mesh OK: cylinder {f_before}→{f_after} faces, vol {simp.volume:.0f}")


def test_sweep():
    """Sweep a circle profile (XY) along an arc path (XZ) — a smooth pipe."""
    doc = {"parameters": {}, "features": [
        {"id": "prof", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "radius": 2}]},
        {"id": "path", "type": "sketch", "plane": "XZ", "entities": [
            {"type": "arc", "x1": 0, "y1": 0, "mx": 5, "my": 12, "x2": 18, "y2": 18}]},
        {"id": "sw", "type": "sweep", "profile": "prof", "path": "path", "operation": "new"}]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1 and part.volume > 100, f"swept pipe should have volume, got {part.volume:.0f}"
    print(f"  sweep OK: arc pipe vol {part.volume:.0f}, {len(part.faces())} faces")


def test_scale_and_move():
    """Scale grows the body by factor³; Move translates + rotates it."""
    _s, base = _box(1, 10, 10, 10)  # 10³ box = 1000 mm³, z=0..10
    sc = {"parameters": {}, "features": base + [{"id": "sc", "type": "scale", "factor": 2}]}
    p, e, _ = rebuild(sc)
    assert not e and abs(p.volume - 8000) < 50, f"scale×2 → 8000, got {p.volume:.0f}"
    mv = {"parameters": {}, "features": base + [
        {"id": "mv", "type": "move", "dx": 25, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0}]}
    p, e, _ = rebuild(mv)
    assert not e and bbox(p)["min"][0] > 14, f"move +25X should shift bbox, got {bbox(p)['min'][0]:.0f}"
    print(f"  scale+move OK: scale×2 vol 8000, move +25X → x_min {bbox(p)['min'][0]:.0f}")


def test_multibody_import_and_guards():
    """A two-object file imports as TWO separate bodies; an organic mesh is
    rejected with a clear message instead of timing out."""
    from build123d import Box, Pos, Sphere
    d = tempfile.mkdtemp()
    two = Box(10, 10, 10) + Pos(30, 0, 0) * Box(10, 10, 10)
    for fmt in ("stl", "3mf"):
        p = os.path.join(d, f"two.{fmt}")
        export(two, fmt, p)
        pay = import_geometry(p, fmt)
        doc = {"parameters": {}, "features": [
            {"id": "im", "type": "import", "format": fmt, "name": pay["name"], "brep": pay["brep"]}]}
        part, e, bodies = rebuild(doc)
        assert not e and len(bodies) == 2, f"{fmt} two-object import → {len(bodies)} bodies, want 2"
    sp = os.path.join(d, "sphere.stl")
    export(Sphere(20), "stl", sp)
    try:
        import_geometry(sp, "stl")
        assert False, "organic sphere should be rejected"
    except ValueError as ex:
        assert "clean editable" in str(ex) or "dense" in str(ex), ex
    print("  multibody-import OK: 2-object STL+3MF → 2 bodies each; organic mesh rejected cleanly")


if __name__ == "__main__":
    print("SindriCAD sidecar smoke test")
    test_rebuild()
    test_error_naming()
    test_exports()
    test_import_roundtrip()
    test_split()
    test_combine()
    test_datum_and_bodies_tessellation()
    test_datum_offset_and_split_by_id()
    test_split_all_and_move_bodies()
    test_presspull_targets_owning_body()
    test_primitives()
    test_modify_tools()
    test_simplify_mesh()
    test_sweep()
    test_scale_and_move()
    test_multibody_import_and_guards()
    print("ALL PASS")
