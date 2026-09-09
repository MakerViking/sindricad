// Typing Japanese in the app's text fields.
//
// A Japanese, Chinese or Korean user types through an IME: keystrokes go to the
// input method, which shows a reading, offers candidates, and only hands the
// finished text to the field. For the whole of that "composition" the two keys
// this app cares most about mean something else entirely:
//
//   Escape  CANCELS the conversion (back to the raw reading)
//   Enter   CONFIRMS the highlighted candidate
//
// Before this, every one of those keystrokes also reached the app: the first
// Enter of a conversion committed a half-typed rename, and Escape closed the
// dialog out from under the person typing. This suite drives the REAL handlers
// and asserts the EFFECT a user would see — the name is unchanged, the modal is
// still on screen, the parameter was not added.
//
// No jsdom in this project, so the elements are the fakeDom stub, extended here
// with the two calls these particular components make that the shared stub does
// not have (remove() and querySelectorAll).
import { describe, it, expect, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";

/** fakeDom + a parent link, so remove() really takes the element off screen and
 *  a test can ask "is the dialog still there" the way a user would. */
class El extends FakeEl {
  parent: El | null = null;
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
  removeAttribute(name: string) {
    delete (this.attrs as Record<string, string>)[name];
  }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (el: El) => {
      for (const c of el.children as El[]) {
        if (c.tagName === sel) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const body = new El("body");
installFakeDocument();
const doc = globalThis.document as unknown as {
  createElement(t: string): El;
  body: El;
  createRange(): unknown;
  activeElement: unknown;
};
doc.createElement = (tag: string) => new El(tag);
doc.body = body;
// startInlineRename selects the label's text through a Range; nothing here has
// a selection model, and the caret is not what this suite is about.
doc.createRange = () => ({ selectNodeContents() {} });
doc.activeElement = null;

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
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
};

const { isImeComposing } = await import("./focus");
const { startInlineRename } = await import("./browserTree");
const { addRow } = await import("./paramsDialog");
const { choose } = await import("./choice");

/** A keydown as the engines we ship on report it. `composing` covers both
 *  signals a real IME raises: the spec's isComposing, and the keyCode 229 that
 *  some engines report on a key they handed to the input method. */
function key(k: string, composing: "no" | "isComposing" | "keyCode229" = "no") {
  return {
    key: composing === "keyCode229" ? "Process" : k,
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

describe("isImeComposing", () => {
  it("is true for either signal, and false for an ordinary keystroke", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({})).toBe(false);
    expect(isImeComposing(null)).toBe(false);
  });
});

describe("renaming a browser-tree row while an IME is composing", () => {
  /** Start a rename on a row currently called "Body1" and hand back the label
   *  plus whatever name the tree was told to save. */
  function rename() {
    const label = new El("span");
    let saved: string | null = null;
    startInlineRename(label as unknown as HTMLElement, "Body1", (n) => (saved = n));
    return { label, saved: () => saved };
  }

  it("does not save on the Enter that confirms a conversion", () => {
    const r = rename();
    // the reading so far — the IME has not handed over the kanji yet
    r.label.textContent = "ほんたい";
    r.label.dispatch("keydown", key("Enter", "isComposing"));
    expect(r.saved()).toBeNull();
    // and the field is still in edit mode, so the next Enter can commit
    expect(r.label.getAttribute("contenteditable")).toBe("true");
  });

  it("does not save on an engine that only reports keyCode 229", () => {
    const r = rename();
    r.label.textContent = "ほんたい";
    r.label.dispatch("keydown", key("Enter", "keyCode229"));
    expect(r.saved()).toBeNull();
    expect(r.label.getAttribute("contenteditable")).toBe("true");
  });

  it("saves on a real Enter once the composition is over", () => {
    const r = rename();
    r.label.textContent = "本体";
    r.label.dispatch("keydown", key("Enter"));
    expect(r.saved()).toBe("本体");
    expect(r.label.getAttribute("contenteditable")).toBeNull();
  });

  it("keeps the typed text when Escape cancels a conversion", () => {
    const r = rename();
    r.label.textContent = "ほんたい";
    r.label.dispatch("keydown", key("Escape", "isComposing"));
    // the rename is still open and the reading is still there — the IME gets to
    // undo its own conversion without the row snapping back to "Body1"
    expect(r.label.textContent).toBe("ほんたい");
    expect(r.label.getAttribute("contenteditable")).toBe("true");
    expect(r.saved()).toBeNull();
  });

  it("still abandons the rename on a real Escape", () => {
    const r = rename();
    r.label.textContent = "本体";
    r.label.dispatch("keydown", key("Escape"));
    expect(r.label.textContent).toBe("Body1");
    expect(r.saved()).toBeNull();
  });
});

describe("adding a parameter while an IME is composing", () => {
  function row() {
    const added: string[] = [];
    const store = { addParam: (n: string) => (added.push(n), null) };
    const el = addRow(store as never) as unknown as El;
    const [name, expr] = el.children as El[];
    name!.value = "はば";
    expr!.value = "20";
    return { expr: expr!, name: name!, added };
  }

  it("does not add on the Enter that confirms a conversion", () => {
    const r = row();
    r.expr.dispatch("keydown", key("Enter", "isComposing"));
    expect(r.added).toEqual([]);
    // nothing was wiped either — the half-typed reading is still in the field
    expect(r.name.value).toBe("はば");
  });

  it("does not add on an engine that only reports keyCode 229", () => {
    const r = row();
    r.expr.dispatch("keydown", key("Enter", "keyCode229"));
    expect(r.added).toEqual([]);
  });

  it("adds on a real Enter", () => {
    const r = row();
    r.expr.dispatch("keydown", key("Enter"));
    expect(r.added).toEqual(["はば"]);
  });
});

describe("a modal while an IME is composing", () => {
  beforeEach(() => {
    winKeys.length = 0;
    body.children.length = 0;
  });

  /** The real choose() modal, plus a way to see whether it is still on screen. */
  function open() {
    let outcome: string | null | undefined;
    void choose("Keep", [
      { value: "both", label: "Both" },
      { value: "one", label: "One" },
    ]).then((v) => (outcome = v));
    const press = (e: unknown) => {
      for (const fn of [...winKeys]) fn(e);
    };
    return { press, onScreen: () => body.children.length > 0, outcome: () => outcome };
  }

  it("stays open when Escape cancels a conversion", async () => {
    const m = open();
    expect(m.onScreen()).toBe(true);
    m.press(key("Escape", "isComposing"));
    await Promise.resolve();
    expect(m.onScreen()).toBe(true);
    expect(m.outcome()).toBeUndefined();
  });

  it("stays open for an engine that only reports keyCode 229", async () => {
    const m = open();
    m.press(key("Escape", "keyCode229"));
    await Promise.resolve();
    expect(m.onScreen()).toBe(true);
    expect(m.outcome()).toBeUndefined();
  });

  it("closes on a real Escape", async () => {
    const m = open();
    m.press(key("Escape"));
    await Promise.resolve();
    expect(m.onScreen()).toBe(false);
    expect(m.outcome()).toBeNull();
  });
});
