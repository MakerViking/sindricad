// A projection refresh delivered to the OPEN sketch walks to the new curves.
//
// The store walks a closed sketch's refresh in steps (projectionWalk.ts) because
// one solve from the old coordinates against curves that moved further than a
// dimension lands the geometry on its mirror side, every number reading
// "satisfied" (field reports 6124e4a7, 66d7eb71). The sketch you have open is
// refreshed by a different path: the store hands the entries to
// SketchMode.syncProjectedCurves (main.ts wires store.onProjectionsApplied to
// it) and the session solves them itself. These drive that handler and the
// real solve pump with the real planegcs solve, and check WHERE the geometry
// ended up.
//
// Driving a real SketchMode needs WebGL, so `this` is a hand-built stand-in
// with the drawing collaborators stubbed; syncProjectedCurves, pump and the
// walk are the real methods off the prototype.

import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => {} }));
// the real solve, until a test kills it the way a WebView that refuses the
// WASM does
const solver = vi.hoisted(() => ({ dead: false }));
vi.mock("./sketchSolve", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sketchSolve")>();
  return {
    ...real,
    compileAndSolve: (...a: Parameters<typeof real.compileAndSolve>) =>
      solver.dead ? Promise.reject(new Error("solver gone")) : real.compileAndSolve(...a),
  };
});

import { SketchMode } from "./sketchMode";
import { SketchHistory } from "./history";
import type { ResolvedEntity } from "./snap";
import type { ProjectionUpdate, SketchConstraint } from "../types";

interface Priv {
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  solveBusy: boolean;
  solveDirty: boolean;
  solverDead: boolean;
  pendingRefresh: unknown;
  entityVersion: number;
  history: SketchHistory;
}

const src = { kind: "edge" as const, body: "body1", sel: { kind: "edge" as const, by: "match" as const, fp: { mid: [0, 0, 0] as [number, number, number], dir: [1, 0, 0] as [number, number, number] } } };
const proj = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ id, type: "projected", source: src, curve: { kind: "line", x1, y1, x2, y2 } });
const upd = (entity: string, x1: number, y1: number, x2: number, y2: number): ProjectionUpdate =>
  ({ sketch: "s1", entity, curve: { kind: "line", x1, y1, x2, y2 }, stale: false });

/** The open sketch of the store test's 66d7eb71 case: a hole dimensioned 10 mm
 *  from a plate's left and bottom edges, both projected. */
function openSketch() {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  Object.assign(s, {
    active: true, tool: "select", patterns: [], selected: new Set<string>(),
    entities: [
      proj("bottom", 30, -20, -30, -20), proj("left", -30, -20, -30, 40),
      { id: "hole", type: "circle", x: -20, y: -10, radius: 5 },
    ] as ResolvedEntity[],
    constraints: [
      { type: "p2lDistance", e: "hole", p: 0, line: "bottom", value: 10 },
      { type: "p2lDistance", e: "hole", p: 0, line: "left", value: 10 },
      { type: "diameter", circle: "hole", value: 10 },
    ] as SketchConstraint[],
    solveBusy: false, solverDead: false, solveDirty: false, pendingDrag: null, pendingPinIdxs: null,
    pendingRefresh: null, pendingBias: null, moveDrag: null, dragFrom: null, dragRelease: null,
    entityVersion: 0, trial: null, editingId: "s1", history: new SketchHistory(),
    refreshActive() {}, onState() {},
  });
  const priv = s as unknown as Priv;
  // the session's baseline, as opening the sketch arms it
  priv.history.reset({ entities: priv.entities, constraints: priv.constraints, patterns: [] });
  /** let the solve pump finish everything queued */
  const settle = () => vi.waitFor(() => {
    expect(priv.solveBusy || priv.solveDirty || priv.pendingRefresh !== null).toBe(false);
  }, { timeout: 5000, interval: 5 });
  const at = (id: string) => priv.entities.find((e) => e.id === id) as unknown as { x: number; y: number; curve: unknown };
  return { s, priv, settle, at };
}

describe("open sketch: a projection refresh walks to the new curves", () => {
  for (const reversed of [false, true]) {
    it(`keeps a hole 10 mm from a plate edge that moves 16 mm${reversed ? " (edge handed back end for end)" : ""}`, async () => {
      const { s, settle, at } = openSketch();
      const curve = reversed
        ? { kind: "line", x1: -14, y1: 40, x2: -14, y2: -20 }
        : { kind: "line", x1: -14, y1: -20, x2: -14, y2: 40 };
      s.syncProjectedCurves([upd("bottom", 30, -20, -14, -20), upd("left", curve.x1, curve.y1, curve.x2, curve.y2)]);
      await settle();
      expect(at("left").curve).toEqual(curve);
      // inside the plate, 10 mm from the moved edge; one solve put it at (-24, -10)
      expect(at("hole").x).toBeCloseTo(-4, 6);
      expect(at("hole").y).toBeCloseTo(-10, 6);
    });
  }

  it("a sketch with nothing to solve takes the curves at once, as before", () => {
    const { s, priv, at } = openSketch();
    priv.constraints = [];
    s.syncProjectedCurves([upd("left", -14, -20, -14, 40)]);
    expect(at("left").curve).toEqual({ kind: "line", x1: -14, y1: -20, x2: -14, y2: 40 });
    expect(at("hole").x).toBe(-20);
  });

  // Undo in the open sketch must not put the projected curves back where the
  // body no longer is: the refresh is derived from the body, never an edit.
  for (const constrained of [true, false]) {
    it(`is not an undo step (${constrained ? "walked" : "nothing to solve"})`, async () => {
      const { s, priv, settle, at } = openSketch();
      if (!constrained) priv.constraints = [];
      s.syncProjectedCurves([upd("left", -14, -20, -14, 40)]);
      await settle();
      expect(at("left").curve).toEqual({ kind: "line", x1: -14, y1: -20, x2: -14, y2: 40 });
      expect(priv.history.canUndo).toBe(false);
    });
  }

  it("still lands the curves when the solver dies during the walk", async () => {
    const { s, priv, at } = openSketch();
    solver.dead = true;
    try {
      s.syncProjectedCurves([upd("bottom", 30, -20, -14, -20), upd("left", -14, -20, -14, 40)]);
      await vi.waitFor(() => expect(priv.solverDead).toBe(true), { timeout: 5000, interval: 5 });
      await vi.waitFor(() => expect(priv.solveBusy).toBe(false), { timeout: 5000, interval: 5 });
    } finally {
      solver.dead = false;
    }
    expect(at("left").curve).toEqual({ kind: "line", x1: -14, y1: -20, x2: -14, y2: 40 });
    expect(at("bottom").curve).toEqual({ kind: "line", x1: 30, y1: -20, x2: -14, y2: -20 });
    expect(priv.pendingRefresh).toBeNull();
    expect(priv.history.canUndo).toBe(false);
  });

  it("a draw that lands mid-walk keeps its entity, and the curves still land", async () => {
    const { s, priv, settle, at } = openSketch();
    s.syncProjectedCurves([upd("bottom", 30, -20, -14, -20), upd("left", -14, -20, -14, 40)]);
    // the walk is awaiting its first solve: draw a point, as a click would
    priv.entities = [...priv.entities, { id: "pt", type: "point", x: 50, y: 50 }];
    priv.entityVersion++;
    await settle();
    expect(at("pt")).toBeDefined();
    expect(at("left").curve).toEqual({ kind: "line", x1: -14, y1: -20, x2: -14, y2: 40 });
  });
});
