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
import { solveSketch, type SConstraint, type SPoint, type SLine, type SCircle, type SArc, type SolveInput, type SolveResult } from "./solver";
import { circumcenter } from "./arc";
import { rectCorners } from "./region";
import { asRound, lineOperand, refPoint, rimNesting, type Round } from "./entityDims";
import type { SketchConstraint } from "../types";
import { isDriven, projEndSamples } from "../types";
import { isOriginGeometry, isOriginId } from "./origin";

// Below this a line has no usable direction, so any angular constraint on it is
// vacuously satisfiable — which is how a conflicting sketch "solves" by folding
// flat instead of reporting that it cannot be solved.
const LINE_COLLAPSE_EPS = 1e-7;

// A rectangle EXTENT at or below this is a collapse, not a small rectangle.
// Deliberately far above LINE_COLLAPSE_EPS: `collinear` between a rect edge and
// a fixed 45-degree line leaves a 40 mm edge at 4.6035578193937e-7 mm rather
// than at 0, which cleared an absolute 1e-7 and reached the document with
// ok:false and an empty conflict list (so sketchMode wrote it back —
// sketchMode.ts:3585). 1e-3 mm is the bucket coincKey rounds positions into, so
// two corners closer together than that FUSE into one solver point on the very
// next compile and the rectangle stops being a rectangle — that is the scale at
// which this file stops being able to tell two points apart, whatever residual
// the solver reports.
const RECT_COLLAPSE_MIN = 1e-3;

/** How far off exact a tangency may sit before this file stops calling it one,
 *  and how far past a segment's end a touch point may land before it counts as
 *  off the end (as a fraction of that segment's length). A document-scale
 *  number in mm, not an epsilon, for the same reason RECT_COLLAPSE_MIN is one:
 *  a converged solve leaves residuals near 1e-9 and a saved document is rounded
 *  to 1e-6, so the slack costs nothing and a tangency landing exactly on a
 *  rectangle's corner is not condemned by float noise. */
const TANGENT_TOL = 1e-3;

/** What a solve says when it could not keep a tangency on the edge it was
 *  created against. Deliberately NOT the generic "that conflicts with the ones
 *  already on this sketch": nothing conflicts, there is simply no solution left
 *  that touches the segment the user drew. */
export const TANGENT_SPAN_MSG =
  "I could not keep that circle touching the edge it is tangent to, so this constraint was not applied. The only solutions I found move the touch point off that edge.";

export interface SolvePass {
  entities: ResolvedEntity[];
  dof: number;
  ok: boolean;
  conflicts: string[]; // inconsistent constraints (sketch can't solve)
  overDefined: string[]; // redundant + partially-redundant (removable / over-defining)
  /** Set when a requested drag was refused: because the grabbed point is fixed
   *  (projected geometry vs a user `fix` constraint — distinct user messaging),
   *  or because the solve it produced was refused by the geometry guard.
   *  The caller must NOT advance its drag anchor on a refusal: a drifted anchor
   *  re-runs the unbounded nearest-point search from the cursor and captures an
   *  unrelated free point mid-gesture. */
  dragRefused?: "projected" | "fix" | "geometry";
  /** Why this pass came back dirty, when the generic "that constraint conflicts
   *  with the ones already on this sketch" would be a lie. Set by a guard that
   *  refused a solve nothing actually conflicted in — today only the tangent-span
   *  invariant. Callers that withdraw a trial constraint should prefer it over
   *  their own message. */
  reason?: string;
  /** How many anchors a requested mover bias actually handed to the solver.
   *  0 means the bias was dropped before it was attempted. Absent when no bias
   *  was requested at all.
   *
   *  A COUNT rather than a boolean, and that distinction is the whole point: an
   *  over-budget bias (dropped, 0 anchors) and a bias that was attempted with
   *  hundreds of anchors, aborted the wasm heap and fell back both return the
   *  free solve's answer AND both "did not apply a bias". Nothing in `entities`
   *  separates them, so a boolean here would pass identically either way — which
   *  it demonstrably did before this was a count. */
  biasAnchors?: number;
}

const TAU = Math.PI * 2;
const ccwDelta = (from: number, to: number) => ((to - from) % TAU + TAU) % TAU;

/** Most anchors a mover bias may allocate before it gives up and solves free.
 *  Each anchor is a fixed helper point plus a temporary coincidence in the
 *  planegcs wasm heap, and an exhausted heap answers with `Aborted(OOM)` — a
 *  throw that cannot be recovered from once made (see the cap's own note). The
 *  measured cliff is ~400 in a fresh worker and ~300 once a session has been
 *  running; this leaves room for the pressure to move. */
const MAX_BIAS_ANCHORS = 120;

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

/** The one entity a dimension is ABOUT, when it is about exactly one — the
 *  entity to name as the mover (see the bias below) when its value is edited.
 *
 *  Editing a value has no pick order to fall back on, so this is the only thing
 *  that can say which geometry should pay: report d8c5265e typed a new diameter
 *  into a circle held inside a free rectangle by two tangents, and the unbiased
 *  solve split the correction between the circle's centre and the rectangle's
 *  corners — "there is no obvious reason for the box dimensions to change".
 *
 *  null for a genuine TWO-entity dimension, and deliberately: the tool does not
 *  store which operand was picked first (see dimensionTool), so there is no
 *  edited entity to prefer and the free solve stays correct.
 *
 *  A `distance` may name a rectangle EDGE (`R~0` — a locked rectangle width),
 *  which the bias normalises to the rectangle itself. */
export function soleDimEntity(c: SketchConstraint): string | null {
  switch (c.type) {
    case "distance": return c.line;
    case "diameter": return c.circle;
    case "radius": return c.e;
    case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY":
      return c.e1 === c.e2 ? c.e1 : null;
    default: return null;
  }
}

export async function compileAndSolve(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  drag?: { fromX: number; fromY: number; toX: number; toY: number },
  bias?: { moves: string[] },
  pins?: { x: number; y: number }[],
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
      // The origin AXES are pinned exactly like the origin point: mergeable, so
      // a user endpoint made coincident with one is anchored by it, and fixed so
      // the axis itself never moves. Not via projPts — an axis is not projected
      // geometry and must not be described as such.
      if (isOriginGeometry(e.id)) { fixedPts.add(p1); fixedPts.add(p2); }
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
        // Side effect worth knowing: endpointPoint() resolves `rect~k` p0/p1 to
        // that edge's two corners, which is a SECOND spelling of a point the
        // document already addresses as `rect` + corner index. Both work; the
        // pickers deliberately emit only the corner-index form, because the
        // glyph renderer resolves a point operand through refPoint(entity, p)
        // and has no idea what `R~0` is (glyphs.ts).
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
      const pid = getPoint(e.x, e.y, true);
      pointMap.set(e.id, pid);
      // ...and the ORIGIN is additionally PINNED, the same way projected
      // geometry is. Mergeable AND fixed is the combination that matters: a user
      // endpoint made coincident with it fuses onto a fixed point and is
      // anchored by it, which is what stops a dimensioned sketch drifting.
      // Deliberately NOT via projPts — a drag refused by the origin should not
      // be reported as "that is projected geometry".
      if (isOriginId(e.id)) fixedPts.add(pid);
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
  // lines + arcs have two endpoints; a point entity has just one (index ignored);
  // a RECTANGLE has four corners, indexed 0..3 in rectCorners CCW order.
  //
  // The rectangle arm is the same lookup dimPoint makes, on purpose: `p` means
  // the same thing in the document whichever constraint carries it (types.ts),
  // and having two resolvers disagree about it is what silently dropped every
  // coincident/midpoint/symmetric aimed at a corner while `fix` and the
  // dimensions took the identical operand and worked.
  //
  // The CENTRES are here for exactly that reason, one report later: a circle
  // centre (index 0) and an arc centre (index 2) are addressable by every
  // dimension and by `fix`, and a coincident naming one used to compile to
  // nothing at all — dof unchanged, circle unmoved, no warning anywhere
  // (reported 2026-09-01). This resolver and dimPoint now answer the same
  // question the same way, which is the invariant that keeps being broken here.
  const endpointPoint = (entId: string, idx: number): string | undefined => {
    const rc = rectMap.get(entId);
    if (rc) return rc[idx];
    const ln = ends.get(entId);
    if (ln) return idx === 0 ? ln[0] : ln[1];
    const ar = arcMap.get(entId);
    if (ar) return idx === 2 ? ar.center : idx === 0 ? ar.ourS : ar.ourE;
    const ct = centers.get(entId);
    if (ct) return ct;
    const pt = pointMap.get(entId);
    if (pt) return pt;
    const sp = splineMap.get(entId);
    if (sp) return idx === 0 ? sp[0] : sp[sp.length - 1];
    return undefined;
  };
  // resolve a circle/arc center to its solver point id
  const centerPoint = (entId: string): string | undefined =>
    centers.get(entId) ?? arcMap.get(entId)?.center;
  // A dimension's pick and a constraint's pick are THE SAME LOOKUP now, and this
  // alias is all that is left of the second one. There were two resolvers for
  // years and they disagreed twice: about rectangle corners (fixed 2026-08-17,
  // after every rect-corner constraint had silently compiled to nothing) and
  // about circle and arc centres (fixed 2026-09-05, same symptom, same shape of
  // report). `p` means one thing in the document whatever constraint carries it,
  // so it gets one resolver.
  const dimPoint = endpointPoint;
  const isCircle = (id: string) => centers.has(id);
  // a circle OR arc primitive — planegcs's Arc derives from Circle, so the rim
  // (edge-to-edge) constraints accept either
  const isRound = (id: string) => centers.has(id) || arcMap.has(id);
  // entity kind by id (line/circle/arc) — one lookup for the tangent/equal ladders
  const kindOf = (id: string): "line" | "circle" | "arc" | undefined =>
    ends.has(id) ? "line" : centers.has(id) ? "circle" : arcMap.has(id) ? "arc" : undefined;
  // Which rectangles a solve could MIRROR in a way a user constraint can SEE.
  //
  // Not "which rectangles are named". The write-back rebuilds a rectangle from
  // the MIN/MAX bounding box of its solved corners, so a mirrored rectangle
  // comes back with its corner LABELS permuted: document corner j holds
  // T(solver corner j), where T is the reflection about the rectangle's own
  // mid-axis. T is an isometry that maps the rectangle onto itself, so a
  // constraint whose operands all sit on that one rectangle keeps exactly the
  // residual it had in the solver. Dimension an edge, then drag a corner past
  // the opposite one: the shape and the dimension both come out right (measured
  // — top and bottom of an axis-aligned rectangle are the same length, so a
  // length dim cannot tell which of them it landed on), and refusing it would
  // freeze a gesture that ships today.
  //
  // Two things break that argument, and each one scopes the guard below:
  //   another entity  the reflection moves the rectangle and not the geometry
  //                   its corner is tied to, so the residual changes
  //   `fix`           an absolute pin. It stays SATISFIED across the mirror —
  //                   `fix` stores no target, it pins whatever point the corner
  //                   index resolves to on each compile — but it silently
  //                   changes which corner it means: measured, pinning corner 2
  //                   at (20,10) and dragging corner 0 past it leaves the
  //                   document with corner 2 at (25,15) and the pinned point
  //                   relabelled as corner 0. A pin that lets its own point move
  //                   is the corner-identity bug wearing a stable-looking result.
  //
  // `angle` was in that list and is deliberately NOT: it is the one SIGNED
  // predicate here, but a single-axis mirror of a rectangle NEGATES the angle
  // between two of its edges, so the solver cannot produce one without breaking
  // the very constraint it is enforcing, and a two-axis mirror is a 180-degree
  // rotation, which preserves signed angles. Measured both ways — with `angle`
  // excluded, the mirroring drag of a 90-degree-dimensioned rectangle is
  // accepted and three following pumps are byte-identical.
  //
  // Read off the constraint's own fields rather than instrumenting each compile
  // branch: a constraint type added later that names a rect edge would otherwise
  // slip through silently, which is exactly the miss class that let endpointPoint
  // and dimPoint drift apart about rectangle corners. But only for a constraint
  // that actually COMPILED — one the compile dropped constrains nothing, and
  // scoping the guard by spelling froze the drag of a rectangle whose only
  // constraint was a coincident the compiler had thrown away.
  const rectAddressed = new Set<string>();
  const rectOf = (v: string): string | undefined => {
    if (rectMap.has(v)) return v; // `R` + a corner index (dimPoint's convention)
    const cut = v.lastIndexOf("~"); // `R~k`, an edge id
    const base = cut > 0 ? v.slice(0, cut) : "";
    return rectMap.has(base) ? base : undefined;
  };
  const namesEntity = (v: string) =>
    ends.has(v) || centers.has(v) || arcMap.has(v) || pointMap.has(v) || splineMap.has(v);
  const noteRectScope = (c: SketchConstraint) => {
    const rects = new Set<string>();
    let observable = c.type === "fix";
    const read = (v: unknown) => {
      if (typeof v !== "string") return;
      const rect = rectOf(v);
      if (rect) rects.add(rect);
      else if (namesEntity(v)) observable = true;
    };
    for (const [k, v] of Object.entries(c)) if (k !== "type") read(v); // `type` is not an operand
    // `offset` is the one type whose operands are not plain string fields.
    // Belt and braces, and labelled as such: `offset` is ALSO a rim dim
    // (isRimDim below), so the rim-branch invariant refuses any solve that moves
    // a copy to the other side of its source, and in all four fixtures tried
    // (rect-to-rect, and a plain-line copy above/below with the source being
    // edge 0 or edge 2) THAT is what refuses the mirroring drag — removing this
    // line changed no measured outcome. It stays because rimBranch compares only
    // which SIDE the copy sits on, and a mirror can move the source edge's line
    // while leaving the copy on the same side of it.
    if (c.type === "offset") for (const pr of c.pairs) { read(pr.src); read(pr.cpy); }
    // two rectangles in one constraint: each is "something else" to the other,
    // and only one of them may mirror
    if (observable || rects.size > 1) for (const rect of rects) rectAddressed.add(rect);
  };
  constraints.forEach((c, i) => {
    const id = constraintKey(i); // user constraint ids never collide with `~` implicit ones
    if (isDriven(c)) return; // reference dim: measured only, never constrains
    // (so it also cannot force a mirror — which is why the scope note at the
    // bottom of this callback sits after this return rather than before it)
    const compiled = cons.length, pinned = fixedPts.size;
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
    else if (c.type === "p2pDistanceX" || c.type === "p2pDistanceY") {
      // Operand order is load-bearing: these are SIGNED, so a and b must stay
      // as the user picked them (see types.ts).
      const a = dimPoint(c.e1, c.p1), b = dimPoint(c.e2, c.p2);
      const kind = c.type === "p2pDistanceX" ? "distanceX" : "distanceY";
      if (a && b && a !== b) cons.push({ id, type: kind, a, b, value: c.value });
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
    // Anything that reached the solver — an equation, or a pinned point (`fix`
    // pushes no constraint, it flags the point) — can hold a rectangle against
    // its own mirror image. Anything that did not, cannot.
    if (cons.length !== compiled || fixedPts.size !== pinned) noteRectScope(c);
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

  // --- "what you picked is what moves" (bug #86) -----------------------------
  // A rectangle expands into 4 free corner points plus 4 implicit
  // horizontal/vertical rules (:160-186), which leaves it 4 DOF with nothing
  // that says "keep my drawn size". So a distance dimension from a circle to one
  // of its edges compiles to ONE p2l_distance over three free x-coordinates, and
  // planegcs is free to split the correction between the circle and the
  // rectangle — which it does, and not stably: field report 787121b3 typed 6 mm
  // from a circle to a 40x40 rectangle's left edge and got a 39.890111 x 40
  // rectangle, and moving the circle's start position 0.13 mm swings the split
  // from 39%/61% to 100% either way. This is a MISSING POLICY, not a broken
  // function: every one of those solutions satisfies the constraint.
  //
  // The policy is the first-picked entity moves. Everything else is held at its
  // INPUT state for this one solve — position AND radius, with the drag pin's
  // device, the only bias the vendored solver offers (see SolveInput.anchors and
  // .radiusAnchors for why there is no weight to reach for instead).
  //
  // Four rules, all load-bearing:
  //   only the REACHABLE     an anchor costs two wasm primitives, and planegcs's
  //                          heap is small enough that anchoring a whole sketch
  //                          aborts it (see `reachable` below). A point no
  //                          compiled constraint can reach cannot move, so
  //                          holding it still buys nothing and costs the solve.
  //   shared points stay FREE  merged corners belong to two entities, and an
  //                            anchor on a point the MOVER also owns freezes the
  //                            mover through the back door.
  //   fixed points are skipped they cannot move anyway; a second pin is noise.
  //   circle radii too       a circle's radius hangs off no point, so pinning
  //                            its centre alone leaves the solver free to pay in
  //                            radius — which on the tangent gesture it did,
  //                            harder than with no bias at all. (An arc's DOES
  //                            hang off points, so a non-mover arc needs no pin
  //                            of its own; a mover arc, whose points are free by
  //                            definition, does. See below.)
  const anchors: { point: string; x: number; y: number }[] = [];
  const radiusAnchors: { id: string; radius: number; arc?: boolean }[] = [];
  if (bias?.moves.length) {
    // A mover spelled as a rectangle EDGE (`R~3`) is the rectangle. `own()`
    // already attributes an edge's corners to the rectangle, so without this
    // normalisation such a mover matches NOTHING, every point in the sketch is
    // anchored including the ones it meant to free, and the gesture silently
    // degrades to "moves nothing" — bug #86's exact symptom with no signal.
    // No caller spells it that way today; both dimensionTool and constraintTools
    // stamp `ent.id`. This is here so the next one cannot be caught by it — and
    // one now is: a locked rectangle width is a `distance` on `R~0`, and
    // soleDimEntity hands that edge straight through as the mover.
    const movers = new Set(bias.moves.map((id) => rectOf(id) ?? id));
    const owners = new Map<string, Set<string>>(); // solver point -> entities that own it
    const own = (entId: string, ...pids: (string | undefined)[]) => {
      for (const pid of pids) {
        if (pid === undefined) continue;
        let s = owners.get(pid);
        if (!s) owners.set(pid, (s = new Set()));
        s.add(entId);
      }
    };
    for (const [id, cp] of rectMap) own(id, ...cp);
    // `ends` carries rectangle EDGES too (`R~k`), and `moves` names ENTITIES —
    // attribute an edge to its rectangle or naming the rectangle would fail to
    // free its own corners.
    for (const [id, e] of ends) own(rectOf(id) ?? id, ...e);
    for (const [id, c] of centers) own(id, c);
    for (const [id, a] of arcMap) own(id, a.ourS, a.ourE, a.center);
    for (const [id, ps] of splineMap) own(id, ...ps);
    for (const [id, p] of pointMap) own(id, p);

    // WHICH points this solve could move at all. Everything else is anchored for
    // nothing, and "for nothing" is not free: each anchor is a fixed helper point
    // plus a temporary coincidence, and planegcs's wasm heap ABORTS (OOM, a throw
    // that escapes to sketchMode's pump() and kills constraint solving for the
    // rest of the session) somewhere past a few hundred of them. Measured before
    // this scoping: 300 lines + a rectangle + a circle — 605 points — solved free
    // in 35 ms and threw Aborted(OOM) the moment a dimension was placed on it.
    // The cliff is memory PRESSURE, not a bound, so it moves with how long the
    // session has run; the answer is not a cap but not generating the anchors.
    //
    // Reachability is over the COMPILED constraints, implicit rectangle rules
    // included — that is what carries a correction from a dimensioned edge round
    // to the other three corners. A FIXED point terminates the walk: it cannot
    // transmit motion, so nothing past it needs holding. Rounds are collected
    // alongside because a radius couples through a constraint (equal-radius)
    // that may name no free point at all.
    const pointIds = new Set(points.map((p) => p.id));
    const groups = cons.map((c) => {
      const pts: string[] = [], rounds: string[] = [];
      const take = (v: unknown): void => {
        if (typeof v === "string") {
          if (pointIds.has(v)) { pts.push(v); return; }
          const e = ends.get(v);
          if (e) { pts.push(e[0], e[1]); return; }
          const ctr = centers.get(v);
          if (ctr) { pts.push(ctr); rounds.push(v); return; }
          const a = arcMap.get(v);
          if (a) { pts.push(a.ourS, a.ourE, a.center); rounds.push(v); return; }
        } else if (Array.isArray(v)) v.forEach(take);
        else if (v && typeof v === "object") Object.values(v).forEach(take);
      };
      for (const [k, v] of Object.entries(c)) { if (k !== "id" && k !== "type") take(v); }
      return { pts, rounds };
    });
    const groupsAt = new Map<string, number[]>();
    groups.forEach((g, i) => {
      for (const p of g.pts) {
        let l = groupsAt.get(p);
        if (!l) groupsAt.set(p, (l = []));
        l.push(i);
      }
    });
    const reachable = new Set<string>();
    const reachableRounds = new Set<string>();
    const queue: string[] = [];
    const reach = (pid: string) => {
      if (reachable.has(pid)) return;
      reachable.add(pid);
      if (!fixedPts.has(pid)) queue.push(pid); // a fixed point conducts nothing
    };
    for (const p of points) {
      const ow = owners.get(p.id);
      if (ow && [...ow].some((id) => movers.has(id))) reach(p.id);
    }
    // A drag frame moves its grabbed point too, so the correction spreads from
    // there as well. (Nothing pairs a drag with a bias today; leaving it out
    // would make that combination anchor the wrong half of the sketch.)
    if (dragInput) reach(dragInput.point);
    const walked = new Set<number>();
    while (queue.length) {
      const p = queue.pop()!;
      for (const gi of groupsAt.get(p) ?? []) {
        if (walked.has(gi)) continue;
        walked.add(gi);
        const g = groups[gi]!;
        for (const q of g.pts) reach(q);
        for (const rd of g.rounds) reachableRounds.add(rd);
      }
    }

    for (const p of points) {
      if (fixedPts.has(p.id)) continue;
      if (!reachable.has(p.id)) continue;
      const ow = owners.get(p.id);
      if (ow && [...ow].some((id) => movers.has(id))) continue;
      anchors.push({ point: p.id, x: p.x, y: p.y });
    }
    // No `some`/`every` question here, unlike the points: a radius belongs to
    // exactly one entity, so "owned by a mover" is a plain id compare. A
    // PROJECTED circle is skipped for the same reason a fixed point is — its
    // `~r` pin already holds the radius rigid and a second pin is noise.
    //
    // CIRCLES ONLY here, deliberately. A NON-MOVER arc needs no radius pin: its
    // centre is compiled as a non-mergeable point (compileArc), so nothing can
    // ever merge onto it and a non-mover arc's centre is therefore always
    // anchored — and `arc_rules` holds both endpoints on the circle, so centre +
    // either endpoint already fixes the radius. Measured: adding an arc_radius
    // pin changes no arc solve this suite can construct. The tangent-on-an-arc
    // test covers that the radius does stay put; it just does not need this to.
    // (A MOVER arc is the opposite case — none of those points are anchored,
    // because they belong to the mover. See the second loop below.)
    for (const c of circles) {
      if (movers.has(c.id) || projRounds.has(c.id)) continue;
      if (reachableRounds.has(c.id)) radiusAnchors.push({ id: c.id, radius: c.radius });
    }
    // ...and the MOVER's own radius, on a POSITION gesture ONLY.
    //
    // A rim dim ("6 mm from this circle's EDGE to that line") measures a
    // position, not a size, so the mover paying in radius is never what the
    // gesture meant — and it is worse than unhelpful: with the centre free and
    // the radius free, planegcs takes the radius NEGATIVE (circle r5, line 20 mm
    // off, circle picked first: raw solved radius -1.4999999999999982), the
    // geometry guard below condemns the whole pass, and the fallback quietly
    // hands back the free solve — which moves the LINE the user measured FROM.
    // So the one gesture the policy exists for did not apply to itself, invisibly.
    //
    // TANGENCY is the same shape of gesture and belongs in the same set — field
    // report fd7dcc5f. "Make this circle touch that edge" says where the circle
    // goes, not how big it is, but with both free planegcs splits the correction
    // evenly: circle r10 in a 100x60 rectangle, tangent to the bottom edge,
    // circle picked first landed at centre y -10 with the radius grown 10 -> 20.
    // What made it read as arbitrary rather than merely wrong is that typing a
    // value into the circle's ⌀ badge creates a driving `diameter`, which lands
    // in `radiusGoverned` below and vetoes the split — so the SAME gesture moved
    // the circle when it happened to carry a dimension and resized it when it
    // did not, through two badges that render identically.
    //
    // Scoped hard, because a radius pin on the mover is exactly wrong for a SIZE
    // dim: any constraint that governs this circle's radius (diameter, radius,
    // equal-radius, an offset's `difference`) vetoes the pin. That is what keeps
    // "equal-radius moves the circle you picked first" — where the mover's radius
    // MUST change — working.
    const positionMovers = new Set<string>();
    const radiusGoverned = new Set<string>();
    for (const c of cons) {
      if (c.type === "rimGap") { positionMovers.add(c.round1); positionMovers.add(c.round2); }
      else if (c.type === "rimLine") positionMovers.add(c.round);
      else if (c.type === "rimPoint") positionMovers.add(c.round);
      else if (c.type === "tangentLC") positionMovers.add(c.circle);
      else if (c.type === "tangentLA") positionMovers.add(c.arc);
      else if (c.type === "tangentCC") { positionMovers.add(c.c1); positionMovers.add(c.c2); }
      else if (c.type === "tangentCA") { positionMovers.add(c.circle); positionMovers.add(c.arc); }
      else if (c.type === "tangentAA") { positionMovers.add(c.a1); positionMovers.add(c.a2); }
      else if (c.type === "diameter" || c.type === "circleRadius") radiusGoverned.add(c.circle);
      else if (c.type === "arcRadius") radiusGoverned.add(c.arc);
      else if (c.type === "equalRadiusCC") { radiusGoverned.add(c.c1); radiusGoverned.add(c.c2); }
      else if (c.type === "equalRadiusCA") { radiusGoverned.add(c.circle); radiusGoverned.add(c.arc); }
      else if (c.type === "equalRadiusAA") { radiusGoverned.add(c.a1); radiusGoverned.add(c.a2); }
      else if (c.type === "radiusDifference") { radiusGoverned.add(c.inner); radiusGoverned.add(c.outer); }
    }
    for (const c of circles) {
      if (!movers.has(c.id) || projRounds.has(c.id)) continue;
      if (positionMovers.has(c.id) && !radiusGoverned.has(c.id)) radiusAnchors.push({ id: c.id, radius: c.radius });
    }
    // The arc half, spelled `arc_radius`. Measured before it: a mover arc under
    // tangent grew 5 -> 7.95, the circle bug with a different primitive name.
    for (const a of arcs) {
      if (!movers.has(a.id) || projRounds.has(a.id)) continue;
      if (positionMovers.has(a.id) && !radiusGoverned.has(a.id)) radiusAnchors.push({ id: a.id, radius: a.radius, arc: true });
    }
  }
  // A LAST bound, because reachability is not one. Scoping the anchors to what
  // the solve can reach (above) removes them for an unrelated fan of geometry,
  // but reachability spreads through the constraint graph, so one hub entity
  // re-couples the whole sketch: a circle dimensioned to a line that N others
  // are `parallel` to reaches 2N+1 points, and the anchor count is back to
  // O(connected component). Measured on that shape, anchoring aborts the wasm
  // heap somewhere past a few hundred anchors.
  //
  // The abort CANNOT be recovered from downstream, which is what makes a cap the
  // fix rather than a nicety: the failed biased pass has already taken the heap,
  // so the free retry beneath it aborts too and the throw reaches pump(), which
  // reads it as a dead solver and turns constraint solving off for the rest of
  // the sketch session. The retry's own comment reasoned that at that size "the
  // free solve has no heap either" — but the free solve of the same model run
  // FIRST succeeds, so the model is fine and it is the abandoned attempt that
  // poisons it. Do not allocate what cannot be paid for.
  //
  // Dropping the bias is the honest degradation: it restores exactly today's
  // free solve, which is the "never worse than before" bar this whole change is
  // held to, and it costs the preference only on sketches big enough that the
  // alternative was losing the solver outright. The budget sits well under the
  // measured cliff (~400 anchors fresh, ~300 in a worker that has been running a
  // while) because the cliff is memory PRESSURE and moves with session age.
  if (anchors.length > MAX_BIAS_ANCHORS) {
    anchors.length = 0;
    radiusAnchors.length = 0;
  }
  // --- caller-supplied position pins ----------------------------------------
  // The BODY drag's device. It has no grabbed solver point to hand `drag`: it
  // translates a whole entity (and the neighbour endpoints merged onto its
  // corners) itself, then asks the solver to re-satisfy everything AROUND that
  // — which without a pin it does by sliding the entity back off the cursor,
  // because an under-constrained profile is free to move the dragged side
  // instead of the fillets attached to it (measured: 3.6-4.0 mm of a 4.24 mm
  // drag). Soft `anchors`, not `fixed`, so a real constraint that must move the
  // corner still wins.
  //
  // Keyed by POSITION, in coincKey's bucket: a caller knows where it put
  // geometry, not what the compiler called the point. Every point in that bucket
  // is held, which is exactly what "this corner stays here" means when several
  // primitives share it.
  //
  // Deliberately AFTER the bias budget above, so a pin can never be dropped by
  // an anchor allowance it did not spend: a drag pins at most a rectangle's four
  // corners, and nothing pairs a drag frame with a bias.
  if (pins?.length) {
    const wanted = new Set(pins.map((q) => key(q.x, q.y)));
    const taken = new Set(anchors.map((a) => a.point));
    for (const p of points) {
      if (!wanted.has(key(p.x, p.y)) || fixedPts.has(p.id) || taken.has(p.id)) continue;
      anchors.push({ point: p.id, x: p.x, y: p.y });
    }
  }
  const biased = anchors.length > 0 || radiusAnchors.length > 0;

  const model = { points, lines, circles, arcs, constraints: cons, ...(dragInput ? { drag: dragInput } : {}) };
  /** The ROUND entities whose tangency the LAST `finish()` found on the wrong
   *  root — the seed pass's pin list. Rewritten by every finish(), so a caller
   *  that means to act on it must read it before running another one. */
  const tangentFlipped = new Set<string>();
  // EVERYTHING between the raw solve and the answer, as a function of that raw
  // solve. It is a closure and not a top-level helper only because it reads two
  // dozen compile-time locals; what matters is that it can be run TWICE.
  //
  // It has to be. The geometry guard below is where a collapsed rectangle turns
  // into `ok:false` + a blamed constraint — 170 lines AFTER the solve. Judging
  // the biased pass on solveSketch's own return therefore judged it before the
  // half that can condemn it had run: an anchored pass that squashed a rectangle
  // reported ok:true / conflicts:[], the fallback below never fired, and
  // sketchMode withdrew a perfectly good constraint with a "that conflicts with
  // the ones already on this sketch" toast. Reproduced on a 40x20 rectangle and
  // a line, Perpendicular with the rect edge picked first.
  const finish = (r: SolveResult): SolvePass => {
    tangentFlipped.clear(); // this pass's verdict, not the previous pass's
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
          // SIGNED, so the residual is against the signed separation — |b-a|
          // would read a correctly-satisfied "20 to the left" as a 40 error.
          case "distanceX": return fx(c.a) && fx(c.b) ? Math.abs((P(c.b).x - P(c.a).x) - c.value) : null;
          case "distanceY": return fx(c.a) && fx(c.b) ? Math.abs((P(c.b).y - P(c.a).y) - c.value) : null;
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
    // A RECTANGLE is the same class of broken geometry, on the path neither check
    // above could reach: a rectangle is never a `line` entity, so its four edges
    // were invisible to the loop above, and expectSaneGeometry had no case for it
    // either. `vertical` on an edge already pinned horizontal by the rectangle's
    // own `~h0` rule is the plainest form — a flat contradiction whose only
    // solution is a zero-length edge, which planegcs finds and reports Success
    // for. Measured before this landed: 40x20 -> 0x20, ok:true, conflicts:[].
    //
    // Both halves below read the SIGNED extents off the solved corner POINTS, not
    // the width/height `out` wrote back, because that write-back is a MIN/MAX
    // bounding box (:622-629) and the bbox is exactly what destroys the second
    // half. With the four implicit ~h/~v pins holding, the solved corners stay an
    // axis-aligned (possibly degenerate) rectangle, so c1.x-c0.x and c3.y-c0.y ARE
    // the rectangle, sign included — two sign bits is the whole of what a solve
    // can do to corner identity. (Tried to break the pins with `parallel(R~0, a
    // fixed 45 degree line)`: the solver collapsed edge 0 rather than rotating it,
    // because a zero-length line has no direction and `parallel` then goes
    // vacuous. `collinear` against the same line does the same thing but stops at
    // 4.6e-7 mm rather than at 0, which is why the collapse threshold below is a
    // document-scale one. Two cases, not a proof: if a solve ever does rotate a
    // rectangle, these signed extents stop describing it and this guard needs the
    // corner positions themselves.)
    //
    //   extent under RECT_COLLAPSE_MIN
    //                 COLLAPSED. Refused for any rectangle, exactly as a line is.
    //                 The threshold is a document-scale one, not an epsilon: a
    //                 solve landed a 40 mm edge at 4.6e-7 mm and walked out with
    //                 ok:false and no conflicts, which the caller writes back.
    //   sign FLIPPED  the solver satisfied the constraint by MIRRORING. The shape
    //                 is fine; the bbox then relabels the corners, so the
    //                 constraint is true in the solver and false in the document,
    //                 and the next pump closes that gap by eating the rectangle
    //                 (measured: 40x20 -> 10x20 on solve 1, then 0x0 on solve 2).
    //
    // A rectangle entity is x/y/width/height and has nowhere to CARRY the mirror.
    // Signed width/height is the only in-type candidate and three separate
    // mechanisms erase or reject it: the parameter re-assert overwrites a
    // solver-written negative on the next mutate (store.ts:817-820), evalDimInput
    // refuses non-positive input so the badge would show a value it will not take
    // back (sketchMode.ts:967,976), and a negative extent inverts rectCorners'
    // documented CCW winding, which face classification reads as the outer face
    // (region.ts:101,678). So the mirror is refused rather than represented — the
    // same call pattern.ts:71 already makes for rotation.
    //
    // The flip half fires ONLY for a rectangle in `rectAddressed` — one a
    // compiled constraint ties to something the mirror does not move. Everything
    // else must go through: dragging a free rectangle's corner past the opposite
    // one mirrors both signs and correctly follows the cursor, and so does
    // dragging a corner of a rectangle that merely carries an edge dimension. A
    // refused drag frame is not free either — the caller has to be told to keep
    // its anchor (see the dragRefused note at the guard's return).
    for (const before of entities) {
      if (before.type !== "rectangle") continue;
      const cp = rectMap.get(before.id);
      if (!cp) continue;
      const c0 = r.points[cp[0]!], c1 = r.points[cp[1]!], c3 = r.points[cp[3]!];
      if (!c0 || !c1 || !c3) continue;
      const w = c1.x - c0.x, h = c3.y - c0.y;
      if (!Number.isFinite(w) || !Number.isFinite(h)) { badGeom.add(before.id); continue; }
      // Judged only against a rectangle that HAD size, mirroring the line arm's
      // `lineLen(before) > LINE_COLLAPSE_EPS` gate: a 40x0 rectangle can exist in
      // a document, and refusing every solve that leaves it flat would freeze the
      // sketch permanently instead of fixing anything.
      const hadW = Math.abs(before.width) > RECT_COLLAPSE_MIN;
      const hadH = Math.abs(before.height) > RECT_COLLAPSE_MIN;
      if ((hadW && Math.abs(w) <= RECT_COLLAPSE_MIN) || (hadH && Math.abs(h) <= RECT_COLLAPSE_MIN)) {
        badGeom.add(before.id);
      } else if (rectAddressed.has(before.id)
        && ((hadW && Math.sign(w) !== Math.sign(before.width))
          || (hadH && Math.sign(h) !== Math.sign(before.height)))) {
        badGeom.add(before.id);
      }
    }
    const guardIds = new Set<string>();
    if (badGeom.size) {
      for (const c of cons) {
        if (constraintIndexOf(c.id) === null) continue; // implicit pins aren't the user's fault
        // A collapsed line or rectangle has to blame the constraint that asked
        // for it. This used to consult a roundRefs() that enumerated circle and
        // arc operands only, so it named nothing for the two shapes the guard
        // above actually catches; that function had no other caller and is gone.
        if (entityRefs(c).some((id) => badGeom.has(id))) guardIds.add(c.id);
      }
    }
    // branch invariants: a rim dim must still describe the SAME configuration it
    // was created in (see entityDims.rimGap for why the branches can't be trusted)
    const hasTangentLine = cons.some((c) => c.type === "tangentLC" || c.type === "tangentLA");
    if (constraints.some(isRimDim) || hasTangentLine) {
      const beforeById = new Map(entities.map((e) => [e.id, e]));
      const afterById = new Map(out.map((e) => [e.id, e]));
      constraints.forEach((c, i) => {
        if (isDriven(c) || !isRimDim(c)) return;
        const cls = rimBranch(c, beforeById);
        if (cls !== null && cls !== rimBranch(c, afterById)) guardIds.add(constraintKey(i));
      });
      // ...and the same thing for a tangency, which had no invariant at all.
      //
      // planegcs's `tangent_lc` / `tangent_la` constrain the round to the
      // INFINITE line its operand lies on, and nothing downstream looked at
      // WHERE on that line the touch point landed. So the MIRRORED root — the
      // circle on the far side of the edge, touching the edge's extension past
      // its end — has residual exactly 0 and is reported ok:true, conflicts:[].
      //
      // Field report 043773a0: a 30 mm circle held in the corner of a rigid
      // 60x50 box by two tangents jumped 30 mm straight down the moment a
      // `concentric` was applied with the OTHER circle picked first. It stayed
      // tangent to the bottom edge (mirrored across it) and "tangent" to the
      // left edge 15 mm below that edge's lower end. Both halves are checked
      // here, because each catches one of those two edges and only their union
      // catches the jump: a circle mirrored across a single long edge stays
      // perfectly in span.
      //
      // Both fire only on a change FOR THE WORSE, the way the rect-mirror guard
      // is judged only against a rectangle that had size:
      //   span  in-span -> out-of-span. A tangency the user created against an
      //         extension is legal and stays legal; so does a solve that leaves
      //         one out of span where it already was.
      //   side  only once the tangency ALREADY HOLDS. On the solve that creates
      //         a tangent the circle is not yet touching anything, so it has
      //         chosen no side and moving it to the near one is the whole point
      //         of the gesture.
      for (const c of cons) {
        if (c.type !== "tangentLC" && c.type !== "tangentLA") continue;
        if (constraintIndexOf(c.id) === null) continue; // no implicit tangencies today
        const roundId = c.type === "tangentLC" ? c.circle : c.arc;
        const b = tangentTouch(beforeById, c.line, roundId);
        const a = tangentTouch(afterById, c.line, roundId);
        if (!b || !a) continue;
        if ((b.inSpan && !a.inSpan) || (b.tangent && b.side !== a.side)) {
          guardIds.add(c.id);
          tangentFlipped.add(roundId);
        }
      }
    }
    if (guardIds.size || badGeom.size) {
      for (const id of guardIds) if (!conflicts.includes(id)) conflicts.push(id);
      // A refused DRAG frame has to SAY it was refused, and `conflicts` is not
      // enough on its own. A drag with no user constraint on the collapsing
      // entity still blames nobody (there is nothing to blame), so the caller's
      // conflict path would not fire — it would take the ordinary branch and advance its drag
      // anchor to the cursor (sketchMode.ts:3558). The next frame's nearest-point
      // search then runs from an origin the grabbed point is no longer at, grabs a
      // different point, and yanks THAT one mid-gesture. `dragRefused` is the
      // existing "keep your anchor" channel, so a geometry refusal joins it rather
      // than inventing a second one.
      const refused = dragRefused ?? (drag ? ("geometry" as const) : undefined);
      return {
        entities, dof: r.dof, ok: false, conflicts,
        overDefined: [...redundant, ...r.partiallyRedundant],
        ...(refused ? { dragRefused: refused } : {}),
        ...(tangentFlipped.size ? { reason: TANGENT_SPAN_MSG } : {}),
      };
    }

    // NOTE, deliberately left as it is: this hands back `out` — the SOLVED
    // geometry — even when r.ok is false, and the caller writes it back because it
    // branches on `conflicts.length`, not on ok (sketchMode.ts:3547,3585). That is
    // wanted for a drag frame the solver merely did not fully converge on, but it
    // is also why the guard above must catch broken geometry itself rather than
    // relying on ok:false to protect the document. Revisit the day a
    // non-converged solve is seen writing something a user notices.
    return {
      entities: out, dof: r.dof, ok: r.ok && conflicts.length === r.conflicts.length,
      conflicts, overDefined: [...redundant, ...r.partiallyRedundant],
      ...(dragRefused ? { dragRefused } : {}),
    };
  };

  // Take the biased pass only if it is CLEAN — judged on the FINAL pass, guard
  // included — and otherwise discard it whole, result and diagnostics alike, for
  // today's free solve. sketchMode withdraws a trial constraint, with a "that
  // conflicts with the ones already on this sketch" toast, on `!ok` or any
  // conflict (sketchMode.ts:3666). A bias is a preference about WHICH valid
  // solution to land on; it must never be able to turn a good constraint into a
  // withdrawn one.
  //
  // This is a routine path, not insurance, and that was the miss: anchoring the
  // non-mover is exactly what removes the solver's freedom to avoid a collapse,
  // so the bias makes the rectangle guard fire STRICTLY MORE OFTEN than the free
  // solve does. Measured over 364 random circle+rectangle p2l-distance sketches
  // that the FREE solve handles cleanly: the anchored pass was discarded on 74
  // of them (20%). (`temporary` really does keep the anchors out of dof /
  // conflicts / redundant, so planegcs itself still never fails because of one —
  // it is the geometry they steer it into that does.)
  //
  // The fallback is not a guarantee of a clean answer, only of never being
  // WORSE than the unbiased solve: 3 of those 364 came back dirty even after
  // falling back, and a control that ran two plain free solves instead of a
  // biased one hit the same thing 2 times out of 364. That residual is the
  // process-state bistability solveReproducibility.test.ts documents, which
  // predates every line of this bias.
  //
  // The biased pass may also THROW rather than return: anchors cost wasm heap,
  // and planegcs answers an exhausted heap with `Aborted(OOM)` out of
  // solve_system. Scoping the anchors to what the solve can reach is what keeps
  // that off the routine path, but the cliff is memory PRESSURE and moves with
  // how long the session has run, so it cannot be ruled out by counting. A throw
  // here escapes to sketchMode's pump(), which reads it as a dead solver and
  // turns constraint solving off for the whole sketch session — so the bias must
  // swallow its own: an abort is one more reason to fall back to today's free
  // solve, not a reason to lose the solver. A throw from the FREE solve is left
  // alone; that one IS a dead solver, and the retry below rethrows it.
  //
  // Measured, on a fan of N lines all `parallel` to the one a circle is
  // dimensioned from (2N+1 reachable points over N constraints — the shape where
  // the anchors, not the model, are what runs the heap out): at N=150 and N=180
  // the anchored pass aborts and this retry returns ok:true, and at N=200 the
  // free solve has no heap either and the throw goes through, which is correct.
  // Not pinned by a test on purpose: the threshold moves with how many solves ran
  // before it, so any such test would be a coin flip on its neighbours.
  let pass: SolvePass;
  try {
    pass = finish(await solveSketch(biased ? { ...model, anchors, radiusAnchors } : model));
  } catch (err) {
    if (!biased) throw err;
    return { ...finish(await solveSketch(model)), ...(bias ? { biasAnchors: anchors.length } : {}) };
  }
  if (biased && !(pass.ok && pass.conflicts.length === 0)) pass = finish(await solveSketch(model));

  if (!drag && !(pass.ok && pass.conflicts.length === 0)) {
    // The TANGENT-ROOT seed. Same contract as the length-pinned seed below (and
    // the same exclusion of drag frames, for the same reasons): one pass with
    // something held still, whose GEOMETRY is then the starting point of one
    // ordinary free solve, kept only if that comes back clean.
    //
    // What it holds is the flipped round's own CENTRE, because the seed below
    // cannot rescue this failure at all: a mirrored circle breaks no line's
    // length, so a length-pinned pass reproduces the flip and hands back the
    // same wrong root — measured, and so does a bare nudge with nothing pinned.
    // Pinning the centre reaches the good root: on the reporter's sketch that
    // pass converges to the circle unmoved with the 50 mm circle brought onto
    // it, clean, and the free solve started from there stays.
    //
    // Read the offenders out FIRST: every finish() below rewrites them.
    //
    // `fixed: true` on the model point rather than a `fix` CONSTRAINT: a pin
    // with an id could be blamed by planegcs's own diagnosis, and the hard pin
    // that sketchSolve is elsewhere warned off (solver.ts's anchors note —
    // fabricated dof and redundants) is harmless here precisely because this
    // pass's diagnostics are thrown away and only its geometry is kept.
    const flipped = [...tangentFlipped]
      .map((id) => centerPoint(id))
      .filter((p): p is string => p !== undefined);
    if (flipped.length) {
      const seeded = await pinnedSeed(model, flipped);
      if (seeded) {
        const alt = finish(await solveSketch(seeded));
        if (alt.ok && alt.conflicts.length === 0) pass = alt;
      }
    }
  }

  // Last resort for a pass that came back dirty: solve it AGAIN from a
  // shape-preserving start, and keep that only if it is clean.
  //
  // The failure it exists for: planegcs starts from the geometry as drawn and
  // walks downhill, and for the angular constraints (parallel / perpendicular /
  // collinear) and for a rectangle corner, the nearest way down is very often to
  // destroy an operand rather than to move it. A line that has shrunk to zero
  // length has no DIRECTION, so `parallel` against it is vacuously true; a
  // rectangle whose width has gone through zero satisfies a point constraint on
  // one corner by walking that corner past its neighbour. Both are local minima
  // of the residual, not disagreements between the constraints — the sketch had
  // a perfectly good answer a rotation or a translation away.
  //
  // So the SEED pass re-solves with every line's current length pinned, which
  // closes the degenerate route and leaves rotating and translating as the only
  // ways down. Its geometry is then the starting point for one ordinary free
  // solve, so what this returns is always a real solve of the user's own model
  // with nothing extra in it: the seed cannot invent a solution, it can only
  // start the search somewhere the collapse is not the nearest exit. Judged
  // through `finish`, so the geometry guard gets the last word here exactly as
  // it does on every other pass, and kept only if it comes back clean — a
  // genuinely contradictory constraint still conflicts and is still withdrawn.
  //
  // Measured over a 36-angle sweep of a free line against a 40x20 rectangle
  // (the app's own emission shapes and its own mover bias). Before: midpoint on
  // a rect corner failed at 32/36 angles for corner 0, 18/36 for corner 1, 32/36
  // for corner 3 and 0/36 for corner 2 — whichever corner already lies toward
  // the line is the one that survives, which is what made it look like the
  // corner INDEX mattered; symmetric on two corners 19-33/36 depending on the
  // pair; collinear on a rect edge 11/36 and on a plain free line 6/36 (so the
  // collapse was never a rectangle-only fault — the rectangle's four implicit
  // h/v pins only widen a local minimum two ordinary lines already have);
  // parallel 1/36 and perpendicular 1/36, at the angle needing an exact quarter
  // turn. After: 0/36 for every one of them. All of those reached the user as
  // "that constraint conflicts with the ones already on this sketch", with the
  // constraint thrown away and the geometry left untouched.
  //
  // Not for a DRAG frame: a refused drag is already a deliberate, explained
  // outcome ("that move would flatten or flip constrained geometry"), the frame
  // is on a 60 Hz path that must not pay two extra solves, and rescuing it would
  // hand the cursor a jump rather than the move it asked for.
  if (!drag && !(pass.ok && pass.conflicts.length === 0)) {
    const seeded = await reseed(model);
    if (seeded) {
      const alt = finish(await solveSketch(seeded));
      if (alt.ok && alt.conflicts.length === 0) pass = alt;
    }
  }
  return bias ? { ...pass, biasAnchors: anchors.length } : pass;
}

/** Every line in the model held at the length it currently has — the pins the
 *  seed pass is built from. Degenerate lines are skipped: a line that is already
 *  zero-length is not one this can protect, and pinning it AT zero would be
 *  asking for the collapse.
 *
 *  The `__len` ids cannot decode to a user constraint (constraintIndexOf), so a
 *  pin can never be blamed for anything — and it never reaches a returned pass
 *  anyway, since the seed pass's own diagnostics are thrown away. */
function lengthPins(model: SolveInput): SConstraint[] {
  const pos = new Map(model.points.map((p) => [p.id, p]));
  const out: SConstraint[] = [];
  model.lines.forEach((l, i) => {
    const a = pos.get(l.p1), b = pos.get(l.p2);
    if (!a || !b) return;
    const value = Math.hypot(b.x - a.x, b.y - a.y);
    if (value > LINE_COLLAPSE_EPS) out.push({ id: `__len${i}`, type: "distance", a: l.p1, b: l.p2, value });
  });
  return out;
}

/** Run the length-pinned seed pass and hand back the SAME model started at the
 *  geometry it found — points at their solved positions, circles and arcs at
 *  their solved radii, arc sweeps recomputed from the seeded points so
 *  `arc_rules` starts describing the seeded arc and not the old one.
 *
 *  The seed pass starts from a nudged copy of the sketch, and that nudge is
 *  load-bearing rather than superstition: a free line that has to rotate an
 *  EXACT quarter turn (Perpendicular to an axis-aligned rect edge, Collinear
 *  with a vertical one) starts at a saddle where the residual pushes equally
 *  both ways and planegcs does not move at all. Measured: without the nudge
 *  parallel and perpendicular still failed at exactly one sweep angle each and
 *  collinear at 90 degrees; with it, at none. A micron is far below the
 *  sidecar's own 1e-6 mm curve rounding, it is applied only to points the solve
 *  is free to move anyway, and it can only ever appear in an answer that would
 *  otherwise have been refused outright.
 *
 *  Null when there is nothing to hold (a sketch with no lines), and on a throw:
 *  the pins cost wasm heap the way the bias anchors do, and a lost retry is not
 *  worth losing the solver over (see the bias's own note above). */
async function reseed(model: SolveInput): Promise<SolveInput | null> {
  const pins = lengthPins(model);
  if (!pins.length) return null;
  const NUDGE = 1e-6; // mm
  let held: SolveResult;
  try {
    held = await solveSketch({
      ...model,
      points: model.points.map((p, i) => p.fixed
        ? p // a fixed point is somebody's anchor: nudging it would MOVE it
        : { ...p, x: p.x + NUDGE * ((i % 5) + 1), y: p.y - NUDGE * ((i % 3) + 1) }),
      constraints: [...model.constraints, ...pins],
    });
  } catch {
    return null;
  }
  return startedAt(model, held);
}

/** Hold `centres` — solver point ids — absolutely still for one pass, and hand
 *  the model back started at the geometry that pass found. The TANGENT-ROOT
 *  seed: a tangency the solve mirrored onto the far side of its line, or past
 *  the end of it, is a wrong ROOT rather than a contradiction, and pinning the
 *  round's own centre for one pass is what makes the root it was already on the
 *  nearest exit. Like reseed, it cannot invent a solution — its answer is only
 *  the starting point of one ordinary free solve of the user's own model.
 *
 *  Null when nothing is left to pin (every named centre is already fixed) and
 *  on a throw, for reseed's reason: a lost retry is not worth losing the solver. */
async function pinnedSeed(model: SolveInput, centres: string[]): Promise<SolveInput | null> {
  const pin = new Set(centres);
  if (!model.points.some((p) => pin.has(p.id) && !p.fixed)) return null;
  let held: SolveResult;
  try {
    held = await solveSketch({
      ...model,
      points: model.points.map((p) => (pin.has(p.id) ? { ...p, fixed: true } : p)),
    });
  } catch {
    return null;
  }
  return startedAt(model, held);
}

/** The SAME model, started at the geometry a seed pass found: points at their
 *  solved positions, circles and arcs at their solved radii, arc sweeps
 *  recomputed from the seeded points so `arc_rules` starts describing the
 *  seeded arc and not the old one. Anything the seed pass did not answer for
 *  keeps its original value. */
function startedAt(model: SolveInput, held: SolveResult): SolveInput {
  const at = (id: string) => held.points[id];
  return {
    ...model,
    points: model.points.map((p) => {
      const q = at(p.id);
      return q && Number.isFinite(q.x) && Number.isFinite(q.y) ? { ...p, x: q.x, y: q.y } : p;
    }),
    circles: model.circles.map((c) => {
      const r = held.circles[c.id];
      return r !== undefined && r > 0 ? { ...c, radius: r } : c;
    }),
    arcs: (model.arcs ?? []).map((a) => {
      const c = at(a.center), s = at(a.start), e = at(a.end);
      const r = held.arcs[a.id]?.radius;
      if (!c || !s || !e || r === undefined || !(r > 0)) return a;
      const startAngle = Math.atan2(s.y - c.y, s.x - c.x);
      const endAngle = Math.atan2(e.y - c.y, e.x - c.x);
      return { ...a, radius: r, startAngle, endAngle: startAngle + ccwDelta(startAngle, endAngle) };
    }),
  };
}

/** the round (circle/arc) entity ids a compiled constraint names — the blame
 *  list when one of them solves to a non-positive radius */
/** Every ENTITY a constraint names, by id, with a rectangle addressed through
 *  one of its edges (`R~2`) reported as the rectangle itself.
 *
 *  This replaces a roundRefs() that enumerated circle and arc operands only,
 *  which was the whole reason a collapsed LINE or RECTANGLE could be refused
 *  while nothing turned red: the guard knew the geometry was bad and could not
 *  name the constraint that asked for it, so `conflicts` came back empty and
 *  every caller keyed on it — the red chip, the drag's conflict branch — saw
 *  nothing to report.
 *
 *  Walks the constraint's own fields rather than switching on its type, so a
 *  constraint type added later is covered the day it lands. That is the same
 *  reason `noteRectScope` walks fields, and the same miss class that let
 *  `endpointPoint` and `dimPoint` drift apart about corners. `id` and `type`
 *  are skipped: they name the constraint, not an entity. */
function entityRefs(c: SConstraint): string[] {
  const out: string[] = [];
  const take = (v: unknown): void => {
    if (typeof v === "string") {
      const t = v.lastIndexOf("~");
      out.push(t < 0 ? v : v.slice(0, t));
    } else if (Array.isArray(v)) {
      v.forEach(take);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(take);
    }
  };
  for (const [k, v] of Object.entries(c)) {
    if (k === "id" || k === "type") continue;
    take(v);
  }
  return out;
}


/** Where a line-to-round tangency touches, for the geometry in `byId` — null
 *  when either operand is gone or the line has collapsed, where there is
 *  nothing to compare.
 *
 *  `inSpan` is the foot-of-perpendicular of the round's centre falling ON the
 *  SEGMENT rather than on its extension; `side` is which side of the line the
 *  centre sits on; `tangent` is whether the tangency actually holds right now
 *  (a solve is judged against the configuration it started in, and before the
 *  constraint is first satisfied there is no side to preserve).
 *
 *  Deliberately the segment `lineOperand` decodes, rectangle edges included:
 *  that is the line the USER drew and picked, and the whole bug is that
 *  planegcs only ever knew the infinite one. */
function tangentTouch(
  byId: Map<string, ResolvedEntity>,
  lineId: string,
  roundId: string,
): { inSpan: boolean; side: number; tangent: boolean } | null {
  const seg = lineOperand(byId, lineId);
  const e = byId.get(roundId);
  const cc = e ? asRound(e) : null;
  if (!seg || !cc) return null;
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > LINE_COLLAPSE_EPS)) return null; // no direction, no tangency to judge
  const len = Math.sqrt(len2);
  const t = ((cc.x - seg.x1) * dx + (cc.y - seg.y1) * dy) / len2;
  const cross = (cc.x - seg.x1) * dy - (cc.y - seg.y1) * dx;
  const slack = TANGENT_TOL / len; // in parameter units: a touch AT a corner is in span
  return {
    inSpan: t >= -slack && t <= 1 + slack,
    side: Math.sign(cross),
    tangent: Math.abs(Math.abs(cross) / len - cc.r) <= TANGENT_TOL,
  };
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
