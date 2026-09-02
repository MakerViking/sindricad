// WHICH warning a curved-face pick says, and to whom.
//
// The plane picker is shared by four flows (sketch, offset plane, datum plane,
// split body), and the "curved face" toast used to be emitted inside it,
// unconditionally, in the SKETCH's words. So picking the barrel of a cylinder to
// split by warned about a sketch that was not being created — and about a follow
// that was never on offer there: a split bakes an absolute plane and has no
// `face` field at all (types.ts), so nothing was ever going to anchor.
//
// Driving the real picker means driving its pointerdown, so the canvas stub here
// hands back the handler the starter registered. Everything under test is real.

import { describe, it, expect, vi } from "vitest";

const spoken: { text: string }[] = [];
vi.mock("../ui/toast", () => ({ toast: (text: string) => spoken.push({ text }) }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/choice", () => ({
  choose: async () => "both",
  chooseMulti: async () => null,
  chooseBody: async () => "b1",
  isChoiceOpen: () => false,
}));

const { createFeatureStarters, CURVED_FACE_NOTE, CURVED_FACE_NOTE_PLANE } =
  await import("./featureStarters");

const TANGENT = { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] } as const;

(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (fn: () => void) => { fn(); return 0; };

/** A world where the face under the cursor is CURVED: pickFacePlane returns a
 *  usable tangent, faceAnchor refuses (viewport.ts's planarity gate). */
function harness() {
  let down: ((e: unknown) => void) | null = null;
  const deps = {
    store: {
      nextId: () => "new1",
      addFeature: () => {},
      updateFeature: () => {},
      document: { features: [] },
      buildState: { result: { bodies: [{ id: "b1", name: "Body1" }] } },
      isBodyVisible: () => true,
      bodyName: () => null,
    },
    viewport: {
      showAllPlanes: () => {},
      suspendPicking: false,
      pickFacePlane: () => TANGENT,
      faceAnchor: () => null, // curved: nothing to anchor by
      hoverFaceAt: () => {},
      hoverPlane: () => {},
      clearHover: () => {},
      pickPlane: () => null,
      selectedFacesForPressPull: () => null,
      selectedEdgeSelectors: () => [],
      selectOnlyEdge: () => {},
      getSelectedBodies: () => [] as string[],
      setSelectedBodies: () => {},
      pickFaceForPressPull: () => null,
    },
    overlay: { selectedRegions: () => [], regions: [] },
    sketch: { enter: () => {}, setTool: () => {} },
    extrude: { start: () => {} },
    edgeFeature: { start: () => {} },
    pressPull: { start: () => {} },
    loftTool: { start: () => {} },
    moveTool: { start: () => {} },
    planeOffset: { start: () => {} },
    texture: { start: () => {} },
    textOnFace: { start: () => {} },
    canvas: {
      addEventListener: (t: string, fn: (e: unknown) => void) => { if (t === "pointerdown") down = fn; },
      removeEventListener: () => {},
    },
    toolBusy: () => false,
    hasBody: () => true,
    setStatus: () => {},
    selectFeature: () => {},
    noteCommitted: () => {},
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    setPlanePick: () => {},
  };
  const starters = createFeatureStarters(deps as never);
  const click = () => {
    expect(down, "the starter registered no pointerdown — the picker never opened").not.toBeNull();
    down!({ button: 0, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation() {} });
  };
  return { starters, click };
}

describe("the curved-face warning names the feature being made", () => {
  it("says 'this sketch' for Sketch", () => {
    spoken.length = 0;
    const { starters, click } = harness();
    starters.startSketch();
    click();
    expect(spoken.map((s) => s.text)).toEqual([CURVED_FACE_NOTE]);
  });

  it("says 'this plane' for Datum Plane — no sketch is being created there", () => {
    spoken.length = 0;
    const { starters, click } = harness();
    starters.createDatumPlane();
    click();
    expect(spoken.map((s) => s.text)).toEqual([CURVED_FACE_NOTE_PLANE]);
  });

  it("says nothing for Split Body, which never had a follow to lose", async () => {
    spoken.length = 0;
    const { starters, click } = harness();
    await starters.startSplit();
    click();
    expect(
      spoken.map((s) => s.text),
      "Split warned about a sketch it is not creating, and a follow it never offered",
    ).toEqual([]);
  });
});
