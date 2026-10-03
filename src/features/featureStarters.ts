// Tool-starter functions: the ~20 "start a modeling tool" entry points (Sketch,
// Extrude, Fillet, Chamfer, Split, Combine, Revolve, Loft, Sweep, Primitive,
// Shell, Draft, Pattern, Scale, Move, Press/Pull…) plus the interactive
// plane/face pickers they share. Each closes over the same large set of
// singletons/state owned by main.ts, passed in once via createFeatureStarters.
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type * as THREE from "three";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { SketchMode, SketchTool } from "../sketch/sketchMode";
import { SketchPlane } from "../sketch/plane";
import type { ExtrudeTool } from "./extrudeTool";
import type { EdgeFeatureTool } from "./edgeFeatureTool";
import type { PressPullTool } from "./pressPullTool";
import type { LoftTool } from "./loftTool";
import type { MoveTool } from "./moveTool";
import type { PlaneOffsetTool } from "./planeOffsetTool";
import type { TextureTool } from "./textureTool";
import type { TextOnFaceTool } from "./textOnFaceTool";
import type { SplitTool } from "./splitTool";
import type { SplitSeed } from "./splitState";
import { choose } from "../ui/choice";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { DimInput } from "../sketch/dimInput";
import type { Feature, PlaneDef, PlaneSpec, Selector } from "../types";
import { findSelectorAt, picksByPosition, replaceSelectorAt } from "./repickReference";
import { datumPlaneDef, planeDefOf, planeOf } from "../document/planeOf";
import { moveSketchPlaneBlocker } from "../document/sketchPlaneEdits";
import { resolveEntities, resolveNum } from "../sketch/resolve";
import { entityPolyline } from "../sketch/region";
import { t } from "../i18n";
import { fieldText, getUnit } from "../ui/units";

/** Said out loud whenever a plane is picked off a curved face. The plane itself
 *  is real and usable (pickFacePlane returns the tangent), but nothing anchors
 *  it, so it will NOT follow later edits the way a planar-face pick does — and
 *  the two are indistinguishable on screen. Shared with contextMenus, which
 *  offers the same two entries from the right-click menu.
 *
 *  Two nouns, because the picker is shared by three flows: warning about "this
 *  sketch" while the user is placing a Datum Plane names a feature that is not
 *  being created. (Split Body no longer uses this picker: its panel refuses a
 *  curved face outright, because a split needs a plane.) */
export const CURVED_FACE_NOTE = t("feature.starters.curvedFaceSketch");
export const CURVED_FACE_NOTE_PLANE = t("feature.starters.curvedFacePlane");

/** The one wording for "another tool owns the app right now", shared by every
 *  surface that can refuse for that reason — the starters below, the ribbon
 *  paths that live in main.ts, and contextMenus' unlessBusy. There used to be
 *  two: right-clicking an edge and picking Fillet said one thing, clicking the
 *  Fillet button beside it said another, for the identical state. */
export const TOOL_BUSY_MESSAGE = t("feature.starters.toolBusy");

export interface FeatureStartersDeps {
  store: DocumentStore;
  viewport: Viewport;
  overlay: SketchOverlay;
  sketch: SketchMode;
  extrude: ExtrudeTool;
  edgeFeature: EdgeFeatureTool;
  pressPull: PressPullTool;
  loftTool: LoftTool;
  moveTool: MoveTool;
  planeOffset: PlaneOffsetTool;
  texture: TextureTool;
  textOnFace: TextOnFaceTool;
  split: SplitTool;
  canvas: HTMLCanvasElement;
  toolBusy: () => boolean;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
  selectFeature: (id: string | null) => void;
  /** Draw the inspector again without changing what it shows: a tool stopped,
   *  so it is no longer read-only (Inspector.lockReason). */
  refreshInspector: () => void;
  noteCommitted: (id: string | null) => void;
  isSketchConsumed: (id: string) => boolean;
  getSelectedFeature: () => string | null;
  setPlanePick: (v: boolean) => void;
}

export function createFeatureStarters(deps: FeatureStartersDeps) {
  const {
    store,
    viewport,
    overlay,
    sketch,
    extrude,
    edgeFeature,
    pressPull,
    loftTool,
    moveTool,
    planeOffset,
    texture,
    textOnFace,
    split,
    canvas,
    toolBusy,
    hasBody,
    setStatus,
    selectFeature,
    refreshInspector,
    noteCommitted,
    getSelectedFeature,
    setPlanePick,
  } = deps;

  /** The busy guard every entry point below opens with. It used to be a bare
   *  `if (toolBusy()) return;` at 22 sites, and that silence is the outage the
   *  cancelPlanePick comment records: a planePick flag left set made extrude,
   *  fillet, shell, press/pull, measure and section ALL dead — no message, no
   *  clue, until the app was restarted. A tool that refuses has to say so, even
   *  when refusing is correct.
   *
   *  Not an "error" class: this is a normal modal refusal, and setStatus
   *  breadcrumbs every error, which repeated clicks would flood. */
  /** "you need a body for this" — the companion to busy(), and one wording.
   *
   *  Eleven starters spelled this guard out by hand and the copies had already
   *  drifted into three phrasings of one sentence ("create or import", "import
   *  or create", and one with no tool name at all). Same reasoning as
   *  TOOL_BUSY_MESSAGE: a refusal the user reads should not depend on which
   *  button they happened to press. */
  /** `tool` is the DISPLAYED tool name, already translated (a `tool.*` key
   *  rendered by the caller), so the sentence never glues two languages. */
  const needsBody = (tool: string) => {
    if (hasBody()) return false;
    setStatus(t("feature.starters.needsBody", { tool }), "");
    return true;
  };

  const busy = () => {
    if (!toolBusy()) return false;
    setStatus(TOOL_BUSY_MESSAGE, "");
    return true;
  };

  /** The done callback of every tool below that CREATES a feature: remember
   *  the commit and select what it made. A cancel selects nothing, but the
   *  inspector still has to be drawn again, out of the read-only state the
   *  running tool put it in. */
  const created = (id: string | null) => {
    noteCommitted(id);
    if (id) selectFeature(id);
    else refreshInspector();
  };

  /** A create tool has just started, so the inspector stops offering whatever
   *  feature was selected before. Field 637278a9: a click on a side face selects
   *  the extrude that made it, that extrude stayed in the panel through Extrude,
   *  and its Start offset was the only one on screen, so typing one rewrote the
   *  OLD extrude. Called after start(): the one render this triggers then
   *  already sees the tool running, and draws the panel read-only. */
  const clearSelectionForCreate = () => selectFeature(null);

  // Interactive Fillet / Chamfer: pick an edge (or use a Ctrl-click pre-selection),
  // then drag an arrow to scrub the radius/distance with a live sidecar preview.
  const startFillet = () => {
    if (busy()) return;
    edgeFeature.start("fillet", created);
    clearSelectionForCreate();
  };
  const startChamfer = () => {
    if (busy()) return;
    edgeFeature.start("chamfer", created);
    clearSelectionForCreate();
  };
  // Interactive Press/Pull: pick a solid face, then drag an arrow along its normal
  // to add/cut material (planar) or offset a curved face — with a live preview.
  //
  // It is also a DISPATCHER, the mirror of startExtrude below: in Fusion, Press
  // Pull sends a profile to Extrude, a face to Offset Face and an edge to
  // Fillet. A field reporter asked for exactly that ("press/pull just the bolt
  // hole"), which was impossible while the tool only understood faces. The
  // dispatch lives HERE, before any tool is active — a tool that is already
  // `active` cannot start another, since every start() self-guards on it.
  const startPressPull = () => {
    if (busy()) return;
    // A selected FACE is Press/Pull's own job and wins. The right-click
    // "Press/Pull face" menu selects a face and then dispatches through here,
    // and viewport.selectOnlyFace clears only the highlighter — NOT the
    // overlay's region selection — so checking regions first would break it
    // for anyone with a sketch profile still selected.
    if (!viewport.selectedFacesForPressPull()) {
      if (viewport.selectedEdgeSelectors().length) {
        edgeFeature.start("fillet", created);
        clearSelectionForCreate();
        return;
      }
      if (overlay.selectedRegions().length) {
        extrude.start(created);
        clearSelectionForCreate();
        return;
      }
    }
    // Nothing pre-selected: arm the face tool, but let it hand the click back
    // if what the user clicks turns out to be an edge or a sketch profile.
    // Region picking cannot cover for this — viewport.regionPickAt bails on
    // toolBusy(), which includes pressPull.active.
    pressPull.start(created, (h) => {
      if (h.kind === "region") {
        overlay.toggleRegionSelection(h.region, false);
        extrude.start(created);
      } else {
        viewport.selectOnlyEdge(h.edge);
        edgeFeature.start("fillet", created);
      }
    });
    clearSelectionForCreate();
  };

  /** Abort an in-flight interactive plane pick, if any.
   *
   *  `planePick` is part of toolBusy(), and pickPlaneInteractive only clears it
   *  from its own canvas click or Escape. Choosing the plane in the BROWSER
   *  instead (tree.onSketchOnPlane) enters the sketch by a different route and
   *  left the flag set forever, so from then on every tool guarded by toolBusy()
   *  — extrude, fillet, shell, press/pull, measure, section — returned silently
   *  and did nothing at all, with no message, until the app was restarted. */
  function cancelPlanePick() {
    pendingPickCleanup?.();
  }

  let pendingPickCleanup: (() => void) | null = null;

  /** `onPick` receives the plane AND, when the click landed on a planar body
   *  face, the selector that names that face. The plane alone is a frozen
   *  placement: the sketch or datum built from it never moves again, which is
   *  GH #52 ("sketch on a face does not follow the face"). The selector is what
   *  lets the sidecar re-derive the plane every rebuild. Absent for the base
   *  planes (nothing to follow) and for curved faces (nothing to follow it
   *  BY — see viewport.faceAnchor), and the curved case says so out loud.
   *
   *  `datums` also offers the construction planes, for the one flow that wants
   *  them (Copy sketch to plane); `onPick` then gets the datum's id as the
   *  link to keep. The other pickers stay as they were: offering a datum to
   *  Sketch or Datum Plane would change what those buttons make. A body face
   *  still wins over a datum quad in front of it, the rule every pick that
   *  reads construction planes follows (viewport.pickDatumAt). Between a datum
   *  and a base plane the NEARER one wins: a datum's quad is sized to the
   *  model and floored at 80 mm, so "datum first" covered the 60 mm base
   *  planes from most views and left them unpickable. */
  function pickPlaneInteractive(
    promptText: string,
    onPick: (spec: PlaneSpec, face?: Selector, planeId?: string) => void,
    unanchoredNote: string | null = CURVED_FACE_NOTE,
    { datums = false }: { datums?: boolean } = {},
  ) {
    if (busy()) return;
    setPlanePick(true);
    viewport.showAllPlanes(true);
    viewport.suspendPicking = true;
    setPrompt(promptText);
    const datumAt = (x: number, y: number): string | null => {
      const hit = datums ? viewport.datumHitAt(x, y) : null;
      if (!hit) return null;
      const base = viewport.basePlaneHitAt(x, y);
      return base && base.distance < hit.distance ? null : hit.id;
    };
    const onMove = (e: PointerEvent) => {
      // a face of the body takes priority over the base-plane quads behind it;
      // highlight whichever the click would select so the target is obvious.
      const face = viewport.pickFacePlane(e.clientX, e.clientY);
      const datumId = face ? null : datumAt(e.clientX, e.clientY);
      if (datums) viewport.hoverDatum(datumId);
      if (face) {
        viewport.hoverFaceAt(e.clientX, e.clientY); // highlight a selectable body face
        viewport.hoverPlane(null);
      } else {
        viewport.clearHover();
        viewport.hoverPlane(datumId ? null : viewport.pickPlane(e.clientX, e.clientY));
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // a face of the body takes priority over the base-plane quads behind it
      const facePlane = viewport.pickFacePlane(e.clientX, e.clientY);
      const datumId = facePlane ? null : datumAt(e.clientX, e.clientY);
      const datum = datumId
        ? store.document.features.find((f): f is Extract<Feature, { type: "datumPlane" }> => f.id === datumId && f.type === "datumPlane")
        : undefined;
      const spec = facePlane ?? (datum ? datumPlaneDef(datum, store.buildState.result?.planes) : viewport.pickPlane(e.clientX, e.clientY));
      if (!spec) return;
      const anchor = facePlane ? viewport.faceAnchor(e.clientX, e.clientY, facePlane) : null;
      if (facePlane && !anchor && unanchoredNote) toast(unanchoredNote, { kind: "warning" });
      // consume this click fully and run on the NEXT frame, so it can't bleed
      // into the sketch's own first-corner placement.
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      requestAnimationFrame(() => onPick(spec, anchor ?? undefined, datum?.id));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
      pendingPickCleanup = null;
      setPlanePick(false);
      viewport.showAllPlanes(false);
      viewport.suspendPicking = false;
      viewport.clearHover();
      if (datums) viewport.hoverDatum(null);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    pendingPickCleanup = cleanup;
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  /** Sketch. A face the user has ALREADY selected IS the pick — the same rule
   *  startPressPull follows above, and the reason the two felt inconsistent:
   *  selecting a face and pressing Sketch used to throw the selection away and
   *  ask for the same face again.
   *
   *  Only when the selection names one plane unambiguously; anything else (no
   *  selection, several faces, a curved face, an unknown body — see
   *  viewport.selectedFaceSketchPlane) falls through to the interactive pick,
   *  which prompts for what it wants. */
  function startSketch(tool?: SketchTool) {
    if (busy()) return;
    const pre = viewport.selectedFaceSketchPlane();
    if (pre) {
      // the face has been consumed; leaving it painted would also leave it
      // armed for whichever tool is pressed after the sketch is closed.
      viewport.clearSelection();
      sketch.enter(pre.plane, store, undefined, undefined, pre.face);
      if (tool) sketch.setTool(tool);
      return;
    }
    pickPlaneInteractive(t("feature.starters.pickSketchPlane"), (spec, face) => {
      sketch.enter(spec, store, undefined, undefined, face);
      if (tool) sketch.setTool(tool);
    });
  }

  // Offset Plane: pick a plane/face, then drag an arrow (or type) to set the
  // offset, with a live ghost of the resulting plane; then sketch on it.
  //
  // It used to BAKE the distance into the resulting plane's origin — the scalar
  // was discarded, the source plane identity was lost, and nothing landed in the
  // timeline, so an offset plane could never be adjusted after the fact. It now
  // creates the same parametric `datumPlane` that the Datum Plane button and the
  // right-click "Offset plane from face" already created (source plane + an
  // editable scalar offset), and enters the sketch BY ID, so changing the offset
  // in the inspector moves the sketch with it.
  function offsetPlane() {
    pickPlaneInteractive(t("feature.starters.pickOffsetSource"), (spec, face) => {
      const src = new SketchPlane(spec);
      planeOffset.start(src, (def) => {
        if (!def) { refreshInspector(); return; }
        const id = store.nextId();
        // `face` rides on the DATUM, not the sketch: the datum is what owns the
        // source plane here, and the sketch follows it by id.
        store.addFeature({ id, type: "datumPlane", plane: spec, ...(face ? { face } : {}), offset: offsetAlong(def, src) } as Feature);
        sketch.enter(def, store, undefined, id);
      });
      clearSelectionForCreate();
    });
  }

  // Datum Plane: pick a plane/face, position it (offset), then save a persistent
  // datum plane feature — it lands in the timeline + Planes folder and can be
  // reused as a sketch / split reference. We store the SOURCE plane + a scalar
  // offset (not a baked plane) so the offset stays editable in the inspector.
  function createDatumPlane() {
    pickPlaneInteractive(t("feature.starters.pickDatumSource"), (spec, face) => {
      const src = new SketchPlane(spec);
      planeOffset.start(src, (def) => {
        if (!def) { refreshInspector(); return; }
        const id = store.nextId();
        store.addFeature({ id, type: "datumPlane", plane: spec, ...(face ? { face } : {}), offset: offsetAlong(def, src) } as Feature);
        selectFeature(id);
      });
      clearSelectionForCreate();
    }, CURVED_FACE_NOTE_PLANE);
  }

  // Right-click → "Offset plane from face": same as Datum Plane but the source is
  // the right-clicked face (no separate pick step) — so the caller, not a pick
  // here, supplies the face anchor.
  function offsetPlaneFromFace(face: PlaneDef, anchor?: Selector) {
    if (busy()) return;
    const src = new SketchPlane(face);
    planeOffset.start(src, (def) => {
      if (!def) { refreshInspector(); return; }
      const id = store.nextId();
      store.addFeature({ id, type: "datumPlane", plane: face, ...(anchor ? { face: anchor } : {}), offset: offsetAlong(def, src) } as Feature);
      selectFeature(id);
    });
    clearSelectionForCreate();
  }

  /** Sketch `id`, or null after saying it no longer exists: an entry point
   *  that refuses has to say why (see busy() above). */
  function sketchById(id: string): Extract<Feature, { type: "sketch" }> | null {
    const f = store.document.features.find((x) => x.id === id);
    if (f?.type === "sketch") return f;
    setStatus(t("feature.starters.sketchGone"), "");
    return null;
  }

  // Copy sketch to plane (right-click a sketch, Doug 27): pick a base plane, a
  // construction plane or a flat face, and a copy of the sketch lands on it with
  // its constraints, dimensions and parameter expressions. Projected geometry
  // comes across as plain curves (sketchPlaneEdits.copySketch).
  function copySketchToPlane(sketchId: string) {
    if (busy()) return;
    if (!sketchById(sketchId)) return;
    pickPlaneInteractive(t("feature.starters.pickCopyTarget"), (spec, face, planeId) => {
      const id = store.copySketchToPlane(sketchId, { plane: spec, ...(planeId ? { planeId } : {}), ...(face ? { face } : {}) });
      if (!id) { setStatus(t("feature.starters.sketchGone"), ""); return; }
      created(id);
    }, CURVED_FACE_NOTE, { datums: true });
  }

  // Move sketch plane (right-click a sketch, Doug L3): the Offset Plane arrow,
  // seated on the plane the sketch sits on now. Committing parks the sketch on
  // a datum plane (sketchPlaneEdits.moveSketchPlane) and selects it, so the
  // inspector shows the Offset that moves it from then on.
  function moveSketchPlane(sketchId: string) {
    if (busy()) return;
    const s = sketchById(sketchId);
    if (!s) return;
    // the same two refusals as opening the sketch to edit it (main.ts editFeature)
    if (store.isSuppressed(sketchId)) { setStatus(t("status.unsuppressToEdit"), ""); return; }
    if (store.document.features.indexOf(s) >= store.rollbackIndex) { setStatus(t("status.rollForwardToEdit"), ""); return; }
    const blocked = moveSketchPlaneBlocker(store.document, sketchId);
    if (blocked) { setStatus(blocked, ""); return; }
    // Where the sketch IS, not its cached `plane`: a face-anchored sketch has
    // moved with its face, and a datum's Offset may have been edited, since the
    // cache was written (planeOf).
    const from = planeDefOf(planeOf(s, store.buildState.result?.planes, store.document.features));
    const src = new SketchPlane(onSketchCurves(s, from));
    planeOffset.start(src, (def) => {
      const delta = def ? offsetAlong(def, src) : 0;
      // nothing moved: no datum to add and no undo step to leave behind
      if (!delta) { refreshInspector(); return; }
      const moved = store.moveSketchPlane(sketchId, delta, from);
      if (!moved) { setStatus(t("feature.starters.sketchGone"), ""); refreshInspector(); return; }
      if (moved.leftShared) toast(t("feature.starters.sketchPlaneDetached"));
      if (picksAfter(sketchId)) toast(t("feature.starters.sketchPlaneMovedPicks"), { kind: "warning" });
      created(moved.datumId);
    }, t("feature.planeOffset.moveSketchPrompt"));
    clearSelectionForCreate();
  }

  /** `plane` with its origin slid, within the plane, to the middle of sketch
   *  `s`'s curves: where Move sketch plane's arrow and Offset box stand. On a
   *  face the plane's own origin is the WORLD origin projected onto the face,
   *  which on a part away from the origin is off screen. The offset is
   *  measured along the normal, so this changes where the arrow is drawn and
   *  nothing about the value. A sketch with no curves (empty, or text only)
   *  keeps the plane's origin. */
  function onSketchCurves(s: Extract<Feature, { type: "sketch" }>, plane: PlaneDef): PlaneDef {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of resolveEntities(s, store.document.parameters).flatMap(entityPolyline)) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return plane;
    const c = new SketchPlane(plane).to3D((minX + maxX) / 2, (minY + maxY) / 2);
    return { ...plane, origin: [c.x, c.y, c.z] };
  }

  /** True when a feature after sketch `sketchId` finds its edges or faces by
   *  position (a fillet, chamfer, press/pull...). Moving the sketch moves its
   *  bodies, and such a pick can then land on a different edge or face with no
   *  error. A sketch, datum plane or split on a face is left out: the builder
   *  re-finds that face along its own normal (_face_anchored_plane), so it
   *  follows. Shifting the picks along with the body needs to know which
   *  bodies the sketch built, which nothing records yet. */
  function picksAfter(sketchId: string): boolean {
    const feats = store.document.features;
    return feats
      .slice(feats.findIndex((f) => f.id === sketchId) + 1)
      .some((f) => f.type !== "sketch" && f.type !== "datumPlane" && f.type !== "split" && picksByPosition(f));
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

  // Split Body: a docked panel with two fields, Body to split and Splitting
  // tool, filled by clicking the model or the Browser (splitTool.ts).
  //
  // It replaced three modal steps: "keep which side?", a list of every body by
  // name (340 near-identical names on an imported assembly), then a plane
  // pick. It also retires a trap: a selected datum plane used to switch this
  // command to "cut every visible body" there and then, with no way to say
  // which. A selected datum now just fills the Tool field, and "All visible
  // bodies" is a choice the user makes on purpose.
  //
  // `seed` is what a right-click already named: the Browser row a body menu
  // was opened on, or the datum a plane menu was opened on.
  function startSplit(seed?: SplitSeed) {
    if (busy()) return;
    if (needsBody(t("tool.split"))) return;
    const selId = getSelectedFeature();
    const sel = selId ? store.document.features.find((f) => f.id === selId) : null;
    split.start({ seed, selectedDatum: sel?.type === "datumPlane" ? sel.id : null }, created);
    clearSelectionForCreate();
  }

  // Combine: boolean-join/cut/intersect bodies. With exactly two bodies the first
  // is the (kept) target and the second the tool; with more, you pick the target
  // and the tool body so cut/intersect direction is unambiguous.
  async function startCombine() {
    if (busy()) return;
    const bodies = store.buildState.result?.bodies ?? [];
    if (bodies.length < 2) {
      setStatus(t("feature.starters.combine.needsTwo"), "");
      return;
    }
    const op = await choose<"join" | "cut" | "intersect">(t("feature.starters.combine.title"), [
      { value: "join", label: t("feature.op.join"), hint: t("feature.starters.combine.joinHint") },
      { value: "cut", label: t("feature.op.cut"), hint: t("feature.starters.combine.cutHint") },
      { value: "intersect", label: t("feature.op.intersect"), hint: t("feature.starters.combine.intersectHint") },
    ]);
    if (!op) return;

    // If the user already multi-selected bodies (Ctrl+click in the tree/viewport),
    // combine those directly: the first is the kept target, the rest are tools —
    // no dialogs. Otherwise fall back to picking a target (when ambiguous) and a
    // multi-select checklist of tool bodies.
    const pre = viewport.getSelectedBodies().filter((id) => bodies.some((b) => b.id === id));
    let target: string;
    let tools: string[];
    if (pre.length >= 2) {
      const first = pre[0];
      if (first === undefined) return;
      target = first;
      tools = pre.slice(1);
    } else {
      // ONE selected body (e.g. right-click → "Combine with…") is the kept target;
      // with none, pick a target when ambiguous. Tools come from the checklist.
      const t0 = pre[0] ?? bodies[0]?.id;
      if (t0 === undefined) return;
      target = t0;
      if (!pre.length && bodies.length > 2) {
        const picked = await chooseBody(t("feature.starters.combine.target"), bodies);
        if (!picked) return;
        target = picked;
      }
      const candidates = bodies.filter((b) => b.id !== target);
      if (candidates.length > 1) {
        const { chooseMulti } = await import("../ui/choice");
        const picked = await chooseMulti<string>(
          t("feature.starters.combine.tools"),
          candidates.map((b) => ({ value: b.id, label: store.bodyName(b.id) ?? b.name })),
          { min: 1, confirmLabel: t("tool.combine") },
        );
        if (!picked) return;
        tools = picked;
      } else {
        tools = candidates.map((b) => b.id);
      }
    }
    viewport.setSelectedBodies([]); // consumed tools would dangle; clear the selection
    // joinTouchingOnly: a new Combine keeps every piece it joins (types.ts).
    store.addFeature({ id: store.nextId(), type: "combine", operation: op, target, tools, joinTouchingOnly: true } as Feature);
  }

  /** Pick one body by name from the rebuild's body list (returns its id). Labels use
   *  the sidebar rename override (store.bodyName) so the picker matches the browser
   *  tree — otherwise a renamed "Bracket" shows as the default "Body1" here. */
  function chooseBody(title: string, bodies: { id: string; name: string }[]): Promise<string | null> {
    return choose<string>(title, bodies.map((b) => ({ value: b.id, label: store.bodyName(b.id) ?? b.name })));
  }

  // Simplify Mesh: merge near-coplanar facets of the active (imported) body into
  // fewer, larger faces. Tune the angular tolerance in the inspector (higher =
  // fewer faces, but coarsens curved regions).
  function startSimplifyMesh() {
    if (busy()) return;
    if (needsBody(t("tool.simplifyMesh"))) return;
    store.addFeature({ id: store.nextId(), type: "simplifyMesh", tolerance: 1 } as Feature);
  }

  // Clean Up: repair boolean rot on all bodies at this point in the timeline —
  // unify glued/overlapping solids, then collapse facet debris (slivers +
  // near-coplanar staircases). Booleans on ragged imports re-manufacture debris,
  // so run it again after a heavy Press/Pull / Combine session to keep Delete
  // Face and downstream booleans reliable. Best-effort in the sidecar: a body it
  // can't confidently clean passes through unchanged.
  function startCleanUp() {
    if (busy()) return;
    if (needsBody(t("tool.cleanUp"))) return;
    store.addFeature({ id: store.nextId(), type: "cleanUp", fit: 2 } as Feature);
    setStatus(t("feature.starters.cleanUpAdded"), "");
  }

  // Scale: resize the active body about the origin (handy for fixing the units of
  // an import). Default factor 1 — set it in the inspector.
  function startScale() {
    if (busy()) return;
    if (needsBody(t("tool.scale"))) return;
    store.addFeature({ id: store.nextId(), type: "scale", factor: 1 } as Feature);
  }

  // Move: translate / rotate the active body. Defaults to no-op — set the offsets
  // and angles in the inspector.
  function startMove() {
    if (busy()) return;
    if (needsBody(t("tool.move"))) return;
    const bodies = store.buildState.result?.bodies ?? [];
    let ids = viewport.getSelectedBodies();
    // A datum plane is a FEATURE, never a body, so it can never be in
    // getSelectedBodies() — and the "none selected → active body" convenience
    // below then silently started dragging an unrelated body instead. Selecting
    // an offset plane and reaching for Move is an obvious gesture (there is no
    // other way to move one), and it moved the wrong thing without a word.
    // Related: field report df10c0b3, "then move the offset plane and expect the
    // surface to move with the offset plane... does not visibly do this".
    if (!ids.length) {
      const sel = getSelectedFeature();
      const f = sel ? store.document.features.find((x) => x.id === sel) : null;
      if (f?.type === "datumPlane") {
        setStatus(t("feature.starters.move.datumPlane"), "");
        return;
      }
    }
    if (!ids.length && bodies.length) {
      const lastBody = bodies[bodies.length - 1];
      if (lastBody) ids = [lastBody.id]; // none selected → active body
    }
    if (!ids.length) {
      setStatus(t("feature.starters.move.selectBody"), "");
      return;
    }
    moveTool.start(ids, created);
    clearSelectionForCreate();
  }

  // Mirror: choose the symmetry plane (the backend honors XY/XZ/YZ; the old tool
  // was hard-coded to YZ). Mirrors the active body and unions the reflection.
  async function startMirror() {
    if (busy()) return;
    const hasSolid = hasBody();
    if (!hasSolid) {
      setStatus(t("feature.starters.mirror.needsBody"), "");
      return;
    }
    // XY / XZ / YZ are plane names, not prose — they stay as written.
    const plane = await choose<"XY" | "XZ" | "YZ">(t("feature.starters.mirror.title"), [
      { value: "XY", label: "XY" },
      { value: "XZ", label: "XZ" },
      { value: "YZ", label: "YZ" },
    ]);
    if (!plane) return;
    store.addFeature({ id: store.nextId(), type: "mirror", plane } as Feature);
  }

  // Revolve/Loft boolean into the active body (New/Join/Cut) the same way extrude
  // does, instead of the old silent overwrite of the active body's shape — so ask
  // upfront, same as the extrude op modal, just without the no-op-guess sorting.
  async function chooseSolidOperation(title: string): Promise<"new" | "join" | "cut" | null> {
    return choose<"new" | "join" | "cut">(title, [
      { value: "new", label: t("feature.op.newBody"), hint: t("feature.starters.solidOp.newHint") },
      { value: "join", label: t("feature.op.join"), hint: t("feature.starters.solidOp.joinHint") },
      { value: "cut", label: t("feature.op.cut"), hint: t("feature.starters.solidOp.cutHint") },
    ]);
  }

  // Revolve: spin a sketch profile around the X/Y/Z axis (defaults to a full 360°;
  // edit the angle in the inspector for a partial revolve). Uses the selected
  // profile area, or the only one if the sketch has just a single profile.
  async function startRevolve() {
    if (busy()) return;
    const regions = overlay.selectedRegions();
    const wr = regions[0] ?? (overlay.regions.length === 1 ? overlay.regions[0] : null);
    if (!wr) {
      setStatus(t("feature.starters.revolve.needsProfile"), "");
      return;
    }
    const axis = await choose<"X" | "Y" | "Z">(t("feature.starters.revolve.axisTitle"), [
      { value: "X", label: t("feature.starters.axis.x") },
      { value: "Y", label: t("feature.starters.axis.y") },
      { value: "Z", label: t("feature.starters.axis.z") },
    ]);
    if (!axis) return;
    const operation = await chooseSolidOperation(t("feature.starters.revolve.opTitle"));
    if (!operation) return;
    store.addFeature({
      id: store.nextId(), type: "revolve", sketch: wr.sketchId, axis, angle: 360, operation, joinTouchingOnly: true,
    } as Feature);
  }

  // Loft: interactive Fusion-style tool — click profiles in order, the loft
  // previews live once two are picked (see LoftTool). Any profiles already
  // selected in the model view seed the tool.
  function startLoft() {
    if (busy()) return;
    loftTool.start(created);
    clearSelectionForCreate();
  }

  type SketchFeature = Extract<Feature, { type: "sketch" }>;

  /** The circles in a sketch a helix can wind around: drawn, construction or
   *  projected, as long as they carry an id to be named by. */
  function helixCircles(sk: SketchFeature): { id: string; x: number; y: number; r: number }[] {
    const params = store.document.parameters;
    const out: { id: string; x: number; y: number; r: number }[] = [];
    for (const e of sk.entities) {
      if (!e.id) continue;
      if (e.type === "circle") {
        out.push({ id: e.id, x: resolveNum(e.x ?? 0, params), y: resolveNum(e.y ?? 0, params), r: resolveNum(e.radius, params) });
      } else if (e.type === "projected" && e.curve.kind === "circle") {
        out.push({ id: e.id, x: e.curve.x, y: e.curve.y, r: e.curve.r });
      }
    }
    return out;
  }

  /** Whether a sketch has a curve a plain sweep could follow. Mirrors the
   *  sidecar's path wire: construction geometry never joins it, and a circle
   *  or a rectangle only ever makes an area. */
  function hasPathCurve(sk: SketchFeature): boolean {
    return sk.entities.some((e) =>
      !e.construction &&
      (e.type === "line" || e.type === "arc" || e.type === "spline" || e.type === "polygon" || e.type === "slot" ||
        (e.type === "projected" && e.curve.kind !== "circle")));
  }

  // How many points of a profile's boundary the helix guesses probe, at most.
  // A thread profile is a handful of corners and gets every one; a circle's
  // many tessellated points are thinned to this.
  const PROFILE_PROBES = 16;

  /** A profile area's anchor point and points around its outer boundary, in
   *  world space. */
  function profileProbes(wr: WorldRegion): THREE.Vector3[] {
    const loop = wr.region.loop;
    const step = Math.max(1, Math.ceil(loop.length / PROFILE_PROBES));
    const out = [wr.interior3D];
    for (let i = 0; i < loop.length; i += step) {
      const p = loop[i]!;
      out.push(wr.plane.to3D(p.x, p.y));
    }
    return out;
  }

  // A helix's pitch and turns, asked before anything is committed, like the
  // shell thickness below: Enter straight away takes these.
  const HELIX_PITCH_MM = 1;
  const HELIX_TURNS = 10;
  let helixDim: DimInput | null = null;

  function askHelixSize(at: { x: number; y: number }): Promise<{ pitch: number; turns: number } | null> {
    const dim = (helixDim ??= new DimInput());
    // The busy flag the shell prompt holds, for the same reason: no other tool
    // may start underneath an open box, and every exit has to clear it.
    setPlanePick(true);
    setPrompt(t("feature.starters.sweep.helixPrompt"));
    return new Promise((resolve) => {
      const close = (size: { pitch: number; turns: number } | null) => {
        setPlanePick(false);
        setPrompt(null);
        dim.hide();
        window.removeEventListener("keydown", onEsc, true);
        resolve(size);
      };
      function onEsc(e: KeyboardEvent) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close(null);
      }
      window.addEventListener("keydown", onEsc, true);
      dim.show(
        [
          { name: "pitch", label: t("feature.dim.pitch"), kind: "length" },
          { name: "turns", label: t("feature.dim.turns"), kind: "count" },
        ],
        () => {
          const pitch = dim.getValue("pitch");
          const turns = dim.getValue("turns");
          if (pitch === null || turns === null || !(pitch > 0) || !(turns > 0)) {
            close(null);
            setStatus(t("feature.starters.sweep.helixZero"), "");
            return;
          }
          close({ pitch, turns });
        },
        () => close(null),
      );
      dim.position(at.x, at.y);
      dim.seed("pitch", HELIX_PITCH_MM);
      dim.seed("turns", HELIX_TURNS);
      dim.focus();
    });
  }

  /** Sweep a profile around a helix on one of `circles` in `pathSketch` (Doug
   *  30: cutting internal threads into 3D-printed parts). Asks which circle
   *  when there are several, then the pitch and turns, then the operation. */
  async function startHelixSweep(
    wr: WorldRegion,
    pathSketch: SketchFeature,
    circles: { id: string; x: number; y: number; r: number }[],
  ) {
    let circle = circles[0];
    if (circles.length > 1) {
      const picked = await choose<string>(
        t("feature.starters.sweep.pickCircle"),
        circles.map((c, i) => ({
          value: c.id,
          label: t("feature.starters.sweep.circleLabel", { n: i + 1, d: fieldText(2 * c.r), unit: getUnit() }),
        })),
      );
      circle = circles.find((c) => c.id === picked);
    }
    if (!circle) return;
    const plane = new SketchPlane(planeOf(pathSketch, store.buildState.result?.planes));
    const size = await askHelixSize(viewport.projectToScreen(plane.to3D(circle.x, circle.y)));
    if (!size) return;
    // Guessed from the profile's own area, the way Extrude guesses: a profile
    // with material in it, or a pitch either way along the axis, is cutting a
    // thread; one in the open is a coil. Probed around its boundary as well as
    // at its anchor point. A thread profile is thin and reaches into the bore,
    // so the anchor alone can sit in the hole or the air while the tip is in
    // the wall (one drawn ON a face straddles it, and the anchor lands on the
    // surface, where inside and outside is a coin toss).
    const probes = profileProbes(wr);
    const solidAt = (shift: number) =>
      probes.some((p) => viewport.pointInSolid(p.clone().addScaledVector(plane.n, shift)));
    const ahead = solidAt(size.pitch);
    const behind = solidAt(-size.pitch);
    const guess = solidAt(0) || ahead || behind ? "cut" : "new";
    const ops = [
      { value: "cut" as const, label: t("feature.op.cut"), hint: t("feature.starters.solidOp.cutHint") },
      { value: "join" as const, label: t("feature.op.join"), hint: t("feature.starters.solidOp.joinHint") },
      { value: "new" as const, label: t("feature.op.newBody"), hint: t("feature.starters.solidOp.newHint") },
    ];
    ops.sort((a, b) => (a.value === guess ? -1 : b.value === guess ? 1 : 0)); // default first
    const operation = await choose(t("feature.starters.sweep.helixOpTitle"), ops);
    if (!operation) return;
    // Which way the helix runs follows from what it is for, so it is decided
    // only once the operation is known. It runs along the circle's normal
    // unless the material says otherwise. A Cut runs INTO the material: a
    // circle drawn on a part's top face points out of the part, and a thread
    // cut along it would cut nothing. A Join or a New Body runs into the OPEN:
    // a coil standing on a plate grows up off it, not down through it. Flip
    // direction in the Inspector undoes either guess, and a Cut that misses
    // says so.
    const flip = operation === "cut" ? behind && !ahead : ahead && !behind;
    store.addFeature({
      id: store.nextId(), type: "sweep", profile: wr.sketchId, path: pathSketch.id,
      helixCircle: circle.id, pitch: size.pitch, turns: size.turns, ...(flip ? { flip: true } : {}), operation,
      joinTouchingOnly: true, // a new sweep joins only what it touches (types.ts)
    } as Feature);
  }

  // Sweep: select a closed profile region, then pick a second (open) sketch as the
  // path — or pre-select BODY EDGES in the viewport and they become the path
  // instead (#16). The profile should sit at the start of the path, roughly
  // perpendicular. A path sketch with a circle in it can be a HELIX instead:
  // the profile winds around the circle's axis (Doug 30).
  async function startSweep() {
    if (busy()) return;
    const regions = overlay.selectedRegions();
    const wr = regions[0] ?? (overlay.regions.length === 1 ? overlay.regions[0] : null);
    if (!wr) {
      setStatus(t("feature.starters.sweep.needsProfile"), "");
      return;
    }
    // Edges win over a sketch path when both are available: picking edges is an
    // explicit act aimed at this command, whereas a path sketch merely exists in
    // the document. Same pre-selection the Fillet/Chamfer hint advertises, so
    // there is nothing new to learn — and it is the only route to a path that
    // does not lie in a plane, which is what was asked for.
    const pathEdges = viewport.selectedEdgeSelectors();
    if (pathEdges.length) {
      store.addFeature({
        id: store.nextId(), type: "sweep", profile: wr.sketchId, pathEdges, operation: "new", joinTouchingOnly: true,
      } as Feature);
      viewport.clearSelection(); // consumed — leaving it lit would re-apply on the next run
      return;
    }
    const all = store.document.features.filter((f) => f.type === "sketch");
    const candidates = all.filter((f) => f.id !== wr.sketchId);
    if (candidates.length === 0) {
      setStatus(t("feature.starters.sweep.needsPath"), "");
      return;
    }
    const label = (id: string) => t("feature.starters.sweep.sketchLabel", { n: all.findIndex((f) => f.id === id) + 1 });
    const c0 = candidates[0];
    if (!c0) return;
    let pathId = c0.id;
    if (candidates.length > 1) {
      const picked = await choose<string>(t("feature.starters.sweep.pickPath"), candidates.map((f) => ({ value: f.id, label: label(f.id) })));
      if (!picked) return;
      pathId = picked;
    }
    // A circle with nothing else to follow can only mean a helix. With both,
    // following the curves stays first: it is what the same sketch did before.
    const pathSketch = candidates.find((f) => f.id === pathId) as SketchFeature;
    const circles = helixCircles(pathSketch);
    if (circles.length) {
      const kind = hasPathCurve(pathSketch)
        ? await choose<"path" | "helix">(t("feature.starters.sweep.pathOrHelix"), [
            { value: "path", label: t("feature.starters.sweep.followPath"), hint: t("feature.starters.sweep.followPathHint") },
            { value: "helix", label: t("feature.starters.sweep.helix"), hint: t("feature.starters.sweep.helixHint") },
          ])
        : "helix";
      if (!kind) return;
      if (kind === "helix") return startHelixSweep(wr, pathSketch, circles);
    }
    store.addFeature({
      id: store.nextId(), type: "sweep", profile: wr.sketchId, path: pathId, operation: "new", joinTouchingOnly: true,
    } as Feature);
  }

  // Primitive: drop a Box / Cylinder / Sphere body at the origin (edit its size in
  // the inspector). Useful as a starting block or as a boolean tool body.
  async function startPrimitive() {
    if (busy()) return;
    const shape = await choose<"box" | "cylinder" | "sphere">(t("feature.starters.primitive.title"), [
      { value: "box", label: t("tool.box"), hint: t("feature.starters.primitive.boxHint") },
      { value: "cylinder", label: t("tool.cylinder"), hint: t("feature.starters.primitive.cylinderHint") },
      { value: "sphere", label: t("tool.sphere"), hint: t("feature.starters.primitive.sphereHint") },
    ]);
    if (!shape) return;
    const id = store.nextId();
    if (shape === "box") store.addFeature({ id, type: "box", length: 20, width: 20, height: 20 } as Feature);
    else if (shape === "cylinder") store.addFeature({ id, type: "cylinder", radius: 10, height: 20 } as Feature);
    else store.addFeature({ id, type: "sphere", radius: 10 } as Feature);
  }

  // One-shot face picker: highlight the face under the cursor, return its selector
  // on click (Esc cancels). Reused by Shell (open face) and Draft (taper face).
  // The click position rides along so a caller that opens an input next can put
  // it where the user just clicked.
  function pickFaceInteractive(
    promptText: string,
    onPick: (sel: Selector, at: { x: number; y: number }) => void,
  ) {
    if (busy()) return;
    if (needsBody(t("tool.shell"))) return;
    setPlanePick(true);
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
      // Stamp the body that owns the clicked face. Without it the sidecar falls
      // back to the active (last-created) body and the face selector resolves
      // against the wrong shape — so on a multi-body model the shell/draft would
      // land on a body the user never touched (same fault as the texture bug).
      const sel: Selector = hit.bodyId ? { ...hit.selector, body: hit.bodyId } : hit.selector;
      const at = { x: e.clientX, y: e.clientY };
      requestAnimationFrame(() => onPick(sel, at));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
      setPlanePick(false);
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

  // Repair an ambiguous saved reference: the rebuild refused to guess between two
  // equally-close faces, so ask the user which one they meant and swap that ONE
  // selector. Everything else about the feature is left alone.
  //
  // Only the selector the sidecar named is touched — located by its stored point,
  // not by index (see repickReference.ts). If it can't be found the feature has
  // moved on since the failed build (already re-picked, or edited), which is not
  // an error: say so and do nothing rather than "repairing" the wrong reference.
  function repickReference(featureId: string, at: readonly number[]) {
    const feature = store.document.features.find((f) => f.id === featureId);
    if (!feature) {
      // The feature itself is gone (undone, or deleted while the "Re-pick face"
      // toast was still up). Same situation as the missing-site branch below and
      // it must answer the same way — this used to be a bare `return`, so the
      // toast's own button did nothing at all.
      setStatus(t("feature.starters.repick.featureGone"), "");
      return;
    }
    const site = findSelectorAt(feature, at);
    if (!site) {
      setStatus(t("feature.starters.repick.referenceChanged"), "");
      return;
    }
    pickFaceInteractive(t("feature.starters.repick.pickFace"), (sel) => {
      // Re-read the feature: the pick is async, and the doc may have moved under
      // us (undo, another edit). Re-locating also re-validates the site.
      const cur = store.document.features.find((f) => f.id === featureId);
      if (!cur) return;
      const site2 = findSelectorAt(cur, at);
      if (!site2) {
        setStatus(t("feature.starters.repick.referenceChanged"), "");
        return;
      }
      store.updateFeature(featureId, replaceSelectorAt(cur, site2, sel));
    });
  }

  // Shell: pick a face to open, then set the wall thickness before anything is
  // committed.
  //
  // It used to add the feature with a hardcoded `thickness: 2` the instant the
  // face was picked, and the only way to see or change that number was to find
  // the feature in the inspector afterwards. So the tool silently chose a
  // dimension for you, and nothing on screen ever said what it was — every other
  // tool that takes a value (fillet, chamfer, press/pull, face offset) asks for
  // it with a DimInput first.
  const SHELL_THICKNESS_MM = 2;
  let shellDim: DimInput | null = null;

  function startShell() {
    pickFaceInteractive(t("feature.starters.shell.pickFace"), (faces, at) => {
      askShellThickness(faces, at);
    });
  }

  function askShellThickness(faces: Selector, at: { x: number; y: number }) {
    const dim = (shellDim ??= new DimInput());
    // Hold the busy flag across the prompt, the same one the face pick held, so
    // no other tool can start underneath an open box. EVERY exit path has to
    // clear it: a planePick left set disables the whole toolbar silently, which
    // has already been shipped once.
    setPlanePick(true);
    setPrompt(t("feature.starters.shell.thicknessPrompt"));

    const close = () => {
      setPlanePick(false);
      setPrompt(null);
      dim.hide();
      window.removeEventListener("keydown", onEsc, true);
    };
    // DimInput deliberately leaves Escape to the owning tool, so without this
    // the box has no way out except committing. Deliberately NOT gated on the
    // box owning the event target: if focus has wandered, Esc must still be able
    // to release the tool rather than stranding it.
    function onEsc(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
    window.addEventListener("keydown", onEsc, true);

    dim.show(
      [{ name: "thickness", label: t("feature.dim.thickness"), kind: "length" }],
      () => {
        const thickness = dim.getValue("thickness");
        close();
        if (thickness === null || !(thickness > 0)) {
          setStatus(t("feature.starters.shell.thicknessZero"), "");
          return;
        }
        store.addFeature({ id: store.nextId(), type: "shell", thickness, faces } as Feature);
      },
      close,
    );
    dim.position(at.x, at.y);
    // Seed the old default so pressing Enter straight away behaves exactly as
    // before; focus() re-selects it so typing replaces the value, not appends.
    dim.seed("thickness", SHELL_THICKNESS_MM);
    dim.focus();
  }

  // Draft: pick a face to taper by 5° about the body's base (pull +Z; edit the
  // angle in the inspector).
  function startDraft() {
    pickFaceInteractive(t("feature.starters.draft.pickFace"), (faces) => {
      store.addFeature({ id: store.nextId(), type: "draft", faces, angle: 5, axis: "Z" } as Feature);
    });
  }

  // Texture: printed surface texture (knurl/hex/waves/ribs/voronoi/noise/image
  // heightmap) over selected faces or a whole body. No pick-then-drag gesture
  // like Shell/Draft — it rides the ambient selection with a docked panel
  // (click/Ctrl-click faces, or toggle Whole Body in the panel), so it just
  // hands off to the tool directly.
  function startTexture() {
    if (busy()) return;
    if (needsBody(t("tool.texture"))) return;
    texture.start(created);
    clearSelectionForCreate();
  }

  // Text on Face: click a face, type, and the text is embossed or engraved into
  // it. Owns its own face pick (like Press/Pull) rather than riding the ambient
  // selection, because the CLICK POINT — not just which face — decides where the
  // glyphs land.
  function startTextOnFace() {
    if (busy()) return;
    if (needsBody(t("tool.textOnFace"))) return;
    textOnFace.start(created);
    clearSelectionForCreate();
  }

  // Pattern: replicate the active body — rectangular grid or circular array. Edit
  // counts / spacing / angle in the inspector.
  async function startPattern() {
    if (busy()) return;
    if (needsBody(t("tool.pattern"))) return;
    const kind = await choose<"rect" | "circular">(t("feature.starters.pattern.title"), [
      { value: "rect", label: t("feature.starters.pattern.rect"), hint: t("feature.starters.pattern.rectHint") },
      { value: "circular", label: t("feature.starters.pattern.circular"), hint: t("feature.starters.pattern.circularHint") },
    ]);
    if (!kind) return;
    addBodyPattern(kind);
  }

  /** The same body pattern, when the caller already knows which kind — the
   *  ribbon's "Rect Pattern" / "Circular Pat." buttons name it, so asking again
   *  would be a dialog with one sensible answer. Speaks if there is no body. */
  function startBodyPattern(kind: "rect" | "circular") {
    if (busy()) return;
    if (needsBody(t(kind === "rect" ? "tool.patternRect" : "tool.patternCircular"))) return;
    addBodyPattern(kind);
  }

  function addBodyPattern(kind: "rect" | "circular") {
    const id = store.nextId();
    if (kind === "rect") {
      store.addFeature({ id, type: "patternRect", countX: 3, countY: 1, spacingX: 30, spacingY: 30 } as Feature);
    } else {
      store.addFeature({ id, type: "patternCircular", count: 4, angle: 360, axis: "Z" } as Feature);
    }
    selectFeature(id); // land in the inspector, where the counts and spacing are
  }

  function startExtrude() {
    if (busy()) return;
    // A SELECTED FACE wins over a plain region extrude, so a visible sketch never
    // hijacks "extrude this face" (was: a shown sketch forced region-extrude, so
    // face cut did nothing).
    const sel = viewport.selectedFacesForPressPull();
    if (sel) {
      // …EXCEPT when the selected face sits ON or BEHIND a visible sketch's
      // plane (same-direction normals): faces win general picks, so a click
      // aimed at a sketch profile lying on that face selects the face instead —
      // and hijacking to Press/Pull forced users to hide the body to extrude a
      // sketch. The sketch has priority when it's on or above the face.
      const underSketch = overlay.regions.some((wr) => {
        if (wr.plane.n.dot(sel.normal) < 0.99) return false; // same-facing planes only
        return wr.plane.plane.distanceToPoint(sel.anchor) <= 0.01; // face on/behind the sketch plane
      });
      if (!underSketch) {
        // One flat face with a visible profile parallel to it to extrude: the
        // extrude STARTS from that face (GH #41 a), the lid on top of the box,
        // in the Extrude panel. Anything else (several faces, a curved one, no
        // visible profile it could start, which is the usual state once a
        // sketch has been extruded and hides) pushes the face itself, as
        // before. That is Press/Pull, with no start offset, so it is NOT the
        // start offset field 637278a9 asked for while extruding a face itself.
        const flat = sel.bodyId ? viewport.selectedFaceSketchPlane() : null;
        const startable = flat && overlay.regions.some((wr) => Math.abs(wr.plane.n.dot(sel.normal)) > 1 - 1e-4);
        if (flat && startable && sel.bodyId) {
          extrude.start(created, {
            fromFace: { selector: flat.face, bodyId: sel.bodyId, normal: sel.normal.clone(), anchor: sel.anchor.clone() },
          });
          clearSelectionForCreate();
          return;
        }
        pressPull.start(created);
        clearSelectionForCreate();
        return;
      }
    }
    if (overlay.regions.length === 0) {
      setStatus(t("feature.extrude.needsProfile"), "");
      return;
    }
    extrude.start(created);
    clearSelectionForCreate();
  }

  return {
    cancelPlanePick,
    startFillet,
    startChamfer,
    startPressPull,
    startSketch,
    offsetPlane,
    createDatumPlane,
    offsetPlaneFromFace,
    copySketchToPlane,
    moveSketchPlane,
    startSplit,
    startCombine,
    startSimplifyMesh,
    startCleanUp,
    startScale,
    startMove,
    startMirror,
    startRevolve,
    startLoft,
    startSweep,
    startPrimitive,
    startShell,
    startDraft,
    startTexture,
    startTextOnFace,
    startPattern,
    startBodyPattern,
    startExtrude,
    repickReference,
  };
}

export type FeatureStarters = ReturnType<typeof createFeatureStarters>;
