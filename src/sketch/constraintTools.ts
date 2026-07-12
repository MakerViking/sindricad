// The 9 constraint-tool click flows (horizontal/vertical/parallel/perpendicular/
// equal/tangent/coincident/concentric/symmetric): each adds a persistent geometric
// constraint that the solver maintains alongside every other constraint already on
// the sketch. Operates purely through the ConstraintHost accessor SketchMode
// provides — no state is copied, so this collaborator always sees SketchMode's
// live entities/constraints.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { pickEntity } from "./modify";
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
]);

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
}

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
  }

  /** add a persistent geometric constraint and re-solve (the solver maintains
   *  all constraints together, not just the one you applied). */
  click(p: THREE.Vector2) {
    const t = this.host.tool();
    // point-based constraints pick the nearest endpoint, not an entity body
    if (t === "coincident" || t === "symmetric" || t === "midpoint") {
      return this.pointConstraintClick(p);
    }
    if (t === "tangent") return this.tangentClick(p);
    if (t === "concentric") return this.concentricClick(p);

    // line-based constraints (horizontal/vertical/parallel/perpendicular/equal)
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, this.host.pickTol());
    const ent = idx >= 0 ? entities[idx] : undefined;
    if (!ent || ent.type !== "line") return;
    const id = ent.id;
    if (t === "horizontal") this.addConstraint({ type: "horizontal", line: id });
    else if (t === "vertical") this.addConstraint({ type: "vertical", line: id });
    else {
      // two-line constraints: first click stores, second applies
      if (this.host.getFilletFirst() == null) {
        this.host.setFilletFirst(idx);
        return;
      }
      const a = entities[this.host.getFilletFirst()!]?.id;
      this.host.setFilletFirst(null);
      if (!a || a === id) return;
      if (t === "parallel") this.addConstraint({ type: "parallel", l1: a, l2: id });
      else if (t === "perpendicular") this.addConstraint({ type: "perpendicular", l1: a, l2: id });
      else if (t === "equal") this.addConstraint({ type: "equal", l1: a, l2: id });
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
      }
    }
    return best;
  }

  private pointConstraintClick(p: THREE.Vector2) {
    const t = this.host.tool();
    const entities = this.host.entities();
    if (t === "midpoint") {
      // pick a point/endpoint, then a line
      if (!this.pendingEndpoint) {
        const ep = this.pickEndpoint(p);
        if (ep) this.pendingEndpoint = ep;
        return;
      }
      const idx = pickEntity(entities, p, this.host.pickTol());
      const e = idx >= 0 ? entities[idx] : null;
      const ep = this.pendingEndpoint;
      this.pendingEndpoint = null;
      if (e?.type === "line" && e.id !== ep.id) this.addConstraint({ type: "midpoint", e: ep.id, p: ep.idx, line: e.id });
      return;
    }
    if (t === "coincident") {
      const ep = this.pickEndpoint(p);
      if (!ep) return;
      if (!this.pendingEndpoint) { this.pendingEndpoint = ep; return; }
      const a = this.pendingEndpoint;
      this.pendingEndpoint = null;
      if (a.id !== ep.id) this.addConstraint({ type: "coincident", e1: a.id, p1: a.idx, e2: ep.id, p2: ep.idx });
      return;
    }
    // symmetric: pick endpoint A, endpoint B, then the axis line
    if (!this.pendingEndpoint) {
      const ep = this.pickEndpoint(p);
      if (ep) this.pendingEndpoint = ep;
      return;
    }
    if (!this.pendingEndpoint2) {
      const ep = this.pickEndpoint(p);
      if (ep && ep.id !== this.pendingEndpoint.id) this.pendingEndpoint2 = ep;
      return;
    }
    // third click: the symmetry axis line
    const idx = pickEntity(entities, p, this.host.pickTol());
    const e = idx >= 0 ? entities[idx] : null;
    const a = this.pendingEndpoint, b = this.pendingEndpoint2;
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    if (e?.type === "line") this.addConstraint({ type: "symmetric", e1: a.id, p1: a.idx, e2: b.id, p2: b.idx, line: e.id });
  }

  private tangentClick(p: THREE.Vector2) {
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, this.host.pickTol());
    if (idx < 0) return;
    const e = entities[idx];
    if (!e) return;
    if (this.host.getFilletFirst() == null) {
      // store first pick if it's a line or a circle
      if (e.type === "line" || e.type === "circle") this.host.setFilletFirst(idx);
      return;
    }
    const first = entities[this.host.getFilletFirst()!];
    this.host.setFilletFirst(null);
    if (!first || first.id === e.id) return;
    const line = first.type === "line" ? first : e.type === "line" ? e : null;
    const circle = first.type === "circle" ? first : e.type === "circle" ? e : null;
    if (line && circle) this.addConstraint({ type: "tangent", line: line.id, circle: circle.id });
  }

  private concentricClick(p: THREE.Vector2) {
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, this.host.pickTol());
    if (idx < 0 || entities[idx]?.type !== "circle") return;
    if (this.host.getFilletFirst() == null) { this.host.setFilletFirst(idx); return; }
    const a = entities[this.host.getFilletFirst()!];
    this.host.setFilletFirst(null);
    const b = entities[idx];
    if (a && b && a.id !== b.id && a.type === "circle") this.addConstraint({ type: "concentric", c1: a.id, c2: b.id });
  }

  private addConstraint(c: SketchConstraint) {
    this.host.constraints().push(c);
    this.host.requestSolve();
  }
}
