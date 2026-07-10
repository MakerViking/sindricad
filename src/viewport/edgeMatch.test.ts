import { describe, it, expect } from "vitest";
import { polylineMid, nearestEdgeByMid, toggleSelectorByMid, midMatchTol, type Vec3 } from "./edgeMatch";

const line = (a: Vec3, b: Vec3, n = 5): { points: Vec3[] } => {
  const points: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return { points };
};

describe("polylineMid", () => {
  it("uses the index-middle sample (picking.ts convention)", () => {
    const pts: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
    expect(polylineMid(pts)).toEqual([2, 0, 0]); // floor(4/2) = index 2
  });
});

describe("nearestEdgeByMid", () => {
  const edges = [line([0, 0, 0], [10, 0, 0]), line([0, 5, 0], [10, 5, 0]), line([0, 0, 8], [10, 0, 8])];
  it("finds the exact edge", () => {
    expect(nearestEdgeByMid(edges, [5, 0, 0], 0.5)).toBe(0);
  });
  it("finds a near-within-tolerance edge", () => {
    expect(nearestEdgeByMid(edges, [5.2, 4.9, 0.1], 0.5)).toBe(1);
  });
  it("returns null on a miss", () => {
    expect(nearestEdgeByMid(edges, [5, 2.5, 4], 0.5)).toBe(null);
  });
  it("resolves ties/nearness to the closest candidate", () => {
    expect(nearestEdgeByMid(edges, [5, 1, 1], 10)).toBe(0); // all within tol; edge 0 closest
  });
  it("handles an empty edge list", () => {
    expect(nearestEdgeByMid([], [0, 0, 0], 1)).toBe(null);
  });
});

describe("toggleSelectorByMid", () => {
  it("adds then removes round-trip", () => {
    const s0: { kind: string; by: string; point: number[] }[] = [];
    const s1 = toggleSelectorByMid(s0, [5, 0, 0], 0.5);
    expect(s1).toHaveLength(1);
    expect(s1[0]).toEqual({ kind: "edge", by: "nearest", point: [5, 0, 0] });
    const s2 = toggleSelectorByMid(s1 as { point?: number[] }[], [5.1, 0, 0.1], 0.5);
    expect(s2).toHaveLength(0);
    expect(s1).toHaveLength(1); // input untouched
  });
  it("ignores selectors without a point (never removes them)", () => {
    const sels = [{ kind: "edge", by: "axis", axis: "Z" } as { point?: number[] }];
    const out = toggleSelectorByMid(sels, [0, 0, 0], 1);
    expect(out).toHaveLength(2); // axis selector kept, nearest appended
  });
});

describe("midMatchTol", () => {
  it("floors at 0.5 and scales with the model", () => {
    expect(midMatchTol(10)).toBe(0.5);
    expect(midMatchTol(1000)).toBe(5);
  });
});
