// Compile the active sketch's geometry + its constraint list into the solver
// model, solve, and write the solved positions back into the entities.
//
// Points: endpoints that should coincide (line/arc endpoints, rectangle corners,
// spline end fit-points) are "mergeable" — two at the same position become one
// shared solver point, so constraints + drags move connected geometry together.
// Non-endpoint points (circle/arc centers, interior spline points) get their own
// identity so they never accidentally fuse with unrelated geometry.
//
// Entities are addressed by their stable id (solver primitive id === entity id),
// so constraints — which reference entity ids — map straight through, and any
// constraint pointing at a missing/wrong-type entity is simply skipped.
//
// A rectangle is expanded here into 4 corner points + 4 implicit edges with
// horizontal/vertical rules, so a rectangle (drawn or loaded) stays rectangular
// under dragging while remaining a single atomic entity in the document.

import type { ResolvedEntity } from "./snap";
import { solveSketch, type SConstraint, type SPoint, type SLine, type SCircle, type SArc } from "./solver";
import { circumcenter } from "./arc";
import { rectCorners } from "./region";
import type { SketchConstraint } from "../types";

export interface SolvePass {
  entities: ResolvedEntity[];
  dof: number;
  ok: boolean;
  conflicts: string[];
}

const TAU = Math.PI * 2;
const ccwDelta = (from: number, to: number) => ((to - from) % TAU + TAU) % TAU;

export async function compileAndSolve(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  drag?: { fromX: number; fromY: number; toX: number; toY: number },
): Promise<SolvePass> {
  const points: SPoint[] = [];
  const pointByKey = new Map<string, string>();
  const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  // mergeable points coincide by position (shared corners); unique points (centers,
  // interior spline points) always get their own identity — see file header.
  const getPoint = (x: number, y: number, mergeable = true): string => {
    if (mergeable) {
      const existing = pointByKey.get(key(x, y));
      if (existing) return existing;
    }
    const id = `P${points.length}`;
    if (mergeable) pointByKey.set(key(x, y), id);
    points.push({ id, x, y });
    return id;
  };

  const lines: SLine[] = [];
  const circles: SCircle[] = [];
  const arcs: SArc[] = [];
  const cons: SConstraint[] = [];
  const ends = new Map<string, [string, string]>(); // line entity id -> [p1, p2]
  const centers = new Map<string, string>(); // circle entity id -> center point
  // arc entity id -> our endpoints (entity x1y1/x2y2), solved center, sweep start
  const arcMap = new Map<string, { ourS: string; ourE: string; center: string; startIsOurS: boolean }>();
  const splineMap = new Map<string, string[]>(); // spline entity id -> fit-point ids
  const rectMap = new Map<string, string[]>(); // rectangle entity id -> 4 corner points
  const pointMap = new Map<string, string>(); // point entity id -> its solver point

  for (const e of entities) {
    if (e.type === "line") {
      const p1 = getPoint(e.x1, e.y1);
      const p2 = getPoint(e.x2, e.y2);
      lines.push({ id: e.id, p1, p2 });
      ends.set(e.id, [p1, p2]);
    } else if (e.type === "circle") {
      const c = getPoint(e.x, e.y, false); // center is not an endpoint
      circles.push({ id: e.id, center: c, radius: e.radius });
      centers.set(e.id, c);
    } else if (e.type === "rectangle") {
      const corner = rectCorners(e.x, e.y, e.width, e.height); // CCW: bl, br, tr, tl
      const cp = corner.map((p) => getPoint(p.x, p.y, true));
      for (let k = 0; k < 4; k++) {
        const a = cp[k], b = cp[(k + 1) % 4];
        if (a === undefined || b === undefined) continue;
        lines.push({ id: `${e.id}~${k}`, p1: a, p2: b });
      }
      cons.push({ id: `${e.id}~h0`, type: "horizontal", line: `${e.id}~0` }); // bottom
      cons.push({ id: `${e.id}~h2`, type: "horizontal", line: `${e.id}~2` }); // top
      cons.push({ id: `${e.id}~v1`, type: "vertical", line: `${e.id}~1` }); // right
      cons.push({ id: `${e.id}~v3`, type: "vertical", line: `${e.id}~3` }); // left
      rectMap.set(e.id, cp);
    } else if (e.type === "arc") {
      const cc = circumcenter({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: e.mx, y: e.my });
      if (!cc) continue; // collinear/degenerate — leave untouched
      const radius = Math.hypot(e.x1 - cc.x, e.y1 - cc.y);
      const ourS = getPoint(e.x1, e.y1);
      const ourE = getPoint(e.x2, e.y2);
      const center = getPoint(cc.x, cc.y, false); // arc center is not an endpoint
      const aS = Math.atan2(e.y1 - cc.y, e.x1 - cc.x);
      const aE = Math.atan2(e.y2 - cc.y, e.x2 - cc.x);
      const aT = Math.atan2(e.my - cc.y, e.mx - cc.x);
      // orient the arc CCW so its sweep passes through the through-point
      const ccwThroughFromStart = ccwDelta(aS, aT) <= ccwDelta(aS, aE);
      const start = ccwThroughFromStart ? ourS : ourE;
      const startA = ccwThroughFromStart ? aS : aE;
      const end = ccwThroughFromStart ? ourE : ourS;
      const endA = ccwThroughFromStart ? aE : aS;
      arcs.push({
        id: e.id, center, start, end, radius,
        startAngle: startA, endAngle: startA + ccwDelta(startA, endA),
      });
      arcMap.set(e.id, { ourS, ourE, center, startIsOurS: ccwThroughFromStart });
    } else if (e.type === "spline") {
      // endpoints are mergeable (chain with lines); interior points are unique
      const last = e.points.length - 1;
      splineMap.set(e.id, e.points.map((p, k) => getPoint(p.x, p.y, k === 0 || k === last)));
    } else if (e.type === "point") {
      // a sketch point is mergeable so it can snap onto / coincide with geometry
      pointMap.set(e.id, getPoint(e.x, e.y, true));
    }
  }

  const isLine = (id: string) => ends.has(id);
  // resolve an entity endpoint (0 = start, 1 = end) to its solver point id.
  // lines + arcs have two endpoints; a point entity has just one (index ignored).
  const endpointPoint = (entId: string, idx: number): string | undefined => {
    const ln = ends.get(entId);
    if (ln) return idx === 0 ? ln[0] : ln[1];
    const ar = arcMap.get(entId);
    if (ar) return idx === 0 ? ar.ourS : ar.ourE;
    const pt = pointMap.get(entId);
    if (pt) return pt;
    const sp = splineMap.get(entId);
    if (sp) return idx === 0 ? sp[0] : sp[sp.length - 1];
    return undefined;
  };
  // resolve a circle/arc center to its solver point id
  const centerPoint = (entId: string): string | undefined =>
    centers.get(entId) ?? arcMap.get(entId)?.center;
  // resolve a dimension pick: rectangle corners by index, circle centers
  // regardless of index, arc center at index 2, else entity endpoints
  const dimPoint = (entId: string, idx: number): string | undefined => {
    const rc = rectMap.get(entId);
    if (rc) return rc[idx];
    if (centers.has(entId)) return centers.get(entId);
    if (idx === 2) return arcMap.get(entId)?.center;
    return endpointPoint(entId, idx);
  };
  const isCircle = (id: string) => centers.has(id);
  constraints.forEach((c, i) => {
    const id = `k${i}`; // user constraint ids never collide with `~` implicit ones
    if (c.type === "horizontal") { if (isLine(c.line)) cons.push({ id, type: "horizontal", line: c.line }); }
    else if (c.type === "vertical") { if (isLine(c.line)) cons.push({ id, type: "vertical", line: c.line }); }
    else if (c.type === "parallel") { if (isLine(c.l1) && isLine(c.l2)) cons.push({ id, type: "parallel", l1: c.l1, l2: c.l2 }); }
    else if (c.type === "perpendicular") { if (isLine(c.l1) && isLine(c.l2)) cons.push({ id, type: "perpendicular", l1: c.l1, l2: c.l2 }); }
    else if (c.type === "equal") { if (isLine(c.l1) && isLine(c.l2)) cons.push({ id, type: "equal", l1: c.l1, l2: c.l2 }); }
    else if (c.type === "distance") { const e = ends.get(c.line); if (e) cons.push({ id, type: "distance", a: e[0], b: e[1], value: c.value }); }
    else if (c.type === "p2pDistance") {
      const a = dimPoint(c.e1, c.p1), b = dimPoint(c.e2, c.p2);
      if (a && b && a !== b) cons.push({ id, type: "distance", a, b, value: c.value });
    }
    else if (c.type === "p2lDistance") {
      const p = dimPoint(c.e, c.p);
      if (p && isLine(c.line)) cons.push({ id, type: "p2lDistance", p, line: c.line, value: c.value });
    }
    else if (c.type === "diameter") { if (centers.has(c.circle)) cons.push({ id, type: "diameter", circle: c.circle, value: c.value }); }
    else if (c.type === "tangent") { if (isLine(c.line) && isCircle(c.circle)) cons.push({ id, type: "tangentLC", line: c.line, circle: c.circle }); }
    else if (c.type === "coincident") {
      const a = endpointPoint(c.e1, c.p1), b = endpointPoint(c.e2, c.p2);
      if (a && b) cons.push({ id, type: "coincident", a, b });
    }
    else if (c.type === "concentric") {
      const a = centerPoint(c.c1), b = centerPoint(c.c2);
      if (a && b) cons.push({ id, type: "coincident", a, b });
    }
    else if (c.type === "midpoint") {
      const p = endpointPoint(c.e, c.p);
      if (p && isLine(c.line)) {
        cons.push({ id: `${id}a`, type: "pointOnLine", p, line: c.line });
        cons.push({ id: `${id}b`, type: "pointOnPerpBisector", p, line: c.line });
      }
    }
    else if (c.type === "symmetric") {
      const a = endpointPoint(c.e1, c.p1), b = endpointPoint(c.e2, c.p2);
      if (a && b && isLine(c.line)) cons.push({ id, type: "symmetric", a, b, line: c.line });
    }
  });

  let dragInput: { point: string; x: number; y: number } | undefined;
  if (drag) {
    // Pin whichever solver point sits nearest the grab position. Coincident
    // endpoints have merged into one point, so a grabbed corner moves as a unit.
    let best: SPoint | null = null;
    let bestD = Infinity;
    for (const p of points) {
      const dx = p.x - drag.fromX, dy = p.y - drag.fromY;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) dragInput = { point: best.id, x: drag.toX, y: drag.toY };
  }

  const r = await solveSketch({ points, lines, circles, arcs, constraints: cons, ...(dragInput ? { drag: dragInput } : {}) });

  const out = entities.map((e): ResolvedEntity => {
    if (e.type === "line") {
      const [p1, p2] = ends.get(e.id)!;
      const a = r.points[p1], b = r.points[p2];
      return a && b ? { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y } : e;
    }
    if (e.type === "circle") {
      const c = r.points[centers.get(e.id)!];
      const rad = r.circles[e.id];
      return c ? { ...e, x: c.x, y: c.y, radius: rad ?? e.radius } : e;
    }
    if (e.type === "rectangle") {
      const cp = rectMap.get(e.id);
      const pts = cp?.map((id) => r.points[id]);
      if (!pts || pts.some((p) => !p)) return e;
      const xs = pts.map((p) => p!.x), ys = pts.map((p) => p!.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      return { ...e, x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
    }
    if (e.type === "arc") {
      const m = arcMap.get(e.id);
      if (!m) return e; // wasn't solved (degenerate)
      const s = r.points[m.ourS], en = r.points[m.ourE], c = r.points[m.center];
      if (!s || !en || !c) return e;
      // recompute the through-point as the arc's mid-sweep, from the solved
      // endpoints + center (robust to angle normalisation in the solver)
      const rad = r.arcs[e.id]?.radius ?? Math.hypot(s.x - c.x, s.y - c.y);
      const [from, to] = m.startIsOurS ? [s, en] : [en, s];
      const aFrom = Math.atan2(from.y - c.y, from.x - c.x);
      const aTo = Math.atan2(to.y - c.y, to.x - c.x);
      const midA = aFrom + ccwDelta(aFrom, aTo) / 2;
      return {
        ...e, x1: s.x, y1: s.y, x2: en.x, y2: en.y,
        mx: c.x + Math.cos(midA) * rad, my: c.y + Math.sin(midA) * rad,
      };
    }
    if (e.type === "spline") {
      const ids = splineMap.get(e.id);
      if (!ids) return e;
      // ids is 1:1 with e.points (built via e.points.map above), so iterate the
      // originals: `orig` is always defined and is the fallback when the solver
      // didn't return a position for that fit point.
      return { ...e, points: e.points.map((orig, k) => {
        const id = ids[k];
        return (id !== undefined ? r.points[id] : undefined) ?? orig;
      }) };
    }
    if (e.type === "point") {
      const p = r.points[pointMap.get(e.id)!];
      return p ? { ...e, x: p.x, y: p.y } : e;
    }
    return e;
  });

  return { entities: out, dof: r.dof, ok: r.ok, conflicts: r.conflicts };
}
