// Highlighting without post-processing: edges recolor their LineMaterial; faces
// recolor their own vertex-color range (per-face tessellation keeps each face's
// vertices distinct, so this only tints the one face).

import * as THREE from "three";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { bodyOfFace, type ModelView } from "./render";

const EDGE_BASE = new THREE.Color(0x1b1f24);
const HOVER = new THREE.Color(0xffd089); // pale hot amber (under cursor)
// molten amber for SELECTED (the Forge accent) — distinct from the paler hover
// and the muted-ember "pickable" emphasis; reads as forged/locked-in.
const SELECT = new THREE.Color(0xff7a3c);
// ERROR: the edge a fillet/chamfer failed on. Highest paint precedence — hover
// and select must never overwrite it, or the "which edge is the problem" signal
// disappears the moment the user mouses over it.
const ERROR = new THREE.Color(0xe23b3b);

export class Highlighter {
  private hoveredEdge: Line2 | null = null;
  private hoveredFace: number | null = null;
  private selectedEdges = new Set<Line2>();
  private selectedFaces = new Set<number>();
  private selectedBodies = new Set<string>();
  private errorEdges = new Set<Line2>();
  // idle (un-hovered, un-selected) edge color. Raised to a visible "selectable"
  // tint while the fillet/chamfer edge tool is active so you can SEE every edge.
  private edgeBase = EDGE_BASE.clone();

  constructor(private view: ModelView) {}

  /** Set the idle edge color and repaint every idle edge to it. */
  setEdgeBase(color: THREE.Color) {
    this.edgeBase.copy(color);
    for (const e of this.view.edges) {
      if (e === this.hoveredEdge || this.selectedEdges.has(e) || this.errorEdges.has(e)) continue;
      (e.material as LineMaterial).color.copy(this.edgeBase);
    }
  }

  /** Paint these edges as ERRORS (red), replacing any previous error set.
   *  Precedence: error > select > hover — the error tint survives hover and
   *  selection toggles until the set is replaced (each rebuild re-derives it
   *  from the latest diagnostics, so it clears naturally when fixed). */
  setErrorEdges(lines: Line2[]) {
    const next = new Set(lines);
    for (const e of this.errorEdges) {
      if (next.has(e)) continue;
      // no longer failing — restore whatever tier it belongs to now
      const c = this.selectedEdges.has(e) ? SELECT : e === this.hoveredEdge ? HOVER : this.edgeBase;
      (e.material as LineMaterial).color.copy(c);
    }
    this.errorEdges = next;
    for (const e of this.errorEdges) (e.material as LineMaterial).color.copy(ERROR);
  }

  hoverEdge(line: Line2 | null) {
    if (this.hoveredEdge === line) return;
    if (
      this.hoveredEdge &&
      !this.selectedEdges.has(this.hoveredEdge) &&
      !this.errorEdges.has(this.hoveredEdge)
    ) {
      (this.hoveredEdge.material as LineMaterial).color.copy(this.edgeBase);
    }
    this.hoveredEdge = line;
    if (line && !this.selectedEdges.has(line) && !this.errorEdges.has(line)) {
      (line.material as LineMaterial).color.copy(HOVER);
    }
  }

  hoverFace(faceId: number | null) {
    if (this.hoveredFace === faceId) return;
    if (this.hoveredFace != null && !this.selectedFaces.has(this.hoveredFace)) {
      this.restoreFace(this.hoveredFace);
    }
    this.hoveredFace = faceId;
    if (faceId != null && !this.selectedFaces.has(faceId)) {
      this.paintFace(faceId, HOVER);
    }
  }

  clearHover() {
    this.hoverEdge(null);
    this.hoverFace(null);
  }

  toggleSelectEdge(line: Line2) {
    // membership always updates; the visible tint only changes when the edge
    // isn't in the error set (error paint has top precedence).
    if (this.selectedEdges.has(line)) {
      this.selectedEdges.delete(line);
      if (!this.errorEdges.has(line)) (line.material as LineMaterial).color.copy(this.edgeBase);
    } else {
      this.selectedEdges.add(line);
      if (!this.errorEdges.has(line)) (line.material as LineMaterial).color.copy(SELECT);
    }
  }

  toggleSelectFace(faceId: number) {
    if (this.selectedFaces.has(faceId)) {
      this.selectedFaces.delete(faceId);
      this.restoreFace(faceId);
    } else {
      this.selectedFaces.add(faceId);
      this.paintFace(faceId, SELECT);
    }
  }

  /** the currently selected edge lines (for pre-selected fillet/chamfer). */
  getSelectedEdges(): Line2[] {
    return [...this.selectedEdges];
  }

  /** the currently selected face ids (for pre-selected press/pull). */
  getSelectedFaces(): number[] {
    return [...this.selectedFaces];
  }

  clearSelection() {
    for (const e of this.selectedEdges) {
      if (!this.errorEdges.has(e)) (e.material as LineMaterial).color.copy(this.edgeBase);
    }
    for (const f of this.selectedFaces) this.restoreFace(f);
    this.selectedEdges.clear();
    this.selectedFaces.clear();
  }

  // --- whole-body selection (Bodies selection mode) ---------------------------

  toggleSelectBody(bodyId: string) {
    if (this.selectedBodies.has(bodyId)) {
      this.selectedBodies.delete(bodyId);
      this.restoreBody(bodyId);
    } else {
      this.selectedBodies.add(bodyId);
      this.paintBody(bodyId, SELECT);
    }
  }

  /** select exactly this body (clearing any other body selection). */
  selectOnlyBody(bodyId: string) {
    this.clearBodySelection();
    this.toggleSelectBody(bodyId);
  }

  getSelectedBodies(): string[] {
    return [...this.selectedBodies];
  }

  clearBodySelection() {
    for (const id of this.selectedBodies) this.restoreBody(id);
    this.selectedBodies.clear();
  }

  /** paint every vertex of the body's own (already-isolated) buffer. A body's
   *  geometry holds only its own vertices now, so "the whole body" IS the
   *  whole buffer — no faceId-range scan needed (unlike paintFace below, this
   *  never needs to scope to a sub-range within a shared buffer). */
  private paintBody(bodyId: string, color: THREE.Color) {
    const body = this.view.bodies.find((b) => b.id === bodyId);
    if (!body) return;
    const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    if (!colorAttr) return;
    for (let v = 0; v < colorAttr.count; v++) colorAttr.setXYZ(v, color.r, color.g, color.b);
    this.uploadRange(colorAttr, [0, colorAttr.count - 1]);
  }

  private paintFace(faceId: number, color: THREE.Color) {
    const body = bodyOfFace(this.view, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return;
    const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const index = body.mesh.geometry.getIndex();
    if (!colorAttr || !index) return;
    const range = this.forEachVertex(tris, index, (v) => {
      colorAttr.setXYZ(v, color.r, color.g, color.b);
    });
    if (range) this.uploadRange(colorAttr, range);
  }

  /** Restore one face's live color to its current base (BASE_COLOR, or the
   *  component/draft analysis color if an analysis is active). */
  private restoreFace(faceId: number) {
    const body = bodyOfFace(this.view, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return;
    const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const index = body.mesh.geometry.getIndex();
    if (!colorAttr || !index) return;
    const base = body.baseColors;
    const range = this.forEachVertex(tris, index, (v) => {
      const r = base[v * 3], g = base[v * 3 + 1], b = base[v * 3 + 2];
      if (r !== undefined && g !== undefined && b !== undefined) colorAttr.setXYZ(v, r, g, b);
    });
    if (range) this.uploadRange(colorAttr, range);
  }

  /** Restore every face of a body to its base color (the whole buffer — see
   *  paintBody's note on why no range scan is needed here). */
  private restoreBody(bodyId: string) {
    const body = this.view.bodies.find((b) => b.id === bodyId);
    if (!body) return;
    const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    if (!colorAttr) return;
    const base = body.baseColors;
    for (let v = 0; v < colorAttr.count; v++) {
      const r = base[v * 3], g = base[v * 3 + 1], b = base[v * 3 + 2];
      if (r !== undefined && g !== undefined && b !== undefined) colorAttr.setXYZ(v, r, g, b);
    }
    this.uploadRange(colorAttr, [0, colorAttr.count - 1]);
  }

  /** Run `fn` over every vertex of the given triangle indices, returning the
   *  touched [minVertex, maxVertex] span (or null if `tris` was empty). */
  private forEachVertex(
    tris: number[],
    index: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    fn: (v: number) => void,
  ): [number, number] | null {
    let lo = Infinity, hi = -Infinity;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        fn(v);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }

  /** Scope the GPU upload of a color-attribute edit to the touched vertex span
   *  (in vertex indices, inclusive) instead of re-uploading the whole buffer. */
  private uploadRange(attr: THREE.BufferAttribute, [lo, hi]: [number, number]) {
    attr.addUpdateRange(lo * 3, (hi - lo + 1) * 3);
    attr.needsUpdate = true;
  }

  /** Set the per-face base color (component / draft analysis) and repaint every
   *  non-selected face to it. Selected faces keep their highlight but their base
   *  updates so they restore correctly on deselect. Pass `() => BASE_COLOR` to
   *  clear an analysis. Body selections re-apply on top afterward. Loops every
   *  body's own buffer (faceIds are globally unique, so the same faceId never
   *  reappears in two bodies — each body only ever repaints its own faces). */
  setBase(colorOf: (faceId: number) => THREE.Color) {
    const cache = new Map<number, THREE.Color>();
    for (const body of this.view.bodies) {
      const colorAttr = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
      const index = body.mesh.geometry.getIndex();
      if (!colorAttr || !index) continue;
      const ids = body.faceIds;
      const base = body.baseColors;
      for (let t = 0; t < ids.length; t++) {
        const fid = ids[t];
        if (fid === undefined) continue;
        let col = cache.get(fid);
        if (!col) {
          col = colorOf(fid);
          cache.set(fid, col);
        }
        const selected = this.selectedFaces.has(fid);
        for (let k = 0; k < 3; k++) {
          const v = index.getX(t * 3 + k);
          base[v * 3] = col.r;
          base[v * 3 + 1] = col.g;
          base[v * 3 + 2] = col.b;
          if (!selected) colorAttr.setXYZ(v, col.r, col.g, col.b);
        }
      }
      // This is a full-buffer rewrite (every face), not a scoped one — clear any
      // pending partial ranges a prior paintFace/paintBody left queued so the
      // renderer does a full upload here instead of replaying a stale sub-range.
      colorAttr.clearUpdateRanges();
      colorAttr.needsUpdate = true;
    }
    // whole-body selections paint on top of the base — re-apply them
    for (const id of this.selectedBodies) this.paintBody(id, SELECT);
  }
}
