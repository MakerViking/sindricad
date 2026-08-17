// THE SAME SKETCH DOES NOT ALWAYS SOLVE THE SAME WAY.
//
// Found while building the constraint semantic ratchet
// (constraintSemantics.test.ts): one case there came back as a 0 mm wide
// rectangle when run on its own, and a 33.49 mm one when the rest of the file
// ran first. Same entities, same constraint, same process, different answer.
//
// Narrowed to this, all measured:
//   - Cold in a process, the identical solve repeated 12 times gives 12
//     identical results.
//   - After ONE unrelated larger solve (40 lines that share nothing with the
//     sketch, solved and discarded), repeating that same identical solve gives
//     TWO different geometries, alternating between them run to run.
//   - Both of them satisfy the constraint exactly. Neither is a convergence
//     failure the app could detect: both report ok, with no conflicts.
//   - A sketch with no degenerate alternative solution stays perfectly stable
//     under the same treatment (the control below). So this is not "the solver
//     is random" — it is a sketch with two valid solutions, one of which is
//     collapsed, and the tie being broken by leftover state.
//
// The mechanism is under planegcs. `solveSketch` keeps ONE GcsWrapper for the
// life of the process (solver.ts:84-101) and calls `clear_data()` before every
// solve; clear_data empties the JS index maps and calls the WASM System's own
// clear (gcs_wrapper.js:37-43), and something the big solve left behind
// survives it.
//
// Why it matters beyond tests: SketchMode pumps a solve on every constraint
// change and every drag frame. A sketch with free DOF and a reachable
// degenerate solution can therefore land on a different shape frame to frame,
// and one of the two shapes here has no area at all.
//
// This is deliberately its OWN file. vitest gives each test file a fresh
// worker, and a cold process is the only place the first-solve behaviour can be
// observed at all — folding these into another file would make them measure
// whatever ran before them, which is the very thing under test.
import { describe, it, expect, vi } from "vitest";

// no @types/node here (tsconfig types is ["vite/client"]) — same local
// declaration sketchSolve.test.ts uses to reach the real wasm on disk
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

/** THE bistable subject: two free points made symmetric about a rectangle's
 *  bottom edge. Nothing in the sketch says how wide the rectangle should be, and
 *  one of the solutions available to the solver is "no width at all" — the
 *  rectangle's own implicit horizontal/vertical rules are satisfied vacuously
 *  once an edge has zero length. Returns the solved width, plus the constraint's
 *  own residual so a flip can be told from a failure. */
async function bistableCase() {
  const ents = [RECT("R", 0, 0, 40, 20), L("A", -30, 30, -10, 33), L("B", 10, -30, 30, -35)];
  const r = await compileAndSolve(ents, [
    { type: "symmetric", e1: "A", p1: 0, e2: "B", p2: 0, line: "R~0" } as SketchConstraint,
  ]);
  const R = r.entities.find((e) => e.id === "R") as { width: number; height: number; y: number };
  const A = r.entities.find((e) => e.id === "A") as { y1: number };
  const B = r.entities.find((e) => e.id === "B") as { y1: number };
  // R~0 is the bottom edge; symmetric holds when the two points straddle it evenly
  const axisY = R.y - R.height / 2;
  return { width: R.width, residual: Math.abs((A.y1 - axisY) + (B.y1 - axisY)), ok: r.ok };
}

/** The CONTROL: two plain lines and one parallel constraint. Just as
 *  underdetermined, but with no degenerate solution to fall into. */
async function stableCase() {
  const ents = [L("P", 0, 0, 40, 0), L("Q", 10, 20, 44, 33)];
  const r = await compileAndSolve(ents, [{ type: "parallel", l1: "P", l2: "Q" } as SketchConstraint]);
  const q = r.entities.find((e) => e.id === "Q") as { x1: number; y1: number; x2: number; y2: number };
  return Math.hypot(q.x2 - q.x1, q.y2 - q.y1);
}

/** An unrelated solve, large enough to trip it. Shares no id, no position and no
 *  constraint with either case above: it is solved and thrown away. */
async function unrelatedSolve(lines: number) {
  const many: ResolvedEntity[] = [];
  for (let i = 0; i < lines; i++) many.push(L(`M${i}`, i, 0, i + 5, 3));
  await compileAndSolve(many, many.map((_, i) => ({ type: "horizontal", line: `M${i}` } as SketchConstraint)));
}

const distinct = (v: number[]) => new Set(v.map((x) => x.toFixed(4))).size;
const repeat = async <T>(n: number, f: () => Promise<T>): Promise<T[]> => {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await f());
  return out;
};

describe("an unrelated earlier solve makes an identical solve stop repeating itself", () => {
  it("cold, the identical solve is perfectly repeatable", async () => {
    // FIRST solves in this process — establishes that the input is not
    // inherently ambiguous to the solver, so the flip below is caused by
    // something and is not just how this sketch always behaves.
    const cold = await repeat(REPEATS, bistableCase);
    expect(cold.every((r) => r.ok), "every cold solve succeeds").toBe(true);
    expect(distinct(cold.map((r) => r.width)),
      "cold, the same input gives the same rectangle every time").toBe(1);
  });

  it("after one unrelated solve, the identical solve returns two different rectangles", async () => {
    await unrelatedSolve(40);
    const warm = await repeat(REPEATS, bistableCase);
    const widths = warm.map((r) => r.width);

    expect(distinct(widths),
      `the same sketch, solved ${REPEATS} times in a row with nothing in between, `
      + "came back the same every time. If planegcs (or clear_data) has been "
      + "fixed so solves no longer inherit state, this whole file is obsolete — "
      + "delete it rather than loosening it.")
      .toBeGreaterThan(1);

    // and the two answers are not near-misses: one of them has no area at all
    expect(Math.max(...widths) - Math.min(...widths),
      "the two answers differ by a whole rectangle").toBeGreaterThan(1);
    expect(Math.min(...widths), "one of the two answers is a collapsed rectangle")
      .toBeLessThan(1e-3);
  });

  it("neither answer is a failure the app could catch — both satisfy the constraint", async () => {
    // This is what makes it dangerous rather than merely untidy. There is no
    // error to report: the solver is right both times, the sketch simply never
    // said which of the two it wanted.
    await unrelatedSolve(40);
    const warm = await repeat(REPEATS, bistableCase);
    for (const r of warm) {
      expect(r.ok, "every solve reports success").toBe(true);
      expect(r.residual, "every solve satisfies symmetric exactly").toBeLessThanOrEqual(1e-6);
    }
  });

  it("CONTROL: a sketch with no degenerate solution stays put", async () => {
    // Same treatment, ordinary geometry: stable before and after. So the flip is
    // not the solver being nondeterministic in general — it is specifically a
    // tie between a real solution and a collapsed one, and that tie is the thing
    // to remove (see the rectangle collapse guard in constraintSemantics).
    const before = await repeat(REPEATS, stableCase);
    await unrelatedSolve(40);
    const after = await repeat(REPEATS, stableCase);

    expect(distinct(before), "stable sketch, cold").toBe(1);
    expect(distinct(after), "stable sketch, after an unrelated solve").toBe(1);
    expect(after[0]!, "and it is the same answer as before").toBeCloseTo(before[0]!, 9);
  });
});
