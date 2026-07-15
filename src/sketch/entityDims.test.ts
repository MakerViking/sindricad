import { describe, it, expect } from "vitest";
import { entityDims, dimensionSegments } from "./entityDims";
import type { ResolvedEntity } from "./snap";

describe("entityDims", () => {
  it("gives width + height for a rectangle, writable in place", () => {
    const e: ResolvedEntity = { type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0 };
    const dims = entityDims(e);
    expect(dims.map((d) => d.field)).toEqual(["width", "height"]);
    expect(dims[0]!.valueMm).toBe(20);
    expect(dims[1]!.valueMm).toBe(10);
    dims[0]!.write(30);
    expect(e.width).toBe(30);
  });
  it("gives diameter for a circle and writes back the radius", () => {
    const e: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0 };
    const [d] = entityDims(e);
    expect(d!.field).toBe("diameter");
    expect(d!.valueMm).toBe(10);
    d!.write(8);
    expect(e.radius).toBe(4);
  });
  it("gives length for a line and rescales the endpoint on write", () => {
    const e: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 3, y2: 4 };
    const [d] = entityDims(e);
    expect(d!.field).toBe("length");
    expect(d!.valueMm).toBeCloseTo(5);
    d!.write(10);
    expect(e.x2).toBeCloseTo(6);
    expect(e.y2).toBeCloseTo(8);
  });
  it("has no editable dimensions for arc/spline/point", () => {
    expect(entityDims({ type: "arc", id: "a", x1: 0, y1: 0, x2: 4, y2: 0, mx: 2, my: 2 })).toEqual([]);
    expect(entityDims({ type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toEqual([]);
    expect(entityDims({ type: "point", id: "p", x: 1, y: 1 })).toEqual([]);
  });
});

describe("dimensionSegments", () => {
  it("collects annotation segments and skips construction geometry", () => {
    const real: ResolvedEntity = { type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0 };
    const constr: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0, construction: true };
    const segs = dimensionSegments([real, constr]);
    expect(segs.length).toBeGreaterThan(0);
    // construction circle contributes nothing
    expect(dimensionSegments([constr])).toEqual([]);
  });
});
