import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { lineIntersect, segIntersect, segCircleIntersect, paramOnSeg, distToSeg } from "./geom2d";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

describe("lineIntersect", () => {
  it("crosses two infinite lines", () => {
    const p = lineIntersect(v(0, 0), v(10, 10), v(0, 10), v(10, 0));
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(5);
    expect(p!.y).toBeCloseTo(5);
  });
  it("returns null for parallel lines", () => {
    expect(lineIntersect(v(0, 0), v(10, 0), v(0, 5), v(10, 5))).toBeNull();
  });
  it("intersects even where segments would not reach", () => {
    const p = lineIntersect(v(0, 0), v(1, 1), v(0, 10), v(1, 9));
    expect(p!.x).toBeCloseTo(5);
    expect(p!.y).toBeCloseTo(5);
  });
});

describe("segIntersect", () => {
  it("crosses two overlapping segments", () => {
    const p = segIntersect(v(0, 0), v(10, 10), v(0, 10), v(10, 0));
    expect(p!.x).toBeCloseTo(5);
  });
  it("returns null when the crossing is outside the segments", () => {
    expect(segIntersect(v(0, 0), v(1, 1), v(0, 10), v(1, 9))).toBeNull();
  });
  it("returns null for parallel segments", () => {
    expect(segIntersect(v(0, 0), v(10, 0), v(0, 5), v(10, 5))).toBeNull();
  });
});

describe("segCircleIntersect", () => {
  it("finds both crossings of a chord", () => {
    const hits = segCircleIntersect(v(-10, 0), v(10, 0), v(0, 0), 5);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.x).sort((a, b) => a - b)).toEqual([expect.closeTo(-5), expect.closeTo(5)]);
  });
  it("returns [] when the segment misses the circle", () => {
    expect(segCircleIntersect(v(-10, 20), v(10, 20), v(0, 0), 5)).toEqual([]);
  });
  it("returns [] for a degenerate zero-length segment", () => {
    expect(segCircleIntersect(v(0, 0), v(0, 0), v(0, 0), 5)).toEqual([]);
  });
  it("clips crossings outside the segment span", () => {
    // segment only reaches the +x crossing, not the -x one
    const hits = segCircleIntersect(v(0, 0), v(10, 0), v(0, 0), 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.x).toBeCloseTo(5);
  });
});

describe("paramOnSeg / distToSeg", () => {
  it("paramOnSeg gives 0.5 at the midpoint and >1 beyond the end", () => {
    expect(paramOnSeg(v(0, 0), v(10, 0), v(5, 3))).toBeCloseTo(0.5);
    expect(paramOnSeg(v(0, 0), v(10, 0), v(20, 0))).toBeCloseTo(2);
  });
  it("distToSeg is the perpendicular distance inside the span", () => {
    expect(distToSeg(v(0, 0), v(10, 0), v(5, 4))).toBeCloseTo(4);
  });
  it("distToSeg clamps to the nearest endpoint beyond the span", () => {
    expect(distToSeg(v(0, 0), v(10, 0), v(13, 4))).toBeCloseTo(5);
  });
});
