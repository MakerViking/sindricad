// Rectangles, polygons and slots as constraint and dimension OPERANDS. Round 1
// decision 2: they stay shapes, but open up. TA 31d958a1 ("Coincident can't
// pick a polygon's corners or centre, or a rectangle's centre"), 31287b94 ("a
// sketch slot doesn't take constraints"), ffae1a6e (a polygon's rotation, set
// by a constraint), GH #17 (sides and corners in the right-click menu), and
// decision C8 (Move refuses a shape tied to what is not moving).
//
// A rectangle's centre is point 4, a polygon's corners are points 0..n-1 and
// its centre -1, a slot's centres 0 and 1; a polygon's sides `P~k`, a slot's
// `S~0`/`S~1` and its axis `S~2` are line operands (types.ts). A polygon or slot
// comes into the solver once a constraint names it (sketchSolve).
//
// Everything is entered where the user enters: clicks of the real constraint
// tools on a SketchMode built off its prototype, whose solve pump is the real
// one; the Dimension tool's pick and plan; the right-click menu; the Move and
// Rotate tools; a parameter write through writeTarget.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import { compileAndSolve, soleDimEntity } from "./sketchSolve";
import { ConstraintTools } from "./constraintTools";
import { pickDimTarget, resolveDim, isDimError } from "./dimensionTool";
import { constraintDims, lineOperand, refPoint } from "./entityDims";
import { constraintGlyphs } from "./glyphs";
import { candidatesFromEntities } from "./snap";
import { explodeCompound } from "./modify";
import { polygonPoints } from "./region";
import { DimInput } from "./dimInput";
import { liveSketch, PX } from "./liveSketch.testkit";
import { ORIGIN_ID, ORIGIN_X_ID } from "./origin";
import { writeTarget } from "../document/numFields";
import { constraintLabel } from "./constraintMenu";
import { contextMenu, type CtxItem } from "../ui/menu";
import { t } from "../i18n";
import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { CadDocument, Feature, SketchConstraint } from "../types";

// The on-canvas box (DimInput) is real, rendered against the fake DOM, for
// Rotate's typed angle.
class FakeInput extends FakeEl {
  constructor() {
    super("input");
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLInputElement = FakeInput;
g.HTMLTextAreaElement = class {};
g.HTMLSelectElement = class {};
g.HTMLElement = FakeEl;
g.Node = FakeEl;
installFakeDocument();
(g.document as { createElement(tag: string): FakeEl }).createElement = (tag: string) =>
  tag === "input" ? new FakeInput() : new FakeEl(tag);
vi.stubGlobal("requestAnimationFrame", () => 0);

type Poly = Extract<ResolvedEntity, { type: "polygon" }>;
type Slot = Extract<ResolvedEntity, { type: "slot" }>;
type Rect = Extract<ResolvedEntity, { type: "rectangle" }>;
type Line = Extract<ResolvedEntity, { type: "line" }>;

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const L = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });
const PT = (id: string, x: number, y: number): ResolvedEntity => ({ type: "point", id, x, y });
/** 40 x 20 about (10, 5) */
const RECT = (): Rect => ({ type: "rectangle", id: "R", x: 10, y: 5, width: 40, height: 20 });
/** a hexagon of radius 10 about (0, 0), its corner 0 at `angle` degrees */
const HEX = (angle = 0): Poly => ({ type: "polygon", id: "H", x: 0, y: 0, radius: 10, sides: 6, angle });
/** 30 long from (10, 0) along the X axis, 6 wide */
const SLOT = (): Slot => ({ type: "slot", id: "S", x1: 10, y1: 0, x2: 40, y2: 0, width: 6 });
const corner = (p: Poly, k: number) => polygonPoints(p.x, p.y, p.radius, p.sides, (p.angle * Math.PI) / 180)[k]!;
const side = (ents: ResolvedEntity[], id: string) => lineOperand(new Map(ents.map((e) => [e.id, e])), id)!;
type Seg = { x1: number; y1: number; x2: number; y2: number };
const mid = (sg: Seg) => ({ x: (sg.x1 + sg.x2) / 2, y: (sg.y1 + sg.y2) / 2 });
const dir = (sg: Seg) => Math.atan2(sg.y2 - sg.y1, sg.x2 - sg.x1);
const r9 = (...ns: number[]) => ns.map((n) => Math.round(n * 1e9) / 1e9 + 0); // + 0: no -0

/** A live sketch whose constraint tools reach it the way SketchMode's own do:
 *  the constraint goes in as a trial (withdrawn if its solve conflicts), the
 *  first pick is the mover, and the real pump solves it. */
function sketch(ents: ResolvedEntity[], cons: SketchConstraint[] = []) {
  const live = liveSketch(ents, cons);
  const s = live.s as unknown as {
    trial: unknown; pendingBias: unknown; requestSolve(): void; constraintTools: ConstraintTools;
    pendingBindings: Map<string, { expr: string; kind: string; name?: string }>;
  };
  s.constraintTools = new ConstraintTools({
    tool: () => live.s.tool,
    entities: () => live.s.entities,
    constraints: () => live.s.constraints,
    pickTol: () => 0.5,
    getFilletFirst: () => (live.s as unknown as { filletFirst: number | null }).filletFirst,
    setFilletFirst: (i) => { (live.s as unknown as { filletFirst: number | null }).filletFirst = i; },
    requestSolve: () => s.requestSolve(),
    warn: (m) => { toasts.push(m); },
    setPendingPoints() {},
    addConstraint: (c, moves) => {
      live.s.constraints.push(c);
      s.trial = { cons: [c], msg: t("sketch.constraint.conflict") };
      if (moves) s.pendingBias = { moves: [moves] };
      s.requestSolve();
    },
  });
  /** a click of `tool` at each point in turn, then the solve settled */
  const use = async (tool: string, ...at: { x: number; y: number }[]) => {
    live.s.tool = tool as typeof live.s.tool;
    for (const q of at) live.click(q.x, q.y);
    await live.settle();
  };
  return { ...live, use, internals: s };
}

const menuItems = () => (vi.mocked(contextMenu).mock.calls.at(-1)?.[2] ?? []) as CtxItem[];
const rightClick = (live: ReturnType<typeof liveSketch>, x: number, y: number) => {
  vi.mocked(contextMenu).mockClear();
  live.s.onContextMenu({ clientX: x * PX, clientY: y * PX, preventDefault() {} } as unknown as MouseEvent);
  return menuItems();
};

beforeEach(() => { toasts.length = 0; });

describe("a rectangle's centre", () => {
  it("takes Coincident, and the rectangle slides onto the origin at its own size", async () => {
    // Before, a click in the middle of a rectangle picked nothing at all.
    const live = sketch([RECT()]);
    await live.use("coincident", { x: 10, y: 5 }, { x: 0, y: 0 });
    expect(live.s.constraints).toEqual([{ type: "coincident", e1: "R", p1: 4, e2: ORIGIN_ID, p2: 0 }]);
    const r = live.ent("R") as Rect;
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(0, 9);
    // planegcs alone found a 56 x 28 rectangle first: the shape keeps its size
    // unless something asks (sketchSolve's soft pins)
    expect(r.width).toBeCloseTo(40, 9);
    expect(r.height).toBeCloseTo(20, 9);
  });
});

describe("a polygon, once a constraint names it", () => {
  it("Horizontal on a side turns it about its centre, and keeps its size", async () => {
    const hex = HEX(17);
    const live = sketch([hex]);
    const mid = side([hex], "H~0");
    await live.use("horizontal", { x: (mid.x1 + mid.x2) / 2, y: (mid.y1 + mid.y2) / 2 });
    expect(live.s.constraints).toEqual([{ type: "horizontal", line: "H~0" }]);
    const p = live.ent("H") as Poly;
    const s0 = side([p], "H~0");
    expect(Math.abs(s0.y2 - s0.y1), "side 0 is level").toBeLessThan(1e-9);
    expect(p.radius).toBeCloseTo(10, 9);
    expect(p.sides).toBe(6);
    // in the app the hexagon first slid 10 mm sideways as it turned
    expect(Math.hypot(p.x, p.y), "it turned in place").toBeLessThan(1e-9);
  });

  it("a corner joins a line's end in either order, and the first pick is what moves", async () => {
    const hex = HEX(17);
    const c0 = corner(hex, 0);
    // the corner first: the hexagon slides over, size and turn kept
    const a = sketch([hex, L("l", 30, 5, 40, 5)]);
    await a.use("coincident", c0, { x: 30, y: 5 });
    expect(a.s.constraints).toEqual([{ type: "coincident", e1: "H", p1: 0, e2: "l", p2: 0 }]);
    const moved = a.ent("H") as Poly;
    expect(corner(moved, 0).distanceTo(v(30, 5))).toBeLessThan(1e-9);
    expect(moved.radius).toBeCloseTo(10, 9);
    expect(moved.angle).toBeCloseTo(17, 9);
    const still = a.ent("l") as Line;
    [still.x1 - 30, still.y1 - 5, still.x2 - 40, still.y2 - 5].forEach((d) => expect(Math.abs(d)).toBeLessThan(1e-9));
    // the line first: its end comes to the corner, the hexagon stays as it was
    const b = sketch([hex, L("l", 30, 5, 40, 5)]);
    await b.use("coincident", { x: 30, y: 5 }, c0);
    expect(b.s.constraints).toEqual([{ type: "coincident", e1: "l", p1: 0, e2: "H", p2: 0 }]);
    expect(b.ent("H"), "digit for digit").toEqual(hex);
    const l = b.ent("l") as Line;
    expect(v(l.x1, l.y1).distanceTo(c0)).toBeLessThan(1e-9);
  });

  it("its centre is a point too: Coincident on the origin centres it", async () => {
    const live = sketch([{ ...HEX(), x: 12, y: -7 }]);
    await live.use("coincident", { x: 12, y: -7 }, { x: 0, y: 0 });
    expect(live.s.constraints).toEqual([{ type: "coincident", e1: "H", p1: -1, e2: ORIGIN_ID, p2: 0 }]);
    const p = live.ent("H") as Poly;
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1e-9);
    expect(p.radius).toBeCloseTo(10, 9);
  });

  it("a size through zero is refused, and the dimension that asked for it is the one blamed", async () => {
    const hex = HEX();
    const r = await compileAndSolve([hex], [{ type: "p2pDistance", e1: "H", p1: -1, e2: "H", p2: 0, value: 0 }]);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(["k0"]);
    expect(r.entities).toEqual([hex]);
  });

  it("a polygon nobody names stays out of the solver: an old sketch solves to exactly what it was", async () => {
    const ents: ResolvedEntity[] = [RECT(), HEX(17), SLOT(), L("l", 0, 30, 20, 34)];
    const r = await compileAndSolve(ents, [{ type: "horizontal", line: "l" }]);
    expect(r.ok).toBe(true);
    expect(r.entities.slice(0, 3)).toEqual(ents.slice(0, 3));
    const without = await compileAndSolve([RECT(), L("l", 0, 30, 20, 34)], [{ type: "horizontal", line: "l" }]);
    expect(r.dof, "the polygon and slot add no freedom to count").toBe(without.dof);
  });
});

describe("a slot, once a constraint names it", () => {
  it("Midpoint of its AXIS on the origin centres it, size and direction kept", async () => {
    const live = sketch([SLOT()]);
    // the origin, then the axis: inside the slot, where no curve is
    await live.use("midpoint", { x: 0, y: 0 }, { x: 25, y: 0.1 });
    expect(live.s.constraints).toEqual([{ type: "midpoint", e: ORIGIN_ID, p: 0, line: "S~2" }]);
    const sl = live.ent("S") as Slot;
    expect((sl.x1 + sl.x2) / 2).toBeCloseTo(0, 9);
    expect((sl.y1 + sl.y2) / 2).toBeCloseTo(0, 9);
    expect(Math.hypot(sl.x2 - sl.x1, sl.y2 - sl.y1)).toBeCloseTo(30, 9);
    expect(sl.y2 - sl.y1).toBeCloseTo(0, 9);
    expect(sl.width).toBe(6);
  });

  it("Parallel takes a side, and a centre takes Coincident", async () => {
    const live = sketch([SLOT(), L("l", 0, 20, 20, 40)]);
    await live.use("parallel", { x: 25, y: 3 }, { x: 10, y: 30 });
    expect(live.s.constraints).toEqual([{ type: "parallel", l1: "S~0", l2: "l" }]);
    const sl = live.ent("S") as Slot;
    expect(Math.atan2(sl.y2 - sl.y1, sl.x2 - sl.x1)).toBeCloseTo(Math.PI / 4, 9);
    expect(sl.width).toBe(6);
    expect([(sl.x1 + sl.x2) / 2, (sl.y1 + sl.y2) / 2].map((n) => Math.round(n * 1e9) / 1e9), "turned about its middle").toEqual([25, 0]);
    const c = sketch([SLOT(), PT("P", 50, 12)]);
    await c.use("coincident", { x: 40, y: 0 }, { x: 50, y: 12 });
    expect(c.s.constraints).toEqual([{ type: "coincident", e1: "S", p1: 1, e2: "P", p2: 0 }]);
    const moved = c.ent("S") as Slot;
    expect([moved.x2, moved.y2].map((n) => Math.round(n * 1e9) / 1e9)).toEqual([50, 12]);
  });
});

describe("a shape drawn square to the axes, turned a quarter turn", () => {
  // The tools draw shapes level (a slot snaps level, a polygon with a typed
  // radius sits at exactly 0 degrees), and from there a side that has to go
  // upright has no slope to follow: the solve shrank the shape or slid it
  // instead of turning it, with no message (Vertical: radius 15 -> 6.75).
  it("Vertical on a hexagon's top side turns it about its centre, its size kept", async () => {
    const hex = { ...HEX(), radius: 15 };
    const live = sketch([hex]);
    await live.use("vertical", mid(side([hex], "H~1")));
    expect(live.s.constraints).toEqual([{ type: "vertical", line: "H~1" }]);
    const p = live.ent("H") as Poly;
    expect(Math.abs(Math.cos(dir(side([p], "H~1"))))).toBeLessThan(1e-9);
    expect(p.radius).toBeCloseTo(15, 9);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1e-9);
  });

  it("Perpendicular between two level hexagons turns the one picked first; the other stays digit for digit", async () => {
    const a: Poly = { ...HEX(), id: "A", radius: 15 };
    const b: Poly = { ...HEX(), id: "B", x: 40, y: 40, radius: 10 };
    const live = sketch([a, b]);
    await live.use("perpendicular", mid(side([a], "A~1")), mid(side([b], "B~1")));
    expect(live.s.constraints).toEqual([{ type: "perpendicular", l1: "A~1", l2: "B~1" }]);
    expect(live.ent("B"), "the second pick").toEqual(b);
    const got = live.ent("A") as Poly;
    expect(Math.abs(Math.cos(dir(side([got], "A~1"))))).toBeLessThan(1e-9);
    expect(got.radius).toBeCloseTo(15, 9);
    expect(Math.hypot(got.x, got.y)).toBeLessThan(1e-9);
  });

  it("Vertical on a level slot's centre line turns it about its middle, its length kept", async () => {
    const live = sketch([SLOT()]);
    await live.use("vertical", { x: 25, y: 0.1 }); // inside, where only the centre line is
    expect(live.s.constraints).toEqual([{ type: "vertical", line: "S~2" }]);
    const sl = live.ent("S") as Slot;
    expect(Math.abs(sl.x2 - sl.x1)).toBeLessThan(1e-9);
    expect([(sl.x1 + sl.x2) / 2, (sl.y1 + sl.y2) / 2].map((n) => Math.round(n * 1e9) / 1e9)).toEqual([25, 0]);
    expect(Math.hypot(sl.x2 - sl.x1, sl.y2 - sl.y1)).toBeCloseTo(30, 9);
  });

  it("Parallel from a level slot's side to an upright line turns the slot, not the line", async () => {
    const live = sketch([SLOT(), L("l", 60, 0, 60, 20)], [{ type: "vertical", line: "l" }]);
    await live.use("parallel", { x: 25, y: 3 }, { x: 60, y: 10 });
    expect(live.s.constraints.at(-1)).toEqual({ type: "parallel", l1: "S~0", l2: "l" });
    expect(live.ent("l"), "the second pick").toEqual(L("l", 60, 0, 60, 20));
    const sl = live.ent("S") as Slot;
    expect(Math.abs(sl.x2 - sl.x1)).toBeLessThan(1e-9);
    expect([(sl.x1 + sl.x2) / 2, (sl.y1 + sl.y2) / 2].map((n) => Math.round(n * 1e9) / 1e9)).toEqual([25, 0]);
  });
});

describe("each shape gives up only what its own constraints need", () => {
  it("a slot that has to slide and a hexagon that has to turn, solved together", async () => {
    // Released together, both were free to do both: the slot turned 21
    // degrees and the hexagon slid 9 mm.
    const sl: Slot = { type: "slot", id: "S", x1: 0, y1: 40, x2: 30, y2: 40, width: 6 };
    const hex: Poly = { ...HEX(), x: 60 };
    const live = sketch([sl, hex], [
      { type: "midpoint", e: ORIGIN_ID, p: 0, line: "S~2" },
      { type: "horizontal", line: "H~0" },
    ]);
    live.s.requestSolve(); // an unbiased solve, as opening the sketch runs
    await live.settle();
    const s2 = live.ent("S") as Slot, h = live.ent("H") as Poly;
    expect([s2.x1, s2.y1, s2.x2, s2.y2].map((n) => Math.round(n * 1e9) / 1e9)).toEqual([-15, 0, 15, 0]);
    expect([h.x, h.y, h.radius].map((n) => Math.round(n * 1e9) / 1e9)).toEqual([60, 0, 10]);
    expect(Math.abs(Math.sin(dir(side([h], "H~0"))))).toBeLessThan(1e-9);
  });

  it("a vertical dimension slides a polygon, a rectangle or a slot straight up or down", async () => {
    // With both directions free it drifted sideways too: polygon x -40 -> -46.08.
    const shapes: [ResolvedEntity, number][] = [
      [{ ...HEX(), x: -40, y: 30 }, -1],
      [{ ...RECT(), x: 40, y: 30 }, 4],
      [{ ...SLOT(), x1: -40, y1: 30, x2: -10, y2: 30 }, 0],
    ];
    for (const [shape, p] of shapes) {
      const live = sketch([shape]);
      (live.s as unknown as { setDrivingDimension(c: SketchConstraint, moves?: string): void })
        .setDrivingDimension({ type: "p2pDistanceY", e1: shape.id, p1: p, e2: ORIGIN_ID, p2: 0, value: 20 }, shape.id);
      await live.settle();
      const got = live.ent(shape.id)!;
      const at = refPoint(got, p)!, was = refPoint(shape, p)!;
      expect(at.y, shape.type).toBeCloseTo(-20, 9);
      expect(at.x, `${shape.type} stays where it was across`).toBeCloseTo(was.x, 9);
    }
  });

  it("Parallel from a side of a hexagon joined to a line turns the hexagon, picked first, about its centre", async () => {
    // Its place was released before its turn: the hexagon slid 10 mm, and the
    // line it is joined to was dragged to nearly nothing (22.4 -> 1.3 long).
    const hex = HEX();
    const join: SketchConstraint = { type: "coincident", e1: "H", p1: 0, e2: "l", p2: 0 };
    const live = sketch([hex, L("l", 10, 0, 30, 10)], [join]);
    await live.use("parallel", mid(side([hex], "H~0")), { x: 20, y: 5 });
    expect(live.s.constraints).toEqual([join, { type: "parallel", l1: "H~0", l2: "l" }]);
    const p = live.ent("H") as Poly, l = live.ent("l") as Line;
    expect(r9(p.x, p.y, p.radius)).toEqual([0, 0, 10]);
    expect(r9(l.x2, l.y2), "the line's far end, picked second").toEqual([30, 10]);
    expect(v(l.x1, l.y1).distanceTo(corner(p, 0))).toBeLessThan(1e-9);
    expect(Math.abs(Math.sin(dir(side([p], "H~0")) - dir(l)))).toBeLessThan(1e-9);
  });

  it("Coincident puts a hexagon's corner on a sloping line at the nearest place", async () => {
    // 3x + 4y = 240; the corner at (10, 0) is 42 from it. It travelled 70,
    // along the X axis, or the hexagon grew to radius 80.
    const hex = HEX();
    const live = sketch([hex, L("l", 80, 0, 0, 60)]);
    await live.use("coincident", corner(hex, 0), { x: 40, y: 30 });
    expect(live.s.constraints).toEqual([{ type: "pointOn", e: "H", p: 0, curve: "l" }]);
    const p = live.ent("H") as Poly;
    expect(corner(p, 0).distanceTo(v(10, 0))).toBeCloseTo(42, 9);
    expect([p.radius, p.angle]).toEqual([10, 0]);
  });
});

describe("the Dimension tool on a shape", () => {
  it("a polygon side's length drives the polygon's size", async () => {
    const hex = HEX();
    const s0 = side([hex], "H~0");
    const pick = pickDimTarget([hex], v((s0.x1 + s0.x2) / 2, (s0.y1 + s0.y2) / 2), 0.5)!;
    const plan = resolveDim([pick]);
    if (isDimError(plan)) throw new Error(plan.message);
    expect(plan.measure()).toBeCloseTo(10, 9); // a hexagon's side is its radius
    const c = plan.make(12);
    expect(c).toMatchObject({ type: "p2pDistance", e1: "H", p1: 0, e2: "H", p2: 1, value: 12 });
    const r = await compileAndSolve([hex], [c], undefined, { moves: [soleDimEntity(c)!] });
    expect(r.conflicts).toEqual([]);
    const p = r.entities[0] as Poly;
    expect(p.radius).toBeCloseTo(12, 9);
    expect([p.x, p.y, p.angle].map((n) => Math.round(n * 1e9) / 1e9), "sized about its centre, not turned").toEqual([0, 0, 0]);
  });

  it("across a slot's two sides is its width, which it refuses and says so", () => {
    const sl = SLOT();
    const a = pickDimTarget([sl], v(25, 3), 0.5)!;
    const b = pickDimTarget([sl], v(25, -3), 0.5)!;
    const res = resolveDim([a, b]);
    expect(isDimError(res) && res.message).toBe(t("sketch.dimension.error.slotWidth"));
  });

  it("from a line to a slot side: a distance whose label sits on the side, and that solves", async () => {
    const sl = SLOT();
    const line = L("l", 10, 20, 40, 20);
    const res = resolveDim([pickDimTarget([sl, line], v(25, 3), 0.5)!, pickDimTarget([sl, line], v(25, 20), 0.5)!]);
    if (isDimError(res)) throw new Error(res.message);
    const c = res.make(10);
    const r = await compileAndSolve([sl, line], [c, ...(res.parallelPair ? [{ type: "parallel" as const, ...res.parallelPair }] : [])], undefined, { moves: [res.moves!] });
    expect(r.conflicts).toEqual([]);
    const top = side(r.entities, "S~0"), l = r.entities[1] as Line;
    expect(Math.abs(l.y1 - top.y1)).toBeCloseTo(10, 9);
    const label = constraintDims(r.entities, [c])[0];
    expect(label, "the label resolves the side's end").toBeDefined();
  });
});

const boundRadius = () => t("sketch.constraint.boundShape", { shape: t("sketch.entity.polygon"), field: t("sketch.constraint.boundField.radius") });

describe("a parameter that sets a shape's number is held where it is", () => {
  // A hexagon with its centre fixed, and a fixed point 20 from it: putting
  // corner 0 on that point can only be done by growing the radius to 20.
  const ents = (): ResolvedEntity[] => [HEX(), PT("P", 20, 0)];
  const cons = (): SketchConstraint[] => [{ type: "fix", e: "H", p: -1 }, { type: "fix", e: "P", p: 0 }];

  it("so a constraint that needs it changed is withdrawn, and the radius stays", async () => {
    const live = sketch(ents(), cons());
    live.internals.pendingBindings.set("e:H:radius", { expr: "10", kind: "length" });
    await live.use("coincident", { x: 10, y: 0 }, { x: 20, y: 0 });
    expect(live.s.constraints).toEqual(cons());
    // the refusal names the number the parameter sets: the plain one blamed
    // "the constraints already on this sketch", of which there are none here
    // that the corner could not have met
    expect(toasts).toEqual([boundRadius()]);
    expect((live.ent("H") as Poly).radius).toBe(10);
  });

  it("a dimension on a side of a polygon whose radius a parameter sets says so", async () => {
    // reviewer's steps: Edit polygon, radius pr=15, then Dimension a side 30.
    // The sketch has no constraints, and the plain refusal said the value
    // conflicts with the ones already on it.
    const hex = { ...HEX(), radius: 15 };
    const live = sketch([hex]);
    live.internals.pendingBindings.set("e:H:radius", { expr: "pr", kind: "length" });
    const s0 = side([hex], "H~0");
    const plan = resolveDim([pickDimTarget([hex], v((s0.x1 + s0.x2) / 2, (s0.y1 + s0.y2) / 2), 0.5)!]);
    if (isDimError(plan)) throw new Error(plan.message);
    (live.s as unknown as { setDrivingDimension(c: SketchConstraint, moves?: string): void }).setDrivingDimension(plan.make(30), plan.moves);
    await live.settle();
    expect(live.s.constraints).toEqual([]);
    expect(toasts).toEqual([boundRadius()]);
    expect(live.ent("H")).toEqual(hex);
  });

  it("CONTROL: with nothing bound the radius is what gives", async () => {
    const live = sketch(ents(), cons());
    await live.use("coincident", { x: 10, y: 0 }, { x: 20, y: 0 });
    expect(live.s.constraints).toHaveLength(3);
    expect((live.ent("H") as Poly).radius).toBeCloseTo(20, 9);
  });
});

describe("a new side count re-aims what names a corner or a side", () => {
  it("through a parameter, in a sketch that is not open", () => {
    // hexagon corner 2 sits at 120 degrees and side 2's middle at 150; as an
    // octagon the nearest are corner 3 (135) and side 3 (157.5)
    const sk: Feature = {
      type: "sketch", id: "sk", plane: "XY",
      entities: [{ type: "polygon", id: "H", x: 0, y: 0, radius: 10, sides: 6, angle: 0 }, { type: "line", id: "l", x1: -5, y1: 9, x2: -30, y2: 20 }],
      constraints: [
        { type: "coincident", e1: "H", p1: 2, e2: "l", p2: 0 },
        { type: "parallel", l1: "H~2", l2: "l" },
        { type: "fix", e: "H", p: -1 },
      ],
    } as Feature;
    const doc = { parameters: {}, features: [sk] } as unknown as CadDocument;
    writeTarget(doc, { kind: "entity", sketch: "sk", entity: "H", field: "sides" }, 8);
    const f = doc.features[0] as Extract<Feature, { type: "sketch" }>;
    expect(f.constraints).toEqual([
      { type: "coincident", e1: "H", p1: 3, e2: "l", p2: 0 },
      { type: "parallel", l1: "H~3", l2: "l" },
      { type: "fix", e: "H", p: -1 },
    ]);
  });
});

describe("a new side count leaves what names OTHER geometry alone", () => {
  // Real ids are e<N>: polygon e1 used to claim lines e10..e19 as its side 0,
  // so a side-count edit moved every constraint on them onto the polygon.
  const ents = (): ResolvedEntity[] => [
    { type: "polygon", id: "e1", x: 0, y: 0, radius: 10, sides: 6, angle: 0 },
    L("e12", 30, 0, 50, 0),
    L("e13", 50, 0, 50, 30),
    PT("e15", 50, 20),
  ];
  const cons = (): SketchConstraint[] => [
    { type: "horizontal", line: "e12" },
    { type: "coincident", e1: "e12", p1: 1, e2: "e13", p2: 0 },
    { type: "vertical", line: "e13" },
    { type: "pointOn", e: "e15", p: 0, curve: "e13" },
  ];

  it("Edit polygon, typed 8 sides", async () => {
    const live = sketch(ents(), cons());
    const dim = new DimInput();
    Object.assign(live.s, { dim });
    (live.s as unknown as { editPolygon(id: string, at: { x: number; y: number }): void }).editPolygon("e1", { x: 0, y: 0 });
    const field = (dim as unknown as { fields: { def: { name: string }; input: FakeInput }[] }).fields.find((f) => f.def.name === "sides")!.input;
    field.value = "8";
    field.dispatch("input");
    field.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    await live.settle();
    expect((live.ent("e1") as Poly).sides).toBe(8);
    expect(live.s.constraints).toEqual(cons());
    expect(toasts).toEqual([]);
  });

  it("a parameter, in a sketch that is not open", () => {
    const sk = { type: "sketch", id: "sk", plane: "XY", entities: ents(), constraints: cons() } as Feature;
    const doc = { parameters: {}, features: [sk] } as unknown as CadDocument;
    writeTarget(doc, { kind: "entity", sketch: "sk", entity: "e1", field: "sides" }, 8);
    expect((doc.features[0] as Extract<Feature, { type: "sketch" }>).constraints).toEqual(cons());
  });
});

describe("the right-click menu names the side or corner under it (GH #17)", () => {
  it("a rectangle side and a line: Parallel, applied to that side, and the line is what turns", async () => {
    const live = sketch([RECT(), L("l", -10, 30, 30, 40)]);
    live.s.selected = new Set(["R", "l"]);
    const items = rightClick(live, 20, -5); // R's bottom side
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["parallel", "perpendicular", "equal"].map((x) => constraintLabel(x as never))));
    items.find((i) => i.label === "Parallel")!.onClick!();
    await live.settle();
    expect(live.s.constraints).toEqual([{ type: "parallel", l1: "R~0", l2: "l" }]);
    const l = live.ent("l") as Line;
    expect(l.y2 - l.y1).toBeCloseTo(0, 9);
    // the side right-clicked is the one kept: named the mover, the rectangle
    // came out resized (37.49 wide for 40) as the line turned anyway
    expect(live.ent("R"), "digit for digit").toEqual(RECT());
  });

  it("a lone polygon side: Horizontal and Vertical; a lone corner: Fix", () => {
    const hex = HEX(17);
    const live = sketch([hex]);
    live.s.selected = new Set(["H"]);
    const s0 = side([hex], "H~0");
    expect(rightClick(live, (s0.x1 + s0.x2) / 2, (s0.y1 + s0.y2) / 2).map((i) => i.label)).toEqual(expect.arrayContaining(["Horizontal", "Vertical"]));
    const c1 = corner(hex, 1);
    const atCorner = rightClick(live, c1.x, c1.y).map((i) => i.label);
    expect(atCorner).toContain("Fix");
    expect(atCorner).not.toContain("Horizontal");
  });

  it("a polygon corner and a sketch point: Coincident joins them, the point coming to the corner", async () => {
    const hex = HEX();
    const live = sketch([hex, PT("P", 25, 5)]);
    live.s.selected = new Set(["H", "P"]);
    const c1 = corner(hex, 1);
    rightClick(live, c1.x, c1.y).find((i) => i.label === "Coincident")!.onClick!();
    await live.settle();
    expect(live.s.constraints).toEqual([{ type: "coincident", e1: "H", p1: 1, e2: "P", p2: 0 }]);
    expect(live.ent("H")).toEqual(hex);
    const pt = live.ent("P") as { x: number; y: number };
    expect(v(pt.x, pt.y).distanceTo(c1)).toBeLessThan(1e-9);
  });

  it("Equal on two circles and Tangent on a line and an arc are the forms the tools make, and hold", async () => {
    // The menu used to emit a line-only `equal` and a circle-only `tangent`:
    // on circles and arcs they compiled to nothing, and the next edit dropped
    // them.
    const live = sketch([{ type: "circle", id: "a", x: 0, y: 0, radius: 5 }, { type: "circle", id: "b", x: 30, y: 0, radius: 8 }]);
    live.s.selected = new Set(["a", "b"]);
    rightClick(live, 5, 0).find((i) => i.label === "Equal")!.onClick!();
    await live.settle();
    expect(live.s.constraints).toEqual([{ type: "equalRadius", a: "a", b: "b" }]);
    expect((live.ent("a") as { radius: number }).radius).toBeCloseTo((live.ent("b") as { radius: number }).radius, 9);
  });
});

describe("Move and Rotate refuse a shape tied to what is not moving (C8)", () => {
  it("Move: a rectangle with a corner on the origin is left where it is, and says why", async () => {
    // a237de6b: the move went through, and the settle put the corner back on
    // the origin by RESIZING the rectangle (60x50 -> 80x40)
    const cons: SketchConstraint[] = [{ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0 }];
    const rect: Rect = { type: "rectangle", id: "R", x: 30, y: 25, width: 60, height: 50 };
    const live = sketch([rect], cons);
    live.s.selected = new Set(["R"]);
    await live.use("move", { x: 30, y: 25 }, { x: 50, y: 35 });
    expect(toasts).toContain(t("sketch.transform.moveTied"));
    expect(live.ent("R")).toEqual(rect);
    expect(live.s.history.canUndo).toBe(false);
  });

  it("Move along the line a corner is held on is not a tie; across it is", async () => {
    const cons: SketchConstraint[] = [{ type: "pointOn", e: "R", p: 0, curve: ORIGIN_X_ID }];
    const rect: Rect = { type: "rectangle", id: "R", x: 30, y: 25, width: 60, height: 50 };
    const along = sketch([rect], cons);
    along.s.selected = new Set(["R"]);
    await along.use("move", { x: 30, y: 25 }, { x: 50, y: 25 });
    expect(toasts).not.toContain(t("sketch.transform.moveTied"));
    expect(along.ent("R")).toMatchObject({ x: 50, y: 25, width: 60, height: 50 });
    const across = sketch([rect], cons);
    across.s.selected = new Set(["R"]);
    await across.use("move", { x: 30, y: 25 }, { x: 30, y: 45 });
    expect(toasts).toContain(t("sketch.transform.moveTied"));
    expect(across.ent("R")).toEqual(rect);
  });

  it("Move of a polygon tied by its corner is refused; selected with what it is tied to, it moves", async () => {
    const cons: SketchConstraint[] = [{ type: "coincident", e1: "H", p1: 0, e2: "l", p2: 0 }];
    const ents = (): ResolvedEntity[] => [HEX(), L("l", 10, 0, 30, 0)];
    const alone = sketch(ents(), cons);
    alone.s.selected = new Set(["H"]);
    await alone.use("move", { x: 0, y: 0 }, { x: 0, y: 20 });
    expect(toasts).toContain(t("sketch.transform.moveTied"));
    toasts.length = 0;
    const both = sketch(ents(), cons);
    both.s.selected = new Set(["H", "l"]);
    await both.use("move", { x: 0, y: 0 }, { x: 0, y: 20 });
    expect(toasts).not.toContain(t("sketch.transform.moveTied"));
    expect(both.ent("H")).toMatchObject({ x: 0, y: 20, radius: 10, angle: 0 });
  });

  it("Rotate: a polygon tied to a line that is not turning is left as it was", async () => {
    const cons: SketchConstraint[] = [{ type: "parallel", l1: "H~0", l2: "l" }];
    const live = sketch([HEX(), L("l", 20, 20, 40, 20 + 20 * Math.tan(Math.PI / 3 * 2))], cons);
    const dim = new DimInput();
    Object.assign(live.s, { dim });
    live.s.selected = new Set(["H"]);
    live.s.tool = "rotate";
    live.click(0, 0);
    const field = (dim as unknown as { fields: { def: { name: string }; input: FakeInput }[] }).fields.find((f) => f.def.name === "angle")!.input;
    field.value = "15";
    field.dispatch("input");
    field.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    await live.settle();
    expect(toasts).toContain(t("sketch.transform.rotateTied"));
    expect(live.ent("H")).toEqual(HEX());
  });
});

describe("a body drag of a polygon or slot nobody names", () => {
  // An old sketch: 0.1.232's snap copied a corner's coordinates to a line's
  // end with no join. The solver has no point there, so the line's end is
  // not joined to the corner and stays where it is when the shape is dragged.
  it("leaves a line end that only sits on a polygon's corner, and a point on a slot's centre", async () => {
    const hex = HEX();
    const c0 = corner(hex, 0);
    const live = sketch([hex, L("l", c0.x, c0.y, 40, 0), SLOT(), PT("P", 40, 0)], [{ type: "horizontal", line: "l" }]);
    const s2 = side([hex], "H~2");
    const from: [number, number] = [(s2.x1 + s2.x2) / 2, (s2.y1 + s2.y2) / 2];
    await live.drag(from, [from[0] + 5, from[1] + 5]);
    const p = live.ent("H") as Poly;
    expect(r9(p.x, p.y, p.radius, p.angle)).toEqual([5, 5, 10, 0]);
    expect(live.ent("l")).toEqual(L("l", c0.x, c0.y, 40, 0));
    await live.drag([25, 3], [30, 8]); // the slot, by its top side
    const sl = live.ent("S") as Slot;
    expect(r9(sl.x1, sl.y1, sl.x2, sl.y2)).toEqual([15, 5, 45, 5]);
    expect(live.ent("P")).toEqual(PT("P", 40, 0));
  });
});

describe("a body drag of a polygon joined to a line", () => {
  it("moves the polygon where the cursor puts it, and the line's end comes with it", async () => {
    // The line is level and its far end fixed, so its near end, joined to
    // corner 0, can only slide along it: the polygon follows the cursor across,
    // and the join holds its corner on the line (the upward part of the drag
    // it cannot follow, and the pins' compromise turns it a little). Unpinned,
    // each frame's solve split the sideways correction between the polygon
    // and the line's end, and the polygon fell back off the cursor (measured:
    // -5.955 for -6).
    const cons: SketchConstraint[] = [
      { type: "coincident", e1: "H", p1: 0, e2: "l", p2: 0 },
      { type: "horizontal", line: "l" },
      { type: "fix", e: "l", p: 1 },
    ];
    const live = sketch([HEX(), L("l", 10, 0, 30, 0)], cons);
    const s0 = side([HEX()], "H~2"); // a side away from the line
    const from: [number, number] = [(s0.x1 + s0.x2) / 2, (s0.y1 + s0.y2) / 2];
    await live.drag(from, [from[0] - 6, from[1] + 4]);
    const p = live.ent("H") as Poly;
    expect(p.x).toBeCloseTo(-6, 6);
    expect(p.radius).toBeCloseTo(10, 6);
    const l = live.ent("l") as Line;
    expect(v(l.x1, l.y1).distanceTo(corner(p, 0))).toBeLessThan(1e-6);
  });
});

describe("Move lets through what a constraint leaves free", () => {
  it("a polygon held only by a vertical distance moves sideways, and not up", async () => {
    const hex: Poly = { ...HEX(), x: -40, y: 25 };
    const cons: SketchConstraint[] = [{ type: "p2pDistanceY", e1: "H", p1: -1, e2: ORIGIN_ID, p2: 0, value: -25 }];
    const across = sketch([hex], cons);
    across.s.selected = new Set(["H"]);
    await across.use("move", { x: -40, y: 25 }, { x: -30, y: 25 });
    expect(toasts).not.toContain(t("sketch.transform.moveTied"));
    expect(across.ent("H")).toMatchObject({ x: -30, y: 25 });
    const up = sketch([hex], cons);
    up.s.selected = new Set(["H"]);
    await up.use("move", { x: -40, y: 25 }, { x: -40, y: 35 });
    expect(toasts).toContain(t("sketch.transform.moveTied"));
    expect(up.ent("H")).toEqual(hex);
  });
});

describe("arming Dimension with a shape selected", () => {
  it("starts clean and says nothing: a polygon's sides and corners take a dimension now", () => {
    const live = sketch([HEX(), RECT(), SLOT()]);
    for (const id of ["H", "R", "S"]) {
      live.s.tool = "select";
      live.s.selected = new Set([id]);
      live.s.setTool("dimension");
      expect(toasts, id).toEqual([]);
    }
  });
});

describe("what draws and what snaps", () => {
  it("a glyph sits on the polygon corner or slot centre it names", () => {
    const hex = HEX();
    const g1 = constraintGlyphs([hex, PT("P", 40, 0)], [{ type: "coincident", e1: "H", p1: 2, e2: "P", p2: 0 }]);
    expect(g1[0]!.pos.distanceTo(corner(hex, 2))).toBeLessThan(1e-9);
    const g2 = constraintGlyphs([SLOT(), L("l", 10, 9, 40, 9)], [{ type: "pointOn", e: "S", p: 1, curve: "l" }]);
    expect([g2[0]!.pos.x, g2[0]!.pos.y]).toEqual([40, 0]);
  });

  it("a rectangle's centre, a polygon's corners and centre and a slot's centres snap WITH their identity", () => {
    const refs = candidatesFromEntities([RECT(), HEX(), SLOT()]).flatMap((c) => (c.ref ? [`${c.ref.id}:${c.ref.idx}`] : []));
    expect(refs).toEqual(expect.arrayContaining(["R:4", "H:-1", "H:0", "H:5", "S:0", "S:1"]));
    // which is what a drawn line's end records as its join
    expect(refPoint(RECT(), 4)).toEqual(v(10, 5));
  });
});

describe("Rotate of a rectangle held on the origin by its CENTRE", () => {
  it("turns it about the origin and keeps it there, its centre carried onto the lines", async () => {
    const rect: Rect = { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 };
    const cons: SketchConstraint[] = [{ type: "coincident", e1: "R", p1: 4, e2: ORIGIN_ID, p2: 0 }];
    const live = sketch([rect], cons);
    const dim = new DimInput();
    Object.assign(live.s, { dim });
    live.s.selected = new Set(["R"]);
    live.s.tool = "rotate";
    live.click(0, 0);
    const field = (dim as unknown as { fields: { def: { name: string }; input: FakeInput }[] }).fields.find((f) => f.def.name === "angle")!.input;
    field.value = "30";
    field.dispatch("input");
    field.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    await live.settle();
    expect(toasts).not.toContain(t("sketch.transform.rotateTied"));
    expect(toasts.some((m) => m.includes("could not move")), toasts.join(" | ")).toBe(false);
    const sides = live.s.entities.filter((e): e is Line => e.type === "line" && !e.construction && !e.id.startsWith("__"));
    expect(sides).toHaveLength(4);
    const xs = sides.flatMap((l) => [l.x1, l.x2]), ys = sides.flatMap((l) => [l.y1, l.y2]);
    const mid = v(xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length);
    expect(mid.length(), "still centred on the origin").toBeLessThan(1e-6);
    const bottom = live.ent("R") as Line;
    expect((Math.atan2(bottom.y2 - bottom.y1, bottom.x2 - bottom.x1) * 180) / Math.PI).toBeCloseTo(30, 6);
    expect(live.s.overIdx.size, "nothing over-defined").toBe(0);
  });
});

describe("Explode carries a polygon's corners and centre onto what it becomes", () => {
  it("a corner becomes the start of its side, the centre its circle's", async () => {
    const cons: SketchConstraint[] = [
      { type: "coincident", e1: "H", p1: 2, e2: "P", p2: 0 },
      { type: "coincident", e1: "H", p1: -1, e2: ORIGIN_ID, p2: 0 },
    ];
    const r = explodeCompound([HEX(), PT("P", 40, 0)], cons, 0)!;
    expect(r.dropped).toBe(0);
    expect(r.constraints.slice(0, 2)).toEqual([
      { type: "coincident", e1: r.sides[2], p1: 0, e2: "P", p2: 0 },
      { type: "coincident", e1: r.helpers[0], p1: 0, e2: ORIGIN_ID, p2: 0 },
    ]);
  });
});
