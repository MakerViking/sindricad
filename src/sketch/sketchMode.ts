// The modal sketch environment: enter on a plane (camera squares to it, model
// dims, grid appears), draw Line/Rectangle/Circle interactively with snapping
// and on-canvas dimension input, then Finish to commit the sketch feature.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { EdgeFingerprint, Feature, ParamTarget, PlaceOffset, PlaneSpec, ProjectedSource, ProjectionUpdate, SketchConstraint, SketchPattern } from "../types";
import { applyProjectionUpdate, dimPlaceOf, isBadgeEntity, isPlacedDim } from "../types";
import { SketchPlane } from "./plane";
import { SketchOverlay, curveObjects, dimensionLineObjects, pointHighlight, polyline, dashedPolyline, CURVE_COLOR, PREVIEW_COLOR, SELECT_COLOR } from "./overlay";
import { DimInput } from "./dimInput";
import { TextPanel } from "./textPanel";
import type { TextValues } from "./textPanel";
import { fetchFonts } from "./textCache";
import { isEditableTarget } from "../ui/focus";
import { SketchDimensions, type ExtraDim } from "./sketchDimensions";
import { SketchGlyphs } from "./sketchGlyphs";
import { constraintGlyphs, diagnosisOf, type ConstraintGlyph } from "./glyphs";
import { entityDims, constraintDims, dimRefPoints, curveKind, lineOperand, linearDim, setDimPixelScale, staggeredDefaults, type DimField, type ConstraintDim } from "./entityDims";
import {
  clampPlace, isDimError, isRoundTarget, pickDimTarget, rebindTarget, resolveDim, targetIdentity,
  targetKey, unsupportedMessage,
  type DimOptions, type DimPlan, type DimTarget,
} from "./dimensionTool";
import { pickEntity, trimEntity, filletCorner, chamferCorner, offsetEntity, offsetChain, signedOffsetAt, breakAt, extendLine, breakLink, PROJECTED_FIXED_MSG, type OffsetResult } from "./modify";
import { newEntityId, newConstraintId, isDimConstraint, notePatternId } from "./id";
import { SketchHistory, cloneSnapshot, type SketchSnapshot } from "./history";
import { isPlainNumber, parseField } from "../ui/units";
import { RIGID_ENTITY_NUM_FIELDS, coerceForField, type FieldKind } from "../document/numFields";
import type { SketchBinding } from "../document/store";
import { circumcenter } from "./arc";
import { compileAndSolve, coincKey, constraintIndexOf } from "./sketchSolve";
import { SolverUnavailable } from "./solver";
import { resolveRealEntities, toSketchEntity } from "./resolve";
import { applyDrivingDimsDirect } from "./directDims";
import { expandPattern, translated, rotated, scaled } from "./pattern";
import { candidatesFromEntities, snap, type SnapKind, type SnapCandidate } from "./snap";
import type { ResolvedEntity } from "./snap";
import { inferHorizontalVertical, isGeometrySnap } from "./autoConstrain";
import { detectRegions, rectCorners } from "./region";
import { setSpaceMouseOrbitLocked } from "../input/spacemouse";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { contextMenu, dismissContextMenu, type CtxItem } from "../ui/menu";
import { niceStep } from "../ui/units";
import { isOriginGeometry, originGeometry } from "./origin";
import { boxFromDrag, entitiesInBox } from "./boxSelect";
import { applicableConstraints, constraintLabel } from "./constraintMenu";
import { ConstraintTools, CONSTRAINT_TOOLS, type ConstraintHost } from "./constraintTools";
import { PatternFlow, PATTERN_TOOLS, ENTITY_PATTERNS, type PatternHost } from "./patternFlow";
import { ProjectPanel } from "./projectPanel";
import { checkSketch } from "./check";
import { showCheckPanel, hideCheckPanel } from "./checkPanel";
import { CONFLICT, SKETCH_POINT_HOVER } from "../viewport/colors3d";

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

/** Cell size and centre for the sketch grid at a given zoom, in PLANE-LOCAL mm.
 *
 *  Exported and pure because it decides two things that are easy to get subtly
 *  wrong and impossible to see afterwards:
 *
 *  1. The cell is `niceStep(worldPerPixel * 64)`, the SAME expression the ground
 *     grid uses (viewport/scene.ts). The two grids have to agree about what a
 *     given zoom looks like, or the lattice appears to jump when a sketch closes.
 *  2. The centre is rounded to whole MAJOR cells. Grid snapping rounds in
 *     plane-local coordinates off the plane origin (see snap.ts), so a visual
 *     grid shifted by anything other than a whole multiple of the cell would
 *     draw lines that are NOT the lines you snap to — the failure this whole
 *     change exists to remove.
 *
 *  `key` is the memo: the render loop calls this every frame, so the caller
 *  rebuilds only when it changes. */
export function gridScaleFor(
  worldPerPixel: number,
  localX: number,
  localY: number,
): { cell: number; cx: number; cy: number; key: string } {
  const cell = niceStep(worldPerPixel * 64); // ~64px cells
  const major = cell * 5;
  const cx = Math.round(localX / major) * major;
  const cy = Math.round(localY / major) * major;
  return { cell, cx, cy, key: `${cell}:${cx}:${cy}` };
}

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
  /** Snap kind of the point most recently placed/hovered, and of the point
   *  that became the current line's START. Auto-H/V must not move a point the
   *  user snapped onto existing geometry (field report ecc3e0d6). */
  private lastSnapKind: SnapKind = "free";
  private basePinned = false;
  /** the constraint the next click would add, drawn muted (field report 636afdcb) */
  private pendingGlyph: ConstraintGlyph | null = null;
  private arcStart: THREE.Vector2 | null = null; // 3-point arc: start, end, then bulge
  private arcEnd: THREE.Vector2 | null = null;
  private splinePts: THREE.Vector2[] = []; // in-progress spline fit points
  private clickPts: THREE.Vector2[] = []; // accumulated clicks for multi-point primitives (polygon/slot/circle variants)
  private polygonSides = 6; // n for the polygon tool
  private filletFirst: number | null = null; // first line picked for a sketch fillet
  /** world position of the endpoint a constraint flow is holding, if any */
  private pendingConstraintPoint: THREE.Vector3 | null = null;
  /** the constraint just added by a tool, on trial until its solve comes back */
  private trialConstraint: SketchConstraint | null = null;
  /** The entities the NEXT non-drag solve is allowed to move — "what you picked
   *  first is what moves" (bug #86, see sketchSolve's `bias`). Armed by the tool
   *  that knows the pick order and consumed by exactly one solve in pump().
   *
   *  Deliberately NOT persisted with the constraint, and deliberately not
   *  reachable from headlessSolve: pick order belongs to the gesture, not to the
   *  document, so no saved sketch changes how it solves because of this. */
  private pendingBias: { moves: string[] } | null = null;
  private selected = new Set<string>(); // selected entity ids (select tool)
  private constraints: SketchConstraint[] = []; // persistent constraints (solved)
  private patterns: SketchPattern[] = []; // associative pattern definitions
  private lastDof = -1;
  /** Marquee (box) selection in progress — GH #17. Started on a press in empty
   *  space with the select tool, so it can never steal a gesture that had a
   *  target: every branch that finds something under the cursor returns first. */
  private boxSel: { from: THREE.Vector2; to: THREE.Vector2; shift: boolean } | null = null;
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

  // --- in-sketch undo -------------------------------------------------------
  // Ctrl+Z used to reach store.undo(), which pops whole-DOCUMENT snapshots — and
  // an open sketch isn't in the document until finish(), so the newest entry IS
  // the sketch. Ten lines drawn, one Ctrl+Z, all ten gone. These stacks live for
  // the editing session only; leaving and re-entering a sketch starts fresh.
  private history = new SketchHistory();
  private dragRefusedToast = false; // one refusal toast per drag gesture (fixed point, or refused geometry)
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
  // the solver WASM failed to come up: stop pumping and say so ONCE, rather
  // than letting every stroke raise the same unhandled rejection
  private solverDead = false;
  private solverDeadToast = false;
  private directDimToast = false; // said once: dims are being written straight to geometry
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
  /** The datumPlane feature this sketch is placed ON, when it was created from
   *  one. Round-tripped through finish() so re-editing a sketch never silently
   *  downgrades it from a live datum link to a baked placement. */
  private planeId: string | null = null;
  private store: DocumentStore | undefined;
  private grid: THREE.GridHelper | null = null;
  /** current sketch-grid cell in mm — ALSO the grid-snap step, so what you snap
   *  to is always the lattice you can see. Starts at GRID_STEP and is replaced by
   *  updateGridScale on the first rendered frame. */
  private gridCell = GRID_STEP;
  private gridKey = ""; // cell+centre the grid was last built for
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
  private viewLocked = false; // orbit stays free inside a sketch (Fusion parity)
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
    this.dims.onLabelMenu = (e, del) => {
      // Disabled rather than absent on an entity dim: a circle's diameter is a
      // property of the circle, so there is no constraint to remove, and saying
      // so beats a right-click that appears to do nothing.
      contextMenu(e.clientX, e.clientY, [
        { label: "Delete dimension", danger: true, disabled: !del, shortcut: "Del", onClick: () => del?.() },
      ]);
    };
    this.glyphs = new SketchGlyphs(viewport);
    this.glyphs.onDelete = (i) => this.deleteConstraint(i);
    this.glyphs.onOverlapPick = (e) => this.labelOverlapSelect(e);
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
      addConstraint: (c, moves) => {
        this.constraints.push(c);
        this.trialConstraint = c; // withdrawn again if this solve conflicts
        if (moves) this.pendingBias = { moves: [moves] }; // before requestSolve — pump reads it synchronously
        this.requestSolve();
      },
      warn: (msg) => toast(msg),
      // Mark the endpoint a constraint flow is holding. Coincident's first click
      // used to leave no trace at all, so the tool looked dead until the second
      // click happened to land on an endpoint.
      setPendingPoints: (ps) => {
        const worlds = ps.map((q) => this.plane.to3D(q.x, q.y));
        this.pendingConstraintPoint = worlds[0] ?? null;
        this.overlay.setPendingPoints(worlds, this.viewport.camera);
        if (this.pendingConstraintPoint) {
          // one scale for the pool: the markers are a few mm apart at most, so a
          // per-marker size would differ by less than a pixel and cost a
          // projection each
          this.overlay.setPendingPointScale(
            this.viewport.pixelWorldSize(this.pendingConstraintPoint) * 6,
          );
        }
        this.viewport.requestRender();
      },
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
  /** `planeId` links the sketch to a datumPlane FEATURE instead of freezing its
   *  placement: `plane` is still stored (as the resolved cache every frontend
   *  consumer reads), but the sidecar prefers the id, so editing the datum's
   *  offset later moves this sketch. Without it an offset plane's distance is
   *  baked into the origin and gone. */
  enter(plane: PlaneSpec, store: DocumentStore, editId?: string, planeId?: string) {
    this.active = true;
    this.editingId = editId ?? null;
    this.plane = this.overlay.planeFor(plane);
    this.planeId = planeId ?? null;
    this.store = store;
    this.history.reset(); // fresh history per session (armed once entities load)
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
        // keep an existing datum link across a re-edit (the caller only passes
        // planeId when it just created the datum)
        if (f.planeId) this.planeId = f.planeId;
        for (const p of this.patterns) notePatternId(p.id); // reserve ids so new ones don't collide
      }
    }

    // The origin goes in AFTER the edit branch above, so it lands on a new
    // sketch and a reopened one alike — a document saved before this existed
    // gains one simply by being opened. Synthetic: stripped again in
    // snapshotFeature, so it is never written back. See origin.ts.
    this.entities.unshift(...originGeometry());
    this.viewport.suspendPicking = true;
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.gridKey = ""; // force the first frame to build at the current zoom
    this.addGrid();
    // The grid rescales with zoom from here on. Registered on the viewport
    // rather than polled, because the only honest source for "how far are we
    // zoomed in" is the frame that is about to be drawn.
    this.viewport.onZoomScale = (wpp, tx, ty, tz) => this.updateGridScale(wpp, tx, ty, tz);

    const el = this.viewport.domElement;
    el.addEventListener("pointerdown", this.boundDown);
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerup", this.boundUp);
    el.addEventListener("contextmenu", this.boundContext);
    window.addEventListener("keydown", this.boundKey, true);

    this.overlay.update(store.document, this.editingId ?? "__active__");
    this.refreshActive();
    this.armPreEdit(); // the session's baseline: the first edit undoes back to here
    // A NEW sketch opens armed to draw (mainstream MCAD: Fusion auto-starts a
    // create tool), but RE-EDITING one opens in select. editFeature() is the only
    // caller that passes editId and it never sets a tool afterwards, so a user
    // who double-clicked a sketch to change what is already there used to land on
    // top of that geometry with Rectangle armed — every click drew instead of
    // picking. That is the case field report c9db7ec2 describes: a sidebar full
    // of editable lengths for entities the user could not click. startSketch()
    // still overrides this immediately when a tool was asked for (L/C/R/A/P).
    this.setTool(this.editingId ? "select" : "rectangle");
    // Square the camera to the plane on EVERY sketch entry, whether or not the
    // orbit lock is on. Opening a sketch should always look at it; whether you
    // may then orbit away is a separate question, and the one the toggle owns.
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.setViewLocked(this.viewLocked); // apply lock-to-plane preference
    if (this.constraints.length > 0) this.requestSolve(); // restore DOF state
    this.onState?.();
  }

  /** The feature this session WOULD commit, built without committing it.
   *
   *  An open sketch lives entirely in this class — `entities`, `constraints` and
   *  `patterns` are a working copy, and nothing reaches the store until finish()
   *  runs. So anything that serialises the document mid-session sees a sketch
   *  that is stale (when editing) or absent altogether (when new). That is why a
   *  bug filed from inside the sketcher used to arrive with an empty document,
   *  which cost a repro on the 2026-08-02 dimension report; the bug reporter now
   *  splices this in. Shared with finish() so the two can never disagree.
   *
   *  Null when no sketch is open, or when nothing has been drawn yet. */
  snapshotFeature(): Feature | null {
    if (!this.active || !this.store) return null;
    if (this.entities.length === 0 && this.patterns.length === 0) return null;
    return {
      id: this.editingId ?? this.store.nextId(),
      type: "sketch",
      plane: this.plane.serialize(),
      ...(this.planeId ? { planeId: this.planeId } : {}),
      entities: this.entities
        .filter((e) => e.id !== TEXT_PREVIEW_ID && !isOriginGeometry(e.id))
        .map(toSketchEntity),
      ...(this.constraints.length > 0 ? { constraints: this.constraints.map((c) => ({ ...c })) } : {}),
      ...(this.patterns.length > 0 ? { patterns: this.patterns.map((p) => ({ ...p })) } : {}),
    };
  }

  finish(commit = true) {
    if (!this.active) return;
    const store = this.store!;
    this.patternFlow.flushOnFinish(); // may add patterns — must precede the snapshot
    const sketch = commit ? this.snapshotFeature() : null;
    if (sketch) {
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
    hideCheckPanel(); // a stale results list must not outlive the sketch it describes
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
    // The prompt is a transient like the rest of these, and was the one thing
    // cleanup() forgot: leaving the sketch used to leave "Rectangle: click two
    // corners · type W, Tab, H · Enter · Esc" on screen while the context tab
    // had already switched back to SOLID, telling the user to do something the
    // app was no longer listening for. Whichever tool comes next sets its own.
    setPrompt(null);
    this.viewport.hoverEntity(null); // drop any Project-tool 3D hover highlight
    this.overlay.setPreview([]);
    this.overlay.setSnap(null);
    this.viewport.onZoomScale = null; // stop rescaling a grid we are about to drop
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
    this.offsetPick = null; // an in-progress offset dies with its tool
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
    // Labels and glyphs take clicks in `select` and, since 2026-08-03, in
    // `dimension`. Two field reports (0.1.76 and 0.1.77) said dimensions could
    // not be edited or deleted "after the fact": the dimension tool re-arms
    // after every commit (it is a batch activity, see dimensionClick), so a user
    // who had just dimensioned a sketch was still in that tool, where every
    // label and glyph was pointer-transparent with no cursor change to say so.
    // labelOverlapDimension keeps dimensioning's own clicks working.
    const annotationsLive = t === "select" || t === "dimension";
    this.dims.setInteractive(annotationsLive);
    this.glyphs.setInteractive(annotationsLive);
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
    this.redrawGlyphs();
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
    this.overlay.setActiveSketch(
      curveObjects(this.entities, this.plane, this.activeColor(), false, this.endpointDotRadius()),
    );
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
  private placeDim(c: SketchConstraint, forceDriven = false, moves?: string): SketchConstraint {
    const drivenable = isPlacedDim(c);
    const driven = drivenable && (this.referenceMode || forceDriven);
    if (this.referenceMode && !drivenable) {
      toast("A line length / circle diameter can't be a reference dimension yet — created as driving.");
    }
    const out = driven ? ({ ...c, driven: true } as SketchConstraint) : c;
    this.setDrivingDimension(out, moves);
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

  /** Write the driving length/⌀ dimensions straight into the geometry, for when
   *  there is no solver to do it properly.
   *
   *  These two dimensions are the only ones that go through a constraint rather
   *  than editing coordinates (see editDimension), so on a machine where the
   *  solver's WASM will not start they were the only ones that silently did
   *  NOTHING: the constraint was recorded, never solved, and the circle stayed
   *  the size it was drawn. Rectangle W/H kept working, which is exactly how a
   *  Windows user reported it — "when creating a circle I am unable to put in a
   *  new value for the dimension, other shapes seem to work fine" (0.1.100).
   *
   *  The constraint is deliberately KEPT. This is a best-effort stand-in, not a
   *  replacement: the moment a real solver is available it drives the geometry
   *  properly, and nothing about the saved sketch is different from one authored
   *  on a working machine.
   *
   *  Only the unambiguous single-entity cases are handled. Anything relating two
   *  entities needs a solve to decide WHICH of them moves, and guessing would
   *  put geometry somewhere the user did not ask for. */
  private applyDrivingDimsDirectly() {
    if (!applyDrivingDimsDirect(this.entities, this.constraints)) return;
    this.entityVersion++; // guards any in-flight solve against this write
    if (!this.directDimToast) {
      this.directDimToast = true;
      toast(
        "Without the constraint solver, a length or diameter is applied to the shape directly and is not kept as a live dimension. It will drive the geometry properly once the solver runs.",
        { timeout: 12000 },
      );
    }
    this.refreshActive();
    this.onState?.();
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
          if (c && isPlacedDim(c)) this.writeDimValue(c, val);
        },
        onDelete: () => this.deleteConstraint(d.cIndex),
        commitExpr: (raw: string) => {
          const c = this.constraints[d.cIndex];
          if (!c || !isDimConstraint(c)) return "not editable";
          if (!c.id) c.id = newConstraintId();
          return this.commitExprInput(`c:${c.id}`, d.kind === "angle" ? "angle" : "length", raw, (v) => {
            this.writeDimValue(c, v);
          });
        },
      };
    });
  }

  /** Write a typed value onto a dimension's constraint, then re-solve.
   *
   *  The one seam BOTH edit paths (plain number and expression) go through,
   *  because the offset dim needs special care: it DISPLAYS |value| while the
   *  stored value is SIGNED, the sign being which side the copy sits on. Typing
   *  "3" into an inward offset must keep it inward — a bare `c.value = val`
   *  would silently flip it outward. Same abs-display trap as the drag path;
   *  centralising the write is what stops the two sites drifting apart. */
  private writeDimValue(c: SketchConstraint & { value: number }, val: number) {
    c.value = c.type === "offset" && c.value < 0 ? -Math.abs(val) : val;
    this.requestSolve();
    this.onState?.();
  }

  /** Add/replace the driving dimension on an entity, then re-solve. A dim gets
   *  its stable id at birth; a replacement inherits the replaced dim's id, so a
   *  parameter binding survives retyping the dimension.
   *
   *  `moves` names the entity this dimension should move (the first-picked
   *  operand — see DimPlan.moves). It biases exactly ONE solve and is never
   *  stored, so only the callers that still know the pick order pass it. */
  private setDrivingDimension(c: SketchConstraint, moves?: string) {
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
      // Same pair, same KIND replaces — but an aligned, a horizontal and a
      // vertical dimension over one pair are three different constraints and
      // must coexist, which the `c.type === k.type` guard already gives us.
      // Both operand orders count as the same dim: re-dimensioning the other way
      // round replaces rather than stacking a second one (the new pick's sign
      // wins, which is the behaviour you want from a re-dimension).
      if (
        (c.type === "p2pDistanceX" && k.type === "p2pDistanceX") ||
        (c.type === "p2pDistanceY" && k.type === "p2pDistanceY")
      ) {
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
      // offset: one dim per OPERATION, identified by the set of copies it
      // governs. Re-offsetting the same curves replaces the old dim (inheriting
      // its id, so a parameter binding survives); a different offset elsewhere
      // in the sketch is a different target and both survive.
      if (c.type === "offset" && k.type === "offset") {
        const key = (o: typeof c) => o.pairs.map((p) => p.cpy).sort().join("|");
        return key(c) === key(k);
      }
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
    if (moves) this.pendingBias = { moves: [moves] }; // BEFORE requestSolve: pump reads it synchronously
    this.requestSolve();
    // requestSolve is a no-op once the solver is known dead, so on those
    // machines the value has to be written into the geometry here or it is
    // recorded and never seen. Harmless when the solver is alive: this is not
    // reached, and the solve is what moves anything.
    if (this.solverDead) this.applyDrivingDimsDirectly();
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
      this.armPreEdit(); // parameter sync is DERIVED — never an undo step
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
      this.armPreEdit(); // projection refresh is DERIVED — never an undo step
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
    if (this.tool === "dimension") return this.labelOverlapDimension(e);
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

  /** Arbitrate a click that landed on a label or glyph while the dimension tool
   *  is active. Dimensioning keeps every click it needs: one with picks already
   *  taken is mid-dimension (the second operand, or the placement), and one that
   *  lands on geometry names the next operand. Only a click on an idle
   *  annotation over empty space belongs to the annotation itself. A
   *  double-click always reaches the label regardless (SketchDimensions). */
  private labelOverlapDimension(e: PointerEvent): boolean {
    const raw = this.planePoint(e);
    if (!raw) return false;
    const midDimension = this.dimPicks.length > 0;
    if (!midDimension && !pickDimTarget(this.entities, raw, this.pickTol())) {
      return false; // the annotation owns this click
    }
    this.dimensionClick(raw, e);
    return true;
  }

  private onPointerDown(e: PointerEvent) {
    // A label stops propagation on its own pointerdown, so reaching here means
    // the click landed away from every dimension: drop the label selection so a
    // later Delete can't remove a dimension the user is no longer pointing at.
    this.dims.clearSelection();
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
    // TRIM takes the RAW cursor, never the snapped point — the same carve-out
    // the dimension tool above makes, for a sharper reason. The entire gesture
    // is "which side of the crossings am I pointing at", and the strongest snap
    // targets near a line you are trimming ARE those crossings. Snapping put the
    // click exactly on a span boundary, which belongs to both spans, so the span
    // search took the earlier one and trim deleted the piece NEXT TO the one
    // under the cursor. Measured on a line crossed at x=-5 and x=+5: aiming at
    // the middle span but snapping to x=-5 removed the LEFT span instead.
    //
    // This also has to come BEFORE the `if (!hit) return` below: a click with
    // nothing to snap to must still trim.
    if (this.tool === "trim") {
      const raw = this.planePoint(e);
      if (!raw) return;
      e.preventDefault();
      this.trimClick(raw);
      return;
    }
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);
    if (!hit) return;
    e.preventDefault();
    const p = hit.p;
    this.lastSnapKind = hit.kind;

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
      // TEXT is draggable too (GH #17: "Unable to manually drag or adjust text
      // position with the mouse in the sketch plane after creation"). It never
      // reached the body-drag below because `pickEntity` cannot see it —
      // entitySegments is empty for text, which is why the double-click above
      // finds it through its glyph bounding box instead. `translated` has always
      // handled a text entity, so arming the SAME drag is all that was missing;
      // a press that does not move still falls through to selection in endDrag,
      // and a double-click was already consumed above.
      const te = this.textEntityAt(raw);
      const teIdx = te ? this.entities.indexOf(te) : -1;
      if (teIdx >= 0) {
        this.moveDrag = {
          idx: teIdx,
          startClient: { x: e.clientX, y: e.clientY },
          last: raw.clone(),
          started: false,
          shift: e.shiftKey,
          stretch: [],
        };
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
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
      // Empty space: begin a marquee. The selection is NOT cleared here any
      // more — a box drag that ends up selecting nothing clears it in endDrag,
      // and a plain click (no movement) clears it there too, so the old
      // behaviour is preserved without pre-emptively wiping a selection the
      // user may be about to extend with Shift.
      this.boxSel = { from: raw.clone(), to: raw.clone(), shift: e.shiftKey };
      try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
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
    // (trim is handled above, on the RAW cursor — see the carve-out there)
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
      this.basePinned = isGeometrySnap(hit.kind);
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
    // The cursor is what makes the dimension SMART: with two points picked, where
    // the label is being dragged chooses aligned / horizontal / vertical. It is
    // passed on every re-resolve, which is why moving the mouse re-plans.
    return {
      ...(this.dimRoundPref ? { roundPref: this.dimRoundPref } : {}),
      cursor: this.lastCursor.clone(),
    };
  }

  /** WHICH dimension the open box belongs to: the plan shape plus the picks it
   *  came from (rim/tangent MODE included — a rim distance and a centre distance
   *  between the same pair share a field set but are different dimensions).
   *  Re-showing the box on a change is what stops a value typed for one
   *  dimension being committed as another.
   *
   *  The field LABEL is part of the identity, and load-bearing for smart
   *  dimensioning: aligned, horizontal and vertical point-to-point distances all
   *  build `kind: "distance"` with `fieldKey: "distance:length"`, so without the
   *  label they are indistinguishable here. Dragging the cursor would then flip
   *  the constraint from p2pDistance to p2pDistanceX underneath a box still
   *  reading "D", and the committed constraint would not be the one on screen. */
  private dimIdentity(plan: DimPlan): string {
    const label = plan.fields[0]?.label ?? "";
    return `${plan.kind}:${plan.fieldKey}:${label}|${this.dimPicks.map(targetIdentity).join("+")}`;
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
    // A reference dim measures and constrains nothing, so it has no business
    // holding anything still — same gate the two implied constraints above use.
    const moves = this.referenceMode || forceDriven ? undefined : plan.moves;
    const placed = this.placeDim(c, forceDriven, moves);
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
    // SMART DIMENSIONING, the live half (GH #17, Moi455). `dimOptions` already
    // passes the cursor and `p2pDimKind` already chooses aligned / horizontal /
    // vertical from it — but nothing re-resolved the plan while the label was
    // being dragged, so the choice was frozen at the instant of the second pick.
    // At that instant the cursor sits ON the point just clicked, which is the
    // one position where the aligned distance can never win, so a two-point
    // dimension could only ever come out horizontal or vertical.
    //
    // Gated on `!dimPlaced`: once the label is placed the dimension is settled,
    // and re-planning then would re-show the box and destroy anything typed.
    if (this.dimPicks.length === 2 && !this.dimPlaced && this.dimPlan) this.refreshDimPlan();
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
    // A marquee owns the pointer for as long as it is being dragged.
    if (this.boxSel) {
      const raw = this.planePoint(e);
      if (raw) {
        this.boxSel.to = raw.clone();
        this.overlay.setPreview(this.boxPreview());
        this.viewport.requestRender();
      }
      return;
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
    this.lastSnapKind = hit.kind; // kept in step with lastCursor: the Enter-key commit reads both
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
      this.previewPendingGlyph(geom.entity, hit.kind);
    } else {
      this.overlay.setPreview([]);
      this.clearPendingGlyph();
    }
  }

  /** Show the constraint this click WOULD add, before it is added.
   *
   *  Point snaps have always drawn a marker under the cursor; the line
   *  horizontal/vertical inference fired silently at commit, so the first sign of
   *  it was a badge appearing on geometry the user had already committed to —
   *  "when working with lines, there is no visual feedback indicating that a
   *  constraint will be applied before clicking. The visual feedback appears to
   *  work only with points" (field report 636afdcb).
   *
   *  This runs the SAME inference the commit will run, with the same pinning, so
   *  the badge cannot promise a constraint the commit then declines to add. */
  private previewPendingGlyph(entity: ResolvedEntity, cursorSnap: SnapKind) {
    if (!this.glyphsVisible || entity.type !== "line" || this.tool !== "line") {
      return this.clearPendingGlyph();
    }
    if (this.dim.isUserDriven("angle")) return this.clearPendingGlyph(); // typed angle wins; nothing inferred
    const r = inferHorizontalVertical(entity, {
      startPinned: this.basePinned,
      endPinned: isGeometrySnap(cursorSnap),
    });
    if (!r.kind) return this.clearPendingGlyph();
    this.pendingGlyph = {
      cIndex: -1,
      label: r.kind === "horizontal" ? "H" : "V",
      pos: new THREE.Vector2((r.ends.x1 + r.ends.x2) / 2, (r.ends.y1 + r.ends.y2) / 2),
      pending: true,
    };
    this.redrawGlyphs();
  }

  private clearPendingGlyph() {
    if (!this.pendingGlyph) return;
    this.pendingGlyph = null;
    this.redrawGlyphs();
  }

  /** Repaint the glyph layer from the committed constraints plus any pending one. */
  private redrawGlyphs() {
    if (!this.glyphsVisible) return void this.glyphs.hide();
    const live = constraintGlyphs(this.entities, this.constraints);
    this.glyphs.show(
      this.pendingGlyph ? [...live, this.pendingGlyph] : live,
      this.plane,
      this.conflictIdx,
      this.overIdx,
    );
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
      // A selected dimension goes first: it is a more specific target than the
      // entity selection, and isEditableTarget above already returned if the
      // label's inline editor has focus, so this only fires once the editor is
      // closed (Esc) or was never opened (right-click).
      if (this.dims.deleteSelected()) {
        e.preventDefault();
        return;
      }
      if (this.tool === "select" && this.selected.size) {
        e.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.offsetPick) { this.cancelOffset(); return; }
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
      // auto-infer horizontal/vertical (skip the closing seg + typed angles).
      // Both ends carry whether they were snapped ONTO existing geometry, so the
      // correction never moves a point the user deliberately joined.
      if (!closing && !this.dim.isUserDriven("angle")) {
        this.inferLineConstraint(entity, this.basePinned, isGeometrySnap(this.lastSnapKind));
      }
      if (closing) {
        this.base = null;
        this.chainStart = null;
        this.dim.hide();
      } else {
        this.base = new THREE.Vector2(entity.x2, entity.y2); // snapped endpoint
        // the next segment starts where this one ended; that point is pinned iff
        // this one's end was, or iff auto-H/V has now fixed it in place
        this.basePinned = isGeometrySnap(this.lastSnapKind);
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
   *  snap it exactly and record the constraint (mainstream MCAD's auto-constrain).
   *
   *  `startPinned`/`endPinned` say which ends were placed on existing geometry.
   *  Making the line exact means moving an endpoint, and this used to always move
   *  the second one — destroying a join the user had just snapped, by exactly the
   *  angular error their hand left (field report ecc3e0d6). See autoConstrain.ts. */
  private inferLineConstraint(e: ResolvedEntity, startPinned = false, endPinned = false) {
    if (e.type !== "line") return;
    const r = inferHorizontalVertical(e, { startPinned, endPinned });
    if (!r.kind) return;
    e.x1 = r.ends.x1;
    e.y1 = r.ends.y1;
    e.x2 = r.ends.x2;
    e.y2 = r.ends.y2;
    this.constraints.push({ type: r.kind, line: e.id });
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
      this.gridSnap ? this.gridCell : 0,
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
    return this.conflict ? CONFLICT : this.lastDof === 0 ? 0xffffff : CURVE_COLOR;
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

  /** Endpoint dot radius in plane units, held at a constant ~5px across.
   *  Recomputed per refresh rather than per frame: the sketch re-emits on
   *  practically every interaction, and a per-frame rescale would mean another
   *  group to keep in sync for a dot. */
  private endpointDotRadius(): number {
    return this.viewport.pixelWorldSize(this.plane.origin) * 2.5;
  }

  private activeCurves(derived: ResolvedEntity[]): THREE.Object3D[] {
    const objs: THREE.Object3D[] = [];
    // ~5px across at the current zoom. Endpoints are only drawn on the ACTIVE
    // sketch: they are click targets for the constraint tools, and putting a dot
    // on every committed sketch in the document would be noise.
    const epR = this.endpointDotRadius();
    if (this.selected.size) {
      const normal = this.entities.filter((e) => !this.selected.has(e.id));
      const chosen = this.entities.filter((e) => this.selected.has(e.id));
      if (normal.length) objs.push(...curveObjects(normal, this.plane, this.activeColor(), false, epR));
      if (chosen.length) objs.push(...curveObjects(chosen, this.plane, SELECT_COLOR, true));
    } else {
      objs.push(...curveObjects(this.entities, this.plane, this.activeColor(), false, epR));
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
    // An offset being placed owns the preview: this is the MODIFY_TOOLS hover
    // branch and it runs on every move, so without this it would overwrite the
    // offset's live preview with a plain hover highlight one frame later.
    if (this.offsetPick) { this.offsetMove(e); return; }
    const p = this.planePoint(e);
    if (!p) return;
    const idx = pickEntity(this.entities, p, this.pickTol());
    const preview: THREE.Object3D[] = [];
    const first = this.filletFirst != null ? this.entities[this.filletFirst] : undefined;
    if (first) {
      // A rectangle presents four LINE OPERANDS and no operand of its own, so
      // highlighting the entity lit all four sides when the user had armed one
      // of them: the right constraint, and feedback that pointed at the wrong
      // thing. Draw the edge actually picked, when the flow is holding one.
      // SketchMode's own fillet tool shares `filletFirst` and holds no operand,
      // so it falls through to the whole entity exactly as before.
      const opId = this.constraintTools.heldOperandId();
      const seg = opId && opId !== first.id
        ? lineOperand(new Map(this.entities.map((e) => [e.id, e])), opId)
        : null;
      preview.push(...curveObjects(
        seg ? [{ type: "line", id: first.id, ...seg } as ResolvedEntity] : [first],
        this.plane, 0x33aaff, true,
      ));
    }
    const hit = idx >= 0 ? this.entities[idx] : undefined;
    if (hit) preview.push(...curveObjects([hit], this.plane, 0xff5555, true));
    // The point under the cursor, for the tools that consume one. It goes on
    // AFTER the entity highlight so it paints on top: an endpoint and the curve
    // owning it are both under the cursor at once, and the click takes the
    // point, so the point is what has to be legible.
    const pt = this.hoverablePoint(p);
    if (pt) {
      preview.push(
        pointHighlight(this.plane, pt.x, pt.y, SKETCH_POINT_HOVER, this.endpointDotRadius() * 1.7),
      );
    }
    this.overlay.setPreview(preview);
  }

  /** The addressable point under the cursor FOR THE ACTIVE TOOL, or null when
   *  the tool does not take one.
   *
   *  Scoped rather than universal on purpose. Trim, fillet, move and the rest of
   *  MODIFY_TOOLS act on whole entities, so lighting up a point while one of
   *  them is armed would promise a target the tool cannot use — the same class
   *  of lie as a target you can hit but cannot see, which is what rectangle
   *  corners were until this release. */
  private hoverablePoint(p: THREE.Vector2): { x: number; y: number } | null {
    // Constraint flows: ask ConstraintTools, so the highlight and the click
    // cannot disagree about which point is addressable.
    if (CONSTRAINT_TOOLS.has(this.tool)) return this.constraintTools.hoverPoint(p);
    if (this.tool !== "dimension") return null;
    // Dimensioning resolves through dimRefPoints, which is a SUPERSET of the
    // constraint picker: it also exposes circle and arc centres. Borrowing the
    // constraint picker here would leave a centre unlit while a click on it
    // works perfectly, so this searches the list dimensions actually use.
    const tol = this.pickTol();
    let best: { x: number; y: number } | null = null;
    let bestD = tol * tol;
    for (const e of this.entities) {
      for (const { pos } of dimRefPoints(e)) {
        const dx = pos.x - p.x, dy = pos.y - p.y, d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { x: pos.x, y: pos.y }; }
      }
    }
    return best;
  }

  // --- selection delete (select tool) -----------------------------------
  /** Remove the selected entities, prune now-dangling constraints, then rebuild
   *  + re-solve via the shared modify tail. */
  private deleteSelected() {
    if (!this.selected.size) return;
    // the origin is not deletable: it is not the user's geometry, and losing it
    // mid-sketch would silently unanchor everything constrained to it
    this.entities = this.entities.filter((en) => !this.selected.has(en.id) || isOriginGeometry(en.id));
    this.selected.clear();
    dismissContextMenu(); // the Delete key can fire while the right-click menu is open
    this.afterModify();
  }

  /** Right-click in select mode: select the entity under the cursor (if any) and
   *  offer Delete. Leaves camera navigation alone when nothing is hit/selected. */
  /** Apply a constraint straight to an already-chosen selection.
   *
   *  Only reached for selections `applicableConstraints` vouched for, so every
   *  operand here is a whole entity that IS a line or a round — no rectangle
   *  edges to disambiguate. The constraint objects are the same shapes
   *  ConstraintTools builds; this is a second ENTRY POINT to them, not a second
   *  implementation of them. `moves` names the first-picked entity, matching the
   *  solver-bias convention the click tools already stamp. */
  private applyConstraintToSelection(t: SketchTool, sel: ResolvedEntity[]) {
    const a = sel[0], b = sel[1];
    if (!a) return;
    const moves = a.id;
    const push = (c: SketchConstraint) => {
      this.constraints.push(c);
      this.trialConstraint = c; // withdrawn again if this solve conflicts
      this.pendingBias = { moves: [moves] };
      this.requestSolve();
      this.onState?.();
    };
    if (t === "horizontal") return push({ type: "horizontal", line: a.id });
    if (t === "vertical") return push({ type: "vertical", line: a.id });
    if (!b) return;
    if (t === "parallel") return push({ type: "parallel", l1: a.id, l2: b.id });
    if (t === "perpendicular") return push({ type: "perpendicular", l1: a.id, l2: b.id });
    if (t === "collinear") return push({ type: "collinear", l1: a.id, l2: b.id });
    if (t === "concentric") return push({ type: "concentric", c1: a.id, c2: b.id });
    if (t === "equal") return push({ type: "equal", l1: a.id, l2: b.id });
    if (t === "tangent") {
      // the wire wants (line, circle) in that order whichever way round they were picked
      const line = a.type === "line" ? a : b;
      const round = a.type === "line" ? b : a;
      return push({ type: "tangent", line: line.id, circle: round.id });
    }
  }

  private onContextMenu(e: MouseEvent) {
    if (!this.active) return;
    // a right-DRAG panned the camera — don't turn its release into a menu
    const dragged = this.rightDragged;
    this.rightDownAt = null;
    this.rightDragged = false;
    if (dragged) return;
    if (this.tool === "dimension") { this.openDimensionMenu(e); return; }
    if (this.tool === "offset") { this.openOffsetMenu(e); return; }
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
    // Constraints that actually APPLY to this selection, first — GH #17's
    // "a small menu showing only the valid/possible constraints for that
    // selection". Offering them here is what makes them findable at all: the
    // constraint tools live behind a caret in a ribbon group that collapses into
    // an overflow menu on a laptop-width window, which is how two testers
    // independently failed to find them.
    const selEnts = this.entities.filter((e) => this.selected.has(e.id));
    const cons = applicableConstraints(selEnts);
    const items: CtxItem[] = [
      ...cons.map((t) => ({
        label: constraintLabel(t),
        onClick: () => this.applyConstraintToSelection(t, selEnts),
      })),
      ...(cons.length ? [{ separator: true, label: "" } as CtxItem] : []),
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

  /** Fusion's in-command marking menu for the Offset tool: the two things the
   *  cursor alone can't say — whether to take the whole connected chain, and
   *  which side to land on when the cursor is nowhere near the curve. */
  private openOffsetMenu(e: MouseEvent) {
    e.preventDefault();
    const pick = this.offsetPick;
    contextMenu(e.clientX, e.clientY, [
      {
        label: `${this.offsetChainMode ? "✓ " : "    "}Chain Selection`,
        onClick: () => {
          this.offsetChainMode = !this.offsetChainMode;
          setPrompt(this.offsetChainMode
            ? "Chain Selection on — the whole connected profile offsets as a unit"
            : "Chain Selection off — only the clicked curve offsets");
        },
      },
      {
        label: "Flip", disabled: !pick,
        onClick: () => { if (pick) pick.side = -pick.side; },
      },
      { separator: true, label: "" },
      { label: "OK", disabled: !pick, onClick: () => { if (pick) this.commitOffset(); } },
      { label: "Cancel", disabled: !pick, onClick: () => this.cancelOffset() },
    ]);
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
  /** Refuse a modify/transform gesture aimed at geometry the user does not own,
   *  and say which kind it is. Two kinds, deliberately one guard: every seam that
   *  must refuse one must refuse the other, and splitting them is how a seam ends
   *  up covering only half.
   *
   *  The origin case matters more than it looks. `pickEntity` already prefers
   *  real geometry, so an axis is only ever picked when nothing else is near —
   *  but trimming one would find no crossings (they are excluded as boundaries)
   *  and `trimEntity` deletes a curve with no usable crossing WHOLE. Without
   *  this, one stray click in empty space along y=0 would silently delete the X
   *  axis for the rest of the session. */
  private guardProjected(e: ResolvedEntity | undefined): boolean {
    if (isOriginGeometry(e?.id)) {
      toast("The sketch origin is fixed reference geometry — snap and constrain to it, but it can't be edited");
      return true;
    }
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
  /** Offset (Fusion parity), two-phase: click a curve, then move the cursor to
   *  choose the SIDE and distance — or type one — and click again (or Enter) to
   *  apply. `side` and `mag` are kept apart on purpose: the box displays the
   *  magnitude, so folding them into one signed number is how typing a value
   *  silently flips an inward offset outward (the abs-display trap). */
  private offsetPick: { idx: number; side: number; mag: number } | null = null;
  /** Fusion's in-command "Chain Selection" toggle, default ON: offset the whole
   *  connected chain rather than only the clicked curve. */
  private offsetChainMode = true;

  private offsetClick(p: THREE.Vector2) {
    if (this.offsetPick) { this.commitOffset(); return; } // second click applies
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0) return;
    const e = this.entities[idx];
    if (!e || this.guardProjected(e)) return;
    // Nothing may end in silence here: the user is mid-gesture, and a tool that
    // does nothing without saying why reads as broken.
    if (e.type === "text") { toast("Offset doesn't apply to sketch text"); return; }
    if (e.type === "point") { toast("Offset needs a curve, not a point"); return; }
    this.offsetPick = { idx, side: 1, mag: 0 };
    this.dim.show(
      [{ name: "offset", label: "Offset", kind: "length" }],
      () => this.commitOffset(),
      () => this.cancelOffset(),
    );
    setPrompt("Offset: move to pick the side, or type a distance · click / Enter to apply · Esc to cancel");
  }

  /** The offset result for the current pick, honouring Chain Selection. Chain
   *  first (a connected profile offsets as a unit), falling back to the single
   *  curve — which is also what a lone curve or a junction lands on. */
  private offsetResultFor(idx: number, dist: number): OffsetResult | null {
    if (Math.abs(dist) < 1e-6) return null;
    return (this.offsetChainMode ? offsetChain(this.entities, idx, dist) : null)
      ?? offsetEntity(this.entities, idx, dist);
  }

  /** Live side/distance + preview while the offset is being placed. */
  private offsetMove(ev: PointerEvent) {
    const pick = this.offsetPick;
    const p = this.planePoint(ev);
    const src = pick ? this.entities[pick.idx] : undefined;
    if (!pick || !src || !p) return;
    const signed = signedOffsetAt(src, p);
    const typed = this.dim.isUserDriven("offset") ? this.dim.getValue("offset") : null;
    if (typed !== null) {
      // Once a value is typed, the SIGN the user wrote owns the side — that is
      // what the minus is FOR, and the old tool worked that way. Previously the
      // cursor always won, so typing -1 silently offset outward and the minus
      // looked ignored. Clear the field to hand the side back to the cursor.
      pick.mag = Math.abs(typed);
      if (typed !== 0) pick.side = typed < 0 ? -1 : 1;
    } else if (signed !== null) {
      if (Math.abs(signed) > 1e-6) pick.side = signed < 0 ? -1 : 1;
      pick.mag = Math.abs(signed);
      this.dim.updateFromCursor({ offset: pick.mag });
    }
    this.dim.position(ev.clientX, ev.clientY);
    const res = this.offsetResultFor(pick.idx, pick.side * pick.mag);
    const added = res ? res.entities.slice(this.entities.length) : [];
    // keep the source highlighted so it stays obvious what is being offset
    const preview = [...curveObjects([src], this.plane, 0x33aaff, true)];
    if (added.length) preview.push(...curveObjects(added, this.plane, PREVIEW_COLOR, true));
    this.overlay.setPreview(preview);
  }

  private commitOffset() {
    const pick = this.offsetPick;
    if (!pick) return;
    // An empty box CANCELS. It used to fall back to `?? 1`, so pressing Enter on
    // an untouched field silently produced a 1 mm offset nobody asked for.
    if (this.dim.isUserDriven("offset")) {
      const typed = this.dim.getValue("offset");
      if (typed === null) { toast("Offset: type a distance, or Esc to cancel"); return; }
      // same rule as the live preview: a typed sign is the side (see offsetMove)
      pick.mag = Math.abs(typed);
      if (typed !== 0) pick.side = typed < 0 ? -1 : 1;
    }
    if (pick.mag < 1e-6) { toast("Offset: type a distance, or Esc to cancel"); return; }
    const res = this.offsetResultFor(pick.idx, pick.side * pick.mag);
    this.offsetPick = null;
    this.dim.hide();
    if (!res) {
      toast("Offset: that distance collapses the geometry");
      this.overlay.setPreview([]);
      return;
    }
    this.entities = res.entities;
    if (res.linked && res.pairs.length) {
      // the associative link + its single editable dimension
      this.setDrivingDimension({ type: "offset", pairs: res.pairs, value: pick.side * pick.mag });
    } else if (!res.linked) {
      toast("Offset copy created — not linked to the source (this shape type is rigid)");
    }
    this.afterModify();
  }

  private cancelOffset() {
    this.offsetPick = null;
    this.dim.hide();
    this.overlay.setPreview([]);
    setPrompt("Offset: click a curve to offset");
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
          ? hit.edge.body
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
        const pts = hit.edge.points;
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
    // Entities that own an addressable endpoint (line/arc/spline/point;
    // projected line/arc/poly), which coincident/midpoint/symmetric name.
    // RECTANGLES are in this set as of 2026-08-17: their four corners became
    // pickable points (constraintTools.pickEndpoint) and endpointPoint resolves
    // them, so leaving them out would have every rect-corner coincident survive
    // its own solve and then be silently deleted by the next trim/fillet/delete
    // — the constraint would work until the user touched anything else.
    const endIds = ids(
      (e) =>
        e.type === "line" || e.type === "arc" || e.type === "spline" || e.type === "point" ||
        e.type === "rectangle" ||
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
    // A CURVE operand (tangent2's two picks) is any line/circle/arc — and a rect
    // edge is a line, so it has to decode too or the tangent the edge picker now
    // emits would be deleted by the next unrelated edit.
    const hasCurveOperand = (id: string) => curveIds.has(id) || hasLineOperand(id);
    // A POINT operand (coincident/midpoint/symmetric). A rectangle corner is
    // spelled `<rectId>` + corner index 0..3 — the form the pickers emit and the
    // one the document defines — but `<rectId>~<k>` p0/p1 reaches the same
    // corner through the edge registration in sketchSolve, and a saved file or
    // the agent-control API can carry it. Accept both here: deleting a
    // constraint the solver honours is the silent-drop failure again, one layer
    // up.
    const hasPointOperand = (id: string) => endIds.has(id) || hasLineOperand(id);
    this.constraints = this.constraints.filter((c) => {
      switch (c.type) {
        case "horizontal": case "vertical": case "distance": return hasLineOperand(c.line);
        case "parallel": case "perpendicular": case "equal": case "collinear": case "angle":
          return hasLineOperand(c.l1) && hasLineOperand(c.l2);
        case "diameter": return roundIds.has(c.circle);
        case "tangent": return hasLineOperand(c.line) && circleIds.has(c.circle);
        case "tangent2": return hasCurveOperand(c.a) && hasCurveOperand(c.b);
        case "equalRadius": return roundIds.has(c.a) && roundIds.has(c.b);
        case "coincident": return hasPointOperand(c.e1) && hasPointOperand(c.e2);
        case "concentric": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "midpoint": return hasPointOperand(c.e) && hasLineOperand(c.line);
        case "symmetric": return hasPointOperand(c.e1) && hasPointOperand(c.e2) && hasLineOperand(c.line);
        case "radius": return roundIds.has(c.e);
        case "p2pDistance": return refIds.has(c.e1) && refIds.has(c.e2);
        case "p2pDistanceX":
        case "p2pDistanceY": return refIds.has(c.e1) && refIds.has(c.e2);
        case "p2lDistance": return refIds.has(c.e) && hasLineOperand(c.line);
        // rim (edge-to-edge) dims — a round operand is a circle OR an arc
        case "radialGap": return roundIds.has(c.inner) && roundIds.has(c.outer);
        case "c2cDistance": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "c2lDistance": return roundIds.has(c.circle) && hasLineOperand(c.line);
        case "p2cDistance": return refIds.has(c.e) && roundIds.has(c.circle);
        case "fix": return refIds.has(c.e);
        // offset: a composite over N source→copy pairs. Deleting ONE copy must
        // break only that member's link (Fusion behavior) — so SHRINK the pair
        // list the way prunePatterns shrinks sources, and drop the whole
        // constraint (with its dimension) only when nothing is left to govern.
        case "offset": {
          c.pairs = c.pairs.filter(
            (pr) =>
              (hasLineOperand(pr.src) && hasLineOperand(pr.cpy)) ||
              (roundIds.has(pr.src) && roundIds.has(pr.cpy)),
          );
          return c.pairs.length > 0;
        }
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

  // --- in-sketch undo -------------------------------------------------------

  private snapshot(): SketchSnapshot {
    return cloneSnapshot({
      entities: this.entities,
      constraints: this.constraints,
      patterns: this.patterns,
    });
  }

  private restore(s: SketchSnapshot) {
    const c = cloneSnapshot(s);
    this.entities = c.entities;
    this.constraints = c.constraints;
    this.patterns = c.patterns;
  }

  /** Re-arm the history baseline. Called when the state SETTLES after a solve,
   *  and by the derived paths to make their own changes invisible to
   *  bankIfChanged. */
  private armPreEdit() {
    if (this.active) this.history.arm(this.snapshot());
  }

  /** Bank one undo step if the sketch changed since the last settled snapshot.
   *
   *  Called from requestSolve() ON PURPOSE. Every user mutation ends there —
   *  draw, trim, fillet, offset, delete, dimension, constraint, text, pattern,
   *  15+ call sites — and hand-listing them is exactly how an undo feature ends
   *  up silently missing one. The three things that must NOT be undoable are
   *  excluded structurally rather than by a denylist:
   *
   *   - The SOLVER's write-back assigns inside pump() and loops; it never calls
   *     requestSolve. So "the solver moved my geometry to satisfy a constraint"
   *     can never consume an undo step.
   *   - DERIVED updates (parameter sync, projection refresh) re-arm the baseline
   *     before calling requestSolve, so they compare equal.
   *   - DRAGS never reach here at all: queueDrag pumps directly, and endDrag
   *     banks the pre-drag snapshot as ONE step. */
  private bankIfChanged() {
    if (!this.active) return;
    // Notify only when a step was ACTUALLY banked. requestSolve is on every
    // mutation path, but it does not itself call onState — most of its ~20 call
    // sites happen to do so afterwards and some do not, which left the undo
    // BUTTON's enabled state depending on which gesture you used. Gating on the
    // return value makes the signal exact and costs nothing on the common case
    // where nothing changed (a solve settling, a re-armed derived update).
    if (this.history.bankIfChanged(this.snapshot())) this.onState?.();
  }

  /** Commit a finished drag as a single undo step. The pre-drag entities were
   *  already deep-cloned into dragSnapshot for Esc-revert, so that same clone is
   *  the undo entry — a drag never touches constraints or patterns, so the
   *  current ones complete the snapshot. */
  private bankDrag() {
    const before = this.dragSnapshot;
    this.dragSnapshot = null; // committed — drop the revert buffer
    if (!before || !this.active) return;
    const banked = this.history.bankBefore(
      { entities: before, constraints: this.constraints, patterns: this.patterns },
      this.snapshot(),
    );
    if (banked) this.onState?.(); // the undo button just became live — see bankIfChanged
  }

  get canUndoSketch(): boolean { return this.history.canUndo; }
  get canRedoSketch(): boolean { return this.history.canRedo; }

  /** Undo the last edit INSIDE the sketch. Returns true when it handled the
   *  request — which is whenever a sketch is open, even with an empty stack:
   *  falling through to the document undo is precisely the old behaviour that
   *  vaporised the whole sketch. */
  undoEdit(): boolean {
    if (!this.active) return false;
    const prev = this.history.undo(this.snapshot());
    if (!prev) { setPrompt("Nothing left to undo in this sketch"); return true; }
    this.applyHistory(prev);
    return true;
  }

  redoEdit(): boolean {
    if (!this.active) return false;
    const next = this.history.redo(this.snapshot());
    if (!next) { setPrompt("Nothing to redo in this sketch"); return true; }
    this.applyHistory(next);
    return true;
  }

  /** Restore a history state and settle. Any half-finished tool gesture is
   *  dropped: its indices refer to the geometry we just replaced. */
  private applyHistory(s: SketchSnapshot) {
    this.restore(s);
    this.selected.clear();
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.filletFirst = null;
    this.splinePts = [];
    this.clickPts = [];
    this.offsetPick = null;
    this.dim.hide();
    this.overlay.setPreview([]);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  /** Mark the sketch dirty and kick the solve pump. Coalesces many requests
   *  into one in-flight solve so the (single, shared) WASM wrapper is never
   *  re-entered, and stale results never clobber newer geometry. */
  private requestSolve() {
    this.bankIfChanged();
    this.solveDirty = true;
    void this.pump();
  }

  /** The one and only path that touches the solver. Serializes drag solves and
   *  constraint/dimension solves through a single in-flight lock. */
  private async pump() {
    if (this.solveBusy || this.solverDead) return;
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
            // Nothing moved: keep the anchor where the grabbed point still is.
            // Advancing dragFrom to the cursor would re-run the nearest-point
            // search from a drifted origin and capture an unrelated FREE point
            // mid-gesture (yanking it to the cursor on release).
            //
            // "geometry" is the guard refusing the solve itself (a collapsed
            // line, a mirrored rectangle). It blames no constraint, so
            // r.conflicts is empty and nothing above paints a red chip — without
            // a word here the drag would just stop dead with no explanation.
            if (!this.dragRefusedToast) {
              this.dragRefusedToast = true;
              toast(r.dragRefused === "projected" ? PROJECTED_FIXED_MSG
                : r.dragRefused === "geometry" ? "That move would flatten or flip constrained geometry, so it was not applied"
                : "That point is fixed — delete its Fix constraint to move it");
            }
          } else if (this.dragFrom) {
            this.dragFrom.set(d.toX, d.toY); // track grabbed pt
          }
          this.refreshDragGeometry(); // curves only; dims/candidates rebuilt on endDrag
        } else {
          this.solveDirty = false;
          // Consume the "what you picked moves" bias here and nowhere else. A
          // DRAG frame must never see it (it has its own pin, and the two would
          // fight); a plain re-solve must never see it (it belongs to the one
          // gesture that armed it).
          const bias = this.pendingBias;
          this.pendingBias = null;
          if (this.constraints.length === 0) { this.lastDof = -1; this.conflict = false; continue; }
          const ver = this.entityVersion;
          const r = await compileAndSolve(this.entities, this.constraints, undefined, bias ?? undefined);
          if (!this.active) break;
          // geometry changed mid-solve (a draw committed): discard, re-solve.
          // Re-arm the bias with it — this result never reached the document, so
          // the gesture that armed it has still not had its one biased solve.
          // `??=`, not `=`: a newer gesture may have armed its own while we were
          // awaiting, and that one is the more recent intent.
          if (this.entityVersion !== ver) { this.pendingBias ??= bias; this.solveDirty = true; continue; }
          this.conflict = r.conflicts.length > 0;
          // A constraint that cannot be satisfied must not stay in the sketch.
          // Keeping it leaves the whole system unsolvable, so every LATER
          // constraint silently does nothing and the tools look broken.
          if (this.trialConstraint && (this.conflict || !r.ok)) {
            const i = this.constraints.lastIndexOf(this.trialConstraint);
            if (i >= 0) this.constraints.splice(i, 1);
            this.trialConstraint = null;
            toast("That constraint conflicts with the ones already on this sketch, so it was not applied.");
            this.solveDirty = true; // re-solve without it, back to the last good state
            continue;
          }
          this.trialConstraint = null;
          this.conflictIdx = parseConflictIdx(r.conflicts);
          this.overIdx = parseConflictIdx(r.overDefined);
          if (!this.conflict) this.entities = r.entities; // keep last good on conflict
          this.lastDof = r.dof;
          this.refreshActive();
        }
      }
    } catch (err) {
      // The solver's WASM never came up (seen in the field on a WebView2 that
      // refuses to compile it). Without this, the rejection escapes `void
      // this.pump()` into the global net and toasts a nameless "Something went
      // wrong" on EVERY stroke. Say what is actually unavailable, once, and
      // stop asking — the geometry is still perfectly usable unconstrained.
      console.error("sketch solve failed:", err);
      this.solverDead = true;
      this.lastDof = -1;
      this.conflict = false;
      if (!this.solverDeadToast) {
        this.solverDeadToast = true;
        toast(
          err instanceof SolverUnavailable
            ? err.message
            : "The 2D constraint solver stopped responding — sketching continues without constraints",
          { kind: "error", timeout: 12000 },
        );
      }
      // The dimension that was in flight when the solver died still has to
      // land, or the very first one a user types is the one that vanishes.
      this.applyDrivingDimsDirectly();
      this.refreshActive();
    } finally {
      this.solveBusy = false;
    }
    // Settled: re-arm the pre-mutation snapshot so the NEXT edit is diffed
    // against post-solve geometry. Without this, a later no-op requestSolve
    // would see the solver's own movement and bank a phantom undo step.
    if (!this.dragFrom && !this.moveDrag) this.armPreEdit();
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
      // The origin offers NO drag handles. It is pinned, so a drag started on it
      // is refused by the solver and nothing happens — but starting one still
      // consumes the click, so the origin could not be SELECTED either. Reported
      // as "it highlights but I can't select it": the click was being spent on a
      // drag that could never move.
      if (isOriginGeometry(e.id)) return;
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

  /** The marquee rectangle as preview geometry. A WINDOW box (drag rightwards)
   *  is drawn solid and a CROSSING box dashed, which is how mainstream CAD tells
   *  you which of the two you are about to get — the direction alone is
   *  invisible once you have started moving. */
  private boxPreview(): THREE.Object3D[] {
    const b = this.boxSel;
    if (!b) return [];
    const { min, max, mode } = boxFromDrag(b.from, b.to);
    const c = [
      this.plane.to3D(min.x, min.y), this.plane.to3D(max.x, min.y),
      this.plane.to3D(max.x, max.y), this.plane.to3D(min.x, max.y),
      this.plane.to3D(min.x, min.y),
    ];
    return [mode === "crossing" ? dashedPolyline(c, SELECT_COLOR) : polyline(c, SELECT_COLOR)];
  }

  /** Finish a marquee: select what it covers, or clear when it covers nothing. */
  private applyBoxSel() {
    const b = this.boxSel;
    this.boxSel = null;
    this.overlay.setPreview([]);
    if (!b) return;
    const moved = b.from.distanceTo(b.to) > this.pickTol() * 0.5;
    if (!moved) {
      // a plain click in empty space — the old clear-everything behaviour
      if (!b.shift) { this.selected.clear(); this.overlay.clearRegionSelection(); }
      this.refreshActive();
      return;
    }
    // Origin geometry is reference, never a selection target: a marquee over the
    // whole sketch would otherwise always drag the axes in with it.
    const hits = entitiesInBox(
      this.entities.filter((e) => !isOriginGeometry(e.id)),
      boxFromDrag(b.from, b.to),
    );
    if (!b.shift) this.selected.clear();
    for (const id of hits) this.selected.add(id);
    this.refreshActive();
    this.onState?.();
  }

  private endDrag(pointerId?: number) {
    if (this.boxSel) {
      if (pointerId != null) {
        try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
      }
      this.applyBoxSel();
      return;
    }
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
      this.bankDrag(); // the whole move is ONE undo step, not one per frame
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
    this.bankDrag(); // the whole drag is ONE undo step, not one per frame
    this.refreshActive(); // restore snap candidates + dimension labels at final positions
    this.onState?.();
  }

  /** remaining degrees of freedom (>0 under-constrained, 0 fully constrained) */
  /** Sketch > Check: what is wrong with this profile, before it has to become a
   *  solid. A tester asked for this after finding that an open contour shows up
   *  only as an extrude that silently finds no region to pull.
   *
   *  Clicking a row SELECTS the entities the issue names, which is the durable
   *  half — refreshActive paints a selection in SELECT_COLOR and it survives
   *  the next pointer move. The marker is deliberately the throwaway half: it
   *  rides on setPreview, so onMove wipes it as soon as the pointer returns to
   *  the canvas, which is the right lifetime for "look here".
   *
   *  The panel is a SNAPSHOT. Nothing re-runs it, so an edit can leave rows
   *  naming entities that are gone; onSelect below tolerates unknown ids rather
   *  than assuming the sketch still matches. */
  runCheck() {
    showCheckPanel(checkSketch(this.entities), {
      onSelect: (ids, at) => {
        this.selected = new Set(ids.filter((id) => this.entities.some((e) => e.id === id)));
        const p = this.plane.to3D(at.x, at.y);
        this.overlay.setPreview([
          pointHighlight(this.plane, at.x, at.y, SELECT_COLOR, this.viewport.pixelWorldSize(p) * 6),
        ]);
        this.refreshActive();
        this.viewport.requestRender();
      },
      onClose: () => {
        this.overlay.setPreview([]);
        this.viewport.requestRender();
      },
    });
  }

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
  /** Rescale the sketch grid to the current zoom, and recentre it on the view.
   *
   *  Called from the viewport's render loop (`onZoomScale`), so it is keyed and
   *  returns immediately when neither the cell nor the centre has changed.
   *
   *  The grid used to be a single `GridHelper(400, 80)` built once on entry:
   *  5 mm cells over a 400 mm square, fixed. Zoom out past 400 mm and it simply
   *  ran out; zoom in to draw a 2 mm feature and the cells were still 5 mm, so
   *  the finest thing you could snap to was 5 mm no matter how close you got.
   *  It also made grid snapping wildly inconsistent: `snap()` only takes a grid
   *  point within 10 px of the cursor, so at high zoom the 5 mm points were too
   *  far apart to ever catch and at low zoom they were sub-pixel dense and
   *  caught everything.
   *
   *  `niceStep(worldPerPixel * 64)` is the SAME expression the ground grid uses
   *  (viewport/scene.ts), deliberately: the two grids have to agree about what
   *  "5 mm" looks like or the lattice appears to jump when you finish a sketch.
   *  DIVISIONS stay fixed and the extent follows the cell, which is what keeps
   *  the line count bounded — an adaptive cell over a fixed 400 mm extent would
   *  be 4,000 divisions at 0.1 mm. */
  private updateGridScale(worldPerPixel: number, tx: number, ty: number, tz: number) {
    if (!this.active) return;
    const local = this.plane.to2D(new THREE.Vector3(tx, ty, tz));
    const { cell, cx, cy, key } = gridScaleFor(worldPerPixel, local.x, local.y);
    if (key === this.gridKey) return;
    this.gridKey = key;
    this.gridCell = cell;
    this.addGrid(cell, cx, cy);
  }

  private addGrid(cell = this.gridCell, cx = 0, cy = 0) {
    this.removeGrid();
    const DIVS = 80;
    const grid = new THREE.GridHelper(cell * DIVS, DIVS, 0x44505c, 0x2c333a);
    // GridHelper lies in XZ; orient it onto the sketch plane (XY local)
    grid.quaternion.copy(this.plane.orientation()).multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
    );
    grid.position.copy(this.plane.to3D(cx, cy));
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
