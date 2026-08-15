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
import { asRound, lineOperand, refPoint, rimNesting, type Round } from "./entityDims";
import type { SketchConstraint } from "../types";
import { isDriven, projEndSamples } from "../types";

// Below this a line has no usable direction, so any angular constraint on it is
// vacuously satisfiable — which is how a conflicting sketch "solves" by folding
// flat instead of reporting that it cannot be solved.
const LINE_COLLAPSE_EPS = 1e-7;

export interface SolvePass {
  entities: ResolvedEntity[];
  dof: number;
  ok: boolean;
  conflicts: string[]; // inconsistent constraints (sketch can't solve)
  overDefined: string[]; // redundant + partially-redundant (removable / over-defining)
  /** Set when a requested drag was refused because the grabbed point is fixed
   *  (projected geometry vs a user `fix` constraint — distinct user messaging).
   *  The caller must NOT advance its drag anchor on a refusal: a drifted anchor
   *  re-runs the unbounded nearest-point search from the cursor and captures an
   *  unrelated free point mid-gesture. */
  dragRefused?: "projected" | "fix";
}

const TAU = Math.PI * 2;
const ccwDelta = (from: number, to: number) => ((to - from) % TAU + TAU) % TAU;

/** THE position-coincidence key: two points merge into one solver point iff
 *  their keys match (0.001mm buckets). Anything else that needs "are these
 *  endpoints attached?" (e.g. the body drag's neighbor stretch) must use this
 *  same key, or its notion of attachment drifts from the solver's. */
export const coincKey = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;

/** The solver id for the user constraint at index `i`. Composite constraints
 *  append a NON-numeric suffix (e.g. `${constraintKey(i)}a`), so the leading
 *  integer always decodes back to the index — see constraintIndexOf. This is the
 *  single source of the id⇄index convention (planegcs conflict reporting decodes it). */
export const constraintKey = (i: number) => `k${i}`;

/** Inverse of constraintKey: the constraint index a solver id belongs to, or
 *  null for implicit ids (rectangle edges `<id>~h0`, projected radius pins
 *  `<id>~r`, the drag pin, etc.). Any id containing `~` is implicit BY CONTRACT
 *  — conflict/redundancy reporting must never blame a user constraint for one. */
export function constraintIndexOf(id: string): number | null {
  if (id.includes("~")) return null;
  const m = /^k(\d+)/.exec(id);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

export async function compileAndSolve(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  drag?: { fromX: number; fromY: number; toX: number; toY: number },
): Promise<SolvePass> {
  const points: SPoint[] = [];
  const pointByKey = new Map<string, string>();
  const key = coincKey;
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
  const fixedPts = new Set<string>(); // solver point ids pinned by a `fix` constraint / projected geometry
  const projPts = new Set<string>(); // the subset of fixedPts pinned by PROJECTED geometry (drag-refusal messaging)
  const pinProjected = (...ids: string[]) => { for (const id of ids) { fixedPts.add(id); projPts.add(id); } };
  // projected circle/arc entity ids: their radius is pinned too (not just the
  // points), which makes them fully rigid — the inert-constraint check needs this
  const projRounds = new Set<string>();

  // Compile a 3-point arc into a native solver arc (shared by user arcs and
  // projected arcs). Returns the registered points, or null when degenerate.
  const compileArc = (
    id: string, x1: number, y1: number, x2: number, y2: number, mx: number, my: number,
  ): { ourS: string; ourE: string; center: string } | null => {
    const cc = circumcenter({ x: x1, y: y1 }, { x: x2, y: y2 }, { x: mx, y: my });
    if (!cc) return null; // collinear/degenerate — leave untouched
    const radius = Math.hypot(x1 - cc.x, y1 - cc.y);
    const ourS = getPoint(x1, y1);
    const ourE = getPoint(x2, y2);
    const center = getPoint(cc.x, cc.y, false); // arc center is not an endpoint
    const aS = Math.atan2(y1 - cc.y, x1 - cc.x);
    const aE = Math.atan2(y2 - cc.y, x2 - cc.x);
    const aT = Math.atan2(my - cc.y, mx - cc.x);
    // orient the arc CCW so its sweep passes through the through-point
    const ccwThroughFromStart = ccwDelta(aS, aT) <= ccwDelta(aS, aE);
    const start = ccwThroughFromStart ? ourS : ourE;
    const startA = ccwThroughFromStart ? aS : aE;
    const end = ccwThroughFromStart ? ourE : ourS;
    const endA = ccwThroughFromStart ? aE : aS;
    arcs.push({
      id, center, start, end, radius,
      startAngle: startA, endAngle: startA + ccwDelta(startA, endA),
    });
    arcMap.set(id, { ourS, ourE, center, startIsOurS: ccwThroughFromStart });
    return { ourS, ourE, center };
  };

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
        // A rectangle edge is a USER-REFERENCEABLE line operand
        // ("<rectId>~<k>" — see types.ts): registering it here is what makes
        // isLine()/ends.get() accept it, so the existing distance / p2lDistance
        // / angle compile branches take a rect edge with no further change.
        // Side effect worth knowing: endpointPoint() now resolves `rect~k` too,
        // so a future coincident-on-a-rect-edge would silently resolve to that
        // edge's corner points.
        ends.set(`${e.id}~${k}`, [a, b]);
      }
      cons.push({ id: `${e.id}~h0`, type: "horizontal", line: `${e.id}~0` }); // bottom
      cons.push({ id: `${e.id}~h2`, type: "horizontal", line: `${e.id}~2` }); // top
      cons.push({ id: `${e.id}~v1`, type: "vertical", line: `${e.id}~1` }); // right
      cons.push({ id: `${e.id}~v3`, type: "vertical", line: `${e.id}~3` }); // left
      rectMap.set(e.id, cp);
    } else if (e.type === "arc") {
      compileArc(e.id, e.x1, e.y1, e.x2, e.y2, e.mx, e.my);
    } else if (e.type === "spline") {
      // endpoints are mergeable (chain with lines); interior points are unique
      const last = e.points.length - 1;
      splineMap.set(e.id, e.points.map((p, k) => getPoint(p.x, p.y, k === 0 || k === last)));
    } else if (e.type === "point") {
      // a sketch point is mergeable so it can snap onto / coincide with geometry
      pointMap.set(e.id, getPoint(e.x, e.y, true));
    } else if (e.type === "projected") {
      // Fixed reference geometry (Fusion Project): compiles as pinned planegcs
      // primitives so user constraints/dims can attach to it. Endpoints are
      // MERGEABLE on purpose — a coincident user endpoint fuses with the fixed
      // point and is thereby anchored (the sticks-to-reference behavior).
      // Write-back never touches projected entities (they are already exact).
      const cv = e.curve;
      if (cv.kind === "line") {
        const p1 = getPoint(cv.x1, cv.y1);
        const p2 = getPoint(cv.x2, cv.y2);
        lines.push({ id: e.id, p1, p2 });
        ends.set(e.id, [p1, p2]);
        pinProjected(p1, p2);
      } else if (cv.kind === "circle") {
        const c = getPoint(cv.x, cv.y, false); // center is not an endpoint
        circles.push({ id: e.id, center: c, radius: cv.r });
        centers.set(e.id, c);
        pinProjected(c);
        projRounds.add(e.id);
        // a planegcs circle radius is a free variable — pin it with an implicit
        // constraint. `~` ids decode to null in constraintIndexOf, so conflict
        // reporting can never blame a user constraint for this pin.
        cons.push({ id: `${e.id}~r`, type: "circleRadius", circle: e.id, value: cv.r });
      } else if (cv.kind === "arc") {
        // native arc with all three defining points fixed; arc_rules then holds
        // radius + sweep angles, so no separate radius pin is needed
        const m = compileArc(e.id, cv.x1, cv.y1, cv.x2, cv.y2, cv.mx, cv.my);
        if (m) {
          pinProjected(m.ourS, m.ourE, m.center);
          projRounds.add(e.id);
        }
      } else {
        // poly: only the first/last samples are real, addressable model points
        // (ONE for a closed poly — projEndSamples). Register them like spline
        // ends (splineMap drives endpointPoint 0/1); no curve primitive —
        // interior samples never enter the solver.
        const sampleIds = projEndSamples(cv).map(([x, y]) => getPoint(x, y));
        if (sampleIds.length) {
          splineMap.set(e.id, sampleIds);
          pinProjected(...sampleIds);
        }
      }
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
  // a circle OR arc primitive — planegcs's Arc derives from Circle, so the rim
  // (edge-to-edge) constraints accept either
  const isRound = (id: string) => centers.has(id) || arcMap.has(id);
  // entity kind by id (line/circle/arc) — one lookup for the tangent/equal ladders
  const kindOf = (id: string): "line" | "circle" | "arc" | undefined =>
    ends.has(id) ? "line" : centers.has(id) ? "circle" : arcMap.has(id) ? "arc" : undefined;
  constraints.forEach((c, i) => {
    const id = constraintKey(i); // user constraint ids never collide with `~` implicit ones
    if (isDriven(c)) return; // reference dim: measured only, never constrains
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
    else if (c.type === "diameter") {
      if (centers.has(c.circle)) cons.push({ id, type: "diameter", circle: c.circle, value: c.value });
      // an ARC can carry a diameter dim too (the right-click Radius/Diameter
      // override) — planegcs has no arc_diameter, so halve it
      else if (arcMap.has(c.circle)) cons.push({ id, type: "arcRadius", arc: c.circle, value: c.value / 2 });
    }
    // --- edge-to-edge (rim) dims: one planegcs constraint each ---------------
    else if (c.type === "radialGap") {
      if (isRound(c.inner) && isRound(c.outer) && c.inner !== c.outer) {
        cons.push({ id, type: "radiusDifference", inner: c.inner, outer: c.outer, value: c.value });
      }
    }
    else if (c.type === "c2cDistance") {
      if (isRound(c.c1) && isRound(c.c2) && c.c1 !== c.c2) {
        cons.push({ id, type: "rimGap", round1: c.c1, round2: c.c2, value: c.value });
      }
    }
    else if (c.type === "c2lDistance") {
      if (isRound(c.circle) && isLine(c.line)) {
        cons.push({ id, type: "rimLine", round: c.circle, line: c.line, value: c.value });
      }
    }
    else if (c.type === "p2cDistance") {
      const p = dimPoint(c.e, c.p);
      if (p && isRound(c.circle)) cons.push({ id, type: "rimPoint", p, round: c.circle, value: c.value });
    }
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
    else if (c.type === "angle") {
      if (isLine(c.l1) && isLine(c.l2)) cons.push({ id, type: "angleLL", l1: c.l1, l2: c.l2, value: (c.value * Math.PI) / 180 });
    }
    else if (c.type === "radius") {
      if (centers.has(c.e)) cons.push({ id, type: "circleRadius", circle: c.e, value: c.value });
      else if (arcMap.has(c.e)) cons.push({ id, type: "arcRadius", arc: c.e, value: c.value });
    }
    else if (c.type === "fix") {
      const p = dimPoint(c.e, c.p);
      if (p) fixedPts.add(p);
    }
    else if (c.type === "collinear") {
      if (isLine(c.l1) && isLine(c.l2)) {
        cons.push({ id: `${id}p`, type: "parallel", l1: c.l1, l2: c.l2 });
        const e2 = ends.get(c.l2);
        if (e2) cons.push({ id: `${id}o`, type: "pointOnLine", p: e2[0], line: c.l1 });
      }
    }
    else if (c.type === "equalRadius") {
      const ka = kindOf(c.a), kb = kindOf(c.b);
      if (ka === "circle" && kb === "circle") cons.push({ id, type: "equalRadiusCC", c1: c.a, c2: c.b });
      else if (ka === "arc" && kb === "arc") cons.push({ id, type: "equalRadiusAA", a1: c.a, a2: c.b });
      else if (ka === "circle" && kb === "arc") cons.push({ id, type: "equalRadiusCA", circle: c.a, arc: c.b });
      else if (ka === "arc" && kb === "circle") cons.push({ id, type: "equalRadiusCA", circle: c.b, arc: c.a });
    }
    else if (c.type === "tangent2") {
      const ka = kindOf(c.a), kb = kindOf(c.b);
      if (ka === "line" && kb === "circle") cons.push({ id, type: "tangentLC", line: c.a, circle: c.b });
      else if (ka === "circle" && kb === "line") cons.push({ id, type: "tangentLC", line: c.b, circle: c.a });
      else if (ka === "line" && kb === "arc") cons.push({ id, type: "tangentLA", line: c.a, arc: c.b });
      else if (ka === "arc" && kb === "line") cons.push({ id, type: "tangentLA", line: c.b, arc: c.a });
      else if (ka === "circle" && kb === "circle") cons.push({ id, type: "tangentCC", c1: c.a, c2: c.b });
      else if (ka === "arc" && kb === "arc") cons.push({ id, type: "tangentAA", a1: c.a, a2: c.b });
      else if (ka === "circle" && kb === "arc") cons.push({ id, type: "tangentCA", circle: c.a, arc: c.b });
      else if (ka === "arc" && kb === "circle") cons.push({ id, type: "tangentCA", circle: c.b, arc: c.a });
    }
    else if (c.type === "offset") {
      // One composite over N source→copy pairs, all governed by c.value.
      // Sub-ids append a LETTER before the pair number so constraintKey's
      // leading-integer decode still resolves them back to this constraint
      // ("k12p3" → 12) — that's what lets a planegcs conflict blame the offset
      // dimension rather than nothing. A digit-first suffix would silently
      // decode to a different constraint index ("k1" + "0" → index 10).
      const mag = Math.abs(c.value); // p2l_distance is unsigned; rimBranch holds the side
      c.pairs.forEach((pr, n) => {
        // A rect-EDGE operand ("<rectId>~<k>") is already direction-locked by the
        // rectangle's implicit horizontal/vertical constraints, so it needs ONE
        // distance and no parallel — 4 edges × 1 equation is exactly a
        // rectangle's 4 DOF. Adding the line treatment there would triple-count.
        const rectEdge = pr.src.includes("~") && pr.cpy.includes("~");
        if (isLine(pr.src) && isLine(pr.cpy)) {
          const e = ends.get(pr.cpy);
          if (!e) return;
          if (rectEdge) {
            cons.push({ id: `${id}a${n}`, type: "p2lDistance", p: e[0], line: pr.src, value: mag });
            return;
          }
          cons.push({ id: `${id}p${n}`, type: "parallel", l1: pr.src, l2: pr.cpy });
          // ONE endpoint distance, not two: once the copy is parallel to the
          // source, pinning either endpoint at `mag` pins the whole line, so a
          // second p2l_distance is always redundant — measured as 11 redundants
          // on a 4-line square before this was cut back.
          cons.push({ id: `${id}a${n}`, type: "p2lDistance", p: e[0], line: pr.src, value: mag });
        } else if (isRound(pr.src) && isRound(pr.cpy) && pr.src !== pr.cpy) {
          const a = centerPoint(pr.src), b = centerPoint(pr.cpy);
          if (a && b) cons.push({ id: `${id}c${n}`, type: "coincident", a, b });
          // `difference` is param2 − param1, i.e. cpy.r − src.r = value. SIGNED,
          // so an inward offset shrinks the copy with no branch ambiguity — the
          // same property that makes radialGap safe against an inside-out annulus.
          cons.push({ id: `${id}r${n}`, type: "radiusDifference", inner: pr.src, outer: pr.cpy, value: c.value });
        }
      });
    }
  });

  for (const p of points) if (fixedPts.has(p.id)) p.fixed = true;

  let dragInput: { point: string; x: number; y: number } | undefined;
  let dragRefused: "projected" | "fix" | undefined;
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
    // a FIXED nearest point (projected geometry, or a user endpoint merged onto
    // it, or a `fix` constraint) cannot move: refuse the drag outright instead
    // of pitting the temporary drag pin against the fixed flag — and REPORT the
    // refusal so the caller keeps its anchor on the stationary point
    if (best && !best.fixed) dragInput = { point: best.id, x: drag.toX, y: drag.toY };
    else if (best) dragRefused = projPts.has(best.id) ? "projected" : "fix";
  }

  const r = await solveSketch({ points, lines, circles, arcs, constraints: cons, ...(dragInput ? { drag: dragInput } : {}) });

  // planegcs never sees a constraint whose operands are ALL fixed — fixed
  // params aren't solver variables, so such a constraint is silently accepted
  // even when violated (e.g. a driving dim between two projected points).
  // Classify these "inert" constraints ourselves: satisfied → redundant
  // (amber), violated → conflict (red) — through the same reporting channel
  // the solver's own diagnosis uses.
  const conflicts = [...r.conflicts];
  const redundant = [...r.redundant];
  // No fixed points (no projected geometry, no `fix`) ⇒ no constraint can be
  // inert (every inertResidual arm requires fx/fxLine/fxRound operands, and
  // projRounds is only ever populated alongside fixedPts) — skip the whole
  // classification pass on ordinary sketches, incl. every drag frame.
  if (fixedPts.size) {
    // mm (radians for angles) — comfortably above the residual floor left by the
    // sidecar's 6-decimal curve rounding (a p2p distance between rounded points
    // can be off by ~1.4e-6 even when nominally exact), and matching its 1e-4 mm
    // change tolerance: a conceptually-satisfied inert dim must grade amber, not red
    const INERT_TOL = 1e-4;
    const pos = new Map(points.map((p) => [p.id, p])); // fixed ⇒ input == solved
    const lineEnds = new Map(lines.map((l) => [l.id, l]));
    const radiusOf = new Map<string, number>([
      ...circles.map((c) => [c.id, c.radius] as const),
      ...arcs.map((a) => [a.id, a.radius] as const),
    ]);
    const centerOf = new Map<string, string>([
      ...circles.map((c) => [c.id, c.center] as const),
      ...arcs.map((a) => [a.id, a.center] as const),
    ]);
    const fx = (id: string) => fixedPts.has(id);
    const fxLine = (id: string) => { const l = lineEnds.get(id); return !!l && fx(l.p1) && fx(l.p2); };
    const fxRound = (id: string) => projRounds.has(id); // center fixed AND radius pinned
    const roundAt = (id: string) => radiusOf.get(id)!;
    const P = (id: string) => pos.get(id)!;
    const dist = (aId: string, bId: string) => { const a = P(aId), b = P(bId); return Math.hypot(a.x - b.x, a.y - b.y); };
    const lineDir = (id: string) => {
      const l = lineEnds.get(id)!;
      const a = P(l.p1), b = P(l.p2);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    };
    const lineLen = (id: string) => { const l = lineEnds.get(id)!; return dist(l.p1, l.p2); };
    const perpDist = (pId: string, lId: string) => {
      const l = lineEnds.get(lId)!;
      const a = P(l.p1), b = P(l.p2), q = P(pId);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return Math.abs((q.x - a.x) * (b.y - a.y) - (q.y - a.y) * (b.x - a.x)) / len;
    };
    const tangentRes = (aId: string, bId: string) => { // two rounds: outer or inner tangency
      const d = dist(centerOf.get(aId)!, centerOf.get(bId)!);
      const r1 = radiusOf.get(aId)!, r2 = radiusOf.get(bId)!;
      return Math.min(Math.abs(d - (r1 + r2)), Math.abs(d - Math.abs(r1 - r2)));
    };
    // residual of an inert constraint, or null when any operand is still free
    const inertResidual = (c: SConstraint): number | null => {
      switch (c.type) {
        // self-coincident (both endpoints position-merged into one solver
        // point, e.g. a user endpoint snapped ONTO the projected point it is
        // constrained to) is absorbed by the merge — vacuous, not over-defining
        case "coincident": return c.a !== c.b && fx(c.a) && fx(c.b) ? dist(c.a, c.b) : null;
        case "horizontal": { if (!fxLine(c.line)) return null; const l = lineEnds.get(c.line)!; return Math.abs(P(l.p1).y - P(l.p2).y); }
        case "vertical": { if (!fxLine(c.line)) return null; const l = lineEnds.get(c.line)!; return Math.abs(P(l.p1).x - P(l.p2).x); }
        case "parallel": { if (!fxLine(c.l1) || !fxLine(c.l2)) return null; const d1 = lineDir(c.l1), d2 = lineDir(c.l2); return Math.abs(d1.x * d2.y - d1.y * d2.x); }
        case "perpendicular": { if (!fxLine(c.l1) || !fxLine(c.l2)) return null; const d1 = lineDir(c.l1), d2 = lineDir(c.l2); return Math.abs(d1.x * d2.x + d1.y * d2.y); }
        case "equal": return fxLine(c.l1) && fxLine(c.l2) ? Math.abs(lineLen(c.l1) - lineLen(c.l2)) : null;
        case "distance": return fx(c.a) && fx(c.b) ? Math.abs(dist(c.a, c.b) - c.value) : null;
        case "p2lDistance": return fx(c.p) && fxLine(c.line) ? Math.abs(perpDist(c.p, c.line) - c.value) : null;
        case "diameter": return fxRound(c.circle) ? Math.abs(2 * radiusOf.get(c.circle)! - c.value) : null;
        case "circleRadius": return fxRound(c.circle) ? Math.abs(radiusOf.get(c.circle)! - c.value) : null;
        case "arcRadius": return fxRound(c.arc) ? Math.abs(radiusOf.get(c.arc)! - c.value) : null;
        case "tangentLC": return fxLine(c.line) && fxRound(c.circle) ? Math.abs(perpDist(centerOf.get(c.circle)!, c.line) - radiusOf.get(c.circle)!) : null;
        case "tangentLA": return fxLine(c.line) && fxRound(c.arc) ? Math.abs(perpDist(centerOf.get(c.arc)!, c.line) - radiusOf.get(c.arc)!) : null;
        case "tangentCC": return fxRound(c.c1) && fxRound(c.c2) ? tangentRes(c.c1, c.c2) : null;
        case "tangentCA": return fxRound(c.circle) && fxRound(c.arc) ? tangentRes(c.circle, c.arc) : null;
        case "tangentAA": return fxRound(c.a1) && fxRound(c.a2) ? tangentRes(c.a1, c.a2) : null;
        case "angleLL": { if (!fxLine(c.l1) || !fxLine(c.l2)) return null; const d1 = lineDir(c.l1), d2 = lineDir(c.l2); const actual = Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y); const w = ((actual - c.value) % TAU + TAU + Math.PI) % TAU - Math.PI; return Math.abs(w); }
        case "equalRadiusCC": return fxRound(c.c1) && fxRound(c.c2) ? Math.abs(radiusOf.get(c.c1)! - radiusOf.get(c.c2)!) : null;
        case "equalRadiusCA": return fxRound(c.circle) && fxRound(c.arc) ? Math.abs(radiusOf.get(c.circle)! - radiusOf.get(c.arc)!) : null;
        case "equalRadiusAA": return fxRound(c.a1) && fxRound(c.a2) ? Math.abs(radiusOf.get(c.a1)! - radiusOf.get(c.a2)!) : null;
        case "pointOnLine": return fx(c.p) && fxLine(c.line) ? perpDist(c.p, c.line) : null;
        case "pointOnPerpBisector": { if (!fx(c.p) || !fxLine(c.line)) return null; const l = lineEnds.get(c.line)!; return Math.abs(dist(c.p, l.p1) - dist(c.p, l.p2)); }
        case "symmetric": { if (!fx(c.a) || !fx(c.b) || !fxLine(c.line)) return null; const l = lineEnds.get(c.line)!; const A = P(l.p1), d = lineDir(c.line), a = P(c.a), b = P(c.b); const t = (a.x - A.x) * d.x + (a.y - A.y) * d.y; const mx = 2 * (A.x + t * d.x) - a.x, my = 2 * (A.y + t * d.y) - a.y; return Math.hypot(mx - b.x, my - b.y); }
        // rim dims: the same measures entityDims defines, over the pinned params
        case "rimGap": {
          if (!fxRound(c.round1) || !fxRound(c.round2)) return null;
          const g1 = roundAt(c.round1), g2 = roundAt(c.round2);
          const d = dist(centerOf.get(c.round1)!, centerOf.get(c.round2)!);
          const rd = Math.abs(g1 - g2);
          return Math.abs((d < rd ? rd - d : d - g1 - g2) - c.value);
        }
        case "rimLine": {
          if (!fxRound(c.round) || !fxLine(c.line)) return null;
          return Math.abs((perpDist(centerOf.get(c.round)!, c.line) - roundAt(c.round)) - c.value);
        }
        case "rimPoint": {
          if (!fx(c.p) || !fxRound(c.round)) return null;
          return Math.abs(Math.abs(dist(c.p, centerOf.get(c.round)!) - roundAt(c.round)) - c.value);
        }
        case "radiusDifference":
          return fxRound(c.inner) && fxRound(c.outer)
            ? Math.abs((roundAt(c.outer) - roundAt(c.inner)) - c.value)
            : null;
      }
    };
    for (const c of cons) {
      if (constraintIndexOf(c.id) === null) continue; // implicit pins are exempt
      const res = inertResidual(c);
      if (res === null) continue;
      const list = res <= INERT_TOL ? redundant : conflicts;
      if (!list.includes(c.id)) list.push(c.id);
    }
  }

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

  // THE solve guard. planegcs will happily report Success / dof 0 / no conflict
  // for a solution that drives a radius through zero, or that satisfies an
  // edge-to-edge distance by turning the configuration inside-out (its p2c/c2l
  // measures are unsigned, and c2cdistance's nested branch is unsigned in
  // |r1 - r2|). Neither may reach the document: blame the constraints involved
  // and hand back the PRE-solve geometry, so the caller's existing
  // "keep last good on conflict" path paints a red chip instead of a broken part.
  const badGeom = new Set<string>();
  for (const [eid, rad] of Object.entries(r.circles)) {
    if (!(rad > 0) || !Number.isFinite(rad)) badGeom.add(eid);
  }
  for (const [eid, a] of Object.entries(r.arcs)) {
    if (!(a.radius > 0) || !Number.isFinite(a.radius)) badGeom.add(eid);
  }
  // A LINE that collapses to nothing is the same class of broken geometry as a
  // zero-radius circle, and it was not covered here. Applying `collinear` to two
  // lines already pinned horizontal and vertical is satisfiable ONLY by shrinking
  // one of them to zero length — at zero length a line has no direction, so
  // "parallel" becomes vacuous and planegcs duly reports success on that branch.
  // Seen in the app 2026-08-15: a 65mm edge became 0mm and the L folded flat.
  // The conflict WAS detected (conflicts named both dims and the parallel); the
  // broken geometry was simply applied anyway.
  //
  // Judged only against lines that HAD length, so a degenerate line already in
  // the sketch is not newly refused, and only the collapse itself is caught.
  const lineLen = (e: { x1: number; y1: number; x2: number; y2: number }) =>
    Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  const solvedById = new Map(out.map((e) => [e.id, e]));
  for (const before of entities) {
    if (before.type !== "line") continue;
    const after = solvedById.get(before.id);
    if (!after || after.type !== "line") continue;
    const la = lineLen(after);
    if (!Number.isFinite(la) || (lineLen(before) > LINE_COLLAPSE_EPS && la <= LINE_COLLAPSE_EPS)) {
      badGeom.add(before.id);
    }
  }
  const guardIds = new Set<string>();
  if (badGeom.size) {
    for (const c of cons) {
      if (constraintIndexOf(c.id) === null) continue; // implicit pins aren't the user's fault
      if (roundRefs(c).some((id) => badGeom.has(id))) guardIds.add(c.id);
    }
  }
  // branch invariants: a rim dim must still describe the SAME configuration it
  // was created in (see entityDims.rimGap for why the branches can't be trusted)
  if (constraints.some(isRimDim)) {
    const beforeById = new Map(entities.map((e) => [e.id, e]));
    const afterById = new Map(out.map((e) => [e.id, e]));
    constraints.forEach((c, i) => {
      if (isDriven(c) || !isRimDim(c)) return;
      const cls = rimBranch(c, beforeById);
      if (cls !== null && cls !== rimBranch(c, afterById)) guardIds.add(constraintKey(i));
    });
  }
  if (guardIds.size || badGeom.size) {
    for (const id of guardIds) if (!conflicts.includes(id)) conflicts.push(id);
    return {
      entities, dof: r.dof, ok: false, conflicts,
      overDefined: [...redundant, ...r.partiallyRedundant],
      ...(dragRefused ? { dragRefused } : {}),
    };
  }

  return {
    entities: out, dof: r.dof, ok: r.ok && conflicts.length === r.conflicts.length,
    conflicts, overDefined: [...redundant, ...r.partiallyRedundant],
    ...(dragRefused ? { dragRefused } : {}),
  };
}

/** the round (circle/arc) entity ids a compiled constraint names — the blame
 *  list when one of them solves to a non-positive radius */
function roundRefs(c: SConstraint): string[] {
  switch (c.type) {
    case "diameter": case "circleRadius": return [c.circle];
    case "arcRadius": return [c.arc];
    case "rimGap": return [c.round1, c.round2];
    case "rimLine": case "rimPoint": return [c.round];
    case "radiusDifference": return [c.inner, c.outer];
    case "tangentLC": return [c.circle];
    case "tangentLA": return [c.arc];
    case "tangentCC": case "equalRadiusCC": return [c.c1, c.c2];
    case "tangentCA": case "equalRadiusCA": return [c.circle, c.arc];
    case "tangentAA": case "equalRadiusAA": return [c.a1, c.a2];
    default: return [];
  }
}

/** the rim dims whose configuration `rimBranch` classifies. `radialGap` is
 *  deliberately absent: `difference` is signed, so it cannot invert an annulus
 *  on its own (the negative-radius half of the guard covers the rest). */
const isRimDim = (c: SketchConstraint): boolean =>
  c.type === "c2cDistance" || c.type === "p2cDistance" || c.type === "c2lDistance" ||
  c.type === "offset";

/** The configuration class a rim dimension describes, for the geometry in
 *  `byId` — null for anything that isn't a rim dim (or whose operands are gone,
 *  where there is nothing to compare). Comparing it before and after a solve is
 *  what stops an annulus inverting, a point crossing a rim, or a circle hopping
 *  to the other side of a line while the typed number stays "satisfied". */
function rimBranch(c: SketchConstraint, byId: Map<string, ResolvedEntity>): string | null {
  const round = (id: string): Round | null => {
    const e = byId.get(id);
    return e ? asRound(e) : null;
  };
  if (c.type === "c2cDistance") {
    const a = round(c.c1), b = round(c.c2);
    return a && b ? `nest:${rimNesting(a, b)}` : null;
  }
  if (c.type === "p2cDistance") {
    const e = byId.get(c.e);
    const p = e ? refPoint(e, c.p) : null;
    const cc = round(c.circle);
    if (!p || !cc) return null;
    return `side:${Math.hypot(p.x - cc.x, p.y - cc.y) >= cc.r ? "out" : "in"}`;
  }
  if (c.type === "c2lDistance") {
    const cc = round(c.circle);
    const seg = lineOperand(byId, c.line);
    if (!cc || !seg) return null;
    const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
    const cross = (cc.x - seg.x1) * dy - (cc.y - seg.y1) * dx; // which side of the line
    const len = Math.hypot(dx, dy) || 1;
    return `side:${cross >= 0 ? "+" : "-"}:${Math.abs(cross) / len >= cc.r ? "out" : "in"}`;
  }
  if (c.type === "offset") {
    // Which side of each SOURCE line its copy sits on. Only line pairs can flip:
    // their p2l_distance is unsigned, so a solve could satisfy the number with
    // the copy on the far side. Round pairs use the signed `difference` and are
    // excluded by construction — they contribute a constant "." so the string
    // still compares equal across the solve.
    const sides = c.pairs.map((pr) => {
      const s = lineOperand(byId, pr.src), t = lineOperand(byId, pr.cpy);
      if (!s || !t) return ".";
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const mx = (t.x1 + t.x2) / 2, my = (t.y1 + t.y2) / 2;
      return (mx - s.x1) * dy - (my - s.y1) * dx >= 0 ? "+" : "-";
    });
    return sides.length ? `off:${sides.join("")}` : null;
  }
  return null;
}
