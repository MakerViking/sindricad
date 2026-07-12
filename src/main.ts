import "./styles.css";
import { Viewport } from "./viewport/viewport";
import type { StandardView } from "./viewport/cameras";
import { Geometry } from "./geometry/client";
import { TauriGeometry } from "./geometry/tauriClient";
import { listen } from "@tauri-apps/api/event";
import { DocumentStore } from "./document/store";
import { EXAMPLE_BRACKET } from "./document/example";
import { Timeline } from "./ui/timeline";
import { BrowserTree } from "./ui/browserTree";
import { Inspector } from "./ui/inspector";
import { Ribbon } from "./ui/ribbon";
import { CommandPalette } from "./ui/commandPalette";
import { SketchPalette } from "./ui/sketchPalette";
import { installKeymap } from "./input/keymap";
import { toggleShortcutHUD } from "./input/shortcuts";
import { initSpaceMouse, setSpaceMouseConfig, getSpaceMouseMode, setSpaceMouseMode } from "./input/spacemouse";
import { SpaceMouseSettings } from "./ui/spaceMouseSettings";
import { saveDocument, saveDocumentAs, openDocument, openDocumentAtPath, exportModel, exportPrintProject, importModel } from "./io/files";
import { openInOrca, sendToPrinter } from "./print/printFlow";
import { installAutosave, checkRecovery } from "./io/recovery";
import { WelcomeScreen, welcomeOnStartup, warmAccount } from "./ui/welcome";
import { openSignInDialog, signOutFlow } from "./tinkeratlas/account";
import { publishToTinkerAtlas } from "./tinkeratlas/publish";
import { currentAccount } from "./tinkeratlas/client";
import { Menubar, dismissContextMenu } from "./ui/menu";
import { choose, isChoiceOpen } from "./ui/choice";
import { toast } from "./ui/toast";
import { FEATURE_META } from "./ui/featureMeta";
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
import { createFeatureStarters } from "./features/featureStarters";
import { createContextMenus } from "./ui/contextMenus";
import { createPanels } from "./ui/panels";
import { setPrompt } from "./ui/prompt";
import { getUnit, setUnit, type Unit } from "./ui/units";
import type { Feature, PlaneDef } from "./types";

// Last-resort net: an uncaught error/rejection anywhere shouldn't fail silently
// with just a blank viewport — log it and tell the user something broke.
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled rejection:", e.reason);
  toast("Something went wrong — check the console for details", { kind: "error" });
});
window.onerror = (message, source, lineno, colno, error) => {
  console.error("Uncaught error:", error ?? message, source, lineno, colno);
  toast("Something went wrong — check the console for details", { kind: "error" });
};

// --- core singletons ---
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const contextTab = document.getElementById("context-tab")!;

const viewport = new Viewport(canvas);

const geometry = import.meta.env.VITE_GEOM === "rust" ? new TauriGeometry() : new Geometry();
void geometry.init(); // fetch the per-launch sidecar auth token + open the socket
// Rust's sidecar supervisor (src-tauri/src/sidecar.rs) emits this if the Python
// geometry process crashes after launch. There's no auto-respawn (the per-launch
// auth token would need to rotate live), so tell the user before they keep
// working on top of a dead backend. Guarded to Tauri only — plain `vite` dev
// (no Tauri host) has nothing to emit this and listen() would just reject.
if ("__TAURI_INTERNALS__" in window) {
  void listen("sidecar:died", () => {
    toast("The geometry engine crashed. Save your work, then restart SindriCAD.", { kind: "error", timeout: 60000 });
  });
}
const store = new DocumentStore(geometry, EXAMPLE_BRACKET);
// crash-safety: periodic recovery snapshots + restore-on-launch prompt
installAutosave(store);
void checkRecovery(store);

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

// Debug handles for console + headless frontend-logic tests. Gated to DEV so
// they're absent from production bundles — a post-XSS attacker shouldn't be
// handed the live store/geometry API for free (the vite dev server is DEV, so
// the localhost:5173 test workflow keeps them).
if (import.meta.env.DEV) {
  (window as any).viewport = viewport;
  (window as any).store = store;
  (window as any).geometry = geometry;
  (window as any).sketch = sketch;
  (window as any).overlay = overlay;
  (window as any).extrude = extrude;
  (window as any).edgeFeature = edgeFeature;
  (window as any).pressPull = pressPull;
  (window as any).solveSketch = solveSketch;
}
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

// WebKitGTK quirk: wheel events over overflow panels don't reliably reach the
// native scroller (GTK kinetic scrolling eats them — measured fine in Chromium,
// dead in the webview), so drive the panel scroll explicitly. deltaMode-
// normalized like the viewport's zoom wheel.
for (const id of ["browser", "inspector"]) {
  const el = document.getElementById(id)!;
  el.addEventListener(
    "wheel",
    (e) => {
      if (el.scrollHeight <= el.clientHeight) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      el.scrollTop += e.deltaY * unit;
      e.preventDefault();
    },
    { passive: false },
  );
}

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
// Open must exit an active sketch first — else the in-progress sketch's curves
// orphan on screen (loading the new doc doesn't touch the active-sketch overlay).
async function openDoc() {
  if (sketch.active) sketch.cancel();
  await openDocument(store, geometry);
}
const spaceMouseSettings = new SpaceMouseSettings();
const welcome = new WelcomeScreen({
  onNew: () => void newDocument(),
  onOpen: () => void openDoc(),
  onOpenPath: async (path) => {
    if (sketch.active) sketch.cancel(); // same guard as openDoc
    return openDocumentAtPath(store, path);
  },
  onSignIn: () => void openSignInDialog(),
  onSignOut: () => void signOutFlow(),
});
new Menubar(document.getElementById("menubar")!, [
  {
    label: "File",
    items: [
      { label: "New", shortcut: "Ctrl+N", onClick: () => void newDocument() },
      { label: "Open…", shortcut: "Ctrl+O", onClick: () => void openDoc() },
      { separator: true, label: "" },
      { label: "Import Mesh…", onClick: () => void importModel(store, geometry) },
      { separator: true, label: "" },
      { label: "Save", shortcut: "Ctrl+S", onClick: () => void saveDocument(store) },
      { label: "Save As…", shortcut: "Ctrl+Shift+S", onClick: () => void saveDocumentAs(store) },
      { separator: true, label: "" },
      { label: "Export…", shortcut: "Ctrl+E", onClick: () => void exportModel(store, geometry) },
      { label: "Export for Print (3MF)…", onClick: () => void exportPrintProject(store, geometry) },
      { separator: true, label: "" },
      { label: "Open in OrcaSlicer…", onClick: () => void openInOrca(store, geometry) },
      { label: "Send to Printer…", onClick: () => void sendToPrinter(store, geometry) },
    ],
  },
  {
    label: "Edit",
    items: [
      { label: "Undo", shortcut: "Ctrl+Z", disabled: () => !store.canUndo, onClick: () => store.undo() },
      { label: "Redo", shortcut: "Ctrl+Y", disabled: () => !store.canRedo, onClick: () => store.redo() },
      { separator: true, label: "" },
      {
        label: "Delete",
        shortcut: "Del",
        disabled: () => !selectedFeature,
        onClick: () => {
          if (deleteSelectedFace()) return;
          if (selectedFeature) {
            store.removeFeature(selectedFeature);
            selectFeature(null);
          }
        },
      },
      {
        label: "Suppress / Unsuppress",
        disabled: () => !selectedFeature,
        onClick: () => selectedFeature && store.toggleSuppress(selectedFeature),
      },
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
  {
    label: "TinkerAtlas",
    items: [
      { label: "Welcome Screen", onClick: () => welcome.open() },
      { separator: true, label: "" },
      { label: "Publish to TinkerAtlas…", onClick: () => void publishToTinkerAtlas(store, geometry, viewport) },
      { separator: true, label: "" },
      { label: "Sign in…", disabled: () => !!currentAccount(), onClick: () => void openSignInDialog() },
      { label: "Sign out", disabled: () => !currentAccount(), onClick: () => void signOutFlow() },
    ],
  },
]);

// warm the TinkerAtlas identity cache from disk (offline-safe), then show the
// welcome screen unless the user turned it off (its footer checkbox).
void warmAccount();
if (welcomeOnStartup()) welcome.open();

const docnameEl = document.getElementById("docname")!;
// mouse-visible undo/redo (Ctrl+Z was the ONLY way before — invisible affordance)
const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement;
const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement;
undoBtn.addEventListener("click", () => store.undo());
redoBtn.addEventListener("click", () => store.redo());
store.onDocChange(() => {
  undoBtn.disabled = !store.canUndo;
  redoBtn.disabled = !store.canRedo;
});
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

// Click a model FACE → select the feature that created it, so Del deletes that
// feature (and the timeline/params show which one owns the face). Provenance is the
// per-face `faceOwners` the sidecar attaches to each body in the build result.
function featureForFace(faceId: number): string | null {
  for (const b of store.buildState.result?.bodies ?? []) {
    if (faceId >= b.faceStart && faceId < b.faceStart + b.faceCount) {
      return b.faceOwners?.[faceId - b.faceStart] ?? null;
    }
  }
  return null;
}
viewport.onHit = (hit) => {
  if (toolBusy()) return;
  if (hit?.kind === "face") {
    const owner = featureForFace(hit.faceId);
    if (owner) selectFeature(owner); // show which feature this face came from
    setPrompt("Del to delete this face (removes it + heals) · Extrude to push/cut it");
  }
};

// Remove the currently-selected face(s) and heal the solid (defeature). Returns
// false when no face is selected (so the caller can fall back to feature-delete).
function deleteSelectedFace(): boolean {
  const fsel = viewport.selectedFacesForPressPull();
  if (!fsel) return false;
  store.addFeature({
    id: store.nextId(),
    type: "deleteFace",
    face: fsel.selectors.length === 1 ? fsel.selectors[0] : fsel.selectors,
    ...(fsel.bodyId ? { body: fsel.bodyId } : {}),
  } as Feature);
  viewport.clearSelection();
  setStatus("Deleting face…", ""); // real outcome (healed, or an error) comes from the rebuild
  setPrompt(null);
  return true;
}

// Guard predicates checked at the top of every start* tool + interactive helper:
// they can't fire mid-sketch / mid-drag.
function toolBusy(): boolean {
  return sketch.active || extrude.active || edgeFeature.active || pressPull.active || planeOffset.active || moveTool.active || measure.active || section.active || planePick || isChoiceOpen();
}
// True when the current rebuild produced a solid body (something to modify).
function hasBody(): boolean {
  return (store.buildState.result?.mesh.positions.length ?? 0) > 0;
}

// --- interactive plane pick (base plane quad or a planar body face) ---
let planePick = false;

// "Repeat <last command>" (Onshape-style): the empty-space menu re-runs the last
// real command. Navigation / view / file actions aren't commands you repeat, so
// they don't overwrite it.
const NON_REPEATABLE = new Set([
  "new", "open", "save", "saveas", "export", "import",
  "print-export", "print-orca", "print-send", "welcome", "ta-publish",
  "undo", "redo", "compute-all", "shortcut-help", "finish", "palette",
  "fit", "iso", "top", "front", "right", "persp",
  "selmode", "selmode-faces", "selmode-bodies",
  "hide-selected", "show-all-bodies",
]);
let lastAction: string | null = null;

const starters = createFeatureStarters({
  store,
  viewport,
  overlay,
  sketch,
  extrude,
  edgeFeature,
  pressPull,
  moveTool,
  planeOffset,
  canvas,
  toolBusy,
  hasBody,
  setStatus,
  selectFeature,
  noteCommitted,
  isSketchConsumed,
  getSelectedFeature: () => selectedFeature,
  setPlanePick: (v) => { planePick = v; },
});

/** A datum plane's world placement (source spec + offset along its normal) as a
 *  PlaneDef — lets "Sketch on plane" / "Offset plane" work straight off the quad. */
function datumPlaneDef(f: Extract<Feature, { type: "datumPlane" }>): PlaneDef {
  const sp = new SketchPlane(f.plane);
  const off = f.offset ?? 0;
  return {
    origin: [sp.origin.x + sp.n.x * off, sp.origin.y + sp.n.y * off, sp.origin.z + sp.n.z * off],
    normal: [sp.n.x, sp.n.y, sp.n.z],
    xdir: [sp.u.x, sp.u.y, sp.u.z],
  };
}

const menus = createContextMenus({
  store,
  viewport,
  sketch,
  measure,
  tree,
  toolBusy,
  setStatus,
  selectFeature,
  editFeature,
  featureForFace,
  deleteSelectedFace,
  syncDatumPlanes,
  datumPlaneDef,
  handleAction,
  getLastAction: () => lastAction,
  setLastAction: (a) => { lastAction = a; },
  startCutByPlane: starters.startCutByPlane,
  offsetPlaneFromFace: starters.offsetPlaneFromFace,
});

// ---------------------------------------------------------------------------
// Viewport right-click: context-aware menus — one provider per target (datum
// plane / edge / face / whole body / empty space), all on the shared engine in
// ui/menu.ts. The viewport owns the click-vs-pan gesture (right button is
// camera pan) and fires onContextClick only for a genuine click; toolBusy
// gates it — an active tool (or sketch mode, which has its own canvas menu)
// owns the gesture.
// ---------------------------------------------------------------------------
viewport.shouldOpenContextMenu = () => !toolBusy();
viewport.onContextClick = (x, y) => menus.openCanvasMenu(x, y);

// A context menu holds targets captured at open time (faceId, edge line, body
// id) — a completed rebuild renumbers topology and replaces the mesh, and any
// document change can invalidate the owning feature. Dismiss rather than let a
// click act on stale targets ("Delete face" healing the WRONG face).
store.onDocChange(() => dismissContextMenu());
store.onBuild((s) => {
  if (s.result && !s.building) dismissContextMenu();
});

tree.onEditSketch = (id) => editFeature(id);
tree.onSketchOnPlane = (plane) => {
  if (!sketch.active && !extrude.active && !edgeFeature.active && !pressPull.active && !planeOffset.active) sketch.enter(plane, store);
};

// --- sketch visibility (MCAD-style: a sketch consumed by a feature hides by
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
  if (extrude.forcedSketchId === id) return true; // being edited — regions must exist
  return store.sketchVisibilityOverride(id) ?? !isSketchConsumed(id);
}
overlay.sketchVisible = isSketchVisible;
tree.isSketchVisible = isSketchVisible;
tree.onToggleSketch = (id) => {
  store.setSketchVisibility(id, !isSketchVisible(id));
  if (!sketch.active) overlay.update(store.document);
  tree.refresh();
};

// SOLID-mode direct selection of a visible sketch's profile AREAS (MCAD-style):
// click a shown sketch's cell to (pre)select it, then Extrude (E) uses it. Only
// fires when a sketch is visible (overlay.regions is empty otherwise), so normal
// face/body picking is untouched the rest of the time.
viewport.regionHoverAt = (x, y) => {
  if (sketch.active || toolBusy()) { overlay.setHoverRegion(null); return false; }
  const wr = overlay.committedRegionAtRay(viewport.rayFrom(x, y).ray);
  overlay.setHoverRegion(wr);
  return !!wr;
};
viewport.regionPickAt = (x, y, additive) => {
  if (sketch.active || toolBusy()) return false;
  const wr = overlay.committedRegionAtRay(viewport.rayFrom(x, y).ray);
  if (!wr) return false;
  overlay.toggleRegionSelection(wr, additive);
  const n = overlay.selectedRegions().length;
  setPrompt(n ? `${n} profile area${n > 1 ? "s" : ""} selected — Extrude (E) · Ctrl-click adds · Esc clears` : null);
  return true;
};
// Esc clears a pre-selected profile-area selection (when not in a tool/sketch)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !toolBusy() && !sketch.active && overlay.selectedRegions().length) {
    overlay.clearRegionSelection();
    setPrompt(null);
  }
});

// per-body show/hide (MCAD-style eye toggle); re-renders without a sidecar rebuild
tree.isBodyVisible = (id) => store.isBodyVisible(id);
tree.onToggleBody = (id) => {
  store.setBodyVisibility(id, !store.isBodyVisible(id));
  tree.refresh();
};

// per-construction-plane show/hide (eye toggle); re-syncs the datum quads, no rebuild
tree.isPlaneVisible = (id) => store.isPlaneVisible(id);
tree.onTogglePlane = (id) => {
  store.setPlaneVisibility(id, !store.isPlaneVisible(id));
  syncDatumPlanes();
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
tree.onCutPlane = (id) => void starters.startCutByPlane(id);
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

// resolve each body's assigned palette slot to a hex color for the viewport.
function computeBodyPaint(): Record<string, string> {
  const pal = store.colorPalette;
  const out: Record<string, string> = {};
  for (const b of store.buildState.result?.bodies ?? []) {
    const slot = store.bodyColorSlot(b.id);
    if (slot != null && pal[slot]) out[b.id] = pal[slot].color;
  }
  return out;
}

// Failed-commit visibility: a feature that errors in the rebuild leaves the
// model looking UNCHANGED (its body keeps the old mesh), so without an active
// notification the only signal is the small status line — "nothing happened".
// Diff each completed build's failing-feature set against the previous one and
// toast every NEW failure; if it's the feature the user JUST committed from an
// interactive tool, select it immediately (red chip scrolls into view).
let prevErrorIds = new Set<string>();
// Failed fillet/chamfer edges (midpoints per feature id) — survives sidecar
// cache-hit rebuilds that re-emit the error without its diagnostics.
const failedEdgeMids = new Map<string, [number, number, number][]>();
let lastCommittedId: string | null = null;
function noteCommitted(id: string | null) {
  if (id) lastCommittedId = id;
}

store.onBuild((s) => {
  // Only render COMPLETED builds. A `building` tick carries the previous result
  // (the new geometry isn't ready yet); re-rendering it would momentarily revert an
  // in-progress ghost (a committed Move/Press-Pull) to the old placement until the
  // real rebuild lands. Skipping it keeps the ghost on screen seamlessly.
  if (s.result && !s.building) {
    if (s.result.mesh.positions.length > 0) {
      // hide the faces AND wireframe of any body the user toggled off (filtered
      // in the render, no sidecar rebuild — setBodyVisibility re-emits the build).
      const hidden = (s.result.bodies ?? [])
        .filter((b) => !store.isBodyVisible(b.id))
        .map((b) => b.id);
      viewport.setModel(s.result, firstModel, hidden);
      firstModel = false;
      viewport.setBodyPaint(computeBodyPaint()); // apply assigned per-body colors
    } else {
      viewport.clearModel();
    }
    // Failed-edge red paint (fillet/chamfer edgeOpFailed diagnostics). Runs for
    // BOTH committed and preview builds (a just-toggled bad edge should turn
    // red live), unlike the toast gate below. The sidecar's prefix cache
    // re-emits errors but NOT diagnostics on cache-hit resumes, so failed mids
    // are cached per feature here and dropped only when the feature's error
    // clears from featureErrors (content-keyed caching guarantees the cached
    // mids stay valid exactly as long as the failing feature is unchanged).
    {
      const errIds = new Set(
        (s.result.featureErrors ?? []).map((e) => e.feature_id).filter(Boolean) as string[],
      );
      for (const d of s.result.diagnostics ?? []) {
        if (d.kind === "edgeOpFailed" && d.feature_id && d.failed?.length) {
          failedEdgeMids.set(d.feature_id, d.failed.map((e) => e.mid));
        }
      }
      for (const id of [...failedEdgeMids.keys()]) {
        if (!errIds.has(id)) failedEdgeMids.delete(id);
      }
      viewport.setErrorEdgeMids([...failedEdgeMids.values()].flat());
    }
    // toast NEW feature errors (skip preview builds — they carry a transient
    // un-committed feature whose failures resolve on commit/cancel)
    if (!store.hasPreview) {
      const errs = s.result.featureErrors ?? [];
      const ids = new Set(errs.map((e) => e.feature_id).filter(Boolean) as string[]);
      for (const e of errs) {
        if (!e.feature_id || prevErrorIds.has(e.feature_id)) continue;
        const f = store.document.features.find((x) => x.id === e.feature_id);
        const label = f ? (FEATURE_META[f.type as keyof typeof FEATURE_META]?.label ?? f.type) : e.feature_id;
        const id = e.feature_id;
        toast(`⚠ ${label} failed: ${e.message}`, {
          kind: "error",
          action: { label: "Show", onClick: () => selectFeature(id) },
        });
        if (id === lastCommittedId) selectFeature(id);
      }
      prevErrorIds = ids;
      lastCommittedId = null;
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
    .filter((f) => store.isPlaneVisible(f.id)) // hidden planes: not drawn, not pickable
    .map((f) => {
      const def = datumPlaneDef(f); // one formula for quad, sketch and offset targets
      return { id: f.id, origin: def.origin, normal: def.normal };
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

const panels = createPanels({ store, viewport, geometry, hasBody, setStatus, selBtn });

function editFeature(id: string) {
  selectFeature(id);
  if (toolBusy()) return; // never open a second interactive tool on top of one
  const f = store.document.features.find((x) => x.id === id);
  if (!f) return;
  if (store.isSuppressed(id)) {
    setStatus("Unsuppress the feature to edit it", "");
    return;
  }
  const idx = store.document.features.findIndex((x) => x.id === id);
  if (idx >= store.rollbackIndex) {
    setStatus("Roll the timeline forward to edit this feature", "");
    return;
  }
  const done = (cid: string | null) => {
    noteCommitted(cid);
    if (cid) selectFeature(cid);
  };
  switch (f.type) {
    case "sketch":
      sketch.enter(f.plane, store, id);
      break;
    case "fillet":
    case "chamfer":
      // false = not tool-editable (parameter value / structural selectors) —
      // the inspector is already focused via selectFeature above.
      if (!edgeFeature.startEdit(id, done)) setStatus("Edit the value in the inspector (right panel)", "");
      break;
    case "extrude":
      if (!extrude.startEdit(id, done)) setStatus("Edit the value in the inspector (right panel)", "");
      break;
    default:
      break; // inspector focus (selectFeature above) is the edit surface for the rest
  }
}

// --- ribbon / keymap actions ---
const SKETCH_TOOLS = new Set([
  "line", "rectangle", "centerRectangle", "circle", "circle2", "circle3",
  "arc", "polygon", "slot", "spline", "point",
  "boltCircle", "hexHoles", "gridHoles", "patternRect", "patternCircular", "honeycomb",
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
  if (!NON_REPEATABLE.has(action)) lastAction = action; // for "Repeat <command>"
  // sketch CREATE tools: switch tool while sketching, else start a sketch with it
  if (SKETCH_TOOLS.has(action)) {
    if (sketch.active) sketch.setTool(action as SketchTool);
    else starters.startSketch(action as SketchTool);
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
  // a 3D modeling command finishes the active sketch first (mainstream MCAD behavior)
  if (sketch.active) sketch.finish(true);

  switch (action) {
    case "sketch":
      starters.startSketch();
      break;
    case "offset-plane":
      starters.offsetPlane();
      break;
    case "extrude":
      starters.startExtrude();
      break;
    case "fillet":
      starters.startFillet();
      break;
    case "chamfer":
      starters.startChamfer();
      break;
    case "presspull":
      starters.startPressPull();
      break;
    case "mirror":
      void starters.startMirror();
      break;
    case "split":
      void starters.startSplit();
      break;
    case "combine":
      void starters.startCombine();
      break;
    case "datum-plane":
      starters.createDatumPlane();
      break;
    case "import":
      void importModel(store, geometry);
      break;
    case "save":
      void saveDocument(store);
      break;
    case "open":
      void openDoc();
      break;
    case "export":
      void exportModel(store, geometry);
      break;
    case "print-export":
      void exportPrintProject(store, geometry);
      break;
    case "print-orca":
      void openInOrca(store, geometry);
      break;
    case "print-send":
      void sendToPrinter(store, geometry);
      break;
    case "welcome":
      welcome.open();
      break;
    case "ta-publish":
      void publishToTinkerAtlas(store, geometry, viewport);
      break;
    case "revolve":
      void starters.startRevolve();
      break;
    case "loft":
      void starters.startLoft();
      break;
    case "sweep":
      void starters.startSweep();
      break;
    case "primitive":
      void starters.startPrimitive();
      break;
    case "shell":
      starters.startShell();
      break;
    case "draft":
      starters.startDraft();
      break;
    case "pattern":
      void starters.startPattern();
      break;
    case "simplify-mesh":
      starters.startSimplifyMesh();
      break;
    case "clean-up":
      starters.startCleanUp();
      break;
    case "scale":
      starters.startScale();
      break;
    case "move":
      starters.startMove();
      break;
    case "measure":
      if (!hasBody()) {
        setStatus("Measure: create or import a body first", "");
        break;
      }
      measure.start();
      break;
    case "properties":
      panels.showProperties();
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
      panels.closeOverhangSettings(); // leaving draft mode
      setStatus(viewport.analysis === "component" ? "Component colors on" : "Component colors off", "");
      break;
    case "draft-analysis":
      if (!hasBody()) {
        setStatus("Draft analysis: create or import a body first", "");
        break;
      }
      viewport.setAnalysis(viewport.analysis === "draft" ? "none" : "draft");
      if (viewport.analysis === "draft") {
        const { dir, threshold } = viewport.draftConfig;
        setStatus(`Overhang: red = unsupported below ${threshold}° from horizontal (build ${dir})`, "");
        panels.showOverhangSettings();
      } else {
        panels.closeOverhangSettings();
        setStatus("Draft analysis off", "");
      }
      break;
    case "zebra":
      if (!hasBody()) {
        setStatus("Zebra: create or import a body first", "");
        break;
      }
      viewport.setZebra(!viewport.zebraOn);
      setStatus(viewport.zebraOn ? "Zebra stripes on (surface continuity)" : "Zebra off", "");
      break;
    case "curvature":
      if (!hasBody()) {
        setStatus("Curvature combs: create or import a body first", "");
        break;
      }
      viewport.setCurvatureCombs(!viewport.combsOn);
      setStatus(viewport.combsOn ? "Curvature combs on (edge bend visualization)" : "Curvature combs off", "");
      break;
    case "interference":
      void panels.showInterference();
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
    case "persp": {
      const mode = viewport.cycleProjection();
      projBtn.textContent =
        mode === "auto" ? "Auto" : mode === "ortho" ? "Ortho" : "Persp";
      break;
    }
    case "selmode": {
      const next = viewport.selecting === "faces" ? "bodies" : "faces";
      viewport.setSelectionMode(next);
      selBtn.textContent = next === "bodies" ? "Bodies" : "Faces";
      selBtn.classList.toggle("active", next === "bodies");
      break;
    }
    case "selmode-faces":
    case "selmode-bodies": {
      const mode = action === "selmode-bodies" ? "bodies" : "faces";
      viewport.setSelectionMode(mode);
      selBtn.textContent = mode === "bodies" ? "Bodies" : "Faces";
      selBtn.classList.toggle("active", mode === "bodies");
      break;
    }
    case "hide-selected": {
      const ids = viewport.getSelectedBodies();
      if (!ids.length) {
        setStatus("Hide: select bodies first (press 2 for body select)", "");
        break;
      }
      store.setBodiesVisibility(new Map(ids.map((id) => [id, false])));
      break;
    }
    case "show-all-bodies":
      store.setBodiesVisibility(
        new Map((store.buildState.result?.bodies ?? []).map((b) => [b.id, true])),
      );
      break;
    case "undo":
      store.undo();
      break;
    case "redo":
      store.redo();
      break;
    case "shortcut-help":
      toggleShortcutHUD();
      break;
    case "compute-all":
      setStatus("Compute All — rebuilding everything from scratch…", "");
      void store.computeAllNow();
      break;
  }
}

// --- keymap (MCAD defaults) ---
installKeymap(
  (a) => {
    // while sketching, the sketch tool owns its tool keys + Esc/Enter
    if (sketch.active && SKETCH_TOOLS.has(a)) return;
    if (a === "escape") {
      if (!sketch.active && !extrude.active && !edgeFeature.active && !pressPull.active && !planeOffset.active) {
        viewport.clearSelection();
        selectFeature(null);
      }
      return;
    }
    // everything else — including the once-dead M/Move and T/Trim keys — routes
    // through the same dispatcher the ribbon and command palette use
    handleAction(a);
  },
  () => (sketch.active ? "sketch" : "model"),
);

// delete: a selected FACE → remove it and heal the solid (defeature — works on
// imported geometry, where there's no feature to delete); otherwise delete the
// selected timeline feature.
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (toolBusy()) return;
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (deleteSelectedFace()) return;
  if (selectedFeature) {
    store.removeFeature(selectedFeature);
    selectFeature(null);
  }
});

// file shortcuts (work everywhere, even mid-sketch)
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "n") { e.preventDefault(); void newDocument(); }
  else if (k === "o") { e.preventDefault(); void openDoc(); }
  else if (k === "s" && e.shiftKey) { e.preventDefault(); void saveDocumentAs(store); }
  else if (k === "s") { e.preventDefault(); void saveDocument(store); }
  else if (k === "e") { e.preventDefault(); void exportModel(store, geometry); }
});

// --- helpers ---
function setStatus(text: string, cls: "" | "connected" | "error") {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}
