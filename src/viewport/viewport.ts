// Viewport orchestrator: owns the scene, camera rig, render loop, ViewCube,
// the current model view, picking + highlighting. Exposes a small API the rest
// of the app uses: setModel(), fit(), pick callbacks, projection/view toggles.

import * as THREE from "three";
import { createScene, type SceneBundle } from "./scene";
import { createCameraRig, type CameraRig, type StandardView } from "./cameras";
import { buildModel, disposeModel, setEdgeResolution, type ModelView } from "./render";
import { Picker, type Hit, type EdgeHit } from "./picking";
import { ViewCube, FACE_VIEWS } from "./viewCube";
import { setPrompt } from "../ui/prompt";
import type { DocumentStore } from "../document/store";
import type { ViewCubeSide } from "../types";

const EDGE_IDLE = new THREE.Color(0x1b1f24); // normal dark edge
const EDGE_PICKABLE = new THREE.Color(0xd98a4a); // muted ember "selectable" edge (fillet/chamfer mode)
import { Highlighter } from "./highlight";
import type { Plane3, PlaneDef, RebuildResult, Selector } from "../types";
import { niceStep } from "../ui/units";

export class Viewport {
  readonly scene: SceneBundle;
  readonly rig: CameraRig;
  private cube: ViewCube;
  private picker = new Picker();
  private highlighter: Highlighter | null = null;
  private model: ModelView | null = null;
  private clock = new THREE.Clock();
  private resolution = new THREE.Vector2();
  private dragMoved = false;
  private downPos = { x: 0, y: 0 };
  // "redefine cube side from a model face" pick mode (null = not active)
  private setOverrideSide: ViewCubeSide | null = null;

  onHit: ((hit: Hit | null, shiftKey: boolean) => void) | null = null;
  onSelectionChange: (() => void) | null = null; // fired when edge/face selection changes
  suspendPicking = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = createScene(canvas);
    const rect = canvas.getBoundingClientRect();
    this.rig = createCameraRig(canvas, rect.width / rect.height);

    this.cube = new ViewCube(canvas, this.scene.renderer, {
      applySide: (side) => this.applyCubeSide(side),
      applyDir: (dir, up) => this.rig.setViewDir(dir, up),
      getOverrides: () => this.store?.viewOverrides ?? {},
      beginSetOverride: (side) => this.beginSetOverride(side),
      resetOverride: (side) => {
        this.store?.setViewOverride(side, null);
        this.cube.refreshOverrideMarks();
      },
    });

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.installPointer();
    this.loop();
  }

  // The document store is wired lazily (the Viewport is constructed before the
  // store in main.ts). Persisted ViewCube overrides live on the document.
  private storeSubscribed = false;
  private get store(): DocumentStore | undefined {
    const s = (window as any).store as DocumentStore | undefined;
    if (s && !this.storeSubscribed) {
      this.storeSubscribed = true;
      // refresh the cube's redefined-side markers whenever the document changes
      // (open file, undo/redo, override set/reset).
      s.onDocChange(() => this.cube.refreshOverrideMarks());
    }
    return s;
  }

  private installPointer() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.dragMoved = false;
      this.downPos = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener("pointermove", (e) => {
      if (
        Math.abs(e.clientX - this.downPos.x) > 3 ||
        Math.abs(e.clientY - this.downPos.y) > 3
      ) {
        this.dragMoved = true;
      }
      this.handleHover(e);
    });
    c.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || this.dragMoved) return;
      // 1) a click landing on the ViewCube corner orients the view (and never
      //    falls through to model picking).
      if (this.cube.handleLeftClick(e.clientX, e.clientY)) return;
      // 2) if we're redefining a cube side, the next model click captures a face.
      if (this.setOverrideSide) {
        this.captureOverrideFace(e);
        return;
      }
      this.handleClick(e);
    });
    // Explicit wheel zoom for BOTH projections (camera-controls' built-in wheel
    // DOLLY didn't zoom in perspective under WebKitGTK). deltaMode-normalized so
    // line/page-mode wheels (some webviews) still produce a sensible step.
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1; // lines/pages -> px
        const dy = Math.max(-240, Math.min(240, e.deltaY * unit));
        this.rig.zoomBy(Math.pow(1.0016, dy)); // >1 (scroll down) zooms out
      },
      { passive: false },
    );
  }

  private handleHover(e: PointerEvent) {
    // while redefining a cube side, hover-highlight the model face under the
    // cursor (so the user sees which face they'll capture).
    if (this.setOverrideSide) {
      this.hoverFaceAt(e.clientX, e.clientY);
      return;
    }
    if (this.suspendPicking) return;
    if (!this.model || !this.highlighter) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.picker.pick(
      e.clientX,
      e.clientY,
      rect,
      this.rig.active,
      this.model,
      this.resolution,
    );
    this.highlighter.clearHover();
    if (hit?.kind === "edge") this.highlighter.hoverEdge(hit.line);
    else if (hit?.kind === "face") this.highlighter.hoverFace(hit.faceId);
  }

  private handleClick(e: PointerEvent) {
    if (this.suspendPicking) return;
    if (!this.model) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.picker.pick(
      e.clientX,
      e.clientY,
      rect,
      this.rig.active,
      this.model,
      this.resolution,
    );
    // Ctrl/Cmd-click adds to the selection; a plain click replaces it (Fusion).
    const add = e.ctrlKey || e.metaKey;
    if (this.highlighter) {
      if (!add) this.highlighter.clearSelection();
      if (hit?.kind === "edge") this.highlighter.toggleSelectEdge(hit.line);
      else if (hit?.kind === "face") this.highlighter.toggleSelectFace(hit.faceId);
    }
    this.onHit?.(hit, e.shiftKey);
    this.onSelectionChange?.();
  }

  /** Selectors for the currently selected edges (for pre-selected fillet/chamfer). */
  selectedEdgeSelectors(): Selector[] {
    if (!this.highlighter) return [];
    return this.highlighter.getSelectedEdges().map((line) => {
      const pts = line.userData.points as [number, number, number][];
      const mid = pts[Math.floor(pts.length / 2)];
      return { kind: "edge", by: "nearest", point: [mid[0], mid[1], mid[2]] };
    });
  }

  /** Pre-selection for Press/Pull: if exactly one face is selected, return its
   *  selector + surface normal + centroid anchor (else null). */
  selectedFaceForPressPull(): { selector: Selector; normal: THREE.Vector3; anchor: THREE.Vector3 } | null {
    if (!this.highlighter || !this.model) return null;
    const faces = this.highlighter.getSelectedFaces();
    if (faces.length !== 1) return null;
    const faceId = faces[0];
    const anchor = this.faceCentroidWorld(faceId);
    const normal = this.faceNormalWorld(faceId);
    return {
      selector: { kind: "face", by: "nearest", point: [anchor.x, anchor.y, anchor.z] },
      normal,
      anchor,
    };
  }

  setModel(result: RebuildResult, fit = false) {
    // dispose previous model first (full-rebuild memory hygiene)
    if (this.model) {
      this.scene.modelGroup.remove(this.model.mesh);
      for (const e of this.model.edges) this.scene.modelGroup.remove(e);
      disposeModel(this.model);
    }
    this.model = buildModel(result, this.resolution);
    this.scene.modelGroup.add(this.model.mesh);
    for (const e of this.model.edges) this.scene.modelGroup.add(e);
    this.highlighter = new Highlighter(this.model);
    if (fit) this.rig.fit(this.model.box, true);
  }

  clearModel() {
    if (!this.model) return;
    this.scene.modelGroup.remove(this.model.mesh);
    for (const e of this.model.edges) this.scene.modelGroup.remove(e);
    disposeModel(this.model);
    this.model = null;
    this.highlighter = null;
  }

  fitView() {
    if (this.model) this.rig.fit(this.model.box, true);
  }

  showAllPlanes(on: boolean) {
    for (const k of ["XY", "XZ", "YZ"] as Plane3[]) {
      const m = this.scene.planes[k];
      m.visible = on;
      (m.material as THREE.MeshBasicMaterial).opacity = on ? 0.18 : 0.08;
    }
  }

  /**
   * Raycast the three plane quads. When several are hit (common near the origin
   * / axes, where the ray is nearly coplanar with two of them), prefer the one
   * whose normal most faces the camera — i.e. the plane you're looking at.
   */
  pickPlane(clientX: number, clientY: number): Plane3 | null {
    this.rayFrom(clientX, clientY);
    const meshes = (["XY", "XZ", "YZ"] as Plane3[]).map((k) => this.scene.planes[k]);
    const hits = this.sharedRaycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const NORMAL: Record<Plane3, THREE.Vector3> = {
      XY: new THREE.Vector3(0, 0, 1),
      XZ: new THREE.Vector3(0, 1, 0),
      YZ: new THREE.Vector3(1, 0, 0),
    };
    const viewDir = this.rig.active.getWorldDirection(new THREE.Vector3());
    let best: Plane3 | null = null;
    let bestFacing = -1;
    for (const h of hits) {
      const id = h.object.userData.plane as Plane3;
      const facing = Math.abs(NORMAL[id].dot(viewDir));
      if (facing > bestFacing) {
        bestFacing = facing;
        best = id;
      }
    }
    return best;
  }

  /**
   * Raycast the solid; if a face is hit, derive a sketch plane from it
   * (origin = face centroid, normal = face normal, xdir = a tangent). Lets you
   * sketch on a face of an existing body.
   */
  pickFacePlane(clientX: number, clientY: number): PlaneDef | null {
    if (!this.model) return null;
    const ray = this.rayFrom(clientX, clientY);
    const hits = ray.intersectObject(this.model.mesh, false);
    const hit = hits[0];
    if (!hit || !hit.face) return null;
    const mesh = this.model.mesh;
    const pos = mesh.geometry.getAttribute("position");
    const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a);
    const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b);
    const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
    const normal = b.sub(a).cross(c.sub(a)).normalize().transformDirection(mesh.matrixWorld).normalize();
    const faceId = this.model.faceIds[hit.faceIndex ?? 0] ?? 0;
    const origin = this.faceCentroidWorld(faceId);
    const ref =
      Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const xdir = ref.sub(normal.clone().multiplyScalar(ref.dot(normal))).normalize();
    return {
      origin: [origin.x, origin.y, origin.z],
      normal: [normal.x, normal.y, normal.z],
      xdir: [xdir.x, xdir.y, xdir.z],
    };
  }

  /** Edge-only pick for the fillet/chamfer edge-selection tools. */
  pickEdgeAt(clientX: number, clientY: number): EdgeHit | null {
    if (!this.model) return null;
    const rect = this.canvas.getBoundingClientRect();
    return this.picker.pickEdge(clientX, clientY, rect, this.rig.active, this.model, this.resolution);
  }

  /** Face pick for the Press/Pull tool: raycast the solid and return a face
   *  selector (nearest-to-the-clicked-point, so it survives topology renumbering),
   *  the world-space surface normal at the hit, and the hit point itself (used as
   *  the drag anchor so the arrow pops out where you clicked). */
  pickFaceForPressPull(
    clientX: number,
    clientY: number,
  ): { selector: Selector; normal: THREE.Vector3; anchor: THREE.Vector3 } | null {
    if (!this.model) return null;
    const ray = this.rayFrom(clientX, clientY);
    const hit = ray.intersectObject(this.model.mesh, false)[0];
    if (!hit || !hit.face) return null;
    const mesh = this.model.mesh;
    const pos = mesh.geometry.getAttribute("position");
    const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a);
    const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b);
    const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
    const normal = b.sub(a).cross(c.sub(a)).normalize().transformDirection(mesh.matrixWorld).normalize();
    const anchor = hit.point.clone();
    return {
      selector: { kind: "face", by: "nearest", point: [anchor.x, anchor.y, anchor.z] },
      normal,
      anchor,
    };
  }

  /** Hover-highlight a specific edge line (or clear with null). */
  hoverEdge(line: import("three/examples/jsm/lines/Line2.js").Line2 | null) {
    this.highlighter?.clearHover();
    if (line) this.highlighter?.hoverEdge(line);
  }

  /** Light up ALL model edges as "selectable" while the fillet/chamfer edge
   *  tool is active, so they're easy to see and target (Fusion-style): bright
   *  color + thicker lines. */
  emphasizeEdges(on: boolean) {
    this.highlighter?.setEdgeBase(on ? EDGE_PICKABLE : EDGE_IDLE);
    if (this.model) {
      for (const e of this.model.edges) (e.material as { linewidth: number }).linewidth = on ? 2.8 : 1.6;
    }
  }

  /** Raycast the solid and hover-highlight the face under the cursor; returns
   *  the faceId (for plane/offset face selection feedback). */
  hoverFaceAt(clientX: number, clientY: number): number | null {
    this.highlighter?.clearHover();
    if (!this.model) return null;
    const ray = this.rayFrom(clientX, clientY);
    const hit = ray.intersectObject(this.model.mesh, false)[0];
    if (!hit) return null;
    const faceId = this.model.faceIds[hit.faceIndex ?? 0] ?? 0;
    this.highlighter?.hoverFace(faceId);
    return faceId;
  }

  /** Clear any hover highlight (used when leaving an interactive pick mode). */
  clearHover() {
    this.highlighter?.clearHover();
  }

  private faceCentroidWorld(faceId: number): THREE.Vector3 {
    const mesh = this.model!.mesh;
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex()!;
    const ids = this.model!.faceIds;
    const acc = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const seen = new Set<number>();
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] !== faceId) continue;
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(t * 3 + k);
        if (seen.has(vi)) continue;
        seen.add(vi);
        acc.add(tmp.fromBufferAttribute(pos, vi));
      }
    }
    if (seen.size) acc.divideScalar(seen.size);
    return acc.applyMatrix4(mesh.matrixWorld);
  }

  /** Area-weighted average normal of a B-rep face (world space) — averaging its
   *  triangles' normals. For a planar face this is the exact normal; for a curved
   *  face it's a representative outward direction. */
  private faceNormalWorld(faceId: number): THREE.Vector3 {
    const mesh = this.model!.mesh;
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex()!;
    const ids = this.model!.faceIds;
    const acc = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] !== faceId) continue;
      a.fromBufferAttribute(pos, index.getX(t * 3));
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
      n.copy(b.sub(a).cross(c.sub(a))); // length = 2× triangle area → area-weighted
      acc.add(n);
    }
    if (acc.lengthSq() < 1e-12) acc.set(0, 0, 1);
    return acc.normalize().transformDirection(mesh.matrixWorld).normalize();
  }

  /** a reusable Raycaster aimed at the given client coords (no allocation) */
  private sharedRaycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  rayFrom(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.sharedRaycaster.setFromCamera(this.ndc, this.rig.active);
    return this.sharedRaycaster;
  }

  toggleProjection() {
    this.rig.toggleProjection();
  }

  setStandardView(v: StandardView) {
    // toolbar buttons + SpaceMouse route here; honor a redefined side so "Top"
    // means whatever the user mapped, not the world default.
    const side = v as ViewCubeSide;
    if (this.applyOverride(side)) return;
    this.rig.setStandardView(v);
  }

  // ---- ViewCube side application + redefinition ----------------------------

  /** Apply a cube side: a user override if one exists, else the default view. */
  private applyCubeSide(side: ViewCubeSide) {
    if (this.applyOverride(side)) return;
    this.rig.setStandardView(FACE_VIEWS[side].view);
  }

  /** If `side` has an override, orient that stored face toward the camera and
   *  return true; otherwise return false. */
  private applyOverride(side: ViewCubeSide): boolean {
    const ov = this.store?.viewOverrides?.[side];
    if (!ov) return false;
    const normal = new THREE.Vector3(...ov.normal);
    const up = new THREE.Vector3(...ov.up);
    this.rig.setViewDir(normal, up);
    return true;
  }

  /** Enter "pick a model face to redefine this cube side" mode. */
  private beginSetOverride(side: ViewCubeSide) {
    this.setOverrideSide = side;
    setPrompt(`Click a model face to set as "${FACE_VIEWS[side].label}" (Esc to cancel)`);
    // listen once for Escape to cancel
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.cancelSetOverride();
        window.removeEventListener("keydown", onKey);
      }
    };
    window.addEventListener("keydown", onKey);
  }

  private cancelSetOverride() {
    this.setOverrideSide = null;
    this.clearHover();
    setPrompt(null);
  }

  /** Capture the clicked model face's plane as the active side's override. */
  private captureOverrideFace(e: PointerEvent) {
    const side = this.setOverrideSide!;
    const plane = this.pickFacePlane(e.clientX, e.clientY);
    if (!plane) {
      setPrompt("No face there — click a model face (Esc to cancel)");
      return;
    }
    // store the face normal (faces the camera when this side is applied) and an
    // up derived from the face's in-plane x axis (xdir × normal = in-plane up).
    const normal = new THREE.Vector3(...plane.normal).normalize();
    const xdir = new THREE.Vector3(...plane.xdir).normalize();
    const up = new THREE.Vector3().crossVectors(normal, xdir).normalize();
    if (up.lengthSq() < 1e-6) up.set(0, 0, 1);
    this.store?.setViewOverride(side, {
      normal: [normal.x, normal.y, normal.z],
      up: [up.x, up.y, up.z],
    });
    this.cube.refreshOverrideMarks();
    this.cancelSetOverride();
    // immediately snap to the newly-defined side so the user sees the result
    this.applyCubeSide(side);
  }

  clearSelection() {
    this.highlighter?.clearSelection();
    this.onSelectionChange?.();
  }

  // --- accessors + helpers for the sketch system ---
  get camera(): THREE.Camera {
    return this.rig.active;
  }
  get domElement(): HTMLCanvasElement {
    return this.canvas;
  }
  addToScene(obj: THREE.Object3D) {
    this.scene.scene.add(obj);
  }
  removeFromScene(obj: THREE.Object3D) {
    this.scene.scene.remove(obj);
  }

  private projScratch = new THREE.Vector3();
  /** project a world point to screen pixels (client coords) */
  projectToScreen(world: THREE.Vector3): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const v = this.projScratch.copy(world).project(this.rig.active);
    return {
      x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
    };
  }

  /** unproject screen (client) coords onto a plane; null if no hit */
  screenToPlane(
    clientX: number,
    clientY: number,
    plane: THREE.Plane,
  ): THREE.Vector3 | null {
    const ray = this.rayFrom(clientX, clientY).ray;
    const out = new THREE.Vector3();
    return ray.intersectPlane(plane, out) ? out : null;
  }

  enterSketchView(origin: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3) {
    this.rig.lookAtPlane(origin, normal, up);
    this.setModelDimmed(true);
  }
  exitSketchView() {
    this.rig.restoreUp();
    this.setModelDimmed(false);
  }

  setModelDimmed(on: boolean) {
    if (!this.model) return;
    const mat = this.model.mesh.material as THREE.MeshStandardMaterial;
    mat.transparent = on;
    mat.opacity = on ? 0.25 : 1;
    mat.depthWrite = !on;
    for (const e of this.model.edges) {
      (e.material as any).opacity = on ? 0.3 : 1;
      (e.material as any).transparent = true;
    }
  }

  /** world-space size of one screen pixel at a given world point (for glyphs) */
  pixelWorldSize(at: THREE.Vector3): number {
    const rect = this.canvas.getBoundingClientRect();
    const cam = this.rig.active;
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const oc = cam as THREE.OrthographicCamera;
      return (oc.top - oc.bottom) / oc.zoom / rect.height;
    }
    const pc = cam as THREE.PerspectiveCamera;
    const dist = pc.position.distanceTo(at);
    return (2 * Math.tan((pc.fov * Math.PI) / 180 / 2) * dist) / rect.height;
  }

  /** A clean drag/cursor snap step (nice 1/2/5 mm) for the current zoom at a world
   *  point, so manipulator + sketch values read 5/1/0.5/0.1 mm, not 0.3425. */
  snapStep(at: THREE.Vector3): number {
    return niceStep(this.pixelWorldSize(at) * 8); // ~8px granularity
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.scene.renderer.setSize(w, h, false);
    this.rig.resize(w, h);
    // LineMaterial.resolution must be in CSS pixels: that's the space its
    // `linewidth` and the Line2 raycast threshold are measured in. (Using the
    // DPR-scaled size made fat-line edges thin AND shrank the edge-pick hit
    // radius by the device pixel ratio.)
    this.resolution.set(w, h);
    setEdgeResolution(this.model, this.resolution);
  }

  private scratchTarget = new THREE.Vector3();
  private loop = () => {
    // Never let a single bad frame kill the loop: if any step throws, log and
    // keep scheduling, so a transient camera/geometry glitch can't freeze the
    // whole app (the rAF used to be unreachable after a throw).
    try {
      const dt = this.clock.getDelta();
      void this.store; // lazily wire the store subscription once it exists
      // The ViewCube drives the camera through camera-controls' own animated
      // setLookAt, so we just always advance the controls — no busy/adopt dance.
      this.rig.update(dt);
      // keep the ground grid spacing/extent matched to the current zoom + pan
      const t = this.rig.controls.getTarget(this.scratchTarget);
      this.scene.grid.update(t.x, t.y, this.pixelWorldSize(t));
      this.scene.renderer.render(this.scene.scene, this.rig.active);
      this.cube.render(this.rig.active); // draw the ViewCube overlay in the corner
    } catch (e) {
      console.error("[viewport] render loop frame error (continuing):", e);
    }
    requestAnimationFrame(this.loop);
  };
}
