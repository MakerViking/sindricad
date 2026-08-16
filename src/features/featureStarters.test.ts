// COVERAGE RATCHET for the model-view feature tools, not a set of hand-written cases.
//
// featureStarters.ts is every "start a modeling tool" entry point in the model
// view — Extrude, Fillet, Chamfer, Shell, Draft, Press/Pull, Loft, Revolve,
// Sweep, Texture, Text on Face, Move, Pattern, the plane pickers — and it had
// ZERO tests. It also carries, in its own comment at the top of
// cancelPlanePick, the field history of the exact fault this file exists to
// catch: a planePick flag left set meant "every tool guarded by toolBusy() —
// extrude, fillet, shell, press/pull, measure, section — returned silently and
// did nothing at all, with no message, until the app was restarted."
//
// The guard that caused that outage is still spelled `if (toolBusy()) return;`
// at 22 sites. This file asserts one property over every entry point instead of
// picking cases:
//
//     an entry point must either BEGIN something or SAY something.
//     A click that does neither is a bug, whatever the tool.
//
// It enumerates the object createFeatureStarters actually RETURNS rather than a
// list copied here, so a tool added later is covered the day it lands and
// coverage cannot decay quietly — same reason constraintCoverage.test.ts
// iterates CONSTRAINT_TOOLS and the sidecar's op coverage is a ratchet.
//
// SCOPE, stated rather than implied: the ratchet ends AT the starter. Calling
// `edgeFeature.start()` counts as beginning something; whether EdgeFeatureTool
// then puts anything on screen is that tool's own contract, tested elsewhere.
// It also does not cover the KEYBOARD path: main.ts has its own silent
// `if (toolBusy()) return;` guards (lines 470, 499, 710, 728, 1003, 1364) that
// fire before a starter is ever reached, so "e" can still be mute where the
// ribbon button now speaks. That is a separate fix.
import { describe, it, expect, vi, beforeEach } from "vitest";

// The two modal helpers are mocked, not stubbed at the DOM level, for one
// reason each: `choose` resolves only when the user clicks a button, so a real
// modal would hang every async starter here forever; and this repo has no jsdom
// on purpose (see vitest.config.ts). Both mocks RECORD, because opening a
// chooser is the strongest form of "said something" a tool can do. The dynamic
// `await import("../ui/choice")` inside startCombine resolves to this mock too.
const spoke: string[] = [];
vi.mock("../ui/choice", () => ({
  choose: (title: string) => {
    spoke.push(`choose(${title})`);
    return Promise.resolve(null);
  },
  chooseMulti: (title: string) => {
    spoke.push(`chooseMulti(${title})`);
    return Promise.resolve(null);
  },
}));
vi.mock("../ui/prompt", () => ({
  setPrompt: (t: string | null) => {
    if (t) spoke.push(`prompt(${t})`);
  },
}));

// featureStarters registers its Escape handler on `window` (the plane picker and
// the face picker both do). Node has no window; this is the missing DOM, not the
// property under test.
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};

import { createFeatureStarters } from "./featureStarters";
import type { PlaneDef } from "../types";

const PLANE: PlaneDef = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };

/** Entry points this ratchet deliberately does not cover, each with its reason.
 *  Mirrors the sidecar's EXCLUDED_OPS idiom: an exclusion has to be argued for
 *  in writing, so the set cannot quietly grow to make a failure go away. */
const EXCLUDED = new Set<string>([
  // Not an entry point: it aborts an in-flight plane pick. With no pick running
  // there is nothing to abort, and doing nothing is the whole contract.
  "cancelPlanePick",
]);

/** Arguments for the starters that take them. Every enumerated name must appear
 *  here (asserted below), so a new starter with a required argument fails the
 *  day it lands instead of being silently invoked with `undefined`. */
const ARGS: Record<string, unknown[]> = {
  startFillet: [],
  startChamfer: [],
  startPressPull: [],
  startSketch: [],
  offsetPlane: [],
  createDatumPlane: [],
  offsetPlaneFromFace: [PLANE],
  startSplit: [],
  startCutByPlane: ["p1"],
  startCombine: [],
  startSimplifyMesh: [],
  startCleanUp: [],
  startScale: [],
  startMove: [],
  startMirror: [],
  startRevolve: [],
  startLoft: [],
  startSweep: [],
  startPrimitive: [],
  startShell: [],
  startDraft: [],
  startTexture: [],
  startTextOnFace: [],
  startPattern: [],
  startExtrude: [],
  repickReference: ["f1", [0, 0, 0]],
};

interface World {
  busy: boolean;
  bodies: { id: string; name: string }[];
  features: { id: string; type: string }[];
  regions: number;
}

/** A fake FeatureStartersDeps whose every observable side effect lands in one
 *  `log`. "Acted or spoke" is then simply `log.length > 0`.
 *
 *  This is a parallel description of FeatureStartersDeps (featureStarters.ts:25)
 *  — if that interface grows a member a starter calls unconditionally, this goes
 *  stale and the test throws TypeError rather than asserting. Loud, but re-read
 *  the interface when it does. */
function harness(world: World) {
  const log: string[] = [];
  spoke.length = 0;
  const act = (what: string) => log.push(what);
  const tool = (name: string) => ({
    start: (...a: unknown[]) => act(`${name}.start(${a.length})`),
  });

  const deps = {
    store: {
      nextId: () => "new1",
      addFeature: (f: { type: string }) => act(`addFeature(${f.type})`),
      updateFeature: (id: string) => act(`updateFeature(${id})`),
      document: { features: world.features },
      buildState: { result: { bodies: world.bodies } },
      isBodyVisible: () => true,
      bodyName: () => null,
    },
    viewport: {
      showAllPlanes: (v: boolean) => act(`showAllPlanes(${v})`),
      set suspendPicking(v: boolean) { act(`suspendPicking(${v})`); },
      get suspendPicking() { return false; },
      pickFacePlane: () => null,
      hoverFaceAt: () => {},
      hoverPlane: () => {},
      clearHover: () => {},
      pickPlane: () => null,
      // null = no face pre-selected, so startExtrude takes its region branch
      selectedFacesForPressPull: () => null,
      selectedEdgeSelectors: () => [],
      selectOnlyEdge: () => {},
      getSelectedBodies: () => [] as string[],
      setSelectedBodies: () => {},
      pickFaceForPressPull: () => null,
    },
    overlay: {
      selectedRegions: () => [],
      // only `sketchId` is read on this path (selectedFacesForPressPull is null,
      // so startExtrude never reaches the plane comparison)
      regions: Array.from({ length: world.regions }, (_, i) => ({ sketchId: `s${i}` })),
    },
    sketch: { enter: () => act("sketch.enter"), setTool: () => act("sketch.setTool") },
    extrude: tool("extrude"),
    edgeFeature: tool("edgeFeature"),
    pressPull: tool("pressPull"),
    loftTool: tool("loftTool"),
    moveTool: tool("moveTool"),
    planeOffset: tool("planeOffset"),
    texture: tool("texture"),
    textOnFace: tool("textOnFace"),
    canvas: {
      addEventListener: (t: string) => act(`canvas.on(${t})`),
      removeEventListener: () => {},
    },
    toolBusy: () => world.busy,
    hasBody: () => world.bodies.length > 0,
    setStatus: (t: string) => act(`status(${t})`),
    selectFeature: () => {},
    noteCommitted: () => {},
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    setPlanePick: (v: boolean) => act(`planePick(${v})`),
  };

  return { starters: createFeatureStarters(deps as never), log, deps };
}

/** The three world-states. One happy path would have passed on current code —
 *  it is the OTHER two that catch the silent no-ops, which is the whole point of
 *  testing shape rather than adding cases. */
const WORLDS: Record<string, World> = {
  "an empty document": { busy: false, bodies: [], features: [], regions: 0 },
  "a body and a sketch region": {
    busy: false,
    bodies: [{ id: "b1", name: "Body1" }, { id: "b2", name: "Body2" }],
    features: [{ id: "f1", type: "sketch" }],
    regions: 1,
  },
  "another tool already running": {
    busy: true,
    bodies: [{ id: "b1", name: "Body1" }],
    features: [{ id: "f1", type: "sketch" }],
    regions: 1,
  },
};

const NAMES = Object.keys(harness(WORLDS["an empty document"]!).starters)
  .filter((k) => !EXCLUDED.has(k));

describe("every feature-tool entry point acts or speaks", () => {
  for (const [worldName, world] of Object.entries(WORLDS)) {
    it.each(NAMES)(`%s answers with ${worldName}`, async (name) => {
      const { starters, log } = harness(world);
      const fn = (starters as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
      await fn(...(ARGS[name] ?? []));
      const answered = log.length > 0 || spoke.length > 0;
      expect(
        answered,
        `${name}() with ${worldName} did nothing and said nothing — a dead button`,
      ).toBe(true);
    });
  }
});

describe("the ratchet itself", () => {
  beforeEach(() => { spoke.length = 0; });

  it("covers every entry point the app exposes, so a new one cannot slip through", () => {
    // If this fails, a starter was added and this file did not notice. It reads
    // the returned object directly, so the only way to fail is an empty export —
    // which would silently disable the whole matrix above.
    expect(NAMES.length).toBeGreaterThanOrEqual(26);
    expect(new Set(NAMES).size).toBe(NAMES.length);
  });

  it("has an argument row for every entry point", () => {
    // Without this, a starter taking a required argument would be called with
    // `undefined`, throw or bail early, and the matrix above would report on a
    // path no user can reach.
    const missing = NAMES.filter((n) => !(n in ARGS));
    expect(missing, `no ARGS entry: ${missing.join(", ")}`).toEqual([]);
    const stale = Object.keys(ARGS).filter((n) => !NAMES.includes(n));
    expect(stale, `ARGS names a starter that no longer exists: ${stale.join(", ")}`).toEqual([]);
  });
});
