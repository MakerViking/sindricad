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
import { SketchPalette } from "./ui/sketchPalette";
import { installKeymap } from "./input/keymap";
import { initSpaceMouse, setSpaceMouseConfig, getSpaceMouseMode, setSpaceMouseMode } from "./input/spacemouse";
import { SpaceMouseSettings } from "./ui/spaceMouseSettings";
import { saveDocument, saveDocumentAs, openDocument, exportModel } from "./io/files";
import { Menubar } from "./ui/menu";
import { SketchOverlay } from "./sketch/overlay";
import { SketchMode, type SketchTool } from "./sketch/sketchMode";
import { SketchPlane } from "./sketch/plane";
import { solveSketch, initSolver } from "./sketch/solver";
import { ExtrudeTool } from "./features/extrudeTool";
import { EdgeFeatureTool } from "./features/edgeFeatureTool";
import { PressPullTool } from "./features/pressPullTool";
import { PlaneOffsetTool } from "./features/planeOffsetTool";
import { setPrompt } from "./ui/prompt";
import { getUnit, setUnit, type Unit } from "./ui/units";
import type { Feature, PlaneSpec } from "./types";

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
      { label: "Open…", shortcut: "Ctrl+O", onClick: () => void openDocument(store) },
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
}
timeline.onSelect = selectFeature;
timeline.onEdit = (id) => editFeature(id);
tree.onSelect = selectFeature;
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

// --- sketch overlays follow the document (when not actively sketching) ---
store.onDocChange(() => {
  if (!sketch.active) overlay.update(store.document);
});

// --- selected-edge hint: tells you pre-selection is usable by Fillet/Chamfer ---
viewport.onSelectionChange = () => {
  if (sketch.active || extrude.active || edgeFeature.active || pressPull.active || planeOffset.active || planePick) return;
  const n = viewport.selectedEdgeSelectors().length;
  setPrompt(n ? `${n} edge${n > 1 ? "s" : ""} selected — Fillet or Chamfer to apply · Esc to clear` : null);
};

// --- rebuild pipeline -> viewport ---
let firstModel = true;
store.onBuild((s) => {
  if (s.result) {
    if (s.result.mesh.positions.length > 0) {
      viewport.setModel(s.result, firstModel);
      firstModel = false;
    } else {
      viewport.clearModel();
    }
  }
  if (s.errorMessage) {
    setStatus(`⚠ ${s.errorFeatureId ?? ""}: ${s.errorMessage}`, "error");
  } else if (!s.building) {
    setStatus("ready", "connected");
  }
});

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

// --- view controls ---
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
  btn.addEventListener("click", () =>
    viewport.setStandardView(btn.dataset.view as StandardView),
  );
});
document.getElementById("fit")!.addEventListener("click", () => viewport.fitView());

// unit selector (display/input only; geometry stays in mm)
const unitSel = document.getElementById("unit") as HTMLSelectElement;
unitSel.value = getUnit();
unitSel.addEventListener("change", () => setUnit(unitSel.value as Unit));
const projBtn = document.getElementById("proj") as HTMLButtonElement;
projBtn.addEventListener("click", () => {
  viewport.toggleProjection();
  projBtn.textContent = viewport.rig.isOrtho() ? "Ortho" : "Persp";
});

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
  if (sketch.active || extrude.active || edgeFeature.active || pressPull.active || planeOffset.active || planePick) return;
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

function startExtrude() {
  if (sketch.active || extrude.active || edgeFeature.active || pressPull.active || planeOffset.active) return;
  if (overlay.regions.length === 0) {
    setStatus("Extrude: create a sketch with a closed profile first", "");
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
      store.addFeature({ id: store.nextId(), type: "mirror", plane: "YZ" } as Feature);
      break;
    case "save":
      void saveDocument(store);
      break;
    case "open":
      void openDocument(store);
      break;
    case "export":
      void exportModel(store, geometry);
      break;
    case "revolve":
    case "loft":
      setStatus(`${action}: coming soon`, "");
      break;
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
  if (sketch.active || extrude.active || edgeFeature.active || pressPull.active || planeOffset.active || planePick) return;
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
  else if (k === "o") { e.preventDefault(); void openDocument(store); }
  else if (k === "s" && e.shiftKey) { e.preventDefault(); void saveDocumentAs(store); }
  else if (k === "s") { e.preventDefault(); void saveDocument(store); }
  else if (k === "e") { e.preventDefault(); void exportModel(store, geometry); }
});

// --- helpers ---
function setStatus(text: string, cls: "" | "connected" | "error") {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}
