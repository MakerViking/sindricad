// Auto horizontal/vertical inference for a freshly drawn line — and, more to the
// point, when NOT to apply it.
//
// Drawing a line within a few degrees of an axis silently makes it exact and
// records the constraint (mainstream MCAD's auto-constrain). Making it exact
// means MOVING an endpoint, and the old code always moved the SECOND one:
//
//     if (nearly horizontal) { e.y2 = e.y1; constraints.push(horizontal) }
//
// If that second endpoint had just been snapped onto an existing endpoint, the
// snap was destroyed on the spot — by exactly the angular error the user's hand
// left, which at ordinary zoom is hundredths of a millimetre. And because
// nothing emits a coincident CONSTRAINT on an endpoint snap, there was nothing
// to pull it back:
//
//   "What appears to be automatic coincidence constraint detection between lines
//    does not work properly. Instead of making their endpoints perfectly
//    coincident, the tool creates a very small gap of a few hundredths of a
//    millimetre. These micro-gaps prevent the lines from being truly joined and
//    can subsequently cause cracks during extrusion, as well as undetected or
//    missing regions." (field report ecc3e0d6)
//
// The rule here: never move a point the user placed on existing geometry. Move
// the free end instead, and when both ends are pinned, leave the line alone —
// its angle is a consequence of two deliberate placements and is not ours to
// round off.
//
// NOTE, because a green test file should not imply more than it covers: this
// stops auto-H/V from BREAKING a join. Making a SNAPPED join survive later
// edits is the coincident a snap now emits (snapCoincidences in snap.ts). A
// chained segment's start counts as pinned (commitFromCursor), since it is the
// end of the segment just committed, and since 2026-10 that joint carries a
// coincident too: the corners inside one chain of lines are joined, not just
// placed on each other (GitHub #17).
//
// Perpendicular and tangent (decision B7, GitHub #17) are inferred at a JOINT:
// the end of a new line or arc that sits on the end of a line or arc already
// there. Within the same 3 degrees as H/V, with the same pinning rule, and
// below H/V: a line within 3 degrees of an axis gets H or V and never also a
// perpendicular, since both take away the one freedom it has left to turn, so
// the second could only be redundant or drag the other line round to suit.

import { circumcenter } from "./arc";
import { asLineSeg } from "./entityDims";
import { JOIN_TOL, type ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

/** A line's two endpoints, as plain numbers. */
export interface LineEnds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface AutoHVResult {
  /** the constraint to record, or null to record none */
  kind: "horizontal" | "vertical" | null;
  /** endpoints after the correction (unchanged when kind is null) */
  ends: LineEnds;
  /** which endpoint was moved to make the line exact — for tests and for anyone
   *  wondering why a point shifted */
  moved: "start" | "end" | null;
}

export interface AutoHVOptions {
  /** the line's START was placed on existing geometry and must not move */
  startPinned?: boolean;
  /** the line's END was placed on existing geometry and must not move */
  endPinned?: boolean;
  /** how close to an axis counts, in degrees */
  toleranceDeg?: number;
}

const DEFAULT_TOL_DEG = 3;

/** Decide whether a line should be made exactly horizontal or vertical, and
 *  which end to move to do it. */
export function inferHorizontalVertical(e: LineEnds, opts: AutoHVOptions = {}): AutoHVResult {
  const tol = opts.toleranceDeg ?? DEFAULT_TOL_DEG;
  const unchanged: AutoHVResult = { kind: null, ends: { ...e }, moved: null };

  // Both ends deliberately placed: the angle is what the user asked for, and
  // there is no end left that is free to move.
  if (opts.startPinned && opts.endPinned) return unchanged;

  const deg = (Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180) / Math.PI;
  const norm = ((deg % 180) + 180) % 180; // 0..180
  const horizontal = Math.min(norm, 180 - norm) <= tol;
  const vertical = Math.abs(norm - 90) <= tol;
  if (!horizontal && !vertical) return unchanged;

  // A zero-length line has no meaningful angle; atan2(0,0) is 0, which would
  // read as "horizontal" and add a constraint to a degenerate segment.
  if (e.x1 === e.x2 && e.y1 === e.y2) return unchanged;

  // Move the end that is NOT pinned. Default (neither pinned) keeps the old
  // behaviour of moving the second point, so an ordinary free-hand draw feels
  // exactly as it did.
  const moveStart = !!opts.startPinned === false && !!opts.endPinned === true;
  const ends = { ...e };
  if (horizontal) {
    if (moveStart) ends.y1 = e.y2;
    else ends.y2 = e.y1;
  } else {
    if (moveStart) ends.x1 = e.x2;
    else ends.x2 = e.x1;
  }
  return { kind: horizontal ? "horizontal" : "vertical", ends, moved: moveStart ? "start" : "end" };
}

/** Snap kinds that mean "this point sits on existing geometry". A grid or free
 *  point is the user's hand, not a join, so auto-H/V may still move it. */
export function isGeometrySnap(kind: string): boolean {
  return kind === "endpoint" || kind === "midpoint" || kind === "center" || kind === "tangent";
}

// --- perpendicular and tangent at a joint ------------------------------------

/** A line or arc with an END where a new entity's end landed: the curve a
 *  perpendicular or a tangent would be inferred against. */
export interface JoinedCurve {
  id: string;
  kind: "line" | "arc";
  /** the curve's direction at the joint, unit length. Either sense: both
   *  relations inferred here are undirected, as their constraints are. */
  dir: { x: number; y: number };
}

/** A tangent the curves already have, up to float noise. What lets a tangent
 *  ride along with an H/V (or with the other end of an arc) without moving
 *  anything already drawn: it holds as drawn, so nothing has to give. */
const EXACT_RAD = 1e-7;

const unit = (x: number, y: number) => {
  const l = Math.hypot(x, y);
  return l > 0 ? { x: x / l, y: y / l } : null;
};

/** The acute angle between two directions, either sense, radians in [0, pi/2]. */
function lineAngle(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const c = Math.abs(a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || 1);
  return Math.acos(Math.min(1, c));
}

/** The tangent direction of a 3-point arc at one of its ends. */
function arcTangentAt(a: ArcPoints, end: "start" | "end") {
  const c = circumcenter({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: a.mx, y: a.my });
  if (!c) return null; // a straight "arc" has no circle to be tangent to
  const p = end === "start" ? { x: a.x1, y: a.y1 } : { x: a.x2, y: a.y2 };
  return unit(-(p.y - c.y), p.x - c.x);
}

/** The lines and arcs, drawn or projected, with an END on `at` (other than
 *  `self`), and their directions there. Construction geometry counts: a
 *  centre line is a fine thing to be square to. Shapes do not, since a
 *  rectangle's corner belongs to two sides and neither is a curve of its own. */
export function curvesEndingAt(
  entities: ResolvedEntity[],
  at: { x: number; y: number },
  self: string,
): JoinedCurve[] {
  const on = (x: number, y: number) => Math.abs(x - at.x) <= JOIN_TOL && Math.abs(y - at.y) <= JOIN_TOL;
  const out: JoinedCurve[] = [];
  for (const e of entities) {
    if (e.id === self) continue;
    const seg = asLineSeg(e);
    if (seg) {
      const dir = (on(seg.x1, seg.y1) || on(seg.x2, seg.y2)) && unit(seg.x2 - seg.x1, seg.y2 - seg.y1);
      if (dir) out.push({ id: e.id, kind: "line", dir });
      continue;
    }
    const arc = e.type === "arc" ? e : e.type === "projected" && e.curve.kind === "arc" ? e.curve : null;
    if (!arc) continue;
    const end = on(arc.x1, arc.y1) ? "start" : on(arc.x2, arc.y2) ? "end" : null;
    const dir = end && arcTangentAt(arc, end);
    if (dir) out.push({ id: e.id, kind: "arc", dir });
  }
  return out;
}

/** What a freshly drawn line is given: H or V, or a perpendicular or tangent
 *  to the curve at one of its ends. */
export type LineRelation =
  | { type: "horizontal" | "vertical" }
  | { type: "perpendicular" | "tangent"; other: string };

/** The constraints `relations` stand for on the line `id`. The new line goes
 *  first in each, so its badge is drawn on it (glyphs.ts). */
export function relationConstraints(id: string, relations: LineRelation[]): SketchConstraint[] {
  return relations.map((r): SketchConstraint =>
    r.type === "perpendicular" ? { type: "perpendicular", l1: id, l2: r.other }
    : r.type === "tangent" ? { type: "tangent2", a: id, b: r.other }
    : { type: r.type, line: id });
}

export interface LineInference {
  relations: LineRelation[];
  /** endpoints after the correction */
  ends: LineEnds;
  moved: "start" | "end" | null;
}

export interface LineInferenceOptions extends AutoHVOptions {
  /** the curves ending where the line STARTS (curvesEndingAt) */
  atStart?: JoinedCurve[];
  /** ...and where it ends */
  atEnd?: JoinedCurve[];
}

/** Decide the constraints a freshly drawn line is given, and which end moves
 *  to make them exact. H/V first, exactly as inferHorizontalVertical always
 *  decided it; failing that, a perpendicular to a line or a tangent to an arc
 *  at the PINNED end, the line turned about that end to make it exact, its
 *  length kept. A tangent that already holds at the H/V direction rides along
 *  with it: tangency to an arc says something about the arc, which an axis
 *  does not, and nothing has to move for it. */
export function inferLineRelations(e: LineEnds, opts: LineInferenceOptions = {}): LineInference {
  const tol = ((opts.toleranceDeg ?? DEFAULT_TOL_DEG) * Math.PI) / 180;
  const unchanged: LineInference = { relations: [], ends: { ...e }, moved: null };
  const hv = inferHorizontalVertical(e, opts);
  if (hv.kind) {
    // the end H/V did not move is the joint, when it was pinned there
    const joint = hv.moved === "start" ? opts.atEnd : opts.startPinned ? opts.atStart : undefined;
    const d = { x: hv.ends.x2 - hv.ends.x1, y: hv.ends.y2 - hv.ends.y1 };
    const ride = (joint ?? []).find((c) => c.kind === "arc" && lineAngle(d, c.dir) <= EXACT_RAD);
    return {
      relations: [{ type: hv.kind }, ...(ride ? [{ type: "tangent" as const, other: ride.id }] : [])],
      ends: hv.ends,
      moved: hv.moved,
    };
  }
  // The pinned end is the pivot; with both or neither pinned there is no free
  // end to turn, or no joint to turn it against.
  if (!!opts.startPinned === !!opts.endPinned) return unchanged;
  const fromStart = !!opts.startPinned;
  const pivot = fromStart ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
  const free = fromStart ? { x: e.x2, y: e.y2 } : { x: e.x1, y: e.y1 };
  const d = { x: free.x - pivot.x, y: free.y - pivot.y };
  const len = Math.hypot(d.x, d.y);
  if (len === 0) return unchanged;
  let best: { c: JoinedCurve; off: number } | null = null;
  for (const c of (fromStart ? opts.atStart : opts.atEnd) ?? []) {
    const between = lineAngle(d, c.dir);
    const off = c.kind === "arc" ? between : Math.PI / 2 - between;
    if (off <= tol && (!best || off < best.off)) best = { c, off };
  }
  if (!best) return unchanged;
  // the exact direction nearest the one drawn: along the arc's tangent, or
  // square to the line, whichever sense the user drew in
  const t = best.c.kind === "arc" ? best.c.dir : { x: -best.c.dir.y, y: best.c.dir.x };
  const sense = t.x * d.x + t.y * d.y < 0 ? -1 : 1;
  const to = { x: pivot.x + sense * t.x * len, y: pivot.y + sense * t.y * len };
  const ends = fromStart ? { ...e, x2: to.x, y2: to.y } : { ...e, x1: to.x, y1: to.y };
  return {
    relations: [{ type: best.c.kind === "arc" ? "tangent" : "perpendicular", other: best.c.id }],
    ends,
    moved: fromStart ? "end" : "start",
  };
}

/** A 3-point arc's defining points: its two ends and the point it passes through. */
export interface ArcPoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mx: number;
  my: number;
}

export interface ArcInference {
  /** the arc after the correction: the same ends, the bulge re-chosen */
  arc: ArcPoints;
  /** the curves it is now tangent to */
  tangents: string[];
}

/** Decide whether a freshly drawn 3-point arc is tangent to a line or arc it
 *  starts or ends on, within the same tolerance as H/V. Its two ends are where
 *  the user clicked (and usually snapped), so neither moves: the third click
 *  only chose the bulge, and the bulge is re-chosen so the arc leaves the
 *  joint exactly along the curve it continues. One joint is made exact, the
 *  nearer; the other end is tangent too only if it already is (a half-round
 *  between two parallel lines), since making it so would bend the curve there. */
export function inferArcTangents(
  a: ArcPoints,
  opts: { atStart?: JoinedCurve[]; atEnd?: JoinedCurve[]; toleranceDeg?: number } = {},
): ArcInference {
  const tol = ((opts.toleranceDeg ?? DEFAULT_TOL_DEG) * Math.PI) / 180;
  const unchanged: ArcInference = { arc: { ...a }, tangents: [] };
  let best: { c: JoinedCurve; off: number; end: "start" | "end" } | null = null;
  for (const end of ["start", "end"] as const) {
    const t = arcTangentAt(a, end);
    if (!t) return unchanged;
    for (const c of (end === "start" ? opts.atStart : opts.atEnd) ?? []) {
      const off = lineAngle(t, c.dir);
      if (off <= tol && (!best || off < best.off)) best = { c, off, end };
    }
  }
  if (!best) return unchanged;
  const P = best.end === "start" ? { x: a.x1, y: a.y1 } : { x: a.x2, y: a.y2 };
  const Q = best.end === "start" ? { x: a.x2, y: a.y2 } : { x: a.x1, y: a.y1 };
  // The circle through P and Q that leaves P along the joint's direction: its
  // centre is on the normal at P, equally far from P and Q.
  const n = { x: -best.c.dir.y, y: best.c.dir.x };
  const qp = { x: P.x - Q.x, y: P.y - Q.y };
  const along = n.x * qp.x + n.y * qp.y;
  const chord2 = qp.x * qp.x + qp.y * qp.y;
  if (Math.abs(along) < 1e-9 * chord2) return unchanged; // Q is on that direction: a straight line, not an arc
  const s = -chord2 / (2 * along);
  const C = { x: P.x + s * n.x, y: P.y + s * n.y };
  const r = Math.abs(s);
  // The new through-point is the arc's middle: on the chord's perpendicular
  // bisector, which the centre is on too, a radius from the centre, on the side
  // of the chord the user's through-point was on.
  const side = (x: number, y: number) => (Q.x - P.x) * (y - P.y) - (Q.y - P.y) * (x - P.x);
  const across = unit(-(Q.y - P.y), Q.x - P.x)!; // P and Q differ, or `along` was 0
  let mid = { x: C.x + across.x * r, y: C.y + across.y * r };
  if (Math.sign(side(mid.x, mid.y)) !== Math.sign(side(a.mx, a.my))) mid = { x: C.x - across.x * r, y: C.y - across.y * r };
  const arc = { ...a, mx: mid.x, my: mid.y };
  const tangents = [best.c.id];
  const other = best.end === "start" ? "end" : "start";
  const t = arcTangentAt(arc, other);
  const ride = t && ((other === "start" ? opts.atStart : opts.atEnd) ?? [])
    .find((c) => c.id !== best!.c.id && lineAngle(t, c.dir) <= EXACT_RAD);
  if (ride) tangents.push(ride.id);
  return { arc, tangents };
}
