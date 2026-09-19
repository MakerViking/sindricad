// A SECTION CUT has to outlive the thing that rebuilt the model.
//
// Field report (Doug Smith, #17): "Allow sketch creation while in a section cut.
// Perhaps a persistent section or similar function."
//
// Two separate reasons it was impossible:
//
//  1. setClipPlane wrote `clippingPlanes` onto the materials that existed at the
//     time. Every rebuild makes new ones (render.ts and edgeLines.ts both start
//     a material at clippingPlanes = null), so the cut died on the next rebuild
//     — the tool's own header said so. Committing a sketch rebuilds, so even if
//     you got into the sketcher the cut was gone by the time you left.
//  2. toolBusy() counted section.active, so no tool could START while the gizmo
//     was up.
//
// The viewport now OWNS the plane and re-applies it; the gizmo is handed down
// separately via stop(true).
//
// WHAT THIS OBSERVES: the materials, which is the thing the renderer reads.
// There is no WebGL here, so setModel itself cannot run — its call to
// applyClipPlane is pinned by a source assertion instead, the same way
// regionPickRepaint.test.ts pins its draw gate. Without that, this file would
// happily pass while nothing re-applied the clip in the shipped app.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Viewport } from "./viewport";
import viewportSrc from "./viewport.ts?raw";
import sectionSrc from "../features/sectionTool.ts?raw";
import mainSrc from "../main.ts?raw";

type Mat = { clippingPlanes: THREE.Plane[] | null };

/** A Viewport carrying only what applyClipPlane touches. Each body needs its own
 *  `edges` too: edgeObjects() maps bodies to b.edges, and the wireframe has to
 *  be clipped alongside the solid or the edges float on outside the cut. */
function probe() {
  const bodyMat: Mat = { clippingPlanes: null };
  const edgeMat: Mat = { clippingPlanes: null };
  const vp = Object.create(Viewport.prototype) as Record<string, unknown> & {
    setClipPlane(p: THREE.Plane | null): void;
    clipped: boolean;
  };
  vp.scene = { renderer: { localClippingEnabled: false } };
  vp.model = { bodies: [{ mesh: { material: bodyMat }, edges: { material: edgeMat } }] };
  vp.requestRender = () => {};
  return { vp, bodyMat, edgeMat, freshMaterials: () => {
    // what a rebuild does: brand-new materials, unclipped
    const m: Mat = { clippingPlanes: null };
    const e: Mat = { clippingPlanes: null };
    (vp.model as { bodies: unknown[] }).bodies = [{ mesh: { material: m }, edges: { material: e } }];
    return { mesh: m, edges: e };
  } };
}

const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

describe("a section cut is persistent view state", () => {
  it("clips the current materials and reports itself as clipped", () => {
    const { vp, bodyMat, edgeMat } = probe();
    expect(vp.clipped).toBe(false);
    vp.setClipPlane(PLANE);
    expect(bodyMat.clippingPlanes).toEqual([PLANE]);
    expect(edgeMat.clippingPlanes).toEqual([PLANE]);
    expect(vp.clipped).toBe(true);
    expect((vp.scene as { renderer: { localClippingEnabled: boolean } }).renderer.localClippingEnabled).toBe(true);
  });

  // The actual bug: new materials arrive unclipped, and something has to put the
  // cut back on them.
  it("re-applies the cut to the materials a rebuild replaced", () => {
    const { vp, freshMaterials } = probe();
    vp.setClipPlane(PLANE);
    const rebuilt = freshMaterials();
    expect(rebuilt.mesh.clippingPlanes).toBe(null); // precondition: the rebuild lost it
    (vp as unknown as { applyClipPlane(): void }).applyClipPlane();
    expect(rebuilt.mesh.clippingPlanes).toEqual([PLANE]);
    expect(rebuilt.edges.clippingPlanes).toEqual([PLANE]);
  });

  it("clears the cut and the renderer flag together", () => {
    const { vp, bodyMat, edgeMat } = probe();
    vp.setClipPlane(PLANE);
    vp.setClipPlane(null);
    expect(bodyMat.clippingPlanes).toBe(null);
    expect(edgeMat.clippingPlanes).toBe(null);
    expect(vp.clipped).toBe(false);
    expect((vp.scene as { renderer: { localClippingEnabled: boolean } }).renderer.localClippingEnabled).toBe(false);
  });
});

// These pin the WIRING that a headless run cannot execute. If any of them stops
// holding, the three tests above keep passing and the feature is broken.
describe("the wiring that makes the cut survive", () => {
  it("setModel re-applies the clip", () => {
    const at = viewportSrc.indexOf("setModel(result: RebuildResult");
    expect(at).toBeGreaterThan(-1);
    const end = viewportSrc.indexOf("\n  /**", at);
    const body = viewportSrc.slice(at, end > at ? end : at + 12000);
    expect(body).toContain("this.applyClipPlane()");
  });

  it("stop(keepClip) leaves the plane alone", () => {
    // The guard is what makes a persistent section possible; an unconditional
    // setClipPlane(null) here would silently restore the old behaviour.
    expect(sectionSrc).toMatch(/stop\(keepClip = false\)/);
    expect(sectionSrc).toMatch(/if \(!keepClip\) this\.viewport\.setClipPlane\(null\)/);
  });

  it("starting another tool hands the cut over instead of being refused", () => {
    expect(mainSrc).toMatch(/if \(section\.active && action !== "section"\) section\.stop\(true\)/);
  });

  // Without this the cut becomes unremovable once the gizmo is down, which is a
  // worse bug than the one being fixed.
  it("toggling Section clears a cut whose gizmo is already down", () => {
    expect(mainSrc).toMatch(/if \(viewport\.clipped\) \{\s*viewport\.setClipPlane\(null\);/);
  });
});
