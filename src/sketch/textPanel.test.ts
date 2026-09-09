// The sketch Text panel, driven for real: the two ways it used to lose what the
// user typed.
//
// 1. A size the app cannot read became the 10mm default. `parseNumber` refuses
//    "3.14.15" on purpose (ui/units) and the panel wrote `|| 10` over the
//    refusal, so a typo modelled text at a size nobody asked for. The `||` also
//    swallowed a typed 0.
// 2. Escape cancelled the panel with no IME check. Escape is the key a Japanese
//    IME uses to CANCEL A CONVERSION, so pressing it mid-word closed the panel
//    and threw the sentence away — in the one field where Japanese is most
//    likely to be typed.
//
// The panel only calls createElement/appendChild/addEventListener and friends,
// so the fakeDom stub plus a document that takes listeners, a window, `new
// Option` and enough innerHTML for a button caption is enough to press the keys
// a user presses.
import { describe, expect, it } from "vitest";

import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { t } from "../i18n";
import { TextPanel, type TextValues } from "./textPanel";

function makeEl(tag: string): FakeEl {
  const el = new FakeEl(tag);
  Object.defineProperty(el, "innerHTML", {
    get: () => "",
    set(html: string) {
      el.children.length = 0;
      if (html.includes("<span>")) el.children.push(new FakeEl("span"));
    },
  });
  return Object.assign(el, { remove() {} });
}

/** The document-level keydown listeners the panel installs, so a test can press
 *  Escape the way the user does rather than calling the handler by name. */
const docKeys = new Set<(e: unknown) => void>();

function installPanelDom(): FakeEl {
  const prompt = makeEl("div");
  installFakeDocument({ prompt });
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.createElement = makeEl;
  docKeys.clear();
  doc.addEventListener = (type: string, fn: (e: unknown) => void) => {
    if (type === "keydown") docKeys.add(fn);
  };
  doc.removeEventListener = (_type: string, fn: (e: unknown) => void) => docKeys.delete(fn);
  (globalThis as Record<string, unknown>).window = { innerWidth: 1280, innerHeight: 900 };
  (globalThis as Record<string, unknown>).Option = class extends FakeEl {
    constructor(text: string, value = "") {
      super("option");
      this.textContent = text;
      this.value = value;
    }
  };
  return prompt;
}

/** The input after the label reading `caption`. */
function field(root: FakeEl, caption: string): FakeEl {
  const walk = (el: FakeEl): FakeEl | null => {
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (k.tagName === "label" && k.textContent === caption) {
        const input = kids.slice(i + 1).find((c) => c.tagName === "input");
        if (input) return input;
      }
      const hit = walk(k);
      if (hit) return hit;
    }
    return null;
  };
  const hit = walk(root);
  if (!hit) throw new Error(`no field labelled ${caption}`);
  return hit;
}

function buttons(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "button") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

function type(el: FakeEl, text: string) {
  el.value = text;
  el.dispatch("input");
}

/** A keystroke as the DOM delivers it. `composing` is the state a Japanese,
 *  Chinese or Korean user is in for most of the keys they press. */
function key(k: string, opts: { composing?: boolean; ctrl?: boolean } = {}) {
  return {
    key: k,
    ctrlKey: !!opts.ctrl,
    metaKey: false,
    ...(opts.composing ? { isComposing: true, keyCode: 229 } : { isComposing: false, keyCode: 0 }),
    preventDefault() {},
    stopPropagation() {},
  };
}

function open(initial: Partial<TextValues> = {}) {
  const prompt = installPanelDom();
  const panel = new TextPanel();
  let committed: TextValues | null = null;
  let cancelled = false;
  panel.show({ x: 100, y: 100 }, ["DejaVu Sans"], initial, {
    onCommit: (v) => { committed = v; },
    onCancel: () => { cancelled = true; },
    onChange: () => {},
  });
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  const root = body.children.at(-1)!;
  const ta = root.children.find((c) => c.tagName === "textarea")!;
  const btns = buttons(root);
  return {
    panel,
    ta,
    size: field(root, t("common.size")),
    angle: field(root, t("sketch.text.angleDeg")),
    add: () => btns[0]!.dispatch("pointerdown", { preventDefault() {}, stopPropagation() {} }),
    pressEscape: (composing: boolean) => { for (const fn of [...docKeys]) fn(key("Escape", { composing })); },
    ctrlEnter: (composing: boolean) => ta.dispatch("keydown", key("Enter", { ctrl: true, composing })),
    committed: () => committed as TextValues | null,
    cancelled: () => cancelled,
    promptText: () => prompt.textContent,
  };
}

describe("TextPanel — a size the app cannot read never becomes the default", () => {
  it("refuses to commit a size typed as '3.14.15' instead of modelling 10mm", () => {
    const p = open();
    type(p.ta, "hello");
    type(p.size, "3.14.15");
    p.add();
    expect(p.committed()).toBeNull();
    expect(p.promptText()).toBe(t("feature.badNumber"));
    // and the panel is still up with the text in it, so the typo can be fixed
    expect(p.panel.isActive).toBe(true);
    expect(p.ta.value).toBe("hello");
  });

  it("refuses an unreadable angle too", () => {
    const p = open();
    type(p.ta, "hello");
    type(p.angle, "1.2.3");
    p.add();
    expect(p.committed()).toBeNull();
  });

  it("commits once the size is fixed, comma decimal and all", () => {
    const p = open();
    type(p.ta, "hello");
    type(p.size, "3.14.15");
    p.add();
    expect(p.committed()).toBeNull();
    type(p.size, "12,5");
    p.add();
    expect(p.committed()?.height).toBe(12.5);
  });

  it("REFUSES a size of 0 rather than committing it", () => {
    // This test used to assert `height === 0`, locking in a value that kills
    // the geometry engine: a font size of 0 or less segfaults OCCT (exit 139,
    // uncatchable), and the live preview calls into it on every render, so "0"
    // typed as the first character of "0.5" was enough to take the sidecar
    // down. The sidecar refuses it now as well — that is the guard that covers
    // a saved document — and this is the half that can tell the user why.
    const p = open();
    type(p.ta, "hello");
    type(p.size, "0");
    p.add();
    expect(p.committed()).toBeNull();
    expect(p.panel.isActive).toBe(true); // still open, so the number can be fixed
    type(p.size, "-5");
    p.add();
    expect(p.committed()).toBeNull();
    // ...and a real size still commits, including a comma decimal.
    type(p.size, "0,5");
    p.add();
    expect(p.committed()?.height).toBe(0.5);
  });

  it("still allows a typed 0 where 0 is a legal value", () => {
    // Only the SIZE is required to be positive. An angle of 0 is ordinary, and
    // the old `|| default` swallowed it — which is the bug that started this.
    const p = open();
    type(p.ta, "hello");
    type(p.angle, "0");
    p.add();
    expect(p.committed()?.angle).toBe(0);
  });

  it("still defaults a field the user cleared, and leaves untouched ones alone", () => {
    const p = open();
    type(p.ta, "hello");
    type(p.size, "");
    p.add();
    expect(p.committed()?.height).toBe(10);
    expect(p.committed()?.angle).toBe(0);
  });
});

describe("TextPanel — Escape belongs to the IME while a conversion is open", () => {
  it("keeps the panel and the typed text when Escape cancels a conversion", () => {
    const p = open();
    type(p.ta, "にほんご");
    p.pressEscape(true);
    expect(p.panel.isActive).toBe(true);
    expect(p.cancelled()).toBe(false);
    expect(p.ta.value).toBe("にほんご");
  });

  it("still closes on a plain Escape", () => {
    const p = open();
    type(p.ta, "hello");
    p.pressEscape(false);
    expect(p.panel.isActive).toBe(false);
    expect(p.cancelled()).toBe(true);
  });

  it("does not commit on Ctrl+Enter mid-composition", () => {
    const p = open();
    type(p.ta, "にほんご");
    p.ctrlEnter(true);
    expect(p.committed()).toBeNull();
    expect(p.panel.isActive).toBe(true);
    p.ctrlEnter(false);
    expect(p.committed()?.text).toBe("にほんご");
  });
});
