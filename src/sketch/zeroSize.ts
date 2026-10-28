// Shapes with no size. A 0x0 rectangle, a circle of radius 0, a line whose ends
// coincide: each draws NOTHING, and the geometry engine refuses the whole
// sketch over it (builder.py: "a rectangle in this sketch has a zero width or
// height"), so every extrude from that sketch fails. The user cannot give a size to, or delete, a thing they cannot see or
// click. Field 7ff177f8 (Paul): two clicks on one spot with the corner
// rectangle tool committed a 0x0 rectangle, which blocked both his extrudes.
import type { ResolvedEntity } from "./snap";

/** Under this, a size is not one anybody drew on purpose. The same floor the
 *  centre-rectangle tool already used for its own commit. */
export const MIN_SIZE_MM = 1e-4;

/** Does `e` have no size? Only the three kinds a two-click tool can collapse. */
export function isZeroSize(e: ResolvedEntity): boolean {
  if (e.type === "rectangle") return !(Math.abs(e.width) >= MIN_SIZE_MM && Math.abs(e.height) >= MIN_SIZE_MM);
  if (e.type === "circle") return !(Math.abs(e.radius) >= MIN_SIZE_MM);
  if (e.type === "line") return !(Math.hypot(e.x2 - e.x1, e.y2 - e.y1) >= MIN_SIZE_MM);
  return false;
}

/** Does constraint `c` name entity `id`, or a part of it (`id~k`)? Every
 *  constraint names its operands by plain string fields. */
export function constraintNames(c: object, id: string): boolean {
  return Object.values(c).some((v) => v === id || (typeof v === "string" && v.startsWith(`${id}~`)));
}

/** The shapes with no size that nothing refers to: safe to drop. One that a
 *  constraint names stays, because a size bound to a parameter arrives through a
 *  constraint, and a parameter set to 0 on purpose must not delete geometry. */
export function droppableZeroSize(entities: readonly ResolvedEntity[], constraints: readonly object[]): ResolvedEntity[] {
  return entities.filter((e) => isZeroSize(e) && !constraints.some((c) => constraintNames(c, e.id)));
}
