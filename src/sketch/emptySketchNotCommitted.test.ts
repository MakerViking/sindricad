// Finishing a sketch nobody drew in must not leave a feature behind.
//
// Creating an Offset Plane drops you straight into a sketch on it
// (featureStarters.offsetPlane). A user who only wanted the plane pressed
// Finish Sketch — and got an empty sketch row in the Browser that they then had
// to tick, select and delete by hand. Two field reports (d911463c, 40c85f97).
//
// The emptiness guard existed and was DEAD: entering a sketch unshifts the
// synthetic origin geometry (origin.ts: point + X/Y axes) into `entities`, so a
// brand-new sketch has 3 entities, never 0, and snapshotFeature() happily
// returned a feature whose `entities` array was empty — the origin is stripped
// one line later.
//
// The test that matters is the LAST one: it watches `doc.features`, not a call.
//
// Driving a real SketchMode needs WebGL, so `this` is a hand-built stand-in —
// but the methods under test (enter / snapshotFeature / finish) are the real
// ones, taken off the prototype. Same harness shape as
// sketchFaceRoundTrip.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { SketchMode } from "./sketchMode";
import { SketchPlane } from "./plane";
import { isOriginGeometry, originGeometry } from "./origin";
import type { CadDocument, Feature, PlaneDef } from "../types";

const PLANE: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };

// vitest runs in node (no jsdom, on purpose — see vitest.config.ts); enter()
// registers its key handler on window, and finish() -> cleanup() clears the
// on-screen prompt and any open panel by id.
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as unknown as { document: unknown }).document ??= {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

/** A SketchMode whose collaborators are stubs. The store's addFeature and
 *  replaceFeature are REAL enough to mutate `doc.features`, because what the
 *  reports are about is what ends up in the document. */
function makeSketch(doc: CadDocument) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  Object.assign(s, {
    fonts: ["stub"], // non-empty: skips the async font fetch
    entities: [],
    constraints: [],
    patterns: [],
    selected: new Set<string>(),
    pendingBindings: new Map<string, unknown>(),
    history: { reset() {} },
    patternFlow: { resetForEnter() {}, flushOnFinish() {} },
    overlay: {
      planeFor: (spec: PlaneDef | string) => new SketchPlane(spec as PlaneDef),
      clearRegionSelection() {},
      update() {},
      setActiveSketch() {},
      setActiveRegions() {},
      setPreview() {},
      setSnap() {},
    },
    viewport: {
      suspendPicking: false,
      enterSketchView() {},
      exitSketchView() {},
      hoverEntity() {},
      rig: { setOrbitLocked() {} },
      domElement: { addEventListener() {}, removeEventListener() {} },
      onZoomScale: null,
    },
    dim: { hide() {} },
    dims: { hide() {} },
    glyphs: { hide() {} },
    textPanel: { hide() {} },
    projectPanel: { hide() {} },
    constraintTools: { resetPending() {} },
    // prototype methods that touch three.js / the solver, stubbed as own props
    addGrid() {},
    removeGrid() {},
    refreshActive() {},
    armPreEdit() {},
    setTool() {},
    setViewLocked() {},
    requestSolve() {},
    resetDimPicks() {},
    drainBindings: () => undefined,
    viewLocked: false,
  });
  const store = {
    document: doc,
    nextId: () => "s99",
    addFeature(f: Feature) {
      doc.features.push(f);
    },
    replaceFeature(id: string, f: Feature) {
      const i = doc.features.findIndex((x) => x.id === id);
      if (i >= 0) doc.features[i] = f;
    },
  };
  return { s, store: store as never };
}

const DATUM: Feature = { id: "dp1", type: "datumPlane", plane: "XY", offset: 10 };

describe("an untouched sketch is not committed", () => {
  let doc: CadDocument;
  beforeEach(() => {
    doc = { version: 5, parameters: {}, features: [{ ...DATUM }] };
  });

  it("adds nothing to the document when Finish follows Offset Plane with nothing drawn", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, undefined, "dp1");
    s.finish(true);
    // the datum plane survives; the sketch that was auto-opened on it does not
    expect(doc.features.map((f) => f.id)).toEqual(["dp1"]);
    expect(doc.features.some((f) => f.type === "sketch")).toBe(false);
  });

  it("still commits a sketch that has geometry in it", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, undefined, "dp1");
    (s as unknown as { entities: unknown[] }).entities.push({
      type: "circle", id: "c1", x: 0, y: 0, radius: 3,
    });
    s.finish(true);
    const f = doc.features.find((x) => x.type === "sketch") as Extract<Feature, { type: "sketch" }>;
    expect(f).toBeDefined();
    expect(f.planeId).toBe("dp1");
    expect(f.entities.map((e) => e.id)).toEqual(["c1"]);
  });

  // The carve-out that makes the guard safe: emptying an EXISTING sketch and
  // pressing Finish must WRITE the deletion, not skip the commit and silently
  // put the old geometry back.
  it("commits the deletion when every entity is erased from an existing sketch", () => {
    doc.features.push({
      id: "s1", type: "sketch", plane: PLANE,
      entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: 3 }],
    });
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, "s1");
    const ents = s as unknown as { entities: { id: string }[] };
    ents.entities = ents.entities.filter((e) => isOriginGeometry(e.id)); // erase all real geometry
    s.finish(true);
    const f = doc.features.find((x) => x.id === "s1") as Extract<Feature, { type: "sketch" }>;
    expect(f.entities).toEqual([]);
  });

  // The bug reporter splices the OPEN sketch into the document it uploads
  // (bugReporter.ts), and it reads it through snapshotFeature(). Keeping the
  // emptiness test at the commit boundary is what preserves that crumb — a
  // report filed from inside an empty auto-sketch must still show the sketch.
  it("keeps the open-sketch snapshot available for the bug reporter", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, undefined, "dp1");
    const snap = s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    expect(snap).not.toBeNull();
    expect(snap.planeId).toBe("dp1");
    expect(snap.entities).toEqual([]);
  });

  // The invariant that broke this once: every entity enter() injects must be
  // recognisable as synthetic, or the next one added silently re-defeats the
  // guard the way the origin did.
  it("marks every synthetic entity enter() injects as origin geometry", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, undefined, "dp1");
    const ents = (s as unknown as { entities: { id: string }[] }).entities;
    expect(ents.length).toBe(originGeometry().length);
    expect(ents.every((e) => isOriginGeometry(e.id))).toBe(true);
  });
});

describe("hasDrawnGeometry reports what the user would lose", () => {
  let doc: CadDocument;
  beforeEach(() => {
    doc = { version: 5, parameters: {}, features: [{ ...DATUM }] };
  });

  it("is false on a fresh sketch and true once something is drawn", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, undefined, "dp1");
    expect(s.hasDrawnGeometry()).toBe(false);
    (s as unknown as { entities: unknown[] }).entities.push({
      type: "circle", id: "c1", x: 0, y: 0, radius: 3,
    });
    expect(s.hasDrawnGeometry()).toBe(true);
  });
});
