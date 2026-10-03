// Snap-to-coincident, entered where the USER enters: the canvas pointer
// handlers and the dim box's Enter, on the real SketchMode methods.
//
// snapCoincident.test.ts pins the pure decision and the index convention. What
// it cannot see is the state the gesture hands that decision, and that is where
// the four defects found in review lived:
//
//   1. a TYPED length puts the end away from the cursor, but the cursor's last
//      snap still named the hovered point, so the line was constrained onto a
//      point it never reached (a typed 10 mm line solved to 20 mm);
//   2. a snapped join compiles to ONE merged solver point, and a coincident
//      between that point and itself is what planegcs calls redundant, so every
//      snapped join drew amber;
//   3. a chain continuation's start was treated as free, so auto-V could move it
//      off the previous segment's end and open a gap at the joint;
//   4. circle centres and projected endpoints snapped but emitted nothing,
//      although the solver addresses both.
//
// And the two that review found once those joins existed:
//
//   5. Fillet and Chamfer move both corner ends off the corner and keep both
//      line ids, so the join a snap left there named a point that was gone. The
//      next solve dragged the lines back onto it and wrecked the profile, and a
//      line that STARTED at the corner was rebuilt reversed, which handed the
//      join at its far end the wrong point;
//   6. a join compiled to nothing (case 2) no longer told the rectangle guard
//      that the rectangle was tied to something, so a corner drag could mirror
//      it out from under the join.
//
// Stubbed: the viewport and plane (identity, at 100 px per mm, so the 10 px snap
// tolerance is 0.1 mm), the overlay, and the dim box's DOM. Real: snapAt, snap,
// candidatesFromEntities, the pointer handlers, commitFromCursor, arcClick, the
// emitter, auto-H/V, and the planegcs solve every join is checked through.
//
// The solver checks follow the rule a drag taught the hard way: a drag moves
// coincident points together whether or not a constraint exists, so it is a
// FALSE oracle. Each join is checked by DISPLACING one side in the model and
// solving, with a control solve without the constraints that must leave the
// gap open, so the assertion cannot pass on geometry alone.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
import * as THREE from "three";
import { SketchMode } from "./sketchMode";
import { circumcenter } from "./arc";
import { t } from "../i18n";
import { compileAndSolve } from "./sketchSolve";
import { candidatesFromEntities, type ResolvedEntity } from "./snap";
import { rectCorners } from "./region";
import { originGeometry } from "./origin";
import type { SketchConstraint } from "../types";

const PX = 100; // screen px per sketch mm

type Line = Extract<ResolvedEntity, { type: "line" }>;
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line =>
  ({ type: "line", id, x1, y1, x2, y2 });

const press = (x: number, y: number) => ({
  button: 0, shiftKey: false, ctrlKey: false, metaKey: false,
  clientX: x * PX, clientY: y * PX, pointerId: 1,
  preventDefault: () => {}, stopPropagation: () => {},
}) as unknown as PointerEvent;

interface Handlers {
  onPointerDown(e: PointerEvent): void;
  onPointerMove(e: PointerEvent): void;
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  tool: string;
  base: THREE.Vector2 | null;
}

/** A SketchMode with the given entities on the sketch and `tool` armed.
 *  `typed` is what the user has typed into the dim box, by field name. */
function drawing(
  tool: "line" | "arc" | "select" | "rectangle" | "centerRectangle" | "arcCenter",
  entities: ResolvedEntity[],
  typed: Record<string, number> = {},
) {
  const s = Object.create(SketchMode.prototype) as Record<string, unknown>;
  let commitDimBox: (() => void) | null = null;
  /** what the viewport would run at the start of its next frame
   *  (Viewport.beforeNextDraw): a drag's later moves wait on it */
  const frames: (() => void)[] = [];
  Object.assign(s, {
    tool, active: true,
    entities: [...entities], constraints: [],
    candidates: candidatesFromEntities(entities),
    base: null, chainStart: null, basePinned: false, baseRef: null,
    lastSnapKind: "free", lastSnapRef: null, lastCursor: new THREE.Vector2(),
    arcStart: null, arcEnd: null, arcStartRef: null, arcEndRef: null, arcCenterRef: null, clickPts: [], arcSweep: 0,
    constructionMode: false, gridSnap: false, glyphsVisible: false, pendingGlyph: null,
    dim: {
      isActive: false,
      isUserDriven: (n: string) => n in typed,
      getValue: (n: string) => typed[n] ?? null,
      show: (_defs: unknown, commit: () => void) => { commitDimBox = commit; },
      hide: () => {},
      updateFromCursor: () => {},
      position: () => {},
    },
    dims: { clearSelection: () => {} },
    viewport: {
      screenToPlane: (x: number, y: number) => new THREE.Vector3(x / PX, y / PX, 0),
      projectToScreen: (w: THREE.Vector3) => ({ x: w.x * PX, y: w.y * PX }),
      pixelWorldSize: () => 1 / PX,
      beforeNextDraw: (fn: () => void) => { frames.push(fn); },
    },
    plane: {
      plane: null,
      origin: new THREE.Vector3(),
      to2D: (w: THREE.Vector3) => new THREE.Vector2(w.x, w.y),
      to3D: (x: number, y: number) => new THREE.Vector3(x, y, 0),
    },
    overlay: { setPreview: () => {} },
    patterns: [], filletFirst: null, selected: new Set<string>(),
    refreshDragGeometry: () => {},
    showSnap: () => {},
    arcPreview: () => {},
    entityCurve: () => ({}),
    // the real refreshActive rebuilds the snap candidates from the entity list;
    // that is the one part of it a second click depends on
    refreshActive: () => { s.candidates = candidatesFromEntities(s.entities as ResolvedEntity[]); },
    requestSolve: () => {},
    onState: () => {},
  });
  const h = s as unknown as Handlers;
  return {
    h,
    click: (x: number, y: number) => h.onPointerDown(press(x, y)),
    /** a move in a frame of its own: the previous frame runs first */
    hover: (x: number, y: number) => {
      for (const fn of frames.splice(0)) fn();
      h.onPointerMove(press(x, y));
    },
    /** Enter in the dim box: what the user does after typing a value */
    enter: () => commitDimBox?.(),
    drawn: () => h.entities.filter((e) => !entities.includes(e)),
  };
}

const coincidents = (cs: SketchConstraint[]) => cs.filter((c) => c.type === "coincident");
const byId = <T extends ResolvedEntity>(es: ResolvedEntity[], id: string) => es.find((e) => e.id === id) as T;
const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const start = (l: Line) => ({ x: l.x1, y: l.y1 });
const end = (l: Line) => ({ x: l.x2, y: l.y2 });

/** Solve `entities` with `patch` applied to one of them, with and without the
 *  constraints the gesture recorded. */
async function displaced(
  entities: ResolvedEntity[], constraints: SketchConstraint[], id: string, patch: Partial<Line> | Record<string, number>,
) {
  const moved = entities.map((e) => (e.id === id ? { ...e, ...patch } as ResolvedEntity : e));
  const quiet = console.log; // planegcs narrates every solve
  console.log = () => {};
  try {
    return { fixed: await compileAndSolve(moved, constraints), control: await compileAndSolve(moved, []) };
  } finally {
    console.log = quiet;
  }
}

/** Hand the mode its REAL solve loop: `requestSolve` and `pump`, the one place
 *  sketchMode withdraws a trial (with a toast) and writes the solver's geometry
 *  back. The harness above stubs them, because most tests here solve by hand.
 *  Returns a wait for every solve the gestures after it started. */
function solving(h: Handlers) {
  const s = h as unknown as Record<string, unknown>;
  const proto = SketchMode.prototype as unknown as { pump(): Promise<void>; requestSolve(): void };
  const started: Promise<void>[] = [];
  toasts.length = 0;
  Object.assign(s, {
    solveBusy: false, solverDead: false, solveDirty: false, pendingDrag: null, pendingPinIdxs: null,
    pendingBias: null, entityVersion: 0, conflict: false, conflictIdx: [], overIdx: [], lastDof: -1,
    trial: null, dragFrom: null, moveDrag: null,
    history: { bankIfChanged: () => false, arm: () => {} },
    requestSolve: proto.requestSolve,
    pump(this: unknown) {
      const run = proto.pump.call(this);
      started.push(run);
      return run;
    },
  });
  return async () => {
    const quiet = console.log; // planegcs narrates every solve
    console.log = () => {};
    try {
      while (started.length) await started.shift();
    } finally {
      console.log = quiet;
    }
  };
}

describe("a line drawn between two snapped endpoints is CONSTRAINED to both", () => {
  it("records one coincident per snapped end, and the solver holds both joins", async () => {
    const d = drawing("line", [line("a", 0, 0, 10, 0), line("b", 20, 5, 30, 5)]);
    d.click(10, 0); // a's end
    d.click(20, 5); // b's start
    const [n] = d.drawn() as Line[];
    expect(n, "the second click committed nothing").toBeDefined();
    expect(coincidents(d.h.constraints)).toEqual([
      { type: "coincident", e1: "a", p1: 1, e2: n!.id, p2: 0 },
      { type: "coincident", e1: "b", p1: 0, e2: n!.id, p2: 1 },
    ]);

    // pull the new line half a millimetre off both joins, then solve
    const r = await displaced(d.h.entities, d.h.constraints, n!.id, { x1: 10.5, y1: 0.5, x2: 19.5, y2: 4.5 });
    const fixedN = byId<Line>(r.fixed.entities, n!.id), controlN = byId<Line>(r.control.entities, n!.id);
    expect(gap(start(fixedN), end(byId<Line>(r.fixed.entities, "a")))).toBeLessThan(1e-6);
    expect(gap(end(fixedN), start(byId<Line>(r.fixed.entities, "b")))).toBeLessThan(1e-6);
    expect(gap(start(controlN), { x: 10, y: 0 }), "the control closed the gap too: this oracle measures nothing")
      .toBeGreaterThan(0.5);
  });
});

describe("a TYPED length is not constrained onto the point the cursor hovers", () => {
  // The cursor rests on a's start, 20 mm away, while the user types 10. The line
  // ends at 10 mm. The hovered point's ref is still the last snap, and emitting
  // it would make the solver pull the line's end 10 mm onto a.
  const a = line("a", 20, 0, 20, 10);

  it("records no coincident to the hovered point, and the typed length survives a solve", async () => {
    const d = drawing("line", [a], { length: 10 });
    d.click(0, 0);
    d.hover(20, 0);
    d.enter();
    const [n] = d.drawn() as Line[];
    expect(n, "Enter in the dim box committed nothing").toBeDefined();
    expect(end(n!)).toEqual({ x: 10, y: 0 });
    expect(coincidents(d.h.constraints), "a coincident joined the line to a point it never reached").toEqual([]);

    const r = await compileAndSolve(d.h.entities, d.h.constraints);
    const s = byId<Line>(r.entities, n!.id);
    expect(Math.hypot(s.x2 - s.x1, s.y2 - s.y1), "the solve stretched the typed length").toBeCloseTo(10, 9);
  });

  it("still records it when the typed length DOES land on the hovered point", () => {
    // the control: the same gesture with 20 typed ends exactly on a's start, so
    // the refusal above is about where the end landed and not about typing
    const d = drawing("line", [a], { length: 20 });
    d.click(0, 0);
    d.hover(20, 0);
    d.enter();
    const [n] = d.drawn() as Line[];
    expect(coincidents(d.h.constraints)).toEqual([{ type: "coincident", e1: "a", p1: 0, e2: n!.id, p2: 1 }]);
  });
});

describe("a snapped join does not read as over-defined", () => {
  it("a line and an ARC drawn onto existing ends solve clean, with no amber", async () => {
    const d = drawing("line", [line("a", 0, 0, 10, 0)]);
    d.click(10, 0); // a's end
    d.click(10, 8); // free; auto-V keeps it vertical
    d.h.base = null; // finish the chain, as Escape would
    d.h.tool = "arc";
    d.click(10, 8); // the line's end
    d.click(0, 8);
    d.click(5, 13); // through-point
    const [l, arc] = d.drawn();
    expect(arc?.type, "the third click committed no arc").toBe("arc");
    expect(coincidents(d.h.constraints)).toEqual([
      { type: "coincident", e1: "a", p1: 1, e2: l!.id, p2: 0 },
      { type: "coincident", e1: l!.id, p1: 1, e2: arc!.id, p2: 0 },
    ]);

    const quiet = console.log;
    console.log = () => {};
    const r = await compileAndSolve(d.h.entities, d.h.constraints).finally(() => { console.log = quiet; });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.overDefined, "every snapped join is drawn amber").toEqual([]);
  });
});

describe("a chained segment never tears the joint it starts from", () => {
  it("auto-V does not move the start of a continuation whose end was snapped", () => {
    // Segment 1 ends FREE at (10,0). Segment 2 runs from there to l's start,
    // 1.5 degrees off vertical. Its end is pinned by the snap; moving its start
    // to make it vertical would leave segment 1's end behind, 0.26 mm away.
    const d = drawing("line", [line("l", 10.26, 10, 30, 10)]);
    d.click(0, 0);
    d.click(10, 0);
    d.click(10.26, 10);
    const [s1, s2] = d.drawn() as Line[];
    expect(s2, "the third click committed no second segment").toBeDefined();
    expect(gap(start(s2!), end(s1!)), "the joint between the two segments opened").toBeLessThan(1e-9);
    expect(end(s2!), "the snapped end moved").toEqual({ x: 10.26, y: 10 });
  });
});

describe("centres and projected endpoints are joined, not just copied", () => {
  it("a line started on a circle's centre follows the circle", async () => {
    const d = drawing("line", [{ type: "circle", id: "c", x: 5, y: 5, radius: 3 }]);
    d.click(5, 5);
    d.click(20, 17);
    const [n] = d.drawn() as Line[];
    expect(coincidents(d.h.constraints)).toEqual([{ type: "coincident", e1: "c", p1: 0, e2: n!.id, p2: 0 }]);

    const r = await displaced(d.h.entities, d.h.constraints, "c", { x: 6, y: 5.5 });
    const centre = (es: ResolvedEntity[]) => byId<Extract<ResolvedEntity, { type: "circle" }>>(es, "c");
    expect(gap(start(byId<Line>(r.fixed.entities, n!.id)), centre(r.fixed.entities))).toBeLessThan(1e-6);
    expect(gap(start(byId<Line>(r.control.entities, n!.id)), centre(r.control.entities))).toBeGreaterThan(1);
  });

  it("a line started on a projected endpoint is held there", async () => {
    const proj: ResolvedEntity = {
      type: "projected", id: "p", source: { kind: "silhouette", body: "b" },
      curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
    };
    const d = drawing("line", [proj]);
    d.click(10, 0);
    d.click(20, 7);
    const [n] = d.drawn() as Line[];
    expect(coincidents(d.h.constraints)).toEqual([{ type: "coincident", e1: "p", p1: 1, e2: n!.id, p2: 0 }]);

    const r = await displaced(d.h.entities, d.h.constraints, n!.id, { x1: 10.5, y1: 0.5 });
    expect(gap(start(byId<Line>(r.fixed.entities, n!.id)), { x: 10, y: 0 })).toBeLessThan(1e-6);
    expect(gap(start(byId<Line>(r.control.entities, n!.id)), { x: 10, y: 0 })).toBeGreaterThan(0.5);
  });
});

// --- 5. a corner op takes the corner, and the join on it, away -------------

type Arc = Extract<ResolvedEntity, { type: "arc" }>;
const arcsOf = (es: ResolvedEntity[]) => es.filter((e): e is Arc => e.type === "arc");
const radiusOf = (a: Arc) => {
  const c = circumcenter({ x: a.x1, y: a.y1 }, { x: a.mx, y: a.my }, { x: a.x2, y: a.y2 });
  return c ? Math.hypot(a.x1 - c.x, a.y1 - c.y) : NaN; // NaN: the arc collapsed to a point
};
/** a line's two ends, whichever way round it is stored */
const endsOf = (l: Line) => [start(l), end(l)];
const hasEnd = (l: Line, p: { x: number; y: number }) => endsOf(l).some((q) => gap(q, p) < 1e-6);

/** A 30 x 20 rectangle drawn with the LINE tool as one chain, closed by clicking
 *  its start again. That closing click snaps onto the chain's start, so the
 *  closing corner carries a coincident: every closed line profile has one. */
function closedSquare(typed: Record<string, number>) {
  const d = drawing("line", [], typed);
  d.click(0, 0); d.click(30, 0); d.click(30, 20); d.click(0, 20); d.click(0, 0);
  const [bottom, right, top, left] = d.drawn() as Line[];
  return { d, bottom: bottom!, right: right!, top: top!, left: left! };
}

describe("Fillet and Chamfer on a corner a snap joined", () => {
  it("the line tool's closing corner is joined, so the cases below are the everyday ones", () => {
    const { d, bottom, left } = closedSquare({});
    expect(coincidents(d.h.constraints)).toEqual([
      { type: "coincident", e1: bottom.id, p1: 0, e2: left.id, p2: 1 },
    ]);
  });

  it("filleting the closing corner rounds it and leaves the rest of the profile alone", async () => {
    const { d, bottom, right, top, left } = closedSquare({ radius: 3 });
    const settle = solving(d.h);
    d.h.tool = "fillet";
    d.click(0, 7); // the closing line
    d.click(12, 0); // the first line
    d.enter(); // radius 3, typed
    await settle();

    expect(toasts, "the fillet's radius and tangencies were withdrawn as a conflict").toEqual([]);
    expect(d.h.constraints.filter((c) => c.type === "tangent2" || c.type === "radius")).toHaveLength(3);
    const es = d.h.entities;
    const [arc] = arcsOf(es);
    expect(arc, "no fillet arc").toBeDefined();
    expect(radiusOf(arc!)).toBeCloseTo(3, 6);
    expect(hasEnd(byId<Line>(es, bottom.id), { x: 3, y: 0 }), "the bottom was not cut back to the arc").toBe(true);
    expect(hasEnd(byId<Line>(es, left.id), { x: 0, y: 3 }), "the left side was not cut back to the arc").toBe(true);
    // the three corners the fillet did not touch are where they were drawn
    expect(byId<Line>(es, right.id)).toMatchObject({ x1: 30, y1: 0, x2: 30, y2: 20 });
    expect(byId<Line>(es, top.id)).toMatchObject({ x1: 30, y1: 20, x2: 0, y2: 20 });
    expect(hasEnd(byId<Line>(es, bottom.id), { x: 30, y: 0 })).toBe(true);
    expect(hasEnd(byId<Line>(es, left.id), { x: 0, y: 20 })).toBe(true);

    const quiet = console.log;
    console.log = () => {};
    const again = await compileAndSolve(es, d.h.constraints).finally(() => { console.log = quiet; });
    expect(again.ok, "the sketch no longer solves after the fillet").toBe(true);
  });

  it("filleting the corner NEXT to the closing one keeps the closing join on the right point", async () => {
    // The left side starts at the top-left corner and ends on the closing
    // corner. Filleting the top-left corner used to rebuild it reversed, so its
    // index 1, the end the closing join names, became the end at the fillet.
    const { d, bottom, left } = closedSquare({ radius: 3 });
    const settle = solving(d.h);
    d.h.tool = "fillet";
    d.click(12, 20); // the top
    d.click(0, 7); // the left side
    d.enter();
    await settle();

    expect(toasts).toEqual([]);
    const es = d.h.entities;
    expect(arcsOf(es)).toHaveLength(1);
    expect(radiusOf(arcsOf(es)[0]!)).toBeCloseTo(3, 6);
    expect(end(byId<Line>(es, left.id)), "the closing join moved").toEqual({ x: 0, y: 0 });
    expect(start(byId<Line>(es, bottom.id))).toEqual({ x: 0, y: 0 });

    // and that join still HOLDS: pull the closing corner apart and solve
    const r = await displaced(es, d.h.constraints, left.id, { x2: 0.5, y2: -0.5 });
    expect(r.fixed.ok).toBe(true);
    expect(gap(end(byId<Line>(r.fixed.entities, left.id)), start(byId<Line>(r.fixed.entities, bottom.id)))).toBeLessThan(1e-6);
    expect(gap(end(byId<Line>(r.control.entities, left.id)), start(byId<Line>(r.control.entities, bottom.id))))
      .toBeGreaterThan(0.5);
  });

  it("chamfering the closing corner bevels it instead of folding the closing line across the profile", async () => {
    const { d, bottom, left } = closedSquare({ distance: 3 });
    const settle = solving(d.h);
    d.h.tool = "chamfer";
    d.click(0, 7);
    d.click(12, 0);
    d.enter(); // distance 3, typed
    await settle();

    expect(toasts).toEqual([]);
    const es = d.h.entities;
    const L = byId<Line>(es, left.id), B = byId<Line>(es, bottom.id);
    expect(hasEnd(L, { x: 0, y: 20 }) && hasEnd(L, { x: 0, y: 3 }), `left side is ${JSON.stringify(endsOf(L))}`).toBe(true);
    expect(hasEnd(B, { x: 30, y: 0 }) && hasEnd(B, { x: 3, y: 0 }), `bottom is ${JSON.stringify(endsOf(B))}`).toBe(true);

    // the geometry alone can look right while the sketch is stuck: a join left
    // across the bevel asks the solver to shrink it to nothing, which the
    // collapse guard refuses on every solve from then on
    const quiet = console.log;
    console.log = () => {};
    const again = await compileAndSolve(es, d.h.constraints).finally(() => { console.log = quiet; });
    expect(again.ok, "the sketch no longer solves after the chamfer").toBe(true);
  });

  it("filleting two separately drawn lines joined by a snap", async () => {
    const d = drawing("line", [line("e", 0, 0, 30, 0)], { radius: 5 });
    d.click(30, 0); // e's end
    d.click(35, 25);
    const [f] = d.drawn() as Line[];
    expect(coincidents(d.h.constraints)).toHaveLength(1);
    const settle = solving(d.h);
    d.h.base = null; // Escape ends the chain
    d.h.tool = "fillet";
    d.click(12, 0);
    d.click(33, 15);
    d.enter();
    await settle();

    expect(toasts).toEqual([]);
    const es = d.h.entities;
    expect(arcsOf(es)).toHaveLength(1);
    expect(radiusOf(arcsOf(es)[0]!)).toBeCloseTo(5, 6);
    expect(start(byId<Line>(es, "e")), "e's far end moved").toEqual({ x: 0, y: 0 });
    expect(hasEnd(byId<Line>(es, f!.id), { x: 35, y: 25 }), "f's far end moved").toBe(true);
    expect(coincidents(d.h.constraints), "the join at the corner outlived the corner").toEqual([]);
  });

  it("a Coincident placed by hand on the corner is taken away with it too", async () => {
    // Not a snap: the same constraint, recorded by the Coincident tool, which
    // filleted into the same wreck before snaps emitted any.
    const d = drawing("select", [line("a", 0, 0, 30, 0), line("b", 30, 0, 30, 20)], { radius: 3 });
    d.h.constraints.push({ type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 });
    const settle = solving(d.h);
    d.h.tool = "fillet";
    d.click(12, 0);
    d.click(30, 12);
    d.enter();
    await settle();

    expect(toasts).toEqual([]);
    const es = d.h.entities;
    expect(start(byId<Line>(es, "a"))).toEqual({ x: 0, y: 0 });
    expect(end(byId<Line>(es, "b"))).toEqual({ x: 30, y: 20 });
    expect(radiusOf(arcsOf(es)[0]!)).toBeCloseTo(3, 6);
  });
});

// --- 6. the rectangle guard still sees a join that compiled to nothing -----

describe("a rectangle with a line snapped onto its corner", () => {
  it("still refuses a corner drag that would mirror it, and the sketch keeps solving", async () => {
    const R: ResolvedEntity = { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 };
    const d = drawing("line", [R]);
    d.click(20, 10); // R's corner 2
    d.click(40, 30.5);
    const [n] = d.drawn() as Line[];
    expect(coincidents(d.h.constraints)).toEqual([{ type: "coincident", e1: "R", p1: 2, e2: n!.id, p2: 0 }]);

    const settle = solving(d.h);
    d.h.base = null;
    d.h.tool = "select";
    d.click(-20, -10); // grab corner 0...
    d.hover(25, 15); // ...and drag it past the opposite corner
    await settle();

    expect(toasts).toEqual([t("sketch.guard.dragFlattens")]);
    expect(byId(d.h.entities, "R")).toEqual(R);
    const quiet = console.log;
    console.log = () => {};
    const after = await compileAndSolve(d.h.entities, d.h.constraints).finally(() => { console.log = quiet; });
    expect(after.ok, "the mirrored corner left the join naming the wrong corner").toBe(true);
  });
});

// --- 7. a rectangle's snapped corner -------------------------------------
//
// Integration check 2a: a rectangle started on the origin snap carried no
// constraint, so a body drag of one edge tore its corner off the origin. The
// first click of a corner-to-corner rectangle IS a corner, the one the user
// aimed at. WHICH corner depends on the way the drag went, so these draw away
// from corner 0 on purpose: the two corner orders in the codebase agree there
// and nowhere else, so a test on corner 0 would pass with the wrong index.

type Rect = Extract<ResolvedEntity, { type: "rectangle" }>;
const cornerOf = (r: Rect, k: number) => rectCorners(r.x, r.y, r.width, r.height)[k]!;

describe("a rectangle is joined at the corners its clicks snapped onto", () => {
  it("started on the origin and drawn down-left: the TOP-RIGHT corner (2) is held on the origin", async () => {
    const d = drawing("rectangle", originGeometry());
    d.click(0, 0); // the origin
    d.click(-40, -25);
    const [r] = d.drawn() as Rect[];
    expect(r?.type, "the second click committed no rectangle").toBe("rectangle");
    expect(coincidents(d.h.constraints)).toEqual([{ type: "coincident", e1: "__origin__", p1: 0, e2: r!.id, p2: 2 }]);

    // as drawn, the join solves clean: no conflict, and no amber
    const quiet = console.log;
    console.log = () => {};
    const asDrawn = await compileAndSolve(d.h.entities, d.h.constraints).finally(() => { console.log = quiet; });
    expect(asDrawn.ok).toBe(true);
    expect(asDrawn.conflicts).toEqual([]);
    expect(asDrawn.overDefined, "the snapped corner is drawn amber").toEqual([]);

    // move the rectangle off the origin in the model, then solve
    const res = await displaced(d.h.entities, d.h.constraints, r!.id, { x: r!.x + 12, y: r!.y + 8 });
    expect(res.fixed.ok).toBe(true);
    expect(gap(cornerOf(byId<Rect>(res.fixed.entities, r!.id), 2), { x: 0, y: 0 })).toBeLessThan(1e-6);
    expect(gap(cornerOf(byId<Rect>(res.control.entities, r!.id), 2), { x: 0, y: 0 }),
      "the control closed the gap too: this oracle measures nothing").toBeGreaterThan(10);
  });

  it("snapped at both clicks: each click's own corner, and both joins hold", async () => {
    const d = drawing("rectangle", [line("a", 30, -10, 30, 0), line("b", 0, 20, -10, 30)]);
    d.click(30, 0); // a's end: the bottom-right corner (1) of what is drawn
    d.click(0, 20); // b's start: the top-left corner (3)
    const [r] = d.drawn() as Rect[];
    expect(coincidents(d.h.constraints)).toEqual([
      { type: "coincident", e1: "a", p1: 1, e2: r!.id, p2: 1 },
      { type: "coincident", e1: "b", p1: 0, e2: r!.id, p2: 3 },
    ]);

    const res = await displaced(d.h.entities, d.h.constraints, r!.id, { x: r!.x + 3, y: r!.y - 2 });
    const fixedR = byId<Rect>(res.fixed.entities, r!.id), controlR = byId<Rect>(res.control.entities, r!.id);
    expect(gap(cornerOf(fixedR, 1), end(byId<Line>(res.fixed.entities, "a")))).toBeLessThan(1e-6);
    expect(gap(cornerOf(fixedR, 3), start(byId<Line>(res.fixed.entities, "b")))).toBeLessThan(1e-6);
    expect(gap(cornerOf(controlR, 1), end(byId<Line>(res.control.entities, "a")))).toBeGreaterThan(1);
  });

  it("a TYPED size that moves the far corner off the hovered point joins only the first", () => {
    const d = drawing("rectangle", [...originGeometry(), line("b", 40, 25, 50, 25)], { width: 30, height: 20 });
    d.click(0, 0); // the origin: the bottom-left corner (0)
    d.hover(40, 25); // resting on b's start, 10 mm past the typed corner
    d.enter();
    const [r] = d.drawn() as Rect[];
    expect(r, "Enter in the dim box committed nothing").toBeDefined();
    expect(cornerOf(r!, 2)).toEqual(new THREE.Vector2(30, 20));
    expect(coincidents(d.h.constraints), "a corner was joined to a point it never reached")
      .toEqual([{ type: "coincident", e1: "__origin__", p1: 0, e2: r!.id, p2: 0 }]);
  });

  it("a CENTRE rectangle joins the corner its second click snapped onto", async () => {
    const d = drawing("centerRectangle", [line("a", 20, 10, 40, 10)]);
    d.click(10, 5); // the centre, on nothing
    d.click(20, 10); // a's start: the top-right corner (2)
    const [r] = d.drawn() as Rect[];
    expect(r?.type, "the corner click committed no rectangle").toBe("rectangle");
    expect(coincidents(d.h.constraints)).toEqual([{ type: "coincident", e1: "a", p1: 0, e2: r!.id, p2: 2 }]);

    const res = await displaced(d.h.entities, d.h.constraints, r!.id, { x: r!.x - 4, y: r!.y + 3 });
    expect(gap(cornerOf(byId<Rect>(res.fixed.entities, r!.id), 2), start(byId<Line>(res.fixed.entities, "a"))))
      .toBeLessThan(1e-6);
    expect(gap(cornerOf(byId<Rect>(res.control.entities, r!.id), 2), start(byId<Line>(res.control.entities, "a"))))
      .toBeGreaterThan(1);
  });
});

// --- 8. the centre-point arc ----------------------------------------------
//
// Integration check 2b: a centre arc whose centre click snapped onto the origin
// and whose start click snapped onto a line's end was created with no
// constraint at all, so the next solve could leave it 5.8 mm off the line. Its
// clicks place the centre (solver point 2), the start (0) and, when the end
// lands on the point it snapped to, the end (1).

describe("a centre-point arc is joined to what its clicks snapped onto", () => {
  // a pie: two radii from the origin, then the arc between their ends
  const pie = () => [...originGeometry(), line("a", 0, 0, 25, 0), line("b", 0, 0, 0, 25)];

  it("joins the centre to the origin, the start to one radius and the end to the other", async () => {
    const d = drawing("arcCenter", pie());
    d.click(0, 0); // centre, on the origin
    d.click(25, 0); // start, on a's end
    d.click(0, 25); // end, on b's end: a quarter turn lands it exactly there
    const [arc] = d.drawn() as Arc[];
    expect(arc?.type, "the third click committed no arc").toBe("arc");
    expect(coincidents(d.h.constraints)).toEqual([
      { type: "coincident", e1: "a", p1: 1, e2: arc!.id, p2: 0 },
      { type: "coincident", e1: "b", p1: 1, e2: arc!.id, p2: 1 },
      { type: "coincident", e1: "__origin__", p1: 0, e2: arc!.id, p2: 2 },
    ]);

    const quiet = console.log;
    console.log = () => {};
    const asDrawn = await compileAndSolve(d.h.entities, d.h.constraints).finally(() => { console.log = quiet; });
    expect(asDrawn.ok).toBe(true);
    expect(asDrawn.overDefined, "a snapped join is drawn amber").toEqual([]);

    // pull the arc off all three, then solve
    const shift = { x1: arc!.x1 + 3, y1: arc!.y1 + 2, x2: arc!.x2 + 3, y2: arc!.y2 + 2, mx: arc!.mx + 3, my: arc!.my + 2 };
    const r = await displaced(d.h.entities, d.h.constraints, arc!.id, shift);
    const centre = (es: ResolvedEntity[]) => {
      const q = byId<Arc>(es, arc!.id);
      return circumcenter({ x: q.x1, y: q.y1 }, { x: q.mx, y: q.my }, { x: q.x2, y: q.y2 })!;
    };
    const fixedArc = byId<Arc>(r.fixed.entities, arc!.id);
    expect(gap(centre(r.fixed.entities), { x: 0, y: 0 }), "the centre left the origin").toBeLessThan(1e-6);
    expect(gap({ x: fixedArc.x1, y: fixedArc.y1 }, end(byId<Line>(r.fixed.entities, "a")))).toBeLessThan(1e-6);
    expect(gap({ x: fixedArc.x2, y: fixedArc.y2 }, end(byId<Line>(r.fixed.entities, "b")))).toBeLessThan(1e-6);
    expect(gap(centre(r.control.entities), { x: 0, y: 0 }), "the control closed the gap too: this oracle measures nothing")
      .toBeGreaterThan(3);
  });

  it("does not join the end to a point it only pointed at", () => {
    // b now ends 5 mm past the radius: the end click picks the angle, and the
    // arc ends ON the radius, not on b's end
    const d = drawing("arcCenter", [...originGeometry(), line("a", 0, 0, 25, 0), line("b", 0, 0, 0, 30)]);
    d.click(0, 0);
    d.click(25, 0);
    d.click(0, 30);
    const [arc] = d.drawn() as Arc[];
    expect(arc).toBeDefined();
    expect(coincidents(d.h.constraints).filter((c) => c.type === "coincident" && c.e1 === "b"),
      "the end was joined to a point it never reached").toEqual([]);
    expect(coincidents(d.h.constraints)).toHaveLength(2);
  });
});

describe("a fillet and a point that was put ON a curve", () => {
  it("drops the point-on that held the corner end, which would bend the fillet", async () => {
    // a's end (30,0) is the corner, and it was put on g, the vertical line
    // x = 30 below the corner. The fillet moves that end to (27,0), off g.
    const d = drawing("select", [line("a", 0, 0, 30, 0), line("b", 30, 0, 30, 20), line("g", 30, -5, 30, -25)], { radius: 3 });
    d.h.constraints.push({ type: "pointOn", e: "a", p: 1, curve: "g" });
    const settle = solving(d.h);
    d.h.tool = "fillet";
    d.click(12, 0);
    d.click(30, 12);
    d.enter();
    await settle();

    expect(toasts).toEqual([]);
    expect(d.h.constraints.filter((c) => c.type === "pointOn"), "the corner's point-on outlived the corner").toEqual([]);
    const es = d.h.entities;
    expect(start(byId<Line>(es, "a"))).toEqual({ x: 0, y: 0 });
    expect(radiusOf(arcsOf(es)[0]!)).toBeCloseTo(3, 6);
  });

  it("keeps one that puts a point on a filleted LINE: its carrier did not move", async () => {
    const d = drawing("select", [line("a", 0, 0, 30, 0), line("b", 30, 0, 30, 20), line("q", 10, 0, 14, 12)], { radius: 3 });
    const keep: SketchConstraint = { type: "pointOn", e: "q", p: 0, curve: "a" };
    d.h.constraints.push(keep);
    const settle = solving(d.h);
    d.h.tool = "fillet";
    d.click(20, 0);
    d.click(30, 12);
    d.enter();
    await settle();

    expect(toasts).toEqual([]);
    expect(d.h.constraints).toContainEqual(keep);
    expect(byId<Line>(d.h.entities, "q").y1, "q's start sits on a's line").toBeCloseTo(0, 9);
  });
});
