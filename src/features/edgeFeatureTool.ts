// Interactive Fillet / Chamfer (MCAD-style): pick a solid edge, then grab a
// small arrow handle on that edge and drag it to set the radius (fillet) or
// setback (chamfer) — with a LIVE preview. Unlike Extrude, a fillet/chamfer
// can't be faked client-side (a real rounded/beveled edge needs build123d/OCCT),
// so the preview is sidecar-driven: the un-committed feature is appended to the
// tree via store.setPreview() and the normal rebuild pipeline renders it.
// Commit promotes it to a real feature (records undo); Esc clears + reverts.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Selector } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";

type Phase = "pick" | "drag";
type Kind = "fillet" | "chamfer";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HANDLE_IDLE = 0xffc83d; // amber
const HANDLE_HOT = 0xffe9a8; // brighter when hovered/grabbed

export class EdgeFeatureTool {
  active = false;
  private kind: Kind = "fillet";
  private phase: Phase = "pick";
  private edges: Selector | Selector[] = [];
  private anchor = new THREE.Vector3(); // arrow origin = edge midpoint
  private axis = new THREE.Vector3(1, 0, 0); // drag axis (unit), fixed for the drag
  private quat = new THREE.Quaternion(); // Y -> axis, for orienting the handle
  private tangent: THREE.Vector3 | null = null; // edge direction (null = pre-selection fallback)
  private value = 2; // radius / distance in mm
  private previewId = ""; // id shared by the live preview and the committed feature

  private gizmo: THREE.Group | null = null;
  private gizmoMat: THREE.MeshBasicMaterial | null = null;
  private hovering = false;
  private grabbing = false;
  private grabValue = 0; // value at grab start (relative drag)
  private grabProj = 0; // axis projection at grab start
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;
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

  private get field() {
    return this.kind === "fillet"
      ? { name: "radius", label: "R" }
      : { name: "distance", label: "D" };
  }

  start(kind: Kind, onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.kind = kind;
    this.phase = "pick";
    this.onDone = onDone;
    this.tangent = null;
    this.viewport.suspendPicking = true; // we drive our own edge-only picking
    this.viewport.emphasizeEdges(true); // light up all edges so they're easy to target
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    // pre-selection (Ctrl-click): skip the pick phase and go straight to the drag
    const pre = this.viewport.selectedEdgeSelectors();
    if (pre.length) {
      this.beginDrag(pre.length === 1 ? pre[0] : pre, this.anchorFromSelectors(pre), null);
    } else {
      setPrompt(`Select an edge to ${kind} (Ctrl-click first to pre-select several)`);
    }
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const hit = this.viewport.pickEdgeAt(e.clientX, e.clientY);
      this.viewport.hoverEdge(hit?.line ?? null);
      this.viewport.domElement.style.cursor = hit ? "pointer" : "default";
      return;
    }
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      // snap to a clean step that scales with zoom (5/1/0.5/0.1mm), so the
      // radius/distance reads as a round number rather than 0.3425.
      const raw = this.grabValue + (proj - this.grabProj);
      const step = this.viewport.snapStep(this.anchor);
      const stepped = Math.max(step, snap(raw, step));
      if (stepped === this.value) return; // same step — don't re-trigger an OCCT rebuild
      this.value = stepped;
      this.dim.updateFromCursor({ [this.field.name]: this.value });
      this.store.setPreview(this.buildFeature());
      return;
    }
    // idle: highlight the handle when hovered so it reads as grabbable
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const hit = this.viewport.pickEdgeAt(e.clientX, e.clientY);
      if (!hit) return; // missed an edge — let the click orbit
      e.preventDefault();
      e.stopImmediatePropagation();
      const pts = hit.line.userData.points as [number, number, number][];
      const { mid, tan } = midAndTangent(pts);
      this.beginDrag(hit.selector, mid, tan);
      return;
    }
    // drag phase: grabbing the handle scrubs; a clean click elsewhere commits
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let the camera orbit while dragging the handle
      this.grabbing = true;
      this.grabValue = this.value;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      this.viewport.domElement.style.cursor = "grabbing";
    }
    // empty-space press: leave it to camera-controls; commit decided on pointerup
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "drag") return;
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      return;
    }
    // a clean click on empty space (no orbit drag) commits
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (!this.downOnGizmo && !moved) this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  private beginDrag(
    edges: Selector | Selector[],
    anchor: THREE.Vector3,
    tangent: THREE.Vector3 | null,
  ) {
    this.edges = edges;
    this.anchor.copy(anchor);
    this.tangent = tangent;
    this.phase = "drag";
    this.value = this.kind === "fillet" ? 2 : 1;
    this.previewId = this.store.nextId();
    this.axis.copy(this.computeAxis());
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    this.viewport.emphasizeEdges(false);
    this.viewport.clearHover();
    this.buildGizmo();
    this.dim.show([{ ...this.field, kind: "length" }], () => this.commit(), () => this.cancel());
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ [this.field.name]: this.value });
    setPrompt(
      `Drag the arrow to set ${this.field.name} · type a value + Enter · click to commit · Esc to cancel`,
    );
    this.store.setPreview(this.buildFeature());
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** keep the handle a constant on-screen size + oriented, and keep a typed value
   *  previewing live (the pointer may be still while the user types). */
  private tick() {
    if (this.phase === "drag" && this.gizmo) {
      const k = this.viewport.pixelWorldSize(this.anchor);
      this.gizmo.position.copy(this.anchor);
      this.gizmo.quaternion.copy(this.quat);
      this.gizmo.scale.setScalar(k);
      this.gizmoMat?.color.set(this.hovering || this.grabbing ? HANDLE_HOT : HANDLE_IDLE);
      const s = this.viewport.projectToScreen(this.anchor);
      this.dim.position(s.x, s.y);
      if (!this.grabbing && this.dim.isUserDriven(this.field.name)) {
        const v = this.dim.getValue(this.field.name);
        if (v != null && Math.abs(v - this.value) > 1e-6) {
          this.value = Math.max(0.001, v);
          this.store.setPreview(this.buildFeature());
        }
      }
      this.raf = requestAnimationFrame(this.boundTick);
    }
  }

  /** Drag axis: perpendicular to the edge and lying in the screen plane, so the
   *  handle sits clear of the edge. Falls back to the camera's right vector when
   *  there's no tangent (pre-selection) or the edge points at the camera. */
  private computeAxis(): THREE.Vector3 {
    const fwd = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (this.tangent) {
      const perp = this.tangent.clone().cross(fwd);
      if (perp.lengthSq() > 1e-6) return perp.normalize();
    }
    return new THREE.Vector3().setFromMatrixColumn(this.viewport.camera.matrixWorld, 0).normalize();
  }

  /** A small arrow built in pixel units; tick() scales it to constant screen size.
   *  depthTest off + high renderOrder so it's always visible and grabbable. */
  private buildGizmo() {
    const mat = new THREE.MeshBasicMaterial({ color: HANDLE_IDLE, depthTest: false, depthWrite: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 34, 12), mat);
    shaft.position.y = 6 + 17; // gap off the edge + half the shaft length
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
    const ray = this.viewport.rayFrom(x, y);
    return ray.intersectObjects(this.gizmo.children, false).length > 0;
  }

  private buildFeature(): Feature {
    const v = Math.round(this.value * 1000) / 1000;
    return this.kind === "fillet"
      ? { id: this.previewId, type: "fillet", edges: this.edges, radius: v }
      : { id: this.previewId, type: "chamfer", edges: this.edges, distance: v };
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    const v = this.dim.getValue(this.field.name);
    if (v != null) this.value = v;
    if (this.value < 1e-3) return this.cancel(); // ignore zero
    const feature = this.buildFeature();
    this.store.setPreview(null);
    this.store.addFeature(feature);
    this.cleanup();
    this.onDone?.(feature.id);
  }

  cancel() {
    this.store.setPreview(null);
    this.cleanup();
    this.onDone?.(null);
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
    this.disposeGizmo();
    this.viewport.emphasizeEdges(false);
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    setPrompt(null);
  }

  private disposeGizmo() {
    if (!this.gizmo) return;
    this.viewport.removeFromScene(this.gizmo);
    for (const child of this.gizmo.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.gizmoMat?.dispose();
    this.gizmo = null;
    this.gizmoMat = null;
  }

  /** Anchor for a pre-selection: average the selector points (nearest selectors
   *  carry their edge midpoint), else fall back to the model's bbox centre. */
  private anchorFromSelectors(sels: Selector[]): THREE.Vector3 {
    const acc = new THREE.Vector3();
    let n = 0;
    for (const s of sels) {
      if ("point" in s) {
        acc.add(new THREE.Vector3(s.point[0], s.point[1], s.point[2]));
        n++;
      }
    }
    if (n > 0) return acc.multiplyScalar(1 / n);
    const bb = this.store.buildState.result?.bbox;
    if (bb) {
      return new THREE.Vector3(
        (bb.min[0] + bb.max[0]) / 2,
        (bb.min[1] + bb.max[1]) / 2,
        (bb.min[2] + bb.max[2]) / 2,
      );
    }
    return acc;
  }
}

/** midpoint + unit tangent (first→last) of an edge polyline */
function midAndTangent(pts: [number, number, number][]): {
  mid: THREE.Vector3;
  tan: THREE.Vector3;
} {
  const m = pts[Math.floor(pts.length / 2)];
  const a = pts[0];
  const b = pts[pts.length - 1];
  const tan = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (tan.lengthSq() < 1e-9) tan.set(1, 0, 0);
  else tan.normalize();
  return { mid: new THREE.Vector3(m[0], m[1], m[2]), tan };
}
