// Explode: a rectangle, polygon or slot turned into the lines (and a slot's
// arcs) it is drawn with, keeping its shape and every constraint on it.
//
// Rectangles, polygons and slots are ONE entity each (types.ts), and round 1
// decided they stay that way (round 1 decision 2): they open up instead, and
// Fillet or Chamfer on one explodes it to lines first. Three reports want
// exactly that:
//
//   5650b766  Fillet on a rectangle "does not give me a fillet radius input
//             box. If I draw 4 separate lines it works ok."
//   be869d55  fillet/chamfer on a polygon selects the outline.
//   a237de6b  "Chamfer, Fillet, Move, Rotate don't work properly on closed
//             shapes like rectangles or polygons." Rotate turned a rectangle
//             into four free lines and every constraint on it was deleted.
//
// The pure function first (what each shape becomes, where each constraint
// goes), then the solver's view of the result, then the gestures that reach it:
// Fillet, Chamfer, the right-click Explode to lines, Rotate.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import * as THREE from "three";
import { chamferCorner, cornerJoins, explodeCompound, filletCorner } from "./modify";
import { compileAndSolve } from "./sketchSolve";
import { circumcenter } from "./arc";
import { detectRegions, pointInRegion, rectCorners, regionsByEntities, resolveRegionRef, type Region } from "./region";
import { expandPattern, translated } from "./pattern";
import { DimInput } from "./dimInput";
import { liveSketch, PX } from "./liveSketch.testkit";
import { dimRefPoints, lineOperand } from "./entityDims";
import { ORIGIN_ID, isOriginGeometry } from "./origin";
import { contextMenu, type CtxItem } from "../ui/menu";
import { DocumentStore } from "../document/store";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { CadDocument, Feature, RebuildReply, SketchConstraint, SketchPattern } from "../types";
import type { GeometryBackend } from "../geometry/client";

// The on-canvas box (DimInput) is real, rendered against the fake DOM; its
// inputs and SketchMode's key handler narrow with instanceof.
class FakeInput extends FakeEl {
  constructor() {
    super("input");
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLInputElement = FakeInput;
g.HTMLTextAreaElement = class {};
g.HTMLSelectElement = class {};
g.HTMLElement = FakeEl;
g.Node = FakeEl;
installFakeDocument();
(g.document as { createElement(tag: string): FakeEl }).createElement = (tag: string) =>
  tag === "input" ? new FakeInput() : new FakeEl(tag);
vi.stubGlobal("requestAnimationFrame", () => 0);

type Line = Extract<ResolvedEntity, { type: "line" }>;
type Arc = Extract<ResolvedEntity, { type: "arc" }>;

const L = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });
/** 60 x 50 with its bottom-left corner on the origin */
const RECT = (): Extract<ResolvedEntity, { type: "rectangle" }> => ({ type: "rectangle", id: "R", x: 30, y: 25, width: 60, height: 50 });
const HEX = (): Extract<ResolvedEntity, { type: "polygon" }> => ({ type: "polygon", id: "P", x: 3, y: 7, radius: 10, sides: 6, angle: 17 });
const SLOT = (): Extract<ResolvedEntity, { type: "slot" }> => ({ type: "slot", id: "S", x1: -10, y1: 0, x2: 20, y2: 5, width: 8 });
const byId = (ents: ResolvedEntity[], id: string) => {
  const e = ents.find((x) => x.id === id);
  if (!e) throw new Error(`no ${id}`);
  return e;
};
const len = (l: Line) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
const lines = (ents: ResolvedEntity[]) => ents.filter((e): e is Line => e.type === "line" && !e.construction);
/** the angle between two lines, in degrees */
const angleDeg = (a: Line, b: Line) => {
  const c = ((a.x2 - a.x1) * (b.x2 - b.x1) + (a.y2 - a.y1) * (b.y2 - b.y1)) / (len(a) * len(b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};
/** how far a line misses being tangent to an arc's circle */
const offTangent = (l: Line, a: Arc) => {
  const c = circumcenter({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: a.mx, y: a.my })!;
  const r = Math.hypot(a.x1 - c.x, a.y1 - c.y);
  const d = Math.abs((c.x - l.x1) * (l.y2 - l.y1) - (c.y - l.y1) * (l.x2 - l.x1)) / len(l);
  return Math.abs(d - r);
};
/** the area inside a closed polyline */
const area = (loop: { x: number; y: number }[]) =>
  Math.abs(loop.reduce((s, p, i) => {
    const q = loop[(i + 1) % loop.length]!;
    return s + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
/** a solve that drags the point at `from` by `by` in six frames, as a hand does, then settles */
async function drag(ents: ResolvedEntity[], cons: SketchConstraint[], from: { x: number; y: number }, by: { x: number; y: number }) {
  let at = from;
  for (let i = 1; i <= 6; i++) {
    const to = { x: from.x + (by.x * i) / 6, y: from.y + (by.y * i) / 6 };
    const r = await compileAndSolve(ents, cons, { fromX: at.x, fromY: at.y, toX: to.x, toY: to.y });
    expect(r.conflicts, `frame ${i}`).toEqual([]);
    ents = r.entities;
    at = to;
  }
  return compileAndSolve(ents, cons);
}

beforeEach(() => { toasts.length = 0; });

describe("what each shape becomes", () => {
  it("a rectangle: four lines in its place, its id on the first, held by Horizontal and Vertical", () => {
    const other = L("x", 0, 0, -5, -5);
    const ex = explodeCompound([other, { ...RECT(), construction: true }, L("y", 1, 1, 2, 2)], [], 1)!;
    expect(ex.entities.map((e) => e.id)).toEqual(["x", ...ex.sides, "y"]);
    expect(ex.sides[0], "the id stays, on the bottom side").toBe("R");
    const corners = rectCorners(30, 25, 60, 50);
    ex.sides.forEach((id, k) => {
      const l = byId(ex.entities, id) as Line;
      const a = corners[k]!, b = corners[(k + 1) % 4]!;
      expect([l.x1, l.y1, l.x2, l.y2]).toEqual([a.x, a.y, b.x, b.y]);
      expect(l.construction).toBe(true);
    });
    const [s0, s1, s2, s3] = ex.sides;
    expect(ex.constraints).toEqual([
      { type: "horizontal", line: s0 }, { type: "vertical", line: s1 },
      { type: "horizontal", line: s2 }, { type: "vertical", line: s3 },
    ]);
    expect(ex.helpers).toEqual([]);
  });

  it("a rectangle about to be rotated is held by Perpendicular, which holds at any angle", () => {
    const ex = explodeCompound([RECT()], [], 0, { square: "perpendicular" })!;
    const [s0, s1, s2, s3] = ex.sides;
    expect(ex.constraints).toEqual([
      { type: "perpendicular", l1: s0, l2: s1 },
      { type: "perpendicular", l1: s1, l2: s2 },
      { type: "perpendicular", l1: s2, l2: s3 },
    ]);
  });

  it("a polygon: its sides as lines, every corner on a construction circle and every side touching a concentric one", () => {
    const ex = explodeCompound([HEX()], [], 0)!;
    expect(ex.sides).toHaveLength(6);
    expect(ex.outline).toEqual(ex.sides);
    const [ring, inner] = ex.helpers.map((id) => byId(ex.entities, id));
    expect(ring).toMatchObject({ type: "circle", x: 3, y: 7, radius: 10, construction: true });
    expect(inner).toMatchObject({ type: "circle", x: 3, y: 7, construction: true });
    expect((inner as { radius: number }).radius).toBeCloseTo(10 * Math.cos(Math.PI / 6), 12);
    expect(ex.constraints).toEqual([
      { type: "concentric", c1: ring!.id, c2: inner!.id },
      ...ex.sides.map((s) => ({ type: "pointOn", e: s, p: 0, curve: ring!.id })),
      ...ex.sides.map((s) => ({ type: "tangent2", a: s, b: inner!.id })),
    ]);
    for (const l of lines(ex.entities)) {
      expect(Math.hypot(l.x1 - 3, l.y1 - 7)).toBeCloseTo(10, 12);
      expect(len(l)).toBeCloseTo(10, 12); // a hexagon's side is its radius
    }
  });

  it("a slot: two lines and two end arcs that meet them tangent, around the same outline", () => {
    const ex = explodeCompound([SLOT()], [], 0)!;
    const [l0, endB, l1, endA] = ex.outline.map((id) => byId(ex.entities, id)) as [Line, Arc, Line, Arc];
    expect(ex.sides).toEqual([l0.id, l1.id]);
    expect([l0.type, endB.type, l1.type, endA.type]).toEqual(["line", "arc", "line", "arc"]);
    // joined end to end, all the way round
    expect([endB.x1, endB.y1]).toEqual([l0.x2, l0.y2]);
    expect([l1.x1, l1.y1]).toEqual([endB.x2, endB.y2]);
    expect([endA.x1, endA.y1]).toEqual([l1.x2, l1.y2]);
    expect([l0.x1, l0.y1]).toEqual([endA.x2, endA.y2]);
    for (const l of [l0, l1]) for (const a of [endA, endB]) expect(offTangent(l, a)).toBeLessThan(1e-9);
    // each end is a half circle the slot's width across, round its own centre
    const cB = circumcenter({ x: endB.x1, y: endB.y1 }, { x: endB.x2, y: endB.y2 }, { x: endB.mx, y: endB.my })!;
    expect(cB.x).toBeCloseTo(20, 9);
    expect(cB.y).toBeCloseTo(5, 9);
    expect(Math.hypot(endB.x1 - cB.x, endB.y1 - cB.y)).toBeCloseTo(4, 9);
    expect(ex.helpers.map((id) => byId(ex.entities, id))).toMatchObject([
      { type: "line", construction: true }, { type: "line", construction: true },
    ]);
  });

  it("is not for anything else, nor for a shape with no size", () => {
    expect(explodeCompound([L("l", 0, 0, 1, 1)], [], 0)).toBeNull();
    expect(explodeCompound([{ ...RECT(), width: 0 }], [], 0)).toBeNull();
    expect(explodeCompound([{ ...HEX(), radius: 0 }], [], 0)).toBeNull();
    expect(explodeCompound([{ ...SLOT(), x2: -10, y2: 0 }], [], 0)).toBeNull();
  });
});

describe("every constraint on the shape moves to its lines", () => {
  const others: ResolvedEntity[] = [
    L("X", 100, 0, 100, 40),
    { type: "circle", id: "C", x: 120, y: 20, radius: 5 },
    { type: "rectangle", id: "Q", x: 30, y: 25, width: 50, height: 40 },
  ];
  /** explode R with `c` on it, and return what `c` became */
  const after = (c: SketchConstraint, place?: { width?: { ox: number; oy: number } }) => {
    const ex = explodeCompound([{ ...RECT(), ...(place ? { dimPlace: place } : {}) }, ...others], [c], 0)!;
    const [s0, s1, s2, s3] = ex.sides as [string, string, string, string];
    return { got: ex.constraints[0], dropped: ex.dropped, s0, s1, s2, s3 };
  };

  it("a corner, in either spelling, becomes the start of the side leaving it", () => {
    let r = after({ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 3 });
    expect(r.got).toEqual({ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: r.s3, p2: 0 });
    // edge 2 runs tr -> tl, so its end (p 1) is corner 3 too
    r = after({ type: "coincident", e1: "R~2", p1: 1, e2: "X", p2: 0 });
    expect(r.got).toEqual({ type: "coincident", e1: r.s3, p1: 0, e2: "X", p2: 0 });
    r = after({ type: "fix", e: "R", p: 1 });
    expect(r.got).toEqual({ type: "fix", e: r.s1, p: 0 });
    r = after({ type: "pointOn", e: "R", p: 2, curve: "X" });
    expect(r.got).toEqual({ type: "pointOn", e: r.s2, p: 0, curve: "X" });
    r = after({ type: "p2cDistance", id: "c1", e: "R", p: 0, circle: "C", value: 7 });
    expect(r.got).toEqual({ type: "p2cDistance", id: "c1", e: "R", p: 0, circle: "C", value: 7 });
    r = after({ type: "symmetric", e1: "R", p1: 1, e2: "R", p2: 2, line: "X" });
    expect(r.got).toEqual({ type: "symmetric", e1: r.s1, p1: 0, e2: r.s2, p2: 0, line: "X" });
  });

  it("an edge becomes its line, in every constraint that takes one", () => {
    const cases: [SketchConstraint, (s: string[]) => SketchConstraint][] = [
      [{ type: "horizontal", line: "R~2" }, (s) => ({ type: "horizontal", line: s[2]! })],
      [{ type: "parallel", l1: "X", l2: "R~1" }, (s) => ({ type: "parallel", l1: "X", l2: s[1]! })],
      [{ type: "perpendicular", l1: "R~0", l2: "X" }, (s) => ({ type: "perpendicular", l1: s[0]!, l2: "X" })],
      [{ type: "equal", l1: "R~3", l2: "X" }, (s) => ({ type: "equal", l1: s[3]!, l2: "X" })],
      [{ type: "collinear", l1: "R~1", l2: "X" }, (s) => ({ type: "collinear", l1: s[1]!, l2: "X" })],
      [{ type: "angle", id: "c2", l1: "R~0", l2: "X", value: 90 }, (s) => ({ type: "angle", id: "c2", l1: s[0]!, l2: "X", value: 90 })],
      [{ type: "tangent", line: "R~1", circle: "C" }, (s) => ({ type: "tangent", line: s[1]!, circle: "C" })],
      [{ type: "tangent2", a: "C", b: "R~1" }, (s) => ({ type: "tangent2", a: "C", b: s[1]! })],
      [{ type: "midpoint", e: "X", p: 0, line: "R~2" }, (s) => ({ type: "midpoint", e: "X", p: 0, line: s[2]! })],
      [{ type: "pointOn", e: "X", p: 1, curve: "R~1" }, (s) => ({ type: "pointOn", e: "X", p: 1, curve: s[1]! })],
      [{ type: "p2lDistance", id: "c3", e: "X", p: 0, line: "R~1", value: 40 }, (s) => ({ type: "p2lDistance", id: "c3", e: "X", p: 0, line: s[1]!, value: 40 })],
      [{ type: "c2lDistance", id: "c4", circle: "C", line: "R~1", value: 55 }, (s) => ({ type: "c2lDistance", id: "c4", circle: "C", line: s[1]!, value: 55 })],
      [
        { type: "offset", id: "c5", value: -5, pairs: [0, 1, 2, 3].map((k) => ({ src: `R~${k}`, cpy: `Q~${k}` })) },
        (s) => ({ type: "offset", id: "c5", value: -5, pairs: [0, 1, 2, 3].map((k) => ({ src: s[k]!, cpy: `Q~${k}` })) }),
      ],
    ];
    for (const [c, want] of cases) {
      const r = after(c);
      expect(r.got, c.type).toEqual(want([r.s0, r.s1, r.s2, r.s3]));
      expect(r.dropped).toBe(0);
    }
  });

  it("a locked width or height holds the distance between opposite sides, its id and its badge placement kept", () => {
    // Lock spells a width as a distance on edge 0 (directDims.lockDimFor).
    // Kept as the LENGTH of the bottom line it would pull the rectangle out by
    // the corner a fillet rounds (see the fillet test below).
    let r = after({ type: "distance", id: "c6", line: "R~0", value: 60 }, { width: { ox: 0, oy: -9 } });
    // from br, on the right side, across to the left side: below the bottom,
    // where the width badge was
    expect(r.got).toEqual({ type: "p2lDistance", id: "c6", e: r.s1, p: 0, line: r.s3, value: 60, place: { ox: 0, oy: -9 } });
    r = after({ type: "distance", line: "R~3", value: 50 });
    expect(r.got).toEqual({ type: "p2lDistance", e: r.s0, p: 0, line: r.s2, value: 50 });
  });

  it("so does a dimension across one side's two corners; a diagonal stays point to point", () => {
    let r = after({ type: "p2pDistance", id: "c7", e1: "R", p1: 2, e2: "R", p2: 3, value: 60, place: { ox: 0, oy: 8 } });
    expect(r.got).toEqual({ type: "p2lDistance", id: "c7", e: r.s1, p: 1, line: r.s3, value: 60, place: { ox: 0, oy: 8 } });
    r = after({ type: "p2pDistanceY", e1: "R", p1: 1, e2: "R", p2: 2, value: 50, driven: true });
    expect(r.got).toEqual({ type: "p2lDistance", e: r.s0, p: 1, line: r.s2, value: 50, driven: true });
    // signed: the size is the magnitude
    r = after({ type: "p2pDistanceX", e1: "R", p1: 1, e2: "R", p2: 0, value: -60 });
    expect(r.got).toEqual({ type: "p2lDistance", e: r.s1, p: 0, line: r.s3, value: 60 });
    r = after({ type: "p2pDistance", e1: "R", p1: 0, e2: "R", p2: 2, value: 78.1 });
    expect(r.got).toEqual({ type: "p2pDistance", e1: r.s0, p1: 0, e2: r.s2, p2: 0, value: 78.1 });
  });

  it("leaves everything else alone, and counts what it cannot carry", () => {
    const keep: SketchConstraint = { type: "vertical", line: "X" };
    const ex = explodeCompound([RECT(), ...others], [
      keep,
      { type: "horizontal", line: "R~7" },
      { type: "coincident", e1: "R", p1: 9, e2: "X", p2: 0 },
      { type: "horizontal", line: "R" },
    ], 0)!;
    expect(ex.constraints[0]).toBe(keep);
    expect(ex.dropped).toBe(3);
    expect(ex.constraints).toHaveLength(1 + 4);
  });

  it("a point on a polygon or slot side moves to that side's line", () => {
    const pt: ResolvedEntity = { type: "point", id: "p", x: 0, y: 0 };
    let ex = explodeCompound([HEX(), pt], [{ type: "pointOn", e: "p", p: 0, curve: "P~3" }, { type: "pointOn", e: "p", p: 0, curve: "P~6" }], 0)!;
    expect(ex.constraints[0]).toEqual({ type: "pointOn", e: "p", p: 0, curve: ex.sides[3] });
    expect(ex.dropped, "a hexagon has no side 6").toBe(1);
    ex = explodeCompound([SLOT(), pt], [{ type: "pointOn", e: "p", p: 0, curve: "S~1" }], 0)!;
    expect(ex.constraints[0]).toEqual({ type: "pointOn", e: "p", p: 0, curve: ex.sides[1] });
  });
});

describe("the solver keeps it the shape it was", () => {
  it("a rectangle: the same freedom, nothing over-defined, and square after a corner drag", async () => {
    const cons: SketchConstraint[] = [
      { type: "distance", line: "R~0", value: 60 },
      { type: "distance", line: "R~3", value: 50 },
    ];
    const before = await compileAndSolve([RECT()], cons);
    const ex = explodeCompound([RECT()], cons, 0)!;
    const r = await compileAndSolve(ex.entities, ex.constraints);
    expect(r.conflicts).toEqual([]);
    expect(r.overDefined).toEqual([]);
    expect(r.dof).toBe(before.dof);

    const free = explodeCompound([RECT()], [], 0)!;
    const d = await drag(free.entities, free.constraints, { x: 60, y: 50 }, { x: 5, y: 3 });
    const ls = lines(d.entities);
    for (let k = 0; k < 4; k++) expect(angleDeg(ls[k]!, ls[(k + 1) % 4]!)).toBeCloseTo(90, 9);
    expect(ls.map(len).map((x) => x.toFixed(6))).toEqual(["65.000000", "53.000000", "65.000000", "53.000000"]);
  });

  it("a polygon: four freedoms (centre, size, angle), and regular after a corner drag", async () => {
    const ex = explodeCompound([HEX()], [], 0)!;
    const r = await compileAndSolve(ex.entities, ex.constraints);
    expect(r.overDefined).toEqual([]);
    expect(r.dof).toBe(4);
    const corner = lines(ex.entities)[0]!;
    const d = await drag(ex.entities, ex.constraints, { x: corner.x1, y: corner.y1 }, { x: 4, y: 3 });
    const ls = lines(d.entities);
    const ring = byId(d.entities, ex.helpers[0]!) as Extract<ResolvedEntity, { type: "circle" }>;
    expect(ring.radius, "the drag did resize it").not.toBeCloseTo(10, 3);
    for (const l of ls) {
      expect(len(l)).toBeCloseTo(ring.radius, 9);
      expect(Math.hypot(l.x1 - ring.x, l.y1 - ring.y)).toBeCloseTo(ring.radius, 9);
    }
  });

  it("a slot: five freedoms (two centres, a width), nothing over-defined, tangent after a drag", async () => {
    const ex = explodeCompound([SLOT()], [], 0)!;
    const r = await compileAndSolve(ex.entities, ex.constraints);
    expect(r.overDefined).toEqual([]);
    expect(r.dof).toBe(5);
    const l0 = byId(ex.entities, ex.sides[0]!) as Line;
    const d = await drag(ex.entities, ex.constraints, { x: l0.x2, y: l0.y2 }, { x: 6, y: 6 });
    const [a0, endB, a1, endA] = ex.outline.map((id) => byId(d.entities, id)) as [Line, Arc, Line, Arc];
    for (const l of [a0, a1]) for (const a of [endA, endB]) expect(offTangent(l, a)).toBeLessThan(1e-6);
  });

  it("CONTROL, why the slot is not held by Tangent: a line tangent to an arc it shares an end with is degenerate", async () => {
    // The obvious set (each side Tangent to both ends) is reported redundant in
    // full, so the solve holds nothing and a drag of it conflicts.
    const ex = explodeCompound([SLOT()], [], 0)!;
    const [s0, endB, s1, endA] = ex.outline;
    const tangents: SketchConstraint[] = [
      { type: "tangent2", a: s0!, b: endB! }, { type: "tangent2", a: s1!, b: endB! },
      { type: "tangent2", a: s1!, b: endA! }, { type: "tangent2", a: s0!, b: endA! },
      { type: "equalRadius", a: endA!, b: endB! },
    ];
    const outline = ex.entities.filter((e) => !e.construction);
    const r = await compileAndSolve(outline, tangents);
    expect(r.overDefined.length).toBe(4);
  });

  it("a rectangle offset from another: no amber once it is lines", async () => {
    // The offset's sides are already Horizontal and Vertical, and the offset
    // added a Parallel on top, which planegcs reports as redundant.
    const outer = RECT();
    const inner: ResolvedEntity = { type: "rectangle", id: "Q", x: 30, y: 25, width: 50, height: 40 };
    const cons: SketchConstraint[] = [{ type: "offset", value: -5, pairs: [0, 1, 2, 3].map((k) => ({ src: `R~${k}`, cpy: `Q~${k}` })) }];
    for (const idx of [0, 1]) {
      const ex = explodeCompound([outer, inner], cons, idx)!;
      const r = await compileAndSolve(ex.entities, ex.constraints);
      expect(r.conflicts).toEqual([]);
      expect(r.overDefined, `exploding ${idx ? "the copy" : "the source"}`).toEqual([]);
      expect(r.dof).toBe(4);
    }
    // and both exploded
    const one = explodeCompound([outer, inner], cons, 0)!;
    const both = explodeCompound(one.entities, one.constraints, one.entities.findIndex((e) => e.id === "Q"))!;
    const r = await compileAndSolve(both.entities, both.constraints);
    expect(r.overDefined).toEqual([]);
    expect(r.dof).toBe(4);
  });

  it("a filleted or chamfered corner leaves a polygon regular", async () => {
    // Equal sides would not: the two sides a corner tool shortens pull every
    // other side down to their length.
    for (const cut of ["fillet", "chamfer"] as const) {
      const ex = explodeCompound([HEX()], [], 0)!;
      let ents: ResolvedEntity[], cons: SketchConstraint[];
      if (cut === "fillet") {
        const f = filletCorner(ex.entities, 0, 1, 3)!;
        ents = f.entities;
        cons = [...cornerJoins(ex.constraints, ex.entities, ents, ex.sides[0]!, ex.sides[1]!).constraints, ...f.constraints];
      } else {
        ents = chamferCorner(ex.entities, 0, 1, 2)!;
        cons = cornerJoins(ex.constraints, ex.entities, ents, ex.sides[0]!, ex.sides[1]!).constraints;
      }
      const r = await compileAndSolve(ents, cons);
      expect(r.conflicts, cut).toEqual([]);
      const ring = byId(r.entities, ex.helpers[0]!) as Extract<ResolvedEntity, { type: "circle" }>;
      expect(ring.radius, cut).toBeCloseTo(10, 9);
      // every side's LINE still sits where the hexagon's side does
      const want = 10 * Math.cos(Math.PI / 6);
      for (const id of ex.sides) {
        const l = byId(r.entities, id) as Line;
        const d = Math.abs((ring.x - l.x1) * (l.y2 - l.y1) - (ring.y - l.y1) * (l.x2 - l.x1)) / len(l);
        expect(d, `${cut} ${id}`).toBeCloseTo(want, 9);
      }
    }
  });

  it("a filleted corner keeps a locked rectangle its size", async () => {
    const cons: SketchConstraint[] = [
      { type: "distance", line: "R~0", value: 60 },
      { type: "distance", line: "R~3", value: 50 },
    ];
    const ex = explodeCompound([RECT()], cons, 0)!;
    const f = filletCorner(ex.entities, 0, 1, 5)!; // bottom-right
    const r = await compileAndSolve(f.entities, [...cornerJoins(ex.constraints, ex.entities, f.entities, ex.sides[0]!, ex.sides[1]!).constraints, ...f.constraints]);
    expect(r.conflicts).toEqual([]);
    const xs = lines(r.entities).flatMap((l) => [l.x1, l.x2]);
    const ys = lines(r.entities).flatMap((l) => [l.y1, l.y2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(50, 9);
  });
});

describe("an extrude's picked area still finds it", () => {
  it("the area named by the rectangle's id is the same area once it is lines", () => {
    // Extrudes record the ids around the area they picked (regionEntities) and
    // trust them before their stored point.
    const before = regionsByEntities(detectRegions("s", [RECT()]), ["R"]);
    const ex = explodeCompound([RECT()], [], 0)!;
    const after = regionsByEntities(detectRegions("s", ex.entities), ["R"]);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(area(after[0]!.loop)).toBeCloseTo(area(before[0]!.loop), 9);
    expect(area(after[0]!.loop)).toBeCloseTo(3000, 9);
  });
});

// --- the gestures -------------------------------------------------------------

/** a live sketch with the REAL on-canvas box, and the keystrokes that fill it */
function withBox(live: ReturnType<typeof liveSketch>) {
  const dim = new DimInput();
  Object.assign(live.s, { dim });
  const field = (name: string) => {
    const f = (dim as unknown as { fields: { def: { name: string }; input: FakeInput }[] }).fields.find((x) => x.def.name === name);
    if (!f) throw new Error(`no ${name} field in the box`);
    return f.input;
  };
  return {
    dim,
    /** type `text` into the box's `name` field and press Enter */
    enter(name: string, text: string) {
      const el = field(name);
      el.value = text;
      el.dispatch("input");
      el.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    },
  };
}
const menuItems = () => (vi.mocked(contextMenu).mock.calls.at(-1)?.[2] ?? []) as CtxItem[];
const rightClick = (live: ReturnType<typeof liveSketch>, x: number, y: number) => {
  vi.mocked(contextMenu).mockClear();
  live.s.onContextMenu({ clientX: x * PX, clientY: y * PX, preventDefault() {} } as unknown as MouseEvent);
  return menuItems();
};

describe("Fillet and Chamfer on a shape's sides", () => {
  it("fillets a locked, origin-anchored rectangle's corner, keeps its size, and one undo puts the rectangle back", async () => {
    const cons: SketchConstraint[] = [
      { type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0 },
      { type: "distance", line: "R~0", value: 60 },
      { type: "distance", line: "R~3", value: 50 },
    ];
    const live = liveSketch([RECT()], cons);
    const box = withBox(live);
    live.s.tool = "fillet";
    live.click(40, 0); // the bottom side
    live.click(60, 30); // the right side
    expect(box.dim.isActive).toBe(true);
    box.enter("radius", "5");
    await live.settle();
    expect(live.s.entities.some((e) => e.type === "rectangle")).toBe(false);
    expect(toasts).toContain(t("sketch.modify.explodedForCorner", { shape: t("sketch.entity.rectangle"), tool: t("tool.fillet") }));
    const arc = live.s.entities.find((e): e is Arc => e.type === "arc")!;
    const c = circumcenter({ x: arc.x1, y: arc.y1 }, { x: arc.x2, y: arc.y2 }, { x: arc.mx, y: arc.my })!;
    expect(Math.hypot(arc.x1 - c.x, arc.y1 - c.y)).toBeCloseTo(5, 6);
    const ls = lines(live.s.entities).filter((l) => !l.id.startsWith("__"));
    const xs = ls.flatMap((l) => [l.x1, l.x2]), ys = ls.flatMap((l) => [l.y1, l.y2]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => +v.toFixed(9))).toEqual([0, 60, 0, 50]);
    expect(live.s.constraints.filter((k) => k.type === "p2lDistance")).toHaveLength(2);
    expect(live.s.constraints).toContainEqual({ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0 });

    expect(live.s.undoEdit()).toBe(true);
    expect(live.s.entities.filter((e) => e.type === "rectangle")).toEqual([RECT()]);
    expect(live.s.constraints).toEqual(cons);
  });

  it("chamfers two sides of a hexagon, which stays regular", async () => {
    const live = liveSketch([HEX()]);
    const box = withBox(live);
    live.s.tool = "chamfer";
    const ex = explodeCompound([HEX()], [], 0)!; // where its sides are
    const [a, b] = lines(ex.entities) as [Line, Line];
    live.click((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2);
    live.click((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
    box.enter("distance", "2");
    await live.settle();
    expect(live.s.entities.some((e) => e.type === "polygon")).toBe(false);
    expect(lines(live.s.entities).filter((l) => !l.id.startsWith("__"))).toHaveLength(7); // six sides and the bevel
    expect(live.s.overIdx.size).toBe(0);
    // its own corner-on-the-circle goes with the corner, and is not announced
    expect(toasts).toEqual([t("sketch.modify.explodedForCorner", { shape: t("sketch.entity.polygon"), tool: t("tool.chamfer") })]);
    const ring = live.s.entities.find((e) => e.type === "circle" && e.construction) as Extract<ResolvedEntity, { type: "circle" }>;
    expect(ring.radius).toBeCloseTo(10, 9);
  });

  it("a hexagon with a rounded or bevelled corner, or two, stays regular when its corner circle is resized", async () => {
    // Integration check 2b: Fillet one corner, then type the corner circle's
    // Diameter 40 -> 22 in the panel. The rounded corner's On-the-ring hold
    // went with the corner, and with five corners on the ring the size of
    // the inner circle was free: the full sides read 9.81 instead of 11 and
    // the extruded hexagon came out lopsided, without a word. A second corner
    // of the same polygon lost its hold too, and said a constraint was lost.
    //
    // A filleted one may instead refuse a big resize, with a note: a fillet's
    // two Tangents share an end with their lines, which planegcs reads as
    // degenerate, and whether a big jump then solves depends on the order the
    // solver sees things in. A filleted rectangle with locked sides is refused
    // the same way (60 -> 30 wide). A chamfer has no Tangents and always
    // resizes. What must never happen is the lopsided shape.
    const HEX20 = (): ResolvedEntity => ({ type: "polygon", id: "P", x: 3, y: 7, radius: 20, sides: 6, angle: 17 });
    const cases = [
      ["chamfer", "distance", 1, 22, "resizes"], ["fillet", "radius", 1, 36, "or says why not"],
      ["fillet", "radius", 1, 22, "or says why not"], ["fillet", "radius", 2, 22, "or says why not"],
    ] as const;
    for (const [tool, field, corners, dia, outcome] of cases) {
      const why = `${tool} x${corners} to ${dia}`;
      toasts.length = 0;
      const live = liveSketch([HEX20()]);
      const box = withBox(live);
      const ex = explodeCompound([HEX20()], [], 0)!; // where its sides are, to click them
      const side = (k: number) => byId(ex.entities, ex.sides[k]!) as Line;
      const along = (l: Line) => [l.x1 + (l.x2 - l.x1) * 0.4, l.y1 + (l.y2 - l.y1) * 0.4] as const; // off the badge
      for (let c = 0; c < corners; c++) {
        live.s.tool = tool;
        live.click(...along(side(2 * c))); // sides 2c and 2c+1 meet at corner 2c+1
        live.click(...along(side(2 * c + 1)));
        box.enter(field, "4");
        await live.settle();
      }
      const exploded = t("sketch.modify.explodedForCorner", { shape: t("sketch.entity.polygon"), tool: t(`tool.${tool}`) });
      expect(toasts, `${why}: nothing lost`).toEqual([exploded]);
      const ring = live.s.entities.find((e) => e.type === "circle" && e.construction && Math.abs(e.radius - 20) < 1e-6)!;
      expect(ring, why).toBeDefined();
      // the panel's Diameter row, while the sketch is open (inspector -> store.setSketchDimension)
      (live.s as unknown as { applyDimensionEdit(id: string, f: string, mm: number): void }).applyDimensionEdit(ring.id, "diameter", dia);
      await live.settle();
      const c = live.s.entities.find((e) => e.id === ring.id) as Extract<ResolvedEntity, { type: "circle" }>;
      if (outcome === "resizes") expect(c.radius, why).toBeCloseTo(dia / 2, 6);
      else if (Math.abs(c.radius - dia / 2) > 1e-6) {
        expect(c.radius, `${why}: refused, so unchanged`).toBeCloseTo(20, 6);
        expect(toasts.length, `${why}: and said so`).toBe(2);
      }
      // every side's line touches the circle a regular hexagon that size has
      // inside it, and every side no tool shortened is a full side long
      const sides = lines(live.s.entities).filter((l) => !l.id.startsWith("__"));
      const inner = c.radius * Math.cos(Math.PI / 6);
      const fromCentre = (l: Line) => Math.abs((c.x - l.x1) * (l.y2 - l.y1) - (c.y - l.y1) * (l.x2 - l.x1)) / len(l);
      const outline = sides.filter((l) => Math.abs(fromCentre(l) - inner) < 1e-6);
      expect(outline, `${why}: six sides touch the inner circle`).toHaveLength(6);
      expect(outline.filter((l) => Math.abs(len(l) - c.radius) < 1e-6), `${why}: full sides`).toHaveLength(6 - 2 * corners);
    }
  });

  it("a parameter-driven polygon stays a polygon, and says why", () => {
    const live = liveSketch([HEX()]);
    (live.s as unknown as { pendingBindings: Map<string, unknown> }).pendingBindings.set("e:P:radius", { expr: "w/2", kind: "length", name: "hole_r" });
    live.s.tool = "fillet";
    const ex = explodeCompound([HEX()], [], 0)!;
    const a = lines(ex.entities)[0]!;
    live.click((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2);
    expect(toasts).toEqual([t("sketch.modify.explodeParamBound", { shape: t("sketch.entity.polygon"), name: "hole_r" })]);
    expect((live.s as unknown as { filletFirst: number | null }).filletFirst).toBeNull();
  });
});

describe("right-click Explode to lines", () => {
  it("is offered for a shape, and not for lines alone", () => {
    const live = liveSketch([RECT(), L("l", 100, 0, 140, 0)]);
    expect(rightClick(live, 30, 0).map((i) => i.label)).toContain(t("sketch.menu.explode"));
    live.s.selected = new Set();
    expect(rightClick(live, 120, 0).map((i) => i.label)).not.toContain(t("sketch.menu.explode"));
  });

  it("turns a selected slot into lines and arcs that stay selected and solve clean", async () => {
    const live = liveSketch([SLOT()]);
    const l0 = explodeCompound([SLOT()], [], 0)!;
    const side = byId(l0.entities, "S") as Line;
    rightClick(live, (side.x1 + side.x2) / 2, (side.y1 + side.y2) / 2).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await live.settle();
    expect(live.s.entities.some((e) => e.type === "slot")).toBe(false);
    expect(live.s.entities.filter((e) => e.type === "arc")).toHaveLength(2);
    expect(live.s.selected.size, "outline and its two construction diameters").toBe(6);
    expect(live.s.overIdx.size).toBe(0);
    expect(live.s.lastDof).toBe(5);
  });

  it("a pattern of the shape patterns all of it, not the one line that kept its id", () => {
    const live = liveSketch([RECT()]);
    const pat: SketchPattern = { id: "p0", type: "patternRect", sources: ["R"], countX: 2, countY: 1, spacingX: 80, spacingY: 0 };
    (live.s as unknown as { patterns: SketchPattern[] }).patterns = [pat];
    rightClick(live, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    const sides = lines(live.s.entities).filter((l) => !l.id.startsWith("__")).map((l) => l.id);
    expect(sides).toHaveLength(4);
    expect((pat as { sources: string[] }).sources).toEqual(sides);
  });
});

describe("Rotate on a rectangle (a237de6b)", () => {
  it("keeps its locks and its corner on the origin, held square, instead of dropping them", async () => {
    // The reporter's shape: a rectangle with two locked sizes and a corner on
    // the origin. Rotate used to leave four free lines and NO constraints, and
    // a corner drag afterwards bent it to 82/90/62/54 degrees.
    const cons: SketchConstraint[] = [
      { type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0 },
      { type: "distance", line: "R~0", value: 60 },
      { type: "distance", line: "R~3", value: 50 },
    ];
    const live = liveSketch([RECT()], cons);
    const box = withBox(live);
    live.s.selected = new Set(["R"]);
    live.s.tool = "rotate";
    // The pivot is the anchored corner. Turned about anything else, the
    // corner would leave the origin its coincident holds it to, and what Rotate
    // should do then is part of another decision (C8: refuse, and say so).
    live.click(0, 0);
    box.enter("angle", "30");
    await live.settle();
    expect(toasts).toContain(t("sketch.transform.rectangleToLines", { count: 1 }));
    const ls = lines(live.s.entities).filter((l) => !l.id.startsWith("__"));
    expect(ls).toHaveLength(4);
    expect(live.s.constraints).toHaveLength(3 + 3);
    expect(live.s.constraints).toContainEqual({ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0 });
    const bottom = byId(live.s.entities, "R") as Line;
    expect(Math.hypot(bottom.x1, bottom.y1), "the corner is still on the origin").toBeLessThan(1e-6);
    expect((Math.atan2(bottom.y2 - bottom.y1, bottom.x2 - bottom.x1) * 180) / Math.PI).toBeCloseTo(30, 3);
    expect(ls.map(len).map((x) => +x.toFixed(6))).toEqual([60, 50, 60, 50]);
    for (let k = 0; k < 4; k++) expect(angleDeg(ls[k]!, ls[(k + 1) % 4]!)).toBeCloseTo(90, 6);
  });
});

// --- what the explode does to the rest of the document ----------------------------

/** A backend that never builds: these tests read the document, not the model. */
const noBackend = () => ({
  async rebuild(): Promise<RebuildReply> { return { ok: false, error: { message: "stub" } }; },
  async init() {},
  onStatus: () => () => {},
  connected: true,
}) as unknown as GeometryBackend;

type Extrude = Extract<Feature, { type: "extrude" }>;

/** A live sketch that IS sketch f1 of a real document, with extrude e1 built on
 *  it, so finish() commits through the real store the way the app does. */
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
    // what finish() reaches that this harness does not draw
    patternFlow: { flushPending() {}, hasPending: () => false, flushOnFinish() {} },
    cleanup() {},
  });
  return {
    ...live,
    store,
    e1: () => store.document.features.find((f): f is Extrude => f.id === "e1" && f.type === "extrude")!,
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
const at = (x: number, y: number) => new THREE.Vector2(x, y);
/** the one area holding `p` */
const areaAt = (rs: Region[], p: THREE.Vector2) => rs.filter((r) => pointInRegion(p, r));
/** the sketch's areas, its pattern copies included, as the extrude sees them */
const areasOf = (live: ReturnType<typeof liveSketch>) => {
  const pats = (live.s as unknown as { patterns: SketchPattern[] }).patterns;
  const byIdMap = new Map(live.s.entities.map((e) => [e.id, e]));
  return detectRegions("f1", [...live.s.entities, ...pats.flatMap((p) => expandPattern(p, byIdMap, {}))]);
};

describe("an extrude built on a shape keeps its area when the shape becomes lines", () => {
  // A line across the rectangle splits it in two, and BOTH halves are bounded
  // by the rectangle and that line: the extrude's ids alone cannot tell them
  // apart, and its stored point picks the half. Explode keeps the rectangle's
  // id on its bottom line only, so afterwards those same ids name the bottom
  // half alone, and the sidecar trusts a name before a point: the top half
  // extruded as the bottom one, with no warning (measured in a replay).
  const CUT = () => L("cut", -10, 25, 70, 25);

  it("Explode re-points an extrude on the top half of a split rectangle, and one undo takes both back", async () => {
    const [top] = areaAt(detectRegions("f1", [RECT(), CUT()]), at(30, 40));
    expect(top!.entityIds).toEqual(["R", "cut"]);
    const doc = onDocument([RECT(), CUT()], { regions: [[30, 40, 0]], regionEntities: [["R", "cut"]], regionHoleEntities: [[]] });
    rightClick(doc, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await doc.settle();
    const after = areasOf(doc);
    expect(
      regionsByEntities(after, ["R", "cut"]).map((r) => pointInRegion(at(30, 10), r)),
      "the kept id alone now names the bottom half",
    ).toEqual([true]);

    doc.finish();
    const e1 = doc.e1();
    const named = regionsByEntities(after, e1.regionEntities![0]!, e1.regionHoleEntities![0]);
    expect(named, "by its name alone, as the sidecar reads it first").toHaveLength(1);
    expect(pointInRegion(at(30, 40), named[0]!)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(e1.regions![0]![0], e1.regions![0]![1]), named[0]!)).toBe(true);

    doc.store.undo();
    expect(doc.e1().regionEntities).toEqual([["R", "cut"]]);
    expect(doc.e1().regions).toEqual([[30, 40, 0]]);
    expect((doc.store.document.features[0] as { entities: ResolvedEntity[] }).entities).toEqual([RECT(), CUT()]);
  });

  it("an extrude on a rectangle stacked on the exploded one stays on it in the build too", async () => {
    // Where two curves share an edge, the sidecar names that edge after BOTH
    // and the app after one, so the app alone would see nothing wrong here:
    // the reference [big, small] still finds the small one in the app, while
    // the build (replayed) found the big one under it. Named by the area's
    // exact ids, the two agree.
    const big: ResolvedEntity = { type: "rectangle", id: "big", x: 0, y: 0, width: 40, height: 20 };
    const small: ResolvedEntity = { type: "rectangle", id: "small", x: 0, y: 15, width: 20, height: 10 };
    const [upper] = areaAt(detectRegions("f1", [big, small]), at(0, 15));
    const doc = onDocument([big, small], { regions: [[0, 15, 0]], regionEntities: [upper!.entityIds], regionHoleEntities: [[]] });
    rightClick(doc, 0, -10).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await doc.settle();
    doc.finish();
    const e1 = doc.e1();
    const [now] = areaAt(areasOf(doc), at(0, 15));
    expect([...e1.regionEntities![0]!].sort()).toEqual([...now!.entityIds].sort());
    expect(e1.regionEntities![0], "the bottom line kept the big one's id, and does not bound this area").not.toContain("big");
  });

  it("an extrude on an area the edit did not touch is written back exactly as it was", async () => {
    const ring: ResolvedEntity = { type: "circle", id: "c", x: 150, y: 25, radius: 10 };
    const doc = onDocument([RECT(), ring], { regions: [[150, 25, 0]], regionEntities: [["c"]], regionHoleEntities: [[]] });
    rightClick(doc, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await doc.settle();
    const before = JSON.stringify(doc.e1());
    doc.finish();
    expect(JSON.stringify(doc.e1())).toBe(before);
  });

  it("undoing the explode inside the sketch drops the re-pointing with it", async () => {
    const doc = onDocument([RECT(), CUT()], { regions: [[30, 40, 0]], regionEntities: [["R", "cut"]], regionHoleEntities: [[]] });
    rightClick(doc, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await doc.settle();
    expect(doc.s.undoEdit()).toBe(true);
    await doc.settle();
    expect(doc.s.entities.some((e) => e.type === "rectangle")).toBe(true);
    const before = JSON.stringify(doc.e1());
    doc.finish();
    expect(JSON.stringify(doc.e1())).toBe(before);
  });

  it("Fillet on a patterned rectangle rounds every copy, and an extrude of all three keeps all three", async () => {
    // A pattern's copies are numbered by position (expandPattern), so a
    // rectangle that becomes four lines and an arc renumbers every copy after
    // the first: the third copy's id became a side of the second.
    const pat: SketchPattern = { id: "p0", type: "patternRect", sources: ["R"], countX: 3, countY: 1, spacingX: 80, spacingY: 0 };
    const centres = [at(30, 25), at(110, 25), at(190, 25)];
    const pre = detectRegions("f1", [RECT(), ...expandPattern(pat, new Map([["R", RECT() as ResolvedEntity]]), {})]);
    const picked = centres.map((c) => areaAt(pre, c)[0]!);
    const doc = onDocument([RECT()], {
      regions: centres.map((c) => [c.x, c.y, 0]),
      regionEntities: picked.map((r) => r.entityIds),
      regionHoleEntities: picked.map(() => []),
    }, [pat]);
    const box = withBox(doc);
    doc.s.tool = "fillet";
    doc.click(40, 0); // the bottom side
    doc.click(60, 30); // the right side
    box.enter("radius", "5");
    await doc.settle();

    // every copy has its corner rounded, so every copy still closes
    const after = areasOf(doc);
    expect(after).toHaveLength(3);
    for (const r of after) expect(area(r.loop)).toBeCloseTo(3000 - (25 - (25 * Math.PI) / 4), 1);

    doc.finish();
    const e1 = doc.e1();
    e1.regionEntities!.forEach((ids, i) => {
      const r = resolveRegionRef(after, ids, e1.regionHoleEntities![i], null);
      expect(r && pointInRegion(centres[i]!, r), `area ${i}`).toBe(true);
    });
  });
});

describe("an extrude that starts from or runs up to a corner of the shape keeps that corner", () => {
  // The #41 start and up-to points name a rectangle corner by the rectangle's
  // id and the corner's index (types.ts ExtrudeRef). Explode keeps the id on
  // the bottom line, which has only ends 0 and 1, so an extrude that ran up to
  // corner 3 failed at Finish with "the sketch point it runs up to isn't on
  // its curve any more" and its body was gone (integration check 2b). Its
  // profile was on ANOTHER sketch, so re-pointing only the extrudes built on
  // this one would not have reached it.
  const pointRef = (k: number) => ({ kind: "sketchPoint" as const, sketch: "f1", entity: "R", pointIndex: k });
  const others = (): Feature[] => [
    { id: "f0", type: "sketch", plane: "XZ", entities: [{ type: "circle", id: "c0", x: 0, y: 0, radius: 5 }] },
    { id: "x4", type: "extrude", sketch: "f0", distance: 5, operation: "new", upToRef: pointRef(3) },
    { id: "x5", type: "extrude", sketch: "f0", distance: 5, operation: "new", startFrom: pointRef(2), upToRef: pointRef(1) },
  ] as unknown as Feature[];
  const ext = (doc: ReturnType<typeof onDocument>, id: string) =>
    doc.store.document.features.find((f): f is Extrude => f.id === id && f.type === "extrude")!;
  /** where a sketchPoint reference lands in f1 as the document has it now,
   *  by the numbering the build reads it with (sidecar _sketch_ref_xy) */
  const landsAt = (doc: ReturnType<typeof onDocument>, ref: Extrude["upToRef"] | Extrude["startFrom"]) => {
    if (ref?.kind !== "sketchPoint") return null;
    const f1 = doc.store.document.features.find((f) => f.id === "f1") as { entities: ResolvedEntity[] };
    const e = f1.entities.find((x) => x.id === ref.entity);
    const p = e && dimRefPoints(e).find((q) => q.p === ref.pointIndex)?.pos;
    return p ? [p.x, p.y] : null;
  };
  const corner = (k: number) => { const c = rectCorners(30, 25, 60, 50)[k]!; return [c.x, c.y]; };

  it("Explode to lines re-points every such extrude at Finish, on whatever sketch its profile is, and one undo takes it back", async () => {
    const doc = onDocument([RECT()], {}, [], others());
    rightClick(doc, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await doc.settle();
    doc.finish();
    expect(landsAt(doc, ext(doc, "x4").upToRef), "x4 runs up to corner 3").toEqual(corner(3));
    expect(landsAt(doc, ext(doc, "x5").startFrom), "x5 starts from corner 2").toEqual(corner(2));
    expect(landsAt(doc, ext(doc, "x5").upToRef), "x5 runs up to corner 1").toEqual(corner(1));
    expect((ext(doc, "x4").upToRef as { entity: string }).entity, "a line other than the one that kept the id").not.toBe("R");

    doc.store.undo();
    expect(ext(doc, "x4").upToRef).toEqual(pointRef(3));
    expect(ext(doc, "x5").startFrom).toEqual(pointRef(2));
    expect(ext(doc, "x5").upToRef).toEqual(pointRef(1));
  });

  it("so does a Fillet on two of its sides, which explodes it first: the corners it did not round stay exactly where they were", async () => {
    const doc = onDocument([RECT()], {}, [], others());
    const box = withBox(doc);
    doc.s.tool = "fillet";
    doc.click(40, 0); // the bottom side
    doc.click(60, 30); // the right side: they meet at corner 1
    box.enter("radius", "5");
    await doc.settle();
    doc.finish();
    expect(landsAt(doc, ext(doc, "x4").upToRef)).toEqual(corner(3));
    expect(landsAt(doc, ext(doc, "x5").startFrom)).toEqual(corner(2));
    // the rounded corner is gone: its reference follows the right side's
    // line to where the rounding starts, as on a corner drawn with Line
    const rounded = landsAt(doc, ext(doc, "x5").upToRef)!;
    expect(rounded[0]).toBeCloseTo(60, 6);
    expect(rounded[1]).toBeCloseTo(5, 6);
  });

  it("an explode undone inside the sketch re-points nothing", async () => {
    const doc = onDocument([RECT()], {}, [], others());
    rightClick(doc, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await doc.settle();
    expect(doc.s.undoEdit()).toBe(true);
    await doc.settle();
    doc.finish();
    expect(ext(doc, "x4").upToRef).toEqual(pointRef(3));
    expect(ext(doc, "x5").startFrom).toEqual(pointRef(2));
  });

  // A SIDE is named `R~k` (entityDims.lineOperand), and after an explode `R`
  // is the bottom line, which has no side 2: the build said "the sketch line
  // it runs up to was deleted from its sketch".
  const sideRef = (k: number) => ({ kind: "sketchLine" as const, sketch: "f1", entity: `R~${k}` });
  const onSides = (): Feature[] => [
    { id: "f0", type: "sketch", plane: "XZ", entities: [{ type: "circle", id: "c0", x: 0, y: 0, radius: 5 }] },
    { id: "x6", type: "extrude", sketch: "f0", distance: 5, operation: "new", startFrom: sideRef(0), upToRef: sideRef(2) },
  ] as unknown as Feature[];
  /** the line a sketchLine reference lies on in f1 as the document has it now,
   *  as a point and a unit direction (a fillet trims a side, not its line) */
  const lineOf = (doc: ReturnType<typeof onDocument>, ref: Extrude["upToRef"] | Extrude["startFrom"]) => {
    if (ref?.kind !== "sketchLine") return null;
    const f1 = doc.store.document.features.find((f) => f.id === "f1") as { entities: ResolvedEntity[] };
    const seg = lineOperand(new Map(f1.entities.map((e) => [e.id, e])), ref.entity);
    if (!seg) return null;
    const n = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    const dx = (seg.x2 - seg.x1) / n, dy = (seg.y2 - seg.y1) / n;
    const r6 = (v: number) => +v.toFixed(6) + 0; // + 0: no -0
    // where the line crosses the axis it is not parallel to, and its direction up to sign
    const at = Math.abs(dx) > Math.abs(dy) ? seg.y1 - (seg.x1 * dy) / dx : seg.x1 - (seg.y1 * dx) / dy;
    return { at: r6(at), dir: [r6(Math.abs(dx)), r6(Math.abs(dy))] };
  };

  it("an extrude that starts from or runs up to a SIDE keeps that side through Explode and Fillet", async () => {
    const before = onDocument([RECT()], {}, [], onSides());
    const bottom = lineOf(before, sideRef(0)), top = lineOf(before, sideRef(2));
    expect(top, "precondition: R~2 is the top side, y = 50").toEqual({ at: 50, dir: [1, 0] });
    expect(bottom).toEqual({ at: 0, dir: [1, 0] });

    const doc = onDocument([RECT()], {}, [], onSides());
    rightClick(doc, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await doc.settle();
    doc.finish();
    expect(lineOf(doc, ext(doc, "x6").upToRef), "x6 runs up to the top side").toEqual(top);
    expect(lineOf(doc, ext(doc, "x6").startFrom), "x6 starts from the bottom side").toEqual(bottom);
    expect((ext(doc, "x6").upToRef as { entity: string }).entity, "a line of its own, not a side of a shape").not.toContain("~");
    doc.store.undo();
    expect(ext(doc, "x6").upToRef).toEqual(sideRef(2));
    expect(ext(doc, "x6").startFrom).toEqual(sideRef(0));

    // Fillet rounds corner 1 between the bottom and the right side: both are
    // trimmed, and stay on their lines
    const filleted = onDocument([RECT()], {}, [], onSides());
    const box = withBox(filleted);
    filleted.s.tool = "fillet";
    filleted.click(40, 0);
    filleted.click(60, 30);
    box.enter("radius", "5");
    await filleted.settle();
    filleted.finish();
    expect(lineOf(filleted, ext(filleted, "x6").upToRef)).toEqual(top);
    expect(lineOf(filleted, ext(filleted, "x6").startFrom)).toEqual(bottom);
  });

  const profile = { id: "f0", type: "sketch", plane: "XZ", entities: [{ type: "circle", id: "c0", x: 0, y: 0, radius: 5 }] };

  // The CENTRE is point 4, and it is no end of any line the rectangle becomes.
  // Explode made a point for it only when a CONSTRAINT named it, so an extrude
  // up to it went red at Finish: "the sketch point it runs up to isn't on its
  // curve any more".
  it("an extrude that runs up to the CENTRE keeps it through Explode and Fillet, and nothing else gets a centre point", async () => {
    const onCentre = (): Feature[] => [
      profile,
      { id: "x7", type: "extrude", sketch: "f0", distance: 5, operation: "new", upToRef: pointRef(4) },
    ] as unknown as Feature[];
    const doc = onDocument([RECT()], {}, [], onCentre());
    rightClick(doc, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await doc.settle();
    doc.finish();
    expect(landsAt(doc, ext(doc, "x7").upToRef), "x7 runs up to the centre").toEqual([30, 25]);
    doc.store.undo();
    expect(ext(doc, "x7").upToRef).toEqual(pointRef(4));

    const filleted = onDocument([RECT()], {}, [], onCentre());
    const box = withBox(filleted);
    filleted.s.tool = "fillet";
    filleted.click(40, 0);
    filleted.click(60, 30);
    box.enter("radius", "5");
    await filleted.settle();
    filleted.finish();
    const c = landsAt(filleted, ext(filleted, "x7").upToRef)!;
    expect(c[0]).toBeCloseTo(30, 6);
    expect(c[1]).toBeCloseTo(25, 6);

    // corners only: the explode is what it was, four lines and nothing more
    const plain = onDocument([RECT()], {}, [], others());
    rightClick(plain, 30, 0).find((i) => i.label === t("sketch.menu.explode"))!.onClick!();
    await plain.settle();
    expect(plain.s.entities.filter((e) => !isOriginGeometry(e.id)).map((e) => e.type)).toEqual(["line", "line", "line", "line"]);
  });

  // Trim gives every piece a new id, a rectangle's untouched sides too, so an
  // extrude up to a side or a corner still drawn said "was deleted from its
  // sketch" at Finish. Two trims in a row: the second retires a line the
  // first one made, and takes away the end the first put corner 3 on.
  it("an extrude that names a side or a corner keeps it through two Trims in a row, and one undo takes it back", async () => {
    const CROSS = () => L("cross", 30, -10, 30, 60);
    const refs = (): Feature[] => [
      profile,
      { id: "x8", type: "extrude", sketch: "f0", distance: 5, operation: "new", startFrom: pointRef(1), upToRef: sideRef(2) },
      { id: "x9", type: "extrude", sketch: "f0", distance: 5, operation: "new", startFrom: sideRef(1), upToRef: pointRef(3) },
    ] as unknown as Feature[];
    const before = onDocument([RECT(), CROSS()], {}, [], refs());
    const top = lineOf(before, sideRef(2)), right = lineOf(before, sideRef(1));
    expect(right, "precondition: R~1 is the right side, x = 60").toEqual({ at: 60, dir: [0, 1] });

    const doc = onDocument([RECT(), CROSS()], {}, [], refs());
    doc.s.tool = "trim";
    doc.click(15, 0); // the bottom side's left half
    await doc.settle();
    doc.click(15, 50); // the top side's left half: a line the first trim made
    await doc.settle();
    expect(doc.s.entities.some((e) => e.type === "rectangle"), "precondition: the rectangle is lines now").toBe(false);
    doc.finish();
    expect(lineOf(doc, ext(doc, "x8").upToRef), "x8 runs up to the top side").toEqual(top);
    expect(landsAt(doc, ext(doc, "x8").startFrom), "x8 starts from corner 1").toEqual(corner(1));
    expect(lineOf(doc, ext(doc, "x9").startFrom), "x9 starts from the right side").toEqual(right);
    expect(landsAt(doc, ext(doc, "x9").upToRef), "x9 runs up to corner 3, the left side's end now").toEqual(corner(3));

    doc.store.undo();
    expect(ext(doc, "x8").upToRef).toEqual(sideRef(2));
    expect(ext(doc, "x9").upToRef).toEqual(pointRef(3));
  });

  it("so does an extrude up to a line or its end through Break", async () => {
    const lineRef = { kind: "sketchLine" as const, sketch: "f1", entity: "ln" };
    const endRef = { kind: "sketchPoint" as const, sketch: "f1", entity: "ln", pointIndex: 1 };
    const doc = onDocument([L("ln", 0, 10, 60, 10)], {}, [], [
      profile,
      { id: "x10", type: "extrude", sketch: "f0", distance: 5, operation: "new", startFrom: endRef, upToRef: lineRef },
    ] as unknown as Feature[]);
    doc.s.tool = "break";
    doc.click(20, 10);
    await doc.settle();
    expect(doc.s.entities.filter((e) => !isOriginGeometry(e.id)), "precondition: two pieces").toHaveLength(2);
    doc.finish();
    expect(lineOf(doc, ext(doc, "x10").upToRef)).toEqual({ at: 10, dir: [1, 0] });
    expect(landsAt(doc, ext(doc, "x10").startFrom)).toEqual([60, 10]);
  });

  // A new side count renumbers a polygon's corners and sides: a hexagon's
  // corner 1 is a dodecagon's corner 2. A constraint on it is re-aimed
  // (rebindPolygonSides); an extrude kept its index and went to whatever
  // corner 1 was now, without a word.
  it("an extrude that names a polygon's corner or side is re-aimed when its side count is edited, as a constraint is", async () => {
    const cornerRef = (k: number) => ({ kind: "sketchPoint" as const, sketch: "f1", entity: "P", pointIndex: k });
    const polySide = (k: number) => ({ kind: "sketchLine" as const, sketch: "f1", entity: `P~${k}` });
    const was = dimRefPoints(HEX()).find((q) => q.p === 1)!.pos;
    const doc = onDocument([HEX()], {}, [], [
      profile,
      { id: "x11", type: "extrude", sketch: "f0", distance: 5, operation: "new", startFrom: polySide(1), upToRef: cornerRef(1) },
    ] as unknown as Feature[]);
    const box = withBox(doc);
    const [c0, c1] = dimRefPoints(HEX()).map((q) => q.pos);
    rightClick(doc, (c0!.x + c1!.x) / 2, (c0!.y + c1!.y) / 2).find((i) => i.label === t("sketch.menu.editPolygon"))!.onClick!();
    box.enter("sides", "12");
    await doc.settle();
    doc.finish();
    expect(ext(doc, "x11").upToRef, "the corner at the same angle").toEqual(cornerRef(2));
    const now = landsAt(doc, ext(doc, "x11").upToRef)!;
    expect(now[0]).toBeCloseTo(was.x, 6);
    expect(now[1]).toBeCloseTo(was.y, 6);
    expect(ext(doc, "x11").startFrom, "the side rebindPolygonSides gives a constraint on side 1").toEqual(polySide(3));

    doc.store.undo();
    expect(ext(doc, "x11").upToRef).toEqual(cornerRef(1));
    expect(ext(doc, "x11").startFrom).toEqual(polySide(1));
  });
});

describe("Fillet and Chamfer on a corner something holds", () => {
  it("a corner on the origin stays there: both sides are held through it", async () => {
    // A rectangle drawn from the origin holds its corner there with a
    // Coincident. The fillet moves that corner's point off the corner, and the
    // Coincident used to go with it without a word: the rectangle came loose.
    const cons: SketchConstraint[] = [
      { type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0 },
      { type: "distance", line: "R~0", value: 60 },
      { type: "distance", line: "R~3", value: 50 },
    ];
    const live = liveSketch([RECT()], cons);
    const box = withBox(live);
    live.s.tool = "fillet";
    live.click(30, 0); // the bottom side
    live.click(0, 25); // the left side, which meets it on the origin
    box.enter("radius", "8");
    await live.settle();
    const ls = lines(live.s.entities).filter((l) => !l.id.startsWith("__"));
    const left = ls.find((l) => Math.abs(l.x1) < 1e-9 && Math.abs(l.x2) < 1e-9)!;
    expect(live.s.constraints).toContainEqual({ type: "pointOn", e: ORIGIN_ID, p: 0, curve: "R" });
    expect(live.s.constraints).toContainEqual({ type: "pointOn", e: ORIGIN_ID, p: 0, curve: left.id });
    // (the fillet's two Tangents draw amber on any two lines: planegcs reads a
    // tangent at a shared end as redundant, which this change does not touch)
    expect([...live.s.overIdx].map((i) => live.s.constraints[i]!.type)).toEqual(["tangent2", "tangent2"]);
    // still anchored: pushed 5 mm off, the solve brings both sides back through it
    const pushed = live.s.entities.map((e) => (e.id.startsWith("__") ? e : translated(e, 5, 5, e.id)));
    const r = await compileAndSolve(pushed, live.s.constraints);
    expect(r.conflicts).toEqual([]);
    const xs = lines(r.entities).filter((l) => !l.id.startsWith("__")).flatMap((l) => [l.x1, l.x2]);
    const ys = lines(r.entities).filter((l) => !l.id.startsWith("__")).flatMap((l) => [l.y1, l.y2]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => +v.toFixed(6))).toEqual([0, 60, 0, 50]);
  });

  it("says so when a dimension to the corner will move the shape", async () => {
    const cons: SketchConstraint[] = [
      { type: "p2pDistanceX", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0, value: 30 },
      { type: "p2pDistanceY", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0, value: 0 },
    ];
    const live = liveSketch([{ ...RECT(), x: 60 }], cons); // its corner 0 at (30, 0)
    const box = withBox(live);
    live.s.tool = "fillet";
    live.click(60, 0); // the bottom side
    live.click(30, 25); // the left side
    box.enter("radius", "5");
    await live.settle();
    // X now reaches the end of the arc, 5 further along: one dimension moved
    expect(toasts).toContain(t("sketch.modify.cornerShifted", { count: 1, tool: t("tool.fillet") }));
  });

  it("two sides that never meet are refused at the second pick, which stays open for one that does", async () => {
    const live = liveSketch([RECT()]);
    const box = withBox(live);
    live.s.tool = "fillet";
    live.click(30, 0); // the bottom side
    live.click(30, 50); // the top: opposite, parallel to it
    expect(toasts).toEqual([t("sketch.modify.sidesDoNotMeet", { tool: t("tool.fillet") })]);
    expect(box.dim.isActive).toBe(false);
    live.click(60, 25); // the right side: next to the first
    expect(box.dim.isActive).toBe(true);
    box.enter("radius", "5");
    await live.settle();
    expect(live.s.entities.filter((e) => e.type === "arc")).toHaveLength(1);
  });

  it("refuses two sides of a hexagon with one between them, which meet outside it", () => {
    const live = liveSketch([HEX()]);
    const box = withBox(live);
    live.s.tool = "chamfer";
    const ex = explodeCompound([HEX()], [], 0)!;
    const [a, , c] = lines(ex.entities) as [Line, Line, Line];
    live.click((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2);
    live.click((c.x1 + c.x2) / 2, (c.y1 + c.y2) / 2);
    expect(toasts).toEqual([t("sketch.modify.sidesDoNotMeet", { tool: t("tool.chamfer") })]);
    expect(box.dim.isActive).toBe(false);
    expect(live.s.entities.filter((e) => e.type === "polygon")).toEqual([HEX()]);
  });
});

describe("Rotate refuses a rectangle tied to what is not turning (C8)", () => {
  it("held on the origin and turned about its centre, it is left where it is, and says why", async () => {
    // Its constraints now come along onto its lines, so the corner on the
    // origin would pull the rectangle back: measured, 18.5 degrees for 30
    // typed, and resized, under a note saying it had been rotated.
    const cons: SketchConstraint[] = [{ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 0 }];
    const live = liveSketch([RECT()], cons);
    const box = withBox(live);
    live.s.selected = new Set(["R"]);
    live.s.tool = "rotate";
    live.click(30, 25);
    box.enter("angle", "30");
    await live.settle();
    expect(toasts).toContain(t("sketch.transform.rotateTied"));
    expect(toasts).not.toContain(t("sketch.transform.rectangleToLines", { count: 1 }));
    expect(live.s.entities.filter((e) => e.type === "rectangle")).toEqual([RECT()]);
    expect(live.s.constraints).toEqual(cons);
    expect(live.s.history.canUndo, "nothing happened, so nothing to undo").toBe(false);
  });

  it("turns once what it is tied to is selected too", async () => {
    const cons: SketchConstraint[] = [{ type: "parallel", l1: "R~0", l2: "l" }];
    const ents = [RECT(), L("l", 0, -20, 60, -20)];
    const refused = liveSketch(ents, cons);
    const box1 = withBox(refused);
    refused.s.selected = new Set(["R"]);
    refused.s.tool = "rotate";
    refused.click(30, 25);
    box1.enter("angle", "30");
    await refused.settle();
    expect(toasts).toContain(t("sketch.transform.rotateTied"));

    toasts.length = 0;
    const live = liveSketch(ents, cons);
    const box = withBox(live);
    live.s.selected = new Set(["R", "l"]);
    live.s.tool = "rotate";
    live.click(30, 25);
    box.enter("angle", "30");
    await live.settle();
    expect(toasts).not.toContain(t("sketch.transform.rotateTied"));
    const bottom = byId(live.s.entities, "R") as Line;
    expect((Math.atan2(bottom.y2 - bottom.y1, bottom.x2 - bottom.x1) * 180) / Math.PI).toBeCloseTo(30, 6);
  });

  it("refuses too when the tie is on a line selected with it, which would drag it back", async () => {
    const cons: SketchConstraint[] = [
      { type: "parallel", l1: "R~0", l2: "l" },
      { type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "l", p2: 0 },
    ];
    const live = liveSketch([RECT(), L("l", 0, 0, -40, 0)], cons); // from the origin, away from the rectangle
    const box = withBox(live);
    live.s.selected = new Set(["R", "l"]);
    live.s.tool = "rotate";
    live.click(30, 25);
    box.enter("angle", "30");
    await live.settle();
    expect(toasts).toContain(t("sketch.transform.rotateTied"));
    expect(live.s.entities.filter((e) => e.type === "rectangle")).toEqual([RECT()]);
  });
});
