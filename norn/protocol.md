# SindriCAD selector-survival (v2 match) — optimization protocol

Sealed goalposts for this arc. After seal, this file is hash-locked; changing anything
here requires the TTY-gated `rebaseline` subcommand.

## Metric and bar

- Target: `v2_rate`, direction `max`, minimum accept delta **0.009** (≈2 of 220 cases) vs incumbent.
- min_delta was sized after the drill: measured noise floor = **0.0** (oracle is deterministic).
- Guardrails (hard ceilings/floors, breach = REJECT regardless of target):
  - per-category survival floors so a headline gain can't rob one category to pay another:
    `concentric`, `mirrored_twin`, `boolean_stack`, `moved_sketch`, `dimension_change`,
    `added_feature` — each floored at its sealed baseline.
  - `invalid_count` max 0 — a frozen corpus case losing key-uniqueness signals corpus/
    determinism drift, not a resolver win.
  - `tests_pass` min 1 — `test_selector_v2.py` must stay green under the tuned config.

Only the v2 `by:"match"` / `tangentChain` path is tunable by these constants; the legacy
`axis`/`normal`/`nearest` selectors are untouched by them, so this arc targets v2 accuracy.

## Oracle

- Command: `sidecar/.venv/bin/python sidecar/tools/eval_selector_survival.py --config {config} --corpus sidecar/tools/corpus/corpus_selectors.json`
  — run from the project root; prints one JSON line (last stdout line), keys exactly
  {`v2_rate`, `concentric`, `mirrored_twin`, `boolean_stack`, `moved_sketch`,
  `dimension_change`, `added_feature`, `invalid_count`, `tests_pass`}; diagnostics to
  stderr; nonzero exit = INVALID.
- Hash-locked files: `sidecar/tools/eval_selector_survival.py`,
  `sidecar/tools/gen_selector_corpus.py`, `sidecar/geom_select.py`,
  `sidecar/test_selector_v2.py`, `sidecar/tools/test_selector_eval_math.py`.
- Runs per measurement: 3; deterministic: true (bit-identical rebuilds confirmed).
- Metric math pinned by hand-computed unit tests in `sidecar/tools/test_selector_eval_math.py`.

## Frozen world

- Fixture dir: `sidecar/tools/corpus/` (manifest: norn/manifest.json, provenance: seeded
  generator, seed 20260714, 220 cases, 40.9% concentric/mirrored-twin hard cases).
- Labels: none — the oracle needs no judged labels. The intended entity for each case is
  fixed at generation time by an independent structural rule (build123d's own filters),
  frozen as an identity key, and never derived from the resolver under test.

## Loop policy

- One knob per experiment: exactly one changed line in `sidecar/selector_tuning.json`
  (the 13 scoring constants) vs norn/baseline/.
- Stop condition: 4 consecutive rejects => stop, do error analysis on worst cases
  (start with the concentric and moved_sketch misses — the largest baseline headroom).
- Holdout: a second differently-seeded corpus, touched exactly once, by finalize, on the
  accepted winner only.

```json norn-protocol
{
  "oracle": {
    "command": "sidecar/.venv/bin/python sidecar/tools/eval_selector_survival.py --config {config} --corpus sidecar/tools/corpus/corpus_selectors.json",
    "files": [
      "sidecar/tools/eval_selector_survival.py",
      "sidecar/tools/gen_selector_corpus.py",
      "sidecar/geom_select.py",
      "sidecar/test_selector_v2.py",
      "sidecar/tools/test_selector_eval_math.py"
    ],
    "runs": 3,
    "deterministic": true
  },
  "config_file": "sidecar/selector_tuning.json",
  "target": {"key": "v2_rate", "direction": "max", "min_delta": 0.009},
  "guardrails": [
    {"key": "concentric", "min": 0.8},
    {"key": "mirrored_twin", "min": 0.888889},
    {"key": "boolean_stack", "min": 0.975},
    {"key": "moved_sketch", "min": 0.866667},
    {"key": "dimension_change", "min": 1.0},
    {"key": "added_feature", "min": 1.0},
    {"key": "invalid_count", "max": 0.0},
    {"key": "tests_pass", "min": 1.0}
  ],
  "stop": {"consecutive_rejects": 4}
}
```
