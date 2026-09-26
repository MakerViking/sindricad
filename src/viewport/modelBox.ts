// Which box the camera is allowed to aim at.
//
// Field case, 2026-09 (an Ender 3 assembly, 340 bodies): seven imported bodies
// each had a conical face that OCCT's mesher left untriangulated. For such a
// face the sidecar's bounding box falls back to the face's GEOMETRIC box, and a
// cone's surface is unbounded along its axis, so the document box came back as
// ±1e100 mm. The viewport took that number verbatim: Fit put the camera about
// 5.2e100 mm out against a far plane of 10,000, the ground grid dropped to
// z = -1e100, and the whole view went blank. Nothing could bring it back,
// because Fit re-fit the same box, and so did every window resize.
//
// The sidecar is being fixed to send a finite box. This is the viewport's own
// guard, so a bad box from ANY source cannot strand the camera again: a box is
// only trusted when it is finite, in range and the right way out, and when it
// is not, the box is measured from the triangles that actually arrived.

import * as THREE from "three";

/** Any model coordinate past this is not geometry, it is OCCT's "unbounded"
 *  sentinel (an open box reads ±1e100) or an overflow. The same limit the
 *  sidecar applies (builder._BBOX_LIMIT, tessellate._UNBOUNDED_MM).
 *
 *  A sentinel test, deliberately not a distance cap. The camera frames relative
 *  to the box and its near/far planes travel with it, so a real part far from
 *  the origin (site coordinates: 1 m at x = 20 km) frames fine. A first version
 *  capped coordinates at 1e7 mm, which silently took Fit away from such a part:
 *  its triangles were skipped and Fit framed the empty origin instead. */
export const MAX_MODEL_COORD_MM = 1e99;

/** The wire's shape for a box. The sidecar sends `null` when nothing has built. */
export type WireBox = { min: ArrayLike<number>; max: ArrayLike<number> } | null | undefined;

export function isSaneCoord(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v) <= MAX_MODEL_COORD_MM;
}

/** A box the camera can be aimed at: every corner coordinate finite and in
 *  range, and not inside out. An EMPTY Box3 (min +Infinity) is not sane, which
 *  is right: there is nothing in it to aim at. */
export function isSaneBox(box: THREE.Box3 | null | undefined): box is THREE.Box3 {
  if (!box) return false;
  const { min, max } = box;
  for (const v of [min.x, min.y, min.z, max.x, max.y, max.z]) if (!isSaneCoord(v)) return false;
  return min.x <= max.x && min.y <= max.y && min.z <= max.z;
}

/** The wire box as a Box3, or null when it is missing or malformed. Says
 *  nothing about sanity: pass the result to isSaneBox. */
export function wireBox(bbox: WireBox): THREE.Box3 | null {
  if (!bbox || bbox.min?.length !== 3 || bbox.max?.length !== 3) return null;
  return new THREE.Box3(
    new THREE.Vector3(bbox.min[0], bbox.min[1], bbox.min[2]),
    new THREE.Vector3(bbox.max[0], bbox.max[1], bbox.max[2]),
  );
}

/** The box around a flat xyz position array. A vertex with any coordinate that
 *  is not sane is skipped rather than allowed to stretch the box to infinity. */
export function boxOfPositions(positions: ArrayLike<number>): THREE.Box3 {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (!isSaneCoord(x) || !isSaneCoord(y) || !isSaneCoord(z)) continue;
    box.expandByPoint(p.set(x, y, z));
  }
  return box;
}

/** The model box for a finished reply: the sidecar's box when it is sane,
 *  otherwise the box of the triangles the reply actually carries. `fromMesh`
 *  says which one it was. Scanning the positions costs O(vertices), which is
 *  why the sidecar's box is still preferred when it can be trusted. */
export function documentBox(
  bbox: WireBox,
  positions: ArrayLike<number>,
): { box: THREE.Box3; fromMesh: boolean } {
  const sent = wireBox(bbox);
  if (isSaneBox(sent)) return { box: sent, fromMesh: false };
  return { box: boxOfPositions(positions), fromMesh: true };
}

/** What Fit frames: the union of the VISIBLE objects' world boxes, or of every
 *  object when none is visible (so Fit after hiding everything still goes
 *  somewhere useful). After Isolate, Fit frames the isolated body, not the
 *  whole assembly it was isolated from.
 *
 *  An object whose box is not sane (no triangles, or a junk vertex) frames
 *  nothing rather than flinging the camera. Empty when nothing qualifies. */
export function framingBox(objects: readonly THREE.Object3D[]): THREE.Box3 {
  const visible = new THREE.Box3();
  const all = new THREE.Box3();
  const one = new THREE.Box3();
  for (const o of objects) {
    // setFromObject reads the cached geometry box and applies matrixWorld, so
    // a body mid-Move is framed where it is drawn.
    one.setFromObject(o);
    if (!isSaneBox(one)) continue;
    all.union(one);
    if (o.visible) visible.union(one);
  }
  return visible.isEmpty() ? all : visible;
}
