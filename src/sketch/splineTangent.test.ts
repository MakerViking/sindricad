// A spline's END made tangent to the curve it meets (TA 848b5ed1; Paul,
// e8c170ea: "If end of a line and end of a spline are coincident, would be
// nice add a tangency constraint between them").
//
// The drawn spline (spline.ts) leaves an end heading for its neighbouring fit
// point, so the tangency is held on the line from the end to that point. These
// run the real Tangent click flow, the real right-click menu and the real
// planegcs solve, and read back where the geometry went.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import * as THREE from "three";
import { compileAndSolve } from "./sketchSolve";
import { ConstraintTools, splineTangentFor, type ConstraintHost } from "./constraintTools";
import { constraintGlyphs } from "./glyphs";
import { applicableConstraints } from "./constraintMenu";
import { liveSketch, PX } from "./liveSketch.testkit";
import { contextMenu, type CtxItem } from "../ui/menu";
import { toast } from "../ui/toast";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { SketchTool } from "./sketchMode";

type Spline = Extract<ResolvedEntity, { type: "spline" }>;
const L = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });
const SP = (id: string, pts: [number, number][], flags: { asDrawn?: true; closed?: true } = { asDrawn: true }): ResolvedEntity =>
  ({ type: "spline", id, points: pts.map(([x, y]) => ({ x, y })), ...flags });
const v = (x: number, y: number) => new THREE.Vector2(x, y);
const spline = (ents: ResolvedEntity[], id: string) => {
  const e = ents.find((x) => x.id === id);
  if (e?.type !== "spline") throw new Error(`no spline ${id}`);
  return e as Spline;
};
/** the unit direction a spline LEAVES its end by: from the end to its neighbour */
const leaving = (s: Spline, end: 0 | 1) => {
  const n = s.points.length;
  const [a, b] = end === 0 ? [s.points[0]!, s.points[1]!] : [s.points[n - 1]!, s.points[n - 2]!];
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
};
const tan = (c: Omit<Extract<SketchConstraint, { type: "splineTangent" }>, "type">): SketchConstraint =>
  ({ type: "splineTangent", ...c });

class Host implements ConstraintHost {
  _tool: SketchTool = "tangent";
  _ents: ResolvedEntity[] = [];
  _cons: SketchConstraint[] = [];
  _fillet: number | null = null;
  warnings: string[] = [];
  moves: (string | undefined)[] = [];
  tool() { return this._tool; }
  entities() { return this._ents; }
  constraints() { return this._cons; }
  pickTol() { return 1; }
  getFilletFirst() { return this._fillet; }
  setFilletFirst(i: number | null) { this._fillet = i; }
  requestSolve() {}
  warn(m: string) { this.warnings.push(m); }
  setPendingPoints() {}
  addConstraint(c: SketchConstraint, moves?: string, holds: readonly SketchConstraint[] = []) {
    this._cons.push(...holds, c);
    this.moves.push(moves);
  }
}

/** A live sketch whose Tangent tool is wired as SketchMode wires it: the
 *  real two-pick slot (the testkit's never arms) and the real push
 *  (addTrialConstraint), so a pair of clicks solves with the real mover bias
 *  and a conflict would withdraw what they added. */
function tangentSketch(ents: ResolvedEntity[], cons: SketchConstraint[] = []) {
  const live = liveSketch(ents, cons);
  const s = live.s as unknown as {
    filletFirst: number | null;
    constraintTools: ConstraintTools;
    addTrialConstraint(c: SketchConstraint, moves?: string, holds?: readonly SketchConstraint[]): void;
  };
  s.filletFirst = null;
  s.constraintTools = new ConstraintTools({
    tool: () => live.s.tool,
    entities: () => live.s.entities,
    constraints: () => live.s.constraints,
    pickTol: () => 0.5,
    getFilletFirst: () => s.filletFirst,
    setFilletFirst: (i) => { s.filletFirst = i; },
    requestSolve: () => live.s.requestSolve(),
    warn: (m) => { throw new Error(`refused: ${m}`); },
    setPendingPoints() {},
    addConstraint: (c, moves, holds) => s.addTrialConstraint(c, moves, holds),
  });
  live.s.tool = "tangent";
  return live;
}
const near = (p: { x: number; y: number }, x: number, y: number) => Math.hypot(p.x - x, p.y - y);

// A line along +x from the origin to (40, 0), and a spline that starts where
// the line ends and wanders off upward: the joint is the line's END.
const lineIntoJoint = () => [L("l", 0, 0, 40, 0), SP("s", [[40, 0], [50, 12], [70, 10], [80, 25]])];

describe("the Tangent tool takes a spline at its end", () => {
  it("spline then line: a splineTangent at the joint end, and the spline moves", () => {
    const h = new Host();
    h._ents = lineIntoJoint();
    const ct = new ConstraintTools(h);
    ct.click(v(60, 11)); // the spline, away from both its ends
    ct.click(v(20, 0)); // the line
    expect(h.warnings).toEqual([]);
    expect(h._cons).toEqual([tan({ spline: "s", end: 0, other: "l" })]);
    expect(h.moves).toEqual(["s"]);
  });

  it("line then spline: the same constraint, and the line is what moves", () => {
    const h = new Host();
    h._ents = lineIntoJoint();
    const ct = new ConstraintTools(h);
    ct.click(v(20, 0));
    ct.click(v(60, 11));
    expect(h._cons).toEqual([tan({ spline: "s", end: 0, other: "l" })]);
    expect(h.moves).toEqual(["l"]);
  });

  it("names the spline's LAST end when that is the one on the curve", () => {
    const h = new Host();
    h._ents = [L("l", 0, 0, 40, 0), SP("s", [[80, 25], [70, 10], [50, 12], [40, 0]])];
    const ct = new ConstraintTools(h);
    ct.click(v(60, 11));
    ct.click(v(20, 0));
    expect(h._cons).toEqual([tan({ spline: "s", end: 1, other: "l" })]);
  });

  it("two splines meeting end to end: both ends are named", () => {
    const h = new Host();
    h._ents = [SP("a", [[0, 0], [10, 5], [20, 0]]), SP("b", [[40, 3], [30, -6], [20, 0]])];
    const ct = new ConstraintTools(h);
    ct.click(v(10, 5));
    ct.click(v(30, -6));
    expect(h._cons).toEqual([tan({ spline: "a", end: 1, other: "b", otherEnd: 1 })]);
  });

  it("a spline whose end is not ON the other curve is refused, and says why", () => {
    const h = new Host();
    h._ents = [L("l", 0, 0, 40, 0), SP("s", [[42, 1], [50, 12], [70, 10]])];
    const ct = new ConstraintTools(h);
    ct.click(v(60, 11));
    ct.click(v(20, 0));
    expect(h._cons).toEqual([]);
    expect(h.warnings).toEqual([t("sketch.constraint.splineTangentNoJoint")]);
  });

  it("an older spline is refused: its model is a different curve from the drawn one", () => {
    const h = new Host();
    h._ents = [L("l", 0, 0, 40, 0), SP("s", [[40, 0], [50, 12], [70, 10]], {})];
    const ct = new ConstraintTools(h);
    ct.click(v(60, 11));
    ct.click(v(20, 0));
    expect(h._cons).toEqual([]);
    expect(h.warnings).toEqual([t("sketch.constraint.splineTangentOld")]);
  });

  it("a closed spline has no end to make tangent", () => {
    const h = new Host();
    h._ents = [L("l", 0, 0, 40, 0), SP("s", [[40, 0], [50, 12], [70, 10]], { asDrawn: true, closed: true })];
    const ct = new ConstraintTools(h);
    ct.click(v(50, 12));
    ct.click(v(20, 0));
    expect(h._cons).toEqual([]);
    expect(h.warnings).toEqual([t("sketch.constraint.splineTangentClosed")]);
  });

  it("other tools still do not take a spline (they have no meaning for one)", () => {
    for (const tool of ["equal", "parallel", "coincident"] as SketchTool[]) {
      const h = new Host();
      h._tool = tool;
      h._ents = lineIntoJoint();
      const ct = new ConstraintTools(h);
      ct.click(v(60, 11));
      ct.click(v(20, 0));
      expect(h._cons.filter((c) => c.type === "splineTangent"), tool).toEqual([]);
    }
  });
});

describe("what the solver makes of it", () => {
  const angle = (u: { x: number; y: number }, w: { x: number; y: number }) =>
    Math.atan2(u.x * w.y - u.y * w.x, u.x * w.x + u.y * w.y);

  it("a line running INTO the joint: the spline carries on along it, one freedom gone", async () => {
    const ents = lineIntoJoint();
    const free = await compileAndSolve(ents, []);
    const r = await compileAndSolve(ents, [tan({ spline: "s", end: 0, other: "l" })], undefined, { moves: ["s"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.dof).toBe(free.dof - 1);
    const s = spline(r.entities, "s");
    const d = leaving(s, 0);
    expect(Math.abs(angle({ x: 1, y: 0 }, d)), "leaves along +x, the way the line runs").toBeLessThan(1e-7);
    // the joint and the line stay (to float noise: the joint is held by the
    // bias's temporary pin, not frozen)
    expect(s.points[0]!.x).toBeCloseTo(40, 9);
    expect(s.points[0]!.y).toBeCloseTo(0, 9);
    const l = r.entities.find((e) => e.id === "l") as Extract<ResolvedEntity, { type: "line" }>;
    for (const [k, want] of [["x1", 0], ["y1", 0], ["x2", 40], ["y2", 0]] as const) {
      expect(l[k], `the line was not the mover: ${k}`).toBeCloseTo(want, 9);
    }
  });

  it("a line running OUT of the joint: the spline leaves the other way, not back over it", async () => {
    // the line now starts at the joint and runs to the right; the spline starts
    // there heading up and slightly right, so a plain parallel would fold it
    // back along the line (+x). Smooth is -x.
    const ents = [L("l", 40, 0, 80, 0), SP("s", [[40, 0], [45, 12], [30, 20]])];
    const r = await compileAndSolve(ents, [tan({ spline: "s", end: 0, other: "l" })], undefined, { moves: ["s"] });
    expect(r.conflicts).toEqual([]);
    const d = leaving(spline(r.entities, "s"), 0);
    expect(Math.abs(angle({ x: -1, y: 0 }, d))).toBeLessThan(1e-7);
  });

  it("a spline drawn folding back over the line still comes out smooth, not a cusp", async () => {
    // leaves the joint 120 degrees off the line's direction: nearer the cusp
    // (180) than smooth (0), so only the joint's side, not the current angle,
    // can say which tangency is meant
    const ents = [L("l", 0, 0, 40, 0), SP("s", [[40, 0], [35, 8.66], [20, 20]])];
    const r = await compileAndSolve(ents, [tan({ spline: "s", end: 0, other: "l" })], undefined, { moves: ["s"] });
    expect(r.conflicts).toEqual([]);
    const s = spline(r.entities, "s");
    const d = leaving(s, 0);
    expect(Math.abs(angle({ x: 1, y: 0 }, d)), `left the joint at ${JSON.stringify(d)}`).toBeLessThan(1e-7);
  });

  it("two splines: the joint is smooth, each leaving it the opposite way", async () => {
    const ents = [SP("a", [[0, 0], [10, 5], [20, 0]]), SP("b", [[20, 0], [30, -6], [40, 3]])];
    const r = await compileAndSolve(ents, [tan({ spline: "a", end: 1, other: "b", otherEnd: 0 })], undefined, { moves: ["a"] });
    expect(r.conflicts).toEqual([]);
    const da = leaving(spline(r.entities, "a"), 1), db = leaving(spline(r.entities, "b"), 0);
    expect(Math.abs(Math.abs(angle(da, db)) - Math.PI)).toBeLessThan(1e-7);
  });

  it("an arc: square to its radius at the joint, carrying on the way the arc sweeps", async () => {
    // a quarter arc about the origin from (20,0) CCW to (0,20); the spline
    // starts at the arc's CCW END, so it must head on in -x
    const s45 = Math.SQRT1_2 * 20;
    const ents: ResolvedEntity[] = [
      { type: "arc", id: "A", x1: 20, y1: 0, x2: 0, y2: 20, mx: s45, my: s45 },
      SP("s", [[0, 20], [-6, 30], [-20, 34]]),
    ];
    const r = await compileAndSolve(ents, [tan({ spline: "s", end: 0, other: "A" })], undefined, { moves: ["s"] });
    expect(r.conflicts).toEqual([]);
    const d = leaving(spline(r.entities, "s"), 0);
    expect(Math.abs(angle({ x: -1, y: 0 }, d))).toBeLessThan(1e-7);
  });

  it("joined only by a Coincident, it solves the joint and the tangency together", async () => {
    // the spline starts 2 mm off the line's end; the coincident brings it on
    const ents = [L("l", 0, 0, 40, 0), SP("s", [[41, 2], [50, 12], [70, 10]])];
    const cons: SketchConstraint[] = [
      { type: "fix", e: "l", p: 0 }, { type: "fix", e: "l", p: 1 },
      { type: "coincident", e1: "s", p1: 0, e2: "l", p2: 1 },
      tan({ spline: "s", end: 0, other: "l" }),
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.conflicts).toEqual([]);
    const s = spline(r.entities, "s");
    expect(Math.hypot(s.points[0]!.x - 40, s.points[0]!.y)).toBeLessThan(1e-7);
    expect(Math.abs(angle({ x: 1, y: 0 }, leaving(s, 0)))).toBeLessThan(1e-7);
  });
});

// The tangency holds a direction only. An end that sits partway along the
// other curve (a T-joint), or one the solver does not merge with the curve's
// own end, is kept there by the On (or Coincident) the tool adds with it;
// without it the first solve swung the end off the curve, still pointing the
// right way. And the joint is what turns about, whichever was picked first.
// These click the real Tangent tool and solve for real, away from the origin's
// axes (the live sketch has them).
describe("the joint stays where it is", () => {
  const radial = (c: { x: number; y: number }, p: { x: number; y: number }) => {
    const l = Math.hypot(p.x - c.x, p.y - c.y);
    return { x: (p.x - c.x) / l, y: (p.y - c.y) / l };
  };
  const dot = (u: { x: number; y: number }, w: { x: number; y: number }) => u.x * w.x + u.y * w.y;
  const line = (ents: ResolvedEntity[], id: string) => ents.find((e) => e.id === id) as Extract<ResolvedEntity, { type: "line" }>;
  /** `got` is `want` to float noise (the solve holds what it does not move
   *  with soft pins, not by freezing it) */
  const unmoved = (got: ResolvedEntity | undefined, want: ResolvedEntity) => {
    for (const [k, v] of Object.entries(want)) {
      const g = (got as Record<string, unknown> | undefined)?.[k];
      if (typeof v === "number") expect(Math.abs((g as number) - v), `${want.id}.${k} moved to ${g}`).toBeLessThan(1e-6);
      else expect(g).toEqual(v);
    }
  };

  it("a spline started on a circle stays on it, where it was, square to the radius", async () => {
    const C: ResolvedEntity = { type: "circle", id: "C", x: 60, y: 50, radius: 20 };
    const live = tangentSketch([C, SP("s", [[80, 50], [88, 62], [100, 64]])]);
    live.click(88, 62);
    live.click(60, 70);
    await live.settle();
    expect(live.s.constraints).toEqual([
      { type: "pointOn", e: "s", p: 0, curve: "C" },
      tan({ spline: "s", end: 0, other: "C" }),
    ]);
    const sp = spline(live.s.entities, "s");
    expect(near(sp.points[0]!, 80, 50), `the end went to ${JSON.stringify(sp.points[0])}`).toBeLessThan(1e-6);
    expect(Math.abs(dot(leaving(sp, 0), radial({ x: 60, y: 50 }, sp.points[0]!)))).toBeLessThan(1e-7);
    unmoved(live.ent("C"), C);
  });

  it("the On is what keeps that end on the circle when the circle is moved afterwards", async () => {
    const C: ResolvedEntity = { type: "circle", id: "C", x: 60, y: 50, radius: 20 };
    const live = tangentSketch([C, SP("s", [[80, 50], [88, 62], [100, 64]])]);
    live.click(88, 62);
    live.click(60, 70);
    await live.settle();
    // drag the circle by its rim, as a whole, 10 mm right and 5 down
    live.s.tool = "select";
    await live.drag([60, 70], [70, 65]);
    const c = live.ent("C") as Extract<ResolvedEntity, { type: "circle" }>;
    expect(c.x, "the drag moved the circle").toBeGreaterThan(65);
    const sp = spline(live.s.entities, "s");
    const off = Math.abs(Math.hypot(sp.points[0]!.x - c.x, sp.points[0]!.y - c.y) - c.radius);
    expect(off, `the end was left at ${JSON.stringify(sp.points[0])}`).toBeLessThan(1e-6);
    expect(Math.abs(dot(leaving(sp, 0), radial(c, sp.points[0]!)))).toBeLessThan(1e-6);
  });

  it("a spline started partway along a line stays on it, and leaves along it", async () => {
    const l = L("l", 40, 30, 80, 30);
    const live = tangentSketch([l, SP("s", [[60, 30], [64, 42], [75, 48]])]);
    live.click(64, 42);
    live.click(45, 30);
    await live.settle();
    expect(live.s.constraints).toEqual([
      { type: "pointOn", e: "s", p: 0, curve: "l" },
      tan({ spline: "s", end: 0, other: "l" }),
    ]);
    const sp = spline(live.s.entities, "s");
    expect(near(sp.points[0]!, 60, 30), `the end went to ${JSON.stringify(sp.points[0])}`).toBeLessThan(1e-6);
    const d = leaving(sp, 0);
    expect(Math.abs(d.y)).toBeLessThan(1e-7);
    expect(d.x).toBeGreaterThan(0);
    unmoved(live.ent("l"), l);
  });

  it("a spline started on an arc's middle stays on the arc", async () => {
    // the arc's circle: centre (60, 36.357), radius 10.643
    const A: ResolvedEntity = { type: "arc", id: "A", x1: 50, y1: 40, x2: 70, y2: 40, mx: 60, my: 47 };
    const live = tangentSketch([A, SP("s", [[60, 47], [58, 55], [50, 60]])]);
    live.click(58, 55);
    live.click(50.783, 41.678);
    await live.settle();
    expect(live.s.constraints).toEqual([
      { type: "pointOn", e: "s", p: 0, curve: "A" },
      tan({ spline: "s", end: 0, other: "A" }),
    ]);
    const sp = spline(live.s.entities, "s");
    expect(near(sp.points[0]!, 60, 47), `the end went to ${JSON.stringify(sp.points[0])}`).toBeLessThan(1e-6);
    const ctr = { x: 60, y: 509 / 14 };
    expect(Math.abs(dot(leaving(sp, 0), radial(ctr, sp.points[0]!)))).toBeLessThan(1e-7);
  });

  it("from the menu too: the On comes with the tangency", async () => {
    const C: ResolvedEntity = { type: "circle", id: "C", x: 60, y: 50, radius: 20 };
    const live = liveSketch([C, SP("s", [[80, 50], [88, 62], [100, 64]])]);
    live.s.selected = new Set(["C", "s"]);
    vi.mocked(contextMenu).mockClear();
    live.s.onContextMenu({ clientX: 88 * PX, clientY: 62 * PX, preventDefault() {} } as unknown as MouseEvent);
    const items = (vi.mocked(contextMenu).mock.calls[0]?.[2] ?? []) as CtxItem[];
    items.find((i) => i.label === t("tool.tangent"))!.onClick!();
    await live.settle();
    expect(live.s.constraints).toEqual([
      { type: "pointOn", e: "s", p: 0, curve: "C" },
      tan({ spline: "s", end: 0, other: "C" }),
    ]);
    expect(near(spline(live.s.entities, "s").points[0]!, 80, 50)).toBeLessThan(1e-6);
  });

  it("an end already held On the curve is not given a second On", async () => {
    const C: ResolvedEntity = { type: "circle", id: "C", x: 60, y: 50, radius: 20 };
    const on: SketchConstraint = { type: "pointOn", e: "s", p: 0, curve: "C" };
    const live = tangentSketch([C, SP("s", [[80, 50], [88, 62], [100, 64]])], [on]);
    live.click(88, 62);
    live.click(60, 70);
    await live.settle();
    expect(live.s.constraints).toEqual([on, tan({ spline: "s", end: 0, other: "C" })]);
  });

  it("two spline ends a hair apart that the solver keeps as two points are joined too", async () => {
    // 0.0002 mm apart, either side of a merge bucket's edge (coincKey rounds
    // to the micron): close enough to be a joint, not merged into one point
    const live = tangentSketch([
      SP("a", [[10, 30], [25, 40], [40.0004, 30]]),
      SP("b", [[40.0006, 30], [50, 22], [65, 28]]),
    ]);
    live.click(25, 40);
    live.click(50, 22);
    await live.settle();
    expect(live.s.constraints).toEqual([
      { type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 },
      tan({ spline: "a", end: 1, other: "b", otherEnd: 0 }),
    ]);
    const a = spline(live.s.entities, "a"), b = spline(live.s.entities, "b");
    expect(near(a.points[2]!, b.points[0]!.x, b.points[0]!.y)).toBeLessThan(1e-9);
    const da = leaving(a, 1), db = leaving(b, 0);
    expect(dot(da, db)).toBeCloseTo(-1, 9);
  });

  it("the line picked first turns about the joint; the spline does not move", async () => {
    const l = L("l", 20, 13, 50, 25);
    const s0 = SP("s", [[50, 25], [58, 38], [72, 40]]) as Spline;
    const live = tangentSketch([l, s0]);
    live.click(35, 19);
    live.click(58, 38);
    await live.settle();
    // the ends are one solver point: nothing to add
    expect(live.s.constraints).toEqual([tan({ spline: "s", end: 0, other: "l" })]);
    const got = line(live.s.entities, "l");
    expect(near({ x: got.x2, y: got.y2 }, 50, 25), `the joint went to ${got.x2}, ${got.y2}`).toBeLessThan(1e-6);
    const sp = spline(live.s.entities, "s");
    sp.points.forEach((p, k) => expect(near(p, s0.points[k]!.x, s0.points[k]!.y), `fit point ${k}`).toBeLessThan(1e-6));
    // ...and the line runs on into the spline's first span
    const u = { x: got.x2 - got.x1, y: got.y2 - got.y1 }, ul = Math.hypot(u.x, u.y);
    expect(dot({ x: u.x / ul, y: u.y / ul }, leaving(sp, 0))).toBeCloseTo(1, 9);
  });

  it("a line held Horizontal, picked first, cannot turn: the spline turns, about the joint", async () => {
    // the line tool usually adds Horizontal, so this is the common case
    const l = L("l", 20, 25, 50, 25);
    const live = tangentSketch([l, SP("s", [[50, 25], [58, 38], [72, 40]])], [{ type: "horizontal", line: "l" }]);
    live.click(35, 25);
    live.click(58, 38);
    await live.settle();
    expect(live.s.constraints.at(-1)).toEqual(tan({ spline: "s", end: 0, other: "l" }));
    unmoved(live.ent("l"), l);
    const sp = spline(live.s.entities, "s");
    expect(near(sp.points[0]!, 50, 25)).toBeLessThan(1e-6);
    expect(near(sp.points[2]!, 72, 40), "the far fit point stays").toBeLessThan(1e-6);
    const d = leaving(sp, 0);
    expect(Math.abs(d.y)).toBeLessThan(1e-7);
    expect(d.x).toBeGreaterThan(0);
  });
});

describe("the rest of the sketcher knows it", () => {
  it("draws a T glyph on the spline by its joint, clear of the joint itself", () => {
    const ents = lineIntoJoint();
    const g = constraintGlyphs(ents, [tan({ spline: "s", end: 0, other: "l" })]);
    expect(g).toHaveLength(1);
    expect(g[0]!.label).toBe("T");
    const d = Math.hypot(g[0]!.pos.x - 40, g[0]!.pos.y);
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(10);
  });

  it("the right-click menu offers Tangent for a spline and the line its end meets, and only then", () => {
    const [l, s] = lineIntoJoint();
    expect(applicableConstraints([l!, s!])).toEqual(["tangent"]);
    const loose = SP("s", [[45, 3], [50, 12], [70, 10]]);
    expect(applicableConstraints([l!, loose])).toEqual([]);
    expect(applicableConstraints([s!])).toEqual([]);
  });

  it("a menu Tangent on the selection solves the spline onto the line's direction", async () => {
    const live = liveSketch(lineIntoJoint());
    live.s.selected = new Set(["l", "s"]);
    vi.mocked(contextMenu).mockClear();
    live.s.onContextMenu({ clientX: 60 * PX, clientY: 11 * PX, preventDefault() {} } as unknown as MouseEvent);
    const items = (vi.mocked(contextMenu).mock.calls[0]?.[2] ?? []) as CtxItem[];
    const item = items.find((i) => i.label === t("tool.tangent"));
    expect(item, items.map((i) => i.label).join(", ")).toBeTruthy();
    item!.onClick!();
    await live.settle();
    expect(live.s.constraints).toEqual([tan({ spline: "s", end: 0, other: "l" })]);
    const d = leaving(spline(live.s.entities, "s"), 0);
    expect(Math.abs(d.y)).toBeLessThan(1e-7);
    expect(d.x).toBeGreaterThan(0);
  });

  it("Paul's gesture: Tangent, the spline, the line, in a live sketch", async () => {
    const live = tangentSketch(lineIntoJoint());
    live.click(60, 11);
    live.click(20, 0);
    await live.settle();
    expect(live.s.constraints).toEqual([tan({ spline: "s", end: 0, other: "l" })]);
    const sp = spline(live.s.entities, "s");
    const d = leaving(sp, 0);
    expect(Math.abs(d.y), `the spline leaves at ${JSON.stringify(d)}`).toBeLessThan(1e-7);
    expect(d.x).toBeGreaterThan(0);
    expect(sp.asDrawn).toBe(true);
    expect(vi.mocked(toast)).not.toHaveBeenCalledWith(expect.stringContaining("conflict"));
  });

  it("deleting the line drops the tangency with it", async () => {
    const live = liveSketch(lineIntoJoint(), [tan({ spline: "s", end: 0, other: "l" })]);
    live.s.selected = new Set(["l"]);
    (live.s as unknown as { deleteSelected(): void }).deleteSelected();
    await live.settle();
    expect(live.s.constraints).toEqual([]);
  });
});

describe("splineTangentFor, the rule both entries share", () => {
  it("with BOTH ends on the curve, takes the end nearer the click", () => {
    // a spline from (0,0) arching up to (40,0): both ends on the line
    const l = L("l", -10, 0, 50, 0), s = SP("s", [[0, 0], [20, 15], [40, 0]]);
    const pick = (e: ResolvedEntity, x: number, y: number) => ({ id: e.id, ent: e, at: { x, y } });
    const near0 = splineTangentFor(pick(s, 5, 6), pick(l, 0, 0), [l, s]);
    const near1 = splineTangentFor(pick(s, 35, 6), pick(l, 0, 0), [l, s]);
    expect("c" in near0 && near0.c.end).toBe(0);
    expect("c" in near1 && near1.c.end).toBe(1);
  });

  it("a spline cannot be tangent to itself", () => {
    const s = SP("s", [[0, 0], [20, 15], [0, 0.0001]]);
    const pick = { id: "s", ent: s, at: { x: 0, y: 0 } };
    expect(splineTangentFor(pick, pick, [s])).toEqual({ why: t("sketch.constraint.splineTangentSelf") });
  });
});
