import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ConstraintTools, type ConstraintHost } from "./constraintTools";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { SketchTool } from "./sketchMode";
import { t } from "../i18n";
import { originGeometry, ORIGIN_ID, ORIGIN_X_ID, ORIGIN_Y_ID } from "./origin";

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
    expect(h.warnings).toEqual([t("sketch.constraint.coincidentMiss")]);
    expect(h.warnings.join(" "), "and it names every kind of point that works")
      .toMatch(/corner.*centre.*sketch point/);
    expect(h.warnings.join(" "), "and the curves a point can go on")
      .toMatch(/line, circle or arc/);
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

// Field report 356b2693: an outline left 0.0196 mm open by a trim. Both ends are
// far inside any pick tolerance, so the user cannot aim at one or the other:
// both clicks land on the same spot. The nearest-point pick resolved the second
// click to the point already held and refused it as "the same point twice", so
// the one tool that closes such a gap could not be used on it.
describe("joining two ends closer together than the pick tolerance", () => {
  const nearGap = (): ResolvedEntity[] => [
    { type: "line", id: "a", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "line", id: "b", x1: 10.0196, y1: 0.0005, x2: 20, y2: 8 },
  ];

  it("coincident: the second click on the same spot takes the OTHER end", () => {
    const h = new MockHost();
    h._ents = nearGap();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(10, 0));
    ct.click(v(10, 0));
    expect(h.warnings).toEqual([]);
    expect(h._cons).toEqual([{ type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 }]);
  });

  it("the hover after the first pick shows the end the second click will take", () => {
    const h = new MockHost();
    h._ents = nearGap();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    expect(ct.hoverPoint(v(10, 0))).toEqual({ x: 10, y: 0 }); // nothing held yet
    ct.click(v(10, 0));
    expect(ct.hoverPoint(v(10, 0))).toEqual({ x: 10.0196, y: 0.0005 });
  });

  it("a lone end clicked twice is still the same point twice, and says so", () => {
    const h = new MockHost();
    h._ents = nearGap();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0));
    ct.click(v(0, 0));
    expect(h._cons).toEqual([]);
    expect(h.warnings).toEqual([t("sketch.constraint.samePointTwice")]);
  });

  it("symmetric: the second pick takes the other end too", () => {
    const h = new MockHost();
    h._ents = [...nearGap(), { type: "line", id: "ax", x1: 10, y1: -20, x2: 10, y2: 20 }];
    h._tool = "symmetric";
    const ct = new ConstraintTools(h);
    ct.click(v(10, 0));
    ct.click(v(10, 0));
    ct.click(v(10, 15)); // the axis
    expect(h.warnings).toEqual([]);
    expect(h._cons).toEqual([{ type: "symmetric", e1: "a", p1: 1, e2: "b", p2: 0, line: "ax" }]);
  });

  it("symmetric: a shared corner clicked twice is still the same point", () => {
    // the other line's end sits EXACTLY on the held one: one solver point, and
    // mirroring it onto itself would pin the corner to the axis
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "a", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "b", x1: 10, y1: 0, x2: 20, y2: 8 },
      { type: "line", id: "ax", x1: 15, y1: -20, x2: 15, y2: 20 },
    ];
    h._tool = "symmetric";
    const ct = new ConstraintTools(h);
    ct.click(v(10, 0));
    ct.click(v(10, 0));
    expect(h.warnings).toEqual([t("sketch.constraint.alreadyPicked")]);
    ct.click(v(15, 10)); // what would have been the axis
    expect(h._cons).toEqual([]);
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

describe("a circle or arc CENTRE is a point the constraint tools can pick", () => {
  // Reported 2026-09-01, with the document: Coincident aimed at a circle's
  // centre did nothing at all. The centre is addressable by every dimension and
  // by `fix` (both resolve through dimRefPoints), and the constraint picker kept
  // a SECOND list of point providers with no circle in it — so the click armed
  // nothing, fell through to the entity pick, missed there too (a circle is
  // measured by its RIM, so its centre is not on it), and answered with a
  // message about endpoints. A dead tool, on a target the app draws a snap dot
  // on.
  const circleAndRect = (): ResolvedEntity[] => [
    { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 },
    { type: "circle", id: "K", x: 60, y: 30, radius: 12 },
  ];

  it("arms the centre on the first click, and marks it", () => {
    const h = new MockHost();
    h._ents = circleAndRect();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(60, 30)); // dead on the circle's centre — nowhere near its rim
    expect(h.warnings, "a click on a real target must not report a miss").toEqual([]);
    expect(h.pending, "the held point is the centre").toEqual({ x: 60, y: 30 });
  });

  it("joins a rectangle corner to a circle centre", () => {
    const h = new MockHost();
    h._ents = circleAndRect();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(20, 10)); // rect corner 2 (tr)
    ct.click(v(60, 30)); // circle centre
    expect(h._cons).toEqual([{ type: "coincident", e1: "R", p1: 2, e2: "K", p2: 0 }]);
    expect(h.moves[0], "the first pick is the mover").toBe("R");
  });

  it("takes an ARC centre at index 2, the index every dimension uses for it", () => {
    const h = new MockHost();
    // quarter arc about (0,0), r 20: ends at (20,0) and (0,20)
    h._ents = [
      { type: "arc", id: "A", x1: 20, y1: 0, x2: 0, y2: 20, mx: Math.SQRT1_2 * 20, my: Math.SQRT1_2 * 20 },
      { type: "point", id: "T", x: 50, y: 50 },
    ];
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0));   // the arc's CENTRE — neither of its ends is here
    ct.click(v(50, 50)); // the sketch point
    expect(h._cons).toEqual([{ type: "coincident", e1: "A", p1: 2, e2: "T", p2: 0 }]);
  });

  it("hovers what it picks: the highlight sits on the centre", () => {
    // The invariant this picker exists to keep — a point you can hit is one you
    // can see, and the reverse. hoverPoint and the click flows both resolve
    // through pickEndpoint, so this goes red the moment they are given separate
    // lists again.
    const h = new MockHost();
    h._ents = circleAndRect();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    expect(ct.hoverPoint(v(60.4, 30.3))).toEqual({ x: 60, y: 30 });
  });

  it("midpoint and symmetric take a centre too", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "K", x: 60, y: 30, radius: 12 },
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 40, y2: 0 },
      { type: "point", id: "T", x: 5, y: 40 },
    ];
    h._tool = "midpoint";
    const ct = new ConstraintTools(h);
    ct.click(v(60, 30)); // the centre
    ct.click(v(20, 0));  // the line to centre it on
    expect(h._cons).toEqual([{ type: "midpoint", e: "K", p: 0, line: "l1" }]);

    h._cons = [];
    h._tool = "symmetric";
    const st = new ConstraintTools(h);
    st.click(v(60, 30)); // the centre
    st.click(v(5, 40));  // the sketch point
    st.click(v(20, 0));  // the axis
    expect(h._cons).toEqual([
      { type: "symmetric", e1: "K", p1: 0, e2: "T", p2: 0, line: "l1" },
    ]);
  });
});

// TA 38391076 and Doug 21: "A point can't be coincident with a line." Before
// pointOn existed, a point then a line body warned "click the second ENDPOINT",
// and a line body then a point dropped the held line without a word. Every
// case runs through the real click flow, in both orders where there are two.
describe("Coincident puts a point ON a line, circle or arc", () => {
  const run = (ents: ResolvedEntity[], ...clicks: THREE.Vector2[]) => {
    const h = new MockHost();
    h._ents = ents;
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    for (const c of clicks) ct.click(c);
    return h;
  };
  // a free point P at (5,8) and a line along y = 0 from x 0 to 20
  const pointAndLine = (): ResolvedEntity[] => [
    { type: "line", id: "l1", x1: 0, y1: 0, x2: 20, y2: 0 },
    { type: "point", id: "P", x: 5, y: 8 },
  ];

  it("point first, then the line's middle", () => {
    const h = run(pointAndLine(), v(5, 8), v(12, 0));
    expect(h._cons).toEqual([{ type: "pointOn", e: "P", p: 0, curve: "l1" }]);
    expect(h.warnings, "no 'click the second endpoint' any more").toEqual([]);
    expect(h.pending, "the held point's marker is cleared").toBeNull();
  });

  it("the line's middle first, then the point: same constraint, nothing dropped", () => {
    const h = run(pointAndLine(), v(12, 0), v(5, 8));
    expect(h._cons).toEqual([{ type: "pointOn", e: "P", p: 0, curve: "l1" }]);
    expect(h.warnings).toEqual([]);
  });

  it("the POINT is what moves, in either order", () => {
    expect(run(pointAndLine(), v(5, 8), v(12, 0)).moves).toEqual(["P"]);
    expect(run(pointAndLine(), v(12, 0), v(5, 8)).moves).toEqual(["P"]);
  });

  it("a line's END goes on another line, by its end index", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 20, y2: 0 },
      { type: "line", id: "l2", x1: 10, y1: 3, x2: 14, y2: 12 },
    ];
    expect(run(ents, v(10, 3), v(4, 0))._cons).toEqual([{ type: "pointOn", e: "l2", p: 0, curve: "l1" }]);
  });

  it("the reporter's case: a rectangle corner onto another rectangle's side", () => {
    // two stacked rectangles (the 38391076 document), the upper one's bottom-left
    // corner put on the lower one's TOP edge
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "R0", x: 0, y: 0, width: 60, height: 20 },
      { type: "rectangle", id: "R1", x: 10, y: 25, width: 20, height: 10 },
    ];
    const h = run(ents, v(0, 20), v(-10, 10)); // R1's corner 0 (bl), then R0's top edge
    expect(h._cons).toEqual([{ type: "pointOn", e: "R1", p: 0, curve: "R0~2" }]);
  });

  it("a point on a circle's rim, and on an arc", () => {
    const circle: ResolvedEntity[] = [
      { type: "circle", id: "K", x: 0, y: 0, radius: 10 },
      { type: "point", id: "P", x: 30, y: 4 },
    ];
    expect(run(circle, v(30, 4), v(0, 10))._cons).toEqual([{ type: "pointOn", e: "P", p: 0, curve: "K" }]);
    expect(run(circle, v(-10, 0), v(30, 4))._cons).toEqual([{ type: "pointOn", e: "P", p: 0, curve: "K" }]);
    const arc: ResolvedEntity[] = [
      // quarter arc about (0,0), r 10, ends (10,0) and (0,10)
      { type: "arc", id: "A", x1: 10, y1: 0, x2: 0, y2: 10, mx: Math.SQRT1_2 * 10, my: Math.SQRT1_2 * 10 },
      { type: "point", id: "P", x: 30, y: 4 },
    ];
    expect(run(arc, v(30, 4), v(Math.SQRT1_2 * 10, Math.SQRT1_2 * 10))._cons)
      .toEqual([{ type: "pointOn", e: "P", p: 0, curve: "A" }]);
  });

  it("a point on a polygon side or a slot side, through their side operands", () => {
    // hexagon about (0,0), r 10, first vertex at angle 0: side 0 runs (10,0) ->
    // (5, 8.66), so its middle is (7.5, 4.33)
    const hex: ResolvedEntity[] = [
      { type: "polygon", id: "H", x: 0, y: 0, radius: 10, sides: 6, angle: 0 },
      { type: "point", id: "P", x: 30, y: 4 },
    ];
    expect(run(hex, v(30, 4), v(7.5, 4.33))._cons).toEqual([{ type: "pointOn", e: "P", p: 0, curve: "H~0" }]);
    expect(run(hex, v(-7.5, -4.33), v(30, 4))._cons).toEqual([{ type: "pointOn", e: "P", p: 0, curve: "H~3" }]);
    // slot from (0,0) to (20,0), 6 wide: side 0 is y = +3 (left of the axis),
    // side 1 is y = -3
    const slot: ResolvedEntity[] = [
      { type: "slot", id: "S", x1: 0, y1: 0, x2: 20, y2: 0, width: 6 },
      { type: "point", id: "P", x: 30, y: 14 },
    ];
    expect(run(slot, v(30, 14), v(10, 3))._cons).toEqual([{ type: "pointOn", e: "P", p: 0, curve: "S~0" }]);
    expect(run(slot, v(30, 14), v(10, -3))._cons).toEqual([{ type: "pointOn", e: "P", p: 0, curve: "S~1" }]);
  });

  it("a slot's round END is not a side: refused out loud, and the point stays held", () => {
    const slot: ResolvedEntity[] = [
      { type: "slot", id: "S", x1: 0, y1: 0, x2: 20, y2: 0, width: 6 },
      { type: "point", id: "P", x: 30, y: 14 },
    ];
    const h = run(slot, v(30, 14), v(23, 0)); // the cap past the axis end
    expect(h._cons).toEqual([]);
    expect(h.warnings).toEqual([t("sketch.constraint.coincidentMiss")]);
    expect(h.pending).toEqual({ x: 30, y: 14 });
  });

  it("refuses a point on its OWN curve, and says why", () => {
    const line = run(pointAndLine(), v(0, 0), v(12, 0)); // l1's own start, then l1
    expect(line._cons).toEqual([]);
    expect(line.warnings).toEqual([t("sketch.constraint.pointOnOwnCurve")]);
    const rect = run([{ type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 }], v(-20, -10), v(0, 10));
    expect(rect._cons, "a corner on its own rectangle's top folds it flat").toEqual([]);
    expect(rect.warnings).toEqual([t("sketch.constraint.pointOnOwnCurve")]);
    const circle = run([{ type: "circle", id: "K", x: 0, y: 0, radius: 10 }], v(0, 0), v(10, 0));
    expect(circle._cons, "a centre on its own rim collapses it").toEqual([]);
  });

  it("two curves that are not two lines: says one has to be a point", () => {
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "K1", x: 0, y: 0, radius: 10 },
      { type: "circle", id: "K2", x: 40, y: 0, radius: 5 },
    ];
    const h = run(ents, v(10, 0), v(45, 0));
    expect(h._cons).toEqual([]);
    expect(h.warnings).toEqual([t("sketch.constraint.pointOnNeedsPoint")]);
  });

  it("two line BODIES still mean Collinear, and a polygon's side is a line body", () => {
    expect(run(pointAndLine().concat([{ type: "line", id: "l2", x1: 0, y1: 5, x2: 20, y2: 9 }]), v(12, 0), v(10, 7))._cons)
      .toEqual([{ type: "collinear", l1: "l1", l2: "l2" }]);
    const ents: ResolvedEntity[] = [
      { type: "polygon", id: "H", x: 0, y: 0, radius: 10, sides: 6, angle: 0 },
      { type: "line", id: "l1", x1: 30, y1: 0, x2: 50, y2: 0 },
    ];
    const h = run(ents, v(7.5, 4.33), v(40, 0));
    expect(h._cons).toEqual([{ type: "collinear", l1: "H~0", l2: "l1" }]);
  });

  it("the ORIGIN is a point it can put on a curve, and its axes are curves to put a point on", () => {
    const ents = (): ResolvedEntity[] => [
      ...originGeometry(),
      { type: "line", id: "l1", x1: 5, y1: 10, x2: 25, y2: 10 },
      { type: "point", id: "P", x: 30, y: 7 },
    ];
    expect(run(ents(), v(0, 0), v(15, 10))._cons, "origin, then a line")
      .toEqual([{ type: "pointOn", e: ORIGIN_ID, p: 0, curve: "l1" }]);
    expect(run(ents(), v(15, 10), v(0, 0))._cons, "a line, then the origin")
      .toEqual([{ type: "pointOn", e: ORIGIN_ID, p: 0, curve: "l1" }]);
    expect(run(ents(), v(30, 7), v(60, 0))._cons, "a point, then the X axis")
      .toEqual([{ type: "pointOn", e: "P", p: 0, curve: ORIGIN_X_ID }]);
    expect(run(ents(), v(0, -40), v(30, 7))._cons, "the Y axis, then a point")
      .toEqual([{ type: "pointOn", e: "P", p: 0, curve: ORIGIN_Y_ID }]);
  });
});

// TA 38391076's own document: e1 stacked on e0, sharing e0's top-left corner,
// with e1's whole bottom edge along e0's top edge. The shared corner is ONE
// point to the solver, and the shared stretch of edge is under the cursor
// twice, so which shape's name a click took came down to a float's last digit
// or list order, and most picks were refused as "belongs to the curve you
// picked". The first stand-in for this case floated e1 clear of e0, which
// never touched it.
describe("Coincident on two shapes that share a corner and an edge (TA 38391076's document)", () => {
  const doc = (): ResolvedEntity[] => [
    { type: "rectangle", id: "e0", x: -2.5416998975938228, y: -1.487824330298821, width: 62.860577955125294, height: 52.19783692131706 },
    { type: "rectangle", id: "e1", x: -7.625099692781474, y: 35.33582784459706, width: 52.69377836474999, height: 21.449467428474694 },
  ];
  const TOP = 24.61109413035971; // e0's top edge, and e1's bottom edge
  const SHARED = v(-33.97198887515647, TOP); // e0's corner 3 and e1's corner 0
  const E0_TR = v(28.888589079968824, TOP); // e0's corner 2, past e1's end
  const E0_BOTTOM = -27.586742790957352;
  const run = (...clicks: THREE.Vector2[]) => {
    const h = new MockHost();
    h._ents = doc();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    for (const c of clicks) ct.click(c);
    return { h, ct };
  };
  // where the click lands on the shared corner: these take e0's name or
  // e1's, by float noise alone (the reviewer's drive saw both)
  const nudges = [v(0, 0), v(-0.3, 0), v(0.3, -0.3), v(0.3, 0.3)];

  it("the shared corner, then e0's top edge past e1: e1's corner goes on it, whichever name the click took", () => {
    for (const d of nudges) {
      const { h } = run(SHARED.clone().add(d), v(25, TOP));
      expect(h._cons, `nudged ${d.x},${d.y}`).toEqual([{ type: "pointOn", e: "e1", p: 0, curve: "e0~2" }]);
      expect(h.warnings).toEqual([]);
      expect(h.moves).toEqual(["e1"]);
    }
  });

  it("and in the other order: e0's top edge, then the shared corner", () => {
    for (const d of nudges) {
      expect(run(v(25, TOP), SHARED.clone().add(d)).h._cons, `nudged ${d.x},${d.y}`)
        .toEqual([{ type: "pointOn", e: "e1", p: 0, curve: "e0~2" }]);
    }
  });

  it("e0's top-right corner onto e1's bottom edge, which lies along e0's own top edge, in either order", () => {
    // every click on that stretch is nearest e0's top edge too (a tie the lower
    // index wins), which is e0's own: it used to be refused, every time
    for (const clicks of [[E0_TR, v(0, TOP)], [v(0, TOP), E0_TR]]) {
      const { h } = run(...clicks);
      expect(h._cons).toEqual([{ type: "pointOn", e: "e0", p: 2, curve: "e1~0" }]);
      expect(h.warnings).toEqual([]);
    }
  });

  it("while e0's corner is held, the hover over the shared stretch lights e1's edge, the one the click takes", () => {
    const { ct } = run(E0_TR);
    expect(ct.hoverCurve(v(0, TOP))?.id).toBe("e1~0");
  });

  it("the shared corner onto e0's BOTTOM edge would fold e0 flat: refused, whichever name the click took", () => {
    for (const d of nudges) {
      const { h } = run(SHARED.clone().add(d), v(0, E0_BOTTOM));
      expect(h._cons, `nudged ${d.x},${d.y}`).toEqual([]);
      expect(h.warnings).toEqual([t("sketch.constraint.pointOnOwnCurve")]);
    }
  });
});

describe("Coincident and points that only SIT together", () => {
  const run = (ents: ResolvedEntity[], ...clicks: THREE.Vector2[]) => {
    const h = new MockHost();
    h._ents = ents;
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    for (const c of clicks) ct.click(c);
    return h;
  };

  it("a line's end on a circle's centre goes on that circle, though the click took the centre's name", () => {
    // A centre keeps its own solver point, so the line's end is a different
    // point that happens to sit there. The circle comes last in the list, so a
    // tie on the shared spot names its centre, which on its own rim is refused.
    const ents: ResolvedEntity[] = [
      { type: "line", id: "L", x1: 0, y1: 0, x2: 20, y2: 5 },
      { type: "circle", id: "K", x: 0, y: 0, radius: 10 },
    ];
    expect(run(ents, v(0, 0), v(-10, 0))._cons).toEqual([{ type: "pointOn", e: "L", p: 0, curve: "K" }]);
    expect(run(ents, v(-10, 0), v(0, 0))._cons).toEqual([{ type: "pointOn", e: "L", p: 0, curve: "K" }]);
  });
});

describe("Coincident and a polygon's CORNER", () => {
  // hexagon about (0,0), r 10, first vertex at angle 0: vertex 1 at (5, 8.66)
  const hex = (): ResolvedEntity[] => [
    { type: "polygon", id: "H", x: 0, y: 0, radius: 10, sides: 6, angle: 0 },
    { type: "line", id: "l", x1: 20, y1: 12, x2: 30, y2: 12 },
  ];
  const CORNER = v(5, 10 * Math.sin(Math.PI / 3));
  const run = (...clicks: THREE.Vector2[]) => {
    const h = new MockHost();
    h._ents = hex();
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    for (const c of clicks) ct.click(c);
    return { h, ct };
  };

  it("is a POINT now, in either order: the corner itself, not the nearest side", () => {
    // it used to be refused ("a corner is not a point yet"), and before that
    // taken as the nearest side, landing the line's end 3 mm off the corner
    expect(run(CORNER, v(20, 12)).h._cons).toEqual([{ type: "coincident", e1: "H", p1: 1, e2: "l", p2: 0 }]);
    const back = run(v(20, 12), CORNER).h;
    expect(back._cons).toEqual([{ type: "coincident", e1: "l", p1: 0, e2: "H", p2: 1 }]);
    expect(back.warnings).toEqual([]);
  });

  it("and so is its centre, and a corner of it goes on a line", () => {
    const { h } = run(v(0, 0), v(25, 12));
    expect(h._cons).toEqual([{ type: "pointOn", e: "H", p: -1, curve: "l" }]);
    expect(run(CORNER, v(25, 12)).h._cons).toEqual([{ type: "pointOn", e: "H", p: 1, curve: "l" }]);
  });
});
