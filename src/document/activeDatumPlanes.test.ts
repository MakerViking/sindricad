// Field report 9ee3fb35: "if I move the timeline marker back before the offset
// plane, the plane is still there."
//
// The rebuild honoured the marker perfectly — the sidecar never built the datum,
// and `RebuildResult.planes` came back null — but the construction-plane quads
// were built from the WHOLE document with one filter (isPlaneVisible), so the
// plane stayed drawn AND stayed in `viewport.datumQuads`, which is the array
// `pickDatumAt` and the click handler raycast. A plane that does not exist yet
// was still selectable, sketchable, and usable as a press/pull "up to" target.
//
// The assertions below are on the RETURNED ARRAY, because that array is
// literally the argument main.ts hands to `viewport.setDatumPlanes` — the quads
// that end up in the scene, not a handler having been called.

import { describe, it, expect } from "vitest";
import { activeDatumPlanes } from "./planeOf";
import type { CadDocument } from "../types";

// The reporter's own document, copied verbatim out of the attached file: a
// tapered extrude, a face-anchored datum plane 36 above its top (f3), and a
// press/pull that goes up to that datum. Kept exactly as it arrived — the report
// is about THIS sequence, and the odd-looking literals are what was sent.
const DOC = {
  version: 5, parameters: {}, paramDefs: {}, sketchVisibility: { f1: true },
  features: [
    { id: "f1", type: "sketch", plane: "XY",
      entities: [{ x: 0, y: 0, id: "e0", type: "circle", radius: 28.284271247461906 }] },
    { id: "f2", type: "extrude", taper: 20, sketch: "f1", distance: 10, operation: "new",
      startOffset: 2, hiddenBodies: [], separateBodies: true,
      regions: [[-8.326672684688674e-16, -1.2281842209915794e-15, 0]],
      regionEntities: [["e0"]], regionHoleEntities: [[]] },
    { id: "f3", type: "datumPlane", offset: 36,
      face: { by: "nearest", body: "body1", kind: "face",
        point: [8.838312069289294, -16.24658178191268, 11.999999999999991] },
      plane: { xdir: [1, 0, 0], normal: [0, 0, 1], origin: [0, 0, 11.999999999999991] } },
    { id: "f5", type: "press-pull", body: "body1", distance: -5, operation: "join",
      upToPlane: "f3", upToOffset: 10,
      face: { by: "nearest", kind: "face", point: [5.676980336507161, 5.937655766805013, 12] } },
  ],
} as unknown as CadDocument;

const ids = (opts: Partial<Parameters<typeof activeDatumPlanes>[1]> = {}) =>
  activeDatumPlanes(DOC.features, {
    rollbackIndex: DOC.features.length,
    isSuppressed: () => false,
    isVisible: () => true,
    resolvedPlanes: undefined,
    ...opts,
  }).map((p) => p.id);

describe("activeDatumPlanes, on the 9ee3fb35 document", () => {
  it("sanity: the reported document really is [sketch, extrude, datumPlane, press-pull]", () => {
    expect(DOC.features.map((f) => f.type)).toEqual(["sketch", "extrude", "datumPlane", "press-pull"]);
    expect(DOC.features[2]!.id).toBe("f3");
  });

  it("draws the plane when the marker is at the end", () => {
    expect(ids({ rollbackIndex: 4 })).toEqual(["f3"]);
  });

  it("drops it when the marker sits ON the plane (nothing after f2 is built)", () => {
    expect(ids({ rollbackIndex: 2 })).toEqual([]);
  });

  it("drops it when the marker is rolled back to the sketch — the report", () => {
    expect(ids({ rollbackIndex: 1 })).toEqual([]);
    expect(ids({ rollbackIndex: 0 })).toEqual([]);
  });

  it("drops it when the plane is suppressed, marker at the end", () => {
    // Same omission, no rollback needed: a suppressed feature is not built
    // either (store.effectiveDoc filters it out), so its quad must go too.
    expect(ids({ rollbackIndex: 4, isSuppressed: (id) => id === "f3" })).toEqual([]);
  });

  it("still drops it when it is hidden — the pre-existing gate survives the move", () => {
    expect(ids({ rollbackIndex: 4, isVisible: (id) => id !== "f3" })).toEqual([]);
  });

  it("places the drawn quad at source plane + offset, and prefers what the build resolved", () => {
    // The placement rule moved out of main.ts with the filters; pin it here so
    // the move cannot quietly re-apply the offset on top of a resolved plane.
    const fallback = activeDatumPlanes(DOC.features, {
      rollbackIndex: 4, isSuppressed: () => false, isVisible: () => true, resolvedPlanes: undefined,
    });
    expect(fallback[0]!.origin[2]).toBeCloseTo(11.999999999999991 + 36, 6);

    const resolved = activeDatumPlanes(DOC.features, {
      rollbackIndex: 4,
      isSuppressed: () => false,
      isVisible: () => true,
      resolvedPlanes: { f3: { origin: [0, 0, 60], normal: [0, 0, 1], xdir: [1, 0, 0] } },
    });
    expect(resolved[0]!.origin, "a resolved plane already has the offset applied")
      .toEqual([0, 0, 60]);
  });
});
