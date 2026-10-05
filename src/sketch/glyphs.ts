// Constraint glyphs: a small on-canvas badge per GEOMETRIC constraint, showing
// its type and letting the user see/delete relationships (Fusion's "Show
// Constraints"). Dimensional constraints (distance/diameter/p2p/p2l/radius/angle)
// are NOT glyphed here — they already render as editable dimension badges.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { asRound, lineOperand, operandPoint } from "./entityDims";
import { entityPolyline } from "./region";

/** a quarter of a spline span, in entityPolyline's 16 samples per span */
const SPLINE_GLYPH_STEP = 4;

const V = (x: number, y: number) => new THREE.Vector2(x, y);

export interface ConstraintGlyph {
  cIndex: number; // index into the constraints array (delete target)
  label: string; // short symbol shown in the badge
  pos: THREE.Vector2; // 2D sketch-plane position
  /** A constraint that is not applied yet — the one this click WOULD add. Drawn
   *  in a muted style with no delete affordance.
   *
   *  Field report 636afdcb: "Automatic constraint detection works with both
   *  points and lines. However, when working with lines, there is no visual
   *  feedback indicating that a constraint will be applied before clicking. The
   *  visual feedback appears to work only with points." Point snaps have always
   *  drawn a marker as you hover; the horizontal/vertical inference on a line
   *  fired silently at commit, so the first sign of it was a glyph appearing on
   *  geometry that had already been drawn. */
  pending?: true;
}

/** The solver's diagnosis of a constraint, or null if clean. Conflict (can't be
 *  satisfied) takes precedence over over-defined (redundant/removable). This is
 *  the single source of that precedence — glyph and dimension badges both use it,
 *  so their red/amber can't drift apart. */
export type ConstraintDiagnosis = "conflict" | "over";
export function diagnosisOf(i: number, conflict: Set<number>, over: Set<number>): ConstraintDiagnosis | null {
  return conflict.has(i) ? "conflict" : over.has(i) ? "over" : null;
}

/** representative point of an entity for glyph placement */
function entCenter(e: ResolvedEntity): THREE.Vector2 {
  switch (e.type) {
    case "line": return V((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2);
    case "arc": return V(e.mx, e.my);
    case "circle": case "point": case "rectangle": case "text": return V(e.x, e.y);
    case "polygon": return V(e.x, e.y);
    case "slot": return V((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2);
    case "spline": { const p = e.points[Math.floor(e.points.length / 2)] ?? e.points[0]; return p ? V(p.x, p.y) : V(0, 0); }
    case "projected": {
      const cv = e.curve;
      if (cv.kind === "line") return V((cv.x1 + cv.x2) / 2, (cv.y1 + cv.y2) / 2);
      if (cv.kind === "circle") return V(cv.x, cv.y);
      if (cv.kind === "arc") return V(cv.mx, cv.my);
      if (cv.kind === "point") return V(cv.x, cv.y);
      const p = cv.pts[Math.floor(cv.pts.length / 2)] ?? cv.pts[0];
      return p ? V(p[0], p[1]) : V(0, 0);
    }
  }
}

/** Where two tangent curves touch, or null when that is not one point.
 *
 *  Report 34bede7e: "the tangent constraint icon is a long way from the point
 *  of tangency". The badge sat halfway between the line's MIDPOINT and the
 *  arc's, which on a long line or a big arc is nowhere near where they meet.
 *  A line and a round touch at the foot of the round's centre on the line
 *  (taken as infinite, as the solver takes it). Two rounds touch on the line
 *  through their centres: `a`'s radius out from its centre towards `b`, or
 *  away from `b` when `a` sits inside it (internal tangency, `b` the larger).
 *  Read off the geometry as it is, so mid-solve it is merely near the point. */
function tangencyPoint(byId: Map<string, ResolvedEntity>, a: string, b: string): THREE.Vector2 | null {
  const round = (id: string) => {
    const e = byId.get(id);
    return e ? asRound(e) : null;
  };
  const ra = round(a), rb = round(b);
  const line = !ra ? lineOperand(byId, a) : !rb ? lineOperand(byId, b) : null;
  const r = ra ?? rb;
  if (line && r) {
    const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return null;
    const t = ((r.x - line.x1) * dx + (r.y - line.y1) * dy) / len2;
    return V(line.x1 + dx * t, line.y1 + dy * t);
  }
  if (!ra || !rb) return null;
  const d = Math.hypot(rb.x - ra.x, rb.y - ra.y);
  if (d < 1e-9) return null; // concentric: they touch everywhere or nowhere
  const ux = (rb.x - ra.x) / d, uy = (rb.y - ra.y) / d;
  const inside = Math.abs(d - Math.abs(ra.r - rb.r)) < Math.abs(d - (ra.r + rb.r)) && ra.r < rb.r;
  const k = inside ? -ra.r : ra.r;
  return V(ra.x + ux * k, ra.y + uy * k);
}

export function constraintGlyphs(ents: ResolvedEntity[], constraints: SketchConstraint[]): ConstraintGlyph[] {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const out: ConstraintGlyph[] = [];
  /** Where a constraint's badge sits for an operand id. A LINE operand is tried
   *  first, through the app's own decoder, because a rectangle EDGE (`R~k`) has
   *  no entity of its own: without this the badge for the seven line tools'
   *  newest legal pick would be dropped entirely — no amber for the redundant
   *  `horizontal`, and nothing to right-click to delete it. Falls back to the
   *  entity centre for circles/arcs and for a bare rectangle id. */
  const center = (id: string): THREE.Vector2 | null => {
    const seg = lineOperand(byId, id);
    if (seg) return V((seg.x1 + seg.x2) / 2, (seg.y1 + seg.y2) / 2);
    if (id.includes("~")) return null; // a malformed edge id names nothing
    const e = byId.get(id);
    return e ? entCenter(e) : null;
  };
  // A point operand: an entity and its `p`, or a line operand and one of its
  // ends (`R~k` p0/p1, and a slot side's, which has no other spelling). The
  // second form solves and survives pruning like the first, so it has to draw
  // too, or a constraint in it is invisible and impossible to right-click
  // away (operandPoint).
  const refPos = (id: string, p: number): THREE.Vector2 | null => operandPoint(byId, id, p);
  const mid2 = (a: THREE.Vector2 | null, b: THREE.Vector2 | null) => (a && b ? a.clone().add(b).multiplyScalar(0.5) : null);
  const push = (i: number, label: string, pos: THREE.Vector2 | null) => { if (pos) out.push({ cIndex: i, label, pos }); };
  /** On the spline a quarter of the way along its end span: by the joint the
   *  tangency is about, but clear of the Coincident badge that usually sits
   *  on the joint itself. */
  const nearEnd = (id: string, end: number): THREE.Vector2 | null => {
    const e = byId.get(id);
    if (e?.type !== "spline") return null;
    const poly = entityPolyline(e);
    const fromEnd = end === 0 ? poly : [...poly].reverse();
    const [a, b] = fromEnd;
    if (!a || !b) return null;
    // two fit points are drawn as one straight segment, not 16 samples
    if (fromEnd.length === 2) return a.clone().lerp(b, 0.25);
    return fromEnd[Math.min(fromEnd.length - 1, SPLINE_GLYPH_STEP)] ?? null;
  };

  constraints.forEach((c, i) => {
    switch (c.type) {
      case "horizontal": push(i, "H", center(c.line)); break;
      case "vertical": push(i, "V", center(c.line)); break;
      case "parallel": push(i, "∥", center(c.l1)); break;
      case "perpendicular": push(i, "⊥", center(c.l1)); break;
      case "collinear": push(i, "—", mid2(center(c.l1), center(c.l2))); break;
      case "equal": push(i, "=", center(c.l1)); break;
      case "equalRadius": push(i, "=", center(c.a)); break;
      // At the touching point; the old halfway spot only when there is none
      // to find (an operand that does not resolve, two concentric rounds).
      case "tangent": push(i, "T", tangencyPoint(byId, c.line, c.circle) ?? mid2(center(c.line), center(c.circle))); break;
      case "tangent2": push(i, "T", tangencyPoint(byId, c.a, c.b) ?? mid2(center(c.a), center(c.b))); break;
      case "splineTangent": push(i, "T", nearEnd(c.spline, c.end)); break;
      case "coincident": push(i, "⊙", refPos(c.e1, c.p1)); break;
      case "concentric": push(i, "◎", center(c.c1)); break;
      case "midpoint": push(i, "M", center(c.line)); break;
      // On the POINT, like coincident's: that is the end that slides along the
      // curve, and a badge at the curve's middle could sit nowhere near it (the
      // line is infinite here). It also keeps the badge, and so the delete,
      // reachable if the curve ever fails to resolve.
      case "pointOn": push(i, "∈", refPos(c.e, c.p)); break;
      case "symmetric": push(i, "⋈", center(c.line)); break;
      case "fix": push(i, "⚓", refPos(c.e, c.p)); break;
      // distance/diameter/p2pDistance/p2lDistance/radius/angle render as dimensions
      default: break;
    }
  });
  return out;
}
