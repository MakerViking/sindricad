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
import { Viewport } from "../viewport/viewport";
import { SectionCaps, CAP_SHADE } from "../viewport/sectionCaps";
import { BASE_COLOR, buildBodyMesh, type ModelView } from "../viewport/render";
import { Picker, type Hit } from "../viewport/picking";
import type { RebuildResult } from "../types";

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

describe("the cut is solid, not hollow (5effc008)", () => {
  // "Section view implies all the bodies are hollow, would be good to see the
  // solid section." Driven the way the user drives it: the real SectionTool on a
  // real Viewport's clip and cap code, with bodies built from real geometry.
  // `draw()` is what the render loop does before every frame it draws. The
  // pixels themselves need WebGL, so they were checked by driving the app.
  const box = (x: number, z: number) => {
    const geo = new THREE.BoxGeometry(10, 10, 10).translate(x, 0, z);
    return {
      id: `b${x}_${z}`,
      mesh: new THREE.Mesh(geo, new THREE.MeshStandardMaterial()),
      edges: { material: { clippingPlanes: null, opacity: 1, transparent: false } },
    };
  };

  function solidHarness(stencil = true) {
    // two boxes on z = 0, one up at z = 30: the model spans z -5..35
    const bodies = [box(0, 0), box(20, 0), box(0, 30)];
    const vp = Object.create(Viewport.prototype) as Record<string, unknown>;
    Object.assign(vp, {
      canvas: { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => CANVAS },
      scene: { renderer: { localClippingEnabled: false }, stencil, scene: new THREE.Scene() },
      model: { bodies, edges: [], orphanEdges: null, box: new THREE.Box3().setFromObject(new THREE.Group().add(...bodies.map((b) => b.mesh.clone()))) },
      caps: new SectionCaps(),
      analysis: "none",
      bodyPaint: {},
      projectToScreen: (p: THREE.Vector3) => ({ x: 450 + p.x * 5, y: 375 - p.z * 5 }),
      pixelWorldSize: () => 0.2,
      rayFrom: () => ({ intersectObjects: () => [] }),
    });
    const caps = vp.caps as SectionCaps;
    const tool = new SectionTool(vp as never);
    const draw = () => (vp as unknown as { syncSectionCaps(): void }).syncSectionCaps();
    /** the caps on screen after the next frame: [x, z] of each, sorted */
    const shown = () => {
      draw();
      return caps.root.children
        .filter((o) => o.visible && ((o as THREE.Mesh).material as THREE.Material).colorWrite)
        .map((o) => [Math.round(o.position.x), Math.round(o.position.z)])
        .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
    };
    return { tool, vp, bodies, caps, shown };
  }

  it("a cut through two bodies shows a solid face on each, and moves with the cut", () => {
    const { tool, shown } = solidHarness();
    tool.start("Z"); // the model's centre, z = 15: between the boxes, cuts nothing
    expect(shown()).toEqual([]);
    typeOffset(-15); // z = 0, through the two lower boxes
    expect(shown()).toEqual([[0, 0], [20, 0]]);
    typeOffset(15); // z = 30: the arrow's drag moves the plane in place
    expect(shown()).toEqual([[0, 30]]);
    press("F"); // the other half kept: still cut, still capped
    expect(shown()).toEqual([[0, 30]]);
  });

  it("the caps stay on the persistent cut after the arrow is put away, and go with it", () => {
    const { tool, shown } = solidHarness();
    tool.start("Z");
    typeOffset(-15);
    tool.stop(true); // another tool started: the arrow goes, the cut stays (#17)
    expect(shown()).toEqual([[0, 0], [20, 0]]);
    tool.start("Z");
    press("Escape"); // Esc clears the cut
    expect(shown()).toEqual([]);
  });

  it("each cap is the body's own colour, darkened", () => {
    const { tool, vp, bodies, caps, shown } = solidHarness();
    (vp as unknown as { setBodyPaint(m: Record<string, string>): void }).setBodyPaint({ [bodies[0]!.id]: "#ff0000" });
    tool.start("Z");
    typeOffset(-15);
    shown();
    const colours = caps.root.children
      .filter((o) => o.visible && ((o as THREE.Mesh).material as THREE.Material).colorWrite)
      .sort((a, b) => a.position.x - b.position.x)
      .map((o) => ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex());
    const dark = (c: THREE.ColorRepresentation) => new THREE.Color(c).multiplyScalar(CAP_SHADE).getHex();
    expect(colours).toEqual([dark("#ff0000"), dark(BASE_COLOR)]);
  });

  it("a hidden body has no cap, and a model dimmed for sketching keeps the see-through look", () => {
    const { tool, vp, bodies, shown } = solidHarness();
    tool.start("Z");
    typeOffset(-15);
    bodies[1]!.mesh.visible = false;
    expect(shown()).toEqual([[0, 0]]);
    (vp as unknown as { setModelDimmed(on: boolean): void }).setModelDimmed(true);
    expect(shown()).toEqual([]);
    (vp as unknown as { setModelDimmed(on: boolean): void }).setModelDimmed(false);
    expect(shown()).toEqual([[0, 0]]);
  });

  it("without a stencil buffer the cut stays hollow, as before", () => {
    const { tool, shown } = solidHarness(false);
    tool.start("Z");
    typeOffset(-15);
    expect(shown()).toEqual([]);
  });
});

describe("a pick lands on what the cut shows (5effc008 review)", () => {
  // With the cut looking solid, a pick that still saw the whole model was a
  // trap: hovering a cap lit up a face of the half the cut removed, and a click
  // took it. Measured in the app before the fix: the cup's floor cap lit its
  // outer wall. Driven here through the real click and pick code, on bodies
  // built the way the app builds them, after the real SectionTool made the cut.
  //
  // Three boxes: A and B on z = 0, and C, small, well below A. The cut is Z at
  // z = 0 keeping the top half, so C is entirely in the removed half: not
  // drawn, and nothing to pick. The camera looks UP at the cut from below,
  // straight through C and A's cap.
  const SIZES: { at: [number, number, number]; size: number }[] = [
    { at: [0, 0, 0], size: 10 }, // A: body1, faces 0-5
    { at: [20, 0, 0], size: 10 }, // B: body2, faces 6-11
    { at: [0, 0, -20], size: 6 }, // C: body3, faces 12-17
  ];
  const TOP_OF_A = 4; // BoxGeometry's face order is +x -x +y -y +z -z
  const W = 1000;
  const H = 700;

  /** Box bodies as the sidecar sends them (each face its own vertices and
   *  B-rep face id, twelve edges each), built into a ModelView by
   *  buildBodyMesh, so a pick resolves faces and edges as the app does. */
  function boxesView(): ModelView {
    const positions: number[] = [];
    const indices: number[] = [];
    const faceIds: number[] = [];
    const edges: RebuildResult["edges"] = [];
    const metas = SIZES.map(({ at, size }, i) => {
      const id = `body${i + 1}`;
      const g = new THREE.BoxGeometry(size, size, size).translate(...at);
      const base = positions.length / 3;
      positions.push(...g.getAttribute("position").array);
      const idx = g.getIndex()!.array;
      for (const v of idx) indices.push(base + v);
      for (let t = 0; t < idx.length / 3; t++) faceIds.push(i * 6 + Math.floor(t / 2));
      const corner = (k: number) => at.map((c, a) => c + ((k >> a) & 1 ? size / 2 : -size / 2)) as [number, number, number];
      for (let k = 0; k < 8; k++) {
        for (const bit of [1, 2, 4]) {
          if (!(k & bit)) edges.push({ id: `${id}e${k}_${bit}`, points: [corner(k), corner(k | bit)], body: id });
        }
      }
      return { id, name: id, faceStart: i * 6, faceCount: 6 };
    });
    const result = { mesh: { positions, indices, faceIds }, edges, bodies: metas } as unknown as RebuildResult;
    const bodies = metas.map((m) =>
      buildBodyMesh(result, m, edges.filter((e) => e.body === m.id), new THREE.Vector2(W, H), undefined),
    );
    const box = new THREE.Box3();
    for (const b of bodies) box.expandByObject(b.mesh);
    return { bodies, edges: bodies.flatMap((b) => b.edges.refs), orphanEdges: null, box };
  }

  function pickHarness(stencil = true) {
    const view = boxesView();
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 10000);
    const vp = Object.create(Viewport.prototype) as Record<string, unknown>;
    Object.assign(vp, {
      canvas: {
        style: {},
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect: () => ({ ...CANVAS, right: W, bottom: H, width: W, height: H, x: 0, y: 0 }),
      },
      scene: { renderer: { localClippingEnabled: false }, stencil, scene: new THREE.Scene() },
      rig: { active: camera },
      model: view,
      caps: new SectionCaps(),
      picker: new Picker(),
      sharedRaycaster: new THREE.Raycaster(),
      ndc: new THREE.Vector2(),
      selectionMode: "faces",
      clipPlane: null,
      datumQuads: [],
      highlighter: null,
      analysis: "none",
      bodyPaint: {},
      projectToScreen: () => ({ x: 500, y: 350 }),
      pixelWorldSize: () => 0.2,
    });
    const tool = new SectionTool(vp as never);
    const v = vp as unknown as {
      syncSectionCaps(): void;
      handleClick(e: unknown): void;
      bodyIdAt(x: number, y: number): string | null;
      pickEdgeAt(x: number, y: number): { edge: { id: string } } | null;
      onHit: ((hit: Hit | null) => void) | null;
      clipPlane: THREE.Plane | null;
    };
    /** Look at `target` from `eye`; the next frame is drawn (caps synced). */
    const look = (eye: [number, number, number], target: [number, number, number]) => {
      camera.position.set(...eye);
      camera.up.set(0, 1, 0);
      camera.lookAt(...target);
      camera.updateMatrixWorld();
      v.syncSectionCaps();
    };
    const screenOf = (p: [number, number, number]) => {
      const s = new THREE.Vector3(...p).project(camera);
      return { x: ((s.x + 1) / 2) * W, y: ((1 - s.y) / 2) * H };
    };
    /** A left click in Faces mode: what it selects. */
    const click = (x: number, y: number) => {
      let got: Hit | null | undefined;
      v.onHit = (hit) => (got = hit);
      v.handleClick({ clientX: x, clientY: y, ctrlKey: false, metaKey: false, shiftKey: false });
      return got;
    };
    const faceOf = (hit: Hit | null | undefined) => (hit?.kind === "face" ? hit.faceId : hit?.kind ?? null);
    return { tool, v, vp, look, screenOf, click, faceOf };
  }

  /** The cut through A and B, at z = 0, keeping the top half. */
  function cutAtZero(h: ReturnType<typeof pickHarness>) {
    h.tool.start("Z"); // the model spans z -23..5, so this cuts at z = -9
    typeOffset(9);
    expect(h.v.clipPlane?.normal.toArray()).toEqual([0, 0, 1]);
    expect(h.v.clipPlane?.constant).toBeCloseTo(0, 9);
  }

  it("a click on a cap selects nothing behind it, not the removed half's faces", () => {
    const h = pickHarness();
    cutAtZero(h);
    h.look([0.3, 0.4, -60], [0.3, 0.4, 0]);
    expect(h.faceOf(h.click(500, 350)), "not C, not A's removed bottom, not A's hidden top").toBeNull();
  });

  it("in Bodies mode the cap is its body's: a click selects A, not C in front of it", () => {
    const h = pickHarness();
    cutAtZero(h);
    h.look([0.3, 0.4, -60], [0.3, 0.4, 0]);
    expect(h.v.bodyIdAt(500, 350)).toBe("body1");
    // beside the bodies there is nothing, removed or not
    const beside = h.screenOf([10, 0, 0]);
    expect(h.v.bodyIdAt(beside.x, beside.y)).toBeNull();
  });

  it("an edge of the removed half is not picked", () => {
    const h = pickHarness();
    cutAtZero(h);
    // close under C, so its edge is tens of pixels from any other: the edge
    // tools' pick has no occlusion test and a generous radius, by design
    h.look([0.3, 0.4, -40], [0.3, 0.4, 0]);
    const onC = h.screenOf([1, -3, -23]); // the middle of C's bottom front edge
    expect(h.v.pickEdgeAt(onC.x, onC.y)).toBeNull();
  });

  it("from the kept side, the faces in front of the cut are picked as before", () => {
    const h = pickHarness();
    cutAtZero(h);
    h.look([0.3, 0.4, 60], [0.3, 0.4, 0]);
    expect(h.faceOf(h.click(500, 350))).toBe(TOP_OF_A);
  });

  it("without a stencil buffer the cut is hollow, and a click takes the inside it shows", () => {
    const h = pickHarness(false);
    cutAtZero(h);
    h.look([0.3, 0.4, -60], [0.3, 0.4, 0]);
    // looking up into hollow A: its top face, seen from inside (bodies are
    // DoubleSide), is what the screen shows there
    expect(h.faceOf(h.click(500, 350))).toBe(TOP_OF_A);
  });

  it("with no cut, a pick sees the whole model, as it always did", () => {
    const h = pickHarness();
    h.look([0.3, 0.4, -60], [0.3, 0.4, 0]);
    expect(h.faceOf(h.click(500, 350)), "C's bottom face").toBe(12 + 5);
  });

  // Extrude's start and up-to picks (GH #41) weigh a body CORNER and the sketch
  // points in front of the body, which the ray cannot hit, so they had their
  // own occlusion test and corner pick, and those saw the whole model through
  // the cut. Driven through the real Extrude tool's Up-to click, on the real
  // viewport's picks, after the cut is made the way the Section tool makes it.
  //
  // Looking up from close under C: P1 is a sketch point 10 below the cut, in
  // the removed half, where C stood in front of it; P2 is one 2 above the cut,
  // inside A, behind A's cap.
  const P1: [number, number, number] = [1, 1, -10];
  const P2: [number, number, number] = [-1, -1, 2];
  const C_CORNER: [number, number, number] = [3, 3, -23]; // a corner of C's bottom face

  async function extrudeOn(h: ReturnType<typeof pickHarness>) {
    const { ExtrudeTool } = await import("./extrudeTool");
    const { SketchOverlay } = await import("../sketch/overlay");
    vi.stubGlobal("Node", FakeEl);
    const level = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] });
    const d = {
      features: [
        // the profile, well clear of the boxes
        { id: "s1", type: "sketch", plane: "XY", entities: [{ id: "ra", type: "rectangle", x: 60, y: 0, width: 10, height: 10 }] },
        { id: "s2", type: "sketch", plane: level(P1[2]), entities: [{ id: "p1", type: "point", x: P1[0], y: P1[1] }] },
        { id: "s3", type: "sketch", plane: level(P2[2]), entities: [{ id: "p2", type: "point", x: P2[0], y: P2[1] }] },
      ],
      parameters: {},
    } as unknown as CadDocument;
    const overlay = new SketchOverlay();
    overlay.update(d);
    const previews: unknown[] = [];
    const queries: unknown[] = [];
    const store = {
      document: d,
      isParamBound: () => false,
      boundExpr: () => null,
      beginEditPreview() {},
      endEditPreview() {},
      setPreview: (f: unknown) => previews.push(f),
      setEditPreview: (f: unknown) => previews.push(f),
      buildState: {},
      hiddenBodyIds: () => [],
      nextId: () => "new1",
      onBuild: () => () => {},
      queryReferences: (items: unknown) => {
        queries.push(items);
        return new Promise(() => {});
      },
    };
    // the real viewport's picks; what the tool draws or highlights is stubbed
    Object.assign(h.vp, {
      projectToScreen: (w: THREE.Vector3) => h.screenOf([w.x, w.y, w.z]),
      addToScene() {},
      removeFromScene() {},
      requestRender() {},
      tiltOffAxis: () => false,
      pointInSolid: () => false,
      planeHitsAt: () => [],
      datumPlaneOf: () => null,
      showAllPlanes() {},
      hoverPlane() {},
      hoverFaceAt: () => null,
      hoverEdge() {},
      hoverDatum() {},
      clearHover() {},
    });
    const tool = new ExtrudeTool(h.vp as never, overlay, store as never);
    overlay.toggleRegionSelection(overlay.regions.find((wr) => wr.region.entityIds.includes("ra"))!, false);
    tool.start(() => {});
    const internals = tool as unknown as { onKey(e: KeyboardEvent): void; onDown(e: PointerEvent): void };
    internals.onKey({ key: "t", target: null, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
    /** an Up-to click at a world point as the screen shows it: the point it ran up to, or "corner" */
    const clickAt = (w: [number, number, number]) => {
      const before = queries.length;
      const s = h.screenOf(w);
      internals.onDown({ button: 0, clientX: s.x, clientY: s.y, buttons: 1, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() {}, stopImmediatePropagation() {} } as unknown as PointerEvent);
      if (queries.length > before) return "corner";
      return (previews.at(-1) as { upToRef?: { entity: string } } | undefined)?.upToRef?.entity ?? null;
    };
    return { clickAt };
  }

  it("Extrude's Up to takes no corner of the removed half, and a sketch point that half hid", async () => {
    const h = pickHarness();
    cutAtZero(h);
    h.look([0.3, 0.4, -40], [0.3, 0.4, 0]);
    const x = await extrudeOn(h);
    expect(x.clickAt(C_CORNER), "a corner of C, which the cut removed").toBeNull();
    expect(x.clickAt(P2), "a point behind A's cap is still hidden").toBeNull();
    expect(x.clickAt(P1), "the point C hid before the cut took it away").toBe("p1");
  });

  it("CONTROL: with no cut, the same clicks take C's corner and leave both points hidden", async () => {
    const h = pickHarness();
    h.look([0.3, 0.4, -40], [0.3, 0.4, 0]);
    const x = await extrudeOn(h);
    expect(x.clickAt(P1), "behind C").toBeNull();
    expect(x.clickAt(P2), "behind C and A").toBeNull();
    expect(x.clickAt(C_CORNER)).toBe("corner");
  });
});
