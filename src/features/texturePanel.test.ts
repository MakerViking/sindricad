// What the Texture panel HANDS THE MODEL when a field holds text the app cannot
// read.
//
// The number parser refuses malformed input on purpose ("3.14.15" is null, not
// 314.15 — ui/units), and every tool that reads a typed field refuses the commit
// rather than modelling something the user did not ask for. This panel used to
// write `parseNumber(x) || <default>`, which turned that deliberate refusal back
// into a silent 0.4mm knurl. The `||` also swallowed a typed 0.
//
// Driven for real: the panel only calls createElement/appendChild/addEventListener
// and friends, so the fakeDom stub plus the extras below (a window, `new
// Option`, and enough innerHTML to hold a button's caption span) is enough to
// click the button the user clicks.
import { describe, expect, it } from "vitest";

import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { t } from "../i18n";
import { TexturePanel, type TextureValues } from "./texturePanel";

/** fakeDom's element, plus `remove()` and an innerHTML setter that keeps the
 *  one tag our buttons put their caption in. */
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
  // Esc belongs to TextureTool, not this panel, so nothing here listens on the
  // document — the stubs are just so the panel can be constructed.
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
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

/** The input sitting after the label that carries `key` — the field the user
 *  sees under that caption. */
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

/** Every button in the panel, in document order: [faces, body, randomize,
 *  browse, Add, Cancel] — the last two are the ones a commit goes through. */
function buttons(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "button") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

const click = (el: FakeEl) => el.dispatch("pointerdown", { preventDefault() {}, stopPropagation() {} });

/** Type into a field the way a user does: the text, then the input event the
 *  panel listens for. */
function type(el: FakeEl, text: string) {
  el.value = text;
  el.dispatch("input");
}

function open() {
  const prompt = installPanelDom();
  const panel = new TexturePanel();
  let committed: TextureValues | null = null;
  panel.show(
    { editing: false, mode: "faces", summary: "2 faces", initial: {} },
    {
      onCommit: (v) => { committed = v; },
      onChange: () => {},
      onCancel: () => {},
      onModeChange: () => {},
    },
  );
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  const root = body.children.at(-1)!;
  const btns = buttons(root);
  return {
    panel,
    depth: field(root, "feature.texture.depth"),
    scale: field(root, "feature.texture.scale"),
    seed: field(root, "feature.texture.seed"),
    /** press Add, the way the user commits */
    commit: () => click(btns.at(-2)!),
    committed: () => committed as TextureValues | null,
    promptText: () => prompt.textContent,
  };
}

describe("TexturePanel — a number the app cannot read never becomes a default", () => {
  it("refuses to commit a depth typed as '3.14.15' instead of modelling 0.4", () => {
    const p = open();
    type(p.depth, "3.14.15");
    p.commit();
    expect(p.committed()).toBeNull();
    expect(p.promptText()).toBe(t("feature.badNumber"));
    // still up, so the typo can be fixed rather than the work lost
    expect(p.panel.isActive).toBe(true);
  });

  it("refuses '1.2.3' in scale — the value that used to read as 2", () => {
    const p = open();
    type(p.scale, "1.2.3");
    p.commit();
    expect(p.committed()).toBeNull();
  });

  it("stays open after refusing, so the typed value can be fixed and committed", () => {
    const p = open();
    type(p.depth, "3.14.15");
    p.commit();
    expect(p.committed()).toBeNull();
    type(p.depth, "1,5"); // comma decimal, the reason parseNumber exists
    p.commit();
    expect(p.committed()?.depth).toBe(1.5);
  });

  it("commits a typed 0 as 0, not as the default", () => {
    const p = open();
    type(p.depth, "0");
    p.commit();
    expect(p.committed()?.depth).toBe(0);
  });

  it("still takes the default for a field the user cleared", () => {
    const p = open();
    type(p.depth, "");
    p.commit();
    expect(p.committed()?.depth).toBe(0.4);
  });

  it("commits untouched fields unchanged", () => {
    const p = open();
    p.commit();
    const v = p.committed();
    expect(v?.depth).toBe(0.4);
    expect(v?.scale).toBe(2);
    expect(v?.seed).toBe(1);
  });
});
