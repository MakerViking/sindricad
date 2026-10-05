// A projected point in use (decision A7): once it has landed, it has to be
// something the sketch can work with, or projecting it was for nothing. A
// fixed point to snap to, to dimension from, to select and Break Link, drawn
// where it is, and never a profile edge.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { candidatesFromEntities, snap, snapCoincidences, type ResolvedEntity } from "./snap";
import { dimRefPoints, refPoint } from "./entityDims";
import { pickEntity } from "./modify";
import { entityInBox } from "./boxSelect";
import { detectRegions } from "./region";
import { pickDimTarget } from "./dimensionTool";
import { curveObjects } from "./overlay";
import { SketchPlane } from "./plane";

const PROJECTED_COLOR = 0xb07fe8; // overlay.ts
const PROJECTED_STALE_COLOR = 0xd9a24d;

const SRC = { kind: "sketchPoint", sketch: "s0", entity: "e0", pointIndex: 0 } as const;
const PT: ResolvedEntity = { type: "projected", id: "pt", source: SRC, curve: { kind: "point", x: 10, y: 5 } };
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });

describe("a projected point is a point the sketch can use", () => {
  it("is reference point 0, the index the solver pins", () => {
    expect(dimRefPoints(PT).map((r) => [r.p, r.pos.x, r.pos.y])).toEqual([[0, 10, 5]]);
    expect(refPoint(PT, 0)?.toArray()).toEqual([10, 5]);
  });

  it("snaps as strongly as a placed point, and a line drawn from it is joined to it", () => {
    const cands = candidatesFromEntities([PT]);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ kind: "endpoint", priority: 110, ref: { id: "pt", idx: 0 } });
    // the line tool's first click lands within snap reach of the point
    const hit = snap(new THREE.Vector2(10.2, 5.1), cands, (p) => ({ x: p.x * 10, y: p.y * 10 }), 0);
    expect(hit.ref).toEqual({ id: "pt", idx: 0 });
    const drawn = line("u", hit.point.x, hit.point.y, 30, 5);
    expect(snapCoincidences(drawn, hit.ref ?? null, null, [PT, drawn], [])).toEqual([
      { type: "coincident", e1: "pt", p1: 0, e2: "u", p2: 0 },
    ]);
  });

  it("is a point the Dimension tool can pick", () => {
    expect(pickDimTarget([PT], new THREE.Vector2(10.1, 5), 0.5)).toMatchObject({ kind: "point", p: 0, e: { id: "pt" } });
  });

  it("can be clicked to select it (for Delete and Break Link), and caught by a selection box", () => {
    expect(pickEntity([PT], new THREE.Vector2(10.2, 5), 0.5)).toBe(0);
    expect(pickEntity([PT], new THREE.Vector2(12, 5), 0.5)).toBe(-1);
    const box = (minx: number, maxx: number) => ({ min: new THREE.Vector2(minx, 0), max: new THREE.Vector2(maxx, 10), mode: "window" as const });
    expect(entityInBox(PT, box(5, 15))).toBe(true);
    expect(entityInBox(PT, box(11, 15))).toBe(false);
  });

  it("never closes or splits a profile", () => {
    const square = [line("a", 0, 0, 20, 0), line("b", 20, 0, 20, 20), line("c", 20, 20, 0, 20), line("d", 0, 20, 0, 0)];
    const without = detectRegions("s", square);
    const withPt = detectRegions("s", [...square, PT]);
    expect(without).toHaveLength(1);
    expect(withPt).toHaveLength(1);
    expect(withPt[0]!.loop.length).toBe(without[0]!.loop.length);
    expect(withPt[0]!.holes).toEqual([]);
    expect(withPt[0]!.entityIds, "the point became part of the square's boundary").toEqual(["a", "b", "c", "d"]);
  });

  it("is drawn as a point in the link colour, amber when its source is lost, and lit by a selection", () => {
    const plane = new SketchPlane("XY");
    const colorOf = (o: THREE.Object3D) => ((o as THREE.LineSegments).material as THREE.LineBasicMaterial).color.getHex();
    const [fresh, stale] = curveObjects([PT, { ...PT, id: "p2", stale: true }], plane, 0xffffff);
    expect((fresh as THREE.LineSegments).isLineSegments, "a projected point drew nothing you can see").toBe(true);
    expect(fresh!.userData.entityId).toBe("pt");
    expect(colorOf(fresh!)).toBe(PROJECTED_COLOR);
    expect(colorOf(stale!)).toBe(PROJECTED_STALE_COLOR);
    const [lit] = curveObjects([PT], plane, 0x33aaff, true);
    expect(colorOf(lit!)).toBe(0x33aaff);
  });
});
