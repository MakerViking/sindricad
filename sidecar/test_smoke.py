"""Backend smoke test — exercises rebuild/tessellate/selectors/export directly
(no WebSocket) so failures point straight at the geometry code.

Run:  uv run python test_smoke.py
"""

import os
import math
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


def test_combine_dangling_ref():
    """A combine whose tool/target was already consumed by an earlier combine is a
    NON-FATAL no-op recorded in diagnostics (not a build-halting error) — so a
    stale duplicate (positional-id drift) can't nuke the whole downstream timeline."""
    _s1, a = _box(1, 20, 20, 20)
    _s2, b = _box(2, 10, 10, 20)
    cb1 = {"id": "cb1", "type": "combine", "operation": "join", "target": "body1", "tools": ["body2"]}
    cb2 = {"id": "cb2", "type": "combine", "operation": "join", "target": "body1", "tools": ["body2"]}  # body2 already gone
    diag = []
    part, err, bodies = rebuild({"parameters": {}, "features": a + b + [cb1, cb2]}, diagnostics=diag)
    assert not err, f"dangling combine should not error, got {err}"
    assert len(bodies) == 1, f"expected 1 body after join, got {len(bodies)}"
    skips = [d for d in diag if d.get("kind") == "combine" and d.get("feature_id") == "cb2"]
    assert skips and skips[0]["lossy"], f"cb2 should be recorded as a skipped combine, got {diag}"
    # a dangling target is handled too (target consumed → no-op, no error)
    cb3 = {"id": "cb3", "type": "combine", "operation": "join", "target": "body2", "tools": ["body1"]}
    part2, err2, _ = rebuild({"parameters": {}, "features": a + b + [cb1, cb3]}, diagnostics=None)
    assert not err2, f"dangling-target combine should not error, got {err2}"
    print(f"  combine dangling-ref OK: cb2 skipped via diagnostics, no build halt")


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


def test_presspull_multiface():
    """press-pull with a LIST of face selectors pushes each face by the same
    distance along its own normal, in one feature (re-resolving per face)."""
    _s, a = _box(1, 20, 20, 10)  # z=0..10
    doc = {"parameters": {}, "features": a + [
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 5,
         "face": [
             {"kind": "face", "by": "normal", "dir": [0, 0, 1]},   # top  +5
             {"kind": "face", "by": "normal", "dir": [0, 0, -1]},  # bottom +5
         ]},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    bb = bbox(part)
    assert bb["min"][2] < -4 and bb["max"][2] > 14, f"both faces should grow z to -5..15, got {bb['min'][2]:.1f}..{bb['max'][2]:.1f}"
    assert abs(part.volume - 8000) < 1, f"expected 20*20*20=8000, got {part.volume:.0f}"
    print(f"  press-pull multi-face OK: z {bb['min'][2]:.0f}..{bb['max'][2]:.0f}, vol {part.volume:.0f}")


def test_sketch_patterns():
    """A sketch pattern definition expands to derived entities at build time: a
    bolt-circle of 6 holes cut through a disk, and a 3x2 rect pattern of a circle."""
    disk = {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [{"id": "e0", "type": "circle", "radius": 30, "x": 0, "y": 0}]},
        {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": "XY", "entities": [],
         "patterns": [{"id": "p1", "type": "boltCircle", "cx": 0, "cy": 0, "bcd": 40, "count": 6, "diameter": 6}]},
        {"id": "cut", "type": "extrude", "sketch": "s2", "distance": 5, "operation": "cut"},
    ]}
    part, err, bodies = rebuild(disk)
    assert not err, err
    # disk pi*30^2*5=14137 minus 6 holes r3: 6*pi*9*5=848 -> ~13289
    assert abs(part.volume - 13289) < 30, f"bolt-circle holes wrong, vol {part.volume:.0f}"
    assert len(part.faces()) == 9, f"expected top+bottom+outer+6 holes = 9 faces, got {len(part.faces())}"

    grid = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [{"id": "c0", "type": "circle", "radius": 2, "x": 0, "y": 0}],
         "patterns": [{"id": "pr", "type": "patternRect", "sources": ["c0"], "countX": 3, "countY": 2, "spacingX": 10, "spacingY": 10}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 3, "operation": "new"},
    ]}
    p2, e2, b2 = rebuild(grid)
    assert not e2, e2
    assert len(p2.solids()) == 6, f"3x2 rect pattern should give 6 disks, got {len(p2.solids())}"
    print(f"  sketch patterns OK: bolt-circle {len(part.faces())} faces, rect pattern {len(p2.solids())} solids")


def test_presspull_upto():
    """press-pull `upTo` extrudes a face up to a target surface — the sidecar derives
    the per-face distance from the target plane (here a low step face → a higher one)."""
    doc = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 10},  # body1 z-5..5
        {"id": "b2", "type": "box", "length": 8, "width": 8, "height": 10},    # body2 z-5..5
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 10, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
        {"id": "cb", "type": "combine", "operation": "join", "target": "body1", "tools": ["body2"]},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": {"kind": "face", "by": "nearest", "point": [-8, -8, 5]},   # the low top step
         "upTo": {"kind": "face", "by": "nearest", "point": [0, 0, 15]}},   # extrude up to the high top
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    bb = bbox(part)
    assert abs(bb["max"][2] - 15) < 0.5, f"low face should rise to z=15, got {bb['max'][2]}"
    assert abs(part.volume - 8000) < 5, f"expected a full 20x20x20=8000, got {part.volume:.0f}"
    print(f"  press-pull up-to OK: z_max {bb['max'][2]:.0f}, vol {part.volume:.0f}")


def test_extrude_operation_multibody():
    """extrude `join` booleans against EVERY body it overlaps (MCAD-style) so a
    bridging extrude merges them; `new` keeps the extrude as a separate body."""
    _s1, a = _box(1, 20, 20, 10)  # body1: x=-10..10, z=0..10
    s2 = {"id": "s2", "type": "sketch", "plane": "XY",
          "entities": [{"type": "rectangle", "width": 10, "height": 10, "x": 5}]}  # overlaps body1
    # distance 20 protrudes above body1's z=10 top, so the join both ADDS material
    # and merges the overlap into one body (a distance-10 prism would sit entirely
    # inside body1 — a legitimate no-op now flagged by the boolean guard).
    join = {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 20, "operation": "join"}
    part, err, bodies = rebuild({"parameters": {}, "features": a + [s2, join]})
    assert not err, err
    assert len(bodies) == 1, f"join should merge overlapping bodies → 1, got {len(bodies)}"

    new = {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 10, "operation": "new"}
    part, err, bodies = rebuild({"parameters": {}, "features": a + [s2, new]})
    assert not err, err
    assert len(bodies) == 2, f"new body should stay separate → 2, got {len(bodies)}"
    print("  extrude operation OK: join→1 merged body, new→2 separate bodies")


def test_extrude_noop_guards():
    """A boolean that changes nothing is flagged, not silently swallowed: a Join
    whose prism is already inside the body, a Cut/Intersect that meets no material,
    and an Intersect that would EMPTY a body all record a feature error (so the
    timeline flags it red) and leave the body intact — while the interacting
    directions still succeed. Regression for 'I extruded a face and nothing
    happened, with no error'."""
    _s, base = _box(1, 40, 40, 20)  # body1: z=0..20, vol 32000
    # a 10×10 profile sketched ON the top face (z=20), normal +Z (outward)
    top = {"id": "s2", "type": "sketch",
           "plane": {"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
           "entities": [{"id": "r", "type": "rectangle", "width": 10, "height": 10, "x": 0, "y": 0}]}
    reg = [[0, 0, 20]]  # region point on the top face

    def run(op, dist):
        ex = {"id": "x", "type": "extrude", "sketch": "s2", "distance": dist,
              "operation": op, "regions": reg}
        _p, err, bodies = rebuild({"parameters": {}, "features": base + [top, ex]})
        vol = bodies[0]["shape"].volume if bodies and bodies[0].get("shape") else None
        return err, vol

    # interacting directions still work, no error
    err, vol = run("join", +5)
    assert not err and abs(vol - 32500) < 1, f"join out should add a boss: {err}, {vol}"
    err, vol = run("cut", -5)
    assert not err and abs(vol - 31500) < 1, f"cut into body should pocket: {err}, {vol}"
    err, vol = run("intersect", -5)
    assert not err and abs(vol - 500) < 1, f"intersect into body keeps overlap: {err}, {vol}"

    # no-op / destructive directions: flagged AND body left intact
    for op, dist, needle in (
        ("join", -5, "already inside"),
        ("cut", +5, "removed nothing"),
        ("intersect", +5, "leave the body empty"),
    ):
        err, vol = run(op, dist)
        assert err and err[0]["feature_id"] == "x", f"{op} {dist:+d} should flag a feature error, got {err}"
        assert needle in err[0]["message"], f"{op} {dist:+d} message: {err[0]['message']}"
        assert abs(vol - 32000) < 1, f"{op} {dist:+d} must leave the body intact (32000), got {vol}"
    print("  extrude no-op guards OK: join-inside / cut-nothing / intersect-empty "
          "flagged + body intact; interacting dirs still build")


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


def test_interference():
    """Two overlapping boxes (separate bodies) report one clash with the right
    overlap volume; clear of each other they report none."""
    from server import _interference_job

    _s1, a = _box(1, 20, 20, 20, 0, 0, "new")
    _s2, b = _box(3, 20, 20, 20, 10, 10, "new")
    res = _interference_job({"parameters": {}, "features": a + b})
    assert "error" not in res, res
    pairs = res["pairs"]
    assert len(pairs) == 1, f"expected 1 clash, got {len(pairs)} ({pairs})"
    assert abs(pairs[0]["volume"] - 2000) < 1, f"overlap vol {pairs[0]['volume']}, want ~2000"

    _s3, c = _box(3, 20, 20, 20, 40, 40, "new")
    res2 = _interference_job({"parameters": {}, "features": a + c})
    assert "error" not in res2, res2
    assert len(res2["pairs"]) == 0, f"disjoint boxes should not clash, got {res2['pairs']}"
    print(f"  interference OK: 1 clash (vol {pairs[0]['volume']:.0f} mm³); disjoint → 0")


def test_remove_body():
    """removeBody drops a body from the model: two separate boxes (body1, body2)
    + a removeBody of body2 → only body1 remains."""
    _s1, a = _box(1, 20, 20, 20, 0, 0, "new")
    _s2, b = _box(3, 20, 20, 20, 40, 0, "new")
    doc = {"parameters": {}, "features": a + b + [
        {"id": "rm", "type": "removeBody", "bodies": ["body2"]},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 1, f"removeBody should leave 1 body, got {len(bodies)}"
    assert bodies[0]["id"] == "body1", f"wrong body kept: {bodies[0]['id']}"
    print(f"  remove-body OK: 2 bodies → removeBody body2 → 1 body")


def test_sketch_crossing_split():
    """Sketch profiles split at CROSSINGS and vertex-touches via the planar
    arrangement (builder._subdivide_faces / src/sketch/region.ts), so a line
    crossing a profile carves separately-extrudable sub-areas (MCAD parity), and
    a honeycomb hexagon whose corner sits on a boundary rectangle extrudes as its
    true CLIPPED region — not the whole hexagon."""
    sq = [(0, 0, 10, 0), (10, 0, 10, 10), (10, 10, 0, 10), (0, 10, 0, 0)]

    def _lines(segs):
        return [{"id": f"l{i}", "type": "line", "x1": a, "y1": b, "x2": c, "y2": d}
                for i, (a, b, c, d) in enumerate(segs)]

    # X in a square -> 4 triangles; extrude one quadrant = 25 * 5 = 125
    xsq = {"id": "s1", "type": "sketch", "plane": "XY",
           "entities": _lines(sq + [(0, 0, 10, 10), (0, 10, 10, 0)])}
    part, err, _ = rebuild({"parameters": {}, "features": [xsq,
        {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new",
         "regions": [[6.67, 3.33, 0]]}]})
    assert not err, err
    assert abs(part.volume - 125) < 1, f"one quadrant of an X-square = 125, got {part.volume:.1f}"

    # a line crossing the square splits it; extrude the top half = 50 * 4 = 200
    cl = {"id": "s1", "type": "sketch", "plane": "XY", "entities": _lines(sq + [(-3, 5, 13, 5)])}
    part, err, _ = rebuild({"parameters": {}, "features": [cl,
        {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 4, "operation": "new",
         "regions": [[5, 7.5, 0]]}]})
    assert not err, err
    assert abs(part.volume - 200) < 1, f"top half of a split square = 200, got {part.volume:.1f}"

    # honeycomb panel: a rectangle with hexagons. The hexagon centered at (15, 8.66)
    # sits ON the right rect edge (a vertex-on-edge T-junction) — it must extrude as
    # a HALF hexagon (32.48 * 2 = 64.95), NOT the full hexagon (would be ~130).
    def _hexlines(cx, cy, R):
        v = [(cx + R * math.cos(math.pi / 6 + k * math.pi / 3),
              cy + R * math.sin(math.pi / 6 + k * math.pi / 3)) for k in range(6)]
        return [(v[k][0], v[k][1], v[(k + 1) % 6][0], v[(k + 1) % 6][1]) for k in range(6)]
    segs = []
    for q in range(-2, 3):
        for r in range(max(-2, -q - 2), min(2, -q + 2) + 1):
            segs += _hexlines(10 * (q + r / 2), 10 * math.sqrt(3) / 2 * r, 5)
    ents = [{"id": "R", "type": "rectangle", "x": 0, "y": 0, "width": 30, "height": 30}]
    ents += [{"id": f"h{i}", "type": "line", "x1": a, "y1": b, "x2": c, "y2": d}
             for i, (a, b, c, d) in enumerate(segs)]
    panel = {"id": "s1", "type": "sketch", "plane": "XY", "entities": ents}
    part, err, _ = rebuild({"parameters": {}, "features": [panel,
        {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 2, "operation": "new",
         "regions": [[13.5, 8.66, 0]]}]})
    assert not err, err
    assert abs(part.volume - 64.95) < 1, \
        f"boundary hexagon should extrude clipped (~65), got {part.volume:.1f}"
    print(f"  sketch crossing-split OK: X-quadrant 125, split-half 200, clipped boundary hex {part.volume:.1f}")


def test_extrude_cut_disjoint():
    """A CUT extrude of several DISJOINT regions (e.g. honeycomb cells) removes
    material from EVERY body in its path. The disjoint extrude is a build123d
    ShapeList — regression for "'ShapeList' object has no attribute 'bounding_box'"
    which silently aborted the cut (the real DDR honeycomb-panel bug)."""
    b1 = {"id": "b1", "type": "box", "length": 40, "width": 40, "height": 10}  # z -5..5
    b2 = {"id": "b2", "type": "box", "length": 40, "width": 40, "height": 10}
    mv = {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 20,
          "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}  # body2 → z 15..25
    sk = {"id": "s1", "type": "sketch", "plane": "XY",
          "entities": [{"id": "c1", "type": "circle", "x": -10, "y": 0, "radius": 3},
                       {"id": "c2", "type": "circle", "x": 10, "y": 0, "radius": 3}]}
    cut = {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 30,
           "operation": "cut", "regions": [[-10, 0, 0], [10, 0, 0]]}
    part, err, bodies = rebuild({"parameters": {}, "features": [b1, b2, mv, sk, cut]})
    assert not err, err
    vols = {b["id"]: b["shape"].volume for b in bodies if b.get("shape")}
    # both boxes (16000 each) lose 2 cylinders where the cut passes through them
    assert vols["body1"] < 16000 - 100, f"body1 not cut: {vols['body1']:.0f}"
    assert vols["body2"] < 16000 - 100, f"body2 not cut: {vols['body2']:.0f}"
    print(f"  extrude cut disjoint OK: both bodies cut (body1 {vols['body1']:.0f}, body2 {vols['body2']:.0f})")


def test_visibility_captured():
    """Captured-visibility semantics: an extrude carrying `hiddenBodies` uses
    THAT set (participants decided at creation, MCAD-style) and ignores the
    document's live eye states — so toggling visibility later can never rewrite
    what a cut touched. Legacy features (no field) keep the live-map behavior
    (test_cut_skips_hidden_body)."""
    b1 = {"id": "b1", "type": "box", "length": 40, "width": 40, "height": 10}
    b2 = {"id": "b2", "type": "box", "length": 40, "width": 40, "height": 10}
    mv = {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 20,
          "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}
    sk = {"id": "s1", "type": "sketch", "plane": "XY",
          "entities": [{"id": "c", "type": "circle", "x": 0, "y": 0, "radius": 5}]}

    # captured "body1 was hidden at creation": body1 stays intact even though
    # the live map says everything is visible
    cut = {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 30,
           "operation": "cut", "regions": [[0, 0, 0]], "hiddenBodies": ["body1"]}
    _, err, bodies = rebuild({"parameters": {}, "features": [b1, b2, mv, sk, cut]})
    assert not err, err
    v = {b["id"]: b["shape"].volume for b in bodies if b.get("shape")}
    assert abs(v["body1"] - 16000) < 1, f"captured-hidden body1 must be intact: {v['body1']:.0f}"
    assert v["body2"] < 16000 - 100, f"body2 should be cut: {v['body2']:.0f}"

    # captured "nothing hidden": cuts EVERYTHING it crosses even though the
    # live map hides body2 — eye toggles are pure display for stamped features
    cut2 = {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 30,
            "operation": "cut", "regions": [[0, 0, 0]], "hiddenBodies": []}
    _, err, bodies = rebuild({"parameters": {}, "features": [b1, b2, mv, sk, cut2],
                              "bodyVisibility": {"body2": False}})
    assert not err, err
    v = {b["id"]: b["shape"].volume for b in bodies if b.get("shape")}
    assert v["body1"] < 16000 - 100 and v["body2"] < 16000 - 100, (
        f"captured-empty set must cut both regardless of live eyes: {v}"
    )

    # cache signature: visibility must be IGNORED when every extrude carries
    # hiddenBodies, and honored when a legacy extrude exists
    import builder
    stamped = {"parameters": {}, "features": [b1, b2, mv, sk, cut2]}
    legacy = {"parameters": {}, "features": [b1, b2, mv, sk,
              {k: val for k, val in cut2.items() if k != "hiddenBodies"}]}
    sig = builder._global_sig
    assert sig(stamped) == sig({**stamped, "bodyVisibility": {"body1": False}}), (
        "eye toggles must not invalidate the cache for stamped documents"
    )
    assert sig(legacy) != sig({**legacy, "bodyVisibility": {"body1": False}}), (
        "legacy documents must keep visibility in the cache signature"
    )
    print("  visibility-captured OK: creation set wins over live eyes both ways; "
          "cache sig ignores eyes for stamped docs")


def test_cut_skips_hidden_body():
    """A cut extrude never edits a HIDDEN body: bodyVisibility travels with the
    rebuild and hidden bodies are excluded from the extrude boolean (a hidden body
    is intentionally protected from edits)."""
    b1 = {"id": "b1", "type": "box", "length": 40, "width": 40, "height": 10}  # z -5..5
    b2 = {"id": "b2", "type": "box", "length": 40, "width": 40, "height": 10}
    mv = {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 20,
          "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}  # body2 → z 15..25
    sk = {"id": "s1", "type": "sketch", "plane": "XY",
          "entities": [{"id": "c", "type": "circle", "x": 0, "y": 0, "radius": 5}]}
    cut = {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 30,
           "operation": "cut", "regions": [[0, 0, 0]]}
    feats = [b1, b2, mv, sk, cut]
    _, err, bodies = rebuild({"parameters": {}, "features": feats,
                              "bodyVisibility": {"body2": False}})
    assert not err, err
    v = {b["id"]: b["shape"].volume for b in bodies if b.get("shape")}
    assert v["body1"] < 16000 - 100, f"visible body1 should be cut: {v['body1']:.0f}"
    assert abs(v["body2"] - 16000) < 1, f"hidden body2 must be UNTOUCHED: {v['body2']:.0f}"
    print(f"  cut skips hidden OK: body1 {v['body1']:.0f} cut, hidden body2 {v['body2']:.0f} intact")


def test_incremental_cache():
    """rebuild_cached (incremental, worker-local snapshot cache) is geometrically
    IDENTICAL to a full rebuild across an edit sequence: cold cache, no-op re-emit,
    editing the last / a middle feature, appending, deleting, and param/visibility
    changes (which force a full rebuild). Guards against a stale-prefix resume."""
    import copy
    import builder

    def full(doc):
        _, err, bodies = builder.rebuild(doc)  # ground truth (never touches the cache)
        assert not err, err
        return {b["id"]: round(b["shape"].volume, 3) for b in bodies if b.get("shape")}

    def cached(doc):
        _, err, bodies = builder.rebuild_cached(doc)
        assert not err, err
        return {b["id"]: round(b["shape"].volume, 3) for b in bodies if b.get("shape")}

    base = {"parameters": {"h": 10}, "features": [
        {"id": "b1", "type": "box", "length": 40, "width": 40, "height": "h"},
        {"id": "b2", "type": "box", "length": 10, "width": 10, "height": 30},
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": -10,
         "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
        {"id": "sk", "type": "sketch", "plane": "XY",
         "entities": [{"id": "c", "type": "circle", "x": 0, "y": 0, "radius": 5}]},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 30,
         "operation": "cut", "regions": [[0, 0, 0]]},
    ]}
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}  # cold

    steps = []
    steps.append(("cold", base))
    steps.append(("no-op re-emit", copy.deepcopy(base)))
    d = copy.deepcopy(base); d["features"][-1]["distance"] = 40
    steps.append(("edit last feature", d))
    d = copy.deepcopy(d); d["features"][2]["dz"] = -5
    steps.append(("edit middle feature", d))
    d = copy.deepcopy(d); d["features"].append({"id": "b3", "type": "box", "length": 5, "width": 5, "height": 5})
    steps.append(("append feature", d))
    d = copy.deepcopy(d); d["parameters"]["h"] = 20
    steps.append(("param change (full)", d))
    d = copy.deepcopy(d); d["bodyVisibility"] = {"body2": False}
    steps.append(("visibility change (full)", d))
    d = copy.deepcopy(d); d["features"].pop()
    steps.append(("delete last feature", d))

    for label, doc in steps:
        assert cached(doc) == full(doc), f"incremental != full at: {label}"
    print(f"  incremental cache OK: {len(steps)} edit steps all match full rebuild")


def test_split_groups_disconnected():
    """Split with groupSides gives one body per physically-SEPARATE piece: a
    connected body → 2 (one per side, each side's many solids kept as one), while
    genuinely disconnected lumps each become their own body. Side-split first (halves
    touch at the cut), then group vertex-connected solids within a side."""
    # (a) a connected plate → exactly 2 bodies (one per side), NOT one-per-solid
    sk = {"id": "s", "type": "sketch", "plane": "XY",
          "entities": [{"id": "r", "type": "rectangle", "x": 0, "y": 0, "width": 40, "height": 40}]}
    ex = {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}
    sp = {"id": "sp", "type": "split", "plane": "XZ", "keep": "both", "body": "body1", "groupSides": True}
    _, err, bodies = rebuild({"parameters": {}, "features": [sk, ex, sp]})
    assert not err, err
    assert len(bodies) == 2, f"connected plate split should give 2 bodies, got {len(bodies)}"

    # (b) one body of two DISJOINT disks, cut through both → 4 separate pieces
    sk2 = {"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"id": "c1", "type": "circle", "x": -20, "y": 0, "radius": 5},
        {"id": "c2", "type": "circle", "x": 20, "y": 0, "radius": 5}]}
    ex2 = {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}
    sp2 = {"id": "sp", "type": "split", "plane": "XZ", "keep": "both", "body": "body1", "groupSides": True}
    _, err2, bodies2 = rebuild({"parameters": {}, "features": [sk2, ex2, sp2]})
    assert not err2, err2
    assert len(bodies2) == 4, f"two disjoint disks cut through both should give 4 pieces, got {len(bodies2)}"
    print(f"  split groups disconnected OK: connected plate→2 bodies, 2 disjoint disks cut→4 bodies")


def test_face_provenance():
    """Each face carries the feature that created/last-shaped it (for click-a-face →
    delete-that-feature). The chamfer face maps to the chamfer; untouched faces keep
    the base feature; provenance survives a move (owner keys follow the transform)."""
    bx = {"id": "bx", "type": "box", "length": 20, "width": 20, "height": 10}
    ch = {"id": "ch", "type": "chamfer",
          "edges": {"kind": "edge", "by": "nearest", "point": [0, 10, 5]}, "distance": 3}
    mv = {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 50,
          "rx": 0, "ry": 0, "rz": 0}
    _, err, bodies = rebuild({"parameters": {}, "features": [bx, ch, mv]})
    assert not err, err
    owners = set(bodies[0]["owners"].values())
    assert "ch" in owners, f"chamfer face not attributed to the chamfer: {owners}"
    assert "bx" in owners, f"untouched faces should stay 'bx' through the move: {owners}"
    print(f"  face provenance OK: face owners = {sorted(owners)}")


def test_delete_face():
    """deleteFace (OCCT defeaturing) removes a face and heals the solid — deleting a
    chamfer/fillet on geometry that has no feature to edit (e.g. imported parts)."""
    doc = {"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": 20, "width": 20, "height": 10},
        {"id": "ch", "type": "chamfer",
         "edges": {"kind": "edge", "by": "nearest", "point": [0, 10, 5]}, "distance": 3},
        {"id": "df", "type": "deleteFace",
         "face": {"kind": "face", "by": "nearest", "point": [0, 8.5, 3.5]}},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert abs(part.volume - 4000) < 1, f"deleteFace should heal to 4000, got {part.volume:.1f}"
    assert len(part.faces()) == 6, f"healed box should have 6 faces, got {len(part.faces())}"
    print(f"  delete-face OK: chamfer removed + healed → vol {part.volume:.0f}, {len(part.faces())} faces")


def test_defeature_chain():
    """The chamfer-chain recognizer: picking ONE face of a corner-chamfer chain
    expands to the whole chain (3 strips + corner patch, never the base faces) and
    defeaturing the chain restores the pristine box. This is the Phase-1 rescue for
    faces where single-face defeaturing no-ops."""
    from build123d import Box, Vector, chamfer

    from builder import _defeature, _expand_blend_chain, _face_width

    b = Box(20, 20, 20)
    corner = Vector(10, 10, 10)
    edges = [
        e for e in b.edges()
        if any((Vector(v.X, v.Y, v.Z) - corner).length < 1e-6 for v in e.vertices())
    ]
    part = chamfer(edges, 2)  # 3 strips + 1 corner patch = 10 faces
    faces = sorted(part.faces(), key=lambda f: f.area)
    patch, strip = faces[0], faces[1]

    for seed, label in ((strip, "strip"), (patch, "patch")):
        chain = _expand_blend_chain(part, [seed])
        widths = sorted(_face_width(f) for f in chain)
        assert len(chain) == 4, f"chain from {label}: expected 4 faces, got {len(chain)}"
        assert widths[-1] < 3, f"chain from {label} absorbed a base face (widths {widths})"

    healed = _defeature(part, [_expand_blend_chain(part, [patch])[0]])
    assert len(healed.faces()) < len(part.faces())
    full = _defeature(part, _expand_blend_chain(part, [patch]))
    assert len(full.faces()) == 6 and abs(full.volume - 8000) < 1, (
        f"full-chain defeature should restore the box, got {len(full.faces())} faces "
        f"vol {full.volume:.1f}"
    )

    # an unhealable delete must raise with the OCCT alert surfaced, not no-op
    b2 = Box(10, 10, 10)
    try:
        _defeature(b2, [b2.faces()[0]])
        raise AssertionError("deleting a bare box face should raise")
    except ValueError as ex:
        assert "BOPAlgo_Alert" in str(ex), f"OCCT alert missing from error: {ex}"
    print("  defeature-chain OK: 4-face chain recognized from strip AND patch, "
          "full chain heals to pristine box, unhealable raises with OCCT alert")


def test_canonicalize_import():
    """Canonical-recognition pre-pass: near-analytic B-spline faces snap to true
    planes on import, so defeaturing can extend them exactly. All-analytic shapes
    pass through untouched (same object)."""
    from build123d import Box, Cylinder
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType
    from OCP.ShapeCustom import ShapeCustom

    from builder import _canonicalize, _wrap_topods

    part = Box(20, 20, 10) - Cylinder(4, 10)
    assert _canonicalize(part) is part, "all-analytic shape must pass through untouched"

    bs = _wrap_topods(ShapeCustom.ConvertToBSpline_s(part.wrapped, True, True, True, True))
    n_spline = sum(
        1 for f in bs.faces()
        if BRepAdaptor_Surface(f.wrapped).GetType()
        == GeomAbs_SurfaceType.GeomAbs_BSplineSurface
    )
    assert n_spline == 6, f"expected 6 spline faces in the test input, got {n_spline}"
    canon = _canonicalize(bs)
    kinds = [BRepAdaptor_Surface(f.wrapped).GetType() for f in canon.faces()]
    n_planes = sum(1 for k in kinds if k == GeomAbs_SurfaceType.GeomAbs_Plane)
    assert n_planes == 6, f"expected 6 snapped planes, got {n_planes}"
    assert abs(canon.volume - bs.volume) < 1e-6 * bs.volume + 1e-9
    assert len(canon.faces()) == len(bs.faces())
    print(f"  canonicalize OK: 6 spline faces → 6 planes, volume preserved "
          f"({canon.volume:.2f})")


def test_tool_fill():
    """P2 tool-solid fill: erase a chamfer by fusing the wedge built from its
    supports' half-spaces (works where extension-healing gives up), with the
    guards that keep it safe — an unbounded wound (deleting a box's whole top
    face) is refused instead of extruding the part, and an unrelated hole inside
    the wedge region is never plugged."""
    from build123d import Box, Cylinder, Pos, Vector, chamfer

    from builder import _expand_blend_chain, _tool_fill_all

    b = Box(20, 20, 20)
    corner = Vector(10, 10, 10)
    edges = [
        e for e in b.edges()
        if any((Vector(v.X, v.Y, v.Z) - corner).length < 1e-6 for v in e.vertices())
    ]
    part = chamfer(edges, 2)
    chain = _expand_blend_chain(part, [min(part.faces(), key=lambda f: f.area)])

    # sequential per-pocket fills restore the pristine box exactly
    r = _tool_fill_all(part, chain)
    assert r is not None and abs(r.volume - 8000) < 0.01, (
        f"corner-chain fill should restore vol 8000, got {r and r.volume}"
    )

    # deleting a box's whole top face has an unbounded wound — must refuse
    top = max(b.faces(), key=lambda f: f.center().Z)
    assert _tool_fill_all(b, [top]) is None, "unbounded fill must be refused"

    # a hole inside the wedge region must survive the fill
    holed = part - Pos(5, 5, 9) * Cylinder(1.5, 2)
    hole_void = part.volume - holed.volume
    c3 = _expand_blend_chain(holed, [min(holed.faces(), key=lambda f: f.area)])
    r3 = _tool_fill_all(holed, c3)
    assert r3 is not None and abs(r3.volume - (8000 - hole_void)) < 0.05, (
        f"hole must not be plugged: got {r3 and r3.volume}, want {8000 - hole_void:.2f}"
    )
    print("  tool-fill OK: corner chain -> pristine box; unbounded refused; "
          "hole preserved")


def test_refacet_clean():
    """Facet-import cleanup: near-coplanar staircase walls (STL heritage, or two
    fused bodies 0.05mm out of line) collapse into single crisp planes; clean
    geometry passes through untouched."""
    from build123d import Box, Pos

    from builder import _refacet_clean

    b = Box(20, 20, 10)
    assert _refacet_clean(b) is b, "clean box must pass through untouched"

    # two fused boxes, misaligned 0.05 mm in X — every side wall becomes a
    # 2-plane staircase the exact-coplanar unify can't merge
    part = b + Pos(0.05, 0, 9.95) * Box(20, 20, 10)
    before = len(part.faces())
    cleaned = _refacet_clean(part)
    assert cleaned is not part, "staircase body should be cleaned"
    after = len(cleaned.faces())
    assert after <= 6 and after < before, (
        f"expected the staircase to collapse to a box (≤6 faces), got {after} (was {before})"
    )
    assert abs(cleaned.volume - part.volume) <= 0.01 * part.volume
    print(f"  refacet-clean OK: fused staircase {before} -> {after} faces, "
          f"volume preserved ({cleaned.volume:.1f})")


def test_unify_body():
    """cleanUp's inter-solid unify: a body whose boolean joins left glued,
    interpenetrating solids plus an inside-out duplicate fuses into ONE clean
    solid at the true union volume; clean bodies and zero-measure (edge)
    contact groups pass through with material and piece-count intact."""
    from build123d import Box, Compound, Pos
    from OCP.BRepCheck import BRepCheck_Analyzer

    from builder import _unify_body, _wrap_topods, rebuild

    # clean single solid: identity fast-path
    b = Box(10, 10, 10)
    assert _unify_body(b) is b, "clean box must pass through untouched"

    # the rot combines bake into ragged bodies: two interpenetrating boxes
    # (union 1500, naive sum 2000) + an inside-out duplicate inside the first
    a = Box(10, 10, 10)
    c = Pos(5, 0, 0) * Box(10, 10, 10)
    inv = _wrap_topods((Pos(-2, 0, 0) * Box(2, 2, 2)).wrapped.Reversed())
    assert inv.volume < 0, "reversed box should report negative volume"
    sick = Compound([a, c, inv])
    u = _unify_body(sick)
    assert u is not sick, "rotten compound should be repaired"
    assert len(u.solids()) == 1, f"expected 1 unified solid, got {len(u.solids())}"
    assert abs(u.volume - 1500) < 1.0, f"true union volume 1500, got {u.volume:.2f}"
    assert BRepCheck_Analyzer(u.wrapped).IsValid()
    assert _unify_body(u) is u, "already-unified body must pass through untouched"

    # two solids touching only along an edge (a grouped split body, e.g. a
    # honeycomb half): both pieces must survive with volume intact
    pair = Compound([Box(1, 1, 1), Pos(1, 1, 0) * Box(1, 1, 1)])
    up = _unify_body(pair)
    assert len(up.solids()) == 2, "edge-contact pieces must stay two solids"
    assert abs(up.volume - 2.0) < 1e-6

    # feature plumbing: a cleanUp feature runs through rebuild without error
    doc = {
        "features": [
            {"id": "f1", "type": "box", "length": 10, "width": 10, "height": 10},
            {"id": "f2", "type": "cleanUp"},
        ],
        "parameters": {},
    }
    part, errors, bodies = rebuild(doc)
    assert not errors, f"cleanUp on a clean body must not error: {errors}"
    assert len(bodies) == 1 and abs(bodies[0]["shape"].volume - 1000) < 1e-6
    print("  unify-body OK: rot -> 1 solid @ true union volume; clean/edge-"
          "contact untouched; cleanUp feature green")


def test_error_continues():
    """A failing feature is a recorded no-op, not a timeline killer: features
    AFTER it still execute (MCAD-style), and the incremental cache both keeps
    working and keeps re-reporting the error on resumed builds."""
    import builder
    from builder import rebuild, rebuild_cached

    doc = {"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": 10, "width": 10, "height": 10},
        # an over-large fillet radius: deterministic OCCT failure mid-timeline
        {"id": "bad", "type": "fillet",
         "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 100},
        {"id": "cy", "type": "cylinder", "radius": 5, "height": 30},
    ]}
    part, errors, bodies = rebuild(doc)
    assert [e["feature_id"] for e in errors] == ["bad"], f"expected bad split flagged: {errors}"
    assert len(bodies) == 2, (
        f"the cylinder AFTER the failed split must still build: {len(bodies)} bodies"
    )

    # incremental: cold build, then a no-op resume — the error must re-report
    # from the cached snapshot, not vanish
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    _, err1, bod1 = rebuild_cached(doc)
    _, err2, bod2 = rebuild_cached(doc)  # 100% cache hit
    assert [e["feature_id"] for e in err1] == ["bad"]
    assert [e["feature_id"] for e in err2] == ["bad"], (
        "resumed build must still report the cached error"
    )
    assert len(bod2) == 2

    # edit downstream of the failed feature: applies incrementally AND matches
    # a fresh full rebuild
    doc["features"].append({"id": "bx2", "type": "box", "length": 5, "width": 5, "height": 5})
    _, err3, bod3 = rebuild_cached(doc)
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    _, err4, bod4 = rebuild(doc)
    assert [e["feature_id"] for e in err3] == ["bad"]
    assert len(bod3) == 3 and len(bod4) == 3
    assert all(
        abs(a["shape"].volume - b["shape"].volume) < 1e-9
        for a, b in zip(bod3, bod4)
    ), "incremental-past-error must equal a full rebuild"
    print("  error-continues OK: failed split no-ops, downstream builds, "
          "cache resumes + re-reports the error")


def test_delete_face_retarget():
    """deleteFace body refs are positional and go stale when upstream edits
    renumber bodies — the pick must re-anchor GEOMETRICALLY: the face nearest
    the recorded point wins across all bodies, with a lossy diagnostic when
    that's a different body than the named one."""
    from builder import rebuild

    doc = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "b2", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "mv", "type": "move", "dx": 50, "dy": 0, "dz": 0,
         "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
        {"id": "ch", "type": "chamfer",
         "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "distance": 2},
        # names body1, but the pick point sits on body2's chamfer face — the
        # exact shape of a saved delete whose body id was renumbered upstream
        {"id": "del", "type": "deleteFace", "body": "body1",
         "face": {"kind": "face", "by": "nearest", "point": [54, 4, 0]}},
    ]}
    diag = []
    part, errors, bodies = rebuild(doc, diagnostics=diag)
    assert not errors, f"re-targeted delete must heal: {errors}"
    rt = [d for d in diag if d.get("kind") == "deleteFace" and d.get("lossy")]
    assert rt, "expected a lossy re-target diagnostic"
    b2 = next(b for b in bodies if b["id"] == "body2")
    assert len(b2["shape"].faces()) == 9, (
        f"one of four chamfer faces healed away: {len(b2['shape'].faces())} faces"
    )
    b1 = next(b for b in bodies if b["id"] == "body1")
    assert len(b1["shape"].faces()) == 6, "the named-but-wrong body must be untouched"
    print("  delete-retarget OK: stale body ref re-anchored to the picked face, "
          "healed, flagged lossy")


def test_presspull_upto_exact():
    """Up-to-surface distances are EXACT: (a) an inward up-to deeper than the
    90% thickness clamp lands ON the target, not short of it (audit bug #1);
    (b) the target face may live on ANOTHER body — 'extrude until it meets
    that part' — resolved globally from the pick point."""
    from builder import rebuild

    # (a) L-shape: base slab + a boss on top. Press the boss top DOWN up-to the
    # base bottom: the prism must cut clean through BOTH blocks (depth 20 —
    # way past any single-face thickness clamp).
    doc = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 10},  # z -5..5
        {"id": "b2", "type": "box", "length": 10, "width": 20, "height": 10},
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 10,
         "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},  # boss z 5..15
        {"id": "cb", "type": "combine", "operation": "join", "target": "body1", "tools": ["body2"]},
        {"id": "pp", "type": "press-pull",
         "face": {"kind": "face", "by": "nearest", "point": [0, 0, 15]},  # boss top
         "distance": -1, "operation": "cut", "body": "body1",
         "upTo": {"kind": "face", "by": "nearest", "point": [8, 8, -5]}},  # base BOTTOM
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    # base 4000 + boss 2000 = 6000; cutting the 10x20 column down to z=-5
    # removes the boss (2000) AND the base under it (2000) → exactly 2000
    v = bodies[0]["shape"].volume
    assert abs(v - 2000) < 1, f"up-to must land exactly on the target: {v:.1f} (clamped would be >2000)"

    # (b) cross-body target: grow a short box UP TO a taller neighbor's top plane
    doc2 = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},   # z -5..5
        {"id": "b2", "type": "box", "length": 10, "width": 10, "height": 30},
        {"id": "mv", "type": "move", "dx": 40, "dy": 0, "dz": 5,
         "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},  # neighbor z -10..20
        {"id": "pp", "type": "press-pull",
         "face": {"kind": "face", "by": "nearest", "point": [0, 0, 5]},  # body1 top
         "distance": 1, "operation": "join", "body": "body1",
         "upTo": {"kind": "face", "by": "nearest", "point": [40, 0, 20]}},  # body2 TOP
    ]}
    part, err, bodies = rebuild(doc2)
    assert not err, err
    b1 = next(b for b in bodies if b["id"] == "body1")
    bb = b1["shape"].bounding_box()
    assert abs(bb.max.Z - 20) < 1e-6, f"body1 must grow exactly to the neighbor's top: z={bb.max.Z}"
    assert abs(b1["shape"].volume - 10 * 10 * 25) < 1, b1["shape"].volume
    print("  press-pull up-to exact OK: through-clamp cut lands on target; "
          "cross-body target plane honored")


def test_export_despite_errors():
    """Export writes what BUILT and warns about what didn't — one red feature
    must not hold every valid body hostage (it used to refuse entirely, which
    blocked the import-repair → print loop)."""
    import os
    import tempfile

    import server

    doc = {"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "bad", "type": "fillet",
         "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 100},
        {"id": "cy", "type": "cylinder", "radius": 5, "height": 30},
    ]}
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "out.stl")
        res = server._export_job(doc, "stl", p)
        assert "error" not in res, f"must export the surviving bodies: {res}"
        assert os.path.exists(res["path"]) and os.path.getsize(res["path"]) > 0
        warns = res.get("warnings") or []
        assert any(w.get("feature_id") == "bad" for w in warns), (
            f"the failed fillet must be named in warnings: {warns}"
        )
        # a document where NOTHING builds is still a hard error
        res2 = server._export_job(
            {"parameters": {}, "features": [
                {"id": "s", "type": "sketch", "plane": "XY",
                 "entities": [{"type": "rectangle", "width": 5, "height": 5}]},
            ]},
            "stl", os.path.join(td, "none.stl"),
        )
        assert "error" in res2, "nothing-built must still refuse"
    print("  export-despite-errors OK: surviving bodies written + failed "
          "feature named; nothing-built still refuses")


def test_export_project_3mf():
    """Orca-project 3MF export job: zip layout, per-object extruder metadata
    (1-based = slot+1, unassigned → 1), palette → filament_colour, shared
    bed-centering transform, and input sanitizing (bad colors / bad slots)."""
    import json
    import zipfile
    import xml.etree.ElementTree as ET
    import server
    from project3mf import sanitize_inputs

    palette, colors0, _ = sanitize_inputs(
        [{"name": "Red", "color": "#e03030"}, {"name": "Blue", "color": "3050E0FF"}],
        {"x": 99}, {},
    )
    assert palette[1]["color"] == "#3050E0", "RRGGBBAA should normalize to #RRGGBB"
    assert not colors0, "out-of-range slot must be dropped"

    doc = {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": 40, "y": 0}]},
        {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 5, "operation": "new"},
    ]}
    _, _, bodies = rebuild(doc)
    assert len(bodies) == 2
    b0, b1 = bodies[0]["id"], bodies[1]["id"]

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "proj.3mf")
        res = server._export_project_job(
            doc, path,
            [{"name": "Red", "color": "#E03030"}, {"name": "Blue", "color": "#3050E0"}],
            {b1: 1},                # b0 unassigned → extruder 1
            {b0: "Left"},
            {"printer_model": "Snapmaker U1"},
        )
        assert "error" not in res, f"exportProject failed: {res}"

        with zipfile.ZipFile(res["path"]) as z:
            entries = set(z.namelist())
            for want in ("[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model",
                         "Metadata/model_settings.config",
                         "Metadata/project_settings.config"):
                assert want in entries, f"missing zip entry {want}"
            model = ET.fromstring(z.read("3D/3dmodel.model"))
            cfg = ET.fromstring(z.read("Metadata/model_settings.config"))
            proj = json.loads(z.read("Metadata/project_settings.config"))

    core = "{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}"
    objs = model.findall(f".//{core}object")
    assert len(objs) == 2
    assert objs[0].get("name") == "Left", "bodyNames rename must win"
    items = model.findall(f".//{core}item")
    assert len(items) == 2 and items[0].get("transform") == items[1].get("transform"), \
        "assembly must share ONE transform"

    # the shared transform lands the combined bbox center at bed center (135,135)
    # and drops z-min to 0: doc spans x∈[-10,50] y∈[-10,10] z∈[0,5] → tx=115 ty=135
    tx, ty, tz = (float(v) for v in items[0].get("transform").split()[9:])
    assert abs(tx - 115) < 0.1 and abs(ty - 135) < 0.1 and abs(tz) < 0.1, (tx, ty, tz)

    ext = {o.get("id"): o.find("./metadata[@key='extruder']").get("value")
           for o in cfg.findall("./object")}
    assert ext["2"] == "1", "unassigned body → extruder 1"
    assert ext["3"] == "2", "slot 1 → extruder 2 (1-based)"
    assert proj["filament_colour"] == ["#E03030", "#3050E0"]
    assert proj["printer_model"] == "Snapmaker U1", "caller settings must survive"
    print("  project-3MF OK: zip layout, extruder metadata, filament_colour, "
          "shared centering transform, sanitize")


if __name__ == "__main__":
    print("SindriCAD sidecar smoke test")
    test_rebuild()
    test_error_naming()
    test_exports()
    test_import_roundtrip()
    test_split()
    test_split_groups_disconnected()
    test_combine()
    test_combine_dangling_ref()
    test_datum_and_bodies_tessellation()
    test_datum_offset_and_split_by_id()
    test_split_all_and_move_bodies()
    test_presspull_targets_owning_body()
    test_presspull_multiface()
    test_presspull_upto()
    test_presspull_upto_exact()
    test_export_despite_errors()
    test_export_project_3mf()
    test_sketch_patterns()
    test_sketch_crossing_split()
    test_extrude_cut_disjoint()
    test_cut_skips_hidden_body()
    test_visibility_captured()
    test_incremental_cache()
    test_face_provenance()
    test_delete_face()
    test_defeature_chain()
    test_canonicalize_import()
    test_tool_fill()
    test_refacet_clean()
    test_unify_body()
    test_error_continues()
    test_delete_face_retarget()
    test_extrude_operation_multibody()
    test_extrude_noop_guards()
    test_primitives()
    test_modify_tools()
    test_simplify_mesh()
    test_sweep()
    test_scale_and_move()
    test_multibody_import_and_guards()
    test_interference()
    test_remove_body()
    print("ALL PASS")
