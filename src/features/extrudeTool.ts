// Interactive Extrude (MCAD-style): select one or more profile AREAS, then set
// the distance by moving the cursor along the profile normal (live solid preview +
// arrow manipulator + numeric box). Areas can be pre-selected in the sketch or
// picked here: plain click picks one and starts the depth drag, Ctrl-click adds
// more (Enter to confirm the set). A ring (annulus) area previews/extrudes as a
// tube; selecting several areas unions them. Operation auto-selects: New Body when
// nothing exists, otherwise Cut when the profile pushes into an existing body and
// Join when it pulls away (both overridable in the commit dialog).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { pointInRegion } from "../sketch/region";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { axisDragDistance } from "./manipulator";
import { choose } from "../ui/choice";

type Phase = "pick" | "drag";
type Op = "new" | "join" | "cut" | "intersect";

export class ExtrudeTool {
  active = false;
  private phase: Phase = "pick";
  private selected: WorldRegion[] = [];
  private distance = 10;
  private preview: THREE.Group | null = null;
  private previewMat: THREE.MeshStandardMaterial | null = null;
  private previewKey = ""; // depth+sign+selection of the built preview geometry
  private arrow: THREE.ArrowHelper | null = null;
  private dim = new DimInput();
  private hitScratch = new THREE.Vector3();
  private onDone: ((id: string | null) => void) | null = null;

  // --- edit mode (re-opening a committed extrude) ---
  private editId: string | null = null; // committed feature id being edited
  private editOp: Op | null = null; // saved operation (pre-sorted first in the modal)
  private editHiddenBodies: string[] | undefined; // participants captured at creation — KEPT
  /** while editing, this sketch is forced visible so its regions exist
   *  (consumed sketches hide by default) — main.ts's isSketchVisible honors it. */
  forcedSketchId: string | null = null;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private overlay: SketchOverlay,
    private store: DocumentStore,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundKey = (e) => this.onKey(e);
  }

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("keydown", this.boundKey, true);
    // honour any areas pre-selected in the sketch
    this.selected = this.overlay.selectedRegions();
    if (this.selected.length) {
      this.beginDrag();
    } else {
      setPrompt("Select a profile to extrude · Ctrl-click adds areas · Enter to confirm");
    }
  }

  /** Re-open a committed extrude for editing: the model rolls back to just
   *  before it, its sketch is forced visible, the saved profile areas are
   *  pre-selected, and the saved distance seeds (and locks) the input — retype
   *  or Ctrl-click areas, then commit to REPLACE the feature in place (same id,
   *  one undo step). Returns false when the distance is a parameter expression
   *  (the inspector's job). */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "extrude") return false;
    if (typeof f.distance !== "number") return false; // parameter expression — inspector's job

    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.editId = featureId;
    this.editOp = f.operation;
    this.editHiddenBodies = f.hiddenBodies;
    this.distance = f.distance;
    this.forcedSketchId = f.sketch;

    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("keydown", this.boundKey, true);

    // roll the model back so the pre-extrude state is what previews/op-guesses
    // see (exactly what the tool saw at creation), then rebuild the overlay so
    // the now-forced-visible sketch contributes regions to select from.
    this.store.beginEditPreview(featureId);
    this.overlay.update(this.store.document);
    const saved: [number, number, number][] = (
      f.regions ?? (f.region ? [f.region] : [])
    ) as [number, number, number][];
    this.overlay.selectRegionsByPoints(saved);
    this.selected = this.overlay.selectedRegions();
    if (this.selected.length) {
      this.beginDrag();
    } else {
      setPrompt(
        "Editing extrude: its areas were not found (sketch changed?) — select a profile · Esc to cancel",
      );
    }
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      this.overlay.setHoverRegion(r);
      this.viewport.domElement.style.cursor = r ? "pointer" : "default";
      return;
    }
    if (!this.selected.length) return;
    const plane = this.selected[0].plane;
    const anchor = this.anchor();
    if (!this.dim.isUserDriven("distance")) {
      const d = axisDragDistance(this.viewport, e.clientX, e.clientY, anchor, plane.n);
      this.distance = d;
      this.dim.updateFromCursor({ distance: Math.abs(d) });
    } else {
      const v = this.dim.getValue("distance");
      if (v != null) this.distance = v; // the field is the truth: typed sign wins
    }
    this.dim.position(e.clientX, e.clientY);
    this.updatePreview();
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      if (!r) return;
      e.preventDefault();
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      this.overlay.toggleRegionSelection(r, additive);
      this.selected = this.overlay.selectedRegions();
      // plain click picks one area and goes straight to depth; Ctrl-click keeps
      // accumulating (Enter confirms the set)
      if (!additive && this.selected.length) this.beginDrag();
    } else {
      e.preventDefault();
      void this.commit();
    }
  }

  private onKey(e: KeyboardEvent) {
    if (this.dim.isActive && e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") this.cancel();
      return;
    }
    if (e.key === "Escape") this.cancel();
    else if (e.key === "Enter" && this.phase === "pick" && this.selected.length) this.beginDrag();
  }

  private beginDrag() {
    this.phase = "drag";
    this.overlay.setHoverRegion(null);
    this.dim.show([{ name: "distance", label: "D" }], () => void this.commit(), () => this.cancel());
    if (this.editId) {
      // seed the SIGNED saved distance and lock the field (userDriven): extrude's
      // onMove free-tracks the cursor and would clobber the seed on the first
      // move otherwise. Cursor-scrub is deliberately off in edit mode — retype
      // or commit. (Seeding the abs value would silently drop a cut's sign the
      // moment getValue is read back — the DimInput abs-display trap.)
      this.dim.seed("distance", this.distance);
      setPrompt(
        "Editing extrude: Ctrl-click areas to add/remove · type a value + Enter · " +
          "click to commit · Esc to cancel (later features are hidden while editing)",
      );
    } else {
      this.distance = 10;
      setPrompt(
        "Move to set depth · type a value + Enter · negative = cut · click to commit · Esc to cancel",
      );
    }
    this.updatePreview();
  }

  // --- geometry helpers ---
  /** the front-most region whose material (loop minus holes) contains the cursor */
  private regionUnder(cx: number, cy: number): WorldRegion | null {
    const ray = this.viewport.rayFrom(cx, cy).ray;
    let best: WorldRegion | null = null;
    let bestDist = Infinity;
    for (const wr of this.overlay.regions) {
      if (!ray.intersectPlane(wr.plane.plane, this.hitScratch)) continue;
      const p2d = wr.plane.to2D(this.hitScratch);
      if (!pointInRegion(p2d, wr.region)) continue;
      const d = ray.origin.distanceToSquared(this.hitScratch);
      if (d < bestDist) {
        bestDist = d;
        best = wr;
      }
    }
    return best;
  }

  /** average of the selected areas' interior points — the arrow anchor */
  private anchor(): THREE.Vector3 {
    const a = new THREE.Vector3();
    for (const wr of this.selected) a.add(wr.interior3D);
    return a.divideScalar(this.selected.length || 1);
  }

  private updatePreview() {
    if (!this.selected.length) return;
    const sign = this.distance >= 0 ? 1 : -1;
    const depth = Math.abs(this.distance);
    const cut = sign < 0;

    const ids = this.selected
      .map((s) => `${s.sketchId}:${s.interior3D.x.toFixed(2)},${s.interior3D.y.toFixed(2)}`)
      .join("|");
    const key = `${depth.toFixed(3)}:${sign}:${ids}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.disposePreviewGeom();
      if (!this.previewMat) {
        this.previewMat = new THREE.MeshStandardMaterial({
          transparent: true,
          opacity: 0.5,
          metalness: 0.1,
          roughness: 0.6,
        });
      }
      this.preview = new THREE.Group();
      for (const wr of this.selected) {
        const shape = new THREE.Shape(wr.region.loop.map((p) => p.clone()));
        for (const h of wr.region.holes) {
          shape.holes.push(new THREE.Path(h.map((p) => p.clone())));
        }
        const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
        geo.applyMatrix4(wr.plane.basisMatrix(sign)); // local +Z -> plane normal (flipped on cut)
        this.preview.add(new THREE.Mesh(geo, this.previewMat));
      }
      this.viewport.addToScene(this.preview);
    }
    this.previewMat?.color.set(cut ? 0xff5c5c : 0x5b9bff);

    // arrow manipulator along the (shared) normal, anchored at the selection center
    const plane = this.selected[0].plane;
    const anchor = this.anchor();
    const dir = plane.n.clone().multiplyScalar(sign);
    if (!this.arrow) {
      this.arrow = new THREE.ArrowHelper(dir, anchor, depth || 1, 0xffd24a, 6, 3);
      this.viewport.addToScene(this.arrow);
    } else {
      this.arrow.position.copy(anchor);
      this.arrow.setDirection(dir);
      this.arrow.setLength(Math.max(depth, 1), 6, 3);
    }
  }

  // Default operation: New Body when the doc has no solid yet, else Cut/Join by
  // whether the extrude direction pushes INTO existing material or away from it
  // (a face pushed inward reads as Cut, pulled outward as Join — MCAD parity).
  // This replaced a pure drag-SIGN guess, which defaulted "push a face through the
  // model" to Join and silently no-op'd (the union was already inside the body).
  private entersSolid(): boolean {
    if (!this.selected.length) return false;
    const sign = this.distance >= 0 ? 1 : -1;
    let inside = 0;
    for (const wr of this.selected) {
      // step the area's interior a hair along the extrude direction, off its face
      const p = wr.interior3D.clone().addScaledVector(wr.plane.n, sign * 0.05);
      if (this.viewport.pointInSolid(p)) inside++;
    }
    return inside * 2 > this.selected.length; // majority of selected areas
  }

  private currentOperation(): Op {
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (!hasSolid) return "new";
    return this.entersSolid() ? "cut" : "join";
  }

  private committing = false;
  private async commit() {
    if (this.committing) return;
    if (!this.selected.length) return this.cancel();
    const v = this.dim.getValue("distance");
    if (v != null) this.distance = v; // the field is the truth: typed sign wins
    if (Math.abs(this.distance) < 1e-3) return; // ignore zero
    let op = this.currentOperation();
    // when a body already exists, let the user state the operation (MCAD-style):
    // New Body avoids any boolean (and the kernel crash on hard geometry).
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (hasSolid) {
      this.committing = true;
      // in edit mode the SAVED operation is the presumptive choice; otherwise
      // the direction-derived guess is.
      const guess = this.editId ? (this.editOp ?? op) : op;
      // op === "cut" ⇔ the extrude direction enters solid (currentOperation).
      // Flag whichever op would then do nothing, so the choice is informed.
      const into = op === "cut";
      const opts: { value: Op; label: string; hint: string }[] = [
        { value: "join", label: "Join", hint: into ? "⚠ likely no effect (profile is inside)" : "merge" },
        { value: "cut", label: "Cut", hint: into ? "remove" : "⚠ nothing to cut here" },
        { value: "new", label: "New Body", hint: "separate" },
        { value: "intersect", label: "Intersect", hint: "keep overlap" },
      ];
      opts.sort((a, b) => (a.value === guess ? -1 : b.value === guess ? 1 : 0)); // default first
      const chosen = await choose<Op>("Extrude — operation", opts);
      this.committing = false;
      if (!chosen) {
        // modal dismissed — the tool is STILL ALIVE; say so instead of leaving
        // the user staring at an unchanged screen ("nothing happened")
        setPrompt("Extrude not committed — Enter/✓ to choose an operation · Esc to cancel");
        return;
      }
      op = chosen;
    } else if (this.editId && this.editOp) {
      // rolled-back model has no solid (this WAS the first solid) — keep the
      // saved operation rather than silently rewriting it to "new".
      op = this.editOp;
    }
    const feature: Feature = {
      id: this.editId ?? this.store.nextId(),
      type: "extrude",
      sketch: this.selected[0].sketchId,
      distance: Math.round(this.distance * 1000) / 1000,
      operation: op,
      regions: this.selected.map((wr) => [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z]),
      // capture the participants NOW: bodies hidden at creation stay excluded
      // from this boolean forever; later eye toggles are pure display. When
      // EDITING, the ORIGINAL capture is kept — re-capturing here would let
      // display toggles rewrite committed boolean history.
      hiddenBodies: this.editId ? this.editHiddenBodies : this.store.hiddenBodyIds(),
    };
    const id = feature.id;
    if (this.editId) {
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(this.editId, feature);
    } else {
      this.store.addFeature(feature);
    }
    this.overlay.clearRegionSelection();
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
    if (this.editId) {
      this.store.endEditPreview();
      this.overlay.clearRegionSelection();
    }
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    this.dim.hide();
    this.disposePreviewGeom();
    this.previewMat?.dispose();
    this.previewMat = null;
    this.previewKey = "";
    if (this.arrow) {
      this.viewport.removeFromScene(this.arrow);
      this.arrow.dispose();
      this.arrow = null;
    }
    this.overlay.setHoverRegion(null);
    this.viewport.suspendPicking = false;
    this.active = false;
    this.selected = [];
    if (this.editId !== null || this.forcedSketchId !== null) {
      this.editId = null;
      this.editOp = null;
      this.editHiddenBodies = undefined;
      this.forcedSketchId = null;
      this.overlay.update(this.store.document); // re-hide the consumed sketch
    }
    setPrompt(null);
  }

  /** remove + dispose the preview group's geometries (the material is reused) */
  private disposePreviewGeom() {
    if (!this.preview) return;
    this.viewport.removeFromScene(this.preview);
    for (const child of this.preview.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.preview = null;
  }
}
