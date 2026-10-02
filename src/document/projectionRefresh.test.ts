// Associative projection refresh (plan step 4): rebuild results carrying
// projectionUpdates land in the document via a DERIVED commit — no undo entry,
// chained on the param queue, guarded against preview timelines, with a
// stale-transition warning and a 5-strike oscillation valve. Driven against a
// scripted stub backend (the sidecar side is covered by sidecar/test_refresh.py).
import { describe, it, expect, beforeEach, vi } from "vitest";

declare const process: { cwd(): string };
// the wasm `?url` import resolves root-relative under vitest (see
// sketch/sketchSolve.test.ts) — point the loader at the file on disk
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { DocumentStore } from "./store";
import type { CadDocument, Feature, ProjectedCurve, ProjectionUpdate, RebuildReply, RebuildResult, SketchConstraint, SketchEntity } from "../types";
import type { GeometryBackend } from "../geometry/client";
import { solveSketchFeature } from "../sketch/headlessSolve";

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

// --- following a projected edge that moved FAR (6124e4a7, 66d7eb71) ----------
//
// These run the REAL planegcs solve, the one main.ts injects. The distances are
// unsigned: one solve from the old coordinates against the new curves lands on
// the mirror image whenever a reference moves further than the dimension, and
// every dimension still reads "satisfied". So each test checks WHERE the
// geometry ended up, not that a solve happened.

type SketchF = Extract<Feature, { type: "sketch" }>;

const src = { kind: "edge" as const, body: "body1", sel: { kind: "edge" as const, by: "match" as const, fp: { mid: [0, 0, 0] as [number, number, number], dir: [1, 0, 0] as [number, number, number] } } };
const proj = (id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity =>
  ({ id, type: "projected", source: src, curve: { kind: "line", x1, y1, x2, y2 } });
const upd = (entity: string, x1: number, y1: number, x2: number, y2: number): ProjectionUpdate =>
  ({ sketch: "s1", entity, curve: { kind: "line", x1, y1, x2, y2 }, stale: false });

const sketchIn = (store: DocumentStore) =>
  store.document.features.find((f): f is SketchF => f.type === "sketch" && f.id === "s1")!;
const entityIn = (store: DocumentStore, id: string) =>
  sketchIn(store).entities.find((e) => e.id === id) as unknown as { x: number; y: number; width: number; height: number; curve: ProjectedCurve };

describe("projection refresh: dimensioned geometry follows a far move", () => {
  let calls: CadDocument[];
  let issues: string[];
  beforeEach(() => {
    calls = [];
    issues = [];
  });

  /** The store as main.ts wires it, the sidecar reporting `updates` once. */
  function refreshed(doc: CadDocument, updates: ProjectionUpdate[]) {
    const store = new DocumentStore(scriptedBackend((n) => (n === 1 ? updates : undefined), calls), doc);
    store.headlessSolve = solveSketchFeature;
    store.onParamSolveIssue = (id) => void issues.push(id);
    return store;
  }
  /** the derived commit landed and its own rebuild came back quiet */
  const landed = () => vi.waitFor(() => expect(calls.length).toBe(2), { timeout: 5000 });

  // 6124e4a7: a 40x40 rectangle held 5 mm inside a projected 50x50 square, the
  // way the field document ties it (projected corner -> rectangle edge). The
  // square becomes 40x40, its right and top edges moving 7 mm, further than 5.
  const square = (l: number, r: number, b: number, t: number) => [
    proj("left", l, t, l, b), proj("top", r, t, l, t), proj("right", r, b, r, t), proj("bottom", l, b, r, b),
  ];
  const insetDoc = (): CadDocument => ({
    parameters: {},
    features: [{
      id: "s1", type: "sketch", plane: "XY", name: "Sketch1",
      entities: [...square(-25, 25, -25, 25), { id: "r", type: "rectangle", x: 0, y: 0, width: 40, height: 40 }],
      constraints: [
        ["right", "r~1"], ["top", "r~2"], ["left", "r~3"], ["bottom", "r~0"],
      ].flatMap(([p, edge]) => [
        { type: "parallel", l1: p, l2: edge },
        { type: "p2lDistance", e: p, p: 0, line: edge, value: 5 },
      ]) as SketchConstraint[],
    }] as Feature[],
  });

  it("keeps a rectangle 5 mm inside a projected square that shrinks by more than 5", async () => {
    const store = refreshed(insetDoc(), [
      upd("left", -22, 18, -22, -22), upd("top", 18, 18, -22, 18),
      upd("right", 18, -22, 18, 18), upd("bottom", -22, -22, 18, -22),
    ]);
    edit(store);
    await landed();
    expect(entityIn(store, "right").curve).toEqual({ kind: "line", x1: 18, y1: -22, x2: 18, y2: 18 });
    const r = entityIn(store, "r");
    // 5 mm in from every side of the new -22..18 square: 30x30, centred on -2
    expect(r.width).toBeCloseTo(30, 6);
    expect(r.height).toBeCloseTo(30, 6);
    expect(r.x).toBeCloseTo(-2, 6);
    expect(r.y).toBeCloseTo(-2, 6);
    expect(issues).toEqual([]);
  });

  // 66d7eb71's front-end half: a hole dimensioned 10 mm from a plate's left and
  // bottom edges. The left edge moves 16 mm inward. (Its sidecar half, the edge
  // rebinding to the hole's circle, is not covered here and not fixed.)
  const holeDoc = (): CadDocument => ({
    parameters: {},
    features: [{
      id: "s1", type: "sketch", plane: "XY", name: "Sketch1",
      entities: [
        proj("bottom", 30, -20, -30, -20), proj("left", -30, -20, -30, 40),
        { id: "hole", type: "circle", x: -20, y: -10, radius: 5 },
      ],
      constraints: [
        { type: "p2lDistance", e: "hole", p: 0, line: "bottom", value: 10 },
        { type: "p2lDistance", e: "hole", p: 0, line: "left", value: 10 },
        { type: "diameter", circle: "hole", value: 10 },
      ],
    }] as Feature[],
  });

  for (const reversed of [false, true]) {
    it(`keeps a hole 10 mm from a plate edge that moves 16 mm${reversed ? " (edge handed back end for end)" : ""}`, async () => {
      const left = reversed ? upd("left", -14, 40, -14, -20) : upd("left", -14, -20, -14, 40);
      const store = refreshed(holeDoc(), [upd("bottom", 30, -20, -14, -20), left]);
      edit(store);
      await landed();
      const h = entityIn(store, "hole");
      // inside the plate, 10 mm from the moved edge; the mirror is (-24, -10)
      expect(h.x).toBeCloseTo(-4, 6);
      expect(h.y).toBeCloseTo(-10, 6);
      expect(issues).toEqual([]);
    });
  }

  // A walk is not rigid: a projected edge that TURNS shrinks part-way along,
  // and a sketch line held to both its ends at a fixed length cannot follow it
  // through the middle steps. The single solve gets this one right and keeps
  // the point on its side, so a walk that cannot finish must fall back to it
  // rather than refuse a refresh that never needed walking.
  it("follows a projected edge that turns 90 degrees, which the walk cannot solve part-way", async () => {
    const doc: CadDocument = {
      parameters: {},
      features: [{
        id: "s1", type: "sketch", plane: "XY", name: "Sketch1",
        entities: [
          proj("edge", -20, 0, 20, 0),
          { id: "ln", type: "line", x1: -20, y1: 0, x2: 20, y2: 0 },
          { id: "pt", type: "point", x: 0, y: 3 },
        ],
        constraints: [
          { type: "coincident", e1: "ln", p1: 0, e2: "edge", p2: 0 },
          { type: "coincident", e1: "ln", p1: 1, e2: "edge", p2: 1 },
          { type: "distance", line: "ln", value: 40 },
          { type: "p2lDistance", e: "pt", p: 0, line: "edge", value: 3 },
        ],
      }] as Feature[],
    };
    const store = refreshed(doc, [upd("edge", 0, -20, 0, 20)]);
    edit(store);
    await landed();
    const ln = entityIn(store, "ln") as unknown as { x1: number; y1: number; x2: number; y2: number };
    expect(ln.x1).toBeCloseTo(0, 6);
    expect(ln.y1).toBeCloseTo(-20, 6);
    expect(ln.x2).toBeCloseTo(0, 6);
    expect(ln.y2).toBeCloseTo(20, 6);
    // 3 mm off the turned edge, on the same side of it as before
    const pt = entityIn(store, "pt");
    expect(pt.x).toBeCloseTo(-3, 6);
    expect(issues).toEqual([]);
  });

  it("refuses a solve that still lands on the far side: curves land, coordinates stay, the sketch is reported", async () => {
    const store = refreshed(holeDoc(), [upd("bottom", 30, -20, -14, -20), upd("left", -14, -20, -14, 40)]);
    // a solver that satisfies every number on the mirror branch once the edge
    // has arrived: exactly what a single unsigned solve did
    store.headlessSolve = async (sk, p) => {
      const out = await solveSketchFeature(sk, p);
      const left = sk.entities.find((e) => e.id === "left");
      const arrived = left?.type === "projected" && left.curve.kind === "line" && left.curve.x1 === -14;
      if (!out || !arrived) return out;
      return { entities: out.entities.map((e) => (e.id === "hole" ? { ...e, x: -24 } : e)) };
    };
    edit(store);
    await landed();
    expect(entityIn(store, "left").curve).toEqual({ kind: "line", x1: -14, y1: -20, x2: -14, y2: 40 });
    const h = entityIn(store, "hole");
    expect(h.x).toBe(-20); // left where it was, not written on the wrong side
    expect(h.y).toBe(-10);
    expect(issues).toEqual(["s1"]);
  });
});
