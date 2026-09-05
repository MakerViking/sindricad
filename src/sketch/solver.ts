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
  // AXIS-ALIGNED distances (smart-dimension's horizontal / vertical results).
  // planegcs has no p2p_distance_x, so these ride its generic `difference` on
  // the points' own x / y params: b.<axis> - a.<axis> = value. SIGNED, unlike
  // `distance` — which is what makes them able to express "B is 20 to the LEFT
  // of A" and is why the tool must order the operands, not sort them.
  | { id: string; type: "distanceX"; a: PointId; b: PointId; value: number }
  | { id: string; type: "distanceY"; a: PointId; b: PointId; value: number }
  | { id: string; type: "p2lDistance"; p: PointId; line: string; value: number }
  | { id: string; type: "diameter"; circle: string; value: number }
  | { id: string; type: "tangentLC"; line: string; circle: string }
  | { id: string; type: "tangentLA"; line: string; arc: string }
  | { id: string; type: "tangentCC"; c1: string; c2: string }
  | { id: string; type: "tangentCA"; circle: string; arc: string }
  | { id: string; type: "tangentAA"; a1: string; a2: string }
  | { id: string; type: "angleLL"; l1: string; l2: string; value: number } // radians
  | { id: string; type: "circleRadius"; circle: string; value: number }
  | { id: string; type: "arcRadius"; arc: string; value: number }
  | { id: string; type: "equalRadiusCC"; c1: string; c2: string }
  | { id: string; type: "equalRadiusCA"; circle: string; arc: string }
  | { id: string; type: "equalRadiusAA"; a1: string; a2: string }
  | { id: string; type: "pointOnLine"; p: PointId; line: string }
  | { id: string; type: "pointOnPerpBisector"; p: PointId; line: string }
  | { id: string; type: "symmetric"; a: PointId; b: PointId; line: string }
  // --- edge-to-edge (rim) distances -----------------------------------------
  // `round1`/`round2`/`round` name a CIRCLE OR ARC primitive: planegcs's Arc
  // derives from Circle, so the same three constraints take either (verified
  // against the installed wasm). See entityDims.rimGap / lineRimPoints /
  // pointRimPoints for the exact measures — they are not all signed, and
  // sketchSolve's solve guard re-checks the branch each one was created in.
  | { id: string; type: "rimGap"; round1: string; round2: string; value: number }
  | { id: string; type: "rimLine"; round: string; line: string; value: number }
  | { id: string; type: "rimPoint"; p: PointId; round: string; value: number }
  // radiusDifference: `outer.radius - inner.radius = value`, SIGNED, touching
  // only the two radius params (planegcs `difference` over ObjectParams). The
  // concentric wall-thickness dim — c2cdistance's nested branch is unsigned and
  // will happily converge to an inverted annulus, so it must NOT be used here.
  | { id: string; type: "radiusDifference"; inner: string; outer: string; value: number };

export interface SolveInput {
  points: SPoint[];
  lines: SLine[];
  circles: SCircle[];
  arcs?: SArc[];
  constraints: SConstraint[];
  drag?: { point: PointId; x: number; y: number };
  /** Points to hold STILL for this solve, at the given position — the "only what
   *  you picked moves" bias (see sketchSolve's `bias`).
   *
   *  Deliberately the SAME device as `drag`, and for a measured reason: there
   *  are no per-parameter weights anywhere in this ABI, and a per-constraint
   *  `scale` is inert on a temporary constraint across 1e-6..1e6, so a fixed
   *  helper point plus a `temporary:true` coincidence is the only bias this
   *  codebase has. `temporary` sets the constraint's tagId to -1, which keeps an
   *  anchor out of dof / conflicts / redundant AND makes it SOFT — planegcs
   *  solves the temporary constraints as a secondary subsystem, so an anchor
   *  yields to a real constraint rather than fighting it. Measured: anchoring a
   *  rectangle whose corner a `fix` still has to move leaves the real constraint
   *  satisfied and the anchor simply ignored, with dof and every diagnostic list
   *  identical to the unanchored solve.
   *
   *  Anchoring the same points with `fixed:true` on the REAL points instead is
   *  hard, and reports dof 1 with 4 fabricated redundants. Don't. */
  anchors?: { point: PointId; x: number; y: number }[];
  /** The RADIUS half of `anchors`: rounds to hold at their given radius.
   *
   *  A planegcs circle/arc radius is a free variable of its own — it is not
   *  reachable through any point, so anchoring a circle's centre leaves its
   *  radius as free as it ever was. Without this, "only what you picked moves"
   *  was a lie for every constraint that can pay in radius, and on the tangent
   *  gesture it was WORSE than no bias at all: line at y=8 tangent to a circle
   *  r=5 at the origin, picking the LINE first, took the circle to r=7 (+40%)
   *  where the unbiased solve took it to r=5.822 (+16%). With the radius pinned
   *  the circle does not move at all and the line lands at y=5.
   *
   *  Same `temporary:true` device as `anchors`, and measured to BITE rather than
   *  to be ignored, on both of the cases that matter: the tangent above, and
   *  equal-radius between two circles (r5 and r10 — pinning either one is what
   *  decides which of them changes; unpinned, planegcs always shrinks C2 to 5
   *  regardless of the pick). Note for whoever finds a contradicting note: an
   *  earlier investigation recorded a temporary `circle_radius` pin as
   *  completely inert. That is not what this ABI does — the numbers above are
   *  from the installed wasm.
   *
   *  `arc: true` spells the pin as planegcs's `arc_radius` instead of
   *  `circle_radius`. A NON-mover arc still needs none: its radius is reachable
   *  through its centre and endpoints (planegcs `arc_rules`), so whoever
   *  anchored those anchored the radius, and sketchSolve says so at the call
   *  site. A MOVER arc has none of them anchored — they belong to the mover —
   *  so its radius is as free as a circle's, and it grows under tangency
   *  without this. */
  radiusAnchors?: { id: string; radius: number; arc?: boolean }[];
}
export interface SolveResult {
  points: Record<PointId, { x: number; y: number }>;
  circles: Record<string, number>; // solved radii
  arcs: Record<string, { radius: number }>; // solved radii (angles recomputed from points)
  dof: number;
  ok: boolean;
  conflicts: string[]; // constraints that can't be satisfied (sketch is inconsistent)
  redundant: string[]; // constraints removable without changing DOF (over-defined)
  partiallyRedundant: string[]; // constraints that partially duplicate others
}

let wrapperPromise: Promise<GcsWrapper> | null = null;
function getWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) {
    wrapperPromise = (async () => {
      const mod = await init_planegcs_module({ locateFile: () => wasmUrl });
      return new GcsWrapper(new mod.GcsSystem());
    })().catch((err) => {
      // Do NOT keep a rejected promise in the cache. It would poison every
      // later solve with the same stale failure and never retry — and a
      // failure here can be transient (a fetch that did not land, an
      // instantiate that raced startup), so a retry can legitimately succeed
      // without restarting the app.
      wrapperPromise = null;
      throw new SolverUnavailable(err);
    });
  }
  return wrapperPromise;
}

/** The constraint solver's WASM could not be instantiated.
 *
 *  The CSP branch was misdiagnosed for a long time, so it is worth stating
 *  plainly. planegcs is an emscripten/embind module, and embind builds each
 *  invoker by handing a SOURCE STRING to the `Function` constructor
 *  (`craftInvokerFunction` -> `new_`). `'wasm-unsafe-eval'` permits WebAssembly
 *  COMPILATION only; it does not permit the Function constructor, which needs
 *  `'unsafe-eval'`. So the failure was never about WebAssembly and never about
 *  the user's webview: it was our own Content-Security-Policy, in every
 *  packaged build (`tauri dev` serves from vite without the CSP, which is why
 *  it never reproduced locally). Three Windows reporters and one Linux reporter
 *  were told to update a runtime that was not the problem; one of them
 *  reinstalled WebView2 for nothing.
 *
 *  Keep the message blaming the build, not the machine. If this fires again it
 *  means the policy regressed — not that someone needs a driver update. */
export class SolverUnavailable extends Error {
  constructor(readonly cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      /content security policy|unsafe-eval|code generation/i.test(detail)
        ? "The 2D constraint solver could not start: this build's security policy blocks the "
          + "code it needs to initialise. That is a bug in SindriCAD, not a problem with your "
          + "system, so updating your webview or graphics drivers will not help. Sketching "
          + "still works, but without constraints, dimensions or point dragging."
        : `The 2D constraint solver could not start: ${detail}`,
    );
    this.name = "SolverUnavailable";
  }
}

/** Warm up the WASM module ahead of first use (call at startup).
 *
 *  A warm-up is OPTIONAL by definition: the caller must not let a failure here
 *  reach the user as an app-level error. It used to be called as a bare
 *  `void initSolver()`, so on a WebView2 that blocks WASM the rejection hit the
 *  global unhandledrejection net and greeted the user with "Something went
 *  wrong — check the console for details" at every startup, naming nothing.
 *  Resolves to false instead of rejecting; the real error is raised at the
 *  point of USE, where it can say what is actually unavailable. */
export async function initSolver(): Promise<boolean> {
  try {
    await getWrapper();
    return true;
  } catch {
    return false;
  }
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
  // Anchors ride the drag pin's device, one helper point each. Read-back walks
  // input.points only, so these helpers never reach the caller.
  (input.anchors ?? []).forEach((a, i) => {
    prims.push({ id: `__anc${i}`, type: "point", x: a.x, y: a.y, fixed: true });
    prims.push({ id: `__ancc${i}`, type: "p2p_coincident", p1_id: a.point, p2_id: `__anc${i}`, temporary: true });
  });
  // A radius anchor needs no helper primitive — the value goes straight on the
  // constraint.
  (input.radiusAnchors ?? []).forEach((a, i) => {
    prims.push(a.arc
      ? { id: `__crad${i}`, type: "arc_radius", a_id: a.id, radius: a.radius, temporary: true }
      : { id: `__crad${i}`, type: "circle_radius", c_id: a.id, radius: a.radius, temporary: true });
  });

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
    conflicts: safeList(() => w.get_gcs_conflicting_constraints?.()),
    redundant: safeList(() => w.get_gcs_redundant_constraints?.()),
    partiallyRedundant: safeList(() => w.get_gcs_partially_redundant_constraints?.()),
  };
}

/** Read a planegcs diagnostic list, tolerating a missing method / throw. */
function safeList(get: () => string[] | undefined): string[] {
  try {
    return get() ?? [];
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
    case "distanceX":
    case "distanceY":
      // param2 - param1 = difference (planegcs semantics, same as radiusDifference)
      return {
        id: c.id, type: "difference",
        param1: { o_id: c.a, prop: c.type === "distanceX" ? "x" : "y" },
        param2: { o_id: c.b, prop: c.type === "distanceX" ? "x" : "y" },
        difference: c.value,
      };
    case "p2lDistance":
      return { id: c.id, type: "p2l_distance", p_id: c.p, l_id: c.line, distance: c.value };
    case "diameter":
      return { id: c.id, type: "circle_diameter", c_id: c.circle, diameter: c.value };
    case "tangentLC":
      return { id: c.id, type: "tangent_lc", l_id: c.line, c_id: c.circle };
    case "tangentLA":
      return { id: c.id, type: "tangent_la", l_id: c.line, a_id: c.arc };
    case "tangentCC":
      return { id: c.id, type: "tangent_cc", c1_id: c.c1, c2_id: c.c2 };
    case "tangentCA":
      return { id: c.id, type: "tangent_ca", c_id: c.circle, a_id: c.arc };
    case "tangentAA":
      return { id: c.id, type: "tangent_aa", a1_id: c.a1, a2_id: c.a2 };
    case "angleLL":
      return { id: c.id, type: "l2l_angle_ll", l1_id: c.l1, l2_id: c.l2, angle: c.value };
    case "circleRadius":
      return { id: c.id, type: "circle_radius", c_id: c.circle, radius: c.value };
    case "arcRadius":
      return { id: c.id, type: "arc_radius", a_id: c.arc, radius: c.value };
    case "equalRadiusCC":
      return { id: c.id, type: "equal_radius_cc", c1_id: c.c1, c2_id: c.c2 };
    case "equalRadiusCA":
      return { id: c.id, type: "equal_radius_ca", c1_id: c.circle, a2_id: c.arc };
    case "equalRadiusAA":
      return { id: c.id, type: "equal_radius_aa", a1_id: c.a1, a2_id: c.a2 };
    case "pointOnLine":
      return { id: c.id, type: "point_on_line_pl", p_id: c.p, l_id: c.line };
    case "pointOnPerpBisector":
      return { id: c.id, type: "point_on_perp_bisector_pl", p_id: c.p, l_id: c.line };
    case "symmetric":
      return { id: c.id, type: "p2p_symmetric_ppl", p1_id: c.a, p2_id: c.b, l_id: c.line };
    case "rimGap":
      return { id: c.id, type: "c2cdistance", c1_id: c.round1, c2_id: c.round2, dist: c.value };
    case "rimLine":
      return { id: c.id, type: "c2ldistance", c_id: c.round, l_id: c.line, dist: c.value };
    case "rimPoint":
      return { id: c.id, type: "p2cdistance", p_id: c.p, c_id: c.round, distance: c.value };
    case "radiusDifference":
      // param2 - param1 = difference (planegcs semantics)
      return {
        id: c.id, type: "difference",
        param1: { o_id: c.inner, prop: "radius" },
        param2: { o_id: c.outer, prop: "radius" },
        difference: c.value,
      };
  }
}
