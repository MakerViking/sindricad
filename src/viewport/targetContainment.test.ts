// Zooming out with the cursor off the model must not carry the orbit target
// away with it (reported 2026-09-07 as "orbits around the wrong point").
//
// Dolly-to-cursor scales the camera and the orbit target about the point under
// the cursor. Zooming OUT scales them away from it, and over empty space that
// point is invented at orbit distance, so every notch moved the target further
// from anything on screen and the default pivot mode then orbited a point far
// from the part. The rig now keeps the target inside a ball around the model
// (1.5 x its half-diagonal) by moving target and camera together, which keeps
// the view direction and zoom the gesture asked for. The oracle is the target's
// distance from the model centre, read from the rig after each notch.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { harness } from "./rig.testkit";

const BOX = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
const HALF_DIAG = BOX.getSize(new THREE.Vector3()).length() / 2; // 86.60
const LIMIT = HALF_DIAG * 1.5; // the rig's CONTENT_RADIUS_FACTOR

function targetDistance(h: ReturnType<typeof harness>) {
  return h.rig.controls.getTarget(new THREE.Vector3()).distanceTo(BOX.getCenter(new THREE.Vector3()));
}

describe("the orbit target stays near the model while zooming", () => {
  it("thirty zoom-out notches with the cursor off the model leave the target inside the content ball", () => {
    const h = harness();
    h.rig.setContentBounds(BOX);
    h.rig.fit(BOX, false);
    h.rig.update(0.016);
    // the "point under the cursor" over empty space: far to the side, at orbit distance
    const offModel = new THREE.Vector3(400, 0, 0);
    for (let i = 0; i < 30; i++) {
      h.rig.zoomBy(1.25, offModel);
      h.rig.update(0.016);
    }
    // RED before the clamp: the target walked to ~1600 mm from the centre.
    expect(targetDistance(h)).toBeLessThanOrEqual(LIMIT + 1e-6);
    // and the zoom itself happened: the camera is far away
    expect(h.rig.controls.distance).toBeGreaterThan(500);
  });

  it("zooming in toward a point on the model still pins that point (the clamp never fires inside the ball)", () => {
    const h = harness();
    h.rig.setContentBounds(BOX);
    h.rig.fit(BOX, false);
    h.rig.update(0.016);
    const onModel = new THREE.Vector3(50, 0, 0); // a surface point
    const before = h.rig.controls.getTarget(new THREE.Vector3()).distanceTo(onModel);
    for (let i = 0; i < 10; i++) {
      h.rig.zoomBy(0.8, onModel);
      h.rig.update(0.016);
    }
    const after = h.rig.controls.getTarget(new THREE.Vector3()).distanceTo(onModel);
    expect(after).toBeLessThan(before); // the target converged on the point under the cursor
    expect(targetDistance(h)).toBeLessThanOrEqual(LIMIT + 1e-6);
  });

  it("with no content bounds the old behaviour is untouched", () => {
    const h = harness();
    h.rig.setContentBounds(null);
    h.rig.fit(BOX, false);
    h.rig.update(0.016);
    const offModel = new THREE.Vector3(400, 0, 0);
    for (let i = 0; i < 10; i++) {
      h.rig.zoomBy(1.25, offModel);
      h.rig.update(0.016);
    }
    expect(targetDistance(h)).toBeGreaterThan(LIMIT); // free to drift, as before
  });
});
