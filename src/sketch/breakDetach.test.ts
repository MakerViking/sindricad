// After Break, the two halves can be pulled apart.
//
// Report 3b97b35d: "After Break the halves stay joined and there is no
// coincident glyph to delete". breakAt writes two curves that share the cut
// point and adds no constraint, and the solver merges endpoints at one spot by
// POSITION (coincKey buckets), so the halves become one solver point that
// nothing draws and every drag preserves by design. Measured on main: dragging
// the shared point moved both ends, and body-dragging one half carried the
// other's end with it. There was no way to separate them from the canvas.
//
// The way out is a gesture, not a document change: Shift-drag a shared end (or
// right-click it, Disconnect, then drag) and only one end leaves: the one of
// the curve you pressed on, or, pressed on the point's dot itself, the one of
// the curve you drag toward. These drive the real handlers: onPointerDown with
// Break armed, then with Select and Shift, onPointerMove past the 4 px click
// threshold, and the real solve pump, which is what moves geometry on a drag.
//
// The oracle for "independent" is a DRAG THROUGH THE SOLVER after the pull,
// never the pull itself. The pull moves an end by construction; whether the two
// ends are still one solver point is only visible when the solver moves one of
// them. The first test is the control that shows this oracle can fail.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts, menus, prompts } = vi.hoisted(() => ({
  toasts: [] as string[],
  menus: [] as { label: string; onClick?: () => void }[][],
  prompts: [] as (string | null)[],
}));
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
vi.mock("../ui/prompt", () => ({ setPrompt: (m: string | null) => void prompts.push(m) }));
vi.mock("../ui/menu", () => ({
  contextMenu: (_x: number, _y: number, items: { label: string; onClick?: () => void }[]) => void menus.push(items),
  dismissContextMenu: () => {},
}));

import { SketchMode } from "./sketchMode";
import { isBreakCut } from "./modify";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
type Line = Extract<ResolvedEntity, { type: "line" }>;

interface Priv {
  onPointerDown(e: PointerEvent): void;
  onPointerMove(e: PointerEvent): void;
  onContextMenu(e: MouseEvent): void;
  endDrag(pointerId?: number): void;
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  tool: string;
  solveBusy: boolean;
  pendingDrag: unknown;
}

/** A SketchMode on a 0..20 line along y=0, with stubs for everything that
 *  draws. The cursor is whatever `at` was last given; `snap` is what the
 *  snapper would return (Break and the select press read it), `raw` the plane
 *  point under the cursor (drags read it). */
function sketch(constraints: SketchConstraint[] = []) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const cur = { raw: v(0, 0), snap: v(0, 0), client: 0 };
  /** what the viewport would run at the start of its next frame
   *  (Viewport.beforeNextDraw): a drag's later moves wait on it */
  const frames: (() => void)[] = [];
  Object.assign(s, {
    active: true, tool: "break", constraints, patterns: [],
    entities: [{ type: "line", id: "L", x1: 0, y1: 0, x2: 20, y2: 0 }] as ResolvedEntity[],
    selected: new Set<string>(), rightDownAt: null, rightDragged: false, boxSel: null,
    solveBusy: false, solverDead: false, solveDirty: false, pendingDrag: null, pendingPinIdxs: null,
    pendingBias: null, moveDrag: null, dragFrom: null, entityVersion: 0, trial: null,
    dims: { clearSelection() {} },
    // a refused pull ends the drag, so later moves are plain hovers
    overlay: { setPreview() {}, activeRegionAt: () => null, setSnap() {}, setHoverRegion() {} },
    viewport: {
      domElement: { setPointerCapture() {}, releasePointerCapture() {} },
      beforeNextDraw: (fn: () => void) => { frames.push(fn); },
    },
    snapAt: () => ({ p: cur.snap.clone(), kind: "free" }),
    planePoint: () => cur.raw.clone(),
    pickTol: () => 0.5, // 9 px, so a px is 0.056 mm here
    endpointDotRadius: () => 0.14, // 2.5 px: "on the dot" reaches 0.28 mm
    refreshActive() {}, refreshDragGeometry() {}, requestSolve() {}, onState() {}, armPreEdit() {}, bankDrag() {},
  });
  const priv = s as unknown as Priv;
  const ev = (shift: boolean, button = 0) => ({
    button, shiftKey: shift, ctrlKey: false, clientX: cur.client, clientY: 0, pointerId: 1,
    preventDefault() {}, stopPropagation() {},
  }) as unknown as PointerEvent;
  /** let the solve pump finish what the last move queued, letting frames pass
   *  meanwhile (a drag move can be waiting on one) */
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      for (const fn of frames.splice(0)) fn();
      if (!priv.solveBusy && !priv.pendingDrag) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    priv,
    breakAt(x: number, y = 0) {
      priv.tool = "break";
      cur.snap = v(x, y); cur.raw = v(x, y);
      priv.onPointerDown(ev(false));
      priv.tool = "select";
    },
    /** press at `press` (raw; it snaps to the joint), drag to each of `path`, release */
    async drag(joint: THREE.Vector2, press: THREE.Vector2, path: THREE.Vector2[], shift: boolean) {
      cur.snap = joint; cur.raw = press; cur.client = 0;
      priv.onPointerDown(ev(shift));
      for (const [k, to] of path.entries()) {
        cur.raw = to; cur.client = 20 * (k + 1); // well past the 4 px click threshold
        priv.onPointerMove(ev(shift));
        await settle();
      }
      priv.endDrag(1);
      // GH #17 drag speed: a cluster-scoped gesture's release can fire one more
      // settle solve in the background (forcedSettle in endDrag). Drain it before
      // the next drag() call starts a new gesture, or that gesture's own first
      // move can find dragRelease still set from this one and get swallowed.
      await settle();
    },
    rightClick(at: THREE.Vector2) {
      cur.raw = at;
      priv.onContextMenu({ clientX: 0, clientY: 0, preventDefault() {} } as unknown as MouseEvent);
    },
    lines: () => priv.entities.filter((e) => e.type === "line") as Line[],
  };
}

/** the half that starts at the line's start, and the one that ends at its end */
const halves = (ls: Line[]) => ({
  left: ls.find((l) => l.x1 === 0 && l.y1 === 0)!,
  right: ls.find((l) => l.x2 === 20 && l.y2 === 0)!,
});

beforeEach(() => { toasts.length = 0; menus.length = 0; prompts.length = 0; });

describe("Break, then pull the halves apart", () => {
  it("Break says the halves stay joined, and how to pull them apart", () => {
    const sk = sketch();
    sk.breakAt(10);
    expect(sk.lines()).toHaveLength(2);
    expect(toasts).toEqual([t("sketch.modify.breakJoined")]);
  });

  it("control: a plain drag of the cut moves both ends, so the join is real", async () => {
    const sk = sketch();
    sk.breakAt(10);
    await sk.drag(v(10, 0), v(9.8, 0.05), [v(10, 4), v(10, 8)], false);
    const { left, right } = halves(sk.lines());
    expect([left.x2, left.y2]).toEqual([expect.closeTo(10, 6), expect.closeTo(8, 6)]);
    expect([right.x1, right.y1]).toEqual([expect.closeTo(10, 6), expect.closeTo(8, 6)]);
  });

  it("Shift-drag pulls away only the half pressed nearest, and it stays its own point", async () => {
    const sk = sketch();
    sk.breakAt(10);
    // pressed just left of the cut, on the LEFT half
    await sk.drag(v(10, 0), v(9.8, 0.05), [v(9, 4), v(9, 6)], true);
    let { left, right } = halves(sk.lines());
    expect([left.x2, left.y2]).toEqual([expect.closeTo(9, 6), expect.closeTo(6, 6)]);
    expect([right.x1, right.y1]).toEqual([10, 0]);

    // the oracle: a PLAIN drag of the pulled end, through the solver, must
    // leave the other half alone. Joined, it would come along.
    await sk.drag(v(9, 6), v(9, 6), [v(5, 10)], false);
    ({ left, right } = halves(sk.lines()));
    expect([left.x2, left.y2]).toEqual([expect.closeTo(5, 6), expect.closeTo(10, 6)]);
    expect([right.x1, right.y1]).toEqual([10, 0]);
  });

  it("pulls the RIGHT half when that is the one pressed", async () => {
    const sk = sketch();
    sk.breakAt(10);
    await sk.drag(v(10, 0), v(10.2, -0.05), [v(11, -4)], true);
    const { left, right } = halves(sk.lines());
    expect([right.x1, right.y1]).toEqual([expect.closeTo(11, 6), expect.closeTo(-4, 6)]);
    expect([left.x2, left.y2]).toEqual([10, 0]);
  });

  // Pressed through onPointerDown directly. In the app the ⊙ badge covers the
  // joint, and a press on it is handed to onPointerDown the same way
  // (labelOverlapSelect; glyphPointDrag.test.ts), so this toast is what a
  // Shift-drag from the badge says too.
  it("refuses when an explicit Coincident holds the ends, and says how to delete it", async () => {
    const sk = sketch();
    sk.breakAt(10);
    const [a, b] = sk.lines();
    sk.priv.constraints = [{ type: "coincident", e1: a!.id, p1: 1, e2: b!.id, p2: 0 }];
    toasts.length = 0;
    const before = JSON.stringify(sk.lines());
    await sk.drag(v(10, 0), v(9.8, 0.05), [v(9, 4), v(9, 6)], true);
    expect(JSON.stringify(sk.lines())).toBe(before);
    expect(toasts).toEqual([t("sketch.guard.coincidentHolds")]);
  });

  it("right-click Disconnect on the cut arms the same pull for a plain drag", async () => {
    const sk = sketch();
    sk.breakAt(10);
    sk.rightClick(v(9.9, 0.02));
    const item = menus.at(-1)?.find((i) => i.label === t("sketch.menu.disconnect"));
    expect(item, "the menu at a shared end offers no Disconnect").toBeDefined();
    item!.onClick!();
    expect(prompts.at(-1)).toBe(t("sketch.prompt.disconnect"));
    await sk.drag(v(10, 0), v(9.8, 0.05), [v(9, 4), v(9, 6)], false);
    const { left, right } = halves(sk.lines());
    expect([left.x2, left.y2]).toEqual([expect.closeTo(9, 6), expect.closeTo(6, 6)]);
    expect([right.x1, right.y1]).toEqual([10, 0]);
  });

  it("does not offer Disconnect away from a shared end", () => {
    const sk = sketch();
    sk.breakAt(10);
    sk.rightClick(v(4, 0.02)); // on the left half, nowhere near the cut
    expect(menus.at(-1)?.some((i) => i.label === t("sketch.menu.disconnect"))).toBe(false);
  });
});

// Pressed ON the cut, both halves are as near as each other, and the half that
// came first in the list always left, whichever way the drag went: dragging
// toward the right half pulled the LEFT half's end across it. The press names
// no curve there, so the drag decides.
describe("pressed on the cut itself, the drag picks the half", () => {
  it("pulls the right half when dragged toward it", async () => {
    const sk = sketch();
    sk.breakAt(10);
    await sk.drag(v(10, 0), v(10, 0), [v(14, 4)], true);
    const { left, right } = halves(sk.lines());
    expect([right.x1, right.y1]).toEqual([expect.closeTo(14, 6), expect.closeTo(4, 6)]);
    expect([left.x2, left.y2]).toEqual([10, 0]);
  });

  it("pulls the left half when dragged toward it", async () => {
    const sk = sketch();
    sk.breakAt(10);
    await sk.drag(v(10, 0), v(10, 0), [v(6, 4)], true);
    const { left, right } = halves(sk.lines());
    expect([left.x2, left.y2]).toEqual([expect.closeTo(6, 6), expect.closeTo(4, 6)]);
    expect([right.x1, right.y1]).toEqual([10, 0]);
  });

  it("does the same for arcs, and for a Disconnect from the menu", async () => {
    // an arc broken at its top: the halves leave the cut heading left and right
    const sk = sketch();
    sk.priv.entities = [{ type: "arc", id: "A", x1: 10, y1: 0, x2: -10, y2: 0, mx: 0, my: 10 }];
    sk.breakAt(0, 10);
    const arcs = () => sk.priv.entities as Extract<ResolvedEntity, { type: "arc" }>[];
    expect(arcs()).toHaveLength(2);
    const cut = v(arcs()[0]!.x2, arcs()[0]!.y2);
    sk.rightClick(cut);
    menus.at(-1)!.find((i) => i.label === t("sketch.menu.disconnect"))!.onClick!();
    // a plain drag from the cut toward the RIGHT half (the one ending at x=10)
    await sk.drag(cut, cut.clone(), [v(cut.x + 3, cut.y + 2)], false);
    // GH #17 drag speed: release now does a cluster solve then a forced
    // full-sketch resettle (two solver passes, not one), so an untouched
    // coordinate can land a float epsilon off its input value (e.g.
    // 9.999999999999998, not exactly 10) even though it never moved
    // geometrically. Identify the half by closeness, not exact equality.
    const right = arcs().find((a) => Math.abs(a.x1 - 10) < 1e-6 || Math.abs(a.x2 - 10) < 1e-6)!;
    const leftArc = arcs().find((a) => a !== right)!;
    const moved = (a: typeof right) => [v(a.x1, a.y1), v(a.x2, a.y2)].some((p) => p.distanceTo(v(cut.x + 3, cut.y + 2)) < 1e-6);
    expect(moved(right), "the right half's end did not follow the drag").toBe(true);
    expect([v(leftArc.x1, leftArc.y1), v(leftArc.x2, leftArc.y2)].some((p) => p.distanceTo(cut) < 1e-9)).toBe(true);
  });

  it("still pulls the half PRESSED when the press is on a curve, off the dot", async () => {
    const sk = sketch();
    sk.breakAt(10);
    // 0.4 mm along the left half (beyond the dot), dragged toward the right half
    await sk.drag(v(10, 0), v(9.6, 0), [v(13, 3)], true);
    const { left, right } = halves(sk.lines());
    expect([left.x2, left.y2]).toEqual([expect.closeTo(13, 6), expect.closeTo(3, 6)]);
    expect([right.x1, right.y1]).toEqual([10, 0]);
  });
});

// Round 2 decision C3: Shift-drag pulls ends apart ONLY at a cut Break made.
// It used to do it at any spot two curve ends shared with no constraint
// holding them, so a Shift-drag of a polyline corner tore the outline open.
// Anywhere but a cut, a Shift-drag is the plain drag it always was, and the
// right-click Disconnect still pulls one end off anywhere.
describe("Shift-drag pulls ends apart only at a Break's cut (C3)", () => {
  /** an L-shaped polyline: A along the x axis, B up from its end, joined by position only */
  const corner = (): ResolvedEntity[] => [
    { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
  ];
  const ends = (sk: ReturnType<typeof sketch>) => {
    const ls = sk.lines();
    const a = ls.find((l) => l.id === "A")!, b = ls.find((l) => l.id === "B")!;
    return { aEnd: [a.x2, a.y2], bStart: [b.x1, b.y1] };
  };

  it("a Shift-drag of a polyline corner moves the corner, both ends together", async () => {
    const sk = sketch();
    sk.priv.entities = corner();
    sk.priv.tool = "select";
    await sk.drag(v(10, 0), v(9.8, 0.05), [v(11, 3), v(12, 4)], true);
    const { aEnd, bStart } = ends(sk);
    expect(aEnd).toEqual([expect.closeTo(12, 6), expect.closeTo(4, 6)]);
    expect(bStart, "the corner was pulled apart").toEqual([expect.closeTo(12, 6), expect.closeTo(4, 6)]);
  });

  it("the right-click Disconnect still pulls one end off a polyline corner", async () => {
    const sk = sketch();
    sk.priv.entities = corner();
    sk.priv.tool = "select";
    sk.rightClick(v(9.9, 0.02));
    menus.at(-1)!.find((i) => i.label === t("sketch.menu.disconnect"))!.onClick!();
    // pressed on the corner's dot and dragged up, the way B goes: B's end leaves
    await sk.drag(v(10, 0), v(9.8, 0.05), [v(11, 3), v(12, 4)], false);
    const { aEnd, bStart } = ends(sk);
    expect(bStart).toEqual([expect.closeTo(12, 6), expect.closeTo(4, 6)]);
    expect(aEnd).toEqual([10, 0]);
  });

  it("knows a cut from the geometry, so it still reads as one in a sketch opened again", () => {
    const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });
    const P = { x: 10, y: 0 };
    // Two lines drawn end to end in one straight line read the same: the
    // geometry cannot tell them from a cut, so those pull apart too (the
    // CHANGELOG says so).
    expect(isBreakCut([line("a", 0, 0, 10, 0), line("b", 10, 0, 20, 0)], P), "two halves of one line").toBe(true);
    expect(isBreakCut([line("a", 10, 0, 0, 0), line("b", 20, 0, 10, 0)], P), "either way round").toBe(true);
    expect(isBreakCut([line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 10)], P), "a corner").toBe(false);
    expect(isBreakCut([line("a", 0, 0, 10, 0), line("b", 10, 0, 5, 0)], P), "one doubling back over the other").toBe(false);
    expect(isBreakCut([line("a", 0, 0, 10, 0), line("b", 10, 0, 20, 0), line("c", 10, 0, 10, 5)], P), "a line drawn onto the cut later").toBe(true);
    expect(isBreakCut([line("a", 0, 0, 10, 0), line("c", 10, 0, 10, 5), line("d", 10, 0, 15, 5)], P), "three corners in one spot").toBe(false);
    // an arc broken at its top, the way Break leaves it, and arcs that only share an end
    const arc = (id: string, x1: number, y1: number, x2: number, y2: number, mx: number, my: number): ResolvedEntity =>
      ({ type: "arc", id, x1, y1, x2, y2, mx, my });
    const top = { x: 0, y: 10 }, s = Math.SQRT1_2 * 10;
    expect(isBreakCut([arc("l", 0, 10, -10, 0, -s, s), arc("r", 10, 0, 0, 10, s, s)], top), "two halves of one arc").toBe(true);
    expect(isBreakCut([arc("l", 0, 10, -10, 0, -s, s), arc("r", 0, 10, -s, s, -5, 8.660254037844386)], top), "overlapping").toBe(false);
    expect(isBreakCut([arc("l", 0, 10, -10, 0, -s, s), arc("r", 0, 10, 10, 20, 7.0710678, 12.9289322)], top), "another circle").toBe(false);
  });
});
