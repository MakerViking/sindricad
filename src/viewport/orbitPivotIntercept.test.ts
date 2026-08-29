// The orbit pivot must survive mouse orbit being taken away from camera-controls.
//
// Two features landed independently and collide in a way that merges CLEANLY and
// then does nothing:
//
//   - PR #45 added "choose what the view swings around": the viewport hangs
//     applyOrbitPivot() off camera-controls' `controlstart` event, and gates it
//     on rig.isOrbiting(), which reads `controls.currentAction & A.ROTATE`.
//   - 0.1.186 rewired MOUSE orbit through the rig's own tumble() so it can pass
//     the poles (field report 73038285), which means taking the press away from
//     camera-controls: `mouseButtons[slot] = A.NONE` on pointerdown.
//
// After the merge, camera-controls never begins a gesture for a mouse orbit. So
// `controlstart` never fires, `currentAction` never contains A.ROTATE, and the
// pivot is silently never applied — to the one gesture it exists for. Touch
// orbit would still work, making it look intermittent rather than broken.
//
// The existing pivot tests all MOCK isOrbiting, so none of them can see this.
// These drive the real rig.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { harness } from "./rig.testkit";

describe("an intercepted mouse orbit still reaches the pivot", () => {
  it("reports itself as orbiting while the drag is in flight", () => {
    const h = harness();
    expect(h.rig.isOrbiting(), "idle rig claims to be orbiting").toBe(false);
    h.down(1, 400, 300); // middle press = orbit, taken from camera-controls
    expect(
      h.rig.isOrbiting(),
      "a mouse orbit reports NOT orbiting, so applyOrbitPivot bails and the chosen "
        + "pivot is never used",
    ).toBe(true);
    h.up();
    expect(h.rig.isOrbiting(), "the drag ended but the rig still claims to orbit").toBe(false);
  });

  it("announces the start, since camera-controls' controlstart cannot", () => {
    const h = harness();
    let starts = 0;
    h.rig.setOnOrbitStart(() => starts++);
    h.down(1, 400, 300);
    expect(
      starts,
      "nothing announced the orbit start, so the viewport never aims the pivot",
    ).toBe(1);
    h.up();
    h.down(1, 400, 300);
    expect(starts, "a second orbit did not announce itself").toBe(2);
  });

  it("does not announce a start for a gesture that is not an orbit", () => {
    // Right-drag is TRUCK and stays with camera-controls, which fires its own
    // controlstart. Announcing here too would apply a pivot to a pan.
    const h = harness();
    let starts = 0;
    h.rig.setOnOrbitStart(() => starts++);
    h.down(2, 400, 300); // right = pan
    expect(starts, "a pan announced itself as an orbit start").toBe(0);
    h.up();
    h.down(0, 400, 300); // plain left = selection
    expect(starts, "a selection click announced itself as an orbit start").toBe(0);
  });

  it("does not announce a start while the sketch locks the view", () => {
    const h = harness();
    let starts = 0;
    h.rig.setOnOrbitStart(() => starts++);
    h.rig.setOrbitLocked(true);
    h.down(1, 400, 300); // middle is TRUCK while locked
    expect(starts, "a locked view announced an orbit start").toBe(0);
    expect(h.rig.isOrbiting(), "a locked view reported itself as orbiting").toBe(false);
  });

  it("keeps the pivot through the frames of the drag it was set for", () => {
    // update() folds a finished pivot away when camera-controls is idle — which,
    // during an intercepted orbit, it always is. Without the drag guard the
    // pivot is cleared on the very first frame after it is set, so the orbit
    // swings about the view centre after all.
    const h = harness();
    h.down(1, 400, 300);
    h.rig.setOrbitPivot(new THREE.Vector3(10, 0, 0));
    const t0 = h.rig.controls.getTarget(new THREE.Vector3()).clone();
    h.rig.update(0.016);
    h.rig.update(0.016);
    const t1 = h.rig.controls.getTarget(new THREE.Vector3());
    expect(
      t1.distanceTo(t0),
      "the pivot was folded away mid-drag — update() cleared it because "
        + "camera-controls is idle during an intercepted orbit",
    ).toBeLessThan(1e-6);
  });
});
