// SEQUENCES, because every test we had solved exactly once.
//
// The bug that motivated this file is invisible to any single-shot test by
// construction: applying Collinear to two lines already pinned Horizontal and
// Vertical is unsatisfiable, and the constraint was left in the sketch anyway.
// From then on the whole system could not solve, so every LATER constraint
// silently did nothing — a perfectly valid Parallel on unrelated lines looked
// broken. One operation: fine. Two: broken. (Reported in the app 2026-08-15.)
//
// The harness below applies constraints ONE AT A TIME with the same rule
// SketchMode uses — a constraint that conflicts is withdrawn and the sketch
// falls back to its last good state — and checks the invariants after every
// single step, not just at the end.
import { describe, it, expect, vi } from "vitest";

// no @types/node here (tsconfig types is ["vite/client"]) — same local
// declaration sketchSolve.test.ts uses to reach the real wasm on disk
declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
import { compileAndSolve } from "./sketchSolve";
import { expectSaneGeometry } from "./solveInvariants";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

interface Step {
  constraint: SketchConstraint;
  applied: boolean;
}

/** Apply constraints in order, withdrawing any whose solve conflicts.
 *
 *  Mirrors SketchMode.pump's rule deliberately: a constraint is on trial until
 *  its solve returns, and an unsatisfiable one must leave NO trace. The
 *  invariants are asserted after every step so a failure names the step that
 *  broke it rather than the end state. */
async function applyInOrder(start: ResolvedEntity[], wanted: SketchConstraint[]) {
  let entities = start;
  const kept: SketchConstraint[] = [];
  const log: Step[] = [];

  for (const c of wanted) {
    const trial = [...kept, c];
    const r = await compileAndSolve(entities, trial);
    const rejected = !r.ok || r.conflicts.length > 0;
    if (rejected) {
      log.push({ constraint: c, applied: false });
      continue; // withdrawn: `kept` and `entities` are untouched
    }
    kept.push(c);
    expectSaneGeometry(r.entities, `after applying ${c.type}`, entities);
    entities = r.entities;
    log.push({ constraint: c, applied: true });
  }
  return { entities, kept, log };
}

const L = (id: string, x1: number, y1: number, x2: number, y2: number) =>
  ({ type: "line", id, x1, y1, x2, y2 }) as unknown as ResolvedEntity;

describe("a rejected constraint must not poison the ones after it", () => {
  it("still applies a valid Parallel after an impossible Collinear", async () => {
    // exactly the shape on screen when this was reported: an L that is already
    // H+V, plus a second, unrelated pair of nearly-parallel lines
    const start = [
      L("A", 0, 0, 55, 0),      // the L, horizontal arm
      L("B", 0, 0, 0, -45),     // the L, vertical arm
      L("C", 90, 0, 90, -45),   // unrelated pair
      L("D", 120, 2, 123, -43),
    ];
    const { kept, log } = await applyInOrder(start, [
      { type: "horizontal", line: "A" } as SketchConstraint,
      { type: "vertical", line: "B" } as SketchConstraint,
      { type: "collinear", l1: "A", l2: "B" } as SketchConstraint, // impossible
      { type: "parallel", l1: "C", l2: "D" } as SketchConstraint,  // perfectly fine
    ]);

    const applied = (t: string) => log.find((s) => s.constraint.type === t)?.applied;
    expect(applied("horizontal"), "horizontal should apply").toBe(true);
    expect(applied("vertical"), "vertical should apply").toBe(true);
    expect(applied("collinear"), "collinear on H+V is impossible and must be withdrawn").toBe(false);
    // THE POINT OF THE FILE: the next constraint must still work
    expect(applied("parallel"), "a valid parallel after a rejected collinear must still apply").toBe(true);
    expect(kept.some((c) => c.type === "collinear"), "the rejected constraint must leave no trace").toBe(false);
  });

  it("keeps the sketch solvable and the geometry sane at every step", async () => {
    const start = [L("A", 0, 0, 50, 0), L("B", 0, 0, 0, -40), L("C", 80, 0, 130, 4)];
    const { entities, kept } = await applyInOrder(start, [
      { type: "horizontal", line: "A" } as SketchConstraint,
      { type: "vertical", line: "B" } as SketchConstraint,
      { type: "collinear", l1: "A", l2: "B" } as SketchConstraint, // withdrawn
      { type: "parallel", l1: "A", l2: "C" } as SketchConstraint,
      { type: "horizontal", line: "C" } as SketchConstraint,
    ]);
    // whatever survived, the result must still be geometry
    expectSaneGeometry(entities, "end of sequence");
    // and the surviving set must actually solve
    const final = await compileAndSolve(entities, kept);
    expect(final.conflicts, "the surviving constraint set must solve cleanly").toEqual([]);
  });

  it("does not care about the ORDER a conflicting pair arrives in", async () => {
    // collinear first, then the vertical that contradicts it: whichever arrives
    // second is the one withdrawn, and either way the sketch stays usable
    const start = [L("A", 0, 0, 50, 0), L("B", 0, 0, 0, -40)];
    const { entities, kept } = await applyInOrder(start, [
      { type: "horizontal", line: "A" } as SketchConstraint,
      { type: "collinear", l1: "A", l2: "B" } as SketchConstraint,
      { type: "vertical", line: "B" } as SketchConstraint,
    ]);
    expectSaneGeometry(entities, "reversed order");
    const final = await compileAndSolve(entities, kept);
    expect(final.conflicts).toEqual([]);
  });
});

// PROPERTY / FUZZ, for the cases neither of us thinks to enumerate.
//
// Everything above is a scenario someone had to imagine first. The three bugs
// this week were all found by a human clicking around, which is exactly the
// search this replaces: random sketches, random constraint orders, asserting
// ONLY the invariants — never a specific expected outcome, because for random
// input there isn't one.
//
// The seed is printed on failure and the generator is deterministic, so any
// failure replays exactly. (Math.random would make a failure unrepeatable,
// which is worse than no test.)
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const CONSTRAINT_KINDS = ["horizontal", "vertical", "parallel", "perpendicular", "collinear", "equal"] as const;

function randomCase(seed: number) {
  const r = rng(seed);
  const n = 2 + Math.floor(r() * 3); // 2-4 lines
  const lines: ResolvedEntity[] = [];
  for (let i = 0; i < n; i++) {
    const x1 = Math.round(r() * 100), y1 = Math.round(r() * 100);
    // a mix of axis-aligned, near-axis and skew, because a uniform fixture
    // hides exactly the bugs that only show when things differ
    const mode = Math.floor(r() * 3);
    // 0 = near-horizontal, 1 = near-vertical, 2 = skew
    const big = () => Math.round(r() * 60) + 5;
    const small = () => Math.round(r() * 4);
    const skew = () => Math.round(r() * 60) - 30;
    const dx = mode === 0 ? big() : mode === 1 ? small() : skew();
    const dy = mode === 0 ? small() : mode === 1 ? big() : skew();
    if (dx === 0 && dy === 0) continue; // never emit a zero-length line
    lines.push(L(`L${i}`, x1, y1, x1 + dx, y1 + dy));
  }
  const wanted: SketchConstraint[] = [];
  const steps = 2 + Math.floor(r() * 4); // 2-5 constraints
  for (let i = 0; i < steps; i++) {
    const kind = CONSTRAINT_KINDS[Math.floor(r() * CONSTRAINT_KINDS.length)]!;
    const a = `L${Math.floor(r() * n)}`, b = `L${Math.floor(r() * n)}`;
    if (kind === "horizontal" || kind === "vertical") wanted.push({ type: kind, line: a } as SketchConstraint);
    else if (a !== b) wanted.push({ type: kind, l1: a, l2: b } as SketchConstraint);
  }
  return { lines, wanted };
}

describe("random constraint sequences keep the sketch usable", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 37);
  it.each(SEEDS)("seed %i never produces broken geometry or a stuck sketch", async (seed) => {
    const { lines, wanted } = randomCase(seed);
    const { entities, kept } = await applyInOrder(lines, wanted);
    // 1. whatever survived is still geometry (applyInOrder also checks each step)
    expectSaneGeometry(entities, `seed ${seed}`);
    // 2. and the surviving set actually solves — a sketch must never be left in
    //    a state where nothing further can be applied
    const final = await compileAndSolve(entities, kept);
    expect(final.conflicts, `seed ${seed}: surviving constraints do not solve`).toEqual([]);
  });
});
