// A tangency is to the SEGMENT the user drew, not to the infinite line it lies
// on. planegcs's `tangent_lc` only knows the infinite line, so a solve is free
// to hand back the MIRRORED root — the circle on the far side of the edge,
// touching the edge's extension somewhere past its end — and report it as
// perfectly satisfied (residual 0, ok:true, conflicts:[]).
//
// Field report 043773a0: a 30 mm circle held in the corner of a rigid 60x50 box
// by two tangents (bottom edge and left edge) jumped 30 mm straight down —
// mirrored across the bottom edge's line — the moment a `concentric` was applied
// with the OTHER circle picked first. It stayed tangent to the bottom edge, and
// "tangent" to the left edge 15 mm below the left edge's lower end.
//
// THE TRAP in this fixture, and the reason it is spelled out this way: the
// entity list must be `originGeometry()` ++ the sketch's own entities, exactly
// as sketchMode builds it (sketchMode.ts:502,517). Without the origin point and
// axes in the model BOTH pick orders answer correctly and this test is green
// against the unfixed code.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve, TANGENT_SPAN_MSG } from "./sketchSolve";
import { resolveRealEntities } from "./resolve";
import { originGeometry } from "./origin";
import { lineOperand } from "./entityDims";
import type { Feature, SketchConstraint } from "../types";
import type { ResolvedEntity } from "./snap";

// The reporter's sketch, from bug-reports/docs/043773a0.json (inlined: that
// directory is gitignored and never ships).
const CONSTRAINTS = [
  { id: "c14", type: "p2pDistance", e1: "e11", e2: "e11", p1: 3, p2: 0, value: 50, driven: true },
  { id: "c15", type: "p2pDistance", e1: "e11", e2: "e11", p1: 0, p2: 1, value: 100, driven: true },
  { type: "equal", l1: "e11~3", l2: "e11~0" },
  { type: "fix", e: "e18", p: 3 },
  { type: "fix", e: "e18", p: 0 },
  { type: "fix", e: "e18", p: 1 },
  { type: "tangent2", a: "e17", b: "e18~0" }, // bottom edge
  { type: "tangent2", a: "e17", b: "e18~3" }, // left edge
  { id: "c20", type: "diameter", circle: "e17", value: 30 },
  { id: "c22", type: "p2pDistance", e1: "e11", e2: "e11", p1: 2, p2: 3, value: 100 },
  { id: "c26", type: "diameter", circle: "e23", value: 50 },
] as unknown as SketchConstraint[];

const SKETCH = {
  id: "f1",
  type: "sketch",
  plane: "XY",
  entities: [
    { id: "e11", type: "rectangle", x: -19.57407247395088, y: -10.397516787731846, width: 100, height: 100 },
    { id: "e17", type: "circle", x: 74.69540203063235, y: -20.462819640218413, radius: 15 },
    { id: "e18", type: "rectangle", x: 89.69540203063235, y: -10.462819640218406, width: 60, height: 50 },
    { id: "e23", type: "circle", x: 179.52591875515432, y: -45.63116726170206, radius: 25 },
  ],
  constraints: CONSTRAINTS,
} as unknown as Extract<Feature, { type: "sketch" }>;

const baseEntities = (): ResolvedEntity[] => [...originGeometry(), ...resolveRealEntities(SKETCH, {})];

/** Foot-of-perpendicular parameter of `c` on the segment `lineId`: 0 at its
 *  start, 1 at its end. Outside [0,1] the tangency touches the extension, not
 *  the edge — which is exactly what the reporter saw. */
function touchParam(ents: ResolvedEntity[], lineId: string, circleId: string): number {
  const seg = lineOperand(new Map(ents.map((e) => [e.id, e])), lineId);
  const c = ents.find((e) => e.id === circleId);
  if (!seg || c?.type !== "circle") throw new Error(`missing operand ${lineId}/${circleId}`);
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  return ((c.x - seg.x1) * dx + (c.y - seg.y1) * dy) / (dx * dx + dy * dy);
}

/** Perpendicular distance from the circle's centre to the line, minus its
 *  radius — 0 when the tangency itself is satisfied. */
function tangentResidual(ents: ResolvedEntity[], lineId: string, circleId: string): number {
  const seg = lineOperand(new Map(ents.map((e) => [e.id, e])), lineId);
  const c = ents.find((e) => e.id === circleId);
  if (!seg || c?.type !== "circle") throw new Error(`missing operand ${lineId}/${circleId}`);
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs((c.x - seg.x1) * dy - (c.y - seg.y1) * dx) / len - c.radius;
}

const CIRCLE30 = { x: 74.69540203063235, y: -20.462819640218413 };

describe("tangency holds against the segment, not its extension (043773a0)", () => {
  it("30 mm circle picked first: it stays in the corner of the box", async () => {
    const concentric: SketchConstraint = { type: "concentric", c1: "e17", c2: "e23" };
    const r = await compileAndSolve(
      baseEntities(),
      [...CONSTRAINTS, concentric],
      undefined,
      { moves: ["e17"] },
    );
    expect(r.conflicts).toEqual([]);
    const c = r.entities.find((e) => e.id === "e17");
    if (c?.type !== "circle") throw new Error("circle lost");
    expect(c.x).toBeCloseTo(CIRCLE30.x, 6);
    expect(c.y).toBeCloseTo(CIRCLE30.y, 6);
    // and the 50 mm circle came to it
    const other = r.entities.find((e) => e.id === "e23");
    if (other?.type !== "circle") throw new Error("circle lost");
    expect(other.x).toBeCloseTo(CIRCLE30.x, 6);
    expect(other.y).toBeCloseTo(CIRCLE30.y, 6);
  });

  it("50 mm circle picked first: the 30 mm circle does not flip outside the box", async () => {
    const concentric: SketchConstraint = { type: "concentric", c1: "e23", c2: "e17" };
    const r = await compileAndSolve(
      baseEntities(),
      [...CONSTRAINTS, concentric],
      undefined,
      { moves: ["e23"] },
    );
    expect(r.conflicts).toEqual([]);
    const c = r.entities.find((e) => e.id === "e17");
    if (c?.type !== "circle") throw new Error("circle lost");
    // The 30 mm circle is tangent to a box whose corners are all `fix`ed: there
    // is nothing for it to pay with, so it must not move at all. Before the fix
    // it landed at y = -50.463, mirrored across the bottom edge.
    expect(c.x).toBeCloseTo(CIRCLE30.x, 6);
    expect(c.y).toBeCloseTo(CIRCLE30.y, 6);
    // ...and both touch points are ON their edges, not past an end.
    for (const edge of ["e18~0", "e18~3"]) {
      expect(tangentResidual(r.entities, edge, "e17")).toBeCloseTo(0, 6);
      const t = touchParam(r.entities, edge, "e17");
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
    // The constraint the user asked for still happened: the 50 mm circle is the
    // one that moved, onto the 30 mm circle's centre.
    const other = r.entities.find((e) => e.id === "e23");
    if (other?.type !== "circle") throw new Error("circle lost");
    expect(other.x).toBeCloseTo(CIRCLE30.x, 6);
    expect(other.y).toBeCloseTo(CIRCLE30.y, 6);
  });

  it("refuses, with its own reason, when nothing keeps the touch point on the edge", async () => {
    // Same rigid box and the same bottom-edge tangency, plus a horizontal
    // distance that drags the circle's centre 200 mm left of the box: every
    // solution that satisfies both touches the bottom edge's EXTENSION.
    // Nothing here contradicts anything, so the generic "that conflicts with
    // the ones already on this sketch" would be a lie.
    const pull = {
      type: "p2pDistanceX", e1: "e18", p1: 0, e2: "e17", p2: 0, value: -200,
    } as unknown as SketchConstraint;
    const cons = CONSTRAINTS.filter((c) => !("b" in c && c.b === "e18~3"));
    const r = await compileAndSolve(baseEntities(), [...cons, pull], undefined, { moves: ["e17"] });
    expect(r.ok).toBe(false);
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.reason).toBe(TANGENT_SPAN_MSG);
    // ...and the document is left exactly as it was, not written with the
    // circle out on the extension.
    const c = r.entities.find((e) => e.id === "e17");
    if (c?.type !== "circle") throw new Error("circle lost");
    expect(c.x).toBeCloseTo(CIRCLE30.x, 6);
    expect(c.y).toBeCloseTo(CIRCLE30.y, 6);
  });
});
