// Clearing an extrude / press-pull's up-to target (GH #41).
//
// The target used to be permanent: nothing in the app deleted `upTo` or
// `upToPlane`, so a feature committed with "up to that face" could never go
// back to a plain depth — and taper, which the inspector hides while a target
// exists, stayed unreachable on that feature forever.
//
// Three things make the clear safe rather than merely tidy, and each has a test
// here because each one is a rebuild error when it is missed:
//   * the keys must be DELETED, not set to undefined (the sidecar refuses an
//     `upToOffset` with nothing to offset from, and a key that is present with
//     value undefined is still a key to every `in`/Object.keys reader);
//   * a zero (or absent) distance has to become a real depth, because the
//     sidecar refuses a blind extrude of 0 and an up-to extrude never read it;
//   * a parameter BOUND to `upToOffset` has to go with it, or the recompute
//     that runs inside every mutate writes the orphan straight back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DocumentStore } from "./store";
import { DEFAULT_EXTRUDE_DISTANCE, resolveTarget } from "./numFields";
import type { CadDocument, Feature, ParamDef, RebuildReply } from "../types";
import type { GeometryBackend } from "../geometry/client";

function stubBackend(): GeometryBackend {
  return {
    async rebuild(): Promise<RebuildReply> {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
}

const extrude = (extra: Record<string, unknown>) =>
  ({
    id: "e1",
    type: "extrude",
    sketch: "s1",
    operation: "new",
    ...extra,
  }) as unknown as Feature;

function makeStore(features: Feature[], paramDefs?: Record<string, ParamDef>) {
  const doc = {
    parameters: {},
    features,
    ...(paramDefs ? { paramDefs } : {}),
  } as unknown as CadDocument;
  return new DocumentStore(stubBackend(), doc);
}

/** the live feature after the mutation (the store clones its input document) */
const feat = (store: DocumentStore, id = "e1") =>
  store.document.features.find((f) => f.id === id) as unknown as Record<string, unknown>;

describe("store.clearUpToTarget", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("deletes the three end-condition keys outright", () => {
    const store = makeStore([
      extrude({ distance: 5, upToPlane: "d1", upToOffset: 3 }),
    ]);

    store.clearUpToTarget("e1");

    const f = feat(store);
    expect("upToPlane" in f, "the plane target is still a key on the feature").toBe(false);
    expect("upTo" in f).toBe(false);
    expect("upToOffset" in f, "the sidecar refuses an offset with no target").toBe(false);
    expect(f.distance, "a real depth was overwritten").toBe(5);
  });

  it("gives a target-only extrude a real depth to fall back on", () => {
    // An up-to extrude never read `distance`, so it can legitimately be 0 — and
    // a blind extrude of 0 is refused by the sidecar. A control that leaves a
    // red timeline chip behind is worse than no control.
    const zero = makeStore([extrude({ distance: 0, upToPlane: "d1" })]);
    zero.clearUpToTarget("e1");
    expect(feat(zero).distance).toBe(DEFAULT_EXTRUDE_DISTANCE);

    const none = makeStore([extrude({ upTo: { kind: "face", by: "nearest", point: [0, 0, 5] } })]);
    none.clearUpToTarget("e1");
    expect(feat(none).distance).toBe(DEFAULT_EXTRUDE_DISTANCE);
  });

  it("drops the parameter bound to the offset, so the recompute cannot write it back", () => {
    const store = makeStore(
      [extrude({ distance: 5, upToPlane: "d1", upToOffset: 3 })],
      {
        d1: { expr: "3", value: 3, unit: "mm", target: { kind: "feature", feature: "e1", field: "upToOffset" } },
        keep: { expr: "8", value: 8, unit: "mm" },
      },
    );

    store.clearUpToTarget("e1");

    expect("upToOffset" in feat(store), "the bound value was written back onto the cleared feature").toBe(false);
    expect(Object.keys(store.document.paramDefs ?? {})).toEqual(["keep"]);
  });

  it("is one undo step, target and binding together", () => {
    const store = makeStore(
      [extrude({ distance: 5, upToPlane: "d1", upToOffset: 3 })],
      { d1: { expr: "3", value: 3, unit: "mm", target: { kind: "feature", feature: "e1", field: "upToOffset" } } },
    );

    store.clearUpToTarget("e1");
    store.undo();

    const f = feat(store);
    expect(f.upToPlane, "undo did not bring the target back").toBe("d1");
    expect(f.upToOffset).toBe(3);
    expect(Object.keys(store.document.paramDefs ?? {})).toEqual(["d1"]);
  });

  it("covers press/pull, which carries the same three fields", () => {
    const store = makeStore([
      {
        id: "p1",
        type: "press-pull",
        face: {},
        operation: "join",
        distance: 4,
        upTo: { kind: "face", by: "nearest", point: [0, 0, 10] },
        upToOffset: 2,
      } as unknown as Feature,
    ]);

    store.clearUpToTarget("p1");

    const f = feat(store, "p1");
    expect("upTo" in f).toBe(false);
    expect("upToOffset" in f).toBe(false);
    expect(f.distance, "press/pull's own depth was overwritten").toBe(4);
  });

  it("does nothing to a feature that has no target, or to a missing one", () => {
    const store = makeStore([extrude({ distance: 5 })]);
    const before = store.toJSON();

    store.clearUpToTarget("e1");
    store.clearUpToTarget("ghost");

    expect(store.toJSON()).toBe(before);
  });
});

describe("resolveTarget honours the row's applies predicate", () => {
  // Without this, a parameter bound to `upToOffset` still resolves after the
  // target is gone and every recompute re-creates the orphan the sidecar
  // refuses — the same resurrection, reached from any other edit.
  const doc = (f: Record<string, unknown>) =>
    ({ parameters: {}, features: [{ id: "e1", type: "extrude", ...f }] }) as unknown as CadDocument;
  const offset = { kind: "feature", feature: "e1", field: "upToOffset" } as const;

  it("resolves the offset while a target exists", () => {
    expect(resolveTarget(doc({ distance: 5, upToPlane: "d1" }), offset)).not.toBeNull();
  });

  it("resolves to nothing once the target is gone", () => {
    expect(resolveTarget(doc({ distance: 5 }), offset)).toBeNull();
  });

  it("still resolves a field with no predicate", () => {
    expect(resolveTarget(doc({ distance: 5 }), { kind: "feature", feature: "e1", field: "distance" })).not.toBeNull();
  });

  // ...but ONLY for a field the document stops having. `taper` also carries an
  // `applies` predicate, and there it is a RENDER gate: the inspector hides the
  // row while a target is set because the sidecar IGNORES a taper under one
  // (sidecar/test_extrude_taper.py::test_up_to_ignores_taper_rather_than_fighting_it),
  // not because the field went away. Treating the predicate as an existence
  // test made params.recompute read a live binding as dangling.
  it("keeps resolving taper on a feature that gained an up-to target", () => {
    expect(
      resolveTarget(doc({ distance: 5, upToPlane: "d1", taper: 3 }), {
        kind: "feature",
        feature: "e1",
        field: "taper",
      }),
      "a taper under a target is ignored by the sidecar, not refused — the binding is still live",
    ).not.toBeNull();
  });
});

describe("a parameter bound to Taper survives an up-to target", () => {
  // The regression this pins is silent and permanent: resolveTarget returning
  // null for `taper` made params.recompute (which runs inside EVERY mutate)
  // treat the binding as dangling and delete the def outright. The number
  // stayed on the feature, so nothing looked wrong — and clearing the target
  // again, the whole point of GH #41, did not bring the parameter back.
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const taperTarget = { kind: "feature", feature: "e1", field: "taper" } as const;
  const bound = (): Record<string, ParamDef> => ({
    wall: { expr: "6", value: 6 } as unknown as ParamDef,
    lip: { expr: "wall / 2", value: 3, target: taperTarget } as unknown as ParamDef,
  });

  it("is not deleted when the extrude is aimed at a target", () => {
    const store = makeStore([extrude({ distance: 5, taper: 3 })], bound());

    store.replaceFeature("e1", extrude({ distance: 5, taper: 3, upToPlane: "d1" }));

    const defs = store.document.paramDefs ?? {};
    expect(Object.keys(defs).sort(), "the user's taper expression was dropped without a word").toEqual(["lip", "wall"]);
    expect(defs.lip?.expr).toBe("wall / 2");
  });

  it("still drives taper after the target is cleared again", async () => {
    const store = makeStore([extrude({ distance: 5, taper: 3 })], bound());

    store.replaceFeature("e1", extrude({ distance: 5, taper: 3, upToPlane: "d1" }));
    store.clearUpToTarget("e1");
    // Move the parameter the binding depends on and let the commit cascade
    // settle: taper has to follow it. This is the EFFECT — a surviving def that
    // no longer drives its field would pass a "the def is still there" check.
    store.setParamExpr("wall", "20");
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(store.document.paramDefs?.lip, "the binding did not survive the round trip").toBeTruthy();
    expect(feat(store).taper, "taper is a dead literal — changing `wall` no longer moves it").toBe(10);
  });

  it("does not report a live feature as deleted when something references the param", () => {
    const defs = bound();
    defs.rim = { expr: "lip * 2", value: 6 } as unknown as ParamDef;
    const store = makeStore([extrude({ distance: 5, taper: 3 })], defs);

    store.replaceFeature("e1", extrude({ distance: 5, taper: 3, upToPlane: "d1" }));

    expect(
      store.paramIssues.lip,
      'the feature is sitting in the timeline — "no longer exists" is false',
    ).toBeUndefined();
  });

  it("still garbage-collects a parameter bound to an orphaned upToOffset", () => {
    // the control: the narrow gate must not stop doing what it was added for
    const store = makeStore([extrude({ distance: 5, upToPlane: "d1", upToOffset: 2 })], {
      off: { expr: "2", value: 2, target: { kind: "feature", feature: "e1", field: "upToOffset" } } as unknown as ParamDef,
    });

    store.replaceFeature("e1", extrude({ distance: 5 }));

    expect(Object.keys(store.document.paramDefs ?? {}), "the orphan offset binding would be written back").toEqual([]);
  });
});
