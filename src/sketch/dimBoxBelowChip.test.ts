// A drawing tool's value box sits below the tool's cursor chip (round 2
// decision C7).
//
// The armed tool's icon rides below-right of the pointer (toolCursor), and the
// W/H box the Rectangle tool opens was placed at the same spot, so each covered
// the other while you drew: the chip hid the box's first field, or the box hid
// the chip, depending on which painted last. The box now starts below the chip.
//
// Driven the way a user draws: the Rectangle tool's first click, then a pointer
// move, through the real handlers and a real DimInput rendered on the fake DOM.
import { describe, it, expect, vi } from "vitest";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

class FakeInput extends FakeEl {
  constructor() {
    super("input");
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLInputElement = FakeInput;
g.HTMLTextAreaElement = class {};
g.HTMLSelectElement = class {};
g.HTMLElement = FakeEl;
g.Node = FakeEl;
installFakeDocument();
(g.document as { createElement(tag: string): FakeEl }).createElement = (tag: string) =>
  tag === "input" ? new FakeInput() : new FakeEl(tag);
vi.stubGlobal("requestAnimationFrame", () => 0);

import * as THREE from "three";
import { liveSketch, PX } from "./liveSketch.testkit";
import { DimInput } from "./dimInput";
import { PatternFlow, type PatternHost } from "./patternFlow";
import { CHIP_BOTTOM, CHIP_LEFT } from "../ui/toolCursor";

const px = (v: string | undefined) => Number.parseFloat(v ?? "NaN");

describe("the W/H box and the cursor chip", () => {
  it("the box opens below the chip, never over it, as the rectangle follows the pointer", () => {
    const live = liveSketch([]);
    const dim = new DimInput();
    // the field initialisers liveSketch leaves to the drawing tools
    Object.assign(live.s, {
      dim, lastCursor: new THREE.Vector2(), base: null, chainStart: null, basePinned: false, baseRef: null,
      clickPts: [], pendingGlyph: null, glyphsVisible: false,
    });
    live.s.tool = "rectangle";
    live.click(100, 100); // the first corner opens the W/H box
    const root = (dim as unknown as { root: FakeEl }).root;
    expect(root.style.display, "the Rectangle tool opened no box").toBe("flex");
    for (const [x, y] of [[130, 125], [90, 80]] as const) {
      live.move(x, y);
      const cx = x * PX, cy = y * PX;
      // the chip ends CHIP_BOTTOM below the pointer, and the box grows right
      // and down from its top-left corner, so a box that starts below that
      // line cannot reach the chip, whatever its size
      expect(px(root.style.top), "the box sits over the chip").toBeGreaterThan(cy + CHIP_BOTTOM);
      expect(px(root.style.left), "the box left the pointer's side").toBe(cx + CHIP_LEFT);
    }
  });

  it("a pattern tool's box opens below the chip too", () => {
    // Bolt Circle, Grid Holes, Hex Holes, Honeycomb and the two entity
    // patterns place their box in PatternFlow, which SketchMode reaches
    // through its pattern host
    for (const tool of ["boltCircle", "gridHoles", "hexHoles", "honeycomb"] as const) {
      const live = liveSketch([]);
      const dim = new DimInput();
      Object.assign(live.s, { dim, lastCursor: new THREE.Vector2() });
      const host = (live.s as unknown as { patternHost(): PatternHost }).patternHost();
      Object.assign(live.s, { patternFlow: new PatternFlow(host) });
      live.s.tool = tool;
      live.click(100, 100); // the centre opens the box
      const root = (dim as unknown as { root: FakeEl }).root;
      expect(root.style.display, `${tool} opened no box`).toBe("flex");
      live.move(130, 125);
      expect(px(root.style.top), `${tool}: the box sits over the chip`).toBeGreaterThan(125 * PX + CHIP_BOTTOM);
      expect(px(root.style.left), `${tool}: the box left the pointer's side`).toBe(130 * PX + CHIP_LEFT);
    }
  });
});
