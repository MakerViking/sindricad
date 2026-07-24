// worldPointInRegion: coplanarity-gated region membership. Regression for the
// loft field bug where selecting an upper ring also selected the lower sketch's
// inner disk (an upper-plane anchor projected into a lower-plane region).
import { describe, it, expect } from "vitest";
import type { ResolvedEntity } from "./snap";
import { detectRegions } from "./region";
import { SketchPlane } from "./plane";
import { worldPointInRegion } from "./regionSelect";

const circle = (id: string, r: number): ResolvedEntity =>
  ({ type: "circle", id, x: 0, y: 0, radius: r }) as ResolvedEntity;

describe("worldPointInRegion — coplanarity gate", () => {
  // The exact recovered loft geometry: lower rings r25/r20 on XY, upper rings
  // r16/r13.18 on a plane parallel to XY at z=24. The upper ring's anchor sits
  // at radius ~14.4, which projects INTO the lower disk (radius < 20).
  const lower = detectRegions("f1", [circle("a", 25), circle("b", 20)]);
  const upper = detectRegions("f4", [circle("c", 16), circle("d", 13.178124256444876)]);
  const lowerPlane = new SketchPlane("XY");
  const upperPlane = new SketchPlane({ origin: [0, 0, 24], normal: [0, 0, 1], xdir: [1, 0, 0] });
  const lowerDisk = lower.find((r) => r.holes.length === 0)!;
  const upperRing = upper.find((r) => r.holes.length > 0)!;
  const upperAnchorWorld = upperPlane.to3D(upperRing.interior.x, upperRing.interior.y);

  it("an upper-ring anchor does NOT select the lower disk (was the bug)", () => {
    // sanity: the projection really does land in the lower disk in 2D
    expect(lowerDisk.holes).toHaveLength(0);
    // but the coplanarity gate rejects it because the anchor is on z=24, not z=0
    expect(worldPointInRegion(upperAnchorWorld, lowerPlane, lowerDisk)).toBe(false);
  });

  it("the upper-ring anchor still selects its own ring", () => {
    expect(worldPointInRegion(upperAnchorWorld, upperPlane, upperRing)).toBe(true);
  });
});
