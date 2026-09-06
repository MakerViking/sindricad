// Snapping onto a point now CONSTRAINS to it, not just copies its coordinate.
//
// Field report ecc3e0d6: "instead of making their endpoints perfectly
// coincident, the tool creates a very small gap of a few hundredths of a
// millimetre. These micro-gaps prevent the lines from being truly joined and can
// subsequently cause cracks during extrusion, as well as undetected or missing
// regions. The lines should automatically [be constrained]."
//
// Half of that shipped in 0.1.186: auto-H/V stopped MOVING the endpoint that had
// just been snapped. But snapping still only copied coordinates, so two points
// that coincided when drawn could be driven apart by any later solve. This is
// the other half — the snap now carries WHICH solver point it landed on, and the
// commit turns that into a real `coincident`.
//
// The index convention is the whole correctness story, so it is what is pinned
// hardest here.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
import { compileAndSolve } from "./sketchSolve";
import type { SketchConstraint } from "../types";
import * as THREE from "three";
import { candidatesFromEntities, snap, snapCoincidences, type ResolvedEntity, type PointRef } from "./snap";
import { rectCorners } from "./region";
import sketchSrc from "./sketchMode.ts?raw";

/** snap() needs a screen projection; identity is fine for these. */
const toScreen = (p: THREE.Vector2) => ({ x: p.x, y: p.y });
const at = (ents: ResolvedEntity[], x: number, y: number) =>
  snap(new THREE.Vector2(x, y), candidatesFromEntities(ents), toScreen, 0, 0.5);

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });

describe("a snapped endpoint knows which solver point it is", () => {
  it("names a line's two ends 0 and 1, matching endpointPoint", () => {
    const ents = [line("l1", 0, 0, 10, 0)];
    expect(at(ents, 0, 0).ref).toEqual({ id: "l1", idx: 0 });
    expect(at(ents, 10, 0).ref).toEqual({ id: "l1", idx: 1 });
  });

  it("names an arc's start and end, but NOT its through-point", () => {
    const arc: ResolvedEntity = { type: "arc", id: "a1", x1: 0, y1: 0, x2: 10, y2: 0, mx: 5, my: 5 };
    expect(at([arc], 0, 0).ref).toEqual({ id: "a1", idx: 0 });
    expect(at([arc], 10, 0).ref).toEqual({ id: "a1", idx: 1 });
    // the through-point is a snap target but not a solver point — it must snap
    // and emit NOTHING, rather than name an index that resolves elsewhere
    const mid = at([arc], 5, 5);
    expect(mid.kind).toBe("midpoint");
    expect(mid.ref, "the arc's through-point was given a solver index").toBeUndefined();
  });

  it("names a placed point", () => {
    expect(at([{ type: "point", id: "p1", x: 3, y: 4 }], 3, 4).ref).toEqual({ id: "p1", idx: 0 });
  });

  it("names only a spline's ENDS, and maps the last one to index 1", () => {
    // endpointPoint maps idx 0 to the first fit point and ANYTHING ELSE to the
    // last, so an interior point given its own index would resolve to the end.
    const sp: ResolvedEntity = {
      type: "spline", id: "s1",
      points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }],
    };
    expect(at([sp], 0, 0).ref).toEqual({ id: "s1", idx: 0 });
    expect(at([sp], 10, 0).ref).toEqual({ id: "s1", idx: 1 });
    expect(at([sp], 5, 5).ref, "an interior fit point was given a solver index").toBeUndefined();
  });

  it("does NOT name a midpoint or a circle centre", () => {
    // Both are genuine snap targets; neither is resolvable by endpointPoint.
    // They must snap the coordinate and emit no constraint.
    expect(at([line("l1", 0, 0, 10, 0)], 5, 0).ref).toBeUndefined();
    expect(at([{ type: "circle", id: "c1", x: 2, y: 2, radius: 5 }], 2, 2).ref).toBeUndefined();
  });
});

describe("rectangle corners use the SOLVER's order", () => {
  // The trap. candidatesFromEntities used to build corners with a nested
  // sx/sy loop, which walks bl, tl, br, tr — while the solver's rectCorners is
  // bl, br, tr, tl. An index taken from the old loop would name the WRONG
  // corner, and the constraint would drag the rectangle inside out.
  const rect: ResolvedEntity = { type: "rectangle", id: "r1", x: 0, y: 0, width: 10, height: 4 };

  it("agrees with rectCorners at every index", () => {
    const corners = rectCorners(0, 0, 10, 4);
    corners.forEach((c, i) => {
      const r = at([rect], c.x, c.y);
      expect(r.ref, `no ref at corner ${i} (${c.x}, ${c.y})`).toBeDefined();
      expect(r.ref, `corner ${i} at (${c.x}, ${c.y}) got the wrong index`).toEqual({ id: "r1", idx: i });
    });
  });

  it("would have caught the old nested-loop order", () => {
    // bl is index 0 in both orders, so it proves nothing. The SECOND corner is
    // where they diverge: rectCorners says br (+hw,-hh), the old loop said
    // tl (-hw,+hh).
    const br = at([rect], 5, -2);
    expect(br.ref, "index 1 is not bottom-right — the corner order regressed").toEqual({ id: "r1", idx: 1 });
    const tl = at([rect], -5, 2);
    expect(tl.ref, "index 3 is not top-left — the corner order regressed").toEqual({ id: "r1", idx: 3 });
  });

  it("does not name the rectangle's centre", () => {
    expect(at([rect], 0, 0).ref).toBeUndefined();
  });
});

describe("a free or grid snap names nothing", () => {
  it("carries no ref when nothing was snapped onto", () => {
    const r = at([line("l1", 0, 0, 10, 0)], 100, 100);
    expect(r.kind).toBe("free");
    expect(r.ref).toBeUndefined();
  });
});

// The indices above are only correct if the SOLVER agrees with them. These run
// the real planegcs wasm: emit a coincident using exactly what a snap would
// record, perturb the geometry, and check the right two points move together.
// A wrong index still solves — it just joins the wrong corner — so asserting
// "ok" would prove nothing. Each case asserts WHICH point ended up where.
describe("the solver joins the points these refs name", () => {
  it("a line end snapped to another line's end stays joined through a solve", async () => {
    const ents: ResolvedEntity[] = [
      line("a", 0, 0, 10, 0),
      line("b", 10.03, 0.02, 20, 5), // drawn with the micro-gap the report describes
    ];
    // what a snap onto a's end (idx 1) would record for b's start (idx 0)
    const r = await compileAndSolve(ents, [{ type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 }]);
    expect(r.ok, "the solver refused a coincident written the way a snap records it").toBe(true);
    const a = r.entities.find((e) => e.id === "a") as Extract<ResolvedEntity, { type: "line" }>;
    const b = r.entities.find((e) => e.id === "b") as Extract<ResolvedEntity, { type: "line" }>;
    expect(Math.hypot(b.x1 - a.x2, b.y1 - a.y2), "the ends did not close").toBeLessThan(1e-6);
    // and it joined the ENDS, not some other pair
    expect(Math.hypot(b.x1 - 10, b.y1 - 0), "it joined the wrong end of a").toBeLessThan(0.1);
  });

  it("a rectangle CORNER index names the corner rectCorners names", async () => {
    // The trap, end to end. Index 1 must be bottom-right (+hw, -hh). If the old
    // nested-loop order leaked back in, this joins top-left instead and the
    // distance assertion below fails loudly.
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "r", x: 0, y: 0, width: 10, height: 4 },
      line("l", 9.98, -1.97, 30, 30),
    ];
    const r = await compileAndSolve(ents, [{ type: "coincident", e1: "r", p1: 1, e2: "l", p2: 0 }]);
    expect(r.ok).toBe(true);
    const l = r.entities.find((e) => e.id === "l") as Extract<ResolvedEntity, { type: "line" }>;
    const corners = rectCorners(0, 0, 10, 4);
    const br = corners[1]!;
    expect(
      Math.hypot(l.x1 - br.x, l.y1 - br.y),
      `index 1 joined (${l.x1.toFixed(2)}, ${l.y1.toFixed(2)}), not bottom-right (${br.x}, ${br.y})`,
    ).toBeLessThan(0.15);
  });

  it("closes the micro-gap the report is about, and keeps it closed", async () => {
    // Two lines meeting at a hundredth of a millimetre: the exact defect.
    const ents: ResolvedEntity[] = [line("a", 0, 0, 20, 0), line("b", 20.01, 0, 20.01, 15)];
    const cons: SketchConstraint[] = [{ type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 }];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    const a = r.entities.find((e) => e.id === "a") as Extract<ResolvedEntity, { type: "line" }>;
    const b = r.entities.find((e) => e.id === "b") as Extract<ResolvedEntity, { type: "line" }>;
    const gap = Math.hypot(b.x1 - a.x2, b.y1 - a.y2);
    expect(gap, `a ${gap.toExponential(1)} mm gap survived the solve`).toBeLessThan(1e-9);
  });
});

// WHICH entities actually get a constraint. This is the half that shipped
// broken: emitSnapCoincidences had an `arc` branch, but its only call site was
// commitFromCursor, and computeGeometry only ever returns a line, rectangle or
// circle. Arcs commit through arcClick and splines through finishSpline, so the
// arc branch was unreachable and an arc snapped onto a line kept the micro-gap.
//
// The decision was pulled out of SketchMode into snapCoincidences precisely so
// this can be asserted on the entity a gesture really produces, rather than on
// source text — constructing a real SketchMode boots the viewport and solver,
// which is why nothing saw this.
describe("which drawn entities owe a coincident", () => {
  const target = line("t", 0, 0, 10, 0);
  const arc = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
    ({ type: "arc", id, x1, y1, x2, y2, mx: (x1 + x2) / 2, my: y1 + 3 });
  const emit = (e: ResolvedEntity, s: PointRef | null, en: PointRef | null, ents: ResolvedEntity[] = []) =>
    snapCoincidences(e, s, en, [target, ...ents, e], []);

  it("an ARC drawn from a snapped point gets one", () => {
    const a = arc("a1", 10, 0, 25, 0);
    expect(emit(a, { id: "t", idx: 1 }, null)).toEqual([
      { type: "coincident", e1: "t", p1: 1, e2: "a1", p2: 0 },
    ]);
  });

  it("an arc snapped at BOTH ends gets both, start=0 and end=1", () => {
    const other = line("o", 25, 0, 40, 0);
    const a = arc("a1", 10, 0, 25, 0);
    expect(emit(a, { id: "t", idx: 1 }, { id: "o", idx: 0 }, [other])).toEqual([
      { type: "coincident", e1: "t", p1: 1, e2: "a1", p2: 0 },
      { type: "coincident", e1: "o", p1: 0, e2: "a1", p2: 1 },
    ]);
  });

  it("a LINE still gets one", () => {
    const l = line("l1", 10, 0, 20, 8);
    expect(emit(l, { id: "t", idx: 1 }, null)).toEqual([
      { type: "coincident", e1: "t", p1: 1, e2: "l1", p2: 0 },
    ]);
  });

  it("a rectangle and a circle get NOTHING, deliberately", () => {
    // their "ends" are not the points the gesture snapped, so a constraint
    // there would join something the user never aimed at
    const r: ResolvedEntity = { type: "rectangle", id: "r1", x: 5, y: 5, width: 10, height: 4 };
    const c: ResolvedEntity = { type: "circle", id: "c1", x: 10, y: 0, radius: 3 };
    expect(emit(r, { id: "t", idx: 1 }, null)).toEqual([]);
    expect(emit(c, { id: "t", idx: 1 }, null)).toEqual([]);
  });

  it("a spline gets nothing, and that is a known deferral not an oversight", () => {
    // finishSpline never reaches here. Pinned so that wiring it up later has to
    // change this expectation deliberately rather than silently.
    const sp: ResolvedEntity = { type: "spline", id: "s1", points: [{ x: 10, y: 0 }, { x: 20, y: 5 }] };
    expect(emit(sp, { id: "t", idx: 1 }, null)).toEqual([]);
  });
});

describe("the emitter refuses nonsense", () => {
  const target = line("t", 0, 0, 10, 0);

  it("will not join an entity to itself", () => {
    const l = line("l1", 10, 0, 20, 0);
    expect(snapCoincidences(l, { id: "l1", idx: 0 }, null, [target, l], [])).toEqual([]);
  });

  it("will not name an entity that no longer exists", () => {
    const l = line("l1", 10, 0, 20, 0);
    expect(snapCoincidences(l, { id: "ghost", idx: 1 }, null, [target, l], [])).toEqual([]);
  });

  it("will not duplicate a constraint already recorded, in either operand order", () => {
    const l = line("l1", 10, 0, 20, 0);
    const already: SketchConstraint[] = [{ type: "coincident", e1: "l1", p1: 0, e2: "t", p2: 1 }];
    expect(snapCoincidences(l, { id: "t", idx: 1 }, null, [target, l], already)).toEqual([]);
  });

  it("treats both ends landing on one point as two DIFFERENT joins, not a duplicate", () => {
    // they differ in p2 (0 and 1), so they are genuinely two constraints. Pinned
    // because it is the case that looks like a duplicate and is not — an
    // in-commit dedup here would silently drop the second end.
    const l = line("l1", 10, 0, 10, 0);
    const both = { id: "t", idx: 1 };
    expect(snapCoincidences(l, both, both, [target, l], [])).toEqual([
      { type: "coincident", e1: "t", p1: 1, e2: "l1", p2: 0 },
      { type: "coincident", e1: "t", p1: 1, e2: "l1", p2: 1 },
    ]);
  });
});

// End to end, through the real solver: an arc drawn onto a line's end must STAY// on it. Without the fix above the arc carried no constraint at all, so the
// micro-gap it was drawn with simply persisted.
describe("the solver keeps a snapped ARC joined", () => {
  it("closes an arc-to-line micro-gap and keeps it closed", async () => {
    const ents: ResolvedEntity[] = [
      line("a", 0, 0, 20, 0),
      // drawn a hundredth of a millimetre off the line's end, as the report describes
      { type: "arc", id: "arc", x1: 20.01, y1: 0.01, x2: 35, y2: 0, mx: 27.5, my: 6 },
    ];
    const r = await compileAndSolve(ents, [{ type: "coincident", e1: "a", p1: 1, e2: "arc", p2: 0 }]);
    expect(r.ok, "the solver refused a coincident on an arc's start").toBe(true);
    const a = r.entities.find((e) => e.id === "a") as Extract<ResolvedEntity, { type: "line" }>;
    const arc = r.entities.find((e) => e.id === "arc") as Extract<ResolvedEntity, { type: "arc" }>;
    const gap = Math.hypot(arc.x1 - a.x2, arc.y1 - a.y2);
    expect(gap, `a ${gap.toExponential(1)} mm arc-to-line gap survived the solve`).toBeLessThan(1e-6);
    // and it joined the arc's START, not its end
    expect(Math.hypot(arc.x1 - 20, arc.y1 - 0), "it joined the wrong end of the arc").toBeLessThan(0.2);
  });
});

// THE WIRING, which is what actually broke. snapCoincidences having an arc case
// proves nothing on its own: the old emitter had one too, and it was dead,
// because arcs commit through arcClick and only commitFromCursor called the
// emitter. The tests above would ALL have passed while a drawn arc got nothing.
//
// Source text, not an import: constructing a real SketchMode boots the viewport,
// overlay and solver (same reason and same limitation as trimRawCursor.test.ts).
// So this pins the EXPRESSION at each commit path.
describe("every commit path that can owe a coincident calls the emitter", () => {
  const commits = [
    // [what commits it, the source marker for its body, the refs it must pass]
    ["arcClick", "private arcClick(", "this.emitSnapCoincidences(ent, this.arcStartRef, this.arcEndRef)"],
    ["commitFromCursor", "private commitFromCursor(", "this.emitSnapCoincidences(entity, this.baseRef, this.lastSnapRef)"],
  ] as const;

  for (const [name, marker, call] of commits) {
    it(`${name} emits, with the refs its own gesture captured`, () => {
      const at = sketchSrc.indexOf(marker);
      expect(at, `${name} is gone — this test is pinning nothing`).toBeGreaterThan(-1);
      const body = sketchSrc.slice(at, at + 1600);
      expect(body, `${name} pushes an entity but never emits its coincidences`).toContain(call);
    });
  }

  it("arcClick captures a ref at BOTH of its first two clicks", () => {
    // pointer MOVES overwrite lastSnapRef between clicks, so reading it at
    // commit time would give the third click's ref for both ends
    const at = sketchSrc.indexOf("private arcClick(");
    const body = sketchSrc.slice(at, at + 1600);
    expect(body).toContain("this.arcStartRef = this.lastSnapRef");
    expect(body).toContain("this.arcEndRef = this.lastSnapRef");
  });

  it("the emitter takes its refs as arguments, not off `this`", () => {
    // the arc path cannot use baseRef/lastSnapRef, so a signature that reads
    // them internally is what made a second call site impossible to add safely
    expect(sketchSrc).toContain("private emitSnapCoincidences(\n    entity: ResolvedEntity,\n    startRef: PointRef | null,\n    endRef: PointRef | null,\n  )");
  });
});
