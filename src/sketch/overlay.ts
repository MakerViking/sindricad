// Renders sketches in 3D: committed sketch curves (always visible, like mainstream MCAD),
// translucent profile region fills, the active sketch being drawn, the
// in-progress preview entity, and the snap glyph. Region metadata is exposed so
// the extrude tool can hit-test and preview.
//
// Materials are module-shared (one per color) so the per-pointer-move redraw
// allocates only geometry, never materials; clearGroup therefore disposes
// geometry only and leaves the shared materials intact.

import * as THREE from "three";
import type { CadDocument, PlaneSpec } from "../types";
import { SketchPlane } from "./plane";
import { resolveEntities } from "./resolve";
import {
  detectRegions,
  entityPolyline,
  glyphRegion,
  pointInRegion,
  regionsByEntities,
  type Region,
} from "./region";
import { worldPointInRegion } from "./regionSelect";
import { dimensionSegments, asRound } from "./entityDims";
import { distToSeg } from "./geom2d";
import { getCachedText, warmText } from "./textCache";
import type { TextFace } from "../geometry/client";
import type { SnapKind } from "./snap";
import type { ResolvedEntity } from "./snap";

export interface WorldRegion {
  sketchId: string;
  region: Region;
  plane: SketchPlane;
  centroid3D: THREE.Vector3;
  interior3D: THREE.Vector3; // a point inside the material — selection anchor
  fill?: THREE.Mesh; // the fill mesh, for hover/selection recoloring
  groupId?: string; // regions selected/hovered as a unit (all glyphs of one text)
  entityId?: string; // the source text entity, for double-click-to-edit
}

/** One stored region reference as a feature persists it: the entities that bound
 *  the area, and the interior point recorded alongside them. The ids are what
 *  survives the user moving the geometry; the point is the legacy form and the
 *  tie-break. Mirrors the extrude feature's `regionEntities` / `regionHoleEntities`
 *  / `regions` triple (src/types.ts), one index at a time. */
export interface RegionRef {
  entityIds: string[];
  /** parallel to the region's holes; `undefined` means the reference does not
   *  record them (not that the region has none) — see regionsByEntities */
  holeEntityIds?: string[][] | undefined;
  point?: [number, number, number] | undefined;
}

export const CURVE_COLOR = 0x5b9bff; // under-constrained blue
export const PREVIEW_COLOR = 0xffffff;
export const SELECT_COLOR = 0xff9d3b; // selected sketch entity (orange)
export const ENDPOINT_COLOR = 0x9ec5ff; // addressable endpoint dot (lighter than the curve)
export const DIM_COLOR = 0x8fa4bd; // muted blue-gray for dimension annotations
const FILL_COLOR = 0x3a7bd5;

const lineMats = new Map<number, THREE.LineBasicMaterial>();
function lineMat(color: number): THREE.LineBasicMaterial {
  let m = lineMats.get(color);
  if (!m) {
    // depthTest TRUE: WebKitGTK does not render LineBasicMaterial lines with
    // depthTest:false (the grid/model edges, which use depthTest:true, render
    // fine). The coplanar grids + the dimmed model all have depthWrite:false, so
    // these lines never z-fight — they just paint on top via renderOrder.
    m = new THREE.LineBasicMaterial({ color, depthTest: true });
    lineMats.set(color, m);
  }
  return m;
}
// construction geometry: dashed orange (referenceable, not a profile)
const CONSTRUCTION_MAT = new THREE.LineDashedMaterial({
  color: 0xffa64d,
  dashSize: 1.6,
  gapSize: 1.0,
  depthTest: true,
});
// projected reference geometry: purple (linked/fixed, Fusion-style); a stale
// projection (source no longer resolves — last shape kept) tints amber
const PROJECTED_COLOR = 0xb07fe8;
const PROJECTED_STALE_COLOR = 0xd9a24d;
const FILL_MAT = new THREE.MeshBasicMaterial({
  color: FILL_COLOR,
  transparent: true,
  opacity: 0.18,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const FILL_HOVER_MAT = new THREE.MeshBasicMaterial({
  color: FILL_COLOR,
  transparent: true,
  opacity: 0.34,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const FILL_SELECTED_MAT = new THREE.MeshBasicMaterial({
  color: SELECT_COLOR,
  transparent: true,
  opacity: 0.34,
  side: THREE.DoubleSide,
  depthWrite: false,
});

// filled glyph interior is drawn by the region fill layer (fillMesh) so it can
// show hover/selection and be picked for extrude — see SketchOverlay.glyphWorldRegions.

export class SketchOverlay {
  readonly group = new THREE.Group();
  private committed = new THREE.Group();
  private fills = new THREE.Group();
  private activeFills = new THREE.Group(); // profile fills for the active (hidden) sketch
  private activeSketch = new THREE.Group(); // active sketch's committed curves
  private previewGroup = new THREE.Group(); // the rubber-band, rebuilt per move
  private snapMarker: THREE.Mesh;
  private pendingMarker: THREE.Mesh;
  private planeCache = new Map<string, SketchPlane>();
  regions: WorldRegion[] = []; // committed-sketch regions
  private activeRegions: WorldRegion[] = []; // active-sketch regions (sketch mode)
  // selection is a set of world interior points (parametric: re-resolved each rebuild
  // against region material, so it survives sketch edits and the sketch→model swap)
  private selectedRegionPoints: [number, number, number][] = [];
  private hovered: WorldRegion | null = null;

  constructor() {
    this.group.add(
      this.committed,
      this.fills,
      this.activeFills,
      this.activeSketch,
      this.previewGroup,
    );
    this.group.renderOrder = 10;

    this.snapMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 1.0, 16),
      new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: true }),
    );
    this.snapMarker.renderOrder = 30;
    this.snapMarker.visible = false;
    this.group.add(this.snapMarker);

    // The endpoint a constraint flow is currently holding. A filled disc rather
    // than the snap ring, so "I have this point" never reads as "you could snap
    // here": the two can be on screen at once and mean different things.
    this.pendingMarker = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 20),
      new THREE.MeshBasicMaterial({ color: 0x35d07f, depthTest: false }),
    );
    this.pendingMarker.renderOrder = 31; // above the snap ring
    this.pendingMarker.visible = false;
    this.group.add(this.pendingMarker);
  }

  planeFor(spec: PlaneSpec): SketchPlane {
    const key = typeof spec === "string" ? spec : JSON.stringify(spec);
    let p = this.planeCache.get(key);
    if (!p) {
      p = new SketchPlane(spec);
      this.planeCache.set(key, p);
    }
    return p;
  }

  /** Decides which committed sketches are shown on the model. Set by the app so
   *  sketches consumed by a feature hide by default (MCAD-style), keeping the
   *  solid's own edges visible/selectable. */
  sketchVisible: (id: string) => boolean = () => true;

  /** Rebuild committed sketch curves + region fills from the document. */
  update(doc: CadDocument, hiddenSketchId: string | null = null) {
    this.clearGroup(this.committed);
    this.clearGroup(this.fills);
    this.regions = [];

    for (const f of doc.features) {
      if (f.type !== "sketch") continue;
      if (f.id === hiddenSketchId) continue; // active sketch drawn by the editor
      if (!this.sketchVisible(f.id)) continue; // hidden (e.g. consumed by a feature)
      const plane = this.planeFor(f.plane);
      const ents = resolveEntities(f, doc.parameters);

      for (const obj of curveObjects(ents, plane, CURVE_COLOR)) {
        obj.userData.sketchId = f.id; // + entityId from curveObjects → Project-tool picking
        this.committed.add(obj);
      }
      for (const region of detectRegions(f.id, ents)) {
        const wr: WorldRegion = {
          sketchId: f.id,
          region,
          plane,
          centroid3D: plane.to3D(region.centroid.x, region.centroid.y),
          interior3D: plane.to3D(region.interior.x, region.interior.y),
        };
        wr.fill = fillMesh(region, plane, this.fillMaterial(wr));
        this.fills.add(wr.fill);
        this.regions.push(wr);
      }
      // Text glyphs are selectable/extrudable profiles too, but they skip line/arc
      // region detection — build them from the cached glyph tessellation instead.
      for (const wr of this.glyphWorldRegions(ents, plane, f.id)) {
        wr.fill = fillMesh(wr.region, plane, this.fillMaterial(wr));
        this.fills.add(wr.fill);
        this.regions.push(wr);
      }
    }
  }

  /** Selectable regions for each non-construction text entity's glyph faces,
   *  sourced from the client-side tessellation cache (empty until glyphs warm —
   *  the async cache fill triggers a repaint, so they appear a frame later). */
  private glyphWorldRegions(
    ents: ResolvedEntity[],
    plane: SketchPlane,
    sketchId: string,
  ): WorldRegion[] {
    const out: WorldRegion[] = [];
    for (const e of ents) {
      if (e.type !== "text" || e.construction) continue;
      const faces = getCachedText(e);
      if (!faces) continue;
      for (const face of faces) {
        const region = glyphRegion(sketchId, face.outer, face.holes);
        out.push({
          sketchId,
          region,
          plane,
          centroid3D: plane.to3D(region.centroid.x, region.centroid.y),
          interior3D: plane.to3D(region.interior.x, region.interior.y),
          groupId: `${sketchId}:${e.id}`, // all glyphs of one text select/extrude together
          entityId: e.id,
        });
      }
    }
    return out;
  }

  /** Profile fills for the active sketch being edited (which `update()` hides).
   *  Sketch mode calls this so areas are visible + selectable while drawing.
   *  `textEnts` (the resolved entity list) lets glyph faces become fills/regions
   *  too — text skips `detectRegions`, so it's threaded in separately. */
  setActiveRegions(
    regions: Region[],
    plane: SketchPlane,
    sketchId = "__active__",
    textEnts: ResolvedEntity[] = [],
  ) {
    this.clearGroup(this.activeFills);
    this.activeRegions = [];
    const withGlyphs: WorldRegion[] = [
      ...regions.map((region) => ({
        sketchId,
        region,
        plane,
        centroid3D: plane.to3D(region.centroid.x, region.centroid.y),
        interior3D: plane.to3D(region.interior.x, region.interior.y),
      })),
      ...this.glyphWorldRegions(textEnts, plane, sketchId),
    ];
    for (const wr of withGlyphs) {
      wr.fill = fillMesh(wr.region, plane, this.fillMaterial(wr));
      this.activeFills.add(wr.fill);
      this.activeRegions.push(wr);
    }
  }

  private fillMaterial(wr: WorldRegion): THREE.MeshBasicMaterial {
    if (this.isRegionSelected(wr)) return FILL_SELECTED_MAT;
    if (this.isHovered(wr)) return FILL_HOVER_MAT;
    return FILL_MAT;
  }
  /** A region is hover-lit if the cursor is on it — or on any sibling in its group
   *  (so hovering one glyph highlights the whole text it belongs to). */
  private isHovered(wr: WorldRegion): boolean {
    const h = this.hovered;
    if (!h) return false;
    return h === wr || (h.groupId !== undefined && h.groupId === wr.groupId);
  }
  /** All regions selected/hovered as a unit with `wr` (its whole text), or just
   *  `wr` when it has no group. */
  private regionGroup(wr: WorldRegion): WorldRegion[] {
    if (wr.groupId === undefined) return [wr];
    return [...this.regions, ...this.activeRegions].filter((r) => r.groupId === wr.groupId);
  }

  // --- region (area) selection: shared by the sketch and the extrude tool ---
  /** committed regions whose material is selected (what the extrude tool consumes) */
  selectedRegions(): WorldRegion[] {
    return this.regions.filter((wr) => this.isRegionSelected(wr));
  }
  // A stored 3D anchor counts for a region only if it lies ON that region's plane
  // AND inside its material — see worldPointInRegion for why the coplanarity gate
  // is essential (parallel-sketch projection bug, loft workflow).
  private pointHitsRegion(p: [number, number, number], wr: WorldRegion): boolean {
    return worldPointInRegion(new THREE.Vector3(p[0], p[1], p[2]), wr.plane, wr.region);
  }
  isRegionSelected(wr: WorldRegion): boolean {
    return this.selectedRegionPoints.some((p) => this.pointHitsRegion(p, wr));
  }
  /** Toggle a region's selection. `additive` (Ctrl/Shift) keeps the rest; a plain
   *  click replaces the whole selection with just this region. A grouped region (a
   *  text's glyphs) toggles as one unit — all its glyph anchors move together. */
  toggleRegionSelection(wr: WorldRegion, additive: boolean) {
    const group = this.regionGroup(wr);
    const pts = group.map(
      (r) => [r.interior3D.x, r.interior3D.y, r.interior3D.z] as [number, number, number],
    );
    const inGroup = (p: [number, number, number]) =>
      group.some((r) => this.pointHitsRegion(p, r));
    const sel = this.isRegionSelected(wr);
    if (!additive) {
      // plain click: this group becomes the whole selection — unless it already WAS
      // the whole selection, in which case a second click clears it.
      const soleSelection = sel && this.selectedRegionPoints.every(inGroup);
      this.selectedRegionPoints = soleSelection ? [] : pts;
    } else if (sel) {
      this.selectedRegionPoints = this.selectedRegionPoints.filter((p) => !inGroup(p));
    } else {
      this.selectedRegionPoints.push(...pts);
    }
    this.recolorFills();
  }
  clearRegionSelection() {
    if (!this.selectedRegionPoints.length) return;
    this.selectedRegionPoints = [];
    this.recolorFills();
  }
  /** Replace the selection with regions containing these world points (the
   *  persisted shape an extrude feature stores) — used when re-opening an
   *  extrude for editing. Points whose region no longer exists simply match
   *  nothing (the containment rule drops them silently). */
  selectRegionsByPoints(points: [number, number, number][]) {
    this.selectedRegionPoints = points.map((p) => [p[0], p[1], p[2]]);
    this.recolorFills();
  }
  /** Replace the selection with the regions those ENTITY references name, falling
   *  back per-reference to the stored point only when the reference carries no
   *  ids. Returns the references it could NOT resolve — the references and not
   *  their indices, because the caller has to keep them, not just count them.
   *
   *  This is what `selectRegionsByPoints` cannot do on its own. Re-opening an
   *  extrude whose sketch has since moved resolves the stored point against the
   *  cells that are there NOW, and on a holed profile the point can be inside the
   *  hole — containment succeeds, so the HOLE's own region comes back selected
   *  and committing writes it over the feature (field 19314fdc, the shell wall
   *  that extrudes as its inner loop; the anchor half of field a20cca53).
   *
   *  A reference that HAS ids and resolves to nothing is left unresolved rather
   *  than falling through to its point: that fall-through is the corrupting
   *  gesture, and it is silent. Resolved references are anchored to the region's
   *  FRESH interior, so committing the edit repairs the stale point on disk. The
   *  CALLER is what makes an unresolved reference safe: ExtrudeTool carries it
   *  through commit untouched, because "this tool could not draw it" is not a
   *  reason to delete an area the model still builds.
   *
   *  Two limits, both inherited and neither closed here. The selection this
   *  writes is still POINTS (`selectRegionsByPoints`), and `selectedRegions`
   *  re-resolves those against every sketch, so a second sketch on the SAME
   *  plane whose region covers the anchor is selected alongside. Fixing that
   *  means making the overlay's whole selection identity-based rather than
   *  point-based, which is a much wider change than this one. And a stale point
   *  is only fenced in as far as the ids fence it: a reference to an OUTER loop
   *  can no longer land in that profile's hole (the hole's cell does not carry
   *  the outer id), but a reference saved on the hole's own cell can still choose
   *  the wrong piece among cells that all carry its id. */
  selectRegionsByEntities(sketchId: string, refs: RegionRef[]): RegionRef[] {
    const inSketch = this.regions.filter((wr) => wr.sketchId === sketchId);
    const shapes = inSketch.map((wr) => wr.region);
    const points: [number, number, number][] = [];
    const unresolved: RegionRef[] = [];
    for (const ref of refs) {
      if (!ref.entityIds.length) {
        // no provenance recorded (pre-0.1.123 document, or a cell whose loop the
        // tracer deduped away): the point is all there is, exactly as before.
        if (ref.point) points.push(ref.point);
        else unresolved.push(ref);
        continue;
      }
      const named = new Set(regionsByEntities(shapes, ref.entityIds, ref.holeEntityIds));
      // `shapes` is `inSketch`'s own Region objects, so identity maps them back
      let hits = inSketch.filter((wr) => named.has(wr.region));
      if (hits.length > 1 && ref.point) {
        // the ids cannot tell these cells apart: two halves of a split square
        // carry the same set, the glyphs of one text all carry the text's id,
        // and a reference matched by containment names several pieces of what it
        // used to be. The stored point breaks the tie among cells the ids
        // already permit, which is narrower than resolving it against the whole
        // sketch and is the only thing that keeps it out of a hole.
        const p = ref.point;
        const narrowed = hits.filter((wr) => this.pointHitsRegion(p, wr));
        if (narrowed.length) hits = narrowed;
      }
      const hit = hits.length === 1 ? hits[0] : undefined;
      if (hit) points.push([hit.interior3D.x, hit.interior3D.y, hit.interior3D.z]);
      else unresolved.push(ref);
    }
    this.selectRegionsByPoints(points);
    return unresolved;
  }
  /** Hover-highlight one region's fill (or clear with null). */
  setHoverRegion(wr: WorldRegion | null) {
    if (this.hovered === wr) return;
    this.hovered = wr;
    this.recolorFills();
  }
  /** active-sketch region whose material contains the 2D sketch point (sketch mode) */
  activeRegionAt(p: THREE.Vector2): WorldRegion | null {
    for (const wr of this.activeRegions) {
      if (pointInRegion(p, wr.region)) return wr;
    }
    return null;
  }
  /** The text entity id whose glyph group's bounding box contains `p` — a GENEROUS
   *  hit (the whole text block, not just glyph ink) so double-click-to-edit lands
   *  even in the gaps between letters. Smallest text wins when several overlap.
   *  `p` is a 2D sketch-plane point; returns null when no text is under it. */
  activeTextIdAt(p: THREE.Vector2): string | null {
    type B = { id: string; minx: number; miny: number; maxx: number; maxy: number };
    const bounds = new Map<string, B>();
    for (const wr of this.activeRegions) {
      if (!wr.groupId || wr.entityId === undefined) continue; // only glyph regions
      let b = bounds.get(wr.groupId);
      if (!b) { b = { id: wr.entityId, minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity }; bounds.set(wr.groupId, b); }
      for (const pt of wr.region.loop) {
        b.minx = Math.min(b.minx, pt.x); b.miny = Math.min(b.miny, pt.y);
        b.maxx = Math.max(b.maxx, pt.x); b.maxy = Math.max(b.maxy, pt.y);
      }
    }
    let best: string | null = null;
    let bestArea = Infinity;
    for (const b of bounds.values()) {
      if (p.x < b.minx || p.x > b.maxx || p.y < b.miny || p.y > b.maxy) continue;
      const area = (b.maxx - b.minx) * (b.maxy - b.miny);
      if (area < bestArea) { bestArea = area; best = b.id; }
    }
    return best;
  }
  /** Front-most COMMITTED region whose material the cursor ray hits — lets a visible
   *  sketch's profile areas be selected directly in the model view (not just inside
   *  the extrude tool). Only visible sketches contribute regions (see update()), so
   *  this is inert when every sketch is hidden/consumed. */
  committedRegionAtRay(ray: THREE.Ray): WorldRegion | null {
    const hit = new THREE.Vector3();
    let best: WorldRegion | null = null;
    let bestDist = Infinity;
    for (const wr of this.regions) {
      if (!ray.intersectPlane(wr.plane.plane, hit)) continue;
      if (!pointInRegion(wr.plane.to2D(hit), wr.region)) continue;
      const d = ray.origin.distanceToSquared(hit);
      if (d < bestDist) {
        bestDist = d;
        best = wr;
      }
    }
    return best;
  }
  private recolorFills() {
    for (const wr of [...this.regions, ...this.activeRegions]) {
      if (wr.fill) wr.fill.material = this.fillMaterial(wr);
    }
  }

  /** The committed sketch curve nearest the cursor, within `maxPx` SCREEN pixels
   *  (the Project tool's sketch-curve pick). Walks the committed curve objects —
   *  tagged with {sketchId, entityId} in update()/curveObjects — and measures
   *  screen-space distance to each polyline segment via `project` (the
   *  viewport's world→client projection). The active sketch's own curves are
   *  never here (update() hides them), and only VISIBLE sketches are pickable. */
  committedCurveAt(
    clientX: number,
    clientY: number,
    project: (world: THREE.Vector3) => { x: number; y: number },
    maxPx = 9,
  ): { sketchId: string; entityId: string } | null {
    let best: { sketchId: string; entityId: string } | null = null;
    let bestD = maxPx;
    const w = new THREE.Vector3();
    for (const obj of this.committed.children) {
      const tag = obj.userData as { sketchId?: string; entityId?: string };
      if (!tag.sketchId || !tag.entityId) continue;
      obj.traverse((o) => {
        if (!(o as THREE.Line).isLine) return;
        const pos = (o as THREE.Line).geometry.getAttribute("position");
        if (!pos) return;
        const paired = (o as THREE.LineSegments).isLineSegments === true;
        let prev: { x: number; y: number } | null = null;
        for (let i = 0; i < pos.count; i++) {
          // geometry points are world coordinates (plane.to3D baked in)
          const s = project(w.fromBufferAttribute(pos, i));
          if (prev) {
            const d = distToSeg(prev, s, { x: clientX, y: clientY });
            if (d < bestD) {
              bestD = d;
              best = { sketchId: tag.sketchId!, entityId: tag.entityId! };
            }
          }
          prev = paired && i % 2 === 1 ? null : s;
        }
      });
    }
    return best;
  }

  /** The active sketch's committed curves (rebuilt only when entities change). */
  setActiveSketch(objects: THREE.Object3D[]) {
    this.clearGroup(this.activeSketch);
    for (const o of objects) this.activeSketch.add(o);
  }

  /** The in-progress rubber-band entity (rebuilt every pointer move). */
  setPreview(objects: THREE.Object3D[]) {
    this.clearGroup(this.previewGroup);
    for (const o of objects) this.previewGroup.add(o);
  }

  setSnap(world: THREE.Vector3 | null, _kind: SnapKind = "free", camera?: THREE.Camera) {
    if (!world) {
      this.snapMarker.visible = false;
      return;
    }
    this.snapMarker.visible = true;
    this.snapMarker.position.copy(world);
    if (camera) this.snapMarker.quaternion.copy(camera.quaternion); // face camera
  }

  setSnapScale(s: number) {
    this.snapMarker.scale.setScalar(s);
  }

  /** Show the endpoint a constraint flow is holding, or clear it with null. */
  setPendingPoint(world: THREE.Vector3 | null, camera?: THREE.Camera) {
    if (!world) {
      this.pendingMarker.visible = false;
      return;
    }
    this.pendingMarker.visible = true;
    this.pendingMarker.position.copy(world);
    if (camera) this.pendingMarker.quaternion.copy(camera.quaternion); // face camera
  }

  setPendingPointScale(s: number) {
    this.pendingMarker.scale.setScalar(s);
  }

  /** Show/hide the translucent profile region fills (Sketch Palette toggle). */
  setFillsVisible(on: boolean) {
    this.fills.visible = on;
  }

  /** geometry is per-object (dispose); materials are module-shared (keep). */
  private clearGroup(g: THREE.Group) {
    for (const c of [...g.children]) {
      g.remove(c);
      (c as any).geometry?.dispose?.();
    }
  }
}

export function curveObjects(
  ents: ReturnType<typeof resolveEntities>,
  plane: SketchPlane,
  color: number,
  highlight = false, // emphasis pass (selection / modify hover): color wins even on projected
  endpointR = 0, // >0 draws a dot at every addressable endpoint (see endpointDot)
): THREE.Object3D[] {
  warmText(ents); // fetch glyph outlines for any text entities; repaints when they land
  const out: THREE.Object3D[] = [];
  for (const e of ents) {
    // every emitted object carries its entity id (committed-curve picking for
    // the Project tool; SketchOverlay.update adds the sketch id on top)
    const add = (o: THREE.Object3D) => {
      o.userData.entityId = e.id;
      out.push(o);
    };
    if (e.type === "point") {
      add(pointMarker(plane, e.x, e.y, e.construction ? 0xffa64d : color));
      continue;
    }
    if (e.type === "text") {
      const faces = getCachedText(e);
      if (faces && faces.length) add(textObjects(faces, plane, color, !!e.construction));
      continue;
    }
    if (endpointR > 0 && !highlight) {
      // the same points pickEndpoint addresses, so what you see is what you can hit
      if (e.type === "line" || e.type === "arc") {
        add(endpointDot(plane, e.x1, e.y1, ENDPOINT_COLOR, endpointR));
        add(endpointDot(plane, e.x2, e.y2, ENDPOINT_COLOR, endpointR));
      } else if (e.type === "spline" && e.points.length) {
        const a = e.points[0], b = e.points[e.points.length - 1];
        if (a) add(endpointDot(plane, a.x, a.y, ENDPOINT_COLOR, endpointR));
        if (b) add(endpointDot(plane, b.x, b.y, ENDPOINT_COLOR, endpointR));
      }
    }
    const pts = entityPolyline(e).map((p) => plane.to3D(p.x, p.y));
    // projected geometry keeps its link color (purple; amber when stale) even
    // as construction — the link state is the more important signal. Emphasis
    // passes (selection, modify hover) set `highlight` so their color wins:
    // Delete works on projected entities, so selection must be visible.
    const projected = e.type === "projected" ? e : null;
    const drawColor =
      projected && !highlight
        ? projected.stale === true ? PROJECTED_STALE_COLOR : PROJECTED_COLOR
        : color;
    const curve =
      !projected && e.construction ? constructionLine(pts) : polyline(pts, drawColor);
    // Circles/arcs (native or projected) get a visible center "+": the center is
    // a snap target and the dimension tool's position handle — invisible, nobody
    // finds it. Grouped so the one-object-per-entity contract holds. asRound is
    // the one center rule (incl. circumcenter for projected arcs).
    const center = asRound(e);
    if (center) {
      const g = new THREE.Group();
      const markerColor = projected ? drawColor : e.construction ? 0xffa64d : color;
      g.add(curve, pointMarker(plane, center.x, center.y, markerColor));
      g.renderOrder = 12;
      add(g);
    } else {
      add(curve);
    }
  }
  return out;
}

/** One THREE.Group for a text entity: an outline THREE.Line per glyph contour plus a
 *  filled glyph mesh (skipped for construction text). Kept to ONE object per entity so
 *  curveObjects' one-object-per-entity contract (see sketchMode preview) holds. */
function textObjects(
  faces: TextFace[],
  plane: SketchPlane,
  color: number,
  construction: boolean,
): THREE.Group {
  const g = new THREE.Group();
  for (const f of faces) {
    for (const loop of [f.outer, ...f.holes]) {
      const pts = loop.map(([x, y]) => plane.to3D(x, y));
      g.add(construction ? constructionLine(pts) : polyline(pts, color));
    }
    // The solid glyph fill is drawn by the region layer (fillMesh) so it can show
    // hover/selection state and be picked for extrude — see glyphWorldRegions.
  }
  g.renderOrder = 12;
  return g;
}

/** a small "+" glyph (two short crossed segments) marking a sketch point.
 *  Built in PLANE coordinates — world-axis offsets would push strokes out of
 *  the plane on XZ/YZ sketches (edge-on, half the cross vanished). */
/** Small square dot at an addressable endpoint.
 *
 *  Endpoints were drawn nowhere: only standalone POINT entities got a marker, so
 *  the ends of a line were invisible until you happened to hover them. That is
 *  most of why Coincident felt broken — its targets are endpoints, and you could
 *  not see where they were (GitHub #17; confirmed in the app 2026-08-15).
 *
 *  Sized by the caller in world units derived from screen pixels, so it stays a
 *  dot rather than growing into a blob when you zoom in. */
function endpointDot(plane: SketchPlane, x: number, y: number, color: number, r: number): THREE.Object3D {
  const pts = [
    plane.to3D(x - r, y - r), plane.to3D(x + r, y - r),
    plane.to3D(x + r, y + r), plane.to3D(x - r, y + r),
    plane.to3D(x - r, y - r),
  ];
  const seg = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(color));
  seg.renderOrder = 14; // above the curves themselves
  return seg;
}

function pointMarker(plane: SketchPlane, x: number, y: number, color: number): THREE.Object3D {
  const s = 0.9;
  const pts = [
    plane.to3D(x - s, y), plane.to3D(x + s, y),
    plane.to3D(x, y - s), plane.to3D(x, y + s),
  ];
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const seg = new THREE.LineSegments(g, lineMat(color));
  seg.renderOrder = 13;
  return seg;
}

export function polyline(points: THREE.Vector3[], color: number): THREE.Line {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(g, lineMat(color));
  line.renderOrder = 12;
  return line;
}

/** MCAD-style dimension annotations (extension lines + dim line + arrowheads)
 *  for a set of entities, batched into one LineSegments object. */
export function dimensionLineObjects(
  ents: ReturnType<typeof resolveEntities>,
  plane: SketchPlane,
  extraSegs: [THREE.Vector2, THREE.Vector2][] = [],
  color: number = DIM_COLOR,
): THREE.Object3D[] {
  const segs = [...dimensionSegments(ents), ...extraSegs];
  if (!segs.length) return [];
  const pts: THREE.Vector3[] = [];
  for (const [a, b] of segs) pts.push(plane.to3D(a.x, a.y), plane.to3D(b.x, b.y));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.LineSegments(g, lineMat(color));
  line.renderOrder = 11;
  return [line];
}

function constructionLine(points: THREE.Vector3[]): THREE.Line {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(g, CONSTRUCTION_MAT);
  line.computeLineDistances(); // required for dashing
  line.renderOrder = 12;
  return line;
}

function fillMesh(region: Region, plane: SketchPlane, material: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape(region.loop.map((p) => p.clone()));
  for (const h of region.holes) {
    shape.holes.push(new THREE.Path(h.map((p) => p.clone())));
  }
  const geo = new THREE.ShapeGeometry(shape);
  geo.applyMatrix4(plane.basisMatrix()); // ShapeGeometry is local XY -> plane
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = 11;
  return mesh;
}
