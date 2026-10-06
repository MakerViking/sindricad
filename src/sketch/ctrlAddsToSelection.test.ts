// Ctrl-click (Cmd-click on a Mac) adds to the sketch selection, as Shift does
// (round 2 decision B8, promised on GH #17).
//
// Moi455 selected two entities with Ctrl+click to constrain them, and the
// second click replaced the first. Ctrl meant "do not snap" everywhere in a
// sketch, and in Select that did nothing useful: a select press picks by
// distance, not by snap. Ctrl now adds in Select, everywhere Shift does, and
// keeps meaning "do not snap" while drawing.
//
// Every press goes through the real handlers (onPointerDown, onPointerMove,
// endDrag), with the modifier on the event the canvas would receive.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { liveSketch, PX } from "./liveSketch.testkit";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";

type Mods = { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
const ev = (x: number, y: number, mods: Mods = {}) =>
  ({
    button: 0, clientX: x * PX, clientY: y * PX, pointerId: 1,
    shiftKey: false, ctrlKey: false, metaKey: false, ...mods,
    preventDefault() {}, stopPropagation() {},
  }) as unknown as PointerEvent;

/** two lines clear of the origin, which a live sketch draws */
const two = (): ResolvedEntity[] => [
  { type: "line", id: "A", x1: 10, y1: 10, x2: 20, y2: 10 },
  { type: "line", id: "B", x1: 10, y1: 20, x2: 20, y2: 20 },
];

function session() {
  const live = liveSketch(two());
  const s = live.s as typeof live.s & { lastPress: unknown };
  /** a press and release on the same spot, a fresh gesture each time */
  const click = (x: number, y: number, mods?: Mods) => {
    s.lastPress = null;
    s.onPointerDown(ev(x, y, mods));
    s.endDrag(1);
  };
  const selected = () => [...live.s.selected].sort();
  return { live, s, click, selected };
}

describe("Ctrl-click adds to the selection in Select", () => {
  it("control: a plain click on a second line replaces the first", () => {
    const { click, selected } = session();
    click(15, 10);
    click(15, 20);
    expect(selected()).toEqual(["B"]);
  });

  it("Ctrl-click on a second line adds it, and Ctrl-click again takes it back out", () => {
    const { click, selected } = session();
    click(15, 10);
    click(15, 20, { ctrlKey: true });
    expect(selected()).toEqual(["A", "B"]);
    click(15, 20, { ctrlKey: true });
    expect(selected()).toEqual(["A"]);
  });

  it("so does Cmd-click, and Shift-click as before", () => {
    const cmd = session();
    cmd.click(15, 10);
    cmd.click(15, 20, { metaKey: true });
    expect(cmd.selected()).toEqual(["A", "B"]);
    const shift = session();
    shift.click(15, 10);
    shift.click(15, 20, { shiftKey: true });
    expect(shift.selected()).toEqual(["A", "B"]);
  });

  it("Ctrl-click on an END of a line adds that point too", () => {
    const { click, selected } = session();
    click(15, 10);
    click(20, 20, { ctrlKey: true }); // B's end: the press grabs the point, the release selects it
    expect(selected()).toEqual(["A", "B@1"]);
  });

  it("a Ctrl box adds what it covers to what is already selected", () => {
    const { s, click, selected } = session();
    click(15, 10);
    s.lastPress = null;
    s.onPointerDown(ev(5, 25, { ctrlKey: true })); // empty space: a marquee
    s.onPointerMove(ev(25, 15, { ctrlKey: true }));
    s.endDrag(1);
    expect(selected()).toEqual(["A", "B"]);
  });

  it("Ctrl turns snapping off only while drawing", () => {
    const { live, s } = session();
    const noSnap: boolean[] = [];
    const real = (live.s as unknown as { snapAt: (x: number, y: number, n?: boolean) => unknown }).snapAt;
    Object.assign(live.s, {
      snapAt: (x: number, y: number, n = false) => { noSnap.push(n); return real(x, y, n); },
      // what the Line tool's first click opens, inert here
      dim: { show() {}, hide() {}, updateFromCursor() {}, placeAt() {}, focus() {}, isActive: false, isUserDriven: () => false, getValue: () => null },
    });
    s.lastPress = null;
    s.onPointerDown(ev(15, 10, { ctrlKey: true }));
    s.endDrag(1);
    s.tool = "line";
    s.lastPress = null;
    s.onPointerDown(ev(30, 30, { ctrlKey: true }));
    expect(noSnap).toEqual([false, true]);
  });

  it("the Select prompt says which key does what", () => {
    const prompt = t("sketch.prompt.select");
    expect(prompt).toContain("Ctrl-click");
    expect(prompt).toContain("Shift-");
    expect(prompt).toContain("Cmd");
    expect(prompt).toContain("without snapping");
  });
});
