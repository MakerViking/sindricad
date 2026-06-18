// Shared math for interactive 3D manipulators (extrude / fillet / chamfer):
// mapping a cursor ray onto a drag axis to read a signed scalar (a distance or
// radius in mm). Kept separate so the tools don't each carry a copy.

import * as THREE from "three";

/** Signed distance along `dir` (unit) of the closest point on the axis
 *  (through `origin`) to the cursor `ray`. */
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
