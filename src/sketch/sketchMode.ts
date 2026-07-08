// The modal sketch environment: enter on a plane (camera squares to it, model
// dims, grid appears), draw Line/Rectangle/Circle interactively with snapping
// and on-canvas dimension input, then Finish to commit the sketch feature.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, PlaneSpec, SketchConstraint, SketchPattern } from "../types";
import { SketchPlane } from "./plane";
import { SketchOverlay, curveObjects, dimensionLineObjects, CURVE_COLOR, PREVIEW_COLOR, SELECT_COLOR } from "./overlay";
import { DimInput } from "./dimInput";
import { SketchDimensions } from "./sketchDimensions";
import { entityDims, type DimField } from "./entityDims";
import { pickEntity, trimEntity, filletCorner, offsetEntity, breakAt, extendLine } from "./modify";
import { newEntityId, newPatternId, notePatternId } from "./id";
import { circumcenter } from "./arc";
import { compileAndSolve } from "./sketchSolve";
import { resolveEntities, toSketchEntity } from "./resolve";
import { expandPattern } from "./pattern";
import { candidatesFromEntities, snap, type SnapKind, type SnapCandidate } from "./snap";
import type { ResolvedEntity } from "./snap";
import { detectRegions } from "./region";
import { setSpaceMouseOrbitLocked } from "../input/spacemouse";
import { setPrompt } from "../ui/prompt";
import { contextMenu, dismissContextMenu } from "../ui/menu";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "centerRectangle"
  | "circle"
  | "circle2"
  | "circle3"
  | "arc"
  | "spline"
  | "polygon"
  | "slot"
  | "point"
  | "mirror"
  | "dimension"
  | "trim"
  | "fillet"
  | "offset"
  | "extend"
  | "break"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "coincident"
  | "concentric"
  | "symmetric"
  | "midpoint"
  | "patternRect"
  | "patternCircular"
  | "hexHoles"
  | "honeycomb"
  | "boltCircle"
  | "gridHoles";

// preset hole patterns: self-contained (click a center, no source selection)
const PRESET_PATTERNS = new Set<SketchTool>(["hexHoles", "honeycomb", "boltCircle", "gridHoles"]);
// patterns that replicate the current selection (MCAD-style)
const ENTITY_PATTERNS = new Set<SketchTool>(["patternRect", "patternCircular"]);
// every pattern tool (presets + entity patterns)
const PATTERN_TOOLS = new Set<SketchTool>([...PRESET_PATTERNS, ...ENTITY_PATTERNS]);

const CONSTRAINT_TOOLS = new Set<SketchTool>([
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
  "tangent",
  "coincident",
  "concentric",
  "symmetric",
  "midpoint",
]);
const MODIFY_TOOLS = new Set<SketchTool>([
  "trim",
  "fillet",
  "offset",
  "extend",
  "break",
  "mirror",
  "dimension",
  ...CONSTRAINT_TOOLS,
]);

const GRID_STEP = 5;

export class SketchMode {
  active = false;
  tool: SketchTool = "select";
  onState: (() => void) | null = null; // notify UI (tool/active changed)

  private plane = new SketchPlane("XY");
  private entities: ResolvedEntity[] = [];
  private candidates: SnapCandidate[] = []; // cached; rebuilt when entities change
  private base: THREE.Vector2 | null = null; // pending first point
  private chainStart: THREE.Vector2 | null = null; // first point of a line chain
  private arcStart: THREE.Vector2 | null = null; // 3-point arc: start, end, then bulge
  private arcEnd: THREE.Vector2 | null = null;
  private splinePts: THREE.Vector2[] = []; // in-progress spline fit points
  private clickPts: THREE.Vector2[] = []; // accumulated clicks for multi-point primitives (polygon/slot/circle variants)
  private polygonSides = 6; // n for the polygon tool
  private filletFirst: number | null = null; // first line picked for a sketch fillet
  private selected = new Set<string>(); // selected entity ids (select tool)
  private constraints: SketchConstraint[] = []; // persistent constraints (solved)
  private patterns: SketchPattern[] = []; // associative pattern definitions
  private pendingPattern: SketchPattern | null = null; // one being placed (live)
  private patternCenter: THREE.Vector2 | null = null; // its center (first click)
  private editOriginal: SketchPattern | null = null; // when editing, the pre-edit copy (Esc restores)
  private lastDof = -1;
  private dragFrom: THREE.Vector2 | null = null; // grabbed point's current position
  private dragSnapshot: ResolvedEntity[] | null = null; // entities at drag start (Esc reverts)
  private pendingDrag: { fromX: number; fromY: number; toX: number; toY: number } | null = null;
  private solveBusy = false; // a solve is in flight (drag or constraint)
  private solveDirty = false; // a constraint/dimension solve is pending
  private entityVersion = 0; // bumped on every entity change; guards stale solves
  private conflict = false; // last solve reported conflicting (over-)constraints
  private lastCursor = new THREE.Vector2();
  private editingId: string | null = null;
  private store: DocumentStore | undefined;
  private grid: THREE.GridHelper | null = null;
  // Sketch Palette options
  private gridVisible = true;
  private gridSnap = true;
  private constructionMode = false;
  private dimsVisible = true;
  private viewLocked = true; // lock the camera square to the sketch plane
  private dim: DimInput;
  private dims: SketchDimensions;
  private boundDown: (e: PointerEvent) => void;
  private boundMove: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundContext: (e: MouseEvent) => void;

  constructor(
    private viewport: Viewport,
    private overlay: SketchOverlay,
  ) {
    this.dim = new DimInput();
    this.dims = new SketchDimensions(viewport, (i, f, mm) =>
      this.editDimension(i, f, mm),
    );
    this.boundDown = (e) => this.onPointerDown(e);
    this.boundMove = (e) => this.onPointerMove(e);
    this.boundUp = (e) => this.endDrag(e.pointerId);
    this.boundKey = (e) => this.onKey(e);
    this.boundContext = (e) => this.onContextMenu(e);
  }

  // --- lifecycle ---------------------------------------------------------
  enter(plane: PlaneSpec, store: DocumentStore, editId?: string) {
    this.active = true;
    this.editingId = editId ?? null;
    this.plane = this.overlay.planeFor(plane);
    this.store = store;

    // load existing entities if editing
    this.entities = [];
    this.constraints = [];
    this.patterns = [];
    this.pendingPattern = null;
    this.patternCenter = null;
    this.selected.clear();
    this.overlay.clearRegionSelection(); // fresh session: drop any stale area selection
    this.lastDof = -1;
    this.conflict = false;
    if (editId) {
      const f = store.document.features.find((x) => x.id === editId);
      if (f && f.type === "sketch") {
        this.entities = resolveEntities(f, store.document.parameters);
        this.constraints = f.constraints ? f.constraints.map((c) => ({ ...c })) : [];
        this.patterns = f.patterns ? f.patterns.map((p) => ({ ...p })) : [];
        for (const p of this.patterns) notePatternId(p.id); // reserve ids so new ones don't collide
      }
    }

    this.viewport.suspendPicking = true;
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.addGrid();

    const el = this.viewport.domElement;
    el.addEventListener("pointerdown", this.boundDown);
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerup", this.boundUp);
    el.addEventListener("contextmenu", this.boundContext);
    window.addEventListener("keydown", this.boundKey, true);

    this.overlay.update(store.document, this.editingId ?? "__active__");
    this.refreshActive();
    this.setTool("rectangle");
    this.setViewLocked(this.viewLocked); // apply lock-to-plane preference
    if (this.constraints.length > 0) this.requestSolve(); // restore DOF state
    this.onState?.();
  }

  finish(commit = true) {
    if (!this.active) return;
    const store = this.store!;
    if (this.pendingPattern) { this.patterns.push(this.pendingPattern); this.pendingPattern = null; }
    if (commit && (this.entities.length > 0 || this.patterns.length > 0)) {
      const sketch: Feature = {
        id: this.editingId ?? store.nextId(),
        type: "sketch",
        plane: this.plane.serialize(),
        entities: this.entities.map(toSketchEntity),
        ...(this.constraints.length > 0 ? { constraints: this.constraints.map((c) => ({ ...c })) } : {}),
        ...(this.patterns.length > 0 ? { patterns: this.patterns.map((p) => ({ ...p })) } : {}),
      };
      if (this.editingId) {
        store.replaceFeature(this.editingId, sketch);
      } else {
        store.addFeature(sketch);
      }
    }
    this.cleanup();
  }

  cancel() {
    this.cleanup();
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointerdown", this.boundDown);
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerup", this.boundUp);
    el.removeEventListener("contextmenu", this.boundContext);
    window.removeEventListener("keydown", this.boundKey, true);
    dismissContextMenu();
    this.selected.clear();
    this.dragFrom = null;
    this.dragSnapshot = null;
    this.pendingDrag = null;
    this.dim.hide();
    this.dims.hide();
    this.overlay.setPreview([]);
    this.overlay.setSnap(null);
    this.removeGrid();
    this.viewport.exitSketchView();
    this.viewport.rig.setOrbitLocked(false); // restore free orbit in model mode
    setSpaceMouseOrbitLocked(false);
    this.viewport.suspendPicking = false;
    this.active = false;
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.splinePts = [];
    this.clickPts = [];
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    this.tool = "select";
    this.overlay.setActiveSketch([]); // clear in-progress curves (else they orphan on screen)
    this.overlay.setActiveRegions([], this.plane); // drop active-sketch fills (committed ones re-render)
    if (this.store) this.overlay.update(this.store.document);
    this.onState?.();
  }

  // --- tools -------------------------------------------------------------
  setTool(t: SketchTool) {
    // Mirror operates on the current multi-selection, so keep it; every other
    // tool starts from a clean slate.
    const keepSelection = t === "mirror";
    this.tool = t;
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.splinePts = [];
    this.filletFirst = null;
    this.dragFrom = null;
    this.pendingDrag = null;
    this.dim.hide();
    this.overlay.setPreview([]);
    dismissContextMenu();
    this.clickPts = [];
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    if (!keepSelection && this.selected.size) { this.selected.clear(); this.refreshActive(); }
    if (this.pendingPattern) this.patterns.push(this.pendingPattern); // don't lose an in-progress pattern
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.onState?.();
  }

  /** Rebuild the active sketch's committed curves + snap candidates + editable
   * dimension labels. Called when the entity list changes — and on drag end. */
  private refreshActive() {
    this.entityVersion++; // bump guards in-flight constraint solves against staleness
    this.overlay.setActiveSketch(this.activeCurves());
    // profile-area fills for the active sketch (hidden from overlay.update),
    // so areas are visible + selectable while drawing
    this.overlay.setActiveRegions(
      detectRegions(this.editingId ?? "__active__", [...this.entities, ...this.derivedEntities()]),
      this.plane,
    );
    this.candidates = candidatesFromEntities(this.entities);
    if (this.dimsVisible) this.dims.show(this.entities, this.plane);
    else this.dims.hide();
  }

  /** Lightweight per-frame refresh for dragging: only the curve geometry moves,
   * so skip the snap-candidate array (snapping is off mid-drag) and the
   * dimension-label DOM teardown/rebuild. refreshActive() restores both on end. */
  private refreshDragGeometry() {
    this.entityVersion++;
    this.overlay.setActiveSketch(curveObjects(this.entities, this.plane, this.activeColor()));
  }

  // --- Sketch Palette options ---
  setGridVisible(on: boolean) {
    this.gridVisible = on;
    if (this.grid) this.grid.visible = on;
  }
  setGridSnap(on: boolean) {
    this.gridSnap = on;
  }
  setConstruction(on: boolean) {
    this.constructionMode = on;
  }
  setDimensionsVisible(on: boolean) {
    this.dimsVisible = on;
    this.refreshActive(); // toggles both the dimension lines and the value labels
  }
  /** Lock the camera square to the sketch plane: re-square now and disable orbit
   *  (mouse + SpaceMouse) so the view can't tilt off the plane. Unlock = free orbit. */
  setViewLocked(on: boolean) {
    this.viewLocked = on;
    if (on) this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.viewport.rig.setOrbitLocked(on);
    setSpaceMouseOrbitLocked(on);
  }
  /** re-square the camera to the active sketch plane (palette "Look At") */
  lookAt() {
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
  }

  /** Apply an edited dimension value (mm) to an entity. Line length and circle
   *  diameter become driving solver constraints (so other constraints are kept);
   *  everything else (rectangle W/H, line angle) edits coordinates directly. */
  private editDimension(index: number, field: DimField, mm: number) {
    const e = this.entities[index];
    if (!e) return;
    if (e.type === "line" && field === "length") {
      this.setDrivingDimension({ type: "distance", line: e.id, value: mm });
      return;
    }
    if (e.type === "circle" && field === "diameter") {
      this.setDrivingDimension({ type: "diameter", circle: e.id, value: mm });
      return;
    }
    entityDims(e).find((d) => d.field === field)?.write(mm);
    this.refreshActive();
  }

  /** Add/replace the driving dimension on an entity, then re-solve. */
  private setDrivingDimension(c: SketchConstraint) {
    this.constraints = this.constraints.filter((k) => {
      if (c.type === "distance" && k.type === "distance") return k.line !== c.line;
      if (c.type === "diameter" && k.type === "diameter") return k.circle !== c.circle;
      return true;
    });
    this.constraints.push(c);
    this.requestSolve();
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return; // left only; middle/right still navigate
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);
    if (!hit) return;
    e.preventDefault();
    const p = hit.p;

    if (this.tool === "select") {
      // grab a point to drag it — connected/constrained geometry follows
      const gp = this.pickPoint(p);
      if (gp) {
        this.dragFrom = gp.clone();
        this.dragSnapshot = JSON.parse(JSON.stringify(this.entities)); // for Esc-cancel revert
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // no draggable vertex under the cursor → (de)select the entity body / area
      const raw = this.planePoint(e) ?? p;
      // DOUBLE-click a pattern's derived copy → edit the owning pattern (associative).
      // A SINGLE click must NOT edit — it selects the cell's profile area for extrude
      // (the whole point of a patterned hole/cell, esp. a thin sub-area carved by a
      // crossing curve, which is always within pick-tolerance of an outline edge).
      const derived = this.derivedEntities();
      const di = pickEntity(derived, raw, this.pickTol());
      if (di >= 0 && e.detail >= 2) {
        this.editPattern(derived[di].id.split("#")[0]);
        return;
      }
      // a real (hand-drawn) entity's body under the cursor → (de)select it
      const idx = pickEntity(this.entities, raw, this.pickTol());
      if (idx >= 0) {
        const id = this.entities[idx].id;
        if (e.shiftKey) {
          if (!this.selected.delete(id)) this.selected.add(id);
        } else {
          this.selected = new Set([id]);
        }
        this.refreshActive();
        return;
      }
      // otherwise select a profile AREA to extrude — includes patterned cells and
      // sub-areas carved by a crossing curve
      const wr = this.overlay.activeRegionAt(raw);
      if (wr) {
        this.overlay.toggleRegionSelection(wr, e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      }
      // empty space → clear both entity and area selection
      if (!e.shiftKey) {
        this.selected.clear();
        this.overlay.clearRegionSelection();
      }
      this.refreshActive();
      return;
    }
    if (PATTERN_TOOLS.has(this.tool)) return this.patternClick(p);
    if (this.tool === "arc") return this.arcClick(p);
    if (this.tool === "spline") return this.splineClick(p);
    if (this.tool === "point") return this.pointClick(p);
    if (this.tool === "polygon") return this.polygonClick(p);
    if (this.tool === "slot") return this.slotClick(p);
    if (this.tool === "circle2") return this.circle2Click(p);
    if (this.tool === "circle3") return this.circle3Click(p);
    if (this.tool === "centerRectangle") return this.centerRectClick(p);
    if (this.tool === "mirror") return this.mirrorClick(p);
    if (this.tool === "dimension") return this.dimensionClick(p);
    if (this.tool === "trim") return this.trimClick(p);
    if (this.tool === "fillet") return this.filletClick(p);
    if (this.tool === "offset") return this.offsetClick(p);
    if (this.tool === "extend") return this.extendClick(p);
    if (this.tool === "break") return this.breakClick(p);
    if (CONSTRAINT_TOOLS.has(this.tool)) return this.constraintClick(p);

    if (!this.base) {
      this.base = p.clone();
      if (this.tool === "line") this.chainStart = p.clone(); // remember loop start
      this.showDimFields();
      return;
    }
    // second click → commit the entity using current dims
    this.commitFromCursor(p);
  }

  // 3-point arc: click start, click end, then click the point it passes through
  private arcClick(p: THREE.Vector2) {
    if (!this.arcStart) {
      this.arcStart = p.clone();
    } else if (!this.arcEnd) {
      this.arcEnd = p.clone();
    } else {
      const a = this.arcStart;
      const b = this.arcEnd;
      const ent: ResolvedEntity = {
        type: "arc",
        id: newEntityId(),
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        mx: p.x,
        my: p.y,
      };
      if (this.constructionMode) ent.construction = true;
      this.entities.push(ent);
      this.arcStart = null;
      this.arcEnd = null;
      this.refreshActive();
      this.overlay.setPreview([]);
      this.requestSolve(); // include the arc in the solve (updates DOF colour)
      this.onState?.();
    }
  }

  // MCAD-style fit-point spline: click to drop points; click the last point
  // again (or press Enter) to finish, Escape to cancel.
  private splineClick(p: THREE.Vector2) {
    const last = this.splinePts[this.splinePts.length - 1];
    if (last && last.distanceTo(p) < 1e-3) {
      this.finishSpline();
      return;
    }
    this.splinePts.push(p.clone());
  }

  private finishSpline() {
    if (this.splinePts.length >= 2) {
      const ent: ResolvedEntity = {
        type: "spline",
        id: newEntityId(),
        points: this.splinePts.map((q) => ({ x: q.x, y: q.y })),
      };
      if (this.constructionMode) ent.construction = true;
      this.entities.push(ent);
      this.refreshActive();
      this.requestSolve();
    }
    this.splinePts = [];
    this.overlay.setPreview([]);
    this.onState?.();
  }

  private splinePreview(cursor: THREE.Vector2) {
    if (!this.splinePts.length) return this.overlay.setPreview([]);
    const pts = [...this.splinePts.map((q) => ({ x: q.x, y: q.y })), { x: cursor.x, y: cursor.y }];
    this.overlay.setPreview([this.entityCurve({ type: "spline", id: "", points: pts })]);
  }

  /** rubber-band preview for the multi-click primitive tools */
  private multiClickPreview(cursor: THREE.Vector2) {
    const pv: ResolvedEntity[] = [];
    if (this.tool === "polygon" && this.clickPts.length === 1) {
      pv.push(...this.polygonLines(this.clickPts[0], cursor).map((e) => ({ ...e, id: "" })));
    } else if (this.tool === "slot") {
      if (this.clickPts.length === 1) {
        const a = this.clickPts[0];
        pv.push({ type: "line", id: "", x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y });
      } else if (this.clickPts.length === 2) {
        const [a, b] = this.clickPts;
        pv.push(...this.slotEntities(a, b, this.slotHalfWidth(a, b, cursor)));
      }
    } else if (this.tool === "circle2" && this.clickPts.length === 1) {
      const a = this.clickPts[0];
      const ctr = a.clone().add(cursor).multiplyScalar(0.5);
      pv.push({ type: "circle", id: "", radius: a.distanceTo(cursor) / 2, x: ctr.x, y: ctr.y });
    } else if (this.tool === "circle3") {
      if (this.clickPts.length === 1) {
        const a = this.clickPts[0];
        pv.push({ type: "line", id: "", x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y });
      } else if (this.clickPts.length === 2) {
        const cc = circumcenter(this.clickPts[0], this.clickPts[1], cursor);
        if (cc) pv.push({ type: "circle", id: "", radius: cc.distanceTo(cursor), x: cc.x, y: cc.y });
      }
    } else if (this.tool === "centerRectangle" && this.clickPts.length === 1) {
      const c = this.clickPts[0];
      const w = Math.abs(cursor.x - c.x) * 2, h = Math.abs(cursor.y - c.y) * 2;
      pv.push({ type: "rectangle", id: "", width: w, height: h, x: c.x, y: c.y });
    }
    this.overlay.setPreview(pv.map((e) => this.entityCurve(e)));
  }

  // --- point: a single click drops a reference/snap point ---------------
  private pointClick(p: THREE.Vector2) {
    const ent: ResolvedEntity = { type: "point", id: newEntityId(), x: p.x, y: p.y };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.overlay.setPreview([]);
    this.requestSolve();
    this.onState?.();
  }

  // --- patterns: click to place, drag to size, type counts, click to commit. Each
  // persists as an editable (associative) definition. Entity patterns (rect/circular)
  // replicate the current selection; presets emit holes. -------------------------
  private patternClick(p: THREE.Vector2) {
    if (!this.patternCenter) {
      if (ENTITY_PATTERNS.has(this.tool) && this.selected.size === 0) {
        setPrompt("Select entities first, then choose a pattern tool");
        return;
      }
      this.patternCenter = p.clone();
      this.pendingPattern = this.defaultPattern(this.tool, p);
      this.dim.show(this.patternDimDefs(this.pendingPattern.type), () => this.commitPattern());
      this.refreshActive();
      return;
    }
    this.commitPattern(); // second click commits
  }

  private defaultPattern(tool: SketchTool, c: THREE.Vector2): SketchPattern {
    const id = newPatternId();
    const sources = [...this.selected];
    if (tool === "boltCircle") return { id, type: "boltCircle", cx: c.x, cy: c.y, bcd: 40, count: 6, diameter: 6 };
    if (tool === "gridHoles") return { id, type: "gridHoles", cx: c.x, cy: c.y, diameter: 6, countX: 3, countY: 3, spacingX: 12, spacingY: 12 };
    if (tool === "hexHoles") return { id, type: "hexHoles", cx: c.x, cy: c.y, diameter: 6, spacing: 12, rings: 2 };
    if (tool === "honeycomb") return { id, type: "honeycomb", cx: c.x, cy: c.y, diameter: 12, spacing: 13, rings: 2 };
    if (tool === "patternCircular") return { id, type: "patternCircular", sources, cx: c.x, cy: c.y, count: 6, angle: 360 };
    return { id, type: "patternRect", sources, countX: 3, countY: 1, spacingX: 15, spacingY: 15 }; // patternRect
  }

  private patternDimDefs(type: SketchPattern["type"]) {
    if (type === "boltCircle") return [{ name: "count", label: "N" }, { name: "diameter", label: "⌀" }];
    if (type === "gridHoles") return [{ name: "countX", label: "Nx" }, { name: "countY", label: "Ny" }, { name: "diameter", label: "⌀" }];
    if (type === "hexHoles" || type === "honeycomb") return [{ name: "rings", label: "Rings" }, { name: "diameter", label: "⌀" }];
    if (type === "patternCircular") return [{ name: "count", label: "N" }, { name: "angle", label: "∠", kind: "angle" as const }];
    return [{ name: "countX", label: "Nx" }, { name: "countY", label: "Ny" }]; // patternRect
  }

  /** Live sizing: cursor offset/distance from the start point drives the spatial
   *  param (bolt dia / spacing / grid-step); typed fields drive counts/angle. */
  private patternMove(p: THREE.Vector2, e: PointerEvent) {
    if (!this.patternCenter || !this.pendingPattern) return;
    const pat = this.pendingPattern;
    const dx = p.x - this.patternCenter.x, dy = p.y - this.patternCenter.y;
    const r = Math.hypot(dx, dy);
    const dimN = (name: string, fallback: number) => Math.round(this.dim.getValue(name) ?? fallback);
    if (pat.type === "boltCircle") {
      if (r > 1) pat.bcd = Math.round(2 * r * 10) / 10;
      pat.count = Math.max(1, dimN("count", pat.count as number));
      pat.diameter = this.dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "gridHoles") {
      if (r > 1) pat.spacingX = pat.spacingY = Math.round((r / 1.5) * 10) / 10;
      pat.countX = Math.max(1, dimN("countX", pat.countX as number));
      pat.countY = Math.max(1, dimN("countY", pat.countY as number));
      pat.diameter = this.dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "hexHoles" || pat.type === "honeycomb") {
      if (r > 1) pat.spacing = Math.round((r / 2) * 10) / 10;
      pat.rings = Math.max(0, dimN("rings", pat.rings as number));
      pat.diameter = this.dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "patternRect") {
      // cursor offset from the start point = the spacing vector (the second instance)
      if (Math.abs(dx) > 1) pat.spacingX = Math.round(dx * 10) / 10;
      if (Math.abs(dy) > 1) pat.spacingY = Math.round(dy * 10) / 10;
      pat.countX = Math.max(1, dimN("countX", pat.countX as number));
      pat.countY = Math.max(1, dimN("countY", pat.countY as number));
    } else if (pat.type === "patternCircular") {
      pat.count = Math.max(1, dimN("count", pat.count as number));
      pat.angle = this.dim.getValue("angle") ?? (pat.angle as number);
    }
    this.dim.position(e.clientX, e.clientY);
    this.refreshActive();
  }

  private commitPattern() {
    if (!this.pendingPattern) return;
    this.patterns.push(this.pendingPattern);
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.dim.hide();
    setPrompt(null);
    if (this.selected.size) this.selected.clear(); // the pattern now owns the copies
    this.setTool("select"); // finish: one pattern per invocation (refreshes + notifies)
  }

  /** Associative editing: re-open an existing pattern's placement flow with its
   *  current values, so dragging/typing re-derives it live. Esc restores it. */
  private editPattern(patId: string) {
    const i = this.patterns.findIndex((p) => p.id === patId);
    if (i < 0) return;
    const pat = this.patterns[i];
    this.patterns.splice(i, 1); // pull it out; commit/cancel puts it back
    this.editOriginal = { ...pat };
    this.pendingPattern = pat;
    this.patternCenter = new THREE.Vector2(
      "cx" in pat ? (pat.cx as number) : 0,
      "cy" in pat ? (pat.cy as number) : 0,
    );
    this.tool = pat.type;
    const cur: Record<string, number> = {};
    for (const d of this.patternDimDefs(pat.type)) cur[d.name] = (pat as unknown as Record<string, number>)[d.name];
    this.dim.show(this.patternDimDefs(pat.type), () => this.commitPattern());
    this.dim.updateFromCursor(cur);
    setPrompt("Edit the pattern — drag/type to change · click to commit · Delete to remove · Esc to keep");
    this.refreshActive();
    this.onState?.();
  }


  private polygonClick(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      return;
    }
    const center = this.clickPts[0];
    this.commitPolygon(center, p);
    this.clickPts = [];
    this.overlay.setPreview([]);
  }
  /** the n line entities of an inscribed regular polygon (first vertex at `vertex`) */
  private polygonLines(center: THREE.Vector2, vertex: THREE.Vector2): ResolvedEntity[] {
    const n = Math.max(3, this.polygonSides);
    const r = center.distanceTo(vertex);
    if (r < 1e-4) return [];
    const a0 = Math.atan2(vertex.y - center.y, vertex.x - center.x);
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2;
      pts.push(new THREE.Vector2(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r));
    }
    const out: ResolvedEntity[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      out.push({ type: "line", id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    return out;
  }
  private commitPolygon(center: THREE.Vector2, vertex: THREE.Vector2) {
    const lines = this.polygonLines(center, vertex);
    if (!lines.length) return;
    for (const l of lines) {
      l.id = newEntityId();
      if (this.constructionMode) l.construction = true;
      this.entities.push(l);
    }
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- slot: two center points, then a width point → rounded slot --------
  private slotClick(p: THREE.Vector2) {
    if (this.clickPts.length < 2) {
      this.clickPts.push(p.clone());
      return;
    }
    // third click sets the half-width (distance from the slot axis)
    const [a, b] = this.clickPts;
    const w = this.slotHalfWidth(a, b, p);
    this.commitSlot(a, b, w);
    this.clickPts = [];
    this.overlay.setPreview([]);
  }
  private slotHalfWidth(a: THREE.Vector2, b: THREE.Vector2, cursor: THREE.Vector2): number {
    const dir = b.clone().sub(a);
    const len = dir.length() || 1;
    dir.divideScalar(len);
    const n = new THREE.Vector2(-dir.y, dir.x);
    return Math.max(0.5, Math.abs(cursor.clone().sub(a).dot(n)));
  }
  /** two straight sides + two end arcs of a rounded slot (axis a→b, radius w) */
  private slotEntities(a: THREE.Vector2, b: THREE.Vector2, w: number): ResolvedEntity[] {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4 || w < 1e-4) return [];
    dir.divideScalar(len);
    const n = new THREE.Vector2(-dir.y, dir.x).multiplyScalar(w);
    const a1 = a.clone().add(n), a2 = a.clone().sub(n);
    const b1 = b.clone().add(n), b2 = b.clone().sub(n);
    // arc through-points: the far tip of each semicircular cap
    const aTip = a.clone().sub(dir.clone().multiplyScalar(w));
    const bTip = b.clone().add(dir.clone().multiplyScalar(w));
    return [
      { type: "line", id: "", x1: a1.x, y1: a1.y, x2: b1.x, y2: b1.y },
      { type: "arc", id: "", x1: b1.x, y1: b1.y, x2: b2.x, y2: b2.y, mx: bTip.x, my: bTip.y },
      { type: "line", id: "", x1: b2.x, y1: b2.y, x2: a2.x, y2: a2.y },
      { type: "arc", id: "", x1: a2.x, y1: a2.y, x2: a1.x, y2: a1.y, mx: aTip.x, my: aTip.y },
    ];
  }
  private commitSlot(a: THREE.Vector2, b: THREE.Vector2, w: number) {
    const ents = this.slotEntities(a, b, w);
    if (!ents.length) return;
    for (const e of ents) {
      e.id = newEntityId();
      if (this.constructionMode) e.construction = true;
      this.entities.push(e);
    }
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- circle by 2 points (diameter endpoints) --------------------------
  private circle2Click(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      return;
    }
    const a = this.clickPts[0];
    const center = a.clone().add(p).multiplyScalar(0.5);
    const r = a.distanceTo(p) / 2;
    this.commitCircle(center, r);
    this.clickPts = [];
    this.overlay.setPreview([]);
  }

  // --- circle through 3 points ------------------------------------------
  private circle3Click(p: THREE.Vector2) {
    this.clickPts.push(p.clone());
    if (this.clickPts.length < 3) return;
    const [a, b, c] = this.clickPts;
    const cc = circumcenter(a, b, c);
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!cc) return; // collinear
    this.commitCircle(cc, cc.distanceTo(a));
  }

  private commitCircle(center: THREE.Vector2, r: number) {
    if (r < 1e-4) return;
    const ent: ResolvedEntity = { type: "circle", id: newEntityId(), radius: r, x: center.x, y: center.y };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- center rectangle: click center, then a corner --------------------
  private centerRectClick(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      return;
    }
    const center = this.clickPts[0];
    const w = Math.abs(p.x - center.x) * 2;
    const h = Math.abs(p.y - center.y) * 2;
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (w < 1e-4 || h < 1e-4) return;
    const ent: ResolvedEntity = { type: "rectangle", id: newEntityId(), width: w, height: h, x: center.x, y: center.y };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- mirror: click a line; reflect the multi-selection across it -------
  private mirrorClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.entities[idx].type !== "line") return;
    const axis = this.entities[idx] as Extract<ResolvedEntity, { type: "line" }>;
    const chosen = this.entities.filter((e) => this.selected.has(e.id) && e.id !== axis.id);
    if (!chosen.length) return; // nothing selected to mirror
    const a = new THREE.Vector2(axis.x1, axis.y1);
    const b = new THREE.Vector2(axis.x2, axis.y2);
    for (const e of chosen) this.entities.push(this.reflectEntity(e, a, b));
    this.selected.clear();
    this.afterModify();
  }
  /** reflect a 2D point across the infinite line through a→b */
  private reflectPoint(x: number, y: number, a: THREE.Vector2, b: THREE.Vector2): { x: number; y: number } {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    const px = a.x + t * dx, py = a.y + t * dy; // foot of perpendicular
    return { x: 2 * px - x, y: 2 * py - y };
  }
  /** a reflected COPY of an entity (fresh id) across the line a→b */
  private reflectEntity(e: ResolvedEntity, a: THREE.Vector2, b: THREE.Vector2): ResolvedEntity {
    const rp = (x: number, y: number) => this.reflectPoint(x, y, a, b);
    const id = newEntityId();
    const c = e.construction ? { construction: true } : {};
    if (e.type === "line") {
      const p1 = rp(e.x1, e.y1), p2 = rp(e.x2, e.y2);
      return { type: "line", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ...c };
    }
    if (e.type === "circle") {
      const ctr = rp(e.x, e.y);
      return { type: "circle", id, radius: e.radius, x: ctr.x, y: ctr.y, ...c };
    }
    if (e.type === "rectangle") {
      // a reflected axis-aligned rectangle stays axis-aligned: reflect the center
      const ctr = rp(e.x, e.y);
      return { type: "rectangle", id, width: e.width, height: e.height, x: ctr.x, y: ctr.y, ...c };
    }
    if (e.type === "arc") {
      // reflection flips orientation, so the through-point reflects too
      const p1 = rp(e.x1, e.y1), p2 = rp(e.x2, e.y2), m = rp(e.mx, e.my);
      return { type: "arc", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mx: m.x, my: m.y, ...c };
    }
    if (e.type === "spline") {
      return { type: "spline", id, points: e.points.map((q) => rp(q.x, q.y)), ...c };
    }
    // point
    const q = rp((e as Extract<ResolvedEntity, { type: "point" }>).x, (e as Extract<ResolvedEntity, { type: "point" }>).y);
    return { type: "point", id, x: q.x, y: q.y, ...c };
  }

  // --- dimension: click an entity, type a driving value -----------------
  private dimensionClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0) return;
    const e = this.entities[idx];
    if (e.type === "line") {
      const cur = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      this.dim.show([{ name: "length", label: "L", kind: "length" }], () => {
        const mm = this.dim.getValue("length") ?? cur;
        this.dim.hide();
        this.setDrivingDimension({ type: "distance", line: e.id, value: mm });
      });
      this.dim.updateFromCursor({ length: cur }); // seed with the current length
    } else if (e.type === "circle") {
      const cur = e.radius * 2;
      this.dim.show([{ name: "diameter", label: "⌀", kind: "length" }], () => {
        const mm = this.dim.getValue("diameter") ?? cur;
        this.dim.hide();
        this.setDrivingDimension({ type: "diameter", circle: e.id, value: mm });
      });
      this.dim.updateFromCursor({ diameter: cur }); // seed with the current diameter
    }
    // rectangles/arcs/splines: no single driving dim in v1
  }

  private onPointerMove(e: PointerEvent) {
    if (this.active && MODIFY_TOOLS.has(this.tool)) {
      this.modifyHover(e);
      return;
    }
    if (!this.active || this.tool === "select") {
      if (this.dragFrom) {
        const w = this.planePoint(e); // raw cursor; snapping off for smooth drag
        if (w) this.queueDrag(w);
        return;
      }
      const hit = this.snapAt(e.clientX, e.clientY);
      this.showSnap(hit);
      if (this.tool === "select") {
        const raw = this.planePoint(e); // hover-highlight a profile area
        this.overlay.setHoverRegion(raw ? this.overlay.activeRegionAt(raw) : null);
      }
      return;
    }
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);
    if (!hit) return;
    this.lastCursor.copy(hit.p);
    this.showSnap(hit);

    if (this.tool === "arc") {
      this.arcPreview(hit.p);
      return;
    }
    if (this.tool === "spline") {
      this.splinePreview(hit.p);
      return;
    }
    if (this.tool === "polygon" || this.tool === "slot" || this.tool === "circle2" ||
        this.tool === "circle3" || this.tool === "centerRectangle") {
      this.multiClickPreview(hit.p);
      return;
    }
    if (PATTERN_TOOLS.has(this.tool)) {
      this.patternMove(hit.p, e);
      return;
    }

    if (this.base) {
      const geom = this.computeGeometry(this.base, hit.p);
      this.dim.updateFromCursor(geom.dims);
      this.dim.position(e.clientX, e.clientY);
      this.overlay.setPreview([geom.preview]); // only the rubber-band redraws
    } else {
      this.overlay.setPreview([]);
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return; // typing in a dim field
    // a pattern being placed/edited: Delete removes it, Esc keeps it as-is
    if (this.pendingPattern) {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.pendingPattern = null; this.editOriginal = null; this.patternCenter = null;
        this.dim.hide(); setPrompt(null); this.refreshActive(); this.onState?.();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.editOriginal) this.patterns.push(this.editOriginal); // restore the pre-edit pattern
        else this.patterns.push(this.pendingPattern); // a fresh placement: keep it at its current values
        this.pendingPattern = null; this.editOriginal = null; this.patternCenter = null;
        this.dim.hide(); setPrompt(null); this.refreshActive(); this.onState?.();
        return;
      }
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.tool === "select" && this.selected.size) {
        e.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.dragFrom) {
        // cancel an in-progress drag: revert geometry to its pre-drag positions
        if (this.dragSnapshot) this.entities = this.dragSnapshot;
        this.dragSnapshot = null;
        this.dragFrom = null;
        this.pendingDrag = null;
        this.conflict = false;
        this.refreshActive();
        this.onState?.();
        return;
      }
      if (this.base || this.arcStart || this.filletFirst != null || this.splinePts.length ||
          this.clickPts.length || this.pendingEndpoint || this.pendingEndpoint2) {
        this.base = null;
        this.chainStart = null;
        this.arcStart = null;
        this.arcEnd = null;
        this.filletFirst = null;
        this.splinePts = [];
        this.clickPts = [];
        this.pendingEndpoint = null;
        this.pendingEndpoint2 = null;
        this.dim.hide();
        this.overlay.setPreview([]);
      } else if (this.selected.size) {
        this.selected.clear();
        this.refreshActive();
      } else {
        this.setTool("select");
      }
      return;
    }
    if (e.key === "Enter") {
      if (this.pendingPattern) {
        e.preventDefault();
        this.commitPattern();
        return;
      }
      if (this.tool === "spline" && this.splinePts.length) {
        e.preventDefault();
        this.finishSpline();
        return;
      }
      if (this.base) {
        e.preventDefault();
        this.commitFromCursor(this.lastCursor);
        return;
      }
    }
    // tool shortcuts inside the sketch
    const k = e.key.toLowerCase();
    // Q/E roll the sketch view ±15° about its normal. Stop the event so the global
    // keymap (q=Press/Pull, e=Extrude) doesn't also fire and kick us out of the sketch.
    if (k === "q") { e.preventDefault(); e.stopImmediatePropagation(); this.viewport.rig.roll(-Math.PI / 12); return; }
    if (k === "e") { e.preventDefault(); e.stopImmediatePropagation(); this.viewport.rig.roll(Math.PI / 12); return; }
    if (k === "l") this.setTool("line");
    else if (k === "r") this.setTool("rectangle");
    else if (k === "c") this.setTool("circle");
    else if (k === "a") this.setTool("arc");
    else if (k === "t") this.setTool("trim");
    else if (k === "o") this.setTool("offset");
  }

  // --- geometry per tool -------------------------------------------------
  private computeGeometry(a: THREE.Vector2, cursor: THREE.Vector2) {
    if (this.tool === "rectangle") {
      let w = Math.abs(cursor.x - a.x);
      let h = Math.abs(cursor.y - a.y);
      const sx = Math.sign(cursor.x - a.x) || 1;
      const sy = Math.sign(cursor.y - a.y) || 1;
      if (this.dim.isUserDriven("width")) w = this.dim.getValue("width") ?? w;
      if (this.dim.isUserDriven("height")) h = this.dim.getValue("height") ?? h;
      const cx = a.x + (sx * w) / 2;
      const cy = a.y + (sy * h) / 2;
      const ent: ResolvedEntity = { type: "rectangle", id: "", width: w, height: h, x: cx, y: cy };
      const dims: Record<string, number> = { width: w, height: h };
      return { dims, preview: this.entityCurve(ent), entity: ent };
    }
    if (this.tool === "circle") {
      let dia = 2 * a.distanceTo(cursor);
      if (this.dim.isUserDriven("diameter")) dia = this.dim.getValue("diameter") ?? dia;
      const ent: ResolvedEntity = { type: "circle", id: "", radius: dia / 2, x: a.x, y: a.y };
      const dims: Record<string, number> = { diameter: dia };
      return { dims, preview: this.entityCurve(ent), entity: ent };
    }
    // line
    let len = a.distanceTo(cursor);
    let ang = (Math.atan2(cursor.y - a.y, cursor.x - a.x) * 180) / Math.PI;
    if (this.dim.isUserDriven("length")) len = this.dim.getValue("length") ?? len;
    if (this.dim.isUserDriven("angle")) ang = this.dim.getValue("angle") ?? ang;
    const ar = (ang * Math.PI) / 180;
    const end = new THREE.Vector2(a.x + Math.cos(ar) * len, a.y + Math.sin(ar) * len);
    const ent: ResolvedEntity = { type: "line", id: "", x1: a.x, y1: a.y, x2: end.x, y2: end.y };
    const dims: Record<string, number> = { length: len, angle: ang };
    return { dims, preview: this.entityCurve(ent), entity: ent };
  }

  private commitFromCursor(cursor: THREE.Vector2) {
    if (!this.base) return;
    const { entity } = this.computeGeometry(this.base, cursor);
    if (this.constructionMode) entity.construction = true;
    entity.id = newEntityId(); // stamp a stable id (computeGeometry left it "")
    this.entities.push(entity);
    if (this.tool === "line" && entity.type === "line") {
      const end = new THREE.Vector2(entity.x2, entity.y2);
      // clicked back on the start point → close the loop and end the chain
      const closing = this.chainStart != null && end.distanceTo(this.chainStart) < 1e-3;
      // auto-infer horizontal/vertical (skip the closing seg + typed angles)
      if (!closing && !this.dim.isUserDriven("angle")) this.inferLineConstraint(entity);
      if (closing) {
        this.base = null;
        this.chainStart = null;
        this.dim.hide();
      } else {
        this.base = new THREE.Vector2(entity.x2, entity.y2); // snapped endpoint
        this.showDimFields();
      }
    } else {
      this.base = null;
      this.dim.hide();
    }
    this.refreshActive(); // entity list changed: rebuild active curves + snaps
    this.overlay.setPreview([]);
    this.requestSolve(); // re-solve if any constraints exist (updates DOF colour)
    this.onState?.();
  }

  /** If a freshly drawn line sits within a few degrees of horizontal/vertical,
   *  snap it exactly and record the constraint (mainstream MCAD's auto-constrain). */
  private inferLineConstraint(e: ResolvedEntity) {
    if (e.type !== "line") return;
    const ang = (Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180) / Math.PI;
    const norm = ((ang % 180) + 180) % 180; // 0..180
    const TOL = 3;
    if (Math.min(norm, 180 - norm) <= TOL) {
      e.y2 = e.y1; // exactly horizontal
      this.constraints.push({ type: "horizontal", line: e.id });
    } else if (Math.abs(norm - 90) <= TOL) {
      e.x2 = e.x1; // exactly vertical
      this.constraints.push({ type: "vertical", line: e.id });
    }
  }

  private showDimFields() {
    const defs =
      this.tool === "rectangle"
        ? [{ name: "width", label: "W" }, { name: "height", label: "H" }]
        : this.tool === "circle"
          ? [{ name: "diameter", label: "⌀" }]
          : [
              { name: "length", label: "L" },
              { name: "angle", label: "∠", kind: "angle" as const },
            ];
    this.dim.show(defs, () => this.commitFromCursor(this.lastCursor));
  }

  // --- snapping + rendering ---------------------------------------------
  private snapAt(clientX: number, clientY: number, noSnap = false) {
    const world = this.viewport.screenToPlane(clientX, clientY, this.plane.plane);
    if (!world) return null;
    const p2d = this.plane.to2D(world);
    // Hold Ctrl to suppress snapping for fine placement (raw cursor position).
    if (noSnap) return { p: p2d, kind: "free" as SnapKind, world };
    const res = snap(
      p2d,
      this.candidates, // cached; rebuilt only when entities change
      (q) => this.viewport.projectToScreen(this.plane.to3D(q.x, q.y)),
      this.gridSnap ? GRID_STEP : 0,
    );
    return { p: res.point, kind: res.kind, world: this.plane.to3D(res.point.x, res.point.y) };
  }

  private showSnap(hit: { kind: SnapKind; world: THREE.Vector3 } | null) {
    if (!hit || hit.kind === "free") {
      this.overlay.setSnap(null);
      return;
    }
    this.overlay.setSnap(hit.world, hit.kind, this.viewport.camera);
    this.overlay.setSnapScale(this.viewport.pixelWorldSize(hit.world) * 6);
  }

  /** MCAD-style state color: over-constrained/conflict = red, fully
   * constrained (dof 0) = white ("fully defined"), under-constrained = blue.
   * dof < 0 means no solve has run yet (treat as under-constrained). */
  private activeColor(): number {
    return this.conflict ? 0xff4444 : this.lastDof === 0 ? 0xffffff : CURVE_COLOR;
  }

  /** All pattern definitions including the one being placed (for live preview). */
  private allPatterns(): SketchPattern[] {
    return this.pendingPattern ? [...this.patterns, this.pendingPattern] : this.patterns;
  }

  /** Derived (copy) entities from every pattern — render/region only, never edited
   *  or snapped individually. Mirrors the build/persist expansion. */
  private derivedEntities(): ResolvedEntity[] {
    const pats = this.allPatterns();
    if (!pats.length) return [];
    const params = this.store?.document.parameters ?? {};
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    const out: ResolvedEntity[] = [];
    for (const pat of pats) out.push(...expandPattern(pat, byId, params));
    return out;
  }

  private activeCurves(): THREE.Object3D[] {
    const objs: THREE.Object3D[] = [];
    if (this.selected.size) {
      const normal = this.entities.filter((e) => !this.selected.has(e.id));
      const chosen = this.entities.filter((e) => this.selected.has(e.id));
      if (normal.length) objs.push(...curveObjects(normal, this.plane, this.activeColor()));
      if (chosen.length) objs.push(...curveObjects(chosen, this.plane, SELECT_COLOR));
    } else {
      objs.push(...curveObjects(this.entities, this.plane, this.activeColor()));
    }
    if (this.dimsVisible) objs.push(...dimensionLineObjects(this.entities, this.plane));
    const derived = this.derivedEntities();
    if (derived.length) objs.push(...curveObjects(derived, this.plane, this.activeColor()));
    return objs;
  }

  private entityCurve(e: ResolvedEntity): THREE.Object3D {
    return curveObjects([e], this.plane, PREVIEW_COLOR)[0];
  }

  // --- modify tools: trim + fillet -------------------------------------
  private pickTol(): number {
    return this.viewport.pixelWorldSize(this.plane.origin) * 9;
  }
  /** raw (unsnapped) cursor point on the sketch plane */
  private planePoint(e: MouseEvent): THREE.Vector2 | null {
    const w = this.viewport.screenToPlane(e.clientX, e.clientY, this.plane.plane);
    return w ? this.plane.to2D(w) : null;
  }
  /** hover-highlight the entity under the cursor in red */
  private modifyHover(e: PointerEvent) {
    const p = this.planePoint(e);
    if (!p) return;
    const idx = pickEntity(this.entities, p, this.pickTol());
    const preview: THREE.Object3D[] = [];
    if (this.filletFirst != null)
      preview.push(...curveObjects([this.entities[this.filletFirst]], this.plane, 0x33aaff));
    if (idx >= 0) preview.push(...curveObjects([this.entities[idx]], this.plane, 0xff5555));
    this.overlay.setPreview(preview);
  }

  // --- selection delete (select tool) -----------------------------------
  /** Remove the selected entities, prune now-dangling constraints, then rebuild
   *  + re-solve via the shared modify tail. */
  private deleteSelected() {
    if (!this.selected.size) return;
    this.entities = this.entities.filter((en) => !this.selected.has(en.id));
    this.selected.clear();
    dismissContextMenu(); // the Delete key can fire while the right-click menu is open
    this.afterModify();
  }

  /** Right-click in select mode: select the entity under the cursor (if any) and
   *  offer Delete. Leaves camera navigation alone when nothing is hit/selected. */
  private onContextMenu(e: MouseEvent) {
    if (!this.active || this.tool !== "select") return;
    const raw = this.planePoint(e);
    const idx = raw ? pickEntity(this.entities, raw, this.pickTol()) : -1;
    if (idx >= 0) {
      const id = this.entities[idx].id;
      if (!this.selected.has(id)) { this.selected = new Set([id]); this.refreshActive(); }
    }
    if (!this.selected.size) return; // nothing to act on → let nav handle it
    e.preventDefault();
    const n = this.selected.size;
    contextMenu(e.clientX, e.clientY, [
      { label: n > 1 ? `Delete ${n} entities` : "Delete", danger: true, onClick: () => this.deleteSelected() },
    ]);
  }
  private trimClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0) return;
    this.entities = trimEntity(this.entities, idx, p);
    this.afterModify();
  }
  private filletClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.entities[idx].type !== "line") return;
    if (this.filletFirst == null) {
      this.filletFirst = idx;
      return;
    }
    if (idx === this.filletFirst) return;
    const second = idx;
    const first = this.filletFirst;
    this.dim.show([{ name: "radius", label: "R", kind: "length" }], () =>
      this.applyFillet(first, second),
    );
  }
  private applyFillet(iA: number, iB: number) {
    const r = this.dim.getValue("radius") ?? 2;
    const res = filletCorner(this.entities, iA, iB, r);
    if (res) this.entities = res;
    this.filletFirst = null;
    this.dim.hide();
    this.afterModify();
  }
  private offsetClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0) return;
    this.dim.show([{ name: "offset", label: "Offset", kind: "length" }], () => {
      const d = this.dim.getValue("offset") ?? 1;
      const res = offsetEntity(this.entities, idx, d);
      if (res) this.entities = res;
      this.dim.hide();
      this.afterModify();
    });
  }
  private extendClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0) return;
    const res = extendLine(this.entities, idx, p);
    if (res) this.entities = res;
    this.afterModify();
  }
  private breakClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0) return;
    this.entities = breakAt(this.entities, idx, p);
    this.afterModify();
  }
  /** add a persistent geometric constraint and re-solve (the solver maintains
   *  all constraints together, not just the one you applied). */
  private constraintClick(p: THREE.Vector2) {
    const t = this.tool;
    // point-based constraints pick the nearest endpoint, not an entity body
    if (t === "coincident" || t === "symmetric" || t === "midpoint") {
      return this.pointConstraintClick(p);
    }
    if (t === "tangent") return this.tangentClick(p);
    if (t === "concentric") return this.concentricClick(p);

    // line-based constraints (horizontal/vertical/parallel/perpendicular/equal)
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.entities[idx].type !== "line") return;
    const id = this.entities[idx].id;
    if (t === "horizontal") this.addConstraint({ type: "horizontal", line: id });
    else if (t === "vertical") this.addConstraint({ type: "vertical", line: id });
    else {
      // two-line constraints: first click stores, second applies
      if (this.filletFirst == null) {
        this.filletFirst = idx;
        return;
      }
      const a = this.entities[this.filletFirst]?.id;
      this.filletFirst = null;
      if (!a || a === id) return;
      if (t === "parallel") this.addConstraint({ type: "parallel", l1: a, l2: id });
      else if (t === "perpendicular") this.addConstraint({ type: "perpendicular", l1: a, l2: id });
      else if (t === "equal") this.addConstraint({ type: "equal", l1: a, l2: id });
    }
  }

  /** nearest addressable endpoint (line/arc/spline end, or a point entity) to p */
  private pickEndpoint(p: THREE.Vector2): { id: string; idx: number } | null {
    const tol = this.pickTol();
    let best: { id: string; idx: number } | null = null;
    let bestD = tol * tol;
    const consider = (id: string, idx: number, x: number, y: number) => {
      const dx = x - p.x, dy = y - p.y, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = { id, idx }; }
    };
    for (const e of this.entities) {
      if (e.type === "line") { consider(e.id, 0, e.x1, e.y1); consider(e.id, 1, e.x2, e.y2); }
      else if (e.type === "arc") { consider(e.id, 0, e.x1, e.y1); consider(e.id, 1, e.x2, e.y2); }
      else if (e.type === "point") consider(e.id, 0, e.x, e.y);
      else if (e.type === "spline") { consider(e.id, 0, e.points[0].x, e.points[0].y); const l = e.points.length - 1; consider(e.id, 1, e.points[l].x, e.points[l].y); }
    }
    return best;
  }

  // coincident/symmetric/midpoint all start from an endpoint pick. We stash the
  // first pick (and, for symmetric, the second) on filletFirst-style state.
  private pendingEndpoint: { id: string; idx: number } | null = null;
  private pendingEndpoint2: { id: string; idx: number } | null = null;
  private pointConstraintClick(p: THREE.Vector2) {
    const t = this.tool;
    if (t === "midpoint") {
      // pick a point/endpoint, then a line
      if (!this.pendingEndpoint) {
        const ep = this.pickEndpoint(p);
        if (ep) this.pendingEndpoint = ep;
        return;
      }
      const idx = pickEntity(this.entities, p, this.pickTol());
      const e = idx >= 0 ? this.entities[idx] : null;
      const ep = this.pendingEndpoint;
      this.pendingEndpoint = null;
      if (e?.type === "line" && e.id !== ep.id) this.addConstraint({ type: "midpoint", e: ep.id, p: ep.idx, line: e.id });
      return;
    }
    if (t === "coincident") {
      const ep = this.pickEndpoint(p);
      if (!ep) return;
      if (!this.pendingEndpoint) { this.pendingEndpoint = ep; return; }
      const a = this.pendingEndpoint;
      this.pendingEndpoint = null;
      if (a.id !== ep.id) this.addConstraint({ type: "coincident", e1: a.id, p1: a.idx, e2: ep.id, p2: ep.idx });
      return;
    }
    // symmetric: pick endpoint A, endpoint B, then the axis line
    if (!this.pendingEndpoint) {
      const ep = this.pickEndpoint(p);
      if (ep) this.pendingEndpoint = ep;
      return;
    }
    if (!this.pendingEndpoint2) {
      const ep = this.pickEndpoint(p);
      if (ep && ep.id !== this.pendingEndpoint.id) this.pendingEndpoint2 = ep;
      return;
    }
    // third click: the symmetry axis line
    const idx = pickEntity(this.entities, p, this.pickTol());
    const e = idx >= 0 ? this.entities[idx] : null;
    const a = this.pendingEndpoint, b = this.pendingEndpoint2;
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    if (e?.type === "line") this.addConstraint({ type: "symmetric", e1: a.id, p1: a.idx, e2: b.id, p2: b.idx, line: e.id });
  }

  private tangentClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0) return;
    const e = this.entities[idx];
    if (this.filletFirst == null) {
      // store first pick if it's a line or a circle
      if (e.type === "line" || e.type === "circle") this.filletFirst = idx;
      return;
    }
    const first = this.entities[this.filletFirst];
    this.filletFirst = null;
    if (!first || first.id === e.id) return;
    const line = first.type === "line" ? first : e.type === "line" ? e : null;
    const circle = first.type === "circle" ? first : e.type === "circle" ? e : null;
    if (line && circle) this.addConstraint({ type: "tangent", line: line.id, circle: circle.id });
  }

  private concentricClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.entities[idx].type !== "circle") return;
    if (this.filletFirst == null) { this.filletFirst = idx; return; }
    const a = this.entities[this.filletFirst];
    this.filletFirst = null;
    const b = this.entities[idx];
    if (a && a.id !== b.id && a.type === "circle") this.addConstraint({ type: "concentric", c1: a.id, c2: b.id });
  }

  private addConstraint(c: SketchConstraint) {
    this.constraints.push(c);
    this.requestSolve();
  }

  /** Drop constraints that reference an entity that no longer exists (or is the
   *  wrong type) — e.g. after trim/break removes or splits a constrained line. */
  private pruneConstraints() {
    const lineIds = new Set(this.entities.filter((e) => e.type === "line").map((e) => e.id));
    const circleIds = new Set(this.entities.filter((e) => e.type === "circle").map((e) => e.id));
    // entities that own an addressable endpoint (line/arc/spline/point)
    const endIds = new Set(
      this.entities
        .filter((e) => e.type === "line" || e.type === "arc" || e.type === "spline" || e.type === "point")
        .map((e) => e.id),
    );
    // entities that own a center (circle/arc), for concentric
    const centerIds = new Set(
      this.entities.filter((e) => e.type === "circle" || e.type === "arc").map((e) => e.id),
    );
    this.constraints = this.constraints.filter((c) => {
      switch (c.type) {
        case "horizontal": case "vertical": case "distance": return lineIds.has(c.line);
        case "parallel": case "perpendicular": case "equal": return lineIds.has(c.l1) && lineIds.has(c.l2);
        case "diameter": return circleIds.has(c.circle);
        case "tangent": return lineIds.has(c.line) && circleIds.has(c.circle);
        case "coincident": return endIds.has(c.e1) && endIds.has(c.e2);
        case "concentric": return centerIds.has(c.c1) && centerIds.has(c.c2);
        case "midpoint": return endIds.has(c.e) && lineIds.has(c.line);
        case "symmetric": return endIds.has(c.e1) && endIds.has(c.e2) && lineIds.has(c.line);
      }
    });
  }

  /** Common tail for modify ops: prune now-dangling constraints, rebuild, re-solve. */
  private afterModify() {
    this.pruneConstraints();
    this.refreshActive();
    this.overlay.setPreview([]);
    this.requestSolve();
  }

  /** Mark the sketch dirty and kick the solve pump. Coalesces many requests
   *  into one in-flight solve so the (single, shared) WASM wrapper is never
   *  re-entered, and stale results never clobber newer geometry. */
  private requestSolve() {
    this.solveDirty = true;
    void this.pump();
  }

  /** The one and only path that touches the solver. Serializes drag solves and
   *  constraint/dimension solves through a single in-flight lock. */
  private async pump() {
    if (this.solveBusy) return;
    this.solveBusy = true;
    try {
      while (this.active && (this.pendingDrag || this.solveDirty)) {
        if (this.pendingDrag) {
          // no entityVersion guard here: a drag never adds/removes entities, so
          // the entity list can't change underneath this solve (unlike a draw).
          const d = this.pendingDrag;
          this.pendingDrag = null;
          const r = await compileAndSolve(this.entities, this.constraints, d);
          if (!this.active || !this.dragFrom) break; // drag ended/cancelled mid-solve
          this.conflict = r.conflicts.length > 0;
          if (!this.conflict) this.entities = r.entities;
          this.lastDof = r.dof;
          if (this.dragFrom) this.dragFrom.set(d.toX, d.toY); // track grabbed pt
          this.refreshDragGeometry(); // curves only; dims/candidates rebuilt on endDrag
        } else {
          this.solveDirty = false;
          if (this.constraints.length === 0) { this.lastDof = -1; this.conflict = false; continue; }
          const ver = this.entityVersion;
          const r = await compileAndSolve(this.entities, this.constraints);
          if (!this.active) break;
          // geometry changed mid-solve (a draw committed): discard, re-solve
          if (this.entityVersion !== ver) { this.solveDirty = true; continue; }
          this.conflict = r.conflicts.length > 0;
          if (!this.conflict) this.entities = r.entities; // keep last good on conflict
          this.lastDof = r.dof;
          this.refreshActive();
        }
      }
    } finally {
      this.solveBusy = false;
    }
    this.onState?.();
  }

  // --- interactive drag: grab a point, geometry follows, constraints hold ---
  /** Find the nearest solver-controlled point (line endpoint or circle centre)
   *  within pick tolerance of p. All entity types expand to solver points. */
  private pickPoint(p: THREE.Vector2): THREE.Vector2 | null {
    const tol = this.pickTol();
    let best: THREE.Vector2 | null = null;
    let bestD = tol * tol;
    const consider = (x: number, y: number) => {
      const dx = x - p.x, dy = y - p.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = new THREE.Vector2(x, y); }
    };
    for (const e of this.entities) {
      if (e.type === "line") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
      else if (e.type === "circle") consider(e.x, e.y);
      else if (e.type === "arc") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
      else if (e.type === "spline") for (const q of e.points) consider(q.x, q.y);
      else if (e.type === "point") consider(e.x, e.y);
      else if (e.type === "rectangle") {
        const hw = e.width / 2, hh = e.height / 2;
        consider(e.x - hw, e.y - hh); consider(e.x + hw, e.y - hh);
        consider(e.x + hw, e.y + hh); consider(e.x - hw, e.y + hh);
      }
    }
    return best;
  }

  /** Queue a drag target; pump serializes solves (latest target wins). */
  private queueDrag(to: THREE.Vector2) {
    if (!this.dragFrom) return;
    this.pendingDrag = { fromX: this.dragFrom.x, fromY: this.dragFrom.y, toX: to.x, toY: to.y };
    void this.pump();
  }

  private endDrag(pointerId?: number) {
    if (!this.dragFrom) return;
    this.dragFrom = null;
    this.dragSnapshot = null; // committed — drop the revert buffer
    this.pendingDrag = null;
    if (pointerId != null) {
      try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
    }
    this.refreshActive(); // restore snap candidates + dimension labels at final positions
    this.onState?.();
  }

  /** remaining degrees of freedom (>0 under-constrained, 0 fully constrained) */
  get dof(): number {
    return this.lastDof;
  }

  /** preview while drawing an arc: chord after 1st click, arc after 2nd */
  private arcPreview(cursor: THREE.Vector2) {
    if (this.arcStart && !this.arcEnd) {
      const a = this.arcStart;
      this.overlay.setPreview([
        this.entityCurve({ type: "line", id: "", x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y }),
      ]);
    } else if (this.arcStart && this.arcEnd) {
      const a = this.arcStart;
      const b = this.arcEnd;
      this.overlay.setPreview([
        this.entityCurve({ type: "arc", id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y, mx: cursor.x, my: cursor.y }),
      ]);
    } else {
      this.overlay.setPreview([]);
    }
  }

  // --- grid --------------------------------------------------------------
  private addGrid() {
    this.removeGrid();
    const grid = new THREE.GridHelper(400, 80, 0x44505c, 0x2c333a);
    // GridHelper lies in XZ; orient it onto the sketch plane (XY local)
    grid.quaternion.copy(this.plane.orientation()).multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
    );
    grid.position.copy(this.plane.origin);
    (grid.material as THREE.Material).depthWrite = false;
    grid.renderOrder = 1;
    grid.visible = this.gridVisible;
    this.grid = grid;
    this.viewport.addToScene(grid);
  }
  private removeGrid() {
    if (this.grid) {
      this.viewport.removeFromScene(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
  }
}
