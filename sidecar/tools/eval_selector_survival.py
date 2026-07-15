"""Selector-survival oracle (Norn oracle entry-point — hash-locked at seal).

Scores the v2 `by:"match"` resolver under a given tuning config against the frozen
corpus. Contract (Norn oracle): prints exactly ONE JSON line as the last line of
stdout; keys are a fixed numeric set; all diagnostics go to stderr; exit 0 on a
completed measurement, nonzero on a setup failure (bad args, unreadable corpus/config).

  .venv/bin/python tools/eval_selector_survival.py --config selector_tuning.json --corpus tools/corpus_selectors.json

For each case: rebuild the mutated part from its stored spec, run the resolver under
the config, and score survival = the resolved entity's identity key == the frozen
expected key (computed at generation time, never from the resolver). A case whose
frozen key no longer uniquely identifies one entity in the freshly built part is
counted 'invalid' (a determinism/corpus tripwire), against neither survival nor total.

Emitted keys:
  v2_rate            overall survived / valid   (TARGET, maximize)
  <category>         per-category survival rate (6 keys; guardrail floors)
  invalid_count      cases whose frozen key lost uniqueness (guardrail: max 0)
  tests_pass         1.0 iff test_selector_v2.py passes under this config (guardrail: min 1)
"""

import argparse
import contextlib
import json
import os
import sys

_SIDECAR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SIDECAR)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import geom_select as gs  # noqa: E402
from gen_selector_corpus import build_part, entity_key  # noqa: E402

CATEGORIES = ["concentric", "mirrored_twin", "boolean_stack",
              "moved_sketch", "dimension_change", "added_feature"]


def score_case(case):
    """Return 'survive' | 'miss' | 'invalid' for one case (per-case errors -> invalid)."""
    kind = case["kind"]
    exp = case["expected_key"]
    try:
        part = build_part(case["mutated_spec"])
        ents = list(part.edges() if kind == "edge" else part.faces())
        # invalidity tripwire: the frozen key must still pin exactly one entity
        if sum(1 for e in ents if entity_key(kind, e) == exp) != 1:
            return "invalid"
        got = (gs.resolve_edges(part, case["selector"]) if kind == "edge"
               else gs.resolve_faces(part, case["selector"]))
        if not got:
            return "miss"
        return "survive" if entity_key(kind, got[0]) == exp else "miss"
    except Exception as ex:  # a broken fixture is not the resolver's fault
        print(f"  case {case['id']} raised: {ex}", file=sys.stderr)
        return "invalid"


def run_selector_tests():
    """Run test_selector_v2 in-process; True iff it passes. stdout captured to stderr."""
    try:
        import test_selector_v2 as t
        with contextlib.redirect_stdout(sys.stderr):
            t.main()
        return True
    except Exception as ex:
        print(f"  test_selector_v2 FAILED: {ex}", file=sys.stderr)
        return False


def aggregate(outcomes):
    """Pure survival-rate math (unit-tested in test_selector_eval_math.py).

    `outcomes` is a list of (category, 'survive'|'miss'|'invalid'). Invalid cases are
    excluded from BOTH numerator and denominator. Rates are survived/valid, 0.0 when a
    denominator is empty. Returns the metric dict WITHOUT tests_pass (added by main).
    """
    survive = {c: 0 for c in CATEGORIES}
    valid = {c: 0 for c in CATEGORIES}
    invalid_count = 0
    for cat, r in outcomes:
        if r == "invalid":
            invalid_count += 1
            continue
        valid[cat] += 1
        if r == "survive":
            survive[cat] += 1
    total_survive = sum(survive.values())
    total_valid = sum(valid.values())
    out = {"v2_rate": round(total_survive / total_valid, 6) if total_valid else 0.0}
    for c in CATEGORIES:
        out[c] = round(survive[c] / valid[c], 6) if valid[c] else 0.0
    out["invalid_count"] = float(invalid_count)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, help="tuning JSON (the knob under test)")
    ap.add_argument("--corpus", required=True, help="frozen corpus_selectors.json")
    args = ap.parse_args()

    try:
        gs.configure(args.config)
        with open(args.corpus) as f:
            corpus = json.load(f)
    except Exception as ex:
        print(f"setup failure: {ex}", file=sys.stderr)
        return 2

    cases = corpus.get("cases", [])
    if not cases:
        print("empty corpus", file=sys.stderr)
        return 2

    outcomes = [(case["category"], score_case(case)) for case in cases]
    out = aggregate(outcomes)
    out["tests_pass"] = 1.0 if run_selector_tests() else 0.0

    survive = {c: sum(1 for cat, r in outcomes if cat == c and r == "survive") for c in CATEGORIES}
    valid = {c: sum(1 for cat, r in outcomes if cat == c and r != "invalid") for c in CATEGORIES}
    print(f"survive={sum(survive.values())}/{sum(valid.values())} per-category="
          f"{ {c: (survive[c], valid[c]) for c in CATEGORIES} }", file=sys.stderr)
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
