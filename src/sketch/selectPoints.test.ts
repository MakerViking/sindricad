// Point- and side-level selection in the sketch Select tool (GH #17, promised
// on 2026-09-02: "point-level selection ... is on the list").
//
// A click takes the POINT under it (a line's or arc's end, a corner, a
// centre), else the SIDE of a rectangle, polygon or slot under it, else the
// entity; Shift- or Ctrl-click adds; a double-click takes the whole shape. The
// right-click menu then offers what fits the points and sides picked, and
// everything that acts on geometry acts on the entity they belong to.
//
// Entered where the user enters: presses and releases through onPointerDown
// and endDrag, the right-click through onContextMenu and its items' clicks,
// Delete through onKey, Move through the tool's clicks. The solves are the
// real planegcs ones (liveSketch.testkit).
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

import * as THREE from "three";
import { liveSketch, PX } from "./liveSketch.testkit";
import { constraintLabel } from "./constraintMenu";
import { lineOperand, refPoint } from "./entityDims";
import { DimInput } from "./dimInput";
import { FIXED_POINT_MSG } from "./modify";
import { ORIGIN_ID } from "./origin";
import { contextMenu, type CtxItem } from "../ui/menu";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";

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

type Live = ReturnType<typeof liveSketch>;
type Rect = Extract<ResolvedEntity, { type: "rectangle" }>;
type Line = Extract<ResolvedEntity, { type: "line" }>;
type Circle = Extract<ResolvedEntity, { type: "circle" }>;

const L = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });
/** 20 x 10 about (60, 30): corners (50,25) (70,25) (70,35) (50,35), sides
 *  0 bottom, 1 right, 2 top, 3 left */
const RECT = (id = "R", x = 60, y = 30): Rect => ({ type: "rectangle", id, x, y, width: 20, height: 10 });
const HEX = (): ResolvedEntity => ({ type: "polygon", id: "H", x: 100, y: 0, radius: 10, sides: 6, angle: 0 });
const SLOT = (): ResolvedEntity => ({ type: "slot", id: "S", x1: 110, y1: 40, x2: 140, y2: 40, width: 6 });
const C = (id: string, x: number, y: number, radius: number): Circle => ({ type: "circle", id, x, y, radius });

const mid = (live: Live, side: string) => {
  const s = lineOperand(new Map(live.s.entities.map((e) => [e.id, e])), side)!;
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
};
const pt = (live: Live, id: string, p: number) => refPoint(live.ent(id)!, p)!;

const ev = (x: number, y: number, mods: { shift?: boolean; ctrl?: boolean } = {}) => ({
  button: 0, clientX: x * PX, clientY: y * PX, pointerId: 1,
  shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, metaKey: false,
  preventDefault() {}, stopPropagation() {},
}) as unknown as PointerEvent;
/** a click, a fresh gesture (no double-click pairing) */
const click = (live: Live, at: { x: number; y: number }, mods: { shift?: boolean; ctrl?: boolean } = {}) => {
  live.s.lastPress = null;
  live.s.onPointerDown(ev(at.x, at.y, mods));
  live.release();
};
const doubleClick = (live: Live, at: { x: number; y: number }) => {
  live.s.lastPress = null;
  live.s.onPointerDown(ev(at.x, at.y));
  live.release();
  live.s.onPointerDown(ev(at.x, at.y));
  live.release();
};
const sel = (live: Live) => [...live.s.selected];

const menuItems = () => (vi.mocked(contextMenu).mock.calls.at(-1)?.[2] ?? []) as CtxItem[];
const rightClick = (live: Live, at: { x: number; y: number }, mods: { shift?: boolean; ctrl?: boolean } = {}) => {
  vi.mocked(contextMenu).mockClear();
  live.s.onContextMenu({
    clientX: at.x * PX, clientY: at.y * PX, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, metaKey: false, preventDefault() {},
  } as unknown as MouseEvent);
  return menuItems();
};
const labels = (items: CtxItem[]) => items.map((i) => i.label);
const CONSTRAINTS = ["coincident", "midpoint", "symmetric", "horizontal", "vertical", "parallel", "perpendicular",
  "equal", "collinear", "tangent", "concentric", "fix"].map((x) => constraintLabel(x as never));
const offered = (items: CtxItem[]) => labels(items).filter((l) => CONSTRAINTS.includes(l));
const choose = async (live: Live, items: CtxItem[], label: string) => {
  const item = items.find((i) => i.label === label);
  expect(item, `menu offered: ${labels(items).join(", ")}`).toBeDefined();
  item!.onClick!();
  await live.settle();
};

/** What the Dimension tool needs to run in a liveSketch: its value box, and
 *  a screen mapping for where the box goes. Returns the typing of a value
 *  into the box's first field, and Enter. */
function withDimensionTool(live: Live) {
  const dim = new DimInput();
  Object.assign(live.s, {
    dim, lastCursor: new THREE.Vector2(), referenceMode: false, dimPicks: [], dimPlan: null, dimPlace: null,
    dimPlaced: false, dimFieldKey: "", dimPlanKey: "",
  });
  const viewport = (live.s as unknown as { viewport: { domElement: object } }).viewport;
  Object.assign(viewport, {
    projectToScreen: (w: THREE.Vector3) => ({ x: w.x * PX, y: w.y * PX }),
    pixelWorldSize: () => 1 / PX,
  });
  Object.assign(viewport.domElement, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1000, right: 1600, bottom: 1000 }) });
  return (text: string) => {
    const field = (dim as unknown as { fields: { input: FakeInput }[] }).fields[0]?.input;
    expect(field, "the Dimension tool's box is open").toBeDefined();
    field!.value = text;
    field!.dispatch("input");
    field!.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
  };
}

const sorted = (xs: string[]) => [...xs].sort();

beforeEach(() => { toasts.length = 0; });

describe("a click in the Select tool takes the point or side under it (GH #17)", () => {
  it("a line's end is that point, and its middle is the line", () => {
    const live = liveSketch([L("A", 10, 0, 30, 0)]);
    click(live, { x: 30, y: 0 });
    expect(sel(live)).toEqual(["A@1"]);
    click(live, { x: 20, y: 0 });
    expect(sel(live)).toEqual(["A"]);
  });

  it("a rectangle: one side, one corner, its centre; and inside, away from all three, nothing", () => {
    const live = liveSketch([RECT()]);
    click(live, mid(live, "R~0"));
    expect(sel(live)).toEqual(["R~0"]);
    click(live, pt(live, "R", 2));
    expect(sel(live)).toEqual(["R@2"]);
    click(live, { x: 60, y: 30 });
    expect(sel(live)).toEqual(["R@4"]);
    click(live, { x: 55, y: 28 });
    expect(sel(live)).toEqual([]);
  });

  it("a polygon's corner, side and centre; a slot's side and centres, and its round end is the slot", () => {
    const live = liveSketch([HEX(), SLOT()]);
    click(live, pt(live, "H", 0));
    expect(sel(live)).toEqual(["H@0"]);
    click(live, mid(live, "H~1"));
    expect(sel(live)).toEqual(["H~1"]);
    click(live, { x: 100, y: 0 });
    expect(sel(live)).toEqual(["H@-1"]);
    click(live, { x: 125, y: 43 });
    expect(sel(live)).toEqual(["S~0"]);
    click(live, { x: 140, y: 40 });
    expect(sel(live)).toEqual(["S@1"]);
    click(live, { x: 107, y: 40 });
    expect(sel(live)).toEqual(["S"]);
  });

  it("Shift-click and Ctrl-click add, and a second Shift-click takes it out again", () => {
    const live = liveSketch([L("A", 10, 0, 30, 0), RECT(), L("B", 10, 60, 30, 60)]);
    click(live, { x: 30, y: 0 });
    click(live, mid(live, "R~1"), { shift: true });
    click(live, { x: 20, y: 60 }, { ctrl: true });
    expect(sel(live)).toEqual(["A@1", "R~1", "B"]);
    click(live, mid(live, "R~1"), { shift: true });
    expect(sel(live)).toEqual(["A@1", "B"]);
  });

  it("a double-click takes the whole shape, and a shape is held whole or by its parts, never both", () => {
    const live = liveSketch([RECT()]);
    click(live, mid(live, "R~0"));
    doubleClick(live, mid(live, "R~0"));
    expect(sel(live)).toEqual(["R"]);
    click(live, pt(live, "R", 1), { shift: true });
    expect(sel(live)).toEqual(["R@1"]);
  });

  it("the hover lights the side or point a click would take, and nothing over a plain line", () => {
    const live = liveSketch([RECT(), L("A", 10, 0, 30, 0)]);
    const drawn: THREE.Object3D[][] = [];
    Object.assign((live.s as unknown as { overlay: object }).overlay, { setPreview: (o: THREE.Object3D[]) => drawn.push(o) });
    Object.assign((live.s as unknown as { viewport: object }).viewport, { pixelWorldSize: () => 1 / PX });
    const hover = (at: { x: number; y: number }) => live.s.onPointerMove(ev(at.x, at.y));
    hover(mid(live, "R~3"));
    expect(drawn.at(-1)!.map((o) => o.userData.entityId)).toEqual(["R~3"]);
    hover({ x: 60, y: 30 });
    expect(drawn.at(-1)).toHaveLength(1); // the centre's square
    expect(drawn.at(-1)![0]!.userData.entityId).toBeUndefined();
    hover({ x: 20, y: 0 });
    expect(drawn.at(-1)).toEqual([]);
  });
});

describe("the right-click menu offers what fits the points and sides picked", () => {
  it("two ends: Coincident joins them, the first picked coming to the second", async () => {
    const live = liveSketch([L("A", 10, 0, 30, 0), L("B", 34, 6, 50, 20)]);
    click(live, { x: 30, y: 0 });
    click(live, { x: 34, y: 6 }, { shift: true });
    const items = rightClick(live, { x: 34, y: 6 });
    expect(offered(items)).toEqual([constraintLabel("coincident")]);
    await choose(live, items, constraintLabel("coincident"));
    expect(live.s.constraints).toEqual([{ type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 }]);
    const a = live.ent("A") as Line, b = live.ent("B") as Line;
    expect(Math.hypot(a.x2 - b.x1, a.y2 - b.y1)).toBeLessThan(1e-9);
    expect([b.x1, b.y1], "B is where it was: A came to it").toEqual([34, 6]);
  });

  it("a line and a rectangle's side: Parallel, and the line is what turns", async () => {
    const live = liveSketch([RECT(), L("A", 10, 0, 30, 12)]);
    click(live, { x: 20, y: 6 });
    click(live, mid(live, "R~1"), { shift: true });
    const items = rightClick(live, mid(live, "R~1"));
    expect(offered(items)).toEqual(["parallel", "perpendicular", "equal", "collinear"].map((x) => constraintLabel(x as never)));
    await choose(live, items, constraintLabel("parallel"));
    expect(live.s.constraints).toEqual([{ type: "parallel", l1: "A", l2: "R~1" }]);
    const a = live.ent("A") as Line;
    expect(Math.abs(a.x2 - a.x1)).toBeLessThan(1e-9);
    // the rectangle keeps its size (a rectangle cannot turn); the solver
    // nudges it 0.01 mm along the way, exactly as it did for the same
    // constraint from a whole-rectangle selection before point-level selection
    const r = live.ent("R") as Rect;
    expect(r.width).toBeCloseTo(20, 9);
    expect(r.height).toBeCloseTo(10, 9);
  });

  it("two adjacent sides of one rectangle: only Equal, which squares it; opposite sides: no constraint", async () => {
    const live = liveSketch([RECT()]);
    click(live, mid(live, "R~0"));
    click(live, mid(live, "R~2"), { shift: true });
    expect(offered(rightClick(live, mid(live, "R~2")))).toEqual([]);
    click(live, mid(live, "R~0"));
    click(live, mid(live, "R~1"), { shift: true });
    const items = rightClick(live, mid(live, "R~1"));
    expect(offered(items)).toEqual([constraintLabel("equal")]);
    await choose(live, items, constraintLabel("equal"));
    expect(live.s.constraints).toEqual([{ type: "equal", l1: "R~0", l2: "R~1" }]);
    const r = live.ent("R") as Rect;
    expect(r.width).toBeCloseTo(r.height, 9);
  });

  it("a corner and another rectangle's side: Coincident and Midpoint; Midpoint puts the corner at its middle", async () => {
    const live = liveSketch([RECT(), RECT("Q", 100, 30)]);
    click(live, pt(live, "R", 2));
    click(live, mid(live, "Q~0"), { shift: true });
    const items = rightClick(live, mid(live, "Q~0"));
    expect(offered(items)).toEqual([constraintLabel("coincident"), constraintLabel("midpoint")]);
    await choose(live, items, constraintLabel("midpoint"));
    expect(live.s.constraints).toEqual([{ type: "midpoint", e: "R", p: 2, line: "Q~0" }]);
    expect(pt(live, "R", 2).distanceTo(new THREE.Vector2(mid(live, "Q~0").x, mid(live, "Q~0").y))).toBeLessThan(1e-9);
  });

  it("a corner and a circle: Coincident puts the corner ON the circle", async () => {
    const live = liveSketch([RECT(), C("c", 100, 30, 8)]);
    click(live, pt(live, "R", 1));
    click(live, { x: 108, y: 30 }, { shift: true });
    const items = rightClick(live, { x: 108, y: 30 });
    expect(offered(items)).toEqual([constraintLabel("coincident")]);
    await choose(live, items, constraintLabel("coincident"));
    expect(live.s.constraints).toEqual([{ type: "pointOn", e: "R", p: 1, curve: "c" }]);
    const c = live.ent("c") as Circle;
    expect(pt(live, "R", 1).distanceTo(new THREE.Vector2(c.x, c.y))).toBeCloseTo(c.radius, 9);
  });

  it("two points and a line: Symmetric mirrors the first onto the second about the line", async () => {
    const live = liveSketch([L("A", 10, 0, 30, 4), RECT(), L("ax", 40, -20, 40, 60)]);
    click(live, { x: 30, y: 4 });
    click(live, pt(live, "R", 0), { shift: true });
    click(live, { x: 40, y: 50 }, { shift: true });
    const items = rightClick(live, { x: 40, y: 50 });
    expect(offered(items)).toEqual([constraintLabel("symmetric")]);
    await choose(live, items, constraintLabel("symmetric"));
    expect(live.s.constraints).toEqual([{ type: "symmetric", e1: "A", p1: 1, e2: "R", p2: 0, line: "ax" }]);
    const a = live.ent("A") as Line, r0 = pt(live, "R", 0);
    expect(a.x2 + r0.x).toBeCloseTo(80, 6);
    expect(a.y2).toBeCloseTo(r0.y, 6);
  });

  it("one corner: Fix; one polygon side: Horizontal and Vertical", async () => {
    const live = liveSketch([HEX()]);
    click(live, pt(live, "H", 1));
    const items = rightClick(live, pt(live, "H", 1));
    expect(offered(items)).toEqual([constraintLabel("fix")]);
    await choose(live, items, constraintLabel("fix"));
    expect(live.s.constraints).toEqual([{ type: "fix", e: "H", p: 1 }]);
    click(live, mid(live, "H~2"));
    expect(offered(rightClick(live, mid(live, "H~2")))).toEqual([constraintLabel("horizontal"), constraintLabel("vertical")]);
  });

  it("three circles: Equal holds them all to the LAST one picked", async () => {
    const live = liveSketch([C("a", 0, 40, 5), C("b", 30, 40, 7), C("c", 60, 40, 9)]);
    click(live, { x: 5, y: 40 });
    click(live, { x: 37, y: 40 }, { shift: true });
    click(live, { x: 69, y: 40 }, { shift: true });
    const items = rightClick(live, { x: 69, y: 40 });
    expect(offered(items)).toEqual([constraintLabel("equal")]);
    await choose(live, items, constraintLabel("equal"));
    expect(live.s.constraints).toEqual([{ type: "equalRadius", a: "a", b: "c" }, { type: "equalRadius", a: "b", b: "c" }]);
    for (const id of ["a", "b", "c"]) expect((live.ent(id) as Circle).radius, id).toBeCloseTo(9, 9);
  });

  it("two points: Dimension hands them to the Dimension tool, and the typed distance holds", async () => {
    const live = liveSketch([L("A", 10, 0, 30, 0), L("B", 34, 6, 50, 20)]);
    const typeValue = withDimensionTool(live);
    click(live, { x: 30, y: 0 });
    click(live, { x: 34, y: 6 }, { shift: true });
    const items = rightClick(live, { x: 34, y: 6 });
    items.find((i) => i.label === constraintLabel("dimension"))!.onClick!();
    expect(live.s.tool).toBe("dimension");
    typeValue("25");
    await live.settle();
    expect(live.s.constraints).toEqual([expect.objectContaining({ type: "p2pDistance", e1: "A", p1: 1, e2: "B", p2: 0, value: 25 })]);
    const a = live.ent("A") as Line, b = live.ent("B") as Line;
    expect(Math.hypot(a.x2 - b.x1, a.y2 - b.y1)).toBeCloseTo(25, 6);
  });
});

describe("what acts on geometry acts on the entity a point or side belongs to", () => {
  it("Delete with a rectangle's side selected deletes the rectangle", () => {
    const live = liveSketch([RECT(), L("A", 10, 0, 30, 0)]);
    Object.assign((live.s as unknown as { dims: object }).dims, { deleteSelected: () => false });
    click(live, mid(live, "R~2"));
    (live.s as unknown as { onKey(e: unknown): void }).onKey({ key: "Delete", target: null, preventDefault() {} });
    expect(live.ent("R")).toBeUndefined();
    expect(live.ent("A")).toBeDefined();
  });

  it("Move with a corner selected moves the whole rectangle, and the corner stays selected", async () => {
    const live = liveSketch([RECT()]);
    click(live, pt(live, "R", 3));
    live.s.tool = "move";
    live.click(0, 0);
    live.click(5, -10);
    await live.settle();
    expect(live.ent("R")).toMatchObject({ x: 65, y: 20, width: 20, height: 10 });
    expect(sel(live)).toEqual(["R@3"]);
  });

  it("a drag of one picked line carries the rectangle whose side is picked with it", async () => {
    const live = liveSketch([RECT(), L("A", 10, 0, 30, 0)]);
    click(live, mid(live, "R~0"));
    click(live, { x: 20, y: 0 }, { shift: true });
    await live.drag([20, 0], [25, 5]);
    const a = live.ent("A") as Line, r = live.ent("R") as Rect;
    expect([a.x1, a.y1, a.x2, a.y2].map((n) => n.toFixed(6))).toEqual(["15", "5", "35", "5"].map((n) => Number(n).toFixed(6)));
    expect([r.x, r.y, r.width, r.height].map((n) => n.toFixed(6))).toEqual(["65", "35", "20", "10"].map((n) => Number(n).toFixed(6)));
  });

  it("Mirror with a rectangle's side picked mirrors the rectangle", () => {
    const live = liveSketch([RECT(), L("ax", 40, -20, 40, 60)]);
    click(live, mid(live, "R~1"));
    live.s.tool = "mirror";
    live.click(40, 50);
    const rects = live.s.entities.filter((e) => e.type === "rectangle");
    expect(rects).toHaveLength(2);
    expect(rects[1]).toMatchObject({ x: 20, y: 30, width: 20, height: 10 });
  });

  it("Copy with a corner picked copies the rectangle, and leaves the copy selected", async () => {
    const live = liveSketch([RECT()]);
    click(live, pt(live, "R", 3));
    live.s.tool = "copy";
    live.click(0, 0);
    live.click(5, -10);
    await live.settle();
    const rects = live.s.entities.filter((e) => e.type === "rectangle");
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual(RECT());
    expect(rects[1]).toMatchObject({ x: 65, y: 20, width: 20, height: 10 });
    expect(sel(live)).toEqual([rects[1]!.id]);
  });

  it("Move with a side of a FIXED rectangle picked is refused, and says why (d0b008cb)", async () => {
    const live = liveSketch([RECT()], [{ type: "fix", e: "R", p: 0 }]);
    click(live, mid(live, "R~2"));
    live.s.tool = "move";
    live.click(0, 0);
    live.click(5, 5);
    await live.settle();
    expect(toasts).toContain(FIXED_POINT_MSG);
    expect(live.ent("R")).toEqual(RECT());
  });

  it("Move with a side picked of a rectangle held on the origin is refused, and says why (C8)", async () => {
    const rect: Rect = { type: "rectangle", id: "R", x: 30, y: 25, width: 60, height: 50 };
    const live = liveSketch([rect], [{ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0 }]);
    click(live, mid(live, "R~2"));
    expect(sel(live)).toEqual(["R~2"]);
    live.s.tool = "move";
    live.click(30, 20);
    live.click(50, 30);
    await live.settle();
    expect(toasts).toContain(t("sketch.transform.moveTied"));
    expect(live.ent("R")).toEqual(rect);
  });

  it("Rotate with a corner picked turns the rectangle into lines held square, not four loose lines", async () => {
    const live = liveSketch([RECT()]);
    const dim = new DimInput();
    Object.assign(live.s, { dim });
    click(live, pt(live, "R", 0));
    live.s.tool = "rotate";
    live.click(50, 25);
    const field = (dim as unknown as { fields: { def: { name: string }; input: FakeInput }[] }).fields.find((f) => f.def.name === "angle")!.input;
    field.value = "30";
    field.dispatch("input");
    field.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    await live.settle();
    expect(toasts).toContain(t("sketch.transform.rectangleToLines", { count: 1 }));
    expect(live.s.constraints.filter((c) => c.type === "perpendicular")).toHaveLength(3);
    const ls = live.s.entities.filter((e): e is Line => e.type === "line" && !e.id.startsWith("__"));
    expect(ls).toHaveLength(4);
    const bottom = ls.find((l) => Math.hypot(l.x1 - 50, l.y1 - 25) < 1e-6)!;
    expect((Math.atan2(bottom.y2 - bottom.y1, bottom.x2 - bottom.x1) * 180) / Math.PI).toBeCloseTo(30, 6);
  });

  it("Break Link is offered for a projected line picked by its end, and breaks it", async () => {
    const proj = {
      type: "projected", id: "P", source: { kind: "sketchCurve", sketch: "s0", entity: "e0" },
      curve: { kind: "line", x1: 10, y1: 50, x2: 30, y2: 50 },
    } as ResolvedEntity;
    const live = liveSketch([proj]);
    click(live, { x: 30, y: 50 });
    expect(sel(live)).toEqual(["P@1"]);
    await choose(live, rightClick(live, { x: 30, y: 50 }), t("sketch.menu.breakLink"));
    expect(live.ent("P")).toMatchObject({ type: "line", x1: 10, y1: 50, x2: 30, y2: 50 });
  });

  it("chain select (its keyboard shortcut) grows a picked end into the whole chain", () => {
    const live = liveSketch([L("A", 10, 10, 30, 10), L("B", 30, 10, 30, 30), L("Z", 60, 60, 70, 60)]);
    click(live, { x: 10, y: 10 });
    expect(sel(live)).toEqual(["A@0"]);
    expect((live.s as unknown as { growSelectionToChains(): boolean }).growSelectionToChains()).toBe(true);
    expect(sorted(sel(live))).toEqual(["A", "B"]);
  });

  it("a side picked, then the Dimension tool: the typed length goes on that side", async () => {
    const live = liveSketch([RECT()]);
    const typeValue = withDimensionTool(live);
    click(live, mid(live, "R~0"));
    live.s.setTool("dimension");
    typeValue("25");
    await live.settle();
    // a rectangle side's length is the distance between its two corners
    expect(live.s.constraints).toEqual([expect.objectContaining({ type: "p2pDistance", e1: "R", p1: 0, e2: "R", p2: 1, value: 25 })]);
    expect((live.ent("R") as Rect).width).toBeCloseTo(25, 9);
  });

  it("a box takes whole entities, and replaces a side of one already picked", () => {
    const live = liveSketch([RECT(), L("A", 10, 0, 30, 0)]);
    click(live, mid(live, "R~0"));
    live.s.lastPress = null;
    live.s.onPointerDown(ev(45, 20, { shift: true }));
    live.move(75, 40);
    live.release();
    expect(sel(live)).toEqual(["R"]);
  });
});

describe("small shapes, double-clicks, and a modifier held on the right-click", () => {
  // the pick tolerance is 0.5 here: every point of a circle of radius 0.4 is
  // within it of the centre, and of a line 0.8 long within it of an end

  it("a small circle's rim takes the circle and its centre the centre, so three small holes take Equal", async () => {
    const live = liveSketch([C("a", 30, 40, 0.3), C("b", 40, 40, 0.4), C("c", 50, 40, 0.45)]);
    click(live, { x: 40.4, y: 40 });
    expect(sel(live)).toEqual(["b"]);
    click(live, { x: 40.05, y: 40 });
    expect(sel(live)).toEqual(["b@0"]);
    click(live, { x: 30.3, y: 40 });
    click(live, { x: 40, y: 40.4 }, { ctrl: true });
    click(live, { x: 49.55, y: 40 }, { ctrl: true });
    expect(sel(live)).toEqual(["a", "b", "c"]);
    const items = rightClick(live, { x: 49.55, y: 40 });
    expect(offered(items)).toEqual([constraintLabel("equal")]);
    await choose(live, items, constraintLabel("equal"));
    for (const id of ["a", "b", "c"]) expect((live.ent(id) as Circle).radius, id).toBeCloseTo(0.45, 9);
  });

  it("a small rectangle's side takes the side, not its centre; its corner and centre stay points", () => {
    const live = liveSketch([{ type: "rectangle", id: "R", x: 50, y: 50, width: 0.8, height: 0.8 }]);
    click(live, { x: 50.4, y: 50 });
    expect(sel(live)).toEqual(["R~1"]);
    click(live, { x: 50.38, y: 50.38 });
    expect(sel(live)).toEqual(["R@2"]);
    click(live, { x: 50.05, y: 50 });
    expect(sel(live)).toEqual(["R@4"]);
  });

  it("your own centre beats an origin axis running past it", () => {
    const live = liveSketch([C("c", 10, 0.3, 5)]);
    click(live, { x: 10, y: 0.05 });
    expect(sel(live)).toEqual(["c@0"]);
  });

  it("the middle of a short line takes the line, and near an end, the end", () => {
    const live = liveSketch([L("A", 10, 10, 10.8, 10), L("B", 10.8, 10, 30, 10)]);
    click(live, { x: 10.4, y: 10 });
    expect(sel(live)).toEqual(["A"]);
    click(live, { x: 10.05, y: 10 });
    expect(sel(live)).toEqual(["A@0"]);
  });

  it("a double-click on a point takes the whole: a circle by its centre, a chain by an end, a rectangle by a corner", () => {
    const live = liveSketch([C("c", 60, 60, 5), L("A", 10, 10, 30, 10), L("B", 30, 10, 30, 30), RECT("R", 60, 30)]);
    doubleClick(live, { x: 60, y: 60 });
    expect(sel(live)).toEqual(["c"]);
    doubleClick(live, { x: 30, y: 10 });
    expect(sorted(sel(live))).toEqual(["A", "B"]);
    doubleClick(live, pt(live, "R", 2));
    expect(sel(live)).toEqual(["R"]);
    doubleClick(live, { x: 60, y: 30 }); // its centre, where there is no handle and no curve
    expect(sel(live)).toEqual(["R"]);
    // the short line, whose middle is within reach of both ends
    const short = liveSketch([L("S", 10, 10, 10.8, 10)]);
    doubleClick(short, { x: 10.6, y: 10 });
    expect(sel(short)).toEqual(["S"]);
  });

  it("a second press on a point that MOVES is still a drag of it, double-click or not", async () => {
    const live = liveSketch([L("A", 10, 10, 30, 10)]);
    live.s.lastPress = null;
    live.s.onPointerDown(ev(10, 10));
    live.release();
    live.s.onPointerDown(ev(10, 10)); // within the double-click's time and reach
    live.move(11, 12);
    await live.settle();
    live.move(12, 14);
    await live.settle();
    live.release();
    await live.settle();
    const a = live.ent("A") as Line;
    expect([a.x1, a.y1]).toEqual([12, 14]);
    expect([a.x2, a.y2]).toEqual([30, 10]);
  });

  it("Ctrl or Shift held on the right-click adds the point under it to the picks; without, it replaces them", () => {
    const live = liveSketch([L("A", 10, 10, 30, 10), L("B", 34, 16, 50, 30)]);
    click(live, { x: 30, y: 10 }, { ctrl: true });
    const items = rightClick(live, { x: 34, y: 16 }, { ctrl: true });
    expect(sel(live)).toEqual(["A@1", "B@0"]);
    expect(offered(items)).toEqual([constraintLabel("coincident")]);
    click(live, { x: 30, y: 10 });
    rightClick(live, { x: 34, y: 16 }, { shift: true });
    expect(sel(live)).toEqual(["A@1", "B@0"]);
    click(live, { x: 30, y: 10 });
    expect(offered(rightClick(live, { x: 34, y: 16 }))).toEqual([constraintLabel("fix")]);
    expect(sel(live)).toEqual(["B@0"]);
  });

  it("a dimension badge over a shape's centre opens its editor; over a side, the side is selected", () => {
    const live = liveSketch([HEX()]);
    const pressBadge = (at: { x: number; y: number }) =>
      (live.s as unknown as { labelOverlapSelect(e: PointerEvent): boolean }).labelOverlapSelect(ev(at.x, at.y));
    expect(pressBadge({ x: 100.2, y: 0 }), "nothing but the centre under it: the badge's own press").toBe(false);
    expect(sel(live)).toEqual([]);
    expect(pressBadge(mid(live, "H~1"))).toBe(true);
    expect(sel(live)).toEqual(["H~1"]);
  });
});
