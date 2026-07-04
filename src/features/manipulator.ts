// Shared math for interactive 3D manipulators (extrude / fillet / chamfer):
// mapping a cursor ray onto a drag axis to read a signed scalar (a distance or
// radius in mm). Kept separate so the tools don't each carry a copy.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";

/** Signed distance along `dir` (unit) of the closest point on the axis
 *  (through `origin`) to the cursor `ray`. Ill-conditioned when the camera
 *  looks down the axis — use axisDragDistance for interactive drags. */
export function distanceAlongAxis(
  ray: THREE.Ray,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
): number {
  const w0 = ray.origin.clone().sub(origin);
  const b = ray.direction.dot(dir);
  const d = ray.direction.dot(w0);
  const e = dir.dot(w0);
  const denom = 1 - b * b; // a=c=1 (unit vectors)
  if (Math.abs(denom) < 1e-6) return -e;
  return (e - b * d) / denom; // signed param along dir
}

/** Drag distance along a world axis for a cursor position — robust at EVERY
 *  view angle. The closest-point solution above degenerates when the camera
 *  looks down the axis (in an orthographic top view it returns a CONSTANT, so
 *  dragging a top-facing face did nothing at all). Near the degeneracy this
 *  projects the axis to screen space and measures the cursor along it; when
 *  the axis has no screen extent (pointing dead at the camera), vertical mouse
 *  motion drives it — up = toward the viewer. */
export function axisDragDistance(
  viewport: Viewport,
  clientX: number,
  clientY: number,
  anchor: THREE.Vector3,
  axis: THREE.Vector3,
): number {
  const ray = viewport.rayFrom(clientX, clientY).ray;
  if (Math.abs(ray.direction.dot(axis)) < 0.95) {
    return distanceAlongAxis(ray, anchor, axis);
  }
  const px = viewport.pixelWorldSize(anchor); // world units per screen pixel
  const step = px * 40;
  const p0 = viewport.projectToScreen(anchor);
  const p1 = viewport.projectToScreen(anchor.clone().addScaledVector(axis, step));
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len > 6) {
    // cursor offset along the screen-projected axis, mapped back to world
    return (((clientX - p0.x) * dx + (clientY - p0.y) * dy) / len) * (step / len);
  }
  // axis points dead at / away from the camera
  const camDir = viewport.camera.getWorldDirection(new THREE.Vector3());
  const sign = axis.dot(camDir) < 0 ? 1 : -1; // toward the viewer → mouse up = +
  return (p0.y - clientY) * px * sign;
}
