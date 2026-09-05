// Scene setup: renderer, lights, Z-up grid + axes, sketch planes.
// CAD convention is Z-up (matches build123d), so the ground grid lies
// in the XY plane and cameras use up = +Z.

import * as THREE from "three";
import { stickyFact } from "../diagnostics/breadcrumbs";
import { toast } from "../ui/toast";
import { niceStep } from "../ui/units";

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  modelGroup: THREE.Group; // rebuilt geometry lives here
  planes: Record<"XY" | "XZ" | "YZ", THREE.Mesh>;
  grid: AdaptiveGrid;
}

/** A ground grid (XY plane) whose spacing snaps to nice 1/2/5×10ⁿ mm values and
 *  rescales with zoom, recentred on the camera target so it always fills the view
 *  with round-number lines. Two layers: dim minor + brighter major (every 5th). */
export class AdaptiveGrid {
  readonly group = new THREE.Group();
  step = 1; // current minor-line spacing in mm
  private minor: THREE.GridHelper | null = null;
  private major: THREE.GridHelper | null = null;
  private key = "";

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** worldPerPixel = world mm covered by one screen pixel at the target.
   *  gridZ = the height the grid sits at (the model's floor, or 0 when empty). */
  update(targetX: number, targetY: number, worldPerPixel: number, gridZ = 0) {
    this.group.position.z = gridZ; // track the model floor every frame, even if x/y/cell are cached
    const cell = niceStep(worldPerPixel * 64); // ~64px minor cells
    const majorCell = cell * 5;
    const cx = Math.round(targetX / majorCell) * majorCell;
    const cy = Math.round(targetY / majorCell) * majorCell;
    const k = `${cell}:${cx}:${cy}`;
    if (k === this.key) return;
    this.key = k;
    this.step = cell;
    this.rebuild(cell);
    this.group.position.set(cx, cy, gridZ);
  }

  private rebuild(cell: number) {
    this.dispose();
    const cells = 100; // extent = cell*100 (covers several screens)
    // center-line color == grid color so GridHelper draws no misplaced axes
    // (the world AxesHelper shows the real origin axes).
    this.minor = new THREE.GridHelper(cell * cells, cells, 0x23272e, 0x23272e);
    this.major = new THREE.GridHelper(cell * cells, cells / 5, 0x3a4048, 0x3a4048);
    for (const g of [this.minor, this.major]) {
      g.rotateX(Math.PI / 2); // GridHelper is XZ by default → lay flat on XY
      (g.material as THREE.Material).depthWrite = false;
      g.renderOrder = -2;
      this.group.add(g);
    }
  }

  private dispose() {
    for (const g of [this.minor, this.major]) {
      if (!g) continue;
      this.group.remove(g);
      g.geometry.dispose();
      (g.material as THREE.Material).dispose();
    }
    this.minor = this.major = null;
  }
}

/** Which renderer the webview reports, recorded once at startup.
 *
 *  TRUST THIS ONLY ON WINDOWS/macOS. WebKitGTK — the engine a Linux Tauri build
 *  runs on — deliberately SPOOFS WEBGL_debug_renderer_info for fingerprinting
 *  resistance and reports "Apple GPU / Apple Inc." on any hardware, so neither
 *  the name nor a software-rasteriser guess means anything there. Verified on
 *  this machine: the string said "Apple GPU" while the web process actually had
 *  /dev/dri/renderD128 open with libdrm_amdgpu + libgallium mapped, i.e. a real
 *  Radeon. The reliable Linux check is the process's open DRI fds, not WebGL.
 *
 *  Still worth recording: it is real on the other two platforms, and knowing it
 *  is spoofed is itself the answer when a Linux report blames the GPU.
 *
 *  DEPTH_BITS and the granted context attributes are recorded alongside it
 *  because, unlike the renderer string, they are REAL on every platform. A
 *  shallow depth buffer makes hidden edges and construction planes bleed through
 *  the solid, which is what report f45fe95c was first blamed on; measuring
 *  WebKitGTK showed 24 bits and killed that theory, but the next report of lines
 *  through a model should settle it from the log instead of from a rig. */
function recordGpu(renderer: THREE.WebGLRenderer) {
  let desc = "unknown";
  let depth = "";
  try {
    const gl = renderer.getContext();
    const a = gl.getContextAttributes();
    depth = `depth bits: ${gl.getParameter(gl.DEPTH_BITS)}, samples: ${gl.getParameter(gl.SAMPLES)}`
      + `, attributes: depth=${a?.depth} stencil=${a?.stencil} antialias=${a?.antialias}`;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const v = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    desc = `${r} (${v})`;
  } catch {
    /* querying the renderer must never break startup */
  }
  const spoofed = /apple/i.test(desc) && !/mac/i.test(navigator.platform ?? "");
  const note = spoofed ? " — reported by WebKitGTK, which spoofs this; not the real GPU" : "";
  (window as { __gpu?: string }).__gpu = desc + note;
  stickyFact(`[gpu] ${desc}${note}`);
  if (depth) stickyFact(`[gpu] ${depth}`);
}

/** Why the 3D context could not be created.
 *
 *  These are not the same problem and do not want the same thing asked of the
 *  user, which is the whole reason the probe below exists: three throws the SAME
 *  bare Error for a card with no WebGL2 and for one that has it but refused our
 *  attributes (three.module.js:15213 and :15217 — no code, no cause).
 *
 *    no-webgl     nothing at all, not even WebGL1: driver missing or blocked
 *    webgl1-only  GL works but only ES2. three r180 asks for "webgl2" and
 *                 nothing else, so this is fatal to the viewport. An older
 *                 NVIDIA card on the open-source nouveau driver is the case
 *                 this was written for (field report, Debian Bookworm, G105M).
 *    renderer     WebGL2 probes fine and three still refused, even without MSAA. */
export type GpuFailure = "no-webgl" | "webgl1-only" | "renderer";

export class NoWebGLError extends Error {
  constructor(readonly failure: GpuFailure, readonly facts: string[], cause?: unknown) {
    super(`3D context unavailable (${failure})`);
    this.name = "NoWebGLError";
    this.cause = cause;
  }
}

/** What this machine says about its own GL, gathered on a THROWAWAY canvas.
 *
 *  Never probe the real #canvas. A canvas hands out exactly one context for its
 *  lifetime: ask it for "webgl" and every later getContext("webgl2") returns
 *  null forever, so a probe placed there would CAUSE the failure it is looking
 *  for. The throwaway is released with WEBGL_lose_context afterwards because
 *  contexts are a capped resource, and a machine already failing here is the
 *  last one that can spare one.
 *
 *  Same spoofing caveat as recordGpu above: on Linux the renderer STRING is
 *  fiction. Whether webgl2 exists at all, and gl.VERSION, are not — and those
 *  are what pick the message. */
function probeGl(): { webgl2: boolean; anyGl: boolean; facts: string[] } {
  const probe = document.createElement("canvas");
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = probe.getContext("webgl2");
  const webgl2 = !!gl;
  if (!gl) gl = probe.getContext("webgl");
  const facts: string[] = [`webgl2: ${webgl2 ? "yes" : "no"}`];
  if (!gl) {
    facts.push("no WebGL context of any version");
    return { webgl2, anyGl: false, facts };
  }
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const v = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    facts.push(`renderer: ${r} (${v})`);
    facts.push(`version: ${gl.getParameter(gl.VERSION)}`);
    facts.push(`shading language: ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`);
  } catch {
    facts.push("renderer strings unreadable");
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { webgl2, anyGl: true, facts };
}

/** The renderer, or a NoWebGLError saying WHICH kind of nothing this machine has.
 *
 *  THE RETRY IS NOT A GUESS, it recovers a context three already made and threw
 *  away. When its attribute set is refused, three calls getContext("webgl2")
 *  a second time with NO attributes purely to decide which message to throw
 *  (three.module.js:15211) — and if that succeeds, a real context now exists on
 *  the canvas, which three then discards by throwing anyway. Asking the same
 *  canvas again returns that existing context (getContext ignores attributes
 *  once a context of the same type exists), so this branch always recovers. The
 *  cost is the default attribute set instead of ours, which for this app means
 *  only that alpha is on, and setClearColor below writes alpha 1 regardless.
 *
 *  Worth knowing if a context-loss bug ever appears here: three registers its
 *  contextlost/restored listeners BEFORE each attempt (three.module.js:15199)
 *  and does not remove them when it throws, so the failed attempt leaves a set
 *  behind on the canvas.
 *
 *  Facts go through stickyFact, not crumb: recordGpu cannot run on this path (it
 *  needs the renderer that does not exist), so this is the ONLY way a bug report
 *  from a machine that cannot draw learns what its GL is, and a sticky fact is
 *  the one kind of breadcrumb that later toasts cannot evict. */
function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const { webgl2, anyGl, facts } = probeGl();
  if (!webgl2) {
    for (const f of facts) stickyFact(`[gpu] ${f}`);
    throw new NoWebGLError(anyGl ? "webgl1-only" : "no-webgl", facts);
  }
  try {
    return new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    try {
      const plain = new THREE.WebGLRenderer({ canvas, antialias: false });
      stickyFact("[gpu] the driver refused our context attributes, running on its defaults");
      return plain;
    } catch (e) {
      for (const f of facts) stickyFact(`[gpu] ${f}`);
      throw new NoWebGLError("renderer", facts, e);
    }
  }
}

/** The viewport background. Set once at startup AND again on every context
 *  restore — see watchContextLoss. */
const CLEAR_COLOR = 0x1a1d21;

/** Survive the GPU taking the context away (a driver reset, a laptop switching
 *  GPUs, or — the field report this exists for — an allocation failure on a
 *  machine that is out of memory).
 *
 *  Three handles the GL side: it calls preventDefault() on the loss (which is
 *  what asks the browser for a restore at all), stops rendering, and rebuilds
 *  every GL object in initGLContext when the context comes back. Do NOT
 *  re-handle any of that. What three does NOT do is the two things that leave
 *  the user looking at a dead rectangle:
 *
 *  - nothing tells the user, and nothing lands in a bug report;
 *  - initGLContext rebuilds three's background module, which drops the clear
 *    colour set above, and it does not dirty our render-on-demand loop — so the
 *    view stays blank until the user happens to move the camera, and then comes
 *    back BLACK. Hence onRestored, which repaints with the colour re-applied. */
function watchContextLoss(
  canvas: HTMLCanvasElement,
  renderer: THREE.WebGLRenderer,
  onRestored?: () => void,
) {
  let losses = 0;
  canvas.addEventListener("webglcontextlost", () => {
    // one sticky fact, however many times this cycles: a machine losing the
    // context in a loop must not fill the sticky buffer with the same line.
    if (losses++ === 0) stickyFact("[gpu] the 3D context was lost at least once");
    toast("The 3D view lost its graphics context and is trying to recover.", { kind: "warning" });
  });
  canvas.addEventListener("webglcontextrestored", () => {
    renderer.setClearColor(CLEAR_COLOR, 1);
    onRestored?.();
  });
}

export function createScene(canvas: HTMLCanvasElement, onContextRestored?: () => void): SceneBundle {
  const renderer = createRenderer(canvas);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(CLEAR_COLOR, 1);
  watchContextLoss(canvas, renderer, onContextRestored);
  recordGpu(renderer);

  const scene = new THREE.Scene();

  // --- lighting rig (key + fill + ambient) for a clean product look ---
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(40, -60, 80);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-50, 40, 20);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202428, 0.6));

  // --- Z-up adaptive ground grid in the XY plane (rescales with zoom) ---
  const grid = new AdaptiveGrid(scene);

  // axes: X red, Y green, Z blue
  const axes = new THREE.AxesHelper(20);
  scene.add(axes);

  // --- sketch planes (semi-transparent, toggled per active sketch) ---
  const planes = {
    XY: makePlane(0x4488ff, "XY"),
    XZ: makePlane(0x44ff88, "XZ"),
    YZ: makePlane(0xff8844, "YZ"),
  };
  for (const p of Object.values(planes)) {
    p.visible = false;
    scene.add(p);
  }

  const modelGroup = new THREE.Group();
  scene.add(modelGroup);

  return { renderer, scene, modelGroup, planes, grid };
}

function makePlane(color: number, kind: "XY" | "XZ" | "YZ"): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(60, 60);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // PlaneGeometry is in XY by default.
  if (kind === "XZ") mesh.rotateX(Math.PI / 2);
  if (kind === "YZ") mesh.rotateY(Math.PI / 2);
  mesh.renderOrder = -1;
  mesh.userData.plane = kind;
  return mesh;
}
