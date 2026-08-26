// HORIZONTAL and VERTICAL point-to-point dimensions — the solver half of smart
// dimensioning (GH #17: "It needs dynamic behavior based on cursor position to
// intelligently switch between shortest direct distance, explicit horizontal
// distance, explicit vertical distance").
//
// planegcs has no p2p_distance_x, so these ride its generic `difference`
// constraint on the points' own x / y params. Whether that actually works on a
// POINT (rather than on a circle's radius, its only previous use here) was the
// open question this file was written to answer. It does.
//
// Every case has teeth in the same shape constraintSemantics.test.ts uses: the
// predicate is VIOLATED by the starting geometry and SATISFIED after the solve.
// A fixture that already satisfied it would pass against a solver that did
// nothing.

import { describe, it, expect, vi } from "vitest";
// no @types/node in this project — the other real-solver suites declare it too
declare const process: { cwd(): string };
// The wasm URL has to be redirected to a real path or the solver cannot start
// under vitest (Vite serves it as a /@fs/ URL). Same shim the other real-solver
// suites use.
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
import { compileAndSolve } from "./sketchSolve";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

/** two free points, at a deliberately awkward offset from each other */
const twoPoints = (): ResolvedEntity[] => [
  { type: "point", id: "a", x: 0, y: 0 },
  { type: "point", id: "b", x: 3, y: 7 },
] as ResolvedEntity[];

/** `a` pinned so the solve has one answer, not a family of them */
const pinA = (): SketchConstraint[] => [{ type: "fix", e: "a", p: 0 }] as SketchConstraint[];

async function solve(ents: ResolvedEntity[], cons: SketchConstraint[]) {
  const r = await compileAndSolve(ents, cons);
  const at = (id: string) => {
    const e = r.entities.find((x) => x.id === id) as { x: number; y: number } | undefined;
    expect(e, `entity ${id} vanished from the solve`).toBeTruthy();
    return e!;
  };
  return { r, at };
}

describe("horizontal (X) point-to-point dimension", () => {
  it("drives the X separation and leaves Y alone", async () => {
    const ents = twoPoints();
    // teeth: the fixture starts at dx = 3, not 25
    expect((ents[1] as { x: number }).x - (ents[0] as { x: number }).x).not.toBeCloseTo(25);

    const { r, at } = await solve(ents, [
      ...pinA(),
      { type: "p2pDistanceX", id: "d", e1: "a", p1: 0, e2: "b", p2: 0, value: 25 } as SketchConstraint,
    ]);
    expect(r.conflicts).toEqual([]);
    expect(at("b").x - at("a").x).toBeCloseTo(25, 6);
    // and it is NOT a direct distance: y is untouched, so the straight-line
    // separation stays sqrt(25^2 + 7^2), not 25
    expect(at("b").y - at("a").y).toBeCloseTo(7, 6);
  });

  it("is SIGNED — the operand order says which side", async () => {
    // The whole reason a horizontal dim differs from |dx|: it can say "to the
    // left". Swapping the operands must negate it, so these must never be
    // canonicalised by sorting ids.
    const { at } = await solve(twoPoints(), [
      ...pinA(),
      { type: "p2pDistanceX", id: "d", e1: "b", p1: 0, e2: "a", p2: 0, value: 25 } as SketchConstraint,
    ]);
    expect(at("a").x - at("b").x).toBeCloseTo(25, 6);
    expect(at("b").x).toBeCloseTo(-25, 6); // b moved LEFT of the pinned a
  });

  it("accepts a negative value", async () => {
    const { at } = await solve(twoPoints(), [
      ...pinA(),
      { type: "p2pDistanceX", id: "d", e1: "a", p1: 0, e2: "b", p2: 0, value: -12 } as SketchConstraint,
    ]);
    expect(at("b").x - at("a").x).toBeCloseTo(-12, 6);
  });
});

describe("vertical (Y) point-to-point dimension", () => {
  it("drives the Y separation and leaves X alone", async () => {
    const ents = twoPoints();
    expect((ents[1] as { y: number }).y - (ents[0] as { y: number }).y).not.toBeCloseTo(-12);

    const { r, at } = await solve(ents, [
      ...pinA(),
      { type: "p2pDistanceY", id: "d", e1: "a", p1: 0, e2: "b", p2: 0, value: -12 } as SketchConstraint,
    ]);
    expect(r.conflicts).toEqual([]);
    expect(at("b").y - at("a").y).toBeCloseTo(-12, 6);
    expect(at("b").x - at("a").x).toBeCloseTo(3, 6);
  });
});

describe("the three dimensions are genuinely different constraints", () => {
  it("X + Y together fully place a point, and disagree with the aligned one", async () => {
    const { r, at } = await solve(twoPoints(), [
      ...pinA(),
      { type: "p2pDistanceX", id: "dx", e1: "a", p1: 0, e2: "b", p2: 0, value: 30 } as SketchConstraint,
      { type: "p2pDistanceY", id: "dy", e1: "a", p1: 0, e2: "b", p2: 0, value: 40 } as SketchConstraint,
    ]);
    expect(r.conflicts).toEqual([]);
    expect(at("b").x).toBeCloseTo(30, 6);
    expect(at("b").y).toBeCloseTo(40, 6);
    // the ALIGNED distance is now 50 — which is why "50 apart" and "30 across,
    // 40 up" are three different dimensions and not one with a display option
    expect(Math.hypot(at("b").x - at("a").x, at("b").y - at("a").y)).toBeCloseTo(50, 6);
    expect(r.dof).toBe(0);
  });

  it("an aligned distance does NOT pin the axes", async () => {
    // the contrast case: p2pDistance leaves a degree of freedom that the X/Y
    // pair removes, which is exactly what the user is choosing between
    const { r } = await solve(twoPoints(), [
      ...pinA(),
      { type: "p2pDistance", id: "d", e1: "a", p1: 0, e2: "b", p2: 0, value: 50 } as SketchConstraint,
    ]);
    expect(r.dof).toBeGreaterThan(0);
  });
});
