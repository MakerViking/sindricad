// Interactive multi-body Move: a 3-axis arrow gizmo at the centre of the
// selected bodies, and a docked Move panel holding the whole move (Doug 28):
// Move X/Y/Z, Rotate X/Y/Z and what the rotation turns about, typed while the
// move is made rather than in the inspector afterwards. Grab an arrow and drag
// to translate along it (the drag writes that axis's row, and the box at the
// cursor takes a typed value for the axis last dragged); type any row and the
// ghost follows. The ghost is the bodies' own meshes moved in place, with no
// sidecar round trip, by the same matrix the sidecar builds (moveMatrix). Click
// off the gizmo, Enter or OK to commit, Esc to revert. A move that only rotates
// commits too. Double-clicking a move reopens the panel on its saved values.
// Mirrors the PressPull / PlaneOffset gizmo pattern; the panel is ToolPanel,
// which the Extrude panel also uses.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { fmtLength, snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import { HANDLE_HOT as HOT } from "../viewport/colors3d";
import { t } from "../i18n";
import { ToolPanel } from "../ui/toolPanel";
import { isImeComposing } from "../ui/focus";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const AXES = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xff5a5a }, // X red
  { dir: new THREE.Vector3(0, 1, 0), color: 0x5ad15a }, // Y green
  { dir: new THREE.Vector3(0, 0, 1), color: 0x5a9bff }, // Z blue
];
/** The panel rows, named as the feature's fields. */
const MOVE_ROWS = ["dx", "dy", "dz"] as const;
const TURN_ROWS = ["rx", "ry", "rz"] as const;

type MoveFeature = Extract<Feature, { type: "move" }>;
type Pivot = "centre" | "origin" | "saved";
interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** The rigid transform a move applies, exactly as the sidecar builds it
 *  (builder._handle_move): T(d) * T(pivot) * R * T(-pivot), where R is the
 *  Euler "XYZ" rotation in degrees, which is build123d's Rot(rx, ry, rz). A
 *  null pivot is the world origin. The live ghost is placed by this, so the
 *  ghost IS the body the move builds; moveTool.test.ts and test_smoke's
 *  test_move_rotates_about_its_pivot pin the same numbers on both sides. */
export function moveMatrix(d: XYZ, r: readonly [number, number, number], pivot: XYZ | null): THREE.Matrix4 {
  const k = Math.PI / 180;
  const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r[0] * k, r[1] * k, r[2] * k, "XYZ"));
  const p = pivot ?? { x: 0, y: 0, z: 0 };
  return new THREE.Matrix4()
    .makeTranslation(d.x + p.x, d.y + p.y, d.z + p.z)
    .multiply(rot)
    .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
}

/** Strip float fuzz (a snapped 0.30000000000000004) from a stored value, and
 *  nothing more: three places turned a typed 1/16 in (1.5875 mm) into 1.588. */
const clean = (n: number) => Math.round(n * 1e6) / 1e6;
/** The pivot is measured off the display mesh, not typed: a thousandth of a
 *  millimetre is far finer than that mesh, and keeps the saved file tidy. */
const tidy = (n: number) => Math.round(n * 1000) / 1000;
/** A saved pivot this close to the middle measured again is still Centre: ten
 *  times the rounding above, and far below anything a user would see. */
const STILL_CENTRE = 0.01;

export class MoveTool {
  active = false;
  /** the feature's `bodies` (empty on a legacy move, which moves the last body) */
  private bodies: string[] = [];
  /** the bodies the ghost moves: `bodies`, or the last body for a legacy move */
  private ghostIds: string[] = [];
  private anchor = new THREE.Vector3(); // gizmo origin before the move, fixed
  private t = new THREE.Vector3(); // current translation
  private r: [number, number, number] = [0, 0, 0]; // current rotation, degrees
  /** What the rotation turns about: the panel's Centre (`centre`, saved as the
   *  feature's pivot), the world origin (no pivot, as every older move), or on
   *  an edit the point the move was saved with when that is no longer the
   *  middle of what moves (`saved`: no chip is on, and the panel says so). */
  private pivot: Pivot = "centre";
  private centre = new THREE.Vector3();
  /** the pivot an edited move was saved with, as saved */
  private savedPivot: THREE.Vector3 | null = null;
  private previewId = "";

  /** edit mode: the move being re-opened, as saved */
  private editId: string | null = null;
  private editSaved: MoveFeature | null = null;
  /** an edit waits for the model rolled back to just before the move */
  private awaitingRollback = false;
  private unsubBuild: (() => void) | null = null;

  private gizmo: THREE.Group | null = null;
  private arrows: { group: THREE.Group; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  private hoverAxis = -1;
  private grabAxis = -1;
  private lastAxis = -1; // most recently dragged axis (target of a typed value)
  private grabVal = 0;
  private grabProj = 0;
  /** where the gizmo was drawn when its arrow was grabbed: the drag is
   *  measured along the axis line through it, the line the arrow lies on */
  private grabFrom = new THREE.Vector3();
  private downPos = { x: 0, y: 0 };
  private raf = 0;

  private dim = new DimInput();
  private panel = new ToolPanel("move-panel");
  private onDone: ((id: string | null) => void) | null = null;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundTick: () => void;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundKey = (e) => this.onKey(e);
    this.boundTick = () => this.tick();
  }

  start(bodies: string[], onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.onDone = onDone;
    this.bodies = bodies;
    this.ghostIds = bodies;
    this.editId = null;
    this.editSaved = null;
    this.t.set(0, 0, 0);
    this.r = [0, 0, 0];
    // Centre for a new move: the arrows sit there, and a body turned in place
    // is what a typed rotation is nearly always for. The origin is one click.
    this.pivot = "centre";
    this.lastAxis = -1;
    this.previewId = this.store.nextId();
    this.listen();
    this.placeOnBodies();
    this.open(t("feature.move.prompt"));
  }

  /** Re-open a committed move: the model rolls back to just before it, the
   *  panel opens on its saved values, and OK replaces it in place (same id, one
   *  undo step). Returns false when a value is set by a parameter, which is
   *  the inspector's job, as for every other tool. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (f?.type !== "move") return false;
    const rows = [...MOVE_ROWS, ...TURN_ROWS];
    if (rows.some((k) => typeof f[k] !== "number" || this.store.isParamBound({ kind: "feature", feature: f.id, field: k }))) {
      return false;
    }
    this.active = true;
    this.onDone = onDone;
    this.editId = featureId;
    this.editSaved = f;
    this.bodies = f.bodies ?? [];
    this.t.set(f.dx as number, f.dy as number, f.dz as number);
    this.r = [f.rx as number, f.ry as number, f.rz as number];
    this.pivot = "origin"; // or, once the model is read, the saved pivot (takeSavedPivot)
    this.lastAxis = -1;
    this.previewId = featureId;
    this.awaitingRollback = true;
    setPrompt(t("feature.rollingBack"));
    window.addEventListener("keydown", this.boundKey, true);
    // a click while the model rolls back finds no gizmo and commits nothing
    this.listenPointer();
    // Which settle is the ROLLED-BACK model: the first one after a build seen
    // starting, skipping a build that was already running, which settles first
    // with the move still in it. splitTool.startEdit has the long version; read
    // too early, the ghost would grab the meshes the move had already moved.
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
      if (!this.awaitingRollback) return this.reghost();
      if (!armed) return;
      armed = false;
      if (skips > 0) {
        skips--;
        return;
      }
      this.awaitingRollback = false;
      // A move saved without bodies moves the last body there is at its point
      // in the timeline (the sidecar's active body), which is this model's last.
      const last = s.result.bodies?.at(-1)?.id;
      this.ghostIds = this.bodies.length ? this.bodies : last ? [last] : [];
      this.placeOnBodies();
      if (f.pivot) this.takeSavedPivot(f.pivot);
      this.open(t("feature.move.editPrompt"));
    });
    live = true;
    return true;
  }

  /** Where the arrows sit, and the Centre the rotation can turn about: the
   *  middle of the bodies' box. */
  private placeOnBodies() {
    const box = this.viewport.bodiesBox(this.ghostIds);
    const mid = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    this.centre.set(tidy(mid.x), tidy(mid.y), tidy(mid.z));
    this.anchor.copy(this.centre);
  }

  /** An edited move turns about the point it was saved with. Still on the
   *  middle of what moves, that point is Centre, kept to its saved digits so an
   *  untouched OK writes it back as it was. An earlier step that has since
   *  moved the bodies leaves it where it was (the move stays the same rigid
   *  motion, as its dx does), so it is no longer the middle: lighting Centre
   *  then claimed a turn in place that the ghost did not show. It is shown as
   *  the fixed point it is, and Centre turns about the middle as it is now. */
  private takeSavedPivot(p: readonly [number, number, number]) {
    this.savedPivot = new THREE.Vector3(p[0], p[1], p[2]);
    if (this.savedPivot.distanceTo(this.centre) <= STILL_CENTRE) {
      this.centre.copy(this.savedPivot);
      this.anchor.copy(this.centre);
      this.pivot = "centre";
    } else {
      this.pivot = "saved";
    }
  }

  private listen() {
    window.addEventListener("keydown", this.boundKey, true);
    this.listenPointer();
    // A build landing mid-move (a body shown or hidden from the Browser's eye)
    // puts fresh meshes on screen at their unmoved place.
    let live = false;
    this.unsubBuild = this.store.onBuild((s) => {
      if (live && !s.building && s.result) this.reghost();
    });
    live = true;
  }

  private listenPointer() {
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
  }

  /** Put the ghost back on whatever meshes the last build drew. */
  private reghost() {
    if (this.awaitingRollback || !this.gizmo) return;
    this.viewport.beginBodyMoveGhost(this.ghostIds);
    this.refreshPreview();
  }

  /** The gizmo, the panel, the box at the cursor and the ghost: what both
   *  entry points show once the model they move is on screen. */
  private open(prompt: string) {
    this.viewport.beginBodyMoveGhost(this.ghostIds); // live mesh transform, no rebuild
    this.buildGizmo();
    this.showPanel();
    this.dim.show(
      [{ name: "move", label: t("tool.move"), kind: "length" }],
      () => this.commit(),
      () => this.cancel(),
      () => this.onDimInput(),
    );
    const s = this.viewport.projectToScreen(this.gizmoAt());
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ move: 0 });
    this.refreshPreview();
    setPrompt(prompt);
    this.raf = requestAnimationFrame(this.boundTick);
  }

  private comp(i: number): number {
    return this.t.getComponent(i);
  }

  /** One axis of the translation, from a drag or a typed value: the row and
   *  the ghost follow. */
  private setAxis(i: number, v: number) {
    this.t.setComponent(i, v);
    const row = MOVE_ROWS[i];
    if (row) this.panel.setNumber(row, v);
    this.refreshPreview();
  }

  /** The move as it stands: what the ghost shows and the feature will hold. */
  private matrix(): THREE.Matrix4 {
    const about = this.pivot === "centre" ? this.centre : this.pivot === "saved" ? this.savedPivot : null;
    return moveMatrix(this.t, this.r, about);
  }

  /** Where the gizmo is drawn: on the moved bodies, where the anchor went. */
  private gizmoAt(): THREE.Vector3 {
    return this.anchor.clone().applyMatrix4(this.matrix());
  }

  private onMove(e: PointerEvent) {
    if (this.grabAxis >= 0) {
      const ax = AXES[this.grabAxis];
      if (!ax) return;
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.grabFrom, ax.dir);
      const raw = this.grabVal + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.grabFrom));
      if (stepped === this.comp(this.grabAxis)) return;
      this.setAxis(this.grabAxis, stepped);
      this.dim.updateFromCursor({ move: stepped });
      return;
    }
    this.hoverAxis = this.hitAxis(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hoverAxis >= 0 ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const axis = this.hitAxis(e.clientX, e.clientY);
    if (axis >= 0) {
      const ax = AXES[axis];
      if (!ax) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // A distance typed before any arrow was touched gets its direction from
      // the arrow taken now (Doug28b: it used to be dropped without a word).
      const pending = this.lastAxis < 0 && this.dim.isUserDriven("move") ? this.dim.getValue("move") : null;
      this.grabAxis = axis;
      this.lastAxis = axis;
      if (pending !== null) this.setAxis(axis, pending);
      this.grabVal = this.comp(axis);
      this.grabFrom.copy(this.gizmoAt());
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.grabFrom, ax.dir);
      // The box now speaks for this axis. Taking hold of the arrow is as
      // deliberate a statement of the value as typing one (planeOffsetTool).
      this.dim.unlock("move");
      this.dim.updateFromCursor({ move: this.comp(axis) });
      // ...so the keys typed next go to it. The preventDefault above keeps
      // focus where it was, which after typing in the panel is a panel row: a
      // 7 typed for the arrow just dragged landed in Rotate Z as 907.
      this.dim.focus();
      this.viewport.domElement.style.cursor = "grabbing";
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grabAxis >= 0) {
      this.grabAxis = -1;
      this.viewport.domElement.style.cursor = this.hoverAxis >= 0 ? "grab" : "default";
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    // a clean click in empty space (not on an arrow) commits, or with nothing
    // to commit closes the tool
    if (!moved && this.hitAxis(e.clientX, e.clientY) < 0) this.commit(true);
  }

  private onKey(e: KeyboardEvent) {
    if (isImeComposing(e)) return; // Escape cancels an IME conversion, not the move
    // The panel's own fields and buttons: Enter is OK, except on a focused
    // Cancel, whose own Enter means cancel. Every other key in a field is the
    // field's (it reads parameter names).
    if (this.panel.owns(e.target)) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      } else if (e.key === "Enter" && e.target !== this.panel.cancelButton) {
        e.preventDefault();
        e.stopPropagation();
        this.commit();
      }
      return;
    }
    if (e.key === "Escape") this.cancel();
  }

  /** A keystroke in the box at the cursor: it is the axis last dragged. With
   *  no axis yet the value waits for an arrow (onDown). */
  private onDimInput() {
    const v = this.dim.getValue("move");
    this.dim.markInvalid("move", v === null && this.dim.getRaw("move").trim() !== "");
    if (v === null || this.lastAxis < 0 || !this.dim.isUserDriven("move")) return;
    this.setAxis(this.lastAxis, v);
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    const pos = this.gizmoAt();
    const k = this.viewport.pixelWorldSize(pos);
    this.gizmo.position.copy(pos);
    this.gizmo.scale.setScalar(k);
    for (const a of this.arrows) {
      const hot = a.axis === this.grabAxis || (this.grabAxis < 0 && a.axis === this.hoverAxis);
      const ax = AXES[a.axis];
      if (ax) a.mat.color.set(hot ? HOT : ax.color);
    }
    const s = this.viewport.projectToScreen(pos);
    this.dim.position(s.x, s.y);
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** Instant ghost: move the bodies' mesh + edges in place (no sidecar round
   *  trip, so the drag is snappy). The real `move` is committed on OK. */
  private refreshPreview() {
    this.viewport.setBodyMoveTransform(this.matrix());
  }

  // --- the panel ------------------------------------------------------------

  private showPanel() {
    const num = (id: string, label: string, field: "length" | "angle") =>
      ({ kind: "number", id, label: t(label), field }) as const;
    this.panel.show(
      t("tool.move"),
      [
        num("dx", "inspector.field.moveX", "length"),
        num("dy", "inspector.field.moveY", "length"),
        num("dz", "inspector.field.moveZ", "length"),
        num("rx", "inspector.field.rotateX", "angle"),
        num("ry", "inspector.field.rotateY", "angle"),
        num("rz", "inspector.field.rotateZ", "angle"),
        {
          kind: "choice", id: "pivot", label: t("feature.move.panel.pivot"),
          options: [
            { value: "centre", label: t("feature.move.panel.pivotCentre"), title: t("feature.move.panel.pivotCentreTitle") },
            { value: "origin", label: t("feature.move.panel.pivotOrigin"), title: t("feature.move.panel.pivotOriginTitle") },
          ],
        },
      ],
      {
        onNumber: (id, v, raw) => this.onPanelNumber(id, v, raw),
        onChoice: (_id, v) => {
          this.pivot = v === "origin" ? "origin" : "centre";
          this.refreshPreview();
          this.syncPanel();
        },
        onOk: () => this.commit(),
        onCancel: () => this.cancel(),
      },
    );
    MOVE_ROWS.forEach((id, i) => this.panel.setNumber(id, this.comp(i)));
    TURN_ROWS.forEach((id, i) => this.panel.setNumber(id, this.r[i] ?? 0));
    this.syncPanel();
  }

  private onPanelNumber(id: string, v: number | null, raw: string) {
    if (v === null && raw !== "") return; // the row shows red, and OK refuses it
    const value = v ?? 0; // a cleared row is no move on that axis
    const i = (MOVE_ROWS as readonly string[]).indexOf(id);
    const j = (TURN_ROWS as readonly string[]).indexOf(id);
    if (i >= 0) {
      this.t.setComponent(i, value);
      // the box at the cursor follows its axis, held to the typed number
      if (i === this.lastAxis) this.dim.seed("move", value);
    } else if (j >= 0) {
      this.r[j] = value;
    }
    // A distance typed at the cursor before any arrow was taken has no axis;
    // the panel is the user saying where it goes, so it no longer waits.
    if (this.lastAxis < 0 && this.dim.isUserDriven("move")) {
      this.dim.unlock("move");
      this.dim.updateFromCursor({ move: 0 });
    }
    this.refreshPreview();
    this.syncPanel();
  }

  private syncPanel(warning: string | null = null) {
    this.panel.setChoice("pivot", this.pivot); // "saved" lights neither chip
    const p = this.savedPivot;
    const note =
      this.pivot === "saved" && p
        ? t("feature.move.panel.savedPivot", { x: fmtLength(p.x), y: fmtLength(p.y), z: fmtLength(p.z) })
        : null;
    this.panel.setWarning(warning ?? note);
  }

  private buildFeature(): MoveFeature {
    // A value an edit did not change is written back exactly as it was saved.
    const saved = this.editSaved;
    const keep = (now: number, was: unknown) => (now === was ? now : clean(now));
    const moved = {
      dx: keep(this.t.x, saved?.dx),
      dy: keep(this.t.y, saved?.dy),
      dz: keep(this.t.z, saved?.dz),
      rx: keep(this.r[0], saved?.rx),
      ry: keep(this.r[1], saved?.ry),
      rz: keep(this.r[2], saved?.rz),
    };
    // An edit keeps everything else the move holds (its bodies, a name) where
    // it was; a new one is written fresh.
    const f: MoveFeature = saved
      ? { ...saved, ...moved }
      : { id: this.previewId, type: "move", ...moved, ...(this.bodies.length ? { bodies: this.bodies } : {}) };
    if (this.pivot === "centre") f.pivot = [this.centre.x, this.centre.y, this.centre.z];
    else if (this.pivot === "origin") delete f.pivot;
    // "saved": the pivot the move was saved with stays, as it was saved
    return f;
  }

  private buildGizmo() {
    const g = new THREE.Group();
    for (let i = 0; i < AXES.length; i++) {
      const a = AXES[i];
      if (!a) continue;
      const mat = new THREE.MeshBasicMaterial({ color: a.color, depthTest: false, depthWrite: false });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 30, 12), mat);
      shaft.position.y = 17;
      const head = new THREE.Mesh(new THREE.ConeGeometry(4.5, 12, 18), mat);
      head.position.y = 30 + 6;
      const arrow = new THREE.Group();
      arrow.add(shaft, head);
      arrow.quaternion.setFromUnitVectors(Y_AXIS, a.dir);
      arrow.renderOrder = 999;
      shaft.renderOrder = 999;
      head.renderOrder = 999;
      arrow.userData.axis = i;
      g.add(arrow);
      this.arrows.push({ group: arrow, mat, axis: i });
    }
    g.renderOrder = 999;
    this.gizmo = g;
    this.viewport.addToScene(g);
  }

  private hitAxis(x: number, y: number): number {
    if (!this.gizmo) return -1;
    const meshes: THREE.Object3D[] = [];
    for (const a of this.arrows) meshes.push(...a.group.children);
    const hits = this.viewport.rayFrom(x, y).intersectObjects(meshes, false);
    if (!hits.length) return -1;
    const first = hits[0];
    if (!first) return -1;
    let o: THREE.Object3D | null = first.object;
    while (o && o.userData.axis === undefined) o = o.parent;
    return o ? (o.userData.axis as number) : -1;
  }

  /** `clickAway`: reached by a clean click in empty canvas rather than Enter or
   *  OK. */
  private commit(clickAway = false) {
    if (!this.active || this.awaitingRollback) return;
    // A row holding text the app cannot read is refused, never replaced by
    // the last value it could read. Checked BEFORE the box at the cursor is
    // read below: that box holds the last good value for its axis, and writing
    // it into the row would wipe the typo out of sight and commit the old number.
    if ([...MOVE_ROWS, ...TURN_ROWS].some((k) => this.panel.numberUnreadable(k))) {
      this.syncPanel(t("feature.badNumber"));
      setPrompt(t("feature.badNumber"));
      return;
    }
    if (this.grabAxis < 0 && this.dim.isUserDriven("move")) {
      const v = this.dim.getValue("move");
      if (v == null) {
        // unparseable text: committing the last good value instead would be a
        // silent wrong-number surprise
        setPrompt(t("feature.badNumber"));
        return;
      }
      if (this.lastAxis < 0) {
        // A distance typed before any arrow was touched has no direction. It
        // used to be dropped and the tool closed with nothing said, although
        // the prompt invites typing a value. Keep it; clicking an arrow gives it
        // the direction (onDown applies it to that axis).
        if (Math.abs(v) > 1e-9) {
          setPrompt(t("feature.move.pickAxis"));
          return;
        }
      } else {
        this.setAxis(this.lastAxis, v); // typed sign wins
      }
    }
    const feature = this.buildFeature();
    const still = [...MOVE_ROWS, ...TURN_ROWS].every((k) => feature[k] === 0);
    if (still) {
      // A click away from an untouched gizmo has always meant "never mind", and
      // there is nothing to lose. An Enter or OK is a request to commit: closing
      // on it silently read as "nothing happened", so stay and say why. An edit
      // is never thrown away by a click: the saved move is still there.
      if (clickAway && !this.editId) return this.cancel();
      this.syncPanel(t("feature.move.panel.nothingMoved"));
      setPrompt(t("feature.move.nothingToCommit"));
      return;
    }
    this.viewport.endBodyMoveGhost(false); // keep the ghost in place; the rebuild replaces it
    if (this.editId) {
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(this.editId, feature);
    } else {
      this.store.addFeature(feature);
    }
    const done = this.onDone;
    this.cleanup();
    done?.(feature.id);
  }

  cancel() {
    this.viewport.endBodyMoveGhost(true); // restore the mesh to its un-moved position
    const editing = this.editId !== null;
    const done = this.onDone;
    this.cleanup();
    if (editing) this.store.endEditPreview();
    done?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.viewport.endBodyMoveGhost(false); // no-op if commit/cancel already ended it
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    this.unsubBuild?.();
    this.unsubBuild = null;
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    this.panel.hide();
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      for (const a of this.arrows) {
        for (const c of a.group.children) if (c instanceof THREE.Mesh) c.geometry.dispose();
        a.mat.dispose();
      }
      this.gizmo = null;
      this.arrows = [];
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabAxis = -1;
    this.hoverAxis = -1;
    this.lastAxis = -1;
    this.t.set(0, 0, 0);
    this.r = [0, 0, 0];
    this.editId = null;
    this.editSaved = null;
    this.savedPivot = null;
    this.awaitingRollback = false;
    this.onDone = null;
    setPrompt(null);
  }
}
