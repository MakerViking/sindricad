// Interactive Offset Plane: after picking a source plane/face, drag an arrow
// along its normal (or type a value) to set the offset distance, with a live
// translucent ghost of the resulting plane. Commit (click / Enter) returns the
// offset PlaneDef so the caller can sketch on it. Mirrors the fillet/press-pull
// gizmo pattern (constant-screen arrow grabbed + dragged, value snapped to the
// zoom-aware clean step via viewport.snapStep).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { PlaneDef } from "../types";
import type { SketchPlane } from "../sketch/plane";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { distanceAlongAxis } from "./manipulator";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HANDLE_IDLE = 0xffc83d; // amber
const HANDLE_HOT = 0xffe9a8;

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

  private dim = new DimInput();
  private onDone: ((def: PlaneDef | null) => void) | null = null;

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
  }

  start(src: SketchPlane, onDone: (def: PlaneDef | null) => void) {
    if (this.active) return;
    this.active = true;
    this.onDone = onDone;
    this.anchor.copy(src.origin);
    this.axis.copy(src.n).normalize();
    this.u.copy(src.u).normalize();
    this.value = 0;
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    this.buildGizmo();
    this.buildGhost();
    this.dim.show([{ name: "offset", label: "Offset", kind: "length" }], () => this.commit());
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ offset: 0 });
    setPrompt(
      "Drag the arrow to set the offset · type a value · Enter to sketch on the plane · Esc to cancel",
    );
    this.raf = requestAnimationFrame(this.boundTick);
    this.updateGhost();
  }

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      const ray = this.viewport.rayFrom(e.clientX, e.clientY).ray;
      const proj = distanceAlongAxis(ray, this.anchor, this.axis);
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
      this.grabProj = distanceAlongAxis(this.viewport.rayFrom(e.clientX, e.clientY).ray, this.anchor, this.axis);
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
    const k = this.viewport.pixelWorldSize(this.anchor);
    this.gizmo.position.copy(this.anchor);
    this.gizmo.quaternion.copy(this.quat);
    this.gizmo.scale.setScalar(k);
    this.gizmoMat?.color.set(this.hovering || this.grabbing ? HANDLE_HOT : HANDLE_IDLE);
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    if (!this.grabbing && this.dim.isUserDriven("offset")) {
      const v = this.dim.getValue("offset");
      if (v != null) {
        const signed = Math.sign(this.value || 1) * Math.abs(v);
        if (Math.abs(signed - this.value) > 1e-6) {
          this.value = signed;
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

  private updateGhost() {
    if (!this.ghost) return;
    this.ghost.position.copy(this.anchor).addScaledVector(this.axis, this.value);
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
    if (v != null) this.value = Math.sign(this.value || 1) * Math.abs(v);
    const o = this.anchor.clone().addScaledVector(this.axis, this.value);
    const def: PlaneDef = {
      origin: [o.x, o.y, o.z],
      normal: [this.axis.x, this.axis.y, this.axis.z],
      xdir: [this.u.x, this.u.y, this.u.z],
    };
    const done = this.onDone;
    this.cleanup();
    done?.(def);
  }

  cancel() {
    const done = this.onDone;
    this.cleanup();
    done?.(null);
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
    setPrompt(null);
  }
}
