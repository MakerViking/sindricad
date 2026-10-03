// Re-opening a feature and pressing Enter must give back the value it was saved
// with, in inches too (Doug-26).
//
// The value box gets this right on its own: it hands back the exact number it
// was seeded with while nothing is typed. But the extrude and fillet/chamfer
// tools then rounded what they committed to 1 um in MILLIMETRES, which is not a
// round number in inches: a 1/32" (0.79375 mm) extrude re-opened and accepted
// came back 0.794 mm. That rounding exists to drop drag and typing noise, so it
// still applies to a value that changed.
//
// Both tools are driven through their real edit entry (startEdit), their real
// value box, and Enter pressed in it, with the element stub the other tool tests
// use. What is asserted is the feature handed to replaceFeature: what the
// document gets.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { FakeEl } from "../ui/fakeDom.testkit";
import { setUnit } from "../ui/units";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { CadDocument, Feature, RebuildResult } from "../types";

class FakeInput extends FakeEl {
  inputMode = "";
  autocomplete = "";
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new FakeInput(tag),
  body: new FakeEl("body"),
  getElementById: () => null,
};
(globalThis as unknown as { window: unknown }).window = { addEventListener() {}, removeEventListener() {} };
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

// after the globals: both tools build a DimInput as a field initialiser
const { ExtrudeTool } = await import("./extrudeTool");
const { EdgeFeatureTool } = await import("./edgeFeatureTool");
const { SketchOverlay } = await import("../sketch/overlay");

const THIRTY_SECOND = 25.4 / 32; // 0.79375 mm
const body = (globalThis as unknown as { document: { body: FakeEl } }).document.body;

const key = (k: string) => ({
  key: k, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  preventDefault() {}, stopPropagation() {},
});

/** The value box's field, as the user sees it: the last input in the box on
 *  the canvas (the Extrude panel has inputs of its own). */
function field(): FakeEl {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "input") out.push(el);
    for (const c of el.children) walk(c);
  };
  for (const c of body.children) if (c.className === "dim-input") walk(c);
  return out.at(-1)!;
}

function typeInto(el: FakeEl, text: string) {
  el.value = text;
  el.dispatch("input");
}

const domElement = {
  style: { cursor: "" },
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
};

beforeEach(() => {
  body.children.length = 0;
  setUnit("in");
});
afterEach(() => setUnit("mm"));

describe("re-opening an extrude and pressing Enter", () => {
  function open(distance: number) {
    const written: Feature[] = [];
    const document_ = {
      features: [
        { id: "s1", type: "sketch", plane: "XY", entities: [{ id: "r", type: "rectangle", x: 0, y: 0, width: 50, height: 50 }] },
        { id: "ex1", type: "extrude", sketch: "s1", distance, operation: "new", regions: [[0, 0, 0]], regionEntities: [["r"]] },
      ],
      parameters: [],
    } as unknown as CadDocument;
    const store = {
      document: document_,
      isParamBound: () => false,
      beginEditPreview() {},
      endEditPreview() {},
      buildState: {}, // no solid: commit skips the operation modal
      hiddenBodyIds: () => [],
      nextId: () => "new1",
      replaceFeature: (_id: string, f: Feature) => written.push(f),
    } as unknown as DocumentStore;
    const viewport = {
      suspendPicking: false,
      domElement,
      tiltOffAxis() {},
      addToScene() {},
      removeFromScene() {},
      projectToScreen: () => ({ x: 0, y: 0 }),
      clearHover() {},
      hoverDatum() {},
    } as unknown as Viewport;
    const tool = new ExtrudeTool(viewport, new SketchOverlay() as never, store);
    expect(tool.startEdit("ex1", () => {}), "precondition: the edit opened").toBe(true);
    return { written, box: field() };
  }

  it("writes the saved depth back unchanged", async () => {
    const { written, box } = open(THIRTY_SECOND);
    expect(box.value).toBe("0.0313");
    box.dispatch("keydown", key("Enter"));
    await Promise.resolve();
    expect(written).toHaveLength(1);
    // not 0.794 (the old 1 um rounding of it), not 0.79502 (the parse of "0.0313")
    expect((written[0] as { distance: number }).distance).toBe(THIRTY_SECOND);
  });

  it("still cleans a typed depth to the micrometre", async () => {
    const { written, box } = open(THIRTY_SECOND);
    typeInto(box, "0.0313");
    box.dispatch("keydown", key("Enter"));
    await Promise.resolve();
    // typed digits are the user's number even where they match the readout
    expect((written[0] as { distance: number }).distance).toBe(0.795);
  });
});

describe("re-opening a fillet and pressing Enter", () => {
  function open(radius: number) {
    const written: Feature[] = [];
    let onBuild: ((s: unknown) => void) | null = null;
    const store = {
      document: {
        features: [{ id: "f1", type: "fillet", edges: { kind: "edge", point: [10, 0, 5] }, radius }],
        parameters: [],
      },
      isParamBound: () => false,
      buildState: { result: null },
      nextId: () => "prev1",
      beginEditPreview() {},
      endEditPreview() {},
      setEditPreview() {},
      replaceFeature: (_id: string, f: Feature) => written.push(f),
      onBuild: (fn: (s: unknown) => void) => {
        onBuild = fn;
        return () => {};
      },
    } as unknown as DocumentStore;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const viewport = {
      camera,
      domElement,
      suspendPicking: false,
      emphasizeEdges() {},
      clearHover() {},
      hoverDatum() {},
      requestRender() {},
      addToScene() {},
      removeFromScene() {},
      edgeLineByMid: () => null, // no rendered line: the selector is carried, no ghost
      projectToScreen: () => ({ x: 0, y: 0 }),
    } as unknown as Viewport;
    const tool = new EdgeFeatureTool(viewport, store);
    expect(tool.startEdit("f1", () => {}), "precondition: the edit opened").toBe(true);
    // the rolled-back model arrives, and the value box opens on the saved value
    onBuild!({ building: false, result: { featureErrors: [] } as unknown as RebuildResult });
    return { written, box: field() };
  }

  it("writes the saved radius back unchanged", () => {
    const { written, box } = open(THIRTY_SECOND);
    expect(box.value).toBe("0.0313");
    box.dispatch("keydown", key("Enter"));
    expect(written).toHaveLength(1);
    expect((written[0] as { radius: number }).radius).toBe(THIRTY_SECOND);
  });

  it("still cleans a typed radius to the micrometre", () => {
    const { written, box } = open(THIRTY_SECOND);
    typeInto(box, "0.04");
    box.dispatch("keydown", key("Enter"));
    expect((written[0] as { radius: number }).radius).toBe(1.016);
  });
});
