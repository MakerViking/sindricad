// Accelerated raycasting for the body meshes.
//
// Every `pointermove` runs a hover pick, and three.js's stock raycast is a
// brute-force scan of every triangle. Measured in a real browser on a hex
// texture over a 40mm cylinder: 50,074 triangles, 2.60ms MEDIAN per pick
// (p95 2.80, max 3.90) against 0.00ms for the same cylinder untextured. At one
// or more pointermove events per frame that is most of a 60fps budget spent
// before anything is drawn, which is why applying a texture tanked the frame
// rate on hardware that renders 50k triangles without noticing.
//
// three-mesh-bvh replaces the scan with a tree walk. It is already a dependency
// of three other projects here, so it is not a new vendor to trust.
//
// This module patches THREE.Mesh.prototype as a SIDE EFFECT of being imported.
// render.ts imports scheduleRaycastIndex from it, and render.ts is pulled in by
// viewport.ts at app load, so the patch is in place long before any pointermove
// can raycast. picking.ts additionally imports flushRaycastIndex.
import * as THREE from "three";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Build the BVH for a body mesh's geometry. Call once per mesh, at build time.
 *
 *  `indirect: true` IS LOAD-BEARING, not a tuning knob. The default build
 *  REORDERS the geometry's index buffer to group triangles spatially — and this
 *  whole app keys its face model on triangle index: `faceIds[t]`, the
 *  `faceTriangles` map, and the highlighter's per-face vertex painting. With the
 *  default build a cylinder's three faces each ended up owning a scrambled mix
 *  of the other faces' triangles (measured: faceId 0 got 69 bottom + 55 lateral
 *  + 18 top), so hover painted a nonsense patch and picking returned the wrong
 *  face. Indirect mode keeps its own ordering in a side buffer and leaves the
 *  index alone.
 *
 *  Safe to call twice: three-mesh-bvh replaces an existing tree. Callers should
 *  normally use scheduleRaycastIndex (below) rather than this directly — the
 *  build is deferred past the first paint, not skipped. */
export function buildRaycastIndex(geo: THREE.BufferGeometry) {
  // A geometry with no index has nothing to accelerate against, and
  // computeBoundsTree would throw rather than no-op.
  if (!geo.getIndex()) return;
  geo.computeBoundsTree({ indirect: true, maxLeafTris: 8 });
}

/** Release a BVH with its geometry. Skipping this leaks the tree's typed
 *  arrays for every rebuild, and a rebuild happens on EVERY document change. */
export function disposeRaycastIndex(geo: THREE.BufferGeometry) {
  pending.delete(geo); // never build a tree for geometry that is already gone
  if (geo.boundsTree) geo.disposeBoundsTree();
}

// --- deferred building ------------------------------------------------------
//
// Building every body's BVH inline during setModel measured ~0.7 s of the 2.26 s
// of frozen main thread after a large reply lands (3,071 bodies). A fully LAZY
// build is still the wrong answer — it just moves the stall into the user's
// first mouse move, which is worse than a stall during a load they are already
// waiting through.
//
// So: build after the first paint instead. `scheduleRaycastIndex` queues the
// geometry, one rAF hands the browser its frame, then idle callbacks drain the
// queue in deadline-bounded chunks. The model appears ~0.7 s sooner and the
// trees are ready a frame or two later.
//
// `flushRaycastIndex` closes the only hole: a pick that arrives before the queue
// drains. Without it three-mesh-bvh would silently fall back to the stock
// brute-force raycast — correct, but a scan of millions of triangles. The picker
// calls it first, and it is free once the queue is empty.
const pending = new Set<THREE.BufferGeometry>();
let scheduled = false;

function drain(hasTime: () => boolean) {
  for (const geo of pending) {
    pending.delete(geo);
    buildRaycastIndex(geo);
    if (!hasTime()) break;
  }
  scheduled = false;
  if (pending.size) schedule();
}

function schedule() {
  if (scheduled || !pending.size) return;
  scheduled = true;
  if (typeof globalThis.requestIdleCallback === "function") {
    // timeout so a permanently busy main thread still gets the trees built
    globalThis.requestIdleCallback((d) => drain(() => d.timeRemaining() > 1), { timeout: 500 });
    return;
  }
  // WebKitGTK has no requestIdleCallback: fall back to a macrotask and bound
  // the chunk by wall clock so one slice can't become its own long task.
  setTimeout(() => {
    const t0 = performance.now();
    drain(() => performance.now() - t0 < 8);
  }, 0);
}

/** Queue a body geometry's BVH to be built after the current frame paints. */
export function scheduleRaycastIndex(geo: THREE.BufferGeometry) {
  if (!geo.getIndex() || geo.boundsTree) return;
  pending.add(geo);
  if (scheduled) return;
  // One rAF first, so the browser gets to paint the model before we spend any
  // main thread on trees. Headless callers (vitest) have no rAF — fall straight
  // through to the idle/macrotask path rather than throwing.
  if (typeof globalThis.requestAnimationFrame !== "function") {
    schedule();
    return;
  }
  scheduled = true;
  globalThis.requestAnimationFrame(() => {
    scheduled = false;
    schedule();
  });
}

/** Build any queued BVHs right now. Called before a pick so an interaction can
 *  never fall back to the stock brute-force raycast. No-op when idle already
 *  drained the queue, which is the normal case. */
export function flushRaycastIndex() {
  if (!pending.size) return;
  drain(() => true);
}
