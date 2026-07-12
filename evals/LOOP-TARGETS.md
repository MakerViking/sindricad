# Improvement-loop targets

Generated 2026-07-12 by a 24-agent scan: 6 specialist finders (one per dimension), every
proposed target then attacked by an **independent adversarial verifier** that checked the
cited code, gameability, and measurability — several verifiers ran live probes. Full detail
(refined metric definitions, anti-gaming countermeasures, file:line evidence, kill reasons)
is in `loop-targets.json`; this file is the ranked summary + the loop architecture.

18 proposed → 17 kept, 1 killed (`save-load-roundtrip-fidelity`: verifier built and ran the
harness — already 100% idempotent on all 13 real fixtures, zero runway).

## Ranked targets

| # | Target | Dim | Metric (direction) | Goal | Harness | Score |
|---|--------|-----|--------------------|------|---------|-------|
| 1 | fillet-chamfer-success | geometry | failed fillet/chamfer features on frozen feasible corpus (↓) | −50%, then recalibrate | hours | 8.5 |
| 2 | cold-rebuild-latency | perf | p50 ms cold full rebuild, 170-feature doc (↓) | −30% at identical output invariants | hours | 8.5 |
| 3 | selector-survival | geometry | % selector refs resolving to intended entity after upstream mutation (↑) | ≥95% legacy / ≥99% v2 | day | 8 |
| 4 | boolean-body-validity | geometry | % bodies passing BRepCheck + expected solid count (↑) | ≥99% | hours | 8 |
| 5 | warm-edit-latency | perf | p50 ms per warm edit, end-to-end WS round trip (↓) | <500 ms on 170-feature doc | hours | 8 |
| 6 | rebuild-payload-bytes | perf | WS reply bytes per full rebuild at pinned mesh quality (↓) | −5× at identical triangle counts | hours | 8 |
| 7 | ts-strict-ratchet | frontend | tsc error count under `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` (↓) | 0, then flip flags on permanently | **exists** | 8 |
| 8 | golden-doc-corpus | eval-infra | golden docs passing recorded invariants via headless ws (↑) | 40+ docs, all 26 feature handlers | day | 8 |
| 9 | real-server-op-coverage | eval-infra | feature handlers + server ops with zero real-ws invariant coverage (↓) | 0 of 26 uncovered (today: 11) | hours | 8 |
| 10 | real-part-benchmark-pass-rate | capability | % curated real-part docs rebuilding with correct volume/topology (↑) | ≥95% | day | 8 |
| 11 | feature-fuzz-robustness | capability | % of 500 seeded feasible feature-timelines rebuilding clean (↑) | ≥99%, then widen ranges | hours | 8 |
| 12 | sketch-region-detection-rate | capability | % generated sketches with correct region/profile detection (↑) | ≥97% | hours | 7.5 |
| 13 | raw-error-message-rate | robustness | % failure responses leaking raw Python/OCCT internals (↓) | <5% | hours | 6.5 |
| 14 | doc-fuzz-escape-rate | robustness | uncaught exceptions per 1000 mutated docs into rebuild() (↓) | 0, held across 3 fresh seeds | hours | 6 |
| 15 | core-logic-coverage | frontend | vitest line % on src/{document,sketch,geometry,io} (↑) | 70% | hours | 6 |
| 16 | dead-exports | frontend | knip unused-export count (↓) | 0, ratcheted | hours | 6 |
| 17 | export-roundtrip-fidelity | eval-infra | export→reimport→compare passes over shape×format grid (↑) | 100% of ≥39 cells | hours | 5.5 |

Notable verified facts from the scan:
- A live 60-case probe measured **48% fillet/chamfer failure** on feasible cases —
  deterministic, with a built-in failure taxonomy from `_report_edge_failures`
  (builder.py:1033–1063). Target #1 has the most user-visible headroom.
- 11 of 26 feature handlers have zero real-server invariant coverage (#9), which caps how
  much the other geometry loops can claim. #8/#9 are *unblockers*: build them first and
  every geometry loop gets its acceptance harness for free.
- #7 needs zero harness work: the metric is `tsc` with two extra flags today.

## Loop architecture (applies to every loop)

**Roles — never self-graded.** Three separate agents per iteration:
1. *Implementer* — changes product code only. The `evals/` dir and corpora are read-only to it.
2. *Evaluator* — different agent, adversarial prompt, no access to the implementer's
   reasoning. Verifies eval-dir integrity (`git diff` + sha256 of corpus and harness against
   the pinned hashes below), runs the harness, writes the verdict.
3. *Loop driver* — accepts an iteration only on evaluator sign-off; reverts no-gain iterations.

**Mechanics.**
- **Baseline first**: capture and commit every metric to `evals/baseline.json` before
  iteration 1. No baseline, no loop.
- **Ratchet**: the whole baseline file is re-checked every iteration — no metric may regress
  while another improves. Improvements update the ratchet floor.
- **Frozen corpora**: eval corpora + harness scripts are committed and sha256-pinned; the
  evaluator refuses to score if hashes mismatch. (`sidecar/tools/` must be committed first —
  it is currently untracked.)
- **Holdouts**: corpus-based metrics keep a second, differently-seeded corpus the implementer
  never sees; acceptance requires comparable improvement on it (catches special-casing).
- **Independent invariants**: pass/fail computed by the harness from returned geometry
  (volume/face-count/bbox via build123d), never from builder-emitted diagnostics — closes the
  exception-swallowing and partial-success gaming vectors (see per-target `anti_gaming` in
  the JSON).
- **One variable per iteration**, measured; **stop conditions**: iteration/time budget plus a
  plateau rule (K iterations without gain → stop). The save-load kill shows why: a saturated
  metric only produces gaming signal.

## Recommended first wave

1. **ts-strict-ratchet** — free harness, start it today as the pipeline shakedown.
2. **golden-doc-corpus + real-server-op-coverage** — one combined harness-building effort
   that unblocks every geometry/capability loop.
3. **fillet-chamfer-success** — biggest verified user-visible headroom (48% failure);
   corpus generation rules and anti-gaming invariants are fully specified in the JSON.
