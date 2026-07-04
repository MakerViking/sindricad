// 3D mouse (3Dconnexion SpaceMouse) support.
//
// The Tauri native side reads the device and streams 6DOF motion + button
// events (see src-tauri/src/spacemouse.rs). Here we map motion onto the camera
// (orbit / pan / zoom via camera-controls) and rising-edge button presses to an
// action callback. Browser/dev (no Tauri) is a no-op.
//
// The axis→action mapping is DATA-DRIVEN and user-configurable (each camera
// action binds to one of the six raw axes, with invert + sensitivity), because
// which physical axis is which differs per device/orientation. The 3D-Mouse
// Settings screen (src/ui/spaceMouseSettings.ts) edits this live with a raw-axis
// readout + a test cube; the config persists to localStorage.

import { listen } from "@tauri-apps/api/event";
import type { Viewport } from "../viewport/viewport";

export interface Motion { tx: number; ty: number; tz: number; rx: number; ry: number; rz: number }
const ZERO: Motion = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

export type AxisName = "tx" | "ty" | "tz" | "rx" | "ry" | "rz";
export const AXIS_NAMES: AxisName[] = ["tx", "ty", "tz", "rx", "ry", "rz"];
export const AXIS_LABELS: Record<AxisName, string> = {
  tx: "Slide ←→ (Tx)", ty: "Push/pull (Ty)", tz: "Lift ↑↓ (Tz)",
  rx: "Tilt/pitch (Rx)", ry: "Tilt sideways/roll (Ry)", rz: "Twist (Rz)",
};

export type ActionName = "panX" | "panY" | "zoom" | "orbitAz" | "orbitPolar" | "roll";
export const ACTION_LABELS: Record<ActionName, string> = {
  panX: "Pan ←→", panY: "Pan ↑↓", zoom: "Zoom", orbitAz: "Rotate ←→", orbitPolar: "Rotate ↑↓", roll: "Roll ↻",
};

export interface AxisBinding { src: AxisName; invert: boolean }

export interface SpaceMouseConfig {
  // "object" = puck manipulates the model (3Dconnexion/Fusion default); "camera"
  // = puck flies the camera (inverse of object on pan + orbit).
  mode: "object" | "camera";
  deadzone: number; // ignore |axis| below this (jitter)
  // pan/zoom are ZOOM-PROPORTIONAL (scaled by rig.viewScale() — the visible
  // view height): a puck deflection moves the view by the same FRACTION of
  // what's on screen at any zoom. Fixed world-unit steps made the puck feel
  // ~100× too fast when zoomed into mm-scale detail ("sensitivity went crazy").
  panSens: number; // fraction-of-view per axis-unit per ms
  zoomSens: number; // ln(zoom-factor) per axis-unit per ms
  orbitSens: number; // radians per axis-unit per ms
  staleMs: number; // no event for this long ⇒ motion treated as zero
  sensVersion?: number; // bump when sens semantics change (see loadConfig)
  // each camera action ← one raw axis (+ invert). All six axes map by default:
  // 3 translations (pan X/Y, zoom) + 3 rotations (yaw, pitch, roll). Ry — the
  // sideways tilt that used to be ignored — drives roll (its 3Dconnexion-
  // conventional action); every action is freely remappable in the settings UI.
  bind: Record<ActionName, AxisBinding>;
}

const DEFAULTS: SpaceMouseConfig = {
  mode: "object",
  deadzone: 24,
  panSens: 0.0000006,
  zoomSens: 0.0000007,
  orbitSens: 0.0000022,
  staleMs: 120,
  sensVersion: 2,
  bind: {
    panX: { src: "tx", invert: false },
    panY: { src: "tz", invert: false },
    zoom: { src: "ty", invert: false },
    orbitAz: { src: "rz", invert: true },
    orbitPolar: { src: "rx", invert: false },
    roll: { src: "ry", invert: false },
  },
};

// v1 (absolute world-units) defaults, used to migrate persisted configs while
// preserving the user's tuning RATIO relative to the old defaults
const V1_PAN_DEFAULT = 0.00006;
const V1_ZOOM_DEFAULT = 0.0001;

const KEY = "sindricad.spacemouse.config";
const LEGACY_MODE_KEY = "sindricad.spacemouse.mode";

function loadConfig(): SpaceMouseConfig {
  const cfg: SpaceMouseConfig = structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<SpaceMouseConfig>;
      const savedBind = saved.bind;
      Object.assign(cfg, saved);
      // migrate v1 (absolute world-unit) pan/zoom sens to the v2 proportional
      // semantics, keeping the user's multiplier relative to the old defaults
      if ((saved.sensVersion ?? 1) < 2) {
        if (typeof saved.panSens === "number") {
          cfg.panSens = (saved.panSens / V1_PAN_DEFAULT) * DEFAULTS.panSens;
        }
        if (typeof saved.zoomSens === "number") {
          cfg.zoomSens = (saved.zoomSens / V1_ZOOM_DEFAULT) * DEFAULTS.zoomSens;
        }
        cfg.sensVersion = 2;
      }
      // Rebuild bind from defaults and merge per-action with validation, so a
      // partial or stale-shaped persisted bind (older dev builds used different
      // action keys) can never leave an action unbound — which would crash the
      // settings UI and the motion loop reading `.src`/`.invert` of undefined.
      cfg.bind = structuredClone(DEFAULTS.bind);
      if (savedBind) {
        for (const a of Object.keys(DEFAULTS.bind) as ActionName[]) {
          const b = savedBind[a];
          if (b && AXIS_NAMES.includes(b.src)) cfg.bind[a] = { src: b.src, invert: !!b.invert };
        }
      }
    } else {
      const legacy = localStorage.getItem(LEGACY_MODE_KEY);
      if (legacy === "camera") cfg.mode = "camera";
    }
  } catch {
    /* ignore */
  }
  return cfg;
}

const CONFIG: SpaceMouseConfig = loadConfig();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(CONFIG));
  } catch {
    /* ignore */
  }
}

export function getSpaceMouseConfig(): SpaceMouseConfig {
  return CONFIG;
}

/** Merge a patch into the live config and persist (used by the settings UI and
 *  the devtools console: window.spaceMouseConfig({ orbitSens: 4e-6 })). */
export function setSpaceMouseConfig(patch: Partial<SpaceMouseConfig>) {
  // Pull `bind` out FIRST: a blanket Object.assign(CONFIG, patch) would replace
  // CONFIG.bind wholesale with the (usually single-action) partial, wiping every
  // other binding. Merge the rest, then merge bind per-action into the existing one.
  const { bind, ...rest } = patch;
  Object.assign(CONFIG, rest);
  if (bind) Object.assign(CONFIG.bind, bind);
  persist();
}

export function resetSpaceMouseConfig() {
  Object.assign(CONFIG, structuredClone(DEFAULTS));
  persist();
}

export function getSpaceMouseMode(): "object" | "camera" {
  return CONFIG.mode;
}

// Sketch "lock to plane": suppress orbit + roll (keep pan + zoom) so the puck
// can't tilt the view off the sketch plane.
let orbitLocked = false;
export function setSpaceMouseOrbitLocked(locked: boolean) {
  orbitLocked = locked;
}

export function setSpaceMouseMode(mode: "object" | "camera") {
  CONFIG.mode = mode;
  persist();
}

// --- live raw-motion stream (for the settings readout + test cube) ---
let latest: Motion = ZERO;
const motionListeners = new Set<(m: Motion) => void>();
export function getLatestMotion(): Motion {
  return latest;
}
export function onSpaceMouseMotion(fn: (m: Motion) => void): () => void {
  motionListeners.add(fn);
  return () => motionListeners.delete(fn);
}

export async function initSpaceMouse(
  viewport: Viewport,
  onButton: (pressedMask: number) => void,
): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return; // native desktop app only

  let motion: Motion = ZERO;
  let lastEvent = 0;
  let prevMask = 0;

  await listen<Motion>("spacemouse:motion", (e) => {
    motion = e.payload;
    latest = e.payload;
    lastEvent = performance.now();
    for (const fn of motionListeners) fn(e.payload);
  });
  await listen<{ mask: number }>("spacemouse:button", (e) => {
    const pressed = e.payload.mask & ~prevMask; // rising edge only
    prevMask = e.payload.mask;
    if (pressed) onButton(pressed);
  });

  const dz = (v: number) => (Math.abs(v) < CONFIG.deadzone ? 0 : v);
  /** signed, deadzoned value of the raw axis a binding points at (0 if unbound) */
  const val = (b: AxisBinding | undefined, m: Motion) =>
    b ? (b.invert ? -1 : 1) * dz(m[b.src]) : 0;
  let last = performance.now();

  const loop = () => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(50, now - last);
    last = now;

    // if the device stopped sending (missed the centering report), decay to zero
    const m = now - lastEvent > CONFIG.staleMs ? ZERO : motion;
    const controls = viewport.rig.controls;
    // object mode manipulates the model → inverse of camera mode on pan + orbit
    const modeSign = CONFIG.mode === "object" ? -1 : 1;
    const b = CONFIG.bind;

    const px = val(b.panX, m), py = val(b.panY, m);
    // zoom-proportional: scale pan by the visible view height and zoom
    // multiplicatively (via the same rig.zoomBy the wheel uses), so the puck
    // moves the view by the same FRACTION of the screen at any zoom level
    const scale = viewport.rig.viewScale();
    if (px || py) {
      controls.truck(
        modeSign * px * CONFIG.panSens * dt * scale,
        modeSign * py * CONFIG.panSens * dt * scale,
        false,
      );
    }
    const z = val(b.zoom, m); // direction is its own preference, not mode-dependent
    // exp(-z): positive axis kept as zoom-IN (old dolly(+z)); zoomBy(>1) = out
    if (z) viewport.rig.zoomBy(Math.exp(-z * CONFIG.zoomSens * dt));

    const az = val(b.orbitAz, m), pol = val(b.orbitPolar, m);
    if (!orbitLocked && (az || pol)) {
      // rig.tumble, NOT controls.rotate: camera-controls clamps vertical orbit
      // just short of the poles every frame, so rotate() hard-stops at the top.
      // tumble() rotates the orbit up-vector along with the camera — free
      // rotation over the poles, matching the 3Dconnexion driver feel.
      viewport.rig.tumble(modeSign * az * CONFIG.orbitSens * dt, modeSign * pol * CONFIG.orbitSens * dt);
    }

    const roll = val(b.roll, m);
    if (!orbitLocked && roll) viewport.rig.roll(modeSign * roll * CONFIG.orbitSens * dt);
  };
  requestAnimationFrame(loop);
}
