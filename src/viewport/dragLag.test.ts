// A drag follows the pointer (field report dd5ade19: "a perceptible delay
// between moving the mouse and the corresponding movement on the screen").
//
// camera-controls smooths every drag toward its target with
// draggingSmoothTime, 0.125 s by default. Mouse ORBIT is immune (it goes through
// tumbleBy -> setLookAt with the transition off), so the lag lived in the
// right-drag pan and in touch gestures. The oracle is the view itself: after a
// pan of 200 px and two rendered frames, how much of the travel has the orbit
// target actually covered? Under the default it is well under half; a pointer
// that is followed covers nearly all of it. getTarget/getPosition are read with
// receiveEndValue = false: the default returns the END of the damped motion,
// which is where the view will be, not where it is drawn.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { harness } from "./rig.testkit";

function panTravel(frames: number): { after: number; settled: number } {
  const h = harness();
  h.rig.update(0.016);
  const start = h.rig.controls.getTarget(new THREE.Vector3(), false);
  h.down(2, 400, 300); // right button = TRUCK (pan)
  h.move(600, 300);
  for (let i = 0; i < frames; i++) h.rig.update(1 / 60);
  const after = h.rig.controls.getTarget(new THREE.Vector3(), false).distanceTo(start);
  for (let i = 0; i < 120; i++) h.rig.update(1 / 60); // let it settle fully
  const settled = h.rig.controls.getTarget(new THREE.Vector3(), false).distanceTo(start);
  h.up();
  return { after, settled };
}

describe("a pan follows the pointer instead of trailing it", () => {
  it("covers nearly all of a drag's travel within two frames", () => {
    const { after, settled } = panTravel(2);
    expect(settled, "the pan moved the view at all").toBeGreaterThan(0);
    // RED on the library default (0.125 s): ~0.27 of the travel after two
    // frames, the rest arriving over the next tenth of a second.
    expect(after / settled, "fraction of the pan travel on screen two frames after the move").toBeGreaterThan(0.85);
  });

  it("mouse orbit has never lagged: one frame is the whole turn", () => {
    const h = harness();
    h.rig.update(0.016);
    const before = h.rig.controls.getPosition(new THREE.Vector3(), false);
    h.down(1, 400, 300);
    h.move(430, 300);
    h.rig.update(1 / 60);
    const oneFrame = h.rig.controls.getPosition(new THREE.Vector3(), false).distanceTo(before);
    for (let i = 0; i < 60; i++) h.rig.update(1 / 60);
    const settled = h.rig.controls.getPosition(new THREE.Vector3(), false).distanceTo(before);
    h.up();
    expect(oneFrame).toBeGreaterThan(0);
    expect(oneFrame / settled).toBeGreaterThan(0.99);
  });
});
