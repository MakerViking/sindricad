// 2D constraint solver bridge over planegcs (FreeCAD's PlaneGCS, WASM).
// Translates our point/line/circle + constraint model into planegcs primitives,
// solves, and reads the solved point positions back. One wrapper is kept for the
// app lifetime; clear_data() resets it between solves.

import { init_planegcs_module, GcsWrapper, SolveStatus } from "@salusoft89/planegcs";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";

export type PointId = string;
export interface SPoint { id: PointId; x: number; y: number; fixed?: boolean }
export interface SLine { id: string; p1: PointId; p2: PointId }
export interface SCircle { id: string; center: PointId; radius: number }
// An arc references three points (center, start, end) plus radius + sweep
// angles. arc_rules keeps the endpoints on the circle at those angles, so the
// endpoints can be shared with lines (coincidence) and the arc stays circular.
export interface SArc {
  id: string;
  center: PointId;
  start: PointId;
  end: PointId;
  radius: number;
  startAngle: number;
  endAngle: number;
}

export type SConstraint =
  | { id: string; type: "coincident"; a: PointId; b: PointId }
  | { id: string; type: "horizontal"; line: string }
  | { id: string; type: "vertical"; line: string }
  | { id: string; type: "parallel"; l1: string; l2: string }
  | { id: string; type: "perpendicular"; l1: string; l2: string }
  | { id: string; type: "equal"; l1: string; l2: string }
  | { id: string; type: "distance"; a: PointId; b: PointId; value: number }
  | { id: string; type: "p2lDistance"; p: PointId; line: string; value: number }
  | { id: string; type: "diameter"; circle: string; value: number }
  | { id: string; type: "tangentLC"; line: string; circle: string }
  | { id: string; type: "pointOnLine"; p: PointId; line: string }
  | { id: string; type: "pointOnPerpBisector"; p: PointId; line: string }
  | { id: string; type: "symmetric"; a: PointId; b: PointId; line: string };

export interface SolveInput {
  points: SPoint[];
  lines: SLine[];
  circles: SCircle[];
  arcs?: SArc[];
  constraints: SConstraint[];
  drag?: { point: PointId; x: number; y: number };
}
export interface SolveResult {
  points: Record<PointId, { x: number; y: number }>;
  circles: Record<string, number>; // solved radii
  arcs: Record<string, { radius: number }>; // solved radii (angles recomputed from points)
  dof: number;
  ok: boolean;
  conflicts: string[];
}

let wrapperPromise: Promise<GcsWrapper> | null = null;
function getWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) {
    wrapperPromise = (async () => {
      const mod = await init_planegcs_module({ locateFile: () => wasmUrl });
      return new GcsWrapper(new mod.GcsSystem());
    })();
  }
  return wrapperPromise;
}

/** Warm up the WASM module ahead of first use (call at startup). */
export function initSolver(): Promise<unknown> {
  return getWrapper();
}

export async function solveSketch(input: SolveInput): Promise<SolveResult> {
  const w = await getWrapper();
  w.clear_data();

  const prims: any[] = [];
  for (const p of input.points)
    prims.push({ id: p.id, type: "point", x: p.x, y: p.y, fixed: !!p.fixed });
  for (const l of input.lines)
    prims.push({ id: l.id, type: "line", p1_id: l.p1, p2_id: l.p2 });
  for (const c of input.circles)
    prims.push({ id: c.id, type: "circle", c_id: c.center, radius: c.radius });
  for (const a of input.arcs ?? []) {
    prims.push({
      id: a.id, type: "arc", c_id: a.center, start_id: a.start, end_id: a.end,
      radius: a.radius, start_angle: a.startAngle, end_angle: a.endAngle,
    });
    prims.push({ id: `${a.id}_rules`, type: "arc_rules", a_id: a.id });
  }
  for (const c of input.constraints) prims.push(toGcsConstraint(c));
  if (input.drag) {
    prims.push({ id: "__drag", type: "point", x: input.drag.x, y: input.drag.y, fixed: true });
    prims.push({ id: "__dragc", type: "p2p_coincident", p1_id: input.drag.point, p2_id: "__drag", temporary: true });
  }

  w.push_primitives_and_params(prims);
  const status = w.solve();
  w.apply_solution();

  const points: Record<string, { x: number; y: number }> = {};
  for (const p of input.points) {
    const sp = w.sketch_index.get_sketch_point(p.id);
    if (sp) points[p.id] = { x: sp.x, y: sp.y };
  }
  const circles: Record<string, number> = {};
  for (const c of input.circles) {
    const sc = w.sketch_index.get_sketch_circle(c.id);
    if (sc) circles[c.id] = sc.radius;
  }
  const arcs: Record<string, { radius: number }> = {};
  for (const a of input.arcs ?? []) {
    const sa = w.sketch_index.get_sketch_arc(a.id);
    if (sa) arcs[a.id] = { radius: sa.radius };
  }
  return {
    points,
    circles,
    arcs,
    dof: w.gcs.dof(),
    ok: status === SolveStatus.Success,
    conflicts: safeConflicts(w),
  };
}

function safeConflicts(w: GcsWrapper): string[] {
  try {
    return w.get_gcs_conflicting_constraints?.() ?? [];
  } catch {
    return [];
  }
}

function toGcsConstraint(c: SConstraint): any {
  switch (c.type) {
    case "coincident":
      return { id: c.id, type: "p2p_coincident", p1_id: c.a, p2_id: c.b };
    case "horizontal":
      return { id: c.id, type: "horizontal_l", l_id: c.line };
    case "vertical":
      return { id: c.id, type: "vertical_l", l_id: c.line };
    case "parallel":
      return { id: c.id, type: "parallel", l1_id: c.l1, l2_id: c.l2 };
    case "perpendicular":
      return { id: c.id, type: "perpendicular_ll", l1_id: c.l1, l2_id: c.l2 };
    case "equal":
      return { id: c.id, type: "equal_length", l1_id: c.l1, l2_id: c.l2 };
    case "distance":
      return { id: c.id, type: "p2p_distance", p1_id: c.a, p2_id: c.b, distance: c.value };
    case "p2lDistance":
      return { id: c.id, type: "p2l_distance", p_id: c.p, l_id: c.line, distance: c.value };
    case "diameter":
      return { id: c.id, type: "circle_diameter", c_id: c.circle, diameter: c.value };
    case "tangentLC":
      return { id: c.id, type: "tangent_lc", l_id: c.line, c_id: c.circle };
    case "pointOnLine":
      return { id: c.id, type: "point_on_line_pl", p_id: c.p, l_id: c.line };
    case "pointOnPerpBisector":
      return { id: c.id, type: "point_on_perp_bisector_pl", p_id: c.p, l_id: c.line };
    case "symmetric":
      return { id: c.id, type: "p2p_symmetric_ppl", p1_id: c.a, p2_id: c.b, l_id: c.line };
  }
}
