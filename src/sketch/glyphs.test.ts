import { describe, it, expect } from "vitest";
import { constraintGlyphs } from "./glyphs";
import type { ResolvedEntity } from "./snap";

describe("constraintGlyphs", () => {
  const line: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 };

  it("places an H glyph at the line midpoint for a horizontal constraint", () => {
    const g = constraintGlyphs([line], [{ type: "horizontal", line: "l" }]);
    expect(g.length).toBe(1);
    expect(g[0]!.label).toBe("H");
    expect(g[0]!.cIndex).toBe(0);
    expect(g[0]!.pos.x).toBeCloseTo(5);
    expect(g[0]!.pos.y).toBeCloseTo(0);
  });

  it("skips dimensional constraints (they render as dimension badges)", () => {
    expect(constraintGlyphs([line], [{ type: "distance", line: "l", value: 10 }])).toEqual([]);
    expect(constraintGlyphs([line], [{ type: "radius", e: "l", value: 3 }])).toEqual([]);
  });

  it("places a fix glyph at the resolved endpoint", () => {
    const g = constraintGlyphs([line], [{ type: "fix", e: "l", p: 1 }]);
    expect(g.length).toBe(1);
    expect(g[0]!.label).toBe("⚓");
    expect(g[0]!.pos.x).toBeCloseTo(10); // endpoint index 1
  });

  it("places a coincident glyph at the shared endpoint", () => {
    const a: ResolvedEntity = { type: "line", id: "a", x1: 0, y1: 0, x2: 5, y2: 0 };
    const b: ResolvedEntity = { type: "line", id: "b", x1: 5, y1: 0, x2: 5, y2: 5 };
    const g = constraintGlyphs([a, b], [{ type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 }]);
    expect(g.length).toBe(1);
    expect(g[0]!.label).toBe("⊙");
    expect(g[0]!.pos.x).toBeCloseTo(5);
    expect(g[0]!.pos.y).toBeCloseTo(0);
  });

  it("keeps the constraint index so a glyph can delete the right constraint", () => {
    const g = constraintGlyphs([line], [
      { type: "distance", line: "l", value: 10 }, // index 0, no glyph
      { type: "horizontal", line: "l" }, // index 1
    ]);
    expect(g.length).toBe(1);
    expect(g[0]!.cIndex).toBe(1); // points at the horizontal, not the dim
  });

  it("skips a glyph whose entity is missing", () => {
    expect(constraintGlyphs([], [{ type: "horizontal", line: "gone" }])).toEqual([]);
  });
});
