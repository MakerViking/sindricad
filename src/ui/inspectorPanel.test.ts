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
import { t } from "../i18n";
// TEXT, not an import: importing main.ts boots the whole app (ribbonActions.test.ts).
import mainSrc from "../main.ts?raw";

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

describe("inspector: a split saved before the Split Body panel", () => {
  // It has no `offset` key, and that absence is what makes the sidecar rebuild
  // it the old way, whose piece ORDER every later positional body id depends
  // on. Typing 0 into its blank Offset wrote `offset: 0`: the cut moved
  // nowhere, the pieces re-ordered, and a later removeBody deleted another one.
  const old = { id: "s1", type: "split", keep: "both", plane: "XY", body: "body1", groupSides: true } as unknown as Feature;
  const offsetOf = (root: FakeEl) => rows(root).find((r) => r.label === "Offset mm")!.input;

  it("typing 0 into an old split's blank Offset writes nothing", () => {
    const { root, inspector, writes } = mount([old]);
    inspector.select("s1");
    const input = offsetOf(root);
    expect(input.value).toBe("");
    input.value = "0";
    input.dispatch("change");
    expect(writes).toEqual([]);
  });

  it("a real offset on an old split is written, and 0 on a panel split is too", () => {
    const { root, inspector, writes } = mount([old, { ...old, id: "s2", offset: 4 } as unknown as Feature]);
    inspector.select("s1");
    offsetOf(root).value = "3";
    offsetOf(root).dispatch("change");
    inspector.select("s2");
    offsetOf(root).value = "0";
    offsetOf(root).dispatch("change");
    expect(writes).toEqual(["field offset=3", "field offset=0"]);
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

// --- a sweep around a helix (Doug 30) ---------------------------------------
//
// Pitch and Turns exist only on a sweep whose path is a helix, and its two
// on/off choices are checkboxes rather than numbers. Run against the REAL store,
// so what is asserted is the document the user ends up with.

const helixSweep = {
  id: "s1",
  type: "sweep",
  profile: "p",
  path: "q",
  helixCircle: "c1",
  pitch: 1,
  turns: 14,
  operation: "cut",
} as unknown as Feature;

/** A checkbox row by its label: [the row, its checkbox]. */
function toggle(root: FakeEl, label: string): FakeEl {
  const row = findRow(root, label);
  expect(row, `no "${label}" row rendered`).toBeTruthy();
  const box = row!.children.find((c) => c.tagName === "input" && c.type === "checkbox");
  expect(box, `the "${label}" row has no checkbox`).toBeTruthy();
  return box!;
}

describe("inspector: a sweep around a helix", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("offers Pitch and Turns, and the Left-hand and Flip direction switches", () => {
    const { root, inspector } = mountReal(helixSweep);
    inspector.select("s1");
    expect(rows(root).map((r) => r.label)).toEqual(["Pitch mm", "Turns"]);
    const left = toggle(root, t("inspector.field.leftHand")) as FakeEl & { checked?: boolean };
    const flip = toggle(root, t("inspector.field.flipDirection")) as FakeEl & { checked?: boolean };
    expect(left.checked).toBe(false);
    expect(flip.checked).toBe(false);
  });

  it("a plain sweep says it has nothing to edit, rather than an empty panel", () => {
    const plain = { id: "s2", type: "sweep", profile: "p", path: "q", operation: "new" } as unknown as Feature;
    const { root, inspector } = mountReal(plain);
    inspector.select("s2");
    expect(rows(root)).toEqual([]);
    expect(findRow(root, t("inspector.field.leftHand")), "a plain sweep offers a helix switch").toBeUndefined();
    expect(texts(root)).toContain(t("inspector.noFields"));
  });

  it("ticking Left-hand writes it, and unticking takes the key out again", () => {
    const { root, inspector, store } = mountReal(helixSweep);
    inspector.select("s1");
    const box = toggle(root, t("inspector.field.leftHand")) as FakeEl & { checked?: boolean };
    box.checked = true;
    box.dispatch("change");
    const f = () => store.document.features[0] as unknown as Record<string, unknown>;
    expect(f().leftHand).toBe(true);
    expect((toggle(root, t("inspector.field.leftHand")) as FakeEl & { checked?: boolean }).checked, "the redrawn panel lost the tick").toBe(true);

    const again = toggle(root, t("inspector.field.leftHand")) as FakeEl & { checked?: boolean };
    again.checked = false;
    again.dispatch("change");
    // omitted when false: a sweep switched on and off again saves as it was
    expect("leftHand" in f(), "unticking left `leftHand: false` in the document").toBe(false);
  });

  it("Flip direction writes `flip`, and a lock refuses it and says why", () => {
    const { root, inspector, store } = mountReal(helixSweep);
    inspector.select("s1");
    const box = toggle(root, t("inspector.field.flipDirection")) as FakeEl & { checked?: boolean };
    box.checked = true;
    box.dispatch("change");
    expect((store.document.features[0] as unknown as Record<string, unknown>).flip).toBe(true);

    inspector.lockReason = () => LOCKED;
    const locked = toggle(root, t("inspector.field.flipDirection")) as FakeEl & { checked?: boolean };
    locked.checked = false;
    locked.dispatch("change");
    expect((store.document.features[0] as unknown as Record<string, unknown>).flip, "flipped back mid-tool").toBe(true);
    expect(locked.checked, "the refused box still shows the change that did not happen").toBe(true);
    expect(locked.title).toBe(LOCKED);
  });
});

// --- an extrude's start object, and a point or line target (GH #41) ----------
//
// Neither is a number, so like the up-to target each gets a named row with the
// one control that removes it. Real store: what is asserted is the document.

describe("inspector: where an extrude starts, and a point or line target", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const corner = {
    kind: "vertex",
    edge: { kind: "edge", by: "match", fp: { mid: [0, 0, 5], dir: [0, 0, 1], length: 10, curve: "line" }, body: "body1" },
    end: 1,
  };
  const saved = {
    id: "e1", type: "extrude", sketch: "s1", distance: 5, operation: "new",
    startFrom: { kind: "sketchPoint", sketch: "s2", entity: "p1", pointIndex: 0 }, startOffset: 2,
    upToRef: corner, upToOffset: 1,
  } as unknown as Feature;

  it("names both, and clearing the start keeps the start offset", () => {
    const { root, inspector, store } = mountReal(saved);
    inspector.select("e1");
    expect(texts(root)).toContain("Start from");
    expect(texts(root)).toContain("Sketch point");
    expect(texts(root), "a corner target was not named").toContain("Corner");

    const clear = buttons(root).find((b) => b.title.toLowerCase().includes("sketch plane"));
    expect(clear, "no control clears where it starts").toBeTruthy();
    clear!.dispatch("click");
    const f = store.document.features[0] as unknown as Record<string, unknown>;
    expect("startFrom" in f, "the start object survived the clear").toBe(false);
    expect(f.startOffset, "the start offset went with it").toBe(2);
    expect(texts(root)).not.toContain("Start from");
  });

  it("clearing a point or line target drops it and its offset, and brings Taper back", () => {
    const { root, inspector, store } = mountReal(saved);
    inspector.select("e1");
    expect(rows(root).map((r) => r.label), "Taper was offered beside a target").not.toContain("Taper°");
    buttons(root).find((b) => b.title.toLowerCase().includes("up-to"))!.dispatch("click");
    const f = store.document.features[0] as unknown as Record<string, unknown>;
    expect("upToRef" in f, "the corner target survived the clear").toBe(false);
    expect("upToOffset" in f).toBe(false);
    expect(rows(root).map((r) => r.label)).toContain("Taper°");
  });
});

// --- an extrude's Symmetric --------------------------------------------------
//
// Symmetric is a flag, not a number, so it had no row: a symmetric extrude
// showed Distance 3 with nothing saying it is split half each side, and a user
// editing that Distance could not know. Real store, so what is asserted is the
// document the switch leaves behind.

describe("inspector: an extrude's Symmetric", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  /** the Symmetric row's switch, if the panel offers one */
  const symmetricSwitch = (root: FakeEl): FakeEl | undefined =>
    findRow(root, "Symmetric")?.children.find((c) => c.tagName === "input");

  it("shows it, and switching it writes the flag, and off removes the key", () => {
    const plain = { id: "e2", type: "extrude", sketch: "s1", distance: 6, operation: "new" } as unknown as Feature;
    const { root, inspector, store } = mountReal(plain);
    inspector.select("e2");
    const sw = symmetricSwitch(root);
    expect(sw, "the inspector does not say whether an extrude is symmetric").toBeDefined();
    expect((sw as unknown as { checked: boolean }).checked).toBe(false);

    (sw as unknown as { checked: boolean }).checked = true;
    sw!.dispatch("change");
    const f = () => store.document.features[0] as unknown as Record<string, unknown>;
    expect(f().symmetric).toBe(true);
    expect((symmetricSwitch(root) as unknown as { checked: boolean }).checked, "the panel did not follow").toBe(true);

    const again = symmetricSwitch(root)!;
    (again as unknown as { checked: boolean }).checked = false;
    again.dispatch("change");
    // absent, not false: an extrude that is not symmetric keeps its exact bytes
    expect("symmetric" in f(), "switching it off wrote symmetric: false").toBe(false);
  });

  it("is not offered beside an up-to target, which the build refuses with it", () => {
    const { root, inspector } = mountReal(savedExtrude);
    inspector.select("e1");
    expect(symmetricSwitch(root)).toBeUndefined();
  });

  it("is read-only while a tool runs", () => {
    const plain = { id: "f2", type: "extrude", sketch: "f1", distance: 20, operation: "new" } as unknown as Feature;
    const { root, inspector, store } = mountReal(plain);
    inspector.select("f2");
    inspector.lockReason = () => t("inspector.lockedDuringTool");
    inspector.refresh();
    const sw = symmetricSwitch(root)!;
    expect(sw.disabled).toBe(true);
    (sw as unknown as { checked: boolean }).checked = true;
    sw.dispatch("change");
    expect("symmetric" in (store.document.features[0] as object), "the switch wrote through the lock").toBe(false);
  });
});

// --- read-only while a modeling tool runs (field 637278a9) -------------------
//
// "click/select a side face, parameters panel is populated with the previous
// extrude dimensions which are editable ... I select extrude to extrude the side
// face, the previous extrude dimension is still there ... if I put in a start
// offset it adjusts my first extrude instead of the one I am currently working
// on." Replayed on his document: the write landed on f2, the first extrude. The
// tool has no Start offset of its own, so the only one on screen was f2's.
//
// main.ts points lockReason at "a modeling tool is running"; these pin what the
// panel does with it. The text is the real locale string.

const LOCKED = t("inspector.lockedDuringTool");
/** f2 as saved in the reporter's document. */
const firstExtrude = {
  id: "f2",
  type: "extrude",
  sketch: "f1",
  distance: 20,
  operation: "new",
  startOffset: 10,
} as unknown as Feature;

describe("inspector: read-only while a tool runs", () => {
  it("says why, and offers no input to type into", () => {
    const { root, inspector, writes } = mount([firstExtrude]);
    inspector.lockReason = () => LOCKED;
    inspector.select("f2");

    expect(texts(root)[0], "the reason is not the first thing the panel says").toBe(LOCKED);
    const all = rows(root);
    expect(all.map((r) => r.label)).toContain("Start offset mm");
    expect(all.filter((r) => !r.input.disabled).map((r) => r.label), "rows still editable during a tool").toEqual([]);
    expect(writes).toEqual([]);
  });

  it("refuses a write from a panel drawn BEFORE the tool started, and says why", () => {
    // The exact sequence of the report: the face click draws f2's rows
    // editable, then Extrude starts. Whatever re-renders the panel, the write
    // itself has to ask, or one missed refresh is the bug again.
    const { root, inspector, writes } = mount([firstExtrude]);
    inspector.select("f2");
    let lock: string | null = null;
    inspector.lockReason = () => lock;
    lock = LOCKED; // the tool starts; nothing has re-rendered yet

    const start = rows(root).find((r) => r.label === "Start offset mm")!.input;
    expect(start.disabled, "fixture: this panel was drawn before the lock").toBe(false);
    start.value = "10";
    start.dispatch("change");
    const width = rows(root).find((r) => r.label === "width")!.input;
    width.value = "55";
    width.dispatch("change");

    expect(writes, "the old extrude (or a parameter) was rewritten mid-tool").toEqual([]);
    for (const input of [start, width]) {
      expect(input.classList.contains("input-error"), "refused without a sign").toBe(true);
      expect(input.title).toBe(LOCKED);
    }
  });

  it("is editable again once the tool ends", () => {
    const { root, inspector, writes } = mount([firstExtrude]);
    let lock: string | null = LOCKED;
    inspector.lockReason = () => lock;
    inspector.select("f2");
    lock = null;
    inspector.refresh();

    expect(texts(root)).not.toContain(LOCKED);
    const start = rows(root).find((r) => r.label === "Start offset mm")!.input;
    expect(start.disabled).toBe(false);
    start.value = "4";
    start.dispatch("change");
    expect(writes).toEqual(["field startOffset=4"]);
  });

  it("will not clear an up-to target mid-tool either", () => {
    vi.useFakeTimers();
    try {
      const { root, inspector, store } = mountReal(savedExtrude);
      inspector.select("e1"); // drawn unlocked: the button is live
      inspector.lockReason = () => LOCKED;
      buttons(root)[0]!.dispatch("click");

      const f = store.document.features[0] as unknown as Record<string, unknown>;
      expect(f.upToPlane, "the target was cleared while a tool was open").toBe("d1");
      expect(texts(root)[0], "the refused click did not say why").toBe(LOCKED);
      expect(buttons(root)[0]!.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- ...and main.ts actually turns it on ------------------------------------
//
// Every test above sets lockReason by hand, so all of them stay green if the
// app never sets it. A review deleted main.ts's one assignment and 300 tests
// passed while the extrude edit was writable again: type a Start offset into
// the open edit, commit, and the value is silently put back. So the wiring is
// read off main.ts as text, the way ambientSelection.test.ts pins its handlers.

/** A top-level function in main.ts, from its signature to the `}` at column 0. */
function mainFunction(name: string): string {
  const at = mainSrc.indexOf(`\nfunction ${name}(`);
  expect(at, `main.ts has no top-level function ${name}(): renamed, and this can no longer check it`).toBeGreaterThan(-1);
  return mainSrc.slice(at, mainSrc.indexOf("\n}\n", at) + 2);
}

/** Tools main.ts constructs that may run with the panel writable, and why. */
const UNLOCKED_BY_DESIGN: Record<string, string> = {
  MeasureTool: "reads distances and writes nothing to the document",
  SectionTool: "a view clip; it writes nothing to the document",
};

describe("main.ts locks the inspector while a modeling tool runs", () => {
  it("points lockReason at featureToolActive, once, and below planePick", () => {
    const assigns = [...mainSrc.matchAll(/^inspector\.lockReason = (.*)$/gm)];
    expect(assigns.length, "lockReason is not assigned exactly once: the panel is never read-only").toBe(1);
    const [assign] = assigns;
    expect(assign![1]).toContain("featureToolActive()");
    expect(assign![1]).toContain('t("inspector.lockedDuringTool")');
    // featureToolActive() reads planePick: a render reaching it any earlier
    // throws in planePick's temporal dead zone at startup.
    expect(assign!.index!).toBeGreaterThan(mainSrc.indexOf("\nlet planePick"));
  });

  it("asks the same question toolBusy does", () => {
    // one list, so "a tool is running" cannot mean two things
    expect(mainFunction("toolBusy")).toContain("featureToolActive()");
  });

  it("counts every tool main.ts constructs, apart from the named read-only ones", () => {
    // Enumerated off the constructors, so a tool added later is held to this
    // the day it lands instead of quietly leaving the panel writable.
    const active = mainFunction("featureToolActive");
    const tools = [...mainSrc.matchAll(/^const (\w+) = new (\w+Tool)\(/gm)].map((m) => ({ name: m[1]!, cls: m[2]! }));
    expect(tools.length, "found no tool constructors: the pattern is stale").toBeGreaterThanOrEqual(10);
    const missing = tools.filter((x) => !(x.cls in UNLOCKED_BY_DESIGN) && !active.includes(`${x.name}.active`));
    expect(missing.map((x) => x.cls), "these tools leave the inspector writable while they run").toEqual([]);
    const stale = Object.keys(UNLOCKED_BY_DESIGN).filter((cls) => !tools.some((x) => x.cls === cls));
    expect(stale, "UNLOCKED_BY_DESIGN names tools main.ts no longer builds").toEqual([]);
    // a pick (Shell, Draft, sketch plane) is a tool too
    expect(active).toContain("planePick");
  });

  it("redraws the panel read-only once an edit has opened its tool", () => {
    // editFeature puts the feature in the panel BEFORE the tool opens, so
    // without this redraw its rows stay editable for the whole edit.
    const edit = mainFunction("editFeature");
    const lastOpen = edit.lastIndexOf(".startEdit(");
    expect(lastOpen, "editFeature opens no tool: the slice is stale").toBeGreaterThan(-1);
    expect(edit.indexOf("if (featureToolActive()) inspector.refresh();", lastOpen)).toBeGreaterThan(lastOpen);
  });

  it("takes the last feature out of the panel when Offset Face or Thicken starts", () => {
    // the create path main.ts wires itself; featureStarters.test.ts holds the rest
    const body = mainFunction("startFaceOffset");
    const start = body.indexOf("faceOffset.start(");
    expect(start).toBeGreaterThan(-1);
    expect(body.indexOf("selectFeature(null)", start), "the selection is not cleared after the tool starts").toBeGreaterThan(start);
  });
});

// Field report 4875dacc: a refused Press/Pull's toast "disappears far too
// quickly, I don't get time to read and understand it or copy it. There is a
// 'SHOW' button ... but the 'SHOW' does not seem to do anything." Show selects
// the failing feature, and the Inspector had nothing to say about a failure:
// its only other home was the red chip's native tooltip. Driven through the
// real DocumentStore, so the failure arrives the way a build delivers it.
describe("inspector: why the selected feature failed", () => {
  const REASON =
    "This face meets its neighbour at the shallow angle of a tessellation facet, so I cannot tell it from one piece of a curved surface I did not recognise, and moving it on its own would dent the body rather than resize the curve.";
  const pressPull = { id: "p1", type: "press-pull", face: {}, distance: 3, operation: "join" } as unknown as Feature;

  /** A store whose builds fail p1 until `fixed` is set. */
  function mountFailing() {
    const state = { fixed: false };
    const backend = {
      async rebuild(): Promise<RebuildReply> {
        return {
          ok: true,
          result: {
            mesh: { positions: [], indices: [], faceIds: [] },
            edges: [],
            bbox: { min: [0, 0, 0], max: [1, 1, 1] },
            bodies: [],
            featureErrors: state.fixed ? [] : [{ feature_id: "p1", message: REASON }],
          },
        } as unknown as RebuildReply;
      },
      async init() {},
      onStatus: () => () => {},
      connected: true,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(backend, { parameters: {}, features: [pressPull] } as unknown as CadDocument);
    const root = new FakeEl("div");
    const inspector = new Inspector(root as unknown as HTMLElement, store);
    return { root, inspector, store, state };
  }
  const failure = (root: FakeEl) => {
    let hit: FakeEl | undefined;
    const walk = (el: FakeEl) => {
      if (el.className === "inspector-failure") hit ??= el;
      el.children.forEach(walk);
    };
    walk(root);
    return hit;
  };
  const shown = (el: FakeEl | undefined) => (el && !el.classList.contains("hidden") ? el.textContent : null);

  it("Show (selecting the feature) puts the whole message in the panel", async () => {
    const { root, inspector, store } = mountFailing();
    await store.rebuildNow();
    inspector.select("p1"); // what the toast's Show reaches, through selectFeature
    expect(shown(failure(root))).toBe(`⚠ Press/Pull failed: ${REASON}`);
  });

  it("follows the build: it goes when the feature builds, comes back when it fails", async () => {
    const { root, inspector, store, state } = mountFailing();
    await store.rebuildNow();
    inspector.select("p1");
    const field = rows(root).find((r) => r.label === "Distance mm")!.input;
    state.fixed = true;
    await store.rebuildNow();
    expect(shown(failure(root)), "a fixed feature still reads as failed").toBeNull();
    state.fixed = false;
    await store.rebuildNow();
    expect(shown(failure(root))).toContain(REASON);
    // and a build never rebuilt the rows under the caret
    expect(rows(root).find((r) => r.label === "Distance mm")!.input).toBe(field);
  });

  it("a feature that built says nothing", async () => {
    const { root, inspector, store, state } = mountFailing();
    state.fixed = true;
    await store.rebuildNow();
    inspector.select("p1");
    expect(shown(failure(root))).toBeNull();
  });
});
