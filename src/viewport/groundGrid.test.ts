// Where the ground grid is allowed to sit.
//
// Field report 04191fb5 (0.1.214, Windows): "When I use extrude and have a
// 'Start offset' it creates the offset on the body correctly but it moves the
// grid 'plane' with the offset, so the origin is left hanging in space."
//
// The mover is the ground grid, not the sketch plane. The grid-floor feature
// (commit 7aac9f1, "the ground grid now sits at the model's lowest Z") was
// applied unclamped: `targetGridZ = model.box.min.z`. A startOffset of 5 makes
// the only body's box start at z=5, so the grid rose 5 mm while the AxesHelper
// origin marker stayed nailed to world (0,0,0) — the origin left in space, with
// no plane under it. Measured on the reporter's own document: gridZ 4.7539 with
// the body's box min at 4.7539.
//
// The rule that fixes it: the grid may drop BELOW the world XY plane to stay
// under a model that hangs under the origin, and may never rise above it.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { AdaptiveGrid, groundGridZ } from "./scene";
import viewportSrc from "./viewport.ts?raw";

describe("the height the ground grid is drawn at", () => {
  it("stays on the XY plane for a model lifted off the origin", () => {
    // 5 is the reporter's startOffset; 4.7539 is what his document actually
    // reports, because result.bbox is padded ~0.25 mm either end.
    for (const minZ of [5, 4.7539, 43.5, 500]) {
      expect(groundGridZ(minZ), `model floor at z=${minZ}`).toBe(0);
    }
  });

  it("still drops under a model that hangs below the origin", () => {
    // The whole point of the floor feature — do not regress it into "always 0".
    expect(groundGridZ(-12)).toBe(-12);
    expect(groundGridZ(-0.25)).toBe(-0.25);
  });

  it("sits on the XY plane for a model resting on it, and for no model at all", () => {
    expect(groundGridZ(0)).toBe(0);
    // An empty Box3's min is +Infinity; NaN reaches here if a payload box is junk.
    expect(groundGridZ(new THREE.Box3().min.z)).toBe(0);
    expect(groundGridZ(NaN)).toBe(0);
  });

  it("puts the grid object itself on the XY plane, where the origin marker is", () => {
    // The effect, not the arithmetic: the group three actually renders.
    const grid = new AdaptiveGrid(new THREE.Scene());
    grid.update(0, 0, 0.1, groundGridZ(5));
    expect(grid.group.position.z, "the grid floated up with the start offset").toBe(0);
    expect(new THREE.AxesHelper(1).position.z, "the origin marker moved").toBe(0);

    grid.update(0, 0, 0.1, groundGridZ(-12));
    expect(grid.group.position.z, "the grid stopped following a model below the origin").toBe(-12);
  });
});

describe("the wiring that reaches that behaviour", () => {
  it("has no unclamped box.min.z assignment left in the viewport", () => {
    // Two call sites — setModel and the progressive/streaming path — and they
    // drifted apart once already. Both must go through the one named rule.
    const raw = viewportSrc.match(/targetGridZ\s*=\s*[^;]+;/g) ?? [];
    expect(raw.length, "no targetGridZ assignments in viewport.ts — this test is stale")
      .toBeGreaterThan(1);
    for (const line of raw) {
      expect(
        /groundGridZ\(|=\s*0;/.test(line),
        `targetGridZ is assigned raw here, so the grid can rise off the XY plane again: ${line}`,
      ).toBe(true);
    }
  });
});
