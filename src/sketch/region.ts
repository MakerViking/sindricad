// Closed-region (profile) detection from resolved sketch entities. Rectangles
// and circles are their own loops; free line segments are chained into closed
// loops by shared endpoints. Each region yields a 2D loop polygon used for
// shading, hover-hit-testing, and the extrude live preview.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import { arcPolyline } from "./arc";
import { splinePolyline } from "./spline";

export interface Region {
  sketchId: string;
  loop: THREE.Vector2[]; // outer boundary, closed polygon (no repeated last point)
  holes: THREE.Vector2[][]; // inner boundaries (directly-nested loops) cut out of the material
  centroid: THREE.Vector2; // outer-loop centroid (label placement; may sit in a hole)
  interior: THREE.Vector2; // a point inside the material (outside all holes) — selection anchor
}

const EPS = 1e-4;
const CIRCLE_SEGS = 64;
const ARC_SEGS = 48;
const SPLINE_SEGS = 16;
const v = (x: number, y: number) => new THREE.Vector2(x, y);

/** The entity's curve as a single polyline, sampled at one consistent fidelity
 *  for ALL consumers (rendering, region tracing, picking, intersection). Closed
 *  primitives (rectangle/circle) include the closing vertex. This is the one
 *  place an entity is turned into points — consumers must not re-tessellate. */
export function entityPolyline(e: ResolvedEntity): THREE.Vector2[] {
  switch (e.type) {
    case "line":
      return [v(e.x1, e.y1), v(e.x2, e.y2)];
    case "rectangle": {
      const c = rectCorners(e.x, e.y, e.width, e.height);
      return [...c, c[0]];
    }
    case "circle": {
      const c = circleLoop(e.x, e.y, e.radius);
      return [...c, c[0]];
    }
    case "arc":
      return arcPolyline(v(e.x1, e.y1), v(e.x2, e.y2), v(e.mx, e.my), ARC_SEGS);
    case "spline":
      return splinePolyline(e.points, SPLINE_SEGS);
  }
}

/** consecutive segment pairs of the entity's polyline */
export function entitySegments(e: ResolvedEntity): [THREE.Vector2, THREE.Vector2][] {
  const p = entityPolyline(e);
  const out: [THREE.Vector2, THREE.Vector2][] = [];
  for (let i = 0; i < p.length - 1; i++) out.push([p[i], p[i + 1]]);
  return out;
}

/** four corners of an axis-aligned rectangle (CCW, no repeat) */
export function rectCorners(
  x: number,
  y: number,
  width: number,
  height: number,
): THREE.Vector2[] {
  const hw = width / 2;
  const hh = height / 2;
  return [
    new THREE.Vector2(x - hw, y - hh),
    new THREE.Vector2(x + hw, y - hh),
    new THREE.Vector2(x + hw, y + hh),
    new THREE.Vector2(x - hw, y + hh),
  ];
}

/** sample a circle as a closed polygon (no repeat) */
export function circleLoop(
  cx: number,
  cy: number,
  r: number,
  segs = CIRCLE_SEGS,
): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

export function detectRegions(
  sketchId: string,
  allEntities: ResolvedEntity[],
): Region[] {
  // construction geometry is reference-only — it never forms a profile
  const entities = allEntities.filter((e) => !e.construction);

  // 1. collect every closed loop: rectangles + circles are their own loops;
  //    line/arc/spline geometry is chained into closed loops by shared endpoints.
  const loops: THREE.Vector2[][] = [];
  for (const e of entities) {
    if (e.type === "rectangle") {
      loops.push(rectCorners(e.x, e.y, e.width, e.height));
    } else if (e.type === "circle") {
      loops.push(circleLoop(e.x, e.y, e.radius));
    }
  }
  const segs: Seg[] = [];
  for (const e of entities) {
    if (e.type === "line" || e.type === "arc" || e.type === "spline") {
      for (const [a, b] of entitySegments(e)) {
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
  }
  loops.push(...traceLoops(segs));

  // 2. each loop becomes a region; its DIRECTLY-nested loops become holes — so
  //    two concentric circles yield a ring (outer, hole=inner) AND a disk (inner).
  //    parent(i) = the smallest-area loop that contains loop i.
  const areas = loops.map(loopAbsArea);
  const parent = loops.map((loopI, i) => {
    let best = -1;
    let bestArea = Infinity;
    const p = representativePoint(loopI);
    for (let j = 0; j < loops.length; j++) {
      if (j === i || areas[j] <= areas[i]) continue;
      if (pointInLoop(p, loops[j]) && areas[j] < bestArea) {
        bestArea = areas[j];
        best = j;
      }
    }
    return best;
  });

  const regions: Region[] = [];
  for (let i = 0; i < loops.length; i++) {
    const holes = loops.filter((_, j) => parent[j] === i);
    regions.push(mkRegion(sketchId, loops[i], holes));
  }
  return regions;
}

function mkRegion(
  sketchId: string,
  loop: THREE.Vector2[],
  holes: THREE.Vector2[][],
): Region {
  const centroid = centroidOf(loop);
  return { sketchId, loop, holes, centroid, interior: interiorPoint(loop, holes, centroid) };
}

function centroidOf(loop: THREE.Vector2[]): THREE.Vector2 {
  const c = new THREE.Vector2();
  for (const p of loop) c.add(p);
  return c.divideScalar(loop.length || 1);
}

/** point-in-polygon (ray cast) in 2D */
export function pointInLoop(p: THREE.Vector2, loop: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** point is in the region's material: inside the outer loop, outside every hole */
export function pointInRegion(p: THREE.Vector2, region: Region): boolean {
  if (!pointInLoop(p, region.loop)) return false;
  return !region.holes.some((h) => pointInLoop(p, h));
}

/** absolute area of a closed polygon (shoelace) */
function loopAbsArea(loop: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    a += (loop[j].x + loop[i].x) * (loop[j].y - loop[i].y);
  }
  return Math.abs(a) / 2;
}

/** a point reliably inside a (convex-ish) loop, for the containment/nesting test */
function representativePoint(loop: THREE.Vector2[]): THREE.Vector2 {
  return centroidOf(loop); // circle/rectangle/most traced loops contain their centroid
}

/** A point inside the region's material (outside all holes), used as the parametric
 *  selection anchor. The outer-loop centroid sits in the hole for a ring, so fall
 *  back to sampling from the centroid toward each vertex. */
function interiorPoint(
  loop: THREE.Vector2[],
  holes: THREE.Vector2[][],
  centroid: THREE.Vector2,
): THREE.Vector2 {
  const ok = (p: THREE.Vector2) =>
    pointInLoop(p, loop) && !holes.some((h) => pointInLoop(p, h));
  if (ok(centroid)) return centroid;
  for (const t of [0.9, 0.75, 0.6, 0.5]) {
    for (const vtx of loop) {
      const p = new THREE.Vector2(
        centroid.x + (vtx.x - centroid.x) * t,
        centroid.y + (vtx.y - centroid.y) * t,
      );
      if (ok(p)) return p;
    }
  }
  return centroid; // best effort
}

// --- line-chain loop tracing ---
type Seg = { x1: number; y1: number; x2: number; y2: number };

function traceLoops(segs: Seg[]): THREE.Vector2[][] {
  if (segs.length < 3) return [];
  const key = (x: number, y: number) =>
    `${Math.round(x / EPS)},${Math.round(y / EPS)}`;

  // adjacency: node key -> list of neighbor keys (multiset; parallel edges kept)
  const nodes = new Map<string, THREE.Vector2>();
  const adj = new Map<string, string[]>();
  const link = (ax: number, ay: number, bx: number, by: number) => {
    const ka = key(ax, ay);
    const kb = key(bx, by);
    if (ka === kb) return; // drop zero-length segments (would self-loop a node)
    if (!nodes.has(ka)) nodes.set(ka, new THREE.Vector2(ax, ay));
    if (!nodes.has(kb)) nodes.set(kb, new THREE.Vector2(bx, by));
    (adj.get(ka) ?? adj.set(ka, []).get(ka)!).push(kb);
    (adj.get(kb) ?? adj.set(kb, []).get(kb)!).push(ka);
  };
  for (const s of segs) link(s.x1, s.y1, s.x2, s.y2);

  // 1. prune dangling chains: iteratively drop degree-1 nodes and their single
  //    incident edge until none remain. This removes overshoots / stray open
  //    segments so they no longer void the whole profile.
  const removeEdge = (a: string, b: string) => {
    const la = adj.get(a);
    if (la) { const i = la.indexOf(b); if (i >= 0) la.splice(i, 1); }
    const lb = adj.get(b);
    if (lb) { const i = lb.indexOf(a); if (i >= 0) lb.splice(i, 1); }
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [n, neigh] of adj) {
      if (neigh.length === 1) {
        removeEdge(n, neigh[0]);
        changed = true;
      }
    }
  }

  // 2. trace each remaining connected component as a simple cycle. Only the
  //    clean case (every surviving node has degree 2) yields a loop — this
  //    supports multiple disjoint profiles in one sketch. Junctions (degree > 2,
  //    e.g. self-intersections) are left for future planar-face work rather than
  //    voiding everything.
  const visited = new Set<string>();
  const loops: THREE.Vector2[][] = [];
  const guard = adj.size + 2;
  for (const [startKey, startNeigh] of adj) {
    if (startNeigh.length === 0 || visited.has(startKey)) continue;
    const loop: THREE.Vector2[] = [];
    let prev: string | null = null;
    let cur: string | null = startKey;
    let ok = true;
    for (let i = 0; i < guard && cur; i++) {
      const neigh: string[] = adj.get(cur)!;
      if (neigh.length !== 2) { ok = false; break; } // junction → skip component
      visited.add(cur);
      loop.push(nodes.get(cur)!);
      const next: string = neigh[0] === prev ? neigh[1] : neigh[0];
      prev = cur;
      cur = next;
      if (cur === startKey) break;
    }
    if (ok && loop.length >= 3) loops.push(loop);
  }
  return loops;
}
