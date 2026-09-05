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

// Report ad6f8d54: "Trying to delete a dimension in a sketch... nothing
// happens." A line's driving length and a circle's driving diameter render
// through the ENTITY's own badge (constraintDims deliberately skips them), and
// that badge carried no onDelete at all — the right-click menu offered "Delete
// dimension" DISABLED and the Delete key fell through to entity deletion. And a
// left-click opens the inline editor and focuses it, so the Delete a user
// presses next was swallowed as text editing.
describe("an entity badge backed by a driving constraint", () => {
  const line = { type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 0 } as unknown as Parameters<
    SketchDimensions["show"]
  >[0][number];

  /** the badge SketchDimensions built for the line's length */
  const badgeOf = () => {
    const root = body().children[0]!;
    const el = root.children[0];
    if (!el) throw new Error("no badge");
    return el;
  };

  /** a live "constraint array" the host resolves the badge against, exactly as
   *  SketchMode.entityDimConstraint does */
  function mount(governed: boolean) {
    body().innerHTML = "";
    const cons = governed ? [{ type: "distance", line: "L", value: 40 }] : [];
    const dims = new SketchDimensions(viewport, () => {});
    const menu = vi.fn();
    dims.onLabelMenu = menu;
    dims.onEntityConstraint = () => (cons.length ? () => { cons.length = 0; } : "free");
    dims.show([line], plane, []);
    return { dims, cons, menu };
  }

  it("offers an ENABLED delete that removes the constraint", () => {
    const { cons, menu } = mount(true);
    badgeOf().dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
    expect(menu).toHaveBeenCalledTimes(1);
    const del = menu.mock.calls[0]![1] as (() => void) | null;
    expect(del).toBeTruthy();
    del!();
    expect(cons).toHaveLength(0);
  });

  it("the Delete key removes the badge the user right-clicked", () => {
    const { dims, cons } = mount(true);
    badgeOf().dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
    expect(dims.deleteSelected()).toBe(true);
    expect(cons).toHaveLength(0);
  });

  it("Delete in the just-opened editor deletes the DIMENSION, not the text", () => {
    const { cons } = mount(true);
    const badge = badgeOf();
    badge.dispatch("pointerdown", press(0));
    badge.dispatch("click", { stopPropagation: () => {} });
    const input = badge.querySelector("input");
    expect(input).toBeTruthy();
    input!.dispatch("keydown", { key: "Delete", stopPropagation: () => {}, preventDefault: () => {} });
    expect(cons).toHaveLength(0);
  });

  it("once the user has typed, Delete is text editing again", () => {
    const { cons } = mount(true);
    const badge = badgeOf();
    badge.dispatch("pointerdown", press(0));
    badge.dispatch("click", { stopPropagation: () => {} });
    const input = badge.querySelector("input")!;
    input.value = "4";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Delete", stopPropagation: () => {}, preventDefault: () => {} });
    expect(cons).toHaveLength(1);
  });

  it("an ungoverned length badge reads as a measurement and offers nothing to delete", () => {
    const { menu } = mount(false);
    const badge = badgeOf();
    expect(badge.className).toContain("sketch-dim-measured");
    badge.dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
    expect(menu.mock.calls[0]![1]).toBeNull();
  });

  it("a governed badge keeps the plain driving-dimension styling", () => {
    mount(true);
    expect(badgeOf().className).toBe("sketch-dim");
  });
});
