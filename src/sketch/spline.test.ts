import { describe, it, expect } from "vitest";
import { splinePolyline } from "./spline";

describe("splinePolyline", () => {
  it("returns the points unchanged for <2 points", () => {
    expect(splinePolyline([])).toHaveLength(0);
    const one = splinePolyline([{ x: 1, y: 2 }]);
    expect(one).toHaveLength(1);
    expect(one[0]!.x).toBe(1);
  });
  it("is a straight segment for exactly two points", () => {
    const p = splinePolyline([{ x: 0, y: 0 }, { x: 10, y: 5 }]);
    expect(p).toHaveLength(2);
    expect(p[1]!.x).toBe(10);
    expect(p[1]!.y).toBe(5);
  });
  it("interpolates through every fit point", () => {
    const fit = [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 12, y: 2 }, { x: 18, y: 9 }];
    const poly = splinePolyline(fit, 10);
    // endpoints are exact fit points
    expect(poly[0]!.x).toBeCloseTo(0);
    expect(poly[0]!.y).toBeCloseTo(0);
    expect(poly.at(-1)!.x).toBeCloseTo(18);
    expect(poly.at(-1)!.y).toBeCloseTo(9);
    // Catmull-Rom passes through the interior fit points too
    const hitsMid = poly.some((p) => Math.abs(p.x - 5) < 1e-6 && Math.abs(p.y - 8) < 1e-6);
    expect(hitsMid).toBe(true);
  });
  it("emits segsPerSpan samples per leg plus the closing point", () => {
    const fit = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    expect(splinePolyline(fit, 4)).toHaveLength((fit.length - 1) * 4 + 1);
  });
});
