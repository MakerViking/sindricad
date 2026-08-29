// Zoom to Fit in an orthographic view.
//
// Field report 76237688 (0.1.171, Windows): "Tried to use 'Fit' to make a body
// fit the screen, it would do it once but not do it again if I zoomed out.
// Seems to be ok when in 'Persp' or 'Auto' but does not work properly in
// 'Ortho'."
//
// An orthographic camera's apparent size is (top − bottom) / 2 / zoom — which is
// exactly what the rig's own viewScale() reports. `fit` framed the box by
// rewriting the frustum bounds and left `zoom`, the only thing the mouse wheel
// touches in ortho, untouched. So the first fit after startup looked right (zoom
// was still 1) and every fit after a wheel zoom framed the box scaled by 1/zoom.
//
// This drives the REAL rig against a DOM stub rather than reading the source,
// because "does the view end up framing the box" is exactly the question a
// source assertion cannot answer.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { orthoHarness } from "./rig.testkit";

const box = () => new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));

describe("Fit in an orthographic view", () => {
  it("frames the box the same way however far the user zoomed out first", () => {
    // The report, as an assertion: fit, zoom out, fit again, and the two views
    // must show the same thing.
    const rig = orthoHarness().rig;
    rig.fit(box(), false);
    rig.update(0.016);
    const first = rig.viewScale();
    expect(first, "the first fit produced a degenerate view").toBeGreaterThan(0);

    rig.zoomBy(4); // wheel out
    rig.update(0.016);
    expect(
      rig.viewScale(),
      "zoomBy did not change the ortho view at all — this test could not detect the bug",
    ).toBeGreaterThan(first * 1.5);

    rig.fit(box(), false);
    rig.update(0.016);
    expect(
      rig.viewScale(),
      "Fit after a zoom-out frames a different amount than Fit from the default zoom — "
        + "the frustum was reset but the accumulated ortho zoom was not (field report 76237688)",
    ).toBeCloseTo(first, 4);
  });

  it("frames the box the same way however far the user zoomed IN first", () => {
    // The other direction, which fails the same way with the opposite sign.
    const rig = orthoHarness().rig;
    rig.fit(box(), false);
    rig.update(0.016);
    const first = rig.viewScale();

    rig.zoomBy(0.25); // wheel in
    rig.update(0.016);
    rig.fit(box(), false);
    rig.update(0.016);
    expect(rig.viewScale(), "Fit after a zoom-IN does not restore the framing").toBeCloseTo(first, 4);
  });

  it("actually contains the box it was asked to fit", () => {
    // Not just self-consistent — the point of Fit is that the thing is on
    // screen. The box's bounding sphere has radius sqrt(3)·10 ≈ 17.32.
    const rig = orthoHarness().rig;
    rig.zoomBy(6);
    rig.update(0.016);
    rig.fit(box(), false);
    rig.update(0.016);
    const half = rig.viewScale();
    const radius = Math.sqrt(3) * 10;
    expect(half, "the fitted view is smaller than the body — it would be clipped").toBeGreaterThanOrEqual(radius);
    expect(half, "the fitted view is far larger than the body — the body would be a speck").toBeLessThan(radius * 2);
  });

  it("leaves the view direction alone, which is why fit is hand-rolled", () => {
    // camera-controls' own fitToBox resets the orbit to an axis view under a
    // Z-up camera; this rig deliberately preserves the direction, and a
    // regression there is a camera that jumps on every Fit.
    const rig = orthoHarness().rig;
    rig.fit(box(), false);
    rig.update(0.016);
    const before = rig.active.position.clone().normalize();
    rig.zoomBy(3);
    rig.update(0.016);
    rig.fit(box(), false);
    rig.update(0.016);
    const after = rig.active.position.clone().normalize();
    expect(after.dot(before), "Fit swung the camera to a different view direction").toBeCloseTo(1, 3);
  });
});
