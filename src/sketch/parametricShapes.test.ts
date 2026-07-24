import { describe, it, expect } from "vitest";
import { polygonPoints, slotOutline, entityPolyline } from "./region";
import { translated, rotated, scaled } from "./pattern";
import { toSketchEntity } from "./resolve";
import type { ResolvedEntity } from "./snap";

describe("polygonPoints", () => {
  it("gives `sides` vertices on the circumradius, first at `angle`", () => {
    const p = polygonPoints(0, 0, 10, 6, 0);
    expect(p).toHaveLength(6);
    expect(p[0]!.x).toBeCloseTo(10);
    expect(p[0]!.y).toBeCloseTo(0);
    for (const v of p) expect(Math.hypot(v.x, v.y)).toBeCloseTo(10);
  });
  it("clamps sides to a minimum of 3", () => {
    expect(polygonPoints(0, 0, 5, 2, 0)).toHaveLength(3);
  });
});

describe("slotOutline", () => {
  it("returns a closed outline whose points stay within width/2 of the axis", () => {
    const o = slotOutline(0, 0, 20, 0, 6); // horizontal axis, width 6 → cap radius 3
    expect(o.length).toBeGreaterThan(4);
    // every boundary point is within 3 (+eps) of the axis line y=0 over x∈[-3,23]
    for (const v of o) expect(Math.abs(v.y)).toBeLessThanOrEqual(3.001);
  });
});

describe("entityPolyline — parametric shapes", () => {
  it("closes a polygon loop", () => {
    const poly: ResolvedEntity = { type: "polygon", id: "p", x: 0, y: 0, radius: 10, sides: 5, angle: 0 };
    const loop = entityPolyline(poly);
    expect(loop.length).toBe(6); // 5 vertices + the closing repeat
    expect(loop[0]!.x).toBeCloseTo(loop[5]!.x);
    expect(loop[0]!.y).toBeCloseTo(loop[5]!.y);
  });
  it("produces a non-trivial closed loop for a slot", () => {
    const slot: ResolvedEntity = { type: "slot", id: "s", x1: 0, y1: 0, x2: 20, y2: 0, width: 6 };
    const loop = entityPolyline(slot);
    expect(loop.length).toBeGreaterThan(6);
  });
});

describe("transforms keep shapes parametric", () => {
  const poly: ResolvedEntity = { type: "polygon", id: "p", x: 1, y: 2, radius: 10, sides: 6, angle: 0.5 };
  const slot: ResolvedEntity = { type: "slot", id: "s", x1: 0, y1: 0, x2: 20, y2: 0, width: 6 };

  it("translated shifts position, preserves shape params", () => {
    const t = translated(poly, 5, -3, "p2") as Extract<ResolvedEntity, { type: "polygon" }>;
    expect(t.type).toBe("polygon");
    expect(t.x).toBe(6); expect(t.y).toBe(-1);
    expect(t.radius).toBe(10); expect(t.sides).toBe(6); expect(t.angle).toBe(0.5);
  });
  it("rotated adds to a polygon's angle and stays a polygon (no explode)", () => {
    const [r] = rotated(poly, 0, 0, Math.PI / 2, "p2") as [Extract<ResolvedEntity, { type: "polygon" }>];
    expect(r.type).toBe("polygon");
    expect(r.angle).toBeCloseTo(0.5 + Math.PI / 2);
  });
  it("scaled multiplies a polygon radius and a slot width", () => {
    const p = scaled(poly, 0, 0, 2, "p2") as Extract<ResolvedEntity, { type: "polygon" }>;
    expect(p.radius).toBe(20);
    const s = scaled(slot, 0, 0, 3, "s2") as Extract<ResolvedEntity, { type: "slot" }>;
    expect(s.width).toBe(18);
  });
});

describe("resolve round-trip", () => {
  it("serializes a resolved polygon/slot back to document entities", () => {
    const poly: ResolvedEntity = { type: "polygon", id: "p", x: 1, y: 2, radius: 10, sides: 6, angle: 0.5 };
    expect(toSketchEntity(poly)).toEqual({ type: "polygon", id: "p", x: 1, y: 2, radius: 10, sides: 6, angle: 0.5 });
    const slot: ResolvedEntity = { type: "slot", id: "s", x1: 0, y1: 0, x2: 20, y2: 0, width: 6 };
    expect(toSketchEntity(slot)).toEqual({ type: "slot", id: "s", x1: 0, y1: 0, x2: 20, y2: 0, width: 6 });
  });
});
