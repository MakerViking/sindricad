// Two palette switches that changed state and left the screen as it was.
//
// Report 9b764625: "the 'Sketch grid' tickbox does not appear to do anything.
// I don't know what a ... 'show profile' do[es]". The viewport draws ON DEMAND:
// a frame happens when the camera moves or something calls requestRender, and a
// click on the palette does neither. Sketch Grid hid the grid object and asked
// for no frame, so the grid stayed on screen until the mouse next moved over
// the canvas (measured in the real app: 0 frames drawn after the click). Show
// Profile had that gap too, and under it a second one: it hid only the
// COMMITTED sketches' fills, never those of the sketch being edited, which is
// the only sketch a palette switch can be clicked in.
//
// The effect checked is the one the user waits for: the object is no longer
// drawn, and a frame is asked for. The real click, through main.ts, runs in
// e2e/sketch_palette_e2e.cjs.
import { describe, it, expect, vi } from "vitest";

import * as THREE from "three";
import { SketchMode } from "./sketchMode";
import { SketchOverlay } from "./overlay";
import { SketchPlane } from "./plane";
import { detectRegions } from "./region";
import type { ResolvedEntity } from "./snap";
import { liveSketch } from "./liveSketch.testkit";

/** drawn = visible itself and through every parent */
function drawn(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

describe("Sketch Grid (9b764625)", () => {
  it("hides the grid and asks for the frame that shows it gone, and back", () => {
    const requestRender = vi.fn();
    const grid = new THREE.Group(); // stands in for the GridHelper on the plane
    const s = Object.create(SketchMode.prototype) as SketchMode;
    Object.assign(s, { grid, gridVisible: true, viewport: { requestRender } });
    s.setGridVisible(false);
    expect(drawn(grid)).toBe(false);
    expect(requestRender, "no frame asked for: the grid stays on screen").toHaveBeenCalledTimes(1);
    s.setGridVisible(true);
    expect(drawn(grid)).toBe(true);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });
});

describe("Show Profile (9b764625)", () => {
  it("hides the fills of the sketch being edited, and asks for the frame", () => {
    const overlay = new SketchOverlay();
    const repaint = vi.fn();
    overlay.onRepaintNeeded = repaint;
    const ents: ResolvedEntity[] = [{ type: "rectangle", id: "r", x: 0, y: 0, width: 20, height: 10 }];
    overlay.setActiveRegions(detectRegions("__active__", ents), new SketchPlane("XY"));
    const fill = (overlay as unknown as { activeRegions: { fill?: THREE.Object3D }[] }).activeRegions[0]?.fill;
    expect(fill, "the rectangle made no profile to hide").toBeTruthy();
    expect(drawn(fill!)).toBe(true);
    repaint.mockClear();

    overlay.setFillsVisible(false);
    expect(drawn(fill!), "the open sketch's profile is still drawn").toBe(false);
    expect(repaint).toHaveBeenCalled();
    overlay.setFillsVisible(true);
    expect(drawn(fill!)).toBe(true);
  });
});

// Hiding the open sketch's fills (above) made a second gap reachable: the click
// that picks a profile area kept picking it. With Show Profile off, a click
// inside a closed area selected an area nobody could see, hover lit nothing,
// and the selection went on to Extrude. Entered through SketchMode's real
// pointer handlers, over a real overlay.
describe("Show Profile off: an area you cannot see cannot be picked (9b764625)", () => {
  const rect: ResolvedEntity = { type: "rectangle", id: "r", x: 0, y: 0, width: 20, height: 10 };
  function live() {
    const l = liveSketch([rect]);
    const overlay = new SketchOverlay();
    overlay.setActiveRegions(detectRegions("__active__", [rect]), new SketchPlane("XY"));
    (l.s as unknown as { overlay: SketchOverlay }).overlay = overlay;
    const o = overlay as unknown as { selectedRegionPoints: unknown[]; hovered: unknown };
    return { ...l, overlay, picked: () => o.selectedRegionPoints.length, hovered: () => o.hovered };
  }

  it("a click inside the area selects it with the shading on, and nothing with it off", () => {
    const l = live();
    l.overlay.setFillsVisible(false);
    l.click(3, 2); // inside the rectangle, clear of its edges and the origin axes
    expect(l.picked(), "an area nobody can see was selected").toBe(0);
    l.overlay.setFillsVisible(true);
    l.click(3, 2);
    expect(l.picked(), "the same click with the shading on").toBe(1);
  });

  it("hovering the area lights nothing while it is hidden", () => {
    const l = live();
    l.move(3, 2);
    expect(l.hovered(), "the shading on: hover lights the area").toBeTruthy();
    l.overlay.setFillsVisible(false);
    l.move(3, 2.5);
    expect(l.hovered()).toBeNull();
  });
});
