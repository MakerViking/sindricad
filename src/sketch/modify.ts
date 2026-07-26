// Sketch modify operations on resolved entities: pick, trim, fillet-corner.
// These mutate the entity list (returning a new one); the sketcher rebuilds.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import { entitySegments, polygonPoints } from "./region";
import { newEntityId } from "./id";
import { arcCenterRadius } from "./arc";
import { coincKey } from "./sketchSolve";
import {
  segIntersect,
  segCircleIntersect,
  circleLineIntersect,
  circleCircleIntersect,
  lineIntersect,
  paramOnSeg,
  distToSeg,
} from "./geom2d";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

/** The one guard toast for projected (linked, fixed) reference geometry — every
 *  modify/transform/constraint seam that refuses to touch it shows this. */
export const PROJECTED_FIXED_MSG = "Projected geometry is fixed — Break Link to edit it";

/** Break Link (Fusion): convert the given projected entities to native
 *  geometry KEEPING their ids, so attached constraints/dims stay valid — and
 *  since they go fixed→free, the sketch can never become over-constrained by
 *  the conversion. The source/stale link fields are dropped; construction
 *  carries over. A closed poly (first sample == last, the projEndSamples
 *  closure rule) becomes a C0-closed spline: the duplicate closing point is
 *  kept, so endpoint index 0 — the one addressable point a closed poly
 *  exposed — still resolves (index 1 lands on the coincident closing point,
 *  which the solver merges back into it). Non-projected / unlisted entities
 *  pass through untouched. */
export function breakLink(ents: ResolvedEntity[], ids: ReadonlySet<string>): ResolvedEntity[] {
  return ents.map((e): ResolvedEntity => {
    if (e.type !== "projected" || !ids.has(e.id)) return e;
    const cv = e.curve;
    const base = { id: e.id, ...constr(e) };
    switch (cv.kind) {
      case "line":
        return { type: "line", ...base, x1: cv.x1, y1: cv.y1, x2: cv.x2, y2: cv.y2 };
      case "arc":
        return { type: "arc", ...base, x1: cv.x1, y1: cv.y1, x2: cv.x2, y2: cv.y2, mx: cv.mx, my: cv.my };
      case "circle":
        return { type: "circle", ...base, x: cv.x, y: cv.y, radius: cv.r };
      case "poly":
        return { type: "spline", ...base, points: cv.pts.map(([x, y]) => ({ x, y })) };
    }
  });
}

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

  if (e.type !== "line") return del(); // rectangle/spline + rigid polygon/slot: deleted whole
  // defer: trim/break/offset on rigid polygon/slot no-op or explode; revisit when a user hits it

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

/** Signed offset of a cursor position from an entity, in exactly the terms
 *  offsetEntity/offsetChain take as `dist`: magnitude = distance to the curve,
 *  sign = which side. Positive means OUTWARD for a closed shape
 *  (circle/arc/rectangle/polygon/slot) and to the LEFT of the stored direction
 *  (x1,y1)→(x2,y2) for a line or spline.
 *
 *  This is what lets the offset tool put the preview under the cursor: the tool
 *  measures with this, and both offset functions consume the same convention
 *  (offsetChain normalizes its arbitrary walk direction to match). Null for
 *  entities that can't be offset. */
export function signedOffsetAt(e: ResolvedEntity, p: THREE.Vector2): number | null {
  const leftOf = (a: THREE.Vector2, b: THREE.Vector2) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return 0;
    return ((p.x - a.x) * -dy + (p.y - a.y) * dx) / len;
  };
  if (e.type === "line") return leftOf(v(e.x1, e.y1), v(e.x2, e.y2));
  if (e.type === "circle") return v(e.x, e.y).distanceTo(p) - e.radius;
  if (e.type === "arc") {
    const g = arcGeom(e);
    return g ? g.C.distanceTo(p) - g.R : null;
  }
  if (e.type === "rectangle") {
    // exact signed distance to an axis-aligned box: outside = the corner/edge
    // distance, inside = the (negative) distance to the nearest edge
    const dx = Math.abs(p.x - e.x) - e.width / 2;
    const dy = Math.abs(p.y - e.y) - e.height / 2;
    return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
  }
  if (e.type === "polygon") {
    // convex polygon: the largest signed distance to any edge's outward line is
    // the exact SDF (negative inside)
    const pts = polygonPoints(e.x, e.y, e.radius, e.sides, (e.angle * Math.PI) / 180);
    let best = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      // polygonPoints runs CCW, so the OUTWARD normal is the right normal
      best = Math.max(best, -leftOf(a, b));
    }
    return Number.isFinite(best) ? best : null;
  }
  if (e.type === "slot") return distToSeg(v(e.x1, e.y1), v(e.x2, e.y2), p) - e.width / 2;
  if (e.type === "spline") {
    // nearest segment decides both distance and side (same left-normal
    // convention offsetEntity pushes the points along)
    let best: number | null = null;
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = v(e.points[i]!.x, e.points[i]!.y), b = v(e.points[i + 1]!.x, e.points[i + 1]!.y);
      const d = distToSeg(a, b, p);
      if (best === null || d < Math.abs(best)) best = Math.sign(leftOf(a, b) || 1) * d;
    }
    return best;
  }
  return null;
}

/** What an offset produced.
 *
 *  `pairs` are the source→copy operands the associative `offset` constraint will
 *  govern (rect operands are EDGES, "<rectId>~<k>" — see types.ts). `linked:
 *  false` means the geometry is correct but free-floating: the solver models
 *  polygon / slot / spline as RIGID, so there is no constraint that could tie
 *  the copy to its source, and the caller says so once rather than implying a
 *  link that doesn't exist. */
export type OffsetResult = {
  entities: ResolvedEntity[];
  pairs: { src: string; cpy: string }[];
  linked: boolean;
};

/** Offset a SINGLE entity by `dist` (closed shapes grow with positive dist;
 *  lines shift to their left normal). Returns null only for entity types that
 *  cannot be offset at all (text, point) — the caller toasts a refusal, because
 *  a silent no-op after the user has typed a distance reads as a broken tool. */
export function offsetEntity(
  ents: ResolvedEntity[],
  index: number,
  dist: number,
): OffsetResult | null {
  const e = ents[index];
  if (!e) return null;
  let copy: ResolvedEntity | null = null;
  let pairs: { src: string; cpy: string }[] = [];
  let linked = true;
  const id = newEntityId();
  if (e.type === "rectangle") {
    const w = e.width + 2 * dist, h = e.height + 2 * dist;
    if (w > 1e-3 && h > 1e-3) {
      copy = { type: "rectangle", id, width: w, height: h, x: e.x, y: e.y, ...constr(e) };
      // Both rectangles are axis-aligned about a shared centre, so edge k of the
      // copy IS edge k of the source (rectCorners' CCW order) — the pairing is
      // positional. Four edge pairs, one distance each, is exactly a
      // rectangle's 4 DOF.
      pairs = [0, 1, 2, 3].map((k) => ({ src: `${e.id}~${k}`, cpy: `${id}~${k}` }));
    }
  } else if (e.type === "circle") {
    const r = e.radius + dist;
    if (r > 1e-3) {
      copy = { type: "circle", id, radius: r, x: e.x, y: e.y, ...constr(e) };
      pairs = [{ src: e.id, cpy: id }];
    }
  } else if (e.type === "line") {
    const dir = v(e.x2 - e.x1, e.y2 - e.y1).normalize();
    const n = v(-dir.y, dir.x).multiplyScalar(dist); // left normal
    copy = { type: "line", id, x1: e.x1 + n.x, y1: e.y1 + n.y, x2: e.x2 + n.x, y2: e.y2 + n.y, ...constr(e) };
    pairs = [{ src: e.id, cpy: id }];
  } else if (e.type === "arc") {
    // concentric offset: positive dist grows the radius (away from the center)
    const g = arcGeom(e);
    if (g && g.R + dist > 1e-3) {
      copy = arcFromSpan(g.C, g.R + dist, g.aStart, g.delta, e);
      pairs = [{ src: e.id, cpy: copy.id }];
    }
  } else if (e.type === "spline") {
    // push each point along its local normal — the perpendicular to the chord
    // through its neighbours, so an interior corner offsets to the miter
    // direction and the ends use their own single segment.
    const pts = e.points;
    if (pts.length >= 2) {
      copy = {
        type: "spline", id, ...constr(e),
        points: pts.map((p, i) => {
          const prev = pts[i - 1] ?? p, next = pts[i + 1] ?? p;
          const dx = next.x - prev.x, dy = next.y - prev.y;
          const len = Math.hypot(dx, dy) || 1;
          return { x: p.x + (-dy / len) * dist, y: p.y + (dx / len) * dist };
        }),
      };
      linked = false;
    }
  } else if (e.type === "polygon") {
    // Fusion keeps a polygon a polygon. `radius` is the CIRCUMradius while the
    // EDGES lie on the inscribed circle (r·cos(π/n)), so moving the edges out by
    // `dist` moves the circumradius by dist / cos(π/n).
    const n = Math.max(3, Math.round(e.sides));
    const r = e.radius + dist / Math.cos(Math.PI / n);
    if (r > 1e-3) {
      copy = { type: "polygon", id, x: e.x, y: e.y, radius: r, sides: e.sides, angle: e.angle, ...constr(e) };
      linked = false;
    }
  } else if (e.type === "slot") {
    // `width` is the OVERALL width (the caps have radius w/2), so pushing the
    // boundary out by `dist` widens it by 2·dist; the axis is unchanged.
    const w = e.width + 2 * dist;
    if (w > 1e-3) {
      copy = { type: "slot", id, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, width: w, ...constr(e) };
      linked = false;
    }
  }
  if (!copy) return null;
  return { entities: [...ents, copy], pairs, linked };
}

type LineE = Extract<ResolvedEntity, { type: "line" }>;
type ArcE = Extract<ResolvedEntity, { type: "arc" }>;
type ChainE = LineE | ArcE;

/** A member of the chain being offset, in traversal order. `ccw` is meaningful
 *  for arcs only: whether this traversal runs along the arc's CCW sweep. */
type Member = { i: number; e: ChainE; from: THREE.Vector2; to: THREE.Vector2; ccw: boolean };

/** An offset member. Lines carry their two endpoints; arcs carry the (unchanged)
 *  centre plus the offset radius, and their endpoints ride on that circle. */
type Off =
  | { kind: "line"; src: string; a: THREE.Vector2; b: THREE.Vector2; dir: THREE.Vector2 }
  | { kind: "arc"; src: string; a: THREE.Vector2; b: THREE.Vector2; C: THREE.Vector2; R: number; ccw: boolean };

/** How far a miter may travel from the original corner, as a multiple of |dist|.
 *  Two nearly-collinear offset lines intersect arbitrarily far away, which used
 *  to fling a spike across the sketch; past this limit the corner is left butted
 *  instead. 4 is the common CAD/stroke default (~29° between segments). */
const MITER_LIMIT = 4;

/** Build an arc entity from its centre, radius, two endpoints and sweep
 *  direction. A CW sweep is emitted as the equivalent CCW arc from the other
 *  end — an arc entity is three points, so it carries no direction of its own. */
function arcFromEnds(
  C: THREE.Vector2, R: number, a: THREE.Vector2, b: THREE.Vector2, ccw: boolean,
  src: { construction?: boolean },
): ResolvedEntity | null {
  const aS = Math.atan2(a.y - C.y, a.x - C.x);
  const aE = Math.atan2(b.y - C.y, b.x - C.x);
  const delta = ccw ? ccwDelta(aS, aE) : ccwDelta(aE, aS);
  if (delta < 1e-9) return null; // collapsed to nothing
  return ccw ? arcFromSpan(C, R, aS, delta, src) : arcFromSpan(C, R, aE, delta, src);
}

/**
 * Offset a connected chain of LINE and ARC entities as a unit, joining the
 * corners — the common "offset this profile in/out" case (polylines, a
 * rectangle drawn as 4 lines, and now filleted profiles, which are the shape
 * most real parts actually have).
 *
 * Returns null when the clicked entity isn't part of a simple chain (a lone
 * curve or a junction); the caller then falls back to single-entity offset.
 * `dist` sign picks the side: every member shifts to its LEFT relative to the
 * traversal direction, so on a CCW loop a positive dist moves inward.
 *
 * Arcs used to be skipped entirely here (only `line` entities entered the
 * adjacency map), so a filleted profile offset as loose, unjoined pieces.
 */
export function offsetChain(
  ents: ResolvedEntity[],
  index: number,
  dist: number,
): OffsetResult | null {
  const isChain = (e: ResolvedEntity | undefined): e is ChainE =>
    e?.type === "line" || e?.type === "arc";
  if (!isChain(ents[index])) return null;

  // endpoint key -> chain-entity indices touching it. coincKey is the solver's
  // canonical coincidence key, so "connected" here matches what the solver merges.
  const touch = new Map<string, number[]>();
  ents.forEach((e, i) => {
    if (!isChain(e)) return;
    for (const k of [coincKey(e.x1, e.y1), coincKey(e.x2, e.y2)]) {
      const arr = touch.get(k);
      if (arr) arr.push(i); else touch.set(k, [i]);
    }
  });

  // connected component containing `index`; bail on any junction (a shared
  // vertex touched by >2 curves) — not a simple chain
  const comp = new Set<number>();
  const stack = [index];
  while (stack.length) {
    const i = stack.pop();
    if (i === undefined || comp.has(i)) continue;
    const e = ents[i];
    if (!isChain(e)) continue;
    comp.add(i);
    for (const k of [coincKey(e.x1, e.y1), coincKey(e.x2, e.y2)]) {
      const arr = touch.get(k);
      if (!arr) continue;
      if (arr.length > 2) return null; // junction
      for (const j of arr) if (j !== i) stack.push(j);
    }
  }
  if (comp.size < 2) return null; // a lone curve — caller handles it

  // pick a start: a free end for an open chain, else any member (closed loop)
  let start = -1, startKey = "";
  for (const i of comp) {
    const e = ents[i] as ChainE;
    if (touch.get(coincKey(e.x1, e.y1))?.length === 1) { start = i; startKey = coincKey(e.x1, e.y1); break; }
    if (touch.get(coincKey(e.x2, e.y2))?.length === 1) { start = i; startKey = coincKey(e.x2, e.y2); break; }
  }
  const closed = start === -1;
  if (closed) { start = comp.values().next().value as number; const s = ents[start] as ChainE; startKey = coincKey(s.x1, s.y1); }

  // walk the chain into an ordered, directed path
  const path: Member[] = [];
  const used = new Set<number>();
  let cur = start, curKey = startKey;
  while (cur !== -1 && !used.has(cur)) {
    used.add(cur);
    const e = ents[cur] as ChainE;
    const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
    const fromP1 = coincKey(p1.x, p1.y) === curKey;
    const from = fromP1 ? p1 : p2, to = fromP1 ? p2 : p1;
    // for an arc, does this traversal run along its CCW sweep? arcGeom's
    // aStart is the CCW start, so travelling from that endpoint is CCW.
    let ccw = true;
    if (e.type === "arc") {
      const g = arcGeom(e);
      if (!g) return null;
      const s = v(g.C.x + Math.cos(g.aStart) * g.R, g.C.y + Math.sin(g.aStart) * g.R);
      ccw = from.distanceTo(s) <= to.distanceTo(s);
    }
    path.push({ i: cur, e, from, to, ccw });
    const toKey = coincKey(to.x, to.y);
    const nxt = (touch.get(toKey) ?? []).find((j) => j !== cur && !used.has(j));
    cur = nxt ?? -1;
    curKey = toKey;
  }
  if (path.length < 2) return null;

  // Normalize the sign so that for the CHAIN it means exactly what it means for
  // the PICKED entity alone (offsetEntity's convention: left of a line's stored
  // direction, outward for an arc). The walk direction is arbitrary — it starts
  // from whichever free end it found — so without this the same cursor position
  // could offset the chain to either side depending on how the walk happened to
  // run. signedOffsetAt measures the cursor in offsetEntity's terms, and this is
  // what keeps the preview under the cursor.
  const picked = path.find((m) => m.i === index);
  if (picked) {
    const backwards = picked.from.distanceTo(v(picked.e.x1, picked.e.y1)) > 1e-9;
    if (picked.e.type === "line" ? backwards : picked.ccw) dist = -dist;
  }

  /** Offset one member to its left by `dist`. For an arc the left normal points
   *  at the centre when travelling CCW, so a CCW arc SHRINKS by dist and a CW
   *  arc grows — that is what keeps an arc coherent with the lines beside it.
   *  Null when the arc's radius would collapse. */
  const offsetOne = (m: Member): Off | null => {
    if (m.e.type === "line") {
      const dir = m.to.clone().sub(m.from).normalize();
      const n = v(-dir.y, dir.x).multiplyScalar(dist);
      return { kind: "line", src: m.e.id, a: m.from.clone().add(n), b: m.to.clone().add(n), dir };
    }
    const g = arcGeom(m.e);
    if (!g) return null;
    const R = g.R + (m.ccw ? -dist : dist);
    if (R < 1e-3) return null;
    const at = (p: THREE.Vector2) => {
      const a = Math.atan2(p.y - g.C.y, p.x - g.C.x);
      return v(g.C.x + Math.cos(a) * R, g.C.y + Math.sin(a) * R);
    };
    return { kind: "arc", src: m.e.id, a: at(m.from), b: at(m.to), C: g.C, R, ccw: m.ccw };
  };

  /** Move the shared corner of two adjacent offset members onto their
   *  intersection. Picks the root nearest the ORIGINAL corner, which is what
   *  keeps a line-arc join on the right branch. Returns false when there is no
   *  usable intersection (parallel lines, separated circles) or the miter would
   *  travel further than MITER_LIMIT — the corner is then left butted. */
  const joinAt = (s0: Off, s1: Off, corner: THREE.Vector2): boolean => {
    let cands: THREE.Vector2[] = [];
    if (s0.kind === "line" && s1.kind === "line") {
      const m = lineIntersect(s0.a, s0.b, s1.a, s1.b);
      cands = m ? [m] : [];
    } else if (s0.kind === "line" && s1.kind === "arc") {
      cands = circleLineIntersect(s0.a, s0.b, s1.C, s1.R);
    } else if (s0.kind === "arc" && s1.kind === "line") {
      cands = circleLineIntersect(s1.a, s1.b, s0.C, s0.R);
    } else if (s0.kind === "arc" && s1.kind === "arc") {
      cands = circleCircleIntersect(s0.C, s0.R, s1.C, s1.R);
    }
    if (!cands.length) return false;
    const best = cands.reduce((p, q) => (q.distanceTo(corner) < p.distanceTo(corner) ? q : p));
    if (best.distanceTo(corner) > MITER_LIMIT * Math.abs(dist) + 1e-9) return false;
    s0.b = best;
    s1.a = best;
    return true;
  };

  // Offset, join, and prune anything that collapsed. An inward offset larger
  // than the smallest feature makes a member run BACKWARDS relative to its
  // source; keeping it produces the classic self-intersecting bow-tie. Drop the
  // reversed members and re-join across the gap, repeating because removing one
  // can expose the next. Bounded by the member count, so it always terminates.
  let live = path;
  let offs: Off[] = [];
  for (let pass = 0; pass <= path.length; pass++) {
    const built = live.map(offsetOne);
    offs = built.filter((o): o is Off => o !== null);
    const survivors = live.filter((_m, k) => built[k] !== null);
    live = survivors;
    if (!offs.length) return null;
    const last = offs.length - 1;
    for (let k = 0; k < last; k++) joinAt(offs[k]!, offs[k + 1]!, live[k]!.to);
    if (closed && offs.length > 1) joinAt(offs[last]!, offs[0]!, live[last]!.to);
    // a LINE that now points the other way has been swallowed by the offset
    const reversed = offs
      .map((o, k) => (o.kind === "line" && o.b.clone().sub(o.a).dot(o.dir) < 0 ? k : -1))
      .filter((k) => k >= 0);
    if (!reversed.length) break;
    const drop = new Set(reversed);
    live = live.filter((_m, k) => !drop.has(k));
    if (live.length < 1) return null;
  }

  const pairs: { src: string; cpy: string }[] = [];
  const copies: ResolvedEntity[] = [];
  for (const o of offs) {
    const srcEnt = ents.find((x) => x.id === o.src) ?? {};
    if (o.kind === "line") {
      const id = newEntityId();
      copies.push({ type: "line", id, x1: o.a.x, y1: o.a.y, x2: o.b.x, y2: o.b.y, ...constr(srcEnt) });
      pairs.push({ src: o.src, cpy: id });
    } else {
      const arc = arcFromEnds(o.C, o.R, o.a, o.b, o.ccw, srcEnt);
      if (!arc) continue; // swept to nothing
      copies.push(arc);
      pairs.push({ src: o.src, cpy: arc.id });
    }
  }
  if (!copies.length) return null;
  return { entities: [...ents, ...copies], pairs, linked: true };
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
