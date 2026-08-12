// Alt/Option + left-drag stands in for a middle-drag, for mice and trackballs
// that have no middle button (reported on a Mac trackball: right-drag panned, but
// nothing could free-orbit, so the view could only ever snap to standard views).
//
// The property that matters most here is NOT that orbit works. It is that left
// click still SELECTS. An earlier approach tracked Alt through keydown/keyup, the
// way the Shift+middle swap still does, and that desyncs the moment a keyup is
// missed (Cmd-Tab away holding Option, focus loss, a window manager that grabs
// Alt+drag). Left would then stay stuck on ROTATE and selection would be dead.
// Deriving the action from the event that is being handled cannot desync, and
// these tests pin that.
import { describe, it, expect } from "vitest";
import CameraControls from "camera-controls";
import { leftButtonAction } from "./cameras";

const A = CameraControls.ACTION;

describe("leftButtonAction", () => {
  it("leaves left alone for selection whenever Alt is not held", () => {
    // every combination without Alt must be NONE — this is the guard that keeps
    // clicking able to select at all
    for (const shift of [false, true]) {
      for (const locked of [false, true]) {
        expect(leftButtonAction(false, shift, locked)).toBe(A.NONE);
      }
    }
  });

  it("orbits on Alt+left, which is the whole point", () => {
    expect(leftButtonAction(true, false, false)).toBe(A.ROTATE);
  });

  it("pans on Shift+Alt+left, mirroring Shift+middle", () => {
    expect(leftButtonAction(true, true, false)).toBe(A.TRUCK);
  });

  it("pans instead of orbiting while the sketch locks the view to its plane", () => {
    // setOrbitLocked puts `middle` on TRUCK; Alt+left has to agree, or the
    // "Option+left is middle" rule quietly stops holding inside a sketch
    expect(leftButtonAction(true, false, true)).toBe(A.TRUCK);
    expect(leftButtonAction(true, true, true)).toBe(A.TRUCK);
  });

  it("never returns ROTATE without Alt, however the other flags fall", () => {
    // stated separately from the first test because this is the regression that
    // would break selection rather than merely fail to orbit
    const withoutAlt = [
      leftButtonAction(false, false, false),
      leftButtonAction(false, true, false),
      leftButtonAction(false, false, true),
      leftButtonAction(false, true, true),
    ];
    expect(withoutAlt.some((a) => a === A.ROTATE)).toBe(false);
  });
});
