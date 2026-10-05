// Trim keeps the cut CONNECTED, and a tangency there tangent (Doug, 25).
//
// Doug's 25 was "Tangency point + trim to it". Trimming TO a tangency shipped
// first (trimTangent.test.ts). The rest is what other CAD packages do with the
// cut: the kept piece's new end is held on the curve it was cut against, so a
// belt or a keyhole stays closed when a dimension changes later, and a tangent
// constraint the trimmed curve had stays on the piece that still touches.
// Before this, the new end was free: the first change of a dimension opened
// the outline right at the cut.
//
// Driven where the user enters: Trim armed, a press on the curve, through the
// real onPointerDown and the real solve pump (liveSketch). A join is checked
// the way a drag cannot fake it (snapCoincidentGesture.test.ts): DISPLACE or
// RESIZE what the end was cut against in the model and solve, against a
// control without the joins.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts, marks } = vi.hoisted(() => ({ toasts: [] as string[], marks: [] as { x: number; y: number }[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("./overlay", async (importOriginal) => {
  const real = await importOriginal<typeof import("./overlay")>();
  // record the points the hover marks; draw nothing (no WebGL here)
  return {
    ...real,
    curveObjects: () => [],
    pointHighlight: (_plane: unknown, x: number, y: number) => { marks.push({ x, y }); return new THREE.Object3D(); },
  };
});

import { SketchMode } from "./sketchMode";
import { liveSketch } from "./liveSketch.testkit";
import { compileAndSolve } from "./sketchSolve";
import { tangencyPoints } from "./modify";
import { ORIGIN_X_ID, isOriginGeometry } from "./origin";
import { arcCenterRadius } from "./arc";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type Line = Extract<ResolvedEntity, { type: "line" }>;
type Arc = Extract<ResolvedEntity, { type: "arc" }>;
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });
const user = (es: ResolvedEntity[]) => es.filter((e) => !isOriginGeometry(e.id));
const byId = (es: ResolvedEntity[], id: string) => es.find((e) => e.id === id)!;
/** distance from q to the INFINITE line through l */
const offLine = (l: Line, q: { x: number; y: number }) =>
  Math.abs((l.x2 - l.x1) * (l.y1 - q.y) - (l.x1 - q.x) * (l.y2 - l.y1)) / Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
const ends = (a: Line | Arc) => [{ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }];

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log; // planegcs narrates every solve
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

/** Trim armed on `ents`, one press at (x, y), solved. */
async function trimmed(ents: ResolvedEntity[], cons: SketchConstraint[], x: number, y: number) {
  const live = liveSketch(ents, cons);
  live.s.tool = "trim";
  live.click(x, y);
  await quietly(live.settle);
  return live;
}

/** the user geometry with `id` moved by (dx, dy) */
function shifted(es: ResolvedEntity[], id: string, dx: number, dy: number): ResolvedEntity[] {
  return es.map((e) => {
    if (e.id !== id) return e;
    if (e.type === "line") return { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy };
    if (e.type === "rectangle" || e.type === "circle") return { ...e, x: e.x + dx, y: e.y + dy };
    throw new Error(`shifted: ${e.type}`);
  });
}

beforeEach(() => { toasts.length = 0; marks.length = 0; });

describe("Trim joins the end it cut to the curve it cut against", () => {
  it("holds a line's cut end ON the line that crossed it", async () => {
    const live = await trimmed([line("H", 0, 0, 40, 0), line("X", 30, -5, 30, 5)], [], 35, 0);
    const piece = user(live.s.entities).find((e) => e.id !== "X") as Line;
    expect([piece.x1, piece.x2]).toEqual([0, 30]);
    expect(live.s.constraints).toEqual([{ type: "pointOn", e: piece.id, p: 1, curve: "X" }]);
    expect(toasts).toEqual([]);

    // the effect: X moves 5 mm left (pinned there) and the cut end goes with it
    const moved = shifted(live.s.entities, "X", -5, 0);
    const pin: SketchConstraint[] = [{ type: "fix", e: "X", p: 0 }, { type: "fix", e: "X", p: 1 }];
    const r = await quietly(() => compileAndSolve(moved, [...live.s.constraints, ...pin]));
    const control = await quietly(() => compileAndSolve(moved, pin));
    expect(r.conflicts).toEqual([]);
    expect((byId(r.entities, piece.id) as Line).x2).toBeCloseTo(25, 9);
    expect((byId(control.entities, piece.id) as Line).x2, "the control moved too: the oracle is blind").toBeCloseTo(30, 9);
  });

  it("joins it with a Coincident where the other curve ENDS at the cut", async () => {
    // V stands on H at x=30: the cut is V's own start
    const live = await trimmed([line("H", 0, 0, 40, 0), line("V", 30, 0, 30, 10)], [], 35, 0);
    const piece = user(live.s.entities).find((e) => e.id !== "V") as Line;
    expect(live.s.constraints).toEqual([{ type: "coincident", e1: piece.id, p1: 1, e2: "V", p2: 0 }]);

    // displaced in the MODEL, so only a real constraint can close the gap:
    // the solver's merge-by-position would not
    const moved = shifted(live.s.entities, "V", -5, 3);
    const pin: SketchConstraint[] = [{ type: "fix", e: "V", p: 0 }, { type: "fix", e: "V", p: 1 }];
    const r = await quietly(() => compileAndSolve(moved, [...live.s.constraints, ...pin]));
    const control = await quietly(() => compileAndSolve(moved, pin));
    const endOf = (es: ResolvedEntity[]) => ends(byId(es, piece.id) as Line)[1]!;
    expect(endOf(r.entities).x).toBeCloseTo(25, 9);
    expect(endOf(r.entities).y).toBeCloseTo(3, 9);
    expect(endOf(control.entities).x).toBeCloseTo(30, 9);
  });

  it("holds both ends of a circle cut to an arc on the line that cut it", async () => {
    const live = await trimmed([{ type: "circle", id: "c", x: 0, y: 0, radius: 10 }, line("L", -20, 3, 20, 3)], [], 0, 10);
    const arc = user(live.s.entities).find((e) => e.type === "arc") as Arc;
    expect(live.s.constraints).toEqual([
      { type: "pointOn", e: arc.id, p: 0, curve: "L" },
      { type: "pointOn", e: arc.id, p: 1, curve: "L" },
    ]);
    // the line drops 2 mm and the arc's ends follow it down its circle
    const moved = shifted(live.s.entities, "L", 0, -2);
    const pin: SketchConstraint[] = [{ type: "fix", e: "L", p: 0 }, { type: "fix", e: "L", p: 1 }];
    const r = await quietly(() => compileAndSolve(moved, [...live.s.constraints, ...pin]));
    for (const q of ends(byId(r.entities, arc.id) as Arc)) expect(q.y).toBeCloseTo(1, 9);
  });

  it("puts the end on the rectangle SIDE it was cut against, and it stays on it", async () => {
    // the rectangle's left side is x=25 and its right side x=35 (sides 3 and 1)
    const rect: ResolvedEntity = { type: "rectangle", id: "R", x: 30, y: 0, width: 10, height: 20 };
    const live = await trimmed([line("H", 0, 1, 40, 1), rect], [], 30, 1);
    const [left, right] = (user(live.s.entities).filter((e) => e.type === "line") as Line[]).sort((a, b) => a.x1 - b.x1);
    expect(live.s.constraints).toEqual([
      { type: "pointOn", e: left!.id, p: 1, curve: "R~3" },
      { type: "pointOn", e: right!.id, p: 0, curve: "R~1" },
    ]);
    const moved = shifted(live.s.entities, "R", -3, 0);
    const pin: SketchConstraint[] = [{ type: "fix", e: "R", p: 0 }, { type: "fix", e: "R", p: 2 }];
    const r = await quietly(() => compileAndSolve(moved, [...live.s.constraints, ...pin]));
    expect((byId(r.entities, left!.id) as Line).x2).toBeCloseTo(22, 9);
    expect((byId(r.entities, right!.id) as Line).x1).toBeCloseTo(32, 9);
  });

  it("leaves an end cut against a spline free, as it always was", async () => {
    const spline: ResolvedEntity = { type: "spline", id: "S", points: [{ x: 30, y: -5 }, { x: 31, y: 0 }, { x: 30, y: 5 }] };
    const live = await trimmed([line("H", 0, 0.5, 40, 0.5), spline], [], 38, 0.5);
    expect(user(live.s.entities).filter((e) => e.type === "line")).toHaveLength(1); // it did trim
    expect(live.s.constraints).toEqual([]);
  });

  it("is one undo step with the trim", async () => {
    const ents = [line("H", 0, 0, 40, 0), line("X", 30, -5, 30, 5)];
    const cons: SketchConstraint[] = [{ type: "horizontal", line: "H" }];
    const live = await trimmed(ents, cons, 35, 0);
    expect(live.s.constraints.some((c) => c.type === "pointOn")).toBe(true);
    live.s.undoEdit();
    await quietly(live.settle);
    expect(user(live.s.entities)).toEqual(ents);
    expect(live.s.constraints).toEqual(cons);
  });
});

describe("Trim in a sketch that is red already", () => {
  it("keeps the joins the solve does not blame, and does not blame them", async () => {
    // Q's two lengths disagree, so the sketch is red before anything is
    // trimmed; H and X have nothing to do with it
    const ents = [line("Q", 0, 20, 10, 20), line("H", 0, 0, 40, 0), line("X", 30, -5, 30, 5)];
    const cons: SketchConstraint[] = [{ type: "distance", line: "Q", value: 10 }, { type: "distance", line: "Q", value: 12 }];
    const live = liveSketch(ents, cons);
    live.s.requestSolve();
    await quietly(live.settle);
    expect((live.s as unknown as { conflict: boolean }).conflict, "the sketch must be red first").toBe(true);

    live.s.tool = "trim";
    live.click(35, 0);
    await quietly(live.settle);
    const piece = user(live.s.entities).find((e) => e.type === "line" && e.id !== "Q" && e.id !== "X") as Line;
    expect([piece.x1, piece.x2]).toEqual([0, 30]);
    expect(live.s.constraints).toEqual([...cons, { type: "pointOn", e: piece.id, p: 1, curve: "X" }]);
    expect(toasts).toEqual([]);
  });
});

describe("a tangency at the cut stays, and the cut stays on it", () => {
  // two pulleys and a belt, tangencies solved by planegcs so the touches carry
  // the solver's own noise, not a hand-made exact one
  async function belt() {
    const drawn: ResolvedEntity[] = [
      { id: "cA", type: "circle", x: 0, y: 0, radius: 10 },
      { id: "cB", type: "circle", x: 40, y: 0, radius: 6 },
      line("l1", -5, 10.3, 46, 6.2),
      line("l2", -5, -10.3, 46, -6.2),
    ];
    const cons: SketchConstraint[] = [
      { type: "tangent2", a: "l1", b: "cA" }, { type: "tangent2", a: "l1", b: "cB" },
      { type: "tangent2", a: "l2", b: "cA" }, { type: "tangent2", a: "l2", b: "cB" },
    ];
    const r = await quietly(() => compileAndSolve(drawn, cons));
    expect(r.ok && r.conflicts.length === 0, "the belt must solve before it can be trimmed").toBe(true);
    return { ents: r.entities, cons };
  }

  it("keeps a belt on its pulleys when a pulley grows: both ends of each arc stay on the belt, tangent, and nothing is amber", async () => {
    const { ents, cons } = await belt();
    const live = liveSketch(ents, cons);
    live.s.tool = "trim";
    // each pulley's span facing the other one, clicked on its rim as solved
    const rim = (id: string, side: number) => {
      const c = byId(live.s.entities, id) as Extract<ResolvedEntity, { type: "circle" }>;
      live.click(c.x + side * c.radius, c.y);
    };
    rim("cA", 1);
    await quietly(live.settle);
    rim("cB", -1);
    await quietly(live.settle);
    const arcs = user(live.s.entities).filter((e): e is Arc => e.type === "arc");
    expect(arcs).toHaveLength(2);
    const arcA = arcs.find((a) => arcCenterRadius(a)!.c.x < 20)!;
    // every one of the four ends is held on the belt line it was cut at
    const joins = live.s.constraints.filter((c) => c.type === "pointOn");
    expect(joins).toHaveLength(4);
    expect(live.s.constraints.filter((c) => c.type === "tangent2")).toHaveLength(4);
    expect([...live.s.overIdx], "a tangency at the cut was painted amber").toEqual([]);

    // grow pulley A, as a later dimension change would
    live.s.constraints.push({ type: "radius", e: arcA.id, value: 13 });
    live.s.requestSolve();
    await quietly(live.settle);
    expect([...live.s.overIdx]).toEqual([]);
    expect(toasts).toEqual([]);
    const lines = ["l1", "l2"].map((id) => byId(live.s.entities, id) as Line);
    for (const a of arcs.map((x) => byId(live.s.entities, x.id) as Arc)) {
      const { c, r } = arcCenterRadius(a)!;
      for (const q of ends(a)) {
        const on = Math.min(...lines.map((l) => offLine(l, q)));
        expect(on, `an end of the arc at x=${c.x.toFixed(1)} came off the belt`).toBeLessThan(1e-6);
      }
      for (const l of lines) expect(Math.abs(offLine(l, c) - r), "the belt is no longer tangent").toBeLessThan(1e-6);
    }
    expect(arcCenterRadius(byId(live.s.entities, arcA.id) as Arc)!.r).toBeCloseTo(13, 6);
  });

  // `tangent` is the older form of the same constraint, still in old files
  const forms: [string, SketchConstraint, (piece: string) => SketchConstraint][] = [
    ["Tangent", { type: "tangent2", a: "t", b: "c" }, (piece) => ({ type: "tangent2", a: piece, b: "c" })],
    ["an old file's Tangent", { type: "tangent", line: "t", circle: "c" }, (piece) => ({ type: "tangent", line: piece, circle: "c" })],
  ];
  it.each(forms)("keeps a line trimmed at its touch on a circle tangent there when the circle moves (%s)", async (_, tangent, kept) => {
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", x: 0, y: 0, radius: 10 }, line("t", -20, 10, 20, 10)];
    const cons: SketchConstraint[] = [tangent];
    const live = await trimmed(ents, cons, -10, 10); // the half left of the touch
    const piece = user(live.s.entities).find((e) => e.type === "line") as Line;
    expect([piece.x1, piece.y1, piece.x2, piece.y2]).toEqual([0, 10, 20, 10]);
    expect(live.s.constraints).toEqual([kept(piece.id), { type: "pointOn", e: piece.id, p: 0, curve: "c" }]);
    expect([...live.s.overIdx], "the tangency at the cut was painted amber").toEqual([]);

    // the circle moves 5 mm right, pinned there: the line must stay tangent
    // AND start on the circle, which only the join can make it do
    const moved = shifted(live.s.entities, "c", 5, 0);
    const pin: SketchConstraint[] = [{ type: "fix", e: "c", p: 0 }, { type: "radius", e: "c", value: 10 }];
    const r = await quietly(() => compileAndSolve(moved, [...live.s.constraints, ...pin]));
    const control = await quietly(() => compileAndSolve(moved, [...live.s.constraints.filter((c) => c.type !== "pointOn"), ...pin]));
    expect(r.conflicts).toEqual([]);
    expect(r.overDefined).toEqual([]);
    const startOff = (es: ResolvedEntity[]) => {
      const l = byId(es, piece.id) as Line;
      return Math.abs(Math.hypot(l.x1 - 5, l.y1) - 10);
    };
    const l = byId(r.entities, piece.id) as Line;
    expect(startOff(r.entities), "the line's cut end left the circle").toBeLessThan(1e-6);
    expect(Math.abs(offLine(l, { x: 5, y: 0 }) - 10), "the line is no longer tangent").toBeLessThan(1e-6);
    expect(startOff(control.entities), "the control kept the end on too: the oracle is blind").toBeGreaterThan(0.1);
  });
});

describe("the tangency point shows while trimming, and snaps", () => {
  const touching = (): { ents: ResolvedEntity[]; cons: SketchConstraint[] } => ({
    ents: [{ type: "circle", id: "c", x: 0, y: 0, radius: 10 }, line("t", -20, 10, 20, 10)],
    cons: [{ type: "tangent2", a: "t", b: "c" }],
  });

  it("is where the two curves a Tangent names touch, and only where both reach", () => {
    const { ents, cons } = touching();
    expect(tangencyPoints(ents, cons).map((q) => [q.x, q.y])).toEqual([[0, 10]]);
    // on the line's EXTENSION: no trim stops there, so no point
    expect(tangencyPoints([ents[0]!, line("t", 5, 10, 20, 10)], cons)).toEqual([]);
    // not touching yet (the solve has not run): nothing to show
    expect(tangencyPoints([ents[0]!, line("t", -20, 12, 20, 12)], cons)).toEqual([]);
    // no Tangent, no point: a crossing shows itself
    expect(tangencyPoints(ents, [])).toEqual([]);
  });

  it("is drawn while Trim is armed, wherever the cursor is", () => {
    const { ents, cons } = touching();
    const live = liveSketch(ents, cons);
    Object.assign(live.s, { endpointDotRadius: () => 0.2 });
    live.s.tool = "trim";
    live.move(-15, -15); // nowhere near either curve
    expect(marks).toEqual([{ x: 0, y: 10 }]);
    marks.length = 0;
    live.s.tool = "fillet";
    live.move(-15, -16);
    expect(marks).toEqual([]);
  });

  /** The drawing tools' snap, through the real refreshActive and snapAt,
   *  with what draws stubbed and a camera that is the identity: 1 px = 1 mm. */
  function snapper(ents: ResolvedEntity[], cons: SketchConstraint[]) {
    const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
    Object.assign(s, {
      entities: ents, constraints: cons, patterns: [], dimPicks: [], dimsVisible: false, entityVersion: 0, gridSnap: false,
      plane: { plane: {}, origin: new THREE.Vector3(), to2D: (w: THREE.Vector3) => new THREE.Vector2(w.x, w.y), to3D: (x: number, y: number) => new THREE.Vector3(x, y, 0) },
      viewport: {
        pixelWorldSize: () => 1, requestRender() {},
        screenToPlane: (x: number, y: number) => new THREE.Vector3(x, y, 0),
        projectToScreen: (w: THREE.Vector3) => ({ x: w.x, y: w.y }),
      },
      overlay: { setActiveSketch() {}, setActiveRegions() {} },
      dims: { hide() {} },
      derivedEntities: () => [],
      activeCurves: () => [],
      redrawGlyphs() {},
      sayTextFailures() {},
    });
    const priv = s as unknown as {
      refreshActive(): void;
      snapAt(x: number, y: number): { p: THREE.Vector2; kind: string; ref?: { id: string; idx: number } } | null;
    };
    priv.refreshActive();
    return (x: number, y: number) => priv.snapAt(x, y);
  }

  it("is a snap target for the drawing tools", () => {
    // the line's midpoint (5, 10) is a snap target too, beside the touch
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", x: 0, y: 0, radius: 10 }, line("t", -20, 10, 30, 10)];
    const cons: SketchConstraint[] = [{ type: "tangent2", a: "t", b: "c" }];
    const hit = snapper(ents, cons)(2, 11); // 2.2 px from the touch, 3.2 from the midpoint
    expect(hit?.kind).toBe("tangent");
    expect([hit!.p.x, hit!.p.y]).toEqual([0, 10]);
  });

  it("does not take a small circle's centre snap away, nor the join it gives", () => {
    // a 1.5 mm hole held tangent to a line: its touch is 1.5 px from its
    // centre, well inside the snap radius. Aimed at the centre, the centre
    // wins, with the solver point a line drawn from it is joined to.
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", x: 10, y: 1.5, radius: 1.5 }, line("t", 0, 0, 30, 0)];
    const cons: SketchConstraint[] = [{ type: "tangent2", a: "t", b: "c" }];
    expect(tangencyPoints(ents, cons).map((q) => [q.x, q.y]), "no touch: the test proves nothing").toEqual([[10, 0]]);
    const hit = snapper(ents, cons)(10, 1.5);
    expect(hit?.kind).toBe("center");
    expect([hit!.p.x, hit!.p.y]).toEqual([10, 1.5]);
    expect(hit?.ref).toEqual({ id: "c", idx: 0 });
  });

  it("shows no point where a curve touches an origin axis: a trim does not stop there", async () => {
    const circle: ResolvedEntity = { type: "circle", id: "c", x: 5, y: 10, radius: 10 };
    const onAxis: SketchConstraint[] = [{ type: "tangent2", a: "c", b: ORIGIN_X_ID }];
    const live = liveSketch([circle, line("L", -20, 15, 30, 15)], onAxis);
    Object.assign(live.s, { endpointDotRadius: () => 0.2 });
    live.s.tool = "trim";
    live.move(-15, -15);
    expect(marks).toEqual([]);
    // what it would have promised: a trim through the touch at (5, 0) runs on
    // to the crossings with L, the whole lower span goes
    live.click(5, 0);
    await quietly(live.settle);
    const arc = user(live.s.entities).find((e) => e.type === "arc") as Arc;
    expect(arc.my).toBeCloseTo(20, 9);
    // control: the same touch on a line of the user's own is a stop, and shows
    const own = liveSketch([circle, line("B", -20, 0, 30, 0)], [{ type: "tangent2", a: "c", b: "B" }]);
    Object.assign(own.s, { endpointDotRadius: () => 0.2 });
    own.s.tool = "trim";
    own.move(-15, -15);
    expect(marks).toEqual([{ x: 5, y: 0 }]);
  });
});
