// Field report 77f004a6: filleting one rim of an extruded hexagon also
// fillets edges nowhere near it — the other cap, and a near-duplicate ring a
// hair off the true one (an OCCT tessellation artefact). The pick-phase chain
// walk (tangentChain, in edgeFeatureTool.ts) used a bare tangent-angle test
// with no notion of which flat loop an edge belongs to, so a connector whose
// endpoint lands within the coincidence tolerance of a rim vertex — tangent
// close enough, wrong loop entirely — joined just the same.
//
// This drives the tool through its REAL pick-phase entry point (the
// pointerdown listener registered in start(), not the pre-selection bypass
// edgeFeatureToolPreview.test.ts uses, which never reaches tangentChain at
// all — visibleEdgeLines there is always empty).
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { FakeEl } from "../ui/fakeDom.testkit";
import { edgeSelectorFrom, type Vec3 } from "../viewport/edgeMatch";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { EdgeHit } from "../viewport/picking";
import type { Feature } from "../types";

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
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 1;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

// imported after the globals above: EdgeFeatureTool constructs a DimInput at
// field-initialisation time, which appends to document.body.
const { EdgeFeatureTool } = await import("./edgeFeatureTool");

type RawEdge = { points: Vec3[]; body?: string };

/** A rounded rim at z=10: a genuine quarter-circle arc (5 sampled points,
 *  real curvature — plane-establishing) blending tangentially into a
 *  straight stretch on one side (A, legitimately in the same flat loop) and,
 *  on the other, into a connector that drifts 0.1mm out of that plane (B,
 *  modelling the near-duplicate-ring artefact). Both A and B are within 10°
 *  of the arc's tangent at their shared vertex, so the OLD tangent-only test
 *  chains both; only B leaves the arc's own plane. */
const arc: RawEdge = {
  points: [
    [10, 0, 10],
    [9.239, 3.827, 10],
    [7.071, 7.071, 10],
    [3.827, 9.239, 10],
    [0, 10, 10],
  ],
  body: "b1",
};
const rimContinuation: RawEdge = { points: [[11.95, -9.81, 10], [10, 0, 10]], body: "b1" };
const duplicateRingBridge: RawEdge = { points: [[0, 10, 10], [-9.9, 11.97, 9.9]], body: "b1" };
const farEdge: RawEdge = { points: [[50, 50, 0], [60, 50, 0]], body: "b1" };

const midOf = (e: RawEdge) => edgeSelectorFrom(e)!.point;

function harness() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const el = {
    style: { cursor: "" },
    clientWidth: 800,
    clientHeight: 600,
    addEventListener(type: string, cb: (e: unknown) => void) {
      handlers[type] = cb;
    },
    removeEventListener() {},
  };
  const previews: (Feature | null)[] = [];
  const store = {
    document: { features: [], parameters: [] },
    buildState: { result: null },
    nextId: () => "prev1",
    setPreview: (f: Feature | null) => previews.push(f),
    setEditPreview: (f: Feature | null) => previews.push(f),
    onBuild: () => () => {},
  } as unknown as DocumentStore;

  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const all = [arc, rimContinuation, duplicateRingBridge, farEdge];
  const viewport = {
    camera,
    domElement: el,
    suspendPicking: false,
    emphasizeEdges() {},
    clearHover() {},
    hoverEdge() {},
    requestRender() {},
    addToScene() {},
    removeFromScene() {},
    selectedEdgeSelectors: () => [], // empty — start() goes to the real pick phase
    edgeLineByMid: () => null,
    visibleEdgeLines: () => all as unknown[],
    projectToScreen: () => ({ x: 100, y: 100 }),
    pixelWorldSize: () => 1,
    rayFrom: () => new THREE.Ray(new THREE.Vector3(0, 0, 100), new THREE.Vector3(0, 0, -1)),
    // the test always "clicks" the arc; which screen point is irrelevant
    pickEdgeAt: (): EdgeHit =>
      ({ kind: "edge", edge: arc as unknown as EdgeHit["edge"], selector: edgeSelectorFrom(arc)! }),
  } as unknown as Viewport;

  const tool = new EdgeFeatureTool(viewport, store);
  tool.start("fillet", () => {});
  return {
    tool,
    ghostMids: () => (tool as unknown as { ghosts: { mid: Vec3 }[] }).ghosts.map((g) => g.mid),
    down: (shiftKey: boolean) =>
      handlers["pointerdown"]?.({
        button: 0,
        clientX: 0,
        clientY: 0,
        shiftKey,
        preventDefault() {},
        stopImmediatePropagation() {},
      }),
  };
}

describe("tangentChain stays inside the clicked rim's own flat loop", () => {
  it("picks up a legitimate same-plane continuation but not the near-duplicate-ring bridge", () => {
    const h = harness();
    h.down(false);
    const mids = h.ghostMids();

    expect(mids, "the arc's own legitimate neighbour, same plane, must still chain in")
      .toContainEqual(midOf(rimContinuation));
    expect(
      mids,
      "a connector 0.1mm out of the rim's own plane reads as tangent-continuous too " +
        "(within the 10° test) but belongs to a different ring — the plane guard must " +
        "reject it, or this is exactly field report 77f004a6",
    ).not.toContainEqual(midOf(duplicateRingBridge));
    expect(mids).not.toContainEqual(midOf(farEdge));
    // the clicked edge itself, plus exactly its one legitimate neighbour
    expect(mids.length).toBe(2);
  });

  it("Shift-click adds exactly the clicked edge, skipping the chain walk entirely", () => {
    const h = harness();
    h.down(true);
    const mids = h.ghostMids();
    expect(mids, "Shift-click must not pull in the tangent chain at all").toEqual([midOf(arc)]);
  });
});
