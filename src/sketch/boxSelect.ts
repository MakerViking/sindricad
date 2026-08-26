// Box (marquee) selection for the sketch — GH #17: "Add box/rectangle selection
// to easily select and delete multiple elements at once."
//
// Two modes, and which one you get is decided by the DIRECTION you drag, the
// convention every mainstream CAD shares:
//
//   left → right   WINDOW    only entities entirely inside the box
//   right → left   CROSSING  anything the box touches
//
// That is not decoration. Selecting a few whole entities out of a dense sketch
// and selecting everything that passes through a region are different jobs, and
// making the drag direction choose means neither needs a modifier key.
//
// The test is done on the same tessellated segments everything else in the
// sketcher measures with (`entitySegments`), so what the box selects agrees with
// what the tracer, the checker and the picker think the geometry is.

import * as THREE from "three";
import { entitySegments, segCross } from "./region";
import type { ResolvedEntity } from "./snap";

export type BoxMode = "window" | "crossing";

export interface SelBox {
  min: THREE.Vector2;
  max: THREE.Vector2;
  mode: BoxMode;
}

/** Normalise a drag into a box + its mode. `from` is where the press landed. */
export function boxFromDrag(from: THREE.Vector2, to: THREE.Vector2): SelBox {
  return {
    min: new THREE.Vector2(Math.min(from.x, to.x), Math.min(from.y, to.y)),
    max: new THREE.Vector2(Math.max(from.x, to.x), Math.max(from.y, to.y)),
    // dragging leftwards is a CROSSING box, exactly as in mainstream CAD
    mode: to.x < from.x ? "crossing" : "window",
  };
}

const inside = (p: { x: number; y: number }, b: SelBox): boolean =>
  p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y;

/** The four edges of the box, as segments. */
function boxEdges(b: SelBox): [THREE.Vector2, THREE.Vector2][] {
  const { min, max } = b;
  const bl = new THREE.Vector2(min.x, min.y);
  const br = new THREE.Vector2(max.x, min.y);
  const tr = new THREE.Vector2(max.x, max.y);
  const tl = new THREE.Vector2(min.x, max.y);
  return [[bl, br], [br, tr], [tr, tl], [tl, bl]];
}

/** Does this entity qualify under the box's mode? */
export function entityInBox(e: ResolvedEntity, b: SelBox): boolean {
  const segs = entitySegments(e);
  if (!segs.length) {
    // Entities with no traceable outline — a sketch POINT, and text, whose
    // glyphs are not tessellated here. A point is its own position; text is
    // deliberately left out rather than guessed at from a bounding box that
    // would grab it from across the sketch.
    if (e.type === "point") return inside(e, b);
    return false;
  }
  if (b.mode === "window") {
    // EVERY sampled point inside. Testing only the endpoints would let a curve
    // that bulges out of the box count as fully contained — an arc between two
    // points inside the box can leave it entirely.
    return segs.every(([p, q]) => inside(p, b) && inside(q, b));
  }
  // crossing: any point inside, or any segment cutting a box edge
  for (const [p, q] of segs) {
    if (inside(p, b) || inside(q, b)) return true;
    for (const [a, c] of boxEdges(b)) if (segCross({ x1: p.x, y1: p.y, x2: q.x, y2: q.y }, { x1: a.x, y1: a.y, x2: c.x, y2: c.y })) return true;
  }
  return false;
}

/** Ids of every entity the box selects. */
export function entitiesInBox(ents: ResolvedEntity[], b: SelBox): string[] {
  return ents.filter((e) => entityInBox(e, b)).map((e) => e.id);
}
