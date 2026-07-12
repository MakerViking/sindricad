# Eval & loop rules (binding for all improvement loops)

## Roles — hard separation, no exceptions

| Role | Does | Must NEVER |
|------|------|-----------|
| Harness builder (H*) | Writes corpus generators + eval harnesses | Audit its own harness, run official baselines, evaluate loop iterations |
| Auditor (A*) | Adversarially reviews a harness before freeze: gameability, correctness, determinism | Be the builder of what it audits; implement fixes |
| Implementer (I*) | Changes product code in the loop worktree | Touch evals/**, sidecar/tools/*corpus*, harness files, tsconfig*; weaken/delete/skip test assertions; read holdout corpora. Type-level fixes in test files (annotations/narrowing with asserted values byte-identical) ONLY under explicit driver assignment + heightened evaluator diff review |
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

## Harness construction rules (lessons from adjudications)

- **Every eval invariant must be executed against the corpus's own certified reference
  solutions at generation time.** A case whose reference fails any eval check must be
  rejected or the check corrected — never ship a corpus whose admission criteria are weaker
  than its scoring criteria. (Learned 2026-07-12: the fillet face-count floor rejected the
  oracle's own references on all 149 tight join_L cases; two audits missed it because the
  shipped builder errored before any invariant ran.)
- Implementer claims of harness defects are adjudicated by the AUDITOR reproducing the claim
  independently (never by trusting implementer code or framing); confirmed defects are fixed
  by the BUILDER, re-audited, re-pinned, and re-baselined — with proof the fix does not
  deflate the runway (shipped-code baseline must be unchanged unless the defect itself
  inflated it).

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

## Mandatory evaluator gates — geometry loops (from audits A2, A3)

Golden-doc / op-coverage loop:
1. Hash-check all frozen tool files (`sidecar/tools/harness_util.py`, `golden_corpus.py`,
   `e2e_coverage.py`) against `evals/MANIFEST.sha256`.
2. `git diff <base>..HEAD -- sidecar/tools/golden.json` → **additions only**: no existing
   entry removed or modified. Re-pinning the hash after growth is NOT sufficient on its own
   (a hand-edit + re-pin would sail through); the diff check is what catches it.
3. **Ratchet metric = e2e `covered/universe`** (delta-gated, constant-asserting,
   non-inflatable). Golden `PASS k/N` is a no-regression gate (must equal N), never a growth
   target — N inflates trivially with near-duplicate docs. `clean-coverage c/26` is
   reportable but not a ratchet (no-op inflation, see audit A2 finding A).
4. `GOLDEN-UPDATE-NEEDED` lines are improvement events requiring human sign-off before the
   golden entry is updated — never auto-updated by any agent.

Fillet/chamfer loop:
1. Hash-check `gen_fillet_corpus.py`, `eval_fillet_corpus.py`, `corpus_fillet.json`.
2. Holdout: the evaluator regenerates a fresh holdout at eval time via
   `gen_fillet_corpus.py --seed <unpublished> --out /tmp/...` — the seed is never written to
   the repo, any report the implementer can read, or the loop transcript. Acceptance requires
   the main-corpus improvement to hold on the fresh holdout within a few points.
3. Grep the implementer's diff (builder.py, geom_select.py) for eval-detection vectors:
   `inspect`, `sys._getframe`, `traceback`, `os.environ` reads, and for literals matching
   corpus dimensions. Any hit = REJECT pending justification.
4. A "fixed" case must produce a single closed valid solid covering ALL selected edges;
   partial application reported as success is a REJECT (the harness's face-count +
   ref-volume invariants enforce this — do not weaken them).
