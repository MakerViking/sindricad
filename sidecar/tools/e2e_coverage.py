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

import golden_corpus as GC
import harness_util as H

# --- hardcoded acceptance tolerances (mirror golden_corpus; not configurable) -
VOL_REL_TOL = 0.005      # volume / delta_volume within 0.5% of expected
BBOX_ABS_TOL = 1e-4      # bbox / delta_bbox component absolute tolerance (mm)
FINE_TOL = 0.005         # rebuild tessellation tol — fine enough that a curved
                         # body's mesh volume matches its analytic volume <0.5%

# Units whose credit MUST come from a pre/post delta (rule (d)). Corpus presence
# alone never credits these — a document has no "before" to compare against.
# Single source of truth lives in harness_util so golden_corpus can't drift.
DELTA_UNITS = H.DELTA_UNITS

# ops already covered by other harnesses / trivially elsewhere — excluded from U.
EXCLUDED_OPS = {"rebuild", "ping", "exportProject", "import"}

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
        brep = imp["result"]["brep"]
        r = await _rebuild(ws, [{"id": "im", "type": "import", "format": "stl", "name": "box", "brep": brep}])
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
            {"id": "im", "type": "import", "format": "stl", "name": "box", "brep": imp["result"]["brep"]},
            {"id": "sm", "type": "simplifyMesh", "tolerance": 1}])
        register("simplifyMesh", "volume", 8000.0, _total_volume(r))
        register("simplifyMesh", "bodies_eq", 1, _nbodies(r))


EXPLICIT_CHECKS = [
    check_box, check_cylinder, check_sphere, check_extrude, check_revolve,
    check_loft, check_shell, check_mirror, check_pattern_rect,
    check_pattern_circular, check_scale, check_move, check_remove_body,
    check_compute_all, check_interference, check_export,
    check_fillet, check_chamfer, check_draft, check_sweep, check_simplify_mesh,
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
