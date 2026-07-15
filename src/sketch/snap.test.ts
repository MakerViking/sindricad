import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { snap, candidatesFromEntities, type SnapCandidate } from "./snap";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const screen = (p: THREE.Vector2) => ({ x: p.x, y: p.y }); // 1px = 1 unit for the test

describe("snap", () => {
  const cands: SnapCandidate[] = [
    { p: v(10, 0), kind: "endpoint", priority: 100 },
    { p: v(10.3, 0), kind: "midpoint", priority: 80 },
  ];
  it("snaps to a candidate within pixel tolerance, higher priority winning", () => {
    const r = snap(v(10.2, 0), cands, screen, 1, 10);
    expect(r.kind).toBe("endpoint");
    expect(r.point.x).toBe(10);
  });
  it("falls back to the grid when no candidate is near", () => {
    const r = snap(v(4.9, 5.1), [], screen, 5, 10);
    expect(r.kind).toBe("grid");
    expect(r.point.x).toBe(5);
    expect(r.point.y).toBe(5);
  });
  it("returns the raw point (free) when grid snapping is off", () => {
    const r = snap(v(3.3, 7.7), [], screen, 0, 10);
    expect(r.kind).toBe("free");
    expect(r.point.x).toBeCloseTo(3.3);
  });
  it("returns free when a candidate exists but is beyond tolerance", () => {
    const r = snap(v(100, 100), cands, screen, 0, 10);
    expect(r.kind).toBe("free");
  });
});

describe("candidatesFromEntities", () => {
  it("emits endpoints + midpoint for a line", () => {
    const c = candidatesFromEntities([{ type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 }]);
    expect(c).toHaveLength(3);
    expect(c.find((x) => x.kind === "midpoint")!.p.x).toBe(5);
  });
  it("emits 4 corners + center + 4 edge midpoints for a rectangle", () => {
    const c = candidatesFromEntities([{ type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0 }]);
    expect(c.filter((x) => x.kind === "endpoint")).toHaveLength(4);
    expect(c.filter((x) => x.kind === "center")).toHaveLength(1);
    expect(c.filter((x) => x.kind === "midpoint")).toHaveLength(4);
  });
  it("emits the center for a circle and a strong point for a point", () => {
    expect(candidatesFromEntities([{ type: "circle", id: "c", radius: 5, x: 1, y: 2 }])[0]!.kind).toBe("center");
    const pt = candidatesFromEntities([{ type: "point", id: "p", x: 3, y: 4 }]);
    expect(pt[0]!.priority).toBe(110);
  });
  it("handles arc and spline fit points", () => {
    const arc = candidatesFromEntities([{ type: "arc", id: "a", x1: 0, y1: 0, x2: 4, y2: 0, mx: 2, my: 2 }]);
    expect(arc).toHaveLength(3);
    const sp = candidatesFromEntities([{ type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }] }]);
    expect(sp).toHaveLength(3);
  });
});
