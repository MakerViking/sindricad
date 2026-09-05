// Editing a sketch dimension from the INSPECTOR (field report 8b49c06e): "the
// parameters panel on the right changes the number but does not adjust attached
// circles", and doing it while the sketch is open changes nothing at all.
//
// The panel used to write raw coordinates into the document feature and stop
// there — no driving constraint, no solve — so anything held to the edited
// entity by a constraint stayed exactly where it was. Both halves are observed
// here through the REAL Inspector, the REAL DocumentStore and the REAL solver:
// the geometry that comes out, not the call that went in.
import { describe, it, expect, beforeEach, vi } from "vitest";

declare const process: { cwd(): string };
// the wasm `?url` import resolves root-relative under vitest (see
// sketch/sketchSolve.test.ts) — point the loader at the file on disk
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { FakeEl, fakeFocus, installFakeDocument } from "./fakeDom.testkit";
import { Inspector } from "./inspector";
import { DocumentStore } from "../document/store";
import { solveSketchFeature } from "../sketch/headlessSolve";
import type { CadDocument, Feature, RebuildReply, SketchConstraint } from "../types";
import type { GeometryBackend } from "../geometry/client";
import mainSrc from "../main.ts?raw";

installFakeDocument();
// the store schedules its debounced rebuild off `window`
vi.stubGlobal("window", { setTimeout, clearTimeout });

const backend = (): GeometryBackend => ({
  async rebuild(): Promise<RebuildReply> {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus() { return () => {}; },
  connected: true,
} as unknown as GeometryBackend);

/** The reporter's shape, minimised: a line with a circle tangent to it. Moving
 *  the circle's diameter must move the circle so the tangency still holds. */
const doc = (): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
      entities: [
        { id: "l1", type: "line", x1: -30, y1: -10, x2: 30, y2: -10 },
        { id: "c1", type: "circle", x: 0, y: 0, radius: 10 },
        { id: "r1", type: "rectangle", x: 40, y: 40, width: 20, height: 8 },
      ],
      constraints: [
        { type: "fix", e: "l1", p: 0 },
        { type: "fix", e: "l1", p: 1 },
        { type: "tangent2", a: "l1", b: "c1" },
      ] as SketchConstraint[],
    },
  ] as Feature[],
});

/** The rendered input of the first row whose <label> reads `label`. */
function input(root: FakeEl, label: string): FakeEl {
  let hit: FakeEl | undefined;
  const walk = (el: FakeEl) => {
    if (el.className.split(" ").includes("param-row")) {
      if (el.children.some((c) => c.tagName === "label" && c.textContent === label)) {
        hit ??= el.children.find((c) => c.tagName === "input");
      }
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  if (!hit) throw new Error(`no "${label}" row in the panel`);
  return hit;
}

const sketchOf = (store: DocumentStore) =>
  store.document.features.find((f) => f.id === "f1") as Extract<Feature, { type: "sketch" }>;

/** the named entity's numeric fields (it exists; a missing one is a test bug) */
function entity(store: DocumentStore, id: string): { x: number; y: number; radius: number; width: number } {
  const e = sketchOf(store).entities.find((x) => x.id === id);
  if (!e) throw new Error(`no entity ${id} in the sketch`);
  return e as unknown as { x: number; y: number; radius: number; width: number };
}

/** let the store's serialized commit chain (solve -> mutate) run out */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(opts: { solver?: boolean } = {}) {
  const store = new DocumentStore(backend(), doc());
  if (opts.solver !== false) store.headlessSolve = solveSketchFeature;
  const root = new FakeEl("div");
  const inspector = new Inspector(root as unknown as HTMLElement, store);
  inspector.select("f1");
  return { store, root };
}

beforeEach(() => {
  fakeFocus.el = null;
});

describe("inspector: a sketch dimension edits like it does on the canvas", () => {
  it("re-solves, so the tangent circle follows the typed diameter", async () => {
    const { store, root } = mount();
    const row = input(root, "Diameter mm");
    row.value = "30";
    row.dispatch("change");
    await settle();

    const c = entity(store, "c1");
    // the typed value survives the solve (a raw radius write is a free variable
    // to the solver and comes back out as ~11.28)
    expect(c.radius).toBeCloseTo(15, 6);
    // ...and the circle MOVED so it still touches the line: the report's
    // "does not adjust attached circles"
    const gap = Math.abs(Math.abs(c.y - -10) - c.radius);
    expect(gap).toBeLessThan(1e-6);
    // the value is a driving dimension now, not just coordinates that happen to
    // look right — a raw-write regression must fail here too
    const dim = (sketchOf(store).constraints ?? []).find((k) => k.type === "diameter");
    expect(dim).toEqual({ type: "diameter", id: expect.any(String), circle: "c1", value: 30 });
  });

  it("still writes the dimensions that have no constraint form", async () => {
    // rectangle W/H (and slot/polygon) stay coordinate writes on both edit
    // paths — the panel must keep working for them.
    const { store, root } = mount();
    const row = input(root, "Width mm");
    row.value = "26";
    row.dispatch("change");
    await settle();
    expect(entity(store, "r1").width).toBe(26);
  });

  it("applies the value directly where no solver will start", async () => {
    // A machine whose planegcs WASM refuses to compile (0.1.100, Windows
    // WebView2) has nothing to drive the new constraint, and "typed a number,
    // nothing happened" is the exact bug directDims exists to prevent.
    const { store, root } = mount({ solver: false });
    const row = input(root, "Diameter mm");
    row.value = "30";
    row.dispatch("change");
    await settle();
    expect(entity(store, "c1").radius).toBe(15);
    expect((sketchOf(store).constraints ?? []).some((k) => k.type === "diameter")).toBe(true);
  });

  it("hands the edit to the live session instead of writing an open sketch", async () => {
    // SketchMode copies the entities at enter() and writes its own back at
    // finish(), so a document write here is invisible while typing and thrown
    // away on Finish.
    const { store, root } = mount();
    store.openSketchId = () => "f1";
    const routed: unknown[] = [];
    store.onSketchDimEdit = (...args) => routed.push(args);
    const before = JSON.stringify(sketchOf(store));

    const row = input(root, "Diameter mm");
    row.value = "30";
    row.dispatch("change");
    await settle();

    expect(JSON.stringify(sketchOf(store)), "the document copy of an open sketch was written").toBe(before);
    expect(routed).toEqual([["f1", "c1", "diameter", 30]]);
  });

  it("main.ts hands that hook to the sketch session", () => {
    // The store side above proves the routing decision; whether anything is
    // LISTENING is main.ts wiring, which no unit test can run (SketchMode needs
    // a WebGL viewport). Pinned as source text, in the style of
    // ambientSelection.test.ts — an unwired hook means the edit vanishes.
    expect(mainSrc).toContain("store.onSketchDimEdit =");
    expect(mainSrc).toContain("sketch.applyDimensionEdit(entityId, field, mm)");
  });
});
