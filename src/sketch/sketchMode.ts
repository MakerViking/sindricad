// The modal sketch environment: enter on a plane (camera squares to it, model
// dims, grid appears), draw Line/Rectangle/Circle interactively with snapping
// and on-canvas dimension input, then Finish to commit the sketch feature.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { EdgeFingerprint, ExtrudeRef, Feature, ParamTarget, PlaceOffset, PlaneSpec, ProjectedSource, ProjectionUpdate, Selector, SketchConstraint, SketchEntity, SketchPattern } from "../types";
import { applyProjectionUpdate, dimPlaceOf, isBadgeEntity, isDriven, isPlacedDim } from "../types";
import { SketchPlane } from "./plane";
import { SketchOverlay, curveObjects, dimensionLineObjects, pointHighlight, polyline, dashedPolyline, CURVE_COLOR, ENDPOINT_COLOR, PREVIEW_COLOR, SELECT_COLOR } from "./overlay";
import { DimInput, type DimFieldDef } from "./dimInput";
import { TextPanel } from "./textPanel";
import type { TextValues } from "./textPanel";
import { aboutTheText, fetchFonts, forgetText, textFailure, textFailureText, textPlaceholder } from "./textCache";
import { isEditableTarget } from "../ui/focus";
import { SketchDimensions, dimBadgeFields, type ExtraDim } from "./sketchDimensions";
import { SketchGlyphs } from "./sketchGlyphs";
import { constraintGlyphs, diagnosisOf, type ConstraintGlyph } from "./glyphs";
import { entityDims, constraintDims, dimRefPoints, curveKind, hoverOperandCurve, lineOperand, lineOperandAt, linearDim, operandPoint, rebindPolygonSides, refPoint, refPointNear, setDimPixelScale, RECT_CENTRE, shapeSideAt, slotAxisAt, staggeredDefaults, type DimField, type ConstraintDim } from "./entityDims";
import {
  clampPlace, isDimError, isRoundTarget, pickDimTarget, rebindTarget, resolveDim, targetIdentity,
  targetKey, unsupportedMessage,
  type DimOptions, type DimPlan, type DimTarget,
} from "./dimensionTool";
import { pickEntity, pointBeatsCurve, tangencyPoints, trimSpan, trimWithConstraints, detachEndpoint, detachableEnd, isBreakCut, filletCorner, chamferCorner, cornerJoins, explodeCompound, polygonRingHolds, rotationTie, translationTie, offsetEntity, offsetChain, offsetChainJunction, signedOffsetAt, followOffsets, followRefusal, breakWithConstraints, joinLines, extendLine, breakLink, attachmentPoints, bodyDragBlocked, bodyDragFrame, fixPinnedIds, pickDragPoint, FIXED_POINT_MSG, PROJECTED_FIXED_MSG, type ExplodeResult, type OffsetResult, type TrimResult } from "./modify";
import { newEntityId, newConstraintId, isDimConstraint, notePatternId } from "./id";
import { SketchHistory, cloneSnapshot, type SketchSnapshot } from "./history";
import { isPlainNumber, parseField, dimValueOk, fmtLength, fieldText, canonicalDecimal, fieldExpr } from "../ui/units";
import { splitNameValue } from "../params/engine";
import { RIGID_ENTITY_NUM_FIELDS, coerceForField, type FieldKind } from "../document/numFields";
import type { RegionCarry, SketchBinding } from "../document/store";
import { composePointCarry, polygonSidesCarry, type PointCarry } from "../document/pointCarry";
import { advanceCenterArcSweep, centerArcEntity, circumcenter } from "./arc";
import { coincKey, compileAndSolve, constraintIndexOf, soleDimEntity, MAX_BIAS_ANCHORS } from "./sketchSolve";
import { SolverUnavailable } from "./solver";
import { p2lSideFlipped, refreshStep, refreshSteps } from "../document/projectionWalk";
import { resolveRealEntities, toSketchEntity } from "./resolve";
import { applyDrivingDimsDirect, governingDimAt, lockDimFor, measuredLocks, planDimEdit } from "./directDims";
import { dimConflictMsg, withdrawTrial, type SketchTrial } from "./dimConflict";
import { expandPattern, translated, rotated, scaled } from "./pattern";
import { candidatesFromEntities, snap, snapCoincidences, type SnapKind, type SnapCandidate, type PointRef } from "./snap";
import type { ResolvedEntity } from "./snap";
import {
  curvesEndingAt, inferArcTangents, inferLineRelations, isGeometrySnap, relationConstraints,
  type ArcPoints, type LineInference,
} from "./autoConstrain";
import { detectRegions, entityPolyline, EPS, pointInLoop, resolveRegionRef, sameRegionIds, twinRegion, type Region } from "./region";
import { splineFlags } from "./spline";
import { worldPointInRegion } from "./regionSelect";
import { setSpaceMouseOrbitLocked } from "../input/spacemouse";
import { stepDoublePress, type PressRecord } from "../input/doublePress";
import { keyHint } from "../input/shortcuts";
import { CHIP_BOTTOM, CHIP_LEFT } from "../ui/toolCursor";
import { setPrompt } from "../ui/prompt";
import { t } from "../i18n";
import { toast } from "../ui/toast";
import { contextMenu, dismissContextMenu, type CtxItem } from "../ui/menu";
import { niceStep } from "../ui/units";
import { isOriginGeometry, originGeometry } from "./origin";
import { boxFromDrag, entitiesInBox } from "./boxSelect";
import { applicableConstraints, constraintLabel, menuOperands, operandUnder, symmetricOperands, type MenuOperand } from "./constraintMenu";
import { addKey, additiveClick, clickKey, dropOwner, pointKey, selOwner, selOwners, selPart } from "./selection";
import { ConstraintTools, CONSTRAINT_TOOLS, splineTangentFor, type ConstraintHost } from "./constraintTools";
import { PatternFlow, PATTERN_TOOLS, ENTITY_PATTERNS, type PatternHost } from "./patternFlow";
import { ProjectPanel } from "./projectPanel";
import { checkSketch } from "./check";
import { showCheckPanel, hideCheckPanel } from "./checkPanel";
import { CONFLICT, EDGE_HOVER, SKETCH_POINT_HOVER } from "../viewport/colors3d";

/** The id a not-yet-drawn entity carries while its constraint badges are
 *  previewed: no entity id ever takes this form (newEntityId). */
const PENDING_ID = "pending:draw";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "centerRectangle"
  | "circle"
  | "circle2"
  | "circle3"
  | "arc"
  | "arcCenter"
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
  | "join"
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
  | "lockDimension"
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
  "join",
  "mirror",
  "dimension",
  "lockDimension",
  ...CONSTRAINT_TOOLS,
]);

const GRID_STEP = 5;

/** A spline closes round on its first point only with this many points placed:
 *  two would make a closed curve with no area, there and back along itself. */
const MIN_CLOSED_SPLINE_POINTS = 3;

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

/** The polygon fields its edit box offers, in box order (see editPolygon). */
type PolygonEditField = "radius" | "sides" | "angle";
const POLYGON_EDIT_FIELDS: [PolygonEditField, FieldKind][] = [["radius", "length"], ["sides", "count"], ["angle", "angle"]];

/** A polygon side count the tool can build: 3 to 64 once rounded (the entity
 *  caps at 64). One rule for the commit guard, the live preview and the edit
 *  box, so none of them can accept a count another refuses. */
function sideCountOk(n: number | null): n is number {
  return n != null && Number.isFinite(n) && Math.round(n) >= 3 && Math.round(n) <= 64;
}

/** Typed dimension text as the expression the sketch STORES for it: what the
 *  user meant, spelled so the parameters engine evaluates it the same on every
 *  rebuild (ui/units.fieldExpr). In inches `1/16` was a sixteenth of a
 *  MILLIMETRE, because the engine reads a bare literal in mm, and `1/16 in` was
 *  1/(16 in). A `name=` prefix is kept; text that does not parse goes through
 *  untouched, so the engine's own message is the one shown. */
function storedDimExpr(raw: string, kind: FieldKind): string {
  const nv = splitNameValue(raw);
  const expr = fieldExpr(nv ? nv.expr : raw, kind);
  if (expr === null) return raw;
  return nv ? `${nv.name}=${expr}` : expr;
}

/** One Fillet/Chamfer pick: the entity, and for a rectangle or polygon the
 *  SIDE it took (`<id>~k`), which becomes a line when the tool runs. */
type CornerPick = { idx: number; side: string | null };

/** The shapes that are one entity but drawn as several curves, and so can be
 *  exploded into them (modify.explodeCompound). */
const isCompoundShape = (e: ResolvedEntity) =>
  e.type === "rectangle" || e.type === "polygon" || e.type === "slot";

// Tools that operate on the current multi-selection, so setTool must keep it.
const KEEPS_SELECTION = new Set<SketchTool>(["mirror", "move", "copy", "rotate", "scale"]);
/** The tools that move the selection about a point the user clicks. Armed with
 *  nothing selected, they take clicks AS the selection first (see
 *  SketchMode.choosingTargets). */
const TRANSFORM_TOOLS = new Set<SketchTool>(["move", "copy", "rotate", "scale"]);
/** Each transform tool's prompt while it is choosing, and what it says when it
 *  arms with nothing selected. */
const CHOOSING_PROMPT: Partial<Record<SketchTool, string>> = {
  move: "sketch.prompt.moveChoose",
  copy: "sketch.prompt.copyChoose",
  rotate: "sketch.prompt.rotateChoose",
  scale: "sketch.prompt.scaleChoose",
};
const NOTHING_SELECTED: Partial<Record<SketchTool, string>> = {
  move: "sketch.transform.selectFirstMove",
  copy: "sketch.transform.selectFirstCopy",
  rotate: "sketch.transform.selectFirstRotate",
  scale: "sketch.transform.selectFirstScale",
};

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

/** Text failures already announced in a toast, by entity id and message, so a
 *  repaint does not repeat one, and neither does dragging the text (every frame
 *  of a drag is a new request, and each one is refused again). */
const announcedTextFailures = new Set<string>();
/** The toast each text's failure is showing, by entity id, so reopening the text
 *  can take it down: the panel says the same thing, and the toast sits where the
 *  panel's Add button often lands (both near the bottom middle of the window). */
const textFailureToasts = new Map<string, () => void>();

/** Did the user actually draw anything in this snapshot? Reads the SERIALISED
 *  feature, where the synthetic origin geometry has already been stripped —
 *  counting `SketchMode.entities` instead is what made the old empty-sketch
 *  guard dead, because entering a sketch injects three entities of its own. */
function hasDrawnContent(f: Feature | null): boolean {
  return !!f && f.type === "sketch" && (f.entities.length > 0 || (f.patterns?.length ?? 0) > 0);
}

export class SketchMode {
  active = false;
  tool: SketchTool = "select";
  onState: (() => void) | null = null; // notify UI (tool/active changed)
  /** What the palette's Construction box should show changed: see
   *  constructionShown(). Fired from refreshActive, which every selection change
   *  and every edit ends in (it is what paints the selection). */
  onConstructionShown: ((on: boolean, mixed: boolean) => void) | null = null;

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
  /** The solver point the current base / last cursor was SNAPPED ONTO, when
   *  there is one. Snapping used to copy the coordinate and stop, so a join
   *  survived only until the next solve moved either side (field ecc3e0d6).
   *  Carried here so commitFromCursor can emit a real coincident constraint. */
  private baseRef: PointRef | null = null;
  private lastSnapRef: PointRef | null = null;
  /** the constraints the next click would add, drawn muted (field report 636afdcb) */
  private pendingGlyphs: ConstraintGlyph[] | null = null;
  private arcStart: THREE.Vector2 | null = null; // 3-point arc: start, end, then bulge
  private arcEnd: THREE.Vector2 | null = null;
  /** what the arc's first and second clicks were SNAPPED ONTO, captured at the
   *  click because pointer MOVES overwrite lastSnapRef between them.
   *
   *  Deliberately not cleared alongside arcStart/arcEnd at the four cancel sites:
   *  a commit requires both points to be set, and each is set together with its
   *  ref by this arc's own clicks, so a stale ref can never be read.
   *
   *  The centre-point arc uses arcStartRef for its START click and arcCenterRef
   *  for its centre click, each set together with its `clickPts` entry, for the
   *  same reason. */
  private arcStartRef: PointRef | null = null;
  private arcEndRef: PointRef | null = null;
  private arcCenterRef: PointRef | null = null;
  /** what a centre rectangle's first click, its CENTRE, was snapped onto: set
   *  with its `clickPts` entry, for the same reason as the arc's */
  private rectCenterRef: PointRef | null = null;
  private splinePts: THREE.Vector2[] = []; // in-progress spline fit points
  private clickPts: THREE.Vector2[] = []; // accumulated clicks for multi-point primitives (polygon/slot/circle variants, centre arc)
  /** centre-point arc: the running signed sweep (radians) from the start, kept
   *  as the cursor moves so the arc follows it the long way round (arc.ts) */
  private arcSweep = 0;
  private polygonSides = 6; // n for the polygon tool
  private filletFirst: number | null = null; // first line picked for a sketch fillet
  /** Which SIDE of a rectangle or polygon the first Fillet/Chamfer pick took
   *  (`<id>~k`), or null for a plain line. Read only beside filletFirst. */
  private filletSide: string | null = null;
  /** world position of the endpoint a constraint flow is holding, if any */
  private pendingConstraintPoint: THREE.Vector3 | null = null;
  /** What a withdrawn trial says when the tool has nothing more specific. */
  private static readonly CONSTRAINT_CONFLICT_MSG = t("sketch.constraint.conflict");
  /** The constraints just added by a tool, on trial until their solve comes
   *  back: withdrawn together if it conflicts, with `msg` said once. A LIST
   *  because the fillet adds three (two tangencies and a radius) that only mean
   *  anything as a set — half a fillet's definition is worse than none.
   *  See dimConflict.SketchTrial for `restore` and the callable `msg`, which a
   *  DIMENSION edit needs and a constraint tool does not. */
  private trial: SketchTrial | null = null;
  /** The entities the NEXT non-drag solve is allowed to move — "what you picked
   *  first is what moves" (bug #86, see sketchSolve's `bias`). Armed by the tool
   *  that knows the pick order and consumed by exactly one solve in pump().
   *
   *  Deliberately NOT persisted with the constraint, and deliberately not
   *  reachable from headlessSolve: pick order belongs to the gesture, not to the
   *  document, so no saved sketch changes how it solves because of this. */
  private pendingBias: { moves: string[] } | null = null;
  /** The select tool's selection, as selection KEYS (selection.ts): whole
   *  entities, and single points (`e3@4`) and shape sides (`e3~2`) of them
   *  (GH #17). Insertion order is pick order. Whatever acts on GEOMETRY reads
   *  the entities the keys belong to (selOwners). */
  private selected = new Set<string>();
  private constraints: SketchConstraint[] = []; // persistent constraints (solved)
  private patterns: SketchPattern[] = []; // associative pattern definitions
  private lastDof = -1;
  /** Marquee (box) selection in progress — GH #17. Started on a press in empty
   *  space with the select tool, so it can never steal a gesture that had a
   *  target: every branch that finds something under the cursor returns first.
   *  `additive` here, on moveDrag and in `dragAdditive`: the press ADDS to the
   *  selection (Shift, Ctrl or Cmd held) instead of replacing it. */
  private boxSel: { from: THREE.Vector2; to: THREE.Vector2; additive: boolean } | null = null;
  private dragFrom: THREE.Vector2 | null = null; // grabbed point's current position
  // click-vs-drag bookkeeping for a grabbed POINT: where the pointer went down
  // (screen px), and whether it ever moved past the same 4px threshold
  // moveDrag uses. A stationary click on a vertex must still SELECT, instead
  // of silently doing nothing: since GH #17 it selects the POINT (`dragKey`,
  // selKeyAt), not the entity owning it.
  private dragStartClient = { x: 0, y: 0 };
  private dragMoved = false;
  private dragAdditive = false;
  private dragKey: string | null = null;
  /** for the second press of a double-click: the entity it takes whole if it
   *  does not move (takeWhole); null for any other press */
  private dragWhole: string | null = null;
  /** the point or side the Select hover has lit (selectHover), or null */
  private selHoverKey: string | null = null;
  /** Set for a press that may PULL APART a shared end (Shift, or a right-click
   *  Disconnect armed on that point): where the press landed, which names the
   *  curve whose end leaves. Spent on the first frame that moves. */
  private dragDetach: THREE.Vector2 | null = null;
  /** The shared point a right-click Disconnect armed (its coincKey bucket);
   *  the next press on it pulls an end away without Shift. */
  private detachArmed: string | null = null;
  /** this press was armed by Disconnect, so the pull also releases the
   *  Coincidents on the end that leaves (detachEndpoint's `release`) */
  private dragDetachRelease = false;
  private dragSnapshot: ResolvedEntity[] | null = null; // entities at drag start (Esc reverts)
  /** the constraints before a Disconnect pull released some: Esc puts them
   *  back, and the drag's undo step holds them (bankDrag). Null for every
   *  other drag, which never touches constraints. */
  private dragConsBefore: SketchConstraint[] | null = null;

  // --- in-sketch undo -------------------------------------------------------
  // Ctrl+Z used to reach store.undo(), which pops whole-DOCUMENT snapshots — and
  // an open sketch isn't in the document until finish(), so the newest entry IS
  // the sketch. Ten lines drawn, one Ctrl+Z, all ten gone. These stacks live for
  // the editing session only; leaving and re-entering a sketch starts fresh.
  private history = new SketchHistory();
  private dragRefusedToast = false; // one refusal toast per drag gesture (fixed point, or refused geometry)
  private pendingDrag: { fromX: number; fromY: number; toX: number; toY: number } | null = null;
  /** A BODY drag has a solve waiting for these entity indices (one, or a whole
   *  dragged selection). Their pins are read from the entities in pump(), not
   *  stored here: several pointermove frames can land while one solve is in
   *  flight, and a position captured at queue time would anchor the entities
   *  where the cursor USED to be. */
  private pendingPinIdxs: number[] | null = null;
  /** This frame has had its drag step; later moves wait on the viewport's next
   *  pre-draw (see queueDragFrame). */
  private dragFrameQueued = false;
  /** A body drag that the solver holds nothing of moved its entity, and the
   *  screen has not caught up yet (see queueBodyDrag). */
  private bodyDragUndrawn = false;
  /** The button came up while the gesture's last move was still waiting for its
   *  frame. pump() finishes the release once that move is solved (see endDrag). */
  private dragRelease: { pointerId: number | undefined } | null = null;
  // whole-entity body drag (select tool, no grab point under the cursor):
  // armed cheaply on pointerdown over an entity body; the revert snapshot is
  // built only when the move actually starts (past a small screen-space
  // threshold) — a plain click stays free and falls through to selection on up.
  private moveDrag: {
    idx: number;
    /** what the drag moves: [idx], or the whole selection idx belongs to */
    group: number[];
    startClient: { x: number; y: number };
    last: THREE.Vector2;
    started: boolean;
    /** Shift, Ctrl or Cmd: a click adds to the selection (additiveClick) */
    additive: boolean;
    /** what a click (no move) selects: the point, side or entity under the
     *  press (selKeyAt) */
    key: string;
  } | null = null;
  private solveBusy = false; // a solve is in flight (drag or constraint)
  // the solver WASM failed to come up: stop pumping and say so ONCE, rather
  // than letting every stroke raise the same unhandled rejection
  private solverDead = false;
  private solverDeadToast = false;
  private directDimToast = false; // said once: dims are being written straight to geometry
  private solveDirty = false; // a constraint/dimension solve is pending
  /** Projection refresh entries waiting to be walked in (see
   *  syncProjectedCurves); later entries for the same entity replace earlier. */
  private pendingRefresh: Map<string, ProjectionUpdate> | null = null;
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
  /** Rotate/Scale: the pivot clicked, while its angle or factor box is open. */
  private transformPivot: THREE.Vector2 | null = null;
  /** Move/Copy/Rotate/Scale are still taking clicks as the selection: Enter
   *  ends it. An empty selection means the same, whatever this says. */
  private pickingTargets = false;
  // distance-constraint dims, computed once per refreshActive() in activeCurves()
  // and reused for the clickable labels (constraintDimExtras)
  private cdims: ConstraintDim[] = [];
  private editingId: string | null = null;
  /** Area references of the extrudes on this sketch that an edit here had to
   *  re-point (carryRegionRefs), as they read now. finish() writes them with
   *  the sketch, in its one undo step; they ride in the in-sketch undo
   *  snapshot, so undoing the edit takes them back too. */
  private regionCarry: RegionCarry = {};
  /** What an edit here renamed, and where each of its points and lines went:
   *  a shape exploded (commitExplodes), a curve or shape trimmed or broken
   *  (carryPieces), two lines Join made one, or a polygon's corners and sides
   *  renumbered (commitPolygonEdit). finish() re-points with it every
   *  extrude, on any sketch, that starts from or runs up to one of them, in
   *  the same undo step; it rides in the in-sketch undo snapshot like
   *  regionCarry. Only kept while an extrude names something in this sketch
   *  (carryPoints), so a session nothing refers into snapshots as before. */
  private pointCarry: PointCarry = {};
  /** The curves a Trim here cut that kept their id (trimClick). finish() stops
   *  a projection of one, in another sketch, from following it; it rides in
   *  the in-sketch undo snapshot like pointCarry. */
  private trimmedCurves: string[] = [];
  /** The datumPlane feature this sketch is placed ON, when it was created from
   *  one. Round-tripped through finish() so re-editing a sketch never silently
   *  downgrades it from a live datum link to a baked placement. */
  private planeId: string | null = null;
  /** The body FACE this sketch was placed on, when it was picked off one. Same
   *  round-trip contract as `planeId` above, for the same reason. */
  private faceAnchor: Selector | null = null;
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
  /** the Sketch Palette's Auto Constrain switched OFF: no H/V, perpendicular
   *  or tangent inferred while drawing. Stored as OFF so that "unset" means the
   *  default, on, as the palette's box does. Joins are not inference and stay:
   *  a snap or a chain corner is a coincident either way. */
  private autoConstrainOff = false;
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
    this.dims.onEntityConstraint = (i, f) => this.entityDimConstraint(i, f);
    this.dims.onEntityLock = (i, f) => this.entityDimLock(i, f);
    this.dims.onLabelMenu = (e, a) => {
      // Disabled rather than absent, so the menu reads the same on every badge:
      // a circle's diameter is a property of the circle, so there is nothing to
      // delete until a dimension governs it, and saying so beats a right-click
      // that appears to do nothing. Lock is the discoverable way to turn a
      // measurement into a dimension that HOLDS (report dff87040).
      contextMenu(e.clientX, e.clientY, [
        { label: t("sketch.dimension.lock"), disabled: !a.lock, onClick: () => a.lock?.() },
        { label: t("sketch.dimension.unlock"), disabled: !a.unlock, onClick: () => a.unlock?.() },
        { label: t("sketch.dimension.delete"), danger: true, disabled: !a.del, shortcut: "Del", onClick: () => a.del?.() },
      ]);
    };
    this.glyphs = new SketchGlyphs(viewport);
    this.glyphs.onDelete = (i) => this.deleteConstraint(i);
    this.glyphs.onOverlapPick = (e) => this.labelOverlapSelect(e);
    this.glyphs.onMenu = (e, i) => this.glyphMenu(e, i);
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
      addConstraint: (c, moves, holds) => this.addTrialConstraint(c, moves, holds),
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
    this.patternFlow = new PatternFlow(this.patternHost());
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
   *  baked into the origin and gone.
   *
   *  `face` is the same idea one level down: the body face the plane was picked
   *  off, so the sidecar re-derives the plane from the live face and the sketch
   *  follows the face when the body changes upstream (GH #52). Both are carried
   *  through the identical three places — stored here, re-adopted on edit,
   *  re-emitted in snapshotFeature — because snapshotFeature is what a re-edit
   *  writes back: drop it in any one of the three and the next commit silently
   *  bakes the stale plane and un-anchors the sketch. */
  enter(plane: PlaneSpec, store: DocumentStore, editId?: string, planeId?: string, face?: Selector) {
    this.active = true;
    this.editingId = editId ?? null;
    this.plane = this.overlay.planeFor(plane);
    this.planeId = planeId ?? null;
    this.faceAnchor = face ?? null;
    this.store = store;
    this.regionCarry = {};
    this.pointCarry = {};
    this.trimmedCurves = [];
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
        if (f.face) this.faceAnchor = f.face;
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
   *  Null when no sketch is open. NOT null for a sketch nothing has been drawn
   *  in yet — that case reports an empty `entities` array, which is exactly the
   *  crumb the bug reporter needs. The decision not to COMMIT an empty sketch
   *  lives in finish(), not here. */
  snapshotFeature(): Feature | null {
    if (!this.active || !this.store) return null;
    if (this.entities.length === 0 && this.patterns.length === 0) return null;
    // A re-edit REBUILDS the feature from this working copy and replaceFeature
    // overwrites the committed one wholesale, so every field the sketcher does
    // not itself model is silently dropped on Finish. `name` is the only such
    // field: the user sets it from the browser tree (onRenameSketch writes it
    // straight onto the feature), the sketcher never reads it, and so a rename
    // survived only until the next edit. Carry it across from the committed
    // feature. If that list ever grows past `name`, this is where it belongs.
    const committed = this.editingId ? this.sourceSketch(this.editingId) : null;
    return {
      id: this.editingId ?? this.store.nextId(),
      type: "sketch",
      plane: this.plane.serialize(),
      ...(this.planeId ? { planeId: this.planeId } : {}),
      ...(this.faceAnchor ? { face: this.faceAnchor } : {}),
      ...(committed?.name ? { name: committed.name } : {}),
      entities: this.entities
        .filter((e) => e.id !== TEXT_PREVIEW_ID && !isOriginGeometry(e.id))
        .map(toSketchEntity),
      ...(this.constraints.length > 0 ? { constraints: this.constraints.map((c) => ({ ...c })) } : {}),
      ...(this.patterns.length > 0 ? { patterns: this.patterns.map((p) => ({ ...p })) } : {}),
    };
  }

  /** Does this session hold geometry the user drew? The synthetic origin does
   *  not count, so a sketch you have only opened reports false. Drives both the
   *  empty-commit guard below and whether Cancel Sketch is worth a confirm. */
  hasDrawnGeometry(): boolean {
    return hasDrawnContent(this.snapshotFeature());
  }

  finish(commit = true) {
    if (!this.active) return;
    const store = this.store!;
    this.patternFlow.flushOnFinish(); // may add patterns — must precede the snapshot
    // Don't commit a sketch nobody drew in. Creating an Offset Plane opens a
    // sketch on it automatically, so a user who only wanted the plane pressed
    // Finish and got an empty sketch row to hunt down and delete (d911463c,
    // 40c85f97). snapshotFeature() has an emptiness guard of its own, but it has
    // been DEAD since the origin landed: enter() unshifts three synthetic
    // entities, so `entities.length` is never 0 on a fresh sketch. The test
    // belongs at this commit boundary rather than inside the shared serialiser,
    // because the bug reporter reads that serialiser and needs the open-sketch
    // crumb even when the sketch is empty.
    //
    // `editingId` is load-bearing: erasing every entity from an EXISTING sketch
    // and pressing Finish must still write the deletion through replaceFeature,
    // not skip the commit and silently restore what was deleted.
    const snap = commit ? this.snapshotFeature() : null;
    const sketch = snap && (this.editingId || hasDrawnContent(snap)) ? snap : null;
    if (sketch) {
      if (this.editingId) {
        const carry = Object.keys(this.regionCarry ?? {}).length ? this.regionCarry : undefined;
        const points = Object.keys(this.pointCarry ?? {}).length ? this.pointCarry : undefined;
        const trimmed = this.trimmedCurves?.length ? this.trimmedCurves : undefined;
        store.replaceFeature(this.editingId, sketch, this.drainBindings(sketch.id), carry, points, trimmed);
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
    this.regionCarry = {};
    this.pointCarry = {};
    this.trimmedCurves = [];
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
    this.dragConsBefore = null;
    this.pendingDrag = null;
    this.pendingPinIdxs = null;
    this.pendingRefresh = null; // the store re-sends it against the committed sketch
    this.dragRelease = null;
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
    // a half-clicked polygon/slot/circle/centre arc dies with its tool; carried
    // over, its points became the next tool's first clicks
    this.clickPts = [];
    this.filletFirst = null;
    this.dragFrom = null;
    this.dragDetach = null;
    this.detachArmed = null;
    this.pendingDrag = null;
    this.pendingPinIdxs = null;
    this.dragRelease = null;
    this.moveDrag = null;
    this.resetDimPicks();
    this.moveBase = null;
    this.transformPivot = null;
    this.pickingTargets = false; // an empty selection still picks first (choosingTargets)
    this.offsetPick = null; // an in-progress offset dies with its tool
    this.polygonEdit = null; // and so does an open polygon edit box
    this.clearPendingGlyph(); // the badge of a constraint the old tool would have added
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
    this.selHoverKey = null; // the preview it drew is gone with the rest
    this.constraintTools.resetPending();
    if (!keepSelection && this.selected.size) { this.selected.clear(); this.refreshActive(); }
    if (preselected.length) this.seedDimPicks(preselected);
    if (this.choosingTargets) this.sayWhatToSelect();
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
    // A tangency is a point on two curves that nothing else marks, and a trim
    // stops there: whatever snaps can land on it too (a coordinate only, as a
    // midpoint snaps: it is no solver point to join). Ranked WITH a midpoint,
    // so an end or a centre in reach still wins: those are solver points a
    // drawn line is joined to, and at 95 a small hole's touch took its centre's
    // snap away, Coincident and all.
    const touches = tangencyPoints(this.entities, this.constraints)
      .map((q): SnapCandidate => ({ p: q, kind: "tangent", priority: 80 }));
    this.candidates = [...candidatesFromEntities([...this.entities, ...derived]), ...touches];
    // an in-progress dimension holds entity REFERENCES, and a solve replaces
    // every entity object — re-read the picks off the fresh list
    if (this.dimPicks.length) this.refreshDimPlan();
    if (this.dimsVisible) this.dims.show(this.entities, this.plane, this.constraintDimExtras());
    else this.dims.hide();
    this.redrawGlyphs();
    this.sayTextFailures();
    this.showConstruction();
    // On-demand renderer: a keyboard-driven repaint (e.g. async text glyphs landing
    // via redraw()) fires no pointer event, so force a frame or it won't draw until
    // the next mouse move.
    this.viewport.requestRender();
  }

  /** A text the font cannot draw shows only an empty frame, so say why. The text being typed
   *  says it in its panel, live; a text already in the sketch says it once in a
   *  toast. Runs on every refresh, which is also how an outline or a refusal that
   *  arrives later gets here (textCache's re-render calls redraw()). A lost engine
   *  is not toasted per text: the app already says that once, and every text in
   *  the sketch would otherwise repeat it. */
  private sayTextFailures() {
    for (const e of this.entities) {
      if (e.type !== "text") continue;
      const failure = textFailure(e);
      if (e.id === TEXT_PREVIEW_ID) {
        if (this.textPanel.isActive) this.textPanel.setStatus(failure ? textFailureText(failure) : null);
      } else if (failure && aboutTheText(failure)) {
        const said = `${e.id}\n${failure.message}`;
        if (announcedTextFailures.has(said)) continue;
        announcedTextFailures.add(said);
        textFailureToasts.set(e.id, toast(textFailureText(failure), { kind: "error" }));
      }
    }
  }

  /** Lightweight per-frame refresh for dragging: the curves are rebuilt, and the
   * dimension badges, their annotation lines and the constraint glyphs are
   * MOVED with them rather than rebuilt (dims.follow / glyphs.follow). The
   * snap-candidate array (snapping is off mid-drag) and the region fills wait
   * for refreshActive() on release. The badges used to wait too: they froze for
   * the whole gesture and jumped on release, and their lines vanished (GH #17). */
  private refreshDragGeometry() {
    this.entityVersion++;
    this.bodyDragUndrawn = false;
    const objs = curveObjects(this.entities, this.plane, this.activeColor(), false, this.endpointDotRadius());
    if (this.dimsVisible) {
      this.cdims = constraintDims(this.entities, this.constraints);
      objs.push(...dimensionLineObjects(this.entities, this.plane, this.cdims.flatMap((d) => d.lines)));
      const extras = this.constraintDimExtras();
      if (!this.dims.follow(this.entities, extras)) this.dims.show(this.entities, this.plane, extras);
    }
    this.overlay.setActiveSketch(objs);
    if (this.glyphsVisible && !this.glyphs.follow(constraintGlyphs(this.entities, this.constraints))) {
      this.redrawGlyphs();
    }
    this.viewport.requestRender();
  }

  // --- Sketch Palette options ---
  setGridVisible(on: boolean) {
    this.gridVisible = on;
    if (this.grid) this.grid.visible = on;
    // The viewport draws on demand and a palette click moves nothing on the
    // canvas, so the grid only went away at the next mouse move over it (report
    // 9b764625: "the Sketch grid tickbox does not appear to do anything").
    this.viewport.requestRender();
  }
  setGridSnap(on: boolean) {
    this.gridSnap = on;
  }
  setConstruction(on: boolean) {
    this.constructionMode = on;
    // With geometry selected the switch converts it as well, the way the
    // Construction toggle does in mainstream MCAD (report 2fc27cf1: "I cannot
    // see how to switch a line from construction to line"). It still sets the
    // mode too, so once the selection is gone and the box shows the mode again
    // (constructionShown), it never disagrees with what the next line will be.
    if (this.active && this.selected.size) this.setSelectedConstruction(on);
    this.showConstruction();
  }

  /** What the palette's Construction box shows: the SELECTION while geometry
   *  that can change is selected, else the drawing mode. Report 9b764625: "I
   *  have a construction line, the construction check box does not do
   *  anything". The box showed the mode, unticked, so ticking it with that
   *  line selected asked for what it already was. Now selecting it ticks the
   *  box, and unticking makes it normal, the same thing right-click > Make
   *  normal does. `on` is the selection's majority, the rule that names the
   *  right-click item, and `mixed` says the selection is part construction. */
  constructionShown(): { on: boolean; mixed: boolean } {
    const sel = this.constructionTargets();
    if (!sel.length) return { on: this.constructionMode, mixed: false };
    const n = sel.filter((e) => e.construction).length;
    return { on: this.selectionMostlyConstruction(), mixed: n > 0 && n < sel.length };
  }
  private showConstruction() {
    const { on, mixed } = this.constructionShown();
    this.onConstructionShown?.(on, mixed);
  }

  /** Make the selection construction geometry, or make it normal again. The
   *  flag has always been stored on every entity type, but only the creation
   *  sites ever set it, so a line drawn the wrong way could only be deleted
   *  and redrawn. `on` omitted flips the selection's majority state, which is
   *  what the right-click item and the shortcut offer.
   *
   *  Origin geometry is skipped: it is reference, and always construction.
   *  Normal drops the key rather than writing `false` (byte stability, like
   *  every optional entity field). afterModify re-detects the profile regions,
   *  which is the point: construction never forms one.
   *
   *  Returns false when nothing was selected that could change, so the caller
   *  can say why instead of appearing to do nothing. */
  setSelectedConstruction(on?: boolean): boolean {
    if (!this.active || !this.constructionTargets().length) return false;
    const make = on ?? !this.selectionMostlyConstruction();
    let changed = 0;
    const owners = this.selectedOwners();
    this.entities = this.entities.map((e) => {
      if (!owners.has(e.id) || isOriginGeometry(e.id) || !!e.construction === make) return e;
      changed++;
      if (make) return { ...e, construction: true };
      const { construction: _dropped, ...rest } = e;
      return rest as ResolvedEntity;
    });
    if (!changed) return true;
    this.afterModify();
    // Said as well as seen: the dashes come or go at once, selected or not
    // (overlay curveObjects), and the toast says what that means for the
    // profile.
    toast(make
      ? t("sketch.constructionToggle.construction", { count: changed })
      : t("sketch.constructionToggle.normal", { count: changed }));
    return true;
  }

  /** The selected entities whose construction flag can change. */
  private constructionTargets(): ResolvedEntity[] {
    const owners = this.selectedOwners();
    return this.entities.filter((e) => owners.has(e.id) && !isOriginGeometry(e.id));
  }

  /** The entities the selection touches, whole or by a point or side: what an
   *  operation on geometry acts on (selection.ts). */
  private selectedOwners(): Set<string> {
    return selOwners(this.selected);
  }

  /** Is most of the selection construction already? Decides which way the
   *  toggle goes, and so what the right-click item calls itself. */
  private selectionMostlyConstruction(): boolean {
    const sel = this.constructionTargets();
    return sel.filter((e) => e.construction).length * 2 > sel.length;
  }
  setReferenceDim(on: boolean) {
    this.referenceMode = on;
  }
  /** The palette's Reference Dim switch, read back: the Dimension tool's
   *  right-click menu flips it too (openDimensionMenu). */
  get referenceDim(): boolean {
    return this.referenceMode;
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
      toast(t("sketch.dimension.referenceNotSupported"));
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
  setAutoConstrain(on: boolean) {
    this.autoConstrainOff = !on;
    if (!on) this.clearPendingGlyph();
  }
  /** The menu a right-click on a constraint's badge opens. A Coincident's ⊙ is
   *  drawn ON its joint, so it takes every right-click there and the canvas
   *  menu's Disconnect was out of reach at every corner of a chain of lines;
   *  the badge offers it instead. It releases this join as it pulls
   *  (detachEndpoint's `release`), which is what Disconnect asks for. */
  private glyphMenu(e: MouseEvent, cIndex: number) {
    const c = this.constraints[cIndex];
    const at = c?.type === "coincident" && this.tool === "select"
      ? operandPoint(new Map(this.entities.map((x) => [x.id, x])), c.e1, c.p1)
      : null;
    const joint = at && detachableEnd(this.entities, at, at.clone()) ? at : null;
    contextMenu(e.clientX, e.clientY, [
      ...(joint ? [{ label: t("sketch.menu.disconnect"), onClick: () => this.armDisconnect(joint) }] : []),
      { label: t("sketch.constraint.deleteConstraint"), danger: true, onClick: () => this.deleteConstraint(cIndex) },
    ]);
  }

  /** Arm Disconnect on the shared point `p`: the next press there pulls an end
   *  away without Shift (detachFrame). */
  private armDisconnect(p: { x: number; y: number }) {
    this.detachArmed = coincKey(p.x, p.y);
    setPrompt(t("sketch.prompt.disconnect"));
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
   *  a field a LOCK already governs retypes that constraint; everything else
   *  (an unlocked rectangle W/H, line angle) edits coordinates directly.
   *  planDimEdit owns that fork — a direct write to a governed field looks like
   *  it worked and is undone by the next solve. */
  private editDimension(index: number, field: DimField, mm: number) {
    const e = this.entities[index];
    if (!e) return;
    const plan = planDimEdit(this.constraints, e, field, mm);
    if (plan.kind === "upsert") {
      this.setDrivingDimension(plan.c, plan.moves);
      return;
    }
    if (plan.kind === "retype") {
      const c = this.constraints[plan.at];
      // plan.value, not mm: a signed X/Y dim keeps the sign it already had
      if (c && isDimConstraint(c)) this.writeDimValue(c, plan.value);
      return;
    }
    const written = this.shapeFieldWrite(index, field, mm);
    if (typeof written === "string") toast(written);
    else this.entities = written;
    this.refreshActive();
  }

  /** The entities with a rectangle's, polygon's or slot's own number written
   *  straight into it, and every shape an Offset ties to it side for side
   *  re-made from it (followOffsets): nothing else would, a solve afterwards
   *  included. Or what to say instead, when the edit cannot be taken
   *  (followOffsets' `refused`). */
  private shapeFieldWrite(index: number, field: DimField, mm: number): ResolvedEntity[] | string {
    const e = this.entities[index];
    if (!e) return this.entities;
    const edited = { ...e };
    entityDims(edited).find((d) => d.field === field)?.write(mm);
    const follow = followOffsets(this.entities.map((x, i) => (i === index ? edited : x)), this.constraints, e.id, e);
    return "refused" in follow ? followRefusal(follow.refused) : follow.entities;
  }

  /** The same edit arriving from the INSPECTOR while this sketch is open
   *  (injected via store.onSketchDimEdit — the mirror of syncParamValues). The
   *  session owns an open sketch's entities, so the panel's number has to come
   *  here instead of to the document copy, which finish() would overwrite.
   *  Addressed by entity ID: this array can have moved on since enter(). */
  applyDimensionEdit(entityId: string, field: DimField, mm: number) {
    if (!this.active) return;
    const i = this.entities.findIndex((e) => e.id === entityId);
    if (i < 0) return;
    this.editDimension(i, field, mm);
    this.onState?.();
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
        t("sketch.dimension.appliedDirectly"),
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

  /** The driving constraint behind an ENTITY dim badge, in the three answers
   *  SketchDimensions.onEntityConstraint asks for. The rule itself lives in
   *  directDims.governingDimAt, shared with the edit path so a badge and a
   *  re-dimension can never disagree about which constraint is "the" one for
   *  this field. */
  private entityDimConstraint(index: number, field: DimField): (() => void) | "free" | null {
    const e = this.entities[index];
    if (!e) return null;
    const at = governingDimAt(this.constraints, e, field);
    // A measurement, honestly labelled: the badge shows what the geometry
    // currently IS, and nothing holds it there (reports fd7dcc5f, dff87040).
    if (at === null || at === "free") return at;
    return () => this.deleteConstraint(at);
  }

  /** "Lock dimension" on a MEASURED entity badge: create the driving constraint
   *  that holds what the badge already reads. No value is retyped, so nothing
   *  should move — which is also why no mover bias is armed. */
  private entityDimLock(index: number, field: DimField): (() => void) | null {
    const e = this.entities[index];
    if (!e) return null;
    const dim = entityDims(e).find((d) => d.field === field);
    if (!dim || !lockDimFor(e, field, dim.valueMm)) return null;
    return () => {
      const cur = this.entities[index];
      const now = cur && entityDims(cur).find((d) => d.field === field);
      const c = cur && now ? lockDimFor(cur, field, now.valueMm) : null;
      if (!c) return;
      this.setDrivingDimension(c);
      this.refreshActive();
      this.onState?.();
    };
  }

  /** Constraints > Lock Dimension (report d3338e3a: "lock dimension should
   *  possibly be in the constraints dropdown as well ... keep it on the right
   *  click as well but it is such an important constraint it should be
   *  obvious"). Selection first: with geometry selected it locks that
   *  geometry's measured dimensions and is done. With nothing selected it arms,
   *  and every entity clicked has its measured dimensions locked. */
  lockDimensionCommand() {
    if (!this.active) return;
    if (this.selected.size) {
      this.lockMeasuredDims(this.selectedOwners());
      return;
    }
    this.setTool("lockDimension");
  }

  /** The armed Lock Dimension tool's click: lock the measured dimensions of the
   *  entity under the cursor. */
  private lockDimensionClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    const e = idx >= 0 ? this.entities[idx] : undefined;
    if (!e || isOriginGeometry(e.id)) return;
    this.lockMeasuredDims(new Set([e.id]));
  }

  private toastLocked(n: number) {
    toast(n ? t("sketch.lockDims.locked", { count: n }) : t("sketch.lockDims.nothing"));
  }

  /** Lock every measured dimension on these entities, as ONE undo step. The
   *  same act as a badge's own Lock (entityDimLock), sized to a selection,
   *  through the same rule (directDims.measuredLocks): the values are what the
   *  geometry already measures, so nothing should move, which is also why no
   *  mover bias is armed. On trial as a set, the way a fillet's constraints
   *  are, so a sketch something else already holds gets them all withdrawn
   *  with a reason rather than painted red; and the ones the rest of the sketch
   *  already implies are dropped (SketchTrial.dropRedundant), so the toast that
   *  counts them is only said once the solve has judged them. */
  private lockMeasuredDims(ids: ReadonlySet<string>) {
    const locks = this.entities
      .filter((e) => ids.has(e.id) && !isOriginGeometry(e.id))
      .flatMap((e) => measuredLocks(this.constraints, e));
    if (!locks.length) {
      this.toastLocked(0);
      return;
    }
    for (const c of locks) if (isDimConstraint(c) && !c.id) c.id = newConstraintId();
    const before = this.constraints;
    this.constraints = [...before, ...locks];
    // A Lock still waiting for its solve (a second click landed while the first
    // was being solved) is folded into this one, so both are judged and the
    // toast counts both.
    const waiting = this.trial?.dropRedundant ? this.trial : null;
    const cons = [...(waiting?.cons ?? []), ...locks];
    this.trial = {
      cons,
      restore: waiting?.restore ?? before,
      msg: (blamed, solved) => dimConflictMsg(cons[0]!, blamed, solved),
      dropRedundant: (kept) => this.toastLocked(kept.length),
    };
    this.requestSolve();
    if (this.solverDead) {
      // see setDrivingDimension; and with no solve to judge them, all of them
      // are what was locked
      this.trial = null;
      this.applyDrivingDimsDirectly();
      this.toastLocked(cons.length);
    }
    this.refreshActive();
    this.onState?.();
  }

  /** "Lock dimension" on a reference (driven) dim: keep the same dimension, at
   *  the value it currently MEASURES, and let it drive. setDrivingDimension's
   *  dedup removes the driven original and hands its id over, so a parameter
   *  binding survives the lock. */
  private lockPlacedDim(cIndex: number, valueMm: number) {
    const c = this.constraints[cIndex];
    if (!c || !isPlacedDim(c) || !isDriven(c)) return;
    const { driven: _driven, ...rest } = c as SketchConstraint & { driven?: boolean };
    this.setDrivingDimension({ ...rest, value: valueMm } as SketchConstraint);
    this.conflictIdx.clear(); // indices shifted; the next solve repopulates
    this.overIdx.clear();
    this.refreshActive();
    this.onState?.();
  }

  /** The inverse: keep the dimension but stop it driving. The geometry does not
   *  move — a dimension that was satisfied still is — but the sketch gains back
   *  the freedom it was holding, and the badge goes bracketed. */
  private unlockPlacedDim(cIndex: number) {
    const c = this.constraints[cIndex];
    if (!c || !isPlacedDim(c) || isDriven(c)) return;
    this.constraints[cIndex] = { ...c, driven: true } as SketchConstraint;
    this.conflictIdx.clear();
    this.overIdx.clear();
    this.requestSolve();
    this.refreshActive();
    this.onState?.();
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
        ...dimBadgeFields(d),
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
        // Lock/Unlock, the two directions of "does this dimension hold?".
        // d.valueMm on a driven dim is the LIVE measurement, which is exactly
        // the value locking it should freeze.
        ...(d.driven
          ? { onLock: () => this.lockPlacedDim(d.cIndex, d.valueMm) }
          : con && isPlacedDim(con) ? { onUnlock: () => this.unlockPlacedDim(d.cIndex) } : {}),
        commitExpr: (raw: string) => {
          const c = this.constraints[d.cIndex];
          if (!c || !isDimConstraint(c)) return t("sketch.dimension.error.notEditable");
          if (!c.id) c.id = newConstraintId();
          return this.commitExprInput(`c:${c.id}`, d.kind === "angle" ? "angle" : "length", raw, (v) => {
            this.writeDimValue(c, v);
          }, d.signed);
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
   *  centralising the write is what stops the two sites drifting apart.
   *
   *  The X/Y distances are signed too and deliberately get NO carve-out here:
   *  unlike offset they DISPLAY their sign, so the user can type it, and
   *  forcing the old sign back would make "put this point on the other side"
   *  unsayable. The editor gate (units.dimValueOk) is what lets the negative
   *  through to this line. */
  private writeDimValue(c: SketchConstraint & { value: number }, val: number) {
    c.value = c.type === "offset" && c.value < 0 ? -Math.abs(val) : val;
    // A single-entity dimension moves that entity. Without this the solve runs
    // free and planegcs splits the correction across everything the dimension
    // can reach: report d8c5265e retyped a circle's diameter and the rectangle
    // it sits tangent inside grew with it. See sketchSolve.soleDimEntity for why
    // a genuine two-entity dim deliberately gets no bias.
    const mover = soleDimEntity(c);
    if (mover) this.pendingBias = { moves: [mover] }; // BEFORE requestSolve: the pump reads it synchronously
    this.requestSolve();
    // no solver on this machine: the value has to reach the geometry here, the
    // same way setDrivingDimension does it (see applyDrivingDimsDirectly)
    if (this.solverDead) this.applyDrivingDimsDirectly();
    this.onState?.();
  }

  /** Add/replace the driving dimension on an entity, then re-solve. A dim gets
   *  its stable id at birth; a replacement inherits the replaced dim's id, so a
   *  parameter binding survives retyping the dimension.
   *
   *  `moves` names the entity this dimension should move (the first-picked
   *  operand — see DimPlan.moves). It biases exactly ONE solve and is never
   *  stored, so only the callers that still know the pick order pass it.
   *
   *  The new dimension goes ON TRIAL like any constraint a tool adds (886da4e5):
   *  a value the sketch cannot satisfy used to be committed anyway, and the only
   *  feedback was every curve painted CONFLICT red. */
  private setDrivingDimension(c: SketchConstraint, moves?: string) {
    // Snapshot BEFORE the sameTarget filter: a withdrawn dimension edit has to
    // restore the WHOLE pre-edit list, not just splice the new dim out. The
    // dimension it replaces has already been dropped by then, so splicing would
    // leave the entity with no dimension at all — a second, silent loss.
    const before = this.constraints;
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
    let replacedValue: number | undefined;
    this.constraints = this.constraints.filter((k) => {
      if (!sameTarget(k)) return true;
      if (isDimConstraint(k) && k.id) replacedId = k.id;
      if (isDimConstraint(k)) replacedValue = k.value;
      return false;
    });
    if (isDimConstraint(c) && !c.id) c.id = replacedId ?? newConstraintId();
    this.constraints.push(c);
    this.trial = {
      cons: [c],
      restore: before,
      msg: (blamed, cons) => dimConflictMsg(c, blamed, cons, replacedValue),
    };
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

  /** The polygon and slot numbers a parameter or a formula sets, for the
   *  solver to hold (sketchSolve.BoundFields): once a constraint names one of
   *  their points or sides they are solver geometry, and a solve that moved a
   *  bound number would be undone by the next parameter sync. */
  private boundShapeFields(): Set<string> | undefined {
    let out: Set<string> | undefined;
    for (const e of this.entities) {
      if (e.type !== "polygon" && e.type !== "slot") continue;
      for (const [field] of RIGID_ENTITY_NUM_FIELDS[e.type] ?? []) {
        if (this.exprFor(`e:${e.id}:${field}`) !== undefined) (out ??= new Set()).add(`${e.id}:${field}`);
      }
    }
    return out;
  }

  /** Evaluate raw dim input for the binding slot `key`: a plain number in
   *  display units, or an expression in canonical units — including the
   *  `name=expr` form (names the dim's model parameter). The number/formula
   *  fork lives here; what counts as an acceptable VALUE is units.dimValueOk,
   *  shared with the label editor's plain-number path on unbound dims
   *  (sketchDimensions.beginEdit) so a formula and a typed literal can't
   *  disagree about whether "-30" is a legal DX. `expr` is null for plain
   *  numbers; `name` is set only when the input renames the binding. */
  private evalDimInput(raw: string, kind: FieldKind, key: string | null, signed = false): { value: number; expr: string | null; name?: string } | { error: string } {
    if (isPlainNumber(raw)) {
      const value = parseField(raw, kind);
      if (!dimValueOk(value, kind, signed)) return { error: t("sketch.dimension.error.invalidValue") };
      return { value, expr: null };
    }
    if (!this.store) return { error: t("sketch.dimension.error.noDocument") };
    const bound = key ? (this.docBinding(key)?.name ?? null) : null;
    const pending = key ? (this.pendingBindings.get(key)?.name ?? null) : null;
    const c = this.store.classifyTargetExpr(bound, pending, storedDimExpr(raw, kind), kind);
    if (!c.ok) return { error: c.error };
    if (!dimValueOk(c.value, kind, signed)) {
      return { error: t(signed ? "sketch.dimension.error.mustBeNonZero" : "sketch.dimension.error.mustBePositive") };
    }
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

  /** Shared raw-input commit for a bindable dim slot with a known key.
   *  `signed` passes the dim's own rule about acceptable values down to
   *  evalDimInput — see units.dimValueOk. `refuse` says why a value cannot be
   *  taken, before anything (its binding included) is written. */
  private commitExprInput(
    key: string, kind: FieldKind, raw: string, apply: (value: number) => void, signed = false,
    refuse?: (value: number) => string | null,
  ): string | null {
    const r = this.evalDimInput(raw, kind, key, signed);
    if ("error" in r) return r.error;
    const no = refuse?.(r.value);
    if (no) return no;
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
    if (!e) return t("sketch.dimension.error.noEntity");
    if (e.type === "line" && field === "length") return this.commitConvertedDim({ type: "distance", line: e.id, value: 0 }, raw);
    if (e.type === "circle" && field === "diameter") return this.commitConvertedDim({ type: "diameter", circle: e.id, value: 0 }, raw);
    const bindable = RIGID_ENTITY_NUM_FIELDS[e.type]?.some(([f]) => f === field);
    if (!bindable) return t("sketch.dimension.error.noExpression");
    const write = (v: number) => this.shapeFieldWrite(index, field, coerceForField(field, v));
    return this.commitExprInput(`e:${e.id}:${field}`, "length", raw, (v) => {
      const written = write(v);
      if (typeof written !== "string") this.entities = written;
      this.refreshActive();
      this.onState?.();
    }, false, (v) => {
      const written = write(v);
      return typeof written === "string" ? written : null;
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
    // the entity being dimensioned is the one that moves — same rule as
    // editDimension's numeric path (report d8c5265e)
    this.setDrivingDimension(c, soleDimEntity(c) ?? undefined); // stamps a fresh id or inherits the replaced dim's
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
    const reshaped: { id: string; was: ResolvedEntity }[] = [];
    for (const e of this.entities) {
      const was = { ...e };
      for (const [field] of RIGID_ENTITY_NUM_FIELDS[e.type] ?? []) {
        const next = valueFor(`e:${e.id}:${field}`);
        if (next == null) continue;
        const rec = e as unknown as Record<string, unknown>;
        const coerced = coerceForField(field, next);
        if (rec[field] !== coerced) {
          rec[field] = coerced;
          touched = true;
          if (reshaped.at(-1)?.id !== e.id) reshaped.push({ id: e.id, was });
        }
      }
    }
    // What an Offset ties to a shape the parameter set is taken along, as for
    // a number typed (followOffsets), against the constraints as they were;
    // then a new side count renumbers the sides and corners constraints name,
    // on the shape and on every one that followed it. What cannot follow is
    // said: the parameter has set the shape all the same.
    const resided: { id: string; sides: number }[] = [];
    const moved = new Set<string>(); // one an earlier shape re-made: that one decides
    for (const { id, was } of reshaped) {
      if (moved.has(id)) continue;
      const follow = followOffsets(this.entities, this.constraints, id, was);
      if ("refused" in follow) {
        toast(followRefusal(follow.refused, true));
        continue;
      }
      follow.entities.forEach((x, j) => { if (x !== this.entities[j]) moved.add(x.id); });
      this.entities = follow.entities;
      resided.push(...follow.resided);
    }
    for (const { id, was } of reshaped) {
      const now = this.entities.find((x) => x.id === id);
      if (was.type === "polygon" && now?.type === "polygon" && now.sides !== was.sides) {
        rebindPolygonSides(this.entities, this.constraints, id, was.sides);
      }
    }
    for (const r of resided) rebindPolygonSides(this.entities, this.constraints, r.id, r.sides);
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
   *  NOT written while the sketch is open; finish() persists the session.
   *
   *  A constrained sketch is WALKED to the new curves in the solve pump
   *  (walkRefresh), the way the store walks a closed one: one solve from the
   *  old coordinates against curves that moved further than a dimension lands
   *  the geometry on its mirror side (field reports 6124e4a7, 66d7eb71). */
  syncProjectedCurves(updates: ProjectionUpdate[]) {
    if (!this.active) return;
    const live = new Map<string, ProjectionUpdate>();
    for (const u of updates) {
      const e = this.entities.find((x) => x.type === "projected" && x.id === u.entity);
      if (!e || e.type !== "projected") continue;
      if (u.stale && e.stale) continue; // already flagged — nothing changes
      live.set(u.entity, u);
    }
    if (!live.size) return;
    if (this.constraints.length > 0 && !this.solverDead) {
      // the walk never reaches requestSolve, and the pump re-arms the baseline
      // once it settles: the refresh is DERIVED, never an undo step
      this.pendingRefresh = new Map([...(this.pendingRefresh ?? []), ...live]);
      void this.pump();
      return;
    }
    this.entities = this.entities.map((e) =>
      e.type === "projected" && live.has(e.id) ? applyProjectionUpdate(e, live.get(e.id)!) : e);
    this.armPreEdit(); // projection refresh is DERIVED — never an undo step
    this.requestSolve();
    this.refreshActive();
  }

  /** The session as a sketch feature, for the pure projection-walk helpers.
   *  Its entities are already numbers, which those helpers resolve as-is. */
  private sessionSketch(entities: ResolvedEntity[]): Extract<Feature, { type: "sketch" }> {
    return { id: this.editingId ?? "", type: "sketch", plane: "XY", entities: entities as unknown as SketchEntity[], constraints: this.constraints };
  }

  /** Land `updates` in the open sketch, walking the projected lines there in
   *  steps (projectionWalk.ts) so the constrained geometry follows them instead
   *  of jumping to a mirror image. A walk that a draw interrupts, that a step
   *  cannot solve, or that still ends on the far side of a line hands over to
   *  the single solve straight onto the new curves, as before. Runs inside
   *  pump(), so no other solve is in flight. */
  private async walkRefresh(updates: Map<string, ProjectionUpdate>) {
    const ver = this.entityVersion;
    const pre = this.sessionSketch(this.entities);
    const steps = refreshSteps(pre, updates);
    let cur: Extract<Feature, { type: "sketch" }> | null = pre;
    try {
      for (let k = 1; k <= steps && steps > 1 && cur; k++) {
        const next: Extract<Feature, { type: "sketch" }> = refreshStep(cur, pre, updates, k / steps);
        const r = await compileAndSolve(next.entities as unknown as ResolvedEntity[], [...this.constraints]);
        if (!this.active) return;
        cur = this.entityVersion === ver && r.ok && r.conflicts.length === 0
          ? { ...next, entities: r.entities as unknown as SketchEntity[] } : null;
      }
    } catch (err) {
      // the solver died mid-walk: hand the entries back for pump() to land
      // unsolved, under any that arrived since
      this.pendingRefresh = new Map([...updates, ...(this.pendingRefresh ?? [])]);
      throw err;
    }
    const walked = steps > 1 && cur && !p2lSideFlipped(pre, cur, {}) ? cur : null;
    // the fallback lands the curves on whatever the session holds NOW: a draw
    // may have added an entity while the walk was solving
    const landed = walked ?? refreshStep(this.sessionSketch(this.entities), pre, updates, 1);
    this.entities = landed.entities as unknown as ResolvedEntity[];
    this.solveDirty = true; // settle: conflict state and DOF colour, or the single solve
    this.refreshActive();
  }

  /** The entities a badge's click may be handed to: everything the user DREW,
   *  and nothing else.
   *
   *  The geometry-beats-label rule exists so a badge cannot swallow a click
   *  aimed at real geometry underneath it. Reference geometry is the one thing
   *  that rule must not cover: `pickEntity` falls back to the origin axes when
   *  none of your own geometry is in range, and under a badge none ever is —
   *  every badge is laid out at least LABEL_CLEAR_PX (18 px) off the geometry it
   *  labels, twice the 9 px pick tolerance. So for a rectangle centred on the
   *  origin the height badge sits exactly on the X axis and the width badge
   *  exactly on the Y axis, and the axis (at distance 0) took every click: the
   *  badge was permanently uneditable and the only feedback was the axis
   *  lighting up. Reported 2026-09-05. The axes are ±10 000 mm long and stay
   *  directly clickable everywhere they are not under a badge. */
  private ownEntities(): ResolvedEntity[] {
    return this.entities.filter((e) => !isOriginGeometry(e.id));
  }

  /** Every entity reachable from `startId` by walking coincident endpoints —
   *  the sketch "chain select" a field tester asked for (Doug Smith #15:
   *  "select a contiguous string of elements in a sketch all together").
   *
   *  Connectivity, NOT tangency. The 3D edge chain in edgeFeatureTool requires
   *  G1 continuity because OCCT cannot end a blend mid-tangency; that is a
   *  kernel constraint, not a selection one. In a sketch a sharp corner in a
   *  profile is still one contour to the user, so a chain crosses it.
   *
   *  A CLOSED entity (circle, rectangle, polygon, slot) is a contour on its own:
   *  it has no free ends, so it neither drags neighbours in nor is dragged in by
   *  one that happens to touch it. That keeps a circle tangent to a rail out of
   *  the rail's chain, which is what "contiguous string" means to a user.
   *
   *  The origin geometry is excluded via ownEntities. That is defensive rather
   *  than load-bearing: this walk matches ENDPOINT to ENDPOINT, and the axes'
   *  ends are at ±10 000 mm while the origin point collapses to a single vertex
   *  (so it reads as closed). Neither is reachable from a real sketch. The
   *  exclusion stays because it is what makes that safety a property of the
   *  code rather than of the axis length.
   *
   *  Construction geometry chains only from a construction pick, the rule
   *  offsetChain follows too. Construction lines drawn out to a profile's
   *  corners are not part of its contour, and a double-click on the profile
   *  used to select them along with it (field report 356b2693). */
  private entityChain(startId: string): string[] {
    const own = this.ownEntities();
    const withConstruction = !!own.find((e) => e.id === startId)?.construction;
    // id → its two free ends. Absent = closed, or too degenerate to walk.
    const ends = new Map<string, [THREE.Vector2, THREE.Vector2]>();
    for (const e of own) {
      if (e.construction && !withConstruction) continue;
      const pts = entityPolyline(e);
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (!a || !b) continue; // text: entityPolyline is empty
      if (a.distanceTo(b) <= EPS) continue; // closed
      ends.set(e.id, [a, b]);
    }
    if (!ends.has(startId)) return [startId];

    const chain = new Set<string>([startId]);
    const queue: string[] = [startId];
    while (queue.length) {
      const cur = queue.pop();
      if (cur === undefined) break;
      const curEnds = ends.get(cur);
      if (!curEnds) continue;
      for (const [id, other] of ends) {
        if (chain.has(id)) continue;
        const touches = curEnds.some((p) => other.some((q) => p.distanceTo(q) <= EPS));
        if (!touches) continue;
        chain.add(id);
        queue.push(id);
      }
    }
    return [...chain];
  }

  /** Grow the current selection to every entity chain-connected to it — the
   *  keyboard route to the same thing double-clicking an entity does (#15).
   *  A gesture nobody is told about is not a feature, and the shortcut list is
   *  where this app advertises its gestures.
   *
   *  Returns false when there was nothing to grow (not in a sketch, not in the
   *  select tool, nothing selected, or the selection is already whole chains),
   *  so the caller can say why instead of appearing to do nothing. */
  growSelectionToChains(): boolean {
    if (!this.active || this.tool !== "select" || this.selected.size === 0) return false;
    const before = [...this.selected].join("|");
    // a point or side grows into its whole entity, and then its chain
    for (const id of this.selectedOwners()) {
      for (const linked of this.entityChain(id)) addKey(this.selected, linked);
    }
    if ([...this.selected].join("|") === before) return false;
    this.refreshActive();
    return true;
  }

  /** What a double-click on entity `id` selects: it and its whole connected
   *  chain (#15), added to the selection with `additive` (Shift, Ctrl, Cmd),
   *  else in place of it. A polygon is taken whole and opens its edit box at
   *  `at` (client px) instead: its chain is only itself (a closed entity has
   *  no free ends, entityChain), so the chain select had nothing to add for
   *  one. False, doing nothing, for the origin, which is not selectable
   *  geometry. */
  private takeWhole(id: string, additive: boolean, at: { x: number; y: number }): boolean {
    const ce = this.entities.find((x) => x.id === id);
    if (!ce || isOriginGeometry(ce.id)) return false;
    if (!additive) this.selected.clear();
    if (ce.type === "polygon") {
      addKey(this.selected, ce.id);
      this.refreshActive();
      this.editPolygon(ce.id, at);
      return true;
    }
    for (const linked of this.entityChain(ce.id)) addKey(this.selected, linked);
    this.refreshActive();
    return true;
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
    // A drag handle under the press: hand the whole press to the canvas. A
    // coincident's ⊙ or a fix's anchor is drawn ON its point, about 18 px
    // across against a 9 px pick radius, so it covered the very handle it
    // marks: a press on a snapped join (and every snap makes one now) only
    // selected, and neither a point drag nor the Shift-drag Break's toast
    // describes could start from the dot. onPointerDown does what a press on
    // the bare canvas does there, pointer capture included, so the drag's
    // moves and release reach the canvas. Double-click delete is unaffected:
    // the badge recognises its second press before asking this.
    if (pickDragPoint(this.entities, raw, this.pickTol())) {
      this.onPointerDown(e);
      return true;
    }
    // Only a CURVE under the badge is geometry it sits over. A shape's centre
    // is inside it, where badges sit (a polygon's radius, at 0.6 of it): a
    // press there opens the badge's editor, as it always did.
    const own = this.ownEntities();
    if (pickEntity(own, raw, this.pickTol()) < 0) return false;
    const key = this.selKeyAt(raw, own);
    if (!key) return false;
    clickKey(this.selected, key, additiveClick(e));
    this.refreshActive();
    return true;
  }

  /** The Select tool's hover: the point or shape side a click at `raw` would
   *  select (selKeyAt), lit the way the constraint tools light theirs, so a
   *  click can take one side of a rectangle without that being a surprise.
   *  A whole entity is not lit, as before. Redrawn only when what is under
   *  the cursor changes. True while a point or side is lit. */
  private selectHover(raw: THREE.Vector2): boolean {
    const key = this.selKeyAt(raw);
    const part = key !== null && selPart(key).kind !== "entity" ? key : null;
    if (part !== this.selHoverKey) {
      this.selHoverKey = part;
      this.overlay.setPreview(part ? this.partObjects([part], SKETCH_POINT_HOVER) : []);
    }
    return part !== null;
  }

  /** Drop the Select hover (a press, a tool change): a lit side left behind
   *  would sit where the side WAS through a drag. */
  private clearSelectHover() {
    if (!this.selHoverKey) return;
    this.selHoverKey = null;
    this.overlay.setPreview([]);
  }

  /** What a click of the Select tool at `raw` selects, as a selection key
   *  (selection.ts), or null over nothing: the POINT under it first (a line's
   *  or arc's end, a corner, a centre), through the same picker every
   *  constraint tool's click goes through (refPointNear), then the
   *  SIDE of a rectangle, polygon or slot under it, then the entity. GH #17:
   *  a click on a rectangle's side used to take the whole rectangle, which
   *  named no operand, so nothing could be constrained to that side from a
   *  selection.
   *
   *  The point gives way to the curve under the cursor where that curve is
   *  nearer, or along the middle of a short one (pointBeatsCurve): otherwise
   *  a small circle's rim took its centre and a short line's middle an end.
   *  Whenever it does take a point, it is the one a constraint tool would.
   *
   *  A sketch POINT is a point already, so it comes back as itself. A slot's
   *  round end is no side: it takes the whole slot. Its axis is not offered
   *  here (it runs through the middle of the slot, where a click picks the
   *  area to extrude); the constraint tools still take it. `ents` narrows the
   *  candidates. */
  private selKeyAt(raw: THREE.Vector2, ents: ResolvedEntity[] = this.entities): string | null {
    const tol = this.pickTol();
    const idx = pickEntity(ents, raw, tol);
    const hit = idx >= 0 ? ents[idx] : undefined;
    const pt = refPointNear(ents, raw, tol);
    const pe = pt ? ents.find((x) => x.id === pt.id) : undefined;
    const pos = pt && pe ? refPoint(pe, pt.idx) : null;
    // an origin axis is reference: it never takes a click from your own point
    const curve = hit && !isOriginGeometry(hit.id) ? hit : undefined;
    if (pt && pe && pos && pointBeatsCurve(curve, pos, raw, tol)) return pe.type === "point" ? pe.id : pointKey(pe.id, pt.idx);
    if (!hit) return null;
    return (isCompoundShape(hit) ? lineOperandAt(hit, raw) : null) ?? hit.id;
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
    // ownEntities, for the same reason as labelOverlapSelect: pickDimTarget
    // falls through to pickEntity, so the origin axes claimed a centred shape's
    // badges here too.
    if (!midDimension && !pickDimTarget(this.ownEntities(), raw, this.pickTol())) {
      return false; // the annotation owns this click
    }
    this.dimensionClick(raw, e);
    return true;
  }

  /** True when this press is the SECOND of a double-click. `PointerEvent.detail`
   *  is always 0 in a pointerdown handler, so both double-click paths below —
   *  edit a pattern, edit text — were dead; this is the same recogniser a
   *  dimension badge uses, so a double-click means one thing everywhere. */
  private lastPress: PressRecord = null;
  private doublePress(e: PointerEvent): boolean {
    const { next, double } = stepDoublePress(this.lastPress, e);
    this.lastPress = next;
    return double;
  }

  private onPointerDown(e: PointerEvent) {
    // A label stops propagation on its own pointerdown, so reaching here means
    // the click landed away from every dimension: drop the label selection so a
    // later Delete can't remove a dimension the user is no longer pointing at.
    this.dims.clearSelection();
    if (e.button === 2) { this.rightDownAt = { x: e.clientX, y: e.clientY }; this.rightDragged = false; }
    if (e.button !== 0) return; // left only; middle/right still navigate
    // Recognised HERE rather than read off `e.detail`, and recorded for every
    // primary press so the pairing can't drift: this handler is registered on
    // `pointerdown`, where Chromium leaves `detail` at 0 (mousedown carries 1
    // then 2). The two double-click paths below — edit a pattern, edit text —
    // gated on `e.detail >= 2` and so never ran in the shipped webview.
    const doubleClick = this.doublePress(e);
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
    // Lock Dimension picks an entity, so it takes the raw cursor for the same
    // reason: a grid snap can pull the point off the curve it was aimed at.
    if (this.tool === "lockDimension") {
      const raw = this.planePoint(e);
      if (!raw) return;
      e.preventDefault();
      this.lockDimensionClick(raw);
      return;
    }
    // FILLET and CHAMFER pick on the raw cursor too, for a third reason: the
    // click must take what the hover lit, and modifyHover picks at the raw
    // cursor (with no snap marker shown). The snapped point fed nothing but the
    // pick. A click half a millimetre along a line that starts on a polygon's
    // corner snapped ONTO the corner, where the pick's tie went to whichever was
    // drawn first: the hover lit the line and the click blamed the polygon.
    if (this.tool === "fillet" || this.tool === "chamfer") {
      const raw = this.planePoint(e);
      if (!raw) return;
      e.preventDefault();
      if (this.tool === "fillet") this.filletClick(raw);
      else this.chamferClick(raw);
      return;
    }
    // Move, Copy, Rotate and Scale with nothing chosen yet: the click CHOOSES,
    // on the raw cursor like the Select tool's, so a snap cannot pull it onto
    // the neighbouring curve. They used to light the curve red, take the
    // click, and only then say to select something first (Paul, 269bfb81).
    if (this.choosingTargets) {
      const raw = this.planePoint(e);
      if (!raw) return;
      e.preventDefault();
      this.chooseTarget(raw, e.shiftKey || e.ctrlKey || e.metaKey, this.onPivotPoint(e));
      return;
    }
    // Ctrl means "do not snap" only while drawing. In Select it ADDS to the
    // selection, like Shift (and Cmd on a Mac), which is what a user reaches
    // for first (GH #17). A select press picks by distance (pickPoint,
    // pickEntity), so it never needed the snap turned off.
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey && this.tool !== "select");
    if (!hit) return;
    e.preventDefault();
    const p = hit.p;
    this.lastSnapKind = hit.kind;
    this.lastSnapRef = hit.ref ?? null;

    if (this.tool === "select") {
      this.clearSelectHover();
      // a Disconnect armed from the right-click menu lasts exactly one press
      const armed = this.detachArmed;
      this.detachArmed = null;
      // grab a point to drag it — connected/constrained geometry follows
      const gp = this.pickPoint(p);
      if (gp) {
        const at = this.planePoint(e) ?? p;
        this.dragFrom = gp.p.clone();
        this.dragStartClient = { x: e.clientX, y: e.clientY };
        this.dragMoved = false;
        this.dragAdditive = additiveClick(e);
        // what a click here selects: the point the hover lit, which is the
        // handle's own point but for a nearer one of a shape with no handles,
        // or the curve itself where it is nearer (selKeyAt)
        this.dragKey = this.selKeyAt(at) ?? this.entities[gp.idx]?.id ?? null;
        // A double-click here takes the whole entity or chain, as one on a
        // curve does (below), once it is known not to be a drag: a handle is
        // under every press on a small circle, a short line or a corner, so
        // otherwise those could never be double-clicked whole. A second press
        // that moves is a drag all the same.
        const ci = doubleClick ? pickEntity(this.entities, at, this.pickTol()) : -1;
        this.dragWhole = !doubleClick ? null
          : ci >= 0 ? this.entities[ci]!.id
            : this.dragKey ? selOwner(this.dragKey) : null;
        // At a Break's cut, Shift pulls this end AWAY from the other half (see
        // detachFrame); anywhere else it drags as a plain drag does, and the
        // right-click Disconnect is the way to pull an end off. A stationary
        // Shift-click still toggles the selection.
        this.dragDetachRelease = armed === coincKey(gp.p.x, gp.p.y);
        const detach = (e.shiftKey && isBreakCut(this.entities, gp.p)) || this.dragDetachRelease;
        this.dragDetach = detach ? at.clone() : null;
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
      if (de && doubleClick) {
        this.editPattern(de.id.split("#")[0] ?? de.id);
        return;
      }
      // DOUBLE-click text → re-open the text panel to edit it in place. (Text isn't
      // pickable as an entity — entitySegments is empty — so it's found via its glyph
      // group's bounding box, a generous hit that lands even between letters.)
      if (doubleClick) {
        const te = this.textEntityAt(raw);
        if (te) {
          this.editText(te, e);
          return;
        }
      }
      // DOUBLE-click a plain entity → take its whole connected chain (#15); a
      // POLYGON opens its edit box (takeWhole). The FIRST press of the pair has
      // already selected that entity on its own, so this widens the selection
      // rather than replacing it from nothing. Shift / Ctrl keeps what was
      // already selected, matching the single-click modifiers below. Handled
      // before the body-drag arm, because a double-click must not start a drag.
      //
      // The double-click is also how a whole rectangle, polygon or slot is
      // taken now that a single click takes one SIDE of it (GH #17): a closed
      // shape's chain is itself. On a point with no curve under it (a centre)
      // it takes the entity the point belongs to.
      if (doubleClick) {
        const ci = pickEntity(this.entities, raw, this.pickTol());
        const under = ci >= 0 ? null : this.selKeyAt(raw);
        const ce = ci >= 0 ? this.entities[ci] : under ? this.entities.find((x) => x.id === selOwner(under)) : undefined;
        if (ce && this.takeWhole(ce.id, additiveClick(e), { x: e.clientX, y: e.clientY })) return;
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
          additive: additiveClick(e),
          key: te!.id,
          group: this.dragGroup(teIdx),
        };
        this.dragRefusedToast = false; // one refusal toast per GESTURE, not per session
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // a real (hand-drawn) entity's body under the cursor → arm a body drag;
      // a plain click (no movement) falls through to selection in endDrag()
      //
      // A click (no movement) selects what selKeyAt names under the press: a
      // corner, end or centre before a shape's side, a side before the whole
      // shape (GH #17). A shape's CENTRE is inside it, where no curve is, so a
      // press there arms the same drag for the shape it belongs to: the click
      // takes the centre, as a click on a circle's centre always took it, and
      // a drag from it moves the shape.
      const idx = pickEntity(this.entities, raw, this.pickTol());
      const key = this.selKeyAt(raw);
      const owner = idx >= 0 ? idx : key ? this.entities.findIndex((x) => x.id === selOwner(key)) : -1;
      const hit = owner >= 0 ? this.entities[owner] : undefined;
      if (hit) {
        this.moveDrag = {
          idx: owner,
          startClient: { x: e.clientX, y: e.clientY },
          last: raw.clone(),
          started: false,
          additive: additiveClick(e),
          key: key ?? hit.id,
          group: this.dragGroup(owner),
        };
        this.dragRefusedToast = false; // one refusal toast per GESTURE, not per session
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // otherwise select a profile AREA to extrude — includes patterned cells and
      // sub-areas carved by a crossing curve
      const wr = this.overlay.activeRegionAt(raw);
      if (wr) {
        this.overlay.toggleRegionSelection(wr, additiveClick(e));
        return;
      }
      // Empty space: begin a marquee. The selection is NOT cleared here any
      // more — a box drag that ends up selecting nothing clears it in endDrag,
      // and a plain click (no movement) clears it there too, so the old
      // behaviour is preserved without pre-emptively wiping a selection the
      // user may be about to extend with Shift or Ctrl.
      this.boxSel = { from: raw.clone(), to: raw.clone(), additive: additiveClick(e) };
      try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
      return;
    }
    if (PATTERN_TOOLS.has(this.tool)) return this.patternClick(p);
    if (this.tool === "arc") return this.arcClick(p);
    if (this.tool === "arcCenter") return this.arcCenterClick(p);
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
    // The four multi-click tools that offer a typed field go through
    // `multiClickAt`, never straight to their own click handler: that is where
    // the guard lives which refuses a field the user typed and the app cannot
    // read. Dispatching directly here walked PAST that guard on the gesture
    // people actually make — the Enter/OK callback in `showMultiDimFields` is
    // the other, much rarer way in, and it was the only one covered.
    if (
      this.tool === "polygon" ||
      this.tool === "slot" ||
      this.tool === "circle2" ||
      this.tool === "centerRectangle"
    ) {
      return this.multiClickAt(p);
    }
    if (this.tool === "circle3") return this.circle3Click(p); // no typed field, nothing to guard
    if (this.tool === "mirror") return this.mirrorClick(p);
    // (trim, fillet and chamfer are handled above, on the RAW cursor — see the
    // carve-out there)
    if (this.tool === "move" || this.tool === "copy") return this.moveClick(p);
    if (this.tool === "rotate") return this.rotateClick(p);
    if (this.tool === "scale") return this.scaleClick(p);
    if (this.tool === "offset") return this.offsetClick(p);
    if (this.tool === "extend") return this.extendClick(p);
    if (this.tool === "break") return this.breakClick(p);
    if (this.tool === "join") return this.joinClick(p);
    if (CONSTRAINT_TOOLS.has(this.tool)) return this.constraintClick(p);

    if (!this.base) {
      this.base = p.clone();
      this.basePinned = isGeometrySnap(hit.kind);
      this.baseRef = hit.ref ?? null;
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
      this.arcStartRef = this.lastSnapRef;
    } else if (!this.arcEnd) {
      this.arcEnd = p.clone();
      this.arcEndRef = this.lastSnapRef;
    } else {
      const id = newEntityId();
      // A tangent to the line or arc either end continues, when the arc leaves
      // it within the H/V tolerance: the bulge is re-chosen to make it exact.
      const { arc, tangents } = this.arcInference(this.arcPoints(p), id);
      const ent: ResolvedEntity = { type: "arc", id, ...arc };
      if (this.constructionMode) ent.construction = true;
      this.entities.push(ent);
      // same join the line tool gets: the arc's ends were placed by snaps, so
      // they must be CONSTRAINED to what they landed on, not merely copied from
      // it (field report ecc3e0d6). The third click is the through-point, which
      // is not a solver point and so is never emitted for.
      this.emitSnapCoincidences(ent, this.arcStartRef, this.arcEndRef);
      this.constraints.push(...tangents.map((other): SketchConstraint => ({ type: "tangent2", a: id, b: other })));
      this.clearPendingGlyph();
      this.arcStart = null;
      this.arcEnd = null;
      this.refreshActive();
      this.overlay.setPreview([]);
      this.requestSolve(); // include the arc in the solve (updates DOF colour)
      this.onState?.();
    }
  }

  // Centre-point arc: click the centre, click the start (that sets the radius),
  // then click the end. The end only chooses the ANGLE — it lands on the radius
  // — and the arc goes the way the cursor swept, which is how the user says
  // which of the two arcs between those points they mean.
  private arcCenterClick(p: THREE.Vector2) {
    const [center, start] = this.clickPts;
    if (!center) {
      this.clickPts = [p.clone()];
      this.arcCenterRef = this.lastSnapRef;
      return;
    }
    if (!start) {
      if (center.distanceTo(p) < 1e-4) return; // no radius yet: wait for a real one
      this.clickPts.push(p.clone());
      this.arcStartRef = this.lastSnapRef;
      this.arcSweep = 0;
      return;
    }
    this.arcSweep = advanceCenterArcSweep(this.arcSweep, center, start, p);
    // no sweep: the end sits on the start, and there is no arc to make yet
    if (Math.abs(this.arcSweep) * center.distanceTo(start) < 1e-4) return;
    const ent: ResolvedEntity = { type: "arc", id: newEntityId(), ...centerArcEntity(center, start, this.arcSweep) };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    // The same joins the 3-point arc gets, plus the centre, which this tool's
    // first click placed (solver point 2). The end click only chose an angle, so
    // its ref joins only where the end landed on that point (snapCoincidences).
    this.emitSnapCoincidences(ent, this.arcStartRef, this.lastSnapRef, this.arcCenterRef);
    this.clickPts = [];
    this.refreshActive();
    this.overlay.setPreview([]);
    this.requestSolve(); // include the arc in the solve (updates DOF colour)
    this.onState?.();
  }

  // MCAD-style fit-point spline: click to drop points; click the last point
  // again (or press Enter) to finish, Escape to cancel. Click the FIRST point
  // once there are three to close it on itself, with no kink where it joins.
  private splineClick(p: THREE.Vector2) {
    const last = this.splinePts[this.splinePts.length - 1];
    if (last && last.distanceTo(p) < 1e-3) {
      this.finishSpline();
      return;
    }
    if (this.splineClosesAt(p)) {
      this.finishSpline(true);
      return;
    }
    this.splinePts.push(p.clone());
  }

  /** Whether a click at `p` closes the spline being drawn: it lands on the
   *  first point (which the snap offers, splineSnapCandidates) and there are
   *  enough points to close round, three. */
  private splineClosesAt(p: THREE.Vector2): boolean {
    const first = this.splinePts[0];
    return this.splinePts.length >= MIN_CLOSED_SPLINE_POINTS && !!first && first.distanceTo(p) < 1e-3;
  }

  /** The in-progress spline's first point as a snap target, once a click there
   *  would close it. Snapping only ever offered COMMITTED geometry, so closing
   *  a spline on itself took a click that happened to land exactly on its
   *  start, and then it closed with a kink (TA 848b5ed1). Stronger than any
   *  point already in the sketch: this one is what a click there means.
   *
   *  The LAST point is how an open spline finishes, and where it sits within
   *  reach of the first, one click can be near both: then it is offered too,
   *  at the same strength, and the snap takes the nearer (snap() breaks a tie
   *  in priority by distance). Offered always, it would finish a spline at any
   *  click near its last point, where a point close to the last one used to be
   *  placed. */
  private splineSnapCandidates(): SnapCandidate[] {
    if (this.tool !== "spline") return this.candidates;
    const first = this.splinePts[0], last = this.splinePts[this.splinePts.length - 1];
    if (!first || !last || this.splinePts.length < MIN_CLOSED_SPLINE_POINTS) return this.candidates;
    const out: SnapCandidate[] = [...this.candidates, { p: first.clone(), kind: "endpoint", priority: 200 }];
    if (last.distanceTo(first) <= 2 * this.pickTol()) out.push({ p: last.clone(), kind: "endpoint", priority: 200 });
    return out;
  }

  /** Commit the spline being drawn: built as drawn (types.ts asDrawn), and
   *  `closed` when it was finished on its first point. */
  private finishSpline(closed = false) {
    if (this.splinePts.length >= 2) {
      const ent: ResolvedEntity = {
        type: "spline",
        id: newEntityId(),
        points: this.splinePts.map((q) => ({ x: q.x, y: q.y })),
        asDrawn: true,
        ...(closed ? { closed: true as const } : {}),
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
    const placed = this.splinePts.map((q) => ({ x: q.x, y: q.y }));
    // on the first point the preview closes, as the click there would
    const ent: ResolvedEntity = this.splineClosesAt(cursor)
      ? { type: "spline", id: "", points: placed, closed: true }
      : { type: "spline", id: "", points: [...placed, { x: cursor.x, y: cursor.y }] };
    this.overlay.setPreview([this.entityCurve(ent)]);
  }

  /** rubber-band preview for the multi-click primitive tools */
  private multiClickPreview(cursor: THREE.Vector2, e?: PointerEvent) {
    const pv: ResolvedEntity[] = [];
    let dims: Record<string, number> | null = null;
    if (this.tool === "polygon" && this.clickPts.length === 1) {
      const a = this.clickPts[0];
      if (a) {
        const vertex = this.polygonVertex(a, cursor);
        pv.push({ type: "polygon", id: "", x: a.x, y: a.y, radius: a.distanceTo(vertex), sides: this.previewSides(), angle: (Math.atan2(vertex.y - a.y, vertex.x - a.x) * 180) / Math.PI });
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
      if (e) this.dimAtCursor(e.clientX, e.clientY);
    }
    this.overlay.setPreview(pv.map((ent) => this.entityCurve(ent)));
  }

  // --- typed dims for the multi-click tools: the same isUserDriven gating the
  // single-drag tools use in computeGeometry(), shared by preview + commit ------

  /** True — having said so — when a field the user TYPED INTO does not hold a
   *  value the operation can legally use. Two ways it can fail, one refusal:
   *
   *  Unreadable. `getValue` returns null for text like "5mm" (or a slipped
   *  "5m") and DimInput.commit drops the field from the committed record, so
   *  every `?? default` on a commit path used to build the FALLBACK instead: the
   *  fillet Radius box silently produced a 2 mm fillet and recorded it.
   *
   *  Readable but not legal for the field. A radius of -3 parses perfectly, and
   *  used to reach filletCorner and EXTEND the leg past the corner — a wrong
   *  sketch, banked with afterModify, with no message anywhere. What counts as
   *  legal is units.dimValueOk, the SAME rule the dimension editor applies (a
   *  length is a magnitude and must be positive; an angle may be any finite
   *  value), so the two can never drift apart. `kind` therefore has to travel
   *  with the name — a bare list of names cannot tell a radius from a heading —
   *  and defaults to "length" exactly as DimFieldDef.kind does. A field whose
   *  sign is meaningful is not passed through here at all: the offset tool
   *  reads its own signed value, because there the minus IS the side.
   *
   *  `isUserDriven` is the whole distinction, and it has to stay: a field nobody
   *  opened legitimately uses its default — that is what a default is for — while
   *  a field someone typed into must refuse rather than guess. Refusing
   *  leaves the box open with the text in it, which is what the message asks for.
   *  Same branch and same message as pressPullTool/faceOffsetTool. */
  private badTypedField(...defs: { name: string; kind?: FieldKind }[]): boolean {
    for (const d of defs) {
      if (!this.dim.isUserDriven(d.name)) continue;
      if (dimValueOk(this.dim.getValue(d.name), d.kind ?? "length")) continue;
      setPrompt(t("feature.badNumber"));
      return true;
    }
    return false;
  }

  /** A polygon's side count is not merely a positive number: below 3 there is no
   *  polygon, and the entity caps at 64. polygonClick CLAMPED a typed count into
   *  that range without saying so — typing 2 built a triangle and typing 100 a
   *  64-gon, both under the number the user believed they had entered — which is
   *  the same defect as building a default under a typed value. This is the one
   *  rule dimValueOk cannot carry, because it is a range this tool owns rather
   *  than what makes a quantity valid; the refusal and the message are shared. */
  private badSideCount(): boolean {
    if (!this.dim.isUserDriven("sides")) return false;
    if (sideCountOk(this.dim.getValue("sides"))) return false;
    setPrompt(t("feature.badNumber"));
    return true;
  }

  /** The side count the polygon preview draws: the typed one while it is a
   *  count the tool can build, otherwise the last committed one. polygonSides
   *  is only written at commit, so the preview drew 6 under a typed 8 until the
   *  tick (report be869d55). A count on its way to valid ("1" on the way to
   *  "12") keeps the last committed shape rather than flickering. */
  private previewSides(): number {
    const typed = this.dim.isUserDriven("sides") ? this.dim.getValue("sides") : null;
    return sideCountOk(typed) ? Math.round(typed) : Math.max(3, Math.round(this.polygonSides));
  }

  /** The dim fields a multi-click tool shows in its current phase — one list,
   *  read both by the box and by the commit guard, so the two can never disagree
   *  about which fields the user was offered. */
  private multiDimDefs(): DimFieldDef[] | null {
    const tool = this.tool;
    return tool === "circle2"
      ? [{ name: "diameter", label: "⌀" }]
      : tool === "polygon"
        ? [{ name: "radius", label: t("sketch.dimension.label.radius") }, { name: "sides", label: t("sketch.dimension.label.count"), kind: "count" as const }]
        : tool === "centerRectangle"
          ? [{ name: "width", label: t("sketch.dimension.label.width") }, { name: "height", label: t("sketch.dimension.label.height") }]
          : tool === "slot"
            ? this.clickPts.length === 1
              ? [{ name: "length", label: t("sketch.dimension.label.length") }]
              : [{ name: "width", label: t("sketch.dimension.label.width") }]
            : null;
  }

  /** dim fields per multi-click tool (and phase, for slot); Enter commits at the
   *  cursor. Typing redraws the preview at the last cursor position, so a typed
   *  side count, radius, width or diameter shows before the mouse moves again. */
  private showMultiDimFields() {
    const defs = this.multiDimDefs();
    if (!defs) return;
    this.dim.show(
      defs,
      () => this.multiClickAt(this.lastCursor.clone()),
      undefined,
      () => this.multiClickPreview(this.lastCursor),
    );
  }

  private multiClickAt(p: THREE.Vector2) {
    // Every one of these reads its typed field through a `?? cursor` fallback,
    // so unreadable text used to commit the CURSOR's figure under the number the
    // user believed they had typed. One guard here covers all four.
    if (this.badTypedField(...(this.multiDimDefs() ?? []))) return;
    if (this.tool === "polygon" && this.badSideCount()) return;
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
    const te = id ? this.entities.find((x) => x.id === id) : undefined;
    if (te?.type === "text") return te;
    // A text that draws nothing (a font with no glyph for one of its characters)
    // has no glyphs to hit, so it is found by the frame drawn in its place.
    // Without this it could not be selected, dragged or reopened, and reopening
    // it is exactly what its message tells the user to do.
    for (const e of this.entities) {
      if (e.type !== "text") continue;
      const frame = textPlaceholder(e);
      if (frame && pointInLoop(p, frame)) return e;
    }
    return null;
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
    // Every text placed shares the preview id: start this one from nothing, not
    // from the outline of the text placed (or cancelled) before it.
    forgetText(TEXT_PREVIEW_ID);
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
    // Reopening a text the font cannot draw: say why before the first keystroke,
    // since that is usually what the user came back to fix. The panel says it
    // now, so its toast goes.
    const failure = editEntity ? textFailure(editEntity) : undefined;
    if (failure) this.textPanel.setStatus(textFailureText(failure));
    if (editEntity) {
      textFailureToasts.get(editEntity.id)?.();
      textFailureToasts.delete(editEntity.id);
    }
  }

  // --- patterns: click to place, drag to size, type counts, click to commit. Each
  // persists as an editable (associative) definition. Entity patterns (rect/circular)
  // replicate the current selection; presets emit holes. Delegates to PatternFlow
  // (see patternFlow.ts), which owns the placement/edit state live. -------------
  private patternClick(p: THREE.Vector2) {
    // entity patterns replicate the selection — drop projected reference
    // geometry from the sources BEFORE PatternFlow snapshots them
    if (ENTITY_PATTERNS.has(this.tool)) {
      for (const id of this.warnSelectedProjected()) dropOwner(this.selected, id);
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

  /** The polygon whose edit box is open, and the text each field was seeded
   *  with: a field still showing that text was not touched, so its value and
   *  any parameter binding it carries are left alone. */
  private polygonEdit: { id: string; seeded: Record<string, string> } | null = null;

  /** Edit a polygon after it is made: its radius, side count and rotation, in
   *  the same on-canvas box that drew it (report ffae1a6e, "I cannot modify a
   *  polygon's rotation after it has been created"). Nothing new is stored: the
   *  three are the polygon's own fields, and the angle is the stored one, the
   *  first corner's direction from +X in degrees. Reached by double-clicking a
   *  polygon or from its right-click menu; `at` is where that happened. */
  private editPolygon(id: string, at: { x: number; y: number }) {
    const e = this.entities.find((x) => x.id === id);
    if (e?.type !== "polygon") return;
    const defs: DimFieldDef[] = POLYGON_EDIT_FIELDS.map(([name, kind]) => ({
      name,
      label: name === "radius" ? t("sketch.dimension.label.radius")
        : name === "sides" ? t("sketch.dimension.label.count")
          : "∠",
      kind,
    }));
    this.dim.show(
      defs,
      () => this.commitPolygonEdit(),
      () => this.cancelPolygonEdit(),
      () => this.previewPolygonEdit(),
    );
    // A parameter-bound field reopens its FORMULA, the rule the radius badge
    // follows (see pendingBindings): seeded as its number, the formula was
    // invisible, and any number typed over it replaced the binding unseen.
    const seeded: Record<string, string> = {};
    for (const [name, kind] of POLYGON_EDIT_FIELDS) {
      const expr = this.exprFor(`e:${id}:${name}`);
      seeded[name] = expr && !isPlainNumber(expr) ? expr : fieldText(e[name], kind);
      this.dim.seed(name, seeded[name]);
    }
    this.polygonEdit = { id, seeded };
    this.clearSelectHover(); // the box's preview takes the layer a lit side is drawn on
    this.dim.position(at.x, at.y);
  }

  /** Draw the polygon as typed so far. A field that does not hold a usable
   *  number yet (half-typed, or a formula, which only resolves on commit) draws
   *  at its current value. */
  private previewPolygonEdit() {
    const e = this.polygonEdit && this.entities.find((x) => x.id === this.polygonEdit?.id);
    if (e?.type !== "polygon") return;
    const radius = this.dim.getValue("radius");
    const sides = this.dim.getValue("sides");
    const angle = this.dim.getValue("angle");
    this.overlay.setPreview([this.entityCurve({
      ...e,
      radius: dimValueOk(radius, "length") ? radius : e.radius,
      sides: sideCountOk(sides) ? Math.round(sides) : e.sides,
      angle: dimValueOk(angle, "angle") ? angle : e.angle,
    })]);
  }

  /** Enter / ✓ on the polygon edit box. Every changed field is evaluated before
   *  ANY is written, so a refusal leaves the polygon and the box exactly as they
   *  were. A changed field goes through the `e:<id>:<field>` binding slot the
   *  radius badge already uses: a formula binds, and a number typed over a bound
   *  field rewrites that binding instead of being overwritten by it on the next
   *  parameter sync. */
  private commitPolygonEdit() {
    const edit = this.polygonEdit;
    const e = edit && this.entities.find((x) => x.id === edit.id);
    if (!edit || e?.type !== "polygon") { this.cancelPolygonEdit(); return; }
    const writes: { field: PolygonEditField; key: string; kind: FieldKind; r: { value: number; expr: string | null; name?: string } }[] = [];
    for (const [field, kind] of POLYGON_EDIT_FIELDS) {
      const raw = this.dim.getRaw(field).trim();
      if (raw === edit.seeded[field]) continue;
      const key = `e:${e.id}:${field}`;
      const r = this.evalDimInput(canonicalDecimal(raw), kind, key);
      if ("error" in r || (field === "sides" && !sideCountOk(r.value))) {
        const error = "error" in r ? r.error : t("sketch.polygonEdit.sidesRange");
        setPrompt(t("sketch.polygonEdit.badValue", { error }));
        this.dim.focus();
        return;
      }
      writes.push({ field, key, kind, r });
    }
    if (!writes.length) { this.cancelPolygonEdit(); return; }
    const oldSides = e.sides;
    // Planned on a copy first: a shape an Offset ties to this one is re-made
    // from it (followOffsets), and one that would be left with nothing refuses
    // the edit before anything is written.
    const edited = { ...e };
    for (const w of writes) edited[w.field] = coerceForField(w.field, w.r.value);
    const follow = followOffsets(this.entities.map((x) => (x === e ? edited : x)), this.constraints, e.id, e);
    if ("refused" in follow) {
      setPrompt(t("sketch.polygonEdit.badValue", { error: followRefusal(follow.refused) }));
      this.dim.focus();
      return;
    }
    for (const w of writes) this.recordBinding(w.key, w.r, w.kind);
    this.cancelPolygonEdit();
    this.entities = follow.entities;
    // a new side count renumbers the sides and corners constraints name, on
    // this polygon and on every one that followed it; each rebind also
    // re-points any extrude that starts from or runs up to one of those
    // corners or sides.
    if (edited.sides !== oldSides) {
      rebindPolygonSides(this.entities, this.constraints, e.id, oldSides);
      this.carryPoints(polygonSidesCarry(e.id, oldSides, edited.sides));
    }
    for (const r of follow.resided) {
      rebindPolygonSides(this.entities, this.constraints, r.id, r.sides);
      const now = this.entities.find((x) => x.id === r.id);
      if (now?.type === "polygon") this.carryPoints(polygonSidesCarry(r.id, r.sides, now.sides));
    }
    this.refreshActive();
    this.requestSolve(); // banks the undo step, like every other sketch edit
    this.onState?.();
  }

  private cancelPolygonEdit() {
    this.polygonEdit = null;
    this.dim.hide();
    this.overlay.setPreview([]);
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
      this.rectCenterRef = this.lastSnapRef;
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
    // This click placed a CORNER, so a corner snapped onto a point is joined to
    // it, as the corner-to-corner rectangle's are. The first click placed the
    // CENTRE, which is a point too now (point 4), so it joins what it was
    // snapped onto, the origin most often.
    this.emitSnapCoincidences(ent, null, this.lastSnapRef, this.rectCenterRef);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- mirror: click a line; reflect the multi-selection across it -------
  private mirrorClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    const axis = idx >= 0 ? this.entities[idx] : undefined;
    if (!axis || axis.type !== "line") return;
    const owners = this.selectedOwners();
    const selectedSources = this.entities.filter((e) => owners.has(e.id) && e.id !== axis.id);
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
      return { type: "spline", id, points: e.points.map((q) => rp(q.x, q.y)), ...splineFlags(e), ...c };
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
  /** What is selected in the select tool becomes this dimension's operands
   *  when the user switches to the dimension tool (Fusion: click the line,
   *  press D): a whole line or circle, and since GH #17 a single point (a
   *  line's end, a corner, a centre) or one side of a shape. A whole
   *  rectangle, polygon or slot names no side or corner, so the tool just
   *  starts empty. A lone point stays picked, waiting for the second. */
  private seedDimPicks(keys: string[]) {
    const picks = this.selectionDimPicks(keys);
    if (!picks) return;
    // A lone LINE reads the cursor for its extents (resolveSingle), but the key
    // that armed this tool carries no cursor and the select tool's hover never
    // writes lastCursor, so it is wherever an earlier tool left it. Planned off
    // that, "click a line, press D, type 25, Enter" could come out a DX/DY.
    // Sit the cursor on the line until the mouse moves: the length, as before.
    // Two points the same way, between them, where their dimension is the
    // aligned distance (p2pDimKind): from the right-click menu, the cursor is
    // wherever the menu was.
    const [p0, p1] = picks;
    if (picks.length === 1 && p0?.kind === "entity" && p0.e.type === "line") {
      this.lastCursor.set((p0.e.x1 + p0.e.x2) / 2, (p0.e.y1 + p0.e.y2) / 2);
    } else if (p0?.kind === "point" && p1?.kind === "point") {
      this.lastCursor.copy(p0.pos).add(p1.pos).multiplyScalar(0.5);
    }
    const r = resolveDim(picks, this.dimOptions());
    if (isDimError(r)) {
      if (r.keepPicks && picks.length === 1 && picks[0]!.kind === "point") {
        this.dimPicks = picks;
        setPrompt(r.message);
        return;
      }
      if (r.message) toast(r.message);
      return; // unusable selection: start clean rather than half-armed
    }
    this.dimPicks = picks;
    this.dimPlan = r;
    setPrompt(r.hint);
    this.syncDimBox();
  }

  /** The selection `keys` as the Dimension tool's picks, or null when they
   *  make none: more than two, or a whole rectangle, polygon or slot, which
   *  names no side or corner. A point key is a point pick and a side key an
   *  edge pick, the two the tool's own clicks make there (pickDimTarget). */
  private selectionDimPicks(keys: string[]): DimTarget[] | null {
    if (!keys.length || keys.length > 2) return null; // a dimension has at most two operands
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    const picks: DimTarget[] = [];
    for (const key of keys) {
      const part = selPart(key);
      const e = byId.get(part.owner);
      if (!e) return null;
      if (part.kind === "point") {
        const pos = dimRefPoints(e).find((r) => r.p === part.p)?.pos;
        if (!pos) return null;
        picks.push({ kind: "point", e, p: part.p, pos: pos.clone() });
      } else if (part.kind === "side") {
        const seg = lineOperand(byId, key);
        if (!seg) return null;
        const k = Number(key.slice(key.indexOf("~") + 1));
        picks.push({ kind: "edge", e, k, a: new THREE.Vector2(seg.x1, seg.y1), b: new THREE.Vector2(seg.x2, seg.y2) });
      } else {
        // A whole rectangle, polygon or slot names no side or corner, which
        // is what the tool dimensions on one: start clean, the prompt saying
        // what to click, rather than refuse "there" before any click was made.
        if (isCompoundShape(e)) return null;
        picks.push({ kind: "entity", e });
      }
    }
    return picks;
  }

  /** The dimension the Dimension tool would make of selection `keys` straight
   *  away, or null when it would make none yet: what the right-click menu's
   *  Dimension item offers. Which KIND (aligned, horizontal, vertical) follows
   *  the cursor once the tool has it; whether there is one at all does not. */
  private selectionDimPlan(keys: string[]): DimPlan | null {
    const picks = this.selectionDimPicks(keys);
    if (!picks) return null;
    const r = resolveDim(picks);
    return isDimError(r) ? null : r;
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
      onLineTol: this.pickTol(),
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
      toast(t("sketch.dimension.geometryGone"));
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
    // The plan reads the cursor (dimOptions), and the cursor is HERE. A tap or a
    // synthetic press arrives with no move first, and planning off wherever the
    // last move left it turned "pick a line, type, Enter" into a horizontal or
    // vertical extent instead of the length.
    this.lastCursor.copy(p);
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
      setPrompt(this.dimHint(r));
    }
    this.dimPlace = null; // a new pick invalidates any earlier placement
    this.syncDimBox(ev);
  }

  /** The plan's own prompt, plus the state of the Reference toggle. The palette
   *  checkbox is the only thing that says Reference Dim is on, and a dimension
   *  placed with it on measures rather than drives — a difference the user only
   *  discovers later, when nothing holds (report dff87040). The plan already
   *  appends its own note when the GEOMETRY forces a driven dim. */
  private dimHint(plan: DimPlan): string {
    return this.referenceMode && plan.forceDriven !== true
      ? t("sketch.dimension.hint.referenceOn", { hint: plan.hint })
      : plan.hint;
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
      if (discarded) toast(t("sketch.dimension.retype"));
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
        toast(t("sketch.dimension.notCreated", { error: r.error }));
        this.dim.focus(); // leave the box open on the bad value
        return;
      }
      // Text nobody typed is the measurement as the box rounded it for display.
      // Committing the parse of it moved the geometry by the rounding (a 1/32"
      // line dimensioned in inches came out 0.0313"), so accept the measurement.
      // Typed digits are the user's number, even when they match the readout.
      value = this.dim.isEdited(plan.field) ? r.value : plan.measure();
      typed = { ...r, value };
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
    // A driven dim measures; it neither holds the typed value nor binds a
    // parameter to it. Say so — silence here is what let report dff87040 type
    // 50 and 100 into a rectangle, see nothing move, and be left with two
    // dimensions that could not stop an Equal constraint resizing it.
    if (isDriven(placed)) {
      if (raw !== "") {
        toast(
          this.referenceMode
            ? t("sketch.dimension.referenceOnNotApplied")
            : t("sketch.dimension.fixedEndsNotApplied"),
          { timeout: 8000 },
        );
      }
    } else if (typed && isDimConstraint(placed) && placed.id) {
      // bind exactly as the label editor does: a formula binds, and a plain
      // number over a dim that WAS bound (the id carries over on replace)
      // rewrites that binding to the literal instead of leaving a stale
      // expression behind
      this.recordBinding(`c:${placed.id}`, typed, kind);
    }
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

  /** The slice of this sketch the pattern tools work through (PatternFlow). */
  private patternHost(): PatternHost {
    return {
      tool: () => this.tool,
      setActiveTool: (t) => { this.tool = t; },
      setTool: (t) => this.setTool(t),
      selected: () => this.selected,
      patterns: () => this.patterns,
      dim: () => this.dim,
      dimAtCursor: (x, y) => this.dimAtCursor(x, y),
      refreshActive: () => this.refreshActive(),
      onState: () => this.onState?.(),
    };
  }

  /** Put a drawing tool's value box (W/H, length, offset, a pattern's
   *  counts) beside the cursor and BELOW the armed tool's chip (toolCursor).
   *  DimInput.position put the box right where the chip is drawn, so each
   *  covered the other. The box still starts at the chip's left edge. */
  private dimAtCursor(x: number, y: number) {
    this.dim.placeAt(x + CHIP_LEFT, y + CHIP_BOTTOM + 4);
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
    // A lone whole-entity pick re-plans too (a LINE's extents, resolveSingle),
    // until a value is typed: "pick, type 25, place, Enter" gave a 25 length.
    const typed = this.dimPlan != null && this.dim.isUserDriven(this.dimPlan.field);
    const lonePick = this.dimPicks.length === 1 && this.dimPicks[0]?.kind === "entity" && !typed;
    if ((this.dimPicks.length === 2 || lonePick) && !this.dimPlaced && this.dimPlan) this.refreshDimPlan();
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
    if (this.active && TRANSFORM_TOOLS.has(this.tool)) {
      this.transformHover(e);
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
        if (!w) return;
        if (this.dragDetach && !this.detachFrame(w)) return;
        this.queueDrag(w);
        return;
      }
      if (this.moveDrag) {
        const raw = this.planePoint(e);
        if (!raw) return;
        const md = this.moveDrag;
        if (!md.started) {
          const dx = e.clientX - md.startClient.x, dy = e.clientY - md.startClient.y;
          if (dx * dx + dy * dy < 16) return; // <4px: still a click, not a move
          // projected geometry never body-drags (fixed reference), and neither
          // does a selection holding some; disarm so a plain click still
          // selects it in endDrag()
          if (md.group.some((i) => this.guardProjected(this.entities[i]))) {
            this.moveDrag = null;
            return;
          }
          // A `fix` constraint pins this entity, or a neighbour corner the drag
          // would carry along. The SOLVER's own refusal (compileAndSolve's
          // dragRefused) never runs here: the body drag doesn't ask the solver
          // whether it may move, it moves and then asks it to settle — and
          // `fix` is positionless, so the settle re-pins the point at wherever
          // the drag left it and reports success (report d0b008cb). Refuse in
          // the arming branch, before anything has moved.
          if (bodyDragBlocked(this.entities, md.group, this.constraints)) {
            this.moveDrag = null;
            if (!this.dragRefusedToast) {
              this.dragRefusedToast = true;
              toast(FIXED_POINT_MSG);
            }
            return;
          }
          md.started = true;
          // nothing has moved yet — snapshot the pristine positions for Esc-revert
          this.dragSnapshot = JSON.parse(JSON.stringify(this.entities));
        }
        const dx = raw.x - md.last.x, dy = raw.y - md.last.y;
        md.last.copy(raw);
        const next = bodyDragFrame(this.entities, md.group, dx, dy, this.constraints);
        if (!next) { this.moveDrag = null; return; } // constraints changed mid-gesture
        this.entities = next;
        // ...and re-satisfy the constraints AROUND it on this frame, not on
        // release. Grabbing a filleted side used to tear every joint open until
        // the button came up (report c0bf7020): the frame moved the line and its
        // neighbours' endpoints arithmetically and the first solve was endDrag's.
        // The redraw rides the same drag step (queueBodyDrag): at most twice a
        // frame, not once per move.
        this.queueBodyDrag(md.group);
        return;
      }
      const hit = this.snapAt(e.clientX, e.clientY);
      this.showSnap(hit);
      if (this.active && this.tool === "select") {
        const raw = this.planePoint(e);
        // the point or side a click would take, lit; over one, the area
        // around it is not what a click takes, so it is not lit. Not while
        // the polygon edit box is open: the layer it would draw on holds the
        // box's live preview of the typed radius, sides and rotation.
        const part = raw && !this.polygonEdit ? this.selectHover(raw) : false;
        this.overlay.setHoverRegion(raw && !part ? this.overlay.activeRegionAt(raw) : null); // a profile area
      }
      return;
    }
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);
    if (!hit) return;
    this.lastCursor.copy(hit.p);
    this.lastSnapKind = hit.kind; // kept in step with lastCursor: the Enter-key commit reads both
    this.lastSnapRef = hit.ref ?? null;
    this.showSnap(hit);

    if (this.tool === "arc") {
      this.arcPreview(hit.p);
      return;
    }
    if (this.tool === "arcCenter") {
      this.arcCenterPreview(hit.p);
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
      this.dimAtCursor(e.clientX, e.clientY);
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
    if (entity.type !== "line" || this.tool !== "line") return this.clearPendingGlyph();
    const r = this.lineInference(entity, isGeometrySnap(cursorSnap));
    this.showPending({ ...entity, ...r.ends, id: PENDING_ID }, relationConstraints(PENDING_ID, r.relations));
  }

  /** Badge `constraints` on `entity`, an entity not drawn yet, where the
   *  committed constraints will be badged: constraintGlyphs places both, so
   *  the badge cannot sit somewhere the real one then does not. */
  private showPending(entity: ResolvedEntity, constraints: SketchConstraint[]) {
    if (!this.glyphsVisible || !constraints.length) return this.clearPendingGlyph();
    this.pendingGlyphs = constraintGlyphs([...this.entities, entity], constraints)
      .map((g) => ({ ...g, cIndex: -1, pending: true as const }));
    this.redrawGlyphs();
  }

  private clearPendingGlyph() {
    if (!this.pendingGlyphs) return;
    this.pendingGlyphs = null;
    this.redrawGlyphs();
  }

  /** Repaint the glyph layer from the committed constraints plus any pending ones. */
  private redrawGlyphs() {
    if (!this.glyphsVisible) return void this.glyphs.hide();
    const live = constraintGlyphs(this.entities, this.constraints);
    this.glyphs.show([...live, ...(this.pendingGlyphs ?? [])], this.plane, this.conflictIdx, this.overIdx);
  }

  /** The constraints a line drawn as `e` is given while drawing, and where its
   *  ends go to make them exact (inferLineRelations): `endPinned` says whether
   *  its end was placed on geometry, and its start's pinning is the gesture's.
   *  ONE function for the commit and for the badge before the click, so the
   *  badge cannot promise a constraint the click then declines. */
  private lineInference(e: Extract<ResolvedEntity, { type: "line" }>, endPinned: boolean): LineInference {
    // the palette's switch, and a typed angle, which wins over any inference
    if (this.autoConstrainOff || this.dim.isUserDriven("angle")) return { relations: [], ends: { ...e }, moved: null };
    const startPinned = this.basePinned;
    return inferLineRelations(e, {
      startPinned,
      endPinned,
      atStart: startPinned ? curvesEndingAt(this.entities, { x: e.x1, y: e.y1 }, e.id) : [],
      atEnd: endPinned ? curvesEndingAt(this.entities, { x: e.x2, y: e.y2 }, e.id) : [],
    });
  }

  /** The 3-point arc the arc tool would make with `through` as its third click. */
  private arcPoints(through: THREE.Vector2): ArcPoints {
    const a = this.arcStart!, b = this.arcEnd!;
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, mx: through.x, my: through.y };
  }

  /** The tangents an arc drawn as `arc` (id `id`) is given, and its bulge made
   *  exact for them (inferArcTangents). Shared by the commit and the badge. */
  private arcInference(arc: ArcPoints, id: string) {
    if (this.autoConstrainOff) return { arc, tangents: [] };
    return inferArcTangents(arc, {
      atStart: curvesEndingAt(this.entities, { x: arc.x1, y: arc.y1 }, id),
      atEnd: curvesEndingAt(this.entities, { x: arc.x2, y: arc.y2 }, id),
    });
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
      this.detachArmed = null;
      if (this.offsetPick) { this.cancelOffset(); return; }
      if (this.polygonEdit) { this.cancelPolygonEdit(); return; }
      if (this.dragFrom || this.moveDrag) {
        // cancel an in-progress drag: revert geometry to its pre-drag positions
        if (this.dragSnapshot) this.entities = this.dragSnapshot;
        if (this.dragConsBefore) this.constraints = this.dragConsBefore; // a Disconnect's joins
        this.dragSnapshot = null;
        this.dragConsBefore = null;
        this.dragFrom = null;
        this.moveDrag = null;
        this.pendingDrag = null;
        this.pendingPinIdxs = null;
        this.dragRelease = null;
        this.conflict = false;
        this.refreshActive();
        this.onState?.();
        return;
      }
      // a picked pivot or base point goes first; the selection stays
      if (this.transformPivot || this.moveBase) {
        this.transformPivot = null;
        this.moveBase = null;
        this.dim.hide();
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
        this.onState?.(); // a transform tool is choosing again: its prompt says so
      } else {
        this.setTool("select");
      }
      return;
    }
    if (e.key === "Enter") {
      if (this.choosingTargets) {
        e.preventDefault();
        this.finishChoosingTargets();
        return;
      }
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
    // computeGeometry() falls back to the cursor for a field it cannot read —
    // right for the live preview, wrong for the commit, which would silently
    // bank a dragged size under a typed one. Refuse here, not in the preview.
    if (this.badTypedField(...this.drawDimDefs())) return;
    const { entity } = this.computeGeometry(this.base, cursor);
    if (this.constructionMode) entity.construction = true;
    entity.id = newEntityId(); // stamp a stable id (computeGeometry left it "")
    this.entities.push(entity);
    // Turn the snaps that PLACED this entity into real coincident constraints,
    // before anything else can move either side. Snapping used to copy the
    // coordinate and stop, so the join lasted exactly until the next solve —
    // "the tool creates a very small gap of a few hundredths of a millimetre...
    // these micro-gaps prevent the lines from being truly joined and can
    // subsequently cause cracks during extrusion, as well as undetected or
    // missing regions" (field report ecc3e0d6).
    this.emitSnapCoincidences(entity, this.baseRef, this.lastSnapRef);
    if (this.tool === "line" && entity.type === "line") {
      const end = new THREE.Vector2(entity.x2, entity.y2);
      // clicked back on the start point → close the loop and end the chain
      const closing = this.chainStart != null && end.distanceTo(this.chainStart) < 1e-3;
      // auto-infer H/V, perpendicular or tangent (skip the closing seg + typed
      // angles). Both ends carry whether they were snapped ONTO existing
      // geometry, so the correction never moves a point the user deliberately
      // joined.
      if (!closing) {
        const r = this.lineInference(entity, isGeometrySnap(this.lastSnapKind));
        Object.assign(entity, r.ends);
        this.constraints.push(...relationConstraints(entity.id, r.relations));
      }
      this.clearPendingGlyph(); // added now: its own badge takes over
      if (closing) {
        this.base = null;
        this.chainStart = null;
        this.dim.hide();
      } else {
        this.base = new THREE.Vector2(entity.x2, entity.y2); // snapped endpoint
        // The next segment starts ON this one's end, so that start is pinned
        // whether or not this end was snapped: it is committed geometry now.
        // Pinning it only after a snap let auto-V make the next segment exact
        // by moving its START, 0.26 mm off this end at 1.5 degrees, and nothing
        // joined the two segments to pull them back together.
        this.basePinned = true;
        // ...and joined: the next segment's start is this one's end, so the
        // corner between them gets a real coincident, not just one coordinate
        // (GitHub #17: "corners inside one continuous chain of lines are placed
        // on each other but not constrained yet"). Whatever this end snapped
        // onto is joined to it already, and so to the next segment through it.
        this.baseRef = { id: entity.id, idx: 1 };
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

  /** Record the `coincident` constraints a freshly drawn entity owes to the
   *  snaps that placed it. The decision lives in `snapCoincidences` (snap.ts),
   *  which is pure and therefore testable without booting a viewport; this only
   *  hands it the current state and appends what comes back. */
  private emitSnapCoincidences(
    entity: ResolvedEntity,
    startRef: PointRef | null,
    endRef: PointRef | null,
    centerRef: PointRef | null = null,
  ) {
    this.constraints.push(
      ...snapCoincidences(entity, startRef, endRef, this.entities, this.constraints, centerRef),
    );
  }

  /** The dim fields the drag-draw tools show — see multiDimDefs for why this is
   *  its own function rather than an expression inside show(). */
  private drawDimDefs(): DimFieldDef[] {
    return this.tool === "rectangle"
      ? [{ name: "width", label: t("sketch.dimension.label.width") }, { name: "height", label: t("sketch.dimension.label.height") }]
      : this.tool === "circle"
        ? [{ name: "diameter", label: "⌀" }]
        : [
            { name: "length", label: t("sketch.dimension.label.length") },
            { name: "angle", label: "∠", kind: "angle" as const },
          ];
  }

  private showDimFields() {
    this.dim.show(this.drawDimDefs(), () => this.commitFromCursor(this.lastCursor));
  }

  // --- snapping + rendering ---------------------------------------------
  private snapAt(clientX: number, clientY: number, noSnap = false) {
    const world = this.viewport.screenToPlane(clientX, clientY, this.plane.plane);
    if (!world) return null;
    const p2d = this.plane.to2D(world);
    // Hold Ctrl to suppress snapping for fine placement (raw cursor position).
    if (noSnap) return { p: p2d, kind: "free" as SnapKind, world, ref: undefined as PointRef | undefined };
    const res = snap(
      p2d,
      this.splineSnapCandidates(), // the cached candidates, plus a spline being drawn's own start
      (q) => this.viewport.projectToScreen(this.plane.to3D(q.x, q.y)),
      this.gridSnap ? this.gridCell : 0,
    );
    return { p: res.point, kind: res.kind, ref: res.ref, world: this.plane.to3D(res.point.x, res.point.y) };
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
      // a whole entity in the selection colour; a selected point or side of
      // one in it ON the entity, which keeps its own colour (GH #17)
      const normal = this.entities.filter((e) => !this.selected.has(e.id));
      const chosen = this.entities.filter((e) => this.selected.has(e.id));
      if (normal.length) objs.push(...curveObjects(normal, this.plane, this.activeColor(), false, epR));
      if (chosen.length) objs.push(...curveObjects(chosen, this.plane, SELECT_COLOR, true));
      objs.push(...this.partObjects([...this.selected], SELECT_COLOR));
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

  /** The points and sides among selection `keys`, drawn in `color` over the
   *  entities they belong to: a side as its own line, a point as the square a
   *  resting endpoint dot is, bigger. Whole-entity keys draw nothing here. */
  private partObjects(keys: string[], color: number): THREE.Object3D[] {
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    const out: THREE.Object3D[] = [];
    for (const key of keys) {
      const part = selPart(key);
      if (part.kind === "side") {
        const seg = lineOperand(byId, key);
        if (!seg) continue;
        for (const o of curveObjects([{ type: "line", id: key, ...seg } as ResolvedEntity], this.plane, color, true)) {
          o.renderOrder = 13; // over the outline it is part of
          out.push(o);
        }
      } else if (part.kind === "point") {
        const owner = byId.get(part.owner);
        const q = owner ? dimRefPoints(owner).find((r) => r.p === part.p)?.pos : undefined;
        if (q) out.push(pointHighlight(this.plane, q.x, q.y, color, this.endpointDotRadius() * 1.7));
      }
    }
    return out;
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
    const cornerTool = this.tool === "fillet" || this.tool === "chamfer";
    const first = this.filletFirst != null ? this.entities[this.filletFirst] : undefined;
    if (first) {
      // A rectangle presents four LINE OPERANDS and no operand of its own, so
      // highlighting the entity lit all four sides when the user had armed one
      // of them: the right constraint, and feedback that pointed at the wrong
      // thing. Draw the edge actually picked, when the flow is holding one.
      // SketchMode's own Fillet and Chamfer share `filletFirst` and hold the
      // side they took in `filletSide` (null for a plain line).
      const opId = cornerTool ? this.filletSide : this.constraintTools.heldOperandId();
      const seg = opId && opId !== first.id
        ? lineOperand(new Map(this.entities.map((e) => [e.id, e])), opId)
        : null;
      preview.push(...curveObjects(
        seg ? [{ type: "line", id: first.id, ...seg } as ResolvedEntity] : [first],
        this.plane, 0x33aaff, true,
      ));
    }
    const hit = idx >= 0 ? this.entities[idx] : undefined;
    // A constraint tool takes a rectangle's EDGE, never the rectangle, so it
    // highlights the edge under the cursor and not all four sides — the
    // difference a reporter saw against the dimension tool and read as "the
    // rectangle is one entity, not lines" (hoverOperandCurve). Trim removes a
    // SPAN, so it highlights exactly the piece the click would take away, from
    // the same plan the click uses (trimSpan) and the same raw cursor: lighting
    // the whole line told a reporter the whole line was about to go. Move and
    // the rest act on the whole entity and keep the whole highlight. Coincident
    // asks ConstraintTools, because its click can take ANOTHER shape's edge than
    // the nearest one, or none at all (ConstraintTools.hoverCurve).
    //
    // Fillet and Chamfer take a line, or ONE side of a rectangle or polygon
    // (cornerPick). They lit a shape's whole outline red, inviting a click that
    // was then dropped without a word (reports 5650b766, be869d55), so they
    // light only the side the click would take, and nothing on a slot, which
    // has no corner to take.
    //
    // A slot's AXIS is a line every constraint tool takes, and it is inside
    // the slot where no curve is under the cursor: lit on its own when the
    // cursor is on it and on nothing else (slotAxisAt, the pick's own rule).
    const axis = (!hit || isOriginGeometry(hit.id)) && CONSTRAINT_TOOLS.has(this.tool) ? this.slotAxisCurve(p) : null;
    const curve = axis ?? (hit
      ? (this.tool === "trim" ? this.trimPreview(idx, hit, p)
        : this.tool === "coincident" ? this.constraintTools.hoverCurve(p)
        : cornerTool ? this.cornerSideCurve(hit, p)
        : CONSTRAINT_TOOLS.has(this.tool) ? hoverOperandCurve(hit, p)
        : hit)
      : this.tool === "coincident" ? this.constraintTools.hoverCurve(p)
      : null);
    if (curve) preview.push(...curveObjects([curve], this.plane, 0xff5555, true));
    // Where curves held tangent touch, drawn as points while Trim is armed: a
    // trim stops at a touch as it does at a crossing (Doug, 25), and a curve
    // that runs smoothly into another shows nowhere where that is.
    if (this.tool === "trim") {
      for (const q of tangencyPoints(this.entities, this.constraints)) {
        preview.push(pointHighlight(this.plane, q.x, q.y, ENDPOINT_COLOR, this.endpointDotRadius() * 1.4));
      }
    }
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

  /** the slot axis under `p` as a synthetic line, for the hover, or null */
  private slotAxisCurve(p: THREE.Vector2): ResolvedEntity | null {
    const axis = slotAxisAt(this.entities, p, this.pickTol());
    const seg = axis ? lineOperand(new Map(this.entities.map((e) => [e.id, e])), axis) : null;
    return axis && seg ? ({ type: "line", id: axis, ...seg } as ResolvedEntity) : null;
  }

  /** What the Trim hover lights: the piece the click would remove, or nothing
   *  when the click would refuse (the origin, projected geometry), because red
   *  there would promise a trim that cannot happen. */
  private trimPreview(idx: number, hit: ResolvedEntity, p: THREE.Vector2): ResolvedEntity | null {
    if (isOriginGeometry(hit.id) || hit.type === "projected") return null;
    return trimSpan(this.entities, idx, p);
  }

  /** The addressable point under the cursor FOR THE ACTIVE TOOL, or null when
   *  the tool does not take one.
   *
   *  Scoped rather than universal on purpose. Trim, fillet, move and the rest of
   *  MODIFY_TOOLS act on curves, not on points, so lighting up a point while one
   *  of them is armed would promise a target the tool cannot use — the same class
   *  of lie as a target you can hit but cannot see, which is what rectangle
   *  corners were until this release. */
  private hoverablePoint(p: THREE.Vector2): { x: number; y: number } | null {
    // Constraint flows: ask ConstraintTools, so the highlight and the click
    // cannot disagree about which point is addressable.
    if (CONSTRAINT_TOOLS.has(this.tool)) return this.constraintTools.hoverPoint(p);
    if (this.tool !== "dimension") return null;
    // Dimensioning resolves through dimRefPoints — the same list the constraint
    // picker enumerates since 2026-09-05, so the two hovers now light the same
    // points. They did NOT before: a circle or arc centre was dimensionable and
    // fixable while every constraint tool ignored it, and a click on one landed
    // on nothing at all.
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
    const owners = this.selectedOwners();
    this.entities = this.entities.filter((en) => !owners.has(en.id) || isOriginGeometry(en.id));
    this.selected.clear();
    dismissContextMenu(); // the Delete key can fire while the right-click menu is open
    this.afterModify();
  }

  /** Right-click in select mode: select the entity under the cursor (if any) and
   *  offer Delete. Leaves camera navigation alone when nothing is hit/selected. */
  /** Push a constraint a constraint tool or the right-click menu made, with
   *  the `holds` it needs (ConstraintHost.addConstraint), and solve, as one
   *  TRIAL: withdrawn together if that solve conflicts. `moves` arms the
   *  mover bias for that solve. */
  private addTrialConstraint(c: SketchConstraint, moves?: string, holds: readonly SketchConstraint[] = []) {
    this.constraints.push(...holds, c);
    this.trial = { cons: [...holds, c], msg: SketchMode.CONSTRAINT_CONFLICT_MSG }; // withdrawn again if this solve conflicts
    if (moves) this.pendingBias = { moves: [moves] }; // before requestSolve — pump reads it synchronously
    this.requestSolve();
  }

  /** Apply a constraint straight to an already-chosen selection, as the
   *  operands constraintMenu read off it (menuOperands): whole lines and
   *  rounds, sketch points, and a shape's side or corner the right-click named.
   *
   *  Only reached for selections `applicableConstraints` vouched for. The
   *  constraint objects are the same shapes ConstraintTools builds; this is a
   *  second ENTRY POINT to them, not a second implementation of them. `moves`
   *  names one entity for the solver bias, as the click tools stamp their
   *  first pick: a selection has no pick order, so it is the first selected,
   *  except that the side or corner the right-click NAMED (`named`) stays and
   *  the other one comes to it (made parallel to a rectangle's side, a line has
   *  to turn, and naming the rectangle the mover resized it on the way). A
   *  point put On a curve or at a Midpoint is what moves, named or not, as
   *  with the tool. Equal on two
   *  rounds and Tangent are the tools' forms too (equalRadius, tangent2): the
   *  line-only `equal` and the circle-only `tangent` this used to emit
   *  compiled to nothing on circles and arcs, and were dropped by the next
   *  edit. */
  private applyConstraintToSelection(t: SketchTool, ops: MenuOperand[], named: MenuOperand | null = null, at: { x: number; y: number } | null = null) {
    const a = ops[0], b = ops[1];
    if (!a) return;
    const mover = (named && ops.find((o) => o !== named)) || a;
    const pushAll = (cs: SketchConstraint[], moves: string[]) => {
      this.constraints.push(...cs);
      this.trial = { cons: cs, msg: SketchMode.CONSTRAINT_CONFLICT_MSG }; // withdrawn again if this solve conflicts
      this.pendingBias = { moves };
      this.requestSolve();
      this.onState?.();
    };
    // the single-constraint path also carries `holds` (constraints a spline's
    // partial-curve tangency needs alongside it, e.g. an On to pin the point),
    // which addTrialConstraint pushes together with `c` as one withdrawable trial
    const push = (c: SketchConstraint, moves = mover.ent.id, holds?: readonly SketchConstraint[]) => {
      this.addTrialConstraint(c, moves, holds);
      this.onState?.();
    };
    if (t === "horizontal") return push({ type: "horizontal", line: a.id });
    if (t === "vertical") return push({ type: "vertical", line: a.id });
    if (t === "fix") return push({ type: "fix", e: a.id, p: a.p });
    if (t === "symmetric") {
      // the first point is what moves, onto the second's mirror, as with the
      // tool's three clicks
      const sym = symmetricOperands(ops);
      if (!sym) return;
      return push({ type: "symmetric", e1: sym.a.id, p1: sym.a.p, e2: sym.b.id, p2: sym.b.p, line: sym.line.id }, sym.a.ent.id);
    }
    if (t === "equal" && ops.length > 2) {
      // Several, held to the size of the LAST picked: a pair's first pick is
      // what moves (bug #86), and a chain moves every one but the last.
      const last = ops[ops.length - 1]!;
      const rest = ops.slice(0, -1);
      return pushAll(
        rest.map((o): SketchConstraint => (o.kind === "line"
          ? { type: "equal", l1: o.id, l2: last.id }
          : { type: "equalRadius", a: o.id, b: last.id })),
        rest.map((o) => o.ent.id),
      );
    }
    if (!b) return;
    if (t === "parallel") return push({ type: "parallel", l1: a.id, l2: b.id });
    if (t === "perpendicular") return push({ type: "perpendicular", l1: a.id, l2: b.id });
    if (t === "collinear") return push({ type: "collinear", l1: a.id, l2: b.id });
    if (t === "concentric") return push({ type: "concentric", c1: a.id, c2: b.id });
    if (t === "equal") {
      return push(a.kind === "line" ? { type: "equal", l1: a.id, l2: b.id } : { type: "equalRadius", a: a.id, b: b.id });
    }
    if (t === "tangent" && (a.kind === "spline" || b.kind === "spline")) {
      // at the joint nearer the right-click, when both of the spline's ends
      // meet the other curve; the SPLINE turns to the curve it meets, as a
      // point put On a curve is what moves (a selection has no pick order)
      const [sp, other] = a.kind === "spline" ? [a, b] : [b, a];
      const pick = (o: MenuOperand) => ({ id: o.id, ent: o.ent, at: at ?? dimRefPoints(o.ent)[0]?.pos ?? { x: 0, y: 0 } });
      const made = splineTangentFor(pick(sp), pick(other), this.entities, this.constraints);
      if ("why" in made) return void toast(made.why);
      return push(made.c, sp.ent.id, made.hold ? [made.hold] : []);
    }
    if (t === "tangent") return push({ type: "tangent2", a: a.id, b: b.id });
    const point = a.kind === "point" ? a : b;
    const other = point === a ? b : a;
    if (point.kind !== "point") return;
    if (t === "coincident") {
      // two points join; a point goes ON a line, circle or arc, and it is the
      // point that moves, as with the tool
      if (other.kind === "point") return push({ type: "coincident", e1: a.id, p1: a.p, e2: b.id, p2: b.p });
      return push({ type: "pointOn", e: point.id, p: point.p, curve: other.id }, point.ent.id);
    }
    if (t === "midpoint") return push({ type: "midpoint", e: point.id, p: point.p, line: other.id }, point.ent.id);
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
    // A right-click on geometry the selection does not touch selects what a
    // left click there would (selKeyAt: a point, a side, an entity). On
    // geometry it does touch, the selection stays as it is. With Shift, Ctrl
    // or Cmd held it ADDS what is under it, as that click would: picking
    // points with Ctrl held and right-clicking the last one (GH #17) must not
    // throw the others away. A shape already held whole stays whole.
    const key = raw ? this.selKeyAt(raw) : null;
    const hit = key ? this.entities.find((x) => x.id === selOwner(key)) : undefined;
    if (key && hit && additiveClick(e)) {
      if (!this.selected.has(key) && !this.selected.has(hit.id)) {
        addKey(this.selected, key);
        this.refreshActive();
      }
    } else if (key && hit && !this.selectedOwners().has(hit.id)) {
      this.selected = new Set([key]);
      this.refreshActive();
    }
    if (!this.selected.size) return; // nothing to act on → let nav handle it
    e.preventDefault();
    const owners = this.selectedOwners();
    const n = owners.size;
    const linked = this.selectedProjectedIds().size;
    // Constraints that actually APPLY to this selection, first — GH #17's
    // "a small menu showing only the valid/possible constraints for that
    // selection". Offering them here is what makes them findable at all: the
    // constraint tools live behind a caret in a ribbon group that collapses into
    // an overflow menu on a laptop-width window, which is how two testers
    // independently failed to find them.
    const selEnts = this.entities.filter((e) => owners.has(e.id));
    // On a rectangle, polygon or slot selected WHOLE (a box, a double-click)
    // the right-click names the corner, centre or side under the cursor, the
    // way a click of a constraint tool would (constraintMenu.operandUnder):
    // that is what makes the menu able to offer anything for a whole shape.
    // A point or side selected on its own is its own operand (menuOperands).
    const tol = this.pickTol();
    const wholeShapes = selEnts.filter((s) => isCompoundShape(s) && this.selected.has(s.id));
    const named = !raw ? null
      : hit && wholeShapes.includes(hit) ? operandUnder(hit, raw, tol)
        : wholeShapes.map((s) => operandUnder(s, raw, tol)).find((o) => o?.kind === "point") ?? null;
    const ops = menuOperands(this.selected, new Map(this.entities.map((x) => [x.id, x])), named) ?? [];
    const cons = applicableConstraints(ops);
    // "Distance" from a selection is a dimension: it needs a value, so the
    // item hands the selection to the Dimension tool (seedDimPicks), which
    // asks for one. Offered when that tool can dimension the selection.
    const dimensionable = this.selectionDimPlan([...this.selected]) !== null;
    // Lock and the construction toggle are offered here for the same reason the
    // constraints are: this menu is where a selection's actions get found
    // (reports d3338e3a and 2fc27cf1).
    const lockable = selEnts.some((e) => !isOriginGeometry(e.id) && measuredLocks(this.constraints, e).length > 0);
    const convertible = this.constructionTargets().length > 0;
    const toNormal = convertible && this.selectionMostlyConstruction();
    const constructionKey = keyHint("toggle-construction");
    // A right-click on a point several curves share: the place a user stuck
    // with Break's joined halves looks for a way to pull them apart, so offer
    // it there. It arms the same pull a Shift-drag makes (detachFrame).
    const joint = raw ? pickDragPoint(this.entities, raw, this.pickTol()) : null;
    const canDetach = !!(raw && joint && detachableEnd(this.entities, joint, raw));
    const lone = selEnts.length === 1 ? selEnts[0] : undefined;
    const at = { x: e.clientX, y: e.clientY };
    const items: CtxItem[] = [
      ...(lone?.type === "polygon"
        ? [
          { label: t("sketch.menu.editPolygon"), onClick: () => this.editPolygon(lone.id, at) },
          { separator: true, label: "" } as CtxItem,
        ]
        : []),
      ...cons.map((tool) => ({
        label: constraintLabel(tool),
        onClick: () => this.applyConstraintToSelection(tool, ops, named, raw),
      })),
      ...(dimensionable ? [{ label: constraintLabel("dimension"), onClick: () => this.setTool("dimension") }] : []),
      ...(lockable
        ? [{ label: t("sketch.menu.lockDimensions"), onClick: () => this.lockMeasuredDims(this.selectedOwners()) }]
        : []),
      ...(cons.length || dimensionable || lockable ? [{ separator: true, label: "" } as CtxItem] : []),
      ...(convertible
        ? [{
          label: toNormal ? t("sketch.menu.makeNormal") : t("sketch.menu.makeConstruction"),
          ...(constructionKey ? { shortcut: constructionKey } : {}),
          onClick: () => { this.setSelectedConstruction(!toNormal); },
        }]
        : []),
      ...(selEnts.some(isCompoundShape)
        ? [{ label: t("sketch.menu.explode"), onClick: () => this.explodeSelected() }]
        : []),
      ...(linked
        ? [{ label: linked > 1 ? t("sketch.menu.breakLinkCount", { count: linked }) : t("sketch.menu.breakLink"), onClick: () => this.breakSelectedLinks() }]
        : []),
      ...(canDetach && joint
        ? [{ label: t("sketch.menu.disconnect"), onClick: () => this.armDisconnect(joint) }]
        : []),
      { label: t("sketch.menu.deleteEntities", { count: n }), danger: true, onClick: () => this.deleteSelected() },
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
        label: check(this.dimTangentArmed, t("sketch.dimension.tangentPick")),
        onClick: () => {
          this.dimTangentArmed = !this.dimTangentArmed;
          setPrompt(this.dimTangentArmed
            ? t("sketch.dimension.tangentArmed")
            : t("sketch.dimension.tangentCleared"));
        },
      },
      { separator: true, label: "" },
      {
        label: check(lone && !isDia, t("common.radius")), disabled: !lone,
        onClick: () => this.setDimRoundPref("radius"),
      },
      {
        label: check(lone && isDia, t("common.diameter")), disabled: !lone,
        onClick: () => this.setDimRoundPref("diameter"),
      },
      { separator: true, label: "" },
      {
        label: check(this.referenceMode, t("sketch.dimension.drivenReference")),
        onClick: () => { this.setReferenceDim(!this.referenceMode); this.onState?.(); },
      },
      { separator: true, label: "" },
      { label: t("common.ok"), disabled: !plan, onClick: () => { if (this.dimPlan) this.commitDim(); } },
      { label: t("common.cancel"), onClick: () => this.cancelDim() },
    ];
    contextMenu(e.clientX, e.clientY, items);
  }

  /** Fusion's in-command marking menu for the Offset tool: the two things the
   *  cursor alone can't say — whether to take the whole connected chain, and
   *  which side to land on when the cursor is nowhere near the curve. */
  private openOffsetMenu(e: MouseEvent) {
    e.preventDefault();
    const pick = this.offsetPick;
    // The right-click that opened this menu blurred the distance box, and a menu
    // item cannot hand focus back. After an item that leaves the pick open, the
    // distance typed next went nowhere and Enter did nothing, with no message
    // (field report 356b2693's right-click path), so give the box focus again.
    const keepTyping = () => { if (this.offsetPick) this.dim.focus(); };
    contextMenu(e.clientX, e.clientY, [
      {
        label: `${this.offsetChainMode ? "✓ " : "    "}${t("sketch.offset.chainSelection")}`,
        onClick: () => {
          this.offsetChainMode = !this.offsetChainMode;
          setPrompt(this.offsetChainMode
            ? t("sketch.offset.chainOn")
            : t("sketch.offset.chainOff"));
          if (pick) this.noteChainJunction(pick.idx);
          keepTyping();
        },
      },
      {
        label: t("common.flip"), disabled: !pick,
        onClick: () => { if (pick) pick.side = -pick.side; keepTyping(); },
      },
      { separator: true, label: "" },
      { label: t("common.ok"), disabled: !pick, onClick: () => { if (pick) this.commitOffset(); } },
      { label: t("common.cancel"), disabled: !pick, onClick: () => this.cancelOffset() },
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
  /** Trim the span under the cursor, carrying over every constraint that still
   *  applies to what is left (trimWithConstraints). What can no longer apply is
   *  removed, and said: a length on a shortened line, a Fix on an end that is
   *  gone. Trim used to drop those, and constraints that still held, without a
   *  word (report 356b2693).
   *
   *  The piece that keeps the curve's id is still that curve
   *  (trimWithConstraints), so what named it follows it: a pattern copies
   *  every piece, an extrude on one of its points goes where the point went,
   *  and an extrude on an area the id would now name wrongly is re-pointed.
   *  An extrude on a point the trim removed is refused at the build, and a
   *  projection of the curve in another sketch keeps its last shape, flagged
   *  stale, as both were when Trim made every id new. A projection that
   *  followed the kept piece would move without a word: a circle trimmed to an
   *  arc renumbers its centre from 0 to 2, so a constraint on the projected
   *  centre would hold the arc's start instead.
   *
   *  Each end the trim cut is joined to the curve it was cut against (cutJoins),
   *  in the same undo step, on trial like a fillet's constraints: a sketch that
   *  cannot take a join keeps the trim and loses only the joins, and a join the
   *  rest of the sketch already implies is dropped rather than painted amber.
   *  In a sketch that is red already, only a join the solve blames goes. */
  private trimClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    const cut = this.entities[idx]!;
    const regions = this.regionsBeforeRename();
    const copiers = this.patterns.filter((pat) => "sources" in pat && pat.sources.includes(cut.id)).map((pat) => pat.id);
    const had = new Set(this.entities.map((e) => e.id));
    const res = trimWithConstraints(this.entities, idx, p, this.constraints);
    this.entities = res.entities;
    this.constraints = [...res.constraints, ...res.joins];
    const became = this.entities.filter((e) => e.id === cut.id || !had.has(e.id)).map((e) => e.id);
    for (const pat of this.patterns) {
      if ("sources" in pat && pat.sources.includes(cut.id)) pat.sources = pat.sources.flatMap((id) => (id === cut.id ? became : [id]));
    }
    this.carryPieces(cut, res);
    const trimmed = this.trimmedCurves ?? []; // a SketchMode built without its constructor (the test kits)
    if (this.entities.some((e) => e.id === cut.id) && !trimmed.includes(cut.id)) this.trimmedCurves = [...trimmed, cut.id];
    // A copy a pattern made of the curve is renumbered once the curve is in
    // pieces (expandPattern numbers copies by position), so an area named by
    // one is treated like an area named by the curve itself.
    this.carryRegionRefs(regions, (id) => id === cut.id || copiers.some((pid) => id.startsWith(`${pid}#`)));
    if (res.joins.length) {
      this.trial = {
        cons: res.joins,
        msg: t("sketch.modify.trimJoinConflict"),
        dropRedundant: () => {},
        alreadyConflicting: this.conflict,
      };
    }
    const before = this.constraints.length;
    this.afterModify(); // prunes too: anything it still finds dangling counts
    const dropped = res.dropped + before - this.constraints.length;
    if (dropped > 0) toast(t("sketch.modify.trimDropped", { count: dropped }));
  }
  /** A Trim or a Break gives every piece a new id (trimWithConstraints says
   *  why), so an extrude that starts from or runs up to a point or a line of
   *  `cut` goes to the piece that still has it: a rectangle's corner to the
   *  line end it is now, its side to its line. It used to say "was deleted
   *  from its sketch" about a side still drawn. */
  private carryPieces(cut: ResolvedEntity, res: TrimResult) {
    this.carryPoints({
      [cut.id]: Object.fromEntries([
        ...Object.entries(res.points).map(([k, q]) => [k, { entity: q.e, pointIndex: q.p }]),
        ...Object.entries(res.lines).map(([id, line]) => [id.slice(cut.id.length), { entity: line }]),
      ]),
    });
  }
  private filletClick(p: THREE.Vector2) {
    const pick = this.cornerPick(p);
    if (!pick) return;
    if (this.filletFirst == null) {
      this.filletFirst = pick.idx;
      this.filletSide = pick.side;
      return;
    }
    if (pick.idx === this.filletFirst && pick.side === this.filletSide) return;
    const first = { idx: this.filletFirst, side: this.filletSide };
    if (this.refuseFarSides(first, pick)) return;
    this.dim.show([{ name: "radius", label: t("sketch.dimension.label.radius"), kind: "length" }], () =>
      this.applyFillet(first, pick),
    );
  }
  /** Apply the fillet AND record what it means: two tangencies and the radius
   *  that was typed. Without them the number lived nowhere — an arc carries no
   *  automatic badge dimension, so nothing was drawn, nothing was editable, and
   *  the next solve was free to resize the arc (report 41dc3246).
   *
   *  On trial, as a set: the fillet's geometry is correct whether or not the
   *  constraints can coexist with what the sketch already carries, so a conflict
   *  withdraws the three constraints and says so — it must not withdraw, or
   *  refuse, the fillet.
   *
   *  A pick on a rectangle or polygon side explodes that shape into lines first
   *  (cornerLines), and only when the fillet then fits: two sides that do not
   *  meet, or a radius too big for them, leave the shape a shape. */
  private applyFillet(a: CornerPick, b: CornerPick) {
    if (this.badTypedField({ name: "radius" })) return; // before ANY mutation: the pick and the box stay live
    const r = this.dim.getValue("radius") ?? 2;
    const regions = this.regionsBeforeRename();
    const plan = this.cornerLines(a, b);
    const res = plan ? filletCorner(plan.entities, plan.iA, plan.iB, r) : null;
    this.filletFirst = null;
    this.dim.hide();
    if (plan && res) {
      this.commitExplodes(plan.exploded, "fillet");
      this.commitCorner(plan, res.entities, "fillet"); // the corner is gone
      this.constraints.push(...res.constraints);
      this.trial = {
        cons: res.constraints,
        msg: t("sketch.constraint.filletRadiusConflict"),
      };
      this.carryRegionRefs(regions);
    } else {
      toast(t("sketch.modify.cornerNoFit", { tool: t("tool.fillet") }));
    }
    this.afterModify();
  }
  private chamferClick(p: THREE.Vector2) {
    const pick = this.cornerPick(p);
    if (!pick) return;
    if (this.filletFirst == null) {
      this.filletFirst = pick.idx;
      this.filletSide = pick.side;
      return;
    }
    if (pick.idx === this.filletFirst && pick.side === this.filletSide) return;
    const first = { idx: this.filletFirst, side: this.filletSide };
    if (this.refuseFarSides(first, pick)) return;
    this.dim.show([{ name: "distance", label: t("sketch.dimension.label.distance"), kind: "length" }], () =>
      this.applyChamfer(first, pick),
    );
  }
  private applyChamfer(a: CornerPick, b: CornerPick) {
    if (this.badTypedField({ name: "distance" })) return; // before ANY mutation: the pick and the box stay live
    const d = this.dim.getValue("distance") ?? 2;
    const regions = this.regionsBeforeRename();
    const plan = this.cornerLines(a, b);
    const res = plan ? chamferCorner(plan.entities, plan.iA, plan.iB, d) : null;
    if (plan && res) {
      this.commitExplodes(plan.exploded, "chamfer");
      this.commitCorner(plan, res, "chamfer"); // as applyFillet
      this.carryRegionRefs(regions);
    } else {
      toast(t("sketch.modify.cornerNoFit", { tool: t("tool.chamfer") }));
    }
    this.filletFirst = null;
    this.dim.hide();
    this.afterModify();
  }

  /** The curve a Fillet or Chamfer click at `p` on `e` would take, to light
   *  it: the line itself, or the one side of a rectangle or polygon, as a
   *  synthetic line. Null for anything the click refuses. */
  private cornerSideCurve(e: ResolvedEntity, p: THREE.Vector2): ResolvedEntity | null {
    if (e.type === "line") return e;
    const side = e.type === "rectangle" ? lineOperandAt(e, p) : e.type === "polygon" ? shapeSideAt(e, p) : null;
    const seg = side ? lineOperand(new Map([[e.id, e]]), side) : null;
    return seg ? ({ type: "line", id: side!, ...seg } as ResolvedEntity) : null;
  }

  /** What a Fillet or Chamfer click takes: a line, or one SIDE of a rectangle
   *  or polygon (`<id>~k`, the side the hover lit), which the tool turns into a
   *  line when it runs (explode, round 1 decision 2). Null, after saying why
   *  when there is something to say, for anything else.
   *
   *  A slot is refused: its straight sides are parallel and its ends already
   *  round, so it has no corner for either tool. So is a shape a parameter
   *  sizes (explodeRefusal). The pick already armed, if any, stays armed. */
  private cornerPick(p: THREE.Vector2): CornerPick | null {
    const idx = pickEntity(this.entities, p, this.pickTol());
    const e = idx >= 0 ? this.entities[idx] : undefined;
    if (!e || this.guardProjected(e)) return null;
    if (e.type === "line") return { idx, side: null };
    const tool = this.tool === "chamfer" ? t("tool.chamfer") : t("tool.fillet");
    if (e.type === "slot") {
      toast(t("sketch.modify.slotNoCorner", { tool }), { timeout: 8000 });
      return null;
    }
    const side = e.type === "rectangle" ? lineOperandAt(e, p) : e.type === "polygon" ? shapeSideAt(e, p) : null;
    if (!side) return null;
    const why = this.explodeRefusal(e);
    if (why) { toast(why, { timeout: 8000 }); return null; }
    return { idx, side };
  }

  /** The two corner picks as LINES, in a COPY of the sketch: a side of a
   *  rectangle or polygon explodes that shape (once, when both picks are on
   *  it) and stands for the line it became. Nothing is committed: the caller
   *  does that, with commitExplodes, once the fillet or chamfer fits. */
  private cornerLines(a: CornerPick, b: CornerPick): {
    entities: ResolvedEntity[]; constraints: SketchConstraint[]; iA: number; iB: number;
    exploded: { shape: ResolvedEntity; result: ExplodeResult }[];
  } | null {
    let entities = this.entities, constraints = this.constraints;
    const exploded: { shape: ResolvedEntity; result: ExplodeResult }[] = [];
    const ids: string[] = [];
    for (const pk of [a, b]) {
      const e = this.entities[pk.idx];
      if (!e) return null;
      if (!pk.side) { ids.push(e.id); continue; }
      let done = exploded.find((x) => x.shape.id === e.id);
      if (!done) {
        const result = explodeCompound(entities, constraints, entities.findIndex((x) => x.id === e.id), { centre: this.extrudeNamesCentre(e.id) });
        if (!result) return null;
        ({ entities, constraints } = result);
        done = { shape: e, result };
        exploded.push(done);
      }
      const line = done.result.sides[Number(pk.side.slice(e.id.length + 1))];
      if (!line) return null;
      ids.push(line);
    }
    const [iA, iB] = ids.map((id) => entities.findIndex((x) => x.id === id));
    if (iA === undefined || iB === undefined || iA < 0 || iB < 0) return null;
    return { entities, constraints, iA, iB, exploded };
  }

  /** Why a shape must stay a shape, or null. A parameter that sets a polygon's
   *  or slot's own numbers (RIGID_ENTITY_NUM_FIELDS) would be left setting
   *  nothing once the shape is lines, and would say nothing about it: the
   *  value would simply stop reaching the sketch. */
  private explodeRefusal(e: ResolvedEntity): string | null {
    for (const [field] of RIGID_ENTITY_NUM_FIELDS[e.type] ?? []) {
      const key = `e:${e.id}:${field}`;
      if (this.exprFor(key) === undefined) continue;
      const name = this.pendingBindings.get(key)?.name ?? this.docBinding(key)?.name;
      const shape = t(`sketch.entity.${e.type}`);
      return name
        ? t("sketch.modify.explodeParamBound", { shape, name })
        : t("sketch.modify.explodeFormulaBound", { shape });
    }
    return null;
  }

  /** The start and up-to references, of every extrude in the document, that
   *  name a point or a line of this sketch (types.ts ExtrudeRef). */
  private refsIntoSketch(): Extract<ExtrudeRef, { sketch: string }>[] {
    if (!this.editingId || !this.store) return [];
    const out: Extract<ExtrudeRef, { sketch: string }>[] = [];
    for (const f of this.store.document.features) {
      if (f.type !== "extrude") continue;
      for (const r of [f.startFrom, f.upToRef]) {
        if ((r?.kind === "sketchPoint" || r?.kind === "sketchLine") && r.sketch === this.editingId) out.push(r);
      }
    }
    return out;
  }

  /** Add what an edit just renamed to pointCarry, after what the edits before
   *  it in this session renamed: the second of two trims can retire a line
   *  the first one made. Nothing while no extrude names anything here. */
  private carryPoints(next: PointCarry) {
    if (this.refsIntoSketch().length) this.pointCarry = composePointCarry(this.pointCarry, next);
  }

  /** Whether an extrude starts from or runs up to rectangle `id`'s centre:
   *  explodeCompound then keeps that centre as a point (`centre`), since it
   *  is no end of any of the lines the rectangle becomes. */
  private extrudeNamesCentre(id: string): boolean {
    return this.refsIntoSketch().some((r) => r.kind === "sketchPoint" && r.entity === id && r.pointIndex === RECT_CENTRE);
  }

  /** Make explodes planned on a copy (explodeCompound) the sketch's own: what
   *  else names the shapes by id, a pattern's sources and the selection, now
   *  names what they became, and the user is told the shape is lines now.
   *  The caller has already taken the planned entities and constraints. */
  private commitExplodes(done: { shape: ResolvedEntity; result: ExplodeResult }[], why: "fillet" | "chamfer" | "menu" | "rotate") {
    for (const { shape, result } of done) {
      // An extrude that starts from or runs up to one of its corners names it
      // by the shape's id and a corner index, and the line that kept the id
      // has two ends: corner 2 or 3 would name nothing at Finish (Extrude:
      // "isn't on its curve any more"). Each point goes where it went, and a
      // side (`<shapeId>~<k>`) to its line.
      this.carryPoints({
        [shape.id]: Object.fromEntries([
          ...Object.entries(result.points).map(([k, q]) => [k, { entity: q.e, pointIndex: q.p }]),
          ...result.sides.map((line, k) => [`~${k}`, { entity: line }]),
        ]),
      });
      // The shape's own id is still there, on its first line. A pattern of the
      // shape copies all of it, not that one line.
      for (const pat of this.patterns) {
        if ("sources" in pat && pat.sources.includes(shape.id)) {
          pat.sources = pat.sources.flatMap((id) => (id === shape.id ? result.outline : [id]));
        }
      }
      // Selected, it stays selected as everything it became, helpers too: a
      // Move that took the polygon's lines and left its circle behind would
      // have the solve pull one back to the other.
      // (A point or side of it selected counts: the shape it named is gone.)
      if (selOwners(this.selected).has(shape.id)) {
        dropOwner(this.selected, shape.id);
        for (const id of [...result.outline, ...result.helpers]) this.selected.add(id);
      }
      const name = t(`sketch.entity.${shape.type}`);
      if (why === "fillet" || why === "chamfer") {
        toast(t("sketch.modify.explodedForCorner", { shape: name, tool: why === "chamfer" ? t("tool.chamfer") : t("tool.fillet") }), { timeout: 8000 });
      }
      if (result.dropped > 0) toast(t("sketch.modify.explodeDropped", { count: result.dropped, shape: name }));
    }
  }

  /** Make a Fillet's or Chamfer's corner the sketch's own. `made` is what
   *  filletCorner or chamferCorner returned on the plan's lines; the
   *  constraints on the corner it cut away are kept where they can be
   *  (cornerJoins, which says what could not be), and a pattern that copies
   *  both lines copies what rounded or bevelled them too. Without that, each
   *  copy is the two cut-back lines with a gap between them, which no longer
   *  closes, and its area dropped out of the sketch without a word. */
  private commitCorner(
    plan: {
      entities: ResolvedEntity[]; constraints: SketchConstraint[]; iA: number; iB: number;
      exploded: { result: ExplodeResult }[];
    },
    made: ResolvedEntity[],
    tool: "fillet" | "chamfer",
  ) {
    const a = plan.entities[plan.iA]!.id, b = plan.entities[plan.iB]!.id;
    // An exploded polygon's corner sat on its construction circle, whether it
    // was exploded just now or earlier; the user never made that hold, so it
    // is kept through a construction point at the corner, unannounced.
    const own = new Set([...plan.exploded.flatMap((x) => x.result.holds), ...polygonRingHolds(plan.constraints, plan.entities)]);
    const joins = cornerJoins(plan.constraints, plan.entities, made, a, b, own);
    this.constraints = joins.constraints;
    this.entities = [...made, ...joins.points];
    const had = new Set(plan.entities.map((e) => e.id));
    const fresh = made.filter((e) => !had.has(e.id)).map((e) => e.id);
    for (const pat of this.patterns) {
      if ("sources" in pat && pat.sources.includes(a) && pat.sources.includes(b)) pat.sources = [...pat.sources, ...fresh];
    }
    const name = tool === "chamfer" ? t("tool.chamfer") : t("tool.fillet");
    if (joins.lost > 0) toast(t("sketch.modify.cornerLost", { count: joins.lost, tool: name }), { timeout: 8000 });
    if (joins.shifted > 0) toast(t("sketch.modify.cornerShifted", { count: joins.shifted, tool: name }), { timeout: 8000 });
  }

  /** Two sides of ONE rectangle or polygon meet only when they are next to
   *  each other. Any other two never meet (a rectangle's opposite sides: the
   *  size was typed and nothing happened, without a word), or meet OUTSIDE the
   *  shape (a hexagon's sides 0 and 2: both grew out to that point and side 1
   *  was left inside). True, after saying so, for those; the first pick stays
   *  armed for a side that does meet it. */
  private refuseFarSides(a: CornerPick, b: CornerPick): boolean {
    const e = this.entities[a.idx];
    if (!e || a.idx !== b.idx || !a.side || !b.side) return false;
    const n = e.type === "rectangle" ? 4 : e.type === "polygon" ? e.sides : 0;
    if (n < 3) return false;
    const k1 = Number(a.side.slice(e.id.length + 1)), k2 = Number(b.side.slice(e.id.length + 1));
    const gap = (((k1 - k2) % n) + n) % n;
    if (gap === 1 || gap === n - 1) return false;
    toast(t("sketch.modify.sidesDoNotMeet", { tool: this.tool === "chamfer" ? t("tool.chamfer") : t("tool.fillet") }));
    return true;
  }

  /** The area references of the extrudes built on this sketch, each as it
   *  reads now: the document's, or this session's re-pointing of it
   *  (`regionCarry`). Only those that record ids: a bare point is named by
   *  nothing an edit here renames. Empty for a sketch nothing is built on. */
  private regionRefs(): { feature: string; index: number; entityIds: string[]; holeEntityIds: string[][] | undefined; point: [number, number, number] | undefined }[] {
    const sketch = this.editingId;
    if (!sketch || !this.store) return [];
    const out: ReturnType<SketchMode["regionRefs"]> = [];
    for (const f of this.store.document.features) {
      if (f.type !== "extrude" || f.sketch !== sketch || !f.regionEntities) continue;
      f.regionEntities.forEach((ids, index) => {
        const now = this.regionCarry[f.id]?.[index];
        const entityIds = now?.entityIds ?? ids;
        if (!entityIds.length) return;
        out.push({
          feature: f.id, index, entityIds,
          holeEntityIds: now?.holeEntityIds ?? f.regionHoleEntities?.[index],
          point: now?.point ?? f.regions?.[index],
        });
      });
    }
    return out;
  }

  /** This sketch's areas as an extrude sees them: its curves and its pattern
   *  copies, which is what refreshActive shows. */
  private sketchRegions(): Region[] {
    return detectRegions(this.editingId ?? "__active__", [...this.entities, ...this.derivedEntities()]);
  }

  /** The areas before an edit that renames the curves around them (an
   *  explode, a sketch fillet or chamfer), for carryRegionRefs. Null, at no
   *  cost, when no extrude on this sketch names an area by its curves. */
  private regionsBeforeRename(): Region[] | null {
    return this.regionRefs().length ? this.sketchRegions() : null;
  }

  /** Keep every extrude on this sketch on the area it builds, across an edit
   *  that renamed the curves around it.
   *
   *  An extrude names its area by the curves around it and trusts that before
   *  its stored point (types.ts, `regionEntities`). Explode keeps a shape's id
   *  on ONE of its lines (explodeCompound), so where the shape bounded several
   *  areas, a line across it or a neighbour sharing a side, the id now names
   *  only the areas beside that line, and could name the wrong one alone.
   *  Measured: the top half of a split rectangle extruded as the bottom half,
   *  with no warning. A pattern's copies are numbered by position
   *  (expandPattern), so a shape that becomes four lines, or a corner that
   *  gains an arc, renumbers every copy after the first.
   *
   *  So a reference to an area whose curves this edit renamed is re-pointed
   *  at the same area (twinRegion) by its new names and its own interior
   *  point, and finish() writes that with the sketch. Not only when the app's
   *  own resolution (resolveRegionRef) would now go wrong: the sidecar labels
   *  an edge two curves share with BOTH of them where the app labels it with
   *  one, so a reference the app still resolves can bind elsewhere in the
   *  build (measured: a rectangle stacked on an exploded one extruded as the
   *  one below it). Named by the area's exact ids, both agree. An area whose
   *  curves kept their names keeps its reference untouched, unless the app
   *  would now resolve it elsewhere.
   *
   *  A Trim does more than rename. The piece that keeps the cut curve's id
   *  can bound a different area than the whole curve did, and the area a
   *  reference named can be gone (trimClick passes `cut`, the names it kept).
   *  Left naming the kept id, such a reference moved: in a rectangle cut into
   *  quadrants by two lines, trimming half of one line merges two quadrants,
   *  and the extrude on one of them went to the quadrant across the line
   *  (measured in the sidecar). So a reference that names a kept name and
   *  whose area has no twin goes where it went when Trim made every id new:
   *  to the area its stored point is in, else to that point alone, which the
   *  build resolves, and flags when stale, as it always has. */
  private carryRegionRefs(before: Region[] | null, cut?: (id: string) => boolean) {
    if (!before) return;
    const after = this.sketchRegions();
    for (const ref of this.regionRefs()) {
      const p = ref.point;
      const holds = p ? (r: Region) => worldPointInRegion(new THREE.Vector3(p[0], p[1], p[2]), this.plane, r) : null;
      const was = resolveRegionRef(before, ref.entityIds, ref.holeEntityIds, holds);
      const twin = was && twinRegion(was, after);
      if (twin) {
        if (sameRegionIds(was, twin) && resolveRegionRef(after, ref.entityIds, ref.holeEntityIds, holds) === twin) continue;
        this.carryRegionRef(ref, twin);
        continue;
      }
      if (!cut || !p || ![ref.entityIds, ...(ref.holeEntityIds ?? [])].some((ids) => ids.some(cut))) continue;
      const home = holds ? after.filter(holds) : [];
      if (home.length === 1) this.carryRegionRef(ref, home[0]!);
      else (this.regionCarry[ref.feature] ??= {})[ref.index] = { entityIds: [], holeEntityIds: [], point: [p[0], p[1], p[2]] };
    }
  }

  /** Re-point one area reference (carryRegionRefs) at `to`: its exact names
   *  and its own interior point. */
  private carryRegionRef(ref: { feature: string; index: number }, to: Region) {
    const at = this.plane.to3D(to.interior.x, to.interior.y);
    (this.regionCarry[ref.feature] ??= {})[ref.index] = {
      entityIds: [...to.entityIds],
      holeEntityIds: to.holeEntityIds.map((g) => [...g]),
      point: [at.x, at.y, at.z],
    };
  }

  /** Explode every selected rectangle, polygon and slot into lines (the
   *  right-click Explode to lines). A shape a parameter sizes is left as it
   *  is, and said. */
  private explodeSelected() {
    const regions = this.regionsBeforeRename();
    const done: { shape: ResolvedEntity; result: ExplodeResult }[] = [];
    const owners = this.selectedOwners();
    for (const shape of this.entities.filter((e) => owners.has(e.id) && isCompoundShape(e))) {
      const why = this.explodeRefusal(shape);
      if (why) { toast(why, { timeout: 8000 }); continue; }
      const result = explodeCompound(this.entities, this.constraints, this.entities.indexOf(shape), { centre: this.extrudeNamesCentre(shape.id) });
      if (!result) continue;
      this.entities = result.entities;
      this.constraints = result.constraints;
      done.push({ shape, result });
    }
    if (!done.length) return;
    this.commitExplodes(done, "menu");
    this.carryRegionRefs(regions);
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
      toast(t("sketch.guard.originFixed"));
      return true;
    }
    if (e?.type !== "projected") return false;
    toast(PROJECTED_FIXED_MSG);
    return true;
  }

  /** ids of the currently-selected projected (linked reference) entities. */
  private selectedProjectedIds(): Set<string> {
    const owners = this.selectedOwners();
    return new Set(
      this.entities.filter((e) => e.type === "projected" && owners.has(e.id)).map((e) => e.id),
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
    // Anything a user `fix` pins refuses the WHOLE transform. Same hole as the
    // body drag: these tools move geometry without consulting the solver, and
    // `fix` is positionless, so the settle afterwards re-pins the point wherever
    // the transform left it and reports success (report d0b008cb). Refused
    // whole, not per-entity: moving the rest of the selection around a held
    // entity tears every joint they share, which is the same reason
    // bodyDragBlocked refuses a gesture rather than dropping one mutator.
    if (this.refusePinnedSelection()) return;
    const next: ResolvedEntity[] = [];
    const sel = new Set<string>();
    // fixed reference geometry: keep it (and its selection) untouched
    const projected = this.warnSelectedProjected();
    // ...and the ORIGIN, with no toast. A click at 0,0 in Select picks one of
    // its axes, so a Move of a selection that included one carried the axis
    // along, and for the rest of the session the solver pinned it wherever it
    // landed (the body drag's twin, 69d5231f). The origin point offers no pick
    // of its own today; it is kept the same way all the same.
    const kept = (id: string) => projected.has(id) || isOriginGeometry(id);
    const owners = this.selectedOwners();
    // the keys an entity was selected by, kept while it keeps its id: a moved
    // rectangle whose side was selected still has that side selected
    const keysOf = (id: string) => [...this.selected].filter((k) => selOwner(k) === id);
    for (const e of this.entities) {
      if (owners.has(e.id) && !kept(e.id)) {
        const out = map(e);
        for (const m of out) next.push(m);
        if (out.length === 1 && out[0]!.id === e.id) for (const k of keysOf(e.id)) sel.add(k);
        else for (const m of out) sel.add(m.id);
      } else {
        next.push(e);
        for (const k of keysOf(e.id)) sel.add(k);
      }
    }
    this.entities = next;
    this.selected = sel;
    this.afterModify();
  }

  /** True, after saying so, when a user `fix` pins anything selected: see
   *  transformSelection. Its own function so Rotate can ask BEFORE it
   *  explodes a rectangle, rather than explode it and then be refused. */
  private refusePinnedSelection(): boolean {
    const pinned = fixPinnedIds(this.constraints);
    if (!pinned.size || ![...this.selectedOwners()].some((id) => pinned.has(id))) return false;
    toast(FIXED_POINT_MSG);
    return true;
  }

  /** True, after saying so, when a selection with a rectangle, polygon or
   *  slot in it is held by a constraint to geometry that is not moving with
   *  it (`tie`: rotationTie or translationTie). The settle after the motion
   *  would pull it part of the way back or stretch it: the user would get
   *  another angle than the one typed, or a rectangle with a corner on the
   *  origin resized instead of moved (measured: 18.5 degrees and a resized
   *  rectangle for 30 typed; 60x50 -> 80x40 for a move of 20,10). Decision
   *  C8: refuse, and say so. A selection of lines alone is left as it was:
   *  the decision is about shapes, and a moved line stretching its neighbour
   *  is the gesture a body drag makes too. */
  private refuseTiedShapes(tie: (c: SketchConstraint, moving: ReadonlySet<string>) => boolean, msg: string): boolean {
    const owners = this.selectedOwners();
    const moving = new Set(
      this.entities
        .filter((e) => owners.has(e.id) && e.type !== "projected" && !isOriginGeometry(e.id))
        .map((e) => e.id),
    );
    if (!this.entities.some((e) => isCompoundShape(e) && moving.has(e.id))) return false;
    if (!this.constraints.some((c) => tie(c, moving))) return false;
    toast(msg, { timeout: 8000 });
    return true;
  }

  /** A rectangle is square to the sketch axes by definition (types.ts), so it
   *  cannot be turned. Rotate used to replace it with four plain lines, and
   *  every constraint and dimension on it went with the rectangle's id
   *  (a237de6b): sizes, a corner on the origin, all of it. Explode it instead,
   *  held square by Perpendicular rather than by Horizontal and Vertical, which
   *  the rotation would break, and its constraints move onto its lines. */
  private explodeSelectedRectangles() {
    const regions = this.regionsBeforeRename();
    const done: { shape: ResolvedEntity; result: ExplodeResult }[] = [];
    const owners = this.selectedOwners();
    for (const shape of this.entities.filter((e) => owners.has(e.id) && e.type === "rectangle")) {
      const result = explodeCompound(this.entities, this.constraints, this.entities.indexOf(shape), {
        square: "perpendicular", centre: this.extrudeNamesCentre(shape.id),
      });
      if (!result) continue;
      this.entities = result.entities;
      this.constraints = result.constraints;
      done.push({ shape, result });
    }
    if (!done.length) return;
    this.commitExplodes(done, "rotate");
    this.carryRegionRefs(regions); // before the rotation moves anything
    toast(t("sketch.transform.rectangleToLines", { count: done.length }), { timeout: 8000 });
  }

  /** keep the id for a single-entity result; give an exploded result (a rotated
   *  rectangle → 4 lines) fresh ids so nothing collides. Rotate explodes a
   *  rectangle itself first (explodeSelectedRectangles), so that only happens
   *  to one it could not explode: a rectangle with no size. */
  private reid(rot: ResolvedEntity[]): ResolvedEntity[] {
    return rot.length === 1 ? rot : rot.map((r) => ({ ...r, id: newEntityId() }));
  }

  // --- move / copy / rotate / scale: choose, then the point --------------
  // Each acts on the selection about a point. A selection made beforehand is
  // used as it is, the way Mirror uses one. Armed with nothing selected, the
  // tool says so at once and its clicks choose (Shift, Ctrl or Cmd add) until
  // Enter. It used to light the curve under the cursor red, take the click,
  // and only then say to select something first (Paul, 269bfb81). The point
  // is then picked like a drawing click, snapping to endpoints, centres,
  // corners and the origin, and Rotate's and Scale's box opens beside it.

  /** True while Move, Copy, Rotate or Scale is choosing what it acts on. */
  private get choosingTargets(): boolean {
    return TRANSFORM_TOOLS.has(this.tool) && (this.pickingTargets || this.selected.size === 0);
  }

  /** The prompt while a transform tool is choosing, else null: main.ts then
   *  shows the tool's own prompt, which is about the point. */
  get choosingPromptKey(): string | null {
    return this.choosingTargets ? (CHOOSING_PROMPT[this.tool] ?? null) : null;
  }

  /** Said when a transform tool arms with nothing selected, before any click,
   *  and again on an Enter with nothing chosen. An AREA selected by clicking
   *  inside a shape shows filled like a selection but is not one here (these
   *  tools move curves), so "nothing is selected" would be false on screen. */
  private sayWhatToSelect() {
    if (this.overlay.selectedActiveRegions().length) { toast(t("sketch.transform.areaNotCurves")); return; }
    const said = NOTHING_SELECTED[this.tool];
    if (said) toast(t(said));
  }

  /** Whether a PLAIN click here, with something already chosen, lands on a
   *  point the pivot would snap to (an end, a corner, a centre, the origin).
   *  That is the point to work from, clicked before Enter: taken as a choice,
   *  it re-selected the same curve or swapped the whole selection for the
   *  shape owning the point, and said nothing. Midpoints are left out: the
   *  middle of a line is where people click to select it. Shift, Ctrl or Cmd
   *  always choose. */
  private onPivotPoint(e: PointerEvent): boolean {
    if (!this.selected.size || e.shiftKey || e.ctrlKey || e.metaKey) return false;
    const kind = this.snapAt(e.clientX, e.clientY)?.kind;
    return kind === "endpoint" || kind === "center";
  }

  /** What a choosing click at `p` takes: what the Select tool's click would
   *  (a text by its glyphs, else the nearest curve), less the origin, which a
   *  transform never moves (transformSelection keeps it). */
  private transformTargetAt(p: THREE.Vector2): ResolvedEntity | null {
    const te = this.textEntityAt(p);
    if (te) return te;
    const idx = pickEntity(this.entities, p, this.pickTol());
    const e = idx >= 0 ? this.entities[idx] : undefined;
    return e && !isOriginGeometry(e.id) ? e : null;
  }

  /** A click while choosing: select what is under it, alone, or add it (and
   *  drop it again) with `add`. Projected geometry is refused NOW, rather than
   *  chosen and then left behind by the move. Once something is chosen, no
   *  click that leaves it as it was, or throws several chosen things away,
   *  passes without a word. */
  private chooseTarget(p: THREE.Vector2, add: boolean, onPivotPoint: boolean) {
    this.pickingTargets = true; // a fresh choice lasts until Enter, not one click
    const had = this.selected.size;
    // the point to move or turn about, clicked before Enter: keep the choice
    if (onPivotPoint) { toast(t("sketch.transform.pressEnter")); return; }
    const e = this.transformTargetAt(p);
    if (!e) {
      // Inside a closed shape, and plainly not a pivot (nothing chosen yet, or
      // an add): the click meant the shape, whose area is not what moves.
      if (this.overlay.activeRegionAt(p) && (add || !had)) toast(t("sketch.transform.areaNotCurves"));
      // otherwise most likely the point to move or turn about, before Enter
      else if (had) toast(t("sketch.transform.pressEnter"));
      return;
    }
    if (this.guardProjected(e)) return;
    if (add) {
      if (!this.selected.delete(e.id)) this.selected.add(e.id);
    } else if (had === 1 && this.selected.has(e.id)) {
      toast(t("sketch.transform.pressEnter")); // already all that is chosen
      return;
    } else {
      this.selected = new Set([e.id]);
      if (had > 1) toast(t("sketch.transform.choseOnlyThis"));
    }
    this.refreshActive();
  }

  /** Enter while choosing: on to the point, when something is chosen. */
  private finishChoosingTargets() {
    if (!this.selected.size) { this.sayWhatToSelect(); return; }
    this.pickingTargets = false;
    this.overlay.setPreview([]); // the choosing hover
    this.onState?.(); // the prompt moves on to the point
  }

  /** The transform tools' hover. While choosing, what a click would select,
   *  in the colour a model edge takes under the cursor: the modify tools' red
   *  says "this click acts on it", and this one only selects. After that, a
   *  click places a point, so the snap marker shows exactly as it does while
   *  drawing, and no curve is lit: lit curves read as "only lines can be
   *  picked" (53f5fcbb). */
  private transformHover(e: PointerEvent) {
    if (this.choosingTargets) {
      this.showSnap(null);
      const p = this.planePoint(e);
      // nothing lit where a plain click is taken as the pivot (onPivotPoint)
      const target = p && !this.onPivotPoint(e) ? this.transformTargetAt(p) : null;
      const lit = target && target.type !== "projected" ? [target] : [];
      this.overlay.setPreview(curveObjects(lit, this.plane, EDGE_HOVER, true));
      return;
    }
    this.overlay.setPreview([]);
    this.showSnap(this.snapAt(e.clientX, e.clientY, e.ctrlKey));
  }

  /** Put the angle or factor box beside the pivot it applies to. It was never
   *  placed, so it opened wherever the last box had been (53f5fcbb). */
  private placeBoxAtPivot(p: THREE.Vector2) {
    const s = this.viewport.projectToScreen(this.plane.to3D(p.x, p.y));
    this.dim.position(s.x, s.y);
  }

  /** Move/Copy: click a base point, then a destination — translate the whole
   *  selection. Move mutates in place; Copy leaves the originals and selects the copies. */
  private moveClick(p: THREE.Vector2) {
    if (!this.moveBase) { this.moveBase = p.clone(); toast(t("sketch.transform.clickDestination")); return; }
    const dx = p.x - this.moveBase.x, dy = p.y - this.moveBase.y;
    this.moveBase = null;
    if (this.tool === "copy") {
      const copies: ResolvedEntity[] = [];
      const sel = new Set<string>();
      const projected = this.warnSelectedProjected(); // linked — can't clone the link
      const owners = this.selectedOwners();
      for (const e of this.entities) {
        if (!owners.has(e.id) || projected.has(e.id)) continue;
        const id = newEntityId();
        copies.push(translated(e, dx, dy, id));
        sel.add(id);
      }
      this.entities = [...this.entities, ...copies];
      this.selected = sel; // leave the copies selected (Fusion-style)
      this.afterModify();
    } else {
      if (this.refusePinnedSelection()) return;
      const d = { x: dx, y: dy };
      if (this.refuseTiedShapes((c, moving) => translationTie(c, this.entities, moving, d), t("sketch.transform.moveTied"))) return;
      this.transformSelection((e) => [translated(e, dx, dy, e.id)]);
    }
  }

  /** Rotate the selection about a clicked center by a typed angle (degrees). */
  private rotateClick(p: THREE.Vector2) {
    const cx = p.x, cy = p.y;
    this.transformPivot = p.clone();
    this.dim.show([{ name: "angle", label: "∠", kind: "angle" }], () => {
      if (this.badTypedField({ name: "angle", kind: "angle" })) return;
      const ang = ((this.dim.getValue("angle") ?? 0) * Math.PI) / 180;
      this.dim.hide();
      this.transformPivot = null;
      if (this.refusePinnedSelection()) return;
      const pivot = { x: cx, y: cy };
      if (this.refuseTiedShapes((c, moving) => rotationTie(c, this.entities, moving, pivot), t("sketch.transform.rotateTied"))) return;
      this.explodeSelectedRectangles();
      this.transformSelection((e) => this.reid(rotated(e, cx, cy, ang, e.id)));
    });
    this.placeBoxAtPivot(p);
    toast(t("sketch.transform.rotatePrompt"));
  }

  /** Scale the selection about a clicked base point by a typed factor. */
  private scaleClick(p: THREE.Vector2) {
    const cx = p.x, cy = p.y;
    this.transformPivot = p.clone();
    this.dim.show([{ name: "factor", label: "×", kind: "count" }], () => {
      if (this.badTypedField({ name: "factor", kind: "count" })) return;
      const f = this.dim.getValue("factor") ?? 1;
      this.dim.hide();
      this.transformPivot = null;
      if (f > 0) this.transformSelection((e) => [scaled(e, cx, cy, f, e.id)]);
    });
    this.placeBoxAtPivot(p);
    toast(t("sketch.transform.scalePrompt"));
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
    if (e.type === "text") { toast(t("sketch.offset.noText")); return; }
    if (e.type === "point") { toast(t("sketch.offset.noPoint")); return; }
    this.offsetPick = { idx, side: 1, mag: 0 };
    this.dim.show(
      [{ name: "offset", label: t("tool.offset"), kind: "length" }],
      () => this.commitOffset(),
      () => this.cancelOffset(),
    );
    setPrompt(t("sketch.offset.prompt"));
    this.noteChainJunction(idx);
  }

  /** Say so when Chain Selection cannot take the whole chain. At a vertex where
   *  three or more curves meet, offsetChain gives up and the tool offsets the
   *  picked curve alone: correct, but it used to happen in silence, and with
   *  the toggle visibly on that reads as "Chain Selection does not work" (field
   *  report 356b2693). Once per pick, never per preview frame. */
  private noteChainJunction(idx: number) {
    if (!this.offsetChainMode) return;
    const at = offsetChainJunction(this.entities, idx);
    if (at) toast(t("sketch.offset.chainJunction", { x: fmtLength(at.x), y: fmtLength(at.y) }));
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
    this.dimAtCursor(ev.clientX, ev.clientY);
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
      if (typed === null) { toast(t("sketch.offset.typeDistance")); return; }
      // same rule as the live preview: a typed sign is the side (see offsetMove)
      pick.mag = Math.abs(typed);
      if (typed !== 0) pick.side = typed < 0 ? -1 : 1;
    }
    if (pick.mag < 1e-6) { toast(t("sketch.offset.typeDistance")); return; }
    const res = this.offsetResultFor(pick.idx, pick.side * pick.mag);
    this.offsetPick = null;
    this.dim.hide();
    if (!res) {
      toast(t("sketch.offset.collapses"));
      this.overlay.setPreview([]);
      return;
    }
    this.entities = res.entities;
    if (res.linked && res.pairs.length) {
      // the associative link + its single editable dimension
      this.setDrivingDimension({ type: "offset", pairs: res.pairs, value: pick.side * pick.mag });
    } else if (!res.linked) {
      toast(t("sketch.offset.rigidCopy"));
    }
    this.afterModify();
  }

  private cancelOffset() {
    this.offsetPick = null;
    this.dim.hide();
    this.overlay.setPreview([]);
    setPrompt(t("sketch.offset.clickCurve"));
  }
  private extendClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    const res = extendLine(this.entities, idx, p);
    if (res) this.entities = res;
    this.afterModify();
  }
  /** Break. The halves of a line or arc share the cut point, and the solver
   *  joins ends at one spot by position alone, with no glyph: nothing on screen
   *  says they are joined, and an ordinary drag moves both. So the toast says
   *  so, and how to pull them apart (detachFrame). It is also the only sign the
   *  break happened at all: the curve looks the same afterwards. */
  /** Break the clicked curve, carrying its constraints onto the pieces the way
   *  Trim does (breakWithConstraints), and say what could not come along. */
  private breakClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    const before = this.entities.length;
    const broken = this.entities[idx]!;
    const res = breakWithConstraints(this.entities, idx, p, this.constraints);
    this.entities = res.entities;
    this.constraints = res.constraints;
    this.carryPieces(broken, res);
    const kept = this.constraints.length;
    this.afterModify(); // prunes too: anything it still finds dangling counts
    const dropped = res.dropped + kept - this.constraints.length;
    if (this.entities.length > before) toast(t("sketch.modify.breakJoined"));
    if (dropped > 0) toast(t("sketch.modify.breakDropped", { count: dropped }));
  }
  /** Join, the opposite of Break: the clicked line and the one it continues
   *  in a straight line become one line, keeping what still applies to it
   *  (joinLines), and saying what could not come along. An extrude that names
   *  an area, an end or a whole line by the two old lines is re-pointed at the
   *  new one, the way Explode does it. */
  private joinClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    const res = joinLines(this.entities, this.constraints, idx, p, this.pickTol());
    if (res.kind === "refused") {
      toast(t(`sketch.modify.join.${res.why}`));
      return;
    }
    const regions = this.regionsBeforeRename();
    this.entities = res.entities;
    this.constraints = res.constraints;
    this.carryPoints(
      Object.fromEntries(
        Object.entries(res.points).map(([id, ps]) => [
          id,
          {
            // an extrude that starts from or runs up to this whole line
            "": { entity: res.id },
            ...Object.fromEntries(Object.entries(ps).map(([k, q]) => [k, { entity: q.e, pointIndex: q.p }])),
          },
        ]),
      ),
    );
    for (const pat of this.patterns) {
      if ("sources" in pat && pat.sources.some((id) => res.from.includes(id))) {
        pat.sources = [...new Set(pat.sources.map((id) => (res.from.includes(id) ? res.id : id)))];
      }
    }
    const wasSelected = res.from.some((id) => this.selected.has(id));
    for (const id of res.from) this.selected.delete(id);
    if (wasSelected) this.selected.add(res.id);
    this.carryRegionRefs(regions);
    const kept = this.constraints.length;
    this.afterModify(); // prunes too: anything it still finds dangling counts
    const dropped = res.dropped + kept - this.constraints.length;
    if (dropped > 0) toast(t("sketch.modify.joinDropped", { count: dropped }));
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
        if (p && pickEntity(this.entities, p, this.pickTol()) >= 0) toast(t("sketch.project.ownCurves"));
        return;
      }
      if (!this.committedSource(hit.sketchId, hit.entityId)) {
        toast(t("sketch.project.patternCopy"));
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
        toast(t("sketch.project.curveDup"));
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
          toast(t("sketch.project.silhouetteDup"));
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
      toast(t("sketch.project.engineUnavailable"));
      return;
    }
    if (!r.ok) {
      toast(r.error ?? t("sketch.project.failed")); // sidecar message verbatim ("created after this sketch"…)
      return;
    }
    // body-edge duplicates are detected against the returned fingerprints (the
    // sketch-curve case was pre-checked above — its ids are stable)
    const fresh = r.curves.filter(({ fp }) => !(fp && this.hasProjectedFp(fp)));
    const skipped = r.curves.length - fresh.length;
    if (skipped) toast(skipped === r.curves.length ? t("sketch.project.edgeDup") : t("sketch.project.edgesSkipped", { count: skipped }));
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
      // Construction mode applies here as it does at every other creation
      // site. This was the one that ignored it, so a projected edge always
      // joined the profile and could never be pure reference, which is what a
      // user asked for: "select an edge of an existing solid or from an earlier
      // sketch and use it for construction geometry in a new sketch". The flag
      // is left off entirely when the mode is off, so an ordinary projection
      // serialises exactly as before.
      this.entities.push({
        type: "projected", id: ids[i]!, source: src, curve,
        ...(this.constructionMode ? { construction: true as const } : {}),
      });
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
    // entities exposing at least one reference point — the operand set for the
    // dimensions (p2p/p2l/fix) AND, since 2026-09-05, for the point CONSTRAINTS:
    // constraintTools.pickEndpoint enumerates this same dimRefPoints list, so
    // "what a dimension can name" and "what a coincident can name" are one set
    // rather than two that drift. They did drift, twice, and both times the
    // narrower one silently deleted constraints the solver was honouring:
    // rectangles were missing from it until 2026-08-17 and circles until now.
    const refIds = ids((e) => dimRefPoints(e).length > 0);
    const rectIds = ids((e) => e.type === "rectangle");
    // A polygon or slot SIDE (`P~k`, `S~0`, `S~1`) or a slot's axis (`S~2`).
    // Resolved through lineOperand, the decoder the solver and the glyphs use,
    // so a side the shape does not have is dropped here instead of sitting in
    // the sketch holding nothing. (A side-count edit re-aims these first:
    // rebindPolygonSides.)
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    const hasShapeSide = (id: string) => {
      const cut = id.lastIndexOf("~");
      const shape = cut > 0 ? byId.get(id.slice(0, cut)) : undefined;
      return (shape?.type === "polygon" || shape?.type === "slot") && lineOperand(byId, id) !== null;
    };
    // A line OPERAND is either a live line entity, a rectangle EDGE
    // ("<rectId>~<k>", k = 0..3 — see types.ts) or a polygon's or slot's side.
    // Every line-operand check goes through here: a bare `lineIds.has(id)`
    // would reject every rect-edge dim and silently drop it on the next
    // trim/fillet/delete.
    const hasLineOperand = (id: string): boolean => {
      const t = id.indexOf("~");
      if (t < 0) return lineIds.has(id);
      const k = Number(id.slice(t + 1));
      return (rectIds.has(id.slice(0, t)) && Number.isInteger(k) && k >= 0 && k <= 3) || hasShapeSide(id);
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
    const hasPointOperand = (id: string) => refIds.has(id) || hasLineOperand(id);
    // A spline with ENDS, the only kind a tangency can leave (a closed one has
    // none); its other curve may be one of those too, a line operand or a round.
    const openSplineIds = ids((e) => e.type === "spline" && !e.closed && e.points.length >= 2);
    this.constraints = this.constraints.filter((c) => {
      switch (c.type) {
        case "horizontal": case "vertical": case "distance": return hasLineOperand(c.line);
        case "parallel": case "perpendicular": case "equal": case "collinear": case "angle":
          return hasLineOperand(c.l1) && hasLineOperand(c.l2);
        case "diameter": return roundIds.has(c.circle);
        case "tangent": return hasLineOperand(c.line) && circleIds.has(c.circle);
        case "tangent2": return hasCurveOperand(c.a) && hasCurveOperand(c.b);
        case "splineTangent":
          return openSplineIds.has(c.spline) && c.other !== c.spline
            && (openSplineIds.has(c.other) || hasLineOperand(c.other) || roundIds.has(c.other));
        case "equalRadius": return roundIds.has(c.a) && roundIds.has(c.b);
        case "coincident": return hasPointOperand(c.e1) && hasPointOperand(c.e2);
        case "concentric": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "midpoint": return hasPointOperand(c.e) && hasLineOperand(c.line);
        case "pointOn": return hasPointOperand(c.e) && hasCurveOperand(c.curve);
        case "symmetric": return hasPointOperand(c.e1) && hasPointOperand(c.e2) && hasLineOperand(c.line);
        case "radius": return roundIds.has(c.e);
        // a dimension's point may be a side's end (`S~0` p0) too: the only
        // spelling a slot side's ends have (dimensionTool's parallel distance)
        case "p2pDistance": return hasPointOperand(c.e1) && hasPointOperand(c.e2);
        case "p2pDistanceX":
        case "p2pDistanceY": return hasPointOperand(c.e1) && hasPointOperand(c.e2);
        case "p2lDistance": return hasPointOperand(c.e) && hasLineOperand(c.line);
        // rim (edge-to-edge) dims — a round operand is a circle OR an arc
        case "radialGap": return roundIds.has(c.inner) && roundIds.has(c.outer);
        case "c2cDistance": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "c2lDistance": return roundIds.has(c.circle) && hasLineOperand(c.line);
        case "p2cDistance": return hasPointOperand(c.e) && roundIds.has(c.circle);
        case "fix": return hasPointOperand(c.e);
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
      setPrompt(t("sketch.pattern.removed", { count: droppedCount }));
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
    const carry = this.regionCarry, points = this.pointCarry, trimmed = this.trimmedCurves;
    return cloneSnapshot({
      entities: this.entities,
      constraints: this.constraints,
      patterns: this.patterns,
      // only when there is one, so every session that re-points nothing
      // snapshots (and compares) exactly as before
      ...(carry && Object.keys(carry).length ? { regionCarry: carry } : {}),
      ...(points && Object.keys(points).length ? { pointCarry: points } : {}),
      ...(trimmed?.length ? { trimmed } : {}),
    });
  }

  private restore(s: SketchSnapshot) {
    const c = cloneSnapshot(s);
    this.entities = c.entities;
    this.constraints = c.constraints;
    this.patterns = c.patterns;
    this.regionCarry = c.regionCarry ?? {};
    this.pointCarry = c.pointCarry ?? {};
    this.trimmedCurves = c.trimmed ?? [];
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
   *  the undo entry — a drag never touches patterns, nor constraints except
   *  for the joins a Disconnect released (dragConsBefore), so the current ones
   *  complete the snapshot. */
  private bankDrag() {
    const before = this.dragSnapshot;
    const consBefore = this.dragConsBefore ?? this.constraints;
    this.dragSnapshot = null; // committed — drop the revert buffer
    this.dragConsBefore = null;
    if (!before || !this.active) return;
    const banked = this.history.bankBefore(
      { entities: before, constraints: consBefore, patterns: this.patterns },
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
    if (!prev) { setPrompt(t("sketch.history.nothingToUndo")); return true; }
    this.applyHistory(prev);
    return true;
  }

  redoEdit(): boolean {
    if (!this.active) return false;
    const next = this.history.redo(this.snapshot());
    if (!next) { setPrompt(t("sketch.history.nothingToRedo")); return true; }
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
    this.polygonEdit = null;
    this.moveBase = null;
    this.transformPivot = null;
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
      while (this.active && (this.pendingDrag || this.pendingPinIdxs !== null || this.pendingRefresh || this.solveDirty)) {
        if (this.pendingDrag || this.pendingPinIdxs !== null) {
          // no entityVersion guard here: a drag never adds/removes entities, so
          // the entity list can't change underneath this solve (unlike a draw).
          const d = this.pendingDrag;
          // A BODY drag has already moved its entities; what it needs from the
          // solver is everything AROUND them brought back into agreement, with
          // the entities themselves held where the cursor put them. Their pins
          // are read HERE so they are the entities' current corners — more
          // pointermove frames may have landed while the previous solve ran.
          const forBody = this.pendingPinIdxs !== null;
          const pinEnts = (this.pendingPinIdxs ?? []).flatMap((i) => this.entities[i] ?? []);
          this.pendingDrag = null;
          this.pendingPinIdxs = null;
          const pins = pinEnts.length
            ? pinEnts.flatMap((e) => attachmentPoints(e, this.constraints).map((q) => ({ x: q.x, y: q.y })))
            : undefined;
          const r = await compileAndSolve(this.entities, this.constraints, d ?? undefined, undefined, pins, this.boundShapeFields());
          // The gesture this result belongs to ended, was cancelled, or was
          // replaced mid-solve: drop the result (and its toast) rather than
          // apply it to a gesture that never asked for it. Asked per KIND —
          // `dragFrom` is null for the whole of a body drag, so testing it alone
          // discarded every body frame's result, and testing either alone lets a
          // stale POINT-drag result land on a body drag that armed while it ran.
          //
          // `continue`, never `break`: endDrag's settle sets `solveDirty` while
          // this solve is still in flight, and pump is only ever kicked from
          // requestSolve/queueDrag/queueBodyDrag — so leaving the loop here left
          // the settle queued with nothing to consume it and the sketch stayed
          // torn AFTER the button came up (78.6 deg on the reporter's profile).
          // The loop condition re-reads solveDirty and runs it.
          if (!this.active || (forBody ? !this.moveDrag : !this.dragFrom)) continue;
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
                : r.dragRefused === "geometry" ? t("sketch.guard.dragFlattens")
                : FIXED_POINT_MSG);
            }
          } else if (d && this.dragFrom && !this.conflict) {
            // track the grabbed point, which moved only if the result landed:
            // a conflicting frame is thrown away above, and an anchor advanced
            // past it drifts the same way a refused one would
            this.dragFrom.set(d.toX, d.toY);
          }
          this.refreshDragGeometry(); // curves, badges, glyphs; candidates rebuilt on endDrag
        } else if (this.pendingRefresh) {
          const updates = this.pendingRefresh;
          this.pendingRefresh = null;
          await this.walkRefresh(updates);
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
          // a copy, so the indices the solve reports still name the constraints
          // it saw if the live list is edited while it runs
          const solved = [...this.constraints];
          // ...and of the entities, for the same reason: a line committed while
          // this solve runs is PUSHED onto the live list, and the solver's
          // write-back maps over the list it was handed, so it met a line it
          // never compiled and threw, which turns the solver off for the session.
          // With every chain corner joined, each segment of a chain starts a
          // solve, so two quick clicks meet one. The version check below then
          // discards this result and solves again, as it always meant to.
          const r = await compileAndSolve([...this.entities], solved, undefined, bias ?? undefined, undefined, this.boundShapeFields());
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
          // constraint silently does nothing and the tools look broken. Unless
          // the sketch was red before the trial and the solve blames none of
          // it: then the conflict is the one that was already there, and
          // withdrawing would lose a Trim's joins on every trim and blame them.
          const blamed = parseConflictIdx(r.conflicts);
          const innocent = !!this.trial?.alreadyConflicting && this.conflict
            && this.trial.cons.every((c) => solved.includes(c) && !blamed.has(solved.indexOf(c)));
          if (this.trial && (this.conflict || !r.ok) && !innocent) {
            const trial = this.trial;
            this.trial = null;
            const w = withdrawTrial(this.constraints, trial, blamed);
            this.constraints = w.constraints;
            // The solve's own reason wins over the tool's when it has one: a
            // tangency with no answer left on the segment it was created
            // against does not CONFLICT with anything, and saying it does sends
            // the user looking for a contradiction that is not there.
            toast(r.reason ?? w.msg);
            this.conflict = false; // the restored list is the last GOOD state
            this.solveDirty = true; // re-solve without them, back to the last good state
            continue;
          }
          // A bulk Lock keeps only what is not already implied. On a hand-drawn
          // rectangle (four lines, H/V on each) the far sides' lengths follow
          // from the near sides', and locking all four left two amber while
          // the toast said four were locked. Judged only by a solve that SAW
          // every member: one set while this solve ran is the next one's. And
          // judged until a solve names none of them, because planegcs can name
          // only part of a redundant set at a time (a parallelogram's two
          // implied sides came back one per solve).
          const trial = this.trial;
          if (!trial?.dropRedundant) {
            this.trial = null;
          } else if (trial.cons.every((c) => solved.includes(c))) {
            const over = parseConflictIdx(r.overDefined);
            const implied = new Set(trial.cons.filter((c) => over.has(solved.indexOf(c))));
            if (implied.size) {
              const rest = trial.cons.filter((c) => !implied.has(c));
              this.constraints = this.constraints.filter((c) => !implied.has(c));
              this.trial = rest.length ? { ...trial, cons: rest } : null;
              if (!rest.length) trial.dropRedundant([]);
              this.solveDirty = true; // re-solve without them
              continue;
            }
            this.trial = null;
            trial.dropRedundant(trial.cons);
          }
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
      // a projection refresh still lands, unsolved, the way it lands in a
      // sketch with nothing to solve
      const refresh = this.pendingRefresh;
      this.pendingRefresh = null;
      if (refresh) {
        this.entities = this.entities.map((e) =>
          e.type === "projected" && refresh.has(e.id) ? applyProjectionUpdate(e, refresh.get(e.id)!) : e);
      }
      if (!this.solverDeadToast) {
        this.solverDeadToast = true;
        toast(
          err instanceof SolverUnavailable
            ? err.message
            : t("sketch.solver.stopped"),
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
    //
    // onState waits for the end of a drag too. Nothing it reports (tool, undo
    // buttons, ribbon, prompt) can change mid-gesture, and on every drag frame it
    // re-laid-out the ribbon: 1.6 ms of each frame on the GH #17 reporter's
    // sketch. endDrag fires it once, on release.
    if (!this.dragFrom && !this.moveDrag) {
      this.armPreEdit();
      this.onState?.();
    }
    // A release that arrived with its last move still unsolved (see endDrag):
    // that move has now landed, so finish the release.
    const release = this.dragRelease;
    if (release) {
      this.dragRelease = null;
      this.pendingDrag = null; // consumed, or the solver died: never wait on it twice
      this.endDrag(release.pointerId);
    }
  }

  // --- interactive drag: grab a point, geometry follows, constraints hold ---
  /** Find the nearest drag handle within pick tolerance of p. The enumeration
   *  itself is pure and lives in modify.ts, so it can be tested without a
   *  viewport. */
  private pickPoint(p: THREE.Vector2): { p: THREE.Vector2; idx: number } | null {
    const g = pickDragPoint(this.entities, p, this.pickTol());
    return g ? { p: new THREE.Vector2(g.x, g.y), idx: g.idx } : null;
  }

  /** Queue a drag target; the latest target wins.
   *
   *  Solving EVERY pointermove ran a full planegcs solve plus the UI update per
   *  move: 7-12 ms each on the GH #17 reporter's 15-constraint sketch, and WebKit
   *  hands a fast hand several moves per frame. Only the frame's last solve ever
   *  reached the screen, and each one before it delayed the frame that would
   *  show it. So a frame gets one drag step in the event that starts it, and one
   *  more, of the newest target, for whatever lands after (queueDragFrame). */
  private queueDrag(to: THREE.Vector2) {
    if (!this.dragFrom || this.dragRelease) return;
    this.pendingDrag = { fromX: this.dragFrom.x, fromY: this.dragFrom.y, toX: to.x, toY: to.y };
    this.queueDragFrame();
  }

  /** The first moving frame of a Shift-drag (or of a press a right-click
   *  Disconnect armed) on a point several curves share: pull ONE end off it,
   *  and drag that end alone for the rest of the gesture. Which end: the one of
   *  the curve the press landed on, or, for a press on the point's dot itself
   *  (the one place the user is sent to), the one whose curve heads the way the
   *  drag goes (detachableEnd). Without this, two ends at one spot are joined
   *  for good (detachEndpoint says why), which is what made Break's halves
   *  inseparable.
   *
   *  False when this frame must not drag: the cursor is still inside the shared
   *  point's position bucket (an end put there would merge straight back), or
   *  the pull was refused, which ends the gesture with the geometry untouched. */
  private detachFrame(w: THREE.Vector2): boolean {
    const press = this.dragDetach, from = this.dragFrom;
    if (!press || !from) return true;
    if (coincKey(w.x, w.y) === coincKey(from.x, from.y)) return false;
    this.dragDetach = null;
    // "on the dot": its drawn radius, doubled for the aim of a hand on a mouse
    const r = detachEndpoint(this.entities, from, press, w, this.constraints, this.endpointDotRadius() * 2, this.dragDetachRelease);
    if (!r) return true; // nothing shares this point: an ordinary drag
    if (r.kind !== "detached") {
      toast(r.kind === "coincident" ? t("sketch.guard.coincidentHolds") : FIXED_POINT_MSG);
      this.dragFrom = null;
      this.dragSnapshot = null;
      return false;
    }
    this.entities = r.entities;
    if (r.constraints) {
      this.dragConsBefore = this.constraints;
      this.constraints = r.constraints;
      this.conflictIdx.clear(); // indices shift; the next solve repopulates
      this.overIdx.clear();
    }
    from.copy(w); // the pulled end sits under the cursor: the drag pins it from here
    return true;
  }

  /** Queue the BODY drag's settle for this frame: re-satisfy the constraints
   *  with the dragged entities held where the translate just put them. Through
   *  the same in-flight lock as queueDrag, and deliberately NOT through
   *  requestSolve() — that banks an undo step, and a drag is ONE step (banked by
   *  endDrag), not one per pointermove.
   *
   *  A body with no attachment points (text, or a polygon or slot no
   *  constraint names) gets the frame's redraw and no solve: it owns no solver point, so nothing rides along with
   *  it and nothing can be pinned — the solve would re-satisfy constraints that
   *  never went out of agreement, at the price of a full solve every frame.
   *  So does every body once the solver is gone (solverDead): pump() would
   *  return at once, and the frame would draw nothing until the release.
   *
   *  So does a selection with more pins than the solver's anchor budget: every
   *  pin is an anchor, and past a few hundred of them the wasm heap can abort,
   *  which pump() reads as a dead solver for the rest of the session (measured:
   *  200 lines parallel to one, all dragged, 402 pins, Aborted(OOM); see
   *  MAX_BIAS_ANCHORS). Such a drag translates frame by frame and settles once,
   *  on release. */
  private queueBodyDrag(group: number[]) {
    const pins = group.reduce((n, i) => {
      const e = this.entities[i];
      return n + (e ? attachmentPoints(e, this.constraints).length : 0);
    }, 0);
    if (pins > 0 && pins <= MAX_BIAS_ANCHORS && !this.solverDead) this.pendingPinIdxs = group;
    else this.bodyDragUndrawn = true;
    this.queueDragFrame();
  }

  /** Bring the screen up to the newest move: at once, when this frame has had
   *  no drag step yet, and for the moves that land after that, once more at the
   *  start of the next frame, ahead of its draw (Viewport.beforeNextDraw).
   *
   *  The first step runs in the move's own event, as every move did before
   *  GH #17. Deferring it to the frame measured slower on WebKitGTK: where the
   *  webview has to wait for the compositor before its next frame, the event
   *  uses that wait to solve, and a solve in the frame adds its whole time to
   *  every move (16-19 ms from a move to the screen, against 21-24 with every
   *  solve in the frame). Through a plain requestAnimationFrame the second step
   *  would land after the frame's draw, one frame behind the pointer. */
  private queueDragFrame() {
    if (this.dragFrameQueued) return;
    this.dragFrameQueued = true;
    this.viewport.beforeNextDraw(() => this.runDragFrame());
    this.dragStep();
  }

  /** The frame's second drag step (see queueDragFrame). */
  private runDragFrame() {
    this.dragFrameQueued = false;
    this.dragStep();
  }

  /** One drag step: the newest queued solve, which redraws when it lands, or
   *  only the redraw for a body drag the solver holds nothing of. */
  private dragStep() {
    if (!this.active) return;
    if (this.pendingDrag || this.pendingPinIdxs !== null) void this.pump();
    else if (this.bodyDragUndrawn && this.moveDrag?.started) this.refreshDragGeometry();
  }

  /** What a body drag grabbed at `idx` moves: the whole selection when the
   *  grabbed entity is part of a multi-selection (report 3f16187e: "select
   *  multiple sketch lines / shapes and drag them somewhere together"), and
   *  that one entity otherwise. The origin is not the user's geometry and never
   *  moves, so a selection that includes it drags without it. GRABBING the
   *  origin stays a drag of the origin alone, which the arming branch refuses
   *  with its toast: a Shift-clicked axis is still the thing under the cursor,
   *  and dragging it must not quietly move the rest of the selection. */
  private dragGroup(idx: number): number[] {
    const grabbed = this.entities[idx];
    const owners = this.selectedOwners();
    if (!grabbed || isOriginGeometry(grabbed.id) || owners.size < 2 || !owners.has(grabbed.id)) return [idx];
    const out: number[] = [];
    this.entities.forEach((e, i) => {
      if (owners.has(e.id) && !isOriginGeometry(e.id)) out.push(i);
    });
    return out.length ? out : [idx];
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
      if (!b.additive) { this.selected.clear(); this.overlay.clearRegionSelection(); }
      this.refreshActive();
      return;
    }
    // Origin geometry is reference, never a selection target: a marquee over the
    // whole sketch would otherwise always drag the axes in with it.
    const hits = entitiesInBox(
      this.entities.filter((e) => !isOriginGeometry(e.id)),
      boxFromDrag(b.from, b.to),
    );
    if (!b.additive) this.selected.clear();
    for (const id of hits) addKey(this.selected, id); // a box takes whole entities
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
      this.pendingPinIdxs = null; // the release solve below supersedes any queued frame
      if (pointerId != null) {
        try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
      }
      const ent = this.entities[md.idx];
      if (!md.started) {
        // never moved: this was a click, which (de)selects what it landed on
        this.dragSnapshot = null;
        if (ent) {
          clickKey(this.selected, md.key, md.additive);
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
    // The gesture's last move can still be waiting for its frame (queueDrag).
    // Releasing on top of it would drop it, and the point would stop one frame
    // short of where the button came up. Solve it now; pump() finishes the
    // release when it lands. With the solver loaded that is still inside this
    // event's microtasks, so no other input sees the half-released state.
    if (this.pendingDrag && !this.solverDead) {
      this.dragRelease = { pointerId };
      void this.pump();
      return;
    }
    this.dragFrom = null;
    this.pendingDrag = null;
    this.pendingPinIdxs = null;
    if (pointerId != null) {
      try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
    }
    if (!this.dragMoved) {
      // never moved: a click on a vertex, which (de)selects that POINT (GH
      // #17); it used to take the entity owning it, and before that it
      // silently did nothing. The second click of a double-click takes the
      // whole entity or chain instead.
      this.dragSnapshot = null;
      const key = this.dragKey;
      const whole = this.dragWhole;
      this.dragKey = null;
      this.dragWhole = null;
      if (whole && this.takeWhole(whole, this.dragAdditive, this.dragStartClient)) return;
      if (key) clickKey(this.selected, key, this.dragAdditive);
      this.refreshActive();
      return;
    }
    this.dragWhole = null;
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
      this.clearPendingGlyph();
    } else if (this.arcStart && this.arcEnd) {
      // the arc the click would make, tangent where it will be, and its badge
      const { arc, tangents } = this.arcInference(this.arcPoints(cursor), PENDING_ID);
      const drawn: ResolvedEntity = { type: "arc", id: PENDING_ID, ...arc };
      this.overlay.setPreview([this.entityCurve(drawn)]);
      this.showPending(drawn, tangents.map((other): SketchConstraint => ({ type: "tangent2", a: PENDING_ID, b: other })));
    } else {
      this.overlay.setPreview([]);
      this.clearPendingGlyph();
    }
  }

  /** preview while drawing a centre-point arc: the radius after the centre
   *  click, then the arc itself, swept the way the cursor has gone */
  private arcCenterPreview(cursor: THREE.Vector2) {
    const [center, start] = this.clickPts;
    if (center && !start) {
      this.overlay.setPreview([
        this.entityCurve({ type: "line", id: "", x1: center.x, y1: center.y, x2: cursor.x, y2: cursor.y }),
      ]);
    } else if (center && start) {
      this.arcSweep = advanceCenterArcSweep(this.arcSweep, center, start, cursor);
      this.overlay.setPreview([this.entityCurve({ type: "arc", id: "", ...centerArcEntity(center, start, this.arcSweep) })]);
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
