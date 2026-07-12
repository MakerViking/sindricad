# Eval & loop rules (binding for all improvement loops)

## Roles — hard separation, no exceptions

| Role | Does | Must NEVER |
|------|------|-----------|
| Harness builder (H*) | Writes corpus generators + eval harnesses | Audit its own harness, run official baselines, evaluate loop iterations |
| Auditor (A*) | Adversarially reviews a harness before freeze: gameability, correctness, determinism | Be the builder of what it audits; implement fixes |
| Implementer (I*) | Changes product code in the loop worktree | Touch evals/**, sidecar/tools/*corpus*, harness files, tsconfig*, test assertions; read holdout corpora |
| Evaluator (E*) | Verifies integrity (hashes + git diff of frozen paths), runs harness, runs test suite + build, scans diff for gaming patterns, emits verdict | Be the implementer or builder of the same loop/harness; edit any code |
| Driver | Compares numbers, enforces ratchet, accepts/reverts, writes reports from evaluator verdicts | Write harness logic, grade results itself |

Every role instance is a separate agent. The driver's report must name which agent
performed each role.

## Mechanics

1. **Baseline before iteration 1** — captured by an evaluator-type agent (not the harness
   builder), recorded in `evals/baseline.json`.
2. **Freeze** — after audit, harnesses + corpora are sha256-pinned in `evals/MANIFEST.sha256`
   and committed. Evaluators recompute hashes every iteration and hard-fail on mismatch.
   `git status` on frozen paths must be clean in the loop worktree.
3. **Ratchet** — the full baseline/ratchet file is re-checked every iteration: no metric may
   regress while another improves. Accepted improvements move the floor.
4. **Holdout** — corpus metrics keep a second differently-seeded corpus, never shown to
   implementers. Acceptance requires comparable holdout improvement (gap = overfitting).
5. **Independent invariants** — pass/fail computed by the harness from returned geometry /
   compiler output, never from product-code-emitted diagnostics.
6. **One variable per iteration**; iterations that don't move the metric are reverted.
7. **Stop conditions** — per-loop iteration budget + plateau rule (2 consecutive no-gain
   iterations → stop and report). A saturated metric produces only gaming signal.
8. **Report** — on loop completion, driver writes `evals/reports/<loop>-<date>.md`:
   baseline → per-iteration table (delta, accepted/reverted, evaluator verdict) → final,
   hash-verification statements, role/agent roster, and what remains.

## Gaming patterns evaluators must scan diffs for

- `@ts-nocheck` (whole-file suppression — strongest undercount lever), `@ts-ignore`,
  `@ts-expect-error`, new `as any` / `as unknown as` casts, non-null `!` waves,
  broad `declare module` shims in added `.d.ts` files
- Weakened/deleted test assertions, `.skip`, loosened tolerances
- Edits to frozen paths (harness, corpus, manifest, ALL tsconfigs incl. root, golden files)
- Special-casing corpus inputs in product code (grep suspicious literals from corpus docs)
- Exception swallowing around measured code paths

## Mandatory evaluator gates — ts-strict loop (from audit A1)

Run in the loop worktree every iteration, `<base>` = the freeze commit:

1. Hash check `evals/MANIFEST.sha256` entries (includes ROOT `tsconfig.json` — the strict
   config inherits its `include` and `strict` family, so root edits shrink the metric while
   `evals/**` diffing stays blind; confirmed live by audit A1).
2. `git diff --name-only <base>..HEAD -- '**/tsconfig*.json' ':(exclude)evals/**'` → must be empty.
3. `git diff <base>..HEAD -- 'src/**' | grep -nE '^\+.*@ts-(nocheck|ignore|expect-error)'` → must be empty.
4. Scan added lines in `src/**` for `as any`, `as unknown as`, suspicious `!` waves, new
   `.d.ts` `declare module` shims — judgment call, flag in verdict.
5. `npm test` passes; `npm run build` passes (the strict flags are extra — the normal build
   must stay green).
