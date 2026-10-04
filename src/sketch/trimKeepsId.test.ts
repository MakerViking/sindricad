// Trim keeps the trimmed curve's id on the piece that is still that curve
// (round 2 decision C1).
//
// Trim used to give every piece a new id. Its constraints were rewritten for
// the new ids (trimConstraints.test.ts), but everything ELSE that named the
// curve lost it: a pattern of it was removed, an extrude that started from or
// ran up to one of its points failed. The piece holding the curve's start now
// keeps its id.
//
// That is not free, and the reason Trim made every id new is the second group
// here: an extrude names its area by the ids around it and trusts them before
// its stored point, so a kept id on a piece that now bounds a DIFFERENT area
// moved the extrude there without a word. Finish now re-points those. The same
// holds for a point the trim REMOVED, which the kept piece's same index now
// names somewhere else, and for a projection of the curve in another sketch,
// which would follow the shortened piece: both stay refused or stale, as they
// were when every id was new (the last group).
//
// Every gesture goes through the real handlers (onPointerDown with Trim armed),
// and the document tests commit through the real store with finish(), the
// way the app does.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installFakeDocument } from "../ui/fakeDom.testkit";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import * as THREE from "three";
import { trimWithConstraints } from "./modify";
import { detectRegions, pointInRegion, regionsByEntities, type Region } from "./region";
import { expandPattern } from "./pattern";
import { dimRefPoints } from "./entityDims";
import { liveSketch } from "./liveSketch.testkit";
import { DocumentStore } from "../document/store";
import type { ResolvedEntity } from "./snap";
import { TRIMMED_AWAY } from "../types";
import type { CadDocument, Feature, RebuildReply, SketchEntity, SketchPattern } from "../types";
import type { GeometryBackend } from "../geometry/client";

installFakeDocument();
vi.stubGlobal("requestAnimationFrame", () => 0);

type Line = Extract<ResolvedEntity, { type: "line" }>;
type Extrude = Extract<Feature, { type: "extrude" }>;
const v = (x: number, y: number) => new THREE.Vector2(x, y);
const L = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });
const user = (ents: ResolvedEntity[]) => ents.filter((e) => !e.id.startsWith("__"));

beforeEach(() => { toasts.length = 0; });

describe("the piece that is still the curve keeps its id", () => {
  const trim = (ents: ResolvedEntity[], index: number, at: THREE.Vector2) =>
    trimWithConstraints(ents, index, at, []).entities;

  it("a line trimmed at its end keeps its id; trimmed in the middle, the piece with its start does", () => {
    const crossed = () => [L("L", 0, 0, 40, 0), L("x1", 10, -5, 10, 5), L("x2", 20, -5, 20, 5)];
    const end = trim(crossed(), 0, v(30, 0.1));
    expect(end.find((e) => e.id === "L")).toMatchObject({ x1: 0, x2: 20 });

    const middle = trim(crossed(), 0, v(15, 0.1)).filter((e) => e.type === "line" && !e.id.startsWith("x")) as Line[];
    expect(middle).toHaveLength(2);
    expect(middle.find((l) => l.id === "L")).toMatchObject({ x1: 0, x2: 10 });
    expect(middle.find((l) => l.id !== "L")).toMatchObject({ x1: 20, x2: 40 });
  });

  it("a circle keeps its id as the arc it became, and an arc as the piece with its start", () => {
    const circle = trim([{ type: "circle", id: "c", x: 0, y: 0, radius: 10 }, L("x", -20, 3, 20, 3)], 0, v(0, 10.1));
    expect(circle.find((e) => e.id === "c")?.type).toBe("arc");
    const arc = trim([{ type: "arc", id: "a", x1: 10, y1: 0, x2: -10, y2: 0, mx: 0, my: 10 }, L("x", 6, -5, 6, 15)], 0, v(-5, 8.7));
    const kept = arc.find((e) => e.id === "a") as Extract<ResolvedEntity, { type: "arc" }>;
    expect(kept.x1).toBeCloseTo(10, 9);
    expect(kept.y1).toBeCloseTo(0, 9);
  });

  it("a rectangle's id goes to the piece of its first side that starts at corner 0, as Explode gives it", () => {
    const rect: ResolvedEntity = { type: "rectangle", id: "R", x: 50, y: 25, width: 100, height: 50 };
    // trim the RIGHT side's top half, above a line across it
    const res = trimWithConstraints([rect, L("x", 90, 10, 110, 10)], 0, v(100, 40), []);
    const R = res.entities.find((e) => e.id === "R") as Line;
    expect([R.x1, R.y1, R.x2, R.y2]).toEqual([0, 0, 100, 0]);
    expect(user(res.entities).filter((e) => e.type === "line" && e.id !== "x")).toHaveLength(4);
    // a line has two ends, so corners 2 and 3 are named on the lines that have them
    const at = (q: { e: string; p: number }) => {
      const pos = dimRefPoints(res.entities.find((e) => e.id === q.e)!).find((r) => r.p === q.p)!.pos;
      return [pos.x, pos.y];
    };
    expect(Object.keys(res.points).sort()).toEqual(["2", "3", "4"]);
    expect(at(res.points[2]!)).toEqual([100, 50]);
    expect(at(res.points[3]!)).toEqual([0, 50]);
    // and its centre is on no line now
    expect(res.points[4]).toEqual({ e: "R", p: TRIMMED_AWAY });
  });
});

// --- the rest of the document ------------------------------------------------

/** A backend that never builds: these tests read the document, not the model. */
const noBackend = () => ({
  async rebuild(): Promise<RebuildReply> { return { ok: false, error: { message: "stub" } }; },
  async init() {},
  onStatus: () => () => {},
  connected: true,
}) as unknown as GeometryBackend;

/** A live sketch that IS sketch f1 of a real document, with extrude e1 built
 *  on it, so finish() commits through the real store the way the app does
 *  (explode.test.ts has the same harness). */
function onDocument(ents: ResolvedEntity[], extrude: Partial<Extrude>, patterns: SketchPattern[] = [], more: Feature[] = []) {
  const live = liveSketch(ents);
  const store = new DocumentStore(noBackend(), {
    version: 5,
    parameters: {},
    features: [
      { id: "f1", type: "sketch", plane: "XY", entities: ents, ...(patterns.length ? { patterns } : {}) },
      { id: "e1", type: "extrude", sketch: "f1", distance: 5, operation: "new", ...extrude },
      ...more,
    ],
  } as unknown as CadDocument);
  Object.assign(live.s, {
    store,
    editingId: "f1",
    patterns,
    patternFlow: { flushPending() {}, hasPending: () => false, flushOnFinish() {} },
    cleanup() {},
  });
  return {
    ...live,
    store,
    ext: (id: string) => store.document.features.find((f): f is Extrude => f.id === id && f.type === "extrude")!,
    /** Trim, clicked where a user clicks */
    trimAt(x: number, y: number) {
      live.s.tool = "trim";
      live.click(x, y);
    },
    /** Finish Sketch. The commit schedules a rebuild this test does not want. */
    finish() {
      vi.useFakeTimers();
      try {
        (live.s as unknown as { finish(): void }).finish();
      } finally {
        vi.useRealTimers();
      }
    },
  };
}
/** the areas of `ents` holding `p` */
const areaAt = (rs: Region[], p: THREE.Vector2) => rs.filter((r) => pointInRegion(p, r));
const committed = (doc: ReturnType<typeof onDocument>) =>
  (doc.store.document.features.find((f) => f.id === "f1") as { entities: ResolvedEntity[] }).entities;

// The document tests sit at (100, 100), clear of the origin axes, which a
// live sketch draws and Trim would cut against.
describe("an extrude on an area keeps that area when Trim keeps an id around it", () => {
  // R cut into quadrants by L and V. Every quadrant is bounded by all three, so
  // the ids name all four and the stored point picks the bottom-left one.
  const quadrants = () => [
    { type: "rectangle", id: "R", x: 100, y: 100, width: 20, height: 10 } as ResolvedEntity,
    L("L", 90, 100, 110, 100),
    L("V", 100, 95, 100, 105),
  ];

  it("an extrude on a quadrant that the trim merged goes to the merged area, not across the line", async () => {
    const [bl] = areaAt(detectRegions("f1", quadrants()), v(95, 97.5));
    const doc = onDocument(quadrants(), { regions: [[95, 97.5, 0]], regionEntities: [bl!.entityIds], regionHoleEntities: [[]] });
    doc.trimAt(95, 100.1); // L's left half: the two left quadrants merge
    await doc.settle();
    expect(doc.ent("L"), "the right half of L kept its id").toMatchObject({ x1: 100, x2: 110 });
    const after = detectRegions("f1", user(doc.s.entities));
    // the hazard: the old name now names only areas on the far side of V,
    // none of them holding the stored point, and the build takes the nearest
    const stale = regionsByEntities(after, bl!.entityIds);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.some((r) => pointInRegion(v(95, 97.5), r))).toBe(false);

    doc.finish();
    const e1 = doc.ext("e1");
    const named = regionsByEntities(after, e1.regionEntities![0]!, e1.regionHoleEntities![0]);
    expect(named, "named by its ids alone, as the build reads it first").toHaveLength(1);
    expect(pointInRegion(v(95, 97.5), named[0]!), "the merged left half").toBe(true);
    expect(pointInRegion(v(95, 102.5), named[0]!)).toBe(true);

    doc.store.undo();
    expect(doc.ext("e1").regionEntities).toEqual([bl!.entityIds]);
    expect(committed(doc)).toEqual(quadrants());
  });

  it("an extrude on an area the trim did not touch is left exactly as it was", async () => {
    // L runs out past both sides of R; trimming its stub outside R changes no area
    const ents = () => [{ type: "rectangle", id: "R", x: 100, y: 100, width: 20, height: 10 } as ResolvedEntity, L("L", 80, 100, 120, 100)];
    const [top] = areaAt(detectRegions("f1", ents()), v(100, 102.5));
    const ref = { regions: [[100, 102.5, 0]] as [number, number, number][], regionEntities: [top!.entityIds], regionHoleEntities: [[]] };
    const doc = onDocument(ents(), ref);
    doc.trimAt(115, 100.1);
    await doc.settle();
    expect(doc.ent("L")).toMatchObject({ x1: 80, x2: 110 });
    doc.finish();
    const e1 = doc.ext("e1");
    expect([e1.regions, e1.regionEntities, e1.regionHoleEntities]).toEqual([ref.regions, ref.regionEntities, ref.regionHoleEntities]);
  });

  it("an extrude whose area the trim opened keeps only its point, which the build resolves as before", async () => {
    // a triangle of lines; trimming one side's span between the other two opens it
    const tri = () => [L("a", 100, 100, 120, 100), L("b", 120, 100, 110, 115), L("c", 110, 115, 100, 100), L("x", 105, 95, 105, 120)];
    const [cell] = areaAt(detectRegions("f1", tri()), v(112, 104));
    const doc = onDocument(tri(), { regions: [[112, 104, 0]], regionEntities: [cell!.entityIds], regionHoleEntities: [[]] });
    doc.trimAt(112, 100.1); // a's span right of x: the triangle's right cell is open now
    await doc.settle();
    expect(areaAt(detectRegions("f1", user(doc.s.entities)), v(112, 104))).toHaveLength(0);
    doc.finish();
    expect(doc.ext("e1").regionEntities).toEqual([[]]);
    expect(doc.ext("e1").regions).toEqual([[112, 104, 0]]);
  });
});

const crossed = () => [L("L", 100, 100, 140, 100), L("x1", 110, 95, 110, 105), L("x2", 120, 95, 120, 105)];
/** where a sketchPoint reference lands in f1 as the document has it now,
 *  by the numbering the build reads it with (sidecar _sketch_ref_xy) */
const landsAt = (doc: ReturnType<typeof onDocument>, ref: Extrude["upToRef"]) => {
  if (ref?.kind !== "sketchPoint") return null;
  const e = committed(doc).find((x) => x.id === ref.entity);
  const p = e && dimRefPoints(e).find((q) => q.p === ref.pointIndex)?.pos;
  return p ? [p.x, p.y] : null;
};
/** a profile on f0 extruded up to each point of f1, as x4, x5, ... */
const upTo = (...refs: [entity: string, pointIndex: number][]): Feature[] => [
  { id: "f0", type: "sketch", plane: "XZ", entities: [{ type: "circle", id: "c0", x: 0, y: 0, radius: 5 }] },
  ...refs.map(([entity, pointIndex], i) => (
    { id: `x${4 + i}`, type: "extrude", sketch: "f0", distance: 5, operation: "new", upToRef: { kind: "sketchPoint", sketch: "f1", entity, pointIndex } }
  )),
] as unknown as Feature[];

describe("what else named the trimmed curve still finds it", () => {
  it("a pattern of it copies every piece, instead of being removed", async () => {
    const pat: SketchPattern = { id: "p0", type: "patternRect", sources: ["L"], countX: 1, countY: 2, spacingX: 0, spacingY: 30 };
    const doc = onDocument(crossed(), {}, [pat]);
    doc.trimAt(115, 100.1);
    await doc.settle();
    const pieces = user(doc.s.entities).filter((e) => e.type === "line" && !e.id.startsWith("x")).map((e) => e.id);
    expect(pieces).toHaveLength(2);
    expect((pat as { sources: string[] }).sources).toEqual(pieces);
    const copies = expandPattern(pat, new Map(doc.s.entities.map((e) => [e.id, e])), {}) as Line[];
    expect(copies.map((c) => [c.x1, c.y1, c.x2, c.y2])).toEqual([[100, 130, 110, 130], [120, 130, 140, 130]]);
  });

  it("an extrude up to an end the trim kept still runs up to that end, now on the other piece", async () => {
    const doc = onDocument(crossed(), {}, [], upTo(["L", 1]));
    doc.trimAt(115, 100.1);
    await doc.settle();
    doc.finish();
    expect(landsAt(doc, doc.ext("x4").upToRef)).toEqual([140, 100]);
    expect((doc.ext("x4").upToRef as { entity: string }).entity).not.toBe("L");
    doc.store.undo();
    expect(doc.ext("x4").upToRef).toMatchObject({ entity: "L", pointIndex: 1 });
  });

  it("a trim undone inside the sketch re-points nothing", async () => {
    const doc = onDocument(crossed(), {}, [], upTo(["L", 1]));
    doc.trimAt(115, 100.1);
    await doc.settle();
    expect(doc.s.undoEdit()).toBe(true);
    await doc.settle();
    expect(user(doc.s.entities)).toEqual(crossed());
    doc.finish();
    expect(doc.ext("x4").upToRef).toMatchObject({ entity: "L", pointIndex: 1 });
  });

  it("an extrude up to a circle's centre still runs up to it once the circle is an arc", async () => {
    const ents = () => [{ type: "circle", id: "c", x: 103, y: 104, radius: 10 } as ResolvedEntity, L("x", 80, 107, 120, 107)];
    const doc = onDocument(ents(), {}, [], upTo(["c", 0]));
    doc.trimAt(103, 114.1);
    await doc.settle();
    doc.finish();
    expect(doc.ext("x4").upToRef).toMatchObject({ entity: "c", pointIndex: 2 });
    const [x, y] = landsAt(doc, doc.ext("x4").upToRef)!;
    expect(x).toBeCloseTo(103, 9);
    expect(y).toBeCloseTo(104, 9);
  });
});

describe("what named a part of the curve the trim removed stays refused, as before", () => {
  it("an extrude up to an end the trim removed is refused, not moved to the cut", async () => {
    // L keeps its id and its point 1 is the cut at x=120 now: left alone, the
    // extrude would run up to that, without a word, where a dimension on the
    // same end is dropped and said
    const doc = onDocument(crossed(), {}, [], upTo(["L", 1], ["L", 0]));
    doc.trimAt(130, 100.1);
    await doc.settle();
    expect(doc.ent("L")).toMatchObject({ x1: 100, x2: 120 });
    doc.finish();
    expect(doc.ext("x4").upToRef).toMatchObject({ entity: "L", pointIndex: TRIMMED_AWAY });
    expect(landsAt(doc, doc.ext("x4").upToRef), "names no point, so the build refuses it").toBeNull();
    expect(doc.ext("x5").upToRef, "the start it kept is untouched").toMatchObject({ entity: "L", pointIndex: 0 });
    doc.store.undo();
    expect(doc.ext("x4").upToRef).toMatchObject({ entity: "L", pointIndex: 1 });
  });

  it("on a clockwise arc, the end the trim removed is refused and the kept ends land where they were", async () => {
    // stored clockwise: from (90,100) over the top to (110,100). The kept piece
    // is rebuilt counter-clockwise, so its point 1 is the arc's START now, 20
    // mm from the end that was trimmed away.
    const arc = () => [
      { type: "arc", id: "a", x1: 90, y1: 100, x2: 110, y2: 100, mx: 100, my: 110 } as ResolvedEntity,
      L("x", 106, 95, 106, 115),
    ];
    const doc = onDocument(arc(), {}, [], upTo(["a", 0], ["a", 1], ["a", 2]));
    doc.trimAt(108.5, 104.9); // the span at the arc's end, right of x
    await doc.settle();
    doc.finish();
    const near = (p: number[] | null) => p?.map((n) => Math.round(n * 1e6) / 1e6);
    expect(near(landsAt(doc, doc.ext("x4").upToRef)), "the start").toEqual([90, 100]);
    expect(doc.ext("x5").upToRef).toMatchObject({ entity: "a", pointIndex: TRIMMED_AWAY });
    expect(landsAt(doc, doc.ext("x5").upToRef), "the end the trim removed").toBeNull();
    expect(near(landsAt(doc, doc.ext("x6").upToRef)), "the centre").toEqual([100, 100]);
  });

  /** sketch f2, after f1: projections of L and of x1 */
  const projections = (): Feature[] => [{
    id: "f2", type: "sketch", plane: "XZ", entities: [
      { type: "projected", id: "pL", source: { kind: "sketchCurve", sketch: "f1", entity: "L" }, curve: { kind: "line", x1: 100, y1: 0, x2: 140, y2: 0 } },
      { type: "projected", id: "pX", source: { kind: "sketchCurve", sketch: "f1", entity: "x1" }, curve: { kind: "line", x1: 110, y1: 0, x2: 110, y2: 0 } },
    ],
  } as unknown as Feature];
  const projected = (doc: ReturnType<typeof onDocument>, id: string) =>
    (doc.store.document.features.find((f) => f.id === "f2") as { entities: SketchEntity[] }).entities.find((e) => e.id === id) as Extract<SketchEntity, { type: "projected" }>;

  it("a projection of the trimmed curve in another sketch goes stale instead of shrinking with it", async () => {
    const doc = onDocument(crossed(), {}, [], projections());
    const untouched = projected(doc, "pX");
    doc.trimAt(130, 100.1);
    await doc.settle();
    doc.finish();
    expect(projected(doc, "pL").source).toEqual({ kind: "sketchCurve", sketch: "f1", entity: "L", index: TRIMMED_AWAY });
    expect(projected(doc, "pX"), "a projection of a curve the trim did not cut").toEqual(untouched);
    doc.store.undo();
    expect(projected(doc, "pL").source).toEqual({ kind: "sketchCurve", sketch: "f1", entity: "L" });
  });

  it("a trim undone inside the sketch leaves the projection following", async () => {
    const doc = onDocument(crossed(), {}, [], projections());
    doc.trimAt(130, 100.1);
    await doc.settle();
    expect(doc.s.undoEdit()).toBe(true);
    await doc.settle();
    doc.finish();
    expect(projected(doc, "pL").source).toEqual({ kind: "sketchCurve", sketch: "f1", entity: "L" });
  });
});
