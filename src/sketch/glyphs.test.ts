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

  // A rect EDGE became clickable for the seven line tools on 2026-08-17, and the
  // FIRST thing a user will do with it is click Horizontal on an edge that is
  // already horizontal. That is correctly reported redundant, not conflicting —
  // but the amber is painted on the GLYPH (sketchGlyphs.show takes the overIdx
  // set), so an operand this file cannot place is an operand with no badge: no
  // amber, nothing to right-click, nothing to delete. Indistinguishable from a
  // tool that did nothing, which is exactly what GitHub #17 was.
  describe("rectangle EDGE operands", () => {
    const rect: ResolvedEntity = { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 };

    it("places a line-constraint glyph on the edge's own midpoint", () => {
      // edge 1 is the RIGHT side (br -> tr), midpoint (20, 0) — not the
      // rectangle's centre, which is where a fallback to the entity would put it
      const g = constraintGlyphs([rect], [{ type: "vertical", line: "R~1" }]);
      expect(g.length, "a rect-edge constraint has no glyph at all").toBe(1);
      expect(g[0]!.label).toBe("V");
      expect(g[0]!.pos.x).toBeCloseTo(20);
      expect(g[0]!.pos.y).toBeCloseTo(0);
    });

    it("places one on each of the four edges, and tells them apart", () => {
      const g = constraintGlyphs([rect], [
        { type: "horizontal", line: "R~0" }, // bottom
        { type: "vertical", line: "R~1" },   // right
        { type: "horizontal", line: "R~2" }, // top
        { type: "vertical", line: "R~3" },   // left
      ]);
      expect(g.map((q) => [q.pos.x, q.pos.y])).toEqual([[0, -10], [20, 0], [0, 10], [-20, 0]]);
    });

    it("still falls back to the entity centre for a non-line operand", () => {
      // `equal` between a rect edge and a circle is not a legal pick, but the
      // fallback matters for every operand that is not a line: decoding must not
      // swallow the circle case on its way to handling `R~k`.
      const k: ResolvedEntity = { type: "circle", id: "K", x: 60, y: 5, radius: 8 };
      const g = constraintGlyphs([rect, k], [{ type: "equalRadius", a: "K", b: "K" }]);
      expect(g[0]!.pos.x).toBeCloseTo(60);
      expect(g[0]!.pos.y).toBeCloseTo(5);
    });

    it("skips an edge index the rectangle does not have", () => {
      expect(constraintGlyphs([rect], [{ type: "horizontal", line: "R~9" }])).toEqual([]);
    });
  });
});
