// Highlighting without post-processing: edges recolor their LineMaterial; faces
// recolor their own vertex-color range (per-face tessellation keeps each face's
// vertices distinct, so this only tints the one face).

import * as THREE from "three";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { ModelView } from "./render";

const EDGE_BASE = new THREE.Color(0x1b1f24);
const HOVER = new THREE.Color(0xffd089); // pale hot amber (under cursor)
// molten amber for SELECTED (the Forge accent) — distinct from the paler hover
// and the muted-ember "pickable" emphasis; reads as forged/locked-in.
const SELECT = new THREE.Color(0xff7a3c);

export class Highlighter {
  private hoveredEdge: Line2 | null = null;
  private hoveredFace: number | null = null;
  private selectedEdges = new Set<Line2>();
  private selectedFaces = new Set<number>();
  private selectedBodies = new Set<string>();
  // idle (un-hovered, un-selected) edge color. Raised to a visible "selectable"
  // tint while the fillet/chamfer edge tool is active so you can SEE every edge.
  private edgeBase = EDGE_BASE.clone();

  constructor(private view: ModelView) {}

  /** Set the idle edge color and repaint every idle edge to it. */
  setEdgeBase(color: THREE.Color) {
    this.edgeBase.copy(color);
    for (const e of this.view.edges) {
      if (e === this.hoveredEdge || this.selectedEdges.has(e)) continue;
      (e.material as LineMaterial).color.copy(this.edgeBase);
    }
  }

  hoverEdge(line: Line2 | null) {
    if (this.hoveredEdge === line) return;
    if (this.hoveredEdge && !this.selectedEdges.has(this.hoveredEdge)) {
      (this.hoveredEdge.material as LineMaterial).color.copy(this.edgeBase);
    }
    this.hoveredEdge = line;
    if (line && !this.selectedEdges.has(line)) {
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
    if (this.selectedEdges.has(line)) {
      this.selectedEdges.delete(line);
      (line.material as LineMaterial).color.copy(this.edgeBase);
    } else {
      this.selectedEdges.add(line);
      (line.material as LineMaterial).color.copy(SELECT);
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
    for (const e of this.selectedEdges)
      (e.material as LineMaterial).color.copy(this.edgeBase);
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

  /** paint every triangle whose faceId falls in the body's range. */
  private paintBody(bodyId: string, color: THREE.Color) {
    const body = this.view.bodies.find((b) => b.id === bodyId);
    if (!body) return;
    const lo = body.faceStart;
    const hi = body.faceStart + body.faceCount;
    const geo = this.view.mesh.geometry;
    const colorAttr = geo.getAttribute("color") as THREE.BufferAttribute;
    const index = geo.getIndex();
    if (!colorAttr || !index) return;
    const ids = this.view.faceIds;
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] < lo || ids[t] >= hi) continue;
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        colorAttr.setXYZ(v, color.r, color.g, color.b);
      }
    }
    colorAttr.needsUpdate = true;
  }

  private paintFace(faceId: number, color: THREE.Color) {
    const geo = this.view.mesh.geometry;
    const colorAttr = geo.getAttribute("color") as THREE.BufferAttribute;
    const index = geo.getIndex();
    if (!colorAttr || !index) return;
    const ids = this.view.faceIds;
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] !== faceId) continue;
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        colorAttr.setXYZ(v, color.r, color.g, color.b);
      }
    }
    colorAttr.needsUpdate = true;
  }

  /** Restore one face's live color to its current base (BASE_COLOR, or the
   *  component/draft analysis color if an analysis is active). */
  private restoreFace(faceId: number) {
    const geo = this.view.mesh.geometry;
    const colorAttr = geo.getAttribute("color") as THREE.BufferAttribute;
    const index = geo.getIndex();
    if (!colorAttr || !index) return;
    const ids = this.view.faceIds;
    const base = this.view.baseColors;
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] !== faceId) continue;
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        colorAttr.setXYZ(v, base[v * 3], base[v * 3 + 1], base[v * 3 + 2]);
      }
    }
    colorAttr.needsUpdate = true;
  }

  /** Restore every face of a body to its base color. */
  private restoreBody(bodyId: string) {
    const body = this.view.bodies.find((b) => b.id === bodyId);
    if (!body) return;
    const lo = body.faceStart;
    const hi = body.faceStart + body.faceCount;
    const geo = this.view.mesh.geometry;
    const colorAttr = geo.getAttribute("color") as THREE.BufferAttribute;
    const index = geo.getIndex();
    if (!colorAttr || !index) return;
    const ids = this.view.faceIds;
    const base = this.view.baseColors;
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] < lo || ids[t] >= hi) continue;
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        colorAttr.setXYZ(v, base[v * 3], base[v * 3 + 1], base[v * 3 + 2]);
      }
    }
    colorAttr.needsUpdate = true;
  }

  /** Set the per-face base color (component / draft analysis) and repaint every
   *  non-selected face to it. Selected faces keep their highlight but their base
   *  updates so they restore correctly on deselect. Pass `() => BASE_COLOR` to
   *  clear an analysis. Body selections re-apply on top afterward. */
  setBase(colorOf: (faceId: number) => THREE.Color) {
    const geo = this.view.mesh.geometry;
    const colorAttr = geo.getAttribute("color") as THREE.BufferAttribute;
    const index = geo.getIndex();
    if (!colorAttr || !index) return;
    const ids = this.view.faceIds;
    const base = this.view.baseColors;
    const cache = new Map<number, THREE.Color>();
    for (let t = 0; t < ids.length; t++) {
      const fid = ids[t];
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
    colorAttr.needsUpdate = true;
    // whole-body selections paint on top of the base — re-apply them
    for (const id of this.selectedBodies) this.paintBody(id, SELECT);
  }
}
