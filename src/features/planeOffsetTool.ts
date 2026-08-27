// Interactive Offset Plane: after picking a source plane/face, drag an arrow
// along its normal (or type a value) to set the offset distance, with a live
// translucent ghost of the resulting plane. Commit (click / Enter) returns the
// offset PlaneDef so the caller can sketch on it. Mirrors the fillet/press-pull
// gizmo pattern (constant-screen arrow grabbed + dragged, value snapped to the
// zoom-aware clean step via viewport.snapStep).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { PlaneDef } from "../types";
import type { DocumentStore } from "../document/store";
import { SketchPlane } from "../sketch/plane";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import { HANDLE_IDLE, HANDLE_HOT } from "../viewport/colors3d";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class PlaneOffsetTool {
  active = false;
  private anchor = new THREE.Vector3(); // source plane origin
  private axis = new THREE.Vector3(0, 0, 1); // source plane normal (drag axis)
  private u = new THREE.Vector3(1, 0, 0); // source plane x-dir (carried to the offset plane)
  private quat = new THREE.Quaternion();
  private value = 0; // offset distance in mm (signed)

  private gizmo: THREE.Group | null = null;
  private gizmoMat: THREE.MeshBasicMaterial | null = null;
  private ghost: THREE.Mesh | null = null;
  private hovering = false;
  private grabbing = false;
  private grabValue = 0;
  private grabProj = 0;
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;
  private raf = 0;
  /** reused per frame — tick() runs every frame and must not allocate */
  private scratch = new THREE.Vector3();

  private dim = new DimInput();
  /** create mode: hand back the resulting plane so the caller can sketch on it */
  private onDone: ((def: PlaneDef | null) => void) | null = null;
  /** edit mode: the datumPlane feature being re-opened, and its completion */
  private editId: string | null = null;
  private onEditDone: ((id: string | null) => void) | null = null;

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

  /** Everything both entry points do: seat the drag axis on `src`, put the arrow
   *  and the ghost quad up, and open the numeric field at `offset`. */
  private begin(src: SketchPlane, offset: number) {
    this.active = true;
    this.anchor.copy(src.origin);
    this.axis.copy(src.n).normalize();
    this.u.copy(src.u).normalize();
    this.value = offset;
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    this.buildGizmo();
    this.buildGhost();
    this.dim.show([{ name: "offset", label: "Offset", kind: "length" }], () => this.commit(), () => this.cancel());
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.raf = requestAnimationFrame(this.boundTick);
    this.updateGhost();
  }

  start(src: SketchPlane, onDone: (def: PlaneDef | null) => void) {
    if (this.active) return;
    this.onDone = onDone;
    this.begin(src, 0);
    this.dim.updateFromCursor({ offset: 0 });
    setPrompt(
      "Drag the arrow to set the offset · type a value · Enter to sketch on the plane · Esc to cancel",
    );
  }

  /** Re-open a committed offset plane so it can be MOVED.
   *
   *  There was no way to move one at all: `editFeature` had no datumPlane arm,
   *  this tool was creation-only, and Move takes bodies. So a user who built on
   *  an offset plane and then wanted to shift it had nothing to grab — which is
   *  what "press/pull to an offset plane, then move the offset plane and expect
   *  the surface to move with the offset plane... does not visibly do this"
   *  actually describes (field report df10c0b3). The parametric link was never
   *  broken; measured on the builder, a datum at offset 20/30/40 gives body
   *  volumes 40000/56000/72000 mm³. The plane simply never moved.
   *
   *  Returns false when this feature can't be tool-edited — an offset driven by
   *  a parameter belongs to the inspector, exactly as for fillet/chamfer — and
   *  the caller falls back to it.
   *
   *  The drag moves the GHOST only; the offset lands in the document on commit
   *  and the ordinary full rebuild carries every downstream feature with it. A
   *  live downstream preview would need a no-undo commit path per drag step and
   *  is deliberately not built here. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "datumPlane") return false;
    if (this.store.isParamBound({ kind: "feature", feature: f.id, field: "offset" })) return false;

    this.editId = featureId;
    this.onEditDone = onDone;
    const offset = typeof f.offset === "number" ? f.offset : 0;
    this.begin(new SketchPlane(f.plane), offset);
    // Seed rather than track: the saved offset must hold until the user
    // deliberately drags the handle or retypes, or the first pointer move would
    // wipe the value they came here to adjust.
    this.dim.seed("offset", offset);
    setPrompt(
      "Drag the arrow to move this plane · type a value · Enter to apply · Esc to cancel",
    );
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      const raw = this.grabValue + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.anchor));
      if (stepped === this.value) return;
      this.value = stepped;
      this.dim.updateFromCursor({ offset: Math.abs(this.value) });
      this.updateGhost();
      return;
    }
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.grabbing = true;
      this.grabValue = this.value;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      // Grabbing the handle is as deliberate a statement of the value as typing
      // one, so hand the box back to cursor tracking — otherwise it sits frozen
      // at the typed or seeded figure while the geometry moves under it, and the
      // arrow "does not display in the input field the distance manually pushed
      // or pulled ... which makes the arrow effectively useless" (field report
      // 215db097). Typing re-locks it on the next keystroke.
      this.dim.unlock("offset");
      this.viewport.domElement.style.cursor = "grabbing";
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (!this.downOnGizmo && !moved) this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    const sign = this.value < 0 ? -1 : 1;
    const dir = this.axis.clone().multiplyScalar(sign);
    this.quat.setFromUnitVectors(Y_AXIS, dir);
    // The handle rides the PLANE, not the origin it is measured from. Anchoring
    // it at the source left the arrow sitting back at the parent face while the
    // ghost floated 60 mm away — you were dragging a handle nowhere near the
    // thing that moved. Scale and the numeric box follow it for the same reason:
    // a constant-screen-size gizmo has to be measured where it is drawn.
    const at = this.planePoint(this.scratch);
    const k = this.viewport.pixelWorldSize(at);
    this.gizmo.position.copy(at);
    this.gizmo.quaternion.copy(this.quat);
    this.gizmo.scale.setScalar(k);
    this.gizmoMat?.color.set(this.hovering || this.grabbing ? HANDLE_HOT : HANDLE_IDLE);
    const s = this.viewport.projectToScreen(at);
    this.dim.position(s.x, s.y);
    if (!this.grabbing && this.dim.isUserDriven("offset")) {
      const v = this.dim.getValue("offset");
      if (v != null) {
        // the field is the truth: typed sign wins (the old code re-applied the
        // drag's sign onto |v|, so a typed negative offset went positive)
        if (Math.abs(v - this.value) > 1e-6) {
          this.value = v;
          this.updateGhost();
        }
      }
    }
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** translucent quad showing where the offset plane lands */
  private buildGhost() {
    const geo = new THREE.PlaneGeometry(60, 60);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd24a,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.axis);
    const m = new THREE.Mesh(geo, mat);
    m.quaternion.copy(q);
    m.renderOrder = 998;
    this.ghost = m;
    this.viewport.addToScene(m);
  }

  /** Where the plane currently sits: the source origin advanced along its own
   *  normal by the live offset. The ghost quad, the drag arrow and the numeric
   *  box all ride this, so the handle stays ON the thing it moves.
   *
   *  `anchor` stays the source origin on purpose — it is what the offset is
   *  measured FROM, and axisDragDistance projects onto the axis line through it,
   *  which is the same infinite line wherever the arrow is drawn. */
  private planePoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.anchor).addScaledVector(this.axis, this.value);
  }

  private updateGhost() {
    if (!this.ghost) return;
    this.ghost.position.copy(this.planePoint(this.scratch));
  }

  private buildGizmo() {
    const mat = new THREE.MeshBasicMaterial({ color: HANDLE_IDLE, depthTest: false, depthWrite: false });
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

  private commit() {
    if (!this.active) return;
    const v = this.dim.getValue("offset");
    // GATE on isUserDriven: while dragging the field displays |value|, so an
    // unguarded read-back flips a negative offset positive (abs-display trap).
    if (v != null && this.dim.isUserDriven("offset")) this.value = v;
    const offset = this.value;
    const o = this.anchor.clone().addScaledVector(this.axis, offset);
    const def: PlaneDef = {
      origin: [o.x, o.y, o.z],
      normal: [this.axis.x, this.axis.y, this.axis.z],
      xdir: [this.u.x, this.u.y, this.u.z],
    };
    const editId = this.editId;
    const editDone = this.onEditDone;
    const done = this.onDone;
    this.cleanup();
    if (editId) {
      // Patch the offset in place: same feature id, one undo step, and the
      // ordinary rebuild moves everything built on this plane with it.
      this.store.updateFeature(editId, { offset } as never);
      editDone?.(editId);
      return;
    }
    done?.(def);
  }

  cancel() {
    const editDone = this.onEditDone;
    const done = this.onDone;
    const editing = this.editId !== null;
    this.cleanup();
    if (editing) editDone?.(null);
    else done?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      for (const c of this.gizmo.children) if (c instanceof THREE.Mesh) c.geometry.dispose();
      this.gizmoMat?.dispose();
      this.gizmo = null;
      this.gizmoMat = null;
    }
    if (this.ghost) {
      this.viewport.removeFromScene(this.ghost);
      this.ghost.geometry.dispose();
      (this.ghost.material as THREE.Material).dispose();
      this.ghost = null;
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    this.value = 0;
    this.editId = null;
    this.onEditDone = null;
    this.onDone = null;
    setPrompt(null);
  }
}
