// Single source of truth for "what dimensions does a sketch entity have, where
// is each one's label/value, how do you read & write it, and how is it drawn as
// a MCAD-style dimension (extension lines + dimension line + arrowheads)."
// Drives the in-canvas dimension labels (SketchDimensions), the inspector, and
// SketchMode.editDimension — one place for all per-entity dimension knowledge.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { DimField, DimPlace, PlaceOffset, SketchConstraint } from "../types";
import { isDriven, dimPlaceOf, projEndSamples } from "../types";
import { circumcenter, arcCenterRadius } from "./arc";
import { rectCorners } from "./region";
import { paramOnSeg, distToSeg, signedAngleDeg } from "./geom2d";

export type { DimField };
type V = THREE.Vector2;
const v = (x: number, y: number) => new THREE.Vector2(x, y);

export interface EntityDim {
  field: DimField;
  label: string; // "Width" / "Height" / "Diameter" / "Length"
  labelPos: V; // where the value text sits (on the dimension line)
  valueMm: number;
  write: (mm: number) => void; // mutate the entity in place
  lines: [V, V][]; // extension lines + dimension line + arrowheads (2D)
  /** The label's CURRENT offset from this dim's natural anchor, in sketch mm —
   *  whether it came from `e.dimPlace[field]` or from the default layout. It's
   *  the basis a label drag adds its cursor delta to, so the first drag starts
   *  from where the label visibly is instead of jumping. */
  place: V;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Screen-space clearance for dimension offsets: the world-mm floor alone lets a
// badge sit ON the geometry it labels at low zoom (3 mm can project to 2 px),
// and the labels are click-targets in the select tool — a badge over a line
// swallows the click meant to select the line. SketchMode feeds the current
// mm-per-pixel each refresh; 0 (the default — e.g. inspector usage, which never
// renders labels) keeps the pure world-space behavior.
let mmPerPx = 0;
export function setDimPixelScale(scale: number) {
  mmPerPx = scale;
}
const LABEL_CLEAR_PX = 18; // ≳ the rendered badge height

function dimOffset(worldOff: number): number {
  return Math.max(worldOff, LABEL_CLEAR_PX * mmPerPx);
}

/** arrowhead (a small "V") at `tip`, opening back along `dir` */
function arrow(tip: V, dir: V, size: number): [V, V][] {
  const back = tip.clone().sub(dir.clone().multiplyScalar(size));
  const perp = v(-dir.y, dir.x).multiplyScalar(size * 0.45);
  return [
    [tip.clone(), back.clone().add(perp)],
    [tip.clone(), back.clone().sub(perp)],
  ];
}

/** a linear dimension measuring a..b, offset perpendicular by `offDir`*off.
 *  `offOverride` (the placement offset a user froze with the dimension tool's
 *  placement click — or dragged the label to — projected onto `offDir`)
 *  replaces the computed offset: its magnitude sets the distance, its sign picks
 *  the side. `place` reports the offset actually applied, as a vector: the label
 *  sits exactly at midpoint(a,b) + place, which is what makes a drag delta
 *  composable with it. */
export function linearDim(
  a: V, b: V, offDir: V, value: number, offOverride?: number,
): { labelPos: V; lines: [V, V][]; place: V } {
  const off = dimOffset(offOverride === undefined ? clamp(value * 0.16, 3, 12) : Math.abs(offOverride));
  const dirOff = offOverride !== undefined && offOverride < 0 ? offDir.clone().negate() : offDir;
  const da = a.clone().add(dirOff.clone().multiplyScalar(off));
  const db = b.clone().add(dirOff.clone().multiplyScalar(off));
  const dir = db.clone().sub(da).normalize();
  const aSize = clamp(value * 0.08, 1.4, 4);
  const lines: [V, V][] = [
    [a.clone(), da.clone()], // extension lines
    [b.clone(), db.clone()],
    [da.clone(), db.clone()], // dimension line
    ...arrow(da, dir.clone().negate(), aSize),
    ...arrow(db, dir, aSize),
  ];
  return {
    labelPos: da.clone().add(db).multiplyScalar(0.5),
    lines,
    place: dirOff.clone().multiplyScalar(off),
  };
}
const linear = linearDim;

/** A badge dim's stored placement, as a vector — `null` when the user hasn't
 *  placed this one and there's no staggered default to fall back on. THE one
 *  reader of `entity.dimPlace`; an explicit user placement always wins. */
function placeOf(e: ResolvedEntity, field: DimField, defaults?: DimPlace): V | null {
  const p = dimPlaceOf(e)?.[field] ?? defaults?.[field];
  return p ? v(p.ox, p.oy) : null;
}

/** A linear badge's offset override: the stored placement projected onto the
 *  dim's own offset direction. Linear dims only move PERPENDICULAR to what they
 *  measure (the along-segment component would just slide the text off its own
 *  dimension line), so one signed scalar is the whole degree of freedom. */
function linearOverride(e: ResolvedEntity, field: DimField, offDir: V, defaults?: DimPlace): number | undefined {
  const p = placeOf(e, field, defaults);
  return p ? p.x * offDir.x + p.y * offDir.y : undefined;
}

/** THE diameter annotation, shared by a circle's badge and an arc's diameter
 *  constraint. `place` is a free 2D offset from the CENTRE and carries two
 *  meanings at once (this is the mainstream-MCAD behaviour, and it's what lets two
 *  concentric circles be read at a glance — dimension one up-left, the other
 *  down-right): its DIRECTION rotates the diameter line through the centre, and
 *  its LENGTH puts the label along that line. Unplaced keeps the historical
 *  layout — a horizontal chord with the label just above the centre.
 *  A label dragged past the rim pulls a leader out to itself; the arrowheads
 *  stay on the rim, because that's what the dimension actually measures. */
export function diameterDim(
  cx: number, cy: number, r: number, place: V | null,
): { labelPos: V; lines: [V, V][]; place: V } {
  const c = v(cx, cy);
  const len = place ? place.length() : 0;
  const off = place && len > 1e-9 ? place.clone() : v(0, dimOffset(clamp(r * 0.25, 2, 6)));
  // unplaced: the chord stays horizontal (the label floats above it); placed:
  // the chord follows the placement direction
  const u = place && len > 1e-9 ? off.clone().divideScalar(len) : v(1, 0);
  const aSize = clamp(r * 0.16, 1.4, 4);
  const tail = c.clone().addScaledVector(u, -r);
  const tip = c.clone().addScaledVector(u, r);
  // leader: when the label sits outside the rim, run the line out to it
  const far = c.clone().addScaledVector(u, Math.max(r, place && len > 1e-9 ? len : 0));
  return {
    labelPos: c.clone().add(off),
    lines: [
      [tail.clone(), far],
      ...arrow(tail, u.clone().negate(), aSize),
      ...arrow(tip, u, aSize),
    ],
    place: off,
  };
}

/** Default badge placements that a single entity can't work out on its own,
 *  because they depend on its NEIGHBOURS.
 *
 *  The case that matters: concentric circles. Each one puts its diameter badge
 *  straight above the shared centre by default, so a 60 mm and a 34 mm circle
 *  drawn about the same point land their labels ~9 px apart and neither is
 *  readable — and the top one swallows the other's click. Concentric groups of
 *  2+ therefore fan out, 90° apart, each label MIDWAY BETWEEN ITS OWN RIM AND
 *  THE NEXT ONE IN (the centre, for the innermost): every label then sits in the
 *  annular band its own circle owns, so no label can land on another circle's
 *  rim — which matters because a badge that lands on geometry hands its clicks
 *  to that geometry (SketchDimensions.onOverlapPick). A lone circle is
 *  untouched: it keeps the historical straight-above default.
 *
 *  These are DEFAULTS. A user placement (entity.dimPlace, set by dragging the
 *  label) always wins — see placeOf. Callers that render a whole entity SET pass
 *  the result to entityDims; single-entity callers (the inspector, the value
 *  writers) don't need it, since it only moves labels.
 *
 *  "Concentric" is judged with the same screen-space clearance the badges use,
 *  so near-concentric circles — which stack just as badly at that zoom — fan out
 *  too; with no zoom context (unit tests, inspector) it falls back to exact. */
export function staggeredDefaults(ents: ResolvedEntity[]): Map<string, DimPlace> {
  const tol = Math.max(dimOffset(0), 1e-9);
  const groups: ResolvedEntity[][] = [];
  for (const e of ents) {
    if (e.type !== "circle" || e.construction) continue;
    const g = groups.find((q) => {
      const h = q[0];
      return h && h.type === "circle" && Math.hypot(h.x - e.x, h.y - e.y) <= tol;
    });
    if (g) g.push(e);
    else groups.push([e]);
  }
  const out = new Map<string, DimPlace>();
  for (const g of groups) {
    if (g.length < 2) continue; // a lone circle keeps the plain default
    const sorted = [...g].sort((a, b) => (a.type === "circle" && b.type === "circle" ? a.radius - b.radius : 0));
    let inner = 0; // the rim just inside this one (0 = the shared centre)
    sorted.forEach((e, k) => {
      if (e.type !== "circle") return;
      const ang = (Math.PI / 4) + k * (Math.PI / 2); // 45°, 135°, 225°, 315°, …
      const dist = (inner + e.radius) / 2;
      inner = e.radius;
      out.set(e.id, { diameter: { ox: Math.cos(ang) * dist, oy: Math.sin(ang) * dist } });
    });
  }
  return out;
}

export function entityDims(e: ResolvedEntity, defaults?: DimPlace): EntityDim[] {
  if (e.type === "rectangle") {
    const hw = e.width / 2;
    const hh = e.height / 2;
    const wDir = v(0, -1), hDir = v(-1, 0);
    const w = linear(v(e.x - hw, e.y - hh), v(e.x + hw, e.y - hh), wDir, e.width, linearOverride(e, "width", wDir, defaults));
    const h = linear(v(e.x - hw, e.y - hh), v(e.x - hw, e.y + hh), hDir, e.height, linearOverride(e, "height", hDir, defaults));
    return [
      { field: "width", label: "Width", valueMm: e.width, labelPos: w.labelPos, lines: w.lines, place: w.place, write: (mm) => { e.width = mm; } },
      { field: "height", label: "Height", valueMm: e.height, labelPos: h.labelPos, lines: h.lines, place: h.place, write: (mm) => { e.height = mm; } },
    ];
  }
  if (e.type === "circle") {
    const d = diameterDim(e.x, e.y, e.radius, placeOf(e, "diameter", defaults));
    return [
      {
        field: "diameter",
        label: "Diameter",
        valueMm: e.radius * 2,
        labelPos: d.labelPos,
        lines: d.lines,
        place: d.place,
        write: (mm) => { e.radius = mm / 2; },
      },
    ];
  }
  if (e.type === "arc") return []; // radius dim editing comes with the solver
  if (e.type === "spline") return []; // splines are defined by their fit points
  if (e.type === "point") return []; // a point carries no dimension
  if (e.type === "text") return []; // text has no editable linear dimension
  if (e.type === "projected") return []; // fixed reference geometry — nothing to edit
  if (e.type === "polygon") {
    const rr = e.radius;
    const a = (e.angle * Math.PI) / 180; // stored degrees
    const c = v(Math.cos(a), Math.sin(a));
    // a radius label only has one degree of freedom: how far OUT along its own
    // radial line it sits (a sideways drag would take it off the line it labels).
    // Unplaced keeps the historical 0.6r; a placement gets the pixel-clearance
    // floor so it can't be dropped onto the centre.
    const p = placeOf(e, "radius", defaults);
    const dist = p ? Math.max(p.x * c.x + p.y * c.y, dimOffset(0)) : rr * 0.6;
    const end = Math.max(rr, dist); // a label past the vertex pulls the line out to it
    return [{
      field: "radius", label: "Radius", valueMm: rr,
      labelPos: v(e.x + c.x * dist, e.y + c.y * dist),
      lines: [[v(e.x, e.y), v(e.x + c.x * end, e.y + c.y * end)]],
      place: c.clone().multiplyScalar(dist),
      write: (mm) => { e.radius = mm; },
    }];
  }
  if (e.type === "slot") {
    const A = v(e.x1, e.y1), B = v(e.x2, e.y2);
    const len = A.distanceTo(B) || 1;
    const dir = B.clone().sub(A).multiplyScalar(1 / len);
    const perp = v(-dir.y, dir.x);
    const ll = linear(A, B, perp, len, linearOverride(e, "length", perp, defaults));
    const wDir = dir.clone().negate();
    const wa = A.clone().addScaledVector(perp, e.width / 2), wb = A.clone().addScaledVector(perp, -e.width / 2);
    const wl = linear(wa, wb, wDir, e.width, linearOverride(e, "width", wDir, defaults));
    return [
      { field: "length", label: "Length", valueMm: len, labelPos: ll.labelPos, lines: ll.lines, place: ll.place,
        write: (mm) => { e.x2 = e.x1 + dir.x * mm; e.y2 = e.y1 + dir.y * mm; } },
      { field: "width", label: "Width", valueMm: e.width, labelPos: wl.labelPos, lines: wl.lines, place: wl.place,
        write: (mm) => { e.width = mm; } },
    ];
  }
  // line: dimension parallel to it, offset to the left normal
  const a = v(e.x1, e.y1);
  const b = v(e.x2, e.y2);
  const len = a.distanceTo(b);
  const dir = b.clone().sub(a).normalize();
  const nrm = v(-dir.y, dir.x);
  const l = linear(a, b, nrm, len, linearOverride(e, "length", nrm, defaults));
  return [
    {
      field: "length",
      label: "Length",
      valueMm: len,
      labelPos: l.labelPos,
      lines: l.lines,
      place: l.place,
      write: (mm) => {
        const cur = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1;
        e.x2 = e.x1 + ((e.x2 - e.x1) / cur) * mm;
        e.y2 = e.y1 + ((e.y2 - e.y1) / cur) * mm;
      },
    },
  ];
}

/** every dimension's annotation segments for a set of entities (skips construction) */
export function dimensionSegments(ents: ResolvedEntity[]): [V, V][] {
  const out: [V, V][] = [];
  const defaults = staggeredDefaults(ents); // labels and their lines must agree
  for (const e of ents) {
    if (e.construction) continue;
    for (const d of entityDims(e, defaults.get(e.id))) out.push(...d.lines);
  }
  return out;
}

// --- constraint-based dimensions (p2pDistance / p2lDistance) -----------------

/** Effective curve kind for constraint/dimension operands: native line/circle/
 *  arc, and projected reference curves by their cached shape (a projected line
 *  IS a line operand — that's the point of projecting). Projected polys are
 *  samples, not a curve, so they stay unaddressable as a curve operand.
 *  SketchMode's pruneConstraints and the constraint click flows share this rule. */
export const curveKind = (e: ResolvedEntity): "line" | "circle" | "arc" | undefined => {
  if (e.type === "line" || e.type === "circle" || e.type === "arc") return e.type;
  if (e.type === "projected" && e.curve.kind !== "poly") return e.curve.kind;
  return undefined;
};

/** The line segment an entity presents to line-based constraint/dimension
 *  flows: native lines, and projected lines (fixed reference operands). One
 *  predicate so the pickers, the solver seeds, and the label renderers agree. */
export function asLineSeg(e: ResolvedEntity): { x1: number; y1: number; x2: number; y2: number } | null {
  if (curveKind(e) !== "line") return null;
  if (e.type === "line") return e;
  return e.type === "projected" && e.curve.kind === "line" ? e.curve : null;
}

/** THE decoder for a line OPERAND id: either a plain entity id (native or
 *  projected line, via asLineSeg) or the compound rectangle-edge form
 *  `"<rectId>~<k>"`, k = 0..3 in rectCorners CCW order — see types.ts. The one
 *  place that knows the compound form; every renderer/validator of a line
 *  operand goes through it (SketchMode.pruneConstraints mirrors the id shape
 *  check, since it validates ids without resolving geometry). */
export function lineOperand(
  byId: Map<string, ResolvedEntity>,
  id: string,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const t = id.indexOf("~");
  if (t < 0) {
    const e = byId.get(id);
    return e ? asLineSeg(e) : null;
  }
  const base = byId.get(id.slice(0, t));
  const k = Number(id.slice(t + 1));
  if (!base || base.type !== "rectangle" || !Number.isInteger(k) || k < 0 || k > 3) return null;
  const c = rectCorners(base.x, base.y, base.width, base.height);
  const a = c[k], b = c[(k + 1) % 4];
  return a && b ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y } : null;
}

/** The ENCODER, and the inverse of lineOperand: which line operand an entity
 *  presents to a click at `p` — its own id for a native/projected line, or
 *  `"<rectId>~<k>"` for whichever of a rectangle's four edges the click is
 *  nearest. Null when the entity presents no line at all.
 *
 *  This is the seam the constraint tools pick a rect EDGE through, and it is
 *  deliberately NOT curveKind. curveKind answers "what KIND of curve is this
 *  entity"; a rectangle edge needs an IDENTITY as well — which of the four —
 *  and there is nowhere in an entity-to-kind answer to carry it. Teaching
 *  curveKind to call a rectangle a "line" would leave every caller reaching for
 *  `ent.id`, which is the bare rectangle id and is not a line operand at all:
 *  the constraint would emit, compile to nothing, and vanish silently — the
 *  exact failure class the rectangle work exists to remove. */
export function lineOperandAt(e: ResolvedEntity, p: { x: number; y: number }): string | null {
  if (e.type === "rectangle") {
    const c = rectCorners(e.x, e.y, e.width, e.height);
    let best: string | null = null;
    let bestD = Infinity;
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      if (!a || !b) continue;
      const d = distToSeg(a, b, p);
      if (d < bestD) { bestD = d; best = `${e.id}~${k}`; }
    }
    return best;
  }
  return curveKind(e) === "line" ? e.id : null;
}

/** The center + radius a round entity presents to snap/marker/dimension flows:
 *  native circles/arcs and projected circle/arc curves. THE one
 *  circumcenter-for-projected-arc rule (arcCenterRadius reconstructs both arc
 *  forms — they share field names); null for everything else (incl. a
 *  degenerate collinear arc). */
export function asRound(e: ResolvedEntity): { x: number; y: number; r: number } | null {
  if (e.type === "circle") return { x: e.x, y: e.y, r: e.radius };
  if (e.type === "projected" && e.curve.kind === "circle") {
    return { x: e.curve.x, y: e.curve.y, r: e.curve.r };
  }
  const arc = e.type === "arc" ? e : e.type === "projected" && e.curve.kind === "arc" ? e.curve : null;
  if (!arc) return null;
  const cr = arcCenterRadius(arc);
  return cr ? { x: cr.c.x, y: cr.c.y, r: cr.r } : null;
}

// --- rim (edge-to-edge) geometry ---------------------------------------------
// The one place that knows what an EDGE-to-edge distance measures, shared by the
// dimension tool's plans, the label renderer, and the solve guard — so the
// number the user sees, the number planegcs drives, and the invariant the guard
// re-checks can never drift apart.

/** a circle/arc reduced to the circle its rim lies on */
export interface Round { x: number; y: number; r: number }

const RIM_EPS = 1e-9;

/** The SIGNED edge-to-edge clearance planegcs's `c2cdistance` measures — verified
 *  against the installed wasm:
 *    nested  (d < |r1 - r2|) → |r1 - r2| - d   (annular minimum gap, always ≥ 0)
 *    otherwise               → d - r1 - r2     (external clearance; < 0 when the
 *                                               rims cross)
 *  The two branches meet with a JUMP at internal tangency, and the nested branch
 *  is unsigned in |r1 - r2| — which is why `rimNesting` is an invariant the solve
 *  guard re-checks instead of trusting the solver to stay in its branch. */
export function rimGap(c1: Round, c2: Round): number {
  const d = Math.hypot(c2.x - c1.x, c2.y - c1.y);
  const rd = Math.abs(c1.r - c2.r);
  return d < rd ? rd - d : d - c1.r - c2.r;
}

/** which round lies INSIDE the other (d < |r1 - r2|), or null when neither does */
export function rimNesting(c1: Round, c2: Round): "c1" | "c2" | null {
  if (Math.hypot(c2.x - c1.x, c2.y - c1.y) >= Math.abs(c1.r - c2.r)) return null;
  return c1.r > c2.r ? "c2" : "c1";
}

/** the two rim points realising `rimGap` — the annotation's endpoints. `fallback`
 *  supplies the direction when the centres coincide (concentric). */
export function rimGapPoints(c1: Round, c2: Round, fallback: V): { a: V; b: V } {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (d < RIM_EPS) return radialGapPoints(c1, c2, fallback);
  const u = v(dx / d, dy / d);
  if (d < Math.abs(c1.r - c2.r)) {
    // nested: both rim points lie on the ray from the BIG centre through the small one
    const big = c1.r > c2.r ? c1 : c2;
    const small = c1.r > c2.r ? c2 : c1;
    const w = c1.r > c2.r ? u : v(-u.x, -u.y);
    return {
      a: v(small.x + w.x * small.r, small.y + w.y * small.r),
      b: v(big.x + w.x * big.r, big.y + w.y * big.r),
    };
  }
  return {
    a: v(c1.x + u.x * c1.r, c1.y + u.y * c1.r),
    b: v(c2.x - u.x * c2.r, c2.y - u.y * c2.r),
  };
}

/** the radial-gap annotation: the two rims sampled along ONE direction. Used for
 *  the concentric wall-thickness dim, where the centre line gives no direction. */
export function radialGapPoints(inner: Round, outer: Round, dir: V): { a: V; b: V } {
  const u = dir.lengthSq() > 1e-12 ? dir.clone().normalize() : v(1, 0);
  return {
    a: v(inner.x + u.x * inner.r, inner.y + u.y * inner.r),
    b: v(outer.x + u.x * outer.r, outer.y + u.y * outer.r),
  };
}

/** point → nearest rim point (planegcs `p2cdistance` = |dist(p, centre) - r|,
 *  UNSIGNED — the point may sit inside). Null when the point is at the centre. */
export function pointRimPoints(p: V, c: Round): { a: V; b: V } | null {
  const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy);
  if (d < RIM_EPS) return null;
  return { a: p.clone(), b: v(c.x + (dx / d) * c.r, c.y + (dy / d) * c.r) };
}

/** rim → line (planegcs `c2ldistance` = |perpDist(centre, line)| - r, signed in r
 *  but blind to which SIDE of the line the centre is on). `a` is the rim point
 *  facing the line, `b` the foot of the perpendicular. Null when the centre lies
 *  ON the line (no facing rim point). */
export function lineRimPoints(
  seg: { x1: number; y1: number; x2: number; y2: number },
  c: Round,
): { a: V; b: V } | null {
  const t = paramOnSeg(v(seg.x1, seg.y1), v(seg.x2, seg.y2), v(c.x, c.y));
  const foot = v(seg.x1 + t * (seg.x2 - seg.x1), seg.y1 + t * (seg.y2 - seg.y1));
  const nx = c.x - foot.x, ny = c.y - foot.y, d = Math.hypot(nx, ny);
  if (d < RIM_EPS) return null;
  return { a: v(c.x - (nx / d) * c.r, c.y - (ny / d) * c.r), b: foot };
}

/** THE enumeration of an entity's dimensionable reference points, with each
 *  one's pick index `p` (the SketchConstraint p2p/p2l semantics: 0/1 =
 *  endpoints, 0..3 = rectangle corners, 2 = arc center; circles and sketch
 *  points expose their single point at 0). The picker, the label renderer, and
 *  the docs in types.ts all hang off this one list. */
export function dimRefPoints(e: ResolvedEntity): { p: number; pos: V }[] {
  if (e.type === "line") return [{ p: 0, pos: v(e.x1, e.y1) }, { p: 1, pos: v(e.x2, e.y2) }];
  if (e.type === "arc") {
    const out = [{ p: 0, pos: v(e.x1, e.y1) }, { p: 1, pos: v(e.x2, e.y2) }];
    const cc = circumcenter({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: e.mx, y: e.my });
    if (cc) out.push({ p: 2, pos: v(cc.x, cc.y) });
    return out;
  }
  if (e.type === "circle" || e.type === "point") return [{ p: 0, pos: v(e.x, e.y) }];
  if (e.type === "rectangle") {
    return rectCorners(e.x, e.y, e.width, e.height).map((q, k) => ({ p: k, pos: v(q.x, q.y) }));
  }
  if (e.type === "spline") {
    const out: { p: number; pos: V }[] = [];
    const a = e.points[0], b = e.points[e.points.length - 1];
    if (a) out.push({ p: 0, pos: v(a.x, a.y) });
    if (b && e.points.length > 1) out.push({ p: 1, pos: v(b.x, b.y) });
    return out;
  }
  if (e.type === "projected") {
    // fixed reference points user dims/constraints can target — same indices
    // the solver registers (sketchSolve projected branch): line/arc endpoints
    // 0/1, arc center 2, circle center 0, poly first/last samples 0/1
    const cv = e.curve;
    if (cv.kind === "line") return [{ p: 0, pos: v(cv.x1, cv.y1) }, { p: 1, pos: v(cv.x2, cv.y2) }];
    if (cv.kind === "circle") return [{ p: 0, pos: v(cv.x, cv.y) }];
    if (cv.kind === "arc") {
      const out = [{ p: 0, pos: v(cv.x1, cv.y1) }, { p: 1, pos: v(cv.x2, cv.y2) }];
      const cc = asRound(e); // the one circumcenter-for-projected-arc rule
      if (cc) out.push({ p: 2, pos: v(cc.x, cc.y) });
      return out;
    }
    return projEndSamples(cv).map((q, k) => ({ p: k, pos: v(q[0], q[1]) })); // closed poly: one point
  }
  return [];
}

/** resolve a dimension pick (entity + p index) to its current 2D position */
export function refPoint(e: ResolvedEntity, p: number): V | null {
  return dimRefPoints(e).find((r) => r.p === p)?.pos ?? null;
}

export interface ConstraintDim {
  cIndex: number; // index into the constraints array (write target)
  labelPos: V;
  valueMm: number; // the driving value (degrees when kind==="angle")
  lines: [V, V][];
  kind?: "length" | "angle"; // default length; angle → value shown in degrees
  driven?: boolean; // reference dim: shown in brackets, measured live, read-only
  /** the label's CURRENT offset from this dim's natural anchor, in sketch mm —
   *  the basis a label drag adds its delta to (see EntityDim.place). Absent =
   *  this dim's constraint has no `place` slot, so its label can't be dragged. */
  place?: V;
}

/** annotation + label geometry for the distance constraints (the driving dims
 *  the dimension tool places between two points, or a point and a line).
 *  `place` (when the dimension tool froze a placement) offsets the label from
 *  the dim's natural anchor — see types.ts. */
export function constraintDims(ents: ResolvedEntity[], constraints: SketchConstraint[]): ConstraintDim[] {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const out: ConstraintDim[] = [];
  constraints.forEach((c, i) => {
    const driven = isDriven(c);
    const place = (c as { place?: PlaceOffset }).place;
    // radius (circle/arc): a radial line from center to rim + an "R" label
    if (c.type === "radius") {
      const e = byId.get(c.e);
      if (!e) return;
      const cr = asRound(e);
      if (!cr || (e.type !== "circle" && e.type !== "arc")) return;
      const cx = cr.x, cy = cr.y, r = cr.r;
      // placement picks the radial DIRECTION (its magnitude is ignored — the
      // label stays on the rim radius, which is what the dim means)
      const pv = place ? v(place.ox, place.oy) : null;
      const d = pv && pv.lengthSq() > 1e-12 ? pv.normalize() : v(Math.SQRT1_2, Math.SQRT1_2); // 45° radial
      out.push({
        cIndex: i, valueMm: driven ? r : c.value, driven,
        labelPos: v(cx + d.x * r * 0.6, cy + d.y * r * 0.6),
        lines: [[v(cx, cy), v(cx + d.x * r, cy + d.y * r)]],
        place: d.clone().multiplyScalar(r * 0.6),
      });
      return;
    }
    // diameter on an ARC (the dimension tool's Radius/Diameter override): a
    // circle's diameter renders through its own entityDims badge, an arc has
    // none — so only arcs are drawn here, and only ever once. The `diameter`
    // constraint carries no `place` slot (see types.ts), so this one label is
    // not draggable: it always renders in the shared default layout.
    if (c.type === "diameter") {
      const e = byId.get(c.circle);
      if (!e || e.type !== "arc") return;
      const cr = asRound(e);
      if (!cr) return;
      const d = diameterDim(cr.x, cr.y, cr.r, null);
      out.push({ cIndex: i, valueMm: cr.r * 2, driven: false, labelPos: d.labelPos, lines: d.lines });
      return;
    }
    // angle (line-to-line): a label between the two lines, value in degrees
    if (c.type === "angle") {
      const s1 = lineOperand(byId, c.l1), s2 = lineOperand(byId, c.l2);
      if (!s1 || !s2) return;
      const m1 = v((s1.x1 + s1.x2) / 2, (s1.y1 + s1.y2) / 2);
      const m2 = v((s2.x1 + s2.x2) / 2, (s2.y1 + s2.y2) / 2);
      const labelPos = m1.clone().add(m2).multiplyScalar(0.5);
      const off = place ? v(place.ox, place.oy) : v(0, 0); // free 2D: a straight offset
      labelPos.add(off);
      out.push({ cIndex: i, valueMm: driven ? signedAngleDeg(s1, s2) : c.value, labelPos, lines: [], kind: "angle", driven, place: off });
      return;
    }
    // each branch yields the measured pair (a, b); the shared tail draws it.
    // (distance/diameter aren't handled here — their measurement always shows via
    // the entity's own length/diameter badge, so reference mode doesn't apply.)
    let a: V | null = null;
    let b: V | null = null;
    let value = 0;
    /** The measured value for a SIGNED dim, when the plain a→b distance the
     *  shared tail computes would throw the sign away. Only the X/Y distances
     *  need it (see types.ts: the operand order IS the sign). */
    let measured: number | null = null;
    // the direction a rim dim samples when the geometry gives none (concentric)
    const placeDir = place ? v(place.ox, place.oy) : v(1, 0);
    const round = (id: string): Round | null => {
      const e = byId.get(id);
      return e ? asRound(e) : null;
    };
    if (c.type === "p2pDistance") {
      const e1 = byId.get(c.e1), e2 = byId.get(c.e2);
      a = e1 ? refPoint(e1, c.p1) : null;
      b = e2 ? refPoint(e2, c.p2) : null;
      value = c.value;
    } else if (c.type === "p2pDistanceX" || c.type === "p2pDistanceY") {
      // Smart dimensioning's horizontal/vertical distances. The witness line
      // spans ONE axis at the first point's other coordinate — the same anchors
      // dimensionTool.p2pPlan draws while you place it, so the badge and the
      // preview agree instead of the badge showing a diagonal.
      const e1 = byId.get(c.e1), e2 = byId.get(c.e2);
      const p = e1 ? refPoint(e1, c.p1) : null;
      const q = e2 ? refPoint(e2, c.p2) : null;
      if (p && q) {
        a = p;
        b = c.type === "p2pDistanceX" ? v(q.x, p.y) : v(p.x, q.y);
        measured = c.type === "p2pDistanceX" ? q.x - p.x : q.y - p.y;
      }
      value = c.value;
    } else if (c.type === "p2lDistance") {
      const pe = byId.get(c.e);
      a = pe ? refPoint(pe, c.p) : null;
      const seg = lineOperand(byId, c.line);
      if (a && seg) {
        const A = v(seg.x1, seg.y1), B = v(seg.x2, seg.y2);
        const t = paramOnSeg(A, B, a);
        b = v(seg.x1 + t * (seg.x2 - seg.x1), seg.y1 + t * (seg.y2 - seg.y1)); // foot of the perpendicular
      }
      value = c.value;
    } else if (c.type === "radialGap") {
      const i = round(c.inner), o = round(c.outer);
      if (i && o) ({ a, b } = radialGapPoints(i, o, placeDir));
      value = c.value;
    } else if (c.type === "c2cDistance") {
      const r1 = round(c.c1), r2 = round(c.c2);
      if (r1 && r2) ({ a, b } = rimGapPoints(r1, r2, placeDir));
      value = c.value;
    } else if (c.type === "c2lDistance") {
      const cr = round(c.circle);
      const seg = lineOperand(byId, c.line);
      const pts = cr && seg ? lineRimPoints(seg, cr) : null;
      if (pts) ({ a, b } = pts);
      value = c.value;
    } else if (c.type === "p2cDistance") {
      const pe = byId.get(c.e);
      const q = pe ? refPoint(pe, c.p) : null;
      const cr = round(c.circle);
      const pts = q && cr ? pointRimPoints(q, cr) : null;
      if (pts) ({ a, b } = pts);
      value = c.value;
    } else if (c.type === "offset") {
      // ONE dim for the whole operation, anchored on the FIRST pair: the chain
      // shares a single value, so a label per member would be N copies of the
      // same number (and Fusion shows one). Displayed as |value| — the stored
      // value is signed because the sign IS the side; see writeDimValue for why
      // the write-back has to put that sign back.
      const pr = c.pairs[0];
      const so = pr ? lineOperand(byId, pr.src) : null;
      const co = pr ? lineOperand(byId, pr.cpy) : null;
      if (so && co) {
        // source midpoint → the foot of its perpendicular on the copy line
        const m = v((so.x1 + so.x2) / 2, (so.y1 + so.y2) / 2);
        const A = v(co.x1, co.y1), B = v(co.x2, co.y2);
        const t = paramOnSeg(A, B, m);
        a = m;
        b = v(co.x1 + t * (co.x2 - co.x1), co.y1 + t * (co.y2 - co.y1));
      } else if (pr) {
        const s = round(pr.src), q = round(pr.cpy);
        // radialGapPoints wants inner-then-outer; an inward offset makes the
        // COPY the inner one, so order by radius rather than by pair role
        if (s && q) ({ a, b } = radialGapPoints(s.r <= q.r ? s : q, s.r <= q.r ? q : s, placeDir));
      }
      value = Math.abs(c.value);
    } else return;
    if (!a || !b) return;
    const meas = a.distanceTo(b);
    if (meas < 1e-6) return;
    const dir = b.clone().sub(a).normalize();
    const nrm = v(-dir.y, dir.x);
    // the frozen placement, projected onto the dim's own left normal: magnitude
    // = how far off the geometry, sign = which side
    const off = place ? place.ox * nrm.x + place.oy * nrm.y : undefined;
    const lin = linear(a, b, nrm, meas, off);
    out.push({ cIndex: i, labelPos: lin.labelPos, valueMm: driven ? measured ?? meas : value, lines: lin.lines, driven, place: lin.place });
  });
  return out;
}
