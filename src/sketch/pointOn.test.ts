// A point ON a line, circle or arc: the `pointOn` constraint (TA 38391076,
// Doug 21: "A point can't be coincident with a line").
//
// The click flow is pinned in constraintTools.test.ts and the geometric meaning
// of each form, through the real tool and the real solver, in
// constraintSemantics.test.ts. This file holds what neither of those can see:
// the semantics that are a CHOICE (an infinite line, a whole circle), the
// cases the compile has to leave out or classify, the rigid shapes' sides, the
// glyph, the selection menu, and the gestures around the origin.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import { compileAndSolve } from "./sketchSolve";
import { constraintGlyphs } from "./glyphs";
import { applicableConstraints } from "./constraintMenu";
import { lineOperand } from "./entityDims";
import { liveSketch, PX } from "./liveSketch.testkit";
import { ORIGIN_ID, ORIGIN_X_ID, originGeometry } from "./origin";
import { contextMenu, type CtxItem } from "../ui/menu";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const L = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });
const PT = (id: string, x: number, y: number): ResolvedEntity => ({ type: "point", id, x, y });
const HEX = (id = "H"): ResolvedEntity => ({ type: "polygon", id, x: 0, y: 0, radius: 10, sides: 6, angle: 0 });
const on = (e: string, curve: string, p = 0): SketchConstraint => ({ type: "pointOn", e, p, curve });
const pos = (ents: ResolvedEntity[], id: string) => {
  const e = ents.find((x) => x.id === id);
  if (e?.type !== "point") throw new Error(`no point ${id}`);
  return { x: e.x, y: e.y };
};
/** distance from q to the INFINITE line through the operand `line` */
const offLine = (ents: ResolvedEntity[], q: { x: number; y: number }, line: string) => {
  const s = lineOperand(new Map(ents.map((e) => [e.id, e])), line)!;
  const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  return Math.abs((q.x - s.x1) * (s.y2 - s.y1) - (q.y - s.y1) * (s.x2 - s.x1)) / len;
};

describe("what the solver makes of it", () => {
  it("a line is INFINITE: the point lands past the segment's end, and can still slide", async () => {
    const ents = [L("A", 0, 0, 40, 0), PT("P", 60, 12)];
    const free = await compileAndSolve(ents, []);
    // the point is the mover, as the tool and the menu both name it
    const r = await compileAndSolve(ents, [on("P", "A")], undefined, { moves: ["P"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const p = pos(r.entities, "P");
    expect(Math.abs(p.y)).toBeLessThan(1e-9);
    expect(p.x, "held on the extension, not dragged back onto the drawn segment").toBeGreaterThan(40);
    expect(r.dof, "one equation: the point keeps its slide along the line").toBe(free.dof - 1);
  });

  it("an arc is its WHOLE circle: the point may land off the drawn sweep", async () => {
    // a quarter arc about the origin, r 20, in the first quadrant; the point
    // starts in the third
    const s = Math.SQRT1_2 * 20;
    const ents: ResolvedEntity[] = [
      { type: "arc", id: "A", x1: 20, y1: 0, x2: 0, y2: 20, mx: s, my: s },
      PT("P", -30, -10),
    ];
    const r = await compileAndSolve(ents, [on("P", "A")], undefined, { moves: ["P"] });
    expect(r.conflicts).toEqual([]);
    const p = pos(r.entities, "P");
    const arc = r.entities.find((e) => e.id === "A") as Extract<ResolvedEntity, { type: "arc" }>;
    expect(Math.hypot(arc.x1, arc.y1), "the arc kept its radius").toBeCloseTo(20, 6);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(20, 6);
    expect(p.x < 0 && p.y < 0, `landed at ${p.x},${p.y}: on the circle, nowhere near the sweep`).toBe(true);
  });

  it("a point already merged onto the curve's own end compiles nothing, so nothing turns amber", async () => {
    // B starts exactly where A ends: one solver point. Putting B's start "on" A
    // is true by construction, and handing planegcs the equation anyway is what
    // it reports as redundant.
    const ents = [L("A", 0, 0, 40, 0), L("B", 40, 0, 40, 30)];
    const free = await compileAndSolve(ents, []);
    const r = await compileAndSolve(ents, [on("B", "A")]);
    expect(r.ok).toBe(true);
    expect(r.overDefined).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.dof).toBe(free.dof);
  });

  it("two FIXED operands are judged by hand: amber when it holds, red when it cannot", async () => {
    // the origin and a projected circle are both pinned, so planegcs never sees
    // the equation (Mimir m:JKYS6Y) and the compile has to classify it
    const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
    const ring = (r: number): ResolvedEntity => ({ type: "projected", id: "K", source: SRC, curve: { kind: "circle", x: 10, y: 0, r } });
    const through = await compileAndSolve([...originGeometry(), ring(10)], [on(ORIGIN_ID, "K")]);
    expect(through.overDefined).toContain("k0");
    expect(through.conflicts).toEqual([]);
    const past = await compileAndSolve([...originGeometry(), ring(5)], [on(ORIGIN_ID, "K")]);
    expect(past.conflicts).toContain("k0");
  });
});

// A polygon or slot comes into the solver once a constraint names it
// (shapeOperands.test.ts has the rest), so a side is a line of the shape, and
// the shape can move to the point as well as the point to it: the tool names
// the point as the mover, which is what holds the shape still.
describe("a point on a polygon or slot side", () => {
  it("the point comes to the side, and the polygon stays exactly as drawn", async () => {
    const ents = [HEX(), PT("P", 30, 4)];
    const r = await compileAndSolve(ents, [on("P", "H~0")], undefined, { moves: ["P"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    // The polygon is written back digit for digit (kept()), so P was solved
    // against a hexagon a few 1e-9 away from the one it is checked against:
    // CI's Node measured 4e-9 here. 1e-7 is the kernel's own Precision::Confusion.
    expect(offLine(r.entities, pos(r.entities, "P"), "H~0")).toBeLessThan(1e-7);
    expect(r.entities.find((e) => e.id === "H"), "every number kept, digit for digit").toEqual(HEX());
  });

  it("a slot's sides lie half its width out from the axis", async () => {
    const slot: ResolvedEntity = { type: "slot", id: "S", x1: 0, y1: 0, x2: 20, y2: 0, width: 6 };
    const r = await compileAndSolve([slot, PT("P", 10, 9), PT("Q", 4, -12)], [on("P", "S~0"), on("Q", "S~1")], undefined, { moves: ["P", "Q"] });
    expect(r.conflicts).toEqual([]);
    expect(pos(r.entities, "P").y).toBeCloseTo(3, 9);
    expect(pos(r.entities, "Q").y).toBeCloseTo(-3, 9);
    expect(r.entities.find((e) => e.id === "S")).toEqual(slot);
  });

  it("a user end that sits on the polygon's corner is JOINED to it once the polygon is in the solver", async () => {
    // L starts on the hexagon's corner (10,0), the start of side 0, with no
    // constraint between them. Unnamed, the polygon is rigid and out of the
    // solver, so L's start drags alone. Named, the corner is a solver point
    // and merges by position, as a rectangle's corner always has: the drag
    // takes the corner with it, and the hexagon stays regular.
    const ents = [HEX(), L("L", 10, 0, 30, 20), PT("P", 30, 4)];
    const drag = { fromX: 10, fromY: 0, toX: 12, toY: -3 };
    for (const cons of [[], [on("P", "H~0")]]) {
      const r = await compileAndSolve(ents, cons, drag);
      expect(r.dragRefused, `refused with ${cons.length} pointOn`).toBeUndefined();
      const l = r.entities.find((e) => e.id === "L") as Extract<ResolvedEntity, { type: "line" }>;
      expect(l.x1).toBeCloseTo(12, 9);
      expect(l.y1).toBeCloseTo(-3, 9);
      const h = r.entities.find((e) => e.id === "H") as Extract<ResolvedEntity, { type: "polygon" }>;
      if (cons.length) expect(Math.hypot(h.x + h.radius * Math.cos((h.angle * Math.PI) / 180) - 12, h.y + h.radius * Math.sin((h.angle * Math.PI) / 180) + 3)).toBeLessThan(1e-6);
      else expect(h).toEqual(HEX());
    }
  });

  it("a side the polygon no longer has compiles to nothing rather than to a wrong side", async () => {
    const five: ResolvedEntity = { ...HEX(), sides: 5 } as ResolvedEntity;
    const r = await compileAndSolve([five, PT("P", 30, 4)], [on("P", "H~5")]);
    expect(r.ok).toBe(true);
    expect(pos(r.entities, "P")).toEqual({ x: 30, y: 4 });
  });
});

describe("its glyph", () => {
  it("sits on the POINT and reads ∈", () => {
    const g = constraintGlyphs([L("A", 0, 0, 40, 0), PT("P", 60, 0)], [on("P", "A")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.label).toBe("∈");
    expect([g[0]!.pos.x, g[0]!.pos.y]).toEqual([60, 0]);
  });

  it("still draws, so it can still be deleted, when the curve no longer resolves", () => {
    const g = constraintGlyphs([{ ...HEX(), sides: 5 } as ResolvedEntity, PT("P", 30, 4)], [on("P", "H~5")]);
    expect(g.map((x) => x.label)).toEqual(["∈"]);
  });
});

describe("the selection's right-click menu", () => {
  const line = L("l", 0, 0, 10, 0);
  const circle: ResolvedEntity = { type: "circle", id: "c", x: 0, y: 0, radius: 5 };
  const point = PT("p", 3, 3);

  it("offers Coincident for a sketch point and a line, circle or arc, in either order, and Midpoint on a line", () => {
    expect(applicableConstraints([point, line])).toEqual(["coincident", "midpoint"]);
    expect(applicableConstraints([line, point])).toEqual(["coincident", "midpoint"]);
    expect(applicableConstraints([point, circle])).toEqual(["coincident"]);
  });

  it("Fix for a point alone, Coincident for two, and nothing for a point and a rectangle nobody named a side of", () => {
    expect(applicableConstraints([point])).toEqual(["fix"]);
    expect(applicableConstraints([point, PT("q", 1, 1)])).toEqual(["coincident"]);
    expect(applicableConstraints([point, { type: "rectangle", id: "r", x: 0, y: 0, width: 4, height: 4 }])).toEqual([]);
  });

  it("Coincident from the menu puts the point on the line, through a real solve", async () => {
    const live = liveSketch([L("l", 0, 0, 40, 0), PT("p", 20, 9)]);
    live.s.selected = new Set(["l", "p"]);
    vi.mocked(contextMenu).mockClear();
    live.s.onContextMenu({ clientX: 20 * PX, clientY: 9 * PX, preventDefault() {} } as unknown as MouseEvent);
    const items = (vi.mocked(contextMenu).mock.calls[0]?.[2] ?? []) as CtxItem[];
    const item = items.find((i) => i.label === "Coincident");
    expect(item, `menu offered: ${items.map((i) => i.label).join(", ")}`).toBeDefined();
    item!.onClick?.();
    await live.settle();
    expect(live.s.constraints).toEqual([on("p", "l")]);
    const p = live.ent("p") as Extract<ResolvedEntity, { type: "point" }>;
    expect(Math.abs(p.y)).toBeLessThan(1e-9);
    expect((live.ent("l") as Extract<ResolvedEntity, { type: "line" }>).y1, "the point moved, not the line").toBe(0);
  });
});

describe("the origin stays pickable", () => {
  beforeEach(() => vi.mocked(contextMenu).mockClear());

  it("a Move whose selection includes the origin leaves the origin at 0,0, and Coincident still finds it there", async () => {
    const live = liveSketch([L("l", 5, 10, 25, 10)]);
    live.s.selected = new Set([ORIGIN_ID, ORIGIN_X_ID, "l"]);
    live.s.tool = "move";
    live.click(5, 10); // base point
    live.click(15, 20); // destination
    await live.settle();
    expect(live.ent("l")).toMatchObject({ x1: 15, y1: 20, x2: 35, y2: 20 });
    expect(live.ent(ORIGIN_ID)).toMatchObject({ x: 0, y: 0 });
    expect(live.ent(ORIGIN_X_ID)).toMatchObject({ y1: 0, y2: 0 });

    // and the reporter's next step works: the origin as the first pick
    live.s.tool = "coincident";
    live.click(0, 0);
    expect(live.held()).toEqual([{ x: 0, y: 0 }]);
    live.click(25, 20); // the line's middle
    expect(live.s.constraints).toEqual([on(ORIGIN_ID, "l")]);
    live.s.requestSolve();
    await live.settle();
    const l = live.ent("l") as Extract<ResolvedEntity, { type: "line" }>;
    expect(offLine([l], { x: 0, y: 0 }, "l"), "the line now runs through the origin").toBeLessThan(1e-9);
    expect(live.ent(ORIGIN_ID)).toMatchObject({ x: 0, y: 0 });
  });
});
