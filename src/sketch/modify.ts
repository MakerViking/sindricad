// Sketch modify operations on resolved entities: pick, trim, fillet-corner.
// These mutate the entity list (returning a new one); the sketcher rebuilds.

import { t } from "../i18n";
import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { entitySegments, polygonPoints, rectCorners } from "./region";
import { asRound, dimRefPoints, lineOperand } from "./entityDims";
import { isOriginGeometry } from "./origin";
import { newEntityId } from "./id";
import { arcCenterRadius } from "./arc";
import { translated } from "./pattern";
import { coincKey } from "./sketchSolve";
import {
  circleLineIntersect,
  circleCircleIntersect,
  curveCrossings,
  lineIntersect,
  paramOnSeg,
  distToSeg,
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
 *  re-satisfies everything around them. */
export function attachmentPoints(e: ResolvedEntity): THREE.Vector2[] {
  if (e.type === "line" || e.type === "arc") return [v(e.x1, e.y1), v(e.x2, e.y2)];
  if (e.type === "rectangle") return rectCorners(e.x, e.y, e.width, e.height).map((q) => q.clone());
  if (e.type === "spline") {
    const a = e.points[0], b = e.points[e.points.length - 1];
    return a && b ? [v(a.x, a.y), v(b.x, b.y)] : [];
  }
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
  return moved.some((e) => attachmentPoints(e).some((q) => pinnedAt.has(coincKey(q.x, q.y))));
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
    [...moved].flatMap((i) => attachmentPoints(ents[i]!).map((q) => coincKey(q.x, q.y))),
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
      const last = e.points.length - 1;
      const hit = [0, last].filter((k) => { const q = e.points[k]; return !!q && near(q.x, q.y); });
      if (!hit.length) return e;
      return { ...e, points: e.points.map((q, k) => (hit.includes(k) ? { x: q.x + dx, y: q.y + dy } : q)) };
    }
    if (e.type === "point" && near(e.x, e.y)) return { ...e, x: e.x + dx, y: e.y + dy };
    return e;
  });
}

/** The nearest solver-controlled point (line/arc endpoint, circle or arc centre,
 *  rectangle corner, spline fit point) within `tol` of p — the select tool's
 *  drag handles. Rigid shapes (polygon/slot) are intentionally excluded: they
 *  don't expand to solver points.
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
        return { type: "spline", ...base, points: cv.pts.map(([x, y]) => ({ x, y })) };
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
 *  constraints could no longer apply and were removed (the caller says so). */
export type TrimResult = { entities: ResolvedEntity[]; constraints: SketchConstraint[]; dropped: number };

/** Trim, keeping every constraint that still applies to what is left.
 *
 *  Trim mints a new id for every piece it keeps, and used to let the caller
 *  prune whatever named the old one, which silently deleted constraints that
 *  still held: an offset link on a trimmed copy, a tangency on the kept arc
 *  (report 356b2693). remapTrimmed now rewrites each of them for the new ids.
 *
 *  The ids stay NEW, never the trimmed entity's. An extrude remembers the ids
 *  bounding the area it picked and trusts a unique id match before its stored
 *  point, so an old id left on a piece that now bounds a DIFFERENT area moved
 *  the extrude there without a word (measured: a quadrant extrude jumped to the
 *  quadrant beside it). With every id new, the stale ids match nothing and the
 *  point decides, as it always has. The piece holding the entity's start (or
 *  the only piece) leads, for remapTrimmed's dimensions. */
export function trimWithConstraints(
  ents: ResolvedEntity[],
  index: number,
  click: THREE.Vector2,
  cons: SketchConstraint[],
): TrimResult {
  const e = ents[index];
  const plan = planTrim(ents, index, click);
  if (!e || !plan) return { entities: ents, constraints: cons, dropped: 0 };
  const start = dimRefPoints(e).find((r) => r.p === 0)?.pos;
  const lead = e.type === "rectangle"
    ? null
    : plan.kept.find((pc) => start && endsAt(pc.geom, start)) ?? plan.kept[0];
  const pieces = plan.kept.map((pc) => ({ ...pc, lead: pc === lead, geom: { ...pc.geom, id: newEntityId() } }));
  const entities = ents.flatMap((o, i) => (i === index ? pieces.map((pc) => pc.geom) : [o]));
  return { entities, ...remapTrimmed(e, pieces, cons, entities) };
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

/** Rewrite the constraints that named a trimmed entity for the pieces it left.
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
 *  counted in `dropped`, so the caller can say what went. */
function remapTrimmed(
  e: ResolvedEntity,
  pieces: TrimPiece[],
  cons: SketchConstraint[],
  after: ResolvedEntity[],
): { constraints: SketchConstraint[]; dropped: number } {
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
      // points
      case "coincident": case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY": {
        const a = point(c.e1, c.p1), b = point(c.e2, c.p2);
        return a && b ? [{ ...c, e1: a.e, p1: a.p, e2: b.e, p2: b.p }] : null;
      }
      case "fix": { const q = point(c.e, c.p); return q ? [{ ...c, e: q.e, p: q.p }] : null; }
      case "midpoint": {
        const q = point(c.e, c.p), line = extent(c.line);
        return q && line ? [{ ...c, e: q.e, p: q.p, line }] : null;
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
  return { constraints, dropped: dropped + lostLinks };
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
  const newA: ResolvedEntity = { ...A, x1: aFar.x, y1: aFar.y, x2: T1.x, y2: T1.y };
  const newB: ResolvedEntity = { ...B, x1: bFar.x, y1: bFar.y, x2: T2.x, y2: T2.y };
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
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = v(e.points[i]!.x, e.points[i]!.y), b = v(e.points[i + 1]!.x, e.points[i + 1]!.y);
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
 *  govern (rect operands are EDGES, "<rectId>~<k>" — see types.ts). `linked:
 *  false` means the geometry is correct but free-floating: the solver models
 *  polygon / slot / spline as RIGID, so there is no constraint that could tie
 *  the copy to its source, and the caller says so once rather than implying a
 *  link that doesn't exist. */
export type OffsetResult = {
  entities: ResolvedEntity[];
  pairs: { src: string; cpy: string }[];
  linked: boolean;
};

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
    const w = e.width + 2 * dist, h = e.height + 2 * dist;
    if (w > 1e-3 && h > 1e-3) {
      copy = { type: "rectangle", id, width: w, height: h, x: e.x, y: e.y, ...constr(e) };
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
    // direction and the ends use their own single segment.
    const pts = e.points;
    if (pts.length >= 2) {
      copy = {
        type: "spline", id, ...constr(e),
        points: pts.map((p, i) => {
          const prev = pts[i - 1] ?? p, next = pts[i + 1] ?? p;
          const dx = next.x - prev.x, dy = next.y - prev.y;
          const len = Math.hypot(dx, dy) || 1;
          return { x: p.x + (-dy / len) * dist, y: p.y + (dx / len) * dist };
        }),
      };
      linked = false;
    }
  } else if (e.type === "polygon") {
    // Fusion keeps a polygon a polygon. `radius` is the CIRCUMradius while the
    // EDGES lie on the inscribed circle (r·cos(π/n)), so moving the edges out by
    // `dist` moves the circumradius by dist / cos(π/n).
    const n = Math.max(3, Math.round(e.sides));
    const r = e.radius + dist / Math.cos(Math.PI / n);
    if (r > 1e-3) {
      copy = { type: "polygon", id, x: e.x, y: e.y, radius: r, sides: e.sides, angle: e.angle, ...constr(e) };
      linked = false;
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
  const isChain = (e: ResolvedEntity | undefined): e is ChainE =>
    e?.type === "line" || e?.type === "arc";
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

  // connected component containing `index`; bail on any junction (a shared
  // vertex touched by >2 curves) — not a simple chain
  const comp = new Set<number>();
  const stack = [index];
  while (stack.length) {
    const i = stack.pop();
    if (i === undefined || comp.has(i)) continue;
    const e = ents[i];
    if (!isChain(e)) continue;
    comp.add(i);
    for (const k of [coincKey(e.x1, e.y1), coincKey(e.x2, e.y2)]) {
      const arr = touch.get(k);
      if (!arr) continue;
      if (arr.length > 2) return null; // junction
      for (const j of arr) if (j !== i) stack.push(j);
    }
  }
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

/** What a detach did: pulled one end off a shared point, or refused because a
 *  constraint holds that very end there. */
export type Detach =
  | { kind: "detached"; entities: ResolvedEntity[]; idx: number }
  | { kind: "coincident" }
  | { kind: "fixed" };

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
      const a = e.points[0], b = e.points[e.points.length - 1];
      return a && b && e.points.length > 1 ? [{ end: 0, ...a }, { end: 1, ...b }] : [];
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
 *  ordinary drag. Refused when an explicit `coincident` (which HAS a glyph to
 *  delete) or a `fix` names that very end. */
export function detachEndpoint(
  ents: ResolvedEntity[],
  at: { x: number; y: number },
  press: THREE.Vector2,
  to: { x: number; y: number },
  cons: readonly SketchConstraint[],
  onPoint = 0,
): Detach | null {
  const pick = detachableEnd(ents, at, press, { to, onPoint });
  if (!pick) return null;
  const ent = ents[pick.idx]!;
  // a sketch point names itself at any index, so any constraint on it is on this end
  const isEnd = (id: string, p: number) => id === ent.id && (ent.type === "point" || p === pick.end);
  if (cons.some((c) => c.type === "coincident" && (isEnd(c.e1, c.p1) || isEnd(c.e2, c.p2)))) return { kind: "coincident" };
  if (cons.some((c) => c.type === "fix" && isEnd(c.e, c.p))) return { kind: "fixed" };
  const moved: ResolvedEntity =
    ent.type === "point" ? { ...ent, x: to.x, y: to.y }
    : ent.type === "spline" ? { ...ent, points: ent.points.map((q, k) => (k === (pick.end === 0 ? 0 : ent.points.length - 1) ? { x: to.x, y: to.y } : q)) }
    : ent.type === "line" || ent.type === "arc" ? (pick.end === 0 ? { ...ent, x1: to.x, y1: to.y } : { ...ent, x2: to.x, y2: to.y })
    : ent;
  return { kind: "detached", entities: ents.map((e, i) => (i === pick.idx ? moved : e)), idx: pick.idx };
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

  const newA: ResolvedEntity = { ...A, x1: aFar.x, y1: aFar.y, x2: T1.x, y2: T1.y };
  const newB: ResolvedEntity = { ...B, x1: bFar.x, y1: bFar.y, x2: T2.x, y2: T2.y };
  const bevel: ResolvedEntity = { type: "line", id: newEntityId(), x1: T1.x, y1: T1.y, x2: T2.x, y2: T2.y };

  const out = ents.map((o, i) => (i === iA ? newA : i === iB ? newB : o));
  out.push(bevel);
  return out;
}
