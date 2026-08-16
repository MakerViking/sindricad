// Picking: raycast the mesh (faces) and the fat edge lines (edges), then turn a
// hit into a *selector descriptor* — never a raw index. Axis-aligned geometry
// becomes a robust axis/normal selector; otherwise a nearest-to-point selector.

import * as THREE from "three";
import type { Selector } from "../types";
import type { ModelView } from "./render";
import type { BodyMesh } from "./render";
import { bodyOfHit, edgeObjects, faceIdOfHit, visibleBodyMeshes } from "./render";
import type { BodyEdges, EdgeRef } from "./edgeLines";
import { edgeSelectorFrom } from "./edgeMatch";
import { flushRaycastIndex } from "./raycastIndex";

export interface EdgeHit {
  kind: "edge";
  /** the edge itself — a stable reference, not the object that draws it */
  edge: EdgeRef;
  selector: Selector;
}

export interface FaceHit {
  kind: "face";
  faceId: number;
  selector: Selector;
  /** world-space raycast intersection — a point guaranteed ON the face's
   *  material (its centroid may not be: annular/holed faces). */
  point: [number, number, number];
}

export type Hit = EdgeHit | FaceHit;

export class Picker {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private scratch = new THREE.Vector3();
  // screen-space distance (px) of the best edge hit from the last pickEdge() —
  // lets pick() prefer a face over an edge unless the cursor is on the edge line.
  private edgeScreenDist = Infinity;
  // Raycast targets: ONE merged object per body now, so this list is ~3k long
  // instead of ~348k and the per-move filter is cheap. Hidden edges are not in
  // the geometry at all (BodyEdges rebuilds without them), so there is nothing
  // per-edge left to filter here — only whole-body visibility.
  private targetCache: { view: ModelView; targets: THREE.Object3D[] } | null = null;
  private edgeTargets(view: ModelView): THREE.Object3D[] {
    if (this.targetCache?.view !== view) {
      const targets = edgeObjects(view).filter((d) => d.pickable).map((d) => d.object);
      this.targetCache = { view, targets };
    }
    return this.targetCache.targets;
  }

  /** Drop the cached raycast targets — call after anything that changes which
   *  bodies or edges are drawn (hideFlushSeams, body show/hide). */
  invalidate() {
    this.targetCache = null;
  }

  /** All pickable (visible) edges — also used for tangent-chain expansion. */
  visibleEdges(view: ModelView): EdgeRef[] {
    return edgeObjects(view).flatMap((d) => d.visibleRefs());
  }

  /** General selection: a face wins over an edge unless the cursor is right on
   *  the edge line — within edgeBandPx(), which is EDGE_NEAR_PX on ordinary
   *  geometry and shrinks to a fifth of the face on a SMALL one (task #56: a
   *  3mm face at 300mm is ~11px, so a fixed 3px halo eats all of it). The
   *  dedicated edge tools call pickEdgeAt() directly and keep the generous
   *  EDGE_PICK_THRESHOLD radius.
   *
   *  Knock-on, deliberate: viewport.ts consults the sketch REGION only when the
   *  hit is not an edge (handleHover/handleClick), so on a small face under a
   *  visible sketch a near-border click that used to be an EDGE now resolves as
   *  a face and the region wins. The documented EDGE > sketch REGION > body FACE
   *  order is untouched — only the "is this an edge" boundary moved, and it
   *  moves identically for every pick() consumer: left-click select, the
   *  feature-selection hook (viewport.onHit -> main.ts's featureForFace, which
   *  now fires on near-border clicks where nothing used to happen), Measure, the
   *  right-click canvas menu, and the Project tool's hover. Press/Pull's
   *  dispatcher joins that list on feat/presspull-dispatch, where it picks with
   *  pickEntity() — this file's own pick() — rather than the plain
   *  pickFaceForPressPull raycast it still uses here. */
  pick(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
  ): Hit | null {
    // Body BVHs are built after the first paint, not during setModel (see
    // raycastIndex.ts). If a pick beats that, build them now: three-mesh-bvh
    // would otherwise fall back to a brute-force scan of every triangle. Free
    // once the queue has drained, which is the normal case.
    flushRaycastIndex();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);
    // one Mesh per visible body now (not caching this list like visibleEdges —
    // body counts are small, unlike edge counts, so a per-move filter is cheap).
    const fHits = this.raycaster.intersectObjects(visibleBodyMeshes(view), false);
    const fHit = fHits[0];
    let face: FaceHit | null = null;
    if (fHit) {
      const faceId = faceIdOfHit(fHit);
      const point = fHit.point.clone();
      const normal =
        fHit.normal?.clone().transformDirection(fHit.object.matrixWorld) ??
        new THREE.Vector3(0, 0, 1);
      face = { kind: "face", faceId, selector: faceSelector(normal, point), point: [point.x, point.y, point.z] };
    }

    // Edges BEHIND the surface must not win. pickEdge deliberately ranks by
    // screen distance rather than depth, which is right for choosing between
    // edges you can see, but it also let an edge on the FAR side of the body
    // take the click: the raycaster reports it, and it can easily be nearer the
    // cursor in screen space than any visible edge. Edge materials are
    // depthTest:true, so that edge is not even drawn where it wins.
    //
    // This is why small faces got dramatically worse at shallow angles: tilting
    // the view projects the far-side edges right next to the near-side ones, so
    // a letter counter that merely loses SOME pixels head-on can lose all of
    // them at 60 degrees.
    //
    // The cutoff has to be tight. A percentage of the view distance is useless
    // on a thin part, where the far edge of a 2mm plate is only 2mm behind the
    // face. Two pixels' worth of world size AT THAT DEPTH is scale-free and
    // still comfortably admits an edge lying on the surface it bounds.
    const maxDepth = fHit ? fHit.distance + 2 * worldPerPixel(camera, fHit.distance, rect.height) : undefined;
    const edge = this.pickEdge(clientX, clientY, rect, camera, view, maxDepth);

    // edge only when on the line (or there's no face under the cursor at all).
    // The band depends on the face being competed for, so measure it — but only
    // when an edge is already inside the WIDEST band the policy can produce.
    // edgeBandPx() never exceeds EDGE_NEAR_PX, so beyond that the face has
    // already won and projecting its triangles on every pointermove would be
    // pure cost on a hover path that runs per rAF over thousands of bodies.
    if (edge && !face) return edge;
    if (edge && face && fHit && this.edgeScreenDist <= EDGE_NEAR_PX) {
      const extent = faceScreenExtentPx(bodyOfHit(fHit), face.faceId, camera, rect);
      if (this.edgeScreenDist <= edgeBandPx(extent)) return edge;
    }
    return face;
  }

  /** Edge-only pick. Returns a precise single-edge (by:nearest) selector — used
   *  by fillet/chamfer where you want exactly the edge you clicked, not its
   *  whole axis group. Also sets this.ndc for a follow-up face pick. */
  pickEdge(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
    maxDepth?: number,
  ): EdgeHit | null {
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);
    // Wide candidate threshold (three.js Line2 threshold is ~0.5× screen px, so
    // this is a forgiving grab radius). We then choose the edge nearest the
    // cursor IN SCREEN SPACE — the raycaster sorts by camera depth, which would
    // otherwise grab a front edge that's visually farther from the cursor.
    this.raycaster.params.Line2 = { threshold: EDGE_PICK_THRESHOLD };
    (this.raycaster as any).camera = camera;
    // NOTE: each LineMaterial's .resolution is kept in sync by
    // setEdgeResolution() on resize, and set at creation time in buildBodyMesh()
    // (render.ts) — no per-move sync needed here.
    // skip hidden lines (flush-seam-hidden contact rims, hidden bodies) — the
    // raycaster tests invisible objects too, which would give ghost edge picks
    const eHits = this.raycaster.intersectObjects(this.edgeTargets(view), false);
    if (!eHits.length) return null;

    let best = eHits[0];
    if (!best) return null;
    let bestD = Infinity;
    for (const h of eHits) {
      // an edge behind the surface at this pixel is not drawn there, so it must
      // not be pickable there either (see pick())
      if (maxDepth !== undefined && h.distance > maxDepth) continue;
      const p = (h as any).pointOnLine ?? h.point;
      this.scratch.copy(p).project(camera);
      const sx = (this.scratch.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-this.scratch.y * 0.5 + 0.5) * rect.height + rect.top;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (bestD === Infinity) return null; // every candidate was occluded
    this.edgeScreenDist = bestD; // used by pick() to decide edge vs face

    // three reports the instance (segment) index as `faceIndex` on a
    // LineSegments2 hit; the owning BodyEdges maps it back to the edge.
    const draw = best.object.userData.edges as BodyEdges | undefined;
    const edge = draw?.refAtSegment(best.faceIndex ?? -1);
    if (!edge) return null;
    const selector = edgeSelectorFrom({ points: edge.points, body: edge.body });
    if (!selector) return null;
    return { kind: "edge", edge, selector };
  }
}

// three.js Line2 raycast threshold is ~0.5× the on-screen pixel radius, so ~26
// gives a comfortable ~13px grab radius. Candidates are then narrowed by screen
// distance (see pickEdge), so a wide value stays precise.
const EDGE_PICK_THRESHOLD = 26;

/** World size of one screen pixel at `dist` from the camera.
 *
 *  Used to turn "a couple of pixels behind the surface" into a world distance,
 *  which is the only occlusion tolerance that behaves on both a 2mm plate and a
 *  300mm assembly. A tolerance expressed as a FRACTION of the view distance
 *  fails exactly where it matters most: the far edge of a thin plate sits well
 *  inside any sane percentage, and thin plates are where small faces live. */
export function worldPerPixel(camera: THREE.Camera, dist: number, heightPx: number): number {
  if (heightPx <= 0) return 0;
  const persp = camera as THREE.PerspectiveCamera;
  if (persp.isPerspectiveCamera) {
    return (2 * Math.tan((persp.fov * Math.PI) / 360) * Math.abs(dist)) / heightPx;
  }
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    return (ortho.top - ortho.bottom) / (ortho.zoom || 1) / heightPx;
  }
  return 0;
}
// In general selection, only treat a click as an edge when the cursor is within
// this many screen px of the edge line; otherwise a face under the cursor wins.
// Kept TIGHT: on an edge-dense model (faceted imports) a generous radius put
// most of every face inside some edge's halo, so faces only highlighted in
// "sweet spots" between edges. 3 px = you're visibly ON the line. Fillet/
// Chamfer (pickEdgeAt) ignore this and keep the wide grab radius.
export const EDGE_NEAR_PX = 3;

// The band is a FRACTION of the face, capped at EDGE_NEAR_PX (see edgeBandPx).
const BAND_EXTENT_FRACTION = 0.2;
// ...but never smaller than this, or a face a few px across would have no edge
// halo at all and its bounding edges would stop being selectable entirely.
const MIN_EDGE_BAND_PX = 0.75;
// Min screen extent at which the cap takes over and the band is EDGE_NEAR_PX
// again: 3 / 0.2 = 15 px. This is the SAFETY THRESHOLD — at or above it the
// pick is bit-identical to before this change.
const EXTENT_CAP_PX = EDGE_NEAR_PX / BAND_EXTENT_FRACTION;

/** Edge-priority band for a face whose smaller on-screen dimension is
 *  `minScreenExtentPx`, in CSS px.
 *
 *  Task #56, measured at 45deg fov / 900px high / face at 300mm: a 3mm face is
 *  ~10.9 x 10.9 px head-on and ~10.9 x 5.4 px at 60 degrees. A FIXED 3px halo
 *  on all four borders leaves 20% of the first clickable and 0% of the second —
 *  the field report verbatim, "the face cannot be selected at all". Occluded
 *  edges (see picking.test.ts) were the other half of that cause and are
 *  already fixed; this is the half that survives a depth test.
 *
 *  Scaling the band by the face's own screen size makes it a constant FRACTION
 *  of the face instead of a constant number of pixels. The min() cap is the
 *  safety property, and the reason ordinary parts do not shift under you: at a
 *  minimum screen extent of EXTENT_CAP_PX (15px) or more the band is 3px again,
 *  so every face that is comfortably clickable today behaves EXACTLY as it did
 *  and edges keep winning everywhere they win now. Only the faces that were
 *  unusable get a smaller halo. */
export function edgeBandPx(minScreenExtentPx: number): number {
  return Math.max(MIN_EDGE_BAND_PX, Math.min(EDGE_NEAR_PX, minScreenExtentPx * BAND_EXTENT_FRACTION));
}

/** Enough of a face to know how big it is — deliberately structural, so the
 *  extent can be measured (and tested) without a whole ModelView. */
type FaceGeometry = Pick<BodyMesh, "mesh" | "faceTriangles">;

// A long thin face (a fillet band 5px x 900px) never satisfies the early exit
// below, so the number of triangles read is also capped.
//
// The cap SAMPLES ACROSS THE WHOLE LIST rather than taking the first N, and
// that is load-bearing, not tidiness. Review found the first-N version breaking
// the change's headline safety property outright: triangle order out of a
// UV-grid tessellator (and out of OCCT's BRepMesh) is spatially coherent, so
// the first 256 triangles of a densely tessellated face are a couple of ROWS of
// it. A 100mm face at 300mm — 362 x 362 px, nowhere near small — measured 9.05px
// at an 80x80 grid and 2.29px at 158x158, i.e. it got a 1.81px or 0.75px band
// instead of 3px and its bounding edges stopped winning picks. render.ts:277
// records 50,074 triangles on ONE hex-textured face and textureTool applies to
// a FACE selector, so the flagship feature lands squarely on this.
//
// Truncation and sampling are NOT the same error. Both can only ever
// under-estimate, but a truncated walk under-estimates by the whole unwalked
// part of the face, while a spread sample is wrong only by the geometry between
// two neighbouring samples. Sampling also makes the early exit fire SOONER on a
// big face — consecutive samples are far apart on it — so this is cheaper than
// the first-N walk it replaces, not dearer.
//
// The index is a low-discrepancy (Weyl / golden-ratio) sequence rather than a
// constant stride, because a constant stride aliases against exactly the
// tessellation this exists for. On a grid whose row is R triangles, a stride
// that is a multiple of R samples one COLUMN of it and re-creates the bug in
// the other axis — measured, not hypothesised: a 40 x 400 px face at 4 x 256
// cells is 2048 triangles, 2048/256 = a stride of 8, and its row is 8
// triangles, so it measured 10px and got a 2px band. A fractional stride does
// not save it either; 2048/256 is exact. An irrational step cannot be periodic
// with any R.
const EXTENT_TRI_SAMPLES = 256;
// 2/(1+sqrt(5)). Irrational, so `i * GOLDEN mod 1` never repeats a column.
const GOLDEN = 0.6180339887498949;

const extentScratch = new THREE.Vector3();

/** The face's SMALLER on-screen dimension in CSS px, or Infinity when it cannot
 *  be measured. Infinity is the "behave exactly as before" sentinel: it makes
 *  edgeBandPx() return EDGE_NEAR_PX, so every bail-out here is fail-safe rather
 *  than a silent behaviour change (pinned as a behaviour in picking.test.ts).
 *
 *  The smaller dimension, not the area: the case that motivated task #56 is a
 *  face that projects to an 11 x 5 px sliver, and an area — or the extent of
 *  the single hit triangle on a finely tessellated cylinder — cannot see it. */
export function faceScreenExtentPx(
  body: FaceGeometry | undefined,
  faceId: number,
  camera: THREE.Camera,
  size: { width: number; height: number },
): number {
  const tris = body?.faceTriangles.get(faceId);
  if (!body || !tris?.length) return Infinity;
  const pos = body.mesh.geometry.getAttribute("position");
  const index = body.mesh.geometry.getIndex();
  if (!pos || !index) return Infinity;
  const mw = body.mesh.matrixWorld;
  const persp = camera as THREE.PerspectiveCamera;
  const v = extentScratch;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const n = Math.min(tris.length, EXTENT_TRI_SAMPLES);
  const sampled = n < tris.length;
  for (let i = 0; i < n; i++) {
    // spread over the WHOLE face, never its first n triangles — see
    // EXTENT_TRI_SAMPLES. A face small enough to read whole is still read
    // whole, in order, so nothing about the ordinary case changes.
    const t = tris[sampled ? Math.floor(((i * GOLDEN) % 1) * tris.length) : i]!;
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(pos, index.getX(t * 3 + k)).applyMatrix4(mw).applyMatrix4(camera.matrixWorldInverse);
      // A vertex at or behind the near plane projects to garbage (the
      // perspective divide flips sign through it), so one such vertex poisons
      // the whole bounding box. Such a face fills the screen anyway, so the
      // unknown sentinel is both safe and correct here. PERSPECTIVE ONLY, and
      // deliberately expressed against `near` rather than as `v.z >= 0`: the
      // ortho camera (cameras.ts builds it with near = -10000) legitimately
      // renders geometry at POSITIVE view-space z, so a sign test — the obvious
      // way to write "behind the camera" — would return the sentinel for
      // roughly half of every ortho pick and quietly revert this fix there.
      if (persp.isPerspectiveCamera && -v.z <= persp.near) return Infinity;
      v.applyMatrix4(camera.projectionMatrix); // Vector3 does the perspective divide
      const sx = (v.x * 0.5 + 0.5) * size.width;
      const sy = (-v.y * 0.5 + 0.5) * size.height;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    // Both dimensions only ever GROW as vertices are added, so once both clear
    // the cap the band is pinned at EDGE_NEAR_PX whatever the rest do. Because
    // the samples are spread over the whole face rather than taken in order,
    // consecutive ones are far apart on a big face and this fires within a few
    // of them — which is what keeps a per-pointermove path affordable. (Under
    // the first-N walk it did NOT: a dense grid face walked all 256 without
    // ever exiting, which is how the under-measurement above went unnoticed.)
    if (maxX - minX > EXTENT_CAP_PX && maxY - minY > EXTENT_CAP_PX) return Infinity;
  }
  return Math.min(maxX - minX, maxY - minY);
}

function faceSelector(normal: THREE.Vector3, hit: THREE.Vector3): Selector {
  const n = normal.clone().normalize();
  const near = (v: number, t: number) => Math.abs(v - t) < 1e-3;
  const axisAligned =
    (near(Math.abs(n.x), 1) && near(n.y, 0) && near(n.z, 0)) ||
    (near(Math.abs(n.y), 1) && near(n.x, 0) && near(n.z, 0)) ||
    (near(Math.abs(n.z), 1) && near(n.x, 0) && near(n.y, 0));
  if (axisAligned) {
    return {
      kind: "face",
      by: "normal",
      dir: [round(n.x), round(n.y), round(n.z)],
    };
  }
  return { kind: "face", by: "nearest", point: [hit.x, hit.y, hit.z] };
}

const round = (v: number) => Math.round(v);
