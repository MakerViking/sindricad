// Turn a RebuildResult into Three.js objects: a shaded mesh (with per-triangle
// faceIds for picking) plus crisp fat edge lines. Because we full-rebuild on
// every change, we dispose the previous objects every time to avoid GPU leaks.

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { RebuildResult } from "../types";
import { disposeObject } from "./dispose";

export interface ModelView {
  mesh: THREE.Mesh;
  faceIds: number[]; // one B-rep face id per triangle (index = faceIndex)
  edges: Line2[]; // each carries userData.edgeId + points
  box: THREE.Box3;
  // per-body faceId ranges (for faceId→body lookup + whole-body highlight)
  bodies: { id: string; name: string; faceStart: number; faceCount: number }[];
  // per-vertex base colors the highlighter restores to (component / draft analysis
  // overwrite this; default = BASE_COLOR everywhere). Separate from the live color
  // attribute, which hover/selection mutate on top.
  baseColors: Float32Array;
}

// Base albedo is baked into vertex colors (material.color stays white) so
// highlight.ts can recolor a single face's vertices without touching lighting.
export const BASE_COLOR = new THREE.Color(0x9aa7b4);

const EDGE_MATERIAL = () =>
  new LineMaterial({
    color: 0x1b1f24,
    linewidth: 1.6, // screen-space px; keep .resolution synced on resize
    worldUnits: false,
    depthTest: true,
  });

export function buildModel(
  result: RebuildResult,
  resolution: THREE.Vector2,
  hiddenBodies: string[] = [],
): ModelView {
  const { positions } = result.mesh;
  let { indices, faceIds } = result.mesh;
  const hidden = new Set(hiddenBodies);

  // Per-body visibility: drop triangles whose B-rep faceId falls in a hidden
  // body's [faceStart, faceStart+faceCount) range. We filter the index buffer +
  // the per-triangle faceIds together (positions stay whole — unreferenced verts
  // are harmless), so faceId↔vertex math in viewport.ts stays valid.
  if (hidden.size) {
    const ranges = (result.bodies ?? [])
      .filter((b) => hidden.has(b.id))
      .map((b) => ({ start: b.faceStart, end: b.faceStart + b.faceCount }));
    const isHidden = (fid: number) => ranges.some((r) => fid >= r.start && fid < r.end);
    const keptIdx: number[] = [];
    const keptFaceIds: number[] = [];
    for (let t = 0; t < faceIds.length; t++) {
      if (isHidden(faceIds[t])) continue;
      keptIdx.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
      keptFaceIds.push(faceIds[t]);
    }
    indices = keptIdx;
    faceIds = keptFaceIds;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geo.setIndex(indices);
  geo.computeVertexNormals();

  // per-vertex color baked to the base albedo; highlight recolors a face's
  // vertices without disturbing lighting (material.color is white).
  const vcount = positions.length / 3;
  const colors = new Float32Array(vcount * 3);
  for (let i = 0; i < vcount; i++) {
    colors[i * 3] = BASE_COLOR.r;
    colors[i * 3 + 1] = BASE_COLOR.g;
    colors[i * 3 + 2] = BASE_COLOR.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0.1,
    roughness: 0.55,
    flatShading: false,
    // push faces back so edge lines stay crisp on top (no z-fighting)
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "model";

  // edges as individual fat lines so picking can identify each one (skip the
  // edges of hidden bodies so a hidden body leaves no floating wireframe).
  const edges: Line2[] = [];
  for (const e of result.edges) {
    if (e.body && hidden.has(e.body)) continue;
    const flat: number[] = [];
    for (const p of e.points) flat.push(p[0], p[1], p[2]);
    const lgeo = new LineGeometry();
    lgeo.setPositions(flat);
    const lmat = EDGE_MATERIAL();
    lmat.resolution.copy(resolution);
    const line = new Line2(lgeo, lmat);
    line.computeLineDistances();
    line.name = "edge";
    line.userData.edgeId = e.id;
    line.userData.points = e.points;
    line.userData.body = e.body;
    edges.push(line);
  }

  const box = new THREE.Box3(
    new THREE.Vector3(...result.bbox.min),
    new THREE.Vector3(...result.bbox.max),
  );

  return { mesh, faceIds, edges, box, bodies: result.bodies ?? [], baseColors: colors.slice() };
}

export function disposeModel(view: ModelView | null) {
  if (!view) return;
  disposeObject(view.mesh);
  for (const e of view.edges) disposeObject(e);
}

export function setEdgeResolution(view: ModelView | null, res: THREE.Vector2) {
  if (!view) return;
  for (const e of view.edges) (e.material as LineMaterial).resolution.copy(res);
}
