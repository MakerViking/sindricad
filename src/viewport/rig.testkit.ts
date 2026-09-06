// A CameraRig driven headlessly, for tests about what the camera actually does.
//
// There is no jsdom in this project, and camera-controls only needs a handful of
// DOM surface: a rect, a few attribute setters, and somewhere to hang pointer
// listeners. That is little enough to stub, and stubbing it buys real behavioural
// cover for navigation — which is otherwise only ever testable by hand.
//
// `harness()` REMEMBERS its listeners so a test can fire a genuine drag through
// the same path a user's pointer takes.
import * as THREE from "three";
import { createCameraRig, type CameraRig } from "./cameras";

// createCameraRig binds Shift on `window` for the middle-button pan swap.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {} };
}
if (typeof (globalThis as { DOMRect?: unknown }).DOMRect === "undefined") {
  (globalThis as { DOMRect?: unknown }).DOMRect = class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    get left() { return this.x; }
    get top() { return this.y; }
    get right() { return this.x + this.width; }
    get bottom() { return this.y + this.height; }
  };
}
// The rig's pointer handlers guard on `e instanceof PointerEvent`; node has no
// such class, so declare one the stub events can be instances of.
export class FakePointerEvent {
  pointerId: number;
  clientX: number;
  clientY: number;
  button: number;
  /** the held-buttons bitmask camera-controls reads (1 left, 2 right, 4
   *  middle); derived from `button` so a stub press looks like a real one to
   *  the library as well as to the rig's own capture listeners. */
  buttons: number;
  movementX: number;
  movementY: number;
  pointerType = "mouse";
  constructor(init: { pointerId?: number; clientX?: number; clientY?: number; button?: number; buttons?: number; movementX?: number; movementY?: number } = {}) {
    this.pointerId = init.pointerId ?? 1;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? (this.button === 0 ? 1 : this.button === 1 ? 4 : this.button === 2 ? 2 : 0);
    this.movementX = init.movementX ?? 0;
    this.movementY = init.movementY ?? 0;
  }
  preventDefault() {}
}
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
}
const PE = (globalThis as { PointerEvent: typeof FakePointerEvent }).PointerEvent;

const W = 800;
const H = 600;

export interface RigHarness {
  rig: CameraRig;
  /** press a mouse button on the canvas (0 = left, 1 = middle, 2 = right) */
  down(button: number, x?: number, y?: number): void;
  /** move the pointer, as the document sees it during a drag */
  move(x: number, y: number): void;
  up(): void;
  cancel(): void;
}

export function harness(): RigHarness {
  const domL: Record<string, ((e: unknown) => void)[]> = {};
  const docL: Record<string, ((e: unknown) => void)[]> = {};
  const add = (bag: Record<string, ((e: unknown) => void)[]>) => (t: string, f: (e: unknown) => void) => {
    (bag[t] ??= []).push(f);
  };
  const doc = {
    addEventListener: add(docL),
    removeEventListener() {},
    documentElement: { clientWidth: W, clientHeight: H },
  };
  const el = {
    addEventListener: add(domL),
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () =>
      new (globalThis as { DOMRect: new (x: number, y: number, w: number, h: number) => unknown }).DOMRect(0, 0, W, H),
    clientWidth: W,
    clientHeight: H,
    ownerDocument: doc,
    style: {},
  };
  const rig = createCameraRig(el as unknown as HTMLElement, W / H);
  const fire = (bag: Record<string, ((e: unknown) => void)[]>, type: string, e: unknown) =>
    (bag[type] ?? []).forEach((f) => f(e));
  // camera-controls re-reads the held buttons from every pointermove and takes
  // its drag deltas from movementX/Y, so a stub move has to carry both or the
  // library sees a drag with no buttons and no motion (our own capture
  // handlers only read clientX/Y). Track the press so move() can supply them.
  let held = { button: -1, buttons: 0, x: 0, y: 0 };
  return {
    rig,
    down: (button, x = 0, y = 0) => {
      const e = new PE({ button, clientX: x, clientY: y });
      held = { button, buttons: e.buttons, x, y };
      fire(domL, "pointerdown", e);
    },
    move: (x, y) => {
      const e = new PE({ button: held.button < 0 ? 0 : held.button, buttons: held.buttons, clientX: x, clientY: y, movementX: x - held.x, movementY: y - held.y });
      held = { ...held, x, y };
      fire(docL, "pointermove", e);
    },
    up: () => {
      held = { button: -1, buttons: 0, x: held.x, y: held.y };
      fire(docL, "pointerup", new PE({ buttons: 0 }));
    },
    cancel: () => {
      held = { button: -1, buttons: 0, x: held.x, y: held.y };
      fire(docL, "pointercancel", new PE({ buttons: 0 }));
    },
  };
}

/** The rig, forced into orthographic and settled. */
export function orthoHarness(): RigHarness {
  const h = harness();
  h.rig.setProjectionMode("ortho");
  h.rig.update(0.016);
  return h;
}

/** Angle between the view direction and world +Z, in radians. */
export function polarOf(rig: CameraRig): number {
  const dir = rig.controls
    .getPosition(new THREE.Vector3())
    .sub(rig.controls.getTarget(new THREE.Vector3()))
    .normalize();
  return Math.acos(THREE.MathUtils.clamp(dir.z, -1, 1));
}
