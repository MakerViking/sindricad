// A face-anchored sketch must survive being REOPENED.
//
// GH #52's fix stores `face` — the body face a sketch was picked off — so the
// sidecar re-derives the plane every rebuild and the sketch follows the face.
// The trap is that the anchor has to ride through THREE places in one class:
// enter() takes it, enter() re-adopts it from the feature when editing, and
// snapshotFeature() writes it back out. snapshotFeature is what a re-edit
// commits, so dropping it in any one of the three means: open the sketch,
// change nothing, close it — and the anchor is silently gone, the plane is
// baked at wherever it stood, and #52 is back with no message at all.
//
// `planeId` is asserted alongside because it is the SAME three lines, already
// shipped, and it is the pattern this one copies. If a future edit breaks the
// shape, both fail together and the cause is obvious.
//
// Driving a real SketchMode needs WebGL, so `this` is a hand-built stand-in —
// but the METHODS under test are the real ones, taken off the prototype. What
// is faked is the viewport/overlay/solver around them, never the round-trip.

import { describe, it, expect, beforeEach } from "vitest";
import { SketchMode } from "./sketchMode";
import { SketchPlane } from "./plane";
import type { CadDocument, Feature, PlaneDef, Selector } from "../types";

const PLANE: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };
const FACE: Selector = { kind: "face", by: "nearest", point: [9.5, 0, 10], body: "body1" };

// vitest runs in node (no jsdom, on purpose — see vitest.config.ts); enter()
// registers its key handler on window.
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};

/** A SketchMode whose collaborators are stubs, so enter()/snapshotFeature() can
 *  run. Everything here is a dependency of entering a sketch, not part of what
 *  is under test — the two methods themselves come from the real prototype. */
function makeSketch(doc: CadDocument) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  Object.assign(s, {
    fonts: ["stub"], // non-empty: skips the async font fetch
    entities: [],
    constraints: [],
    patterns: [],
    selected: new Set<string>(),
    history: { reset() {} },
    patternFlow: { resetForEnter() {}, flushOnFinish() {} },
    overlay: {
      planeFor: (spec: PlaneDef | string) => new SketchPlane(spec as PlaneDef),
      clearRegionSelection() {},
      update() {},
    },
    viewport: {
      suspendPicking: false,
      enterSketchView() {},
      domElement: { addEventListener() {}, removeEventListener() {} },
      onZoomScale: null,
    },
    // prototype methods that touch three.js / the solver, stubbed as own props
    addGrid() {},
    refreshActive() {},
    armPreEdit() {},
    setTool() {},
    setViewLocked() {},
    requestSolve() {},
    viewLocked: false,
  });
  const store = {
    document: doc,
    nextId: () => "s99",
  };
  return { s, store: store as never };
}

const DOC: CadDocument = { version: 5, parameters: {}, features: [] };

describe("a face-anchored sketch round-trips through enter -> snapshot -> enter", () => {
  let doc: CadDocument;
  beforeEach(() => {
    doc = { ...DOC, features: [] };
  });

  it("keeps `face` and `planeId` the first time the sketch is committed", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, undefined, "dp1", FACE);
    (s as unknown as { entities: unknown[] }).entities.push({
      type: "circle", id: "c1", x: 0, y: 0, radius: 3,
    });
    const f = s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    expect(f.face).toEqual(FACE);
    expect(f.planeId).toBe("dp1");
  });

  it("keeps them when the SAVED sketch is reopened and closed unchanged", () => {
    // The re-bake trap: editFeature passes neither `face` nor `planeId` (it only
    // knows the id), so the round-trip depends entirely on enter() re-adopting
    // them from the stored feature.
    const first = (() => {
      const { s, store } = makeSketch(doc);
      s.enter(PLANE, store, undefined, "dp1", FACE);
      (s as unknown as { entities: unknown[] }).entities.push({
        type: "circle", id: "c1", x: 0, y: 0, radius: 3,
      });
      return s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    })();
    doc.features = [{ ...first, id: "s1" }];

    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, "s1"); // editFeature's call shape: id only
    const again = s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    expect(again.id).toBe("s1");
    expect(again.face).toEqual(FACE);
    expect(again.planeId).toBe("dp1");
  });

  it("writes no `face` key at all for a sketch on a base plane", () => {
    // Legacy compat, the whole rule: no anchor picked, not one byte added.
    const { s, store } = makeSketch(doc);
    s.enter("XY", store);
    (s as unknown as { entities: unknown[] }).entities.push({
      type: "circle", id: "c1", x: 0, y: 0, radius: 3,
    });
    const f = s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    expect("face" in f).toBe(false);
    expect("planeId" in f).toBe(false);
  });
});
