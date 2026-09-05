// Renders sketches in 3D: committed sketch curves (always visible, like mainstream MCAD),
// translucent profile region fills, the active sketch being drawn, the
// in-progress preview entity, and the snap glyph. Region metadata is exposed so
// the extrude tool can hit-test and preview.
//
// Materials are module-shared (one per color) so the per-pointer-move redraw
// allocates only geometry, never materials; clearGroup therefore disposes
// geometry only and leaves the shared materials intact.

import * as THREE from "three";
import type { CadDocument, PlaneDef, PlaneSpec } from "../types";
import { planeOf } from "../document/planeOf";
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
import { dimensionSegments, asRound, dimRefPoints } from "./entityDims";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { isOriginId, isOriginGeometry } from "./origin";
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
export const ORIGIN_COLOR = 0xffd257; // the fixed sketch origin — a datum, not geometry
export const DIM_COLOR = 0x8fa4bd; // muted blue-gray for dimension annotations
const FILL_COLOR = 0x3a7bd5;

/** Sketch CURVES are drawn as fat lines. GH #17: "Lines are currently too thin
 *  and blend in visually with dimension lines. A thickness of 2-3px would solve
 *  this." A plain THREE.Line cannot do it — WebGL ignores LineBasicMaterial's
 *  `linewidth` in every browser, which is why the old value looked like 1px
 *  whatever it was set to. Line2 is the same technique the 3D model edges
 *  already use (viewport/edgeLines.ts).
 *
 *  Dimension ANNOTATIONS deliberately stay on the thin material: the reporter's
 *  complaint was that geometry and annotation were indistinguishable, so making
 *  both fat would lose the very distinction being asked for. */
const SKETCH_LINE_WIDTH = 2.2;
/** CSS pixels — the space LineMaterial measures `linewidth` in. Kept in step by
 *  the viewport's resize (see setSketchLineResolution); a stale resolution makes
 *  fat lines render at the wrong width or vanish. */
const fatResolution = new THREE.Vector2(1, 1);
const fatMats = new Map<string, LineMaterial>();
function fatMat(color: number, dashed: boolean): LineMaterial {
  const key = `${color}:${dashed}`;
  let m = fatMats.get(key);
  if (!m) {
    m = new LineMaterial({
      color,
      linewidth: SKETCH_LINE_WIDTH,
      depthTest: true,
      dashed,
      ...(dashed ? { dashSize: 1.6, gapSize: 1.0, dashScale: 1 } : {}),
    });
    m.resolution.copy(fatResolution);
    fatMats.set(key, m);
  }
  return m;
}

/** Push the canvas size into every sketch fat-line material. Called from the
 *  viewport's resize beside setEdgeResolution, in CSS pixels for the reason
 *  documented there. */
export function setSketchLineResolution(w: number, h: number) {
  fatResolution.set(w, h);
  for (const m of fatMats.values()) m.resolution.set(w, h);
}

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
const CONSTRUCTION_COLOR = 0xffa64d;
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
  /** The endpoint(s) a constraint flow is holding. A POOL rather than one mesh:
   *  symmetric holds two points before it asks for the axis, and with a single
   *  marker its middle click left no trace at all. Grown on demand and capped —
   *  no flow addresses more points than it can show. */
  private pendingMarkers: THREE.Mesh[] = [];
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

  }

  /** One more held-point disc, added to the scene hidden. A filled disc rather
   *  than the snap ring, so "I have this point" never reads as "you could snap
   *  here": the two can be on screen at once and mean different things. */
  private growPendingMarker(): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 20),
      new THREE.MeshBasicMaterial({ color: 0x35d07f, depthTest: false }),
    );
    m.renderOrder = 31; // above the snap ring
    m.visible = false;
    this.group.add(m);
    this.pendingMarkers.push(m);
    return m;
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

  /** The planes the last rebuild actually USED, for face-anchored sketches (see
   *  document/planeOf). Injected the same way as sketchVisible rather than
   *  passed to update(), because update() has four call sites and only the app
   *  can see the build state. Default = none, i.e. every sketch draws at its own
   *  cached plane, which is what a document with no anchor wants anyway. */
  resolvedPlanes: () => Record<string, PlaneDef> | undefined = () => undefined;

  /** Called whenever a region fill changes colour. The viewport draws ON DEMAND,
   *  and the overlay holds no reference to it, so a selection made from a path
   *  that doesn't otherwise touch the viewport (the model-view area click, Esc,
   *  sketch mode's area click, the extrude tool's toggles) recoloured a mesh
   *  nobody ever drew — the highlight only appeared on the next mouse move,
   *  because pointermove requests a frame unconditionally. Injected the same way
   *  as sketchVisible; the app points it at viewport.requestRender(). */
  onRepaintNeeded: () => void = () => {};

  /** Rebuild committed sketch curves + region fills from the document. */
  update(doc: CadDocument, hiddenSketchId: string | null = null) {
    const resolved = this.resolvedPlanes();
    this.clearGroup(this.committed);
    this.clearGroup(this.fills);
    this.regions = [];

    for (const f of doc.features) {
      if (f.type !== "sketch") continue;
      if (f.id === hiddenSketchId) continue; // active sketch drawn by the editor
      if (!this.sketchVisible(f.id)) continue; // hidden (e.g. consumed by a feature)
      const plane = this.planeFor(planeOf(f, resolved));
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
   *  ids. Returns BOTH halves of the answer: the WorldRegions it resolved, in the
   *  order of the references that named them, and the references it could NOT
   *  resolve — the references and not their indices, because the caller has to
   *  keep them, not just count them.
   *
   *  `resolved` is returned rather than left for the caller to read back out of
   *  `selectedRegions()`, and that is the whole point of it. The selection this
   *  writes is POINTS, and `selectedRegions` re-resolves a point against EVERY
   *  sketch (coplanar within ~1e-3 mm) — so a caller that reads the selection
   *  back has laundered the identity these ids just established and gets a
   *  coplanar NEIGHBOUR sketch's region alongside. ExtrudeTool committed that
   *  neighbour into the feature (route B: an 18000 mm³ wall became 50000 mm³ on
   *  a bare depth change). The overlay's *display* is still point-based, so a
   *  neighbouring region can still light up; what the caller COMMITS is now
   *  these regions, from this sketch.
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
   *  Two limits, both inherited and neither closed here. The overlay's SELECTION
   *  is still points, so what lights up on screen is still whatever contains the
   *  anchor, including a coplanar neighbour's region — only the returned
   *  `resolved` list is identity-clean, and it is that list a caller must write.
   *  And a stale point is only fenced in as far as the ids fence it: a reference
   *  to an OUTER loop can no longer land in that profile's hole (the hole's cell
   *  does not carry the outer id), but a reference saved on the hole's own cell
   *  can still choose the wrong piece among cells that all carry its id. */
  selectRegionsByEntities(
    sketchId: string,
    refs: RegionRef[],
  ): { resolved: WorldRegion[]; unresolved: RegionRef[] } {
    const inSketch = this.regions.filter((wr) => wr.sketchId === sketchId);
    const shapes = inSketch.map((wr) => wr.region);
    const resolved: WorldRegion[] = [];
    const unresolved: RegionRef[] = [];
    for (const ref of refs) {
      let hits: WorldRegion[];
      if (!ref.entityIds.length) {
        // no provenance recorded (pre-0.1.123 document, or a cell whose loop the
        // tracer deduped away): the point is all there is, exactly as before —
        // except that it is resolved against THIS sketch's cells rather than
        // every sketch's, and a point that now lands in none of them counts as
        // unresolved (the caller carries it) instead of vanishing at commit.
        const p = ref.point;
        hits = p ? inSketch.filter((wr) => this.pointHitsRegion(p, wr)) : [];
      } else {
        const named = new Set(regionsByEntities(shapes, ref.entityIds, ref.holeEntityIds));
        // `shapes` is `inSketch`'s own Region objects, so identity maps them back
        hits = inSketch.filter((wr) => named.has(wr.region));
        if (hits.length > 1 && ref.point) {
          // the ids cannot tell these cells apart: two halves of a split square
          // carry the same set, the glyphs of one text all carry the text's id,
          // and a reference matched by containment names several pieces of what it
          // used to be. The stored point breaks the tie among cells the ids
          // already permit, which is narrower than resolving it against the whole
          // sketch and is the only thing that keeps it out of a hole.
          // Unconditionally, because the `if (narrowed.length)` this replaces
          // could not change the outcome: leaving `hits` at length > 1 and
          // setting it to [] both fail the `=== 1` test below and land the
          // reference in `unresolved`. Keeping the guard implied a fallback
          // that was never taken.
          const p = ref.point;
          hits = hits.filter((wr) => this.pointHitsRegion(p, wr));
        }
      }
      // One cell or nothing. Several means the ids name a set of cells and the
      // point is in none of them, so nothing here can tell which one the user
      // extruded; zero means the ids (or the point) name nothing live. Either
      // way, choosing would be a guess written to disk — this refuses, and the
      // caller keeps the reference untouched.
      const hit = hits.length === 1 ? hits[0] : undefined;
      if (hit) resolved.push(hit);
      else unresolved.push(ref);
    }
    // the FRESH interiors, so committing the edit repairs the stale points on disk
    this.selectRegionsByPoints(
      resolved.map((wr) => [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z]),
    );
    return { resolved, unresolved };
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
    // Something on screen just changed colour. Safe to ask for a frame from
    // here: recolorFills is never reached from inside the render loop (only
    // onZoomScale is, and that path never lands here).
    this.onRepaintNeeded();
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
        // Fat sketch curves (Line2) carry their world points on userData: a
        // LineGeometry has no `position` attribute and a Line2 is a Mesh, so the
        // isLine + getAttribute path below cannot see them at all. Reading the
        // stashed points keeps picking independent of the drawing technique.
        const stashed = (o.userData as { pts?: THREE.Vector3[] }).pts;
        const pos = stashed
          ? null
          : (o as THREE.Line).isLine
            ? (o as THREE.Line).geometry.getAttribute("position")
            : null;
        if (!stashed && !pos) return;
        const count = stashed ? stashed.length : pos!.count;
        const paired = !stashed && (o as THREE.LineSegments).isLineSegments === true;
        let prev: { x: number; y: number } | null = null;
        for (let i = 0; i < count; i++) {
          // geometry points are world coordinates (plane.to3D baked in)
          const s = project(stashed ? w.copy(stashed[i]!) : w.fromBufferAttribute(pos!, i));
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
  /** Show every point a constraint flow is holding, or clear them with []. */
  setPendingPoints(worlds: THREE.Vector3[], camera?: THREE.Camera) {
    for (let i = 0; i < Math.max(worlds.length, this.pendingMarkers.length); i++) {
      const w = worlds[i];
      const m = this.pendingMarkers[i] ?? (w ? this.growPendingMarker() : undefined);
      if (!m) continue;
      m.visible = w !== undefined;
      if (w) {
        m.position.copy(w);
        if (camera) m.quaternion.copy(camera.quaternion); // face camera
      }
    }
  }

  setPendingPointScale(s: number) {
    for (const m of this.pendingMarkers) m.scale.setScalar(s);
  }

  /** How many held-point markers are currently on screen. */
  visiblePendingCount(): number {
    return this.pendingMarkers.filter((m) => m.visible).length;
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
      // The ORIGIN reads as a datum, not as a stray point the user left behind.
      // It gets its own colour and is never tinted by selection/DOF state,
      // because it is fixed and none of those states can apply to it. A tester
      // could not find anything to anchor to precisely because there was nothing
      // on screen saying "this is 0,0".
      // `!highlight` matches how projected geometry is drawn: the datum colour
      // is the RESTING look, and an emphasis pass (selection, hover) must still
      // win — the origin is selectable precisely so you can constrain to it, and
      // a selection you cannot see reads as a selection that did not happen.
      add(pointMarker(
        plane,
        e.x,
        e.y,
        isOriginId(e.id) && !highlight ? ORIGIN_COLOR : e.construction ? 0xffa64d : color,
      ));
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
        // EVERY control point, not just the two ends. pickPoint already offers
        // all of them as drag handles, so the interior ones were draggable and
        // INVISIBLE — the exact shape of the rectangle-corner bug below, and of
        // GH #17's "the spline control points are too small ... causing unwanted
        // bumps": you cannot aim carefully at a handle you cannot see, so you
        // grab whichever one the cursor happens to be nearest.
        for (const q of e.points) add(endpointDot(plane, q.x, q.y, ENDPOINT_COLOR, endpointR));
      } else if (e.type === "rectangle") {
        // Corners 0..3, from dimRefPoints — the SAME source pickEndpoint reads,
        // so the two cannot drift about which corners are addressable. Not a
        // blanket switch to dimRefPoints for every type: it also returns an
        // arc's CENTRE as p2, which is a dimension target and not an endpoint.
        //
        // Without this the four corners were pickable and invisible, which is
        // the exact shape of GH #17 — a tool whose targets carry no dot reads
        // as dead, and the corners are the only click targets opening the
        // rectangle affordance added.
        for (const { pos } of dimRefPoints(e)) {
          add(endpointDot(plane, pos.x, pos.y, ENDPOINT_COLOR, endpointR));
        }
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
    // The origin AXES are reference geometry, not the user's construction lines,
    // and they must not read as something you drew and forgot. Same colour as
    // the origin point, so the three together read as one datum.
    const curve = isOriginGeometry(e.id) && !highlight
      ? polyline(pts, ORIGIN_COLOR)
      : !projected && e.construction
        ? constructionLine(pts)
        : polyline(pts, drawColor);
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

/** A point highlight at plane coords, for the hover pass. Exported so the hover
 *  draws the SAME square the resting dots do, only bigger and in another colour:
 *  a differently-shaped marker would read as a different kind of thing rather
 *  than as "this one, the one you are pointing at". */
export function pointHighlight(
  plane: SketchPlane,
  x: number,
  y: number,
  color: number,
  r: number,
): THREE.Object3D {
  const o = endpointDot(plane, x, y, color, r);
  o.renderOrder = 15; // above the resting dots it sits on top of
  return o;
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

export function polyline(points: THREE.Vector3[], color: number): THREE.Object3D {
  return fatLine(points, color, false);
}

/** A dashed polyline — the marquee's CROSSING box, and anything else that needs
 *  to read as "provisional" rather than as drawn geometry. */
export function dashedPolyline(points: THREE.Vector3[], color: number): THREE.Object3D {
  return fatLine(points, color, true);
}

/** A sketch curve as a fat line.
 *
 *  The world points are stashed on `userData.pts` because LineGeometry does NOT
 *  expose a `position` attribute — it packs instanceStart/instanceEnd — and a
 *  Line2 is a Mesh, so `isLine` is false. Every picker that walked the geometry
 *  would have silently stopped finding sketch curves. Carrying the points makes
 *  picking independent of how the line happens to be drawn, which is sturdier
 *  than teaching each picker a second geometry layout. */
function fatLine(points: THREE.Vector3[], color: number, dashed: boolean): THREE.Object3D {
  const g = new LineGeometry();
  const flat: number[] = [];
  for (const p of points) flat.push(p.x, p.y, p.z);
  g.setPositions(flat);
  const line = new Line2(g, fatMat(color, dashed));
  if (dashed) line.computeLineDistances();
  line.renderOrder = 12;
  line.userData.pts = points;
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

function constructionLine(points: THREE.Vector3[]): THREE.Object3D {
  const line = fatLine(points, CONSTRUCTION_COLOR, true);
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
