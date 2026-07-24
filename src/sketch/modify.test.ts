import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { trimEntity, breakAt, extendLine, chamferCorner, offsetEntity } from "./modify";
import type { ResolvedEntity } from "./snap";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const arcRadius = (a: any) => {
  const ax = a.x1, ay = a.y1, bx = a.x2, by = a.y2, cx = a.mx, cy = a.my;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return Math.hypot(ax - ux, ay - uy);
};

describe("chamferCorner", () => {
  it("bevels two perpendicular lines, keeping their ids", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
    ];
    const out = chamferCorner(ents, 0, 1, 2)!;
    expect(out).not.toBeNull();
    const lines = out.filter((e) => e.type === "line");
    expect(lines.length).toBe(3); // A, B, bevel
    const A = out.find((e) => e.id === "A") as any, B = out.find((e) => e.id === "B") as any;
    expect(A.x2).toBeCloseTo(8); expect(A.y2).toBeCloseTo(0);          // shortened to setback
    expect(B.x2).toBeCloseTo(10); expect(B.y2).toBeCloseTo(2);
    const bevel = lines.find((e) => e.id !== "A" && e.id !== "B") as any;
    expect(bevel.x1).toBeCloseTo(8); expect(bevel.y1).toBeCloseTo(0);
    expect(bevel.x2).toBeCloseTo(10); expect(bevel.y2).toBeCloseTo(2);
  });
  it("returns null for parallel lines", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    expect(chamferCorner(ents, 0, 1, 2)).toBeNull();
  });
});

describe("trimEntity — arcs & circles", () => {
  it("trims a circle to the complementary arc", () => {
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "c", x: 0, y: 0, radius: 5 },
      { type: "line", id: "v", x1: 0, y1: -10, x2: 0, y2: 10 }, // crosses at (0,±5)
    ];
    const out = trimEntity(ents, 0, v(5, 0)); // click the right half
    expect(out.find((e) => e.type === "circle")).toBeUndefined();
    const arcs = out.filter((e) => e.type === "arc") as any[];
    expect(arcs.length).toBe(1);
    expect(arcs[0].mx).toBeCloseTo(-5, 1); // kept the LEFT half (mid at (-5,0))
    expect(arcs[0].my).toBeCloseTo(0, 1);
  });
  it("trims the middle span of an arc into two arcs", () => {
    const ents: ResolvedEntity[] = [
      { type: "arc", id: "a", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 }, // upper half
      { type: "line", id: "l1", x1: 2.5, y1: -10, x2: 2.5, y2: 10 },
      { type: "line", id: "l2", x1: -2.5, y1: -10, x2: -2.5, y2: 10 },
    ];
    const out = trimEntity(ents, 0, v(0, 5)); // click the top-middle span
    expect(out.filter((e) => e.type === "arc").length).toBe(2);
  });
  it("deletes a circle with no crossings", () => {
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", x: 0, y: 0, radius: 5 }];
    expect(trimEntity(ents, 0, v(5, 0))).toEqual([]);
  });
});

describe("breakAt — arcs & circles", () => {
  it("splits an arc into two arcs", () => {
    const ents: ResolvedEntity[] = [{ type: "arc", id: "a", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 }];
    const out = breakAt(ents, 0, v(0, 5));
    expect(out.filter((e) => e.type === "arc").length).toBe(2);
  });
  it("opens a circle into a single arc", () => {
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", x: 0, y: 0, radius: 5 }];
    const out = breakAt(ents, 0, v(5, 0));
    expect(out.find((e) => e.type === "circle")).toBeUndefined();
    expect(out.filter((e) => e.type === "arc").length).toBe(1);
  });
});

describe("extendLine — arcs", () => {
  it("grows an arc's end to the nearest crossing", () => {
    const ents: ResolvedEntity[] = [
      { type: "arc", id: "a", x1: 5, y1: 0, x2: 0, y2: 5, mx: 3.5355, my: 3.5355 }, // quarter 0→90°
      { type: "line", id: "l", x1: -10, y1: 3.5, x2: 0, y2: 3.5 }, // crosses circle at ~135°
    ];
    const out = extendLine(ents, 0, v(0, 5))!; // click near the (0,5) end
    expect(out).not.toBeNull();
    const a = out.find((e) => e.id === "a") as any;
    expect(a.x2).toBeLessThan(0); // end swept past 90° toward ~135°
    expect(arcRadius(a)).toBeCloseTo(5, 1); // radius preserved
  });
});

describe("offsetEntity — arc", () => {
  it("offsets an arc concentrically (radius grows by dist)", () => {
    const ents: ResolvedEntity[] = [{ type: "arc", id: "a", x1: 5, y1: 0, x2: 0, y2: 5, mx: 3.5355, my: 3.5355 }];
    const out = offsetEntity(ents, 0, 3)!;
    expect(out.length).toBe(2);
    expect(arcRadius(out[1])).toBeCloseTo(8, 1);
  });
});
