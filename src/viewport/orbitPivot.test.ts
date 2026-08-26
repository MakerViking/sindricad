// The orbit pivot's decision layer (GitHub #17). What is worth pinning down here
// is not that a mode returns a point — it is what happens when it CANNOT:
//
//   - "cursor" over empty space has no point to orbit,
//   - "model" in an empty document has no model,
//   - any mode can be handed a pivot sitting on the camera, which is not a
//     basis at all.
//
// All three have to land on the same answer — null, meaning "orbit the view
// centre, exactly as before" — because the alternative failure is silent and
// awful: the view swings around a centre that is nowhere on screen and nothing
// explains why.
//
// The feel of an orbit cannot be tested here (or anywhere headless). This
// covers the decision and the fold arithmetic, and stops there.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";
import {
  foldPivot,
  loadPivotMode,
  nextPivotMode,
  PIVOT_MODES,
  resolvePivot,
  savePivotMode,
  type PivotMode,
} from "./orbitPivot";
import { Viewport } from "./viewport";

const CAM = new THREE.Vector3(0, -100, 60);
const CURSOR = new THREE.Vector3(12, 4, 3);
const CENTRE = new THREE.Vector3(5, 5, 5);

function inputs(over: Partial<Parameters<typeof resolvePivot>[1]> = {}) {
  return { cursor: CURSOR, modelCentre: CENTRE, camera: CAM, ...over };
}

describe("resolvePivot", () => {
  it("leaves the orbit point alone in the default mode", () => {
    expect(resolvePivot("view", inputs())).toBeNull();
  });

  it("orbits the model centre in 'model'", () => {
    expect(resolvePivot("model", inputs())).toEqual(CENTRE);
  });

  it("orbits the world origin in 'origin'", () => {
    expect(resolvePivot("origin", inputs())).toEqual(new THREE.Vector3(0, 0, 0));
  });

  it("orbits the cursor hit in 'cursor'", () => {
    expect(resolvePivot("cursor", inputs())).toEqual(CURSOR);
  });

  it("falls back when the cursor ray hit nothing", () => {
    // empty space has no depth — there is no point under the cursor to orbit
    expect(resolvePivot("cursor", inputs({ cursor: null }))).toBeNull();
  });

  it("falls back when the document is empty", () => {
    expect(resolvePivot("model", inputs({ modelCentre: null }))).toBeNull();
  });

  it("refuses a pivot sitting on the camera", () => {
    // radius 0: the orbit basis collapses and the spherical state decodes to a
    // position with no relation to where the camera was.
    const onCamera = CAM.clone().add(new THREE.Vector3(0.1, 0, 0));
    expect(resolvePivot("cursor", inputs({ cursor: onCamera }))).toBeNull();
    // ...but a pivot merely CLOSE is fine, or you could never orbit a near face
    const nearby = CAM.clone().add(new THREE.Vector3(2, 0, 0));
    expect(resolvePivot("cursor", inputs({ cursor: nearby }))).toEqual(nearby);
  });

  it("refuses a non-finite pivot", () => {
    // a degenerate raycast/bbox can hand us a NaN; camera-controls would take it
    // and every later frame would decode NaN into a blank viewport
    const nan = new THREE.Vector3(NaN, 0, 0);
    expect(resolvePivot("cursor", inputs({ cursor: nan }))).toBeNull();
    expect(resolvePivot("model", inputs({ modelCentre: nan }))).toBeNull();
  });
});

describe("pivot mode cycling and persistence", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });

  it("cycles through every mode and comes back round", () => {
    let m: PivotMode = "view";
    const seen: PivotMode[] = [];
    for (let i = 0; i < PIVOT_MODES.length; i++) {
      seen.push(m);
      m = nextPivotMode(m);
    }
    expect(seen).toEqual([...PIVOT_MODES]);
    expect(m).toBe("view"); // wrapped
  });

  it("round-trips a saved mode", () => {
    savePivotMode("cursor");
    expect(loadPivotMode()).toBe("cursor");
  });

  it("defaults to 'view' with nothing saved", () => {
    expect(loadPivotMode()).toBe("view");
  });

  it("ignores a stored value that is not a mode", () => {
    // an older build's key, or a hand-edited one. Casting it through would put
    // the rig in a mode no branch handles, and orbit would just quietly stop
    // doing anything special.
    store.set("sindricad.orbitPivot", "centre-of-plane");
    expect(loadPivotMode()).toBe("view");
  });

  it("survives storage throwing", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadPivotMode()).toBe("view");
    expect(() => savePivotMode("origin")).not.toThrow();
  });
});

describe("foldPivot", () => {
  // The fold has to be INVISIBLE: after it the camera must render from exactly
  // where the pivot offset had put it, looking exactly the same way. Checked
  // against three.js's own lookAt rather than against the same arithmetic
  // restated — a camera built on the folded pair must match one placed at the
  // rendered point by hand.
  const pos = new THREE.Vector3(0, -100, 60);
  const target = new THREE.Vector3(5, 5, 5);
  const rendered = new THREE.Vector3(18, -94, 71); // where the offset put it

  it("lands the camera on the rendered position", () => {
    expect(foldPivot(pos, target, rendered).pos).toEqual(rendered);
  });

  it("keeps the view direction and the orbit radius", () => {
    const f = foldPivot(pos, target, rendered);
    const before = target.clone().sub(pos);
    const after = f.target.clone().sub(f.pos);
    expect(after.length()).toBeCloseTo(before.length(), 10);
    expect(after.clone().normalize().dot(before.clone().normalize())).toBeCloseTo(1, 12);
  });

  it("reproduces the same orientation through a real lookAt", () => {
    const up = new THREE.Vector3(0, 0, 1);
    const f = foldPivot(pos, target, rendered);
    // what camera-controls renders WITH the offset: oriented from the reported
    // pair, then translated onto `rendered`
    const offsetCam = new THREE.PerspectiveCamera();
    offsetCam.up.copy(up);
    offsetCam.position.copy(pos);
    offsetCam.lookAt(target);
    offsetCam.position.copy(rendered);
    offsetCam.updateMatrixWorld();
    // what it renders AFTER the fold: no offset, straight from the folded pair
    const foldedCam = new THREE.PerspectiveCamera();
    foldedCam.up.copy(up);
    foldedCam.position.copy(f.pos);
    foldedCam.lookAt(f.target);
    foldedCam.updateMatrixWorld();
    for (let i = 0; i < 16; i++) {
      expect(foldedCam.matrixWorld.elements[i]!).toBeCloseTo(
        offsetCam.matrixWorld.elements[i]!,
        10,
      );
    }
  });
});

// The gate in the Viewport: which drags get a pivot at all. Same stubbing trick
// as tiltOffAxis.test.ts — a real Viewport needs a WebGL context, so the method
// is run against a prototype with only the members it touches.
type PivotProbe = {
  pivotMode: PivotMode;
  rig: unknown;
  pressPos: { x: number; y: number };
  modelBox(): THREE.Box3 | null;
  surfacePointAt(x: number, y: number): THREE.Vector3 | null;
  applyOrbitPivot(): void;
};

function probe(mode: PivotMode, opts: { orbiting?: boolean; box?: THREE.Box3 | null } = {}) {
  const setOrbitPivot = vi.fn();
  const surfacePointAt = vi.fn(() => CURSOR.clone());
  const vp = Object.create(Viewport.prototype) as PivotProbe;
  vp.pivotMode = mode;
  vp.pressPos = { x: 300, y: 200 };
  vp.rig = {
    isOrbiting: () => opts.orbiting ?? true,
    setOrbitPivot,
    controls: { getPosition: (v: THREE.Vector3) => v.copy(CAM) },
  } as never;
  vp.modelBox = () =>
    opts.box === undefined
      ? new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 10))
      : opts.box;
  vp.surfacePointAt = surfacePointAt;
  return { vp, setOrbitPivot, surfacePointAt };
}

describe("Viewport.applyOrbitPivot", () => {
  it("does nothing at all in the default mode", () => {
    const { vp, setOrbitPivot, surfacePointAt } = probe("view");
    vp.applyOrbitPivot();
    expect(setOrbitPivot).not.toHaveBeenCalled();
    expect(surfacePointAt).not.toHaveBeenCalled();
  });

  it("skips a drag that is a pan, not an orbit", () => {
    // a truck has no pivot; setting one would leave a screen-space offset for
    // the rig to fold back out for nothing
    const { vp, setOrbitPivot } = probe("cursor", { orbiting: false });
    vp.applyOrbitPivot();
    expect(setOrbitPivot).not.toHaveBeenCalled();
  });

  it("picks from the press position, not from wherever the pointer is now", () => {
    const { vp, setOrbitPivot, surfacePointAt } = probe("cursor");
    vp.applyOrbitPivot();
    expect(surfacePointAt).toHaveBeenCalledWith(300, 200);
    expect(setOrbitPivot).toHaveBeenCalledWith(CURSOR);
  });

  it("does not pay for a raycast in a mode that never reads it", () => {
    const { vp, setOrbitPivot, surfacePointAt } = probe("origin");
    vp.applyOrbitPivot();
    expect(surfacePointAt).not.toHaveBeenCalled();
    expect(setOrbitPivot).toHaveBeenCalledWith(new THREE.Vector3(0, 0, 0));
  });

  it("uses the box centre, not its corner, for 'model'", () => {
    const { vp, setOrbitPivot } = probe("model");
    vp.applyOrbitPivot();
    expect(setOrbitPivot).toHaveBeenCalledWith(new THREE.Vector3(5, 5, 5));
  });

  it("leaves the orbit point alone when there is no model", () => {
    const { vp, setOrbitPivot } = probe("model", { box: null });
    vp.applyOrbitPivot();
    expect(setOrbitPivot).not.toHaveBeenCalled();
  });
});
