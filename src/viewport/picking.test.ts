// The occlusion tolerance for edge picking, and the edge-priority BAND.
//
// pickEdge ranks candidates by SCREEN distance, not depth, which is right when
// choosing between edges you can actually see. It also meant an edge on the FAR
// side of the body could take the click: the raycaster reports it, and it is
// often nearer the cursor in screen space than any visible edge. Edge materials
// are depthTest:true, so that edge is not even drawn where it was winning.
//
// The reported symptom (task #56) was that small faces lose most of their
// clickable pixels head-on and ALL of them at 60 degrees. Occluded edges are
// one half of that cause and are fixed above; the screen-space band is the
// other half, and it is what "the edge band on a small face" below pins.
//
// These tests pin the tolerance, because getting it wrong in either direction
// is silently bad: too tight and an edge lying ON the surface it bounds stops
// being pickable; too loose and the far side of a thin plate keeps winning.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { EDGE_NEAR_PX, edgeBandPx, faceScreenExtentPx, worldPerPixel } from "./picking";

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

// --- The edge band on a small face (task #56) -------------------------------
//
// Field report: a small face on a tilted view cannot be selected at all. The
// configuration it was measured in is 45 degree fov, 1440x900, face at 300mm,
// which puts one screen pixel at ~0.276mm — so a 3mm face is ~10.9px across and
// a fixed 3px edge halo on all four borders eats most or all of it.
//
// The model below is analytic and deterministic on purpose: the clickable area
// of a w x h px face with a `band` px halo inside each border. It is a model of
// the pick, not the pick itself — it proves the BAND POLICY, and only the
// hand-test in the app proves the extent is measured against the right face.
const FOV = 45;
const VIEW_W = 1440;
const VIEW_H = 900;
const FACE_DIST = 300;

const bandCam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
/** mm -> screen px in the measured configuration (reuses the shipped helper
 *  rather than re-deriving tan(fov/2), so the test cannot drift from pick()). */
const px = (mm: number) => mm / worldPerPixel(bandCam, FACE_DIST, VIEW_H);

/** Fraction of a w x h px face that is further than `band` px from every border
 *  — i.e. the part of it that resolves as a FACE rather than as one of its
 *  bounding edges. */
const clickable = (w: number, h: number, band: number) =>
  Math.max(0, 1 - (2 * band) / w) * Math.max(0, 1 - (2 * band) / h);

/** A row of the field table: a square face of `mm` seen at `tiltDeg`, which
 *  foreshortens one screen dimension by cos(tilt). */
const row = (mm: number, tiltDeg: number) => {
  const w = px(mm);
  const h = px(mm) * Math.cos((tiltDeg * Math.PI) / 180);
  return {
    w,
    h,
    before: clickable(w, h, EDGE_NEAR_PX),
    after: clickable(w, h, edgeBandPx(Math.min(w, h))),
  };
};

describe("the edge band on a small face (task #56)", () => {
  it("makes a 3mm face head-on go from a fifth clickable to over a third", () => {
    const r = row(3, 0);
    expect(r.w).toBeCloseTo(10.86, 2);
    expect(r.h).toBeCloseTo(10.86, 2);
    expect(r.before).toBeCloseTo(0.2, 3);
    expect(r.after).toBeCloseTo(0.36, 3);
  });

  it("makes a 3mm face at 60 degrees clickable AT ALL — the field report", () => {
    const r = row(3, 60);
    expect(r.w).toBeCloseTo(10.86, 2);
    expect(r.h).toBeCloseTo(5.43, 2);
    // 11 x 5 px with a 3px halo on all four borders: not one pixel of it is a
    // face. This is the reported bug, reproduced as a number.
    expect(r.before).toBe(0);
    expect(r.after).toBeCloseTo(0.48, 3);
  });

  it("helps a 6mm face at 60 degrees too — its SHORT side is what matters", () => {
    // 22 x 11 px. The long side is well past the cap; the band still shrinks,
    // because the policy reads the SMALLER dimension. A "faces wider than 22px
    // are unchanged" reading of the cap would be wrong here.
    const r = row(6, 60);
    expect(r.w).toBeCloseTo(21.73, 2);
    expect(r.h).toBeCloseTo(10.86, 2);
    expect(r.before).toBeCloseTo(0.324, 3);
    expect(r.after).toBeCloseTo(0.48, 3);
  });

  it("leaves an ordinary face bit-identical — the safety property", () => {
    // 87 x 43 px: both dimensions clear EDGE_NEAR_PX / 0.2 = 15px, so the cap
    // holds the band at 3px and this pick is the same pick as before the
    // change. toBe on the raw float, not toBeCloseTo: "unchanged" means equal.
    const r = row(24, 60);
    expect(r.after).toBe(r.before);
    expect(edgeBandPx(Math.min(r.w, r.h))).toBe(EDGE_NEAR_PX);
  });

  it("FAILS if the band ever reverts to a constant", () => {
    // The pair is the point: a constant band satisfies the second and cannot
    // satisfy the first. This is the test that has to go red if edgeBandPx is
    // replaced by `return EDGE_NEAR_PX`.
    expect(edgeBandPx(px(3) * Math.cos(Math.PI / 3))).toBeLessThan(EDGE_NEAR_PX);
    expect(edgeBandPx(px(24) * Math.cos(Math.PI / 3))).toBe(EDGE_NEAR_PX);
  });

  it("never grows as the face shrinks", () => {
    let prev = 0;
    for (let e = 0; e <= 40; e += 0.25) {
      const b = edgeBandPx(e);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it("keeps a floor, so a tiny face's edges stay selectable", () => {
    // A 1mm face at 300mm is under 4px. Scaling all the way down would leave it
    // no edge halo at all and its bounding edges would become unpickable in
    // general selection — the opposite complaint.
    expect(edgeBandPx(px(1))).toBe(0.75);
    expect(edgeBandPx(0)).toBe(0.75);
  });

  it("engages the cap exactly at 15px of minimum screen extent", () => {
    expect(edgeBandPx(14.9)).toBeLessThan(EDGE_NEAR_PX);
    expect(edgeBandPx(15)).toBe(EDGE_NEAR_PX);
    expect(edgeBandPx(Infinity)).toBe(EDGE_NEAR_PX);
  });
});

// --- Measuring the face's screen extent -------------------------------------
//
// These cover the ways the measurement can go WRONG rather than its arithmetic.
// Every bail-out must return Infinity, because Infinity is what makes
// edgeBandPx give EDGE_NEAR_PX, i.e. exactly today's behaviour — an implicit
// contract worth asserting rather than only documenting.
const FACE_ID = 7;

/** One `mm` square in the XY plane at world z = `z`, as the minimum a
 *  faceScreenExtentPx call needs: an indexed geometry plus its faceId -> local
 *  triangle map, exactly as buildBodyMesh produces. */
function quadBody(mm: number, z: number) {
  const h = mm / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-h, -h, z, h, -h, z, h, h, z, -h, h, z], 3),
  );
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(geo);
  mesh.updateMatrixWorld();
  return { mesh, faceTriangles: new Map<number, number[]>([[FACE_ID, [0, 1]]]) };
}

const VIEW = { width: VIEW_W, height: VIEW_H };

describe("faceScreenExtentPx", () => {
  it("measures a 3mm face at 300mm as ~11px, which is the whole bug", () => {
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, FACE_DIST);
    cam.updateMatrixWorld();
    expect(faceScreenExtentPx(quadBody(3, 0), FACE_ID, cam, VIEW)).toBeCloseTo(px(3), 2);
  });

  it("returns the SHORT side of a face, not its long one", () => {
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, FACE_DIST);
    cam.updateMatrixWorld();
    // 3mm tall, 24mm wide: on a 1440x900 view the pixels are square, so the
    // short side must come back even though the long one is way past the cap.
    const h = 1.5;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-12, -h, 0, 12, -h, 0, 12, h, 0, -12, h, 0], 3),
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geo);
    mesh.updateMatrixWorld();
    const body = { mesh, faceTriangles: new Map<number, number[]>([[FACE_ID, [0, 1]]]) };
    expect(faceScreenExtentPx(body, FACE_ID, cam, VIEW)).toBeCloseTo(px(3), 2);
  });

  it("refuses a face STRADDLING the camera, which reads as a zero-px sliver", () => {
    // The case that motivates the guard, and the one that bites: you are zoomed
    // in far enough that a big face passes the near plane. The vertices behind
    // it divide by a NEGATIVE w, so they land mirrored — here exactly on top of
    // the front ones, collapsing the face's height to 0px. Unguarded that reads
    // as the smallest face imaginable and hands it the 0.75px floor band, which
    // is the opposite of what a screen-filling face should get.
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      // spans z = -100 (in front) to z = +100 (behind the camera)
      new THREE.Float32BufferAttribute([-1.5, -1.5, -100, 1.5, -1.5, -100, 1.5, 1.5, 100, -1.5, 1.5, 100], 3),
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geo);
    mesh.updateMatrixWorld();
    const body = { mesh, faceTriangles: new Map<number, number[]>([[FACE_ID, [0, 1]]]) };
    const extent = faceScreenExtentPx(body, FACE_ID, cam, VIEW);
    expect(extent).toBe(Infinity);
    // the sentinel must survive into the band — that is what actually matters
    expect(edgeBandPx(extent)).toBe(EDGE_NEAR_PX);
  });

  it("refuses a face ENTIRELY behind the camera, which reads as ~3px", () => {
    // Same poison, cheaper to see: 3mm at 1000mm behind divides by w = -1000 and
    // comes back as a plausible-looking 3px face. It is small enough to slip
    // past the big-face early exit, so only the guard catches it.
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld();
    const extent = faceScreenExtentPx(quadBody(3, 1000), FACE_ID, cam, VIEW);
    expect(extent).toBe(Infinity);
    expect(edgeBandPx(extent)).toBe(EDGE_NEAR_PX);
  });

  it("does NOT trip that guard under an ORTHOGRAPHIC camera", () => {
    // cameras.ts builds its ortho camera with near = -10000, so geometry at
    // POSITIVE view-space z is legitimately visible there. Writing the guard
    // the obvious way — `v.z >= 0`, "behind the camera" — would return the
    // sentinel for roughly half of every ortho pick and silently revert this
    // fix in that projection. Same frustum numbers as cameras.ts.
    const cam = new THREE.OrthographicCamera(-80, 80, 50, -50, -10000, 10000);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld();
    const extent = faceScreenExtentPx(quadBody(1.5, 100), FACE_ID, cam, VIEW);
    expect(Number.isFinite(extent)).toBe(true);
    // 1.5mm across a 160mm-wide / 100mm-tall frustum on a 1440x900 view = 13.5px
    expect(extent).toBeCloseTo(13.5, 4);
    expect(edgeBandPx(extent)).toBeLessThan(EDGE_NEAR_PX);
  });

  it("returns the sentinel for an unknown faceId or a missing body", () => {
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, FACE_DIST);
    cam.updateMatrixWorld();
    expect(faceScreenExtentPx(quadBody(3, 0), 999, cam, VIEW)).toBe(Infinity);
    expect(faceScreenExtentPx(undefined, FACE_ID, cam, VIEW)).toBe(Infinity);
  });

  it("early-exits a big face to the sentinel rather than walking it", () => {
    // Both dimensions past the cap pin the band at EDGE_NEAR_PX whatever the
    // remaining triangles do, so the walk stops. The observable is that the
    // answer is the sentinel, not the (also large) true extent.
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, FACE_DIST);
    cam.updateMatrixWorld();
    const extent = faceScreenExtentPx(quadBody(24, 0), FACE_ID, cam, VIEW);
    expect(extent).toBe(Infinity);
    expect(edgeBandPx(extent)).toBe(EDGE_NEAR_PX);
  });
});
