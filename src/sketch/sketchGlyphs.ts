// On-canvas constraint glyphs: small DOM badges projected onto the sketch,
// mirroring SketchDimensions. Each shows a constraint's type; clicking one (in
// the select tool) deletes that constraint. Conflicting constraints render red.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { camHash } from "../viewport/camHash";
import type { SketchPlane } from "./plane";
import { diagnosisOf, type ConstraintGlyph } from "./glyphs";

interface GlyphEl {
  el: HTMLDivElement;
  pos: THREE.Vector2;
}

export class SketchGlyphs {
  private root: HTMLDivElement;
  private items: GlyphEl[] = [];
  private plane: SketchPlane | null = null;
  private raf = 0;
  private scratch = new THREE.Vector3();
  private lastCamHash = "";
  /** delete the constraint at this index (wired by SketchMode) */
  onDelete: ((cIndex: number) => void) | null = null;
  /** Geometry-beats-glyph, mirroring SketchDimensions.onOverlapPick. A glyph is
   *  a DOM badge above the canvas, so in the dimension tool it would swallow the
   *  click that names an operand. Return true = "the click belonged to the tool
   *  underneath" and the glyph skips its delete for that click. */
  onOverlapPick: ((e: PointerEvent) => boolean) | null = null;
  /** set by the pointerdown hook above; consumed by the click that follows */
  private suppressDelete = false;

  constructor(private viewport: Viewport) {
    this.root = document.createElement("div");
    this.root.className = "sketch-glyphs";
    document.body.appendChild(this.root);
  }

  show(glyphs: ConstraintGlyph[], plane: SketchPlane, conflicts: Set<number>, over: Set<number>) {
    this.clear();
    this.plane = plane;
    for (const g of glyphs) {
      const el = document.createElement("div");
      const st = diagnosisOf(g.cIndex, conflicts, over);
      el.className = st ? `sketch-glyph ${st}` : "sketch-glyph";
      el.textContent = g.label;
      el.title = st === "conflict" ? "Conflicting constraint — click to delete"
        : st === "over" ? "Redundant (over-defined) constraint — click to delete"
        : "Click to delete this constraint";
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.suppressDelete = this.onOverlapPick?.(e) ?? false;
      });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.suppressDelete) {
          this.suppressDelete = false;
          return;
        }
        this.onDelete?.(g.cIndex);
      });
      this.root.appendChild(el);
      this.items.push({ el, pos: g.pos });
    }
    this.lastCamHash = ""; // force a reposition next frame
    if (!this.raf) this.loop();
  }

  hide() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.plane = null;
    this.clear();
  }

  /** glyphs accept clicks in the select and dimension tools; under a drawing tool
   *  they stay click-through. In the dimension tool onOverlapPick above arbitrates,
   *  so a click that names a dimension operand still reaches the tool. */
  setInteractive(on: boolean) {
    this.root.classList.toggle("glyphs-passive", !on);
  }

  private clear() {
    this.root.innerHTML = "";
    this.items = [];
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.plane) return;
    const cam = this.viewport.camera;
    const hash = camHash(cam);
    if (hash === this.lastCamHash) return;
    this.lastCamHash = hash;
    for (const g of this.items) {
      this.plane.to3D(g.pos.x, g.pos.y, this.scratch);
      const s = this.viewport.projectToScreen(this.scratch);
      g.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
    }
  };
}
