// Renders sketches in 3D: committed sketch curves (always visible, like Fusion),
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
  pointInRegion,
  type Region,
} from "./region";
import { dimensionSegments } from "./entityDims";
import type { SnapKind } from "./snap";

export interface WorldRegion {
  sketchId: string;
  region: Region;
  plane: SketchPlane;
  centroid3D: THREE.Vector3;
  interior3D: THREE.Vector3; // a point inside the material — selection anchor
  fill?: THREE.Mesh; // the fill mesh, for hover/selection recoloring
}

export const CURVE_COLOR = 0x5b9bff; // under-constrained blue
export const PREVIEW_COLOR = 0xffffff;
export const SELECT_COLOR = 0xff9d3b; // selected sketch entity (orange)
export const DIM_COLOR = 0x8fa4bd; // muted blue-gray for dimension annotations
const FILL_COLOR = 0x3a7bd5;

const lineMats = new Map<number, THREE.LineBasicMaterial>();
function lineMat(color: number): THREE.LineBasicMaterial {
  let m = lineMats.get(color);
  if (!m) {
    m = new THREE.LineBasicMaterial({ color, depthTest: false });
    lineMats.set(color, m);
  }
  return m;
}
// construction geometry: dashed orange (referenceable, not a profile)
const CONSTRUCTION_MAT = new THREE.LineDashedMaterial({
  color: 0xffa64d,
  dashSize: 1.6,
  gapSize: 1.0,
  depthTest: false,
});
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

export class SketchOverlay {
  readonly group = new THREE.Group();
  private committed = new THREE.Group();
  private fills = new THREE.Group();
  private activeFills = new THREE.Group(); // profile fills for the active (hidden) sketch
  private activeSketch = new THREE.Group(); // active sketch's committed curves
  private previewGroup = new THREE.Group(); // the rubber-band, rebuilt per move
  private snapMarker: THREE.Mesh;
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
      new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false }),
    );
    this.snapMarker.renderOrder = 30;
    this.snapMarker.visible = false;
    this.group.add(this.snapMarker);
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
   *  sketches consumed by a feature hide by default (Fusion-style), keeping the
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
    }
  }

  /** Profile fills for the active sketch being edited (which `update()` hides).
   *  Sketch mode calls this so areas are visible + selectable while drawing. */
  setActiveRegions(regions: Region[], plane: SketchPlane, sketchId = "__active__") {
    this.clearGroup(this.activeFills);
    this.activeRegions = [];
    for (const region of regions) {
      const wr: WorldRegion = {
        sketchId,
        region,
        plane,
        centroid3D: plane.to3D(region.centroid.x, region.centroid.y),
        interior3D: plane.to3D(region.interior.x, region.interior.y),
      };
      wr.fill = fillMesh(region, plane, this.fillMaterial(wr));
      this.activeFills.add(wr.fill);
      this.activeRegions.push(wr);
    }
  }

  private fillMaterial(wr: WorldRegion): THREE.MeshBasicMaterial {
    if (this.isRegionSelected(wr)) return FILL_SELECTED_MAT;
    if (this.hovered === wr) return FILL_HOVER_MAT;
    return FILL_MAT;
  }

  // --- region (area) selection: shared by the sketch and the extrude tool ---
  /** committed regions whose material is selected (what the extrude tool consumes) */
  selectedRegions(): WorldRegion[] {
    return this.regions.filter((wr) => this.isRegionSelected(wr));
  }
  isRegionSelected(wr: WorldRegion): boolean {
    return this.selectedRegionPoints.some((p) =>
      pointInRegion(wr.plane.to2D(new THREE.Vector3(p[0], p[1], p[2])), wr.region),
    );
  }
  /** Toggle a region's selection. `additive` (Ctrl/Shift) keeps the rest; a plain
   *  click replaces the whole selection with just this region. */
  toggleRegionSelection(wr: WorldRegion, additive: boolean) {
    const sel = this.isRegionSelected(wr);
    const c = wr.interior3D;
    if (!additive) {
      this.selectedRegionPoints = sel && this.selectedRegionPoints.length === 1 ? [] : [[c.x, c.y, c.z]];
    } else if (sel) {
      this.selectedRegionPoints = this.selectedRegionPoints.filter(
        (p) => !pointInRegion(wr.plane.to2D(new THREE.Vector3(p[0], p[1], p[2])), wr.region),
      );
    } else {
      this.selectedRegionPoints.push([c.x, c.y, c.z]);
    }
    this.recolorFills();
  }
  clearRegionSelection() {
    if (!this.selectedRegionPoints.length) return;
    this.selectedRegionPoints = [];
    this.recolorFills();
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
  private recolorFills() {
    for (const wr of [...this.regions, ...this.activeRegions]) {
      if (wr.fill) wr.fill.material = this.fillMaterial(wr);
    }
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
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const e of ents) {
    const pts = entityPolyline(e).map((p) => plane.to3D(p.x, p.y));
    out.push(e.construction ? constructionLine(pts) : polyline(pts, color));
  }
  return out;
}

export function polyline(points: THREE.Vector3[], color: number): THREE.Line {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(g, lineMat(color));
  line.renderOrder = 12;
  return line;
}

/** Fusion-style dimension annotations (extension lines + dim line + arrowheads)
 *  for a set of entities, batched into one LineSegments object. */
export function dimensionLineObjects(
  ents: ReturnType<typeof resolveEntities>,
  plane: SketchPlane,
): THREE.Object3D[] {
  const segs = dimensionSegments(ents);
  if (!segs.length) return [];
  const pts: THREE.Vector3[] = [];
  for (const [a, b] of segs) pts.push(plane.to3D(a.x, a.y), plane.to3D(b.x, b.y));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.LineSegments(g, lineMat(DIM_COLOR));
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
