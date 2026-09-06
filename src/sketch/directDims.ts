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
// it is also stated here once (drivingDimFor) for both editors to share — along
// with its two neighbours, which answer the same question from the other end:
// which constraint LOCKS a badge that has none (lockDimFor), which one already
// governs it (governingDimAt), and therefore what typing into it should do
// (planDimEdit).

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
 *  null = no constraint form for TYPING a value; the caller writes the number
 *  into the entity (rectangle W/H, slot width, polygon radius, line angle). A
 *  rectangle's extent does have a constraint form once it is locked — see
 *  lockDimFor and planDimEdit, which is what the callers ask. */
export function drivingDimFor(
  e: { type: ResolvedEntity["type"]; id: string },
  field: DimField,
  mm: number,
): SketchConstraint | null {
  if (e.type === "line" && field === "length") return { type: "distance", line: e.id, value: mm };
  if (e.type === "circle" && field === "diameter") return { type: "diameter", circle: e.id, value: mm };
  return null;
}

/** Which rectangle EDGES set a given extent: the two horizontal edges carry the
 *  width, the two vertical ones the height. A rectangle's implicit
 *  horizontal/vertical rules make either edge of a pair enough to fix that
 *  extent, so both count when asking whether the badge is governed. */
function rectEdgesFor(id: string, field: DimField): [string, string] | null {
  if (field === "width") return [`${id}~0`, `${id}~2`];
  if (field === "height") return [`${id}~3`, `${id}~1`];
  return null;
}

/** The constraint a "Lock dimension" on this badge should create — the driving
 *  form of what the badge currently measures.
 *
 *  A superset of drivingDimFor, and deliberately a SEPARATE function: typing a
 *  number into a rectangle's width still writes the width (that is how a
 *  rectangle has always been sized, and it is the one dimension that works with
 *  no solver at all), while LOCKING it is an explicit request for a constraint.
 *  A rectangle's extent has no dimension type of its own, so the lock is spelled
 *  as a `distance` on the edge that spans it — the same operand form the
 *  dimension tool already puts a p2lDistance on, which sketchSolve compiles via
 *  the rect-edge line registration.
 *
 *  null = this badge cannot be locked: the polygon radius and slot L/W are never
 *  compiled at all, so nothing can move them and a lock would mean nothing. */
export function lockDimFor(
  e: { type: ResolvedEntity["type"]; id: string },
  field: DimField,
  mm: number,
): SketchConstraint | null {
  const direct = drivingDimFor(e, field, mm);
  if (direct) return direct;
  if (e.type !== "rectangle") return null;
  const edges = rectEdgesFor(e.id, field);
  return edges ? { type: "distance", line: edges[0], value: mm } : null;
}

/** Is this badge's value governed by a driving constraint, and which one?
 *
 *  Three answers, because the badge has three honest states (see
 *  SketchDimensions.onEntityConstraint):
 *    a number → the index of the driving constraint that holds it
 *    "free"   → it COULD be governed and isn't: the badge is a live measurement
 *    null     → intrinsic; no constraint form exists either way
 *
 *  Report dff87040 is the gap between "free" and null: a rectangle's W/H
 *  answered null, so its badge rendered as a driving dimension while nothing
 *  drove it, and an Equal constraint was free to resize the rectangle out from
 *  under two dimensions the user had typed in himself. */
export function governingDimAt(
  constraints: SketchConstraint[],
  e: { type: ResolvedEntity["type"]; id: string },
  field: DimField,
): number | "free" | null {
  let governs: ((c: SketchConstraint) => boolean) | null = null;
  if (e.type === "line" && field === "length") {
    governs = (c) => c.type === "distance" && c.line === e.id;
  } else if (e.type === "circle" && field === "diameter") {
    governs = (c) => c.type === "diameter" && c.circle === e.id;
  } else if (e.type === "rectangle") {
    const edges = rectEdgesFor(e.id, field);
    if (edges) governs = (c) => c.type === "distance" && (c.line === edges[0] || c.line === edges[1]);
  }
  if (!governs) return null;
  const at = constraints.findIndex(governs);
  return at < 0 ? "free" : at;
}

/** What typing a value into an entity badge should do. One decision, in one
 *  place, because getting it wrong is silent: a direct write to a field a
 *  constraint governs looks like it worked and is undone by the next solve.
 *
 *  `moves` names the entity the solve should move to satisfy the new value —
 *  see sketchSolve's bias ("what you picked is what moves"). */
export type DimEdit =
  | { kind: "upsert"; c: SketchConstraint; moves: string }
  | { kind: "retype"; at: number }
  | { kind: "direct" };

export function planDimEdit(
  constraints: SketchConstraint[],
  e: { type: ResolvedEntity["type"]; id: string },
  field: DimField,
  mm: number,
): DimEdit {
  const dim = drivingDimFor(e, field, mm);
  if (dim) return { kind: "upsert", c: dim, moves: e.id };
  const at = governingDimAt(constraints, e, field);
  if (typeof at === "number") return { kind: "retype", at };
  return { kind: "direct" };
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
  const dim = isDimConstraint(c) && !c.id ? { ...c, id: replacedId ?? newConstraintId() } : c;
  return [...kept, dim];
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
      // A LOCKED rectangle extent is a distance on one of its edges ("R~0"), and
      // no entity carries that id — decode it, or a locked rectangle is the one
      // dimension that silently does nothing on a machine with no solver.
      const t = c.line.indexOf("~");
      if (t > 0) {
        const r = entities.find((x) => x.id === c.line.slice(0, t));
        const k = Number(c.line.slice(t + 1));
        if (r?.type !== "rectangle" || !(c.value > 0) || !Number.isInteger(k) || k < 0 || k > 3) continue;
        const field = k === 0 || k === 2 ? "width" : "height"; // 0/2 horizontal, 1/3 vertical
        if (Math.abs(r[field] - c.value) <= EPS) continue;
        r[field] = c.value;
        changed = true;
        continue;
      }
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
