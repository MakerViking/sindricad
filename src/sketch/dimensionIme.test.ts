// Typing Japanese into a dimension.
//
// A CJK user types through an IME: every keystroke belongs to the input method
// until the conversion is confirmed, and the two keys this app leans on hardest
// mean something else entirely while that is going on —
//
//   Enter   CONFIRMS the highlighted candidate
//   Escape  CANCELS the conversion, back to the raw reading
//
// Before this, an inline dimension edit committed on the first Enter of a
// conversion (parsing a half-typed reading as a number, so the dimension either
// took a wrong value or snapped back) and reverted on the Escape that was meant
// to undo the IME's own guess. The heads-up DimInput committed the whole tool
// on that same Enter.
//
// These drive the REAL handlers against the fakeDom stub and assert the EFFECT:
// nothing was committed, nothing was reverted, and the text the user has typed
// so far is still in the field.
//
// Numeric fields are NOT exempt: both boxes are `type="text"` with
// `inputMode="decimal"` precisely so "1,5" survives, and a Japanese IME will
// happily compose fullwidth digits (１２３) into them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, byClass, installFakeDocument } from "../ui/fakeDom.testkit";

/** fakeDom + the calls these three components make that the shared stub does
 *  not have: remove() (so "is the panel still on screen" is answerable), and a
 *  querySelector that survives a CLASS selector (checkPanel builds its rows as
 *  markup, which the stub does not parse). */
class El extends FakeEl {
  parent: El | null = null;
  tabIndex = 0;
  #text = "";
  constructor(tag: string) {
    super(tag);
    // Setting textContent REPLACES the children, the way a real node does. Not
    // pedantry: reverting an inline dimension edit is exactly
    // `label.el.textContent = "12 mm"`, so a stub that keeps the children makes
    // "is the editor still open" answer yes forever — the assertion would pass
    // whether the bug is fixed or not.
    Object.defineProperty(this, "textContent", {
      get: () => this.#text,
      set: (v: string) => {
        this.#text = v;
        this.children.length = 0;
      },
      configurable: true,
    });
  }
  override appendChild(c: FakeEl): FakeEl {
    (c as El).parent = this;
    return super.appendChild(c);
  }
  override append(...cs: FakeEl[]) {
    for (const c of cs) (c as El).parent = this;
    super.append(...cs);
  }
  remove() {
    const kids = this.parent?.children;
    if (kids) {
      const i = kids.indexOf(this);
      if (i >= 0) kids.splice(i, 1);
    }
    this.parent = null;
  }
  override querySelector(sel: string): FakeEl | null {
    const hit = super.querySelector(sel);
    if (hit) return hit;
    // a class selector against unparsed markup: hand back a throwaway element
    // so the component can wire its click handlers and get to the part under test
    return sel.startsWith(".") ? new El("div") : null;
  }
  querySelectorAll(_sel: string): El[] {
    return [];
  }
}

installFakeDocument();
const doc = globalThis.document as unknown as { createElement(t: string): El; body: El };
doc.createElement = (tag: string) => new El(tag);
const body = new El("body");
doc.body = body;

type Handler = (e: unknown) => void;
const winKeys: Handler[] = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, fn: Handler) => {
    if (type === "keydown") winKeys.push(fn);
  },
  removeEventListener: (type: string, fn: Handler) => {
    const i = winKeys.indexOf(fn);
    if (type === "keydown" && i >= 0) winKeys.splice(i, 1);
  },
};

vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

const { SketchDimensions } = await import("./sketchDimensions");
const { DimInput } = await import("./dimInput");
const { showCheckPanel, isCheckPanelOpen } = await import("./checkPanel");
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";

const viewport = {
  camera: new THREE.PerspectiveCamera(),
  projectToScreen: () => ({ x: 0, y: 0 }),
  projectToOverlay: () => ({ x: 0, y: 0, width: 900, height: 700 }),
} as unknown as Viewport;

const plane = {
  to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0),
} as unknown as SketchPlane;

/** A keydown as the engines we ship on report it: `isComposing` is the spec
 *  signal, keyCode 229 is what some engines report instead. */
function key(k: string, composing: "no" | "isComposing" | "keyCode229" = "no") {
  return {
    // The 229 case keeps the real key name on purpose. Engines differ on
    // whether they also mask `key` as "Process", and a fixture that masks it
    // proves nothing here: `e.key === "Escape"` is false either way, so the
    // test would pass with or without the guard.
    key: k,
    isComposing: composing === "isComposing",
    keyCode: composing === "keyCode229" ? 229 : 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
    target: null,
  };
}

describe("inline dimension edit while an IME is composing", () => {
  /** Open the value editor on a 10 mm dimension the way a click does, and hand
   *  back the input plus whatever the sketch was told to commit. */
  function edit() {
    body.children.length = 0;
    const dims = new SketchDimensions(viewport, () => {});
    const committed: number[] = [];
    dims.show([], plane, [
      { anchor: new THREE.Vector2(0, 0), valueMm: 10, commit: (v: number) => committed.push(v) },
    ]);
    const badge = byClass(body, "sketch-dim")[0] as El;
    badge.dispatch("click", { stopPropagation() {} });
    const input = badge.querySelector("input") as El;
    return { badge, input, committed };
  }

  it("does not commit on the Enter that confirms a conversion", () => {
    const e = edit();
    e.input.value = "１２"; // fullwidth digits, still mid-conversion
    e.input.dispatch("keydown", key("Enter", "isComposing"));
    expect(e.committed).toEqual([]);
    // and the editor is still open with the reading intact, so the next Enter can commit
    expect(e.badge.querySelector("input")).toBe(e.input);
    expect(e.input.value).toBe("１２");
  });

  it("does not commit on an engine that only reports keyCode 229", () => {
    const e = edit();
    e.input.value = "１２";
    e.input.dispatch("keydown", key("Enter", "keyCode229"));
    expect(e.committed).toEqual([]);
    expect(e.badge.querySelector("input")).toBe(e.input);
  });

  it("does not revert on the Escape that cancels a conversion", () => {
    const e = edit();
    e.input.value = "２５";
    e.input.dispatch("keydown", key("Escape", "isComposing"));
    // revert() replaces the label's contents with the formatted value, tearing
    // the editor out from under the person typing
    expect(e.badge.querySelector("input")).toBe(e.input);
    expect(e.committed).toEqual([]);
  });

  it("still commits on a real Enter", () => {
    const e = edit();
    e.input.value = "25";
    e.input.dispatch("keydown", key("Enter"));
    expect(e.committed).toEqual([25]);
  });

  it("still reverts on a real Escape", () => {
    const e = edit();
    e.input.value = "25";
    e.input.dispatch("keydown", key("Escape"));
    expect(e.badge.querySelector("input")).toBeNull();
    expect(e.committed).toEqual([]);
  });

  it("does not delete the dimension on the Backspace that erases a kana", () => {
    body.children.length = 0;
    const dims = new SketchDimensions(viewport, () => {});
    let deleted = 0;
    dims.show([], plane, [
      {
        anchor: new THREE.Vector2(0, 0),
        valueMm: 10,
        commit: () => {},
        onDelete: () => deleted++,
      },
    ]);
    const badge = byClass(body, "sketch-dim")[0] as El;
    badge.dispatch("click", { stopPropagation() {} });
    const input = badge.querySelector("input") as El;
    input.dispatch("keydown", key("Backspace", "isComposing"));
    expect(deleted).toBe(0);
  });
});

describe("heads-up dimension box while an IME is composing", () => {
  function box() {
    const committed: Record<string, number>[] = [];
    const dim = new DimInput();
    dim.show([{ name: "d", label: "Depth" }], (v) => committed.push(v));
    const field = (dim as unknown as { fields: { input: El }[] }).fields[0]!.input;
    return { dim, field, committed };
  }

  it("does not commit on the Enter that confirms a conversion", () => {
    const b = box();
    b.field.value = "１０";
    b.field.dispatch("keydown", key("Enter", "isComposing"));
    expect(b.committed).toEqual([]);
    expect(b.dim.isActive).toBe(true);
  });

  it("does not commit on an engine that only reports keyCode 229", () => {
    const b = box();
    b.field.value = "１０";
    b.field.dispatch("keydown", key("Enter", "keyCode229"));
    expect(b.committed).toEqual([]);
  });

  it("still commits on a real Enter", () => {
    const b = box();
    b.field.value = "10";
    b.field.dispatch("keydown", key("Enter"));
    expect(b.committed).toEqual([{ d: 10 }]);
  });
});

describe("sketch check panel while an IME is composing", () => {
  beforeEach(() => {
    winKeys.length = 0;
    body.children.length = 0;
  });

  function open() {
    let closed = 0;
    showCheckPanel([], { onSelect: () => {}, onClose: () => closed++ });
    const press = (e: unknown) => {
      for (const fn of [...winKeys]) fn(e);
    };
    return { press, closed: () => closed };
  }

  it("stays open when Escape cancels a conversion", () => {
    const p = open();
    p.press(key("Escape", "isComposing"));
    expect(isCheckPanelOpen()).toBe(true);
    expect(p.closed()).toBe(0);
  });

  it("stays open for an engine that only reports keyCode 229", () => {
    const p = open();
    p.press(key("Escape", "keyCode229"));
    expect(isCheckPanelOpen()).toBe(true);
  });

  it("closes on a real Escape", () => {
    const p = open();
    p.press(key("Escape"));
    expect(isCheckPanelOpen()).toBe(false);
    expect(p.closed()).toBe(1);
  });
});

// A tool letter hotkey (Extrude's T, Section's F, ...) is arbitrated by
// DimInput.claimToolHotkey on behalf of four tools that own the keydown
// handler themselves. While the box holds text the user has not touched the
// letter belongs to the TOOL — but not while an IME is converting: there the
// letter is part of the reading being typed, and claiming it both fires the
// tool and swallows the keystroke the input method was waiting for.
class FakeField {
  constructor(private touched: boolean) {}
  getAttribute(name: string): string | null {
    return name === "data-undo-passthrough" ? (this.touched ? "0" : "1") : null;
  }
}
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement ??= FakeField;

describe("tool letter hotkey while an IME is composing", () => {
  /** claimToolHotkey with a box that is open and focused; only "is this my own
   *  box" is faked, the arbitration is the real one. */
  function claim(e: unknown): { claimed: boolean; prevented: number } {
    let prevented = 0;
    const owner = { active: true, ownsTarget: () => true };
    const ev = { ...(e as object), target: new FakeField(false), preventDefault: () => prevented++ };
    const claimed = DimInput.prototype.claimToolHotkey.call(owner as never, ev as never);
    return { claimed, prevented };
  }

  it("leaves the letter to the input method mid-conversion", () => {
    const r = claim(key("t", "isComposing"));
    expect(r.claimed).toBe(false);
    expect(r.prevented).toBe(0);
  });

  it("leaves it alone on an engine that only reports keyCode 229", () => {
    const r = claim(key("t", "keyCode229"));
    expect(r.claimed).toBe(false);
  });

  it("still gives an ordinary letter to the tool", () => {
    const r = claim(key("t"));
    expect(r.claimed).toBe(true);
    expect(r.prevented).toBe(1);
  });
});
