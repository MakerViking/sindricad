// Sketch modify operations on resolved entities: pick, trim, fillet-corner.
// These mutate the entity list (returning a new one); the sketcher rebuilds.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import { entitySegments } from "./region";
import { newEntityId } from "./id";
import {
  segIntersect,
  segCircleIntersect,
  lineIntersect,
  paramOnSeg,
  distToSeg,
} from "./geom2d";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

/** index of the entity whose curve is nearest p within tol, else -1 */
export function pickEntity(
  ents: ResolvedEntity[],
  p: THREE.Vector2,
  tol: number,
): number {
  let best = -1;
  let bestD = tol;
  ents.forEach((e, i) => {
    const d = distToEntity(e, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function distToEntity(e: ResolvedEntity, p: THREE.Vector2): number {
  if (e.type === "circle") return Math.abs(v(e.x, e.y).distanceTo(p) - e.radius);
  // line/rect/arc/spline: nearest of the shared tessellated segments
  let d = Infinity;
  for (const [a, b] of entitySegments(e)) d = Math.min(d, distToSeg(a, b, p));
  return d;
}

/**
 * Trim: remove the clicked portion of a line up to its nearest intersections.
 * Non-line entities (or lines with no crossing) are deleted whole.
 */
export function trimEntity(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] {
  const e = ents[index];
  if (e.type !== "line") return ents.filter((_, i) => i !== index);

  const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
  const params = new Set<number>([0, 1]);
  ents.forEach((o, i) => {
    if (i === index) return;
    const hits: THREE.Vector2[] = [];
    if (o.type === "circle") hits.push(...segCircleIntersect(p1, p2, v(o.x, o.y), o.radius));
    else for (const [a, b] of entitySegments(o)) {
      const x = segIntersect(p1, p2, a, b);
      if (x) hits.push(x);
    }
    for (const h of hits) {
      const t = paramOnSeg(p1, p2, h);
      if (t > 1e-4 && t < 1 - 1e-4) params.add(t);
    }
  });

  const sorted = [...params].sort((a, b) => a - b);
  if (sorted.length <= 2) return ents.filter((_, i) => i !== index); // no crossing → delete

  const tc = Math.max(0, Math.min(1, paramOnSeg(p1, p2, click)));
  let lo = 0, hi = 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (tc >= sorted[i] && tc <= sorted[i + 1]) { lo = sorted[i]; hi = sorted[i + 1]; break; }
  }
  const at = (t: number) => v(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
  const pieces: ResolvedEntity[] = [];
  const keep = (ta: number, tb: number) => {
    if (tb - ta < 1e-3) return;
    const a = at(ta), b = at(tb);
    pieces.push({ type: "line", id: newEntityId(), x1: a.x, y1: a.y, x2: b.x, y2: b.y, construction: e.construction });
  };
  keep(0, lo);
  keep(hi, 1);
  return ents.flatMap((o, i) => (i === index ? pieces : [o]));
}

/**
 * Fillet the corner where two line entities meet: shorten both to the tangent
 * points and insert a tangent arc of the given radius. Returns null if it can't.
 */
export function filletCorner(
  ents: ResolvedEntity[],
  iA: number,
  iB: number,
  radius: number,
): ResolvedEntity[] | null {
  const A = ents[iA], B = ents[iB];
  if (A?.type !== "line" || B?.type !== "line") return null;
  const a1 = v(A.x1, A.y1), a2 = v(A.x2, A.y2);
  const b1 = v(B.x1, B.y1), b2 = v(B.x2, B.y2);
  const corner = lineIntersect(a1, a2, b1, b2);
  if (!corner) return null; // parallel

  // far endpoints (the ends to keep) and direction unit vectors from the corner
  const aFar = a1.distanceTo(corner) >= a2.distanceTo(corner) ? a1 : a2;
  const bFar = b1.distanceTo(corner) >= b2.distanceTo(corner) ? b1 : b2;
  const d1 = aFar.clone().sub(corner).normalize();
  const d2 = bFar.clone().sub(corner).normalize();
  const cosT = Math.max(-1, Math.min(1, d1.dot(d2)));
  const theta = Math.acos(cosT);
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return null; // collinear

  const tan = radius / Math.tan(theta / 2); // tangent length along each line
  if (tan > aFar.distanceTo(corner) || tan > bFar.distanceTo(corner)) return null; // too big

  const T1 = corner.clone().add(d1.clone().multiplyScalar(tan));
  const T2 = corner.clone().add(d2.clone().multiplyScalar(tan));
  const bis = d1.clone().add(d2).normalize();
  const center = corner.clone().add(bis.multiplyScalar(radius / Math.sin(theta / 2)));
  const through = center.clone().add(corner.clone().sub(center).normalize().multiplyScalar(radius));

  // A and B survive (just shortened) → keep their ids + constraints; the arc is new
  const newA: ResolvedEntity = { ...A, x1: aFar.x, y1: aFar.y, x2: T1.x, y2: T1.y };
  const newB: ResolvedEntity = { ...B, x1: bFar.x, y1: bFar.y, x2: T2.x, y2: T2.y };
  const arc: ResolvedEntity = { type: "arc", id: newEntityId(), x1: T1.x, y1: T1.y, x2: T2.x, y2: T2.y, mx: through.x, my: through.y };

  const out = ents.map((o, i) => (i === iA ? newA : i === iB ? newB : o));
  out[iB] = newB;
  out.push(arc);
  return out;
}

/** Offset: add a copy of the entity offset by `dist` (closed shapes grow with
 *  positive dist; lines shift to their left normal). Returns the new entities. */
export function offsetEntity(
  ents: ResolvedEntity[],
  index: number,
  dist: number,
): ResolvedEntity[] | null {
  const e = ents[index];
  let copy: ResolvedEntity | null = null;
  const id = newEntityId();
  if (e.type === "rectangle") {
    const w = e.width + 2 * dist, h = e.height + 2 * dist;
    if (w > 1e-3 && h > 1e-3) copy = { type: "rectangle", id, width: w, height: h, x: e.x, y: e.y };
  } else if (e.type === "circle") {
    const r = e.radius + dist;
    if (r > 1e-3) copy = { type: "circle", id, radius: r, x: e.x, y: e.y };
  } else if (e.type === "line") {
    const dir = v(e.x2 - e.x1, e.y2 - e.y1).normalize();
    const n = v(-dir.y, dir.x).multiplyScalar(dist); // left normal
    copy = { type: "line", id, x1: e.x1 + n.x, y1: e.y1 + n.y, x2: e.x2 + n.x, y2: e.y2 + n.y };
  }
  if (!copy) return null;
  return [...ents, copy];
}

/** Break: split the clicked curve at the click point into two pieces. */
export function breakAt(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] {
  const e = ents[index];
  if (e.type === "line") {
    const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
    let t = paramOnSeg(p1, p2, click);
    t = Math.max(0.02, Math.min(0.98, t));
    const m = v(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
    const a: ResolvedEntity = { type: "line", id: newEntityId(), x1: p1.x, y1: p1.y, x2: m.x, y2: m.y, construction: e.construction };
    const b: ResolvedEntity = { type: "line", id: newEntityId(), x1: m.x, y1: m.y, x2: p2.x, y2: p2.y, construction: e.construction };
    return ents.flatMap((o, i) => (i === index ? [a, b] : [o]));
  }
  return ents; // arc/circle break later
}

// --- geometric constraints (applied once; a full solver maintains them) ---
const lineDir = (e: { x1: number; y1: number; x2: number; y2: number }) =>
  v(e.x2 - e.x1, e.y2 - e.y1).normalize();

export function makeHorizontal(ents: ResolvedEntity[], i: number): ResolvedEntity[] {
  const e = ents[i];
  if (e.type !== "line") return ents;
  const y = (e.y1 + e.y2) / 2;
  return ents.map((o, j) => (j === i ? { ...e, y1: y, y2: y } : o));
}
export function makeVertical(ents: ResolvedEntity[], i: number): ResolvedEntity[] {
  const e = ents[i];
  if (e.type !== "line") return ents;
  const x = (e.x1 + e.x2) / 2;
  return ents.map((o, j) => (j === i ? { ...e, x1: x, x2: x } : o));
}
/** rotate line B about its start to a target direction (keeping its length) */
function alignLine(ents: ResolvedEntity[], iB: number, dir: THREE.Vector2): ResolvedEntity[] {
  const B = ents[iB];
  if (B.type !== "line") return ents;
  const len = v(B.x2 - B.x1, B.y2 - B.y1).length();
  const old = lineDir(B);
  const sign = dir.dot(old) >= 0 ? 1 : -1; // keep B pointing the same general way
  const d = dir.clone().multiplyScalar(sign * len);
  return ents.map((o, j) => (j === iB ? { ...B, x2: B.x1 + d.x, y2: B.y1 + d.y } : o));
}
export function makeParallel(ents: ResolvedEntity[], iA: number, iB: number): ResolvedEntity[] {
  const A = ents[iA];
  if (A?.type !== "line") return ents;
  return alignLine(ents, iB, lineDir(A));
}
export function makePerpendicular(ents: ResolvedEntity[], iA: number, iB: number): ResolvedEntity[] {
  const A = ents[iA];
  if (A?.type !== "line") return ents;
  const d = lineDir(A);
  return alignLine(ents, iB, v(-d.y, d.x));
}
export function makeEqual(ents: ResolvedEntity[], iA: number, iB: number): ResolvedEntity[] {
  const A = ents[iA], B = ents[iB];
  if (A?.type !== "line" || B?.type !== "line") return ents;
  const lenA = v(A.x2 - A.x1, A.y2 - A.y1).length();
  const d = lineDir(B).multiplyScalar(lenA);
  return ents.map((o, j) => (j === iB ? { ...B, x2: B.x1 + d.x, y2: B.y1 + d.y } : o));
}

/** Extend: lengthen the clicked end of a line to the nearest crossing. */
export function extendLine(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] | null {
  const e = ents[index];
  if (e.type !== "line") return null;
  const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
  const extendEnd2 = paramOnSeg(p1, p2, click) >= 0.5; // which end is near the click
  const dir = p2.clone().sub(p1).normalize();
  const far = p1.clone().sub(dir.clone().multiplyScalar(1e5)); // a ray well past both ends
  const farEnd = p2.clone().add(dir.clone().multiplyScalar(1e5));

  let bestT = extendEnd2 ? 1 : 0;
  let found = false;
  ents.forEach((o, i) => {
    if (i === index) return;
    const hits: THREE.Vector2[] = [];
    if (o.type === "circle") hits.push(...segCircleIntersect(far, farEnd, v(o.x, o.y), o.radius));
    else for (const [a, b] of entitySegments(o)) {
      const x = segIntersect(far, farEnd, a, b);
      if (x) hits.push(x);
    }
    for (const h of hits) {
      const t = paramOnSeg(p1, p2, h);
      if (extendEnd2 && t > 1 + 1e-4 && (!found || t < bestT)) { bestT = t; found = true; }
      if (!extendEnd2 && t < -1e-4 && (!found || t > bestT)) { bestT = t; found = true; }
    }
  });
  if (!found) return null;
  const np = p1.clone().add(p2.clone().sub(p1).multiplyScalar(bestT));
  const out = ents.map((o, i) => {
    if (i !== index || o.type !== "line") return o;
    return extendEnd2
      ? { ...o, x2: np.x, y2: np.y }
      : { ...o, x1: np.x, y1: np.y };
  });
  return out;
}
