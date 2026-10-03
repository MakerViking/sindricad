// Arithmetic in a dimension box, and the unit it is read in.
//
// A user with years of CAD experience asked to type `31.53+2*1.62` for an
// overall 34.77 ("if I know the wall thickness I need and the inside dimension
// required"), or `176.3-21.43` degrees for 154.87. The on-canvas boxes read a
// bare number only and refused the expression.
//
// The unit rule (ui/units.fieldExpr) is the part with a measured failure behind
// it. In inches, typing `1/16` into a SKETCH dimension stored 0.0625 mm: the
// sketch editor hands any non-number to the parameters engine, which reads a
// bare literal in millimetres. And `1/16 in` stored 1/(16 in), because the
// engine binds a unit suffix to the literal right before it. Bare arithmetic now
// reads in the display unit, a trailing unit applies to the whole expression,
// and a named parameter stays canonical.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { FakeEl, byClass, installFakeDocument } from "./fakeDom.testkit";
import { fieldExpr, parseFieldExpr, parseField, setUnit, getUnit, setFieldParams } from "./units";
import { evalExpr } from "../params/eval";
import type { CadDocument, Feature, RebuildReply } from "../types";
import type { GeometryBackend } from "../geometry/client";
import type { Viewport } from "../viewport/viewport";

installFakeDocument();
// the store's debounced rebuild timer
(globalThis as unknown as { window: unknown }).window ??= { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

const { DimInput } = await import("../sketch/dimInput");
const { SketchDimensions } = await import("../sketch/sketchDimensions");
const { SketchMode } = await import("../sketch/sketchMode");
const { SketchPlane } = await import("../sketch/plane");
const { DocumentStore } = await import("../document/store");

const startUnit = getUnit();
afterEach(() => setUnit(startUnit));

const SIXTEENTH = 25.4 / 16; // 1.5875 mm

describe("the reporter's own examples", () => {
  beforeEach(() => setUnit("mm"));

  it("31.53+2*1.62 is 34.77", () => {
    expect(parseField("31.53+2*1.62"), "a plain-number parse must still refuse an expression").toBeNull();
    expect(parseFieldExpr("31.53+2*1.62")).toBeCloseTo(34.77, 9);
  });

  it("176.3-21.43 degrees is 154.87", () => {
    expect(parseFieldExpr("176.3-21.43", "angle")).toBeCloseTo(154.87, 9);
  });
});

describe("what counts as a number", () => {
  beforeEach(() => setUnit("mm"));

  it("still takes a plain literal, either decimal separator", () => {
    expect(parseFieldExpr("34.77")).toBe(34.77);
    expect(parseFieldExpr("12,5")).toBe(12.5);
    expect(parseFieldExpr("2,5*2")).toBe(5);
  });

  it("resolves parameter names from the document", () => {
    expect(parseFieldExpr("wall*2", "length", { wall: 1.62 })).toBeCloseTo(3.24, 9);
  });

  it("REFUSES rather than guessing", () => {
    for (const bad of ["", "   ", "abc", "31.53+", "wall*2", "1/0", "((1+2)", "2*in"]) {
      expect(parseFieldExpr(bad), `"${bad}" should not resolve to a number`).toBeNull();
    }
  });

  it("an unknown name is a refusal, not a zero", () => {
    expect(parseFieldExpr("thicknes*2", "length", { thickness: 2 })).toBeNull();
  });
});

describe("units", () => {
  it("bare arithmetic reads in the DISPLAY unit, like a plain number", () => {
    setUnit("in");
    expect(parseFieldExpr("2")).toBe(50.8);
    expect(parseFieldExpr("1+1"), "a bare expression disagreed with the plain number 2").toBe(50.8);
    expect(parseFieldExpr("1/16"), "1/16 in inches read as a sixteenth of a millimetre").toBe(SIXTEENTH);
    setUnit("cm");
    expect(parseFieldExpr("2+3")).toBe(50);
  });

  it("a trailing unit applies to the WHOLE expression, in any display unit", () => {
    for (const u of ["mm", "cm", "in"] as const) {
      setUnit(u);
      expect(parseFieldExpr("1/16 in"), `"1/16 in" in ${u} mode`).toBe(SIXTEENTH);
      expect(parseFieldExpr("1/16in"), `"1/16in" in ${u} mode`).toBe(SIXTEENTH);
      expect(parseFieldExpr("(1+1) in"), `"(1+1) in" in ${u} mode`).toBe(50.8);
      expect(parseFieldExpr("5 mm"), `"5 mm" in ${u} mode`).toBe(5);
    }
  });

  it("an expression naming a parameter stays CANONICAL", () => {
    // A parameter's value is already mm; converting the literals around it would
    // scale half the expression and not the other half.
    setUnit("in");
    expect(parseFieldExpr("wall*2", "length", { wall: 10 })).toBe(20);
    expect(parseFieldExpr("wall+1", "length", { wall: 10 })).toBe(11);
  });

  it("literals that carry their own units are read one by one, as the engine does", () => {
    setUnit("in");
    expect(parseFieldExpr("1 in + 2 mm")).toBeCloseTo(27.4, 9);
  });

  it("angles are degrees whatever the display unit", () => {
    setUnit("in");
    expect(parseFieldExpr("90+45", "angle")).toBe(135);
    expect(parseFieldExpr("a*2", "angle", { a: 45 })).toBe(90);
  });

  it("what is STORED evaluates, through the canonical engine, to what was meant", () => {
    // A sketch dimension stores the expression and re-evaluates it on every
    // rebuild, so the stored text must not depend on the reader's unit setting.
    setUnit("in");
    const stored = fieldExpr("1/16")!;
    expect(stored).toBe("(1/16)*1 in");
    setUnit("mm");
    expect(evalExpr(stored, {})).toBe(SIXTEENTH);
    expect(fieldExpr("1/16 in")).toBe("(1/16)*1 in");
    // the millimetre user's expression is stored exactly as typed, as before
    expect(fieldExpr("31.53+2*1.62")).toBe("31.53+2*1.62");
    expect(fieldExpr("5 in")).toBe("5 in");
  });
});

// --- the dimension box on the canvas (extrude depth, fillet radius, ...) -----

const key = (k: string) => ({
  key: k, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  preventDefault() {}, stopPropagation() {},
});

function inputs(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "input") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

describe("the heads-up dimension box", () => {
  it("commits the expression's value, and resolves the document's parameters", () => {
    setUnit("mm");
    setFieldParams(() => ({ wall: 1.62 }));
    try {
      const box = new DimInput();
      const committed: Record<string, number>[] = [];
      box.show([{ name: "distance", label: "D" }], (v) => committed.push(v));
      const field = inputs((globalThis.document as unknown as { body: FakeEl }).body).at(-1)!;
      field.value = "31.53+2*wall";
      field.dispatch("input");
      field.dispatch("keydown", key("Enter"));
      expect(committed).toHaveLength(1);
      expect(committed[0]!.distance).toBeCloseTo(34.77, 9);
    } finally {
      setFieldParams(() => ({}));
    }
  });
});

// --- the sketch dimension editor, end to end in inches ----------------------

function stubBackend(): GeometryBackend {
  return {
    async rebuild(): Promise<RebuildReply> {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
}

/** A sketch with one 10 mm line and its driving length dimension, open in a
 *  SketchMode built off the prototype, with the REAL dimension labels (wired the
 *  way SketchMode's constructor wires them) and a REAL document store behind
 *  it. The badge is the line's length, the dimension a user clicks most. */
function sketchWithLengthDim() {
  const store = new DocumentStore(stubBackend(), { parameters: {}, features: [] } as CadDocument);
  const s = Object.create(SketchMode.prototype) as InstanceType<typeof SketchMode> & Record<string, unknown>;
  const line = { type: "line", id: "e1", x1: 0, y1: 0, x2: 10, y2: 0 };
  Object.assign(s, {
    active: true,
    plane: new SketchPlane("XY"),
    entities: [line],
    constraints: [],
    conflictIdx: new Set<number>(),
    overIdx: new Set<number>(),
    pendingBindings: new Map(),
    editingId: null,
    store,
    trial: null,
    pendingBias: null,
    solverDead: false,
    requestSolve() {},
    refreshActive() {},
    onState: null,
  });
  const viewport = {
    camera: new THREE.PerspectiveCamera(),
    projectToScreen: () => ({ x: 0, y: 0 }),
    projectToOverlay: () => ({ x: 0, y: 0, width: 900, height: 700 }),
  } as unknown as Viewport;
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  body.children.length = 0;
  const m = s as unknown as {
    editDimension(i: number, f: string, mm: number): void;
    commitEntityDimExpr(i: number, f: string, raw: string): string | null;
    entityDimExpr(i: number, f: string): string | undefined;
  };
  const labels = new SketchDimensions(
    viewport,
    (i, f, mm) => m.editDimension(i, f, mm),
    (i, f, raw) => m.commitEntityDimExpr(i, f, raw),
    (i, f) => m.entityDimExpr(i, f),
  );
  const own = s as unknown as { entities: never; plane: never; constraints: { type: string; line?: string; value: number }[] };
  labels.show(own.entities, own.plane);
  const badge = byClass(body, "sketch-dim")[0]!;
  /** the driving length the edit placed on the line */
  const length = () => own.constraints.find((c) => c.type === "distance" && c.line === "e1");
  return { s, store, badge, length };
}

describe("the sketch dimension editor in inch mode (click a dimension, type, Enter)", () => {
  beforeEach(() => setUnit("in"));

  function type(badge: FakeEl, text: string) {
    badge.dispatch("click", { stopPropagation() {} });
    const input = badge.querySelector("input")!;
    input.value = text;
    input.dispatch("input");
    input.dispatch("keydown", key("Enter"));
    expect(input.classList.contains("input-error"), input.title).toBe(false);
  }

  for (const typed of ["1/16", "1/16 in"]) {
    it(`"${typed}" makes the line exactly 1/16 inch, and the document keeps it`, () => {
      const { s, store, badge, length } = sketchWithLengthDim();
      type(badge, typed);
      expect(length()?.value, `"${typed}" did not land as 1/16 inch`).toBe(SIXTEENTH);

      // What the sketch STORES is re-evaluated by the parameters engine on every
      // rebuild. Commit it the way Finish does, and read the dimension back
      // from the document after the engine has run.
      const bindings = (s as unknown as { drainBindings(id: string): unknown[] }).drainBindings("s1");
      store.addFeature(
        { id: "s1", type: "sketch", plane: "XY", entities: [{ type: "line", id: "e1", x1: 0, y1: 0, x2: 10, y2: 0 }], constraints: [{ ...length()! }] } as Feature,
        undefined,
        bindings as never,
      );
      const saved = store.document.features.find((f) => f.id === "s1") as { constraints: { value: number }[] };
      expect(saved.constraints[0]!.value, "the stored expression re-evaluated to something else").toBe(SIXTEENTH);
      // ...and it really is the engine's answer: the dimension is bound to a
      // model parameter holding a unit-explicit expression
      const bound = Object.values(store.document.paramDefs ?? {}).filter((d) => d.target);
      expect(bound.map((d) => [d.expr, d.value])).toEqual([["(1/16)*1 in", SIXTEENTH]]);
    });
  }

  it("a named parameter in the expression stays canonical", async () => {
    const { store, badge, length } = sketchWithLengthDim();
    expect(store.addParam("wall", "2")).toBeNull();
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // the param commit is queued
    expect(store.document.parameters.wall).toBe(2);
    type(badge, "wall*2");
    expect(length()?.value).toBe(4);
  });
});
