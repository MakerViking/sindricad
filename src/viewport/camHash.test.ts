// The badge layers reproject only when camHash changes. An orthographic zoom
// changes neither position nor quaternion, so before this the hash stayed put
// and a badge culled at the old zoom stayed culled after zooming out; the
// lock-dimension e2e hit exactly that with a pivot-less zoomBy.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { camHash } from "./camHash";

describe("camHash", () => {
  it("changes when only the orthographic zoom changes", () => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    cam.position.set(0, 0, 50);
    const before = camHash(cam);
    cam.zoom = 2;
    cam.updateProjectionMatrix();
    expect(camHash(cam)).not.toBe(before);
  });

  it("is stable while nothing about the camera changes", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    cam.position.set(1, 2, 3);
    expect(camHash(cam)).toBe(camHash(cam));
  });

  it("tells a perspective camera from an orthographic one at the same pose", () => {
    const p = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    const o = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    expect(camHash(p)).not.toBe(camHash(o));
  });
});
