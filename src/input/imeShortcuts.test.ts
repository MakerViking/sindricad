// Tool shortcuts must not fire on the keystrokes of an IME conversion.
//
// Japanese is typed by sounding a word out in romaji and then converting it, so
// the letters that reach the app during composition are exactly the letters the
// app binds to tools — "e" is Extrude, "f" is Fillet, "l" is Line. And Escape,
// which the IME uses to CANCEL a conversion, is the app's "drop what you are
// doing". Without a composition guard, writing 円 ("en") in any un-shielded
// field started the Extrude tool.
//
// Drives the REAL keymap and asserts on the actions it dispatched.
import { describe, it, expect, beforeEach } from "vitest";

const windowHandlers: ((e: unknown) => void)[] = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (t: string, fn: (e: unknown) => void) => {
    if (t === "keydown") windowHandlers.push(fn);
  },
  removeEventListener() {},
};
// keymap narrows with `instanceof`; nothing in this suite is an input, so the
// stubs only have to exist for the checks to run.
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = class {};
(globalThis as unknown as { HTMLTextAreaElement: unknown }).HTMLTextAreaElement = class {};
(globalThis as unknown as { HTMLSelectElement: unknown }).HTMLSelectElement = class {};
(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = class {};

const { installKeymap } = await import("./keymap");

const actions: string[] = [];
installKeymap((a) => actions.push(a), () => "model");

/** A keydown on the canvas (no field focused) as the browser delivers it. */
function press(k: string, ime?: "isComposing" | "keyCode229") {
  const e = {
    key: ime === "keyCode229" ? "Process" : k,
    isComposing: ime === "isComposing",
    keyCode: ime === "keyCode229" ? 229 : 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    preventDefault() {},
    stopPropagation() {},
  };
  for (const fn of windowHandlers) fn(e);
}

describe("keymap during an IME composition", () => {
  beforeEach(() => {
    actions.length = 0;
  });

  it("runs the tool on an ordinary letter (the control)", () => {
    press("e");
    expect(actions).toEqual(["extrude"]);
  });

  it("starts nothing while a conversion is in progress", () => {
    press("e", "isComposing");
    press("f", "isComposing");
    press("l", "isComposing");
    expect(actions).toEqual([]);
  });

  it("starts nothing on an engine that only reports keyCode 229", () => {
    press("e", "keyCode229");
    expect(actions).toEqual([]);
  });

  it("does not cancel the tool when Escape cancels a conversion", () => {
    press("Escape", "isComposing");
    press("Escape", "keyCode229");
    expect(actions).toEqual([]);
    // and a real Escape still reaches the app
    press("Escape");
    expect(actions).toEqual(["escape"]);
  });
});
