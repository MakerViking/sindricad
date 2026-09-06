import * as THREE from "three";

/** A cheap change-detection hash of a camera's pose. Projected-DOM overlays
 *  (dimension labels, constraint glyphs) reproject their badges only when this
 *  changes, so a static view costs one string build per frame instead of a
 *  full per-label reprojection.
 *
 *  The hash covers the projection as well as the pose. An orthographic zoom
 *  moves nothing in the camera's position or quaternion: only `zoom` changes,
 *  and a badge projected before the zoom is then drawn at the wrong pixel, or
 *  stays culled after zooming out should have brought its anchor back into
 *  view. The wheel path never showed it because it dollies toward the cursor
 *  and so moves the position too; a programmatic zoomBy with no pivot, and the
 *  lock-dimension e2e that used one, did. */
export function camHash(cam: THREE.Camera): string {
  const p = cam.position;
  const q = cam.quaternion;
  const zoom = (cam as { zoom?: number }).zoom ?? 1;
  const kind = (cam as { isOrthographicCamera?: boolean }).isOrthographicCamera ? "o" : "p";
  return `${kind}${zoom.toFixed(4)},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`;
}
