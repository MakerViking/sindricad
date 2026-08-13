// The occlusion tolerance for edge picking.
//
// pickEdge ranks candidates by SCREEN distance, not depth, which is right when
// choosing between edges you can actually see. It also meant an edge on the FAR
// side of the body could take the click: the raycaster reports it, and it is
// often nearer the cursor in screen space than any visible edge. Edge materials
// are depthTest:true, so that edge is not even drawn where it was winning.
//
// The reported symptom (task #56) was that small faces lose most of their
// clickable pixels head-on and ALL of them at 60 degrees. The screen-space band
// alone only accounts for the first part; occluded edges account for the rest,
// because tilting the view projects far-side edges alongside near-side ones.
//
// These tests pin the tolerance, because getting it wrong in either direction
// is silently bad: too tight and an edge lying ON the surface it bounds stops
// being pickable; too loose and the far side of a thin plate keeps winning.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { worldPerPixel } from "./picking";

const HEIGHT_PX = 800;

describe("worldPerPixel", () => {
  it("scales with distance under perspective", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    const near = worldPerPixel(c, 300, HEIGHT_PX);
    const far = worldPerPixel(c, 600, HEIGHT_PX);
    expect(far / near).toBeCloseTo(2, 6);
    // sanity: a 45 degree fov at 300mm over 800px is a few tenths of a mm
    expect(near).toBeGreaterThan(0.2);
    expect(near).toBeLessThan(0.4);
  });

  it("ignores distance under orthographic, where a pixel is a fixed size", () => {
    const o = new THREE.OrthographicCamera(-80, 80, 50, -50, -1000, 1000);
    expect(worldPerPixel(o, 300, HEIGHT_PX)).toBeCloseTo(worldPerPixel(o, 1200, HEIGHT_PX), 12);
    expect(worldPerPixel(o, 300, HEIGHT_PX)).toBeCloseTo(100 / HEIGHT_PX, 12);
  });

  it("follows ortho zoom, so zooming in tightens the tolerance too", () => {
    const o = new THREE.OrthographicCamera(-80, 80, 50, -50, -1000, 1000);
    const wide = worldPerPixel(o, 300, HEIGHT_PX);
    o.zoom = 4;
    expect(worldPerPixel(o, 300, HEIGHT_PX)).toBeCloseTo(wide / 4, 12);
  });

  it("returns 0 rather than dividing by a zero-height viewport", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    expect(worldPerPixel(c, 300, 0)).toBe(0);
  });
});

describe("the occlusion cutoff pick() derives from it", () => {
  // pick() admits an edge at up to faceDistance + 2 * worldPerPixel
  const cutoff = (cam: THREE.Camera, faceDist: number) =>
    faceDist + 2 * worldPerPixel(cam, faceDist, HEIGHT_PX);

  it("keeps an edge lying on the face it bounds", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    // same depth as the surface, give or take raycast/line-width slop
    expect(300.05).toBeLessThanOrEqual(cutoff(c, 300));
  });

  it("rejects the far edge of a THIN plate, which is the case that matters", () => {
    // A 2mm plate at 300mm. This is why the tolerance cannot be a percentage of
    // the view distance: 2mm is 0.67% of 300mm, so any sane percentage would
    // admit it — and thin plates are exactly where small faces live.
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    expect(302).toBeGreaterThan(cutoff(c, 300));
  });

  it("rejects the far side of an ordinary body by a wide margin", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    expect(400).toBeGreaterThan(cutoff(c, 300)); // 100mm cube
  });

  it("stays tight when zoomed right in, where world units are small", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    // 5mm from a detail: a pixel is ~5um, so even 0.05mm behind is rejected
    expect(5.05).toBeGreaterThan(cutoff(c, 5));
    expect(5.00002).toBeLessThanOrEqual(cutoff(c, 5));
  });
});
