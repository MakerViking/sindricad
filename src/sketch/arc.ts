// 3-point arc math (start, end, and a point the arc passes through). Shared by
// rendering (overlay), region tessellation, snapping, and dimensions. The
// sidecar builds the authoritative B-rep arc edge from the same three points.

import * as THREE from "three";

/** circumcenter of three 2D points, or null if they're collinear */
export function circumcenter(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): THREE.Vector2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return new THREE.Vector2(ux, uy);
}

export function arcRadius(
  start: THREE.Vector2,
  end: THREE.Vector2,
  through: THREE.Vector2,
): number {
  const c = circumcenter(start, end, through);
  return c ? c.distanceTo(start) : 0;
}

/** sample the arc start → through → end as a polyline of n+1 points */
export function arcPolyline(
  start: THREE.Vector2,
  end: THREE.Vector2,
  through: THREE.Vector2,
  n = 48,
): THREE.Vector2[] {
  const c = circumcenter(start, end, through);
  if (!c) return [start.clone(), end.clone()]; // collinear → straight
  const r = c.distanceTo(start);
  const ang = (p: THREE.Vector2) => Math.atan2(p.y - c.y, p.x - c.x);
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const a0 = ang(start);
  const dThrough = norm(ang(through) - a0);
  const dEnd = norm(ang(end) - a0);
  // sweep CCW if `through` lies on the CCW path to `end`, else CW
  const sweep = dThrough <= dEnd ? dEnd : dEnd - TAU;
  const out: THREE.Vector2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * (i / n);
    out.push(new THREE.Vector2(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r));
  }
  return out;
}
