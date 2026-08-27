// Getting back to the model when there is nothing on screen.
//
// Field report 32887098 (0.1.171, Windows): "When I hit 'file' and 'New' the
// window view does not reset itself, I got lost at least once when I zoomed out
// to the extent that the origin and grid had disappeared... the only quick way
// back was to exit and reload SindriCAD."
//
// Two faults, one symptom. File > New rebuilt the document and never touched the
// camera — that is main.ts wiring, pinned as source below. The worse one is that
// Fit, the command a lost user reaches for, was `if (this.model) …` and so did
// NOTHING on an empty document: the one moment it is most needed is the one
// moment it stayed silent. That half is real behaviour and is tested for real.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { harness } from "./rig.testkit";
import viewportSrc from "./viewport.ts?raw";
import mainSrc from "../main.ts?raw";

const EMPTY = () => new THREE.Box3(); // three's default Box3 IS empty (min +∞, max −∞)

describe("Fit with nothing in the document", () => {
  it("brings the camera back to a human-scale view of the origin", () => {
    // The lost-user case: zoom out until nothing is visible, then Fit.
    const { rig } = harness();
    rig.update(0.016);
    for (let i = 0; i < 8; i++) rig.zoomBy(4); // far, far out
    rig.update(0.016);
    const lost = rig.viewScale();
    expect(lost, "the zoom-out did not actually get the camera far away").toBeGreaterThan(1000);

    rig.fit(EMPTY(), false);
    rig.update(0.016);
    const found = rig.viewScale();
    expect(found, "Fit on an empty document left the camera where it was").toBeLessThan(lost / 10);
    // a workable desk-scale view, not a nanometre and not a kilometre
    expect(found, "the recovered view is absurdly tight").toBeGreaterThan(1);
    expect(found, "the recovered view is still far too wide to see a grid").toBeLessThan(2000);
  });

  it("aims at the origin, which is where the grid and the origin marker are", () => {
    const { rig } = harness();
    rig.update(0.016);
    // wander off: orbit and zoom somewhere unhelpful
    rig.tumble(1.2, 0.7);
    for (let i = 0; i < 5; i++) rig.zoomBy(4);
    rig.update(0.016);

    rig.fit(EMPTY(), false);
    rig.update(0.016);
    const target = rig.controls.getTarget(new THREE.Vector3());
    expect(target.length(), "Fit on an empty document did not re-aim at the origin").toBeLessThan(1e-6);
  });

  it("produces a finite camera, not one placed behind its own target", () => {
    // An empty Box3's bounding sphere has radius −1, so the padded radius goes
    // NEGATIVE and multiplies through into the camera position. That is how you
    // get a viewport showing nothing at all with no way to tell why.
    const { rig } = harness();
    rig.fit(EMPTY(), false);
    rig.update(0.016);
    const pos = rig.controls.getPosition(new THREE.Vector3());
    expect(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)).toBe(true);
    expect(pos.length(), "the camera sits on top of its target").toBeGreaterThan(1e-3);
    expect(rig.viewScale(), "the view scale is not a positive finite number").toBeGreaterThan(0);
  });
});

describe("the wiring that reaches that behaviour", () => {
  it("Fit no longer bails out when there is no model", () => {
    const at = viewportSrc.indexOf("fitView()");
    expect(at, "no fitView() in viewport.ts — this test's slice is stale").toBeGreaterThan(-1);
    const body = viewportSrc.slice(at, at + 700);
    expect(
      body,
      "fitView() guards on `if (this.model)` again, so Fit does nothing on an empty "
        + "document — the exact moment the user needs it (field report 32887098)",
    ).not.toMatch(/if\s*\(\s*this\.model\s*\)/);
    expect(body, "fitView() no longer falls back to an empty box").toContain("Box3()");
  });

  it("File > New resets the view", () => {
    const at = mainSrc.indexOf("async function newDocument(");
    expect(at, "no newDocument() in main.ts — this test's slice is stale").toBeGreaterThan(-1);
    const body = mainSrc.slice(at, mainSrc.indexOf("\n}", at));
    expect(body, "newDocument() no longer clears the document at all").toContain("store.newDocument()");
    expect(
      body,
      "File > New leaves the camera wherever the last document left it, so a user who had "
        + "zoomed out starts the new document lost (field report 32887098)",
    ).toContain("resetView()");
  });

  it("resetView squares up AND frames, rather than only one of the two", () => {
    const at = viewportSrc.indexOf("resetView()");
    expect(at, "no resetView() in viewport.ts").toBeGreaterThan(-1);
    const body = viewportSrc.slice(at, at + 300);
    expect(body, "resetView() does not restore a standard orientation").toContain("setStandardView(");
    expect(body, "resetView() does not re-frame, so the zoom level survives a New").toContain("fitView()");
  });
});
