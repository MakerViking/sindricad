import { describe, it, expect } from "vitest";
import { constraintGlyphs } from "./glyphs";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

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

// A constraint spelled with a rectangle EDGE and a point index (`R~k` p0/p1) is
// a second, legal spelling of a corner. Nothing in the app emits it — the
// pickers use the rectangle's own id — but the solver accepts it and
// pruneConstraints keeps it, so one can arrive live from a saved file or the
// agent-control API. It used to render nothing at all: a constraint that solves,
// survives pruning, cannot be seen and cannot be right-clicked away.
describe("constraintGlyphs — the rectangle EDGE spelling of a corner", () => {
  const R = { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 } as ResolvedEntity;
  const P = { type: "point", id: "P", x: 60, y: 60 } as ResolvedEntity;
  // rectCorners is CCW from bottom-left: (-20,-10) (20,-10) (20,10) (-20,10),
  // and edge k runs corner k -> corner (k+1)%4.
  const corners: [number, number][] = [[-20, -10], [20, -10], [20, 10], [-20, 10]];

  it.each([0, 1, 2, 3])("edge %i p0 draws on that edge's FIRST corner", (k) => {
    const g = constraintGlyphs([R, P], [
      { type: "coincident", e1: `R~${k}`, p1: 0, e2: "P", p2: 0 } as SketchConstraint,
    ]);
    expect(g, `R~${k} p0 rendered nothing`).toHaveLength(1);
    expect(g[0]!.pos.x).toBeCloseTo(corners[k]![0]);
    expect(g[0]!.pos.y).toBeCloseTo(corners[k]![1]);
  });

  it("edge k p1 draws on the NEXT corner round, and wraps at edge 3", () => {
    const at = (k: number, p: number) =>
      constraintGlyphs([R, P], [
        { type: "coincident", e1: `R~${k}`, p1: p, e2: "P", p2: 0 } as SketchConstraint,
      ])[0]!.pos;
    expect(at(0, 1).x).toBeCloseTo(20); // edge 0 ends at corner 1
    expect(at(0, 1).y).toBeCloseTo(-10);
    // the wrap is the part an off-by-one would get wrong while every other row passes
    expect(at(3, 1).x).toBeCloseTo(-20); // edge 3 ends back at corner 0
    expect(at(3, 1).y).toBeCloseTo(-10);
  });

  it("refuses a spelling that names no rectangle, rather than inventing a spot", () => {
    // A dangling or malformed reference must stay invisible: drawing it at a
    // made-up position would be worse than not drawing it, because the user
    // could then delete a constraint that is not where the badge says it is.
    expect(constraintGlyphs([R, P], [
      { type: "coincident", e1: "NOPE~0", p1: 0, e2: "P", p2: 0 } as SketchConstraint,
    ])).toHaveLength(0);
    expect(constraintGlyphs([R, P], [
      { type: "coincident", e1: "R~9", p1: 0, e2: "P", p2: 0 } as SketchConstraint,
    ])).toHaveLength(0);
    expect(constraintGlyphs([R, P], [
      { type: "coincident", e1: "P~0", p1: 0, e2: "P", p2: 0 } as SketchConstraint,
    ])).toHaveLength(0);
  });
});

// Report 34bede7e: "When I create a tangent between an arc and a line the
// tangent constraint icon is a long way from the point of tangency". The badge
// sat halfway between the two curves' MIDPOINTS: an arc drawn off the end of a
// 100 mm line put it 18 mm from where they meet.
describe("a tangent's badge sits where the two curves touch (34bede7e)", () => {
  const at = (ents: ResolvedEntity[], c: SketchConstraint) => {
    const g = constraintGlyphs(ents, [c]);
    expect(g, "a tangent with no badge cannot be deleted").toHaveLength(1);
    expect(g[0]!.label).toBe("T");
    return g[0]!.pos;
  };
  const expectAt = (p: { x: number; y: number }, x: number, y: number) => {
    expect(Math.hypot(p.x - x, p.y - y), `badge at (${p.x}, ${p.y}), touching point (${x}, ${y})`).toBeLessThan(1e-9);
  };
  const s2 = Math.SQRT1_2;

  it("an arc drawn off the end of a line: on the shared end, either operand order", () => {
    // centre (100, 20), r 20, from (100, 0) a quarter turn up to (120, 20)
    const ents: ResolvedEntity[] = [
      { type: "line", id: "l", x1: 0, y1: 0, x2: 100, y2: 0 },
      { type: "arc", id: "a", x1: 100, y1: 0, x2: 120, y2: 20, mx: 100 + 20 * s2, my: 20 - 20 * s2 },
    ];
    expectAt(at(ents, { type: "tangent2", a: "l", b: "a" }), 100, 0);
    expectAt(at(ents, { type: "tangent2", a: "a", b: "l" }), 100, 0);
  });

  it("a circle on a line, the older { line, circle } spelling: the foot of its centre", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "l", x1: 0, y1: 0, x2: 100, y2: 0 },
      { type: "circle", id: "c", x: 30, y: 10, radius: 10 },
    ];
    expectAt(at(ents, { type: "tangent", line: "l", circle: "c" }), 30, 0);
  });

  it("two arcs touching from outside: on the line through their centres", () => {
    const ents: ResolvedEntity[] = [
      // centre (0, 0), r 10, from (0, 10) round to (10, 0)
      { type: "arc", id: "a", x1: 0, y1: 10, x2: 10, y2: 0, mx: 10 * s2, my: 10 * s2 },
      // centre (25, 0), r 15, from (10, 0) round to (25, 15)
      { type: "arc", id: "b", x1: 10, y1: 0, x2: 25, y2: 15, mx: 25 - 15 * s2, my: 15 * s2 },
    ];
    expectAt(at(ents, { type: "tangent2", a: "a", b: "b" }), 10, 0);
    expectAt(at(ents, { type: "tangent2", a: "b", b: "a" }), 10, 0);
  });

  it("a circle touching the inside of a bigger one, either operand order", () => {
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "big", x: 0, y: 0, radius: 20 },
      { type: "circle", id: "small", x: 12, y: 0, radius: 8 },
    ];
    expectAt(at(ents, { type: "tangent2", a: "small", b: "big" }), 20, 0);
    expectAt(at(ents, { type: "tangent2", a: "big", b: "small" }), 20, 0);
  });

  it("a rectangle EDGE operand", () => {
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 },
      { type: "circle", id: "c", x: 5, y: -20, radius: 10 },
    ];
    expectAt(at(ents, { type: "tangent2", a: "R~0", b: "c" } as SketchConstraint), 5, -10);
  });

  it("still draws a badge when there is no single touching point, so it can be deleted", () => {
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "c1", x: 0, y: 0, radius: 10 },
      { type: "circle", id: "c2", x: 0, y: 0, radius: 10 },
    ];
    expectAt(at(ents, { type: "tangent2", a: "c1", b: "c2" }), 0, 0);
  });
});
