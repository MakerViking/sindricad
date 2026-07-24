import * as THREE from "three";

/** A cheap change-detection hash of a camera's pose. Projected-DOM overlays
 *  (dimension labels, constraint glyphs) reproject their badges only when this
 *  changes, so a static view costs one string build per frame instead of a
 *  full per-label reprojection. */
export function camHash(cam: THREE.Camera): string {
  const p = cam.position;
  const q = cam.quaternion;
  return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`;
}
