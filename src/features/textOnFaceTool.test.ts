import { describe, it, expect } from "vitest";

import { snapTo, textFrame } from "./textOnFaceTool";
import type { PlaneDef } from "../types";

// Field-reported 2026-08-21: "it always starts vertical, it would be better if
// it started horizontal."
//
// viewport.pickFacePlane picks its xdir from a reference axis (viewport.ts:1347):
// world Z when the face is not roughly horizontal, world X when it is. So on any
// WALL the frame's x-axis is the projection of world up — it points up the wall —
// and text, which runs along x, comes out reading bottom-to-top.
//
// These assert the property that matters (the text axis is level with the
// ground), not a particular vector, so a different but still-horizontal choice
// stays green.
describe("textFrame — text reads horizontally on a wall", () => {
  const plane = (normal: [number, number, number], xdir: [number, number, number]): PlaneDef =>
    ({ origin: [0, 0, 0], normal, xdir }) as PlaneDef;

  /** how far the text axis tilts out of level, in degrees */
  const tiltDeg = (p: PlaneDef) => Math.abs(Math.asin(p.xdir[2]!) * (180 / Math.PI));

  it("levels the text axis on a wall the picker would have stood upright", () => {
    // A wall facing +X: pickFacePlane's ref is world Z, so its xdir is +Z —
    // straight up the wall. That is the reported bug, reproduced as input.
    const picked = plane([1, 0, 0], [0, 0, 1]);
    expect(tiltDeg(picked)).toBeCloseTo(90, 6); // the defect, stated

    const framed = textFrame(picked);
    expect(tiltDeg(framed)).toBeCloseTo(0, 6);
    // still a valid frame: x must lie IN the face
    const dot = framed.xdir[0]! * 1 + framed.xdir[1]! * 0 + framed.xdir[2]! * 0;
    expect(dot).toBeCloseTo(0, 9);
  });

  it("levels it on walls of every heading, not just the axis-aligned one", () => {
    for (let deg = 0; deg < 360; deg += 15) {
      const r = (deg * Math.PI) / 180;
      const n: [number, number, number] = [Math.cos(r), Math.sin(r), 0];
      const framed = textFrame(plane(n, [0, 0, 1]));
      expect(tiltDeg(framed)).toBeCloseTo(0, 6);
      // perpendicular to the face normal, i.e. still in the plane
      const dot = framed.xdir[0]! * n[0] + framed.xdir[1]! * n[1] + framed.xdir[2]! * n[2];
      expect(dot).toBeCloseTo(0, 9);
    }
  });

  it("leaves a horizontal face alone", () => {
    // A top face has no "up" to level against, and the picker already gives it
    // world X. Rewriting it would be churn — and would rotate text on every
    // top face, which nobody reported.
    const top = plane([0, 0, 1], [1, 0, 0]);
    expect(textFrame(top)).toEqual(top);
    const bottom = plane([0, 0, -1], [1, 0, 0]);
    expect(textFrame(bottom)).toEqual(bottom);
  });

  it("leaves a steeply sloped face alone rather than producing a degenerate axis", () => {
    // Just inside the horizontal test (|n.z| > 0.9): the cross product with up
    // is still well conditioned here, but the picker's own choice is already
    // near-level, so this documents where the handover sits.
    const nearlyFlat = plane([0.1, 0, 0.995], [1, 0, 0]);
    expect(textFrame(nearlyFlat)).toEqual(nearlyFlat);
  });
});

// Placement snapping. The candidates the tool builds are, in order: the face's
// true centroid, the centre of its extent, its four edge midpoints and its four
// corners — all in the text frame's own (u, v), so "middle of this face" means
// the same on a wall as on a top face.
describe("snapTo — placement snapping", () => {
  const centre = { u: 0, v: 0 };
  const corner = { u: 10, v: 5 };
  const cands = [centre, corner];

  it("returns the raw point when nothing is near enough", () => {
    const at = { u: 4, v: 4 };
    expect(snapTo(at, cands, 1)).toBe(at); // identity: not a rounded copy
  });

  it("snaps to a candidate inside the tolerance", () => {
    expect(snapTo({ u: 0.3, v: -0.2 }, cands, 1)).toEqual(centre);
  });

  it("takes the NEAREST candidate, not the first one in range", () => {
    // Both are within a generous tolerance; the corner is closer. A loop that
    // stopped at the first hit would answer `centre` and the snap would feel
    // like it was pulling to the wrong place.
    expect(snapTo({ u: 9, v: 4.5 }, cands, 100)).toEqual(corner);
  });

  it("does not snap at exactly the tolerance", () => {
    // Boundary, stated: `tol` is the first distance that no longer snaps, so a
    // tolerance of 0 disables snapping entirely rather than snapping everything.
    const at = { u: 1, v: 0 };
    expect(snapTo(at, cands, 1)).toBe(at);
    expect(snapTo({ u: 0.999, v: 0 }, cands, 1)).toEqual(centre);
  });

  it("is inert with no candidates or zero tolerance", () => {
    const at = { u: 3, v: 3 };
    expect(snapTo(at, [], 5)).toBe(at);
    expect(snapTo(at, cands, 0)).toBe(at);
  });
});
