// Interactive Extrude (Fusion-style): pick a profile region, then set the
// distance by moving the cursor along the profile normal (with a live solid
// preview + an arrow manipulator + a numeric box). Operation auto-selects:
// New Body when nothing exists, Join when adding (positive), Cut when removing
// (negative, preview turns red). Commit builds it authoritatively in the sidecar.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { pointInLoop } from "../sketch/region";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { disposeObject } from "../viewport/dispose";

type Phase = "pick" | "drag";

export class ExtrudeTool {
  active = false;
  private phase: Phase = "pick";
  private region: WorldRegion | null = null;
  private distance = 10;
  private preview: THREE.Mesh | null = null;
  private previewKey = ""; // depth+sign of the built preview geometry
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
    this.region = null;
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("keydown", this.boundKey, true);
    setPrompt("Select a profile to extrude");
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = r ? "pointer" : "default";
      return;
    }
    // drag: distance follows cursor projection onto the normal axis
    if (!this.region) return;
    if (!this.dim.isUserDriven("distance")) {
      const ray = this.viewport.rayFrom(e.clientX, e.clientY).ray;
      const d = distanceAlongAxis(ray, this.region.centroid3D, this.region.plane.n);
      this.distance = d;
      this.dim.updateFromCursor({ distance: Math.abs(d) });
    } else {
      const v = this.dim.getValue("distance");
      if (v != null) this.distance = Math.sign(this.distance || 1) * v;
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
      this.region = r;
      this.phase = "drag";
      this.distance = 10;
      this.dim.show([{ name: "distance", label: "D" }], () => this.commit());
      setPrompt(
        "Move to set depth · type a value + Enter · negative = cut · click to commit · Esc to cancel",
      );
      this.updatePreview();
    } else {
      e.preventDefault();
      this.commit();
    }
  }

  private onKey(e: KeyboardEvent) {
    if (this.dim.isActive && e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") this.cancel();
      return;
    }
    if (e.key === "Escape") this.cancel();
  }

  // --- geometry helpers ---
  /** the front-most region whose 2D loop contains the cursor (nearest to camera) */
  private regionUnder(cx: number, cy: number): WorldRegion | null {
    const ray = this.viewport.rayFrom(cx, cy).ray;
    let best: WorldRegion | null = null;
    let bestDist = Infinity;
    for (const wr of this.overlay.regions) {
      if (!ray.intersectPlane(wr.plane.plane, this.hitScratch)) continue;
      const p2d = wr.plane.to2D(this.hitScratch);
      if (!pointInLoop(p2d, wr.region.loop)) continue;
      const d = ray.origin.distanceToSquared(this.hitScratch);
      if (d < bestDist) {
        bestDist = d;
        best = wr;
      }
    }
    return best;
  }

  private updatePreview() {
    if (!this.region) return;
    const plane = this.region.plane;
    const sign = this.distance >= 0 ? 1 : -1;
    const depth = Math.abs(this.distance);
    const cut = sign < 0;

    // only rebuild the (relatively expensive) extrude geometry when depth/sign
    // actually changed — the cursor fires many moves at the same depth.
    const key = `${depth.toFixed(3)}:${sign}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      const shape = new THREE.Shape(this.region.region.loop.map((p) => p.clone()));
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
      geo.applyMatrix4(plane.basisMatrix(sign)); // local +Z -> plane normal (flipped on cut)
      if (!this.preview) {
        this.preview = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            transparent: true,
            opacity: 0.5,
            metalness: 0.1,
            roughness: 0.6,
          }),
        );
        this.viewport.addToScene(this.preview);
      } else {
        this.preview.geometry.dispose();
        this.preview.geometry = geo;
      }
    }
    if (this.preview) {
      (this.preview.material as THREE.MeshStandardMaterial).color.set(
        cut ? 0xff5c5c : 0x5b9bff,
      );
    }

    // arrow manipulator along the normal
    const dir = plane.n.clone().multiplyScalar(sign);
    if (!this.arrow) {
      this.arrow = new THREE.ArrowHelper(dir, this.region.centroid3D, depth || 1, 0xffd24a, 6, 3);
      this.viewport.addToScene(this.arrow);
    } else {
      this.arrow.position.copy(this.region.centroid3D);
      this.arrow.setDirection(dir);
      this.arrow.setLength(Math.max(depth, 1), 6, 3);
    }
  }

  // Deliberate MVP heuristic: New Body when the doc has no solid yet, else
  // Join/Cut by drag sign. A fuller version would consider the specific body
  // and whether the profile actually intersects it (needs sketch-on-face).
  private currentOperation(): "new" | "join" | "cut" {
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (!hasSolid) return "new";
    return this.distance >= 0 ? "join" : "cut";
  }

  private commit() {
    if (!this.region) return this.cancel();
    const v = this.dim.getValue("distance");
    if (v != null) this.distance = Math.sign(this.distance || 1) * v;
    if (Math.abs(this.distance) < 1e-3) return; // ignore zero
    const c = this.region.centroid3D;
    const feature: Feature = {
      id: this.store.nextId(),
      type: "extrude",
      sketch: this.region.sketchId,
      distance: Math.round(this.distance * 1000) / 1000,
      operation: this.currentOperation(),
      region: [c.x, c.y, c.z],
    };
    const id = feature.id;
    this.store.addFeature(feature);
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
    if (this.preview) {
      this.viewport.removeFromScene(this.preview);
      disposeObject(this.preview);
      this.preview = null;
    }
    this.previewKey = "";
    if (this.arrow) {
      this.viewport.removeFromScene(this.arrow);
      this.arrow.dispose();
      this.arrow = null;
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.region = null;
    setPrompt(null);
  }
}

/** signed distance along `dir` (unit) of the closest point on the axis to the ray */
function distanceAlongAxis(
  ray: THREE.Ray,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
): number {
  const w0 = ray.origin.clone().sub(origin);
  const b = ray.direction.dot(dir);
  const d = ray.direction.dot(w0);
  const e = dir.dot(w0);
  const denom = 1 - b * b; // a=c=1 (unit vectors)
  if (Math.abs(denom) < 1e-6) return -e;
  return (e - b * d) / denom; // signed param along dir
}
