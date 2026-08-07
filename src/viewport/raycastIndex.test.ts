// Body BVHs are built after the first paint instead of inside setModel (~0.7 s
// of the 2.26 s post-reply freeze on a 3,071-body assembly). The safety property
// that makes that acceptable is flushRaycastIndex(): a pick arriving before the
// idle queue drains must still get a tree, because three-mesh-bvh would
// otherwise silently fall back to a brute-force scan of every triangle.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { scheduleRaycastIndex, flushRaycastIndex, disposeRaycastIndex } from "./raycastIndex";

function indexedGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
}

describe("deferred raycast index", () => {
  it("does not build the tree at schedule time", () => {
    const g = indexedGeo();
    scheduleRaycastIndex(g);
    expect(g.boundsTree).toBeUndefined();
    disposeRaycastIndex(g);
  });

  it("flush builds every queued tree", () => {
    const a = indexedGeo(), b = indexedGeo();
    scheduleRaycastIndex(a);
    scheduleRaycastIndex(b);
    flushRaycastIndex();
    expect(a.boundsTree).toBeDefined();
    expect(b.boundsTree).toBeDefined();
    disposeRaycastIndex(a); disposeRaycastIndex(b);
  });

  it("flush is a no-op when nothing is queued", () => {
    expect(() => flushRaycastIndex()).not.toThrow();
  });

  it("skips geometry with no index (computeBoundsTree would throw)", () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    scheduleRaycastIndex(g);
    flushRaycastIndex();
    expect(g.boundsTree).toBeUndefined();
  });

  it("a disposed geometry is dropped from the queue, never built", () => {
    const g = indexedGeo();
    scheduleRaycastIndex(g);
    disposeRaycastIndex(g);   // body removed before idle ran
    flushRaycastIndex();
    expect(g.boundsTree).toBeUndefined();
  });

  it("keeps the index buffer unreordered (indirect: true is load-bearing)", () => {
    const g = indexedGeo();
    const before = Array.from(g.getIndex()!.array);
    scheduleRaycastIndex(g);
    flushRaycastIndex();
    expect(Array.from(g.getIndex()!.array)).toEqual(before);
    disposeRaycastIndex(g);
  });
});
