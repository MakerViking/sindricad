// The one piece of the Text-on-Face panel with logic rather than layout.
//
// SCOPE, stated rather than implied: there is no jsdom here, so the parts of the
// panel that are pure layout — hiding the depth and bevel fields for a flat
// text, repainting the colour chips — are still only reachable by hand in the
// app. What IS covered is the rule that decides which filament a flat text
// starts on (get it wrong and the letters are invisible, which is exactly the
// failure the auto-pick exists to prevent), and, in the second half of this
// file, what the panel hands the model when a field holds text it cannot read.
import { describe, expect, it } from "vitest";

import { autoGlyphSlot } from "./textOnFacePanel";

describe("autoGlyphSlot — a flat text must never start invisible", () => {
  it("avoids the body's own filament, so the glyphs read against it", () => {
    expect(autoGlyphSlot(4, 0)).toBe(1);
    expect(autoGlyphSlot(4, 1)).toBe(0);
    expect(autoGlyphSlot(4, 3)).toBe(0);
  });

  it("takes the first slot when the body has no colour of its own", () => {
    expect(autoGlyphSlot(4, null)).toBe(0);
  });

  it("still returns a slot when the body holds the only colour there is", () => {
    // A single-filament palette: there is no contrasting choice, so the text
    // takes slot 0 and prints in the body's colour. Invisible, but the user can
    // see the chip is lit and change it — which beats a null that silently means
    // "inherit" and gives them nothing to notice.
    expect(autoGlyphSlot(1, 0)).toBe(0);
  });

  it("returns null rather than an index into an empty palette", () => {
    expect(autoGlyphSlot(0, null)).toBeNull();
    expect(autoGlyphSlot(0, 2)).toBeNull();
  });
});

// --- the panel itself, driven for real --------------------------------------
//
// The scope note above is out of date for the numeric fields: no jsdom is
// needed to press the Add button. The panel only calls createElement /
// appendChild / addEventListener and friends, so the fakeDom stub plus a
// document that takes listeners, a window, and enough innerHTML to hold a
// button's caption span is enough to drive it.
//
// What this locks: a size the app cannot read must not commit as the default.
// `parseNumber` refuses "3.14.15" on purpose (ui/units) and the panel wrote
// `|| 0` over that refusal, so a typo modelled text at a size nobody asked for.

import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { t } from "../i18n";
import { TextOnFacePanel, type TextOnFaceValues } from "./textOnFacePanel";

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

function installPanelDom(): FakeEl {
  const prompt = makeEl("div");
  installFakeDocument({ prompt });
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.createElement = makeEl;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  (globalThis as Record<string, unknown>).window = { innerWidth: 1280, innerHeight: 900 };
  return prompt;
}

/** The input after the label carrying `key`. */
function field(root: FakeEl, key: string): FakeEl {
  const walk = (el: FakeEl): FakeEl | null => {
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (k.dataset.i18n === key) {
        const input = kids.slice(i + 1).find((c) => c.tagName === "input");
        if (input) return input;
      }
      const hit = walk(k);
      if (hit) return hit;
    }
    return null;
  };
  const hit = walk(root);
  if (!hit) throw new Error(`no field under ${key}`);
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

function typeIn(el: FakeEl, text: string) {
  el.value = text;
  el.dispatch("input");
}

function openPanel() {
  const prompt = installPanelDom();
  const panel = new TextOnFacePanel();
  let committed: TextOnFaceValues | null = null;
  panel.show(
    { editing: false, fonts: ["DejaVu Sans"], initial: { text: "hi" } },
    { onCommit: (v) => { committed = v; }, onChange: () => {}, onCancel: () => {} },
  );
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  const root = body.children.at(-1)!;
  const text = root.children.find((c) => c.tagName === "textarea")!;
  // [colour chips…, Add, Cancel]
  const ok = buttons(root).at(-2)!;
  return {
    panel,
    text,
    height: field(root, "feature.text.size"),
    across: field(root, "feature.text.across"),
    add: () => ok.dispatch("pointerdown", { preventDefault() {}, stopPropagation() {} }),
    ctrlEnter: (composing: boolean) =>
      text.dispatch("keydown", {
        key: "Enter", ctrlKey: true, metaKey: false,
        isComposing: composing, keyCode: composing ? 229 : 0,
        preventDefault() {},
      }),
    committed: () => committed as TextOnFaceValues | null,
    promptText: () => prompt.textContent,
  };
}

describe("TextOnFacePanel — a number the app cannot read never becomes a default", () => {
  it("refuses to commit a size typed as '3.14.15'", () => {
    const p = openPanel();
    p.add();
    expect(p.committed()?.height).toBe(6); // control: the seeded value commits
    typeIn(p.height, "3.14.15");
    p.add();
    expect(p.committed()?.height).toBe(6); // still the previous commit, not a new one
    expect(p.promptText()).toBe(t("feature.badNumber"));
  });

  it("refuses an unreadable placement offset", () => {
    const p = openPanel();
    typeIn(p.across, "1.2.3");
    p.add();
    expect(p.committed()).toBeNull();
  });

  it("commits once the size reads as a number again", () => {
    const p = openPanel();
    typeIn(p.height, "1.2.3");
    p.add();
    expect(p.committed()).toBeNull();
    typeIn(p.height, "8,5"); // comma decimal
    p.add();
    expect(p.committed()?.height).toBe(8.5);
  });

  it("leaves a cleared field on its default", () => {
    const p = openPanel();
    typeIn(p.across, "");
    p.add();
    expect(p.committed()?.u).toBe(0);
  });

  it("does not commit on Ctrl+Enter mid-composition", () => {
    const p = openPanel();
    p.text.value = "にほんご";
    p.ctrlEnter(true);
    expect(p.committed()).toBeNull();
    p.ctrlEnter(false);
    expect(p.committed()?.text).toBe("にほんご");
  });
});
