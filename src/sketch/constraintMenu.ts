// WHICH constraints make sense for what is currently selected.
//
// GH #17: "The current constraint bar lacks visibility. Desired workflow: select
// points/lines to constrain, then a small menu showing ONLY the valid/possible
// constraints for that selection."
//
// The reporter asked for the menu to appear on releasing Ctrl. It is offered on
// RIGHT-CLICK instead, which is where this sketcher already puts per-selection
// actions (Delete, Break Link) — a new global meaning for "let go of a modifier"
// is a gesture that fires while you are doing something else, and Ctrl is
// already multi-select here.
//
// SCOPE, stated rather than implied. Only entities with ONE unambiguous operand
// are offered: a line IS a line, a circle IS a circle. A rectangle presents four
// line operands and none of its own (see constraintTools.operandAt and
// entityDims.lineOperandAt), so "make these parallel" has no answer until an
// EDGE is named — those keep the click-driven tools. Offering a guess there
// would apply a constraint to an edge the user never chose, which is the silent
// wrong-geometry class this codebase exists to avoid.
//
// Point-level constraints (coincident, midpoint, symmetric, fix) are not here
// either: the selection model holds ENTITIES, and those need a specific endpoint.

import type { ResolvedEntity } from "./snap";
import type { SketchTool } from "./sketchMode";
import { SKETCH, leavesOf } from "../ui/ribbon";

/** Menu label for a constraint, taken from the RIBBON's own table rather than a
 *  second list beside it. Two lists of the same names drift, and the ribbon is
 *  already the place this app names its tools — the split-button tooltips learnt
 *  that lesson when a hand-written string outlived the tools it described. */
const LABELS = new Map<string, string>();
for (const g of SKETCH) for (const it of g.items) for (const leaf of leavesOf(it)) {
  LABELS.set(leaf.action, leaf.label);
}
export const constraintLabel = (t: SketchTool): string => LABELS.get(t) ?? t;

/** The operand kind an entity contributes, or null when it is ambiguous. */
export type OperandKind = "line" | "round";

export function soleOperand(e: ResolvedEntity): OperandKind | null {
  if (e.type === "line") return "line";
  if (e.type === "circle" || e.type === "arc") return "round";
  // rectangle / polygon / slot: several operands, none of them the entity
  // spline / text / point / projected: not a line or round operand at all
  return null;
}

/** Constraints applicable to this selection, in the order they are worth
 *  offering — commonest first, which is what the reporter asked for ("ordered by
 *  likelihood of use"). Empty when the selection cannot carry any. */
export function applicableConstraints(sel: ResolvedEntity[]): SketchTool[] {
  const kinds = sel.map(soleOperand);
  if (kinds.some((k) => k === null)) return []; // any ambiguous member disqualifies the set

  if (sel.length === 1) {
    // A lone line can be squared to an axis. Nothing useful applies to a lone
    // circle: its radius needs a VALUE, which is a dimension, not a constraint.
    return kinds[0] === "line" ? ["horizontal", "vertical"] : [];
  }
  if (sel.length !== 2) return [];

  const [a, b] = kinds;
  if (a === "line" && b === "line") {
    // parallel and perpendicular are the everyday pair; collinear is rarer and
    // destructive-looking, so it sits last
    return ["parallel", "perpendicular", "equal", "collinear"];
  }
  if (a === "round" && b === "round") return ["concentric", "equal", "tangent"];
  return ["tangent"]; // one line, one round
}
