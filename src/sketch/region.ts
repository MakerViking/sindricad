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
  loop: THREE.Vector2[]; // closed polygon (no repeated last point)
  centroid: THREE.Vector2;
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
  const regions: Region[] = [];
  // construction geometry is reference-only — it never forms a profile
  const entities = allEntities.filter((e) => !e.construction);

  // rectangles + circles: each is a closed loop on its own
  for (const e of entities) {
    if (e.type === "rectangle") {
      regions.push(mkRegion(sketchId, rectCorners(e.x, e.y, e.width, e.height)));
    } else if (e.type === "circle") {
      regions.push(mkRegion(sketchId, circleLoop(e.x, e.y, e.radius)));
    }
  }

  // line + arc + spline geometry: chain into closed loops via shared tessellation
  const segs: Seg[] = [];
  for (const e of entities) {
    if (e.type === "line" || e.type === "arc" || e.type === "spline") {
      for (const [a, b] of entitySegments(e)) {
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
  }
  for (const loop of traceLoops(segs)) {
    regions.push(mkRegion(sketchId, loop));
  }

  return regions;
}

function mkRegion(sketchId: string, loop: THREE.Vector2[]): Region {
  return { sketchId, loop, centroid: centroidOf(loop) };
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
