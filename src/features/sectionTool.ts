// Section analysis (Inspect): a draggable clipping plane that cuts the model so
// you can see inside. Pick an axis, drag the arrow to move the cut, F flips which
// half is kept, Esc closes (restores the full model). Capped: each cut body
// shows a solid face in its own colour, darkened (viewport/sectionCaps.ts), on
// the persistent cut too, since the viewport draws the caps from its plane.
//
// The box reads where the cut IS along the axis, measured from the origin plane
// across it (x for an X cut), not an offset from the model's middle: "it placed
// the section in the middle of the solid and called the offset 0... perhaps it
// should show the distance the section plane is from the X or Y or Z plane"
// (983f5f56). Dragging moves that number, typing one puts the cut there.
//
// The clip is a view state rather than a feature, but it is a PERSISTENT one:
// the viewport owns the plane and re-applies it after every rebuild, and
// starting another tool takes this gizmo down via stop(true) while leaving the
// cut on screen. That is what lets you sketch inside a section (#17). The check
// button (or Enter) does the same: done with the arrow, keep the cut. A kept
// cut shows a chip in the viewport's corner ("Section X 12 mm") whose × takes
// it away, because a check that left the cut with no trace of how to undo it
// "looked like it did nothing" (1a28cd21). Esc while the gizmo is up, the chip's
// ×, Esc with nothing else to let go of, or Inspect ▸ Section again put the
// model back.
//
// The tool also remembers the last cut (axis, where along it, which half) for
// as long as the document stays open, so reopening on the same axis puts the
// cut back where you left it (field reports 5effc008, 724df0f3). Both the cut
// and that memory belong to ONE document: documentReplaced() drops them on
// New, Open, Close and Recover (f36c1c7a).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { fmtLength, onUnitChange, snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import { HANDLE_HOT as HOT } from "../viewport/colors3d";
import { setText, setTitle, t } from "../i18n";
import { isImeComposing } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
export type SectionAxis = "X" | "Y" | "Z";
const AXES: Record<SectionAxis, THREE.Vector3> = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
};
/** The axis chooser's order when there is no last cut: Z (a horizontal cut)
 *  is the default, so it goes first. */
const AXIS_ORDER: SectionAxis[] = ["Z", "X", "Y"];
const IDLE = 0x6fc3ff;
/** Screen gap between the model and the offset box beside it. */
const BOX_GAP = 16;

interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Top-left corner for the offset box: BESIDE the model on screen, never on it.
 *
 *  The box used to follow the plane's centre (+16 px), and the plane's centre is
 *  the middle of the cut, the one spot a section exists to show: "the onscreen
 *  dimension and tickboxes cover a lot of detail of the section" (5effc008).
 *  Right of the model's projected box first, left of it if that runs off the
 *  canvas, and only when the model fills the view either way is it pinned to the
 *  canvas's right edge, where covering something cannot be helped. Vertically it
 *  stays level with the arrow, so the number still reads as the arrow's. */
export function besideModel(
  model: ScreenRect,
  arrowY: number,
  box: { width: number; height: number },
  view: ScreenRect,
): { x: number; y: number } {
  const right = model.right + BOX_GAP;
  const left = model.left - BOX_GAP - box.width;
  let x: number;
  if (right + box.width <= view.right) x = right;
  else if (left >= view.left) x = left;
  else x = view.right - box.width;
  const y = Math.min(Math.max(arrowY - box.height / 2, view.top), view.bottom - box.height);
  return { x: Math.max(x, view.left), y };
}

export class SectionTool {
  active = false;
  private plane = new THREE.Plane();
  private axis = new THREE.Vector3(0, 0, 1);
  private anchor = new THREE.Vector3(); // model box center: where the arrow sits across the axis
  /** Where the cut is ALONG the axis, from the origin: what the box shows. */
  private at = 0;
  private side = 1; // which half to keep (F flips)
  private gizmo: THREE.Group | null = null;
  private gizmoMat: THREE.MeshBasicMaterial | null = null;
  private hovering = false;
  private grabbing = false;
  private grabAt = 0;
  private grabProj = 0;
  private raf = 0;
  private onDone: (() => void) | null = null;
  private axisName: SectionAxis = "Z";
  /** The last cut this document, kept across close and reopen. `at` is the
   *  plane's ABSOLUTE position along the axis rather than an offset from the
   *  model's centre, so an edit that grows the model does not move the cut. */
  private last: { axis: SectionAxis; at: number; side: number } | null = null;
  /** The kept cut's chip, built the first time a cut is kept. */
  private chip: { root: HTMLDivElement; label: HTMLSpanElement } | null = null;
  /** The chip is explained once a session, the first time a cut is kept. */
  private toldKept = false;

  private dim = new DimInput();

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundTick: () => void;

  constructor(private viewport: Viewport) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundKey = (e) => this.onKey(e);
    this.boundTick = () => this.tick();
    onUnitChange(() => this.labelChip());
  }

  /** True while a cut is on screen with the arrow put away: the chip is up. */
  get kept(): boolean {
    return !this.active && this.viewport.clipped;
  }

  /** Take a kept cut away and put the model back together: the chip's ×, Esc
   *  with nothing else to let go of, Inspect ▸ Section again (main.ts). */
  clear() {
    if (this.active) {
      this.stop();
      return;
    }
    this.viewport.setClipPlane(null);
    this.showChip(false);
  }

  /** The axis chooser's order: the last cut's axis first, because choose()
   *  focuses its first option and one Enter should put the last cut back. */
  axisOrder(): SectionAxis[] {
    const last = this.last?.axis;
    return last ? [last, ...AXIS_ORDER.filter((a) => a !== last)] : [...AXIS_ORDER];
  }

  /** The document was replaced (New, Open, Close, the recent list, Recover).
   *  The cut, its arrow and the remembered position all described the OLD
   *  model: left in place, the arrow stayed live over an empty document and the
   *  plane, anchored on the old model, cut the next one (f36c1c7a). */
  documentReplaced() {
    if (this.active) this.stop();
    else if (this.viewport.clipped) this.viewport.setClipPlane(null);
    this.showChip(false);
    this.last = null;
  }

  start(axisName: SectionAxis, onDone?: () => void) {
    if (this.active) return;
    const box = this.viewport.modelBox();
    if (!box) return;
    this.active = true;
    this.showChip(false); // the box and its buttons speak for the cut now
    this.onDone = onDone ?? null;
    this.axisName = axisName;
    this.axis.copy(AXES[axisName]);
    box.getCenter(this.anchor);
    // Same axis as the last cut: put it back. Only while it still falls inside
    // the model, though: an edit since then can leave it beyond the end, where
    // it cuts nothing, or everything, and the model just vanishes. Otherwise
    // the cut starts through the model's middle, as it always did.
    const last = this.last?.axis === axisName ? this.last : null;
    const inside = !!last && last.at >= box.min.dot(this.axis) && last.at <= box.max.dot(this.axis);
    this.at = last && inside ? last.at : this.anchor.dot(this.axis);
    this.side = last && inside ? last.side : 1;
    this.updatePlane();
    this.viewport.setClipPlane(this.plane);
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);
    this.buildGizmo();
    // Labelled with the axis: the number is that coordinate of the cut. Signed,
    // unlike the offset it replaced (shown as |value|): a cut below the origin
    // reads -12, and the field reads back what it shows.
    this.dim.show([{ name: "at", label: axisName, kind: "length" }], () => this.keep(), () => this.stop());
    this.placeBox();
    // A cursor value, never seed(): seeding marks the field user-driven, and
    // tick() would then hold the cut at it against the arrow.
    this.dim.updateFromCursor({ at: this.at });
    setPrompt(t("feature.section.prompt", { axis: axisName }));
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** The check button, or Enter: done with the arrow, the cut STAYS (stop(true)).
   *  A typed value goes in first; text that cannot be read keeps the tool open,
   *  marked, rather than keeping a cut somewhere the user did not ask for. It
   *  used to only apply a typed value and otherwise do nothing at all, so a
   *  check after a drag "looked like it did nothing" (1a28cd21).
   *  Gated on isUserDriven: after a drag the cut is already where it goes. */
  private keep() {
    if (this.dim.isUserDriven("at")) {
      const v = this.dim.getValue("at");
      if (v == null) {
        this.dim.markInvalid("at", true);
        return;
      }
      this.at = v;
      this.updatePlane();
    }
    this.stop(true);
  }

  private center(): THREE.Vector3 {
    return this.anchor.clone().addScaledVector(this.axis, this.at - this.anchor.dot(this.axis));
  }

  private updatePlane() {
    const n = this.axis.clone().multiplyScalar(this.side);
    this.plane.setFromNormalAndCoplanarPoint(n, this.center());
    // The plane is moved in place, which the viewport cannot see. Without this
    // a flip (F) or a typed offset did not show until the mouse next moved:
    // only a pointermove over the canvas asks for a frame.
    this.viewport.requestRender();
  }

  /** Put the offset box beside the model (see besideModel). */
  private placeBox() {
    const arrow = this.viewport.projectToScreen(this.center());
    const box = this.viewport.modelBox();
    if (!box) {
      this.dim.position(arrow.x, arrow.y);
      return;
    }
    const model = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      const p = this.viewport.projectToScreen(corner);
      model.left = Math.min(model.left, p.x);
      model.right = Math.max(model.right, p.x);
      model.top = Math.min(model.top, p.y);
      model.bottom = Math.max(model.bottom, p.y);
    }
    const at = besideModel(model, arrow.y, this.dim.size, this.viewport.domElement.getBoundingClientRect());
    this.dim.placeAt(at.x, at.y);
  }

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      // snapped from the ORIGIN, so a drag reads round numbers in the box
      const at = snap(this.grabAt + (proj - this.grabProj), this.viewport.snapStep(this.center()));
      if (at === this.at) return;
      this.at = at;
      this.updatePlane();
      this.dim.updateFromCursor({ at });
      return;
    }
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.hitGizmo(e.clientX, e.clientY)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.grabbing = true;
      this.grabAt = this.at;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      // Taking hold of the arrow is as deliberate as typing: the box follows the
      // drag again. Without it a typed value froze the box, and tick() pulled
      // the cut back to that value the moment the arrow was let go.
      this.dim.unlock("at");
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button === 0) this.grabbing = false;
  }

  private onKey(e: KeyboardEvent) {
    if (isImeComposing(e)) return; // Escape cancels an IME conversion, not the tool
    if (e.key === "Escape") this.stop();
    else if (e.key === "f" || e.key === "F") {
      // Same as extrude's T: the offset box holds focus, so an unswallowed "f"
      // would also be typed into a field that stays on screen (88c9bdf0).
      if (!this.dim.claimToolHotkey(e)) return;
      this.side *= -1;
      this.updatePlane();
    }
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    const c = this.center();
    const k = this.viewport.pixelWorldSize(c);
    this.gizmo.position.copy(c);
    this.gizmo.quaternion.setFromUnitVectors(Y_AXIS, this.axis.clone().multiplyScalar(this.side));
    this.gizmo.scale.setScalar(k);
    this.gizmoMat?.color.set(this.hovering || this.grabbing ? HOT : IDLE);
    this.placeBox();
    if (!this.grabbing && this.dim.isUserDriven("at")) {
      // typing moves the cut as you type; a drag's value is never read back
      const v = this.dim.getValue("at");
      if (v != null && Math.abs(v - this.at) > 1e-6) {
        this.at = v;
        this.updatePlane();
      }
    }
    this.raf = requestAnimationFrame(this.boundTick);
  }

  private buildGizmo() {
    const mat = new THREE.MeshBasicMaterial({ color: IDLE, depthTest: false, depthWrite: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 34, 12), mat);
    shaft.position.y = 6 + 17;
    const head = new THREE.Mesh(new THREE.ConeGeometry(5, 13, 18), mat);
    head.position.y = 6 + 34 + 6.5;
    const g = new THREE.Group();
    g.add(shaft, head);
    g.renderOrder = 999;
    shaft.renderOrder = 999;
    head.renderOrder = 999;
    this.gizmoMat = mat;
    this.gizmo = g;
    this.viewport.addToScene(g);
  }

  private hitGizmo(x: number, y: number): boolean {
    if (!this.gizmo) return false;
    return this.viewport.rayFrom(x, y).intersectObjects(this.gizmo.children, false).length > 0;
  }

  /** Close the tool.
   *
   *  `keepClip` leaves the CUT on screen and only takes down the gizmo and the
   *  key/pointer handlers — a "persistent section", which is what makes
   *  sketching inside a section possible (field report #17: "Allow sketch
   *  creation while in a section cut. Perhaps a persistent section"). The
   *  viewport owns the plane and re-applies it across rebuilds, so the cut
   *  survives committing the sketch.
   *
   *  Esc still clears the cut outright: an invisible clip you cannot get rid of
   *  would be worse than no feature at all. That is also why a kept cut shows
   *  its chip, with the × that takes it away. */
  stop(keepClip = false) {
    if (!this.active) return;
    this.last = { axis: this.axisName, at: this.at, side: this.side };
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    if (!keepClip) this.viewport.setClipPlane(null);
    else this.showChip(true);
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      for (const c of this.gizmo.children) if (c instanceof THREE.Mesh) c.geometry.dispose();
      this.gizmoMat?.dispose();
      this.gizmo = null;
      this.gizmoMat = null;
    }
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    setPrompt(null);
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  /** Show or hide the kept cut's chip. The first time a cut is kept, say once
   *  that it stays until removed, and how. */
  private showChip(on: boolean) {
    if (!on) {
      if (this.chip) this.chip.root.style.display = "none";
      return;
    }
    const chip = (this.chip ??= this.buildChip());
    this.labelChip();
    chip.root.style.display = "";
    if (!this.toldKept) {
      this.toldKept = true;
      toast(t("feature.section.keptHint"), { timeout: 10000 });
    }
  }

  /** "Section X 12 mm": the kept cut's axis and where it is, in the display unit. */
  private labelChip() {
    const last = this.last;
    if (!this.chip || !last) return;
    setText(this.chip.label, "feature.section.chip", { axis: last.axis, at: fmtLength(last.at) });
  }

  /** Top left of the viewport, the corner nothing else uses: the ViewCube and
   *  the tool panels are top right, the view buttons and frame readout below. */
  private buildChip(): { root: HTMLDivElement; label: HTMLSpanElement } {
    const root = document.createElement("div");
    root.className = "section-chip";
    const glyph = document.createElement("span");
    glyph.className = "section-chip-icon";
    glyph.innerHTML = icon("section");
    const label = document.createElement("span");
    label.className = "section-chip-label";
    const remove = document.createElement("button");
    remove.className = "section-chip-remove";
    setTitle(remove, "feature.section.remove");
    remove.setAttribute("aria-label", t("feature.section.remove"));
    remove.innerHTML = icon("close");
    remove.addEventListener("click", () => this.clear());
    root.append(glyph, label, remove);
    (this.viewport.domElement.parentElement ?? document.body).appendChild(root);
    return { root, label };
  }
}
