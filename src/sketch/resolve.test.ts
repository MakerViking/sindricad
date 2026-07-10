// Regression lock for the Wave-1 pattern-baking fix (docs/IMPROVEMENT-AUDIT.md
// §1.2 / §5.2): SketchMode.enter() must resolve ONLY a sketch's real (persisted)
// entities — never the pattern-derived copies — or else every enter/finish cycle
// bakes the previous cycle's derived copies in as new real entities and the
// sketch grows without bound. These tests exercise the resolve.ts round trip
// that enter()/finish() rely on: resolveRealEntities -> toSketchEntity -> (next
// cycle) resolveRealEntities again.
import { describe, it, expect } from "vitest";
import { resolveRealEntities, resolveEntities, toSketchEntity } from "./resolve";
import type { Feature, Params, SketchEntity } from "../types";

type SketchFeature = Extract<Feature, { type: "sketch" }>;

const params: Params = { r: 5, len: 10 };

function makeSketch(entities: SketchEntity[]): SketchFeature {
  return {
    id: "f1",
    type: "sketch",
    plane: "XY",
    entities,
    patterns: [
      // 2x1 grid (skips the original) -> 1 derived copy of e1
      { id: "p1", type: "patternRect", sources: ["e1"], countX: 2, countY: 1, spacingX: 20, spacingY: 0 },
      // 3-way full-circle pattern (skips the original) -> 2 derived copies of e2
      { id: "p2", type: "patternCircular", sources: ["e2"], cx: 0, cy: 0, count: 3, angle: 360 },
    ],
  };
}

const baseEntities: SketchEntity[] = [
  // parametric: radius comes from a document parameter, not a literal
  { type: "circle", id: "e1", radius: "r", x: 0, y: 0 },
  { type: "line", id: "e2", x1: 0, y1: 0, x2: "len", y2: 0 },
];

describe("resolveRealEntities", () => {
  it("returns exactly the real entities, in order, with their persisted ids", () => {
    const sketch = makeSketch(baseEntities);
    const real = resolveRealEntities(sketch, params);
    expect(real.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("never returns pattern-derived ids", () => {
    const sketch = makeSketch(baseEntities);
    const real = resolveRealEntities(sketch, params);
    expect(real.some((e) => e.id.includes("#"))).toBe(false);
  });

  it("resolves parameter-expression coordinates against the document params", () => {
    const sketch = makeSketch(baseEntities);
    const [circle, line] = resolveRealEntities(sketch, params);
    expect(circle).toMatchObject({ type: "circle", radius: 5, x: 0, y: 0 });
    expect(line).toMatchObject({ type: "line", x1: 0, y1: 0, x2: 10, y2: 0 });
  });

  it("round-trips through toSketchEntity to the persisted (finish()) form", () => {
    const sketch = makeSketch(baseEntities);
    const persisted = resolveRealEntities(sketch, params).map(toSketchEntity);
    expect(persisted).toEqual([
      { type: "circle", id: "e1", radius: 5, x: 0, y: 0 },
      { type: "line", id: "e2", x1: 0, y1: 0, x2: 10, y2: 0 },
    ]);
  });
});

describe("resolveEntities", () => {
  it("returns real entities plus every pattern's derived copies", () => {
    const sketch = makeSketch(baseEntities);
    const all = resolveEntities(sketch, params);
    // 2 real + 1 (patternRect: 2*1 - 1) + 2 (patternCircular: 3 - 1)
    expect(all).toHaveLength(5);
  });

  it("derives ids as '<patternId>#<n>', distinct from real entity ids", () => {
    const sketch = makeSketch(baseEntities);
    const all = resolveEntities(sketch, params);
    const derivedIds = all.map((e) => e.id).filter((id) => id.includes("#"));
    expect(derivedIds).toEqual(["p1#0", "p2#0", "p2#1"]);
  });

  it("computes derived copies from the resolved source geometry", () => {
    const sketch = makeSketch(baseEntities);
    const all = resolveEntities(sketch, params);
    const derived = all.find((e) => e.id === "p1#0");
    // translated by (i=1)*spacingX=20, (j=0)*spacingY=0 from the resolved source (0,0)
    expect(derived).toMatchObject({ type: "circle", radius: 5, x: 20, y: 0 });
  });
});

describe("enter/finish round trip (regression: pattern copies must never be baked in)", () => {
  it("resolving real entities repeatedly never grows the persisted entity list", () => {
    let entities: SketchEntity[] = baseEntities;
    for (let cycle = 0; cycle < 3; cycle++) {
      const sketch = makeSketch(entities);
      const real = resolveRealEntities(sketch, params);
      // THE regression: this used to include the previous cycle's derived
      // pattern copies, so the list grew by the pattern's instance count
      // every enter/finish cycle instead of staying at the 2 real entities.
      expect(real).toHaveLength(2);
      expect(real.map((e) => e.id)).toEqual(["e1", "e2"]);
      entities = real.map(toSketchEntity);
    }
    // after 3 cycles the persisted entities are still just the resolved
    // (now-numeric) originals — nothing accumulated.
    expect(entities).toEqual([
      { type: "circle", id: "e1", radius: 5, x: 0, y: 0 },
      { type: "line", id: "e2", x1: 0, y1: 0, x2: 10, y2: 0 },
    ]);
  });

  it("resolveEntities recomputed from the round-tripped entities keeps the same derived count", () => {
    // simulate one enter->finish cycle, then re-render (resolveEntities) as the
    // committed-sketch overlay would: the derived-copy count must be identical
    // to what it was before the round trip, not doubled/accumulated.
    const before = resolveEntities(makeSketch(baseEntities), params);
    const roundTripped = resolveRealEntities(makeSketch(baseEntities), params).map(toSketchEntity);
    const after = resolveEntities(makeSketch(roundTripped), params);
    expect(after).toHaveLength(before.length);
  });
});
