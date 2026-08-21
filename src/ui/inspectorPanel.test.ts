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
import { describe, it, expect, beforeEach } from "vitest";
import { FakeEl, fakeFocus, installFakeDocument } from "./fakeDom.testkit";
import { Inspector } from "./inspector";
import type { DocumentStore } from "../document/store";
import type { CadDocument, Feature } from "../types";

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
