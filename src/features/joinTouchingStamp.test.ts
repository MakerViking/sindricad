// Every tool that makes a feature able to Join stamps it `joinTouchingOnly`, so
// the sidecar joins only what the new solid touches and keeps every piece it
// was given (types.ts, on the extrude). An edit keeps what the feature had: a
// feature saved before the stamp must rebuild as it was saved.
//
// GH #41 / TA 8c510bd3: a lip joined under a lid took in the box it sits 0.2 mm
// inside, by bounding box alone, and welded the lid onto it. The sidecar half is
// sidecar/test_join_touching.py; this is the half that decides whether a
// feature the user makes gets the rule at all. Each tool is driven through its
// real entry (the starter, the tool's start or startEdit, Enter in its value
// box) and what is asserted is the feature the document gets.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl } from "../ui/fakeDom.testkit";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { CadDocument, Feature } from "../types";

// `choose` resolves only when a button is clicked: answer each chooser by its
// title, the way the user would.
const answers = new Map<string, unknown>();
vi.mock("../ui/choice", () => ({
  choose: (title: string) => Promise.resolve(answers.get(title) ?? null),
  chooseMulti: (title: string) => Promise.resolve(answers.get(title) ?? null),
}));

class FakeInput extends FakeEl {
  inputMode = "";
  autocomplete = "";
}

const keyHandlers: ((e: unknown) => void)[] = [];
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new FakeInput(tag),
  body: new FakeEl("body"),
  getElementById: () => null,
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (type === "keydown") keyHandlers.push(fn);
  },
  removeEventListener() {},
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

// after the globals: the tools build a DimInput as a field initialiser
const { ExtrudeTool } = await import("./extrudeTool");
const { FaceOffsetTool } = await import("./faceOffsetTool");
const { LoftTool } = await import("./loftTool");
const { SketchOverlay } = await import("../sketch/overlay");
const { createFeatureStarters } = await import("./featureStarters");
const { t } = await import("../i18n");

const body = (globalThis as unknown as { document: { body: FakeEl } }).document.body;

const key = (k: string) => ({
  key: k, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
});

/** The value box's field, as the user sees it: the last input on the page. */
function field(): FakeEl {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "input") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(body);
  return out.at(-1)!;
}

/** Type a value and press Enter in the tool's value box. */
async function enter(value: string) {
  await enterIn(field(), value);
}

/** The same in an extrude's depth box beside the cursor. The Extrude panel's
 *  fields come after it on the page, so "the last input" is not this one. */
async function enterDepth(value: string) {
  const root = body.children.find((c) => c.className === "dim-input");
  if (!root) throw new Error("the depth box is not on the page");
  const inputs: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "input") inputs.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  await enterIn(inputs[0]!, value);
}

async function enterIn(box: FakeEl, value: string) {
  box.value = value;
  box.dispatch("input");
  box.dispatch("keydown", key("Enter"));
  await Promise.resolve();
}

const domElement = {
  style: { cursor: "" },
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
};

const viewportStub = {
  suspendPicking: false,
  domElement,
  tiltOffAxis() {},
  addToScene() {},
  removeFromScene() {},
  projectToScreen: () => ({ x: 0, y: 0 }),
  clearHover() {},
  hoverDatum() {},
  pointInSolid: () => false,
};

const SQUARE = { id: "r", type: "rectangle", x: 0, y: 0, width: 50, height: 50 };

beforeEach(() => {
  body.children.length = 0;
  keyHandlers.length = 0;
  answers.clear();
});

describe("the extrude tool", () => {
  function harness(features: unknown[]) {
    const written: Feature[] = [];
    const document_ = { features, parameters: [] } as unknown as CadDocument;
    const store = {
      document: document_,
      isParamBound: () => false,
      boundExpr: () => null,
      beginEditPreview() {},
      endEditPreview() {},
      setPreview() {},
      setEditPreview() {},
      onBuild: () => () => {},
      buildState: {}, // no solid: commit skips the operation modal
      hiddenBodyIds: () => [],
      nextId: () => "new1",
      addFeature: (f: Feature) => written.push(f),
      replaceFeature: (_id: string, f: Feature) => written.push(f),
    } as unknown as DocumentStore;
    const overlay = new SketchOverlay();
    const tool = new ExtrudeTool(viewportStub as unknown as Viewport, overlay as never, store);
    return { tool, overlay, document_, written };
  }

  it("stamps a NEW extrude", async () => {
    const h = harness([{ id: "s1", type: "sketch", plane: "XY", entities: [SQUARE] }]);
    h.overlay.update(h.document_);
    h.overlay.selectRegionsByPoints([[0, 0, 0]]);
    expect(h.overlay.selectedRegions(), "precondition: the square is picked").toHaveLength(1);
    h.tool.start(() => {});
    await enterDepth("5");
    expect(h.written).toHaveLength(1);
    expect(h.written[0]).toMatchObject({
      type: "extrude", sketch: "s1", distance: 5, regionEntities: [["r"]], separateBodies: true, joinTouchingOnly: true,
    });
  });

  it("leaves an extrude saved before the stamp unstamped when it is edited", async () => {
    const h = harness([
      { id: "s1", type: "sketch", plane: "XY", entities: [SQUARE] },
      { id: "ex1", type: "extrude", sketch: "s1", distance: 3, operation: "join", regions: [[0, 0, 0]], regionEntities: [["r"]] },
    ]);
    expect(h.tool.startEdit("ex1", () => {}), "precondition: the edit opened").toBe(true);
    await enterDepth("4");
    expect(h.written).toHaveLength(1);
    expect(h.written[0]).toMatchObject({ id: "ex1", distance: 4 });
    expect("joinTouchingOnly" in h.written[0]!).toBe(false);
  });

  it("keeps the stamp through an edit", async () => {
    const h = harness([
      { id: "s1", type: "sketch", plane: "XY", entities: [SQUARE] },
      {
        id: "ex1", type: "extrude", sketch: "s1", distance: 3, operation: "join", regions: [[0, 0, 0]],
        regionEntities: [["r"]], joinTouchingOnly: true,
      },
    ]);
    h.tool.startEdit("ex1", () => {});
    await enterDepth("4");
    expect(h.written[0]).toMatchObject({ id: "ex1", distance: 4, joinTouchingOnly: true });
  });
});

describe("thicken", () => {
  it("stamps the feature it makes", async () => {
    const written: Feature[] = [];
    const store = {
      nextId: () => "new1",
      setPreview() {},
      addFeature: (f: Feature) => written.push(f),
    } as unknown as DocumentStore;
    const viewport = {
      ...viewportStub,
      // a face picked before the tool: start goes straight to the drag
      selectedFacesForPressPull: () => ({
        selectors: [{ kind: "face", by: "normal", dir: [0, 0, 1] }], faceIds: [0],
        anchor: new THREE.Vector3(0, 0, 5), normal: new THREE.Vector3(0, 0, 1), bodyId: "body1",
      }),
    } as unknown as Viewport;
    new FaceOffsetTool(viewport, store).start("thicken", () => {});
    await enter("2");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: "thicken", thickness: 2, operation: "join", joinTouchingOnly: true });
  });
});

describe("loft", () => {
  it("stamps the feature it makes", () => {
    const written: Feature[] = [];
    const store = {
      nextId: () => "new1",
      setPreview() {},
      addFeature: (f: Feature) => written.push(f),
    } as unknown as DocumentStore;
    const profile = (sketchId: string, z: number) => ({ sketchId, interior3D: new THREE.Vector3(0, 0, z) });
    const overlay = {
      // two profiles picked before the tool, which seed it
      selectedRegions: () => [profile("s1", 0), profile("s2", 10)],
      selectRegionsByPoints() {},
      setHoverRegion() {},
    };
    new LoftTool(viewportStub as unknown as Viewport, overlay as never, store).start(() => {});
    for (const h of keyHandlers) h(key("Enter"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: "loft", joinTouchingOnly: true });
  });
});

describe("the starters: Combine, Revolve and Sweep", () => {
  function harness(opts: { selectedEdges?: unknown[] } = {}) {
    const written: Feature[] = [];
    const deps = {
      store: {
        nextId: () => "new1",
        addFeature: (f: Feature) => written.push(f),
        document: { features: [{ id: "s1", type: "sketch", entities: [] }, { id: "s2", type: "sketch", entities: [] }] },
        buildState: { result: { bodies: [{ id: "body1", name: "Body1" }, { id: "body2", name: "Body2" }] } },
        bodyName: () => null,
      },
      viewport: {
        getSelectedBodies: () => [] as string[],
        setSelectedBodies() {},
        selectedEdgeSelectors: () => opts.selectedEdges ?? [],
        clearSelection() {},
      },
      overlay: { selectedRegions: () => [{ sketchId: "s1" }], regions: [{ sketchId: "s1" }] },
      toolBusy: () => false,
      setStatus() {},
    };
    return { starters: createFeatureStarters(deps as never), written };
  }

  it("Combine stamps the feature it makes", async () => {
    answers.set(t("feature.starters.combine.title"), "join");
    const h = harness();
    await h.starters.startCombine();
    expect(h.written).toHaveLength(1);
    expect(h.written[0]).toMatchObject({ type: "combine", operation: "join", target: "body1", tools: ["body2"], joinTouchingOnly: true });
  });

  it("Revolve stamps the feature it makes", async () => {
    answers.set(t("feature.starters.revolve.axisTitle"), "Z");
    answers.set(t("feature.starters.revolve.opTitle"), "join");
    const h = harness();
    await h.starters.startRevolve();
    expect(h.written[0]).toMatchObject({ type: "revolve", operation: "join", joinTouchingOnly: true });
  });

  it("Sweep stamps the feature it makes, along a path sketch or along edges", async () => {
    let h = harness();
    await h.starters.startSweep();
    expect(h.written[0]).toMatchObject({ type: "sweep", path: "s2", joinTouchingOnly: true });
    h = harness({ selectedEdges: [{ kind: "edge", point: [0, 0, 0] }] });
    await h.starters.startSweep();
    expect(h.written[0]).toMatchObject({ type: "sweep", pathEdges: [{ kind: "edge" }], joinTouchingOnly: true });
  });
});
