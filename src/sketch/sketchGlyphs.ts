// On-canvas constraint glyphs: small DOM badges projected onto the sketch,
// mirroring SketchDimensions. Each shows a constraint's type; clicking one (in
// the select tool) deletes that constraint, and a double- or right-click deletes
// it even when the badge sits on the geometry it constrains, which claims plain
// clicks. Conflicting constraints render red.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { camHash } from "../viewport/camHash";
import { overlayHost, outsideRect } from "../viewport/overlayHost";
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
  /** Right-click on a badge. The owner renders the menu (this class owns no menu
   *  UI) and decides what it offers; `cIndex` is the constraint the badge names.
   *  This is the delete route geometry cannot steal — the glyph for
   *  horizontal/vertical/parallel/perpendicular/equal/midpoint/symmetric sits at
   *  the line MIDPOINT and the one for coincident/fix on an ENDPOINT, i.e. by
   *  construction exactly ON the operand, so onOverlapPick claims every left
   *  click and rebuilds the badge away mid-gesture. Reported 2026-08-31
   *  (59c5a7d7): "could not delete a parallel constraint". */
  onMenu: ((e: MouseEvent, cIndex: number) => void) | null = null;
  /** set by the pointerdown hook above; consumed by the click that follows */
  private suppressDelete = false;
  /** The previous left press on a badge, for our OWN double-click detection.
   *  The browser's `dblclick` is useless here: the first press runs
   *  onOverlapPick, which rebuilds the whole layer, so the two clicks land on
   *  different elements and the retargeted dblclick never reaches a badge
   *  (measured in Chromium — a dblclick on an overlapping glyph deleted
   *  nothing). This state lives on the instance, which outlives the elements. */
  private lastPress = { t: 0, x: 0, y: 0, cIndex: -1 };
  private static readonly DBL_MS = 500;
  private static readonly DBL_PX = 5;

  /** is this press the second half of a double-click on the same badge? */
  private isDoublePress(cIndex: number, e: PointerEvent): boolean {
    const p = this.lastPress;
    const hit =
      p.cIndex === cIndex &&
      Date.now() - p.t <= SketchGlyphs.DBL_MS &&
      Math.abs(e.clientX - p.x) <= SketchGlyphs.DBL_PX &&
      Math.abs(e.clientY - p.y) <= SketchGlyphs.DBL_PX;
    this.lastPress = hit
      ? { t: 0, x: 0, y: 0, cIndex: -1 } // consumed: a triple-click isn't two deletes
      : { t: Date.now(), x: e.clientX, y: e.clientY, cIndex };
    return hit;
  }

  constructor(private viewport: Viewport) {
    this.root = document.createElement("div");
    this.root.className = "sketch-glyphs";
    overlayHost().appendChild(this.root);
  }

  show(glyphs: ConstraintGlyph[], plane: SketchPlane, conflicts: Set<number>, over: Set<number>) {
    this.clear();
    this.plane = plane;
    for (const g of glyphs) {
      const el = document.createElement("div");
      if (g.pending) {
        // Not a constraint yet — the one this click would add. Muted, and NOT
        // clickable: there is nothing to delete, and offering a delete target
        // for something that does not exist is worse than no affordance at all.
        el.className = "sketch-glyph pending";
        el.textContent = g.label;
        el.title = "Will be applied when you click";
        this.root.appendChild(el);
        this.items.push({ el, pos: g.pos });
        continue;
      }
      const st = diagnosisOf(g.cIndex, conflicts, over);
      el.className = st ? `sketch-glyph ${st}` : "sketch-glyph";
      el.textContent = g.label;
      el.title = st === "conflict" ? "Conflicting constraint — click to delete"
        : st === "over" ? "Redundant (over-defined) constraint — click to delete"
        : "Click to delete this constraint (double- or right-click if it sits on geometry)";
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        // Primary button only, the same guard the dimension badges carry: a
        // secondary press must leave this element alive (and the selection
        // alone) for the contextmenu handler below, and onOverlapPick rebuilds
        // the whole layer when geometry claims the pick.
        if (e.button !== 0) return;
        // Escape hatch, and literally what the 59c5a7d7 reporter tried: a badge
        // sitting on its own operand loses every SINGLE click to the geometry
        // underneath, so a double-click deletes regardless of who won the
        // singles. It acts on the second PRESS, not on a `click`/`dblclick`,
        // because the rebuild this press would otherwise trigger detaches the
        // element those later events need. `suppressDelete` swallows the click
        // that follows this press (every pointerdown rewrites it, so it can
        // never go stale).
        if (this.isDoublePress(g.cIndex, e)) {
          this.suppressDelete = true;
          this.onDelete?.(g.cIndex);
          return;
        }
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
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onMenu?.(e, g.cIndex);
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
      const p = this.viewport.projectToOverlay(this.scratch);
      // Same rule as SketchDimensions: a glyph whose anchor has left the canvas
      // is not drawn at all. Clipping alone would leave half a badge that still
      // deletes a constraint when the click was aimed at the panel behind it.
      if (outsideRect(p)) {
        g.el.style.visibility = "hidden";
        continue;
      }
      g.el.style.visibility = "";
      g.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    }
  };
}
