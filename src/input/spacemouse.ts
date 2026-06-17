// 3D mouse (3Dconnexion SpaceMouse) support.
//
// The Tauri native side reads the device and streams 6DOF motion + button
// events (see src-tauri/src/spacemouse.rs). Here we map motion onto the camera
// (orbit / pan / zoom via camera-controls) and rising-edge button presses to an
// action callback. Browser/dev (no Tauri) is a no-op.
//
// The axis→action mapping, signs, and sensitivities are hardware-dependent —
// tune CONFIG below against the real device. `setSpaceMouseConfig()` lets you
// tweak it live from the devtools console while dialing it in.

import { listen } from "@tauri-apps/api/event";
import type { Viewport } from "../viewport/viewport";

interface Motion { tx: number; ty: number; tz: number; rx: number; ry: number; rz: number }
const ZERO: Motion = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

export interface SpaceMouseConfig {
  deadzone: number; // ignore |axis| below this (jitter)
  panSens: number; // world units per axis-unit per ms
  zoomSens: number;
  orbitSens: number; // radians per axis-unit per ms
  staleMs: number; // no event for this long ⇒ motion treated as zero
  invert: { panX: boolean; panY: boolean; zoom: boolean; orbitAz: boolean; orbitPolar: boolean };
}

const CONFIG: SpaceMouseConfig = {
  deadzone: 24,
  panSens: 0.00006,
  zoomSens: 0.0001,
  orbitSens: 0.0000022,
  staleMs: 120,
  invert: { panX: false, panY: false, zoom: false, orbitAz: false, orbitPolar: false },
};

/** Live-tune from the console: window.spaceMouseConfig({ orbitSens: 0.000004 }). */
export function setSpaceMouseConfig(patch: Partial<SpaceMouseConfig>) {
  Object.assign(CONFIG, patch);
  if (patch.invert) Object.assign(CONFIG.invert, patch.invert);
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
    lastEvent = performance.now();
  });
  await listen<{ mask: number }>("spacemouse:button", (e) => {
    const pressed = e.payload.mask & ~prevMask; // rising edge only
    prevMask = e.payload.mask;
    if (pressed) onButton(pressed);
  });

  const dz = (v: number) => (Math.abs(v) < CONFIG.deadzone ? 0 : v);
  const sgn = (b: boolean) => (b ? -1 : 1);
  let last = performance.now();

  const loop = () => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(50, now - last);
    last = now;

    // if the device stopped sending (missed the centering report), decay to zero
    const m = now - lastEvent > CONFIG.staleMs ? ZERO : motion;
    const controls = viewport.rig.controls;

    // pan: cap slide left/right (tx) + up/down (tz)
    const px = dz(m.tx), py = dz(m.tz);
    if (px || py) {
      controls.truck(
        sgn(CONFIG.invert.panX) * px * CONFIG.panSens * dt,
        sgn(CONFIG.invert.panY) * py * CONFIG.panSens * dt,
        false,
      );
    }
    // zoom: cap push/pull (ty)
    const z = dz(m.ty);
    if (z) controls.dolly(sgn(CONFIG.invert.zoom) * z * CONFIG.zoomSens * dt, false);

    // orbit: twist (rz) → azimuth, pitch (rx) → polar
    const az = dz(m.rz), pol = dz(m.rx);
    if (az || pol) {
      controls.rotate(
        sgn(CONFIG.invert.orbitAz) * az * CONFIG.orbitSens * dt,
        sgn(CONFIG.invert.orbitPolar) * pol * CONFIG.orbitSens * dt,
        false,
      );
    }
  };
  requestAnimationFrame(loop);
}
