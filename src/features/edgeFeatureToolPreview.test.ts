// The two ways the fillet/chamfer tool used to leave a user staring at an
// unchanged model, from field report a0a76571 ("the chamfer appears to have the
// same size regardless of the value I enter... the meshing never finishes...
// even Undo does not work").
//
// 1. A REFUSED preview said nothing. OCCT declines a chamfer on most edges of
//    some bodies at any size ("Failed creating a chamfer, try a smaller length
//    value(s)") — measured on the reporter's own document: 17 of its 21 edges
//    fail at every size from 0.5 to 3 mm, and the other four fail at 2 mm and
//    up. main.ts suppresses the feature-error toast for the whole time a preview
//    is live, so every typed value produced the same picture and no message.
//
// 2. A sub-floor typed value rebuilt EVERY FRAME. The rAF guard compared the raw
//    typed number and stored a clamped one, so "0" — the first keystroke of
//    "0.5" — never equalled the stored 0.001 and pushed a fresh sidecar rebuild
//    on every tick, which is a build chip that never clears and an undo whose
//    rebuild is immediately superseded.
//
// Both are observed as EFFECTS: what the prompt banner says, and how many
// previews reach the store. The tool is driven through its real entry points
// (start with a pre-selection, then the real rAF callback it registered), with
// the same element stub the other tool tests use rather than jsdom.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { FakeEl } from "../ui/fakeDom.testkit";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { Feature, RebuildResult, Selector } from "../types";

const promptEl = new FakeEl("div");
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new FakeEl(tag),
  body: new FakeEl("body"),
  getElementById: (id: string) => (id === "prompt" ? promptEl : null),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
};
let rafCb: (() => void) | null = null;
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
  cb: () => void,
) => {
  rafCb = cb;
  return 1;
};
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

// imported after the globals above: EdgeFeatureTool constructs a DimInput at
// field-initialisation time, which appends to document.body.
const { EdgeFeatureTool } = await import("./edgeFeatureTool");

const EDGE: Selector = { kind: "edge", point: [10, 0, 5] } as unknown as Selector;

function harness() {
  const el = {
    style: { cursor: "" },
    addEventListener() {},
    removeEventListener() {},
  };
  const previews: (Feature | null)[] = [];
  let onBuild: ((s: unknown) => void) | null = null;
  const store = {
    document: { features: [], parameters: [] },
    buildState: { result: null },
    nextId: () => "prev1",
    setPreview: (f: Feature | null) => previews.push(f),
    setEditPreview: (f: Feature | null) => previews.push(f),
    onBuild: (fn: (s: unknown) => void) => {
      onBuild = fn;
      fn({ building: false, result: null }); // the real store replays current state
      return () => {};
    },
  } as unknown as DocumentStore;

  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const viewport = {
    camera,
    domElement: el,
    suspendPicking: false,
    emphasizeEdges() {},
    clearHover() {},
    requestRender() {},
    addToScene() {},
    removeFromScene() {},
    selectedEdgeSelectors: () => [EDGE],
    // no rendered line for the pick: the selector still commits, and the tool
    // skips the Line2 ghost it would otherwise build (see seedGhosts)
    edgeLineByMid: () => null,
    visibleEdgeLines: () => [],
    projectToScreen: () => ({ x: 100, y: 100 }),
    pixelWorldSize: () => 1,
  } as unknown as Viewport;

  const tool = new EdgeFeatureTool(viewport, store);
  tool.start("chamfer", () => {});
  return {
    tool,
    previews,
    emitBuild: (result: RebuildResult) => onBuild?.({ building: false, result }),
    // the dim box the tool opened, reached the way the user reaches it: by value
    seed: (v: number) => (tool as unknown as { dim: { seed(n: string, v: number): void } }).dim
      .seed("distance", v),
    tick: () => rafCb?.(),
  };
}

const REFUSAL = "Failed creating a chamfer, try a smaller length value(s)";

describe("a fillet/chamfer preview the kernel refuses", () => {
  it("says so in the tool's prompt instead of showing the unchanged model", () => {
    const h = harness();
    expect(promptEl.textContent, "precondition: the tool's own prompt is showing")
      .toContain("commit");

    h.emitBuild({
      featureErrors: [{ feature_id: "prev1", message: REFUSAL }],
    } as unknown as RebuildResult);

    expect(
      promptEl.textContent,
      "the kernel refused the chamfer and the user was told nothing — the model just " +
        "sat there unchanged, which is what a0a76571 reported as 'the same size regardless'",
    ).toContain(REFUSAL);
    expect(promptEl.textContent, "the message must name the operation").toContain("chamfer");
  });

  it("clears back to the tool's instructions once a size builds", () => {
    const h = harness();
    h.emitBuild({
      featureErrors: [{ feature_id: "prev1", message: REFUSAL }],
    } as unknown as RebuildResult);
    h.emitBuild({ featureErrors: [] } as unknown as RebuildResult);
    expect(
      promptEl.textContent,
      "a failure that has gone away must not keep accusing a value that now works",
    ).not.toContain(REFUSAL);
    expect(promptEl.textContent).toContain("commit");
  });

  it("stays quiet about someone else's failing feature", () => {
    // The control: the tool must only speak for its OWN preview, or every
    // pre-existing red chip in the document would shout over its prompt.
    const h = harness();
    h.emitBuild({
      featureErrors: [{ feature_id: "some-other-feature", message: REFUSAL }],
    } as unknown as RebuildResult);
    expect(promptEl.textContent).not.toContain(REFUSAL);
  });
});

describe("a typed value below the minimum", () => {
  it("pushes one preview, not one per frame", () => {
    const h = harness();
    const before = h.previews.length;
    expect(before, "precondition: entering the drag pushes the opening preview").toBe(1);

    h.seed(0); // "0" — the first keystroke of "0.5", and a value OCCT cannot use
    for (let i = 0; i < 5; i++) h.tick();

    expect(
      h.previews.length - before,
      "every rAF frame fired a fresh full rebuild: the guard compared the raw typed " +
        "value against a clamped stored one, so a sub-floor entry could never settle",
    ).toBeLessThanOrEqual(1);
  });

  it("still previews a normal typed value exactly once", () => {
    // The counter-check: clamping once must not cost a legitimate retype its
    // rebuild, nor make it repeat.
    const h = harness();
    const before = h.previews.length;
    h.seed(4);
    for (let i = 0; i < 5; i++) h.tick();
    expect(h.previews.length - before, "a typed 4 mm did not reach the sidecar once").toBe(1);
    const last = h.previews[h.previews.length - 1] as { distance?: number };
    expect(last.distance, "the previewed chamfer is not the number that was typed").toBe(4);
  });
});
