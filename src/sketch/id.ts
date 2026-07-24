// Stable per-entity identity for the sketcher. Constraints reference entities by
// id (never array index), so modify operations that reorder/split/remove
// entities can't silently repoint a constraint at the wrong geometry.
//
// Ids are a monotonic per-session counter shared by all families (`e0`, `p1`,
// `c2`, …). When a sketch is loaded, each family's note() bumps the counter past
// any saved ids so freshly created objects never collide with persisted ones.

import type { SketchConstraint } from "../types";

let counter = 0;

function idFamily(prefix: string) {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  return {
    next: (): string => `${prefix}${counter++}`,
    /** Reserve a loaded id so future next() calls won't reuse it. */
    note: (id: string | undefined): void => {
      if (!id) return;
      const m = re.exec(id);
      if (m) counter = Math.max(counter, Number(m[1]) + 1);
    },
  };
}

const entity = idFamily("e");
export const newEntityId = entity.next;
export const noteEntityId = entity.note;

/** Pattern ids: `p` prefix, so a pattern id and its derived entities ("p3#0")
 *  never collide with entity ids ("e3"). */
const pattern = idFamily("p");
export const newPatternId = pattern.next;
export const notePatternId = pattern.note;

/** Constraint ids (dimension constraints only): the stable identity a parameter
 *  binding references — the constraint array itself is spliced by edits. */
const constraint = idFamily("c");
export const newConstraintId = constraint.next;
export const noteConstraintId = constraint.note;

/** A dimension (value-bearing) constraint — the ones that carry a stable c-id.
 *  The single definition of the concept; the load migration and the editor both
 *  stamp through this predicate. */
export function isDimConstraint(c: SketchConstraint): c is SketchConstraint & { id?: string; value: number } {
  return "value" in c;
}
