// Interactive Loft (Fusion-style): pick two or more profile AREAS in order and
// the loft previews live as soon as the second profile is added — click more to
// add, click a picked one again to drop it, Enter to commit, Esc to cancel. Each
// profile keeps its holes, so two concentric-ring profiles loft into a tube (the
// sidecar resolves each region anchor to its face; see builder._handle_loft).
//
// Profiles are stored as {sketch, anchor} DATA, not live WorldRegion refs: a
// preview rebuild re-detects regions, so a held ref would go stale. The anchor
// point is stable and re-resolves against the rebuilt regions each time.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { pointInRegion } from "../sketch/region";
import { setPrompt } from "../ui/prompt";

interface Profile {
  sketch: string;
  region: [number, number, number]; // interior anchor (world), stable across rebuilds
  key: string; // sketch + anchor, for pick de-dup / toggle
}

export class LoftTool {
  active = false;
  private profiles: Profile[] = [];
  private previewId = "";
  private onDone: ((id: string | null) => void) | null = null;
  private hitScratch = new THREE.Vector3();

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
    this.onDone = onDone;
    this.previewId = this.store.nextId();
    this.viewport.suspendPicking = true;
    // seed from any profiles already selected in the model view, in the order
    // the selection reports them (so "pick both, then Loft" works too)
    this.profiles = this.overlay.selectedRegions().map((wr) => this.toProfile(wr));
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("keydown", this.boundKey, true);
    this.refresh();
  }

  private toProfile(wr: WorldRegion): Profile {
    const p = wr.interior3D;
    const region: [number, number, number] = [p.x, p.y, p.z];
    return { sketch: wr.sketchId, region, key: `${wr.sketchId}|${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}` };
  }

  private onMove(e: PointerEvent) {
    const r = this.regionUnder(e.clientX, e.clientY);
    this.overlay.setHoverRegion(r);
    this.viewport.domElement.style.cursor = r ? "pointer" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const r = this.regionUnder(e.clientX, e.clientY);
    if (!r) return;
    e.preventDefault();
    const prof = this.toProfile(r);
    const i = this.profiles.findIndex((p) => p.key === prof.key);
    if (i >= 0) this.profiles.splice(i, 1); // click a picked profile again to drop it
    else this.profiles.push(prof);
    this.refresh();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); this.cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); this.commit(); }
  }

  /** re-highlight the picked profiles and refresh the live preview */
  private refresh() {
    this.overlay.selectRegionsByPoints(this.profiles.map((p) => p.region));
    const n = this.profiles.length;
    if (n >= 2) {
      this.store.setPreview(this.buildFeature());
      setPrompt(`Loft: ${n} profiles · click more, or a picked one to drop it · Enter to finish · Esc to cancel`);
    } else {
      this.store.setPreview(null);
      setPrompt(
        n === 1
          ? "Loft: click a second profile · Esc to cancel"
          : "Loft: click the first profile · Esc to cancel",
      );
    }
  }

  private buildFeature(id = this.previewId): Feature {
    return {
      id,
      type: "loft",
      operation: "new",
      profiles: this.profiles.map((p) => ({ sketch: p.sketch, region: p.region })),
    } as Feature;
  }

  private commit() {
    if (this.profiles.length < 2) {
      setPrompt("Loft needs at least two profiles · click another · Esc to cancel");
      return;
    }
    this.store.setPreview(null);
    const feature = this.buildFeature(this.store.nextId());
    this.store.addFeature(feature);
    const id = feature.id;
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
    if (!this.active) return;
    this.store.setPreview(null);
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown);
    window.removeEventListener("keydown", this.boundKey, true);
    this.overlay.setHoverRegion(null);
    this.overlay.selectRegionsByPoints([]);
    this.viewport.domElement.style.cursor = "default";
    this.viewport.suspendPicking = false;
    this.profiles = [];
    this.active = false;
    setPrompt(null);
  }

  /** front-most committed region whose material (loop minus holes) is under the cursor */
  private regionUnder(cx: number, cy: number): WorldRegion | null {
    const ray = this.viewport.rayFrom(cx, cy).ray;
    let best: WorldRegion | null = null;
    let bestDist = Infinity;
    for (const wr of this.overlay.regions) {
      if (!ray.intersectPlane(wr.plane.plane, this.hitScratch)) continue;
      if (!pointInRegion(wr.plane.to2D(this.hitScratch), wr.region)) continue;
      const d = ray.origin.distanceToSquared(this.hitScratch);
      if (d < bestDist) { bestDist = d; best = wr; }
    }
    return best;
  }
}
