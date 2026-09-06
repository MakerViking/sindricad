// Saying WHY a dimension edit was refused, and withdrawing the trial that was
// refused.
//
// Reported 2026-09-05 (886da4e5): a circle tangent to two edges of a Fixed
// rectangle, with its own centre Fixed as well, cannot change size — the two
// tangencies plus the diameter already determine x, y and r, so pinning the
// centre is consistent at the current value and unsatisfiable the instant the
// value moves. Typing a new diameter turned every curve in the sketch red and
// said nothing, because a dimension edit was the one constraint-adding path
// that never went on trial: the unsatisfiable dim stayed in the sketch (and
// would have been committed by finish()), and red geometry was the only
// feedback.
//
// Two pieces live here rather than in SketchMode because SketchMode is not
// unit-testable (no test constructs it — see vitest.config.ts): the WORDING
// and the WITHDRAW decision, both pure.

import type { SketchConstraint } from "../types";
import { fmtLength, round } from "../ui/units";

/** Human name per constraint TYPE. Typed as a total Record so a constraint type
 *  added to the union without a name here fails the build rather than showing
 *  up in a user-facing sentence as `undefined`.
 *
 *  `constraintMenu`'s label table cannot be reused: it is keyed by the ribbon
 *  ACTION ("tangent") rather than by the stored constraint type ("tangent2"),
 *  and several actions share one type. */
export const CONSTRAINT_NAMES: Record<SketchConstraint["type"], string> = {
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  distance: "Length",
  diameter: "Diameter",
  p2pDistance: "Distance",
  p2pDistanceX: "Horizontal distance",
  p2pDistanceY: "Vertical distance",
  p2lDistance: "Distance to line",
  radialGap: "Radial gap",
  c2cDistance: "Rim-to-rim distance",
  c2lDistance: "Rim-to-line distance",
  p2cDistance: "Point-to-rim distance",
  tangent: "Tangent",
  tangent2: "Tangent",
  coincident: "Coincident",
  concentric: "Concentric",
  midpoint: "Midpoint",
  symmetric: "Symmetric",
  angle: "Angle",
  radius: "Radius",
  fix: "Fix",
  collinear: "Collinear",
  equalRadius: "Equal radius",
  offset: "Offset",
};

/** Every field on a constraint that names an entity. Read by field name rather
 *  than switched per type on purpose: this is used only to ask "is there a Fix
 *  on something this dimension governs", where a superset of operands is
 *  harmless and a missed one is a sentence that omits the real reason.
 *  (`offset` carries its operands in `pairs` and is deliberately not covered —
 *  a Fix on an offset copy is not a case this message has to explain.) */
const OPERAND_FIELDS = ["circle", "line", "e", "e1", "e2", "l1", "l2", "c1", "c2", "a", "b", "inner", "outer"];

function operandsOf(c: SketchConstraint): string[] {
  const rec = c as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const f of OPERAND_FIELDS) {
    const v = rec[f];
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/** "a and b", "a, b and c" — never an Oxford comma, matching the app's copy. */
function listPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What to say when a dimension edit came back unsatisfiable.
 *
 *  `blamed` is the solver's conflict set decoded to indices into `constraints`
 *  (the list that was SOLVED, dimension included). Two things it cannot tell
 *  us on its own, both measured on the reporter's sketch:
 *
 *  - it names the tangencies and the dimension but NOT the Fix the user added
 *    last (planegcs reports that one as merely redundant), so a Fix on the
 *    dimensioned entity is looked up directly here;
 *  - it can be entirely implicit ids (rect edges), decoding to an empty set,
 *    which is what the last-resort wording is for. */
export function dimConflictMsg(
  edited: SketchConstraint,
  blamed: Set<number>,
  constraints: SketchConstraint[],
  prevValue?: number,
): string {
  const what = (CONSTRAINT_NAMES[edited.type] ?? "dimension").toLowerCase();
  // No previous value means there was no dimension there to replace: the same
  // seam places NEW dimensions as well as retyping existing ones, and "I could
  // not change this diameter" is a lie about the first of those.
  const verb = prevValue == null ? "add" : "change";
  // An `angle` stores DEGREES and every other dimension millimetres (types.ts),
  // so a length format here would report 30° as "30 mm" — or "1.181 in" with the
  // display unit set to inches. Same split the inspector makes for a field.
  const fmtPrev = (v: number) => (edited.type === "angle" ? `${round(v)}°` : fmtLength(v));
  const left = prevValue == null ? "" : ` The dimension was left at ${fmtPrev(prevValue)}.`;

  const reasons: string[] = [];
  const targets = new Set(operandsOf(edited));
  if (constraints.some((k) => k.type === "fix" && targets.has(k.e))) {
    reasons.push(
      edited.type === "diameter" || edited.type === "radius"
        ? "its centre is fixed"
        : "one of its points is fixed",
    );
  }

  // What the solver actually blamed, by name, deduped and counted. The edited
  // dimension itself is always in there and is not a reason for its own refusal.
  const counts = new Map<string, number>();
  for (const i of [...blamed].sort((a, b) => a - b)) {
    const k = constraints[i];
    if (!k || k === edited) continue;
    const name = CONSTRAINT_NAMES[k.type];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const held = [...counts].map(([n, n2]) => (n2 === 1 ? `a ${n} constraint` : `${n2} ${n} constraints`));
  if (held.length) reasons.push(`it is held by ${listPhrase(held)}`);

  if (reasons.length === 0) {
    return `I could not ${verb} this ${what}: the new value conflicts with the constraints already on this sketch.${left}`;
  }
  return `I could not ${verb} this ${what}: ${listPhrase(reasons)}, so it cannot take the new value.${left}`;
}

/** The constraints a tool has just added, on trial until their solve comes back.
 *
 *  `restore` is what a DIMENSION edit needs and a constraint tool does not: the
 *  edit already dropped the dimension it replaced, so splicing out only the new
 *  one would leave the entity with no dimension at all — a second, silent loss.
 *  `msg` may be a function so the wording can name what the solver blamed, which
 *  is not known until the solve returns. */
export interface SketchTrial {
  cons: SketchConstraint[];
  msg: string | ((blamed: Set<number>, cons: SketchConstraint[]) => string);
  restore?: SketchConstraint[];
}

/** Undo a refused trial: the constraint list to go back to, and the one thing
 *  to say about it. Pure, so the withdraw rule can be tested against the real
 *  solver without constructing a SketchMode.
 *
 *  `current` is the list that was solved and `blamed` indexes into it. */
export function withdrawTrial(
  current: SketchConstraint[],
  trial: SketchTrial,
  blamed: Set<number>,
): { constraints: SketchConstraint[]; msg: string } {
  let constraints: SketchConstraint[];
  if (trial.restore) {
    constraints = trial.restore;
  } else {
    constraints = [...current];
    for (const c of trial.cons) {
      const i = constraints.lastIndexOf(c);
      if (i >= 0) constraints.splice(i, 1);
    }
  }
  const msg = typeof trial.msg === "function" ? trial.msg(blamed, current) : trial.msg;
  return { constraints, msg };
}
