// Walking a projection refresh in steps, so a closed sketch FOLLOWS its moved
// projected edges instead of jumping to a mirror image of what was drawn.
//
// Field report 6124e4a7: a 40x40 rectangle held 5 mm inside a projected 50x50
// square by four point-to-line distances. The square was resized to 40x40 and
// the rectangle came back the same 40x40, translated, two sides 5 mm OUTSIDE the
// square, with every dimension reporting "satisfied". planegcs's p2l_distance is
// UNSIGNED, and the store re-solved once from the old coordinates against the
// new curves: when a reference moves further than the dimension, the far side
// is the nearer solution and the solver takes it. Field report 66d7eb71 has the
// same jump on this side (a hole dimensioned 10 mm from a plate edge landing
// outside it), but this is only its front-end half: on the reporter's document
// the sidecar also rebinds that projected edge to the hole's circle, the
// distance then names a circle and drops out of the solve, and nothing here can
// put it back.
//
// The cure is a continuation: move each projected LINE a fraction of the way,
// solve, feed the coordinates forward, repeat. Each step is small against the
// smallest unsigned distance on the moved geometry, so the near branch is the
// right one every time. Lines only: a circle or arc update, a curve changing
// kind, and a stale flag land whole on the last step, exactly as before. The
// walk is not rigid (a turning edge shrinks part-way), so the store falls back
// to the single solve when a step cannot be solved.
//
// Pure: the store owns the solves and decides what lands.

import type { Feature, Params, ProjectedCurve, ProjectionUpdate, SketchConstraint } from "../types";
import { applyProjectionUpdate, isDriven } from "../types";
import { resolveRealEntities } from "../sketch/resolve";
import { lineOperand, refPoint } from "../sketch/entityDims";

type SketchFeature = Extract<Feature, { type: "sketch" }>;
type LineCurve = Extract<ProjectedCurve, { kind: "line" }>;

/** The most solves one refresh may cost. Measured: the two field documents
 *  need 2 to 5 steps; 32 covers a reference moving 16 times its dimension. */
const MAX_STEPS = 32;

/** An UNSIGNED distance dimension's value and the entities it ties together
 *  (a rect edge operand names its rectangle), or null for any other
 *  constraint. These are the dimensions planegcs can satisfy with the geometry
 *  on the far side. */
function unsignedDistance(c: SketchConstraint): { value: number; ops: string[] } | null {
  const base = (id: string) => id.split("~")[0] ?? id;
  switch (c.type) {
    case "p2lDistance": return { value: c.value, ops: [c.e, base(c.line)] };
    case "p2pDistance": return { value: c.value, ops: [c.e1, c.e2] };
    case "c2lDistance": return { value: c.value, ops: [c.circle, base(c.line)] };
    case "p2cDistance": return { value: c.value, ops: [c.e, c.circle] };
    case "c2cDistance": return { value: c.value, ops: [c.c1, c.c2] };
    default: return null;
  }
}

/** `b`'s ends in the order that pairs each with the nearer end of `a`. The
 *  sidecar may hand a refreshed line back end for end, and walking that would
 *  collapse the line through its midpoint halfway along. */
function alignLine(a: LineCurve, b: LineCurve): LineCurve {
  const direct = Math.hypot(a.x1 - b.x1, a.y1 - b.y1) + Math.hypot(a.x2 - b.x2, a.y2 - b.y2);
  const swapped = Math.hypot(a.x1 - b.x2, a.y1 - b.y2) + Math.hypot(a.x2 - b.x1, a.y2 - b.y1);
  return swapped < direct ? { kind: "line", x1: b.x2, y1: b.y2, x2: b.x1, y2: b.y1 } : b;
}

function oldLines(pre: SketchFeature): Map<string, LineCurve> {
  const out = new Map<string, LineCurve>();
  for (const e of pre.entities) {
    if (e.type === "projected" && e.id !== undefined && e.curve.kind === "line") out.set(e.id, e.curve);
  }
  return out;
}

/** How many solves the refresh of `pre` takes: enough that no projected line
 *  end moves more than half the smallest unsigned distance dimension on the
 *  moved geometry per step. 1 (today's single solve) when no such dimension
 *  touches it, because then there is no far side to land on. */
export function refreshSteps(pre: SketchFeature, updates: Map<string, ProjectionUpdate>): number {
  let dim = Infinity;
  for (const c of pre.constraints ?? []) {
    const d = isDriven(c) ? null : unsignedDistance(c);
    const v = Math.abs(d?.value ?? 0);
    if (d?.ops.some((id) => updates.has(id)) && v > 1e-9) dim = Math.min(dim, v);
  }
  if (!Number.isFinite(dim)) return 1;
  const old = oldLines(pre);
  let travel = 0;
  for (const [id, u] of updates) {
    const a = old.get(id);
    if (!a || u.stale || u.curve.kind !== "line") continue;
    const b = alignLine(a, u.curve);
    travel = Math.max(travel, Math.hypot(b.x1 - a.x1, b.y1 - a.y1), Math.hypot(b.x2 - a.x2, b.y2 - a.y2));
  }
  return Math.min(MAX_STEPS, Math.max(1, Math.ceil(travel / (0.5 * dim))));
}

/** `cur` with every refreshed projected curve set to where it is at fraction
 *  `t` of the refresh: a line part-way from its `pre` position to its new one,
 *  anything else still at its `pre` curve. At t = 1 every update lands whole,
 *  through the same applyProjectionUpdate the single-shot path used. */
export function refreshStep(
  cur: SketchFeature,
  pre: SketchFeature,
  updates: Map<string, ProjectionUpdate>,
  t: number,
): SketchFeature {
  const old = oldLines(pre);
  const entities = cur.entities.map((e) => {
    if (e.type !== "projected" || e.id === undefined) return e;
    const u = updates.get(e.id);
    if (!u) return e;
    if (t >= 1) return applyProjectionUpdate(e, u);
    const a = old.get(e.id);
    if (!a || u.stale || u.curve.kind !== "line") return e;
    const b = alignLine(a, u.curve);
    const at = (p: number, q: number) => p + (q - p) * t;
    return { ...e, curve: { kind: "line" as const, x1: at(a.x1, b.x1), y1: at(a.y1, b.y1), x2: at(a.x2, b.x2), y2: at(a.y2, b.y2) } };
  });
  return { ...cur, entities };
}

/** For each constraint: the side of its line a driving p2lDistance's point sits
 *  on (+1/-1) and the line's direction, or null where there is no side to keep
 *  (another constraint, a point ON its line, an operand that is gone). */
function p2lSides(f: SketchFeature, params: Params): ({ side: number; dx: number; dy: number } | null)[] {
  const byId = new Map(resolveRealEntities(f, params).map((e) => [e.id, e]));
  return (f.constraints ?? []).map((c) => {
    if (c.type !== "p2lDistance" || isDriven(c)) return null;
    const e = byId.get(c.e);
    const p = e ? refPoint(e, c.p) : null;
    const s = lineOperand(byId, c.line);
    if (!p || !s) return null;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const cross = ((p.x - s.x1) * dy - (p.y - s.y1) * dx) / len;
    return Math.abs(cross) < 1e-6 ? null : { side: Math.sign(cross), dx, dy };
  });
}

/** True when a driving p2lDistance whose point sat clearly on one side of its
 *  line in `before` sits on the other side (or on the line) in `after`: the
 *  number still reads "satisfied" and the geometry is the mirror image. Judged
 *  against the PRE-refresh sketch, because by the time the solver sees the new
 *  curves the old coordinates can already be on the far side of them. A line
 *  that came back end for end is judged in its old direction, so a reversed
 *  refresh is not mistaken for a flip. */
export function p2lSideFlipped(before: SketchFeature, after: SketchFeature, params: Params): boolean {
  const a = p2lSides(before, params);
  const b = p2lSides(after, params);
  return a.some((s, i) => {
    if (!s) return false;
    const n = b[i];
    if (!n) return true;
    const sameWay = s.dx * n.dx + s.dy * n.dy >= 0;
    return (sameWay ? n.side : -n.side) !== s.side;
  });
}
