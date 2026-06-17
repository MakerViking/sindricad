// The modal sketch environment: enter on a plane (camera squares to it, model
// dims, grid appears), draw Line/Rectangle/Circle interactively with snapping
// and on-canvas dimension input, then Finish to commit the sketch feature.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, PlaneSpec, SketchConstraint } from "../types";
import { SketchPlane } from "./plane";
import { SketchOverlay, curveObjects, dimensionLineObjects, CURVE_COLOR, PREVIEW_COLOR } from "./overlay";
import { DimInput } from "./dimInput";
import { SketchDimensions } from "./sketchDimensions";
import { entityDims, type DimField } from "./entityDims";
import { pickEntity, trimEntity, filletCorner, offsetEntity, breakAt, extendLine } from "./modify";
import { newEntityId } from "./id";
import { compileAndSolve } from "./sketchSolve";
import { resolveEntities, toSketchEntity } from "./resolve";
import { candidatesFromEntities, snap, type SnapKind, type SnapCandidate } from "./snap";
import type { ResolvedEntity } from "./snap";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "circle"
  | "arc"
  | "spline"
  | "trim"
  | "fillet"
  | "offset"
  | "extend"
  | "break"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal";

const CONSTRAINT_TOOLS = new Set<SketchTool>([
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
]);
const MODIFY_TOOLS = new Set<SketchTool>([
  "trim",
  "fillet",
  "offset",
  "extend",
  "break",
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
  private filletFirst: number | null = null; // first line picked for a sketch fillet
  private constraints: SketchConstraint[] = []; // persistent constraints (solved)
  private lastDof = -1;
  private dragFrom: THREE.Vector2 | null = null; // grabbed point's current position
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
  private dim: DimInput;
  private dims: SketchDimensions;
  private boundDown: (e: PointerEvent) => void;
  private boundMove: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

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
    this.lastDof = -1;
    this.conflict = false;
    if (editId) {
      const f = store.document.features.find((x) => x.id === editId);
      if (f && f.type === "sketch") {
        this.entities = resolveEntities(f, store.document.parameters);
        this.constraints = f.constraints ? f.constraints.map((c) => ({ ...c })) : [];
      }
    }

    this.viewport.suspendPicking = true;
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.addGrid();

    const el = this.viewport.domElement;
    el.addEventListener("pointerdown", this.boundDown);
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    this.overlay.update(store.document, this.editingId ?? "__active__");
    this.refreshActive();
    this.setTool("rectangle");
    if (this.constraints.length > 0) this.requestSolve(); // restore DOF state
    this.onState?.();
  }

  finish(commit = true) {
    if (!this.active) return;
    const store = this.store!;
    if (commit && this.entities.length > 0) {
      const sketch: Feature = {
        id: this.editingId ?? store.nextId(),
        type: "sketch",
        plane: this.plane.serialize(),
        entities: this.entities.map(toSketchEntity),
        ...(this.constraints.length > 0 ? { constraints: this.constraints.map((c) => ({ ...c })) } : {}),
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
    window.removeEventListener("keydown", this.boundKey, true);
    this.dragFrom = null;
    this.pendingDrag = null;
    this.dim.hide();
    this.dims.hide();
    this.overlay.setPreview([]);
    this.overlay.setSnap(null);
    this.removeGrid();
    this.viewport.exitSketchView();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.splinePts = [];
    this.tool = "select";
    if (this.store) this.overlay.update(this.store.document);
    this.onState?.();
  }

  // --- tools -------------------------------------------------------------
  setTool(t: SketchTool) {
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
    this.onState?.();
  }

  /** Rebuild the active sketch's committed curves + snap candidates + editable
   * dimension labels. Called when the entity list changes — and on drag end. */
  private refreshActive() {
    this.entityVersion++; // bump guards in-flight constraint solves against staleness
    this.overlay.setActiveSketch(this.activeCurves());
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
    const hit = this.snapAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    const p = hit.p;

    if (this.tool === "select") {
      // grab a point to drag it — connected/constrained geometry follows
      const gp = this.pickPoint(p);
      if (gp) {
        this.dragFrom = gp.clone();
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
      }
      return;
    }
    if (this.tool === "arc") return this.arcClick(p);
    if (this.tool === "spline") return this.splineClick(p);
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

  // Fusion-style fit-point spline: click to drop points; click the last point
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
      return;
    }
    const hit = this.snapAt(e.clientX, e.clientY);
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
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.base || this.arcStart || this.filletFirst != null || this.splinePts.length) {
        this.base = null;
        this.chainStart = null;
        this.arcStart = null;
        this.arcEnd = null;
        this.filletFirst = null;
        this.splinePts = [];
        this.dim.hide();
        this.overlay.setPreview([]);
      } else {
        this.setTool("select");
      }
      return;
    }
    if (e.key === "Enter") {
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
   *  snap it exactly and record the constraint (Fusion's auto-constrain). */
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
  private snapAt(clientX: number, clientY: number) {
    const world = this.viewport.screenToPlane(clientX, clientY, this.plane.plane);
    if (!world) return null;
    const p2d = this.plane.to2D(world);
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

  /** Fusion-style state color: over-constrained/conflict = red, fully
   * constrained (dof 0) = white ("fully defined"), under-constrained = blue.
   * dof < 0 means no solve has run yet (treat as under-constrained). */
  private activeColor(): number {
    return this.conflict ? 0xff4444 : this.lastDof === 0 ? 0xffffff : CURVE_COLOR;
  }

  private activeCurves(): THREE.Object3D[] {
    const objs = curveObjects(this.entities, this.plane, this.activeColor());
    if (this.dimsVisible) objs.push(...dimensionLineObjects(this.entities, this.plane));
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
  private planePoint(e: PointerEvent): THREE.Vector2 | null {
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
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.entities[idx].type !== "line") return;
    const id = this.entities[idx].id;
    if (this.tool === "horizontal") this.addConstraint({ type: "horizontal", line: id });
    else if (this.tool === "vertical") this.addConstraint({ type: "vertical", line: id });
    else {
      // two-line constraints: first click stores, second applies
      if (this.filletFirst == null) {
        this.filletFirst = idx;
        return;
      }
      const a = this.entities[this.filletFirst]?.id;
      this.filletFirst = null;
      if (!a || a === id) return;
      if (this.tool === "parallel") this.addConstraint({ type: "parallel", l1: a, l2: id });
      else if (this.tool === "perpendicular") this.addConstraint({ type: "perpendicular", l1: a, l2: id });
      else if (this.tool === "equal") this.addConstraint({ type: "equal", l1: a, l2: id });
    }
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
    this.constraints = this.constraints.filter((c) => {
      switch (c.type) {
        case "horizontal": case "vertical": case "distance": return lineIds.has(c.line);
        case "parallel": case "perpendicular": case "equal": return lineIds.has(c.l1) && lineIds.has(c.l2);
        case "diameter": return circleIds.has(c.circle);
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
          if (!this.active) break;
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
