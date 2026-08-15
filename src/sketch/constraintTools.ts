// The 9 constraint-tool click flows (horizontal/vertical/parallel/perpendicular/
// equal/tangent/coincident/concentric/symmetric): each adds a persistent geometric
// constraint that the solver maintains alongside every other constraint already on
// the sketch. Operates purely through the ConstraintHost accessor SketchMode
// provides — no state is copied, so this collaborator always sees SketchMode's
// live entities/constraints.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { projEndSamples } from "../types";
import { pickEntity, PROJECTED_FIXED_MSG } from "./modify";
import { curveKind, dimRefPoints } from "./entityDims";
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

/** line/circle/arc are the tangency-capable curves (curveKind — see entityDims);
 *  circle/arc carry a radius+center. */
const isCurve = (e: ResolvedEntity) => curveKind(e) !== undefined;
const isRound = (e: ResolvedEntity) => { const k = curveKind(e); return k === "circle" || k === "arc"; };

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
  /** Show (or clear) the endpoint this flow is holding, so the user can see that
   *  a first pick landed. Coincident's first click used to leave NO trace at all
   *  — the tool looked broken until the second click happened to work. */
  setPendingPoint(p: { x: number; y: number } | null): void;
  /** Push a constraint and solve. The host REMOVES it again if that solve turns
   *  out to conflict: an unsatisfiable constraint left sitting in the sketch
   *  poisons every later one, because the whole system stops solving and nothing
   *  moves. Reported in the app 2026-08-15 — after one bad Collinear, a perfectly
   *  good Parallel on other lines also appeared to do nothing. */
  addConstraint(c: SketchConstraint): void;
}


/** What each tool needs under the cursor. Used only for the "nothing here"
 *  message, so a miss names the target instead of looking like a dead tool. */
const WANTS: Partial<Record<SketchTool, string>> = {
  horizontal: "a line",
  vertical: "a line",
  parallel: "two lines",
  perpendicular: "two lines",
  collinear: "two lines",
  equal: "two lines, or two circles/arcs",
  tangent: "a circle or arc, then the line or curve it should touch",
  concentric: "two circles or arcs",
  coincident: "two endpoints",
  midpoint: "an endpoint, then the line to centre it on",
  symmetric: "two endpoints, then the axis line",
  fix: "a point, an endpoint or a centre",
};

const COINCIDENT_MISS =
  "Coincident joins two ENDPOINTS — click the ends of the lines, not their middles. "
  + "To make two lines lie along each other, use Collinear.";


export class ConstraintTools {
  constructor(private host: ConstraintHost) {}

  // coincident/symmetric/midpoint all start from an endpoint pick. We stash the
  // first pick (and, for symmetric, the second) on filletFirst-style state.
  private pendingEndpoint: { id: string; idx: number } | null = null;
  private pendingEndpoint2: { id: string; idx: number } | null = null;

  /** whether an endpoint-based flow (coincident/symmetric/midpoint) is mid-pick */
  hasPending(): boolean {
    return this.pendingEndpoint != null || this.pendingEndpoint2 != null;
  }
  /** abandon any in-progress endpoint pick (tool switch, Escape, session end) */
  resetPending() {
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    this.host.setPendingPoint(null); // the marker must not outlive the pick
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
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, this.host.pickTol());
    const ent = idx >= 0 ? entities[idx] : undefined;
    if (!ent || curveKind(ent) !== "line") return this.missed();
    if (t === "horizontal" || t === "vertical") {
      // constraining the projected line ITSELF is meaningless — it's fixed
      if (ent.type !== "line") return this.host.warn(PROJECTED_FIXED_MSG);
      if (t === "horizontal") this.addConstraint({ type: "horizontal", line: ent.id });
      else this.addConstraint({ type: "vertical", line: ent.id });
    } else {
      const id = ent.id;
      // two-line constraints: first click stores, second applies
      if (this.host.getFilletFirst() == null) {
        this.host.setFilletFirst(idx);
        return;
      }
      const a = entities[this.host.getFilletFirst()!]?.id;
      this.host.setFilletFirst(null);
      if (!a || a === id) return this.missed();
      if (t === "parallel") this.addConstraint({ type: "parallel", l1: a, l2: id });
      else if (t === "perpendicular") this.addConstraint({ type: "perpendicular", l1: a, l2: id });
      else if (t === "collinear") this.addConstraint({ type: "collinear", l1: a, l2: id });
    }
  }

  /** nearest addressable endpoint (line/arc/spline end, or a point entity) to p */
  private pickEndpoint(p: THREE.Vector2): { id: string; idx: number } | null {
    const tol = this.host.pickTol();
    let best: { id: string; idx: number } | null = null;
    let bestD = tol * tol;
    const consider = (id: string, idx: number, x: number, y: number) => {
      const dx = x - p.x, dy = y - p.y, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = { id, idx }; }
    };
    for (const e of this.host.entities()) {
      if (e.type === "line") { consider(e.id, 0, e.x1, e.y1); consider(e.id, 1, e.x2, e.y2); }
      else if (e.type === "arc") { consider(e.id, 0, e.x1, e.y1); consider(e.id, 1, e.x2, e.y2); }
      else if (e.type === "point") consider(e.id, 0, e.x, e.y);
      else if (e.type === "spline") {
        const first = e.points[0], last = e.points[e.points.length - 1];
        if (first) consider(e.id, 0, first.x, first.y);
        if (last) consider(e.id, 1, last.x, last.y);
      } else if (e.type === "projected") {
        // projected endpoints are addressable anchors (coincident-to-reference
        // is the sticks-to-projection behavior); poly exposes first/last samples
        const cv = e.curve;
        if (cv.kind === "line" || cv.kind === "arc") {
          consider(e.id, 0, cv.x1, cv.y1);
          consider(e.id, 1, cv.x2, cv.y2);
        } else if (cv.kind === "poly") {
          projEndSamples(cv).forEach(([x, y], k) => consider(e.id, k, x, y));
        }
      }
    }
    return best;
  }

  /** Plane coordinates of an endpoint reference, so the host can mark it on
   *  screen. Mirrors pickEndpoint's own idea of which points are addressable —
   *  if a point can be picked it can be shown, and vice versa. */
  private endpointXY(ep: { id: string; idx: number }): { x: number; y: number } | null {
    const e = this.host.entities().find((x) => x.id === ep.id);
    if (!e) return null;
    if (e.type === "point") return { x: e.x, y: e.y };
    if (e.type === "line" || e.type === "arc") {
      return ep.idx === 0 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
    }
    if (e.type === "spline") {
      const pt = ep.idx === 0 ? e.points[0] : e.points[e.points.length - 1];
      return pt ? { x: pt.x, y: pt.y } : null;
    }
    if (e.type === "projected") {
      const cv = (e as any).curve;
      if (!cv) return null;
      if (cv.kind === "line" || cv.kind === "arc") {
        return ep.idx === 0 ? { x: cv.x1, y: cv.y1 } : { x: cv.x2, y: cv.y2 };
      }
      const s = projEndSamples(cv)[ep.idx];
      return s ? { x: s[0], y: s[1] } : null;
    }
    return null;
  }

  private pointConstraintClick(p: THREE.Vector2) {
    const t = this.host.tool();
    const entities = this.host.entities();
    if (t === "midpoint") {
      // pick a point/endpoint, then a line
      if (!this.pendingEndpoint) {
        const ep = this.pickEndpoint(p);
        if (!ep) return this.missed();
        this.pendingEndpoint = ep;
        this.host.setPendingPoint(this.endpointXY(ep));
        return;
      }
      const idx = pickEntity(entities, p, this.host.pickTol());
      const e = idx >= 0 ? entities[idx] : null;
      const ep = this.pendingEndpoint;
      this.pendingEndpoint = null;
      this.host.setPendingPoint(null);
      if (e && curveKind(e) === "line" && e.id !== ep.id) this.addConstraint({ type: "midpoint", e: ep.id, p: ep.idx, line: e.id });
      else this.missed();
      return;
    }
    if (t === "coincident") {
      const ep = this.pickEndpoint(p);
      if (ep) {
        // An endpoint pick is the primary flow and wins over any line held for
        // the collinear fallback below.
        this.host.setFilletFirst(null);
        if (!this.pendingEndpoint) {
          this.pendingEndpoint = ep;
          this.host.setPendingPoint(this.endpointXY(ep));
          return;
        }
        const a = this.pendingEndpoint;
        this.pendingEndpoint = null;
        this.host.setPendingPoint(null);
        if (a.id !== ep.id) this.addConstraint({ type: "coincident", e1: a.id, p1: a.idx, e2: ep.id, p2: ep.idx });
        return;
      }

      // No endpoint under the cursor. This used to be a bare `return`: no
      // constraint, no message, no highlight — indistinguishable from a broken
      // tool, and the reason both a field reporter and the author concluded
      // sketch lines were not selectable at all.
      const ents = this.host.entities();
      const idx = pickEntity(ents, p, this.host.pickTol());
      const ent = idx >= 0 ? ents[idx] : undefined;
      if (!ent || curveKind(ent) !== "line") {
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
      const first = this.host.getFilletFirst();
      if (first == null) {
        this.host.setFilletFirst(idx);
        return;
      }
      const a = ents[first]?.id;
      this.host.setFilletFirst(null);
      if (!a || a === ent.id) return;
      this.addConstraint({ type: "collinear", l1: a, l2: ent.id });
      this.host.warn("Two lines: applied Collinear (Coincident joins endpoints).");
      return;
    }
    // symmetric: pick endpoint A, endpoint B, then the axis line
    if (!this.pendingEndpoint) {
      const ep = this.pickEndpoint(p);
      if (!ep) return this.missed();
      this.pendingEndpoint = ep;
      this.host.setPendingPoint(this.endpointXY(ep));
      return;
    }
    if (!this.pendingEndpoint2) {
      const ep = this.pickEndpoint(p);
      if (!ep) return this.missed();
      if (ep && ep.id !== this.pendingEndpoint.id) this.pendingEndpoint2 = ep;
      return;
    }
    // third click: the symmetry axis line
    const idx = pickEntity(entities, p, this.host.pickTol());
    const e = idx >= 0 ? entities[idx] : null;
    const a = this.pendingEndpoint, b = this.pendingEndpoint2;
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    if (e && curveKind(e) === "line") this.addConstraint({ type: "symmetric", e1: a.id, p1: a.idx, e2: b.id, p2: b.idx, line: e.id });
  }

  /** Two-pick flow shared by tangent/equal/concentric: returns [first, second]
   *  once a second valid curve lands (both pass `ok`, distinct); null while
   *  arming the first pick or on an invalid pick. Uses the filletFirst slot. */
  private pickPair(p: THREE.Vector2, ok: (e: ResolvedEntity) => boolean): [ResolvedEntity, ResolvedEntity] | null {
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, this.host.pickTol());
    const e = idx >= 0 ? entities[idx] : undefined;
    if (!e || !ok(e)) return null;
    if (this.host.getFilletFirst() == null) { this.host.setFilletFirst(idx); return null; }
    const first = entities[this.host.getFilletFirst()!];
    this.host.setFilletFirst(null);
    if (!first || first.id === e.id) return null;
    return [first, e];
  }

  /** tangent between two curves: line/circle/arc, in any mix except line+line.
   *  Emits the general `tangent2`; the compiler picks the right planegcs variant. */
  private tangentClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, isCurve);
    if (!pair) return this.missed();
    const [first, e] = pair;
    // two lines cannot be tangent — say so rather than swallowing the pick
    if (curveKind(first) === "line" && curveKind(e) === "line") return this.missed();
    this.addConstraint({ type: "tangent2", a: first.id, b: e.id });
  }

  /** equal: two lines share length, or two circles/arcs share radius. */
  private equalClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, isCurve);
    if (!pair) return this.missed();
    const [first, e] = pair;
    if (curveKind(first) === "line" && curveKind(e) === "line") {
      this.addConstraint({ type: "equal", l1: first.id, l2: e.id });
    } else if (isRound(first) && isRound(e)) {
      this.addConstraint({ type: "equalRadius", a: first.id, b: e.id });
    }
  }

  private concentricClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, isRound); // circles and arcs both carry a center
    if (!pair) return this.missed();
    this.addConstraint({ type: "concentric", c1: pair[0].id, c2: pair[1].id });
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

  private addConstraint(c: SketchConstraint) {
    this.host.addConstraint(c);
  }
}
