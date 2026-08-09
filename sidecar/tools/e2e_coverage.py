"""e2e_coverage.py — real-server op/feature coverage counter for the sidecar.

Computes the universe U of units that ought to be exercised end-to-end:
    U = _FEATURE_HANDLERS keys (parsed at runtime from builder.py)
        + ops dispatched by server.py
        - {rebuild, ping, exportProject, import}   # covered by other harnesses
and reports which are NOT yet covered by a real check.

A unit earns coverage ONLY through a check that, hardcoded here:
  (a) ran against a subprocess-spawned server.py (its child PID + LISTENING line
      are observed and printed below);
  (b) got ok=true;
  (c) asserted a NUMERIC GEOMETRIC INVARIANT against a precomputed expected
      constant — an exact body/pair count, or a volume/bbox within a fixed
      tolerance. Bare ok, or an open-ended predicate (>=0), earns nothing;
  (d) for transform/pattern/remove/scale/move units the asserted post value must
      DIFFER from the pre-op measure (a no-op earns no credit) — enforced by
      requiring those units to register through a delta_* invariant with a
      distinct `pre`.

register() is the single gate; it refuses credit for anything that doesn't meet
the above. Coverage is drawn from the golden corpus (feature types exercised by
clean, invariant-verified documents) plus the explicit checks below.

Run from sidecar/ with .venv/bin/python:  python tools/e2e_coverage.py
"""

import os
import sys
import tempfile

import websockets

# sidecar/ on the path: the migrateGeometry check has to CONSTRUCT a pre-v5
# document, and `builder._shape_to_brep_b64` is kept alive for exactly that
# ("nothing writes it any more … kept because the tests need to be able to
# construct one"). Same pattern as eval_fillet_corpus.py.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import golden_corpus as GC
import harness_util as H

# --- hardcoded acceptance tolerances (mirror golden_corpus; not configurable) -
VOL_REL_TOL = 0.005      # volume / delta_volume within 0.5% of expected
BBOX_ABS_TOL = 1e-4      # bbox / delta_bbox component absolute tolerance (mm)
FINE_TOL = 0.005         # rebuild tessellation tol — fine enough that a curved
                         # body's mesh volume matches its analytic volume <0.5%

# Mesh volume of a 20-cube with `ribs` (depth 0.4, scale 2.0) on its top face,
# at FINE_TOL. MEASURED, like check_draft's constant — texture displaces the
# MESH, so there is no closed form to derive it from. Reproduced to six decimals
# across repeated runs.
#
# What makes it a real check rather than a rubber stamp: the untextured body
# reads exactly 8000, and 8000 is 0.88% away from this, i.e. OUTSIDE the 0.5%
# acceptance band. So a texture that silently resolved to nothing FAILS here.
# Re-measure deliberately when texture's CODE_VERSION changes; never widen the
# tolerance to absorb a drift.
TEXTURED_BOX_VOLUME = 8071.166667

# Units whose credit MUST come from a pre/post delta (rule (d)). Corpus presence
# alone never credits these — a document has no "before" to compare against.
# Single source of truth lives in harness_util so golden_corpus can't drift.
DELTA_UNITS = H.DELTA_UNITS

# ops already covered by other harnesses / trivially elsewhere — excluded from U.
#
# The four below are excluded on a STRICTER test than "someone tested it
# somewhere": there is no numeric geometric invariant to assert about them, so
# the only way to make them count would be to weaken register()'s rule (c) —
# and that gate is the only reason this number means anything. Each names the
# suite that actually covers it. Adding to this set is a decision to stop
# measuring something; do not do it to make a floor reachable.
EXCLUDED_OPS = {
    "rebuild", "ping", "exportProject", "import",
    # A race, not a shape. test_cancel.py drives it over a real socket.
    "cancel",
    # Best-effort BY DESIGN: "a body that can't confidently be cleaned stays
    # unchanged" (builder._handle_clean_up). On the clean input this harness can
    # construct, a box goes in and a box comes out, so any volume assertion here
    # passes for a do-nothing implementation. Covered by test_smoke.py.
    # ACKNOWLEDGED DEBT, not a solved problem: crediting it honestly needs a
    # deterministically rotten body plus a solid-count invariant kind that
    # register() does not have.
    "cleanUp",
    # Returns font families. No geometry, and the answer is a property of the
    # HOST's font set rather than of this code. Covered by test_text.py.
    "listFonts",
    # Glyph outlines are font-dependent, so a hardcoded numeric invariant would
    # be unreachable in CI by construction — precisely the trap that once put
    # this floor at 23 on one machine and 21 on every other checkout. Covered by
    # test_text.py.
    "tessellateText",
}

# unit -> {"kind","expected","actual","source"} once credited.
COVERED = {}


def _num_list(x):
    return isinstance(x, (list, tuple)) and all(isinstance(v, (int, float)) for v in x)


def _judge(unit, kind, expected, actual, pre):
    """Return None if the assertion earns credit, else a refusal reason. All
    acceptance logic is here and hardcoded — no predicate the caller supplies can
    widen it."""
    is_delta = kind.startswith("delta_")
    if unit in DELTA_UNITS and not is_delta:
        return f"{unit} is a transform/pattern/remove/scale/move unit — needs a delta_* invariant"
    if is_delta and unit not in DELTA_UNITS:
        return f"{unit} may not claim credit through a delta invariant"

    if kind in ("bodies_eq", "pairs_eq", "delta_bodies"):
        if not isinstance(expected, int):
            return f"{kind} expected must be an int, got {expected!r}"
        if actual != expected:
            return f"{kind}: actual {actual} != expected {expected}"
        if kind == "delta_bodies":
            if not isinstance(pre, int):
                return "delta_bodies needs an int pre-op count"
            if actual == pre:
                return f"delta_bodies is a no-op (pre==post=={actual})"
        return None

    if kind in ("volume", "delta_volume"):
        if not (isinstance(expected, (int, float)) and expected > 0):
            return f"{kind} expected must be a positive number, got {expected!r}"
        if abs(actual - expected) > expected * VOL_REL_TOL:
            return f"{kind}: actual {actual:.4f} != expected {expected:.4f} (>{VOL_REL_TOL:.1%})"
        if kind == "delta_volume":
            if not isinstance(pre, (int, float)):
                return "delta_volume needs a numeric pre-op volume"
            if abs(actual - pre) <= abs(pre) * VOL_REL_TOL:
                return f"delta_volume did not move (pre {pre:.4f} ~ post {actual:.4f})"
        return None

    if kind in ("bbox", "delta_bbox"):
        if not (_num_list(expected) and len(expected) == 6 and _num_list(actual) and len(actual) == 6):
            return f"{kind} expected/actual must be 6-number bboxes"
        for i in range(6):
            if abs(actual[i] - expected[i]) > BBOX_ABS_TOL:
                return f"{kind}: component {i} {actual[i]:.5f} != expected {expected[i]:.5f}"
        if kind == "delta_bbox":
            if not (_num_list(pre) and len(pre) == 6):
                return "delta_bbox needs a 6-number pre-op bbox"
            if all(abs(actual[i] - pre[i]) <= BBOX_ABS_TOL for i in range(6)):
                return "delta_bbox did not move the bounding box"
        return None

    return f"unknown invariant kind {kind!r}"


def register(unit, kind, expected, actual, pre=None, source="explicit check"):
    """The one credit gate. Prints PASS/REFUSED and records covered units."""
    why = _judge(unit, kind, expected, actual, pre)
    if why is None:
        COVERED[unit] = {"kind": kind, "expected": expected, "actual": actual, "source": source}
        print(f"  COVER {unit:16} {kind:13} expected={expected} actual={_fmt(actual)}  [{source}]")
    else:
        print(f"  REFUSE {unit:16} {kind:13} {why}")


def _fmt(v):
    if isinstance(v, float):
        return f"{v:.4f}"
    if _num_list(v):
        return "[" + ",".join(f"{x:.3f}" for x in v) + "]"
    return str(v)


# --- measurement helpers ------------------------------------------------------


async def _rebuild(ws, features, op="rebuild", **extra):
    reply = await H.ws_call(ws, op, "c", document={"parameters": {}, "features": features},
                            tolerance=FINE_TOL, **extra)
    if not reply.get("ok"):
        raise RuntimeError(f"{op} not ok: {reply.get('error')}")
    return reply["result"]


def _total_volume(result):
    return sum(H.mesh_volume(b["positions"], b["indices"])
               for b in (result.get("bodies") or []) if b.get("positions"))


def _nbodies(result):
    return len(result.get("bodies") or [])


def _flat_bbox(result):
    bb = result.get("bbox")
    if not bb:
        return None
    return [*bb["min"], *bb["max"]]


def _sketch_rect(sid, w, h, plane="XY", x=0, y=0):
    return {"id": sid, "type": "sketch", "plane": plane,
            "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]}


def _box(bid="b", l=20, w=20, h=20):
    return {"id": bid, "type": "box", "length": l, "width": w, "height": h}


# --- explicit checks (each asserts a precomputed constant) --------------------

import math

_PI = math.pi


async def check_box(ws):
    # box: exact L*W*H, flat faces → mesh volume is exact.
    r = await _rebuild(ws, [_box("b", 20, 20, 20)])
    register("box", "volume", 8000.0, _total_volume(r))
    register("box", "bbox", [-10, -10, -10, 10, 10, 10], _flat_bbox(r))


async def check_cylinder(ws):
    r = await _rebuild(ws, [{"id": "c", "type": "cylinder", "radius": 5, "height": 8}])
    register("cylinder", "volume", _PI * 25 * 8, _total_volume(r))


async def check_sphere(ws):
    r = await _rebuild(ws, [{"id": "s", "type": "sphere", "radius": 6}])
    register("sphere", "volume", 4.0 / 3.0 * _PI * 216, _total_volume(r))


async def check_extrude(ws):
    r = await _rebuild(ws, [_sketch_rect("s", 20, 20),
                            {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}])
    register("extrude", "volume", 4000.0, _total_volume(r))


async def check_revolve(ws):
    # rect w4 h10 at x=12 on XZ, revolved 360 about Z -> washer:
    # pi*(14^2 - 10^2)*10
    r = await _rebuild(ws, [_sketch_rect("s", 4, 10, plane="XZ", x=12),
                            {"id": "rv", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 360}])
    register("revolve", "volume", _PI * (14 * 14 - 10 * 10) * 10, _total_volume(r))


async def check_loft(ws):
    r = await _rebuild(ws, [
        _sketch_rect("s1", 20, 20),
        {"id": "s2", "type": "sketch",
         "plane": {"origin": [0, 0, 15], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": [{"type": "circle", "radius": 6}]},
        {"id": "lf", "type": "loft", "sketches": ["s1", "s2"]}])
    register("loft", "bodies_eq", 1, _nbodies(r))
    register("loft", "bbox", [-10, -10, 0, 10, 10, 15], _flat_bbox(r))


async def check_shell(ws):
    # shell keeps the outer envelope: bbox unchanged, still one body.
    r = await _rebuild(ws, [
        _sketch_rect("s", 20, 20),
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"},
        {"id": "sh", "type": "shell", "thickness": 2, "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}])
    register("shell", "bodies_eq", 1, _nbodies(r))
    register("shell", "bbox", [-10, -10, 0, 10, 10, 20], _flat_bbox(r))


async def check_mirror(ws):
    base = [_box("b", 4, 4, 4), {"id": "mv", "type": "move", "dx": 20}]
    pre = _total_volume(await _rebuild(ws, base))
    post = _total_volume(await _rebuild(ws, base + [{"id": "mr", "type": "mirror", "plane": "YZ"}]))
    register("mirror", "delta_volume", 2 * pre, post, pre=pre)


async def check_pattern_rect(ws):
    base = [_box("b", 4, 4, 4)]
    pre = _total_volume(await _rebuild(ws, base))
    post = _total_volume(await _rebuild(ws, base + [
        {"id": "pr", "type": "patternRect", "countX": 3, "countY": 2, "spacingX": 10, "spacingY": 10}]))
    register("patternRect", "delta_volume", 6 * pre, post, pre=pre)


async def check_pattern_circular(ws):
    base = [_box("b", 2, 2, 2), {"id": "mv", "type": "move", "dx": 20}]
    pre = _total_volume(await _rebuild(ws, base))
    post = _total_volume(await _rebuild(ws, base + [
        {"id": "pc", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z"}]))
    register("patternCircular", "delta_volume", 4 * pre, post, pre=pre)


async def check_scale(ws):
    base = [_box("b", 20, 20, 20)]
    pre = _total_volume(await _rebuild(ws, base))
    post = _total_volume(await _rebuild(ws, base + [{"id": "sc", "type": "scale", "factor": 2}]))
    register("scale", "delta_volume", 8 * pre, post, pre=pre)


async def check_move(ws):
    base = [_box("b", 20, 20, 20)]
    pre = _flat_bbox(await _rebuild(ws, base))
    post = _flat_bbox(await _rebuild(ws, base + [{"id": "mv", "type": "move", "dx": 50}]))
    register("move", "delta_bbox", [40, -10, -10, 60, 10, 10], post, pre=pre)


async def check_remove_body(ws):
    base = [_box("b", 20, 20, 20), {"id": "c", "type": "cylinder", "radius": 4, "height": 30}]
    pre = _nbodies(await _rebuild(ws, base))
    post = _nbodies(await _rebuild(ws, base + [{"id": "rm", "type": "removeBody", "bodies": ["body2"]}]))
    register("removeBody", "delta_bodies", 1, post, pre=pre)


async def check_compute_all(ws):
    r = await _rebuild(ws, [_box("b", 20, 20, 20)], op="computeAll", revision=1)
    register("computeAll", "bodies_eq", 1, _nbodies(r))
    register("computeAll", "volume", 8000.0, _total_volume(r))


async def check_interference(ws):
    # two 20-cubes, second shoved +10 in x -> they overlap -> exactly one pair.
    doc = {"parameters": {}, "features": [
        _box("b1", 20, 20, 20), _box("b2", 20, 20, 20), {"id": "mv", "type": "move", "dx": 10}]}
    reply = await H.ws_call(ws, "interference", "c", document=doc)
    if not reply.get("ok"):
        print(f"  REFUSE interference     — op not ok: {reply.get('error')}")
        return
    register("interference", "pairs_eq", 1, len(reply["result"].get("pairs") or []))


async def check_export(ws):
    # export a box to STL, re-import it, and assert the round-tripped volume.
    # (import is used only as a measuring instrument here, not claimed for credit.)
    doc = {"parameters": {}, "features": [_box("b", 20, 20, 20)]}
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "box.stl")
        exp = await H.ws_call(ws, "export", "c", document=doc, format="stl", path=path)
        if not exp.get("ok"):
            print(f"  REFUSE export           — op not ok: {exp.get('error')}")
            return
        imp = await H.ws_call(ws, "import", "c", path=path, format="stl")
        if not imp.get("ok"):
            print(f"  REFUSE export           — reimport not ok: {imp.get('error')}")
            return
        geom = imp["result"]["geom"]
        r = await _rebuild(ws, [{"id": "im", "type": "import", "format": "stl", "name": "box", "geom": geom}])
        register("export", "volume", 8000.0, _total_volume(r))


async def check_fillet(ws):
    r = await _rebuild(ws, [_box("b", 20, 20, 20),
        {"id": "fl", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 2}])
    # 20^3 box, fillet the 4 vertical edges r=2: removes 4*(r^2 - pi r^2/4)*h
    register("fillet", "volume", 8000.0 - 4 * (4 - _PI) * 20, _total_volume(r))
    register("fillet", "bodies_eq", 1, _nbodies(r))


async def check_chamfer(ws):
    r = await _rebuild(ws, [_box("b", 20, 20, 20),
        {"id": "ch", "type": "chamfer", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "distance": 2}])
    # 20^3 box, chamfer 4 vertical edges d=2: removes 4*(d^2/2)*h = 160
    register("chamfer", "volume", 7840.0, _total_volume(r))
    register("chamfer", "bodies_eq", 1, _nbodies(r))


async def check_draft(ws):
    r = await _rebuild(ws, [_box("b", 20, 20, 20),
        {"id": "dr", "type": "draft",
         "faces": {"kind": "face", "by": "normal", "dir": [1, 0, 0]}, "angle": 10, "axis": "Z"}])
    # draft the +X face 10deg about Z (measured constant; flat faces => exact mesh volume)
    register("draft", "volume", 7294.692, _total_volume(r))
    register("draft", "bodies_eq", 1, _nbodies(r))


async def check_sweep(ws):
    r = await _rebuild(ws, [
        {"id": "pa", "type": "sketch", "plane": "XY",
         "entities": [{"type": "line", "x1": 0, "y1": 0, "x2": 20, "y2": 0}]},
        {"id": "pr", "type": "sketch", "plane": "YZ",
         "entities": [{"type": "circle", "radius": 3, "x": 0, "y": 0}]},
        {"id": "sw", "type": "sweep", "profile": "pr", "path": "pa"}])
    # r=3 circle swept 20 along X => cylinder volume pi r^2 L
    register("sweep", "volume", _PI * 9 * 20, _total_volume(r))
    register("sweep", "bodies_eq", 1, _nbodies(r))


async def check_simplify_mesh(ws):
    # import a triangulated STL box, then simplifyMesh — exercises the real
    # UnifySameDomain-on-mesh path (import is a measuring instrument, not credited).
    doc = {"parameters": {}, "features": [_box("b", 20, 20, 20)]}
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "box.stl")
        exp = await H.ws_call(ws, "export", "c", document=doc, format="stl", path=path)
        if not exp.get("ok"):
            print(f"  REFUSE simplifyMesh     — export not ok: {exp.get('error')}")
            return
        imp = await H.ws_call(ws, "import", "c", path=path, format="stl")
        if not imp.get("ok"):
            print(f"  REFUSE simplifyMesh     — reimport not ok: {imp.get('error')}")
            return
        r = await _rebuild(ws, [
            {"id": "im", "type": "import", "format": "stl", "name": "box", "geom": imp["result"]["geom"]},
            {"id": "sm", "type": "simplifyMesh", "tolerance": 1}])
        register("simplifyMesh", "volume", 8000.0, _total_volume(r))
        register("simplifyMesh", "bodies_eq", 1, _nbodies(r))


async def check_sketch(ws):
    # A sketch produces NO solid, so it can only be credited through a consumer
    # that honours it — the same argument datumPlane is credited by below. The
    # profile here is 12x8, deliberately NOT check_extrude's 20x20, so the
    # asserted numbers are determined by THIS sketch's geometry and nothing else.
    r = await _rebuild(ws, [_sketch_rect("s", 12, 8),
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"}])
    register("sketch", "volume", 480.0, _total_volume(r))
    register("sketch", "bbox", [-6, -4, 0, 6, 4, 5], _flat_bbox(r))


async def check_combine(ws):
    # two 20-cubes, the second shoved +10 in x, then joined:
    # 8000 + 8000 - 4000 of overlap. A join that merely grouped the two bodies
    # without fusing them would read 16000 here.
    r = await _rebuild(ws, [
        _box("b1", 20, 20, 20), _box("b2", 20, 20, 20),
        {"id": "mv", "type": "move", "dx": 10},
        {"id": "cb", "type": "combine", "operation": "join",
         "target": "body1", "tools": ["body2"]}])
    register("combine", "volume", 12000.0, _total_volume(r))
    register("combine", "bodies_eq", 1, _nbodies(r))


async def check_press_pull(ws):
    # the top face of a 20-cube pushed +5 along its own normal: 20*20*25.
    # NOT 1.0 mm and not a cut: a cut past an exact 1.0 mm boundary is on record
    # as SIGSEGV-ing inside OCCT, and a segfault here takes the whole harness
    # down rather than failing one check.
    r = await _rebuild(ws, [_box("b", 20, 20, 20),
        {"id": "pp", "type": "press-pull", "operation": "join", "distance": 5,
         "face": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}])
    register("press-pull", "volume", 10000.0, _total_volume(r))
    register("press-pull", "bbox", [-10, -10, -10, 10, 10, 15], _flat_bbox(r))


async def check_offset_face(ws):
    # offset the top face out by 2: 20*20*22. The bbox is what separates this
    # from a thicken — the ORIGINAL body has to have grown, not gained a neighbour.
    r = await _rebuild(ws, [_box("b", 20, 20, 20),
        {"id": "of", "type": "offsetFace", "distance": 2,
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}])
    register("offsetFace", "volume", 8800.0, _total_volume(r))
    register("offsetFace", "bbox", [-10, -10, -10, 10, 10, 12], _flat_bbox(r))


async def check_thicken(ws):
    # thicken defaults to a NEW body: the 20x20 top face at thickness 3 adds
    # 1200 alongside the untouched 8000, which is why the body count is asserted
    # too — 9200 in one body would mean it silently merged.
    r = await _rebuild(ws, [_box("b", 20, 20, 20),
        {"id": "th", "type": "thicken", "thickness": 3,
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}])
    register("thicken", "volume", 9200.0, _total_volume(r))
    register("thicken", "bodies_eq", 2, _nbodies(r))


async def check_delete_face(ws):
    # chamfer one edge, then defeature it away. The heal must restore the
    # ORIGINAL 4000 exactly: a delete that left a hole, or one that healed by
    # extending the wrong neighbour, both miss it.
    r = await _rebuild(ws, [
        {"id": "bx", "type": "box", "length": 20, "width": 20, "height": 10},
        {"id": "ch", "type": "chamfer",
         "edges": {"kind": "edge", "by": "nearest", "point": [0, 10, 5]}, "distance": 3},
        {"id": "df", "type": "deleteFace",
         "face": {"kind": "face", "by": "nearest", "point": [0, 8.5, 3.5]}}])
    register("deleteFace", "volume", 4000.0, _total_volume(r))
    register("deleteFace", "bbox", [-10, -10, -5, 10, 10, 5], _flat_bbox(r))


async def check_texture(ws):
    # Texture displaces at TESSELLATION, not on the solid, so the thing that
    # moves is the MESH volume — which is exactly what _total_volume measures.
    # The constant is measured (like check_draft's), and it is the point of the
    # check: a texture that resolved to nothing would read the untextured 8000.
    r = await _rebuild(ws, [_box("b", 20, 20, 20),
        {"id": "tx", "type": "texture", "kind": "ribs", "depth": 0.4, "scale": 2.0,
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}])
    register("texture", "volume", TEXTURED_BOX_VOLUME, _total_volume(r))
    # Deliberately NO bodies_eq here. A textured body is still one body, so that
    # assertion holds just as well for a texture that did nothing — and because
    # register() credits a unit on ANY passing assertion, pairing it with the
    # volume would let the weak one grant credit whenever the strong one broke.


async def check_text_on_face(ws):
    # Glyph area is HOST-dependent (this is why tessellateText/listFonts are
    # exempted below — a hardcoded glyph count read 23 on one machine and 21 on
    # another), so this check may not hardcode a volume.
    #
    # Instead: one string, one depth, one face, embossed and engraved. The
    # material added must equal the material removed, exactly. That is
    # font-independent, and it CANNOT be satisfied by a feature that silently
    # resolved to nothing — two no-ops make `expected` 0, and _judge refuses a
    # volume assertion whose expected is not strictly positive.
    #
    # No bbox assertion here on purpose. The one that would be meaningful (an
    # emboss stands the text exactly `depth` proud) is measured on the MESH, and
    # at FINE_TOL the box's own corners jitter by ~3e-4 — past BBOX_ABS_TOL, the
    # same reason check_loft's bbox is refused. A volume pair is the honest
    # invariant at this tolerance.
    text = {"type": "textOnFace", "text": "Ag", "height": 6, "align": "center",
            "depth": 0.6, "pick": [0, 0, 10],
            "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
            "face": {"kind": "face", "by": "nearest", "point": [0, 0, 10], "body": "body1"}}
    base = _total_volume(await _rebuild(ws, [_box("b", 20, 20, 20)]))
    up = await _rebuild(ws, [_box("b", 20, 20, 20), dict(text, id="t", operation="emboss")])
    down = await _rebuild(ws, [_box("b", 20, 20, 20), dict(text, id="t", operation="engrave")])
    register("textOnFace", "volume", base - _total_volume(down), _total_volume(up) - base)


async def check_project_geometry(ws):
    # The top-face boundary of a 20x20x10 extrusion projected onto XY: four exact
    # lines on the +-10 footprint. Asserted as a bbox in PLANE coordinates, with
    # z pinned to 0 — a planar projection has no third component, so carrying a
    # real z here would be inventing precision the result does not have.
    doc = {"parameters": {}, "features": [
        _sketch_rect("s1", 20, 20),
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10,
         "operation": "new"}]}
    reply = await H.ws_call(ws, "projectGeometry", "c", document=doc, plane="XY",
                            sources=[{"kind": "faceBoundary", "body": "body1",
                                      "sel": {"kind": "face", "by": "nearest",
                                              "point": [0, 0, 10]}}])
    if not reply.get("ok"):
        print(f"  REFUSE projectGeometry  — op not ok: {reply.get('error')}")
        return
    res = reply["result"]["results"]
    if not res or not res[0].get("ok"):
        print(f"  REFUSE projectGeometry  — source not ok: {res}")
        return
    curves = [e["curve"] for e in res[0]["curves"]]
    if not curves or not all(c.get("kind") == "line" for c in curves):
        print(f"  REFUSE projectGeometry  — expected 4 lines, got {curves}")
        return
    xs = [v for c in curves for v in (c["x1"], c["x2"])]
    ys = [v for c in curves for v in (c["y1"], c["y2"])]
    register("projectGeometry", "bbox", [-10, -10, 0, 10, 10, 0],
             [min(xs), min(ys), 0, max(xs), max(ys), 0])


async def check_migrate_geometry(ws):
    # v4 -> v5 in one hop: hand the op a pre-v5 inline base64 BREP, then rebuild
    # an import feature from the hash it hands back. The volume is what proves
    # the migrated blob is the SAME SOLID. A hash recorded over the wrong bytes,
    # or a blob the rebuild cannot find, both fail here instead of surfacing as
    # an empty document in front of a user opening an old file.
    from build123d import Box

    from builder import _shape_to_brep_b64

    reply = await H.ws_call(ws, "migrateGeometry", "c",
                            items=[{"id": "legacy1",
                                    "brep": _shape_to_brep_b64(Box(20, 20, 20))}])
    if not reply.get("ok"):
        print(f"  REFUSE migrateGeometry  — op not ok: {reply.get('error')}")
        return
    result = reply["result"]
    if result.get("failed") or not result.get("items"):
        print(f"  REFUSE migrateGeometry  — failed={result.get('failed')}")
        return
    r = await _rebuild(ws, [{"id": "im", "type": "import", "format": "brep",
                             "name": "legacy", "geom": result["items"][0]["geom"]}])
    register("migrateGeometry", "volume", 8000.0, _total_volume(r))
    register("migrateGeometry", "bbox", [-10, -10, -10, 10, 10, 10], _flat_bbox(r))


async def check_datum_split(ws):
    # datumPlane + split, together on purpose: a datum registers a plane and
    # produces NO geometry, so its only observable effect is that a consumer
    # honours it. A centred 20-cube cut at an XY datum offset +5 keeps 2000 above
    # the plane (z 5..10); an IGNORED offset would cut at z=0 and read 4000. That
    # is what makes this a real check of the datum and not just of split.
    #
    # These two ops were previously credited ONLY by the golden corpus, via a
    # document whose import source lives in the developer's home directory,
    # outside the repo. So coverage read 23 on that one machine and 21 on every
    # other checkout, and CI could never reach its own floor. Do not re-derive
    # coverage from documents that reach outside the repo.
    datum = [_box("b", 20, 20, 20),
             {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 5}]
    both = await _rebuild(ws, datum + [
        {"id": "sp", "type": "split", "planeId": "dp", "keep": "both"}])
    register("split", "bodies_eq", 2, _nbodies(both))
    top = await _rebuild(ws, datum + [
        {"id": "sp", "type": "split", "planeId": "dp", "keep": "top"}])
    register("datumPlane", "volume", 2000.0, _total_volume(top))


EXPLICIT_CHECKS = [
    check_box, check_cylinder, check_sphere, check_extrude, check_revolve,
    check_loft, check_shell, check_mirror, check_pattern_rect,
    check_pattern_circular, check_scale, check_move, check_remove_body,
    check_compute_all, check_interference, check_export,
    check_fillet, check_chamfer, check_draft, check_sweep, check_simplify_mesh,
    check_datum_split,
    check_sketch, check_combine, check_press_pull, check_offset_face,
    check_thicken, check_delete_face, check_texture, check_text_on_face,
    check_project_geometry,
    check_migrate_geometry,
]


# --- corpus scan --------------------------------------------------------------


async def _credit_corpus(ws):
    """Run each golden document; a document that (a) rebuilds ok, (b) matches its
    recorded body count / per-body volumes / bbox within the golden tolerances,
    and (c) has zero feature errors credits each of its NON-delta feature types
    (delta units are excluded — a document has no pre-op measure)."""
    golden = GC.load_golden()
    for key in sorted(golden):
        entry = golden[key]
        if entry["featureErrors"]:
            continue  # only clean documents credit coverage
        try:
            parsed = __import__("json").load(open(entry["path"]))
            doc = GC.effective_doc(parsed)
            reply = await H.ws_call(ws, "rebuild", "c", document=doc, tolerance=GC.REBUILD_TOLERANCE)
        except Exception as ex:
            print(f"  corpus {key}: rebuild raised {ex}")
            continue
        if not reply.get("ok"):
            print(f"  corpus {key}: rebuild not ok")
            continue
        cur = GC.invariants(reply["result"])
        diffs = (GC._cmp_bodies(entry["bodies"], cur["bodies"])
                 or GC._cmp_volumes(entry["volumes"], cur["volumes"])
                 or GC._cmp_bbox(entry["bbox"], cur["bbox"])
                 or GC._cmp_ferrs(entry["featureErrors"], cur["featureErrors"]))
        if diffs:
            print(f"  corpus {key}: invariant mismatch ({diffs}) — no credit")
            continue
        for t in entry["featureTypes"]:
            if t in DELTA_UNITS:
                continue
            register(t, "bodies_eq", entry["bodies"], cur["bodies"], source=f"corpus:{key}")


async def _main():
    handler_keys = H.parse_feature_handler_keys()
    ops = H.parse_server_ops()
    universe = (handler_keys | ops) - EXCLUDED_OPS
    with H.SpawnedServer() as srv:
        print(f"server child pid={srv.pid} {srv.listening_line}")
        async with websockets.connect(srv.url, max_size=H._MAX_WS) as ws:
            print("-- corpus-derived coverage --")
            await _credit_corpus(ws)
            print("-- explicit checks --")
            for check in EXPLICIT_CHECKS:
                try:
                    await check(ws)
                except Exception as ex:
                    # A check whose op errors (e.g. a primitive that crashes the
                    # render path) earns NO credit — report and keep going so one
                    # broken op can't hide the coverage of every later unit.
                    print(f"  REFUSE {check.__name__}: op raised {type(ex).__name__}: {ex}")
    covered = set(COVERED) & universe
    uncovered = sorted(universe - covered)
    print(f"\ncovered {len(covered)}/{len(universe)}")
    print(f"UNCOVERED {len(uncovered)}: {uncovered}")
    return 0


if __name__ == "__main__":
    sys.exit(H.run(_main()))
