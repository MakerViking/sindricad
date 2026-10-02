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

/** center + radius of a 3-point arc entity (start/end + through-point), or null
 *  if the three points are collinear. One place for the reconstruction every
 *  arc consumer (dimensions, modify tools, fix) otherwise re-inlines. */
export function arcCenterRadius(
  e: { x1: number; y1: number; x2: number; y2: number; mx: number; my: number },
): { c: THREE.Vector2; r: number } | null {
  const c = circumcenter({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: e.mx, y: e.my });
  return c ? { c, r: Math.hypot(e.x1 - c.x, e.y1 - c.y) } : null;
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

// --- centre-point arc ---------------------------------------------------------
//
// Click the centre, click the start (which sets the radius), then sweep to the
// end. It builds the SAME 3-point arc entity as the 3-point tool (start, end,
// and the point at mid-sweep as the through-point), so nothing downstream knows
// or cares which tool drew it.

const TAU = Math.PI * 2;
/** A sweep of a whole turn puts the end back on the start: a circle, which is
 *  what the Circle tool is for. Stopping a degree short keeps the two endpoints
 *  apart, so the solver never merges them into one point. */
export const MAX_CENTER_ARC_SWEEP = TAU * (359 / 360);

/** Follow the cursor round a centre-point arc. `sweep` is the running signed
 *  angle (radians, + = counter-clockwise) from the start direction; the result
 *  is the angle to the cursor that lies NEAREST it, so the arc keeps going the
 *  way the cursor went — past 180 degrees and on — instead of flipping to the
 *  short way round as an atan2 would. A cursor on the centre has no direction
 *  and leaves the sweep where it was. */
export function advanceCenterArcSweep(
  sweep: number,
  center: { x: number; y: number },
  start: { x: number; y: number },
  cursor: { x: number; y: number },
): number {
  const sx = start.x - center.x, sy = start.y - center.y;
  const cx = cursor.x - center.x, cy = cursor.y - center.y;
  if (Math.hypot(cx, cy) < 1e-9) return sweep;
  const theta = Math.atan2(sx * cy - sy * cx, sx * cx + sy * cy); // (-π, π] from the start
  const step = theta - sweep;
  const next = sweep + (step - TAU * Math.round(step / TAU));
  return Math.max(-MAX_CENTER_ARC_SWEEP, Math.min(MAX_CENTER_ARC_SWEEP, next));
}

/** The 3-point arc a centre-point arc describes: the end, `sweep` radians round
 *  from the start, and the through-point halfway along — which is what tells
 *  arcPolyline (and the sidecar) which way round the arc goes. */
export function centerArcEntity(
  center: { x: number; y: number },
  start: { x: number; y: number },
  sweep: number,
): { x1: number; y1: number; x2: number; y2: number; mx: number; my: number } {
  const at = (a: number) => {
    const dx = start.x - center.x, dy = start.y - center.y;
    const c = Math.cos(a), s = Math.sin(a);
    return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
  };
  const end = at(sweep);
  const mid = at(sweep / 2);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y, mx: mid.x, my: mid.y };
}
