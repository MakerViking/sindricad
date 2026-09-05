// Each solve runs on its own planegcs system, so a solve cannot inherit state
// from the one before it.
//
// This replaces solveReproducibility.test.ts, which pinned the OPPOSITE: with
// one GcsSystem shared for the app's lifetime and only clear_data() between
// solves, an identical sketch solved twelve times in a row came back with two
// different rectangles once an unrelated solve had run first (40 mm against
// 33.49 mm, both legitimate answers to an under-constrained sketch). That file
// said of itself: "If planegcs (or clear_data) has been fixed so solves no
// longer inherit state, this whole file is obsolete — delete it rather than
// loosening it." The retry pass added to compileAndSolve on 2026-09-05 (up to
// three solves per call) made the inheritance bite on every call, and the old
// "cold" repeatability assertion then failed on the CI runner while passing
// locally, because how far the leaked state moved the answer depended on the
// CPU's float path. The fix is in solver.ts: one system per solve, deleted
// afterwards. This test observes the effect that file could not have: the
// unrelated solve no longer changes the answer.
import { describe, it, expect, vi } from "vitest";
declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
import { compileAndSolve } from "./sketchSolve";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const RECT = (id: string, x: number, y: number, width: number, height: number) =>
  ({ type: "rectangle", id, x, y, width, height }) as unknown as ResolvedEntity;
const L = (id: string, x1: number, y1: number, x2: number, y2: number) =>
  ({ type: "line", id, x1, y1, x2, y2 }) as unknown as ResolvedEntity;

const REPEATS = 12;

/** The subject the old file called bistable: two free points made symmetric
 *  about a rectangle's bottom edge, with nothing saying how wide the rectangle
 *  is. Returns the solved width and the constraint's own residual. */
async function underConstrained() {
  const ents = [RECT("R", 0, 0, 40, 20), L("A", -30, 30, -10, 33), L("B", 10, -30, 30, -35)];
  const r = await compileAndSolve(ents, [
    { type: "symmetric", e1: "A", p1: 0, e2: "B", p2: 0, line: "R~0" } as SketchConstraint,
  ]);
  const R = r.entities.find((e) => e.id === "R") as { width: number; height: number; y: number };
  const A = r.entities.find((e) => e.id === "A") as { y1: number };
  const B = r.entities.find((e) => e.id === "B") as { y1: number };
  const axisY = R.y - R.height / 2;
  return { width: R.width, residual: Math.abs((A.y1 - axisY) + (B.y1 - axisY)), ok: r.ok };
}

/** The unrelated solve that used to perturb the one after it. */
async function unrelatedSolve(lines: number) {
  const many: ResolvedEntity[] = [];
  for (let i = 0; i < lines; i++) many.push(L(`M${i}`, i, 0, i + 5, 3));
  await compileAndSolve(many, many.map((_, i) => ({ type: "horizontal", line: `M${i}` } as SketchConstraint)));
}

const distinct = (v: number[]) => new Set(v.map((x) => x.toFixed(4))).size;

describe("a solve does not inherit state from the solve before it", () => {
  it("an unrelated solve in between leaves an identical solve identical", async () => {
    // Warm the module with one solve first: the very first solve in a fresh
    // wasm instance is allowed to differ from the rest (one-time initialisation
    // inside the module), and that is not what this test is about.
    await underConstrained();
    const a = await underConstrained();
    await unrelatedSolve(40);
    const b = await underConstrained();
    expect(b.width, "the unrelated solve changed the next answer — state leaked between solves").toBe(a.width);
  });

  it("repeats agree, and every one of them is a real answer", async () => {
    await underConstrained();
    const runs: Awaited<ReturnType<typeof underConstrained>>[] = [];
    for (let i = 0; i < REPEATS; i++) runs.push(await underConstrained());
    expect(distinct(runs.map((r) => r.width)), "the same input gives the same rectangle every time").toBe(1);
    expect(runs.every((r) => r.ok), "every solve lands on a real answer").toBe(true);
    expect(runs.every((r) => r.residual <= 1e-6), "and satisfies symmetric").toBe(true);
    // The old collapsed branch (a zero-width rectangle) is caught by the
    // geometry guard and re-solved from a shape-preserving seed; none of it may
    // reach the document.
    expect(Math.min(...runs.map((r) => r.width)), "no collapsed rectangle reaches the document").toBeGreaterThan(1e-3);
  });
});
