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
  const calls = { zoom: [] as number[], tumble: [] as [number, number][], truck: 0 };
  const rig = {
    controls: {
      truck: () => {
        calls.truck++;
      },
    },
    viewScale: () => 100,
    zoomBy: (f: number) => calls.zoom.push(f),
    tumble: (a: number, p: number) => calls.tumble.push([a, p]),
    roll: () => {},
  };
  const base = cbs.length;
  frame = null;
  // only `rig` is reached from the loop, so a real Viewport is not needed
  await initSpaceMouse({ rig } as unknown as Parameters<typeof initSpaceMouse>[0], () => {});
  const motionCb = cbs[base];
  if (!motionCb) throw new Error("initSpaceMouse never registered a motion listener");

  const drive = (m: Motion, frames: number) => {
    for (let i = 0; i < frames; i++) {
      motionCb({ payload: m });
      nowMs += 16;
      const f = frame!;
      frame = null;
      f();
    }
  };
  return { calls, drive };
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
