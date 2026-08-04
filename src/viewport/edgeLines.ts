// One LineSegments2 per body, one shared LineMaterial, per-edge colour written
// into the instance colour buffer.
//
// Before this every B-rep edge was its own THREE.Line2 with its OWN
// LineMaterial. On an imported assembly that is ~348,000 objects and ~348,000
// materials: 12.2 GiB peak RSS (an OOM on a 16 GB machine, not merely a slow
// frame) and 113-119 ms/frame of scene-graph traversal before a single draw
// call. Measured in WebKitGTK — the webview Tauri actually uses on Linux, and
// 2.2-2.6x worse than V8 at exactly that traversal. Merging per body measured
// 348,844 -> 6,124 objects and 348,840 -> 3,061 materials, frame 1,385 -> 27-35 ms.
// Hidden edges do NOT help: `visible = false` still costs the traversal, which
// is why hiding is a geometry rebuild here rather than a per-object flag.
//
// The identity change that ripples outward: an edge is an EdgeRef, not a THREE
// object. A ref is created once per body build and never replaced, so consumers
// keep them in a Set exactly as they kept Line2s.

import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { RebuildResult } from "../types";

export type EdgePt = [number, number, number];

/** A stable handle to one B-rep edge. Identity is meaningful: the same edge
 *  always yields the same ref for the life of the body that owns it. */
export interface EdgeRef {
  readonly id: string;
  /** owning body id — undefined only for orphan edges (see ModelView). */
  readonly body: string | undefined;
  readonly points: EdgePt[];
  /** the merged object that draws this edge, and this edge's slot in it */
  readonly draw: BodyEdges;
  readonly slot: number;
}

export const EDGE_IDLE_COLOR = 0x1b1f24;
export const EDGE_IDLE_WIDTH = 1.6;

/** Every edge of ONE body, merged into a single LineSegments2. */
export class BodyEdges {
  readonly object: LineSegments2;
  readonly material: LineMaterial;
  readonly refs: EdgeRef[] = [];

  /** per edge: display-only hiding (flush seams). Hiding rebuilds the geometry
   *  rather than flagging an object, because there is no object to flag — and
   *  because a hidden-but-present segment would still cost traversal. */
  private hidden: Uint8Array;
  /** per edge: the colour it should currently be (survives a geometry rebuild) */
  private rgb: Float32Array;
  /** per edge: first segment in the LIVE geometry, or -1 when hidden */
  private segStart: Int32Array;
  /** per edge: how many segments it contributes (points - 1) */
  private segCount: Int32Array;
  /** the live instance colour data — held by reference (LineSegmentsGeometry
   *  .setColors does not copy a Float32Array), so a recolour writes into it. */
  private colorBuf = new Float32Array(0);
  /** segment index -> edge slot; this is the picking table, per body. Keeping
   *  it body-indexed is deliberate: merging ACROSS bodies later only has to
   *  concatenate these, not redesign the lookup. */
  private segOwner = new Int32Array(0);
  private liveSegments = 0;
  private bodyVisible = true;
  private dirty = true;

  constructor(edges: RebuildResult["edges"], resolution: THREE.Vector2) {
    const n = edges.length;
    this.hidden = new Uint8Array(n);
    this.rgb = new Float32Array(n * 3);
    this.segStart = new Int32Array(n);
    this.segCount = new Int32Array(n);
    const base = new THREE.Color(EDGE_IDLE_COLOR);
    for (let i = 0; i < n; i++) {
      const e = edges[i]!;
      this.refs.push({ id: e.id, body: e.body, points: e.points, draw: this, slot: i });
      this.segCount[i] = Math.max(0, e.points.length - 1);
      this.rgb[i * 3] = base.r;
      this.rgb[i * 3 + 1] = base.g;
      this.rgb[i * 3 + 2] = base.b;
    }

    // ONE material for the whole body. Its own colour stays white; the per-edge
    // colour arrives as an instance colour and is multiplied by it.
    this.material = new LineMaterial({
      color: 0xffffff,
      vertexColors: true,
      linewidth: EDGE_IDLE_WIDTH,
      worldUnits: false,
      depthTest: true,
    });
    this.material.resolution.copy(resolution);
    this.object = new LineSegments2(new LineSegmentsGeometry(), this.material);
    this.object.name = "edges";
    this.object.userData.edges = this;
    this.flush();
  }

  /** Rebuild the drawn geometry from the currently visible edges. O(edges), and
   *  a no-op unless something changed — call it once after a BATCH of hides. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;

    let segs = 0;
    for (let i = 0; i < this.refs.length; i++) if (!this.hidden[i]) segs += this.segCount[i]!;
    this.liveSegments = segs;

    // An empty body still gets a well-formed (degenerate) geometry rather than
    // an attribute-less one: three's raycast and computeBoundingSphere both
    // read instanceStart directly, and it is never drawn (visible is false).
    const count = Math.max(segs, 1);
    const pos = new Float32Array(count * 6);
    const col = new Float32Array(count * 6);
    const owner = new Int32Array(count).fill(-1);

    let s = 0;
    for (let i = 0; i < this.refs.length; i++) {
      if (this.hidden[i]) { this.segStart[i] = -1; continue; }
      this.segStart[i] = s;
      const pts = this.refs[i]!.points;
      const r = this.rgb[i * 3]!, g = this.rgb[i * 3 + 1]!, b = this.rgb[i * 3 + 2]!;
      for (let k = 0; k + 1 < pts.length; k++, s++) {
        const a = pts[k]!, c = pts[k + 1]!;
        const o = s * 6;
        pos[o] = a[0]; pos[o + 1] = a[1]; pos[o + 2] = a[2];
        pos[o + 3] = c[0]; pos[o + 4] = c[1]; pos[o + 5] = c[2];
        col[o] = r; col[o + 1] = g; col[o + 2] = b;
        col[o + 3] = r; col[o + 4] = g; col[o + 5] = b;
        owner[s] = i;
      }
    }

    const geo = new LineSegmentsGeometry();
    geo.setPositions(pos);
    geo.setColors(col);
    this.object.geometry.dispose();
    this.object.geometry = geo;
    this.colorBuf = col;
    this.segOwner = owner;
    this.applyVisible();
  }

  /** Which edge a raycast hit belongs to. `segment` is the `faceIndex` three
   *  reports for a LineSegments2 hit — the instance (segment) index. */
  refAtSegment(segment: number): EdgeRef | undefined {
    const slot = this.segOwner[segment];
    return slot === undefined || slot < 0 ? undefined : this.refs[slot];
  }

  /** Repaint one edge. Cheap: writes its own segment span and uploads only that
   *  span, the same discipline highlight.ts uses for face vertex colours. */
  setColor(slot: number, color: THREE.Color) {
    this.rgb[slot * 3] = color.r;
    this.rgb[slot * 3 + 1] = color.g;
    this.rgb[slot * 3 + 2] = color.b;
    const start = this.segStart[slot]!;
    const n = this.segCount[slot]!;
    if (start < 0 || n === 0) return; // hidden — the colour lands on the next flush
    for (let s = start; s < start + n; s++) {
      const o = s * 6;
      this.colorBuf[o] = color.r; this.colorBuf[o + 1] = color.g; this.colorBuf[o + 2] = color.b;
      this.colorBuf[o + 3] = color.r; this.colorBuf[o + 4] = color.g; this.colorBuf[o + 5] = color.b;
    }
    const attr = this.object.geometry.attributes.instanceColorStart as
      THREE.InterleavedBufferAttribute | undefined;
    if (attr) {
      attr.data.addUpdateRange(start * 6, n * 6);
      attr.data.needsUpdate = true;
    }
  }

  /** Repaint EVERY edge (used when the idle base colour changes). One upload. */
  setColorAll(color: THREE.Color, skip?: (ref: EdgeRef) => boolean) {
    for (let i = 0; i < this.refs.length; i++) {
      if (skip?.(this.refs[i]!)) continue;
      this.rgb[i * 3] = color.r;
      this.rgb[i * 3 + 1] = color.g;
      this.rgb[i * 3 + 2] = color.b;
      const start = this.segStart[i]!;
      const n = this.segCount[i]!;
      if (start < 0) continue;
      for (let s = start; s < start + n; s++) {
        const o = s * 6;
        this.colorBuf[o] = color.r; this.colorBuf[o + 1] = color.g; this.colorBuf[o + 2] = color.b;
        this.colorBuf[o + 3] = color.r; this.colorBuf[o + 4] = color.g; this.colorBuf[o + 5] = color.b;
      }
    }
    const attr = this.object.geometry.attributes.instanceColorStart as
      THREE.InterleavedBufferAttribute | undefined;
    if (attr) {
      attr.data.clearUpdateRanges(); // whole-buffer rewrite; drop queued sub-ranges
      attr.data.needsUpdate = true;
    }
  }

  /** Hide/show one edge (display only). Takes effect on the next flush(). */
  setHidden(slot: number, hidden: boolean) {
    const v = hidden ? 1 : 0;
    if (this.hidden[slot] === v) return;
    this.hidden[slot] = v;
    this.dirty = true;
  }

  isHidden(slot: number): boolean {
    return this.hidden[slot] === 1;
  }

  /** Un-hide every edge. hideFlushSeams only ever HIDES, and a body reused
   *  across a rebuild (etag unchanged) keeps this object — so without this its
   *  seam-hiding from the previous model would accumulate and never come back.
   *  The old one-Line2-per-edge code got this for free, by reassigning
   *  `e.visible` on every edge each rebuild. */
  showAll() {
    for (let i = 0; i < this.hidden.length; i++) {
      if (this.hidden[i]) { this.hidden[i] = 0; this.dirty = true; }
    }
  }

  /** Whether this body is shown at all (body hiding / isolate). */
  setBodyVisible(v: boolean) {
    this.bodyVisible = v;
    this.applyVisible();
  }

  private applyVisible() {
    this.object.visible = this.bodyVisible && this.liveSegments > 0;
  }

  /** Any edge currently drawn and pickable? (`object.visible` folds in both the
   *  body's visibility and "this body has edges left after hiding".) */
  get pickable(): boolean {
    return this.object.visible;
  }

  /** The refs a pick or a chain walk may land on — visible body, unhidden edge. */
  visibleRefs(): EdgeRef[] {
    if (!this.object.visible) return [];
    return this.refs.filter((r) => this.segStart[r.slot]! >= 0);
  }

  setResolution(res: THREE.Vector2) {
    this.material.resolution.copy(res);
  }

  /** Restore build-time appearance on a REUSED body (see resetBodyAppearance). */
  resetAppearance() {
    this.object.position.set(0, 0, 0);
    this.material.clippingPlanes = null;
    this.material.transparent = false;
    this.material.opacity = 1;
    this.material.color.setHex(0xffffff);
    this.material.linewidth = EDGE_IDLE_WIDTH;
    this.showAll(); // seam hiding is re-derived from the new model, not inherited
    this.setColorAll(new THREE.Color(EDGE_IDLE_COLOR));
  }

  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
