// Inch mode: four decimals, and a value nobody edited is never re-written.
//
// A tester working in inches (Doug) asked for four decimals. Three was not only
// too coarse to read, it was too coarse to KEEP: every editor in the app fills
// its field with the rounded text and reads that text back on Enter. A 1/16"
// (1.5875 mm) showed "0.063", so clicking its dimension and pressing Enter made
// it 0.063" (1.6002 mm); a 1/32" became 0.031" (0.7874 mm). The same text
// round-trip ran through re-opening an extrude and through the inspector.
//
// These drive the REAL editors through the element stub — the dimension label
// editor a click opens, the heads-up box a feature edit seeds, the inspector
// row — and assert the number that comes OUT, which is what the geometry gets.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { FakeEl, byClass, installFakeDocument } from "./fakeDom.testkit";
import { setUnit, fieldText, fmtLength, parseField, numericInput } from "./units";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "../sketch/plane";

class FakeInput extends FakeEl {
  inputMode = "";
  autocomplete = "";
  dispatchEvent(e: { type: string }) {
    this.dispatch(e.type, e);
    return true;
  }
}

installFakeDocument();
const doc = globalThis.document as unknown as { createElement(tag: string): FakeEl; body: FakeEl };
doc.createElement = (tag: string) => new FakeInput(tag);
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

const { DimInput } = await import("../sketch/dimInput");
const { SketchDimensions } = await import("../sketch/sketchDimensions");
const { Inspector } = await import("./inspector");

const SIXTEENTH = 25.4 / 16; // 1.5875 mm
const THIRTY_SECOND = 25.4 / 32; // 0.79375 mm

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

beforeEach(() => setUnit("in"));
afterEach(() => setUnit("mm"));

describe("what inch mode shows", () => {
  it("shows four decimals, enough to hold every sixteenth exactly", () => {
    expect(fmtLength(SIXTEENTH)).toBe("0.0625 in");
    expect(fieldText(THIRTY_SECOND)).toBe("0.0313");
    expect(fieldText(25.4 * 1.2345)).toBe("1.2345");
    // ...and a sixteenth read back is the sixteenth, not 0.063"
    expect(parseField(fieldText(SIXTEENTH))).toBeCloseTo(SIXTEENTH, 9);
  });

  it("leaves millimetres and centimetres at three", () => {
    setUnit("mm");
    expect(fmtLength(SIXTEENTH)).toBe("1.588 mm");
    setUnit("cm");
    expect(fieldText(SIXTEENTH)).toBe("0.159");
  });

  it("steps an inch field without dropping the fourth decimal", () => {
    // Arrow Up used to round the stepped value to three places: 0.0625 -> 1.063.
    const el = numericInput(new FakeInput("input") as unknown as HTMLInputElement, 1);
    el.value = fieldText(SIXTEENTH);
    (el as unknown as FakeEl).dispatch("keydown", key("ArrowUp"));
    expect(el.value).toBe("1.0625");
  });
});

describe("the dimension label editor (click a dimension, press Enter)", () => {
  const viewport = {
    camera: new THREE.PerspectiveCamera(),
    projectToScreen: () => ({ x: 0, y: 0 }),
    projectToOverlay: () => ({ x: 0, y: 0, width: 900, height: 700 }),
  } as unknown as Viewport;
  const plane = { to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0) } as unknown as SketchPlane;

  function open(extra: { expr?: string } = {}) {
    doc.body.children.length = 0;
    const dims = new SketchDimensions(viewport, () => {});
    const committed: number[] = [];
    const exprs: string[] = [];
    dims.show([], plane, [{
      anchor: new THREE.Vector2(0, 0),
      valueMm: THIRTY_SECOND,
      commit: (v: number) => committed.push(v),
      commitExpr: (raw: string) => (exprs.push(raw), null),
      ...extra,
    }]);
    const badge = byClass(doc.body, "sketch-dim")[0]!;
    badge.dispatch("click", { stopPropagation() {} });
    const input = badge.querySelector("input")!;
    return { input, committed, exprs };
  }

  it("commits the EXACT value it was opened with when the text was not touched", () => {
    const e = open();
    expect(e.input.value).toBe("0.0313");
    e.input.dispatch("keydown", key("Enter"));
    // not 0.0313 * 25.4 = 0.79502, and not the old 0.031 * 25.4 = 0.7874
    expect(e.committed).toEqual([THIRTY_SECOND]);
  });

  it("still commits what the user typed", () => {
    const e = open();
    e.input.value = "0.5";
    e.input.dispatch("input");
    e.input.dispatch("keydown", key("Enter"));
    expect(e.committed).toEqual([12.7]);
  });

  it("commits what the user typed even when it is the text it opened with", () => {
    // Untouched means nothing TYPED, not "the text still matches": typing
    // 0.0313 over a 0.0313 readout is asking for 0.0313".
    const e = open();
    e.input.value = "0.0313";
    e.input.dispatch("input");
    e.input.dispatch("keydown", key("Enter"));
    expect(e.committed).toEqual([parseField("0.0313")]);
    expect(e.committed[0]).not.toBe(THIRTY_SECOND);
  });

  it("leaves a bound dimension's binding alone instead of rebinding it to the rounded text", () => {
    const e = open({ expr: String(THIRTY_SECOND) }); // bound to a literal
    expect(e.input.value).toBe("0.0313");
    e.input.dispatch("keydown", key("Enter"));
    expect(e.exprs).toEqual([]);
    expect(e.committed).toEqual([]);
  });
});

describe("the heads-up box a feature edit seeds (re-opening an extrude)", () => {
  function open() {
    const box = new DimInput();
    const committed: Record<string, number>[] = [];
    box.show([{ name: "distance", label: "D" }], (v) => committed.push(v));
    const field = inputs(doc.body).at(-1)!;
    return { box, field, committed };
  }

  it("commits the saved depth, not the parse of its rounded text", () => {
    const { box, field, committed } = open();
    box.seed("distance", THIRTY_SECOND);
    expect(field.value).toBe("0.0313");
    field.dispatch("keydown", key("Enter"));
    expect(committed).toEqual([{ distance: THIRTY_SECOND }]);
  });

  it("does the same for a value the cursor wrote (a dimension being placed)", () => {
    const { box, field } = open();
    box.updateFromCursor({ distance: THIRTY_SECOND });
    expect(box.isEdited("distance")).toBe(false);
    expect(box.getValue("distance")).toBe(THIRTY_SECOND);
    field.value = "0.5";
    expect(box.isEdited("distance")).toBe(true);
    expect(box.getValue("distance")).toBe(12.7);
  });

  it("takes TYPED digits at their word, even the digits it was showing", () => {
    // The box tracks a 9.99984 mm measurement and reads "10"; the user types 10.
    // Comparing text, the app could not tell that from untouched and handed
    // back 9.99984 — a line the user typed vertical came out 0.0004 deg off.
    setUnit("mm");
    const { box, field } = open();
    box.updateFromCursor({ distance: 9.99984 });
    expect(field.value).toBe("10");
    field.value = "10";
    field.dispatch("input");
    expect(box.isEdited("distance")).toBe(true);
    expect(box.getValue("distance")).toBe(10);
  });
});

describe("the inspector", () => {
  function mount(features: unknown[], parameters: Record<string, number> = {}) {
    const writes: string[] = [];
    const store = {
      document: { features, parameters, paramDefs: {} },
      paramIssues: {},
      onDocChange: () => () => {},
      boundExpr: () => null,
      isParamBound: () => false,
      setParam: (name: string, v: number) => writes.push(`param ${name}=${v}`),
      setTargetValue: (t: { field: string }, v: number) => writes.push(`value ${t.field}=${v}`),
      setTargetExpr: () => null,
    };
    const root = new FakeEl("div");
    const inspector = new Inspector(root as unknown as HTMLElement, store as unknown as DocumentStore);
    return { root, inspector, writes };
  }

  it("shows a feature length to four decimals and writes nothing back for it", () => {
    const { root, inspector, writes } = mount([{ id: "f1", type: "cylinder", radius: THIRTY_SECOND, height: SIXTEENTH }]);
    inspector.select("f1");
    const [radius, height] = inputs(root);
    expect(radius!.value).toBe("0.0313");
    expect(height!.value).toBe("0.0625");
    radius!.dispatch("change");
    expect(writes).toEqual([]);
    radius!.value = "0.5";
    radius!.dispatch("change");
    expect(writes).toEqual(["value radius=12.7"]);
  });

  it("shows a parameter to four decimals and writes nothing back for it", () => {
    const { root, inspector, writes } = mount([], { gap: THIRTY_SECOND });
    inspector.select(null);
    const [gap] = inputs(root);
    expect(gap!.value).toBe("0.0313");
    gap!.dispatch("change");
    expect(writes).toEqual([]);
  });
});
