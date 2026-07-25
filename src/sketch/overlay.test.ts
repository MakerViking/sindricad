// Rendering contract for projected (linked) reference geometry: the ONE
// curveObjects factory feeds BOTH display paths — the open sketch's active
// curves and the committed model overlay — so asserting its material colors
// here covers stale/link rendering end to end (the stale FLAG's propagation
// into doc entities is covered by the step-4 refresh e2e).
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { curveObjects } from "./overlay";
import { SketchPlane } from "./plane";
import type { ResolvedEntity } from "./snap";

const PROJECTED_COLOR = 0xb07fe8; // purple link color (overlay.ts)
const PROJECTED_STALE_COLOR = 0xd9a24d; // amber: source no longer resolves

const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const matColor = (o: THREE.Object3D): number => {
  // one object per entity; circles/arcs are a group of curve + center marker
  const line = (o as THREE.Group).isGroup ? (o as THREE.Group).children[0] : o;
  return ((line as THREE.Line).material as THREE.LineBasicMaterial).color.getHex();
};

describe("curveObjects — projected link colors", () => {
  const plane = new SketchPlane("XY");
  const fresh: ResolvedEntity = {
    type: "projected", id: "p1", source: SRC, curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
  };
  const stale: ResolvedEntity = { ...fresh, id: "p2", stale: true };

  it("fresh projected renders purple, stale renders amber — regardless of pass color", () => {
    const objs = curveObjects([fresh, stale], plane, 0xffffff);
    expect(objs).toHaveLength(2);
    expect(matColor(objs[0]!)).toBe(PROJECTED_COLOR);
    expect(matColor(objs[1]!)).toBe(PROJECTED_STALE_COLOR);
  });

  it("selection/hover emphasis (highlight) wins over the link color", () => {
    const objs = curveObjects([stale], plane, 0x33aaff, true);
    expect(matColor(objs[0]!)).toBe(0x33aaff);
  });

  it("a broken (now native) line renders in the pass color again", () => {
    const native: ResolvedEntity = { type: "line", id: "p1", x1: 0, y1: 0, x2: 10, y2: 0 };
    const objs = curveObjects([native], plane, 0xffffff);
    expect(matColor(objs[0]!)).toBe(0xffffff);
  });
});
