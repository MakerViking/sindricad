import "./styles.css";
import { Viewport } from "./viewport/viewport";
import type { StandardView } from "./viewport/cameras";
import { Geometry } from "./geometry/client";
import { TauriGeometry } from "./geometry/tauriClient";
import { DocumentStore } from "./document/store";
import { EXAMPLE_BRACKET } from "./document/example";
import { Timeline } from "./ui/timeline";
import { BrowserTree } from "./ui/browserTree";
import { Inspector } from "./ui/inspector";
import { Ribbon } from "./ui/ribbon";
import { CommandPalette } from "./ui/commandPalette";
import { SketchPalette } from "./ui/sketchPalette";
import { installKeymap } from "./input/keymap";
import { initSpaceMouse, setSpaceMouseConfig, getSpaceMouseMode, setSpaceMouseMode } from "./input/spacemouse";
import { SpaceMouseSettings } from "./ui/spaceMouseSettings";
import { saveDocument, saveDocumentAs, openDocument, exportModel, importModel } from "./io/files";
import { Menubar } from "./ui/menu";
import { contextMenu } from "./ui/menu";
import { choose } from "./ui/choice";
import { SketchOverlay } from "./sketch/overlay";
import { SketchMode, type SketchTool } from "./sketch/sketchMode";
import { SketchPlane } from "./sketch/plane";
import { solveSketch, initSolver } from "./sketch/solver";
import { ExtrudeTool } from "./features/extrudeTool";
import { EdgeFeatureTool } from "./features/edgeFeatureTool";
import { PressPullTool } from "./features/pressPullTool";
import { MoveTool } from "./features/moveTool";
import { MeasureTool } from "./features/measureTool";
import { SectionTool } from "./features/sectionTool";
import { PlaneOffsetTool } from "./features/planeOffsetTool";
import { setPrompt } from "./ui/prompt";
import { getUnit, setUnit, toDisplay, round, type Unit } from "./ui/units";
import type { Feature, PlaneDef, PlaneSpec, Selector } from "./types";

// --- core singletons ---
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const contextTab = document.getElementById("context-tab")!;

const viewport = new Viewport(canvas);

const geometry = import.meta.env.VITE_GEOM === "rust" ? new TauriGeometry() : new Geometry();
const store = new DocumentStore(geometry, EXAMPLE_BRACKET);

const overlay = new SketchOverlay();
viewport.addToScene(overlay.group);
const sketch = new SketchMode(viewport, overlay);
const extrude = new ExtrudeTool(viewport, overlay, store);
const edgeFeature = new EdgeFeatureTool(viewport, store);
const pressPull = new PressPullTool(viewport, store);
const moveTool = new MoveTool(viewport, store);
const measure = new MeasureTool(viewport);
const section = new SectionTool(viewport);
const planeOffset = new PlaneOffsetTool(viewport);

(window as any).viewport = viewport;
(window as any).store = store;
(window as any).geometry = geometry;
(window as any).sketch = sketch;
(window as any).overlay = overlay;
(window as any).extrude = extrude;
(window as any).edgeFeature = edgeFeature;
(window as any).pressPull = pressPull;
(window as any).solveSketch = solveSketch;
void initSolver(); // warm up the constraint solver WASM

// --- 3D mouse (SpaceMouse): navigate the camera + map buttons (desktop app) ---
(window as any).spaceMouseConfig = setSpaceMouseConfig; // live-tune from devtools
void initSpaceMouse(viewport, (pressed) => {
  if (pressed & 1) viewport.fitView(); // button 1 → Fit
  else if (pressed & 2) viewport.setStandardView("iso"); // button 2 → Home/ISO
});

// --- UI ---
const ribbon = new Ribbon(document.getElementById("ribbon")!);
ribbon.onAction = handleAction;

// Cmd/Ctrl-K command palette — search + run any command (discoverability safety net)
const cmdk = new CommandPalette(handleAction);
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    cmdk.toggle(sketch.active ? "sketch" : "model");
  }
});
const palette = new SketchPalette(document.getElementById("palette")!);
const timeline = new Timeline(document.getElementById("timeline")!, store);
const tree = new BrowserTree(document.getElementById("browser")!, store);
const inspector = new Inspector(document.getElementById("inspector")!, store);

// --- File menu + document-name titlebar ---
async function newDocument() {
  // window.confirm is a no-op in Tauri's WebKitGTK webview — use the native dialog.
  if (store.dirty) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask("Discard unsaved changes and start a new document?", {
      title: "New Document",
      kind: "warning",
    });
    if (!ok) return;
  }
  if (sketch.active) sketch.cancel();
  store.newDocument();
}
const spaceMouseSettings = new SpaceMouseSettings();
new Menubar(document.getElementById("menubar")!, [
  {
    label: "File",
    items: [
      { label: "New", shortcut: "Ctrl+N", onClick: () => void newDocument() },
      { label: "Open…", shortcut: "Ctrl+O", onClick: () => void openDocument(store, geometry) },
      { separator: true, label: "" },
      { label: "Import Mesh…", onClick: () => void importModel(store, geometry) },
      { separator: true, label: "" },
      { label: "Save", shortcut: "Ctrl+S", onClick: () => void saveDocument(store) },
      { label: "Save As…", shortcut: "Ctrl+Shift+S", onClick: () => void saveDocumentAs(store) },
      { separator: true, label: "" },
      { label: "Export…", shortcut: "Ctrl+E", onClick: () => void exportModel(store, geometry) },
    ],
  },
  {
    label: "View",
    items: [
      { label: "SpaceMouse: Move Object", checked: () => getSpaceMouseMode() === "object", onClick: () => setSpaceMouseMode("object") },
      { label: "SpaceMouse: Move Camera", checked: () => getSpaceMouseMode() === "camera", onClick: () => setSpaceMouseMode("camera") },
      { separator: true, label: "" },
      { label: "3D Mouse Settings…", onClick: () => spaceMouseSettings.open() },
    ],
  },
]);

const docnameEl = document.getElementById("docname")!;
store.onMeta(() => {
  docnameEl.textContent = (store.dirty ? "● " : "") + store.fileName;
  docnameEl.classList.toggle("dirty", store.dirty);
});

let selectedFeature: string | null = null;
function selectFeature(id: string | null) {
  selectedFeature = id;
  timeline.select(id);
  tree.select(id);
  inspector.select(id);
  viewport.highlightDatum(id); // brighten the matching construction plane (if any)
}
timeline.onSelect = selectFeature;
timeline.onEdit = (id) => editFeature(id);
tree.onSelect = selectFeature;
// clicking a construction plane in the viewport selects it (so it can be cut by)
viewport.onPickDatum = (id) => selectFeature(id);

// right-click a model face → context menu. Uses face raycasting (not the
// edge-priority picker), so it reliably targets thin faces like an inner ledge.
canvas.addEventListener("contextmenu", (e) => {
  if (toolBusy()) return;
  if (viewport.cubeHitsRegion(e.clientX, e.clientY)) return; // ViewCube owns its corner
  // right-click a construction plane → cut all visible bodies by it
  const datumId = viewport.pickDatumAt(e.clientX, e.clientY);
  if (datumId) {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: "Cut all bodies", onClick: () => void startCutByPlane(datumId) },
    ]);
    return;
  }
  const face = viewport.pickFacePlane(e.clientX, e.clientY);
  if (!face) return; // not over a face — leave the browser default
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: "Offset plane from face", onClick: () => offsetPlaneFromFace(face) },
    { label: "Sketch on this face", onClick: () => { if (!toolBusy()) sketch.enter(face, store); } },
  ]);
});
tree.onEditSketch = (id) => editFeature(id);
tree.onSketchOnPlane = (plane) => {
  if (!sketch.active && !extrude.active && !edgeFeature.active && !pressPull.active && !planeOffset.active) sketch.enter(plane, store);
};

// --- sketch visibility (Fusion-style: a sketch consumed by a feature hides by
// default so the solid's edges stay clear; toggle from the browser tree). The
// explicit overrides live in the store so they persist with the .sindri file. ---
function isSketchConsumed(id: string): boolean {
  return store.document.features.some(
    (f) =>
      (f.type === "extrude" && f.sketch === id) ||
      (f.type === "revolve" && f.sketch === id) ||
      (f.type === "sweep" && (f.profile === id || f.path === id)) ||
      (f.type === "loft" && f.sketches.includes(id)),
  );
}
function isSketchVisible(id: string): boolean {
  return store.sketchVisibilityOverride(id) ?? !isSketchConsumed(id);
}
overlay.sketchVisible = isSketchVisible;
tree.isSketchVisible = isSketchVisible;
tree.onToggleSketch = (id) => {
  store.setSketchVisibility(id, !isSketchVisible(id));
  if (!sketch.active) overlay.update(store.document);
  tree.refresh();
};

// per-body show/hide (Fusion-style eye toggle); re-renders without a sidecar rebuild
tree.isBodyVisible = (id) => store.isBodyVisible(id);
tree.onToggleBody = (id) => {
  store.setBodyVisibility(id, !store.isBodyVisible(id));
  tree.refresh();
};

// body multi-selection (Bodies select mode) — viewport ↔ tree kept in sync
tree.isBodySelected = (id) => viewport.getSelectedBodies().includes(id);
tree.onSelectBody = (id, additive) => {
  const cur = new Set(viewport.getSelectedBodies());
  if (additive) cur.has(id) ? cur.delete(id) : cur.add(id);
  else { cur.clear(); cur.add(id); }
  viewport.setSelectedBodies([...cur]);
};
tree.onCutPlane = (id) => void startCutByPlane(id);
// rename / delete from the browser tree. Sketches & planes are features → patch
// or remove them; body names are display-only overrides; deleting a body appends
// a removeBody feature (see store). All paths re-emit and re-render the tree.
tree.onRenameSketch = (id, name) => store.updateFeature(id, { name } as Partial<Feature>);
tree.onDeleteSketch = (id) => store.removeFeature(id);
tree.onRenamePlane = (id, name) => store.updateFeature(id, { name } as Partial<Feature>);
tree.onDeletePlane = (id) => store.removeFeature(id);
tree.onRenameBody = (id, name) => store.setBodyName(id, name);
tree.onDeleteBody = (id) => store.removeBody(id);
viewport.onBodySelectionChange = () => {
  tree.refresh();
  if (toolBusy()) return;
  const n = viewport.getSelectedBodies().length;
  setPrompt(n ? `${n} bod${n > 1 ? "ies" : "y"} selected — Move (M) to drag · Esc to clear` : null);
};
// Esc clears the body selection while in Bodies mode
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && viewport.selecting === "bodies" && !toolBusy() && viewport.getSelectedBodies().length) {
    viewport.setSelectedBodies([]);
  }
});

// --- sketch overlays follow the document (when not actively sketching) ---
store.onDocChange(() => {
  if (!sketch.active) overlay.update(store.document);
});

// --- selected-edge hint: tells you pre-selection is usable by Fillet/Chamfer ---
viewport.onSelectionChange = () => {
  if (toolBusy()) return;
  const n = viewport.selectedEdgeSelectors().length;
  setPrompt(n ? `${n} edge${n > 1 ? "s" : ""} selected — Fillet or Chamfer to apply · Esc to clear` : null);
};

// --- rebuild pipeline -> viewport ---
let firstModel = true;
store.onBuild((s) => {
  if (s.result) {
    if (s.result.mesh.positions.length > 0) {
      // hide the faces AND wireframe of any body the user toggled off (filtered
      // in the render, no sidecar rebuild — setBodyVisibility re-emits the build).
      const hidden = (s.result.bodies ?? [])
        .filter((b) => !store.isBodyVisible(b.id))
        .map((b) => b.id);
      viewport.setModel(s.result, firstModel, hidden);
      firstModel = false;
    } else {
      viewport.clearModel();
    }
  }
  syncDatumPlanes();
  if (s.errorMessage) {
    setStatus(`⚠ ${s.errorFeatureId ?? ""}: ${s.errorMessage}`, "error");
  } else if (!s.building) {
    setStatus("ready", "connected");
  }
});

// reflect the document's datum/construction planes as selectable quads in 3D.
// Resolved client-side (source plane + offset along its normal) so no rebuild is
// needed just to move/show a plane.
function syncDatumPlanes() {
  const planes = store.document.features
    .filter((f): f is Extract<Feature, { type: "datumPlane" }> => f.type === "datumPlane")
    .map((f) => {
      const sp = new SketchPlane(f.plane);
      const off = f.offset ?? 0;
      return {
        id: f.id,
        origin: [
          sp.origin.x + sp.n.x * off,
          sp.origin.y + sp.n.y * off,
          sp.origin.z + sp.n.z * off,
        ] as [number, number, number],
        normal: [sp.n.x, sp.n.y, sp.n.z] as [number, number, number],
      };
    });
  viewport.setDatumPlanes(planes);
  viewport.highlightDatum(selectedFeature);
}

geometry.onStatus((connected) => {
  if (!connected) setStatus("connecting to sidecar…", "error");
  else void store.rebuildNow();
});

const SKETCH_PROMPTS: Record<string, string> = {
  select: "Pick a tool: Line (L) · Rectangle (R) · Circle (C) · Arc (A) · Trim (T)",
  line: "Line: click points · type length + Tab + angle · Enter to commit · click the start to close · Esc",
  rectangle: "Rectangle: click two corners · type W, Tab, H · Enter · Esc",
  circle: "Circle: click center, then radius · type ⌀ · Enter · Esc",
  arc: "Arc: click start, click end, then click a point it passes through · Esc",
  spline: "Spline: click to place fit points · click the last point or press Enter to finish · Esc to cancel",
  point: "Point: click to place a reference point (snaps + constrains) · Esc",
  polygon: "Polygon: click the center, then a vertex (6-sided, inscribed) · Esc",
  slot: "Slot: click the two arc centers, then a point for the width · Esc",
  circle2: "Circle (2-point): click two points on the diameter · Esc",
  circle3: "Circle (3-point): click three points the circle passes through · Esc",
  centerRectangle: "Center Rectangle: click the center, then a corner · Esc",
  mirror: "Mirror: with entities selected, click a line to mirror across · Esc",
  dimension: "Dimension: click a line (length) or circle (⌀), type a value + Enter · Esc",
  trim: "Trim: click a curve to remove it (trimmed to nearest crossings) · Esc",
  fillet: "Fillet: click two lines, then type a radius + Enter · Esc",
  offset: "Offset: click a curve, then type an offset distance + Enter · Esc",
  extend: "Extend: click a line near the end to lengthen to the nearest crossing · Esc",
  break: "Break: click a line where you want to split it · Esc",
  horizontal: "Horizontal: click a line to make it horizontal · Esc",
  vertical: "Vertical: click a line to make it vertical · Esc",
  parallel: "Parallel: click two lines to make the 2nd parallel to the 1st · Esc",
  perpendicular: "Perpendicular: click two lines · Esc",
  equal: "Equal: click two lines to make the 2nd the same length as the 1st · Esc",
  tangent: "Tangent: click a line and a circle to make them tangent · Esc",
  coincident: "Coincident: click two endpoints to make them coincide · Esc",
  concentric: "Concentric: click two circles to share a center · Esc",
  midpoint: "Midpoint: click a point/endpoint, then a line — the point sits at its midpoint · Esc",
  symmetric: "Symmetric: click two endpoints, then the symmetry axis line · Esc",
};

// --- sketch mode state -> UI (ribbon context, palette, prompt) ---
let sketchWasActive = false;
sketch.onState = () => {
  if (sketch.active && !sketchWasActive) palette.emitAll(); // apply palette opts
  sketchWasActive = sketch.active;
  ribbon.setContext(sketch.active ? "sketch" : "model");
  ribbon.setActiveSketchTool(sketch.tool);
  palette.setVisible(sketch.active);
  contextTab.textContent = sketch.active ? "SKETCH" : "SOLID";
  contextTab.classList.toggle("sketch", sketch.active);
  if (sketch.active) {
    setPrompt(SKETCH_PROMPTS[sketch.tool] ?? null);
  } else {
    setPrompt(null);
  }
};

// --- sketch palette toggles -> sketch/overlay ---
palette.onToggle = (key, value) => {
  switch (key) {
    case "lockView": sketch.setViewLocked(value); break;
    case "construction": sketch.setConstruction(value); break;
    case "grid": sketch.setGridVisible(value); break;
    case "snap": sketch.setGridSnap(value); break;
    case "profile": overlay.setFillsVisible(value); break;
    case "dimensions": sketch.setDimensionsVisible(value); break;
  }
};
palette.onLookAt = () => sketch.lookAt();

// --- view controls (all routed through handleAction so the command palette,
// keymap and buttons share one dispatch) ---
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => handleAction(btn.dataset.view as string));
});
document.getElementById("fit")!.addEventListener("click", () => handleAction("fit"));

// Faces / Bodies selection-filter toggle (Bodies mode = click whole bodies to move)
const selBtn = document.getElementById("selmode") as HTMLButtonElement;
selBtn.addEventListener("click", () => handleAction("selmode"));

// unit selector (display/input only; geometry stays in mm)
const unitSel = document.getElementById("unit") as HTMLSelectElement;
unitSel.value = getUnit();
unitSel.addEventListener("change", () => setUnit(unitSel.value as Unit));
const projBtn = document.getElementById("proj") as HTMLButtonElement;
projBtn.addEventListener("click", () => handleAction("persp"));

// --- interactive plane pick (base plane quad or a planar body face) ---
let planePick = false;

// Interactive Fillet / Chamfer: pick an edge (or use a Ctrl-click pre-selection),
// then drag an arrow to scrub the radius/distance with a live sidecar preview.
const startFillet = () => edgeFeature.start("fillet", (id) => id && selectFeature(id));
const startChamfer = () => edgeFeature.start("chamfer", (id) => id && selectFeature(id));
// Interactive Press/Pull: pick a solid face, then drag an arrow along its normal
// to add/cut material (planar) or offset a curved face — with a live preview.
const startPressPull = () => {
  if (sketch.active || extrude.active || edgeFeature.active || pressPull.active || planeOffset.active) return;
  pressPull.start((id) => id && selectFeature(id));
};
function pickPlaneInteractive(promptText: string, onPick: (spec: PlaneSpec) => void) {
  if (toolBusy()) return;
  planePick = true;
  viewport.showAllPlanes(true);
  viewport.suspendPicking = true;
  setPrompt(promptText);
  const onMove = (e: PointerEvent) => {
    // a face of the body takes priority over the base-plane quads behind it;
    // highlight whichever the click would select so the target is obvious.
    const face = viewport.pickFacePlane(e.clientX, e.clientY);
    if (face) {
      viewport.hoverFaceAt(e.clientX, e.clientY); // highlight a selectable body face
      viewport.hoverPlane(null);
    } else {
      viewport.clearHover();
      viewport.hoverPlane(viewport.pickPlane(e.clientX, e.clientY));
    }
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // a face of the body takes priority over the base-plane quads behind it
    const spec = viewport.pickFacePlane(e.clientX, e.clientY) ?? viewport.pickPlane(e.clientX, e.clientY);
    if (!spec) return;
    // consume this click fully and run on the NEXT frame, so it can't bleed
    // into the sketch's own first-corner placement.
    e.preventDefault();
    e.stopImmediatePropagation();
    cleanup();
    requestAnimationFrame(() => onPick(spec));
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup();
  };
  const cleanup = () => {
    planePick = false;
    viewport.showAllPlanes(false);
    viewport.suspendPicking = false;
    viewport.clearHover();
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onEsc, true);
    setPrompt(null);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onEsc, true);
}

function startSketch(tool?: SketchTool) {
  pickPlaneInteractive("Select a plane or a planar face of a body to sketch on", (spec) => {
    sketch.enter(spec, store);
    if (tool) sketch.setTool(tool);
  });
}

// Offset Plane: pick a plane/face, then drag an arrow (or type) to set the offset,
// with a live ghost of the resulting plane; commit sketches on the offset plane.
function offsetPlane() {
  pickPlaneInteractive("Select a plane or face to offset from", (spec) => {
    planeOffset.start(new SketchPlane(spec), (def) => {
      if (def) sketch.enter(def, store);
    });
  });
}

// Datum Plane: pick a plane/face, position it (offset), then save a persistent
// datum plane feature — it lands in the timeline + Planes folder and can be
// reused as a sketch / split reference. We store the SOURCE plane + a scalar
// offset (not a baked plane) so the offset stays editable in the inspector.
function createDatumPlane() {
  pickPlaneInteractive("Select a plane or face for the datum plane", (spec) => {
    const src = new SketchPlane(spec);
    planeOffset.start(src, (def) => {
      if (!def) return;
      const id = store.nextId();
      store.addFeature({ id, type: "datumPlane", plane: spec, offset: offsetAlong(def, src) } as Feature);
      selectFeature(id);
    });
  });
}

// Right-click → "Offset plane from face": same as Datum Plane but the source is
// the right-clicked face (no separate pick step).
function offsetPlaneFromFace(face: PlaneDef) {
  if (toolBusy()) return;
  const src = new SketchPlane(face);
  planeOffset.start(src, (def) => {
    if (!def) return;
    const id = store.nextId();
    store.addFeature({ id, type: "datumPlane", plane: face, offset: offsetAlong(def, src) } as Feature);
    selectFeature(id);
  });
}

// signed distance of an offset-tool result from its source plane, along the
// source normal (mm) — the editable `offset` we store on the datum.
function offsetAlong(def: PlaneDef, src: SketchPlane): number {
  return (
    (def.origin[0] - src.origin.x) * src.n.x +
    (def.origin[1] - src.origin.y) * src.n.y +
    (def.origin[2] - src.origin.z) * src.n.z
  );
}

// Split Body: choose which side(s) to keep, then pick + position a cutting plane.
// Reuses the plane picker + offset gizmo so the cut lands exactly where you want.
async function startSplit() {
  if (toolBusy()) return;
  if (!hasBody()) {
    setStatus("Split: create or import a body first", "");
    return;
  }
  // "select that plane and cut": a selected construction plane cuts ALL visible
  // bodies by id (startCutByPlane handles the keep-side prompt).
  const sel = selectedFeature ? store.document.features.find((f) => f.id === selectedFeature) : null;
  if (sel?.type === "datumPlane") return void startCutByPlane(sel.id);

  const keep = await choose<"both" | "top" | "bottom">("Split Body — keep which side?", [
    { value: "both", label: "Both", hint: "two bodies" },
    { value: "top", label: "Top", hint: "+normal side" },
    { value: "bottom", label: "Bottom", hint: "−normal side" },
  ]);
  if (!keep) return;
  const bodies = store.buildState.result?.bodies ?? [];
  let body: string | undefined;
  if (bodies.length > 1) {
    const picked = await chooseBody("Which body to split?", bodies);
    if (!picked) return;
    body = picked;
  }
  pickPlaneInteractive("Select a plane or face to cut by", (spec) => {
    planeOffset.start(new SketchPlane(spec), (def) => {
      if (def) store.addFeature({ id: store.nextId(), type: "split", plane: def, keep, body } as Feature);
    });
  });
}

// Cut ALL visible bodies by a construction plane (right-click a plane → Cut, or
// select a plane + Split Body). Reuses the split feature with `planeId` + the list
// of currently-visible body ids.
async function startCutByPlane(planeId: string) {
  if (toolBusy()) return;
  if (!hasBody()) {
    setStatus("Cut: create or import a body first", "");
    return;
  }
  const keep = await choose<"both" | "top" | "bottom">("Cut — keep which side?", [
    { value: "both", label: "Both", hint: "two bodies" },
    { value: "top", label: "Top", hint: "+normal side" },
    { value: "bottom", label: "Bottom", hint: "−normal side" },
  ]);
  if (!keep) return;
  const ids = (store.buildState.result?.bodies ?? [])
    .filter((b) => store.isBodyVisible(b.id))
    .map((b) => b.id);
  store.addFeature({ id: store.nextId(), type: "split", planeId, keep, bodies: ids } as Feature);
}

// Combine: boolean-join/cut/intersect bodies. With exactly two bodies the first
// is the (kept) target and the second the tool; with more, you pick the target
// and the tool body so cut/intersect direction is unambiguous.
async function startCombine() {
  if (toolBusy()) return;
  const bodies = store.buildState.result?.bodies ?? [];
  if (bodies.length < 2) {
    setStatus("Combine: needs at least two bodies — model or import another", "");
    return;
  }
  const op = await choose<"join" | "cut" | "intersect">("Combine bodies", [
    { value: "join", label: "Join", hint: "union" },
    { value: "cut", label: "Cut", hint: "subtract" },
    { value: "intersect", label: "Intersect", hint: "overlap" },
  ]);
  if (!op) return;
  let target = bodies[0].id;
  if (bodies.length > 2) {
    const t = await chooseBody("Target body (kept)", bodies);
    if (!t) return;
    target = t;
  }
  const candidates = bodies.filter((b) => b.id !== target);
  let tools = candidates.map((b) => b.id);
  if (candidates.length > 1) {
    const tool = await chooseBody("Tool body (combined into the target)", candidates);
    if (!tool) return;
    tools = [tool];
  }
  store.addFeature({ id: store.nextId(), type: "combine", operation: op, target, tools } as Feature);
}

/** Pick one body by name from the rebuild's body list (returns its id). */
function chooseBody(title: string, bodies: { id: string; name: string }[]): Promise<string | null> {
  return choose<string>(title, bodies.map((b) => ({ value: b.id, label: b.name })));
}

// Simplify Mesh: merge near-coplanar facets of the active (imported) body into
// fewer, larger faces. Tune the angular tolerance in the inspector (higher =
// fewer faces, but coarsens curved regions).
function startSimplifyMesh() {
  if (toolBusy()) return;
  if (!hasBody()) {
    setStatus("Simplify Mesh: import or create a body first", "");
    return;
  }
  store.addFeature({ id: store.nextId(), type: "simplifyMesh", tolerance: 1 } as Feature);
}

// Scale: resize the active body about the origin (handy for fixing the units of
// an import). Default factor 1 — set it in the inspector.
function startScale() {
  if (toolBusy()) return;
  if (!hasBody()) {
    setStatus("Scale: create or import a body first", "");
    return;
  }
  store.addFeature({ id: store.nextId(), type: "scale", factor: 1 } as Feature);
}

// Move: translate / rotate the active body. Defaults to no-op — set the offsets
// and angles in the inspector.
function startMove() {
  if (toolBusy()) return;
  if (!hasBody()) {
    setStatus("Move: create or import a body first", "");
    return;
  }
  const bodies = store.buildState.result?.bodies ?? [];
  let ids = viewport.getSelectedBodies();
  if (!ids.length && bodies.length) ids = [bodies[bodies.length - 1].id]; // none selected → active body
  if (!ids.length) {
    setStatus("Move: select a body first (Select: Bodies)", "");
    return;
  }
  moveTool.start(ids, (id) => id && selectFeature(id));
}

// --- Inspect: Properties readout (volume / area / mass / center / bbox) ---
let propsPanel: HTMLDivElement | null = null;
let propsEsc: ((e: KeyboardEvent) => void) | null = null;
function closeProperties() {
  propsPanel?.remove();
  propsPanel = null;
  if (propsEsc) {
    window.removeEventListener("keydown", propsEsc, true);
    propsEsc = null;
  }
}
function showProperties() {
  if (!hasBody()) {
    setStatus("Properties: create or import a body first", "");
    return;
  }
  const sel = viewport.getSelectedBodies();
  const p = viewport.bodyProperties(sel.length ? sel : null);
  if (!p) return;
  closeProperties();
  const unit = getUnit();
  const f = toDisplay(1);
  const cm3 = p.volume / 1000; // mm³ → cm³ (mass at 1 g/cm³ baseline)
  const title = sel.length === 1 ? p.names[0] : sel.length ? `${sel.length} bodies` : "All bodies";
  const rows: [string, string][] = [
    ["Volume", `${round(p.volume * f * f * f)} ${unit}³`],
    ["Surface area", `${round(p.area * f * f)} ${unit}²`],
    ["Mass (≈1 g/cm³)", `${round(cm3)} g`],
    ["Center of mass", `${round(toDisplay(p.com.x))}, ${round(toDisplay(p.com.y))}, ${round(toDisplay(p.com.z))}`],
    [
      "Bounding box",
      `${round(toDisplay(p.bbox.max.x - p.bbox.min.x))} × ${round(toDisplay(p.bbox.max.y - p.bbox.min.y))} × ${round(toDisplay(p.bbox.max.z - p.bbox.min.z))} ${unit}`,
    ],
  ];
  const el = document.createElement("div");
  el.className = "measure-panel";
  el.innerHTML =
    `<div class="measure-title">Properties — ${title}</div>` +
    rows
      .map(([k, v]) => `<div class="measure-row"><span class="measure-k">${k}</span><span class="measure-v">${v}</span></div>`)
      .join("") +
    `<div class="measure-hint">Select a body for its own properties · Esc to close</div>`;
  document.body.appendChild(el);
  propsPanel = el;
  propsEsc = (e) => {
    if (e.key === "Escape") closeProperties();
  };
  window.addEventListener("keydown", propsEsc, true);
}

let clashPanel: HTMLDivElement | null = null;
let clashEsc: ((e: KeyboardEvent) => void) | null = null;
function closeInterference() {
  clashPanel?.remove();
  clashPanel = null;
  if (clashEsc) {
    window.removeEventListener("keydown", clashEsc, true);
    clashEsc = null;
  }
}
async function showInterference() {
  if (!hasBody()) {
    setStatus("Interference: create or import a body first", "");
    return;
  }
  if ((store.buildState.result?.bodies?.length ?? 0) < 2) {
    setStatus("Interference: needs at least two bodies", "");
    return;
  }
  setStatus("Checking interference…", "");
  const res = await geometry.interference(store.document);
  if (!res.ok) {
    setStatus(`Interference check failed: ${res.message ?? "error"}`, "error");
    return;
  }
  const pairs = res.pairs ?? [];
  setStatus(
    pairs.length ? `${pairs.length} interference${pairs.length > 1 ? "s" : ""} found` : "No interferences found",
    pairs.length ? "error" : "connected",
  );
  closeInterference();
  const unit = getUnit();
  const f = toDisplay(1);
  const el = document.createElement("div");
  el.className = "measure-panel";
  if (!pairs.length) {
    el.innerHTML =
      `<div class="measure-title">Interference</div>` +
      `<div class="measure-row"><span class="measure-v">No overlapping bodies</span></div>` +
      `<div class="measure-hint">Esc to close</div>`;
  } else {
    el.innerHTML =
      `<div class="measure-title">Interference — ${pairs.length} clash${pairs.length > 1 ? "es" : ""}</div>` +
      pairs
        .map(
          (p, i) =>
            `<div class="measure-row clash-row" data-i="${i}"><span class="measure-k">${p.aName} ∩ ${p.bName}</span><span class="measure-v">${round(p.volume * f * f * f)} ${unit}³</span></div>`,
        )
        .join("") +
      `<div class="measure-hint">Click a clash to highlight the bodies · Esc to close</div>`;
  }
  document.body.appendChild(el);
  clashPanel = el;
  el.querySelectorAll<HTMLElement>(".clash-row").forEach((row) => {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => {
      const p = pairs[Number(row.dataset.i)];
      viewport.setSelectionMode("bodies");
      selBtn.textContent = "Bodies";
      selBtn.classList.add("active");
      viewport.setSelectedBodies([p.a, p.b]);
    });
  });
  clashEsc = (e) => {
    if (e.key === "Escape") closeInterference();
  };
  window.addEventListener("keydown", clashEsc, true);
}


// they can't fire mid-sketch / mid-drag.
function toolBusy(): boolean {
  return sketch.active || extrude.active || edgeFeature.active || pressPull.active || planeOffset.active || moveTool.active || measure.active || section.active || planePick;
}

// True when the current rebuild produced a solid body (something to modify).
function hasBody(): boolean {
  return (store.buildState.result?.mesh.positions.length ?? 0) > 0;
}

// Mirror: choose the symmetry plane (the backend honors XY/XZ/YZ; the old tool
// was hard-coded to YZ). Mirrors the active body and unions the reflection.
async function startMirror() {
  if (toolBusy()) return;
  const hasSolid = hasBody();
  if (!hasSolid) {
    setStatus("Mirror: create a body first", "");
    return;
  }
  const plane = await choose<"XY" | "XZ" | "YZ">("Mirror across plane", [
    { value: "XY", label: "XY" },
    { value: "XZ", label: "XZ" },
    { value: "YZ", label: "YZ" },
  ]);
  if (!plane) return;
  store.addFeature({ id: store.nextId(), type: "mirror", plane } as Feature);
}

// Revolve: spin a sketch profile around the X/Y/Z axis (defaults to a full 360°;
// edit the angle in the inspector for a partial revolve). Uses the selected
// profile area, or the only one if the sketch has just a single profile.
async function startRevolve() {
  if (toolBusy()) return;
  const regions = overlay.selectedRegions();
  const wr = regions[0] ?? (overlay.regions.length === 1 ? overlay.regions[0] : null);
  if (!wr) {
    setStatus("Revolve: select a sketch profile to revolve first", "");
    return;
  }
  const axis = await choose<"X" | "Y" | "Z">("Revolve around axis", [
    { value: "X", label: "X axis" },
    { value: "Y", label: "Y axis" },
    { value: "Z", label: "Z axis" },
  ]);
  if (!axis) return;
  store.addFeature({ id: store.nextId(), type: "revolve", sketch: wr.sketchId, axis, angle: 360 } as Feature);
}

// Loft: blend through two or more free (un-consumed) sketch profiles, in timeline
// order. Sketches already used by another feature are excluded.
function startLoft() {
  if (toolBusy()) return;
  const free = store.document.features.filter(
    (f) => f.type === "sketch" && !isSketchConsumed(f.id),
  );
  if (free.length < 2) {
    setStatus("Loft: needs at least two un-consumed sketch profiles", "");
    return;
  }
  store.addFeature({ id: store.nextId(), type: "loft", sketches: free.map((f) => f.id) } as Feature);
}

// Sweep: select a closed profile region, then pick a second (open) sketch as the
// path. The profile should sit at the start of the path, roughly perpendicular.
async function startSweep() {
  if (toolBusy()) return;
  const regions = overlay.selectedRegions();
  const wr = regions[0] ?? (overlay.regions.length === 1 ? overlay.regions[0] : null);
  if (!wr) {
    setStatus("Sweep: select a profile sketch region first", "");
    return;
  }
  const all = store.document.features.filter((f) => f.type === "sketch");
  const candidates = all.filter((f) => f.id !== wr.sketchId);
  if (candidates.length === 0) {
    setStatus("Sweep: add a second sketch with an open curve for the path", "");
    return;
  }
  const label = (id: string) => `Sketch ${all.findIndex((f) => f.id === id) + 1}`;
  let pathId = candidates[0].id;
  if (candidates.length > 1) {
    const picked = await choose<string>("Pick the path sketch", candidates.map((f) => ({ value: f.id, label: label(f.id) })));
    if (!picked) return;
    pathId = picked;
  }
  store.addFeature({ id: store.nextId(), type: "sweep", profile: wr.sketchId, path: pathId, operation: "new" } as Feature);
}

// Primitive: drop a Box / Cylinder / Sphere body at the origin (edit its size in
// the inspector). Useful as a starting block or as a boolean tool body.
async function startPrimitive() {
  if (toolBusy()) return;
  const shape = await choose<"box" | "cylinder" | "sphere">("Create primitive", [
    { value: "box", label: "Box", hint: "l×w×h" },
    { value: "cylinder", label: "Cylinder", hint: "r, h" },
    { value: "sphere", label: "Sphere", hint: "r" },
  ]);
  if (!shape) return;
  const id = store.nextId();
  if (shape === "box") store.addFeature({ id, type: "box", length: 20, width: 20, height: 20 } as Feature);
  else if (shape === "cylinder") store.addFeature({ id, type: "cylinder", radius: 10, height: 20 } as Feature);
  else store.addFeature({ id, type: "sphere", radius: 10 } as Feature);
}

// One-shot face picker: highlight the face under the cursor, return its selector
// on click (Esc cancels). Reused by Shell (open face) and Draft (taper face).
function pickFaceInteractive(promptText: string, onPick: (sel: Selector) => void) {
  if (toolBusy()) return;
  if (!hasBody()) {
    setStatus("Create or import a body first", "");
    return;
  }
  planePick = true;
  viewport.suspendPicking = true;
  setPrompt(promptText);
  const onMove = (e: PointerEvent) => void viewport.hoverFaceAt(e.clientX, e.clientY);
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const hit = viewport.pickFaceForPressPull(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cleanup();
    requestAnimationFrame(() => onPick(hit.selector));
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup();
  };
  const cleanup = () => {
    planePick = false;
    viewport.suspendPicking = false;
    viewport.clearHover();
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onEsc, true);
    setPrompt(null);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onEsc, true);
}

// Shell: pick a face to open, hollow the body to a 2mm wall (edit thickness in
// the inspector).
function startShell() {
  pickFaceInteractive("Select a face to open for the shell · Esc to cancel", (faces) => {
    store.addFeature({ id: store.nextId(), type: "shell", thickness: 2, faces } as Feature);
  });
}

// Draft: pick a face to taper by 5° about the body's base (pull +Z; edit the
// angle in the inspector).
function startDraft() {
  pickFaceInteractive("Select a face to draft · Esc to cancel", (faces) => {
    store.addFeature({ id: store.nextId(), type: "draft", faces, angle: 5, axis: "Z" } as Feature);
  });
}

// Pattern: replicate the active body — rectangular grid or circular array. Edit
// counts / spacing / angle in the inspector.
async function startPattern() {
  if (toolBusy()) return;
  if (!hasBody()) {
    setStatus("Pattern: create or import a body first", "");
    return;
  }
  const kind = await choose<"rect" | "circular">("Pattern type", [
    { value: "rect", label: "Rectangular", hint: "grid" },
    { value: "circular", label: "Circular", hint: "around axis" },
  ]);
  if (!kind) return;
  const id = store.nextId();
  if (kind === "rect") {
    store.addFeature({ id, type: "patternRect", countX: 3, countY: 1, spacingX: 30, spacingY: 30 } as Feature);
  } else {
    store.addFeature({ id, type: "patternCircular", count: 4, angle: 360, axis: "Z" } as Feature);
  }
}

function startExtrude() {
  if (sketch.active || extrude.active || edgeFeature.active || pressPull.active || planeOffset.active) return;
  if (overlay.regions.length === 0) {
    // Fusion parity: Extrude on a selected planar face extrudes that face — the
    // same offset-a-face operation as Press/Pull — so route it there instead of
    // demanding a sketch. Only fall back to the hint if nothing usable is picked.
    if (viewport.selectedFaceForPressPull()) {
      pressPull.start((id) => id && selectFeature(id));
      return;
    }
    setStatus("Extrude: select a face, or create a sketch with a closed profile first", "");
    return;
  }
  extrude.start((id) => id && selectFeature(id));
}

function editFeature(id: string) {
  selectFeature(id);
  const f = store.document.features.find((x) => x.id === id);
  if (f?.type === "sketch") sketch.enter(f.plane, store, id);
}

// --- ribbon / keymap actions ---
const SKETCH_TOOLS = new Set([
  "line", "rectangle", "centerRectangle", "circle", "circle2", "circle3",
  "arc", "polygon", "slot", "spline", "point",
]);
// sketch MODIFY tools (ribbon action -> sketch tool name)
const SKETCH_MODIFY: Record<string, SketchTool> = {
  trim: "trim",
  "fillet-sketch": "fillet",
  offset: "offset",
  extend: "extend",
  break: "break",
  "mirror-sketch": "mirror",
  dimension: "dimension",
  horizontal: "horizontal",
  vertical: "vertical",
  parallel: "parallel",
  perpendicular: "perpendicular",
  equal: "equal",
  tangent: "tangent",
  coincident: "coincident",
  concentric: "concentric",
  midpoint: "midpoint",
  symmetric: "symmetric",
};
function handleAction(action: string) {
  // sketch CREATE tools: switch tool while sketching, else start a sketch with it
  if (SKETCH_TOOLS.has(action)) {
    if (sketch.active) sketch.setTool(action as SketchTool);
    else startSketch(action as SketchTool);
    return;
  }
  // sketch MODIFY tools only make sense inside a sketch
  if (action in SKETCH_MODIFY) {
    if (sketch.active) sketch.setTool(SKETCH_MODIFY[action]);
    else setStatus("Enter a sketch to use modify tools", "");
    return;
  }
  if (action === "finish") return void sketch.finish(true);
  if (action === "palette") return void palette.setVisible(true);
  // a 3D modeling command finishes the active sketch first (Fusion behavior)
  if (sketch.active) sketch.finish(true);

  switch (action) {
    case "sketch":
      startSketch();
      break;
    case "offset-plane":
      offsetPlane();
      break;
    case "extrude":
      startExtrude();
      break;
    case "fillet":
      startFillet();
      break;
    case "chamfer":
      startChamfer();
      break;
    case "presspull":
      startPressPull();
      break;
    case "mirror":
      void startMirror();
      break;
    case "split":
      void startSplit();
      break;
    case "combine":
      void startCombine();
      break;
    case "datum-plane":
      createDatumPlane();
      break;
    case "import":
      void importModel(store, geometry);
      break;
    case "save":
      void saveDocument(store);
      break;
    case "open":
      void openDocument(store, geometry);
      break;
    case "export":
      void exportModel(store, geometry);
      break;
    case "revolve":
      void startRevolve();
      break;
    case "loft":
      startLoft();
      break;
    case "sweep":
      void startSweep();
      break;
    case "primitive":
      void startPrimitive();
      break;
    case "shell":
      startShell();
      break;
    case "draft":
      startDraft();
      break;
    case "pattern":
      void startPattern();
      break;
    case "simplify-mesh":
      startSimplifyMesh();
      break;
    case "scale":
      startScale();
      break;
    case "move":
      startMove();
      break;
    case "measure":
      if (!hasBody()) {
        setStatus("Measure: create or import a body first", "");
        break;
      }
      measure.start();
      break;
    case "properties":
      showProperties();
      break;
    case "section":
      if (section.active) {
        section.stop();
        break;
      }
      if (!hasBody()) {
        setStatus("Section: create or import a body first", "");
        break;
      }
      void (async () => {
        const ax = await choose<"X" | "Y" | "Z">("Section — cut along which axis?", [
          { value: "Z", label: "Z", hint: "horizontal cut" },
          { value: "X", label: "X" },
          { value: "Y", label: "Y" },
        ]);
        if (ax) section.start(ax);
      })();
      break;
    case "component-colors":
      if (!hasBody()) {
        setStatus("Component colors: create or import a body first", "");
        break;
      }
      viewport.setAnalysis(viewport.analysis === "component" ? "none" : "component");
      setStatus(viewport.analysis === "component" ? "Component colors on" : "Component colors off", "");
      break;
    case "draft-analysis":
      if (!hasBody()) {
        setStatus("Draft analysis: create or import a body first", "");
        break;
      }
      viewport.setAnalysis(viewport.analysis === "draft" ? "none" : "draft");
      setStatus(
        viewport.analysis === "draft"
          ? "Draft analysis: red = overhang (down-facing vs +Z), green = up, blue = wall"
          : "Draft analysis off",
        "",
      );
      break;
    case "interference":
      void showInterference();
      break;
    // --- global File / View commands (also reachable from the palette) ---
    case "new":
      void newDocument();
      break;
    case "saveas":
      void saveDocumentAs(store);
      break;
    case "fit":
      viewport.fitView();
      break;
    case "iso":
    case "top":
    case "front":
    case "right":
      viewport.setStandardView(action as StandardView);
      break;
    case "persp":
      viewport.toggleProjection();
      projBtn.textContent = viewport.rig.isOrtho() ? "Ortho" : "Persp";
      break;
    case "selmode": {
      const next = viewport.selecting === "faces" ? "bodies" : "faces";
      viewport.setSelectionMode(next);
      selBtn.textContent = next === "bodies" ? "Bodies" : "Faces";
      selBtn.classList.toggle("active", next === "bodies");
      break;
    }
  }
}

// --- keymap (Fusion defaults) ---
installKeymap((a) => {
  // while sketching, the sketch tool owns its tool keys + Esc/Enter
  if (sketch.active && SKETCH_TOOLS.has(a)) return;
  switch (a) {
    case "sketch":
    case "line":
    case "rectangle":
    case "circle":
    case "arc":
    case "extrude":
    case "fillet":
    case "chamfer":
      handleAction(a);
      break;
    case "presspull":
      handleAction(a);
      break;
    case "dimension":
      if (sketch.active) handleAction("dimension");
      break;
    case "undo":
      store.undo();
      break;
    case "redo":
      store.redo();
      break;
    case "save":
      void saveDocument(store);
      break;
    case "escape":
      if (!sketch.active && !extrude.active && !edgeFeature.active && !pressPull.active && !planeOffset.active) {
        viewport.clearSelection();
        selectFeature(null);
      }
      break;
    case "fit":
      viewport.fitView();
      break;
  }
});

// delete selected feature
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (toolBusy()) return;
  if ((e.key === "Delete" || e.key === "Backspace") && selectedFeature) {
    store.removeFeature(selectedFeature);
    selectFeature(null);
  }
});

// file shortcuts (work everywhere, even mid-sketch)
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "n") { e.preventDefault(); void newDocument(); }
  else if (k === "o") { e.preventDefault(); void openDocument(store, geometry); }
  else if (k === "s" && e.shiftKey) { e.preventDefault(); void saveDocumentAs(store); }
  else if (k === "s") { e.preventDefault(); void saveDocument(store); }
  else if (k === "e") { e.preventDefault(); void exportModel(store, geometry); }
});

// --- helpers ---
function setStatus(text: string, cls: "" | "connected" | "error") {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}
