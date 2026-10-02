// The viewport's per-frame work must not force a layout, and work queued with
// beforeNextDraw must land in the frame it was queued for (GH #17).
//
// Measured on the #17 reporter's sketch in Chromium: the render loop's
// pixelWorldSize read getBoundingClientRect on every drawn frame, right after a
// pointermove had dirtied the DOM, so every drag frame paid a synchronous
// layout (~0.65 ms). Every sketch badge and glyph did the same through
// projectToOverlay, and the ViewCube through its own render.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { Viewport } from "./viewport";
import viewportSrc from "./viewport.ts?raw";

/** A Viewport over a canvas that counts its layout reads. A real one needs a
 *  WebGL context, so the methods run against the prototype (same trick as
 *  regionPickRepaint.test.ts); resize() is the real one, fed by the real rect. */
function probe(rect = { left: 40, top: 60, right: 840, bottom: 660, width: 800, height: 600 }) {
  const reads = vi.fn(() => rect);
  const cam = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000);
  cam.zoom = 2;
  cam.updateProjectionMatrix();
  const vp = Object.create(Viewport.prototype) as any;
  vp.canvas = { getBoundingClientRect: reads, style: {} as Record<string, string> };
  vp.scene = { renderer: { setSize() {} } };
  vp.rig = { active: cam, resize() {} };
  vp.resolution = new THREE.Vector2();
  vp.projScratch = new THREE.Vector3();
  vp.resize(); // what the ResizeObserver runs whenever the canvas changes size
  reads.mockClear();
  return { vp: vp as Viewport, reads, cam };
}

describe("per-frame size reads come from the last resize, not from layout (GH #17)", () => {
  it("pixelWorldSize never reads the canvas rect", () => {
    const { vp, reads, cam } = probe();
    const px = vp.pixelWorldSize(new THREE.Vector3());
    // RED on 83ecd3d: one getBoundingClientRect per call, two per drawn frame
    expect(reads).not.toHaveBeenCalled();
    expect(px).toBeCloseTo((cam.top - cam.bottom) / cam.zoom / 600, 12);
  });

  it("projectToOverlay never reads the canvas rect, and still says where the canvas ends", () => {
    const { vp, reads } = probe();
    const p = vp.projectToOverlay(new THREE.Vector3(0, 0, 0));
    expect(reads).not.toHaveBeenCalled();
    expect(p).toEqual({ x: 400, y: 300, width: 800, height: 600 }); // centre of an 800x600 canvas
  });

  it("follows the canvas when it is resized", () => {
    const { vp, reads } = probe();
    reads.mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500 });
    (vp as any).resize();
    expect(vp.projectToOverlay(new THREE.Vector3(0, 0, 0))).toEqual({ x: 500, y: 250, width: 1000, height: 500 });
  });
});

describe("beforeNextDraw lands in the frame it was asked for (GH #17)", () => {
  it("runs each queued callback once, in order, and one that throws does not stop the rest", () => {
    const { vp } = probe();
    (vp as any).preDraw = []; // an instance field initialiser: Object.create skips those
    const ran: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vp.beforeNextDraw(() => ran.push("a"));
    vp.beforeNextDraw(() => { throw new Error("boom"); });
    vp.beforeNextDraw(() => {
      ran.push("c");
      vp.beforeNextDraw(() => ran.push("next frame"));
    });
    expect(ran).toEqual([]); // nothing runs until the frame does
    (vp as any).runPreDraw();
    expect(ran).toEqual(["a", "c"]);
    expect(err).toHaveBeenCalledTimes(1);
    (vp as any).runPreDraw();
    expect(ran).toEqual(["a", "c", "next frame"]);
    (vp as any).runPreDraw();
    expect(ran).toEqual(["a", "c", "next frame"]); // once each
    err.mockRestore();
  });

  // WebKitGTK starts a frame straight after an event that changed something it
  // has to repaint, and otherwise waits for its display tick; a drag move that
  // only queues work here changes nothing (GH #17). A custom property was tried
  // first and measured doing nothing there.
  it("asks the engine for that frame at once, once per frame, with a repaint nobody can see", () => {
    const { vp } = probe();
    (vp as any).preDraw = [];
    const style = (vp as any).canvas.style as Record<string, string>;
    const invisible = /^rgba\(0, 0, [01], 0\)$/; // alpha 0, over a canvas WebGL paints opaque
    vp.beforeNextDraw(() => {});
    const first = style.backgroundColor;
    expect(first).toMatch(invisible);
    vp.beforeNextDraw(() => {});
    expect(style.backgroundColor, "a frame is asked for once").toBe(first);
    (vp as any).runPreDraw();
    vp.beforeNextDraw(() => {});
    // it has to CHANGE each time: an engine repaints for a change, not a write
    expect(style.backgroundColor).not.toBe(first);
    expect(style.backgroundColor).toMatch(invisible);
  });

  it("the render loop queues the pre-draw pass as its own callback, ahead of the draw", () => {
    // Source-asserted: the loop is an instance field over a WebGL renderer. The
    // ORDER is the whole contract. A callback queued after the loop's own would
    // run after that frame's draw, which is the one-frame trail this removes;
    // and the two must be separate callbacks, because the browser only drains
    // the pre-draw work's microtasks (the drag solve) between callbacks.
    const tail = viewportSrc.slice(viewportSrc.indexOf("private loop = () => {"));
    const pre = tail.indexOf("requestAnimationFrame(() => this.runPreDraw());");
    const draw = tail.indexOf("requestAnimationFrame(this.loop);");
    expect(pre).toBeGreaterThan(-1);
    expect(draw).toBeGreaterThan(pre);
  });
});
