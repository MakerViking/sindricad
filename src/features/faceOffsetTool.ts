// Interactive Offset Face and Thicken. Both are the same gesture — pick solid
// face(s), grab an arrow on the face and scrub along its normal, or type a
// value — so they share one tool, parameterised by `mode`:
//
//   offsetFace : the picked faces MOVE along their normals, the body staying
//                closed (neighbouring faces stretch to follow).
//   thicken    : the picked faces gain a wall, as a new body or joined in.
//
// Like Fillet/Press-Pull-on-curved-faces, neither result can be faked
// client-side — a real surface offset needs build123d/OCCT — so the preview is
// sidecar-driven: the un-committed feature goes through store.setPreview() and
// the normal rebuild pipeline renders it. Commit promotes it (records undo);
// Esc reverts.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Selector } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import { HANDLE_IDLE, HANDLE_HOT, HANDLE_CUT as HANDLE_IN } from "../viewport/colors3d";

export type FaceOffsetMode = "offsetFace" | "thicken";

type Phase = "pick" | "drag";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

const LABEL: Record<FaceOffsetMode, string> = { offsetFace: "Offset Face", thicken: "Thicken" };

export class FaceOffsetTool {
  active = false;
  private mode: FaceOffsetMode = "offsetFace";
  private phase: Phase = "pick";
  private faces: Selector[] = [];
  private faceIds: number[] = [];
  private bodyId: string | null = null;
  private anchor = new THREE.Vector3();
  private axis = new THREE.Vector3(0, 0, 1);
  private quat = new THREE.Quaternion();
  private value = 0;
  private symmetric = false; // thicken only
  private previewId = "";

  private gizmo: THREE.Group | null = null;
  private gizmoMat: THREE.MeshBasicMaterial | null = null;
  private hovering = false;
  private grabbing = false;
  private grabValue = 0;
  private grabProj = 0;
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

  start(mode: FaceOffsetMode, onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.mode = mode;
    this.phase = "pick";
    this.symmetric = false;
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    const pre = this.viewport.selectedFacesForPressPull();
    if (pre) this.beginDrag(pre.selectors, pre.faceIds, pre.anchor, pre.normal, pre.bodyId);
    else setPrompt(`Select a face to ${LABEL[mode]} (Ctrl+click adds more)`);
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = faceId != null ? "pointer" : "default";
      return;
    }
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      const raw = this.grabValue + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.anchor));
      if (stepped === this.value) return; // same step — don't re-trigger an OCCT rebuild
      this.value = stepped;
      this.dim.updateFromCursor({ distance: Math.abs(this.value) });
      this.pushPreview();
      return;
    }
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit) return; // missed the body — let the click orbit
      e.preventDefault();
      e.stopImmediatePropagation();
      this.beginDrag([hit.selector], [hit.faceId], hit.anchor, hit.normal, hit.bodyId);
      return;
    }
    // Ctrl/Cmd-click another face on the SAME body adds it; all faces share the
    // one distance (matching how press-pull and the sidecar handler treat them)
    if (e.ctrlKey || e.metaKey) {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && hit.bodyId === this.bodyId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.faces.push(hit.selector);
        this.faceIds.push(hit.faceId);
        this.pushPreview();
        this.prompt();
      }
      return;
    }
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't orbit while dragging the handle
      this.grabbing = true;
      this.grabValue = this.value;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      // Grabbing the handle is as deliberate a statement of the value as typing
      // one, so hand the box back to cursor tracking — otherwise it sits frozen
      // at the typed or seeded figure while the geometry moves under it, and the
      // arrow "does not display in the input field the distance manually pushed
      // or pulled ... which makes the arrow effectively useless" (field report
      // 215db097). Typing re-locks it on the next keystroke.
      this.dim.unlock("distance");
      this.viewport.domElement.style.cursor = "grabbing";
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "drag") return;
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.downOnGizmo || moved) return;
    this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { this.cancel(); return; }
    // Thicken's one option worth a key: grow the wall both ways about the surface
    if ((e.key === "s" || e.key === "S") && this.mode === "thicken" && this.phase === "drag") {
      this.symmetric = !this.symmetric;
      this.pushPreview();
      this.prompt();
    }
  }

  private prompt() {
    const n = this.faces.length > 1 ? `${this.faces.length} faces — ` : "";
    const sym = this.mode === "thicken" ? ` · S = symmetric${this.symmetric ? " (on)" : ""}` : "";
    setPrompt(`${n}drag the arrow or type a distance${sym} · click empty space to commit · Esc to cancel`);
  }

  private beginDrag(
    faces: Selector[], faceIds: number[], anchor: THREE.Vector3,
    normal: THREE.Vector3, bodyId: string | null = null,
  ) {
    this.faces = faces;
    this.faceIds = faceIds;
    this.bodyId = bodyId;
    this.anchor.copy(anchor);
    this.axis.copy(normal).normalize();
    this.phase = "drag";
    this.value = 0;
    this.previewId = this.store.nextId();
    this.viewport.clearHover();
    this.buildGizmo();
    this.dim.show([{ name: "distance", label: "D", kind: "length" }], () => this.commit(), () => this.cancel());
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ distance: 0 });
    this.prompt();
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** keep the handle a constant on-screen size, point it the way we're dragging,
   *  and keep a typed value previewing live (the pointer may be still). */
  private tick() {
    if (this.phase === "drag" && this.gizmo) {
      const sign = this.value < 0 ? -1 : 1;
      const dir = this.axis.clone().multiplyScalar(sign);
      this.quat.setFromUnitVectors(Y_AXIS, dir);
      const k = this.viewport.pixelWorldSize(this.anchor);
      this.gizmo.position.copy(this.anchor);
      this.gizmo.quaternion.copy(this.quat);
      this.gizmo.scale.setScalar(k);
      this.gizmoMat?.color.set(
        this.hovering || this.grabbing ? HANDLE_HOT : sign < 0 ? HANDLE_IN : HANDLE_IDLE,
      );
      const s = this.viewport.projectToScreen(this.anchor);
      this.dim.position(s.x, s.y);
      // The field is the truth once typed — including its SIGN. While dragging
      // it displays |value|, so an unguarded read-back would strip an inward
      // drag's sign (the abs-display trap press-pull documents).
      if (!this.grabbing && this.dim.isUserDriven("distance")) {
        const v = this.dim.getValue("distance");
        if (v != null && Math.abs(v - this.value) > 1e-6) {
          this.value = v;
          this.pushPreview();
        }
      }
      this.raf = requestAnimationFrame(this.boundTick);
    }
  }

  private pushPreview() {
    this.store.setPreview(Math.abs(this.value) < 1e-6 ? null : this.buildFeature());
  }

  /** A small arrow built in pixel units; tick() scales it to constant screen size.
   *  depthTest off + high renderOrder so it's always visible and grabbable. */
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
    const ray = this.viewport.rayFrom(x, y);
    return ray.intersectObjects(this.gizmo.children, false).length > 0;
  }

  private buildFeature(): Feature {
    const v = Math.round(this.value * 1000) / 1000;
    const faces = this.faces.length === 1 ? (this.faces[0] ?? this.faces) : this.faces;
    const body = this.bodyId != null ? { body: this.bodyId } : {};
    if (this.mode === "thicken") {
      return {
        id: this.previewId, type: "thicken", faces, thickness: v,
        // thickening faces OF an existing solid should grow that solid; a
        // standalone surface body has nothing to join, and the sidecar's
        // _boolean_into_bodies falls back to a new body in that case anyway
        operation: "join",
        ...(this.symmetric ? { symmetric: true } : {}),
        ...body,
      };
    }
    return { id: this.previewId, type: "offsetFace", faces, distance: v, ...body };
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    const v = this.dim.getValue("distance");
    if (v == null && this.dim.isUserDriven("distance")) {
      setPrompt("Can't read that number — fix the value, or Esc to cancel");
      return;
    }
    if (v != null && this.dim.isUserDriven("distance")) this.value = v;
    if (Math.abs(this.value) < 1e-3) {
      // keep the tool alive: silently cancelling reads as "nothing happened"
      setPrompt("Nothing to commit — drag the arrow or type a distance first");
      return;
    }
    const feature = this.buildFeature();
    this.store.setPreview(null); // addFeature re-adds it as a committed feature
    this.store.addFeature(feature);
    this.cleanup();
    this.onDone?.(feature.id);
  }

  cancel() {
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
    this.store.setPreview(null);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    this.disposeGizmo();
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    this.value = 0;
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
}
