// Fit can always bring the camera back.
//
// Field case, 2026-09: a 340-body Ender 3 assembly opened to a completely blank
// viewport, grid included, and Fit did nothing. Seven imported bodies had a
// conical face the mesher left untriangulated, OCCT reported those bodies'
// boxes as open (±1e100 mm), and the document box inherited it. Fit framed
// that box "correctly": camera 5.2e100 mm out, far plane at 10,000. Then:
//   - Fit could not recover, because it re-fit the same box, and
//   - in Ortho (and Auto on a straight-on view) even a FINITE box could not
//     recover, because the ortho fit kept max(controls.distance, 2r), and
//     controls.distance was 5.2e100.
//
// The viewport now refuses such boxes before they reach the rig (modelBox.ts).
// These tests are about the rig's own guarantee, driven through the real rig:
// whatever state the camera is in and whatever box it is handed, a Fit leaves
// the camera inside its own near/far range, framing something.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { harness, orthoHarness } from "./rig.testkit";
import { fitDistance, type CameraRig } from "./cameras";
import { framingBox } from "./modelBox";

const OPEN = 1e100;
const openBox = () => new THREE.Box3(new THREE.Vector3(-OPEN, -OPEN, -OPEN), new THREE.Vector3(OPEN, OPEN, OPEN));
// a small part, of the order of what the BLTouch body DID mesh (±2.0 x ±2.0 x ±2.5 mm)
const part = () => new THREE.Box3(new THREE.Vector3(-4.96, -4.96, -4.96), new THREE.Vector3(4.96, 4.96, 4.96));

/** Throw the camera out to where the ±1e100 fit used to leave it, off-axis so
 *  Auto stays in perspective (or along an axis so it snaps to ortho). */
function strand(rig: CameraRig, onAxis = false) {
  const d = 5.2e100;
  if (onAxis) rig.controls.setLookAt(0, -d, 0, 0, 0, 0, false);
  else rig.controls.setLookAt(d * 0.6, -d * 0.64, d * 0.48, 0, 0, 0, false);
  rig.update(0.016);
  expect(rig.controls.distance, "the setup did not strand the camera").toBeGreaterThan(1e99);
}

/** Is all of `box` between the active camera's near and far planes? That is
 *  the whole question a blank viewport asks. */
function boxInDepthRange(rig: CameraRig, box: THREE.Box3): boolean {
  const cam = rig.active as THREE.PerspectiveCamera | THREE.OrthographicCamera;
  cam.updateMatrixWorld();
  const forward = cam.getWorldDirection(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const depth = sphere.center.clone().sub(cam.position).dot(forward);
  return depth - sphere.radius >= cam.near && depth + sphere.radius <= cam.far;
}

describe("Fit handed a box nobody can aim at", () => {
  it("refuses the ±1e100 box and frames the origin, instead of flinging the camera", () => {
    const { rig } = harness();
    rig.update(0.016);
    rig.fit(openBox(), false);
    rig.update(0.016);
    expect(rig.controls.distance, "Fit threw the camera out to frame an open OCCT box").toBeLessThan(1e4);
    expect(rig.controls.getTarget(new THREE.Vector3()).length()).toBeLessThan(1e-6);
    expect(boxInDepthRange(rig, part()), "the origin view does not even show a part at the origin").toBe(true);
  });

  it("refuses it in Ortho too", () => {
    const { rig } = orthoHarness();
    rig.fit(openBox(), false);
    rig.update(0.016);
    expect(rig.controls.distance).toBeLessThan(1e4);
    expect(rig.viewScale(), "the ortho frustum was sized to the open box").toBeLessThan(1e4);
  });
});

describe("Fit from a camera that was already thrown out", () => {
  it("brings it back in Ortho, where it used to keep the stranded distance", () => {
    const { rig } = orthoHarness();
    strand(rig, true);
    expect(boxInDepthRange(rig, part()), "the stranded camera can still see the part: no bug to recover from").toBe(false);

    rig.fit(part(), false);
    rig.update(0.016);
    expect(
      rig.controls.distance,
      "Fit in Ortho kept max(controls.distance, 2r), so the camera stayed 5e100 mm out",
    ).toBeLessThan(1e3);
    expect(boxInDepthRange(rig, part()), "after Fit the part is still outside the camera's depth range").toBe(true);
  });

  it("brings it back in Auto on a straight-on view, which is ortho underneath", () => {
    const { rig } = harness(); // Auto is the default mode
    strand(rig, true);
    expect(rig.isOrtho(), "an axis view in Auto should be orthographic").toBe(true);
    rig.fit(part(), false);
    rig.update(0.016);
    expect(boxInDepthRange(rig, part())).toBe(true);
  });

  it("lands within a few frames when Fit is animated, not after half a minute of easing", () => {
    // Every user-facing Fit animates. camera-controls eases from where the
    // camera IS, so from 5e100 mm the ease alone takes seconds of frames with
    // the model still past the far plane.
    const { rig } = harness();
    strand(rig);
    expect(rig.isOrtho()).toBe(false);
    rig.fit(part(), true);
    for (let i = 0; i < 3; i++) rig.update(1 / 60);
    expect(rig.controls.distance, "an animated Fit is still easing in from the stranded camera").toBeLessThan(1e3);
    expect(boxInDepthRange(rig, part())).toBe(true);
  });

  it("keeps easing an ordinary Fit, from a camera that is somewhere sensible", () => {
    // The snap is for a stranded camera only; an everyday Fit still animates.
    const { rig } = harness();
    rig.update(0.016);
    for (let i = 0; i < 3; i++) rig.zoomBy(4);
    rig.update(0.016);
    const before = rig.controls.distance;
    rig.fit(part(), true);
    rig.update(1 / 60);
    const after = rig.controls.distance;
    expect(after, "the ordinary Fit jumped instead of easing").toBeGreaterThan(fitDistance(Math.sqrt(3) * 4.96 * 1.15, false) * 2);
    expect(after).toBeLessThan(before);
  });
});

describe("the distance Fit puts the camera at", () => {
  it("depends on the box, the projection and the model, never on the previous camera", () => {
    // The old ortho rule consulted the current distance. The arguments are the
    // guarantee: none of them can carry a stranded camera in.
    const r = 20;
    expect(fitDistance(r, true)).toBe(40);
    expect(fitDistance(r, false)).toBeCloseTo(r / Math.sin(Math.PI / 8), 9);
    // Ortho stands clear of the rest of the model (see the next block), within
    // the camera's ±10,000 mm depth range
    expect(fitDistance(r, true, 300)).toBe(300);
    expect(fitDistance(r, true, 1e6), "the framed part was pushed past the far plane").toBe(10000 - r);
    expect(fitDistance(r, true, NaN)).toBe(40);
    expect(fitDistance(r, false, 300), "the model's reach moved a perspective camera").toBeCloseTo(
      r / Math.sin(Math.PI / 8),
      9,
    );
  });

  it("frames a real part far from the origin, instead of the empty origin view", () => {
    // Site coordinates: 1 m at x = 20 km. The near and far planes travel with
    // the camera, so distance from the origin is no reason to refuse a box.
    const far = new THREE.Box3(new THREE.Vector3(2e7 - 500, -500, -500), new THREE.Vector3(2e7 + 500, 500, 500));
    for (const make of [harness, orthoHarness]) {
      const { rig } = make();
      rig.update(0.016);
      rig.fit(far, false);
      rig.update(0.016);
      expect(rig.controls.getTarget(new THREE.Vector3()).x, "Fit went to the origin, not the part").toBeCloseTo(2e7, 0);
      expect(boxInDepthRange(rig, far), `the far part in ${rig.isOrtho() ? "ortho" : "persp"}`).toBe(true);
    }
  });

  it("keeps parts from a millimetre to a large printer inside the camera's depth range", () => {
    for (const half of [0.5, 5, 50, 250, 700]) {
      for (const make of [harness, orthoHarness]) {
        const { rig } = make();
        rig.update(0.016);
        const b = new THREE.Box3(new THREE.Vector3(-half, -half, -half), new THREE.Vector3(half, half, half));
        rig.fit(b, false);
        rig.update(0.016);
        expect(boxInDepthRange(rig, b), `a ${2 * half} mm part in ${rig.isOrtho() ? "ortho" : "persp"}`).toBe(true);
      }
    }
  });
});

// The ortho camera draws everything within ±10,000 mm of itself, BEHIND it too,
// but a pick ray starts at the camera: whatever is drawn behind it cannot be
// clicked, and a click on it selects what is under it. Fit after Isolate frames
// one small part, and a first version of the stranded-camera fix put the
// camera 2r from it, 19.9 mm from a 10 mm part inside an assembly. Show all
// then drew a housing plate in front of the part that clicked through to it.
describe("Fit in ortho after Isolate, then Show all", () => {
  function boxMesh(min: [number, number, number], max: [number, number, number]) {
    const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    m.updateMatrixWorld();
    return m;
  }

  for (const [label, make] of [["Ortho", orthoHarness], ["Auto on a straight-on view", harness]] as const) {
    it(`leaves the part in front clickable, in ${label}`, () => {
      const { rig } = make();
      rig.update(0.016);
      const part = boxMesh([-5, -5, -5], [5, 5, 5]);
      const plate = boxMesh([-100, -60, -100], [100, -40, 100]); // in front, seen from Front
      // what setModel does: the whole model is the content, and the load fits it
      rig.setContentBounds(framingBox([part, plate]));
      rig.fit(framingBox([part, plate]), false);
      rig.setStandardView("front");
      for (let i = 0; i < 600; i++) rig.update(1 / 60);
      expect(rig.isOrtho(), "the setup is not an ortho view").toBe(true);

      plate.visible = false; // Isolate the part
      rig.fit(framingBox([part, plate]), false); // Fit frames the visible bodies
      for (let i = 0; i < 5; i++) rig.update(1 / 60);
      plate.visible = true; // Show all

      const cam = rig.active as THREE.OrthographicCamera;
      cam.updateMatrixWorld();
      expect(boxInDepthRange(rig, framingBox([part])), "Fit lost the part").toBe(true);
      // a click in the middle of the view, the way picking.ts casts it
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(0, 0), cam);
      const hit = rc.intersectObjects([part, plate], false)[0];
      expect(
        hit?.object === plate ? "plate" : hit?.object === part ? "the part behind the plate" : "nothing",
        `the camera stood ${rig.controls.distance.toFixed(1)} mm from the part, inside the assembly, so the plate `
          + "in front of it was drawn but the click went through it",
      ).toBe("plate");
    });
  }
});
