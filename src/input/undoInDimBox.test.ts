// Ctrl+Z while a 3D tool's dimension box has focus.
//
// Field report a0a76571: "even Undo does not work". The chamfer tool opens the
// on-canvas dimension box and re-asserts focus on the next frame, so for the
// whole time the tool is open the caret is in an <input> — and BOTH layers threw
// the keystroke away. DimInput's own keydown handler calls stopPropagation on
// every key (so drawing shortcuts can't fire while typing), which means the
// event never even reached the window; and keymap.ts returns early for any
// event aimed at an input. The WebView's text-undo took it instead, and the
// document's undo was unreachable without first cancelling the tool.
//
// The rule: while the box's text is UNCHANGED since it took focus there is no
// typing in there to undo, so the keystroke is the app's. Once the user has
// actually typed, it is theirs again.
//
// This drives the REAL DimInput and the REAL keymap against each other — the
// box is built by DimInput.show(), the keydown is dispatched to the listener the
// box registered, and the assertion is on the action the keymap dispatched. A
// test of either half alone would have passed throughout: keymap's early return
// and DimInput's stopPropagation each hide the bug on their own.
import { describe, it, expect, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

// keymap.ts narrows on `instanceof HTMLInputElement`, so the stub element has to
// BE one as far as the runtime is concerned.
class FakeInput extends FakeEl {
  constructor() {
    super("input");
  }
}
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = FakeInput;
(globalThis as unknown as { HTMLTextAreaElement: unknown }).HTMLTextAreaElement = class {};
(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = FakeEl;

installFakeDocument();
(globalThis as unknown as { document: { createElement(t: string): FakeEl } }).document
  .createElement = (tag: string) => (tag === "input" ? new FakeInput() : new FakeEl(tag));

const windowHandlers: ((e: unknown) => void)[] = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (_t: string, fn: (e: unknown) => void) => windowHandlers.push(fn),
  removeEventListener() {},
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;

const { DimInput } = await import("../sketch/dimInput");
const { installKeymap } = await import("./keymap");

const actions: string[] = [];
installKeymap((a) => actions.push(a), () => "model");

/** The box a fillet/chamfer/extrude opens, plus its input element. */
function openBox() {
  const dim = new DimInput();
  dim.show([{ name: "distance", label: "D", kind: "length" }], () => {});
  const input = (dim as unknown as { fields: { input: FakeInput }[] }).fields[0]!.input;
  input.dispatch("focus");
  return { dim, input };
}

/** One keystroke, delivered the way the browser delivers it: to the input's own
 *  keydown listener first, and on to the window unless that one stopped it. */
function press(input: FakeInput, key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  let stopped = false;
  let defaultPrevented = false;
  const e = {
    key,
    ctrlKey: !!mods.ctrlKey,
    metaKey: false,
    shiftKey: !!mods.shiftKey,
    target: input,
    stopPropagation: () => (stopped = true),
    preventDefault: () => (defaultPrevented = true),
  };
  input.dispatch("keydown", e);
  if (!stopped) for (const fn of windowHandlers) fn(e);
  return { stopped, defaultPrevented };
}

/** What the user typing a digit does: the browser writes the character and
 *  fires `input`. */
function type(input: FakeInput, text: string) {
  input.value += text;
  input.dispatch("input");
}

beforeEach(() => {
  actions.length = 0;
});

describe("undo while a tool's dimension box has focus", () => {
  it("reaches the app when nothing has been typed in the box", () => {
    const { input } = openBox();
    const { stopped, defaultPrevented } = press(input, "z", { ctrlKey: true });
    expect(stopped, "the dim box swallowed the keystroke before the window ever saw it")
      .toBe(false);
    expect(actions, "Ctrl+Z never reached the app: undo is unreachable while a tool is open")
      .toEqual(["undo"]);
    expect(defaultPrevented, "the WebView's own text undo would run as well").toBe(true);
  });

  it("carries Ctrl+Y and Ctrl+Shift+Z through as redo", () => {
    const { input } = openBox();
    press(input, "y", { ctrlKey: true });
    press(input, "z", { ctrlKey: true, shiftKey: true });
    expect(actions).toEqual(["redo", "redo"]);
  });

  it("belongs to the box again once the user has typed in it", () => {
    // Their edit is what the text history is for; taking Ctrl+Z away from a
    // half-typed number would be the same defect pointing the other way.
    const { input } = openBox();
    type(input, "5");
    const { stopped } = press(input, "z", { ctrlKey: true });
    expect(stopped, "typed text must keep its own undo").toBe(true);
    expect(actions, "the app undid the document while the user was mid-edit").toEqual([]);
  });

  it("still keeps ordinary keys out of the app", () => {
    // The control: this exception is for undo/redo only. A letter typed into the
    // box must never fire a modeling shortcut.
    const { input } = openBox();
    const { stopped } = press(input, "l");
    expect(stopped).toBe(true);
    expect(actions).toEqual([]);
  });
});
