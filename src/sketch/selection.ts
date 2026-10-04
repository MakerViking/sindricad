// What the sketch Select tool holds: whole entities, and single POINTS and
// SIDES of them (GH #17: "point-level selection"). A click on a line's end, a
// shape's corner or centre, or one side of a rectangle, polygon or slot takes
// THAT point or side, so the right-click menu can constrain it, rather than the
// whole entity, which named no operand at all for a shape.
//
// A selection KEY is a string, so the selection stays a Set<string>:
//
//   `e3`     the whole entity e3
//   `e3~2`   side 2 of rectangle, polygon or slot e3: the constraint operand
//            spelling every tool already uses (entityDims.lineOperand)
//   `e3@4`   point 4 of e3, numbered as dimRefPoints numbers it (a
//            rectangle's centre is 4, a polygon's -1, an arc's centre 2)
//
// A sketch POINT entity is a point already, so it is only ever its whole key.
// Selection keys live for the editing session and are never saved.
//
// Everything that acts on geometry (Delete, Move, Rotate, Mirror, Explode,
// construction, a body drag) acts on what a key belongs to, its OWNER: Delete
// with a rectangle's side selected deletes the rectangle.

export type SelPart =
  | { kind: "entity"; owner: string }
  | { kind: "side"; owner: string; side: string }
  | { kind: "point"; owner: string; p: number };

/** The key of point `p` of entity `id`. */
export const pointKey = (id: string, p: number): string => `${id}@${p}`;

/** What a selection key names. An id with neither marker is a whole entity;
 *  entity ids never carry `~` (it is the operand separator, see
 *  entityDims.lineOperand) and never carry `@` (sketch/id.ts). */
export function selPart(key: string): SelPart {
  const at = key.lastIndexOf("@");
  if (at > 0) {
    const p = Number(key.slice(at + 1));
    if (Number.isInteger(p)) return { kind: "point", owner: key.slice(0, at), p };
  }
  const t = key.indexOf("~");
  if (t > 0) return { kind: "side", owner: key.slice(0, t), side: key };
  return { kind: "entity", owner: key };
}

/** The entity a selection key belongs to. */
export const selOwner = (key: string): string => selPart(key).owner;

/** The entities the selection touches, whole or in part: what an operation on
 *  geometry acts on. */
export function selOwners(keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) out.add(selOwner(k));
  return out;
}

/** Add `key`, keeping one owner either WHOLE or as PARTS, never both: a whole
 *  entity replaces the points and sides of it already held, and a part
 *  replaces the whole. Both at once would hand the constraint menu the same
 *  geometry twice under two names. */
export function addKey(sel: Set<string>, key: string) {
  const owner = selOwner(key);
  const whole = key === owner;
  for (const k of [...sel]) {
    if (k !== key && selOwner(k) === owner && (whole || k === owner)) sel.delete(k);
  }
  sel.add(key);
}

/** Drop `id` from the selection, whole and every part of it. */
export function dropOwner(sel: Set<string>, id: string) {
  for (const k of [...sel]) if (selOwner(k) === id) sel.delete(k);
}

/** A click's effect on the selection: with Shift, Ctrl or Cmd it toggles
 *  `key` in or out and keeps the rest; without, `key` becomes the selection. */
export function clickKey(sel: Set<string>, key: string, additive: boolean) {
  if (!additive) {
    sel.clear();
    sel.add(key);
  } else if (sel.has(key)) {
    sel.delete(key);
  } else {
    addKey(sel, key);
  }
}

/** Whether a press adds to the selection rather than replacing it: Shift, or
 *  Ctrl (Cmd on macOS). */
export const additiveClick = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean =>
  e.shiftKey || e.ctrlKey || e.metaKey;
