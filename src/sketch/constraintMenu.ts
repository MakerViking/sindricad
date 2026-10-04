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
// SCOPE, stated rather than implied. Only members with ONE unambiguous operand
// are offered: a line IS a line, a circle IS a circle, a sketch point IS a
// point. A rectangle, polygon or slot presents several line operands and
// several points and none of its own, so "make these parallel" has no answer
// until a SIDE is named. The right-click names one: on the shape it lands on,
// the corner or centre under the cursor, or else the side (operandUnder). Any
// other shape in the selection stays unnamed, and an unnamed member empties
// the menu: offering a guess there would apply a constraint to a side the user
// never chose, which is the silent wrong-geometry class this codebase exists
// to avoid.
//
// Point-level constraints need a specific point. A sketch point is one, and so
// is a shape's corner or centre named by the right-click; a line's END is not
// offered, since the selection holds whole lines (those keep the tools).

import type { ResolvedEntity } from "./snap";
import type { SketchTool } from "./sketchMode";
import { SKETCH, leavesOf } from "../ui/ribbon";
import { dimRefPoints, lineOperandAt } from "./entityDims";
import { isOriginGeometry } from "./origin";

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
export type OperandKind = "line" | "round" | "point";

export function soleOperand(e: ResolvedEntity): OperandKind | null {
  if (e.type === "line") return "line";
  if (e.type === "circle" || e.type === "arc") return "round";
  if (e.type === "point") return "point"; // the origin is one too
  // rectangle / polygon / slot: several operands, none of them the entity
  // (operandUnder names one); spline / text / projected: no operand at all
  return null;
}

/** One member of the selection as the operand it hands a constraint. */
export interface MenuOperand {
  kind: OperandKind;
  /** the id the constraint names: the entity's, or a side's (`R~2`) */
  id: string;
  /** which of the entity's points, for a point (dimRefPoints numbering) */
  p: number;
  /** the entity it belongs to: the one a solve should move when it is first */
  ent: ResolvedEntity;
}

const isShape = (e: ResolvedEntity) => e.type === "rectangle" || e.type === "polygon" || e.type === "slot";

/** The operand a right-click at `at` names on `e`: for a rectangle, polygon or
 *  slot, its corner or centre within `tol` (the nearest), or else the side
 *  under the cursor; for anything else its sole operand. Null where it names
 *  none, as on a slot's round end. Points first, as every point tool picks. */
export function operandUnder(e: ResolvedEntity, at: { x: number; y: number }, tol: number): MenuOperand | null {
  if (!isShape(e)) {
    const kind = soleOperand(e);
    return kind ? { kind, id: e.id, p: 0, ent: e } : null;
  }
  let best: { p: number; d: number } | null = null;
  for (const r of dimRefPoints(e)) {
    const d = Math.hypot(r.pos.x - at.x, r.pos.y - at.y);
    if (d <= tol && (!best || d < best.d)) best = { p: r.p, d };
  }
  if (best) return { kind: "point", id: e.id, p: best.p, ent: e };
  const side = lineOperandAt(e, at);
  return side ? { kind: "line", id: side, p: 0, ent: e } : null;
}

/** The selection as operands: `named` gives the operand for the member the
 *  right-click landed on, every other member gives its sole one. Null when any
 *  member has none, which empties the menu. */
export function menuOperands(sel: ResolvedEntity[], named?: MenuOperand | null): MenuOperand[] | null {
  const out: MenuOperand[] = [];
  for (const e of sel) {
    if (named && named.ent.id === e.id) { out.push(named); continue; }
    const kind = soleOperand(e);
    if (!kind) return null;
    out.push({ kind, id: e.id, p: 0, ent: e });
  }
  return out;
}

/** Constraints applicable to this selection, in the order they are worth
 *  offering — commonest first, which is what the reporter asked for ("ordered by
 *  likelihood of use"). Empty when the selection cannot carry any. `named` is
 *  the operand the right-click named on the shape it landed on (operandUnder). */
export function applicableConstraints(sel: ResolvedEntity[], named?: MenuOperand | null): SketchTool[] {
  const ops = menuOperands(sel, named);
  if (!ops) return []; // any ambiguous member disqualifies the set
  const [a, b] = ops;
  if (!a) return [];

  if (ops.length === 1) {
    // A lone line can be squared to an axis, unless it is a rectangle's side,
    // which its rectangle already holds square. A lone point can be fixed
    // where it is, unless it is the origin, which is fixed already. Nothing
    // useful applies to a lone circle: its radius needs a VALUE, which is a
    // dimension, not a constraint.
    if (a.kind === "line") return a.ent.type === "rectangle" ? [] : ["horizontal", "vertical"];
    if (a.kind === "point") return isOriginGeometry(a.ent.id) ? [] : ["fix"];
    return [];
  }
  if (ops.length !== 2 || !b) return [];
  // Two operands of ONE shape (its corner and its own side, two of its
  // corners) is the self-reference the tools refuse: it folds the shape.
  if (a.ent.id === b.ent.id) return [];
  // two points join; a point and a curve: the point goes ON it, or, on a
  // line, to its middle
  if (a.kind === "point" && b.kind === "point") return ["coincident"];
  if (a.kind === "point" || b.kind === "point") {
    const curve = a.kind === "point" ? b : a;
    return curve.kind === "line" ? ["coincident", "midpoint"] : ["coincident"];
  }
  if (a.kind === "line" && b.kind === "line") {
    // parallel and perpendicular are the everyday pair; collinear is rarer and
    // destructive-looking, so it sits last
    return ["parallel", "perpendicular", "equal", "collinear"];
  }
  if (a.kind === "round" && b.kind === "round") return ["concentric", "equal", "tangent"];
  return ["tangent"]; // one line, one round
}
