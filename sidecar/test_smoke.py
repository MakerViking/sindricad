"""Backend smoke test — exercises rebuild/tessellate/selectors/export directly
(no WebSocket) so failures point straight at the geometry code.

Run:  uv run python test_smoke.py
"""

import os
import math
import struct
import sys
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


def test_sweep_along_body_edge():
    """Sweep a profile along a picked BODY EDGE instead of a path sketch (#16).

    Field request (Doug Smith): "instead of creating a sketch, it would really be
    great to be able to select an edge of a solid to define the path for the
    sweep." The path arrives as SELECTORS, like fillet's edges, so it survives
    upstream edits that renumber topology.

    Geometry: a 30x30x10 box spanning x/y 0..30, so its corner post runs from
    (0,0,0) to (0,0,10). An r2 circle at the origin swept along that post is a
    cylinder of pi*4*10 = 125.664.
    """
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 30, "height": 30, "x": 15, "y": 15}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"},
        {"id": "prof", "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "radius": 2}]},
        {"id": "sw", "type": "sweep", "profile": "prof", "operation": "new",
         "pathEdges": [{"kind": "edge", "by": "nearest", "point": [0, 0, 5]}]}]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 2, f"box + swept solid expected, got {len(bodies)}"
    # Bodies are named body1/body2, not after the features, so identify the swept
    # one by what it should be: everything that is not the 9000 mm3 box.
    want = math.pi * 4 * 10
    vols = sorted(b["shape"].volume for b in bodies)
    assert abs(vols[1] - 9000) < 1.0, f"the box should be untouched, got {vols[1]:.3f}"
    assert abs(vols[0] - want) < 1.0, (
        f"sweeping r2 along the 10 mm corner post should give {want:.3f}, "
        f"got {vols[0]:.3f}")
    print(f"  sweep-along-edge OK: corner post pipe vol {vols[0]:.3f}")


def test_sweep_edge_path_reports_disconnected_edges():
    """Edges that do not meet end to end must not be swept silently.

    The longest-wire rule a sketch path uses applies here too, and sweeping along
    "whichever of my picks was longest" is exactly the failure field report
    780bdbd0 was about — a lip hugging 54% of a contour with no error anywhere.
    Two opposite corner posts of the same box share no endpoint.

    Reported the same way a disconnected SKETCH path is: a non-fatal `lossy`
    diagnostic, not a build-halting error. The body still builds (MCAD-style),
    but the truncation is on the record instead of being invisible.
    """
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 30, "height": 30, "x": 15, "y": 15}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"},
        {"id": "prof", "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "radius": 2}]},
        {"id": "sw", "type": "sweep", "profile": "prof", "operation": "new",
         "pathEdges": [{"kind": "edge", "by": "nearest", "point": [0, 0, 5]},
                       {"kind": "edge", "by": "nearest", "point": [30, 30, 5]}]}]}
    diag = []
    _part, _err, _bodies = rebuild(doc, diagnostics=diag)
    truncation = [d for d in diag
                  if d.get("feature_id") == "sw" and "disconnected pieces" in (d.get("reason") or "")]
    assert truncation, (
        "two disconnected posts were swept as one path with nothing on the "
        f"record; diagnostics were {diag}")
    assert truncation[0]["lossy"] is True
    print(f"  disconnected edge path reported: {truncation[0]['reason']}")


def test_sweep_along_non_planar_edge_chain():
    """The point of the whole feature: a path that does NOT lie in a plane.

    "This should also allow for sweeping around contours not lying in a plane."
    A sketch path is planar by construction, so this was unreachable before —
    the limitation was the SKETCH, never the kernel (MakePipeShell has never
    required a planar spine).

    The chain, on a box spanning x/y 0..30, z 0..10:
      corner post (0,0,0)->(0,0,10)   along +Z
      top edge    (0,0,10)->(30,0,10) along +X   [with the post, in plane y=0]
      top edge    (30,0,10)->(30,30,10) along +Y [leaves that plane]
    Three mutually perpendicular directions cannot share a plane, so if this
    builds at all the non-planar claim holds.

    The volume is asserted as a BAND, not a number: an r2 pipe round two square
    corners loses and gains material at the mitres, and pinning the exact figure
    would be pinning OCCT's corner treatment rather than the feature.
    """
    swept_len = 10 + 30 + 30
    doc = {"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 30, "height": 30, "x": 15, "y": 15}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"},
        {"id": "prof", "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "radius": 2}]},
        {"id": "sw", "type": "sweep", "profile": "prof", "operation": "new",
         "pathEdges": [{"kind": "edge", "by": "nearest", "point": [0, 0, 5]},
                       {"kind": "edge", "by": "nearest", "point": [15, 0, 10]},
                       {"kind": "edge", "by": "nearest", "point": [30, 15, 10]}]}]}
    diag = []
    _part, err, bodies = rebuild(doc, diagnostics=diag)
    assert not err, err
    # No truncation: all three edges must have joined into ONE spine, or this is
    # testing a shorter path than it claims to.
    truncated = [d for d in diag if "disconnected pieces" in (d.get("reason") or "")]
    assert not truncated, f"the three edges did not form one path: {truncated}"
    assert len(bodies) == 2, f"box + swept solid expected, got {len(bodies)}"
    vols = sorted(b["shape"].volume for b in bodies)
    nominal = math.pi * 4 * swept_len
    assert 0.75 * nominal < vols[0] < 1.25 * nominal, (
        f"an r2 pipe along {swept_len} mm of non-planar chain should be near "
        f"{nominal:.0f}, got {vols[0]:.3f}")
    assert bodies[0]["shape"].is_valid and bodies[1]["shape"].is_valid
    print(f"  non-planar sweep OK: 3-edge chain vol {vols[0]:.3f} (nominal {nominal:.0f})")


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
    # 1. the guard does not disturb an ordinary boolean: unify still merges the
    #    coplanar faces a cut leaves behind
    doc = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 40, "width": 40, "height": 20},
        {"id": "b2", "type": "box", "length": 10, "width": 10, "height": 40},
        {"id": "c1", "type": "combine", "operation": "cut", "target": "body1", "tool": "body2"}]}
    from unittest.mock import patch

    with patch.object(builder, "_validated_boolean_cleanup",
                      wraps=builder._validated_boolean_cleanup) as cleanup_check:
        _, err, bodies = rebuild(doc)
    assert cleanup_check.called, "the real boolean path bypassed the cleanup guard"
    assert not err, err
    solids = [b["shape"] for b in bodies if b.get("shape") is not None]
    assert solids, f"the cut produced no body: {err}"
    assert solids[0].is_valid, "an ordinary cut came back invalid"

    # 2. Pin the whole truth table, including the call order. A valid cleanup is
    #    ALWAYS selected, so measuring raw first was redundant on every ordinary
    #    boolean. Raw is consulted only when cleanup is invalid, preserving the
    #    field backstop without paying two full topology walks on the good path.
    raw, cleaned = object(), object()

    def choose(cleaned_valid, raw_valid):
        seen = []

        class Result:
            def __init__(self, value):
                self.value = value

            def IsValid(self):
                seen.append(self.value)
                return cleaned_valid if self.value is cleaned else raw_valid

        got = builder._validated_boolean_cleanup(raw, cleaned, Result)
        return got, seen

    got, seen = choose(True, False)
    assert got is cleaned and seen == [cleaned], "valid cleanup should skip raw validation"
    got, seen = choose(True, True)
    assert got is cleaned and seen == [cleaned], "two valid results must select cleanup"
    got, seen = choose(False, True)
    assert got is raw and seen == [cleaned, raw], "valid raw result must rescue bad cleanup"
    got, seen = choose(False, False)
    assert got is cleaned and seen == [cleaned, raw], \
        "an already-invalid boolean must still keep its cleanup"

    # Analyzer failure follows the old outer-try behavior too: good raw rescues
    # an unreadable cleanup; bad raw still keeps cleanup rather than regressing
    # to the already-invalid pre-clean shape.
    def choose_when_cleaned_check_raises(raw_valid):
        class Result:
            def __init__(self, value):
                self.value = value

            def IsValid(self):
                if self.value is cleaned:
                    raise RuntimeError("synthetic analyzer failure")
                return raw_valid

        return builder._validated_boolean_cleanup(raw, cleaned, Result)

    assert choose_when_cleaned_check_raises(True) is raw
    assert choose_when_cleaned_check_raises(False) is cleaned

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
    """A two-object file imports as TWO separate bodies; an organic mesh lands
    as read-only reference geometry instead of timing out."""
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
    # An organic mesh is no longer REFUSED. It lands as read-only reference
    # geometry carrying a structured reason, so the user gets the sphere plus a
    # note saying why it is not editable, instead of getting nothing. A sphere
    # fits NOTHING in v1 (there are no cylinders in it), so it is still well
    # over MAX_IMPORT_FACES at ~7,400 faces — what changed is the outcome, not
    # the judgement.
    res = import_geometry(sp, "stl")
    ref = res.get("reference")
    assert ref, f"an organic sphere must degrade to reference geometry: {res}"
    assert ref["why"] == "tooManyFaces", ref
    assert ref["faces"] > builder.MAX_IMPORT_FACES, ref
    assert res["faces"] > 0, "the degraded import must still return geometry"
    print(f"  multibody-import OK: 2-object STL+3MF → 2 bodies each; organic "
          f"mesh degraded to reference at {ref['faces']:,} faces")


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


def _dirty_box_stl(path, n=12, jitter=0.005, seed=7):
    """A Box(20,20,10) written the way a dirty exporter writes one.

    Each of the six planes is subdivided n x n, every interior vertex is pushed
    off its plane by up to `jitter` mm, one zero-area sliver is emitted per row,
    and the three negative faces are wound backwards. 1,800 triangles carrying
    635 distinct facet normals for six real planes — the small version of the
    field file `_replane_mesh_file` exists for. Returns the triangle count.

    Written by hand rather than with `export_stl` because the point is the
    DIRT: build123d emits two clean triangles per plane, which proves nothing.
    """
    import numpy as np

    rng = np.random.default_rng(seed)
    half = {0: 10.0, 1: 10.0, 2: 5.0}
    tris = []
    for axis in (0, 1, 2):
        for sign in (1, -1):
            u, v = [k for k in range(3) if k != axis]
            grid = np.zeros((n + 1, n + 1, 3))
            for i in range(n + 1):
                for j in range(n + 1):
                    p = np.zeros(3)
                    p[axis] = sign * half[axis]
                    p[u] = -half[u] + 2 * half[u] * i / n
                    p[v] = -half[v] + 2 * half[v] * j / n
                    if 0 < i < n and 0 < j < n:
                        p[axis] += rng.uniform(-jitter, jitter)
                    grid[i, j] = p
            for i in range(n):
                for j in range(n):
                    a, b, c, d = (grid[i, j], grid[i + 1, j],
                                  grid[i + 1, j + 1], grid[i, j + 1])
                    if sign > 0:
                        tris += [(a, b, c), (a, c, d)]
                    else:
                        tris += [(a, c, b), (a, d, c)]
                # a collapsed sliver along the row, like a real dirty export
                tris.append((grid[i, 0], grid[i + 1, 0], grid[i, 0]))
    with open(path, "wb") as fh:
        fh.write(b"\0" * 80)
        fh.write(struct.pack("<I", len(tris)))
        for t in tris:
            nrm = np.cross(t[1] - t[0], t[2] - t[0])
            ln = float(np.linalg.norm(nrm))
            nrm = nrm / ln if ln > 1e-12 else np.zeros(3)
            fh.write(struct.pack("<3f", *nrm))
            for p in t:
                fh.write(struct.pack("<3f", *p))
            fh.write(b"\0\0")
    return len(tris)


def test_replane_rebuilds_a_dirty_mesh():
    """A shattered export comes back as the planes it was made of.

    This is the small stand-in for a friend's architectural STL: 128,838
    triangles and 21,315 facet directions for ~393 real planes, which the
    ordinary import path turned into a 102,618-face body in ~4 minutes because
    UnifySameDomain merges only EXACTLY coplanar faces."""
    from builder import _replane_mesh_file

    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "dirty.stl")
        ntri = _dirty_box_stl(p)
        report = {}
        out = _replane_mesh_file(p, report=report)
        assert out is not None, "a dirty planar box must not be declined"
        nf = len(out.faces())
        assert nf <= 12, f"six planes should not need more than 12 faces, got {nf}"
        solids = out.solids()
        assert len(solids) == 1, f"a closed box must close into one solid, got {len(solids)}"
        vol = solids[0].volume
        assert abs(vol - 4000) <= 0.01 * 4000, f"volume {vol:.1f} is not the box's 4000"
        assert abs(out.area - 1600) <= 0.01 * 1600, f"area {out.area:.1f} is not the box's 1600"
        assert report["replaned"]["from"] == ntri - 72  # the collapsed slivers weld away
        print(f"  replane OK: {ntri} dirty triangles -> {nf} faces, "
              f"one solid, volume {vol:.1f} (true 4000)")


def test_replane_declines_a_faceted_curve():
    """A curved mesh is NOT a dirty planar one, and must fall straight back.

    Replaning a sphere would hand the user a few hundred flat faces and call it
    an editable model. The screen is the share of seams where two regions meet
    at under 15 degrees — what approximating a curve by planes looks like."""
    from build123d import Sphere, Torus, export_stl

    from builder import _replane_mesh_file

    with tempfile.TemporaryDirectory() as d:
        for name, shape, tol, ang in (("sphere", Sphere(10), 0.02, 0.1),
                                      ("torus", Torus(20, 5), 0.05, 0.2)):
            p = os.path.join(d, f"{name}.stl")
            export_stl(shape, p, tolerance=tol, angular_tolerance=ang)
            assert _replane_mesh_file(p) is None, f"{name} must be declined, not flattened"
    print("  replane OK: a tessellated sphere and torus both decline")


def test_replane_survives_a_region_it_cannot_rebuild():
    """One bad region loses its own triangles, never the whole import.

    Exactly 1 of the field file's 393 regions has no closed boundary loop, and
    `_refacet_clean`'s all-or-nothing bail would have thrown away the other 392
    for it."""
    import numpy as np

    from builder import _REGION_OK, _planar_face_from_region, _replane_mesh_file

    # a region of one collapsed triangle: every edge has both ends on the same
    # welded vertex, so there is no boundary to chain and no face to build
    snapped = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
    status, face = _planar_face_from_region(
        [np.array([0, 0, 0])], snapped[0], np.array([0.0, 0.0, 1.0]), snapped)
    assert status != _REGION_OK and face is None, (
        f"an unchainable region must report a status, not a face: {status}")

    # and end to end: a box carrying a non-manifold flap still imports
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "flap.stl")
        ntri = _dirty_box_stl(p)
        flap = []
        for i in range(8):
            for j in range(4):
                a = np.array([-10 + 2.5 * i, 10.0, -5 + 2.5 * j])
                b = np.array([-10 + 2.5 * (i + 1), 10.0, -5 + 2.5 * j])
                c = np.array([-10 + 2.5 * (i + 1), 14.0, -5 + 2.5 * j])
                e = np.array([-10 + 2.5 * i, 14.0, -5 + 2.5 * j])
                flap += [(a, b, c), (a, c, e)]
        with open(p, "r+b") as fh:
            fh.seek(80)
            fh.write(struct.pack("<I", ntri + len(flap)))
            fh.seek(0, os.SEEK_END)
            for t in flap:
                nrm = np.cross(t[1] - t[0], t[2] - t[0])
                nrm = nrm / float(np.linalg.norm(nrm))
                fh.write(struct.pack("<3f", *nrm))
                for q in t:
                    fh.write(struct.pack("<3f", *q))
                fh.write(b"\0\0")
        report = {}
        out = _replane_mesh_file(p, report=report)
        assert out is not None, "a non-manifold flap must not lose the import"
        assert len(out.faces()) <= 20, f"got {len(out.faces())} faces"
    print(f"  replane OK: an unchainable region reports {status!r}, and a "
          f"non-manifold flap still imports ({len(out.faces())} faces)")


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
    """GH #49: a file was judged for the SUM of its bodies' faces.

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
    total backstop.

    RE-BLESSED AGAIN (2026-09-14): the two over-limit cases no longer RAISE.
    Both face gates now degrade the import to read-only reference geometry and
    report a structured `reference` reason, so what is asserted is the reason,
    not an exception. The per-body-vs-total distinction GH #49 is about is
    unchanged — that is still what this test guards."""
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

        # ...and a body that is ITSELF over the limit still lands as REFERENCE
        # geometry rather than as an editable body, naming which of the two it
        # is. It is no longer refused: "too detailed to edit" is a statement
        # about editing, so the user gets the geometry read-only instead of
        # getting nothing.
        builder.MAX_IMPORT_FACES = 20
        res = import_geometry(two_stl, "stl")
        ref = res.get("reference")
        assert ref, f"a 22-face body at a 20 limit must degrade, got: {res}"
        assert ref["why"] == "tooManyFaces", ref
        assert ref["faces"] == 22, (
            f"the note must quote the POST-FIT count, got: {ref}")
        assert ref["bodyIndex"] == 1 and ref["bodyCount"] == 2, (
            f"the note must say WHICH body is too detailed, got: {ref}")
        assert res["faces"] == 44, (
            f"the degraded import must still return the geometry, got {res['faces']}")

        # ...and the total backstop is a separate guard with its own reason, so
        # the frontend can word it as a viewport cost rather than as an
        # editability judgement.
        builder.MAX_IMPORT_FACES = 30
        builder.MAX_IMPORT_TOTAL_FACES = 30
        res = import_geometry(two_stl, "stl")
        ref = res.get("reference")
        assert ref, f"44 total faces must trip a 30-face total backstop: {res}"
        assert ref["why"] == "tooManyTotalFaces", (
            f"the viewport backstop must not read as an editability "
            f"judgement: {ref}")
        assert ref["faces"] == 44 and ref["bodies"] == 2, ref
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


def test_export_project_3mf_paints_whole_body_off_slot_zero():
    """A body on any slot but 0 must carry `paint_color` on EVERY triangle.

    Verified against PrusaSlicer 2.9.6 on 2026-09-08: it ignores Bambu's
    per-object `extruder` in model_settings.config (a slot-1 body came back on
    extruder 1) but honours per-triangle paint exactly as Orca does. Painting
    the base slot onto every triangle is the one encoding both slicers read.
    A face explicitly on slot 0 of such a body must say "4" outright, or
    PrusaSlicer would paint it the body's colour."""
    import re
    from project3mf import _mesh_xml

    # Two triangles on face 0, one on face 1, one on face 2.
    pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]
    idx = [0, 1, 2, 1, 3, 2, 0, 2, 3, 0, 3, 1]
    face_ids = [0, 0, 1, 2]

    def paints(xml):
        return [re.search(r'paint_color="([^"]*)"', t) and
                re.search(r'paint_color="([^"]*)"', t).group(1)
                for t in re.findall(r"<triangle [^>]*/>", xml)]

    # Slot-0 body: only the off-base face is painted (unchanged behaviour).
    assert paints(_mesh_xml(pos, idx, face_ids, [None, 2, None], base_slot=0)) == [None, None, "0C", None]
    # Slot-1 body, no face paint: every triangle says slot 1.
    assert paints(_mesh_xml(pos, idx, None, None, base_slot=1)) == ["8"] * 4
    # Slot-1 body with faces on slot 2 and slot 0: base fills the gaps, and the
    # slot-0 face is written out explicitly.
    assert paints(_mesh_xml(pos, idx, face_ids, [None, 2, 0], base_slot=1)) == ["8", "8", "0C", "4"]
    print("  whole-body paint off slot 0 OK")
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


def test_offset_ladder():
    """`_offset_faces` is a ladder now, and this pins the three things that must
    not silently invert.

    The reason it is a ladder: the single BRepOffset call it used to be is
    broadly broken on imported geometry. Measured over 198 bodies of a real
    STEP import, offsetting the two largest cylindrical faces of each by
    +0.15 mm, one subprocess per body: 115 attempts -> 60 completed, 50 refused,
    5 ran past 20 s, and 17 MORE bodies took the process down with SIGSEGV. On
    faces >= 1 mm^2, 8 completed and every one of those was a 4-face washer.

    1. RUNG 2 IS EXACT, AND AGREES WITH THE RUNG IT REPLACED. A straight bore is
       an annulus, so the answer is closed form. It is asserted against
       BRepOffset's own output on a case BRepOffset handles, because the sign
       convention is the easy thing to get backwards: `d` runs along the face's
       OUTWARD normal, which for a bore points into the hole, so +d SHRINKS it.

    2. RUNG 2 DECLINES A LIP. A chamfered bore is rung 3's class (stage 2) and
       must not be answered with a plain annulus, which would leave the chamfer
       pinned at the old radius.

    3. THE PROBE FAILS CLOSED. This is the single easiest thing to get
       backwards, and it inverts the guard: `_probe_blend` fails OPEN (only a
       timeout refuses) because a fillet that fails fast has a better message
       from OCCT than the guard could write. Offsets are the SIGSEGV class, and
       a SIGSEGV produces silence rather than a raise, so silence here has to
       mean NO. Asserted by driving the verdict directly — a test that depends
       on a real crash would be asserting OCCT's build, not this code — plus one
       real end-to-end run on the fixture that does core locally, whose whole
       job is to still be running on the next line.
    """
    from build123d import Cylinder, GeomType as _GT, chamfer

    def _radii(shape):
        out = []
        for f in shape.faces():
            fr = builder._cylinder_frame(f)
            if fr is not None:
                out.append(fr[1])
        return sorted(out)

    # --- 1. rung 2 is exact, and matches BRepOffset where both run -----------
    # A 20x20x10 plate with a plain r=4 through bore. Built from sketches and
    # NOT from the box primitive with a symmetric cut: a symmetric extrude
    # leaves a seam at the sketch plane that splits the bore into two
    # cylindrical faces of half the length, so the closed form below would be
    # comparing against the wrong L.
    plate, err, _ = rebuild({"parameters": {}, "features": [
        {"id": "sk0", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "id": "r", "width": 20, "height": 20}]},
        {"id": "ex0", "type": "extrude", "sketch": "sk0", "distance": 10},
        {"id": "sk", "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "id": "c", "radius": 4, "x": 0, "y": 0}]},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10,
         "operation": "cut"}]})
    assert not err, err
    bore = next(f for f in plate.faces() if f.geom_type == _GT.CYLINDER)
    assert abs(bore.area - 2 * math.pi * 4 * 10) < 1e-6, (
        f"the fixture's bore is not one full-length face: area {bore.area:.4f}")
    base_vol, base_faces = plate.volume, len(plate.faces())

    for d, want_r in ((1.0, 3.0), (-1.0, 5.0)):
        got = builder._offset_cylinder_by_boolean(plate, bore, d)
        assert got is not None, f"rung 2 declined a plain straight bore at d={d}"
        want_dv = math.pi * abs(want_r**2 - 16.0) * 10.0 * (1 if d > 0 else -1)
        dv = got.volume - base_vol
        assert abs(dv - want_dv) < 1e-6, (
            f"rung 2 at d={d}: dV {dv:+.6f}, closed form says {want_dv:+.6f}")
        assert _radii(got) == [want_r], (
            f"rung 2 at d={d}: bore is now {_radii(got)}, wanted [{want_r}] — +d runs "
            "along the face's OUTWARD normal, which on a bore points into the hole")
        assert got.is_valid and len(got.faces()) == base_faces, (
            f"rung 2 at d={d} changed the topology: {len(got.faces())} faces, valid "
            f"{got.is_valid}")
        # the rung it replaced, on a body BRepOffset copes with: same answer
        ref = builder._brep_offset_pass(plate, [(bore, d)])
        assert abs(ref.volume - got.volume) < 1e-6 and _radii(ref) == _radii(got), (
            f"rung 2 and BRepOffset disagree at d={d}: {got.volume:.6f}/{_radii(got)} "
            f"vs {ref.volume:.6f}/{_radii(ref)}")

    # --- 2. rung 2 declines a lip -------------------------------------------
    # A tube whose bore carries a 0.3 mm chamfer at each end: two CONE faces
    # neighbouring the wall. Offsetting that as a plain annulus would move the
    # wall and leave the chamfer pinned at the old radius, which is exactly the
    # silent wrong answer BRepOffset already gives here (measured: the chamfer
    # grows 0.3 -> 0.45 mm while the opening stays put).
    tube = Cylinder(2, 4) - Cylinder(1.3, 4)
    rim = [e for e in tube.edges()
           if e.geom_type == _GT.CIRCLE and abs(e.radius - 1.3) < 1e-6]
    assert len(rim) == 2, f"expected two bore rims to chamfer, got {len(rim)}"
    tube = chamfer(rim, length=0.3)
    cones = [f for f in tube.faces() if f.geom_type == _GT.CONE]
    assert len(cones) == 2, f"the fixture must have two chamfers, got {len(cones)} cones"
    lip_bore = next(f for f in tube.faces()
                    if f.geom_type == _GT.CYLINDER and abs(f.radius - 1.3) < 1e-6)
    assert builder._offset_cylinder_by_boolean(tube, lip_bore, 0.15) is None, (
        "rung 2 answered a CHAMFERED bore with a plain annulus — that leaves the "
        "chamfer at the old radius")
    outer = next(f for f in tube.faces()
                 if f.geom_type == _GT.CYLINDER and abs(f.radius - 2.0) < 1e-6)
    assert builder._offset_cylinder_by_boolean(tube, outer, 0.15) is not None, (
        "rung 2 declined the tube's plain OUTER wall — the lip screen is reading "
        "the whole body instead of the face's own neighbours")

    # --- 3. the probe fails CLOSED, and the honest message survives ----------
    assert builder._offset_needs_probing(tube, [(lip_bore, 0.15)]), \
        "a curved face must be probed"
    assert not builder._offset_needs_probing(plate, [(plate.faces().sort_by()[0], 1.0)]), (
        "a planar face on a small body must NOT pay a fork — that is what kept the "
        "fillet probe from adding 27 minutes to this test leg")

    # Driven through STUBS, both sides. The verdict is stubbed because a test
    # that waited for a real SIGSEGV would be asserting OCCT's build rather than
    # this file; the BRepOffset pass is stubbed because ACTUALLY RUNNING it on
    # this fixture cores the interpreter, which is the whole reason the probe
    # exists and would take the test suite with it.
    real_probe, real_pass = builder._probe_offsets, builder._brep_offset_pass
    calls = []
    try:
        # The stub returns the INPUT BODY, not a sentinel: rung 4's result now
        # goes through `_offset_result_reason`, which reads the shape, so a
        # sentinel would be refused as unauditable and this test would be
        # asserting the stub rather than the ladder.
        builder._brep_offset_pass = lambda part, pairs: calls.append(pairs) or tube
        builder._probe_offsets = lambda part, pairs: "unsafe"
        try:
            builder._offset_faces(tube, [(lip_bore, 0.15), (outer, 0.15)])
            raise AssertionError("an UNREPORTED probe let the offset through — the guard "
                                 "is failing OPEN, and a SIGSEGV reports nothing")
        except ValueError as e:
            assert "sandbox" in str(e), f"wrong refusal for a silent probe: {e}"
        assert not calls, "the kernel was called anyway after a silent probe"
        # A child that RAISED did report, so it is not the silence this guard is
        # about: let the real call run and raise the same way, because there OCCT's
        # own message is accurate and a different amount genuinely does help.
        builder._probe_offsets = lambda part, pairs: "raise"
        got = builder._offset_faces(tube, [(lip_bore, 0.15), (outer, 0.15)])
        assert got is tube and len(calls) == 1 and len(calls[0]) == 2, (
            "a reported kernel refusal did not reach the kernel, so the user would "
            f"get the guard's sentence instead of OCCT's: {got}, {calls}")
    finally:
        builder._probe_offsets, builder._brep_offset_pass = real_probe, real_pass

    src = inspect.getsource(builder._brep_offset_pass)
    assert "can't offset this face by that amount" in src, (
        "the honest IsDone()==false message was reworded — a face this path has "
        "always declined must not start saying something different")

    # One real end-to-end pass on the fixture that cores this OCCT build. The
    # assertion is deliberately weak, because what is being observed is that the
    # NEXT line runs at all.
    try:
        builder._offset_faces(tube, [(lip_bore, 0.15)])
        outcome = "built"
    except ValueError as e:
        outcome = "sandbox" if "sandbox" in str(e) else "kernel"
    print(f"  offset-ladder OK: rung 2 exact and agrees with BRepOffset, declines a "
          f"chamfered bore, probe fails closed (live chamfered bore: {outcome})")


def _lipped_bore(lip):
    """A tube whose r=1.3 bore carries a 0.3 mm lip at each end.

    `lip` is "chamfer", "fillet" or "mixed" (chamfer one end, fillet the other).
    Built from primitives rather than loaded from a .brep, because the same
    nominal shape read back from a file SIGSEGVs this OCCT build where the
    in-process one does not (measured, stage 1 concern 3) — and a test whose
    subject is arithmetic must not be gambling on which of those it got."""
    from build123d import Cylinder, GeomType as _GT, chamfer, fillet

    def rims(shape, pick=None):
        out = [e for e in shape.edges()
               if e.geom_type == _GT.CIRCLE and abs(e.radius - 1.3) < 1e-6]
        return out if pick is None else [e for e in out if pick(e.center().Z)]

    tube = Cylinder(2, 4) - Cylinder(1.3, 4)
    assert len(rims(tube)) == 2, "the fixture must start with two bore rims"
    if lip == "chamfer":
        return chamfer(rims(tube), length=0.3)
    if lip == "fillet":
        return fillet(rims(tube), radius=0.3)
    out = fillet(rims(tube, lambda z: z > 0), radius=0.3)
    return chamfer(rims(out, lambda z: z < 0), length=0.3)


def _profile_dvolume_numeric(face, o, ax, delta):
    """|pi * integral[(rho+delta)^2 - rho^2] dz| over one face, NUMERICALLY.

    The independent twin of `builder._retune_face_dvolume`, and deliberately
    written from the surface's own `Value(u, v)` rather than from its analytic
    parameters, so it shares no arithmetic with the thing it checks.

    Romberg and not a plain trapezoid: the integrand is smooth in v but the
    torus profile is sinusoidal, and a trapezoid at n = 2000 lands 1.9e-8
    relative, which is a blunter ruler than the closed form it is meant to
    police. One Richardson step off n = 1000 / 2000 takes that to 1.2e-15 for
    0.011 s.

    ABSOLUTE VALUE, because the traversal sign is not part of the integral —
    `_retune_face_dvolume` multiplies it in from the face's outward normal, and
    the v direction here is whatever OCCT chose. That sign is pinned
    end-to-end instead, by the measured-vs-analytic assertion below."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    s = BRepAdaptor_Surface(face)
    v0, v1 = s.FirstVParameter(), s.LastVParameter()
    um = 0.5 * (s.FirstUParameter() + s.LastUParameter())

    def rho_z(v):
        p = s.Value(um, v)
        wx, wy, wz = p.X() - o[0], p.Y() - o[1], p.Z() - o[2]
        z = wx * ax[0] + wy * ax[1] + wz * ax[2]
        rx, ry, rz = wx - z * ax[0], wy - z * ax[1], wz - z * ax[2]
        return math.sqrt(rx * rx + ry * ry + rz * rz), z

    def trapezoid(n):
        total = 0.0
        pr, pz = rho_z(v0)
        for i in range(1, n + 1):
            cr, cz = rho_z(v0 + (v1 - v0) * i / n)
            total += 0.5 * (((pr + delta) ** 2 - pr * pr)
                            + ((cr + delta) ** 2 - cr * cr)) * (cz - pz)
            pr, pz = cr, cz
        return total

    coarse, fine = trapezoid(1000), trapezoid(2000)
    return abs(math.pi * (4.0 * fine - coarse) / 3.0)


def test_retune_radially():
    """Rung 3 of the offset ladder — the one that stops the ladder shipping a
    silently wrong lip.

    What it used to do, measured on exactly the fixture below: BRepOffset
    returns a VALID solid in which the cone surface never moved and was merely
    re-trimmed, so the chamfer grows 0.3 -> 0.45 mm while the top opening stays
    pinned at 1.6. `mk.IsDone()` is true throughout. Nothing in the old code
    could tell.

    1. THE LIP KEEPS ITS SIZE, and the volume is checked against a frustum
       formula written out by hand here — not against the rung's own analytic,
       which is what its ORACLE 3 already compares to and therefore cannot be
       the test's oracle too.

    2. THE CLOSED FORM MATCHES A NUMERICAL INTEGRATION of the same surface, per
       face, for all three surface types. This is kept as a test and not left
       as a one-off measurement because the closed form is the rung's OWN
       oracle: get the sign or a term wrong on one face of a chain and what is
       left is an oracle that happily accepts a result off by twice that face's
       contribution.

    3. EVERY PCURVE SURVIVES. The claim that a pure radial bump leaves every
       pcurve valid verbatim is a property of OCCT's parametrisation, not of
       this code, and nothing else here would notice if it stopped holding —
       the result would be faces whose boundaries are not on them, which is a
       far worse failure than a refusal.

    4. THE INPUT IS NOT MUTATED. The edit is done in place on a deep copy, and
       `BRepBuilderAPI_Copy(shape, copyGeom=True)` is what makes that true;
       with copyGeom off, the Geom handles are shared and the caller's own body
       changes under it. On an import that reaches further than the caller —
       measured, editing body 10 of the reference STEP would drag its siblings
       19 and 22 — but a local check is enough to pin the flag.

    5. THE ROUND TRIP IS EXACT. +d then -d returns the original volume and the
       original face inventory. Nothing in that routes through the analytic
       model, so a self-consistent wrong model cannot hide inside it."""
    from build123d import GeomType as _GT
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.TopAbs import TopAbs_EDGE

    def cone_size(shape):
        """Every cone as (half angle deg, radial size, axial size) — read at the
        face's OWN v range. Never RefRadius: that is the radius at v = 0, which
        on a real lip is routinely outside the face's range entirely."""
        out = []
        for f in shape.faces():
            if f.geom_type != _GT.CONE:
                continue
            s = BRepAdaptor_Surface(f.wrapped)
            c = s.Cone()
            um = 0.5 * (s.FirstUParameter() + s.LastUParameter())
            sa = math.sin(c.SemiAngle())
            v0, v1 = s.FirstVParameter(), s.LastVParameter()
            r0, r1 = c.RefRadius() + v0 * sa, c.RefRadius() + v1 * sa
            p0, p1 = s.Value(um, v0), s.Value(um, v1)
            axial = abs((p1.Z() - p0.Z()))
            out.append((round(math.degrees(abs(c.SemiAngle())), 9),
                        round(abs(r1 - r0), 9), round(axial, 9)))
        return sorted(out)

    def torus_size(shape):
        out = []
        for f in shape.faces():
            if f.geom_type != _GT.TORUS:
                continue
            s = BRepAdaptor_Surface(f.wrapped)
            out.append((round(s.Torus().MinorRadius(), 9),
                        round(s.LastVParameter() - s.FirstVParameter(), 9)))
        return sorted(out)

    def radii(shape):
        return sorted(round(f.radius, 9) for f in shape.faces()
                      if f.geom_type == _GT.CYLINDER)

    def bore_of(shape):
        return next(f for f in shape.faces()
                    if f.geom_type == _GT.CYLINDER and abs(f.radius - 1.3) < 1e-6)

    # --- 1. the lip keeps its size ------------------------------------------
    tube = _lipped_bore("chamfer")
    bore = bore_of(tube)
    before_cones, before_tori = cone_size(tube), torus_size(tube)
    assert before_cones == [(45.0, 0.3, 0.3)] * 2, (
        f"the fixture's chamfers are not 0.3 mm at 45 deg: {before_cones}")

    got = builder._offset_faces(tube, [(bore, 0.15)])
    assert got is not None and got.is_valid, "the ladder did not build a valid body"
    # Named separately from the ladder call above so that a rung 3 that DECLINES
    # is reported as a decline. Without this, a broken rung 3 falls through to
    # BRepOffset and the failure below reads as BRepOffset's old defect, which
    # sends the next reader to the wrong function.
    assert builder._retune_radially(tube, bore, 0.15) is not None, (
        "rung 3 declined a plain chamfered bore, so the ladder fell through to "
        "BRepOffset — whatever is asserted below is BRepOffset's answer, not this "
        "rung's")
    assert len(got.faces()) == len(tube.faces()), (
        f"rung 3 must not change the topology: {len(tube.faces())} faces -> "
        f"{len(got.faces())}")
    assert radii(got) == [1.15, 2.0], (
        f"the wall did not move to 1.15 and only the wall: {radii(got)} — +d runs "
        "along the face's OUTWARD normal, which on a bore points into the hole")
    assert cone_size(got) == before_cones, (
        f"THE CHAMFER CHANGED SIZE: {before_cones} -> {cone_size(got)}. That is the "
        "exact defect rung 3 exists to stop; BRepOffset grows it 0.3 -> 0.45 here "
        "and still reports success")

    # Hand-derived, from the frustum formula and nothing else. The bore is a
    # 3.4 mm straight wall between two 45-degree frusta running 1.3 -> 1.6 over
    # 0.3 mm of axis. Shrinking the hole by 0.15 ADDS material.
    def frustum(r_lo, r_hi, h):
        return math.pi * h / 3.0 * (r_lo * r_lo + r_lo * r_hi + r_hi * r_hi)

    want_dv = (math.pi * (1.3 ** 2 - 1.15 ** 2) * 3.4
               + 2 * (frustum(1.3, 1.6, 0.3) - frustum(1.15, 1.45, 0.3)))
    assert abs((got.volume - tube.volume) - want_dv) < 1e-9, (
        f"dV {got.volume - tube.volume:+.9f}, the frustum formula says "
        f"{want_dv:+.9f}")

    # --- 2. the closed form against a numerical integration, all three types --
    mixed = _lipped_bore("mixed")
    target = bore_of(mixed)
    _idx = next(i for i, f in enumerate(builder._retune_faces(mixed.wrapped))
                if f.IsSame(target.wrapped))
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    scratch = BRepBuilderAPI_Copy(mixed.wrapped, True, False).Shape()
    plan = builder._retune_plan(scratch, builder._retune_faces(scratch)[_idx], 0.15)
    kinds = set()
    for f in plan["affected"]:
        closed = builder._retune_face_dvolume(
            f, plan["origin"], plan["axis"], plan["delta"])
        numeric = _profile_dvolume_numeric(
            f, plan["origin"], plan["axis"], plan["delta"])
        kinds.add(str(BRepAdaptor_Surface(f).GetType()).split("_")[-1])
        assert abs(abs(closed) - numeric) <= 1e-12 * numeric, (
            f"the closed form for a {BRepAdaptor_Surface(f).GetType()} face reads "
            f"{abs(closed):.13f}, integrating the same surface gives {numeric:.13f}")
    assert kinds == {"Cylinder", "Cone", "Torus"}, (
        f"this leg must exercise all three surface types, it saw {sorted(kinds)}")
    assert len(plan["affected"]) == 3 and len(plan["lips"]) == 2, (
        f"the BFS did not pick up both lips: {len(plan['affected'])} faces, "
        f"{len(plan['lips'])} lips")

    # --- 3. every pcurve survives -------------------------------------------
    # If this ever fails the operation has started producing faces whose
    # boundaries are not on them, which every check downstream would wave
    # through — the topology is untouched, so nothing counts as different.
    mixed_out = builder._retune_radially(mixed, target, 0.15)
    assert mixed_out is not None, "rung 3 declined the chamfer-plus-fillet bore"
    for f in mixed_out.faces():
        for e in builder._retune_explore(f.wrapped, TopAbs_EDGE):
            from OCP.TopoDS import TopoDS
            pc = BRep_Tool.CurveOnSurface_s(TopoDS.Edge_s(e), f.wrapped, 0.0, 0.0)
            assert pc is not None, (
                "a retuned face lost the pcurve of one of its own edges — the "
                "parametric domain moved, which is the one thing this method "
                "assumes never happens")
    assert torus_size(mixed_out) == torus_size(mixed) and \
        cone_size(mixed_out) == cone_size(mixed), (
        f"the mixed lip changed size: cones {cone_size(mixed)} -> "
        f"{cone_size(mixed_out)}, tori {torus_size(mixed)} -> {torus_size(mixed_out)}")

    # --- 4. the input is not mutated ----------------------------------------
    fil = _lipped_bore("fillet")
    snapshot = (round(fil.volume, 9), radii(fil), torus_size(fil))
    assert builder._retune_radially(fil, bore_of(fil), 0.15) is not None
    assert (round(fil.volume, 9), radii(fil), torus_size(fil)) == snapshot, (
        "rung 3 edited the CALLER's body — BRepBuilderAPI_Copy was called without "
        "copyGeom, so the Geom handles are shared")

    # --- 5. the round trip is exact -----------------------------------------
    for lip in ("chamfer", "fillet", "mixed"):
        src = _lipped_bore(lip)
        out = builder._retune_radially(src, bore_of(src), 0.15)
        assert out is not None, f"rung 3 declined the {lip} bore"
        back = builder._retune_radially(
            out, next(f for f in out.faces()
                      if f.geom_type == _GT.CYLINDER and abs(f.radius - 1.15) < 1e-9),
            -0.15)
        assert back is not None, f"rung 3 could not undo the {lip} bore"
        assert abs(back.volume - src.volume) < 1e-9, (
            f"{lip}: +0.15 then -0.15 left {back.volume - src.volume:+.12f} mm^3 behind")
        assert radii(back) == radii(src) and cone_size(back) == cone_size(src) \
            and torus_size(back) == torus_size(src), (
            f"{lip}: the round trip did not restore the face inventory")

    print("  retune OK: chamfer and fillet keep their size, closed form matches a "
          "numerical integration on all three surface types, pcurves survive, the "
          "round trip is exact")


# --- stage 3: the eight screens, and the fixtures that make them provable ----
#
# All four bodies are built from primitives in process rather than read from a
# .brep, for the reason `_lipped_bore` gives. They are the judge's fixtures
# reproduced: the counterbore body comes out at 10912.796114 mm^3 and the taper's
# band ratio at 0.4180, matching /tmp/jx_cbore_break.brep and
# /tmp/jx_taper_lip.brep to the digit.

def _cbore_break():
    """A 3 mm bore whose 0.3 mm chamfer lands on a COUNTERBORE FLOOR only 0.2 mm
    wide (r 3.3 -> 3.5). Grow the bore and the chamfer walks off the outer edge
    of that floor and undercuts the counterbore wall — and the result is a valid,
    watertight, single solid with the right volume and a perfectly preserved
    0.3 mm x 45 degree chamfer. Graft 1's fixture."""
    from build123d import Box, Cylinder, GeomType as _GT, Pos, chamfer

    body = Box(24, 24, 20) - Cylinder(3, 20) - Pos(0, 0, 8) * Cylinder(3.5, 4)
    rim = [e for e in body.edges()
           if e.geom_type == _GT.CIRCLE and abs(e.radius - 3.0) < 1e-9
           and abs(e.center().Z - 6.0) < 1e-9]
    assert len(rim) == 1, "cbore fixture: expected exactly one rim on the floor"
    return chamfer(rim, length=0.3)


def _taper_bore():
    """A 3 mm bore opening into a 22 mm 8 degree FUNCTIONAL TAPER — coaxial, full
    360, meeting the wall at exactly r, one perpendicular plane beyond it, and
    not a lip. Graft 2's fixture."""
    from build123d import Cone, Cylinder, Pos

    return (Cylinder(12, 82) - Cylinder(3, 82)
            - Pos(0, 0, 30.0) * Cone(3.0, 6.09, 22.0))


def _cross_near():
    """A 3 mm bore with a 1.5 mm cross hole passing 0.20 mm clear of its wall, at
    half height, so it shares no edge and no far plane with the bore and graft 1
    structurally cannot see it. Graft 6's fixture."""
    from build123d import Axis, Box, Cylinder, Pos, Rot, chamfer

    body = Box(40, 40, 30) - Cylinder(3.0, 30)
    body = chamfer(body.edges().filter_by(Axis.Z, reverse=True)
                   .group_by(Axis.Z)[-1], 0.5)
    return body - Pos(0, 4.7, 0) * Rot(0, 90, 0) * Cylinder(1.5, 40)


def _second_solid():
    """A bored block and a SEPARATE 0.4 mm solid standing at rho 3.5..3.9, in the
    ring the wall sweeps when the bore grows.

    A compound, because that is what a STEP import is — the reference import is
    2009 solids in one — and because it is the one arrangement every other oracle
    is structurally blind to: `BRepCheck_Analyzer` validates each solid on its
    own and both are fine, the second solid's volume never changes so the
    analytic dV is exactly right, and the wall's final position is nowhere near
    it so no distance is ever zero. Graft 7's fixture."""
    from build123d import Axis, Box, Compound, Cylinder, Pos, chamfer

    body = Box(40, 40, 40) - Cylinder(3.0, 40)
    body = chamfer(body.edges().filter_by(Axis.Z, reverse=True)
                   .group_by(Axis.Z)[-1], 0.5)
    return Compound([body, Pos(3.7, 0, 0) * Box(0.4, 0.4, 0.4)])


def _pocketed_bore():
    """A 3 mm bore with an 8x2x4 mm pocket milled into its wall, so the wall's
    (u, v) domain has a BITE out of it. Graft 4's fixture."""
    from build123d import Box, Cylinder, Pos

    return Box(30, 30, 30) - Cylinder(3, 30) - Pos(6, 0, 0) * Box(8, 2, 4)


def _bore_face(shape, r=3.0):
    from build123d import GeomType as _GT

    return max((f for f in shape.faces()
                if f.geom_type == _GT.CYLINDER and abs(f.radius - r) < 1e-6),
               key=lambda f: f.area)


def _screen_verdict(shape, r, d):
    """"ok" or the refusal sentence, for one attempt."""
    try:
        builder._retune_radially_report(shape, _bore_face(shape, r), d)
        return "ok"
    except ValueError as e:
        return str(e)


def test_retune_screens():
    """Stage 3's eight screens: each one firing on the geometry it exists for,
    and staying quiet on the geometry next to it.

    THE SHAPE OF EVERY ASSERTION HERE is a PAIR — the same fixture at a distance
    that is fine and at a distance that is not — because a screen that refuses
    everything passes a one-sided test perfectly. The census is the other half of
    that argument (all eight together cost 0 of 119 accepted attempts over the
    2009-body reference import); this is the half that says they do anything.

    `SINDRI_OFFSET_NO_ORACLES` is read ONCE at import, so a test process cannot
    flip it. That is deliberate — it is what makes "unreachable from the wire"
    checkable — and it means the guards-off half of each pair is asserted here as
    a property of the construction instead: the wrong answer each screen prevents
    is spelled out in the assertion message, and was measured by running this
    same file's fixtures under the hatch. Section 8 proves the hatch is wired to
    something and is not reachable from request data."""
    from OCP.TopAbs import TopAbs_EDGE
    from build123d import Box, Cylinder, GeomType as _GT, Pos

    # --- 1. the radial-overrun screen ---------------------------------------
    cb = _cbore_break()
    assert abs(cb.volume - 10912.796114) < 1e-5, (
        f"the counterbore fixture drifted: {cb.volume:.6f} mm^3, the judge's "
        f"jx_cbore_break.brep is 10912.796114")
    grown = _screen_verdict(cb, 3.0, -0.25)
    assert "3.5500" in grown and "3.5000" in grown, (
        "graft 1 did not refuse the chamfer walking off the counterbore floor: "
        f"{grown!r}. With the guards off this returns a VALID single solid with "
        "the correct volume and a perfect 0.3 mm chamfer, and a 0.05 mm "
        "inward-overhanging knife edge")
    assert _screen_verdict(cb, 3.0, -0.50) != "ok", (
        "graft 1 let the chamfer become a buried internal groove")
    assert _screen_verdict(cb, 3.0, +0.15) == "ok", (
        "graft 1 refused the bore SHRINKING, which only widens the floor it "
        "sits on — the screen is reading the direction wrong")

    # --- 2. the band-shape screen -------------------------------------------
    tp = _taper_bore()
    cone = next(f for f in tp.faces() if f.geom_type == _GT.CONE)
    ratio = builder._face_width(cone) / max(e.length for e in cone.edges())
    assert abs(ratio - 0.4180) < 5e-4, (
        f"the taper fixture drifted: band ratio {ratio:.4f}, the judge's "
        f"jx_taper_lip.brep is 0.4180")
    assert not builder._retune_is_band_shaped(cone.wrapped), (
        "graft 2 thinks a 22 mm 8 degree functional taper is a chamfer")
    for d in (+0.15, -0.15):
        assert "taper" in _screen_verdict(tp, 3.0, d), (
            f"graft 2 accepted the functional taper at d={d:+.2f}; with the "
            "guards off its large end silently moves 6.09 -> 5.94 mm, which is "
            "not an offset of the bore, it is a redesign of the part")
    assert _screen_verdict(tp, 12.0, +0.15) == "ok", (
        "graft 2 refused the OUTER wall of the same body, which has no ring "
        "beyond it at all — the screen is being applied to the wrong face")
    for lip in ("chamfer", "fillet", "mixed"):
        src = _lipped_bore(lip)
        for f in src.faces():
            if f.geom_type in (_GT.CONE, _GT.TORUS):
                assert builder._retune_is_band_shaped(f.wrapped), (
                    f"graft 2 refused a real 0.3 mm {lip} lip")

    # --- 3. the axis is in the fingerprint ----------------------------------
    twin = Box(30, 30, 10) - Pos(-6, 0, 0) * Cylinder(3, 10) \
        - Pos(6, 0, 0) * Cylinder(3, 10)
    walls = [f for f in twin.faces()
             if f.geom_type == _GT.CYLINDER and abs(f.radius - 3.0) < 1e-9]
    assert len(walls) == 2, "the twin-bore fixture lost a wall"
    a, b = (builder._retune_fingerprint(w.wrapped) for w in walls)
    assert a != b, (
        "graft 3 is not in: two unrelated bores drilled with the SAME DRILL "
        "fingerprint identically, so one can take the other's place in the "
        "audit unnoticed")
    assert a[:2] == b[:2], (
        "the two bores should agree on type and radius and differ only in axis; "
        f"{a} vs {b}")

    # --- 4. the lateral-area ruler ------------------------------------------
    # The before-the-move half. `_retune_plan` refuses this particular body
    # earlier — the pocket's side walls are planes parallel to the axis — so what
    # is provable is that the RULER works, which is what the screen is for: no
    # other check in the file states that a chained face fills its own (u, v) box.
    bitten = _bore_face(_pocketed_bore())
    want = builder._retune_band_area(bitten.wrapped)
    got = builder._retune_measured_area(bitten.wrapped)
    rel = abs(want - got) / abs(want)
    assert rel > 1e-3, (
        f"graft 4's ruler cannot see a bore wall with a pocket cut into it: "
        f"analytic {want:.6f} mm2 against measured {got:.6f}, {rel:.3e} relative")
    assert builder._retune_area_reason(
        {"affected": [bitten.wrapped]}, "before the move") is not None, (
        "graft 4 passed a face that is 1.4% short of the band it claims to be")
    for lip in ("chamfer", "fillet", "mixed"):
        src = _lipped_bore(lip)
        for f in src.faces():
            w = builder._retune_band_area(f.wrapped)
            if w is None:
                continue
            m = builder._retune_measured_area(f.wrapped)
            assert abs(w - m) <= max(1e-12, 1e-8 * abs(w)), (
                f"graft 4's band is too tight: a clean {lip} fixture face reads "
                f"{abs(w - m) / abs(w):.3e} relative")

    # --- 5. the feature moved by exactly delta ------------------------------
    # Fault injection, because the shipped code has no way to move a surface by
    # the wrong amount and a screen against an impossible fault is untested code.
    src = _lipped_bore("chamfer")
    real_surface = builder._retune_surface
    try:
        builder._retune_surface = lambda face, delta: real_surface(
            face, delta * 1.01)
        hurt = _screen_verdict(src, 1.3, 0.15)
    finally:
        builder._retune_surface = real_surface
    assert "did not move the way it was told to" in hurt, (
        f"graft 5 waved through a surface that moved 1% too far: {hurt!r}")
    assert _screen_verdict(_lipped_bore("chamfer"), 1.3, 0.15) == "ok", (
        "graft 5 refuses a correct move — the injection did not get undone, or "
        "the 1e-9 band is below the arithmetic's own noise")

    # --- 6. the clearance screen, banded ------------------------------------
    cn = _cross_near()
    assert _screen_verdict(cn, 3.0, -0.15) == "ok", (
        "graft 6 refused a bore whose 0.20 mm gap only closes to 0.05 mm — this "
        "is the false refusal the [0, r_reach] band caused in two designs, and "
        "scoping the band to what the surfaces sweep is what removes it")
    assert _screen_verdict(cn, 3.0, +0.15) == "ok", (
        "graft 6 refused a bore moving AWAY from its obstacle")
    hit = _screen_verdict(cn, 3.0, -0.20)
    assert "runs into other geometry" in hit, (
        f"graft 6 drilled the bore into the cross hole: {hit!r}. Nothing else "
        "objects — the topology never changed, so BRepCheck calls it valid and "
        "the analytic and measured volumes agree to 5e-12")

    # --- 7. what is standing inside the swept ring --------------------------
    ss = _second_solid()
    assert len(ss.solids()) == 2, "the second-solid fixture collapsed into one"
    assert _screen_verdict(ss, 3.0, -0.15) == "ok", (
        "graft 7 refused a wall that stops 0.35 mm short of the second solid")
    swept = _screen_verdict(ss, 3.0, -2.00)
    assert "standing inside the ring" in swept, (
        f"graft 7 swept the wall straight through a separate solid: {swept!r}. "
        "Every other oracle is green on that result — each solid is valid on its "
        "own, and the volume agrees with the analytic to 1.2e-11")

    # The band is cut from the geometry BEFORE the edit. Read afterwards it takes
    # the destination as the origin and shifts a second time, and this fixture is
    # the one that tells the two apart: a 3 mm bore growing to 3.5 sweeps
    # [3.0, 3.5] along the wall and [3.0, 4.0] only in the top 0.5 mm where the
    # chamfer is, so a void at rho 3.6..3.8 halfway down is clear of both — while
    # the doubly-shifted band reads [3.5, 4.0] along the whole wall and buries it.
    from build123d import Axis, chamfer
    near = Box(40, 40, 30) - Cylinder(3.0, 30)
    near = chamfer(near.edges().filter_by(Axis.Z, reverse=True)
                   .group_by(Axis.Z)[-1], 0.5)
    near = near - Pos(3.7, 0, 0) * Box(0.2, 0.2, 0.2)
    assert _screen_verdict(near, 3.0, -0.50) == "ok", (
        "a void 0.1 mm beyond where the wall stops was refused — the swept band "
        "is being read AFTER the edit, so it names a ring the feature has "
        "already left")

    # --- 8. the guards-off hatch --------------------------------------------
    assert builder._OFFSET_NO_ORACLES is False, (
        "the test process is running with SINDRI_OFFSET_NO_ORACLES set, so every "
        "assertion above was checking nothing")
    src = inspect.getsource(builder)
    assert src.count("SINDRI_OFFSET_NO_ORACLES") == 1, (
        "SINDRI_OFFSET_NO_ORACLES is read in more than one place; it must be the "
        "single module-level constant, fixed before any request is parsed")
    head = src.split("def ", 1)[0]
    assert "SINDRI_OFFSET_NO_ORACLES" in head or \
        "_OFFSET_NO_ORACLES = os.environ" in src, "the hatch is not read at import"
    for fn in (builder._retune_radially_report, builder._retune_plan):
        body = inspect.getsource(fn)
        assert "environ" not in body and "getenv" not in body, (
            f"{fn.__name__} reads the environment at call time — a request could "
            "then reach the hatch")
    assert src.count("_OFFSET_NO_ORACLES") >= 4, (
        "the hatch is declared but barely wired; it must gate the screens it "
        "claims to, or the with/without comparison it exists for is a fiction")

    # every screen above left the caller's body alone
    for shape in (cb, tp, cn):
        for f in shape.faces():
            for e in builder._retune_explore(f.wrapped, TopAbs_EDGE):
                assert e is not None
    assert abs(cb.volume - 10912.796114) < 1e-5, (
        "a screen mutated the caller's body while refusing it")

    print("  offset screens OK: radial overrun, band shape, axis in the "
          "fingerprint, lateral area, moved-by-delta, banded clearance, swept-ring "
          "inventory, and the guards-off hatch")


# ---------------------------------------------------------------------------
# The offset ladder on IMPORTED geometry.
#
# Every offset test above this line builds its own body. These four load files
# from sidecar/fixtures/, and the justification is measured rather than a
# preference: a .brep read back off disk and the same nominal shape built in
# process are NOT interchangeable on this path.
#
# The bushing below is the proof. `Cylinder(2, 4) - Cylinder(1.3, 4)` chamfered
# 0.3 gives the same 6 faces and the same volume to 1e-9 — 28.236634770 either
# way — and then `_brep_offset_pass` on its r=1.3 bore at +0.15 RETURNS from the
# primitive build (a valid solid at 31.992409, wrong: the chamfer grew 0.3 ->
# 0.45) and EXITS 139 from the file. `_probe_offsets` exists for the second of
# those, so a test for it has to use the file.
#
# fixtures/README.md carries the per-file provenance and says which of the four
# are reproducible from primitives (three of them are) and which is not.
# ---------------------------------------------------------------------------

_FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _fixture_shape(name):
    """Load sidecar/fixtures/<name>, or say plainly what was lost."""
    path = os.path.join(_FIXTURES, name)
    assert os.path.exists(path), (
        f"sidecar/fixtures/{name} is missing. It is imported provenance, not a "
        "shape this file can build — see fixtures/README.md before deciding it "
        "is safe to leave out")
    return builder.import_brep(path)


def _chamfer_bore_volume(r):
    """Closed-form volume of offset_chamfer_bore.brep with its bore at `r` mm.

    Outer cylinder r=2 h=4, minus (a 45 degree frustum r+0.3 -> r over 0.3, a
    straight bore of length 3.4, and the mirrored frustum). Written out here
    rather than taken from anything in builder.py: this is the test's oracle for
    rung 3 and it may not share arithmetic with the rung. It reproduces the
    file's own volume to 1e-9 at r=1.3 (28.236634770), which is what says the
    formula and the fixture are the same solid."""
    frustum = math.pi * 0.3 / 3.0 * (r * r + r * (r + 0.3) + (r + 0.3) ** 2)
    return math.pi * 2.0 ** 2 * 4.0 - (math.pi * r * r * 3.4 + 2 * frustum)


def _cone_lips(shape):
    """Every CONE face as (semi_deg, dR, axial, r_small, r_big), rounded to 6 dp.

    Decoded in the CONE'S OWN FRAME from `RefRadius`, `SemiAngle` and the face's
    v range, not by measuring rho about a guessed axis. These fixtures are STEP
    fragments that sit tens of mm from the world origin, and a first cut of this
    helper that assumed the Z axis through (0,0,0) read the bushing's 0.3 mm
    chamfer as dR 0.048 and then reported it UNCHANGED across an offset that had
    plainly moved it. `RefRadius` is the radius at v=0 and is routinely outside
    the face's own v range, so it is never read as an end radius — both ends are
    evaluated."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    out = []
    for f in shape.faces():
        s = BRepAdaptor_Surface(f.wrapped)
        if s.GetType() != GeomAbs_SurfaceType.GeomAbs_Cone:
            continue
        c = s.Cone()
        v0, v1 = s.FirstVParameter(), s.LastVParameter()
        r0 = c.RefRadius() + v0 * math.sin(c.SemiAngle())
        r1 = c.RefRadius() + v1 * math.sin(c.SemiAngle())
        z0, z1 = v0 * math.cos(c.SemiAngle()), v1 * math.cos(c.SemiAngle())
        out.append(tuple(round(x, 6) for x in (
            abs(math.degrees(c.SemiAngle())), abs(r1 - r0), abs(z1 - z0),
            min(r0, r1), max(r0, r1))))
    return sorted(out)


def _tori(shape):
    """(major, minor) per TORUS face, rounded to 6 dp."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    out = []
    for f in shape.faces():
        s = BRepAdaptor_Surface(f.wrapped)
        if s.GetType() == GeomAbs_SurfaceType.GeomAbs_Torus:
            out.append((round(s.Torus().MajorRadius(), 6),
                        round(s.Torus().MinorRadius(), 6)))
    return sorted(out)


def _cyl_radii(shape):
    from build123d import GeomType as _GT

    return sorted(round(f.radius, 6) for f in shape.faces()
                  if f.geom_type == _GT.CYLINDER)


def _guards_off(name, r, d):
    """What rung 3 WOULD have built with `SINDRI_OFFSET_NO_ORACLES=1`.

    A subprocess, and it has to be: the hatch is read once at import
    (`builder._OFFSET_NO_ORACLES`), deliberately, so that "no document and no
    wire message can reach it" is checkable rather than promised. The cost of
    that decision is that the guards-off half of an adversarial pair cannot be
    run in this process — `test_retune_screens` pays it by asserting the wrong
    answer in prose. Here the fixtures are files, so the child can just load one
    and report what came out, and the pair becomes two measurements instead of
    one measurement and an argument.

    Returns the child's dict, or raises with its stderr tail."""
    import json
    import subprocess

    here = os.path.dirname(os.path.abspath(builder.__file__))
    d_ = tempfile.mkdtemp()
    runner = os.path.join(d_, "guards_off.py")
    with open(runner, "w", encoding="utf-8") as fh:
        fh.write(
            "import json, sys\n"
            f"sys.path.insert(0, {here!r})\n"
            "import builder, test_smoke as T\n"
            f"s = T._fixture_shape({name!r})\n"
            f"out, rep = builder._retune_radially_report(s, T._bore_face(s, {r!r}), {d!r})\n"
            "print('OUT ' + json.dumps({'volume': out.volume, 'valid': out.is_valid,\n"
            "      'faces': len(out.faces()), 'cones': T._cone_lips(out),\n"
            "      'radii': T._cyl_radii(out), 'err': rep['err']}))\n"
        )
    env = dict(os.environ, SINDRI_OFFSET_NO_ORACLES="1", PYTHONIOENCODING="utf-8")
    proc = subprocess.run([sys.executable, runner], capture_output=True,
                          encoding="utf-8", errors="replace", env=env,
                          timeout=300)
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("OUT ")), None)
    assert line, (
        f"the guards-off child produced nothing for {name} (exit {proc.returncode}); "
        f"stderr tail: {proc.stderr[-400:]}")
    return json.loads(line[4:])


def test_offset_imported_bore_keeps_its_lip():
    """The two silent wrong answers this ladder was built to stop, on the
    imported bodies they were measured on.

    BOTH are `IsDone()`-true, `is_valid`-true results from BRepOffset. Nothing in
    the old code could tell, because the old code's only gate was `IsDone()`.

      A. offset_chamfer_bore.brep — the CHAMFER CHANGES SIZE. BRepOffset leaves
         the cone surface exactly where it is and re-trims it, so a 0.3 mm
         chamfer silently becomes 0.45 mm while the opening stays pinned. (On
         this file it does not even get that far: it exits 139. The 0.45 was
         measured on the primitive-built twin, which is the same solid to 1e-9.)

      B. offset_fillet_bore.brep — THE WHOLE SOLID MOVES. Offsetting the r=1.1
         bore by +0.15 also grows every fillet 0.3 -> 0.45 and pushes the r=6.5
         outer wall to 6.65: dV +67.173728 in about 4 ms, against +3.900565.

    The assertions are against a closed form written out in this file
    (`_chamfer_bore_volume`) and against the parameters of faces the user never
    selected. Not against `_retune_radially_report`'s own `err`, which is the
    rung's ORACLE 3 comparing the rung to itself."""
    # --- the fixture is the solid the closed form describes ------------------
    bushing = _fixture_shape("offset_chamfer_bore.brep")
    assert len(bushing.faces()) == 6 and bushing.is_valid, (
        f"the bushing changed: {len(bushing.faces())} faces, valid {bushing.is_valid}")
    assert abs(bushing.volume - _chamfer_bore_volume(1.3)) < 1e-9, (
        f"the fixture and the closed form have drifted apart: {bushing.volume:.9f} "
        f"vs {_chamfer_bore_volume(1.3):.9f}")

    outer, bore = _bore_face(bushing, 2.0), _bore_face(bushing, 1.3)
    lip_before = _cone_lips(bushing)
    assert lip_before == [(45.0, 0.3, 0.3, 1.3, 1.6)] * 2, (
        f"the bushing's two 0.3 mm chamfers are not what they were: {lip_before}")

    # --- 1. RUNG 2 answers the plain outer wall, exactly ---------------------
    # An annulus, so the answer is closed form. `d` runs along the face's
    # OUTWARD normal: on the outer wall that points away from the axis, so +d
    # GROWS it, and on the bore below it points into the hole, so +d SHRINKS it.
    # Length is read off the face's own area rather than assumed.
    length = outer.area / (2 * math.pi * 2.0)
    assert abs(length - 4.0) < 1e-9, f"the outer wall is not 4 mm long: {length:.9f}"
    rung2_dv = []
    for d, want_r in ((0.15, 2.15), (-0.15, 1.85)):
        got = builder._offset_cylinder_by_boolean(bushing, outer, d)
        assert got is not None, f"rung 2 declined the bushing's plain outer wall at d={d}"
        want_dv = math.pi * (want_r ** 2 - 4.0) * length
        rung2_dv.append(got.volume - bushing.volume)
        assert abs((got.volume - bushing.volume) - want_dv) < 1e-9, (
            f"rung 2 on the outer wall at d={d}: dV {got.volume - bushing.volume:+.9f}, "
            f"the annulus says {want_dv:+.9f}")
        assert got.is_valid and len(got.faces()) == 6, (
            f"rung 2 changed the bushing's topology at d={d}: {len(got.faces())} "
            f"faces, valid {got.is_valid}")
        assert _cyl_radii(got) == [1.3, want_r], (
            f"rung 2 at d={d} left the radii {_cyl_radii(got)}, wanted [1.3, {want_r}]")
        assert _cone_lips(got) == lip_before, (
            f"rung 2 on the OUTER wall disturbed the bore's chamfers: {_cone_lips(got)}")

    # ...and it must NOT be the rung that takes the chamfered bore. A plain
    # annulus there would move the wall and leave the cone pinned at the old
    # radius, which is defect A with the sign of the error reversed.
    assert builder._offset_cylinder_by_boolean(bushing, bore, 0.15) is None, (
        "rung 2 answered a CHAMFERED bore with an annulus — the chamfer would be "
        "left behind at the old radius")

    # --- 2. RUNG 3 moves the lip and does not resize it ----------------------
    # This is the regression test for defect A. dR and axial are the chamfer's
    # own 0.3 x 0.3; r_small tracks the bore. Volume against the closed form.
    for d, want_r in ((0.15, 1.15), (-0.15, 1.45)):
        got = builder._retune_radially(bushing, bore, d)
        assert got is not None, f"rung 3 declined the imported chamfered bore at d={d}"
        assert got.is_valid and len(got.faces()) == 6, (
            f"rung 3 at d={d}: {len(got.faces())} faces, valid {got.is_valid}")
        assert _cone_lips(got) == [(45.0, 0.3, 0.3, want_r, want_r + 0.3)] * 2, (
            f"the chamfer changed size at d={d}: {lip_before} -> {_cone_lips(got)}. "
            "0.3 -> 0.45 with the opening pinned is exactly what BRepOffset does here")
        assert _cyl_radii(got) == [want_r, 2.0], (
            f"rung 3 at d={d} left the radii {_cyl_radii(got)}, wanted "
            f"[{want_r}, 2.0] — the outer wall is not part of this feature")
        want_v = _chamfer_bore_volume(want_r)
        assert abs(got.volume - want_v) < 1e-9, (
            f"rung 3 at d={d}: {got.volume:.9f}, the closed form for a {want_r} mm "
            f"bore says {want_v:.9f}")

    # --- 3. RUNG 3 does not offset the whole solid ---------------------------
    # Defect B. Every face outside the feature must be bit-for-bit where it was:
    # the r=6.5 outer wall, and the two 0.3 mm rounds on ITS rims.
    filleted = _fixture_shape("offset_fillet_bore.brep")
    assert len(filleted.faces()) == 8 and _tori(filleted) == [
        (1.4, 0.3), (1.4, 0.3), (6.2, 0.3), (6.2, 0.3)], (
        f"the filleted fixture changed: {len(filleted.faces())} faces, {_tori(filleted)}")
    fb = _bore_face(filleted, 1.1)
    wall_len = fb.area / (2 * math.pi * 1.1)
    got = builder._retune_radially(filleted, fb, 0.15)
    assert got is not None, "rung 3 declined the imported filleted bore"
    assert _tori(got) == [(1.25, 0.3), (1.25, 0.3), (6.2, 0.3), (6.2, 0.3)], (
        f"the fillets are wrong: {_tori(got)}. Moving the OUTER pair, or growing "
        "any minor radius, is BRepOffset offsetting the whole solid")
    assert _cyl_radii(got) == [0.95, 6.5], (
        f"radii {_cyl_radii(got)}: the 6.5 outer wall moved, which is defect B")
    # The wall alone is not the answer: the two fillet rings carry the rest, and
    # the difference between those two numbers is the whole feature. Checked
    # against a numerical integration of the fixture's OWN three surfaces rather
    # than a remembered constant, which also puts the TORUS branch of that
    # integrator on imported geometry.
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    fpos = BRepAdaptor_Surface(fb.wrapped).Cylinder().Position()
    fo = (fpos.Location().X(), fpos.Location().Y(), fpos.Location().Z())
    fax = (fpos.Direction().X(), fpos.Direction().Y(), fpos.Direction().Z())
    fchain = [fb] + [f for f in filleted.faces()
                     if BRepAdaptor_Surface(f.wrapped).GetType()
                     == GeomAbs_SurfaceType.GeomAbs_Torus
                     and abs(BRepAdaptor_Surface(f.wrapped).Torus().MajorRadius()
                             - 1.4) < 1e-6]
    assert len(fchain) == 3, f"the filleted chain is wall + two rounds, got {len(fchain)}"
    want_dv = sum(_profile_dvolume_numeric(f.wrapped, fo, fax, -0.15) for f in fchain)
    wall_only = math.pi * (1.1 ** 2 - 0.95 ** 2) * wall_len
    dv = got.volume - filleted.volume
    assert abs(dv - want_dv) < 1e-9, (
        f"dV {dv:+.9f}, the integral over the same three faces says {want_dv:+.9f}")
    assert dv > wall_only + 0.5, (
        f"dV {dv:+.6f} is barely more than the wall alone ({wall_only:+.6f}), so "
        "the two rounds did not move with it")
    assert dv < 10.0, (
        f"dV {dv:+.6f}: BRepOffset's whole-solid answer on this body is +67.173728, "
        "and anything near it means every face moved")
    assert got.is_valid and len(got.faces()) == 8, (
        f"rung 3 on the filleted bore: {len(got.faces())} faces, valid {got.is_valid}")

    print(f"  imported bore OK: rung 2 outer wall exact ({rung2_dv[0]:+.6f}/"
          f"{rung2_dv[1]:+.6f}), rung 3 keeps 45deg x 0.3 x 0.3 at r 1.15 and 1.45, "
          f"filleted bore dV {dv:+.6f} and not +67.173728")


def test_offset_refuses_an_undercut_and_a_taper():
    """The two shapes that separate "a lip the wall may drag along with it" from
    "geometry that must be left alone", each asserted BOTH WAYS: what rung 3
    builds with the guards off, and what THE LADDER does with them on.

    THE GATE IS `_offset_faces`, NOT `_retune_radially_report`, and that
    substitution is exactly how four stages of verification missed the defect
    this test now pins: every screen's sentence used to be swallowed by
    `_retune_radially`, so `_screen_verdict` named the collision while the
    shipped ladder built BRepOffset's wrong answer on the same fixture. The
    reason check stays — it is the only place the sentence is readable — but the
    pass/fail gate is the function the feature handler calls.

    A one-sided refusal test is worthless — a screen that refuses everything
    passes it — and `test_retune_screens` can only argue the guards-off half in
    prose, because the hatch is read once at import and an in-process test
    cannot flip it. These two fixtures are files, so a child process can.

      offset_cbore_break.brep — a 3.0 mm bore with a 0.3 chamfer under a 3.5 mm
      counterbore. Growing the bore walks the chamfer's top edge out to 3.55,
      through the counterbore wall at 3.50. A REFUSAL: the overrun is a fact
      about the solid, not about which rung builds it.

      offset_taper_lip.brep — a 3.0 mm bore whose neighbour is an 8 degree, 22 mm
      FUNCTIONAL taper. Radially it looks exactly like a chamfer (coaxial, full
      360, meeting the wall at exactly r), and every candidate retune design
      moved its far end with the wall. NOT a refusal: measured, rung 4 does the
      right thing here — it holds the semi-angle at 7.9952 deg AND the far end
      at 6.09 mm and lengthens the cone instead — so graft 2 is an eligibility
      screen for rung 3's method and the ladder is expected to answer, well,
      through rung 4. See `_RetuneRefuse`."""
    # --- the undercut -------------------------------------------------------
    cb = _fixture_shape("offset_cbore_break.brep")
    assert abs(cb.volume - 10912.796114) < 1e-5 and len(cb.faces()) == 10, (
        f"the counterbore fixture changed: {cb.volume:.6f}, {len(cb.faces())} faces")
    assert _cone_lips(cb) == [(45.0, 0.3, 0.3, 3.0, 3.3)], _cone_lips(cb)
    face = _bore_face(cb, 3.0)

    # NARROW: the same bore, the same direction, 0.15 is fine. The screen is
    # about where the chamfer LANDS, not about bores-with-chamfers.
    ok = builder._offset_faces(cb, [(face, -0.15)])
    assert ok.is_valid, "the ladder refused a counterbore with 0.05 mm to spare"
    assert _cone_lips(ok) == [(45.0, 0.3, 0.3, 3.15, 3.45)], _cone_lips(ok)

    # ...and 0.25 is not. Guards off first, so the refusal has something to be
    # a refusal OF.
    wrong = _guards_off("offset_cbore_break.brep", 3.0, -0.25)
    assert wrong["cones"] == [[45.0, 0.3, 0.3, 3.25, 3.55]], (
        f"guards off, the chamfer should reach 3.55 past a wall at 3.50: {wrong['cones']}")
    assert not wrong["valid"], (
        "guards off this shape came back VALID, so BRepCheck is not the backstop "
        "the screens were sized against")
    assert wrong["err"] < 1e-9, (
        f"the analytic volume oracle AGREES with the broken shape to {wrong['err']:.1e} "
        "— that is why a volume check cannot be the thing that catches this")
    try:
        got = builder._offset_faces(cb, [(_bore_face(cb, 3.0), -0.25)])
        raise AssertionError(
            "THE LADDER BUILT THE UNDERCUT. Rung 3 names this collision and the "
            "ladder used to throw the sentence away and let BRepOffset answer, "
            f"which silently resized the 0.30 mm chamfer to 0.05: {_cone_lips(got)}")
    except ValueError as e:
        assert "3.5500" in str(e) and "3.5000" in str(e), (
            f"the refusal must NAME the collision, not just decline: {e}")
    # and the body is untouched, which is the other half of "left alone"
    assert abs(cb.volume - 10912.796114) < 1e-5, "the refused offset mutated the input"

    # --- the functional taper -----------------------------------------------
    tp = _fixture_shape("offset_taper_lip.brep")
    assert abs(tp.volume - 33916.761837) < 1e-5 and len(tp.faces()) == 5, (
        f"the taper fixture changed: {tp.volume:.6f}, {len(tp.faces())} faces")
    assert _cone_lips(tp) == [(7.995152, 3.09, 22.0, 3.0, 6.09)], _cone_lips(tp)

    wrong = _guards_off("offset_taper_lip.brep", 3.0, -0.25)
    assert wrong["cones"] == [[7.995152, 3.09, 22.0, 3.25, 6.34]], (
        f"guards off, the taper's far end should move with the wall: {wrong['cones']}")
    assert wrong["valid"], (
        "this one comes back VALID — a 0.25 mm radial shift of a 22 mm taper is "
        "watertight, self-consistent and completely wrong, which is why the band "
        "screen exists rather than another validity check")
    for d in (-0.25, 0.25):
        verdict = _screen_verdict(tp, 3.0, d)
        assert verdict != "ok", f"the functional taper was accepted by rung 3 at d={d}"
        assert "taper" in verdict, f"the refusal does not name what it saw: {verdict!r}"
        # ...and the LADDER answers it anyway, through rung 4, with the taper's
        # two functional numbers intact. This is the measurement that says graft
        # 2 must stay a decline and not become a refusal.
        out = builder._offset_faces(tp, [(_bore_face(tp, 3.0), d)])
        semi, _dr, _ax, r_small, r_big = _cone_lips(out)[0]
        assert semi == 7.995152 and r_big == 6.09, (
            f"rung 4 moved the taper's angle or its far end at d={d}: {_cone_lips(out)}")
        assert abs(r_small - (3.0 - d)) < 1e-9, (
            f"rung 4 did not move the wall to {3.0 - d}: {_cone_lips(out)}")

    # NARROW, the other half: the same screen, on a real 0.3 mm chamfer of the
    # same 45 degree family, accepts. The bushing is the control.
    bushing = _fixture_shape("offset_chamfer_bore.brep")
    assert _screen_verdict(bushing, 1.3, 0.15) == "ok", (
        "the band screen refused a genuine 0.3 mm chamfer — it is reading "
        "'has a cone neighbour' rather than the ring's shape")

    print("  offset refusals OK: the ladder refuses the undercut by name "
          "(3.5500 vs 3.5000, invalid with the guards off) and leaves the body "
          "alone; the 8deg taper is named by rung 3 and answered by rung 4 with "
          "its angle and far end intact; a real chamfer still accepted")


def test_offset_probe_survives_a_segfault():
    """A LIVE SIGSEGV, and the session is still there afterwards.

    Offsetting both of the bushing's cylinders in one pass is a first-class user
    action — `_handle_offset_face` resolves a list of selectors — and it is
    rung 4's, by structure: rungs 2 and 3 are single-face, and this function's
    contract is that every face is registered before ONE MakeOffsetShape() pass
    so adjacent offsets close against each other. Looping the cheap rungs per
    face would break that quietly. So multi-face goes to BRepOffset...

    ...and on this file BRepOffset dies. Not raises — dies. That is the whole
    reason `_probe_offsets` forks: an in-worker deadline cannot catch it (OCCT
    holds the GIL, and the taper path measured a SIGALRM armed for 1.0 s arriving
    at 10.39 s), and geometry runs in a max_workers=1 pool, so one crash costs
    the session rather than the feature.

    Both halves run in children of this process, so a regression is a failed
    assertion here and not a dead test run. The control half is deliberately
    fragile in one direction: if BRepOffset ever STOPS coring on this fixture,
    this test fails and says so, because at that point the fork is being paid
    for nothing and somebody should decide whether to keep it."""
    import subprocess

    here = os.path.dirname(os.path.abspath(builder.__file__))
    d = tempfile.mkdtemp()

    def child(call, name):
        path = os.path.join(d, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(
                "import sys\n"
                f"sys.path.insert(0, {here!r})\n"
                "import builder, test_smoke as T\n"
                "s = T._fixture_shape('offset_chamfer_bore.brep')\n"
                "pairs = [(T._bore_face(s, 2.0), 0.15), (T._bore_face(s, 1.3), 0.15)]\n"
                "seen = []\n"
                "r2, r3 = builder._offset_cylinder_by_boolean, builder._retune_radially\n"
                "builder._offset_cylinder_by_boolean = lambda p, f, x: seen.append('rung2') or r2(p, f, x)\n"
                "builder._retune_radially = lambda p, f, x: seen.append('rung3') or r3(p, f, x)\n"
                "try:\n"
                f"    out = {call}\n"
                "    print('BUILT %.6f' % out.volume)\n"
                "except ValueError as e:\n"
                "    print('MSG %s' % e)\n"
                "print('RUNGS %s' % seen)\n"
                "print('ALIVE')\n")
        # ENCODING PINNED, BOTH DIRECTIONS, and this is not defensive padding.
        # The refusal read for below contains an em-dash; `text=True` decodes the
        # child with whatever `locale.getencoding()` says at that moment; and
        # OCCT'S STEP READER FLIPS THE PROCESS LOCALE TO C AND DOES NOT PUT IT
        # BACK. Watched live: UTF-8 for the whole of builder's import, then
        # ANSI_X3.4-1968 from the STEP round trip in `test_import_roundtrip`
        # onwards, with no setlocale anywhere in this repo. So this test passed
        # run on its own and died with a UnicodeDecodeError in the full suite —
        # a failure caused by test ORDER, in a test about crashes. The child
        # gets PYTHONIOENCODING for the same reason on the way out: an ASCII
        # stdout would make it fail to PRINT the sentence, which reads exactly
        # like the crash this test exists to rule out.
        return subprocess.run([sys.executable, path], capture_output=True,
                              encoding="utf-8", errors="replace", timeout=300,
                              env=dict(os.environ, PYTHONIOENCODING="utf-8"))

    # 1. the control: the kernel call the ladder is standing in front of.
    raw = child("builder._brep_offset_pass(s, pairs)", "raw.py")
    assert raw.returncode != 0 and "ALIVE" not in raw.stdout, (
        f"BRepOffset returned {raw.returncode} on offset_chamfer_bore.brep instead "
        f"of dying. The probe costs a fork on every curved offset and it is "
        f"justified by this crash; if the crash is gone, so is the justification. "
        f"stdout: {raw.stdout[-200:]!r}")

    # 2. the ladder, same body, same two faces: a sentence, and a live process.
    led = child("builder._offset_faces(s, pairs)", "ladder.py")
    assert led.returncode == 0, (
        f"the ladder took the process down with it (exit {led.returncode}) — the "
        f"probe did not fail closed. stderr tail: {led.stderr[-400:]}")
    assert "ALIVE" in led.stdout, f"the child stopped early: {led.stdout[-300:]!r}"
    assert "MSG " in led.stdout and "sandbox" in led.stdout, (
        f"want the sandbox refusal, got {led.stdout[-400:]!r}")
    assert "never run on your model" in led.stdout, (
        "the refusal no longer says the model was left alone, which is the one "
        f"thing the user needs to know after a crash: {led.stdout[-400:]!r}")
    assert "RUNGS []" in led.stdout, (
        f"a multi-face offset consulted the single-face rungs: {led.stdout[-300:]!r}. "
        "Answering one face at a time breaks the one-pass contract silently, which "
        "is worse than the refusal it would be replacing")

    print(f"  offset probe OK: raw BRepOffset exit {raw.returncode} on the imported "
          f"bushing, the ladder refuses in words and the process is still alive")


def test_offset_rules_are_pinned():
    """The assumptions the ladder rests on, asserted as rules rather than as
    outcomes, in the register `test_unify_never_costs_a_valid_solid` uses.

    An outcome test tells you a body came out right today. These four tell you
    WHY it will tomorrow, and each one is load-bearing for a different rung."""
    from build123d import Box, Cylinder, GeomType as _GT, Pos
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopoDS import TopoDS

    bushing = _fixture_shape("offset_chamfer_bore.brep")
    bore = _bore_face(bushing, 1.3)

    # --- 1. faces() order survives a BREP round trip -------------------------
    # The probe names its target by INDEX into part.faces(), because a
    # nearest-centre re-match in the child would be free to pick a DIFFERENT
    # face and the probe would then be clearing an operation the worker is not
    # about to run. test_import_roundtrip pins the EDGE version of this; the
    # face version is what `_probe_offsets` actually depends on.
    back = builder._brep_b64_to_shape(builder._shape_to_brep_b64(bushing))
    before = [(round(f.area, 9), str(f.geom_type)) for f in bushing.faces()]
    after = [(round(f.area, 9), str(f.geom_type)) for f in back.faces()]
    assert before == after, (
        f"a BREP round trip reordered the faces, so the probe would be testing "
        f"the wrong face:\n  {before}\n  {after}")

    # --- 2. the pcurve-invariance claim --------------------------------------
    # Rung 3's entire argument is that bumping one radial constant leaves the
    # parametric domain untouched, so every pcurve stays valid verbatim. If that
    # is false the result has faces whose boundaries are not on them, and every
    # check downstream waves it through because the topology is byte-identical.
    # Asserted on the IMPORTED body specifically: test_retune_radially pins it
    # on a primitive build, and provenance is exactly what differs here.
    retuned = builder._retune_radially(bushing, bore, 0.15)
    assert retuned is not None, "rung 3 declined the bushing"
    pairs = 0
    for f in retuned.faces():
        for e in builder._retune_explore(f.wrapped, TopAbs_EDGE):
            pc = BRep_Tool.CurveOnSurface_s(TopoDS.Edge_s(e), f.wrapped, 0.0, 0.0)
            assert pc is not None, (
                "a retuned face lost the pcurve of one of its own edges")
            pairs += 1
    assert pairs == 24, f"the bushing has 24 (edge, face) pairs, walked {pairs}"

    # --- 3. the closed-form dV, four ways ------------------------------------
    # `_retune_face_dvolume` is the rung's OWN oracle (ORACLE 3 compares the
    # measured change to it), so a sign or a term wrong in it buys an oracle that
    # cheerfully accepts a body off by one face's contribution. It is checked
    # here PER FACE against a numerical integration of the same surface, and
    # summed against the independent closed form for the whole solid and against
    # what the kernel measured. Calling it directly is not decoration: a version
    # of this section that compared only numeric/closed/kernel passed a 1%
    # falsified `_retune_face_dvolume` with the guards off, because none of those
    # three readings goes anywhere near it.
    #
    # delta is -d on a bore: +d runs along the outward normal, which points into
    # the hole.
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    pos = BRepAdaptor_Surface(bore.wrapped).Cylinder().Position()
    o = (pos.Location().X(), pos.Location().Y(), pos.Location().Z())
    ax = (pos.Direction().X(), pos.Direction().Y(), pos.Direction().Z())
    chain = [bore] + [f for f in bushing.faces() if f.geom_type == _GT.CONE]
    assert len(chain) == 3, f"the bushing's chain is wall + two chamfers, got {len(chain)}"
    analytic, numeric = [], []
    for f in chain:
        analytic.append(builder._retune_face_dvolume(f.wrapped, o, ax, -0.15))
        numeric.append(_profile_dvolume_numeric(f.wrapped, o, ax, -0.15))
        assert abs(abs(analytic[-1]) - numeric[-1]) < 1e-9, (
            f"the closed form and the integral disagree on one face: "
            f"{analytic[-1]:.12f} vs {numeric[-1]:.12f}")
    assert abs(abs(analytic[0]) - 3.925420020660) < 1e-9, (
        f"the wall alone should move {3.925420020660:.9f} mm3, closed form says "
        f"{abs(analytic[0]):.9f} — the two chamfers carry the rest")
    closed = _chamfer_bore_volume(1.15) - _chamfer_bore_volume(1.3)
    measured = retuned.volume - bushing.volume
    assert abs(sum(analytic) - closed) < 1e-9 and abs(sum(numeric) - closed) < 1e-9 \
        and abs(measured - closed) < 1e-9, (
        f"four readings of the same dV disagree: per-face closed form "
        f"{sum(analytic):.12f}, numerical {sum(numeric):.12f}, whole-solid closed "
        f"form {closed:.12f}, kernel {measured:.12f}")

    # --- 4. the probe fails CLOSED -------------------------------------------
    # The single easiest thing in this file to get backwards, and it INVERTS the
    # convention next door: `_probe_blend` fails OPEN, because a fillet that
    # fails fast has a better message from OCCT than a guard could write.
    # Offsets are the SIGSEGV class and a SIGSEGV reports nothing, so here
    # silence has to mean no.
    src = inspect.getsource(builder._probe_offsets)
    assert src.index('verdict = "unsafe"') < src.index('verdict = "pass"'), (
        "the verdict no longer starts at 'unsafe' — an unreported child would "
        "inherit whatever the last line left behind")
    assert 'return "pass"' not in src, (
        "a clearance now bypasses the verdict machinery, so a path that never "
        "heard from the child could return one")
    assert src.count('return "unsafe"') >= 3, (
        "the early-exit paths (serialisation, naming a face, spawning) no longer "
        "all refuse; an offset that cannot be probed must not be run")
    # and behaviourally: a face that cannot be named in this body is a refusal,
    # not a shrug.
    plate = Box(20, 20, 10) - Cylinder(4, 12)
    foreign = _bore_face(plate, 4.0)
    assert builder._probe_offsets(bushing, [(foreign, 0.15)]) == "unsafe", (
        "a face the probe cannot name in the body it was handed came back as "
        "anything other than unsafe")

    # --- 5. the guards are NARROW --------------------------------------------
    # `test_blend_hang_guard`'s discipline: the ordinary case must be untouched.
    # A plain bore and a plain boss are rung 2's, they are exact, and they must
    # not start paying a ~0.5 s fork per rebuild — that is field report a0a76571,
    # where the viewport lagged so far behind the number that typing looked like
    # it did nothing. Asserted by making a fork an error.
    boss = Box(20, 20, 10) + Pos(0, 0, 11) * Cylinder(4, 12)
    real = builder._probe_offsets
    try:
        def _no_fork(part, prs):
            raise AssertionError("a plain cylinder offset forked a probe")

        builder._probe_offsets = _no_fork
        got = builder._offset_faces(plate, [(_bore_face(plate, 4.0), 1.0)])
        assert _cyl_radii(got) == [3.0] and abs(got.volume - (4000 - math.pi * 9 * 10)) < 1e-6, (
            f"plain bore: radii {_cyl_radii(got)}, volume {got.volume:.4f}")
        got = builder._offset_faces(boss, [(_bore_face(boss, 4.0), 1.0)])
        assert _cyl_radii(got) == [5.0] and abs(got.volume - (4000 + math.pi * 25 * 12)) < 1e-6, (
            f"plain boss: radii {_cyl_radii(got)}, volume {got.volume:.4f}")
    finally:
        builder._probe_offsets = real
    # a planar face on a small body must not even be a candidate for a fork
    assert not builder._offset_needs_probing(
        plate, [(plate.faces().sort_by()[0], 1.0)]), (
        "an ordinary planar offset is now probed, which is what kept the fillet "
        "probe from adding 27 minutes to this test leg")

    print(f"  offset rules OK: face order survives BREP, {pairs} pcurves intact, "
          f"dV agrees four ways ({closed:.9f}), probe defaults to unsafe, plain "
          f"bore/boss still fork-free")


def test_offset_ladder_refuses_through_the_front_door():
    """Everything the ladder must refuse, asserted on `_offset_faces` itself.

    THE ONE TEST THAT WOULD HAVE CAUGHT THE ASSEMBLY DEFECT. Rung 3's screens
    were verified for three stages through `_retune_radially_report`, which is
    rung 3 in isolation, while `_offset_faces` — the function
    `_handle_offset_face` and `_press_pull` actually call — discarded every one
    of their sentences and let BRepOffset answer instead. Each section below is
    a pair: the distance that must build, and the one that must refuse in words.

    Five distinct mechanisms, all measured on this machine before they were
    written down:

      1. GRAFT 1 escaping rung 3 (`_RetuneRefuse`). Reference-import bodies 1745
         and 1761 came back from the old ladder INVALID, 66 faces down to 52 and
         split into two solids with both fillets deleted, after rung 3 had said
         in words "the lip would reach 1.4500 mm from the axis but the face
         beyond it starts at 1.5000 mm".
      2. GRAFTS 6 and 7 escaping rung 3, on a dowel that STICKS OUT of its bore
         — the normal arrangement in a STEP import, and the one graft 7's own
         fixture could not reach because it sat wholly inside the bore's axial
         window.
      3. `_offset_result_reason`: rung 4 had no gate on its own output. On the
         census it returned six invalid bodies and one 89-face body reduced to
         two faces, all stored as successful features.
      4. `_offset_moved_far_away`: a partial-360 cylinder — 222 of the 627
         cylindrical faces in the brief's census — takes rung 4 by construction,
         and rung 4 offsets the whole tangent chain.
      5. The refused body is LEFT ALONE. A refusal that mutated the input would
         be the same defect wearing a message."""
    import math

    from build123d import Box, Compound, Cylinder, GeomType as _GT, Pos

    # --- 1. a lip that overruns the flat beyond it --------------------------
    cb = _fixture_shape("offset_cbore_break.brep")
    ok = builder._offset_faces(cb, [(_bore_face(cb, 3.0), -0.15)])
    assert ok.is_valid and _cone_lips(ok) == [(45.0, 0.3, 0.3, 3.15, 3.45)], (
        f"the ladder refused a counterbore with 0.05 mm to spare: {_cone_lips(ok)}")
    v0, n0 = cb.volume, len(cb.faces())
    try:
        builder._offset_faces(cb, [(_bore_face(cb, 3.0), -0.25)])
        raise AssertionError("the ladder built the undercut")
    except ValueError as e:
        assert "3.5500" in str(e) and "3.5000" in str(e), f"unnamed: {e}"
    assert cb.volume == v0 and len(cb.faces()) == n0, "the refusal mutated the input"

    # --- 2. a dowel standing in the bore, flush AND proud --------------------
    # Same geometry twice; the only difference is whether the pin protrudes. The
    # proud one used to be ACCEPTED with 31.415927 mm3 of solid-solid overlap,
    # err 5.0e-13 and valid True, because `buried` demanded axial containment
    # and BRepExtrema measures surface-to-surface: two coaxial cylinders 0.2 mm
    # apart read 0.2 mm of clearance while the solids they bound interpenetrate.
    plate = Box(30, 30, 10) - Cylinder(3.0, 10)
    for stick, must in ((5.0, "refuse"), (7.0, "refuse")):
        body = Compound([plate, Cylinder(2.6, 2 * stick)])
        try:
            builder._offset_faces(body, [(_bore_face(body, 3.0), 0.60)])
            raise AssertionError(
                f"the ladder grew a 3.0 mm bore 0.60 mm into a 2.6 mm pin "
                f"(pin half-height {stick}) — {must} was required")
        except ValueError as e:
            assert ("standing inside the ring" in str(e)
                    or "runs into other geometry" in str(e)), f"unnamed: {e}"
    # ...and the same bore, away from the pin, still builds.
    body = Compound([plate, Cylinder(2.6, 14.0)])
    out = builder._offset_faces(body, [(_bore_face(body, 3.0), -0.15)])
    assert out.is_valid and 3.15 in _cyl_radii(out), (
        f"the clearance screen refused a bore growing AWAY from the pin: "
        f"{_cyl_radii(out)}")

    # --- 3 and 4. a partial-360 cylinder: one slot wall ---------------------
    # A plain build123d slot, no import involved. Picking ONE half-bore and
    # offsetting it returned a valid solid with the SAME face count in which the
    # other half-bore and both slot walls had also moved: dV +57.567476 against
    # a one-face ideal of +13.783738, 4.18x wrong, at every distance from 0.001
    # to 1.0 and both signs.
    slot = (Box(30, 20, 10) - Pos(5, 0, 0) * Cylinder(3, 10)
            - Pos(-5, 0, 0) * Cylinder(3, 10) - Box(10, 6, 10))
    half = min((f for f in slot.faces() if f.geom_type == _GT.CYLINDER),
               key=lambda f: f.area)
    assert builder._retune_radially(slot, half, 0.15) is None, (
        "a 180 degree cylinder is not rung 3's — the u-span screen is gone")
    v0 = slot.volume
    try:
        got = builder._offset_faces(slot, [(half, 0.15)])
        raise AssertionError(
            f"the ladder offset a whole slot from one picked wall: "
            f"dV {got.volume - v0:+.6f} against a one-face ideal of "
            f"{math.pi * (9 - 2.85 ** 2) * 10 / 2:+.6f}")
    except ValueError as e:
        assert "other surface" in str(e), f"unnamed: {e}"
    assert slot.volume == v0, "the refusal mutated the input"

    # --- 5. the gate is not blanket: the honest rung-4 case still builds -----
    # A 90 degree corner notch. It is a PARTIAL cylinder, so rungs 2 and 3 both
    # decline it by construction and it is rung 4's — the same class as the slot
    # wall above, and the reason the screen has to be "what moved", not "is it a
    # full 360". Here rung 4 moves exactly that one surface and the gate lets it
    # through; on the slot it moves three more and the gate does not.
    notch = Box(20, 20, 10) - Pos(10, 10, 0) * Cylinder(4, 10)
    face = _bore_face(notch, 4.0)
    assert builder._offset_cylinder_by_boolean(notch, face, 0.15) is None, \
        "a 90 degree notch is not rung 2's"
    assert builder._retune_radially(notch, face, 0.15) is None, \
        "a 90 degree notch is not rung 3's"
    before = sorted(f.area for f in notch.faces() if f.geom_type == _GT.PLANE)
    got = builder._offset_faces(notch, [(face, 0.15)])
    assert got.is_valid and _cyl_radii(got) == [3.85], (
        f"the rung-4 gate refused a clean single-face offset: {_cyl_radii(got)}")
    assert len(sorted(f.area for f in got.faces()
                      if f.geom_type == _GT.PLANE)) == len(before), (
        "rung 4 changed the plane count on a case the gate accepted")

    print("  offset front door OK: the undercut, a proud dowel and a slot wall "
          "are all refused BY `_offset_faces` in words with the body untouched, "
          "and a clean partial-cylinder rung-4 offset still builds")


def test_offset_gate_and_probe_child_fail_closed():
    """The two halves of the ladder that no shape can be built to exercise.

    Both were found by mutation-testing the test above: disabling rung 4's
    VALIDITY gate, and making the probe child report a setup failure as an
    honest kernel refusal, each left every other offset test green.

    They are unreachable from geometry for opposite reasons. The validity gate
    only fires on imported bodies where BRepOffset returns a torn solid — four
    of the 183 census attempts, none of them reproducible from primitives — so
    it is driven with a shape that IS invalid instead. The child's polarity bug
    needs a recipe the child cannot deserialise, which is a protocol input, not
    a shape. So these are asserted directly rather than through a fixture, and
    that is the honest form: a fixture that happened to trip them would be
    asserting this OCCT build."""
    import json
    import subprocess

    from build123d import Box
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.TopoDS import TopoDS_Shell

    # --- 1. rung 4's result gate refuses a torn solid ------------------------
    box = Box(20, 20, 10)
    faces = box.faces()
    bld = BRep_Builder()
    shell = TopoDS_Shell()
    bld.MakeShell(shell)
    for f in faces[:-1]:            # five of six: an open shell
        bld.Add(shell, f.wrapped)
    torn = builder._wrap_topods(BRepBuilderAPI_MakeSolid(shell).Solid())
    assert not BRepCheck_Analyzer(torn.wrapped).IsValid(), \
        "the torn fixture is valid, so it proves nothing"
    assert len(torn.solids()) == len(box.solids()), (
        "the torn fixture also changes the solid count, so this would pass on "
        "the wrong gate")
    reason = builder._offset_result_reason(box, torn, [(faces[0], 0.15)])
    assert reason and "broken solid" in reason, (
        f"rung 4's validity gate let a torn solid through: {reason!r}")
    # and the gate is not a blanket no: the untouched body passes its own gate
    assert builder._offset_result_reason(box, box, [(faces[0], 0.15)]) is None, (
        "the gate refuses a result identical to its input")

    # --- 2. the probe CHILD must not call a setup failure a kernel refusal ---
    # "raise" is the one verdict that tells the parent to run the unprobed call
    # on the real body. A child that could not even resolve the face has learned
    # nothing and must report the silence-equivalent.
    recipe = json.dumps({"brep": builder._shape_to_brep_b64(box),
                         "pairs": [[9999, 0.15]]})
    p = subprocess.run(
        [sys.executable, "-c", "import builder; builder._offset_probe_main()"],
        input=recipe, capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        cwd=os.path.dirname(os.path.abspath(builder.__file__)), timeout=300)
    done = [json.loads(l) for l in p.stdout.splitlines()
            if l.startswith("{") and '"done"' in l]
    assert done, f"the child reported nothing at all: {p.stdout!r} {p.stderr[-400:]}"
    assert done[-1]["ok"] is False and done[-1]["raised"] is False, (
        f"a face the child could not resolve was reported as an honest kernel "
        f"refusal, which is the parent's permission to run it for real: {done[-1]}")
    # ...and the parent reads that as unsafe, which is a refusal.
    verdict = "pass" if done[-1]["ok"] else ("raise" if done[-1]["raised"] else "unsafe")
    assert verdict == "unsafe", verdict

    print("  offset gate OK: rung 4 refuses a torn solid and accepts an "
          "untouched one, and a probe child that cannot resolve a face reports "
          "silence rather than a kernel refusal")


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
    test_export_project_3mf_paints_whole_body_off_slot_zero()
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
    test_replane_rebuilds_a_dirty_mesh()
    test_replane_declines_a_faceted_curve()
    test_replane_survives_a_region_it_cannot_rebuild()
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
    test_offset_ladder()
    test_retune_radially()
    test_retune_screens()
    test_offset_imported_bore_keeps_its_lip()
    test_offset_refuses_an_undercut_and_a_taper()
    test_offset_probe_survives_a_segfault()
    test_offset_rules_are_pinned()
    test_offset_ladder_refuses_through_the_front_door()
    test_offset_gate_and_probe_child_fail_closed()
    test_face_selector_on_concentric_cylinders()
    test_simplify_mesh()
    test_sweep()
    test_sweep_along_body_edge()
    test_sweep_edge_path_reports_disconnected_edges()
    test_sweep_along_non_planar_edge_chain()
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
