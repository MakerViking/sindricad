// Interactive Extrude (Fusion-style): select one or more profile AREAS, then set
// the distance by moving the cursor along the profile normal (live solid preview +
// arrow manipulator + numeric box). Areas can be pre-selected in the sketch or
// picked here: plain click picks one and starts the depth drag, Ctrl-click adds
// more (Enter to confirm the set). A ring (annulus) area previews/extrudes as a
// tube; selecting several areas unions them. Operation auto-selects: New Body when
// nothing exists, Join when adding (positive), Cut when removing (negative → red).

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
    this.distance = 10;
    this.overlay.setHoverRegion(null);
    this.dim.show([{ name: "distance", label: "D" }], () => void this.commit(), () => this.cancel());
    setPrompt(
      "Move to set depth · type a value + Enter · negative = cut · click to commit · Esc to cancel",
    );
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

  // Default operation: New Body when the doc has no solid yet, else Join/Cut by
  // drag sign. When a solid exists the user confirms/overrides via a modal.
  private currentOperation(): Op {
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (!hasSolid) return "new";
    return this.distance >= 0 ? "join" : "cut";
  }

  private committing = false;
  private async commit() {
    if (this.committing) return;
    if (!this.selected.length) return this.cancel();
    const v = this.dim.getValue("distance");
    if (v != null) this.distance = v; // the field is the truth: typed sign wins
    if (Math.abs(this.distance) < 1e-3) return; // ignore zero
    let op = this.currentOperation();
    // when a body already exists, let the user state the operation (Fusion-style):
    // New Body avoids any boolean (and the kernel crash on hard geometry).
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (hasSolid) {
      this.committing = true;
      const guess = op;
      const opts: { value: Op; label: string; hint: string }[] = [
        { value: "join", label: "Join", hint: "merge" },
        { value: "cut", label: "Cut", hint: "remove" },
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
    }
    const feature: Feature = {
      id: this.store.nextId(),
      type: "extrude",
      sketch: this.selected[0].sketchId,
      distance: Math.round(this.distance * 1000) / 1000,
      operation: op,
      regions: this.selected.map((wr) => [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z]),
      // capture the participants NOW: bodies hidden at creation stay excluded
      // from this boolean forever; later eye toggles are pure display
      hiddenBodies: this.store.hiddenBodyIds(),
    };
    const id = feature.id;
    this.store.addFeature(feature);
    this.overlay.clearRegionSelection();
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
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
