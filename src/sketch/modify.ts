// Sketch modify operations on resolved entities: pick, trim, fillet-corner.
// These mutate the entity list (returning a new one); the sketcher rebuilds.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import { entitySegments } from "./region";
import { newEntityId } from "./id";
import { arcCenterRadius } from "./arc";
import { coincKey } from "./sketchSolve";
import {
  segIntersect,
  segCircleIntersect,
  lineIntersect,
  paramOnSeg,
  distToSeg,
} from "./geom2d";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

const TAU = Math.PI * 2;
/** CCW angular distance from `from` to `to`, always in [0, TAU) */
const ccwDelta = (from: number, to: number) => (((to - from) % TAU) + TAU) % TAU;

/** Build an arc entity from a center, radius and a CCW angular span (start + delta>0). */
function arcFromSpan(
  C: THREE.Vector2,
  R: number,
  aStart: number,
  delta: number,
  src: { construction?: boolean },
): ResolvedEntity {
  const aEnd = aStart + delta;
  const aMid = aStart + delta / 2;
  return {
    type: "arc",
    id: newEntityId(),
    x1: C.x + Math.cos(aStart) * R, y1: C.y + Math.sin(aStart) * R,
    x2: C.x + Math.cos(aEnd) * R, y2: C.y + Math.sin(aEnd) * R,
    mx: C.x + Math.cos(aMid) * R, my: C.y + Math.sin(aMid) * R,
    ...constr(src),
  };
}

/** An arc's center, radius, CCW start angle and CCW sweep (delta>0), from its 3
 *  stored points — oriented so the through-point lies inside the sweep (matches
 *  the reconstruction in sketchSolve). Null for a degenerate/collinear arc. */
function arcGeom(e: { x1: number; y1: number; x2: number; y2: number; mx: number; my: number }):
  { C: THREE.Vector2; R: number; aStart: number; delta: number } | null {
  const cr = arcCenterRadius(e);
  if (!cr) return null;
  const C = cr.c, R = cr.r;
  const aS = Math.atan2(e.y1 - C.y, e.x1 - C.x);
  const aE = Math.atan2(e.y2 - C.y, e.x2 - C.x);
  const aT = Math.atan2(e.my - C.y, e.mx - C.x);
  const throughFwd = ccwDelta(aS, aT) <= ccwDelta(aS, aE);
  return throughFwd
    ? { C, R, aStart: aS, delta: ccwDelta(aS, aE) }
    : { C, R, aStart: aE, delta: ccwDelta(aE, aS) };
}

/** angles (atan2, unbounded) at which other entities cross the circle (C,R) */
function circleCrossAngles(ents: ResolvedEntity[], index: number, C: THREE.Vector2, R: number): number[] {
  const out: number[] = [];
  ents.forEach((o, i) => {
    if (i === index) return;
    for (const [a, b] of entitySegments(o)) {
      for (const h of segCircleIntersect(a, b, C, R)) out.push(Math.atan2(h.y - C.y, h.x - C.x));
    }
  });
  return out;
}

/** spread that copies a construction flag only when set — avoids emitting an
 *  explicit `construction: undefined`, which exactOptionalPropertyTypes rejects. */
const constr = (e: { construction?: boolean }) =>
  e.construction === undefined ? {} : { construction: e.construction };

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
 * Trim: remove the clicked portion of a curve up to its nearest intersections.
 * Lines split into the outer segments; arcs into the outer sub-arcs; a circle
 * becomes the complementary arc. A curve with no usable crossing is deleted whole.
 */
export function trimEntity(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] {
  const e = ents[index];
  if (!e) return ents;
  const del = () => ents.filter((_, i) => i !== index);

  if (e.type === "circle") {
    const C = v(e.x, e.y), R = e.radius;
    const norm = (a: number) => ((a % TAU) + TAU) % TAU;
    const angs = [...new Set(circleCrossAngles(ents, index, C, R).map(norm))].sort((a, b) => a - b);
    if (angs.length < 2) return del(); // nothing to trim against
    const tc = norm(Math.atan2(click.y - C.y, click.x - C.x));
    // the CCW span [lo,hi] between adjacent crossings that contains the click
    let lo = angs[angs.length - 1]!, hi = angs[0]!;
    for (let k = 0; k < angs.length; k++) {
      const a = angs[k]!, b = angs[(k + 1) % angs.length]!;
      if (ccwDelta(a, tc) <= ccwDelta(a, b)) { lo = a; hi = b; break; }
    }
    const keep = ccwDelta(hi, lo); // complement of the removed span
    if (keep < 1e-3) return del();
    return ents.flatMap((o, i) => (i === index ? [arcFromSpan(C, R, hi, keep, e)] : [o]));
  }

  if (e.type === "arc") {
    const g = arcGeom(e);
    if (!g) return del();
    const { C, R, aStart, delta } = g;
    const params = new Set<number>([0, 1]);
    for (const ang of circleCrossAngles(ents, index, C, R)) {
      const t = ccwDelta(aStart, ang) / delta;
      if (t > 1e-4 && t < 1 - 1e-4) params.add(t);
    }
    const sorted = [...params].sort((a, b) => a - b);
    if (sorted.length <= 2) return del();
    const tc = Math.max(0, Math.min(1, ccwDelta(aStart, Math.atan2(click.y - C.y, click.x - C.x)) / delta));
    let lo = 0, hi = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!, b = sorted[i + 1]!;
      if (tc >= a && tc <= b) { lo = a; hi = b; break; }
    }
    const pieces: ResolvedEntity[] = [];
    const keep = (ta: number, tb: number) => {
      if (tb - ta > 1e-3) pieces.push(arcFromSpan(C, R, aStart + ta * delta, (tb - ta) * delta, e));
    };
    keep(0, lo); keep(hi, 1);
    return ents.flatMap((o, i) => (i === index ? pieces : [o]));
  }

  if (e.type !== "line") return del();

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
    const a = sorted[i], b = sorted[i + 1];
    if (a === undefined || b === undefined) continue;
    if (tc >= a && tc <= b) { lo = a; hi = b; break; }
  }
  const at = (t: number) => v(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
  const pieces: ResolvedEntity[] = [];
  const keep = (ta: number, tb: number) => {
    if (tb - ta < 1e-3) return;
    const a = at(ta), b = at(tb);
    pieces.push({ type: "line", id: newEntityId(), x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...constr(e) });
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
  if (!e) return null;
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
  } else if (e.type === "arc") {
    // concentric offset: positive dist grows the radius (away from the center)
    const g = arcGeom(e);
    if (g && g.R + dist > 1e-3) copy = arcFromSpan(g.C, g.R + dist, g.aStart, g.delta, {});
  }
  if (!copy) return null;
  return [...ents, copy];
}

type LineE = Extract<ResolvedEntity, { type: "line" }>;

/**
 * Offset a connected chain of LINE entities as a unit, mitering the corners —
 * the common "offset this profile in/out" case (polygon outlines, polylines,
 * a rectangle drawn as 4 lines). Returns the entities with the offset chain
 * ADDED (originals kept), or null when the clicked entity isn't part of a
 * simple line chain (a lone line or a junction) — the caller then falls back to
 * single-entity offset. `dist` sign picks the side.
 *
 * Considers ONLY line entities; arcs in a profile are ignored (not joined) — a
 * line-line corner with a coincident arc endpoint miters the two lines and skips
 * the arc. defer: mixed line+arc chain joins; revisit when arc offset is added.
 */
export function offsetLineChain(
  ents: ResolvedEntity[],
  index: number,
  dist: number,
): ResolvedEntity[] | null {
  if (ents[index]?.type !== "line") return null;
  // endpoint key -> line-entity indices touching it. coincKey is the solver's
  // canonical coincidence key, so "connected" here matches what the solver merges.
  const touch = new Map<string, number[]>();
  ents.forEach((e, i) => {
    if (e.type !== "line") return;
    for (const k of [coincKey(e.x1, e.y1), coincKey(e.x2, e.y2)]) {
      const arr = touch.get(k);
      if (arr) arr.push(i); else touch.set(k, [i]);
    }
  });

  // connected component of lines containing `index`; bail on any junction (a
  // shared vertex touched by >2 lines) — not a simple chain
  const comp = new Set<number>();
  const stack = [index];
  while (stack.length) {
    const i = stack.pop();
    if (i === undefined || comp.has(i)) continue;
    const e = ents[i];
    if (!e || e.type !== "line") continue;
    comp.add(i);
    for (const k of [coincKey(e.x1, e.y1), coincKey(e.x2, e.y2)]) {
      const arr = touch.get(k);
      if (!arr) continue;
      if (arr.length > 2) return null; // junction
      for (const j of arr) if (j !== i) stack.push(j);
    }
  }
  if (comp.size < 2) return null; // a lone line — caller handles it

  // order the chain into a directed path. Start at a free end (a vertex touched
  // by only one line) for an open chain; any line for a closed loop. Within a
  // junction-free component, touch[k].length IS that vertex's chain degree.
  let start = -1, startKey = "";
  for (const i of comp) {
    const e = ents[i] as LineE;
    if (touch.get(coincKey(e.x1, e.y1))?.length === 1) { start = i; startKey = coincKey(e.x1, e.y1); break; }
    if (touch.get(coincKey(e.x2, e.y2))?.length === 1) { start = i; startKey = coincKey(e.x2, e.y2); break; }
  }
  const closed = start === -1;
  if (closed) { start = comp.values().next().value as number; const s = ents[start] as LineE; startKey = coincKey(s.x1, s.y1); }

  // walk: each step yields the line's [from, to] in path order
  const path: { from: THREE.Vector2; to: THREE.Vector2 }[] = [];
  const used = new Set<number>();
  let cur = start, curKey = startKey;
  while (cur !== -1 && !used.has(cur)) {
    used.add(cur);
    const e = ents[cur] as LineE;
    const a = v(e.x1, e.y1), b = v(e.x2, e.y2);
    const fromA = coincKey(a.x, a.y) === curKey;
    const from = fromA ? a : b, to = fromA ? b : a;
    path.push({ from, to });
    const toKey = coincKey(to.x, to.y);
    const arr = touch.get(toKey) ?? [];
    const nxt = arr.find((j) => j !== cur && !used.has(j)); // touch⊆comp here
    cur = nxt ?? -1;
    curKey = toKey;
  }
  if (path.length < 2) return null;

  // offset each segment to its left normal by dist
  const seg = path.map(({ from, to }) => {
    const dir = to.clone().sub(from).normalize();
    const n = v(-dir.y, dir.x).multiplyScalar(dist);
    return { a: from.clone().add(n), b: to.clone().add(n) };
  });
  // miter join adjacent offset segments (and the wrap corner when closed)
  const joinAt = (i: number, j: number) => {
    const s0 = seg[i], s1 = seg[j];
    if (!s0 || !s1) return;
    const m = lineIntersect(s0.a, s0.b, s1.a, s1.b);
    if (m) { s0.b = m; s1.a = m; } // shared corner → the miter point
  };
  for (let i = 0; i < seg.length - 1; i++) joinAt(i, i + 1);
  if (closed) joinAt(seg.length - 1, 0);

  const offsetLines: ResolvedEntity[] = seg.map((s) => ({
    type: "line", id: newEntityId(), x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y,
  }));
  return [...ents, ...offsetLines];
}

/** Break: split the clicked curve at the click point. A line/arc splits into two
 *  pieces; a circle opens into a single arc starting/ending at the click point. */
export function breakAt(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] {
  const e = ents[index];
  if (!e) return ents;
  if (e.type === "line") {
    const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
    let t = paramOnSeg(p1, p2, click);
    t = Math.max(0.02, Math.min(0.98, t));
    const m = v(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
    const a: ResolvedEntity = { type: "line", id: newEntityId(), x1: p1.x, y1: p1.y, x2: m.x, y2: m.y, ...constr(e) };
    const b: ResolvedEntity = { type: "line", id: newEntityId(), x1: m.x, y1: m.y, x2: p2.x, y2: p2.y, ...constr(e) };
    return ents.flatMap((o, i) => (i === index ? [a, b] : [o]));
  }
  if (e.type === "circle") {
    // open the closed loop at the click angle → one arc sweeping (almost) full circle
    const C = v(e.x, e.y), R = e.radius;
    const ac = Math.atan2(click.y - C.y, click.x - C.x);
    const gap = 1e-3; // tiny opening so start ≠ end (a valid arc)
    return ents.flatMap((o, i) => (i === index ? [arcFromSpan(C, R, ac + gap, TAU - 2 * gap, e)] : [o]));
  }
  if (e.type === "arc") {
    const g = arcGeom(e);
    if (!g) return ents;
    const { C, R, aStart, delta } = g;
    let t = ccwDelta(aStart, Math.atan2(click.y - C.y, click.x - C.x)) / delta;
    t = Math.max(0.02, Math.min(0.98, t));
    const a = arcFromSpan(C, R, aStart, t * delta, e);
    const b = arcFromSpan(C, R, aStart + t * delta, (1 - t) * delta, e);
    return ents.flatMap((o, i) => (i === index ? [a, b] : [o]));
  }
  return ents;
}

// --- geometric constraints (applied once; a full solver maintains them) ---
const lineDir = (e: { x1: number; y1: number; x2: number; y2: number }) =>
  v(e.x2 - e.x1, e.y2 - e.y1).normalize();

export function makeHorizontal(ents: ResolvedEntity[], i: number): ResolvedEntity[] {
  const e = ents[i];
  if (!e || e.type !== "line") return ents;
  const y = (e.y1 + e.y2) / 2;
  return ents.map((o, j) => (j === i ? { ...e, y1: y, y2: y } : o));
}
export function makeVertical(ents: ResolvedEntity[], i: number): ResolvedEntity[] {
  const e = ents[i];
  if (!e || e.type !== "line") return ents;
  const x = (e.x1 + e.x2) / 2;
  return ents.map((o, j) => (j === i ? { ...e, x1: x, x2: x } : o));
}
/** rotate line B about its start to a target direction (keeping its length) */
function alignLine(ents: ResolvedEntity[], iB: number, dir: THREE.Vector2): ResolvedEntity[] {
  const B = ents[iB];
  if (!B || B.type !== "line") return ents;
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

/** Extend: lengthen the clicked end of a line or arc to the nearest crossing. */
export function extendLine(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] | null {
  const e = ents[index];
  if (!e) return null;
  if (e.type === "arc") return extendArc(ents, index, e, click);
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

/** Extend an arc's near-clicked end along its circle to the nearest crossing. */
function extendArc(
  ents: ResolvedEntity[],
  index: number,
  e: Extract<ResolvedEntity, { type: "arc" }>,
  click: THREE.Vector2,
): ResolvedEntity[] | null {
  const g = arcGeom(e);
  if (!g) return null;
  const { C, R, aStart, delta } = g;
  const ac = Math.atan2(click.y - C.y, click.x - C.x);
  const nearEnd = ccwDelta(aStart, ac) > delta / 2; // click closer to end than start
  const aEnd = aStart + delta;
  let best: number | null = null;
  for (const raw of circleCrossAngles(ents, index, C, R)) {
    if (ccwDelta(aStart, raw) <= delta + 1e-6) continue; // already on the arc
    // gap = how far to sweep (CCW past the end, or CW before the start) to reach it
    const gap = nearEnd ? ccwDelta(aEnd, raw) : ccwDelta(raw, aStart);
    if (gap > 1e-4 && gap < TAU - delta - 1e-4 && (best === null || gap < best)) best = gap;
  }
  if (best === null) return null;
  const grown = nearEnd
    ? arcFromSpan(C, R, aStart, delta + best, e)
    : arcFromSpan(C, R, aStart - best, delta + best, e);
  const kept = { ...grown, id: e.id }; // survive: keep id + constraints
  return ents.map((o, i) => (i === index ? kept : o));
}

/**
 * Chamfer the corner where two line entities meet: shorten both to the setback
 * points and insert a straight bevel line. `dist` is the equal setback along
 * each line. Returns null if it can't (parallel/collinear/too-big).
 */
export function chamferCorner(
  ents: ResolvedEntity[],
  iA: number,
  iB: number,
  dist: number,
): ResolvedEntity[] | null {
  const A = ents[iA], B = ents[iB];
  if (A?.type !== "line" || B?.type !== "line") return null;
  const a1 = v(A.x1, A.y1), a2 = v(A.x2, A.y2);
  const b1 = v(B.x1, B.y1), b2 = v(B.x2, B.y2);
  const corner = lineIntersect(a1, a2, b1, b2);
  if (!corner) return null; // parallel

  const aFar = a1.distanceTo(corner) >= a2.distanceTo(corner) ? a1 : a2;
  const bFar = b1.distanceTo(corner) >= b2.distanceTo(corner) ? b1 : b2;
  const d1 = aFar.clone().sub(corner).normalize();
  const d2 = bFar.clone().sub(corner).normalize();
  const cosT = Math.max(-1, Math.min(1, d1.dot(d2)));
  const theta = Math.acos(cosT);
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return null; // collinear
  if (dist > aFar.distanceTo(corner) || dist > bFar.distanceTo(corner)) return null; // too big

  const T1 = corner.clone().add(d1.clone().multiplyScalar(dist));
  const T2 = corner.clone().add(d2.clone().multiplyScalar(dist));

  const newA: ResolvedEntity = { ...A, x1: aFar.x, y1: aFar.y, x2: T1.x, y2: T1.y };
  const newB: ResolvedEntity = { ...B, x1: bFar.x, y1: bFar.y, x2: T2.x, y2: T2.y };
  const bevel: ResolvedEntity = { type: "line", id: newEntityId(), x1: T1.x, y1: T1.y, x2: T2.x, y2: T2.y };

  const out = ents.map((o, i) => (i === iA ? newA : i === iB ? newB : o));
  out.push(bevel);
  return out;
}
