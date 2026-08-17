// SEMANTIC RATCHET for the constraint tools: does a constraint ACHIEVE ITS
// GEOMETRIC MEANING, and does it do so when the operand is a rectangle corner
// or a rectangle edge?
//
// The three files already here stop one rung short of that, by construction:
//   constraintCoverage.test.ts  — an armed tool must APPLY or SAY something.
//   constraintSequences.test.ts — a rejected constraint must not poison later ones.
//   solveInvariants.ts          — whatever solved is still geometry.
// None of them can tell "perpendicular was applied" from "those two lines are
// now perpendicular". A constraint that compiles to nothing passes all three.
//
// So this file states, for every tool in CONSTRAINT_TOOLS, ONE machine-checkable
// predicate over the SOLVED geometry — the property a user would point at on
// screen and call the constraint by name. It enumerates the set rather than a
// list copied here, so a 13th tool fails the day it lands unless it declares a
// predicate.
//
// Every case carries its own teeth: the predicate must be VIOLATED by the
// starting geometry and SATISFIED after the solve. A fixture that already
// satisfies the predicate would pass even against a solver that did nothing, so
// the before-check is not decoration — it is what makes the after-check mean
// anything. (See "the predicate has teeth" at the bottom for the mutation proof.)
//
// Motivation: "I can select a corner as an endpoint on a rectangle" — a user
// wish from 2026-08-16. A rectangle is not a line: sketchSolve expands it into 4
// corner points + 4 implicit edges (sketchSolve.ts:147-167), and the two point
// resolvers disagree about whether those corners exist (dimPoint knows them,
// endpointPoint does not). That disagreement is invisible to every existing
// test, and it is exactly what the rectangle matrix below pins down.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// no @types/node here (tsconfig types is ["vite/client"]) — same local
// declaration sketchSolve.test.ts uses to reach the real wasm on disk
declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "./sketchSolve";
import { expectSaneGeometry } from "./solveInvariants";
import { ConstraintTools, CONSTRAINT_TOOLS, type ConstraintHost } from "./constraintTools";
import { lineOperand, refPoint, asRound } from "./entityDims";
import { rectCorners } from "./region";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { SketchTool } from "./sketchMode";

// ---------------------------------------------------------------------------
// tolerance
// ---------------------------------------------------------------------------

/** Residual a satisfied constraint must come in under, in mm (or as a unit-vector
 *  dot/cross, which is dimensionless). planegcs converges far tighter than this
 *  on these fixtures — the loosest residual measured while writing the file was
 *  ~2e-10, on a rectangle side length. 1e-6 leaves four orders of headroom over
 *  that without being loose enough to accept a constraint that did nothing: every
 *  case below starts with a residual of at least ~1 mm (asserted, see BEFORE). */
const TOL = 1e-6;

/** How far from satisfied a fixture must START. Without this a case could pass
 *  against a solver that never ran. */
const MIN_VIOLATION = 1e-3;

// ---------------------------------------------------------------------------
// operand resolution — the two addressing conventions, in one place
// ---------------------------------------------------------------------------

type V2 = { x: number; y: number };
type Seg = { x1: number; y1: number; x2: number; y2: number };

const byId = (ents: ResolvedEntity[]) => new Map(ents.map((e) => [e.id, e]));

/** A LINE operand: a plain line id, or the rectangle-edge form `<rectId>~<k>`.
 *  Goes through entityDims.lineOperand, which is the app's own decoder — a
 *  private copy here could agree with the test and disagree with the app. */
function seg(ents: ResolvedEntity[], id: string): Seg {
  const s = lineOperand(byId(ents), id);
  if (!s) throw new Error(`no line operand ${id}`);
  return s;
}

/** A POINT operand (entity id + `p` index). Two conventions reach the solver:
 *   - dimPoint (sketchSolve.ts:241): rectangle corner by index, circle centre,
 *     arc centre at 2, else an endpoint — mirrored by entityDims.dimRefPoints.
 *   - a rectangle EDGE id with p 0/1, which resolves to that edge's two corners
 *     (sketchSolve.ts:161 registers `rect~k` in `ends`, so endpointPoint takes it).
 *  Both are addressable in the document format, so both are resolved here. */
function pt(ents: ResolvedEntity[], eid: string, p: number): V2 {
  if (eid.includes("~")) {
    const s = seg(ents, eid);
    return p === 0 ? { x: s.x1, y: s.y1 } : { x: s.x2, y: s.y2 };
  }
  const e = byId(ents).get(eid);
  if (!e) throw new Error(`no entity ${eid}`);
  const q = refPoint(e, p);
  if (!q) throw new Error(`no point ${eid}[${p}]`);
  return { x: q.x, y: q.y };
}

function round(ents: ResolvedEntity[], id: string): { x: number; y: number; r: number } {
  const e = byId(ents).get(id);
  const c = e ? asRound(e) : null;
  if (!c) throw new Error(`no round ${id}`);
  return c;
}

// ---------------------------------------------------------------------------
// the geometric measures the predicates are built from
// ---------------------------------------------------------------------------

const len = (s: Seg) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
/** unit direction; throws on a collapsed line rather than returning NaN, because
 *  a directionless line makes every angular predicate VACUOUSLY true — the exact
 *  failure mode the zero-length-line guard exists for (sketchSolve.ts:600-620). */
function dir(s: Seg): V2 {
  const l = len(s);
  if (!(l > 1e-9)) throw new Error("line has collapsed — it has no direction");
  return { x: (s.x2 - s.x1) / l, y: (s.y2 - s.y1) / l };
}
const cross = (a: V2, b: V2) => a.x * b.y - a.y * b.x;
const dot = (a: V2, b: V2) => a.x * b.x + a.y * b.y;
const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y);
/** distance from p to the INFINITE line through s (planegcs's own convention —
 *  every line constraint acts on the line, not the segment) */
const perpDist = (p: V2, s: Seg) =>
  Math.abs((p.x - s.x1) * (s.y2 - s.y1) - (p.y - s.y1) * (s.x2 - s.x1)) / len(s);
/** p reflected in the infinite line through s */
function mirror(p: V2, s: Seg): V2 {
  const u = dir(s);
  const t = (p.x - s.x1) * u.x + (p.y - s.y1) * u.y;
  const fx = s.x1 + t * u.x, fy = s.y1 + t * u.y;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
}
const midOf = (s: Seg): V2 => ({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 });

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const L = (id: string, x1: number, y1: number, x2: number, y2: number) =>
  ({ type: "line", id, x1, y1, x2, y2 }) as unknown as ResolvedEntity;
const C = (id: string, x: number, y: number, radius: number) =>
  ({ type: "circle", id, x, y, radius }) as unknown as ResolvedEntity;
/** rectangle centred on (x,y). rectCorners is CCW: 0 bl, 1 br, 2 tr, 3 tl, and
 *  edge `~k` runs corner k → k+1, so ~0 is the bottom and ~1 the right side. */
const RECT = (id: string, x: number, y: number, width: number, height: number) =>
  ({ type: "rectangle", id, x, y, width, height }) as unknown as ResolvedEntity;

// ---------------------------------------------------------------------------
// the predicate table — at least one entry per tool in CONSTRAINT_TOOLS
// ---------------------------------------------------------------------------
//
// A LIST per tool, not a single case, because two of the twelve mean different
// things depending on what you pick and emit a DIFFERENT constraint for each:
// `equal` emits `equal` on two lines and `equalRadius` on two rounds
// (constraintTools.ts:336-343), and `tangent` emits `tangent2`, which the
// compiler then splits eight ways (sketchSolve.ts tangent2 ladder). Covering one
// form and calling the tool checked would leave the other free to compile to
// nothing — the exact bug class this file exists for.

/** The residual of a constraint's own geometric meaning, measured on a solved
 *  entity list. Zero (within TOL) means the constraint holds. A single number
 *  rather than a set of expects, so the same function can prove the fixture
 *  starts violated and ends satisfied. */
type Residual = (ents: ResolvedEntity[]) => number;

interface ToolCase {
  /** what the tool means, in one line — this is the deliverable */
  meaning: string;
  /** which pick shapes this row covers, when the tool has more than one form
   *  (e.g. "two lines" vs "two rounds"); shown in the test name */
  form?: string;
  entities: () => ResolvedEntity[];
  /** clicks that drive the REAL ConstraintTools flow, in plane coords */
  clicks: [number, number][];
  /** the constraint the tool is expected to emit (shape match) */
  emits: Partial<SketchConstraint> & { type: string };
  residual: Residual;
  /** `fix` is the odd one out: its meaning is "does NOT move", which is not a
   *  residual on one solve. Cases that set this get the two-solve treatment. */
  provedByNotMoving?: { pull: SketchConstraint; point: [string, number] };
}

const TOOL_CASES: Record<string, ToolCase[]> = {
  // --- angular, one line -----------------------------------------------------
  horizontal: [{
    meaning: "the line's two endpoints have the same y",
    entities: () => [L("A", 0, 0, 40, 9)],
    clicks: [[20, 4.5]],
    emits: { type: "horizontal", line: "A" },
    residual: (e) => { const s = seg(e, "A"); return Math.abs(s.y1 - s.y2); },
  }],
  vertical: [{
    meaning: "the line's two endpoints have the same x",
    entities: () => [L("A", 0, 0, 9, 40)],
    clicks: [[4.5, 20]],
    emits: { type: "vertical", line: "A" },
    residual: (e) => { const s = seg(e, "A"); return Math.abs(s.x1 - s.x2); },
  }],
  // --- angular, two lines ----------------------------------------------------
  parallel: [{
    meaning: "the two line directions are collinear: |u1 x u2| = 0",
    entities: () => [L("A", 0, 0, 40, 0), L("B", 0, 20, 40, 32)],
    clicks: [[20, 0], [20, 26]],
    emits: { type: "parallel", l1: "A", l2: "B" },
    residual: (e) => Math.abs(cross(dir(seg(e, "A")), dir(seg(e, "B")))),
  }],
  perpendicular: [{
    meaning: "the two line directions are orthogonal: |u1 . u2| = 0",
    entities: () => [L("A", 0, 0, 40, 0), L("B", 0, 20, 40, 32)],
    clicks: [[20, 0], [20, 26]],
    emits: { type: "perpendicular", l1: "A", l2: "B" },
    residual: (e) => Math.abs(dot(dir(seg(e, "A")), dir(seg(e, "B")))),
  }],
  collinear: [{
    meaning: "the two lines share one infinite axis: parallel AND BOTH of l2's "
      + "endpoints lie on l1",
    // BOTH endpoints on purpose. The compile pins only l2's first endpoint
    // (sketchSolve.ts:333) and relies on `parallel` for the second — but
    // `parallel` is vacuous on a collapsed line, which is how a conflicting
    // sketch once "solved" by folding a 65 mm edge to zero. Asserting both ends
    // is what makes that route show up here instead of passing.
    entities: () => [L("A", 0, 0, 40, 0), L("B", 60, 12, 100, 15)],
    clicks: [[20, 0], [80, 13.5]],
    emits: { type: "collinear", l1: "A", l2: "B" },
    residual: (e) => {
      const a = seg(e, "A"), b = seg(e, "B");
      return Math.max(
        Math.abs(cross(dir(a), dir(b))),
        perpDist({ x: b.x1, y: b.y1 }, a),
        perpDist({ x: b.x2, y: b.y2 }, a),
      );
    },
  }],
  // --- size ------------------------------------------------------------------
  equal: [{
    meaning: "the two lines have the same length",
    form: "two lines",
    entities: () => [L("A", 0, 0, 40, 0), L("B", 0, 20, 25, 20)],
    clicks: [[20, 0], [12, 20]],
    emits: { type: "equal", l1: "A", l2: "B" },
    residual: (e) => Math.abs(len(seg(e, "A")) - len(seg(e, "B"))),
  }, {
    // The tool's OTHER form. Two rounds emit `equalRadius`, not `equal`
    // (constraintTools.ts:342), and the compiler then splits it three ways by
    // circle/arc mix. Covering only the line form would leave this one free to
    // compile to nothing — the emits check below is what pins which of the two
    // the click flow chose.
    meaning: "the two rounds have the same radius",
    form: "two rounds",
    entities: () => [C("K1", 0, 0, 20), C("K2", 60, 0, 9)],
    clicks: [[20, 0], [69, 0]], // each click is dead on that circle's rim
    emits: { type: "equalRadius", a: "K1", b: "K2" },
    residual: (e) => Math.abs(round(e, "K1").r - round(e, "K2").r),
  }],
  // --- curve contact ---------------------------------------------------------
  tangent: [{
    meaning: "line + round: the centre's distance to the line equals the radius",
    form: "line + circle",
    entities: () => [L("A", -40, 0, 40, 0), C("K", 0, 18, 10)],
    clicks: [[0, 8], [0, 0]], // the circle's rim first (tangent wants a curve), then the line
    emits: { type: "tangent2", a: "K", b: "A" },
    residual: (e) => { const k = round(e, "K"); return Math.abs(perpDist(k, seg(e, "A")) - k.r); },
  }, {
    // AMBIGUOUS BY DESIGN, and worth stating rather than hiding: two circles are
    // tangent either externally (d = r1 + r2) or internally (d = |r1 - r2|), and
    // the tool gives the user no way to choose. So the predicate has to accept
    // EITHER branch. Note what that costs: unlike the rim dims, which pin their
    // branch across a later solve (rimBranch, sketchSolve.ts:685), nothing here
    // stops a tangency flipping from external to internal on an unrelated edit
    // and still "holding". This row asserts tangency, not which kind.
    meaning: "round + round: the centres are one sum-of-radii OR one "
      + "difference-of-radii apart (either tangency branch)",
    form: "two circles",
    entities: () => [C("K1", 0, 0, 20), C("K2", 60, 0, 9)],
    clicks: [[20, 0], [69, 0]],
    emits: { type: "tangent2", a: "K1", b: "K2" },
    residual: (e) => {
      const a = round(e, "K1"), b = round(e, "K2");
      const d = dist(a, b);
      return Math.min(Math.abs(d - (a.r + b.r)), Math.abs(d - Math.abs(a.r - b.r)));
    },
  }],
  // --- points ----------------------------------------------------------------
  coincident: [{
    meaning: "the two picked points are at the same position",
    entities: () => [L("A", 0, 0, 40, 0), L("B", 44, 6, 80, 6)],
    clicks: [[40, 0], [44, 6]],
    emits: { type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 },
    residual: (e) => dist(pt(e, "A", 1), pt(e, "B", 0)),
  }],
  concentric: [{
    meaning: "the two rounds share a centre",
    entities: () => [C("K1", 0, 0, 20), C("K2", 6, 4, 9)],
    clicks: [[20, 0], [15, 4]],
    emits: { type: "concentric", c1: "K1", c2: "K2" },
    residual: (e) => dist(round(e, "K1"), round(e, "K2")),
  }],
  midpoint: [{
    meaning: "the picked point sits at the midpoint of the line's two endpoints",
    entities: () => [L("A", 0, 0, 40, 0), L("B", 5, -30, 8, -12)],
    clicks: [[8, -12], [20, 0]], // the point, then the line to centre it on
    emits: { type: "midpoint", e: "B", p: 1, line: "A" },
    residual: (e) => dist(pt(e, "B", 1), midOf(seg(e, "A"))),
  }],
  symmetric: [{
    meaning: "each picked point is the other's reflection in the INFINITE axis line",
    // Ambiguity worth naming: planegcs mirrors about the infinite line, not the
    // picked SEGMENT, and the two points are interchangeable (no branch to pick).
    entities: () => [L("AX", 0, -50, 0, 50), L("A", -30, 20, -20, 24), L("B", 26, 8, 40, 8)],
    clicks: [[-30, 20], [26, 8], [0, 0]], // point, point, then the axis
    emits: { type: "symmetric", e1: "A", p1: 0, e2: "B", p2: 0, line: "AX" },
    residual: (e) => dist(mirror(pt(e, "A", 0), seg(e, "AX")), pt(e, "B", 0)),
  }],
  // --- pinning ---------------------------------------------------------------
  fix: [{
    meaning: "the pinned point does not move under a later solve that would "
      + "otherwise have moved it",
    entities: () => [L("A", 10, 10, 50, 30)],
    clicks: [[10, 10]],
    emits: { type: "fix", e: "A", p: 0 },
    // The pull has to be one that actually moves p0 when it is NOT pinned, or
    // "it did not move" proves nothing. `horizontal` is not such a pull —
    // planegcs happens to satisfy it by moving p1 alone, so a fix that compiled
    // to nothing would still pass. Stretching the line to 90 mm moves both ends
    // (measured: p0 goes to (-3.06, 3.47)), which is why the case below asserts
    // the control moves it before asserting the pin holds it.
    provedByNotMoving: { pull: { type: "distance", line: "A", value: 90 } as SketchConstraint, point: ["A", 0] },
    residual: () => 0, // unused: see provedByNotMoving
  }],
};

// ---------------------------------------------------------------------------
// the host: the REAL ConstraintTools flow, with SketchMode's accept/withdraw rule
// ---------------------------------------------------------------------------

class Host implements ConstraintHost {
  _tool: SketchTool = "select";
  _ents: ResolvedEntity[] = [];
  _cons: SketchConstraint[] = [];
  _fillet: number | null = null;
  warnings: string[] = [];
  pending: { x: number; y: number } | null = null;
  tool() { return this._tool; }
  entities() { return this._ents; }
  constraints() { return this._cons; }
  pickTol() { return 2; }
  getFilletFirst() { return this._fillet; }
  setFilletFirst(i: number | null) { this._fillet = i; }
  requestSolve() {}
  warn(m: string) { this.warnings.push(m); }
  setPendingPoint(p: { x: number; y: number } | null) { this.pending = p; }
  addConstraint(c: SketchConstraint) { this._cons.push(c); }
}

/** Drive the real tool with real clicks and return what it emitted. */
function applyByClicking(tool: SketchTool, ents: ResolvedEntity[], clicks: [number, number][]) {
  const h = new Host();
  h._ents = ents;
  h._tool = tool;
  const ct = new ConstraintTools(h);
  for (const [x, y] of clicks) ct.click(new THREE.Vector2(x, y));
  return h;
}

async function solved(ents: ResolvedEntity[], cons: SketchConstraint[]) {
  const r = await compileAndSolve(ents, cons);
  expect(r.conflicts, "the fixture must not be a conflicting sketch").toEqual([]);
  expect(r.ok, "the solve must succeed").toBe(true);
  return r.entities;
}

// ---------------------------------------------------------------------------
// 1. THE SEMANTIC RATCHET
// ---------------------------------------------------------------------------

const TOOLS = [...CONSTRAINT_TOOLS];

/** every declared row, flattened, each tagged with the tool it belongs to —
 *  what the ratchet iterates, so a tool's SECOND form is a first-class case */
const ROWS: { tool: SketchTool; label: string; spec: ToolCase }[] = TOOLS.flatMap((t) =>
  (TOOL_CASES[t] ?? []).map((spec) => ({
    tool: t,
    label: spec.form ? `${t} (${spec.form})` : t,
    spec,
  })),
);

describe("every constraint tool declares a machine-checkable meaning", () => {
  it("covers every tool in CONSTRAINT_TOOLS", () => {
    // The ratchet. A 13th tool lands with no predicate and this is what says so.
    const missing = TOOLS.filter((t) => !TOOL_CASES[t]?.length);
    expect(missing, "these tools have no geometric predicate declared").toEqual([]);
    // and nothing here is testing a tool the app no longer exposes
    const stale = Object.keys(TOOL_CASES).filter((t) => !CONSTRAINT_TOOLS.has(t as SketchTool));
    expect(stale, "predicates declared for tools that are not in CONSTRAINT_TOOLS").toEqual([]);
  });

  it.each(ROWS)("$label achieves its geometric meaning after a real solve", async ({ tool, label, spec }) => {
    const start = spec.entities();

    // 1. the REAL tool, driven by REAL clicks, must emit the constraint
    const h = applyByClicking(tool, start, spec.clicks);
    expect(h._cons, `${label}: the click flow emitted no constraint (warnings: ${h.warnings.join(" | ")})`)
      .toHaveLength(1);
    // WHICH constraint matters as much as that there is one: `equal` and
    // `tangent` each pick between two emissions by what was clicked, so a flow
    // that fell into the wrong branch must fail here, before any geometry is
    // measured.
    expect(h._cons[0]).toMatchObject(spec.emits);

    if (spec.provedByNotMoving) {
      // `fix`: pin, then apply something that would otherwise move the pinned
      // point, and require it to be exactly where it started.
      const { pull, point } = spec.provedByNotMoving;
      const before = pt(start, point[0], point[1]);
      const withoutFix = await solved(start, [pull]);
      // the pull must be a real pull, or "did not move" proves nothing
      expect(dist(pt(withoutFix, point[0], point[1]), before),
        `${label}: the control constraint does not move the point, so the fix proves nothing`)
        .toBeGreaterThan(MIN_VIOLATION);
      const withFix = await solved(start, [...h._cons, pull]);
      expect(dist(pt(withFix, point[0], point[1]), before),
        `${label}: the pinned point moved`).toBeLessThanOrEqual(TOL);
      return;
    }

    // 2. the fixture must START violated, or the after-check proves nothing
    expect(spec.residual(start),
      `${label}: the fixture already satisfies the predicate — it cannot show the solve did anything`)
      .toBeGreaterThan(MIN_VIOLATION);

    // 3. and the solved geometry must satisfy it
    const after = await solved(start, h._cons);
    expect(spec.residual(after), `${label}: ${spec.meaning}`).toBeLessThanOrEqual(TOL);
  });
});

// ---------------------------------------------------------------------------
// 2. THE RECTANGLE-OPERAND MATRIX
// ---------------------------------------------------------------------------
//
// What the user asked for. A rectangle is one atomic entity in the document; the
// solver expands it into 4 corner points + 4 implicit edges carrying
// horizontal/vertical rules (sketchSolve.ts:147-167). So there are two things a
// constraint might be pointed at:
//
//   a rect EDGE   — `"<rectId>~<k>"`, registered in `ends` (sketchSolve.ts:161),
//                   so every line-operand compile branch already takes it.
//   a rect CORNER — the rectangle's own id with p = 0..3 (entityDims.ts:444
//                   dimRefPoints), which reaches the solver ONLY through
//                   dimPoint (sketchSolve.ts:241). The point-pair constraints
//                   resolve through endpointPoint (sketchSolve.ts:225) instead,
//                   and endpointPoint does not know rectMap.
//
// The matrix below states, per tool, which of those is legal and what must hold.

/** The rectangle's own contract, which no existing post-condition asserts:
 *  still axis-aligned (its 4 implicit horizontal/vertical rules), opposite sides
 *  still equal, and — the one that bites — still has AREA.
 *
 *  solveInvariants.expectSaneGeometry has no `rectangle` case at all (it switches
 *  on line/circle/arc/point and falls through), and the solve guard's
 *  zero-length-line scan only walks entities whose type IS "line"
 *  (sketchSolve.ts:612), which a rectangle never is. A rectangle that solves to
 *  zero width or zero height therefore passes both. */
function expectStillRectangular(ents: ResolvedEntity[], id: string, where: string) {
  const e = byId(ents).get(id);
  if (!e || e.type !== "rectangle") throw new Error(`${where}: ${id} is not a rectangle`);
  const c = rectCorners(e.x, e.y, e.width, e.height);
  const [bl, br, tr, tl] = c as [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2];
  expect(e.width, `${where}: ${id} collapsed to zero width`).toBeGreaterThan(MIN_VIOLATION);
  expect(e.height, `${where}: ${id} collapsed to zero height`).toBeGreaterThan(MIN_VIOLATION);
  // the four implicit rules, read back off the solved corners
  expect(Math.abs(bl.y - br.y), `${where}: ${id} bottom edge is no longer horizontal`).toBeLessThanOrEqual(TOL);
  expect(Math.abs(tl.y - tr.y), `${where}: ${id} top edge is no longer horizontal`).toBeLessThanOrEqual(TOL);
  expect(Math.abs(br.x - tr.x), `${where}: ${id} right edge is no longer vertical`).toBeLessThanOrEqual(TOL);
  expect(Math.abs(bl.x - tl.x), `${where}: ${id} left edge is no longer vertical`).toBeLessThanOrEqual(TOL);
  // opposite sides equal (a rectangle, not merely an axis-aligned quad)
  expect(Math.abs(dist(bl, br) - dist(tl, tr)), `${where}: ${id} horizontal sides differ`).toBeLessThanOrEqual(TOL);
  expect(Math.abs(dist(bl, tl) - dist(br, tr)), `${where}: ${id} vertical sides differ`).toBeLessThanOrEqual(TOL);
}

/** What pointing this tool at a rectangle is EXPECTED to do. Stating the outcome
 *  per row is the point of the matrix: "the constraint holds", "it was already
 *  true", and "the solver satisfies it by destroying the rectangle" are three
 *  different answers, and lumping them together is how the third one hides. */
type RectOutcome =
  /** the predicate holds on the solved geometry, and the rectangle survives */
  | "satisfied"
  /** already true of a rectangle by construction — the solve succeeds and the
   *  constraint comes back reported as over-defined (removable), which is the
   *  correct answer, not a failure */
  | "redundant"
  /** BUG, pinned here rather than hidden: the constraint contradicts one of the
   *  rectangle's own implicit horizontal/vertical rules, and planegcs satisfies
   *  the contradiction by shrinking the edge to zero length — at which point it
   *  has no direction and every angular constraint on it is vacuous. The solve
   *  reports ok with an empty conflict list and the flattened rectangle is
   *  written into the document. */
  | "collapses";

interface RectCase {
  /** which rectangle part this tool is pointed at. "corner (via edge id)" is a
   *  distinct answer from "corner": the point-pair constraints can only reach a
   *  corner through the EDGE id `R~k`, never through the rectangle id + corner
   *  index the document format defines (see the corner gap below). */
  operand: "edge" | "corner" | "corner (via edge id)";
  outcome: RectOutcome;
  entities: () => ResolvedEntity[];
  constraints: SketchConstraint[];
  /** the tool's own predicate, measured on the rectangle operand. Not read for
   *  `collapses` rows — a collapsed edge satisfies every angular predicate
   *  vacuously, which is exactly why those rows assert the geometry instead. */
  residual: Residual;
  /** `fix` again: a pin's meaning is "does not move", so its case names the
   *  point and the pull instead of a residual. */
  provedByNotMoving?: { pull: SketchConstraint; point: [string, number] };
}

/** Tools that cannot take a rectangle operand at all, and why. Stated rather
 *  than omitted, so "not covered" and "not applicable" stay distinguishable. */
const RECT_NOT_APPLICABLE: Partial<Record<string, string>> = {
  concentric: "a rectangle has no centre — concentric compiles centerPoint(), which "
    + "resolves circles and arcs only (sketchSolve.ts:237)",
};

const RECT_CASES: Record<string, RectCase> = {
  // --- rect EDGE as a line operand ------------------------------------------
  horizontal: {
    operand: "edge",
    outcome: "redundant",
    // A rectangle's bottom edge is already horizontal, by the implicit `~h0`
    // rule sketchSolve pushes for it (sketchSolve.ts:163). So the honest answer
    // for this tool is not "it works" but "there was nothing to do", and the
    // solver says so: over-defined names the user constraint and the rectangle
    // is untouched. Measured: over = ["k0"], 40x20 in and out.
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [{ type: "horizontal", line: "R~0" } as SketchConstraint],
    residual: (e) => { const s = seg(e, "R~0"); return Math.abs(s.y1 - s.y2); },
  },
  vertical: {
    operand: "edge",
    outcome: "collapses",
    // THE most reachable instance of the bug, and the plainest: click Vertical,
    // then a rectangle's bottom edge. That edge is already pinned horizontal by
    // the rectangle's own rule, so "vertical" is a flat contradiction and the
    // only geometry satisfying both is a zero-length edge. planegcs finds it,
    // reports success, and the document gets a 0 x 20 rectangle.
    //
    // The same contradiction on a plain LINE is refused — see the control in
    // "a rectangle can be solved out of existence" below. The difference is the
    // guard: its collapse scan walks entities whose type IS "line"
    // (sketchSolve.ts:612), and a rectangle never is one.
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [{ type: "vertical", line: "R~0" } as SketchConstraint],
    residual: (e) => { const s = seg(e, "R~0"); return Math.abs(s.x1 - s.x2); },
  },
  parallel: {
    operand: "edge",
    outcome: "satisfied",
    // R~1 is the right side, vertical by the rectangle's own rule, so parallel
    // to it means A must become vertical. A starts steep, which is what keeps
    // the solver rotating A instead of flattening R — start A nearly horizontal
    // instead and this same constraint collapses the rectangle (measured; see
    // the collapse section).
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 69, 40)],
    constraints: [{ type: "parallel", l1: "R~1", l2: "A" } as SketchConstraint],
    residual: (e) => Math.abs(cross(dir(seg(e, "R~1")), dir(seg(e, "A")))),
  },
  perpendicular: {
    operand: "edge",
    outcome: "satisfied",
    // R~0 is the bottom edge, horizontal, so A must become vertical. Same
    // caveat as parallel above, and it is worth being blunt about it: this row
    // passes because A starts steep. Of five starting angles measured, two
    // collapsed the rectangle instead. The row proves the constraint CAN be
    // achieved on a rect edge, not that it always is.
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 69, 40)],
    constraints: [{ type: "perpendicular", l1: "R~0", l2: "A" } as SketchConstraint],
    residual: (e) => Math.abs(dot(dir(seg(e, "R~0")), dir(seg(e, "A")))),
  },
  collinear: {
    operand: "edge",
    outcome: "satisfied",
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", 60, 3, 100, 5)],
    constraints: [{ type: "collinear", l1: "R~0", l2: "A" } as SketchConstraint],
    residual: (e) => {
      const a = seg(e, "R~0"), b = seg(e, "A");
      return Math.max(
        Math.abs(cross(dir(a), dir(b))),
        perpDist({ x: b.x1, y: b.y1 }, a),
        perpDist({ x: b.x2, y: b.y2 }, a),
      );
    },
  },
  equal: {
    operand: "edge",
    outcome: "satisfied",
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", 100, 0, 130, 0)],
    constraints: [{ type: "equal", l1: "R~0", l2: "A" } as SketchConstraint],
    residual: (e) => Math.abs(len(seg(e, "R~0")) - len(seg(e, "A"))),
  },
  tangent: {
    operand: "edge",
    outcome: "satisfied",
    entities: () => [RECT("R", 0, 0, 40, 20), C("K", 0, 30, 8)],
    constraints: [{ type: "tangent2", a: "K", b: "R~2" } as SketchConstraint],
    residual: (e) => { const k = round(e, "K"); return Math.abs(perpDist(k, seg(e, "R~2")) - k.r); },
  },
  midpoint: {
    operand: "edge",
    outcome: "satisfied",
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", 5, -30, 5, -20)],
    constraints: [{ type: "midpoint", e: "A", p: 1, line: "R~0" } as SketchConstraint],
    residual: (e) => dist(pt(e, "A", 1), midOf(seg(e, "R~0"))),
  },
  // --- rect CORNER as a point operand ---------------------------------------
  fix: {
    operand: "corner",
    outcome: "satisfied",
    // The one tool that reaches a rectangle corner end to end today: fixClick
    // picks through dimRefPoints (constraintTools.ts:361) and the compile
    // resolves through dimPoint (sketchSolve.ts:326), and both know rectangles.
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [
      { type: "fix", e: "R", p: 2 } as SketchConstraint,
      { type: "distance", line: "R~0", value: 25 } as SketchConstraint,
    ],
    // corner 2 = tr = (20,10). Shrinking the bottom edge to 25 moves it to
    // (9.186, 10) when nothing is pinned, so the pin has something to hold.
    residual: (e) => dist(pt(e, "R", 2), { x: 20, y: 10 }),
    provedByNotMoving: { pull: { type: "distance", line: "R~0", value: 25 } as SketchConstraint, point: ["R", 2] },
  },
  coincident: {
    operand: "corner (via edge id)",
    outcome: "satisfied",
    // A rect corner IS reachable by a point-pair constraint — but only through
    // the EDGE id, `R~0` p0, which is corner 0. That is the side effect
    // sketchSolve.ts:157-160 predicts in its own comment. The rectangle id with
    // a corner index does NOT work; see "the corner gap" below.
    //
    // The pull here is deliberately SMALL. A large one is satisfied by mirroring
    // the rectangle, and the write-back then relabels its corners — see "a
    // rectangle corner constraint can destroy the rectangle" below, which is the
    // most important thing in this file.
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", -24, -14, 10, -14)],
    constraints: [{ type: "coincident", e1: "A", p1: 0, e2: "R~0", p2: 0 } as SketchConstraint],
    residual: (e) => dist(pt(e, "A", 0), pt(e, "R~0", 0)),
  },
  symmetric: {
    operand: "corner (via edge id)",
    outcome: "satisfied",
    // Two rect corners, addressed through the two edge ids that carry them,
    // mirrored about a vertical line: R~0 p0 is corner 0 (bl) and R~1 p0 is
    // corner 1 (br). Already true for a centred rectangle, so the fixture puts
    // the axis off-centre and requires the rectangle to slide onto it.
    entities: () => [RECT("R", 12, 0, 40, 20), L("AX", 0, -50, 0, 50)],
    constraints: [
      { type: "vertical", line: "AX" } as SketchConstraint,
      { type: "symmetric", e1: "R~0", p1: 0, e2: "R~1", p2: 0, line: "AX" } as SketchConstraint,
    ],
    residual: (e) => dist(mirror(pt(e, "R~0", 0), seg(e, "AX")), pt(e, "R~1", 0)),
  },
};

describe("the rectangle-operand matrix", () => {
  it("says something about every constraint tool", () => {
    // Same ratchet shape as above: a tool with neither a rectangle case nor a
    // stated reason it cannot have one is a hole in the matrix, not a pass.
    const unstated = TOOLS.filter((t) => !RECT_CASES[t] && !RECT_NOT_APPLICABLE[t]);
    expect(unstated, "these tools say nothing about rectangle operands").toEqual([]);
  });

  const CASES = TOOLS.filter((t) => RECT_CASES[t]);
  it.each(CASES)("%s on a rectangle operand", async (tool) => {
    const spec = RECT_CASES[tool]!;
    const start = spec.entities();
    const where = `${tool} on a rectangle ${spec.operand}`;

    if (spec.outcome === "collapses") {
      // Pinning a BUG, not blessing it. The day the guard learns about
      // rectangles this test fails, and that failure is the signal to move this
      // row to "satisfied" (or to "conflict", if the fix refuses it instead —
      // refusing is the right answer here, since the constraint really is
      // unsatisfiable).
      const r = await compileAndSolve(start, spec.constraints);
      expect(r.ok, `${where}: now refused — good, update this row`).toBe(true);
      expect(r.conflicts, `${where}: now blamed — good, update this row`).toEqual([]);
      expect(() => expectStillRectangular(r.entities, "R", where),
        `${where}: the rectangle survived — the collapse is fixed, update this row`)
        .toThrow(/collapsed to zero/);
      return;
    }

    if (spec.outcome === "redundant") {
      // Already true by construction. The solve must succeed, leave the
      // rectangle alone, and SAY the constraint was removable — a silent
      // acceptance would be indistinguishable from one that did something.
      const r = await compileAndSolve(start, spec.constraints);
      expect(r.ok, `${where}: the solve failed`).toBe(true);
      expect(r.conflicts, `${where}: an already-true constraint must not conflict`).toEqual([]);
      expect(r.overDefined.length, `${where}: an already-true constraint was not reported as over-defined`)
        .toBeGreaterThan(0);
      expect(spec.residual(r.entities), `${where}: ${TOOL_CASES[tool]?.[0]?.meaning}`).toBeLessThanOrEqual(TOL);
      expectStillRectangular(r.entities, "R", where);
      return;
    }

    if (spec.provedByNotMoving) {
      const { pull, point } = spec.provedByNotMoving;
      const before = pt(start, point[0], point[1]);
      const withoutPin = await solved(start, [pull]);
      expect(dist(pt(withoutPin, point[0], point[1]), before),
        `${tool}: the control does not move the corner, so the pin proves nothing`)
        .toBeGreaterThan(MIN_VIOLATION);
      const after = await solved(start, spec.constraints);
      expect(dist(pt(after, point[0], point[1]), before),
        `${tool}: the pinned rectangle corner moved`).toBeLessThanOrEqual(TOL);
      expectStillRectangular(after, "R", where);
      return;
    }

    expect(spec.residual(start),
      `${tool}: the rectangle fixture already satisfies the predicate`)
      .toBeGreaterThan(MIN_VIOLATION);
    const after = await solved(start, spec.constraints);
    expect(spec.residual(after), `${tool}: rectangle operand — ${TOOL_CASES[tool]?.[0]?.meaning}`)
      .toBeLessThanOrEqual(TOL);
    expectStillRectangular(after, "R", where);
  });

  it("a rect-edge constraint may legitimately MOVE and RESIZE the rectangle", async () => {
    // Saying so explicitly, because "stays a rectangle" above is deliberately
    // weaker than "stays the same rectangle" and the difference is not obvious.
    // A free rectangle has 4 DOF; planegcs spreads the correction over
    // everything free, so constraining one edge routinely changes the
    // rectangle's SIZE even though the user only pointed at a line.
    //
    // That is correct solver behaviour, not a bug — but it is a UX surprise
    // worth knowing about before rect edges become clickable: the user applies
    // Perpendicular to a line and watches their rectangle shrink.
    const start = [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 69, 40)];
    const after = await solved(start, [{ type: "perpendicular", l1: "R~0", l2: "A" } as SketchConstraint]);
    const R = byId(after).get("R") as { width: number; height: number } | undefined;
    expectStillRectangular(after, "R", "perpendicular resize");
    expect(R?.width, "the rectangle was resized by a constraint on one of its edges")
      .not.toBeCloseTo(40, 3);
  });
});

// ---------------------------------------------------------------------------
// 3. THE CORNER GAP — what the user actually asked for, and what is missing
// ---------------------------------------------------------------------------
//
// "I can select a corner as an endpoint on a rectangle." Today you cannot, at
// either layer, and the failure is SILENT at both. These tests pin the current
// behaviour so the day it changes, it changes visibly.

describe("a rectangle corner as a point operand: the two silent gaps", () => {
  const POINT_PAIR_TOOLS = ["coincident", "midpoint", "symmetric"] as const;

  it.each(POINT_PAIR_TOOLS)(
    "%s cannot PICK a rectangle corner (pickEndpoint never looks at rectangles)",
    (tool) => {
      // constraintTools.pickEndpoint (constraintTools.ts:158-187) enumerates
      // line / arc / point / spline / projected. `rectangle` is not in that
      // list, so a click dead on a corner finds nothing.
      const ents = [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 100, 3)];
      const h = applyByClicking(tool, ents, [[20, 10]]); // exactly corner 2 (tr)
      expect(h._cons, `${tool} now picks a rectangle corner — move it into the matrix above`)
        .toHaveLength(0);
      expect(h.pending, `${tool} armed a pending point on a rectangle corner`).toBeNull();
      // it does at least SAY so (the affordance ratchet's property)
      expect(h.warnings.length, `${tool}: silent miss on a rectangle corner`).toBeGreaterThan(0);
    },
  );

  it("no line-based tool can PICK a rectangle edge either", () => {
    // curveKind (entityDims.ts:301) returns undefined for a rectangle, so every
    // line-operand tool falls straight through to missed(). The rect-edge cases
    // in the matrix above therefore reach the solver only from the DIMENSION
    // tool or from a saved file — never from a constraint click.
    for (const tool of ["horizontal", "vertical", "parallel", "perpendicular", "collinear", "equal", "tangent"] as SketchTool[]) {
      const ents = [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 100, 3), C("K", 0, 60, 8)];
      const h = applyByClicking(tool, ents, [[0, -10]]); // dead on the bottom edge
      expect(h._cons, `${tool} now picks a rectangle edge — move it into the matrix above`)
        .toHaveLength(0);
      expect(h.warnings.length, `${tool}: silent miss on a rectangle edge`).toBeGreaterThan(0);
    }
  });

  it.each(["coincident", "midpoint", "symmetric"] as const)(
    "%s with a rectangle id + corner index compiles to NOTHING",
    async (kind) => {
      // The second gap, below the picker: even handed the constraint directly
      // (from a file, or from a future picker), the compile drops it. These
      // three resolve points through endpointPoint (sketchSolve.ts:225), which
      // consults ends / arcMap / pointMap / splineMap — never rectMap. `fix`,
      // p2pDistance and p2lDistance go through dimPoint (sketchSolve.ts:241)
      // instead, which does know rectangle corners. Same document convention,
      // two resolvers, one of them blind.
      const start: ResolvedEntity[] = [RECT("R", 0, 0, 40, 20), L("A", 30, 30, 60, 30), L("AX", -60, -50, -60, 50)];
      const c: Record<string, SketchConstraint> = {
        coincident: { type: "coincident", e1: "A", p1: 0, e2: "R", p2: 2 } as SketchConstraint,
        midpoint: { type: "midpoint", e: "R", p: 0, line: "A" } as SketchConstraint,
        symmetric: { type: "symmetric", e1: "R", p1: 0, e2: "R", p2: 1, line: "AX" } as SketchConstraint,
      };
      const free = await compileAndSolve(start, []);
      const withIt = await compileAndSolve(start, [c[kind]!]);
      // A constraint that reached the solver removes DOF. This one does not:
      // same DOF, no conflict, no redundancy report — nothing at all.
      expect(withIt.dof, `${kind} on a rectangle corner now removes DOF — the gap is closed, update this test`)
        .toBe(free.dof);
      expect(withIt.conflicts, `${kind}: silently dropped, so nothing is reported`).toEqual([]);
      expect(withIt.overDefined, `${kind}: silently dropped, so nothing is reported`).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. THE CORNER CONSTRAINT THAT DESTROYS THE RECTANGLE
// ---------------------------------------------------------------------------

describe("a rectangle corner constraint can destroy the rectangle", () => {
  // THE headline finding, and the direct answer to "can I select a corner as an
  // endpoint on a rectangle": through the edge id you can, and for a big enough
  // pull it eats the rectangle on the SECOND solve.
  //
  // Why. The write-back rebuilds a rectangle from the MIN/MAX bounding box of
  // its four solved corner points (sketchSolve.ts:540-548). That is lossless
  // only while the solved rectangle keeps its original corner ORDER. A
  // constraint that drags corner 0 past corner 2 is satisfied by MIRRORING the
  // rectangle, and the bbox then relabels the corners: the point the solver
  // moved becomes corner 2 in the document, and document corner 0 is somewhere
  // the constraint never asked for. The next compile re-derives the corners from
  // x/y/w/h, so the constraint's own point has jumped to the far end of the
  // diagonal — and the solver closes that gap the only way still open to it, by
  // shrinking the rectangle to nothing.
  //
  // Every solve reports ok:true with an empty conflict list, and the collapse
  // scan cannot see it (it walks `line` entities only — sketchSolve.ts:612), so
  // the rectangle simply disappears.
  const start = () => [RECT("R", 0, 0, 40, 20), L("A", 30, 30, 60, 30)];
  const pullCornerAcross = [
    { type: "coincident", e1: "A", p1: 0, e2: "R~0", p2: 0 } as SketchConstraint,
  ];

  it("solve 1: the constraint holds in the SOLVER but is false in the document", async () => {
    const r = await compileAndSolve(start(), pullCornerAcross);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    // A's endpoint is where it was; the rectangle moved. But document corner 0
    // is NOT on it — the bbox relabelled it to the opposite corner.
    const gap = dist(pt(r.entities, "A", 0), pt(r.entities, "R~0", 0));
    expect(gap, "corner 0 landed on the coincident point after all — the write-back "
      + "was fixed, so this test and the matrix's coincident case should merge")
      .toBeGreaterThan(MIN_VIOLATION);
    // and it is the OPPOSITE corner that carries the constrained position
    expect(dist(pt(r.entities, "A", 0), pt(r.entities, "R", 2)),
      "the solver's corner 0 was relabelled as document corner 2").toBeLessThanOrEqual(TOL);
  });

  it("solve 2: re-solving the same constraint set collapses it to a point", async () => {
    // SketchMode pumps a solve on every constraint change and every drag frame,
    // so "the second solve" is not a contrived scenario — it is the next frame.
    const once = await compileAndSolve(start(), pullCornerAcross);
    const twice = await compileAndSolve(once.entities, pullCornerAcross);
    const R2 = byId(twice.entities).get("R") as { width: number; height: number } | undefined;

    expect(twice.ok, "and it still reports success").toBe(true);
    expect(twice.conflicts, "and blames nothing").toEqual([]);
    expect(R2?.width, "the rectangle has zero width").toBeLessThan(MIN_VIOLATION);
    expect(R2?.height, "the rectangle has zero height").toBeLessThan(MIN_VIOLATION);
    // nothing in the existing post-conditions catches it; the rectangle check
    // this file adds does
    expect(() => expectStillRectangular(twice.entities, "R", "after two solves"))
      .toThrow(/collapsed to zero/);
  });
});

// ---------------------------------------------------------------------------
// 5. THE SAME COLLAPSE FROM THE EDGE SIDE
// ---------------------------------------------------------------------------

describe("a rectangle can be solved out of existence, and nothing notices", () => {
  // Same class as the 2026-08-15 field report (a 65 mm line folded to zero
  // length so an impossible `parallel` became vacuous), on the path that fix
  // did not reach: compileAndSolve's collapse scan walks `before.type === "line"`
  // (sketchSolve.ts:612), and a rectangle's four edges are never `line`
  // entities. expectSaneGeometry has no rectangle case either — it switches on
  // line/circle/arc/point and falls through.
  //
  // NOT reachable by clicking today, and only because two doors happen to be
  // shut: the constraint tools refuse a rectangle outright (see the gap tests
  // above), and evalDimInput rejects a non-positive length (sketchMode.ts:968).
  // Opening the first of those — which is exactly what "select a corner on a
  // rectangle" asks for — makes every case below live. A saved file or the
  // agent-control API can author these constraint rows today.

  it("THE PAIR: the same contradiction is refused on a line and accepted on a rectangle", async () => {
    // The clearest statement of the whole bug, in one test.
    //
    // Left: a plain line told to be both horizontal and vertical. Unsatisfiable
    // except at zero length; the guard catches the collapse, reports not-ok, and
    // hands back the pre-solve geometry. Exactly right.
    const line = [L("A", 0, 0, 40, 0)];
    const lineResult = await compileAndSolve(line, [
      { type: "horizontal", line: "A" } as SketchConstraint,
      { type: "vertical", line: "A" } as SketchConstraint,
    ]);
    expect(lineResult.ok, "a LINE in this contradiction is refused").toBe(false);
    expect(lineResult.entities, "and its pre-solve geometry is handed back").toEqual(line);

    // Right: the identical contradiction on a rectangle's bottom edge, which
    // carries the horizontal half implicitly (`R~h0`, sketchSolve.ts:163). One
    // user constraint, `vertical`, is all it takes. The solve reports SUCCESS,
    // blames nothing, and writes a zero-width rectangle into the document.
    const rect = [RECT("R", 0, 0, 40, 20)];
    const rectResult = await compileAndSolve(rect, [{ type: "vertical", line: "R~0" } as SketchConstraint]);
    expect(rectResult.ok, "the RECTANGLE in the same contradiction is accepted").toBe(true);
    expect(rectResult.conflicts, "and nothing is blamed").toEqual([]);
    const R = byId(rectResult.entities).get("R") as { width: number; height: number } | undefined;
    expect(R?.width, "the rectangle was flattened to zero width").toBeLessThan(MIN_VIOLATION);

    // and the blanket post-condition every other test in this repo leans on
    // does not notice either — it has no `rectangle` case at all
    expect(() => expectSaneGeometry(rectResult.entities, "after vertical on a rect edge", rect),
      "expectSaneGeometry now rejects a collapsed rectangle — good, update this test")
      .not.toThrow();
  });

  it("parallel between a rect edge and a skew line collapses it, reporting ok", async () => {
    const start = [RECT("R", 0, 0, 40, 20), L("A", 40, 0, 70, 12)];
    const r = await compileAndSolve(start, [{ type: "parallel", l1: "R~1", l2: "A" } as SketchConstraint]);
    const R2 = byId(r.entities).get("R") as { height: number } | undefined;

    expect(r.ok, "the solve reports success").toBe(true);
    expect(r.conflicts, "and blames nothing").toEqual([]);
    expect(R2?.height, "the rectangle now has zero height").toBeLessThan(MIN_VIOLATION);
    // and it walks straight past the guard that exists for exactly this
    expect(() => expectStillRectangular(r.entities, "R", "collapsed"))
      .toThrow(/zero height/);
  });

  it("perpendicular collapses it or not depending on the OTHER line's start angle", async () => {
    // Why the matrix's `perpendicular` row passing is not reassurance. Same
    // constraint, same rectangle, same first click — only the free line's
    // starting direction differs, and that decides whether the solver rotates
    // the line (correct) or flattens the rectangle (silent data loss). A user
    // cannot see which side of that they are on before clicking.
    const run = async (x2: number, y2: number) => {
      const r = await compileAndSolve(
        [RECT("R", 0, 0, 40, 20), L("A", 60, 0, x2, y2)],
        [{ type: "perpendicular", l1: "R~0", l2: "A" } as SketchConstraint],
      );
      const R = byId(r.entities).get("R") as { width: number } | undefined;
      return { ok: r.ok, conflicts: r.conflicts, width: R?.width ?? NaN };
    };
    const steep = await run(69, 40);   // A starts near vertical
    const shallow = await run(100, 9); // A starts near horizontal

    expect(steep.width, "a steep starting line: the rectangle survives").toBeGreaterThan(MIN_VIOLATION);
    expect(shallow.width, "a shallow starting line: the rectangle is flattened").toBeLessThan(MIN_VIOLATION);
    // and the two are indistinguishable from the outside
    expect(shallow.ok, "the flattening solve reports success").toBe(true);
    expect(shallow.conflicts, "and blames nothing").toEqual([]);
  });

  it("symmetric about a rect-edge axis: the width is left to the solver's mood", async () => {
    // This one collapses the rectangle too — but only sometimes, so it asserts
    // what is actually true of it rather than a width. Cold in the process the
    // rectangle comes back 0 wide; after a larger unrelated solve, 33.49 wide.
    // Same entities, same constraint, both branches satisfying it exactly.
    // See solveReproducibility.test.ts, which pins that on its own (a fresh file
    // is the only way to control "cold" — vitest gives each file a worker, and
    // the flip latches for the rest of the process once it happens).
    //
    // What IS invariant, and is the point here: whatever the solver picks, the
    // rectangle's width is nobody's decision. Nothing constrains it, nothing
    // reports it, and if the answer is zero nothing refuses it.
    const start = [RECT("R", 0, 0, 40, 20), L("A", -30, 30, -10, 33), L("B", 10, -30, 30, -35)];
    const r = await compileAndSolve(start, [
      { type: "symmetric", e1: "A", p1: 0, e2: "B", p2: 0, line: "R~0" } as SketchConstraint,
    ]);
    const R2 = byId(r.entities).get("R") as { width: number; height: number } | undefined;
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    // the constraint itself IS achieved, in either branch — the axis is the
    // rectangle's bottom edge, so the two points must straddle it evenly
    const axisY = (R2!.height / 2) * -1 + (byId(r.entities).get("R") as { y: number }).y;
    const A = byId(r.entities).get("A") as { y1: number };
    const B = byId(r.entities).get("B") as { y1: number };
    expect(Math.abs((A.y1 - axisY) + (B.y1 - axisY)), "symmetric holds either way")
      .toBeLessThanOrEqual(TOL);
    // and the rectangle it deformed to get there was never anyone's choice
    expect(R2!.height, "the rectangle was resized by a constraint that never named it")
      .toBeLessThan(20 - MIN_VIOLATION);
  });

  it("a p2lDistance of 0 across a rectangle flattens it, reporting ok", async () => {
    // The same collapse through a plain dimension. Blocked at the UI only by
    // evalDimInput's `value > 0` check — nothing below that layer refuses it.
    const start = [RECT("R", 0, 0, 40, 20)];
    const r = await compileAndSolve(start, [
      { type: "p2lDistance", e: "R", p: 0, line: "R~2", value: 0 } as SketchConstraint,
    ]);
    const R2 = byId(r.entities).get("R") as { height: number } | undefined;
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(R2?.height, "the rectangle now has zero height").toBeLessThan(MIN_VIOLATION);
  });

  it("CONTROL: the same collapse on a plain LINE is caught", async () => {
    // Proof the guard works and the rectangle is genuinely the blind spot, not
    // the whole mechanism being absent.
    const start = [L("A", 0, 0, 55, 0), L("B", 0, 0, 0, -45)];
    const r = await compileAndSolve(start, [
      { type: "horizontal", line: "A" } as SketchConstraint,
      { type: "vertical", line: "B" } as SketchConstraint,
      { type: "collinear", l1: "A", l2: "B" } as SketchConstraint,
    ]);
    expect(r.ok, "a collapsing LINE is refused").toBe(false);
    expect(r.entities, "and the pre-solve geometry is handed back").toEqual(start);
  });
});

// ---------------------------------------------------------------------------
// 6. THE PREDICATES HAVE TEETH
// ---------------------------------------------------------------------------

describe("the predicates have teeth", () => {
  // A predicate that cannot fail is not a check. Rather than editing production
  // code, each case is run against a solve that deliberately never receives the
  // constraint — the exact observable signature of a compile branch that drops
  // it on the floor, which is the real bug this file is hunting (see the corner
  // gap above, where three constraint types do precisely that).
  const RESIDUAL_ROWS = ROWS.filter((r) => !r.spec.provedByNotMoving);

  it.each(RESIDUAL_ROWS)("$label goes RED when the constraint is dropped", async ({ label, spec }) => {
    const start = spec.entities();
    const after = await solved(start, []); // the constraint never reaches the solver
    expect(spec.residual(after),
      `${label}: the predicate passes with NO constraint applied — it proves nothing`)
      .toBeGreaterThan(MIN_VIOLATION);
  });

  it("fix goes RED when the pin is dropped", async () => {
    const spec = TOOL_CASES["fix"]![0]!;
    const { pull, point } = spec.provedByNotMoving!;
    const start = spec.entities();
    const before = pt(start, point[0], point[1]);
    const after = await solved(start, [pull]); // no fix
    expect(dist(pt(after, point[0], point[1]), before)).toBeGreaterThan(MIN_VIOLATION);
  });

  it("the rectangle predicates go RED when their constraint is dropped", async () => {
    // Only the "satisfied" rows are residual claims that could be vacuous. A
    // "redundant" row asserts the constraint was already true, so it cannot go
    // red this way — that is what redundant MEANS — and a "collapses" row
    // asserts a bug, whose teeth are the surviving-rectangle case beside it.
    for (const tool of TOOLS.filter((t) => RECT_CASES[t]?.outcome === "satisfied")) {
      const spec = RECT_CASES[tool]!;
      const start = spec.entities();
      if (spec.provedByNotMoving) {
        const { pull, point } = spec.provedByNotMoving;
        const before = pt(start, point[0], point[1]);
        const after = await solved(start, [pull]); // the pin is dropped
        expect(dist(pt(after, point[0], point[1]), before),
          `${tool}: the rectangle pin predicate passes with NO pin applied`)
          .toBeGreaterThan(MIN_VIOLATION);
        continue;
      }
      const after = await solved(start, []);
      expect(spec.residual(after),
        `${tool}: the rectangle predicate passes with NO constraint applied`)
        .toBeGreaterThan(MIN_VIOLATION);
    }
  });

  it("expectStillRectangular rejects a rectangle with no area", () => {
    // The rectangle post-condition itself, exercised against geometry it must
    // refuse — otherwise the matrix's "stays a rectangle" clause is decoration.
    //
    // Only the zero-area cases are checkable here, and that is worth knowing:
    // a `rectangle` entity is x/y/width/height, so a SKEWED one cannot be
    // expressed at all. The solve write-back rebuilds it from the bounding box
    // of the four solved corners (sketchSolve.ts:540-548), which means a
    // rectangle that skewed inside the solver comes back looking perfectly
    // axis-aligned. The four implicit-rule assertions above can therefore only
    // fail via that write-back, never via a genuinely rotated quad.
    const flat = [RECT("R", 0, 0, 40, 0)];
    expect(() => expectStillRectangular(flat, "R", "flat")).toThrow(/zero height/);
    const thin = [RECT("R", 0, 0, 0, 20)];
    expect(() => expectStillRectangular(thin, "R", "thin")).toThrow(/zero width/);
  });
});
