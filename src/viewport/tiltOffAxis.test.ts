// Starting an extrude on a flat sketch view swings the camera so the depth shows.
//
// Field report (2026-08-26, Thomas): "when selecting to extrude anything from a
// sketch, I want it to be like in Fusion where the camera tilts so we see a
// better view of the extrusion."
//
// The reason it matters is geometric, not cosmetic: a sketch is viewed straight
// on, so a prism grown from it extends exactly along the view axis and is
// invisible until you orbit. You are dragging a depth handle you cannot see.
//
// The GUARD is the part worth testing. Tilting unconditionally would yank the
// camera away from a viewpoint the user deliberately chose — which is a worse
// bug than the one being fixed, because it fights someone who already knows what
// they want. So it fires only from a near-straight-on view.

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { Viewport } from "./viewport";

/** The two collaborators tiltOffAxis actually touches. */
function harness(viewDir: THREE.Vector3) {
  const rotate = vi.fn();
  const vp = Object.create(Viewport.prototype) as Viewport & {
    rig: unknown;
    requestRender: () => void;
  };
  // Only the two members tiltOffAxis touches; a real Camera/CameraControls pair
  // needs a WebGL context, which is the whole reason this is a stub.
  vp.rig = {
    active: {
      getWorldDirection: (v: THREE.Vector3) => v.copy(viewDir).normalize(),
    },
    controls: { rotate },
  } as never;
  vp.requestRender = () => {};
  return { vp, rotate };
}

const Z = new THREE.Vector3(0, 0, 1);

describe("tiltOffAxis", () => {
  it("tilts when looking straight down the plane normal", () => {
    // the flat sketch view: camera looks along -Z at an XY sketch
    const { vp, rotate } = harness(new THREE.Vector3(0, 0, -1));
    expect(vp.tiltOffAxis(Z)).toBe(true);
    expect(rotate).toHaveBeenCalledTimes(1);
    // animated — a snap here would be jarring, and cancelling on user input is
    // the wanted behaviour
    expect(rotate.mock.calls[0]![2]).toBe(true);
  });

  it("tilts from the OTHER side of the plane too", () => {
    // |dot|, not dot: a sketch can be viewed from either face
    const { vp, rotate } = harness(new THREE.Vector3(0, 0, 1));
    expect(vp.tiltOffAxis(Z)).toBe(true);
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it("leaves a view the user already angled ALONE", () => {
    // 45 degrees off the normal — they can already see depth, and moving the
    // camera would be fighting them.
    const { vp, rotate } = harness(new THREE.Vector3(0, 1, -1));
    expect(vp.tiltOffAxis(Z)).toBe(false);
    expect(rotate).not.toHaveBeenCalled();
  });

  it("still tilts from a slightly-off view, so a nudge doesn't defeat it", () => {
    // ~5 degrees off: functionally still flat-on, depth still unreadable.
    const nearlyFlat = new THREE.Vector3(0, Math.tan(THREE.MathUtils.degToRad(5)), -1);
    const { vp, rotate } = harness(nearlyFlat);
    expect(vp.tiltOffAxis(Z)).toBe(true);
    expect(rotate).toHaveBeenCalled();
  });

  it("works on a plane that is not axis-aligned", () => {
    // the rule is about the angle to THIS plane's normal, not about world axes
    const n = new THREE.Vector3(1, 1, 1).normalize();
    const { vp, rotate } = harness(n.clone().negate());
    expect(vp.tiltOffAxis(n)).toBe(true);
    expect(rotate).toHaveBeenCalled();
  });
});
