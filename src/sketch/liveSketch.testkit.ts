// A SketchMode that takes real GESTURES: press, move and release go through
// onPointerDown / onPointerMove / endDrag exactly as the canvas listeners call
// them, the solve pump and the undo history are the real ones, and so is the
// constraint-tool click flow. Only what draws (viewport, overlay, labels,
// glyphs) is stubbed.
//
// Driving a real SketchMode needs WebGL, so `this` is hand-built off the
// prototype, the same trick doublePress.test.ts and
// emptySketchNotCommitted.test.ts use. The point of this one is that a test can
// observe what the user would see after a gesture (where the geometry ended
// up, what is selected, what the next click picks) instead of asserting that a
// helper was called. The caller mocks the planegcs wasm URL (see
// bodyDrag.test.ts), because the solves are real.
//
// Screen space is the sketch plane scaled by PX: client (x*PX, y*PX) is plane
// point (x, y). That keeps the handlers' 4 px click-vs-drag threshold honest
// (any move past 0.4 mm is a drag) without a camera.

import * as THREE from "three";
import { SketchMode, type SketchTool } from "./sketchMode";
import { SketchHistory } from "./history";
import { ConstraintTools } from "./constraintTools";
import { originGeometry } from "./origin";
import { SketchPlane } from "./plane";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

export const PX = 10;

/** The private state and handlers a gesture test drives and reads back. */
export interface SketchInternals {
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  selected: Set<string>;
  tool: SketchTool;
  history: SketchHistory;
  constructionMode: boolean;
  solveBusy: boolean;
  solveDirty: boolean;
  solverDead: boolean;
  /** what the last settled solve painted amber (over-defined), by constraint index */
  overIdx: Set<number>;
  lastDof: number;
  pendingPinIdxs: number[] | null;
  pendingDrag: unknown;
  lastPress: unknown;
  /** armed by a press on an entity body; null for a vertex press or a marquee */
  moveDrag: unknown;
  onPointerDown(e: PointerEvent): void;
  onPointerMove(e: PointerEvent): void;
  endDrag(pointerId?: number): void;
  onContextMenu(e: MouseEvent): void;
  armPreEdit(): void;
  requestSolve(): void;
  undoEdit(): boolean;
  setTool(t: SketchTool): void;
  setConstruction(on: boolean): void;
  setSelectedConstruction(on?: boolean): boolean;
  lockDimensionCommand(): void;
}

const pointer = (x: number, y: number, shift: boolean): PointerEvent =>
  ({
    button: 0,
    clientX: x * PX,
    clientY: y * PX,
    pointerId: 1,
    shiftKey: shift,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
  }) as unknown as PointerEvent;

export function liveSketch(ents: ResolvedEntity[], cons: SketchConstraint[] = []) {
  const s = Object.create(SketchMode.prototype) as SketchInternals;
  /** the points the constraint flow is holding, as its marker would show them */
  let held: { x: number; y: number }[] = [];
  /** what the viewport would run at the start of its next frame
   *  (Viewport.beforeNextDraw): a drag's later moves wait on it. settle() lets
   *  a frame pass. */
  const frames: (() => void)[] = [];
  Object.assign(s, {
    active: true,
    tool: "select",
    plane: new SketchPlane("XY"),
    entities: [...originGeometry(), ...ents],
    constraints: cons,
    patterns: [],
    selected: new Set<string>(),
    history: new SketchHistory(),
    // field initialisers the constructor would have run
    lastPress: null,
    moveDrag: null,
    dragFrom: null,
    dragSnapshot: null,
    boxSel: null,
    textBoxStart: null,
    rightDownAt: null,
    rightDragged: false,
    pendingDrag: null,
    pendingPinIdxs: null,
    pendingBias: null,
    trial: null,
    solveBusy: false,
    solveDirty: false,
    solverDead: false,
    conflict: false,
    conflictIdx: new Set<number>(),
    overIdx: new Set<number>(),
    entityVersion: 0,
    lastDof: -1,
    dragRefusedToast: false,
    constructionMode: false,
    filletFirst: null,
    // what draws: inert
    dims: { clearSelection() {}, hide() {}, setInteractive() {} },
    glyphs: { setInteractive() {} },
    dim: { hide() {} },
    textPanel: { hide() {} },
    projectPanel: { hide() {} },
    patternFlow: { flushPending() {}, hasPending: () => false },
    overlay: {
      activeRegionAt: () => null,
      activeTextIdAt: () => null,
      setPreview() {},
      setSnap() {},
      setHoverRegion() {},
      toggleRegionSelection() {},
      clearRegionSelection() {},
    },
    viewport: {
      domElement: { setPointerCapture() {}, releasePointerCapture() {} },
      hoverEntity() {},
      requestRender() {},
      beforeNextDraw: (fn: () => void) => { frames.push(fn); },
    },
    // the screen <-> plane mapping and the redraws, replaced
    planePointAt: (cx: number, cy: number) => new THREE.Vector2(cx / PX, cy / PX),
    snapAt: (cx: number, cy: number) => ({ p: new THREE.Vector2(cx / PX, cy / PX), kind: "free" }),
    pickTol: () => 0.5,
    refreshActive() {},
    refreshDragGeometry() {},
  });
  Object.assign(s, {
    constraintTools: new ConstraintTools({
      tool: () => s.tool,
      entities: () => s.entities,
      constraints: () => s.constraints,
      pickTol: () => 0.5,
      getFilletFirst: () => null,
      setFilletFirst() {},
      requestSolve() {},
      warn() {},
      setPendingPoints: (ps) => { held = ps; },
      addConstraint: (c) => { s.constraints.push(c); },
    }),
  });
  s.armPreEdit();

  // Every press starts a fresh gesture: two presses that land close together
  // would otherwise read as a double-click and take the chain-select branch.
  const press = (x: number, y: number, shift = false) => {
    s.lastPress = null;
    s.onPointerDown(pointer(x, y, shift));
  };
  const move = (x: number, y: number) => s.onPointerMove(pointer(x, y, false));
  const release = () => s.endDrag(1);

  /** Wait until the solve pump has nothing queued and nothing in flight,
   *  letting frames pass meanwhile (a drag move can be waiting on one). */
  const settle = async () => {
    for (let i = 0; i < 1000; i++) {
      for (const fn of frames.splice(0)) fn();
      if (!s.solveBusy && !s.solveDirty && s.pendingPinIdxs === null && !s.pendingDrag) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("the sketch solve pump never settled");
  };

  return {
    s,
    press,
    move,
    release,
    settle,
    /** a press and a release on the same spot */
    click(x: number, y: number, shift = false) {
      press(x, y, shift);
      release();
    },
    /** Press at `from`, walk to `to` in `steps` frames, release. With `each`,
     *  every frame's solve lands before the next move, which is what a slow hand
     *  gives the pump; without it the frames pile up behind one solve. */
    async drag(from: [number, number], to: [number, number], steps = 6, each = true) {
      press(from[0], from[1]);
      for (let i = 1; i <= steps; i++) {
        move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
        if (each) await settle();
      }
      release();
      await settle();
    },
    ent: (id: string) => s.entities.find((e) => e.id === id),
    /** what the constraint flow is holding after the last click */
    held: () => held,
  };
}
