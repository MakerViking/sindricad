"""Deterministic, stratified, oracle-gated fillet/chamfer eval corpus generator.

REVISION (auditor A3): the earlier bare 3x clearance floor excised the entire
failure region, saturating the corpus at 0/500. This version STRATIFIES cases into
clearance bands and replaces the clearance floor with a SEQUENTIAL FEASIBILITY
ORACLE, so tight-band-but-achievable cases (where the shipped single-call fillet
fails yet a one-edge-at-a-time application recovers) are admitted and measured.

Each case is a self-contained SindriCAD document: a primitive (box / cylinder) or a
simple join/cut boolean of two primitives, followed by ONE fillet or chamfer feature
(id "op") whose edges are chosen with a legacy queryable selector (axis / all /
nearest — the forms the shipping frontend actually emits; `ofFace` is NOT used, its
face argument routes through the match-fingerprint path the frontend does not emit).

CLEARANCE BAND. For every selected edge the clearance is the distance to the nearest
NON-TOUCHING face of the same body (faces at distance > EPS_TOUCH — a face sharing
the edge or an end vertex touches at 0 and is excluded), additionally capped by the
edge's own radius for a circular rim. A case's band is (min clearance) / (op size).
Cases are generated to fill fixed per-band quotas:
    [1.2, 1.5) x   quota   |  [2.0, 3.0) x   quota
    [1.5, 2.0) x   quota   |  [3.0, inf) x    quota (regression floor)
op is set AFTER measuring clearance (op = min_clearance / ratio, ratio drawn inside
the target band) so a case lands in its band by construction. Boolean templates
(join_L, cut_pocket) dominate the tight bands naturally — their thin walls give a
small clearance whose op stays individually feasible; solid box/cylinder edges have
a full-dimension clearance whose tight-band op would be individually infeasible, so
they populate the loose bands. The per-band template mix is recorded in gen stats.

FEASIBILITY ORACLE (replaces the bare clearance rule). A candidate is accepted iff
  (a) every selected edge blends INDIVIDUALLY on the pre-op body at the drawn size, and
  (b) a reference SEQUENTIAL application — one edge at a time on the evolving body,
      each subsequent edge re-identified geometrically (midpoint + direction + length)
      because prior blends renumber the topology — yields a SINGLE CLOSED VALID solid
      covering ALL selected edges, and
  (c) that sequential result removes net material (ref_removed > 0), so the evaluator's
      "removed volume > 0" and ref-volume checks are well defined.
Cases whose sequential run reaches only n-1 edges (or produces an invalid / multi-solid
body, or net-adds material) are EXCLUDED — the headline must be 100%-achievable. Each
accepted case stores applied=n (== n_edges) and ref_removed (the reference removed
volume from the sequential run) for the evaluator to score the shipped single-call
fillet against.

ANALYTIC SUBSET. A case is analytic only when it is a pure box (no boolean) whose
selected edges are convex 90-degree straight edges that do not interact at a shared
vertex — the `axis` selector's 4 disjoint full-length parallel edges, or a single
`nearest` edge. For those the removed volume is EXACT with no vertex-interaction term:
  fillet:  removed = sum (1 - pi/4) * r^2 * L_e ;  chamfer: removed = sum (1/2) d^2 L_e
The evaluator uses this exact expectation for analytic cases and ref_removed for the
rest.

CYLINDER SEAM. The cyl_axisZ (seam line) and cyl_all (both rims + seam) templates are
included because the frontend can emit those selectors, but the seam is a parametric
artifact OCCT cannot blend, so the oracle rejects those draws at generation — proving
the generator never emits a seam case even sequential can't complete. Seam discards
are logged separately.

DETERMINISM. Every draw comes from one seeded RNG; the sequential oracle uses a fixed
edge order and deterministic OCCT, so re-running a seed reproduces byte-identical
output. All stored floats are rounded to ROUND_DP so the JSON round-trips for the
self-hash (sha256 of the canonical `cases` array, recomputed and enforced by eval).

Usage (sidecar venv):
    .venv/bin/python tools/gen_fillet_corpus.py --seed 1401 --count 500 \
        --out tools/corpus_fillet.json
Frozen main corpus: seed 1401, count 500. The evaluator regenerates a FRESH HOLDOUT at
eval time with an unpublished --seed to a throwaway --out; that seed is never committed
and implementers never see the holdout (see eval_fillet_corpus.py).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from build123d import chamfer, fillet  # noqa: E402
from OCP.BRepCheck import BRepCheck_Analyzer  # noqa: E402
from OCP.BRepExtrema import BRepExtrema_DistShapeShape  # noqa: E402

from builder import rebuild  # noqa: E402
from geom_select import _edge_dir, _edge_mid, resolve_edges  # noqa: E402

EPS_TOUCH = 1e-6
ROUND_DP = 6
OP_MIN = 0.4
MAX_ATTEMPTS_PER_CASE = 600
INF_BAND_RATIO = (3.0, 6.0)  # ratio range used for the [3.0, inf) floor band

# clearance bands: (label, lo, hi). hi = inf for the regression floor.
BANDS = [
    ("1.2-1.5", 1.2, 1.5),
    ("1.5-2.0", 1.5, 2.0),
    ("2.0-3.0", 2.0, 3.0),
    ("3.0-inf", 3.0, math.inf),
]

# which templates may fill which band, as (template, weight) — see module docstring.
# The tight bands lean on join_L: its single reflex (concave) vertical edge is the
# achievable-but-combined-fails case (the shipped single-call blend chokes on the
# reflex neighbourhood while the sequential oracle recovers). cut_pocket contributes
# achievable PASSING tight cases (parallel non-interacting edges the builder handles),
# so the tight bands are an honest mix, not all-failures.
BAND_TEMPLATES = {
    "1.2-1.5": [("join_L", 3), ("cut_pocket", 1)],
    "1.5-2.0": [("join_L", 3), ("cut_pocket", 1)],
    "2.0-3.0": [("box_single", 1), ("cyl_rim", 1), ("join_L", 1), ("cut_pocket", 1)],
    "3.0-inf": [("box_axis", 1), ("box_single", 1), ("cyl_rim", 1), ("join_L", 1),
                ("cut_pocket", 1), ("cyl_axisZ", 1), ("cyl_all", 1)],
}


# --- geometry measurement ----------------------------------------------------


def _edge_is_circle(e):
    try:
        return e.geom_type.name.lower() == "circle"
    except Exception:
        return False


def _edge_radius(e):
    try:
        return float(e.radius)
    except Exception:
        return None


def _clearance(shape, edge):
    """Distance from `edge` to the nearest non-touching face of `shape`, capped by
    the edge's own radius for a circular edge. math.inf if no non-touching face
    (e.g. a cylinder seam line — handled as an infeasible seam draw upstream)."""
    ew = edge.wrapped
    best = math.inf
    for f in shape.faces():
        d = BRepExtrema_DistShapeShape(ew, f.wrapped).Value()
        if d > EPS_TOUCH and d < best:
            best = d
    if _edge_is_circle(edge):
        r = _edge_radius(edge)
        if r is not None and r < best:
            best = r
    return best


def _valid_single_solid(shape):
    try:
        return BRepCheck_Analyzer(shape.wrapped).IsValid() and len(shape.solids()) == 1
    except Exception:
        return False


def _apply_one(shape, edge, op_kind, size):
    if op_kind == "fillet":
        return fillet([edge], radius=size)
    return chamfer([edge], length=size)


# --- feasibility oracle ------------------------------------------------------


def _oracle(preop, edges, op_kind, size):
    """Return (accepted, applied, ref_removed).

    (a) every edge blends individually on the pre-op body, and
    (b) a sequential one-edge-at-a-time application (edges re-identified on the
        evolving body by midpoint + direction + length) covers ALL edges and yields
        a single closed valid solid removing net material.
    """
    # (a) individual feasibility on the pristine pre-op body
    for e in edges:
        try:
            _apply_one(preop, e, op_kind, size)
        except Exception:
            return False, 0, None

    # (b) sequential application with geometric re-identification
    targets = [(_edge_mid(e), _edge_dir(e), float(e.length)) for e in edges]
    order = sorted(range(len(targets)),
                   key=lambda i: tuple(round(c, 3) for c in targets[i][0]))
    tol = 1.5 * size + 0.5
    body = preop
    applied = 0
    for i in order:
        p, d, ln = targets[i]
        best = None  # (cost, midpoint_dist, edge)
        for e in body.edges():
            mp = _edge_mid(e)
            md = (mp - p).length
            ang = 1.0 - abs(_edge_dir(e).dot(d))
            cost = md + 3.0 * ang + 0.2 * abs(float(e.length) - ln)
            if best is None or cost < best[0]:
                best = (cost, md, e)
        if best is None or best[1] > tol:
            return False, applied, None  # target edge no longer present
        try:
            body = _apply_one(body, best[2], op_kind, size)
        except Exception:
            return False, applied, None
        applied += 1

    if applied != len(edges) or not _valid_single_solid(body):
        return False, applied, None
    ref_removed = float(preop.volume) - float(body.volume)
    if ref_removed <= 0:
        return False, applied, None
    return True, applied, ref_removed


# --- case templates ----------------------------------------------------------
# Each returns (features_without_op, selector, analytic_eligible, nominal_size).
# nominal_size only seeds the op fallback for infinite-clearance (seam) draws.


def _t_box_axis(rng):
    L, W, H = (round(rng.uniform(10, 24), 3) for _ in range(3))
    axis = rng.choice(("X", "Y", "Z"))
    feats = [{"id": "b1", "type": "box", "length": L, "width": W, "height": H}]
    return feats, {"kind": "edge", "by": "axis", "axis": axis}, True, min(L, W, H)


def _t_box_single(rng):
    L, W, H = (round(rng.uniform(10, 24), 3) for _ in range(3))
    sx, sy = rng.choice((-1, 1)), rng.choice((-1, 1))
    feats = [{"id": "b1", "type": "box", "length": L, "width": W, "height": H}]
    sel = {"kind": "edge", "by": "nearest", "point": [sx * L / 2, sy * W / 2, 0.0]}
    return feats, sel, True, min(L, W, H)


def _t_box_all(rng):
    # NOTE: intentionally NOT used in the corpus (see BAND_TEMPLATES). Chamfering /
    # filleting all 12 box edges makes three blends meet at each of the 8 corners,
    # where the shipped single-call op and the sequential oracle legitimately differ
    # (~2% corner-treatment volume), which would false-positive the ref-volume check.
    # Every corpus edge set is mutually non-vertex-sharing (parallel axis sets or a
    # single edge) so combined == sequential exactly and ref_removed is a tight
    # reference. Kept only for documentation / ad-hoc probing.
    L, W, H = (round(rng.uniform(10, 24), 3) for _ in range(3))
    feats = [{"id": "b1", "type": "box", "length": L, "width": W, "height": H}]
    return feats, {"kind": "edge", "by": "all"}, False, min(L, W, H)


def _t_cyl_rim(rng):
    R = round(rng.uniform(5, 16), 3)
    H = round(rng.uniform(8, 24), 3)
    feats = [{"id": "c1", "type": "cylinder", "radius": R, "height": H}]
    sel = {"kind": "edge", "by": "nearest", "point": [0.0, 0.0, H / 2]}
    return feats, sel, False, min(R, H)


def _t_cyl_axisZ(rng):  # cylinder SEAM line — oracle rejects (seam is unfilletable)
    R = round(rng.uniform(5, 16), 3)
    H = round(rng.uniform(8, 24), 3)
    feats = [{"id": "c1", "type": "cylinder", "radius": R, "height": H}]
    return feats, {"kind": "edge", "by": "axis", "axis": "Z"}, False, min(R, H)


def _t_cyl_all(rng):  # both rims + seam — oracle rejects (seam is unfilletable)
    R = round(rng.uniform(5, 16), 3)
    H = round(rng.uniform(8, 24), 3)
    feats = [{"id": "c1", "type": "cylinder", "radius": R, "height": H}]
    return feats, {"kind": "edge", "by": "all"}, False, min(R, H)


def _t_join_L(rng):
    L, W, H = (round(rng.uniform(12, 28), 3) for _ in range(3))
    dx = round(L * rng.uniform(0.35, 0.65), 3)
    dy = round(W * rng.uniform(0.35, 0.65), 3)
    feats = [
        {"id": "b1", "type": "box", "length": L, "width": W, "height": H},
        {"id": "b2", "type": "box", "length": L, "width": W, "height": H},
        {"id": "mv", "type": "move", "dx": dx, "dy": dy, "dz": 0,
         "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
        {"id": "cb", "type": "combine", "operation": "join",
         "target": "body1", "tools": ["body2"]},
    ]
    return feats, {"kind": "edge", "by": "axis", "axis": "Z"}, False, min(L, W, H)


def _t_cut_pocket(rng):
    L, W, H = (round(rng.uniform(16, 28), 3) for _ in range(3))
    # a large pocket leaves thin walls -> small clearance -> tight bands
    L2 = round(L - rng.uniform(2, 8), 3)
    W2 = round(W - rng.uniform(2, 8), 3)
    H2 = round(rng.uniform(H * 0.4, H * 0.8), 3)
    feats = [
        {"id": "b1", "type": "box", "length": L, "width": W, "height": H},
        {"id": "b2", "type": "box", "length": L2, "width": W2, "height": H2},
        {"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": round(H / 2, 3),
         "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
        {"id": "cb", "type": "combine", "operation": "cut",
         "target": "body1", "tools": ["body2"]},
    ]
    return feats, {"kind": "edge", "by": "axis", "axis": "Z"}, False, min(L2, W2, H2)


TEMPLATES = {
    "box_axis": _t_box_axis,
    "box_single": _t_box_single,
    "box_all": _t_box_all,
    "cyl_rim": _t_cyl_rim,
    "cyl_axisZ": _t_cyl_axisZ,
    "cyl_all": _t_cyl_all,
    "join_L": _t_join_L,
    "cut_pocket": _t_cut_pocket,
}


# --- analytic expectation ----------------------------------------------------


def _expected_removed(op_kind, size, edges):
    total = 0.0
    for e in edges:
        L = float(e.length)
        if op_kind == "fillet":
            total += (1.0 - math.pi / 4.0) * size * size * L
        else:
            total += 0.5 * size * size * L
    return total


# --- rounding / hashing ------------------------------------------------------


def _round(obj):
    if isinstance(obj, float):
        return round(obj, ROUND_DP)
    if isinstance(obj, dict):
        return {k: _round(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round(v) for v in obj]
    return obj


def _canonical(cases):
    return json.dumps(cases, sort_keys=True, separators=(",", ":"))


# --- generation --------------------------------------------------------------


def _build_active(features):
    part, errors, bodies = rebuild({"parameters": {}, "features": features})
    if errors or not bodies:
        return None
    return bodies[-1]["shape"]


def _pick_band(quota, filled):
    """Choose a band that still needs cases — the one with the largest remaining
    need (ties broken by band order), for balanced deterministic filling."""
    needy = [(quota[b] - filled[b], -i, b) for i, (b, _, _) in enumerate(BANDS)
             if filled[b] < quota[b]]
    needy.sort(reverse=True)
    return needy[0][2]


def generate(seed, count):
    rng = random.Random(seed)
    base = count // len(BANDS)
    quota = {b: base for b, _, _ in BANDS}
    for i in range(count - base * len(BANDS)):  # spread any remainder
        quota[BANDS[i][0]] += 1
    filled = {b: 0 for b, _, _ in BANDS}
    band_range = {b: (lo, hi) for b, lo, hi in BANDS}

    cases = []
    stats = {
        "attempts": 0,
        "rejected_build": 0,
        "rejected_no_edges": 0,
        "rejected_small_op": 0,
        "rejected_band_miss": 0,
        "discard_individual": 0,
        "discard_sequential": 0,
        "discard_seam": 0,
        "by_band": {b: {} for b, _, _ in BANDS},  # band -> {template: n}
    }
    idx = 0
    while len(cases) < count:
        if stats["attempts"] > count * MAX_ATTEMPTS_PER_CASE:
            raise RuntimeError(
                f"gave up after {stats['attempts']} attempts with "
                f"{len(cases)}/{count} cases; band fill {filled}"
            )
        stats["attempts"] += 1
        band = _pick_band(quota, filled)
        lo, hi = band_range[band]
        choices = BAND_TEMPLATES[band]
        tname = rng.choices([n for n, _ in choices], weights=[w for _, w in choices], k=1)[0]
        feats, sel, analytic_ok, nominal = TEMPLATES[tname](rng)
        op_kind = rng.choice(("fillet", "chamfer"))

        active = _build_active(feats)
        if active is None:
            stats["rejected_build"] += 1
            continue
        try:
            edges = resolve_edges(active, sel)
        except Exception:
            edges = []
        if not edges:
            stats["rejected_no_edges"] += 1
            continue

        min_clear = min(_clearance(active, e) for e in edges)
        seam = not math.isfinite(min_clear)
        if seam:
            # a seam-only selection has no bounding clearance; give the oracle a
            # sane size to test (it will reject the unfilletable seam)
            op = round(nominal / rng.uniform(*INF_BAND_RATIO), 3)
        elif math.isinf(hi):
            op = round(min_clear / rng.uniform(*INF_BAND_RATIO), 3)
        else:
            op = round(min_clear / rng.uniform(lo, hi), 3)
        if op < OP_MIN:
            stats["rejected_small_op"] += 1
            continue

        accepted, applied, ref_removed = _oracle(active, edges, op_kind, op)
        if not accepted:
            if seam:
                stats["discard_seam"] += 1
            elif applied == 0:
                stats["discard_individual"] += 1
            else:
                stats["discard_sequential"] += 1
            continue

        # feasible & fully achievable — place it in the band its op actually lands in
        actual_ratio = min_clear / op
        placed = None
        for b, blo, bhi in BANDS:
            if blo <= actual_ratio < bhi:
                placed = b
                break
        if placed is None or filled[placed] >= quota[placed]:
            # landed in a full/undesired band after rounding — drop, try again
            stats["rejected_band_miss"] += 1
            continue

        n_edges = len(edges)
        expected = _expected_removed(op_kind, op, edges) if analytic_ok else None
        if op_kind == "fillet":
            op_feat = {"id": "op", "type": "fillet", "edges": sel, "radius": op}
        else:
            op_feat = {"id": "op", "type": "chamfer", "edges": sel, "distance": op}

        idx += 1
        cases.append(_round({
            "id": f"case_{idx:04d}",
            "template": tname,
            "band": placed,
            "op_kind": op_kind,
            "op_value": op,
            "op_feature_id": "op",
            "selector": sel,
            "n_edges": n_edges,
            "pre_op_faces": len(active.faces()),
            "pre_op_volume": float(active.volume),
            "min_clearance": min_clear,
            "clearance_ratio": actual_ratio,
            "oracle_applied": applied,
            "ref_removed": ref_removed,
            "expected_removed": expected,
            "doc": {"parameters": {}, "features": feats + [op_feat]},
        }))
        filled[placed] += 1
        stats["by_band"][placed][tname] = stats["by_band"][placed].get(tname, 0) + 1
        if len(cases) % 25 == 0:
            print(f"  ... {len(cases)}/{count}  fill={filled}  "
                  f"attempts={stats['attempts']}", file=sys.stderr)

    return cases, stats


def main():
    ap = argparse.ArgumentParser(description="Generate the fillet/chamfer eval corpus")
    ap.add_argument("--seed", type=int, default=1401)
    ap.add_argument("--count", type=int, default=500)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "corpus_fillet.json"))
    args = ap.parse_args()

    cases, stats = generate(args.seed, args.count)
    self_hash = hashlib.sha256(_canonical(cases).encode()).hexdigest()

    n = len(cases)
    out = {
        "seed": args.seed,
        "count": n,
        "bands": [{"label": b, "lo": lo, "hi": (None if math.isinf(hi) else hi)}
                  for b, lo, hi in BANDS],
        "generation_stats": {
            **stats,
            "analytic_cases": sum(1 for c in cases if c["expected_removed"] is not None),
        },
        "cases": cases,
        "self_hash": self_hash,
    }
    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    print(f"{args.out}: {n} cases (seed {args.seed}), self_hash {self_hash[:16]}...")
    print(f"  attempts={stats['attempts']} "
          f"discard: individual={stats['discard_individual']} "
          f"sequential={stats['discard_sequential']} seam={stats['discard_seam']} "
          f"| reject: build={stats['rejected_build']} "
          f"no-edges={stats['rejected_no_edges']} small-op={stats['rejected_small_op']} "
          f"band-miss={stats['rejected_band_miss']}")
    print(f"  analytic={out['generation_stats']['analytic_cases']}")
    for b, _, _ in BANDS:
        print(f"  band {b}: {stats['by_band'][b]}")


if __name__ == "__main__":
    main()
