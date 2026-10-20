// Headless re-solve of a CLOSED sketch after a parameter edit changed one of
// its dimension-constraint values. The open sketch handles itself live
// (SketchMode.syncParamValues); this runs for every other affected sketch so a
// param-driven dim actually moves geometry instead of being decorative.
//
// Failure semantics (plan R2, amended for report X-param-refuse): a solve
// that reports conflicts keeps the OLD coordinates and hands the caller the
// solver's blamed constraint indices (via `onConflict`), decoded the same way
// the open-sketch trial does (sketchMode.ts's parseConflictIdx) — the caller
// (DocumentStore.commitDraft) uses that to refuse the whole parameter
// edit rather than silently leaving one sketch behind. A solve that merely
// crashed has nothing to blame and still resolves to a bare null.
//
// One failure is NOT a conflict, and must stay distinguishable: the solver's
// WASM never came up at all (SolverUnavailable — our CSP, and the 0.1.100
// WebView2 reports). Nothing on that machine will ever satisfy the
// constraint, so a typed length or diameter has to be written into the
// geometry directly (directDims) instead of waiting for a solve that cannot
// happen. Flattening it to the same null hid that from
// DocumentStore.setSketchDimension, which is how the inspector's fallback
// ended up unreachable on exactly those machines. It propagates.

import type { Feature, Params, SketchEntity } from "../types";
import { compileAndSolve, constraintIndexOf, type BoundFields } from "./sketchSolve";
import { resolveRealEntities, toSketchEntity } from "./resolve";
import { SolverUnavailable } from "./solver";

/** planegcs conflict ids decoded to indices into the constraint list that was
 *  solved; implicit ids (rect edges, the drag pin) decode to null and are
 *  skipped — the same decode sketchMode.ts's (private) parseConflictIdx does
 *  for the open-sketch trial. */
function parseConflictIdx(ids: string[]): Set<number> {
  const s = new Set<number>();
  for (const id of ids) {
    const i = constraintIndexOf(id);
    if (i !== null) s.add(i);
  }
  return s;
}

export async function solveSketchFeature(
  sketch: Extract<Feature, { type: "sketch" }>,
  params: Params,
  bound?: BoundFields,
  onConflict?: (blamed: Set<number>) => void,
): Promise<{ entities: SketchEntity[] } | null> {
  try {
    const entities = resolveRealEntities(sketch, params);
    const r = await compileAndSolve(entities, sketch.constraints ?? [], undefined, undefined, undefined, bound);
    if (!r.ok || r.conflicts.length > 0) {
      onConflict?.(parseConflictIdx(r.conflicts));
      return null;
    }
    return { entities: r.entities.map(toSketchEntity) };
  } catch (err) {
    if (err instanceof SolverUnavailable) throw err; // no solver at all — the caller decides
    return null; // solver crashed — keep old coordinates
  }
}
