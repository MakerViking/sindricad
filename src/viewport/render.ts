// Turn a RebuildResult into Three.js objects: one shaded Mesh+BufferGeometry PER
// BODY (with per-triangle faceIds for picking) plus crisp fat edge lines. Bodies
// are keyed by id so an unchanged body (same wire-protocol etag) can reuse its
// previous GPU objects untouched instead of rebuilding — see Viewport.setModel().

import * as THREE from "three";
import type { RebuildResult } from "../types";
import { disposeObject } from "./dispose";
import { buildRaycastIndex } from "./raycastIndex";
import { BodyEdges, EDGE_IDLE_COLOR, EDGE_IDLE_WIDTH, type EdgeRef } from "./edgeLines";

export { BodyEdges, EDGE_IDLE_COLOR, EDGE_IDLE_WIDTH };
export type { EdgeRef };

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
  /** every edge of this body, merged into ONE object with ONE material */
  edges: BodyEdges;
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
  // consumers (overlays.ts's curvature combs, edgeLineByMid, hideFlushSeams)
  // already expect. These are REFERENCES now, not THREE objects: the drawable
  // lives on the owning body's BodyEdges (ref.draw).
  edges: EdgeRef[];
  // Edges whose `body` doesn't name a live body id. The current sidecar/Rust
  // backend always tags every edge with its owning body, so in practice this is
  // always empty — kept as a defensive fallback (rebuilt fresh every setModel()
  // call, always visible, never moved with a body) so a body-less edge can't
  // silently vanish if that invariant ever lapses.
  orphanEdges: BodyEdges | null;
  box: THREE.Box3;
}

// Base albedo is baked into vertex colors (material.color stays white) so
// highlight.ts can recolor a single face's vertices without touching lighting.
export const BASE_COLOR = new THREE.Color(0x9aa7b4);


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

function buildEdgeLines(edges: RebuildResult["edges"], resolution: THREE.Vector2): BodyEdges {
  return new BodyEdges(edges, resolution);
}

/** A one-time bucketing of the reply's single shared triangle array into
 *  per-body triangle lists, plus one shared global->local vertex scratch buffer.
 *
 *  Without this, buildBodyMesh is O(bodies x WHOLE-MODEL triangles): each body
 *  scans every triangle in the model to find its own, and allocates+fills its
 *  own whole-model `Int32Array` remap. That is invisible at 5 bodies and fatal
 *  at 3,000 — measured 38.1s to build one imported assembly, 2.1s with this.
 *  Here the whole model is walked TWICE total, no matter how many bodies. */
export interface MeshPartition {
  /** body id -> indices into `result.mesh.faceIds` of the triangles it owns */
  trisByBody: Map<string, Int32Array>;
  /** global vertex index -> body-local; -1 everywhere between bodies. Shared
   *  across bodies and handed back clean by buildBodyMesh (which resets only
   *  the entries it touched) — refilling this per body is the very cost being
   *  removed. */
  remap: Int32Array;
}

/** Bucket `result`'s triangles by owning body, in two passes over the model.
 *  Only bodies named in `rebuilding` get a list: a body whose etag is unchanged
 *  keeps its existing GPU objects and is never passed to buildBodyMesh, so
 *  bucketing its triangles would be pure waste. */
export function partitionMesh(result: RebuildResult, rebuilding: Iterable<string>): MeshPartition {
  const metas = result.bodies ?? [];
  const wanted = rebuilding instanceof Set ? rebuilding : new Set(rebuilding);
  const { faceIds, positions } = result.mesh;

  // faceId -> slot, so the per-triangle test is one array read instead of a
  // range comparison against every body. -1 = a face nobody is rebuilding.
  let faceLimit = 0;
  for (const m of metas) faceLimit = Math.max(faceLimit, m.faceStart + m.faceCount);
  const slotOfFace = new Int32Array(faceLimit).fill(-1);
  const slotBodies: string[] = [];
  for (const m of metas) {
    if (!wanted.has(m.id)) continue;
    const slot = slotBodies.length;
    slotBodies.push(m.id);
    slotOfFace.fill(slot, m.faceStart, Math.min(m.faceStart + m.faceCount, faceLimit));
  }

  // pass 1: count, so each body's list is exactly sized (no growing arrays)
  const counts = new Int32Array(slotBodies.length);
  for (let t = 0; t < faceIds.length; t++) {
    const fid = faceIds[t];
    if (fid === undefined || fid < 0 || fid >= faceLimit) continue;
    const slot = slotOfFace[fid]!;
    if (slot >= 0) counts[slot]!++;
  }

  // pass 2: fill. Triangle ORDER within a body is preserved (ascending t), which
  // is what keeps localFaceIds and the faceTriangles map identical to the
  // scan-every-triangle path.
  const lists = slotBodies.map((_, i) => new Int32Array(counts[i]!));
  const cursor = new Int32Array(slotBodies.length);
  for (let t = 0; t < faceIds.length; t++) {
    const fid = faceIds[t];
    if (fid === undefined || fid < 0 || fid >= faceLimit) continue;
    const slot = slotOfFace[fid]!;
    if (slot < 0) continue;
    lists[slot]![cursor[slot]!++] = t;
  }

  const trisByBody = new Map<string, Int32Array>();
  for (let i = 0; i < slotBodies.length; i++) trisByBody.set(slotBodies[i]!, lists[i]!);
  return { trisByBody, remap: new Int32Array(positions.length / 3).fill(-1) };
}

/** Build one body's own isolated Mesh+BufferGeometry: slice its triangles out of
 *  the (still shared-array) wire mesh — result.mesh stays one concatenated set
 *  of arrays, per client.ts's assemble() — and remap to a dense local vertex
 *  range, so each body owns independent GPU buffers untouched by any other
 *  body's rebuild. `faceIds` in the slice stay their original (globally-unique)
 *  B-rep ids; only the vertex numbering is body-local.
 *
 *  `partition` is optional and purely a performance path: pass one when building
 *  several bodies from the same reply. Output is identical either way. */
export function buildBodyMesh(
  result: RebuildResult,
  meta: { id: string; name: string; faceStart: number; faceCount: number },
  bodyEdges: RebuildResult["edges"],
  resolution: THREE.Vector2,
  etag: string | undefined,
  partition?: MeshPartition,
): BodyMesh {
  const { positions, indices, faceIds } = result.mesh;
  const meshNormals = result.mesh.normals;
  const { faceStart, faceCount } = meta;
  const faceEnd = faceStart + faceCount;

  // The triangles this body owns. With a partition they were bucketed in one
  // pass over the whole model; without one — the single-body live-preview drag
  // path — scanning costs the same, so don't make the caller build one.
  const shared = partition?.trisByBody.get(meta.id);
  let owned: Int32Array;
  if (shared) {
    owned = shared;
  } else {
    const scan: number[] = [];
    for (let t = 0; t < faceIds.length; t++) {
      const fid = faceIds[t];
      if (fid !== undefined && fid >= faceStart && fid < faceEnd) scan.push(t);
    }
    owned = Int32Array.from(scan);
  }

  // global vertex index -> local (dense); a flat typed array beats a Map here —
  // this runs per changed body on every live-preview drag tick, and Map<number,
  // number> pays hashing/boxing on 3 lookups per triangle.
  const remap = shared ? partition!.remap : new Int32Array(positions.length / 3).fill(-1);
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
  for (let k = 0; k < owned.length; k++) {
    const t = owned[k]!;
    const fid = faceIds[t];
    if (fid === undefined) continue;
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
    localIndices.push(local(i0), local(i1), local(i2));
    localFaceIds.push(fid);
  }

  // Hand the SHARED remap back clean for the next body by clearing only the
  // entries this body touched — O(this body), never O(model). Refilling a
  // whole-model buffer per body is exactly the cost partitionMesh removes.
  if (shared) {
    for (let k = 0; k < owned.length; k++) {
      const t = owned[k]!;
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      if (i0 !== undefined) remap[i0] = -1;
      if (i1 !== undefined) remap[i1] = -1;
      if (i2 !== undefined) remap[i2] = -1;
    }
  }

  // A textured face arrives fully de-indexed — 3 unique vertices per triangle,
  // no sharing at all (measured 2.99 verts/tri on a hex texture: 149,950
  // vertices for 50,074 triangles). That is how the sidecar delivers
  // per-triangle normals for faceted shading. Weld the duplicates back
  // together: same position, same normal, same face => same vertex.
  //
  // The key MUST include the faceId. Welding on position+normal alone would let
  // two coplanar neighbouring faces share a vertex, and then hover-painting one
  // face bleeds colour into the other — face colour is per-VERTEX here.
  //
  // Triangle ORDER is untouched, so `localFaceIds` and the `faceTriangles` map
  // built below stay valid; only vertex numbering changes. Only runs when the
  // sidecar shipped normals (i.e. a textured body) — everything else already
  // arrives well-shared at ~1.02 verts/tri, and welding it would change what
  // computeVertexNormals averages over.
  let posOut = localPositions;
  let nrmOut = localNormals;
  if (anyNormal && localIndices.length) {
    const q = 1e4; // 0.1µm position buckets, 1e-3 on the unit normal
    const seen = new Map<string, number>();
    const wp: number[] = [];
    const wn: number[] = [];
    for (let t = 0; t < localIndices.length; t++) {
      const v = localIndices[t]!;
      const fid = localFaceIds[(t / 3) | 0]!;
      const b = v * 3;
      const key = `${Math.round(localPositions[b]! * q)},${Math.round(localPositions[b + 1]! * q)},`
        + `${Math.round(localPositions[b + 2]! * q)}|${Math.round(localNormals[b]! * 1e3)},`
        + `${Math.round(localNormals[b + 1]! * 1e3)},${Math.round(localNormals[b + 2]! * 1e3)}|${fid}`;
      let nv = seen.get(key);
      if (nv === undefined) {
        nv = wp.length / 3;
        seen.set(key, nv);
        wp.push(localPositions[b]!, localPositions[b + 1]!, localPositions[b + 2]!);
        wn.push(localNormals[b]!, localNormals[b + 1]!, localNormals[b + 2]!);
      }
      localIndices[t] = nv;
    }
    posOut = wp;
    nrmOut = wn;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(posOut, 3));
  geo.setIndex(localIndices);
  // a textured body ships sidecar-computed normals (analytic on displaced
  // faces — smooth shading at coarse displacement density); everything else
  // keeps the usual client-side accumulation.
  if (anyNormal) geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrmOut, 3));
  else geo.computeVertexNormals();

  // per-vertex color baked to the base albedo; highlight recolors a face's
  // vertices without disturbing lighting (material.color is white).
  const vcount = posOut.length / 3;
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
  // Hover picking raycasts this mesh on every pointermove; without a BVH that
  // is a full triangle scan (2.60ms median on a 50k-triangle textured body).
  buildRaycastIndex(geo);

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

/** faceId -> owning body, built lazily per ModelView and thrown away with it
 *  (a new reply always makes a new ModelView, so this can never go stale).
 *  Bodies own contiguous faceId ranges, so a sorted range table + binary search
 *  answers in log(bodies) instead of scanning — this runs on every hover, and a
 *  linear scan over an imported assembly's thousands of bodies is felt. */
const faceIndexCache = new WeakMap<ModelView, { starts: Int32Array; bodies: BodyMesh[] }>();

function faceIndexOf(view: ModelView) {
  let idx = faceIndexCache.get(view);
  if (!idx) {
    const bodies = [...view.bodies].sort((a, b) => a.faceStart - b.faceStart);
    const starts = new Int32Array(bodies.length);
    for (let i = 0; i < bodies.length; i++) starts[i] = bodies[i]!.faceStart;
    idx = { starts, bodies };
    faceIndexCache.set(view, idx);
  }
  return idx;
}

/** Which BodyMesh owns a global B-rep faceId (undefined if none — e.g. a stale
 *  id from before a rebuild). Shared by viewport.ts's public faceIdToBodyId and
 *  highlight.ts's per-body paint/restore, so the range lookup has one definition. */
export function bodyOfFace(view: ModelView, faceId: number): BodyMesh | undefined {
  const { starts, bodies } = faceIndexOf(view);
  // rightmost body whose faceStart <= faceId
  let lo = 0, hi = starts.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= faceId) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return undefined;
  const b = bodies[found]!;
  // ranges can have gaps (a body dropped between replies), so still bounds-check
  return faceId < b.faceStart + b.faceCount ? b : undefined;
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
  if (body.mesh.material instanceof THREE.MeshStandardMaterial) {
    const mat = body.mesh.material;
    mat.clippingPlanes = null;
    mat.transparent = false;
    mat.opacity = 1;
    mat.depthWrite = true;
  }
  body.edges.resetAppearance();
}

function disposeBody(body: BodyMesh) {
  disposeObject(body.mesh);
  body.edges.dispose();
}

export { disposeBody, buildEdgeLines };

export function disposeModel(view: ModelView | null) {
  if (!view) return;
  for (const b of view.bodies) disposeBody(b);
  view.orphanEdges?.dispose();
}

export function setEdgeResolution(view: ModelView | null, res: THREE.Vector2) {
  if (!view) return;
  for (const b of view.bodies) b.edges.setResolution(res);
  view.orphanEdges?.setResolution(res);
}

/** Every merged edge object in the model — the things that actually live in the
 *  scene graph and get raycast, as opposed to ModelView.edges (references). */
export function edgeObjects(view: ModelView): BodyEdges[] {
  const out = view.bodies.map((b) => b.edges);
  if (view.orphanEdges) out.push(view.orphanEdges);
  return out;
}
