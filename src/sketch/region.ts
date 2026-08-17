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
  /** ids of the entities whose curves bound this region's OUTER loop, sorted.
   *  This is what lets a stored region reference survive the user moving the
   *  entity (field report a20cca53): `interior` is a world point, so once the
   *  circle moves the point stays behind and resolves to whatever cell now
   *  contains it — the surrounding rectangle, in the reported case. Empty when
   *  provenance is not recoverable (a cell bounded by geometry the tracer
   *  deduped away); callers must fall back to the point rather than guess. */
  entityIds: string[];
  /** ids bounding each HOLE loop, parallel to `holes`.
   *
   *  Without these, `entityIds` names the outer loop ONLY, and a face rebuilt
   *  from it has no hole — so its centre lands INSIDE the hole and resolves to
   *  the wrong cell. That shipped: field report 19314fdc, "extrude the shell
   *  wall... the result is never the shell, but the inside loop extrusion".
   *  The sidecar's `len(faces) != 1` guard does not catch it, because a
   *  rectangle's outer loop alone bounds exactly one (solid) face. */
  holeEntityIds: string[][];
}

const EPS = 1e-4;
const CIRCLE_SEGS = 64;
const ARC_SEGS = 48;
const SPLINE_SEGS = 16;
const v = (x: number, y: number) => new THREE.Vector2(x, y);

/** append the first vertex to close a polygon; an empty input stays empty */
function closed(pts: THREE.Vector2[]): THREE.Vector2[] {
  const first = pts[0];
  return first ? [...pts, first] : pts;
}

/** The entity's curve as a single polyline, sampled at one consistent fidelity
 *  for ALL consumers (rendering, region tracing, picking, intersection). Closed
 *  primitives (rectangle/circle) include the closing vertex. This is the one
 *  place an entity is turned into points — consumers must not re-tessellate. */
export function entityPolyline(e: ResolvedEntity): THREE.Vector2[] {
  switch (e.type) {
    case "line":
      return [v(e.x1, e.y1), v(e.x2, e.y2)];
    case "rectangle":
      return closed(rectCorners(e.x, e.y, e.width, e.height));
    case "circle":
      return closed(circleLoop(e.x, e.y, e.radius));
    case "arc":
      return arcPolyline(v(e.x1, e.y1), v(e.x2, e.y2), v(e.mx, e.my), ARC_SEGS);
    case "spline":
      return splinePolyline(e.points, SPLINE_SEGS);
    case "point":
      return [v(e.x, e.y)]; // a point has no extent: a single vertex, no segments
    case "polygon":
      // e.angle is stored in DEGREES (like every other angle field); the math
      // helper below works in radians.
      return closed(polygonPoints(e.x, e.y, e.radius, e.sides, (e.angle * Math.PI) / 180));
    case "slot":
      return closed(slotOutline(e.x1, e.y1, e.x2, e.y2, e.width));
    case "text":
      return []; // text is rendered from cached glyph contours, not this single-polyline path
    case "projected":
      // the cached curve is already plain numbers — sample like the native kinds
      switch (e.curve.kind) {
        case "line":
          return [v(e.curve.x1, e.curve.y1), v(e.curve.x2, e.curve.y2)];
        case "circle":
          return closed(circleLoop(e.curve.x, e.curve.y, e.curve.r));
        case "arc":
          return arcPolyline(v(e.curve.x1, e.curve.y1), v(e.curve.x2, e.curve.y2), v(e.curve.mx, e.curve.my), ARC_SEGS);
        case "poly":
          return e.curve.pts.map(([x, y]) => v(x, y));
      }
  }
}

/** consecutive segment pairs of the entity's polyline */
export function entitySegments(e: ResolvedEntity): [THREE.Vector2, THREE.Vector2][] {
  const p = entityPolyline(e);
  const out: [THREE.Vector2, THREE.Vector2][] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    if (a && b) out.push([a, b]);
  }
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

/** vertices of a regular polygon (center, circumradius, sides, first-vertex angle) */
export function polygonPoints(cx: number, cy: number, r: number, sides: number, angle: number): THREE.Vector2[] {
  const n = Math.max(3, Math.round(sides));
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = angle + (i / n) * Math.PI * 2;
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

/** closed outline of a center-to-center slot: two straight sides + two end caps
 *  (arc centers A=(x1,y1), B=(x2,y2), overall width w). */
export function slotOutline(x1: number, y1: number, x2: number, y2: number, w: number, segs = 16): THREE.Vector2[] {
  const r = w / 2;
  let dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const ap = Math.atan2(dx, -dy); // angle of the left perpendicular (-dy, dx)
  const P = (cx: number, cy: number, a: number) => new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  const out: THREE.Vector2[] = [P(x1, y1, ap)]; // A + perp
  for (let i = 1; i <= segs; i++) out.push(P(x2, y2, ap - (i / segs) * Math.PI)); // B cap → B − perp
  for (let i = 0; i < segs; i++) out.push(P(x1, y1, ap + Math.PI - (i / segs) * Math.PI)); // A cap → toward A + perp
  return out;
}

export function detectRegions(
  sketchId: string,
  allEntities: ResolvedEntity[],
): Region[] {
  // construction geometry is reference-only — it never forms a profile. Text glyphs
  // are their own filled meshes (overlay), never part of line/arc region detection.
  const entities = allEntities.filter((e) => !e.construction && e.type !== "text");

  // Per-entity polyline segments + bbox, for cheap crossing detection and tracing.
  const perEntity = entities.map((e) => {
    const segs = entitySegments(e).map(
      ([a, b]) => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, eid: e.id }) as Seg,
    );
    return { e, segs, box: segsBBox(segs) };
  });

  // 1. collect every closed loop. Do any two entities' curves actually CROSS at
  //    an interior point (not merely meet at shared endpoints)? A crossing means
  //    simple whole-shape / shared-vertex detection would miss a sub-region — or
  //    emit a self-touching phantom (an "X" in a square) — so we planarize.
  let traced: TracedLoop[];
  if (anyCrossing(perEntity)) {
    // Split every segment at all pairwise interior intersections, then extract the
    // planar arrangement's minimal faces. This is what lets a line crossing a
    // profile carve it into separately-selectable sub-areas (MCAD parity); it
    // mirrors the sidecar's OCCT arrangement (builder.py _subdivide_faces).
    traced = traceLoops(planarize(perEntity));
  } else {
    // Fast path (unchanged for non-crossing sketches): rectangles + circles are
    // their own loops; free line/arc/spline geometry is chained into closed loops
    // by shared endpoints. The first three are 1:1 with an entity, so provenance
    // is exact; the chained loops get theirs from the tracer.
    traced = [];
    for (const { e } of perEntity) {
      if (e.type === "rectangle")
        traced.push({ loop: rectCorners(e.x, e.y, e.width, e.height), eids: [e.id] });
      else if (e.type === "circle")
        traced.push({ loop: circleLoop(e.x, e.y, e.radius), eids: [e.id] });
      // a projected CIRCLE is a closed loop of its own, like a native circle —
      // its polyline has no free endpoints for the chain tracer to join
      else if (e.type === "projected" && e.curve.kind === "circle")
        traced.push({ loop: circleLoop(e.curve.x, e.curve.y, e.curve.r), eids: [e.id] });
    }
    const free: Seg[] = [];
    for (const { e, segs } of perEntity)
      if (e.type === "line" || e.type === "arc" || e.type === "spline" ||
          (e.type === "projected" && e.curve.kind !== "circle"))
        free.push(...segs);
    traced.push(...traceLoops(free));
  }
  const loops = traced.map((t) => t.loop);

  // 2. each loop becomes a region; its DIRECTLY-nested loops become holes — so
  //    two concentric circles yield a ring (outer, hole=inner) AND a disk (inner).
  //    parent(i) = the smallest-area loop that contains loop i. Uses a guaranteed-
  //    interior point (not the centroid) so non-convex arrangement cells nest right.
  const areas = loops.map(loopAbsArea);
  const reps = loops.map(loopInteriorPoint);
  const parent = loops.map((_loopI, i) => {
    // reps/areas are parallel to loops, so index i is always valid
    const p = reps[i];
    const ai = areas[i];
    if (!p || ai === undefined) return -1;
    let best = -1;
    let bestArea = Infinity;
    for (let j = 0; j < loops.length; j++) {
      const aj = areas[j];
      const lj = loops[j];
      if (j === i || aj === undefined || lj === undefined || aj <= ai) continue;
      if (pointInLoop(p, lj) && aj < bestArea) {
        bestArea = aj;
        best = j;
      }
    }
    return best;
  });

  const regions: Region[] = [];
  for (let i = 0; i < loops.length; i++) {
    const loop = loops[i];
    if (!loop) continue;
    const holeIdx = loops.map((_, j) => j).filter((j) => parent[j] === i);
    const holes = holeIdx.map((j) => loops[j]!);
    // the holes' OWN bounding entities, so a stored reference can rebuild the
    // face WITH its holes — see holeEntityIds
    const holeEntityIds = holeIdx.map((j) => traced[j]?.eids ?? []);
    regions.push(mkRegion(sketchId, loop, holes, traced[i]?.eids ?? [], holeEntityIds));
  }
  return regions;
}

function mkRegion(
  sketchId: string,
  loop: THREE.Vector2[],
  holes: THREE.Vector2[][],
  entityIds: string[],
  holeEntityIds: string[][] = [],
): Region {
  const centroid = centroidOf(loop);
  return {
    sketchId, loop, holes, centroid,
    interior: interiorPoint(loop, holes, centroid),
    entityIds, holeEntityIds,
  };
}

/** Build a selectable Region from one tessellated glyph face (outer boundary +
 *  holes, in sketch-2D mm). Text skips the line/arc arrangement entirely — its
 *  faces arrive pre-formed from the sidecar's font tessellation (cached client-
 *  side), so each glyph face becomes its own extrudable profile. */
export function glyphRegion(
  sketchId: string,
  outer: [number, number][],
  holes: [number, number][][],
  entityId?: string,
): Region {
  const loop = outer.map(([x, y]) => new THREE.Vector2(x, y));
  const holeLoops = holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
  return mkRegion(sketchId, loop, holeLoops, entityId === undefined ? [] : [entityId]);
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
    if (!a || !b) continue;
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

/** unordered id-set equality. The tracer sorts its ids (`[...eids].sort()`) but
 *  the fast path and glyphRegion emit singletons unsorted, and a stored reference
 *  is only as ordered as whatever wrote it — so identity is compared as a SET. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size !== B.size) return false;
  for (const id of A) if (!B.has(id)) return false;
  return true;
}

/** Do two lists of hole-id groups describe the same holes? Order-insensitive on
 *  BOTH levels: hole order follows loop-discovery order, so reordering the
 *  entities in a sketch reorders the holes without changing the geometry. */
function sameHoleIds(a: readonly string[][], b: readonly string[][]): boolean {
  if (a.length !== b.length) return false;
  const spare = [...b];
  for (const grp of a) {
    const i = spare.findIndex((s) => sameIds(grp, s));
    if (i < 0) return false;
    spare.splice(i, 1);
  }
  return true;
}

/** The regions bounded by exactly these entities — how a stored region reference
 *  is resolved once the geometry it was picked on has MOVED.
 *
 *  `interior` is a world point and a point does not move with the circle it was
 *  inside (field report a20cca53); worse, on a holed profile the stale point can
 *  land in the HOLE, and `pointInRegion` then happily resolves it to the hole's
 *  own cell (field 19314fdc). The entity ids survive the move, so they are asked
 *  first and the point is only ever a tie-break between cells the ids already
 *  permit.
 *
 *  The OUTER loop decides; `holeEids` only narrows a tie, and never rules a
 *  candidate out on its own. That is deliberate: the hole set is the part most
 *  likely to have legitimately changed since the reference was saved (a hole
 *  added or removed, or — for every document written between 0.1.123 and the
 *  release that added `regionHoleEntities` — never recorded at all). Demanding
 *  hole equality would push those references back onto the stale point, which is
 *  the exact corruption this exists to remove. Passing `undefined` means "cannot
 *  discriminate", which is NOT the same as passing `[]` ("this region has no
 *  holes").
 *
 *  Several results mean the ids genuinely cannot tell the cells apart — a line
 *  splitting a square gives both halves the SAME entity set, and every glyph of
 *  one text carries that text's single id. The sidecar refuses outright there
 *  (`len(faces) != 1` in `_region_anchor_from_entities`) and falls back to the
 *  stored point; the caller here does the same, and safely, because the point can
 *  only choose among cells the ids already allow. Zero results mean the ids name
 *  nothing live: the sketch really changed, and the caller must say so rather
 *  than guess. */
export function regionsByEntities(
  regions: readonly Region[],
  eids: readonly string[],
  holeEids?: readonly string[][],
): Region[] {
  if (!eids.length) return [];
  const byOuter = regions.filter((r) => sameIds(r.entityIds, eids));
  if (byOuter.length < 2 || holeEids === undefined) return byOuter;
  const byHoles = byOuter.filter((r) => sameHoleIds(r.holeEntityIds, holeEids));
  return byHoles.length ? byHoles : byOuter;
}

/** absolute area of a closed polygon (shoelace) */
function loopAbsArea(loop: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const pi = loop[i], pj = loop[j];
    if (!pi || !pj) continue;
    a += (pj.x + pi.x) * (pj.y - pi.y);
  }
  return Math.abs(a) / 2;
}

/** A point guaranteed inside a loop (ignoring holes), for the containment/nesting
 *  test. The centroid works for convex loops (circle/rectangle/triangle); for a
 *  non-convex arrangement cell it can fall outside, so fall back to sampling from
 *  the centroid toward each vertex until a point lands inside. */
function loopInteriorPoint(loop: THREE.Vector2[]): THREE.Vector2 {
  const c = centroidOf(loop);
  if (pointInLoop(c, loop)) return c;
  for (const t of [0.5, 0.6, 0.75, 0.9]) {
    for (const vtx of loop) {
      const p = new THREE.Vector2(c.x + (vtx.x - c.x) * t, c.y + (vtx.y - c.y) * t);
      if (pointInLoop(p, loop)) return p;
    }
  }
  return c; // best effort
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
  // Ray-sampling toward the outer vertices can't reach the material of a THIN
  // ring: every centroid→vertex sample up to t=0.9 still lands inside the hole
  // (inner_r/outer_r > 0.9). Falling through to `centroid` returned a point in
  // the HOLE — which then highlighted/extruded the inner disk instead of the
  // ring (field bug: "selecting the outer ring selects the inner circle").
  // Scanline fallback: on a horizontal line across the region, the midpoint
  // between two consecutive boundary crossings that lands outside every hole is
  // guaranteed to be in the material. Try several heights so a line that only
  // grazes a hole's extreme isn't the sole chance.
  let minY = Infinity, maxY = -Infinity;
  for (const p of loop) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const rings = [loop, ...holes];
  for (const frac of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
    const y = minY + (maxY - minY) * frac;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if (!a || !b) continue;
        if ((a.y > y) !== (b.y > y)) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k++) {
      const xk = xs[k], xk1 = xs[k + 1];
      if (xk === undefined || xk1 === undefined) continue;
      const p = new THREE.Vector2((xk + xk1) / 2, y);
      if (ok(p)) return p;
    }
  }
  return centroid; // best effort
}

// --- line-chain loop tracing ---
type Seg = { x1: number; y1: number; x2: number; y2: number; eid?: string | undefined };
type Box = { minx: number; miny: number; maxx: number; maxy: number };

function segsBBox(segs: Seg[]): Box {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const s of segs) {
    minx = Math.min(minx, s.x1, s.x2);
    miny = Math.min(miny, s.y1, s.y2);
    maxx = Math.max(maxx, s.x1, s.x2);
    maxy = Math.max(maxy, s.y1, s.y2);
  }
  return { minx, miny, maxx, maxy };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return (
    a.minx <= b.maxx + EPS && b.minx <= a.maxx + EPS &&
    a.miny <= b.maxy + EPS && b.miny <= a.maxy + EPS
  );
}

/** Interior crossing point of two segments — where both segments cross strictly
 *  inside their spans (not merely touching at a shared endpoint, and not parallel/
 *  collinear). Returns null otherwise. This is the geometry the vertex-only tracer
 *  can't see. */
function segCross(a: Seg, b: Seg): THREE.Vector2 | null {
  const rx = a.x2 - a.x1, ry = a.y2 - a.y1;
  const sx = b.x2 - b.x1, sy = b.y2 - b.y1;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel / collinear
  const qpx = b.x1 - a.x1, qpy = b.y1 - a.y1;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  const E = 1e-6;
  if (t <= E || t >= 1 - E || u <= E || u >= 1 - E) return null; // interior of BOTH only
  return v(a.x1 + t * rx, a.y1 + t * ry);
}

/** Param t ∈ (E, 1-E) if point (px,py) lies on segment s strictly between its
 *  endpoints (within EPS), else null. Detects T-junctions: one entity's VERTEX
 *  touching another's edge interior — e.g. a hexagon whose corner sits on a
 *  boundary rectangle's edge. OCCT splits there, so we must too, or the frontend
 *  region and the sidecar cell disagree. */
function pointOnSegInterior(px: number, py: number, s: Seg): number | null {
  const rx = s.x2 - s.x1, ry = s.y2 - s.y1;
  const len2 = rx * rx + ry * ry;
  if (len2 < 1e-18) return null;
  const t = ((px - s.x1) * rx + (py - s.y1) * ry) / len2;
  const E = 1e-6;
  if (t <= E || t >= 1 - E) return null;
  const dx = px - (s.x1 + t * rx), dy = py - (s.y1 + t * ry); // offset from the line
  return dx * dx + dy * dy > EPS * EPS ? null : t;
}

type EntSegs = { segs: Seg[]; box: Box };

/** Do any two entities' curves meet at a point that isn't a shared endpoint —
 *  an interior crossing (X) or a vertex-on-edge touch (T)? Entity-bbox broad-phase
 *  keeps this cheap: separated entities (a grid of holes) never reach the O(segs²)
 *  inner test, so the common non-crossing sketch pays almost nothing. */
function anyCrossing(per: EntSegs[]): boolean {
  for (let i = 0; i < per.length; i++) {
    const pi = per[i];
    if (!pi) continue;
    for (let j = i + 1; j < per.length; j++) {
      const pj = per[j];
      if (!pj || !boxesOverlap(pi.box, pj.box)) continue;
      for (const a of pi.segs)
        for (const b of pj.segs) {
          if (segCross(a, b)) return true;
          if (pointOnSegInterior(b.x1, b.y1, a) !== null) return true;
          if (pointOnSegInterior(b.x2, b.y2, a) !== null) return true;
          if (pointOnSegInterior(a.x1, a.y1, b) !== null) return true;
          if (pointOnSegInterior(a.x2, a.y2, b) !== null) return true;
        }
    }
  }
  return false;
}

/** Split every segment at its interior intersections AND at any other entity's
 *  vertex that lands on its interior, so each crossing/touch becomes a shared
 *  vertex the half-edge tracer can split at. Same entity-bbox broad-phase as
 *  anyCrossing. */
function planarize(per: EntSegs[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < per.length; i++) {
    const pi = per[i];
    if (!pi) continue;
    for (const a of pi.segs) {
      const rx = a.x2 - a.x1, ry = a.y2 - a.y1;
      const len2 = rx * rx + ry * ry;
      const cuts: { x: number; y: number; t: number }[] = [];
      const addCut = (x: number, y: number) =>
        cuts.push({ x, y, t: ((x - a.x1) * rx + (y - a.y1) * ry) / len2 });
      for (let j = 0; j < per.length; j++) {
        const pj = per[j];
        if (j === i || !pj || !boxesOverlap(pi.box, pj.box)) continue;
        for (const b of pj.segs) {
          const p = segCross(a, b);
          if (p) addCut(p.x, p.y);
          if (pointOnSegInterior(b.x1, b.y1, a) !== null) addCut(b.x1, b.y1);
          if (pointOnSegInterior(b.x2, b.y2, a) !== null) addCut(b.x2, b.y2);
        }
      }
      if (!cuts.length) { out.push(a); continue; }
      cuts.sort((p, q) => p.t - q.t);
      let px = a.x1, py = a.y1;
      for (const c of cuts) {
        if (Math.abs(c.x - px) > EPS || Math.abs(c.y - py) > EPS)
          out.push({ x1: px, y1: py, x2: c.x, y2: c.y, eid: a.eid });
        px = c.x; py = c.y;
      }
      if (Math.abs(a.x2 - px) > EPS || Math.abs(a.y2 - py) > EPS)
        out.push({ x1: px, y1: py, x2: a.x2, y2: a.y2, eid: a.eid });
    }
  }
  return out;
}


/** One minimal face of the planar arrangement, plus the entities that bound it. */
type TracedLoop = { loop: THREE.Vector2[]; eids: string[] };

function traceLoops(segs: Seg[]): TracedLoop[] {
  if (segs.length < 3) return [];
  const key = (x: number, y: number) =>
    `${Math.round(x / EPS)},${Math.round(y / EPS)}`;

  // Build a planar graph and extract its MINIMAL FACES via half-edge traversal. Unlike
  // simple cycle-tracing this handles JUNCTIONS (degree > 2) — shared hexagon vertices,
  // touching profiles, T-joins — splitting them into the right areas instead of voiding
  // the whole component. This is MCAD-style profile detection.
  const nodes = new Map<string, THREE.Vector2>();
  const nodeKey = (x: number, y: number) => {
    const k = key(x, y);
    if (!nodes.has(k)) nodes.set(k, new THREE.Vector2(x, y));
    return k;
  };
  // one undirected edge per coincident segment (dedupe shared edges), as 2 half-edges
  // pushed as adjacent pairs (2k = a→b, 2k+1 = b→a) so the twin is just `i ^ 1`.
  // `eid` rides along so a traced face can name the entities that bound it. Where
  // two entities lay down a coincident edge the dedupe keeps the first — a shared
  // boundary genuinely belongs to both, and either id re-derives the same point.
  const he: { from: string; to: string; angle: number; eid?: string | undefined }[] = [];
  const seen = new Set<string>();
  for (const s of segs) {
    const a = nodeKey(s.x1, s.y1), b = nodeKey(s.x2, s.y2);
    if (a === b) continue;
    const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(ek)) continue;
    seen.add(ek);
    const pa = nodes.get(a)!, pb = nodes.get(b)!;
    he.push({ from: a, to: b, angle: Math.atan2(pb.y - pa.y, pb.x - pa.x), eid: s.eid });
    he.push({ from: b, to: a, angle: Math.atan2(pa.y - pb.y, pa.x - pb.x), eid: s.eid });
  }
  if (he.length < 6) return [];

  // outgoing half-edge indices per node, sorted CCW by angle
  const out = new Map<string, number[]>();
  he.forEach((h, i) => (out.get(h.from) ?? out.set(h.from, []).get(h.from)!).push(i));
  for (const idxs of out.values())
    idxs.sort((i, j) => (he[i]?.angle ?? 0) - (he[j]?.angle ?? 0));
  // next half-edge in the same minimal face = the edge just clockwise of this edge's twin
  const next = (i: number): number | undefined => {
    const h = he[i];
    if (!h) return undefined;
    const idxs = out.get(h.to);
    if (!idxs) return undefined;
    const pos = idxs.indexOf(i ^ 1); // twin
    return idxs[(pos - 1 + idxs.length) % idxs.length];
  };

  const visited = new Set<number>();
  const loops: TracedLoop[] = [];
  for (let s = 0; s < he.length; s++) {
    if (visited.has(s)) continue;
    const faceHE: number[] = [];
    let cur: number | undefined = s;
    let guard = 0;
    while (cur !== undefined && !visited.has(cur) && guard++ < he.length + 2) {
      visited.add(cur);
      faceHE.push(cur);
      cur = next(cur);
    }
    if (cur !== s || faceHE.length < 3) continue;
    const pts: THREE.Vector2[] = [];
    const eids = new Set<string>();
    for (const hi of faceHE) {
      const h = he[hi];
      if (!h) continue;
      pts.push(nodes.get(h.from)!);
      if (h.eid !== undefined) eids.add(h.eid);
    }
    // keep CCW (interior) faces; the outer/unbounded face is CW (negative area)
    if (signedLoopArea(pts) > EPS) loops.push({ loop: pts, eids: [...eids].sort() });
  }
  return loops;
}

function signedLoopArea(loop: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const pi = loop[i], pj = loop[j];
    if (!pi || !pj) continue;
    a += pj.x * pi.y - pi.x * pj.y;
  }
  return a / 2;
}
