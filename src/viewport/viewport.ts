// Viewport orchestrator: owns the scene, camera rig, render loop, ViewCube,
// the current model view, picking + highlighting. Exposes a small API the rest
// of the app uses: setModel(), fit(), pick callbacks, projection/view toggles.

import * as THREE from "three";
import { createScene, type SceneBundle } from "./scene";
import { createCameraRig, type CameraRig, type StandardView } from "./cameras";
import { buildModel, disposeModel, setEdgeResolution, BASE_COLOR, type ModelView } from "./render";
import { makeZebraMaterial, buildCurvatureCombs } from "./overlays";
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
  // Z the ground grid sits at: the model's lowest point (so the grid is always a
  // floor under the model), or 0 (world XY) when the document is empty.
  private targetGridZ = 0;
  private clock = new THREE.Clock();
  private resolution = new THREE.Vector2();
  // persistent construction/datum planes (translucent quads, click to select)
  private datumGroup = new THREE.Group();
  private datumQuads: THREE.Mesh[] = [];
  private selectedDatum: string | null = null;
  private dragMoved = false;
  private downPos = { x: 0, y: 0 };
  // "redefine cube side from a model face" pick mode (null = not active)
  private setOverrideSide: ViewCubeSide | null = null;

  onHit: ((hit: Hit | null, shiftKey: boolean) => void) | null = null;
  onSelectionChange: (() => void) | null = null; // fired when edge/face selection changes
  onPickDatum: ((id: string) => void) | null = null; // fired when a datum plane quad is clicked
  // SOLID-mode selection of a visible sketch's profile areas (set by the app).
  // regionPickAt: click-select the region under the cursor (true if one was hit,
  // so face/body picking is skipped). regionHoverAt: hover-highlight it.
  regionPickAt: ((clientX: number, clientY: number, additive: boolean) => boolean) | null = null;
  regionHoverAt: ((clientX: number, clientY: number) => boolean) | null = null;
  onBodySelectionChange: (() => void) | null = null; // fired when the body selection changes
  // "faces" = pick faces/edges (default); "bodies" = pick whole bodies (to move).
  private selectionMode: "faces" | "bodies" = "faces";
  suspendPicking = false;
  // until the user drives the camera, the model is kept auto-framed on resize —
  // this catches the canvas layout settling a frame or two after the first fit
  // (common under remote desktops / fractional scaling), which would otherwise
  // leave the model rendered off-centre and un-aimable.
  private userMovedCamera = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = createScene(canvas);
    this.scene.scene.add(this.datumGroup);
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
    // Re-measure on ANY canvas size change, not just window resizes: the initial
    // layout often settles a frame or two after construction (especially under
    // remote desktops / fractional scaling), and without this the camera keeps a
    // stale aspect and the first fit lands the model off-screen.
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    // once the user drives the camera (orbit/pan/zoom), stop auto-framing.
    this.rig.controls.addEventListener("controlstart", () => {
      this.userMovedCamera = true;
    });
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
        this.userMovedCamera = true;
        // zoom toward what's under the cursor (Fusion-style), not the orbit centre
        this.rig.zoomBy(Math.pow(1.0016, dy), this.cursorWorldPoint(e.clientX, e.clientY));
      },
      { passive: false },
    );
  }

  /** World point under the cursor for zoom-to-cursor: the model surface hit if the
   *  cursor is over it, else a point on the cursor ray at the current orbit-target
   *  distance (so zooming over empty space still tracks the cursor direction). */
  private cursorWorldPoint(clientX: number, clientY: number): THREE.Vector3 {
    const rc = this.rayFrom(clientX, clientY);
    if (this.model) {
      const hit = rc.intersectObject(this.model.mesh, false)[0];
      if (hit) return hit.point.clone();
    }
    const cam = this.rig.controls.getPosition(new THREE.Vector3());
    const target = this.rig.controls.getTarget(new THREE.Vector3());
    const dist = cam.distanceTo(target);
    return rc.ray.origin.clone().add(rc.ray.direction.clone().multiplyScalar(dist));
  }

  private handleHover(e: PointerEvent) {
    // while redefining a cube side, hover-highlight the model face under the
    // cursor (so the user sees which face they'll capture).
    if (this.setOverrideSide) {
      this.hoverFaceAt(e.clientX, e.clientY);
      return;
    }
    if (this.suspendPicking) return;
    if (this.selectionMode === "bodies") return; // no face hover while picking bodies
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
    if (hit?.kind === "edge") { this.highlighter.hoverEdge(hit.line); this.regionHoverAt?.(-1, -1); return; }
    if (hit?.kind === "face") { this.highlighter.hoverFace(hit.faceId); this.regionHoverAt?.(-1, -1); return; }
    // no solid edge/face under the cursor → a visible sketch's region may be (clicking
    // through a hole, or with the body hidden). The face ALWAYS wins when present.
    this.regionHoverAt?.(e.clientX, e.clientY);
  }

  private handleClick(e: PointerEvent) {
    if (this.suspendPicking) return;
    const rect = this.canvas.getBoundingClientRect();

    // --- Bodies mode: a click selects the WHOLE body under the cursor ---
    if (this.selectionMode === "bodies" && this.model && this.highlighter) {
      const fh = this.rayFrom(e.clientX, e.clientY).intersectObject(this.model.mesh, false)[0];
      const bodyId = fh ? this.faceIdToBodyId(this.model.faceIds[fh.faceIndex ?? 0] ?? 0) : null;
      const add = e.ctrlKey || e.metaKey;
      if (bodyId) {
        if (add) this.highlighter.toggleSelectBody(bodyId);
        else this.highlighter.selectOnlyBody(bodyId);
      } else if (!add) {
        this.highlighter.clearBodySelection();
      }
      this.onBodySelectionChange?.();
      return;
    }

    const hit = this.model
      ? this.picker.pick(e.clientX, e.clientY, rect, this.rig.active, this.model, this.resolution)
      : null;
    // A solid FACE always wins. Only when nothing solid is under the cursor (clicking
    // through a honeycomb hole, or with the body hidden) does a click select a visible
    // sketch's profile area — so face selection (delete/press-pull) keeps working with
    // a sketch shown.
    if (!hit && this.regionPickAt?.(e.clientX, e.clientY, e.ctrlKey || e.metaKey || e.shiftKey)) return;
    // a click on a construction plane (where it doesn't overlap the body) selects it
    if (!hit && this.datumQuads.length) {
      const dh = this.rayFrom(e.clientX, e.clientY).intersectObjects(this.datumQuads, false)[0];
      if (dh) {
        this.onPickDatum?.(dh.object.userData.datumId as string);
        return;
      }
    }
    if (!this.model) return;
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

  // ---- Bodies selection mode + body helpers --------------------------------

  setSelectionMode(m: "faces" | "bodies") {
    if (this.selectionMode === m) return;
    this.selectionMode = m;
    // switching clears the other kind of selection so paint never mixes
    if (m === "bodies") this.highlighter?.clearSelection();
    else {
      this.highlighter?.clearBodySelection();
      this.onBodySelectionChange?.();
    }
  }
  get selecting(): "faces" | "bodies" {
    return this.selectionMode;
  }

  /** which body owns a triangle's B-rep faceId (null if none). */
  faceIdToBodyId(faceId: number): string | null {
    for (const b of this.model?.bodies ?? []) {
      if (faceId >= b.faceStart && faceId < b.faceStart + b.faceCount) return b.id;
    }
    return null;
  }

  // --- face-color analysis overlays (Inspect) ---------------------------------
  // A view state painted into the per-face base color; it survives selection and
  // re-applies after each rebuild (setModel). "component" = one hue per body;
  // "draft" = overhang analysis: faces facing away from the build direction by
  // more than the threshold (measured from straight-down) are flagged red.
  analysis: "none" | "component" | "draft" = "none";
  // overhang config (transient view state, not persisted): build direction and
  // the support threshold in degrees from horizontal (45° = typical FDM default).
  private draftDir = new THREE.Vector3(0, 0, 1);
  private draftThreshold = 45;
  // per-body assigned colors (body id → hex) shown as the default base when no
  // analysis overlay is active; pushed from main.ts on color change + rebuild.
  private bodyPaint: Record<string, string> = {};
  // zebra-stripe + curvature-comb overlays (display-only; re-applied on rebuild)
  private zebra = false;
  private zebraMat: THREE.ShaderMaterial | null = null;
  private savedMat: THREE.Material | THREE.Material[] | null = null;
  private combs = false;
  private combsObj: THREE.LineSegments | null = null;

  setAnalysis(mode: "none" | "component" | "draft") {
    this.analysis = mode;
    this.applyAnalysis();
  }

  /** the current overhang build direction (as a sign+axis label) and threshold. */
  get draftConfig(): { dir: "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z"; threshold: number } {
    const v = this.draftDir;
    const dir = v.x > 0.5 ? "+X" : v.x < -0.5 ? "-X" : v.y > 0.5 ? "+Y" : v.y < -0.5 ? "-Y" : v.z < -0.5 ? "-Z" : "+Z";
    return { dir, threshold: this.draftThreshold };
  }

  /** reconfigure overhang analysis (build direction + threshold°) and repaint. */
  setDraftConfig(dir: "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z", threshold: number) {
    const map: Record<string, [number, number, number]> = {
      "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0], "+Z": [0, 0, 1], "-Z": [0, 0, -1],
    };
    this.draftDir.set(...map[dir]);
    this.draftThreshold = Math.max(0, Math.min(90, threshold));
    if (this.analysis === "draft") this.applyAnalysis();
  }

  private applyAnalysis() {
    if (!this.highlighter || !this.model) return;
    if (this.analysis === "component") {
      const hue = new Map<string, THREE.Color>();
      this.model.bodies.forEach((b, i) =>
        hue.set(b.id, new THREE.Color().setHSL((i * 0.137 + 0.05) % 1, 0.45, 0.55)),
      );
      this.highlighter.setBase((fid) => hue.get(this.faceIdToBodyId(fid) ?? "") ?? BASE_COLOR);
    } else if (this.analysis === "draft") {
      const B = this.draftDir;
      const OVERHANG = new THREE.Color(0xe24a3b); // unsupported overhang (red)
      const TOP = new THREE.Color(0x49c46a); // up-facing
      const WALL = new THREE.Color(0x4aa3e2); // wall / steep-enough downward
      // a downward face is an overhang when its angle from straight-down (β) is
      // below the threshold; β=0 is a flat ceiling (worst), β=90° is a vertical
      // wall (fine). Equivalent to slicers' "support below <threshold>°".
      this.highlighter.setBase((fid) => {
        const c = this.faceNormalWorld(fid).dot(B); // cos(angle to build dir)
        if (c >= -0.02) return c > 0.02 ? TOP : WALL; // up-facing or vertical
        const beta = Math.acos(Math.min(1, -c)) * (180 / Math.PI); // 0..90, 0 = straight down
        return beta < this.draftThreshold ? OVERHANG : WALL;
      });
    } else {
      // default appearance: assigned per-body colors, else the neutral shade
      this.highlighter.setBase((fid) => {
        const bid = this.faceIdToBodyId(fid);
        const hex = bid ? this.bodyPaint[bid] : undefined;
        return hex ? new THREE.Color(hex) : BASE_COLOR;
      });
    }
  }

  /** set the per-body assigned colors (body id → hex) and repaint if no analysis
   *  overlay is currently masking them. */
  setBodyPaint(map: Record<string, string>) {
    this.bodyPaint = map;
    if (this.analysis === "none") this.applyAnalysis();
  }

  /** Zebra-stripe continuity overlay: swaps the model material for a reflective
   *  striped shader (restored on toggle-off / re-applied after rebuild). */
  get zebraOn(): boolean {
    return this.zebra;
  }
  get combsOn(): boolean {
    return this.combs;
  }
  setZebra(on: boolean) {
    this.zebra = on;
    this.applyZebra();
  }
  private applyZebra() {
    if (!this.model) return;
    const mesh = this.model.mesh;
    if (this.zebra) {
      if (!this.zebraMat) this.zebraMat = makeZebraMaterial();
      if (mesh.material !== this.zebraMat) {
        this.savedMat = mesh.material;
        mesh.material = this.zebraMat;
      }
    } else if (this.zebraMat && mesh.material === this.zebraMat) {
      if (this.savedMat) mesh.material = this.savedMat;
      this.savedMat = null;
    }
  }

  /** Curvature-comb overlay along edges (rebuilt from the current model). */
  setCurvatureCombs(on: boolean) {
    this.combs = on;
    this.applyCombs();
  }
  private applyCombs() {
    if (this.combsObj) {
      this.scene.modelGroup.remove(this.combsObj);
      this.combsObj.geometry.dispose();
      (this.combsObj.material as THREE.Material).dispose();
      this.combsObj = null;
    }
    if (this.combs && this.model) {
      const seg = buildCurvatureCombs(this.model, this.model.box);
      if (seg) {
        this.combsObj = seg;
        this.scene.modelGroup.add(seg);
      }
    }
  }

  getSelectedBodies(): string[] {
    return this.highlighter?.getSelectedBodies() ?? [];
  }

  /** set the body selection from outside (e.g. the browser tree). */
  setSelectedBodies(ids: string[]) {
    if (!this.highlighter) return;
    this.highlighter.clearBodySelection();
    for (const id of ids) this.highlighter.toggleSelectBody(id);
    this.onBodySelectionChange?.();
  }

  /** right-click hit-test against the construction-plane quads. */
  pickDatumAt(clientX: number, clientY: number): string | null {
    if (!this.datumQuads.length) return null;
    const dh = this.rayFrom(clientX, clientY).intersectObjects(this.datumQuads, false)[0];
    return dh ? (dh.object.userData.datumId as string) : null;
  }

  /** centroid (world) of the given bodies' vertices — the Move gizmo anchor. */
  bodiesCentroid(ids: string[]): THREE.Vector3 {
    const out = new THREE.Vector3();
    if (!this.model) return out;
    const set = new Set(ids);
    const ranges = this.model.bodies.filter((b) => set.has(b.id));
    if (!ranges.length) return out;
    const inRange = (fid: number) =>
      ranges.some((r) => fid >= r.faceStart && fid < r.faceStart + r.faceCount);
    const pos = this.model.mesh.geometry.getAttribute("position");
    const index = this.model.mesh.geometry.getIndex()!;
    const fids = this.model.faceIds;
    const seen = new Set<number>();
    const tmp = new THREE.Vector3();
    let n = 0;
    for (let t = 0; t < fids.length; t++) {
      if (!inRange(fids[t])) continue;
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        if (seen.has(v)) continue;
        seen.add(v);
        out.add(tmp.fromBufferAttribute(pos, v));
        n++;
      }
    }
    if (n) out.divideScalar(n);
    return out.applyMatrix4(this.model.mesh.matrixWorld);
  }

  /** True if (clientX,clientY) is over the ViewCube corner — so a right-click
   *  there belongs to the cube, not the model. */
  cubeHitsRegion(clientX: number, clientY: number): boolean {
    return this.cube.hitsRegion(clientX, clientY);
  }

  /** Render the document's datum/construction planes as translucent quads that
   *  can be clicked to select (and then cut by). */
  setDatumPlanes(
    planes: { id: string; origin: [number, number, number]; normal: [number, number, number] }[],
  ) {
    for (const q of this.datumQuads) {
      this.datumGroup.remove(q);
      q.geometry.dispose();
      (q.material as THREE.Material).dispose();
    }
    this.datumQuads = [];
    const up = new THREE.Vector3(0, 0, 1);
    for (const p of planes) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xb98cff, // construction-plane lilac
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), mat);
      m.position.set(p.origin[0], p.origin[1], p.origin[2]);
      m.quaternion.setFromUnitVectors(
        up,
        new THREE.Vector3(p.normal[0], p.normal[1], p.normal[2]).normalize(),
      );
      m.renderOrder = -1;
      m.userData.datumId = p.id;
      this.datumGroup.add(m);
      this.datumQuads.push(m);
    }
    this.highlightDatum(this.selectedDatum);
  }

  /** Brighten the selected construction plane; others stay faint. */
  highlightDatum(id: string | null) {
    this.selectedDatum = id;
    for (const q of this.datumQuads) {
      (q.material as THREE.MeshBasicMaterial).opacity =
        q.userData.datumId === id ? 0.32 : 0.12;
    }
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

  /** Pre-selection for Press/Pull: return a selector for EACH selected face (one
   *  by:"nearest" per face so refs survive renumbering), plus the normal/centroid
   *  of the first face to anchor the drag arrow. Null if nothing is selected. */
  selectedFacesForPressPull(): { selectors: Selector[]; faceIds: number[]; normal: THREE.Vector3; anchor: THREE.Vector3; bodyId: string | null } | null {
    if (!this.highlighter || !this.model) return null;
    const faces = this.highlighter.getSelectedFaces();
    if (faces.length === 0) return null;
    const selectors: Selector[] = faces.map((fid) => {
      const c = this.faceCentroidWorld(fid);
      return { kind: "face", by: "nearest", point: [c.x, c.y, c.z] };
    });
    const first = faces[0];
    return {
      selectors,
      faceIds: [...faces],
      normal: this.faceNormalWorld(first),
      anchor: this.faceCentroidWorld(first),
      bodyId: this.faceIdToBodyId(first),
    };
  }

  setModel(result: RebuildResult, fit = false, hiddenBodies: string[] = []) {
    // dispose previous model first (full-rebuild memory hygiene)
    if (this.model) {
      this.scene.modelGroup.remove(this.model.mesh);
      for (const e of this.model.edges) this.scene.modelGroup.remove(e);
      disposeModel(this.model);
    }
    this.model = buildModel(result, this.resolution, hiddenBodies);
    this.scene.modelGroup.add(this.model.mesh);
    for (const e of this.model.edges) this.scene.modelGroup.add(e);
    this.highlighter = new Highlighter(this.model);
    this.targetGridZ = this.model.box.min.z; // drop the grid to the model's floor
    this.applyAnalysis(); // paints the analysis overlay, or assigned body colors when "none"
    if (this.zebra) this.applyZebra();
    if (this.combs) this.applyCombs();
    if (fit) this.rig.fit(this.model.box, true);
  }

  clearModel() {
    if (!this.model) return;
    this.scene.modelGroup.remove(this.model.mesh);
    for (const e of this.model.edges) this.scene.modelGroup.remove(e);
    disposeModel(this.model);
    this.model = null;
    this.highlighter = null;
    this.targetGridZ = 0; // no model → grid back on the world XY plane
    this.savedMat = null; // its material died with the model
    if (this.combsObj) {
      this.scene.modelGroup.remove(this.combsObj);
      this.combsObj.geometry.dispose();
      (this.combsObj.material as THREE.Material).dispose();
      this.combsObj = null;
    }
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

  /** Brighten the plane under the cursor during plane-pick (null = none). */
  hoverPlane(kind: Plane3 | null) {
    for (const k of ["XY", "XZ", "YZ"] as Plane3[]) {
      const m = this.scene.planes[k];
      if (!m.visible) continue;
      (m.material as THREE.MeshBasicMaterial).opacity = k === kind ? 0.36 : 0.14;
    }
  }

  /**
   * Raycast the three plane quads and return the plane whose surface is nearest
   * the camera under the cursor — i.e. the one you're pointing at.
   * `intersectObjects` returns hits sorted nearest-first, so hits[0] is it.
   */
  pickPlane(clientX: number, clientY: number): Plane3 | null {
    this.rayFrom(clientX, clientY);
    const meshes = (["XY", "XZ", "YZ"] as Plane3[]).map((k) => this.scene.planes[k]);
    const hits = this.sharedRaycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    return (hits[0].object.userData.plane as Plane3) ?? null;
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

  // --- Measure (Inspect): pick a face/edge and read its size ----------------

  /** Pick the face or edge under the cursor (face-vs-edge gated like selection). */
  pickEntity(clientX: number, clientY: number): Hit | null {
    if (!this.model) return null;
    const rect = this.canvas.getBoundingClientRect();
    return this.picker.pick(clientX, clientY, rect, this.rig.active, this.model, this.resolution);
  }

  /** World-space area (mm²) of a B-rep face = Σ its triangle areas. */
  faceArea(faceId: number): number {
    const mesh = this.model!.mesh;
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex()!;
    const ids = this.model!.faceIds;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let area = 0;
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] !== faceId) continue;
      a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mesh.matrixWorld);
      area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    }
    return area;
  }

  /** Face readout: area + world centroid + outward normal. */
  measureFace(faceId: number): { area: number; centroid: THREE.Vector3; normal: THREE.Vector3 } {
    return {
      area: this.faceArea(faceId),
      centroid: this.faceCentroidWorld(faceId),
      normal: this.faceNormalWorld(faceId),
    };
  }

  /** Highlight exactly these faces + edges (used by the Measure tool). */
  measureHighlight(
    faceIds: number[],
    lines: import("three/examples/jsm/lines/Line2.js").Line2[],
  ) {
    this.highlighter?.clearSelection();
    for (const f of faceIds) this.highlighter?.toggleSelectFace(f);
    for (const l of lines) this.highlighter?.toggleSelectEdge(l);
  }

  /** Smart select (Plasticity-style): select every face coplanar with the given
   *  one. Switches to face mode, clears the current selection, selects the set,
   *  fires onSelectionChange. Returns the count selected. */
  selectCoplanarFaces(faceId: number): number {
    if (!this.model || !this.highlighter) return 0;
    this.setSelectionMode("faces");
    const n0 = this.faceNormalWorld(faceId);
    const c0 = this.faceCentroidWorld(faceId);
    const d0 = n0.dot(c0); // plane offset along the normal
    const diag = this.model.box.getSize(new THREE.Vector3()).length() || 1;
    const tol = 1e-3 * diag + 1e-4;
    this.highlighter.clearSelection();
    let count = 0;
    for (const fid of new Set(this.model.faceIds)) {
      const n = this.faceNormalWorld(fid);
      if (n.dot(n0) < 0.999) continue; // parallel + same facing
      if (Math.abs(n.dot(this.faceCentroidWorld(fid)) - d0) > tol) continue; // same plane
      this.highlighter.toggleSelectFace(fid);
      count++;
    }
    this.onSelectionChange?.();
    return count;
  }

  /** Section/clip: clip the model (faces + edges) by a plane, or clear with null.
   *  Lost on the next rebuild (materials are recreated) — fine for an interactive
   *  section that you set, look at, then close. */
  setClipPlane(plane: THREE.Plane | null) {
    this.scene.renderer.localClippingEnabled = !!plane;
    const planes = plane ? [plane] : null;
    if (this.model) {
      (this.model.mesh.material as THREE.Material).clippingPlanes = planes;
      for (const e of this.model.edges)
        (e.material as unknown as { clippingPlanes: THREE.Plane[] | null }).clippingPlanes = planes;
    }
  }

  /** The model's world bounding box (for placing the section plane), or null. */
  modelBox(): THREE.Box3 | null {
    return this.model?.box ?? null;
  }

  /** Mass/geometry properties of the given bodies (or the whole model if null),
   *  computed from the tessellation: volume + center of mass (divergence theorem
   *  over the triangles), surface area, and bounding box. */
  bodyProperties(
    ids: string[] | null,
  ): { volume: number; area: number; com: THREE.Vector3; bbox: THREE.Box3; names: string[] } | null {
    if (!this.model) return null;
    const all = this.model.bodies;
    const ranges = ids && ids.length ? all.filter((b) => ids.includes(b.id)) : all;
    const inRange = (fid: number) =>
      ranges.length === 0 || ranges.some((r) => fid >= r.faceStart && fid < r.faceStart + r.faceCount);
    const pos = this.model.mesh.geometry.getAttribute("position");
    const index = this.model.mesh.geometry.getIndex()!;
    const fids = this.model.faceIds;
    const mw = this.model.mesh.matrixWorld;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const bbox = new THREE.Box3().makeEmpty();
    const com = new THREE.Vector3();
    let area = 0;
    let vol = 0;
    for (let t = 0; t < fids.length; t++) {
      if (!inRange(fids[t])) continue;
      a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw);
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw);
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw);
      bbox.expandByPoint(a);
      bbox.expandByPoint(b);
      bbox.expandByPoint(c);
      area += b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5;
      const v = a.dot(b.clone().cross(c)) / 6; // signed tet (origin,a,b,c) volume
      vol += v;
      com.addScaledVector(a.clone().add(b).add(c), v / 4); // tet centroid · weight
    }
    if (Math.abs(vol) > 1e-9) com.divideScalar(vol);
    return {
      volume: Math.abs(vol),
      area,
      com,
      bbox,
      names: (ids && ids.length ? all.filter((x) => ids.includes(x.id)) : all).map((x) => x.name),
    };
  }

  /** Face pick for the Press/Pull tool: raycast the solid and return a face
   *  selector (nearest-to-the-clicked-point, so it survives topology renumbering),
   *  the world-space surface normal at the hit, and the hit point itself (used as
   *  the drag anchor so the arrow pops out where you clicked). */
  pickFaceForPressPull(
    clientX: number,
    clientY: number,
  ): { selector: Selector; faceId: number; normal: THREE.Vector3; anchor: THREE.Vector3; bodyId: string | null } | null {
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
    const faceId = this.model.faceIds[hit.faceIndex ?? 0] ?? 0;
    return {
      selector: { kind: "face", by: "nearest", point: [anchor.x, anchor.y, anchor.z] },
      faceId,
      normal,
      anchor,
      bodyId: this.faceIdToBodyId(faceId),
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

  /** Select exactly the given B-rep face (clears any prior selection). Used by the
   *  right-click "Delete Face" menu so the face-delete path has a definite target. */
  selectOnlyFace(faceId: number) {
    this.highlighter?.clearSelection();
    this.highlighter?.toggleSelectFace(faceId);
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

  // --- Press/Pull ghost: an instant frontend-only preview of the extrude so the
  // drag feels immediate (the real OCCT result needs a full rebuild and only lands
  // on commit). For each selected face we offset its triangles by distance·normal
  // (the cap) and raise walls from the face's boundary edges → a translucent prism.
  private ppGhost: THREE.Mesh | null = null;
  setPressPullGhost(faceIds: number[], distance: number) {
    this.clearPressPullGhost();
    if (!this.model || faceIds.length === 0 || Math.abs(distance) < 1e-4) return;
    const mesh = this.model.mesh;
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex()!;
    const ids = this.model.faceIds;
    const mw = mesh.matrixWorld;
    const wv = (vi: number) => new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mw);
    const out: number[] = [];
    const push = (v: THREE.Vector3) => out.push(v.x, v.y, v.z);
    for (const faceId of faceIds) {
      const off = this.faceNormalWorld(faceId).multiplyScalar(distance);
      const tris: [number, number, number][] = [];
      for (let t = 0; t < ids.length; t++) {
        if (ids[t] === faceId) tris.push([index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)]);
      }
      if (!tris.length) continue;
      // cap (the face moved by `off`)
      for (const [i0, i1, i2] of tris) {
        push(wv(i0).add(off)); push(wv(i1).add(off)); push(wv(i2).add(off));
      }
      // boundary walls: an edge interior to the face appears in two triangles
      // (toggled out); a boundary edge appears once (kept).
      const edges = new Map<string, [number, number]>();
      const bump = (a: number, b: number) => {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [a, b]);
      };
      for (const [i0, i1, i2] of tris) { bump(i0, i1); bump(i1, i2); bump(i2, i0); }
      for (const [a, b] of edges.values()) {
        const A = wv(a), B = wv(b);
        const Ao = A.clone().add(off), Bo = B.clone().add(off);
        push(A); push(B); push(Bo);
        push(A); push(Bo); push(Ao);
      }
    }
    if (!out.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
    const mat = new THREE.MeshBasicMaterial({
      color: distance >= 0 ? 0xffc83d : 0xff6b5c, // amber = add, red = cut
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ppGhost = new THREE.Mesh(geo, mat);
    this.ppGhost.renderOrder = 998;
    this.addToScene(this.ppGhost);
  }
  clearPressPullGhost() {
    if (!this.ppGhost) return;
    this.removeFromScene(this.ppGhost);
    this.ppGhost.geometry.dispose();
    (this.ppGhost.material as THREE.Material).dispose();
    this.ppGhost = null;
  }

  // --- Move ghost: translate the selected bodies' mesh + edges live during a drag,
  // with NO sidecar rebuild (a rigid move needs no geometry recompute) — so dragging
  // is snappy. The real `move` feature is committed on release. We move the moved
  // bodies' vertices in place and offset their edge-line objects; cancel restores.
  private moveGhost: { verts: number[]; orig: Float32Array; edges: import("three/examples/jsm/lines/Line2.js").Line2[] } | null = null;
  beginBodyMoveGhost(bodyIds: string[]) {
    this.endBodyMoveGhost(true);
    if (!this.model) return;
    const sel = new Set(bodyIds);
    const ranges = this.model.bodies
      .filter((b) => sel.has(b.id))
      .map((b) => [b.faceStart, b.faceStart + b.faceCount] as [number, number]);
    if (!ranges.length) return;
    const inSel = (fid: number) => ranges.some(([s, e]) => fid >= s && fid < e);
    const geo = this.model.mesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const index = geo.getIndex()!;
    const ids = this.model.faceIds;
    const vset = new Set<number>();
    for (let t = 0; t < ids.length; t++) {
      if (!inSel(ids[t])) continue;
      vset.add(index.getX(t * 3));
      vset.add(index.getX(t * 3 + 1));
      vset.add(index.getX(t * 3 + 2));
    }
    const verts = [...vset];
    const orig = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
      orig[i * 3] = pos.getX(verts[i]);
      orig[i * 3 + 1] = pos.getY(verts[i]);
      orig[i * 3 + 2] = pos.getZ(verts[i]);
    }
    const edges = this.model.edges.filter((e) => sel.has(e.userData.body as string));
    this.moveGhost = { verts, orig, edges };
  }
  setBodyMoveOffset(offset: THREE.Vector3) {
    if (!this.moveGhost || !this.model) return;
    const pos = this.model.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const { verts, orig, edges } = this.moveGhost;
    for (let i = 0; i < verts.length; i++) {
      pos.setXYZ(verts[i], orig[i * 3] + offset.x, orig[i * 3 + 1] + offset.y, orig[i * 3 + 2] + offset.z);
    }
    pos.needsUpdate = true;
    for (const e of edges) e.position.copy(offset);
  }
  endBodyMoveGhost(restore: boolean) {
    if (!this.moveGhost || !this.model) {
      this.moveGhost = null;
      return;
    }
    if (restore) {
      const pos = this.model.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      const { verts, orig, edges } = this.moveGhost;
      for (let i = 0; i < verts.length; i++) {
        pos.setXYZ(verts[i], orig[i * 3], orig[i * 3 + 1], orig[i * 3 + 2]);
      }
      pos.needsUpdate = true;
      for (const e of edges) e.position.set(0, 0, 0);
    }
    this.moveGhost = null;
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
    // Flat, orthographic view for 2D precision (no perspective convergence). Capture
    // the prior projection ONCE so re-orienting (Look At) mid-sketch doesn't lose it.
    if (!this.sketchOrtho) {
      this.sketchPrevOrtho = this.rig.isOrtho();
      if (!this.rig.isOrtho()) this.rig.toggleProjection();
      this.sketchOrtho = true;
    }
    this.scene.grid.group.visible = false; // hide the world ground grid; only the sketch grid shows
    this.setModelDimmed(true);
  }
  exitSketchView() {
    if (this.sketchOrtho) {
      if (this.rig.isOrtho() !== this.sketchPrevOrtho) this.rig.toggleProjection(); // restore projection
      this.sketchOrtho = false;
    }
    this.scene.grid.group.visible = true;
    this.rig.restoreUp();
    this.setModelDimmed(false);
  }
  private sketchPrevOrtho = false;
  private sketchOrtho = false; // currently in the sketch's forced flat (ortho) view

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
    // Keep the model framed while the user hasn't taken over the camera. This is
    // what corrects an off-centre first fit once the canvas size finally settles
    // (the actual cause of "the model renders in the corner and I can't aim at
    // it" under remote desktops / fractional scaling).
    if (this.model && !this.userMovedCamera && w > 10 && h > 10) {
      this.rig.fit(this.model.box, false);
    }
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
      this.scene.grid.update(t.x, t.y, this.pixelWorldSize(t), this.targetGridZ);
      this.scene.renderer.render(this.scene.scene, this.rig.active);
      this.cube.render(this.rig.active); // draw the ViewCube overlay in the corner
    } catch (e) {
      console.error("[viewport] render loop frame error (continuing):", e);
    }
    requestAnimationFrame(this.loop);
  };
}
