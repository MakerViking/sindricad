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
// render.ts imports buildRaycastIndex from it, and render.ts is pulled in by
// viewport.ts at app load, so the patch is in place long before any pointermove
// can raycast. Nothing else needs to import it.
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
 *  Cost is paid here rather than on the first pick, so the first mouse move
 *  after a rebuild is not the slow one. Safe to call twice: three-mesh-bvh
 *  replaces an existing tree. */
export function buildRaycastIndex(geo: THREE.BufferGeometry) {
  // A geometry with no index has nothing to accelerate against, and
  // computeBoundsTree would throw rather than no-op.
  if (!geo.getIndex()) return;
  geo.computeBoundsTree({ indirect: true, maxLeafTris: 8 });
}

/** Release a BVH with its geometry. Skipping this leaks the tree's typed
 *  arrays for every rebuild, and a rebuild happens on EVERY document change. */
export function disposeRaycastIndex(geo: THREE.BufferGeometry) {
  if (geo.boundsTree) geo.disposeBoundsTree();
}
