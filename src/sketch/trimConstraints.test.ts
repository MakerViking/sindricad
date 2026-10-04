// Trim keeps the constraints that still apply to what is left.
//
// Report 356b2693 (skeptic re-check, verified on the reporter's document): an
// arc offset from the outer profile and then TRIMMED lost its offset link, and
// with it the tangency the reporter had built on it. Trim minted a new id for
// every piece it kept, and the modify tail pruned every constraint that named
// the old one, without a word. Trim now rewrites each constraint for the
// pieces, and the piece that is still the curve keeps its id
// (trimKeepsId.test.ts, which also covers what that id must not do).
//
// Each test clicks Trim where a user would (onPointerDown with Trim armed ->
// trimClick), then checks the EFFECT through the real solver where there is one
// to check: a link that survives must still drive the geometry, which is a
// stronger claim than "a constraint object with the right ids exists".

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));

import { SketchMode } from "./sketchMode";
import { offsetEntity } from "./modify";
import { compileAndSolve } from "./sketchSolve";
import { arcCenterRadius } from "./arc";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
type Line = Extract<ResolvedEntity, { type: "line" }>;
type Arc = Extract<ResolvedEntity, { type: "arc" }>;

interface Priv {
  onPointerDown(e: PointerEvent): void;
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
}

/** click Trim at `at` on a SketchMode holding `entities` + `constraints` */
function trimAt(entities: ResolvedEntity[], constraints: SketchConstraint[], at: THREE.Vector2) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  Object.assign(s, {
    active: true, tool: "trim", entities: [...entities], constraints: structuredClone(constraints), patterns: [],
    lastPress: null, selected: new Set<string>(),
    dims: { clearSelection() {} },
    overlay: { setPreview: () => {} },
    planePoint: () => at.clone(),
    pickTol: () => 1,
    refreshActive: () => {},
    requestSolve: () => {},
    onState: () => {},
  });
  const priv = s as unknown as Priv;
  const ev = { button: 0, clientX: 0, clientY: 0, shiftKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {} };
  priv.onPointerDown(ev as unknown as PointerEvent);
  return { entities: priv.entities, constraints: priv.constraints };
}

const radiusOf = (a: ResolvedEntity) => arcCenterRadius(a as Arc)!.r;
const byId = (es: ResolvedEntity[], id: string) => es.find((e) => e.id === id)!;
const DROPPED_ONE = t("sketch.modify.trimDropped", { count: 1 });

beforeEach(() => { toasts.length = 0; });

describe("trim keeps what still applies", () => {
  it("keeps the offset link on a trimmed offset copy, and the link still drives it (356b2693)", async () => {
    // the reporter's sequence: offset an arc, then trim the copy where a line crosses it
    const src: ResolvedEntity = { type: "arc", id: "src", x1: 20, y1: 0, x2: -20, y2: 0, mx: 0, my: 20 };
    const off = offsetEntity([src], 0, -2.413)!;
    const copyId = off.pairs[0]!.cpy;
    const cross: ResolvedEntity = { type: "line", id: "x", x1: 10, y1: 0, x2: 10, y2: 30 };
    const cons: SketchConstraint[] = [{ type: "offset", pairs: off.pairs, value: -2.413 }];
    // trim the copy's right-hand end, beyond the crossing line
    const after = trimAt([...off.entities, cross], cons, v(17.2, 3));
    const link = after.constraints.find((c) => c.type === "offset");
    expect(link, "trim deleted the offset link").toBeDefined();
    const kept = after.entities.find((e) => e.type === "arc" && e.id !== "src") as Arc;
    expect(kept.id, "the trimmed copy is still the copy").toBe(copyId);
    expect(link!.type === "offset" && link!.pairs.map((p) => p.cpy)).toEqual([kept.id]);
    expect(toasts).toEqual([]);

    // the effect: grow the SOURCE to r=25 and the trimmed copy must follow it
    const grown = [...after.constraints, { type: "radius", e: "src", value: 25 } as SketchConstraint];
    const r = await compileAndSolve(after.entities, grown);
    expect(r.conflicts).toEqual([]);
    expect(radiusOf(byId(r.entities, "src"))).toBeCloseTo(25, 6);
    expect(radiusOf(byId(r.entities, kept.id))).toBeCloseTo(25 - 2.413, 6);
  });

  it("keeps a tangency on the arc it trimmed, and it still holds", async () => {
    // arc r=10 tangent to the line y=10 at its top; a vertical line crosses it at x=6
    const ents: ResolvedEntity[] = [
      { type: "arc", id: "a", x1: 10, y1: 0, x2: -10, y2: 0, mx: 0, my: 10 },
      { type: "line", id: "top", x1: -20, y1: 10, x2: 20, y2: 10 },
      { type: "line", id: "x", x1: 6, y1: -5, x2: 6, y2: 5 },
    ];
    const cons: SketchConstraint[] = [{ type: "tangent2", a: "a", b: "top" }];
    const after = trimAt(ents, cons, v(9.6, 2)); // the short end below the crossing
    const arc = after.entities.find((e) => e.type === "arc")!;
    expect(after.constraints).toEqual([{ type: "tangent2", a: arc.id, b: "top" }]);

    // the effect: lift the line 3 mm and the arc must stay on it
    const lifted = after.entities.map((e) => (e.id === "top" ? { ...e, y1: 13, y2: 13 } as ResolvedEntity : e));
    const r = await compileAndSolve(lifted, after.constraints);
    const top = byId(r.entities, "top") as Line;
    const { c, r: rad } = arcCenterRadius(byId(r.entities, arc.id) as Arc)!;
    // the solver's own convergence, against a 3 mm gap without the tangency
    expect(Math.abs(Math.abs(top.y1 - c.y) - rad)).toBeLessThan(1e-4);
  });

  it("keeps a belt a belt: both pulleys trimmed, all four tangencies kept, and it still solves", async () => {
    const drawn: ResolvedEntity[] = [
      { id: "cA", type: "circle", x: 0, y: 0, radius: 10 },
      { id: "cB", type: "circle", x: 40, y: 0, radius: 6 },
      { id: "l1", type: "line", x1: -1, y1: 10.3, x2: 41, y2: 6.2 },
      { id: "l2", type: "line", x1: -1, y1: -10.3, x2: 41, y2: -6.2 },
    ];
    const cons: SketchConstraint[] = [
      { type: "tangent2", a: "l1", b: "cA" }, { type: "tangent2", a: "l1", b: "cB" },
      { type: "tangent2", a: "l2", b: "cA" }, { type: "tangent2", a: "l2", b: "cB" },
    ];
    const solved = await compileAndSolve(drawn, cons);
    expect(solved.conflicts).toEqual([]);
    // trim each pulley's span facing the other one, as a belt is drawn
    let step = trimAt(solved.entities, cons, v(10, 0));
    step = trimAt(step.entities, step.constraints, v(34, 0));
    const arcs = step.entities.filter((e) => e.type === "arc") as Arc[];
    expect(arcs).toHaveLength(2);
    // which arc is which pulley: by centre, so the check does not lean on the ids
    const pulley = new Map(arcs.map((a) => [arcCenterRadius(a)!.c.x < 20 ? "cA" : "cB", a.id] as const));
    const renamed = (id: string) => pulley.get(id as "cA" | "cB") ?? id;
    expect(step.constraints).toEqual(cons.map((c) => (c.type === "tangent2" ? { ...c, b: renamed(c.b) } : c)));
    expect(toasts).toEqual([]);
    // and the belt holds when a pulley moves
    const moved = step.entities.map((e) => (e.id === renamed("cB") ? { ...(e as Arc), x1: (e as Arc).x1 + 5, x2: (e as Arc).x2 + 5, mx: (e as Arc).mx + 5 } as ResolvedEntity : e));
    const r = await compileAndSolve(moved, step.constraints);
    expect(r.conflicts).toEqual([]);
    for (const [l, c] of [["l1", "cA"], ["l1", "cB"], ["l2", "cA"], ["l2", "cB"]] as const) {
      const line = byId(r.entities, l) as Line;
      const { c: ctr, r: rad } = arcCenterRadius(byId(r.entities, renamed(c)) as Arc)!;
      const d = Math.abs((line.x2 - line.x1) * (line.y1 - ctr.y) - (line.x1 - ctr.x) * (line.y2 - line.y1)) /
        Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
      expect(Math.abs(d - rad), `${l} left ${c}`).toBeLessThan(1e-4);
    }
  });

  it("gives a horizontal to BOTH pieces of a line trimmed in the middle", async () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "h", x1: -20, y1: 0, x2: 20, y2: 0 },
      { type: "line", id: "v1", x1: -5, y1: -10, x2: -5, y2: 10 },
      { type: "line", id: "v2", x1: 5, y1: -10, x2: 5, y2: 10 },
    ];
    const after = trimAt(ents, [{ type: "horizontal", line: "h" }], v(0, 0.2));
    const pieces = after.entities.filter((e) => e.type === "line" && e.id !== "v1" && e.id !== "v2") as Line[];
    expect(pieces).toHaveLength(2);
    const held = after.constraints.flatMap((c) => (c.type === "horizontal" ? [c.line] : [])).sort();
    expect(held).toEqual(pieces.map((p) => p.id).sort());

    // the effect: tip both pieces and the solve levels them again
    const tipped = after.entities.map((e) =>
      pieces.some((p) => p.id === e.id) ? { ...(e as Line), y2: (e as Line).y2 + 2 } as ResolvedEntity : e);
    const r = await compileAndSolve(tipped, after.constraints);
    for (const p of pieces) {
      const l = byId(r.entities, p.id) as Line;
      expect(l.y1).toBeCloseTo(l.y2, 6);
    }
  });

  it("follows a coincident on the end that is kept, and holds it", async () => {
    // L ends where M starts, held by an explicit coincident; trim L's START away
    const ents: ResolvedEntity[] = [
      { type: "line", id: "L", x1: 0, y1: 0, x2: 20, y2: 0 },
      { type: "line", id: "M", x1: 20, y1: 0, x2: 20, y2: 20 },
      { type: "line", id: "x", x1: 5, y1: -5, x2: 5, y2: 5 },
    ];
    const cons: SketchConstraint[] = [{ type: "coincident", e1: "L", p1: 1, e2: "M", p2: 0 }];
    const after = trimAt(ents, cons, v(2, 0.1));
    const L = after.entities.find((e) => e.type === "line" && e.id !== "M" && e.id !== "x") as Line;
    expect([L.x1, L.x2]).toEqual([5, 20]);
    expect(after.constraints).toEqual([{ type: "coincident", e1: L.id, p1: 1, e2: "M", p2: 0 }]);

    // the effect: pull M's start 4 mm up and L's end must come with it.
    // Moved apart in the MODEL, so only a real constraint can close the gap:
    // the solver's merge-by-position would not.
    const pulled = after.entities.map((e) => (e.id === "M" ? { ...(e as Line), y1: 4 } as ResolvedEntity : e));
    const r = await compileAndSolve(pulled, after.constraints);
    const L2 = byId(r.entities, L.id) as Line, M2 = byId(r.entities, "M") as Line;
    expect(Math.hypot(L2.x2 - M2.x1, L2.y2 - M2.y1)).toBeLessThan(1e-6);
  });

  it("turns a line-circle tangent into a curve tangent when the circle becomes an arc", async () => {
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "c", x: 0, y: 0, radius: 10 },
      { type: "line", id: "top", x1: -20, y1: 10, x2: 20, y2: 10 },
      { type: "line", id: "x", x1: -20, y1: -3, x2: 20, y2: -3 },
    ];
    // `tangent` takes a CIRCLE only, so kept as it was it would compile to
    // nothing and the next prune would delete it
    const after = trimAt(ents, [{ type: "tangent", line: "top", circle: "c" }], v(0, -10.1));
    const arc = after.entities.find((e) => e.type === "arc")!;
    expect(after.constraints).toEqual([{ type: "tangent2", a: "top", b: arc.id }]);
    const lifted = after.entities.map((e) => (e.id === "top" ? { ...e, y1: 12, y2: 12 } as ResolvedEntity : e));
    const r = await compileAndSolve(lifted, after.constraints);
    const top = byId(r.entities, "top") as Line;
    const { c, r: rad } = arcCenterRadius(byId(r.entities, arc.id) as Arc)!;
    expect(Math.abs(Math.abs(top.y1 - c.y) - rad)).toBeLessThan(1e-4);
  });

  it("carries a Fix on a rectangle corner to the line that corner became", () => {
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "r", x: 50, y: 75, width: 100, height: 150 },
      { type: "line", id: "v", x1: 30, y1: -20, x2: 30, y2: 20 },
    ];
    // corner 0 is the bottom-left, (0,0); trim the bottom edge right of x=30
    const after = trimAt(ents, [{ type: "fix", e: "r", p: 0 }], v(70, 0.3));
    const fix = after.constraints.find((c) => c.type === "fix");
    expect(fix, "the Fix was deleted with the rectangle's id").toBeDefined();
    const owner = byId(after.entities, fix!.type === "fix" ? fix!.e : "") as Line;
    const p = fix!.type === "fix" && fix!.p === 0 ? v(owner.x1, owner.y1) : v(owner.x2, owner.y2);
    expect([p.x, p.y]).toEqual([0, 0]);
  });
});

describe("trim says what it had to remove", () => {
  it("removes a length on the trimmed line, and says so", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 0 },
      { type: "line", id: "x", x1: 30, y1: -5, x2: 30, y2: 5 },
    ];
    // kept, a 40 mm length would drag the 30 mm piece straight back out
    const after = trimAt(ents, [{ type: "distance", line: "L", value: 40 }], v(35, 0.1));
    expect(after.constraints).toEqual([]);
    expect(toasts).toEqual([DROPPED_ONE]);
  });

  it("removes a Fix on an end that was trimmed away, and says so", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 0 },
      { type: "line", id: "x", x1: 30, y1: -5, x2: 30, y2: 5 },
    ];
    const cons: SketchConstraint[] = [{ type: "fix", e: "L", p: 1 }, { type: "fix", e: "L", p: 0 }];
    const after = trimAt(ents, cons, v(35, 0.1));
    const L = after.entities.find((e) => e.id !== "x")!;
    // the start survives, so its Fix does; the end is gone, so its Fix is too
    expect(after.constraints).toEqual([{ type: "fix", e: L.id, p: 0 }]);
    expect(toasts).toEqual([DROPPED_ONE]);
  });

  it("says nothing when nothing had to go", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 0 },
      { type: "line", id: "x", x1: 30, y1: -5, x2: 30, y2: 5 },
    ];
    trimAt(ents, [{ type: "horizontal", line: "L" }], v(35, 0.1));
    expect(toasts).toEqual([]);
  });

  // The line tool joins every corner of a chain with a Coincident, so trimming
  // the overhang past a crossing up to a corner (the commonest trim there is)
  // always cuts a join away. The corner is what the user took apart; a note
  // about it on nearly every trim would only teach people to ignore the note.
  it("takes a corner's join away with the corner it cut off, without a note", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 10, y1: -32, x2: 40, y2: -30 },
      { type: "line", id: "B", x1: 40, y1: -30, x2: 43, y2: -5 },
      { type: "line", id: "x", x1: 35, y1: -40, x2: 35, y2: -20 },
    ];
    const join: SketchConstraint = { type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 };
    const after = trimAt(ents, [join], v(38, -30.1)); // A, between the crossing and the corner
    const A = after.entities.find((e) => e.type === "line" && !["B", "x"].includes(e.id)) as Line;
    expect(A.x2, "the trim cut somewhere else").toBeCloseTo(35, 9);
    expect(after.constraints).toEqual([]);
    expect(toasts).toEqual([]);
    expect(byId(after.entities, "B")).toEqual(ents[1]);

    // ...and only the join goes unsaid: a Fix on the same cut-off end is still counted
    toasts.length = 0;
    trimAt(ents, [join, { type: "fix", e: "A", p: 1 }], v(38, -30.1));
    expect(toasts).toEqual([DROPPED_ONE]);
  });
});

describe("trim keeps a point that was put ON the trimmed curve", () => {
  it("on the piece nearest the point, and it still holds the point there", async () => {
    // base y = 0 from x 0 to 40, crossed at x 10 and x 20; P sits on base at
    // x 30. Trimming the middle span leaves [0,10] (the lead, which has the
    // original start) and [20,40], which is the piece P is on.
    const ents: ResolvedEntity[] = [
      { type: "line", id: "base", x1: 0, y1: 0, x2: 40, y2: 0 },
      { type: "line", id: "x1", x1: 10, y1: -5, x2: 10, y2: 5 },
      { type: "line", id: "x2", x1: 20, y1: -5, x2: 20, y2: 5 },
      { type: "point", id: "P", x: 30, y: 0 },
    ];
    const after = trimAt(ents, [{ type: "pointOn", e: "P", p: 0, curve: "base" }], v(15, 0.1));
    const pieces = after.entities.filter((e) => e.type === "line" && !["x1", "x2"].includes(e.id)) as Line[];
    expect(pieces).toHaveLength(2);
    const right = pieces.find((l) => Math.max(l.x1, l.x2) === 40)!;
    expect(after.constraints).toEqual([{ type: "pointOn", e: "P", p: 0, curve: right.id }]);
    expect(toasts).toEqual([]);

    // the effect: lift the right piece 3 mm and P must go with it
    const lifted = after.entities.map((e) => (e.id === right.id ? { ...e, y1: 3, y2: 3 } as ResolvedEntity : e));
    const r = await compileAndSolve(lifted, after.constraints, undefined, { moves: ["P"] });
    const p = byId(r.entities, "P") as Extract<ResolvedEntity, { type: "point" }>;
    expect(p.y).toBeCloseTo(3, 9);
  });
});
