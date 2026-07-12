// Fit-point spline math: a Catmull-Rom curve interpolating the given points,
// sampled to a polyline for rendering, region tracing, and snapping. The
// sidecar builds the authoritative B-spline edge through the same fit points.

import * as THREE from "three";

type P = { x: number; y: number };

/** sample a Catmull-Rom spline through `pts` as a polyline (segsPerSpan per leg). */
export function splinePolyline(pts: P[], segsPerSpan = 16): THREE.Vector2[] {
  if (pts.length < 2) return pts.map((p) => new THREE.Vector2(p.x, p.y));
  if (pts.length === 2) {
    const [a, b] = pts;
    if (a && b) return [new THREE.Vector2(a.x, a.y), new THREE.Vector2(b.x, b.y)];
  }
  const out: THREE.Vector2[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    if (!p0 || !p1 || !p2 || !p3) continue;
    for (let s = 0; s < segsPerSpan; s++) {
      const t = s / segsPerSpan;
      out.push(catmull(p0, p1, p2, p3, t));
    }
  }
  const last = pts[n - 1];
  if (last) out.push(new THREE.Vector2(last.x, last.y));
  return out;
}

function catmull(p0: P, p1: P, p2: P, p3: P, t: number): THREE.Vector2 {
  const t2 = t * t, t3 = t2 * t;
  const c = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return new THREE.Vector2(c(p0.x, p1.x, p2.x, p3.x), c(p0.y, p1.y, p2.y, p3.y));
}
