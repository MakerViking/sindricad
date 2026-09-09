// "12,5" typed into a real field of the app, and what the model gets.
//
// Half of Europe writes one and a half as "1,5". Every numeric field in this app
// used to reach the model through `parseFloat`, which reads that as 1 — no
// error, no red chip, a wall a tenth of the thickness that was typed. The panels
// were worse: `parseFloat("0,4") || 0.4` fell through to the DEFAULT, so a typed
// value simply vanished.
//
// These drive the REAL components through the element stub and assert the VALUE
// that came out the other side — the number the geometry would have been built
// from — not that a parser was called.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";
import { setUnit } from "./units";
import type { DocumentStore } from "../document/store";

/** The stub input, plus the two bits the numeric field needs: a `checked` flag
 *  (the panels build checkboxes from the same element) and dispatchEvent, which
 *  is how a stepped value tells its panel to re-preview. */
class FakeInput extends FakeEl {
  checked = false;
  min = "";
  inputMode = "";
  autocomplete = "";
  placeholder = "";
  rows = 0;
  dispatchEvent(e: { type: string }) {
    this.dispatch(e.type, e);
    return true;
  }
  // The stub parses no markup, but every icon button in these panels writes
  // `<svg…><span></span>` and then querySelectors that span to put its label in.
  // Materialise the placeholder so the panels can be built at all.
  override get innerHTML(): string {
    return "";
  }
  override set innerHTML(v: string) {
    this.children.length = 0;
    for (const _ of v.matchAll(/<span\b/g)) this.children.push(new FakeInput("span"));
  }
}

installFakeDocument();
const doc = globalThis.document as unknown as {
  createElement(tag: string): FakeEl;
  body: FakeEl;
  addEventListener?: unknown;
  removeEventListener?: unknown;
};
doc.createElement = (tag: string) => new FakeInput(tag);
doc.addEventListener = () => {};
doc.removeEventListener = () => {};
(globalThis as unknown as { window: unknown }).window = { innerWidth: 1200, innerHeight: 800 };
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
(globalThis as unknown as { Option: unknown }).Option = class extends FakeInput {
  constructor(text = "", value = "") {
    super("option");
    this.textContent = text;
    this.value = value;
  }
};

const { DimInput } = await import("../sketch/dimInput");
const { Inspector } = await import("./inspector");
const { TextPanel } = await import("../sketch/textPanel");
const { TexturePanel } = await import("../features/texturePanel");

const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, stopPropagation() {} });

/** Every <input> in the tree, in document order. */
function inputs(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "input") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

beforeEach(() => setUnit("mm"));
afterEach(() => setUnit("mm"));

describe("the on-canvas dimension box (extrude, fillet, chamfer, move, offset…)", () => {
  function open() {
    const box = new DimInput();
    const committed: Record<string, number>[] = [];
    box.show([{ name: "distance", label: "Distance" }], (v) => committed.push(v));
    const field = inputs(doc.body).at(-1)!;
    return { box, field, committed };
  }

  it("commits a comma-typed depth as the number that was typed", () => {
    const { field, committed } = open();
    field.value = "12,5";
    field.dispatch("keydown", key("Enter"));
    expect(committed[0]).toEqual({ distance: 12.5 });
  });

  it("still converts from the display unit", () => {
    setUnit("cm");
    const { field, committed } = open();
    field.value = "1,5";
    field.dispatch("keydown", key("Enter"));
    expect(committed[0], "1.5 cm is 15 mm").toEqual({ distance: 15 });
  });

  it("reads back a four-digit value it printed itself", () => {
    // The round-trip that decides the grouping rule: if the box printed "1,500"
    // the way en-US writes fifteen hundred, this read it back as 1.5 mm and the
    // feature silently collapsed. Nothing editable is ever grouped (ui/units).
    const { box, field } = open();
    box.seed("distance", 1500);
    expect(field.value).toBe("1500");
    expect(box.getValue("distance")).toBe(1500);
  });

  it("drops a field that is not a number rather than committing its first digits", () => {
    const { field, committed } = open();
    field.value = "12 mm-ish";
    field.dispatch("keydown", key("Enter"));
    expect(committed[0], "no silent truncation to 12").toEqual({});
  });
});

describe("the inspector", () => {
  function mount(features: unknown[] = [], parameters: Record<string, number> = { width: 40 }) {
    const writes: string[] = [];
    const store = {
      document: { features, parameters, paramDefs: {} },
      paramIssues: {},
      onDocChange: () => () => {},
      boundExpr: () => null,
      isParamBound: () => false,
      setParam: (name: string, v: number) => writes.push(`param ${name}=${v}`),
      setTargetValue: (t: { field: string }, v: number) => writes.push(`value ${t.field}=${v}`),
      setTargetExpr: (t: { field: string }, expr: string) => {
        writes.push(`expr ${t.field}=${expr}`);
        return null;
      },
    };
    const root = new FakeEl("div");
    const inspector = new Inspector(root as unknown as HTMLElement, store as unknown as DocumentStore);
    return { root, inspector, writes };
  }

  it("writes a comma-typed parameter as the number that was typed", () => {
    const { root, inspector, writes } = mount();
    inspector.select(null); // nothing selected: the panel is just the parameter table
    const field = inputs(root)[0]!;
    field.value = "1,5";
    field.dispatch("change");
    expect(writes).toEqual(["param width=1.5"]);
  });

  it("writes a comma-typed feature field as the number that was typed", () => {
    const cylinder = { id: "f1", type: "cylinder", radius: 5, height: 12 };
    const { root, inspector, writes } = mount([cylinder]);
    inspector.select("f1");
    const radius = inputs(root).find((i) => i.value === "5")!;
    radius.value = "0,5";
    radius.dispatch("change");
    expect(writes).toEqual(["value radius=0.5"]);
  });

  it("stores an EXPRESSION dot-decimal, whatever separator was typed", () => {
    // The params grammar is dot-only on purpose (params/parse.ts) so a saved
    // document means the same thing on every machine. The comma is normalised at
    // the input, not in the grammar.
    const cylinder = { id: "f1", type: "cylinder", radius: 5, height: 12 };
    const { root, inspector, writes } = mount([cylinder]);
    inspector.select("f1");
    const radius = inputs(root).find((i) => i.value === "5")!;
    radius.value = "width*1,5";
    radius.dispatch("change");
    expect(writes).toEqual(["expr radius=width*1.5"]);
  });
});

describe("the tool panels that used to swallow a comma into their default", () => {
  it("sketch Text takes a comma-typed size", () => {
    const panel = new TextPanel();
    const seen: { height: number; angle: number }[] = [];
    panel.show({ x: 0, y: 0 }, [], { height: 10 }, {
      onCommit: () => {},
      onCancel: () => {},
      onChange: (v) => seen.push(v),
    });
    const size = inputs(doc.body).find((i) => i.value === "10")!;
    size.value = "12,5";
    size.dispatch("input");
    expect(seen.at(-1)?.height, "not the 10 mm default").toBe(12.5);
  });

  it("Texture takes a comma-typed depth", () => {
    const panel = new TexturePanel();
    const seen: { depth: number }[] = [];
    panel.show(
      { editing: false, mode: "faces", summary: "", initial: { depth: 0.4 } },
      { onCommit: () => {}, onCancel: () => {}, onChange: (v) => seen.push(v), onModeChange: () => {} },
    );
    const depth = inputs(doc.body).find((i) => i.value === "0.4")!;
    depth.value = "0,25";
    depth.dispatch("input");
    expect(seen.at(-1)?.depth, "not the 0.4 default").toBe(0.25);
  });

  it("steps with Arrow Up now that the spinner is gone", () => {
    // type="number" had to go — it reports "" for anything it cannot parse as a
    // dot-decimal literal, so a comma never reached the app at all. Its keyboard
    // stepping is kept, and it steps the value the user can see.
    const panel = new TexturePanel();
    const seen: { depth: number }[] = [];
    panel.show(
      { editing: false, mode: "faces", summary: "", initial: { depth: 0.4 } },
      { onCommit: () => {}, onCancel: () => {}, onChange: (v) => seen.push(v), onModeChange: () => {} },
    );
    const depth = inputs(doc.body).find((i) => i.value === "0.4")!;
    depth.dispatch("keydown", key("ArrowUp"));
    expect(depth.value).toBe("0.41"); // step="0.01"
    expect(seen.at(-1)?.depth).toBe(0.41);
  });
});
