// Headless re-solve of a CLOSED sketch after a parameter edit changed one of
// its dimension-constraint values. The open sketch handles itself live
// (SketchMode.syncParamValues); this runs for every other affected sketch so a
// param-driven dim actually moves geometry instead of being decorative.
//
// Failure semantics (plan R2): a solve that fails or reports conflicts keeps
// the OLD coordinates — the param edit still lands, and the caller surfaces
// the sketch id so the user hears about it (never blocks the edit).

import type { Feature, Params, SketchEntity } from "../types";
import { compileAndSolve } from "./sketchSolve";
import { resolveRealEntities, toSketchEntity } from "./resolve";

export async function solveSketchFeature(
  sketch: Extract<Feature, { type: "sketch" }>,
  params: Params,
): Promise<{ entities: SketchEntity[] } | null> {
  try {
    const entities = resolveRealEntities(sketch, params);
    const r = await compileAndSolve(entities, sketch.constraints ?? []);
    if (!r.ok || r.conflicts.length > 0) return null;
    return { entities: r.entities.map(toSketchEntity) };
  } catch {
    return null; // solver unavailable/crashed — keep old coordinates
  }
}
