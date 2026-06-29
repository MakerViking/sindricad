// Interactive multi-body Move: a 3-axis arrow gizmo placed at the centroid of the
// selected bodies. Grab an axis arrow and drag to translate the bodies along it,
// with a LIVE sidecar preview (an un-committed `move` feature) — type a value for
// precision, click off the gizmo / Enter to commit, Esc to revert. Mirrors the
// PressPull / PlaneOffset gizmo pattern. Translation only; rotation is editable on
// the committed feature in the inspector (rx/ry/rz).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { distanceAlongAxis } from "./manipulator";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HOT = 0xffe9a8; // hovered / grabbed arrow
const AXES = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xff5a5a }, // X red
  { dir: new THREE.Vector3(0, 1, 0), color: 0x5ad15a }, // Y green
  { dir: new THREE.Vector3(0, 0, 1), color: 0x5a9bff }, // Z blue
];

export class MoveTool {
  active = false;
  private bodies: string[] = [];
  private anchor = new THREE.Vector3(); // gizmo origin (selection centroid), fixed
  private t = new THREE.Vector3(); // current translation
  private previewId = "";

  private gizmo: THREE.Group | null = null;
  private arrows: { group: THREE.Group; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  private hoverAxis = -1;
  private grabAxis = -1;
  private lastAxis = -1; // most recently dragged axis (target of a typed value)
  private grabVal = 0;
  private grabProj = 0;
  private downPos = { x: 0, y: 0 };
  private raf = 0;

  private dim = new DimInput();
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
    this.bodies = bodies;
    this.onDone = onDone;
    this.t.set(0, 0, 0);
    this.lastAxis = -1;
    this.previewId = this.store.nextId();
    this.anchor.copy(this.viewport.bodiesCentroid(bodies));
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    this.buildGizmo();
    this.dim.show([{ name: "move", label: "Move", kind: "length" }], () => this.commit());
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ move: 0 });
    setPrompt(
      "Drag an axis arrow to move the selected bodies · type a value · Enter to commit · Esc to cancel",
    );
    this.raf = requestAnimationFrame(this.boundTick);
  }

  private comp(i: number): number {
    return this.t.getComponent(i);
  }
  private setComp(i: number, v: number) {
    this.t.setComponent(i, v);
  }

  private onMove(e: PointerEvent) {
    if (this.grabAxis >= 0) {
      const axis = AXES[this.grabAxis].dir;
      const ray = this.viewport.rayFrom(e.clientX, e.clientY).ray;
      const proj = distanceAlongAxis(ray, this.anchor, axis);
      const raw = this.grabVal + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.anchor));
      if (stepped === this.comp(this.grabAxis)) return;
      this.setComp(this.grabAxis, stepped);
      this.dim.updateFromCursor({ move: stepped });
      this.refreshPreview();
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
      e.preventDefault();
      e.stopImmediatePropagation();
      this.grabAxis = axis;
      this.lastAxis = axis;
      this.grabVal = this.comp(axis);
      this.grabProj = distanceAlongAxis(
        this.viewport.rayFrom(e.clientX, e.clientY).ray,
        this.anchor,
        AXES[axis].dir,
      );
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
    // a clean click in empty space (not on an arrow) commits
    if (!moved && this.hitAxis(e.clientX, e.clientY) < 0) this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    const pos = this.anchor.clone().add(this.t);
    const k = this.viewport.pixelWorldSize(pos);
    this.gizmo.position.copy(pos);
    this.gizmo.scale.setScalar(k);
    for (const a of this.arrows) {
      const hot = a.axis === this.grabAxis || (this.grabAxis < 0 && a.axis === this.hoverAxis);
      a.mat.color.set(hot ? HOT : AXES[a.axis].color);
    }
    const s = this.viewport.projectToScreen(pos);
    this.dim.position(s.x, s.y);
    // a typed value retargets the most recently dragged axis
    if (this.grabAxis < 0 && this.lastAxis >= 0 && this.dim.isUserDriven("move")) {
      const v = this.dim.getValue("move");
      if (v != null) {
        const cur = this.comp(this.lastAxis);
        const signed = Math.sign(cur || 1) * Math.abs(v);
        if (Math.abs(signed - cur) > 1e-6) {
          this.setComp(this.lastAxis, signed);
          this.refreshPreview();
        }
      }
    }
    this.raf = requestAnimationFrame(this.boundTick);
  }

  private refreshPreview() {
    if (this.t.lengthSq() < 1e-9) {
      this.store.setPreview(null);
      return;
    }
    this.store.setPreview(this.buildFeature());
  }

  private buildFeature(): Feature {
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return {
      id: this.previewId,
      type: "move",
      dx: r(this.t.x),
      dy: r(this.t.y),
      dz: r(this.t.z),
      rx: 0,
      ry: 0,
      rz: 0,
      bodies: this.bodies.length ? this.bodies : undefined,
    };
  }

  private buildGizmo() {
    const g = new THREE.Group();
    for (let i = 0; i < AXES.length; i++) {
      const a = AXES[i];
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
    let o: THREE.Object3D | null = hits[0].object;
    while (o && o.userData.axis === undefined) o = o.parent;
    return o ? (o.userData.axis as number) : -1;
  }

  private commit() {
    if (!this.active) return;
    if (this.grabAxis < 0 && this.lastAxis >= 0 && this.dim.isUserDriven("move")) {
      const v = this.dim.getValue("move");
      if (v != null) this.setComp(this.lastAxis, Math.sign(this.comp(this.lastAxis) || 1) * Math.abs(v));
    }
    if (this.t.lengthSq() < 1e-9) return this.cancel(); // nothing moved
    const feature = this.buildFeature();
    this.store.setPreview(null);
    this.store.addFeature(feature);
    const done = this.onDone;
    this.cleanup();
    done?.(feature.id);
  }

  cancel() {
    this.store.setPreview(null);
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
    this.t.set(0, 0, 0);
    setPrompt(null);
  }
}
