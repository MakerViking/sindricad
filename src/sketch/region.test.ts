// Unit tests for closed-region detection (src/sketch/region.ts): entityPolyline,
// detectRegions, pointInLoop/pointInRegion.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  detectRegions,
  entityPolyline,
  glyphRegion,
  pointInRegion,
  regionsByEntities,
} from "./region";
import type { ResolvedEntity } from "./snap";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });
const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity =>
  ({ type: "rectangle", id, x, y, width, height });
const circle = (id: string, x: number, y: number, radius: number): ResolvedEntity =>
  ({ type: "circle", id, x, y, radius });

describe("entityPolyline", () => {
  it("a line is its two endpoints, open (no closing vertex)", () => {
    const p = entityPolyline(line("l1", 0, 0, 5, 0));
    expect(p).toEqual([new THREE.Vector2(0, 0), new THREE.Vector2(5, 0)]);
  });

  it("a rectangle's polyline repeats its first corner to close the loop", () => {
    const p = entityPolyline(rect("r1", 0, 0, 10, 4));
    expect(p).toHaveLength(5); // 4 corners + repeated first
    expect(p[0]).toEqual(p[4]);
  });

  it("a circle's polyline repeats its first sampled point to close the loop", () => {
    const p = entityPolyline(circle("c1", 0, 0, 3));
    expect(p[0]).toEqual(p[p.length - 1]);
    expect(p.length).toBeGreaterThan(3);
  });
});

describe("glyphRegion — a tessellated glyph face becomes an extrudable profile", () => {
  it("a square outer with a square hole yields a ring whose interior avoids the hole", () => {
    // 10×10 outer, 4×4 centered hole (like the counter of an 'O')
    const outer: [number, number][] = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const holes: [number, number][][] = [[[-2, -2], [2, -2], [2, 2], [-2, 2]]];
    const region = glyphRegion("s1", outer, holes);

    expect(region.sketchId).toBe("s1");
    expect(region.loop).toHaveLength(4);
    expect(region.holes).toHaveLength(1);
    // the selection anchor must sit in the material — inside the outer, outside the hole
    expect(pointInRegion(region.interior, region)).toBe(true);
    // a point in the counter (hole) is NOT part of the material
    expect(pointInRegion(new THREE.Vector2(0, 0), region)).toBe(false);
  });

  it("a solid glyph face (no holes) keeps its whole area", () => {
    const outer: [number, number][] = [[0, 0], [6, 0], [6, 4], [0, 4]];
    const region = glyphRegion("s1", outer, []);
    expect(region.holes).toHaveLength(0);
    expect(pointInRegion(new THREE.Vector2(3, 2), region)).toBe(true);
  });
});

describe("detectRegions — simple closed rectangle", () => {
  it("a single rectangle entity yields exactly one region with no holes", () => {
    const regions = detectRegions("s1", [rect("r1", 0, 0, 10, 6)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.holes).toHaveLength(0);
    // loop is the 4 rectangle corners (unclosed, no repeated last point)
    expect(regions[0]?.loop).toHaveLength(4);
  });

  it("a 4-line closed loop (chained by shared endpoints) also yields one region", () => {
    const entities = [
      line("l1", -5, -5, 5, -5),
      line("l2", 5, -5, 5, 5),
      line("l3", 5, 5, -5, 5),
      line("l4", -5, 5, -5, -5),
    ];
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.holes).toHaveLength(0);
  });

  it("an open 3-line chain (missing the closing side) yields no region", () => {
    const entities = [
      line("l1", -5, -5, 5, -5),
      line("l2", 5, -5, 5, 5),
      line("l3", 5, 5, -5, 5),
      // no l4 closing back to (-5, -5): the chain never closes
    ];
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(0);
  });
});

describe("detectRegions — circle-inside-rectangle hole handling", () => {
  // Non-crossing (circle entirely inside, not touching the rectangle boundary):
  // the fast path treats each as its own loop, then nests by containment —
  // a ring (rect w/ hole=circle) AND the disk (circle, no holes), per the code's
  // own comment at region.ts:131-132.
  const entities = [rect("r1", 0, 0, 20, 20), circle("c1", 0, 0, 3)];

  it("yields two regions: the outer ring (hole=circle) and the inner disk", () => {
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(2);
    const ring = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;
    expect(ring).toBeDefined();
    expect(disk).toBeDefined();
    expect(ring.holes).toHaveLength(1);
    expect(ring.loop).toHaveLength(4); // the rectangle
    expect(disk.loop.length).toBeGreaterThan(4); // the sampled circle
  });

  it("pointInRegion: material of the ring excludes the hole's interior", () => {
    const regions = detectRegions("s1", entities);
    const ring = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;

    // center of the circle: inside the disk, but excluded from the ring's material
    expect(pointInRegion(new THREE.Vector2(0, 0), disk)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(0, 0), ring)).toBe(false);

    // a point between the circle and the rectangle boundary: in the ring's
    // material, but outside the disk
    expect(pointInRegion(new THREE.Vector2(8, 8), ring)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(8, 8), disk)).toBe(false);

    // a point outside the rectangle entirely: in neither region
    expect(pointInRegion(new THREE.Vector2(100, 100), ring)).toBe(false);
    expect(pointInRegion(new THREE.Vector2(100, 100), disk)).toBe(false);
  });
});

describe("detectRegions — thin-ring interior anchor (field bug: outer ring selects inner circle)", () => {
  // Two concentric circles with a thin ring (inner_r/outer_r = 0.914 > 0.9), the
  // exact Test1.sindri geometry. The region's `interior` anchor MUST land in the
  // ring material — not in the hole. When it fell in the hole (0,0), selecting the
  // ring stored an anchor inside the disk, so the disk highlighted/extruded instead.
  it("the annulus anchor is inside its own material, not the hole", () => {
    const regions = detectRegions("s1", [circle("outer", 0, 0, 27.5), circle("inner", 0, 0, 25.123885645485018)]);
    expect(regions).toHaveLength(2);
    const annulus = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;
    // the anchor must be in the annulus material and NOT in the disk (the hole)
    expect(pointInRegion(annulus.interior, annulus)).toBe(true);
    expect(pointInRegion(annulus.interior, disk)).toBe(false);
  });
});

describe("detectRegions — projected reference geometry forms profiles", () => {
  const pline = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
    type: "projected", id,
    source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
    curve: { kind: "line", x1, y1, x2, y2 },
  });

  it("a square of 4 projected lines chains into one region", () => {
    const regions = detectRegions("s1", [
      pline("p1", 0, 0, 20, 0),
      pline("p2", 20, 0, 20, 20),
      pline("p3", 20, 20, 0, 20),
      pline("p4", 0, 20, 0, 0),
    ]);
    expect(regions).toHaveLength(1);
    expect(pointInRegion(new THREE.Vector2(10, 10), regions[0]!)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(30, 10), regions[0]!)).toBe(false);
  });

  it("a projected circle is its own closed loop (fast path, like a native circle)", () => {
    const pc: ResolvedEntity = {
      type: "projected", id: "pc",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "circle", x: 0, y: 0, r: 5 },
    };
    const regions = detectRegions("s1", [pc]);
    expect(regions).toHaveLength(1);
    expect(pointInRegion(new THREE.Vector2(0, 0), regions[0]!)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(6, 0), regions[0]!)).toBe(false);
  });

  it("a construction projected entity never forms a profile", () => {
    const pc: ResolvedEntity = {
      type: "projected", id: "pc",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "circle", x: 0, y: 0, r: 5 },
      construction: true,
    };
    expect(detectRegions("s1", [pc])).toHaveLength(0);
  });
});

// regionsByEntities is how a stored region reference is resolved once the sketch
// has moved: `interior` is a world point and stays behind (field a20cca53), and
// on a holed profile that stale point lands inside the HOLE (field 19314fdc).
// These run against the real tracer, so the id sets under test are the ones the
// tracer actually emits rather than hand-written stand-ins.
describe("regionsByEntities", () => {
  // 100x100 outer / 80x80 inner: two cells, the wall and the inner disk
  const shell = () =>
    detectRegions("s1", [rect("outer", 0, 0, 100, 100), rect("inner", 0, 0, 80, 80)]);

  it("names the WALL by its outer ids, not the cell the stale point would hit", () => {
    const hit = regionsByEntities(shell(), ["outer"], [["inner"]]);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.holes).toHaveLength(1);
  });

  it("the inner disk is a different reference entirely", () => {
    const hit = regionsByEntities(shell(), ["inner"]);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.holes).toHaveLength(0);
  });

  it("id ORDER does not matter — the tracer sorts, the fast path does not", () => {
    // a line across a square: both halves carry {sq, cut} in tracer order
    const regions = detectRegions("s1", [rect("sq", 0, 0, 100, 100), line("cut", -60, 0, 60, 0)]);
    expect(regionsByEntities(regions, ["cut", "sq"])).toHaveLength(2);
    expect(regionsByEntities(regions, ["sq", "cut"])).toHaveLength(2);
  });

  it("holes break a tie but never rule the only candidate out", () => {
    // the wall's holes really are [["inner"]]; claiming otherwise must NOT drop
    // it, because a legacy reference records no holes and one that does may have
    // had a hole added or removed since — and dropping it means falling back to
    // the stored point, which is the corruption.
    expect(regionsByEntities(shell(), ["outer"], [])).toHaveLength(1);
    expect(regionsByEntities(shell(), ["outer"], [["gone"]])).toHaveLength(1);
    expect(regionsByEntities(shell(), ["outer"], undefined)).toHaveLength(1);
  });

  it("hole ORDER does not matter — it follows loop discovery, not the document", () => {
    const regions = detectRegions("s1", [
      rect("outer", 0, 0, 100, 100),
      circle("a", -25, 0, 8),
      circle("b", 25, 0, 8),
    ]);
    const wall = regionsByEntities(regions, ["outer"], [["b"], ["a"]]);
    expect(wall).toHaveLength(1);
    expect(wall[0]!.holes).toHaveLength(2);
  });

  it("ids that name nothing live resolve to nothing (the sketch really changed)", () => {
    expect(regionsByEntities(shell(), ["deleted"])).toEqual([]);
    expect(regionsByEntities(shell(), [])).toEqual([]);
  });

  it("a SUBSET of a region's bounding ids is not a match", () => {
    // set equality, mirroring the sidecar's "these edges bound exactly one face":
    // a partial reference must fall back rather than resolve to a bigger cell.
    const regions = detectRegions("s1", [rect("sq", 0, 0, 100, 100), line("cut", -60, 0, 60, 0)]);
    expect(regionsByEntities(regions, ["sq"])).toEqual([]);
  });
});
