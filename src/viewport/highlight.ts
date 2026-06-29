// Highlighting without post-processing: edges recolor their LineMaterial; faces
// recolor their own vertex-color range (per-face tessellation keeps each face's
// vertices distinct, so this only tints the one face).

import * as THREE from "three";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { BASE_COLOR, type ModelView } from "./render";

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
      this.paintFace(this.hoveredFace, BASE_COLOR);
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
      this.paintFace(faceId, BASE_COLOR);
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
    for (const f of this.selectedFaces) this.paintFace(f, BASE_COLOR);
    this.selectedEdges.clear();
    this.selectedFaces.clear();
  }

  // --- whole-body selection (Bodies selection mode) ---------------------------

  toggleSelectBody(bodyId: string) {
    if (this.selectedBodies.has(bodyId)) {
      this.selectedBodies.delete(bodyId);
      this.paintBody(bodyId, BASE_COLOR);
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
    for (const id of this.selectedBodies) this.paintBody(id, BASE_COLOR);
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
}
