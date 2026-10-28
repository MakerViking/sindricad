// A shape with no size draws nothing and the engine refuses its whole sketch
// (field 7ff177f8: a 0x0 rectangle from two clicks on one spot blocked both of
// Paul's extrudes). Two routes in: the tool must not commit one, and closing a
// sketch that already holds one must remove it, which is what the engine's
// message tells the user to do. The finish() test runs Paul's own sketch.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

const toasts: string[] = [];
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));

import { SketchMode } from "./sketchMode";
import { SketchPlane } from "./plane";
import { constraintNames, droppableZeroSize, isZeroSize } from "./zeroSize";
import type { ResolvedEntity } from "./snap";
import type { CadDocument, Feature, PlaneDef } from "../types";

(globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
(globalThis as unknown as { document: unknown }).document ??= {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};

const rect = (id: string, w: number, h: number): ResolvedEntity => ({ type: "rectangle", id, x: 1, y: 2, width: w, height: h });

describe("isZeroSize", () => {
  it("catches a rectangle, circle or line with no size, and nothing else", () => {
    expect(isZeroSize(rect("r", 0, 0))).toBe(true);
    expect(isZeroSize(rect("r", 10, 0))).toBe(true);
    expect(isZeroSize(rect("r", 10, 5e-5))).toBe(true);
    expect(isZeroSize(rect("r", 10, 2))).toBe(false);
    expect(isZeroSize({ type: "circle", id: "c", x: 0, y: 0, radius: 0 })).toBe(true);
    expect(isZeroSize({ type: "circle", id: "c", x: 0, y: 0, radius: 0.5 })).toBe(false);
    expect(isZeroSize({ type: "line", id: "l", x1: 3, y1: 3, x2: 3, y2: 3 })).toBe(true);
    expect(isZeroSize({ type: "line", id: "l", x1: 3, y1: 3, x2: 4, y2: 3 })).toBe(false);
  });

  it("drops only what no constraint names, a part of it included", () => {
    const ents = [rect("e0", 0, 0), rect("e1", 0, 0), rect("e2", 0, 0), rect("e3", 5, 5)];
    const cons = [{ type: "coincident", e1: "e1", e2: "e3", p1: 0, p2: 0 }, { type: "distance", a: "e2~1", b: "e3" }];
    expect(droppableZeroSize(ents, cons).map((e) => e.id)).toEqual(["e0"]);
    expect(constraintNames({ type: "x", a: "e10" }, "e1")).toBe(false); // e10 is not e1
  });
});

// Paul's sketch f2 from report 7ff177f8, trimmed to what matters: the 0x0
// rectangle e0, a real rectangle, a circle and the one tangency he had.
const PAUL: Extract<Feature, { type: "sketch" }> = {
  id: "f2", type: "sketch", plane: { xdir: [1, 0, 0], normal: [0, 0, 1], origin: [0, 0, 30] }, planeId: "f1",
  entities: [
    { x: 24.1322105835406, y: 34.85310819075543, id: "e0", type: "rectangle", width: 0, height: 0 },
    { x: -37.991926121384864, y: 18.221449545342313, id: "e1", type: "rectangle", width: 60.330526458851494, height: 28.045542029520156 },
    { x: -6.590874719375587, y: 34.86701102709557, id: "e6", type: "circle", radius: 13.81510118527907 },
    { id: "e7", x1: -31.958873475500457, x2: 22.82776676821295, y1: 56.05032018981214, y2: 41.21227179047197, type: "line" },
  ],
  constraints: [{ a: "e6", b: "e7", type: "tangent2" }],
} as unknown as Extract<Feature, { type: "sketch" }>;

function makeSketch(doc: CadDocument) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  Object.assign(s, {
    fonts: ["stub"], entities: [], constraints: [], patterns: [], selected: new Set<string>(),
    pendingBindings: new Map<string, unknown>(), history: { reset() {} },
    patternFlow: { resetForEnter() {}, flushOnFinish() {} },
    overlay: {
      planeFor: (spec: PlaneDef | string) => new SketchPlane(spec as PlaneDef),
      clearRegionSelection() {}, update() {}, setActiveSketch() {}, setActiveRegions() {}, setPreview() {}, setSnap() {},
    },
    viewport: {
      suspendPicking: false, enterSketchView() {}, exitSketchView() {}, hoverEntity() {},
      rig: { setOrbitLocked() {} }, domElement: { addEventListener() {}, removeEventListener() {} }, onZoomScale: null,
    },
    dim: { hide() {} }, dims: { hide() {} }, glyphs: { hide() {} }, textPanel: { hide() {} }, projectPanel: { hide() {} },
    constraintTools: { resetPending() {} },
    addGrid() {}, removeGrid() {}, refreshActive() {}, armPreEdit() {}, setTool() {}, setViewLocked() {},
    requestSolve() {}, resetDimPicks() {}, drainBindings: () => undefined, viewLocked: false,
  });
  const store = {
    document: doc, nextId: () => "s99",
    addFeature(f: Feature) { doc.features.push(f); },
    replaceFeature(id: string, f: Feature) { const i = doc.features.findIndex((x) => x.id === id); if (i >= 0) doc.features[i] = f; },
  };
  return { s, store: store as never };
}

describe("closing a sketch removes the shapes with no size", () => {
  let doc: CadDocument;
  beforeEach(() => {
    toasts.length = 0;
    doc = { version: 5, parameters: {}, features: [{ id: "f1", type: "datumPlane", plane: "XY", offset: 30 }, structuredClone(PAUL)] };
  });

  it("Paul's sketch: open it, close it, and the 0x0 rectangle is gone, everything else kept, and said", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PAUL.plane as PlaneDef, store, "f2", "f1");
    s.finish(true);
    const f = doc.features.find((x) => x.id === "f2") as Extract<Feature, { type: "sketch" }>;
    expect(f.entities.map((e) => e.id)).toEqual(["e1", "e6", "e7"]);
    expect(f.constraints).toEqual([{ a: "e6", b: "e7", type: "tangent2" }]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/Removed 1 shape with no size/);
  });

  it("keeps one a constraint names: a size bound to a parameter set to 0 is on purpose", () => {
    const held = structuredClone(PAUL);
    (held.constraints as unknown[]).push({ type: "coincident", e1: "e0", e2: "e1", p1: 0, p2: 0 });
    doc.features[1] = held;
    const { s, store } = makeSketch(doc);
    s.enter(held.plane as PlaneDef, store, "f2", "f1");
    s.finish(true);
    const f = doc.features.find((x) => x.id === "f2") as Extract<Feature, { type: "sketch" }>;
    expect(f.entities.map((e) => e.id)).toContain("e0");
    expect(toasts).toHaveLength(0);
  });

  it("Cancel removes nothing (it commits nothing)", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PAUL.plane as PlaneDef, store, "f2", "f1");
    s.finish(false);
    const f = doc.features.find((x) => x.id === "f2") as Extract<Feature, { type: "sketch" }>;
    expect(f.entities.map((e) => e.id)).toContain("e0");
  });
});

describe("the drawing tools do not commit a shape with no size", () => {
  /** commitFromCursor, the real one, with only the dimension box stubbed */
  function drawing(tool: "rectangle" | "circle" | "line", typedZero = false) {
    const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
    Object.assign(s, {
      tool, base: new THREE.Vector2(5, 5), entities: [], constraints: [], constructionMode: false,
      dim: {
        isUserDriven: (n: string) => typedZero && (n === "width" || n === "diameter" || n === "length"),
        getValue: () => 0,
        hide() {},
      },
      entityCurve: () => null,
    });
    return s;
  }

  for (const tool of ["rectangle", "circle", "line"] as const) {
    it(`${tool}: a second click on the first one's spot keeps the first click and adds nothing`, () => {
      toasts.length = 0;
      const s = drawing(tool);
      (s as unknown as { commitFromCursor(p: THREE.Vector2): void }).commitFromCursor(new THREE.Vector2(5, 5));
      expect((s as unknown as { entities: unknown[] }).entities).toHaveLength(0);
      expect((s as unknown as { base: THREE.Vector2 | null }).base).not.toBeNull();
      expect(toasts).toHaveLength(0); // a double click is just a double click
    });
  }

  it("a typed 0 never reaches the check: the typed-value guard refuses it first", () => {
    toasts.length = 0;
    const s = drawing("rectangle", true);
    (s as unknown as { commitFromCursor(p: THREE.Vector2): void }).commitFromCursor(new THREE.Vector2(9, 9));
    expect((s as unknown as { entities: unknown[] }).entities).toHaveLength(0);
  });
});
