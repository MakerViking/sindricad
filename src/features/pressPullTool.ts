// Interactive Press/Pull (MCAD-style): pick a solid face, then grab a small
// arrow handle on it and drag along the face normal to add material (boss / pull
// out), cut material (pocket / push in), or resize a cylindrical face (hole/boss)
// — with a LIVE preview. Same interaction as Fillet/Chamfer (EdgeFeatureTool): an
// on-top, constant-screen-size gizmo you grab and scrub; a clean click commits.
//
// Like Fillet (and unlike sketch Extrude) the result can't be faked client-side —
// a real surface offset needs build123d/OCCT — so the preview is sidecar-driven:
// the un-committed feature is appended via store.setPreview() and the normal
// rebuild pipeline renders it. Commit promotes it (records undo); Esc reverts.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Selector } from "../types";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { EdgeRef } from "../viewport/edgeLines";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import { HANDLE_IDLE, HANDLE_HOT, HANDLE_CUT } from "../viewport/colors3d";

type Phase = "pick" | "drag";

/** What the pick phase found that ISN'T this tool's job.
 *
 *  Fusion's Press Pull is a dispatcher — a profile goes to Extrude, a face to
 *  Offset Face, an edge to Fillet — and a field reporter asked for exactly that
 *  ("press/pull just the bolt hole"). The tool reports what was under the
 *  cursor rather than starting anything: `featureStarters` owns tool launching,
 *  and nothing in this codebase has one tool call another's start(). */
export type PressPullHandoff =
  | { kind: "region"; region: WorldRegion }
  | { kind: "edge"; edge: EdgeRef };

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class PressPullTool {
  active = false;
  private phase: Phase = "pick";
  private faces: Selector[] = []; // one or more faces pushed together by `value`
  private faceIds: number[] = []; // their mesh faceIds (for the instant ghost preview)
  private upTo: Selector | null = null; // "extrude up to this surface" target (else by distance)
  private upToPlane: string | null = null; // ...or up to this DATUM plane, by feature id
  private pickingTarget = false; // waiting for the user to click the up-to target surface
  private bodyId: string | null = null; // the body that owns the picked face
  private anchor = new THREE.Vector3(); // gizmo origin = the clicked point on the face
  private axis = new THREE.Vector3(0, 0, 1); // drag axis (unit) = face outward normal
  private quat = new THREE.Quaternion(); // Y -> current arrow direction
  private value = 0; // signed distance in mm (+ along normal / out, − in)
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
  private onHandoff: ((h: PressPullHandoff) => void) | null = null;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundTick: () => void;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
    private overlay: SketchOverlay,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundKey = (e) => this.onKey(e);
    this.boundTick = () => this.tick();
  }

  start(onDone: (id: string | null) => void, onHandoff?: (h: PressPullHandoff) => void) {
    if (this.active) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.onHandoff = onHandoff ?? null;
    this.viewport.suspendPicking = true; // we drive our own face picking
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    // pre-selection: faces already selected → skip straight to the drag
    const pre = this.viewport.selectedFacesForPressPull();
    if (pre) {
      this.beginDrag(pre.selectors, pre.faceIds, pre.anchor, pre.normal, pre.bodyId);
    } else {
      setPrompt("Click a face to Press/Pull · a sketch profile to Extrude · an edge to Fillet");
    }
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = faceId != null ? "pointer" : "default";
      return;
    }
    // T mode ("extrude up to"): show what the click would bind. Without this the
    // tool hit-tests only its own arrow while the mode is armed, so sweeping
    // over a face or an offset plane looks exactly like sweeping over nothing
    // (field report c0cfee48: "no highlight, so I could not tell it was aimed at
    // the plane" — the click did bind it).
    //
    // The highlight has to tell the truth about onDown, so it mirrors that
    // branch's precedence exactly: a body hit blocks the datum fallback, and one
    // of the operation's OWN faces binds nothing at all. Lighting up a plane the
    // click would ignore is worse than no highlight. One raycast: hoverFaceAt
    // and pickFaceForPressPull search the same meshes, so the faceIds check
    // stands in for the second call.
    if (this.pickingTarget) {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      const targetable = faceId != null && !this.faceIds.includes(faceId);
      if (!targetable) this.viewport.clearHover();
      const datumId = faceId == null ? this.viewport.pickDatumAt(e.clientX, e.clientY) : null;
      this.viewport.hoverDatum(datumId);
      this.viewport.domElement.style.cursor = targetable || datumId ? "pointer" : "default";
      return;
    }
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      // snap the drag to a clean zoom-scaled step (MCAD-style); hold Ctrl/Cmd —
      // or type a value — for finer control
      const raw = this.grabValue + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.anchor, e.ctrlKey || e.metaKey));
      if (stepped === this.value) return; // same step — don't re-trigger an OCCT rebuild
      this.value = stepped;
      this.dim.updateFromCursor({ distance: Math.abs(this.value) });
      this.refreshPreview();
      return;
    }
    // idle: highlight the handle when hovered so it reads as grabbable
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      // Dispatch first: an EDGE is Fillet's job and a sketch PROFILE is
      // Extrude's. pickEntity() is the same gated pick the model view uses, so
      // this reproduces the standing EDGE > sketch REGION > body FACE priority
      // (viewport.handleClick) instead of inventing a second one. Deliberately
      // NOT pickEdgeAt(): that keeps the wide grab radius meant for the
      // dedicated edge tools, and here it would steal clicks aimed at faces.
      const entity = this.viewport.pickEntity(e.clientX, e.clientY);
      if (entity?.kind === "edge") {
        this.handOff(e, { kind: "edge", edge: entity.edge });
        return;
      }
      const region = this.overlay.committedRegionAtRay(
        this.viewport.rayFrom(e.clientX, e.clientY).ray,
      );
      if (region) {
        this.handOff(e, { kind: "region", region });
        return;
      }
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit) return; // missed the body — let the click orbit
      e.preventDefault();
      e.stopImmediatePropagation();
      this.beginDrag([hit.selector], [hit.faceId], hit.anchor, hit.normal, hit.bodyId);
      return;
    }
    // drag phase: clicking the "up to" target surface (after pressing T).
    // Consume EVERY click in this mode — a miss must never fall through to the
    // clean-click-commits path and fire a stray plain commit (audit bug #3).
    if (this.pickingTarget) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && !this.faceIds.includes(hit.faceId)) {
        this.setUpTo(hit.selector);
        this.commitUpTo();
        return;
      }
      // A datum plane is a legitimate target too (field report ffab4ece: "extrude
      // up to that offset plane"), but only on a body MISS — the same BODY-FIRST
      // precedence viewport.handleClick uses, so an 80x80 quad floating in front
      // of the solid can never steal a face pick.
      const datumId = hit ? null : this.viewport.pickDatumAt(e.clientX, e.clientY);
      if (datumId) {
        this.setUpTo(datumId);
        this.commitUpTo();
        return;
      }
      setPrompt("Pick the face or plane to extrude UP TO (any face, any body) · Esc to go back");
      return;
    }
    // drag phase: Ctrl/Cmd-click another face on the SAME body adds it to the
    // operation (all faces share the one distance). Do this before the grab check.
    if (e.ctrlKey || e.metaKey) {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && hit.bodyId === this.bodyId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.faces.push(hit.selector);
        this.faceIds.push(hit.faceId);
        this.refreshPreview();
        setPrompt(`${this.faces.length} faces — drag or type a distance · click to commit · Esc to cancel`);
      }
      return;
    }
    // grabbing the handle scrubs; a clean click elsewhere commits
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let the camera orbit while dragging the handle
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
    if (this.pickingTarget) return; // T-mode clicks are fully handled in onDown
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.downOnGizmo || moved) return;
    // Clean click on ANOTHER face = extrude UP TO it (mainstream MCAD "to object" —
    // no T needed: pick a face, then click the face to meet). Empty space or
    // one of the operation's own faces = commit as before.
    //
    // Deliberately NO datum fallback here, unlike the T-mode branch above: this
    // runs on EVERY click that isn't on the gizmo, so falling back to a datum
    // quad would turn "click empty space to commit" into "extrude up to this
    // plane" wherever a plane's 80x80 quad happens to sit under the cursor —
    // a silent wrong commit. Naming a plane as the target needs T.
    const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
    if (hit && !this.faceIds.includes(hit.faceId)) {
      this.setUpTo(hit.selector);
      this.commitUpTo();
      return;
    }
    this.commit();
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
    if (e.key === "Escape") {
      if (this.pickingTarget) {
        this.pickingTarget = false;
        // leaving T mode must take its highlights with it, or the last face and
        // plane the cursor passed stay lit over a tool that no longer aims at them
        this.viewport.clearHover();
        this.viewport.hoverDatum(null);
        // restore the distance field T-mode hid (audit bug #2: leaving it
        // active let Enter commit a plain distance mid-target-pick)
        this.dim.show([{ name: "distance", label: "D", kind: "length" }], () => this.commit(), () => this.cancel());
        this.dim.updateFromCursor({ distance: Math.abs(this.value) });
        setPrompt("Drag the arrow · type a value · click another face = extrude up to it · T = up to a face or plane · click empty space to commit · Esc to cancel");
        return;
      }
      this.cancel();
      return;
    }
    if ((e.key === "t" || e.key === "T") && this.phase === "drag" && !this.pickingTarget) {
      this.pickingTarget = true;
      this.dim.hide(); // Enter must not commit a plain distance while picking
      this.viewport.clearPressPullGhost();
      setPrompt("Click the face or plane to extrude UP TO (any face, any body) · Esc to go back");
    }
  }

  private beginDrag(faces: Selector[], faceIds: number[], anchor: THREE.Vector3, normal: THREE.Vector3, bodyId: string | null = null) {
    this.faces = faces;
    this.faceIds = faceIds;
    this.upTo = null;
    this.upToPlane = null;
    this.pickingTarget = false;
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
    setPrompt(
      "Drag the arrow · type a value (negative = cut) · click ANOTHER face = extrude up to it · T = up to a face or plane · click empty space to commit · Esc to cancel",
    );
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
      const base = sign < 0 ? HANDLE_CUT : HANDLE_IDLE;
      this.gizmoMat?.color.set(this.hovering || this.grabbing ? HANDLE_HOT : base);
      const s = this.viewport.projectToScreen(this.anchor);
      this.dim.position(s.x, s.y);
      if (!this.grabbing && this.dim.isUserDriven("distance")) {
        const v = this.dim.getValue("distance");
        if (v != null) {
          // the field is the truth: typed sign wins (out = +, cut = −). The old
          // code re-applied the drag's sign onto |v|, so a typed "-2" after an
          // outward drag silently JOINED 2 instead of cutting.
          if (Math.abs(v - this.value) > 1e-6) {
            this.value = v;
            this.refreshPreview();
          }
        }
      }
      this.raf = requestAnimationFrame(this.boundTick);
    }
  }

  /** Instant ghost preview during the drag — a frontend-only translucent prism, no
   *  kernel round-trip (that's why dragging feels immediate). The real OCCT geometry
   *  is computed once on commit. Near-zero distance clears the ghost. */
  private refreshPreview() {
    this.viewport.setPressPullGhost(this.faceIds, this.value);
  }

  /** A small arrow built in pixel units; tick() scales it to constant screen size.
   *  depthTest off + high renderOrder so it's always visible and grabbable. */
  private buildGizmo() {
    const mat = new THREE.MeshBasicMaterial({ color: HANDLE_IDLE, depthTest: false, depthWrite: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 34, 12), mat);
    shaft.position.y = 6 + 17; // gap off the face + half the shaft length
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
    return {
      id: this.previewId,
      type: "press-pull",
      face: this.faces.length === 1 ? (this.faces[0] ?? this.faces) : this.faces,
      distance: v,
      operation: v >= 0 ? "join" : "cut",
      ...(this.bodyId != null ? { body: this.bodyId } : {}),
      ...(this.upTo ? { upTo: this.upTo } : {}),
      ...(this.upToPlane ? { upToPlane: this.upToPlane } : {}),
    };
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    const v = this.dim.getValue("distance");
    if (v == null && this.dim.isUserDriven("distance")) {
      // the field holds unparseable text — committing the stale drag value
      // instead would be a silent wrong-number surprise
      setPrompt("Can't read that number — fix the value, or Esc to cancel");
      return;
    }
    // Typed sign wins (out = +, cut = −) — but ONLY when the user actually
    // typed. While dragging, the field displays |value| (line ~106), so reading
    // it back unguarded strips a dragged cut's sign and commits a JOIN — the
    // mirror image of the typed-"-2"-after-outward-drag bug this line fixed.
    if (v != null && this.dim.isUserDriven("distance")) this.value = v;
    if (Math.abs(this.value) < 1e-3) {
      // keep the tool alive: silently cancelling here read as "nothing happened"
      setPrompt("Nothing to commit — drag the arrow or type a distance first");
      return;
    }
    const feature = this.buildFeature();
    this.store.addFeature(feature);
    this.cleanup();
    this.onDone?.(feature.id);
  }

  /** Commit an "extrude up to a surface" — the sidecar derives each face's distance
   *  from the target, so we skip the near-zero-distance guard `commit()` applies. */
  private commitUpTo() {
    const feature = this.buildFeature();
    this.store.addFeature(feature);
    this.cleanup();
    this.onDone?.(feature.id);
  }

  cancel() {
    this.cleanup();
    this.onDone?.(null);
  }

  /** Stand down so another tool can take this click.
   *
   *  Tears down through cleanup() and NOT cancel(): cancel() reports
   *  `onDone(null)`, and the starter's callback would then record a committed
   *  feature id of null for a press/pull the user never began. cleanup() also
   *  restores `viewport.suspendPicking = false` and clears `active`, both of
   *  which must happen BEFORE the receiving tool's start() sets them again. */
  private handOff(e: PointerEvent, h: PressPullHandoff) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const handoff = this.onHandoff;
    this.cleanup();
    handoff?.(h);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    this.viewport.clearPressPullGhost();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    this.disposeGizmo();
    this.viewport.clearHover();
    this.viewport.hoverDatum(null);
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
