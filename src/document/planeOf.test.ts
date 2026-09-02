// planeOf: which plane a face-anchored sketch is DRAWN at.
//
// The sidecar re-derives an anchored sketch's plane every rebuild and returns
// it in `RebuildResult.planes`; the feature's own `plane` is only the cache
// written the last time the sketch was closed. Reading `f.plane` directly draws
// the curves at the old height while the cut they drive lands at the new one —
// and worse, reopening the sketch at the stale plane re-bakes it on close,
// silently undoing the follow.

import { describe, it, expect } from "vitest";
import { planeOf } from "./planeOf";
import type { PlaneDef } from "../types";

const CACHED: PlaneDef = { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] };
const RESOLVED: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };

describe("planeOf", () => {
  it("prefers the plane the rebuild resolved over the feature's cache", () => {
    expect(planeOf({ id: "s1", plane: CACHED }, { s1: RESOLVED })).toBe(RESOLVED);
  });

  it("falls back to the cache when this feature has no resolved plane", () => {
    // The overwhelmingly common case: a sketch with no `face` at all. The
    // sidecar sends nothing for it and it must place exactly as it always did.
    expect(planeOf({ id: "s1", plane: CACHED }, { s2: RESOLVED })).toBe(CACHED);
    expect(planeOf({ id: "s1", plane: CACHED }, {})).toBe(CACHED);
    expect(planeOf({ id: "s1", plane: CACHED }, undefined)).toBe(CACHED);
  });

  it("falls back for a base-plane sketch, whose plane is a string", () => {
    expect(planeOf({ id: "s1", plane: "XY" }, undefined)).toBe("XY");
  });

  it("follows the DATUM a sketch is bound to when it has no entry of its own", () => {
    // "Offset plane" puts the `face` anchor on the datum and gives the sketch
    // only `planeId` (featureStarters.offsetPlane), so the sidecar's `planes`
    // map — keyed by the feature that carries the anchor — has no entry for the
    // sketch. _sketch_plane_ref still resolves the link when it BUILDS it, so
    // without this the cut follows and only the drawing stays behind.
    expect(planeOf({ id: "s1", plane: CACHED, planeId: "dp" }, { dp: RESOLVED }))
      .toBe(RESOLVED);
  });

  it("prefers the sketch's own resolved plane over its datum's", () => {
    const own: PlaneDef = { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] };
    expect(planeOf({ id: "s1", plane: CACHED, planeId: "dp" }, { s1: own, dp: RESOLVED }))
      .toBe(own);
  });
});
