// The modal sketch environment: enter on a plane (camera squares to it, model
// dims, grid appears), draw Line/Rectangle/Circle interactively with snapping
// and on-canvas dimension input, then Finish to commit the sketch feature.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { EdgeFingerprint, Feature, ParamTarget, PlaceOffset, PlaneSpec, ProjectedSource, ProjectionUpdate, SketchConstraint, SketchPattern } from "../types";
import { applyProjectionUpdate, dimPlaceOf, isBadgeEntity, isPlacedDim } from "../types";
import { SketchPlane } from "./plane";
import { SketchOverlay, curveObjects, dimensionLineObjects, CURVE_COLOR, PREVIEW_COLOR, SELECT_COLOR } from "./overlay";
import { DimInput } from "./dimInput";
import { TextPanel } from "./textPanel";
import type { TextValues } from "./textPanel";
import { fetchFonts } from "./textCache";
import { isEditableTarget } from "../ui/focus";
import { SketchDimensions, type ExtraDim } from "./sketchDimensions";
import { SketchGlyphs } from "./sketchGlyphs";
import { constraintGlyphs, diagnosisOf } from "./glyphs";
import { entityDims, constraintDims, dimRefPoints, curveKind, linearDim, setDimPixelScale, staggeredDefaults, type DimField, type ConstraintDim } from "./entityDims";
import {
  clampPlace, isDimError, isRoundTarget, pickDimTarget, rebindTarget, resolveDim, targetIdentity,
  targetKey, unsupportedMessage,
  type DimOptions, type DimPlan, type DimTarget,
} from "./dimensionTool";
import { pickEntity, trimEntity, filletCorner, chamferCorner, offsetEntity, offsetLineChain, breakAt, extendLine, breakLink, PROJECTED_FIXED_MSG } from "./modify";
import { newEntityId, newConstraintId, isDimConstraint, notePatternId } from "./id";
import { isPlainNumber, parseField } from "../ui/units";
import { RIGID_ENTITY_NUM_FIELDS, coerceForField, type FieldKind } from "../document/numFields";
import type { SketchBinding } from "../document/store";
import { circumcenter } from "./arc";
import { compileAndSolve, coincKey, constraintIndexOf } from "./sketchSolve";
import { resolveRealEntities, toSketchEntity } from "./resolve";
import { expandPattern, translated, rotated, scaled } from "./pattern";
import { candidatesFromEntities, snap, type SnapKind, type SnapCandidate } from "./snap";
import type { ResolvedEntity } from "./snap";
import { detectRegions, rectCorners } from "./region";
import { setSpaceMouseOrbitLocked } from "../input/spacemouse";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { contextMenu, dismissContextMenu, type CtxItem } from "../ui/menu";
import { ConstraintTools, CONSTRAINT_TOOLS, type ConstraintHost } from "./constraintTools";
import { PatternFlow, PATTERN_TOOLS, ENTITY_PATTERNS, type PatternHost } from "./patternFlow";
import { ProjectPanel } from "./projectPanel";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "centerRectangle"
  | "circle"
  | "circle2"
  | "circle3"
  | "arc"
  | "spline"
  | "polygon"
  | "slot"
  | "point"
  | "mirror"
  | "dimension"
  | "trim"
  | "fillet"
  | "chamfer"
  | "move"
  | "copy"
  | "rotate"
  | "scale"
  | "offset"
  | "extend"
  | "break"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "coincident"
  | "concentric"
  | "symmetric"
  | "midpoint"
  | "collinear"
  | "fix"
  | "patternRect"
  | "patternCircular"
  | "hexHoles"
  | "honeycomb"
  | "boltCircle"
  | "gridHoles"
  | "text"
  | "project";

// PRESET_PATTERNS/ENTITY_PATTERNS/PATTERN_TOOLS live in patternFlow.ts (imported
// above); CONSTRAINT_TOOLS lives in constraintTools.ts (also imported above).
const MODIFY_TOOLS = new Set<SketchTool>([
  "trim",
  "fillet",
  "chamfer",
  "move",
  "copy",
  "rotate",
  "scale",
  "offset",
  "extend",
  "break",
  "mirror",
  "dimension",
  ...CONSTRAINT_TOOLS,
]);

const GRID_STEP = 5;

// Map planegcs conflict ids back to constraint indices. Implicit ids (rect
// edges `<id>~h0`, the drag pin) decode to null and are skipped.
function parseConflictIdx(ids: string[]): Set<number> {
  const s = new Set<number>();
  for (const id of ids) {
    const i = constraintIndexOf(id);
    if (i !== null) s.add(i);
  }
  return s;
}

// Tools that operate on the current multi-selection, so setTool must keep it.
const KEEPS_SELECTION = new Set<SketchTool>(["mirror", "move", "copy", "rotate", "scale"]);

// Tolerant edge-fingerprint compare for the Project tool's duplicate-pick check.
// Fingerprints carry unrounded float noise (sidecar-authored), so byte equality
// is meaningless — same midpoint (within 1e-3 mm), same unoriented tangent, and
// a matching length when both carry one, is "the same edge".
function fpClose(a: EdgeFingerprint, b: EdgeFingerprint): boolean {
  if (Math.hypot(a.mid[0] - b.mid[0], a.mid[1] - b.mid[1], a.mid[2] - b.mid[2]) > 1e-3) return false;
  const dot = Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2]);
  if (dot < 1 - 1e-6) return false;
  if (a.length != null && b.length != null && Math.abs(a.length - b.length) > 1e-3) return false;
  return true;
}

// Sentinel id for the in-progress text tool's live-preview entity: it lives on the
// active entity list (so it repaints through the normal render path) but is never
// committed — filtered out at serialization and dropped on tool switch/cancel.
const TEXT_PREVIEW_ID = "__textpreview__";

export class SketchMode {
  active = false;
  tool: SketchTool = "select";
  onState: (() => void) | null = null; // notify UI (tool/active changed)

  private plane = new SketchPlane("XY");
  private entities: ResolvedEntity[] = [];
  private candidates: SnapCandidate[] = []; // cached; rebuilt when entities change
  private base: THREE.Vector2 | null = null; // pending first point
  private chainStart: THREE.Vector2 | null = null; // first point of a line chain
  private arcStart: THREE.Vector2 | null = null; // 3-point arc: start, end, then bulge
  private arcEnd: THREE.Vector2 | null = null;
  private splinePts: THREE.Vector2[] = []; // in-progress spline fit points
  private clickPts: THREE.Vector2[] = []; // accumulated clicks for multi-point primitives (polygon/slot/circle variants)
  private polygonSides = 6; // n for the polygon tool
  private filletFirst: number | null = null; // first line picked for a sketch fillet
  private selected = new Set<string>(); // selected entity ids (select tool)
  private constraints: SketchConstraint[] = []; // persistent constraints (solved)
  private patterns: SketchPattern[] = []; // associative pattern definitions
  private lastDof = -1;
  private dragFrom: THREE.Vector2 | null = null; // grabbed point's current position
  // click-vs-drag bookkeeping for a grabbed POINT: which entity owns it, where
  // the pointer went down (screen px), and whether it ever moved past the same
  // 4px threshold moveDrag uses. A stationary click on a vertex must still
  // SELECT the owning entity instead of silently doing nothing.
  private dragEntIdx = -1;
  private dragStartClient = { x: 0, y: 0 };
  private dragMoved = false;
  private dragShift = false;
  private dragSnapshot: ResolvedEntity[] | null = null; // entities at drag start (Esc reverts)
  private dragRefusedToast = false; // one fixed-point toast per refused drag gesture
  private pendingDrag: { fromX: number; fromY: number; toX: number; toY: number } | null = null;
  // whole-entity body drag (select tool, no grab point under the cursor):
  // armed cheaply on pointerdown over an entity body; the snapshot and the
  // neighbor-stretch closures are built only when the move actually starts
  // (past a small screen-space threshold) — a plain click stays free and
  // falls through to selection on up.
  private moveDrag: {
    idx: number;
    startClient: { x: number; y: number };
    last: THREE.Vector2;
    started: boolean;
    shift: boolean;
    stretch: ((dx: number, dy: number) => void)[]; // filled when the move starts
  } | null = null;
  private solveBusy = false; // a solve is in flight (drag or constraint)
  private solveDirty = false; // a constraint/dimension solve is pending
  private entityVersion = 0; // bumped on every entity change; guards stale solves
  private conflict = false; // last solve reported conflicting (over-)constraints
  private lastCursor = new THREE.Vector2();
  // dimension tool: 0-2 accumulated picks and the plan they currently resolve
  // to (see dimensionTool.ts — the dimension TYPE is decided by the pair, not
  // by the first pick). `dimPlace` is frozen by the placement click.
  private dimPicks: DimTarget[] = [];
  private dimPlan: DimPlan | null = null;
  private dimPlace: PlaceOffset | null = null;
  // the click-to-place has happened. NOT the same as `dimPlace != null`, which
  // is null for the dims that render through entityDims and have no place slot.
  private dimPlaced = false;
  // where the value box currently sits (client px), so it only steps aside when
  // the cursor is genuinely about to land on it — and never once placed
  private dimBoxAt: { x: number; y: number } | null = null;
  private dimFieldKey = ""; // field set the open box was built for
  // full identity of the dimension the open box belongs to (kind + field set +
  // the picks). Two DIFFERENT dimensions can share a field set — a rect edge's
  // LENGTH and a circle-to-edge DISTANCE are both `distance:length` — so the
  // field key alone would carry a typed value silently across a plan change.
  private dimPlanKey = "";
  // Right-click overrides on the in-progress dimension (Fusion's marking menu).
  // `dimTangentArmed` is Fusion's "Pick Circle/Arc Tangent": it arms the NEXT
  // pick only and is consumed by the first circle/arc that uses it — never
  // sticky. `dimRoundPref` overrides radius-vs-diameter for a lone round and
  // persists for the whole in-progress dim (reset with the picks).
  private dimTangentArmed = false;
  private dimRoundPref: "radius" | "diameter" | undefined;
  // right-press bookkeeping for the canvas context menus: a right-DRAG is a
  // camera pan and must not pop a menu on release (the viewport applies the
  // same 5 px rule to its own right-click menus).
  private rightDownAt: { x: number; y: number } | null = null;
  private rightDragged = false;
  // Move/Copy tool: first (base) point picked; the second click sets the offset.
  private moveBase: THREE.Vector2 | null = null;
  // distance-constraint dims, computed once per refreshActive() in activeCurves()
  // and reused for the clickable labels (constraintDimExtras)
  private cdims: ConstraintDim[] = [];
  private editingId: string | null = null;
  private store: DocumentStore | undefined;
  private grid: THREE.GridHelper | null = null;
  // Sketch Palette options
  private gridVisible = true;
  private gridSnap = true;
  private constructionMode = false;
  private referenceMode = false; // dimensions placed as driven/reference (measured only)
  private dimsVisible = true;
  private glyphsVisible = true; // show constraint glyphs on canvas
  // Glyph cIndex and conflictIdx are POSITIONAL into this.constraints. The handle
  // stays valid because every this.constraints mutation is followed by
  // refreshActive(), which re-show()s glyphs with fresh indices before the next
  // input frame — so a click can't carry a stale index. (No per-constraint UID.)
  private conflictIdx = new Set<number>(); // constraint indices the solver flagged conflicting
  private overIdx = new Set<number>(); // indices flagged redundant / over-defining (removable)
  private readonly textPanel = new TextPanel();
  // Project tool: filter chips (edges&faces / sketch curves) + a one-at-a-time
  // in-flight gate so a double-click can't race two projectGeometry calls.
  private readonly projectPanel = new ProjectPanel();
  private projectBusy = false;
  private fonts: string[] = []; // system fonts for the text tool (loaded on enter)
  // text tool: press-drag defines a box (wrap width); a plain click is a point anchor.
  private textBoxStart: THREE.Vector2 | null = null;
  private textBoxEnd: THREE.Vector2 | null = null;
  private textBoxScreen: { x: number; y: number } | null = null;
  private viewLocked = true; // lock the camera square to the sketch plane
  private dim: DimInput;
  private dims: SketchDimensions;
  private glyphs: SketchGlyphs;
  private boundDown: (e: PointerEvent) => void;
  private boundMove: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundContext: (e: MouseEvent) => void;
  // collaborators: the constraint-tool click flows and the pattern placement/edit
  // flow, each operating on a live accessor into this SketchMode (see their
  // Host interfaces) rather than a copy of its state.
  private constraintTools: ConstraintTools;
  private patternFlow: PatternFlow;

  constructor(
    private viewport: Viewport,
    private overlay: SketchOverlay,
  ) {
    this.dim = new DimInput();
    this.dims = new SketchDimensions(
      viewport,
      (i, f, mm) => this.editDimension(i, f, mm),
      (i, f, raw) => this.commitEntityDimExpr(i, f, raw),
      (i, f) => this.entityDimExpr(i, f),
    );
    this.dims.onOverlapPick = (e) => this.labelOverlapSelect(e);
    this.dims.onPlanePoint = (cx, cy) => this.planePointAt(cx, cy);
    this.dims.onEntityPlace = (i, f, ox, oy, done) => this.commitEntityPlace(i, f, ox, oy, done);
    this.glyphs = new SketchGlyphs(viewport);
    this.glyphs.onDelete = (i) => this.deleteConstraint(i);
    this.boundDown = (e) => this.onPointerDown(e);
    this.boundMove = (e) => this.onPointerMove(e);
    this.boundUp = (e) => this.endDrag(e.pointerId);
    this.boundKey = (e) => this.onKey(e);
    this.boundContext = (e) => this.onContextMenu(e);
    const constraintHost: ConstraintHost = {
      tool: () => this.tool,
      entities: () => this.entities,
      constraints: () => this.constraints,
      pickTol: () => this.pickTol(),
      getFilletFirst: () => this.filletFirst,
      setFilletFirst: (v) => { this.filletFirst = v; },
      requestSolve: () => this.requestSolve(),
      warn: (msg) => toast(msg),
    };
    this.constraintTools = new ConstraintTools(constraintHost);
    const patternHost: PatternHost = {
      tool: () => this.tool,
      setActiveTool: (t) => { this.tool = t; },
      setTool: (t) => this.setTool(t),
      selected: () => this.selected,
      patterns: () => this.patterns,
      dim: () => this.dim,
      refreshActive: () => this.refreshActive(),
      onState: () => this.onState?.(),
    };
    this.patternFlow = new PatternFlow(patternHost);
    // Filter chip clicks land on the panel, not the canvas, so projectHover
    // doesn't run — clear the other mode's hover feedback explicitly.
    this.projectPanel.onChange = () => {
      this.viewport.hoverEntity(null);
      this.overlay.setPreview([]);
      this.viewport.requestRender();
    };
  }

  // --- lifecycle ---------------------------------------------------------
  enter(plane: PlaneSpec, store: DocumentStore, editId?: string) {
    this.active = true;
    this.editingId = editId ?? null;
    this.plane = this.overlay.planeFor(plane);
    this.store = store;
    if (!this.fonts.length) void fetchFonts().then((f) => { this.fonts = f; });

    // load existing entities if editing
    this.entities = [];
    this.constraints = [];
    this.patterns = [];
    this.patternFlow.resetForEnter();
    this.selected.clear();
    this.overlay.clearRegionSelection(); // fresh session: drop any stale area selection
    this.lastDof = -1;
    this.conflict = false;
    if (editId) {
      const f = store.document.features.find((x) => x.id === editId);
      if (f && f.type === "sketch") {
        // real entities only — derived pattern copies are NEVER stored in
        // this.entities (see derivedEntities()); doing so would persist them
        // as real geometry on the next finish() and bake in duplicates (§1.2).
        this.entities = resolveRealEntities(f, store.document.parameters);
        this.constraints = f.constraints ? f.constraints.map((c) => ({ ...c })) : [];
        this.patterns = f.patterns ? f.patterns.map((p) => ({ ...p })) : [];
        for (const p of this.patterns) notePatternId(p.id); // reserve ids so new ones don't collide
      }
    }

    this.viewport.suspendPicking = true;
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.addGrid();

    const el = this.viewport.domElement;
    el.addEventListener("pointerdown", this.boundDown);
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerup", this.boundUp);
    el.addEventListener("contextmenu", this.boundContext);
    window.addEventListener("keydown", this.boundKey, true);

    this.overlay.update(store.document, this.editingId ?? "__active__");
    this.refreshActive();
    this.setTool("rectangle");
    this.setViewLocked(this.viewLocked); // apply lock-to-plane preference
    if (this.constraints.length > 0) this.requestSolve(); // restore DOF state
    this.onState?.();
  }

  finish(commit = true) {
    if (!this.active) return;
    const store = this.store!;
    this.patternFlow.flushOnFinish();
    if (commit && (this.entities.length > 0 || this.patterns.length > 0)) {
      const sketch: Feature = {
        id: this.editingId ?? store.nextId(),
        type: "sketch",
        plane: this.plane.serialize(),
        entities: this.entities.filter((e) => e.id !== TEXT_PREVIEW_ID).map(toSketchEntity),
        ...(this.constraints.length > 0 ? { constraints: this.constraints.map((c) => ({ ...c })) } : {}),
        ...(this.patterns.length > 0 ? { patterns: this.patterns.map((p) => ({ ...p })) } : {}),
      };
      if (this.editingId) {
        store.replaceFeature(this.editingId, sketch, this.drainBindings(sketch.id));
      } else {
        store.addFeature(sketch, undefined, this.drainBindings(sketch.id));
      }
    }
    this.cleanup();
  }

  cancel() {
    this.cleanup();
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.pendingBindings.clear();
    el.removeEventListener("pointerdown", this.boundDown);
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerup", this.boundUp);
    el.removeEventListener("contextmenu", this.boundContext);
    window.removeEventListener("keydown", this.boundKey, true);
    dismissContextMenu();
    this.selected.clear();
    this.dragFrom = null;
    this.dragSnapshot = null;
    this.pendingDrag = null;
    this.moveDrag = null;
    this.dim.hide();
    this.dims.hide();
    this.glyphs.hide();
    this.textPanel.hide();
    this.projectPanel.hide();
    this.viewport.hoverEntity(null); // drop any Project-tool 3D hover highlight
    this.overlay.setPreview([]);
    this.overlay.setSnap(null);
    this.removeGrid();
    this.viewport.exitSketchView();
    this.viewport.rig.setOrbitLocked(false); // restore free orbit in model mode
    setSpaceMouseOrbitLocked(false);
    this.viewport.suspendPicking = false;
    this.active = false;
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.splinePts = [];
    this.clickPts = [];
    this.resetDimPicks();
    this.constraintTools.resetPending();
    this.tool = "select";
    this.overlay.setActiveSketch([]); // clear in-progress curves (else they orphan on screen)
    this.overlay.setActiveRegions([], this.plane); // drop active-sketch fills (committed ones re-render)
    if (this.store) this.overlay.update(this.store.document);
    this.onState?.();
  }

  // --- tools -------------------------------------------------------------
  setTool(t: SketchTool) {
    // Mirror operates on the current multi-selection, so keep it; every other
    // tool starts from a clean slate.
    // Mirror + the transform tools (move/copy/rotate/scale) operate on the
    // current multi-selection, so keep it; every other tool starts clean.
    const keepSelection = KEEPS_SELECTION.has(t);
    // Read the selection BEFORE the clear below consumes it: arriving at the
    // dimension tool with geometry already selected dimensions that geometry
    // (Fusion: pick the line, then press D).
    const preselected = t === "dimension" ? [...this.selected] : [];
    this.tool = t;
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.splinePts = [];
    this.filletFirst = null;
    this.dragFrom = null;
    this.pendingDrag = null;
    this.moveDrag = null;
    this.resetDimPicks();
    this.moveBase = null;
    this.dim.hide();
    this.textPanel.hide();
    // Project tool: chips only while it's active; leaving it drops any 3D hover
    if (t === "project") this.projectPanel.show(this.viewport.domElement);
    else {
      this.projectPanel.hide();
      this.viewport.hoverEntity(null);
    }
    // drop any uncommitted text preview left on the active list when switching tools
    if (this.dropTextPreview()) this.refreshActive();
    this.overlay.setPreview([]);
    this.constraintTools.resetPending();
    if (!keepSelection && this.selected.size) { this.selected.clear(); this.refreshActive(); }
    if (preselected.length) this.seedDimPicks(preselected);
    this.patternFlow.flushPending(); // don't lose an in-progress pattern
    this.dims.setInteractive(t === "select");
    this.glyphs.setInteractive(t === "select");
    this.onState?.();
  }

  /** Public re-draw hook: e.g. async glyph outlines for a text entity just arrived,
   *  so the active sketch's curves (incl. text + its live preview entity) need
   *  repainting. No-op when inactive. */
  redraw(): void {
    if (this.active) this.refreshActive();
  }

  /** Rebuild the active sketch's committed curves + snap candidates + editable
   * dimension labels. Called when the entity list changes — and on drag end. */
  private refreshActive() {
    this.entityVersion++; // bump guards in-flight constraint solves against staleness
    // current zoom → mm-per-pixel, so dimension badges keep screen clearance
    // from the geometry they label (they're click targets in the select tool)
    setDimPixelScale(this.viewport.pixelWorldSize(this.plane.origin));
    const derived = this.derivedEntities(); // computed once, shared below
    this.overlay.setActiveSketch(this.activeCurves(derived));
    // profile-area fills for the active sketch (hidden from overlay.update),
    // so areas are visible + selectable while drawing
    this.overlay.setActiveRegions(
      detectRegions(this.editingId ?? "__active__", [...this.entities, ...derived]),
      this.plane,
      this.editingId ?? "__active__",
      [...this.entities, ...derived],
    );
    this.candidates = candidatesFromEntities([...this.entities, ...derived]);
    // an in-progress dimension holds entity REFERENCES, and a solve replaces
    // every entity object — re-read the picks off the fresh list
    if (this.dimPicks.length) this.refreshDimPlan();
    if (this.dimsVisible) this.dims.show(this.entities, this.plane, this.constraintDimExtras());
    else this.dims.hide();
    if (this.glyphsVisible) this.glyphs.show(constraintGlyphs(this.entities, this.constraints), this.plane, this.conflictIdx, this.overIdx);
    else this.glyphs.hide();
    // On-demand renderer: a keyboard-driven repaint (e.g. async text glyphs landing
    // via redraw()) fires no pointer event, so force a frame or it won't draw until
    // the next mouse move.
    this.viewport.requestRender();
  }

  /** Lightweight per-frame refresh for dragging: only the curve geometry moves,
   * so skip the snap-candidate array (snapping is off mid-drag) and the
   * dimension-label DOM teardown/rebuild. refreshActive() restores both on end. */
  private refreshDragGeometry() {
    this.entityVersion++;
    this.overlay.setActiveSketch(curveObjects(this.entities, this.plane, this.activeColor()));
  }

  // --- Sketch Palette options ---
  setGridVisible(on: boolean) {
    this.gridVisible = on;
    if (this.grid) this.grid.visible = on;
  }
  setGridSnap(on: boolean) {
    this.gridSnap = on;
  }
  setConstruction(on: boolean) {
    this.constructionMode = on;
  }
  setReferenceDim(on: boolean) {
    this.referenceMode = on;
  }
  /** place a dimension, stamping it driven (reference, measured-only) when the
   *  Reference palette toggle is on — or when the plan says every operand is
   *  fixed reference geometry, where a driving dim could never be satisfied.
   *  Only the 4 placed dims carry `driven` (see types.ts): a line's length and a
   *  circle's diameter always show their own measurement badge, so Reference
   *  can't apply to them — say so rather than dropping the flag in silence.
   *  Returns the constraint that was placed (carrying the id it was born with,
   *  or inherited), so a caller can bind an expression to it. */
  private placeDim(c: SketchConstraint, forceDriven = false): SketchConstraint {
    const drivenable = isPlacedDim(c);
    const driven = drivenable && (this.referenceMode || forceDriven);
    if (this.referenceMode && !drivenable) {
      toast("A line length / circle diameter can't be a reference dimension yet — created as driving.");
    }
    const out = driven ? ({ ...c, driven: true } as SketchConstraint) : c;
    this.setDrivingDimension(out);
    return out;
  }
  setDimensionsVisible(on: boolean) {
    this.dimsVisible = on;
    this.refreshActive(); // toggles both the dimension lines and the value labels
  }
  setConstraintsVisible(on: boolean) {
    this.glyphsVisible = on;
    this.refreshActive();
  }
  /** Delete the constraint at `cIndex` (clicked its glyph) and re-solve. */
  private deleteConstraint(cIndex: number) {
    if (cIndex < 0 || cIndex >= this.constraints.length) return;
    this.constraints.splice(cIndex, 1);
    this.conflictIdx.clear(); // indices shift; the next solve repopulates
    this.overIdx.clear();
    this.requestSolve();
    this.refreshActive();
    this.onState?.();
  }
  /** Lock the camera square to the sketch plane: re-square now and disable orbit
   *  (mouse + SpaceMouse) so the view can't tilt off the plane. Unlock = free orbit. */
  setViewLocked(on: boolean) {
    this.viewLocked = on;
    if (on) this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.viewport.rig.setOrbitLocked(on);
    setSpaceMouseOrbitLocked(on);
  }
  /** re-square the camera to the active sketch plane (palette "Look At") */
  lookAt() {
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
  }

  /** Apply an edited dimension value (mm) to an entity. Line length and circle
   *  diameter become driving solver constraints (so other constraints are kept);
   *  everything else (rectangle W/H, line angle) edits coordinates directly. */
  private editDimension(index: number, field: DimField, mm: number) {
    const e = this.entities[index];
    if (!e) return;
    if (e.type === "line" && field === "length") {
      this.setDrivingDimension({ type: "distance", line: e.id, value: mm });
      return;
    }
    if (e.type === "circle" && field === "diameter") {
      this.setDrivingDimension({ type: "diameter", circle: e.id, value: mm });
      return;
    }
    entityDims(e).find((d) => d.field === field)?.write(mm);
    this.refreshActive();
  }

  /** clickable labels for the distance constraints: editing one writes the
   *  constraint's driving value and re-solves. Reads the cdims activeCurves()
   *  computed earlier in the same refreshActive() pass. */

  // --- dimension label placement (drag) ---------------------------------
  // A dragged label writes its offset where that dimension's placement LIVES:
  // on the constraint for the placed dims, on the entity (`dimPlace`) for the
  // badges, which have no backing constraint. See types.ts. Placement is
  // annotation only — it never changes geometry, so neither path re-solves.

  /** Re-lay-out after a placement write and hand back the dim's new label
   *  anchor. Mid-drag stays on the cheap path — curves + dimension lines only —
   *  because a full refreshActive() would tear down the very label element the
   *  drag is riding on. */
  private afterPlaceDrag(done: boolean, anchor: () => THREE.Vector2 | null): THREE.Vector2 | null {
    if (done) {
      this.refreshActive();
      this.onState?.(); // undo checkpoint: the placement is a document edit
      return null; // labels were just rebuilt — the caller's is gone
    }
    this.overlay.setActiveSketch(this.activeCurves(this.derivedEntities())); // also refreshes this.cdims
    this.viewport.requestRender();
    return anchor();
  }

  /** Persist a dragged ENTITY badge placement (rect W/H, circle diameter,
   *  polygon radius, slot L/W, line length). A drag back onto the geometry
   *  (clampPlace's null: inside the same screen-space floor the badge's own
   *  clearance uses) CLEARS the placement rather than freezing a degenerate one
   *  — that's how the user gets the default layout back. */
  private commitEntityPlace(
    index: number, field: DimField, ox: number, oy: number, done: boolean,
  ): THREE.Vector2 | null {
    const e = this.entities[index];
    if (!e || !isBadgeEntity(e)) return null; // not a badge-bearing type
    const p = clampPlace(ox, oy, this.viewport.pixelWorldSize(this.plane.origin));
    const next = { ...dimPlaceOf(e) };
    if (p) next[field] = p;
    else delete next[field];
    if (Object.keys(next).length) e.dimPlace = next;
    else delete e.dimPlace; // omit when empty (byte stability, like every optional)
    return this.afterPlaceDrag(done, () => {
      const cur = this.entities[index];
      if (!cur) return null;
      // recompute through the same neighbour-aware defaults the labels render
      // with, so a mid-drag label tracks its dim's REAL anchor
      const def = staggeredDefaults(this.entities).get(cur.id);
      return entityDims(cur, def).find((d) => d.field === field)?.labelPos ?? null;
    });
  }

  /** Persist a dragged CONSTRAINT dim placement (the placed dims — see
   *  isPlacedDim, which is exactly the set that carries `place`). */
  private commitConstraintPlace(cIndex: number, ox: number, oy: number, done: boolean): THREE.Vector2 | null {
    const c = this.constraints[cIndex];
    if (!c || !isPlacedDim(c)) return null;
    const p = clampPlace(ox, oy, this.viewport.pixelWorldSize(this.plane.origin));
    const { place: _dropped, ...rest } = c;
    this.constraints[cIndex] = (p ? { ...c, place: p } : rest) as SketchConstraint;
    return this.afterPlaceDrag(done, () => this.cdims.find((d) => d.cIndex === cIndex)?.labelPos ?? null);
  }

  private constraintDimExtras(): ExtraDim[] {
    return this.cdims.map((d) => {
      const st = diagnosisOf(d.cIndex, this.conflictIdx, this.overIdx);
      const con = this.constraints[d.cIndex];
      const key = con && isDimConstraint(con) && con.id ? `c:${con.id}` : null;
      const expr = key ? this.exprFor(key) : undefined;
      return {
        anchor: d.labelPos,
        valueMm: d.valueMm,
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.driven ? { driven: true } : {}),
        ...(st === "conflict" ? { conflict: true } : st === "over" ? { over: true } : {}),
        ...(expr ? { expr } : {}),
        // draggable only when this dim's constraint has a `place` slot to write
        // to (constraintDims omits `place` for the ones that don't)
        ...(d.place
          ? {
            place: d.place,
            placeCommit: (ox: number, oy: number, done: boolean) =>
              this.commitConstraintPlace(d.cIndex, ox, oy, done),
          }
          : {}),
        commit: (val: number) => {
          const c = this.constraints[d.cIndex];
          if (c && isPlacedDim(c)) {
            c.value = val;
            this.requestSolve();
            this.onState?.();
          }
        },
        commitExpr: (raw: string) => {
          const c = this.constraints[d.cIndex];
          if (!c || !isDimConstraint(c)) return "not editable";
          if (!c.id) c.id = newConstraintId();
          return this.commitExprInput(`c:${c.id}`, d.kind === "angle" ? "angle" : "length", raw, (v) => {
            c.value = v;
            this.requestSolve();
            this.onState?.();
          });
        },
      };
    });
  }

  /** Add/replace the driving dimension on an entity, then re-solve. A dim gets
   *  its stable id at birth; a replacement inherits the replaced dim's id, so a
   *  parameter binding survives retyping the dimension. */
  private setDrivingDimension(c: SketchConstraint) {
    // the unordered pair of rounds a rim-gap dim spans. radialGap and
    // c2cDistance are the SAME user intent ("the gap between these two rims") in
    // two solver formulations — treating them as one target is what stops a
    // stale c2cDistance surviving when the pair becomes concentric (or the
    // reverse) and gets re-dimensioned.
    const rimPair = (k: SketchConstraint): string | null =>
      k.type === "radialGap" ? [k.inner, k.outer].sort().join("|")
        : k.type === "c2cDistance" ? [k.c1, k.c2].sort().join("|")
          : null;
    const sameTarget = (k: SketchConstraint): boolean => {
      if (c.type === "distance" && k.type === "distance") return k.line === c.line;
      if (c.type === "diameter" && k.type === "diameter") return k.circle === c.circle;
      if (c.type === "p2pDistance" && k.type === "p2pDistance") {
        return (
          (k.e1 === c.e1 && k.p1 === c.p1 && k.e2 === c.e2 && k.p2 === c.p2) ||
          (k.e1 === c.e2 && k.p1 === c.p2 && k.e2 === c.e1 && k.p2 === c.p1)
        );
      }
      if (c.type === "p2lDistance" && k.type === "p2lDistance") {
        return k.e === c.e && k.p === c.p && k.line === c.line;
      }
      if (c.type === "radius" && k.type === "radius") return k.e === c.e;
      if (c.type === "angle" && k.type === "angle") {
        return (k.l1 === c.l1 && k.l2 === c.l2) || (k.l1 === c.l2 && k.l2 === c.l1);
      }
      const pair = rimPair(c);
      if (pair !== null) return pair === rimPair(k);
      if (c.type === "c2lDistance" && k.type === "c2lDistance") return k.circle === c.circle && k.line === c.line;
      if (c.type === "p2cDistance" && k.type === "p2cDistance") {
        return k.e === c.e && k.p === c.p && k.circle === c.circle;
      }
      return false;
    };
    let replacedId: string | undefined;
    this.constraints = this.constraints.filter((k) => {
      if (!sameTarget(k)) return true;
      if (isDimConstraint(k) && k.id) replacedId = k.id;
      return false;
    });
    if (isDimConstraint(c) && !c.id) c.id = replacedId ?? newConstraintId();
    this.constraints.push(c);
    this.requestSolve();
  }

  // --- parameter bindings on sketch dims -------------------------------------
  // While the sketch is OPEN its dims aren't in the document yet, so expression
  // bindings are recorded here (keyed `c:<constraintId>` / `e:<entityId>:<field>`)
  // and land atomically with the sketch commit (store.applyBindings inside the
  // same mutate). Bound dims render fx: and reopen their expression.
  private pendingBindings = new Map<string, { expr: string; kind: FieldKind; name?: string }>();

  /** the sketch feature id currently open for editing (null for a new sketch
   *  or when the editor is closed) — the store's cascade must not headlessly
   *  overwrite it. */
  get openDocId(): string | null {
    return this.active ? this.editingId : null;
  }

  /** binding key → ParamTarget once the owning sketch id is known. */
  private static targetOf(key: string, sketchId: string): ParamTarget {
    const [t, id, field] = key.split(":");
    return t === "c"
      ? { kind: "constraint", sketch: sketchId, constraint: id! }
      : { kind: "entity", sketch: sketchId, entity: id!, field: field! };
  }

  /** SketchBinding list for the commit; targets get the final sketch id. */
  private drainBindings(sketchId: string): SketchBinding[] {
    const out: SketchBinding[] = [];
    for (const [key, b] of this.pendingBindings) {
      out.push({ target: SketchMode.targetOf(key, sketchId), expr: b.expr, kind: b.kind, ...(b.name ? { name: b.name } : {}) });
    }
    this.pendingBindings.clear();
    return out;
  }

  /** the DOCUMENT-side binding for a pending key (editing an existing sketch). */
  private docBinding(key: string): { name: string; expr: string; value: number } | null {
    if (!this.editingId || !this.store) return null;
    return this.store.boundExpr(SketchMode.targetOf(key, this.editingId));
  }

  /** the driving expression for a bound dim key — pending wins over the doc. */
  private exprFor(key: string): string | undefined {
    return this.pendingBindings.get(key)?.expr ?? this.docBinding(key)?.expr;
  }

  /** Evaluate raw dim input for the binding slot `key`: a plain number in
   *  display units, or an expression in canonical units — including the
   *  `name=expr` form (names the dim's model parameter). The number/formula
   *  fork and the positivity rule for sketch dims live here (the label
   *  editor's plain-number path on UNBOUND dims re-checks positivity in
   *  sketchDimensions.beginEdit). `expr` is null for plain numbers; `name` is
   *  set only when the input renames the binding. */
  private evalDimInput(raw: string, kind: FieldKind, key: string | null): { value: number; expr: string | null; name?: string } | { error: string } {
    if (isPlainNumber(raw)) {
      const value = parseField(raw, kind);
      if (value == null || (kind !== "angle" && !(value > 0))) return { error: "invalid value" };
      return { value, expr: null };
    }
    if (!this.store) return { error: "no document" };
    const bound = key ? (this.docBinding(key)?.name ?? null) : null;
    const pending = key ? (this.pendingBindings.get(key)?.name ?? null) : null;
    const c = this.store.classifyTargetExpr(bound, pending, raw, kind);
    if (!c.ok) return { error: c.error };
    if (kind !== "angle" && !(c.value > 0)) return { error: "must evaluate to a positive value" };
    return { value: c.value, expr: c.expr, ...(c.name ? { name: c.name } : {}) };
  }

  /** Record/refresh the pending binding for a dim edit: formulas always bind
   *  (a `name=expr` name overrides, else a previously chosen name survives);
   *  a plain number keeps an EXISTING binding as its literal. */
  private recordBinding(key: string, r: { value: number; expr: string | null; name?: string }, kind: FieldKind) {
    if (r.name) {
      this.pendingBindings.set(key, { expr: r.expr!, kind, name: r.name });
      return;
    }
    const prior = this.pendingBindings.get(key);
    const keepName = prior?.name ? { name: prior.name } : {};
    if (r.expr) this.pendingBindings.set(key, { expr: r.expr, kind, ...keepName });
    else if (prior || this.docBinding(key)) this.pendingBindings.set(key, { expr: String(r.value), kind, ...keepName });
  }

  /** Shared raw-input commit for a bindable dim slot with a known key. */
  private commitExprInput(key: string, kind: FieldKind, raw: string, apply: (value: number) => void): string | null {
    const r = this.evalDimInput(raw, kind, key);
    if ("error" in r) return r.error;
    this.recordBinding(key, r, kind);
    apply(r.value);
    return null;
  }

  /** Raw label input on an entity dimension. Line length / circle diameter
   *  convert to their driving constraint (existing behavior) and bind there;
   *  solver-rigid direct fields (polygon radius, slot width…) bind as entity
   *  targets. Everything else: numbers only for now.
   *  defer: expressions on rectangle W/H + derived dims (slot length) — needs
   *  an auto-constraint conversion; revisit when a user asks for it. */
  private commitEntityDimExpr(index: number, field: DimField, raw: string): string | null {
    const e = this.entities[index];
    if (!e) return "no entity";
    if (e.type === "line" && field === "length") return this.commitConvertedDim({ type: "distance", line: e.id, value: 0 }, raw);
    if (e.type === "circle" && field === "diameter") return this.commitConvertedDim({ type: "diameter", circle: e.id, value: 0 }, raw);
    const bindable = RIGID_ENTITY_NUM_FIELDS[e.type]?.some(([f]) => f === field);
    if (!bindable) return "this dimension can't hold an expression yet";
    return this.commitExprInput(`e:${e.id}:${field}`, "length", raw, (v) => {
      entityDims(e).find((d) => d.field === field)?.write(coerceForField(field, v));
      this.refreshActive();
      this.onState?.();
    });
  }

  /** Entity length/⌀ input that must live on a driving constraint: evaluate
   *  first, place the constraint (id carries over on replace), then bind. */
  private commitConvertedDim(base: Extract<SketchConstraint, { type: "distance" } | { type: "diameter" }>, raw: string): string | null {
    const prior =
      base.type === "distance"
        ? this.constraints.find((k): k is Extract<SketchConstraint, { type: "distance" }> => k.type === "distance" && k.line === base.line)
        : this.constraints.find((k): k is Extract<SketchConstraint, { type: "diameter" }> => k.type === "diameter" && k.circle === base.circle);
    const r = this.evalDimInput(raw, "length", prior?.id ? `c:${prior.id}` : null);
    if ("error" in r) return r.error;
    const c = { ...base, value: r.value };
    this.setDrivingDimension(c); // stamps a fresh id or inherits the replaced dim's
    this.recordBinding(`c:${(c as { id?: string }).id!}`, r, "length");
    this.onState?.();
    return null;
  }

  /** the driving expression shown on an entity dim label, when bound. */
  private entityDimExpr(index: number, field: DimField): string | undefined {
    const e = this.entities[index];
    if (!e) return undefined;
    if (e.type === "line" && field === "length") {
      const c = this.constraints.find((k): k is Extract<SketchConstraint, { type: "distance" }> => k.type === "distance" && k.line === e.id);
      return c?.id ? this.exprFor(`c:${c.id}`) : undefined;
    }
    if (e.type === "circle" && field === "diameter") {
      const c = this.constraints.find((k): k is Extract<SketchConstraint, { type: "diameter" }> => k.type === "diameter" && k.circle === e.id);
      return c?.id ? this.exprFor(`c:${c.id}`) : undefined;
    }
    if (RIGID_ENTITY_NUM_FIELDS[e.type]?.some(([f]) => f === field)) return this.exprFor(`e:${e.id}:${field}`);
    return undefined;
  }

  /** A parameter commit landed (store.onParamsApplied): refresh every bound
   *  live dim value — document bindings read the table, pending ones
   *  re-evaluate — then re-solve so the geometry follows. */
  syncParamValues() {
    if (!this.active || !this.store) return;
    const valueFor = (key: string): number | null => {
      const pend = this.pendingBindings.get(key);
      if (pend) {
        const v = this.store!.classifyTargetExpr(null, null, pend.expr, pend.kind);
        return v.ok ? v.value : null;
      }
      return this.docBinding(key)?.value ?? null;
    };
    let touched = false;
    for (const c of this.constraints) {
      if (!isDimConstraint(c) || !c.id) continue;
      const next = valueFor(`c:${c.id}`);
      if (next != null && next !== c.value) {
        c.value = next;
        touched = true;
      }
    }
    for (const e of this.entities) {
      for (const [field] of RIGID_ENTITY_NUM_FIELDS[e.type] ?? []) {
        const next = valueFor(`e:${e.id}:${field}`);
        if (next == null) continue;
        const rec = e as unknown as Record<string, unknown>;
        const coerced = coerceForField(field, next);
        if (rec[field] !== coerced) {
          rec[field] = coerced;
          touched = true;
        }
      }
    }
    if (touched) {
      this.requestSolve();
      this.refreshActive();
      this.onState?.();
    }
  }

  /** Projection refresh for the OPEN sketch (injected via
   *  store.onProjectionsApplied — the mirror of syncParamValues): patch the
   *  session copies of the updated projected entities, then re-solve so
   *  constrained geometry follows and the overlay repaints. The doc copy is
   *  NOT written while the sketch is open; finish() persists the session. */
  syncProjectedCurves(updates: ProjectionUpdate[]) {
    if (!this.active) return;
    let touched = false;
    for (const u of updates) {
      const i = this.entities.findIndex((x) => x.type === "projected" && x.id === u.entity);
      const e = this.entities[i];
      if (!e || e.type !== "projected") continue;
      if (u.stale && e.stale) continue; // already flagged — nothing changes
      this.entities[i] = applyProjectionUpdate(e, u);
      touched = true;
    }
    if (touched) {
      this.requestSolve();
      this.refreshActive();
    }
  }

  /** Geometry-beats-label: called from a dimension badge's pointerdown when the
   *  badge sits over sketch geometry (common at low zoom — the badge is a DOM
   *  element above the canvas, so the canvas never sees the click). Select the
   *  entity under the cursor and return true; the badge then skips its
   *  value-edit. False = nothing underneath, the badge behaves normally. */
  private labelOverlapSelect(e: PointerEvent): boolean {
    if (this.tool !== "select") return false;
    const raw = this.planePoint(e);
    if (!raw) return false;
    const idx = pickEntity(this.entities, raw, this.pickTol());
    const ent = idx >= 0 ? this.entities[idx] : undefined;
    if (!ent) return false;
    if (e.shiftKey) {
      if (!this.selected.delete(ent.id)) this.selected.add(ent.id);
    } else {
      this.selected = new Set([ent.id]);
    }
    this.refreshActive();
    return true;
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button === 2) { this.rightDownAt = { x: e.clientX, y: e.clientY }; this.rightDragged = false; }
    if (e.button !== 0) return; // left only; middle/right still navigate
    // Project picks 3D model geometry / committed sketch curves — it needs the
    // raw client coords, so it branches BEFORE the plane-point conversion.
    if (this.tool === "project") {
      e.preventDefault();
      void this.projectClick(e);
      return;
    }
    // Dimension takes the RAW plane point, and branches before snapAt's
    // early-return: snapping to a nearby vertex pulls the point off a circle's
    // rim (defeating the rim hit-test at high zoom), and a failed snap would
    // otherwise swallow the click entirely.
    if (this.tool === "dimension") {
      const raw = this.planePoint(e);
      if (!raw) return;
      e.preventDefault();
      this.dimensionClick(raw, e);
      return;
    }
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);
    if (!hit) return;
    e.preventDefault();
    const p = hit.p;

    if (this.tool === "select") {
      // grab a point to drag it — connected/constrained geometry follows
      const gp = this.pickPoint(p);
      if (gp) {
        this.dragFrom = gp.p.clone();
        this.dragEntIdx = gp.idx;
        this.dragStartClient = { x: e.clientX, y: e.clientY };
        this.dragMoved = false;
        this.dragShift = e.shiftKey;
        this.dragRefusedToast = false;
        this.dragSnapshot = JSON.parse(JSON.stringify(this.entities)); // for Esc-cancel revert
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // no draggable vertex under the cursor → (de)select the entity body / area
      const raw = this.planePoint(e) ?? p;
      // DOUBLE-click a pattern's derived copy → edit the owning pattern (associative).
      // A SINGLE click must NOT edit — it selects the cell's profile area for extrude
      // (the whole point of a patterned hole/cell, esp. a thin sub-area carved by a
      // crossing curve, which is always within pick-tolerance of an outline edge).
      const derived = this.derivedEntities();
      const di = pickEntity(derived, raw, this.pickTol());
      const de = di >= 0 ? derived[di] : undefined;
      if (de && e.detail >= 2) {
        this.editPattern(de.id.split("#")[0] ?? de.id);
        return;
      }
      // DOUBLE-click text → re-open the text panel to edit it in place. (Text isn't
      // pickable as an entity — entitySegments is empty — so it's found via its glyph
      // group's bounding box, a generous hit that lands even between letters.)
      if (e.detail >= 2) {
        const te = this.textEntityAt(raw);
        if (te) {
          this.editText(te, e);
          return;
        }
      }
      // a real (hand-drawn) entity's body under the cursor → arm a body drag;
      // a plain click (no movement) falls through to selection in endDrag()
      const idx = pickEntity(this.entities, raw, this.pickTol());
      const hit = idx >= 0 ? this.entities[idx] : undefined;
      if (hit) {
        this.moveDrag = {
          idx,
          startClient: { x: e.clientX, y: e.clientY },
          last: raw.clone(),
          started: false,
          shift: e.shiftKey,
          stretch: [],
        };
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // otherwise select a profile AREA to extrude — includes patterned cells and
      // sub-areas carved by a crossing curve
      const wr = this.overlay.activeRegionAt(raw);
      if (wr) {
        this.overlay.toggleRegionSelection(wr, e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      }
      // empty space → clear both entity and area selection
      if (!e.shiftKey) {
        this.selected.clear();
        this.overlay.clearRegionSelection();
      }
      this.refreshActive();
      return;
    }
    if (PATTERN_TOOLS.has(this.tool)) return this.patternClick(p);
    if (this.tool === "arc") return this.arcClick(p);
    if (this.tool === "spline") return this.splineClick(p);
    if (this.tool === "point") return this.pointClick(p);
    if (this.tool === "text") {
      // click on existing text → edit it (discoverable: the text tool also edits);
      // otherwise begin a placement: drag to define a box, or release for a point anchor
      const te = this.textEntityAt(p);
      if (te) { this.editText(te, e); return; }
      this.textBoxStart = p.clone();
      this.textBoxEnd = null;
      this.textBoxScreen = { x: e.clientX, y: e.clientY };
      try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    if (this.tool === "polygon") return this.polygonClick(p);
    if (this.tool === "slot") return this.slotClick(p);
    if (this.tool === "circle2") return this.circle2Click(p);
    if (this.tool === "circle3") return this.circle3Click(p);
    if (this.tool === "centerRectangle") return this.centerRectClick(p);
    if (this.tool === "mirror") return this.mirrorClick(p);
    if (this.tool === "trim") return this.trimClick(p);
    if (this.tool === "fillet") return this.filletClick(p);
    if (this.tool === "chamfer") return this.chamferClick(p);
    if (this.tool === "move" || this.tool === "copy") return this.moveClick(p);
    if (this.tool === "rotate") return this.rotateClick(p);
    if (this.tool === "scale") return this.scaleClick(p);
    if (this.tool === "offset") return this.offsetClick(p);
    if (this.tool === "extend") return this.extendClick(p);
    if (this.tool === "break") return this.breakClick(p);
    if (CONSTRAINT_TOOLS.has(this.tool)) return this.constraintClick(p);

    if (!this.base) {
      this.base = p.clone();
      if (this.tool === "line") this.chainStart = p.clone(); // remember loop start
      this.showDimFields();
      return;
    }
    // second click → commit the entity using current dims
    this.commitFromCursor(p);
  }

  // 3-point arc: click start, click end, then click the point it passes through
  private arcClick(p: THREE.Vector2) {
    if (!this.arcStart) {
      this.arcStart = p.clone();
    } else if (!this.arcEnd) {
      this.arcEnd = p.clone();
    } else {
      const a = this.arcStart;
      const b = this.arcEnd;
      const ent: ResolvedEntity = {
        type: "arc",
        id: newEntityId(),
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        mx: p.x,
        my: p.y,
      };
      if (this.constructionMode) ent.construction = true;
      this.entities.push(ent);
      this.arcStart = null;
      this.arcEnd = null;
      this.refreshActive();
      this.overlay.setPreview([]);
      this.requestSolve(); // include the arc in the solve (updates DOF colour)
      this.onState?.();
    }
  }

  // MCAD-style fit-point spline: click to drop points; click the last point
  // again (or press Enter) to finish, Escape to cancel.
  private splineClick(p: THREE.Vector2) {
    const last = this.splinePts[this.splinePts.length - 1];
    if (last && last.distanceTo(p) < 1e-3) {
      this.finishSpline();
      return;
    }
    this.splinePts.push(p.clone());
  }

  private finishSpline() {
    if (this.splinePts.length >= 2) {
      const ent: ResolvedEntity = {
        type: "spline",
        id: newEntityId(),
        points: this.splinePts.map((q) => ({ x: q.x, y: q.y })),
      };
      if (this.constructionMode) ent.construction = true;
      this.entities.push(ent);
      this.refreshActive();
      this.requestSolve();
    }
    this.splinePts = [];
    this.overlay.setPreview([]);
    this.onState?.();
  }

  private splinePreview(cursor: THREE.Vector2) {
    if (!this.splinePts.length) return this.overlay.setPreview([]);
    const pts = [...this.splinePts.map((q) => ({ x: q.x, y: q.y })), { x: cursor.x, y: cursor.y }];
    this.overlay.setPreview([this.entityCurve({ type: "spline", id: "", points: pts })]);
  }

  /** rubber-band preview for the multi-click primitive tools */
  private multiClickPreview(cursor: THREE.Vector2, e?: PointerEvent) {
    const pv: ResolvedEntity[] = [];
    let dims: Record<string, number> | null = null;
    if (this.tool === "polygon" && this.clickPts.length === 1) {
      const a = this.clickPts[0];
      if (a) {
        const vertex = this.polygonVertex(a, cursor);
        pv.push({ type: "polygon", id: "", x: a.x, y: a.y, radius: a.distanceTo(vertex), sides: Math.max(3, Math.round(this.polygonSides)), angle: (Math.atan2(vertex.y - a.y, vertex.x - a.x) * 180) / Math.PI });
        dims = { radius: a.distanceTo(vertex) };
      }
    } else if (this.tool === "slot") {
      if (this.clickPts.length === 1) {
        const a = this.clickPts[0];
        if (a) {
          const b = this.slotEnd(a, cursor);
          pv.push({ type: "line", id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          dims = { length: a.distanceTo(b) };
        }
      } else if (this.clickPts.length === 2) {
        const [a, b] = this.clickPts;
        if (a && b) {
          const half = this.slotHalf(a, b, cursor);
          pv.push({ type: "slot", id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: half * 2 });
          dims = { width: half * 2 };
        }
      }
    } else if (this.tool === "circle2" && this.clickPts.length === 1) {
      const a = this.clickPts[0];
      if (a) {
        const end = this.circle2End(a, cursor);
        const ctr = a.clone().add(end).multiplyScalar(0.5);
        pv.push({ type: "circle", id: "", radius: a.distanceTo(end) / 2, x: ctr.x, y: ctr.y });
        dims = { diameter: a.distanceTo(end) };
      }
    } else if (this.tool === "circle3") {
      // fully determined by the three picked points — no dimension to type
      if (this.clickPts.length === 1) {
        const a = this.clickPts[0];
        if (a) pv.push({ type: "line", id: "", x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y });
      } else if (this.clickPts.length === 2) {
        const [a, b] = this.clickPts;
        const cc = a && b ? circumcenter(a, b, cursor) : null;
        if (cc) pv.push({ type: "circle", id: "", radius: cc.distanceTo(cursor), x: cc.x, y: cc.y });
      }
    } else if (this.tool === "centerRectangle" && this.clickPts.length === 1) {
      const c = this.clickPts[0];
      if (c) {
        const { w, h } = this.centerRectSize(c, cursor);
        pv.push({ type: "rectangle", id: "", width: w, height: h, x: c.x, y: c.y });
        dims = { width: w, height: h };
      }
    }
    if (dims) {
      this.dim.updateFromCursor(dims);
      if (e) this.dim.position(e.clientX, e.clientY);
    }
    this.overlay.setPreview(pv.map((ent) => this.entityCurve(ent)));
  }

  // --- typed dims for the multi-click tools: the same isUserDriven gating the
  // single-drag tools use in computeGeometry(), shared by preview + commit ------

  /** dim fields per multi-click tool (and phase, for slot); Enter commits at the cursor */
  private showMultiDimFields() {
    const t = this.tool;
    const defs =
      t === "circle2"
        ? [{ name: "diameter", label: "⌀" }]
        : t === "polygon"
          ? [{ name: "radius", label: "R" }, { name: "sides", label: "N", kind: "count" as const }]
          : t === "centerRectangle"
            ? [{ name: "width", label: "W" }, { name: "height", label: "H" }]
            : t === "slot"
              ? this.clickPts.length === 1
                ? [{ name: "length", label: "L" }]
                : [{ name: "width", label: "W" }]
              : null;
    if (!defs) return;
    this.dim.show(defs, () => this.multiClickAt(this.lastCursor.clone()));
  }

  private multiClickAt(p: THREE.Vector2) {
    if (this.tool === "polygon") this.polygonClick(p);
    else if (this.tool === "slot") this.slotClick(p);
    else if (this.tool === "circle2") this.circle2Click(p);
    else if (this.tool === "centerRectangle") this.centerRectClick(p);
  }

  /** circle2: the second diameter endpoint, honoring a typed ⌀ (along a→cursor) */
  private circle2End(a: THREE.Vector2, cursor: THREE.Vector2): THREE.Vector2 {
    if (!this.dim.isUserDriven("diameter")) return cursor.clone();
    const dia = this.dim.getValue("diameter");
    if (dia == null || dia <= 0) return cursor.clone();
    const dir = cursor.clone().sub(a);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0);
    else dir.normalize();
    return a.clone().add(dir.multiplyScalar(dia));
  }

  /** polygon: the first vertex, honoring a typed circumradius R (along center→cursor) */
  private polygonVertex(center: THREE.Vector2, cursor: THREE.Vector2): THREE.Vector2 {
    if (!this.dim.isUserDriven("radius")) return cursor.clone();
    const r = this.dim.getValue("radius");
    if (r == null || r <= 0) return cursor.clone();
    const dir = cursor.clone().sub(center);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0);
    else dir.normalize();
    return center.clone().add(dir.multiplyScalar(r));
  }

  /** centerRectangle: full width/height, honoring typed values */
  private centerRectSize(c: THREE.Vector2, cursor: THREE.Vector2): { w: number; h: number } {
    let w = Math.abs(cursor.x - c.x) * 2;
    let h = Math.abs(cursor.y - c.y) * 2;
    if (this.dim.isUserDriven("width")) w = this.dim.getValue("width") ?? w;
    if (this.dim.isUserDriven("height")) h = this.dim.getValue("height") ?? h;
    return { w, h };
  }

  /** slot: the axis end point, honoring a typed length L (along a→cursor) */
  private slotEnd(a: THREE.Vector2, cursor: THREE.Vector2): THREE.Vector2 {
    if (!this.dim.isUserDriven("length")) return cursor.clone();
    const len = this.dim.getValue("length");
    if (len == null || len <= 0) return cursor.clone();
    const dir = cursor.clone().sub(a);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0);
    else dir.normalize();
    return a.clone().add(dir.multiplyScalar(len));
  }

  /** slot: half-width from the cursor, honoring a typed full width W */
  private slotHalf(a: THREE.Vector2, b: THREE.Vector2, cursor: THREE.Vector2): number {
    if (this.dim.isUserDriven("width")) {
      const w = this.dim.getValue("width");
      if (w != null && w > 0) return w / 2;
    }
    return this.slotHalfWidth(a, b, cursor);
  }

  // --- point: a single click drops a reference/snap point ---------------
  private pointClick(p: THREE.Vector2) {
    const ent: ResolvedEntity = { type: "point", id: newEntityId(), x: p.x, y: p.y };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.overlay.setPreview([]);
    this.requestSolve();
    this.onState?.();
  }

  /** the smallest rectangle entity that contains `p`, or null — used to format text
   *  INSIDE a drawn box (centered + wrapped to the box width). */
  /** Plane-frame angle (radians) of the current view's screen-right direction. The
   *  sketch view squares to the plane but can sit at any 90° rotation (nearest-square
   *  entry — enterSketchView), so text is placed relative to what the user currently
   *  sees as horizontal, not the plane's raw +X (which may point up/down on screen). */
  private viewRightAngle(): number {
    const right = new THREE.Vector3().setFromMatrixColumn(this.viewport.rig.active.matrixWorld, 0);
    return Math.atan2(right.dot(this.plane.v), right.dot(this.plane.u));
  }

  private rectContaining(
    p: THREE.Vector2,
    phi: number,
  ): { x: number; y: number; width: number } | null {
    let best: { x: number; y: number; width: number } | null = null;
    let bestArea = Infinity;
    for (const e of this.entities) {
      if (e.type !== "rectangle") continue;
      if (Math.abs(p.x - e.x) <= e.width / 2 && Math.abs(p.y - e.y) <= e.height / 2) {
        const area = e.width * e.height;
        if (area < bestArea) {
          bestArea = area;
          // wrap width = the rect's extent along the view's horizontal (screen-right)
          const w = e.width * Math.abs(Math.cos(phi)) + e.height * Math.abs(Math.sin(phi));
          best = { x: e.x, y: e.y, width: w };
        }
      }
    }
    return best;
  }

  /** Open the text panel for a placement. `explicitBox` is a dragged box; otherwise a
   *  click that lands inside a rectangle binds the text into it (centered + wrapped). */
  /** The text entity (if any) under a 2D sketch point — generous bounding-box hit. */
  /** Remove the in-progress text preview entity from the active list. Returns true
   *  if one was present (so callers can skip a repaint when nothing changed). */
  private dropTextPreview(): boolean {
    const before = this.entities.length;
    this.entities = this.entities.filter((e) => e.id !== TEXT_PREVIEW_ID);
    return this.entities.length !== before;
  }

  private textEntityAt(p: THREE.Vector2): Extract<ResolvedEntity, { type: "text" }> | null {
    const id = this.overlay.activeTextIdAt(p);
    if (!id) return null;
    const te = this.entities.find((x) => x.id === id);
    return te && te.type === "text" ? te : null;
  }

  /** Re-open the text panel to edit an existing text, anchored near the pointer. */
  private editText(te: Extract<ResolvedEntity, { type: "text" }>, e: PointerEvent) {
    this.openTextPanel(
      new THREE.Vector2(te.x, te.y),
      { x: e.clientX, y: e.clientY },
      undefined,
      te,
      this.viewRightAngle(),
    );
  }

  private openTextPanel(
    clickPoint: THREE.Vector2,
    screen: { x: number; y: number },
    explicitBox?: { x: number; y: number; width: number },
    editEntity?: Extract<ResolvedEntity, { type: "text" }>,
    viewPhi = 0,
  ) {
    // Text advances along the view's screen-right; `phiDeg` is baked into the stored
    // (plane-frame) angle so 0° in the panel = horizontal as the user sees it, and
    // editing subtracts it back out to show the user-facing angle.
    const phiDeg = (viewPhi * 180) / Math.PI;
    const box = editEntity
      ? editEntity.boxWidth !== undefined
        ? { x: editEntity.x, y: editEntity.y, width: editEntity.boxWidth }
        : undefined
      : (explicitBox ?? this.rectContaining(clickPoint, viewPhi));
    const anchor = editEntity
      ? { x: editEntity.x, y: editEntity.y }
      : box
        ? { x: box.x, y: box.y }
        : { x: clickPoint.x, y: clickPoint.y };
    const id = editEntity ? editEntity.id : newEntityId();
    const construction = editEntity ? !!editEntity.construction : this.constructionMode;
    const build = (v: TextValues): ResolvedEntity => ({
      type: "text", id, text: v.text,
      x: anchor.x, y: anchor.y, height: v.height, style: v.style,
      align: box ? "center" : v.align, angle: v.angle + phiDeg,
      ...(v.font ? { font: v.font } : {}),
      ...(v.boxWidth ? { boxWidth: v.boxWidth } : box ? { boxWidth: box.width } : {}),
      ...(editEntity?.pathRef !== undefined ? { pathRef: editEntity.pathRef } : {}),
      ...(editEntity?.positionOnPath !== undefined ? { positionOnPath: editEntity.positionOnPath } : {}),
      ...(construction ? { construction: true } : {}),
    });
    const initial: Partial<TextValues> = editEntity
      ? {
          text: editEntity.text, height: editEntity.height, angle: editEntity.angle - phiDeg,
          ...(editEntity.style ? { style: editEntity.style } : {}),
          ...(editEntity.align ? { align: editEntity.align } : {}),
          ...(editEntity.font ? { font: editEntity.font } : {}),
          ...(editEntity.boxWidth !== undefined ? { boxWidth: editEntity.boxWidth } : {}),
        }
      : { height: 10, ...(box ? { boxWidth: box.width, align: "center" } : {}) };
    // Editing: hide the original text so only the live preview shows; keep it to
    // restore if the edit is cancelled. editEntity is already the live list object.
    const original = editEntity;
    if (editEntity) {
      this.entities = this.entities.filter((e) => e.id !== id);
      this.selected.clear();
      this.overlay.clearRegionSelection();
      this.refreshActive();
    }
    this.textPanel.show(screen, this.fonts, initial, {
      onChange: (v) => {
        // live preview via a temporary entity on the active list — reuses the proven
        // committed-render path (setActiveSketch), which repaints when glyphs arrive.
        this.dropTextPreview();
        this.entities.push({ ...build(v), id: TEXT_PREVIEW_ID });
        this.refreshActive();
      },
      onCommit: (v) => {
        this.entities = this.entities.filter((e) => e.id !== TEXT_PREVIEW_ID && e.id !== id);
        this.entities.push(build(v));
        this.refreshActive();
        this.requestSolve();
        this.onState?.();
      },
      onCancel: () => {
        this.dropTextPreview();
        if (original) this.entities.push(original); // restore the unedited text
        this.refreshActive();
      },
    });
  }

  // --- patterns: click to place, drag to size, type counts, click to commit. Each
  // persists as an editable (associative) definition. Entity patterns (rect/circular)
  // replicate the current selection; presets emit holes. Delegates to PatternFlow
  // (see patternFlow.ts), which owns the placement/edit state live. -------------
  private patternClick(p: THREE.Vector2) {
    // entity patterns replicate the selection — drop projected reference
    // geometry from the sources BEFORE PatternFlow snapshots them
    if (ENTITY_PATTERNS.has(this.tool)) {
      for (const id of this.warnSelectedProjected()) this.selected.delete(id);
    }
    this.patternFlow.click(p);
  }

  private patternMove(p: THREE.Vector2, e: PointerEvent) {
    this.patternFlow.move(p, e);
  }

  private commitPattern() {
    this.patternFlow.commit();
  }

  /** Associative editing: re-open an existing pattern's placement flow with its
   *  current values, so dragging/typing re-derives it live. Esc restores it. */
  private editPattern(patId: string) {
    this.patternFlow.edit(patId);
  }


  private polygonClick(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      this.showMultiDimFields(); // R
      return;
    }
    const center = this.clickPts[0];
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!center) return;
    // honor a typed side count (N); blank/invalid keeps the current count
    const rawN = this.dim.getValue("sides");
    if (rawN != null && Number.isFinite(rawN)) this.polygonSides = Math.max(3, Math.min(64, Math.round(rawN)));
    const vertex = this.polygonVertex(center, p);
    this.dim.hide();
    this.commitPolygon(center, vertex);
  }
  /** Commit a regular polygon as one parametric entity (rigid — the solver
   *  skips it; `angle` is the first-vertex angle in DEGREES). */
  private commitPolygon(center: THREE.Vector2, vertex: THREE.Vector2) {
    const r = center.distanceTo(vertex);
    if (r < 1e-4) return;
    const angle = (Math.atan2(vertex.y - center.y, vertex.x - center.x) * 180) / Math.PI;
    const e: ResolvedEntity = {
      type: "polygon", id: newEntityId(), x: center.x, y: center.y,
      radius: r, sides: Math.max(3, Math.round(this.polygonSides)), angle,
    };
    if (this.constructionMode) e.construction = true;
    this.entities.push(e);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- slot: two center points, then a width point → rounded slot --------
  private slotClick(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      this.showMultiDimFields(); // L
      return;
    }
    if (this.clickPts.length === 1) {
      const a = this.clickPts[0];
      this.clickPts.push(a ? this.slotEnd(a, p) : p.clone());
      this.showMultiDimFields(); // W (replaces the L field)
      return;
    }
    // third click sets the half-width (distance from the slot axis)
    const [a, b] = this.clickPts;
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!a || !b) return;
    const w = this.slotHalf(a, b, p);
    this.dim.hide();
    this.commitSlot(a, b, w);
  }
  private slotHalfWidth(a: THREE.Vector2, b: THREE.Vector2, cursor: THREE.Vector2): number {
    const dir = b.clone().sub(a);
    const len = dir.length() || 1;
    dir.divideScalar(len);
    const n = new THREE.Vector2(-dir.y, dir.x);
    return Math.max(0.5, Math.abs(cursor.clone().sub(a).dot(n)));
  }
  private commitSlot(a: THREE.Vector2, b: THREE.Vector2, w: number) {
    // w is the half-width (distance from the axis); the slot entity stores overall width
    if (a.distanceTo(b) < 1e-4 || w < 1e-4) return;
    const e: ResolvedEntity = { type: "slot", id: newEntityId(), x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: 2 * w };
    if (this.constructionMode) e.construction = true;
    this.entities.push(e);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- circle by 2 points (diameter endpoints) --------------------------
  private circle2Click(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      this.showMultiDimFields(); // ⌀
      return;
    }
    const a = this.clickPts[0];
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!a) return;
    const end = this.circle2End(a, p);
    const center = a.clone().add(end).multiplyScalar(0.5);
    const r = a.distanceTo(end) / 2;
    this.dim.hide();
    this.commitCircle(center, r);
  }

  // --- circle through 3 points ------------------------------------------
  private circle3Click(p: THREE.Vector2) {
    this.clickPts.push(p.clone());
    if (this.clickPts.length < 3) return;
    const [a, b, c] = this.clickPts;
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!a || !b || !c) return;
    const cc = circumcenter(a, b, c);
    if (!cc) return; // collinear
    this.commitCircle(cc, cc.distanceTo(a));
  }

  private commitCircle(center: THREE.Vector2, r: number) {
    if (r < 1e-4) return;
    const ent: ResolvedEntity = { type: "circle", id: newEntityId(), radius: r, x: center.x, y: center.y };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- center rectangle: click center, then a corner --------------------
  private centerRectClick(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      this.showMultiDimFields(); // W/H
      return;
    }
    const center = this.clickPts[0];
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!center) return;
    const { w, h } = this.centerRectSize(center, p);
    if (w < 1e-4 || h < 1e-4) return;
    this.dim.hide();
    const ent: ResolvedEntity = { type: "rectangle", id: newEntityId(), width: w, height: h, x: center.x, y: center.y };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- mirror: click a line; reflect the multi-selection across it -------
  private mirrorClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    const axis = idx >= 0 ? this.entities[idx] : undefined;
    if (!axis || axis.type !== "line") return;
    const selectedSources = this.entities.filter((e) => this.selected.has(e.id) && e.id !== axis.id);
    // projected geometry is a fixed reference — mirror the rest of the selection
    // (it stays selected; the commit below clears the whole selection anyway)
    const projected = this.warnSelectedProjected();
    const chosen = selectedSources.filter((e) => !projected.has(e.id));
    if (!chosen.length) return; // nothing selected to mirror
    const a = new THREE.Vector2(axis.x1, axis.y1);
    const b = new THREE.Vector2(axis.x2, axis.y2);
    for (const e of chosen) this.entities.push(this.reflectEntity(e, a, b));
    this.selected.clear();
    this.afterModify();
  }
  /** reflect a 2D point across the infinite line through a→b */
  private reflectPoint(x: number, y: number, a: THREE.Vector2, b: THREE.Vector2): { x: number; y: number } {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    const px = a.x + t * dx, py = a.y + t * dy; // foot of perpendicular
    return { x: 2 * px - x, y: 2 * py - y };
  }
  /** a reflected COPY of an entity (fresh id) across the line a→b */
  private reflectEntity(e: ResolvedEntity, a: THREE.Vector2, b: THREE.Vector2): ResolvedEntity {
    const rp = (x: number, y: number) => this.reflectPoint(x, y, a, b);
    const id = newEntityId();
    const c = e.construction ? { construction: true } : {};
    if (e.type === "line") {
      const p1 = rp(e.x1, e.y1), p2 = rp(e.x2, e.y2);
      return { type: "line", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ...c };
    }
    if (e.type === "circle") {
      const ctr = rp(e.x, e.y);
      return { type: "circle", id, radius: e.radius, x: ctr.x, y: ctr.y, ...c };
    }
    if (e.type === "rectangle") {
      // a reflected axis-aligned rectangle stays axis-aligned: reflect the center
      const ctr = rp(e.x, e.y);
      return { type: "rectangle", id, width: e.width, height: e.height, x: ctr.x, y: ctr.y, ...c };
    }
    if (e.type === "arc") {
      // reflection flips orientation, so the through-point reflects too
      const p1 = rp(e.x1, e.y1), p2 = rp(e.x2, e.y2), m = rp(e.mx, e.my);
      return { type: "arc", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mx: m.x, my: m.y, ...c };
    }
    if (e.type === "spline") {
      return { type: "spline", id, points: e.points.map((q) => rp(q.x, q.y)), ...c };
    }
    if (e.type === "text") {
      const at = rp(e.x, e.y); // reflect the anchor; keep the string/style (glyphs aren't mirrored)
      return { ...e, id, x: at.x, y: at.y };
    }
    // point
    const q = rp((e as Extract<ResolvedEntity, { type: "point" }>).x, (e as Extract<ResolvedEntity, { type: "point" }>).y);
    return { type: "point", id, x: q.x, y: q.y, ...c };
  }

  // --- dimension tool ----------------------------------------------------
  // Picks accumulate (0-2 operands, dimensionTool.pickDimTarget); resolveDim
  // decides WHICH dimension they describe — the type is a property of the pair,
  // not of the first pick. A placement click freezes the label position and the
  // DimInput commits the value. The tool re-arms after every commit
  // (dimensioning is a batch activity), so no setTool() call happens here.

  /** clear the whole in-progress dimension (picks, plan, frozen placement, box) */
  /** Entities selected in the select tool become this dimension's operands when
   *  the user switches to the dimension tool (Fusion: click the line, press D).
   *  Whole-entity picks only — a rectangle selected as a unit names no single
   *  edge, so resolveDim refuses it and the tool just starts empty. */
  private seedDimPicks(ids: string[]) {
    if (ids.length > 2) return; // a dimension has at most two operands
    const picks: DimTarget[] = [];
    for (const id of ids) {
      const e = this.entities.find((x) => x.id === id);
      if (!e) return;
      picks.push({ kind: "entity", e });
    }
    const r = resolveDim(picks, this.dimOptions());
    if (isDimError(r)) {
      if (r.message) toast(r.message);
      return; // unusable selection: start clean rather than half-armed
    }
    this.dimPicks = picks;
    this.dimPlan = r;
    setPrompt(r.hint);
    this.syncDimBox();
  }

  /** Put the typed value into the entity the user picked FIRST, before solving.
   *
   *  A radial gap is one equation over two free radii, so planegcs satisfies it
   *  by minimising total movement — it slides BOTH circles (a 60/50 pair asked
   *  for a 3mm wall came back 57.838/51.838). The gap is right but the result is
   *  not what anyone means: you point at the ring you want resized first, and
   *  expect the other one to stay put. Pre-setting the first-picked radius makes
   *  the system already satisfied, so the solver has nothing to redistribute and
   *  the second circle keeps its size. If other constraints disagree the solver
   *  still wins — this only chooses WHERE the slack is taken from.
   *  defer: the same treatment for c2cDistance rim clearance, whose branch
   *  depends on the centre distance too; revisit when a user reports it. */
  private seedFirstPicked(c: SketchConstraint, firstPicked: string | null) {
    if (c.type !== "radialGap" || !firstPicked) return;
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    const inner = byId.get(c.inner), outer = byId.get(c.outer);
    if (!inner || inner.type !== "circle" || !outer || outer.type !== "circle") return;
    if (firstPicked === c.inner) {
      const r = outer.radius - c.value;
      if (r > 1e-6) inner.radius = r;
    } else if (firstPicked === c.outer) {
      const r = inner.radius + c.value;
      if (r > 1e-6) outer.radius = r;
    }
  }

  private resetDimPicks() {
    this.dimPicks = [];
    this.dimPlan = null;
    this.dimPlace = null;
    this.dimPlaced = false;
    this.dimBoxAt = null;
    this.dimFieldKey = "";
    this.dimPlanKey = "";
    this.dimTangentArmed = false;
    this.dimRoundPref = undefined;
  }

  /** the right-click overrides the pair matrix reads */
  private dimOptions(): DimOptions {
    return this.dimRoundPref ? { roundPref: this.dimRoundPref } : {};
  }

  /** WHICH dimension the open box belongs to: the plan shape plus the picks it
   *  came from (rim/tangent MODE included — a rim distance and a centre distance
   *  between the same pair share a field set but are different dimensions).
   *  Re-showing the box on a change is what stops a value typed for one
   *  dimension being committed as another. */
  private dimIdentity(plan: DimPlan): string {
    return `${plan.kind}:${plan.fieldKey}|${this.dimPicks.map(targetIdentity).join("+")}`;
  }

  /** Re-resolve the current picks against the LIVE entity list. Every solve
   *  replaces the entity objects, so a held pick reference goes stale;
   *  rebindTarget re-reads it and drops picks whose geometry vanished.
   *  A dropped pick or a changed plan must reach the BOX too — otherwise the
   *  box keeps showing a field the new plan doesn't have, and the commit builds
   *  a different constraint at a value the user never saw. */
  private refreshDimPlan() {
    const before = this.dimPicks.map(targetKey).join("+");
    this.dimPicks = this.dimPicks
      .map((t) => rebindTarget(t, this.entities))
      .filter((t): t is DimTarget => t !== null);
    const r = resolveDim(this.dimPicks, this.dimOptions());
    this.dimPlan = isDimError(r) ? null : r;
    if (this.dimPicks.map(targetKey).join("+") !== before) {
      toast("The geometry this dimension referenced is gone — dimension cancelled");
      this.cancelDim();
      return;
    }
    // steady state: same picks, same plan → leave the box (and its focus /
    // anything half-typed) alone
    if (!this.dimPlan) {
      if (this.dim.isActive) { this.dim.hide(); this.dimFieldKey = ""; this.dimPlanKey = ""; }
      return;
    }
    if (this.dimIdentity(this.dimPlan) !== this.dimPlanKey) this.syncDimBox();
  }

  /** A dimension-tool click: pick an operand, or place the resolved dimension.
   *  The candidate is recomputed HERE, never read from hover state — a
   *  synthetic pointerdown arrives with no preceding pointermove. */
  private dimensionClick(p: THREE.Vector2, ev: PointerEvent) {
    const cand = pickDimTarget(this.entities, p, this.pickTol());
    // Text has no entitySegments, so pickDimTarget can never return it — without
    // this its "can't be dimensioned yet" message would be unreachable and a
    // click on the glyphs would be a total no-op.
    if (!cand && !this.dimPlan && this.textEntityAt(p)) {
      toast(unsupportedMessage("text"));
      return;
    }
    const fresh = cand != null && !this.dimPicks.some((t) => targetKey(t) === targetKey(cand));
    if (cand && fresh && this.dimPicks.length < 2) this.dimPick(cand, ev);
    else this.dimPlaceClick(p, ev);
  }

  private dimPick(t: DimTarget, ev: PointerEvent) {
    const prev = this.dimPicks.slice();
    // Fusion's tangent arm: consumed by the first circle/arc that can use it,
    // and only by that one — a line/point pick leaves it armed for the next.
    const pick: DimTarget = this.dimTangentArmed && isRoundTarget(t) && t.kind !== "edge"
      ? { ...t, rim: true }
      : t;
    if (pick !== t) this.dimTangentArmed = false;
    this.dimPicks.push(pick);
    const r = resolveDim(this.dimPicks, this.dimOptions());
    if (isDimError(r)) {
      if (r.message) toast(r.message); // toast on CLICK only, never from hover
      // a dead combination (concentric, coincident, same operand) drops the new
      // pick and keeps whatever already resolved — never a silent dead end
      if (!r.keepPicks) this.dimPicks = prev;
      this.refreshDimPlan();
    } else {
      this.dimPlan = r;
      setPrompt(r.hint);
    }
    this.dimPlace = null; // a new pick invalidates any earlier placement
    this.syncDimBox(ev);
  }

  /** Freeze the label position (`place`) at the cursor. Does NOT commit —
   *  Enter / ✓ in the value box does, so nothing reaches setDrivingDimension
   *  without passing through the box. */
  private dimPlaceClick(p: THREE.Vector2, ev: PointerEvent) {
    if (!this.dimPlan) {
      // Nothing resolved yet: a lone armed operand plus a click that hit
      // nothing (a missed second pick, which is exactly what happens on a long
      // two-point distance). Keep the pick — Escape is the way to clear it —
      // and re-state what the tool is waiting for.
      if (this.dimPicks.length) {
        const r = resolveDim(this.dimPicks, this.dimOptions());
        if (isDimError(r) && r.message) toast(r.message);
      }
      return;
    }
    const anchor = this.dimPlan.labelAnchor();
    this.dimPlace = anchor
      ? clampPlace(p.x - anchor.x, p.y - anchor.y, this.viewport.pixelWorldSize(this.plane.origin))
      : null; // distance/diameter render through entityDims — no place slot
    this.dimPlaced = true; // NOT `dimPlace != null` — that is null for those two
    this.positionDimBox(ev);
    this.dim.setClickThrough(false); // ✓ / ✕ / the field are live from here on
    this.dim.focus(); // the canvas click blurred the input
  }

  /** Open / refresh the value box for the current plan. DimInput.show() starts
   *  with hide(), which throws away anything typed — so re-show ONLY when the
   *  dimension's identity actually changes, and say so when that discards input
   *  the user had already entered. */
  private syncDimBox(ev?: PointerEvent) {
    const plan = this.dimPlan;
    if (!plan) {
      this.dim.hide();
      this.dimFieldKey = "";
      this.dimPlanKey = "";
      return;
    }
    const key = this.dimIdentity(plan);
    if (key !== this.dimPlanKey) {
      const prevField = this.dimFieldKey.split(":")[0] ?? "";
      const discarded = prevField !== "" && this.dim.isUserDriven(prevField);
      this.dimFieldKey = plan.fieldKey;
      this.dimPlanKey = key;
      this.dim.show(plan.fields, () => this.commitDim(), () => this.cancelDim());
      if (discarded) toast("This is a different dimension now — retype the value");
    }
    this.dim.updateFromCursor({ [plan.field]: plan.measure() });
    this.positionDimBox(ev);
    // Until the label is placed the box must not intercept the click that
    // places it — that click landed on ✓ and committed the measured value.
    this.dim.setClickThrough(!this.dimPlaced);
    this.dim.focus();
  }

  /** Enter / ✓ : evaluate what was typed, build the constraint and hand it to
   *  the shared placement path (which stamps driven from the Reference toggle or
   *  the plan), then re-arm. The raw text goes through the SAME evaluator as a
   *  dimension label's inline editor, so `w/2` and `name=expr` work here too and
   *  a bad value is refused out loud instead of being replaced by the
   *  measurement. Only a genuinely EMPTY box means "accept the measurement". */
  private commitDim() {
    const plan = this.dimPlan;
    if (!plan) { this.cancelDim(); return; }
    const kind: FieldKind = plan.kind === "angle" ? "angle" : "length";
    const raw = this.dim.getRaw(plan.field).trim();
    let value = plan.measure();
    let typed: { value: number; expr: string | null; name?: string } | null = null;
    if (raw !== "") {
      const r = this.evalDimInput(raw, kind, null);
      if ("error" in r) {
        toast(`Dimension not created — ${r.error}`);
        this.dim.focus(); // leave the box open on the bad value
        return;
      }
      value = r.value;
      typed = r;
    }
    const c = this.dimPlace ? plan.make(value, this.dimPlace) : plan.make(value);
    const forceDriven = plan.forceDriven === true;
    const firstPicked = this.dimPicks[0]?.e.id ?? null;
    this.dim.hide();
    const pair = plan.parallelPair;
    const conc = plan.implyConcentric;
    this.resetDimPicks();
    this.overlay.setPreview([]);
    // the parallelism a "distance between two parallel lines" implies — added
    // BEFORE the dim so one solve covers both, and only for a DRIVING dim (a
    // reference dim must not move geometry)
    if (pair && !this.referenceMode && !forceDriven) this.addParallelPair(pair.l1, pair.l2);
    // likewise the concentricity a radial-gap (wall-thickness) dim implies:
    // `difference` ties only the two radii, so without it the typed number stops
    // being the radial gap the moment either centre moves (see types.ts)
    if (conc && !this.referenceMode && !forceDriven) this.addConcentricPair(conc.c1, conc.c2);
    if (!this.referenceMode && !forceDriven) this.seedFirstPicked(c, firstPicked);
    const placed = this.placeDim(c, forceDriven);
    // bind exactly as the label editor does: a formula binds, and a plain number
    // over a dim that WAS bound (the id carries over on replace) rewrites that
    // binding to the literal instead of leaving a stale expression behind
    if (typed && isDimConstraint(placed) && placed.id) this.recordBinding(`c:${placed.id}`, typed, kind);
    this.onState?.();
  }

  /** Hold two line operands parallel, unless something already does. Skipped
   *  when redundant, because a redundant constraint shows as an amber
   *  over-constrained chip: both explicitly horizontal (or both vertical),
   *  a rectangle edge whose orientation the rectangle itself fixes, or an
   *  existing parallel/collinear between the pair. */
  private addParallelPair(l1: string, l2: string) {
    const orient = (id: string): "h" | "v" | null => {
      const t = id.indexOf("~");
      if (t >= 0) { // rect edge: bottom/top are horizontal, right/left vertical
        const k = Number(id.slice(t + 1));
        return k === 0 || k === 2 ? "h" : k === 1 || k === 3 ? "v" : null;
      }
      for (const c of this.constraints) {
        if (c.type === "horizontal" && c.line === id) return "h";
        if (c.type === "vertical" && c.line === id) return "v";
      }
      return null;
    };
    const o1 = orient(l1);
    if (o1 !== null && o1 === orient(l2)) return;
    const already = this.constraints.some(
      (c) => (c.type === "parallel" || c.type === "collinear") &&
        ((c.l1 === l1 && c.l2 === l2) || (c.l1 === l2 && c.l2 === l1)),
    );
    if (!already) this.constraints.push({ type: "parallel", l1, l2 });
  }

  /** Hold two rounds concentric, unless something already does. Skipped when
   *  redundant (an existing concentric on the same pair) so a radial-gap dim
   *  can't turn its own implied constraint into an amber over-constrained chip. */
  private addConcentricPair(c1: string, c2: string) {
    const already = this.constraints.some(
      (c) => c.type === "concentric" && ((c.c1 === c1 && c.c2 === c2) || (c.c1 === c2 && c.c2 === c1)),
    );
    if (!already) this.constraints.push({ type: "concentric", c1, c2 });
  }

  /** Esc / ✕ : abandon the in-progress dimension, staying armed on the tool. */
  private cancelDim() {
    this.dim.hide();
    this.resetDimPicks();
    this.overlay.setPreview([]);
    this.viewport.requestRender();
  }

  /** Park the value box near the dimension's own anchor (which doesn't move
   *  while you place), clamped inside the viewport — extrudeTool's rule: a
   *  cursor-glued box is unclickable. It sits on the side of the anchor AWAY
   *  from the cursor, because the quadrant the cursor is in is where the
   *  placement click is about to land, and a box under that click swallows it
   *  (the canvas never sees the pointerdown, so no placement is recorded). */
  /** Park the value box once per dimension and then LEAVE IT THERE.
   *
   *  It used to be repositioned on every pointer move, to the side of the anchor
   *  away from the cursor, so it could never swallow the click-to-place. That
   *  made the box flee an approaching pointer and rendered ✓ unclickable. The
   *  box is click-through until the dimension is placed (see
   *  DimInput.setClickThrough), so it no longer needs to dodge anything —
   *  a stationary box is worth far more than a clever one. */
  private positionDimBox(ev?: PointerEvent) {
    if (this.dimBoxAt) return; // already parked for this dimension
    const plan = this.dimPlan;
    const at = plan ? this.dimBoxAnchor(plan) : null;
    const s = at
      ? this.viewport.projectToScreen(this.plane.to3D(at.x, at.y))
      : ev
        ? { x: ev.clientX, y: ev.clientY }
        : null;
    if (!s) return;
    const rect = this.viewport.domElement.getBoundingClientRect();
    const boxW = 170, boxH = 46, m = 12, gap = 28;
    const cx = ev?.clientX ?? s.x + 1, cy = ev?.clientY ?? s.y + 1;
    const left = cx >= s.x ? s.x - gap - boxW : s.x + gap;
    const top = cy >= s.y ? s.y - gap - boxH : s.y + gap;
    const fx = Math.max(rect.left + m, Math.min(left, rect.right - boxW - m));
    const fy = Math.max(rect.top + m, Math.min(top, rect.bottom - boxH - m));
    this.dimBoxAt = { x: fx, y: fy };
    this.dim.position(fx - 16, fy - 16); // dim.position adds a +16 cursor offset
  }

  /** the plane point a plan's label hangs off: its own anchor, else the middle
   *  of its dimension line */
  private dimBoxAnchor(plan: DimPlan): THREE.Vector2 | null {
    const own = plan.labelAnchor();
    if (own) return own;
    const an = plan.anchors();
    return an ? an.a.clone().add(an.b).multiplyScalar(0.5) : null;
  }

  /** Dimension-tool hover: highlight what a click would pick (lit = picked,
   *  empty space = places), draw the live annotation, and track the value. */
  private dimensionHover(e: PointerEvent) {
    const p = this.planePoint(e);
    if (!p) return;
    this.lastCursor.copy(p);
    const preview: THREE.Object3D[] = [];
    for (const t of this.dimPicks) preview.push(...this.dimTargetObjects(t, 0x33aaff));
    const cand = this.dimPicks.length < 2 ? pickDimTarget(this.entities, p, this.pickTol()) : null;
    if (cand && !this.dimPicks.some((t) => targetKey(t) === targetKey(cand))) {
      preview.push(...this.dimTargetObjects(cand, 0xff5555));
    }
    const plan = this.dimPlan;
    if (plan) {
      const segs = this.dimPreviewSegs(plan, p);
      if (segs.length) preview.push(...dimensionLineObjects([], this.plane, segs, PREVIEW_COLOR));
      this.dim.updateFromCursor({ [plan.field]: plan.measure() });
      this.positionDimBox(e);
    }
    this.overlay.setPreview(preview);
  }

  /** highlight geometry for one pick candidate (a synthetic line for a rect
   *  edge, a small cross for a reference point) */
  private dimTargetObjects(t: DimTarget, color: number): THREE.Object3D[] {
    if (t.kind === "entity") return curveObjects([t.e], this.plane, color, true);
    if (t.kind === "edge") {
      return curveObjects(
        [{ type: "line", id: "__dimedge__", x1: t.a.x, y1: t.a.y, x2: t.b.x, y2: t.b.y }],
        this.plane, color, true,
      );
    }
    const r = this.pickTol() * 0.6;
    return curveObjects(
      [
        { type: "line", id: "__dimptA__", x1: t.pos.x - r, y1: t.pos.y - r, x2: t.pos.x + r, y2: t.pos.y + r },
        { type: "line", id: "__dimptB__", x1: t.pos.x - r, y1: t.pos.y + r, x2: t.pos.x + r, y2: t.pos.y - r },
      ],
      this.plane, color, true,
    );
  }

  /** the annotation segments (extension lines + dimension line + arrowheads)
   *  for the resolved plan, offset by the frozen placement or the live cursor */
  private dimPreviewSegs(plan: DimPlan, cursor: THREE.Vector2): [THREE.Vector2, THREE.Vector2][] {
    const an = plan.anchors();
    if (!an) return []; // angle dims render as a bare value (see entityDims)
    const anchor = this.dimBoxAnchor(plan);
    // A plan with no labelAnchor (line length, circle diameter) can't PERSIST a
    // placement — those render through entityDims, which has no constraint
    // access (see types.ts). Previewing at the cursor would promise a position
    // the commit throws away, so preview them exactly where they will land.
    const holdsPlace = plan.labelAnchor() !== null;
    const off = !holdsPlace
      ? null
      : this.dimPlace
        ? new THREE.Vector2(this.dimPlace.ox, this.dimPlace.oy)
        : anchor ? cursor.clone().sub(anchor) : new THREE.Vector2();
    if (plan.kind === "radius") {
      const d = off && off.lengthSq() > 1e-12 ? off.clone().normalize() : new THREE.Vector2(Math.SQRT1_2, Math.SQRT1_2);
      return [[an.a.clone(), an.a.clone().addScaledVector(d, plan.measure())]];
    }
    if (plan.kind === "diameter") return [[an.a.clone(), an.b.clone()]];
    const dir = an.b.clone().sub(an.a);
    if (dir.lengthSq() < 1e-12) return [];
    dir.normalize();
    const nrm = new THREE.Vector2(-dir.y, dir.x);
    return linearDim(an.a, an.b, nrm, plan.measure(), off ? off.x * nrm.x + off.y * nrm.y : undefined).lines;
  }

  private onPointerMove(e: PointerEvent) {
    // right-DRAG is camera pan (viewport TRUCK), not a menu gesture — the same
    // 5 px rule the viewport's own context-click guard uses
    if (this.rightDownAt && !this.rightDragged &&
      Math.hypot(e.clientX - this.rightDownAt.x, e.clientY - this.rightDownAt.y) > 5) {
      this.rightDragged = true;
    }
    if (this.active && this.tool === "project") {
      this.projectHover(e);
      return;
    }
    if (this.active && this.tool === "dimension") {
      this.dimensionHover(e);
      return;
    }
    if (this.active && MODIFY_TOOLS.has(this.tool)) {
      this.modifyHover(e);
      return;
    }
    if (!this.active || this.tool === "select") {
      if (this.dragFrom) {
        if (!this.dragMoved) {
          const dx = e.clientX - this.dragStartClient.x, dy = e.clientY - this.dragStartClient.y;
          if (dx * dx + dy * dy < 16) return; // <4px: still a click — don't solve yet
          this.dragMoved = true;
        }
        const w = this.planePoint(e); // raw cursor; snapping off for smooth drag
        if (w) this.queueDrag(w);
        return;
      }
      if (this.moveDrag) {
        const raw = this.planePoint(e);
        if (!raw) return;
        const md = this.moveDrag;
        if (!md.started) {
          const dx = e.clientX - md.startClient.x, dy = e.clientY - md.startClient.y;
          if (dx * dx + dy * dy < 16) return; // <4px: still a click, not a move
          // projected geometry never body-drags (fixed reference); disarm so a
          // plain click still selects it in endDrag()
          if (this.guardProjected(this.entities[md.idx])) {
            this.moveDrag = null;
            return;
          }
          md.started = true;
          // nothing has moved yet, so build the revert snapshot and the
          // neighbor-stretch set from the still-pristine positions
          this.dragSnapshot = JSON.parse(JSON.stringify(this.entities));
          const ent = this.entities[md.idx];
          if (ent) md.stretch = this.stretchTargets(md.idx, this.attachmentPoints(ent));
        }
        const dx = raw.x - md.last.x, dy = raw.y - md.last.y;
        md.last.copy(raw);
        const ent = this.entities[md.idx];
        if (ent) this.entities[md.idx] = translated(ent, dx, dy, ent.id);
        for (const s of md.stretch) s(dx, dy);
        this.refreshDragGeometry(); // curves only; dims/regions/candidates rebuilt on endDrag
        return;
      }
      const hit = this.snapAt(e.clientX, e.clientY);
      this.showSnap(hit);
      if (this.tool === "select") {
        const raw = this.planePoint(e); // hover-highlight a profile area
        this.overlay.setHoverRegion(raw ? this.overlay.activeRegionAt(raw) : null);
      }
      return;
    }
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);
    if (!hit) return;
    this.lastCursor.copy(hit.p);
    this.showSnap(hit);

    if (this.tool === "arc") {
      this.arcPreview(hit.p);
      return;
    }
    if (this.tool === "spline") {
      this.splinePreview(hit.p);
      return;
    }
    if (this.tool === "polygon" || this.tool === "slot" || this.tool === "circle2" ||
        this.tool === "circle3" || this.tool === "centerRectangle") {
      this.multiClickPreview(hit.p, e);
      return;
    }
    if (PATTERN_TOOLS.has(this.tool)) {
      this.patternMove(hit.p, e);
      return;
    }

    if (this.textBoxStart) {
      this.textBoxEnd = hit.p.clone();
      const s = this.textBoxStart, w = Math.abs(hit.p.x - s.x), h = Math.abs(hit.p.y - s.y);
      if (w > 0.5 && h > 0.5) {
        this.overlay.setPreview(curveObjects(
          [{ type: "rectangle", id: "__textbox__", width: w, height: h, x: (s.x + hit.p.x) / 2, y: (s.y + hit.p.y) / 2, construction: true }],
          this.plane, PREVIEW_COLOR,
        ));
      }
      return;
    }

    if (this.base) {
      const geom = this.computeGeometry(this.base, hit.p);
      this.dim.updateFromCursor(geom.dims);
      this.dim.position(e.clientX, e.clientY);
      this.overlay.setPreview([geom.preview]); // only the rubber-band redraws
    } else {
      this.overlay.setPreview([]);
    }
  }

  private onKey(e: KeyboardEvent) {
    // The dim box auto-focuses while drawing, so nearly every in-sketch Esc
    // arrives with an editable target — it must still cancel (same carve-out
    // extrudeTool.onKey has). Only Esc aimed at OUR dim box passes; any other
    // editor (dimension-label inline edit, rename fields) keeps handling its
    // own keys, and all non-Escape keys still never fire shortcuts while typing.
    const escInOwnDim = e.key === "Escape" && this.dim.isActive && this.dim.ownsTarget(e.target);
    if (!escInOwnDim && isEditableTarget(e.target)) return; // typing in a dim/text field, not a shortcut
    // a pattern being placed/edited: Delete removes it, Esc keeps it as-is
    if (this.patternFlow.hasPending()) {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.patternFlow.deletePending();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.patternFlow.cancelPending();
        return;
      }
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.tool === "select" && this.selected.size) {
        e.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.dragFrom || this.moveDrag) {
        // cancel an in-progress drag: revert geometry to its pre-drag positions
        if (this.dragSnapshot) this.entities = this.dragSnapshot;
        this.dragSnapshot = null;
        this.dragFrom = null;
        this.moveDrag = null;
        this.pendingDrag = null;
        this.conflict = false;
        this.refreshActive();
        this.onState?.();
        return;
      }
      if (this.base || this.arcStart || this.filletFirst != null || this.splinePts.length ||
          this.clickPts.length || this.dimPicks.length || this.dimPlan || this.constraintTools.hasPending()) {
        this.base = null;
        this.chainStart = null;
        this.arcStart = null;
        this.arcEnd = null;
        this.filletFirst = null;
        this.splinePts = [];
        this.clickPts = [];
        // in-progress dimension: picks AND an open value box both die here (the
        // old code listed only the first-point slot, which is why Escape could
        // leave a dim box stranded on screen). The tool stays armed.
        this.resetDimPicks();
        this.constraintTools.resetPending();
        this.dim.hide();
        this.overlay.setPreview([]);
      } else if (this.selected.size) {
        this.selected.clear();
        this.refreshActive();
      } else {
        this.setTool("select");
      }
      return;
    }
    if (e.key === "Enter") {
      if (this.patternFlow.hasPending()) {
        e.preventDefault();
        this.commitPattern();
        return;
      }
      if (this.tool === "spline" && this.splinePts.length) {
        e.preventDefault();
        this.finishSpline();
        return;
      }
      if (this.base) {
        e.preventDefault();
        this.commitFromCursor(this.lastCursor);
        return;
      }
    }
    // tool shortcuts inside the sketch
    const k = e.key.toLowerCase();
    // Q/E deliberately NOT handled here: they fall through to the global keymap
    // (q=Press/Pull, e=Extrude), which finishes the sketch and starts the tool —
    // the sketch view now opens straightened to the nearest rotation, so the old
    // Q/E view-roll is no longer needed.
    if (k === "l") this.setTool("line");
    else if (k === "r") this.setTool("rectangle");
    else if (k === "c") this.setTool("circle");
    else if (k === "a") this.setTool("arc");
    else if (k === "t") this.setTool("trim");
    else if (k === "o") this.setTool("offset");
    else if (k === "p") this.setTool("project");
  }

  // --- geometry per tool -------------------------------------------------
  private computeGeometry(a: THREE.Vector2, cursor: THREE.Vector2) {
    if (this.tool === "rectangle") {
      let w = Math.abs(cursor.x - a.x);
      let h = Math.abs(cursor.y - a.y);
      const sx = Math.sign(cursor.x - a.x) || 1;
      const sy = Math.sign(cursor.y - a.y) || 1;
      if (this.dim.isUserDriven("width")) w = this.dim.getValue("width") ?? w;
      if (this.dim.isUserDriven("height")) h = this.dim.getValue("height") ?? h;
      const cx = a.x + (sx * w) / 2;
      const cy = a.y + (sy * h) / 2;
      const ent: ResolvedEntity = { type: "rectangle", id: "", width: w, height: h, x: cx, y: cy };
      const dims: Record<string, number> = { width: w, height: h };
      return { dims, preview: this.entityCurve(ent), entity: ent };
    }
    if (this.tool === "circle") {
      let dia = 2 * a.distanceTo(cursor);
      if (this.dim.isUserDriven("diameter")) dia = this.dim.getValue("diameter") ?? dia;
      const ent: ResolvedEntity = { type: "circle", id: "", radius: dia / 2, x: a.x, y: a.y };
      const dims: Record<string, number> = { diameter: dia };
      return { dims, preview: this.entityCurve(ent), entity: ent };
    }
    // line
    let len = a.distanceTo(cursor);
    let ang = (Math.atan2(cursor.y - a.y, cursor.x - a.x) * 180) / Math.PI;
    if (this.dim.isUserDriven("length")) len = this.dim.getValue("length") ?? len;
    if (this.dim.isUserDriven("angle")) ang = this.dim.getValue("angle") ?? ang;
    const ar = (ang * Math.PI) / 180;
    const end = new THREE.Vector2(a.x + Math.cos(ar) * len, a.y + Math.sin(ar) * len);
    const ent: ResolvedEntity = { type: "line", id: "", x1: a.x, y1: a.y, x2: end.x, y2: end.y };
    const dims: Record<string, number> = { length: len, angle: ang };
    return { dims, preview: this.entityCurve(ent), entity: ent };
  }

  private commitFromCursor(cursor: THREE.Vector2) {
    if (!this.base) return;
    const { entity } = this.computeGeometry(this.base, cursor);
    if (this.constructionMode) entity.construction = true;
    entity.id = newEntityId(); // stamp a stable id (computeGeometry left it "")
    this.entities.push(entity);
    if (this.tool === "line" && entity.type === "line") {
      const end = new THREE.Vector2(entity.x2, entity.y2);
      // clicked back on the start point → close the loop and end the chain
      const closing = this.chainStart != null && end.distanceTo(this.chainStart) < 1e-3;
      // auto-infer horizontal/vertical (skip the closing seg + typed angles)
      if (!closing && !this.dim.isUserDriven("angle")) this.inferLineConstraint(entity);
      if (closing) {
        this.base = null;
        this.chainStart = null;
        this.dim.hide();
      } else {
        this.base = new THREE.Vector2(entity.x2, entity.y2); // snapped endpoint
        this.showDimFields();
      }
    } else {
      this.base = null;
      this.dim.hide();
    }
    this.refreshActive(); // entity list changed: rebuild active curves + snaps
    this.overlay.setPreview([]);
    this.requestSolve(); // re-solve if any constraints exist (updates DOF colour)
    this.onState?.();
  }

  /** If a freshly drawn line sits within a few degrees of horizontal/vertical,
   *  snap it exactly and record the constraint (mainstream MCAD's auto-constrain). */
  private inferLineConstraint(e: ResolvedEntity) {
    if (e.type !== "line") return;
    const ang = (Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180) / Math.PI;
    const norm = ((ang % 180) + 180) % 180; // 0..180
    const TOL = 3;
    if (Math.min(norm, 180 - norm) <= TOL) {
      e.y2 = e.y1; // exactly horizontal
      this.constraints.push({ type: "horizontal", line: e.id });
    } else if (Math.abs(norm - 90) <= TOL) {
      e.x2 = e.x1; // exactly vertical
      this.constraints.push({ type: "vertical", line: e.id });
    }
  }

  private showDimFields() {
    const defs =
      this.tool === "rectangle"
        ? [{ name: "width", label: "W" }, { name: "height", label: "H" }]
        : this.tool === "circle"
          ? [{ name: "diameter", label: "⌀" }]
          : [
              { name: "length", label: "L" },
              { name: "angle", label: "∠", kind: "angle" as const },
            ];
    this.dim.show(defs, () => this.commitFromCursor(this.lastCursor));
  }

  // --- snapping + rendering ---------------------------------------------
  private snapAt(clientX: number, clientY: number, noSnap = false) {
    const world = this.viewport.screenToPlane(clientX, clientY, this.plane.plane);
    if (!world) return null;
    const p2d = this.plane.to2D(world);
    // Hold Ctrl to suppress snapping for fine placement (raw cursor position).
    if (noSnap) return { p: p2d, kind: "free" as SnapKind, world };
    const res = snap(
      p2d,
      this.candidates, // cached; rebuilt only when entities change
      (q) => this.viewport.projectToScreen(this.plane.to3D(q.x, q.y)),
      this.gridSnap ? GRID_STEP : 0,
    );
    return { p: res.point, kind: res.kind, world: this.plane.to3D(res.point.x, res.point.y) };
  }

  private showSnap(hit: { kind: SnapKind; world: THREE.Vector3 } | null) {
    if (!hit || hit.kind === "free") {
      this.overlay.setSnap(null);
      return;
    }
    this.overlay.setSnap(hit.world, hit.kind, this.viewport.camera);
    this.overlay.setSnapScale(this.viewport.pixelWorldSize(hit.world) * 6);
  }

  /** MCAD-style state color: over-constrained/conflict = red, fully
   * constrained (dof 0) = white ("fully defined"), under-constrained = blue.
   * dof < 0 means no solve has run yet (treat as under-constrained). */
  private activeColor(): number {
    return this.conflict ? 0xff4444 : this.lastDof === 0 ? 0xffffff : CURVE_COLOR;
  }

  /** All pattern definitions including the one being placed (for live preview). */
  private allPatterns(): SketchPattern[] {
    const pending = this.patternFlow.pending;
    return pending ? [...this.patterns, pending] : this.patterns;
  }

  /** Derived (copy) entities from every pattern — render/region only, never edited
   *  or snapped individually. Mirrors the build/persist expansion. */
  private derivedEntities(): ResolvedEntity[] {
    const pats = this.allPatterns();
    if (!pats.length) return [];
    const params = this.store?.document.parameters ?? {};
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    const out: ResolvedEntity[] = [];
    for (const pat of pats) out.push(...expandPattern(pat, byId, params));
    return out;
  }

  private activeCurves(derived: ResolvedEntity[]): THREE.Object3D[] {
    const objs: THREE.Object3D[] = [];
    if (this.selected.size) {
      const normal = this.entities.filter((e) => !this.selected.has(e.id));
      const chosen = this.entities.filter((e) => this.selected.has(e.id));
      if (normal.length) objs.push(...curveObjects(normal, this.plane, this.activeColor()));
      if (chosen.length) objs.push(...curveObjects(chosen, this.plane, SELECT_COLOR, true));
    } else {
      objs.push(...curveObjects(this.entities, this.plane, this.activeColor()));
    }
    if (this.dimsVisible) {
      this.cdims = constraintDims(this.entities, this.constraints);
      objs.push(...dimensionLineObjects(this.entities, this.plane, this.cdims.flatMap((d) => d.lines)));
    } else {
      this.cdims = [];
    }
    if (derived.length) objs.push(...curveObjects(derived, this.plane, this.activeColor()));
    return objs;
  }

  private entityCurve(e: ResolvedEntity): THREE.Object3D {
    // curveObjects yields exactly one object per input entity, so [0] is present
    const obj = curveObjects([e], this.plane, PREVIEW_COLOR)[0];
    if (!obj) throw new Error("entityCurve: curveObjects returned no object");
    return obj;
  }

  // --- modify tools: trim + fillet -------------------------------------
  private pickTol(): number {
    return this.viewport.pixelWorldSize(this.plane.origin) * 9;
  }
  /** raw (unsnapped) cursor point on the sketch plane */
  private planePoint(e: MouseEvent): THREE.Vector2 | null {
    return this.planePointAt(e.clientX, e.clientY);
  }
  /** raw (unsnapped) screen point → sketch-plane 2D (mm). THE screen→plane
   *  conversion: it goes through the plane itself, so it is correct on a
   *  datum/XZ/YZ plane whose axes need not line up with the screen's — callers
   *  outside the pointer handlers (e.g. the dimension labels' drag) use it
   *  rather than scaling screen pixels by a mm-per-pixel factor. */
  private planePointAt(clientX: number, clientY: number): THREE.Vector2 | null {
    const w = this.viewport.screenToPlane(clientX, clientY, this.plane.plane);
    return w ? this.plane.to2D(w) : null;
  }
  /** hover-highlight the entity under the cursor in red */
  private modifyHover(e: PointerEvent) {
    const p = this.planePoint(e);
    if (!p) return;
    const idx = pickEntity(this.entities, p, this.pickTol());
    const preview: THREE.Object3D[] = [];
    const first = this.filletFirst != null ? this.entities[this.filletFirst] : undefined;
    if (first) preview.push(...curveObjects([first], this.plane, 0x33aaff, true));
    const hit = idx >= 0 ? this.entities[idx] : undefined;
    if (hit) preview.push(...curveObjects([hit], this.plane, 0xff5555, true));
    this.overlay.setPreview(preview);
  }

  // --- selection delete (select tool) -----------------------------------
  /** Remove the selected entities, prune now-dangling constraints, then rebuild
   *  + re-solve via the shared modify tail. */
  private deleteSelected() {
    if (!this.selected.size) return;
    this.entities = this.entities.filter((en) => !this.selected.has(en.id));
    this.selected.clear();
    dismissContextMenu(); // the Delete key can fire while the right-click menu is open
    this.afterModify();
  }

  /** Right-click in select mode: select the entity under the cursor (if any) and
   *  offer Delete. Leaves camera navigation alone when nothing is hit/selected. */
  private onContextMenu(e: MouseEvent) {
    if (!this.active) return;
    // a right-DRAG panned the camera — don't turn its release into a menu
    const dragged = this.rightDragged;
    this.rightDownAt = null;
    this.rightDragged = false;
    if (dragged) return;
    if (this.tool === "dimension") { this.openDimensionMenu(e); return; }
    if (this.tool !== "select") return;
    const raw = this.planePoint(e);
    const idx = raw ? pickEntity(this.entities, raw, this.pickTol()) : -1;
    const hit = idx >= 0 ? this.entities[idx] : undefined;
    if (hit) {
      const id = hit.id;
      if (!this.selected.has(id)) { this.selected = new Set([id]); this.refreshActive(); }
    }
    if (!this.selected.size) return; // nothing to act on → let nav handle it
    e.preventDefault();
    const n = this.selected.size;
    const linked = this.selectedProjectedIds().size;
    const items: CtxItem[] = [
      ...(linked
        ? [{ label: linked > 1 ? `Break Link (${linked})` : "Break Link", onClick: () => this.breakSelectedLinks() }]
        : []),
      { label: n > 1 ? `Delete ${n} entities` : "Delete", danger: true, onClick: () => this.deleteSelected() },
    ];
    contextMenu(e.clientX, e.clientY, items);
  }

  /** Fusion's in-command marking menu for the Dimension tool: the overrides the
   *  picks alone can't express. "Pick Circle/Arc Tangent" is armed BEFORE the
   *  pick it applies to and is consumed by it (never sticky), which is the only
   *  way to say "measure to the EDGE of this circle, not its centre". */
  private openDimensionMenu(e: MouseEvent) {
    e.preventDefault();
    const check = (on: boolean, label: string) => `${on ? "✓ " : "    "}${label}`;
    const plan = this.dimPlan;
    // radius/diameter only means something while a lone round is picked
    const lone = this.dimPicks.length === 1 && this.dimPicks[0] !== undefined && isRoundTarget(this.dimPicks[0]);
    const isDia = plan?.kind === "diameter";
    const items: CtxItem[] = [
      {
        label: check(this.dimTangentArmed, "Pick Circle/Arc Tangent"),
        onClick: () => {
          this.dimTangentArmed = !this.dimTangentArmed;
          setPrompt(this.dimTangentArmed
            ? "Tangent pick armed — click a circle or arc to measure to its EDGE"
            : "Tangent pick cleared");
        },
      },
      { separator: true, label: "" },
      {
        label: check(lone && !isDia, "Radius"), disabled: !lone,
        onClick: () => this.setDimRoundPref("radius"),
      },
      {
        label: check(lone && isDia, "Diameter"), disabled: !lone,
        onClick: () => this.setDimRoundPref("diameter"),
      },
      { separator: true, label: "" },
      {
        label: check(this.referenceMode, "Driven (reference)"),
        onClick: () => { this.setReferenceDim(!this.referenceMode); this.onState?.(); },
      },
      { separator: true, label: "" },
      { label: "OK", disabled: !plan, onClick: () => { if (this.dimPlan) this.commitDim(); } },
      { label: "Cancel", onClick: () => this.cancelDim() },
    ];
    contextMenu(e.clientX, e.clientY, items);
  }

  private setDimRoundPref(pref: "radius" | "diameter") {
    this.dimRoundPref = pref;
    this.refreshDimPlan();
    if (this.dimPlan) setPrompt(this.dimPlan.hint);
  }

  /** Break Link (context menu): the selected projected entities become native
   *  geometry with the SAME ids — attached constraints/dims stay valid, the
   *  geometry unfreezes, and the associative refresh skips them from now on
   *  (they are no longer type "projected"). Breaking one member of a
   *  multi-curve group (a face boundary's siblings) breaks only that member —
   *  the others stay linked (Fusion behavior). */
  private breakSelectedLinks() {
    const ids = this.selectedProjectedIds();
    if (!ids.size) return;
    this.entities = breakLink(this.entities, ids);
    this.afterModify(); // selection stays: the entities still exist, now native
  }
  private trimClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    this.entities = trimEntity(this.entities, idx, p);
    this.afterModify();
  }
  private filletClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (this.guardProjected(idx >= 0 ? this.entities[idx] : undefined)) return;
    if (idx < 0 || this.entities[idx]?.type !== "line") return;
    if (this.filletFirst == null) {
      this.filletFirst = idx;
      return;
    }
    if (idx === this.filletFirst) return;
    const second = idx;
    const first = this.filletFirst;
    this.dim.show([{ name: "radius", label: "R", kind: "length" }], () =>
      this.applyFillet(first, second),
    );
  }
  private applyFillet(iA: number, iB: number) {
    const r = this.dim.getValue("radius") ?? 2;
    const res = filletCorner(this.entities, iA, iB, r);
    if (res) this.entities = res;
    this.filletFirst = null;
    this.dim.hide();
    this.afterModify();
  }
  private chamferClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (this.guardProjected(idx >= 0 ? this.entities[idx] : undefined)) return;
    if (idx < 0 || this.entities[idx]?.type !== "line") return;
    if (this.filletFirst == null) {
      this.filletFirst = idx;
      return;
    }
    if (idx === this.filletFirst) return;
    const second = idx;
    const first = this.filletFirst;
    this.dim.show([{ name: "distance", label: "D", kind: "length" }], () =>
      this.applyChamfer(first, second),
    );
  }
  private applyChamfer(iA: number, iB: number) {
    const d = this.dim.getValue("distance") ?? 2;
    const res = chamferCorner(this.entities, iA, iB, d);
    if (res) this.entities = res;
    this.filletFirst = null;
    this.dim.hide();
    this.afterModify();
  }

  /** Projected geometry is FIXED reference geometry: every modify/transform seam
   *  calls this and bails with one consistent toast. Delete stays allowed. */
  private guardProjected(e: ResolvedEntity | undefined): boolean {
    if (e?.type !== "projected") return false;
    toast(PROJECTED_FIXED_MSG);
    return true;
  }

  /** ids of the currently-selected projected (linked reference) entities. */
  private selectedProjectedIds(): Set<string> {
    return new Set(
      this.entities.filter((e) => e.type === "projected" && this.selected.has(e.id)).map((e) => e.id),
    );
  }

  /** The selected projected (linked reference) ids, toasting PROJECTED_FIXED_MSG
   *  once when any exist — the shared seam for tools that transform the
   *  selection. Each caller keeps its own retention semantics (deselect /
   *  keep-selected / skip from copies). */
  private warnSelectedProjected(): Set<string> {
    const ids = this.selectedProjectedIds();
    if (ids.size) toast(PROJECTED_FIXED_MSG);
    return ids;
  }

  /** replace each selected entity with map(e) (flattened); others unchanged. Owns
   *  the selection: it re-selects the transform's output, so a rotate that explodes
   *  a rectangle into fresh-id lines leaves those lines selected (not a stale id). */
  private transformSelection(map: (e: ResolvedEntity) => ResolvedEntity[]) {
    const next: ResolvedEntity[] = [];
    const sel = new Set<string>();
    // fixed reference geometry: keep it (and its selection) untouched
    const projected = this.warnSelectedProjected();
    for (const e of this.entities) {
      if (this.selected.has(e.id) && !projected.has(e.id)) {
        for (const m of map(e)) { next.push(m); sel.add(m.id); }
      } else {
        next.push(e);
        if (projected.has(e.id)) sel.add(e.id);
      }
    }
    this.entities = next;
    this.selected = sel;
    this.afterModify();
  }

  /** keep the id for a single-entity result; give an exploded result (a rotated
   *  rectangle → 4 lines) fresh ids so nothing collides. */
  private reid(rot: ResolvedEntity[]): ResolvedEntity[] {
    return rot.length === 1 ? rot : rot.map((r) => ({ ...r, id: newEntityId() }));
  }

  /** Move/Copy: click a base point, then a destination — translate the whole
   *  selection. Move mutates in place; Copy leaves the originals and selects the copies. */
  private moveClick(p: THREE.Vector2) {
    if (!this.selected.size) { toast("Select entities first, then Move/Copy"); return; }
    if (!this.moveBase) { this.moveBase = p.clone(); toast("Click the destination point"); return; }
    const dx = p.x - this.moveBase.x, dy = p.y - this.moveBase.y;
    this.moveBase = null;
    if (this.tool === "copy") {
      const copies: ResolvedEntity[] = [];
      const sel = new Set<string>();
      const projected = this.warnSelectedProjected(); // linked — can't clone the link
      for (const e of this.entities) {
        if (!this.selected.has(e.id) || projected.has(e.id)) continue;
        const id = newEntityId();
        copies.push(translated(e, dx, dy, id));
        sel.add(id);
      }
      this.entities = [...this.entities, ...copies];
      this.selected = sel; // leave the copies selected (Fusion-style)
      this.afterModify();
    } else {
      this.transformSelection((e) => [translated(e, dx, dy, e.id)]);
    }
  }

  /** Rotate the selection about a clicked center by a typed angle (degrees). */
  private rotateClick(p: THREE.Vector2) {
    if (!this.selected.size) { toast("Select entities first, then Rotate"); return; }
    const cx = p.x, cy = p.y;
    this.dim.show([{ name: "angle", label: "∠", kind: "angle" }], () => {
      const ang = ((this.dim.getValue("angle") ?? 0) * Math.PI) / 180;
      this.dim.hide();
      this.transformSelection((e) => this.reid(rotated(e, cx, cy, ang, e.id)));
    });
    toast("Rotate: type an angle in degrees");
  }

  /** Scale the selection about a clicked base point by a typed factor. */
  private scaleClick(p: THREE.Vector2) {
    if (!this.selected.size) { toast("Select entities first, then Scale"); return; }
    const cx = p.x, cy = p.y;
    this.dim.show([{ name: "factor", label: "×", kind: "count" }], () => {
      const f = this.dim.getValue("factor") ?? 1;
      this.dim.hide();
      if (f > 0) this.transformSelection((e) => [scaled(e, cx, cy, f, e.id)]);
    });
    toast("Scale: type a factor (e.g. 2 or 0.5)");
  }
  private offsetClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    this.dim.show([{ name: "offset", label: "Offset", kind: "length" }], () => {
      const d = this.dim.getValue("offset") ?? 1;
      // a connected line chain offsets as a mitered unit; else a single entity
      const res = offsetLineChain(this.entities, idx, d) ?? offsetEntity(this.entities, idx, d);
      if (res) this.entities = res;
      this.dim.hide();
      this.afterModify();
    });
  }
  private extendClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    const res = extendLine(this.entities, idx, p);
    if (res) this.entities = res;
    this.afterModify();
  }
  private breakClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    this.entities = breakAt(this.entities, idx, p);
    this.afterModify();
  }
  /** add a persistent geometric constraint and re-solve (the solver maintains
   *  all constraints together, not just the one you applied). Delegates to
   *  ConstraintTools (see constraintTools.ts), which owns the 9 click flows. */
  private constraintClick(p: THREE.Vector2) {
    this.constraintTools.click(p);
  }

  // --- Project (Fusion-style): click 3D model edges, body faces (→ boundary),
  // or committed sketch curves; each pick calls the projectGeometry aux-op
  // against the timeline-PREFIX document (store.projectGeometry truncates) and
  // lands purple linked "projected" entities in the open sketch immediately. ---

  /** the committed sketch feature `id`, when it is a sketch */
  private sourceSketch(id: string): Extract<Feature, { type: "sketch" }> | null {
    const f = this.store?.document.features.find((x) => x.id === id);
    return f && f.type === "sketch" ? f : null;
  }

  /** a committed sketch's REAL entity by id, with its owning sketch feature —
   *  derived pattern copies (ids carry "#") resolve to null: they don't exist
   *  in the document, so the sidecar could never re-find them. */
  private committedSource(
    sketchId: string,
    entityId: string,
  ): { sketch: Extract<Feature, { type: "sketch" }>; entity: ResolvedEntity } | null {
    const sk = this.sourceSketch(sketchId);
    if (!sk || !this.store) return null;
    const entity = resolveRealEntities(sk, this.store.document.parameters).find((x) => x.id === entityId);
    return entity ? { sketch: sk, entity } : null;
  }

  /** hover feedback for the Project tool: model edge/face highlight in Edges &
   *  faces AND Body silhouette modes (the model is dimmed 0.25 in sketch view
   *  but still raycastable; there is no body-level hover in the viewport, so a
   *  silhouette pick hovers the face/edge that will resolve to its body); a
   *  committed curve highlight via the preview layer in Sketch curves mode. */
  private projectHover(e: PointerEvent) {
    if (this.projectPanel.filter !== "sketchCurves") {
      this.overlay.setPreview([]);
      this.viewport.hoverEntity(this.viewport.pickEntity(e.clientX, e.clientY));
      return;
    }
    this.viewport.hoverEntity(null);
    const hit = this.overlay.committedCurveAt(e.clientX, e.clientY, (w) => this.viewport.projectToScreen(w));
    const src = hit ? this.committedSource(hit.sketchId, hit.entityId) : null;
    this.overlay.setPreview(
      src ? curveObjects([src.entity], this.overlay.planeFor(src.sketch.plane), 0x33aaff, true) : [],
    );
    this.viewport.requestRender();
  }

  /** does an already-placed projected entity carry (a match selector for) this
   *  edge fingerprint? Tolerant compare — fps carry float noise, never compare
   *  them byte-for-byte. */
  private hasProjectedFp(fp: EdgeFingerprint): boolean {
    return this.entities.some((x) => {
      if (x.type !== "projected") return false;
      const s = x.source;
      if (s.kind !== "edge" && s.kind !== "faceBoundary") return false;
      return s.sel.kind === "edge" && s.sel.by === "match" && fpClose(s.sel.fp, fp);
    });
  }

  /** One Project pick: resolve what's under the cursor into a ProjectedSource,
   *  run the op, land the returned curves as projected entities. Await-guarded
   *  by projectBusy so double-clicks can't race two calls. */
  private async projectClick(e: PointerEvent) {
    if (this.projectBusy || !this.store) return;
    let source: ProjectedSource | null = null;
    if (this.projectPanel.filter === "sketchCurves") {
      const hit = this.overlay.committedCurveAt(e.clientX, e.clientY, (w) => this.viewport.projectToScreen(w));
      if (!hit) {
        // nothing committed under the cursor — the ACTIVE sketch's own entities
        // are never valid sources (checked second: a projection usually lies
        // screen-coincident with its source, and the source must stay pickable)
        const p = this.planePoint(e);
        if (p && pickEntity(this.entities, p, this.pickTol()) >= 0) toast("Can't project the active sketch's own curves");
        return;
      }
      if (!this.committedSource(hit.sketchId, hit.entityId)) {
        toast("Pattern copies can't be projected — pick the pattern's source curve");
        return;
      }
      const dup = this.entities.some(
        (x) =>
          x.type === "projected" &&
          x.source.kind === "sketchCurve" &&
          x.source.sketch === hit.sketchId &&
          x.source.entity === hit.entityId,
      );
      if (dup) {
        toast("That curve is already projected into this sketch");
        return;
      }
      source = { kind: "sketchCurve", sketch: hit.sketchId, entity: hit.entityId };
    } else {
      const hit = this.viewport.pickEntity(e.clientX, e.clientY);
      if (!hit) return;
      const body =
        hit.kind === "edge"
          ? (hit.line.userData.body as string | undefined)
          : this.viewport.faceIdToBodyId(hit.faceId);
      if (!body) return;
      if (this.projectPanel.filter === "silhouette") {
        // any face/edge hit resolves to its whole BODY — the HLR outline source
        const dup = this.entities.some(
          (x) => x.type === "projected" && x.source.kind === "silhouette" && x.source.body === body,
        );
        if (dup) {
          toast("That body's silhouette is already projected into this sketch");
          return;
        }
        source = { kind: "silhouette", body };
      } else if (hit.kind === "edge") {
        // NOT hit.selector: the picker's nearest point is the line's mid VERTEX,
        // which for a 2-point straight edge is an ENDPOINT — a corner shared by
        // three edges that "nearest" (center-distance) then resolves to the
        // wrong one. The middle segment's midpoint is on (or near) the curve
        // and never a corner.
        const pts = hit.line.userData.points as [number, number, number][];
        const k = Math.max(0, Math.ceil(pts.length / 2) - 1);
        const a = pts[k]!, b = pts[Math.min(pts.length - 1, k + 1)]!;
        source = {
          kind: "edge", body,
          sel: { kind: "edge", by: "nearest", point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] },
        };
      } else {
        // the raycast hit point re-finds exactly the clicked face: it lies ON
        // the face's material, so by:"nearest" distance is 0 there and > 0 for
        // every other face. NOT the face centroid (which can fall off the
        // material — a washer's annular face — and tie with another face), and
        // NOT the picker's own selector (may be a by:"normal" GROUP hit, too
        // broad for one face's boundary).
        source = { kind: "faceBoundary", body, sel: { kind: "face", by: "nearest", point: hit.point } };
      }
    }

    this.projectBusy = true;
    // Session identity: enter() always assigns a fresh entities array, so if the
    // sketch was finished and a NEW one started while the op was in flight (a
    // realistic window — cold-cache prefix rebuilds take seconds), the identity
    // check below rejects the stale reply instead of landing curves computed
    // against the old sketch's plane and timeline prefix.
    const session = this.entities;
    let results;
    try {
      results = await this.store.projectGeometry(this.plane.serialize(), [source], this.editingId);
    } finally {
      this.projectBusy = false;
    }
    if (!this.active || this.tool !== "project" || this.entities !== session) return; // finished/switched/re-entered mid-flight
    const r = results[0];
    if (!r) {
      toast("geometry engine unavailable");
      return;
    }
    if (!r.ok) {
      toast(r.error ?? "projection failed"); // sidecar message verbatim ("created after this sketch"…)
      return;
    }
    // body-edge duplicates are detected against the returned fingerprints (the
    // sketch-curve case was pre-checked above — its ids are stable)
    const fresh = r.curves.filter(({ fp }) => !(fp && this.hasProjectedFp(fp)));
    const skipped = r.curves.length - fresh.length;
    if (skipped) toast(skipped === r.curves.length ? "That edge is already projected into this sketch" : `${skipped} already-projected edge${skipped > 1 ? "s" : ""} skipped`);
    if (!fresh.length) return;
    // multi-curve picks (a face boundary, a projected rectangle) emit sibling
    // entities sharing source.group = the FIRST sibling's entity id (stable:
    // entity ids are birth-stamped and survive edits)
    const ids = fresh.map(() => newEntityId());
    const group = ids.length > 1 ? { group: ids[0]! } : {};
    fresh.forEach(({ fp, curve }, i) => {
      // NOTE (plan step 4): a faceBoundary source persists with a per-edge
      // by:"match" sel — the rebuild refresh handler must resolve it via
      // resolve_edges (not resolve_faces) when it lands.
      const src: ProjectedSource =
        source.kind === "sketchCurve"
          ? // `index: i` is sound because sketch-curve results carry no fps, so
            // the dedup filter above never drops any — i IS the edge index in
            // the sidecar's deterministic _entity_edges order (the refresh
            // handler's authoritative sibling correspondence).
            { kind: "sketchCurve", sketch: source.sketch, entity: source.entity, ...group, ...(fresh.length > 1 ? { index: i } : {}) }
          : source.kind === "silhouette"
            ? // whole-body source: no selector; the refresh re-runs HLR and
              // re-matches the sibling curves (see _recompute_projections)
              { kind: "silhouette", body: source.body, ...group }
            : { kind: source.kind, body: source.body, sel: fp ? { kind: "edge", by: "match", fp } : source.sel, ...group };
      this.entities.push({ type: "projected", id: ids[i]!, source: src, curve });
    });
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  /** Drop constraints that reference an entity that no longer exists (or is the
   *  wrong type) — e.g. after trim/break removes or splits a constrained line.
   *  Projected entities count via their CURVE kind (curveKind: a projected line
   *  is a valid line operand). NOTE: the switch is exhaustive on purpose — before
   *  step 5 the value-dim/fix/collinear/equalRadius/tangent2 types fell through
   *  and were silently dropped by every modify op; the `satisfies never` default
   *  makes a future SketchConstraint variant a tsc error here, not a silent drop. */
  private pruneConstraints() {
    const ids = (pred: (e: ResolvedEntity) => boolean) =>
      new Set(this.entities.filter(pred).map((e) => e.id));
    const lineIds = ids((e) => curveKind(e) === "line");
    const circleIds = ids((e) => curveKind(e) === "circle");
    // entities that own a center (circle/arc), for concentric/radius/equalRadius
    const roundIds = ids((e) => { const k = curveKind(e); return k === "circle" || k === "arc"; });
    const curveIds = ids((e) => curveKind(e) !== undefined);
    // entities that own an addressable endpoint (line/arc/spline/point; projected line/arc/poly)
    const endIds = ids(
      (e) =>
        e.type === "line" || e.type === "arc" || e.type === "spline" || e.type === "point" ||
        (e.type === "projected" && e.curve.kind !== "circle"),
    );
    // entities exposing at least one dimensionable reference point (p2p/p2l/fix targets)
    const refIds = ids((e) => dimRefPoints(e).length > 0);
    const rectIds = ids((e) => e.type === "rectangle");
    // A line OPERAND is either a live line entity or a rectangle EDGE
    // ("<rectId>~<k>", k = 0..3 — see types.ts). Every line-operand check goes
    // through here: a bare `lineIds.has(id)` would reject every rect-edge dim
    // and silently drop it on the next trim/fillet/delete.
    const hasLineOperand = (id: string): boolean => {
      const t = id.indexOf("~");
      if (t < 0) return lineIds.has(id);
      const k = Number(id.slice(t + 1));
      return rectIds.has(id.slice(0, t)) && Number.isInteger(k) && k >= 0 && k <= 3;
    };
    this.constraints = this.constraints.filter((c) => {
      switch (c.type) {
        case "horizontal": case "vertical": case "distance": return hasLineOperand(c.line);
        case "parallel": case "perpendicular": case "equal": case "collinear": case "angle":
          return hasLineOperand(c.l1) && hasLineOperand(c.l2);
        case "diameter": return roundIds.has(c.circle);
        case "tangent": return hasLineOperand(c.line) && circleIds.has(c.circle);
        case "tangent2": return curveIds.has(c.a) && curveIds.has(c.b);
        case "equalRadius": return roundIds.has(c.a) && roundIds.has(c.b);
        case "coincident": return endIds.has(c.e1) && endIds.has(c.e2);
        case "concentric": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "midpoint": return endIds.has(c.e) && hasLineOperand(c.line);
        case "symmetric": return endIds.has(c.e1) && endIds.has(c.e2) && hasLineOperand(c.line);
        case "radius": return roundIds.has(c.e);
        case "p2pDistance": return refIds.has(c.e1) && refIds.has(c.e2);
        case "p2lDistance": return refIds.has(c.e) && hasLineOperand(c.line);
        // rim (edge-to-edge) dims — a round operand is a circle OR an arc
        case "radialGap": return roundIds.has(c.inner) && roundIds.has(c.outer);
        case "c2cDistance": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "c2lDistance": return roundIds.has(c.circle) && hasLineOperand(c.line);
        case "p2cDistance": return refIds.has(c.e) && roundIds.has(c.circle);
        case "fix": return refIds.has(c.e);
        // unreachable while the switch is exhaustive; keeps (rather than drops)
        // a variant tsc failed to flag
        default: return c satisfies never;
      }
    });
  }

  /** Drop pattern sources that reference an entity that no longer exists (e.g.
   *  Delete, or trim/fillet/offset/extend/break replacing an id) — mirrors
   *  pruneConstraints() so a vanished source can't silently shrink the pattern
   *  forever. A pattern left with zero surviving sources is dropped entirely. */
  private prunePatterns() {
    if (!this.patterns.length) return;
    const ids = new Set(this.entities.map((e) => e.id));
    let droppedCount = 0;
    this.patterns = this.patterns.filter((pat) => {
      if (!("sources" in pat)) return true; // preset patterns (hex/honeycomb/boltCircle/gridHoles) have no sources
      const survivors = pat.sources.filter((id) => ids.has(id));
      if (survivors.length === 0) { droppedCount++; return false; }
      pat.sources = survivors;
      return true;
    });
    if (droppedCount > 0) {
      setPrompt(
        droppedCount === 1
          ? "A pattern was removed: its source entity no longer exists"
          : `${droppedCount} patterns were removed: their source entities no longer exist`,
      );
    }
  }

  /** Common tail for modify ops: prune now-dangling constraints + patterns, rebuild, re-solve. */
  private afterModify() {
    this.pruneConstraints();
    this.prunePatterns();
    this.refreshActive();
    this.overlay.setPreview([]);
    this.requestSolve();
  }

  /** Mark the sketch dirty and kick the solve pump. Coalesces many requests
   *  into one in-flight solve so the (single, shared) WASM wrapper is never
   *  re-entered, and stale results never clobber newer geometry. */
  private requestSolve() {
    this.solveDirty = true;
    void this.pump();
  }

  /** The one and only path that touches the solver. Serializes drag solves and
   *  constraint/dimension solves through a single in-flight lock. */
  private async pump() {
    if (this.solveBusy) return;
    this.solveBusy = true;
    try {
      while (this.active && (this.pendingDrag || this.solveDirty)) {
        if (this.pendingDrag) {
          // no entityVersion guard here: a drag never adds/removes entities, so
          // the entity list can't change underneath this solve (unlike a draw).
          const d = this.pendingDrag;
          this.pendingDrag = null;
          const r = await compileAndSolve(this.entities, this.constraints, d);
          if (!this.active || !this.dragFrom) break; // drag ended/cancelled mid-solve
          this.conflict = r.conflicts.length > 0;
          this.conflictIdx = parseConflictIdx(r.conflicts);
          this.overIdx = parseConflictIdx(r.overDefined);
          if (!this.conflict) this.entities = r.entities;
          this.lastDof = r.dof;
          if (r.dragRefused) {
            // grabbed point is fixed and did NOT move: keep the anchor on it.
            // Advancing dragFrom to the cursor would re-run the nearest-point
            // search from a drifted origin and capture an unrelated FREE point
            // mid-gesture (yanking it to the cursor on release).
            if (!this.dragRefusedToast) {
              this.dragRefusedToast = true;
              toast(r.dragRefused === "projected" ? PROJECTED_FIXED_MSG : "That point is fixed — delete its Fix constraint to move it");
            }
          } else if (this.dragFrom) {
            this.dragFrom.set(d.toX, d.toY); // track grabbed pt
          }
          this.refreshDragGeometry(); // curves only; dims/candidates rebuilt on endDrag
        } else {
          this.solveDirty = false;
          if (this.constraints.length === 0) { this.lastDof = -1; this.conflict = false; continue; }
          const ver = this.entityVersion;
          const r = await compileAndSolve(this.entities, this.constraints);
          if (!this.active) break;
          // geometry changed mid-solve (a draw committed): discard, re-solve
          if (this.entityVersion !== ver) { this.solveDirty = true; continue; }
          this.conflict = r.conflicts.length > 0;
          this.conflictIdx = parseConflictIdx(r.conflicts);
          this.overIdx = parseConflictIdx(r.overDefined);
          if (!this.conflict) this.entities = r.entities; // keep last good on conflict
          this.lastDof = r.dof;
          this.refreshActive();
        }
      }
    } finally {
      this.solveBusy = false;
    }
    this.onState?.();
  }

  // --- interactive drag: grab a point, geometry follows, constraints hold ---
  /** the moved entity's attachment points: positions where neighbors may coincide */
  private attachmentPoints(e: ResolvedEntity): THREE.Vector2[] {
    if (e.type === "line" || e.type === "arc") {
      return [new THREE.Vector2(e.x1, e.y1), new THREE.Vector2(e.x2, e.y2)];
    }
    if (e.type === "rectangle") return rectCorners(e.x, e.y, e.width, e.height).map((q) => q.clone());
    if (e.type === "spline") {
      const last = e.points.length - 1;
      const a = e.points[0], b = e.points[last];
      return a && b ? [new THREE.Vector2(a.x, a.y), new THREE.Vector2(b.x, b.y)] : [];
    }
    if (e.type === "circle" || e.type === "point") return [new THREE.Vector2(e.x, e.y)];
    return [];
  }

  /** mutators for OTHER entities' endpoints that coincide with `pts` — the same
   *  position-based merge the solver does (shared coincKey, so "rides along
   *  during drag" and "merged solver point on release" agree exactly).
   *  Rectangles/circles are skipped (their shape can't follow a single corner);
   *  arcs re-solve their through-point after. */
  private stretchTargets(movedIdx: number, pts: THREE.Vector2[]): ((dx: number, dy: number) => void)[] {
    const keys = new Set(pts.map((q) => coincKey(q.x, q.y)));
    const near = (x: number, y: number) => keys.has(coincKey(x, y));
    const out: ((dx: number, dy: number) => void)[] = [];
    this.entities.forEach((e, i) => {
      if (i === movedIdx) return;
      if (e.type === "line" || e.type === "arc") {
        if (near(e.x1, e.y1)) out.push((dx, dy) => { e.x1 += dx; e.y1 += dy; });
        if (near(e.x2, e.y2)) out.push((dx, dy) => { e.x2 += dx; e.y2 += dy; });
      } else if (e.type === "spline") {
        const last = e.points.length - 1;
        for (const k of [0, last]) {
          const q = e.points[k];
          if (q && near(q.x, q.y)) out.push((dx, dy) => { q.x += dx; q.y += dy; });
        }
      } else if (e.type === "point") {
        if (near(e.x, e.y)) out.push((dx, dy) => { e.x += dx; e.y += dy; });
      }
    });
    return out;
  }

  /** Find the nearest solver-controlled point (line endpoint or circle centre)
   *  within pick tolerance of p. Rigid shapes (polygon/slot) are intentionally
   *  excluded — they don't expand to solver points. */
  private pickPoint(p: THREE.Vector2): { p: THREE.Vector2; idx: number } | null {
    const tol = this.pickTol();
    let best: THREE.Vector2 | null = null;
    let bestIdx = -1;
    let bestD = tol * tol;
    let cur = -1;
    const consider = (x: number, y: number) => {
      const dx = x - p.x, dy = y - p.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = new THREE.Vector2(x, y); bestIdx = cur; }
    };
    this.entities.forEach((e, i) => {
      cur = i;
      if (e.type === "line") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
      else if (e.type === "circle") consider(e.x, e.y);
      else if (e.type === "arc") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
      else if (e.type === "spline") for (const q of e.points) consider(q.x, q.y);
      else if (e.type === "point") consider(e.x, e.y);
      else if (e.type === "rectangle") {
        const hw = e.width / 2, hh = e.height / 2;
        consider(e.x - hw, e.y - hh); consider(e.x + hw, e.y - hh);
        consider(e.x + hw, e.y + hh); consider(e.x - hw, e.y + hh);
      }
    });
    return best ? { p: best, idx: bestIdx } : null;
  }

  /** Queue a drag target; pump serializes solves (latest target wins). */
  private queueDrag(to: THREE.Vector2) {
    if (!this.dragFrom) return;
    this.pendingDrag = { fromX: this.dragFrom.x, fromY: this.dragFrom.y, toX: to.x, toY: to.y };
    void this.pump();
  }

  private endDrag(pointerId?: number) {
    if (this.textBoxStart) {
      // finish a text placement: a real drag = a box (wrap width); a click = point anchor
      const s = this.textBoxStart, screen = this.textBoxScreen ?? { x: 0, y: 0 }, end = this.textBoxEnd;
      this.textBoxStart = null;
      this.textBoxEnd = null;
      this.textBoxScreen = null;
      if (pointerId != null) {
        try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
      }
      this.overlay.setPreview([]);
      const phi = this.viewRightAngle();
      if (end) {
        const dx = end.x - s.x, dy = end.y - s.y;
        const cos = Math.cos(phi), sin = Math.sin(phi);
        const wView = Math.abs(dx * cos + dy * sin); // box extent along screen-right (wrap width)
        const hView = Math.abs(-dx * sin + dy * cos); // box extent along screen-up
        if (wView > 1 && hView > 1) {
          const cx = (s.x + end.x) / 2, cy = (s.y + end.y) / 2;
          this.openTextPanel(new THREE.Vector2(cx, cy), screen, { x: cx, y: cy, width: wView }, undefined, phi);
          return;
        }
      }
      this.openTextPanel(s, screen, undefined, undefined, phi);
      return;
    }
    if (this.moveDrag) {
      const md = this.moveDrag;
      this.moveDrag = null;
      if (pointerId != null) {
        try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
      }
      const ent = this.entities[md.idx];
      if (!md.started) {
        // never moved: this was a click — the original (de)select behavior
        this.dragSnapshot = null;
        if (ent) {
          if (md.shift) {
            if (!this.selected.delete(ent.id)) this.selected.add(ent.id);
          } else {
            this.selected = new Set([ent.id]);
          }
          this.refreshActive();
        }
        return;
      }
      this.dragSnapshot = null; // committed — drop the revert buffer
      this.refreshActive();
      this.requestSolve(); // re-satisfy constraints at the new position
      this.onState?.(); // undo checkpoint
      return;
    }
    if (!this.dragFrom) return;
    this.dragFrom = null;
    this.pendingDrag = null;
    if (pointerId != null) {
      try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
    }
    if (!this.dragMoved) {
      // never moved: a click on a vertex — (de)select the owning entity, same
      // behavior as clicking its body (users click near endpoints constantly;
      // this used to silently do nothing)
      this.dragSnapshot = null;
      const ent = this.entities[this.dragEntIdx];
      this.dragEntIdx = -1;
      if (ent) {
        if (this.dragShift) {
          if (!this.selected.delete(ent.id)) this.selected.add(ent.id);
        } else {
          this.selected = new Set([ent.id]);
        }
      }
      this.refreshActive();
      return;
    }
    this.dragEntIdx = -1;
    this.dragSnapshot = null; // committed — drop the revert buffer
    this.refreshActive(); // restore snap candidates + dimension labels at final positions
    this.onState?.();
  }

  /** remaining degrees of freedom (>0 under-constrained, 0 fully constrained) */
  get dof(): number {
    return this.lastDof;
  }

  /** preview while drawing an arc: chord after 1st click, arc after 2nd */
  private arcPreview(cursor: THREE.Vector2) {
    if (this.arcStart && !this.arcEnd) {
      const a = this.arcStart;
      this.overlay.setPreview([
        this.entityCurve({ type: "line", id: "", x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y }),
      ]);
    } else if (this.arcStart && this.arcEnd) {
      const a = this.arcStart;
      const b = this.arcEnd;
      this.overlay.setPreview([
        this.entityCurve({ type: "arc", id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y, mx: cursor.x, my: cursor.y }),
      ]);
    } else {
      this.overlay.setPreview([]);
    }
  }

  // --- grid --------------------------------------------------------------
  private addGrid() {
    this.removeGrid();
    const grid = new THREE.GridHelper(400, 80, 0x44505c, 0x2c333a);
    // GridHelper lies in XZ; orient it onto the sketch plane (XY local)
    grid.quaternion.copy(this.plane.orientation()).multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
    );
    grid.position.copy(this.plane.origin);
    (grid.material as THREE.Material).depthWrite = false;
    grid.renderOrder = 1;
    grid.visible = this.gridVisible;
    this.grid = grid;
    this.viewport.addToScene(grid);
  }
  private removeGrid() {
    if (this.grid) {
      this.viewport.removeFromScene(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
  }
}
