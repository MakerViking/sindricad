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
// (both overridable in the commit dialog).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { drawOnTop } from "../viewport/gizmos";
import type { RegionRef, SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature, Num, Selector } from "../types";
import { pointInRegion } from "../sketch/region";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { axisDragDistance, pixelDistanceToSegment } from "./manipulator";
import { choose } from "../ui/choice";
// One number for "the depth a fresh extrude starts at", shared with the store:
// clearing an up-to target has to restore a depth, and two constants would
// drift. It lives in the document layer because the store cannot import this
// file (that would pull the viewport stack into the document layer).
import { DEFAULT_EXTRUDE_DISTANCE } from "../document/numFields";

type Phase = "pick" | "drag";
type Op = "new" | "join" | "cut" | "intersect";

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

export class ExtrudeTool {
  active = false;
  private phase: Phase = "pick";
  private selected: WorldRegion[] = [];
  private distance = DEFAULT_EXTRUDE_DISTANCE;
  private preview: THREE.Group | null = null;
  private previewMat: THREE.MeshStandardMaterial | null = null;
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
  private editOp: Op | null = null; // saved operation (pre-sorted first in the modal)
  private editHiddenBodies: string[] | undefined; // participants captured at creation — KEPT
  private editSeparateBodies: boolean | undefined; // ditto: an edit must not change body COUNT
  /** Values that only the inspector can set, carried through an edit unchanged.
   *  The tool offers no field for any of them, so if `startEdit` does not load
   *  them `commit` deletes them — and a bare depth nudge would throw away
   *  numbers the user typed (GH #41). Same contract as the end condition above
   *  it: what startEdit does not load, commit destroys. */
  private editStartOffset: Num | undefined;
  private editTaper: Num | undefined;
  private editUpToOffset: Num | undefined;
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
  private pickingTarget = false; // waiting for the user to click the up-to target
  /** while editing, this sketch is forced visible so its regions exist
   *  (consumed sketches hide by default) — main.ts's isSketchVisible honors it. */
  forcedSketchId: string | null = null;

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

  start(onDone: (id: string | null) => void) {
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
    // A FRESH extrude must not inherit the last edited feature's inspector
    // values. Cleared here rather than in beginDrag for the same reason as the
    // end condition above: startEdit calls beginDrag too.
    this.editStartOffset = undefined;
    this.editTaper = undefined;
    this.editUpToOffset = undefined;
    this.pickingTarget = false;
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
      setPrompt("Select a profile to extrude · Ctrl-click adds areas · Enter to confirm");
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
    this.editOp = f.operation;
    this.editHiddenBodies = f.hiddenBodies;
    this.editSeparateBodies = f.separateBodies;
    // Carry the saved end condition through the edit. Not restoring it here is
    // how a depth tweak would silently turn an "up to that face" extrude back
    // into a blind one — `commit` writes what these fields hold, so anything
    // startEdit does not load, commit deletes.
    this.upTo = f.upTo ?? null;
    this.upToPlane = f.upToPlane ?? null;
    // Inspector-only values ride along untouched, for the same reason.
    this.editStartOffset = f.startOffset;
    this.editTaper = f.taper;
    this.editUpToOffset = f.upToOffset;
    this.pickingTarget = false;
    this.distance = f.distance;
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
        setPrompt(
          `Editing extrude: ${unresolved.length} of ${saved.length} areas no longer match the sketch ` +
            "and are kept unchanged · changing the area set drops them · " +
            "drag the arrow or type a value + Enter · click to commit · Esc to cancel",
        );
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
      const one = saved.length === 1;
      const it = one ? "it" : "them";
      const changed = unresolved.some((ref) => ref.entityIds?.length);
      setPrompt(
        changed
          ? `Editing extrude: its ${one ? "area was" : `${saved.length} areas were`} not found ` +
              `(sketch changed?) · ${one ? "it is" : "they are"} kept until you pick · ` +
              `what you pick replaces ${it} · select a profile · Esc to cancel`
          : `Editing extrude: its ${one ? "area cannot" : `${saved.length} areas cannot`} be shown ` +
              `· ${one ? "it is" : "they are"} kept as saved · what you pick replaces ${it} ` +
              "· select a profile · Esc to cancel",
      );
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
    setPrompt(
      "That area belongs to a different sketch · an extrude uses one sketch, so this edit " +
        "can only use its own · Esc, then extrude the other sketch separately",
    );
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      this.overlay.setHoverRegion(r);
      this.viewport.domElement.style.cursor = r ? "pointer" : "default";
      return;
    }
    // T mode ("extrude up to"): show what the click would bind, with the same
    // BODY-FIRST precedence the T-mode click uses below. Without it the mode is
    // invisible — the cursor sweeps a face or an offset plane and nothing on
    // screen says it is aimed at anything (field report c0cfee48, reported
    // against press/pull; this tool had the gap verbatim).
    if (this.pickingTarget) {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      const datumId = faceId == null ? this.viewport.pickDatumAt(e.clientX, e.clientY) : null;
      this.viewport.hoverDatum(datumId);
      this.viewport.domElement.style.cursor = faceId != null || datumId ? "pointer" : "default";
      return;
    }
    if (!this.selected.length) return;
    const first = this.selected[0];
    if (!first) return;
    const anchor = this.anchor();
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
      this.distance = this.grab.distance + (axis - this.grab.axis);
      // A drag owns the field (armDragIfMoved unlocked it), so this lands. The
      // box shows the magnitude and `distance` carries the sign — the split
      // commit() reads.
      this.dim.updateFromCursor({ distance: Math.abs(this.distance) });
    } else {
      // NOT dragging, so the depth is not the pointer's to change. It used to
      // be: a pre-selected profile puts this tool straight into "drag" phase
      // with the field still cursor-tracking, so bare pointermoves — no button
      // ever down, no pointerdown ever dispatched — scrubbed the depth (field
      // 3998d6ea). Two bare moves were enough to swing it from the seeded
      // 10 mm to a large negative and then a large positive value; the exact
      // figures depend on where the cursor was and are not worth recording,
      // because the sign is the part that bites. The sign crossing zero flips
      // `entersSolid`'s reading
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
    if (!this.grab) {
      // After updatePreview, so the affordance is measured against the arrow as
      // just drawn. A handle that gives no sign of being grabbable is half of
      // field 6e2bcadd — the reporter could SEE the arrow and concluded it was
      // decoration.
      this.viewport.domElement.style.cursor = this.overArrow(e.clientX, e.clientY) ? "ns-resize" : "default";
    }
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
    if (!this.arrow || !first) return false;
    const anchor = this.anchor();
    const sign = this.distance >= 0 ? 1 : -1;
    const tip = anchor
      .clone()
      .addScaledVector(first.plane.n, sign * Math.max(Math.abs(this.distance), ARROW_MIN_MM));
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
  private positionDim(anchor: THREE.Vector3 = this.anchor()) {
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
      if (dropped) {
        setPrompt(
          `Editing extrude: ${dropped} area${dropped === 1 ? "" : "s"} that could not be shown ` +
            `${dropped === 1 ? "is" : "are"} no longer kept · what you pick is the new set`,
        );
      }
    } else {
      e.preventDefault();
      // T-mode: this click names the surface to extrude UP TO. Consume EVERY
      // click here — a miss must never fall through to the clean-click-commits
      // path below and fire a stray plain commit (the same audit finding that
      // shaped press/pull's version of this branch).
      if (this.pickingTarget) {
        e.stopImmediatePropagation();
        const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
        if (hit) {
          this.setUpTo(hit.selector);
          void this.commit();
          return;
        }
        // A datum plane is a legitimate target too (field report ffab4ece), but
        // only on a body MISS — the same BODY-FIRST precedence
        // viewport.handleClick uses, so a plane's 80x80 quad floating in front
        // of the solid can never steal a face pick.
        const datumId = this.viewport.pickDatumAt(e.clientX, e.clientY);
        if (datumId) {
          this.setUpTo(datumId);
          void this.commit();
          return;
        }
        setPrompt("Pick the face or plane to extrude UP TO (any face, any body) · Esc to go back");
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
          // Hide the depth box too. Leaving it up was a trap: its Enter/✓
          // callback still points at commit(), whose first guard bails to
          // cancel() on an empty selection — so typing Enter after removing the
          // last area silently threw the whole extrude away, while the prompt
          // said "select a profile". onKey defers to the input while it has
          // focus, so nothing else intercepted it. (GitHub issue #14.)
          this.dim.hide();
          setPrompt(
            (dropped ? `${dropped} unmatched ${dropped === 1 ? "area is" : "areas are"} no longer kept · ` : "") +
              "Select a profile to extrude · Ctrl-click adds areas · Enter to confirm",
          );
          return;
        }
        this.updatePreview();
        if (dropped) {
          setPrompt(
            `Editing extrude: ${dropped} unmatched ${dropped === 1 ? "area is" : "areas are"} ` +
              "no longer kept, pick again if the feature still needs " +
              `${dropped === 1 ? "it" : "them"} · Ctrl-click areas to add/remove · ` +
              "drag the arrow or type a value + Enter · click to commit · Esc to cancel",
          );
        }
        return;
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

  /** `upTo` (a face) and `upToPlane` (a datum id) are mutually exclusive by
   *  contract — the sidecar REFUSES a feature carrying both rather than picking
   *  one — so every target set goes through here and clears the other. */
  private setUpTo(target: Selector | string) {
    if (typeof target === "string") {
      this.upToPlane = target;
      this.upTo = null;
    } else {
      this.upTo = target;
      this.upToPlane = null;
    }
  }

  private onKey(e: KeyboardEvent) {
    if (this.dim.isActive && e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") { this.cancel(); return; }
      // Everything else aimed at the depth box is the FIELD's — Enter commits,
      // Tab locks and advances — except this tool's own letter hotkey on a box
      // nobody has typed into yet. Without that exception T and Shift-T below
      // were unreachable for the whole time the tool was open, because
      // beginDrag focuses the box: pressing T to aim the extrude at a plane
      // typed a "t" over the seeded depth (field report 88c9bdf0).
      if (e.key.toLowerCase() !== "t" || !this.dim.claimToolHotkey(e)) return;
    }
    if (e.key === "Escape") {
      // Esc out of target-picking goes back to the depth gesture rather than
      // cancelling the whole extrude — the same two-level Escape press/pull has.
      if (this.pickingTarget) {
        this.pickingTarget = false;
        // leaving T mode takes its highlights with it, or the last face and
        // plane the cursor passed stay lit over a tool that no longer aims there
        this.viewport.clearHover();
        this.viewport.hoverDatum(null);
        // restore the field T-mode hid: leaving it hidden would strand the user
        // with no way to type a depth, and leaving it ACTIVE during the pick let
        // Enter commit a plain distance mid-target-pick.
        this.dim.show([{ name: "distance", label: "D" }], () => void this.commit(), () => this.cancel());
        this.dim.seed("distance", this.distance);
        setPrompt(
          "Drag the arrow or type a value + Enter · T = extrude up to a face or plane · " +
            "click to commit · Esc to cancel",
        );
        return;
      }
      this.cancel();
      return;
    }
    if (e.key === "Enter" && this.phase === "pick" && this.selected.length) this.beginDrag();
    else if (
      (e.key === "T" || e.key === "t") &&
      e.shiftKey &&
      this.phase === "drag" &&
      !this.pickingTarget &&
      (this.upTo || this.upToPlane)
    ) {
      // Shift-T is the tool's half of GH #41: `setUpTo` could only ever SET a
      // target, so an extrude aimed at a face could not be turned back into a
      // plain-depth one from here — and taper, which the inspector hides while a
      // target exists, stayed out of reach with it. Tested BEFORE the plain-T
      // branch below, which would otherwise swallow the same key press. The
      // inspector's "Up to" row is the discoverable control; this is parity for
      // someone already in the tool.
      this.upTo = null;
      this.upToPlane = null;
      // An up-to extrude never read its distance, so it can legitimately be 0 —
      // and a plain extrude of 0 is refused by the sidecar. Same substitution
      // the inspector's clear makes (store.clearUpToTarget), and the field is
      // re-seeded so the user sees the depth they are about to commit.
      if (this.distance === 0) {
        this.distance = DEFAULT_EXTRUDE_DISTANCE;
        this.dim.seed("distance", this.distance);
        this.updatePreview();
      }
      setPrompt(
        "Up-to target cleared, extruding by distance again · drag the arrow or type a value + Enter · " +
          "T = up to a face or plane · click to commit · Esc to cancel",
      );
    } else if ((e.key === "t" || e.key === "T") && !e.shiftKey && this.phase === "drag" && !this.pickingTarget) {
      this.pickingTarget = true;
      this.dim.hide(); // Enter must not commit a plain distance while picking
      setPrompt("Click the face or plane to extrude UP TO (any face, any body) · Esc to go back");
    }
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
    this.dim.show([{ name: "distance", label: "D" }], () => void this.commit(), () => this.cancel());
    // Seed on BOTH paths, and lock the field either way.
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
    this.dim.seed("distance", this.distance);
    setPrompt(
      this.editId
        ? "Editing extrude: drag the arrow or type a value + Enter · Ctrl-click areas to " +
            "add/remove · T = up to a face or plane, Shift-T clears it · click to commit · Esc to cancel " +
            "(later features are hidden while editing)"
        : // Advertise the area toggle here too. The pick-phase prompt says
          // "Ctrl-click adds areas", but a plain click jumps straight to drag, so
          // a user who picked one of several profiles landed here and was told
          // only how to set depth — the reporter of issue #14 concluded the other
          // closed sections simply could not be selected. The handler existed;
          // nothing said so.
          //
          // "Move to set depth" is gone with the scrub it described. A prompt that
          // advertises a gesture the tool does not have is how issue #14 happened;
          // one that describes a gesture the tool no longer has is the same fault
          // in reverse.
          "Drag the arrow to set depth · Ctrl-click areas to add/remove · type a value + Enter · " +
          "negative = cut · T = up to a face or plane, Shift-T clears it · click to commit · Esc to cancel",
    );
    this.positionDim();
    this.updatePreview();
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
    const sign = this.distance >= 0 ? 1 : -1;
    const depth = Math.abs(this.distance);
    const cut = sign < 0;

    const ids = this.selected
      .map((s) => `${s.sketchId}:${s.interior3D.x.toFixed(2)},${s.interior3D.y.toFixed(2)}`)
      .join("|");
    const key = `${depth.toFixed(3)}:${sign}:${ids}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.disposePreviewGeom();
      if (!this.previewMat) {
        this.previewMat = new THREE.MeshStandardMaterial({
          transparent: true,
          opacity: 0.5,
          metalness: 0.1,
          roughness: 0.6,
        });
      }
      this.preview = new THREE.Group();
      for (const wr of this.selected) {
        const shape = new THREE.Shape(wr.region.loop.map((p) => p.clone()));
        for (const h of wr.region.holes) {
          shape.holes.push(new THREE.Path(h.map((p) => p.clone())));
        }
        const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
        geo.applyMatrix4(wr.plane.basisMatrix(sign)); // local +Z -> plane normal (flipped on cut)
        this.preview.add(new THREE.Mesh(geo, this.previewMat));
      }
      this.viewport.addToScene(this.preview);
    }
    this.previewMat?.color.set(cut ? 0xff5c5c : 0x5b9bff);

    // arrow manipulator along the (shared) normal, anchored at the selection center
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const anchor = this.anchor();
    const dir = plane.n.clone().multiplyScalar(sign);
    if (!this.arrow) {
      this.arrow = new THREE.ArrowHelper(dir, anchor, Math.max(depth, ARROW_MIN_MM), 0xffd24a, 6, 3);
      drawOnTop(this.arrow);
      this.viewport.addToScene(this.arrow);
    } else {
      this.arrow.position.copy(anchor);
      this.arrow.setDirection(dir);
      this.arrow.setLength(Math.max(depth, ARROW_MIN_MM), 6, 3);
    }
  }

  // Default operation: New Body when the doc has no solid yet, else Cut/Join by
  // whether the extrude direction pushes INTO existing material or away from it
  // (a face pushed inward reads as Cut, pulled outward as Join — MCAD parity).
  // This replaced a pure drag-SIGN guess, which defaulted "push a face through the
  // model" to Join and silently no-op'd (the union was already inside the body).
  private entersSolid(): boolean {
    if (!this.selected.length) return false;
    const sign = this.distance >= 0 ? 1 : -1;
    let inside = 0;
    for (const wr of this.selected) {
      // step the area's interior a hair along the extrude direction, off its face
      const p = wr.interior3D.clone().addScaledVector(wr.plane.n, sign * 0.05);
      if (this.viewport.pointInSolid(p)) inside++;
    }
    return inside * 2 > this.selected.length; // majority of selected areas
  }

  private currentOperation(): Op {
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (!hasSolid) return "new";
    return this.entersSolid() ? "cut" : "join";
  }

  private committing = false;
  private async commit() {
    if (this.committing) return;
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
    const v = this.dim.getValue("distance");
    // GATE on isUserDriven: while dragging, the field displays |distance| —
    // reading it back unconditionally strips the drag's sign and sends the
    // extrude the wrong way ("Cut removed nothing" on cut-toward-body).
    // Typed values (userDriven) carry their own sign and win.
    if (v != null && this.dim.isUserDriven("distance")) this.distance = v;
    if (Math.abs(this.distance) < 1e-3) return; // ignore zero
    let op = this.currentOperation();
    // when a body already exists, let the user state the operation (MCAD-style):
    // New Body avoids any boolean (and the kernel crash on hard geometry).
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (hasSolid) {
      this.committing = true;
      // in edit mode the SAVED operation is the presumptive choice; otherwise
      // the direction-derived guess is.
      let guess = this.editId ? (this.editOp ?? op) : op;
      // All-glyph profile (sketch text): a flush emboss on a body direction-
      // guesses "join", but joined text can never print in its own color — bias
      // the default to New Body so the two-tone path is one Enter away. Cut
      // (engraving) guesses stay untouched.
      const isTextProfile = this.selected.every((wr) => wr.entityId !== undefined);
      if (!this.editId && isTextProfile && guess === "join") guess = "new";
      // op === "cut" ⇔ the extrude direction enters solid (currentOperation).
      // Flag whichever op would then do nothing, so the choice is informed.
      const into = op === "cut";
      const opts: { value: Op; label: string; hint: string }[] = [
        { value: "join", label: "Join", hint: into ? "⚠ likely no effect (profile is inside)" : "merge" },
        { value: "cut", label: "Cut", hint: into ? "remove" : "⚠ nothing to cut here" },
        { value: "new", label: "New Body", hint: isTextProfile ? "separate — assign its own print color" : "separate" },
        { value: "intersect", label: "Intersect", hint: "keep overlap" },
      ];
      opts.sort((a, b) => (a.value === guess ? -1 : b.value === guess ? 1 : 0)); // default first
      const chosen = await choose<Op>("Extrude — operation", opts);
      this.committing = false;
      if (!chosen) {
        // modal dismissed — the tool is STILL ALIVE; say so instead of leaving
        // the user staring at an unchanged screen ("nothing happened")
        setPrompt("Extrude not committed — Enter/✓ to choose an operation · Esc to cancel");
        return;
      }
      op = chosen;
    } else if (this.editId && this.editOp) {
      // rolled-back model has no solid (this WAS the first solid) — keep the
      // saved operation rather than silently rewriting it to "new".
      op = this.editOp;
    }
    const first = this.selected[0];
    // `forcedSketchId` is the same field the selection fence uses, set from the
    // feature at startEdit, so a carried-only commit writes the sketch the
    // feature already named rather than inferring one from nothing.
    const sketchId = first ? first.sketchId : this.forcedSketchId;
    if (!sketchId) return;
    const hiddenBodies = this.editId ? this.editHiddenBodies : this.store.hiddenBodyIds();
    const areas: CarriedRegion[] = [
      ...this.selected.map((wr) => ({
        point: [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z] as [number, number, number],
        entityIds: wr.region.entityIds,
        holeEntityIds: wr.region.holeEntityIds ?? [],
      })),
      ...this.editCarried,
    ];
    const feature: Feature = {
      id: this.editId ?? this.store.nextId(),
      type: "extrude",
      // `first` is safe to read the sketch off ONLY because the selection is
      // fenced to one sketch: `selectRegionsByEntities` resolves within the
      // feature's own sketch and `editSelection` filters the rest to it. Before
      // that fence, a coplanar neighbour that sorted earlier in the timeline
      // became `first` and re-targeted the whole feature's `sketch` — silently,
      // on a depth change. Fence and field move together; do not derive this
      // from a selection that is not fenced.
      sketch: sketchId,
      distance: Math.round(this.distance * 1000) / 1000,
      operation: op,
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
      // Inspector-only values, carried through an edit. The tool has no field
      // for any of them, so before this they were deleted by any edit — a plain
      // depth nudge threw away a typed start offset or taper (GH #41).
      //
      // `upToOffset` is written ONLY while a target survives the edit: the
      // sidecar refuses an offset with nothing to offset FROM, so carrying it
      // past a cleared target would turn an edit into a rebuild error.
      ...(this.editStartOffset !== undefined ? { startOffset: this.editStartOffset } : {}),
      ...(this.editTaper !== undefined ? { taper: this.editTaper } : {}),
      ...(this.editUpToOffset !== undefined && (this.upTo || this.upToPlane)
        ? { upToOffset: this.editUpToOffset }
        : {}),
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
    };
    const id = feature.id;
    if (this.editId) {
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(this.editId, feature);
    } else {
      this.store.addFeature(feature);
    }
    this.overlay.clearRegionSelection();
    this.cleanup();
    this.onDone?.(id);
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
    this.disposePreviewGeom();
    this.previewMat?.dispose();
    this.previewMat = null;
    this.previewKey = "";
    if (this.arrow) {
      this.viewport.removeFromScene(this.arrow);
      this.arrow.dispose();
      this.arrow = null;
    }
    this.overlay.setHoverRegion(null);
    this.viewport.clearHover();
    this.viewport.hoverDatum(null);
    this.viewport.suspendPicking = false;
    this.active = false;
    this.selected = [];
    this.editCarried = [];
    if (this.editId !== null || this.forcedSketchId !== null) {
      this.editId = null;
      this.editOp = null;
      this.editHiddenBodies = undefined;
      this.forcedSketchId = null;
      this.overlay.update(this.store.document); // re-hide the consumed sketch
    }
    setPrompt(null);
  }

  /** remove + dispose the preview group's geometries (the material is reused) */
  private disposePreviewGeom() {
    if (!this.preview) return;
    this.viewport.removeFromScene(this.preview);
    for (const child of this.preview.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.preview = null;
  }
}
