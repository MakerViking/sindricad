// Editing a sketch dimension from the INSPECTOR (field report 8b49c06e): "the
// parameters panel on the right changes the number but does not adjust attached
// circles", and doing it while the sketch is open changes nothing at all.
//
// The panel used to write raw coordinates into the document feature and stop
// there — no driving constraint, no solve — so anything held to the edited
// entity by a constraint stayed exactly where it was. Both halves are observed
// here through the REAL Inspector, the REAL DocumentStore and the REAL solver:
// the geometry that comes out, not the call that went in.
import { describe, it, expect, beforeEach, vi } from "vitest";

declare const process: { cwd(): string };
// the wasm `?url` import resolves root-relative under vitest (see
// sketch/sketchSolve.test.ts) — point the loader at the file on disk
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import * as THREE from "three";
import { FakeEl, fakeFocus, installFakeDocument } from "./fakeDom.testkit";
import { setUnit } from "./units";
import { Inspector } from "./inspector";
import { DocumentStore } from "../document/store";
import { solveSketchFeature } from "../sketch/headlessSolve";
import { SolverUnavailable } from "../sketch/solver";
import { arcCenterRadius } from "../sketch/arc";
import { constraintDims } from "../sketch/entityDims";
import { liveSketch } from "../sketch/liveSketch.testkit";
import type { SketchMode } from "../sketch/sketchMode";
import type { ResolvedEntity } from "../sketch/snap";
import type { CadDocument, Feature, RebuildReply, SketchConstraint } from "../types";
import type { GeometryBackend } from "../geometry/client";
import mainSrc from "../main.ts?raw";

installFakeDocument();
// the store schedules its debounced rebuild off `window`
vi.stubGlobal("window", { setTimeout, clearTimeout });

const backend = (): GeometryBackend => ({
  async rebuild(): Promise<RebuildReply> {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus() { return () => {}; },
  connected: true,
} as unknown as GeometryBackend);

/** The reporter's shape, minimised: a line with a circle tangent to it. Moving
 *  the circle's diameter must move the circle so the tangency still holds. */
const doc = (): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
      entities: [
        { id: "l1", type: "line", x1: -30, y1: -10, x2: 30, y2: -10 },
        { id: "c1", type: "circle", x: 0, y: 0, radius: 10 },
        { id: "r1", type: "rectangle", x: 40, y: 40, width: 20, height: 8 },
      ],
      constraints: [
        { type: "fix", e: "l1", p: 0 },
        { type: "fix", e: "l1", p: 1 },
        { type: "tangent2", a: "l1", b: "c1" },
      ] as SketchConstraint[],
    },
  ] as Feature[],
});

/** What a <label> reads, its own text and its spans' (a sketch dimension's
 *  label is the parameter's name, when it has one, then what it measures). */
const text = (el: FakeEl): string => el.textContent + el.children.map(text).join("");

/** Every parameter row in the panel, in order. */
function paramRows(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.className.split(" ").includes("param-row")) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

const labelOf = (row: FakeEl): FakeEl => row.children.find((c) => c.tagName === "label")!;

/** The first row whose <label> reads `label`. */
function row(root: FakeEl, label: string): FakeEl {
  const hit = paramRows(root).find((r) => text(labelOf(r)) === label);
  if (!hit) throw new Error(`no "${label}" row in the panel: ${paramRows(root).map((r) => text(labelOf(r))).join(" | ")}`);
  return hit;
}

/** The rendered input of the first row whose <label> reads `label`. */
function input(root: FakeEl, label: string): FakeEl {
  return row(root, label).children.find((c) => c.tagName === "input")!;
}

const sketchOf = (store: DocumentStore) =>
  store.document.features.find((f) => f.id === "f1") as Extract<Feature, { type: "sketch" }>;

/** the named entity's numeric fields (it exists; a missing one is a test bug) */
function entity(store: DocumentStore, id: string): { x: number; y: number; radius: number; width: number } {
  const e = sketchOf(store).entities.find((x) => x.id === id);
  if (!e) throw new Error(`no entity ${id} in the sketch`);
  return e as unknown as { x: number; y: number; radius: number; width: number };
}

/** let the store's serialized commit chain (solve -> mutate) run out */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** the real Inspector on the real store, wired the way main.ts wires it */
function mount() {
  const store = new DocumentStore(backend(), doc());
  store.headlessSolve = solveSketchFeature;
  const root = new FakeEl("div");
  const inspector = new Inspector(root as unknown as HTMLElement, store);
  inspector.select("f1");
  return { store, root };
}

beforeEach(() => {
  fakeFocus.el = null;
});

describe("inspector: a sketch dimension edits like it does on the canvas", () => {
  it("re-solves, so the tangent circle follows the typed diameter", async () => {
    const { store, root } = mount();
    const row = input(root, "Circle 1 · Diameter mm");
    row.value = "30";
    row.dispatch("change");
    await settle();

    const c = entity(store, "c1");
    // the typed value survives the solve (a raw radius write is a free variable
    // to the solver and comes back out as ~11.28)
    expect(c.radius).toBeCloseTo(15, 6);
    // ...and the circle MOVED so it still touches the line: the report's
    // "does not adjust attached circles"
    const gap = Math.abs(Math.abs(c.y - -10) - c.radius);
    expect(gap).toBeLessThan(1e-6);
    // the value is a driving dimension now, not just coordinates that happen to
    // look right — a raw-write regression must fail here too
    const dim = (sketchOf(store).constraints ?? []).find((k) => k.type === "diameter");
    expect(dim).toEqual({ type: "diameter", id: expect.any(String), circle: "c1", value: 30 });
  });

  it("still writes the dimensions that have no constraint form", async () => {
    // rectangle W/H (and slot/polygon) stay coordinate writes on both edit
    // paths — the panel must keep working for them.
    const { store, root } = mount();
    const row = input(root, "Rectangle 1 · Width mm");
    row.value = "26";
    row.dispatch("change");
    await settle();
    expect(entity(store, "r1").width).toBe(26);
  });

  it("applies the value directly where no solver will start", async () => {
    // A machine whose planegcs WASM refuses to compile (0.1.100, Windows
    // WebView2) has nothing to drive the new constraint, and "typed a number,
    // nothing happened" is the exact bug directDims exists to prevent.
    //
    // The shape here is the one the app actually reaches: main.ts:184 assigns
    // headlessSolve unconditionally, so a dead solver is an ASSIGNED
    // headlessSolve that fails — not a missing one. solveSketchFeature raises
    // SolverUnavailable for it (headlessSolve.test.ts pins that link).
    const { store, root } = mount();
    store.headlessSolve = async () => {
      throw new SolverUnavailable(new EvalError("unsafe-eval is not an allowed source of script"));
    };
    const row = input(root, "Circle 1 · Diameter mm");
    row.value = "30";
    row.dispatch("change");
    await settle();
    expect(entity(store, "c1").radius).toBe(15);
    expect((sketchOf(store).constraints ?? []).some((k) => k.type === "diameter")).toBe(true);
  });

  it("leaves the geometry alone when the solve FAILS rather than being absent", async () => {
    // The other side of the guard above, and the trap it has to avoid: a solve
    // that ran and could not satisfy the sketch says nothing about where the
    // circle should go, so writing the diameter in anyway would put geometry
    // where the user never asked (applyDrivingDimsDirect's own warning). The
    // constraint is still recorded, as it is on the canvas, and the user hears.
    const { store, root } = mount();
    store.headlessSolve = async () => null; // ran, conflicted
    const issues: string[] = [];
    store.onParamSolveIssue = (id) => issues.push(id);
    const row = input(root, "Circle 1 · Diameter mm");
    row.value = "30";
    row.dispatch("change");
    await settle();
    expect(entity(store, "c1").radius).toBe(10);
    expect((sketchOf(store).constraints ?? []).some((k) => k.type === "diameter")).toBe(true);
    expect(issues).toEqual(["f1"]);
  });

  it("hands the edit to the live session instead of writing an open sketch", async () => {
    // SketchMode copies the entities at enter() and writes its own back at
    // finish(), so a document write here is invisible while typing and thrown
    // away on Finish.
    const { store, root } = mount();
    store.openSketchId = () => "f1";
    const routed: unknown[] = [];
    store.onSketchDimEdit = (...args) => routed.push(args);
    const before = JSON.stringify(sketchOf(store));

    const row = input(root, "Circle 1 · Diameter mm");
    row.value = "30";
    row.dispatch("change");
    await settle();

    expect(JSON.stringify(sketchOf(store)), "the document copy of an open sketch was written").toBe(before);
    expect(routed).toEqual([["f1", "c1", "diameter", 30]]);
  });

  it("still refuses to write the document if the sketch is opened mid-solve", async () => {
    // The solve is awaited, so "is this sketch open?" can change under it. The
    // answer that matters is the one at write time: SketchMode has copied the
    // entities by then and finish() will write its own back over anything left
    // here.
    const { store, root } = mount();
    let release = () => {};
    store.headlessSolve = async (f, p) => {
      await new Promise<void>((r) => { release = r; });
      return solveSketchFeature(f, p);
    };
    const before = JSON.stringify(sketchOf(store));

    const row = input(root, "Circle 1 · Diameter mm");
    row.value = "30";
    row.dispatch("change");
    await settle();
    store.openSketchId = () => "f1"; // the user opened it while the solve ran
    release();
    await settle();

    expect(JSON.stringify(sketchOf(store)), "the document copy of an open sketch was written").toBe(before);
  });

  it("main.ts hands that hook to the sketch session", () => {
    // The store side above proves the routing decision; whether anything is
    // LISTENING is main.ts wiring, which no unit test can run (SketchMode needs
    // a WebGL viewport). Pinned as source text, in the style of
    // ambientSelection.test.ts — an unwired hook means the edit vanishes.
    expect(mainSrc).toContain("store.onSketchDimEdit =");
    expect(mainSrc).toContain("sketch.applyDimensionEdit(entityId, field, mm)");
  });
});

describe("inspector: a rectangle's offset follows a size typed in the panel", () => {
  it("in a closed sketch, the copy stays 5 out all round (report 0fc1ceed)", async () => {
    // A coordinate write and then a solve, and the solve cannot put the copy
    // right: one unsigned distance a side is still met with the copy 30 wide
    // inside a source widened to 40.
    const store = new DocumentStore(backend(), {
      parameters: {},
      features: [
        {
          id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
          entities: [
            { id: "r1", type: "rectangle", x: 40, y: 40, width: 20, height: 8 },
            { id: "r2", type: "rectangle", x: 40, y: 40, width: 30, height: 18 },
          ],
          constraints: [{ type: "offset", pairs: [0, 1, 2, 3].map((k) => ({ src: `r1~${k}`, cpy: `r2~${k}` })), value: 5 }],
        },
      ] as Feature[],
    });
    store.headlessSolve = solveSketchFeature;
    const root = new FakeEl("div");
    new Inspector(root as unknown as HTMLElement, store).select("f1");
    const row = input(root, "Rectangle 1 · Width mm"); // the first rectangle's
    row.value = "40";
    row.dispatch("change");
    await settle();
    expect(entity(store, "r1").width).toBe(40);
    expect(entity(store, "r2").width).toBeCloseTo(50, 9);
    expect(entity(store, "r2").x).toBeCloseTo(40, 9);
  });

  it("and so does a copy that was turned into lines", async () => {
    // The copy as Explode (or a Fillet on its corner) leaves it: four lines,
    // each tied to its side of the rectangle. Before, the lines stayed 30 wide
    // inside a source widened to 40.
    const L = (id: string, x1: number, y1: number, x2: number, y2: number) => ({ id, type: "line", x1, y1, x2, y2 });
    const store = new DocumentStore(backend(), {
      parameters: {},
      features: [
        {
          id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
          entities: [
            { id: "r1", type: "rectangle", x: 40, y: 40, width: 20, height: 8 },
            L("b", 25, 31, 55, 31), L("r", 55, 31, 55, 49), L("t", 55, 49, 25, 49), L("l", 25, 49, 25, 31),
          ],
          constraints: [
            { type: "offset", pairs: ["b", "r", "t", "l"].map((cpy, k) => ({ src: `r1~${k}`, cpy })), value: 5 },
            { type: "horizontal", line: "b" }, { type: "vertical", line: "r" },
            { type: "horizontal", line: "t" }, { type: "vertical", line: "l" },
          ],
        },
      ] as Feature[],
    });
    store.headlessSolve = solveSketchFeature;
    const root = new FakeEl("div");
    new Inspector(root as unknown as HTMLElement, store).select("f1");
    const row = input(root, "Rectangle 1 · Width mm");
    row.value = "40";
    row.dispatch("change");
    await settle();
    expect(entity(store, "r1").width).toBe(40);
    const xs = sketchOf(store).entities.flatMap((e) => (e.type === "line" ? [Number(e.x1), Number(e.x2)] : []));
    expect(Math.min(...xs)).toBeCloseTo(15, 9);
    expect(Math.max(...xs), "5 out of the source's right side at 60").toBeCloseTo(65, 9);
  });
});

// ---------------------------------------------------------------------------
// Named sketch dimensions (decision B10, report 9e9ae278): every row says whose
// dimension it is, a dimension becomes a parameter when the user NAMES it (and
// only then), and the panel and the canvas point at each other. Every sketch
// dimension is listed, including one placed on an arc (Paul, cac30e98).

/** A sketch whose dimensions are all constraints but the lines' lengths: an
 *  arc of radius 50 about the origin, a line to its start and a construction
 *  line square to it. */
const arcDoc = (): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
      entities: [
        { id: "a1", type: "arc", x1: 50, y1: 0, x2: 0, y2: 50, mx: 50 * Math.SQRT1_2, my: 50 * Math.SQRT1_2 },
        { id: "l1", type: "line", x1: 0, y1: 0, x2: 40, y2: 0 },
        { id: "l2", type: "line", x1: 0, y1: 0, x2: 0, y2: 30, construction: true },
      ],
      constraints: [
        { type: "radius", id: "cr", e: "a1", value: 50 },
        { type: "angle", id: "ca", l1: "l1", l2: "l2", value: 90 },
        { type: "p2pDistance", id: "cp", e1: "l1", p1: 1, e2: "a1", p2: 0, value: 10 },
      ] as SketchConstraint[],
    },
  ] as Feature[],
});

/** Two parallel lines held by an offset, INWARD by default: the copy sits on
 *  the negative side, which is what the sign of the stored value says. */
const offsetLines = (value: number): ResolvedEntity[] => [
  { id: "l1", type: "line", x1: 0, y1: 0, x2: 40, y2: 0 } as ResolvedEntity,
  { id: "l2", type: "line", x1: 0, y1: value, x2: 40, y2: value } as ResolvedEntity,
];
const offsetOf = (value: number) => ({ type: "offset", id: "co", pairs: [{ src: "l1", cpy: "l2" }], value }) as SketchConstraint;
const offsetDoc = (value = -3): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
      entities: offsetLines(value),
      constraints: [offsetOf(value)],
    },
  ] as Feature[],
});

function mountDoc(d: CadDocument) {
  const store = new DocumentStore(backend(), d);
  store.headlessSolve = solveSketchFeature;
  const root = new FakeEl("div");
  const inspector = new Inspector(root as unknown as HTMLElement, store);
  inspector.select("f1");
  return { store, root, inspector };
}

const labels = (root: FakeEl) => paramRows(root).map((r) => text(labelOf(r)));
const keyEv = (key: string) => ({ key, isComposing: false, keyCode: 0, stopPropagation() {}, preventDefault() {} });

/** Double-click a row's label, type `name` into the box it becomes, Enter. */
function nameRow(root: FakeEl, label: string, name: string): FakeEl {
  const lab = labelOf(row(root, label));
  lab.dispatch("dblclick");
  const box = lab.children.find((c) => c.tagName === "input");
  if (!box) throw new Error(`double-clicking "${label}" opened no name box`);
  box.value = name;
  box.dispatch("keydown", keyEv("Enter"));
  return box;
}

const constraintOf = (store: DocumentStore, id: string) =>
  (sketchOf(store).constraints ?? []).find((c) => (c as { id?: string }).id === id) as (SketchConstraint & { value: number }) | undefined;

describe("inspector: a sketch dimension says whose it is", () => {
  it("names each row by its entity, and marks construction geometry", () => {
    const { store, root } = mountDoc(arcDoc());
    // listing reads the bindings without writing an empty table into a
    // document that has none (it would be saved: the file changes for nothing)
    expect(store.document.paramDefs).toBeUndefined();
    expect(labels(root)).toEqual([
      "Line 1 · Length mm",
      "Line 2 · Length mm (construction)",
      "Arc 1 · Radius mm",
      "Line 1 to Line 2 · Angle°",
      "Line 1 to Arc 1 · Distance mm",
    ]);
  });

  it("lists a dimension placed on an arc, with its value (cac30e98)", () => {
    const { root } = mountDoc(arcDoc());
    expect(input(root, "Arc 1 · Radius mm").value).toBe("50");
    expect(input(root, "Line 1 to Line 2 · Angle°").value).toBe("90");
  });

  it("re-solves the sketch when the arc's radius is typed", async () => {
    const { store, root } = mountDoc(arcDoc());
    const box = input(root, "Arc 1 · Radius mm");
    box.value = "60";
    box.dispatch("change");
    await settle();
    expect(constraintOf(store, "cr")?.value).toBe(60);
    const a = sketchOf(store).entities.find((e) => e.id === "a1") as unknown as { x1: number; y1: number; x2: number; y2: number; mx: number; my: number };
    expect(arcCenterRadius(a)?.r).toBeCloseTo(60, 5);
  });
});

describe("inspector: naming a sketch dimension makes it a parameter", () => {
  it("names a dimension from its label, and only that one becomes a parameter", async () => {
    const { store, root } = mount();
    nameRow(root, "Rectangle 1 · Width mm", "wall");
    await settle();

    const defs = store.document.paramDefs ?? {};
    expect(Object.keys(defs)).toEqual(["wall"]);
    // a rectangle's width has nothing holding it until it is named: naming
    // locks it, at the width it has, and the parameter drives that lock
    const target = defs.wall!.target as { kind: string; constraint: string };
    expect(target.kind).toBe("constraint");
    expect(constraintOf(store, target.constraint)).toMatchObject({ type: "distance", line: "r1~0", value: 20 });
    expect(defs.wall).toMatchObject({ expr: "20", value: 20 });
    expect(entity(store, "r1").width).toBe(20); // naming moves nothing
    // the row now carries the name, above what it measures
    expect(labels(root)).toContain("wallRectangle 1 · Width mm");
  });

  it("drives the geometry once named: changing the parameter resizes the rectangle", async () => {
    const { store, root } = mount();
    nameRow(root, "Rectangle 1 · Width mm", "wall");
    await settle();
    expect(store.setParamExpr("wall", "26")).toBeNull();
    await settle();
    expect(entity(store, "r1").width).toBeCloseTo(26, 6);
  });

  it("takes name=value typed into the value box (the canvas label's way)", async () => {
    const { store, root } = mount();
    const box = input(root, "Circle 1 · Diameter mm");
    box.value = "dia=30";
    box.dispatch("change");
    await settle();
    const def = store.document.paramDefs?.dia;
    expect(def).toMatchObject({ expr: "30", value: 30 });
    expect(constraintOf(store, (def!.target as { constraint: string }).constraint)).toMatchObject({ type: "diameter", circle: "c1", value: 30 });
    expect(entity(store, "c1").radius).toBeCloseTo(15, 6);
  });

  it("reads a formula typed in inches as inches, the way the canvas label does", async () => {
    setUnit("in");
    try {
      const { store, root } = mount();
      const box = input(root, "Rectangle 1 · Width in");
      box.value = "w=1/2";
      box.dispatch("change");
      await settle();
      // not half a millimetre: the engine reads a bare literal in mm
      expect(store.document.paramDefs?.w?.value).toBeCloseTo(12.7, 9);
      expect(entity(store, "r1").width).toBeCloseTo(12.7, 6);
    } finally {
      setUnit("mm");
    }
  });

  it("keeps the parameter when a number is typed into a named dimension", async () => {
    const { store, root } = mount();
    nameRow(root, "Rectangle 1 · Width mm", "wall");
    await settle();
    const box = input(root, "wallRectangle 1 · Width mm");
    box.value = "24";
    box.dispatch("change");
    await settle();
    expect(store.document.paramDefs?.wall).toMatchObject({ expr: "24", value: 24 });
    expect(entity(store, "r1").width).toBeCloseTo(24, 6);
  });

  it("renames the parameter a dimension already has", async () => {
    const { store, root } = mount();
    nameRow(root, "Rectangle 1 · Width mm", "wall");
    await settle();
    nameRow(root, "wallRectangle 1 · Width mm", "side");
    await settle();
    expect(Object.keys(store.document.paramDefs ?? {})).toEqual(["side"]);
    expect(labels(root)).toContain("sideRectangle 1 · Width mm");
  });

  it("refuses a name that is taken, and says why in the box", async () => {
    const { store, root } = mount();
    nameRow(root, "Rectangle 1 · Width mm", "wall");
    await settle();
    const box = nameRow(root, "Rectangle 1 · Height mm", "wall");
    expect(box.classList.contains("input-error")).toBe(true);
    expect(box.title).toMatch(/wall/);
    await settle();
    expect(Object.keys(store.document.paramDefs ?? {})).toEqual(["wall"]);
  });

  it("names a constraint dimension too: the arc's radius", async () => {
    const { store, root } = mountDoc(arcDoc());
    nameRow(root, "Arc 1 · Radius mm", "bend");
    await settle();
    expect(store.document.paramDefs?.bend).toMatchObject({ expr: "50", target: { kind: "constraint", sketch: "f1", constraint: "cr" } });
  });

  it("keeps an inward offset inward when it is named and retyped", async () => {
    // The offset SHOWS 3 and stores -3 (the sign is the side). A parameter
    // wrote its value straight onto the constraint, so naming it put +3 there
    // and the copy jumped to the other side.
    const { store, root } = mountDoc(offsetDoc());
    nameRow(root, "Line 1 to Line 2 · Offset mm", "gap");
    await settle();
    expect(store.document.paramDefs?.gap).toMatchObject({ expr: "3", value: 3 });
    expect(constraintOf(store, "co")?.value).toBe(-3);
    const box = input(root, "gapLine 1 to Line 2 · Offset mm");
    box.value = "4";
    box.dispatch("change");
    await settle();
    expect(constraintOf(store, "co")?.value).toBe(-4);
  });

  it("keeps an offset's side whatever sign its parameter takes", async () => {
    // A parameter sets the distance and never the side: written as it came, a
    // formula that went below zero flipped the copy across (and keeping only
    // an inward side, it then stayed inward for every value after).
    for (const side of [1, -1]) {
      const { store, root } = mountDoc(offsetDoc(3 * side));
      nameRow(root, "Line 1 to Line 2 · Offset mm", "gap");
      await settle();
      const seen: number[] = [];
      for (const v of ["-2", "2", "4"]) {
        expect(store.setParamExpr("gap", v)).toBeNull(); // Modify > Parameters
        await settle();
        seen.push(constraintOf(store, "co")!.value);
      }
      expect(seen).toEqual([2 * side, 2 * side, 4 * side]);
    }
  });

  it("names a dimension when its name box is left, as Tab or a click elsewhere leaves it", async () => {
    // Enter was the only way in: the name typed and then clicked away from
    // was thrown away, where every other box in the panel commits on leaving.
    const { store, root } = mount();
    const lab = labelOf(row(root, "Rectangle 1 · Width mm"));
    lab.dispatch("dblclick");
    const box = lab.children.find((c) => c.tagName === "input")!;
    box.value = "wall";
    box.dispatch("blur");
    await settle();
    expect(Object.keys(store.document.paramDefs ?? {})).toEqual(["wall"]);
    expect(labels(root)).toContain("wallRectangle 1 · Width mm");

    // Escape still puts the label back with nothing named
    const lab2 = labelOf(row(root, "Rectangle 1 · Height mm"));
    lab2.dispatch("dblclick");
    const box2 = lab2.children.find((c) => c.tagName === "input")!;
    box2.value = "tall";
    box2.dispatch("keydown", keyEv("Escape"));
    box2.dispatch("blur");
    await settle();
    expect(Object.keys(store.document.paramDefs ?? {})).toEqual(["wall"]);
  });
});

describe("inspector: the open sketch's dimensions, live", () => {
  /** A live sketch session (real SketchMode, real solves) wired to a real
   *  Inspector exactly the way main.ts wires the two. */
  function openSession(ents: ResolvedEntity[], cons: SketchConstraint[] = [], saved?: CadDocument) {
    const ls = liveSketch(ents, cons);
    const sm = ls.s as unknown as SketchMode;
    const lit: { objs: THREE.Object3D[]; key: string | null } = { objs: [], key: null };
    // `saved`: the session is a reopened f1 of that document; else a new sketch
    const store = new DocumentStore(backend(), saved ?? { parameters: {}, features: [] });
    store.openSketchId = () => sm.openDocId;
    store.onParamsApplied = () => sm.syncParamValues();
    Object.assign(ls.s, {
      store,
      editingId: saved ? "f1" : null,
      overlay: { ...(ls.s as unknown as { overlay: object }).overlay, setLinkHighlight: (o: THREE.Object3D[]) => { lit.objs = o; } },
      dims: { ...(ls.s as unknown as { dims: object }).dims, highlight: (k: string | null) => { lit.key = k; } },
    });
    const root = new FakeEl("div");
    const inspector = new Inspector(root as unknown as HTMLElement, store);
    inspector.liveSketch = () => {
      const v = sm.panelDims();
      return v && {
        ...v,
        selected: sm.selectedIds,
        binding: sm.panelBindings(),
        commit: (r, raw) => sm.commitPanelDim(r, raw),
        rename: (r, n) => sm.namePanelDim(r, n),
      };
    };
    inspector.onDimHover = (_id, r) => sm.highlightPanelDim(r);
    sm.onDimsChanged = () => inspector.sketchChanged();
    sm.onSelectionChange = () => inspector.sketchSelectionChanged(sm.selectedIds);
    inspector.refresh();
    return { ...ls, sm, store, root, inspector, lit };
  }

  const arc = (): ResolvedEntity => ({ id: "a1", type: "arc", x1: 50, y1: 0, x2: 0, y2: 50, mx: 50 * Math.SQRT1_2, my: 50 * Math.SQRT1_2 }) as ResolvedEntity;
  const rect = (): ResolvedEntity => ({ id: "r1", type: "rectangle", x: 40, y: 40, width: 20, height: 8 }) as ResolvedEntity;

  it("lists a dimension added on an arc in the open sketch, and edits it there", async () => {
    // Paul's report: the dimension was placed with the sketch open, and the
    // panel listed the document's copy, which does not have it until Finish.
    const o = openSession([arc()]);
    expect(labels(o.root)).toEqual([]);
    o.s.constraints.push({ type: "radius", id: "cr", e: "a1", value: 50 });
    o.inspector.sketchChanged(); // what the session's refresh does (onDimsChanged)
    expect(labels(o.root)).toEqual(["Arc 1 · Radius mm"]);

    const box = input(o.root, "Arc 1 · Radius mm");
    box.value = "60";
    box.dispatch("change");
    await o.settle();
    const a = o.ent("a1") as unknown as { x1: number; y1: number; x2: number; y2: number; mx: number; my: number };
    expect(arcCenterRadius(a)?.r).toBeCloseTo(60, 5);
    expect(o.store.document.features).toEqual([]); // the session's copy, not the document's
  });

  it("names a dimension in the session, to land with the sketch at Finish", async () => {
    const o = openSession([rect()]);
    nameRow(o.root, "Rectangle 1 · Width mm", "wall");
    await o.settle();
    const lockC = o.s.constraints.find((c) => c.type === "distance") as SketchConstraint & { id: string; line: string; value: number };
    expect(lockC).toMatchObject({ line: "r1~0", value: 20 });
    const pending = (o.s as unknown as { pendingBindings: Map<string, unknown> }).pendingBindings;
    expect([...pending]).toEqual([[`c:${lockC.id}`, { expr: "20", kind: "length", name: "wall" }]]);
    expect(o.store.document.paramDefs).toBeUndefined(); // nothing written before Finish
    expect(labels(o.root)).toContain("wallRectangle 1 · Width mm");
  });

  it("keeps an inward offset inward when its parameter changes with the sketch open", async () => {
    // Modify > Parameters while the sketch is open: the session takes the new
    // value (syncParamValues), which wrote it straight onto the offset, so
    // the copy jumped to the other side.
    const d = offsetDoc(-3);
    d.paramDefs = { gap: { expr: "3", value: 3, unit: "mm", target: { kind: "constraint", sketch: "f1", constraint: "co" } } };
    const o = openSession(offsetLines(-3), [offsetOf(-3)], d);
    expect(labels(o.root)).toContain("gapLine 1 to Line 2 · Offset mm");
    expect(o.store.setParamExpr("gap", "5")).toBeNull();
    await settle(); // the parameter commit lands
    await o.settle(); // and the session re-solves
    expect((o.s.constraints[0] as { value: number }).value).toBe(-5);
  });

  it("says a name given in this session works in other values once the sketch is finished", async () => {
    // Named in the open sketch, the name is not in the document until Finish,
    // and the engine called it an unknown parameter, as if naming had failed.
    const o = openSession([rect(), { id: "l1", type: "line", x1: 0, y1: -10, x2: 30, y2: -10 } as ResolvedEntity]);
    nameRow(o.root, "Rectangle 1 · Width mm", "wall");
    await o.settle();
    const box = input(o.root, "Line 1 · Length mm");
    box.value = "wall/2";
    box.dispatch("change");
    expect(box.classList.contains("input-error")).toBe(true);
    expect(box.title).toBe('"wall" is named in this sketch, and other values can use it once the sketch is finished');
    const pending = (o.s as unknown as { pendingBindings: Map<string, unknown> }).pendingBindings;
    expect(pending.size).toBe(1); // only the name; the formula bound nothing
  });

  it("takes a formula on a rectangle's width, as its canvas label now does", async () => {
    const o = openSession([rect()]);
    const box = input(o.root, "Rectangle 1 · Width mm");
    box.value = "w=30";
    box.dispatch("change");
    await o.settle();
    expect(box.classList.contains("input-error")).toBe(false);
    expect((o.ent("r1") as unknown as { width: number }).width).toBeCloseTo(30, 6);
    expect(o.sm.panelBindings()(o.sm.panelDims()!.rows.find((r) => r.key === "e:r1:width")!)).toEqual({ expr: "30", name: "w" });
  });

  it("lights up a row's geometry and its label while the row is pointed at", () => {
    const o = openSession([rect(), arc()]);
    const r = row(o.root, "Rectangle 1 · Width mm");
    r.dispatch("mouseenter");
    expect(o.lit.key).toBe("e:r1:width");
    expect(o.lit.objs.map((x) => x.userData.entityId)).toEqual(["r1"]);
    r.dispatch("mouseleave");
    expect(o.lit.key).toBeNull();
    expect(o.lit.objs).toEqual([]);
  });

  it("marks the rows of what is selected on the canvas", () => {
    const o = openSession([rect(), { id: "l1", type: "line", x1: 0, y1: -10, x2: 30, y2: -10 } as ResolvedEntity]);
    // the selection is drawn through activeCurves, which is where it is noticed
    Object.assign(o.s, {
      refreshActive: () => (o.s as unknown as { activeCurves(d: unknown[]): unknown }).activeCurves([]),
      viewport: { ...(o.s as unknown as { viewport: object }).viewport, pixelWorldSize: () => 0.1 },
    });
    o.click(15, -10); // on the line
    const marked = paramRows(o.root).filter((r) => r.classList.contains("param-row-linked")).map((r) => text(labelOf(r)));
    expect(marked).toEqual(["Line 1 · Length mm"]);
    o.click(-50, -50); // empty space
    expect(paramRows(o.root).some((r) => r.classList.contains("param-row-linked"))).toBe(false);
  });

  it("applies a number typed into an arc's diameter label on the canvas", () => {
    // The label showed the arc's diameter and took the edit, but its commit
    // wrote only the placed dimensions, which an arc's diameter is not.
    const o = openSession([arc()], [{ type: "diameter", id: "cd", circle: "a1", value: 100 }]);
    const internals = o.s as unknown as { cdims: unknown; constraintDimExtras(): { key?: string; commit(v: number): void }[] };
    internals.cdims = constraintDims(o.s.entities, o.s.constraints);
    internals.constraintDimExtras().find((x) => x.key === "c:cd")!.commit(80);
    expect((o.s.constraints[0] as { value: number }).value).toBe(80);
  });

  it("main.ts wires the panel and the sketcher both ways", () => {
    expect(mainSrc).toContain("inspector.liveSketch = () =>");
    expect(mainSrc).toContain("inspector.onDimHover = (sketchId, row) =>");
    expect(mainSrc).toContain("sketch.onDimsChanged = () => inspector.sketchChanged();");
    expect(mainSrc).toContain("sketch.onSelectionChange = () => inspector.sketchSelectionChanged(sketch.selectedIds);");
  });
});
