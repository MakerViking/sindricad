// Viewport right-click: context-aware menus — one provider per target (datum
// plane / edge / face / whole body / empty space), all on the shared engine in
// ui/menu.ts. The viewport owns the click-vs-pan gesture (right button is
// camera pan) and fires onContextClick only for a genuine click; toolBusy
// gates it — an active tool (or sketch mode, which has its own canvas menu)
// owns the gesture.
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { SketchMode } from "../sketch/sketchMode";
import type { MeasureTool } from "../features/measureTool";
import { BrowserTree, bodyColorMenuItems } from "./browserTree";
import { contextMenu, type CtxItem } from "./menu";
import { isInspectorEditable } from "./inspector";
import { allCommands } from "./commands";
import { FEATURE_META } from "./featureMeta";
import { keyHint } from "../input/shortcuts";
import type { Feature, PlaneDef } from "../types";
import type { EdgeHit, FaceHit } from "../viewport/picking";

export interface ContextMenusDeps {
  store: DocumentStore;
  viewport: Viewport;
  sketch: SketchMode;
  measure: MeasureTool;
  tree: BrowserTree;
  toolBusy: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
  selectFeature: (id: string | null) => void;
  editFeature: (id: string) => void;
  featureForFace: (faceId: number) => string | null;
  deleteSelectedFace: () => boolean;
  syncDatumPlanes: () => void;
  datumPlaneDef: (f: Extract<Feature, { type: "datumPlane" }>) => PlaneDef;
  handleAction: (action: string) => void;
  getLastAction: () => string | null;
  setLastAction: (action: string) => void;
  startCutByPlane: (planeId: string) => void | Promise<void>;
  offsetPlaneFromFace: (face: PlaneDef) => void;
}

export function createContextMenus(deps: ContextMenusDeps) {
  const {
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
    getLastAction,
    setLastAction,
    startCutByPlane,
    offsetPlaneFromFace,
  } = deps;

  /** Wrap a menu item that starts a tool or mutates the DOCUMENT: the click runs
   *  when the item is chosen, not when the menu opened, and a keyboard shortcut
   *  may have started a tool in between. Refusals are reported, never silent.
   *  Display-only items (hide/isolate/color/rename) stay unwrapped on purpose —
   *  the browser tree's eye toggles are likewise always available, even mid-tool. */
  function unlessBusy(fn: () => void): () => void {
    return () => {
      if (toolBusy()) {
        setStatus("Finish the active tool first (Esc cancels it)", "");
        return;
      }
      fn();
    };
  }

  function openDatumMenu(x: number, y: number, datumId: string) {
    const f = store.document.features.find(
      (ft): ft is Extract<Feature, { type: "datumPlane" }> => ft.id === datumId && ft.type === "datumPlane",
    );
    selectFeature(datumId); // same as clicking it — the menu acts on a visible selection
    contextMenu(x, y, [
      { label: "Cut all bodies", onClick: unlessBusy(() => void startCutByPlane(datumId)) },
      { label: "Sketch on plane", disabled: !f, onClick: unlessBusy(() => { if (f) sketch.enter(datumPlaneDef(f), store); }) },
      { label: "Offset plane", disabled: !f, onClick: unlessBusy(() => { if (f) offsetPlaneFromFace(datumPlaneDef(f)); }) },
      { separator: true, label: "" },
      { label: "Hide plane", onClick: () => { store.setPlaneVisibility(datumId, false); syncDatumPlanes(); tree.refresh(); } },
      { label: "Delete plane", danger: true, onClick: unlessBusy(() => { store.removeFeature(datumId); selectFeature(null); }) },
    ]);
  }

  function openEdgeMenu(x: number, y: number, hit: EdgeHit) {
    contextMenu(x, y, [
      // routed through handleAction so "Repeat <command>" records them
      { label: "Fillet", shortcut: keyHint("fillet"), onClick: unlessBusy(() => { viewport.selectOnlyEdge(hit.line); handleAction("fillet"); }) },
      { label: "Chamfer", shortcut: keyHint("chamfer"), onClick: unlessBusy(() => { viewport.selectOnlyEdge(hit.line); handleAction("chamfer"); }) },
      { separator: true, label: "" },
      { label: "Measure from here", shortcut: keyHint("measure"), onClick: unlessBusy(() => { setLastAction("measure"); measure.startWith(hit); }) },
    ]);
  }

  function openFaceMenu(x: number, y: number, hit: FaceHit) {
    const plane = viewport.pickFacePlane(x, y); // null on curved faces
    const bodyId = viewport.faceIdToBodyId(hit.faceId);
    const ownerId = featureForFace(hit.faceId);
    const owner = ownerId ? store.document.features.find((f) => f.id === ownerId) : undefined;
    const ownerLabel = owner ? (FEATURE_META[owner.type as keyof typeof FEATURE_META]?.label ?? owner.type) : "";
    const items: CtxItem[] = [
      { label: "Press/Pull face", shortcut: keyHint("presspull"), onClick: unlessBusy(() => { viewport.selectOnlyFace(hit.faceId); handleAction("presspull"); }) },
      { label: "Sketch on this face", shortcut: keyHint("sketch"), disabled: !plane, onClick: unlessBusy(() => { if (plane) sketch.enter(plane, store); }) },
      { label: "Measure from here", shortcut: keyHint("measure"), onClick: unlessBusy(() => { setLastAction("measure"); measure.startWith(hit); }) },
      { separator: true, label: "" },
      {
        label: "Select coplanar faces",
        onClick: unlessBusy(() => {
          const n = viewport.selectCoplanarFaces(hit.faceId);
          setStatus(`Selected ${n} coplanar face${n === 1 ? "" : "s"}`, "");
        }),
      },
      { label: "Offset plane from face", shortcut: keyHint("offset-plane"), disabled: !plane, onClick: unlessBusy(() => { if (plane) offsetPlaneFromFace(plane); }) },
      { separator: true, label: "" },
      ...(owner
        ? [{ label: `${isInspectorEditable(owner.type) ? "Edit" : "Select"} ${ownerLabel}`, onClick: unlessBusy(() => editFeature(owner.id)) }]
        : []),
      ...(bodyId
        ? [
            { label: "Hide body", onClick: () => hideBody(bodyId) },
            { label: "Isolate body", onClick: () => isolateBody(bodyId) },
          ]
        : []),
      { separator: true, label: "" },
      { label: "Delete face (heal)", danger: true, onClick: unlessBusy(() => { viewport.selectOnlyFace(hit.faceId); deleteSelectedFace(); }) },
    ];
    contextMenu(x, y, items);
  }

  function openBodyMenu(x: number, y: number, bodyId: string) {
    if (!viewport.getSelectedBodies().includes(bodyId)) viewport.setSelectedBodies([bodyId]);
    contextMenu(x, y, [
      // routed through handleAction so "Repeat <command>" records them
      { label: "Move", shortcut: keyHint("move"), onClick: unlessBusy(() => handleAction("move")) },
      { label: "Combine with…", shortcut: keyHint("combine"), onClick: unlessBusy(() => handleAction("combine")) },
      { label: "Properties", onClick: unlessBusy(() => handleAction("properties")) },
      { separator: true, label: "" },
      { label: "Hide body", onClick: () => hideBody(bodyId) },
      { label: "Isolate body", onClick: () => isolateBody(bodyId) },
      { label: "Show all bodies", shortcut: keyHint("show-all-bodies"), onClick: () => handleAction("show-all-bodies") },
      { separator: true, label: "" },
      { label: "Rename…", onClick: () => tree.beginRename(bodyId) },
      { label: "Color", children: bodyColorMenuItems(store, bodyId) },
      { separator: true, label: "" },
      { label: "Remove body", danger: true, onClick: unlessBusy(() => store.removeBody(bodyId)) },
    ]);
  }

  // "Repeat <last command>" (Onshape-style): the empty-space menu re-runs the last
  // real command. Navigation / view / file actions aren't commands you repeat, so
  // they don't overwrite it.
  function actionLabel(id: string): string {
    return allCommands().find((c) => c.id === id)?.label ?? id;
  }

  function openEmptyMenu(x: number, y: number) {
    const lastAction = getLastAction();
    contextMenu(x, y, [
      {
        label: lastAction ? `Repeat ${actionLabel(lastAction)}` : "Repeat last command",
        disabled: !lastAction,
        onClick: () => { if (lastAction) handleAction(lastAction); },
      },
      { separator: true, label: "" },
      { label: "Fit view", shortcut: keyHint("fit"), onClick: () => handleAction("fit") },
      {
        label: "Look",
        children: [
          { label: "Isometric", onClick: () => handleAction("iso") },
          { label: "Top", onClick: () => handleAction("top") },
          { label: "Front", onClick: () => handleAction("front") },
          { label: "Right", onClick: () => handleAction("right") },
        ],
      },
      { label: "Show all bodies", shortcut: keyHint("show-all-bodies"), onClick: () => handleAction("show-all-bodies") },
      { separator: true, label: "" },
      { label: "Undo", shortcut: "Ctrl+Z", disabled: !store.canUndo, onClick: () => store.undo() },
      { label: "Redo", shortcut: "Ctrl+Y", disabled: !store.canRedo, onClick: () => store.redo() },
    ]);
  }

  function hideBody(id: string) {
    store.setBodyVisibility(id, false);
    tree.refresh();
  }

  /** Show only this body (Onshape "Isolate"): hide every other body — one batched
   *  store update, ONE re-render. Undo is "Show all bodies" (Shift+H / the menus). */
  function isolateBody(id: string) {
    store.setBodiesVisibility(new Map((store.buildState.result?.bodies ?? []).map((b) => [b.id, b.id === id])));
    tree.refresh();
  }

  function openCanvasMenu(x: number, y: number) {
    if (toolBusy()) return;
    // a construction plane wins where its quad is exposed (same order as click-select)
    const datumId = viewport.pickDatumAt(x, y);
    if (datumId) return openDatumMenu(x, y, datumId);
    if (viewport.selecting === "bodies") {
      // plain mesh raycast (no edge priority) — must agree with left-click select,
      // else right-clicking on/near any edge of a body misses the body menu
      const bodyId = viewport.bodyIdAt(x, y);
      return bodyId ? openBodyMenu(x, y, bodyId) : openEmptyMenu(x, y);
    }
    const hit = viewport.pickEntity(x, y);
    if (hit?.kind === "edge") return openEdgeMenu(x, y, hit);
    if (hit?.kind === "face") return openFaceMenu(x, y, hit);
    openEmptyMenu(x, y);
  }

  return { openDatumMenu, openEdgeMenu, openFaceMenu, openBodyMenu, openEmptyMenu, openCanvasMenu };
}

export type ContextMenus = ReturnType<typeof createContextMenus>;
