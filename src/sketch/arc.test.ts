import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { circumcenter, arcRadius, arcPolyline } from "./arc";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

describe("circumcenter", () => {
  it("finds the center of three points on a known circle", () => {
    // points on the unit circle centered at (3, 4)
    const c = circumcenter({ x: 4, y: 4 }, { x: 3, y: 5 }, { x: 2, y: 4 });
    expect(c).not.toBeNull();
    expect(c!.x).toBeCloseTo(3);
    expect(c!.y).toBeCloseTo(4);
  });
  it("returns null for collinear points", () => {
    expect(circumcenter({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
  });
});

describe("arcRadius", () => {
  it("recovers the radius", () => {
    expect(arcRadius(v(4, 4), v(2, 4), v(3, 5))).toBeCloseTo(1);
  });
  it("is 0 for a degenerate (collinear) arc", () => {
    expect(arcRadius(v(0, 0), v(2, 2), v(1, 1))).toBe(0);
  });
});

describe("arcPolyline", () => {
  it("returns n+1 points all on the circle", () => {
    const pts = arcPolyline(v(4, 4), v(2, 4), v(3, 5), 12);
    expect(pts).toHaveLength(13);
    for (const p of pts) expect(p.distanceTo(v(3, 4))).toBeCloseTo(1);
  });
  it("keeps the exact start and end points", () => {
    const pts = arcPolyline(v(4, 4), v(2, 4), v(3, 5), 8);
    expect(pts[0]!.x).toBeCloseTo(4);
    expect(pts[0]!.y).toBeCloseTo(4);
    expect(pts.at(-1)!.x).toBeCloseTo(2);
    expect(pts.at(-1)!.y).toBeCloseTo(4);
  });
  it("degenerates to a straight two-point line when collinear", () => {
    const pts = arcPolyline(v(0, 0), v(2, 0), v(1, 0), 8);
    expect(pts).toHaveLength(2);
  });
});
