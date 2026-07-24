// Selection-membership test for sketch profile regions.
//
// A committed region selection is stored as world-space anchor points (parametric:
// re-resolved against re-detected regions each rebuild). Deciding whether a stored
// anchor belongs to a given region needs BOTH a coplanarity check and a 2D
// containment check — the coplanarity gate is not optional.

import * as THREE from "three";
import type { SketchPlane } from "./plane";
import { pointInRegion, type Region } from "./region";

// Max out-of-plane distance (mm) for an anchor to count as "on" a region's plane.
// Sketch anchors are placed exactly on their plane (to3D), so same-plane distance
// is ~0; a parallel sketch is offset by whole mm, far above this.
const PLANE_EPS = 1e-3;

/** A world-space point belongs to a region only if it lies ON the region's plane
 *  AND inside the region's material. The coplanarity gate matters because
 *  SketchPlane.to2D ORTHOGONALLY PROJECTS any 3D point onto the plane: without the
 *  gate, an anchor on one sketch's plane projects onto a PARALLEL sketch's plane
 *  and can fall inside a region there — the field bug where selecting an upper
 *  ring also selected the lower sketch's inner disk (loft workflow). */
export function worldPointInRegion(p: THREE.Vector3, plane: SketchPlane, region: Region): boolean {
  if (Math.abs(plane.plane.distanceToPoint(p)) > PLANE_EPS) return false;
  return pointInRegion(plane.to2D(p), region);
}
