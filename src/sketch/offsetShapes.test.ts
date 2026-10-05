// Offset of a rectangle or a polygon stays tied to the shape it came from, the
// way an offset of separate lines does (field report 0fc1ceed): "using offset in
// polygons and rectangles does not keep any connection to the original shape,
// I can click on the offset outline and drag it away from its parent."
//
// Measured before the fix, through the gestures below:
//   polygon    the copy was never linked ("not linked to the source"); a drag
//              of it left the source where it was
//   rectangle  linked, and a drag kept it so, but a width typed into the
//              source's badge did not reach the copy: 40 wide with a 5 mm copy,
//              typed 60, left the copy 50 wide INSIDE the source, and every
//              later solve kept it there (the offset is one unsigned distance a
//              side, which the flipped copy still satisfies)
//
// Everything here goes in through the Offset tool, the drag, the polygon's
// edit box and the size badge, and reads back what the user would see.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
const { prompts } = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock("../ui/prompt", () => ({ setPrompt: (m: string) => { prompts.push(m); } }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import { DimInput } from "./dimInput";
import { DocumentStore } from "../document/store";
import { solveSketchFeature } from "./headlessSolve";
import type { GeometryBackend } from "../geometry/client";
import { liveSketch, PX } from "./liveSketch.testkit";
import { compileAndSolve } from "./sketchSolve";
import { polygonPoints } from "./region";
import { contextMenu, type CtxItem } from "../ui/menu";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { CadDocument, Feature, ParamTarget, RebuildReply, SketchConstraint } from "../types";

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
// the store schedules its debounced rebuild off `window`
vi.stubGlobal("window", { setTimeout, clearTimeout });

type Poly = Extract<ResolvedEntity, { type: "polygon" }>;
type Rect = Extract<ResolvedEntity, { type: "rectangle" }>;

/** a hexagon well away from the origin, corner 0 straight right of its centre */
const HEX = (): Poly => ({ type: "polygon", id: "P", x: 50, y: 50, radius: 10, sides: 6, angle: 0 });
/** 40 x 20, well away from the origin */
const RECT = (): Rect => ({ type: "rectangle", id: "R", x: 60, y: 40, width: 40, height: 20 });
/** the circumradius whose sides sit `d` out from those of radius `r` */
const grown = (r: number, d: number, n = 6) => r + d / Math.cos(Math.PI / n);
/** the middle of side k of a polygon */
const sideMid = (p: Poly, k: number) => {
  const vs = polygonPoints(p.x, p.y, p.radius, p.sides, (p.angle * Math.PI) / 180);
  const a = vs[k]!, b = vs[(k + 1) % vs.length]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

/** a live sketch with the REAL on-canvas box, and the keystrokes that fill it */
function sketch(ents: ResolvedEntity[], cons: SketchConstraint[] = []) {
  const live = liveSketch(ents, cons);
  const dim = new DimInput();
  Object.assign(live.s, { dim });
  const enter = (name: string, text: string) => {
    const f = (dim as unknown as { fields: { def: { name: string }; input: FakeInput }[] }).fields.find((x) => x.def.name === name);
    if (!f) throw new Error(`no ${name} field in the box`);
    f.input.value = text;
    f.input.dispatch("input");
    f.input.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
  };
  const s = live.s as unknown as {
    editDimension(i: number, field: string, mm: number): void;
    editPolygon(id: string, at: { x: number; y: number }): void;
    requestSolve(): void;
    conflict: boolean;
  };
  /** the Offset tool: click the curve at `at`, type `dist`, Enter */
  const offset = async (at: { x: number; y: number }, dist: string) => {
    live.s.setTool("offset");
    live.click(at.x, at.y);
    enter("offset", dist);
    await live.settle();
    live.s.setTool("select");
  };
  /** the user's shapes, the copy included, by type */
  const shapes = <T extends ResolvedEntity["type"]>(type: T) =>
    live.s.entities.filter((e): e is Extract<ResolvedEntity, { type: T }> => e.type === type);
  /** a solve with nothing asked of it, the way the next edit anywhere runs one */
  const resolve = async () => { s.requestSolve(); await live.settle(); };
  return { ...live, enter, offset, shapes, resolve, internals: s };
}

const rightClick = (live: ReturnType<typeof sketch>, x: number, y: number) => {
  vi.mocked(contextMenu).mockClear();
  live.s.onContextMenu({ clientX: x * PX, clientY: y * PX, preventDefault() {} } as unknown as MouseEvent);
  return (vi.mocked(contextMenu).mock.calls.at(-1)?.[2] ?? []) as CtxItem[];
};

beforeEach(() => {
  toasts.length = 0;
  prompts.length = 0;
});

describe("a polygon's offset stays tied to the polygon", () => {
  it("is linked when it is made, and holds without anything over-constrained", async () => {
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    const [src, cpy] = live.shapes("polygon");
    expect(cpy!.radius).toBeCloseTo(grown(10, 5), 9);
    expect(toasts, "no 'not linked to the source' note").toEqual([]);
    const link = live.s.constraints.find((c) => c.type === "offset");
    expect(link).toMatchObject({ type: "offset", value: 5 });
    expect(link?.type === "offset" && link.pairs).toHaveLength(6);
    expect(live.s.overIdx.size, "nothing amber").toBe(0);
    // the source is free to move, turn and grow; the copy follows it
    expect(live.s.lastDof).toBe(4);
    expect(src).toEqual(HEX());
  });

  it("dragging the copy away takes the source with it", async () => {
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    const cpy = live.shapes("polygon")[1]!;
    const at = sideMid(cpy, 0);
    await live.drag([at.x, at.y], [at.x + 20, at.y]);
    const [s2, c2] = live.shapes("polygon");
    expect(c2!.x).toBeCloseTo(70, 6);
    expect(s2!.x, "the source came along").toBeCloseTo(70, 6);
    expect(s2!.y).toBeCloseTo(50, 6);
    expect(c2!.radius - s2!.radius).toBeCloseTo(grown(10, 5) - 10, 6);
  });

  it("dragging the source takes the copy with it", async () => {
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    const at = sideMid(HEX(), 1);
    await live.drag([at.x, at.y], [at.x, at.y + 20]);
    const [s2, c2] = live.shapes("polygon");
    expect(s2!.y).toBeCloseTo(70, 6);
    expect(c2!.y).toBeCloseTo(70, 6);
    expect(c2!.x).toBeCloseTo(50, 6);
  });

  it("follows a radius, a turn and a side count typed into the source's edit box", async () => {
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    live.internals.editPolygon("P", { x: 0, y: 0 });
    live.enter("radius", "20"); // the box takes all three; Enter commits what changed
    await live.settle();
    let [src, cpy] = live.shapes("polygon");
    expect(src!.radius).toBe(20);
    expect(cpy!.radius).toBeCloseTo(grown(20, 5), 9);

    live.internals.editPolygon("P", { x: 0, y: 0 });
    live.enter("sides", "8");
    await live.settle();
    [src, cpy] = live.shapes("polygon");
    expect(src!.sides).toBe(8);
    expect(cpy!.sides, "the copy has as many sides").toBe(8);
    expect(cpy!.radius).toBeCloseTo(grown(20, 5, 8), 6);
    expect(live.s.overIdx.size).toBe(0);
    expect(live.internals.conflict).toBe(false);

    live.internals.editPolygon("P", { x: 0, y: 0 });
    live.enter("angle", "15");
    await live.settle();
    [src, cpy] = live.shapes("polygon");
    expect(src!.angle).toBeCloseTo(15, 9);
    expect(cpy!.angle).toBeCloseTo(15, 6);

    // and it is still the source's offset afterwards: a drag of the copy
    // moves both
    const at = sideMid(cpy!, 2);
    await live.drag([at.x, at.y], [at.x - 10, at.y]);
    [src, cpy] = live.shapes("polygon");
    expect(src!.x).toBeCloseTo(40, 6);
    expect(cpy!.x).toBeCloseTo(40, 6);
    expect(cpy!.radius).toBeCloseTo(grown(20, 5, 8), 6);
  });

  it("a radius typed on the COPY's badge, or its side count, moves the source, and a solve keeps it", async () => {
    // Without the follow, the next solve held the source and put the copy
    // straight back to the radius it had.
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    const iCpy = live.s.entities.findIndex((e) => e.type === "polygon" && e.id !== "P");
    live.internals.editDimension(iCpy, "radius", 30);
    await live.resolve();
    const [src, cpy] = live.shapes("polygon");
    expect(cpy!.radius).toBe(30);
    expect(src!.radius).toBeCloseTo(30 - (grown(10, 5) - 10), 9);

    // and a side count typed into the copy's edit box reaches the source
    live.internals.editPolygon(cpy!.id, { x: 0, y: 0 });
    live.enter("sides", "5");
    await live.settle();
    const [s2, c2] = live.shapes("polygon");
    expect(c2!.sides).toBe(5);
    expect(s2!.sides).toBe(5);
    expect(s2!.radius).toBeCloseTo(30 - 5 / Math.cos(Math.PI / 5), 9);
    expect(live.s.overIdx.size).toBe(0);
  });

  it("a radius typed on a parameter-bound badge follows too, and one that would leave nothing is refused before it binds", async () => {
    // A bound badge commits through the expression path (commitEntityDimExpr),
    // which records the binding: a refusal has to come before that, or the
    // parameter would go on setting a size the sketch never took.
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "-5"); // inward: radius 10 - 5.77
    const s = live.s as unknown as {
      commitEntityDimExpr(i: number, field: string, raw: string): string | null;
      pendingBindings: Map<string, unknown>;
    };
    const iP = live.s.entities.findIndex((e) => e.id === "P");
    expect(s.commitEntityDimExpr(iP, "radius", "3")).toBe(t("sketch.offset.followCollapses"));
    expect(s.pendingBindings.has("e:P:radius")).toBe(false);
    expect(live.shapes("polygon")[0]!.radius).toBe(10);

    expect(s.commitEntityDimExpr(iP, "radius", "25")).toBeNull();
    const [src, cpy] = live.shapes("polygon");
    expect(src!.radius).toBe(25);
    expect(cpy!.radius).toBeCloseTo(grown(25, -5), 9);
  });

  it("still holds after the source is exploded to lines, without anything amber", async () => {
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    const at = sideMid(HEX(), 3);
    live.s.selected = new Set(["P"]);
    rightClick(live, at.x, at.y).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await live.settle();
    expect(live.shapes("polygon")).toHaveLength(1); // the copy
    expect(live.s.overIdx.size, "nothing amber").toBe(0);
    expect(live.internals.conflict).toBe(false);
    const cpy = live.shapes("polygon")[0]!;
    const c = sideMid(cpy, 0);
    await live.drag([c.x, c.y], [c.x + 20, c.y]);
    const ring = live.s.entities.find((e) => e.type === "circle" && e.construction && Math.abs(e.radius - 10) < 1e-6);
    expect(ring, "the source's corner circle is still radius 10").toBeDefined();
    expect(ring!.type === "circle" && ring!.x).toBeCloseTo(70, 6);
    expect(live.shapes("polygon")[0]!.x).toBeCloseTo(70, 6);
  });

  it("a parameter that grows the source past its copy takes the copy out with it", async () => {
    // The headless solve after a parameter edit starts from the source already
    // grown, the copy still inside it. The link is signed, and the side check
    // that refuses a flipped copy must not refuse the solve that unflips it.
    const src = { ...HEX(), radius: 20 };
    const cpy: Poly = { ...HEX(), id: "C", radius: grown(10, 5) };
    const pairs = [0, 1, 2, 3, 4, 5].map((k) => ({ src: `P~${k}`, cpy: `C~${k}` }));
    const r = await compileAndSolve([src, cpy], [{ type: "offset", pairs, value: 5 }], undefined, undefined, undefined, new Set(["P:radius"]));
    expect(r.conflicts).toEqual([]);
    expect(r.ok).toBe(true);
    const [s2, c2] = r.entities as Poly[];
    expect(s2!.radius).toBeCloseTo(20, 9);
    expect(c2!.radius).toBeCloseTo(grown(20, 5), 6);
  });
});

describe("a rectangle's offset follows a size typed into the rectangle", () => {
  it("typed width and height on the source: the copy stays 5 out all round, and a solve keeps it", async () => {
    const live = sketch([RECT()]);
    await live.offset({ x: 60, y: 30 }, "5");
    expect(live.shapes("rectangle")[1]).toMatchObject({ width: 50, height: 30 });
    const iR = live.s.entities.findIndex((e) => e.id === "R");
    live.internals.editDimension(iR, "width", 60);
    live.internals.editDimension(iR, "height", 30);
    await live.resolve();
    const [src, cpy] = live.shapes("rectangle");
    expect(src).toMatchObject({ x: 60, y: 40, width: 60, height: 30 });
    expect(cpy!.width).toBeCloseTo(70, 9);
    expect(cpy!.height).toBeCloseTo(40, 9);
    expect(cpy!.x).toBeCloseTo(60, 9);
    expect(cpy!.y).toBeCloseTo(40, 9);
  });

  it("typed on the copy: the source follows", async () => {
    const live = sketch([RECT()]);
    await live.offset({ x: 60, y: 30 }, "5");
    const iC = live.s.entities.findIndex((e) => e.type === "rectangle" && e.id !== "R");
    live.internals.editDimension(iC, "width", 80);
    await live.resolve();
    const [src, cpy] = live.shapes("rectangle");
    expect(cpy!.width).toBe(80);
    expect(src!.width).toBeCloseTo(70, 9);
    expect(src!.height).toBeCloseTo(20, 9);
  });

  it("an inward copy that a smaller source would leave with nothing refuses the size, and says so", async () => {
    const live = sketch([RECT()]);
    await live.offset({ x: 60, y: 30 }, "-5"); // inward: 30 x 10
    expect(live.shapes("rectangle")[1]).toMatchObject({ width: 30, height: 10 });
    const before = JSON.stringify(live.shapes("rectangle"));
    const iR = live.s.entities.findIndex((e) => e.id === "R");
    live.internals.editDimension(iR, "height", 8);
    expect(toasts).toEqual([t("sketch.offset.followCollapses")]);
    expect(JSON.stringify(live.shapes("rectangle"))).toBe(before);
  });
});

describe("an offset that was turned into lines follows a size typed into the shape", () => {
  // Explode turns a shape into lines, and so does a Fillet or a Chamfer on one
  // of its corners. Measured before the carry, a size typed into the shape
  // still at the other end of the link left those lines where they were, on
  // the wrong side of it, with nothing amber and no message: the hexagon's
  // filleted copy 5 mm INSIDE a source typed to radius 25, an exploded
  // source outside a copy typed to radius 8, a rectangle's filleted copy 50
  // wide inside a source typed 60 wide.
  type Line = Extract<ResolvedEntity, { type: "line" }>;
  /** how far the line `l` runs from the point (x, y) */
  const off = (l: Line, x: number, y: number) =>
    Math.abs((x - l.x1) * (l.y2 - l.y1) - (y - l.y1) * (l.x2 - l.x1)) / Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  const drawn = (live: ReturnType<typeof sketch>) =>
    live.s.entities.filter((e): e is Line => e.type === "line" && !e.construction && !e.id.startsWith("__"));
  /** Fillet: click two sides, type the radius */
  const fillet = async (live: ReturnType<typeof sketch>, a: { x: number; y: number }, b: { x: number; y: number }, r: string) => {
    live.s.setTool("fillet");
    live.click(a.x, a.y);
    live.click(b.x, b.y);
    live.enter("radius", r);
    await live.settle();
    live.s.setTool("select");
  };
  const explode = async (live: ReturnType<typeof sketch>, id: string, at: { x: number; y: number }) => {
    live.s.selected = new Set([id]);
    rightClick(live, at.x, at.y).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await live.settle();
  };
  /** every end of the arc `a` is an end of one of the lines */
  const joined = (a: ResolvedEntity, ls: Line[]) => {
    if (a.type !== "arc") return false;
    const ends = ls.flatMap((l) => [[l.x1, l.y1], [l.x2, l.y2]]);
    const meets = (x: number, y: number) => ends.some(([ex, ey]) => Math.hypot(ex! - x, ey! - y) < 1e-6);
    return meets(a.x1, a.y1) && meets(a.x2, a.y2);
  };

  it("a polygon's filleted copy stays 5 out of a radius typed on the source, and the source stays put", async () => {
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    const cpy = live.shapes("polygon")[1]!;
    await fillet(live, sideMid(cpy, 0), sideMid(cpy, 1), "1");
    expect(live.shapes("polygon").map((p) => p.id), "the copy is lines now").toEqual(["P"]);
    live.internals.editDimension(live.s.entities.findIndex((e) => e.id === "P"), "radius", 25);
    await live.resolve();
    expect(live.internals.conflict).toBe(false);
    expect(live.shapes("polygon")[0], "nothing pulled the source round").toEqual({ ...HEX(), radius: 25 });
    const ls = drawn(live);
    expect(ls).toHaveLength(6);
    for (const l of ls) expect(off(l, 50, 50)).toBeCloseTo(25 * Math.cos(Math.PI / 6) + 5, 6);
    const arc = live.s.entities.find((e) => e.type === "arc");
    expect(arc && joined(arc, ls), "the rounded corner still joins its two sides").toBe(true);
  });

  it("an exploded source follows a radius typed on its copy", async () => {
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    await explode(live, "P", sideMid(HEX(), 3));
    const iC = live.s.entities.findIndex((e) => e.type === "polygon");
    live.internals.editDimension(iC, "radius", 8);
    await live.resolve();
    expect(live.internals.conflict).toBe(false);
    const c = live.shapes("polygon")[0]!;
    expect(c).toMatchObject({ x: 50, y: 50, radius: 8, angle: 0 });
    const ls = drawn(live);
    expect(ls).toHaveLength(6);
    for (const l of ls) expect(off(l, 50, 50), "inside the copy, 5 in").toBeCloseTo(8 * Math.cos(Math.PI / 6) - 5, 6);
  });

  it("a new side count for a polygon whose copy is lines is refused, and says why", async () => {
    // Taken, the six lines were bent round eight sides, nothing amber.
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    await explode(live, live.shapes("polygon")[1]!.id, sideMid(live.shapes("polygon")[1]!, 3));
    const before = JSON.stringify(live.s.entities);
    live.internals.editPolygon("P", { x: 0, y: 0 });
    live.enter("sides", "8");
    await live.settle();
    expect(JSON.stringify(live.s.entities)).toBe(before);
    expect(prompts.at(-1)).toBe(t("sketch.polygonEdit.badValue", { error: t("sketch.offset.followSides") }));
  });

  it("a rectangle's filleted copy follows a width typed on the source, its rounded corner too", async () => {
    const live = sketch([RECT()]);
    await live.offset({ x: 60, y: 30 }, "5"); // copy 50 x 30: x 35..85, y 25..55
    await fillet(live, { x: 70, y: 25 }, { x: 85, y: 45 }, "3");
    live.internals.editDimension(live.s.entities.findIndex((e) => e.id === "R"), "width", 60);
    await live.resolve();
    expect(live.internals.conflict).toBe(false);
    expect(live.shapes("rectangle")).toEqual([{ ...RECT(), width: 60 }]);
    const ls = drawn(live);
    const xs = ls.flatMap((l) => [l.x1, l.x2]);
    expect(Math.min(...xs)).toBeCloseTo(25, 9);
    expect(Math.max(...xs), "5 out of the source's right side at 90").toBeCloseTo(95, 9);
    const arc = live.s.entities.find((e) => e.type === "arc");
    expect(arc && joined(arc, ls)).toBe(true);
  });
});

describe("a parameter that sets the shape takes its offset along too", () => {
  // Measured before: a side count set from the parameter table left the copy
  // a hexagon, turned 7.5 degrees and moved 5 mm off the octagon, nothing
  // amber; and a radius that left nothing of the inward copy said "geometry
  // left unchanged" over a source the parameter had already shrunk.
  const backend = {
    async rebuild(): Promise<RebuildReply> { return { ok: false, error: { message: "stub" } }; },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
  const PAIRS = [0, 1, 2, 3, 4, 5].map((k) => ({ src: `P~${k}`, cpy: `C~${k}` }));
  /** the hexagon and its offset by `d` in a closed sketch, field `field` of the
   *  hexagon set by parameter `n` */
  function closed(d: number, field: "sides" | "radius", value: number) {
    const doc = {
      parameters: { n: value },
      paramDefs: { n: { expr: String(value), value, unit: field === "sides" ? "count" : "mm", target: { kind: "entity", sketch: "f1", entity: "P", field } } },
      features: [{
        id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
        entities: [HEX(), { ...HEX(), id: "C", radius: grown(10, d) }],
        constraints: [{ type: "offset", pairs: PAIRS, value: d }],
      }],
    } as unknown as CadDocument;
    const store = new DocumentStore(backend, doc);
    store.headlessSolve = solveSketchFeature;
    const said: string[] = [];
    store.onWarning = (m) => void said.push(m);
    store.onParamSolveIssue = (id) => void said.push(t("status.sketchUnsatisfied", { id }));
    const set = async (expr: string) => {
      expect(store.setParamExpr("n", expr)).toBeNull();
      for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const sketchF = () => store.document.features[0] as Extract<Feature, { type: "sketch" }>;
    const poly = (id: string) => sketchF().entities.find((e) => e.id === id) as unknown as Poly;
    return { store, said, set, poly, sketchF };
  }

  it("closed sketch: a side count from the parameter table gives the copy as many sides", async () => {
    const c = closed(5, "sides", 6);
    await c.set("8");
    expect(c.poly("P").sides).toBe(8);
    expect(c.poly("C")).toMatchObject({ x: 50, y: 50, sides: 8, angle: 0 });
    expect(c.poly("C").radius).toBeCloseTo(grown(10, 5, 8), 9);
    const link = c.sketchF().constraints?.find((x) => x.type === "offset");
    expect(link?.type === "offset" && link.pairs.every((pr) => pr.src.slice(2) === pr.cpy.slice(2)), "side k with side k").toBe(true);
    expect(c.said).toEqual([]);
  });

  it("closed sketch: a radius that leaves nothing of the inward copy says that, not 'left unchanged'", async () => {
    const c = closed(-2, "radius", 10);
    await c.set("2");
    expect(c.poly("P").radius, "the parameter has set the shape").toBe(2);
    expect(c.said).toEqual([t("status.sketchNote", { id: "f1", note: t("sketch.offset.paramCollapses") })]);
  });

  it("open sketch: the session's parameter sync takes the copy along, and says when it cannot", async () => {
    const live = sketch([HEX()]);
    await live.offset(sideMid(HEX(), 0), "5");
    const cpyId = live.shapes("polygon")[1]!.id;
    let n = 8;
    const s = live.s as unknown as { store: unknown; editingId: string; pendingBindings: Map<string, unknown>; syncParamValues(): void };
    s.store = {
      document: { features: [] },
      boundExpr: (tg: ParamTarget) =>
        tg.kind === "entity" && tg.entity === "P" && tg.field === "sides" ? { name: "n", expr: String(n), value: n } : null,
    };
    s.editingId = "f1";
    s.syncParamValues();
    await live.settle();
    const [src, cpy] = live.shapes("polygon");
    expect(src!.sides).toBe(8);
    expect(cpy).toMatchObject({ id: cpyId, sides: 8 });
    expect(cpy!.radius).toBeCloseTo(grown(10, 5, 8), 9);
    expect(live.internals.conflict).toBe(false);

    // the copy turned into lines cannot take a side count: said, not bent
    await (async () => {
      live.s.selected = new Set([cpyId]);
      const at = sideMid(cpy!, 3);
      rightClick(live, at.x, at.y).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
      await live.settle();
    })();
    n = 5;
    toasts.length = 0;
    s.syncParamValues();
    await live.settle();
    expect(toasts).toEqual([t("sketch.offset.paramSides")]);
  });
});

describe("what is not a whole shape's offset is left to the solve", () => {
  it("a slot's offset is still a free copy, and says so", async () => {
    const slot: ResolvedEntity = { type: "slot", id: "S", x1: 30, y1: 30, x2: 60, y2: 30, width: 8 };
    const live = sketch([slot]);
    await live.offset({ x: 45, y: 34 }, "2");
    expect(live.s.constraints).toEqual([]);
    expect(toasts).toEqual([t("sketch.offset.rigidCopy")]);
  });
});
