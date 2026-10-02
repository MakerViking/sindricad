// Small 2D geometry helpers for the sketch modify tools (trim, fillet).

import * as THREE from "three";

type V = THREE.Vector2;
type Pt = { x: number; y: number }; // structural: THREE.Vector2 or a plain point
const v = (x: number, y: number) => new THREE.Vector2(x, y);

/** intersection of two INFINITE lines (through p1p2 and p3p4); null if parallel */
export function lineIntersect(p1: V, p2: V, p3: V, p4: V): V | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  return v(p1.x + d1x * t, p1.y + d1y * t);
}

/** intersection point of two SEGMENTS, or null if they don't cross */
export function segIntersect(p1: V, p2: V, p3: V, p4: V): V | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return v(p1.x + d1x * t, p1.y + d1y * t);
}

/** intersection points of segment p1p2 with the full circle (center c, radius r) */
export function segCircleIntersect(p1: V, p2: V, c: V, r: number): V[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const fx = p1.x - c.x, fy = p1.y - c.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0 || a < 1e-12) return [];
  const sq = Math.sqrt(disc);
  const out: V[] = [];
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t >= -1e-6 && t <= 1 + 1e-6) out.push(v(p1.x + dx * t, p1.y + dy * t));
  }
  return out;
}

/** How close a curve may come to a circle and still TOUCH it, in mm. A tangency
 *  the solver satisfied is exact only to its convergence: a solved belt sketch
 *  (two circles, two lines, four tangents) left the line-circle discriminant at
 *  -1.11e-10, so an exact `disc < 0` test called a real tangency a miss about
 *  half the time, and trim deleted the whole curve instead of cutting at the
 *  touch. Relative above 1 mm because the noise scales with the radius.
 *
 *  It is used two ways, and neither may merge two crossings a user can see. A
 *  curve that MISSES the circle by no more than this touches it. A curve that
 *  cuts it touches only when its two crossings sit within this of their
 *  midpoint, measured ALONG the cut. A radial band there would merge real
 *  crossings up to 2.8e-3*r apart (0.056 mm at r=20), and the chord between
 *  them could not be trimmed at all. */
export const touchTol = (r: number) => 1e-6 * Math.max(1, r);

/** intersection points of the INFINITE line through p1p2 with the circle
 *  (c, r). The unclamped twin of segCircleIntersect: a corner miter lands beyond
 *  the offset segment's ends more often than not, so clamping to [0,1] would
 *  discard exactly the join we're looking for. A line that touches the circle
 *  (touchTol) gives one point, the foot of the centre on the line. */
export function circleLineIntersect(p1: V, p2: V, c: V, r: number): V[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return [];
  // the foot of the centre on the line, and how far the centre sits from it
  const t = ((c.x - p1.x) * dx + (c.y - p1.y) * dy) / len2;
  const fx = p1.x + dx * t, fy = p1.y + dy * t;
  const d = Math.hypot(c.x - fx, c.y - fy);
  if (d > r + touchTol(r)) return [];
  // half the chord, along the line; zero for a line that just misses
  const half = d < r ? Math.sqrt(r * r - d * d) : 0;
  if (half <= touchTol(r)) return [v(fx, fy)];
  const h = half / Math.sqrt(len2);
  return [v(fx - dx * h, fy - dy * h), v(fx + dx * h, fy + dy * h)];
}

/** intersection points of the two full circles (c1,r1) and (c2,r2) — 0, 1 or 2.
 *  Concentric or non-touching circles give none. The arc-to-arc companion to
 *  lineIntersect (line-line) and segCircleIntersect (line-arc), used to miter a
 *  corner where two offset arcs meet. Circles that touch (touchTol), outside or
 *  inside, give ONE point: the contact on the line of centres. */
export function circleCircleIntersect(c1: V, r1: number, c2: V, r2: number): V[] {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  const tol = touchTol(Math.max(r1, r2));
  if (d < 1e-9 || d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0; // half the common chord; zero for a near miss
  const mx = c1.x + (a * dx) / d, my = c1.y + (a * dy) / d;
  if (h <= tol) return [v(mx, my)]; // tangent: one point
  const ox = (-dy * h) / d, oy = (dx * h) / d;
  return [v(mx + ox, my + oy), v(mx - ox, my - oy)];
}

const TAU = Math.PI * 2;
/** CCW angular distance from `from` to `to`, always in [0, TAU) */
const ccwDelta = (from: number, to: number) => (((to - from) % TAU) + TAU) % TAU;

/** A curve the trim/extend crossing search tests against, exact wherever the
 *  sketch has an exact form: a straight segment, or a circle. An arc is its
 *  circle plus the CCW sweep from `a0` (a full circle sweeps TAU). */
export type Curve2 =
  | { kind: "seg"; a: V; b: V }
  | { kind: "round"; c: V; r: number; a0: number; sweep: number };

/** What a crossing is searched ALONG: the infinite line through a and b, or a
 *  full circle. Where along it the caller wants them is the caller's business:
 *  trim wants the inside of its curve, extend the outside. */
export type Carrier2 = { kind: "line"; a: V; b: V } | { kind: "circle"; c: V; r: number };

/** Where `other` crosses or touches the carrier `on`.
 *
 *  Analytic for every pair a sketch draws: line-line, line-circle and
 *  circle-circle. Trim and extend used to intersect against an arc's or
 *  circle's TESSELLATION (48 chords per arc, 64 per circle), which cost them
 *  twice: a trimmed line ended on a chord, 0.009 mm off an r=20 arc, and a
 *  tangent touch lies outside the chord polygon, so it was never found at all.
 *  A touch within touchTol counts as ONE crossing at the contact point.
 *  Crossings beyond `other`'s own extent (a segment's ends, an arc's sweep) are
 *  dropped. */
export function curveCrossings(on: Carrier2, other: Curve2): V[] {
  if (other.kind === "seg") {
    let pts: V[];
    if (on.kind === "line") {
      const x = lineIntersect(on.a, on.b, other.a, other.b);
      pts = x ? [x] : [];
    } else {
      pts = circleLineIntersect(other.a, other.b, on.c, on.r);
    }
    return pts.filter((p) => {
      const t = paramOnSeg(other.a, other.b, p);
      return t >= -1e-6 && t <= 1 + 1e-6;
    });
  }
  const pts = on.kind === "line"
    ? circleLineIntersect(on.a, on.b, other.c, other.r)
    : circleCircleIntersect(on.c, on.r, other.c, other.r);
  if (other.sweep >= TAU) return pts;
  // the same touchTol along the rim, so a crossing AT an arc's end still counts
  const slack = touchTol(other.r) / Math.max(other.r, 1e-9);
  return pts.filter((p) => {
    const at = ccwDelta(other.a0, Math.atan2(p.y - other.c.y, p.x - other.c.x));
    return at <= other.sweep + slack || at >= TAU - slack;
  });
}

/** parameter t in [0,1] of the closest point on segment p1p2 to q */
export function paramOnSeg(p1: Pt, p2: Pt, q: Pt): number {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy || 1;
  return ((q.x - p1.x) * dx + (q.y - p1.y) * dy) / len2;
}

/** distance from point q to segment p1p2 */
export function distToSeg(p1: Pt, p2: Pt, q: Pt): number {
  const t = Math.max(0, Math.min(1, paramOnSeg(p1, p2, q)));
  return Math.hypot(q.x - (p1.x + (p2.x - p1.x) * t), q.y - (p1.y + (p2.y - p1.y) * t));
}

/** Signed included angle (degrees, in (-180,180]) from line l1's direction to
 *  line l2's. Matches planegcs's l2l_angle sense, so seeding an angle dimension
 *  with it is a solve no-op. Used for the driving angle seed and the driven readout. */
export function signedAngleDeg(
  l1: { x1: number; y1: number; x2: number; y2: number },
  l2: { x1: number; y1: number; x2: number; y2: number },
): number {
  const a = Math.atan2(l1.y2 - l1.y1, l1.x2 - l1.x1);
  const b = Math.atan2(l2.y2 - l2.y1, l2.x2 - l2.x1);
  let d = ((b - a) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}
