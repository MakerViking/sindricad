// GH #39, end to end through the REAL motion loop: 2 s of a hard tilt with a
// 30-count push/pull leak must not zoom, and a pure 30-count push/pull must.
//
// This drives initSpaceMouse itself rather than a rewritten model of it, because
// the bug is not in any single expression: it is that the loop reads each bound
// axis in isolation and applies zoom MULTIPLICATIVELY every frame, so a leak
// that clears the deadzone integrates into a visible zoom. Unfiltered, the tilt
// case called rig.zoomBy on 125 of 125 frames (net factor 0.9589, ~4% zoom-in).
//
// There is no jsdom in this suite (see vitest.config.ts), so the environment is
// hand-built: only window.__TAURI_INTERNALS__ is stubbed, which leaves the REAL
// @tauri-apps/api listen() running its real transport; performance.now and
// requestAnimationFrame are deterministic so a "frame" is exactly 16 ms.
import { describe, it, expect, beforeAll } from "vitest";
import type { Motion } from "./spacemouse";

type Handler = (e: { payload: unknown }) => void;
const cbs: Handler[] = [];
let nowMs = 1000;
let frame: null | (() => void) = null;

beforeAll(async () => {
  const store = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  (globalThis as unknown as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {
      transformCallback: (cb: Handler) => {
        cbs.push(cb);
        return cbs.length;
      },
      invoke: async () => 0,
    },
  };
  (globalThis as unknown as Record<string, unknown>).performance = { now: () => nowMs };
  (globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (fn: () => void) => {
    frame = fn;
    return 1;
  };
});

/** a fake viewport rig that records what the loop asked the camera to do */
async function harness() {
  const { initSpaceMouse } = await import("./spacemouse");
  const calls = { zoom: [] as number[], tumble: [] as [number, number][], truck: 0, roll: 0, driven: 0 };
  const rig = {
    controls: {
      truck: () => {
        calls.truck++;
      },
    },
    viewScale: () => 100,
    zoomBy: (f: number) => calls.zoom.push(f),
    tumble: (a: number, p: number) => calls.tumble.push([a, p]),
    roll: () => {
      calls.roll++;
    },
  };
  const base = cbs.length;
  frame = null;
  const buttons: number[] = [];
  // only `rig` and noteCameraDriven are reached from the loop, so a real
  // Viewport is not needed
  const viewport = {
    rig,
    noteCameraDriven: () => {
      calls.driven++;
    },
  };
  await initSpaceMouse(viewport as unknown as Parameters<typeof initSpaceMouse>[0], (mask) => buttons.push(mask));
  const motionCb = cbs[base];
  const buttonCb = cbs[base + 1];
  if (!motionCb || !buttonCb) throw new Error("initSpaceMouse never registered its motion and button listeners");

  const drive = (m: Motion, frames: number) => {
    for (let i = 0; i < frames; i++) {
      motionCb({ payload: m });
      nowMs += 16;
      const f = frame!;
      frame = null;
      f();
    }
  };
  /** frames with no motion event at all: the puck at rest, after its report */
  const idle = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      nowMs += 16;
      const f = frame!;
      frame = null;
      f();
    }
  };
  const press = (mask: number) => buttonCb({ payload: { mask } });
  return { calls, drive, idle, press, buttons };
}

const mot = (p: Partial<Motion>): Motion => ({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, ...p });

describe("SpaceMouse motion loop (GH #39)", () => {
  it("a 30-count push/pull leak during a 200-count tilt orbits without zooming", async () => {
    const h = await harness();
    h.drive(mot({ rx: 200, ty: 30 }), 125); // 2 s at 16 ms a frame
    expect(h.calls.zoom.length).toBe(0);
    expect(h.calls.tumble.length).toBe(125); // and the tilt the user meant still orbits
  });

  it("a 30-count push/pull on its own still zooms every frame", async () => {
    const h = await harness();
    h.drive(mot({ ty: 30 }), 125);
    expect(h.calls.zoom.length).toBe(125);
  });
});

// The loop drives the rig directly, and none of those calls is reported by
// camera-controls or the rig (loadFitGate.test.ts shows it), so a user
// navigating by puck alone never counted as having moved the camera: a load's
// owed Fit yanked them at the commit, and every window resize re-framed the
// model over their navigation. The loop tells the viewport itself, on exactly
// the frames that moved the camera.
describe("SpaceMouse navigation counts as the user moving the camera", () => {
  it("on every frame a bound axis moves the camera: pan, zoom, orbit and roll", async () => {
    for (const [what, m] of [
      ["pan", mot({ tx: 200 })],
      ["zoom", mot({ ty: 200 })],
      ["orbit", mot({ rx: 200 })],
      ["roll", mot({ ry: 200 })],
    ] as const) {
      const h = await harness();
      h.drive(m, 5);
      const moves = h.calls.truck + h.calls.zoom.length + h.calls.tumble.length + h.calls.roll;
      expect(moves, `the setup: a ${what} deflection did not move the camera`).toBe(5);
      expect(h.calls.driven, `a ${what} with the puck left the camera unclaimed`).toBe(5);
    }
  });

  it("but not on a frame that moved nothing: at rest, inside the deadzone, or orbit-locked", async () => {
    const { setSpaceMouseOrbitLocked } = await import("./spacemouse");
    const h = await harness();
    h.drive(mot({}), 5); // the centring report
    h.idle(20); // and no reports at all, which the loop decays to zero
    h.drive(mot({ tx: 10, rz: -12 }), 5); // under the 24-count deadzone
    setSpaceMouseOrbitLocked(true); // a sketch's lock to plane: orbit and roll are dropped
    try {
      h.drive(mot({ rx: 200, ry: 200 }), 5);
    } finally {
      setSpaceMouseOrbitLocked(false);
    }
    const moves = h.calls.truck + h.calls.zoom.length + h.calls.tumble.length + h.calls.roll;
    expect(moves, "the setup moved the camera").toBe(0);
    expect(h.calls.driven, "a frame that moved nothing claimed the camera").toBe(0);
  });

  it("nor on a button press, such as its Fit button", async () => {
    const h = await harness();
    h.press(1);
    h.press(0);
    h.idle(3);
    expect(h.buttons, "the setup: the press did not reach the button handler").toEqual([1]);
    expect(h.calls.driven, "a button press claimed the camera, so the load fit would never come").toBe(0);
  });
});
