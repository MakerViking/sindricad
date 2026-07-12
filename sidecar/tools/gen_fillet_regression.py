"""Regression stratum for the fillet/chamfer loop: the common ALL-EDGES case.

Auditor A3 fast-follow (task #10). The main corpus (corpus_fillet.json) deliberately
excludes box_all / cyl_all because chamfering/filleting a shared-vertex edge set makes
several blends meet at each corner, where the shipped single-call op and a sequential
per-edge run legitimately diverge (~2% corner volume) — so a sequential reference is
not a valid oracle for them. But a sequential-FALLBACK implementation of fillet must
not REGRESS these everyday cases. This separate corpus is that guard rail.

Cases: box_all (all 12 box edges, fillet AND chamfer) and cyl_all (both circular rims
of a cylinder, fillet AND chamfer; the seam edge is EXCLUDED — it is a parametric
artifact OCCT cannot blend — by selecting the two rims explicitly rather than `all`).

FEASIBILITY ORACLE (different from the main corpus on purpose): a case is admitted iff
the COMBINED (single-call) op ALREADY succeeds on today's shipped builder with a single
closed valid solid that clears the evaluator's checks. The sequential certifier is NOT
used here — it cannot complete a shared-vertex set, and it is not the reference anyway.
op is drawn at a comfortably feasible fraction of the local size so combined succeeds.

The evaluator (eval_fillet_corpus.py, unchanged) scores this file with validity +
face-count + ref-volume(2%): each case stores expected_removed=null and ref_removed =
the CERTIFIED COMBINED op's removed volume. Storing the combined removed (not null) is
what closes A3's face-count blind spot: box_all's shared vertices give ~1.7 blend
faces/edge, so a genuine 10/12 or 11/12 partial still clears pre_faces + n_edges and
would slip past validity + face-count + removed>0 alone. With ref_removed populated,
the evaluator's 2% ref-volume branch flags an 11/12 partial (~11.5% divergence) and
anything coarser (a dropped cyl rim ~= 50%). This is exact here — unlike the main
corpus, BOTH the reference AND the shipped path are the single-call combined op, so a
correct implementation matches to ~0% (the ~2% corner-divergence caveat applies only to
a SEQUENTIAL reference, which this corpus does not use). Expected baseline: 0/COUNT
today — the point is that it STAYS 0 after a fillet change.

Deterministic seeded generation; the seed is publishable (this is a regression floor,
not a held-out target). self-hash (sha256 of the canonical `cases` array) like the main
corpus, enforced by the evaluator.

Usage (sidecar venv):
    .venv/bin/python tools/gen_fillet_regression.py --seed 4242 --count 60 \
        --out tools/corpus_fillet_regression.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from builder import rebuild  # noqa: E402
from geom_select import resolve_edges  # noqa: E402

# read-only reuse of the frozen main generator's helpers (import does not modify it)
from gen_fillet_corpus import (  # noqa: E402
    _canonical,
    _clearance,
    _round,
    _valid_single_solid,
)

OP_MIN = 0.4
FEASIBLE_RATIO = (4.0, 8.0)  # op = local_size / U(4, 8) — comfortably feasible for combined
MAX_ATTEMPTS_PER_CASE = 400

# fixed (template, op_kind) quotas summing to the default count (15 each -> 60)
QUOTAS = [
    ("box_all", "fillet", 15),
    ("box_all", "chamfer", 15),
    ("cyl_all", "fillet", 15),
    ("cyl_all", "chamfer", 15),
]


def _t_box_all(rng):
    L, W, H = (round(rng.uniform(10, 24), 3) for _ in range(3))
    feats = [{"id": "b1", "type": "box", "length": L, "width": W, "height": H}]
    return feats, {"kind": "edge", "by": "all"}, min(L, W, H)


def _t_cyl_all(rng):
    R = round(rng.uniform(5, 16), 3)
    H = round(rng.uniform(8, 24), 3)
    feats = [{"id": "c1", "type": "cylinder", "radius": R, "height": H}]
    # both rims, seam excluded: a two-selector union of nearest-to-each-rim-centre
    sel = [
        {"kind": "edge", "by": "nearest", "point": [0.0, 0.0, H / 2]},
        {"kind": "edge", "by": "nearest", "point": [0.0, 0.0, -H / 2]},
    ]
    return feats, sel, min(R, H)


TEMPLATES = {"box_all": _t_box_all, "cyl_all": _t_cyl_all}


def _build_active(features):
    part, errors, bodies = rebuild({"parameters": {}, "features": features})
    if errors or not bodies:
        return None
    return bodies[-1]["shape"]


def _certify(feats, sel, op_kind, op, n_edges, pre_faces, pre_vol):
    """Combined-op oracle: build the full doc and require it to clear the evaluator's
    regression checks (no op error, single closed valid solid, face-count, removed>0).
    Returns (ok, doc, ref_removed) — ref_removed is the COMBINED op's removed volume,
    which the evaluator's 2% ref-volume branch compares the shipped combined result
    against. Because BOTH the reference and the shipped path here are the single-call
    combined op, a correct implementation matches to ~0%, while a partial (e.g. 11/12
    edges ~= 11.5%, or a dropped cyl rim ~= 50%) diverges and is caught — closing the
    face-count blind spot (box_all's shared-vertex corners give ~1.7 faces/edge, so a
    partial still clears pre_faces + n_edges). The ~2% corner-divergence caveat only
    applies to a SEQUENTIAL reference, which this corpus deliberately does not use."""
    if op_kind == "fillet":
        op_feat = {"id": "op", "type": "fillet", "edges": sel, "radius": op}
    else:
        op_feat = {"id": "op", "type": "chamfer", "edges": sel, "distance": op}
    doc = {"parameters": {}, "features": feats + [op_feat]}
    part, errors, _bodies = rebuild(doc)
    if any(e.get("feature_id") == "op" for e in errors):
        return False, doc, None
    if part is None or not _valid_single_solid(part):
        return False, doc, None
    if len(part.faces()) < pre_faces + n_edges:
        return False, doc, None
    removed = pre_vol - float(part.volume)
    if removed <= 0:
        return False, doc, None
    return True, doc, removed


def generate(seed, count):
    rng = random.Random(seed)
    # scale the fixed quotas if a non-default count is requested
    total = sum(q for *_, q in QUOTAS)
    scaled = [(t, k, max(1, round(q * count / total))) for t, k, q in QUOTAS]
    # fix rounding drift so the quotas sum exactly to count
    drift = count - sum(q for *_, q in scaled)
    scaled[0] = (scaled[0][0], scaled[0][1], scaled[0][2] + drift)
    need = {(t, k): q for t, k, q in scaled}

    stats = {"attempts": 0, "discard_combined": 0, "rejected_build": 0,
             "rejected_small_op": 0, "by_kind": {}}
    cases = []
    idx = 0
    order = [(t, k) for t, k, _ in scaled]
    while len(cases) < count:
        if stats["attempts"] > count * MAX_ATTEMPTS_PER_CASE:
            raise RuntimeError(f"gave up after {stats['attempts']} attempts; need {need}")
        stats["attempts"] += 1
        # pick a (template, kind) that still needs cases, in fixed order for determinism
        target = next(((t, k) for (t, k) in order if need[(t, k)] > 0), None)
        if target is None:
            break
        tname, op_kind = target
        feats, sel, nominal = TEMPLATES[tname](rng)

        active = _build_active(feats)
        if active is None:
            stats["rejected_build"] += 1
            continue
        try:
            edges = resolve_edges(active, sel)
        except Exception:
            edges = []
        if not edges:
            stats["rejected_build"] += 1
            continue

        op = round(nominal / rng.uniform(*FEASIBLE_RATIO), 3)
        if op < OP_MIN:
            stats["rejected_small_op"] += 1
            continue

        n_edges = len(edges)
        pre_faces = len(active.faces())
        pre_vol = float(active.volume)
        min_clear = min(_clearance(active, e) for e in edges)

        ok, doc, ref_removed = _certify(feats, sel, op_kind, op, n_edges, pre_faces, pre_vol)
        if not ok:
            stats["discard_combined"] += 1
            continue

        idx += 1
        need[target] -= 1
        stats["by_kind"][f"{tname}/{op_kind}"] = stats["by_kind"].get(f"{tname}/{op_kind}", 0) + 1
        cases.append(_round({
            "id": f"reg_{idx:04d}",
            "template": tname,
            "band": "regression",
            "op_kind": op_kind,
            "op_value": op,
            "op_feature_id": "op",
            "selector": sel,
            "n_edges": n_edges,
            "pre_op_faces": pre_faces,
            "pre_op_volume": pre_vol,
            "min_clearance": min_clear,
            "oracle_applied": n_edges,   # combined op covers all edges
            "ref_removed": ref_removed,   # COMBINED reference: catches partial fillets
            "expected_removed": None,     # not analytic
            "doc": doc,
        }))

    return cases, stats


def main():
    ap = argparse.ArgumentParser(description="Generate the box_all/cyl_all regression stratum")
    ap.add_argument("--seed", type=int, default=4242)
    ap.add_argument("--count", type=int, default=60)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "corpus_fillet_regression.json"))
    args = ap.parse_args()

    cases, stats = generate(args.seed, args.count)
    self_hash = hashlib.sha256(_canonical(cases).encode()).hexdigest()
    out = {
        "seed": args.seed,
        "count": len(cases),
        "kind": "regression",
        "generation_stats": stats,
        "cases": cases,
        "self_hash": self_hash,
    }
    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    print(f"{args.out}: {len(cases)} cases (seed {args.seed}), self_hash {self_hash[:16]}...")
    print(f"  attempts={stats['attempts']} discard_combined={stats['discard_combined']} "
          f"rejected_build={stats['rejected_build']} small_op={stats['rejected_small_op']}")
    print(f"  by_kind={stats['by_kind']}")


if __name__ == "__main__":
    main()
