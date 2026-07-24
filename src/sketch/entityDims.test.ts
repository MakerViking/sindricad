import { describe, it, expect } from "vitest";
import { entityDims, dimensionSegments, constraintDims } from "./entityDims";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

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

describe("constraintDims (radius + angle driving dims)", () => {
  it("renders a radius dim for a circle with a radial line", () => {
    const circle: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0 };
    const cons: SketchConstraint[] = [{ type: "radius", e: "c", value: 5 }];
    const dims = constraintDims([circle], cons);
    expect(dims.length).toBe(1);
    expect(dims[0]!.cIndex).toBe(0);
    expect(dims[0]!.valueMm).toBe(5);
    expect(dims[0]!.lines.length).toBe(1); // one radial line center→rim
    expect(dims[0]!.kind).toBeUndefined(); // radius is a length
  });

  it("renders a radius dim for an arc (via circumcenter)", () => {
    const arc: ResolvedEntity = { type: "arc", id: "a", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 };
    const cons: SketchConstraint[] = [{ type: "radius", e: "a", value: 5 }];
    const dims = constraintDims([arc], cons);
    expect(dims.length).toBe(1);
    expect(dims[0]!.valueMm).toBe(5);
  });

  it("renders an angle dim tagged kind='angle' with the value in degrees", () => {
    const l1: ResolvedEntity = { type: "line", id: "a", x1: 0, y1: 0, x2: 10, y2: 0 };
    const l2: ResolvedEntity = { type: "line", id: "b", x1: 0, y1: 0, x2: 0, y2: 10 };
    const cons: SketchConstraint[] = [{ type: "angle", l1: "a", l2: "b", value: 90 }];
    const dims = constraintDims([l1, l2], cons);
    expect(dims.length).toBe(1);
    expect(dims[0]!.kind).toBe("angle");
    expect(dims[0]!.valueMm).toBe(90);
  });

  it("skips a radius dim whose entity is missing", () => {
    const cons: SketchConstraint[] = [{ type: "radius", e: "gone", value: 3 }];
    expect(constraintDims([], cons)).toEqual([]);
  });
});
