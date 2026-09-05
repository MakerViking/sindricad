// Headless re-solve of a CLOSED sketch after a parameter edit changed one of
// its dimension-constraint values. The open sketch handles itself live
// (SketchMode.syncParamValues); this runs for every other affected sketch so a
// param-driven dim actually moves geometry instead of being decorative.
//
// Failure semantics (plan R2): a solve that fails or reports conflicts keeps
// the OLD coordinates — the param edit still lands, and the caller surfaces
// the sketch id so the user hears about it (never blocks the edit).
//
// One failure is NOT that, and must stay distinguishable: the solver's WASM
// never came up at all (SolverUnavailable — our CSP, and the 0.1.100 WebView2
// reports). Nothing on that machine will ever satisfy the constraint, so a
// typed length or diameter has to be written into the geometry directly
// (directDims) instead of waiting for a solve that cannot happen. Flattening it
// to the same null hid that from DocumentStore.setSketchDimension, which is how
// the inspector's fallback ended up unreachable on exactly those machines. It
// propagates; every other failure still resolves to null.

import type { Feature, Params, SketchEntity } from "../types";
import { compileAndSolve } from "./sketchSolve";
import { resolveRealEntities, toSketchEntity } from "./resolve";
import { SolverUnavailable } from "./solver";

export async function solveSketchFeature(
  sketch: Extract<Feature, { type: "sketch" }>,
  params: Params,
): Promise<{ entities: SketchEntity[] } | null> {
  try {
    const entities = resolveRealEntities(sketch, params);
    const r = await compileAndSolve(entities, sketch.constraints ?? []);
    if (!r.ok || r.conflicts.length > 0) return null;
    return { entities: r.entities.map(toSketchEntity) };
  } catch (err) {
    if (err instanceof SolverUnavailable) throw err; // no solver at all — the caller decides
    return null; // solver crashed — keep old coordinates
  }
}
