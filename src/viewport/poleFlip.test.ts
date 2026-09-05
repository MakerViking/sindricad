// The Top and Bottom views used to leave the orbit up-vector lying exactly along
// the line you were looking down, so there was no well-defined "up" left to turn
// around and the picture snapped through a quarter turn on every mouse move and
// every wheel notch.
//
// Field report ada02e3d (0.1.196): "every rotation increment adjusts the view
// angle by 90 degrees ... when zooming in/out or using the mouse to change the
// view angle".
//
// Mechanism, for whoever reads a red run: `setStandardView("top")` forced
// camera.up to world +Z and then put the camera on +Z, so up was PARALLEL to the
// view axis. `tumbleBy` rotates the offset and the up-vector by the SAME
// quaternion, and a rotation preserves the angle between two vectors — so once
// that angle is 0 it is 0 forever, and every `controls.setLookAt` rebuilt the
// camera basis from a cross product of magnitude ~1e-16, i.e. from float noise.
//
// These tests measure the RENDERED camera basis and the world position, not
// which function ran. The control at the bottom (the same drag from Front) is
// what stops the thresholds passing vacuously.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { harness } from "./rig.testkit";

/** The camera's screen-right axis, from the matrix that actually gets rendered. */
function screenRight(rig: { active: THREE.Camera }): THREE.Vector3 {
  rig.active.updateMatrixWorld();
  return new THREE.Vector3().setFromMatrixColumn(rig.active.matrixWorld, 0).normalize();
}

const deg = (a: THREE.Vector3, b: THREE.Vector3) =>
  (Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)) * 180) / Math.PI;

/** Let a transitioned move (setStandardView animates) finish. Measuring a drag
 *  mid-flight reads the transition's own turn and every case looks broken. */
function settle(rig: { update(dt: number): boolean }) {
  for (let i = 0; i < 600; i++) if (!rig.update(0.016)) return;
}

/** Middle-drag eight 3-pixel steps, reporting the per-step turn of the screen
 *  basis and how far the camera walked. */
function dragEightSteps(h: ReturnType<typeof harness>) {
  const { rig } = h;
  settle(rig);
  const start = rig.controls.getPosition(new THREE.Vector3()).clone();
  let prev = screenRight(rig);
  const turns: number[] = [];
  h.down(1, 400, 300);
  for (let i = 1; i <= 8; i++) {
    h.move(400 + i * 3, 300);
    rig.update(0.016);
    const now = screenRight(rig);
    turns.push(deg(prev, now));
    prev = now;
  }
  h.up();
  const moved = rig.controls.getPosition(new THREE.Vector3()).distanceTo(start);
  return { turns, moved };
}

describe("orbiting from a pole view", () => {
  it("a middle-drag at Top orbits instead of flipping", () => {
    const h = harness();
    h.rig.setStandardView("top");
    settle(h.rig);
    const { turns, moved } = dragEightSteps(h);
    for (const t of turns) {
      expect(t, `a 3px drag step turned the view ${t.toFixed(1)}° — the camera basis is flipping`).toBeLessThan(5);
    }
    expect(moved, "the camera never orbited away from the top pole").toBeGreaterThan(20);
  });

  it("a middle-drag at Bottom orbits instead of flipping", () => {
    const h = harness();
    h.rig.setStandardView("bottom");
    settle(h.rig);
    const { turns, moved } = dragEightSteps(h);
    for (const t of turns) {
      expect(t, `a 3px drag step turned the view ${t.toFixed(1)}° — the camera basis is flipping`).toBeLessThan(5);
    }
    expect(moved, "the camera never orbited away from the bottom pole").toBeGreaterThan(20);
  });

  it("a wheel notch after an orbit from Top does not re-aim the view", () => {
    // The reporter saw the flip on zoom too. It needs one orbit first: from a
    // CLEAN Top the basis is degenerate but stationary, and it is the tumble
    // that starts feeding noise into it.
    const h = harness();
    const { rig } = h;
    rig.setStandardView("top");
    settle(rig);
    rig.tumble(-0.05, 0);
    settle(rig);
    let prev = screenRight(rig);
    const pivot = new THREE.Vector3(10, 5, 0);
    for (let i = 0; i < 5; i++) {
      rig.zoomBy(0.9, pivot);
      settle(rig);
      const now = screenRight(rig);
      const t = deg(prev, now);
      expect(t, `a wheel notch turned the view ${t.toFixed(1)}° — zoom is re-aiming the camera`).toBeLessThan(1);
      prev = now;
    }
  });

  it("survives an up-vector deliberately laid on the view axis", () => {
    // `viewport.captureOverrideFace` falls back to up = (0,0,1) when the picked
    // face's normal×xdir degenerates, and that override is PERSISTED in the
    // document and replayed through setViewDir — a second door into the same
    // degenerate basis. The orbit itself has to refuse to sit on it.
    const h = harness();
    h.rig.setViewDir(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1));
    settle(h.rig);
    const { turns, moved } = dragEightSteps(h);
    for (const t of turns) {
      expect(t, `a 3px drag step turned the view ${t.toFixed(1)}° — the degenerate up was not re-seated`).toBeLessThan(5);
    }
    expect(moved, "the camera never orbited away from the degenerate axis").toBeGreaterThan(20);
  });

  it("the same drag from Front turns smoothly, so the thresholds above are not vacuous", () => {
    // The control. Front has never been degenerate; if this ever flips, the
    // measurement above is broken rather than the code under test.
    const h = harness();
    h.rig.setStandardView("front");
    settle(h.rig);
    const { turns, moved } = dragEightSteps(h);
    for (const t of turns) {
      expect(t, "a plain front-view drag is flipping — this test's measurement is broken").toBeLessThan(5);
    }
    expect(moved, "a plain front-view drag did not move the camera — the harness is not driving an orbit").toBeGreaterThan(20);
  });
});
