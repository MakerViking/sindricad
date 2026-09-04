"""Backend smoke test — exercises rebuild/tessellate/selectors/export directly
(no WebSocket) so failures point straight at the geometry code.

Run:  uv run python test_smoke.py
"""

import os
import math
import struct
import tempfile

import inspect
import builder
from builder import rebuild, import_geometry
from tessellate import tessellate, tessellate_bodies, edge_polylines, bbox
from exporters import export
from geom_select import resolve_faces

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
        assert payload["geom"], "no geometry hash produced"
        # a clean box must come back as 6 faces — proves coplanar-facet merging
        # (UnifySameDomain) recovers real editable faces, not a triangle soup.
        assert payload["faces"] == 6, f"{fmt} box should merge to 6 faces, got {payload['faces']}"
        doc = {"parameters": {}, "features": [
            {"id": "imp", "type": "import", "format": fmt, "name": payload["name"], "geom": payload["geom"]}
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


def test_sketch_spline_extrude():
    """A sketch profile whose closed loop includes a free-form `spline` entity
    (not just line/arc) extrudes like any other polyline profile. The spline's
    points are collinear here, so `Edge.make_spline` degenerates to an exact
    straight edge and the enclosed area stays an exact 10x6 rectangle — this
    checks the "spline" entity dispatch/combining, not curve fitting."""
    ents = [
        {"id": "l0", "type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0},
        {"id": "l1", "type": "line", "x1": 10, "y1": 0, "x2": 10, "y2": 6},
        {"id": "l2", "type": "line", "x1": 10, "y1": 6, "x2": 0, "y2": 6},
        {"id": "sp", "type": "spline", "points": [
            {"x": 0, "y": 6}, {"x": 0, "y": 3}, {"x": 0, "y": 0}]},
    ]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"},
    ]}
    part, err, _ = rebuild(doc)
    assert not err, err
    assert abs(part.volume - 300) < 1, f"10x6x5 rect closed by a spline side = 300, got {part.volume:.1f}"
    print(f"  sketch spline extrude OK: vol {part.volume:.0f}")


def test_sketch_pattern_with_spline():
    """A sketch pattern's source entities can include a spline: `_translate_entity`
    / `_rotate_entity` must carry spline points through pattern expansion just
    like line/circle/arc, so a patterned spline-sided profile tiles correctly."""
    ents = [
        {"id": "l0", "type": "line", "x1": 0, "y1": 0, "x2": 4, "y2": 0},
        {"id": "l1", "type": "line", "x1": 4, "y1": 0, "x2": 4, "y2": 4},
        {"id": "l2", "type": "line", "x1": 4, "y1": 4, "x2": 0, "y2": 4},
        {"id": "sp", "type": "spline", "points": [
            {"x": 0, "y": 4}, {"x": 0, "y": 2}, {"x": 0, "y": 0}]},
    ]
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": ents,
         "patterns": [{"id": "pr", "type": "patternRect", "sources": [e["id"] for e in ents],
                       "countX": 2, "countY": 2, "spacingX": 10, "spacingY": 10}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 3, "operation": "new"},
    ]}
    part, err, _ = rebuild(doc)
    assert not err, err
    assert len(part.solids()) == 4, f"2x2 rect pattern of a spline-sided square should give 4 solids, got {len(part.solids())}"
    assert abs(part.volume - 192) < 1, f"4 unit squares of 4x4x3 = 192, got {part.volume:.1f}"
    print(f"  sketch pattern+spline OK: {len(part.solids())} solids, vol {part.volume:.0f}")


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


# --- press-pull up-to: plane targets, offset, and the three silent-wrong guards --
# A datum plane is a legitimate up-to target (field report ffab4ece: "created an
# offset plane, selected a face to extrude, would be good if extruding to the
# offset plane is possible"). `upToPlane` is a DATUM FEATURE ID (or "XY"/"XZ"/"YZ"),
# not a Selector — a datum has no topology to fingerprint, so it names itself the
# way sketch.planeId and split.planeId already do.

_PP_BOX = {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 10}  # z −5..5
_PP_TOP = {"kind": "face", "by": "nearest", "point": [0, 0, 5]}  # its top face


def _pp_body(bodies, bid="body1"):
    """The named body's shape, or None if the feature annihilated it."""
    for b in bodies:
        if b["id"] == bid:
            return b.get("shape")
    return None


def _stranded_area(shape, z):
    """Total area of HORIZONTAL faces of `shape` still sitting at height `z`.

    The witness for "up to" on a target that crosses the picked face: any of the
    picked face left behind at its starting height is area that never travelled.
    Volume cannot see it — a half-moved top and a flat top can measure the same —
    so the shape has to be read directly."""
    tot = 0.0
    for f in shape.faces():
        n = f.normal_at()
        if abs(abs(n.Z) - 1) < 1e-6 and abs(f.center().Z - z) < 1e-6:
            tot += f.area
    return tot


# A 20x20x10 plate (z −5..5) with a 6x20x10 rib on top (z 5..15) fused into one
# solid, plus a separate 4x4x4 block at z −20..−16 joined into the SAME body:
# 1 body / 2 solids / 5264 mm³. The block sits under the rib's footprint, so a
# prism down the rib passes straight through it.
_PP_RIB_AND_BLOCK = [
    _PP_BOX,
    {"id": "b2", "type": "box", "length": 6, "width": 20, "height": 10},
    {"id": "mv2", "type": "move", "dx": 0, "dy": 0, "dz": 10, "rx": 0, "ry": 0, "rz": 0,
     "bodies": ["body2"]},
    {"id": "b3", "type": "box", "length": 4, "width": 4, "height": 4},
    {"id": "mv3", "type": "move", "dx": 0, "dy": 0, "dz": -18, "rx": 0, "ry": 0, "rz": 0,
     "bodies": ["body3"]},
    {"id": "cb", "type": "combine", "operation": "join", "target": "body1",
     "tools": ["body2", "body3"]},
]
_PP_RIB_TOP = {"kind": "face", "by": "nearest", "point": [0, 0, 15]}


def test_presspull_upto_datum_plane():
    """`upToPlane` extrudes up to a DATUM plane, with no face to pick.

    Before: `upToPlane` was not read at all, so the feature fell through to
    `distance` (0) and silently did nothing — err == [], body unchanged at 4000."""
    doc = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 25},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": _PP_TOP, "upToPlane": "dp"},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    bb = bbox(part)
    assert abs(bb["max"][2] - 25) < 0.01, f"top must land ON the datum at z=25, got {bb['max'][2]}"
    assert abs(part.volume - 12000) < 1, f"20x20x30 = 12000, got {part.volume:.1f}"

    # a BASE plane id resolves the same way (no datum feature needed)
    doc2 = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": _PP_TOP, "upToPlane": "XY"},  # z=0, INSIDE the box → pushes the top down
    ]}
    part2, err2, _ = rebuild(doc2)
    assert not err2, err2
    assert abs(bbox(part2)["max"][2]) < 0.01, f"top must land on XY (z=0), got {bbox(part2)['max'][2]}"

    # a datum that only exists LATER in the timeline must say so, not resolve
    doc3 = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": _PP_TOP, "upToPlane": "dp"},
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 25},
    ]}
    _p3, err3, _b3 = rebuild(doc3)
    assert err3 and "timeline" in err3[0]["message"], f"out-of-order datum must name the ordering: {err3}"

    # `upTo` and `upToPlane` together are invalid — refuse rather than pick one
    doc4 = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 25},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": _PP_TOP, "upToPlane": "dp", "upTo": _PP_TOP},
    ]}
    _p4, err4, _b4 = rebuild(doc4)
    assert err4, "setting both upTo and upToPlane must be refused, not silently resolved"
    print(f"  press-pull up-to datum plane OK: z_max 25, vol {part.volume:.0f}; "
          f"late datum + both-set refused")


def test_presspull_upto_offset():
    """`upToOffset` shifts the landing along the EXTRUDE direction: positive goes
    past the target, negative stops short. Applies to a plane target and a face
    target alike. Before: the field was not read, so both cases ignored it."""
    doc = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 25},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": _PP_TOP, "upToPlane": "dp", "upToOffset": -3},
    ]}
    part, err, _ = rebuild(doc)
    assert not err, err
    assert abs(bbox(part)["max"][2] - 22) < 0.01, f"−3 must stop short at z=22, got {bbox(part)['max'][2]}"
    assert abs(part.volume - 10800) < 1, f"20x20x27 = 10800, got {part.volume:.1f}"

    # mirror on a FACE target: body2's bottom face sits at z=20, so −3 lands at 17
    face_doc = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "b2", "type": "box", "length": 8, "width": 8, "height": 10},
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 25, "rx": 0, "ry": 0, "rz": 0,
         "bodies": ["body2"]},  # body2 z 20..30
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0, "body": "body1",
         "face": _PP_TOP, "upTo": {"kind": "face", "by": "nearest", "point": [0, 0, 20]},
         "upToOffset": -3},
    ]}
    _p, ferr, fbodies = rebuild(face_doc)
    assert not ferr, ferr
    b1 = _pp_body(fbodies)
    assert abs(b1.bounding_box().max.Z - 17) < 0.01, f"face target −3 → z=17, got {b1.bounding_box().max.Z}"
    assert abs(b1.volume - 8800) < 1, f"20x20x22 = 8800, got {b1.volume:.1f}"

    # sign convention, in the direction where the two readings diverge: the top
    # face pushed DOWN to XY travels along −normal, so a POSITIVE offset still has
    # to go PAST z=0, not back up. Reading the offset off +normal instead of off
    # the travel direction inverts exactly this case.
    down = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "pp", "type": "press-pull", "operation": "cut", "distance": 0,
         "face": _PP_TOP, "upToPlane": "XY", "upToOffset": 2},
    ]}
    dp_, derr, _ = rebuild(down)
    assert not derr, derr
    assert abs(bbox(dp_)["max"][2] + 2) < 0.01, (
        f"pushing DOWN, +2 must land past the target at z=−2, got {bbox(dp_)['max'][2]}"
    )
    print("  press-pull up-to offset OK: plane −3 → z=22, face −3 → z=17, downward +2 → z=−2")


def test_presspull_upto_tilted_target_trims():
    """A TILTED target has to TRIM the extrusion, not extrude by one scalar.

    Before: the target was reduced to (centre, normal) and the distance measured at
    the source face's CENTRE, so the result was a flat-topped solid — right only
    along the centre line, silently wrong everywhere else, with err == [].

    Volume alone cannot catch this: the landing height is linear across the face, so
    a centred face's average height IS its centre height and both the wrong flat top
    and the correct wedge measure 12000. The witness is the SHAPE — the new top face
    must be the target plane itself."""
    n = [0, 0.7071067811865476, 0.7071067811865476]
    doc = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "dp", "type": "datumPlane",
         "plane": {"origin": [0, 0, 25], "normal": n, "xdir": [1, 0, 0]}},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": _PP_TOP, "upToPlane": "dp"},
    ]}
    part, err, _ = rebuild(doc)
    assert not err, err
    # the landing surface is z = 25 − y over x,y ∈ [−10,10]: 15 at y=+10, 35 at y=−10.
    # added material = ∫∫(20 − y) dx dy = 20·400 = 8000, on top of the 4000 box.
    bb = bbox(part)
    assert abs(bb["max"][2] - 35) < 0.01, f"the wedge peaks at z=35 (flat-top bug gives 25), got {bb['max'][2]}"
    assert abs(part.volume - 12000) < 1, f"4000 + 8000 wedge = 12000, got {part.volume:.1f}"
    top = max(part.faces(), key=lambda f: f.center().Z)
    from build123d import Vector
    assert abs(abs(top.normal_at().dot(Vector(*n))) - 1) < 1e-6, (
        f"the new top face must BE the target plane, got normal {top.normal_at()}"
    )

    # the same tilt through the SHIPPED path — an up-to FACE, not a datum. This is
    # where the flat top was actually measured (body1 came back z −5..25, vol 12000).
    face_doc = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "s", "type": "sketch",
         "plane": {"origin": [0, 0, 25], "normal": n, "xdir": [1, 0, 0]},
         "entities": [{"id": "r", "type": "rectangle", "width": 60, "height": 60, "x": 0, "y": 0}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 2, "operation": "new"},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0, "body": "body1",
         "face": _PP_TOP, "upTo": {"kind": "face", "by": "nearest", "point": [0, 0, 25]}},
    ]}
    _p, ferr, fbodies = rebuild(face_doc)
    assert not ferr, ferr
    b1 = _pp_body(fbodies)
    assert abs(b1.bounding_box().max.Z - 35) < 0.01, (
        f"tilted FACE target must trim too, got z_max {b1.bounding_box().max.Z}"
    )
    print(f"  press-pull up-to tilted OK: trimmed wedge z 15..35, vol {part.volume:.0f}")


def test_presspull_upto_refuses_through_body():
    """An up-to target past the body's FAR side used to consume the whole body:
    solids 0, volume 0, err == []. Same class as the boolean no-op guard — flag it
    red instead of deleting the model."""
    doc = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "b2", "type": "box", "length": 20, "width": 20, "height": 10},
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": -30, "rx": 0, "ry": 0, "rz": 0,
         "bodies": ["body2"]},  # body2 z −35..−25, well below body1
        {"id": "pp", "type": "press-pull", "operation": "cut", "distance": -1, "body": "body1",
         "face": _PP_TOP,
         "upTo": {"kind": "face", "by": "nearest", "point": [0, 0, -35]}},  # body2's BOTTOM
    ]}
    _part, err, bodies = rebuild(doc)
    assert err, "an up-to that eats the whole body must raise, not return an empty body"
    b1 = _pp_body(bodies)
    assert b1 is not None and len(b1.solids()) == 1 and abs(b1.volume - 4000) < 1, (
        f"the body must survive the refusal intact, got {b1 and b1.volume}"
    )
    print(f"  press-pull up-to through-body refused: {err[0]['message']}")


def test_presspull_upto_refuses_cylinder():
    """A CURVED source face has no single direction to measure to the target along.
    Before: `normal_at()` on the cylinder gave one arbitrary direction and the wall
    was offset by that scalar — a r5 h20 cylinder (1570.8 mm³) silently collapsed to
    15.7 mm³ with err == []."""
    doc = {"parameters": {}, "features": [
        {"id": "cy", "type": "cylinder", "radius": 5, "height": 20},
        {"id": "b2", "type": "box", "length": 10, "width": 10, "height": 4},
        {"id": "mv", "type": "move", "dx": 30, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0,
         "bodies": ["body2"]},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0, "body": "body1",
         "face": {"kind": "face", "by": "nearest", "point": [5, 0, 0]},  # the cylindrical wall
         "upTo": {"kind": "face", "by": "nearest", "point": [25, 0, 0]}},
    ]}
    _part, err, bodies = rebuild(doc)
    assert err, "an up-to on a curved source face must raise, not shrink the radius"
    b1 = _pp_body(bodies)
    assert abs(b1.volume - 1570.796) < 0.1, f"the cylinder must be untouched, got {b1.volume:.1f}"
    print(f"  press-pull up-to cylinder refused: {err[0]['message']}")


# The two-solid body every multi-solid check below starts from: a 4 mm slot cut
# clean across the 20x20x10 box splits body1 into x −10..−2 and x 2..10 — 2 solids,
# 3200 mm³, still ONE body. A single-solid box cannot see the bug this catches.
_PP_SPLIT_BODY = [
    _PP_BOX,
    {"id": "dpc", "type": "datumPlane", "plane": "XY", "offset": -10},
    {"id": "sk", "type": "sketch", "plane": "dpc",
     "entities": [{"id": "r", "type": "rectangle", "width": 4, "height": 40, "x": 0, "y": 0}]},
    {"id": "ec", "type": "extrude", "sketch": "sk", "distance": 20, "operation": "cut"},
]


def test_presspull_upto_refuses_deleting_one_solid():
    """An up-to cut past ONE solid's far side must refuse, even when other solids
    on the same body survive.

    The first guard tested emptiness (`not out.solids()`), which only fires when the
    body has nothing left. On a body an earlier cut split in two, a target past one
    piece's far side deleted that piece while the other kept the chip green:
    err == [], 2 solids / 3200 mm³ → 1 solid / 1600. The count is the witness, not
    the emptiness."""
    before, err0, bodies0 = rebuild({"parameters": {}, "features": list(_PP_SPLIT_BODY)})
    assert not err0, err0
    b0 = _pp_body(bodies0)
    assert len(b0.solids()) == 2 and abs(b0.volume - 3200) < 1, (
        f"setup must give 2 solids / 3200 mm³, got {len(b0.solids())} / {b0.volume:.1f}"
    )

    doc = {"parameters": {}, "features": _PP_SPLIT_BODY + [
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": -50},  # far below the box
        {"id": "pp", "type": "press-pull", "operation": "cut", "distance": 0, "body": "body1",
         "face": {"kind": "face", "by": "nearest", "point": [-6, 0, 5]},  # the LEFT piece's top
         "upToPlane": "dp"},
    ]}
    _p, err, bodies = rebuild(doc)
    assert err, "an up-to that eats a whole solid must raise, not delete it silently"
    b1 = _pp_body(bodies)
    assert len(b1.solids()) == 2 and abs(b1.volume - 3200) < 1, (
        f"both solids must survive the refusal, got {len(b1.solids())} / {b1.volume:.1f}"
    )

    # CONTROL — the count dropping is not by itself an error. A JOIN that bridges
    # two solids into one is a real, visible, correct outcome, and a guard that
    # looked at the count alone would refuse it. Two stacked slabs with a 10 mm gap,
    # one body; press the lower one's top up to the upper one's top plane.
    merge = {"parameters": {}, "features": [
        _PP_BOX,                                                            # z −5..5
        {"id": "b2", "type": "box", "length": 20, "width": 20, "height": 10},
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 20, "rx": 0, "ry": 0, "rz": 0,
         "bodies": ["body2"]},                                              # z 15..25
        {"id": "cb", "type": "combine", "operation": "join", "target": "body1",
         "tools": ["body2"]},                                               # 1 body, 2 solids
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 25},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0, "body": "body1",
         "face": _PP_TOP, "upToPlane": "dp"},
    ]}
    _pm, merr, mbodies = rebuild(merge)
    assert not merr, f"a join that merges two solids into one must still succeed: {merr}"
    bm = _pp_body(mbodies)
    assert len(bm.solids()) == 1, f"the bridging join should leave ONE solid, got {len(bm.solids())}"
    assert abs(bm.volume - 12000) < 1, f"20x20x30 = 12000, got {bm.volume:.1f}"
    print(f"  press-pull up-to one-solid delete refused: {err[0]['message']}")



def test_presspull_upto_guards_survive_their_own_blind_spots():
    """The two guards, at the boundaries where each was measured to fail.

    Both are third-round findings: the fixes for the obvious case left a narrower
    one open, and both failures are the same shape as the bug they replaced —
    geometry quietly gone, err == [].

    (a) SURVIVING is not the same as surviving the REBUILD. `_drop_debris` runs
    later on every body and deletes any solid under 0.1% of the biggest that is
    not touching it. A cut leaving a 0.16 mm³ crumb therefore passed a
    "remainder is non-empty" test and was swept away afterwards — the block gone
    with a green chip, exactly what the per-solid guard exists to stop.

    (b) The overshoot cap is a RATIO of the face's tilt term to the BODY's
    diagonal, so a small face on a large body defeats it: a 2x2 pip on a 200x200
    plate at 89.9° gave tilt 1620 against a 2830 budget and passed, while `d`
    itself — which that cap does not bound — reached 171,887 mm and built a
    172-metre spike. An angular floor is independent of both sizes."""
    # (a) the crumb. -30 clears the block entirely; -19.99 leaves 0.16 mm³ of it.
    for offset in (-30, -19.99):
        doc = {"parameters": {}, "features": _PP_RIB_AND_BLOCK + [
            {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": offset},
            {"id": "pp", "type": "press-pull", "operation": "cut", "distance": 0,
             "body": "body1", "face": _PP_RIB_TOP, "upToPlane": "dp"},
        ]}
        _p, err, bodies = rebuild(doc)
        assert err, f"datum {offset}: a solid reduced to debris must raise, not vanish later"
        assert "delete" in err[0]["message"], f"datum {offset}: say what is lost: {err}"
        b = _pp_body(bodies)
        assert len(b.solids()) == 2 and abs(b.volume - 5264) < 1, (
            f"datum {offset}: body must survive intact, got {len(b.solids())} / {b.volume:.1f}"
        )

    # (b) a SMALL face on a LARGE body. The pip sits on the plate (plate z -5..5,
    # pip z 5..7) so the join is one solid and the pip's top is a real 2x2 face.
    plate = [
        {"id": "b1", "type": "box", "length": 200, "width": 200, "height": 10},
        {"id": "b2", "type": "box", "length": 2, "width": 2, "height": 2},
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 6, "rx": 0, "ry": 0, "rz": 0,
         "bodies": ["body2"]},
        {"id": "cb", "type": "combine", "operation": "join", "target": "body1",
         "tools": ["body2"]},
    ]
    pip_top = {"kind": "face", "by": "nearest", "point": [0, 0, 7]}

    def aimed(deg):
        a = math.radians(deg)
        return {"parameters": {}, "features": plate + [
            {"id": "dp", "type": "datumPlane",
             "plane": {"origin": [0, 300, 7], "normal": [0, math.sin(a), math.cos(a)],
                       "xdir": [1, 0, 0]}},
            {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
             "body": "body1", "face": pip_top, "upToPlane": "dp"},
        ]}

    _p, err, bodies = rebuild(aimed(89.9))
    assert err, "a near edge-on target must be refused however small the face is"
    assert "edge-on" in err[0]["message"], f"name the reason: {err}"
    b = _pp_body(bodies)
    assert b.bounding_box().max.Z < 20, (
        f"the refusal must leave the part alone, got z_max {b.bounding_box().max.Z:.1f}"
    )
    return True


def test_presspull_upto_refuses_edge_on_target():
    """A target that is nearly EDGE-ON to the source face must be refused, not built.

    The overshoot the trimmed prism needs is span/|n·N| (see `_prism_to_plane`), which
    runs away long before the dead-parallel |n·N| < 1e-6 check fires. Measured on this
    20x20x10 box with the datum tilted off the face normal, err was [] and the result's
    z_max went 1151.9 mm at 89.5°, 5735.6 at 89.9°, 572963.8 at 89.999° — a metre-high
    spike and a full retessellation of it from one misjudged click. Those answers are
    geometrically CORRECT, which is exactly why nothing caught them; the cap is on
    blast radius, so the test has to check both sides of it."""
    from build123d import Vector

    def tilted(deg):
        a = math.radians(deg)
        return {"parameters": {}, "features": [
            _PP_BOX,
            {"id": "dp", "type": "datumPlane",
             "plane": {"origin": [0, 0, 6], "normal": [0, math.sin(a), math.cos(a)],
                       "xdir": [1, 0, 0]}},
            {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
             "face": _PP_TOP, "upToPlane": "dp"},
        ]}

    # LEGITIMATE tilts still build, and still build the RIGHT thing. These targets
    # CROSS the 20x20 top face (z = 6 − y·tan(deg) dips under z=5 at y = 1/tan), so
    # the witness is the SHAPE, not the volume: this row used to assert 4794.67 at
    # 30°, which is the volume of a result that carried the target plane over part
    # of the face and left 165.36 mm² of the ORIGINAL z=5 face standing over the
    # rest. A true up-to leaves none of it — and measures 4400.000, while the
    # earlier flat-top bug ALSO measured 4400, so the two wrongs are
    # volume-indistinguishable and only `_stranded_area` tells them apart.
    #
    # 30°: the plane stays above the box floor across the whole face, so the top
    #      simply follows it — 4000 + 20·∫(1 − y·tan30) dy = 4400.
    # 60°: it dips below z=−5 past y=6.35, so the box is cut clean away there and
    #      the volume is 20·∫(11 − y·tan60) dy over y ∈ [−10, 6.35] = 4630.645.
    for deg, vol, z_max in ((30.0, 4400.000, 11.7735), (60.0, 4630.645, 23.3205)):
        _p, err, bodies = rebuild(tilted(deg))
        assert not err, f"a {deg}° target is ordinary work and must still build: {err}"
        b1 = _pp_body(bodies)
        assert _stranded_area(b1, 5) < 1e-6, (
            f"{deg}°: {_stranded_area(b1, 5):.2f} mm² of the picked face is still at z=5 — "
            "'up to' means EVERY point of it reaches the target"
        )
        tn = Vector(0, math.sin(math.radians(deg)), math.cos(math.radians(deg)))
        on_target = [f for f in b1.faces() if abs(abs(f.normal_at().dot(tn)) - 1) < 1e-6]
        assert on_target and max(f.area for f in on_target) > 100, (
            f"{deg}°: no face of the result carries the target plane's normal"
        )
        assert abs(b1.volume - vol) < 0.01, f"{deg}°: expected {vol}, got {b1.volume:.3f}"
        assert abs(b1.bounding_box().max.Z - z_max) < 0.01, (
            f"{deg}°: expected z_max {z_max}, got {b1.bounding_box().max.Z:.3f}"
        )

    # ...just INSIDE the cap, a steep target is still ordinary work and must build.
    # The cap is span/|n·N| > 10·(body diagonal), i.e. about 84.6° for this box.
    _p84, err84, b84 = rebuild(tilted(84.0))
    assert not err84, f"84° is inside the cap and must build: {err84}"
    assert abs(_pp_body(b84).bounding_box().max.Z - 101.1436) < 0.01, (
        f"84° must reach the plane, got z_max {_pp_body(b84).bounding_box().max.Z:.4f}"
    )

    # ...and the runaway ones are refused, with the body left exactly as it was.
    for deg in (85.0, 89.5, 89.9, 89.999):
        _p, err, bodies = rebuild(tilted(deg))
        assert err, f"a {deg}° target must be refused, not built"
        assert "edge-on" in err[0]["message"], f"{deg}°: say WHY it was refused: {err}"
        b1 = _pp_body(bodies)
        assert abs(b1.volume - 4000) < 1 and abs(b1.bounding_box().max.Z - 5) < 1e-6, (
            f"{deg}°: the box must be untouched, got {b1.volume:.1f} / "
            f"z_max {b1.bounding_box().max.Z}"
        )
    print("  press-pull up-to edge-on refused: 30°/60° land whole on the target "
          "(nothing stranded at z=5), 84° builds, 85°+ refused")


def test_presspull_upto_refuses_coincident_target():
    """A target LEVEL with the source face is one ordinary gesture away — datum on a
    face, press T, click that datum — and used to return the part untouched with
    err == [], a green chip on an operation that did nothing. Same class as the
    boolean no-op guards, so it gets the same treatment: raise."""
    doc = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 5},  # ON the top face
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": _PP_TOP, "upToPlane": "dp"},
    ]}
    _p, err, bodies = rebuild(doc)
    assert err, "an up-to target level with the source face must raise, not report success"
    assert abs(_pp_body(bodies).volume - 4000) < 1, "the box must be untouched"

    # ...but a coincident target WITH an offset really does move the face, so the
    # guard has to be measured after the offset, not before it.
    doc["features"][-1] = dict(doc["features"][-1], upToOffset=4)
    _p2, err2, bodies2 = rebuild(doc)
    assert not err2, f"a coincident target plus an offset is a real move: {err2}"
    b2 = _pp_body(bodies2)
    assert abs(b2.bounding_box().max.Z - 9) < 0.01, f"+4 → z=9, got {b2.bounding_box().max.Z}"
    assert abs(b2.volume - 5600) < 1, f"20x20x14 = 5600, got {b2.volume:.1f}"
    print(f"  press-pull up-to coincident refused: {err[0]['message']}")


def test_presspull_upto_no_move_guard_measures_the_whole_face():
    """The no-move guard has to ask whether the face moves ANYWHERE, not whether it
    moves at its CENTRE.

    Measuring at the centre refused every target that merely passed THROUGH it: a
    datum on the top face tilted 45° about X was rejected as "already level with the
    face you picked" while the plane climbed to z=15 at y=−10 — a 10 mm move over
    half the face, called nothing. And it was a cliff, not a boundary: nudging that
    datum to z=5.0000001 built and ADDED 1000 mm³, to z=4.9999999 CUT 1000 mm³, so
    2e-7 mm of datum flipped the outcome across −1000 / refused / +1000."""
    from build123d import Vector

    def through_centre(deg, z=5.0):
        a = math.radians(deg)
        return {"parameters": {}, "features": [
            _PP_BOX,
            {"id": "dp", "type": "datumPlane",
             "plane": {"origin": [0, 0, z], "normal": [0, math.sin(a), math.cos(a)],
                       "xdir": [1, 0, 0]}},
            {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
             "face": _PP_TOP, "upToPlane": "dp"},
        ]}

    # A tilted target through the face centre is a real move at every one of these
    # angles, and the answer is CONTINUOUS across the datum height that used to be
    # a cliff. Volume is unchanged by symmetry (what the plane adds on y<0 it takes
    # on y>0), which is exactly why the shape is the assertion.
    for deg, z_max in ((10.0, 6.7632), (45.0, 15.0), (80.0, 61.7128)):
        heights = [None, None, None]
        for i, z in enumerate((5.0, 5.0000001, 4.9999999)):
            _p, err, bodies = rebuild(through_centre(deg, z))
            assert not err, f"{deg}° through the face centre is a real move: {err}"
            b1 = _pp_body(bodies)
            assert _stranded_area(b1, 5) < 1e-6, (
                f"{deg}° @ z={z}: {_stranded_area(b1, 5):.2f} mm² of the face never moved"
            )
            assert abs(b1.bounding_box().max.Z - z_max) < 0.01, (
                f"{deg}° @ z={z}: the plane peaks at z={z_max}, got {b1.bounding_box().max.Z:.4f}"
            )
            tn = Vector(0, math.sin(math.radians(deg)), math.cos(math.radians(deg)))
            on_target = [f for f in b1.faces()
                         if abs(abs(f.normal_at().dot(tn)) - 1) < 1e-6]
            assert on_target and max(f.area for f in on_target) > 100, (
                f"{deg}° @ {z}: no face of the result carries the target plane's normal"
            )
            heights[i] = b1.volume
        assert max(heights) - min(heights) < 1e-3, (
            f"{deg}°: 2e-7 mm of datum must not change the volume, got {heights}"
        )
    # 45° through the centre: +1000 mm³ of wedge on y<0, −1000 on y>0.
    _p45, _e45, b45 = rebuild(through_centre(45.0))
    assert abs(_pp_body(b45).volume - 4000) < 0.01, (
        f"45° through the centre is volume-neutral, got {_pp_body(b45).volume:.3f}"
    )

    # CONTROL, just inside the boundary the guard still owns: a target PARALLEL to
    # the face moves it by the same amount everywhere, so "level with the face" is
    # still exactly the no-op it always was and must still be refused...
    level = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 5},
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
         "face": _PP_TOP, "upToPlane": "dp"},
    ]}
    _pl, lerr, lbodies = rebuild(level)
    assert lerr and "moved nothing" in lerr[0]["message"], (
        f"a target level with the face is still a no-op and must raise: {lerr}"
    )
    assert abs(_pp_body(lbodies).volume - 4000) < 1e-6, "the refused box must be untouched"

    # ...and a parallel target a thousandth of a millimetre off it is a real move.
    level["features"][1] = dict(level["features"][1], offset=5.001)
    _pn, nerr, nbodies = rebuild(level)
    assert not nerr, f"a 0.001 mm parallel move is real and must build: {nerr}"
    assert abs(_pp_body(nbodies).volume - 4000.4) < 1e-3, (
        f"20x20x0.001 = 0.4 mm³ added, got {_pp_body(nbodies).volume:.4f}"
    )

    # CONTROL on a TILTED source face, where "measure the whole face" is easiest to
    # get wrong: the face's bounding box has corners OFF its own plane, and reading
    # the target distance at those raw corners shows movement on a target that is
    # dead coincident. Box rotated 45° about X, datum laid exactly on its new top.
    r = math.sqrt(0.5)
    tc, tn = [0, -5 * r, 5 * r], [0, -r, r]

    def on_tilted_face(origin):
        return {"parameters": {}, "features": [
            _PP_BOX,
            {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": 0,
             "rx": 45, "ry": 0, "rz": 0, "bodies": ["body1"]},
            {"id": "dp", "type": "datumPlane",
             "plane": {"origin": origin, "normal": tn, "xdir": [1, 0, 0]}},
            {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
             "face": {"kind": "face", "by": "nearest", "point": tc}, "upToPlane": "dp"},
        ]}

    _pt, terr, tbodies = rebuild(on_tilted_face(tc))
    assert terr and "moved nothing" in terr[0]["message"], (
        f"a target coincident with a TILTED face is still a no-op and must raise: {terr}"
    )
    assert abs(_pp_body(tbodies).volume - 4000) < 1e-6, "the refused box must be untouched"
    _pm, merr, mbodies = rebuild(on_tilted_face([tc[i] + 2 * tn[i] for i in range(3)]))
    assert not merr, f"2 mm off that same tilted face is a real move: {merr}"
    assert abs(_pp_body(mbodies).volume - 4800) < 1e-3, (
        f"400 mm² x 2 mm = 800 mm³ added, got {_pp_body(mbodies).volume:.4f}"
    )
    print("  press-pull up-to no-move guard OK: tilted-through-centre builds at "
          "10°/45°/80° and is continuous across 2e-7 mm; level still refused, on a "
          "tilted face too")


def test_presspull_upto_refuses_deleting_a_split_solid():
    """The through-body guard must test each solid, not the solid COUNT.

    Counting made a cut that deletes one solid while SPLITTING another look like no
    change at all: on the rib+plate+block body below (2 solids / 5264 mm³) a cut
    down the rib to z=−30 removed the rib, split the plate in two and ate the 4x4x4
    block whole — 2 solids in, 2 solids out, err == [], and 64 mm³ of the user's
    model gone under a green chip (5264 − 1200 − 1200 − 64 = 2800)."""
    _b, err0, bodies0 = rebuild({"parameters": {}, "features": list(_PP_RIB_AND_BLOCK)})
    assert not err0, err0
    b0 = _pp_body(bodies0)
    assert len(b0.solids()) == 2 and abs(b0.volume - 5264) < 1, (
        f"setup must give 2 solids / 5264 mm³, got {len(b0.solids())} / {b0.volume:.1f}"
    )

    def cut_to(offset):
        return {"parameters": {}, "features": _PP_RIB_AND_BLOCK + [
            {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": offset},
            {"id": "pp", "type": "press-pull", "operation": "cut", "distance": 0,
             "body": "body1", "face": _PP_RIB_TOP, "upToPlane": "dp"},
        ]}

    _p, err, bodies = rebuild(cut_to(-30))  # past the block's far side
    assert err, "a cut that consumes a whole solid must raise even when the count holds"
    assert "delete" in err[0]["message"], f"say what would be lost: {err}"
    b1 = _pp_body(bodies)
    assert len(b1.solids()) == 2 and abs(b1.volume - 5264) < 1, (
        f"the body must survive the refusal intact, got {len(b1.solids())} / {b1.volume:.1f}"
    )

    # CONTROL, just inside the boundary: the same cut stopped at z=−6 — below the
    # plate, above the block. It still SPLITS the plate in two (2 solids → 3), which
    # is ordinary work; nothing disappears, so nothing may be refused.
    _pc, cerr, cbodies = rebuild(cut_to(-6))
    assert not cerr, f"a cut that only splits a solid must still build: {cerr}"
    bc = _pp_body(cbodies)
    assert len(bc.solids()) == 3, f"the plate splits in two, block survives → 3, got {len(bc.solids())}"
    assert abs(bc.volume - 2864) < 1, f"5264 − 1200 rib − 1200 slot = 2864, got {bc.volume:.1f}"
    print(f"  press-pull up-to split-solid delete refused: {err[0]['message']}")


def test_presspull_upto_far_square_on_target_builds():
    """A target that is FAR but dead square-on is a legitimate long extrude.

    The blast-radius cap folded the prism's numeric slack, `max(1, 0.01·|d|)`, into
    the quantity it capped, so |n·N| == 1.0 — square-on by any reading — was refused
    above roughly 1000x the body diagonal with the message "too close to edge-on".
    Measured on this box: 27,000 mm built and 28,000 mm did not."""
    def to_offset(o):
        return {"parameters": {}, "features": [
            _PP_BOX,
            {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": o},
            {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
             "face": _PP_TOP, "upToPlane": "dp"},
        ]}

    for o in (27000, 28000, 50000):
        _p, err, bodies = rebuild(to_offset(o))
        assert not err, f"a square-on target at {o} mm is a long extrude, not edge-on: {err}"
        b1 = _pp_body(bodies)
        assert abs(b1.bounding_box().max.Z - o) < 0.01, (
            f"{o}: must land ON the target, got z_max {b1.bounding_box().max.Z}"
        )
        assert abs(b1.volume - 400 * (o + 5)) < 1, (
            f"{o}: 20x20x{o + 5} = {400 * (o + 5)}, got {b1.volume:.1f}"
        )
    print("  press-pull up-to far square-on target OK: 27000 / 28000 / 50000 mm all build")


def test_presspull_upto_plane_missing_says_why():
    """An `upToPlane` id that isn't a live datum has FOUR causes needing opposite
    fixes, and the guard used to report the ordering one for all of them — telling a
    user whose datum was DELETED that it "has to come BEFORE" the press/pull, the
    inverse of the truth. The id is document text, so it rides in `subject`, never in
    the sentence."""
    def run(features):
        _p, err, _b = rebuild({"parameters": {}, "features": features})
        # pick the PRESS/PULL's entry: case (d) below breaks the datum on purpose,
        # so that feature reports first and err[0] would be the wrong error.
        mine = [e for e in err if e["feature_id"] == "pp"]
        assert mine, f"a bad up-to plane must raise on the press/pull: {err}"
        return mine[0]

    pp = {"id": "pp", "type": "press-pull", "operation": "join", "distance": 0,
          "face": _PP_TOP}
    datum = {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 25}

    # (a) defined LATER — the one case the old message was right about
    later = run([_PP_BOX, dict(pp, upToPlane="dp"), datum])
    assert "timeline" in later["message"] and "BEFORE" in later["message"], later

    # (b) not in the document at all (the datum was deleted)
    gone = run([_PP_BOX, dict(pp, upToPlane="dp")])
    assert "BEFORE" not in gone["message"], f"a deleted datum is not an ordering problem: {gone}"
    assert "delete" in gone["message"].lower(), gone

    # (c) points at a feature that exists but is not a datum plane
    wrong = run([_PP_BOX, dict(pp, upToPlane="b1")])
    assert "BEFORE" not in wrong["message"] and "datum plane" in wrong["message"], wrong

    # (d) the datum is upstream but its own feature failed, so it never registered
    broken = run([_PP_BOX,
                  {"id": "dp", "type": "datumPlane", "plane": "nope", "offset": 25},
                  dict(pp, upToPlane="dp")])
    assert "BEFORE" not in broken["message"] and "didn't build" in broken["message"], broken

    # the id itself never reaches the prose — it rides in `subject`, sanitised
    for e in (later, gone, wrong, broken):
        assert "dp" not in e["message"].split() and "b1" not in e["message"].split(), (
            f"the document's id must not be echoed into the sentence: {e['message']}"
        )
    assert gone["subject"] == "dp" and wrong["subject"] == "b1", (gone, wrong)
    print("  press-pull up-to missing plane diagnosed: later / deleted / not-a-datum / "
          "failed, id in `subject`")


def test_presspull_offset_needs_a_target():
    """`upToOffset` with no up-to target was READ and then thrown away: `d` fell back
    to `distance`, so a 3 mm push with a 7 mm offset moved 3 mm with err == [] and the
    typed 7 vanished. Refuse it — a wire that silently drops a number the user typed
    is the same silent class as a boolean that changes nothing."""
    doc = {"parameters": {}, "features": [
        _PP_BOX,
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 3,
         "face": _PP_TOP, "upToOffset": 7},
    ]}
    _p, err, bodies = rebuild(doc)
    assert err, "an offset with nothing to offset FROM must be refused, not dropped"
    b1 = _pp_body(bodies)
    assert abs(b1.bounding_box().max.Z - 5) < 1e-6, (
        f"the refused feature must leave the box alone, got z_max {b1.bounding_box().max.Z}"
    )

    # a ZERO offset drops nothing, so it stays valid — a client that always sends
    # the field must not start failing.
    doc["features"][-1] = dict(doc["features"][-1], upToOffset=0)
    _p2, err2, bodies2 = rebuild(doc)
    assert not err2, f"upToOffset 0 without a target is harmless and must build: {err2}"
    assert abs(_pp_body(bodies2).bounding_box().max.Z - 8) < 1e-6, "plain distance 3 → z=8"
    print(f"  press-pull offset without a target refused: {err[0]['message']}")



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


def test_offset_face_and_thicken():
    """Offset Face moves selected faces along their normals (single and multi-face,
    the latter exercising resolve_faces' list branch); Thicken gives faces a wall.
    Both must REFUSE non-prismatic faces and faceted mesh imports rather than
    letting OCCT's BRepOffset segfault the sidecar."""
    from build123d import Cylinder
    _s, base = _box(1, 20, 20, 10)  # 20×20×10 = 4000
    top = {"kind": "face", "by": "normal", "dir": [0, 0, 1]}
    side = {"kind": "face", "by": "normal", "dir": [1, 0, 0]}

    def build(*extra):
        return rebuild({"parameters": {}, "features": base + list(extra)})

    # single planar face, out and in
    p, e, _ = build({"id": "of", "type": "offsetFace", "faces": top, "distance": 2})
    assert not e, e
    assert abs(p.volume - 4800) < 1, f"offset top +2 → 20×20×12, got {p.volume:.0f}"
    p, e, _ = build({"id": "of", "type": "offsetFace", "faces": top, "distance": -3})
    assert not e, e
    assert abs(p.volume - 2800) < 1, f"offset top -3 → 20×20×7, got {p.volume:.0f}"

    # two faces in ONE offset pass — a list selector (resolve_faces list branch)
    p, e, _ = build({"id": "of", "type": "offsetFace", "faces": [top, side], "distance": 2})
    assert not e, e
    assert abs(p.volume - 5280) < 1, f"offset top+side +2 → 22×20×12, got {p.volume:.0f}"

    # thicken: new body (default), symmetric doubles it, join merges
    p, e, bodies = build({"id": "th", "type": "thicken", "faces": top, "thickness": 2})
    assert not e, e
    assert len(bodies) == 2, f"thicken defaults to a new body, got {len(bodies)}"
    assert abs(bodies[1]["shape"].volume - 800) < 1, "thickened top face → 20×20×2"
    _p, e, bodies = build({"id": "th", "type": "thicken", "faces": top, "thickness": 2, "symmetric": True})
    assert not e, e
    assert abs(bodies[1]["shape"].volume - 1600) < 1, "symmetric thicken spans both sides"
    p, e, bodies = build({"id": "th", "type": "thicken", "faces": top, "thickness": 2, "operation": "join"})
    assert not e, e
    assert len(bodies) == 1 and abs(p.volume - 4800) < 1, "join merges into the source body"

    # refusals must be clean ValueErrors (feature errors), never a crash
    _p, e, _ = rebuild({"parameters": {}, "features": [
        {"id": "sp", "type": "sphere", "radius": 10},
        {"id": "of", "type": "offsetFace", "faces": {"kind": "face", "by": "all"}, "distance": 1}]})
    assert e and "flat and cylindrical" in e[0]["message"], f"sphere must be refused, got {e}"
    _p, e, _ = build({"id": "th", "type": "thicken", "faces": top, "thickness": 0})
    assert e and "thickness is zero" in e[0]["message"], f"zero thicken must be refused, got {e}"

    # An imported STL body: since GH #49 `_fit_surfaces` recognises the wall, so
    # this cylinder arrives as 3 faces (1 Cylinder, 2 Plane) rather than the 26
    # planes `_refacet_clean` used to leave. Offsetting the top cap MUST still
    # work — this pins the deliberate decision not to blanket-refuse "faceted"
    # bodies, and it is also the control on the refuse-don't-dent screen: the
    # cap's neighbours sit at 90 degrees, so nothing about it reads as one facet
    # of an unrecognised curve. (Meshes that don't reduce are already rejected at
    # import by MAX_IMPORT_FACES, and server.py's out-of-process worker is the
    # backstop if OCCT still crashes.)
    d = tempfile.mkdtemp()
    path = os.path.join(d, "cyl.stl")
    export(Cylinder(6, 20), "stl", path)
    mesh = [{"id": "im", "type": "import", "format": "stl", "name": "cyl",
             "geom": import_geometry(path, "stl")["geom"]}]
    _p, e, bodies = rebuild({"parameters": {}, "features": mesh})
    before = bodies[0]["shape"].volume
    _p, e, bodies = rebuild({"parameters": {}, "features": mesh + [
        {"id": "of", "type": "offsetFace", "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "distance": 2}]})
    assert not e, f"offsetting a cleaned mesh import should work, got {e}"
    assert bodies[0]["shape"].volume > before + 100, "the offset should have added material"
    print("  offset-face/thicken OK: 4800/2800/5280, thicken 800/1600/join, sphere refused, STL import offsets")


def test_simplify_mesh():
    """Simplify Mesh cuts the facet count of a body that is STILL FACETED, while
    the volume is preserved within tolerance.

    RE-BLESSED for GH #49. The old fixture was a dense cylinder STL, on the
    reading that a cylinder mesh is what "still faceted" looks like. Surface
    fitting made that false: the same file now imports as 3 faces (one real
    Cylinder and two caps) and Simplify Mesh on it is 3 -> 3, so the strict
    reduction the test existed to pin had quietly become impossible to observe.
    The intent is unchanged and the body is different: a CONE, which v1 does not
    fit, so it arrives as hundreds of leftover facets with real work left to do.
    The cylinder stays as the control on the other side of that: a body the
    importer already made analytic has nothing for Simplify Mesh to take away,
    and it must not damage it either."""
    from build123d import Cone, Cylinder
    d = tempfile.mkdtemp()

    p = os.path.join(d, "cone.stl")
    export(Cone(8, 0, 20), "stl", p)
    payload = import_geometry(p, "stl")
    doc = {"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "cone", "geom": payload["geom"]}]}
    base, e0, _ = rebuild(doc)
    f_before = len(base.faces())
    doc["features"].append({"id": "sm", "type": "simplifyMesh", "tolerance": 15})
    simp, e1, _ = rebuild(doc)
    f_after = len(simp.faces())
    assert not e0 and not e1, (e0, e1)
    # Measured 483 -> 62 (volume 1340.1593 -> 1338.9263). The bar is a real cut,
    # not the exact number, which moves with the tessellator.
    assert f_before > 100, (
        f"the fixture must still be faceted for this to test anything, got "
        f"{f_before} faces")
    assert f_after < f_before / 2, \
        f"simplify should roughly halve a faceted cone ({f_before}→{f_after})"
    assert abs(simp.volume - base.volume) / base.volume < 0.1, "volume should stay close"

    # The control: an import the fitter already turned into analytic faces.
    pc = os.path.join(d, "cyl.stl")
    export(Cylinder(6, 20), "stl", pc)
    cyl_payload = import_geometry(pc, "stl")
    cdoc = {"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "cyl",
         "geom": cyl_payload["geom"]},
        {"id": "sm", "type": "simplifyMesh", "tolerance": 15}]}
    csimp, e2, _ = rebuild(cdoc)
    assert not e2, e2
    assert len(csimp.faces()) == 3, (
        f"a fitted cylinder is already 3 faces; Simplify Mesh must leave it "
        f"alone, got {len(csimp.faces())}")
    assert abs(csimp.volume - 2261.9467) < 1.0, (
        f"Simplify Mesh damaged an analytic body: vol {csimp.volume:.4f}")
    print(f"  simplify-mesh OK: faceted cone {f_before}→{f_after} faces, vol "
          f"{simp.volume:.0f}; a fitted cylinder stays at 3 faces")


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


def test_revolve_loft_operation():
    """Revolve/Loft used to always do `act["shape"] = solid` onto the active body
    when one existed -- silently DISCARDING it, no boolean, no warning. They now
    thread `operation` through the same `_boolean_into_bodies` extrude uses.
    Absent `operation` still defaults to "new", so an old document that relied on
    the silent overwrite now gets a separate body instead -- a deliberate behavior
    change that closes the data-loss bug (the old overwrite is the bug)."""
    _s, base = _box(1, 30, 30, 10)  # body1: x/y=-15..15, z=0..10, vol 9000

    # Ring profile on the XZ plane (u=X, v=Z): a 10x10 square offset to x=5..15,
    # revolved 360 deg around Z makes a tube (outer r=15, inner r=5, z=-5..5) that
    # overlaps the base body's footprint and pokes out below its z=0 floor.
    ring = {"id": "rs", "type": "sketch", "plane": "XZ",
            "entities": [{"type": "rectangle", "width": 10, "height": 10, "x": 10}]}

    # (a) operation absent -> defaults to "new": a separate body, base untouched.
    rev_new = {"id": "rv", "type": "revolve", "sketch": "rs", "axis": "Z", "angle": 360}
    _p, err, bodies = rebuild({"parameters": {}, "features": base + [ring, rev_new]})
    assert not err, err
    assert len(bodies) == 2, f"revolve with no operation should add a body, got {len(bodies)}"
    assert abs(bodies[0]["shape"].volume - 9000) < 1, \
        f"base body must be untouched, got {bodies[0]['shape'].volume:.0f}"

    # (b) operation "join" onto the overlapping base body -> ONE merged body,
    # heavier than the base alone (material actually added, not discarded).
    rev_join = {"id": "rv", "type": "revolve", "sketch": "rs", "axis": "Z", "angle": 360, "operation": "join"}
    _p, err, bodies = rebuild({"parameters": {}, "features": base + [ring, rev_join]})
    assert not err, err
    assert len(bodies) == 1, f"join onto an overlapping body should merge -> 1, got {len(bodies)}"
    assert bodies[0]["shape"].volume > 9000 + 1, \
        f"join should add material over the base's 9000, got {bodies[0]['shape'].volume:.0f}"
    print(f"  revolve operation OK: no-op-field -> 2 bodies base untouched; "
          f"join -> 1 body vol {bodies[0]['shape'].volume:.0f} > 9000")

    # (c) loft equivalent of (a): a frustum profile (10x10 base, 5x5 top @ z=10),
    # operation absent -> a separate body, base untouched.
    lb = {"id": "lb", "type": "sketch", "plane": "XY",
          "entities": [{"type": "rectangle", "width": 10, "height": 10}]}
    lt = {"id": "lt", "type": "sketch",
          "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
          "entities": [{"type": "rectangle", "width": 5, "height": 5}]}
    loft_new = {"id": "lf", "type": "loft", "sketches": ["lb", "lt"]}
    _p, err, bodies = rebuild({"parameters": {}, "features": base + [lb, lt, loft_new]})
    assert not err, err
    assert len(bodies) == 2, f"loft with no operation should add a body, got {len(bodies)}"
    assert abs(bodies[0]["shape"].volume - 9000) < 1, \
        f"base body must be untouched, got {bodies[0]['shape'].volume:.0f}"
    assert bodies[1]["shape"].volume > 0, "the lofted frustum should have volume"
    print(f"  loft operation OK: no-op-field -> 2 bodies base untouched, "
          f"frustum vol {bodies[1]['shape'].volume:.0f}")


def test_loft_profiles_keeps_holes_as_tube():
    """Fusion-flow loft: lofting the SELECTED ring profiles (region anchors on two
    sketches) keeps each ring's hole, so two concentric-circle rings blend into a
    hollow TUBE — not a solid cone (the whole-sketch loft lofts the outer wire
    only). Volume = outer frustum (r25->r16) minus inner frustum (r20->r13.178)."""
    ring_lo = {"id": "s1", "type": "sketch", "plane": "XY", "entities": [
        {"type": "circle", "id": "a", "x": 0, "y": 0, "radius": 25},
        {"type": "circle", "id": "b", "x": 0, "y": 0, "radius": 20}]}
    ring_hi = {"id": "s2", "type": "sketch",
               "plane": {"origin": [0, 0, 24], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
               "entities": [
                   {"type": "circle", "id": "c", "x": 0, "y": 0, "radius": 16},
                   {"type": "circle", "id": "d", "x": 0, "y": 0, "radius": 13.178}]}
    lf = {"id": "lf", "type": "loft", "operation": "new", "profiles": [
        {"sketch": "s1", "region": [22.5, 0, 0]},   # anchor in the lower ring
        {"sketch": "s2", "region": [14.5, 0, 24]}]}  # anchor in the upper ring
    _p, err, bodies = rebuild({"parameters": {}, "features": [ring_lo, ring_hi, lf]})
    assert not err, err
    assert len(bodies) == 1, f"loft new -> 1 body, got {len(bodies)}"
    vol = bodies[0]["shape"].volume
    # a solid cone would be ~32191; the tube is ~11153 (hole preserved)
    assert 11000 < vol < 11300, f"expected a hollow tube (~11153), got {vol:.0f} (a cone would be ~32191)"
    assert len(bodies[0]["shape"].faces()) == 4, "tube = outer + inner side + 2 end rings"
    print(f"  loft profiles OK: two rings -> hollow tube vol {vol:.0f} (hole kept)")


def test_region_stale_diagnostic():
    """A stored region point that lands inside NO cell falls back to the nearest
    one. That fallback exists for tessellation drift, so a hair-off point stays
    silent — but a point nowhere near any profile is a stale reference, and
    silently extruding a different area is how a user cuts geometry they never
    selected. It must announce itself as `regionStale` while still building.

    The control matters as much as the case: field report a20cca53 (drag a
    circle, the extrude jumps to the surrounding rectangle) does NOT come through
    here. There the stale point lands INSIDE a genuinely different cell, so
    containment succeeds and this fallback never runs. Entity-anchored regions
    are what fix that one; this only stops the no-containing-cell case being
    silent. If this control ever starts emitting a diagnostic, the two failures
    have been conflated again."""
    circles = [{"id": "cA", "type": "circle", "radius": 4, "x": 10, "y": 10},
               {"id": "cB", "type": "circle", "radius": 4, "x": 30, "y": 14}]

    def run(pt, ents):
        diag = []
        doc = {"parameters": {}, "features": [
            {"id": "s1", "type": "sketch", "plane": "XY", "entities": ents},
            {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 5,
             "operation": "new", "regions": [pt]}]}
        _p, err, bodies = rebuild(doc, diagnostics=diag)
        return err, bodies, [d for d in diag if d.get("kind") == "regionStale"]

    err, bodies, stale = run([500, 500, 0], circles)
    assert not err, f"a stale region must still build (nearest cell): {err}"
    assert bodies, "stale region should still produce a body"
    assert len(stale) == 1, f"far-outside point must warn, got {stale}"
    assert stale[0]["feature_id"] == "ex" and stale[0]["lossy"] is True, stale[0]
    assert len(stale[0]["at"]) == 3 and stale[0]["offBy"] > 1, stale[0]

    _err, _b, stale = run([10, 10 + 1e-7, 0], circles)
    assert not stale, f"tessellation drift is what the fallback is for: {stale}"

    # control: a20cca53's shape — the point lands in the rectangle's cell
    rect = [{"id": f"l{i}", "type": "line", "x1": a, "y1": b, "x2": c, "y2": d}
            for i, (a, b, c, d) in enumerate(
                [(0, 0, 40, 0), (40, 0, 40, 20), (40, 20, 0, 20), (0, 20, 0, 0)])]
    _err, _b, stale = run([10, 10, 0], rect + circles)
    assert not stale, \
        f"containment succeeded on a different cell — not this code path: {stale}"
    print("  region-stale OK: far point warns + still builds; drift silent; "
          "a20cca53's wrong-cell hit is a different path")


def test_region_follows_a_moved_entity():
    """Field report a20cca53, end to end: extrude one of two circles sitting in a
    rectangle, then drag that circle elsewhere in the sketch. The extrude must
    stay on the circle.

    Without `regionEntities` the stored point stays where the circle used to be,
    lands inside the rectangle's cell, and the rectangle is extruded — a block
    with holes instead of a peg. That is the reported bug, and it is asserted
    here as the LEGACY control so the fallback is not quietly changed: every
    document written before this field existed still resolves that way."""
    rect = [(0, 0, 40, 0), (40, 0, 40, 20), (40, 20, 0, 20), (0, 20, 0, 0)]
    R = 4.0
    disc = math.pi * R * R * 5              # the peg
    block = (40 * 20 - 2 * math.pi * R * R) * 5   # the plate, two holes

    def run(cx, cy, with_entities):
        ents = [{"id": f"l{i}", "type": "line", "x1": a, "y1": b, "x2": c, "y2": d}
                for i, (a, b, c, d) in enumerate(rect)] + [
            {"id": "cA", "type": "circle", "radius": R, "x": cx, "y": cy},
            {"id": "cB", "type": "circle", "radius": R, "x": 30, "y": 14}]
        ex = {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 5,
              "operation": "new", "regions": [[10, 10, 0]]}  # picked on cA at (10,10)
        if with_entities:
            ex["regionEntities"] = [["cA"]]
        part, err, _ = rebuild({"parameters": {}, "features": [
            {"id": "s1", "type": "sketch", "plane": "XY", "entities": ents}, ex]})
        assert not err, err
        return part.volume

    assert abs(run(10, 10, True) - disc) < 1, "unmoved: must be the circle"
    moved = run(25, 6, True)
    assert abs(moved - disc) < 1, \
        f"the extrude must follow the circle it was picked on, got {moved:.1f}"

    legacy = run(25, 6, False)
    assert abs(legacy - block) < 1, \
        f"legacy point-only docs must keep resolving by point, got {legacy:.1f}"

    # An id naming an entity that no longer exists is stale, not moved: fall back
    # to the point rather than inventing an anchor.
    ents = [{"id": f"l{i}", "type": "line", "x1": a, "y1": b, "x2": c, "y2": d}
            for i, (a, b, c, d) in enumerate(rect)] + [
        {"id": "cB", "type": "circle", "radius": R, "x": 30, "y": 14}]
    part, err, _ = rebuild({"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": ents},
        {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 5,
         "operation": "new", "regions": [[10, 10, 0]],
         "regionEntities": [["cA"]]}]})
    assert not err, f"a deleted entity must not break the build: {err}"
    assert part is not None, "a deleted entity must still resolve by point"
    print("  a20cca53 OK: extrude follows a moved circle; legacy point-only and "
          "deleted-entity docs both fall back")


def _holed_sketch(kind, x, y):
    """The two field-report profiles, centred on (x,y).

    shell: 100x100 outer, 80x80 inner — a 3600mm2 wall around a 6400mm2 hole, so
    the hole is the BIGGER face and "the region is the biggest cell" picks it.
    plate: 60x60 outer, r20 hole — a centred hole big enough to swallow the point
    an outer-loop-only rebuild yields (measured: `center()` of the solid outer
    face, i.e. dead centre, and the triangle centroid 14.1mm out if that is ever
    the fallback again). r10 was NOT big enough and made the case theatre."""
    if kind == "shell":
        return [{"id": "outer", "type": "rectangle", "width": 100, "height": 100,
                 "x": x, "y": y},
                {"id": "inner", "type": "rectangle", "width": 80, "height": 80,
                 "x": x, "y": y}]
    return [{"id": "p", "type": "rectangle", "width": 60, "height": 60,
             "x": x, "y": y},
            {"id": "h", "type": "circle", "radius": 20, "x": x, "y": y}]


def test_holed_region_anchors_in_the_wall():
    """Field report 19314fdc: "Two rectangles like a shell cross-section. Extrude
    the shell wall. The result is never the shell, but the inside loop extrusion."

    `regionEntities` names the region's OUTER loop only, so the wall rebuilt as a
    SOLID 100x100 and the point taken from it sat in the 80x80 hole. Cutting the
    holes out is what fixes it, and it has to be a real boolean: the wall is
    3600mm2 against a 6400mm2 hole, so "the region is the biggest face" picks the
    HOLE and reproduces the bug with more code behind it. That number is asserted
    by name below so a future area heuristic fails here loudly.

    Every case here is either MOVED or LEGACY, because those are the only two
    documents where the stored point is not already the right answer — on an
    unmoved post-0.1.144 document the fallback is correct and NOTHING about this
    change is observable through the volume. (The unmoved profiles are pinned
    where they can be: on the anchor itself, in
    `test_region_anchor_refuses_and_keeps_a_correct_cell`.)

    LEGACY is the case with no drift at all. 0.1.123 through 0.1.144 shipped
    `regionEntities` WITHOUT `regionHoleEntities`, so no "does this region have
    holes" test can see those documents — the outer loop rebuilds solid, the
    anchor lands in the hole, and the reported bug is still live on every file
    they saved. Comparing the rebuilt profile against the cell it resolved to is
    what catches that, because a correct anchor matches its cell exactly (measured
    bit-equal, curved boundaries included)."""
    def build(kind, x, y, hole_ids, pt):
        ex = {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 5,
              "operation": "new", "regions": [list(pt)],   # picked in the material
              "regionEntities": [["outer" if kind == "shell" else "p"]]}
        if hole_ids is not None:
            ex["regionHoleEntities"] = [hole_ids]
        part, err, _ = rebuild({"parameters": {}, "features": [
            {"id": "s1", "type": "sketch", "plane": "XY",
             "entities": _holed_sketch(kind, x, y)}, ex]})
        assert not err, err
        return part.volume

    def shell(x, y, hole_ids, pt=(45, 0, 0)):
        return build("shell", x, y, hole_ids, pt)

    WALL, HOLE = 3600 * 5, 6400 * 5
    # The whole point of anchoring: move BOTH rectangles and leave the stored
    # point behind. (45,0) is now inside the hole, so the point alone extrudes it.
    moved = shell(30, 20, [["inner"]])
    assert abs(moved - WALL) < 1, \
        f"a moved shell must still extrude its wall, got {moved:.1f} " \
        f"({HOLE} is field 19314fdc, the hole)"

    # LEGACY, and NOT moved: this is the shipped-beta document, and the anchor it
    # produces is inside the hole with no drift involved at all.
    legacy = shell(0, 0, None)
    assert abs(legacy - WALL) < 1, \
        f"a document with no hole ids must fall back to the stored point, " \
        f"got {legacy:.1f} — {HOLE} is field 19314fdc, still extruding the hole"

    # A centred hole. The point is picked in the rim at (25,0) and the sketch then
    # moves to (25,15), which leaves it 15mm from the new centre and so INSIDE the
    # r20 hole: the stored point is genuinely stranded, which is what makes this a
    # drift test rather than a restatement of the fallback.
    def plate(x, y, hole_ids, pt=(25, 0, 0)):
        return build("plate", x, y, hole_ids, pt)

    RIM, PEG = (3600 - math.pi * 400) * 5, math.pi * 400 * 5
    moved = plate(25, 15, [["h"]])
    assert abs(moved - RIM) < 1, \
        f"a moved centred-hole plate: got {moved:.1f}, want {RIM:.1f} " \
        f"({PEG:.1f} is the peg — the stranded point is in the hole)"
    legacy = plate(0, 0, None)
    assert abs(legacy - RIM) < 1, \
        f"legacy centred-hole plate must resolve by point, got {legacy:.1f} " \
        f"({PEG:.1f} is the hole its outer-loop-only anchor lands in)"

    print("  19314fdc OK: a moved shell extrudes its 18000 wall and not its 32000 "
          "hole; a moved centred-hole plate stays a rim; shipped-beta documents "
          "with no hole ids fall back")


def test_region_anchor_refuses_and_keeps_a_correct_cell():
    """The anchor's own refusals, asserted where they happen.

    Through the volume these are indistinguishable from the safety net catching a
    WRONG anchor downstream — an unmoved document extrudes the right thing either
    way — so a refusal is asserted as a refusal: `None` out of
    `_region_anchor_from_entities`, which is the moment the fallback is chosen.

    The last case is the other direction, and it is the one that can bring field
    a20cca53 back. `_region_face_from_entities` throws an anchor away when the
    profile it rebuilt is not the cell the anchor landed in, and a reference that
    names only SOME of its boundary entities rebuilds bigger than its cell while
    being perfectly correct. Discarding that anchor sends the extrude to the stale
    point, which is the bug the entity ids exist to fix, so the guard is bounded to
    cells that lie strictly INSIDE the rebuilt profile (a hole) and this case —
    whose cell shares the profile's outer boundary — must survive it."""
    from builder import (_build_sketch, _region_anchor_from_entities,
                         _region_face_from_entities)

    def entry(ents):
        return _build_sketch(
            {"id": "s1", "type": "sketch", "plane": "XY", "entities": ents},
            lambda v: v)

    # An UNMOVED centred-hole plate — the spec's second case. Its volume cannot
    # test anything (the stored point is still right), but the anchor can: it must
    # come out of the rim, not the r20 hole the outer loop alone rebuilds over.
    plate = entry(_holed_sketch("plate", 0, 0))
    anchor = _region_anchor_from_entities(plate, ["p"], [["h"]])
    assert anchor is not None, \
        "a centred-hole plate is an ordinary profile: it must anchor at all"
    pt, area, _bb = anchor
    assert math.hypot(pt.X, pt.Y) > 20, \
        f"the centred-hole plate's anchor fell in its own hole: {pt} is " \
        f"{math.hypot(pt.X, pt.Y):.2f}mm from the centre, the hole is r20"
    assert abs(area - (3600 - math.pi * 400)) < 1e-6, \
        f"the anchor must be derived from the rim, got area {area:.3f}"

    shell = entry(_holed_sketch("shell", 0, 0))
    # The reported geometry itself, unmoved: the anchor must be in the 3600mm2
    # wall, so outside the 80x80 hole on at least one axis.
    wall_pt, wall_area, _bb = _region_anchor_from_entities(
        shell, ["outer"], [["inner"]])
    assert max(abs(wall_pt.X), abs(wall_pt.Y)) > 40, \
        f"the shell's anchor is in its own hole: {wall_pt} (the hole is +-40)"
    assert abs(wall_area - 3600) < 1e-6, \
        f"the anchor must be derived from the wall, got area {wall_area:.3f}"
    assert _region_anchor_from_entities(shell, ["outer"], [["deleted"]]) is None, \
        "a hole id naming an entity that is gone is a stale reference: refuse it, " \
        "do not derive an anchor from the outer loop and land in the hole"
    assert _region_anchor_from_entities(shell, ["outer"], [[]]) is None, \
        "an EMPTY hole group is a hole whose entity ids the tracer could not " \
        "recover (src/sketch/region.ts), not a region without holes"
    # A hole that severs the material into two pieces: neither is "the" region.
    sever = entry([{"id": "o", "type": "rectangle", "width": 40, "height": 20,
                    "x": 0, "y": 0},
                   {"id": "s", "type": "rectangle", "width": 10, "height": 40,
                    "x": 0, "y": 0}])
    assert _region_anchor_from_entities(sever, ["o"], [["s"]]) is None, \
        "a hole that cuts the material in two leaves no single anchor"

    # The area guard's boundary, in both directions. Same sketch, same stored
    # point, moved: a 60x60 rectangle with an r10 circle straddling its right edge,
    # and a reference that names the rectangle only.
    def straddle(dx, with_ents, pt=(15, 0, 0)):
        ents = [{"id": "p", "type": "rectangle", "width": 60, "height": 60,
                 "x": dx, "y": 0},
                {"id": "c", "type": "circle", "radius": 10, "x": dx + 30, "y": 0}]
        ex = {"id": "ex", "type": "extrude", "sketch": "s1", "distance": 5,
              "operation": "new", "regions": [list(pt)]}
        if with_ents:
            ex["regionEntities"] = [["p"]]
        part, err, _ = rebuild({"parameters": {}, "features": [
            {"id": "s1", "type": "sketch", "plane": "XY", "entities": ents}, ex]})
        assert not err, err
        return part.volume

    BIG, HALF = (3600 - math.pi * 50) * 5, math.pi * 50 * 5
    assert abs(straddle(-10, False) - HALF) < 1, \
        "the control is wrong: the moved sketch must strand the stored point in " \
        "the half-disc, or the case below proves nothing"
    kept = straddle(-10, True)
    assert abs(kept - BIG) < 1, \
        f"the area guard ate a CORRECT anchor: got {kept:.1f}, want {BIG:.1f} " \
        f"({HALF:.1f} is field a20cca53, the stale point's cell). The rebuilt " \
        f"profile is 3600mm2 against a 3442.9mm2 cell because the reference names " \
        f"only the rectangle, but that cell shares the profile's outer boundary — " \
        f"it is not a hole, so the mismatch must not condemn the anchor"

    # ...and a rebuild that would anchor in the hole no longer gets that far: the
    # hole's own cell is bounded by `inner` alone, so it cannot contain a reference
    # that names `outer`, and the wall is the only cell left. This used to assert
    # None — refuse, and let the stored point speak — which was the right answer
    # while the rebuilt profile was the only evidence available. Naming the cell is
    # strictly better than refusing: it is right even when the point is stale, which
    # is the case the point cannot survive (a20cca53).
    holed = entry(_holed_sketch("shell", 0, 0))
    cells = [(fc, fc.bounding_box()) for fc in holed["faces"]]
    wall = _region_face_from_entities(holed, cells, ["outer"], None)
    assert wall is not None and abs(wall.area - 3600) < 1e-6, \
        f"an outer-loop-only reference must resolve to the 3600mm2 WALL — the only " \
        f"cell whose boundary contains `outer` — and not to the 6400mm2 hole its " \
        f"solid rebuild anchors in; got " \
        f"{'None' if wall is None else format(wall.area, '.3f')}"

    print("  anchor refusals OK: deleted, empty and severing hole groups all "
          "refuse; an under-named reference keeps its cell; a holed region names "
          "its wall instead of anchoring in its hole")


# Field report 953a6c3f, reduced to lines. An 80x230 outline split across the
# middle, with a 60x210 outline drawn straight THROUGH that split — the shape of
# the reporter's part, minus its corner arcs, which change nothing here.
#
# What makes it the reproduction is that the inner verticals cross the mid line:
# each of the four cells is then bounded by a DIFFERENT set of entities, and the
# two band cells are bounded by entities that do not close a loop on their own
# (the inner three only close once trimmed at the crossing). That is the case an
# entity anchor cannot rebuild, and used to answer wrongly rather than refuse.
_BUG953_SKETCH = [
    {"id": "oL", "type": "line", "x1": -40, "y1": 0, "x2": -40, "y2": -115},
    {"id": "oB", "type": "line", "x1": -40, "y1": -115, "x2": 40, "y2": -115},
    {"id": "oR", "type": "line", "x1": 40, "y1": -115, "x2": 40, "y2": 0},
    {"id": "mid", "type": "line", "x1": 40, "y1": 0, "x2": -40, "y2": 0},
    {"id": "tL", "type": "line", "x1": -40, "y1": 0, "x2": -40, "y2": 115},
    {"id": "tT", "type": "line", "x1": -40, "y1": 115, "x2": 40, "y2": 115},
    {"id": "tR", "type": "line", "x1": 40, "y1": 115, "x2": 40, "y2": 0},
    {"id": "iL", "type": "line", "x1": -30, "y1": 105, "x2": -30, "y2": -105},
    {"id": "iB", "type": "line", "x1": -30, "y1": -105, "x2": 30, "y2": -105},
    {"id": "iR", "type": "line", "x1": 30, "y1": -105, "x2": 30, "y2": 105},
    {"id": "iT", "type": "line", "x1": 30, "y1": 105, "x2": -30, "y2": 105},
]
_BAND_LO = ["oL", "oB", "oR", "mid", "iL", "iB", "iR"]   # 2900mm2, y -115..0
_BAND_HI = ["tL", "tT", "tR", "mid", "iL", "iT", "iR"]   # 2900mm2, y 0..115
_CORE_LO = ["mid", "iL", "iB", "iR"]                     # 6300mm2, y -105..0
_CORE_HI = ["mid", "iL", "iT", "iR"]                     # 6300mm2, y 0..105


def test_region_names_its_cell_and_does_not_collapse():
    """Field report 953a6c3f: "I select the right parts of the sketch, but a
    different part is extruded" — four picked areas built two.

    Two of the four are the U-shaped bands, and a band's boundary entities do NOT
    close a loop by themselves: three of the seven only close once trimmed where
    the inner outline crosses the mid line. `Wire.combine` closed the other four
    into the OUTER loop, the open wire was dropped, and the anchor came out of a
    9200mm2 profile that is not any cell — landing, confidently, inside the 6300mm2
    core. Containment succeeded, so nothing warned: the extrude reported no error
    and quietly built half of what was asked for.

    A cell is IDENTIFIED here rather than rebuilt: the arrangement knows which
    entities bound each cell, so a reference that names them names the cell, and
    no geometry has to be re-derived. The volumes below are the assertion that
    matters — four areas must add up — and the labels are asserted too so the
    failure says WHICH cell went wrong rather than only that a number moved."""
    from builder import _build_sketch

    entry = _build_sketch(
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": _BUG953_SKETCH},
        lambda v: v)
    got = {}
    for fc, lbl in zip(entry["faces"], entry["cellEntities"]):
        assert lbl is not None, \
            f"a {fc.area:.1f}mm2 cell has no entity label: every edge of this " \
            f"arrangement comes from a named line, so attribution must be total"
        got[lbl] = round(fc.area, 3)
    want = {frozenset(_BAND_LO): 2900.0, frozenset(_BAND_HI): 2900.0,
            frozenset(_CORE_LO): 6300.0, frozenset(_CORE_HI): 6300.0}
    assert got == want, \
        f"the four cells must carry four DISTINCT entity sets:\n  got  {got}\n  " \
        f"want {want}"

    def extrude(regions, eids, dist=10):
        part, err, _b = rebuild({"parameters": {}, "features": [
            {"id": "s1", "type": "sketch", "plane": "XY",
             "entities": _BUG953_SKETCH},
            {"id": "ex", "type": "extrude", "sketch": "s1", "distance": dist,
             "operation": "new", "regions": [list(p) for p in regions],
             "regionEntities": eids,
             "regionHoleEntities": [[] for _ in eids]}]})
        assert not err, err
        return part.volume

    # The reported feature: four areas, and the whole outline is what they add to.
    four = extrude([(0, -110, 0), (0, 110, 0), (0, -50, 0), (0, 50, 0)],
                   [_BAND_LO, _BAND_HI, _CORE_LO, _CORE_HI])
    assert abs(four - 184000) < 1, \
        f"four picked areas collapsed: got {four:.1f}, want 184000.0 " \
        f"(126000.0 is the two cores alone — the reported bug, where the bands' " \
        f"references resolved into the cores and the union lost half the part)"

    # The bands ALONE, which is the pair that used to resolve into the cores. The
    # numbers are far apart on purpose: 2900 against 6300 per cell.
    bands = extrude([(0, -110, 0), (0, 110, 0)], [_BAND_LO, _BAND_HI])
    assert abs(bands - 58000) < 1, \
        f"the bands resolved to the wrong cells: got {bands:.1f}, want 58000.0 " \
        f"(126000.0 is the cores)"

    # A reference saved BEFORE the inner outline existed names four entities that
    # no cell carries exactly any more — the split gave both new pieces the inner
    # ids too. Only the band's boundary still contains all four, so it is named
    # without a tie-break. (This is `f4` in the reporter's document.)
    presplit = extrude([(0, -110, 0)], [["oL", "oB", "oR", "mid"]])
    assert abs(presplit - 29000) < 1, \
        f"a pre-split reference must resolve to the 2900mm2 band that still " \
        f"contains all of its entities: got {presplit:.1f}, want 29000.0 " \
        f"(63000.0 is the core, which shares only `mid` with it)"

    print("  953a6c3f OK: four picked areas build 184000 and not 126000; the "
          "bands resolve to the bands; a pre-split reference names its band")




def test_unify_is_never_handed_an_invalid_shape_on_import():
    """UnifySameDomain SEGFAULTS on an invalid solid, so it must never see one.

    GH #49 (alwin4711): importing a Bambu Studio project 3MF killed the geometry
    worker outright, which the app reports as the generic "the geometry kernel
    crashed on this operation". The file is VALID and lib3mf reads it fine. What
    died was the cleanup pass: `_refacet_clean` sews the mesh and rebuilds a
    solid, that rebuilt solid was invalid (BRepCheck_InvalidImbricationOfWires),
    and `ShapeUpgrade_UnifySameDomain.Build()` on it segfaulted.

    A segfault is NOT an exception. `_maybe_unify` wraps its body in
    `except Exception` and that catches exactly nothing here — the process is
    gone, so no fallback, no error message, no traceback.

    The rule pinned here is the one that generalises: on the mesh-import path,
    nothing invalid reaches UnifySameDomain. The reporter's file is not in the
    repo (it is a user's part), so this builds its own invalid shape instead:
    two interpenetrating boxes in one mesh sew into an invalid solid, which was
    measured reaching `_maybe_unify` from `_sew_mesh_file` before this guard —
    a SECOND call site on the same path as the one that crashed.

    Note `_explode_solids` is deliberately left unguarded: it calls unify once
    per body and the validity check costs ~0.06 s each, which is minutes on a
    3,000-body assembly.
    """
    from OCP.BRepCheck import BRepCheck_Analyzer

    def _write_stl(tris, path):
        with open(path, "wb") as f:
            f.write(b"\0" * 80)
            f.write(struct.pack("<I", len(tris)))
            for tri in tris:
                f.write(struct.pack("<3f", 0, 0, 0))
                for pt in tri:
                    f.write(struct.pack("<3f", *pt))
                f.write(struct.pack("<H", 0))

    def _box(sx=20.0, sy=20.0, sz=20.0, ox=0.0, oy=0.0, oz=0.0):
        v = [(ox, oy, oz), (ox + sx, oy, oz), (ox + sx, oy + sy, oz), (ox, oy + sy, oz),
             (ox, oy, oz + sz), (ox + sx, oy, oz + sz), (ox + sx, oy + sy, oz + sz),
             (ox, oy + sy, oz + sz)]
        out = []
        for a, b, c, d in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                           (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]:
            out.append((v[a], v[b], v[c]))
            out.append((v[a], v[c], v[d]))
        return out

    path = os.path.join(tempfile.gettempdir(), "sindri_invalid_unify.stl")
    _write_stl(_box() + _box(ox=10.0, oy=10.0, oz=10.0), path)

    # 1. the shape really is invalid, otherwise this test proves nothing
    seen = []
    original = builder._maybe_unify

    def spy(shape):
        seen.append(BRepCheck_Analyzer(shape.wrapped).IsValid())
        return original(shape)

    builder._maybe_unify = spy
    try:
        import_geometry(path, "stl")
    except ValueError:
        pass  # a refusal is a fine outcome; a dead process is not
    finally:
        builder._maybe_unify = original

    assert seen, "unify was never called, so this test is not exercising the path"
    assert all(seen), (
        f"an INVALID shape reached UnifySameDomain (validity per call: {seen}) — "
        "that is the GH #49 segfault, and it will kill the worker on the right input"
    )

    # 2. and the guard has not broken the ordinary case: a clean box mesh still
    #    merges its coplanar triangles down to 6 real faces
    good = os.path.join(tempfile.gettempdir(), "sindri_valid_unify.stl")
    _write_stl(_box(), good)
    faces = import_geometry(good, "stl")["faces"]
    assert faces == 6, f"a plain box mesh should merge to 6 faces, got {faces}"

def test_unify_never_costs_a_valid_solid():
    """UnifySameDomain is a tidy-up, and it must not break the solid it tidies.

    Found on a user's part (Shroud.sindri). Feature `f12`, a 360-degree revolve
    CUT, produced a valid 36-face solid; ShapeUpgrade_UnifySameDomain then
    returned SUCCESSFULLY and handed back a shape carrying an invalid face with a
    0.017 mm sliver edge. Nothing reported anything.

    Everything downstream inherited it, and the symptoms pointed everywhere but
    here: a chamfer on that body failed at EVERY size — 3.15, 1.5, 0.5, 0.1, even
    0.01 — with OCCT's misleading "try a smaller length value(s)", and two
    fillets each took about TEN MINUTES to fail. The document could not be opened
    at all. `body4 valid: False` was the fact that turned it from a size problem
    into a validity problem.

    Fuzzy values were tried as an alternative and REJECTED: a 1e-5 fuzzy cut
    returns a valid solid of 251393 mm3 where the correct answer is 60684 mm3 —
    four times the volume, i.e. silently wrong geometry, which is worse than the
    bug.

    Asserted here on a shape this repo can build from scratch: the guard must be
    a no-op on ordinary geometry (unify still merges coplanar faces), and it must
    prefer a valid raw result over an invalid cleaned one. The user's own part is
    not in the repo, so what is pinned is the RULE, not that one document.
    """
    from OCP.BRepCheck import BRepCheck_Analyzer

    # 1. the guard does not disturb an ordinary boolean: unify still merges the
    #    coplanar faces a cut leaves behind
    doc = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 40, "width": 40, "height": 20},
        {"id": "b2", "type": "box", "length": 10, "width": 10, "height": 40},
        {"id": "c1", "type": "combine", "operation": "cut", "target": "body1", "tool": "body2"}]}
    _, err, bodies = rebuild(doc)
    solids = [b["shape"] for b in bodies if b.get("shape") is not None]
    assert solids, f"the cut produced no body: {err}"
    assert solids[0].is_valid, "an ordinary cut came back invalid"

    # 2. the rule itself, stated as code so it cannot rot: a cleaned shape is
    #    only accepted when it does not DESTROY validity the raw result had.
    src = inspect.getsource(builder._serial_bool)
    assert "BRepCheck_Analyzer" in src, (
        "_serial_bool no longer checks the cleaned shape's validity — "
        "UnifySameDomain can return successfully and hand back a broken solid")
    assert "raw" in src and "cleaned" in src, \
        "_serial_bool no longer distinguishes the raw boolean from the cleaned one"

    # 3. and the direction of the check: a boolean that was ALREADY invalid must
    #    still get its cleanup, or the guard would change results for no reason.
    assert "IsValid() and not" in src.replace("\n", " "), \
        "the validity guard is no longer one-directional (raw valid -> cleaned invalid)"

    print("  unify-guard OK: a tidy-up may not cost a valid solid")


def test_blend_hang_guard():
    """A fillet that HANGS must be refused, not allowed to wedge the session.

    Found on a user's own part (Shroud.sindri, 28 features), sent as a feature
    request — he had no idea it was broken. Feature `f33`, a 16-edge fillet at
    r=1.6, never returns: the document rebuilt for 25 MINUTES on main without
    completing, so it could not be opened at all. Bisected by prefix — the first
    26 features build in 2.1 s, adding f33 never finishes — and five of its
    sixteen edges hang INDIVIDUALLY too, so it is the body at that radius rather
    than one pathological edge.

    An in-worker deadline cannot catch this: OCCT holds the GIL for the whole
    call (the taper path measured a SIGALRM armed for 1.0 s arriving at 10.39 s),
    and geometry runs in a max_workers=1 pool, so one hang costs the whole
    session. Hence a subprocess with a timeout.

    What is asserted here is the part that must not regress: the guard is
    NARROW. It refuses a hang and nothing else — an ordinary blend still builds,
    and a blend that FAILS still fails with OCCT's own message rather than the
    guard's, because "try a smaller length value(s)" is far more actionable.
    """
    # 1. an ordinary fillet is unaffected
    doc = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 40, "width": 40, "height": 20},
        {"id": "f1", "type": "fillet",
         "edges": {"kind": "edge", "by": "nearest", "point": [20, 20, 10]}, "radius": 3}]}
    _, err, bodies = rebuild(doc)
    assert not err, f"an ordinary fillet was refused: {err}"
    solids = [b["shape"] for b in bodies if b.get("shape") is not None]
    assert len(solids) == 1 and solids[0].volume < 40 * 40 * 20, "the fillet removed nothing"

    # 2. an impossible radius still reports the KERNEL's message, not the guard's.
    #    The guard only decides "did it finish", so a fast failure falls through
    #    to the real call and keeps its own diagnosis.
    doc2 = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "f1", "type": "fillet",
         "edges": {"kind": "edge", "by": "nearest", "point": [5, 5, 0]}, "radius": 500}]}
    _, err2, _ = rebuild(doc2)
    assert err2, "a 500mm fillet on a 10mm box should fail"
    msg = str(err2[0].get("message", ""))
    assert "within" not in msg, (
        "an impossible radius was reported as a TIMEOUT — the guard is pre-empting "
        f"honest failures and hiding the kernel's message: {msg}")

    # 3. the guard's own machinery answers the question it claims to
    from build123d import Box
    b = Box(10, 20, 30)
    assert builder._probe_blend(b, list(b.edges())[:1], "fillet", 1.0), \
        "a trivially valid fillet was refused by the probe"

    # 4. edge ORDER survives the BREP round-trip, which is what lets the probe
    #    name the same edges the worker resolved. If this ever stops holding,
    #    the probe silently starts testing a DIFFERENT operation.
    from geom_select import _edge_mid
    mids = lambda sh: [tuple(round(float(c), 6) for c in (_edge_mid(e).X, _edge_mid(e).Y, _edge_mid(e).Z))
                       for e in sh.edges()]
    round_tripped = builder._brep_b64_to_shape(builder._shape_to_brep_b64(b))
    assert mids(b) == mids(round_tripped), \
        "BREP round-trip no longer preserves edge order — _probe_blend would test the wrong edges"

    # 5. the probe is TARGETED, not universal. Paying a fork per fillet added
    #    ~27 minutes to CI's `test` leg, so a plain box gets no probe while
    #    spline edges and large bodies still do. This is a heuristic and the
    #    residual risk is real: an unprobed blend behaves exactly as it did
    #    before the guard existed.
    simple = Box(20, 20, 20)
    assert not builder._blend_needs_probing(simple, list(simple.edges())[:1]), \
        "a plain box fillet is being probed — that is the CI cost with none of the benefit"
    from build123d import Cylinder
    cyl = Cylinder(5, 10)
    assert not builder._blend_needs_probing(cyl, list(cyl.edges())[:1]), \
        "an analytic cylinder edge is being probed"

    # 6. the refusal must not promise a smaller value works. Measured on the
    #    part this was written for: EVERY radius from 0.02 to 1.6 fails — small
    #    ones refuse outright, large ones never return. "Try a smaller value" is
    #    the same lie OCCT tells, and it sends the user round a loop with no exit.
    src = inspect.getsource(builder._blend_edges)
    assert "did not finish" in src, "the refusal no longer says what was actually observed"
    assert "Try a smaller value" not in src, (
        "the refusal promises a smaller value works — measured false on the geometry "
        "this guard exists for")

    print("  blend-hang-guard OK: hang refused, honest failures keep the kernel's message")


def test_fillet_failure_diagnostics():
    """When a fillet/chamfer fails, the per-edge probe names the offending
    edges' midpoints in an `edgeOpFailed` diagnostic (so the UI can paint
    exactly those edges red) while the feature itself errors as before. A
    successful fillet emits no such diagnostic."""
    _s, base = _box(1, 20, 20, 2)  # thin plate: corners +-10, z=0..2
    # a top edge (y=+10, z=2, along X): its midpoint is (0, 10, 2)
    fil = {"id": "fl", "type": "fillet", "radius": 5,  # 5mm into a 2mm wall -> impossible
           "edges": {"kind": "edge", "by": "nearest", "point": [0, 10, 2]}}
    diag = []
    _p, err, bodies = rebuild({"parameters": {}, "features": base + [fil]}, diagnostics=diag)
    assert err and err[0]["feature_id"] == "fl", f"oversized fillet should error, got {err}"
    entries = [d for d in diag if d.get("kind") == "edgeOpFailed"]
    assert len(entries) == 1, f"expected one edgeOpFailed diagnostic, got {diag}"
    ent = entries[0]
    assert ent["feature_id"] == "fl" and ent["reason"] in ("per-edge", "combination"), ent
    assert ent["failed"] and len(ent["failed"][0]["mid"]) == 3, ent
    mx, my, mz = ent["failed"][0]["mid"]
    assert abs(mx) < 0.1 and abs(my - 10) < 0.1 and abs(mz - 2) < 0.1, \
        f"failed-edge midpoint should be the top edge (0,10,2), got {ent['failed'][0]['mid']}"
    assert bodies and abs(bodies[0]["shape"].volume - 800) < 1, "plate must survive intact (20*20*2)"

    # happy path: a sane radius emits NO edgeOpFailed diagnostic
    diag2 = []
    fil_ok = dict(fil, radius=0.5)
    _p, err, _b = rebuild({"parameters": {}, "features": base + [fil_ok]}, diagnostics=diag2)
    assert not err, f"0.5mm fillet on a 2mm plate should build: {err}"
    assert not [d for d in diag2 if d.get("kind") == "edgeOpFailed"], diag2
    print("  fillet failure diagnostics OK: edgeOpFailed names the top edge (0,10,2); "
          "happy path emits none")


def test_boolean_guards_combine_sweep():
    """The extrude no-op guards also cover the OTHER boolean sites: a Combine Cut
    whose tools don't touch the target, and a Combine Intersect that would empty
    it, raise instead of silently consuming the tools; Sweep now routes through
    _boolean_into_bodies, so a sweep Cut that reaches no body is flagged too.
    Join with an embedded tool stays legal (it visibly absorbs the tool body --
    see test_combine), and a sweep Join with nothing to hit still makes a new
    body."""
    _s1, a = _box(1, 20, 20, 20)          # body1 at origin, vol 8000
    _s2, b = _box(2, 10, 10, 10, x=100)   # body2 far away, vol 1000

    for op, needle in (("cut", "removed nothing"),
                       ("intersect", "leave the target empty")):
        doc = {"parameters": {}, "features": a + b + [
            {"id": "cb", "type": "combine", "operation": op,
             "target": "body1", "tools": ["body2"]}]}
        _p, err, bodies = rebuild(doc)
        assert err and err[0]["feature_id"] == "cb", \
            f"combine {op} disjoint should flag a feature error, got {err}"
        assert needle in err[0]["message"], err[0]["message"]
        assert len(bodies) == 2, \
            f"failed combine {op} must consume nothing, got {len(bodies)} bodies"
        vols = sorted(round(x["shape"].volume) for x in bodies)
        assert vols == [1000, 8000], vols

    # sweep: same pipe fixture as test_sweep, but with a body it can't reach
    pipe = [
        {"id": "prof", "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "radius": 2}]},
        {"id": "path", "type": "sketch", "plane": "XZ", "entities": [
            {"type": "arc", "x1": 0, "y1": 0, "mx": 5, "my": 12, "x2": 18, "y2": 18}]},
    ]
    _s3, faraway = _box(3, 10, 10, 10, x=100)
    doc = {"parameters": {}, "features": faraway + pipe + [
        {"id": "sw", "type": "sweep", "profile": "prof", "path": "path", "operation": "cut"}]}
    _p, err, bodies = rebuild(doc)
    assert err and err[0]["feature_id"] == "sw" and "removed nothing" in err[0]["message"], \
        f"sweep cut reaching nothing should flag, got {err}"
    assert len(bodies) == 1 and abs(bodies[0]["shape"].volume - 1000) < 1, \
        "failed sweep cut must leave the body intact"

    doc = {"parameters": {}, "features": faraway + pipe + [
        {"id": "sw", "type": "sweep", "profile": "prof", "path": "path", "operation": "join"}]}
    _p, err, bodies = rebuild(doc)
    assert not err, f"sweep join with nothing to hit should fall back to a new body: {err}"
    assert len(bodies) == 2, f"expected the pipe as a second body, got {len(bodies)}"
    print("  boolean guards OK: combine cut/intersect disjoint flagged (tools kept); "
          "sweep cut-nothing flagged, join falls back to new body")


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
            {"id": "im", "type": "import", "format": fmt, "name": pay["name"], "geom": pay["geom"]}]}
        part, e, bodies = rebuild(doc)
        assert not e and len(bodies) == 2, f"{fmt} two-object import → {len(bodies)} bodies, want 2"
    sp = os.path.join(d, "sphere.stl")
    export(Sphere(20), "stl", sp)
    try:
        import_geometry(sp, "stl")
        assert False, "organic sphere should be rejected"
    except ValueError as ex:
        # The wording of this refusal was rewritten for GH #49 (it now says
        # fitting was tried first and what it could not recognise stays
        # faceted), so match on what will not move: the refusal quotes a count
        # and points somewhere useful. A sphere fits NOTHING in v1 — no
        # cylinders in it — so it is still refused at 7,413 faces.
        msg = str(ex)
        assert "faces" in msg or "triangles" in msg, ex
        assert "STEP" in msg, ex
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


def _holed_plate_files(d):
    """Two STLs: one plate, and the SAME plate twice as a two-object file.

    Box(40,40,5) with a 4x4 grid of through-holes reads back as 22 faces once
    surface fitting has run (16 bore cylinders + 6 walls), so the pair reads
    back as 44 (two disconnected shells, one per plate). Written at the same
    tessellation both times so the two-object file is exactly twice the
    one-object file and nothing else moved.

    It was 220 and 436 before GH #49, when each bore arrived as ten flat
    strips."""
    from build123d import (Box, Circle, Compound, GridLocations, Pos, export_stl,
                           extrude)

    one = Box(40, 40, 5) - Compound(
        [loc * extrude(Circle(2.0), amount=5, both=True)
         for loc in GridLocations(9, 9, 4, 4)])
    two = Compound([one, Pos(60, 0, 0) * one])
    out = []
    for label, shp in (("one", one), ("two", two)):
        p = os.path.join(d, f"{label}.stl")
        export_stl(shp, p, tolerance=0.05, angular_tolerance=0.2)
        out.append(p)
    return out


def test_the_face_limit_is_judged_per_body():
    """GH #49: a file is refused for the SUM of its bodies' faces.

    MAX_IMPORT_FACES answers "did this ONE body reduce to something editable",
    and it was compared against the face count of the whole sewn compound. A
    Bambu/Orca project 3MF is inherently multi-object, so the reporter's two
    bodies — 1,850 and 1,737 faces, BOTH under the 2,000 limit — were refused
    together at their sum of 3,587. Nothing about his geometry is organic; the
    gate measured the wrong thing.

    The limit is monkeypatched down instead of building two genuinely
    1,900-face bodies, which costs ~160 s to import; this plate costs ~2.4 s.

    RE-BLESSED for the fitter: the plate is 22 faces now, not 220, because its
    sixteen bores each became one cylinder. The brackets scale with it (300/200
    -> 30/20) and the three cases they separate are exactly the ones they always
    were: both bodies admitted, one body over on its own, the pair over the
    total backstop."""
    d = tempfile.mkdtemp()
    one_stl, two_stl = _holed_plate_files(d)

    keep = (builder.MAX_IMPORT_FACES, builder.MAX_IMPORT_TOTAL_FACES)
    try:
        builder.MAX_IMPORT_FACES = 30
        builder.MAX_IMPORT_TOTAL_FACES = 100_000
        n1 = import_geometry(one_stl, "stl")["faces"]
        assert n1 == 22, f"one plate imported as {n1} faces, want 22"
        n2 = import_geometry(two_stl, "stl")["faces"]
        assert n2 == 44, (
            f"two copies of a plate that passes at {n1} faces imported as {n2}, "
            f"want 44")

        # ...and a body that is ITSELF over the limit is still refused, naming
        # which of the two it is.
        builder.MAX_IMPORT_FACES = 20
        try:
            import_geometry(two_stl, "stl")
            assert False, "a 22-face body must still be refused at a 20 limit"
        except ValueError as ex:
            assert "recognised" in str(ex), (
                f"the refusal must say fitting was tried first, got: {ex}")
            assert "22 faces" in str(ex), (
                f"the refusal must quote the POST-FIT count, got: {ex}")
            assert "of 2 " in str(ex) and "body" in str(ex), (
                f"the refusal must say WHICH body is organic, got: {ex}")

        # ...and the total backstop is a separate guard with its own message.
        builder.MAX_IMPORT_FACES = 30
        builder.MAX_IMPORT_TOTAL_FACES = 30
        try:
            import_geometry(two_stl, "stl")
            assert False, "44 total faces must trip a 30-face total backstop"
        except ValueError as ex:
            assert "too much detail" in str(ex), ex
            assert "recognised" not in str(ex), (
                f"the viewport backstop must not read as an editability "
                f"judgement: {ex}")
    finally:
        builder.MAX_IMPORT_FACES, builder.MAX_IMPORT_TOTAL_FACES = keep
    print(f"  per-body face limit OK: 1 plate {n1} faces, 2 plates {n2} faces, "
          f"both admitted at a 30-face PER-BODY limit")


def test_peek_counts_every_model_part_of_a_3mf():
    """The twin of test_heartbeat's exactness test, for the worker's own count.

    builder._peek_triangle_count feeds the MAX_IMPORT_TRIANGLES gate, and it
    read only the FIRST .model part. In the 3MF production extension that
    Bambu, Orca and PrusaSlicer all write, 3D/3dmodel.model is a manifest of
    <build><item> references holding ZERO triangles and the geometry lives in
    3D/Objects/*.model, so the density gate saw 0 triangles for the reporter's
    9,268-triangle file. Lives here rather than in test_heartbeat because this
    is builder's own count; the SERVER process is the one that must never
    import builder (build123d's import-time font scan — see
    server._mesh_triangle_estimate), and test_heartbeat imports both on purpose
    so it can compare them."""
    import zipfile

    d = tempfile.mkdtemp()
    tri = b'<triangle v1="0" v2="1" v3="2"/>'

    def _part(n):
        return (b'<?xml version="1.0"?><model><resources><object id="1"><mesh>'
                b"<vertices/><triangles>" + tri * n
                + b"</triangles></mesh></object></resources></model>")

    def _manifest(objectids):
        items = b"".join(b'<item objectid="%d"/>' % i for i in objectids)
        return (b'<?xml version="1.0"?><model><resources/><build>'
                + items + b"</build></model>")

    bambu = os.path.join(d, "bambu.3mf")
    with zipfile.ZipFile(bambu, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("3D/3dmodel.model", _manifest([2, 3]))
        z.writestr("3D/Objects/object_2.model", _part(3_000))
        z.writestr("3D/Objects/object_3.model", _part(2_000))
    got = builder._peek_triangle_count(bambu, "3mf")
    # +1 per triangle-bearing part: "<triangle" also matches each part's own
    # <triangles> container element. Over, never under.
    assert 5_000 <= got <= 5_002, f"counted {got} triangles across 2 parts, want 5,000"

    # Placements are NOT counted. The production extension lets ONE part be
    # placed by several <build><item> entries, but build123d's Mesher walks
    # GetMeshObjects() and never reads a build item, so a part placed twice is
    # READ ONCE — measured, a real production-extension 3MF placing one 12-face
    # box 1, 2 and 20 times reads back as a single 12-face shape every time.
    # This count feeds a HARD REFUSAL below, so scaling by placements rejected
    # healthy plates for triangles that no code path builds.
    inst = os.path.join(d, "instanced.3mf")
    with zipfile.ZipFile(inst, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("3D/3dmodel.model", _manifest([2, 2]))
        z.writestr("3D/Objects/object_2.model", _part(3_000))
    once = os.path.join(d, "once.3mf")
    with zipfile.ZipFile(once, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("3D/3dmodel.model", _manifest([2]))
        z.writestr("3D/Objects/object_2.model", _part(3_000))
    got2 = builder._peek_triangle_count(inst, "3mf")
    assert got2 == builder._peek_triangle_count(once, "3mf"), (
        f"placing a part twice changed the count ({got2} vs "
        f"{builder._peek_triangle_count(once, '3mf')}) — the reader builds one "
        f"copy either way")
    assert 3_000 <= got2 <= 3_001, (
        f"2 items placing 1 part counted {got2}, want the ~3,000 on disk")

    # ...and the refusal that count feeds does not fire on a mixed plate. One
    # big object plus a small one duplicated is the ordinary Bambu/Orca plate,
    # and an averaged placement factor over the whole file charged the big part
    # for the small one's copies: 31,002 real triangles were reported as
    # 155,010 and refused as "almost certainly an organic/scanned model".
    plate = os.path.join(d, "plate.3mf")
    with zipfile.ZipFile(plate, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("3D/3dmodel.model", _manifest([2, 3, 3, 3, 3, 3, 3, 3, 3]))
        z.writestr("3D/Objects/object_2.model", _part(30_000))
        z.writestr("3D/Objects/object_3.model", _part(1_000))
    got3 = builder._peek_triangle_count(plate, "3mf")
    assert 31_000 <= got3 <= 31_002, (
        f"a plate of 31,000 triangles with one part placed 8 times counted "
        f"{got3}")
    assert got3 <= builder.MAX_IMPORT_TRIANGLES, (
        f"{got3:,} would refuse a 31,000-triangle plate as too dense")

    # The zip-bomb sentinel still fires, and now on the TOTAL declared size:
    # three parts of 40 MiB each are past the 64 MiB scan window together while
    # none of them is past it alone.
    bomb = os.path.join(d, "bomb.3mf")
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        for i in (1, 2, 3):
            z.writestr(f"3D/Objects/object_{i}.model", b"\0" * (40 * 1024 * 1024))
    assert builder._peek_triangle_count(bomb, "3mf") > builder.MAX_IMPORT_TRIANGLES, \
        "a 120 MiB 3MF split across three parts walked straight past the scan window"
    print(f"  3MF peek OK: {got:,} triangles across 2 parts, {got2:,} for a "
          f"part placed twice, {got3:,} for a mixed plate, split zip bomb refused")


def test_a_loose_shell_is_judged_as_a_body_of_its_own():
    """A mesh file mixing a watertight and a non-watertight object.

    build123d hands back a bare Shell for anything that does not close
    (Mesher._get_shape returns the outer shell when it is not manifold), so
    such a file sews to a compound holding a Solid AND a Shell. _explode_solids
    fell back to the whole shape only when there were NO solids, so on a mixed
    compound it returned just the solid — and the caller's face gates are both
    computed from that list. Measured on a 3MF holding a clean box plus an open
    scanned strip: 60 of the compound's 66 faces were counted by neither
    MAX_IMPORT_FACES nor the whole-file backstop, and the organic body rode
    into the document unjudged."""
    from build123d import Box, Compound, Shell

    from builder import _explode_solids

    solid = Box(10, 10, 10)
    # an OPEN shell: a box's faces minus one, so it cannot close into a solid
    open_shell = Shell(Box(6, 6, 6).faces()[:-1])
    assert len(open_shell.solids()) == 0, "the fixture stopped being a loose shell"
    mixed = Compound([solid, open_shell])

    bodies = _explode_solids(mixed)
    per_body = [len(b.faces()) for b in bodies]
    assert len(bodies) == 2, (
        f"a solid + a loose shell is two bodies, the gate saw {len(bodies)}: "
        f"{per_body}")
    assert sum(per_body) == len(mixed.faces()), (
        f"the gates judge {sum(per_body)} of the compound's "
        f"{len(mixed.faces())} faces — the difference is invisible to both "
        f"MAX_IMPORT_FACES and MAX_IMPORT_TOTAL_FACES")

    # a shape with no solid at all is still one body, and a plain solid is not
    # double-counted by the loose-child pass
    assert len(_explode_solids(open_shell)) == 1
    assert [len(b.faces()) for b in _explode_solids(Compound([solid]))] == [6]
    print(f"  loose-shell body OK: {per_body} faces over 2 bodies, "
          f"{sum(per_body)} of {len(mixed.faces())} judged")


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




def test_text_on_face_colours_only_its_glyphs():
    """A `colorSlot` on textOnFace paints the LETTERS, not the face they sit on.

    Face ownership cannot answer this on its own: `_owners` is last-modifier, so
    the host face the glyphs were cut into is attributed to the text feature too.
    Measured on the reported document, 159 faces came back owned by the text, of
    which 4 — 1529.6 mm², the 40x40 face minus the glyph footprint, split into
    regions — were the host. Colouring by owner would paint the whole side.

    So the handler records new-AND-off-the-plane faces while it still holds both
    shapes, and that map rides to the wire and into the project 3MF."""
    import zipfile
    import xml.etree.ElementTree as ET
    import re
    import server

    doc = {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 40, "height": 40, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"},
        {"id": "t1", "type": "textOnFace",
         "face": {"kind": "face", "by": "nearest", "point": [0, 0, 10]},
         "pick": [0, 0, 10],
         "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "text": "AB", "height": 6, "depth": 0.6, "operation": "emboss",
         "align": "center", "u": 0, "v": 0, "colorSlot": 2},
    ]}
    _p, err, bodies = rebuild(doc)
    assert not err, f"setup failed: {err}"
    b = bodies[0]
    marks = b.get("_faceSlots") or {}
    assert marks, "the text claimed no faces — a colourSlot that colours nothing"
    assert set(marks.values()) == {2}, f"every claimed face is slot 2: {set(marks.values())}"

    # The HOST face must NOT be claimed. It is the one still lying in the text's
    # plane; the glyph tops sit `depth` above it and the walls run between.
    from builder import _face_fp
    host = [f for f in b["shape"].faces() if abs(f.center().Z - 10) < 1e-6]
    assert host, "the fixture should still have a face at z=10"
    for f in host:
        assert _face_fp(f) not in marks, (
            f"the host face ({f.area:.1f} mm²) was claimed — that paints the whole surface"
        )

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "textcolour.3mf")
        res = server._export_project_job(
            doc, path,
            [{"name": "A", "color": "#B8ACD6"}, {"name": "B", "color": "#96D8AF"},
             {"name": "C", "color": "#F99963"}],
            {}, {}, {})
        assert "error" not in res, f"export failed: {res}"
        with zipfile.ZipFile(res["path"]) as z:
            model = z.read("3D/3dmodel.model").decode("utf-8")
    vals = set(re.findall(r'paint_color="([^"]+)"', model))
    assert vals == {"0C"}, f"slot 2 must reach the file as 0C, got {vals}"
    painted = model.count("paint_color=")
    total = model.count("<triangle ")
    assert 0 < painted < total, (
        f"{painted} of {total} triangles painted — all or nothing means the face "
        "mapping collapsed"
    )
    return True


def test_export_project_3mf_paints_textured_faces():
    """A texture feature's colorSlot must reach the file as per-triangle
    `paint_color`, not just the viewport.

    Field-reported 2026-08-21: a cube with three textured faces at three palette
    slots showed three colours on screen and opened in Orca as one. The colour
    was assigned, the sidecar already published it per face for the viewport, and
    the project writer had no way to say it — it emitted per-OBJECT extruders
    only. Nothing was broken; the export simply could not express the model."""
    import zipfile
    import xml.etree.ElementTree as ET
    import server
    from project3mf import _paint_attr

    # The documented Bambu/Orca encoding, pinned by value. Getting this wrong is
    # silent: a wrong code paints the wrong filament, and LOWERCASE hex is
    # ignored outright by Bambu's parser, which reads as "all one colour".
    assert [_paint_attr(i) for i in range(5)] == ["4", "8", "0C", "1C", "2C"]
    assert all(c not in "abcdef" for c in "".join(_paint_attr(i) for i in range(8)))

    doc = {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"},
        {"id": "t1", "type": "texture", "kind": "ribs", "depth": 0.4, "scale": 5,
         "colorSlot": 2, "profile": "facet", "direction": "out", "sharpness": 0.5,
         "body": "body1",
         "faces": {"kind": "face", "by": "nearest", "point": [0, 0, 10]}},
    ]}
    _, errors, bodies = rebuild(doc)
    assert not errors, f"setup failed: {errors}"
    assert len(bodies) == 1

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "painted.3mf")
        res = server._export_project_job(
            doc, path,
            [{"name": "A", "color": "#B8ACD6"}, {"name": "B", "color": "#96D8AF"},
             {"name": "C", "color": "#F99963"}],
            {},          # no BODY assignment at all — the field case exactly
            {}, {},
        )
        assert "error" not in res, f"exportProject failed: {res}"
        with zipfile.ZipFile(res["path"]) as z:
            model = z.read("3D/3dmodel.model").decode("utf-8")
        tris = ET.fromstring(model).iter("{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}triangle")
        painted = [t for t in tris if t.get("paint_color")]
        assert painted, "no triangle carried paint_color — the colour was dropped again"
        vals = {t.get("paint_color") for t in painted}
        assert vals == {"0C"}, f"slot 2 must encode as 0C, got {vals}"

        # ...and the unpainted faces stay silent, inheriting the object extruder.
        total = model.count("<triangle ")
        assert 0 < len(painted) < total, (
            f"{len(painted)} of {total} triangles painted — a whole-body paint means "
            "the face mapping collapsed"
        )
    return True


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
    pal_mat, _, _ = sanitize_inputs(
        [{"name": "Red", "color": "#e03030", "material": "PLA"},
         {"name": "Blue", "color": "#3050E0"}], {}, {})
    assert pal_mat[0]["material"] == "PLA", "material must survive sanitize"
    assert "material" not in pal_mat[1], "absent material stays absent"

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
            [{"name": "Red", "color": "#E03030", "material": "PETG"},
             {"name": "Blue", "color": "#3050E0"}],
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
    assert proj["filament_type"] == ["PETG", "PLA"], \
        "material → filament_type at its slot; material-less slot defaults PLA"
    assert proj["printer_model"] == "Snapmaker U1", "caller settings must survive"
    print("  project-3MF OK: zip layout, extruder metadata, filament_colour, "
          "filament_type, shared centering transform, sanitize")


def test_face_selector_on_concentric_cylinders():
    """Selecting a ring's OUTER wall must not resolve to its INNER wall.

    The frontend used to build a by:"nearest" face selector from the mean of the
    face's mesh VERTICES, which for a full cylinder is a point on the AXIS. Both
    concentric walls then sat near that point and resolve_faces picked the closer
    one — the inner — so texture / press-pull / delete-face on a ring's outside
    landed inside. Measured on a real ring: the point sent was (0.54, 0, 8.5) and
    it resolved to r=25 instead of r=30.

    This pins the contract the fix relies on: a point ON a face resolves to that
    face, and an axis point is genuinely ambiguous and biased inward."""
    from build123d import Cylinder, GeomType

    ring = Cylinder(30, 20) - Cylinder(25, 20)
    cyls = [f for f in ring.faces() if f.geom_type == GeomType.CYLINDER]
    assert len(cyls) == 2, f"expected 2 cylindrical walls, got {len(cyls)}"
    outer = max(cyls, key=lambda f: f.radius)
    inner = min(cyls, key=lambda f: f.radius)

    for want, label in ((outer, "outer"), (inner, "inner")):
        p = want.center()
        got = resolve_faces(ring, {"kind": "face", "by": "nearest",
                                   "point": [p.X, p.Y, p.Z]})[0]
        assert abs(got.radius - want.radius) < 1e-6, (
            f"on-surface {label} point resolved to r={got.radius:.2f}, wanted r={want.radius:.2f}"
        )

    # the axis point (what the old frontend sent) is inward-biased — asserted so
    # nobody reintroduces a vertex-mean centroid for face selectors
    axis = resolve_faces(ring, {"kind": "face", "by": "nearest", "point": [0.0, 0.0, 0.0]})[0]
    assert abs(axis.radius - inner.radius) < 1e-6, (
        "an axis point resolves to the INNER wall — never build a face selector from one"
    )
    print("  face-selector OK: on-surface points resolve correctly; an axis point is inward-biased")


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
    test_presspull_upto_datum_plane()
    test_presspull_upto_offset()
    test_presspull_upto_tilted_target_trims()
    test_presspull_upto_refuses_through_body()
    test_presspull_upto_refuses_cylinder()
    test_presspull_upto_refuses_deleting_one_solid()
    test_presspull_upto_refuses_edge_on_target()
    test_presspull_upto_guards_survive_their_own_blind_spots()
    test_presspull_upto_refuses_coincident_target()
    test_presspull_upto_no_move_guard_measures_the_whole_face()
    test_presspull_upto_refuses_deleting_a_split_solid()
    test_presspull_upto_far_square_on_target_builds()
    test_presspull_upto_plane_missing_says_why()
    test_presspull_offset_needs_a_target()
    test_presspull_upto_exact()
    test_export_despite_errors()
    test_export_project_3mf()
    test_export_project_3mf_paints_textured_faces()
    test_text_on_face_colours_only_its_glyphs()
    test_sketch_patterns()
    test_sketch_spline_extrude()
    test_sketch_pattern_with_spline()
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
    test_the_face_limit_is_judged_per_body()
    test_peek_counts_every_model_part_of_a_3mf()
    test_a_loose_shell_is_judged_as_a_body_of_its_own()
    test_unify_body()
    test_error_continues()
    test_delete_face_retarget()
    test_extrude_operation_multibody()
    test_extrude_noop_guards()
    test_primitives()
    test_modify_tools()
    test_offset_face_and_thicken()
    test_face_selector_on_concentric_cylinders()
    test_simplify_mesh()
    test_sweep()
    test_revolve_loft_operation()
    test_loft_profiles_keeps_holes_as_tube()
    test_boolean_guards_combine_sweep()
    test_region_stale_diagnostic()
    test_region_follows_a_moved_entity()
    test_holed_region_anchors_in_the_wall()
    test_region_anchor_refuses_and_keeps_a_correct_cell()
    test_region_names_its_cell_and_does_not_collapse()
    test_unify_never_costs_a_valid_solid()
    test_unify_is_never_handed_an_invalid_shape_on_import()
    test_blend_hang_guard()
    test_fillet_failure_diagnostics()
    test_scale_and_move()
    test_multibody_import_and_guards()
    test_interference()
    test_remove_body()
    print("ALL PASS")
