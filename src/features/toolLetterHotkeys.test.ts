// Field report 88c9bdf0 was filed against Extrude ("pressing T types a T into
// the dimension box instead of arming the target pick"), but Extrude is not the
// only tool that binds a bare letter while its own dimension box holds focus.
// Thicken binds S (symmetric) and Section binds F (flip the kept side), and
// unlike press/pull NEITHER tears its box down afterwards — so the stray letter
// stays in the field as an unparseable value and freezes it (the `input`
// listener sets userDriven, so cursor tracking stops writing over it too).
//
// Both tools go through the same arbitration as Extrude: the letter belongs to
// the tool while the field's text is unchanged since it took focus, and to the
// field once the user has typed a value.

import { describe, expect, it } from "vitest";
import { SectionTool } from "./sectionTool";
import { FaceOffsetTool } from "./faceOffsetTool";
import { DimInput } from "../sketch/dimInput";

(globalThis as unknown as { document: unknown }).document ??= {
  createElement: () => ({
    style: {},
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    focus() {},
    select() {},
    remove() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }),
  body: { appendChild() {} },
  getElementById: () => null,
};
// no jsdom in this repo: DimInput's arbitration starts with an instanceof
class FakeField {
  constructor(private touched = false) {}
  getAttribute(name: string): string | null {
    // what DimInput writes: "1" while the text is unchanged since it took focus
    return name === "data-undo-passthrough" ? (this.touched ? "0" : "1") : null;
  }
}
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement ??= FakeField;

/** A keystroke delivered to the tool's open dimension field. */
function fieldKey(k: string, opts: { touched?: boolean } = {}) {
  const prevented = { count: 0 };
  const e = {
    key: k,
    target: new FakeField(!!opts.touched),
    preventDefault() {
      prevented.count++;
    },
  } as unknown as KeyboardEvent;
  return { e, prevented };
}

/** A dim stub reporting the box as open and focused. The arbitration is
 *  DimInput's real `claimToolHotkey` — only "is this my own box" is faked. */
function focusedDim() {
  const owner = { active: true, ownsTarget: () => true };
  return {
    isActive: true,
    show() {},
    seed() {},
    hide() {},
    unlock() {},
    updateFromCursor() {},
    position() {},
    isUserDriven: () => false,
    getValue: () => null,
    claimToolHotkey: (e: KeyboardEvent) => DimInput.prototype.claimToolHotkey.call(owner, e),
  };
}

describe("SectionTool F while the offset box has focus", () => {
  /** The tool mid-section: the clip plane built, the offset box up. */
  function harness() {
    const tool = new SectionTool({} as never);
    const t = tool as unknown as {
      active: boolean;
      plane: { normal: { z: number } };
      dim: unknown;
      onKey: (e: KeyboardEvent) => void;
      updatePlane: () => void;
    };
    t.active = true;
    t.dim = focusedDim();
    t.updatePlane(); // +Z kept, as start() leaves it
    return t;
  }

  it("F flips the kept side and does not reach the field", () => {
    const t = harness();
    expect(t.plane.normal.z).toBe(1);
    const { e, prevented } = fieldKey("f");

    t.onKey(e);

    expect(t.plane.normal.z, "F went to the text field instead of the tool").toBe(-1);
    expect(prevented.count, "the letter was left to be typed into the box as well").toBe(1);
  });

  it("once an offset has been typed, F stays TEXT", () => {
    const t = harness();
    const { e, prevented } = fieldKey("f", { touched: true });

    t.onKey(e);

    expect(t.plane.normal.z, "F was stolen from a field the user was typing in").toBe(1);
    expect(prevented.count).toBe(0);
  });
});

describe("FaceOffsetTool S while the distance box has focus", () => {
  /** Thicken mid-drag, one face picked, the distance box up. */
  function harness() {
    const previews: (Record<string, unknown> | null)[] = [];
    const store = { setPreview: (f: Record<string, unknown> | null) => previews.push(f) };
    const tool = new FaceOffsetTool({} as never, store as never);
    const t = tool as unknown as {
      active: boolean;
      mode: string;
      phase: string;
      value: number;
      faces: unknown[];
      faceIds: number[];
      bodyId: string | null;
      previewId: string;
      dim: unknown;
      onKey: (e: KeyboardEvent) => void;
    };
    t.active = true;
    t.mode = "thicken";
    t.phase = "drag";
    t.value = 2;
    t.faces = [{ kind: "face" }];
    t.faceIds = [3];
    t.bodyId = "b1";
    t.previewId = "p1";
    t.dim = focusedDim();
    return { t, previews };
  }

  it("S makes the wall symmetric and does not reach the field", () => {
    const { t, previews } = harness();
    const { e, prevented } = fieldKey("s");

    t.onKey(e);

    expect(previews.at(-1)?.symmetric, "S went to the text field instead of the tool").toBe(true);
    expect(prevented.count, "the letter was left to be typed into the box as well").toBe(1);
  });

  it("once a thickness has been typed, S stays TEXT", () => {
    const { t, previews } = harness();
    const { e, prevented } = fieldKey("s", { touched: true });

    t.onKey(e);

    expect(previews, "S was stolen from a field the user was typing in").toHaveLength(0);
    expect(prevented.count).toBe(0);
  });
});
