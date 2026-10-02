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
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));

import { byClass, installFakeDocument, type FakeEl } from "../ui/fakeDom.testkit";
import { liveSketch, PX } from "./liveSketch.testkit";
import { SketchGlyphs } from "./sketchGlyphs";
import { constraintGlyphs } from "./glyphs";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";

installFakeDocument();
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

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
  const s = live.s as unknown as { labelOverlapSelect(e: PointerEvent): boolean };
  glyphs.onOverlapPick = (e) => s.labelOverlapSelect(e);
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
  return { live, coincidentBadge, pressBadge };
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
