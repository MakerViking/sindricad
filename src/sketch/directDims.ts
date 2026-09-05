// Writing a driving length / diameter straight into the geometry, for machines
// with no constraint solver.
//
// A line's length and a circle's diameter are the only two sketch dimensions
// that go through a solver constraint rather than editing coordinates (see
// SketchMode.editDimension; rectangle W/H and line angle are direct writes). So
// where the solver's WASM will not start, those two were the only dimensions
// that silently did NOTHING: the constraint was recorded, never solved, and the
// shape kept the size it was drawn at. That is exactly how it reached us, from a
// Windows user on 0.1.100 whose WebView2 refused to compile WebAssembly:
// "when creating a circle I am unable to put in a new value for the dimension.
// Other shapes seem to work fine."
//
// This is a stand-in, not a solver. The constraints are left in place, so once a
// real solver is available it drives the geometry properly and a sketch authored
// here is indistinguishable from one authored on a working machine.
//
// Because "which dimensions are constraints" is the fact this file is built on,
// it is also stated here once (drivingDimFor) for both editors to share.

import type { ResolvedEntity } from "./snap";
import type { DimField, SketchConstraint } from "../types";
import { isDimConstraint, newConstraintId } from "./id";

const EPS = 1e-9;

/** Which entity dimension edits through a DRIVING solver constraint rather than
 *  by writing coordinates, and what that constraint is. The single definition
 *  of that rule: SketchMode.editDimension (in-canvas label) and
 *  DocumentStore.setSketchDimension (the inspector, sketch closed) both ask
 *  here, because two copies would drift and the difference is visible — a raw
 *  radius write is a free variable to the solver and gets solved straight back
 *  out, while a driving diameter holds the typed value and moves whatever is
 *  attached to it.
 *
 *  null = no constraint form; the caller writes the number into the entity
 *  (rectangle W/H, slot width, polygon radius, line angle). */
export function drivingDimFor(
  e: { type: ResolvedEntity["type"]; id: string },
  field: DimField,
  mm: number,
): SketchConstraint | null {
  if (e.type === "line" && field === "length") return { type: "distance", line: e.id, value: mm };
  if (e.type === "circle" && field === "diameter") return { type: "diameter", circle: e.id, value: mm };
  return null;
}

/** Add-or-replace one of the above on a constraint list, returning a new array.
 *  A replacement inherits the replaced dim's id so a parameter binding survives
 *  retyping the dimension (same rule as SketchMode.setDrivingDimension, whose
 *  dedup covers every other dimension kind as well). */
export function upsertDrivingDim(constraints: SketchConstraint[], c: SketchConstraint): SketchConstraint[] {
  const sameTarget = (k: SketchConstraint): boolean =>
    (c.type === "distance" && k.type === "distance" && k.line === c.line) ||
    (c.type === "diameter" && k.type === "diameter" && k.circle === c.circle);
  let replacedId: string | undefined;
  const kept = constraints.filter((k) => {
    if (!sameTarget(k)) return true;
    if (isDimConstraint(k) && k.id) replacedId = k.id;
    return false;
  });
  if (isDimConstraint(c) && !c.id) c.id = replacedId ?? newConstraintId();
  return [...kept, c];
}

/** Apply what can be applied without solving. Mutates `entities` in place and
 *  returns true if anything actually moved.
 *
 *  Only single-entity dimensions are handled. Anything relating two entities
 *  (point-to-point, radial gap, angle between lines) needs a solve to decide
 *  WHICH end moves, and guessing would put geometry somewhere the user never
 *  asked for. Those stay unapplied rather than applied wrongly. */
export function applyDrivingDimsDirect(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
): boolean {
  let changed = false;
  for (const c of constraints) {
    if (c.type === "diameter") {
      const e = entities.find((x) => x.id === c.circle);
      if (e?.type !== "circle" || !(c.value > 0)) continue;
      if (Math.abs(e.radius - c.value / 2) <= EPS) continue;
      e.radius = c.value / 2;
      changed = true;
    } else if (c.type === "distance") {
      const e = entities.find((x) => x.id === c.line);
      if (e?.type !== "line" || !(c.value > 0)) continue;
      const dx = e.x2 - e.x1;
      const dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy);
      // a zero-length line has no direction to grow along; leave it alone
      if (len <= EPS || Math.abs(len - c.value) <= EPS) continue;
      // Hold the start and slide the end along the existing direction. With no
      // solver there is nothing to say the other end should move, and this is
      // the least surprising of the two.
      e.x2 = e.x1 + (dx / len) * c.value;
      e.y2 = e.y1 + (dy / len) * c.value;
      changed = true;
    }
  }
  return changed;
}
