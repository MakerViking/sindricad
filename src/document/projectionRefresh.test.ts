// Associative projection refresh (plan step 4): rebuild results carrying
// projectionUpdates land in the document via a DERIVED commit — no undo entry,
// chained on the param queue, guarded against preview timelines, with a
// stale-transition warning and a 5-strike oscillation valve. Driven against a
// scripted stub backend (the sidecar side is covered by sidecar/test_refresh.py).
import { describe, it, expect, beforeEach } from "vitest";
import { DocumentStore } from "./store";
import type { CadDocument, Feature, ProjectedCurve, ProjectionUpdate, RebuildReply, RebuildResult, SketchEntity } from "../types";
import type { GeometryBackend } from "../geometry/client";

const CURVE0: ProjectedCurve = { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 };
const CURVE1: ProjectedCurve = { kind: "line", x1: 5, y1: 0, x2: 15, y2: 0 };

const okReply = (updates?: ProjectionUpdate[]): RebuildReply => ({
  ok: true,
  result: {
    mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
    edges: [],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    ...(updates?.length ? { projectionUpdates: updates } : {}),
  } as RebuildResult,
});

/** Backend whose Nth rebuild/computeAll (1-based, shared count) returns next(n)'s updates. */
function scriptedBackend(next: (n: number) => ProjectionUpdate[] | undefined, calls: CadDocument[]): GeometryBackend {
  const reply = async (doc: CadDocument): Promise<RebuildReply> => {
    calls.push(doc);
    return okReply(next(calls.length));
  };
  return {
    rebuild: reply,
    computeAll: reply,
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

const pdoc = (opts: { stale?: boolean; constraints?: boolean } = {}): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "s1", type: "sketch", plane: "XY", name: "Sketch1",
      entities: [{
        id: "p1", type: "projected",
        source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
        curve: { ...CURVE0 },
        ...(opts.stale ? { stale: true } : {}),
      }],
      ...(opts.constraints ? { constraints: [{ type: "horizontal", line: "p1" }] } : {}),
    },
  ] as Feature[],
});

const updCurve = (curve: ProjectedCurve = CURVE1): ProjectionUpdate => ({ sketch: "s1", entity: "p1", curve: { ...curve }, stale: false });
const UPD_STALE: ProjectionUpdate = { sketch: "s1", entity: "p1", stale: true };

// drain the whole async chain (rebuild -> paramChain -> commit -> rebuild -> ...)
const settle = () => new Promise<void>((res) => {
  let i = 0;
  const tick = () => (++i > 30 ? res() : void setTimeout(tick, 0));
  tick();
});

const p1Of = (store: DocumentStore) => {
  const sk = store.document.features.find((f): f is Extract<Feature, { type: "sketch" }> => f.type === "sketch" && f.id === "s1");
  return sk?.entities.find((e): e is Extract<SketchEntity, { type: "projected" }> => e.type === "projected" && e.id === "p1");
};

const edit = (store: DocumentStore, id = "x1") =>
  store.addFeature({ id, type: "extrude", sketch: "s1", distance: 5, operation: "new" } as Feature);

describe("projection refresh (derived commit loop)", () => {
  let calls: CadDocument[];
  let warnings: string[];
  beforeEach(() => {
    calls = [];
    warnings = [];
  });

  const makeStore = (next: (n: number) => ProjectionUpdate[] | undefined, doc = pdoc()) => {
    const store = new DocumentStore(scriptedBackend(next, calls), doc);
    store.onWarning = (m) => void warnings.push(m);
    return store;
  };

  it("lands new curves via a derived commit — no undo entry, quiescent in 2 rebuilds", async () => {
    const store = makeStore((n) => (n === 1 ? [updCurve()] : undefined));
    edit(store); // ONE user edit -> rebuild 1 (updates) -> commit -> rebuild 2 (quiet)
    await settle();
    expect(p1Of(store)?.curve).toEqual(CURVE1);
    expect(calls.length).toBe(2); // exactly-2-rebuild quiescence
    // the derived commit did not add an undo entry: ONE undo reverts the user
    // edit (and its refresh) back to the pristine document
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.document.features).toHaveLength(1);
    expect(p1Of(store)?.curve).toEqual(CURVE0);
    expect(store.canUndo).toBe(false);
    await settle();
  });

  it("preview and edit-preview rebuilds never commit", async () => {
    const store = makeStore(() => [updCurve()]); // EVERY rebuild claims changes
    store.setPreview({ id: "pv", type: "extrude", sketch: "s1", distance: 1, operation: "new" } as Feature);
    await settle();
    expect(p1Of(store)?.curve).toEqual(CURVE0); // untouched
    expect(calls.length).toBe(1); // no derived commit -> no follow-up rebuild
    store.setPreview(null);
    store.beginEditPreview("s1");
    await settle();
    expect(p1Of(store)?.curve).toEqual(CURVE0);
  });

  it("drops updates whose sketch/entity no longer exists", async () => {
    const store = makeStore((n) => (n === 1 ? [{ sketch: "s1", entity: "gone", curve: CURVE1, stale: false }, { sketch: "nope", entity: "p1", curve: CURVE1, stale: false }] : undefined));
    const before = store.toJSON();
    edit(store);
    await settle();
    expect(calls.length).toBe(1); // nothing valid -> no commit, no extra rebuild
    store.undo();
    expect(store.toJSON()).toBe(before);
  });

  it("sets stale with ONE warning, keeps the last shape", async () => {
    const store = makeStore((n) => (n === 1 ? [UPD_STALE] : undefined));
    edit(store);
    await settle();
    const p1 = p1Of(store);
    expect(p1?.stale).toBe(true);
    expect(p1?.curve).toEqual(CURVE0); // last shape kept
    expect(warnings.filter((w) => w.includes("lost its source"))).toEqual([
      "Projected geometry in Sketch1 lost its source — keeping last shape",
    ]);
  });

  it("clears stale (key deleted, not set false) when the source resolves again", async () => {
    const store = makeStore((n) => (n === 1 ? [updCurve(CURVE0)] : undefined), pdoc({ stale: true }));
    edit(store);
    await settle();
    const p1 = p1Of(store);
    expect(p1 && "stale" in p1).toBe(false); // omit-when-false discipline
    expect(warnings).toHaveLength(0);
  });

  it("re-solves a constrained closed sketch so curves + coords land together", async () => {
    const store = makeStore((n) => (n === 1 ? [updCurve()] : undefined), pdoc({ constraints: true }));
    const seen: ProjectedCurve[] = [];
    store.headlessSolve = async (sketch) => {
      const p = sketch.entities.find((e) => e.type === "projected");
      if (p && p.type === "projected") seen.push(p.curve);
      // marker entity proves the SOLVED entities are what landed
      return { entities: [...sketch.entities, { id: "solved", type: "point", x: 1, y: 2 }] };
    };
    edit(store);
    await settle();
    expect(seen).toEqual([CURVE1]); // solver saw the NEW curve
    const sk = store.document.features[0] as Extract<Feature, { type: "sketch" }>;
    expect(sk.entities.some((e) => e.id === "solved")).toBe(true);
  });

  it("delivers open-sketch updates via the hook, never the doc", async () => {
    const store = makeStore((n) => (n === 1 ? [updCurve()] : undefined));
    store.openSketchId = () => "s1";
    const delivered: ProjectionUpdate[][] = [];
    store.onProjectionsApplied = (u) => void delivered.push(u);
    edit(store);
    await settle();
    expect(delivered).toEqual([[updCurve()]]);
    expect(p1Of(store)?.curve).toEqual(CURVE0); // doc copy untouched
    expect(calls.length).toBe(1); // no derived commit -> no follow-up rebuild
  });

  it("valve trips after 5 consecutive applied refreshes and warns once", async () => {
    // oscillation: every rebuild reports a change (alternating curves)
    const store = makeStore((n) => [updCurve(n % 2 ? CURVE1 : CURVE0)]);
    edit(store);
    await settle();
    // rebuild 1..5 applied (each triggering the next); rebuild 6's updates trip
    // the valve -> no further commit, loop halts
    expect(calls.length).toBe(6);
    const valve = warnings.filter((w) => w.includes("paused automatic refresh"));
    expect(valve).toHaveLength(1);
  });

  it("open-sketch-only deliveries never inflate the streak (no false valve trip)", async () => {
    const store = makeStore(() => [updCurve()]); // EVERY rebuild claims changes
    store.openSketchId = () => "s1";
    const delivered: ProjectionUpdate[][] = [];
    store.onProjectionsApplied = (u) => void delivered.push(u);
    // 6 user edits while the sketch stays open: each rebuild re-delivers to the
    // session (the doc copy lags until finish(), so the sidecar re-emits every
    // time) — nothing is oscillating, so the valve must NOT trip
    for (let i = 0; i < 6; i++) {
      store.mutate(() => {}, true);
      await settle();
    }
    expect(delivered).toHaveLength(6);
    expect(warnings.filter((w) => w.includes("paused automatic refresh"))).toHaveLength(0);
  });

  it("a user edit re-arms a tripped valve (the toast's 'edit the model' path)", async () => {
    const store = makeStore((n) => (n <= 6 ? [updCurve(n % 2 ? CURVE1 : CURVE0)] : n === 7 ? [updCurve(CURVE1)] : undefined));
    edit(store);
    await settle();
    expect(calls.length).toBe(6); // tripped
    edit(store, "x2"); // new user gesture -> fresh refresh budget
    await settle();
    // rebuild 7's update applied again, rebuild 8 quiet
    expect(calls.length).toBe(8);
    expect(p1Of(store)?.curve).toEqual(CURVE1);
  });

  it("Compute All re-arms a tripped valve and applies the recomputed updates", async () => {
    const store = makeStore((n) => (n <= 6 ? [updCurve(n % 2 ? CURVE1 : CURVE0)] : n === 7 ? [updCurve(CURVE1)] : undefined));
    edit(store);
    await settle();
    expect(calls.length).toBe(6); // tripped
    await store.computeAllNow(); // call 7: the explicit retry the toast promises
    await settle();
    expect(calls.length).toBe(8); // commit applied -> one quiet follow-up rebuild
    expect(p1Of(store)?.curve).toEqual(CURVE1);
  });

  it("a quiet PREVIEW rebuild does not re-arm a tripped valve", async () => {
    // oscillate to a trip, then: preview rebuild = quiet, post-preview rebuild
    // claims changes again — the pause must hold (no reset from the preview)
    const store = makeStore((n) => (n <= 6 ? [updCurve(n % 2 ? CURVE1 : CURVE0)] : n === 7 ? undefined : [updCurve(CURVE0)]));
    edit(store);
    await settle();
    expect(calls.length).toBe(6); // tripped
    const curveAtTrip = p1Of(store)?.curve;
    store.setPreview({ id: "pv", type: "extrude", sketch: "s1", distance: 1, operation: "new" } as Feature); // call 7 (quiet)
    await settle();
    store.setPreview(null); // call 8: updates again — still paused
    await settle();
    expect(calls.length).toBe(8); // no commit -> no follow-up rebuild
    expect(p1Of(store)?.curve).toEqual(curveAtTrip);
    expect(warnings.filter((w) => w.includes("paused automatic refresh"))).toHaveLength(1); // warned once, stayed shut
  });
});
