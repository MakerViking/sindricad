// Break keeps the constraints that still apply to the two halves.
//
// Integration check 4b: before Break the sketch carried [horizontal A,
// coincident {A end, B start}, vertical B]. After Break of B only [horizontal A]
// was left, with no word about it, and moving A's end then left a 3 mm gap at a
// join the user had snapped. breakAt gives both halves new ids, and the prune
// that follows every modify deleted whatever named the old one. Trim had the
// same defect once and got remapTrimmed; Break now goes through it too.
//
// Driven where the user enters: Break armed, a press on the curve, through the
// real onPointerDown and the real solve pump (liveSketch). The join is checked
// the way a drag cannot fake (see snapCoincidentGesture.test.ts): DISPLACE one
// side in the model and solve, with a control solve without the constraints.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));

import { liveSketch } from "./liveSketch.testkit";
import { compileAndSolve } from "./sketchSolve";
import { isOriginGeometry } from "./origin";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type Line = Extract<ResolvedEntity, { type: "line" }>;
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });
const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

beforeEach(() => { toasts.length = 0; });

/** A's end joined to B's start, the corner the user snapped, then B broken at (-20, 25). */
async function brokenCorner(extra: SketchConstraint[] = []) {
  const live = liveSketch([line("A", -40, 10, -20, 10), line("B", -20, 10, -20, 40)], [
    { type: "horizontal", line: "A" },
    { type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 },
    { type: "vertical", line: "B" },
    ...extra,
  ]);
  live.s.tool = "break";
  live.click(-20, 25);
  await live.settle();
  const lines = live.s.entities.filter((e): e is Line => e.type === "line" && !isOriginGeometry(e.id));
  const lower = lines.find((l) => l.y1 === 10 && l.x1 === -20);
  const upper = lines.find((l) => l.y2 === 40);
  return { live, lower, upper };
}

describe("Break carries the broken curve's constraints onto its halves", () => {
  it("keeps the snapped join on the half that has that end, and the vertical on both halves", async () => {
    const { live, lower, upper } = await brokenCorner();
    expect(lower, "no lower half from (-20,10)").toBeDefined();
    expect(upper, "no upper half to (-20,40)").toBeDefined();
    expect(live.s.constraints).toEqual([
      { type: "horizontal", line: "A" },
      { type: "coincident", e1: "A", p1: 1, e2: lower!.id, p2: 0 },
      { type: "vertical", line: lower!.id },
      { type: "vertical", line: upper!.id },
    ]);
    // nothing was lost, so nothing is reported lost
    expect(toasts).toEqual([t("sketch.modify.breakJoined")]);
  });

  it("the join still HOLDS: moving A's end pulls the lower half's start with it", async () => {
    const { live, lower } = await brokenCorner();
    const moved = live.s.entities.map((e) => (e.id === "A" ? { ...e, x2: -23, y2: 12 } as ResolvedEntity : e));
    const quiet = console.log; // planegcs narrates every solve
    console.log = () => {};
    try {
      const fixed = await compileAndSolve(moved, live.s.constraints);
      const control = await compileAndSolve(moved, []);
      const endOf = (es: ResolvedEntity[], id: string) => { const l = es.find((e) => e.id === id) as Line; return { x: l.x2, y: l.y2 }; };
      const startOf = (es: ResolvedEntity[], id: string) => { const l = es.find((e) => e.id === id) as Line; return { x: l.x1, y: l.y1 }; };
      expect(fixed.ok).toBe(true);
      expect(gap(endOf(fixed.entities, "A"), startOf(fixed.entities, lower!.id)), "the snapped join opened").toBeLessThan(1e-6);
      expect(gap(endOf(control.entities, "A"), startOf(control.entities, lower!.id)),
        "the control closed the gap too: this oracle measures nothing").toBeGreaterThan(1);
    } finally {
      console.log = quiet;
    }
  });

  it("drops a length that no half can keep, and SAYS so", async () => {
    const { live, lower, upper } = await brokenCorner([{ type: "distance", line: "B", value: 30 }]);
    expect(live.s.constraints.some((c) => c.type === "distance"), "a 30 mm length was left on a 15 mm half").toBe(false);
    expect(live.s.constraints).toContainEqual({ type: "vertical", line: lower!.id });
    expect(live.s.constraints).toContainEqual({ type: "vertical", line: upper!.id });
    expect(toasts).toEqual([t("sketch.modify.breakJoined"), t("sketch.modify.breakDropped", { count: 1 })]);
  });

  it("is one undo step, and undo brings the original curve and its constraints back", async () => {
    const { live } = await brokenCorner();
    live.s.undoEdit();
    await live.settle();
    expect(live.s.entities.find((e) => e.id === "B")).toMatchObject({ x1: -20, y1: 10, x2: -20, y2: 40 });
    expect(live.s.constraints).toEqual([
      { type: "horizontal", line: "A" },
      { type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 },
      { type: "vertical", line: "B" },
    ]);
  });
});
