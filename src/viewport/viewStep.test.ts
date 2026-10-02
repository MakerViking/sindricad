// The arrow keys turn the view in 15 degree steps (a tester: the ViewCube's
// 45 degree edges and corners are too coarse to work with).
//
// There was no stepped rotation at all — the "45" was the ViewCube's fixed
// targets — so this is the whole path a keystroke takes: the REAL keymap
// resolves the arrow from the REAL shortcut table, main.ts routes it to
// Viewport.stepView (pinned as source, since importing main boots the app), and
// stepView turns the REAL camera rig. Assertions are on where the camera ends
// up, measured against what a mouse drag in the same direction does.
import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";

const windowHandlers: ((e: unknown) => void)[] = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (t: string, fn: (e: unknown) => void) => {
    if (t === "keydown") windowHandlers.push(fn);
  },
  removeEventListener() {},
};
class Sel {}
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = class {};
(globalThis as unknown as { HTMLTextAreaElement: unknown }).HTMLTextAreaElement = class {};
(globalThis as unknown as { HTMLSelectElement: unknown }).HTMLSelectElement = Sel;
(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = class {};

const { installKeymap } = await import("../input/keymap");
const { harness } = await import("./rig.testkit");
const { Viewport } = await import("./viewport");
const mainSrc = (await import("../main.ts?raw")).default;

const STEP_DEG = 15;

/** A keydown as the browser delivers it; `defaulted` says whether the app took
 *  the keystroke's default away (preventDefault). */
function press(key: string, target: unknown = null) {
  const e = {
    key, target, isComposing: false, keyCode: 0,
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    defaulted: false,
    preventDefault() { e.defaulted = true; },
    stopPropagation() {},
  };
  for (const fn of windowHandlers) fn(e);
  return e;
}

describe("the keymap", () => {
  const actions: string[] = [];
  let decline = false;
  let context: "model" | "sketch" = "model";
  installKeymap((a) => {
    actions.push(a);
    return decline ? false : undefined;
  }, () => context);
  beforeEach(() => {
    actions.length = 0;
    decline = false;
    context = "model";
  });

  it("turns each arrow into its view step, in a sketch as well as outside one", () => {
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) press(k);
    context = "sketch";
    press("ArrowLeft");
    expect(actions).toEqual(["view-step-left", "view-step-right", "view-step-up", "view-step-down", "view-step-left"]);
  });

  it("leaves the arrows to a focused <select>, which steps its options with them", () => {
    const e = press("ArrowDown", new Sel());
    expect(actions).toEqual([]);
    expect(e.defaulted).toBe(false);
  });

  it("leaves the key's default alone when the app declines it (a modal is up)", () => {
    decline = true;
    const e = press("ArrowRight");
    expect(actions).toEqual(["view-step-right"]);
    expect(e.defaulted).toBe(false);
    // ...and takes it as before otherwise
    decline = false;
    expect(press("ArrowRight").defaulted).toBe(true);
  });
});

describe("main.ts routes the steps (source)", () => {
  it("sends each step to Viewport.stepView, outside handleAction, and not under a modal", () => {
    const at = mainSrc.indexOf("const VIEW_STEP_DIRS");
    expect(at, "VIEW_STEP_DIRS is gone from main.ts").toBeGreaterThan(-1);
    const body = mainSrc.slice(at, at + 1400);
    for (const a of ["view-step-left", "view-step-right", "view-step-up", "view-step-down"]) expect(body).toContain(`"${a}"`);
    expect(body).toContain("viewport.stepView(step.right, step.down)");
    expect(body).toContain("if (isChoiceOpen()) return false");
    // routed in the keymap callback, BEFORE handleAction — which would end a
    // section edit and record the step as "Repeat"
    expect(body.indexOf("stepView")).toBeLessThan(body.indexOf("handleAction(a)"));
  });
});

// --- the camera ------------------------------------------------------------------

function standIn() {
  const h = harness();
  const vp = Object.create(Viewport.prototype) as InstanceType<typeof Viewport>;
  // the private flags stepView writes, read back as the render loop and the load fit would
  const flags = vp as unknown as { needsRender: boolean; cameraDriven: boolean };
  Object.assign(vp, { rig: h.rig, needsRender: false, lingerFrames: 0, userMovedCamera: false, cameraDriven: false });
  h.rig.update(0.016);
  return { vp, h, flags };
}

const viewDir = (h: ReturnType<typeof harness>) =>
  h.rig.controls.getTarget(new THREE.Vector3()).sub(h.rig.controls.getPosition(new THREE.Vector3())).normalize();
const degBetween = (a: THREE.Vector3, b: THREE.Vector3) => THREE.MathUtils.radToDeg(a.angleTo(b));

describe("Viewport.stepView", () => {
  it("turns the view exactly one 15 degree step per press", () => {
    const { vp, h } = standIn();
    for (const [right, down] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const before = viewDir(h);
      vp.stepView(right, down);
      h.rig.update(0.016);
      expect(degBetween(before, viewDir(h)), `step ${right},${down}`).toBeCloseTo(STEP_DEG, 6);
    }
  });

  it("turns it the way a mouse drag in the same direction does", () => {
    // Small drag, same direction: the view must move toward where the drag took it.
    for (const [right, down, dx, dy] of [[1, 0, 20, 0], [-1, 0, -20, 0], [0, -1, 0, -20], [0, 1, 0, 20]] as const) {
      const drag = standIn();
      const from = viewDir(drag.h);
      drag.h.down(1, 400, 300);
      drag.h.move(400 + dx, 300 + dy);
      drag.h.up();
      drag.h.rig.update(0.016);
      const dragged = viewDir(drag.h).sub(from);

      const key = standIn();
      key.vp.stepView(right, down);
      key.h.rig.update(0.016);
      const stepped = viewDir(key.h).sub(from);
      expect(stepped.dot(dragged), `arrow ${right},${down} turned against the drag`).toBeGreaterThan(0);
    }
  });

  it("claims the camera from a load's owed fit, and asks for a frame", () => {
    const { vp, flags } = standIn();
    vp.stepView(1, 0);
    expect(flags.cameraDriven).toBe(true);
    expect(flags.needsRender).toBe(true);
  });

  it("holds still while a sketch's Lock to Plane is on", () => {
    const { vp, h, flags } = standIn();
    h.rig.setOrbitLocked(true);
    const before = viewDir(h);
    vp.stepView(1, 0);
    vp.stepView(0, 1);
    h.rig.update(0.016);
    expect(degBetween(before, viewDir(h))).toBeCloseTo(0, 9);
    expect(flags.cameraDriven).toBe(false);
  });
});
