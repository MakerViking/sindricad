// The construction-plane quad has to reach past the model.
//
// Field report f45fe95c (Linux): "some lines overlaying the surface of the body
// … in space because they moved as I rotated the body". Nothing was wrong with
// his geometry — his part is 83.72 mm across and the datum quad was a hardcoded
// 80x80, so the quad's boundary ended 1.86 mm inside each end of the top face.
// The plane floats 20 mm above that face, so the boundary's projection slid
// across the face as the camera orbited: a faint straight line that moves.
//
// These tests observe the GEOMETRY the viewport puts in the scene, not that a
// sizing function was called, because the only thing that matters is whether the
// quad's boundary lands over a face.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { datumQuadGeometry } from "./viewport";

/** The body from f45fe95c: an 83.72 x 39.59 rectangle centred on the origin,
 *  extruded and then press-pulled up to a datum, top face at z = 49.858. */
const REPORTER_BOX = new THREE.Box3(
  new THREE.Vector3(-41.86047183451246, -19.79402311031947, 0),
  new THREE.Vector3(41.86047183451246, 19.79402311031947, 49.858),
);

/** World-space XY footprint of the quad. Both the reporter's datum planes are
 *  Z-normal, so the quad is laid out unrotated and its own X/Y are world X/Y. */
function footprint(box: THREE.Box3 | null): THREE.Box3 {
  const geo = datumQuadGeometry(box);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  expect(bb).not.toBeNull();
  return bb as THREE.Box3;
}

describe("datumQuadGeometry", () => {
  it("reaches past the model, so its boundary never lands over a face", () => {
    const q = footprint(REPORTER_BOX);
    expect(q.min.x).toBeLessThan(REPORTER_BOX.min.x);
    expect(q.max.x).toBeGreaterThan(REPORTER_BOX.max.x);
    expect(q.min.y).toBeLessThan(REPORTER_BOX.min.y);
    expect(q.max.y).toBeGreaterThan(REPORTER_BOX.max.y);
  });

  it("clears the model by a visible margin, not by a rounding error", () => {
    const q = footprint(REPORTER_BOX);
    // A datum floats above the face it hovers over, so its boundary walks in
    // over that face as the camera tilts: merely covering the footprint is not
    // enough. Measured on this document in the app, a quad of 1.25 x the
    // diagonal (margin 0.11 x diag) still cut the top face at the iso view; the
    // shipping 1.75 leaves 0.48. The floor here is what keeps that headroom.
    const diag = REPORTER_BOX.getSize(new THREE.Vector3()).length();
    expect(q.max.x - REPORTER_BOX.max.x).toBeGreaterThan(0.25 * diag);
  });

  it("keeps the old 80 mm square for an empty or tiny document", () => {
    for (const box of [
      null,
      new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)),
      new THREE.Box3(new THREE.Vector3(-5, -5, 0), new THREE.Vector3(5, 5, 2)),
    ]) {
      const q = footprint(box);
      expect(q.max.x - q.min.x).toBeCloseTo(80, 6);
      expect(q.max.y - q.min.y).toBeCloseTo(80, 6);
    }
  });

  it("stays square and centred on the plane origin", () => {
    const q = footprint(REPORTER_BOX);
    expect(q.max.x - q.min.x).toBeCloseTo(q.max.y - q.min.y, 6);
    expect(q.min.x + q.max.x).toBeCloseTo(0, 6);
    expect(q.min.y + q.max.y).toBeCloseTo(0, 6);
  });
});
