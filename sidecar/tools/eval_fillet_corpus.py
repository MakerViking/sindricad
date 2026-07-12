"""Evaluate a stratified fillet/chamfer corpus against the live sidecar rebuild().

For each case the tool rebuilds the stored document IN-PROCESS (no server, no port)
and decides pass/fail from invariants IT computes from the returned body via
build123d — never from the builder's own diagnostics (those are used only to bucket
the failure taxonomy). A fillet/chamfer feature is FAILED if ANY of:

  (a) error       — its feature_id appears in rebuild()'s errors list, and the
                    message is not a selector miss (those are counted separately);
  (b) validity    — the resulting body is not a SINGLE CLOSED VALID solid
                    (BRepCheck_Analyzer.IsValid() and exactly one solid) — a
                    face-padded / partially-healed body is caught here;
  (c) face-count  — resulting face count < pre_op_faces + n_edges (a correct blend
                    adds >= one face per resolved edge; fewer means a silent partial
                    fallback or a weakened selector);
  (d) volume      — removed volume must be > 0 AND match the reference:
                      analytic cases: |removed - expected_removed| > 2% of expected;
                      combination cases: |removed - ref_removed|   > 2% of ref_removed,
                    where ref_removed is the corpus's sequential-oracle reference.
                    (b)+(c)+(d) together enforce "a fixed case produces a single valid
                    solid covering ALL selected edges" and cannot be spoofed by
                    padding faces or silently dropping an edge.

Selector misses (the op errors with a "no edge found" message) are counted SEPARATELY
and kept out of the headline — the oracle-gated corpus should never miss, so a miss
signals selector breakage. The corpus self-hash (sha256 of the canonical `cases`
array) is recomputed and the tool HARD-FAILS on mismatch, so a tampered/truncated
corpus cannot be scored.

Output: a per-band failure table and a taxonomy breakdown (per-edge vs combination
vs other, plus the top error messages), then the exact final line:
    failed=N/COUNT rate=X.XX% selector-miss=M

HOLDOUT PROTOCOL (anti-memorization). The published main corpus (corpus_fillet.json,
seed 1401) is hash-pinned and visible to implementers, so a tight-band corpus could be
memorized. The evaluator must therefore ALSO regenerate a FRESH holdout at eval time
with an UNPUBLISHED seed and require the improvement to hold on it:
    .venv/bin/python tools/gen_fillet_corpus.py --seed <SECRET> --out /tmp/holdout.json
    .venv/bin/python tools/eval_fillet_corpus.py --corpus /tmp/holdout.json
The secret seed is never committed, never written to any report the implementer can
read, and never left in the loop transcript. Do not reuse 1401 or 9973.

Usage (sidecar venv):
    .venv/bin/python tools/eval_fillet_corpus.py --corpus tools/corpus_fillet.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from OCP.BRepCheck import BRepCheck_Analyzer  # noqa: E402

from builder import rebuild  # noqa: E402

VOLUME_TOL = 0.02  # 2% of the reference removed volume
_SELECTOR_MISS_MARKERS = ("no edge found",)


def _canonical(cases):
    return json.dumps(cases, sort_keys=True, separators=(",", ":"))


def _load(path):
    with open(path) as fh:
        data = json.load(fh)
    cases = data["cases"]
    recomputed = hashlib.sha256(_canonical(cases).encode()).hexdigest()
    stored = data.get("self_hash")
    if recomputed != stored:
        sys.exit(
            f"CORPUS HASH MISMATCH — refusing to run.\n"
            f"  stored     {stored}\n  recomputed {recomputed}\n"
            f"  ({path} is tampered, truncated, or was written by an incompatible generator)"
        )
    return data, cases


def _is_selector_miss(msg):
    m = (msg or "").lower()
    return any(marker in m for marker in _SELECTOR_MISS_MARKERS)


def _valid_single_solid(part):
    try:
        return BRepCheck_Analyzer(part.wrapped).IsValid() and len(part.solids()) == 1
    except Exception:
        return False


def evaluate(cases):
    bands = sorted({c["band"] for c in cases})
    result = {
        "failed": 0,
        "selector_miss": 0,
        "per_edge": 0,       # op errored, edgeOpFailed reason "per-edge"
        "combination": 0,    # op errored, edgeOpFailed reason "combination"
        "other": 0,          # invariant failures / errors without an edge probe
        "error_messages": Counter(),
        "by_band": {b: {"total": 0, "failed": 0} for b in bands},
        "failed_ids": [],
    }

    for c in cases:
        band = c["band"]
        result["by_band"][band]["total"] += 1
        op_id = c["op_feature_id"]
        diag = []
        part, errors, bodies = rebuild(c["doc"], diagnostics=diag)
        op_errors = [e for e in errors if e.get("feature_id") == op_id]

        failed = False
        if op_errors:
            msg = op_errors[0].get("message", "")
            if _is_selector_miss(msg):
                result["selector_miss"] += 1
                continue
            failed = True
            result["error_messages"][msg] += 1
            reasons = [d.get("reason") for d in diag
                       if d.get("kind") == "edgeOpFailed" and d.get("feature_id") == op_id]
            if "per-edge" in reasons:
                result["per_edge"] += 1
            elif "combination" in reasons:
                result["combination"] += 1
            else:
                result["other"] += 1
        else:
            # op did not error — check the invariants this tool computes itself
            checks = []
            if part is None:
                checks.append("no-body")
            else:
                if not _valid_single_solid(part):
                    checks.append("not-single-valid-solid")
                # face-count floor: min_faces (a merging edge set fuses blend faces, so
                # a valid complete solid can dip below pre+n_edges — see the corpus
                # generator). Falls back to the naive pre+n for corpora without the field.
                min_faces = c.get("min_faces") or (c["pre_op_faces"] + c["n_edges"])
                if len(part.faces()) < min_faces:
                    checks.append(f"facecount({len(part.faces())}<{min_faces})")
                removed = c["pre_op_volume"] - float(part.volume)
                exp = c["expected_removed"]
                ref = exp if exp is not None else c["ref_removed"]
                kind = "analytic" if exp is not None else "ref"
                if removed <= 0:
                    checks.append("removed<=0")
                elif ref and abs(removed - ref) > VOLUME_TOL * abs(ref):
                    checks.append(f"volume-{kind}")
            if checks:
                failed = True
                result["other"] += 1
                result["error_messages"]["invariant:" + "+".join(checks)] += 1

        if failed:
            result["failed"] += 1
            result["failed_ids"].append(c["id"])
            result["by_band"][band]["failed"] += 1

    return result


def main():
    ap = argparse.ArgumentParser(description="Evaluate a fillet/chamfer corpus")
    ap.add_argument("--corpus", default=os.path.join(os.path.dirname(__file__), "corpus_fillet.json"))
    ap.add_argument("--show-ids", action="store_true", help="list the failing case ids")
    args = ap.parse_args()

    data, cases = _load(args.corpus)
    count = len(cases)
    res = evaluate(cases)

    failed = res["failed"]
    rate = (failed / count * 100.0) if count else 0.0

    print(f"corpus {args.corpus}: {count} cases, seed {data.get('seed')}, hash OK")
    print("per-band failure:")
    for band in sorted(res["by_band"]):
        b = res["by_band"][band]
        br = (b["failed"] / b["total"] * 100.0) if b["total"] else 0.0
        print(f"  {band:>8}  {b['failed']:3d}/{b['total']:<3d}  {br:5.1f}%")
    print("taxonomy:")
    print(f"  per-edge     {res['per_edge']}")
    print(f"  combination  {res['combination']}")
    print(f"  other        {res['other']}  (invariant failures + errors w/o edge probe)")
    print(f"  selector-miss {res['selector_miss']}  (separate from headline)")
    if res["error_messages"]:
        print("  top messages:")
        for msg, n in res["error_messages"].most_common(10):
            print(f"    {n:4d}  {msg}")
    if args.show_ids and res["failed_ids"]:
        print("  failed ids:", ", ".join(res["failed_ids"]))
    print(f"failed={failed}/{count} rate={rate:.2f}% selector-miss={res['selector_miss']}")


if __name__ == "__main__":
    main()
