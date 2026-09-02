// What the user actually SEES when an edit gesture reaches the inspector: where
// the caret lands, and that a fieldless feature says something rather than
// rendering an empty panel (field report c8531ceb).
//
// Both behaviours shipped with no cover at all because "there is no jsdom in
// this project" was taken to mean "not testable". It isn't: the inspector only
// ever calls createElement, appendChild/append, querySelector("input"), focus
// and scrollIntoView, so a ~70-line element stub is enough to run render() for
// real and read the result back. Deliberately NOT a jsdom dependency — this
// covers the two behaviours that regressed, not the DOM.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeEl, fakeFocus, installFakeDocument } from "./fakeDom.testkit";
import { Inspector } from "./inspector";
import { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, Feature, RebuildReply } from "../types";

// --- the element stub -------------------------------------------------------
// Lives in fakeDom.testkit.ts so the timeline's chip test renders against the
// same stub (featureEditReachable.test.ts) instead of a second copy that could
// drift. `fakeFocus.el` is the element that most recently had focus() called on
// it, so a test can ask "did the caret land here" the way a user would notice.

installFakeDocument();

// --- reading the rendered panel back ---------------------------------------

/** Every rendered label/input pair, in document order. */
function rows(root: FakeEl): { label: string; input: FakeEl }[] {
  const out: { label: string; input: FakeEl }[] = [];
  const walk = (el: FakeEl) => {
    if (el.className === "param-row") {
      const label = el.children.find((c) => c.tagName === "label");
      const input = el.children.find((c) => c.tagName === "input");
      if (label && input) out.push({ label: label.textContent, input });
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

/** The rendered row whose <label> reads `label`, whatever else it is classed. */
function findRow(root: FakeEl, label: string): FakeEl | undefined {
  let hit: FakeEl | undefined;
  const walk = (el: FakeEl) => {
    if (el.className.split(" ").includes("param-row")) {
      if (el.children.some((c) => c.tagName === "label" && c.textContent === label)) hit ??= el;
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  return hit;
}

/** Every button in the panel, in document order — the panel had none at all
 *  before the up-to clear control, so this doubles as "is there a control here". */
function buttons(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "button") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

/** All visible text in the panel, in document order. */
function texts(root: FakeEl): string[] {
  const out: string[] = [];
  const walk = (el: FakeEl) => {
    if (el.textContent) out.push(el.textContent);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

// --- a store that only has to answer what render() asks ---------------------

function makeStore(features: Feature[], parameters: Record<string, number> = { width: 40 }) {
  const doc = { features, parameters, paramDefs: {} } as unknown as CadDocument;
  const writes: string[] = [];
  const store = {
    document: doc,
    paramIssues: {} as Record<string, string>,
    onDocChange: () => () => {},
    boundExpr: () => null,
    isParamBound: () => false,
    setParam: (name: string, v: number) => writes.push(`param ${name}=${v}`),
    setTargetValue: (t: { field: string }, v: number) => writes.push(`field ${t.field}=${v}`),
    setTargetExpr: () => null,
    updateFeature: () => {},
  };
  return { store: store as unknown as DocumentStore, writes };
}

function mount(features: Feature[], parameters?: Record<string, number>) {
  const root = new FakeEl("div");
  const { store, writes } = makeStore(features, parameters);
  const inspector = new Inspector(root as unknown as HTMLElement, store);
  return { root, inspector, writes };
}

const cylinder = { id: "f1", type: "cylinder", radius: 5, height: 12 } as unknown as Feature;
const imported = { id: "f3", type: "import", solid: true } as unknown as Feature;

beforeEach(() => {
  fakeFocus.el = null;
});

describe("inspector: where the edit gesture lands", () => {
  it("focuses the FEATURE's first field, never a global parameter row", () => {
    // The panel's first input is a document parameter. Focusing the panel
    // instead of the feature's own box means the user types 12, hits Enter and
    // silently rewrites `width` — a rebuild of something they never selected.
    const { root, inspector, writes } = mount([cylinder]);
    inspector.select("f1", true);

    const all = rows(root);
    expect(all.map((r) => r.label)).toEqual(["width", "Radius mm", "Height mm"]);
    expect(fakeFocus.el, "nothing was focused at all").not.toBeNull();
    expect(fakeFocus.el, "the caret is in the global `width` parameter row").not.toBe(all[0]!.input);
    expect(all.find((r) => r.input === fakeFocus.el)?.label).toBe("Radius mm");

    // and the consequence itself: typing into the caret's own input writes the
    // CYLINDER's radius, not the document parameter
    fakeFocus.el!.value = "12";
    fakeFocus.el!.dispatch("change");
    expect(writes).toEqual(["field radius=12"]);
  });

  it("plain selection does not steal the caret", () => {
    // select(id) without focus is every single click in the timeline; stealing
    // focus there yanks the caret out of whatever the user was typing.
    const { root, inspector } = mount([cylinder]);
    inspector.select("f1");
    expect(rows(root).length).toBe(3);
    expect(fakeFocus.el).toBeNull();
  });

  it("a feature with no numeric fields names itself and says there is nothing to edit", () => {
    // A blank panel is indistinguishable from a broken one, and the gesture
    // that got here was a deliberate double-click.
    const { root, inspector } = mount([imported]);
    inspector.select("f3", true);
    const shown = texts(root);
    expect(shown).toContain("Import · f3");
    expect(shown.join("\n")).toContain("No editable values");
    expect(fakeFocus.el, "there is no input to focus, and no crash either").toBeNull();
  });

  it("survives the states an edit gesture can arrive in", () => {
    const { root, inspector } = mount([{ id: "s1", type: "sketch", plane: "XY", entities: [] } as unknown as Feature]);
    expect(() => inspector.select(null, true)).not.toThrow();
    expect(() => inspector.select("ghost", true)).not.toThrow();
    expect(() => inspector.select("s1", true)).not.toThrow();
    expect(rows(root).map((r) => r.label)).toEqual(["width"]); // empty sketch: no dims
  });
});

describe("inspector: rows that don't apply are not offered", () => {
  const plain = { id: "p1", type: "press-pull", face: {}, distance: 3, operation: "join" } as unknown as Feature;
  const upTo = { id: "p2", type: "press-pull", face: {}, distance: 3, operation: "join", upToPlane: "top" } as unknown as Feature;

  it("hides Target offset on a plain-distance press/pull", () => {
    // The sidecar ignores upToOffset without an up-to target, so the row was an
    // input that swallowed the number and changed nothing (bug #88).
    const { root, inspector } = mount([plain]);
    inspector.select("p1");
    expect(rows(root).map((r) => r.label)).toEqual(["width", "Distance mm"]);
  });

  it("shows Target offset once there IS a target", () => {
    const { root, inspector } = mount([upTo]);
    inspector.select("p2");
    expect(rows(root).map((r) => r.label)).toEqual(["width", "Distance mm", "Target offset mm"]);
  });

  it("counts a FACE target too, not just a datum plane", () => {
    const face = { id: "p3", type: "press-pull", face: {}, distance: 3, operation: "join", upTo: { by: "match" } } as unknown as Feature;
    const { root, inspector } = mount([face]);
    inspector.select("p3");
    expect(rows(root).map((r) => r.label)).toContain("Target offset mm");
  });
});

// --- clearing an up-to target (GH #41) --------------------------------------
//
// An extrude or press/pull committed with an "up to that face/plane" target had
// no way back: nothing in the app deleted `upTo`/`upToPlane`, and because the
// Taper row is hidden while a target exists (numFields.isBlindExtrude), taper
// became permanently unreachable on that feature. These run the REAL store, so
// what is asserted is the document the user ends up with — a stub that applies
// the patch itself would only restate the test.

function stubBackend(): GeometryBackend {
  return {
    async rebuild(): Promise<RebuildReply> {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
}

function mountReal(feature: Feature, paramDefs?: CadDocument["paramDefs"]) {
  const store = new DocumentStore(stubBackend(), {
    parameters: {},
    features: [feature],
    ...(paramDefs ? { paramDefs } : {}),
  } as unknown as CadDocument);
  const root = new FakeEl("div");
  const inspector = new Inspector(root as unknown as HTMLElement, store);
  return { root, inspector, store };
}

const savedExtrude = {
  id: "e1",
  type: "extrude",
  sketch: "s1",
  distance: 5,
  operation: "new",
  upToPlane: "d1",
  upToOffset: 3,
} as unknown as Feature;

describe("inspector: clearing an up-to target", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("offers a clear control that names what it does", () => {
    const { root, inspector } = mountReal(savedExtrude);
    inspector.select("e1");

    const btns = buttons(root);
    expect(btns.length, "the panel offers no control at all").toBe(1);
    expect(btns[0]!.title.toLowerCase()).toContain("clear the up-to target");
    // the row says WHICH target, so the button is not a blind delete
    expect(texts(root)).toContain("Up to");
    // no datum called d1 exists in this fixture, so the raw id is the fallback
    expect(texts(root)).toContain("d1");
  });

  it("names the plane the way the browser tree does, so a rename shows", () => {
    const named = { id: "d1", type: "datumPlane", source: "XY", offset: 5, name: "Lid plane" };
    const unnamed = { id: "d2", type: "datumPlane", source: "XY", offset: 9 };
    const mount = (planes: object[], upToPlane: string) => {
      const store = new DocumentStore(stubBackend(), {
        parameters: {},
        features: [...planes, { ...(savedExtrude as object), upToPlane }],
      } as unknown as CadDocument);
      const root = new FakeEl("div");
      new Inspector(root as unknown as HTMLElement, store).select("e1");
      return texts(root);
    };
    expect(mount([named], "d1")).toContain("Lid plane");
    expect(mount([named, unnamed], "d2"), "second datum, no name").toContain("Plane2");
    expect(mount([], "XY")).toContain("XY plane");
    expect(mount([], "gone"), "a deleted datum must not throw mid-render").toContain("gone");
  });

  it("clicking it drops the target and brings Taper back", () => {
    const { root, inspector, store } = mountReal(savedExtrude);
    inspector.select("e1");

    buttons(root)[0]!.dispatch("click");

    const f = store.document.features[0] as unknown as Record<string, unknown>;
    expect("upToPlane" in f, "the up-to plane survived the clear").toBe(false);
    expect("upTo" in f, "the up-to face survived the clear").toBe(false);
    expect("upToOffset" in f, "an orphan target offset was left behind").toBe(false);
    expect(f.distance, "the saved depth was not preserved").toBe(5);
    // the payoff: the row that the target was hiding
    const labels = rows(root).map((r) => r.label);
    expect(labels, "Taper is still unreachable").toContain("Taper°");
    expect(labels, "Target offset outlived its target").not.toContain("Target offset mm");
    expect(buttons(root).length, "the clear control is still offered with nothing to clear").toBe(0);
  });

  it("lays the target out on its own track, not the 84px input one", () => {
    // `.param-row`'s second column is a fixed 84px input track. The clear
    // button takes 26px of it, and "Picked face" measures 68.5px — measured in
    // Chromium against the real stylesheet, the button wrapped onto a second
    // line under the name and the row rendered 38px tall against its
    // neighbours' 29px. `.param-row-target` widens that column to 110px and
    // `.param-target` makes the cell a flex box that ellipsises overlong names,
    // which brought the row back to 18px with the button inline. Layout is not
    // observable in this fake DOM, so what is pinned here is that the row still
    // carries the hooks those rules key on.
    const { root, inspector } = mountReal(savedExtrude);
    inspector.select("e1");

    const row = findRow(root, "Up to");
    expect(row, "no Up to row rendered").toBeTruthy();
    expect(row!.className.split(" "), "the row falls back to the 84px input track").toContain("param-row-target");
    const cell = row!.children.find((c) => c.className === "param-target");
    expect(cell, "the name and the button are not in a flex cell — they will wrap").toBeTruthy();
    expect(cell!.children.length, "the name and the clear button should share the cell").toBe(2);
  });

  it("covers a picked FACE target too, and press/pull as well", () => {
    const face = {
      id: "p1",
      type: "press-pull",
      face: {},
      distance: 4,
      operation: "join",
      upTo: { kind: "face", by: "nearest", point: [0, 0, 10] },
    } as unknown as Feature;
    const { root, inspector, store } = mountReal(face);
    inspector.select("p1");

    expect(texts(root), "a face target has no id to show, so it is named").toContain("Picked face");
    buttons(root)[0]!.dispatch("click");

    const f = store.document.features[0] as unknown as Record<string, unknown>;
    expect("upTo" in f, "the picked face survived the clear").toBe(false);
    expect(rows(root).map((r) => r.label)).toEqual(["Distance mm"]);
  });
});
