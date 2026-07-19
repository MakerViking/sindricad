// Turn a RebuildResult into Three.js objects: one shaded Mesh+BufferGeometry PER
// BODY (with per-triangle faceIds for picking) plus crisp fat edge lines. Bodies
// are keyed by id so an unchanged body (same wire-protocol etag) can reuse its
// previous GPU objects untouched instead of rebuilding — see Viewport.setModel().

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { RebuildResult } from "../types";
import { disposeObject } from "./dispose";

/** One body's own isolated Mesh + edges. `faceStart`/`faceCount` are the body's
 *  B-rep faceId sub-range (global, per the wire protocol) — `faceIds` below are
 *  NOT remapped, so a faceId is always globally meaningful even though the
 *  triangle/vertex indices that carry it are local to this body's own buffers.
 *  `etag` is the sidecar's content fingerprint as of this build (undefined if
 *  the reply didn't carry one) — Viewport.setModel() diffs on it to decide
 *  whether a body needs rebuilding at all. */
export interface BodyMesh {
  id: string;
  name: string;
  faceStart: number;
  faceCount: number;
  etag?: string | undefined;
  mesh: THREE.Mesh;
  faceIds: number[]; // one B-rep faceId per triangle, index = local faceIndex
  edges: Line2[];
  // per-vertex base colors (this body's own buffer) the highlighter restores to
  // (component/draft analysis overwrite this; default = BASE_COLOR everywhere).
  baseColors: Float32Array;
  // B-rep faceId -> LOCAL triangle indices (into this body's own index buffer),
  // precomputed once so highlight.ts/viewport.ts can touch just one face's/body's
  // own triangles without scanning the whole body on each hover/select/measure.
  faceTriangles: Map<number, number[]>;
}

export interface ModelView {
  bodies: BodyMesh[];
  // ALL edges, flattened (every body's + orphans below) — the flat list existing
  // consumers (overlays.ts's curvature combs, setEdgeResolution, emphasizeEdges,
  // setClipPlane, setModelDimmed, hideFlushSeams) already expect.
  edges: Line2[];
  // Edges whose `body` doesn't name a live body id. The current sidecar/Rust
  // backend always tags every edge with its owning body, so in practice this is
  // always empty — kept as a defensive fallback (rebuilt fresh every setModel()
  // call, always visible, never moved with a body) so a body-less edge can't
  // silently vanish if that invariant ever lapses.
  orphanEdges: Line2[];
  box: THREE.Box3;
}

// Base albedo is baked into vertex colors (material.color stays white) so
// highlight.ts can recolor a single face's vertices without touching lighting.
export const BASE_COLOR = new THREE.Color(0x9aa7b4);

const EDGE_IDLE_COLOR = 0x1b1f24;
const EDGE_IDLE_WIDTH = 1.6;
const EDGE_MATERIAL = () =>
  new LineMaterial({
    color: EDGE_IDLE_COLOR,
    linewidth: EDGE_IDLE_WIDTH, // screen-space px; keep .resolution synced on resize
    worldUnits: false,
    depthTest: true,
  });

/** Split a RebuildResult's flat edge list by owning body id (see `orphans` above
 *  for the no-match fallback). `bodyIds` is the set of body ids present in this
 *  reply, so a stale `body` reference (a body that's gone) also falls to orphans. */
export function groupEdgesByBody(
  edges: RebuildResult["edges"],
  bodyIds: Set<string>,
): { byBody: Map<string, RebuildResult["edges"]>; orphans: RebuildResult["edges"] } {
  const byBody = new Map<string, RebuildResult["edges"]>();
  const orphans: RebuildResult["edges"] = [];
  for (const e of edges) {
    if (e.body && bodyIds.has(e.body)) {
      let list = byBody.get(e.body);
      if (!list) byBody.set(e.body, (list = []));
      list.push(e);
    } else {
      orphans.push(e);
    }
  }
  return { byBody, orphans };
}

function buildEdgeLines(edges: RebuildResult["edges"], resolution: THREE.Vector2): Line2[] {
  const out: Line2[] = [];
  for (const e of edges) {
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
    out.push(line);
  }
  return out;
}

/** Build one body's own isolated Mesh+BufferGeometry: slice its triangles out of
 *  the (still shared-array) wire mesh — result.mesh stays one concatenated set
 *  of arrays, per client.ts's assemble() — and remap to a dense local vertex
 *  range, so each body owns independent GPU buffers untouched by any other
 *  body's rebuild. `faceIds` in the slice stay their original (globally-unique)
 *  B-rep ids; only the vertex numbering is body-local. */
export function buildBodyMesh(
  result: RebuildResult,
  meta: { id: string; name: string; faceStart: number; faceCount: number },
  bodyEdges: RebuildResult["edges"],
  resolution: THREE.Vector2,
  etag: string | undefined,
): BodyMesh {
  const { positions, indices, faceIds } = result.mesh;
  const meshNormals = result.mesh.normals;
  const { faceStart, faceCount } = meta;
  const faceEnd = faceStart + faceCount;

  // global vertex index -> local (dense); a flat typed array beats a Map here —
  // this runs per changed body on every live-preview drag tick, and Map<number,
  // number> pays hashing/boxing on 3 lookups per triangle.
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const localPositions: number[] = [];
  const localNormals: number[] = [];
  let anyNormal = false; // an all-zero slice = "sidecar sent none for this body"
  const localIndices: number[] = [];
  const localFaceIds: number[] = [];
  const local = (gi: number): number => {
    let li = remap[gi];
    if (li === undefined) li = -1; // gi is always in range; -1 = "not yet assigned"
    if (li !== -1) return li;
    const base = gi * 3;
    const x = positions[base], y = positions[base + 1], z = positions[base + 2];
    if (x === undefined || y === undefined || z === undefined) return -1; // in range; unreachable
    li = localPositions.length / 3;
    localPositions.push(x, y, z);
    if (meshNormals) {
      const nx = meshNormals[base] ?? 0, ny = meshNormals[base + 1] ?? 0, nz = meshNormals[base + 2] ?? 0;
      localNormals.push(nx, ny, nz);
      if (nx !== 0 || ny !== 0 || nz !== 0) anyNormal = true;
    }
    remap[gi] = li;
    return li;
  };
  for (let t = 0; t < faceIds.length; t++) {
    const fid = faceIds[t];
    if (fid === undefined || fid < faceStart || fid >= faceEnd) continue;
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
    localIndices.push(local(i0), local(i1), local(i2));
    localFaceIds.push(fid);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(localPositions, 3));
  geo.setIndex(localIndices);
  // a textured body ships sidecar-computed normals (analytic on displaced
  // faces — smooth shading at coarse displacement density); everything else
  // keeps the usual client-side accumulation.
  if (anyNormal) geo.setAttribute("normal", new THREE.Float32BufferAttribute(localNormals, 3));
  else geo.computeVertexNormals();

  // per-vertex color baked to the base albedo; highlight recolors a face's
  // vertices without disturbing lighting (material.color is white).
  const vcount = localPositions.length / 3;
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

  const edges = buildEdgeLines(bodyEdges, resolution);

  // one pass over this body's own (already-sliced) triangle list, grouping
  // LOCAL triangle indices by their B-rep faceId.
  const faceTriangles = new Map<number, number[]>();
  for (let t = 0; t < localFaceIds.length; t++) {
    const fid = localFaceIds[t];
    if (fid === undefined) continue;
    let tris = faceTriangles.get(fid);
    if (!tris) faceTriangles.set(fid, (tris = []));
    tris.push(t);
  }

  const body: BodyMesh = {
    id: meta.id,
    name: meta.name,
    faceStart,
    faceCount,
    etag,
    mesh,
    faceIds: localFaceIds,
    edges,
    baseColors: colors.slice(),
    faceTriangles,
  };
  // reverse lookup: a raycast hit's `.object` (the exact mesh hit) back to the
  // BodyMesh that owns it — picking.ts/viewport.ts use this via faceIdOfHit().
  mesh.userData.owner = body;
  return body;
}

/** All body meshes currently visible — the raycast target set for "the solid".
 *  three.js's Raycaster does NOT check `.visible` (only `layers.test()`), so any
 *  raycast against "the model" must filter explicitly; a hidden body is only
 *  `mesh.visible = false` now (not dropped from the geometry at build time). */
export function visibleBodyMeshes(view: ModelView): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const b of view.bodies) if (b.mesh.visible) out.push(b.mesh);
  return out;
}

/** The B-rep faceId a raycast Intersection landed on, resolved via the hit
 *  mesh's own `userData.owner` (set in buildBodyMesh) — `hit.faceIndex` is a
 *  LOCAL triangle index into whichever body mesh was actually hit. */
export function faceIdOfHit(hit: THREE.Intersection): number {
  const owner = hit.object.userData.owner as BodyMesh | undefined;
  return owner?.faceIds[hit.faceIndex ?? 0] ?? 0;
}

/** Which BodyMesh owns a global B-rep faceId (undefined if none — e.g. a stale
 *  id from before a rebuild). Shared by viewport.ts's public faceIdToBodyId and
 *  highlight.ts's per-body paint/restore, so the range lookup has one definition. */
export function bodyOfFace(view: ModelView, faceId: number): BodyMesh | undefined {
  return view.bodies.find((b) => faceId >= b.faceStart && faceId < b.faceStart + b.faceCount);
}

/** Reset a REUSED body's transient per-model display state (clip plane, dimmed
 *  opacity, emphasized/hovered/selected edge styling) back to build-time
 *  defaults — i.e. make it look exactly like a freshly built body would. A
 *  reused body's mesh/material/edge objects are never recreated across a
 *  rebuild, so without this they'd keep whatever setClipPlane()/
 *  setModelDimmed()/emphasizeEdges()/Highlighter left on them from before this
 *  reply. The old single-merged-mesh code reset ALL of this on every rebuild by
 *  construction (a fresh mesh+materials every time); this keeps that same
 *  "lost on rebuild" guarantee uniform across every body, reused or not.
 *  Skips the mesh material when it's not this body's own (e.g. the shared
 *  zebra-stripe shader material is swapped in/out by Viewport.applyZebra(),
 *  never touched here). */
export function resetBodyAppearance(body: BodyMesh) {
  // clear any leftover move-ghost translation: a reused (etag-unchanged) body
  // must sit at the origin — its vertices already encode its true position.
  body.mesh.position.set(0, 0, 0);
  body.mesh.updateMatrixWorld();
  for (const e of body.edges) e.position.set(0, 0, 0);
  if (body.mesh.material instanceof THREE.MeshStandardMaterial) {
    const mat = body.mesh.material;
    mat.clippingPlanes = null;
    mat.transparent = false;
    mat.opacity = 1;
    mat.depthWrite = true;
  }
  for (const e of body.edges) {
    const emat = e.material as LineMaterial;
    emat.clippingPlanes = null;
    emat.transparent = false;
    emat.opacity = 1;
    emat.color.setHex(EDGE_IDLE_COLOR);
    emat.linewidth = EDGE_IDLE_WIDTH;
  }
}

function disposeBody(body: BodyMesh) {
  disposeObject(body.mesh);
  for (const e of body.edges) disposeObject(e);
}

export { disposeBody, buildEdgeLines };

export function disposeModel(view: ModelView | null) {
  if (!view) return;
  for (const b of view.bodies) disposeBody(b);
  for (const e of view.orphanEdges) disposeObject(e);
}

export function setEdgeResolution(view: ModelView | null, res: THREE.Vector2) {
  if (!view) return;
  for (const e of view.edges) (e.material as LineMaterial).resolution.copy(res);
}
