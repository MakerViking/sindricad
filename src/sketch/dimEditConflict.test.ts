// Editing a dimension that the sketch cannot satisfy must leave the sketch as it
// was, not red. Report 886da4e5 (2026-09-05, v0.1.211):
//
//   "a circle is constrained by tangents inside a rectangle, the rectangle has
//    it's corners fixed with the "fix" constraint, I then fix the circle centre
//    with the Fix constraint... then I try to edit the circle diameter... it
//    turned all the sketch element lines red... did not give any warning"
//
// The two tangencies to the FIXED rectangle plus the diameter already determine
// the circle's x, y and r, so it slides along the corner bisector as the
// diameter changes. Fixing the centre is consistent while the diameter keeps its
// value (planegcs reports it as merely redundant, which is why the Fix was
// accepted in silence) and unsatisfiable the instant the value moves at all.
//
// Every constraint edit already goes on trial and is withdrawn if its solve
// conflicts (constraintSequences.test.ts). A DIMENSION edit was the one path
// that did not, so the unsatisfiable diameter stayed in the sketch — every
// active curve painted CONFLICT red, no message, and finish() would have
// committed it. This drives the real solver over the reporter's geometry and
// asserts the END state: the diameter is back at 30, the sketch solves clean,
// and the refusal says why.

// no @types/node here (tsconfig types is ["vite/client"]) — same local
// declaration sketchSolve.test.ts uses to reach the real wasm on disk
import { describe, it, expect, vi } from "vitest";
declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
import { compileAndSolve, constraintIndexOf } from "./sketchSolve";
import { dimConflictMsg, withdrawTrial, type SketchTrial } from "./dimConflict";
import { drivingDimFor, upsertDrivingDim } from "./directDims";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

/** The reporter's sketch, from bug-reports/docs/886da4e5.json (inlined: the
 *  bug-reports tree is local-only and is not in the repo). e18 is the small
 *  rectangle whose corners are Fixed; e17 is the circle tangent to two of its
 *  edges; e11 is a second, still-loose rectangle — it is why the sketch keeps
 *  3 DOF throughout, so "is the sketch fully constrained" is NOT available as a
 *  test for this refusal. */
const entities = (): ResolvedEntity[] => [
  { type: "rectangle", id: "e11", x: -7.649130461954812, y: 27.027137507924373, width: 86.88949115816148, height: 86.88949115816148 } as ResolvedEntity,
  { type: "circle", id: "e17", x: 74.69540203063235, y: -20.462819640218413, radius: 15 } as ResolvedEntity,
  { type: "rectangle", id: "e18", x: 89.69540203063235, y: -10.462819640218406, width: 60, height: 50 } as ResolvedEntity,
];

/** The sketch's constraints as saved. */
const asSaved = (): SketchConstraint[] => [
  { type: "p2pDistance", id: "c14", e1: "e11", p1: 3, e2: "e11", p2: 0, value: 50, driven: true },
  { type: "p2pDistance", id: "c15", e1: "e11", p1: 0, e2: "e11", p2: 1, value: 100, driven: true },
  { type: "equal", l1: "e11~3", l2: "e11~0" },
  { type: "fix", e: "e18", p: 3 },
  { type: "fix", e: "e18", p: 0 },
  { type: "fix", e: "e18", p: 1 },
  { type: "tangent2", a: "e17", b: "e18~0" },
  { type: "tangent2", a: "e17", b: "e18~3" },
  { type: "diameter", id: "c20", circle: "e17", value: 30 },
] as SketchConstraint[];

/** Fix on the circle's CENTRE — p 0 is the centre for a circle (dimRefPoints). */
const CENTRE_FIX = { type: "fix", e: "e17", p: 0 } as SketchConstraint;

const blamedOf = (conflicts: string[]) => {
  const s = new Set<number>();
  for (const id of conflicts) {
    const i = constraintIndexOf(id);
    if (i !== null) s.add(i);
  }
  return s;
};

const circleOf = (ents: ResolvedEntity[]) =>
  ents.find((e) => e.id === "e17") as Extract<ResolvedEntity, { type: "circle" }>;

/** One diameter edit, run the way SketchMode runs it: replace the entity's
 *  driving dimension, solve, and if that solve conflicts withdraw the trial and
 *  re-solve the restored list. The withdraw rule and the wording are the real
 *  shipped ones (dimConflict.ts); only the pump's plumbing is inlined here,
 *  because no unit test can construct a SketchMode. */
async function editDiameter(start: ResolvedEntity[], before: SketchConstraint[], mm: number) {
  const dim = drivingDimFor({ type: "circle", id: "e17" }, "diameter", mm)!;
  const after = upsertDrivingDim(before, dim);
  const edited = after[after.length - 1]!;
  const prev = before.find((c) => c.type === "diameter") as { value: number } | undefined;
  const trial: SketchTrial = {
    cons: [edited],
    restore: before,
    msg: (blamed, cons) => dimConflictMsg(edited, blamed, cons, prev?.value),
  };

  const r = await compileAndSolve(start, after);
  if (r.ok && r.conflicts.length === 0) {
    return { refused: false as const, entities: r.entities, constraints: after, msg: "" };
  }
  const w = withdrawTrial(after, trial, blamedOf(r.conflicts));
  const back = await compileAndSolve(start, w.constraints);
  return { refused: true as const, entities: back.entities, constraints: w.constraints, msg: w.msg, back };
}

describe("editing the diameter of a circle that cannot change size (886da4e5)", () => {
  it("leaves the sketch solvable and the circle where it was, and says why", async () => {
    const start = entities();
    const before = [...asSaved(), CENTRE_FIX];

    // precondition: the sketch as the reporter left it solves cleanly
    const pre = await compileAndSolve(start, before);
    expect(pre.ok, "the reporter's sketch solves before the edit").toBe(true);
    expect(pre.conflicts).toEqual([]);
    expect(circleOf(pre.entities).radius).toBeCloseTo(15, 3);

    const res = await editDiameter(start, before, 40);
    expect(res.refused, "30 -> 40 is unsatisfiable here and must be refused").toBe(true);

    // THE POINT OF THE FILE: the sketch is not left red.
    expect(res.back!.ok, "the sketch must solve again after the refusal").toBe(true);
    expect(res.back!.conflicts, "no curve may be left painted CONFLICT").toEqual([]);

    // and the circle is exactly as it was, with its 30 mm dimension intact
    const c = circleOf(res.entities);
    expect(c.radius).toBeCloseTo(15, 3);
    expect(c.x).toBeCloseTo(74.695, 3);
    expect(c.y).toBeCloseTo(-20.463, 3);
    const dim = res.constraints.find((k) => k.type === "diameter") as { value: number } | undefined;
    expect(dim?.value, "the dimension the user replaced must come back").toBe(30);

    // the refusal names why, rather than leaving red geometry to explain itself
    expect(res.msg).toContain("its centre is fixed");
    expect(res.msg).toContain("Tangent");
    expect(res.msg).toContain("30 mm");
  });

  it("refuses even the smallest change to that diameter", async () => {
    const start = entities();
    const before = [...asSaved(), CENTRE_FIX];
    const res = await editDiameter(start, before, 30.5);
    expect(res.refused, "30 -> 30.5 conflicts identically: it is the MOVE that is impossible").toBe(true);
    expect(circleOf(res.entities).radius).toBeCloseTo(15, 3);
  });

  it("still applies the same edit when the centre is not fixed", async () => {
    // CONTROL. Without this a fix that refuses every dimension edit would pass
    // the tests above: this is the normal, working behaviour the refusal must
    // not swallow.
    const start = entities();
    const res = await editDiameter(start, asSaved(), 40);
    expect(res.refused, "with the centre free the circle simply grows").toBe(false);
    const c = circleOf(res.entities);
    expect(c.radius).toBeCloseTo(20, 3);
    expect(c.x).toBeCloseTo(79.695, 3);
    expect(c.y).toBeCloseTo(-15.463, 3);
  });

  it("lets a LATER edit work after a refused one", async () => {
    // the pathology the trial mechanism exists for: an unsatisfiable constraint
    // left resident makes every later operation silently do nothing
    const start = entities();
    const refused = await editDiameter(start, [...asSaved(), CENTRE_FIX], 40);
    expect(refused.refused).toBe(true);
    // drop the Fix (as the user would) and re-dimension: this must now work
    const freed = refused.constraints.filter((c) => !(c.type === "fix" && c.e === "e17"));
    const res = await editDiameter(start, freed, 40);
    expect(res.refused, "with the Fix removed the same edit must apply").toBe(false);
    expect(circleOf(res.entities).radius).toBeCloseTo(20, 3);
  });
});
