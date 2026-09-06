// Free orbit: the view must not stop at the poles, and the button map must
// survive every way a drag can end.
//
// Field report 73038285 (0.1.181, linux): "The view rotation is artificially
// constrained and cannot rotate freely beyond a certain limit."
//
// camera-controls clamps the polar angle to (0, π) on every frame
// (Spherical.makeSafe), so its native ROTATE stops dead looking straight down
// and cannot carry on over the top. The rig has always had `tumble`, which
// rotates the orbit up-vector along with the camera so the pole travels with it
// and the clamp has nothing to bite — but only the SpaceMouse used it. Mouse
// orbit now takes the same path.
//
// The second half of this file is the plumbing that fix required, and is the
// riskier half: taking a press away from camera-controls means putting the
// button map BACK afterwards. Strand it on A.NONE and orbit is dead for the rest
// of the session, which is a far worse bug than the one being fixed.
//
// Stated plainly, because it matters when reading a green run: the pole tests
// below pass on the UNFIXED code too — `tumble` was always free, it just had no
// mouse caller. The two that actually discriminate the fix are "takes the middle
// button for the drag and gives it back" and "actually turns the camera while
// the drag is in flight"; both were run red against the pre-fix rig.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import CameraControls from "camera-controls";
import { harness, polarOf } from "./rig.testkit";

const A = CameraControls.ACTION;

describe("orbit passes over the pole", () => {
  it("keeps turning past straight-down instead of jamming", () => {
    // Tip the view a long way past vertical in small steps. Under the clamp the
    // camera sticks at the pole and every further step is a no-op; free orbit
    // carries on and comes out the other side.
    const { rig } = harness();
    rig.update(0.016);
    const start = rig.controls.getPosition(new THREE.Vector3()).clone().normalize();

    const step = Math.PI / 36; // 5°
    let minPolar = Infinity;
    let maxPolar = -Infinity;
    for (let i = 0; i < 72; i++) { // 360° total
      rig.tumble(0, step);
      rig.update(0.016);
      const p = polarOf(rig);
      minPolar = Math.min(minPolar, p);
      maxPolar = Math.max(maxPolar, p);
    }

    // A clamped orbit can never reach BOTH poles: makeSafe pins it just inside
    // one of them and it stops. Free orbit sweeps the whole range.
    expect(minPolar, "the view never reached the top pole — orbit is still clamped").toBeLessThan(0.05);
    expect(maxPolar, "the view never reached the bottom pole — orbit is still clamped").toBeGreaterThan(Math.PI - 0.05);

    // and a full turn comes back to where it started
    const end = rig.controls.getPosition(new THREE.Vector3()).clone().normalize();
    expect(end.dot(start), "360° of polar orbit did not return the camera to its start").toBeCloseTo(1, 2);
  });

  it("the clamp this fix routes around is real, so the test above can fail", () => {
    // The control. Driving camera-controls' own rotate() the same distance must
    // NOT sweep both poles — if it did, the assertions above would pass for the
    // wrong reason and prove nothing.
    const { rig } = harness();
    const controls = rig.controls;
    rig.update(0.016);
    let minPolar = Infinity;
    let maxPolar = -Infinity;
    for (let i = 0; i < 72; i++) {
      controls.rotate(0, Math.PI / 36, false);
      rig.update(0.016);
      const p = polarOf(rig);
      minPolar = Math.min(minPolar, p);
      maxPolar = Math.max(maxPolar, p);
    }
    expect(
      minPolar < 0.05 && maxPolar > Math.PI - 0.05,
      "camera-controls' native rotate() now sweeps both poles unclamped — the workaround "
        + "may no longer be needed, but more likely this test's polar measure is broken",
    ).toBe(false);
  });
});

describe("the button map survives every way a drag can end", () => {
  it("takes the middle button for the drag and gives it back", () => {
    const h = harness();
    expect(h.rig.controls.mouseButtons.middle, "middle does not start on ROTATE").toBe(A.ROTATE);
    h.down(1, 400, 300);
    expect(
      h.rig.controls.mouseButtons.middle,
      "camera-controls was left holding the middle button, so it will orbit too — the "
        + "view would turn at double speed",
    ).toBe(A.NONE);
    h.up();
    expect(h.rig.controls.mouseButtons.middle, "middle was stranded on NONE — orbit is now dead").toBe(A.ROTATE);
  });

  it("gives it back on pointercancel, not just a clean release", () => {
    // A lost pointer (touch interruption, a window-manager grab) never sends
    // pointerup. Stranding the map here kills orbit for the whole session.
    const h = harness();
    h.down(1, 400, 300);
    h.cancel();
    expect(h.rig.controls.mouseButtons.middle, "a cancelled drag stranded the middle button on NONE").toBe(A.ROTATE);
  });

  it("actually turns the camera while the drag is in flight", () => {
    const h = harness();
    h.rig.update(0.016);
    const before = h.rig.controls.getPosition(new THREE.Vector3()).clone();
    h.down(1, 400, 300);
    h.move(500, 300);
    h.rig.update(0.016);
    expect(
      h.rig.controls.getPosition(new THREE.Vector3()).distanceTo(before),
      "a middle-drag moved the camera not at all — the orbit never reached tumble",
    ).toBeGreaterThan(1e-3);
  });

  it("ignores pointer movement once the drag has ended", () => {
    const h = harness();
    h.down(1, 400, 300);
    h.up();
    h.rig.update(0.016);
    const after = h.rig.controls.getPosition(new THREE.Vector3()).clone();
    h.move(700, 300); // plain hover
    h.rig.update(0.016);
    expect(
      h.rig.controls.getPosition(new THREE.Vector3()).distanceTo(after),
      "the camera turned on a hover — the drag state was never cleared",
    ).toBeLessThan(1e-6);
  });

  it("leaves panning alone", () => {
    // Right-drag is TRUCK and must stay entirely with camera-controls; taking it
    // over would turn pan into orbit.
    const h = harness();
    h.down(2, 400, 300);
    expect(h.rig.controls.mouseButtons.right, "the right button was taken over — pan is now orbit").toBe(A.TRUCK);
    h.up();
    expect(h.rig.controls.mouseButtons.right).toBe(A.TRUCK);
  });

  it("leaves the left button to selection", () => {
    // Left is A.NONE unless Alt is held; a plain left press must not start an
    // orbit, or clicking would stop selecting.
    const h = harness();
    h.rig.update(0.016);
    const before = h.rig.controls.getPosition(new THREE.Vector3()).clone();
    h.down(0, 400, 300);
    h.move(500, 300);
    h.rig.update(0.016);
    expect(
      h.rig.controls.getPosition(new THREE.Vector3()).distanceTo(before),
      "a plain left-drag orbited the camera — left is reserved for selection",
    ).toBeLessThan(1e-6);
  });

  it("does not orbit while the sketch locks the view to its plane", () => {
    // setOrbitLocked puts middle on TRUCK. The interception reads the map rather
    // than re-deriving which button orbits, so this follows — but it is the
    // property a sketch depends on, so it is pinned.
    const h = harness();
    h.rig.setOrbitLocked(true);
    h.rig.update(0.016);
    const before = h.rig.controls.getPosition(new THREE.Vector3()).clone();
    h.down(1, 400, 300);
    expect(h.rig.controls.mouseButtons.middle, "the locked middle button was taken for an orbit").toBe(A.TRUCK);
    const dirBefore = before.clone().sub(h.rig.controls.getTarget(new THREE.Vector3())).normalize();
    h.move(500, 300);
    h.rig.update(0.016);
    // A locked middle-drag PANS (TRUCK): the camera and its target move together
    // and the view direction does not change. The old assertion wanted the
    // camera position itself unmoved, which only held while the stub events
    // never reached camera-controls' own truck at all.
    const dirAfter = h.rig.controls.getPosition(new THREE.Vector3()).sub(h.rig.controls.getTarget(new THREE.Vector3())).normalize();
    expect(dirAfter.dot(dirBefore), "the view orbited off the sketch plane while locked to it").toBeGreaterThan(1 - 1e-9);
  });
});
