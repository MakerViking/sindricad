// DOUBLE-CLICK, in a Chromium webview, on an element whose own pointerdown
// rebuilds the UI.
//
// Two paths depended on the browser's double-click and neither one ever fired:
//
//  1. A dimension badge whose click is claimed by geometry underneath it is
//     supposed to stay editable via a double-click (the documented escape
//     hatch). But claiming the click rebuilds every badge, and Chromium fires
//     NEITHER `click` NOR `dblclick` when a pointerdown handler detaches the
//     pressed element — measured with playwright-core against /usr/bin/chromium:
//     a detaching handler yields `pointerdown, pointerdown` and nothing else,
//     not even on the container. So the hatch was a comment, not a behaviour.
//
//  2. SketchMode's "double-click a pattern copy to edit the pattern" and
//     "double-click text to re-open the text panel" gate on `e.detail >= 2`
//     inside a handler registered on `pointerdown`. `PointerEvent.detail` is
//     always 0 there (measured: `mousedown` carries 1 then 2, `pointerdown`
//     carries 0), so both were dead in the shipped webview.
//
// Both now recognise the second press themselves, from its time and position.
// These tests observe the EFFECT — an editor input in the badge, the pattern
// editor opening — not that a handler ran.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, byClass, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchDimensions } from "./sketchDimensions";
import { SketchMode } from "./sketchMode";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";
import type { ResolvedEntity } from "./snap";

installFakeDocument();
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

const viewport = {
  camera: new THREE.PerspectiveCamera(),
  projectToScreen: () => ({ x: 0, y: 0 }),
} as unknown as Viewport;

const plane = {
  to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0),
} as unknown as SketchPlane;

const press = (x = 100, y = 100) => ({
  button: 0,
  shiftKey: false,
  ctrlKey: false,
  clientX: x,
  clientY: y,
  pointerId: 1,
  stopPropagation: () => {},
  preventDefault: () => {},
});

const body = () => (globalThis as unknown as { document: { body: FakeEl } }).document.body;

describe("a badge whose click geometry keeps stays editable by double-press", () => {
  let dims: SketchDimensions;
  let overlap: ReturnType<typeof vi.fn>;
  let badge: FakeEl;

  const build = (driven = false) => {
    body().innerHTML = "";
    dims = new SketchDimensions(viewport, () => {});
    overlap = vi.fn(() => true); // geometry claims every click
    dims.onOverlapPick = overlap as unknown as (e: PointerEvent) => boolean;
    dims.show([], plane, [{ anchor: new THREE.Vector2(0, 0), valueMm: 10, commit: () => {}, ...(driven ? { driven: true } : {}) }]);
    badge = byClass(body(), driven ? "sketch-dim sketch-dim-driven" : "sketch-dim")[0]!;
  };

  beforeEach(() => build());

  it("opens the value editor on the second press", () => {
    badge.dispatch("pointerdown", press());
    expect(badge.querySelector("input"), "the first press must still go to geometry").toBeNull();
    badge.dispatch("pointerdown", press());
    expect(badge.querySelector("input"), "no editor opened on the second press").not.toBeNull();
    expect(overlap, "the second press was forwarded to geometry again").toHaveBeenCalledTimes(1);
  });

  it("a second press somewhere else is a fresh single press", () => {
    badge.dispatch("pointerdown", press(100, 100));
    badge.dispatch("pointerdown", press(140, 100));
    expect(badge.querySelector("input")).toBeNull();
    expect(overlap).toHaveBeenCalledTimes(2);
  });

  it("a second press a second later is a fresh single press", () => {
    // the boundary, not the bug: two deliberate clicks on a badge that sits on
    // geometry must both keep going to the geometry
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    badge.dispatch("pointerdown", press());
    now.mockReturnValue(1000);
    badge.dispatch("pointerdown", press());
    expect(badge.querySelector("input")).toBeNull();
    expect(overlap).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("does not open an editor on a REFERENCE dimension, which is read-only", () => {
    build(true);
    badge.dispatch("pointerdown", press());
    badge.dispatch("pointerdown", press());
    expect(badge.querySelector("input")).toBeNull();
  });
});

// --- the canvas half: e.detail is 0 on pointerdown -------------------------

const PAT: ResolvedEntity = { type: "line", id: "pat1#1", x1: 0, y1: 0, x2: 10, y2: 0 };
const TEXT = { type: "text", id: "t1", x: 0, y: 0, text: "hi", size: 5 } as unknown as ResolvedEntity;

function makeMode(opts: { derived?: ResolvedEntity[]; text?: ResolvedEntity | null } = {}) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const calls = { pattern: [] as string[], text: 0 };
  Object.assign(s, {
    tool: "select",
    entities: [],
    selected: new Set<string>(),
    dims: { clearSelection() {} },
    overlay: { activeRegionAt: () => null },
    viewport: { domElement: { setPointerCapture() {} } },
    snapAt: () => ({ p: new THREE.Vector2(0, 0), kind: "free" }),
    planePoint: () => new THREE.Vector2(0, 0),
    pickPoint: () => null,
    pickTol: () => 0.9,
    derivedEntities: () => opts.derived ?? [],
    textEntityAt: () => opts.text ?? null,
    editPattern: (id: string) => { calls.pattern.push(id); },
    editText: () => { calls.text++; },
  });
  const down = (e: ReturnType<typeof press>) =>
    (s as unknown as { onPointerDown: (e: PointerEvent) => void }).onPointerDown(e as unknown as PointerEvent);
  return { down, calls };
}

describe("double-click on the canvas, where PointerEvent.detail is always 0", () => {
  it("opens the owning pattern on the second press over a derived copy", () => {
    const { down, calls } = makeMode({ derived: [PAT] });
    down(press());
    expect(calls.pattern, "a single click must select, never edit").toEqual([]);
    down(press());
    expect(calls.pattern).toEqual(["pat1"]);
  });

  it("re-opens the text panel on the second press over text", () => {
    const { down, calls } = makeMode({ text: TEXT });
    down(press());
    expect(calls.text).toBe(0);
    down(press());
    expect(calls.text).toBe(1);
  });

  it("two presses far apart are two single clicks", () => {
    const { down, calls } = makeMode({ derived: [PAT] });
    down(press(100, 100));
    down(press(100, 160));
    expect(calls.pattern).toEqual([]);
  });
});
