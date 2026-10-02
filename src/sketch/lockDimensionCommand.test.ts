// Constraints > Lock Dimension.
//
// Report d3338e3a: "I think 'lock dimension' should possibly be in the
// 'constraints' dropdown as well or as a tool... keep it on the right click as
// well but it is such an important constraint it should be obvious." Lock had
// shipped the day before, on a measured badge's right-click only.
//
// It is the badge's own Lock, sized to a selection: every MEASURED badge on the
// chosen geometry becomes the driving constraint that holds what it reads now,
// spelled exactly the way the badge's Lock spells it (lockDimFor, whose holding
// power lockDimension.test.ts already measures against the real solver). So
// these tests pin WHAT it creates and WHEN, entering where the user does: the
// command the ribbon leaf runs, the armed tool's click, the right-click menu.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import { liveSketch, PX } from "./liveSketch.testkit";
import { governingDimAt, lockDimFor } from "./directDims";
import { compileAndSolve } from "./sketchSolve";
import { toast } from "../ui/toast";
import { contextMenu, type CtxItem } from "../ui/menu";
import { SKETCH, leavesOf } from "../ui/ribbon";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import sketchModeSrc from "./sketchMode.ts?raw";

const rect = (): ResolvedEntity => ({ type: "rectangle", id: "e0", x: 30, y: 20, width: 60, height: 40 });
const circle = (): ResolvedEntity => ({ type: "circle", id: "e1", x: 120, y: 20, radius: 10 });

/** the constraints a lock added, without the ids it stamped on them */
const added = (cons: SketchConstraint[], from: number) =>
  cons.slice(from).map((c) => {
    const { id: _id, ...rest } = c as SketchConstraint & { id?: string };
    return rest;
  });

const toasts = () => vi.mocked(toast).mock.calls.map((c) => c[0]);

describe("Lock Dimension on a selection (d3338e3a)", () => {
  beforeEach(() => vi.mocked(toast).mockClear());

  it("locks a selected rectangle's W and H at what they measure, as one undo step", async () => {
    const live = liveSketch([rect()]);
    live.click(30, 0); // the bottom edge selects the rectangle
    expect([...live.s.selected]).toEqual(["e0"]);
    const depth = live.s.history.depth;
    live.s.lockDimensionCommand();
    await live.settle();
    // the same constraints the badges' own right-click Lock would have made
    expect(added(live.s.constraints, 0)).toEqual([lockDimFor(rect(), "width", 60), lockDimFor(rect(), "height", 40)]);
    expect(governingDimAt(live.s.constraints, live.ent("e0")!, "width")).toBeTypeOf("number");
    expect(governingDimAt(live.s.constraints, live.ent("e0")!, "height")).toBeTypeOf("number");
    expect(live.s.history.depth).toBe(depth + 1);
    expect(toasts()).toEqual(["Locked 2 dimensions at their current values"]);
    // ...and they stay in the sketch: nothing about them conflicts, so the
    // solve kept them and left the rectangle the size it was
    const r = await compileAndSolve(live.s.entities, live.s.constraints);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const e0 = live.ent("e0") as Extract<ResolvedEntity, { type: "rectangle" }>;
    expect(e0.width).toBeCloseTo(60, 6);
    expect(e0.height).toBeCloseTo(40, 6);
  });

  it("locks every selected entity at once, and keeps the selection", async () => {
    const live = liveSketch([rect(), circle()]);
    live.click(30, 0);
    live.click(130, 20, true); // the circle's rim
    live.s.lockDimensionCommand();
    await live.settle();
    expect(added(live.s.constraints, 0)).toHaveLength(3);
    expect(added(live.s.constraints, 0)).toContainEqual({ type: "diameter", circle: "e1", value: 20 });
    expect([...live.s.selected].sort()).toEqual(["e0", "e1"]);
  });

  it("a second Lock finds nothing left to lock, and says so instead of doing nothing", async () => {
    const live = liveSketch([rect()]);
    live.click(30, 0);
    live.s.lockDimensionCommand();
    await live.settle();
    const n = live.s.constraints.length;
    live.s.lockDimensionCommand();
    await live.settle();
    expect(live.s.constraints).toHaveLength(n);
    expect(toasts().at(-1)).toMatch(/^Nothing to lock/);
  });
});

// The commonest hand-drawn shape: four lines closed into a rectangle, with the
// horizontal/vertical the Line tool adds on its own. Its far sides' lengths
// follow from the near sides', so a lock on all four over-defines it twice.
const handRect = (): { ents: ResolvedEntity[]; cons: SketchConstraint[] } => ({
  ents: [
    { type: "line", id: "e0", x1: 10, y1: 10, x2: 70, y2: 10 },
    { type: "line", id: "e1", x1: 70, y1: 10, x2: 70, y2: 50 },
    { type: "line", id: "e2", x1: 70, y1: 50, x2: 10, y2: 50 },
    { type: "line", id: "e3", x1: 10, y1: 50, x2: 10, y2: 10 },
  ],
  cons: [
    { type: "horizontal", line: "e0" },
    { type: "vertical", line: "e1" },
    { type: "horizontal", line: "e2" },
    { type: "vertical", line: "e3" },
  ],
});

/** the lines whose length a lock now holds */
const lockedLines = (cons: SketchConstraint[]) =>
  cons.flatMap((c) => (c.type === "distance" && "line" in c ? [c.line] : [])).sort();

describe("Lock Dimension keeps only what is not already implied (d3338e3a)", () => {
  beforeEach(() => vi.mocked(toast).mockClear());

  it("a hand-drawn rectangle gets one width and one height, none of them amber, and the toast says two", async () => {
    const { ents, cons } = handRect();
    const live = liveSketch(ents, cons);
    for (const e of ents) live.s.selected.add(e.id);
    const depth = live.s.history.depth;
    live.s.lockDimensionCommand();
    await live.settle();
    // one lock per direction: the other two lengths follow from them
    const held = lockedLines(live.s.constraints);
    expect(held).toHaveLength(2);
    expect(held.filter((id) => id === "e0" || id === "e2"), "no width kept").toHaveLength(1);
    expect(held.filter((id) => id === "e1" || id === "e3"), "no height kept").toHaveLength(1);
    expect([...live.s.overIdx], "the sketch is painting a lock amber").toEqual([]);
    expect(toasts()).toEqual(["Locked 2 dimensions at their current values"]);
    expect(live.s.history.depth).toBe(depth + 1);
    // ...and nothing a lock was meant to hold was lost with the two it dropped
    const all = [...cons, ...ents.map((e) => lockDimFor(e, "length", e.type === "line" ? Math.hypot(e.x2 - e.x1, e.y2 - e.y1) : 0)!)];
    expect(lockedLines(all)).toEqual(["e0", "e1", "e2", "e3"]);
    const [kept, every] = await Promise.all([compileAndSolve(live.s.entities, live.s.constraints), compileAndSolve(ents, all)]);
    expect(kept.overDefined).toEqual([]);
    expect(kept.dof).toBe(every.dof);
  });

  it("drops redundant locks the solver only names one solve at a time (a parallelogram)", async () => {
    // Two parallel pairs close into a parallelogram, so opposite sides are
    // equal; planegcs names one of the two implied lengths per solve.
    const ents: ResolvedEntity[] = [
      { type: "line", id: "e0", x1: 10, y1: 10, x2: 70, y2: 10 },
      { type: "line", id: "e1", x1: 70, y1: 10, x2: 90, y2: 50 },
      { type: "line", id: "e2", x1: 90, y1: 50, x2: 30, y2: 50 },
      { type: "line", id: "e3", x1: 30, y1: 50, x2: 10, y2: 10 },
    ];
    const live = liveSketch(ents, [{ type: "parallel", l1: "e0", l2: "e2" }, { type: "parallel", l1: "e1", l2: "e3" }]);
    for (const e of ents) live.s.selected.add(e.id);
    live.s.lockDimensionCommand();
    await live.settle();
    expect(lockedLines(live.s.constraints)).toHaveLength(2);
    expect([...live.s.overIdx]).toEqual([]);
    expect(toasts()).toEqual(["Locked 2 dimensions at their current values"]);
  });

  it("locking the far side of a rectangle whose near side is locked adds nothing, and says so", async () => {
    const { ents, cons } = handRect();
    const live = liveSketch(ents, [...cons, lockDimFor(ents[0]!, "length", 60)!]);
    live.s.requestSolve();
    await live.settle();
    const before = [...live.s.constraints];
    live.click(40, 50); // the top line
    live.s.lockDimensionCommand();
    await live.settle();
    expect(live.s.constraints).toEqual(before);
    expect(toasts()).toEqual([expect.stringMatching(/^Nothing to lock/)]);
  });

  it("two armed clicks inside one solve are judged together, and counted together", async () => {
    // The second click lands while the first click's solve is still running.
    // Both locks get judged and the toast counts what survived of both, instead
    // of the first being dropped from the count.
    const { ents, cons } = handRect();
    const live = liveSketch(ents, cons);
    live.s.lockDimensionCommand();
    live.click(40, 10); // bottom
    live.click(40, 50); // top: implied by the bottom
    await live.settle();
    expect(lockedLines(live.s.constraints)).toEqual(["e0"]);
    expect(toasts()).toEqual(["Locked 1 dimension at its current value"]);
  });
});

describe("Lock Dimension with nothing selected arms a tool (d3338e3a)", () => {
  it("each entity clicked has its measured dimensions locked", async () => {
    const live = liveSketch([rect(), circle()]);
    live.s.lockDimensionCommand();
    expect(live.s.tool).toBe("lockDimension");
    live.click(130, 20);
    await live.settle();
    expect(added(live.s.constraints, 0)).toEqual([{ type: "diameter", circle: "e1", value: 20 }]);
    live.click(30, 0);
    await live.settle();
    expect(added(live.s.constraints, 0)).toHaveLength(3);
    expect(live.s.tool, "the tool stays armed for the next pick").toBe("lockDimension");
  });

  it("a click on empty canvas locks nothing", async () => {
    const live = liveSketch([rect()]);
    live.s.lockDimensionCommand();
    live.click(200, 200);
    await live.settle();
    expect(live.s.constraints).toEqual([]);
  });
});

describe("where Lock lives (d3338e3a)", () => {
  const menuAt = (live: ReturnType<typeof liveSketch>, x: number, y: number): CtxItem[] => {
    vi.mocked(contextMenu).mockClear();
    live.s.onContextMenu({ clientX: x * PX, clientY: y * PX, preventDefault() {} } as unknown as MouseEvent);
    return (vi.mocked(contextMenu).mock.calls[0]?.[2] ?? []) as CtxItem[];
  };

  it("in the Constraints dropdown of the sketch ribbon", () => {
    const group = SKETCH.find((g) => g.id === "CONSTRAINTS");
    const dropdown = group?.items.find((it) => "children" in it);
    expect(dropdown && leavesOf(dropdown).map((l) => l.action)).toContain("lockDimension");
  });

  it("on the selection's right-click while there is a measured dimension to lock, and not after", async () => {
    const live = liveSketch([rect()]);
    const lock = menuAt(live, 30, 0).find((i) => i.label === "Lock dimensions");
    expect(lock, "the right-click menu offers no Lock").toBeDefined();
    lock!.onClick?.();
    await live.settle();
    expect(added(live.s.constraints, 0)).toHaveLength(2);
    expect(menuAt(live, 30, 0).find((i) => i.label === "Lock dimensions")).toBeUndefined();
  });

  it("and still on a measured badge's own right-click, where it started", () => {
    const at = sketchModeSrc.indexOf("this.dims.onLabelMenu = (e, a) => {");
    expect(at).toBeGreaterThan(-1);
    expect(sketchModeSrc.slice(at, at + 1200)).toContain('t("sketch.dimension.lock")');
  });
});
