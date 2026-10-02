// A sketch drag on the GH #17 reporter's machine felt "elastic": the geometry
// and the badges trailed the pointer. Measured on his 15-constraint sketch, every
// pointermove ran a full planegcs solve AND the whole UI update (onState, which
// re-laid-out the ribbon) inside the event, 7-12 ms each, and WebKit hands a
// fast hand several moves per frame. The dimension badges and glyphs did not
// move at all until the button came up.
//
// These drive the real SketchMode handlers the canvas listeners call
// (onPointerDown / onPointerMove / endDrag) and the real solver, with the
// viewport's frame scheduling replaced by a queue the test drains by hand. Each
// observes an effect: how many solves ran, where the dragged point ended up,
// what the UI was told, and where the badges are drawn.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
// The real solver, counted.
vi.mock("./sketchSolve", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sketchSolve")>();
  return { ...real, compileAndSolve: vi.fn(real.compileAndSolve) };
});

import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchMode } from "./sketchMode";
import { SketchPlane } from "./plane";
import { SketchHistory } from "./history";
import { SketchDimensions } from "./sketchDimensions";
import { SketchGlyphs } from "./sketchGlyphs";
import { compileAndSolve } from "./sketchSolve";
import { initSolver } from "./solver";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { Viewport } from "../viewport/viewport";

installFakeDocument();
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

const solves = compileAndSolve as unknown as ReturnType<typeof vi.fn>;

/** Every pending microtask and the timers they queue: what the browser drains
 *  after an event handler returns, before the next event. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** Two lines joined at (10,0); A is horizontal and its start is fixed, so
 *  dragging B's free end at (10,10) is a real constrained solve. */
const doc = (): { ents: ResolvedEntity[]; cons: SketchConstraint[] } => ({
  ents: [
    { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
  ],
  cons: [
    { type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 },
    { type: "horizontal", line: "A" },
    { type: "fix", e: "A", p: 0 },
  ] as SketchConstraint[],
});

// The handlers and state under test are private: reach them the way the
// other prototype-built SketchMode tests do (doublePress, centreRectBadge).
type Mode = Record<string, any>;

/** A SketchMode on the select tool where one screen px is one sketch mm, so a
 *  pointer event's clientX/Y IS the plane point. `frames` is what the viewport
 *  would run at the start of its next frame (Viewport.beforeNextDraw). */
function mount(opts: { badges?: boolean; more?: SketchConstraint[] } = {}) {
  const { ents, cons } = doc();
  cons.push(...(opts.more ?? []));
  const frames: (() => void)[] = [];
  const seen = { state: 0, redraws: 0, drawnB: "" };
  const viewport = {
    camera: new THREE.PerspectiveCamera(),
    domElement: { setPointerCapture() {}, releasePointerCapture() {} },
    beforeNextDraw: (fn: () => void) => { frames.push(fn); },
    requestRender() {},
    pixelWorldSize: () => 0.01,
    projectToOverlay: (w: THREE.Vector3) => ({ x: w.x * 10, y: w.y * 10, width: 900, height: 700 }),
  };
  const s = Object.create(SketchMode.prototype) as Mode;
  Object.assign(s, {
    active: true,
    tool: "select",
    plane: new SketchPlane("XY"),
    entities: ents,
    constraints: cons,
    patterns: [],
    selected: new Set<string>(),
    history: new SketchHistory(),
    conflictIdx: new Set<number>(),
    overIdx: new Set<number>(),
    pendingDrag: null,
    pendingPinIdx: null,
    moveDrag: null,
    dragFrom: null,
    boxSel: null,
    trial: null,
    pendingBias: null,
    dimPicks: [],
    entityVersion: 0,
    lastDof: -1,
    conflict: false,
    dimsVisible: !!opts.badges,
    glyphsVisible: !!opts.badges,
    patternFlow: { pending: null },
    viewport,
    overlay: {
      setActiveSketch: () => {
        seen.redraws++;
        seen.drawnB = JSON.stringify(s.entities.find((e: ResolvedEntity) => e.id === "B"));
      },
      setActiveRegions() {},
      setPreview() {},
      activeRegionAt: () => null,
      activeTextIdAt: () => null,
    },
    dim: { hide() {} },
    dims: opts.badges
      ? new SketchDimensions(viewport as unknown as Viewport, () => {})
      : { clearSelection() {}, show() {}, hide() {}, follow: () => true },
    glyphs: opts.badges
      ? new SketchGlyphs(viewport as unknown as Viewport)
      : { show() {}, hide() {}, follow: () => true },
    onState: () => { seen.state++; },
    snapAt: (x: number, y: number) => ({ p: new THREE.Vector2(x, y), kind: "free" }),
    planePoint: (e: { clientX: number; clientY: number }) => new THREE.Vector2(e.clientX, e.clientY),
  });
  s.armPreEdit();
  const ev = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, shiftKey: false, ctrlKey: false, preventDefault() {} });
  const down = (x: number, y: number) => s.onPointerDown(ev(x, y));
  const move = (x: number, y: number) => s.onPointerMove(ev(x, y));
  const up = () => s.endDrag(1);
  /** run the frame the viewport would draw next, and the solve it starts */
  const frame = async () => {
    const due = frames.splice(0);
    for (const fn of due) fn();
    await settle();
    while (s.solveBusy) await settle();
  };
  const B = () => s.entities.find((e: ResolvedEntity) => e.id === "B") as Extract<ResolvedEntity, { type: "line" }>;
  return { s, down, move, up, frame, frames, seen, B };
}

// The app loads the solver at startup (main.ts), so by the time anyone drags,
// a solve finishes inside the frame that starts it.
beforeAll(async () => {
  expect(await initSolver()).toBe(true);
});

beforeEach(() => {
  solves.mockClear();
});

describe("a sketch drag solves a frame's first move at once and the rest once, ahead of the draw (GH #17)", () => {
  it("solves a frame's first move in its own event, and the rest of that frame's moves once, at the newest", async () => {
    const m = mount();
    m.down(10, 10);
    m.move(15, 10);
    await settle(); // separate events: each one's microtasks drain before the next
    // The first move of a frame is solved in its event, as every move was on
    // 83ecd3d: where the webview has to wait for its next frame, the solve uses
    // the wait instead of adding to it (measured on WebKitGTK).
    expect(solves).toHaveBeenCalledTimes(1);
    expect(m.B().x2).toBeCloseTo(15, 6);
    for (const [x, y] of [[16, 10], [17, 10]] as const) {
      m.move(x, y);
      await settle();
    }
    // RED on 83ecd3d: one full solve per move, three in all, in the handlers
    expect(solves).toHaveBeenCalledTimes(1);
    expect(m.frames.length, "one frame queued for the whole burst").toBe(1);

    await m.frame();
    expect(solves).toHaveBeenCalledTimes(2);
    expect(m.B().x2).toBeCloseTo(17, 6); // the newest target, not the one before it
    expect(m.B().y2).toBeCloseTo(10, 6);
    expect(m.frames.length, "nothing more queued once it is solved").toBe(0);

    // the next frame starts over: its first move is solved at once again
    m.move(19, 10);
    await settle();
    expect(solves).toHaveBeenCalledTimes(3);
    expect(m.B().x2).toBeCloseTo(19, 6);
  });

  // WebKitGTK starts a frame straight after an event that changed something it
  // has to repaint, and otherwise waits for its display tick. Measured on the
  // reporter's sketch (WebKitGTK 2.52, broadway): 8-9 ms from a move to the
  // screen on 83ecd3d, whose ribbon re-layout did this by accident, 13-14 with
  // the solve moved into the frame and nothing changed, 5-6 with this. Through
  // the real Viewport.beforeNextDraw.
  it("asks the engine for the frame inside the move's own event, with a repaint nobody can see", () => {
    const m = mount();
    const vp = Object.create(Viewport.prototype) as Record<string, any>;
    vp.preDraw = []; // instance field initialisers: Object.create skips them
    vp.canvas = { style: {} as Record<string, string> };
    m.s.viewport.beforeNextDraw = (fn: () => void) => vp.beforeNextDraw(fn);
    m.down(10, 10);
    m.move(15, 10);
    // RED before the fix: the move queued its frame and changed nothing at all
    expect(vp.canvas.style.backgroundColor).toMatch(/^rgba\(0, 0, [01], 0\)$/); // alpha 0: invisible
  });

  it("tells the UI nothing on drag frames, and once on release", async () => {
    const m = mount();
    m.down(10, 10);
    for (let i = 1; i <= 4; i++) {
      m.move(14 + i, 10);
      await m.frame();
    }
    // RED on 83ecd3d: onState after every frame's solve, re-laying-out the ribbon each time
    expect(m.seen.state).toBe(0);
    m.up();
    await settle();
    while (m.s.solveBusy) await settle();
    expect(m.seen.state).toBeGreaterThan(0);
    expect(m.s.dragFrom).toBeNull();
  });

  // A guard for the coalescing rather than a reproduction: 83ecd3d solved in
  // the move itself, so it never had a queued move at release to lose.
  it("a release with the last move still waiting for its frame lands the point under the cursor, as one undo step", async () => {
    const m = mount();
    const before = { x2: m.B().x2, y2: m.B().y2 };
    m.down(10, 10);
    m.move(15, 10); // the frame's first move, solved in its event
    await settle();
    m.move(18, 10); // the second waits for the frame, and the button comes up first
    await settle();
    expect(m.s.pendingDrag, "the move under test really is waiting").not.toBeNull();
    m.up();
    await settle();
    while (m.s.solveBusy) await settle();
    expect(m.B().x2).toBeCloseTo(18, 6);
    expect(m.B().y2).toBeCloseTo(10, 6);
    expect(m.s.dragFrom).toBeNull();
    expect(m.s.dragRelease ?? null).toBeNull();
    // the frame that was queued for that move has nothing left to do
    const n = solves.mock.calls.length;
    await m.frame();
    expect(solves.mock.calls.length).toBe(n);
    // one undo step for the whole gesture, back to where it started
    expect(m.s.canUndoSketch).toBe(true);
    expect(m.s.undoEdit()).toBe(true);
    expect(m.B().x2).toBeCloseTo(before.x2, 6);
    expect(m.B().y2).toBeCloseTo(before.y2, 6);
  });

  it("a body drag also solves and redraws twice per frame at most, not once per move", async () => {
    const m = mount();
    m.down(10, 5); // B's body, away from both ends
    m.seen.redraws = 0;
    for (const d of [5, 6, 7]) {
      m.move(10 + d, 5 + d);
      await settle();
    }
    // RED on 83ecd3d: a pinned solve and a curve rebuild per move, three of each
    expect(solves).toHaveBeenCalledTimes(1);
    expect(m.seen.redraws).toBe(1);
    await m.frame();
    expect(solves).toHaveBeenCalledTimes(2);
    expect(m.seen.redraws).toBe(2);
    expect(m.seen.drawnB, "the screen shows the newest move").toBe(JSON.stringify(m.B()));
    // ...and the solve kept the joint: B's start is still on A's end
    const A = m.s.entities.find((e: ResolvedEntity) => e.id === "A") as Extract<ResolvedEntity, { type: "line" }>;
    expect(Math.hypot(m.B().x1 - A.x2, m.B().y1 - A.y2)).toBeLessThan(1e-6);
    await m.frame();
    expect(m.seen.redraws, "a frame with no new move draws nothing more").toBe(2);
    m.up();
    await settle();
  });

  // The solver's WASM can be refused (seen on WebView2); the sketch then stays
  // editable unconstrained. A regression guard rather than a reproduction:
  // 83ecd3d redrew on every move. The first version of the frame coalescing
  // queued a solve that could never run, and drew nothing until the release.
  it("a body drag with the solver gone still draws every frame", async () => {
    const m = mount();
    m.s.solverDead = true;
    m.down(10, 5);
    m.seen.redraws = 0;
    for (const d of [5, 6, 7]) {
      m.move(10 + d, 5 + d);
      await settle();
    }
    await m.frame();
    expect(solves).toHaveBeenCalledTimes(0);
    expect(m.B().x1).toBeCloseTo(17, 6); // the data moved...
    expect(m.seen.drawnB, "...and so did the screen").toBe(JSON.stringify(m.B()));
    m.up();
    await settle();
  });
});

/** The overlay elements a layer has drawn, by their class prefix. */
function drawn(root: FakeEl, cls: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.className.split(" ").includes(cls)) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

describe("dimension badges and constraint glyphs move with a drag (GH #17)", () => {
  it("follow the geometry on every drag frame, and do not jump on release", async () => {
    const body = (globalThis as unknown as { document: { body: FakeEl } }).document.body;
    body.innerHTML = "";
    // B vertical, so dragging its free end lengthens it: its length badge and
    // its V glyph both have somewhere to go
    const m = mount({ badges: true, more: [{ type: "vertical", line: "B" } as SketchConstraint] });
    m.s.refreshActive(); // what enter() draws
    const dims = m.s.dims as unknown as { loop: () => void };
    const glyphs = m.s.glyphs as unknown as { loop: () => void };
    const paint = () => { dims.loop(); glyphs.loop(); }; // their rAF passes
    paint();
    const where = () => ({
      dims: drawn(body, "sketch-dim").map((el) => `${el.textContent}@${el.style.transform}`),
      glyphs: drawn(body, "sketch-glyph").map((el) => `${el.textContent}@${el.style.transform}`),
    });
    const atRest = where();
    expect(atRest.dims.length).toBeGreaterThan(0);
    expect(atRest.glyphs.length).toBeGreaterThan(0);

    m.down(10, 10);
    m.move(14, 16);
    await m.frame();
    expect(m.B().y2).toBeCloseTo(16, 6);
    paint();
    const midDrag = where();
    // RED on 83ecd3d: every badge and glyph stays where it was until release
    expect(midDrag.dims).not.toEqual(atRest.dims);
    expect(midDrag.glyphs).not.toEqual(atRest.glyphs);

    m.up();
    await settle();
    paint();
    // release rebuilds them from scratch; they must already have been there
    expect(where()).toEqual(midDrag);
  });
});
