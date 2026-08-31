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

// --- the CURSOR half: which of the three am I drawing? -----------------------
//
// The tool decides from where the label is being dragged. The rule is "which
// dimension line is the user drawing", not "which quadrant is the cursor in":
// a horizontal dimension's label sits above or below the pair, a vertical one's
// sits beside it, an aligned one's sits off the perpendicular of the line
// joining them. Scoring the cursor direction against those three expected offsets
// is one comparison instead of a pile of quadrant cases, and it behaves for a
// pair at ANY angle rather than only axis-aligned ones.

import * as THREE from "three";
import { p2pDimKind, resolveDim, isDimError, type DimTarget } from "./dimensionTool";
import sketchSrc from "./sketchMode.ts?raw";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

describe("p2pDimKind — the smart part of smart dimensioning", () => {
  // a diagonal pair, so all three answers are genuinely different
  const A = v(0, 0);
  const B = v(40, 30);

  it("dragging ABOVE the pair gives the HORIZONTAL distance", () => {
    expect(p2pDimKind(A, B, v(20, 200))).toBe("horizontal");
    expect(p2pDimKind(A, B, v(20, -200))).toBe("horizontal");
  });

  it("dragging BESIDE the pair gives the VERTICAL distance", () => {
    expect(p2pDimKind(A, B, v(300, 15))).toBe("vertical");
    expect(p2pDimKind(A, B, v(-300, 15))).toBe("vertical");
  });

  it("dragging off the PERPENDICULAR of the pair gives the aligned distance", () => {
    // perpendicular to (40,30) is (-30,40) normalised — go that way from the mid
    const perp = v(-30, 40).normalize().multiplyScalar(80);
    expect(p2pDimKind(A, B, v(20, 15).add(perp))).toBe("aligned");
    expect(p2pDimKind(A, B, v(20, 15).sub(perp))).toBe("aligned");
  });

  it("works for a pair at any angle, not just axis-aligned ones", () => {
    // a steep pair: its perpendicular is nearly horizontal, so "aligned" and
    // "vertical" compete — the aligned zone must still exist and be reachable
    const a = v(0, 0), b = v(5, 90);
    const perp = v(-90, 5).normalize().multiplyScalar(60);
    expect(p2pDimKind(a, b, v(2.5, 45).add(perp))).toBe("aligned");
    expect(p2pDimKind(a, b, v(2.5, 300))).toBe("horizontal");
  });

  it("holds the aligned default when the cursor has no direction to read", () => {
    // exactly on the midpoint: any answer would be arbitrary, and flickering
    // between three as the cursor crosses the centre is worse than picking one
    expect(p2pDimKind(A, B, v(20, 15))).toBe("aligned");
  });

  it("survives coincident picks without dividing by zero", () => {
    expect(p2pDimKind(A, A, v(10, 10))).toBe("aligned");
  });

  it("is stable either side of an axis — no flicker across the centre line", () => {
    // the same zone must answer the same on both sides, or the dimension would
    // change type as the label crosses the pair
    for (const y of [200, -200]) expect(p2pDimKind(A, B, v(20, y))).toBe("horizontal");
    for (const x of [300, -300]) expect(p2pDimKind(A, B, v(x, 15))).toBe("vertical");
  });
});

// WHY the whole mechanism above was unreachable, and what makes it reachable.
//
// GH #17 (Moi455) asked for dimensioning that switches between horizontal,
// vertical and direct distance as you move the cursor. Everything above shipped
// in 0.1.193 and is correct — and none of it could be observed, because
// `sketchMode.dimensionHover` never re-resolved the plan while the label was
// being dragged. The choice was frozen at the instant of the SECOND PICK.
//
// That instant is the worst possible sample point, which the first test here
// pins as a property rather than an anecdote.
describe("the plan must be re-resolved while the label is dragged", () => {
  const A = v(0, 0);
  const B = v(40, 30);

  it("freezing the choice at the second click makes ALIGNED unreachable", () => {
    // At the second click the cursor is BY DEFINITION on the point just picked.
    // From either endpoint the aligned zone is never the answer, so a dimension
    // planned once, at that moment, can only ever be horizontal or vertical —
    // exactly what the reporter described.
    expect(p2pDimKind(A, B, A)).not.toBe("aligned");
    expect(p2pDimKind(A, B, B)).not.toBe("aligned");
    // ...while a cursor dragged off the pair's perpendicular does give aligned,
    // so the information was there all along and was simply never sampled again.
    const perp = v(-30, 40).normalize().multiplyScalar(80);
    expect(p2pDimKind(A, B, v(20, 15).add(perp))).toBe("aligned");
  });

  it("the three kinds build DIFFERENT constraints, so re-resolving changes the result", () => {
    const pt = (id: string, x: number, y: number): DimTarget => ({
      kind: "point",
      e: { type: "point", id, x, y } as never,
      p: 0,
      pos: v(x, y),
    });
    const picks = [pt("a", 0, 0), pt("b", 40, 30)];
    const kindOf = (cursor: THREE.Vector2) => {
      const r = resolveDim(picks, { cursor });
      if (isDimError(r)) throw new Error("resolveDim refused a plain point pair");
      return { type: (r.make(1) as { type: string }).type, label: r.fields[0]?.label };
    };
    const perp = v(-30, 40).normalize().multiplyScalar(80);
    expect(kindOf(v(20, 200))).toEqual({ type: "p2pDistanceX", label: "DX" });
    expect(kindOf(v(300, 15))).toEqual({ type: "p2pDistanceY", label: "DY" });
    expect(kindOf(v(20, 15).add(perp))).toEqual({ type: "p2pDistance", label: "D" });
  });

  it("the three are indistinguishable by kind+fieldKey, so identity needs the LABEL", () => {
    // This is the trap that makes the fix more than one line. All three plans
    // are kind "distance" with fieldKey "distance:length". SketchMode re-shows
    // the value box only when its dimIdentity changes, so an identity built from
    // kind+fieldKey alone would let the constraint flip from p2pDistance to
    // p2pDistanceX under a box still labelled "D" — a value typed for one
    // dimension committed as another.
    const pt = (id: string, x: number, y: number): DimTarget => ({
      kind: "point", e: { type: "point", id, x, y } as never, p: 0, pos: v(x, y),
    });
    const picks = [pt("a", 0, 0), pt("b", 40, 30)];
    const plan = (cursor: THREE.Vector2) => {
      const r = resolveDim(picks, { cursor });
      if (isDimError(r)) throw new Error("refused");
      return r;
    };
    const perp = v(-30, 40).normalize().multiplyScalar(80);
    const h = plan(v(20, 200));
    const a = plan(v(20, 15).add(perp));
    expect(`${h.kind}:${h.fieldKey}`).toBe(`${a.kind}:${a.fieldKey}`); // identical!
    expect(h.fields[0]?.label).not.toBe(a.fields[0]?.label); // the only difference
  });
});

// The wiring, which is what actually broke. Source text, not an import:
// constructing a real SketchMode boots the viewport, overlay and solver, and no
// test in this repo does it — which is precisely how a fully tested chooser
// shipped with nothing calling it. Same approach and same limitation as
// trimRawCursor.test.ts.
describe("sketchMode wires the live re-plan (source)", () => {
  it("dimensionHover re-resolves the plan while the label is unplaced", () => {
    const at = sketchSrc.indexOf("private dimensionHover(");
    expect(at, "dimensionHover is gone — this test pins nothing").toBeGreaterThan(-1);
    const body = sketchSrc.slice(at, at + 1400);
    expect(
      body,
      "dimensionHover no longer re-resolves: the dimension kind is frozen at the second pick again",
    ).toContain("this.refreshDimPlan()");
    expect(
      body,
      "the re-plan must be gated on !dimPlaced, or placing the label re-shows the box and destroys what was typed",
    ).toContain("!this.dimPlaced");
  });

  it("dimIdentity includes the field label", () => {
    const at = sketchSrc.indexOf("private dimIdentity(");
    const body = sketchSrc.slice(at, at + 400);
    expect(
      body,
      "dimIdentity dropped the label — aligned/horizontal/vertical are indistinguishable again",
    ).toContain("fields[0]?.label");
  });
});
