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
// is a shape's corner or centre named by the right-click. Since GH #17's
// point-level selection a click in the Select tool takes a single point (a
// line's end, a corner, a centre) or a single side of a shape too
// (selection.ts), and each of those is the operand it names: the selection is
// read KEY by key, not entity by entity.

import type { ResolvedEntity } from "./snap";
import type { SketchTool } from "./sketchMode";
import { SKETCH, leavesOf } from "../ui/ribbon";
import { dimRefPoints, lineOperand, lineOperandAt } from "./entityDims";
import { splineTangentFor } from "./constraintTools";
import { isOriginGeometry } from "./origin";
import { selPart } from "./selection";

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
export type OperandKind = "line" | "round" | "point" | "spline";

export function soleOperand(e: ResolvedEntity): OperandKind | null {
  if (e.type === "line") return "line";
  if (e.type === "circle" || e.type === "arc") return "round";
  if (e.type === "point") return "point"; // the origin is one too
  // a spline is an operand of Tangent alone, at the end where it meets the
  // other member (splineTangentFor)
  if (e.type === "spline") return "spline";
  // rectangle / polygon / slot: several operands, none of them the entity
  // (operandUnder names one); text / projected: no operand at all
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

/** The selection as operands, one per selection KEY (selection.ts): a side's
 *  key is that side, a point's key that point, and a whole entity gives its
 *  sole operand, or, for the shape the right-click landed on, the operand it
 *  `named` there. Null when any member has none, which empties the menu. */
export function menuOperands(
  keys: Iterable<string>,
  byId: Map<string, ResolvedEntity>,
  named?: MenuOperand | null,
): MenuOperand[] | null {
  const out: MenuOperand[] = [];
  for (const key of keys) {
    const part = selPart(key);
    const ent = byId.get(part.owner);
    if (!ent) return null;
    if (part.kind === "side") {
      if (!lineOperand(byId, key)) return null;
      out.push({ kind: "line", id: key, p: 0, ent });
    } else if (part.kind === "point") {
      if (!dimRefPoints(ent).some((r) => r.p === part.p)) return null;
      out.push({ kind: "point", id: ent.id, p: part.p, ent });
    } else if (named && named.ent.id === ent.id) {
      out.push(named);
    } else {
      const kind = soleOperand(ent);
      if (!kind) return null;
      out.push({ kind, id: ent.id, p: 0, ent });
    }
  }
  return out;
}

/** side k of an operand id `R~k` */
const sideIndex = (id: string) => Number(id.slice(id.indexOf("~") + 1));

/** The two points and the line of a Symmetric, in selection order, or null:
 *  exactly two points and one line, the line belonging to neither point's
 *  entity (a line's own ends about itself, a corner about its own side). Two
 *  corners of ONE rectangle are the useful pick: "centre it on this line". */
export function symmetricOperands(ops: MenuOperand[]): { a: MenuOperand; b: MenuOperand; line: MenuOperand } | null {
  const pts = ops.filter((o) => o.kind === "point");
  const line = ops.find((o) => o.kind === "line");
  const [a, b] = pts;
  if (ops.length !== 3 || !a || !b || !line) return null;
  if (line.ent.id === a.ent.id || line.ent.id === b.ent.id) return null;
  return { a, b, line };
}

/** What two operands can take. Two of ONE entity are the self-reference the
 *  tools refuse (a corner on its own side, two corners joined, which folds the
 *  shape), with one exception: two adjacent sides of a rectangle, which Equal
 *  makes a square (its opposite sides are equal already). */
function pairConstraints(a: MenuOperand, b: MenuOperand): SketchTool[] {
  if (a.ent.id === b.ent.id) {
    const adjacent = a.ent.type === "rectangle" && a.kind === "line" && b.kind === "line" &&
      Math.abs(sideIndex(a.id) - sideIndex(b.id)) % 2 === 1;
    return adjacent ? ["equal"] : [];
  }
  // A spline only goes Tangent, and only where one of its ends already meets
  // the other curve: offered when the tool would make it, not to be refused.
  if (a.kind === "spline" || b.kind === "spline") {
    const [sp, other] = a.kind === "spline" ? [a, b] : [b, a];
    const pick = (o: MenuOperand) => ({ id: o.id, ent: o.ent, at: dimRefPoints(o.ent)[0]?.pos ?? { x: 0, y: 0 } });
    const made = splineTangentFor(pick(sp), pick(other), [a.ent, b.ent]);
    return "c" in made ? ["tangent"] : [];
  }
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

/** Constraints applicable to these operands (menuOperands), in the order they
 *  are worth offering: commonest first, which is what the reporter asked for
 *  ("ordered by likelihood of use"). Empty when the selection cannot carry
 *  any. */
export function applicableConstraints(ops: MenuOperand[]): SketchTool[] {
  const [a, b] = ops;
  if (!a) return [];

  if (ops.length === 1) {
    // A lone line can be squared to an axis, unless it is a rectangle's side,
    // which its rectangle already holds square. A lone point can be fixed
    // where it is, unless it is the origin's, which is fixed already, or a
    // projected one, which is fixed reference. Nothing useful applies to a
    // lone circle: its radius needs a VALUE, which is a dimension, not a
    // constraint.
    if (a.kind === "line") return a.ent.type === "rectangle" ? [] : ["horizontal", "vertical"];
    if (a.kind === "point") return isOriginGeometry(a.ent.id) || a.ent.type === "projected" ? [] : ["fix"];
    return [];
  }
  if (ops.length === 2 && b) return pairConstraints(a, b);
  if (symmetricOperands(ops)) return ["symmetric"];
  // Several lines, or several circles and arcs, of different entities: Equal
  // holds them all to one size (GH #17: "several circles, then Equal: the
  // menu is limited to pairs").
  const owners = new Set(ops.map((o) => o.ent.id));
  if (owners.size !== ops.length) return [];
  if (ops.every((o) => o.kind === "line") || ops.every((o) => o.kind === "round")) return ["equal"];
  return [];
}
