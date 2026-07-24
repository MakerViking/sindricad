// Small 2D geometry helpers for the sketch modify tools (trim, fillet).

import * as THREE from "three";

type V = THREE.Vector2;
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

/** parameter t in [0,1] of the closest point on segment p1p2 to q */
export function paramOnSeg(p1: V, p2: V, q: V): number {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy || 1;
  return ((q.x - p1.x) * dx + (q.y - p1.y) * dy) / len2;
}

/** distance from point q to segment p1p2 */
export function distToSeg(p1: V, p2: V, q: V): number {
  const t = Math.max(0, Math.min(1, paramOnSeg(p1, p2, q)));
  return q.distanceTo(v(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t));
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
