// Interactive Fillet / Chamfer (MCAD-style): pick a solid edge, then grab a
// small arrow handle on that edge and drag it to set the radius (fillet) or
// setback (chamfer) — with a LIVE preview. Unlike Extrude, a fillet/chamfer
// can't be faked client-side (a real rounded/beveled edge needs build123d/OCCT),
// so the preview is sidecar-driven: the un-committed feature is appended to the
// tree via store.setPreview() and the normal rebuild pipeline renders it.
// Commit promotes it to a real feature (records undo); Esc clears + reverts.

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Selector } from "../types";
import { midMatchTol } from "../viewport/edgeMatch";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";

type Phase = "pick" | "drag";
type Kind = "fillet" | "chamfer";
type Vec3 = [number, number, number];

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HANDLE_IDLE = 0xffc83d; // amber
const HANDLE_HOT = 0xffe9a8; // brighter when hovered/grabbed
// Ghost member lines (edit mode): drawn on top of the live preview, where the
// member edges themselves have been consumed into rounded faces. Colors match
// the Highlighter's SELECT / ERROR tiers so the language stays consistent.
const GHOST_SELECT = 0xff7a3c;
const GHOST_ERROR = 0xe23b3b;

/** One edit-mode member edge: its selector, the sharp-model polyline snapshot
 *  it was matched to (for drawing + screen-space hit tests), and its ghost. */
interface GhostEdge {
  sel: Selector;
  mid: Vec3;
  points: Vec3[];
  line: Line2;
}

export class EdgeFeatureTool {
  active = false;
  private kind: Kind = "fillet";
  private phase: Phase = "pick";
  private anchor = new THREE.Vector3(); // arrow origin = edge midpoint
  private axis = new THREE.Vector3(1, 0, 0); // drag axis (unit), fixed for the drag
  private quat = new THREE.Quaternion(); // Y -> axis, for orienting the handle
  private tangent: THREE.Vector3 | null = null; // edge direction (null = pre-selection fallback)
  private value = 2; // radius / distance in mm
  private previewId = ""; // id shared by the live preview and the committed feature

  // --- membership (create AND edit): every selected edge is a ghost line —
  // drawn through the model (depthTest off) so inner/occluded members stay
  // visible, and click-toggleable in both modes. ---
  private ghosts: GhostEdge[] = []; // membership display + toggle targets
  private unmatchedSels: Selector[] = []; // saved selectors we couldn't visualize (kept for commit)

  // --- edit mode (re-opening a committed fillet/chamfer) ---
  private editId: string | null = null; // committed feature id being edited
  private awaitingRollback = false; // waiting for the rolled-back model build
  private unsubBuild: (() => void) | null = null;

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
      this.beginDrag(pre, this.anchorFromSelectors(pre), null);
    } else {
      setPrompt(`Select an edge to ${kind} (Ctrl-click first to pre-select several)`);
    }
  }

  /** Re-open a committed fillet/chamfer for editing: the model rolls back to
   *  just before the feature (its member edges exist again), the saved edges
   *  show as orange ghost lines (click one to remove it, click any other edge
   *  to add it), the saved value seeds the input, and commit REPLACES the
   *  feature in place (same id, one undo step). Returns false when this
   *  feature can't be tool-edited (parameter-driven value, or selectors
   *  without a point) — the caller falls back to the inspector. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || (f.type !== "fillet" && f.type !== "chamfer")) return false;
    const value = f.type === "fillet" ? f.radius : f.distance;
    if (typeof value !== "number") return false; // parameter expression — inspector's job
    const sels = Array.isArray(f.edges) ? f.edges : [f.edges];
    if (!sels.length || !sels.every((s) => "point" in s)) return false; // structural selectors — can't re-anchor

    this.active = true;
    this.kind = f.type;
    this.phase = "drag";
    this.onDone = onDone;
    this.tangent = null;
    this.editId = featureId;
    this.previewId = featureId; // keep the SAME id through preview and commit
    this.value = value;
    this.unmatchedSels = [];
    this.awaitingRollback = true;

    this.viewport.suspendPicking = true;
    this.viewport.emphasizeEdges(true); // additions should be easy to see
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);
    setPrompt("Rolling back to edit… (later features are hidden while editing)");

    // Roll the model to just before the feature; the NEXT completed build shows
    // the sharp member edges, which we snapshot as ghosts before pushing the
    // live preview back on top of them.
    this.store.beginEditPreview(featureId);
    this.unsubBuild = this.store.onBuild((s) => {
      if (s.building || !s.result) return;
      if (this.awaitingRollback) {
        this.awaitingRollback = false;
        this.seedGhosts(sels);
        this.enterEditUI();
        this.pushPreview();
      } else if (this.editId) {
        this.recolorGhostsFromDiagnostics(s.result.diagnostics);
      }
    });
    return true;
  }

  /** Match each saved selector to a rendered sharp edge and build its ghost.
   *  Selectors that don't match (stale midpoint) are kept for commit but have
   *  no visual — the sidecar still resolves them by nearest at build time. */
  private seedGhosts(sels: Selector[]) {
    for (const sel of sels) {
      if (!("point" in sel)) {
        this.unmatchedSels.push(sel);
        continue;
      }
      const mid = sel.point as Vec3;
      const line = this.viewport.edgeLineByMid(mid);
      if (line) this.addGhost(sel, line.userData.points as Vec3[]);
      else this.unmatchedSels.push(sel);
    }
  }

  private addGhost(sel: Selector, points: Vec3[]) {
    const mid = points[Math.floor(points.length / 2)];
    if (!mid) return; // an edge always has points; nothing to ghost otherwise
    const geo = new LineGeometry();
    const flat: number[] = [];
    for (const p of points) flat.push(p[0], p[1], p[2]);
    geo.setPositions(flat);
    const el = this.viewport.domElement;
    const mat = new LineMaterial({
      color: GHOST_SELECT,
      linewidth: 3.5,
      worldUnits: false,
      depthTest: false,
      transparent: true,
    });
    mat.resolution.set(el.clientWidth, el.clientHeight);
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    line.renderOrder = 998;
    this.viewport.addToScene(line);
    this.ghosts.push({ sel, mid, points, line });
  }

  private removeGhost(g: GhostEdge) {
    this.ghosts = this.ghosts.filter((x) => x !== g);
    this.viewport.removeFromScene(g.line);
    g.line.geometry.dispose();
    (g.line.material as LineMaterial).dispose();
  }

  private disposeGhosts() {
    for (const g of [...this.ghosts]) this.removeGhost(g);
    this.unmatchedSels = [];
  }

  /** Screen-space hit test against the ghost polylines (Line2 raycast is
   *  finicky with tool-owned materials; a projected-point distance check is
   *  robust and cheap at ghost counts). */
  private ghostAt(clientX: number, clientY: number): GhostEdge | null {
    for (const g of this.ghosts) {
      for (const p of g.points) {
        const s = this.viewport.projectToScreen(new THREE.Vector3(p[0], p[1], p[2]));
        if (Math.hypot(s.x - clientX, s.y - clientY) < 8) return g;
      }
    }
    return null;
  }

  /** Mount the drag-phase UI (gizmo + value input) anchored to the current
   *  member set, seeded with the saved value. */
  private enterEditUI() {
    const sels = this.currentSelectors();
    this.anchor.copy(this.anchorFromSelectors(sels));
    this.axis.copy(this.computeAxis());
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    this.buildGizmo();
    this.dim.show([{ ...this.field, kind: "length" }], () => this.commit(), () => this.cancel());
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ [this.field.name]: this.value });
    setPrompt(
      `Editing ${this.kind}: click an edge to add or remove it · drag the arrow or type a value · ` +
        `Enter/click empty space to apply · Esc to cancel (later features are hidden while editing)`,
    );
    if (!this.raf) this.raf = requestAnimationFrame(this.boundTick);
  }

  /** The full member selector set (ghosted + unmatched saved selectors). */
  private currentSelectors(): Selector[] {
    return [...this.unmatchedSels, ...this.ghosts.map((g) => g.sel)];
  }

  /** Route the live preview to the right store channel: edit mode replaces the
   *  committed feature at its timeline position; create mode appends. */
  private pushPreview() {
    const feature = this.buildFeature();
    if (this.editId) this.store.setEditPreview(feature);
    else this.store.setPreview(feature);
  }

  /** Paint ghosts red when the sidecar's failure probe names their edge (the
   *  edgeOpFailed diagnostic carries the failed edges' midpoints). */
  private recolorGhostsFromDiagnostics(diags: import("../types").ResolveDiag[] | undefined) {
    const entry = diags?.find(
      (d) => d.kind === "edgeOpFailed" && d.feature_id === this.previewId && d.failed?.length,
    );
    const bb = this.store.buildState.result?.bbox;
    const diag = bb
      ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2])
      : 100;
    const tol = midMatchTol(diag);
    for (const g of this.ghosts) {
      const failed = !!entry?.failed?.some(
        (e) => Math.hypot(e.mid[0] - g.mid[0], e.mid[1] - g.mid[1], e.mid[2] - g.mid[2]) <= tol,
      );
      (g.line.material as LineMaterial).color.set(failed ? GHOST_ERROR : GHOST_SELECT);
    }
    this.viewport.requestRender();
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
      this.pushPreview();
      return;
    }
    // idle: highlight the handle when hovered so it reads as grabbable
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    if (!this.hovering) {
      // ghosts and bare edges are toggle targets in BOTH modes — show it
      const g = this.ghostAt(e.clientX, e.clientY);
      const hit = g ? null : this.viewport.pickEdgeAt(e.clientX, e.clientY);
      this.viewport.hoverEdge(hit?.line ?? null);
      this.viewport.domElement.style.cursor = g || hit ? "pointer" : "default";
      return;
    }
    this.viewport.domElement.style.cursor = "grab";
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
      this.beginDrag([hit.selector], mid, tan, pts);
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
      return;
    }
    // click toggles membership in BOTH modes — a ghost hit removes that edge,
    // a bare-edge hit adds it. Either way this press is a toggle, not the
    // commit-on-clean-click gesture (downOnGizmo doubles as that latch).
    const g = this.ghostAt(e.clientX, e.clientY);
    if (g) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.removeGhost(g);
      this.afterMembershipChange();
      this.downOnGizmo = true;
      return;
    }
    const hit = this.viewport.pickEdgeAt(e.clientX, e.clientY);
    if (hit) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.viewport.clearHover();
      this.addGhost(hit.selector, hit.line.userData.points as Vec3[]);
      this.afterMembershipChange();
      this.downOnGizmo = true;
      return;
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
    edges: Selector[],
    anchor: THREE.Vector3,
    tangent: THREE.Vector3 | null,
    points?: Vec3[],
  ) {
    // Every member gets a ghost line (visible through the model) and stays
    // click-toggleable — a direct pick carries its polyline, pre-selected
    // selectors get matched by midpoint (unmatched ones still commit).
    if (points && edges.length === 1 && edges[0]) this.addGhost(edges[0], points);
    else this.seedGhosts(edges);
    this.anchor.copy(anchor);
    this.tangent = tangent;
    this.phase = "drag";
    this.value = this.kind === "fillet" ? 2 : 1;
    this.previewId = this.store.nextId();
    this.axis.copy(this.computeAxis());
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    // keep edges emphasized: more edges can be clicked into the set mid-drag
    this.viewport.clearHover();
    this.buildGizmo();
    this.dim.show([{ ...this.field, kind: "length" }], () => this.commit(), () => this.cancel());
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ [this.field.name]: this.value });
    setPrompt(
      `Drag the arrow to set ${this.field.name} · type a value + Enter · ` +
        `click edges to add/remove them · click empty space to commit · Esc to cancel`,
    );
    this.pushPreview();
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
          this.pushPreview();
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

  /** Re-anchor the gizmo/input to the new member set and refresh the preview.
   *  With zero members the preview drops back to the bare model (a fillet with
   *  no edges would just error every rebuild). */
  private afterMembershipChange() {
    const sels = this.currentSelectors();
    const verb = this.editId ? "Editing" : "Creating";
    if (sels.length) {
      this.anchor.copy(this.anchorFromSelectors(sels));
      this.axis.copy(this.computeAxis());
      this.quat.setFromUnitVectors(Y_AXIS, this.axis);
      this.pushPreview();
      setPrompt(
        `${verb} ${this.kind}: ${sels.length} edge${sels.length === 1 ? "" : "s"} · click edges to add/remove · ` +
          `Enter/click empty space to ${this.editId ? "apply" : "commit"} · Esc to cancel`,
      );
    } else {
      if (this.editId) this.store.setEditPreview(null);
      else this.store.setPreview(null);
      setPrompt(`No edges selected — click an edge to add one · Esc to cancel`);
    }
  }

  private buildFeature(): Feature {
    const v = Math.round(this.value * 1000) / 1000;
    const sels = this.currentSelectors();
    const edges = sels.length === 1 && sels[0] ? sels[0] : sels;
    return this.kind === "fillet"
      ? { id: this.previewId, type: "fillet", edges, radius: v }
      : { id: this.previewId, type: "chamfer", edges, distance: v };
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    const v = this.dim.getValue(this.field.name);
    if (v != null) this.value = v;
    if (this.value < 1e-3) return this.cancel(); // ignore zero
    if (this.currentSelectors().length === 0) {
      setPrompt("No edges selected — click an edge to add one · Esc to cancel");
      return; // deleting is an explicit timeline action, not an implicit empty commit
    }
    const feature = this.buildFeature();
    if (this.editId) {
      const id = this.editId;
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(id, feature);
    } else {
      this.store.setPreview(null);
      this.store.addFeature(feature);
    }
    this.cleanup();
    this.onDone?.(feature.id);
  }

  cancel() {
    if (this.editId) this.store.endEditPreview();
    else this.store.setPreview(null);
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
    this.disposeGhosts();
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.editId = null;
    this.awaitingRollback = false;
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
  if (!a || !b || !m) return { mid: new THREE.Vector3(), tan: new THREE.Vector3(1, 0, 0) };
  const tan = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (tan.lengthSq() < 1e-9) tan.set(1, 0, 0);
  else tan.normalize();
  return { mid: new THREE.Vector3(m[0], m[1], m[2]), tan };
}
