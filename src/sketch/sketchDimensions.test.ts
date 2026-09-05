// A dimension badge sits ON the geometry it labels — a line's length badge
// lands at the line's midpoint, which is exactly where a user aims to
// right-click that line. The badge's pointerdown had no button guard, so a
// RIGHT press ran onOverlapPick (SketchMode.labelOverlapSelect), which replaces
// the whole selection with the one entity under the cursor. With two lines
// selected for a Parallel/Perpendicular constraint that ate the selection
// before the context menu was ever built.
//
// These run the real SketchDimensions against the fakeDom stub (no jsdom), so
// they observe the EFFECT a user would notice — did the selection hook fire,
// did the badge get marked selected — not that a guard exists in the source.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, byClass, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchDimensions } from "./sketchDimensions";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";

installFakeDocument();
// the badge reposition loop rides on rAF, which node has no notion of; the stub
// returns a handle and never re-enters, so show() runs exactly one pass
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

const viewport = {
  camera: new THREE.PerspectiveCamera(),
  projectToScreen: () => ({ x: 0, y: 0 }),
  projectToOverlay: () => ({ x: 0, y: 0, width: 900, height: 700 }),
} as unknown as Viewport;

const plane = {
  to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0),
} as unknown as SketchPlane;

/** A pointerdown as the browser delivers it, with the fields the handler reads. */
const press = (button: number, shiftKey = false) => ({
  button,
  shiftKey,
  clientX: 100,
  clientY: 100,
  pointerId: 1,
  stopPropagation: () => {},
  preventDefault: () => {},
});

const body = () => (globalThis as unknown as { document: { body: FakeEl } }).document.body;

describe("dimension badge: which mouse button acts", () => {
  let dims: SketchDimensions;
  let overlap: ReturnType<typeof vi.fn>;
  let badge: FakeEl;

  beforeEach(() => {
    body().innerHTML = "";
    dims = new SketchDimensions(viewport, () => {});
    overlap = vi.fn(() => true); // "geometry under the cursor claimed the pick"
    dims.onOverlapPick = overlap as unknown as (e: PointerEvent) => boolean;
    dims.show([], plane, [{ anchor: new THREE.Vector2(0, 0), valueMm: 10, commit: () => {} }]);
    const found = byClass(body(), "sketch-dim");
    expect(found).toHaveLength(1);
    badge = found[0]!;
  });

  it("ignores a right press, so the selection survives to the context menu", () => {
    badge.dispatch("pointerdown", press(2));
    expect(overlap).not.toHaveBeenCalled();
    expect(badge.classList.contains("is-selected")).toBe(false);
  });

  it("ignores a middle press (it belongs to camera pan)", () => {
    badge.dispatch("pointerdown", press(1));
    expect(overlap).not.toHaveBeenCalled();
  });

  it("still acts on a left press", () => {
    badge.dispatch("pointerdown", press(0));
    expect(overlap).toHaveBeenCalledTimes(1);
  });

  it("still forwards Shift+left, which toggles membership", () => {
    badge.dispatch("pointerdown", press(0, true));
    expect(overlap).toHaveBeenCalledTimes(1);
    expect((overlap.mock.calls[0]![0] as { shiftKey: boolean }).shiftKey).toBe(true);
  });

  it("marks the badge selected on a left press that geometry did not claim", () => {
    overlap.mockReturnValue(false);
    badge.dispatch("pointerdown", press(0));
    expect(badge.classList.contains("is-selected")).toBe(true);
  });

  it("opens the badge's own menu on the right-click that follows", () => {
    // the guard returns early, so the contextmenu listener registered after it
    // must still be wired — a right press then a right-click is one gesture
    const menu = vi.fn();
    dims.onLabelMenu = menu;
    badge.dispatch("pointerdown", press(2));
    badge.dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
    expect(menu).toHaveBeenCalledTimes(1);
    expect(byClass(body(), "sketch-dim")).toHaveLength(1);
  });
});
