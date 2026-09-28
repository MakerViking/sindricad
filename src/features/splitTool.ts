// Split Body: the docked panel's tool (plan section B).
//
// Two fields filled by clicking — the bodies to split, and the plane or flat
// face to split them with — plus an offset and which side to keep. The panel
// DOM is splitPanel.ts and every decision is in splitState.ts; this file wires
// them to the canvas, the Browser and the keyboard, draws the preview, and
// writes the feature.
//
// What it owns while active, and why each one:
//  - canvas clicks. viewport picking is suspended and the tool raycasts itself,
//    so a click fills the ACTIVE field whichever selection mode (Faces/Bodies)
//    the viewport is in. Only OK or Enter commits: a stray click picks a body or
//    a plane, it never cuts.
//  - Browser row clicks (tree.pickHook). An origin-plane row would otherwise
//    start a sketch in the middle of the command.
//  - Enter and Escape, in the capture phase, IME-safe like the other tools.
//
// The preview is frontend-only on purpose: the plane clipped to the targets'
// box, the targets painted as selected, and the offset arrow, which always
// points to the side "Above" names. A real rebuild takes ~3 s on the
// 908-solid body the plan measured, too slow to follow a drag.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, PlaneDef, Plane3 } from "../types";
import type { TreePick } from "../ui/browserTree";
import { SketchPlane } from "../sketch/plane";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { snap } from "../ui/units";
import { t } from "../i18n";
import { isEditableTarget, isImeComposing } from "../ui/focus";
import { outsideRect, overlayHost } from "../viewport/overlayHost";
import { axisDragDistance } from "./manipulator";
import { buildOffsetArrow, disposeOffsetArrow, OFFSET_ARROW_LENGTH_PX, type OffsetArrow } from "./offsetArrow";
import { HANDLE_HOT, HANDLE_IDLE, PLANE_PREVIEW } from "../viewport/colors3d";
import { SplitPanel, type SplitPanelView } from "./splitPanel";
import {
  activate, buildSplitFeature, chooseToolHit, clearField, editedSplit, firstEmptyField, hasTargets, initialSplitState,
  pickBody, pickTool, planeBoxSection, planeMissesBox, resultingPieces, setAllVisible,
  stateFromFeature, type BodyStamp, type Box, type SplitFeatureShape, type SplitSeed, type SplitState, type SplitToolRef,
} from "./splitState";

/** The codes whose message tells the user to edit an old split and press OK to
 *  cut it part by part (builder._legacy_failed, splitLegacyVolume). */
const CONVERT_ON_OK = new Set(["splitLegacyFailed", "splitLegacyVolume"]);

const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** Pixels a press may travel and still be a click, same as the viewport's. */
const CLICK_SLOP_PX = 3;

export interface SplitToolDeps {
  viewport: Viewport;
  store: DocumentStore;
  /** install (or with null, remove) the Browser's row interceptor */
  setTreePick: (fn: ((pick: TreePick) => boolean) | null) => void;
  /** a datum plane's placement as the last build resolved it, or null */
  datumPlane: (id: string) => PlaneDef | null;
  /** the name the Browser shows for a datum ("Plane2", or its rename) */
  datumName: (id: string) => string;
}

function toBox(b: THREE.Box3): Box {
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}

export class SplitTool {
  active = false;
  private state: SplitState | null = null;
  private onDone: ((id: string | null) => void) | null = null;
  private panel = new SplitPanel();

  // --- edit mode (re-opening a committed split) ---
  private editId: string | null = null;
  /** the edited split's own groupSides, carried over unchanged (see
   *  buildSplitFeature: positional body ids) */
  private editGroupSides: boolean | undefined = undefined;
  /** the split as it stood when the edit began, and the body the panel filled
   *  in for an old split that named none (see editedSplit) */
  private editOriginal: SplitFeatureShape | null = null;
  private editAutoBody: string | null = null;
  /** the old split's last build said "edit it and press OK" (CONVERT_ON_OK) */
  private editConvert = false;
  /** the bodies the edited split was saved with: not picked in this panel, so
   *  exempt from missedBody (an old "Cut all bodies" names every visible body,
   *  and refusing OK until the ones its plane misses were Ctrl-clicked out made
   *  "edit the split and press OK" impossible) */
  private savedTargets = new Set<string>();
  private awaitingRollback = false;
  private unsubBuild: (() => void) | null = null;

  /** the body selection before the tool painted its targets, put back on Cancel */
  private priorSelection: string[] = [];
  /** the selected face that filled Tool when the panel opened, taken out of the
   *  selection and put back on Cancel; and the build it was a face of, since a
   *  rebuild renumbers faces (and drops the selection) */
  private consumedFaces: number[] = [];
  private consumedFrom: unknown = null;

  // --- preview ---
  private fill: THREE.Mesh | null = null;
  private outline: THREE.LineLoop | null = null;
  private arrow: OffsetArrow | null = null;
  private aboveEl: HTMLDivElement | null = null;
  /** the tool's plane at offset 0 */
  private base: { origin: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  /** the targets' world box */
  private box: THREE.Box3 | null = null;
  /** each explicitly picked body's own box, when there are several (missedBody) */
  private bodyBoxes: [string, THREE.Box3][] = [];
  /** where the arrow's drag axis passes through the base plane */
  private anchor = new THREE.Vector3();
  private raf = 0;
  private lastTick = "";

  // --- pointer ---
  private downPos = { x: 0, y: 0 };
  private downOnArrow = false;
  private grabbing = false;
  private grabValue = 0;
  private grabProj = 0;
  private hovering = false;
  private hoverRaf = 0;
  private hoverEvent: PointerEvent | null = null;
  private showingOrigin = false;

  private boundMove = (e: PointerEvent) => this.onMove(e);
  private boundDown = (e: PointerEvent) => this.onDown(e);
  private boundUp = (e: PointerEvent) => this.onUp(e);
  // While the offset arrow is held, the release is listened for on the WINDOW:
  // let go over the docked panel, the Browser or the timeline and the canvas
  // never hears it, and the arrow stayed latched, following the bare cursor
  // (the extrude tool's field report 3998d6ea, same class).
  private boundGrabEnd = () => this.endGrab();
  private boundTick = () => this.tick();
  // Capture phase on `document`: Enter and Escape are the tool's for its whole
  // lifetime, including the rollback wait of an edit before the panel exists,
  // and main.ts's own Escape handlers are all gated off by toolBusy().
  private keyHandler = (e: KeyboardEvent) => {
    if (!this.active || isImeComposing(e)) return;
    // A text field OUTSIDE the panel keeps its own Enter and Escape: the Ctrl+K
    // palette, a Browser rename, an inspector field. Taken here, Enter in the
    // palette committed the split and Escape in it cancelled the whole command.
    // The panel's own fields (Offset) still commit on Enter.
    if (isEditableTarget(e.target) && !this.panel.owns(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    } else if (e.key === "Enter") {
      // Enter is OK wherever focus is, including a Keep chip just clicked:
      // leaving it to the focused button would toggle that chip again and
      // commit nothing. The one exception is a focused Cancel, whose own Enter
      // (a click on it) means cancel.
      if (e.target === this.panel.cancelButton) return;
      e.preventDefault();
      e.stopPropagation();
      this.commit();
    }
  };

  constructor(private deps: SplitToolDeps) {
    // New, Open and Close do not end a modeling tool on their own. Left open,
    // the panel held the old document's body and datum ids with Enter armed, so
    // OK wrote a split naming bodies the new document does not have.
    deps.store.onReplace(() => this.cancel());
  }

  private get viewport() {
    return this.deps.viewport;
  }
  private get store() {
    return this.deps.store;
  }

  /** Open the panel for a new split. `selectedDatum` is the selected feature
   *  when it is a datum plane (main.ts owns that selection). */
  start(opts: { seed?: SplitSeed | undefined; selectedDatum: string | null }, onDone: (id: string | null) => void) {
    if (this.active) return;
    const live = (this.store.buildState.result?.bodies ?? []).map((b) => b.id);
    this.priorSelection = this.viewport.getSelectedBodies();
    this.state = initialSplitState({
      seed: opts.seed,
      selectedBodies: this.priorSelection,
      liveBodies: live,
      selectedDatum: opts.selectedDatum,
      selectedFace: this.viewport.selectedFaceSketchPlane(),
    });
    this.active = true;
    this.onDone = onDone;
    this.editId = null;
    this.editGroupSides = undefined;
    this.editOriginal = null;
    this.editAutoBody = null;
    this.editConvert = false;
    this.savedTargets = new Set();
    // A datum that arrives from a right-click menu or the selection goes
    // through the same check as a clicked one. The Browser offers "Split bodies
    // with this plane…" on every datum row, suppressed ones and ones past the
    // rollback marker included, and taken unchecked it drew a preview, took OK
    // and wrote a split that went red with splitNoPlane.
    const refused = this.dropRefusedDatum();
    if (refused) toast(refused, { kind: "warning" });
    // The face that filled Tool is consumed; left lit it would read as a second
    // selection the command is also acting on. ONLY that face: an edge or a
    // face the command did not take stays selected (it cleared the whole face
    // and edge selection, and Cancel gave back only the bodies).
    this.consumedFaces = this.state.tool?.kind === "face" ? this.viewport.getSelectedFaceIds() : [];
    this.consumedFrom = this.store.buildState.result;
    if (this.consumedFaces.length) this.viewport.deselectFaces(this.consumedFaces);
    this.begin(false);
    // A build landing mid-tool (a body shown or hidden from the Browser's eye)
    // repaints the model, dropping the targets' paint, and can change what
    // "All visible" counts and where the plane is drawn.
    this.unsubBuild = this.store.onBuild((s) => {
      if (!s.building && s.result) this.refresh();
    });
  }

  /** Re-open a committed split with its values. The model rolls back to just
   *  before it, so the targets are whole again and pickable by the ids the
   *  feature names; OK replaces the feature in place (same id, one undo step).
   *  Returns false when the split's offset is a parameter expression — that is
   *  the inspector's job, as for every other tool. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "split") return false;
    if (this.store.isParamBound({ kind: "feature", feature: f.id, field: "offset" })) return false;
    // A face-anchored split's cut follows its face, and only the last build
    // knows where that face IS now: `f.plane` is where it was when it was
    // picked. Read BEFORE the rollback, whose build does not contain the split.
    const last = this.store.buildState.result;
    const resolved = last?.planes?.[featureId];
    const state = stateFromFeature(f as SplitFeatureShape, resolved);
    if (!state) return false;
    this.active = true;
    this.onDone = onDone;
    this.editId = featureId;
    this.editGroupSides = f.groupSides;
    this.editOriginal = f as SplitFeatureShape;
    this.editAutoBody = null;
    // Read, like `resolved`, before the rollback, whose build has no split in it.
    this.editConvert = [...(last?.featureErrors ?? []), ...(last?.diagnostics ?? [])].some(
      (e) => e.feature_id === featureId && CONVERT_ON_OK.has(e.code ?? ""),
    );
    this.savedTargets = new Set(state.bodies);
    this.state = state;
    // Its datum may have been deleted, suppressed, or moved after the split
    // since it was made (the split is red with splitNoPlane then). Shown as
    // the Tool, the field read as validly filled and OK wrote the dead planeId
    // straight back. Empty and lit instead, with the reason.
    const refused = this.dropRefusedDatum();
    if (refused) toast(refused, { kind: "warning" });
    this.priorSelection = this.viewport.getSelectedBodies();
    this.awaitingRollback = true;
    setPrompt(t("feature.rollingBack"));
    document.addEventListener("keydown", this.keyHandler, true);
    // Which settle is the ROLLED-BACK model: the first one after a build seen
    // starting, skipping a build that was already running, which settles
    // first with the whole timeline in it (the same rule as afterBuild). Read
    // as the rollback, that model gave an old split with no body the LAST body
    // of the full model, and OK wrote that id into the feature.
    const wasBuilding = this.store.buildState.building;
    this.store.beginEditPreview(featureId);
    let skips = wasBuilding ? 1 : 0;
    let armed = this.store.buildState.building;
    let live = false; // onBuild replays the current state synchronously; that is not news
    this.unsubBuild = this.store.onBuild((s) => {
      if (!live) return;
      if (s.building) {
        armed = true;
        return;
      }
      if (!s.result) return;
      if (this.awaitingRollback) {
        if (!armed) return;
        armed = false;
        if (skips > 0) {
          skips--;
          return;
        }
        this.awaitingRollback = false;
        // An older split named no body and cut "the active one", which the
        // sidecar takes to be the LAST body. Show that body, so the field says
        // what the feature does, and OK writes it down explicitly.
        if (this.state && !hasTargets(this.state)) {
          const last = s.result.bodies?.at(-1)?.id;
          if (last) {
            this.editAutoBody = last;
            this.state = { ...this.state, bodies: [last], active: firstEmptyField({ ...this.state, bodies: [last] }) };
          }
        }
        this.begin(true);
      } else {
        this.refresh();
      }
    });
    live = true;
    return true;
  }

  /** Everything both entry points do once the model is where it should be. */
  private begin(editing: boolean) {
    const el = this.viewport.domElement;
    this.viewport.suspendPicking = true;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    if (!editing) document.addEventListener("keydown", this.keyHandler, true);
    this.deps.setTreePick((p) => this.onTreePick(p));
    this.panel.show(this.view(), this.state?.offset ?? 0, {
      onActivate: (f) => this.set(activate(this.state!, f)),
      onClear: (f) => this.set(clearField(this.state!, f)),
      onAllVisible: (on) => this.set(setAllVisible(this.state!, on)),
      onOffset: (mm) => {
        if (!this.state || mm === this.state.offset) return;
        this.state = { ...this.state, offset: mm };
        this.refreshPreview();
      },
      onKeep: (keep) => this.set({ ...this.state!, keep }),
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
    this.refresh();
    this.raf = requestAnimationFrame(this.boundTick);
  }

  private set(next: SplitState) {
    this.state = next;
    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // what the panel shows

  private visibleBodies(): string[] {
    return (this.store.buildState.result?.bodies ?? []).filter((b) => this.store.isBodyVisible(b.id)).map((b) => b.id);
  }

  private bodyName(id: string): string {
    const b = (this.store.buildState.result?.bodies ?? []).find((x) => x.id === id);
    return this.store.bodyName(id) ?? b?.name ?? id;
  }

  private toolText(tool: SplitToolRef): string {
    switch (tool.kind) {
      case "datum":
        return this.deps.datumName(tool.id);
      case "origin":
        return t("browser.originPlane", { plane: tool.plane });
      case "face": {
        const body = tool.face.body;
        return body ? t("feature.split.faceOf", { name: this.bodyName(body) }) : t("feature.split.face");
      }
      case "fixed":
        return t("feature.split.fixedPlane");
    }
  }

  private view(): SplitPanelView {
    const s = this.state!;
    const visible = this.visibleBodies().length;
    const bodyEmpty = !hasTargets(s);
    const bodyText = s.allVisible
      ? t("feature.split.allVisible", { count: visible })
      : s.bodies.length === 0
        ? t("feature.split.bodyNone")
        : s.bodies.length === 1
          ? this.bodyName(s.bodies[0]!)
          : t("feature.split.bodyCount", { count: s.bodies.length });
    return {
      editing: this.editId !== null,
      bodyText,
      bodyEmpty,
      toolText: s.tool ? this.toolText(s.tool) : t("feature.split.toolNone"),
      toolEmpty: !s.tool,
      active: s.active,
      allVisible: s.allVisible,
      visibleCount: visible,
      keep: s.keep,
      warning: this.warning(),
    };
  }

  /** What will stop OK, in words, or null. */
  private warning(): string | null {
    if (this.misses()) return t("feature.split.planeMisses");
    const missed = this.missedBody();
    return missed ? t("feature.split.planeMissesBody", { name: this.bodyName(missed) }) : null;
  }

  /** The prompt for the ACTIVE field: a filled field clicked to pick again is
   *  waiting for a click just like an empty one (it said "press OK" there). */
  private hint(): string {
    const s = this.state!;
    if (s.active === "body") return t("feature.split.prompt.body");
    if (s.active === "tool") return t("feature.split.prompt.tool");
    return t("feature.split.prompt.ready");
  }

  // ---------------------------------------------------------------------------
  // refresh: panel + prompt + highlight + preview

  private refresh() {
    if (!this.active || !this.state || this.awaitingRollback) return;
    this.reapplyHighlight();
    this.recomputeGeometry();
    this.refreshPreview();
    // The three origin planes are big translucent quads through the middle of
    // the model; once a tool is chosen they only hide the preview. Shown again
    // while Tool is ACTIVE, a re-pick included: a click only takes one while it
    // is shown (toolAt), so a re-pick could not take an origin plane in the
    // canvas. Their Browser rows pick them either way.
    this.showOriginPlanes(this.state.active === "tool");
  }

  private showOriginPlanes(on: boolean) {
    if (on === this.showingOrigin) return;
    this.showingOrigin = on;
    this.viewport.showAllPlanes(on);
    if (!on) this.viewport.hoverPlane(null);
  }

  /** Paint the targets as the selection. "All visible" paints nothing: it is
   *  every body on screen, and on a 3,000-body assembly repainting them all is
   *  the colour re-upload viewport.setBodyPaint warns about. */
  private reapplyHighlight() {
    if (!this.state || this.awaitingRollback) return;
    const want = this.state.allVisible ? [] : this.state.bodies;
    const cur = this.viewport.getSelectedBodies();
    if (cur.length === want.length && cur.every((id) => want.includes(id))) return;
    this.viewport.setSelectedBodies(want);
  }

  private targetIds(): string[] {
    if (!this.state) return [];
    return this.state.allVisible ? this.visibleBodies() : this.state.bodies;
  }

  /** The tool's plane at offset 0, in world space. */
  private basePlane(tool: SplitToolRef): { origin: THREE.Vector3; normal: THREE.Vector3 } | null {
    let def: PlaneDef | Plane3 | null;
    switch (tool.kind) {
      case "datum":
        def = this.deps.datumPlane(tool.id);
        break;
      case "origin":
        def = tool.plane;
        break;
      case "face":
      case "fixed":
        def = tool.plane;
        break;
    }
    if (!def) return null;
    const p = new SketchPlane(def);
    return { origin: p.origin.clone(), normal: p.n.clone().normalize() };
  }

  private recomputeGeometry() {
    const s = this.state!;
    this.base = s.tool ? this.basePlane(s.tool) : null;
    const ids = this.targetIds();
    this.box = ids.length ? this.viewport.bodiesBox(ids) : null;
    this.bodyBoxes = [];
    if (!s.allVisible && s.bodies.length > 1) {
      for (const id of s.bodies.filter((b) => !this.savedTargets.has(b))) {
        const b = this.viewport.bodiesBox([id]);
        if (b && !b.isEmpty()) this.bodyBoxes.push([id, b]);
      }
    }
    if (this.base) {
      // The drag axis runs through the targets' centre, projected onto the
      // plane, so the arrow sits in the middle of what is being cut.
      const { origin, normal } = this.base;
      const centre = this.box ? this.box.getCenter(new THREE.Vector3()) : origin.clone();
      this.anchor.copy(centre).addScaledVector(normal, -centre.clone().sub(origin).dot(normal));
    }
  }

  /** Coincidence tolerance in mm for this model: a plane within it of a box
   *  face is ON it (Q1), not outside it. */
  private tol(): number {
    const b = this.box ?? this.viewport.modelBox();
    const diag = b && !b.isEmpty() ? b.getSize(new THREE.Vector3()).length() : 100;
    return Math.max(1e-3, diag * 1e-6);
  }

  /** True when the plane, at its current offset, cannot cut the targets at all:
   *  every corner of their box lies on one side of it. */
  private misses(): boolean {
    if (!this.base || !this.box || !this.state) return false;
    const o = this.base.origin.clone().addScaledVector(this.base.normal, this.state.offset);
    // The box is the MESH's, and a curved surface's triangles sit inside it by
    // up to the tessellation tolerance. Grown by 0.1% of the diagonal so a
    // plane shaving a sliver off a dome is never refused here: a false "misses"
    // would block a real cut, while a plane that truly misses by less than this
    // still reaches the sidecar, which refuses it in words.
    const grown = this.box.clone().expandByScalar(this.box.getSize(new THREE.Vector3()).length() * 1e-3);
    return planeMissesBox([o.x, o.y, o.z], [this.base.normal.x, this.base.normal.y, this.base.normal.z], toBox(grown), this.tol());
  }

  /** A body the user PICKED in this panel, among several, that the plane cannot
   *  cut (an edited split's saved bodies are exempt, see savedTargets): every
   *  corner of its own box lies on one side. misses() reads the union of the
   *  targets' boxes, which straddles the plane as soon as one of them does,
   *  and the sidecar records a body a split over several misses without a word
   *  (a plane through an assembly misses most of it). So a 3 mm box Ctrl-picked
   *  beside a 10 mm one and a plane at z=5 cut the big box, left the small one,
   *  and said nothing. "All visible" is exempt: missing most of those is the
   *  point. Grown like misses(), by the targets' own 0.1%. */
  private missedBody(): string | null {
    if (!this.base || !this.box || !this.state || !this.bodyBoxes.length) return null;
    const o = this.base.origin.clone().addScaledVector(this.base.normal, this.state.offset);
    const n = this.base.normal;
    const grow = this.box.getSize(new THREE.Vector3()).length() * 1e-3;
    for (const [id, box] of this.bodyBoxes) {
      if (planeMissesBox([o.x, o.y, o.z], [n.x, n.y, n.z], toBox(box.clone().expandByScalar(grow)), this.tol())) return id;
    }
    return null;
  }

  private refreshPreview() {
    if (!this.state) return;
    this.panel.update(this.view());
    setPrompt(this.hint());
    this.clearPlanePreview();
    if (!this.base) {
      this.removeArrow();
      return;
    }
    const n = this.base.normal;
    const o = this.base.origin.clone().addScaledVector(n, this.state.offset);
    if (this.box) {
      // A few percent past the targets so the plane's edge is visible outside
      // the solid rather than hidden exactly on its silhouette.
      const grown = this.box.clone().expandByScalar(Math.max(1, this.box.getSize(new THREE.Vector3()).length() * 0.03));
      const pts = planeBoxSection([o.x, o.y, o.z], [n.x, n.y, n.z], toBox(grown));
      if (pts.length >= 3) this.drawSection(pts);
    }
    this.ensureArrow();
    this.lastTick = "";
    this.viewport.requestRender();
  }

  private drawSection(pts: [number, number, number][]) {
    const verts: number[] = [];
    for (let i = 1; i + 1 < pts.length; i++) verts.push(...pts[0]!, ...pts[i]!, ...pts[i + 1]!);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: PLANE_PREVIEW, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    );
    fill.renderOrder = 997;
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
    const outline = new THREE.LineLoop(lineGeo, new THREE.LineBasicMaterial({ color: PLANE_PREVIEW, transparent: true, opacity: 0.9, depthTest: false }));
    outline.renderOrder = 998;
    this.fill = fill;
    this.outline = outline;
    this.viewport.addToScene(fill);
    this.viewport.addToScene(outline);
  }

  private clearPlanePreview() {
    for (const obj of [this.fill, this.outline]) {
      if (!obj) continue;
      this.viewport.removeFromScene(obj);
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
    this.fill = null;
    this.outline = null;
  }

  private ensureArrow() {
    if (!this.arrow) {
      this.arrow = buildOffsetArrow();
      this.viewport.addToScene(this.arrow.group);
    }
    if (!this.aboveEl) {
      const el = document.createElement("div");
      el.className = "split-above-marker";
      el.textContent = t("feature.split.above");
      // The viewport's clipped overlay, not <body>: zoomed in, the tip leaves
      // the canvas and a body-level label floated over the Browser and ribbon.
      overlayHost().appendChild(el);
      this.aboveEl = el;
    }
  }

  private removeArrow() {
    if (this.arrow) {
      this.viewport.removeFromScene(this.arrow.group);
      disposeOffsetArrow(this.arrow);
      this.arrow = null;
    }
    this.aboveEl?.remove();
    this.aboveEl = null;
  }

  /** Where the plane is at the current offset, on the drag axis. */
  private planePoint(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.anchor).addScaledVector(this.base!.normal, this.state!.offset);
  }

  /** Per frame: keep the arrow a constant size on screen, pointing to Above,
   *  and the Above label at its tip. Only renders when something moved. */
  private tick() {
    if (!this.active) return;
    this.raf = requestAnimationFrame(this.boundTick);
    if (!this.arrow || !this.base || !this.state) return;
    const at = this.planePoint();
    const k = this.viewport.pixelWorldSize(at);
    const tip = at.clone().addScaledVector(this.base.normal, k * (OFFSET_ARROW_LENGTH_PX + 12));
    const s = this.viewport.projectToOverlay(tip);
    // A tip behind the camera projects to a mirrored point that labels nothing.
    const cam = this.viewport.camera;
    const behind = tip.clone().sub(cam.position).dot(cam.getWorldDirection(new THREE.Vector3())) <= 0;
    const hidden = behind || outsideRect(s);
    const hot = this.hovering || this.grabbing;
    const key = `${at.x},${at.y},${at.z},${k},${hot},${s.x},${s.y},${hidden}`;
    if (key === this.lastTick) return;
    this.lastTick = key;
    this.arrow.group.position.copy(at);
    this.arrow.group.quaternion.setFromUnitVectors(Y_AXIS, this.base.normal);
    this.arrow.group.scale.setScalar(k);
    this.arrow.material.color.set(hot ? HANDLE_HOT : HANDLE_IDLE);
    if (this.aboveEl) {
      this.aboveEl.style.visibility = hidden ? "hidden" : "visible";
      this.aboveEl.style.left = `${s.x}px`;
      this.aboveEl.style.top = `${s.y}px`;
    }
    this.viewport.requestRender();
  }

  // ---------------------------------------------------------------------------
  // picking

  private hitArrow(x: number, y: number): boolean {
    if (!this.arrow) return false;
    return this.viewport.rayFrom(x, y).intersectObjects(this.arrow.group.children, false).length > 0;
  }

  /** What a Tool click at (x, y) names. `curved` when the nearest thing is a
   *  face that is not flat (or whose body is unknown): a split needs a plane,
   *  and it says so rather than cutting along a tangent. */
  /** Why a datum cannot cut here, in words, or null when it can: it has to
   *  exist at the split's place in the timeline. A datum made after the split,
   *  or suppressed, is not there when the split runs, and writing its id gave a
   *  red chip with an internal id in it ("unknown plane reference: f12"). */
  private datumRefusal(id: string): string | null {
    const features = this.store.document.features;
    const at = features.findIndex((f) => f.id === id);
    // deleted: there is no name to give it ("Plane0" was what it got)
    if (at < 0 || features[at]!.type !== "datumPlane") return t("feature.split.planeGone");
    const limit = this.editId ? features.findIndex((f) => f.id === this.editId) : this.store.rollbackIndex;
    const name = this.deps.datumName(id);
    if (at >= 0 && at < limit) return this.store.isSuppressed(id) ? t("feature.split.planeSuppressed", { name }) : null;
    return t("feature.split.planeNotYet", { name });
  }

  /** A datum in the Tool field that cannot cut here (datumRefusal) is taken
   *  out: the field is emptied and made the active one when Body is filled.
   *  Returns why, or null when the Tool is fine (or is not a datum). */
  private dropRefusedDatum(): string | null {
    const s = this.state;
    if (s?.tool?.kind !== "datum") return null;
    const refused = this.datumRefusal(s.tool.id);
    if (refused) {
      const next = { ...s, tool: null };
      this.state = { ...next, active: firstEmptyField(next) };
    }
    return refused;
  }

  private toolAt(x: number, y: number): { ref: SplitToolRef } | { curved: true } | { refused: string } | null {
    const faceDist = this.viewport.surfaceHitDistance(x, y);
    const datum = this.viewport.datumHitAt(x, y);
    const which = chooseToolHit(faceDist, datum?.distance ?? null, this.tol() * 10);
    if (which === "datum" && datum) {
      const refused = this.datumRefusal(datum.id);
      return refused ? { refused } : { ref: { kind: "datum", id: datum.id } };
    }
    if (which === "face") {
      const plane = this.viewport.pickFacePlane(x, y);
      const anchor = plane ? this.viewport.faceAnchor(x, y, plane) : null;
      if (!plane || !anchor) return { curved: true };
      return { ref: { kind: "face", plane, face: anchor } };
    }
    const origin = this.showingOrigin ? this.viewport.pickPlane(x, y) : null;
    return origin ? { ref: { kind: "origin", plane: origin } } : null;
  }

  private onTreePick(p: TreePick): boolean {
    if (!this.active) return false;
    // While an edit waits for the model to roll back there are no fields to
    // fill yet, but the click is still this tool's: handed back, an origin row
    // would open a sketch in the middle of the edit.
    if (!this.state || this.awaitingRollback) return true;
    if (p.kind === "body") {
      this.set(pickBody(this.state, p.id, p.additive));
      return true;
    }
    // A plane row is always the TOOL, whichever field is active: it can be
    // nothing else, and making the user activate the field first would turn a
    // one-click answer into two.
    if (p.kind === "datum") {
      const refused = this.datumRefusal(p.id);
      if (refused) {
        toast(refused, { kind: "warning" });
        return true;
      }
    }
    this.set(pickTool(this.state, p.kind === "origin" ? { kind: "origin", plane: p.plane } : { kind: "datum", id: p.id }));
    return true;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnArrow = this.hitArrow(e.clientX, e.clientY);
    if (!this.downOnArrow || !this.base) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.grabbing = true;
    this.grabValue = this.state!.offset;
    this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.base.normal);
    this.viewport.domElement.style.cursor = "grabbing";
    window.addEventListener("pointerup", this.boundGrabEnd);
    window.addEventListener("pointercancel", this.boundGrabEnd);
  }

  /** The arrow is let go of: a release anywhere (window), a cancel, or a move
   *  that arrives with the button already up. */
  private endGrab() {
    if (!this.grabbing) return;
    this.grabbing = false;
    window.removeEventListener("pointerup", this.boundGrabEnd);
    window.removeEventListener("pointercancel", this.boundGrabEnd);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onMove(e: PointerEvent) {
    // The button came up where nothing told us (outside the window, an
    // alt-tab): `buttons` is the only thing on a move that knows.
    if (this.grabbing && !(e.buttons & 1)) this.endGrab();
    if (this.grabbing && this.base && this.state) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.base.normal);
      const stepped = snap(this.grabValue + (proj - this.grabProj), this.viewport.snapStep(this.planePoint()));
      if (stepped === this.state.offset) return;
      this.state = { ...this.state, offset: stepped };
      this.panel.setOffset(stepped);
      this.refreshPreview();
      return;
    }
    if (e.buttons !== 0) return; // orbit / pan in progress
    this.hoverEvent = e;
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const ev = this.hoverEvent;
      this.hoverEvent = null;
      if (ev && this.active) this.hover(ev.clientX, ev.clientY);
    });
  }

  private hover(x: number, y: number) {
    const el = this.viewport.domElement;
    if (this.viewport.cubeHitsRegion(x, y)) {
      // the ViewCube owns its corner: nothing behind it is a pick
      this.hovering = false;
      this.viewport.hoverDatum(null);
      this.viewport.clearHover();
      this.viewport.hoverPlane(null);
      el.style.cursor = "default";
      return;
    }
    this.hovering = this.hitArrow(x, y);
    if (this.hovering) {
      el.style.cursor = "grab";
      return;
    }
    if (this.state?.active === "tool") {
      const faceDist = this.viewport.surfaceHitDistance(x, y);
      const datum = this.viewport.datumHitAt(x, y);
      const which = chooseToolHit(faceDist, datum?.distance ?? null, this.tol() * 10);
      this.viewport.hoverDatum(which === "datum" ? datum!.id : null);
      if (which === "face") this.viewport.hoverFaceAt(x, y);
      else this.viewport.clearHover();
      // Only while the origin planes are SHOWN: a click takes one only then
      // (toolAt), and a pointer over an invisible plane promised a pick that
      // did nothing.
      const origin = which || !this.showingOrigin ? null : this.viewport.pickPlane(x, y);
      this.viewport.hoverPlane(origin);
      el.style.cursor = which || origin ? "pointer" : "default";
    } else if (this.state?.active === "body") {
      el.style.cursor = this.viewport.bodyIdAt(x, y) ? "pointer" : "default";
    } else {
      // nothing is armed: a plain click here picks nothing (SplitState.active)
      el.style.cursor = "default";
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grabbing) {
      this.endGrab();
      return;
    }
    // A ViewCube click orients the view (the viewport's own pointerup) and must
    // not also be read as a pick of whatever lies behind the cube: that
    // replaced a 5-body pick with the one body behind the corner.
    if (this.viewport.cubeHitsRegion(e.clientX, e.clientY)) return;
    const moved = Math.abs(e.clientX - this.downPos.x) > CLICK_SLOP_PX || Math.abs(e.clientY - this.downPos.y) > CLICK_SLOP_PX;
    if (moved || this.downOnArrow || e.altKey || !this.state || this.awaitingRollback) return;
    // Ctrl-click adds or removes a body WHICHEVER field is active, as it does on
    // a Browser row. Routed by the active field, it became a Tool pick once a
    // plain click had moved on to Tool: the body was not added, and a face of
    // it replaced the splitting plane (the verify run on the field file).
    const additive = e.ctrlKey || e.metaKey;
    if (additive || this.state.active === "body") {
      const id = this.viewport.bodyIdAt(e.clientX, e.clientY);
      if (id) this.set(pickBody(this.state, id, additive));
      return;
    }
    if (this.state.active !== "tool") return; // both filled, nothing armed
    const hit = this.toolAt(e.clientX, e.clientY);
    if (!hit) return;
    if ("curved" in hit) {
      toast(t("feature.split.curvedFace"), { kind: "warning" });
      return;
    }
    if ("refused" in hit) {
      toast(hit.refused, { kind: "warning" });
      return;
    }
    this.set(pickTool(this.state, hit.ref));
  }

  // ---------------------------------------------------------------------------
  // commit / cancel

  private commit() {
    if (!this.active || !this.state || this.awaitingRollback) return;
    if (this.panel.offsetUnreadable()) {
      setPrompt(t("feature.badNumber"));
      return;
    }
    // The datum can have gone since it was picked (deleted or suppressed from
    // the Browser, which stays live during the command): OK must not write a
    // planeId that names nothing.
    const deadTool = this.dropRefusedDatum();
    if (deadTool) {
      this.refresh();
      setPrompt(deadTool);
      return;
    }
    const refusal = this.warning();
    if (refusal) {
      setPrompt(refusal);
      return;
    }
    const id = this.editId ?? this.store.nextId();
    const built = buildSplitFeature(this.state, { id, visibleBodies: this.visibleBodies(), groupSides: this.editId ? this.editGroupSides : true });
    if ("missing" in built) {
      const next = activate(this.state, built.missing);
      this.set(next);
      setPrompt(t(built.missing === "body" ? "feature.split.needBody" : "feature.split.needTool"));
      return;
    }
    const onDone = this.onDone;
    if (this.editId) {
      // An old split OK'd unchanged is written back exactly as it was, so it
      // keeps rebuilding the way it always did (editedSplit).
      const next = this.editOriginal ? editedSplit(this.editOriginal, built.feature, this.editAutoBody, this.editConvert) : built.feature;
      this.cleanup();
      this.store.endEditPreview(false); // replaceFeature rebuilds
      this.store.replaceFeature(id, next as unknown as Feature);
      onDone?.(id);
      return;
    }
    const feature = built.feature as unknown as Feature;
    // Everything the post-build step needs has to be read NOW, from the model
    // the user was looking at: ids are positional, so after the rebuild "which
    // bodies are new" can only be answered against this snapshot.
    const targets = built.feature.body ? [built.feature.body] : [...(built.feature.bodies ?? [])];
    const before: BodyStamp[] = (this.store.buildState.result?.bodies ?? []).map((b) => ({ id: b.id, etag: b.etag }));
    const appendedAtEnd = this.store.rollbackIndex >= this.store.document.features.length;
    const wasBuilding = this.store.buildState.building;
    this.cleanup(false);
    this.store.addFeature(feature);
    if (appendedAtEnd) this.afterBuild(id, targets, before, wasBuilding);
    onDone?.(id);
  }

  /** Once the split has built: select every piece (plan B6). Skipped when the
   *  split failed (its error toast is the answer then) and when the split went
   *  in mid-timeline (positional ids, see resultingPieces). The pieces of a
   *  renamed body are NAMED by the store from the build's own lineage
   *  (DocumentStore.bodyName), not here. */
  private afterBuild(featureId: string, targets: string[], before: BodyStamp[], wasBuilding: boolean) {
    // Which settle is the split's. The store may start the rebuild inside
    // addFeature or a moment later, and one may already be running: that one
    // settles FIRST, without the split in it, and the store then runs another
    // for the new document. So a settle only counts once a build has been seen
    // STARTING, and a build that was already running is let through once.
    // Reading a stale settle as the split's would select strangers (body ids
    // are positional, so "new since before" would be some other feature's
    // bodies). splitTool.test.ts drives both orders.
    let skips = wasBuilding ? 1 : 0;
    let armed = this.store.buildState.building;
    let live = false; // onBuild replays the current state synchronously; that is not news
    let unsub: (() => void) | null = null;
    unsub = this.store.onBuild((s) => {
      if (!live) return;
      if (s.building) {
        armed = true;
        return;
      }
      if (!armed || !s.result) return;
      armed = false;
      if (skips > 0) {
        skips--;
        return;
      }
      unsub?.();
      if (!this.store.document.features.some((f) => f.id === featureId)) return;
      if ((s.result.featureErrors ?? []).some((e) => e.feature_id === featureId)) return;
      if (this.active) return; // another run of this tool owns the selection now
      const after: BodyStamp[] = (s.result.bodies ?? []).map((b) => ({ id: b.id, etag: b.etag }));
      this.viewport.setSelectedBodies(resultingPieces(targets, before, after));
    });
    live = true;
  }

  cancel() {
    if (!this.active) return;
    const onDone = this.onDone;
    const editing = this.editId !== null;
    this.cleanup(true);
    if (editing) this.store.endEditPreview();
    onDone?.(null);
  }

  /** `restore` puts the body selection back the way it was before the tool
   *  painted its targets (Cancel); a commit leaves it to the post-build step. */
  private cleanup(restore = false) {
    this.endGrab();
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    document.removeEventListener("keydown", this.keyHandler, true);
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf);
    this.raf = this.hoverRaf = 0;
    this.deps.setTreePick(null);
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.panel.hide();
    this.clearPlanePreview();
    this.removeArrow();
    this.showOriginPlanes(false);
    this.viewport.hoverDatum(null);
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.viewport.setSelectedBodies(restore ? this.priorSelection : []);
    // Face ids are the build's: after a rebuild they name other faces.
    if (restore && this.consumedFaces.length && this.store.buildState.result === this.consumedFrom) {
      this.viewport.selectFaces(this.consumedFaces);
    }
    this.consumedFaces = [];
    this.consumedFrom = null;
    this.active = false;
    this.state = null;
    this.editId = null;
    this.editGroupSides = undefined;
    this.editOriginal = null;
    this.editAutoBody = null;
    this.editConvert = false;
    this.savedTargets = new Set();
    this.awaitingRollback = false;
    this.grabbing = this.hovering = false;
    this.base = null;
    this.box = null;
    this.bodyBoxes = [];
    setPrompt(null);
  }

  /** The Faces/Bodies switch clears the viewport's body selection going to
   *  Faces, and the targets are painted AS that selection: the Body field still
   *  named them and OK would cut them, with nothing lit in the model or the
   *  Browser. main.ts calls this after every switch. */
  selectionModeChanged() {
    if (this.active) this.reapplyHighlight();
  }
}
