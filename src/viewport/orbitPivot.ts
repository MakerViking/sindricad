// Which point the view swings around when you orbit. GitHub #17 asked for the
// choice: "center on model origin, center of plane, or current cursor position".
//
// The decision itself is pure and lives here, deliberately apart from the rig
// that carries it out (cameras.ts) and the raycast that feeds it (viewport.ts):
// a Viewport needs a WebGL context to exist, so anything that has to be tested
// cannot live inside one.

import * as THREE from "three";

/** Closest a pivot may sit to the camera, in mm. Same figure as cameras.ts's
 *  MIN_PERSP_DIST but a different claim — that is a near-plane guard for the
 *  dolly, this is the floor below which an orbit basis stops being a basis — so
 *  it is stated here rather than shared, and cameras.ts must not import it back
 *  (this module is a leaf on purpose). */
const MIN_PIVOT_CAM_DIST = 0.5;

export type PivotMode = "view" | "model" | "origin" | "cursor";

/** Cycle order for the control-strip button. "view" is first because it is the
 *  default and the one people return to. */
export const PIVOT_MODES = ["view", "model", "origin", "cursor"] as const;

export const PIVOT_LABEL: Record<PivotMode, string> = {
  view: "View",
  model: "Model",
  origin: "Origin",
  cursor: "Cursor",
};

export const PIVOT_HINT: Record<PivotMode, string> = {
  // Named "View", not "Model centre", on purpose. This is what the app has
  // always done — orbit about whatever the view is centred on — and that starts
  // at the model centre only until you pan or zoom toward the cursor, both of
  // which move the orbit target. Calling it "Model" would be a promise the mode
  // does not keep; "Model" below is the mode that actually keeps it.
  view: "the centre of the view (default)",
  model: "the centre of the whole model",
  origin: "the world origin (0, 0, 0)",
  cursor: "the point under the cursor when the drag starts",
};

const KEY = "sindricad.orbitPivot";

export function nextPivotMode(mode: PivotMode): PivotMode {
  const i = PIVOT_MODES.indexOf(mode);
  return PIVOT_MODES[(i + 1) % PIVOT_MODES.length]!;
}

export function loadPivotMode(): PivotMode {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    // Validate rather than cast: a value left by an older build (or a hand-edited
    // one) would otherwise put the rig in a mode no branch handles, and the
    // symptom — orbit quietly doing nothing special — gives no hint why.
    if (raw && (PIVOT_MODES as readonly string[]).includes(raw)) return raw as PivotMode;
  } catch {
    /* ignore */
  }
  return "view";
}

export function savePivotMode(mode: PivotMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
}

export interface PivotInputs {
  /** The model surface point under the cursor, or null when the ray hit
   *  nothing. Empty space has no depth, so a miss is genuinely "no point". */
  cursor: THREE.Vector3 | null;
  /** Centre of the model's bounding box, or null for an empty document. */
  modelCentre: THREE.Vector3 | null;
  /** Where the camera is, so a pivot sitting on top of it can be refused. */
  camera: THREE.Vector3;
}

/** The world point to orbit about, or null for "leave the orbit point alone" —
 *  i.e. keep swinging around the view centre, exactly as the app always has.
 *
 *  Every failure lands on that null rather than on a guessed point. A pivot the
 *  user cannot see is worse than no pivot: the model lurches away from a centre
 *  that is nowhere on screen, and there is nothing to look at that explains it. */
export function resolvePivot(mode: PivotMode, inp: PivotInputs): THREE.Vector3 | null {
  const p = pivotPoint(mode, inp);
  if (!p) return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  // A pivot ON the camera has no orbit basis at all: the radius collapses to
  // zero, the view direction becomes undefined, and camera-controls decodes the
  // spherical state into a position that has nothing to do with where you were.
  if (p.distanceTo(inp.camera) < MIN_PIVOT_CAM_DIST) return null;
  return p;
}

function pivotPoint(mode: PivotMode, inp: PivotInputs): THREE.Vector3 | null {
  switch (mode) {
    case "view":
      return null;
    case "model":
      return inp.modelCentre;
    case "origin":
      return new THREE.Vector3(0, 0, 0);
    case "cursor":
      return inp.cursor;
  }
}

/** Fold a pivot's screen-space offset back into a plain camera/target pair.
 *
 *  `pos`/`target` are the pair camera-controls reports; `rendered` is where the
 *  offset actually put the camera. Moving BOTH endpoints by the difference is
 *  what makes the fold invisible: the camera lands exactly on `rendered`, and
 *  because only a translation was applied, the view direction and the orbit
 *  radius are untouched — so the next lookAt reproduces the same orientation.
 *  Shifting one endpoint alone would re-aim the camera, which is the whole
 *  thing the offset existed to avoid. */
export function foldPivot(
  pos: THREE.Vector3,
  target: THREE.Vector3,
  rendered: THREE.Vector3,
): { pos: THREE.Vector3; target: THREE.Vector3 } {
  const shift = rendered.clone().sub(pos);
  return { pos: pos.clone().add(shift), target: target.clone().add(shift) };
}

/** Add the pivot chooser to the viewport's control strip, next to the
 *  projection toggle it most resembles: one button that cycles and wears the
 *  state it is in. Returns null when there is no strip to mount into (a layout
 *  without one, or a harness), which is not an error — the feature is reachable
 *  only through this button, so its absence just means the default stays.
 *
 *  Built here rather than in index.html so the whole feature stays inside the
 *  viewport layer and nothing else has to know the mode exists. */
export function mountPivotButton(
  get: () => PivotMode,
  set: (mode: PivotMode) => void,
): HTMLButtonElement | null {
  const host = document.getElementById("viewcontrols");
  if (!host) return null;
  const btn = document.createElement("button");
  btn.id = "orbitpivot";
  const paint = () => {
    const mode = get();
    btn.textContent = `Pivot: ${PIVOT_LABEL[mode]}`;
    btn.title = `Orbit around ${PIVOT_HINT[mode]} — click to cycle`;
  };
  btn.addEventListener("click", () => {
    set(nextPivotMode(get()));
    paint();
  });
  paint();
  host.appendChild(btn);
  return btn;
}
