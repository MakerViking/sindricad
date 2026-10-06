// Perpendicular and tangent inference while drawing (decision B7, GitHub #17),
// and the corners inside one chain of lines joined by a real coincident.
//
// Moi455 on #17: "Lack of auto-inference for basic constraints while drawing:
// coincidence (e.g., centering a circle on a line), verticality,
// horizontality, and perpendicularity (right angle)." And the public reply
// that promised the rest: "Corners inside one continuous chain of lines are
// placed on each other but not constrained yet. That's next."
//
// Thomas's decisions: within 3 degrees like H/V; H/V wins over perpendicular;
// a Sketch Palette switch to turn inference off, on by default; line-arc AND
// arc-arc tangency.
//
// The pure rules are tested first. The gestures after them enter where the
// user enters: the canvas pointer handlers and the real snap, on a SketchMode
// whose solve pump and undo history are the real ones (liveSketch.testkit),
// with only what draws stubbed. A constraint is checked the way a drag taught
// the hard way: by DISPLACING geometry in the model and solving, against a
// control solve without the constraint, never by dragging.
import { beforeEach, describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
import * as THREE from "three";
import { SketchMode } from "./sketchMode";
import { SketchPalette } from "../ui/sketchPalette";
import sketchModeSrc from "./sketchMode.ts?raw";
import { liveSketch, PX } from "./liveSketch.testkit";
import { candidatesFromEntities, type ResolvedEntity } from "./snap";
import { compileAndSolve } from "./sketchSolve";
import { circumcenter } from "./arc";
import {
  curvesEndingAt, inferArcTangents, inferLineRelations, type ArcPoints, type JoinedCurve, type LineEnds,
} from "./autoConstrain";
import type { ConstraintGlyph } from "./glyphs";
import type { SketchConstraint } from "../types";

type Line = Extract<ResolvedEntity, { type: "line" }>;
type Arc = Extract<ResolvedEntity, { type: "arc" }>;
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });
const rad = (deg: number) => (deg * Math.PI) / 180;
/** a point `len` from `from` at `deg` degrees */
const polar = (from: { x: number; y: number }, deg: number, len: number) =>
  ({ x: from.x + Math.cos(rad(deg)) * len, y: from.y + Math.sin(rad(deg)) * len });
/** the arc on circle (c, r) from angle a0 to a1 (degrees), through its middle */
const arcOn = (id: string, c: { x: number; y: number }, r: number, a0: number, a1: number): Arc => {
  const s = polar(c, a0, r), e = polar(c, a1, r), m = polar(c, (a0 + a1) / 2, r);
  return { type: "arc", id, x1: s.x, y1: s.y, x2: e.x, y2: e.y, mx: m.x, my: m.y };
};
/** the direction of a line, degrees in [0, 180) */
const heading = (l: LineEnds) => ((Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180) / Math.PI + 360) % 180;
const len = (l: LineEnds) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
/** how far from tangent a line through `at` is to an arc, degrees (0 = tangent) */
function offTangentDeg(l: LineEnds, a: Arc, at: { x: number; y: number }) {
  const c = circumcenter({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: a.mx, y: a.my })!;
  const d = { x: l.x2 - l.x1, y: l.y2 - l.y1 }, r = { x: at.x - c.x, y: at.y - c.y };
  return 90 - (Math.acos(Math.abs(d.x * r.x + d.y * r.y) / Math.hypot(d.x, d.y) / Math.hypot(r.x, r.y)) * 180) / Math.PI;
}
/** the angle between two arcs' tangents where they meet at `at`, degrees */
function arcsKinkDeg(a: Arc, b: Arc, at: { x: number; y: number }) {
  const n = (q: Arc) => {
    const c = circumcenter({ x: q.x1, y: q.y1 }, { x: q.x2, y: q.y2 }, { x: q.mx, y: q.my })!;
    return { x: at.x - c.x, y: at.y - c.y };
  };
  const p = n(a), q = n(b);
  return (Math.acos(Math.min(1, Math.abs(p.x * q.x + p.y * q.y) / Math.hypot(p.x, p.y) / Math.hypot(q.x, q.y))) * 180) / Math.PI;
}
const quietly = async <T>(f: () => Promise<T>): Promise<T> => {
  const log = console.log; // planegcs narrates every solve
  console.log = () => {};
  try { return await f(); } finally { console.log = log; }
};

// --- the rules, pure --------------------------------------------------------

describe("which curves meet a new entity's end", () => {
  it("lines and arcs ending there, with their direction there; not ones passing through", () => {
    const at = { x: 10, y: 0 };
    const found = curvesEndingAt([
      line("a", 0, 0, 10, 0), // ends here
      line("b", 10, 0, 10, 5), // starts here
      line("c", 5, -5, 15, 5), // passes through, ends elsewhere
      arcOn("d", { x: 10, y: 5 }, 5, -90, 0), // starts here, heading along +x
      { type: "rectangle", id: "R", x: 15, y: 5, width: 10, height: 10 }, // a corner here, no curve of its own
      line("self", 10, 0, 20, 20),
    ], at, "self");
    expect(found.map((c) => c.id)).toEqual(["a", "b", "d"]);
    const d = found.find((c) => c.id === "d")!;
    expect(Math.abs(d.dir.y), "an arc's direction at its end is its tangent there").toBeLessThan(1e-12);
  });
});

describe("a line drawn from a joint", () => {
  const along = (deg: number): JoinedCurve[] => [{ id: "o", kind: "line", dir: { x: Math.cos(rad(deg)), y: Math.sin(rad(deg)) } }];
  const from = (deg: number, length = 20): LineEnds => {
    const e = polar({ x: 0, y: 0 }, deg, length);
    return { x1: 0, y1: 0, x2: e.x, y2: e.y };
  };

  it("square to the line it starts on, within 3 degrees: perpendicular, turned about the joint, its length kept", () => {
    const r = inferLineRelations(from(120 + 2.5), { startPinned: true, atStart: along(30) });
    expect(r.relations).toEqual([{ type: "perpendicular", other: "o" }]);
    expect(r.moved).toBe("end");
    expect(r.ends.x1).toBe(0);
    expect(r.ends.y1).toBe(0);
    expect(heading(r.ends)).toBeCloseTo(120, 9);
    expect(len(r.ends)).toBeCloseTo(20, 9);
  });

  it("past 3 degrees: nothing", () => {
    expect(inferLineRelations(from(120 + 3.2), { startPinned: true, atStart: along(30) }).relations).toEqual([]);
  });

  it("H/V wins: a line square to a horizontal one is made vertical, never also perpendicular", () => {
    const r = inferLineRelations(from(91), { startPinned: true, atStart: along(0) });
    expect(r.relations).toEqual([{ type: "vertical" }]);
  });

  it("H/V wins even where the other line is only nearly horizontal, so nothing already drawn turns", () => {
    // a perpendicular as well would rotate `o` by its 1 degree to suit
    const r = inferLineRelations(from(90.5), { startPinned: true, atStart: along(1) });
    expect(r.relations).toEqual([{ type: "vertical" }]);
  });

  it("joined at its END: the start turns about it", () => {
    const e = polar({ x: 0, y: 0 }, 180 + 122, 20); // drawn towards the joint at the origin
    const r = inferLineRelations({ x1: e.x, y1: e.y, x2: 0, y2: 0 }, { endPinned: true, atEnd: along(30) });
    expect(r.relations).toEqual([{ type: "perpendicular", other: "o" }]);
    expect(r.moved).toBe("start");
    expect([r.ends.x2, r.ends.y2]).toEqual([0, 0]);
    expect(heading(r.ends)).toBeCloseTo(120, 9);
  });

  it("joined at both ends: left alone, as H/V leaves it", () => {
    const r = inferLineRelations(from(121), { startPinned: true, endPinned: true, atStart: along(30) });
    expect(r.relations).toEqual([]);
  });

  it("a curve at an end that is not pinned is not a joint", () => {
    expect(inferLineRelations(from(121), { atStart: along(30) }).relations).toEqual([]);
  });

  it("along an arc's tangent: tangent, either sense", () => {
    const arc: JoinedCurve[] = [{ id: "a", kind: "arc", dir: { x: Math.cos(rad(40)), y: Math.sin(rad(40)) } }];
    for (const deg of [41.5, 220 - 2]) {
      const r = inferLineRelations(from(deg), { startPinned: true, atStart: arc });
      expect(r.relations, `drawn at ${deg} degrees`).toEqual([{ type: "tangent", other: "a" }]);
      expect(Math.abs(Math.sin(rad(heading(r.ends) - 40)))).toBeLessThan(1e-12);
    }
  });

  it("a tangent that already holds rides along with H/V; one that would turn the arc does not", () => {
    const flat: JoinedCurve[] = [{ id: "a", kind: "arc", dir: { x: 1, y: 0 } }];
    expect(inferLineRelations(from(1), { startPinned: true, atStart: flat }).relations)
      .toEqual([{ type: "horizontal" }, { type: "tangent", other: "a" }]);
    const tilted: JoinedCurve[] = [{ id: "a", kind: "arc", dir: { x: Math.cos(rad(2)), y: Math.sin(rad(2)) } }];
    expect(inferLineRelations(from(1), { startPinned: true, atStart: tilted }).relations).toEqual([{ type: "horizontal" }]);
  });
});

describe("a 3-point arc drawn from a joint", () => {
  // the line runs along +x into (10, 0); an arc from there up to (20, 10)
  const L: JoinedCurve[] = [{ id: "L", kind: "line", dir: { x: 1, y: 0 } }];
  const drawn = (through: { x: number; y: number }): ArcPoints => ({ x1: 10, y1: 0, x2: 20, y2: 10, mx: through.x, my: through.y });
  // the exact quarter round through those ends has its centre at (10, 10)
  const onQuarter = (deg: number) => polar({ x: 10, y: 10 }, deg, 10);

  it("leaving the line within 3 degrees: tangent, its ends kept and its bulge made exact", () => {
    // the quarter's middle is at -45 degrees; a through-point a little off it
    const r = inferArcTangents(drawn({ x: onQuarter(-45).x + 0.15, y: onQuarter(-45).y - 0.1 }), { atStart: L });
    expect(r.tangents).toEqual(["L"]);
    expect([r.arc.x1, r.arc.y1, r.arc.x2, r.arc.y2]).toEqual([10, 0, 20, 10]);
    const c = circumcenter({ x: r.arc.x1, y: r.arc.y1 }, { x: r.arc.x2, y: r.arc.y2 }, { x: r.arc.mx, y: r.arc.my })!;
    expect(c.x).toBeCloseTo(10, 9);
    expect(c.y).toBeCloseTo(10, 9);
  });

  it("bulging well off tangent: nothing", () => {
    const flat = drawn({ x: 15.7, y: 4.3 }); // a much shallower arc than the quarter
    const r = inferArcTangents(flat, { atStart: L });
    expect(r.tangents).toEqual([]);
    expect(r.arc).toEqual(flat);
  });

  it("an arc bulging the long way round keeps going the long way, wherever it is drawn", () => {
    // Off the axes on purpose: the arc's middle is found from the centre, and
    // an exact half-round there has its centre ON the chord.
    const turn = (p: { x: number; y: number }) => {
      const c = Math.cos(rad(37)), s = Math.sin(rad(37));
      return { x: 3 + p.x * c - p.y * s, y: -2 + p.x * s + p.y * c };
    };
    const P = turn({ x: 10, y: 0 }), Q = turn({ x: 14, y: 4 }), user = turn({ x: 7.3, y: 6.9 });
    const dir = { x: Math.cos(rad(37)), y: Math.sin(rad(37)) }; // the line's +x, turned
    const r = inferArcTangents({ x1: P.x, y1: P.y, x2: Q.x, y2: Q.y, mx: user.x, my: user.y }, {
      atStart: [{ id: "L", kind: "line", dir }],
    });
    expect(r.tangents).toEqual(["L"]);
    // the exact circle has its centre at (10, 4), radius 4: the long way round
    // passes through its point at 135 degrees, not the short way's -45
    const far = turn(polar({ x: 10, y: 4 }, 135, 4));
    expect(Math.hypot(r.arc.mx - far.x, r.arc.my - far.y)).toBeLessThan(1e-9);
  });

  it("a half round between two parallel lines is tangent to both", () => {
    // turned off the axes: the centre of an exact half round sits ON its
    // chord, which is no direction at all to find the arc's middle along
    const c = Math.cos(rad(37)), sn = Math.sin(rad(37));
    const turn = (p: { x: number; y: number }) => ({ x: 3 + p.x * c - p.y * sn, y: -2 + p.x * sn + p.y * c });
    const P = turn({ x: 10, y: 0 }), Q = turn({ x: 10, y: 10 }), user = turn({ x: 15.1, y: 5.2 });
    const r = inferArcTangents({ x1: P.x, y1: P.y, x2: Q.x, y2: Q.y, mx: user.x, my: user.y }, {
      atStart: [{ id: "L", kind: "line", dir: { x: c, y: sn } }],
      atEnd: [{ id: "B", kind: "line", dir: { x: -c, y: -sn } }],
    });
    expect(r.tangents).toEqual(["L", "B"]);
    const mid = turn({ x: 15, y: 5 });
    expect(Math.hypot(r.arc.mx - mid.x, r.arc.my - mid.y)).toBeLessThan(1e-9);
  });
});

// --- the solver: a tangent at a shared end ---------------------------------
//
// What every tangent inferred here is: a Tangent between two curves that also
// share an end. planegcs's tangent_la / tangent_aa are degenerate there (the
// touch is a maximum of the distance they measure), so it read every one as
// redundant. sketchSolve compiles it to angle_via_point instead, at 0 or pi
// chosen from the geometry as it stands, and getting that choice wrong for any
// orientation folds the curve over to the cusp.

describe("a Tangent where two curves meet", () => {
  // a line along +x into (10, 0) or out of it, and an arc leaving (10, 0)
  const lineIn = line("L", 0, 0, 10, 0), lineOut = line("L", 10, 0, 0, 0);
  const arcs: [string, Arc][] = [
    ["counter-clockwise", arcOn("A", { x: 10, y: 5 }, 5, -90, 0)],
    ["clockwise", arcOn("A", { x: 10, y: 5 }, 5, 0, -90)],
    ["on the other side", arcOn("A", { x: 10, y: -5 }, 5, 90, 0)],
  ];
  const cases: [string, ResolvedEntity[], SketchConstraint[]][] = [];
  for (const [ln, l] of [["into the joint", lineIn], ["out of it", lineOut]] as const) {
    for (const [an, a] of arcs) {
      const lp = l.x2 === 10 ? 1 : 0, ap = a.x1 === 10 && Math.abs(a.y1) < 1e-9 ? 0 : 1;
      for (const order of ["line first", "arc first"]) {
        const tangent: SketchConstraint = order === "line first" ? { type: "tangent2", a: "L", b: "A" } : { type: "tangent2", a: "A", b: "L" };
        cases.push([`a line ${ln}, an arc ${an}, ${order}`, [l, a], [{ type: "coincident", e1: "L", p1: lp, e2: "A", p2: ap }, tangent]]);
      }
    }
  }
  // arc to arc at (15, 5): an S, an S the other way round, and one inside the other
  const A = arcOn("A", { x: 10, y: 5 }, 5, -90, 0);
  for (const [name, B] of [
    ["an S", arcOn("B", { x: 20, y: 5 }, 5, 180, 90)],
    ["an S the other way", arcOn("B", { x: 20, y: 5 }, 5, 180, 270)],
    ["one inside the other", arcOn("B", { x: 12.5, y: 5 }, 2.5, 0, 90)],
  ] as const) {
    cases.push([`arc to arc, ${name}`, [A, B], [{ type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 }, { type: "tangent2", a: "B", b: "A" }]]);
  }

  it.each(cases)("%s: holds as drawn, takes one freedom, and is not amber", async (_name, ents, cons) => {
    const joined = await quietly(() => compileAndSolve(ents, [cons[0]!]));
    const r = await quietly(() => compileAndSolve(ents, cons));
    expect(r.ok).toBe(true);
    expect(r.overDefined, "the tangent is read as redundant").toEqual([]);
    expect(r.dof, "the tangent took no freedom away").toBe(joined.dof - 1);
    let moved = 0;
    r.entities.forEach((e, i) => {
      const was = ents[i] as unknown as Record<string, number>, now = e as unknown as Record<string, number>;
      for (const k of ["x1", "y1", "x2", "y2", "mx", "my"]) if (k in was) moved = Math.max(moved, Math.abs(now[k]! - was[k]!));
    });
    expect(moved, "a tangent join was folded over to reach the other angle").toBeLessThan(1e-9);
  });
});

// --- the gestures ---------------------------------------------------------

/** A live SketchMode with `ents` drawn, `tool` armed and the REAL snap over
 *  the real candidates. `typed` is what the user has typed into the dim box. */
function drawing(tool: "line" | "arc", ents: ResolvedEntity[], typed: Record<string, number> = {}) {
  const live = liveSketch(ents);
  const s = live.s as unknown as Record<string, unknown>;
  let badges: ConstraintGlyph[] = [];
  let commitBox: (() => void) | null = null;
  const proto = SketchMode.prototype as unknown as { snapAt: unknown };
  Object.assign(s, {
    tool,
    snapAt: proto.snapAt, // liveSketch stubs it out; these tests are about what a snap joins
    gridSnap: false,
    // what the real one does that a draw depends on: the next click snaps to
    // what was just drawn, and a solve in flight learns the list changed
    refreshActive(this: { candidates: unknown; entities: ResolvedEntity[]; entityVersion: number }) {
      this.entityVersion++;
      this.candidates = candidatesFromEntities(this.entities);
    },
    glyphsVisible: true,
    glyphs: {
      setInteractive() {},
      show: (g: ConstraintGlyph[]) => { badges = g; },
      hide: () => { badges = []; },
      follow: () => true,
    },
    dim: {
      isActive: false,
      isUserDriven: (n: string) => n in typed,
      getValue: (n: string) => typed[n] ?? null,
      show: (_defs: unknown, commit: () => void) => { commitBox = commit; },
      hide() {},
      updateFromCursor() {},
      position() {},
      placeAt() {},
    },
    entityCurve: () => ({}),
    base: null, chainStart: null, basePinned: false, baseRef: null,
    lastSnapKind: "free", lastSnapRef: null, lastCursor: new THREE.Vector2(),
    arcStart: null, arcEnd: null, arcStartRef: null, arcEndRef: null, arcCenterRef: null, clickPts: [], arcSweep: 0,
    splinePts: [],
  });
  (s.refreshActive as () => void).call(s);
  Object.assign(s.viewport as object, {
    screenToPlane: (x: number, y: number) => new THREE.Vector3(x / PX, y / PX, 0),
    projectToScreen: (w: THREE.Vector3) => ({ x: w.x * PX, y: w.y * PX }),
  });
  const h = live.s;
  return {
    h,
    click: (p: { x: number; y: number }) => live.press(p.x, p.y),
    hover: (p: { x: number; y: number }) => live.move(p.x, p.y),
    /** Enter in the dim box: what the user does after typing a value */
    enter: () => commitBox?.(),
    // by id: a solve writes every entity back as a new object
    drawn: () => h.entities.filter((e) => !e.id.startsWith("__") && !ents.some((g) => g.id === e.id)),
    /** the badges on screen: real ones and the pending one the next click would add */
    badges: () => badges.map((b) => (b.pending ? `(${b.label})` : b.label)),
    inferred: () => h.constraints.filter((c) => c.type !== "coincident"),
    settle: () => quietly(live.settle),
  };
}

const byId = <T extends ResolvedEntity>(es: ResolvedEntity[], id: string) => es.find((e) => e.id === id) as T;

beforeEach(() => { toasts.length = 0; });

describe("drawing a chain of lines", () => {
  it("joins every corner inside the chain with a coincident, and the joint holds when one side is moved", async () => {
    const d = drawing("line", []);
    d.click({ x: 3, y: 2 }); // clear of the origin, which would snap and join too
    d.click({ x: 20, y: 7 });
    d.click({ x: 31, y: 25 });
    const [a, b] = d.drawn() as Line[];
    expect(b, "the third click committed no second segment").toBeDefined();
    expect(d.h.constraints.filter((c) => c.type === "coincident")).toEqual([
      { type: "coincident", e1: a!.id, p1: 1, e2: b!.id, p2: 0 },
    ]);

    // pull the second segment's start 1 mm off the corner, then solve
    const moved = d.h.entities.map((e) => (e.id === b!.id ? { ...e, x1: b!.x1 + 1, y1: b!.y1 - 1 } : e));
    const fixed = await quietly(() => compileAndSolve(moved, d.h.constraints));
    const control = await quietly(() => compileAndSolve(moved, []));
    const gap = (es: ResolvedEntity[]) => {
      const p = byId<Line>(es, a!.id), q = byId<Line>(es, b!.id);
      return Math.hypot(p.x2 - q.x1, p.y2 - q.y1);
    };
    expect(gap(fixed.entities)).toBeLessThan(1e-6);
    expect(gap(control.entities), "the control closed the gap too: this oracle measures nothing").toBeGreaterThan(1);
  });
});

describe("perpendicular, drawn", () => {
  it("a chain's next segment drawn square to the last within 3 degrees is made square and constrained", async () => {
    // a 30 degree first segment, then one at 122 degrees: 2 off square
    const d = drawing("line", []);
    const p0 = { x: 3, y: 2 }, p1 = polar(p0, 30, 20), p2 = polar(p1, 122, 15);
    d.click(p0);
    d.click(p1);
    d.hover(p2);
    expect(d.badges(), "no pending badge before the click").toContain("(⊥)");
    d.click(p2);
    const [a, b] = d.drawn() as Line[];
    expect(d.inferred()).toEqual([{ type: "perpendicular", l1: b!.id, l2: a!.id }]);
    expect(heading(b!)).toBeCloseTo(120, 9);
    expect(len(b!), "the length the user drew").toBeCloseTo(15, 9);
    expect([b!.x1, b!.y1], "the corner moved").toEqual([a!.x2, a!.y2]);

    await d.settle();
    expect(toasts, "the solve failed").toEqual([]);
    expect(d.h.solverDead, "the solver was turned off").toBe(false);
    expect([...d.h.overIdx], "drawn amber").toEqual([]);
    expect(d.badges()).toContain("⊥");

    // turn the second segment 10 degrees about the corner, then solve
    const off = polar(p1, 130, 15);
    const moved = d.h.entities.map((e) => (e.id === b!.id ? { ...e, x2: off.x, y2: off.y } : e));
    const fixed = await quietly(() => compileAndSolve(moved, d.h.constraints));
    const control = await quietly(() => compileAndSolve(moved, d.h.constraints.filter((c) => c.type !== "perpendicular")));
    const square = (es: ResolvedEntity[]) => Math.abs(heading(byId<Line>(es, b!.id)) - heading(byId<Line>(es, a!.id)) - 90);
    expect(square(fixed.entities)).toBeLessThan(1e-6);
    expect(square(control.entities), "the control squared it too: this oracle measures nothing").toBeGreaterThan(5);
  });

  it("a segment clicked while the last one's solve is still running leaves the solver on", async () => {
    // The first segment's Horizontal starts a solve, and the next click lands
    // before it returns. The line it pushes used to reach the solver's
    // write-back uncompiled, which threw and turned constraint solving off
    // for the rest of the session. With every chain corner joined, every
    // segment of a chain starts a solve, so this is two quick clicks.
    const d = drawing("line", []);
    d.click({ x: 3, y: 2 });
    d.click({ x: 23, y: 2.4 });
    d.click({ x: 31, y: 20 });
    await d.settle();
    expect(d.h.solverDead, "the solver was turned off").toBe(false);
    expect(toasts).toEqual([]);
    expect(d.drawn()).toHaveLength(2);
  });

  it("H/V wins: square to a horizontal segment and within 3 degrees of vertical is Vertical only", () => {
    const d = drawing("line", []);
    d.click({ x: 3, y: 2 });
    d.click({ x: 23, y: 2.4 }); // horizontal, made exact
    d.hover({ x: 23.5, y: 17 }); // 1.9 degrees off vertical
    expect(d.badges(), "the badge promises a perpendicular as well").toEqual(["H", "(V)"]);
    d.click({ x: 23.5, y: 17 });
    const [a, b] = d.drawn() as Line[];
    expect(d.inferred()).toEqual([{ type: "horizontal", line: a!.id }, { type: "vertical", line: b!.id }]);
  });

  it("a TYPED length is kept: the segment turns square, it does not stretch", () => {
    const d = drawing("line", [], { length: 10 });
    const p0 = { x: 3, y: 2 }, p1 = polar(p0, 30, 10);
    d.click(p0);
    d.click(polar(p0, 30, 25)); // the cursor runs past; the typed 10 decides
    d.hover(polar(p1, 121.5, 30));
    d.enter();
    const [a, b] = d.drawn() as Line[];
    expect(d.inferred()).toEqual([{ type: "perpendicular", l1: b!.id, l2: a!.id }]);
    expect(len(b!)).toBeCloseTo(10, 9);
    expect(heading(b!)).toBeCloseTo(120, 9);
  });

  it("4 degrees off square: nothing is added and nothing moves", () => {
    const d = drawing("line", []);
    const p0 = { x: 3, y: 2 }, p1 = polar(p0, 30, 20), p2 = polar(p1, 124, 15);
    d.click(p0);
    d.click(p1);
    d.click(p2);
    const [, b] = d.drawn() as Line[];
    expect(d.inferred()).toEqual([]);
    expect(b!.x2).toBeCloseTo(p2.x, 12);
    expect(b!.y2).toBeCloseTo(p2.y, 12);
  });

  it("drawn onto the end of a slanted line: the free start turns, the snapped end stays", () => {
    const o = line("o", 30, 10, 47.32, 20); // 30 degrees, ending at (47.32, 20)
    const d = drawing("line", [o]);
    const start = polar({ x: 47.32, y: 20 }, 120 - 180 - 2, 15); // the end will snap onto o's end
    d.click(start);
    d.click({ x: 47.32, y: 20 });
    const [n] = d.drawn() as Line[];
    expect(d.inferred()).toEqual([{ type: "perpendicular", l1: n!.id, l2: "o" }]);
    expect([n!.x2, n!.y2]).toEqual([47.32, 20]);
    expect(Math.abs(heading(n!) - heading(o) - 90)).toBeLessThan(1e-9);
  });
});

/** centre (10, 10), from -90 to -30 degrees: it leaves (10, 0) along +x and
 *  arrives at (18.66, 5) heading 60 degrees, clear of both axes */
const slanted = () => arcOn("q", { x: 10, y: 10 }, 10, -90, -30);
const slantedEnd = () => polar({ x: 10, y: 10 }, -30, 10);

describe("tangent, drawn", () => {
  // centre (10, 10), from -90 to 0 degrees: it leaves (10, 0) along +x and
  // arrives at (20, 10) heading +y
  const quarter = () => arcOn("q", { x: 10, y: 10 }, 10, -90, 0);

  it("a line drawn on from an arc's end within 3 degrees of its tangent is made tangent, and holds", async () => {
    const d = drawing("line", [slanted()]);
    const at = slantedEnd();
    d.click(at); // the arc's end
    const to = polar(at, 60 + 2.5, 12);
    d.hover(to);
    expect(d.badges()).toEqual(["(T)"]);
    d.click(to);
    const [n] = d.drawn() as Line[];
    expect(d.inferred()).toEqual([{ type: "tangent2", a: n!.id, b: "q" }]);
    expect(d.h.constraints).toContainEqual({ type: "coincident", e1: "q", p1: 1, e2: n!.id, p2: 0 });
    expect(offTangentDeg(n!, slanted(), at)).toBeLessThan(1e-9);
    expect(len(n!)).toBeCloseTo(12, 9);

    await d.settle();
    expect(toasts).toEqual([]);
    expect([...d.h.overIdx], "the inferred tangent is drawn amber").toEqual([]);

    // turn the line 8 degrees about the joint, then solve
    const off = polar(at, 68, 12);
    const moved = d.h.entities.map((e) => (e.id === n!.id ? { ...e, x2: off.x, y2: off.y } : e));
    const fixed = await quietly(() => compileAndSolve(moved, d.h.constraints));
    const control = await quietly(() => compileAndSolve(moved, d.h.constraints.filter((c) => c.type !== "tangent2")));
    const off2 = (r: { entities: ResolvedEntity[] }) =>
      offTangentDeg(byId<Line>(r.entities, n!.id), byId<Arc>(r.entities, "q"), { x: byId<Line>(r.entities, n!.id).x1, y: byId<Line>(r.entities, n!.id).y1 });
    expect(fixed.overDefined).toEqual([]);
    expect(off2(fixed)).toBeLessThan(1e-6);
    expect(off2(control), "the control made it tangent too: this oracle measures nothing").toBeGreaterThan(5);
  });

  it("a 3-point arc started on a line's end, bulging within 3 degrees of it, is made tangent and holds", async () => {
    const L = line("L", 0, 0, 10, 0);
    const d = drawing("arc", [L]);
    d.click({ x: 10, y: 0 }); // L's end
    d.click({ x: 20, y: 10 });
    const near = polar({ x: 10, y: 10 }, -45, 10);
    const through = { x: near.x + 0.1, y: near.y - 0.05 }; // about 1.5 degrees off tangent
    d.hover(through);
    expect(d.badges()).toEqual(["(T)"]);
    d.click(through);
    const [arc] = d.drawn() as Arc[];
    expect(arc?.type, "the third click committed no arc").toBe("arc");
    expect(d.inferred()).toEqual([{ type: "tangent2", a: arc!.id, b: "L" }]);
    expect([arc!.x1, arc!.y1, arc!.x2, arc!.y2], "an end the user placed moved").toEqual([10, 0, 20, 10]);
    expect(Math.hypot(arc!.mx - through.x, arc!.my - through.y), "the bulge was not corrected at all").toBeGreaterThan(0.05);
    expect(offTangentDeg(L, arc!, { x: 10, y: 0 })).toBeLessThan(1e-9);

    await d.settle();
    expect([...d.h.overIdx]).toEqual([]);

    // tilt the line 6 degrees about the joint, then solve
    const tilt = polar({ x: 10, y: 0 }, 180 + 6, 10);
    const moved = d.h.entities.map((e) => (e.id === "L" ? { ...e, x1: tilt.x, y1: tilt.y } : e));
    const fixed = await quietly(() => compileAndSolve(moved, d.h.constraints));
    const control = await quietly(() => compileAndSolve(moved, d.h.constraints.filter((c) => c.type !== "tangent2")));
    const off = (r: { entities: ResolvedEntity[] }) => offTangentDeg(byId<Line>(r.entities, "L"), byId<Arc>(r.entities, arc!.id), { x: byId<Line>(r.entities, "L").x2, y: byId<Line>(r.entities, "L").y2 });
    expect(off(fixed)).toBeLessThan(1e-6);
    expect(off(control)).toBeGreaterThan(3);
  });

  it("an arc drawn on from an arc's end is tangent to it (arc-arc), and holds", async () => {
    const d = drawing("arc", [quarter()]);
    // an S: on from (20, 10) heading +y, curving the other way round (30, 10)
    const S = arcOn("", { x: 30, y: 10 }, 10, 180, 90);
    d.click({ x: 20, y: 10 });
    d.click({ x: S.x2, y: S.y2 });
    d.click({ x: S.mx - 0.2, y: S.my + 0.1 });
    const [arc] = d.drawn() as Arc[];
    expect(d.inferred()).toEqual([{ type: "tangent2", a: arc!.id, b: "q" }]);
    expect(arcsKinkDeg(arc!, quarter(), { x: 20, y: 10 })).toBeLessThan(1e-9);

    await d.settle();
    expect([...d.h.overIdx]).toEqual([]);
    const shove = { x1: arc!.x1, y1: arc!.y1, x2: arc!.x2 + 2, y2: arc!.y2 - 1, mx: arc!.mx + 2, my: arc!.my };
    const moved = d.h.entities.map((e) => (e.id === arc!.id ? { ...e, ...shove } : e));
    const fixed = await quietly(() => compileAndSolve(moved, d.h.constraints));
    const control = await quietly(() => compileAndSolve(moved, d.h.constraints.filter((c) => c.type !== "tangent2")));
    const kink = (r: { entities: ResolvedEntity[] }) => arcsKinkDeg(byId<Arc>(r.entities, arc!.id), byId<Arc>(r.entities, "q"), { x: byId<Arc>(r.entities, "q").x2, y: byId<Arc>(r.entities, "q").y2 });
    expect(kink(fixed)).toBeLessThan(1e-6);
    expect(kink(control)).toBeGreaterThan(3);
  });

  it("a line on from an arc that leaves it horizontally gets Horizontal and Tangent", async () => {
    // centre (10, 10), from 180 to 270 degrees: it ends at (10, 0) heading +x
    const d = drawing("line", [arcOn("q", { x: 10, y: 10 }, 10, 180, 270)]);
    d.click({ x: 10, y: 0 });
    d.click({ x: 25, y: 0.3 });
    const [n] = d.drawn() as Line[];
    expect(d.inferred()).toEqual([{ type: "horizontal", line: n!.id }, { type: "tangent2", a: n!.id, b: "q" }]);
    await d.settle();
    expect([...d.h.overIdx]).toEqual([]);
  });
});

describe("the Sketch Palette's Auto Constrain switch", () => {
  it("is on by default, and SketchMode agrees", () => {
    expect(SketchPalette.defaultFor("autoConstrain")).toBe(true);
    const m = /private\s+autoConstrainOff\s*=\s*(true|false)\s*;/.exec(sketchModeSrc);
    expect(m, "no `private autoConstrainOff = …` in sketchMode.ts: renamed, and this test is blind").toBeTruthy();
    expect(m![1] === "false", "the box and the sketcher disagree about the default").toBe(SketchPalette.defaultFor("autoConstrain"));
  });

  it("off: nothing is inferred and nothing moves, but the joins stay", () => {
    const d = drawing("line", []);
    (d.h as unknown as SketchMode).setAutoConstrain(false);
    const p0 = { x: 3, y: 2 }, p1 = { x: 23, y: 2.4 }, p2 = polar(p1, 92, 15);
    d.click(p0);
    d.click(p1);
    d.hover(p2);
    expect(d.badges(), "a badge promises a constraint with inference off").toEqual([]);
    d.click(p2);
    const [a, b] = d.drawn() as Line[];
    expect(d.inferred()).toEqual([]);
    expect(a!.y2, "the line was straightened").toBeCloseTo(2.4, 12);
    expect(b!.x2).toBeCloseTo(p2.x, 12);
    expect(b!.y2).toBeCloseTo(p2.y, 12);
    expect(d.h.constraints).toEqual([{ type: "coincident", e1: a!.id, p1: 1, e2: b!.id, p2: 0 }]);
  });

  it("back on: the next segment is inferred again", () => {
    const d = drawing("line", []);
    const m = d.h as unknown as SketchMode;
    m.setAutoConstrain(false);
    m.setAutoConstrain(true);
    d.click({ x: 3, y: 2 });
    d.click({ x: 23, y: 2.4 });
    expect(d.inferred().map((c) => c.type)).toEqual(["horizontal"]);
  });
});

describe("undo", () => {
  it("takes a line and everything inferred with it away in ONE step", async () => {
    const d = drawing("line", [slanted()]);
    d.click(slantedEnd());
    d.click(polar(slantedEnd(), 61, 12));
    await d.settle();
    const [n] = d.drawn() as Line[];
    expect(d.h.constraints.map((c) => c.type)).toEqual(["coincident", "tangent2"]);
    expect(d.h.undoEdit()).toBe(true);
    expect(d.h.entities.some((e) => e.id === n!.id), "the line survived the undo").toBe(false);
    expect(d.h.constraints, "a constraint survived the undo").toEqual([]);
  });
});
