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
});
