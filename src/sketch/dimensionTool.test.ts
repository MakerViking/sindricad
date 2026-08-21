import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  PARALLEL_EPS,
  clampPlace,
  isDimError,
  isRoundTarget,
  pickDimTarget,
  rebindTarget,
  resolveDim,
  targetIdentity,
  targetKey,
  type DimError,
  type DimPlan,
  type DimTarget,
} from "./dimensionTool";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

// --- fixtures ---------------------------------------------------------------
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });
const circle = (id: string, x: number, y: number, radius: number): ResolvedEntity =>
  ({ type: "circle", id, x, y, radius });
const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity =>
  ({ type: "rectangle", id, x, y, width, height });
/** semicircle of radius 5 centred at the origin */
const arc = (id: string): ResolvedEntity =>
  ({ type: "arc", id, x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 });
const projLine = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "projected", id, source: { kind: "silhouette", body: "b" }, curve: { kind: "line", x1, y1, x2, y2 } });
const projCircle = (id: string, x: number, y: number, r: number): ResolvedEntity =>
  ({ type: "projected", id, source: { kind: "silhouette", body: "b" }, curve: { kind: "circle", x, y, r } });

/** a line of `len` through `at`, rotated `deg` from +X */
const atAngle = (id: string, deg: number, y = 0, len = 10): ResolvedEntity => {
  const r = (deg * Math.PI) / 180;
  return line(id, 0, y, Math.cos(r) * len, y + Math.sin(r) * len);
};

const T = {
  entity: (e: ResolvedEntity): DimTarget => ({ kind: "entity", e }),
  point: (e: ResolvedEntity, p: number, x: number, y: number): DimTarget => ({ kind: "point", e, p, pos: v(x, y) }),
  edge: (e: ResolvedEntity, k: number, ax: number, ay: number, bx: number, by: number): DimTarget =>
    ({ kind: "edge", e, k, a: v(ax, ay), b: v(bx, by) }),
};

const plan = (r: ReturnType<typeof resolveDim>): DimPlan => {
  if (isDimError(r)) throw new Error(`expected a plan, got error "${r.error}"`);
  return r;
};
const err = (r: ReturnType<typeof resolveDim>): DimError => {
  if (!isDimError(r)) throw new Error(`expected an error, got a ${r.kind} plan`);
  return r;
};
const made = (r: ReturnType<typeof resolveDim>, value = 42): SketchConstraint => plan(r).make(value);

// --- pickDimTarget -----------------------------------------------------------

describe("pickDimTarget", () => {
  const TOL = 1;

  it("returns null when nothing is near the cursor", () => {
    expect(pickDimTarget([circle("c", 0, 0, 5)], v(100, 100), TOL)).toBeNull();
  });

  it("picks a reference point when the cursor is on one", () => {
    const l = line("l", 0, 0, 10, 0);
    const t = pickDimTarget([l], v(10.2, 0), TOL);
    expect(t?.kind).toBe("point");
    expect(t && t.kind === "point" && t.p).toBe(1);
  });

  it("picks the whole entity for a rim click on a circle", () => {
    const c = circle("c", 0, 0, 5);
    const t = pickDimTarget([c], v(5.1, 0), TOL);
    expect(t?.kind).toBe("entity");
    expect(t?.e.id).toBe("c");
  });

  it("resolves the SMALL circle when it sits inside a big one (no containment fallback)", () => {
    const big = circle("big", 0, 0, 50);
    const small = circle("small", 10, 0, 2);
    const t = pickDimTarget([big, small], v(12.1, 0), TOL); // on the small rim, deep inside the big one
    expect(t?.kind).toBe("entity");
    expect(t?.e.id).toBe("small");
  });

  it("clicking clear of every rim inside a big circle picks nothing (not the big circle's centre)", () => {
    const big = circle("big", 0, 0, 50);
    expect(pickDimTarget([big], v(20, 20), TOL)).toBeNull();
  });

  it("rim beats centre on a circle small enough for both to be in tolerance", () => {
    const tiny = circle("tiny", 0, 0, 0.5);
    const t = pickDimTarget([tiny], v(0.5, 0), 1); // within tol of the centre AND the rim
    expect(t?.kind).toBe("entity"); // → keeps its diameter dim reachable
  });

  it("refines a rectangle body hit to its nearest edge", () => {
    const r = rect("r", 0, 0, 20, 10); // corners: (-10,-5) (10,-5) (10,5) (-10,5)
    const bottom = pickDimTarget([r], v(0, -5.2), TOL);
    expect(bottom?.kind).toBe("edge");
    expect(bottom && bottom.kind === "edge" && bottom.k).toBe(0);
    const right = pickDimTarget([r], v(10.2, 0), TOL);
    expect(right && right.kind === "edge" && right.k).toBe(1);
    const top = pickDimTarget([r], v(0, 5.2), TOL);
    expect(top && top.kind === "edge" && top.k).toBe(2);
    const left = pickDimTarget([r], v(-10.2, 0), TOL);
    expect(left && left.kind === "edge" && left.k).toBe(3);
  });

  it("picks a rectangle CORNER as a point, not an edge", () => {
    const r = rect("r", 0, 0, 20, 10);
    const t = pickDimTarget([r], v(-10.1, -5.1), TOL);
    expect(t?.kind).toBe("point");
    expect(t && t.kind === "point" && t.p).toBe(0);
  });
});

describe("targetKey", () => {
  it("distinguishes the three pick kinds and their indices", () => {
    const r = rect("r", 0, 0, 20, 10);
    expect(targetKey(T.entity(r))).toBe("entity:r");
    expect(targetKey(T.edge(r, 2, 0, 0, 1, 0))).toBe("edge:r~2");
    expect(targetKey(T.point(r, 3, 0, 0))).toBe("point:r:3");
    expect(targetKey(T.edge(r, 2, 0, 0, 1, 0))).not.toBe(targetKey(T.edge(r, 3, 0, 0, 1, 0)));
  });
});

// --- single-pick plans -------------------------------------------------------

describe("resolveDim — single pick", () => {
  it("line → a driving length", () => {
    const p = plan(resolveDim([T.entity(line("l", 0, 0, 10, 0))]));
    expect(p.kind).toBe("length");
    expect(p.measure()).toBeCloseTo(10);
    expect(made(resolveDim([T.entity(line("l", 0, 0, 10, 0))]), 25))
      .toEqual({ type: "distance", line: "l", value: 25 });
  });

  it("rectangle edge → the p2p distance between its two corners", () => {
    const r = rect("r", 0, 0, 20, 10);
    const res = resolveDim([T.edge(r, 0, -10, -5, 10, -5)]);
    expect(plan(res).measure()).toBeCloseTo(20);
    expect(made(res, 30)).toEqual({ type: "p2pDistance", e1: "r", p1: 0, e2: "r", p2: 1, value: 30 });
  });

  it("rectangle edge 3 wraps its second corner index back to 0", () => {
    const r = rect("r", 0, 0, 20, 10);
    const c = made(resolveDim([T.edge(r, 3, -10, 5, -10, -5)]), 10);
    expect(c).toEqual({ type: "p2pDistance", e1: "r", p1: 3, e2: "r", p2: 0, value: 10 });
  });

  it("circle → diameter", () => {
    const res = resolveDim([T.entity(circle("c", 0, 0, 5))]);
    expect(plan(res).kind).toBe("diameter");
    expect(plan(res).measure()).toBeCloseTo(10);
    expect(made(res, 12)).toEqual({ type: "diameter", circle: "c", value: 12 });
  });

  it("arc → radius", () => {
    const res = resolveDim([T.entity(arc("a"))]);
    expect(plan(res).kind).toBe("radius");
    expect(plan(res).measure()).toBeCloseTo(5);
    expect(made(res, 7)).toEqual({ type: "radius", e: "a", value: 7 });
  });

  it("a lone reference point arms for a second pick instead of erroring out", () => {
    const e = err(resolveDim([T.point(line("l", 0, 0, 10, 0), 0, 0, 0)]));
    expect(e.error).toBe("need-second");
    expect(e.keepPicks).toBe(true);
    expect(e.message).not.toBe("");
  });

  it("a lone projected entity stays armed as a pair operand and says so", () => {
    const e = err(resolveDim([T.entity(projLine("pl", 0, 0, 10, 0))]));
    expect(e.error).toBe("projected-single");
    expect(e.keepPicks).toBe(true);
    expect(e.message).toMatch(/pick a second entity/i);
  });

  it("no picks at all resolves to a silent 'not finished'", () => {
    const e = err(resolveDim([]));
    expect(e.error).toBe("need-second");
    expect(e.message).toBe("");
  });
});

// --- the pair matrix ---------------------------------------------------------

describe("resolveDim — pair matrix", () => {
  it("point + point → p2pDistance", () => {
    const a = line("a", 0, 0, 10, 0), b = line("b", 0, 8, 10, 8);
    const res = resolveDim([T.point(a, 0, 0, 0), T.point(b, 0, 0, 8)]);
    expect(plan(res).measure()).toBeCloseTo(8);
    expect(made(res, 8)).toEqual({ type: "p2pDistance", e1: "a", p1: 0, e2: "b", p2: 0, value: 8 });
  });

  it("point + line → p2lDistance (perpendicular)", () => {
    const l = line("l", 0, 0, 10, 0);
    const p = line("p", 3, 6, 4, 7);
    const res = resolveDim([T.point(p, 0, 3, 6), T.entity(l)]);
    expect(plan(res).measure()).toBeCloseTo(6);
    expect(made(res, 6)).toEqual({ type: "p2lDistance", e: "p", p: 0, line: "l", value: 6 });
  });

  it("line + point (picked in the other order) → the same p2lDistance", () => {
    const l = line("l", 0, 0, 10, 0);
    const p = line("p", 3, 6, 4, 7);
    expect(made(resolveDim([T.entity(l), T.point(p, 0, 3, 6)]), 6))
      .toEqual({ type: "p2lDistance", e: "p", p: 0, line: "l", value: 6 });
  });

  it("circle rim + circle rim → CENTRE-TO-CENTRE distance", () => {
    const c1 = circle("c1", 0, 0, 5), c2 = circle("c2", 30, 0, 3);
    const res = resolveDim([T.entity(c1), T.entity(c2)]);
    expect(plan(res).measure()).toBeCloseTo(30);
    expect(made(res, 30)).toEqual({ type: "p2pDistance", e1: "c1", p1: 0, e2: "c2", p2: 0, value: 30 });
  });

  it("arc + circle → centre-to-centre, with the arc's centre index 2", () => {
    const c = made(resolveDim([T.entity(arc("a")), T.entity(circle("c", 20, 0, 3))]), 20);
    expect(c).toEqual({ type: "p2pDistance", e1: "a", p1: 2, e2: "c", p2: 0, value: 20 });
  });

  it("circle + line → CENTRE-to-line distance", () => {
    const res = resolveDim([T.entity(circle("c", 0, 7, 5)), T.entity(line("l", 0, 0, 10, 0))]);
    expect(plan(res).measure()).toBeCloseTo(7);
    expect(made(res, 7)).toEqual({ type: "p2lDistance", e: "c", p: 0, line: "l", value: 7 });
  });

  it("two non-parallel lines → angle", () => {
    const res = resolveDim([T.entity(line("a", 0, 0, 10, 0)), T.entity(line("b", 0, 0, 0, 10))]);
    expect(plan(res).kind).toBe("angle");
    expect(plan(res).measure()).toBeCloseTo(90);
    expect(made(res, 90)).toEqual({ type: "angle", l1: "a", l2: "b", value: 90 });
  });

  it("two PARALLEL lines → distance, never a 0° angle", () => {
    const res = resolveDim([T.entity(line("a", 0, 0, 10, 0)), T.entity(line("b", 0, 4, 10, 4))]);
    expect(plan(res).kind).toBe("distance");
    expect(plan(res).measure()).toBeCloseTo(4);
    expect(made(res, 4)).toEqual({ type: "p2lDistance", e: "a", p: 0, line: "b", value: 4 });
  });

  it("a parallel-lines distance also asks for the parallelism it assumes", () => {
    // one p2lDistance pins ONE endpoint's distance: without the parallel the
    // solver satisfies the typed number by rotating the pair
    const res = resolveDim([T.entity(line("a", 0, 0, 10, 0)), T.entity(line("b", 0, 4, 10, 4))]);
    expect(plan(res).parallelPair).toEqual({ l1: "a", l2: "b" });
  });

  it("the parallel-lines distance is the SAME constraint in either pick order", () => {
    // setDrivingDimension dedups p2lDistance on (e, p, line) — an order-dependent
    // operand would create a second dim for one visible gap instead of replacing
    const a = line("a", 0, 0, 10, 0), b = line("b", 0, 4, 10, 4);
    const fwd = made(resolveDim([T.entity(a), T.entity(b)]), 4);
    const rev = made(resolveDim([T.entity(b), T.entity(a)]), 4);
    expect(rev).toEqual(fwd);
    expect(plan(resolveDim([T.entity(b), T.entity(a)])).parallelPair).toEqual({ l1: "a", l2: "b" });
  });

  it("two edges of ONE rectangle need no parallel — the rectangle holds them", () => {
    const r = rect("r", 0, 0, 20, 10);
    const res = resolveDim([T.edge(r, 0, -10, -5, 10, -5), T.edge(r, 2, 10, 5, -10, 5)]);
    expect(plan(res).parallelPair).toBeUndefined();
  });

  it("no parallelPair on the dims that don't imply one", () => {
    expect(plan(resolveDim([T.entity(line("a", 0, 0, 10, 0)), T.entity(line("b", 0, 0, 0, 10))])).parallelPair)
      .toBeUndefined();
    expect(plan(resolveDim([T.entity(circle("c", 0, 9, 2)), T.entity(line("l", 0, 0, 10, 0))])).parallelPair)
      .toBeUndefined();
  });

  it("two ANTI-parallel lines (180° apart) → distance too", () => {
    const res = resolveDim([T.entity(line("a", 0, 0, 10, 0)), T.entity(line("b", 10, 4, 0, 4))]);
    expect(plan(res).kind).toBe("distance");
    expect(plan(res).measure()).toBeCloseTo(4);
  });

  it("rect edge + rect edge (opposite sides of the same rect) → distance", () => {
    const r = rect("r", 0, 0, 20, 10);
    const res = resolveDim([T.edge(r, 0, -10, -5, 10, -5), T.edge(r, 2, 10, 5, -10, 5)]);
    expect(plan(res).measure()).toBeCloseTo(10);
    expect(made(res, 10)).toEqual({ type: "p2lDistance", e: "r", p: 0, line: "r~2", value: 10 });
  });

  it("rect edge + rect edge (adjacent sides) → angle", () => {
    const r = rect("r", 0, 0, 20, 10);
    const res = resolveDim([T.edge(r, 0, -10, -5, 10, -5), T.edge(r, 1, 10, -5, 10, 5)]);
    expect(plan(res).kind).toBe("angle");
    expect(made(res, 90)).toEqual({ type: "angle", l1: "r~0", l2: "r~1", value: 90 });
  });

  it("rect edge + circle → centre-to-edge distance", () => {
    const r = rect("r", 0, 0, 20, 10);
    const res = resolveDim([T.edge(r, 0, -10, -5, 10, -5), T.entity(circle("c", 0, 15, 2))]);
    expect(plan(res).measure()).toBeCloseTo(20);
    expect(made(res, 20)).toEqual({ type: "p2lDistance", e: "c", p: 0, line: "r~0", value: 20 });
  });

  it("rect edge + a free point → point-to-edge distance", () => {
    const r = rect("r", 0, 0, 20, 10);
    const pt: ResolvedEntity = { type: "point", id: "pt", x: 0, y: 20 };
    const res = resolveDim([T.edge(r, 0, -10, -5, 10, -5), T.point(pt, 0, 0, 20)]);
    expect(plan(res).measure()).toBeCloseTo(25);
    expect(made(res, 25)).toEqual({ type: "p2lDistance", e: "pt", p: 0, line: "r~0", value: 25 });
  });

  it("rect edge + a line at an angle → angle, with the edge as l1", () => {
    const r = rect("r", 0, 0, 20, 10);
    const res = resolveDim([T.edge(r, 3, -10, 5, -10, -5), T.entity(line("l", 0, 0, 10, 0))]);
    expect(plan(res).kind).toBe("angle");
    expect(made(res, 90).type).toBe("angle");
    expect((made(res, 90) as { l1: string }).l1).toBe("r~3");
  });

  it("a projected line is a valid operand and keeps the dim driving when the other end moves", () => {
    const res = resolveDim([T.entity(projLine("pl", 0, 0, 10, 0)), T.entity(circle("c", 0, 9, 2))]);
    expect(plan(res).forceDriven).toBeUndefined();
    expect(made(res, 9)).toEqual({ type: "p2lDistance", e: "c", p: 0, line: "pl", value: 9 });
  });

  it("two FIXED operands force a driven (reference) dimension", () => {
    const res = resolveDim([T.entity(projCircle("pc", 0, 0, 5)), T.entity(projLine("pl", 0, 9, 10, 9))]);
    expect(plan(res).forceDriven).toBe(true);
    expect(plan(res).hint).toMatch(/driven/i);
  });
});

// The field-reported bug itself: "6 mm from this circle to that rectangle's
// edge" resized the RECTANGLE. Which of the two moves is a policy, the policy is
// "the one you picked first", and `plan.moves` is where this layer says so — it
// is not carried by the constraint the plan makes, so nothing else can observe
// it. Nothing did: inverting the stamp to `t2.e.id` (the second pick moves and
// the thing you measured FROM gets resized — exactly the reported bug) left the
// whole sketch suite green.
//
// Every case is asserted in BOTH orders. One order alone is not a test of pick
// order at all: `moves = whichever operand is the circle` would pass it.
describe("resolveDim — which operand the pick order nominates as the mover (bug #86)", () => {
  const moverOf = (a: DimTarget, b: DimTarget) => plan(resolveDim([a, b])).moves;

  it("circle + rectangle edge — the reported gesture, both ways round", () => {
    const c = circle("c", -13.8194, 12.8, 2.4);
    const r = rect("r", 0, 0, 40, 40);
    const edge = T.edge(r, 3, -20, 20, -20, -20); // the LEFT edge
    expect(moverOf(T.entity(c), edge)).toBe("c"); // circle picked first: it moves
    expect(moverOf(edge, T.entity(c))).toBe("r"); // edge first: the RECTANGLE moves
  });

  it("a rect edge nominates the RECTANGLE, never the `r~k` operand", () => {
    // `moves` is matched against ENTITY ids in sketchSolve; `r~3` matches
    // nothing there and silently degrades to "moves nothing", which is the
    // reported symptom again with no signal.
    const r = rect("r", 0, 0, 40, 40);
    expect(moverOf(T.edge(r, 3, -20, 20, -20, -20), T.entity(line("l", 0, 0, 10, 0)))).toBe("r");
  });

  it("point + line, and the same pair the other way round", () => {
    const l = line("l", 0, 0, 10, 0);
    const p = line("p", 3, 6, 4, 7);
    // the CONSTRAINT is identical in both orders (it dedups on the operands) —
    // only `moves` records which one the user asked to move
    expect(made(resolveDim([T.point(p, 0, 3, 6), T.entity(l)]), 6))
      .toEqual(made(resolveDim([T.entity(l), T.point(p, 0, 3, 6)]), 6));
    expect(moverOf(T.point(p, 0, 3, 6), T.entity(l))).toBe("p");
    expect(moverOf(T.entity(l), T.point(p, 0, 3, 6))).toBe("l");
  });

  it("two lines (angle), two circles (centre distance), circle + line", () => {
    const a = line("a", 0, 0, 10, 0), b = line("b", 0, 0, 0, 10);
    expect(moverOf(T.entity(a), T.entity(b))).toBe("a");
    expect(moverOf(T.entity(b), T.entity(a))).toBe("b");
    const c1 = circle("c1", 0, 0, 5), c2 = circle("c2", 30, 0, 3);
    expect(moverOf(T.entity(c1), T.entity(c2))).toBe("c1");
    expect(moverOf(T.entity(c2), T.entity(c1))).toBe("c2");
    const l = line("l", 0, 0, 10, 0), c = circle("c", 0, 7, 5);
    expect(moverOf(T.entity(c), T.entity(l))).toBe("c");
    expect(moverOf(T.entity(l), T.entity(c))).toBe("l");
  });

  it("`lineLine` swaps its own operands and STILL reports the first pick", () => {
    // The one branch that reorders what it was handed: the plan's l1/l2 come out
    // in a normalised order, so reading the mover back off the constraint would
    // give the wrong entity. It is stamped from the TARGETS, above that swap.
    const steep = atAngle("steep", 80), flat = atAngle("flat", 10);
    const p = plan(resolveDim([T.entity(flat), T.entity(steep)]));
    expect(p.moves).toBe("flat");
    expect(plan(resolveDim([T.entity(steep), T.entity(flat)])).moves).toBe("steep");
  });

  it("a SINGLE-pick dim nominates nobody", () => {
    // A lone circle's diameter has no second operand to hold still, so there is
    // nothing to express — and a `moves` naming the sole operand would anchor
    // the rest of the sketch against it for no reason.
    expect(plan(resolveDim([T.entity(circle("c", 0, 0, 5))])).moves).toBeUndefined();
    expect(plan(resolveDim([T.entity(line("l", 0, 0, 10, 0))])).moves).toBeUndefined();
    const r = rect("r", 0, 0, 20, 10);
    expect(plan(resolveDim([T.edge(r, 0, -10, -5, 10, -5)])).moves).toBeUndefined();
  });
});

// --- errors: nothing is ever a silent dead end -------------------------------

describe("resolveDim — error cases", () => {
  it("same-entity: an entity pick and its own centre point are one operand (silent)", () => {
    const c = circle("c", 0, 0, 5);
    const e = err(resolveDim([T.entity(c), T.point(c, 0, 0, 0)]));
    expect(e.error).toBe("same-entity");
    expect(e.message).toBe(""); // deliberately silent — a re-click keeps the diameter dim
  });

  it("same-entity: the same line picked twice (silent)", () => {
    const l = line("l", 0, 0, 10, 0);
    expect(err(resolveDim([T.entity(l), T.entity(l)])).error).toBe("same-entity");
  });

  it("concentric circles resolve straight to the radial gap, no tangent mode needed", () => {
    // their centre distance is 0 and always will be, so there is nothing to
    // disambiguate — the wall thickness is the only meaningful dimension
    const p = plan(resolveDim([T.entity(circle("in", 0, 0, 2)), T.entity(circle("out", 0, 0, 9))]));
    expect(p.measure()).toBeCloseTo(7);
    expect(p.make(7, undefined)).toMatchObject({ type: "radialGap", inner: "in", outer: "out", value: 7 });
  });

  it("a concentric pair resolves the same however each circle was picked", () => {
    // a centre pick arrives as kind:"point" and an entity pick as kind:"entity";
    // both are round operands and must reach the same radial-gap plan
    const inner = circle("in", 0, 0, 2), outer = circle("out", 0, 0, 9);
    for (const picks of [
      [T.point(inner, 0, 0, 0), T.entity(outer)],
      [T.point(inner, 0, 0, 0), T.point(outer, 0, 0, 0)],
      [T.entity(outer), T.point(inner, 0, 0, 0)],
    ]) {
      const p = plan(resolveDim(picks));
      expect(p.measure()).toBeCloseTo(7);
      expect(p.make(7, undefined)).toMatchObject({ type: "radialGap", inner: "in", outer: "out" });
    }
  });

  it("coincident points measure 0 and are refused with a message", () => {
    const a = line("a", 0, 0, 10, 0), b = line("b", 0, 0, 0, 10);
    const e = err(resolveDim([T.point(a, 0, 0, 0), T.point(b, 0, 0, 0)]));
    expect(e.error).toBe("coincident-points");
    expect(e.message).toMatch(/0/);
  });

  it("a point that lies on the picked line is refused", () => {
    const l = line("l", 0, 0, 10, 0);
    const e = err(resolveDim([T.point(l, 0, 0, 0), T.entity(l)]));
    expect(e.error).toBe("point-on-line");
  });

  it("collinear lines are refused (their distance is 0)", () => {
    const e = err(resolveDim([T.entity(line("a", 0, 0, 10, 0)), T.entity(line("b", 20, 0, 30, 0))]));
    expect(e.error).toBe("point-on-line");
    expect(e.message).toMatch(/collinear/i);
  });

  it("a zero-length line is degenerate", () => {
    expect(err(resolveDim([T.entity(line("l", 4, 4, 4, 4))])).error).toBe("degenerate");
  });

  it("a zero-radius circle is degenerate", () => {
    expect(err(resolveDim([T.entity(circle("c", 0, 0, 0))])).error).toBe("degenerate");
  });

  it("a zero-length rectangle edge is degenerate", () => {
    const r = rect("r", 0, 0, 0, 10);
    expect(err(resolveDim([T.edge(r, 0, 0, -5, 0, -5)])).error).toBe("degenerate");
  });

  it("splines / text / polygons are unsupported, and the message names the kind", () => {
    const sp: ResolvedEntity = { type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] };
    const poly: ResolvedEntity = { type: "polygon", id: "g", x: 0, y: 0, radius: 5, sides: 6, angle: 0 };
    const slot: ResolvedEntity = { type: "slot", id: "sl", x1: 0, y1: 0, x2: 10, y2: 0, width: 4 };
    for (const [e, kind] of [[sp, "spline"], [poly, "polygon"], [slot, "slot"]] as const) {
      const d = err(resolveDim([T.entity(e)]));
      expect(d.error).toBe("unsupported");
      expect(d.message).toContain(kind);
    }
  });

  it("an unsupported entity in a PAIR is reported too, not silently ignored", () => {
    const sp: ResolvedEntity = { type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] };
    expect(err(resolveDim([T.entity(line("l", 0, 0, 10, 0)), T.entity(sp)])).error).toBe("unsupported");
  });

  it("every error carries either a message or a deliberate silence, never undefined", () => {
    const cases: DimTarget[][] = [
      // two coincident endpoints on different lines: still a genuine refusal
      // (a concentric circle PAIR is no longer one — it resolves to the gap)
      [T.point(line("ca", 0, 0, 10, 0), 0, 0, 0), T.point(line("cb", 0, 0, 0, 10), 0, 0, 0)],
      [T.entity(line("l", 4, 4, 4, 4))],
      [T.entity({ type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })],
      [T.point(line("l", 0, 0, 10, 0), 0, 0, 0)],
    ];
    for (const picks of cases) expect(typeof err(resolveDim(picks)).message).toBe("string");
  });
});

// --- the parallel/angle threshold -------------------------------------------

describe("parallel-vs-angle sweep", () => {
  const sweep = (deg: number) =>
    plan(resolveDim([T.entity(line("a", 0, 4, 10, 4)), T.entity(atAngle("b", deg))])).kind;

  it("treats near-parallel as a distance and anything past the epsilon as an angle", () => {
    expect(sweep(0)).toBe("distance");
    expect(sweep(0.05)).toBe("distance");
    expect(sweep(0.09)).toBe("distance");
    expect(sweep(0.11)).toBe("angle");
    expect(sweep(0.2)).toBe("angle");
    expect(sweep(1)).toBe("angle");
    expect(sweep(45)).toBe("angle");
    expect(sweep(90)).toBe("angle");
  });

  it("does NOT regress a deliberate shallow-angle dim", () => {
    const p = plan(resolveDim([T.entity(line("a", 0, 4, 10, 4)), T.entity(atAngle("b", 0.5))]));
    expect(p.kind).toBe("angle");
    expect(p.measure()).toBeCloseTo(0.5, 3);
  });

  it("the epsilon is sin(0.1°)", () => {
    expect(PARALLEL_EPS).toBeCloseTo(Math.sin((0.1 * Math.PI) / 180), 12);
  });
});

// --- placement ---------------------------------------------------------------

describe("label placement", () => {
  const place = { ox: 3, oy: -4 };

  it("threads `place` onto the four constraint-rendered dims", () => {
    const c1 = circle("c1", 0, 0, 5), c2 = circle("c2", 30, 0, 3);
    expect(plan(resolveDim([T.entity(c1), T.entity(c2)])).make(30, place))
      .toMatchObject({ type: "p2pDistance", place });
    expect(plan(resolveDim([T.entity(c1), T.entity(line("l", 0, 20, 10, 20))])).make(20, place))
      .toMatchObject({ type: "p2lDistance", place });
    expect(plan(resolveDim([T.entity(arc("a"))])).make(5, place))
      .toMatchObject({ type: "radius", place });
    expect(plan(resolveDim([T.entity(line("a", 0, 0, 10, 0)), T.entity(line("b", 0, 0, 0, 10))])).make(90, place))
      .toMatchObject({ type: "angle", place });
  });

  it("omits `place` entirely when none was frozen (byte stability)", () => {
    const c = made(resolveDim([T.entity(circle("c1", 0, 0, 5)), T.entity(circle("c2", 30, 0, 3))]));
    expect("place" in c).toBe(false);
  });

  it("distance / diameter have no place slot (they render through entityDims)", () => {
    const lengthPlan = plan(resolveDim([T.entity(line("l", 0, 0, 10, 0))]));
    const diaPlan = plan(resolveDim([T.entity(circle("c", 0, 0, 5))]));
    expect(lengthPlan.labelAnchor()).toBeNull();
    expect(diaPlan.labelAnchor()).toBeNull();
    expect(lengthPlan.make(10, place)).toEqual({ type: "distance", line: "l", value: 10 });
    expect(diaPlan.make(10, place)).toEqual({ type: "diameter", circle: "c", value: 10 });
  });

  it("clampPlace caps a far placement and passes an in-band one through", () => {
    const mmPerPx = 0.5;
    const huge = clampPlace(100000, 0, mmPerPx);
    expect(Math.hypot(huge?.ox ?? 0, huge?.oy ?? 0)).toBeCloseTo(600 * mmPerPx, 3);
    const ok = clampPlace(0, -20, mmPerPx);
    expect(ok).toEqual({ ox: 0, oy: -20 }); // in band: passed through, sign kept
  });

  it("clampPlace refuses a sub-floor placement rather than inflating it", () => {
    // the floor is a SCREEN distance but `place` is stored in sketch mm: pushing
    // a 1 px click up to 18 px at a zoomed-OUT mm/px would bake a huge mm offset
    // into the document and throw the label off-screen at every other zoom
    expect(clampPlace(0.001, 0, 0.5)).toBeNull();
    expect(clampPlace(0, 0, 0.5)).toBeNull();
    expect(clampPlace(1, 0, 19.13)).toBeNull(); // the zoomed-out repro
  });

  it("clampPlace with no zoom context passes the offset through", () => {
    expect(clampPlace(1.23456789, -2, 0)).toEqual({ ox: 1.2346, oy: -2 });
  });
});

// --- rebinding after a solve -------------------------------------------------

describe("rebindTarget", () => {
  it("re-reads a point pick from the fresh (solved) entity list", () => {
    const before = line("l", 0, 0, 10, 0);
    const after = line("l", 0, 0, 14, 0); // the solver moved the endpoint
    const t = rebindTarget(T.point(before, 1, 10, 0), [after]);
    expect(t && t.kind === "point" && t.pos.x).toBeCloseTo(14);
    expect(t?.e).toBe(after);
  });

  it("re-reads a rectangle edge pick", () => {
    const after = rect("r", 0, 0, 40, 10);
    const t = rebindTarget(T.edge(rect("r", 0, 0, 20, 10), 0, -10, -5, 10, -5), [after]);
    expect(t && t.kind === "edge" && t.a.x).toBeCloseTo(-20);
    expect(t && t.kind === "edge" && t.b.x).toBeCloseTo(20);
  });

  it("drops a pick whose entity is gone", () => {
    expect(rebindTarget(T.entity(line("l", 0, 0, 1, 0)), [])).toBeNull();
  });

  it("drops an edge pick whose rectangle became something else", () => {
    expect(rebindTarget(T.edge(rect("r", 0, 0, 20, 10), 0, -10, -5, 10, -5), [line("r", 0, 0, 1, 0)])).toBeNull();
  });

  it("a rebound pick re-resolves to the same plan shape with the new measurement", () => {
    const before = rect("r", 0, 0, 20, 10);
    const t = rebindTarget(T.edge(before, 0, -10, -5, 10, -5), [rect("r", 0, 0, 40, 10)]);
    expect(plan(resolveDim([t!])).measure()).toBeCloseTo(40);
  });
});

// --- EDGE-TO-EDGE (rim / tangent) rows ---------------------------------------

/** the same pick, armed with Fusion's "Pick Circle/Arc Tangent" */
const rim = (t: DimTarget): DimTarget => {
  if (t.kind === "edge") throw new Error("a rectangle edge can't carry rim mode");
  return { ...t, rim: true };
};

describe("resolveDim — rim (edge-to-edge) distances", () => {
  it("marks circles and arcs as rim-capable and everything else not", () => {
    expect(isRoundTarget(T.entity(circle("c", 0, 0, 5)))).toBe(true);
    expect(isRoundTarget(T.entity(arc("a")))).toBe(true);
    expect(isRoundTarget(T.entity(projCircle("pc", 0, 0, 5)))).toBe(true);
    expect(isRoundTarget(T.entity(line("l", 0, 0, 10, 0)))).toBe(false);
    expect(isRoundTarget(T.edge(rect("r", 0, 0, 20, 10), 0, -10, -5, 10, -5))).toBe(false);
  });

  it("keeps the rim MODE out of targetKey but inside targetIdentity", () => {
    const t = T.entity(circle("c", 0, 0, 5));
    expect(targetKey(rim(t))).toBe(targetKey(t)); // same geometry ⇒ same operand
    expect(targetIdentity(rim(t))).not.toBe(targetIdentity(t)); // different dimension
  });

  it("preserves rim mode through rebindTarget", () => {
    const after = circle("c", 0, 0, 8);
    const t = rebindTarget(rim(T.entity(circle("c", 0, 0, 5))), [after]);
    expect(t && t.kind === "entity" && t.rim).toBe(true);
  });

  it("ignores rim mode on a lone pick (a circle is still a diameter)", () => {
    const p = plan(resolveDim([rim(T.entity(circle("c", 0, 0, 5)))]));
    expect(p.kind).toBe("diameter");
    expect(p.make(20)).toEqual({ type: "diameter", circle: "c", value: 20 });
  });

  it("ignores rim mode on a non-round pick (line + line is still an angle)", () => {
    const l1 = line("a", 0, 0, 10, 0);
    const l2 = atAngle("b", 30, 5);
    expect(plan(resolveDim([rim(T.entity(l1)), rim(T.entity(l2))])).kind).toBe("angle");
  });

  // --- concentric ⇒ radial gap (wall thickness) ------------------------------

  it("concentric rims give a SIGNED radial gap, outer minus inner", () => {
    const inner = circle("i", 0, 0, 5);
    const outer = circle("o", 0, 0, 12);
    const p = plan(resolveDim([rim(T.entity(outer)), rim(T.entity(inner))])); // outer picked FIRST
    expect(p.measure()).toBeCloseTo(7);
    expect(p.field).toBe("gap");
    // inner/outer roles come from the radii, never from pick order — that is
    // what stops the annulus solving inside-out
    expect(p.make(3)).toEqual({ type: "radialGap", inner: "i", outer: "o", value: 3 });
    expect(p.implyConcentric).toEqual({ c1: "i", c2: "o" });
  });

  it("a concentric radial gap carries its label placement", () => {
    const p = plan(resolveDim([rim(T.entity(circle("i", 0, 0, 5))), rim(T.entity(circle("o", 0, 0, 12)))]));
    expect(p.make(3, { ox: 1, oy: 2 })).toEqual({ type: "radialGap", inner: "i", outer: "o", value: 3, place: { ox: 1, oy: 2 } });
    expect(p.labelAnchor()).not.toBeNull();
  });

  it("concentric rims of EQUAL radius have no gap to drive", () => {
    const e = err(resolveDim([rim(T.entity(circle("i", 0, 0, 5))), rim(T.entity(circle("o", 0, 0, 5)))]));
    expect(e.error).toBe("degenerate");
    expect(e.message).toMatch(/measures 0/);
  });

  it("a concentric arc + circle pair still resolves to a radial gap", () => {
    // `arc` is radius 5 about the origin
    const p = plan(resolveDim([rim(T.entity(arc("a"))), rim(T.entity(circle("o", 0, 0, 12)))]));
    expect(p.measure()).toBeCloseTo(7);
    expect(p.make(7)).toEqual({ type: "radialGap", inner: "a", outer: "o", value: 7 });
  });

  it("REFUSES one rim pick against a CONCENTRIC circle's centre (that is its radius)", () => {
    // the outer rim armed, the inner picked plainly ⇒ its CENTRE against the
    // outer rim — with the centres coincident that distance IS the outer radius,
    // and there is no direction to draw the annotation along
    const e = err(resolveDim([T.entity(circle("i", 0, 0, 5)), rim(T.entity(circle("o", 0, 0, 12)))]));
    expect(e.error).toBe("coincident-points");
    expect(e.message).toMatch(/radius/);
  });

  it("one rim pick against an OFFSET circle's centre is a point-to-rim dim", () => {
    const p = plan(resolveDim([T.entity(circle("i", 4, 0, 5)), rim(T.entity(circle("o", 0, 0, 12)))]));
    expect(p.measure()).toBeCloseTo(8); // |4 - 12|
    expect(p.make(20)).toEqual({ type: "p2cDistance", e: "i", p: 0, circle: "o", value: 20 });
  });

  // --- non-concentric rim-to-rim --------------------------------------------

  it("separated rims give the minimum edge-to-edge clearance", () => {
    const a = circle("a", 0, 0, 5);
    const b = circle("b", 20, 0, 3);
    const p = plan(resolveDim([rim(T.entity(a)), rim(T.entity(b))]));
    expect(p.measure()).toBeCloseTo(12); // 20 - 5 - 3
    expect(p.make(4)).toEqual({ type: "c2cDistance", c1: "a", c2: "b", value: 4 });
    const an = p.anchors()!;
    expect(an.a.x).toBeCloseTo(5); // the two facing rim points
    expect(an.b.x).toBeCloseTo(17);
  });

  it("normalises the operand order by id, so the same pair replaces rather than duplicates", () => {
    const a = circle("a", 0, 0, 5);
    const b = circle("b", 20, 0, 3);
    const fwd = plan(resolveDim([rim(T.entity(a)), rim(T.entity(b))])).make(4);
    const rev = plan(resolveDim([rim(T.entity(b)), rim(T.entity(a))])).make(4);
    expect(rev).toEqual(fwd);
  });

  it("nested (non-concentric) rims give the minimum radial clearance", () => {
    const big = circle("big", 0, 0, 10);
    const small = circle("small", 2, 0, 3);
    const p = plan(resolveDim([rim(T.entity(big)), rim(T.entity(small))]));
    expect(p.measure()).toBeCloseTo(5); // (10 - 3) - 2
    expect(p.make(1)).toEqual({ type: "c2cDistance", c1: "big", c2: "small", value: 1 });
  });

  it("REFUSES overlapping rims — there is no clearance to drive", () => {
    const e = err(resolveDim([rim(T.entity(circle("a", 0, 0, 5))), rim(T.entity(circle("b", 6, 0, 5)))]));
    expect(e.error).toBe("overlapping");
    expect(e.message).toMatch(/overlap/);
  });

  it("REFUSES externally tangent rims (the clearance measures 0)", () => {
    const e = err(resolveDim([rim(T.entity(circle("a", 0, 0, 5))), rim(T.entity(circle("b", 8, 0, 3)))]));
    expect(e.error).toBe("degenerate");
  });

  it("REFUSES internally tangent rims (the radial clearance measures 0)", () => {
    const e = err(resolveDim([rim(T.entity(circle("a", 0, 0, 10))), rim(T.entity(circle("b", 7, 0, 3)))]));
    expect(e.error).toBe("degenerate");
  });

  // --- rim to line ----------------------------------------------------------

  it("a rim and a line give an edge-to-line distance", () => {
    const c = circle("c", 0, 10, 3);
    const l = line("l", -10, 0, 10, 0);
    const p = plan(resolveDim([rim(T.entity(c)), T.entity(l)]));
    expect(p.measure()).toBeCloseTo(7); // 10 - 3
    expect(p.make(2)).toEqual({ type: "c2lDistance", circle: "c", line: "l", value: 2 });
    const an = p.anchors()!;
    expect(an.a.y).toBeCloseTo(7); // rim point facing the line
    expect(an.b.y).toBeCloseTo(0); // foot of the perpendicular
  });

  it("a rim and a RECTANGLE EDGE give an edge-to-line distance on the `~k` operand", () => {
    const r = rect("r", 0, 0, 40, 10); // bottom edge (k=0) at y = -5
    const c = circle("c", 0, 20, 3);
    const p = plan(resolveDim([rim(T.entity(c)), T.edge(r, 0, -20, -5, 20, -5)]));
    expect(p.measure()).toBeCloseTo(22); // 25 - 3
    expect(p.make(9)).toEqual({ type: "c2lDistance", circle: "c", line: "r~0", value: 9 });
  });

  it("pick order does not matter for a rim + line pair", () => {
    const c = circle("c", 0, 10, 3);
    const l = line("l", -10, 0, 10, 0);
    expect(plan(resolveDim([T.entity(l), rim(T.entity(c))])).make(2))
      .toEqual({ type: "c2lDistance", circle: "c", line: "l", value: 2 });
  });

  it("REFUSES a line that crosses the circle", () => {
    const e = err(resolveDim([rim(T.entity(circle("c", 0, 1, 3))), T.entity(line("l", -10, 0, 10, 0))]));
    expect(e.error).toBe("crossing");
    expect(e.message).toMatch(/crosses/);
  });

  it("REFUSES a line tangent to the circle (measures 0)", () => {
    const e = err(resolveDim([rim(T.entity(circle("c", 0, 3, 3))), T.entity(line("l", -10, 0, 10, 0))]));
    expect(e.error).toBe("degenerate");
  });

  it("REFUSES a line through the circle's centre", () => {
    const e = err(resolveDim([rim(T.entity(circle("c", 0, 0, 3))), T.entity(line("l", -10, 0, 10, 0))]));
    expect(e.error).toBe("point-on-line");
  });

  // --- point to rim ---------------------------------------------------------

  it("a point outside the rim gives a point-to-edge distance", () => {
    const l = line("l", 20, 0, 30, 0);
    const c = circle("c", 0, 0, 5);
    const p = plan(resolveDim([T.point(l, 0, 20, 0), rim(T.entity(c))]));
    expect(p.measure()).toBeCloseTo(15); // 20 - 5
    expect(p.make(6)).toEqual({ type: "p2cDistance", e: "l", p: 0, circle: "c", value: 6 });
    const an = p.anchors()!;
    expect(an.a.x).toBeCloseTo(20);
    expect(an.b.x).toBeCloseTo(5);
  });

  it("a point INSIDE the rim measures to the rim too", () => {
    const l = line("l", 2, 0, 30, 0);
    const p = plan(resolveDim([T.point(l, 0, 2, 0), rim(T.entity(circle("c", 0, 0, 5)))]));
    expect(p.measure()).toBeCloseTo(3); // |2 - 5|
  });

  it("a rectangle CORNER to a rim works (corner index preserved)", () => {
    const r = rect("r", 0, 0, 20, 10);
    const p = plan(resolveDim([T.point(r, 2, 10, 5), rim(T.entity(circle("c", 40, 5, 5)))]));
    expect(p.measure()).toBeCloseTo(25); // 30 - 5
    expect(p.make(7)).toEqual({ type: "p2cDistance", e: "r", p: 2, circle: "c", value: 7 });
  });

  it("REFUSES a point that lies ON the rim", () => {
    const l = line("l", 5, 0, 30, 0);
    expect(err(resolveDim([T.point(l, 0, 5, 0), rim(T.entity(circle("c", 0, 0, 5)))])).error).toBe("degenerate");
  });

  it("REFUSES the circle's own centre against its own rim", () => {
    const c = circle("c", 0, 0, 5);
    expect(err(resolveDim([T.point(c, 0, 0, 0), rim(T.entity(c))])).error).toBe("same-entity");
  });

  it("REFUSES one circle reached twice by different routes (rim + its own centre)", () => {
    // both picks armed with tangent: the centre pick also reduces to the RIM, so
    // without an explicit guard this reads as two coincident equal rims and the
    // radial-gap branch reports "the same circle" instead of the truth
    const c = circle("c", 0, 0, 5);
    const e = err(resolveDim([rim(T.point(c, 0, 0, 0)), rim(T.entity(c))]));
    expect(e.error).toBe("same-entity");
    expect(e.message).toMatch(/picked twice/);
  });

  it("REFUSES a point sitting on another circle's centre", () => {
    const other = circle("o", 0, 0, 2);
    expect(err(resolveDim([T.point(other, 0, 0, 0), rim(T.entity(circle("c", 0, 0, 5)))])).error)
      .toBe("coincident-points");
  });

  // --- reference geometry ---------------------------------------------------

  it("two PROJECTED rims create a driven (reference) rim dim", () => {
    const p = plan(resolveDim([
      rim(T.entity(projCircle("pa", 0, 0, 5))),
      rim(T.entity(projCircle("pb", 20, 0, 3))),
    ]));
    expect(p.forceDriven).toBe(true);
    expect(p.measure()).toBeCloseTo(12);
  });

  it("a degenerate (zero-radius) rim pick is refused", () => {
    expect(err(resolveDim([rim(T.entity(circle("c", 0, 0, 0))), T.entity(line("l", 0, 5, 10, 5))])).error)
      .toBe("degenerate");
  });
});

// --- right-click Radius / Diameter override ----------------------------------

describe("resolveDim — roundPref override", () => {
  it("defaults a circle to diameter and an arc to radius", () => {
    expect(plan(resolveDim([T.entity(circle("c", 0, 0, 5))])).kind).toBe("diameter");
    expect(plan(resolveDim([T.entity(arc("a"))])).kind).toBe("radius");
  });

  it("forces a circle to a radius dim", () => {
    const p = plan(resolveDim([T.entity(circle("c", 0, 0, 5))], { roundPref: "radius" }));
    expect(p.kind).toBe("radius");
    expect(p.measure()).toBeCloseTo(5);
    expect(p.make(8)).toEqual({ type: "radius", e: "c", value: 8 });
  });

  it("forces an arc to a diameter dim", () => {
    const p = plan(resolveDim([T.entity(arc("a"))], { roundPref: "diameter" }));
    expect(p.kind).toBe("diameter");
    expect(p.measure()).toBeCloseTo(10);
    expect(p.make(9)).toEqual({ type: "diameter", circle: "a", value: 9 });
  });

  it("leaves PAIR dimensions untouched", () => {
    const p = plan(resolveDim(
      [T.entity(circle("a", 0, 0, 5)), T.entity(circle("b", 20, 0, 3))],
      { roundPref: "radius" },
    ));
    expect(p.kind).toBe("distance");
    expect(p.make(20)).toEqual({ type: "p2pDistance", e1: "a", p1: 0, e2: "b", p2: 0, value: 20 });
  });
});
