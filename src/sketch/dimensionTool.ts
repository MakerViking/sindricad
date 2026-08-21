// The Dimension tool's pick layer and its pair matrix — the pure, DOM-free core
// SketchMode drives (mirroring constraintTools.ts). Two facts shape it:
//
//  1. The dimension TYPE is decided by the pair, not by the first pick. A rim
//     click is a diameter *or* the start of a centre-to-centre distance; which
//     one it becomes is only known once the second pick (or the placement
//     click) arrives. So picking accumulates DimTargets and `resolveDim` maps
//     0-2 of them onto a DimPlan.
//  2. Every degenerate pick returns a NAMED error with the user-facing message
//     attached, so SketchMode can toast it. Nothing here fails silently.
//
// A rectangle edge is a first-class line operand (`"<rectId>~<k>"`, see
// types.ts), which is what makes rect-edge lengths, rect-edge-to-circle
// distances and rect-edge angles fall out of the same three pair rules.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { PlaceOffset, SketchConstraint } from "../types";
import type { DimFieldDef } from "./dimInput";
import {
  asLineSeg, asRound, dimRefPoints, lineRimPoints, pointRimPoints,
  radialGapPoints, rimGap, rimGapPoints, type Round,
} from "./entityDims";
import { pickEntity, PROJECTED_FIXED_MSG } from "./modify";
import { rectCorners } from "./region";
import { distToSeg, signedAngleDeg } from "./geom2d";

type V = THREE.Vector2;
const v = (x: number, y: number) => new THREE.Vector2(x, y);

export type Seg = { x1: number; y1: number; x2: number; y2: number };

/** One dimension pick. `entity` is a whole-curve pick (a line body, a circle
 *  rim); `point` is a dimensionable reference point (dimRefPoints); `edge` is
 *  one side of a rectangle.
 *
 *  `rim` is Fusion's "Pick Circle/Arc Tangent": it arms ONE pick (right-click
 *  menu, before the pick) so a circle/arc contributes its EDGE rather than its
 *  centre to a pair distance. It is meaningless on a lone pick and on anything
 *  that isn't round, where it is simply ignored. */
export type DimTarget =
  | { kind: "point"; e: ResolvedEntity; p: number; pos: V; rim?: true }
  | { kind: "entity"; e: ResolvedEntity; rim?: true }
  | { kind: "edge"; e: ResolvedEntity; k: number; a: V; b: V };

/** How the pair matrix should resolve things the picks alone don't decide —
 *  the right-click overrides on the in-progress dimension. */
export interface DimOptions {
  /** force a lone circle/arc to radius or diameter (default: circle ⇒ diameter,
   *  arc ⇒ radius, exactly like Fusion) */
  roundPref?: "radius" | "diameter";
}

export type DimErrorCode =
  | "same-entity"
  | "concentric"
  | "coincident-points"
  | "point-on-line"
  | "degenerate"
  | "overlapping"
  | "crossing"
  | "unsupported"
  | "need-second"
  | "projected-single";

/** A pick combination that yields no dimension. `message` is the toast text
 *  ("" = deliberately silent); `keepPicks` marks the "not an error, just not
 *  finished" cases where the pick stays armed as a pair operand. */
export interface DimError {
  error: DimErrorCode;
  message: string;
  keepPicks?: boolean;
}

export interface DimPlan {
  kind: "length" | "distance" | "diameter" | "radius" | "angle";
  /** the single DimInput field this plan reads its value from */
  field: string;
  fields: DimFieldDef[];
  /** identity of the field set — SketchMode re-show()s the box only when this
   *  changes (show() destroys whatever the user already typed) */
  fieldKey: string;
  /** live measured value, mm (degrees for an angle) */
  measure(): number;
  /** the two ends of the dimension line, for the placement preview */
  anchors(): { a: V; b: V } | null;
  /** the point `place` is measured FROM (null = this dim can't hold a placement) */
  labelAnchor(): V | null;
  make(value: number, place?: PlaceOffset): SketchConstraint;
  /** The two line operands this plan's value only MEANS something between when
   *  they are held parallel (the parallel-lines distance: one p2lDistance pins
   *  a single endpoint, so without this the solver satisfies the number by
   *  rotating the pair and the typed gap is the gap nowhere else). SketchMode
   *  adds the `parallel` constraint unless the pair is already held parallel. */
  parallelPair?: { l1: string; l2: string };
  /** The two rounds a radial-gap (wall-thickness) value only MEANS something
   *  between while their centres coincide — `difference` ties the two radii and
   *  nothing else (see types.ts). SketchMode adds the `concentric` constraint
   *  unless one already holds them together. */
  implyConcentric?: { c1: string; c2: string };
  /** The entity this dimension should MOVE — the FIRST-PICKED operand.
   *
   *  A pair dimension is one equation over two entities' free parameters, and
   *  the solver will happily satisfy it by moving either. Field report 787121b3:
   *  dimensioning a circle 6 mm from a 40x40 rectangle's edge resized the
   *  RECTANGLE to 39.890111. Which one moves is a POLICY question the geometry
   *  cannot answer, and the answer is "the one you picked first" — SketchMode
   *  hands this to the next solve as `bias.moves` (sketchSolve).
   *
   *  Set only for a two-pick plan: a lone circle's diameter has no second
   *  operand to hold still, so it has nothing to say here. NOT persisted with
   *  the constraint — pick order is a property of the gesture, not of the
   *  document, so re-editing the placed value later takes the free solve. */
  moves?: string;
  /** every operand is fixed reference geometry → create a driven (reference) dim */
  forceDriven?: boolean;
  /** status/toast text once this plan is armed */
  hint: string;
}

export type DimResolution = DimPlan | DimError;

export const isDimError = (r: DimResolution): r is DimError =>
  (r as DimError).error !== undefined;

/** Two lines closer than this to parallel get a DISTANCE, not an angle. sin(0.1°):
 *  looser than Fusion (which calls 179.998° non-parallel) so "two parallel lines
 *  must give a distance" holds robustly; a deliberate 0.2° angle dim still resolves
 *  as an angle. Load-bearing — there is no right-click override in v1. */
export const PARALLEL_EPS = Math.sin((0.1 * Math.PI) / 180);

/** below this a measured distance/length/radius is "zero" — nothing to drive */
export const MEASURE_EPS = 1e-6;

/** Screen-space bounds on a frozen label placement: the floor keeps a label from
 *  burying itself in the geometry it annotates, the ceiling from flying off-screen
 *  at extreme zoom. */
export const MIN_PLACE_PX = 18;
export const MAX_PLACE_PX = 600;

const PROJECTED_PAIR_MSG =
  `${PROJECTED_FIXED_MSG} — pick a second entity to dimension to it`;
const CONCENTRIC_MSG =
  "These circles are concentric — centre distance is 0. Dimension each diameter, or " +
  "right-click → Pick Circle/Arc Tangent before each pick for the radial gap (wall thickness).";

// --- small geometry helpers (kept local; all take plain {x,y}) ---------------

const segLen = (s: Seg) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

/** unit direction of a segment, or null when degenerate */
function dirOf(s: Seg): { x: number; y: number } | null {
  const len = segLen(s);
  if (len < MEASURE_EPS) return null;
  return { x: (s.x2 - s.x1) / len, y: (s.y2 - s.y1) / len };
}

/** perpendicular distance from a point to the INFINITE line through `s` */
function perpDist(p: { x: number; y: number }, s: Seg): number {
  const len = segLen(s) || 1;
  return Math.abs((p.x - s.x1) * (s.y2 - s.y1) - (p.y - s.y1) * (s.x2 - s.x1)) / len;
}

/** foot of the perpendicular from `p` onto the infinite line through `s` */
function footOf(p: { x: number; y: number }, s: Seg): V {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2;
  return v(s.x1 + t * dx, s.y1 + t * dy);
}

const mid = (a: V, b: V) => a.clone().add(b).multiplyScalar(0.5);

/** the dimRefPoints index of an entity's CENTRE, or null if it has none.
 *  (circles expose their centre at 0, arcs at 2 — native and projected alike) */
function centreIndex(e: ResolvedEntity): number | null {
  if (e.type === "circle") return 0;
  if (e.type === "arc") return 2;
  if (e.type === "projected") {
    if (e.curve.kind === "circle") return 0;
    if (e.curve.kind === "arc") return 2;
  }
  return null;
}

/** stable identity of a pick — used to reject picking the same thing twice */
export function targetKey(t: DimTarget): string {
  if (t.kind === "point") return `point:${t.e.id}:${t.p}`;
  if (t.kind === "edge") return `edge:${t.e.id}~${t.k}`;
  return `entity:${t.e.id}`;
}

/** targetKey plus the rim/tangent MODE. Deliberately separate: the mode must not
 *  make a re-pick of the same geometry look like a new operand (targetKey drives
 *  the "already picked ⇒ this click places" rule), but it DOES change which
 *  dimension the open value box belongs to. */
export function targetIdentity(t: DimTarget): string {
  return t.kind !== "edge" && t.rim ? `${targetKey(t)}~rim` : targetKey(t);
}

/** whether a pick can carry the rim/tangent mode at all (a circle or an arc) */
export function isRoundTarget(t: DimTarget): boolean {
  return t.kind !== "edge" && asRound(t.e) !== null && centreIndex(t.e) !== null;
}

// --- picking -----------------------------------------------------------------

/** THE dimension-tool pick. Reference points win over curve bodies, EXCEPT that
 *  a circle/arc RIM beats its own centre when the cursor is within tolerance of
 *  both (a small circle would otherwise always resolve to its centre and lose
 *  its diameter dim — and for a pair dim the outcome is identical, since an
 *  entity pick reduces to the centre anyway).
 *
 *  Deliberately has NO "clicked inside a circle ⇒ that circle's centre"
 *  fallback: it is what made a small circle drawn inside a big one resolve to
 *  the BIG circle. A rim click is now itself a valid distance operand, which
 *  serves the same need better. */
export function pickDimTarget(ents: ResolvedEntity[], p: V, tol: number): DimTarget | null {
  let best: { e: ResolvedEntity; p: number; pos: V } | null = null;
  let bestD = tol * tol;
  for (const e of ents) {
    for (const r of dimRefPoints(e)) {
      const dx = r.pos.x - p.x, dy = r.pos.y - p.y, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = { e, p: r.p, pos: r.pos }; }
    }
  }
  if (best) {
    const round = asRound(best.e);
    if (round && centreIndex(best.e) === best.p) {
      const dRim = Math.abs(Math.hypot(p.x - round.x, p.y - round.y) - round.r);
      if (dRim <= tol) return { kind: "entity", e: best.e };
    }
    return { kind: "point", e: best.e, p: best.p, pos: best.pos.clone() };
  }
  const idx = pickEntity(ents, p, tol);
  const e = idx >= 0 ? ents[idx] : undefined;
  if (!e) return null;
  if (e.type === "rectangle") {
    const c = rectCorners(e.x, e.y, e.width, e.height);
    let bk = 0, bd = Infinity;
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      if (!a || !b) continue;
      const d = distToSeg(a, b, p);
      if (d < bd) { bd = d; bk = k; }
    }
    const a = c[bk], b = c[(bk + 1) % 4];
    if (!a || !b) return null;
    return { kind: "edge", e, k: bk, a: a.clone(), b: b.clone() };
  }
  return { kind: "entity", e };
}

/** Re-resolve a pick against a fresh entity list (the solver hands back NEW
 *  entity objects, so a held reference goes stale). Null = the picked geometry
 *  is gone and the pick must be dropped. */
export function rebindTarget(t: DimTarget, ents: ResolvedEntity[]): DimTarget | null {
  const e = ents.find((x) => x.id === t.e.id);
  if (!e) return null;
  const rim = t.kind !== "edge" && t.rim ? { rim: true as const } : {};
  if (t.kind === "entity") return { kind: "entity", e, ...rim };
  if (t.kind === "point") {
    const r = dimRefPoints(e).find((q) => q.p === t.p);
    return r ? { kind: "point", e, p: t.p, pos: r.pos.clone(), ...rim } : null;
  }
  if (e.type !== "rectangle") return null;
  const c = rectCorners(e.x, e.y, e.width, e.height);
  const a = c[t.k], b = c[(t.k + 1) % 4];
  return a && b ? { kind: "edge", e, k: t.k, a: a.clone(), b: b.clone() } : null;
}

/** Clamp a frozen label placement into the sane screen-space band. `mmPerPx <= 0`
 *  (no zoom context, e.g. unit tests) leaves it untouched.
 *
 *  Null = "don't freeze a placement at all": the offset is stored in sketch MM
 *  but the floor is a SCREEN distance, so forcing a sub-floor click up to the
 *  floor would, at a zoomed-out mm/px, turn a 1 px click into a 300 mm offset
 *  and throw the label off-screen at every other zoom. Below the floor the
 *  renderer's own pixel-aware offset (entityDims.dimOffset) is the right answer. */
export function clampPlace(dx: number, dy: number, mmPerPx: number): PlaceOffset | null {
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  if (!(mmPerPx > 0)) return { ox: r4(dx), oy: r4(dy) };
  const lo = MIN_PLACE_PX * mmPerPx, hi = MAX_PLACE_PX * mmPerPx;
  const len = Math.hypot(dx, dy);
  if (len < lo) return null; // too close to the geometry to be a deliberate placement
  const s = Math.min(len, hi) / len;
  return { ox: r4(dx * s), oy: r4(dy * s) };
}

// --- operand reduction -------------------------------------------------------

interface PointOp { kind: "point"; eid: string; p: number; pos: V; round: boolean; fixed: boolean; roundOf?: Round }
interface LineOp { kind: "line"; opId: string; eid: string; p0: number; seg: Seg; fixed: boolean }
/** a circle/arc contributing its RIM (tangent mode) rather than its centre */
interface RoundOp { kind: "round"; eid: string; c: Round; fixed: boolean }
type Operand = PointOp | LineOp | RoundOp;

/** The "this kind of geometry has no dimension yet" message. Exported because
 *  SketchMode raises it for TEXT, which `pickEntity` can never return (text has
 *  no entitySegments — it is hit-tested through its glyph bounding box). */
export const unsupportedMessage = (kind: string): string =>
  `A ${kind} can't be dimensioned yet — pick a line, arc, circle or rectangle edge.`;

const unsupported = (e: ResolvedEntity): DimError => ({
  error: "unsupported",
  message: unsupportedMessage(e.type),
});

const degenerate = (what: string): DimError => ({
  error: "degenerate",
  message: `That ${what} measures 0 — nothing to drive.`,
});

/** A pick reduced to what the constraint schema can actually reference: a
 *  point (entity id + `p` index) or a line operand (possibly a rect edge).
 *  `p0` is the line's start point as a point operand — for a rect edge that is
 *  corner k, which is exactly what makes a parallel-lines distance work on
 *  rectangle sides. */
function reduce(t: DimTarget): Operand | DimError {
  const fixed = t.e.type === "projected";
  // rim/tangent mode: the pick contributes its EDGE. Silently inert on anything
  // that isn't a circle/arc — the arm stays live in SketchMode until a round
  // consumes it, so a stray line pick must not be an error.
  if (t.kind !== "edge" && t.rim) {
    const rd = asRound(t.e);
    if (rd && centreIndex(t.e) !== null) {
      if (rd.r < MEASURE_EPS) return degenerate(t.e.type === "arc" ? "arc" : "circle");
      return { kind: "round", eid: t.e.id, c: rd, fixed };
    }
  }
  if (t.kind === "point") {
    // a picked circle/arc CENTRE is a round operand — otherwise picking the
    // shared centre of two concentric circles reports "coincident points"
    // instead of the concentric message that names the real situation
    const round = centreIndex(t.e) === t.p;
    // carry the circle/arc itself: two concentric circles have NO meaningful
    // centre distance, so the pair resolves to their radial gap instead
    const rd0 = round ? asRound(t.e) : null;
    return { kind: "point", eid: t.e.id, p: t.p, pos: t.pos.clone(), round, fixed, ...(rd0 ? { roundOf: rd0 } : {}) };
  }
  if (t.kind === "edge") {
    return {
      kind: "line", opId: `${t.e.id}~${t.k}`, eid: t.e.id, p0: t.k,
      seg: { x1: t.a.x, y1: t.a.y, x2: t.b.x, y2: t.b.y }, fixed,
    };
  }
  const e = t.e;
  const ls = asLineSeg(e);
  if (ls) {
    // asLineSeg hands back the entity itself for a native line — copy only the
    // 4 coordinates so a Seg never carries an entity's id/type along
    const seg: Seg = { x1: ls.x1, y1: ls.y1, x2: ls.x2, y2: ls.y2 };
    return { kind: "line", opId: e.id, eid: e.id, p0: 0, seg, fixed };
  }
  const rd = asRound(e);
  const ci = centreIndex(e);
  if (rd && ci !== null) {
    return { kind: "point", eid: e.id, p: ci, pos: v(rd.x, rd.y), round: true, fixed, roundOf: rd };
  }
  return unsupported(e);
}

// --- plan builders -----------------------------------------------------------

function buildPlan(spec: {
  kind: DimPlan["kind"];
  field: string;
  label: string;
  fieldKind: "length" | "angle";
  value: number;
  anchors: { a: V; b: V } | null;
  labelAnchor: V | null;
  make: (value: number, place?: PlaceOffset) => SketchConstraint;
  forceDriven?: boolean;
  parallelPair?: { l1: string; l2: string };
  implyConcentric?: { c1: string; c2: string };
  hint: string;
}): DimPlan {
  const fields: DimFieldDef[] = [{ name: spec.field, label: spec.label, kind: spec.fieldKind }];
  const anchors = spec.anchors;
  const labelAnchor = spec.labelAnchor;
  return {
    kind: spec.kind,
    field: spec.field,
    fields,
    fieldKey: `${spec.field}:${spec.fieldKind}`,
    measure: () => spec.value,
    anchors: () => (anchors ? { a: anchors.a.clone(), b: anchors.b.clone() } : null),
    labelAnchor: () => labelAnchor?.clone() ?? null,
    make: spec.make,
    ...(spec.forceDriven ? { forceDriven: true } : {}),
    ...(spec.parallelPair ? { parallelPair: spec.parallelPair } : {}),
    ...(spec.implyConcentric ? { implyConcentric: spec.implyConcentric } : {}),
    hint: spec.hint,
  };
}

/** the shared distance plan: point-to-point, centre-to-centre, and the
 *  edge-length special case all land here */
function p2pPlan(a: PointOp, b: PointOp, forceDriven: boolean, hint: string): DimPlan {
  return buildPlan({
    kind: "distance", field: "distance", label: "D", fieldKind: "length",
    value: a.pos.distanceTo(b.pos),
    anchors: { a: a.pos, b: b.pos },
    labelAnchor: mid(a.pos, b.pos),
    forceDriven,
    hint,
    make: (value, place) => ({
      type: "p2pDistance", e1: a.eid, p1: a.p, e2: b.eid, p2: b.p, value,
      ...(place ? { place } : {}),
    }),
  });
}

/** point (or a line's start point) to a line operand: the perpendicular distance */
function p2lPlan(
  pt: PointOp, ln: LineOp, forceDriven: boolean, hint: string,
  parallelPair?: { l1: string; l2: string },
): DimPlan {
  const foot = footOf(pt.pos, ln.seg);
  return buildPlan({
    kind: "distance", field: "distance", label: "D", fieldKind: "length",
    value: perpDist(pt.pos, ln.seg),
    anchors: { a: pt.pos, b: foot },
    labelAnchor: mid(pt.pos, foot),
    forceDriven,
    ...(parallelPair ? { parallelPair } : {}),
    hint,
    make: (value, place) => ({
      type: "p2lDistance", e: pt.eid, p: pt.p, line: ln.opId, value,
      ...(place ? { place } : {}),
    }),
  });
}

// --- rim (edge-to-edge) plans ------------------------------------------------
// Every measure and every annotation pair comes from entityDims, which is also
// what the solve guard re-checks — one definition of "what the edge distance is".

/** Two rims. Concentric ⇒ the SIGNED radial gap (wall thickness) on planegcs
 *  `difference`, which is the only formulation that cannot solve an annulus
 *  inside-out. Otherwise the minimum edge-to-edge clearance on `c2cdistance`;
 *  overlapping rims have no clearance to drive and are refused. */
function roundRoundPlan(a: RoundOp, b: RoundOp, forceDriven: boolean, drivenHint: string): DimResolution {
  // Two picks can name the same circle by different routes (its rim and its
  // centre) — without this they read as two coincident, equal rims and the
  // radial-gap branch would report "the same circle" instead of the truth.
  if (a.eid === b.eid) {
    return { error: "same-entity", message: "That is one circle picked twice — pick a second entity to measure to." };
  }
  const d = Math.hypot(b.c.x - a.c.x, b.c.y - a.c.y);
  if (d < MEASURE_EPS) {
    const gap = Math.abs(b.c.r - a.c.r);
    if (gap < MEASURE_EPS) {
      return { error: "degenerate", message: "These two rims are the same circle — the radial gap measures 0." };
    }
    const inner = a.c.r <= b.c.r ? a : b;
    const outer = a.c.r <= b.c.r ? b : a;
    const pts = radialGapPoints(inner.c, outer.c, v(1, 0));
    const innerId = inner.eid, outerId = outer.eid;
    return buildPlan({
      kind: "distance", field: "gap", label: "Gap", fieldKind: "length",
      value: gap,
      anchors: pts,
      labelAnchor: mid(pts.a, pts.b),
      forceDriven,
      implyConcentric: { c1: innerId, c2: outerId },
      hint: `Radial gap (wall thickness): type a value · click to place${drivenHint}`,
      make: (value, place) => ({
        type: "radialGap", inner: innerId, outer: outerId, value, ...(place ? { place } : {}),
      }),
    });
  }
  const gap = rimGap(a.c, b.c);
  const sum = a.c.r + b.c.r;
  const diff = Math.abs(a.c.r - b.c.r);
  // classify from the GEOMETRY, not from rimGap's sign: its two branches meet
  // with a jump at internal tangency, so the sign alone would call a pair of
  // internally-tangent rims "overlapping"
  if (Math.abs(d - sum) < MEASURE_EPS || Math.abs(d - diff) < MEASURE_EPS) {
    return { error: "degenerate", message: "These two rims touch — the edge-to-edge distance measures 0, nothing to drive." };
  }
  if (d > diff && d < sum) {
    return {
      error: "overlapping",
      message: "These two circles overlap — there is no edge-to-edge clearance to dimension. " +
        "Dimension their centres, or each diameter.",
    };
  }
  const nested = d < diff;
  // normalised by operand id, not pick order, so dimensioning the same pair the
  // other way round REPLACES the dim (setDrivingDimension's dedup) instead of
  // creating a second one
  const [o1, o2] = a.eid <= b.eid ? [a, b] : [b, a];
  const pts = rimGapPoints(a.c, b.c, v(1, 0));
  const id1 = o1.eid, id2 = o2.eid;
  return buildPlan({
    kind: "distance", field: "distance", label: "D", fieldKind: "length",
    value: gap,
    anchors: pts,
    labelAnchor: mid(pts.a, pts.b),
    forceDriven,
    hint: `${nested ? "Minimum radial clearance" : "Edge-to-edge clearance"}: type a value · click to place${drivenHint}`,
    make: (value, place) => ({
      type: "c2cDistance", c1: id1, c2: id2, value, ...(place ? { place } : {}),
    }),
  });
}

/** A rim and a line operand: planegcs `c2ldistance` = |perp(centre, line)| - r.
 *  A line that CROSSES the circle has no edge-to-edge distance — refused rather
 *  than driven to a negative number the solver would satisfy by flipping. */
function roundLinePlan(rd: RoundOp, ln: LineOp, forceDriven: boolean, drivenHint: string): DimResolution {
  if (segLen(ln.seg) < MEASURE_EPS) return degenerate("line");
  const pts = lineRimPoints(ln.seg, rd.c);
  if (!pts) {
    return { error: "point-on-line", message: "That circle's centre lies on the line — there is no edge-to-edge distance to dimension." };
  }
  const gap = perpDist(rd.c, ln.seg) - rd.c.r;
  if (gap < -MEASURE_EPS) {
    return {
      error: "crossing",
      message: "That line crosses the circle — there is no edge-to-edge distance to dimension. " +
        "Dimension the centre to the line instead.",
    };
  }
  if (gap < MEASURE_EPS) {
    return { error: "degenerate", message: "That line is tangent to the circle — the edge-to-edge distance measures 0, nothing to drive." };
  }
  const cid = rd.eid, lid = ln.opId;
  return buildPlan({
    kind: "distance", field: "distance", label: "D", fieldKind: "length",
    value: gap,
    anchors: pts,
    labelAnchor: mid(pts.a, pts.b),
    forceDriven,
    hint: `Edge-to-line distance: type a value · click to place${drivenHint}`,
    make: (value, place) => ({
      type: "c2lDistance", circle: cid, line: lid, value, ...(place ? { place } : {}),
    }),
  });
}

/** A point and a rim: planegcs `p2cdistance` = |dist(p, centre) - r|. Works from
 *  either side of the rim; the solve guard keeps the point on the side it was
 *  dimensioned from. */
function pointRoundPlan(pt: PointOp, rd: RoundOp, forceDriven: boolean, drivenHint: string): DimResolution {
  const d = Math.hypot(pt.pos.x - rd.c.x, pt.pos.y - rd.c.y);
  if (d < MEASURE_EPS) {
    return {
      error: "coincident-points",
      message: "That point sits at the circle's centre — the distance to its edge IS its radius, " +
        "so dimension the radius instead.",
    };
  }
  const gap = Math.abs(d - rd.c.r);
  if (gap < MEASURE_EPS) {
    return { error: "degenerate", message: "That point lies on the circle — the distance to the edge measures 0, nothing to drive." };
  }
  const pts = pointRimPoints(pt.pos, rd.c);
  if (!pts) return degenerate("circle");
  const eid = pt.eid, p = pt.p, cid = rd.eid;
  return buildPlan({
    kind: "distance", field: "distance", label: "D", fieldKind: "length",
    value: gap,
    anchors: pts,
    labelAnchor: mid(pts.a, pts.b),
    forceDriven,
    hint: `Point-to-edge distance: type a value · click to place${drivenHint}`,
    make: (value, place) => ({
      type: "p2cDistance", e: eid, p, circle: cid, value, ...(place ? { place } : {}),
    }),
  });
}

// --- resolution --------------------------------------------------------------

/** Map 0-2 picks onto the dimension they describe. Pure: every input is in the
 *  targets, every failure is a named DimError carrying its own toast text. */
export function resolveDim(picks: DimTarget[], opts: DimOptions = {}): DimResolution {
  const [t1, t2] = picks;
  if (!t1) return { error: "need-second", message: "", keepPicks: true };
  if (!t2) return resolveSingle(t1, opts);
  if (targetKey(t1) === targetKey(t2)) return { error: "same-entity", message: "" };
  return resolvePair(t1, t2);
}

function resolveSingle(t: DimTarget, opts: DimOptions): DimResolution {
  const e = t.e;
  if (t.kind === "edge") {
    const len = t.a.distanceTo(t.b);
    if (len < MEASURE_EPS) return degenerate("edge");
    // a rectangle edge's length IS the distance between its two corners
    const a: PointOp = { kind: "point", eid: e.id, p: t.k, pos: t.a, round: false, fixed: false };
    const b: PointOp = { kind: "point", eid: e.id, p: (t.k + 1) % 4, pos: t.b, round: false, fixed: false };
    return p2pPlan(a, b, false, "Rectangle edge: type a length, or pick a second entity · click to place");
  }
  if (t.kind === "point") {
    return {
      error: "need-second", keepPicks: true,
      message: e.type === "projected"
        ? PROJECTED_PAIR_MSG
        : "Pick a second point, or a line, for the distance between them",
    };
  }
  // whole-entity pick
  if (e.type === "projected") {
    // fixed reference geometry has no driving dim of its own, but IS a valid
    // pair operand — stay armed
    return { error: "projected-single", keepPicks: true, message: PROJECTED_PAIR_MSG };
  }
  const ls = asLineSeg(e);
  if (ls) {
    const len = Math.hypot(ls.x2 - ls.x1, ls.y2 - ls.y1);
    if (len < MEASURE_EPS) return degenerate("line");
    const a = v(ls.x1, ls.y1), b = v(ls.x2, ls.y2);
    const eid = e.id;
    return buildPlan({
      kind: "length", field: "length", label: "L", fieldKind: "length",
      value: len,
      anchors: { a, b },
      labelAnchor: null, // `distance` renders through entityDims — no place slot
      hint: "Line: type a length, or pick a second entity · click to place",
      make: (value) => ({ type: "distance", line: eid, value }),
    });
  }
  if (e.type === "circle") {
    if (e.radius < MEASURE_EPS) return degenerate("circle");
    const eid = e.id;
    if (opts.roundPref === "radius") return roundValuePlan(eid, e.radius, v(e.x, e.y), "Circle");
    return buildPlan({
      kind: "diameter", field: "diameter", label: "⌀", fieldKind: "length",
      value: e.radius * 2,
      anchors: { a: v(e.x - e.radius, e.y), b: v(e.x + e.radius, e.y) },
      labelAnchor: null, // `diameter` renders through entityDims — no place slot
      hint: "Circle: type a diameter, or pick a second entity · click to place",
      make: (value) => ({ type: "diameter", circle: eid, value }),
    });
  }
  if (e.type === "arc") {
    const rd = asRound(e);
    if (!rd || rd.r < MEASURE_EPS) return degenerate("arc");
    const eid = e.id;
    const c = v(rd.x, rd.y);
    if (opts.roundPref === "diameter") {
      return buildPlan({
        kind: "diameter", field: "diameter", label: "⌀", fieldKind: "length",
        value: rd.r * 2,
        anchors: { a: v(rd.x - rd.r, rd.y), b: v(rd.x + rd.r, rd.y) },
        labelAnchor: null, // `diameter` has no place slot (see types.ts)
        hint: "Arc: type a diameter, or pick a second entity · click to place",
        make: (value) => ({ type: "diameter", circle: eid, value }),
      });
    }
    return roundValuePlan(eid, rd.r, c, "Arc");
  }
  return unsupported(e);
}

/** the radius plan, shared by an arc (its default) and a circle whose
 *  right-click override asked for a radius instead of a diameter */
function roundValuePlan(eid: string, r: number, c: V, what: string): DimPlan {
  return buildPlan({
    kind: "radius", field: "radius", label: "R", fieldKind: "length",
    value: r,
    anchors: { a: c, b: v(c.x + r * Math.SQRT1_2, c.y + r * Math.SQRT1_2) },
    labelAnchor: c,
    hint: `${what}: type a radius, or pick a second entity · click to place`,
    make: (value, place) => ({ type: "radius", e: eid, value, ...(place ? { place } : {}) }),
  });
}

function resolvePair(t1: DimTarget, t2: DimTarget): DimResolution {
  const r = pairPlan(t1, t2);
  // "the first-picked entity moves" — stamped HERE, at the one place that still
  // knows the pick order. Every branch below normalises its operands by entity
  // id (so re-dimensioning the same pair the other way round REPLACES the dim
  // rather than adding a second one), and `lineLine` swaps them outright, so
  // nothing further down can be asked for this. A rectangle EDGE pick reports
  // the rectangle, which is the entity the bias moves.
  if (!isDimError(r)) r.moves = t1.e.id;
  return r;
}

function pairPlan(t1: DimTarget, t2: DimTarget): DimResolution {
  const o1 = reduce(t1);
  if ("error" in o1) return o1;
  const o2 = reduce(t2);
  if ("error" in o2) return o2;
  const a = o1, b = o2;
  // both operands fixed ⇒ nothing can move to satisfy a driving dim: make it a
  // reference (driven) dim instead of an unsatisfiable one
  const forceDriven = a.fixed && b.fixed;
  const drivenHint = forceDriven ? " · reference geometry — created as a driven dimension" : "";
  // --- rim (tangent) rows: at least one operand contributes its EDGE ---------
  if (a.kind === "round" || b.kind === "round") {
    const rd = a.kind === "round" ? a : (b as RoundOp);
    const other = a.kind === "round" ? b : a;
    if (other.kind === "round") return roundRoundPlan(rd, other, forceDriven, drivenHint);
    if (other.kind === "line") return roundLinePlan(rd, other, forceDriven, drivenHint);
    if (other.eid === rd.eid) {
      // the round's own centre picked alongside its rim: that is its radius
      return { error: "same-entity", message: "That is the circle's own centre and rim — dimension its radius instead." };
    }
    return pointRoundPlan(other, rd, forceDriven, drivenHint);
  }
  if (a.kind === "point" && b.kind === "point") {
    if (a.eid === b.eid && a.p === b.p) return { error: "same-entity", message: "" };
    const d = a.pos.distanceTo(b.pos);
    if (d < MEASURE_EPS) {
      // Two CONCENTRIC circles/arcs: their centre distance is 0 and always will
      // be, so there is nothing to disambiguate — the only dimension that means
      // anything here is the radial gap (wall thickness). Resolve straight to
      // it rather than making the user arm tangent mode for the one possible
      // answer. Tangent mode still matters for circles that are NOT concentric,
      // where centre-to-centre and rim-to-rim are both meaningful.
      if (a.roundOf && b.roundOf && a.eid !== b.eid) {
        return roundRoundPlan(
          { kind: "round", eid: a.eid, c: a.roundOf, fixed: a.fixed },
          { kind: "round", eid: b.eid, c: b.roundOf, fixed: b.fixed },
          forceDriven, drivenHint,
        );
      }
      return a.round && b.round
        ? { error: "concentric", message: CONCENTRIC_MSG }
        : { error: "coincident-points", message: "Those two points are coincident — the distance measures 0, nothing to drive." };
    }
    return p2pPlan(a, b, forceDriven, `Distance: type a value · click to place${drivenHint}`);
  }
  if (a.kind === "point" || b.kind === "point") {
    const pt = a.kind === "point" ? a : (b as PointOp);
    const ln = a.kind === "line" ? a : (b as LineOp);
    if (segLen(ln.seg) < MEASURE_EPS) return degenerate("line");
    if (perpDist(pt.pos, ln.seg) < MEASURE_EPS) {
      return { error: "point-on-line", message: "That point lies on the line — the distance measures 0, nothing to drive." };
    }
    return p2lPlan(pt, ln, forceDriven, `Distance to line: type a value · click to place${drivenHint}`);
  }
  return lineLine(a, b, forceDriven, drivenHint);
}

function lineLine(l1: LineOp, l2: LineOp, forceDriven: boolean, drivenHint: string): DimResolution {
  if (l1.opId === l2.opId) return { error: "same-entity", message: "" };
  const d1 = dirOf(l1.seg), d2 = dirOf(l2.seg);
  if (!d1 || !d2) return degenerate("line");
  const sinT = Math.abs(d1.x * d2.y - d1.y * d2.x);
  if (sinT >= PARALLEL_EPS) {
    const s1 = l1.seg, s2 = l2.seg;
    const m1 = v((s1.x1 + s1.x2) / 2, (s1.y1 + s1.y2) / 2);
    const m2 = v((s2.x1 + s2.x2) / 2, (s2.y1 + s2.y2) / 2);
    const id1 = l1.opId, id2 = l2.opId;
    return buildPlan({
      kind: "angle", field: "angle", label: "∠", fieldKind: "angle",
      value: signedAngleDeg(s1, s2),
      anchors: null, // an angle dim renders as a bare value (see entityDims)
      labelAnchor: mid(m1, m2),
      forceDriven,
      hint: `Angle: type the included angle · click to place${drivenHint}`,
      make: (value, place) => ({ type: "angle", l1: id1, l2: id2, value, ...(place ? { place } : {}) }),
    });
  }
  // Parallel: an angle dim here would read "0°" and drive nothing. Measure the
  // perpendicular distance instead, anchored at one line's OWN start point.
  //
  // Which line supplies that point is normalised by operand id, NOT by pick
  // order: setDrivingDimension's p2lDistance dedup matches on (e, p, line), so
  // a cursor- or order-dependent choice would let the SAME pair dimensioned the
  // other way round create a SECOND constraint instead of replacing the first.
  //
  // One p2lDistance is one equation — it pins one endpoint's distance and
  // leaves the pair free to rotate, so the typed gap would be the real gap
  // nowhere else. `parallelPair` is the second equation ("these two are
  // parallel"), which is exactly what "distance between two parallel lines"
  // means. Same-entity edges (two sides of one rectangle) are already held
  // parallel by the rectangle itself, so they don't ask for it.
  const [pl, ll] = l1.opId <= l2.opId ? [l1, l2] : [l2, l1];
  const pt: PointOp = {
    kind: "point", eid: pl.eid, p: pl.p0, pos: v(pl.seg.x1, pl.seg.y1), round: false, fixed: pl.fixed,
  };
  if (perpDist(pt.pos, ll.seg) < MEASURE_EPS) {
    return { error: "point-on-line", message: "Those lines are collinear — the distance measures 0, nothing to drive." };
  }
  const pair = pl.eid === ll.eid ? undefined : { l1: pl.opId, l2: ll.opId };
  return p2lPlan(pt, ll, forceDriven, `Parallel lines: type the distance · click to place${drivenHint}`, pair);
}
