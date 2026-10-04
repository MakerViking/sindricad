// A press on a coincident's ⊙ badge is a press on the joint it marks.
//
// Integration check 4c: since every snapped join carries a coincident, the ⊙
// badge sits on every snapped joint. It is a DOM element above the canvas, about
// 18 px across against a 9 px pick radius, so it took the press: the badge's
// "geometry beats label" hook (labelOverlapSelect) only SELECTED the entity
// underneath, and neither a point drag nor the Shift-drag that Break's toast
// tells the user to make could start from the dot. Drawn as one chain, with no
// coincident and so no badge, the same press dragged the joint.
//
// Entered where the user enters: the REAL SketchGlyphs badge receives the
// pointerdown, wired to the real labelOverlapSelect exactly as the SketchMode
// constructor wires it, and the drag continues through the real onPointerMove,
// endDrag and solve pump (liveSketch). Only what draws is stubbed.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts, menus } = vi.hoisted(() => ({
  toasts: [] as string[],
  menus: [] as { label: string; onClick?: () => void }[][],
}));
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/menu", () => ({
  contextMenu: (_x: number, _y: number, items: { label: string; onClick?: () => void }[]) => void menus.push(items),
  dismissContextMenu: () => {},
}));

import { byClass, installFakeDocument, type FakeEl } from "../ui/fakeDom.testkit";
import { liveSketch, PX } from "./liveSketch.testkit";
import { SketchGlyphs } from "./sketchGlyphs";
import { constraintGlyphs } from "./glyphs";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";
import { t } from "../i18n";

installFakeDocument();
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});
// what Esc's "is the user typing?" check tests a key's target against
for (const k of ["HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLElement"]) vi.stubGlobal(k, class {});

type Line = Extract<ResolvedEntity, { type: "line" }>;
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });
const body = () => (globalThis as unknown as { document: { body: FakeEl } }).document.body;

/** liveSketch with its glyph layer made real, and the badge's hooks wired the
 *  way the SketchMode constructor wires them. */
function withGlyphs(ents: ResolvedEntity[], cons: SketchConstraint[]) {
  body().innerHTML = "";
  const live = liveSketch(ents, cons);
  // the endpoint dot's radius, 2.5 px (the Shift-detach reads it; breakDetach.test.ts)
  Object.assign(live.s, { endpointDotRadius: () => 2.5 / PX });
  const glyphs = new SketchGlyphs({
    camera: new THREE.PerspectiveCamera(),
    projectToOverlay: () => ({ x: 0, y: 0, width: 900, height: 700 }),
  } as unknown as Viewport);
  const s = live.s as unknown as { labelOverlapSelect(e: PointerEvent): boolean; glyphMenu(e: MouseEvent, i: number): void };
  glyphs.onOverlapPick = (e) => s.labelOverlapSelect(e);
  glyphs.onMenu = (e, i) => s.glyphMenu(e, i);
  const plane = { to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0) } as unknown as SketchPlane;
  glyphs.show(constraintGlyphs(live.s.entities, live.s.constraints), plane, new Set(), new Set());
  const coincidentBadge = () => byClass(body(), "sketch-glyph").find((el) => el.textContent === "⊙");
  /** a press ON the badge, at plane point (x, y) */
  const pressBadge = (x: number, y: number, shift = false) => {
    live.s.lastPress = null; // a fresh gesture, not the second half of a double-click
    coincidentBadge()!.dispatch("pointerdown", {
      button: 0, clientX: x * PX, clientY: y * PX, pointerId: 1,
      shiftKey: shift, ctrlKey: false, metaKey: false,
      preventDefault() {}, stopPropagation() {},
    });
  };
  /** a right-click ON the first badge reading `label`; the menu it opened */
  const rightClickBadge = (label: string, x: number, y: number) => {
    menus.length = 0;
    byClass(body(), "sketch-glyph").find((el) => el.textContent === label)!.dispatch("contextmenu", {
      button: 2, clientX: x * PX, clientY: y * PX, preventDefault() {}, stopPropagation() {},
    });
    return menus.at(-1) ?? [];
  };
  return { live, coincidentBadge, pressBadge, rightClickBadge };
}

const at = (l: ResolvedEntity | undefined, end: 0 | 1) => {
  const q = l as Line;
  return end === 0 ? { x: q.x1, y: q.y1 } : { x: q.x2, y: q.y2 };
};

describe("pressing the ⊙ badge on a snapped join starts the drag of that joint", () => {
  it("a plain drag from the badge moves the joint, both ends together", async () => {
    // L2 drawn starting on L1's end, the snap having recorded the join
    const { live, coincidentBadge, pressBadge } = withGlyphs(
      [line("L1", 0, 0, 20, 0), line("L2", 20, 0, 20, 15)],
      [{ type: "coincident", e1: "L1", p1: 1, e2: "L2", p2: 0 }],
    );
    expect(coincidentBadge(), "precondition: the join has a ⊙ badge").toBeDefined();
    pressBadge(20, 0);
    live.move(22, 2);
    await live.settle();
    live.move(24, 4);
    await live.settle();
    live.release();
    await live.settle();
    expect(at(live.ent("L1"), 1)).toEqual({ x: expect.closeTo(24, 6), y: expect.closeTo(4, 6) });
    expect(at(live.ent("L2"), 0)).toEqual({ x: expect.closeTo(24, 6), y: expect.closeTo(4, 6) });
    expect(at(live.ent("L1"), 0), "the far end of L1 moved").toEqual({ x: 0, y: 0 });
  });

  it("a press on the badge that does not move still selects, as before", async () => {
    const { live, pressBadge } = withGlyphs(
      [line("L1", 0, 0, 20, 0), line("L2", 20, 0, 20, 15)],
      [{ type: "coincident", e1: "L1", p1: 1, e2: "L2", p2: 0 }],
    );
    pressBadge(20, 0);
    live.release();
    await live.settle();
    expect(live.s.selected.size).toBe(1);
    expect(at(live.ent("L1"), 1)).toEqual({ x: 20, y: 0 });
  });

  it("after Break, Shift-drag from the badge on the cut pulls the free half away, as Break's toast says", async () => {
    // a line broken at (10,0) into A and B, then C snapped onto the cut, which
    // joined C to A. B's end is free to leave: drag toward B, holding Shift.
    const { live, pressBadge } = withGlyphs(
      [line("A", 0, 0, 10, 0), line("B", 10, 0, 20, 0), line("C", 10, 0, 10, 12)],
      [{ type: "coincident", e1: "A", p1: 1, e2: "C", p2: 0 }],
    );
    pressBadge(10, 0, true);
    live.move(14, -3);
    await live.settle();
    live.move(15, -4);
    await live.settle();
    live.release();
    await live.settle();
    expect(at(live.ent("B"), 0), "B's end did not leave the cut").toEqual({ x: expect.closeTo(15, 6), y: expect.closeTo(-4, 6) });
    expect(at(live.ent("A"), 1)).toEqual({ x: 10, y: 0 });
    expect(at(live.ent("C"), 0)).toEqual({ x: 10, y: 0 });
  });

  it("CONTROL: a badge away from every handle (H, at a line's middle) still selects and drags nothing", async () => {
    const { live } = withGlyphs([line("L1", 0, 0, 20, 0)], [{ type: "horizontal", line: "L1" }]);
    const h = byClass(body(), "sketch-glyph").find((el) => el.textContent === "H")!;
    live.s.lastPress = null;
    h.dispatch("pointerdown", {
      button: 0, clientX: 10 * PX, clientY: 0, pointerId: 1, shiftKey: false, ctrlKey: false, metaKey: false,
      preventDefault() {}, stopPropagation() {},
    });
    expect([...live.s.selected]).toEqual(["L1"]);
    live.move(12, 3);
    await live.settle();
    live.release();
    await live.settle();
    expect(live.ent("L1")).toEqual(line("L1", 0, 0, 20, 0));
  });
});

// Every corner of a chain of lines carries a Coincident since the line tool
// joins them (inference.test.ts), so the ⊙ covers every polyline corner and
// takes the right-click there. The canvas menu's Disconnect could no longer be
// reached at a corner, and the pull refused an explicit join anyway
// (coincidentHolds), so pulling a corner apart took two steps where it took
// one. The badge's menu offers it now, and a Disconnect releases the join as
// it pulls: one step, and one undo puts both back.
describe("Disconnect from the ⊙ badge on a chain's corner", () => {
  // A then B, as the line tool draws them: B starts on A's end, the corner joined
  const chain = (extra: ResolvedEntity[] = [], cons: SketchConstraint[] = []) => withGlyphs(
    [line("A", 0, 0, 20, 0), line("B", 20, 0, 23, 15), ...extra],
    [{ type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 }, ...cons],
  );
  const coincidents = (cs: SketchConstraint[]) => cs.filter((c) => c.type === "coincident");
  /** pick Disconnect from the corner badge's menu, then pull from the corner to `to` */
  async function disconnect(sk: ReturnType<typeof chain>, to: [number, number]) {
    const items = sk.rightClickBadge("⊙", 20, 0);
    const item = items.find((i) => i.label === t("sketch.menu.disconnect"));
    expect(item, `the badge's menu offers ${JSON.stringify(items.map((i) => i.label))}`).toBeDefined();
    item!.onClick!();
    sk.pressBadge(20, 0);
    sk.live.move(20 + (to[0] - 20) / 2, (to[1]) / 2);
    await sk.live.settle();
    sk.live.move(to[0], to[1]);
    await sk.live.settle();
  }

  it("pulls the corner apart in one step, and the two ends move independently after", async () => {
    const sk = chain();
    toasts.length = 0;
    await disconnect(sk, [24, 8]); // toward B, which heads up from the corner
    sk.live.release();
    await sk.live.settle();
    expect(toasts, "the pull was refused").toEqual([]);
    expect(at(sk.live.ent("B"), 0)).toEqual({ x: expect.closeTo(24, 6), y: expect.closeTo(8, 6) });
    expect(at(sk.live.ent("A"), 1)).toEqual({ x: 20, y: 0 });
    expect(coincidents(sk.live.s.constraints), "the join was left on the ends it no longer joins").toEqual([]);

    // The oracle for "apart" is the solver, not the pull: drag A's end and B's
    // start must stay put. With the join kept this would conflict or drag B along.
    await sk.live.drag([20, 0], [18, -3]);
    expect(at(sk.live.ent("A"), 1)).toEqual({ x: expect.closeTo(18, 6), y: expect.closeTo(-3, 6) });
    expect(at(sk.live.ent("B"), 0)).toEqual({ x: expect.closeTo(24, 6), y: expect.closeTo(8, 6) });
  });

  it("is ONE undo step: one Ctrl+Z puts the end and its join back", async () => {
    const sk = chain();
    await disconnect(sk, [24, 8]);
    sk.live.release();
    await sk.live.settle();
    expect(at(sk.live.ent("B"), 0), "precondition: the pull happened").toEqual({ x: expect.closeTo(24, 6), y: expect.closeTo(8, 6) });
    expect(sk.live.s.undoEdit()).toBe(true);
    await sk.live.settle();
    expect(at(sk.live.ent("B"), 0)).toEqual({ x: 20, y: 0 });
    expect(coincidents(sk.live.s.constraints)).toEqual([{ type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 }]);
  });

  it("Esc during the pull puts the end and its join back", async () => {
    const sk = chain();
    await disconnect(sk, [24, 8]);
    expect(coincidents(sk.live.s.constraints), "precondition: the pull released the join").toEqual([]);
    (sk.live.s as unknown as { onKey(e: unknown): void }).onKey({ key: "Escape", target: null, preventDefault() {} });
    await sk.live.settle();
    expect(at(sk.live.ent("B"), 0)).toEqual({ x: 20, y: 0 });
    expect(coincidents(sk.live.s.constraints)).toEqual([{ type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 }]);
  });

  it("keeps what the end that left was joined to joined to each other", async () => {
    // C was snapped onto the same corner, which joined it to A's end. Pull A's
    // end away (toward A, to the left): B and C are joined only through it.
    const sk = chain([line("C", 20, 0, 20, -12)], [{ type: "coincident", e1: "A", p1: 1, e2: "C", p2: 0 }]);
    await disconnect(sk, [16, 1]);
    sk.live.release();
    await sk.live.settle();
    expect(at(sk.live.ent("A"), 1)).toEqual({ x: expect.closeTo(16, 6), y: expect.closeTo(1, 6) });
    expect(coincidents(sk.live.s.constraints)).toEqual([{ type: "coincident", e1: "B", p1: 0, e2: "C", p2: 0 }]);
  });

  it("a Shift-drag from the badge still refuses an explicit join, and says where Disconnect is", async () => {
    const sk = chain();
    toasts.length = 0;
    sk.pressBadge(20, 0, true);
    sk.live.move(22, 4);
    await sk.live.settle();
    sk.live.move(24, 8);
    await sk.live.settle();
    sk.live.release();
    await sk.live.settle();
    expect(toasts).toEqual([t("sketch.guard.coincidentHolds")]);
    expect(at(sk.live.ent("B"), 0)).toEqual({ x: 20, y: 0 });
    expect(coincidents(sk.live.s.constraints)).toHaveLength(1);
  });

  it("CONTROL: a badge that marks no shared end offers Delete only", () => {
    const sk = withGlyphs([line("L1", 0, 0, 20, 0)], [{ type: "horizontal", line: "L1" }]);
    expect(sk.rightClickBadge("H", 10, 0).map((i) => i.label)).toEqual([t("sketch.constraint.deleteConstraint")]);
  });
});
