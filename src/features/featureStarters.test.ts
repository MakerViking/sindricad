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
//
// WHERE THE BOUNDARY IS, and why. `createFeatureStarters` is not quite the whole
// set of model-view feature entry points: Offset Face, Thicken, edit-feature and
// the Delete key are wired directly in main.ts, and the first version of this
// file left them out — so Shell spoke when busy while the Offset Face button two
// lines away in the same ribbon group stayed a dead click. An enumerated source
// of truth that does not enumerate everything is the exact failure this file
// exists to prevent, so the second describe block below reads main.ts as TEXT
// and holds ITS toolBusy() guards to the same property, with every silent one
// named and argued for. The two blocks together cover every way a model-view
// feature can be started.
//
// KEYBOARD is not a gap, and an earlier version of this comment said it was.
// Verified path: shortcuts.ts `{ key: "e", action: "extrude" }` -> keymap.ts
// `onAction(action)` (no busy guard anywhere in keymap.ts) -> main.ts
// `handleAction(a)` -> `starters.startExtrude()` -> busy(). The "e" key and the
// ribbon button reach the same starter and both speak.
import { describe, it, expect, vi, beforeEach } from "vitest";
// `?raw` rather than fs, and TEXT rather than an import, for the reasons
// ribbonActions.test.ts gives: importing main.ts boots the whole app, and this
// tsconfig has no @types/node.
import mainSrc from "../main.ts?raw";

// The two modal helpers are mocked, not stubbed at the DOM level, for one
// reason each: `choose` resolves only when the user clicks a button, so a real
// modal would hang every async starter here forever; and this repo has no jsdom
// on purpose (see vitest.config.ts). Both mocks RECORD, because opening a
// chooser is the strongest form of "said something" a tool can do. The dynamic
// `await import("../ui/choice")` inside startCombine resolves to this mock too.
const spoke: string[] = [];
vi.mock("../ui/choice", () => ({
  choose: (title: string) => {
    if (title) spoke.push(`choose(${title})`);
    return Promise.resolve(null);
  },
  chooseMulti: (title: string) => {
    if (title) spoke.push(`chooseMulti(${title})`);
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
  // The ribbon's "Rect Pattern" button already names the kind, so this skips the
  // rect/circular dialog startPattern asks. Exercised with "rect"; "circular"
  // differs only in the feature it appends.
  startBodyPattern: ["rect"],
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
      // the face-reference pick that rides alongside pickFacePlane; null here
      // because pickFacePlane already says "no body face under the cursor"
      faceAnchor: () => null,
      hoverFaceAt: () => {},
      hoverPlane: () => {},
      clearHover: () => {},
      pickPlane: () => null,
      // null = no face pre-selected, so startExtrude takes its region branch
      selectedFacesForPressPull: () => null,
      // same for the Sketch button: no usable pre-selection, so it arms the
      // interactive plane pick (the face-first path is
      // src/features/sketchOnPreselectedFace.test.ts)
      selectedFaceSketchPlane: () => null,
      clearSelection: () => act("clearSelection"),
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
    // Only a NON-EMPTY message counts as speaking. main.ts:1386 is
    // `statusEl.textContent = text`, so setStatus("") CLEARS the bar — a starter
    // that "refuses with a message" of "" tells the user exactly as much as the
    // silent `return` this whole file exists to outlaw, and the first version of
    // this harness scored it as a pass.
    setStatus: (t: string) => { if (t.trim()) act(`status(${t})`); },
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

describe("the feature entry points that live in main.ts, not in featureStarters", () => {
  // main.ts wires four model-view entry points itself — Offset Face, Thicken
  // (one function), edit-feature, and the Delete key — and they are invisible to
  // the matrix above because they never appear in the object createFeatureStarters
  // returns. Same property, read off the source: a toolBusy() EARLY RETURN either
  // says something, or it is named here with a reason.
  //
  // The cost of reading source is that this must know how the guard is spelled,
  // so it also asserts the mechanism is still there (below). Rename toolBusy and
  // this fails loudly instead of passing with a hole in it.
  const GUARD = /if \(([^)]*\btoolBusy\(\)[^)]*)\)\s*(\{[^{}]*\}|return[^;]*;)/g;
  const OWNER = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^([\w.]+)\s*=|^(window\.addEventListener\("\w+")/;

  /** Guards that refuse and stay silent are only allowed here, with a reason.
   *  Keyed by the enclosing handler, which is what a reader greps for. */
  const SILENT_BY_DESIGN: Record<string, string> = {
    "viewport.onHit":
      "a hover/hit handler: it only sets the passive 'Del deletes this face' hint, " +
      "and a status line on every pointer move while a tool runs would flood the bar",
    "viewport.onSelectionChange":
      "same — a passive 'n edges selected' hint, fired by selection changes, not by a click on a command",
    "viewport.onBodySelectionChange":
      "same, for body selection",
    "viewport.regionHoverAt":
      "a hover PREDICATE whose false return means 'not my hit'; it starts nothing",
    "viewport.regionPickAt":
      "a pick PREDICATE: false hands the click to the next picker rather than refusing a command, " +
      "and the tool that IS running already owns the prompt",
  };

  /** The handler each guard sits in — the nearest preceding top-level binding. */
  function ownerOf(src: string, index: number): string {
    const before = src.slice(0, index).split("\n");
    for (let i = before.length - 1; i >= 0; i--) {
      const m = OWNER.exec(before[i] ?? "");
      if (m) return m[1] ?? m[2] ?? m[3] ?? "?";
    }
    return "?";
  }

  const guards = [...mainSrc.matchAll(GUARD)]
    // `!toolBusy()` is the opposite shape: it ACTS when nothing is running, so
    // there is no refusal to voice.
    .filter((m) => !(m[1] ?? "").includes("!toolBusy()"))
    .map((m) => ({
      owner: ownerOf(mainSrc, m.index ?? 0),
      speaks: (m[2] ?? "").includes("setStatus("),
    }));

  it("still finds the guard it is written to check", () => {
    // A rename or a reformat that stops this regex matching would silently
    // disable everything below, which is the standard failure of a source-reading
    // test. 8 sites at the time of writing; the floor is deliberately lower.
    expect(guards.length).toBeGreaterThanOrEqual(6);
    expect(mainSrc).toContain("function toolBusy(");
    expect(mainSrc).toContain("TOOL_BUSY_MESSAGE");
    expect(guards.every((g) => g.owner !== "?")).toBe(true);
  });

  it("has no silent toolBusy() refusal that is not argued for", () => {
    const silent = guards.filter((g) => !g.speaks).map((g) => g.owner);
    const undocumented = silent.filter((o) => !(o in SILENT_BY_DESIGN));
    expect(
      undocumented,
      `main.ts refuses silently in ${undocumented.join(", ")} — either say why ` +
        `it refused (setStatus(TOOL_BUSY_MESSAGE, "")) or add it to ` +
        `SILENT_BY_DESIGN with a reason`,
    ).toEqual([]);
  });

  it("has no stale exemption", () => {
    // An exemption naming a handler that no longer exists is a hole that reads
    // like coverage — the same reason the sidecar checks PAYLOAD_FREE.
    const owners = new Set(guards.map((g) => g.owner));
    const stale = Object.keys(SILENT_BY_DESIGN).filter((o) => !owners.has(o));
    expect(stale, `SILENT_BY_DESIGN names guards main.ts no longer has: ${stale.join(", ")}`)
      .toEqual([]);
  });

  it("makes Offset Face, Thicken, edit-feature and Delete speak", () => {
    // The three that were mute, named: a regression here is a dead click on a
    // ribbon button, and the generic assertion above would only say "undocumented".
    for (const owner of ["startFaceOffset", "editFeature"]) {
      const g = guards.filter((x) => x.owner === owner);
      expect(g.length, `no toolBusy() guard found in ${owner}`).toBeGreaterThan(0);
      expect(g.every((x) => x.speaks), `${owner} refuses silently`).toBe(true);
    }
    // The Delete key's guard sits in an anonymous keydown listener, so it is
    // identified by its owner prefix rather than a function name.
    const keydown = guards.filter((g) => g.owner.startsWith("window.addEventListener"));
    expect(keydown.length).toBeGreaterThan(0);
    expect(keydown.every((g) => g.speaks), "the Delete key refuses silently").toBe(true);
  });
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

// Move, when what is selected is a datum plane.
//
// A datum plane is a FEATURE, never a body, so it can never appear in
// getSelectedBodies(). startMove's "none selected → active body" convenience
// therefore fired and silently began dragging an unrelated body — the last one
// in the build — while the user believed they were moving the plane they had
// just clicked.
//
// There is no other way to move an offset plane (editFeature has no datumPlane
// arm, planeOffsetTool is creation-only, moveTool takes bodies), so reaching for
// Move here is the obvious gesture. Related to field report df10c0b3: "press/pull
// to an offset plane, then move the offset plane and expect the surface to move
// with the offset plane... does not visibly do this."
describe("Move with a datum plane selected", () => {
  const world = () => ({
    busy: false,
    bodies: [{ id: "body1", name: "Body1" }, { id: "body2", name: "Body2" }],
    features: [{ id: "d1", type: "datumPlane" }],
    regions: 0,
  });

  it("refuses, instead of dragging whichever body happens to be last", () => {
    const h = harness(world());
    (h.deps as { getSelectedFeature: () => string | null }).getSelectedFeature = () => "d1";
    const starters = createFeatureStarters(h.deps as never);
    starters.startMove();
    expect(
      h.log.join("\n"),
      "Move started on a body while a datum plane was selected — the user asked to move the "
        + "plane and something else moved instead",
    ).not.toContain("moveTool.start");
  });

  it("says what to do instead, rather than refusing in silence", () => {
    const h = harness(world());
    (h.deps as { getSelectedFeature: () => string | null }).getSelectedFeature = () => "d1";
    const starters = createFeatureStarters(h.deps as never);
    starters.startMove();
    // the harness routes setStatus into `log` as `status(...)`; `spoke` is only
    // the modal/prompt sinks
    const said = [...h.log, ...spoke].join("\n");
    expect(said, "Move refused a datum plane without saying anything").toMatch(/status\(/);
    expect(said, "the message does not point at the Offset field, which is the only way").toMatch(/Offset/i);
  });

  it("still moves the active body when nothing is selected at all", () => {
    // The convenience itself is deliberate and must survive: this narrows it,
    // it does not remove it.
    const h = harness(world());
    (h.deps as { getSelectedFeature: () => string | null }).getSelectedFeature = () => null;
    const starters = createFeatureStarters(h.deps as never);
    starters.startMove();
    expect(
      h.log.join("\n"),
      "Move no longer falls back to the active body when nothing is selected",
    ).toContain("moveTool.start");
  });

  it("still moves a selected BODY, plane or no plane", () => {
    const h = harness(world());
    (h.deps.viewport as { getSelectedBodies: () => string[] }).getSelectedBodies = () => ["body1"];
    (h.deps as { getSelectedFeature: () => string | null }).getSelectedFeature = () => "d1";
    const starters = createFeatureStarters(h.deps as never);
    starters.startMove();
    expect(
      h.log.join("\n"),
      "an explicit body selection must win — the plane selection is incidental there",
    ).toContain("moveTool.start");
  });
});
