// Fit-point spline math: a Catmull-Rom curve interpolating the given points,
// sampled to a polyline for rendering, region tracing, and snapping. A spline
// drawn with `asDrawn` (every one drawn since 2026-10) is built by the sidecar
// as exactly this curve, each span as its cubic Bezier (builder.py
// _catmull_rom_edge); an older one is built as the kernel's own B-spline
// through the same fit points, which is a different curve (see types.ts).

import * as THREE from "three";

type P = { x: number; y: number };

/** sample a Catmull-Rom spline through `pts` as a polyline (segsPerSpan per leg).
 *
 *  Open, the end spans reuse their end point as the missing neighbour, so the
 *  curve leaves its first point heading for the second ((p1 - p0) / 2), which
 *  is what a spline tangency holds (types.ts splineTangent). `closed` wraps the
 *  neighbours round instead: one more span, from the last point back to the
 *  first, and no kink there. A closed polyline ends on its first point again. */
export function splinePolyline(pts: P[], segsPerSpan = 16, closed = false): THREE.Vector2[] {
  if (pts.length < 2) return pts.map((p) => new THREE.Vector2(p.x, p.y));
  if (pts.length === 2 && !closed) {
    const [a, b] = pts;
    if (a && b) return [new THREE.Vector2(a.x, a.y), new THREE.Vector2(b.x, b.y)];
  }
  const out: THREE.Vector2[] = [];
  const n = pts.length;
  const at = (k: number) => (closed ? pts[((k % n) + n) % n] : pts[Math.min(n - 1, Math.max(0, k))]);
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    if (!p0 || !p1 || !p2 || !p3) continue;
    for (let s = 0; s < segsPerSpan; s++) {
      const t = s / segsPerSpan;
      out.push(catmull(p0, p1, p2, p3, t));
    }
  }
  const last = closed ? pts[0] : pts[n - 1];
  if (last) out.push(new THREE.Vector2(last.x, last.y));
  return out;
}

function catmull(p0: P, p1: P, p2: P, p3: P, t: number): THREE.Vector2 {
  const t2 = t * t, t3 = t2 * t;
  const c = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return new THREE.Vector2(c(p0.x, p1.x, p2.x, p3.x), c(p0.y, p1.y, p2.y, p3.y));
}

type SplineFlags = { asDrawn?: true; closed?: true };

/** A spline's build flags, to spread into a copy of it: a mirrored, patterned
 *  or offset copy has to build the way its source does. Omitted when false,
 *  like every persisted flag. */
export function splineFlags(e: SplineFlags): SplineFlags {
  return { ...(e.asDrawn ? { asDrawn: true } : {}), ...(e.closed ? { closed: true } : {}) };
}

/** The fit points that are a spline's ENDS, by index: its first and its last,
 *  or only its first when it is closed (it has no ends, and the first is the
 *  one point it exposes, as dimRefPoints numbers it 0). */
export function splineEndIndices(e: { points: readonly P[]; closed?: true }): number[] {
  const n = e.points.length;
  if (n === 0) return [];
  return e.closed || n === 1 ? [0] : [0, n - 1];
}
