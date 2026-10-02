// The section TOOL, driven the way the user drives it: start() is what the axis
// chooser calls, typing goes into the real offset box (input, then Enter), and
// F and Esc arrive on the window the way the keyboard delivers them. The
// SectionTool and the DimInput are real; only the viewport is a stub, keeping
// the plane by reference exactly as the real one does, so a test reads the cut
// that is on screen rather than a private field.
//
// Three field reports from the same tester:
//   5effc008 / 724df0f3: "Section view does not remember where it was
//     positioned after it closes or which view was sectioned", and "the
//     onscreen dimension and tickboxes cover a lot of detail of the section".
//   f36c1c7a: "I had an active cross section, hit file, new, abandoned
//     original file... the cross-section drag arrow was still active in the
//     new document."
//
// What it does NOT cover, stated rather than implied: real projection, layout,
// the WebGL clip and the repaint itself (only that a frame is asked for). Those
// were checked by driving the app headless, which is not in CI.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { SectionTool, besideModel } from "./sectionTool";
import { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument } from "../types";
import mainSrc from "../main.ts?raw";

installFakeDocument();
class FakeInput extends FakeEl {}
const doc = globalThis.document as unknown as { createElement: (tag: string) => FakeEl; body: FakeEl };
doc.createElement = (tag: string) => (tag === "input" ? new FakeInput(tag) : new FakeEl(tag));

const keydown: ((e: unknown) => void)[] = [];
let frames: FrameRequestCallback[] = [];
vi.stubGlobal("HTMLInputElement", FakeInput);
vi.stubGlobal("window", {
  addEventListener: (type: string, fn: (e: unknown) => void) => {
    if (type === "keydown") keydown.push(fn);
  },
  removeEventListener: (type: string, fn: (e: unknown) => void) => {
    if (type === "keydown") keydown.splice(keydown.indexOf(fn), 1);
  },
});
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
vi.stubGlobal("cancelAnimationFrame", () => {});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** Run one animation frame: the tool's tick() and the box's re-focus. */
function frame() {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
}

/** A key on the window, as the keyboard sends it (target: the canvas). */
function press(key: string) {
  const e = { key, target: null, preventDefault() {}, stopPropagation() {} };
  for (const fn of [...keydown]) fn(e);
}

/** The offset box's root: the DimInput mounts itself on <body>. */
function dimRoot(): FakeEl {
  const root = doc.body.children.filter((c) => c.className === "dim-input").at(-1);
  if (!root) throw new Error("no offset box was mounted");
  return root;
}

/** Type into the offset box and press Enter, the way a user does. */
function typeOffset(mm: number) {
  const input = dimRoot().querySelector("input");
  if (!input) throw new Error("the offset box has no field");
  input.value = String(mm);
  input.dispatch("input");
  input.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
}

const MODEL = new THREE.Box3(new THREE.Vector3(-10, -20, -5), new THREE.Vector3(30, 20, 15));
const CANVAS = { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 };

/** A viewport looking straight down -Y (a front view): world X runs right and
 *  Z runs up the screen, 5 px per mm, the model's centre near the middle. */
function harness(box: THREE.Box3 | null = MODEL, origin = { x: 450, y: 375 }) {
  let clip: THREE.Plane | null = null;
  const scene = new Set<THREE.Object3D>();
  const vp = {
    renders: 0,
    modelBox: () => box,
    setClipPlane(p: THREE.Plane | null) {
      clip = p; // by reference, as the real viewport keeps it
    },
    get clipped() {
      return !!clip;
    },
    requestRender() {
      vp.renders++;
    },
    projectToScreen: (p: THREE.Vector3) => ({ x: origin.x + p.x * 5, y: origin.y - p.z * 5 }),
    pixelWorldSize: () => 0.2,
    domElement: {
      style: {} as Record<string, string>,
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => CANVAS,
    },
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.delete(o),
    rayFrom: () => ({ intersectObjects: () => [] }),
  };
  const tool = new SectionTool(vp as never);
  return {
    tool,
    vp,
    /** the cut on screen: [normal, constant], or null for no cut (-0 read as 0) */
    cut: () => (clip ? { normal: clip.normal.toArray().map((v) => v + 0), constant: clip.constant + 0 } : null),
    arrows: () => scene.size,
  };
}

beforeEach(() => {
  keydown.length = 0;
  frames = [];
});

describe("reopening Section puts the last cut back (5effc008, 724df0f3)", () => {
  it("same axis: the typed offset survives Esc and a reopen", () => {
    const { tool, cut } = harness();
    tool.start("X");
    typeOffset(-7);
    const before = cut();
    // model centre x = 10, so -7 puts the cut at x = 3
    expect(before).toEqual({ normal: [1, 0, 0], constant: -3 });
    press("Escape");
    expect(cut(), "Esc still takes the cut away").toBeNull();
    expect(tool.active).toBe(false);

    tool.start("X");
    expect(cut()).toEqual(before);
    // and the box shows it (as |value|, never seeded: see the abs-display trap)
    expect(dimRoot().querySelector("input")!.value).toBe("7");
  });

  it("the kept half (F) is remembered with it", () => {
    const { tool, cut } = harness();
    tool.start("Y");
    press("f");
    expect(cut()!.normal).toEqual([0, -1, 0]);
    press("Escape");
    tool.start("Y");
    expect(cut()!.normal).toEqual([0, -1, 0]);
  });

  it("the cut is remembered where it is ON the axis, so a model that grew does not move it", () => {
    const box = MODEL.clone();
    const { tool, cut } = harness(box);
    tool.start("X");
    typeOffset(-7); // x = 3
    press("Escape");
    box.max.x = 70; // an edit makes the model longer: its centre moves from 10 to 30
    tool.start("X");
    expect(cut()).toEqual({ normal: [1, 0, 0], constant: -3 });
  });

  it("a different axis starts at the model's centre, as before", () => {
    const { tool, cut } = harness();
    tool.start("X");
    typeOffset(-7);
    press("Escape");
    tool.start("Z"); // centre z = 5
    expect(cut()).toEqual({ normal: [0, 0, 1], constant: -5 });
  });

  it("a remembered cut that no longer falls inside the model is not restored", () => {
    // It would cut nothing, or everything, and the model would just vanish.
    const { tool, cut } = harness();
    tool.start("X");
    typeOffset(100); // x = 110, past the end at 30
    press("Escape");
    tool.start("X");
    expect(cut()).toEqual({ normal: [1, 0, 0], constant: -10 });
  });

  it("a cut left on screen by another tool is remembered too", () => {
    // stop(true) is what starting any other tool does (main.ts handleAction)
    const { tool, cut } = harness();
    tool.start("Y");
    typeOffset(4);
    tool.stop(true);
    expect(cut(), "the cut stays while the other tool runs").not.toBeNull();
    tool.start("Y");
    expect(cut()).toEqual({ normal: [0, 1, 0], constant: -4 });
  });

  it("the chooser offers the last axis first, so one Enter reopens it", () => {
    const { tool } = harness();
    expect(tool.axisOrder()).toEqual(["Z", "X", "Y"]);
    tool.start("Y");
    press("Escape");
    expect(tool.axisOrder()).toEqual(["Y", "Z", "X"]);
    // and main.ts builds the chooser from that order, not a fixed list
    const at = mainSrc.indexOf('case "section":');
    const arm = mainSrc.slice(at, mainSrc.indexOf("case ", at + 20));
    expect(arm).toContain("section.axisOrder()");
  });
});

describe("a section belongs to its document (f36c1c7a)", () => {
  /** The real store's replace events, the ones File ▸ New/Open/Close and
   *  Recover raise, with a backend that never answers a rebuild. */
  function storeWith(tool: SectionTool) {
    const backend = {
      rebuild: () => new Promise(() => {}),
      onRebuildChunk: () => () => {},
      onStatus: () => () => {},
      onProgress: () => () => {},
      cancel: async () => true,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(backend, { parameters: {}, features: [] } as CadDocument);
    store.onReplace(() => tool.documentReplaced()); // what main.ts wires, pinned below
    return store;
  }

  it("File ▸ New takes down the arrow AND the cut, and forgets the position", () => {
    const { tool, cut, arrows } = harness();
    const store = storeWith(tool);
    tool.start("X");
    typeOffset(-7);
    expect(arrows()).toBe(1);
    store.newDocument();
    expect(tool.active).toBe(false);
    expect(arrows(), "the drag arrow stayed in the new document").toBe(0);
    expect(cut(), "the old plane would cut the next document's bodies").toBeNull();
    expect(tool.axisOrder()).toEqual(["Z", "X", "Y"]);
    tool.start("X");
    expect(cut()).toEqual({ normal: [1, 0, 0], constant: -10 });
  });

  it("Open (and Recover, the same load) clears a cut whose arrow was already down", () => {
    const { tool, cut } = harness();
    const store = storeWith(tool);
    tool.start("Z");
    tool.stop(true); // another tool took the arrow down, the cut stayed
    expect(cut()).not.toBeNull();
    store.load(JSON.stringify({ parameters: {}, features: [] }));
    expect(cut()).toBeNull();
  });

  it("main.ts wires it to the store's replace event", () => {
    const at = mainSrc.indexOf("store.onReplace(");
    expect(at).toBeGreaterThan(-1);
    const body = mainSrc.slice(at, mainSrc.indexOf("\n});", at));
    expect(body).toContain("section.documentReplaced()");
  });
});

describe("a flip or a typed offset repaints at once", () => {
  // Render-on-demand: the plane is moved in place, and only a pointermove over
  // the canvas asked for a frame, so F and Enter did nothing visible until the
  // mouse moved.
  it("F asks for a frame", () => {
    const { tool, vp } = harness();
    tool.start("Z");
    const before = vp.renders;
    press("F");
    expect(vp.renders).toBeGreaterThan(before);
  });

  it("Enter on a typed offset asks for a frame", () => {
    const { tool, vp } = harness();
    tool.start("Z");
    const before = vp.renders;
    typeOffset(3);
    expect(vp.renders).toBeGreaterThan(before);
  });
});

describe("the offset box stays off the section (5effc008)", () => {
  /** The model's box on screen, through the same projection the harness uses. */
  function modelOnScreen(box: THREE.Box3, origin: { x: number; y: number }) {
    return { left: origin.x + box.min.x * 5, right: origin.x + box.max.x * 5, top: origin.y - box.max.z * 5, bottom: origin.y - box.min.z * 5 };
  }
  /** The box as laid out: 122 x 40 px, the size measured in the real app. */
  function boxOnScreen() {
    const root = dimRoot();
    const left = parseFloat(root.style.left!);
    const top = parseFloat(root.style.top!);
    return { left, top, right: left + 122, bottom: top + 40 };
  }
  const overlaps = (a: ReturnType<typeof boxOnScreen>, b: ReturnType<typeof boxOnScreen>) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  function openWithLaidOutBox(h: ReturnType<typeof harness>) {
    h.tool.start("Z");
    const root = dimRoot();
    root.offsetWidth = 122;
    root.offsetHeight = 40;
    frame(); // tick() places it every frame, as the camera moves
  }

  it("sits beside the model, level with the arrow, not over the cut", () => {
    const origin = { x: 450, y: 375 };
    const h = harness(MODEL, origin);
    openWithLaidOutBox(h);
    const model = modelOnScreen(MODEL, origin);
    const box = boxOnScreen();
    expect(overlaps(box, model), JSON.stringify({ box, model })).toBe(false);
    expect(box.left).toBeGreaterThanOrEqual(model.right);
    // level with the arrow: the cut is at z = 5, i.e. y = 350 on screen
    expect(box.top).toBeLessThanOrEqual(350);
    expect(box.bottom).toBeGreaterThanOrEqual(350);
  });

  it("goes to the left when the model reaches the canvas's right edge", () => {
    const origin = { x: 800, y: 375 }; // model spans x 750..950 of a 1000 px canvas
    const h = harness(MODEL, origin);
    openWithLaidOutBox(h);
    const model = modelOnScreen(MODEL, origin);
    const box = boxOnScreen();
    expect(overlaps(box, model), JSON.stringify({ box, model })).toBe(false);
    expect(box.right).toBeLessThanOrEqual(model.left);
  });

  it("stays on the canvas when the model fills it", () => {
    const at = besideModel({ left: -50, top: -50, right: 1050, bottom: 750 }, 900, { width: 122, height: 40 }, CANVAS);
    expect(at).toEqual({ x: 1000 - 122, y: 700 - 40 });
  });
});
