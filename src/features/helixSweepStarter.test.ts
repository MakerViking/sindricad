// Sweep around a helix, from the Sweep button (Doug 30: "a HELIX as a
// sketch/path entity ... to sweep a thread profile along in a boolean
// subtract").
//
// Driven the way the user drives it: Sweep with a profile area selected, a path
// sketch holding a circle, the real pitch/turns box typed into and Enter
// pressed, and the operation chooser answered with its FIRST option, which is
// what Enter picks there. What is asserted is the feature that lands in the
// document. The geometry it builds is the sidecar's (test_sweep_path.py).
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument, byClass } from "../ui/fakeDom.testkit";

installFakeDocument();

/** Every chooser the flow opens, in order, and how each is answered. */
const asked: { title: string; options: { value: string; label: string }[] }[] = [];
let answer: (title: string, options: { value: string; label: string }[]) => string | null = (_t, o) => o[0]?.value ?? null;
vi.mock("../ui/choice", () => ({
  choose: async (title: string, options: { value: string; label: string }[]) => {
    asked.push({ title, options });
    return answer(title, options);
  },
  chooseMulti: async () => null,
  isChoiceOpen: () => false,
}));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= () => 0;

const { createFeatureStarters } = await import("./featureStarters");
const { SketchPlane } = await import("../sketch/plane");
const { t } = await import("../i18n");

/** A 12 x 12 x 10 block with an M6 bore (minor radius 2.46) along Z. */
const inBlock = (p: THREE.Vector3) => p.z > 0 && p.z < 10 && Math.hypot(p.x, p.y) > 2.46 && Math.abs(p.x) < 6 && Math.abs(p.y) < 6;

/** The block's top face as a sketch plane: its normal points OUT of the block. */
const TOP_FACE = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] } as const;

/** A plate under the XY plane, 5 thick: the open air is everywhere above it. */
const inPlate = (p: THREE.Vector3) => p.z > -5 && p.z < 0 && Math.abs(p.x) < 40 && Math.abs(p.y) < 40;

/** The profile's area: its anchor point, and its outer boundary on XZ as
 *  (radius, height) corners. Without corners only the anchor is there to probe. */
function harness(opts: {
  profileAt: [number, number, number];
  pathEntities: unknown[];
  corners?: [number, number][];
  solid?: (p: THREE.Vector3) => boolean;
}) {
  const added: Record<string, unknown>[] = [];
  const status: string[] = [];
  const busy: boolean[] = [];
  const features = [
    { id: "thr", type: "sketch", plane: "XZ", entities: [] },
    { id: "hx", type: "sketch", plane: TOP_FACE, entities: opts.pathEntities },
  ];
  const deps = {
    store: {
      nextId: () => "f9",
      addFeature: (f: Record<string, unknown>) => added.push(f),
      document: { features, parameters: {} },
      buildState: { result: { bodies: [{ id: "body1", name: "Body1" }] } },
    },
    viewport: {
      selectedEdgeSelectors: () => [],
      pointInSolid: opts.solid ?? inBlock,
      projectToScreen: () => ({ x: 50, y: 60 }),
    },
    overlay: {
      selectedRegions: () => [{
        sketchId: "thr",
        interior3D: new THREE.Vector3(...opts.profileAt),
        plane: new SketchPlane("XZ"),
        region: { loop: (opts.corners ?? []).map(([x, y]) => new THREE.Vector2(x, y)) },
      }],
      regions: [],
    },
    toolBusy: () => false,
    hasBody: () => true,
    setStatus: (text: string) => status.push(text),
    setPlanePick: (v: boolean) => busy.push(v),
  };
  return { starters: createFeatureStarters(deps as never), added, status, busy };
}

/** The open pitch/turns box: its inputs in order, read off the real DimInput. */
function helixBox(): FakeEl[] {
  const body = (globalThis as unknown as { document: { body: FakeEl } }).document.body;
  const inputs: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "input") inputs.push(el);
    el.children.forEach(walk);
  };
  byClass(body, "dim-input").forEach(walk);
  return inputs;
}

/** Type into a field the way a keystroke does, then Enter. */
function typeAndEnter(values: string[]) {
  const inputs = helixBox();
  expect(inputs.length, "the pitch/turns box is not open").toBe(2);
  values.forEach((v, i) => {
    inputs[i]!.value = v;
    inputs[i]!.dispatch("input");
  });
  inputs[0]!.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const CIRCLE = { type: "circle", id: "c1", radius: 3, x: 0, y: 0, construction: true };

beforeEach(() => {
  asked.length = 0;
  answer = (_t, o) => o[0]?.value ?? null;
});

describe("Sweep around a helix", () => {
  it("cuts a thread into the part: down from a circle on its top face, Cut first", async () => {
    // The profile sits in the block's wall just under the top face, and the
    // circle is drawn ON the top face, whose normal points out into the air.
    const h = harness({ profileAt: [2.7, 0, 9.7], pathEntities: [CIRCLE] });
    const run = h.starters.startSweep();
    typeAndEnter(["1", "14"]);
    await run;

    expect(asked.map((a) => a.title), "a circle with no curves to follow is a helix; nothing to ask").toEqual([
      t("feature.starters.sweep.helixOpTitle"),
    ]);
    expect(asked[0]!.options[0]!.value, "a profile in the part's material should default to Cut").toBe("cut");
    expect(h.added).toEqual([{
      id: "f9", type: "sweep", profile: "thr", path: "hx", helixCircle: "c1",
      pitch: 1, turns: 14, flip: true, operation: "cut", joinTouchingOnly: true,
    }]);
    expect(h.busy, "the busy flag the box held was never released").toEqual([true, false]);
  });

  it("still cuts down into the part from a profile drawn ON its top face", async () => {
    // The profile's area straddles the face, so the point inside it sits on
    // the surface, where an inside/outside test can go either way (the fake
    // here says outside). The material a pitch below it is what decides.
    const h = harness({ profileAt: [2.7, 0, 10], pathEntities: [CIRCLE] });
    const run = h.starters.startSweep();
    typeAndEnter(["1", "11"]);
    await run;

    expect(asked[0]!.options[0]!.value).toBe("cut");
    expect(h.added[0]).toMatchObject({ flip: true, operation: "cut", turns: 11 });
  });

  it("makes a coil in the open: New Body first, and no flip key at all", async () => {
    const h = harness({ profileAt: [20, 0, 0.5], pathEntities: [CIRCLE] });
    const run = h.starters.startSweep();
    typeAndEnter(["2.5", "6.5"]);
    await run;

    expect(asked[0]!.options[0]!.value).toBe("new");
    expect(h.added).toEqual([{
      id: "f9", type: "sweep", profile: "thr", path: "hx", helixCircle: "c1",
      pitch: 2.5, turns: 6.5, operation: "new", joinTouchingOnly: true,
    }]);
  });

  it("finds the wall with the profile's tip when its anchor sits in the bore", async () => {
    // A cutter that reaches well into the bore: its anchor point is in the
    // hole and a pitch either side of it is hole or air, but its tip is in the
    // wall just under the top face. Probing the anchor alone guessed a New
    // Body and built a coil standing on the block.
    const h = harness({
      profileAt: [2.277, 0, 10],
      corners: [[1.5, 9.55], [2.33, 9.55], [3, 9.9375], [3, 10.0625], [2.33, 10.45], [1.5, 10.45]],
      pathEntities: [CIRCLE],
    });
    const run = h.starters.startSweep();
    typeAndEnter(["1", "10"]);
    await run;

    expect(asked[0]!.options[0]!.value, "the tip is in the wall: this is a thread").toBe("cut");
    expect(h.added[0]).toMatchObject({ flip: true, operation: "cut" });
  });

  it("cuts up into the part from a profile drawn a pitch below it", async () => {
    // The way to a thread that runs cleanly out of the bottom face. The
    // anchor a pitch up lands exactly on that face; the profile's outer
    // corners a pitch up are in the wall.
    const h = harness({
      profileAt: [2.65, 0, -1],
      corners: [[2.3, -1.4665], [3, -1.0625], [3, -0.9375], [2.3, -0.5335]],
      pathEntities: [CIRCLE],
    });
    const run = h.starters.startSweep();
    typeAndEnter(["1", "12"]);
    await run;

    expect(asked[0]!.options[0]!.value).toBe("cut");
    expect(h.added[0]).toMatchObject({ operation: "cut", turns: 12 });
    expect(h.added[0], "the circle's normal already points up into the part").not.toHaveProperty("flip");
  });

  it("grows a coil standing on a plate up off it, whichever operation is picked", async () => {
    // Material lies a pitch below the profile and none above. For a Cut that
    // means down into the plate; for a New Body or a Join it means up into
    // the open. The direction used to be guessed for Cut whatever was picked,
    // and a New Body coil ran down through the plate.
    const corners: [number, number][] = [[19.6, 0.1], [20.4, 0.1], [20.4, 0.9], [19.6, 0.9]];
    for (const [op, flip] of [["new", false], ["join", false], ["cut", true]] as const) {
      asked.length = 0;
      answer = (_t, o) => (o.some((x) => x.value === op) ? op : o[0]!.value);
      const h = harness({ profileAt: [20, 0, 0.5], corners, pathEntities: [CIRCLE], solid: inPlate });
      const run = h.starters.startSweep();
      typeAndEnter(["2.5", "6"]);
      await run;

      expect(h.added, `${op}: committed`).toHaveLength(1);
      expect(h.added[0]!.operation).toBe(op);
      expect(h.added[0]!.flip ?? false, `${op}: which way the helix runs`).toBe(flip);
    }
  });

  it("asks which circle when there are several, naming each by its diameter", async () => {
    const h = harness({
      profileAt: [20, 0, 0.5],
      pathEntities: [CIRCLE, { type: "circle", id: "c2", radius: 4, x: 0, y: 0 }],
    });
    answer = (title, o) => (title === t("feature.starters.sweep.pickCircle") ? "c2" : o[0]!.value);
    const run = h.starters.startSweep();
    await flush();
    typeAndEnter(["1", "3"]);
    await run;

    expect(asked[0]!.options.map((o) => o.label)).toEqual([
      t("feature.starters.sweep.circleLabel", { n: 1, d: "6", unit: "mm" }),
      t("feature.starters.sweep.circleLabel", { n: 2, d: "8", unit: "mm" }),
    ]);
    expect(h.added[0]?.helixCircle).toBe("c2");
  });

  it("with curves AND a circle, following the curves stays the default", async () => {
    const line = { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 };
    const h = harness({ profileAt: [20, 0, 0.5], pathEntities: [line, CIRCLE] });
    const run = h.starters.startSweep();
    await run;

    expect(asked[0]!.title).toBe(t("feature.starters.sweep.pathOrHelix"));
    expect(asked[0]!.options.map((o) => o.value)).toEqual(["path", "helix"]);
    expect(h.added, "the plain sweep along the line, exactly as before").toEqual([
      { id: "f9", type: "sweep", profile: "thr", path: "hx", operation: "new", joinTouchingOnly: true },
    ]);
  });

  it("commits nothing when the path-or-helix question is dismissed", async () => {
    const line = { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 };
    const h = harness({ profileAt: [20, 0, 0.5], pathEntities: [line, CIRCLE] });
    answer = () => null;
    await h.starters.startSweep();
    expect(h.added).toEqual([]);
  });

  it("refuses a zero pitch out loud, and commits nothing", async () => {
    const h = harness({ profileAt: [2.7, 0, 9.7], pathEntities: [CIRCLE] });
    const run = h.starters.startSweep();
    typeAndEnter(["0", "10"]);
    await run;
    expect(h.added).toEqual([]);
    expect(h.status).toContain(t("feature.starters.sweep.helixZero"));
    expect(h.busy).toEqual([true, false]);
  });
});
