// Sketch TEXT can be dragged in the plane.
//
// GH #17: "Text Tool: Unable to manually drag or adjust text position with the
// mouse in the sketch plane after creation."
//
// The machinery was all there. `translated()` has always handled a text entity,
// and the body-drag path calls it. What was missing is that text never REACHED
// that path: `pickEntity` walks `entitySegments`, which is empty for text, which
// is exactly why the double-click-to-edit branch finds text through its glyph
// bounding box instead. So the drag is armed from that same hit test.
//
// This file pins the two halves that make the gesture work — the translation
// itself, and that the drag is armed for text at all.

import { describe, it, expect } from "vitest";
import { translated } from "./pattern";
import { pickEntity } from "./modify";
import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import sketchModeSrc from "./sketchMode.ts?raw";

const text = (x: number, y: number): ResolvedEntity =>
  ({ type: "text", id: "t1", text: "hello", height: 10, x, y }) as unknown as ResolvedEntity;

describe("translating text", () => {
  it("moves it in the plane and keeps everything else", () => {
    const out = translated(text(5, 7), 10, -3, "t1") as unknown as {
      type: string; x: number; y: number; text: string; height: number;
    };
    expect(out.type).toBe("text");
    expect(out.x).toBeCloseTo(15);
    expect(out.y).toBeCloseTo(4);
    expect(out.text).toBe("hello"); // content and size ride along untouched
    expect(out.height).toBeCloseTo(10);
  });
});

describe("why text needed its own hit test", () => {
  it("pickEntity genuinely cannot see text", () => {
    // Not an accident to work around — text has no tessellated outline, so the
    // ordinary body-drag path can never find it. If this ever starts returning a
    // hit, the special case in sketchMode is redundant and should go.
    expect(pickEntity([text(0, 0)], new THREE.Vector2(0, 0), 50)).toBe(-1);
  });

  it("the select tool arms a body drag from the TEXT hit test", () => {
    // Source-asserted: driving a real SketchMode needs the viewport, overlay and
    // solver. What matters is that the text branch arms `moveDrag`, and that it
    // sits BEFORE the pickEntity branch — after it, pickEntity's miss would have
    // already fallen through to the marquee.
    const at = sketchModeSrc.indexOf("const te = this.textEntityAt(raw);\n      const teIdx");
    expect(at, "the text-drag branch is gone from the select tool").toBeGreaterThan(-1);
    const pickAt = sketchModeSrc.indexOf("const idx = pickEntity(this.entities, raw, this.pickTol());", at);
    expect(pickAt).toBeGreaterThan(at);
    expect(sketchModeSrc.slice(at, pickAt)).toContain("this.moveDrag = {");
  });
});
