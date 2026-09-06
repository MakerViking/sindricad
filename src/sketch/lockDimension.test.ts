// Cluster "lock-dimension" — reports dff87040 ("Equal on a 50x100 rectangle
// gives an 86.9 square... I don't have any obvious way to constrain a
// dimension") and d8c5265e ("I change the diameter of the circle... it changes
// the dimensions of the box as well").
//
// One design gap behind both: a value badge's border is the only signal of
// whether it drives anything, and a rectangle's W/H badge — which nothing can
// drive — rendered with the SOLID accent border that means "driving". So the
// user typed 50 and 100, watched the numbers change back, and had no way to
// pin them.
//
// These run the REAL planegcs wasm so the assertions are about geometry, not
// about which function was called.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve, soleDimEntity } from "./sketchSolve";
import { governingDimAt, lockDimFor, planDimEdit } from "./directDims";
import { expectUnchangedOnFailure } from "./solveInvariants";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const rect = (width: number, height: number): ResolvedEntity =>
  ({ type: "rectangle", id: "e11", x: -7.649130461954812, y: 27.027137507924373, width, height }) as ResolvedEntity;
const asRect = (e: ResolvedEntity | undefined) => {
  if (e?.type !== "rectangle") throw new Error("rectangle lost");
  return e;
};

describe("which badge is a measurement and which one drives", () => {
  it("a rectangle's W/H badge reads as a MEASUREMENT until something governs it", () => {
    // the whole of report dff87040: this used to answer `null`, which
    // SketchDimensions renders with the solid accent border — the same border a
    // driving dimension gets.
    expect(governingDimAt([], rect(100, 50), "width")).toBe("free");
    expect(governingDimAt([], rect(100, 50), "height")).toBe("free");
  });

  it("a locked rectangle badge reports the constraint that holds it", () => {
    const cons: SketchConstraint[] = [
      { type: "horizontal", line: "other" },
      { type: "distance", line: "e11~0", value: 100 },
    ];
    expect(governingDimAt(cons, rect(100, 50), "width")).toBe(1);
    // the height is still free: one lock does not vouch for the other
    expect(governingDimAt(cons, rect(100, 50), "height")).toBe("free");
  });

  it("counts the OPPOSITE edge too — either one fixes that extent", () => {
    const cons: SketchConstraint[] = [{ type: "distance", line: "e11~2", value: 100 }];
    expect(governingDimAt(cons, rect(100, 50), "width")).toBe(0);
    const tall: SketchConstraint[] = [{ type: "distance", line: "e11~1", value: 50 }];
    expect(governingDimAt(tall, rect(100, 50), "height")).toBe(0);
  });

  it("a polygon's radius stays intrinsic — the solver never moves it", () => {
    const poly = { type: "polygon", id: "p1", x: 0, y: 0, radius: 10, sides: 6, angle: 0 } as unknown as ResolvedEntity;
    expect(governingDimAt([], poly, "radius")).toBeNull();
  });
});

describe("locking a rectangle's width", () => {
  it("names the rectangle's own bottom edge, at the value on the badge", () => {
    expect(lockDimFor(rect(100, 50), "width", 100)).toEqual({ type: "distance", line: "e11~0", value: 100 });
    expect(lockDimFor(rect(100, 50), "height", 50)).toEqual({ type: "distance", line: "e11~3", value: 50 });
  });

  it("holds 100 x 50 under Equal instead of collapsing to a square", async () => {
    const equal: SketchConstraint = { type: "equal", l1: "e11~3", l2: "e11~0" };

    // What the reporter had: two dimensions he typed himself, both stamped
    // `driven` (Reference Dim was on), which the solver drops before compiling.
    // Equal was then free to make the rectangle square — he saw 86.9 mm, this
    // seed gives 63.1, and the number is not the point: nothing held either
    // side, and nothing said so.
    const loose = await compileAndSolve([rect(100, 50)], [
      { type: "p2pDistance", e1: "e11", p1: 0, e2: "e11", p2: 1, value: 100, driven: true },
      { type: "p2pDistance", e1: "e11", p1: 3, e2: "e11", p2: 0, value: 50, driven: true },
      equal,
    ]);
    expect(loose.ok).toBe(true);
    const collapsed = asRect(loose.entities[0]);
    expect(collapsed.width).toBeCloseTo(collapsed.height, 4); // a square
    expect(collapsed.width).not.toBeCloseTo(100, 3);

    // Locked: the same two dimensions as driving constraints. Equal now
    // CONFLICTS — reported, with the geometry left where it was.
    const before = [rect(100, 50)];
    const locked = await compileAndSolve([rect(100, 50)], [
      lockDimFor(rect(100, 50), "width", 100)!,
      lockDimFor(rect(100, 50), "height", 50)!,
      equal,
    ]);
    expect(locked.ok).toBe(false);
    expectUnchangedOnFailure(locked, before, locked.entities, "locked rectangle under Equal");
    const held = asRect(locked.entities[0]);
    expect(held.width).toBeCloseTo(100, 6);
    expect(held.height).toBeCloseTo(50, 6);
  }, 30000);

  it("leaves the rectangle solvable on its own (it is a dimension, not a fix)", async () => {
    const r = await compileAndSolve([rect(100, 50)], [
      lockDimFor(rect(100, 50), "width", 100)!,
      lockDimFor(rect(100, 50), "height", 50)!,
    ]);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(2); // it can still be moved; it can no longer be resized
    expect(asRect(r.entities[0]).width).toBeCloseTo(100, 6);
  }, 30000);
});

describe("editing a badge that is already locked", () => {
  it("retypes the constraint rather than writing a width the next solve undoes", () => {
    const cons: SketchConstraint[] = [{ type: "distance", line: "e11~0", value: 100 }];
    expect(planDimEdit(cons, rect(100, 50), "width", 60)).toEqual({ kind: "retype", at: 0 });
  });

  it("an unlocked rectangle badge still writes straight into the geometry", () => {
    expect(planDimEdit([], rect(100, 50), "width", 60)).toEqual({ kind: "direct" });
  });

  it("a circle's diameter still becomes a driving constraint, and moves the circle", () => {
    const circle = { type: "circle", id: "e8", x: 0, y: 0, radius: 10 } as ResolvedEntity;
    expect(planDimEdit([], circle, "diameter", 30)).toEqual({
      kind: "upsert",
      c: { type: "diameter", circle: "e8", value: 30 },
      moves: "e8",
    });
  });
});

// Report d8c5265e: a circle held inside a free rectangle by two tangents. Its
// diameter edit ran an UNBIASED solve, so planegcs split the correction between
// the circle's centre and the rectangle's corners — "there is no obvious reason
// for the box dimensions to change".
describe("a dimension value edit moves the entity it dimensions", () => {
  const seed = (): ResolvedEntity[] => [
    { type: "rectangle", id: "e7", x: -44.75031411997571, y: 24.922397843507845, width: 71.19921540795315, height: 43.80078459003447 } as ResolvedEntity,
    { type: "circle", id: "e8", x: -70.34992182395229, y: 36.82279013852507, radius: 10 } as ResolvedEntity,
  ];
  const cons = (dia: number): SketchConstraint[] => [
    { type: "tangent2", a: "e8", b: "e7~2" },
    { type: "tangent2", a: "e8", b: "e7~3" },
    { type: "diameter", id: "c9", circle: "e8", value: dia },
  ];

  it("names the circle as the mover for its own diameter", () => {
    expect(soleDimEntity({ type: "diameter", circle: "e8", value: 30 })).toBe("e8");
    expect(soleDimEntity({ type: "distance", line: "e11~0", value: 100 })).toBe("e11~0");
    expect(soleDimEntity({ type: "p2pDistance", e1: "e11", p1: 0, e2: "e11", p2: 1, value: 100 })).toBe("e11");
  });

  it("leaves a genuine two-entity dimension unbiased — there is no edited entity", () => {
    // the pick order is deliberately not stored (dimensionTool), so a dim
    // between two entities has no "the one you meant" to prefer
    expect(soleDimEntity({ type: "p2pDistance", e1: "e7", p1: 0, e2: "e8", p2: 0, value: 30 })).toBeNull();
    expect(soleDimEntity({ type: "equal", l1: "a", l2: "b" })).toBeNull();
  });

  it("free, the rectangle absorbs part of a diameter change", async () => {
    const r = await compileAndSolve(seed(), cons(30));
    expect(r.ok).toBe(true);
    const box = asRect(r.entities[0]);
    // the reported symptom, reproduced: the box grew with the circle
    expect(box.width).toBeGreaterThan(72);
    expect(box.height).toBeGreaterThan(44.5);
  }, 30000);

  it("with the circle named as the mover, only the circle moves", async () => {
    const r = await compileAndSolve(seed(), cons(30), undefined, { moves: [soleDimEntity(cons(30)[2]!)!] });
    expect(r.ok).toBe(true);
    const box = asRect(r.entities[0]);
    expect(box.x).toBeCloseTo(-44.75031411997571, 6);
    expect(box.y).toBeCloseTo(24.922397843507845, 6);
    expect(box.width).toBeCloseTo(71.19921540795315, 6);
    expect(box.height).toBeCloseTo(43.80078459003447, 6);
    const c = r.entities[1];
    if (c?.type !== "circle") throw new Error("circle lost");
    expect(c.radius).toBeCloseTo(15, 6); // and the typed diameter is honoured
  }, 30000);

  it("holds the box when the diameter SHRINKS too", async () => {
    const r = await compileAndSolve(seed(), cons(10), undefined, { moves: ["e8"] });
    expect(r.ok).toBe(true);
    expect(asRect(r.entities[0]).width).toBeCloseTo(71.19921540795315, 6);
  }, 30000);
});
