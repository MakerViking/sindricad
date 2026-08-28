// The sketch view lock, and the two defaults that must not drift apart.
//
// Field report 9e3da3c7 (0.1.181, linux): "In the Sketch workspace, it is not
// possible to rotate the view. As a result, it is impossible to select geometry
// located behind the sketch support face in order to project it onto the
// sketch." Lock to Plane defaulted ON, which squares the camera to the sketch
// plane AND forbids orbiting off it — so projecting geometry that sits behind
// the face was unreachable.
//
// Entering a sketch still always squares the camera (SketchMode.enter calls
// enterSketchView unconditionally now); the lock only governs whether you may
// then orbit away, and it is off by default.
//
// The defaults live in TWO places — the palette's TOGGLES table, which draws the
// checkbox, and SketchMode.viewLocked, which is what the camera actually obeys.
// If they disagree the palette shows one thing and the camera does another, so
// the important assertion here is that they AGREE.
import { describe, it, expect } from "vitest";
import { SketchPalette } from "./sketchPalette";
import sketchModeSrc from "../sketch/sketchMode.ts?raw";

/** `private viewLocked = <value>;` as SketchMode declares it. */
function sketchModeDefault(): boolean {
  const m = /private\s+viewLocked\s*=\s*(true|false)\s*;/.exec(sketchModeSrc);
  expect(
    m,
    "no `private viewLocked = …` in sketchMode.ts — it was renamed or removed, and this "
      + "test can no longer tell whether the camera agrees with the palette checkbox",
  ).toBeTruthy();
  return m![1] === "true";
}

describe("Lock to Plane", () => {
  it("is off by default, so a sketch can be orbited away from", () => {
    expect(
      SketchPalette.defaultFor("lockView"),
      "Lock to Plane is on by default again — geometry behind the sketch support face "
        + "cannot be orbited to and so cannot be projected (field report 9e3da3c7)",
    ).toBe(false);
  });

  it("agrees with the camera state SketchMode actually applies", () => {
    // Two independent defaults for one setting. Flipping either alone leaves the
    // checkbox lying about what the camera is doing.
    expect(
      sketchModeDefault(),
      "SketchMode.viewLocked and the palette's Lock to Plane default disagree — the "
        + "checkbox shows one thing and the camera obeys the other",
    ).toBe(SketchPalette.defaultFor("lockView"));
  });

  it("still squares the camera to the plane on every sketch entry", () => {
    // The lock going off must NOT mean a sketch opens at whatever angle the
    // model view happened to be at. enter() calls enterSketchView itself now,
    // rather than relying on setViewLocked(true) to do it as a side effect.
    const at = sketchModeSrc.indexOf("setViewLocked(this.viewLocked)");
    expect(at, "SketchMode.enter no longer applies the lock preference at all").toBeGreaterThan(-1);
    const before = sketchModeSrc.slice(Math.max(0, at - 600), at);
    expect(
      before,
      "sketch entry no longer squares the camera to the plane on its own — with the lock "
        + "off by default, opening a sketch would leave the camera wherever it was",
    ).toContain("enterSketchView(");
  });

  it("keeps the toggle available for people who want it", () => {
    // The fix is a default, not a removal: locking to the plane is a real
    // preference and the palette must still offer it.
    expect(SketchPalette.toggleKeys()).toContain("lockView");
  });
});
