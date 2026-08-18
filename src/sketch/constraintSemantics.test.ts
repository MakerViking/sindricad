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
// wish from 2026-08-16, granted on 2026-08-17. A rectangle is not a line:
// sketchSolve expands it into 4 corner points + 4 implicit edges, and the two
// point resolvers used to DISAGREE about whether those corners exist (dimPoint
// knew them, endpointPoint did not), so the same operand worked in a dimension
// and vanished in a constraint. That disagreement was invisible to every
// existing test, and it is what the rectangle matrix below pins down — along
// with the two rectangle-destroying solves that the closed door was the only
// thing hiding.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// no @types/node here (tsconfig types is ["vite/client"]) — same local
// declaration sketchSolve.test.ts uses to reach the real wasm on disk
declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve, constraintIndexOf } from "./sketchSolve";
import { constraintGlyphs, diagnosisOf } from "./glyphs";
import { expectSaneGeometry, expectUnchangedOnFailure } from "./solveInvariants";
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
 *   - dimPoint (sketchSolve): rectangle corner by index, circle centre,
 *     arc centre at 2, else an endpoint — mirrored by entityDims.dimRefPoints.
 *   - a rectangle EDGE id with p 0/1, which resolves to that edge's two corners
 *     (sketchSolve's rectangle branch registers `rect~k` in `ends`, so endpointPoint takes it).
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
 *  failure mode the zero-length-line guard exists for (sketchSolve's LINE collapse scan). */
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
/** arc on the circle (cx,cy,r), from angle a0 to a1 (radians, CCW) — the through
 *  point is the mid-sweep, which is what circumcenter reconstructs it from */
const ARC = (id: string, cx: number, cy: number, r: number, a0: number, a1: number) => {
  const at = (a: number) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  const s = at(a0), e = at(a1), m = at((a0 + a1) / 2);
  return ({ type: "arc", id, x1: s.x, y1: s.y, x2: e.x, y2: e.y, mx: m.x, my: m.y }) as unknown as ResolvedEntity;
};
const PT = (id: string, x: number, y: number) =>
  ({ type: "point", id, x, y }) as unknown as ResolvedEntity;
const SPL = (id: string, pts: [number, number][]) =>
  ({ type: "spline", id, points: pts.map(([x, y]) => ({ x, y })) }) as unknown as ResolvedEntity;

// ---------------------------------------------------------------------------
// the predicate table — at least one entry per tool in CONSTRAINT_TOOLS
// ---------------------------------------------------------------------------
//
// A LIST per tool, not a single case, because two of the twelve mean different
// things depending on what you pick and emit a DIFFERENT constraint for each:
// `equal` emits `equal` on two lines and `equalRadius` on two rounds
// (constraintTools.equalClick), and `tangent` emits `tangent2`, which the
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
  // Both measured through dir(), not off the raw endpoints. |y1 - y2| is 0 on a
  // line that has been folded to a point, so it grades a collapse as a perfect
  // horizontal — the vacuous-satisfaction failure every other angular predicate
  // here already guards against, and the one the rectangle work is about.
  horizontal: [{
    meaning: "the line's two endpoints have the same y",
    entities: () => [L("A", 0, 0, 40, 9)],
    clicks: [[20, 4.5]],
    emits: { type: "horizontal", line: "A" },
    residual: (e) => Math.abs(dir(seg(e, "A")).y),
  }],
  vertical: [{
    meaning: "the line's two endpoints have the same x",
    entities: () => [L("A", 0, 0, 9, 40)],
    clicks: [[4.5, 20]],
    emits: { type: "vertical", line: "A" },
    residual: (e) => Math.abs(dir(seg(e, "A")).x),
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
    // (sketchSolve's collinear branch) and relies on `parallel` for the second — but
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
    // (constraintTools.equalClick), and the compiler then splits it three ways by
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
    // branch across a later solve (sketchSolve.rimBranch), nothing here
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
// horizontal/vertical rules (sketchSolve's rectangle branch). So there are two
// things a constraint might be pointed at:
//
//   a rect EDGE   — `"<rectId>~<k>"`, registered in `ends`, so every
//                   line-operand compile branch already takes it. Clickable as
//                   of 2026-08-17 via entityDims.lineOperandAt.
//   a rect CORNER — the rectangle's own id with p = 0..3 (entityDims
//                   dimRefPoints). Both point resolvers know it as of
//                   2026-08-17: dimPoint always did (that is why `fix` and the
//                   dimensions worked), and endpointPoint — which the point-pair
//                   constraints go through — now does too. When those two
//                   disagreed, coincident/midpoint/symmetric were silently
//                   dropped while the identical operand worked in a dimension.
//
// The matrix below states, per tool AND per pick shape, which of those is legal
// and what must hold.

/** The rectangle's own contract, which no existing post-condition asserted when
 *  this file was written: it still has AREA, judged against the size it went in
 *  with.
 *
 *  Both blind spots that made it necessary are closed as of 2026-08-17:
 *  expectSaneGeometry now has a `rectangle` case (solveInvariants.ts) and the
 *  solve guard walks rectangles as well as `line` entities (sketchSolve.ts).
 *  This stays because it is RELATIVE where both of those are absolute, and
 *  because a helper this file owns can be pointed at any intermediate result.
 *
 *  It used to assert six more things — that the four edges are still axis
 *  aligned and that opposite sides are still equal — and every one of them was
 *  a tautology. This helper reads the corners back through rectCorners(x, y, w,
 *  h), which builds them from those four numbers: bl.y and br.y are both
 *  `y - h/2`, the same expression, so they are equal bit for bit whatever the
 *  solver did. A rectangle ENTITY cannot express a skew (the write-back rebuilds
 *  it from the bounding box of the four solved corners), so there was nothing
 *  for those clauses to catch and no input that could make them fail. Deleted
 *  rather than left as reassurance.
 *
 *  The floor is RELATIVE because the matrix says out loud that a constraint on
 *  one edge may legitimately move and RESIZE the whole rectangle — so "survived"
 *  cannot mean "unchanged". A thousandth of what it had is not a resize: a
 *  40 x 20 that came back 40 x 0.002 cleared the old absolute 1e-3 fence and
 *  passed as a survivor. 1e-3 OF 20 mm is 0.02 mm, still twenty times the
 *  0.001 mm bucket coincKey fuses two corners into on the next compile, so both
 *  fences hold at once. */
const RECT_SURVIVOR_FRACTION = 1e-3;
function expectStillRectangular(ents: ResolvedEntity[], id: string, where: string, before: ResolvedEntity[]) {
  const e = byId(ents).get(id);
  if (!e || e.type !== "rectangle") throw new Error(`${where}: ${id} is not a rectangle`);
  const was = byId(before).get(id);
  if (!was || was.type !== "rectangle") throw new Error(`${where}: ${id} was not a rectangle going in`);
  const floor = (had: number) => Math.max(MIN_VIOLATION, Math.abs(had) * RECT_SURVIVOR_FRACTION);
  expect(e.width, `${where}: ${id} collapsed to zero width (was ${was.width})`)
    .toBeGreaterThan(floor(was.width));
  expect(e.height, `${where}: ${id} collapsed to zero height (was ${was.height})`)
    .toBeGreaterThan(floor(was.height));
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
  /** the constraint contradicts one of the rectangle's own implicit
   *  horizontal/vertical rules, so the only geometry satisfying both is a
   *  zero-length edge. planegcs finds it and reports Success; the solve guard
   *  refuses it and hands back the pre-solve rectangle, which is the same answer
   *  the plain-LINE form of the contradiction has always got. */
  | "conflict";

interface RectCase {
  /** which rectangle part this tool is pointed at. "corner (via edge id)" is a
   *  distinct answer from "corner": `R~k` p0/p1 reaches the same solver point as
   *  the rectangle id + corner index, but it is a SECOND spelling of it — the
   *  pickers emit only the corner-index form, because nothing that renders a
   *  point operand can decode an edge id (see section 3). */
  operand: "edge" | "corner" | "corner (via edge id)";
  outcome: RectOutcome;
  /** which pick shape this row covers, when the tool has more than one — the
   *  reason RECT_CASES is a LIST per tool. One row per TOOL hid a second
   *  outcome: `horizontal` was recorded as harmlessly redundant on the bottom
   *  edge, and the identical click on the RIGHT edge (already pinned vertical by
   *  the rectangle's own `~v1` rule) is the flat contradiction that used to eat
   *  the rectangle. Same tool, same gesture, opposite outcome. */
  form?: string;
  entities: () => ResolvedEntity[];
  constraints: SketchConstraint[];
  /** the tool's own predicate, measured on the rectangle operand. Not read for
   *  `conflict` rows — those assert the REFUSAL and the untouched geometry, not
   *  a residual, because a collapsed edge satisfies every angular predicate
   *  vacuously. */
  residual: Residual;
  /** `fix` again: a pin's meaning is "does not move", so its case names the
   *  point and the pull instead of a residual. */
  provedByNotMoving?: { pull: SketchConstraint; point: [string, number] };
}

/** Tools that cannot take a rectangle operand at all, and why. Stated rather
 *  than omitted, so "not covered" and "not applicable" stay distinguishable. */
const RECT_NOT_APPLICABLE: Partial<Record<string, string>> = {
  concentric: "a rectangle has no centre — concentric compiles centerPoint(), which "
    + "resolves circles and arcs only (sketchSolve.centerPoint)",
};

const RECT_CASES: Record<string, RectCase[]> = {
  // --- rect EDGE as a line operand ------------------------------------------
  horizontal: [{
    operand: "edge",
    form: "an edge that is already horizontal",
    outcome: "redundant",
    // A rectangle's bottom edge is already horizontal, by the implicit `~h0`
    // rule sketchSolve pushes for it. So the honest answer for this tool is not
    // "it works" but "there was nothing to do", and the solver says so:
    // over-defined names the user constraint and the rectangle is untouched.
    // Measured: over = ["k0"], 40x20 in and out.
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [{ type: "horizontal", line: "R~0" } as SketchConstraint],
    residual: (e) => Math.abs(dir(seg(e, "R~0")).y),
  }, {
    operand: "edge",
    form: "an edge that is already VERTICAL",
    outcome: "conflict",
    // THE second outcome one row per tool was hiding, and it is one click away
    // from the first: same tool, same rectangle, the user picks the RIGHT edge
    // instead of the bottom one. R~1 is pinned vertical by the rectangle's own
    // `~v1` rule, so `horizontal` on it is the identical contradiction the
    // `vertical` row below describes — and with only the bottom-edge row here,
    // this tool was recorded as harmlessly redundant, full stop.
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [{ type: "horizontal", line: "R~1" } as SketchConstraint],
    residual: (e) => Math.abs(dir(seg(e, "R~1")).y),
  }],
  vertical: [{
    operand: "edge",
    form: "an edge that is already horizontal",
    outcome: "conflict",
    // THE most reachable instance of the contradiction, and the plainest: click
    // Vertical, then a rectangle's bottom edge. That edge is already pinned
    // horizontal by the rectangle's own rule, so "vertical" is a flat
    // contradiction and the only geometry satisfying both is a zero-length edge.
    // planegcs finds it and reports success — up to 2026-08-17 that 0 x 20
    // rectangle was written into the document, because the guard's collapse scan
    // walked only entities whose type IS "line" and a rectangle never is one. It
    // walks rectangles too now, so this lands where the plain LINE form of the
    // same contradiction has always landed: refused, pre-solve geometry handed
    // back. See the control in "a rectangle solved out of existence" below.
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [{ type: "vertical", line: "R~0" } as SketchConstraint],
    residual: (e) => Math.abs(dir(seg(e, "R~0")).x),
  }, {
    operand: "edge",
    form: "an edge that is already vertical",
    outcome: "redundant",
    // and the mirror image of the pair above: the harmless half of `vertical`.
    // Stated because "vertical on a rectangle conflicts" would be exactly as
    // wrong as "horizontal on a rectangle is harmless".
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [{ type: "vertical", line: "R~1" } as SketchConstraint],
    residual: (e) => Math.abs(dir(seg(e, "R~1")).x),
  }],
  parallel: [{
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
  }],
  perpendicular: [{
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
  }],
  collinear: [{
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
  }],
  equal: [{
    operand: "edge",
    form: "an edge and a free line",
    outcome: "satisfied",
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", 100, 0, 130, 0)],
    constraints: [{ type: "equal", l1: "R~0", l2: "A" } as SketchConstraint],
    residual: (e) => Math.abs(len(seg(e, "R~0")) - len(seg(e, "A"))),
  }, {
    operand: "edge",
    form: "two edges of the SAME rectangle (make it square)",
    outcome: "satisfied",
    // Newly reachable by clicking, and the one two-pick gesture where both picks
    // land on one entity: holdPair rejects the same OPERAND twice but not two
    // different edges of one rectangle, because "make this rectangle square" is
    // the obvious thing a user wants from Equal on a rectangle.
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [{ type: "equal", l1: "R~0", l2: "R~1" } as SketchConstraint],
    residual: (e) => Math.abs(len(seg(e, "R~0")) - len(seg(e, "R~1"))),
  }],
  tangent: [{
    operand: "edge",
    outcome: "satisfied",
    entities: () => [RECT("R", 0, 0, 40, 20), C("K", 0, 30, 8)],
    constraints: [{ type: "tangent2", a: "K", b: "R~2" } as SketchConstraint],
    residual: (e) => { const k = round(e, "K"); return Math.abs(perpDist(k, seg(e, "R~2")) - k.r); },
  }],
  midpoint: [{
    operand: "edge",
    form: "a line endpoint centred on a rect edge",
    outcome: "satisfied",
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", 5, -30, 5, -20)],
    constraints: [{ type: "midpoint", e: "A", p: 1, line: "R~0" } as SketchConstraint],
    residual: (e) => dist(pt(e, "A", 1), midOf(seg(e, "R~0"))),
  }, {
    operand: "corner",
    form: "a rect CORNER centred on a free line",
    outcome: "satisfied",
    // The direction the affordance actually opened: the corner is the POINT
    // operand, resolved through endpointPoint, which knew nothing about
    // rectangles until 2026-08-17. Corner 2 is (20,10); the line is placed so
    // its midpoint is nowhere near it.
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", 40, 30, 90, 30)],
    constraints: [{ type: "midpoint", e: "R", p: 2, line: "A" } as SketchConstraint],
    residual: (e) => dist(pt(e, "R", 2), midOf(seg(e, "A"))),
  }],
  // --- rect CORNER as a point operand ---------------------------------------
  fix: [{
    operand: "corner",
    outcome: "satisfied",
    // The one tool that reached a rectangle corner end to end before step 3:
    // fixClick picks through dimRefPoints and the compile resolves through
    // dimPoint, and both knew rectangles all along.
    entities: () => [RECT("R", 0, 0, 40, 20)],
    constraints: [
      { type: "fix", e: "R", p: 2 } as SketchConstraint,
      { type: "distance", line: "R~0", value: 25 } as SketchConstraint,
    ],
    // corner 2 = tr = (20,10). Shrinking the bottom edge to 25 moves it to
    // (9.186, 10) when nothing is pinned, so the pin has something to hold.
    residual: (e) => dist(pt(e, "R", 2), { x: 20, y: 10 }),
    provedByNotMoving: { pull: { type: "distance", line: "R~0", value: 25 } as SketchConstraint, point: ["R", 2] },
  }],
  coincident: [{
    operand: "corner",
    form: "the rectangle id + corner index (what the picker emits)",
    outcome: "satisfied",
    // The spelling every picker now produces, and the one the document format
    // defines: `R` + corner index, resolved by endpointPoint exactly as dimPoint
    // resolves it.
    //
    // The pull is deliberately SMALL. A large one is satisfied by mirroring the
    // rectangle, and the write-back then relabels its corners — see "a rectangle
    // corner constraint can destroy the rectangle" below, which is the most
    // important thing in this file.
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", -24, -14, 10, -14)],
    constraints: [{ type: "coincident", e1: "A", p1: 0, e2: "R", p2: 0 } as SketchConstraint],
    residual: (e) => dist(pt(e, "A", 0), pt(e, "R", 0)),
  }, {
    operand: "corner (via edge id)",
    form: "the EDGE id `R~0` p0, the second spelling of corner 0",
    outcome: "satisfied",
    // Still legal, still compiles, and a saved file may carry it — the edge
    // registration in sketchSolve puts `R~k` in `ends`, so endpointPoint takes
    // p0/p1 as that edge's two corners. Kept as a row because pruneConstraints
    // has to keep accepting it (hasPointOperand) or the constraint would work
    // until the user's next unrelated edit deleted it.
    entities: () => [RECT("R", 0, 0, 40, 20), L("A", -24, -14, 10, -14)],
    constraints: [{ type: "coincident", e1: "A", p1: 0, e2: "R~0", p2: 0 } as SketchConstraint],
    residual: (e) => dist(pt(e, "A", 0), pt(e, "R~0", 0)),
  }],
  symmetric: [{
    operand: "corner",
    outcome: "satisfied",
    // Two rect corners about a vertical axis: corner 0 (bl) and corner 1 (br).
    // Already true for a centred rectangle, so the fixture puts the axis
    // off-centre and requires the rectangle to slide onto it. This is the
    // three-click gesture the picker now supports end to end.
    entities: () => [RECT("R", 12, 0, 40, 20), L("AX", 0, -50, 0, 50)],
    constraints: [
      { type: "vertical", line: "AX" } as SketchConstraint,
      { type: "symmetric", e1: "R", p1: 0, e2: "R", p2: 1, line: "AX" } as SketchConstraint,
    ],
    residual: (e) => dist(mirror(pt(e, "R", 0), seg(e, "AX")), pt(e, "R", 1)),
  }],
};

describe("the rectangle-operand matrix", () => {
  it("says something about every constraint tool", () => {
    // Same ratchet shape as above: a tool with neither a rectangle case nor a
    // stated reason it cannot have one is a hole in the matrix, not a pass.
    const unstated = TOOLS.filter((t) => !RECT_CASES[t]?.length && !RECT_NOT_APPLICABLE[t]);
    expect(unstated, "these tools say nothing about rectangle operands").toEqual([]);
  });

  /** every declared rectangle row, flattened — so a tool's SECOND outcome is a
   *  first-class case and cannot hide behind its first (see RectCase.form) */
  const RECT_ROWS: { tool: SketchTool; label: string; spec: RectCase }[] = TOOLS.flatMap((t) =>
    (RECT_CASES[t] ?? []).map((spec) => ({
      tool: t,
      label: spec.form ? `${t} (${spec.form})` : t,
      spec,
    })),
  );

  it.each(RECT_ROWS)("$label on a rectangle operand", async ({ tool, label, spec }) => {
    const start = spec.entities();
    const where = `${label} on a rectangle ${spec.operand}`;

    if (spec.outcome === "conflict") {
      // Unsatisfiable except by destroying the rectangle, so the only right
      // answer is to refuse the solve and hand back what was there before —
      // byte for byte, the way the plain-LINE control below is handled.
      const r = await compileAndSolve(start, spec.constraints);
      expect(r.ok, `${where}: an unsatisfiable constraint must be refused`).toBe(false);
      expect(r.entities, `${where}: the pre-solve geometry must be handed back`).toEqual(start);
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
      expectStillRectangular(r.entities, "R", where, start);
      expectSaneGeometry(r.entities, where, start);
      return;
    }

    if (spec.provedByNotMoving) {
      const { pull, point } = spec.provedByNotMoving;
      const before = pt(start, point[0], point[1]);
      const withoutPin = await solved(start, [pull]);
      expect(dist(pt(withoutPin, point[0], point[1]), before),
        `${label}: the control does not move the corner, so the pin proves nothing`)
        .toBeGreaterThan(MIN_VIOLATION);
      const after = await solved(start, spec.constraints);
      expect(dist(pt(after, point[0], point[1]), before),
        `${label}: the pinned rectangle corner moved`).toBeLessThanOrEqual(TOL);
      expectStillRectangular(after, "R", where, start);
      expectSaneGeometry(after, where, start);
      return;
    }

    expect(spec.residual(start),
      `${label}: the rectangle fixture already satisfies the predicate`)
      .toBeGreaterThan(MIN_VIOLATION);
    const after = await solved(start, spec.constraints);
    expect(spec.residual(after), `${label}: rectangle operand — ${TOOL_CASES[tool]?.[0]?.meaning}`)
      .toBeLessThanOrEqual(TOL);
    expectStillRectangular(after, "R", where, start);
    // ...and the blanket post-condition, on a real solve result rather than a
    // hand-built literal: expectStillRectangular is this file's own helper, so
    // without this the rectangle arm of the shared one would be pinned only by
    // synthetic input and could rot without any solve noticing.
    expectSaneGeometry(after, where, start);
  });

  it("a rect-edge constraint may legitimately MOVE and RESIZE the rectangle", async () => {
    // Saying so explicitly, because "stays a rectangle" above is deliberately
    // weaker than "stays the same rectangle" and the difference is not obvious.
    // A free rectangle has 4 DOF; planegcs spreads the correction over
    // everything free, so constraining one edge routinely changes the
    // rectangle's SIZE even though the user only pointed at a line.
    //
    // That is correct solver behaviour, not a bug — but it is a UX surprise
    // worth knowing about now that rect edges ARE clickable: the user applies
    // Perpendicular to a line and watches their rectangle shrink.
    const start = [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 69, 40)];
    const after = await solved(start, [{ type: "perpendicular", l1: "R~0", l2: "A" } as SketchConstraint]);
    const R = byId(after).get("R") as { width: number; height: number } | undefined;
    expectStillRectangular(after, "R", "perpendicular resize", start);
    expect(R?.width, "the rectangle was resized by a constraint on one of its edges")
      .not.toBeCloseTo(40, 3);
  });
});

// ---------------------------------------------------------------------------
// 3. THE CORNER AFFORDANCE — what the user actually asked for
// ---------------------------------------------------------------------------
//
// "I can select a corner as an endpoint on a rectangle." Until 2026-08-17 you
// could not, at either layer, and the failure was SILENT at both: pickEndpoint
// enumerated line/arc/point/spline/projected and never rectangle, and below it
// endpointPoint consulted ends/arcMap/pointMap/splineMap and never rectMap —
// so even a constraint authored by hand was dropped on the floor. These tests
// are the ones that used to assert the door was shut; they now assert it opens
// onto the SAME addressing convention the dimension tool has always used (the
// rectangle's own id + corner index 0..3), not a second one.

describe("a rectangle corner is a first-class point operand", () => {
  it.each(["coincident", "midpoint", "symmetric"] as const)(
    "%s PICKS a rectangle corner, and marks it",
    (tool) => {
      // One click, dead on corner 2 (tr). All three flows start by picking an
      // endpoint, so after the first click the tool must be ARMED and showing
      // the user where: the marker comes from endpointXY, whose whole job is to
      // mirror pickEndpoint's idea of what is addressable. A corner that can be
      // picked but not shown is how Coincident read as broken (GitHub #17).
      const ents = [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 100, 3)];
      const h = applyByClicking(tool, ents, [[20, 10]]);
      expect(h.warnings, `${tool}: a click dead on a corner must not miss`).toEqual([]);
      expect(h.pending, `${tool}: the picked corner is not marked on screen`)
        .toEqual({ x: 20, y: 10 });
    },
  );

  it.each([
    ["coincident", [[20, 10], [60, 0]], { type: "coincident", e1: "R", p1: 2, e2: "A", p2: 0 }],
    ["midpoint", [[20, 10], [80, 1.5]], { type: "midpoint", e: "R", p: 2, line: "A" }],
    // symmetric: corner 0 (bl), corner 1 (br), then the axis
    ["symmetric", [[-20, -10], [20, -10], [80, 1.5]], { type: "symmetric", e1: "R", p1: 0, e2: "R", p2: 1, line: "A" }],
  ] as [SketchTool, [number, number][], Partial<SketchConstraint>][])(
    "%s emits the rectangle's OWN id + corner index",
    (tool, clicks, emits) => {
      // The spelling matters as much as the pick. `R~k` p0/p1 also reaches a
      // corner (the edge registration side effect sketchSolve's edge registration warns
      // about), but it is a second convention for the same point: the glyph
      // renderer resolves a coincident's badge through refPoint(entity, p)
      // (glyphs.constraintGlyphs), which has no idea what `R~0` is, so a constraint spelled
      // that way would be invisible and undeletable. dimRefPoints' p 0..3 is the
      // convention the document format defines (types.ts) and the dimension tool
      // already emits.
      const ents = [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 100, 3)];
      const h = applyByClicking(tool, ents, clicks);
      expect(h._cons, `${tool}: the corner flow emitted nothing (warnings: ${h.warnings.join(" | ")})`)
        .toHaveLength(1);
      expect(h._cons[0]).toMatchObject(emits);
    },
  );

  it.each(["coincident", "midpoint", "symmetric"] as const)(
    "%s with a rectangle id + corner index reaches the SOLVER",
    async (kind) => {
      // The layer below the picker. These three resolve points through
      // endpointPoint (sketchSolve); `fix`, p2pDistance and p2lDistance
      // go through dimPoint (sketchSolve). Same document convention, two
      // resolvers — and one of them was blind to rectMap, so a constraint
      // authored from a file or by the agent-control API was silently dropped.
      // A constraint that reached the solver REMOVES DOF; that is the check.
      const start: ResolvedEntity[] = [RECT("R", 0, 0, 40, 20), L("A", 30, 30, 60, 30), L("AX", -60, -50, -60, 50)];
      const c: Record<string, SketchConstraint> = {
        coincident: { type: "coincident", e1: "A", p1: 0, e2: "R", p2: 2 } as SketchConstraint,
        midpoint: { type: "midpoint", e: "R", p: 0, line: "A" } as SketchConstraint,
        symmetric: { type: "symmetric", e1: "R", p1: 0, e2: "R", p2: 1, line: "AX" } as SketchConstraint,
      };
      const free = await compileAndSolve(start, []);
      const withIt = await compileAndSolve(start, [c[kind]!]);
      expect(withIt.dof, `${kind} on a rectangle corner still compiles to nothing`)
        .toBeLessThan(free.dof);
    },
  );

  it("the corner it resolves is the SAME point dimPoint resolves", async () => {
    // "Make the two agree rather than inventing a third convention." Agreement
    // is not that both compile — it is that both land on the same solver point.
    // Measured by driving the two resolvers at the same corner from opposite
    // sides: a p2pDistance (dimPoint) pins corner 2 one way, a coincident
    // (endpointPoint) names the same corner, and if they disagreed the two would
    // be satisfiable independently and the corner would not sit on the point.
    const start: ResolvedEntity[] = [
      RECT("R", 0, 0, 40, 20),
      { type: "point", id: "A", x: 26, y: 14 } as unknown as ResolvedEntity,
    ];
    const r = await compileAndSolve(start, [
      { type: "fix", e: "A", p: 0 } as SketchConstraint,
      { type: "coincident", e1: "A", p1: 0, e2: "R", p2: 2 } as SketchConstraint,
    ]);
    expect(r.ok, "a corner pulled onto a fixed point must solve").toBe(true);
    expect(dist(pt(r.entities, "R", 2), { x: 26, y: 14 }),
      "endpointPoint resolved a different corner than dimPoint would have")
      .toBeLessThanOrEqual(TOL);
  });

  it("the seven line tools PICK a rectangle edge, spelled `R~k`", () => {
    // The other half of the affordance. curveKind (entityDims) returns
    // undefined for a rectangle, which is what made every line-operand tool fall
    // through to missed() — the rect-edge rows in the matrix above could be
    // reached only from the dimension tool or a saved file.
    //
    // curveKind is NOT where this was fixed, and that is deliberate: it answers
    // "what KIND of curve is this entity", and a rect edge needs an IDENTITY as
    // well (which of the four). Teaching curveKind to call a rectangle a "line"
    // would have every caller then use `ent.id` — the bare rectangle id, which is
    // not a line operand at all — and emit a constraint that compiles to nothing.
    // The seam is lineOperandAt (entityDims.ts), which returns the OPERAND ID.
    const rows: [SketchTool, [number, number][], Partial<SketchConstraint>][] = [
      ["horizontal", [[0, -10]], { type: "horizontal", line: "R~0" }],
      ["vertical", [[0, -10]], { type: "vertical", line: "R~0" }],
      ["parallel", [[0, -10], [80, 1.5]], { type: "parallel", l1: "R~0", l2: "A" }],
      ["perpendicular", [[0, -10], [80, 1.5]], { type: "perpendicular", l1: "R~0", l2: "A" }],
      ["collinear", [[0, -10], [80, 1.5]], { type: "collinear", l1: "R~0", l2: "A" }],
      ["equal", [[0, -10], [80, 1.5]], { type: "equal", l1: "R~0", l2: "A" }],
      ["tangent", [[0, -10], [0, 68]], { type: "tangent2", a: "R~0", b: "K" }],
    ];
    for (const [tool, clicks, emits] of rows) {
      const ents = [RECT("R", 0, 0, 40, 20), L("A", 60, 0, 100, 3), C("K", 0, 60, 8)];
      const h = applyByClicking(tool, ents, clicks);
      expect(h._cons, `${tool}: clicking a rectangle edge emitted nothing (warnings: ${h.warnings.join(" | ")})`)
        .toHaveLength(1);
      expect(h._cons[0], `${tool}: wrong operand for the bottom edge`).toMatchObject(emits);
    }
  });

  it("and it picks the edge under the CURSOR, not just edge 0", () => {
    // Identity, stated on its own: a seam that returned a fixed edge would pass
    // every row above. R is 40 x 20 centred on the origin, so edge 0 is the
    // bottom (y = -10), 1 the right (x = 20), 2 the top (y = 10), 3 the left
    // (x = -20) — rectCorners CCW, edge k running corner k -> k+1.
    for (const [k, click] of ([[0, [0, -10]], [1, [20, 0]], [2, [0, 10]], [3, [-20, 0]]] as [number, [number, number]][])) {
      const h = applyByClicking("horizontal", [RECT("R", 0, 0, 40, 20)], [click]);
      expect(h._cons[0], `a click at (${click}) did not name edge ${k}`)
        .toMatchObject({ type: "horizontal", line: `R~${k}` });
    }
  });

  it("a constraint the compile DROPS must still not freeze the rectangle", async () => {
    // A constraint the compile threw away cannot force a mirror, so it must not
    // scope the mirror guard. Measured before that gate existed: a dropped
    // constraint made the free corner drag come back ok:false and frozen at
    // 40 x 20, while the identical drag with no constraint at all gave the
    // correct 5 x 5 — the guard reading operand strings before knowing whether
    // the operands had resolved.
    //
    // The fixture is `concentric`, which is the tool that STILL cannot take a
    // rectangle (a rectangle has no centre — see RECT_NOT_APPLICABLE), now that
    // coincident on a corner compiles. Read by spelling alone it names both a
    // rectangle and a circle, so it would scope the guard; it compiles to
    // nothing, so it must not.
    const start = [RECT("R", 0, 0, 40, 20), C("K", 100, 100, 8)];
    const inert = [{ type: "concentric", c1: "R", c2: "K" } as SketchConstraint];
    const free = await compileAndSolve(start, [], { fromX: -20, fromY: -10, toX: 25, toY: 15 });
    const withIt = await compileAndSolve(start, inert, { fromX: -20, fromY: -10, toX: 25, toY: 15 });
    expect(free.ok, "the control drag solves").toBe(true);
    expect(withIt.ok, "a constraint that compiled to nothing must not refuse the drag").toBe(free.ok);
    expect(withIt.entities, "and must not change what the drag produces").toEqual(free.entities);
  });
});

// ---------------------------------------------------------------------------
// 3b. WHAT THE USER SEES AFTER CLICKING A RECT EDGE
// ---------------------------------------------------------------------------

describe("the first thing a user will do with a clickable rect edge", () => {
  // A rectangle carries four implicit horizontal/vertical rules of its own, so
  // the two most obvious clicks on a newly-pickable edge are the two that have
  // nothing to do: Horizontal on an edge that is already horizontal, and
  // Vertical on that same edge. They are DIFFERENT answers and both have to
  // read as answers, not as a dead tool. Driven through the real click flow and
  // then through the real diagnosis, because that is where the red/amber comes
  // from (glyphs.diagnosisOf — conflict beats over-defined; SketchMode feeds it
  // the same two sets).
  const idxSet = (ids: string[]) =>
    new Set(ids.map(constraintIndexOf).filter((i): i is number => i !== null));

  it("Horizontal on an already-horizontal edge grades AMBER and leaves a badge", async () => {
    const ents = [RECT("R", 0, 0, 40, 20)];
    const h = applyByClicking("horizontal", ents, [[0, -10]]); // the bottom edge
    expect(h._cons).toHaveLength(1);
    const r = await compileAndSolve(ents, h._cons);
    expect(r.ok, "an already-true constraint is not a failed solve").toBe(true);
    expect(diagnosisOf(0, idxSet(r.conflicts), idxSet(r.overDefined)),
      "a redundant constraint must grade over-defined (amber), never conflict (red)")
      .toBe("over");
    // ...and there has to be something ON SCREEN carrying that amber, or the
    // user has an invisible constraint they cannot delete. The badge belongs on
    // the EDGE (y = -10), not at the rectangle's centre.
    const g = constraintGlyphs(r.entities, h._cons);
    expect(g, "the redundant constraint has no glyph to paint amber on").toHaveLength(1);
    expect(g[0]!.pos.y).toBeCloseTo(-10);
    expect(g[0]!.cIndex, "and it deletes the right constraint").toBe(0);
  });

  it("Vertical on that same edge is REFUSED, and blames no constraint", async () => {
    // Stated exactly as it behaves rather than as one might wish. The guard
    // catches the collapse and returns ok:false, but nothing populates
    // `conflicts` — roundRefs names circles and arcs only — so no chip goes red.
    // What the user gets instead is SketchMode's trial-constraint withdrawal:
    // the constraint is spliced back out and a toast says it was not applied
    // (sketchMode.ts, `if (this.trialConstraint && (this.conflict || !r.ok))`).
    // That is a real answer, and it is why the refusal must set ok:false even
    // with an empty conflict list.
    const ents = [RECT("R", 0, 0, 40, 20)];
    const h = applyByClicking("vertical", ents, [[0, -10]]);
    expect(h._cons).toHaveLength(1);
    const r = await compileAndSolve(ents, h._cons);
    expect(r.ok, "the contradiction must be refused").toBe(false);
    expect(r.entities, "and the rectangle handed back untouched").toEqual(ents);
    expect(diagnosisOf(0, idxSet(r.conflicts), idxSet(r.overDefined)),
      "nothing blames the user constraint — the toast is the whole message")
      .toBeNull();
  });

  it("Vertical on the RIGHT edge is the harmless one, same tool", async () => {
    // The pair, from the other side: whether Vertical is redundant or refused
    // depends entirely on which edge is under the cursor, and a user cannot see
    // which side of that they are on before clicking. Both outcomes are correct;
    // recording only one of them is what hid the collapse.
    const ents = [RECT("R", 0, 0, 40, 20)];
    const h = applyByClicking("vertical", ents, [[20, 0]]); // the right edge
    expect(h._cons[0]).toMatchObject({ type: "vertical", line: "R~1" });
    const r = await compileAndSolve(ents, h._cons);
    expect(r.ok).toBe(true);
    expect(diagnosisOf(0, idxSet(r.conflicts), idxSet(r.overDefined))).toBe("over");
  });
});

// ---------------------------------------------------------------------------
// 4. THE CORNER CONSTRAINT THAT DESTROYS THE RECTANGLE
// ---------------------------------------------------------------------------

describe("a rectangle corner constraint can destroy the rectangle", () => {
  // THE headline finding, and the direct answer to "can I select a corner as an
  // endpoint on a rectangle": through the edge id you can, and up to 2026-08-17
  // a big enough pull ate the rectangle on the SECOND solve.
  //
  // Why. The write-back rebuilds a rectangle from the MIN/MAX bounding box of
  // its four solved corner points (the rectangle arm of the write-back). That is lossless
  // only while the solved rectangle keeps its original corner ORDER. A
  // constraint that drags corner 0 past corner 2 is satisfied by MIRRORING the
  // rectangle, and the bbox then relabels the corners: the point the solver
  // moved becomes corner 2 in the document, and document corner 0 is somewhere
  // the constraint never asked for. The next compile re-derives the corners from
  // x/y/w/h, so the constraint's own point has jumped to the far end of the
  // diagonal — and the solver closed that gap the only way still open to it, by
  // shrinking the rectangle to nothing. Every solve reported ok:true with an
  // empty conflict list.
  //
  // The fix refuses the mirroring solve instead, because a rectangle entity is
  // x/y/width/height and has nowhere to carry the two orientation bits: the only
  // in-type carrier would be a signed width/height, which the parameter
  // re-assert overwrites (store.ts:817-820), evalDimInput will not accept back
  // (sketchMode.evalDimInput's `value > 0` check) and rectCorners' documented CCW contract forbids
  // (region.ts:101). So the rectangle below comes back exactly as it went in.
  //
  // It refuses NARROWLY, and the rows in this block are the map of where the
  // line falls: only a constraint that ties the rectangle to something the
  // mirror does not move can see the relabel, because the mirror is a reflection
  // of the rectangle onto itself. A dimension between two of its own corners
  // cannot (see section 4b), an angle between two of its own edges cannot, a
  // `fix` on one of its corners can, and so can anything naming a second entity.
  const start = () => [RECT("R", 0, 0, 40, 20), L("A", 30, 30, 60, 30)];
  const pullCornerAcross = [
    { type: "coincident", e1: "A", p1: 0, e2: "R~0", p2: 0 } as SketchConstraint,
  ];

  it("solve 1: a constraint that can only be met by mirroring is refused", async () => {
    const r = await compileAndSolve(start(), pullCornerAcross);
    // Measured on the unfixed tree: ok:true, conflicts:[], a 10x20 rectangle
    // whose document corner 0 was 22.36 mm from the point it was made coincident
    // with — the solver's corner 0 had been relabelled as document corner 2.
    expect(r.ok, "a solve that would relabel the rectangle's corners must be refused").toBe(false);
    expect(r.entities, "and the pre-solve geometry is handed back").toEqual(start());
  });

  it("solve 2: nothing was written, so re-solving is a fixed point", async () => {
    // SketchMode pumps a solve on every constraint change and every drag frame,
    // so "the second solve" is not a contrived scenario — it is the next frame.
    // That is what turned the relabel into an annihilation: solve 2 used to put
    // all four corners at (27.171572875253805, 30).
    const once = await compileAndSolve(start(), pullCornerAcross);
    const twice = await compileAndSolve(once.entities, pullCornerAcross);
    expect(twice.entities, "a refused solve must not drift on the next pump").toEqual(once.entities);
    expectStillRectangular(twice.entities, "R", "after two solves", start());
  });

  it("CONTROL: a pull that does NOT mirror still solves, and corner 0 lands on it", async () => {
    // The teeth. Without this, "refused" above would be satisfiable by refusing
    // every rectangle constraint, which is a worse bug than the one being fixed.
    // Same constraint, same corner — only the target is inside the rectangle's
    // own quadrant, so the solver satisfies it by TRANSLATING and corner 0 stays
    // corner 0.
    const small = [RECT("R", 0, 0, 40, 20), L("A", -24, -14, 10, -14)];
    const r = await compileAndSolve(small, pullCornerAcross);
    expect(r.ok, "a non-mirroring corner constraint must still solve").toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(dist(pt(r.entities, "A", 0), pt(r.entities, "R", 0)),
      "document corner 0 is the corner the constraint named").toBeLessThanOrEqual(TOL);
    expectStillRectangular(r.entities, "R", "non-mirroring pull", small);
  });

  it.each([
    ["R~0/R~2 p0", { type: "coincident", e1: "R~0", p1: 0, e2: "R~2", p2: 0 } as SketchConstraint],
    ["R~3/R~1 p1", { type: "coincident", e1: "R~3", p1: 1, e2: "R~1", p2: 1 } as SketchConstraint],
  ])("ANNIHILATION (%s): making two opposite corners coincident is refused", async (_label, c) => {
    // The worse variant, and it needs no second solve: the two corner addresses
    // below name opposite ends of the same diagonal, and with the rectangle's
    // four implicit h/v pins holding, the only geometry satisfying that is a
    // point. Measured unfixed, identically for both addresses: ok:true,
    // conflicts:[], dof 2, all four corners at (-20,-10).
    //
    // Two rows because they are two different spellings of the same corner pair.
    // Both are caught by the COLLAPSE arm, not by the corner-addressing scan —
    // measured, they stay green with that scan disabled entirely — so what the
    // second row buys is a second edge-id spelling reaching the same corner, not
    // a second code path. R~0 p0 is corner 0 and R~3 p1 is corner 0 as well
    // (edge k runs corner k -> k+1, so edge 3 is tl -> bl).
    const r = await compileAndSolve([RECT("R", 0, 0, 40, 20)], [c]);
    expect(r.ok, "annihilating a rectangle must be refused").toBe(false);
    expect(r.entities, "and the pre-solve geometry is handed back")
      .toEqual([RECT("R", 0, 0, 40, 20)]);
  });

  it("a rectangle squeezed to a millionth of a millimetre is a collapse too", async () => {
    // The gap an absolute epsilon leaves. `collinear` pins the rectangle's bottom
    // edge to a fixed 45-degree line, which is the vertical-on-a-rect-edge
    // contradiction rotated: the only way to satisfy it is to take the direction
    // out of that edge. planegcs does NOT drive it to exactly zero here — it
    // stops at width 4.6035578193937e-7, which cleared LINE_COLLAPSE_EPS (1e-7)
    // and walked out through the ordinary return with ok:false, conflicts:[] and
    // the 4.6e-7 mm rectangle in `entities`. sketchMode writes back on an empty
    // conflict list (sketchMode's solve pump writes back when `conflicts` is empty), so that IS the document.
    //
    // 4.6e-7 mm is not a small rectangle, it is a broken one: the compiler
    // buckets coincident points at 0.001 mm (sketchSolve.coincKey), so on
    // the very next solve those two corners fuse into ONE solver point and the
    // rectangle stops being a rectangle. Anything under that bucket has to count
    // as collapsed, whatever the solver's residual says.
    const start = [RECT("R", 0, 0, 40, 20), L("S", -60, -60, 0, 0)];
    const cons = [
      { type: "fix", e: "S", p: 0 } as SketchConstraint,
      { type: "fix", e: "S", p: 1 } as SketchConstraint,
      { type: "collinear", l1: "R~0", l2: "S" } as SketchConstraint,
    ];
    const r = await compileAndSolve(start, cons);
    expect(r.ok, "an edge with no direction left is a failed solve").toBe(false);
    expect(r.entities, "and the pre-solve geometry must be handed back, not the wreck")
      .toEqual(start);
  });

  it.each([
    // Two SEPARATE fixtures because the flip test has two clauses and a fixture
    // that trips both cannot tell them apart: with only the both-signs case
    // covered, either clause could be deleted and the suite would stay green
    // (measured — that is why these rows exist).
    ["x only", L("A", 60, -10, 80, -10), { w: -40, h: 20 }],
    ["y only", L("A", -20, 40, 0, 40), { w: 40, h: -30 }],
  ])("ONE SIGN (%s): a mirror on a single axis is refused as well", async (_label, a) => {
    // Corner 0 pulled straight past the corner that shares its edge, so exactly
    // one of the two extents comes back negative and NEITHER is anywhere near
    // zero — the collapse arm cannot be what refuses these. The solver's signed
    // extents are in the third column, read off the guard while writing this.
    const start = [RECT("R", 0, 0, 40, 20), a];
    const r = await compileAndSolve(start, [
      { type: "coincident", e1: "A", p1: 0, e2: "R~0", p2: 0 } as SketchConstraint,
    ]);
    expect(r.ok, "a single-axis mirror relabels corners just as thoroughly").toBe(false);
    expect(r.entities, "and the pre-solve geometry is handed back").toEqual(start);
  });

  it("the BARE rectangle id + corner index scopes the guard, not just `R~k`", async () => {
    // Two spellings reach a rectangle corner and only one of them has an edge in
    // it. Every other flip row above uses `R~k`; this one uses the form the
    // shipped dimension tool actually emits for a corner pick — bare id, corner
    // index, resolved through dimPoint (dimensionTool.ts:395, pinned by
    // dimensionTool.test.ts:148). Measured with the bare-id arm of the scan
    // disabled: ok:true, conflicts:[], R = 9.266 x 19.320 with corner 0
    // relabelled — the headline bug, on a path a user can reach today.
    const start = [RECT("R", 0, 0, 40, 20), { type: "point", id: "A", x: 30, y: 30 } as unknown as ResolvedEntity];
    const r = await compileAndSolve(start, [
      { type: "fix", e: "A", p: 0 } as SketchConstraint,
      { type: "p2pDistance", e1: "A", p1: 0, e2: "R", p2: 0, value: 1 } as SketchConstraint,
    ]);
    expect(r.ok, "a corner addressed by bare id must scope the guard too").toBe(false);
    expect(r.entities, "and the pre-solve geometry is handed back").toEqual(start);
  });

  it("a FIX on a corner refuses the mirror, because the pin would change corners", async () => {
    // `fix` compiles to "pin whatever solver point this corner index resolves
    // to" — it stores no target position (sketchSolve's `fix` branch). So the mirror
    // leaves it SATISFIED and stable-looking, which is what makes it dangerous:
    // measured with this refusal disabled, the drag is accepted, three following
    // pumps are byte-identical, and the pinned corner 2 has quietly moved from
    // (20,10) to (25,15) — the point the user pinned is now labelled corner 0.
    //
    // So the assertion is about the PIN, not about the refusal: the corner the
    // user said would not move must not have moved.
    const start = [RECT("R", 0, 0, 40, 20)];
    const pinned = [{ type: "fix", e: "R", p: 2 } as SketchConstraint];
    const before = pt(start, "R", 2);
    const r = await compileAndSolve(start, pinned, { fromX: -20, fromY: -10, toX: 25, toY: 15 });
    expect(dist(pt(r.entities, "R", 2), before), "the pinned corner moved").toBeLessThanOrEqual(TOL);
    expect(r.dragRefused, "and the caller keeps its anchor on the grabbed corner").toBe("geometry");

    // TEETH: the identical drag with no pin must still work, or the row above
    // would pass against a build that refuses every drag of this rectangle.
    const free = await compileAndSolve(start, [], { fromX: -20, fromY: -10, toX: 25, toY: 15 });
    expect(free.ok, "the unpinned control drag solves").toBe(true);
    expect(dist(pt(free.entities, "R", 2), before), "and does move that corner")
      .toBeGreaterThan(MIN_VIOLATION);
  });

  it("an ANGLE between two rect edges does NOT veto the mirror", async () => {
    // The other side of the same question, and it goes the other way. A signed
    // angle looks like it must break under a reflection, but a single-axis
    // mirror negates the angle between two edges of the same rectangle, so the
    // solver cannot reach one without violating the constraint it is enforcing
    // (measured: the -90 spelling of this fixture conflicts outright), and a
    // two-axis mirror is a 180-degree rotation, which preserves signed angles.
    // Refusing it would cost a working gesture for a hazard that cannot occur.
    const start = [RECT("R", 0, 0, 40, 20)];
    const cons = [{ type: "angle", l1: "R~0", l2: "R~1", value: 90 } as unknown as SketchConstraint];
    const dragged = await compileAndSolve(start, cons, { fromX: -20, fromY: -10, toX: 25, toY: 15 });
    expect(dragged.ok, "a mirror the angle cannot observe must not be refused").toBe(true);
    const R = byId(dragged.entities).get("R") as { width: number; height: number };
    expect(R.width, "the rectangle followed the cursor").toBeCloseTo(5, 6);
    expect(R.height).toBeCloseTo(5, 6);
    const pumped = await compileAndSolve(dragged.entities, cons);
    expect(pumped.ok, "and the result settles").toBe(true);
    expect(pumped.entities, "with no drift on the next pump").toEqual(dragged.entities);
  });

  it("a dimension between TWO rectangles scopes both of them", async () => {
    // Neither operand is "something else" by type — both are rectangles — so the
    // isometry argument that lets an edge dimension through has to be read
    // carefully: it holds only when the reflection moves EVERYTHING the
    // constraint names. Here it moves R and leaves C where it is pinned, so R's
    // relabel is observable through C.
    //
    // Measured with the two-rectangle clause removed: ok:true, conflicts:[], R
    // back as 9.266 x 19.320 with corner 0 relabelled — bug A again, reached
    // without a single non-rectangle entity in the sketch.
    const start = [RECT("R", 0, 0, 40, 20), RECT("C", 35, 35, 10, 10)];
    const cons = [
      { type: "fix", e: "C", p: 0 } as SketchConstraint, // C's corner 0 sits at (30,30)
      { type: "p2pDistance", e1: "C", p1: 0, e2: "R", p2: 0, value: 1 } as SketchConstraint,
    ];
    const r = await compileAndSolve(start, cons);
    expect(r.ok, "a mirror observable through the OTHER rectangle must be refused").toBe(false);
    expect(r.entities, "and the pre-solve geometry is handed back").toEqual(start);
  });

  it("an OFFSET tying two rectangles refuses a mirroring drag", async () => {
    // R's top edge is offset 5 mm from C's top edge. Dragging R's bottom-left
    // corner up past its own top edge gives the solver R at w 40 h -30 with C
    // untouched: a clean y-mirror, no collapse. It must not reach the document.
    //
    // What this row does NOT pin, stated so nobody reads it as more than it is:
    // `offset` is also a rim dim (sketchSolve.isRimDim), so the rim-branch
    // invariant refuses this same drag on its own. Measured — with the corner
    // scan's `pairs` arm deleted, all four offset fixtures tried came back
    // refused exactly as below. So this asserts the user-visible outcome, not
    // which guard produced it.
    const start = [RECT("R", 0, 0, 40, 20), RECT("C", 0, 0, 50, 30)];
    const cons = [{ type: "offset", value: 5, pairs: [{ src: "R~2", cpy: "C~2" }] } as unknown as SketchConstraint];
    const settled = await compileAndSolve(start, cons);
    expect(settled.ok, "the fixture must settle first").toBe(true);
    const dragged = await compileAndSolve(settled.entities, cons, { fromX: -20, fromY: -10, toX: -20, toY: 40 });
    expect(dragged.ok, "a mirror an offset pair can see must be refused").toBe(false);
    expect(dragged.entities, "and the pre-solve geometry handed back").toEqual(settled.entities);
  });
});

// ---------------------------------------------------------------------------
// 4b. THE SAME LOSS FROM A DRAG — no new affordance required
// ---------------------------------------------------------------------------

describe("dragging a rectangle corner cannot silently relabel it", () => {
  // The corner-identity bug is NOT gated behind a future picker. pickPoint
  // already enumerates rectangle corners (sketchMode.pickPoint), so the
  // select tool grabs one today, and dimensionTool already emits corner and
  // edge operands (dimensionTool.ts:224-235). One dimension plus one drag is
  // enough, in the shipped beta.
  //
  // Which is also why the guard cannot simply refuse every mirror of a
  // dimensioned rectangle: dimensioning an edge and dragging a corner past the
  // opposite one is a shipped gesture, and the two tests below are the two sides
  // of that — one dimension the mirror cannot observe, one it can.

  const A_PT = (x: number, y: number) => ({ type: "point", id: "A", x, y } as unknown as ResolvedEntity);

  it("an edge dimension does NOT veto the mirroring drag", async () => {
    // The constraint the dimension tool emits for "click a rectangle edge, type
    // 40" (dimensionTool.ts:576-582 -> p2pPlan at :394-397): bare id, corners 0
    // and 1. Grab the bottom-left corner and drag it straight up past the top
    // edge.
    //
    // The write-back mirrors: doc corner j ends up holding the reflection of
    // solver corner j about the rectangle's own mid-axis. That reflection is an
    // ISOMETRY of the rectangle, so a dimension whose two operands are both on
    // this one rectangle has exactly the residual it had in the solver — bottom
    // edge and top edge of an axis-aligned rectangle are the same length, and
    // the dim cannot tell which one it is being measured on. Refusing here would
    // freeze a working gesture and hand back geometry with no toast and no red
    // chip, so the rectangle must come through.
    const start = [RECT("R", 0, 0, 40, 20)];
    const cons = [{ type: "p2pDistance", e1: "R", p1: 0, e2: "R", p2: 1, value: 40 } as SketchConstraint];
    const dragged = await compileAndSolve(start, cons, { fromX: -20, fromY: -10, toX: -20, toY: 30 });
    expect(dragged.ok, "a mirror no constraint can observe must not be refused").toBe(true);
    expect(dragged.dragRefused, "and the caller keeps following the cursor").toBeUndefined();

    // the grabbed corner is under the cursor (it is document corner 3 now, which
    // is the whole point: the LABEL moved, the geometry did what was asked)
    const R = byId(dragged.entities).get("R") as { x: number; y: number; width: number; height: number };
    const corners = rectCorners(R.x, R.y, R.width, R.height);
    expect(Math.min(...corners.map((c) => dist(c, { x: -20, y: 30 }))),
      "the corner the user is holding is under the cursor").toBeLessThanOrEqual(TOL);
    expectStillRectangular(dragged.entities, "R", "after the mirroring drag", start);
    expect(dist(pt(dragged.entities, "R", 0), pt(dragged.entities, "R", 1)),
      "and the edge dimension still measures 40").toBeCloseTo(40, 6);

    // and it settles: the next pump with nothing touched must not move it
    const pumped = await compileAndSolve(dragged.entities, cons);
    expect(pumped.ok, "the pumped solve succeeds").toBe(true);
    expect(pumped.entities, "an untouched re-solve must not move the geometry")
      .toEqual(dragged.entities);
  });

  it("a dimension to something OUTSIDE the rectangle DOES veto it, and says so", async () => {
    // The other side. Same drag, but the dimension ties the rectangle's top edge
    // to a fixed point, which the reflection does not move — so the relabel is
    // observable: in solver space the constraint holds, in the document it does
    // not, and the next pump used to close that gap by eating the rectangle
    // (measured unfixed: drag -> w 40 h 20 looking perfect, next pump -> h 0).
    //
    // The refusal MUST reach the caller. conflicts is empty here (nothing blames
    // a constraint for a collapsed rectangle), so `dragRefused` is the only
    // channel that stops sketchMode advancing its drag anchor to the cursor
    // (sketchMode's `this.dragFrom.set(d.toX, d.toY)`) and grabbing a different corner on the next frame.
    const ents = [RECT("R", 0, 0, 40, 20), A_PT(0, -30)];
    const cons = [
      { type: "fix", e: "A", p: 0 } as SketchConstraint,
      { type: "p2lDistance", e: "A", p: 0, line: "R~2", value: 40 } as SketchConstraint,
    ];
    const settled = await compileAndSolve(ents, cons);
    expect(settled.ok, "the fixture must settle before the drag means anything").toBe(true);
    expectStillRectangular(settled.entities, "R", "settled", ents);

    const dragged = await compileAndSolve(settled.entities, cons, { fromX: -20, fromY: -10, toX: -20, toY: 30 });
    expect(dragged.ok, "a mirror this dimension CAN observe is refused").toBe(false);
    expect(dragged.entities, "and the geometry is handed back untouched").toEqual(settled.entities);
    expect(dragged.dragRefused, "and the caller is told to keep its anchor").toBe("geometry");

    const pumped = await compileAndSolve(dragged.entities, cons);
    expect(pumped.entities, "a refused solve must not drift on the next pump")
      .toEqual(dragged.entities);
    expectStillRectangular(pumped.entities, "R", "after the drag settled", ents);
  });

  it("TEETH: the same fixture still drags when the drag does not mirror it", async () => {
    // Without this the test above passes against a build that refuses EVERY drag
    // of a dimensioned rectangle — which is what it was measuring before this
    // row existed. Same entities, same constraint, a pull that keeps the corner
    // order: the rectangle must actually move.
    const ents = [RECT("R", 0, 0, 40, 20), A_PT(0, -30)];
    const cons = [
      { type: "fix", e: "A", p: 0 } as SketchConstraint,
      { type: "p2lDistance", e: "A", p: 0, line: "R~2", value: 40 } as SketchConstraint,
    ];
    const settled = await compileAndSolve(ents, cons);
    const dragged = await compileAndSolve(settled.entities, cons, { fromX: -20, fromY: -10, toX: -35, toY: -10 });
    expect(dragged.ok, "an ordinary drag of a dimensioned rectangle must still solve").toBe(true);
    expect(dragged.dragRefused, "and must not be reported as refused").toBeUndefined();
    const R = byId(dragged.entities).get("R") as { width: number };
    expect(R.width, "the rectangle actually widened under the cursor").toBeCloseTo(55, 6);
    expectStillRectangular(dragged.entities, "R", "after the ordinary drag", ents);
  });

  it("CONTROL: an UNCONSTRAINED corner drag past the opposite corner still works", async () => {
    // This is what stops the guard being a blanket "refuse every sign flip".
    // With nothing addressing the rectangle by corner or edge, a mirror is a
    // pure renaming — no constraint can observe it — and the gesture is correct
    // today: grab bl at (-20,-10), drag to (25,15), and the dragged corner is
    // still under the cursor. Refusing this would freeze the drag mid-gesture,
    // and sketchMode advances the drag anchor anyway, so the next frame
    // would search for a nearest point from a drifted origin.
    const r = await compileAndSolve([RECT("R", 0, 0, 40, 20)], [], { fromX: -20, fromY: -10, toX: 25, toY: 15 });
    expect(r.ok, "a free corner drag must not be refused").toBe(true);
    const R = byId(r.entities).get("R") as { x: number; y: number; width: number; height: number };
    expect(R.width, "the mirrored drag gives a 5 mm wide rectangle").toBeCloseTo(5, 6);
    expect(R.height).toBeCloseTo(5, 6);
    expect(R.x).toBeCloseTo(22.5, 6);
    expect(R.y).toBeCloseTo(12.5, 6);
  });
});

// ---------------------------------------------------------------------------
// 5. THE SAME COLLAPSE FROM THE EDGE SIDE
// ---------------------------------------------------------------------------

describe("a rectangle solved out of existence is refused, not written", () => {
  // Same class as the 2026-08-15 field report (a 65 mm line folded to zero
  // length so an impossible `parallel` became vacuous), on the path that fix did
  // not reach: compileAndSolve's collapse scan walked `before.type === "line"`
  // only, and a rectangle's four edges are never `line` entities.
  // expectSaneGeometry had no rectangle case either — it switched on
  // line/circle/arc/point and fell through.
  //
  // Both blind spots are closed as of 2026-08-17 (the rectangle arm of
  // sketchSolve's solve guard, and expectSaneGeometry's rectangle case), so every case below asserts the REFUSAL. The
  // measurements quoted in each comment are what the unfixed tree produced —
  // kept, because they are what made the bug legible.
  //
  // REACHABLE BY CLICKING as of 2026-08-17. This block used to open with "not
  // reachable today, and only because two doors happen to be shut": the
  // constraint tools refused a rectangle outright, and evalDimInput rejects a
  // non-positive length. Step 3 opened the first of those — which is exactly
  // what "select a corner on a rectangle" asked for — so every row below is now
  // two clicks away, and the guards under them are the only thing between a user
  // and a rectangle that eats itself. That is the whole reason the guards went
  // in first.

  it("THE PAIR: the same contradiction is refused on a line and on a rectangle", async () => {
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
    // carries the horizontal half implicitly (`R~h0`, pushed by sketchSolve's rectangle branch). One
    // user constraint, `vertical`, is all it takes. Unfixed, the solve reported
    // SUCCESS, blamed nothing, and wrote a 0 x 20 rectangle into the document.
    const rect = [RECT("R", 0, 0, 40, 20)];
    const rectResult = await compileAndSolve(rect, [{ type: "vertical", line: "R~0" } as SketchConstraint]);
    expect(rectResult.ok, "the RECTANGLE in the same contradiction is refused too").toBe(false);
    expect(rectResult.entities, "and its pre-solve geometry is handed back").toEqual(rect);

    // and the blanket post-condition every other test in this repo leans on now
    // has a rectangle case (pinned shape by shape in the block below), so a
    // collapse reaching the document by some other route is caught there too
    expect(() => expectSaneGeometry([RECT("R", 0, 0, 0, 20)], "a flattened rectangle", rect),
      "expectSaneGeometry must reject a collapsed rectangle")
      .toThrow(/collapsed/);
  });

  it("parallel between a rect edge and a skew line is refused, not flattened", async () => {
    // Unfixed: ok:true, conflicts:[], height 8.881784197001252e-16.
    const start = [RECT("R", 0, 0, 40, 20), L("A", 40, 0, 70, 12)];
    const r = await compileAndSolve(start, [{ type: "parallel", l1: "R~1", l2: "A" } as SketchConstraint]);
    expect(r.ok, "the collapse must be refused").toBe(false);
    expect(r.entities, "and the pre-solve geometry handed back").toEqual(start);
  });

  it("perpendicular is achieved or refused depending on the OTHER line's start angle", async () => {
    // Why the matrix's `perpendicular` row passing is not reassurance. Same
    // constraint, same rectangle, same first click — only the free line's
    // starting direction differs, and that decides whether the solver rotates
    // the line (correct) or flattens the rectangle. A user cannot see which side
    // of that they are on before clicking.
    //
    // What the guard changes: the flattening branch is REFUSED rather than
    // silently applied, so the two are no longer indistinguishable from the
    // outside. The coin flip itself remains — that is a solver property, not
    // something a post-solve guard can remove.
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

    expect(steep.ok, "a steep starting line: the constraint is achieved").toBe(true);
    expect(steep.width, "and the rectangle survives").toBeGreaterThan(MIN_VIOLATION);
    // unfixed: ok true, width 0 — the flattening was indistinguishable from the steep case
    expect(shallow.ok, "a shallow starting line: the flattening solve is refused").toBe(false);
    expect(shallow.width, "and the rectangle comes back exactly as it went in").toBeCloseTo(40, 9);
  });

  it("symmetric about a rect-edge axis: a zero-width answer never reaches the document", async () => {
    // This one is BISTABLE, so it asserts what holds across BOTH branches rather
    // than a width. Cold in the process the rectangle comes back 0 wide; after a
    // larger unrelated solve, 33.49 wide. Same entities, same constraint, both
    // branches satisfying it exactly. See solveReproducibility.test.ts, which
    // pins that on its own (a fresh file is the only way to control "cold" —
    // vitest gives each test file a worker, and the flip latches for the rest of
    // the process once it happens).
    //
    // What IS invariant, and is the point here: the rectangle's width is nobody's
    // decision — nothing constrains it and nothing reports it — but if the
    // solver's answer is zero, the guard refuses it and the document keeps what
    // it had. Either branch is a legitimate outcome; a collapsed rectangle in
    // the document is not.
    const start = [RECT("R", 0, 0, 40, 20), L("A", -30, 30, -10, 33), L("B", 10, -30, 30, -35)];
    const r = await compileAndSolve(start, [
      { type: "symmetric", e1: "A", p1: 0, e2: "B", p2: 0, line: "R~0" } as SketchConstraint,
    ]);
    if (!r.ok) {
      expect(r.entities, "the refused branch hands back the pre-solve geometry").toEqual(start);
      return;
    }
    expect(r.conflicts).toEqual([]);
    expectStillRectangular(r.entities, "R", "symmetric about a rect edge", start);
    // the constraint itself IS achieved on the accepted branch — the axis is the
    // rectangle's bottom edge, so the two points must straddle it evenly
    const R2 = byId(r.entities).get("R") as { width: number; height: number; y: number };
    const axisY = R2.y - R2.height / 2;
    const A = byId(r.entities).get("A") as { y1: number };
    const B = byId(r.entities).get("B") as { y1: number };
    expect(Math.abs((A.y1 - axisY) + (B.y1 - axisY)), "symmetric holds")
      .toBeLessThanOrEqual(TOL);
  });

  it("a p2lDistance of 0 across a rectangle is refused, not flattened", async () => {
    // The same collapse through a plain dimension. Blocked at the UI only by
    // evalDimInput's `value > 0` check — nothing below that layer refused it.
    // Unfixed: ok:true, conflicts:[], height 0.
    const start = [RECT("R", 0, 0, 40, 20)];
    const r = await compileAndSolve(start, [
      { type: "p2lDistance", e: "R", p: 0, line: "R~2", value: 0 } as SketchConstraint,
    ]);
    expect(r.ok, "the collapse must be refused").toBe(false);
    expect(r.entities, "and the pre-solve geometry handed back").toEqual(start);
  });

  it.each([
    ["zero height", () => [RECT("R", 0, 0, 40, 0), L("A", 60, 0, 100, 3)] as ResolvedEntity[]],
    ["zero width", () => [RECT("R", 0, 0, 0, 20), L("A", 60, 0, 100, 3)] as ResolvedEntity[]],
  ])("EXEMPTION (%s): a rectangle that was ALREADY flat is not newly refused", async (_label, mk) => {
    // The gate that stops the fix trading one bug for another. A 40 x 0
    // rectangle can exist in a document (a drag, a bound parameter, an older
    // file), and a guard that judged only the POST-solve size would make it
    // permanently unsolvable — every pump refused, the whole sketch frozen.
    // Mirrors the line arm's `lenOf(prev) > MIN_LEN` gate exactly.
    //
    // Both axes, because the gate is two independent clauses: with only the
    // zero-height row here, the width clause could be changed to fire on every
    // rectangle and the suite would stay green (measured).
    const start = mk();
    const r = await compileAndSolve(start, [{ type: "horizontal", line: "A" } as SketchConstraint]);
    expect(r.ok, "a pre-existing degenerate rectangle must not fail the solve").toBe(true);
    expect(r.conflicts).toEqual([]);
  });

  it("CONTROL: the same collapse on a plain LINE is caught", async () => {
    // Proof the guard mechanism works and the rectangle was genuinely the blind
    // spot, not the whole mechanism being absent. Green before the rectangle
    // arms landed and green after: the fix is targeted, not blunt.
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
// 5b. THE SHARED POST-CONDITION'S RECTANGLE CASE, SHAPE BY SHAPE
// ---------------------------------------------------------------------------

describe("expectSaneGeometry judges a rectangle on every axis it can fail on", () => {
  // solveInvariants is what four other suites lean on for "whatever solved is
  // still geometry", so its rectangle arm needs its own teeth: with only a
  // zero-WIDTH literal checking it (which is all THE PAIR above does), the
  // height clause, the finiteness clause and the no-`before` clause could each
  // be deleted with the whole suite green. Measured, one mutation at a time —
  // that is why the rows below are separate.
  const was = [RECT("R", 0, 0, 40, 20)];

  it.each([
    ["zero width", RECT("R", 0, 0, 0, 20), /collapsed to zero width/],
    ["zero height", RECT("R", 0, 0, 40, 0), /collapsed to zero height/],
    // The gap an absolute 1e-7 leaves, and the one a real solve landed in
    // (see "squeezed to a millionth of a millimetre" above): 4.6e-7 mm is under
    // the 0.001 mm bucket at which this compiler stops telling two points apart,
    // so the next solve fuses those corners into one.
    ["a millionth of a mm wide", RECT("R", 0, 0, 4.6035578193937e-7, 20), /collapsed to zero width/],
    ["non-finite", RECT("R", 0, 0, NaN, 20), /non-finite/],
  ])("rejects %s", (_label, wreck, msg) => {
    expect(() => expectSaneGeometry([wreck], "post-solve", was)).toThrow(msg);
  });

  it("judges a rectangle with no `before` list at all", () => {
    // The `!before` half of the gate: called without a pre-solve list there is
    // nothing to be lenient about, so a flat rectangle is flat, full stop.
    expect(() => expectSaneGeometry([RECT("R", 0, 0, 40, 0)], "no before list"))
      .toThrow(/collapsed to zero height/);
  });

  it("EXEMPTION: a rectangle that was already flat going in is left alone", () => {
    // Same lenience the line arm has, and for the same reason: reporting a
    // pre-existing degenerate entity as though this solve created it would make
    // every later assertion in the suite unreadable.
    expect(() => expectSaneGeometry([RECT("R", 0, 0, 40, 0)], "already flat", [RECT("R", 0, 0, 40, 0)]))
      .not.toThrow();
    expect(() => expectSaneGeometry([RECT("R", 0, 0, 0, 20)], "already flat", [RECT("R", 0, 0, 0, 20)]))
      .not.toThrow();
  });

  it("and a refused solve is judged as unchanged on the rectangle's own fields", () => {
    // The other post-condition in solveInvariants, and the one that would have
    // caught the 4.6e-7 escape by itself: a not-ok solve must not have handed
    // back changed geometry. Its key() built a per-type fingerprint for lines and
    // circles and fell back to the bare id for everything else, so a rectangle
    // could be squeezed to a millionth of a millimetre, come back with ok:false,
    // and compare EQUAL to what went in.
    const before = [RECT("R", 0, 0, 40, 20)];
    expect(() => expectUnchangedOnFailure({ ok: false }, before,
      [RECT("R", -19.17, -25, 4.6035578193937e-7, 70)], "a wrecked rectangle"))
      .toThrow(/still changed the geometry/);
    expect(() => expectUnchangedOnFailure({ ok: false }, before, [RECT("R", 0, 0, 40, 20)], "unchanged"))
      .not.toThrow();
  });

  it("and a healthy rectangle passes", () => {
    // The teeth on the rows above: without this they would all pass against a
    // rectangle case that throws unconditionally.
    expect(() => expectSaneGeometry([RECT("R", 5, 5, 40, 20)], "healthy", was)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5c. THE RATCHET ENUMERATES EMISSION FORMS, NOT TOOLS
// ---------------------------------------------------------------------------

describe("every branch of the tangent2 and equalRadius ladders compiles", () => {
  // Section 1 enumerates CONSTRAINT_TOOLS, which is one rung short of what
  // matters: two of those tools emit ONE constraint type that the compiler then
  // splits by the KINDS of its two operands — tangent2 eight ways and
  // equalRadius four (sketchSolve's tangent2/equalRadius ladders). A tool row
  // exercises exactly one of those branches, so six arc branches could be
  // deleted with the whole suite green. Measured, one at a time.
  //
  // Generated as the full cross product rather than a hand-written list, so a
  // branch cannot be forgotten here the way it was forgotten there. What it
  // asserts is the SEMANTIC outcome, not that DOF moved: a deleted branch makes
  // the constraint compile to nothing, the geometry comes back untouched, and
  // the residual is still the violation it started at.
  const KINDS = ["line", "circle", "arc"] as const;
  // Two slots, so the same kind can appear on both sides without the two
  // fixtures coinciding. Positions chosen so EVERY pair starts violated by
  // several mm (asserted below, per row).
  const SLOT_A: Record<(typeof KINDS)[number], () => ResolvedEntity> = {
    line: () => L("P", -60, 0, 60, 0),
    circle: () => C("P", 0, 0, 20),
    arc: () => ARC("P", 0, 0, 20, 0.3, 2.5),
  };
  const SLOT_B: Record<(typeof KINDS)[number], () => ResolvedEntity> = {
    line: () => L("Q", -60, 40, 60, 46),
    circle: () => C("Q", 60, 6, 9),
    arc: () => ARC("Q", 60, 6, 9, -1, 1.5),
  };
  /** a line + a round are tangent when the centre sits one radius off the line;
   *  two rounds when their centres are a sum OR a difference of radii apart
   *  (the tool cannot pick the branch — see the two-circle row in section 1) */
  const tangency = (ka: string, kb: string): Residual => (e) => {
    if (ka === "line" || kb === "line") {
      const lineId = ka === "line" ? "P" : "Q";
      const roundId = ka === "line" ? "Q" : "P";
      const k = round(e, roundId);
      return Math.abs(perpDist(k, seg(e, lineId)) - k.r);
    }
    const a = round(e, "P"), b = round(e, "Q");
    const d = dist(a, b);
    return Math.min(Math.abs(d - (a.r + b.r)), Math.abs(d - Math.abs(a.r - b.r)));
  };

  const TANGENT_PAIRS = KINDS.flatMap((ka) => KINDS.map((kb) => [ka, kb] as const))
    .filter(([ka, kb]) => !(ka === "line" && kb === "line")); // two lines cannot be tangent

  it("covers all eight tangent2 branches", () => {
    // The ratchet on the ratchet: 3x3 kinds minus line+line is what the ladder
    // has arms for, and this is what says so if either side changes.
    expect(TANGENT_PAIRS).toHaveLength(8);
  });

  it.each(TANGENT_PAIRS)("tangent2 %s + %s reaches the solver and is achieved", async (ka, kb) => {
    const start = [SLOT_A[ka](), SLOT_B[kb]()];
    const res = tangency(ka, kb);
    expect(res(start), `tangent2 ${ka}+${kb}: the fixture is already tangent`)
      .toBeGreaterThan(MIN_VIOLATION);
    const after = await solved(start, [{ type: "tangent2", a: "P", b: "Q" } as SketchConstraint]);
    expect(res(after), `tangent2 ${ka}+${kb}: the compile ladder dropped this branch`)
      .toBeLessThanOrEqual(TOL);
  });

  const RADIUS_PAIRS = (["circle", "arc"] as const)
    .flatMap((ka) => (["circle", "arc"] as const).map((kb) => [ka, kb] as const));

  it.each(RADIUS_PAIRS)("equalRadius %s + %s reaches the solver and is achieved", async (ka, kb) => {
    const start = [SLOT_A[ka](), SLOT_B[kb]()];
    const res: Residual = (e) => Math.abs(round(e, "P").r - round(e, "Q").r);
    expect(res(start), `equalRadius ${ka}+${kb}: the fixture already has equal radii`)
      .toBeGreaterThan(MIN_VIOLATION);
    const after = await solved(start, [{ type: "equalRadius", a: "P", b: "Q" } as SketchConstraint]);
    expect(res(after), `equalRadius ${ka}+${kb}: the compile ladder dropped this branch`)
      .toBeLessThanOrEqual(TOL);
  });
});

// ---------------------------------------------------------------------------
// 5d. THE POINT-PAIR TOOLS, DRIVEN AT EVERY KIND OF POINT
// ---------------------------------------------------------------------------

describe("coincident / midpoint / symmetric reach every kind of point", () => {
  // The same flaw one layer down. Section 1's three point-pair rows all name a
  // LINE endpoint, and all three tools resolve through ONE function
  // (endpointPoint), which has an arm per entity kind — so the sketch-point arm
  // and the spline arm could each be deleted with the file green. Measured. The
  // rectangle arm added on 2026-08-17 would have been the fourth.
  //
  // One table of point PROVIDERS, driven through all three tools, so a new arm
  // gets covered by adding one row rather than by remembering three tests.
  const PROVIDERS: { kind: string; ents: () => ResolvedEntity[]; ref: [string, number]; at: V2 }[] = [
    { kind: "line end", ents: () => [L("P", 0, 0, 30, 0)], ref: ["P", 1], at: { x: 30, y: 0 } },
    { kind: "arc end", ents: () => [ARC("P", 0, 0, 20, 0, Math.PI / 2)], ref: ["P", 1], at: { x: 0, y: 20 } },
    { kind: "sketch point", ents: () => [PT("P", 12, 7)], ref: ["P", 0], at: { x: 12, y: 7 } },
    { kind: "spline end", ents: () => [SPL("P", [[0, 0], [10, 6], [24, 4]])], ref: ["P", 1], at: { x: 24, y: 4 } },
    { kind: "rectangle corner", ents: () => [RECT("P", 0, 0, 40, 20)], ref: ["P", 2], at: { x: 20, y: 10 } },
  ];

  it.each(PROVIDERS)("coincident takes a $kind", async ({ kind, ents, ref, at }) => {
    // The target is PINNED, so the only way the distance closes is the provider
    // point moving — a constraint that compiled to nothing leaves it where it is.
    const start = [...ents(), PT("T", -18, 26)];
    const cons = [
      { type: "fix", e: "T", p: 0 } as SketchConstraint,
      { type: "coincident", e1: "P", p1: ref[1], e2: "T", p2: 0 } as SketchConstraint,
    ];
    expect(dist(at, { x: -18, y: 26 }), `${kind}: the fixture is already coincident`)
      .toBeGreaterThan(MIN_VIOLATION);
    const after = await solved(start, cons);
    expect(dist(pt(after, ref[0], ref[1]), { x: -18, y: 26 }),
      `${kind}: endpointPoint has no arm for this — the constraint was dropped`)
      .toBeLessThanOrEqual(TOL);
  });

  it.each(PROVIDERS)("midpoint takes a $kind", async ({ kind, ents, ref }) => {
    // The line is pinned at both ends, so its midpoint is a fixed target.
    // Placed up and to the RIGHT of every provider point on purpose: pulling a
    // rectangle's top-right corner to the LEFT of its own top-left one is
    // satisfied by mirroring, which the corner-identity guard refuses — a
    // correct refusal, and not what this row is measuring.
    const start = [...ents(), L("AX", 30, 34, 70, 34)];
    const cons = [
      { type: "fix", e: "AX", p: 0 } as SketchConstraint,
      { type: "fix", e: "AX", p: 1 } as SketchConstraint,
      { type: "midpoint", e: "P", p: ref[1], line: "AX" } as SketchConstraint,
    ];
    const after = await solved(start, cons);
    expect(dist(pt(after, ref[0], ref[1]), { x: 50, y: 34 }),
      `${kind}: midpoint dropped this operand`).toBeLessThanOrEqual(TOL);
  });

  it.each(PROVIDERS)("symmetric takes a $kind", async ({ kind, ents, ref }) => {
    // Axis pinned vertical at x = -40; B pinned. The provider's point is the
    // only thing free to move onto B's mirror image.
    const start = [...ents(), PT("B", -70, 12), L("AX", -40, -60, -40, 60)];
    const cons = [
      { type: "fix", e: "AX", p: 0 } as SketchConstraint,
      { type: "fix", e: "AX", p: 1 } as SketchConstraint,
      { type: "fix", e: "B", p: 0 } as SketchConstraint,
      { type: "symmetric", e1: "P", p1: ref[1], e2: "B", p2: 0, line: "AX" } as SketchConstraint,
    ];
    const after = await solved(start, cons);
    expect(dist(pt(after, ref[0], ref[1]), { x: -10, y: 12 }),
      `${kind}: symmetric dropped this operand`).toBeLessThanOrEqual(TOL);
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
    // red this way — that is what redundant MEANS — and a "conflict" row
    // asserts a refusal, whose teeth are the non-mirroring CONTROL beside it.
    for (const [tool, cases] of Object.entries(RECT_CASES)) {
      for (const spec of cases.filter((s) => s.outcome === "satisfied")) {
        const label = spec.form ? `${tool} (${spec.form})` : tool;
        const start = spec.entities();
        if (spec.provedByNotMoving) {
          const { pull, point } = spec.provedByNotMoving;
          const before = pt(start, point[0], point[1]);
          const after = await solved(start, [pull]); // the pin is dropped
          expect(dist(pt(after, point[0], point[1]), before),
            `${label}: the rectangle pin predicate passes with NO pin applied`)
            .toBeGreaterThan(MIN_VIOLATION);
          continue;
        }
        const after = await solved(start, []);
        expect(spec.residual(after),
          `${label}: the rectangle predicate passes with NO constraint applied`)
          .toBeGreaterThan(MIN_VIOLATION);
      }
    }
  });

  it("the angular predicates refuse to GRADE a collapsed line", () => {
    // The other way a predicate can be vacuous, and the one the file's own
    // `dir()` was written for: at zero length a line has no direction, so every
    // angular property is true of it. `horizontal` and `vertical` measured
    // |y1-y2| and |x1-x2| straight off the endpoints, which are 0 on a collapsed
    // line — so the row that records `horizontal` as harmless would have recorded
    // a solve that folded the line to a point as harmless too. Every other
    // angular row in the file (parallel/perpendicular/collinear) already went
    // through dir() and already threw. These two now do as well.
    const collapsed = [L("A", 7, 7, 7, 7)];
    for (const tool of ["horizontal", "vertical"] as const) {
      expect(() => TOOL_CASES[tool]![0]!.residual(collapsed),
        `${tool}: a collapsed line was graded, not refused`).toThrow(/collapsed/);
    }
    // and the same predicates on the RECTANGLE side of the matrix, which is
    // where a collapse is actually reachable (a rect edge pinned against its own
    // implicit rule)
    const flatRect = [RECT("R", 0, 0, 0, 20)];
    expect(() => RECT_CASES["horizontal"]![0]!.residual(flatRect),
      "the rect-edge horizontal predicate graded a collapsed edge").toThrow(/collapsed/);
  });

  it("expectStillRectangular rejects a rectangle with no area", () => {
    // The rectangle post-condition itself, exercised against geometry it must
    // refuse — otherwise the matrix's "stays a rectangle" clause is decoration.
    const was = [RECT("R", 0, 0, 40, 20)];
    const flat = [RECT("R", 0, 0, 40, 0)];
    expect(() => expectStillRectangular(flat, "R", "flat", was)).toThrow(/zero height/);
    const thin = [RECT("R", 0, 0, 0, 20)];
    expect(() => expectStillRectangular(thin, "R", "thin", was)).toThrow(/zero width/);
  });

  it("expectStillRectangular judges the collapse RELATIVE to what went in", () => {
    // The hole an absolute floor leaves, and the reason this helper takes the
    // pre-solve list at all. A 40 x 20 rectangle coming back 40 x 0.002 is not a
    // survivor by any reading a user would accept — but 0.002 clears the
    // 0.001 mm absolute fence, so it passed as one. Two rows, one per axis, so
    // neither relative floor can be deleted with the file green.
    const was = [RECT("R", 0, 0, 40, 20)];
    expect(() => expectStillRectangular([RECT("R", 0, 0, 40, 0.002)], "R", "squeezed", was))
      .toThrow(/zero height/);
    expect(() => expectStillRectangular([RECT("R", 0, 0, 0.002, 20)], "R", "squeezed", was))
      .toThrow(/zero width/);
    // and the teeth: a rectangle a constraint legitimately RESIZED is not a
    // collapse. The matrix says so out loud ("may legitimately MOVE and RESIZE"),
    // so the floor has to be a fraction of the original, not a fraction of
    // "unchanged".
    expect(() => expectStillRectangular([RECT("R", 3, 4, 6, 1)], "R", "resized", was))
      .not.toThrow();
  });
});
