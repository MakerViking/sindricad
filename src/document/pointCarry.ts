// Where an extrude's start or up-to reference goes (types.ts ExtrudeRef) when
// an edit renames what it names in a sketch: a shape exploded or trimmed into
// lines with new ids, or a polygon's corners and sides renumbered by a new side
// count. Apart from store.ts so that numFields.ts, which re-aims on a side
// count set from the parameter table, reaches it without importing the store.

import type { CadDocument, ExtrudeStart } from "../types";
import { polygonRenumber } from "../sketch/entityDims";

/** What edits inside a sketch renamed: entity id, then what a reference names
 *  on it, then what that is now. A point, keyed by its index, is a point of
 *  `entity` now (`pointIndex`). A line, keyed by what follows the id in the
 *  reference's own (`~<k>` for side k of a shape, `<shapeId>~<k>`, and "" for
 *  the entity itself), is the line `entity` now, with no `pointIndex`.
 *  Travels with the sketch's commit like RegionCarry. */
export type PointCarry = Record<string, Record<string, { entity: string; pointIndex?: number }>>;

/** Where `carry` sends point `pointIndex` of `entity`, or with no index the
 *  line `entity` names; undefined when it does not move it. */
function carried(carry: PointCarry, entity: string, pointIndex?: number) {
  if (pointIndex !== undefined) {
    const to = carry[entity]?.[String(pointIndex)];
    return to?.pointIndex !== undefined ? to : undefined;
  }
  const cut = entity.indexOf("~");
  const to = cut < 0 ? carry[entity]?.[""] : carry[entity.slice(0, cut)]?.[entity.slice(cut)];
  return to?.pointIndex === undefined ? to : undefined;
}

/** `carry`, then `next`, an edit made after it in the same session, as one:
 *  what `carry` moved goes on to wherever `next` moves that, and what `next`
 *  moves that `carry` left alone is added. Trimming two sides of a rectangle
 *  in a row needs it: the second trim retires a line the first one made. */
export function composePointCarry(carry: PointCarry, next: PointCarry): PointCarry {
  const out: PointCarry = {};
  for (const [id, keys] of Object.entries(carry)) {
    out[id] = Object.fromEntries(
      Object.entries(keys).map(([k, to]) => [k, carried(next, to.entity, to.pointIndex) ?? to]),
    );
  }
  // a key `carry` has for the same id keeps its meaning: the id named the
  // shape there (Explode keeps it on the first line), not what holds it now
  for (const [id, keys] of Object.entries(next)) out[id] = { ...keys, ...out[id] };
  return out;
}

/** Re-point every extrude that starts from or runs up to something `carry`
 *  renamed in sketch `sketchId`. EVERY extrude in the document, not only those
 *  built on that sketch: the profile is usually on another one. */
export function applyPointCarry(d: CadDocument, sketchId: string, carry: PointCarry) {
  const moved = (ref: ExtrudeStart | undefined) => {
    if (ref?.kind === "sketchPoint" && ref.sketch === sketchId) {
      const to = carried(carry, ref.entity, ref.pointIndex);
      return to?.pointIndex !== undefined ? { ...ref, entity: to.entity, pointIndex: to.pointIndex } : null;
    }
    if (ref?.kind === "sketchLine" && ref.sketch === sketchId) {
      const to = carried(carry, ref.entity);
      return to ? { ...ref, entity: to.entity } : null;
    }
    return null;
  };
  d.features = d.features.map((f) => {
    if (f.type !== "extrude") return f;
    const start = moved(f.startFrom), end = moved(f.upToRef);
    if (!start && !end) return f;
    return { ...f, ...(start ? { startFrom: start } : {}), ...(end ? { upToRef: end } : {}) };
  });
}

/** What polygon `polyId`'s side count going from `was` to `now` does to a
 *  reference on it: corner k and side k go where rebindPolygonSides sends a
 *  constraint's, so an extrude up to a hexagon's corner 1 is still up to the
 *  corner at 60 degrees when it becomes a dodecagon (its corner 2). Its
 *  centre is not renumbered. */
export function polygonSidesCarry(polyId: string, was: number, now: number): PointCarry {
  const to = polygonRenumber(was, now);
  const keys: PointCarry[string] = {};
  for (let k = 0; k < Math.max(3, Math.round(was)); k++) {
    keys[k] = { entity: polyId, pointIndex: to.corner(k) };
    keys[`~${k}`] = { entity: `${polyId}~${to.side(k)}` };
  }
  return { [polyId]: keys };
}
