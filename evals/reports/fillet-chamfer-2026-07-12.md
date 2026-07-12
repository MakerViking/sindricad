# Loop report: fillet/chamfer robustness — CLOSED AT GOAL

**Result: 149/500 failed → 0/500 failed (29.8% → 0.0%)** on the frozen 500-case stratified
corpus — and, decisively, **0/500 on a secret-seed holdout where the shipped builder fails
134/500 (26.8%)**. The fix generalizes; memorization is ruled out by construction.

Branch: `loop/fillet` (worktree `.claude/worktrees/loop-fillet`), base `132dbe7`,
HEAD `41b8644`. **Not merged** — user's call (see merge notes).

## What the product gained

Fillet/chamfer on tight concave geometry (boolean joins where blend radius is 1.2–2× the
local wall clearance) previously **hard-failed** — OCCT's combined operation raises, the
feature errors out, edges paint red. Now:

- Combined single-call operation stays PRIMARY (fast path; correctly handles vertex-sharing
  sets like all-12-box-edges — protected by a dedicated 60-case regression stratum, 0/60).
- On combined failure: sequential per-edge blending on the evolving body, edges re-found by
  geometric identity through topology renumbering, multi-pass to a fixpoint, in **canonical
  order** (sorted rounded-3dp midpoint) — making rebuild output deterministic, an
  architectural requirement in a full-rebuild system.
- **All-or-nothing honesty preserved**: any unrecoverable edge → red-edge diagnostics +
  original error. No partial success, no silent radius reduction — verified by code review
  AND by independent volume invariants on all 1000 corpus+holdout cases.
- Rider fix: `server.py` honors `SINDRI_SIDECAR_PORT` (defaults to 8765; enables headless
  harness runs without colliding with the live app).

## Iterations

| Step | Commit | Frozen corpus | Notes |
|------|--------|---------------|-------|
| baseline | 132dbe7 | 149/500 fail | all `combination`-class OCCT raises, tight join_L |
| 1 | ba2cf36 | 149/500 | fallback recovers all 149 geometrically (valid solids, exact volume) but metric frozen — implementer flagged SUSPECTED-HARNESS-DEFECT |
| adjudication | — | — | auditor A3 confirmed: eval's face-count floor rejected the corpus oracle's own reference solutions (merged blend faces); harness fixed under governance (min_faces floor, `b2a2799`), **shipped-builder baseline unchanged at 149 = no runway deflation** |
| 2 | 41b8644 | **0/500** | canonical edge ordering; volume matches reference exactly |

Final gates (evaluator EV2, fresh agent, all run independently): frozen corpus 0/500 twice;
secret holdout 0/500 (vs 134/500 shipped baseline on same holdout); regression stratum 0/60;
golden corpus 13/13 with sentinels untouched; sidecar tests all pass; gaming scan clean
(zero eval-detection vectors, zero corpus literals, the one sanctioned server.py line).

## Role roster

Corpus/harness builder: H3 · Harness auditor + adjudicator: A3 · Implementer: I-fillet-impl ·
Final evaluator: EV2 (fresh, no prior role) · Driver: main session. Six parties, no
self-grading at any step.

## The adjudication (worth remembering)

The implementer's "this eval is unwinnable" claim — the #1 gaming pattern on its face —
was **TRUE**: overlapping fillets merge blend faces, so the eval's face-count floor rejected
geometrically perfect solutions. It was caught only because the claim was adjudicated by an
independent auditor who rebuilt the references from scratch, and fixed only under
governance with proof the shipped-builder baseline (the runway) stayed at 149. Systemic
lesson now in RULES.md: every eval invariant must be executed against the corpus's own
certified reference solutions at generation time.

## Merge notes (for the user)

- `loop/fillet` touches `sidecar/builder.py` (+~150 lines) and `sidecar/server.py` (1 line).
  Your main tree has **uncommitted** edits to both files — expect small conflicts.
- The branch already contains the merged eval infrastructure (it merged `sindricad` cleanly).
- Ship gate satisfied: box_all/cyl_all regression stratum 0/60 with the fallback active.
