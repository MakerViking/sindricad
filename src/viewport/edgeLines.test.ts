// Phase A.2 regression: merged per-body edges.
//
// Every B-rep edge used to be its own Line2 with its own LineMaterial (~348,000
// of each on an imported assembly). They are now one LineSegments2 per body with
// ONE shared material, and an edge is identified by a stable EdgeRef.
//
// The contracts worth pinning are the ones the type system cannot check:
//  - a raycast segment index maps back to the right edge (picking)
//  - hiding an edge removes its segments AND keeps every other edge's mapping
//  - a reused body does not inherit the previous model's seam hiding
//  - colour survives a geometry rebuild
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { BodyEdges, EDGE_IDLE_COLOR } from "./edgeLines";
import type { RebuildResult } from "../types";

const RES = new THREE.Vector2(800, 600);

/** Three edges with 1, 2 and 3 segments respectively (points - 1). */
function threeEdges(): RebuildResult["edges"] {
  return [
    { id: "e0", body: "b", points: [[0, 0, 0], [1, 0, 0]] },
    { id: "e1", body: "b", points: [[0, 1, 0], [1, 1, 0], [2, 1, 0]] },
    { id: "e2", body: "b", points: [[0, 2, 0], [1, 2, 0], [2, 2, 0], [3, 2, 0]] },
  ];
}

const segCount = (be: BodyEdges) =>
  (be.object.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).count;

/** The instance colour of segment `s`, at its start vertex. Rounded because the
 *  buffer is Float32 and THREE.Color components are doubles. */
function segColor(be: BodyEdges, s: number): [number, number, number] {
  const attr = be.object.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute;
  const a = attr.data.array;
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r6(a[s * 6]!), r6(a[s * 6 + 1]!), r6(a[s * 6 + 2]!)];
}

/** Same rounding, applied to a THREE.Color, so the two are comparable. */
function rgbOf(c: THREE.Color): [number, number, number] {
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r6(c.r), r6(c.g), r6(c.b)];
}

describe("BodyEdges", () => {
  it("merges every edge into ONE object with ONE material", () => {
    const be = new BodyEdges(threeEdges(), RES);
    expect(be.refs.length).toBe(3);
    expect(segCount(be)).toBe(1 + 2 + 3);
    // the whole point: one material for the body, not one per edge
    expect(be.object.material).toBe(be.material);
  });

  it("maps every segment index back to the edge that owns it", () => {
    const be = new BodyEdges(threeEdges(), RES);
    // segments 0 | 1,2 | 3,4,5
    expect(be.refAtSegment(0)?.id).toBe("e0");
    expect(be.refAtSegment(1)?.id).toBe("e1");
    expect(be.refAtSegment(2)?.id).toBe("e1");
    expect(be.refAtSegment(3)?.id).toBe("e2");
    expect(be.refAtSegment(5)?.id).toBe("e2");
    expect(be.refAtSegment(6)).toBeUndefined(); // past the end
    expect(be.refAtSegment(-1)).toBeUndefined();
  });

  it("carries each edge's points and body on the ref", () => {
    const be = new BodyEdges(threeEdges(), RES);
    expect(be.refs[1]!.points).toEqual([[0, 1, 0], [1, 1, 0], [2, 1, 0]]);
    expect(be.refs[1]!.body).toBe("b");
  });

  it("colours only the segments of the edge asked for", () => {
    const be = new BodyEdges(threeEdges(), RES);
    const red = new THREE.Color(1, 0, 0);
    be.setColor(1, red); // e1 -> segments 1,2
    expect(segColor(be, 1)).toEqual([1, 0, 0]);
    expect(segColor(be, 2)).toEqual([1, 0, 0]);
    const base = new THREE.Color(EDGE_IDLE_COLOR);
    expect(segColor(be, 0)).toEqual(rgbOf(base));
    expect(segColor(be, 3)).toEqual(rgbOf(base));
  });

  it("drops a hidden edge's segments and keeps the others mapped correctly", () => {
    const be = new BodyEdges(threeEdges(), RES);
    be.setHidden(1, true); // hide e1 (2 segments)
    be.flush();
    expect(segCount(be)).toBe(1 + 3);
    // e2 has moved down to segments 1..3 — the mapping must follow it
    expect(be.refAtSegment(0)?.id).toBe("e0");
    expect(be.refAtSegment(1)?.id).toBe("e2");
    expect(be.refAtSegment(3)?.id).toBe("e2");
    expect(be.visibleRefs().map((r) => r.id)).toEqual(["e0", "e2"]);
  });

  it("keeps each edge's colour across a hide-driven rebuild", () => {
    const be = new BodyEdges(threeEdges(), RES);
    be.setColor(2, new THREE.Color(0, 1, 0)); // e2 green
    be.setHidden(0, true);
    be.flush();
    // e2 now starts at segment 2 (e1's two segments come first)
    expect(be.refAtSegment(2)?.id).toBe("e2");
    expect(segColor(be, 2)).toEqual([0, 1, 0]);
  });

  it("colours a hidden edge without error, and shows it on unhide", () => {
    const be = new BodyEdges(threeEdges(), RES);
    be.setHidden(1, true);
    be.flush();
    be.setColor(1, new THREE.Color(1, 0, 1)); // hidden: no segments to write
    be.showAll();
    be.flush();
    expect(segCount(be)).toBe(6);
    expect(segColor(be, 1)).toEqual([1, 0, 1]);
  });

  it("showAll clears inherited hiding — a reused body must not keep old seams", () => {
    const be = new BodyEdges(threeEdges(), RES);
    be.setHidden(0, true);
    be.setHidden(2, true);
    be.flush();
    expect(segCount(be)).toBe(2);
    be.resetAppearance(); // what a reused body gets on rebuild
    be.flush();
    expect(segCount(be)).toBe(6);
    expect(be.visibleRefs().length).toBe(3);
  });

  it("is not pickable when the body is hidden or every edge is hidden", () => {
    const be = new BodyEdges(threeEdges(), RES);
    expect(be.pickable).toBe(true);
    be.setBodyVisible(false);
    expect(be.pickable).toBe(false);
    expect(be.visibleRefs()).toEqual([]);
    be.setBodyVisible(true);
    for (let i = 0; i < 3; i++) be.setHidden(i, true);
    be.flush();
    expect(be.pickable).toBe(false);
  });

  it("survives a body with no edges at all (well-formed, never drawn)", () => {
    const be = new BodyEdges([], RES);
    expect(be.pickable).toBe(false);
    expect(be.refs).toEqual([]);
    // geometry must still be well-formed: three's raycast reads instanceStart
    // directly and computeBoundingSphere warns on NaN
    expect(segCount(be)).toBe(1);
    expect(be.object.geometry.boundingSphere?.radius).toBe(0);
  });
});
