// Sketch modify operations on resolved entities: pick, trim, fillet-corner.
// These mutate the entity list (returning a new one); the sketcher rebuilds.

import { t } from "../i18n";
import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { PlaceOffset, SketchConstraint } from "../types";
import { TRIMMED_AWAY, dimPlaceOf, isDriven } from "../types";
import { entitySegments, polygonPoints, rectCorners } from "./region";
import { POLYGON_CENTRE, RECT_CENTRE, asRound, curveKind, dimRefPoints, lineOperand, lineOperandAt, namedEntityIds, refPoint } from "./entityDims";
import { isOriginGeometry } from "./origin";
import { newEntityId } from "./id";
import { arcCenterRadius } from "./arc";
import { translated } from "./pattern";
import { splineEndIndices, splineFlags } from "./spline";
import { coincKey } from "./sketchSolve";
import {
  circleLineIntersect,
  circleCircleIntersect,
  curveCrossings,
  lineIntersect,
  paramOnSeg,
  distToSeg,
  touchTol,
  type Carrier2,
  type Curve2,
} from "./geom2d";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

/** The one guard toast for projected (linked, fixed) reference geometry — every
 *  modify/transform/constraint seam that refuses to touch it shows this. */
export const PROJECTED_FIXED_MSG = t("sketch.guard.projectedFixed");

/** The one guard toast for a point a user `fix` constraint pins. Lives here, not
 *  inlined at its call sites: the solver-drag path and the body-drag/transform
 *  paths refuse the same thing and must say the same words. */
export const FIXED_POINT_MSG = t("sketch.guard.pointFixed");

/** The entities a `fix` constraint pins. A `fix` names an entity plus a point
 *  index, and every point it can resolve to belongs to that entity, so matching
 *  on the entity id is exact — no point math needed. */
export const fixPinnedIds = (cons: readonly SketchConstraint[]): Set<string> =>
  new Set(cons.flatMap((c) => (c.type === "fix" ? [c.e] : [])));

/** WHERE each `fix` pins, as coincKey buckets — the same bucket the solver
 *  merges positions into, so "is this endpoint the pinned one?" is asked in the
 *  solver's own terms rather than with a private tolerance. */
export function fixPinnedKeys(
  ents: readonly ResolvedEntity[],
  cons: readonly SketchConstraint[],
): Set<string> {
  const out = new Set<string>();
  for (const c of cons) {
    if (c.type !== "fix") continue;
    const e = ents.find((x) => x.id === c.e);
    if (!e) continue;
    // circles and sketch points expose their single point at ANY index, which is
    // how sketchSolve's dimPoint resolves them; everything else is by index.
    const pos = e.type === "circle" || e.type === "point"
      ? v(e.x, e.y)
      : dimRefPoints(e).find((r) => r.p === c.p)?.pos;
    if (pos) out.add(coincKey(pos.x, pos.y));
  }
  return out;
}

/** The moved entity's attachment points: the positions where neighbours may
 *  coincide, and — during a drag — the positions to hold still while the solver
 *  re-satisfies everything around them. `cons` is the sketch's constraints. */
export function attachmentPoints(e: ResolvedEntity, cons: readonly SketchConstraint[]): THREE.Vector2[] {
  if (e.type === "line" || e.type === "arc") return [v(e.x1, e.y1), v(e.x2, e.y2)];
  if (e.type === "rectangle") return rectCorners(e.x, e.y, e.width, e.height).map((q) => q.clone());
  // A polygon's corners and a slot's centres, once a constraint names the
  // shape: solver points then, so a body drag holds them where the cursor put
  // them, or the frame's solve pulls the shape back toward whatever it is tied
  // to. Before that the solver has no point there, so nothing merges with
  // one and nothing that only sits on it may ride along (an old sketch's
  // snapped line end stayed put in 0.1.232), and a drag of the shape needs no
  // solve at all.
  if ((e.type === "polygon" || e.type === "slot") && !namedEntityIds(cons).has(e.id)) return [];
  if (e.type === "polygon") return polygonPoints(e.x, e.y, e.radius, e.sides, (e.angle * Math.PI) / 180);
  if (e.type === "slot") return [v(e.x1, e.y1), v(e.x2, e.y2)];
  if (e.type === "spline") return splineEndIndices(e).map((k) => v(e.points[k]!.x, e.points[k]!.y));
  if (e.type === "circle" || e.type === "point") return [v(e.x, e.y)];
  return [];
}

/** What a body drag moves: the one grabbed entity, or a whole selection. */
const dragIdxs = (idx: number | readonly number[]): readonly number[] =>
  typeof idx === "number" ? [idx] : idx;

/** Would a body drag of ents[idx] (or of every entity in a selection) move a
 *  point a `fix` pins?
 *
 *  Two ways it can, and the second is why this is not just an id test: the
 *  dragged entity itself is pinned, or it shares a corner with a neighbour whose
 *  endpoint is pinned and which the drag would therefore carry along. Dropping
 *  only that one neighbour mutator would silently TEAR the joint instead —
 *  merged-by-position points have nothing pulling them back together — so the
 *  whole gesture is refused. For a selection, one pinned member refuses it all,
 *  for the same reason. */
export function bodyDragBlocked(
  ents: readonly ResolvedEntity[],
  idx: number | readonly number[],
  cons: readonly SketchConstraint[],
): boolean {
  const moved: ResolvedEntity[] = [];
  for (const i of dragIdxs(idx)) {
    const e = ents[i];
    if (!e) return true;
    moved.push(e);
  }
  if (moved.length === 0) return true;
  const pinnedIds = fixPinnedIds(cons);
  if (pinnedIds.size === 0) return false;
  if (moved.some((e) => pinnedIds.has(e.id))) return true;
  const pinnedAt = fixPinnedKeys(ents, cons);
  if (pinnedAt.size === 0) return false;
  return moved.some((e) => attachmentPoints(e, cons).some((q) => pinnedAt.has(coincKey(q.x, q.y))));
}

/** ONE frame of the select tool's whole-entity body drag: the grabbed entity
 *  (or every entity of a dragged selection, report 3f16187e) translated by
 *  (dx,dy), plus every OTHER entity's endpoint that coincides with one of their
 *  attachment points carried along with them. Returns null when the gesture is
 *  refused (see bodyDragBlocked).
 *
 *  Neighbour attachment is decided with `coincKey`, the same position merge the
 *  solver does, so "rides along during the drag" and "one merged solver point in
 *  the solve" agree exactly. Rectangles and circles are never stretched (their
 *  shape cannot follow a single corner); an arc's through-point is deliberately
 *  left alone, as the per-frame solve is what re-forms the arc.
 *
 *  The ORIGIN is never carried, nor moved (report 69d5231f). It is a `point`
 *  sitting on whatever was drawn from it, so the carry rule below picked it up
 *  like any neighbour, and the solver pins the origin at its INPUT position: once
 *  a frame had moved it, the "fixed" origin was fixed at the new spot, a
 *  rectangle made coincident with it slid away rigidly with the coincident still
 *  satisfied, and the origin stayed off 0,0 until the sketch was reopened (which
 *  is also why it could no longer be picked there). Left where it is, the
 *  coincident holds the corner against the drag's soft pins: a fully dimensioned
 *  rectangle stays put and a free one stretches. A corner that only SITS on the
 *  origin, with no coincident, has nothing holding it and moves off with the
 *  drag; whether that should stretch or be refused instead is still open.
 *
 *  Pure, and returning a fresh list rather than mutating in place, because the
 *  drag now hands the result to the solver every frame and the solver hands back
 *  new objects — a set of closures captured once at press time would be writing
 *  into entities the document no longer holds. */
export function bodyDragFrame(
  ents: readonly ResolvedEntity[],
  idx: number | readonly number[],
  dx: number,
  dy: number,
  cons: readonly SketchConstraint[],
): ResolvedEntity[] | null {
  const moved = new Set(dragIdxs(idx));
  if (bodyDragBlocked(ents, [...moved], cons)) return null;
  const keys = new Set(
    [...moved].flatMap((i) => attachmentPoints(ents[i]!, cons).map((q) => coincKey(q.x, q.y))),
  );
  const near = (x: number, y: number) => keys.has(coincKey(x, y));
  return ents.map((e, i) => {
    if (isOriginGeometry(e.id)) return e;
    if (moved.has(i)) return translated(e, dx, dy, e.id);
    if (e.type === "line" || e.type === "arc") {
      const s = near(e.x1, e.y1), t = near(e.x2, e.y2);
      if (!s && !t) return e;
      return {
        ...e,
        ...(s ? { x1: e.x1 + dx, y1: e.y1 + dy } : {}),
        ...(t ? { x2: e.x2 + dx, y2: e.y2 + dy } : {}),
      };
    }
    if (e.type === "spline") {
      const hit = splineEndIndices(e).filter((k) => { const q = e.points[k]; return !!q && near(q.x, q.y); });
      if (!hit.length) return e;
      return { ...e, points: e.points.map((q, k) => (hit.includes(k) ? { x: q.x + dx, y: q.y + dy } : q)) };
    }
    if (e.type === "point" && near(e.x, e.y)) return { ...e, x: e.x + dx, y: e.y + dy };
    return e;
  });
}

/** The nearest solver-controlled point (line/arc endpoint, circle or arc centre,
 *  rectangle corner, spline fit point) within `tol` of p — the select tool's
 *  drag handles. Polygons and slots are intentionally excluded: they expand to
 *  solver points only once a constraint names them (sketchSolve), so a handle
 *  on one would drag in one sketch and be refused in the next. A body drag
 *  moves them whole.
 *
 *  The ORIGIN offers no handles. It is pinned, so a drag started on it is
 *  refused and nothing happens — but starting one still consumes the click, so
 *  the origin could not be SELECTED either ("it highlights but I can't select
 *  it": the click was spent on a drag that could never move). */
export function pickDragPoint(
  ents: readonly ResolvedEntity[],
  p: { x: number; y: number },
  tol: number,
): { x: number; y: number; idx: number } | null {
  let best: { x: number; y: number; idx: number } | null = null;
  let bestD = tol * tol;
  let cur = -1;
  const d2 = (x: number, y: number) => (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
  // ties go to the LAST candidate, which is the historical behaviour
  const consider = (x: number, y: number) => {
    const d = d2(x, y);
    if (d <= bestD) { bestD = d; best = { x, y, idx: cur }; }
  };
  // ...except an arc's CENTRE, which must lose them: a small fillet's centre sits
  // inside pick tolerance of its own tangent points, and stealing that click
  // would make the endpoints of every fillet arc undraggable.
  const considerStrict = (x: number, y: number) => {
    const d = d2(x, y);
    if (d < bestD) { bestD = d; best = { x, y, idx: cur }; }
  };
  ents.forEach((e, i) => {
    cur = i;
    if (isOriginGeometry(e.id)) return;
    if (e.type === "line") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
    else if (e.type === "circle") consider(e.x, e.y);
    else if (e.type === "arc") {
      consider(e.x1, e.y1);
      consider(e.x2, e.y2);
      // GH report 41dc3246: "I can't grab the arc's centre". The solver side was
      // always there (the centre is a real, non-mergeable solver point and the
      // drag pin accepts it) — only the handle was missing. dimRefPoints is THE
      // enumeration of an entity's reference points, arc centre included at p:2.
      const cc = dimRefPoints(e).find((r) => r.p === 2);
      if (cc) considerStrict(cc.pos.x, cc.pos.y);
    }
    else if (e.type === "spline") for (const q of e.points) consider(q.x, q.y);
    else if (e.type === "point") consider(e.x, e.y);
    else if (e.type === "rectangle") {
      const hw = e.width / 2, hh = e.height / 2;
      consider(e.x - hw, e.y - hh); consider(e.x + hw, e.y - hh);
      consider(e.x + hw, e.y + hh); consider(e.x - hw, e.y + hh);
    }
  });
  return best;
}

/** Break Link (Fusion): convert the given projected entities to native
 *  geometry KEEPING their ids, so attached constraints/dims stay valid — and
 *  since they go fixed→free, the sketch can never become over-constrained by
 *  the conversion. The source/stale link fields are dropped; construction
 *  carries over. A closed poly (first sample == last, the projEndSamples
 *  closure rule) becomes a C0-closed spline: the duplicate closing point is
 *  kept, so endpoint index 0 — the one addressable point a closed poly
 *  exposed — still resolves (index 1 lands on the coincident closing point,
 *  which the solver merges back into it). Non-projected / unlisted entities
 *  pass through untouched. */
export function breakLink(ents: ResolvedEntity[], ids: ReadonlySet<string>): ResolvedEntity[] {
  return ents.map((e): ResolvedEntity => {
    if (e.type !== "projected" || !ids.has(e.id)) return e;
    const cv = e.curve;
    const base = { id: e.id, ...constr(e) };
    switch (cv.kind) {
      case "line":
        return { type: "line", ...base, x1: cv.x1, y1: cv.y1, x2: cv.x2, y2: cv.y2 };
      case "arc":
        return { type: "arc", ...base, x1: cv.x1, y1: cv.y1, x2: cv.x2, y2: cv.y2, mx: cv.mx, my: cv.my };
      case "circle":
        return { type: "circle", ...base, x: cv.x, y: cv.y, radius: cv.r };
      case "poly":
        // a spline made now builds as it is drawn (types.ts asDrawn)
        return { type: "spline", ...base, points: cv.pts.map(([x, y]) => ({ x, y })), asDrawn: true };
    }
  });
}

const TAU = Math.PI * 2;
/** CCW angular distance from `from` to `to`, always in [0, TAU) */
const ccwDelta = (from: number, to: number) => (((to - from) % TAU) + TAU) % TAU;

/** Build an arc entity from a center, radius and a CCW angular span (start + delta>0).
 *  `id` defaults to a fresh one; trim's planner passes its own so the hover,
 *  which plans on every pointer move, never burns ids. */
function arcFromSpan(
  C: THREE.Vector2,
  R: number,
  aStart: number,
  delta: number,
  src: { construction?: boolean },
  id = newEntityId(),
): ResolvedEntity {
  const aEnd = aStart + delta;
  const aMid = aStart + delta / 2;
  return {
    type: "arc",
    id,
    x1: C.x + Math.cos(aStart) * R, y1: C.y + Math.sin(aStart) * R,
    x2: C.x + Math.cos(aEnd) * R, y2: C.y + Math.sin(aEnd) * R,
    mx: C.x + Math.cos(aMid) * R, my: C.y + Math.sin(aMid) * R,
    ...constr(src),
  };
}

/** An arc's center, radius, CCW start angle and CCW sweep (delta>0), from its 3
 *  stored points — oriented so the through-point lies inside the sweep (matches
 *  the reconstruction in sketchSolve). Null for a degenerate/collinear arc. */
function arcGeom(e: { x1: number; y1: number; x2: number; y2: number; mx: number; my: number }):
  { C: THREE.Vector2; R: number; aStart: number; delta: number } | null {
  const cr = arcCenterRadius(e);
  if (!cr) return null;
  const C = cr.c, R = cr.r;
  const aS = Math.atan2(e.y1 - C.y, e.x1 - C.x);
  const aE = Math.atan2(e.y2 - C.y, e.x2 - C.x);
  const aT = Math.atan2(e.my - C.y, e.mx - C.x);
  const throughFwd = ccwDelta(aS, aT) <= ccwDelta(aS, aE);
  return throughFwd
    ? { C, R, aStart: aS, delta: ccwDelta(aS, aE) }
    : { C, R, aStart: aE, delta: ccwDelta(aE, aS) };
}

/** `o` as the crossing search sees it: exact for a line, circle or arc, native
 *  or projected, and the shared tessellation for everything else (a spline
 *  has no closed form here; rectangle and polygon edges are straight anyway). */
function entityCurves(o: ResolvedEntity): Curve2[] {
  const seg = (x1: number, y1: number, x2: number, y2: number): Curve2 =>
    ({ kind: "seg", a: v(x1, y1), b: v(x2, y2) });
  const round = (x: number, y: number, r: number): Curve2 =>
    ({ kind: "round", c: v(x, y), r, a0: 0, sweep: TAU });
  const arc = (a: { x1: number; y1: number; x2: number; y2: number; mx: number; my: number }): Curve2[] | null => {
    const g = arcGeom(a);
    return g ? [{ kind: "round", c: g.C, r: g.R, a0: g.aStart, sweep: g.delta }] : null;
  };
  const cv = o.type === "projected" ? o.curve : null;
  if (o.type === "line") return [seg(o.x1, o.y1, o.x2, o.y2)];
  if (cv?.kind === "line") return [seg(cv.x1, cv.y1, cv.x2, cv.y2)];
  if (o.type === "circle") return [round(o.x, o.y, o.radius)];
  if (cv?.kind === "circle") return [round(cv.x, cv.y, cv.r)];
  // a degenerate (collinear) arc keeps its polyline, as before
  const exact = o.type === "arc" ? arc(o) : cv?.kind === "arc" ? arc(cv) : null;
  return exact ?? entitySegments(o).map(([a, b]) => ({ kind: "seg", a, b }));
}

/** every point where another entity crosses or touches the carrier `on` */
function crossingsOn(ents: ResolvedEntity[], index: number, on: Carrier2): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  ents.forEach((o, i) => {
    // The origin axes are REFERENCE, not a modify boundary. They exist in every
    // sketch and span it, so counting them as crossings would silently change
    // what trim/extend do to any line that happens to cross y=0 or x=0 — in
    // every document ever made. Snap to them, constrain to them, do not cut on
    // them.
    if (i === index || isOriginGeometry(o.id)) return;
    for (const c of entityCurves(o)) out.push(...curveCrossings(on, c));
  });
  return out;
}

/** angles (atan2, unbounded) at which other entities cross the circle (C,R) */
function circleCrossAngles(ents: ResolvedEntity[], index: number, C: THREE.Vector2, R: number): number[] {
  return crossingsOn(ents, index, { kind: "circle", c: C, r: R }).map((h) => Math.atan2(h.y - C.y, h.x - C.x));
}

/** spread that copies a construction flag only when set — avoids emitting an
 *  explicit `construction: undefined`, which exactOptionalPropertyTypes rejects. */
const constr = (e: { construction?: boolean }) =>
  e.construction === undefined ? {} : { construction: e.construction };

/** index of the entity whose curve is nearest p within tol, else -1 */
export function pickEntity(
  ents: ResolvedEntity[],
  p: THREE.Vector2,
  tol: number,
): number {
  // YOUR geometry always beats REFERENCE geometry. The origin axes run through
  // 0,0 and stretch across the sketch, so anything you draw along an axis — the
  // bottom edge of a rectangle on y=0, a line from the origin — sits exactly on
  // top of one. Nearest-wins alone would then be decided by list order, and the
  // origin is inserted first, so the axis would win every tie and clicking your
  // own line would select the axis instead. Two passes rather than a distance
  // fudge: a penalty would still lose to the axis for anything a hair further
  // from the cursor, which is the same bug with extra arithmetic.
  const nearestIn = (want: boolean): number => {
    let best = -1;
    let bestD = tol;
    ents.forEach((e, i) => {
      if (isOriginGeometry(e.id) !== want) return;
      const d = distToEntity(e, p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  const own = nearestIn(false);
  return own >= 0 ? own : nearestIn(true);
}

/** Whether a Select-tool click at `p` takes the point at `pos` (an end, a
 *  corner or a centre, which refPointNear picked within pick tolerance) rather
 *  than `curve`, the curve under the cursor (pickEntity's pick, undefined over
 *  none). Every point within tolerance taking the click covered the whole of a
 *  small circle or a short line: its rim took the centre and its middle an
 *  end, so it could no longer be selected on its own (GH #17).
 *
 *  A point OFF the curve (a centre) takes the click only when the cursor is
 *  nearer to it than to the curve. A point ON it (one of its ends or corners,
 *  or another curve's end touching it) takes it within a third of the way to
 *  the curve's next point, so the middle third of a short line is the line. */
export function pointBeatsCurve(curve: ResolvedEntity | undefined, pos: THREE.Vector2, p: THREE.Vector2, tol: number): boolean {
  if (!curve) return true;
  const on = tol * 0.1; // this close counts as on the curve, which is measured on its tessellation
  const dPt = pos.distanceTo(p);
  if (distToEntity(curve, pos) > on) return dPt < distToEntity(curve, p);
  let span = Infinity;
  for (const r of dimRefPoints(curve)) {
    const d = r.pos.distanceTo(pos);
    if (d > on && distToEntity(curve, r.pos) <= on) span = Math.min(span, d);
  }
  return dPt < span / 3;
}

function distToEntity(e: ResolvedEntity, p: THREE.Vector2): number {
  if (e.type === "circle") return Math.abs(v(e.x, e.y).distanceTo(p) - e.radius);
  // line/rect/arc/spline: nearest of the shared tessellated segments
  let d = Infinity;
  for (const [a, b] of entitySegments(e)) d = Math.min(d, distToSeg(a, b, p));
  return d;
}

/** One piece a trim leaves: its geometry, and the OPERAND it was cut from —
 *  the trimmed entity's own id, or `<rectId>~<k>` for a rectangle edge.
 *  `whole` marks a rectangle edge the trim did not touch, which keeps its
 *  full extent. `lead` marks the piece that takes over a dimension on the whole
 *  curve, which must land on one piece only (trimWithConstraints sets it). */
type TrimPiece = { from: string; geom: ResolvedEntity; whole: boolean; lead?: boolean };

/** What a trim at `click` does to ents[index]: the piece it removes, and the
 *  pieces it keeps, in order along the curve. Decided ONCE for both the click
 *  (trimWithConstraints) and the hover (trimSpan), so the red piece under the
 *  cursor is exactly what the click takes away. Geometry only: every piece
 *  carries a placeholder id, because the hover plans on every pointer move and
 *  minting ids there would burn one per frame. */
type TrimPlan = { removed: ResolvedEntity; kept: TrimPiece[] };

/** The span [lo,hi] of `sorted` (crossing parameters, 0 and 1 included) that
 *  holds the click parameter `tc`. */
function spanAround(sorted: number[], tc: number): [number, number] {
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    if (tc >= a && tc <= b) return [a, b];
  }
  return [0, 1];
}

function planTrim(ents: ResolvedEntity[], index: number, click: THREE.Vector2): TrimPlan | null {
  const e = ents[index];
  if (!e) return null;
  const whole: TrimPlan = { removed: e, kept: [] }; // a curve with no usable crossing goes whole
  const piece = (geom: ResolvedEntity): TrimPiece => ({ from: e.id, geom, whole: false });
  /** Trim [lo,hi] out of a curve parametrised over [0,1]. An outer piece
   *  shorter than 1e-3 is a sliver and is not kept; the removed piece is
   *  whatever the kept ones leave, so a sliver goes WITH it on screen too. */
  const cut = (lo: number, hi: number, sub: (ta: number, tb: number) => ResolvedEntity): TrimPlan => {
    const left = lo >= 1e-3, right = 1 - hi >= 1e-3;
    const kept = [...(left ? [piece(sub(0, lo))] : []), ...(right ? [piece(sub(hi, 1))] : [])];
    return kept.length ? { removed: sub(left ? lo : 0, right ? hi : 1), kept } : whole;
  };

  if (e.type === "circle") {
    const C = v(e.x, e.y), R = e.radius;
    const norm = (a: number) => ((a % TAU) + TAU) % TAU;
    const angs = [...new Set(circleCrossAngles(ents, index, C, R).map(norm))].sort((a, b) => a - b);
    if (angs.length < 2) return whole; // nothing to trim against
    const tc = norm(Math.atan2(click.y - C.y, click.x - C.x));
    // the CCW span [lo,hi] between adjacent crossings that contains the click
    let lo = angs[angs.length - 1]!, hi = angs[0]!;
    for (let k = 0; k < angs.length; k++) {
      const a = angs[k]!, b = angs[(k + 1) % angs.length]!;
      if (ccwDelta(a, tc) <= ccwDelta(a, b)) { lo = a; hi = b; break; }
    }
    const keep = ccwDelta(hi, lo); // complement of the removed span
    if (keep < 1e-3) return whole;
    return {
      removed: arcFromSpan(C, R, lo, ccwDelta(lo, hi), e, e.id),
      kept: [piece(arcFromSpan(C, R, hi, keep, e, e.id))],
    };
  }

  if (e.type === "arc") {
    const g = arcGeom(e);
    if (!g) return whole;
    const { C, R, aStart, delta } = g;
    const params = new Set<number>([0, 1]);
    for (const ang of circleCrossAngles(ents, index, C, R)) {
      const t = ccwDelta(aStart, ang) / delta;
      if (t > 1e-4 && t < 1 - 1e-4) params.add(t);
    }
    const sorted = [...params].sort((a, b) => a - b);
    if (sorted.length <= 2) return whole;
    const tc = Math.max(0, Math.min(1, ccwDelta(aStart, Math.atan2(click.y - C.y, click.x - C.x)) / delta));
    const [lo, hi] = spanAround(sorted, tc);
    return cut(lo, hi, (ta, tb) => arcFromSpan(C, R, aStart + ta * delta, (tb - ta) * delta, e, e.id));
  }

  // A RECTANGLE is one entity, so trimming it used to delete all four edges —
  // "I clicked the bottom line and the whole rectangle disappeared". It is four
  // lines to the user, so explode it into four and trim the one that was
  // clicked. The `defer ... revisit when a user hit it` note that used to live
  // here has been redeemed; polygon/slot are genuinely rigid parametric shapes
  // (a trimmed hexagon is not a hexagon) and a spline has no edges, so those
  // keep the delete-whole behaviour until someone hits THAT.
  //
  // Exploding drops the rectangle's id, and with it the implicit `~h0`/`~v0`
  // constraints the solver derives from the entity — they are generated at
  // compile time, so nothing dangles. The edges are planned under their operand
  // ids (`<rectId>~<k>`), which is how trimWithConstraints carries a user
  // constraint on an edge or a corner over to the line that edge became.
  if (e.type === "rectangle") {
    const corners = rectCorners(e.x, e.y, e.width, e.height);
    const edges: ResolvedEntity[] = corners.map((a, k) => {
      const b = corners[(k + 1) % corners.length]!;
      return { type: "line", id: `${e.id}~${k}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...constr(e) };
    });
    // which edge was clicked — measured on the exploded lines, not guessed
    let hit = 0;
    let hitD = Infinity;
    edges.forEach((ln, k) => {
      const d = distToEntity(ln, click);
      if (d < hitD) { hitD = d; hit = k; }
    });
    const exploded = ents.flatMap((o, i) => (i === index ? edges : [o]));
    const sub = planTrim(exploded, index + hit, click);
    if (!sub) return whole;
    return {
      removed: sub.removed,
      kept: edges.flatMap((ed, k) => (k === hit ? sub.kept : [{ from: ed.id, geom: ed, whole: true }])),
    };
  }
  if (e.type !== "line") return whole; // spline + rigid polygon/slot: deleted whole

  const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
  const params = new Set<number>([0, 1]);
  for (const h of crossingsOn(ents, index, { kind: "line", a: p1, b: p2 })) {
    const t = paramOnSeg(p1, p2, h);
    if (t > 1e-4 && t < 1 - 1e-4) params.add(t);
  }
  const sorted = [...params].sort((a, b) => a - b);
  if (sorted.length <= 2) return whole; // no crossing → delete

  const tc = Math.max(0, Math.min(1, paramOnSeg(p1, p2, click)));
  // The caller passes the RAW cursor, never a snapped point. That matters here
  // and not anywhere else in this file: a crossing belongs to the span on either
  // side of it, so a click landing exactly on one picks whichever comes first —
  // deleting the piece NEXT TO the one under the cursor. Snapping aimed clicks
  // straight at the crossings, which is precisely the input this cannot resolve.
  // See sketchMode's trim carve-out.
  const [lo, hi] = spanAround(sorted, tc);
  // the ends that survive stay EXACTLY where they were, so a neighbour that
  // shares one stays merged with it in the solver's position buckets
  const at = (t: number) => (t === 0 ? p1 : t === 1 ? p2 : v(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t));
  return cut(lo, hi, (ta, tb) => {
    const a = at(ta), b = at(tb);
    return { type: "line", id: e.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...constr(e) };
  });
}

/** The piece a trim at `click` would remove from ents[index] — what the Trim
 *  hover draws in red: a line segment, a sub-arc, the span of a circle, the span
 *  of the clicked rectangle edge, or the whole entity when nothing crosses it
 *  (and always for a spline, polygon or slot). Null when there is no entity.
 *
 *  The hover used to light the WHOLE entity, which told the user the whole line
 *  was about to go when trim removes only the span between crossings — one
 *  reporter filed a bug on the trim it predicted, not the trim it did. */
export function trimSpan(ents: ResolvedEntity[], index: number, click: THREE.Vector2): ResolvedEntity | null {
  return planTrim(ents, index, click)?.removed ?? null;
}

/**
 * Trim: remove the clicked portion of a curve up to its nearest intersections.
 * Lines split into the outer segments; arcs into the outer sub-arcs; a circle
 * becomes the complementary arc. A curve with no usable crossing is deleted whole.
 * A tangential touch is a crossing like any other.
 */
export function trimEntity(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] {
  return trimWithConstraints(ents, index, click, []).entities;
}

/** A trim's entities, the constraints rewritten for what it left, and how many
 *  constraints could no longer apply and were removed (the caller says so).
 *  `points` and `lines` say where what an extrude's start or up-to reference
 *  can name on the trimmed entity went (types.ts ExtrudeRef), for the caller
 *  to re-point those: each of its points (by dimRefPoints index) to the piece
 *  that still has it, or else to another curve's end at that spot, and its
 *  line operands (its own id for a line, a rectangle's `<rectId>~<k>`) to the
 *  piece that keeps that line. What the trim took away is in neither. */
export type TrimResult = {
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  dropped: number;
  points: Record<number, { e: string; p: number }>;
  lines: Record<string, string>;
};

/** Trim, keeping every constraint that still applies to what is left.
 *
 *  Trim used to let the caller prune whatever named the trimmed curve, which
 *  silently deleted constraints that still held: an offset link on a trimmed
 *  copy, a tangency on the kept arc (report 356b2693). remapTrimmed rewrites
 *  each of them for the pieces.
 *
 *  The piece holding the curve's start (or the only piece) keeps the curve's
 *  own id, because it IS that curve, shortened: a pattern that copies it, and
 *  an extrude that starts from or runs up to a point of it the trim kept,
 *  still find it. Every other piece is new. A rectangle's id goes to the piece
 *  of its first side that starts at corner 0, the side explodeCompound gives
 *  it to. That piece also leads, for remapTrimmed's dimensions.
 *
 *  A kept id is not free. An extrude remembers the ids bounding the area it
 *  picked and trusts a unique id match before its stored point, so the id on
 *  a piece that now bounds a DIFFERENT area moved the extrude there without a
 *  word (measured: a quadrant extrude jumped to the quadrant beside it). The
 *  caller re-points those references (SketchMode.carryRegionRefs). A line has
 *  only two ends, and the kept piece's ends are not the curve's: `points` says
 *  where each point went, or that the trim removed it, for the caller to
 *  re-point an extrude that names it. And a projection of the curve in another
 *  sketch would follow the kept piece without a word, so the caller stops it
 *  following (SketchMode.trimClick). */
export function trimWithConstraints(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
  cons: SketchConstraint[],
): TrimResult & { joins: SketchConstraint[] } {
  const e = ents[index];
  const plan = planTrim(ents, index, click);
  if (!e || !plan) return { entities: ents, constraints: cons, dropped: 0, points: {}, lines: {}, joins: [] };
  const start = dimRefPoints(e).find((r) => r.p === 0)?.pos;
  const startsHere = (pc: TrimPiece) => !!start && endsAt(pc.geom, start);
  const lead = e.type === "rectangle" ? null : plan.kept.find(startsHere) ?? plan.kept[0];
  const side0 = plan.kept.filter((pc) => pc.from === `${e.id}~0`);
  const keeper = e.type === "rectangle" ? side0.find(startsHere) ?? side0[0] : lead;
  const pieces = plan.kept.map((pc) => ({
    ...pc,
    lead: pc === lead,
    geom: { ...pc.geom, id: pc === keeper ? e.id : newEntityId() },
  }));
  const entities = ents.flatMap((o, i) => (i === index ? pieces.map((pc) => pc.geom) : [o]));
  const remapped = remapTrimmed(e, pieces, cons, entities);
  // trimmedPoints only looks at e's OWN pieces, so a point this trim cut off
  // every one of them reads TRIMMED_AWAY even when another entity still ends
  // there — the second of two trims in a row does that to the first trim's
  // corner. remapped.points already found it there (sharedEnd): where
  // trimmedPoints says TRIMMED_AWAY, prefer remapped.points' answer if it has
  // one. Elsewhere trimmedPoints' own entries stand, including the ones it
  // omits for a point that did not move.
  const points = trimmedPoints(e, pieces);
  for (const [p, q] of Object.entries(points)) {
    if (q.p === TRIMMED_AWAY && remapped.points[Number(p)]) points[Number(p)] = remapped.points[Number(p)]!;
  }
  return { entities, ...remapped, points, joins: cutJoins(e, pieces, entities) };
}

/** Where each of `e`'s points (by dimRefPoints index) is after a trim, when
 *  that is not the same index on `e`'s own id: the piece that still has it,
 *  the one that kept the id first. A circle's centre becomes its arc's centre
 *  (index 2).
 *
 *  A point the trim removed goes to TRIMMED_AWAY on `e`'s id, so an extrude
 *  on it is refused and says so, as when Trim made every id new. Left as it
 *  was, it would name whatever the kept piece has at that index now: the
 *  cut, or on a clockwise arc (arcFromSpan rebuilds it counter-clockwise) the
 *  arc's other end, and the extrude would move there without a word. A
 *  dimension on such a point is dropped and said (remapTrimmed), for the same
 *  reason. When no piece kept the id, nothing is removed that way: the id is
 *  gone, and a reference to it is refused as it always was. */
function trimmedPoints(e: ResolvedEntity, pieces: TrimPiece[]): Record<number, { e: string; p: number }> {
  const out: Record<number, { e: string; p: number }> = {};
  const order = [...pieces.filter((pc) => pc.geom.id === e.id), ...pieces.filter((pc) => pc.geom.id !== e.id)];
  const idKept = order[0]?.geom.id === e.id;
  for (const { p, pos } of dimRefPoints(e)) {
    let found = false;
    for (const pc of order) {
      const hit = dimRefPoints(pc.geom).find((r) => r.pos.distanceTo(pos) < 1e-6);
      if (!hit) continue;
      if (pc.geom.id !== e.id || hit.p !== p) out[p] = { e: pc.geom.id, p: hit.p };
      found = true;
      break;
    }
    if (!found && idKept) out[p] = { e: e.id, p: TRIMMED_AWAY };
  }
  return out;
}

/** The joins a trim owes the ends it CUT: each kept piece's new end, held on
 *  the curve it was cut against, as other CAD packages do (Doug, 25). Without
 *  them the new end was free, so the next change of a dimension opened the
 *  outline right there: a belt came off its pulley, a keyhole stopped being
 *  closed. They are returned apart from the rewritten constraints because
 *  the caller adds them on trial: a sketch that cannot take one keeps the trim
 *  and loses only the joins.
 *
 *  A Coincident when the curve it was cut against has a POINT there (an end,
 *  a corner), the way two ends that meet are joined; otherwise a point on that
 *  curve (`pointOn`): a line, a rectangle, polygon or slot side, a circle or an
 *  arc, native or projected. A spline, a slot's round end and sketch text take
 *  no point on them, so a cut against one stays free, as it always was. Where
 *  several curves pass through the cut, a point on any of them comes first,
 *  then the first curve in sketch order.
 *
 *  A cut is an end of a kept piece the curve did not have before (planTrim
 *  never cuts within 1e-4 of an end), and the curve it was cut against is the
 *  one that end lies on. To a few times touchTol, not exactly: a cut at a
 *  tangency is where curveCrossings counted a touch, and that sits up to
 *  touchTol off one of the two curves.
 *
 *  A tangency between the piece and that curve is kept (remapTrimmed). Held on
 *  the curve at the touch, the solver states it AT that point (sketchSolve's
 *  tangent2), because to planegcs a tangency and a point on the curve at the
 *  touch are the same condition twice. */
function cutJoins(e: ResolvedEntity, pieces: TrimPiece[], after: ResolvedEntity[]): SketchConstraint[] {
  const had = dimRefPoints(e).map((r) => r.pos);
  const own = new Set(pieces.map((pc) => pc.geom.id));
  // the origin axes cut nothing (crossingsOn), so nothing was cut against them
  const others = after.filter((o) => !own.has(o.id) && !isOriginGeometry(o.id));
  const tolFor = (o: ResolvedEntity) => 4 * touchTol(Math.max(asRound(e)?.r ?? 0, asRound(o)?.r ?? 0));
  const out: SketchConstraint[] = [];
  for (const pc of pieces) {
    const g = pc.geom;
    if (pc.whole || (g.type !== "line" && g.type !== "arc")) continue;
    for (const end of [0, 1]) {
      const at = refPoint(g, end);
      if (!at || had.some((q) => q.distanceTo(at) < 1e-6)) continue; // an end it always had
      const through = others.filter((o) => entityCurves(o).some((c) => onCurve(c, at, tolFor(o))));
      const point = through
        .map((o) => ({ o, r: dimRefPoints(o).find((r) => r.pos.distanceTo(at) <= tolFor(o)) }))
        .find((x) => x.r);
      if (point?.r) {
        out.push({ type: "coincident", e1: g.id, p1: end, e2: point.o.id, p2: point.r.p });
        continue;
      }
      for (const o of through) {
        const k = curveKind(o);
        const curve = lineOperandAt(o, at) ?? (k === "circle" || k === "arc" ? o.id : null);
        if (!curve) continue;
        out.push({ type: "pointOn", e: g.id, p: end, curve });
        break;
      }
    }
  }
  return out;
}

/** is `q` on the curve `c`, within `tol` (an arc within its sweep)? */
function onCurve(c: Curve2, q: THREE.Vector2, tol: number): boolean {
  if (c.kind === "seg") return distToSeg(c.a, c.b, q) <= tol;
  if (Math.abs(q.distanceTo(c.c) - c.r) > tol) return false;
  if (c.sweep >= TAU) return true;
  const slack = tol / Math.max(c.r, 1e-9);
  const at = ccwDelta(c.a0, Math.atan2(q.y - c.c.y, q.x - c.c.x));
  return at <= c.sweep + slack || at >= TAU - slack;
}

/** Where the curves a Tangent names touch, for the Trim tool to show and the
 *  drawing tools to snap to: a tangency is a point a trim stops at (a touch
 *  counts as a crossing), and nothing else on screen says where it is. Only
 *  where both curves really reach it, so not on a line's extension or past an
 *  arc's end, and only once the solve has made them touch. Not where a curve
 *  touches an origin axis either: the axes cut nothing (crossingsOn), so a
 *  trim runs straight through that touch and a dot there would promise a stop
 *  it does not make. */
export function tangencyPoints(ents: readonly ResolvedEntity[], cons: readonly SketchConstraint[]): THREE.Vector2[] {
  const byId = new Map(ents.map((e) => [e.id, e]));
  /** the entity an operand is on: a side `S~k` is on its shape */
  const owner = (id: string) => byId.get(id) ?? byId.get(id.split("~")[0]!);
  const shape = (id: string) => {
    const o = byId.get(id);
    return lineOperand(byId, id) ?? (o ? asRound(o) : null);
  };
  const reaches = (id: string, q: THREE.Vector2) => {
    const o = owner(id);
    return !!o && entityCurves(o).some((c) => onCurve(c, q, 1e-4));
  };
  const out: THREE.Vector2[] = [];
  for (const c of cons) {
    const pair: [string, string] | null =
      c.type === "tangent" ? [c.line, c.circle] : c.type === "tangent2" ? [c.a, c.b] : null;
    if (!pair || pair.some((id) => isOriginGeometry(id))) continue;
    const [a, b] = pair;
    const sa = shape(a), sb = shape(b);
    const at = sa && sb ? touchPoint(sa, sb) : null;
    if (!at || !reaches(a, at) || !reaches(b, at)) continue;
    if (!out.some((q) => q.distanceTo(at) < 1e-6)) out.push(at);
  }
  return out;
}

/** does a line or arc end at `p`? */
function endsAt(g: ResolvedEntity, p: THREE.Vector2): boolean {
  if (g.type !== "line" && g.type !== "arc") return false;
  return Math.hypot(g.x1 - p.x, g.y1 - p.y) < 1e-6 || Math.hypot(g.x2 - p.x, g.y2 - p.y) < 1e-6;
}

/** Where point operand (`id`, `p`) sat on the entity `e` before it was trimmed:
 *  `id` is the entity itself, or a rectangle edge spelling of one of its
 *  corners (edge k runs from corner k to corner k+1, as in glyphs.ts). */
function pointBefore(e: ResolvedEntity, id: string, p: number): THREE.Vector2 | null {
  if (e.type === "circle") return v(e.x, e.y); // a circle resolves to its centre at any index
  if (id === e.id) return dimRefPoints(e).find((r) => r.p === p)?.pos ?? null;
  const k = Number(id.slice(id.lastIndexOf("~") + 1));
  if (e.type !== "rectangle" || !Number.isInteger(k)) return null;
  return rectCorners(e.x, e.y, e.width, e.height)[(k + (p === 1 ? 1 : 0)) % 4] ?? null;
}

/** Where a tangency between `carrier` (the trimmed curve, as it was) and `other`
 *  touches — the point on the carrier nearest the other curve. Null when the
 *  pair has no single touch point (two lines, concentric rounds). */
function touchPoint(
  carrier: { x1: number; y1: number; x2: number; y2: number } | { x: number; y: number; r: number },
  other: { x1: number; y1: number; x2: number; y2: number } | { x: number; y: number; r: number },
): THREE.Vector2 | null {
  const foot = (l: { x1: number; y1: number; x2: number; y2: number }, q: THREE.Vector2) => {
    const a = v(l.x1, l.y1), b = v(l.x2, l.y2);
    return a.clone().lerp(b, paramOnSeg(a, b, q));
  };
  if ("x1" in carrier) return "r" in other ? foot(carrier, v(other.x, other.y)) : null;
  const C = v(carrier.x, carrier.y);
  if ("x1" in other) {
    const dir = foot(other, C).sub(C);
    return dir.lengthSq() < 1e-18 ? null : C.clone().add(dir.normalize().multiplyScalar(carrier.r));
  }
  const c2 = v(other.x, other.y);
  const u = c2.clone().sub(C);
  if (u.lengthSq() < 1e-18) return null;
  u.normalize().multiplyScalar(carrier.r);
  const near = C.clone().add(u), far = C.clone().sub(u);
  const miss = (q: THREE.Vector2) => Math.abs(q.distanceTo(c2) - other.r);
  return miss(near) <= miss(far) ? near : far;
}

/** Rewrite the constraints that named a trimmed entity for the pieces it left,
 *  and say where its points and lines went (TrimResult).
 *
 *  Trim shortens a curve; it does not change what the curve IS. So a constraint
 *  about the CARRIER (the infinite line, the full circle) still holds and stays:
 *  horizontal, parallel, a radius, a tangency, an offset link. The ones that
 *  carry no number hold for every piece and are given to every piece; a
 *  dimension stays once, on the lead piece, rather than appearing twice. A
 *  tangency goes to the piece that actually touches.
 *
 *  A constraint about the curve's EXTENT does not hold (a length, an equal
 *  length, a midpoint): kept, it would pull the piece straight back out to the
 *  old length. A constraint on a POINT follows that point to whichever piece
 *  still has it, and goes when the point was trimmed away. Both of those are
 *  counted in `dropped`, so the caller can say what went, except a Coincident
 *  that joined a cut-away end: that corner is what the trim took apart. */
function remapTrimmed(
  e: ResolvedEntity,
  pieces: TrimPiece[],
  cons: SketchConstraint[],
  after: ResolvedEntity[],
): Omit<TrimResult, "entities"> {
  const names = (id: string) => id === e.id || (e.type === "rectangle" && id.startsWith(`${e.id}~`));
  const byId = new Map(after.map((x) => [x.id, x]));
  const cutFrom = (id: string) => pieces.filter((pc) => pc.from === id);
  /** the piece that takes over operand `id`: the lead, else the first piece of
   *  that rectangle edge */
  const keeper = (id: string) => { const ps = cutFrom(id); return ps.find((pc) => pc.lead) ?? ps[0]; };
  /** a curve operand, rewritten to its keeper; null when nothing of it is left */
  const curve = (id: string): string | null => (names(id) ? keeper(id)?.geom.id ?? null : id);
  /** the other pieces cut from a curve operand */
  const others = (id: string): string[] =>
    names(id) ? cutFrom(id).filter((pc) => pc !== keeper(id)).map((pc) => pc.geom.id) : [];
  /** an operand whose EXTENT matters: only an untouched rectangle edge still has it */
  const extent = (id: string): string | null => {
    if (!names(id)) return id;
    const k = keeper(id);
    return k?.whole ? k.geom.id : null;
  };
  /** a point operand, followed to whichever piece still has that point */
  const point = (id: string, p: number): { e: string; p: number } | null => {
    if (!names(id)) return { e: id, p };
    const at = pointBefore(e, id, p);
    if (!at) return null;
    for (const pc of [...pieces.filter((x) => x.lead), ...pieces.filter((x) => !x.lead)]) {
      const hit = dimRefPoints(pc.geom).find((r) => r.pos.distanceTo(at) < 1e-6);
      if (hit) return { e: pc.geom.id, p: hit.p };
    }
    return null;
  };
  /** a tangency operand: the piece nearest the touch point, when there is a choice */
  const touching = (id: string, otherId: string): string | null => {
    const ps = names(id) ? cutFrom(id) : [];
    if (ps.length < 2) return curve(id);
    const carrier = lineOperand(new Map([[e.id, e]]), id) ?? asRound(e);
    const other = lineOperand(byId, otherId) ?? (byId.has(otherId) ? asRound(byId.get(otherId)!) : null);
    const at = carrier && other ? touchPoint(carrier, other) : null;
    if (!at) return curve(id);
    return ps.reduce((a, b) => (distToEntity(b.geom, at) < distToEntity(a.geom, at) ? b : a)).geom.id;
  };
  /** the piece of a curve operand nearest a point, when there is a choice */
  const nearestTo = (id: string, q: { e: string; p: number }): string | null => {
    const ps = names(id) ? cutFrom(id) : [];
    if (ps.length < 2) return curve(id);
    const owner = byId.get(q.e);
    const at = owner ? refPoint(owner, q.p) : null;
    if (!at) return curve(id);
    return ps.reduce((a, b) => (distToEntity(b.geom, at) < distToEntity(a.geom, at) ? b : a)).geom.id;
  };
  const mentions = (c: SketchConstraint) =>
    c.type === "offset"
      ? c.pairs.some((pr) => names(pr.src) || names(pr.cpy))
      : Object.entries(c).some(([k, val]) => k !== "type" && k !== "id" && typeof val === "string" && names(val));

  let lostLinks = 0;
  const remap = (c: SketchConstraint): SketchConstraint[] | null => {
    switch (c.type) {
      // the carrier's direction or centre, and no number: true of every piece
      case "horizontal": case "vertical": {
        const line = curve(c.line);
        return line ? [{ ...c, line }, ...others(c.line).map((l) => ({ ...c, line: l }))] : null;
      }
      case "parallel": case "perpendicular": case "collinear": {
        const l1 = curve(c.l1), l2 = curve(c.l2);
        if (!l1 || !l2) return null;
        return [
          { ...c, l1, l2 },
          ...others(c.l1).map((l) => ({ ...c, l1: l, l2 })),
          ...others(c.l2).map((l) => ({ ...c, l1, l2: l })),
        ];
      }
      case "concentric": {
        const c1 = curve(c.c1), c2 = curve(c.c2);
        if (!c1 || !c2) return null;
        return [
          { ...c, c1, c2 },
          ...others(c.c1).map((r) => ({ ...c, c1: r, c2 })),
          ...others(c.c2).map((r) => ({ ...c, c1, c2: r })),
        ];
      }
      case "equalRadius": {
        const a = curve(c.a), b = curve(c.b);
        if (!a || !b) return null;
        return [
          { ...c, a, b },
          ...others(c.a).map((r) => ({ ...c, a: r, b })),
          ...others(c.b).map((r) => ({ ...c, a, b: r })),
        ];
      }
      // a dimension on the carrier: once, on the keeper
      case "angle": {
        const l1 = curve(c.l1), l2 = curve(c.l2);
        return l1 && l2 ? [{ ...c, l1, l2 }] : null;
      }
      case "diameter": { const circle = curve(c.circle); return circle ? [{ ...c, circle }] : null; }
      case "radius": { const r = curve(c.e); return r ? [{ ...c, e: r }] : null; }
      case "radialGap": {
        const inner = curve(c.inner), outer = curve(c.outer);
        return inner && outer ? [{ ...c, inner, outer }] : null;
      }
      case "c2cDistance": {
        const c1 = curve(c.c1), c2 = curve(c.c2);
        return c1 && c2 ? [{ ...c, c1, c2 }] : null;
      }
      case "c2lDistance": {
        const circle = curve(c.circle), line = curve(c.line);
        return circle && line ? [{ ...c, circle, line }] : null;
      }
      // the curve's extent
      case "distance": { const line = extent(c.line); return line ? [{ ...c, line }] : null; }
      case "equal": {
        const l1 = extent(c.l1), l2 = extent(c.l2);
        return l1 && l2 ? [{ ...c, l1, l2 }] : null;
      }
      case "tangent": {
        const line = touching(c.line, c.circle), circle = touching(c.circle, c.line);
        if (!line || !circle) return null;
        // a trimmed circle is an ARC now, and `tangent` takes circles only
        return [e.type === "circle" && c.circle === e.id ? { type: "tangent2", a: line, b: circle } : { ...c, line, circle }];
      }
      case "tangent2": {
        const a = touching(c.a, c.b), b = touching(c.b, c.a);
        return a && b ? [{ ...c, a, b }] : null;
      }
      // points. A join whose end on this curve was cut away goes with it,
      // unsaid, as Fillet's corner join does (cornerJoins): cutting the end off
      // a corner IS taking the corner apart, and every corner of a chain of
      // lines carries one, so saying it would make a note of nearly every trim.
      case "coincident": {
        const a = point(c.e1, c.p1), b = point(c.e2, c.p2);
        return a && b ? [{ ...c, e1: a.e, p1: a.p, e2: b.e, p2: b.p }] : [];
      }
      // A trim deletes a spline whole, which drops this. A trimmed `other`
      // hands it to the piece at the joint, the one nearest the spline's end.
      case "splineTangent": {
        const spline = curve(c.spline), other = nearestTo(c.other, { e: c.spline, p: c.end });
        return spline && other ? [{ ...c, spline, other }] : null;
      }
      case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY": {
        const a = point(c.e1, c.p1), b = point(c.e2, c.p2);
        return a && b ? [{ ...c, e1: a.e, p1: a.p, e2: b.e, p2: b.p }] : null;
      }
      case "fix": { const q = point(c.e, c.p); return q ? [{ ...c, e: q.e, p: q.p }] : null; }
      case "midpoint": {
        const q = point(c.e, c.p), line = extent(c.line);
        return q && line ? [{ ...c, e: q.e, p: q.p, line }] : null;
      }
      // A point on the CARRIER, so it holds for every piece; but one point on
      // two pieces would also hold those pieces in line with each other, which
      // the trim did not ask for. It goes to the piece nearest the point.
      case "pointOn": {
        const q = point(c.e, c.p);
        const on = q ? nearestTo(c.curve, q) : null;
        return q && on ? [{ ...c, e: q.e, p: q.p, curve: on }] : null;
      }
      case "symmetric": {
        const a = point(c.e1, c.p1), b = point(c.e2, c.p2), line = curve(c.line);
        return a && b && line ? [{ ...c, e1: a.e, p1: a.p, e2: b.e, p2: b.p, line }] : null;
      }
      case "p2lDistance": {
        const q = point(c.e, c.p), line = curve(c.line);
        return q && line ? [{ ...c, e: q.e, p: q.p, line }] : null;
      }
      case "p2cDistance": {
        const q = point(c.e, c.p), circle = curve(c.circle);
        return q && circle ? [{ ...c, e: q.e, p: q.p, circle }] : null;
      }
      // Every piece of a trimmed COPY is still an offset of its source; a
      // trimmed SOURCE keeps the link on its keeper only, because two sources
      // would govern the one copy twice.
      case "offset": {
        let lost = 0;
        const pairs = c.pairs.flatMap((pr) => {
          const src = curve(pr.src), cpy = curve(pr.cpy);
          if (!src || !cpy) { lost++; return []; }
          return [{ src, cpy }, ...others(pr.cpy).map((o) => ({ src, cpy: o }))];
        });
        if (!pairs.length) return null;
        lostLinks += lost;
        return [{ ...c, pairs }];
      }
      default: return [c satisfies never];
    }
  };

  const constraints: SketchConstraint[] = [];
  let dropped = 0;
  for (const c of cons) {
    const next = mentions(c) ? remap(c) : [c];
    if (next) constraints.push(...next);
    else dropped++;
  }
  // Where an extrude's reference on it goes: by the same rules as a
  // constraint's point and curve operands, except that a point no piece has
  // goes to another curve's end still drawn there. Two ends at one position
  // are one point to the solver (coincKey), so that is the same point; it is
  // how a corner a first trim put on one side survives a second trim that
  // takes that side's end away.
  const pieceIds = new Set(pieces.map((pc) => pc.geom.id));
  const sharedEnd = (at: THREE.Vector2): { e: string; p: number } | null => {
    const key = coincKey(at.x, at.y);
    for (const o of after) {
      if (pieceIds.has(o.id) || isOriginGeometry(o.id)) continue;
      const r = dimRefPoints(o).find((x) => coincKey(x.pos.x, x.pos.y) === key);
      if (r) return { e: o.id, p: r.p };
    }
    return null;
  };
  const points: Record<number, { e: string; p: number }> = {};
  for (const { p, pos } of dimRefPoints(e)) {
    const q = point(e.id, p) ?? sharedEnd(pos);
    if (q) points[p] = q;
  }
  const lines: Record<string, string> = {};
  const ownLines = e.type === "rectangle" ? [0, 1, 2, 3].map((k) => `${e.id}~${k}`) : e.type === "line" ? [e.id] : [];
  for (const id of ownLines) {
    const to = curve(id);
    if (to) lines[id] = to;
  }
  return { constraints, dropped: dropped + lostLinks, points, lines };
}

/** What Explode made of a rectangle, polygon or slot. */
export type ExplodeResult = {
  /** the whole entity list, with the shape replaced IN PLACE by what it became */
  entities: ResolvedEntity[];
  /** the whole constraint list: everything that named the shape rewritten for
   *  what it became, then the constraints that keep it the same shape */
  constraints: SketchConstraint[];
  /** the line each SIDE operand became: `sides[k]` is what `<shapeId>~k` names */
  sides: string[];
  /** the outline it became, in order around it (a slot's two end arcs
   *  included). The first is the shape's own id. */
  outline: string[];
  /** the construction geometry that holds it in shape: a polygon's two
   *  circles, a slot's two end diameters, a rectangle's centre point and the
   *  two lines that hold it (only when a constraint names that centre, or the
   *  caller asks: `centre`). Not part of the outline. */
  helpers: string[];
  /** the constraints that hold it in shape, the last ones in `constraints`
   *  (the same objects): the explode's own, not anything the user made */
  holds: SketchConstraint[];
  /** constraints that named the shape and could not be carried over */
  dropped: number;
  /** where each of the shape's own points went, by its dimRefPoints index:
   *  corner k to the start of side k's line, a polygon's centre to its ring's,
   *  a slot's centres to its end arcs', a rectangle's centre to its centre
   *  point when it has one (`helpers`). An extrude's start or up-to point
   *  names a shape's point by that index (types.ts ExtrudeRef), and a line
   *  has only ends 0 and 1, so the caller re-points those references with
   *  this. */
  points: Record<number, { e: string; p: number }>;
};

/** Explode ents[idx], a rectangle, polygon or slot, into the lines (and a
 *  slot's arcs) it is drawn with, plus the constraints that keep it the shape
 *  it was:
 *
 *    rectangle  4 lines, Horizontal and Vertical on them; or, with
 *               `square: "perpendicular"`, Perpendicular on three corners,
 *               which holds it square at ANY angle (Rotate wants that)
 *    polygon    n lines, every corner ON a construction circle and every
 *               side Tangent to a second one inside it, the two concentric,
 *               which is what keeps it regular
 *    slot       2 lines and 2 end arcs, a construction line across each end
 *               holding its arc's centre and square to the sides, and the
 *               arcs Equal in radius, which keeps every join tangent
 *
 *  Each leaves exactly the freedom the shape had: a rectangle its position and
 *  two sizes (plus its angle, held square by Perpendicular), a polygon its
 *  centre, size and angle, a slot its two centres and width. A size the user
 *  never locked stays free; it is not turned into a dimension.
 *
 *  The shape's id goes to its first line, on purpose. An extrude records the
 *  ids that bound the area it picked (types.ts, `regionEntities`) and trusts
 *  them before its stored point, so an id that vanished would leave it on the
 *  point alone. Kept on a side of the SAME area, it still names that area.
 *  Only on its first side, though, so where the shape bounded several areas
 *  the id alone can name the wrong one: the caller re-points the extrudes on
 *  the sketch (SketchMode.carryRegionRefs). An extrude that starts from or
 *  runs up to one of the shape's points, from any sketch, is re-pointed too
 *  (`points`, SketchMode.commitExplodes): the first line has only two ends,
 *  so its corner 2 or 3 would name nothing. A trim keeps the trimmed curve's
 *  id on one piece too, and its caller re-points the same two kinds of
 *  reference.
 *
 *  Every constraint that named the shape is rewritten for the lines: a side
 *  (`R~k`, `P~k`, `S~k`) becomes its line, and a rectangle corner becomes the
 *  start of the side leaving it. A LOCKED width or height, and a dimension
 *  across one side's two corners, become the distance between the two
 *  opposite sides rather than the length of one line: a later fillet or
 *  chamfer shortens that line, and its length would then pull the shape out
 *  by the corner it rounded. The opposite sides do not move when a corner is
 *  rounded, so the size holds.
 *
 *  Null when `idx` is not one of the three shapes, or the shape has no size. */
export function explodeCompound(
  ents: ResolvedEntity[],
  cons: SketchConstraint[],
  idx: number,
  opts: { square?: "axes" | "perpendicular"; centre?: boolean } = {},
): ExplodeResult | null {
  const e = ents[idx];
  if (!e) return null;
  const c = constr(e);
  const line = (id: string, a: { x: number; y: number }, b: { x: number; y: number }): ResolvedEntity =>
    ({ type: "line", id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...c });
  let made: ResolvedEntity[];
  let sides: string[];
  let outline: string[];
  let helpers: string[] = [];
  let keep: SketchConstraint[];

  if (e.type === "rectangle") {
    if (!(e.width > 0 && e.height > 0)) return null;
    const corners = rectCorners(e.x, e.y, e.width, e.height); // bl, br, tr, tl
    sides = [e.id, newEntityId(), newEntityId(), newEntityId()];
    made = corners.map((a, k) => line(sides[k]!, a, corners[(k + 1) % 4]!));
    outline = sides;
    const [s0, s1, s2, s3] = sides as [string, string, string, string];
    keep = opts.square === "perpendicular"
      ? [
        { type: "perpendicular", l1: s0, l2: s1 },
        { type: "perpendicular", l1: s1, l2: s2 },
        { type: "perpendicular", l1: s2, l2: s3 },
      ]
      : [
        { type: "horizontal", line: s0 },
        { type: "vertical", line: s1 },
        { type: "horizontal", line: s2 },
        { type: "vertical", line: s3 },
      ];
    // Its CENTRE, when a constraint names it (point 4): a construction point
    // held in the middle of two construction lines, one across from the left
    // side's line to the right side's and one up from the bottom's to the
    // top's, each square to the sides it spans. Not a diagonal between two
    // corners: a fillet or chamfer moves the corners off the corner, while
    // the sides' lines stay where they were, so this keeps the centre where
    // it was after one. Rotate needs it most, turning a rectangle about its
    // centre on the origin. `centre` asks for it when no constraint names it:
    // an extrude that starts from or runs up to it does (types.ts ExtrudeRef),
    // and without the point it had nowhere to go.
    const namesCentre = opts.centre || cons.some((k) => {
      const rec = k as unknown as Record<string, unknown>;
      return ([["e", "p"], ["e1", "p1"], ["e2", "p2"]] as const).some(([f, q]) => rec[f] === e.id && rec[q] === RECT_CENTRE);
    });
    if (namesCentre) {
      const centre = newEntityId(), across = newEntityId(), up = newEntityId();
      const hw = e.width / 2, hh = e.height / 2;
      made.push(
        { type: "point", id: centre, x: e.x, y: e.y, construction: true },
        { ...line(across, { x: e.x - hw, y: e.y }, { x: e.x + hw, y: e.y }), construction: true },
        { ...line(up, { x: e.x, y: e.y - hh }, { x: e.x, y: e.y + hh }), construction: true },
      );
      helpers = [centre, across, up];
      keep.push(
        { type: "pointOn", e: across, p: 0, curve: s3 },
        { type: "pointOn", e: across, p: 1, curve: s1 },
        { type: "perpendicular", l1: across, l2: s1 },
        { type: "midpoint", e: centre, p: 0, line: across },
        { type: "pointOn", e: up, p: 0, curve: s0 },
        { type: "pointOn", e: up, p: 1, curve: s2 },
        { type: "perpendicular", l1: up, l2: s0 },
        { type: "midpoint", e: centre, p: 0, line: up },
      );
    }
  } else if (e.type === "polygon") {
    if (!(e.radius > 0)) return null;
    const vs = polygonPoints(e.x, e.y, e.radius, e.sides, (e.angle * Math.PI) / 180);
    const n = vs.length;
    sides = vs.map((_, k) => (k === 0 ? e.id : newEntityId()));
    made = vs.map((a, k) => line(sides[k]!, a, vs[(k + 1) % n]!));
    outline = sides;
    // Its corners on one circle and its sides touching a second, concentric
    // one. Equal sides would hold it too, until a fillet or a chamfer: those
    // shorten the two sides they work on, and Equal then pulls every side to
    // the shorter length and the polygon out of shape (measured: a hexagon of
    // radius 10 shrank to 9.86 and went irregular). A side's line does not
    // move when its corner is rounded, so the inner circle keeps holding it.
    const ring: ResolvedEntity = { type: "circle", id: newEntityId(), x: e.x, y: e.y, radius: e.radius, construction: true };
    const inner: ResolvedEntity = { type: "circle", id: newEntityId(), x: e.x, y: e.y, radius: e.radius * Math.cos(Math.PI / n), construction: true };
    made.push(ring, inner);
    helpers = [ring.id, inner.id];
    keep = [
      { type: "concentric", c1: ring.id, c2: inner.id },
      // corner k is where side k starts
      ...sides.map((s): SketchConstraint => ({ type: "pointOn", e: s, p: 0, curve: ring.id })),
      ...sides.map((s): SketchConstraint => ({ type: "tangent2", a: s, b: inner.id })),
    ];
  } else if (e.type === "slot") {
    const one = new Map([[e.id, e]]);
    const a = lineOperand(one, `${e.id}~0`), b = lineOperand(one, `${e.id}~1`);
    if (!a || !b || !(e.width > 0)) return null;
    // Side 0 runs (x1,y1) -> (x2,y2) on the left of the axis and side 1 back
    // on the right (entityDims' shapeSide), so the end arcs close them up:
    // one round (x2,y2) from side 0's end to side 1's start, one round
    // (x1,y1) from side 1's end to side 0's start, each bulging out along the
    // axis. A construction line across each end (its diameter) is what holds
    // the shape, see below.
    const r = e.width / 2;
    const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    const ux = (e.x2 - e.x1) / len, uy = (e.y2 - e.y1) / len;
    const s0 = e.id, s1 = newEntityId(), endB = newEntityId(), endA = newEntityId();
    const acrossB = newEntityId(), acrossA = newEntityId();
    const P0 = { x: a.x1, y: a.y1 }, P1 = { x: a.x2, y: a.y2 }, P2 = { x: b.x1, y: b.y1 }, P3 = { x: b.x2, y: b.y2 };
    made = [
      line(s0, P0, P1),
      { type: "arc", id: endB, x1: P1.x, y1: P1.y, x2: P2.x, y2: P2.y, mx: e.x2 + ux * r, my: e.y2 + uy * r, ...c },
      line(s1, P2, P3),
      { type: "arc", id: endA, x1: P3.x, y1: P3.y, x2: P0.x, y2: P0.y, mx: e.x1 - ux * r, my: e.y1 - uy * r, ...c },
      { ...line(acrossB, P1, P2), construction: true },
      { ...line(acrossA, P3, P0), construction: true },
    ];
    sides = [s0, s1];
    outline = [s0, endB, s1, endA];
    helpers = [acrossB, acrossA];
    // NOT Tangent, chosen when a line tangent to an arc it shares an end with
    // compiled to a degenerate equation (the touch is a maximum of the
    // distance it measures), so the solver reported all four as redundant and
    // a drag of the result conflicted. That compiles to angle_via_point now
    // (sketchSolve's tangent2), but this hold is what slots already exploded
    // carry, and it is as good. Each end's centre on its diameter, both diameters
    // square to side 0 and equal radii give the same shape, tangent by
    // construction, with the slot's five freedoms: two centres and a width.
    keep = [
      { type: "pointOn", e: endB, p: 2, curve: acrossB },
      { type: "pointOn", e: endA, p: 2, curve: acrossA },
      { type: "perpendicular", l1: s0, l2: acrossB },
      { type: "perpendicular", l1: s0, l2: acrossA },
      { type: "equalRadius", a: endA, b: endB },
    ];
  } else {
    return null;
  }

  const shape = e.id;
  const names = (id: string) => id === shape || id.startsWith(`${shape}~`);
  /** a LINE operand: a side becomes its line; the bare shape id was never one */
  const side = (id: string): string | null => {
    if (!names(id)) return id;
    const k = Number(id.slice(shape.length + 1));
    return id !== shape && Number.isInteger(k) && k >= 0 ? sides[k] ?? null : null;
  };
  /** which rectangle corner a point operand names, in either spelling: the
   *  rectangle and a corner index, or an edge and its end (edge k runs from
   *  corner k to corner k+1, as sketchSolve registers it) */
  const cornerOf = (id: string, p: number): number | null => {
    if (e.type !== "rectangle") return null; // a polygon's or slot's: see point()
    if (id === shape) return Number.isInteger(p) && p >= 0 && p <= 3 ? p : null;
    const k = Number(id.slice(shape.length + 1));
    return Number.isInteger(k) && k >= 0 && k <= 3 ? (k + (p === 1 ? 1 : 0)) % 4 : null;
  };
  /** a POINT operand: a corner becomes the start of the side leaving it, a
   *  polygon's centre the centre of its circle, a slot's centres those of its
   *  end arcs, and the end of a side (`P~k` p0/p1) the end of its line. A
   *  rectangle's centre becomes its construction centre point (above). */
  const point = (id: string, p: number): { e: string; p: number } | null => {
    if (!names(id)) return { e: id, p };
    if (e.type === "rectangle") {
      if (id === shape && p === RECT_CENTRE) return helpers[0] ? { e: helpers[0], p: 0 } : null;
      const k = cornerOf(id, p);
      return k === null ? null : { e: sides[k]!, p: 0 };
    }
    if (id !== shape) {
      const l = side(id);
      return l ? { e: l, p: p === 1 ? 1 : 0 } : null;
    }
    if (e.type === "polygon") {
      if (p === POLYGON_CENTRE) return { e: helpers[0]!, p: 0 };
      return Number.isInteger(p) && p >= 0 && p < sides.length ? { e: sides[p]!, p: 0 } : null;
    }
    // a slot: its arcs are outline[3] round (x1,y1) and outline[1] round (x2,y2)
    return p === 0 ? { e: outline[3]!, p: 2 } : p === 1 ? { e: outline[1]!, p: 2 } : null;
  };
  /** corner k as an end of the side through it that runs ACROSS `field`'s
   *  measure: the width runs between the two vertical sides (odd k), the
   *  height between the two horizontal ones */
  const across = (k: number, field: "width" | "height") =>
    k % 2 === (field === "width" ? 1 : 0) ? { e: sides[k]!, p: 0 } : { e: sides[(k + 3) % 4]!, p: 1 };
  /** the rectangle's width or height, held from corner `from` to the opposite
   *  side through corner `to` (see the header: not the length of one line) */
  const size = (
    field: "width" | "height", from: number, to: number,
    c: { id?: string; value: number; driven?: boolean; place?: PlaceOffset },
  ): SketchConstraint => ({
    type: "p2lDistance",
    ...(c.id !== undefined ? { id: c.id } : {}),
    e: across(from, field).e, p: across(from, field).p, line: across(to, field).e,
    value: Math.abs(c.value),
    ...(c.driven ? { driven: true } : {}),
    ...(c.place ? { place: c.place } : {}),
  });
  /** the size a point-to-point dimension across two corners of one side spans,
   *  if it does: {0,1} and {2,3} the width, {1,2} and {3,0} the height. X can
   *  only hold a width and Y only a height (a Y across the bottom is 0). */
  const spans = (c: Extract<SketchConstraint, { type: "p2pDistance" | "p2pDistanceX" | "p2pDistanceY" }>) => {
    if (e.type !== "rectangle") return null;
    const a = cornerOf(c.e1, c.p1), b = cornerOf(c.e2, c.p2);
    if (!names(c.e1) || !names(c.e2) || a === null || b === null) return null;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const field = (lo === 0 && hi === 1) || (lo === 2 && hi === 3) ? "width"
      : (lo === 1 && hi === 2) || (lo === 0 && hi === 3) ? "height" : null;
    if (!field || (c.type === "p2pDistanceX" && field !== "width") || (c.type === "p2pDistanceY" && field !== "height")) return null;
    return { field, from: a, to: b } as const;
  };

  const remap = (k: SketchConstraint): SketchConstraint | null => {
    switch (k.type) {
      case "horizontal": case "vertical": { const l = side(k.line); return l ? { ...k, line: l } : null; }
      case "distance": {
        if (e.type === "rectangle" && names(k.line)) {
          // a locked width (edge 0 or 2) or height (edge 1 or 3), from Lock
          const edge = Number(k.line.slice(shape.length + 1));
          if (k.line === shape || !Number.isInteger(edge) || edge < 0 || edge > 3) return null;
          // A lock has no label placement of its own: its label was the
          // rectangle's badge, so the badge's placement carries over. It lands
          // where the badge was: a dimension's label sits on the left of the
          // way it measures, which is below the bottom side for br -> bl and
          // left of the left side for bl -> tl.
          const field = edge % 2 === 0 ? "width" : "height";
          const place = dimPlaceOf(e)?.[field];
          return field === "width"
            ? size(field, 1, 0, { ...k, ...(place ? { place } : {}) })
            : size(field, 0, 3, { ...k, ...(place ? { place } : {}) });
        }
        const l = side(k.line);
        return l ? { ...k, line: l } : null;
      }
      case "parallel": case "perpendicular": case "equal": case "collinear": case "angle": {
        const l1 = side(k.l1), l2 = side(k.l2);
        return l1 && l2 ? { ...k, l1, l2 } : null;
      }
      case "tangent": { const l = side(k.line); return l && !names(k.circle) ? { ...k, line: l } : null; }
      case "tangent2": { const a = side(k.a), b = side(k.b); return a && b ? { ...k, a, b } : null; }
      // a spline is never the shape; the side it is tangent to becomes a line
      case "splineTangent": { const o = side(k.other); return o ? { ...k, other: o } : null; }
      case "coincident": {
        const a = point(k.e1, k.p1), b = point(k.e2, k.p2);
        return a && b ? { ...k, e1: a.e, p1: a.p, e2: b.e, p2: b.p } : null;
      }
      case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY": {
        const s = spans(k);
        if (s) return size(s.field, s.from, s.to, k);
        const a = point(k.e1, k.p1), b = point(k.e2, k.p2);
        return a && b ? { ...k, e1: a.e, p1: a.p, e2: b.e, p2: b.p } : null;
      }
      case "symmetric": {
        const a = point(k.e1, k.p1), b = point(k.e2, k.p2), l = side(k.line);
        return a && b && l ? { ...k, e1: a.e, p1: a.p, e2: b.e, p2: b.p, line: l } : null;
      }
      case "midpoint": case "p2lDistance": {
        const q = point(k.e, k.p), l = side(k.line);
        return q && l ? { ...k, e: q.e, p: q.p, line: l } : null;
      }
      case "pointOn": {
        const q = point(k.e, k.p), l = side(k.curve);
        return q && l ? { ...k, e: q.e, p: q.p, curve: l } : null;
      }
      case "fix": case "p2cDistance": {
        const q = point(k.e, k.p);
        return q ? { ...k, e: q.e, p: q.p } : null;
      }
      case "c2lDistance": { const l = side(k.line); return l && !names(k.circle) ? { ...k, line: l } : null; }
      case "offset": {
        const pairs = k.pairs.map((pr) => ({ src: side(pr.src), cpy: side(pr.cpy) }));
        return pairs.every((pr) => pr.src && pr.cpy) ? { ...k, pairs: pairs as { src: string; cpy: string }[] } : null;
      }
      // operands that are always rounds, and a rectangle, polygon or slot is
      // never one: these can only name the shape in a broken document
      case "concentric": case "equalRadius": case "diameter": case "radius":
      case "radialGap": case "c2cDistance":
        return null;
      default: return k satisfies never;
    }
  };
  const mentions = (k: SketchConstraint) =>
    k.type === "offset"
      ? k.pairs.some((pr) => names(pr.src) || names(pr.cpy))
      : Object.entries(k).some(([f, val]) => f !== "type" && f !== "id" && typeof val === "string" && names(val));

  const constraints: SketchConstraint[] = [];
  let dropped = 0;
  for (const k of cons) {
    if (!mentions(k)) { constraints.push(k); continue; }
    const next = remap(k);
    if (next) constraints.push(next);
    else dropped++;
  }
  constraints.push(...keep);
  const points: Record<number, { e: string; p: number }> = {};
  for (const { p } of dimRefPoints(e)) {
    const q = point(shape, p);
    if (q) points[p] = q;
  }
  return {
    entities: ents.flatMap((o, i) => (i === idx ? made : [o])),
    constraints,
    sides,
    outline,
    helpers,
    holds: keep,
    dropped,
    points,
  };
}

/** `l` cut back to `to` at its corner end, the end that is not being kept.
 *  `keepStart` says which end that is.
 *
 *  Moved in place, never rebuilt as kept-end → `to`. Constraints name a line's
 *  ends by INDEX (0 = x1/y1), so reversing a line that started at the corner
 *  handed every coincident and dimension on it the other end: a join at the
 *  far corner then dragged the far end onto the fillet. */
function cutBack(l: LineE, keepStart: boolean, to: THREE.Vector2): LineE {
  return keepStart ? { ...l, x2: to.x, y2: to.y } : { ...l, x1: to.x, y1: to.y };
}

/** The constraints after a corner operation (Fillet, Chamfer) on lines `a`
 *  and `b`, for the corner it cut away.
 *
 *  Those operations keep both line ids and move both corner ends off the
 *  corner on purpose: there is no corner afterwards. A coincident that joined
 *  the two corner ends (every snapped corner has one, and so does the closing
 *  corner of every line chain) then names a point that is not there, and the
 *  next solve pulls the lines back onto it: the profile folded up, or never
 *  solved again. So that join goes with the corner, which is what happened
 *  before snaps emitted joins. Joins on the ends the operation did not move,
 *  the far corners, stay; cutBack is what keeps their indices right.
 *
 *  A Coincident that held the corner to some OTHER point (the origin, another
 *  curve's end) is kept as that point On both lines, which is exactly where
 *  the corner was, and holds it the same two ways. Dropped with the corner, as
 *  it used to be, a rectangle anchored on the origin by that corner came loose
 *  without a word.
 *
 *  An exploded polygon's own corner On its ring (in `quiet`) is kept through
 *  a construction point at the corner, On both lines and On the ring, the way
 *  the rectangle's centre is held (explodeCompound). Dropped with the corner,
 *  it left five corners on the ring and the polygon's inner circle free:
 *  resizing the ring then made it irregular. The point comes back in `points`
 *  for the caller to add.
 *
 *  What cannot be kept is counted, for the caller to say so, except for the
 *  constraints in `quiet` (an explode's own, which the user never made):
 *    lost     a point held On a curve by the moved corner end itself: on the
 *             new tangent point it would bend the fillet, so it goes (one on a
 *             cut-back LINE stays, since the line's carrier did not move)
 *    shifted  a dimension that measured to the corner, or the length of a line
 *             that is now shorter, and so reads another value than it holds:
 *             the next solve moves the shape to give it back
 *  Whether a fillet should carry a corner's constraints onto a construction
 *  point at the old corner instead, so a dimension keeps measuring to it, is a
 *  design question this does not answer; it only names the dimension. */
export function cornerJoins(
  constraints: SketchConstraint[],
  before: readonly ResolvedEntity[],
  after: readonly ResolvedEntity[],
  a: string,
  b: string,
  quiet: ReadonlySet<SketchConstraint> = new Set(),
): { constraints: SketchConstraint[]; points: ResolvedEntity[]; lost: number; shifted: number } {
  const was = new Map(before.map((e) => [e.id, e]));
  const now = new Map(after.map((e) => [e.id, e]));
  const moved = (id: string, p: number) => {
    const e0 = was.get(id), e1 = now.get(id);
    const p0 = e0 && refPoint(e0, p), p1 = e1 && refPoint(e1, p);
    return !!p0 && !!p1 && coincKey(p0.x, p0.y) !== coincKey(p1.x, p1.y);
  };
  const out: SketchConstraint[] = [];
  const points: ResolvedEntity[] = [];
  const holds = (e: string, p: number, curve: string) =>
    [...constraints, ...out].some((k) => k.type === "pointOn" && k.e === e && k.p === p && k.curve === curve);
  let lost = 0, shifted = 0;
  for (const c of constraints) {
    if (c.type === "coincident") {
      const m1 = moved(c.e1, c.p1), m2 = moved(c.e2, c.p2);
      if (!m1 && !m2) { out.push(c); continue; }
      const e = m1 ? c.e2 : c.e1, p = m1 ? c.p2 : c.p1;
      // both ends moved, or the other end is on one of the two lines: the
      // corner's own join, gone with the corner
      if ((m1 && m2) || e === a || e === b) continue;
      for (const curve of [a, b]) if (!holds(e, p, curve)) out.push({ type: "pointOn", e, p, curve });
      continue;
    }
    if (c.type === "pointOn" && moved(c.e, c.p)) {
      const e0 = was.get(c.e);
      const corner = e0 && refPoint(e0, c.p);
      if (quiet.has(c) && corner && c.curve !== a && c.curve !== b) {
        const id = newEntityId();
        points.push({ type: "point", id, x: corner.x, y: corner.y, construction: true });
        out.push(
          { type: "pointOn", e: id, p: 0, curve: a },
          { type: "pointOn", e: id, p: 0, curve: b },
          { type: "pointOn", e: id, p: 0, curve: c.curve },
        );
        continue;
      }
      if (!quiet.has(c)) lost++;
      continue;
    }
    if (!isDriven(c)) {
      const m0 = measureDim(c, was), m1 = measureDim(c, now);
      if (m0 !== null && m1 !== null && Math.abs(m0 - m1) > 1e-6) shifted++;
    }
    out.push(c);
  }
  return { constraints: out, points, lost, shifted };
}

/** The corner-On-ring holds of every polygon exploded into lines (modify.ts
 *  explodeCompound): a line's end On a construction circle that is concentric
 *  with a second construction circle the same line is tangent to. Once the
 *  explode is done they are ordinary constraints, so they are known by that
 *  shape, which is what lets a second Fillet or Chamfer on the polygon keep
 *  its corner as the first one does (cornerJoins' `quiet`). */
export function polygonRingHolds(constraints: readonly SketchConstraint[], ents: readonly ResolvedEntity[]): Set<SketchConstraint> {
  const guide = new Set(ents.filter((e) => e.type === "circle" && e.construction).map((e) => e.id));
  const inners = new Map<string, string[]>();
  const touches = new Set<string>();
  for (const k of constraints) {
    if (k.type === "concentric" && guide.has(k.c1) && guide.has(k.c2)) {
      inners.set(k.c1, [...(inners.get(k.c1) ?? []), k.c2]);
      inners.set(k.c2, [...(inners.get(k.c2) ?? []), k.c1]);
    }
    if (k.type === "tangent2") touches.add(`${k.a}|${k.b}`).add(`${k.b}|${k.a}`);
  }
  return new Set(constraints.filter((k) =>
    k.type === "pointOn" && (inners.get(k.curve) ?? []).some((inner) => touches.has(`${k.e}|${inner}`))));
}

/** What a length dimension measures on `ents` right now, or null for one this
 *  does not measure. Only the kinds a corner operation can change: a line's
 *  length, and a distance with a point at one end. */
function measureDim(c: SketchConstraint, ents: ReadonlyMap<string, ResolvedEntity>): number | null {
  const pt = (id: string, p: number) => { const e = ents.get(id); return e ? refPoint(e, p) : null; };
  const seg = (id: string) => lineOperand(ents as Map<string, ResolvedEntity>, id);
  switch (c.type) {
    case "distance": { const l = seg(c.line); return l ? Math.hypot(l.x2 - l.x1, l.y2 - l.y1) : null; }
    case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY": {
      const p = pt(c.e1, c.p1), q = pt(c.e2, c.p2);
      if (!p || !q) return null;
      return c.type === "p2pDistanceX" ? q.x - p.x : c.type === "p2pDistanceY" ? q.y - p.y : p.distanceTo(q);
    }
    case "p2lDistance": {
      const p = pt(c.e, c.p), l = seg(c.line);
      if (!p || !l) return null;
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
      return len > 1e-12 ? Math.abs((p.x - l.x1) * (l.y2 - l.y1) - (p.y - l.y1) * (l.x2 - l.x1)) / len : null;
    }
    case "p2cDistance": {
      const p = pt(c.e, c.p), r = ents.get(c.circle), cr = r && asRound(r);
      return p && cr ? Math.abs(Math.hypot(p.x - cr.x, p.y - cr.y) - cr.r) : null;
    }
    default: return null;
  }
}

/** Does `c` tie geometry in `moving` (entity ids; a rectangle side `R~k`
 *  counts as R) to geometry outside it, in a way a rotation about `pivot`
 *  would break? Then the settle after the rotation pulls the turned geometry
 *  part of the way back, and the angle the user typed is not the angle they
 *  get (decision C8: refuse, and say so).
 *
 *  Not a tie: a constraint wholly inside or wholly outside; a reference
 *  dimension, which holds nothing; Equal, since a rotation keeps every
 *  length; and a Coincident or a point On a curve whose point sits on the
 *  pivot, which the rotation leaves where it is. */
export function rotationTie(
  c: SketchConstraint,
  ents: readonly ResolvedEntity[],
  moving: ReadonlySet<string>,
  pivot: { x: number; y: number },
): boolean {
  const base = (id: string) => { const k = id.indexOf("~"); return k > 0 ? id.slice(0, k) : id; };
  const ops = c.type === "offset"
    ? c.pairs.flatMap((pr) => [pr.src, pr.cpy])
    : Object.entries(c).flatMap(([f, val]) => (f !== "type" && f !== "id" && typeof val === "string" ? [val] : []));
  const inside = ops.filter((id) => moving.has(base(id))).length;
  if (inside === 0 || inside === ops.length) return false;
  if (isDriven(c) || c.type === "equal") return false;
  if (c.type === "coincident" || c.type === "pointOn") {
    const [id, p] = c.type === "coincident" ? [c.e1, c.p1] : [c.e, c.p];
    const byId = new Map(ents.map((e) => [e.id, e]));
    const side = id.includes("~") ? lineOperand(byId, id) : null;
    const e = byId.get(id);
    const q = side ? (p === 1 ? v(side.x2, side.y2) : v(side.x1, side.y1)) : e ? refPoint(e, p) : null;
    return !(q && Math.hypot(q.x - pivot.x, q.y - pivot.y) < 1e-6);
  }
  return true;
}

/** Does `c` tie geometry in `moving` (entity ids; a side `R~k` counts as R)
 *  to geometry outside it, in a way a MOVE by `d` would break? The settle
 *  after the move would then pull the moved geometry part of the way back, or
 *  stretch it, which is how a rectangle with a corner on the origin came out
 *  of a Move resized instead of moved (a237de6b, decision C8: refuse, and say
 *  so).
 *
 *  Not a tie: what rotationTie lets through, since a move keeps every length
 *  as a rotation does; and anything about DIRECTION alone (Horizontal,
 *  Vertical, Parallel, Perpendicular, an angle), which a move keeps too. Nor a
 *  move in a direction the constraint leaves free: along the line of a point
 *  On a line, of two Collinear lines, of a distance from a point or a rim to a
 *  line, or of a line touching a round; sideways for a vertical distance, and
 *  up or down for a horizontal one. */
export function translationTie(
  c: SketchConstraint,
  ents: readonly ResolvedEntity[],
  moving: ReadonlySet<string>,
  d: { x: number; y: number },
): boolean {
  if (!rotationTie(c, ents, moving, { x: Number.NaN, y: Number.NaN })) return false;
  const dl = Math.hypot(d.x, d.y);
  if (!(dl > 0)) return false; // no move breaks nothing
  // the move runs along (dx, dy), to within a thousandth of a degree
  const along = (dx: number, dy: number) => {
    const len = Math.hypot(dx, dy);
    return len > 0 && Math.abs(dx * d.y - dy * d.x) / (len * dl) <= 2e-5;
  };
  /** the move runs along line operand `id` (a circle or an arc has no along) */
  const alongLine = (id: string) => {
    const seg = lineOperand(new Map(ents.map((e) => [e.id, e])), id);
    return !!seg && along(seg.x2 - seg.x1, seg.y2 - seg.y1);
  };
  switch (c.type) {
    // a spline's tangency holds a direction only; the joint is its coincident's
    case "horizontal": case "vertical": case "parallel": case "perpendicular": case "angle":
    case "splineTangent":
      return false;
    case "pointOn": return !alongLine(c.curve);
    case "collinear": return !alongLine(c.l1);
    case "p2lDistance": case "c2lDistance": return !alongLine(c.line);
    case "tangent": return !alongLine(c.line);
    case "tangent2": return !(alongLine(c.a) || alongLine(c.b));
    case "p2pDistanceX": return !along(0, 1);
    case "p2pDistanceY": return !along(1, 0);
    default: return true;
  }
}

/**
 * Fillet the corner where two line entities meet: shorten both to the tangent
 * points and insert a tangent arc of the given radius. Returns null if it can't.
 *
 * The `constraints` half is what makes the radius SURVIVE. An arc carries no
 * automatic badge dimension (unlike a circle, which always shows a diameter), so
 * a radius label renders only from an explicit `radius` constraint — without one
 * the number the user typed existed nowhere afterwards: not on screen, not
 * editable, and free for the next solve to change (GH report 41dc3246). The two
 * tangencies go with it because they are what the fillet MEANS; with them the
 * arc slides along the sides when one is dragged instead of being resized by it.
 * The caller decides whether they land — see sketchMode's trial machinery.
 */
export function filletCorner(
  ents: ResolvedEntity[],
  iA: number,
  iB: number,
  radius: number,
): { entities: ResolvedEntity[]; constraints: SketchConstraint[] } | null {
  const A = ents[iA], B = ents[iB];
  if (A?.type !== "line" || B?.type !== "line") return null;
  const a1 = v(A.x1, A.y1), a2 = v(A.x2, A.y2);
  const b1 = v(B.x1, B.y1), b2 = v(B.x2, B.y2);
  const corner = lineIntersect(a1, a2, b1, b2);
  if (!corner) return null; // parallel

  // far endpoints (the ends to keep) and direction unit vectors from the corner
  const aFar = a1.distanceTo(corner) >= a2.distanceTo(corner) ? a1 : a2;
  const bFar = b1.distanceTo(corner) >= b2.distanceTo(corner) ? b1 : b2;
  const d1 = aFar.clone().sub(corner).normalize();
  const d2 = bFar.clone().sub(corner).normalize();
  const cosT = Math.max(-1, Math.min(1, d1.dot(d2)));
  const theta = Math.acos(cosT);
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return null; // collinear

  const tan = radius / Math.tan(theta / 2); // tangent length along each line
  if (tan > aFar.distanceTo(corner) || tan > bFar.distanceTo(corner)) return null; // too big

  const T1 = corner.clone().add(d1.clone().multiplyScalar(tan));
  const T2 = corner.clone().add(d2.clone().multiplyScalar(tan));
  const bis = d1.clone().add(d2).normalize();
  const center = corner.clone().add(bis.multiplyScalar(radius / Math.sin(theta / 2)));
  const through = center.clone().add(corner.clone().sub(center).normalize().multiplyScalar(radius));

  // A and B survive (just shortened) → keep their ids + constraints; the arc is new
  const newA = cutBack(A, aFar === a1, T1);
  const newB = cutBack(B, bFar === b1, T2);
  const arc: ResolvedEntity = { type: "arc", id: newEntityId(), x1: T1.x, y1: T1.y, x2: T2.x, y2: T2.y, mx: through.x, my: through.y };

  const out = ents.map((o, i) => (i === iA ? newA : i === iB ? newB : o));
  out[iB] = newB;
  out.push(arc);
  return {
    entities: out,
    constraints: [
      { type: "tangent2", a: newA.id, b: arc.id },
      { type: "tangent2", a: newB.id, b: arc.id },
      { type: "radius", e: arc.id, value: radius },
    ],
  };
}

/** Signed offset of a cursor position from an entity, in exactly the terms
 *  offsetEntity/offsetChain take as `dist`: magnitude = distance to the curve,
 *  sign = which side. Positive means OUTWARD for a closed shape
 *  (circle/arc/rectangle/polygon/slot) and to the LEFT of the stored direction
 *  (x1,y1)→(x2,y2) for a line or spline.
 *
 *  This is what lets the offset tool put the preview under the cursor: the tool
 *  measures with this, and both offset functions consume the same convention
 *  (offsetChain normalizes its arbitrary walk direction to match). Null for
 *  entities that can't be offset. */
export function signedOffsetAt(e: ResolvedEntity, p: THREE.Vector2): number | null {
  const leftOf = (a: THREE.Vector2, b: THREE.Vector2) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return 0;
    return ((p.x - a.x) * -dy + (p.y - a.y) * dx) / len;
  };
  if (e.type === "line") return leftOf(v(e.x1, e.y1), v(e.x2, e.y2));
  if (e.type === "circle") return v(e.x, e.y).distanceTo(p) - e.radius;
  if (e.type === "arc") {
    const g = arcGeom(e);
    return g ? g.C.distanceTo(p) - g.R : null;
  }
  if (e.type === "rectangle") {
    // exact signed distance to an axis-aligned box: outside = the corner/edge
    // distance, inside = the (negative) distance to the nearest edge
    const dx = Math.abs(p.x - e.x) - e.width / 2;
    const dy = Math.abs(p.y - e.y) - e.height / 2;
    return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
  }
  if (e.type === "polygon") {
    // convex polygon: the largest signed distance to any edge's outward line is
    // the exact SDF (negative inside)
    const pts = polygonPoints(e.x, e.y, e.radius, e.sides, (e.angle * Math.PI) / 180);
    let best = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      // polygonPoints runs CCW, so the OUTWARD normal is the right normal
      best = Math.max(best, -leftOf(a, b));
    }
    return Number.isFinite(best) ? best : null;
  }
  if (e.type === "slot") return distToSeg(v(e.x1, e.y1), v(e.x2, e.y2), p) - e.width / 2;
  if (e.type === "spline") {
    // nearest segment decides both distance and side (same left-normal
    // convention offsetEntity pushes the points along)
    let best: number | null = null;
    const n = e.points.length;
    // a closed spline's last span runs back to its first point
    const spans = e.closed && n > 2 ? n : n - 1;
    for (let i = 0; i < spans; i++) {
      const q = e.points[(i + 1) % n]!;
      const a = v(e.points[i]!.x, e.points[i]!.y), b = v(q.x, q.y);
      const d = distToSeg(a, b, p);
      if (best === null || d < Math.abs(best)) best = Math.sign(leftOf(a, b) || 1) * d;
    }
    return best;
  }
  return null;
}

/** What an offset produced.
 *
 *  `pairs` are the source→copy operands the associative `offset` constraint will
 *  govern (rectangle and polygon operands are SIDES, "<shapeId>~<k>" — see
 *  types.ts). `linked: false` means the geometry is correct but free-floating:
 *  there is no constraint that could tie a slot or a spline copy to its source,
 *  and the caller says so once rather than implying a link that doesn't exist. */
export type OffsetResult = {
  entities: ResolvedEntity[];
  pairs: { src: string; cpy: string }[];
  linked: boolean;
};

type RectE = Extract<ResolvedEntity, { type: "rectangle" }>;
type PolyE = Extract<ResolvedEntity, { type: "polygon" }>;

/** A rectangle's size once every side moves out by `dist` (in, when negative)
 *  about the same centre, or null when nothing is left of it. */
function offsetRectSize(e: RectE, dist: number): { width: number; height: number } | null {
  const width = e.width + 2 * dist, height = e.height + 2 * dist;
  return width > 1e-3 && height > 1e-3 ? { width, height } : null;
}

/** The same for a polygon's radius. Fusion keeps a polygon a polygon. `radius`
 *  is the CIRCUMradius while the EDGES lie on the inscribed circle
 *  (r·cos(π/n)), so moving the edges out by `dist` moves the circumradius by
 *  dist / cos(π/n). */
function offsetPolygonRadius(e: PolyE, dist: number): number | null {
  const n = Math.max(3, Math.round(e.sides));
  const r = e.radius + dist / Math.cos(Math.PI / n);
  return r > 1e-3 ? r : null;
}

/** The two shapes `c` ties side for side, when it is an Offset of a whole
 *  rectangle or polygon onto another of the same kind: every pair names side
 *  k of the one and side k of the other, which is what Offset makes of one.
 *  Null for any other link (lines, a trimmed or exploded copy), which
 *  followOffsets carries line by line instead. */
function wholeShapeOffset(
  c: SketchConstraint,
  get: (id: string) => ResolvedEntity | undefined,
): { src: ResolvedEntity; cpy: ResolvedEntity; value: number } | null {
  if (c.type !== "offset" || !c.pairs.length) return null;
  const split = (s: string) => {
    const cut = s.indexOf("~");
    return cut > 0 ? { shape: s.slice(0, cut), side: s.slice(cut + 1) } : null;
  };
  const first = c.pairs[0]!;
  const srcId = split(first.src)?.shape, cpyId = split(first.cpy)?.shape;
  for (const pr of c.pairs) {
    const a = split(pr.src), b = split(pr.cpy);
    if (!a || !b || a.shape !== srcId || b.shape !== cpyId || a.side !== b.side) return null;
  }
  const src = srcId === undefined ? undefined : get(srcId), cpy = cpyId === undefined ? undefined : get(cpyId);
  if (!src || !cpy || src.id === cpy.id) return null;
  const same = (src.type === "rectangle" && cpy.type === "rectangle") || (src.type === "polygon" && cpy.type === "polygon");
  return same ? { src, cpy, value: c.value } : null;
}

/** `onto` re-made as `from` with every side moved out by `dist`: its own id,
 *  construction flag and label placements kept. Null when nothing is left. */
function reshapeOnto(from: ResolvedEntity, dist: number, onto: ResolvedEntity): ResolvedEntity | null {
  if (from.type === "rectangle" && onto.type === "rectangle") {
    const s = offsetRectSize(from, dist);
    return s && { ...onto, x: from.x, y: from.y, ...s };
  }
  if (from.type === "polygon" && onto.type === "polygon") {
    const r = offsetPolygonRadius(from, dist);
    return r === null ? null : { ...onto, x: from.x, y: from.y, radius: r, sides: from.sides, angle: from.angle };
  }
  return null;
}

type LineSeg = { x1: number; y1: number; x2: number; y2: number };

/** Where a point beside the segment `s0` goes when the segment becomes `s1`:
 *  it keeps how far out from the segment it sits and how far along from the
 *  segment's nearer end, so the corner two sides of an offset share lands on
 *  the same new spot whichever side carries it. */
function sideCarry(s0: LineSeg, s1: LineSeg): (x: number, y: number) => THREE.Vector2 {
  const frame = (s: LineSeg) => {
    const a = v(s.x1, s.y1), b = v(s.x2, s.y2);
    const len = a.distanceTo(b);
    const u = len > 1e-12 ? b.clone().sub(a).divideScalar(len) : v(1, 0);
    return { a, b, u, n: v(-u.y, u.x) };
  };
  const f0 = frame(s0), f1 = frame(s1);
  return (x, y) => {
    const q = v(x, y);
    const atB = q.distanceTo(f0.b) < q.distanceTo(f0.a);
    const o = q.sub(atB ? f0.b : f0.a);
    return (atB ? f1.b : f1.a).clone().addScaledVector(f1.u, o.dot(f0.u)).addScaledVector(f1.n, o.dot(f0.n));
  };
}

/** `e` with each of its ends that shared a spot with a carried line's end,
 *  or sat On a carried line (`moved`: that spot's coincKey, then where it
 *  went), taken along. The solver joins the ends that share a spot, with no
 *  constraint saying so, so a fillet's arc or a chamfer's line left behind is
 *  no longer joined to the sides it rounds: the solve then pulled the source
 *  back to the copy instead. A point On a side left behind (the corner a
 *  fillet cut away, kept On both sides) had the solve turn the source 3
 *  degrees and move it 1 mm. An arc's middle moves by the mean of its ends'
 *  moves, which is the whole arc moved when both ends moved alike. */
function takenAlong(e: ResolvedEntity, moved: ReadonlyMap<string, THREE.Vector2>): ResolvedEntity {
  const to = (x: number, y: number) => moved.get(coincKey(x, y));
  if (e.type === "point") {
    const a = to(e.x, e.y);
    return a ? { ...e, x: a.x, y: a.y } : e;
  }
  if (e.type !== "line" && e.type !== "arc") return e;
  const a = to(e.x1, e.y1), b = to(e.x2, e.y2);
  if (!a && !b) return e;
  const ends = { x1: a?.x ?? e.x1, y1: a?.y ?? e.y1, x2: b?.x ?? e.x2, y2: b?.y ?? e.y2 };
  if (e.type === "line") return { ...e, ...ends };
  const dx = (ends.x1 - e.x1 + ends.x2 - e.x2) / 2, dy = (ends.y1 - e.y1 + ends.y2 - e.y2) / 2;
  return { ...e, ...ends, mx: e.mx + dx, my: e.my + dy };
}

export type FollowRefusal = "collapses" | "sides";

/** Why followOffsets refused, in words: for a number typed, which is not
 *  taken, or for one a parameter set, which the shape has already taken. */
export function followRefusal(why: FollowRefusal, byParameter = false): string {
  if (byParameter) return t(why === "sides" ? "sketch.offset.paramSides" : "sketch.offset.paramCollapses");
  return t(why === "sides" ? "sketch.offset.followSides" : "sketch.offset.followCollapses");
}

/** After an edit that wrote a rectangle's or polygon's own numbers straight
 *  into it (a typed width, height or radius, a polygon's side count or turn),
 *  every rectangle or polygon an Offset ties to it side for side, re-made from
 *  it, and on along a chain of offsets. `ents` holds the edited shape `id`
 *  as edited, `was` the shape before the edit; `cons` are as they were
 *  before the edit.
 *
 *  Those edits do not go through the solver, and a solve afterwards cannot
 *  repair them. A rectangle's offset is an UNSIGNED distance per side, so a
 *  source widened past its copy already satisfies every one of them with the
 *  copy inside it: 40 wide with a 5 mm copy, typed 60, left the copy 50 wide
 *  inside the source and every later solve kept it there. A polygon's is
 *  signed, but the solve holds the first of the two shapes still: a radius
 *  typed on the copy went straight back to what it was.
 *
 *  A partner an Explode left as lines (a Fillet or a Chamfer on its corner
 *  explodes it too) cannot be re-made as a shape, and its distances are
 *  unsigned the same way: a hexagon's filleted 5 mm copy, its source typed
 *  from radius 10 to 25, sat 5 mm INSIDE the source with nothing amber. So
 *  each line tied to a side of the edited shape is carried with that side
 *  (sideCarry), and on along offsets of those lines, and what ended where
 *  one of them ended, or is held On one, goes too (takenAlong): the solve
 *  afterwards finds them on the right side with nothing left to close. A polygon given a new side
 *  count has other sides now, and its lines are left to the solve.
 *
 *  `resided` are the polygons whose side count followed, with the count they
 *  had, for the caller to re-aim what names their sides (rebindPolygonSides)
 *  after it has re-aimed the edited one's. `refused` says why the edit
 *  cannot be taken (followRefusal says it in words): a shape would be left
 *  with nothing (an inward copy of a source made too small for it), or a
 *  polygon whose offset is lines now was given a new side count (its six
 *  lines were bent round eight sides, nothing amber). */
export function followOffsets(
  ents: readonly ResolvedEntity[],
  cons: readonly SketchConstraint[],
  id: string,
  was: ResolvedEntity,
): { entities: ResolvedEntity[]; resided: { id: string; sides: number }[] } | { refused: FollowRefusal } {
  const entities = [...ents];
  const at = new Map(entities.map((e, i) => [e.id, i]));
  const get = (x: string) => { const i = at.get(x); return i === undefined ? undefined : entities[i]; };
  /** each entity this moved, as it was before */
  const before = new Map<string, ResolvedEntity>([[id, was]]);
  const owner = (s: string) => (s.includes("~") ? s.slice(0, s.indexOf("~")) : s);
  /** the carried lines' ends: where each spot went, the first line to move
   *  it deciding, so two sides that met at a corner still meet */
  const moved = new Map<string, THREE.Vector2>();
  const carry = (x: number, y: number, to: { x: number; y: number }) => {
    const k = coincKey(x, y);
    if (!moved.has(k)) moved.set(k, v(to.x, to.y));
    return moved.get(k)!;
  };
  /** how each carried line moved, for what is held On it */
  const carriers = new Map<string, (x: number, y: number) => THREE.Vector2>();
  const resided: { id: string; sides: number }[] = [];
  const done = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const fromId = queue.shift()!;
    const from = get(fromId), old = before.get(fromId);
    if (!from || !old) continue;
    const newSides = from.type === "polygon" && old.type === "polygon" && Math.round(from.sides) !== Math.round(old.sides);
    for (const c of cons) {
      if (c.type !== "offset") continue;
      const link = wholeShapeOffset(c, get);
      if (link) {
        if (link.src.id !== from.id && link.cpy.id !== from.id) continue;
        const fromSrc = link.src.id === from.id;
        const other = fromSrc ? link.cpy : link.src;
        if (done.has(other.id)) continue;
        const made = reshapeOnto(from, fromSrc ? link.value : -link.value, other);
        if (!made) return { refused: "collapses" };
        if (other.type === "polygon" && made.type === "polygon" && Math.round(made.sides) !== Math.round(other.sides)) {
          resided.push({ id: other.id, sides: other.sides });
        }
        entities[at.get(other.id)!] = made;
        before.set(other.id, other);
        done.add(other.id);
        queue.push(other.id);
        continue;
      }
      for (const pr of c.pairs) {
        const mine = owner(pr.src) === from.id ? pr.src : owner(pr.cpy) === from.id ? pr.cpy : null;
        if (!mine) continue;
        if (newSides) return { refused: "sides" };
        const line = get(mine === pr.src ? pr.cpy : pr.src); // a side ("Q~k") names no entity
        if (line?.type !== "line" || done.has(line.id)) continue;
        const s0 = lineOperand(new Map([[old.id, old]]), mine), s1 = lineOperand(new Map([[from.id, from]]), mine);
        if (!s0 || !s1) continue;
        const go = sideCarry(s0, s1);
        const a = carry(line.x1, line.y1, go(line.x1, line.y1)), b = carry(line.x2, line.y2, go(line.x2, line.y2));
        entities[at.get(line.id)!] = { ...line, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        carriers.set(line.id, go);
        before.set(line.id, line);
        done.add(line.id);
        queue.push(line.id);
      }
    }
  }
  // a point held On a carried line goes with it
  for (const c of cons) {
    if (c.type !== "pointOn" || done.has(c.e)) continue;
    const go = carriers.get(c.curve), e = get(c.e);
    const q = go && e ? refPoint(e, c.p) : null;
    if (go && q) carry(q.x, q.y, go(q.x, q.y));
  }
  if (moved.size) {
    entities.forEach((e, i) => { if (!done.has(e.id) && !isOriginGeometry(e.id)) entities[i] = takenAlong(e, moved); });
  }
  return { entities, resided };
}

/** Offset a SINGLE entity by `dist` (closed shapes grow with positive dist;
 *  lines shift to their left normal). Returns null only for entity types that
 *  cannot be offset at all (text, point) — the caller toasts a refusal, because
 *  a silent no-op after the user has typed a distance reads as a broken tool. */
export function offsetEntity(
  ents: ResolvedEntity[],
  index: number,
  dist: number,
): OffsetResult | null {
  const e = ents[index];
  if (!e) return null;
  let copy: ResolvedEntity | null = null;
  let pairs: { src: string; cpy: string }[] = [];
  let linked = true;
  const id = newEntityId();
  if (e.type === "rectangle") {
    const s = offsetRectSize(e, dist);
    if (s) {
      copy = { type: "rectangle", id, width: s.width, height: s.height, x: e.x, y: e.y, ...constr(e) };
      // Both rectangles are axis-aligned about a shared centre, so edge k of the
      // copy IS edge k of the source (rectCorners' CCW order) — the pairing is
      // positional. Four edge pairs, one distance each, is exactly a
      // rectangle's 4 DOF.
      pairs = [0, 1, 2, 3].map((k) => ({ src: `${e.id}~${k}`, cpy: `${id}~${k}` }));
    }
  } else if (e.type === "circle") {
    const r = e.radius + dist;
    if (r > 1e-3) {
      copy = { type: "circle", id, radius: r, x: e.x, y: e.y, ...constr(e) };
      pairs = [{ src: e.id, cpy: id }];
    }
  } else if (e.type === "line") {
    const dir = v(e.x2 - e.x1, e.y2 - e.y1).normalize();
    const n = v(-dir.y, dir.x).multiplyScalar(dist); // left normal
    copy = { type: "line", id, x1: e.x1 + n.x, y1: e.y1 + n.y, x2: e.x2 + n.x, y2: e.y2 + n.y, ...constr(e) };
    pairs = [{ src: e.id, cpy: id }];
  } else if (e.type === "arc") {
    // concentric offset: positive dist grows the radius (away from the center)
    const g = arcGeom(e);
    if (g && g.R + dist > 1e-3) {
      copy = arcFromSpan(g.C, g.R + dist, g.aStart, g.delta, e);
      pairs = [{ src: e.id, cpy: copy.id }];
    }
  } else if (e.type === "spline") {
    // push each point along its local normal — the perpendicular to the chord
    // through its neighbours, so an interior corner offsets to the miter
    // direction and the ends use their own single segment. A closed spline has
    // no ends: its neighbours wrap round.
    const pts = e.points;
    const n = pts.length;
    if (n >= 2) {
      copy = {
        type: "spline", id, ...constr(e), ...splineFlags(e),
        points: pts.map((p, i) => {
          const prev = pts[i - 1] ?? (e.closed ? pts[n - 1]! : p), next = pts[i + 1] ?? (e.closed ? pts[0]! : p);
          const dx = next.x - prev.x, dy = next.y - prev.y;
          const len = Math.hypot(dx, dy) || 1;
          return { x: p.x + (-dy / len) * dist, y: p.y + (dx / len) * dist };
        }),
      };
      linked = false;
    }
  } else if (e.type === "polygon") {
    const r = offsetPolygonRadius(e, dist);
    if (r !== null) {
      copy = { type: "polygon", id, x: e.x, y: e.y, radius: r, sides: e.sides, angle: e.angle, ...constr(e) };
      // The same positional pairing (polygonPoints' order: both share a centre
      // and a turn). The solver holds the copy as one shape rather than side
      // by side (sketchSolve's offset), so the pairs say which sides go
      // together; a side count change re-aims them (rebindPolygonSides).
      pairs = Array.from({ length: Math.max(3, Math.round(e.sides)) }, (_, k) => ({ src: `${e.id}~${k}`, cpy: `${id}~${k}` }));
    }
  } else if (e.type === "slot") {
    // `width` is the OVERALL width (the caps have radius w/2), so pushing the
    // boundary out by `dist` widens it by 2·dist; the axis is unchanged.
    const w = e.width + 2 * dist;
    if (w > 1e-3) {
      copy = { type: "slot", id, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, width: w, ...constr(e) };
      linked = false;
    }
  }
  if (!copy) return null;
  return { entities: [...ents, copy], pairs, linked };
}

type LineE = Extract<ResolvedEntity, { type: "line" }>;
type ArcE = Extract<ResolvedEntity, { type: "arc" }>;
type ChainE = LineE | ArcE;

/** A member of the chain being offset, in traversal order. `ccw` is meaningful
 *  for arcs only: whether this traversal runs along the arc's CCW sweep. */
type Member = { i: number; e: ChainE; from: THREE.Vector2; to: THREE.Vector2; ccw: boolean };

/** An offset member. Lines carry their two endpoints; arcs carry the (unchanged)
 *  centre plus the offset radius, and their endpoints ride on that circle. */
type Off =
  | { kind: "line"; src: string; a: THREE.Vector2; b: THREE.Vector2; dir: THREE.Vector2 }
  | { kind: "arc"; src: string; a: THREE.Vector2; b: THREE.Vector2; C: THREE.Vector2; R: number; ccw: boolean };

/** How far a miter may travel from the original corner, as a multiple of |dist|.
 *  Two nearly-collinear offset lines intersect arbitrarily far away, which used
 *  to fling a spike across the sketch; past this limit the corner is left butted
 *  instead. 4 is the common CAD/stroke default (~29° between segments). */
const MITER_LIMIT = 4;

/** Build an arc entity from its centre, radius, two endpoints and sweep
 *  direction. A CW sweep is emitted as the equivalent CCW arc from the other
 *  end — an arc entity is three points, so it carries no direction of its own. */
function arcFromEnds(
  C: THREE.Vector2, R: number, a: THREE.Vector2, b: THREE.Vector2, ccw: boolean,
  src: { construction?: boolean },
): ResolvedEntity | null {
  const aS = Math.atan2(a.y - C.y, a.x - C.x);
  const aE = Math.atan2(b.y - C.y, b.x - C.x);
  const delta = ccw ? ccwDelta(aS, aE) : ccwDelta(aE, aS);
  if (delta < 1e-9) return null; // collapsed to nothing
  return ccw ? arcFromSpan(C, R, aS, delta, src) : arcFromSpan(C, R, aE, delta, src);
}

/** The connected curves (lines and arcs) a chain offset from `index` would
 *  take, plus the endpoint map offsetChain orders them by. Or, when the walk
 *  reaches a vertex that three or more of those curves share, that vertex: it
 *  is not a simple chain, and where it stopped is what the caller tells the
 *  user. Null when the pick is not a line or an arc.
 *
 *  Construction geometry takes part only when the pick is itself
 *  construction. Construction lines drawn out to a profile's corners are not
 *  part of its contour, and counting them turned every corner they reached
 *  into a three-curve junction, so the profile stopped being a chain at all
 *  (field report 356b2693: "Chain select no longer works on offset"). */
function chainComponent(
  ents: ResolvedEntity[],
  index: number,
): { comp: Set<number>; touch: Map<string, number[]> } | { junction: THREE.Vector2 } | null {
  const withConstruction = !!ents[index]?.construction;
  const isChain = (e: ResolvedEntity | undefined): e is ChainE =>
    (e?.type === "line" || e?.type === "arc") && (withConstruction || !e.construction);
  if (!isChain(ents[index])) return null;

  // endpoint key -> chain-entity indices touching it. coincKey is the solver's
  // canonical coincidence key, so "connected" here matches what the solver merges.
  const touch = new Map<string, number[]>();
  ents.forEach((e, i) => {
    if (!isChain(e)) return;
    for (const k of [coincKey(e.x1, e.y1), coincKey(e.x2, e.y2)]) {
      const arr = touch.get(k);
      if (arr) arr.push(i); else touch.set(k, [i]);
    }
  });

  // connected component containing `index`; stop at any junction (a shared
  // vertex touched by >2 curves) — not a simple chain
  const comp = new Set<number>();
  const stack = [index];
  while (stack.length) {
    const i = stack.pop();
    if (i === undefined || comp.has(i)) continue;
    const e = ents[i];
    if (!isChain(e)) continue;
    comp.add(i);
    for (const p of [v(e.x1, e.y1), v(e.x2, e.y2)]) {
      const arr = touch.get(coincKey(p.x, p.y));
      if (!arr) continue;
      if (arr.length > 2) return { junction: p };
      for (const j of arr) if (j !== i) stack.push(j);
    }
  }
  return { comp, touch };
}

/** Where Chain Selection stops for this pick: the vertex at which three or
 *  more curves meet, or null when there is no such vertex in its chain. */
export function offsetChainJunction(ents: ResolvedEntity[], index: number): THREE.Vector2 | null {
  const walk = chainComponent(ents, index);
  return walk && "junction" in walk ? walk.junction : null;
}

/**
 * Offset a connected chain of LINE and ARC entities as a unit, joining the
 * corners — the common "offset this profile in/out" case (polylines, a
 * rectangle drawn as 4 lines, and now filleted profiles, which are the shape
 * most real parts actually have).
 *
 * Returns null when the clicked entity isn't part of a simple chain (a lone
 * curve or a junction); the caller then falls back to single-entity offset.
 * `dist` sign picks the side: every member shifts to its LEFT relative to the
 * traversal direction, so on a CCW loop a positive dist moves inward.
 *
 * Arcs used to be skipped entirely here (only `line` entities entered the
 * adjacency map), so a filleted profile offset as loose, unjoined pieces.
 */
export function offsetChain(
  ents: ResolvedEntity[],
  index: number,
  dist: number,
): OffsetResult | null {
  const walk = chainComponent(ents, index);
  if (!walk || "junction" in walk) return null; // not a line/arc, or a junction
  const { comp, touch } = walk;
  if (comp.size < 2) return null; // a lone curve — caller handles it

  // pick a start: a free end for an open chain, else any member (closed loop)
  let start = -1, startKey = "";
  for (const i of comp) {
    const e = ents[i] as ChainE;
    if (touch.get(coincKey(e.x1, e.y1))?.length === 1) { start = i; startKey = coincKey(e.x1, e.y1); break; }
    if (touch.get(coincKey(e.x2, e.y2))?.length === 1) { start = i; startKey = coincKey(e.x2, e.y2); break; }
  }
  const closed = start === -1;
  if (closed) { start = comp.values().next().value as number; const s = ents[start] as ChainE; startKey = coincKey(s.x1, s.y1); }

  // walk the chain into an ordered, directed path
  const path: Member[] = [];
  const used = new Set<number>();
  let cur = start, curKey = startKey;
  while (cur !== -1 && !used.has(cur)) {
    used.add(cur);
    const e = ents[cur] as ChainE;
    const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
    const fromP1 = coincKey(p1.x, p1.y) === curKey;
    const from = fromP1 ? p1 : p2, to = fromP1 ? p2 : p1;
    // for an arc, does this traversal run along its CCW sweep? arcGeom's
    // aStart is the CCW start, so travelling from that endpoint is CCW.
    let ccw = true;
    if (e.type === "arc") {
      const g = arcGeom(e);
      if (!g) return null;
      const s = v(g.C.x + Math.cos(g.aStart) * g.R, g.C.y + Math.sin(g.aStart) * g.R);
      ccw = from.distanceTo(s) <= to.distanceTo(s);
    }
    path.push({ i: cur, e, from, to, ccw });
    const toKey = coincKey(to.x, to.y);
    const nxt = (touch.get(toKey) ?? []).find((j) => j !== cur && !used.has(j));
    cur = nxt ?? -1;
    curKey = toKey;
  }
  if (path.length < 2) return null;

  // Normalize the sign so that for the CHAIN it means exactly what it means for
  // the PICKED entity alone (offsetEntity's convention: left of a line's stored
  // direction, outward for an arc). The walk direction is arbitrary — it starts
  // from whichever free end it found — so without this the same cursor position
  // could offset the chain to either side depending on how the walk happened to
  // run. signedOffsetAt measures the cursor in offsetEntity's terms, and this is
  // what keeps the preview under the cursor.
  const picked = path.find((m) => m.i === index);
  if (picked) {
    const backwards = picked.from.distanceTo(v(picked.e.x1, picked.e.y1)) > 1e-9;
    if (picked.e.type === "line" ? backwards : picked.ccw) dist = -dist;
  }

  /** Offset one member to its left by `dist`. For an arc the left normal points
   *  at the centre when travelling CCW, so a CCW arc SHRINKS by dist and a CW
   *  arc grows — that is what keeps an arc coherent with the lines beside it.
   *  Null when the arc's radius would collapse. */
  const offsetOne = (m: Member): Off | null => {
    if (m.e.type === "line") {
      const dir = m.to.clone().sub(m.from).normalize();
      const n = v(-dir.y, dir.x).multiplyScalar(dist);
      return { kind: "line", src: m.e.id, a: m.from.clone().add(n), b: m.to.clone().add(n), dir };
    }
    const g = arcGeom(m.e);
    if (!g) return null;
    const R = g.R + (m.ccw ? -dist : dist);
    if (R < 1e-3) return null;
    const at = (p: THREE.Vector2) => {
      const a = Math.atan2(p.y - g.C.y, p.x - g.C.x);
      return v(g.C.x + Math.cos(a) * R, g.C.y + Math.sin(a) * R);
    };
    return { kind: "arc", src: m.e.id, a: at(m.from), b: at(m.to), C: g.C, R, ccw: m.ccw };
  };

  /** Move the shared corner of two adjacent offset members onto their
   *  intersection. Picks the root nearest the ORIGINAL corner, which is what
   *  keeps a line-arc join on the right branch. Returns false when there is no
   *  usable intersection (parallel lines, separated circles) or the miter would
   *  travel further than MITER_LIMIT — the corner is then left butted. */
  const joinAt = (s0: Off, s1: Off, corner: THREE.Vector2): boolean => {
    let cands: THREE.Vector2[] = [];
    if (s0.kind === "line" && s1.kind === "line") {
      const m = lineIntersect(s0.a, s0.b, s1.a, s1.b);
      cands = m ? [m] : [];
    } else if (s0.kind === "line" && s1.kind === "arc") {
      cands = circleLineIntersect(s0.a, s0.b, s1.C, s1.R);
    } else if (s0.kind === "arc" && s1.kind === "line") {
      cands = circleLineIntersect(s1.a, s1.b, s0.C, s0.R);
    } else if (s0.kind === "arc" && s1.kind === "arc") {
      cands = circleCircleIntersect(s0.C, s0.R, s1.C, s1.R);
    }
    if (!cands.length) return false;
    const best = cands.reduce((p, q) => (q.distanceTo(corner) < p.distanceTo(corner) ? q : p));
    if (best.distanceTo(corner) > MITER_LIMIT * Math.abs(dist) + 1e-9) return false;
    s0.b = best;
    s1.a = best;
    return true;
  };

  // Offset, join, and prune anything that collapsed. An inward offset larger
  // than the smallest feature makes a member run BACKWARDS relative to its
  // source; keeping it produces the classic self-intersecting bow-tie. Drop the
  // reversed members and re-join across the gap, repeating because removing one
  // can expose the next. Bounded by the member count, so it always terminates.
  let live = path;
  let offs: Off[] = [];
  for (let pass = 0; pass <= path.length; pass++) {
    const built = live.map(offsetOne);
    offs = built.filter((o): o is Off => o !== null);
    const survivors = live.filter((_m, k) => built[k] !== null);
    live = survivors;
    if (!offs.length) return null;
    const last = offs.length - 1;
    for (let k = 0; k < last; k++) joinAt(offs[k]!, offs[k + 1]!, live[k]!.to);
    if (closed && offs.length > 1) joinAt(offs[last]!, offs[0]!, live[last]!.to);
    // a LINE that now points the other way has been swallowed by the offset
    const reversed = offs
      .map((o, k) => (o.kind === "line" && o.b.clone().sub(o.a).dot(o.dir) < 0 ? k : -1))
      .filter((k) => k >= 0);
    if (!reversed.length) break;
    const drop = new Set(reversed);
    live = live.filter((_m, k) => !drop.has(k));
    if (live.length < 1) return null;
  }

  const pairs: { src: string; cpy: string }[] = [];
  const copies: ResolvedEntity[] = [];
  for (const o of offs) {
    const srcEnt = ents.find((x) => x.id === o.src) ?? {};
    if (o.kind === "line") {
      const id = newEntityId();
      copies.push({ type: "line", id, x1: o.a.x, y1: o.a.y, x2: o.b.x, y2: o.b.y, ...constr(srcEnt) });
      pairs.push({ src: o.src, cpy: id });
    } else {
      const arc = arcFromEnds(o.C, o.R, o.a, o.b, o.ccw, srcEnt);
      if (!arc) continue; // swept to nothing
      copies.push(arc);
      pairs.push({ src: o.src, cpy: arc.id });
    }
  }
  if (!copies.length) return null;
  return { entities: [...ents, ...copies], pairs, linked: true };
}

/** Break: split the clicked curve at the click point. A line/arc splits into two
 *  pieces; a circle opens into a single arc starting/ending at the click point. */
export function breakAt(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] {
  const e = ents[index];
  if (!e) return ents;
  if (e.type === "line") {
    const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
    let t = paramOnSeg(p1, p2, click);
    t = Math.max(0.02, Math.min(0.98, t));
    const m = v(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
    const a: ResolvedEntity = { type: "line", id: newEntityId(), x1: p1.x, y1: p1.y, x2: m.x, y2: m.y, ...constr(e) };
    const b: ResolvedEntity = { type: "line", id: newEntityId(), x1: m.x, y1: m.y, x2: p2.x, y2: p2.y, ...constr(e) };
    return ents.flatMap((o, i) => (i === index ? [a, b] : [o]));
  }
  if (e.type === "circle") {
    // open the closed loop at the click angle → one arc sweeping (almost) full circle
    const C = v(e.x, e.y), R = e.radius;
    const ac = Math.atan2(click.y - C.y, click.x - C.x);
    const gap = 1e-3; // tiny opening so start ≠ end (a valid arc)
    return ents.flatMap((o, i) => (i === index ? [arcFromSpan(C, R, ac + gap, TAU - 2 * gap, e)] : [o]));
  }
  if (e.type === "arc") {
    const g = arcGeom(e);
    if (!g) return ents;
    const { C, R, aStart, delta } = g;
    let t = ccwDelta(aStart, Math.atan2(click.y - C.y, click.x - C.x)) / delta;
    t = Math.max(0.02, Math.min(0.98, t));
    const a = arcFromSpan(C, R, aStart, t * delta, e);
    const b = arcFromSpan(C, R, aStart + t * delta, (1 - t) * delta, e);
    return ents.flatMap((o, i) => (i === index ? [a, b] : [o]));
  }
  return ents;
}

/** Break, keeping every constraint that still applies to the pieces.
 *
 *  breakAt gives every piece a NEW id (an extrude trusts a unique id match
 *  before its stored point, so the id left on one half could name an area
 *  only the other half bounds), and the caller then pruned whatever named the
 *  old one. So a snapped join on either end, a horizontal, a tangency all
 *  went without a word, and the join opened on the next solve. The rewrite is
 *  Trim's, remapTrimmed: a point constraint follows its point to the piece
 *  that still has it (the start's to the first half, the end's to the
 *  second), a direction such as horizontal or parallel goes to every piece, a
 *  dimension of the carrier stays once on the piece holding the start, and a
 *  constraint on the curve's EXTENT (a length, an equal length, a midpoint)
 *  holds for no piece and is counted in `dropped` for the caller to say so.
 *  No constraint is added at the cut: the halves stay free to pull apart
 *  there (breakJoined). */
export function breakWithConstraints(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
  cons: SketchConstraint[],
): TrimResult {
  const e = ents[index];
  const entities = breakAt(ents, index, click);
  if (!e || entities === ents) return { entities: ents, constraints: cons, dropped: 0, points: {}, lines: {} };
  const made = entities.slice(index, index + 1 + entities.length - ents.length);
  const start = dimRefPoints(e).find((r) => r.p === 0)?.pos;
  const lead = made.find((g) => start && endsAt(g, start)) ?? made[0];
  const pieces = made.map((geom) => ({ from: e.id, geom, whole: false, lead: geom === lead }));
  return { entities, ...remapTrimmed(e, pieces, cons, entities) };
}

/** What a detach did: pulled one end off a shared point, or refused because a
 *  constraint holds that very end there. `constraints` is set when the pull
 *  released Coincidents to do it (detachEndpoint's `release`). */
export type Detach =
  | { kind: "detached"; entities: ResolvedEntity[]; idx: number; constraints?: SketchConstraint[] }
  | { kind: "coincident" }
  | { kind: "fixed" };

/** Is `at` a cut Break made: two ends meet there that are the halves of one
 *  line (on one straight line, leaving the spot in opposite directions) or of
 *  one arc (on one circle, one ending where the other starts)? Other curves
 *  may end there too, one drawn onto the cut later. That is the only place a
 *  Shift-drag pulls ends apart (SketchMode.detachFrame). Anywhere else, a
 *  polyline's corner, a line end on a rectangle corner or on the origin,
 *  Shift-drag is the plain drag it always was, and the right-click Disconnect
 *  still pulls one end off.
 *
 *  Read from the geometry, because nothing else records a Break: it adds no
 *  constraint at the cut (breakWithConstraints), and the cut has to read as
 *  one after the sketch is closed and opened again. It stops reading as one
 *  once the halves are bent apart there; Disconnect still works then. And it
 *  cannot tell a cut from a joint that looks like one: two lines drawn end to
 *  end along one straight line, or two arcs of one circle meeting end to
 *  start, read as a cut, so Shift-drag pulls those apart too. Telling them
 *  apart needs the cut recorded in the document. */
export function isBreakCut(ents: readonly ResolvedEntity[], at: { x: number; y: number }): boolean {
  const key = coincKey(at.x, at.y);
  const P = v(at.x, at.y);
  type Curve = Extract<ResolvedEntity, { type: "line" } | { type: "arc" }>;
  const ends: { e: Curve; p: 0 | 1 }[] = [];
  for (const e of ents) {
    if (e.type !== "line" && e.type !== "arc") continue;
    if (coincKey(e.x1, e.y1) === key) ends.push({ e, p: 0 });
    if (coincKey(e.x2, e.y2) === key) ends.push({ e, p: 1 });
  }
  /** the way a line leaves the spot from its end `p` */
  const away = (l: Extract<ResolvedEntity, { type: "line" }>, p: 0 | 1) =>
    (p === 0 ? v(l.x2, l.y2) : v(l.x1, l.y1)).sub(P).normalize();
  /** whether an arc STARTS at the spot, running counter-clockwise from aStart */
  const startsHere = (g: NonNullable<ReturnType<typeof arcGeom>>) => {
    const ang = Math.atan2(P.y - g.C.y, P.x - g.C.x);
    const off = (x: number) => Math.min(ccwDelta(x, ang), ccwDelta(ang, x));
    return off(g.aStart) < off(g.aStart + g.delta);
  };
  const halves = (a: { e: Curve; p: 0 | 1 }, b: { e: Curve; p: 0 | 1 }): boolean => {
    if (a.e === b.e) return false;
    if (a.e.type === "line" && b.e.type === "line") {
      const da = away(a.e, a.p), db = away(b.e, b.p);
      return Math.abs(da.cross(db)) < 1e-6 && da.dot(db) < 0;
    }
    if (a.e.type !== "arc" || b.e.type !== "arc") return false;
    const ga = arcGeom(a.e), gb = arcGeom(b.e);
    if (!ga || !gb) return false;
    const tol = 1e-6 * Math.max(1, ga.R);
    if (ga.C.distanceTo(gb.C) > tol || Math.abs(ga.R - gb.R) > tol) return false;
    // one has to end at the cut and the other start there, or they lie over each other
    return startsHere(ga) !== startsHere(gb);
  };
  return ends.some((a, i) => ends.slice(i + 1).some((b) => halves(a, b)));
}

/** Which end a detach at the shared point `at` would pull away: of the ends
 *  that sit there, the one whose curve is nearest `press` (where the user
 *  pressed, so the curve they were pointing at). `end` is the point index
 *  constraints use: 0/1 for a line, arc or spline, 0 for a sketch point.
 *
 *  A press ON the point (within `drag.onPoint` of it) names no curve: every
 *  curve there is about as near as any other, and the nearest was whichever
 *  came first in the list, so the same half left whichever way the user
 *  dragged. There `drag.to` decides: the end that leaves is the one whose curve
 *  heads the way the cursor went, so dragging from a Break's cut toward one
 *  half pulls that half's end.
 *
 *  Only a line, arc or spline end, or a sketch point, can leave: a rectangle
 *  corner cannot move without its rectangle, and the origin is fixed. Null
 *  when the point is not shared, or nothing of the user's can leave it. */
export function detachableEnd(
  ents: readonly ResolvedEntity[],
  at: { x: number; y: number },
  press: THREE.Vector2,
  drag?: { to: { x: number; y: number }; onPoint: number },
): { idx: number; end: number } | null {
  const key = coincKey(at.x, at.y);
  const ends = (e: ResolvedEntity): { end: number; x: number; y: number }[] => {
    if (e.type === "line" || e.type === "arc") return [{ end: 0, x: e.x1, y: e.y1 }, { end: 1, x: e.x2, y: e.y2 }];
    if (e.type === "spline") {
      return e.points.length > 1 ? splineEndIndices(e).map((k, end) => ({ end, ...e.points[k]! })) : [];
    }
    if (e.type === "point") return [{ end: 0, x: e.x, y: e.y }];
    if (e.type === "rectangle") return rectCorners(e.x, e.y, e.width, e.height).map((q, k) => ({ end: k, x: q.x, y: q.y }));
    return [];
  };
  const owners = ents.flatMap((e, idx) =>
    ends(e).filter((q) => coincKey(q.x, q.y) === key).map((q) => ({ idx, end: q.end })));
  if (owners.length < 2) return null;
  const movable = owners.filter(({ idx }) => {
    const e = ents[idx]!;
    return (e.type === "line" || e.type === "arc" || e.type === "spline" || e.type === "point") && !isOriginGeometry(e.id);
  });
  const dist = ({ idx }: { idx: number }) => {
    const e = ents[idx]!;
    return e.type === "point" ? press.distanceTo(v(e.x, e.y)) : distToEntity(e, press);
  };
  const nearest = movable.reduce<{ idx: number; end: number } | null>((b, o) => (!b || dist(o) < dist(b) ? o : b), null);
  if (!drag || press.distanceTo(v(at.x, at.y)) > drag.onPoint) return nearest;
  const way = v(drag.to.x - press.x, drag.to.y - press.y);
  if (way.lengthSq() < 1e-18) return nearest;
  way.normalize();
  /** how much a curve heads the way the cursor went, leaving `at` from this
   *  end: along its first (or last) tessellated segment. A sketch point heads
   *  nowhere (0), so it leaves only when every curve there points away. */
  const heading = ({ idx, end }: { idx: number; end: number }) => {
    const segs = entitySegments(ents[idx]!);
    const s = end === 0 ? segs[0] : segs[segs.length - 1];
    if (!s) return 0;
    const into = end === 0 ? s[1].clone().sub(s[0]) : s[0].clone().sub(s[1]);
    return into.lengthSq() < 1e-18 ? 0 : into.normalize().dot(way);
  };
  return movable.reduce<{ idx: number; end: number } | null>(
    (b, o) => (!b || heading(o) > heading(b) + 1e-9 ? o : b), nearest);
}

/** Pull ONE curve's end off a point it shares with others, to `to`.
 *
 *  Endpoints at the same spot are joined by position alone: the solver merges
 *  them into one point (coincKey), nothing draws that join, and every drag
 *  keeps it on purpose (bodyDragFrame). So after Break the two halves could not
 *  be pulled apart at all, and there was no glyph to delete (report 3b97b35d).
 *  This is the way out: the end detachableEnd picks moves to `to`, out of the
 *  shared bucket, and from then on it is a point of its own. A press within
 *  `onPoint` of the shared point is ON it, and the drag toward `to` picks.
 *
 *  Null when there is nothing to pull apart, so the caller carries on with an
 *  ordinary drag. Refused when a `fix` names that very end, and when an
 *  explicit `coincident` (which HAS a glyph to delete) does, unless `release`:
 *  a right-click Disconnect, which asks for exactly that join to come apart.
 *  Every corner of a chain of lines carries one, so refusing there made
 *  Disconnect two steps at the commonest joint in a sketch. The points the end
 *  was joined to stay joined to each other. */
export function detachEndpoint(
  ents: ResolvedEntity[],
  at: { x: number; y: number },
  press: THREE.Vector2,
  to: { x: number; y: number },
  cons: readonly SketchConstraint[],
  onPoint = 0,
  release = false,
): Detach | null {
  const pick = detachableEnd(ents, at, press, { to, onPoint });
  if (!pick) return null;
  const ent = ents[pick.idx]!;
  // a sketch point names itself at any index, so any constraint on it is on this end
  const isEnd = (id: string, p: number) => id === ent.id && (ent.type === "point" || p === pick.end);
  const joins = cons.filter((c): c is Extract<SketchConstraint, { type: "coincident" }> =>
    c.type === "coincident" && (isEnd(c.e1, c.p1) || isEnd(c.e2, c.p2)));
  if (joins.length && !release) return { kind: "coincident" };
  if (cons.some((c) => c.type === "fix" && isEnd(c.e, c.p))) return { kind: "fixed" };
  const moved: ResolvedEntity =
    ent.type === "point" ? { ...ent, x: to.x, y: to.y }
    : ent.type === "spline" ? { ...ent, points: ent.points.map((q, k) => (k === (pick.end === 0 ? 0 : ent.points.length - 1) ? { x: to.x, y: to.y } : q)) }
    : ent.type === "line" || ent.type === "arc" ? (pick.end === 0 ? { ...ent, x1: to.x, y1: to.y } : { ...ent, x2: to.x, y2: to.y })
    : ent;
  const entities = ents.map((e, i) => (i === pick.idx ? moved : e));
  if (!joins.length) return { kind: "detached", entities, idx: pick.idx };
  // What the end was joined to stays joined, each to the first of them: two
  // curves joined only through the end that left would otherwise come apart too.
  type Pt = { e: string; p: number };
  const others: Pt[] = joins.map((c) => (isEnd(c.e1, c.p1) ? { e: c.e2, p: c.p2 } : { e: c.e1, p: c.p1 }));
  const hub = others[0]!;
  /** a coincident already between `a` and `b`, either way round */
  const linked = (a: Pt, b: Pt) => cons.some((c) => c.type === "coincident" && (
    (c.e1 === a.e && c.p1 === a.p && c.e2 === b.e && c.p2 === b.p) ||
    (c.e1 === b.e && c.p1 === b.p && c.e2 === a.e && c.p2 === a.p)));
  const relinks = others.slice(1)
    .filter((o) => !linked(hub, o))
    .map((o): SketchConstraint => ({ type: "coincident", e1: hub.e, p1: hub.p, e2: o.e, p2: o.p }));
  const released = new Set<SketchConstraint>(joins);
  const constraints = [...cons.filter((c) => !released.has(c)), ...relinks];
  return { kind: "detached", entities, idx: pick.idx, constraints };
}

/** Why Join left the lines as they were: the click found no line, nothing
 *  meets it at an end, what meets it turns a corner there or runs back over
 *  it, or one of the two is construction geometry and the other is not. */
export type JoinRefusal = "noLine" | "nothingJoined" | "notInLine" | "overlap" | "construction";

/** What Join made: the one line (`id`), the two it replaced (`from`), the
 *  constraints rewritten for it, how many could not be kept, and where each
 *  replaced line's OUTER end went (old id, then its end index), for an
 *  extrude that starts from or runs up to one of them. */
export type JoinResult =
  | {
    kind: "joined"; entities: ResolvedEntity[]; constraints: SketchConstraint[]; dropped: number;
    id: string; from: [string, string]; points: Record<string, Record<number, { e: string; p: number }>>;
  }
  | { kind: "refused"; why: JoinRefusal };

/** How far two lines meeting at a point may turn there and still be one line:
 *  the sine of the angle between them. Break's halves turn by rounding only
 *  (about 1e-16); anything a user can see is a corner. */
const JOIN_STRAIGHT = 1e-6;

/** Join, the opposite of Break: the line ents[index] and the line it
 *  continues in a straight line, end to end, made ONE line from the far end of
 *  the one to the far end of the other (field report 8d69be71: a Break could
 *  not be taken back once the sketch had been closed).
 *
 *  Which two: of the clicked line's two ends, the one nearer `click` first,
 *  then the other. A click within `tol` of a point where lines meet may also
 *  join two OTHER lines there, so the stem of a T, picked at the joint, still
 *  joins the bar it stands on.
 *
 *  The constraints are Trim's rule run backwards (remapTrimmed):
 *    on the line       a direction, a tangency, a distance or point On the
 *                      line holds for the whole line and is kept once; the
 *                      length of one piece, an Equal or a Midpoint on one does
 *                      not, and goes
 *    an outer end      follows it to the end of the new line it now is
 *    the joint         is gone: a Coincident that held another curve's point
 *                      there, or that point sitting there with nothing holding
 *                      it (the solver merged them), becomes that point On the
 *                      new line, where it still is; the two pieces' own join
 *                      goes quietly; anything else on the joint (a dimension
 *                      to it, a Fix) goes
 *  and what goes is counted in `dropped` for the caller to say so. The new
 *  line gets a NEW id, as Break's pieces do (trimWithConstraints says why),
 *  and runs the way the clicked line ran. */
export function joinLines(
  ents: ResolvedEntity[],
  cons: readonly SketchConstraint[],
  index: number,
  click: THREE.Vector2,
  tol: number,
): JoinResult {
  const picked = ents[index];
  if (picked?.type !== "line" || isOriginGeometry(picked.id)) return { kind: "refused", why: "noLine" };
  const endOf = (l: LineE, end: number) => (end === 0 ? v(l.x1, l.y1) : v(l.x2, l.y2));
  /** the lines with an end at `at`, and which end */
  const meetingAt = (at: THREE.Vector2) => {
    const key = coincKey(at.x, at.y);
    return ents.flatMap((l) => (l.type === "line" && !isOriginGeometry(l.id)
      ? [0, 1].filter((end) => { const q = endOf(l, end); return coincKey(q.x, q.y) === key; }).map((end) => ({ l, end }))
      : []));
  };
  /** why `a` (at its end `ae`) and `b` (at `be`) cannot be one line, or null */
  const refusal = (a: LineE, ae: number, b: LineE, be: number): JoinRefusal | null => {
    if (!!a.construction !== !!b.construction) return "construction";
    const q = endOf(a, ae);
    const d1 = q.clone().sub(endOf(a, 1 - ae)), d2 = endOf(b, 1 - be).sub(q);
    const l1 = d1.length(), l2 = d2.length();
    if (!(l1 > 1e-9 && l2 > 1e-9)) return "notInLine";
    if (Math.abs(d1.cross(d2)) / (l1 * l2) > JOIN_STRAIGHT) return "notInLine";
    return d1.dot(d2) > 0 ? null : "overlap";
  };
  // the most telling reason, when nothing joins
  const RANK: JoinRefusal[] = ["nothingJoined", "notInLine", "overlap", "construction"];
  let why: JoinRefusal = "nothingJoined";
  const worse = (r: JoinRefusal) => { if (RANK.indexOf(r) > RANK.indexOf(why)) why = r; };
  const near = endOf(picked, 0).distanceTo(click) <= endOf(picked, 1).distanceTo(click) ? 0 : 1;
  for (const end of [near, 1 - near]) {
    for (const m of meetingAt(endOf(picked, end))) {
      if (m.l.id === picked.id) continue;
      const r = refusal(picked, end, m.l, m.end);
      if (!r) return joined(ents, cons, picked, end, m.l, m.end);
      worse(r);
    }
  }
  const joint = endOf(picked, near);
  if (joint.distanceTo(click) <= tol) {
    const there = meetingAt(joint).filter((m) => m.l.id !== picked.id);
    for (const [i, m] of there.entries()) {
      for (const o of there.slice(i + 1)) {
        if (o.l.id !== m.l.id && !refusal(m.l, m.end, o.l, o.end)) return joined(ents, cons, m.l, m.end, o.l, o.end);
      }
    }
  }
  return { kind: "refused", why };
}

/** joinLines' result for `a` (joined at its end `ae`) and `b` (at `be`). */
function joined(
  ents: ResolvedEntity[],
  cons: readonly SketchConstraint[],
  a: LineE,
  ae: number,
  b: LineE,
  be: number,
): JoinResult & { kind: "joined" } {
  const id = newEntityId();
  const far = (l: LineE, end: number) => (end === 0 ? { x: l.x2, y: l.y2 } : { x: l.x1, y: l.y1 });
  // a's far end keeps its index, so the line runs the way `a` ran
  const [s, t] = ae === 1 ? [far(a, ae), far(b, be)] : [far(b, be), far(a, ae)];
  const line: ResolvedEntity = { type: "line", id, x1: s.x, y1: s.y, x2: t.x, y2: t.y, ...constr(a) };
  const entities = ents.flatMap((e) => (e.id === a.id ? [line] : e.id === b.id ? [] : [e]));
  const joint = ae === 0 ? v(a.x1, a.y1) : v(a.x2, a.y2);
  const names = (x: string) => x === a.id || x === b.id;
  const curve = (x: string) => (names(x) ? id : x);
  /** a point operand: an outer end to its end of the new line, the joint to
   *  null (it is gone), anything else unchanged */
  const point = (e: string, p: number): { e: string; p: number } | null => {
    if (e === a.id) return p === 1 - ae ? { e: id, p } : null;
    if (e === b.id) return p === 1 - be ? { e: id, p: ae } : null;
    return { e, p };
  };
  const isJoint = (e: string, p: number) => (e === a.id && p === ae) || (e === b.id && p === be);
  /** what sits at the joint, on the new line: a point On it */
  const onLine = (q: { e: string; p: number }): SketchConstraint => ({ type: "pointOn", e: q.e, p: q.p, curve: id });

  let dropped = 0;
  const remap = (c: SketchConstraint): SketchConstraint | null | "quiet" => {
    switch (c.type) {
      case "horizontal": case "vertical": return { ...c, line: curve(c.line) };
      case "parallel": case "collinear": case "perpendicular": case "angle": {
        const l1 = curve(c.l1), l2 = curve(c.l2);
        if (l1 !== l2) return { ...c, l1, l2 };
        // between the two pieces: in line now by being one line
        return c.type === "parallel" || c.type === "collinear" ? "quiet" : null;
      }
      // the length of a piece: not the new line's
      case "distance": case "equal": return null;
      case "tangent": return { ...c, line: curve(c.line) };
      case "tangent2": return { ...c, a: curve(c.a), b: curve(c.b) };
      case "c2lDistance": return { ...c, line: curve(c.line) };
      // a spline is never one of the two lines being joined; the curve it
      // meets can be
      case "splineTangent": return { ...c, other: curve(c.other) };
      case "coincident": {
        const j1 = isJoint(c.e1, c.p1), j2 = isJoint(c.e2, c.p2);
        if (j1 && j2) return "quiet"; // the pieces' own join
        const q1 = point(c.e1, c.p1), q2 = point(c.e2, c.p2);
        // another curve's point held on the joint: On the new line now
        const other = j1 ? q2 : j2 ? q1 : null;
        if (j1 || j2) return other && other.e !== id ? onLine(other) : null;
        return q1 && q2 ? { ...c, e1: q1.e, p1: q1.p, e2: q2.e, p2: q2.p } : null;
      }
      case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY": {
        const q1 = point(c.e1, c.p1), q2 = point(c.e2, c.p2);
        return q1 && q2 ? { ...c, e1: q1.e, p1: q1.p, e2: q2.e, p2: q2.p } : null;
      }
      case "fix": case "p2cDistance": {
        const q = point(c.e, c.p);
        return q ? { ...c, e: q.e, p: q.p } : null;
      }
      case "midpoint": {
        const q = point(c.e, c.p);
        return q && !names(c.line) ? { ...c, e: q.e, p: q.p } : null;
      }
      case "pointOn": {
        const q = point(c.e, c.p), on = curve(c.curve);
        if (!q) return null;
        return q.e === id && on === id ? "quiet" : { ...c, e: q.e, p: q.p, curve: on };
      }
      case "p2lDistance": {
        const q = point(c.e, c.p), line = curve(c.line);
        return q && !(q.e === id && line === id) ? { ...c, e: q.e, p: q.p, line } : null;
      }
      case "symmetric": {
        const q1 = point(c.e1, c.p1), q2 = point(c.e2, c.p2);
        return q1 && q2 ? { ...c, e1: q1.e, p1: q1.p, e2: q2.e, p2: q2.p, line: curve(c.line) } : null;
      }
      // A piece that was the COPY keeps one source: two would govern the
      // one line twice (remapTrimmed's rule for a trimmed source).
      case "offset": {
        const seen = new Set<string>();
        const pairs = c.pairs.flatMap((pr) => {
          const src = curve(pr.src), cpy = curve(pr.cpy);
          if (src === cpy || seen.has(cpy)) return [];
          seen.add(cpy);
          return [{ src, cpy }];
        });
        return pairs.length ? { ...c, pairs } : null;
      }
      // rounds only: never a line
      case "concentric": case "equalRadius": case "diameter": case "radius":
      case "radialGap": case "c2cDistance":
        return c;
      default: return c satisfies never;
    }
  };
  const mentions = (c: SketchConstraint) =>
    c.type === "offset"
      ? c.pairs.some((pr) => names(pr.src) || names(pr.cpy))
      : Object.entries(c).some(([k, val]) => k !== "type" && k !== "id" && typeof val === "string" && names(val));
  const constraints: SketchConstraint[] = [];
  const seen = new Set<string>();
  for (const c of cons) {
    if (!mentions(c)) { constraints.push(c); continue; }
    const next = remap(c);
    if (next === "quiet") continue;
    if (!next) { dropped++; continue; }
    // both pieces Horizontal, say: once is enough
    const key = JSON.stringify(next);
    if (seen.has(key)) continue;
    seen.add(key);
    constraints.push(next);
  }
  // A curve's point that sat on the joint with nothing holding it there was
  // held all the same: the solver merges ends at one spot (coincKey). Kept On
  // the new line, it stays where it is.
  const key = coincKey(joint.x, joint.y);
  const held = new Set(constraints.flatMap((c) => (c.type === "pointOn" && c.curve === id ? [`${c.e}:${c.p}`] : [])));
  for (const e of entities) {
    if (e.id === id) continue;
    for (const { p, pos } of dimRefPoints(e)) {
      if (!mergesAt(e, p) || coincKey(pos.x, pos.y) !== key || held.has(`${e.id}:${p}`)) continue;
      held.add(`${e.id}:${p}`);
      constraints.push(onLine({ e: e.id, p }));
    }
  }
  return {
    kind: "joined", entities, constraints, dropped, id, from: [a.id, b.id],
    points: { [a.id]: { [1 - ae]: { e: id, p: 1 - ae } }, [b.id]: { [1 - be]: { e: id, p: ae } } },
  };
}

/** Does point `p` of `e` join whatever else ends at the same spot? The points
 *  the solver merges by position (getPoint's `mergeable`): a line's, arc's or
 *  spline's ends, a sketch point, a rectangle's corners, and the same on
 *  projected geometry. Not a centre, nor a polygon's or slot's points, which
 *  join nothing until a constraint names them. */
function mergesAt(e: ResolvedEntity, p: number): boolean {
  if (e.type === "line" || e.type === "spline" || e.type === "point") return true;
  if (e.type === "arc") return p !== 2;
  if (e.type === "rectangle") return p !== RECT_CENTRE;
  if (e.type === "projected") return e.curve.kind !== "circle" && !(e.curve.kind === "arc" && p === 2);
  return false;
}

// --- geometric constraints (applied once; a full solver maintains them) ---
const lineDir = (e: { x1: number; y1: number; x2: number; y2: number }) =>
  v(e.x2 - e.x1, e.y2 - e.y1).normalize();

export function makeHorizontal(ents: ResolvedEntity[], i: number): ResolvedEntity[] {
  const e = ents[i];
  if (!e || e.type !== "line") return ents;
  const y = (e.y1 + e.y2) / 2;
  return ents.map((o, j) => (j === i ? { ...e, y1: y, y2: y } : o));
}
export function makeVertical(ents: ResolvedEntity[], i: number): ResolvedEntity[] {
  const e = ents[i];
  if (!e || e.type !== "line") return ents;
  const x = (e.x1 + e.x2) / 2;
  return ents.map((o, j) => (j === i ? { ...e, x1: x, x2: x } : o));
}
/** rotate line B about its start to a target direction (keeping its length) */
function alignLine(ents: ResolvedEntity[], iB: number, dir: THREE.Vector2): ResolvedEntity[] {
  const B = ents[iB];
  if (!B || B.type !== "line") return ents;
  const len = v(B.x2 - B.x1, B.y2 - B.y1).length();
  const old = lineDir(B);
  const sign = dir.dot(old) >= 0 ? 1 : -1; // keep B pointing the same general way
  const d = dir.clone().multiplyScalar(sign * len);
  return ents.map((o, j) => (j === iB ? { ...B, x2: B.x1 + d.x, y2: B.y1 + d.y } : o));
}
export function makeParallel(ents: ResolvedEntity[], iA: number, iB: number): ResolvedEntity[] {
  const A = ents[iA];
  if (A?.type !== "line") return ents;
  return alignLine(ents, iB, lineDir(A));
}
export function makePerpendicular(ents: ResolvedEntity[], iA: number, iB: number): ResolvedEntity[] {
  const A = ents[iA];
  if (A?.type !== "line") return ents;
  const d = lineDir(A);
  return alignLine(ents, iB, v(-d.y, d.x));
}
export function makeEqual(ents: ResolvedEntity[], iA: number, iB: number): ResolvedEntity[] {
  const A = ents[iA], B = ents[iB];
  if (A?.type !== "line" || B?.type !== "line") return ents;
  const lenA = v(A.x2 - A.x1, A.y2 - A.y1).length();
  const d = lineDir(B).multiplyScalar(lenA);
  return ents.map((o, j) => (j === iB ? { ...B, x2: B.x1 + d.x, y2: B.y1 + d.y } : o));
}

/** Extend: lengthen the clicked end of a line or arc to the nearest crossing. */
export function extendLine(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
): ResolvedEntity[] | null {
  const e = ents[index];
  if (!e) return null;
  if (e.type === "arc") return extendArc(ents, index, e, click);
  if (e.type !== "line") return null;
  const p1 = v(e.x1, e.y1), p2 = v(e.x2, e.y2);
  const extendEnd2 = paramOnSeg(p1, p2, click) >= 0.5; // which end is near the click

  let bestT = extendEnd2 ? 1 : 0;
  let found = false;
  // along the line's whole INFINITE carrier: a crossing past either end is a
  // candidate, and a circle the extension only touches is one too
  for (const h of crossingsOn(ents, index, { kind: "line", a: p1, b: p2 })) {
    const t = paramOnSeg(p1, p2, h);
    if (extendEnd2 && t > 1 + 1e-4 && (!found || t < bestT)) { bestT = t; found = true; }
    if (!extendEnd2 && t < -1e-4 && (!found || t > bestT)) { bestT = t; found = true; }
  }
  if (!found) return null;
  const np = p1.clone().add(p2.clone().sub(p1).multiplyScalar(bestT));
  const out = ents.map((o, i) => {
    if (i !== index || o.type !== "line") return o;
    return extendEnd2
      ? { ...o, x2: np.x, y2: np.y }
      : { ...o, x1: np.x, y1: np.y };
  });
  return out;
}

/** Extend an arc's near-clicked end along its circle to the nearest crossing. */
function extendArc(
  ents: ResolvedEntity[],
  index: number,
  e: Extract<ResolvedEntity, { type: "arc" }>,
  click: THREE.Vector2,
): ResolvedEntity[] | null {
  const g = arcGeom(e);
  if (!g) return null;
  const { C, R, aStart, delta } = g;
  const ac = Math.atan2(click.y - C.y, click.x - C.x);
  const nearEnd = ccwDelta(aStart, ac) > delta / 2; // click closer to end than start
  const aEnd = aStart + delta;
  let best: number | null = null;
  for (const raw of circleCrossAngles(ents, index, C, R)) {
    if (ccwDelta(aStart, raw) <= delta + 1e-6) continue; // already on the arc
    // gap = how far to sweep (CCW past the end, or CW before the start) to reach it
    const gap = nearEnd ? ccwDelta(aEnd, raw) : ccwDelta(raw, aStart);
    if (gap > 1e-4 && gap < TAU - delta - 1e-4 && (best === null || gap < best)) best = gap;
  }
  if (best === null) return null;
  const grown = nearEnd
    ? arcFromSpan(C, R, aStart, delta + best, e)
    : arcFromSpan(C, R, aStart - best, delta + best, e);
  const kept = { ...grown, id: e.id }; // survive: keep id + constraints
  return ents.map((o, i) => (i === index ? kept : o));
}

/**
 * Chamfer the corner where two line entities meet: shorten both to the setback
 * points and insert a straight bevel line. `dist` is the equal setback along
 * each line. Returns null if it can't (parallel/collinear/too-big).
 */
export function chamferCorner(
  ents: ResolvedEntity[],
  iA: number,
  iB: number,
  dist: number,
): ResolvedEntity[] | null {
  const A = ents[iA], B = ents[iB];
  if (A?.type !== "line" || B?.type !== "line") return null;
  const a1 = v(A.x1, A.y1), a2 = v(A.x2, A.y2);
  const b1 = v(B.x1, B.y1), b2 = v(B.x2, B.y2);
  const corner = lineIntersect(a1, a2, b1, b2);
  if (!corner) return null; // parallel

  const aFar = a1.distanceTo(corner) >= a2.distanceTo(corner) ? a1 : a2;
  const bFar = b1.distanceTo(corner) >= b2.distanceTo(corner) ? b1 : b2;
  const d1 = aFar.clone().sub(corner).normalize();
  const d2 = bFar.clone().sub(corner).normalize();
  const cosT = Math.max(-1, Math.min(1, d1.dot(d2)));
  const theta = Math.acos(cosT);
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return null; // collinear
  if (dist > aFar.distanceTo(corner) || dist > bFar.distanceTo(corner)) return null; // too big

  const T1 = corner.clone().add(d1.clone().multiplyScalar(dist));
  const T2 = corner.clone().add(d2.clone().multiplyScalar(dist));

  const newA = cutBack(A, aFar === a1, T1);
  const newB = cutBack(B, bFar === b1, T2);
  const bevel: ResolvedEntity = { type: "line", id: newEntityId(), x1: T1.x, y1: T1.y, x2: T2.x, y2: T2.y };

  const out = ents.map((o, i) => (i === iA ? newA : i === iB ? newB : o));
  out.push(bevel);
  return out;
}
