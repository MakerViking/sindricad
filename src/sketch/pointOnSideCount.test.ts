// A point put on a polygon SIDE (`pointOn` on `P~k`), and the polygon's side
// count changed from the parameter table. Side k of a hexagon is not side k of
// an octagon, and the solve pulled the point onto the new side k's line, past
// a vertex and off the outline, with ok and no conflict: a hexagon (r 10) with
// its point on side 3 at (-7.5, -4.33) moved 3.99 mm to (-11.33, -3.20) as an
// octagon (review of the pointOn change).
//
// Both ways a parameter reaches the sketch, through the real solver: the OPEN
// sketch (store.onParamsApplied -> SketchMode.syncParamValues) and a CLOSED one
// (DocumentStore.setParamExpr -> recompute -> the headless re-solve). The edit
// box is in rigidShapeTools.test.ts.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));
// the store schedules its debounced rebuild off `window`
vi.stubGlobal("window", { setTimeout, clearTimeout });

import { liveSketch } from "./liveSketch.testkit";
import { lineOperand } from "./entityDims";
import { solveSketchFeature } from "./headlessSolve";
import { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, Feature, ParamTarget, RebuildReply, SketchConstraint, SketchEntity } from "../types";
import type { ResolvedEntity } from "./snap";

const HEX: ResolvedEntity = { type: "polygon", id: "H", x: 0, y: 0, radius: 10, sides: 6, angle: 0 };
/** the middle of the hexagon's side 3, (-10,0) -> (-5,-8.66) */
const P0 = { x: -7.5, y: -5 * Math.sqrt(3) / 2 };
const ON_SIDE_3: SketchConstraint = { type: "pointOn", e: "P", p: 0, curve: "H~3" };

/** how far `q` is from the nearest side SEGMENT of polygon `poly`: 0 on the
 *  outline, more on a side's extension past a vertex */
function offOutline(poly: ResolvedEntity, q: { x: number; y: number }): number {
  if (poly.type !== "polygon") throw new Error("not a polygon");
  const byId = new Map([[poly.id, poly]]);
  let best = Infinity;
  for (let k = 0; k < poly.sides; k++) {
    const s = lineOperand(byId, `${poly.id}~${k}`)!;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const t = Math.max(0, Math.min(1, ((q.x - s.x1) * dx + (q.y - s.y1) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(s.x1 + t * dx - q.x, s.y1 + t * dy - q.y));
  }
  return best;
}

describe("a point on a polygon side, when the side count changes from a parameter", () => {
  it("open sketch: the point is re-aimed at the side it is on now, and stays on the outline", async () => {
    const live = liveSketch([{ ...HEX }, { type: "point", id: "P", ...P0 }], [{ ...ON_SIDE_3 }]);
    await live.settle();
    const s = live.s as unknown as {
      store: unknown; editingId: string; pendingBindings: Map<string, unknown>;
      constraints: SketchConstraint[]; syncParamValues(): void;
    };
    // the parameter table now drives H's side count to 8
    s.store = {
      boundExpr: (tg: ParamTarget) =>
        tg.kind === "entity" && tg.entity === "H" && tg.field === "sides" ? { name: "n", expr: "8", value: 8 } : null,
    };
    s.editingId = "f1";
    s.pendingBindings = new Map();
    s.syncParamValues();
    await live.settle();
    const poly = live.ent("H")!;
    const p = live.ent("P") as { x: number; y: number };
    expect((poly as { sides: number }).sides).toBe(8);
    // the octagon's side 4 runs (-10,0) -> (-7.07,-7.07), the stretch P is on
    expect(s.constraints).toEqual([{ ...ON_SIDE_3, curve: "H~4" }]);
    expect(offOutline(poly, p), "on the octagon's outline, not a side's extension").toBeLessThan(1e-6);
    expect(Math.hypot(p.x - P0.x, p.y - P0.y), "out to the new side, not 3.99 mm along a wrong one").toBeLessThan(1);
  });

  it("closed sketch: the parameter commit re-aims it before the headless re-solve", async () => {
    const backend = {
      async rebuild(): Promise<RebuildReply> { return { ok: false, error: { message: "stub" } }; },
      async init() {},
      onStatus() { return () => {}; },
      connected: true,
    } as unknown as GeometryBackend;
    const doc: CadDocument = {
      parameters: { n: 6 },
      paramDefs: { n: { expr: "6", value: 6, unit: "count", target: { kind: "entity", sketch: "f1", entity: "H", field: "sides" } } },
      features: [{
        id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
        entities: [{ ...HEX }, { type: "point", id: "P", ...P0 }] as SketchEntity[],
        constraints: [{ ...ON_SIDE_3 }],
      }] as Feature[],
    };
    const store = new DocumentStore(backend, doc);
    store.headlessSolve = solveSketchFeature;
    expect(store.setParamExpr("n", "8")).toBeNull();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    const f = store.document.features[0] as Extract<Feature, { type: "sketch" }>;
    const poly = f.entities.find((e) => e.id === "H") as unknown as ResolvedEntity;
    const p = f.entities.find((e) => e.id === "P") as unknown as { x: number; y: number };
    expect((poly as { sides: number }).sides).toBe(8);
    expect(f.constraints).toEqual([{ ...ON_SIDE_3, curve: "H~4" }]);
    expect(offOutline(poly, p)).toBeLessThan(1e-6);
    expect(Math.hypot(p.x - P0.x, p.y - P0.y)).toBeLessThan(1);
  });
});

// An extrude that starts from or runs up to one of the polygon's corners or
// sides, from any sketch, names it by its index the same way: corner 1 of a
// hexagon is corner 2 of a dodecagon. It kept the index and moved to another
// corner without a word, while the constraints were re-aimed.
describe("an extrude up to a polygon's corner or side, when the side count changes from a parameter", () => {
  it("closed sketch: the parameter commit re-aims it as it does a constraint, and one undo takes it back", async () => {
    const backend = {
      async rebuild(): Promise<RebuildReply> { return { ok: false, error: { message: "stub" } }; },
      async init() {},
      onStatus() { return () => {}; },
      connected: true,
    } as unknown as GeometryBackend;
    const corner = (k: number) => ({ kind: "sketchPoint" as const, sketch: "f1", entity: "H", pointIndex: k });
    const side = (k: number) => ({ kind: "sketchLine" as const, sketch: "f1", entity: `H~${k}` });
    const doc: CadDocument = {
      parameters: { n: 6 },
      paramDefs: { n: { expr: "6", value: 6, unit: "count", target: { kind: "entity", sketch: "f1", entity: "H", field: "sides" } } },
      features: [
        { id: "f1", type: "sketch", plane: "XZ", name: "Sketch1", entities: [{ ...HEX }] as SketchEntity[] },
        { id: "f0", type: "sketch", plane: "XY", name: "Sketch2", entities: [{ type: "circle", id: "c0", x: 0, y: 0, radius: 5 }] },
        { id: "x1", type: "extrude", sketch: "f0", distance: 5, operation: "new", startFrom: side(1), upToRef: corner(1) },
      ] as Feature[],
    };
    const store = new DocumentStore(backend, doc);
    store.headlessSolve = solveSketchFeature;
    const x1 = () => store.document.features.find((f) => f.id === "x1") as Extract<Feature, { type: "extrude" }>;
    expect(store.setParamExpr("n", "12")).toBeNull();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect((store.document.features[0] as Extract<Feature, { type: "sketch" }>).entities[0], "precondition").toMatchObject({ sides: 12 });
    // the hexagon's corner 1 is at 60 degrees, the dodecagon's corner 2
    expect(x1().upToRef).toEqual(corner(2));
    expect(x1().startFrom).toEqual(side(3));
    store.undo();
    expect(x1().upToRef).toEqual(corner(1));
    expect(x1().startFrom).toEqual(side(1));
  });
});
