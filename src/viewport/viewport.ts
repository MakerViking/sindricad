// Viewport orchestrator: owns the scene, camera rig, render loop, ViewCube,
// the current model view, picking + highlighting. Exposes a small API the rest
// of the app uses: setModel(), fit(), pick callbacks, projection/view toggles.

import * as THREE from "three";
import { createScene, type SceneBundle } from "./scene";
import {
  createCameraRig,
  type CameraRig,
  type StandardView,
  type ProjectionMode,
} from "./cameras";
import {
  buildBodyMesh,
  buildEdgeLines,
  bodyOfFace,
  disposeBody,
  disposeModel,
  faceIdOfHit,
  groupEdgesByBody,
  resetBodyAppearance,
  setEdgeResolution,
  visibleBodyMeshes,
  BASE_COLOR,
  type BodyMesh,
  type ModelView,
} from "./render";
import { disposeObject } from "./dispose";
import { makeZebraMaterial, buildCurvatureCombs } from "./overlays";
import { Picker, type Hit, type EdgeHit } from "./picking";
import { ViewCube, FACE_VIEWS } from "./viewCube";
import { setPrompt } from "../ui/prompt";
import type { DocumentStore } from "../document/store";
import type { ViewCubeSide } from "../types";

const EDGE_IDLE = new THREE.Color(0x1b1f24); // normal dark edge
const EDGE_PICKABLE = new THREE.Color(0xd98a4a); // muted ember "selectable" edge (fillet/chamfer mode)
import { Highlighter } from "./highlight";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";
import { nearestEdgeByMid, midMatchTol } from "./edgeMatch";
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
  // Right-click context menu: fires only on a genuine right-CLICK (press +
  // release without movement — right-drag is camera pan). `shouldOpenContextMenu`
  // is the app-level gate: when it returns false (a tool or sketch owns the
  // gesture) the event is left completely alone, no preventDefault.
  onContextClick: ((x: number, y: number) => void) | null = null;
  shouldOpenContextMenu: (() => boolean) | null = null;
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
  // Render-on-demand: the loop only draws when something is actually dirty —
  // the camera moved (rig.update's own return), a mutation flagged us via
  // requestRender(), or we're still in the few-frame "linger" window after one
  // (covers effects that settle a frame late, e.g. a texture upload). Starts
  // dirty so the very first frame after construction paints.
  private needsRender = true;
  private lingerFrames = 3;

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = createScene(canvas);
    this.scene.scene.add(this.datumGroup);
    const rect = canvas.getBoundingClientRect();
    this.rig = createCameraRig(canvas, rect.width / rect.height);

    this.cube = new ViewCube(canvas, this.scene.renderer, {
      applySide: (side) => this.applyCubeSide(side),
      applyDir: (dir, up) => { this.rig.setViewDir(dir, up); this.requestRender(); },
      getOverrides: () => this.store?.viewOverrides ?? {},
      beginSetOverride: (side) => this.beginSetOverride(side),
      resetOverride: (side) => {
        this.store?.setViewOverride(side, null);
        this.cube.refreshOverrideMarks();
        this.requestRender();
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
      this.requestRender();
    });
    this.installPointer();
    this.loop();
  }

  /** Mark the next few frames dirty so the render loop actually draws them.
   *  Call this from any method that changes what's on screen but doesn't move
   *  the camera (rig.update()'s own "moved" return already covers camera
   *  motion/inertia/transitions). The 3-frame linger absorbs effects that
   *  settle a frame late (e.g. a texture/geometry upload finishing async). */
  requestRender() {
    this.needsRender = true;
    this.lingerFrames = 3;
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
      // Unconditional (not just when handleHover's own hover-paint fires below):
      // the ViewCube (not one of our owned files) also hover-highlights off this
      // same canvas's pointermove, with no callback into the Viewport — so a cube
      // hover-in/out needs a render even when handleHover early-returns (no
      // model, suspended picking, bodies-selection mode, etc).
      this.requestRender();
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
    // Right-click → onContextClick, but ONLY on a click (press + release
    // without movement) — right-DRAG is camera pan (mouseButtons.right =
    // TRUCK). WebKit fires `contextmenu` while the button is still down: the
    // click then waits for the release; a platform that fires it after the
    // release delivers immediately. Same shape as the left-click guard above.
    let rightDown: { x: number; y: number } | null = null;
    let rightDrag = false; // did this right-press move far enough to be a pan?
    let menuPending = false; // contextmenu seen mid-press → deliver on release
    c.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 2) return;
        rightDown = { x: e.clientX, y: e.clientY };
        rightDrag = false;
        menuPending = false;
      },
      true,
    );
    c.addEventListener(
      "pointermove",
      (e) => {
        if (rightDown && !rightDrag && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) > 5) rightDrag = true;
      },
      true,
    );
    c.addEventListener(
      "pointerup",
      (e) => {
        if (e.button !== 2 || !rightDown) return;
        const at = rightDown;
        rightDown = null;
        if (menuPending && !rightDrag) this.onContextClick?.(at.x, at.y);
        menuPending = false;
      },
      true,
    );
    c.addEventListener("contextmenu", (e) => {
      if (!this.onContextClick) return;
      if (!(this.shouldOpenContextMenu?.() ?? true)) return; // a tool/sketch owns the gesture
      if (this.cubeHitsRegion(e.clientX, e.clientY)) return; // ViewCube owns its corner
      e.preventDefault();
      if (e.buttons & 2) menuPending = true; // fired on press → wait for the release
      else if (!rightDrag) this.onContextClick(e.clientX, e.clientY); // fired on release
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
        // zoom toward what's under the cursor (MCAD-style), not the orbit centre
        this.rig.zoomBy(Math.pow(1.0016, dy), this.cursorWorldPoint(e.clientX, e.clientY));
        this.requestRender();
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
      const hit = rc.intersectObjects(visibleBodyMeshes(this.model), false)[0];
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
    );
    this.highlighter.clearHover();
    this.requestRender();
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
      const bodyId = this.bodyIdAt(e.clientX, e.clientY);
      const add = e.ctrlKey || e.metaKey;
      if (bodyId) {
        if (add) this.highlighter.toggleSelectBody(bodyId);
        else this.highlighter.selectOnlyBody(bodyId);
      } else if (!add) {
        this.highlighter.clearBodySelection();
      }
      this.onBodySelectionChange?.();
      this.requestRender();
      return;
    }

    const hit = this.model
      ? this.picker.pick(e.clientX, e.clientY, rect, this.rig.active, this.model)
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
    // Ctrl/Cmd-click adds to the selection; a plain click replaces it (mainstream MCAD).
    const add = e.ctrlKey || e.metaKey;
    if (this.highlighter) {
      if (!add) this.highlighter.clearSelection();
      if (hit?.kind === "edge") this.highlighter.toggleSelectEdge(hit.line);
      else if (hit?.kind === "face") this.highlighter.toggleSelectFace(hit.faceId);
      this.requestRender();
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
    this.requestRender();
  }
  get selecting(): "faces" | "bodies" {
    return this.selectionMode;
  }

  /** which body owns a triangle's B-rep faceId (null if none). */
  faceIdToBodyId(faceId: number): string | null {
    if (!this.model) return null;
    return bodyOfFace(this.model, faceId)?.id ?? null;
  }

  /** The body under the cursor via a plain mesh raycast (no edge priority) —
   *  exactly how bodies-mode click-select resolves, so the right-click body
   *  menu agrees with a left-click at the same pixel. */
  bodyIdAt(clientX: number, clientY: number): string | null {
    if (!this.model) return null;
    const fh = this.rayFrom(clientX, clientY).intersectObjects(visibleBodyMeshes(this.model), false)[0];
    return fh ? this.faceIdToBodyId(faceIdOfHit(fh)) : null;
  }

  private psRay = new THREE.Raycaster();
  // a diagonal probe direction: never coplanar with the model's axis-aligned
  // faces, so the parity count can't graze along a face and miscount.
  private psDir = new THREE.Vector3(0.5773, 0.5772, 0.5774).normalize();
  /** True when world point `p` is INSIDE a solid body — an even/odd parity ray
   *  cast against the merged (closed, manifold) body mesh: an odd number of
   *  crossings means the point is enclosed. False when there's no model. Used by
   *  Extrude to tell whether pushing along a direction enters material (→ Cut) or
   *  leaves it (→ Join). A heuristic: the sidecar boolean guard is the authority. */
  pointInSolid(p: THREE.Vector3): boolean {
    if (!this.model) return false;
    this.psRay.set(p, this.psDir);
    this.psRay.near = 0;
    this.psRay.far = Infinity;
    return this.psRay.intersectObjects(visibleBodyMeshes(this.model), false).length % 2 === 1;
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
  // per-body original material, saved while zebra is on (keyed by body id since
  // each body now owns its own mesh/material instead of one shared mesh).
  private savedMats = new Map<string, THREE.Material | THREE.Material[]>();
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
    this.requestRender();
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
    if (this.zebra) {
      if (!this.zebraMat) this.zebraMat = makeZebraMaterial();
      for (const b of this.model.bodies) {
        if (b.mesh.material !== this.zebraMat) {
          this.savedMats.set(b.id, b.mesh.material);
          b.mesh.material = this.zebraMat;
        }
      }
    } else if (this.zebraMat) {
      for (const b of this.model.bodies) {
        if (b.mesh.material === this.zebraMat) {
          const saved = this.savedMats.get(b.id);
          if (saved) b.mesh.material = saved;
        }
      }
      this.savedMats.clear();
    }
    this.requestRender();
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
    this.requestRender();
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
    this.requestRender();
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
    const bodies = this.model.bodies.filter((b) => set.has(b.id));
    if (!bodies.length) return out;
    // each body's own buffer already holds only its own (deduped) vertices, so
    // this can walk every vertex directly instead of scanning triangles with a
    // seen-set — the merged-mesh version needed the seen-set to dedupe a vertex
    // shared by multiple triangles; a per-body buffer has no such duplicates.
    const tmp = new THREE.Vector3();
    let n = 0;
    for (const body of bodies) {
      const pos = body.mesh.geometry.getAttribute("position");
      for (let v = 0; v < pos.count; v++) {
        out.add(tmp.fromBufferAttribute(pos, v).applyMatrix4(body.mesh.matrixWorld));
        n++;
      }
    }
    if (n) out.divideScalar(n);
    return out;
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
    this.requestRender();
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

  /** Find the rendered edge whose polyline midpoint is nearest `mid` (world
   *  units, model-scaled tolerance) — the rebuild-stable way to re-locate an
   *  edge a saved selector or a sidecar diagnostic refers to. */
  edgeLineByMid(mid: [number, number, number]): Line2 | null {
    if (!this.model) return null;
    const edges = this.model.edges.map((e) => ({ points: e.userData.points as [number, number, number][] }));
    const i = nearestEdgeByMid(edges, mid, midMatchTol(this.model.box.getSize(this.projScratch).length()));
    return i == null ? null : this.model.edges[i];
  }

  /** Paint these edges as selected (used to pre-highlight a feature's saved
   *  member edges when re-opening it for editing). */
  selectEdgeLines(lines: Line2[]) {
    if (!this.highlighter) return;
    const already = new Set(this.highlighter.getSelectedEdges());
    for (const l of lines) if (!already.has(l)) this.highlighter.toggleSelectEdge(l);
    this.requestRender();
  }

  /** Paint the edges nearest these midpoints red (fillet/chamfer failures).
   *  Replaces the previous error set; pass [] to clear. Re-apply after each
   *  rebuild (setModel rebuilds the highlighter, wiping paint by design). */
  setErrorEdgeMids(mids: [number, number, number][]) {
    if (!this.highlighter) return;
    const lines: Line2[] = [];
    for (const mid of mids) {
      const l = this.edgeLineByMid(mid);
      if (l) lines.push(l);
    }
    this.highlighter.setErrorEdges(lines);
    this.requestRender();
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
    const hidden = new Set(hiddenBodies);
    const bodyMeta = result.bodies ?? [];
    const bodyIds = new Set(bodyMeta.map((b) => b.id));
    const { byBody, orphans } = groupEdgesByBody(result.edges, bodyIds);

    // bodies from the PREVIOUS model, keyed by id — consumed as we go; whatever
    // is left at the end no longer exists in this reply and gets disposed.
    const prevBodies = new Map<string, BodyMesh>(this.model?.bodies.map((b) => [b.id, b]) ?? []);
    const bodies: BodyMesh[] = [];
    for (const meta of bodyMeta) {
      const prev = prevBodies.get(meta.id);
      prevBodies.delete(meta.id);
      let body: BodyMesh;
      if (prev && meta.etag !== undefined && prev.etag === meta.etag) {
        // unchanged since the last reply — keep its GPU objects untouched, just
        // reset the transient display state a rebuild used to wipe for free.
        body = prev;
        resetBodyAppearance(body);
      } else {
        body = buildBodyMesh(result, meta, byBody.get(meta.id) ?? [], this.resolution, meta.etag);
        if (prev) {
          this.scene.modelGroup.remove(prev.mesh);
          for (const e of prev.edges) this.scene.modelGroup.remove(e);
          disposeBody(prev);
        }
        this.scene.modelGroup.add(body.mesh);
        for (const e of body.edges) this.scene.modelGroup.add(e);
      }
      body.mesh.visible = !hidden.has(meta.id);
      for (const e of body.edges) e.visible = body.mesh.visible;
      bodies.push(body);
    }
    // any body left in prevBodies is gone from this reply — dispose it
    for (const stale of prevBodies.values()) {
      this.scene.modelGroup.remove(stale.mesh);
      for (const e of stale.edges) this.scene.modelGroup.remove(e);
      disposeBody(stale);
    }

    // orphan edges (no owning body — see ModelView.orphanEdges) are rebuilt
    // fresh every call; there's no per-body cache key to reuse them by.
    if (this.model) for (const e of this.model.orphanEdges) { this.scene.modelGroup.remove(e); disposeObject(e); }
    const orphanEdges = buildEdgeLines(orphans, this.resolution);
    for (const e of orphanEdges) this.scene.modelGroup.add(e);

    const box = new THREE.Box3(new THREE.Vector3(...result.bbox.min), new THREE.Vector3(...result.bbox.max));
    const edges = bodies.flatMap((b) => b.edges).concat(orphanEdges);
    this.model = { bodies, edges, orphanEdges, box };

    this.hideFlushSeams();
    this.highlighter = new Highlighter(this.model);
    this.targetGridZ = this.model.box.min.z; // drop the grid to the model's floor
    this.applyAnalysis(); // paints the analysis overlay, or assigned body colors when "none"
    if (this.zebra) this.applyZebra();
    if (this.combs) this.applyCombs();
    if (fit) this.rig.fit(this.model.box, true);
  }

  /** Flush-seam hiding (display-only). A contact line between ALIGNED pieces —
   *  two mating bodies, or glued solids inside one body — reads as a scar
   *  across a continuous surface. Hide an edge when two DISTINCT coplanar,
   *  same-orientation planar faces sit on OPPOSITE SIDES of it (the surface
   *  provably continues across, checked against the actual triangles — so a
   *  hole rim, whose far side is empty space, can never be swallowed). A real
   *  step keeps its line: a visible seam now MEANS misalignment. */
  private hideFlushSeams() {
    const model = this.model;
    if (!model || !model.edges.length) return;

    // one pass over every body's own (already-isolated) index buffer: per-face
    // normal / plane point / bbox / planarity / triangle list (curved faces
    // never hide a seam). faceId is globally unique across bodies (the wire
    // protocol partitions it per body), so a single Map keyed by faceId still
    // spans the whole model correctly even though the triangles backing each
    // entry now live in several different BufferGeometries — this is what lets
    // a seam between two DIFFERENT mating bodies still hide, not just a seam
    // within one body's own faces.
    interface FInfo {
      planar: boolean;
      n: THREE.Vector3; p: THREE.Vector3;
      min: THREE.Vector3; max: THREE.Vector3;
      tris: { body: BodyMesh; t: number }[]; // (owning body, LOCAL triangle index)
    }
    const faces = new Map<number, FInfo>();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
    for (const body of model.bodies) {
      const pos = body.mesh.geometry.getAttribute("position");
      const index = body.mesh.geometry.getIndex()!;
      const ids = body.faceIds;
      const mw = body.mesh.matrixWorld;
      for (let t = 0; t < ids.length; t++) {
        a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw);
        b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw);
        c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw);
        n.copy(ab.copy(b).sub(a)).cross(ac.copy(c).sub(a));
        const len = n.length();
        let f = faces.get(ids[t]);
        if (!f) {
          f = {
            planar: true,
            n: len > 1e-9 ? n.clone().divideScalar(len) : new THREE.Vector3(),
            p: a.clone(), min: a.clone(), max: a.clone(), tris: [],
          };
          faces.set(ids[t], f);
        } else if (len > 1e-9 && f.n.lengthSq() > 0.5 && n.clone().divideScalar(len).dot(f.n) < 0.9998) {
          f.planar = false;
        } else if (len > 1e-9 && f.n.lengthSq() < 0.5) {
          f.n.copy(n).divideScalar(len);
        }
        f.tris.push({ body, t });
        for (const v of [a, b, c]) { f.min.min(v); f.max.max(v); }
      }
    }

    const TOL = 0.02;  // on-plane tolerance (mm) — flush contacts are exact
    const INFL = 0.5;  // bbox slack for candidate gathering
    const EPS = 0.3;   // side-sample offset from the edge (mm)
    const planar = [...faces.values()].filter((f) => f.planar && f.n.lengthSq() > 0.5);

    const tri = new THREE.Triangle();
    const closest = new THREE.Vector3();
    const contains = (f: FInfo, q: THREE.Vector3) => {
      if (
        q.x < f.min.x - EPS || q.x > f.max.x + EPS ||
        q.y < f.min.y - EPS || q.y > f.max.y + EPS ||
        q.z < f.min.z - EPS || q.z > f.max.z + EPS
      ) return false;
      for (const { body, t } of f.tris) {
        const pos = body.mesh.geometry.getAttribute("position");
        const index = body.mesh.geometry.getIndex()!;
        const mw = body.mesh.matrixWorld;
        tri.a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw);
        tri.b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw);
        tri.c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw);
        tri.closestPointToPoint(q, closest);
        if (closest.distanceTo(q) < 0.05) return true;
      }
      return false;
    };

    const lo = new THREE.Vector3(), hi = new THREE.Vector3();
    const m = new THREE.Vector3(), d = new THREE.Vector3(), s = new THREE.Vector3();
    const qPlus = new THREE.Vector3(), qMinus = new THREE.Vector3();
    for (const line of model.edges) {
      const pts = line.userData.points as [number, number, number][];
      if (!pts || pts.length < 2) continue;
      lo.set(Infinity, Infinity, Infinity);
      hi.set(-Infinity, -Infinity, -Infinity);
      for (const q of pts) {
        lo.x = Math.min(lo.x, q[0]); lo.y = Math.min(lo.y, q[1]); lo.z = Math.min(lo.z, q[2]);
        hi.x = Math.max(hi.x, q[0]); hi.y = Math.max(hi.y, q[1]); hi.z = Math.max(hi.z, q[2]);
      }
      // candidate faces: planar, edge lies in their plane, bbox borders the edge
      const cands: FInfo[] = [];
      for (const f of planar) {
        if (
          f.min.x - INFL > lo.x || f.max.x + INFL < hi.x ||
          f.min.y - INFL > lo.y || f.max.y + INFL < hi.y ||
          f.min.z - INFL > lo.z || f.max.z + INFL < hi.z
        ) continue;
        let on = true;
        for (const q of pts) {
          const dd =
            (q[0] - f.p.x) * f.n.x + (q[1] - f.p.y) * f.n.y + (q[2] - f.p.z) * f.n.z;
          if (Math.abs(dd) > TOL) { on = false; break; }
        }
        if (on) cands.push(f);
      }
      if (cands.length < 2) continue;

      // side samples at the edge midpoint, perpendicular to the edge IN the plane
      const k = Math.floor((pts.length - 1) / 2);
      m.set(
        (pts[k][0] + pts[k + 1][0]) / 2,
        (pts[k][1] + pts[k + 1][1]) / 2,
        (pts[k][2] + pts[k + 1][2]) / 2,
      );
      d.set(
        pts[k + 1][0] - pts[k][0],
        pts[k + 1][1] - pts[k][1],
        pts[k + 1][2] - pts[k][2],
      );
      if (d.lengthSq() < 1e-12) continue;
      d.normalize();
      s.crossVectors(d, cands[0].n).normalize();
      qPlus.copy(m).addScaledVector(s, EPS);
      qMinus.copy(m).addScaledVector(s, -EPS);

      // the surface continues across iff DISTINCT same-orientation faces own
      // the two sides (one face owning both = the edge wraps a slot/hole rim)
      let gPlus: FInfo | null = null;
      let gMinus: FInfo | null = null;
      for (const f of cands) if (contains(f, qPlus)) { gPlus = f; break; }
      for (const f of cands) if (contains(f, qMinus)) { gMinus = f; break; }
      if (gPlus && gMinus && gPlus !== gMinus && gPlus.n.dot(gMinus.n) > 0.999) {
        line.visible = false;
      }
    }
  }

  clearModel() {
    if (!this.model) return;
    for (const b of this.model.bodies) this.scene.modelGroup.remove(b.mesh);
    for (const e of this.model.edges) this.scene.modelGroup.remove(e);
    disposeModel(this.model);
    this.model = null;
    this.highlighter = null;
    this.targetGridZ = 0; // no model → grid back on the world XY plane
    this.savedMats.clear(); // materials died with the model
    if (this.combsObj) {
      this.scene.modelGroup.remove(this.combsObj);
      this.combsObj.geometry.dispose();
      (this.combsObj.material as THREE.Material).dispose();
      this.combsObj = null;
    }
    this.requestRender();
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
    this.requestRender();
  }

  /** Brighten the plane under the cursor during plane-pick (null = none). */
  hoverPlane(kind: Plane3 | null) {
    for (const k of ["XY", "XZ", "YZ"] as Plane3[]) {
      const m = this.scene.planes[k];
      if (!m.visible) continue;
      (m.material as THREE.MeshBasicMaterial).opacity = k === kind ? 0.36 : 0.14;
    }
    this.requestRender();
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
    const hits = ray.intersectObjects(visibleBodyMeshes(this.model), false);
    const hit = hits[0];
    if (!hit || !hit.face) return null;
    const mesh = hit.object as THREE.Mesh;
    const pos = mesh.geometry.getAttribute("position");
    const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a);
    const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b);
    const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
    const normal = b.sub(a).cross(c.sub(a)).normalize().transformDirection(mesh.matrixWorld).normalize();
    const faceId = faceIdOfHit(hit);
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
    return this.picker.pickEdge(clientX, clientY, rect, this.rig.active, this.model);
  }

  // --- Measure (Inspect): pick a face/edge and read its size ----------------

  /** Pick the face or edge under the cursor (face-vs-edge gated like selection). */
  pickEntity(clientX: number, clientY: number): Hit | null {
    if (!this.model) return null;
    const rect = this.canvas.getBoundingClientRect();
    return this.picker.pick(clientX, clientY, rect, this.rig.active, this.model);
  }

  /** World-space area (mm²) of a B-rep face = Σ its triangle areas. */
  faceArea(faceId: number): number {
    const body = this.model && bodyOfFace(this.model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return 0;
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const mw = body.mesh.matrixWorld;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let area = 0;
    for (const t of tris) {
      a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw);
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw);
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw);
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

  /** All world-space triangles of a B-rep face — the Measure tool's raw
   *  material for true shortest-distance computation. */
  faceTriangles(faceId: number): THREE.Triangle[] {
    const out: THREE.Triangle[] = [];
    const body = this.model && bodyOfFace(this.model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return out;
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const mw = body.mesh.matrixWorld;
    for (const t of tris) {
      const tri = new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw),
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw),
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw),
      );
      out.push(tri);
    }
    return out;
  }

  /** Hover-highlight whatever a pick returned (Measure aiming feedback). */
  hoverEntity(hit: import("./picking").Hit | null) {
    this.highlighter?.clearHover();
    if (!hit) { this.requestRender(); return; }
    if (hit.kind === "edge") this.highlighter?.hoverEdge(hit.line);
    else this.highlighter?.hoverFace(hit.faceId);
    this.requestRender();
  }

  /** Transient marker line between the two closest points of a measure pair
   *  (pass null to clear). Drawn on top so it reads through the model. */
  setMeasureMarker(a: THREE.Vector3 | null, b?: THREE.Vector3) {
    if (this.measureLine) {
      this.scene.scene.remove(this.measureLine);
      this.measureLine.geometry.dispose();
      (this.measureLine.material as THREE.Material).dispose();
      this.measureLine = null;
    }
    if (!a || !b) { this.requestRender(); return; }
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffc24a,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    this.measureLine = new THREE.Line(geo, mat);
    this.measureLine.renderOrder = 999;
    this.scene.scene.add(this.measureLine);
    this.requestRender();
  }
  private measureLine: THREE.Line | null = null;

  /** Highlight exactly these faces + edges (used by the Measure tool). */
  measureHighlight(
    faceIds: number[],
    lines: import("three/examples/jsm/lines/Line2.js").Line2[],
  ) {
    this.highlighter?.clearSelection();
    for (const f of faceIds) this.highlighter?.toggleSelectFace(f);
    for (const l of lines) this.highlighter?.toggleSelectEdge(l);
    this.requestRender();
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
    for (const body of this.model.bodies) {
      for (const fid of body.faceTriangles.keys()) {
        const n = this.faceNormalWorld(fid);
        if (n.dot(n0) < 0.999) continue; // parallel + same facing
        if (Math.abs(n.dot(this.faceCentroidWorld(fid)) - d0) > tol) continue; // same plane
        this.highlighter.toggleSelectFace(fid);
        count++;
      }
    }
    this.onSelectionChange?.();
    this.requestRender();
    return count;
  }

  /** Section/clip: clip the model (faces + edges) by a plane, or clear with null.
   *  Lost on the next rebuild (materials are recreated) — fine for an interactive
   *  section that you set, look at, then close. */
  setClipPlane(plane: THREE.Plane | null) {
    this.scene.renderer.localClippingEnabled = !!plane;
    const planes = plane ? [plane] : null;
    if (this.model) {
      for (const b of this.model.bodies) (b.mesh.material as THREE.Material).clippingPlanes = planes;
      for (const e of this.model.edges)
        (e.material as unknown as { clippingPlanes: THREE.Plane[] | null }).clippingPlanes = planes;
    }
    this.requestRender();
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
    const bodies = ids && ids.length ? all.filter((b) => ids.includes(b.id)) : all;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const bbox = new THREE.Box3().makeEmpty();
    const com = new THREE.Vector3();
    let area = 0;
    let vol = 0;
    for (const body of bodies) {
      const pos = body.mesh.geometry.getAttribute("position");
      const index = body.mesh.geometry.getIndex()!;
      const mw = body.mesh.matrixWorld;
      for (let t = 0; t < body.faceIds.length; t++) {
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
    }
    if (Math.abs(vol) > 1e-9) com.divideScalar(vol);
    return {
      volume: Math.abs(vol),
      area,
      com,
      bbox,
      names: bodies.map((x) => x.name),
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
    const hit = ray.intersectObjects(visibleBodyMeshes(this.model), false)[0];
    if (!hit || !hit.face) return null;
    const mesh = hit.object as THREE.Mesh;
    const pos = mesh.geometry.getAttribute("position");
    const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a);
    const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b);
    const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
    const normal = b.sub(a).cross(c.sub(a)).normalize().transformDirection(mesh.matrixWorld).normalize();
    const anchor = hit.point.clone();
    const faceId = faceIdOfHit(hit);
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
    this.requestRender();
  }

  /** Light up ALL model edges as "selectable" while the fillet/chamfer edge
   *  tool is active, so they're easy to see and target (MCAD-style): bright
   *  color + thicker lines. */
  emphasizeEdges(on: boolean) {
    this.highlighter?.setEdgeBase(on ? EDGE_PICKABLE : EDGE_IDLE);
    if (this.model) {
      for (const e of this.model.edges) (e.material as { linewidth: number }).linewidth = on ? 2.8 : 1.6;
    }
    this.requestRender();
  }

  /** Raycast the solid and hover-highlight the face under the cursor; returns
   *  the faceId (for plane/offset face selection feedback). */
  hoverFaceAt(clientX: number, clientY: number): number | null {
    this.highlighter?.clearHover();
    this.requestRender();
    if (!this.model) return null;
    const ray = this.rayFrom(clientX, clientY);
    const hit = ray.intersectObjects(visibleBodyMeshes(this.model), false)[0];
    if (!hit) return null;
    const faceId = faceIdOfHit(hit);
    this.highlighter?.hoverFace(faceId);
    return faceId;
  }

  /** Clear any hover highlight (used when leaving an interactive pick mode). */
  clearHover() {
    this.highlighter?.clearHover();
    this.requestRender();
  }

  private faceCentroidWorld(faceId: number): THREE.Vector3 {
    const acc = new THREE.Vector3();
    const body = this.model && bodyOfFace(this.model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return acc;
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const tmp = new THREE.Vector3();
    const seen = new Set<number>();
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(t * 3 + k);
        if (seen.has(vi)) continue;
        seen.add(vi);
        acc.add(tmp.fromBufferAttribute(pos, vi));
      }
    }
    if (seen.size) acc.divideScalar(seen.size);
    return acc.applyMatrix4(body.mesh.matrixWorld);
  }

  /** Area-weighted average normal of a B-rep face (world space) — averaging its
   *  triangles' normals. For a planar face this is the exact normal; for a curved
   *  face it's a representative outward direction. */
  private faceNormalWorld(faceId: number): THREE.Vector3 {
    const acc = new THREE.Vector3();
    const body = this.model && bodyOfFace(this.model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) { acc.set(0, 0, 1); return acc; }
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const t of tris) {
      a.fromBufferAttribute(pos, index.getX(t * 3));
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
      n.copy(b.sub(a).cross(c.sub(a))); // length = 2× triangle area → area-weighted
      acc.add(n);
    }
    if (acc.lengthSq() < 1e-12) acc.set(0, 0, 1);
    return acc.normalize().transformDirection(body.mesh.matrixWorld).normalize();
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

  cycleProjection(): ProjectionMode {
    const order: ProjectionMode[] = ["persp", "ortho", "auto"];
    const next =
      order[(order.indexOf(this.rig.projectionMode()) + 1) % order.length];
    this.rig.setProjectionMode(next);
    this.requestRender();
    return next;
  }

  setStandardView(v: StandardView) {
    // toolbar buttons + SpaceMouse route here; honor a redefined side so "Top"
    // means whatever the user mapped, not the world default.
    const side = v as ViewCubeSide;
    this.requestRender();
    if (this.applyOverride(side)) return;
    this.rig.setStandardView(v);
  }

  // ---- ViewCube side application + redefinition ----------------------------

  /** Apply a cube side: a user override if one exists, else the default view. */
  private applyCubeSide(side: ViewCubeSide) {
    this.requestRender();
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
    this.requestRender();
  }

  /** Select exactly the given B-rep face (clears any prior selection). Used by the
   *  right-click "Delete Face" menu so the face-delete path has a definite target. */
  selectOnlyFace(faceId: number) {
    this.highlighter?.clearSelection();
    this.highlighter?.toggleSelectFace(faceId);
    this.onSelectionChange?.();
    this.requestRender();
  }

  /** Select exactly the given edge line (clears any prior selection). Used by the
   *  right-click Fillet/Chamfer menu — the edge tools consume the pre-selection. */
  selectOnlyEdge(line: import("three/examples/jsm/lines/Line2.js").Line2) {
    this.highlighter?.clearSelection();
    this.highlighter?.toggleSelectEdge(line);
    this.onSelectionChange?.();
    this.requestRender();
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
    this.requestRender();
  }
  removeFromScene(obj: THREE.Object3D) {
    this.scene.scene.remove(obj);
    this.requestRender();
  }

  // --- Press/Pull ghost: an instant frontend-only preview of the extrude so the
  // drag feels immediate (the real OCCT result needs a full rebuild and only lands
  // on commit). For each selected face we offset its triangles by distance·normal
  // (the cap) and raise walls from the face's boundary edges → a translucent prism.
  private ppGhost: THREE.Mesh | null = null;
  setPressPullGhost(faceIds: number[], distance: number) {
    this.clearPressPullGhost();
    if (!this.model || faceIds.length === 0 || Math.abs(distance) < 1e-4) return;
    const out: number[] = [];
    const push = (v: THREE.Vector3) => out.push(v.x, v.y, v.z);
    for (const faceId of faceIds) {
      // per-body model: resolve the face's owning body and read its own buffers
      // (vertex indices below are body-local, consistent with wv()'s source).
      const body = bodyOfFace(this.model, faceId);
      const triIdx = body?.faceTriangles.get(faceId);
      if (!body || !triIdx || triIdx.length === 0) continue;
      const pos = body.mesh.geometry.getAttribute("position");
      const index = body.mesh.geometry.getIndex()!;
      const mw = body.mesh.matrixWorld;
      const wv = (vi: number) => new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mw);
      const off = this.faceNormalWorld(faceId).multiplyScalar(distance);
      const tris: [number, number, number][] = triIdx.map(
        (t) => [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)] as [number, number, number],
      );
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
    this.requestRender();
  }
  clearPressPullGhost() {
    if (!this.ppGhost) return;
    this.removeFromScene(this.ppGhost);
    this.ppGhost.geometry.dispose();
    (this.ppGhost.material as THREE.Material).dispose();
    this.ppGhost = null;
    this.requestRender();
  }

  // --- Move ghost: translate the selected bodies' mesh + edges live during a drag,
  // with NO sidecar rebuild (a rigid move needs no geometry recompute) — so dragging
  // is snappy. The real `move` feature is committed on release. With per-body meshes
  // this is a pure object-transform offset: zero vertex writes, zero GPU uploads.
  // Raycasts (bodyIdAt, pointInSolid parity) follow matrixWorld, refreshed eagerly
  // on every offset so picking never lags the visual. On commit (restore=false) the
  // offset stays until the rebuilt body arrives; the moved body's etag changes, so
  // setModel replaces its mesh (position 0) — and resetBodyAppearance() clears any
  // lingering offset on the reuse path as a belt-and-braces guard.
  private moveGhost: {
    bodies: BodyMesh[];
    edges: import("three/examples/jsm/lines/Line2.js").Line2[];
  } | null = null;
  beginBodyMoveGhost(bodyIds: string[]) {
    this.endBodyMoveGhost(true);
    if (!this.model) return;
    const sel = new Set(bodyIds);
    const bodies = this.model.bodies.filter((b) => sel.has(b.id));
    if (!bodies.length) return;
    const edges = this.model.edges.filter((e) => sel.has(e.userData.body as string));
    this.moveGhost = { bodies, edges };
  }
  setBodyMoveOffset(offset: THREE.Vector3) {
    if (!this.moveGhost || !this.model) return;
    for (const b of this.moveGhost.bodies) {
      b.mesh.position.copy(offset);
      b.mesh.updateMatrixWorld();
    }
    for (const e of this.moveGhost.edges) e.position.copy(offset);
    this.requestRender();
  }
  endBodyMoveGhost(restore: boolean) {
    if (!this.moveGhost || !this.model) {
      this.moveGhost = null;
      return;
    }
    if (restore) {
      for (const b of this.moveGhost.bodies) {
        b.mesh.position.set(0, 0, 0);
        b.mesh.updateMatrixWorld();
      }
      for (const e of this.moveGhost.edges) e.position.set(0, 0, 0);
      this.requestRender();
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
    // Flat, orthographic view for 2D precision (no perspective convergence). Force
    // 'ortho' MODE (not just a camera swap) so 'auto' can't flip back to perspective
    // on an off-axis sketch plane. Capture the prior mode ONCE so re-orienting
    // (Look At) mid-sketch doesn't lose it.
    if (!this.sketchOrtho) {
      this.sketchPrevMode = this.rig.projectionMode();
      this.rig.setProjectionMode("ortho");
      this.sketchOrtho = true;
    }
    this.scene.grid.group.visible = false; // hide the world ground grid; only the sketch grid shows
    this.setModelDimmed(true);
    this.requestRender();
  }
  exitSketchView() {
    if (this.sketchOrtho) {
      this.rig.setProjectionMode(this.sketchPrevMode); // restore projection mode
      this.sketchOrtho = false;
    }
    this.scene.grid.group.visible = true;
    this.rig.restoreUp();
    this.setModelDimmed(false);
    this.requestRender();
  }
  private sketchPrevMode: ProjectionMode = "auto";
  private sketchOrtho = false; // currently in the sketch's forced flat (ortho) view

  setModelDimmed(on: boolean) {
    if (!this.model) return;
    for (const b of this.model.bodies) {
      const mat = b.mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = on;
      mat.opacity = on ? 0.25 : 1;
      mat.depthWrite = !on;
    }
    for (const e of this.model.edges) {
      (e.material as any).opacity = on ? 0.3 : 1;
      (e.material as any).transparent = true;
    }
    this.requestRender();
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
    this.requestRender();
  }

  /** Capture the model view as a PNG data URL (publish cover, etc.). The
   *  renderer runs without preserveDrawingBuffer (scene.ts), so the buffer is
   *  only valid in the same task as a render call — render synchronously right
   *  before reading. Skips the ViewCube overlay for a clean shot; the next
   *  loop frame repaints it. */
  screenshotPNG(): string {
    this.scene.renderer.render(this.scene.scene, this.rig.active);
    const url = this.canvas.toDataURL("image/png");
    this.requestRender(); // repaint with the ViewCube overlay
    return url;
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
      // Always run this (needed for damping/transitions to progress); its
      // return says whether the camera actually moved this frame.
      const moved = this.rig.update(dt);
      // Render-on-demand: skip the (relatively expensive) grid rebuild + GPU
      // draw entirely when nothing changed — camera didn't move, no mutation
      // flagged requestRender(), and we've drained the post-mutation linger.
      if (moved || this.needsRender || this.lingerFrames > 0) {
        // keep the ground grid spacing/extent matched to the current zoom + pan
        const t = this.rig.controls.getTarget(this.scratchTarget);
        this.scene.grid.update(t.x, t.y, this.pixelWorldSize(t), this.targetGridZ);
        this.scene.renderer.render(this.scene.scene, this.rig.active);
        this.cube.render(this.rig.active); // draw the ViewCube overlay in the corner
        this.needsRender = false;
        if (this.lingerFrames > 0) this.lingerFrames--;
      }
    } catch (e) {
      console.error("[viewport] render loop frame error (continuing):", e);
    }
    requestAnimationFrame(this.loop);
  };
}
