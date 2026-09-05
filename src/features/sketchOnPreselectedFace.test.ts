// startSketch honours a face that is already selected.
//
// Reported: select a face, press Sketch, and the tool ignores the selection and
// arms an interactive pick — "it asks me to select the face I just selected".
// Press/Pull in the same ribbon consults viewport.selectedFacesForPressPull()
// first, which is why the two felt inconsistent.
//
// What this observes is the EFFECT: which of the two routes startSketch takes.
// Entering the sketch means `sketch.enter` with the pre-selected face's plane
// AND its selector (the selector is what makes the sketch follow the face on
// later rebuilds, GH #52); arming the pick means planePick(true), the canvas
// listeners and the "Select a plane" prompt. The two are mutually exclusive, so
// both are asserted in each direction — a fix that entered the sketch AND left
// a pick armed would leave every other tool dead behind it (see
// featureStarters.ts cancelPlanePick).

import { describe, it, expect, vi } from "vitest";
import { createFeatureStarters } from "./featureStarters";
import type { PlaneDef, Selector } from "../types";

const spoke: string[] = [];
vi.mock("../ui/prompt", () => ({
  setPrompt: (t: string | null) => {
    if (t) spoke.push(`prompt(${t})`);
  },
}));

// The Escape handler of the interactive pick registers on `window`, which Node
// does not have. This is the missing DOM, not the property under test.
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};

const FACE_PLANE: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };
const FACE_SEL: Selector = { kind: "face", by: "nearest", point: [5, 5, 10], body: "body1" };

function harness(pre: { plane: PlaneDef; face: Selector } | null) {
  const log: string[] = [];
  spoke.length = 0;
  const act = (what: string) => log.push(what);
  const entered: { plane: PlaneDef; face: Selector | undefined }[] = [];
  const deps = {
    store: { document: { features: [] }, buildState: { result: { bodies: [] } } },
    viewport: {
      selectedFaceSketchPlane: () => pre,
      clearSelection: () => act("clearSelection"),
      showAllPlanes: (v: boolean) => act(`showAllPlanes(${v})`),
      set suspendPicking(v: boolean) { act(`suspendPicking(${v})`); },
      get suspendPicking() { return false; },
      clearHover: () => {},
    },
    sketch: {
      enter: (plane: PlaneDef, _s: unknown, _e: unknown, _p: unknown, face?: Selector) => {
        entered.push({ plane, face });
        act("sketch.enter");
      },
      setTool: (t: string) => act(`sketch.setTool(${t})`),
    },
    canvas: {
      addEventListener: (t: string) => act(`canvas.on(${t})`),
      removeEventListener: () => {},
    },
    toolBusy: () => false,
    hasBody: () => true,
    setStatus: (t: string) => { if (t.trim()) act(`status(${t})`); },
    selectFeature: () => {},
    noteCommitted: () => {},
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    setPlanePick: (v: boolean) => act(`planePick(${v})`),
  };
  return { starters: createFeatureStarters(deps as never), log, entered };
}

const armedAPick = (log: string[]) =>
  log.includes("planePick(true)") || spoke.some((s) => s.startsWith("prompt(Select a plane"));

describe("Sketch with a planar face already selected", () => {
  it("enters the sketch on that face instead of asking for another pick", () => {
    const { starters, log, entered } = harness({ plane: FACE_PLANE, face: FACE_SEL });
    starters.startSketch();
    expect(entered).toEqual([{ plane: FACE_PLANE, face: FACE_SEL }]);
    expect(armedAPick(log), `startSketch armed a pick anyway: ${log.join(" | ")}`).toBe(false);
  });

  it("still applies the tool the ribbon asked for", () => {
    const { starters, log } = harness({ plane: FACE_PLANE, face: FACE_SEL });
    starters.startSketch("line");
    expect(log).toContain("sketch.setTool(line)");
  });

  it("clears the selection, so the face is not still armed for the next tool", () => {
    const { starters, log } = harness({ plane: FACE_PLANE, face: FACE_SEL });
    starters.startSketch();
    expect(log).toContain("clearSelection");
  });
});

describe("Sketch with no usable pre-selection", () => {
  // null covers all four of them: nothing selected, several faces selected, a
  // curved face, an unknown body (see selectedFaceSketchPlane.test.ts).
  it("still arms the interactive pick", () => {
    const { starters, log, entered } = harness(null);
    starters.startSketch();
    expect(entered).toEqual([]);
    expect(armedAPick(log), `startSketch neither entered nor picked: ${log.join(" | ")}`).toBe(true);
  });
});
