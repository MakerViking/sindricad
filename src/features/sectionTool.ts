// Section analysis (Inspect): a draggable clipping plane that cuts the model so
// you can see inside. Pick an axis, drag the arrow to move the cut, F flips which
// half is kept, Esc closes (restores the full model). Uncapped (shows the hollow
// interior) — a filled cap is a later refinement. The clip is a view state, not a
// feature; it clears on the next rebuild.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const AXES: Record<string, THREE.Vector3> = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
};
const IDLE = 0x6fc3ff;
const HOT = 0xffe9a8;

export class SectionTool {
  active = false;
  private plane = new THREE.Plane();
  private axis = new THREE.Vector3(0, 0, 1);
  private anchor = new THREE.Vector3(); // model box center
  private offset = 0;
  private side = 1; // which half to keep (F flips)
  private gizmo: THREE.Group | null = null;
  private gizmoMat: THREE.MeshBasicMaterial | null = null;
  private hovering = false;
  private grabbing = false;
  private grabOffset = 0;
  private grabProj = 0;
  private raf = 0;
  private onDone: (() => void) | null = null;

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
  }

  start(axisName: "X" | "Y" | "Z", onDone?: () => void) {
    if (this.active) return;
    const box = this.viewport.modelBox();
    if (!box) return;
    this.active = true;
    this.onDone = onDone ?? null;
    const ax = AXES[axisName];
    if (ax) this.axis.copy(ax);
    box.getCenter(this.anchor);
    this.offset = 0;
    this.side = 1;
    this.updatePlane();
    this.viewport.setClipPlane(this.plane);
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);
    this.buildGizmo();
    this.dim.show(
      [{ name: "offset", label: "Offset", kind: "length" }],
      () => this.applyTypedOffset(),
      () => this.stop(),
    );
    const s = this.viewport.projectToScreen(this.center());
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ offset: Math.abs(this.offset) });
    setPrompt(
      "Section: drag the arrow to move the cut · type a value + Enter · F flips the kept side · Esc to close",
    );
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** Enter in the field (or the on-screen check button) sets the exact offset.
   *  GATED on isUserDriven: Enter after a pure drag would read back the
   *  |value| the display shows and strip a negative offset's sign (the
   *  abs-display trap). A typed value is the truth as-is, sign included. */
  private applyTypedOffset() {
    if (!this.dim.isUserDriven("offset")) return; // drag value already applied live
    const v = this.dim.getValue("offset");
    if (v == null) return;
    this.offset = v;
    this.updatePlane();
  }

  private center(): THREE.Vector3 {
    return this.anchor.clone().addScaledVector(this.axis, this.offset);
  }

  private updatePlane() {
    const n = this.axis.clone().multiplyScalar(this.side);
    this.plane.setFromNormalAndCoplanarPoint(n, this.center());
  }

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      const raw = this.grabOffset + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.center()));
      if (stepped === this.offset) return;
      this.offset = stepped;
      this.updatePlane();
      this.dim.updateFromCursor({ offset: Math.abs(this.offset) });
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
      this.grabOffset = this.offset;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button === 0) this.grabbing = false;
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.stop();
    else if (e.key === "f" || e.key === "F") {
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
    const s = this.viewport.projectToScreen(c);
    this.dim.position(s.x, s.y);
    if (!this.grabbing && this.dim.isUserDriven("offset")) {
      const v = this.dim.getValue("offset");
      // typed sign wins; only read back through isUserDriven (never the |value| shown)
      if (v != null && Math.abs(v - this.offset) > 1e-6) {
        this.offset = v;
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

  stop() {
    if (!this.active) return;
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    this.viewport.setClipPlane(null);
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
}
