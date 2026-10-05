// Join: two lines that meet end to end in a straight line made one line again,
// the opposite of Break (field report 8d69be71): "if I break a line save the
// sketch and then edit the sketch and decide I want it to be a continuous line
// there is no way to remove the break."
//
// Everything goes in through the Join tool's click, as the ribbon arms it, and
// reads back the sketch the user would see: one line, the constraints that
// still apply to it, and what an extrude built on it now names.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { liveSketch } from "./liveSketch.testkit";
import { detectRegions, pointInRegion, regionsByEntities } from "./region";
import { dimRefPoints } from "./entityDims";
import { DocumentStore } from "../document/store";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { CadDocument, Feature, RebuildReply, SketchConstraint } from "../types";
import type { GeometryBackend } from "../geometry/client";

type Line = Extract<ResolvedEntity, { type: "line" }>;
type Extrude = Extract<Feature, { type: "extrude" }>;

const L = (id: string, x1: number, y1: number, x2: number, y2: number, construction?: boolean): Line =>
  ({ type: "line", id, x1, y1, x2, y2, ...(construction ? { construction } : {}) });
/** the user's lines: the origin axes are lines too */
const lines = (ents: ResolvedEntity[]) => ents.filter((e): e is Line => e.type === "line" && !e.id.startsWith("__"));
/** a 60 x 40 profile of four lines, well away from the origin, its bottom
 *  broken at x = 40 the way Break leaves it: two pieces end to end */
const BROKEN = (): ResolvedEntity[] => [
  L("b1", 10, 10, 40, 10), L("b2", 40, 10, 70, 10),
  L("r", 70, 10, 70, 50), L("t", 70, 50, 10, 50), L("l", 10, 50, 10, 10),
];
const HV = (): SketchConstraint[] => [
  { type: "horizontal", line: "b1" }, { type: "horizontal", line: "b2" },
  { type: "vertical", line: "r" }, { type: "horizontal", line: "t" }, { type: "vertical", line: "l" },
];

/** a live sketch, and a click of the Join tool */
function sketch(ents: ResolvedEntity[], cons: SketchConstraint[] = []) {
  const live = liveSketch(ents, cons);
  const s = live.s as unknown as { requestSolve(): void };
  const join = async (x: number, y: number) => {
    live.s.setTool("join");
    live.click(x, y);
    await live.settle();
  };
  return { ...live, join, resolve: async () => { s.requestSolve(); await live.settle(); } };
}

beforeEach(() => {
  toasts.length = 0;
});

describe("Join makes two pieces one line", () => {
  it("undoes a Break: one line end to end, its constraints kept, and one undo splits it again", async () => {
    const ents = [L("b", 10, 10, 70, 10), L("r", 70, 10, 70, 50)];
    const cons: SketchConstraint[] = [
      { type: "horizontal", line: "b" },
      { type: "fix", e: "b", p: 0 },
      { type: "coincident", e1: "b", p1: 1, e2: "r", p2: 0 },
      { type: "vertical", line: "r" },
    ];
    const live = sketch(ents, cons);
    live.s.setTool("break");
    live.click(40, 10);
    await live.settle();
    expect(lines(live.s.entities)).toHaveLength(3);
    const broken = JSON.stringify({ e: live.s.entities, c: live.s.constraints });

    await live.join(40, 10);
    const [m, r] = lines(live.s.entities);
    expect(lines(live.s.entities)).toHaveLength(2);
    expect([m!.x1, m!.y1, m!.x2, m!.y2]).toEqual([10, 10, 70, 10]);
    expect(m!.id).not.toBe("b");
    expect(r!.id).toBe("r");
    expect(live.s.constraints).toEqual([
      { type: "horizontal", line: m!.id },
      { type: "fix", e: m!.id, p: 0 },
      { type: "coincident", e1: m!.id, p1: 1, e2: "r", p2: 0 },
      { type: "vertical", line: "r" },
    ]);
    expect(toasts).toEqual([t("sketch.modify.breakJoined")]);

    expect(live.s.undoEdit()).toBe(true);
    expect(JSON.stringify({ e: live.s.entities, c: live.s.constraints })).toBe(broken);
  });

  it("the outer ends' constraints hold the new line: the join at its far end pulls it along", async () => {
    // a drag is a false oracle for a constraint (the drag carries what sits
    // on an end anyway): move the other line's end in the model and solve
    const live = sketch([...BROKEN()], [...HV(), { type: "coincident", e1: "b2", p1: 1, e2: "r", p2: 0 }]);
    await live.join(30, 10);
    const m = lines(live.s.entities).find((l) => l.x1 === 10 && l.y1 === 10)!;
    expect(live.s.constraints).toContainEqual({ type: "coincident", e1: m.id, p1: 1, e2: "r", p2: 0 });
    live.s.entities = live.s.entities.map((e) => (e.id === "r" ? { ...e, x1: 75, y1: 5 } : e));
    await live.resolve();
    const m2 = live.s.entities.find((e) => e.id === m.id) as Line;
    const r2 = live.s.entities.find((e) => e.id === "r") as Line;
    expect(Math.hypot(m2.x2 - r2.x1, m2.y2 - r2.y1)).toBeLessThan(1e-6);
  });

  it("a curve standing on the joint stays on the line, and a click on it at the joint joins the two it stands on", async () => {
    const stem = L("s", 40, 10, 40, 40);
    const live = sketch([L("b1", 10, 10, 40, 10), L("b2", 40, 10, 70, 10), stem], [{ type: "vertical", line: "s" }]);
    await live.join(40, 10.2); // on the stem, at the joint
    const m = lines(live.s.entities).find((l) => l.id !== "s")!;
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([10, 10, 70, 10]);
    expect(live.s.constraints).toContainEqual({ type: "pointOn", e: "s", p: 0, curve: m.id });
    // nothing held it but the solver merging ends at one spot; the joint is
    // gone, so without this the stem's foot would be loose
    live.s.entities = live.s.entities.map((e) => (e.id === "s" ? { ...e, y1: 15, y2: 45 } : e));
    await live.resolve();
    const s2 = live.s.entities.find((e) => e.id === "s") as Line;
    const m2 = live.s.entities.find((e) => e.id === m.id) as Line;
    expect(Math.abs(s2.y1 - m2.y1)).toBeLessThan(1e-6);
  });

  it("drops what held the joint or one piece's length, says how many, and keeps one Horizontal", async () => {
    const pt: ResolvedEntity = { type: "point", id: "pt", x: 40, y: 10 };
    const live = sketch([L("b1", 10, 10, 40, 10), L("b2", 40, 10, 70, 10), L("x", 40, 30, 60, 30), pt], [
      { type: "horizontal", line: "b1" },
      { type: "horizontal", line: "b2" },
      { type: "coincident", e1: "b1", p1: 1, e2: "b2", p2: 0 }, // the pieces' own join: quietly gone
      { type: "coincident", e1: "pt", p1: 0, e2: "b1", p2: 1 }, // a point held on the joint: On the line now
      { type: "distance", line: "b1", value: 30 }, // one piece's length
      { type: "p2pDistance", e1: "b2", p1: 0, e2: "x", p2: 0, value: 20 }, // a dimension to the joint
    ]);
    await live.join(20, 10);
    const m = lines(live.s.entities).find((l) => l.y1 === 10)!;
    expect(live.s.constraints).toEqual([
      { type: "horizontal", line: m.id },
      { type: "pointOn", e: "pt", p: 0, curve: m.id },
    ]);
    expect(toasts).toEqual([t("sketch.modify.joinDropped", { count: 2 })]);
  });
});

describe("Join says why it left the lines alone", () => {
  const refused = async (ents: ResolvedEntity[], at: [number, number], why: string) => {
    const live = sketch(ents);
    const before = JSON.stringify(live.s.entities);
    await live.join(...at);
    expect(JSON.stringify(live.s.entities)).toBe(before);
    expect(toasts).toEqual([t(`sketch.modify.join.${why}`)]);
  };
  it("two lines that meet at a corner", () => refused([L("a", 10, 10, 40, 10), L("b", 40, 10, 40, 40)], [38, 10], "notInLine"));
  it("a line with nothing at its ends", () => refused([L("a", 10, 10, 40, 10)], [38, 10], "nothingJoined"));
  it("a line that runs back over the other", () => refused([L("a", 10, 10, 40, 10), L("b", 40, 10, 20, 10)], [38, 10], "overlap"));
  it("a construction line and a line", () => refused([L("a", 10, 10, 40, 10), L("b", 40, 10, 70, 10, true)], [38, 10], "construction"));
  it("an arc", () => refused([{ type: "arc", id: "a", x1: 10, y1: 10, x2: 30, y2: 10, mx: 20, my: 20 }], [20, 20], "noLine"));
});

// --- after the sketch was saved and opened again -----------------------------

const noBackend = (): GeometryBackend => ({
  async rebuild(): Promise<RebuildReply> {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus: () => () => {},
  connected: true,
}) as unknown as GeometryBackend;

describe("Join on a sketch saved with a Break in it", () => {
  // The sketch as Break saved it, opened again: two plain lines end to end.
  // An extrude builds the area, another starts from one outer end and runs up
  // to the other, the way Extrude's start and up-to points name them.
  const doc = (): CadDocument => JSON.parse(JSON.stringify({
    version: 5,
    parameters: {},
    features: [
      { id: "f1", type: "sketch", plane: "XY", entities: BROKEN(), constraints: HV() },
      { id: "e1", type: "extrude", sketch: "f1", distance: 5, operation: "new", regions: [[40, 30, 0]], regionEntities: [["b1", "b2", "l", "r", "t"]], regionHoleEntities: [[]] },
      { id: "f0", type: "sketch", plane: "XZ", entities: [{ type: "circle", id: "c0", x: 0, y: 0, radius: 5 }] },
      {
        id: "x1", type: "extrude", sketch: "f0", distance: 5, operation: "new",
        startFrom: { kind: "sketchPoint", sketch: "f1", entity: "b1", pointIndex: 0 },
        upToRef: { kind: "sketchPoint", sketch: "f1", entity: "b2", pointIndex: 1 },
      },
      // and one that starts from one piece and runs up to the other, as lines
      {
        id: "x2", type: "extrude", sketch: "f0", distance: 5, operation: "new",
        startFrom: { kind: "sketchLine", sketch: "f1", entity: "b1" },
        upToRef: { kind: "sketchLine", sketch: "f1", entity: "b2" },
      },
    ],
  })) as CadDocument;

  function reopened() {
    const store = new DocumentStore(noBackend(), doc());
    const f1 = store.document.features[0] as Extract<Feature, { type: "sketch" }>;
    const live = sketch(f1.entities as ResolvedEntity[], f1.constraints ?? []);
    Object.assign(live.s, {
      store,
      editingId: "f1",
      patternFlow: { flushPending() {}, hasPending: () => false, flushOnFinish() {} },
      cleanup() {},
    });
    const finish = () => {
      vi.useFakeTimers(); // the commit schedules a rebuild this test does not want
      try {
        (live.s as unknown as { finish(): void }).finish();
      } finally {
        vi.useRealTimers();
      }
    };
    const feature = <T extends Feature>(id: string) => store.document.features.find((f) => f.id === id) as T;
    return { ...live, store, finish, feature };
  }

  it("joins, and what is built on the two pieces is built on the one line after Finish", async () => {
    const live = reopened();
    await live.join(40, 10);
    live.finish();
    const f1 = live.feature<Extract<Feature, { type: "sketch" }>>("f1");
    const bottom = lines(f1.entities as ResolvedEntity[]).filter((l) => l.y1 === 10 && l.y2 === 10);
    expect(bottom).toHaveLength(1);
    const m = bottom[0]!;
    expect([m.x1, m.x2]).toEqual([10, 70]);
    expect(f1.constraints).toContainEqual({ type: "horizontal", line: m.id });
    expect(f1.constraints?.filter((c) => c.type === "horizontal" && c.line === m.id)).toHaveLength(1);

    // the area, by the names of the curves round it, as the build reads it first
    const e1 = live.feature<Extrude>("e1");
    const named = regionsByEntities(detectRegions("f1", f1.entities as ResolvedEntity[]), e1.regionEntities![0]!, e1.regionHoleEntities?.[0]);
    expect(named).toHaveLength(1);
    expect(pointInRegion(new THREE.Vector2(40, 30), named[0]!)).toBe(true);
    expect(e1.regionEntities![0]).toContain(m.id);

    // the outer ends, by the new line and its own end numbers
    const x1 = live.feature<Extrude>("x1");
    const at = (ref: Extrude["startFrom"]) => {
      if (ref?.kind !== "sketchPoint") return null;
      const e = (f1.entities as ResolvedEntity[]).find((x) => x.id === ref.entity);
      const q = e && dimRefPoints(e).find((r) => r.p === ref.pointIndex)?.pos;
      return q ? [q.x, q.y] : null;
    };
    expect(at(x1.startFrom)).toEqual([10, 10]);
    expect(at(x1.upToRef)).toEqual([70, 10]);
    // and the lines, by the one line both pieces are part of now: before, the
    // build said the line it runs up to "was deleted"
    const x2 = live.feature<Extrude>("x2");
    expect(x2.startFrom).toEqual({ kind: "sketchLine", sketch: "f1", entity: m.id });
    expect(x2.upToRef).toEqual({ kind: "sketchLine", sketch: "f1", entity: m.id });

    // one undo of the document takes all of it back
    live.store.undo();
    expect(live.feature<Extrude>("x1").upToRef).toEqual({ kind: "sketchPoint", sketch: "f1", entity: "b2", pointIndex: 1 });
    expect(live.feature<Extrude>("x2").upToRef).toEqual({ kind: "sketchLine", sketch: "f1", entity: "b2" });
    expect(live.feature<Extract<Feature, { type: "sketch" }>>("f1").entities).toEqual(BROKEN());
  });
});
