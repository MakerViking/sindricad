// Field report ab855a5b: sketch dimension labels and constraint glyphs painted
// over the ribbon, the browser tree and the inspector, and — because they carry
// pointer-events — took the clicks aimed at those panels. Both layers were
// mounted on <body>, positioned in window coordinates, and written every frame
// with whatever projectToScreen returned, however far outside the canvas that
// was.
//
// These run the real SketchDimensions and SketchGlyphs against the fakeDom stub
// and observe what a user would see: is the badge still drawn, and where. The
// plane and the projection are pass-throughs, so an anchor's coordinates ARE
// the overlay pixel it lands on — (100, 120) is on the canvas, (-500, 120) is
// off its left edge, which is exactly where the browser tree sits.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, byClass, installFakeDocument } from "../ui/fakeDom.testkit";
import { ndcToRect, outsideRect } from "../viewport/overlayHost";
import { SketchDimensions } from "./sketchDimensions";
import { SketchGlyphs } from "./sketchGlyphs";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";

// The clipping layer the fix added, resolved by id exactly as index.html's is.
// Installing it means these run the REAL mounting path instead of the off-page
// fallback to <body>, which is the shape of the bug being fixed.
const host = new FakeEl("div");
installFakeDocument({ "viewport-overlay": host });

// The reposition loop rides on rAF. Keep the callback instead of dropping it,
// so a test can run a second pass — which is what a camera move does.
let nextFrame: (() => void) | null = null;
vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
  nextFrame = cb;
  return 1;
});
vi.stubGlobal("cancelAnimationFrame", () => {});

const W = 900;
const H = 700;
// where the canvas starts in the WINDOW, i.e. what projectToScreen adds on top
// of the canvas-local pixel: the browser tree's width, and the titlebar plus
// ribbon's height. A layer mounted inside the viewport must not use these.
const LEFT = 232;
const TOP = 125;
const cam = new THREE.PerspectiveCamera();
let panX = 0;

const plane = {
  to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0),
} as unknown as SketchPlane;

const viewport = {
  camera: cam,
  projectToScreen: (w: THREE.Vector3) => ({ x: w.x + panX + LEFT, y: w.y + TOP }),
  projectToOverlay: (w: THREE.Vector3) => ({ x: w.x + panX, y: w.y, width: W, height: H }),
} as unknown as Viewport;

/** what panning the camera does: the projection shifts and the next frame runs */
const panBy = (dx: number) => {
  panX += dx;
  cam.position.x += 1; // camHash must change or the loop skips the pass
  nextFrame?.();
};

const body = () => (globalThis as unknown as { document: { body: FakeEl } }).document.body;
const dimAt = (x: number, y: number) => ({
  anchor: new THREE.Vector2(x, y),
  valueMm: 10,
  commit: () => {},
});
const dblclick = { stopPropagation: () => {}, preventDefault: () => {} };
/** the pixel a badge was placed at, read back out of the transform it wrote */
const placedAt = (el: FakeEl) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform ?? "");
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

beforeEach(() => {
  host.innerHTML = "";
  body().innerHTML = "";
  panX = 0;
  nextFrame = null;
});

describe("sketch labels stay inside the viewport", () => {
  it("mounts both label layers in the clipping host, not on the body", () => {
    new SketchDimensions(viewport, () => {});
    new SketchGlyphs(viewport);
    expect(host.children.map((c) => c.className).sort()).toEqual(["sketch-dims", "sketch-glyphs"]);
    // the body is where they used to live, and where they floated over the panels
    expect(body().children).toHaveLength(0);
  });

  it("draws a dimension badge at its OVERLAY pixel, not its window pixel", () => {
    const dims = new SketchDimensions(viewport, () => {});
    dims.show([], plane, [dimAt(100, 120)]);
    const badge = byClass(host, "sketch-dim")[0]!;
    expect(badge.style.transform).toBe("translate(100px, 120px) translate(-50%, -50%)");
    expect(badge.style.visibility).not.toBe("hidden");
  });

  it("hides a dimension badge whose anchor has left the canvas", () => {
    const dims = new SketchDimensions(viewport, () => {});
    dims.show([], plane, [dimAt(100, 120)]);
    const badge = byClass(host, "sketch-dim")[0]!;
    const drawn = badge.style.transform;

    panBy(-600); // the anchor is now 500 px left of the canvas, over the tree

    expect(badge.style.visibility).toBe("hidden");
    // and no new placement was written: nothing to half-draw at the edge
    expect(badge.style.transform).toBe(drawn);
  });

  it("hides a badge that has run off the RIGHT edge too", () => {
    const dims = new SketchDimensions(viewport, () => {});
    dims.show([], plane, [dimAt(800, 120)]);
    const badge = byClass(host, "sketch-dim")[0]!;

    panBy(300); // x = 1100 against a 900-wide canvas: over the inspector

    expect(badge.style.visibility).toBe("hidden");
  });

  it("shows it again when the anchor comes back", () => {
    const dims = new SketchDimensions(viewport, () => {});
    dims.show([], plane, [dimAt(100, 120)]);
    const badge = byClass(host, "sketch-dim")[0]!;
    panBy(-600);
    expect(badge.style.visibility).toBe("hidden");

    panBy(600);

    expect(badge.style.visibility).toBe("");
    expect(badge.style.transform).toBe("translate(100px, 120px) translate(-50%, -50%)");
  });

  it("keeps the badge being EDITED visible, so an open editor never vanishes", () => {
    const dims = new SketchDimensions(viewport, () => {});
    dims.show([], plane, [dimAt(100, 120), dimAt(140, 160)]);
    const [edited, other] = byClass(host, "sketch-dim");
    edited!.dispatch("dblclick", dblclick); // opens the inline value editor
    expect(edited!.querySelector("input")).not.toBeNull();

    panBy(-600); // both anchors leave the canvas

    expect(edited!.style.visibility).not.toBe("hidden");
    expect(edited!.querySelector("input")).not.toBeNull();
    expect(other!.style.visibility).toBe("hidden"); // control: only the editor is spared
  });

  // Being exempt from the cull is not the same as being on screen: the host
  // clips, so a badge left at its projected pixel (x = -500 against a 900-wide
  // canvas) is invisible while still holding the caret and still committing on
  // Enter. The decision was that the label being edited STAYS VISIBLE.
  it("pins the badge being edited inside the canvas, whole, instead of past its edge", () => {
    const dims = new SketchDimensions(viewport, () => {});
    dims.show([], plane, [dimAt(100, 120)]);
    const badge = byClass(host, "sketch-dim")[0]!;
    badge.offsetWidth = 60; // what the browser lays the badge out as
    badge.offsetHeight = 20;
    badge.dispatch("dblclick", dblclick);

    panBy(-600);

    const at = placedAt(badge)!;
    expect(at.y).toBe(120); // the axis that never left the canvas does not move
    // inset by half the badge, so no part of it is outside the clip
    expect(at.x).toBeGreaterThanOrEqual(30);
    expect(at.x).toBeLessThanOrEqual(W - 30);
  });

  it("hides a constraint glyph whose anchor has left the canvas", () => {
    const glyphs = new SketchGlyphs(viewport);
    glyphs.show(
      [{ cIndex: 0, label: "T", pos: new THREE.Vector2(100, 120) }],
      plane,
      new Set(),
      new Set(),
    );
    const badge = byClass(host, "sketch-glyph")[0]!;
    expect(badge.style.transform).toBe("translate(100px, 120px) translate(-50%, -50%)");

    panBy(-600);

    expect(badge.style.visibility).toBe("hidden");
  });
});

// The projections above are pass-throughs so the placement rules can be read at
// a glance. This pins the arithmetic they stand in for — the mapping wrapped
// around THREE's own `.project()`, and the only reason "the anchor left the
// canvas" is answerable at all.
describe("ndcToRect", () => {
  it("puts the centre of the view in the middle and flips y to screen order", () => {
    const rect = { width: W, height: H };
    expect(ndcToRect({ x: 0, y: 0 }, rect)).toEqual({ x: W / 2, y: H / 2 });
    expect(ndcToRect({ x: -1, y: 1 }, rect)).toEqual({ x: 0, y: 0 }); // top-left
    expect(ndcToRect({ x: 1, y: -1 }, rect)).toEqual({ x: W, y: H }); // bottom-right
  });

  it("sends a world point projected off the canvas to a pixel outside it", () => {
    const rect = { width: W, height: H };
    const eye = new THREE.PerspectiveCamera(50, W / H, 0.1, 1000);
    eye.position.set(0, 0, 100);
    eye.lookAt(0, 0, 0);
    eye.updateMatrixWorld();

    const middle = ndcToRect(new THREE.Vector3(0, 0, 0).project(eye), rect);
    expect(middle.x).toBeCloseTo(W / 2);
    expect(middle.y).toBeCloseTo(H / 2);

    // far off to the left of anything the camera frames at that distance
    const away = new THREE.Vector3(-500, 0, 0).project(eye);
    const p = { ...ndcToRect(away, rect), width: W, height: H };
    expect(p.x).toBeLessThan(0);
    expect(outsideRect(p)).toBe(true);
  });
});
