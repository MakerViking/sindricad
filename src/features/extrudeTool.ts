// Interactive Extrude (MCAD-style): select one or more profile AREAS, then set
// the distance by DRAGGING the arrow manipulator along the profile normal, or by
// typing it (live solid preview + arrow + numeric box). The arrow is a handle:
// it moves the depth while it is being dragged and at no other time — hovering
// never changes anything, and a press that has not travelled yet is still a
// click (fields 3998d6ea / 6e2bcadd). A click commits, on the RELEASE. Areas can
// be pre-selected in the sketch or picked here: plain click picks one and goes
// straight to the depth step, Ctrl-click adds more (Enter to confirm the set). A
// ring (annulus) area previews/extrudes as a tube; selecting several areas
// unions them. Operation auto-selects: New Body when nothing exists, otherwise
// Cut when the profile pushes into an existing body and Join when it pulls away
// (both overridable in the panel).
//
// The docked Extrude panel (GH #41) holds everything else an extrude has, typed
// BEFORE it exists rather than in the inspector afterwards: where it starts
// (the profile plane, an offset, or an OBJECT: a face, a plane, a point or a
// line), one side or symmetric, a distance or up to a target (a face, a plane,
// a corner, a sketch point or a line, with a target offset), a taper, and the
// operation. A taper, a target or a start object cannot be drawn by the
// instant ghost, so those preview through the real build (store.setPreview).
// Enter, OK or a click commits; with a target set, a click on another target
// aims there instead.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { drawOnTop } from "../viewport/gizmos";
import { selectionOutline, type RegionRef, type SketchOverlay, type WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { EdgeFingerprint, ExtrudeRef, ExtrudeStart, FaceFingerprint, Feature, Num, Plane3, Selector } from "../types";
import type { EdgeRef } from "../viewport/render";
import { edgeSelectorFrom } from "../viewport/edgeMatch";
import { lineOperand, refPoint } from "../sketch/entityDims";
import { distToSeg, paramOnSeg } from "../sketch/geom2d";
import type { SketchPlane } from "../sketch/plane";
import type { ResolvedEntity } from "../sketch/snap";
import { pointInRegion } from "../sketch/region";
import { DimInput } from "../sketch/dimInput";
import { round } from "../ui/units";
import { setPrompt } from "../ui/prompt";
import { axisDragDistance, pixelDistanceToSegment } from "./manipulator";
import { t } from "../i18n";
import { ToolPanel } from "../ui/toolPanel";
import { planeLabel, refLabel } from "../ui/featureMeta";
import { featureErrorMessages } from "../geometry/featureErrorText";
// One number for "the depth a fresh extrude starts at", shared with the store:
// clearing an up-to target has to restore a depth, and two constants would
// drift. It lives in the document layer because the store cannot import this
// file (that would pull the viewport stack into the document layer).
import { DEFAULT_EXTRUDE_DISTANCE } from "../document/numFields";
import { isImeComposing } from "../ui/focus";

type Phase = "pick" | "drag";
/** A selected face Extrude was started on: its pick, as the viewport hands
 *  it over (selectedFaceSketchPlane, so already known to be flat and on a
 *  known body). */
export interface FromFace {
  selector: Selector;
  bodyId: string;
  normal: THREE.Vector3;
  anchor: THREE.Vector3;
}

/** An up-to target, one of the three exclusive kinds (see setUpTo). */
type Target = { face: Selector } | { plane: string } | { ref: ExtrudeRef };
type Op = "new" | "join" | "cut" | "intersect";
/** The values the panel types that the INSPECTOR can also set on a committed
 *  extrude, so an edit has to know which of them the user changed here. */
type PanelValue = "startOffset" | "taper" | "upToOffset";
const PANEL_VALUES: readonly PanelValue[] = ["startOffset", "taper", "upToOffset"];

/** How close, in screen pixels, a click must land to a point (a sketch point,
 *  a body corner) to name it as a start or end object rather than whatever is
 *  behind it. A little under the depth arrow's grab: a point is a smaller
 *  target than a shaft, and what is behind it is usually also a valid pick. */
const POINT_PX = 8;

/** How far a click must land to a straight sketch curve to name it. The
 *  Project tool's sketch-curve pick radius, which is the one other place the
 *  app picks a sketch curve in the model. */
const CURVE_PX = 9;

/** How far off parallel to the sketch a start or end object may be, as the
 *  sine of the angle: the sidecar's _REF_PARALLEL_TOL, checked here too so a
 *  tilted pick is refused on the click rather than after a build. */
const PARALLEL_TOL = 1e-4;

/** How close, in mm, a plane must be to the profile to count as level with
 *  it (and so be skipped as a start or end), and how close behind an origin
 *  plane a construction plane may be and still win the click. */
const LEVEL_TOL = 1e-4;

/** The origin planes' normals, as SketchPlane builds them (n = u x v). Only
 *  the direction matters here: each passes through the world origin. */
const BASE_NORMAL: Record<Plane3, THREE.Vector3> = {
  XY: new THREE.Vector3(0, 0, 1),
  XZ: new THREE.Vector3(0, -1, 0),
  YZ: new THREE.Vector3(1, 0, 0),
};

/** What a click in the model names as a start or end object (GH #41), before
 *  it is checked against the profile and turned into a stored reference. */
type Picked =
  // `flat` is asked only when a face is to be a START (refusal): it walks the
  // face's triangles, which a hover over a large face should not pay for
  | { kind: "face"; selector: Selector; bodyId: string | null; normal: THREE.Vector3; anchor: THREE.Vector3; flat: () => boolean }
  | { kind: "plane"; id: string; normal: THREE.Vector3; origin: THREE.Vector3 }
  | { kind: "sketchPoint"; sketch: string; entity: string; point: number; world: THREE.Vector3 }
  | { kind: "sketchLine"; sketch: string; entity: string; a: THREE.Vector3; b: THREE.Vector3 }
  | { kind: "edge"; edge: EdgeRef; selector: Selector }
  | { kind: "vertex"; point: THREE.Vector3; edge: EdgeRef }
  | { kind: "refused"; why: string };

/** How close the cursor must be to the depth arrow, in SCREEN pixels, to take
 *  hold of it. Wide enough to catch a shaft a couple of pixels across with a
 *  mouse. It no longer has to stay narrow to protect the commit gesture —
 *  commit moved to the RELEASE of a click that did not move (onUp), so the two
 *  gestures are told apart by what the pointer does, not by where it went down. */
const GRAB_PX = 10;

/** Below this projected shaft length the arrow has stopped being a line to aim
 *  ALONG: the grab disc is already 2·GRAB_PX across, so a shorter shaft adds no
 *  direction the segment test could use, and `pixelDistanceToSegment` has
 *  degenerated into that disc.
 *
 *  This is not hypothetical — it is the camera the app leaves you in. Finish
 *  Sketch calls `sketchMode.cleanup` → `viewport.exitSketchView`, which restores
 *  the projection mode and the up vector but NOT the orientation, so the view is
 *  still looking straight down the sketch normal when Extrude opens. Measured in
 *  that view (extrudeArrowHandle.test.ts, `topDown`): anchor and tip both project
 *  to (400,300) — a 0 px shaft — and BEFORE the fallback below the entire
 *  grabbable set was a 21 px disc at the profile centre. */
const DEGENERATE_SHAFT_PX = 2 * GRAB_PX;

/** Press-to-drag threshold in screen pixels: under this a press is still a
 *  CLICK. Same number and same reason as sketchMode's point/body drags
 *  ("<4px: still a click"), reused rather than re-chosen so the two halves of
 *  the app do not disagree about what a click is. */
const DRAG_START_PX = 4;

/** The shortest arrow that is ever DRAWN, in mm. A near-zero depth still has to
 *  show a handle, so `updatePreview` floors the length here — and `overArrow`
 *  reads the same floor, because an arrow you can see but cannot grab is
 *  precisely field 6e2bcadd. One constant, so the two cannot drift. */
const ARROW_MIN_MM = 1;

/** Whether there is a body, and whether each selected area meets material a
 *  hair along (+) and against (-) its normal from where the extrude starts,
 *  with what it was read at (ExtrudeTool.readingKey). */
type SolidReading = { key: string; solid: boolean; plus: boolean[]; minus: boolean[] };

/** One area of the feature being edited, in the document's own shape.
 *
 *  This IS `RegionRef` with nothing optional: `point` and `holeEntityIds` are
 *  optional there because a caller may not record them, but an area that is
 *  going back into the document has both. Declaring it as a narrowing rather
 *  than a second type keeps one description of the persisted triple
 *  (`regions` / `regionEntities` / `regionHoleEntities`, one index at a time),
 *  so a fourth field is added in one place and not three. */
type CarriedRegion = RegionRef & {
  point: [number, number, number];
  holeEntityIds: string[][];
};

/** The straight line a sketch curve presents to a click at (`cx`, `cy`) on
 *  screen, as the id a `sketchLine` reference stores and its two ends in the
 *  world: a line or a projected line is itself, and a rectangle, polygon or
 *  slot is the SIDE nearest the cursor, `<shapeId>~<k>`, the way its sketch's
 *  constraints name that side (entityDims.lineOperand, which numbers the sides
 *  and which the sidecar reads in step). Null for a curve that is not
 *  straight, and on a slot's round end, which is no side: no side then comes
 *  within `maxPx`. A side hidden behind a body at this pixel (`hidden`) is
 *  not one, as committedCurveAt has it. */
function lineUnderCursor(
  e: ResolvedEntity,
  plane: SketchPlane,
  cx: number,
  cy: number,
  project: (w: THREE.Vector3) => { x: number; y: number },
  maxPx: number,
  hidden: (w: THREE.Vector3) => boolean,
): { entity: string; a: THREE.Vector3; b: THREE.Vector3 } | null {
  const one = new Map([[e.id, e]]);
  const sides = e.type === "rectangle" ? 4 : e.type === "polygon" ? Math.max(3, Math.round(e.sides)) : e.type === "slot" ? 2 : 0;
  const ids = sides ? Array.from({ length: sides }, (_, k) => `${e.id}~${k}`) : [e.id];
  const q = { x: cx, y: cy };
  let best: { entity: string; a: THREE.Vector3; b: THREE.Vector3 } | null = null;
  let bestD = sides ? maxPx : Infinity; // a line was already found near the cursor
  for (const id of ids) {
    const seg = lineOperand(one, id);
    if (!seg) continue;
    const a = plane.to3D(seg.x1, seg.y1), b = plane.to3D(seg.x2, seg.y2);
    const sa = project(a), sb = project(b);
    const d = distToSeg(sa, sb, q);
    if (d >= bestD) continue;
    if (sides && hidden(a.clone().lerp(b, Math.max(0, Math.min(1, paramOnSeg(sa, sb, q)))))) continue;
    best = { entity: id, a, b };
    bestD = d;
  }
  return best;
}

/** Where end `end` of an edge is, read off its fingerprint the way the sidecar
 *  picks it (_edge_end: end 1 lies further along `dir`): exactly for a line,
 *  from its centre, radius and length for an arc, at its middle otherwise. */
function edgeEndOf(fp: EdgeFingerprint, end: 0 | 1): THREE.Vector3 {
  const mid = new THREE.Vector3(...fp.mid);
  const dir = new THREE.Vector3(...fp.dir).normalize();
  const sign = end === 1 ? 1 : -1;
  if (fp.curve === "line" && fp.length !== undefined) return mid.addScaledVector(dir, (sign * fp.length) / 2);
  if (fp.curve === "circle" && fp.center && fp.radius && fp.length !== undefined) {
    const c = new THREE.Vector3(...fp.center);
    const r = mid.clone().sub(c).normalize();
    const half = fp.length / (2 * fp.radius);
    return c.addScaledVector(r, fp.radius * Math.cos(half)).addScaledVector(dir, sign * fp.radius * Math.sin(half));
  }
  return mid;
}

/** A text field (the command palette, a Browser rename, a panel field): it
 *  keeps its own keys. Read off the tag rather than instanceof, so the stubbed
 *  key events the tests send pass straight through. */
function isTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el) return false;
  return (typeof el.tagName === "string" && /^(input|textarea|select)$/i.test(el.tagName)) || el.isContentEditable === true;
}

export class ExtrudeTool {
  active = false;
  private phase: Phase = "pick";
  private selected: WorldRegion[] = [];
  private distance = DEFAULT_EXTRUDE_DISTANCE;
  private preview: THREE.Group | null = null;
  private previewMat: THREE.MeshStandardMaterial | null = null;
  private previewEdgeMat: THREE.LineBasicMaterial | null = null;
  private previewKey = ""; // depth+sign+selection of the built preview geometry
  private arrow: THREE.ArrowHelper | null = null;
  private dim = new DimInput();
  /** A live handle drag: the axis reading at the moment the arrow was grabbed,
   *  and the depth it had then. Non-null ONLY between the moment a press on the
   *  arrow turns into a drag (past DRAG_START_PX) and the release — which is the
   *  whole of the fix for fields 3998d6ea and 6e2bcadd. The arrow is a handle,
   *  so a pointer move outside that window has no route to the depth at all, and
   *  inside it every path has the same one.
   *
   *  This is the model pressPullTool already ships (`grabbing` / `grabValue` /
   *  `grabProj`, "grabbing the handle scrubs; a clean click elsewhere commits").
   *  Extrude was the tool left behind, not the one being redesigned. */
  private grab: { axis: number; distance: number } | null = null;
  /** An unresolved left-button press in the drag phase: where it went down,
   *  whether it went down on the handle, and whether it has yet travelled far
   *  enough to be a drag rather than a click.
   *
   *  It exists because BOTH gestures the drag phase offers start with a press in
   *  the same place. The arrow is anchored at the region's interior point, which
   *  is where the profile is and where the prompt has taught users to click to
   *  commit — so a press cannot be classified when it arrives, only once the
   *  pointer has either moved (drag) or come back up in place (click). Deciding
   *  at pointerdown is what let a press on the arrow throw away a typed depth,
   *  and a press that MISSED the arrow by 15 px commit a feature the user was
   *  still editing. */
  private press: { x: number; y: number; onArrow: boolean; moved: boolean } | null = null;
  private hitScratch = new THREE.Vector3();
  private onDone: ((id: string | null) => void) | null = null;

  // --- edit mode (re-opening a committed extrude) ---
  private editId: string | null = null; // committed feature id being edited
  private editHiddenBodies: string[] | undefined; // participants captured at creation — KEPT
  private editSeparateBodies: boolean | undefined; // ditto: an edit must not change body COUNT
  private editJoinTouchingOnly: boolean | undefined; // ditto: nor which bodies a join takes in
  /** The saved start offset, taper and target offset of the feature being
   *  edited. Before the panel only the inspector could set them, and an edit
   *  that did not load them deleted them on commit — a bare depth nudge threw
   *  away numbers the user typed (GH #41). Same contract as the end condition
   *  above: what startEdit does not load, commit destroys. A value the panel
   *  did not change is still written back from the document (panelValues). */
  private editStartOffset: Num | undefined;
  private editTaper: Num | undefined;
  private editUpToOffset: Num | undefined;
  /** the depth the edited feature was saved with; null on a fresh extrude */
  private editDistance: number | null = null;
  /** Areas of the feature being edited that this tool could NOT resolve, held
   *  exactly as the document has them and written straight back on commit. See
   *  startEdit: without this, editing the depth of a feature whose sketch has
   *  partly changed DELETES the areas the tool could not draw. */
  private editCarried: CarriedRegion[] = [];
  // --- end condition: "extrude UP TO that face / plane" (issue #41) ---------
  // The same three-field vocabulary press/pull uses, and set through the same
  // one-way door (`setUpTo`), because the sidecar REFUSES a feature carrying
  // both a face target and a plane target rather than picking one.
  private upTo: Selector | null = null;
  private upToPlane: string | null = null;
  /** ...or up to a point or a straight line (GH #41 b), the third kind */
  private upToRef: ExtrudeRef | null = null;
  private pickingTarget = false; // waiting for the user to click the up-to target
  // --- start object: "start the extrude from that face / plane / point / line"
  /** What Start = Object starts from; null until one is picked. */
  private startRef: ExtrudeStart | null = null;
  /** The face Extrude was started on (start's `fromFace`), held until the
   *  first profile is picked, when it becomes the start object. */
  private fromFace: FromFace | null = null;
  /** How far the start object sits from the sketch, along the profile normal,
   *  as far as this tool can tell without a build: exact at the pick, and read
   *  from the document or the reference's own fingerprint on an edit (which
   *  can lag a body edited upstream; the built preview shows the truth). It
   *  places the depth arrow and steers the operation guess. */
  private startRefDist = 0;
  private pickingStart = false; // waiting for the user to click the start object
  /** The Start choice to go back to when a start pick is abandoned with
   *  nothing picked, so Escape does not leave an empty Object box behind. */
  private startModeBefore: "profile" | "offset" = "profile";
  /** A picked edge, corner or face whose reference the sidecar is authoring
   *  right now (a by:"match" fingerprint, store.queryReferences). `token`
   *  drops a reply that a newer pick, a cancel or a close made stale. */
  private pending: { role: "start" | "end"; token: number } | null = null;
  private pendingSeq = 0;
  /** Why the last start or end pick was refused, shown in the panel until the
   *  next pick; null = nothing refused. */
  private pickNote: string | null = null;
  /** while editing, this sketch is forced visible so its regions exist
   *  (consumed sketches hide by default) — main.ts's isSketchVisible honors it. */
  forcedSketchId: string | null = null;

  // --- the docked panel (GH #41) ---------------------------------------------
  private panel = new ToolPanel("extrude-panel");
  /** Start: on the profile plane, `startOffset` away from it, or from an
   *  object (`startRef`, plus the start offset measured from it) */
  private startMode: "profile" | "offset" | "object" = "profile";
  private startOffset = 0; // mm, along the profile normal
  /** Direction: half the distance each side of the start (the persisted flag) */
  private symmetric = false;
  private taper = 0; // degrees
  private upToOffset = 0; // mm, along the extrude direction
  /** Which panel values the user changed. On an EDIT the others are written
   *  back from the document as it is at commit, never from a snapshot (field
   *  637278a9), and a parameter binding rides along as the binding it is. */
  private edited = new Set<PanelValue>();
  /** Panel values the user may not type over, with the reason: a value bound
   *  to a parameter changes in Parameters, or the binding would put it back. */
  private readOnly: Partial<Record<PanelValue, string>> = {};
  /** The operation, guessed from where the extrude goes until the user picks
   *  one (`opPinned`). An edit opens pinned on the saved operation. */
  private op: Op = "new";
  private opPinned = false;
  /** Is there a body to join, cut or intersect? Read when the depth step
   *  starts, before this tool's own preview can put one on screen. */
  private hasSolid = false;
  /** Id of the feature being made: the live preview and the commit share it,
   *  so a preview failure can be read back off the build by id. */
  private previewId = "";
  /** The feature last handed to the store's live preview, as JSON; "" = none. */
  private sentPreview = "";
  private offBuild: (() => void) | null = null;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundCancel: () => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private overlay: SketchOverlay,
    private store: DocumentStore,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundCancel = () => this.onCancel();
    this.boundKey = (e) => this.onKey(e);
  }

  /** `fromFace`: Extrude was started on a selected FLAT face, so it starts
   *  from that face (GH #41 a) once a profile is picked. The face is checked
   *  against the profile then, like a face clicked into the Start box. */
  start(onDone: (id: string | null) => void, opts: { fromFace?: FromFace } = {}) {
    if (this.active) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    // A fresh extrude has no end condition. Cleared HERE and not in beginDrag,
    // which startEdit also calls and which re-runs when the user re-states the
    // area set — clearing there would silently drop a saved target on every
    // edit, the same class as the carried areas this tool already protects.
    this.upTo = null;
    this.upToPlane = null;
    this.upToRef = null;
    // A FRESH extrude must not inherit the last edited feature's inspector
    // values. Cleared here rather than in beginDrag for the same reason as the
    // end condition above: startEdit calls beginDrag too.
    this.editStartOffset = undefined;
    this.editTaper = undefined;
    this.editUpToOffset = undefined;
    this.editDistance = null;
    this.pickingTarget = false;
    // ...nor the last session's panel values: the tool instance is reused
    this.resetPanelValues();
    this.fromFace = opts.fromFace ?? null;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    // The release is where an extrude commits and where a handle drag ends, and
    // it goes on WINDOW rather than the canvas — see onUp for why both.
    window.addEventListener("pointerup", this.boundUp);
    window.addEventListener("pointercancel", this.boundCancel);
    window.addEventListener("keydown", this.boundKey, true);
    // honour any areas pre-selected in the sketch
    this.selected = this.overlay.selectedRegions();
    if (this.selected.length) {
      this.beginDrag();
    } else {
      setPrompt(t(this.fromFace ? "feature.extrude.fromFacePrompt" : "feature.extrude.pickPrompt"));
    }
  }

  /** Re-open a committed extrude for editing: the model rolls back to just
   *  before it, its sketch is forced visible, the saved profile areas are
   *  pre-selected, and the saved distance seeds the input — drag the arrow,
   *  retype, or Ctrl-click areas, then commit to REPLACE the feature in place
   *  (same id, one undo step). Returns false when the distance is a parameter
   *  expression (the inspector's job). */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "extrude") return false;
    if (typeof f.distance !== "number" || this.store.isParamBound({ kind: "feature", feature: f.id, field: "distance" }))
      return false; // parameter-driven distance — inspector's job

    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.editId = featureId;
    this.editHiddenBodies = f.hiddenBodies;
    this.editSeparateBodies = f.separateBodies;
    this.editJoinTouchingOnly = f.joinTouchingOnly;
    // Carry the saved end condition through the edit. Not restoring it here is
    // how a depth tweak would silently turn an "up to that face" extrude back
    // into a blind one — `commit` writes what these fields hold, so anything
    // startEdit does not load, commit deletes.
    this.upTo = f.upTo ?? null;
    this.upToPlane = f.upToPlane ?? null;
    this.upToRef = f.upToRef ?? null;
    // The values the panel shows, loaded for the same reason. They ride along
    // untouched unless the user changes them here.
    this.editStartOffset = f.startOffset;
    this.editTaper = f.taper;
    this.editUpToOffset = f.upToOffset;
    this.pickingTarget = false;
    this.loadPanelValues(f);
    this.distance = f.distance;
    this.editDistance = f.distance;
    this.forcedSketchId = f.sketch;

    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("pointerup", this.boundUp); // on window — see start()
    window.addEventListener("pointercancel", this.boundCancel);
    window.addEventListener("keydown", this.boundKey, true);

    // roll the model back so the pre-extrude state is what previews/op-guesses
    // see (exactly what the tool saw at creation), then rebuild the overlay so
    // the now-forced-visible sketch contributes regions to select from.
    this.store.beginEditPreview(featureId);
    // until the rollback lands, the screen still shows this feature's own solid
    this.awaitingBuild = true;
    this.overlay.update(this.store.document);
    const saved: [number, number, number][] = (
      f.regions ?? (f.region ? [f.region] : [])
    ) as [number, number, number][];
    // Resolve each area by the ENTITIES it was picked on, not by its stored
    // point. The point does not move with the geometry (field a20cca53), and on
    // a holed profile a stale point lands inside the HOLE — containment
    // succeeds, the hole's own cell comes back selected, and committing any
    // edit (a bare depth change is enough) writes that hole over the feature.
    // That is field 19314fdc's other half: the sidecar builds the wall while the
    // edit tool reopens on the hole. An area with no ids recorded is still
    // resolved by its point — that much the sidecar still does too (`if not
    // eids ... return None` falls back) — but per reference and inside THIS
    // sketch, and a point that now lands in no cell is reported unresolved so
    // the caller can carry it. The sidecar parenthetical holds for the BUILD;
    // it stopped describing the EDIT the moment losing an area became possible.
    //
    // One arm, not two. The `if (f.regionEntities?.length)` fork that used to
    // stand here sent a WHOLLY pre-0.1.123 feature (no `regionEntities` key at
    // all) down `selectRegionsByPoints`, which drops a point inside nothing
    // without saying so: measured, a two-area legacy extrude whose sketch had
    // since moved +20 mm came back with one area and committed one on a bare
    // depth change, no banner. The id-less arm of `selectRegionsByEntities`
    // was already written for exactly that document; nothing routed to it
    // unless a SIBLING reference happened to carry ids.
    const ents = f.regionEntities;
    const answer = this.overlay.selectRegionsByEntities(
      f.sketch,
      saved.map((p, i) => ({
        entityIds: ents?.[i] ?? [],
        // `undefined` (not `[]`) when this document never recorded them: every
        // file written between 0.1.123 and the release that added the field
        // names outer loops only, and "unknown holes" must not read as "no
        // holes" — see regionsByEntities.
        holeEntityIds: f.regionHoleEntities?.[i],
        point: p,
      })),
    );
    const unresolved: RegionRef[] = answer.unresolved;
    // The regions the IDS resolved, not what the overlay lights up. Reading
    // the selection back instead round-trips this answer through a world
    // point, and `selectedRegions` re-resolves a point against every coplanar
    // sketch — so a neighbouring sketch's region joined the feature and
    // commit wrote it (route B: 18000 mm³ of wall became 50000 mm³, and the
    // feature's `sketch` field was rewritten to the neighbour, on nothing but
    // a depth change). Identity established by ids is kept as identity, and a
    // legacy area is now fenced by `selectRegionsByEntities`'s own `inSketch`
    // filter rather than by `editSelection` — same fence, one implementation.
    this.selected = answer.resolved;
    // An area the tool cannot show is still an area of the FEATURE. Writing back
    // only what is selected would delete it on a bare depth change — one ordinary
    // gesture, no confirmation, geometry gone, which is the same class of silent
    // corruption this whole fix exists to remove. So the references that did not
    // resolve are carried through commit byte for byte: this tool has no opinion
    // about an area it could not find, and the sidecar's own resolution rule is
    // not this one (it accepts references this refuses, and falls back to the
    // stored point otherwise), so the build is unaffected either way.
    //
    // CARRIED WHETHER OR NOT ANYTHING RESOLVED, and that is the fix for the
    // regression this file's own change introduced. Routing legacy features
    // through `selectRegionsByEntities` imported its "one cell or nothing" rule,
    // which is right when IDS narrow to several cells and wrong when a bare
    // POINT sits inside overlapping ones — two exactly coincident circles, or a
    // text glyph over the plate it sits on. That is ordinary geometry, not a
    // changed sketch, so the whole feature went down the nothing-resolved arm
    // and a re-pick replaced the area set. Refusing to DRAW an area is never a
    // reason to delete it.
    //
    // `unresolved` are already RegionRefs built from the document at the top of
    // this method, so they carry a point by construction; absent hole ids carry
    // as `[]`, which is what the sidecar already makes of absent (`for grp in
    // (hole_eids or [])`), recording no claim the document did not already make.
    this.editCarried = unresolved.map((ref) => ({
      ...ref,
      point: ref.point ?? [0, 0, 0],
      holeEntityIds: ref.holeEntityIds ?? [],
    }));
    if (this.selected.length) {
      // They are dropped only when the user changes the area set, because that
      // gesture re-states the set — see onDown, BOTH branches of it.
      this.beginDrag();
      if (unresolved.length) {
        // beginDrag sets its own prompt, so this replaces it. An area whose ids
        // no longer name a cell is NOT quietly re-resolved from its point: the
        // sketch really did change, and a wrong area committed in silence is the
        // whole defect. Say which, and say what happens to it.
        setPrompt(t("feature.extrude.edit.partlyUnmatched", { count: unresolved.length, total: saved.length }));
      }
    } else {
      // Nothing could be DRAWN. The areas are still held (above), so a depth
      // edit committed from here keeps them; picking states a new set and drops
      // them, which onDown's pick branch now does explicitly.
      //
      // Two different causes, and the message distinguishes them because only
      // one is the sketch's fault. A reference carrying IDS that no longer name
      // a cell means the sketch really did change. A reference with only a
      // POINT can fail on a document nobody has touched, by landing inside
      // overlapping cells — coincident profiles, or a text glyph over the plate
      // beneath it. Telling that user their sketch changed is a guess presented
      // as a fact, and it sent them looking for an edit they never made.
      const changed = unresolved.some((ref) => ref.entityIds?.length);
      setPrompt(t(changed ? "feature.extrude.edit.notFound" : "feature.extrude.edit.cannotShow", { count: saved.length }));
    }
    return true;
  }

  /** The overlay's selection, cut down to the sketch this edit belongs to.
   *
   *  A feature names ONE sketch (`Feature.sketch`), so an area from another one
   *  cannot be part of it — but `selectedRegions` matches by world point and
   *  accepts any region within ~1e-3 mm of the plane, so a second sketch drawn
   *  on the SAME plane hands back its regions too. Committing those wrote a
   *  foreign sketch's area into the feature AND retargeted `sketch` to it, on a
   *  reopen and a click. Outside edit mode this changes nothing (the pick phase
   *  is the user stating the set from scratch). */
  private editSelection(): WorldRegion[] {
    const sel = this.overlay.selectedRegions();
    const own = this.forcedSketchId;
    if (!this.editId || own === null) return sel;
    return sel.filter((wr) => wr.sketchId === own);
  }

  /** True when this click is on another sketch's area while editing — refused
   *  out loud, because silently ignoring it is the affordance bug and silently
   *  taking it is the geometry bug. */
  private refusesForeignRegion(r: WorldRegion): boolean {
    if (!this.editId || this.forcedSketchId === null) return false;
    if (r.sketchId === this.forcedSketchId) return false;
    setPrompt(t("feature.extrude.edit.foreignRegion"));
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      this.overlay.setHoverRegion(r);
      this.viewport.domElement.style.cursor = r ? "pointer" : "default";
      return;
    }
    // T mode ("extrude up to"), or picking where it starts: show what the
    // click would bind (hoverObject).
    if (this.pickingTarget || this.pickingStart) {
      this.hoverObject(e.clientX, e.clientY);
      return;
    }
    if (!this.selected.length) return;
    const first = this.selected[0];
    if (!first) return;
    const anchor = this.arrowSpan().from;
    // A press that is no longer held cannot be a drag. `pointerup` is heard on
    // window, but a release the browser never delivers at all — dragging out of
    // the window, a pointercancel, an alt-tab mid-gesture — would otherwise
    // leave the handle latched and the depth following the bare cursor, which
    // is field 3998d6ea exactly, arrived at from the other side. `buttons` is
    // the only thing on a move event that knows, and it costs nothing to ask.
    if (this.press && !(e.buttons & 1)) this.endPress();
    this.armDragIfMoved(e, anchor, first.plane.n);
    if (this.grab) {
      // Dragging the handle. The depth is where it stood when the arrow was
      // grabbed, plus how far along the axis the cursor has travelled since —
      // an OFFSET, not the raw axis reading. Reading it absolutely would snap
      // the depth to the cursor on the first frame unless the user had grabbed
      // the arrow exactly at its tip, which on a 33 mm arrow means a jump of
      // tens of millimetres for taking hold of the middle of the shaft.
      const axis = axisDragDistance(this.viewport, e.clientX, e.clientY, anchor, first.plane.n);
      // Symmetric, the arrow's tip is one END of the extrude, half the distance
      // from the midplane, so the distance moves twice as far as the tip does
      // and the tip stays under the cursor. To the micrometre: past that a
      // drag's depth is pointer noise.
      this.distance = round(this.grab.distance + (axis - this.grab.axis) * (this.symmetric ? 2 : 1), 3);
      // A drag owns the field (armDragIfMoved unlocked it), so this lands. The
      // box shows the magnitude and `distance` carries the sign — the split
      // commit() reads. The panel shows the signed number, as typed.
      this.dim.updateFromCursor({ distance: Math.abs(this.distance) });
      this.panel.setNumber("distance", this.distance);
    } else {
      // NOT dragging, so the depth is not the pointer's to change. It used to
      // be: a pre-selected profile puts this tool straight into "drag" phase
      // with the field still cursor-tracking, so bare pointermoves — no button
      // ever down, no pointerdown ever dispatched — scrubbed the depth (field
      // 3998d6ea). Two bare moves were enough to swing it from the seeded
      // 10 mm to a large negative and then a large positive value; the exact
      // figures depend on where the cursor was and are not worth recording,
      // because the sign is the part that bites. The sign crossing zero flips
      // `operationFrom`'s reading
      // and with it Cut vs Join, so hovering over the sketch plane silently
      // retargeted the operation.
      //
      // The field is still read back, because typing has to reach the preview
      // without waiting for Enter, and a move is the only tick this tool gets.
      const v = this.dim.getValue("distance");
      if (v != null && this.dim.isUserDriven("distance")) this.distance = v; // the field is the truth: typed sign wins
    }
    this.positionDim(anchor);
    this.updatePreview();
    if (this.grab) return;
    // With a target set there is no arrow, and a click on a face, plane, point
    // or line aims there instead (onDown), so that is what the hover shows.
    if (this.hasTarget()) {
      this.hoverObject(e.clientX, e.clientY);
      return;
    }
    // After updatePreview, so the affordance is measured against the arrow as
    // just drawn. A handle that gives no sign of being grabbable is half of
    // field 6e2bcadd — the reporter could SEE the arrow and concluded it was
    // decoration.
    this.viewport.domElement.style.cursor = this.overArrow(e.clientX, e.clientY) ? "ns-resize" : "default";
  }

  /** Light what a click here would name as the start or the target, with the
   *  same precedence `objectAt` uses. Without it aiming is invisible: the
   *  cursor sweeps a face or an offset plane and nothing on screen says it is
   *  aimed at anything (field report c0cfee48, reported against press/pull;
   *  this tool had the gap verbatim). A point shows the snap ring; a sketch line
   *  shows the pointer only, there being no highlight for one outside a sketch. */
  private hoverObject(cx: number, cy: number) {
    const picked = this.objectAt(cx, cy);
    this.clearPickHover();
    if (picked?.kind === "sketchPoint" || picked?.kind === "vertex") {
      const at = picked.kind === "vertex" ? picked.point : picked.world;
      this.overlay.setSnap(at, "endpoint", this.viewport.camera);
      this.overlay.setSnapScale(this.viewport.pixelWorldSize(at) * 6);
      this.pointLit = true;
    } else if (picked?.kind === "edge") {
      this.viewport.hoverEdge(picked.edge);
    } else if (picked?.kind === "face") {
      this.viewport.hoverFaceAt(cx, cy);
    } else if (picked?.kind === "plane") {
      if (picked.id in BASE_NORMAL) this.viewport.hoverPlane(picked.id as Plane3);
      else this.viewport.hoverDatum(picked.id);
    }
    this.viewport.domElement.style.cursor = picked && picked.kind !== "refused" ? "pointer" : "default";
  }

  /** What a click here names as a start or end object, smallest thing first:
   *  a point (a sketch point or a body corner, whichever is nearer the cursor),
   *  then a sketch line, then the body (an edge when the cursor is on it, else
   *  a face), then a construction plane or an origin plane, whichever is in
   *  front. A plane only on a body MISS: the same BODY-FIRST precedence
   *  viewport.handleClick uses, so a plane's quad floating in front of the
   *  solid can never steal a face pick (field report ffab4ece).
   *
   *  Sketch points and curves hidden behind a body at this pixel are not
   *  candidates, as a corner behind the surface is not: they rank ahead of the
   *  body, so a sketch behind it would otherwise take a click aimed at its
   *  face. A side of a rectangle, polygon or slot is a line like one drawn
   *  with the Line tool (lineUnderCursor). A sketch curve that cannot be a
   *  line (an arc, a circle, a slot's round end) gives way to the body behind
   *  it, and is refused only on a click that has no body behind it: a circle
   *  drawn on a face must not stop the face being picked, and a plane behind
   *  the curve is not what was aimed at.
   *
   *  The profile's OWN sketch, and any plane level with the profile, are left
   *  out: they are neither a start nor an end, and skipping them lets a click
   *  reach what is behind them (an origin plane under the profile's own
   *  construction plane). */
  private objectAt(cx: number, cy: number): Picked | null {
    const own = this.selected[0]?.sketchId ?? this.forcedSketchId ?? undefined;
    const project = (w: THREE.Vector3) => this.viewport.projectToScreen(w);
    const px = (w: THREE.Vector3) => {
      const s = project(w);
      return Math.hypot(s.x - cx, s.y - cy);
    };
    const hidden = this.viewport.behindSurfaceAt(cx, cy);
    const sp = this.overlay.committedPointAt(cx, cy, project, POINT_PX, own, hidden);
    const vx = this.viewport.pickVertexAt(cx, cy, POINT_PX, hidden);
    if (sp && (!vx || px(sp.world) <= px(vx.point))) {
      return { kind: "sketchPoint", sketch: sp.sketchId, entity: sp.entityId, point: sp.point, world: sp.world };
    }
    const corner = vx?.edges[0];
    if (vx && corner) return { kind: "vertex", point: vx.point, edge: corner };
    let notLine: string | null = null;
    const curve = this.overlay.committedCurveAt(cx, cy, project, CURVE_PX, own, hidden);
    if (curve) {
      const found = this.overlay.sketchEntity(this.store.document, curve.sketchId, curve.entityId);
      const line = found ? lineUnderCursor(found.entity, found.plane, cx, cy, project, CURVE_PX, hidden) : null;
      if (line) return { kind: "sketchLine", sketch: curve.sketchId, ...line };
      notLine = t("feature.extrude.ref.notStraight");
    }
    const hit = this.viewport.pickEntity(cx, cy);
    if (hit?.kind === "edge") return { kind: "edge", edge: hit.edge, selector: hit.selector };
    if (hit) {
      const face = this.viewport.pickFaceForPressPull(cx, cy);
      if (face) {
        // flat AND on a known body: the two things a start face needs
        // (faceAnchor's own two refusals)
        const flat = () => {
          const plane = this.viewport.pickFacePlane(cx, cy);
          return plane !== null && this.viewport.faceAnchor(cx, cy, plane) !== null;
        };
        return { kind: "face", selector: face.selector, bodyId: face.bodyId, normal: face.normal, anchor: face.anchor, flat };
      }
    }
    if (notLine) return { kind: "refused", why: notLine };
    return this.planeAt(cx, cy);
  }

  /** The plane a click here names: the nearest construction plane or (while
   *  they are drawn) origin plane that is not level with the profile. A
   *  construction plane wins a tie with an origin plane it lies on: it is the
   *  one the user made, and it may move later. */
  private planeAt(cx: number, cy: number): Picked | null {
    const hits = this.viewport.planeHitsAt(cx, cy, this.showingOrigin);
    const usable = hits.flatMap((h) => {
      const q = this.planeDef(h.id);
      return q && !this.levelWithProfile(q) ? [{ ...h, ...q }] : [];
    });
    const first = usable[0];
    if (!first) return null;
    const tie = usable.find((h) => h.datum && h.distance <= first.distance + LEVEL_TOL);
    const p = tie ?? first;
    return { kind: "plane", id: p.id, normal: p.normal, origin: p.origin };
  }

  /** An origin plane's or a construction plane's normal and a point on it. */
  private planeDef(id: string): { normal: THREE.Vector3; origin: THREE.Vector3 } | null {
    if (id in BASE_NORMAL) return { normal: BASE_NORMAL[id as Plane3].clone(), origin: new THREE.Vector3() };
    const q = this.viewport.datumPlaneOf(id);
    return q ? { normal: new THREE.Vector3(...q.normal), origin: new THREE.Vector3(...q.origin) } : null;
  }

  /** A plane the profile lies in: neither a start nor an end. */
  private levelWithProfile(q: { normal: THREE.Vector3; origin: THREE.Vector3 }): boolean {
    const p = this.selected[0]?.plane;
    if (!p || q.normal.lengthSq() === 0) return false;
    const square = q.normal.clone().normalize().cross(p.n).length() <= PARALLEL_TOL;
    return square && Math.abs(p.plane.distanceToPoint(q.origin)) <= LEVEL_TOL;
  }

  /** Turn a pending press into a handle drag once the pointer has actually
   *  travelled — the second half of classifying the press onDown deliberately
   *  left open.
   *
   *  Two things had to wait for movement, and they are the two confirmed
   *  defects of deciding at pointerdown:
   *
   *  - The field is unlocked HERE, not on the press. Typing a depth and then
   *    clicking to commit is the gesture the prompt teaches, and the arrow sits
   *    at the profile's interior point — the very place that click lands. When
   *    the press unlocked the field, that taught gesture silently threw the
   *    typed number away and committed the pre-typed one. Typing now wins right
   *    up until the user drags.
   *  - The grab's reference reading is taken at the PRESS position, not here,
   *    so the ~4 px that armed the drag is not swallowed and the depth moves
   *    continuously from where the arrow was taken hold of.
   *
   *  A press that missed the handle still latches `moved`, because that is what
   *  stops the release from committing (see onUp): a press aimed at the arrow
   *  and landing 15 px off it used to commit the in-progress feature at whatever
   *  depth was current. */
  private armDragIfMoved(e: PointerEvent, anchor: THREE.Vector3, axis: THREE.Vector3) {
    const p = this.press;
    if (!p || p.moved || this.grab) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return; // still a click
    p.moved = true;
    if (!p.onArrow) return; // the pointer is dragging something that is not this handle
    this.grab = {
      axis: axisDragDistance(this.viewport, p.x, p.y, anchor, axis),
      distance: this.distance,
    };
    this.dim.unlock("distance");
    this.viewport.domElement.style.cursor = "ns-resize";
  }

  /** Is the cursor on the depth arrow? The test that makes the manipulator a
   *  handle rather than a readout.
   *
   *  Measured against the arrow AS DRAWN: updatePreview floors its length at
   *  ARROW_MIN_MM so a near-zero depth still shows something, and an arrow you
   *  can see but cannot grab is the complaint being fixed.
   *
   *  The fallback is the part that makes this usable rather than merely correct.
   *  Weighed three ways when the shaft projects to nothing: a bigger disc around
   *  the anchor (a number with no referent — any radius is a guess), the arrow's
   *  DRAWN head size in pixels (real, but still a small disc, and it shrinks
   *  with zoom exactly when the model is small on screen), or the selected
   *  PROFILE. The profile wins: it is the one thing with screen extent in that
   *  view, it is what the user is looking at and aiming for, it scales with zoom
   *  for free, and — since commit became a release-in-place — a click on it
   *  still commits, so widening the grab steals no gesture. */
  private overArrow(cx: number, cy: number): boolean {
    const first = this.selected[0];
    if (!this.arrow || !first || this.hasTarget()) return false;
    const { from: anchor, length } = this.arrowSpan();
    const sign = this.distance >= 0 ? 1 : -1;
    const tip = anchor.clone().addScaledVector(first.plane.n, sign * length);
    const a = this.viewport.projectToScreen(anchor);
    const b = this.viewport.projectToScreen(tip);
    if (pixelDistanceToSegment(cx, cy, a, b) <= GRAB_PX) return true;
    if (Math.hypot(b.x - a.x, b.y - a.y) >= DEGENERATE_SHAFT_PX) return false;
    // Degenerate shaft: grab anywhere on the profile being extruded. Scoped to
    // the SELECTED areas, so a press on some other region still means what it
    // means everywhere else in this tool.
    const r = this.regionUnder(cx, cy);
    return r !== null && this.selected.includes(r);
  }

  /** Park the depth input at a STABLE spot near the profile — anchored to the
   *  selection center (which doesn't move while you drag depth), offset off the
   *  geometry and clamped inside the viewport. Following the cursor made the box
   *  (and its buttons) impossible to click. */
  private positionDim(anchor: THREE.Vector3 = this.arrowSpan().from) {
    const s = this.viewport.projectToScreen(anchor);
    const rect = this.viewport.domElement.getBoundingClientRect();
    const boxW = 160, boxH = 46, m = 12;
    const fx = Math.max(rect.left + m, Math.min(s.x + 28, rect.right - boxW - m));
    const fy = Math.max(rect.top + m, Math.min(s.y + 28, rect.bottom - boxH - m));
    this.dim.position(fx - 16, fy - 16); // dim.position adds a +16 cursor offset
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      if (!r) return;
      if (this.refusesForeignRegion(r)) return;
      e.preventDefault();
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      this.overlay.toggleRegionSelection(r, additive);
      this.selected = this.editSelection();
      // Picking here STATES the area set, exactly as the modifier click does in
      // the edit phase, so anything startEdit was holding on the user's behalf
      // stops applying. Without this the carried areas would ride along
      // invisibly beside whatever is picked and commit would write MORE areas
      // than the user can see — which is why the carry used to be skipped
      // entirely on this path, at the cost of losing the areas instead.
      // Dropping them here is what makes carrying them safe.
      const dropped = this.editCarried.length;
      this.editCarried = [];
      // plain click picks one area and goes straight to depth; Ctrl-click keeps
      // accumulating (Enter confirms the set)
      if (!additive && this.selected.length) this.beginDrag();
      // AFTER beginDrag, which sets a prompt of its own: announcing the drop
      // first would put it on screen for one statement and then replace it.
      if (dropped) setPrompt(t("feature.extrude.edit.droppedNewSet", { count: dropped }));
    } else {
      e.preventDefault();
      // T-mode: this click names the surface to extrude UP TO. Consume EVERY
      // click here — a miss must never fall through to the clean-click-commits
      // path below and fire a stray plain commit (the same audit finding that
      // shaped press/pull's version of this branch).
      //
      // The click FILLS the panel's Up-to box and the extrude waits: a target
      // offset can only be typed once there is a target to offset from, and a
      // click that also committed left no moment to type it (GH #41). Enter, OK
      // or a click off any target commits (below). Picking where it STARTS is
      // the same gesture into the Start box.
      if (this.pickingTarget || this.pickingStart) {
        e.stopImmediatePropagation();
        this.pickObject(this.pickingStart ? "start" : "end", this.objectAt(e.clientX, e.clientY));
        return;
      }
      // A modifier-held click means "change the area set", not "commit". Edit mode
      // is otherwise a trap: startEdit restores the saved areas and goes straight
      // to drag, so beginDrag's "Ctrl-click areas to add/remove" prompt had no
      // reachable handler and every attempt to drop an area committed instead.
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        const r = this.regionUnder(e.clientX, e.clientY);
        if (!r) return; // modifier on empty space: do nothing rather than commit
        if (this.refusesForeignRegion(r)) return;
        this.overlay.toggleRegionSelection(r, true);
        this.selected = this.editSelection();
        // The user is now stating the area set by hand, so the unmatched areas
        // startEdit was holding on their behalf stop applying — keeping them
        // would ADD an area to whatever is picked here. This is the one place
        // the edit can lose an area, and it says so instead of doing it quietly.
        const dropped = this.editCarried.length;
        this.editCarried = [];
        if (!this.selected.length) {
          // emptied: updatePreview early-returns without disposing, so the old
          // preview would hang in the scene. Drop it and go back to picking.
          this.phase = "pick";
          this.disposePreviewGeom();
          this.previewKey = "";
          this.pushBuiltPreview(false);
          // Hide the depth box too. Leaving it up was a trap: its Enter/✓
          // callback still points at commit(), whose first guard bails to
          // cancel() on an empty selection — so typing Enter after removing the
          // last area silently threw the whole extrude away, while the prompt
          // said "select a profile". onKey defers to the input while it has
          // focus, so nothing else intercepted it. (GitHub issue #14.) The
          // panel goes for the same reason: its OK and its fields' Enter call
          // commit() too. Its values are the tool's, so they come back with it
          // when a profile is picked (beginDrag).
          this.dim.hide();
          this.panel.hide();
          setPrompt(
            dropped
              ? t("feature.extrude.edit.droppedThenPick", { count: dropped })
              : t("feature.extrude.pickPrompt"),
          );
          return;
        }
        this.updatePreview();
        if (dropped) setPrompt(t("feature.extrude.edit.droppedPickAgain", { count: dropped }));
        return;
      }
      // With a target set, a click on another target aims there instead.
      // Committing to the FIRST target was what a click on the right face did
      // after a mis-pick, which is the natural way to correct one. Anywhere
      // else a click still commits, on the release, below.
      if (this.hasTarget()) {
        const picked = this.objectAt(e.clientX, e.clientY);
        if (picked) {
          e.stopImmediatePropagation();
          this.pickObject("end", picked);
          return;
        }
      }
      // Neither gesture the drag phase offers is decided here. Both start with a
      // left press, often in the SAME place — the arrow is anchored at the
      // region's interior point, which is exactly where the prompt teaches users
      // to click to commit — so the press is only recorded, and onMove/onUp
      // classify it by what the pointer does next. Deciding at pointerdown is
      // what produced both confirmed defects: a press on the arrow discarded a
      // typed depth, and a press aimed at the arrow that landed 15 px off it
      // committed the feature the user was still editing.
      //
      // The `e.preventDefault()` above is what lets the user drag and then keep
      // typing: without it the press moves focus off the depth input and the
      // keystrokes after a drag go nowhere (DimInput's ✓ button guards itself
      // the same way).
      this.press = {
        x: e.clientX,
        y: e.clientY,
        onArrow: this.overArrow(e.clientX, e.clientY),
        moved: false,
      };
    }
  }

  /** End of a press. THIS is where an extrude commits, and where a handle drag
   *  ends — the two outcomes of the press onDown deliberately left unclassified.
   *
   *  Commit is a click: a left press that never travelled DRAG_START_PX and came
   *  back up within that distance of where it went down. That is a stated change
   *  to how EVERY extrude commits, not just one aimed at the arrow, and it is
   *  the point. Committing on pointerDOWN meant a press that missed the handle
   *  destroyed the in-progress feature: measured side-on, a press 15 px off the
   *  shaft followed by a drag left the distance at 33.594 and committed. The
   *  cost is that a press-drag-release over empty space no longer commits — the
   *  user has to click. That is the trade taken deliberately: a gesture that
   *  fails to commit is one more click, a gesture that commits by accident is
   *  lost work.
   *
   *  The release is heard on WINDOW, not on the canvas: a depth drag routinely
   *  ends with the cursor over the depth box or off the edge of the viewport,
   *  and a pointerup the tool never hears leaves the handle latched to the mouse
   *  — the very symptom of field 3998d6ea, arrived at from the other side. Which
   *  is also why the release POSITION is checked and not just the `moved` flag:
   *  the moves themselves are only heard on the canvas, so a drag that leaves it
   *  would otherwise come back as a click.
   *
   *  The field stays UNLOCKED after a drag: the number in the box is the dragged
   *  one, `distance` carries its sign (the box shows the magnitude), and typing
   *  re-locks on the next keystroke. */
  /** Forget the in-flight press and any drag it armed. The one place that does
   *  it, so a release, a cancel and a button that came up unseen cannot drift
   *  apart about what "the gesture is over" means. */
  private endPress() {
    this.press = null;
    this.grab = null;
  }

  /** The browser took the gesture away (a system drag, a context menu, focus
   *  loss). Treated as an abandoned drag and never as a commit: the user did
   *  not release over the model, so nothing about their intent is known. */
  private onCancel() {
    this.endPress();
  }

  private onUp(e: PointerEvent) {
    const p = this.press;
    const wasDragging = this.grab !== null;
    this.endPress();
    if (wasDragging || !p || this.phase !== "drag" || e.button !== 0) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (p.moved || dx * dx + dy * dy > DRAG_START_PX * DRAG_START_PX) return; // a drag, not a click
    void this.commit();
  }

  /** `upTo` (a face), `upToPlane` (a plane id) and `upToRef` (a point or a
   *  line) are mutually exclusive by contract — the sidecar REFUSES a feature
   *  carrying two rather than picking one — so every target set goes through
   *  here and clears the others. */
  private setUpTo(target: Target) {
    this.upTo = "face" in target ? target.face : null;
    this.upToPlane = "plane" in target ? target.plane : null;
    this.upToRef = "ref" in target ? target.ref : null;
  }

  private onKey(e: KeyboardEvent) {
    if (isImeComposing(e)) return; // Escape cancels an IME conversion, not the tool
    // The panel's own fields and buttons. Enter is OK wherever focus is in it,
    // except on a focused Cancel (whose own Enter means cancel); Escape is the
    // tool's. Every other key in a FIELD is the field's, letters included: a
    // field takes a parameter name (`wall*2`), so S and T are text there. On a
    // chip just clicked they are still the tool's hotkeys, below.
    if (this.panel.owns(e.target)) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.onEscape();
        return;
      }
      if (e.key === "Enter") {
        if (e.target === this.panel.cancelButton) return;
        e.preventDefault();
        e.stopPropagation();
        void this.commit();
        return;
      }
      if (isTextField(e.target)) return;
    }
    if (this.dim.isActive && e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") {
        this.cancel();
        return;
      }
      // Everything else aimed at the depth box is the FIELD's — Enter commits,
      // Tab locks and advances — except T on a box nobody has typed into yet.
      // Without that exception T and Shift-T below were unreachable for the
      // whole time the tool was open, because beginDrag focuses the box:
      // pressing T to aim the extrude at a plane typed a "t" over the seeded
      // depth (field report 88c9bdf0).
      //
      // S is NOT claimed here. The box reads parameter names and functions
      // (`size*2`, `sqrt(2)`), so in it S is the first letter of a value, and
      // claiming it toggled Symmetric and left `ize*2` behind. The Direction
      // chips are the control; S toggles only where the key is free.
      if (e.key.toLowerCase() !== "t" || !this.dim.claimToolHotkey(e)) return;
    } else if (isTextField(e.target) && !this.panel.owns(e.target)) {
      // Another editor (the command palette, a Browser rename) keeps its keys.
      return;
    }
    if (e.key === "Escape") {
      this.onEscape();
      return;
    }
    if (e.key === "Enter" && this.phase === "pick" && this.selected.length) this.beginDrag();
    else if (e.key === "Enter" && this.phase === "drag") {
      // With the depth box up its own Enter commits; this is the Enter of an
      // extrude aimed at a target, where there is no depth box to type into.
      e.preventDefault();
      void this.commit();
    } else if (
      (e.key === "T" || e.key === "t") &&
      e.shiftKey &&
      this.phase === "drag" &&
      !this.pickingTarget &&
      this.hasTarget()
    ) {
      // Shift-T is the tool's half of GH #41: `setUpTo` could only ever SET a
      // target, so an extrude aimed at a face could not be turned back into a
      // plain-depth one from here — and taper, which is hidden while a target
      // exists, stayed out of reach with it. Tested BEFORE the plain-T branch
      // below, which would otherwise swallow the same key press. The panel's
      // Extent row is the discoverable control; this is parity for the keyboard.
      this.clearTarget();
    } else if ((e.key === "t" || e.key === "T") && !e.shiftKey && this.phase === "drag" && !this.pickingTarget) {
      this.armTargetPick();
    } else if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && this.phase === "drag" && !this.pickingTarget && !this.hasTarget()) {
      // Toggle symmetric while the depth is live, so the ghost shows what it
      // means. Stopped here so the model-context S (start a sketch) never sees
      // it. Ignored with a target, where half each way means nothing.
      e.preventDefault();
      e.stopPropagation();
      this.setSymmetric(!this.symmetric);
    }
  }

  /** Escape: out of target picking back to where the extrude was, else cancel
   *  the whole extrude — the same two-level Escape press/pull has. */
  private onEscape() {
    if (this.pickingTarget) this.leaveTargetPick();
    else if (this.pickingStart) this.leaveStartPick();
    else this.cancel();
  }

  private hasTarget(): boolean {
    return this.upTo !== null || this.upToPlane !== null || this.upToRef !== null;
  }

  /** T, or the panel's Up-to choice or box: the next click names what to
   *  extrude up to. */
  private armTargetPick() {
    if (this.phase !== "drag") return;
    if (this.pickingStart) this.leaveStartPick();
    this.pickingTarget = true;
    this.pickNote = null;
    this.dim.hide(); // Enter must not commit a plain distance while picking
    this.showOriginPlanes(true);
    setPrompt(t("feature.extrude.targetPrompt"));
    this.updatePreview();
    this.syncPanel();
  }

  /** A target was clicked: it fills the panel, and the extrude waits for
   *  Enter or OK so a target offset can be typed first. */
  private setTarget(target: Target) {
    this.setUpTo(target);
    this.pickingTarget = false;
    this.pickNote = null;
    // the pick's highlights go with it, or the face just clicked stays lit
    this.clearPickHover();
    this.showOriginPlanes(false);
    setPrompt(t("feature.extrude.targetSet"));
    this.updatePreview();
    this.syncPanel();
  }

  private leaveTargetPick() {
    this.pickingTarget = false;
    this.pickNote = null;
    // leaving T mode takes its highlights with it, or the last face and plane
    // the cursor passed stay lit over a tool that no longer aims there
    this.clearPickHover();
    this.showOriginPlanes(false);
    if (this.pending?.role === "end") this.pending = null;
    if (this.hasTarget()) {
      setPrompt(t("feature.extrude.targetSet"));
    } else {
      // restore the field T-mode hid: leaving it hidden would strand the user
      // with no way to type a depth, and leaving it ACTIVE during the pick let
      // Enter commit a plain distance mid-target-pick.
      this.showDim();
      setPrompt(t("feature.extrude.dragPromptAfterTarget"));
    }
    this.updatePreview();
    this.syncPanel();
  }

  /** Back to extruding by a distance: Shift-T, the panel's Distance choice or
   *  the Up-to box's clear button. */
  private clearTarget() {
    const had = this.hasTarget();
    this.upTo = null;
    this.upToPlane = null;
    this.upToRef = null;
    this.pickingTarget = false;
    this.pickNote = null;
    if (this.pending?.role === "end") this.pending = null;
    this.clearPickHover();
    this.showOriginPlanes(false);
    // An up-to extrude never read its distance, so it can legitimately be 0 —
    // and a plain extrude of 0 is refused by the sidecar. Same substitution
    // the inspector's clear makes (store.clearUpToTarget).
    if (this.distance === 0) this.distance = DEFAULT_EXTRUDE_DISTANCE;
    if (!this.pickingStart) this.showDim();
    this.panel.setNumber("distance", this.distance);
    setPrompt(t(had ? "feature.extrude.targetCleared" : "feature.extrude.dragPromptAfterTarget"));
    this.updatePreview();
    this.syncPanel();
  }

  // --- the start object (GH #41 a) -------------------------------------------

  /** Start = Object, or a click on its box: the next click names the face,
   *  plane, point or line the extrude starts from. */
  private armStartPick() {
    if (this.phase !== "drag") return;
    if (this.pickingTarget) this.leaveTargetPick();
    if (this.startMode !== "object") this.startModeBefore = this.startMode;
    this.startMode = "object";
    this.pickingStart = true;
    this.pickNote = null;
    this.dim.hide(); // Enter must not commit while the box waits for its click
    this.showOriginPlanes(true);
    setPrompt(t("feature.extrude.startPrompt"));
    this.updatePreview();
    this.syncPanel();
  }

  /** Out of the start pick (Escape, or another Start choice). With nothing
   *  picked, Start goes back to what it was, so no empty Object box is left
   *  for OK to trip over. */
  private leaveStartPick() {
    this.endStartPick();
    if (this.startRef === null && this.pending?.role !== "start") this.startMode = this.startModeBefore;
    this.afterStartChange();
  }

  private endStartPick() {
    this.pickingStart = false;
    this.pickNote = null;
    this.clearPickHover();
    this.showOriginPlanes(false);
  }

  /** The Start box's clear button: start on the sketch again. A start offset
   *  that was typed stays, measured from the sketch, as Offset. */
  private clearStart() {
    this.endStartPick();
    if (this.pending?.role === "start") this.pending = null;
    this.startRef = null;
    this.startRefDist = 0;
    this.startMode = this.startOffset !== 0 || this.readOnly.startOffset !== undefined ? "offset" : "profile";
    this.afterStartChange();
  }

  /** A start object was picked (and, for a body's edge, corner or face, its
   *  reference authored): it fills the Start box. */
  private setStart(ref: ExtrudeStart, dist: number) {
    this.endStartPick();
    this.startRef = ref;
    this.startRefDist = dist;
    this.startMode = "object";
    // Read before the built preview can put material on screen: whether the
    // extrude goes into a body is measured from where it now starts.
    this.refreshGuess();
    this.afterStartChange();
  }

  private afterStartChange() {
    if (!this.hasTarget() && !this.pickingTarget) this.showDim();
    if (this.hasTarget()) setPrompt(t("feature.extrude.targetSet"));
    else setPrompt(t(this.editId ? "feature.extrude.edit.dragPrompt" : "feature.extrude.dragPrompt"));
    this.updatePreview();
    this.syncPanel();
  }

  /** Clear every pick highlight: a face, a plane, an origin plane, a point.
   *  An origin plane can only be lit while they are drawn, and the ring only
   *  after hoverObject put it on a point. */
  private clearPickHover() {
    this.viewport.clearHover();
    this.viewport.hoverDatum(null);
    if (this.showingOrigin) this.viewport.hoverPlane(null);
    if (this.pointLit) this.overlay.setSnap(null);
    this.pointLit = false;
  }
  /** hoverObject has the snap ring on a point */
  private pointLit = false;

  /** The three origin planes are drawn while a start or a target is picked,
   *  so they can be clicked (Split does the same while its Tool box is
   *  active); otherwise they would only hide the preview. */
  private showingOrigin = false;
  private showOriginPlanes(on: boolean) {
    if (on === this.showingOrigin) return;
    this.showingOrigin = on;
    this.viewport.showAllPlanes(on);
    if (!on) this.viewport.hoverPlane(null);
  }

  /** A click named `picked` as the start (`role` "start") or the target: check
   *  it against the profile, then fill the box, or say why not and wait for
   *  another click. A body's edge, corner or start face is first turned into a
   *  stored reference by the sidecar (authorRef), never kept as a point. */
  private pickObject(role: "start" | "end", picked: Picked | null) {
    if (!picked) {
      setPrompt(t(role === "start" ? "feature.extrude.startPrompt" : "feature.extrude.targetPrompt"));
      return;
    }
    // A newer pick for this box: a reference still being read for an older one
    // must not land over it when its reply comes (authorRef's token).
    if (this.pending?.role === role) this.pending = null;
    const why = this.refusal(role, picked);
    if (why) {
      this.refusePick(role, why);
      return;
    }
    const n = this.selected[0]?.plane;
    const height = (p: THREE.Vector3) => (n ? n.plane.distanceToPoint(p) : 0);
    switch (picked.kind) {
      case "plane":
        if (role === "end") this.setTarget({ plane: picked.id });
        else this.setStart({ kind: "plane", plane: picked.id }, height(picked.origin));
        return;
      case "face":
        if (role === "end") {
          this.setTarget({ face: picked.selector });
          return;
        }
        this.authorRef(role, { kind: "face", body: picked.bodyId!, sel: picked.selector }, height(picked.anchor), (sel) => ({
          kind: "face", face: sel,
        }));
        return;
      case "sketchPoint": {
        const ref: ExtrudeRef = { kind: "sketchPoint", sketch: picked.sketch, entity: picked.entity, pointIndex: picked.point };
        if (role === "end") this.setTarget({ ref });
        else this.setStart(ref, height(picked.world));
        return;
      }
      case "sketchLine": {
        const ref: ExtrudeRef = { kind: "sketchLine", sketch: picked.sketch, entity: picked.entity };
        if (role === "end") this.setTarget({ ref });
        else this.setStart(ref, height(picked.a));
        return;
      }
      case "edge": {
        const first = picked.edge.points[0];
        const at = first ? new THREE.Vector3(...first) : new THREE.Vector3();
        this.authorRef(role, { kind: "edge", body: picked.edge.body!, sel: picked.selector }, height(at), (sel) =>
          (sel as { fp?: EdgeFingerprint }).fp?.curve === "line" ? { kind: "edge", edge: sel } : t("feature.extrude.ref.edgeNotStraight"),
        );
        return;
      }
      case "vertex": {
        const sel = edgeSelectorFrom({ points: picked.edge.points, body: picked.edge.body })!;
        const at = picked.point;
        this.authorRef(role, { kind: "edge", body: picked.edge.body!, sel }, height(at), (stored) => {
          const fp = (stored as { fp?: EdgeFingerprint }).fp;
          if (!fp) return t("feature.extrude.ref.noReply");
          // which END of the edge the corner is, by the fingerprint's own
          // direction: the convention the sidecar resolves it by (_edge_end)
          const along = at.clone().sub(new THREE.Vector3(...fp.mid)).dot(new THREE.Vector3(...fp.dir));
          return { kind: "vertex", edge: stored, end: along > 0 ? 1 : 0 };
        });
        return;
      }
    }
  }

  /** Why `picked` cannot be the start or the target, or null when it can. The
   *  sidecar refuses the same things on every build; saying so on the click
   *  saves a round trip and keeps the pick open for the right one. */
  private refusal(role: "start" | "end", picked: Picked): string | null {
    if (picked.kind === "refused") return picked.why;
    // A face or a plane can be a TARGET whatever its angle (it is trimmed on,
    // _prism_to_plane), and a point always: only the rest is measured against
    // the profile.
    if (role === "end" && (picked.kind === "face" || picked.kind === "plane" || picked.kind === "sketchPoint")) return null;
    const n = this.selected[0]?.plane.n;
    if (!n) return t("feature.extrude.ref.noProfile");
    const parallel = (dir: THREE.Vector3) => dir.lengthSq() > 0 && Math.abs(dir.clone().normalize().dot(n)) <= PARALLEL_TOL;
    const square = (normal: THREE.Vector3) => normal.lengthSq() > 0 && normal.clone().normalize().cross(n).length() <= PARALLEL_TOL;
    switch (picked.kind) {
      case "plane":
        return square(picked.normal) ? null : t("feature.extrude.ref.planeTilted");
      case "face":
        if (!picked.bodyId || !picked.flat()) return t("feature.extrude.ref.faceCurved");
        return square(picked.normal) ? null : t("feature.extrude.ref.faceTilted");
      case "sketchLine":
        return parallel(picked.b.clone().sub(picked.a)) ? null : t("feature.extrude.ref.lineNotParallel");
      case "edge": {
        if (!picked.edge.body) return t("feature.extrude.ref.noBody");
        const pts = picked.edge.points;
        if (pts.length !== 2) return t("feature.extrude.ref.edgeNotStraight");
        const d = new THREE.Vector3(...pts[1]!).sub(new THREE.Vector3(...pts[0]!));
        return parallel(d) ? null : t("feature.extrude.ref.lineNotParallel");
      }
      case "vertex":
        return picked.edge.body ? null : t("feature.extrude.ref.noBody");
      case "sketchPoint":
        return null;
    }
  }

  /** A pick that cannot be used: say why in the panel and the prompt, and keep
   *  the box waiting for the right click. */
  private refusePick(role: "start" | "end", why: string) {
    if (role === "start" && !this.pickingStart) this.armStartPick();
    else if (role === "end" && !this.pickingTarget && !this.hasTarget()) this.armTargetPick();
    this.pickNote = why;
    setPrompt(why);
    this.syncPanel();
  }

  /** Have the sidecar turn a picked body edge, corner or face into a STORED
   *  reference: the by:"match" fingerprint of what the pick resolves to on its
   *  body (store.queryReferences). A point would re-bind to the wrong edge in
   *  silence, which is why a point is never what is kept. The box says
   *  "Reading" until the reply, OK waits for it, and a reply that a newer
   *  pick, a clear or a close overtook is dropped (`token`). */
  private authorRef(
    role: "start" | "end",
    item: { kind: "edge" | "face"; body: string; sel: Selector },
    dist: number,
    make: (stored: Selector) => ExtrudeRef | ExtrudeStart | string,
  ) {
    const ask = this.store.queryReferences([item], this.editId);
    if (!ask) {
      this.refusePick(role, t("feature.extrude.ref.unsupported"));
      return;
    }
    const token = ++this.pendingSeq;
    this.pending = { role, token };
    this.pickNote = null;
    if (role === "start") this.endStartPick();
    else {
      this.pickingTarget = false;
      this.clearPickHover();
      this.showOriginPlanes(false);
    }
    setPrompt(t("feature.extrude.panel.reading"));
    this.syncPanel();
    void ask.then((res) => {
      if (!this.active || this.pending?.token !== token) return;
      this.pending = null;
      const r = res[0];
      const ent = r?.ok ? r.entities[0] : undefined;
      if (!ent) {
        this.refusePick(role, r?.error ? t("feature.extrude.ref.failed", { why: r.error }) : t("feature.extrude.ref.noReply"));
        return;
      }
      const made = make({ ...ent.sel, body: ent.body });
      if (typeof made === "string") {
        this.refusePick(role, made);
        return;
      }
      if (role === "start") this.setStart(made as ExtrudeStart, dist);
      else this.setTarget({ ref: made as ExtrudeRef });
    });
  }

  /** Where a SAVED start object sits from the sketch, along the profile
   *  normal, without a build: from the document for a sketch point, line or
   *  plane, and from the reference's own fingerprint for a body's face, edge or
   *  corner. That fingerprint is where the object was when it was picked, so
   *  after an upstream edit this can lag; it only places the arrow, and the
   *  built preview shows where the extrude really starts. */
  private estimateStart(ref: ExtrudeStart): number {
    const plane = this.selected[0]?.plane;
    if (!plane) return 0;
    const at = (p: THREE.Vector3 | null) => (p ? plane.plane.distanceToPoint(p) : 0);
    switch (ref.kind) {
      case "plane": {
        if (ref.plane in BASE_NORMAL) return at(new THREE.Vector3());
        const q = this.viewport.datumPlaneOf(ref.plane);
        return at(q ? new THREE.Vector3(...q.origin) : null);
      }
      case "face": {
        const fp = (ref.face as { fp?: FaceFingerprint }).fp;
        return at(fp ? new THREE.Vector3(...fp.centroid) : null);
      }
      case "sketchPoint": {
        const found = this.overlay.sketchEntity(this.store.document, ref.sketch, ref.entity);
        const p = found ? refPoint(found.entity, ref.pointIndex) : null;
        return at(found && p ? found.plane.to3D(p.x, p.y) : null);
      }
      case "sketchLine": {
        // a side of a shape is `<shapeId>~<k>`, read off the shape (lineOperand)
        const cut = ref.entity.indexOf("~");
        const found = this.overlay.sketchEntity(this.store.document, ref.sketch, cut < 0 ? ref.entity : ref.entity.slice(0, cut));
        const seg = found ? lineOperand(new Map([[found.entity.id, found.entity]]), ref.entity) : null;
        return at(found && seg ? found.plane.to3D(seg.x1, seg.y1) : null);
      }
      case "edge": {
        const fp = (ref.edge as { fp?: EdgeFingerprint }).fp;
        return at(fp ? new THREE.Vector3(...fp.mid) : null);
      }
      case "vertex": {
        const fp = (ref.edge as { fp?: EdgeFingerprint }).fp;
        return at(fp ? edgeEndOf(fp, ref.end) : null);
      }
    }
  }

  private setSymmetric(on: boolean) {
    this.symmetric = on;
    this.updatePreview();
    this.syncPanel();
  }

  /** The depth box, open on the current distance and locked to it. */
  private showDim() {
    this.dim.show(
      [{ name: "distance", label: t("feature.dim.distance") }],
      () => void this.commit(),
      () => this.cancel(),
      () => this.onDimInput(),
    );
    this.dim.seed("distance", this.distance);
    if (this.selected.length) this.positionDim();
  }

  /** A keystroke in the depth box: the panel and the ghost follow it now, not
   *  on the next pointer move. Text the box cannot read turns it red, as a
   *  panel field does; commit refuses it. */
  private onDimInput() {
    const v = this.dim.getValue("distance");
    this.dim.markInvalid("distance", v === null && this.dim.getRaw("distance").trim() !== "");
    if (v == null || !this.dim.isUserDriven("distance")) return;
    this.distance = v;
    this.panel.setNumber("distance", v);
    this.updatePreview();
    this.syncPanel();
  }

  // --- the panel ------------------------------------------------------------

  private resetPanelValues() {
    this.startMode = "profile";
    this.startModeBefore = "profile";
    this.startRef = null;
    this.startRefDist = 0;
    this.pickingStart = false;
    this.pending = null;
    this.pickNote = null;
    this.startOffset = 0;
    this.symmetric = false;
    this.taper = 0;
    this.upToOffset = 0;
    this.edited.clear();
    this.readOnly = {};
    this.op = "new";
    this.opPinned = false;
    this.previewError = null;
    this.awaitingBuild = false;
    this.solidReading = null;
  }

  /** An edit opens the panel on the feature as saved. A value bound to a
   *  parameter (or a legacy bare parameter name) shows its formula and is not
   *  typed over here: the binding would put the old value back on the next
   *  parameter change. */
  private loadPanelValues(f: Extract<Feature, { type: "extrude" }>) {
    this.resetPanelValues();
    for (const k of PANEL_VALUES) {
      const raw = f[k];
      if (raw === undefined) continue;
      const bound = typeof raw !== "number" || this.store.isParamBound({ kind: "feature", feature: f.id, field: k });
      if (bound) this.readOnly[k] = t("feature.extrude.panel.boundTitle");
      this[k] = typeof raw === "number" ? raw : (this.store.document.parameters[raw] ?? 0);
    }
    if (f.startOffset !== undefined && (this.readOnly.startOffset !== undefined || this.startOffset !== 0)) {
      this.startMode = "offset";
    }
    if (f.startFrom) {
      this.startMode = "object";
      this.startRef = f.startFrom;
      // Measured once the areas are known (beginDrag): it needs the profile's
      // plane, and startEdit only resolves the areas after this.
      this.startRefDist = 0;
    }
    this.symmetric = f.symmetric === true;
    this.op = f.operation;
    this.opPinned = true;
  }

  /** The text a read-only panel value shows: its formula. */
  private boundText(k: PanelValue): string {
    const live = this.editId ? this.store.document.features.find((f) => f.id === this.editId) : undefined;
    const raw = live?.type === "extrude" ? live[k] : undefined;
    const bound = this.editId ? this.store.boundExpr?.({ kind: "feature", feature: this.editId, field: k }) : null;
    return bound?.expr ?? String(raw ?? "");
  }

  private showPanel() {
    if (this.panel.isActive) return;
    const opt = (value: string, label: string, title?: string) => ({
      value,
      label: t(label),
      ...(title ? { title: t(title) } : {}),
    });
    this.panel.show(
      t("tool.extrude"),
      [
        {
          kind: "choice", id: "start", label: t("feature.extrude.panel.start"),
          options: [
            opt("profile", "feature.extrude.panel.startProfile", "feature.extrude.panel.startProfileTitle"),
            opt("offset", "feature.extrude.panel.startOffset", "feature.extrude.panel.startOffsetTitle"),
            opt("object", "feature.extrude.panel.startObject", "feature.extrude.panel.startObjectTitle"),
          ],
        },
        {
          kind: "pick", id: "startObject", label: t("feature.extrude.panel.startFrom"),
          clearTitle: t("feature.extrude.panel.startClearTitle"),
        },
        { kind: "number", id: "startOffset", label: t("inspector.field.startOffset") },
        {
          kind: "choice", id: "direction", label: t("feature.extrude.panel.direction"),
          options: [
            opt("one", "feature.extrude.panel.oneSide", "feature.extrude.panel.oneSideTitle"),
            opt("symmetric", "feature.extrude.panel.symmetric", "feature.extrude.panel.symmetricTitle"),
          ],
        },
        {
          kind: "choice", id: "extent", label: t("feature.extrude.panel.extent"),
          options: [
            opt("distance", "feature.extrude.panel.distance", "feature.extrude.panel.distanceTitle"),
            opt("upTo", "feature.extrude.panel.upTo", "feature.extrude.panel.upToTitle"),
          ],
        },
        { kind: "number", id: "distance", label: t("inspector.field.distance") },
        { kind: "pick", id: "target", label: t("inspector.upTo.label"), clearTitle: t("inspector.upTo.clearTitle") },
        { kind: "number", id: "upToOffset", label: t("inspector.field.targetOffset") },
        { kind: "number", id: "taper", label: t("inspector.field.taper"), field: "angle" },
        {
          kind: "choice", id: "op", label: t("feature.extrude.panel.operation"),
          options: [
            opt("join", "feature.op.join", "feature.extrude.op.joinHint"),
            opt("cut", "feature.op.cut", "feature.extrude.op.cutHint"),
            opt("new", "feature.op.newBody", "feature.extrude.op.newHint"),
            opt("intersect", "feature.op.intersect", "feature.extrude.op.intersectHint"),
          ],
        },
      ],
      {
        onNumber: (id, v, raw) => this.onPanelNumber(id, v, raw),
        onChoice: (id, v) => this.onPanelChoice(id, v),
        onPick: (id) => (id === "startObject" ? this.armStartPick() : this.armTargetPick()),
        onClear: (id) => (id === "startObject" ? this.clearStart() : this.clearTarget()),
        onOk: () => void this.commit(),
        onCancel: () => this.cancel(),
      },
    );
    for (const k of PANEL_VALUES) {
      const reason = this.readOnly[k];
      this.panel.setNumber(k, reason !== undefined ? this.boundText(k) : this[k]);
      this.panel.setReadOnly(k, reason ?? null);
    }
  }

  private onPanelNumber(id: string, v: number | null, raw: string) {
    if (id === "distance") {
      if (v === null) return; // the field shows red, and OK refuses it
      this.distance = v;
      // the depth box follows, locked to the typed number the way a seed is
      this.dim.seed("distance", v);
    } else if ((PANEL_VALUES as readonly string[]).includes(id)) {
      if (v === null && raw !== "") return;
      const k = id as PanelValue;
      this[k] = v ?? 0; // a cleared field is "none"
      this.edited.add(k);
    }
    this.updatePreview();
    this.syncPanel();
  }

  private onPanelChoice(id: string, v: string) {
    if (id === "start") {
      if (v === "profile" && this.readOnly.startOffset !== undefined) {
        this.panel.setWarning(t("feature.extrude.panel.startBound"));
        return;
      }
      if (v === "object") {
        // like Up to: choosing it makes the box active, so the next click in
        // the model names the object
        this.armStartPick();
        return;
      }
      if (this.pickingStart) this.endStartPick();
      // a start still being read would land after the user chose otherwise
      if (this.pending?.role === "start") this.pending = null;
      this.startMode = v === "offset" ? "offset" : "profile";
      // and the depth box the pick hid comes back
      this.afterStartChange();
      return;
    } else if (id === "direction") {
      this.setSymmetric(v === "symmetric");
      return;
    } else if (id === "extent") {
      if (v === "upTo") this.armTargetPick();
      else this.clearTarget();
      return;
    } else if (id === "op") {
      this.op = v as Op;
      this.opPinned = true;
    }
    this.updatePreview();
    this.syncPanel();
  }

  /** Show which rows apply and what each holds. Rows that do not apply are
   *  hidden: a target makes Direction, Distance and Taper meaningless (the
   *  sidecar ignores a taper under a target and refuses symmetric with one),
   *  and Target offset means nothing without one. */
  private syncPanel() {
    const p = this.panel;
    if (!p.isActive) return;
    const target = this.hasTarget();
    const aiming = target || this.pickingTarget;
    p.setChoice("start", this.startMode);
    p.setVisible("startObject", this.startMode === "object");
    p.setPick("startObject", this.startText(), {
      empty: this.startRef === null && this.pending?.role !== "start",
      active: this.pickingStart,
    });
    // measured from the object, so it applies there too (sidecar: start_at)
    p.setVisible("startOffset", this.startMode !== "profile");
    p.setChoice("direction", this.symmetric ? "symmetric" : "one");
    p.setVisible("direction", !aiming);
    p.setChoice("extent", aiming ? "upTo" : "distance");
    p.setVisible("distance", !aiming);
    p.setVisible("target", aiming);
    p.setPick("target", this.targetText(), { empty: !target, active: this.pickingTarget });
    p.setVisible("upToOffset", target);
    p.setVisible("taper", !aiming);
    p.setChoice("op", this.op);
    p.setVisible("op", this.hasSolid);
    p.setWarning(this.panelWarning());
  }

  private targetText(): string {
    if (this.pending?.role === "end") return t("feature.extrude.panel.reading");
    if (this.upToPlane !== null) return planeLabel(this.store.document.features, this.upToPlane);
    if (this.upTo !== null) return t("inspector.upTo.pickedFace");
    if (this.upToRef !== null) return refLabel(this.upToRef, this.store.document.features);
    return t("feature.extrude.panel.targetPick");
  }

  private startText(): string {
    if (this.pending?.role === "start") return t("feature.extrude.panel.reading");
    if (this.startRef !== null) return refLabel(this.startRef, this.store.document.features);
    return t("feature.extrude.panel.startPick");
  }

  /** The build's own refusal of the previewed feature, read off the last build;
   *  null while there is none or no built preview is up. */
  private previewError: string | null = null;
  /** whether the extrude goes into a body, as last measured (see refreshAutoOp) */
  private into = false;
  /** a build is on its way that will change what is on screen (refreshGuess) */
  private awaitingBuild = false;
  /** The model as last read off a screen WITHOUT this tool's built preview
   *  (readSolid), keyed by the start and the areas it was read at. While that
   *  preview is up the screen cannot be read, so the guess is decided again
   *  from this: a start object or a taper puts the preview up, and froze the
   *  operation at the sign it had then (a seal recess typed as -2 from a lid's
   *  start face stayed Join, and built nothing). */
  private solidReading: SolidReading | null = null;

  /** Something that will go wrong on OK, said before OK is pressed. */
  private panelWarning(): string | null {
    if (this.pickNote) return this.pickNote;
    if (this.previewError) return this.previewError;
    if (this.hasTarget() || this.pickingTarget) return null;
    // the sidecar refuses it, and OK used to do nothing and say nothing
    if (Math.abs(this.distance) < 1e-3) return t("feature.extrude.panel.zeroDistance");
    if (!this.hasSolid) return null;
    if (this.op === "join" && this.into) return t("feature.extrude.panel.joinNoEffect");
    if (this.op === "cut" && !this.into) return t("feature.extrude.panel.cutNothing");
    return null;
  }

  /** The panel values as the feature will hold them: what the user typed or
   *  chose here, else (on an edit) what the document holds NOW. */
  private panelValues(): Record<PanelValue, Num | undefined> {
    const live = this.inspectorOnlyValues();
    const value = (k: PanelValue): Num | undefined => {
      if (!this.edited.has(k)) return live[k];
      return this[k] !== 0 ? this[k] : undefined;
    };
    return {
      startOffset: this.startMode !== "profile" ? value("startOffset") : undefined,
      taper: value("taper"),
      upToOffset: value("upToOffset"),
    };
  }

  /** Where the extrude starts, in mm along the profile normal: the start
   *  offset, measured from the start object when there is one. */
  private effectiveStart(): number {
    if (this.startMode === "offset") return this.startOffset;
    if (this.startMode === "object") return (this.startRef ? this.startRefDist : 0) + this.startOffset;
    return 0;
  }

  /** Where the depth arrow starts and how long it is drawn: from the start
   *  plane, the whole distance; symmetric, from the midplane to one end. The
   *  shortest arrow drawn is ARROW_MIN_MM, and overArrow measures the same one. */
  private arrowSpan(): { from: THREE.Vector3; length: number } {
    const n = this.selected[0]?.plane.n;
    const from = this.anchor();
    if (n) from.addScaledVector(n, this.effectiveStart());
    const reach = this.symmetric ? Math.abs(this.distance) / 2 : Math.abs(this.distance);
    return { from, length: Math.max(reach, ARROW_MIN_MM) };
  }

  /** A taper, a target or a start object cannot be drawn by the instant ghost
   *  (it is a straight prism of the profile, and an object's position is only
   *  known for sure by the build), so those preview through the real build
   *  instead. Never while a start or a target is being PICKED: the click has
   *  to land on the model as it is without this extrude, which is also the
   *  model the picked reference is authored against (store.queryReferences). */
  private wantsBuiltPreview(): boolean {
    if (this.pickingTarget || this.pickingStart || this.pending) return false;
    return this.hasTarget() || this.taper !== 0 || (this.startMode === "object" && this.startRef !== null);
  }

  /** Hand the feature being made to the store's live preview, or take it back.
   *  Only when it changed: every hand-over is a rebuild. */
  private pushBuiltPreview(on: boolean) {
    if (on) this.previewId = this.editId ?? this.store.nextId();
    const f = on ? this.buildFeature(this.previewId) : null;
    const key = f ? JSON.stringify(f) : "";
    if (key === this.sentPreview) return;
    if (!key) this.awaitingBuild = true; // taken back: the screen catches up on the next build
    this.sentPreview = key;
    this.previewError = null;
    if (this.editId) this.store.setEditPreview(f);
    else this.store.setPreview(f);
  }

  /** The guessed operation, from what the model says the extrude would do
   *  (`seen`, refreshGuess). */
  private refreshAutoOp(seen: Op) {
    this.into = seen === "cut";
    if (this.opPinned) return;
    if (!this.hasSolid) {
      this.op = "new";
      return;
    }
    let guess: Op = seen;
    // All-glyph profile (sketch text): a flush emboss on a body direction-
    // guesses "join", but joined text can never print in its own color — bias
    // the default to New Body. Cut (engraving) guesses stay untouched.
    const isTextProfile = this.selected.every((wr) => wr.entityId !== undefined);
    if (isTextProfile && guess === "join") guess = "new";
    this.op = guess;
  }

  private beginDrag() {
    this.phase = "drag";
    this.overlay.setHoverRegion(null);
    this.pickingTarget = false;
    // Swing off the flat sketch view so the depth is visible. A prism grown from
    // a sketch you are looking at straight-on extends exactly along the view
    // axis, so it is invisible until you orbit — which is why every mainstream
    // MCAD tilts here. No-ops when the camera is already at an angle, so a
    // deliberate viewpoint is never yanked away. See Viewport.tiltOffAxis.
    const plane = this.selected[0]?.plane;
    if (plane) this.viewport.tiltOffAxis(plane.n);
    if (!this.editId) this.distance = DEFAULT_EXTRUDE_DISTANCE; // a fresh extrude starts there
    // A saved start object is measured now that there is a profile to measure
    // from (loadPanelValues runs before the areas are resolved).
    if (this.startRef) this.startRefDist = this.estimateStart(this.startRef);
    // Read before this tool's own preview can put material on screen: with no
    // body there is nothing to join, cut or intersect, and the panel offers
    // no Operation. An edit always offers it, opened on the saved one.
    this.hasSolid = this.editId !== null || (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    // Seed on BOTH paths, and lock the field either way (showDim).
    //
    // The edit path always did (the SIGNED saved distance — seeding the absolute
    // value would silently drop a cut's sign the moment getValue is read back,
    // the DimInput abs-display trap). The create path did not, and that was the
    // other half of field 3998d6ea: an unseeded field is cursor-tracking, so the
    // depth followed the pointer with nothing pressed. Filling it here also fixes
    // what removing the scrub would otherwise leave behind — the box used to be
    // populated by that first stray move, so without a seed the user would face a
    // blank D beside a 10 mm preview.
    //
    // The lock costs nothing now: hovering no longer writes to the field, and
    // grabbing the arrow releases it (onDown). What it buys is that the two
    // paths are the same tool from here on.
    //
    // An edit of an "up to" extrude has no depth box at all: the target decides
    // how far, and the panel holds the target and its offset.
    if (this.hasTarget()) this.dim.hide();
    else this.showDim();
    // The create prompt advertises the area toggle too. The pick-phase prompt
    // says "Ctrl-click adds areas", but a plain click jumps straight to drag, so
    // a user who picked one of several profiles landed here and was told only
    // how to set depth — the reporter of issue #14 concluded the other closed
    // sections simply could not be selected. The handler existed; nothing said
    // so.
    //
    // "Move to set depth" is gone with the scrub it described. A prompt that
    // advertises a gesture the tool does not have is how issue #14 happened;
    // one that describes a gesture the tool no longer has is the same fault in
    // reverse.
    if (this.hasTarget()) setPrompt(t("feature.extrude.targetSet"));
    else setPrompt(t(this.editId ? "feature.extrude.edit.dragPrompt" : "feature.extrude.dragPrompt"));
    this.positionDim();
    this.showPanel();
    this.panel.setNumber("distance", this.distance);
    // A build error on the previewed feature is said in the panel, before OK.
    this.offBuild ??= this.store.onBuild?.((b) => this.onBuild(b)) ?? null;
    this.updatePreview();
    this.syncPanel();
    // Started on a selected face: that face is where it starts, checked now
    // that there is a profile to check it against. Once only: a later re-pick
    // of the areas must not put back a start the user has since changed.
    const face = this.fromFace;
    this.fromFace = null;
    if (face) {
      this.startModeBefore = this.startMode === "object" ? "profile" : this.startMode;
      this.startMode = "object";
      this.pickObject("start", { kind: "face", ...face, flat: () => true });
    }
  }

  /** A build finished: if it was building this tool's preview, put its
   *  refusal (a taper the profile cannot carry, a target it cannot reach) in
   *  the panel, where it is read before OK rather than after. */
  private onBuild(b: DocumentStore["buildState"]) {
    if (b.building) return;
    // The model on screen is now the one asked for (an edit's rollback, or
    // the model with a taken-back preview gone): the guess can be read again.
    this.awaitingBuild = false;
    if (!this.sentPreview) this.refreshGuess();
    const msg = this.sentPreview ? (featureErrorMessages(b, undefined).get(this.previewId) ?? null) : null;
    if (msg === this.previewError) return;
    this.previewError = msg;
    this.syncPanel();
  }

  /** Re-read the guessed operation and whether the extrude goes into a body.
   *  The screen is read only while it shows the model the extrude will meet:
   *  not under this tool's own built preview, whose material would read as
   *  "the extrude goes into a body", nor while a build is on its way (an
   *  edit's rollback, a preview just taken back). */
  private refreshGuess() {
    if (!this.selected.length) return;
    // Read the screen when it shows the model as the extrude will meet it;
    // otherwise decide again from the last reading, if it was taken at this
    // start and these areas (solidReading).
    const fresh = !this.sentPreview && !this.awaitingBuild;
    const reading = fresh ? this.readSolid() : this.solidReading;
    if (!reading || reading.key !== this.readingKey()) return;
    this.solidReading = reading;
    const was = `${this.op}:${this.into}`;
    this.refreshAutoOp(this.operationFrom(reading));
    if (`${this.op}:${this.into}` !== was) this.syncPanel();
  }

  // --- geometry helpers ---
  /** the front-most region whose material (loop minus holes) contains the cursor */
  private regionUnder(cx: number, cy: number): WorldRegion | null {
    const ray = this.viewport.rayFrom(cx, cy).ray;
    let best: WorldRegion | null = null;
    let bestDist = Infinity;
    for (const wr of this.overlay.regions) {
      if (!ray.intersectPlane(wr.plane.plane, this.hitScratch)) continue;
      const p2d = wr.plane.to2D(this.hitScratch);
      if (!pointInRegion(p2d, wr.region)) continue;
      const d = ray.origin.distanceToSquared(this.hitScratch);
      if (d < bestDist) {
        bestDist = d;
        best = wr;
      }
    }
    return best;
  }

  /** average of the selected areas' interior points — the arrow anchor */
  private anchor(): THREE.Vector3 {
    const a = new THREE.Vector3();
    for (const wr of this.selected) a.add(wr.interior3D);
    return a.divideScalar(this.selected.length || 1);
  }

  private updatePreview() {
    if (!this.selected.length) return;
    const built = this.wantsBuiltPreview();
    // The guess first, while the screen may still show no preview of ours (and
    // from the last reading once one is up: the sign or Symmetric may have
    // changed since).
    this.refreshGuess();
    this.pushBuiltPreview(built);
    const sign = this.distance >= 0 ? 1 : -1;
    const depth = Math.abs(this.distance);
    const cut = sign < 0;
    // Where the prism starts along the profile normal: the start offset, and
    // symmetric, half the depth back from it so the start is its midplane.
    const base = this.effectiveStart() - (this.symmetric ? (sign * depth) / 2 : 0);

    const ids = this.selected
      .map((s) => `${s.sketchId}:${s.interior3D.x.toFixed(2)},${s.interior3D.y.toFixed(2)}`)
      .join("|");
    const key = `${depth.toFixed(3)}:${sign}:${base}:${built}:${ids}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.disposePreviewGeom();
      // The ghost must not hide the profile it grows from (field ed91af03).
      // It used to write depth at opacity 0.5 and sort BEFORE the sketch
      // overlay, so once beginDrag tilted the camera its cap stood in front of
      // the fills at the base and every one of them failed the depth test: the
      // selected areas' orange vanished, and what was left was a blue volume
      // beside blue unselected fills. Without depth writes the fills (and the
      // sketch curves) draw over it, the lower opacity keeps them readable,
      // and the edges keep the volume legible now that it is fainter.
      if (!this.previewMat) {
        this.previewMat = new THREE.MeshStandardMaterial({
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          metalness: 0.1,
          roughness: 0.6,
        });
      }
      this.previewEdgeMat ??= new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false });
      this.preview = new THREE.Group();
      // With a built preview up, the real feature is on screen and a straight
      // ghost over it would contradict the taper or the target: only the
      // selection outline stays.
      for (const wr of built ? [] : this.selected) {
        const shape = new THREE.Shape(wr.region.loop.map((p) => p.clone()));
        for (const h of wr.region.holes) {
          shape.holes.push(new THREE.Path(h.map((p) => p.clone())));
        }
        const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
        geo.applyMatrix4(wr.plane.basisMatrix(sign)); // local +Z -> plane normal (flipped on cut)
        const n = wr.plane.n;
        if (base) geo.translate(n.x * base, n.y * base, n.z * base);
        this.preview.add(new THREE.Mesh(geo, this.previewMat));
        // 40°: a tessellated circle's facets meet at a few degrees, and a line
        // down every one of them would hatch a cylinder instead of outlining it
        this.preview.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 40), this.previewEdgeMat));
      }
      // And the selection itself, on top of all of it: with depth writes gone
      // the fills show through, but a translucent orange under a translucent
      // blue is still a guess, and this is the one thing the user must not
      // have to guess at. Same areas as the ghost, so it is rebuilt with it.
      this.preview.add(selectionOutline(this.selected));
      this.viewport.addToScene(this.preview);
    }
    const ghostColor = cut ? 0xff5c5c : 0x5b9bff;
    this.previewMat?.color.set(ghostColor);
    this.previewEdgeMat?.color.set(ghostColor);

    // arrow manipulator along the (shared) normal, anchored at the selection
    // center on the start plane. Hidden while aiming at a target: there is no
    // distance to drag.
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const { from: anchor, length } = this.arrowSpan();
    const dir = plane.n.clone().multiplyScalar(sign);
    if (!this.arrow) {
      this.arrow = new THREE.ArrowHelper(dir, anchor, length, 0xffd24a, 6, 3);
      drawOnTop(this.arrow);
      this.viewport.addToScene(this.arrow);
    } else {
      this.arrow.position.copy(anchor);
      this.arrow.setDirection(dir);
      this.arrow.setLength(length, 6, 3);
    }
    this.arrow.visible = !this.hasTarget() && !this.pickingTarget && !this.pickingStart;
  }

  /** What the reading is keyed on: where the extrude starts, and the areas. */
  private readingKey(): string {
    return `${this.effectiveStart()}|${this.selected.map((s) => s.interior3D.toArray().join(",")).join(";")}`;
  }

  /** Read the model on screen: is there a body, and does each selected area
   *  meet material a hair either side of where the extrude starts? The start
   *  plane, not the sketch: an extrude from a start object or an offset goes
   *  into whatever is there. */
  private readSolid(): SolidReading {
    const start = this.effectiveStart();
    const at = (wr: WorldRegion, step: number) =>
      this.viewport.pointInSolid(wr.interior3D.clone().addScaledVector(wr.plane.n, start + step));
    return {
      key: this.readingKey(),
      solid: (this.store.buildState.result?.mesh.positions.length ?? 0) > 0,
      plus: this.selected.map((wr) => at(wr, 0.05)),
      minus: this.selected.map((wr) => at(wr, -0.05)),
    };
  }

  // Default operation: New Body when the doc has no solid yet, else Cut/Join by
  // whether the extrude direction pushes INTO existing material or away from it
  // (a face pushed inward reads as Cut, pulled outward as Join — MCAD parity).
  // This replaced a pure drag-SIGN guess, which defaulted "push a face through the
  // model" to Join and silently no-op'd (the union was already inside the body).
  // Symmetric goes both ways from the start, so material on EITHER side counts:
  // a symmetric extrude from a face of a body is half inside it, which is the
  // cut the feature was asked for. A majority of the selected areas decides.
  private operationFrom(r: SolidReading): Op {
    if (!r.solid) return "new";
    const forward = this.distance >= 0;
    const inside = r.plus.filter((plus, i) => {
      const minus = r.minus[i] === true;
      return this.symmetric ? plus || minus : forward ? plus : minus;
    }).length;
    return inside * 2 > r.plus.length ? "cut" : "join";
  }

  private async commit() {
    // An edit whose areas could NONE of them be drawn is still a real edit. The
    // areas are held in `editCarried`, the sketch is known from the feature
    // being edited, and the only thing missing is a selected region to read that
    // sketch off — so cancelling here threw away a typed depth and exited, which
    // reads as the tool ignoring you. Reachable whenever every stored reference
    // is ambiguous or stale: a legacy area over overlapping cells, or ids that
    // no longer name anything.
    //
    // Scoped hard to the EDIT path with something actually held. The
    // empty-selection cancel is load-bearing for CREATE: without it, typing
    // Enter after removing the last area silently threw the whole extrude away
    // (GitHub issue #14).
    const carriedOnly = !this.selected.length
      && this.editId !== null
      && this.editCarried.length > 0
      && this.forcedSketchId !== null;
    if (!this.selected.length && !carriedOnly) return this.cancel();
    // A picked edge, corner or face whose reference is still being read: the
    // feature cannot name it yet.
    if (this.pending) {
      this.panel.setWarning(t("feature.extrude.panel.stillReading"));
      return;
    }
    // Enter or OK while the Up-to box waits for its click: nothing yet says
    // how far to go.
    if (this.pickingTarget && !this.hasTarget()) {
      this.panel.setWarning(t("feature.extrude.panel.needsTarget"));
      setPrompt(t("feature.extrude.targetPrompt"));
      return;
    }
    // ...or while Start = Object has nothing in its box: nothing says where
    // it starts.
    if (this.startMode === "object" && this.startRef === null) {
      if (!this.pickingStart) this.armStartPick();
      this.panel.setWarning(t("feature.extrude.panel.needsStart"));
      return;
    }
    // A panel field holding text the app cannot read is refused, never
    // replaced by the last value it could. Only the fields that apply: a row
    // the panel has hidden is not read.
    const target = this.hasTarget();
    const read = [
      ...(this.startMode !== "profile" ? ["startOffset"] : []),
      ...(target ? ["upToOffset"] : ["distance", "taper"]),
    ];
    if (read.some((k) => this.panel.numberUnreadable(k))) {
      this.panel.setWarning(t("feature.badNumber"));
      return;
    }
    const v = this.dim.getValue("distance");
    // The depth box beside the cursor is held to the same rule. It reads
    // names and arithmetic, so a typo (`wal*2` for `wall*2`) is an ordinary
    // way to land here, and falling back to the last depth it could read
    // committed the seeded 10 mm with the typo still on screen.
    if (!target && this.dim.isActive && this.dim.isEdited("distance") && v === null) {
      this.dim.markInvalid("distance", true);
      this.panel.setWarning(t("feature.badNumber"));
      setPrompt(t("feature.badNumber"));
      return;
    }
    // GATE on isUserDriven: while dragging, the field displays |distance| —
    // reading it back unconditionally strips the drag's sign and sends the
    // extrude the wrong way ("Cut removed nothing" on cut-toward-body).
    // Typed values (userDriven) carry their own sign and win.
    if (v != null && this.dim.isUserDriven("distance")) this.distance = v;
    // A zero distance is refused, out loud in the panel (panelWarning); with a
    // target the distance is not read at all
    if (!target && Math.abs(this.distance) < 1e-3) {
      this.syncPanel();
      return;
    }
    const feature = this.buildFeature(this.editId ?? this.store.nextId());
    if (!feature) return;
    const id = feature.id;
    if (this.editId) {
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(this.editId, feature);
    } else {
      if (this.sentPreview) this.store.setPreview(null);
      this.store.addFeature(feature);
    }
    this.sentPreview = ""; // handed over above; cleanup must not take it back again
    this.overlay.clearRegionSelection();
    this.cleanup();
    this.onDone?.(id);
  }

  /** The feature as the tool and the panel describe it right now: what commit
   *  writes, and what the live preview builds. Null without a sketch to name. */
  private buildFeature(id: string): Feature | null {
    const first = this.selected[0];
    // `forcedSketchId` is the same field the selection fence uses, set from the
    // feature at startEdit, so a carried-only commit writes the sketch the
    // feature already named rather than inferring one from nothing.
    const sketchId = first ? first.sketchId : this.forcedSketchId;
    if (!sketchId) return null;
    const hiddenBodies = this.editId ? this.editHiddenBodies : this.store.hiddenBodyIds();
    const kept = this.panelValues();
    const areas: CarriedRegion[] = [
      ...this.selected.map((wr) => ({
        point: [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z] as [number, number, number],
        entityIds: wr.region.entityIds,
        holeEntityIds: wr.region.holeEntityIds ?? [],
      })),
      ...this.editCarried,
    ];
    return {
      id,
      type: "extrude",
      // `first` is safe to read the sketch off ONLY because the selection is
      // fenced to one sketch: `selectRegionsByEntities` resolves within the
      // feature's own sketch and `editSelection` filters the rest to it. Before
      // that fence, a coplanar neighbour that sorted earlier in the timeline
      // became `first` and re-targeted the whole feature's `sketch` — silently,
      // on a depth change. Fence and field move together; do not derive this
      // from a selection that is not fenced.
      sketch: sketchId,
      // A typed depth is kept as typed, only its float fuzz (0.1+0.2) dropped:
      // rounded to 1 um, 1/16" (1.5875 mm) was saved as 1.588 and 1/32"
      // (0.79375 mm) as 0.794. A drag is rounded where it moves the depth. An
      // edit that left the depth alone keeps the saved number as it is.
      distance: this.distance === this.editDistance ? this.distance : round(this.distance, 6),
      // The panel's: guessed from the direction until the user picks one, the
      // saved one on an edit, New Body while there is nothing to combine with.
      operation: this.hasSolid ? this.op : "new",
      // The entities that bound each area, recorded so the reference survives the
      // user moving the geometry it was picked on. `regions` alone is a world
      // point, and a point does not move with the circle it was inside — it ends
      // up in whatever profile now covers it (field report a20cca53). The holes'
      // own bounding entities ride along too, so the sidecar can rebuild the face
      // WITH its holes; without them it rebuilds a SOLID face whose centre sits
      // inside the hole and resolves to the wrong cell (field 19314fdc).
      //
      // Built as ONE list of areas and then projected, rather than three spreads
      // kept in step by hand. The index correspondence between the three arrays
      // is the thing this whole path exists to protect, so it is established
      // structurally and not re-asserted three times.
      //
      // `editCarried` are the areas of the feature being edited that this tool
      // could not resolve, and they go back untouched. Writing only `selected`
      // would delete them, so a depth change on a feature whose sketch has partly
      // moved would quietly shrink the solid. Order across areas carries no
      // meaning (they union), so appending is safe.
      regions: areas.map((a) => a.point),
      regionEntities: areas.map((a) => a.entityIds),
      regionHoleEntities: areas.map((a) => a.holeEntityIds),
      // End condition, when one was picked. Written only when set, so a plain
      // extrude's feature object is unchanged — and never both, which the
      // sidecar refuses (`setUpTo` is the one door that guarantees it).
      //
      // `distance` above still rides along and is deliberately NOT cleared: the
      // sidecar does not read it while a target is set, and keeping it means
      // clearing the target in the inspector restores the depth the user had
      // rather than dropping them at 0.
      ...(this.upTo ? { upTo: this.upTo } : {}),
      ...(this.upToPlane ? { upToPlane: this.upToPlane } : {}),
      // A point or a line (GH #41 b), and the object it starts from (GH #41 a):
      // written only when set, so an extrude without them keeps its exact
      // bytes, and an older document never grows either key.
      ...(this.upToRef ? { upToRef: this.upToRef } : {}),
      ...(this.startMode === "object" && this.startRef ? { startFrom: this.startRef } : {}),
      // The panel's values: typed here, or on an edit carried from the
      // document as it is now (see panelValues). Before the panel these were
      // inspector-only, and an edit that did not load them deleted them — a
      // plain depth nudge threw away a typed start offset or taper (GH #41).
      //
      // `upToOffset` is written ONLY while a target survives the edit: the
      // sidecar refuses an offset with nothing to offset FROM, so carrying it
      // past a cleared target would turn an edit into a rebuild error.
      ...(kept.startOffset !== undefined ? { startOffset: kept.startOffset } : {}),
      ...(kept.taper !== undefined ? { taper: kept.taper } : {}),
      ...(kept.upToOffset !== undefined && this.hasTarget()
        ? { upToOffset: kept.upToOffset }
        : {}),
      // Written only when on, so an ordinary extrude's feature object is
      // unchanged, and never with a target, which the sidecar refuses with it.
      ...(this.symmetric && !this.hasTarget() ? { symmetric: true } : {}),
      // capture the participants NOW: bodies hidden at creation stay excluded
      // from this boolean forever; later eye toggles are pure display. When
      // EDITING, the ORIGINAL capture is kept — re-capturing here would let
      // display toggles rewrite committed boolean history.
      ...(hiddenBodies !== undefined ? { hiddenBodies } : {}),
      // NEW extrudes split into one body per connected lump; an EDIT keeps
      // whatever the feature already had. Stamping it on edit would renumber the
      // bodies of a document that never asked for it — see types.ts.
      ...(this.editId
        ? this.editSeparateBodies !== undefined
          ? { separateBodies: this.editSeparateBodies }
          : {}
        : { separateBodies: true }),
      // NEW extrudes join only what they touch, and keep every piece; an EDIT
      // keeps the rule the feature was made with, the same way (types.ts).
      ...(this.editId
        ? this.editJoinTouchingOnly !== undefined
          ? { joinTouchingOnly: this.editJoinTouchingOnly }
          : {}
        : { joinTouchingOnly: true }),
    };
  }

  /** The start offset, taper and target offset an edit writes back where the
   *  panel did not change them: the document's CURRENT ones, not the startEdit
   *  snapshot, whenever the feature is still there.
   *  Writing the snapshot put back whatever had been typed into the inspector
   *  while the tool was open (found triaging field 637278a9: a Start offset of
   *  10 typed mid-edit was committed as the 3 the edit had opened on). The
   *  inspector is read-only during a tool now; this keeps the commit honest
   *  whoever wrote. The raw fields are read, so a parameter binding survives as
   *  the name it is rather than as its value. */
  private inspectorOnlyValues(): { startOffset: Num | undefined; taper: Num | undefined; upToOffset: Num | undefined } {
    const live = this.editId ? this.store.document.features.find((f) => f.id === this.editId) : undefined;
    if (live?.type !== "extrude") {
      return { startOffset: this.editStartOffset, taper: this.editTaper, upToOffset: this.editUpToOffset };
    }
    return { startOffset: live.startOffset, taper: live.taper, upToOffset: live.upToOffset };
  }

  cancel() {
    if (this.editId) {
      this.store.endEditPreview();
      this.overlay.clearRegionSelection();
    }
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown);
    window.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("pointercancel", this.boundCancel);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    this.grab = null; // a tool torn down mid-drag must not resume one on reopen
    this.press = null; // nor commit on a release that arrives after teardown
    this.dim.hide();
    this.panel.hide();
    this.offBuild?.();
    this.offBuild = null;
    // A built preview still up is taken back. An edit's is the store's edit
    // preview, which cancel/commit already ended.
    if (this.sentPreview && !this.editId) this.store.setPreview(null);
    this.sentPreview = "";
    this.disposePreviewGeom();
    this.previewMat?.dispose();
    this.previewMat = null;
    this.previewEdgeMat?.dispose();
    this.previewEdgeMat = null;
    this.previewKey = "";
    if (this.arrow) {
      this.viewport.removeFromScene(this.arrow);
      this.arrow.dispose();
      this.arrow = null;
    }
    this.overlay.setHoverRegion(null);
    this.clearPickHover();
    this.showOriginPlanes(false);
    this.pickingStart = false;
    this.pickingTarget = false;
    this.pending = null; // a reference still being read lands on nothing
    this.viewport.suspendPicking = false;
    this.active = false;
    this.selected = [];
    this.editCarried = [];
    if (this.editId !== null || this.forcedSketchId !== null) {
      this.editId = null;
      this.editHiddenBodies = undefined;
      this.forcedSketchId = null;
      this.overlay.update(this.store.document); // re-hide the consumed sketch
    }
    setPrompt(null);
  }

  /** remove + dispose the preview group's geometries (the materials are
   *  reused; the selection outline's is shared with the sketch overlay) */
  private disposePreviewGeom() {
    if (!this.preview) return;
    this.viewport.removeFromScene(this.preview);
    // traverse, not children: the outline is a group of its own. Line2 is a
    // Mesh, so the one test covers the ghost and the outline.
    this.preview.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
    });
    this.preview = null;
  }
}
