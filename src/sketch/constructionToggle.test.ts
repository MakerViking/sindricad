// Switching existing geometry between construction and normal.
//
// Report 2fc27cf1: "I cannot see how to switch a line from 'construction' to
// 'line'". There was no way. The `construction` flag has always been stored on
// every entity type, but only the creation sites ever set it (the palette
// switch was read when a line was DRAWN and never again), so a line drawn the
// wrong way could only be deleted and redrawn. The same reporter's other sketch
// carries three construction entities, so they had drawn with the switch on and
// then found no way back.
//
// Three ways in now, each tested where the user enters: the selection's
// right-click menu, the palette's Construction switch acting on a selection,
// and X. The effect that matters is the profile: construction never forms a
// region, so converting a closed outline takes its area away and converting it
// back returns it.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import { liveSketch, PX } from "./liveSketch.testkit";
import { detectRegions } from "./region";
import { contextMenu, type CtxItem } from "../ui/menu";
import { toast } from "../ui/toast";
import { resolveShortcut, SHORTCUTS } from "../input/shortcuts";
import type { ResolvedEntity } from "./snap";
import mainSrc from "../main.ts?raw";

const rect = (): ResolvedEntity => ({ type: "rectangle", id: "e0", x: 30, y: 20, width: 60, height: 40 });
const line = (id: string, x1: number, y1: number, x2: number, y2: number, construction = false): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2, ...(construction ? { construction: true } : {}) }) as ResolvedEntity;

/** Right-click at plane (x, y) and return the menu that opened. */
function menuAt(live: ReturnType<typeof liveSketch>, x: number, y: number): CtxItem[] {
  vi.mocked(contextMenu).mockClear();
  live.s.onContextMenu({ clientX: x * PX, clientY: y * PX, preventDefault() {} } as unknown as MouseEvent);
  return (vi.mocked(contextMenu).mock.calls[0]?.[2] ?? []) as CtxItem[];
}
const item = (items: CtxItem[], label: string) => items.find((i) => i.label === label);
const regions = (live: ReturnType<typeof liveSketch>) => detectRegions("__active__", live.s.entities).length;

describe("the selection's right-click turns geometry into construction and back (2fc27cf1)", () => {
  beforeEach(() => vi.mocked(contextMenu).mockClear());

  it("Make construction on a rectangle takes its profile away, in one undo step", async () => {
    const live = liveSketch([rect()]);
    expect(regions(live)).toBe(1);
    const items = menuAt(live, 30, 0); // the bottom edge
    const make = item(items, "Make construction");
    expect(make, `menu offered: ${items.map((i) => i.label).join(", ")}`).toBeDefined();
    const depth = live.s.history.depth;
    make!.onClick?.();
    await live.settle();
    expect(live.ent("e0")?.construction).toBe(true);
    expect(regions(live), "a construction rectangle still closes a profile").toBe(0);
    expect(live.s.history.depth).toBe(depth + 1);
    live.s.undoEdit();
    expect(live.ent("e0")?.construction).toBeUndefined();
    expect(regions(live)).toBe(1);
  });

  it("on construction geometry it offers Make normal, which drops the flag entirely", async () => {
    const live = liveSketch([{ ...rect(), construction: true }]);
    expect(regions(live)).toBe(0);
    const items = menuAt(live, 30, 0);
    expect(item(items, "Make construction")).toBeUndefined();
    item(items, "Make normal")!.onClick?.();
    await live.settle();
    // dropped, not `construction: false` — the same byte-stable shape as a line
    // that was never construction
    expect("construction" in live.ent("e0")!).toBe(false);
    expect(regions(live)).toBe(1);
  });

  it("follows the selection's majority, and converts all of it", async () => {
    const live = liveSketch([
      line("a", 0, 0, 10, 0, true),
      line("b", 0, 10, 10, 10, true),
      line("c", 0, 20, 10, 20),
    ]);
    live.click(5, 0);
    live.click(5, 10, true);
    live.click(5, 20, true);
    const items = menuAt(live, 5, 20);
    item(items, "Make normal")!.onClick?.();
    await live.settle();
    for (const id of ["a", "b", "c"]) expect(live.ent(id)?.construction, id).toBeUndefined();
  });

  it("leaves the origin alone, even when it is part of the selection", async () => {
    const live = liveSketch([line("a", 10, 10, 20, 10, true)]);
    live.click(15, 10);
    live.s.selected.add("__originX__");
    expect(live.s.setSelectedConstruction(false)).toBe(true);
    await live.settle();
    expect(live.ent("a")?.construction).toBeUndefined();
    expect(live.ent("__originX__")?.construction).toBe(true);
  });
});

describe("the palette's Construction switch acts on a selection too (2fc27cf1)", () => {
  it("ticking it converts the selected line, and still arms the mode for the next one", async () => {
    const live = liveSketch([line("a", 0, 0, 10, 0)]);
    live.click(5, 0);
    live.s.setConstruction(true);
    await live.settle();
    expect(live.ent("a")?.construction).toBe(true);
    expect(live.s.constructionMode).toBe(true);
    live.s.setConstruction(false);
    await live.settle();
    expect(live.ent("a")?.construction).toBeUndefined();
  });

  it("CONTROL: with nothing selected it only sets the mode, as it always has", async () => {
    const live = liveSketch([line("a", 0, 0, 10, 0)]);
    const depth = live.s.history.depth;
    live.s.setConstruction(true);
    await live.settle();
    expect(live.ent("a")?.construction).toBeUndefined();
    expect(live.s.constructionMode).toBe(true);
    expect(live.s.history.depth).toBe(depth);
  });
});

// Report 9b764625: "In a sketch, I have a construction line, in the Sketch
// Palette panel the construction check box does not do anything". The box
// showed the drawing mode, unticked, whatever was selected: with that line
// selected, ticking it asked for what the line already was, and nothing
// changed. The box now shows what it would act on, the selection, by the same
// majority rule that names the right-click item.
describe("the palette's Construction box shows the selection (9b764625)", () => {
  it("ticked for a selected construction line, and unticking it makes the line normal", async () => {
    const live = liveSketch([line("a", 0, 0, 10, 0, true)]);
    expect(live.s.constructionShown(), "nothing selected: the drawing mode").toEqual({ on: false, mixed: false });
    live.click(5, 0);
    expect(live.s.constructionShown()).toEqual({ on: true, mixed: false });
    live.s.setConstruction(false); // the untick
    await live.settle();
    expect(live.ent("a")?.construction).toBeUndefined();
    expect(live.s.constructionShown()).toEqual({ on: false, mixed: false });
  });

  it("with nothing selected it shows the drawing mode, whatever is in the sketch", () => {
    const live = liveSketch([line("a", 0, 0, 10, 0, true)]);
    live.s.setConstruction(true);
    expect(live.s.constructionShown()).toEqual({ on: true, mixed: false });
    live.s.setConstruction(false);
    expect(live.s.constructionShown()).toEqual({ on: false, mixed: false });
  });

  it("a part-construction selection shows as mixed, over the way the right-click item would go", async () => {
    const live = liveSketch([
      line("a", 0, 0, 10, 0, true),
      line("b", 0, 10, 10, 10, true),
      line("c", 0, 20, 10, 20),
    ]);
    live.click(5, 0);
    live.click(5, 10, true);
    live.click(5, 20, true);
    const shown = live.s.constructionShown();
    expect(shown).toEqual({ on: true, mixed: true });
    expect(item(menuAt(live, 5, 20), "Make normal"), "the right-click item goes the other way").toBeDefined();
    // a click on an indeterminate box flips what is underneath it
    live.s.setConstruction(!shown.on);
    await live.settle();
    for (const id of ["a", "b", "c"]) expect(live.ent(id)?.construction, id).toBeUndefined();
    expect(live.s.constructionShown()).toEqual({ on: false, mixed: false });
  });

  it("a tie shows unticked and mixed, so a click makes it all construction, like the right-click", () => {
    const live = liveSketch([line("a", 0, 0, 10, 0, true), line("b", 0, 10, 10, 10)]);
    live.click(5, 0);
    live.click(5, 10, true);
    expect(live.s.constructionShown()).toEqual({ on: false, mixed: true });
    expect(item(menuAt(live, 5, 10), "Make construction")).toBeDefined();
  });

  it("the origin in a selection does not count: it is construction and cannot change", () => {
    const live = liveSketch([line("a", 10, 10, 20, 10)]);
    live.click(15, 10);
    live.s.selected.add("__originX__");
    expect(live.s.constructionShown()).toEqual({ on: false, mixed: false });
  });
});

describe("a toggle says what it changed, and what that means for the profile (2fc27cf1)", () => {
  // The selection stays after a toggle. When a selected entity drew solid in
  // the selection colour whether it was construction or not (3f16187e), the
  // only visible change was a closed profile losing its fill. It is dashed
  // while selected now (cd7b5ac6), and the note also says what the switch
  // means for the profile.
  beforeEach(() => vi.mocked(toast).mockClear());
  const toasts = () => vi.mocked(toast).mock.calls.map((c) => c[0]);

  it("the right-click item names the change and the count", async () => {
    const live = liveSketch([line("a", 0, 0, 10, 0), line("b", 0, 10, 10, 10)]);
    live.click(5, 0);
    live.click(5, 10, true);
    item(menuAt(live, 5, 10), "Make construction")!.onClick?.();
    await live.settle();
    expect(toasts()).toEqual(["Made 2 entities construction geometry: they draw dashed and are never part of a profile"]);
    item(menuAt(live, 5, 10), "Make normal")!.onClick?.();
    await live.settle();
    expect(toasts().at(-1)).toBe("Made 2 entities normal geometry: they draw solid and can be part of a profile");
  });

  it("so does the palette switch converting a selection left over from before", async () => {
    const live = liveSketch([line("a", 0, 0, 10, 0)]);
    live.click(5, 0);
    live.s.setConstruction(true);
    await live.settle();
    expect(toasts()).toEqual(["Made 1 entity construction geometry: it draws dashed and is never part of a profile"]);
  });

  it("and says nothing, and banks nothing, when the selection already was that kind", async () => {
    const live = liveSketch([line("a", 0, 0, 10, 0, true)]);
    live.click(5, 0);
    const depth = live.s.history.depth;
    live.s.setConstruction(true);
    await live.settle();
    expect(toasts()).toEqual([]);
    expect(live.s.history.depth).toBe(depth);
  });
});

describe("X toggles the selection (2fc27cf1)", () => {
  it("is bound in the sketch context, on a key nothing else in that context uses", () => {
    expect(resolveShortcut("x", false, "sketch")).toBe("toggle-construction");
    const taken = SHORTCUTS.filter((s) => s.key === "x" && s.context !== "model");
    expect(taken.map((s) => s.id)).toEqual(["s.construction"]);
  });

  it("main.ts routes the action to the toggle and says so when nothing is selected", () => {
    const at = mainSrc.indexOf('if (action === "toggle-construction")');
    expect(at).toBeGreaterThan(-1);
    const body = mainSrc.slice(at, at + 400);
    expect(body).toContain("sketch.setSelectedConstruction()");
    expect(body).toContain("status.constructionNothingSelected");
  });

  it("flips a selected line each time, and reports nothing to do on an empty selection", async () => {
    const live = liveSketch([line("a", 0, 0, 10, 0)]);
    expect(live.s.setSelectedConstruction()).toBe(false);
    live.click(5, 0);
    live.s.setSelectedConstruction();
    await live.settle();
    expect(live.ent("a")?.construction).toBe(true);
    live.s.setSelectedConstruction();
    await live.settle();
    expect(live.ent("a")?.construction).toBeUndefined();
  });
});

// Integration check 6b: X pressed while a drag is still held left an EMPTY undo
// step. The toggle banked the pre-drag state at once (requestSolve), and the
// release banked the very same pre-drag state again (bankDrag), so the second
// undo changed nothing. The gesture is now one step whichever moment X lands in.
describe("X pressed in the middle of a drag (integration 6b)", () => {
  /** a selected line, then a drag of its end with X pressed at `xAt` */
  async function dragWithX(xAt: "before the first move" | "mid-drag") {
    const live = liveSketch([line("a", 0, 0, 20, 0), line("b", 0, 10, 20, 10)]);
    live.click(10, 0); // select a
    await live.settle();
    // an earlier, unrelated step, so "one undo too many" has something to land on
    live.s.entities = live.s.entities.map((e) => (e.id === "b" ? { ...e, y1: 12, y2: 12 } as ResolvedEntity : e));
    live.s.requestSolve();
    await live.settle();
    const depth = live.s.history.depth;
    live.press(20, 0); // a's end, button held from here
    if (xAt === "before the first move") { live.s.setSelectedConstruction(); await live.settle(); }
    live.move(22, 2);
    await live.settle();
    if (xAt === "mid-drag") { live.s.setSelectedConstruction(); await live.settle(); }
    live.move(25, 5);
    await live.settle();
    live.release();
    await live.settle();
    return { live, depth };
  }

  for (const when of ["mid-drag", "before the first move"] as const) {
    it(`${when}: the drag and the toggle land, as ONE undo step, and the next undo is the step before`, async () => {
      const { live, depth } = await dragWithX(when);
      expect(live.ent("a")).toMatchObject({ x1: 0, y1: 0, x2: expect.closeTo(25, 6), y2: expect.closeTo(5, 6), construction: true });
      expect(live.s.history.depth, "the gesture banked an extra, empty undo step").toBe(depth + 1);

      live.s.undoEdit();
      await live.settle();
      expect(live.ent("a"), "undo did not restore the line as it was before the gesture").toEqual(line("a", 0, 0, 20, 0));
      // the NEXT undo reverts the step before the gesture, not nothing
      live.s.undoEdit();
      await live.settle();
      expect(live.ent("b")).toEqual(line("b", 0, 10, 20, 10));
    });
  }
});
