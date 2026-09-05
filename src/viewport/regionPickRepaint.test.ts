// Clicking a visible sketch's profile AREA in the model view has to repaint.
//
// Report a58966e5: "Click on an area to select it, does not highlight until I
// move the mouse. It does say it is selected." The selection really happened —
// only the frame was missing, because the viewport draws ON DEMAND and the
// region branch of handleClick was the one selection path that never marked the
// frame dirty.
//
// WHAT THIS TEST OBSERVES: the DRAW GATE, not pixels. There is no WebGL in a
// headless run, so the closest observable effect is the pair of fields loop()
// reads to decide whether to call renderer.render — needsRender / lingerFrames.
// A source assertion below pins that gate, so this test dies loudly if the two
// fields are ever renamed and it stops meaning anything. Asserting "a spy was
// called" would be a call-shaped test and proves nothing about the screen.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Viewport } from "./viewport";
import viewportSrc from "./viewport.ts?raw";
import mainSrc from "../main.ts?raw";
import { SketchOverlay, SELECT_COLOR } from "../sketch/overlay";
import type { CadDocument } from "../types";

// The reporter's own document, copied out of their report (bug-reports/ is not
// in the repo): one XY sketch, one circle, no features — so the sketch is
// visible and its single profile area is click-selectable in the model view.
const doc = {
  version: 5,
  features: [
    {
      id: "f1",
      type: "sketch",
      plane: "XY",
      entities: [
        {
          id: "e2",
          type: "circle",
          x: -47.03314313588676,
          y: 29.133252723679856,
          radius: 18.232308360403255,
        },
      ],
    },
  ],
  parameters: {},
} as unknown as CadDocument;

function overlayFor(): SketchOverlay {
  const overlay = new SketchOverlay();
  overlay.update(doc);
  return overlay;
}

/** The Viewport members handleClick actually touches. A real Viewport needs a
 *  WebGL context, so the method runs against the prototype (same trick as
 *  orbitPivot.test.ts / tiltOffAxis.test.ts). needsRender and lingerFrames are
 *  the REAL private fields loop() reads. */
function probe(overlay: SketchOverlay, opts: { hitRegion: boolean }) {
  const vp = Object.create(Viewport.prototype) as any;
  vp.suspendPicking = false;
  vp.streaming = false;
  vp.selectionMode = "faces";
  vp.datumQuads = [];
  vp.canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
  };
  // a model plus a picker that hits nothing: the solid is not what is clicked
  vp.model = {} as never;
  vp.rig = { active: null } as never;
  vp.picker = { pick: () => null } as never;
  vp.highlighter = { clearSelection() {}, toggleSelectFace() {}, toggleSelectEdge() {} } as never;
  // Start with a CLEAN gate, which is what a real click has by the time the
  // button comes back up: camera-controls fires controlstart on the PRESS (it
  // does so even though left is mapped to ACTION.NONE) and that requests a
  // frame, but its 3-frame linger has drained long before a human-length hold
  // ends. Measured in a browser: hold the button ~250 ms and the release draws
  // nothing; a zero-length synthetic click lands inside the linger and paints
  // by accident. That is the "sometimes it works" in the report.
  vp.needsRender = false;
  vp.lingerFrames = 0;
  // main.ts's regionPickAt wiring, minus the toolBusy()/sketch.active gate
  vp.regionPickAt = (_x: number, _y: number, additive: boolean) => {
    if (!opts.hitRegion) return false;
    const wr = overlay.regions[0]!;
    const ray = new THREE.Ray(
      new THREE.Vector3(wr.interior3D.x, wr.interior3D.y, 50),
      new THREE.Vector3(0, 0, -1),
    );
    const hit = overlay.committedRegionAtRay(ray);
    if (!hit) return false;
    overlay.toggleRegionSelection(hit, additive);
    return true;
  };
  // ...and main.ts's repaint wiring, the thing under test
  overlay.onRepaintNeeded = () => vp.requestRender();
  return vp;
}

const CLICK = {
  clientX: 400,
  clientY: 300,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
} as unknown as PointerEvent;

/** exactly loop()'s draw gate, minus camera motion (the camera is still) */
const willDrawAFrame = (vp: any): boolean => vp.needsRender || vp.lingerFrames > 0;

describe("clicking a sketch profile area (a58966e5)", () => {
  it("the reporter's document really does produce one clickable region", () => {
    const overlay = overlayFor();
    expect(overlay.regions.length).toBe(1);
    expect(overlay.regions[0]!.fill).toBeDefined();
  });

  it("selects the area and recolours its fill", () => {
    const overlay = overlayFor();
    const wr = overlay.regions[0]!;
    const before = wr.fill!.material as THREE.MeshBasicMaterial;
    const vp = probe(overlay, { hitRegion: true });
    vp.handleClick(CLICK);
    const after = wr.fill!.material as THREE.MeshBasicMaterial;
    expect(overlay.selectedRegions().length).toBe(1); // the status prompt's number
    expect(after).not.toBe(before);
    expect(after.color.getHex()).toBe(SELECT_COLOR); // orange, not the pale fill
  });

  it("asks for a frame, so the new colour is actually drawn", () => {
    const overlay = overlayFor();
    const vp = probe(overlay, { hitRegion: true });
    vp.handleClick(CLICK);
    expect((overlay.regions[0]!.fill!.material as THREE.MeshBasicMaterial).color.getHex()).toBe(
      SELECT_COLOR,
    );
    expect(willDrawAFrame(vp), "no frame was requested after selecting the area").toBe(true);
  });

  it("CONTROL: the same click MISSING the area also marks the frame dirty", () => {
    // guards against the test passing for the wrong reason — this path was
    // never broken, so it must stay true either way
    const overlay = overlayFor();
    const vp = probe(overlay, { hitRegion: false });
    vp.handleClick(CLICK);
    expect(willDrawAFrame(vp)).toBe(true);
  });

  it("asks for a frame when Esc clears the selection", () => {
    const overlay = overlayFor();
    const vp = probe(overlay, { hitRegion: true });
    vp.handleClick(CLICK);
    vp.needsRender = false;
    vp.lingerFrames = 0;
    overlay.clearRegionSelection(); // main.ts's Escape handler
    expect(overlay.selectedRegions().length).toBe(0);
    expect(willDrawAFrame(vp), "no frame was requested after clearing").toBe(true);
  });

  it("asks for a frame when the hover highlight moves off the area", () => {
    // handleHover returns on a region hit before its own requestRender(); the
    // post-click hover re-establish (pointerup -> queueHover) has no other one.
    const overlay = overlayFor();
    const vp = probe(overlay, { hitRegion: true });
    overlay.setHoverRegion(overlay.regions[0]!);
    vp.needsRender = false;
    vp.lingerFrames = 0;
    overlay.setHoverRegion(null);
    expect(willDrawAFrame(vp), "no frame was requested after un-hovering").toBe(true);
  });
});

describe("loop() really is the gate these flags feed", () => {
  it("draws only when the camera moved, needsRender, or lingerFrames", () => {
    expect(viewportSrc).toContain("if (moved || this.needsRender || this.lingerFrames > 0) {");
    expect(viewportSrc).toContain("this.scene.renderer.render(this.scene.scene, this.rig.active);");
  });

  it("main.ts wires the overlay's repaint hook to the viewport", () => {
    // the probe above wires it by hand; this is what proves the real app does
    expect(mainSrc).toContain("overlay.onRepaintNeeded = () => viewport.requestRender();");
  });
});
