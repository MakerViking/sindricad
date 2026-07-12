// Unit tests for expandPattern (src/sketch/pattern.ts). Mirrors the Python port
// (sidecar/builder.py _expand_pattern) — see the file header comment there.
import { describe, it, expect } from "vitest";
import { expandPattern } from "./pattern";
import type { ResolvedEntity } from "./snap";
import type { Params, SketchPattern } from "../types";

const params: Params = {};

function byIdMap(entities: ResolvedEntity[]): Map<string, ResolvedEntity> {
  return new Map(entities.map((e) => [e.id, e]));
}

describe("expandPattern / patternRect", () => {
  const src: ResolvedEntity = { type: "circle", id: "c1", radius: 2, x: 0, y: 0 };
  const pat: SketchPattern = {
    id: "p1", type: "patternRect", sources: ["c1"],
    countX: 3, countY: 2, spacingX: 10, spacingY: 5,
  };

  it("emits (countX * countY - 1) instances, skipping the original at (0,0)", () => {
    const out = expandPattern(pat, byIdMap([src]), params);
    expect(out).toHaveLength(3 * 2 - 1);
  });

  it("positions each instance at i*spacingX, j*spacingY relative to the source", () => {
    const out = expandPattern(pat, byIdMap([src]), params) as Extract<ResolvedEntity, { type: "circle" }>[];
    const positions = out.map((e) => [e.x, e.y] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(positions).toEqual([
      [0, 5], [10, 0], [10, 5], [20, 0], [20, 5],
    ]);
  });

  it("derives ids as '<pattern.id>#<n>' in emission order", () => {
    const out = expandPattern(pat, byIdMap([src]), params);
    expect(out.map((e) => e.id)).toEqual(["p1#0", "p1#1", "p1#2", "p1#3", "p1#4"]);
  });

  it("carries the source's construction flag onto every derived copy", () => {
    const constrSrc: ResolvedEntity = { ...src, construction: true };
    const out = expandPattern(pat, byIdMap([constrSrc]), params);
    expect(out.every((e) => e.construction === true)).toBe(true);
  });

  it("silently drops sources that aren't in byId (missing-source filtering)", () => {
    const patMissing: SketchPattern = { ...pat, sources: ["c1", "does-not-exist"] };
    const out = expandPattern(patMissing, byIdMap([src]), params);
    // same count as with a single valid source — the missing id contributes nothing
    expect(out).toHaveLength(3 * 2 - 1);
  });
});

describe("expandPattern / patternCircular", () => {
  const src: ResolvedEntity = { type: "circle", id: "c1", radius: 1, x: 10, y: 0 };

  it("full 360° pattern spaces `count` instances evenly and omits the original", () => {
    const pat: SketchPattern = {
      id: "p2", type: "patternCircular", sources: ["c1"],
      cx: 0, cy: 0, count: 4, angle: 360,
    };
    const out = expandPattern(pat, byIdMap([src]), params) as Extract<ResolvedEntity, { type: "circle" }>[];
    expect(out).toHaveLength(3); // count - 1 (original stays as the real entity)
    // step = 360/4 = 90°: instances land at (0,10), (-10,0), (0,-10)
    const rounded = out.map((e) => [Math.round(e.x) || 0, Math.round(e.y) || 0]);
    expect(rounded).toEqual([[0, 10], [-10, 0], [0, -10]]);
  });

  it("partial-angle pattern spaces across count-1 steps", () => {
    const pat: SketchPattern = {
      id: "p3", type: "patternCircular", sources: ["c1"],
      cx: 0, cy: 0, count: 3, angle: 180,
    };
    const out = expandPattern(pat, byIdMap([src]), params) as Extract<ResolvedEntity, { type: "circle" }>[];
    expect(out).toHaveLength(2);
    // step = 180/(3-1) = 90°
    const rounded = out.map((e) => [Math.round(e.x), Math.round(e.y)]);
    expect(rounded).toEqual([[0, 10], [-10, 0]]);
  });

  it("derives ids as '<pattern.id>#<n>'", () => {
    const pat: SketchPattern = {
      id: "p4", type: "patternCircular", sources: ["c1"],
      cx: 0, cy: 0, count: 3, angle: 360,
    };
    const out = expandPattern(pat, byIdMap([src]), params);
    expect(out.map((e) => e.id)).toEqual(["p4#0", "p4#1"]);
  });

  // KNOWN ISSUE (docs/IMPROVEMENT-AUDIT.md §5.2 / §1.2): the TS preview and the
  // Python build (sidecar/builder.py _expand_pattern) round non-integer counts
  // differently — JS `Math.round` rounds .5 away from zero, Python's `round()`
  // rounds .5 to even (banker's rounding). A half-integer count like 2.5 is
  // therefore NOT guaranteed to produce the same instance count in both halves
  // of the mirrored pair. This is an open bug, not intended behavior — do not
  // assert a "correct" value here until it's fixed on both sides.
  it.skip("half-integer counts match the Python build123d port (KNOWN DIVERGENCE, unresolved)", () => {
    const pat: SketchPattern = {
      id: "p5", type: "patternCircular", sources: ["c1"],
      cx: 0, cy: 0, count: 2.5, angle: 360,
    };
    const out = expandPattern(pat, byIdMap([src]), params);
    // Math.round(2.5) = 3 in JS; Python round(2.5) = 2 (round-half-to-even) —
    // so `out` currently disagrees with what builder.py would build.
    expect(out).toHaveLength(2); // count - 1, once the divergence is resolved
  });
});
