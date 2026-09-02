// WHERE a committed face-anchored sketch is DRAWN, and when that gets refreshed.
//
// planeOf has two consumers. The sketch-EDIT arm (main.ts) is covered end to end
// by e2e/sketch_on_face_e2e.cjs; the OVERLAY — the one that decides where the
// curves and their region hit-boxes actually appear — had no oracle at all, unit
// or e2e. Both halves of that consumer are pinned here:
//
//   1. update() places committed curves at the RESOLVED plane. Reverting
//      overlay.ts to `this.planeFor(f.plane)` left the whole suite green.
//   2. main.ts repaints on BUILD. `resolvedPlanes` is read only inside update(),
//      and every mutation path in the store emits the document BEFORE it
//      schedules the rebuild — so the doc-change repaint runs against the
//      PREVIOUS build's planes and the curves stay one edit behind unless a
//      build handler repaints them. Deleting the wiring line also left the suite
//      green, which is why the wiring is asserted as source text: there is no
//      other seam short of booting the app.
//
// The stale plane is not only a wrong picture: WorldRegion.interior3D comes off
// the same plane, and extrudeTool writes it into a new extrude's region selector
// as `point` — a selector point that is not on the geometry.

import { describe, it, expect } from "vitest";
import { SketchOverlay } from "./overlay";
import type { CadDocument, PlaneDef } from "../types";

const CACHED: PlaneDef = { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] };
const RESOLVED: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };

const doc = (): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "s1",
      type: "sketch",
      plane: CACHED,
      face: { kind: "face", by: "nearest", point: [9.5, 0, 5], body: "body1" },
      entities: [
        { id: "r1", type: "rectangle", width: 8, height: 8, x: 0, y: 0 },
      ],
    },
  ],
} as unknown as CadDocument);

describe("SketchOverlay — the plane committed curves are drawn at", () => {
  it("draws a face-anchored sketch at the plane the rebuild resolved", () => {
    const o = new SketchOverlay();
    o.resolvedPlanes = () => ({ s1: RESOLVED });
    o.update(doc());
    expect(o.regions).toHaveLength(1);
    // the region carries the plane it was built on, and its interior point is
    // what an extrude picked off this sketch would store as a selector
    expect(o.regions[0]!.centroid3D.z).toBeCloseTo(10, 9);
    expect(o.regions[0]!.interior3D.z).toBeCloseTo(10, 9);
  });

  it("falls back to the cached plane when the build resolved none", () => {
    const o = new SketchOverlay();
    o.update(doc());
    expect(o.regions[0]!.centroid3D.z).toBeCloseTo(5, 9);
  });
});

describe("main.ts wiring", () => {
  it("repaints the overlay when a build completes, not only on doc change", async () => {
    const mainSrc = (await import("../main.ts?raw")).default;
    // the source of the planes, and the repaint that lets a new one reach screen
    expect(mainSrc).toContain("overlay.resolvedPlanes = () => store.buildState.result?.planes");
    expect(mainSrc).toMatch(
      /if \(s\.result && !s\.building && !sketch\.active\) overlay\.update\(store\.document\);/,
    );
  });
});
