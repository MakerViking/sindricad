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
  /** the second argument of every addConstraint call, 1:1 with `_cons`.
   *
   *  Recorded because DROPPING it was invisible: this host used to declare
   *  `addConstraint(c: SketchConstraint)` and silently discard the mover, so
   *  inverting every one of the four two-pick sites at once (`a.ent.id` ->
   *  `b.ent.id`, `first.ent.id` -> `e.ent.id`, `pair[0]` -> `pair[1]`) left the
   *  whole sketch suite green — the tests observed the CALL and not the effect
   *  the call is for. `moves` is what makes "what you picked first is what
   *  moves" true (bug #86), and it is not carried by the constraint itself, so
   *  the only place it can be asserted is here. */
  moves: (string | undefined)[] = [];
  addConstraint(c: SketchConstraint, moves?: string) {
    this._cons.push(c);
    this.moves.push(moves);
    this.solves++;
  }
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

// Bug #86's POLICY, at the layer that decides it: the entity picked FIRST is the
// one the next solve is allowed to move. Every flow below is run in BOTH pick
// orders, because that is the only shape that catches an inversion — an
// assertion in one order alone passes for `moves = the other one` half the time.
//
// Nothing in the suite observed this before: the host dropped the second
// argument on the floor, so inverting all four sites at once left 639 tests
// green while the field-reported bug came straight back.
describe("which entity the pick order nominates as the mover (bug #86)", () => {
  /** run a two-click flow and report the single mover it stamped */
  const moverOf = (tool: SketchTool, ents: ResolvedEntity[], first: THREE.Vector2, second: THREE.Vector2) => {
    const h = new MockHost();
    h._ents = ents;
    h._tool = tool;
    const ct = new ConstraintTools(h);
    ct.click(first);
    ct.click(second);
    expect(h._cons).toHaveLength(1); // the flow really completed
    return h.moves[0];
  };

  const twoLines = (): ResolvedEntity[] => [
    { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
  ];
  const twoCircles = (): ResolvedEntity[] => [
    { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
    { type: "circle", id: "c2", radius: 8, x: 0, y: 0 },
  ];

  it("parallel/perpendicular/collinear: the first line", () => {
    for (const t of ["parallel", "perpendicular", "collinear"] as const) {
      expect(moverOf(t, twoLines(), v(5, 0), v(5, 5))).toBe("l1");
      expect(moverOf(t, twoLines(), v(5, 5), v(5, 0))).toBe("l2"); // the inverse
    }
  });

  it("tangent: the first curve, line or circle", () => {
    const mix = (): ResolvedEntity[] => [
      { type: "line", id: "l1", x1: -10, y1: 5, x2: 10, y2: 5 },
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
    ];
    expect(moverOf("tangent", mix(), v(0, 5), v(5, 0))).toBe("l1");
    expect(moverOf("tangent", mix(), v(5, 0), v(0, 5))).toBe("c1");
  });

  it("equal (lengths) and equal-radius: the first pick", () => {
    expect(moverOf("equal", twoLines(), v(5, 0), v(5, 5))).toBe("l1");
    expect(moverOf("equal", twoLines(), v(5, 5), v(5, 0))).toBe("l2");
    // the radius half is the one where an inversion is VISIBLE in the document:
    // the circle the user did not pick is the one that changes size
    expect(moverOf("equal", twoCircles(), v(5, 0), v(8, 0))).toBe("c1");
    expect(moverOf("equal", twoCircles(), v(8, 0), v(5, 0))).toBe("c2");
  });

  it("concentric: the first round", () => {
    expect(moverOf("concentric", twoCircles(), v(5, 0), v(8, 0))).toBe("c1");
    expect(moverOf("concentric", twoCircles(), v(8, 0), v(5, 0))).toBe("c2");
  });

  it("coincident: the first ENDPOINT, and its line-body fallback the first line", () => {
    expect(moverOf("coincident", twoLines(), v(0, 0), v(0, 5))).toBe("l1");
    expect(moverOf("coincident", twoLines(), v(0, 5), v(0, 0))).toBe("l2");
    // two line BODIES fall through to collinear — same rule
    expect(moverOf("coincident", twoLines(), v(5, 0), v(5, 5))).toBe("l1");
    expect(moverOf("coincident", twoLines(), v(5, 5), v(5, 0))).toBe("l2");
  });

  it("midpoint: the POINT, which is always the first pick of that flow", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    expect(moverOf("midpoint", ents, v(0, 0), v(5, 5))).toBe("l1");
  });

  it("symmetric: the first of the two mirrored points, not the axis", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 0, y1: 10, x2: 10, y2: 10 },
      { type: "line", id: "ax", x1: -5, y1: 5, x2: 15, y2: 5 },
    ];
    h._tool = "symmetric";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0));  // point A
    ct.click(v(0, 10)); // point B
    ct.click(v(5, 5));  // the axis
    expect(h._cons).toHaveLength(1);
    expect(h.moves[0]).toBe("l1"); // A swings onto B's mirror, not the pair meeting
  });

  it("a rectangle EDGE nominates the RECTANGLE, not the edge operand", () => {
    // `R~0` is a line operand and not an entity, and sketchSolve's `moves` set is
    // about ENTITIES: the mover has to be the rectangle or its corners never come
    // free. The operand id is what every other field of the constraint carries,
    // which is exactly why this one is easy to get wrong.
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 40 },
      { type: "line", id: "l2", x1: -10, y1: 30, x2: 10, y2: 30 },
    ];
    const h = new MockHost();
    h._ents = ents;
    h._tool = "parallel";
    const ct = new ConstraintTools(h);
    ct.click(v(0, -20)); // the rectangle's BOTTOM edge
    ct.click(v(0, 30));  // the line
    expect(h._cons).toEqual([{ type: "parallel", l1: "R~0", l2: "l2" }]);
    expect(h.moves[0]).toBe("R"); // the entity, not "R~0"
  });

  it("a one-pick constraint nominates nobody", () => {
    // horizontal/vertical/fix have no second operand to hold still, so there is
    // no policy to express — and a `moves` that named the sole operand would
    // anchor the whole sketch against it for nothing.
    const h = new MockHost();
    h._ents = [{ type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 1 }];
    h._tool = "horizontal";
    new ConstraintTools(h).click(v(5, 0.5));
    expect(h._cons).toEqual([{ type: "horizontal", line: "l1" }]);
    expect(h.moves[0]).toBeUndefined();
  });
});
