// Which tessellated chord a circle/arc touch point gets cut into (region.ts's
// onThisChord). c576eca (0.1.248) started cutting touches from the TRUE curve,
// then handed each point to every chord whose span bracketed it: a straight
// edge's span by its parameter alone (no distance), a round chord's by a CCW-only
// angle. Both cut chords the point is nowhere near, each cut zig-zags the loop
// back to the point, and the fill fans triangles out from it. Field reports
// f40b90ca, 4d0a741e and 9dec2462 (a circle across a rectangle's edge, an arc
// across a spline) and 50429b0d (a mirrored pocket, whose arc runs clockwise).
//
// The oracle throughout is what the user sees: how many regions, how big each
// one is, and whether the fill the overlay triangulates (THREE.ShapeGeometry,
// exactly as overlay.ts's fillMesh builds it) covers the region's own area —
// a self-intersecting loop triangulates to far more than it encloses.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { detectRegions, entityPolyline, pointInRegion, type Region } from "./region";
import { resolveEntities } from "./resolve";
import type { ResolvedEntity } from "./snap";
import type { Feature } from "../types";
import fixtures from "./fixtures/regionTouchChords.json";

type Sketch = Extract<Feature, { type: "sketch" }>;

const shoelace = (pts: readonly THREE.Vector2[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** the material area: outer loop minus its holes */
const regionArea = (r: Region) => shoelace(r.loop) - r.holes.reduce((s, h) => s + shoelace(h), 0);

/** the area the overlay's fill mesh actually covers */
function fillArea(r: Region): number {
  const shape = new THREE.Shape(r.loop.map((p) => p.clone()));
  for (const h of r.holes) shape.holes.push(new THREE.Path(h.map((p) => p.clone())));
  const geo = new THREE.ShapeGeometry(shape);
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex()!;
  const at = (i: number) => new THREE.Vector2(pos.getX(i), pos.getY(i));
  let a = 0;
  for (let i = 0; i < idx.count; i += 3)
    a += Math.abs(THREE.ShapeUtils.area([at(idx.getX(i)), at(idx.getX(i + 1)), at(idx.getX(i + 2))]));
  geo.dispose();
  return a;
}

function expectFillsMatch(regions: Region[]) {
  for (const r of regions) {
    const area = regionArea(r);
    // earcut drops a sliver here and there (measured up to 1.4e-5 mm²); the
    // bug this guards against overfilled by whole multiples of the region
    const off = Math.abs(fillArea(r) - area);
    expect(off, `fill of [${r.entityIds.join(",")}] (area ${area.toFixed(3)}) off by`).toBeLessThan(1e-4 + 1e-6 * area);
  }
}

const sortedAreas = (regions: Region[]) => regions.map(regionArea).sort((a, b) => a - b);

const reporterRegions = (id: keyof typeof fixtures) =>
  detectRegions(id, resolveEntities(fixtures[id] as unknown as Sketch, {}));

// Each reporter's sketch (feature f1, entities only, copied from their document).
// The pinned areas were measured on the fixed tracer; what makes them trustworthy
// is not the pin but the oracles beside it: every fill equals its region, no two
// regions overlap, and the mirrored pocket equals the original one.
describe("detectRegions — the reporters' sketches triangulate exactly", () => {
  const cases: [keyof typeof fixtures, number[]][] = [
    ["f40b90ca", [1.514, 1.514, 24.953, 24.953, 26.466, 26.466, 78.414, 156.003, 231.086, 233.593, 252.719, 457.737, 542.217, 554.945, 579.402, 776.588, 795.023, 800, 1176.251, 1384.78, 3468.099, 6334.142, 1712755.871]],
    // 23.526 and 528.716 were MISSING until the half-edge angles were made
    // canonical (region.ts canonAngle, field 652c7ea5): 23.526 is the larger
    // part of circle e253 that line e247 cuts (2.98 + 23.53 = the whole 26.51
    // disc; only the small part was found), 528.716 the cell beside it.
    ["4d0a741e", [2.942, 3.008, 5.597, 7.913, 18.555, 23.459, 23.526, 26.466, 41.171, 78.414, 156.003, 180.287, 227.997, 231.086, 252.719, 457.737, 528.716, 579.402, 629.204, 748.254, 776.588, 800, 1176.251, 1384.78, 3468.099, 6334.142, 1712755.871]],
    ["50429b0d", [28.229, 28.229, 115.085, 115.085, 1246.009, 4978.373]],
    // three circles tangent to a trapezoid's top and to a fourth circle, the
    // solver leaving one edge end 3e-10 below zero: 3 of 7 profiles until the
    // half-edge angles were made canonical (region.ts canonAngle)
    ["652c7ea5", [15.974, 15.974, 78.414, 78.414, 78.414, 98.02, 2000]],
    ["9dec2462", [1.514, 1.514, 24.953, 24.953, 26.466, 26.466, 78.414, 156.003, 231.086, 233.593, 252.719, 457.737, 542.217, 554.945, 579.402, 776.588, 795.023, 800, 1176.251, 1384.78, 3468.099, 6334.142, 1712755.871]],
  ];

  for (const [id, areas] of cases) {
    it(`${id}: every region's fill covers exactly the region`, () => {
      expectFillsMatch(reporterRegions(id));
    });

    it(`${id}: ${areas.length} regions, each the expected size`, () => {
      const got = sortedAreas(reporterRegions(id));
      expect(got).toHaveLength(areas.length);
      got.forEach((a, i) => expect(a, `region ${i} by size`).toBeCloseTo(areas[i]!, 2));
    });

    it(`${id}: no point of the sketch lies in two regions`, () => {
      const regions = reporterRegions(id);
      let overlaps = 0;
      const N = 300; // a 300x300 grid over the busy part of the sketch, 1.33 mm apart
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          const p = new THREE.Vector2(-200 + (400 * (i + 0.5)) / N, -200 + (400 * (j + 0.5)) / N);
          if (regions.filter((r) => pointInRegion(p, r)).length > 1) overlaps++;
        }
      expect(overlaps).toBe(0);
    });
  }

  it("50429b0d: the mirrored corner pocket is a region of its own, the same size as the original", () => {
    const regions = reporterRegions("50429b0d");
    const pocket = (ids: string[]) =>
      regions.find((r) => [...r.entityIds].sort().join(",") === [...ids].sort().join(","));
    const original = pocket(["e7", "e14", "e16", "e17"]);
    const mirrored = pocket(["e7", "e19", "e20", "e21"]);
    expect(original, "the original pocket").toBeDefined();
    expect(mirrored, "the mirrored pocket").toBeDefined();
    expect(mirrored!.holes).toHaveLength(1); // its own hole circle e18
    expect(regionArea(mirrored!)).toBeCloseTo(regionArea(original!), 6);
  });
});

const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity =>
  ({ type: "rectangle", id, x, y, width, height });
const circle = (id: string, x: number, y: number, radius: number): ResolvedEntity =>
  ({ type: "circle", id, x, y, radius });
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });

describe("detectRegions — a touch point is cut only into the chord it lies on", () => {
  it("a circle across a rectangle's left edge cuts that edge only: three clean cells", () => {
    const box = rect("r", 0, 0, 40, 20); // x from -20 to 20
    // crosses x=-20 at 113.6 degrees round the circle, off every 64-gon vertex
    const hole = circle("c", -18, 3, 5);
    const regions = detectRegions("s", [box, hole]);
    expect(regions).toHaveLength(3);
    expectFillsMatch(regions);
    // the two cells inside the rectangle are the rectangle, exactly
    const inside = regions.filter((r) => r.interior.x > -20);
    expect(inside).toHaveLength(2);
    expect(inside.reduce((s, r) => s + regionArea(r), 0)).toBeCloseTo(800, 6);
    // and the circle's two pieces are its 64-gon, give or take the two cut
    // points, which sit on the true circle a sagitta outside it
    const disk = shoelace(entityPolyline(hole).slice(0, -1));
    expect(sortedAreas(regions).slice(0, 2).reduce((s, a) => s + a, 0)).toBeCloseTo(disk, 2);
  });

  it("an arc across a closed spline splits it into two clean cells", () => {
    const oval: ResolvedEntity = {
      type: "spline", id: "s", closed: true,
      points: [{ x: -20, y: 0 }, { x: 0, y: -15 }, { x: 20, y: 0 }, { x: 0, y: 15 }],
    };
    const cut: ResolvedEntity = { type: "arc", id: "a", x1: -10, y1: -30, x2: -10, y2: 30, mx: 5, my: 0 };
    const regions = detectRegions("s", [oval, cut]);
    expect(regions).toHaveLength(2);
    expectFillsMatch(regions);
    const whole = shoelace(entityPolyline(oval).slice(0, -1));
    expect(regions.reduce((s, r) => s + regionArea(r), 0)).toBeCloseTo(whole, 6);
  });

  it("a clockwise arc (what Mirror makes) closes the same wedge as the counter-clockwise one", () => {
    // c576eca's own case (field 44177174): a line from an arc's start out to a
    // point ON the arc at 37 degrees, off every tessellation vertex. Mirror
    // flips an arc's winding, so the same arc stored end-first runs CLOCKWISE.
    const d2r = Math.PI / 180;
    const p = { x: 20 * Math.cos(37 * d2r), y: 20 * Math.sin(37 * d2r) };
    const m = 20 * Math.SQRT1_2;
    const ccw: ResolvedEntity = { type: "arc", id: "a", x1: 20, y1: 0, x2: 0, y2: 20, mx: m, my: m };
    const cw: ResolvedEntity = { type: "arc", id: "a", x1: 0, y1: 20, x2: 20, y2: 0, mx: m, my: m };
    const chord = line("l", 20, 0, p.x, p.y);
    const forward = detectRegions("s", [ccw, chord]);
    const backward = detectRegions("s", [cw, chord]);
    expect(backward).toHaveLength(forward.length);
    expectFillsMatch(backward);
    expect(sortedAreas(backward).map((a) => a.toFixed(6))).toEqual(sortedAreas(forward).map((a) => a.toFixed(6)));
  });

  it("a mirrored pocket: a clockwise arc touching a rectangle edge and two lines", () => {
    // the 50429b0d shape, reduced: inside a 40x40 box, a line down from the top
    // edge, a quarter arc, and a line out to the right edge cut off a corner pocket.
    // Built once as drawn (CCW arc) and once as Mirror leaves it (CW arc).
    const box = rect("b", 0, 0, 40, 40); // corners at +-20
    const down = line("d", 5, 20, 5, 10);
    const out = line("o", 10, 5, 20, 5);
    const arc = (cw: boolean): ResolvedEntity => {
      const c = { x: 10, y: 10 }, r = 5, mid = { x: c.x - r * Math.SQRT1_2, y: c.y - r * Math.SQRT1_2 };
      return cw
        ? { type: "arc", id: "a", x1: 10, y1: 5, x2: 5, y2: 10, mx: mid.x, my: mid.y }
        : { type: "arc", id: "a", x1: 5, y1: 10, x2: 10, y2: 5, mx: mid.x, my: mid.y };
    };
    for (const cw of [false, true]) {
      const regions = detectRegions("s", [box, down, out, arc(cw)]);
      expect(regions, cw ? "clockwise" : "counter-clockwise").toHaveLength(2);
      expectFillsMatch(regions);
      expect(regions.reduce((s, r) => s + regionArea(r), 0)).toBeCloseTo(1600, 6);
    }
  });
});

describe("detectRegions — a tangent touch across the +/-PI seam (field 652c7ea5)", () => {
  // A circle resting on a line, the line's left half sloping down by 3e-10 so
  // its leftward chord reads atan2 = -PI while the circle's tangent there reads
  // +PI: before canonAngle the two never tied, the order around the touch node
  // was wrong, and the circle's own disc was not traced at all.
  const sketch = (dy: number): ResolvedEntity[] => [
    line("l0", -30, dy, 0, 0), line("l1", 0, 0, 30, 0),
    line("l2", 30, 0, 30, -10), line("l3", 30, -10, -30, -10), line("l4", -30, -10, -30, dy),
    circle("c", -12, 5, 5),
  ];
  for (const dy of [0, -3e-10, 3e-10]) {
    it(`the disc and the box are both profiles, left end ${dy}`, () => {
      const areas = detectRegions("s", sketch(dy)).map((r) => regionArea(r)).sort((a, b) => a - b);
      expect(areas).toHaveLength(2);
      expect(areas[0]).toBeCloseTo(Math.PI * 25, 0);
      expect(areas[1]).toBeCloseTo(600, 2);
    });
  }
});
