// The 9 constraint-tool click flows (horizontal/vertical/parallel/perpendicular/
// equal/tangent/coincident/concentric/symmetric): each adds a persistent geometric
// constraint that the solver maintains alongside every other constraint already on
// the sketch. Operates purely through the ConstraintHost accessor SketchMode
// provides — no state is copied, so this collaborator always sees SketchMode's
// live entities/constraints.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { pickEntity, PROJECTED_FIXED_MSG } from "./modify";
import { curveKind, dimRefPoints, lineOperandAt, refPoint } from "./entityDims";
import type { SketchTool } from "./sketchMode";

export const CONSTRAINT_TOOLS = new Set<SketchTool>([
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
  "tangent",
  "coincident",
  "concentric",
  "symmetric",
  "midpoint",
  "collinear",
  "fix",
]);

/** What a click landed on, expressed as a constraint OPERAND rather than as an
 *  entity. The two differ for exactly one shape: a rectangle presents four line
 *  operands (`<rectId>~<k>`) and no operand of its own, so an entity id is not
 *  enough to say what was clicked. */
interface Operand {
  /** the id to put in the constraint — a rect EDGE, not the rectangle */
  id: string;
  kind: "line" | "circle" | "arc";
  /** the entity it came from: needed for the projected-is-fixed message, and to
   *  tell "another edge of the same rectangle" from "the same operand twice" */
  ent: ResolvedEntity;
  /** index into the live entity list, for the host's first-pick highlight */
  index: number;
}

const isRoundOp = (o: Operand) => o.kind === "circle" || o.kind === "arc";

/** the ENTITY an operand id belongs to — `R~2` belongs to the rectangle `R` */
const baseOf = (id: string) => { const t = id.indexOf("~"); return t < 0 ? id : id.slice(0, t); };

/** The slice of SketchMode these click flows read/write — live accessors, not copies. */
export interface ConstraintHost {
  /** current active sketch tool (drives which constraint flow fires) */
  tool(): SketchTool;
  /** live entity list — never copied */
  entities(): ResolvedEntity[];
  /** live constraint list — never copied; constraint flows push onto it */
  constraints(): SketchConstraint[];
  /** pick tolerance in plane units, scaled to current zoom */
  pickTol(): number;
  /** shared "first pick" slot for two-step line/entity flows — also used by
   *  SketchMode's own fillet tool (filletClick/modifyHover); reset to null on
   *  every setTool() */
  getFilletFirst(): number | null;
  setFilletFirst(idx: number | null): void;
  /** kick the solve pump after a constraint changes */
  requestSolve(): void;
  /** surface a user-facing warning (SketchMode routes it to the toast layer —
   *  kept an accessor so these flows stay DOM-free/unit-testable) */
  warn(msg: string): void;
  /** Show (or clear) the endpoints this flow is holding, so the user can see
   *  that a pick landed. Coincident's first click used to leave NO trace at all
   *  — the tool looked broken until the second click happened to work.
   *
   *  A LIST, because symmetric holds two points before it asks for its axis and
   *  a single marker could only ever show one of them: its middle click landed
   *  with no feedback whatsoever. Pass [] to clear. */
  setPendingPoints(ps: { x: number; y: number }[]): void;
  /** Push a constraint and solve. The host REMOVES it again if that solve turns
   *  out to conflict: an unsatisfiable constraint left sitting in the sketch
   *  poisons every later one, because the whole system stops solving and nothing
   *  moves. Reported in the app 2026-08-15 — after one bad Collinear, a perfectly
   *  good Parallel on other lines also appeared to do nothing.
   *
   *  `moves` names the ENTITY that solve should move — the first-picked operand
   *  of a two-pick flow (bug #86; see DimPlan.moves for why the geometry cannot
   *  answer this on its own). A one-pick flow has no second operand to hold
   *  still and passes nothing. */
  addConstraint(c: SketchConstraint, moves?: string): void;
}


/** What each tool needs under the cursor. Used only for the "nothing here"
 *  message, so a miss names the target instead of looking like a dead tool.
 *  A rectangle EDGE is a line to every one of these, and a rectangle CORNER is
 *  an endpoint — say so, because a user who has just been told "needs a line"
 *  after clicking a rectangle side has been told the wrong thing. */
const WANTS: Partial<Record<SketchTool, string>> = {
  horizontal: "a line, or a rectangle edge",
  vertical: "a line, or a rectangle edge",
  parallel: "two lines (a rectangle edge counts)",
  perpendicular: "two lines (a rectangle edge counts)",
  collinear: "two lines (a rectangle edge counts)",
  equal: "two lines, or two circles/arcs",
  tangent: "a circle or arc, then the line or curve it should touch",
  concentric: "two circles or arcs",
  coincident: "two endpoints, rectangle corners or circle/arc centres",
  midpoint: "a point, an endpoint or a centre, then the line to centre it on",
  symmetric: "two points, endpoints or centres, then the axis line",
  fix: "a point, an endpoint or a centre",
};

/** A nullable plane point as the list `setPendingPoints` takes — a point the
 *  flow could not resolve shows nothing rather than a marker at the origin. */
const pts = (...ps: ({ x: number; y: number } | null)[]): { x: number; y: number }[] =>
  ps.filter((q): q is { x: number; y: number } => q !== null);

const COINCIDENT_MISS =
  "Coincident joins two POINTS — click the ends of the lines, a rectangle's corners "
  + "or a circle's centre, not their middles. To make two lines lie along each other, "
  + "use Collinear.";


export class ConstraintTools {
  constructor(private host: ConstraintHost) {}

  // coincident/symmetric/midpoint all start from an endpoint pick. We stash the
  // first pick (and, for symmetric, the second) on filletFirst-style state.
  private pendingEndpoint: { id: string; idx: number } | null = null;
  private pendingEndpoint2: { id: string; idx: number } | null = null;
  /** the first operand of a two-pick flow; valid ONLY while filletFirst is set */
  private firstOperand: Operand | null = null;

  /** whether an endpoint-based flow (coincident/symmetric/midpoint) is mid-pick */
  hasPending(): boolean {
    return this.pendingEndpoint != null || this.pendingEndpoint2 != null;
  }
  /** abandon any in-progress endpoint pick (tool switch, Escape, session end) */
  resetPending() {
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    this.firstOperand = null;
    this.host.setPendingPoints([]); // the marker must not outlive the pick
  }

  /** The OPERAND id a two-pick flow is currently holding, or null.
   *
   *  `filletFirst` holds an ENTITY index, which is all SketchMode's own fillet
   *  tool needs and is what its Escape path reads — but it cannot say WHICH of a
   *  rectangle's four line operands was picked, so the first-pick highlight lit
   *  all four sides when the user had armed one. This is the missing half, and
   *  it is deliberately read-only: the index stays the single source of "am I
   *  armed", so nothing here can leave a pick alive that Escape cannot clear. */
  heldOperandId(): string | null {
    return this.host.getFilletFirst() == null ? null : (this.firstOperand?.id ?? null);
  }

  /** Report a click that found no usable target. Every tool routes misses here:
   *  a constraint tool that does nothing and says nothing is indistinguishable
   *  from a broken one, which is exactly how Coincident read (GitHub #17). */
  private missed() {
    const t = this.host.tool();
    this.host.warn(`Nothing to constrain there — ${t} needs ${WANTS[t] ?? "a target"}.`);
  }

  /** add a persistent geometric constraint and re-solve (the solver maintains
   *  all constraints together, not just the one you applied). */
  click(p: THREE.Vector2) {
    const t = this.host.tool();
    // point-based constraints pick the nearest endpoint, not an entity body
    if (t === "coincident" || t === "symmetric" || t === "midpoint") {
      return this.pointConstraintClick(p);
    }
    if (t === "fix") return this.fixClick(p);
    if (t === "tangent") return this.tangentClick(p);
    if (t === "equal") return this.equalClick(p);
    if (t === "concentric") return this.concentricClick(p);

    // line-based constraints (horizontal/vertical/parallel/perpendicular/collinear)
    const op = this.pickOperand(p);
    if (!op || op.kind !== "line") return this.missed();
    if (t === "horizontal" || t === "vertical") {
      // constraining the projected line ITSELF is meaningless — it's fixed.
      // (Tested on the ENTITY, not on `kind`: a rect edge is a line operand and
      // is perfectly constrainable, it just isn't a `line` entity.)
      if (op.ent.type === "projected") return this.host.warn(PROJECTED_FIXED_MSG);
      if (t === "horizontal") this.addConstraint({ type: "horizontal", line: op.id });
      else this.addConstraint({ type: "vertical", line: op.id });
    } else {
      // two-line constraints: first click stores, second applies. The FIRST pick
      // is the one that moves (bug #86) — `ent.id` rather than the operand id,
      // because a rect edge's mover is its rectangle.
      const pair = this.holdPair(op);
      if (!pair) return;
      const [a, b] = pair;
      const moves = a.ent.id;
      if (t === "parallel") this.addConstraint({ type: "parallel", l1: a.id, l2: b.id }, moves);
      else if (t === "perpendicular") this.addConstraint({ type: "perpendicular", l1: a.id, l2: b.id }, moves);
      else if (t === "collinear") this.addConstraint({ type: "collinear", l1: a.id, l2: b.id }, moves);
    }
  }

  /** THE operand under the cursor. Rectangles are the reason this exists: they
   *  present four line operands and none of their own, so "which entity" is not
   *  the same question as "which operand" — see entityDims.lineOperandAt for why
   *  the seam is there and not in curveKind. */
  private pickOperand(p: THREE.Vector2): Operand | null {
    const entities = this.host.entities();
    const index = pickEntity(entities, p, this.host.pickTol());
    const ent = index >= 0 ? entities[index] : undefined;
    if (!ent) return null;
    const lineId = lineOperandAt(ent, p);
    if (lineId) return { id: lineId, kind: "line", ent, index };
    const k = curveKind(ent);
    return k === "circle" || k === "arc" ? { id: ent.id, kind: k, ent, index } : null;
  }

  /** The shared two-pick handshake: returns [first, second] once a second
   *  operand lands, null while arming the first or on a repeat of the same one.
   *
   *  `filletFirst` stays the single source of "am I armed", because SketchMode
   *  clears it on Escape and on setTool and knows nothing about the operand slot
   *  beside it — reading the operand only while filletFirst is set is what keeps
   *  a first pick from surviving an Escape. */
  private holdPair(op: Operand): [Operand, Operand] | null {
    if (this.host.getFilletFirst() == null) {
      this.host.setFilletFirst(op.index);
      this.firstOperand = op;
      return null;
    }
    const first = this.firstOperand;
    this.host.setFilletFirst(null);
    this.firstOperand = null;
    // The SAME operand twice is a miss; two different EDGES of one rectangle are
    // not (making two of its sides equal is a legitimate, useful pick).
    if (!first || first.id === op.id) { this.missed(); return null; }
    return [first, op];
  }

  /** nearest addressable POINT to p — a line/arc/spline end, a point entity, a
   *  RECTANGLE CORNER, or a circle/arc CENTRE.
   *
   *  It enumerates `dimRefPoints`, which is the document's one answer to "which
   *  points does this entity expose, and under which index". Borrowing it rather
   *  than keeping a second list here is the whole point: this used to have an
   *  arm per entity type and no arm for `circle`, so a circle's centre was
   *  addressable by every dimension and by `fix` and reachable by no constraint
   *  at all. Coincident aimed at one armed nothing and said "click the ends of
   *  the lines", which reads as a dead tool (reported 2026-09-01). An arc's
   *  centre was in the same position, one index further along.
   *
   *  Rectangle corners keep the spelling the document already uses everywhere —
   *  the rectangle's own id with `idx` = the corner index 0..3 — and not the
   *  edge form `R~k` p0/p1: that reaches the same solver point, but nothing that
   *  renders a point operand (glyphs.refPos) can decode it, so such a constraint
   *  would be invisible and undeletable. */
  private pickEndpoint(p: THREE.Vector2): { id: string; idx: number } | null {
    const tol = this.host.pickTol();
    let best: { id: string; idx: number } | null = null;
    let bestD = tol * tol;
    for (const e of this.host.entities()) {
      for (const r of dimRefPoints(e)) {
        const dx = r.pos.x - p.x, dy = r.pos.y - p.y, d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { id: e.id, idx: r.p }; }
      }
    }
    return best;
  }

  /** Plane coords of the addressable point under `p`, or null. For the hover
   *  highlight, and deliberately routed through the SAME pickEndpoint the click
   *  flows use: if these two ever disagree the highlight becomes a lie, which is
   *  the failure this whole affordance exists to remove (a target you can see
   *  but not hit is the GH #17 shape, and one you can hit but not see is what
   *  rectangle corners were until this release). */
  hoverPoint(p: THREE.Vector2): { x: number; y: number } | null {
    const ep = this.pickEndpoint(p);
    return ep ? this.endpointXY(ep) : null;
  }

  /** Where a picked point reference IS, so the host can mark it on screen —
   *  resolved through `refPoint`, which is the same list pickEndpoint picked it
   *  out of. One list, so a point that can be picked is always one that can be
   *  shown, and the two cannot drift apart. */
  private endpointXY(ep: { id: string; idx: number }): { x: number; y: number } | null {
    const e = this.host.entities().find((x) => x.id === ep.id);
    const q = e ? refPoint(e, ep.idx) : null;
    return q ? { x: q.x, y: q.y } : null;
  }

  private pointConstraintClick(p: THREE.Vector2) {
    const t = this.host.tool();
    if (t === "midpoint") {
      // pick a point/endpoint, then a line
      if (!this.pendingEndpoint) {
        const ep = this.pickEndpoint(p);
        if (!ep) return this.missed();
        this.pendingEndpoint = ep;
        this.host.setPendingPoints(pts(this.endpointXY(ep)));
        return;
      }
      const op = this.pickOperand(p);
      const ep = this.pendingEndpoint;
      this.pendingEndpoint = null;
      this.host.setPendingPoints([]);
      // compared by OWNING ENTITY, not by operand id: centring a rectangle's
      // corner on one of that same rectangle's edges is a self-referential
      // squash, and `R~0` would not equal `R` on a bare id compare
      if (op && op.kind === "line" && baseOf(op.id) !== ep.id) {
        // the POINT was picked first, so the point is what moves (bug #86)
        this.addConstraint({ type: "midpoint", e: ep.id, p: ep.idx, line: op.id }, ep.id);
      } else this.missed();
      return;
    }
    if (t === "coincident") {
      const ep = this.pickEndpoint(p);
      if (ep) {
        // An endpoint pick is the primary flow and wins over any line held for
        // the collinear fallback below.
        this.host.setFilletFirst(null);
        this.firstOperand = null;
        if (!this.pendingEndpoint) {
          this.pendingEndpoint = ep;
          this.host.setPendingPoints(pts(this.endpointXY(ep)));
          return;
        }
        const a = this.pendingEndpoint;
        this.pendingEndpoint = null;
        this.host.setPendingPoints([]);
        // Two points of the SAME entity: refused, but no longer in silence. It
        // used to fall through a bare `if (a.id !== ep.id)` — no constraint, no
        // message, and the pending marker wiped on the way out, which is the
        // dead-tool reading this whole pass exists to remove. Newly easy to hit
        // now that rectangle corners are pickable: both corners of a rectangle
        // carry the rectangle's own id, so clicking any two of them lands here.
        //
        // Refusing is right on the geometry as well as the affordance. Joining
        // two corners of one rectangle annihilates it in a single solve, and
        // joining a line's two ends collapses it — the guard would refuse the
        // solve anyway, one step later and with less to say about why.
        if (a.id === ep.id) {
          this.host.warn(
            a.idx === ep.idx
              ? "That is the same point twice — Coincident joins two DIFFERENT points."
              : "Those are two points of the same shape — joining them would collapse it.",
          );
          return;
        }
        this.addConstraint({ type: "coincident", e1: a.id, p1: a.idx, e2: ep.id, p2: ep.idx }, a.id);
        return;
      }

      // No endpoint under the cursor. This used to be a bare `return`: no
      // constraint, no message, no highlight — indistinguishable from a broken
      // tool, and the reason both a field reporter and the author concluded
      // sketch lines were not selectable at all.
      const op = this.pickOperand(p);
      if (!op || op.kind !== "line") {
        this.host.warn(COINCIDENT_MISS);
        return; // keep any pending endpoint: a stray click must not lose the first pick
      }
      if (this.pendingEndpoint) {
        // half-way through the endpoint pair — say so rather than silently
        // switching them into a different constraint
        this.host.warn("Click the second ENDPOINT to finish this coincident, or press Esc to start over.");
        return;
      }
      // Two line BODIES: apply collinear, the way SolidWorks and Fusion do,
      // instead of doing nothing.
      if (this.host.getFilletFirst() == null) {
        this.host.setFilletFirst(op.index);
        this.firstOperand = op;
        return;
      }
      const first = this.firstOperand;
      this.host.setFilletFirst(null);
      this.firstOperand = null;
      if (!first || first.id === op.id) return;
      this.addConstraint({ type: "collinear", l1: first.id, l2: op.id }, first.ent.id);
      this.host.warn("Two lines: applied Collinear (Coincident joins endpoints).");
      return;
    }
    // symmetric: pick endpoint A, endpoint B, then the axis line
    if (!this.pendingEndpoint) {
      const ep = this.pickEndpoint(p);
      if (!ep) return this.missed();
      this.pendingEndpoint = ep;
      this.host.setPendingPoints(pts(this.endpointXY(ep)));
      return;
    }
    if (!this.pendingEndpoint2) {
      const ep = this.pickEndpoint(p);
      if (!ep) return this.missed();
      // Two corners of the SAME rectangle is the useful symmetric pick (that is
      // what "centre this rectangle on the axis" means), so the distinctness
      // test is per POINT here, not per entity — two picks of one line's two
      // ends stay legal for the same reason.
      if (ep.id === this.pendingEndpoint.id && ep.idx === this.pendingEndpoint.idx) {
        // Clicking the SAME point twice used to fall out of here having done and
        // said nothing, holding a pick the user could not tell was still held.
        this.host.warn("That is the point you already picked — choose the second one to mirror.");
        return;
      }
      this.pendingEndpoint2 = ep;
      // BOTH points are now held, and both are marked. With one marker the
      // second pick landed with no feedback at all, so the middle of a
      // three-click gesture looked like nothing had happened.
      this.host.setPendingPoints(
        pts(this.endpointXY(this.pendingEndpoint), this.endpointXY(ep)),
      );
      return;
    }
    // third click: the symmetry axis line
    const op = this.pickOperand(p);
    const a = this.pendingEndpoint, b = this.pendingEndpoint2;
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    this.host.setPendingPoints([]);
    // three picks, and the first is still the mover: A swings onto B's mirror
    // rather than the pair meeting in the middle
    if (op && op.kind === "line") this.addConstraint({ type: "symmetric", e1: a.id, p1: a.idx, e2: b.id, p2: b.idx, line: op.id }, a.id);
  }

  /** Two-pick flow shared by tangent/equal/concentric: returns [first, second]
   *  once a second valid operand lands (both pass `ok`, distinct); null while
   *  arming the first pick or on an invalid pick. Uses the filletFirst slot as
   *  the armed flag — see holdPair for why the operand rides beside it. */
  /** Two-click operand pick, reporting its OWN misses.
   *
   *  It has to, because `null` means two different things here and the callers
   *  could not tell them apart: "that click found nothing" and "that click armed
   *  the first of two". Every caller used to answer both with `missed()`, so the
   *  opening click of Tangent, Equal and Concentric told the user "Nothing to
   *  constrain there" about a pick that had landed perfectly well and was
   *  waiting for its partner. That is the dead-tool signature the whole
   *  affordance pass exists to remove, reading out loud on a tool that worked.
   *
   *  `holdPair` above already had this shape; this brings the two into line. */
  private pickPair(p: THREE.Vector2, ok: (o: Operand) => boolean): [Operand, Operand] | null {
    const op = this.pickOperand(p);
    if (!op || !ok(op)) { this.missed(); return null; }
    if (this.host.getFilletFirst() == null) {
      this.host.setFilletFirst(op.index);
      this.firstOperand = op;
      return null; // armed, not missed: say nothing
    }
    const first = this.firstOperand;
    this.host.setFilletFirst(null);
    this.firstOperand = null;
    if (!first || first.id === op.id) { this.missed(); return null; }
    return [first, op];
  }

  /** tangent between two curves: line/circle/arc, in any mix except line+line.
   *  Emits the general `tangent2`; the compiler picks the right planegcs variant. */
  private tangentClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, () => true); // every operand is a tangency-capable curve
    if (!pair) return; // pickPair already said whatever needed saying
    const [first, e] = pair;
    // two lines cannot be tangent — say so rather than swallowing the pick
    if (first.kind === "line" && e.kind === "line") return this.missed();
    this.addConstraint({ type: "tangent2", a: first.id, b: e.id }, first.ent.id);
  }

  /** equal: two lines share length, or two circles/arcs share radius. */
  private equalClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, () => true);
    if (!pair) return; // pickPair already said whatever needed saying
    const [first, e] = pair;
    if (first.kind === "line" && e.kind === "line") {
      this.addConstraint({ type: "equal", l1: first.id, l2: e.id }, first.ent.id);
    } else if (isRoundOp(first) && isRoundOp(e)) {
      this.addConstraint({ type: "equalRadius", a: first.id, b: e.id }, first.ent.id);
    } else {
      // A line and a circle. Both picks were valid targets, so `missed` would be
      // a lie, and falling off the end here is worse: it consumed two clicks,
      // emitted nothing and said nothing, which is precisely how a working tool
      // reads as broken. There is no meaning to give it — a length and a radius
      // are not the same measurement — so say that.
      this.host.warn(
        "Equal needs two lines, or two circles/arcs — a length and a radius are not comparable.",
      );
    }
  }

  private concentricClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, isRoundOp); // circles and arcs both carry a center
    if (!pair) return; // pickPair already said whatever needed saying
    this.addConstraint({ type: "concentric", c1: pair[0].id, c2: pair[1].id }, pair[0].ent.id);
  }

  /** fix/lock: pin the nearest addressable point of any entity. Reuses
   *  dimRefPoints (line/arc endpoints, arc/circle centers, rect corners, spline
   *  ends) so the `p`-index convention lives in exactly one place. */
  private fixClick(p: THREE.Vector2) {
    const tol = this.host.pickTol();
    let best: { id: string; p: number } | null = null;
    let bestD = tol * tol;
    for (const e of this.host.entities()) {
      if (e.type === "projected") continue; // already fixed — fixing it is meaningless
      for (const r of dimRefPoints(e)) {
        const dx = r.pos.x - p.x, dy = r.pos.y - p.y, d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { id: e.id, p: r.p }; }
      }
    }
    if (best) return this.addConstraint({ type: "fix", e: best.id, p: best.p });
    // no addressable point — explain a click on projected geometry (skipped
    // above: it is already fixed) instead of silently doing nothing. This
    // specific message beats the generic one, so it goes first.
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, tol);
    if (entities[idx]?.type === "projected") return this.host.warn(PROJECTED_FIXED_MSG);
    return this.missed();
  }

  private addConstraint(c: SketchConstraint, moves?: string) {
    this.host.addConstraint(c, moves);
  }
}
