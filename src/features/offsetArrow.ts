// The offset arrow: the drag handle Offset Plane / Datum Plane put on a plane,
// shared with Split Body so moving a cut feels exactly like moving a plane.
//
// Only the handle lives here — its shape, its paint and its teardown. What a
// drag MEANS stays with each tool: Offset Plane commits on a click away from
// the arrow, Split Body must not (a stray click there picks a body or a plane
// for one of its fields, and only OK commits).
//
// The mesh is modelled in PIXELS along +Y: a caller scales the group by
// viewport.pixelWorldSize() every frame so it stays the same size on screen at
// any zoom, and orients +Y onto the drag axis.

import * as THREE from "three";
import { HANDLE_IDLE } from "../viewport/colors3d";

export interface OffsetArrow {
  group: THREE.Group;
  material: THREE.MeshBasicMaterial;
}

export function buildOffsetArrow(): OffsetArrow {
  const material = new THREE.MeshBasicMaterial({ color: HANDLE_IDLE, depthTest: false, depthWrite: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 34, 12), material);
  shaft.position.y = 6 + 17;
  const head = new THREE.Mesh(new THREE.ConeGeometry(5, 13, 18), material);
  head.position.y = 6 + 34 + 6.5;
  const group = new THREE.Group();
  group.add(shaft, head);
  group.renderOrder = 999;
  shaft.renderOrder = 999;
  head.renderOrder = 999;
  return { group, material };
}

/** Free the arrow's GPU buffers. The caller removes it from the scene first. */
export function disposeOffsetArrow(arrow: OffsetArrow) {
  for (const c of arrow.group.children) if (c instanceof THREE.Mesh) c.geometry.dispose();
  arrow.material.dispose();
}

/** Distance from the arrow's base to the tip of its head, in the same pixel
 *  units the mesh is modelled in — where a label naming the arrow's direction
 *  goes. */
export const OFFSET_ARROW_LENGTH_PX = 6 + 34 + 13;
