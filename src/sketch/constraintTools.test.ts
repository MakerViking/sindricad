import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ConstraintTools, type ConstraintHost } from "./constraintTools";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { SketchTool } from "./sketchMode";

// Minimal live-accessor host mirroring what SketchMode provides. pickEntity
// (from modify.ts) is the real implementation, so clicks are aimed at geometry.
class MockHost implements ConstraintHost {
  _tool: SketchTool = "select";
  _ents: ResolvedEntity[] = [];
  _cons: SketchConstraint[] = [];
  _fillet: number | null = null;
  solves = 0;
  tool() { return this._tool; }
  entities() { return this._ents; }
  constraints() { return this._cons; }
  pickTol() { return 1; }
  getFilletFirst() { return this._fillet; }
  setFilletFirst(i: number | null) { this._fillet = i; }
  requestSolve() { this.solves++; }
  warnings: string[] = [];
  warn(msg: string) { this.warnings.push(msg); }
  pending: { x: number; y: number } | null = null;
  pendingSets = 0;
  pendingAll: { x: number; y: number }[] = [];
  setPendingPoints(ps: { x: number; y: number }[]) {
    this.pendingAll = ps;
    this.pending = ps[0] ?? null; // `pending` stays "the first held point"
    this.pendingSets++;
  }
  addConstraint(c: SketchConstraint) { this._cons.push(c); this.solves++; }
}

const v = (x: number, y: number) => new THREE.Vector2(x, y);

describe("constraintTools click flows (Tier 1 additions)", () => {
  it("equal on two lines emits an `equal` constraint", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    h._tool = "equal";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0)); // first line body
    ct.click(v(5, 5)); // second line body
    expect(h._cons).toEqual([{ type: "equal", l1: "l1", l2: "l2" }]);
  });

  it("equal on two circles emits `equalRadius` (NEW)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "circle", id: "c2", radius: 3, x: 20, y: 0 },
    ];
    h._tool = "equal";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0));  // on c1 rim
    ct.click(v(23, 0)); // on c2 rim
    expect(h._cons).toEqual([{ type: "equalRadius", a: "c1", b: "c2" }]);
  });

  it("tangent on a line + circle emits the general `tangent2` (NEW)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: -10, y1: 5, x2: 10, y2: 5 },
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
    ];
    h._tool = "tangent";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 5)); // line
    ct.click(v(5, 0)); // circle rim
    expect(h._cons).toEqual([{ type: "tangent2", a: "l1", b: "c1" }]);
  });

  it("tangent refuses two lines", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    h._tool = "tangent";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0));
    ct.click(v(5, 5));
    expect(h._cons).toEqual([]);
  });

  it("concentric accepts circles (and the same path serves arcs)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "circle", id: "c2", radius: 8, x: 0, y: 0 },
    ];
    h._tool = "concentric";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0)); // c1 rim
    ct.click(v(8, 0)); // c2 rim
    expect(h._cons).toEqual([{ type: "concentric", c1: "c1", c2: "c2" }]);
  });

  it("collinear on two lines emits a `collinear` constraint (NEW)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 20, y1: 2, x2: 30, y2: 2 },
    ];
    h._tool = "collinear";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0));
    ct.click(v(25, 2));
    expect(h._cons).toEqual([{ type: "collinear", l1: "l1", l2: "l2" }]);
  });

  it("fix pins the nearest point — a circle center → {fix, p:0} (NEW)", () => {
    const h = new MockHost();
    h._ents = [{ type: "circle", id: "c1", radius: 5, x: 0, y: 0 }];
    h._tool = "fix";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0)); // at the center
    expect(h._cons).toEqual([{ type: "fix", e: "c1", p: 0 }]);
  });

  it("fix on a line endpoint records that endpoint index", () => {
    const h = new MockHost();
    h._ents = [{ type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 }];
    h._tool = "fix";
    const ct = new ConstraintTools(h);
    ct.click(v(10, 0)); // the end (index 1)
    expect(h._cons).toEqual([{ type: "fix", e: "l1", p: 1 }]);
  });

  it("fix on projected geometry adds nothing and warns (it is already fixed)", () => {
    const h = new MockHost();
    h._ents = [{
      type: "projected", id: "p1",
      source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
      curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
    }];
    h._tool = "fix";
    const ct = new ConstraintTools(h);
    ct.click(v(10, 0));
    expect(h._cons).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/Break Link/);
  });
});

// Coincident is point-to-point, so clicking a line BODY used to hit a bare
// `return`: no constraint, no message, no marker. Thomas hit it in the app on
// 2026-08-15 and GitHub #17 reported it as "sketch lines aren't selectable" —
// the tool is indistinguishable from a broken one. These pin the three ways out.
describe("coincident: the silent-miss fixes", () => {
  const twoLines = (): ResolvedEntity[] => [
    { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
  ];

  it("marks the endpoint it is holding after the first pick", () => {
    const h = new MockHost();
    h._ents = twoLines();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0)); // endpoint of l1
    expect(h.pending).toEqual({ x: 0, y: 0 });
    expect(h._cons).toEqual([]); // nothing applied yet — it is a two-click flow
  });

  it("clears the marker once the pair completes", () => {
    const h = new MockHost();
    h._ents = twoLines();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0));
    ct.click(v(0, 5));
    expect(h._cons).toEqual([{ type: "coincident", e1: "l1", p1: 0, e2: "l2", p2: 0 }]);
    expect(h.pending).toBeNull();
  });

  it("clears the marker when the pick is abandoned", () => {
    const h = new MockHost();
    h._ents = twoLines();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0));
    ct.resetPending();
    expect(h.pending).toBeNull();
  });

  it("applies COLLINEAR when two line bodies are picked, as SolidWorks and Fusion do", () => {
    const h = new MockHost();
    h._ents = twoLines();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0)); // middle of l1 — no endpoint here
    ct.click(v(5, 5)); // middle of l2
    expect(h._cons).toEqual([{ type: "collinear", l1: "l1", l2: "l2" }]);
  });

  it("says something when the click hits nothing at all", () => {
    const h = new MockHost();
    h._ents = twoLines();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(50, 50)); // empty space
    expect(h._cons).toEqual([]);
    expect(h.warnings.join(" ")).toMatch(/ENDPOINTS/);
    expect(h.warnings.join(" ")).toMatch(/Collinear/);
  });

  it("does not throw away a first endpoint pick on a stray click", () => {
    const h = new MockHost();
    h._ents = twoLines();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0));      // good first pick
    ct.click(v(50, 50));    // stray
    expect(h.pending).toEqual({ x: 0, y: 0 }); // still held
    ct.click(v(0, 5));      // second endpoint still completes it
    expect(h._cons).toEqual([{ type: "coincident", e1: "l1", p1: 0, e2: "l2", p2: 0 }]);
  });
});
