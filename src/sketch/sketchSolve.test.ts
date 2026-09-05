// Solver-fixed integration for projected reference geometry (plan step 5),
// exercised against the REAL planegcs WASM: projected curves compile as pinned
// primitives, user constraints/dims attach to them, and user geometry follows
// when the projection moves (the associative payoff). The wasm `?url` import
// resolves root-relative under vitest, so locateFile needs the absolute path.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve, constraintIndexOf } from "./sketchSolve";
import { expectSaneGeometry, expectUnchangedOnFailure } from "./solveInvariants";
import { breakLink } from "./modify";
import type { ResolvedEntity } from "./snap";
import type { ProjectedCurve, SketchConstraint } from "../types";

const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const projected = (id: string, curve: ProjectedCurve): ResolvedEntity => ({ type: "projected", id, source: SRC, curve });
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });

/** the projected entities of a pass, for asserting they never move */
const projectedOf = (ents: ResolvedEntity[]) => ents.filter((e) => e.type === "projected");

describe("constraintIndexOf implicit-id contract", () => {
  it("decodes user ids and rejects `~` internal ids", () => {
    expect(constraintIndexOf("k7")).toBe(7);
    expect(constraintIndexOf("k7a")).toBe(7); // composite suffix
    expect(constraintIndexOf("e3~r")).toBeNull(); // projected radius pin
    expect(constraintIndexOf("e3~h0")).toBeNull(); // rectangle rule
    expect(constraintIndexOf("__dragc")).toBeNull();
  });
});

describe("projected geometry compiles as fixed solver primitives", () => {
  it("projected-only sketch has 0 DOF; a free user line keeps its 4", async () => {
    const ents = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 5, 5, 15, 5)];
    const r = await compileAndSolve(ents, [{ type: "horizontal", line: "u" }]);
    expect(r.ok).toBe(true);
    // projected removes no user DOF: horizontal takes 1 of the line's 4
    expect(r.dof).toBe(3);
  });

  it("user line coincident to a projected endpoint follows when the projection moves", async () => {
    const constraints: SketchConstraint[] = [
      { type: "coincident", e1: "u", p1: 0, e2: "pl", p2: 1 },
      { type: "horizontal", line: "u" },
      { type: "distance", line: "u", value: 20 },
    ];
    const before = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 40, 0, 60, 2)];
    const r1 = await compileAndSolve(before, constraints);
    expect(r1.ok).toBe(true);
    expect(r1.conflicts).toEqual([]);
    const u1 = r1.entities.find((e) => e.id === "u");
    expect(u1).toMatchObject({ x1: 40, y1: 0 });
    if (u1?.type !== "line") throw new Error("line lost");
    expect(Math.hypot(u1.x2 - u1.x1, u1.y2 - u1.y1)).toBeCloseTo(20, 6);

    // simulate a projection refresh: the source moved up by 5
    const moved = [projected("pl", { kind: "line", x1: 0, y1: 5, x2: 40, y2: 5 }), u1];
    const r2 = await compileAndSolve(moved, constraints);
    expect(r2.ok).toBe(true);
    const u2 = r2.entities.find((e) => e.id === "u");
    if (u2?.type !== "line") throw new Error("line lost");
    expect(u2.x1).toBeCloseTo(40, 6);
    expect(u2.y1).toBeCloseTo(5, 6); // followed the projection
    expect(u2.y2).toBeCloseTo(5, 6); // horizontal held
    expect(Math.hypot(u2.x2 - u2.x1, u2.y2 - u2.y1)).toBeCloseTo(20, 6);
    // the projected entity itself is byte-identical
    expect(projectedOf(r2.entities)).toEqual(projectedOf(moved));
  });

  it("projected coords never change, even under a conflicting dim", async () => {
    const ents = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 })];
    // driving dim between the two fixed endpoints with the WRONG value
    const r = await compileAndSolve(ents, [{ type: "p2pDistance", e1: "pl", p1: 0, e2: "pl", p2: 1, value: 30 }]);
    expect(projectedOf(r.entities)).toEqual(ents); // untouched
    // the impossible dim surfaces (conflict or redundancy — never silence)
    const flagged = [...r.conflicts, ...r.overDefined].map(constraintIndexOf).filter((i) => i !== null);
    expect(flagged).toContain(0);
  });

  it("a driving dim between two fully-fixed projected points is over-defined, not a crash", async () => {
    const ents = [
      projected("pa", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }),
      projected("pb", { kind: "line", x1: 0, y1: 10, x2: 40, y2: 10 }),
    ];
    // value matches the true distance → satisfiable but adds nothing
    const r = await compileAndSolve(ents, [{ type: "p2pDistance", e1: "pa", p1: 0, e2: "pb", p2: 0, value: 10 }]);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.overDefined.map(constraintIndexOf)).toContain(0); // amber via existing plumbing
    expect(projectedOf(r.entities)).toEqual(ents);
  });

  it("projected circle: center + radius pinned; a dimensioned user line moves instead", async () => {
    const ents = [
      projected("pc", { kind: "circle", x: 10, y: 10, r: 5 }),
      line("u", 30, 10, 45, 10),
    ];
    const constraints: SketchConstraint[] = [
      { type: "horizontal", line: "u" },
      { type: "distance", line: "u", value: 15 },
      // p2p dim from the user line start to the projected circle CENTER (p 0)
      { type: "p2pDistance", e1: "u", p1: 0, e2: "pc", p2: 0, value: 12 },
    ];
    const r = await compileAndSolve(ents, constraints);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    // no internal `~r` pin ever surfaces as a user constraint problem
    expect([...r.conflicts, ...r.overDefined].map(constraintIndexOf).filter((i) => i !== null)).toEqual([]);
    expect(projectedOf(r.entities)).toEqual([ents[0]]); // circle untouched
    const u = r.entities.find((e) => e.id === "u");
    if (u?.type !== "line") throw new Error("line lost");
    expect(Math.hypot(u.x1 - 10, u.y1 - 10)).toBeCloseTo(12, 5); // line obeyed the dim
  });

  it("projected arc: all three points fixed; coincident user geometry follows a refresh", async () => {
    // semicircle: (0,0)→(10,0) through (5,5), center (5,0) r=5
    const arc: ProjectedCurve = { kind: "arc", x1: 0, y1: 0, x2: 10, y2: 0, mx: 5, my: 5 };
    const constraints: SketchConstraint[] = [
      { type: "coincident", e1: "u", p1: 0, e2: "pa", p2: 1 },
      { type: "vertical", line: "u" },
      { type: "distance", line: "u", value: 8 },
    ];
    const before = [projected("pa", arc), line("u", 10, 0, 10, -8)];
    const r1 = await compileAndSolve(before, constraints);
    expect(r1.ok).toBe(true);
    expect(projectedOf(r1.entities)).toEqual([before[0]]);
    // refresh: arc slides +3 in x
    const movedArc: ProjectedCurve = { kind: "arc", x1: 3, y1: 0, x2: 13, y2: 0, mx: 8, my: 5 };
    const u1 = r1.entities.find((e) => e.id === "u");
    if (u1?.type !== "line") throw new Error("line lost");
    const r2 = await compileAndSolve([projected("pa", movedArc), u1], constraints);
    expect(r2.ok).toBe(true);
    const u2 = r2.entities.find((e) => e.id === "u");
    if (u2?.type !== "line") throw new Error("line lost");
    expect(u2.x1).toBeCloseTo(13, 6); // stuck to the arc's moved endpoint
    expect(u2.y1).toBeCloseTo(0, 6);
    expect(Math.abs(u2.y2 - u2.y1)).toBeCloseTo(8, 6);
  });

  it("projected poly: first/last samples anchor coincident geometry", async () => {
    const poly: ProjectedCurve = { kind: "poly", pts: [[0, 0], [2, 1], [4, 1.5], [6, 1]] };
    const constraints: SketchConstraint[] = [
      { type: "coincident", e1: "u", p1: 0, e2: "pp", p2: 1 },
      { type: "horizontal", line: "u" },
      { type: "distance", line: "u", value: 5 },
    ];
    const ents = [projected("pp", poly), line("u", 6, 1, 11, 2)];
    const r = await compileAndSolve(ents, constraints);
    expect(r.ok).toBe(true);
    const u = r.entities.find((e) => e.id === "u");
    if (u?.type !== "line") throw new Error("line lost");
    expect(u.x1).toBeCloseTo(6, 6);
    expect(u.y1).toBeCloseTo(1, 6); // anchored on the last sample
    expect(u.y2).toBeCloseTo(1, 6);
    expect(projectedOf(r.entities)).toEqual([ents[0]]);
  });

  it("coincident on an exactly-snapped projected endpoint: merged, no conflict", async () => {
    // user line starts EXACTLY on the projected endpoint → position-merge into
    // one (fixed) solver point. planegcs flags the now-vacuous coincident as
    // removable (same as native snapped+coincident endpoints — pre-existing,
    // uniform behavior); it must never read as a CONFLICT, and the merge is
    // what anchors the line to the reference.
    const ents = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 40, 0, 55, 5)];
    const r = await compileAndSolve(ents, [{ type: "coincident", e1: "u", p1: 0, e2: "pl", p2: 1 }]);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.overDefined.map(constraintIndexOf)).toContain(0); // removable, amber like native
  });

  it("dragging a user endpoint merged onto a projected point is refused (no fighting)", async () => {
    // user line starts EXACTLY on the projected endpoint → positions merge, point is fixed
    const ents = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 40, 0, 60, 0)];
    const constraints: SketchConstraint[] = [{ type: "distance", line: "u", value: 20 }];
    const r = await compileAndSolve(ents, constraints, { fromX: 40, fromY: 0, toX: 45, toY: 9 });
    expect(r.conflicts).toEqual([]); // refused cleanly, not reported as inconsistent
    expect(r.dragRefused).toBe("projected"); // reported: caller keeps its anchor + explains
    const u = r.entities.find((e) => e.id === "u");
    expect(u).toMatchObject({ x1: 40, y1: 0 }); // did not move
    expect(projectedOf(r.entities)).toEqual([ents[0]]);
  });

  it("dragRefused distinguishes a user `fix` pin, and a free drag reports nothing", async () => {
    const ents = [line("u", 0, 0, 20, 0)];
    const fixed = await compileAndSolve(ents, [{ type: "fix", e: "u", p: 0 }], { fromX: 0, fromY: 0, toX: 5, toY: 5 });
    expect(fixed.dragRefused).toBe("fix");
    expect(fixed.entities.find((e) => e.id === "u")).toMatchObject({ x1: 0, y1: 0 });
    const free = await compileAndSolve(ents, [], { fromX: 20, fromY: 0, toX: 25, toY: 5 });
    expect(free.dragRefused).toBeUndefined();
    expect(free.entities.find((e) => e.id === "u")).toMatchObject({ x2: 25, y2: 5 });
  });
});

describe("Break Link — constraints survive the projected→native conversion", () => {
  it("a dim + coincident to a broken (now native) line still resolve, and the line drags", async () => {
    const constraints: SketchConstraint[] = [
      { type: "coincident", e1: "u", p1: 0, e2: "pl", p2: 1 },
      { type: "p2pDistance", e1: "u", p1: 1, e2: "pl", p2: 0, value: 50 },
    ];
    const before = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 40, 0, 55, 5)];
    const r1 = await compileAndSolve(before, constraints);
    expect(r1.ok).toBe(true);
    expect(r1.conflicts).toEqual([]);

    // Break Link: same id, native line — the constraints keep their targets
    const broken = breakLink(r1.entities, new Set(["pl"]));
    expect(broken[0]).toMatchObject({ type: "line", id: "pl" });
    const r2 = await compileAndSolve(broken, constraints);
    expect(r2.ok).toBe(true);
    expect(r2.conflicts).toEqual([]);
    // fixed→free: the ex-projected line's 4 DOF joined the sketch (never over-constrains)
    expect(r2.dof).toBeGreaterThan(r1.dof);

    // dragging the ex-projected endpoint now WORKS (it was refused while linked)
    const r3 = await compileAndSolve(broken, constraints, { fromX: 0, fromY: 0, toX: -5, toY: 3 });
    expect(r3.dragRefused).toBeUndefined();
    const dragged = r3.entities.find((e) => e.id === "pl");
    if (dragged?.type !== "line") throw new Error("line lost");
    expect(dragged.x1).toBeCloseTo(-5, 6);
    expect(dragged.y1).toBeCloseTo(3, 6);
  });

  it("a p2p dim to a broken closed poly (now C0-closed spline) still resolves at index 0", async () => {
    const closed: ProjectedCurve = { kind: "poly", pts: [[0, 0], [4, 4], [8, 0], [0, 0]] };
    const constraints: SketchConstraint[] = [
      { type: "p2pDistance", e1: "u", p1: 0, e2: "pq", p2: 0, value: 10 },
    ];
    const ents = [projected("pq", closed), line("u", 10, 0, 20, 0)];
    const r1 = await compileAndSolve(ents, constraints);
    expect(r1.ok).toBe(true);
    expect(r1.conflicts).toEqual([]);

    const broken = breakLink(ents, new Set(["pq"]));
    expect(broken[0]).toMatchObject({ type: "spline", id: "pq" });
    const r2 = await compileAndSolve(broken, constraints);
    expect(r2.ok).toBe(true);
    expect(r2.conflicts).toEqual([]);
    const u = r2.entities.find((e) => e.id === "u");
    if (u?.type !== "line") throw new Error("line lost");
    // the dim held against the spline's endpoint 0 (same location the closed
    // poly exposed as its one addressable point)
    const sp = r2.entities.find((e) => e.id === "pq");
    if (sp?.type !== "spline") throw new Error("spline lost");
    const p0 = sp.points[0]!;
    expect(Math.hypot(u.x1 - p0.x, u.y1 - p0.y)).toBeCloseTo(10, 5);
  });
});

// The associative payoff for Offset, against the REAL solver. The bug this
// fixes: an offset copy carried no constraint at all, so it drifted off its
// source on the next solve ("de-concentrified") and its distance wasn't editable.
describe("offset constraint — the copy stays tied to its source", () => {
  const circle = (id: string, x: number, y: number, r: number): ResolvedEntity =>
    ({ type: "circle", id, x, y, radius: r });

  it("pulls a drifted copy back to concentric at the right gap (the ring case)", async () => {
    // the copy starts off-centre and at the wrong radius, as if it had drifted
    const ents = [circle("c1", 0, 0, 5), circle("c2", 0.7, -0.4, 7.1)];
    const cons: SketchConstraint[] = [
      { type: "offset", pairs: [{ src: "c1", cpy: "c2" }], value: 3 },
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const a = r.entities.find((e) => e.id === "c1");
    const b = r.entities.find((e) => e.id === "c2");
    if (a?.type !== "circle" || b?.type !== "circle") throw new Error("circles lost");
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(0, 5); // concentric again
    expect(b.radius - a.radius).toBeCloseTo(3, 5); // and the gap is the dim
  });

  it("makes the copy FOLLOW an upstream radius change", async () => {
    const ents = [circle("c1", 0, 0, 5), circle("c2", 0, 0, 8)];
    const cons: SketchConstraint[] = [
      { type: "offset", pairs: [{ src: "c1", cpy: "c2" }], value: 3 },
      { type: "radius", e: "c1", value: 9 }, // drive the SOURCE bigger
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    const a = r.entities.find((e) => e.id === "c1");
    const b = r.entities.find((e) => e.id === "c2");
    if (a?.type !== "circle" || b?.type !== "circle") throw new Error("circles lost");
    expect(a.radius).toBeCloseTo(9, 5);
    expect(b.radius).toBeCloseTo(12, 5); // followed, keeping the 3mm wall
  });

  it("takes a NEGATIVE value as an inward offset (signed, no branch ambiguity)", async () => {
    const ents = [circle("c1", 0, 0, 5), circle("c2", 0, 0, 3)];
    const cons: SketchConstraint[] = [
      { type: "offset", pairs: [{ src: "c1", cpy: "c2" }], value: -2 },
      { type: "radius", e: "c1", value: 10 },
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    const b = r.entities.find((e) => e.id === "c2");
    if (b?.type !== "circle") throw new Error("circle lost");
    expect(b.radius).toBeCloseTo(8, 5); // stayed INSIDE
  });

  it("governs a whole 4-line chain from ONE value (Fusion: not four dims)", async () => {
    // a 10x10 square and its inward copy at 2mm, corners joined
    const sq = (p: string, o: number): ResolvedEntity[] => [
      line(`${p}0`, o, o, 10 - o, o),
      line(`${p}1`, 10 - o, o, 10 - o, 10 - o),
      line(`${p}2`, 10 - o, 10 - o, o, 10 - o),
      line(`${p}3`, o, 10 - o, o, o),
    ];
    // the copy starts SLOPPY — 1.4mm on one side, 2.6 on another
    const ents = [...sq("s", 0), ...sq("c", 0), ...[]];
    const copy = [
      line("c0", 1.4, 1.4, 8.7, 1.4), line("c1", 8.7, 1.4, 8.7, 8.6),
      line("c2", 8.7, 8.6, 1.3, 8.6), line("c3", 1.3, 8.6, 1.4, 1.4),
    ];
    const all = [...ents.slice(0, 4), ...copy];
    const cons: SketchConstraint[] = [
      // the copy's corners are a chain
      { type: "coincident", e1: "c0", p1: 1, e2: "c1", p2: 0 },
      { type: "coincident", e1: "c1", p1: 1, e2: "c2", p2: 0 },
      { type: "coincident", e1: "c2", p1: 1, e2: "c3", p2: 0 },
      { type: "coincident", e1: "c3", p1: 1, e2: "c0", p2: 0 },
      // ...and ONE offset dim governs every member
      { type: "offset", value: 2, pairs: [0, 1, 2, 3].map((k) => ({ src: `s${k}`, cpy: `c${k}` })) },
    ];
    const r = await compileAndSolve(all, cons);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    // every copy edge ends up exactly 2mm from its source edge
    for (const k of [0, 1, 2, 3]) {
      const s = r.entities.find((e) => e.id === `s${k}`);
      const c = r.entities.find((e) => e.id === `c${k}`);
      if (s?.type !== "line" || c?.type !== "line") throw new Error("chain lost");
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy) || 1;
      const perp = Math.abs((c.x1 - s.x1) * dy - (c.y1 - s.y1) * dx) / len;
      expect(perp).toBeCloseTo(2, 4);
      // and parallel to it
      expect(Math.abs((c.x2 - c.x1) * dy - (c.y2 - c.y1) * dx) / (len * len)).toBeCloseTo(0, 4);
    }
  });

  it("survives losing one copy: the pair list shrinks, the rest stay linked", async () => {
    // pruneConstraints drops the dead pair; the solver must accept what's left
    const ents = [circle("c1", 0, 0, 5), circle("c2", 0, 0, 8)];
    const cons: SketchConstraint[] = [
      { type: "offset", value: 3, pairs: [{ src: "c1", cpy: "c2" }, { src: "gone", cpy: "alsogone" }] },
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    const b = r.entities.find((e) => e.id === "c2");
    if (b?.type !== "circle") throw new Error("circle lost");
    expect(b.radius).toBeCloseTo(8, 5); // the live pair still holds
  });
});

// Applying Collinear to two lines that are already Horizontal and Vertical is
// only satisfiable by shrinking one to ZERO LENGTH: at zero length a line has no
// direction, so `parallel` goes vacuous and planegcs reports that branch solved.
//
// Reported in the app on 2026-08-15 — a 65mm edge became 0mm and the L folded
// flat. The conflict WAS detected (both dims and the parallel were named); the
// broken geometry was applied anyway, because badGeom only screened zero-radius
// circles and arcs and never a collapsed line.
describe("a line that collapses to nothing is refused, like a zero-radius circle", () => {
  it("keeps the pre-solve geometry and reports the conflict", async () => {
    const entities: any[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 70, y2: 0 },
      { type: "line", id: "B", x1: 0, y1: 0, x2: 0, y2: -65 },
    ];
    const constraints: any[] = [
      { type: "coincident", e1: "A", p1: 0, e2: "B", p2: 0 },
      { type: "horizontal", line: "A" },
      { type: "vertical", line: "B" },
      { type: "collinear", l1: "A", l2: "B" }, // the destructive one
    ];
    const r = await compileAndSolve(entities, constraints);
    const len = (e: any) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    const B = r.entities.find((e: any) => e.id === "B")!;
    // refused rather than applied: H + V + collinear cannot all hold on two real
    // lines, so the only "solution" is a degenerate one and it must not land
    expect(r.ok).toBe(false);
    // the whole point: the 65mm edge is still 65mm, not 0
    expect(len(B)).toBeCloseTo(65, 6);
    // and the universal post-conditions, which would have caught this class on
    // their own without anyone predicting collinear specifically
    expectSaneGeometry(r.entities, "collinear on H+V", entities);
    expectUnchangedOnFailure(r, entities, r.entities, "collinear on H+V");
  });
});

// Bug #86, field report 787121b3 (0.1.136): "The dimensions of the rectangle
// (40x40) change instead of changing the distance of the circle to the
// rectangle."
//
// A rectangle expands into 4 free corners + 4 implicit h/v rules, so it carries
// 4 DOF and nothing that says "keep my drawn size". A p2lDistance from a circle
// centre to one of its edges is ONE equation over three free x-coordinates, so
// the solver is free to split the correction between the circle and the
// rectangle — and it does, unstably: at the reported start position it moved the
// left edge 0.110mm and the circle 0.071mm (39.890111 x 40), at x=-13.9 it moved
// the rectangle alone, at x=-13.95 the circle alone.
//
// The fix is a POLICY, not a repair: the FIRST-PICKED entity moves. Everything
// else is anchored at its input position for that one solve.
describe("bug #86 — a dimension moves what you dimensioned, not what you measured from", () => {
  const seed = (): any[] => [
    { type: "rectangle", id: "e9", x: 0, y: 0, width: 40, height: 40 },
    { type: "circle", id: "e11", x: -13.8194, y: 12.798995405618346, radius: 2.4 },
  ];
  const dim: any[] = [
    { type: "diameter", circle: "e11", value: 4.8 },
    { type: "p2lDistance", e: "e11", p: 0, line: "e9~3", value: 6 }, // to the LEFT edge
  ];
  const rectOf = (r: { entities: ResolvedEntity[] }) => {
    const e = r.entities.find((x) => x.id === "e9");
    if (e?.type !== "rectangle") throw new Error("rectangle lost");
    return e;
  };
  const circleOf = (r: { entities: ResolvedEntity[] }) => {
    const e = r.entities.find((x) => x.id === "e11");
    if (e?.type !== "circle") throw new Error("circle lost");
    return e;
  };

  it("a distance dimension moves the entity you dimensioned, not the one you measured from", async () => {
    const r = await compileAndSolve(seed(), dim, undefined, { moves: ["e11"] });
    const rect = rectOf(r);
    expect(rect.width).toBe(40); // the reported symptom: it became 39.890111
    expect(rect.height).toBe(40);
    expect(rect.x).toBe(0);
    // the left edge is at x = -20, so 6mm out from it is x = -14
    expect(Math.abs(circleOf(r).x - -14)).toBeLessThan(1e-9);
  });

  it("no bias is today's behaviour", async () => {
    // Bias omitted must take the untouched free path, and what that path DOES is
    // the defect: it pays for the dimension by moving the rectangle's left edge.
    //
    // Asserted as the defect and not as a number. This solve is one of the
    // bistable ones solveReproducibility documents — repeated 20 times in one
    // process it alternates between 39.890111 (rect 61% / circle 39%) and
    // 39.929289 (the same split the other way round) — and WHICH of the two it
    // lands on depends on how many solves ran earlier in the same worker. So an
    // exact-float allowlist here fails on unrelated edits to the tests ABOVE it:
    // a mutation that changed nothing about this solve, only the count before it,
    // flipped it red. Both values resize the rectangle and neither is 40, and
    // that is the whole of what this test is about.
    const r = await compileAndSolve(seed(), dim);
    const rect = rectOf(r);
    expect(rect.width).not.toBe(40); // the rectangle paid, which is the bug
    expect(rect.width).toBeGreaterThan(39.5); // ...a little, not a collapse
    expect(rect.width).toBeLessThan(40);
    // toBeCloseTo, not toBe: on the CI runner the solver lands 1e-16 off the
    // exact half, and an exact-float compare on a solver output is the wrong
    // oracle (see the comment above).
    expect(rect.x).toBeCloseTo((40 - rect.width) / 2, 9); // the LEFT edge is the one that moved
  });

  it("anchors do not change what the solver reports", async () => {
    // The anchors ride on the drag pin's device — a `fixed:true` HELPER point
    // plus a `temporary:true` coincidence. `temporary` tags the constraint -1,
    // so it never enters dof / conflicts / redundant. Doing it with `fixed:true`
    // on the real points instead fabricates 4 redundants and reports dof 1,
    // which is what this test exists to catch.
    const free = await compileAndSolve(seed(), dim);
    const biased = await compileAndSolve(seed(), dim, undefined, { moves: ["e11"] });
    expect(biased.dof).toBe(5);
    expect(biased.dof).toBe(free.dof);
    expect(biased.conflicts).toEqual([]);
    expect(biased.overDefined).toEqual([]);
  });

  it("an anchored pass the GEOMETRY GUARD condemns falls back to the free solve", async () => {
    // sketchMode withdraws a trial constraint — with a "that conflicts with the
    // ones already on this sketch" toast — on `!r.ok` OR any conflict
    // (sketchMode.ts:3666). So a biased pass that is anything less than
    // ok-with-no-conflicts must be discarded WHOLE, result AND diagnostics, and
    // today's free solve returned in its place: the bias must never be able to
    // turn a good constraint into a withdrawn one.
    //
    // THE THING THIS TEST HAS TO DISCRIMINATE, because an earlier version of it
    // did not: the fallback has to be judged on the FINISHED pass, guard
    // included, not on solveSketch's raw return. Perpendicular between this
    // rectangle's TOP edge and this line, rect picked first, is a case where
    // planegcs reports Success with an empty conflict list while having driven
    // the rectangle's width to zero — so the raw return looks clean, and only
    // the RECT_COLLAPSE guard 170 lines later condemns it. Judged raw, the
    // fallback never fired and this perfectly valid Perpendicular came back
    // ok:false / conflicts:["k0"] with the geometry untouched.
    //
    // Deleting the fallback line makes this fail on the first expect.
    const rect = (): any[] => [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 },
      { type: "line", id: "L", x1: 10, y1: 20, x2: -20, y2: 10 },
    ];
    const perp: any[] = [{ type: "perpendicular", l1: "R~2", l2: "L" }];
    const free = await compileAndSolve(rect(), perp);
    const biased = await compileAndSolve(rect(), perp, undefined, { moves: ["R"] });
    expect(free.ok).toBe(true); // the constraint IS satisfiable — nothing to withdraw
    expect(free.conflicts).toEqual([]);
    expect(biased.ok).toBe(true);
    expect(biased.conflicts).toEqual([]);
    // discarded WHOLE: the free solve's geometry, not the collapsed anchored one
    expect(biased.entities).toEqual(free.entities);
    // and the anchored pass really was condemned, i.e. this is the fallback and
    // not a bias that happened to land on the same answer — picking the LINE
    // first (the other order) is clean anchored, and lands somewhere else.
    const other = await compileAndSolve(rect(), perp, undefined, { moves: ["L"] });
    const otherRect = other.entities.find((e) => e.id === "R");
    if (otherRect?.type !== "rectangle") throw new Error("rectangle lost");
    expect(otherRect.width).toBeCloseTo(40, 9); // rect held; the LINE rotated
    expect(free.entities).not.toEqual(other.entities);
  });

  it("a mover's non-mover circle keeps its RADIUS — the tangent gesture", async () => {
    // A radius is a solver variable that hangs off no point, so anchoring the
    // circle's centre alone left it as free as ever, and the bias made the
    // reported symptom WORSE than shipping nothing: arm Tangent, pick the LINE
    // first, and the circle the user did not pick grew 5 -> 7 (+40%), where the
    // unbiased solve took it to 5.822 (+16%). SolveInput.radiusAnchors is the
    // fix; the bar it has to clear is "never worse than the free solve", and it
    // clears it by not moving the non-mover AT ALL.
    const seedT = (): any[] => [
      { type: "line", id: "L", x1: -20, y1: 8, x2: 20, y2: 8 },
      { type: "circle", id: "C", x: 0, y: 0, radius: 5 },
    ];
    const tangent: any[] = [{ type: "tangent2", a: "L", b: "C" }];
    const circ = (r: { entities: ResolvedEntity[] }) => {
      const e = r.entities.find((x) => x.id === "C");
      if (e?.type !== "circle") throw new Error("circle lost");
      return e;
    };
    const free = await compileAndSolve(seedT(), tangent);
    const biased = await compileAndSolve(seedT(), tangent, undefined, { moves: ["L"] });
    expect(biased.ok).toBe(true);
    expect(biased.conflicts).toEqual([]);
    expect(circ(biased).radius).toBe(5); // untouched, not merely closer than free
    expect(circ(biased).x).toBeCloseTo(0, 12); // -9.9e-33 on the CI runner: a solver output, not a literal
    expect(circ(biased).y).toBeCloseTo(0, 12);
    // never worse than today, stated as the measurement it is
    expect(Math.abs(circ(biased).radius - 5)).toBeLessThan(Math.abs(circ(free).radius - 5));
    // and the LINE, which IS the mover, absorbed the whole correction: tangent
    // to an r=5 circle at the origin puts it at y=5.
    const l = biased.entities.find((e) => e.id === "L");
    if (l?.type !== "line") throw new Error("line lost");
    expect(l.y1).toBeCloseTo(5, 9);
  });

  it("...and an ARC keeps its radius too, with no radius pin of its own", async () => {
    // Same gesture, same bar, DIFFERENT mechanism, and the difference is worth
    // stating because it is why sketchSolve emits no arc radius anchor. An
    // arc's centre is compiled as a non-mergeable point, so a non-mover arc's
    // centre is always anchored, and `arc_rules` keeps both endpoints on the
    // circle — centre + either endpoint already fixes the radius. Confirmed by
    // deleting an arc arm from the radius anchors: this test did not move.
    //
    // What it DOES defend is the guarantee itself: with the bias removed the
    // arc grows past 7.5, and this fails.
    const seedA = (): any[] => [
      { type: "line", id: "L", x1: -20, y1: 8, x2: 20, y2: 8 },
      { type: "arc", id: "A", x1: -5, y1: 0, x2: 5, y2: 0, mx: 0, my: 5 },
    ];
    const tangent: any[] = [{ type: "tangent2", a: "L", b: "A" }];
    const free = await compileAndSolve(seedA(), tangent);
    const biased = await compileAndSolve(seedA(), tangent, undefined, { moves: ["L"] });
    expect(biased.ok).toBe(true);
    expect(biased.conflicts).toEqual([]);
    expect(biased.overDefined).toEqual([]);
    expect(biased.dof).toBe(free.dof);
    const arcOf = (r: { entities: ResolvedEntity[] }) => {
      const e = r.entities.find((x) => x.id === "A");
      if (e?.type !== "arc") throw new Error("arc lost");
      return Math.hypot(e.mx - (e.x1 + e.x2) / 2, e.my - (e.y1 + e.y2) / 2); // sagitta == r here
    };
    expect(arcOf(biased)).toBeCloseTo(5, 9); // untouched
    expect(arcOf(free)).toBeGreaterThan(7); // what it does without the pin
  });

  it("the circle you PICKED keeps its size under tangent — it moves instead", async () => {
    // Field report fd7dcc5f: "tangent grew my circle instead of moving it".
    // Tangency measures a POSITION, exactly like a rim dim, so the mover paying
    // in radius is never what the gesture meant — but `rimMovers` listed only
    // the three rim dims, so a mover circle under tangent kept BOTH a free
    // centre and a free radius and planegcs split the correction evenly between
    // them: measured on HEAD, centre y -10 (half the gap) and radius 10 -> 20.
    const seed = (): any[] => [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 100, height: 60 },
      { type: "circle", id: "C", x: 0, y: 0, radius: 10 },
    ];
    const tangent: any[] = [{ type: "tangent2", a: "C", b: "R~0" }]; // R~0 is the bottom edge
    const r = await compileAndSolve(seed(), tangent, undefined, { moves: ["C"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const c = r.entities.find((e) => e.id === "C");
    const rect = r.entities.find((e) => e.id === "R");
    if (c?.type !== "circle" || rect?.type !== "rectangle") throw new Error("geometry lost");
    expect(c.radius).toBe(10); // the mover was not resized
    expect(c.y).toBeCloseTo(-20, 9); // it MOVED: tangent to the edge at y=-30
    expect(rect.width).toBeCloseTo(100, 9); // the rectangle held
    expect(rect.height).toBeCloseTo(60, 9);
  });

  it("...and lands in the SAME place whether or not the circle carries a diameter", async () => {
    // The invariant the report is actually about. The auto ⌀ badge is
    // measurement-only (entityDims reads e.radius; nothing creates a
    // constraint), so with only the badge the radius is a free variable and the
    // tangent resizes; TYPE a value into that same badge and the driving
    // `diameter` vetoes the radius, so the tangent translates. Two identical
    // -looking badges, two different gestures. Pinning the mover's radius makes
    // the undimensioned answer equal the dimensioned one.
    const seed = (): any[] => [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 100, height: 60 },
      { type: "circle", id: "C", x: 0, y: 0, radius: 10 },
    ];
    const tangent: any[] = [{ type: "tangent2", a: "C", b: "R~0" }];
    const withDim: any[] = [...tangent, { type: "diameter", circle: "C", value: 20 }];
    const bare = await compileAndSolve(seed(), tangent, undefined, { moves: ["C"] });
    const dimmed = await compileAndSolve(seed(), withDim, undefined, { moves: ["C"] });
    const circ = (r: { entities: ResolvedEntity[] }) => {
      const e = r.entities.find((x) => x.id === "C");
      if (e?.type !== "circle") throw new Error("circle lost");
      return e;
    };
    expect(bare.ok).toBe(true);
    expect(dimmed.ok).toBe(true);
    expect(circ(bare).radius).toBeCloseTo(circ(dimmed).radius, 9);
    expect(circ(bare).x).toBeCloseTo(circ(dimmed).x, 9);
    expect(circ(bare).y).toBeCloseTo(circ(dimmed).y, 9);
  });

  it("a mover ARC keeps its radius under tangent too", async () => {
    // The non-mover arc above needs no pin of its own (its centre is anchored
    // and `arc_rules` does the rest), but a MOVER arc has neither: its centre is
    // free because it belongs to the mover, so the radius is free as well and
    // the arc grows. Measured on HEAD: 5 -> 7.95. This is the one radius anchor
    // that has to be spelled `arc_radius` rather than `circle_radius`.
    const seed = (): any[] => [
      { type: "line", id: "L", x1: -20, y1: 8, x2: 20, y2: 8 },
      { type: "arc", id: "A", x1: -5, y1: 0, x2: 5, y2: 0, mx: 0, my: 5 },
    ];
    const tangent: any[] = [{ type: "tangent2", a: "A", b: "L" }];
    const r = await compileAndSolve(seed(), tangent, undefined, { moves: ["A"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const a = r.entities.find((e) => e.id === "A");
    const l = r.entities.find((e) => e.id === "L");
    if (a?.type !== "arc" || l?.type !== "line") throw new Error("geometry lost");
    // circumcircle of the three solved points — the sagitta shortcut the test
    // above uses only holds while the arc stays a half circle on a fixed chord
    const d = 2 * (a.x1 * (a.y2 - a.my) + a.x2 * (a.my - a.y1) + a.mx * (a.y1 - a.y2));
    const s1 = a.x1 * a.x1 + a.y1 * a.y1, s2 = a.x2 * a.x2 + a.y2 * a.y2, s3 = a.mx * a.mx + a.my * a.my;
    const cx = (s1 * (a.y2 - a.my) + s2 * (a.my - a.y1) + s3 * (a.y1 - a.y2)) / d;
    const cy = (s1 * (a.mx - a.x2) + s2 * (a.x1 - a.mx) + s3 * (a.x2 - a.x1)) / d;
    expect(Math.hypot(a.x1 - cx, a.y1 - cy)).toBeCloseTo(5, 6); // radius held
    expect(cy).toBeCloseTo(3, 6); // and it MOVED: centre 5 below the line at y=8
    expect(l.y1).toBeCloseTo(8, 9); // the non-mover line held
    expect(l.y2).toBeCloseTo(8, 9);
  });

  it("circle-to-circle tangent moves the circle you picked, not both radii", async () => {
    // Same arm, the other operand shape. On HEAD the picked circle grew 5 ->
    // 11.93 while its centre crept to 10.07; pinned, it translates whole.
    const seed = (): any[] => [
      { type: "circle", id: "A", x: 0, y: 0, radius: 5 },
      { type: "circle", id: "B", x: 30, y: 0, radius: 12 },
    ];
    const tangent: any[] = [{ type: "tangent2", a: "A", b: "B" }];
    const r = await compileAndSolve(seed(), tangent, undefined, { moves: ["A"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const a = r.entities.find((e) => e.id === "A");
    const b = r.entities.find((e) => e.id === "B");
    if (a?.type !== "circle" || b?.type !== "circle") throw new Error("geometry lost");
    expect(a.radius).toBeCloseTo(5, 9); // the mover kept its size
    expect(b.radius).toBeCloseTo(12, 9); // the non-mover was already covered
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(17, 6); // externally tangent
  });

  it("equal-radius moves the circle you picked first, not the other one", async () => {
    // The gesture that read as fixed while doing nothing: constraintTools passes
    // `moves` on the equalRadius path, but until radii were anchored the bias
    // could not reach a radius, so all three of these gave C1=5 / C2=5 — the
    // NON-picked circle halving every time, which is bug #86 exactly.
    const two = (): any[] => [
      { type: "circle", id: "C1", x: 0, y: 0, radius: 5 },
      { type: "circle", id: "C2", x: 30, y: 0, radius: 10 },
    ];
    const eq: any[] = [{ type: "equalRadius", a: "C1", b: "C2" }];
    const radii = (r: { entities: ResolvedEntity[] }) =>
      r.entities.map((e) => (e.type === "circle" ? e.radius : NaN));
    const first = await compileAndSolve(two(), eq, undefined, { moves: ["C1"] });
    expect(radii(first)).toEqual([10, 10]);
    expect(radii(await compileAndSolve(two(), eq, undefined, { moves: ["C2"] }))).toEqual([5, 5]);
    // and a radius anchor stays out of the diagnostics exactly as a point anchor
    // does — `temporary` is what buys that, and losing it would light the whole
    // sketch amber. The free solve reports the same 5.
    expect(first.dof).toBe((await compileAndSolve(two(), eq)).dof);
    expect(first.dof).toBe(5);
    expect(first.overDefined).toEqual([]);
    expect(first.conflicts).toEqual([]);
  });

  it("a corner the MOVER shares stays free — anchoring it freezes the mover", async () => {
    // The `shared points stay FREE` rule, which nothing else in the suite
    // defends: inverting its `.some` to `.every` left all 608 sketch tests green
    // while reintroducing the bug. L's start is merged onto R's bottom-left
    // corner, so that solver point is owned by BOTH — and R is the mover, so it
    // must NOT be anchored. Anchored (the `.every` reading), R's left edge can
    // only move by dragging a pinned corner with it, so the solver splits the
    // 0.1806 mm correction instead and the circle the user did not pick drifts:
    // R 39.9097 with C at -13.9097, rather than R 39.8194 with C where it was.
    const shared = (): any[] => [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 40 },
      { type: "line", id: "L", x1: -20, y1: -20, x2: -40, y2: -40 },
      { type: "circle", id: "C", x: -13.8194, y: 12.798995405618346, radius: 2.4 },
    ];
    const cons: any[] = [
      { type: "diameter", circle: "C", value: 4.8 },
      { type: "p2lDistance", e: "C", p: 0, line: "R~3", value: 6 },
    ];
    const r = await compileAndSolve(shared(), cons, undefined, { moves: ["R"] });
    const rect = r.entities.find((e) => e.id === "R");
    const c = r.entities.find((e) => e.id === "C");
    if (rect?.type !== "rectangle" || c?.type !== "circle") throw new Error("geometry lost");
    expect(c.x).toBe(-13.8194); // exactly: the circle is not the mover
    expect(rect.width).toBeCloseTo(39.8194, 9); // the rectangle paid in full
  });

  it("naming an entity that moves nothing degrades gracefully", async () => {
    // The mover is whatever was picked FIRST, and nothing guarantees the pick is
    // one of the operands (a stale pick, a future flow). With every point
    // anchored the solver splits the correction 50/50 instead of failing — and
    // dimensioning the rectangle first moves the RECTANGLE, which is the same
    // policy read from the other end.
    const other: any[] = [...seed(), { type: "line", id: "L1", x1: 30, y1: -30, x2: 50, y2: -12 }];
    const none = await compileAndSolve(other, dim, undefined, { moves: ["L1"] });
    expect(none.ok).toBe(true);
    expect(none.conflicts).toEqual([]);
    const rectFirst = await compileAndSolve(seed(), dim, undefined, { moves: ["e9"] });
    expect(circleOf(rectFirst).x).toBe(-13.8194); // the circle did not budge
    expect(rectOf(rectFirst).width).toBeCloseTo(39.8194, 9);
  });

  it("a mover spelled as a rectangle EDGE frees the rectangle, not nothing", async () => {
    // `moves` names ENTITIES and `own()` attributes an edge's corners to the
    // rectangle, so an un-normalised `R~3` matched nothing: every point in the
    // sketch got anchored, including the four corners the pick meant to free,
    // and the gesture degraded to "moves nothing" — bug #86's exact symptom,
    // silently, with ok:true and no conflicts. (Measured before the
    // normalisation: R came back 39.9398 with the circle dragged to -13.9398.)
    // No caller spells it that way today; this is the trap closed for the next one.
    const r = await compileAndSolve(seed(), dim, undefined, { moves: ["e9~3"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(circleOf(r).x).toBe(-13.8194); // the circle is not the mover: untouched
    expect(rectOf(r).width).toBeCloseTo(39.8194, 9); // the rectangle paid in full
  });

  it("a rim DISTANCE moves the circle you picked — it does not resize it", async () => {
    // A rim dim measures a POSITION, so paying for it in the mover's radius is
    // never what the gesture meant. And the free radius was not merely unhelpful:
    // with the centre free and the radius free, planegcs takes the radius
    // NEGATIVE (raw solved radius -1.4999999999999982 here), the geometry guard
    // condemns the whole anchored pass, and the fallback quietly returns the FREE
    // solve — which moves the line the user measured FROM. So the one gesture the
    // policy exists for did not apply to itself, invisibly. Measured before the
    // mover-radius pin: L at y=-13.264911 and C resized to 2.470178.
    const seedR = (): any[] => [
      { type: "circle", id: "C", x: 0, y: 0, radius: 5 },
      { type: "line", id: "L", x1: -20, y1: -12, x2: 20, y2: -12 },
    ];
    const rim: any[] = [{ type: "c2lDistance", circle: "C", line: "L", value: 20 }];
    const r = await compileAndSolve(seedR(), rim, undefined, { moves: ["C"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const c = r.entities.find((e) => e.id === "C");
    const l = r.entities.find((e) => e.id === "L");
    if (c?.type !== "circle" || l?.type !== "line") throw new Error("geometry lost");
    expect(l.y1).toBe(-12); // the NON-mover line did not move at all
    expect(l.y2).toBe(-12);
    expect(c.radius).toBe(5); // the mover was not resized
    expect(c.y).toBeCloseTo(13, 9); // it MOVED: rim 20mm above a line at y=-12
  });

  it("...but a SIZE dim on the same circle still resizes it", async () => {
    // The boundary just inside the guard above: any constraint that governs the
    // mover's radius vetoes the pin, or the policy would freeze the very thing a
    // diameter/equal-radius gesture is asking to change. Rim dim AND a diameter
    // on one circle — the diameter must win, and the line must still hold still.
    const seedR = (): any[] => [
      { type: "circle", id: "C", x: 0, y: 0, radius: 5 },
      { type: "line", id: "L", x1: -20, y1: -12, x2: 20, y2: -12 },
    ];
    const both: any[] = [
      { type: "c2lDistance", circle: "C", line: "L", value: 20 },
      { type: "diameter", circle: "C", value: 16 },
    ];
    const r = await compileAndSolve(seedR(), both, undefined, { moves: ["C"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const c = r.entities.find((e) => e.id === "C");
    const l = r.entities.find((e) => e.id === "L");
    if (c?.type !== "circle" || l?.type !== "line") throw new Error("geometry lost");
    expect(c.radius).toBeCloseTo(8, 9); // the diameter got what it asked for
    expect(l.y1).toBeCloseTo(-12, 12); // and the non-mover still held (to 2e-15)
    expect(c.y).toBeCloseTo(16, 9); // rim at -12+20 = 8, centre 8 above that
  });

  it("a BIG sketch still takes the bias — anchoring all of it aborts the solver", async () => {
    // THE regression this exists for is not a wrong number, it is a THROW. An
    // anchor costs two wasm primitives (a fixed helper point + a temporary
    // coincidence), and planegcs answers an exhausted heap with `Aborted(OOM)`
    // out of solve_system — which escapes compileAndSolve into sketchMode's
    // pump(), where it is read as a dead solver and turns constraint solving off
    // for the WHOLE session ("The 2D constraint solver stopped responding").
    // So on a large sketch, placing the FIRST dimension killed constraint
    // solving on a sketch that dimensioned fine before the bias existed.
    //
    // 300 unconstrained lines + the same rectangle-and-circle fixture: 605
    // solver points, of which exactly FOUR (the rectangle's corners) can move
    // when the circle is the mover. Anchoring the reachable set is 4 anchors;
    // anchoring the sketch is 603, and 603 aborts. The free solve was never in
    // any trouble at this size, which is what makes it a pure regression — so
    // this asserts BOTH, and asserts the policy still holds at the end of it.
    const many = (n: number): any[] => {
      const ents: any[] = [];
      for (let i = 0; i < n; i++) {
        ents.push({ type: "line", id: `L${i}`, x1: 100 + i * 3, y1: 0, x2: 102 + i * 3, y2: 5 });
      }
      return [...ents, ...seed()];
    };
    const free = await compileAndSolve(many(300), dim);
    expect(free.ok).toBe(true); // the size itself is not the problem
    const r = await compileAndSolve(many(300), dim, undefined, { moves: ["e11"] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(rectOf(r).width).toBe(40); // and the policy survived the scoping
    expect(Math.abs(circleOf(r).x - -14)).toBeLessThan(1e-9);
  });
});

// Round-3 review: scoping the anchors to the REACHABLE set is not a bound.
// Reachability spreads through the constraint graph, so a single hub entity
// re-couples the whole sketch and the anchor count is O(connected component)
// again — a circle dimensioned to a line that N others are `parallel` to reaches
// 2N+1 points. Past a few hundred anchors planegcs answers with Aborted(OOM),
// and that throw cannot be recovered from downstream: the abandoned biased pass
// has already taken the heap, so the free retry under it aborts too and the
// throw reaches pump(), which turns constraint solving off for the whole sketch
// session. A sketch that dimensioned fine before the bias existed would lose its
// solver on the FIRST dimension.
describe("bug #86 — a bias too big to pay for is dropped, not attempted", () => {
  const fan = (n: number) => {
    const ents: any[] = [
      { type: "circle", id: "C", x: 0, y: 40, radius: 5 },
      { type: "line", id: "L0", x1: -20, y1: 0, x2: 20, y2: 0 },
    ];
    const cons: any[] = [{ type: "p2lDistance", e: "C", p: 0, line: "L0", value: 20 }];
    for (let i = 0; i < n; i++) {
      ents.push({ type: "line", id: `fanline${i}`, x1: -20, y1: -5 - i, x2: 20, y2: -5 - i });
      cons.push({ type: "parallel", l1: "L0", l2: `fanline${i}` });
    }
    return { ents, cons };
  };

  it("solves a fan past the budget exactly as the free solve would", async () => {
    // What is OBSERVABLE from outside is that the bias was not applied: over the
    // budget the answer must be the free solve's, entity for entity. (An anchored
    // pass that aborts and retries free lands on the same answer, so this cannot
    // witness the allocation itself — the heap cost is invisible to a caller.
    // Stated rather than implied: this pins the CAP's behaviour, not the abort.)
    const cons = fan(200).cons;
    const free = await compileAndSolve(fan(200).ents, cons);
    const biased = await compileAndSolve(fan(200).ents, cons, undefined, { moves: ["C"] });
    expect(biased.ok).toBe(true);
    expect(free.ok).toBe(true);
    // The load-bearing assertion: the bias was DROPPED, not attempted. Nothing
    // in `entities` can say this — an over-budget bias and one that aborted the
    // heap and fell back both return the free answer — which is why the pass
    // reports the decision.
    expect(biased.biasAnchors).toBe(0);
    const y = (r: typeof free, id: string) => {
      const e = r.entities.find((x) => x.id === id);
      if (e?.type !== "line") throw new Error(`${id} lost`);
      return e.y1;
    };
    expect(y(biased, "L0")).toBeCloseTo(y(free, "L0"), 9);
  });

  it("still applies the bias on a sketch inside the budget", async () => {
    // The counter-check: the cap must not quietly disable the policy everywhere.
    // 10 parallels is ~21 reachable points, far under MAX_BIAS_ANCHORS.
    const { ents, cons } = fan(10);
    const biased = await compileAndSolve(ents, cons, undefined, { moves: ["C"] });
    expect(biased.ok).toBe(true);
    expect(biased.biasAnchors).toBeGreaterThan(0); // inside the budget, the policy applies
    const l0 = biased.entities.find((e) => e.id === "L0");
    if (l0?.type !== "line") throw new Error("L0 lost");
    // C was picked, so C moves and the line it was measured FROM stays put.
    // Tolerance, not equality: the solver returns residue on the order of 1e-14
    // and an exact assertion here would be a coin flip on its neighbours — the
    // trap round 3 caught twice in this very file.
    expect(l0.y1).toBeCloseTo(0, 9);
    expect(l0.y2).toBeCloseTo(0, 9);
    const c = biased.entities.find((e) => e.id === "C");
    if (c?.type !== "circle") throw new Error("C lost");
    expect(c.y).toBeCloseTo(20, 6); // the mover absorbed the 20 mm
  });
});
