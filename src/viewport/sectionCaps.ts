// Solid section caps: what makes a section cut read as SOLID instead of hollow.
// Field report 5effc008: "Section view implies all the bodies are hollow, would
// be good to see the solid section."
//
// The cut itself is a clipping plane on the body materials (Viewport.setClipPlane),
// and a clipped closed surface shows its own inside. The stencil buffer fills
// that hole, one body at a time:
//
//   1. A WRITER draws the body's surface, clipped by the same plane moved a
//      hair into the kept side (WRITER_NUDGE), into the stencil only (no
//      colour, no depth), flipping bit 0 for every layer it covers. Along a
//      view ray the layers left on the kept side are odd in number exactly
//      where the ray meets the plane INSIDE the body.
//   2. A CAP quad on the plane draws where that bit is set, in the body's colour
//      darkened, depth-tested like any surface. It writes 0 back as it goes, so
//      the next body starts from a clean stencil without a full-screen clear.
//
// Parity (Invert) rather than the Increment/Decrement front/back pair of three's
// webgl_clipping_stencil example: parity needs the surface CLOSED but not
// consistently wound, and a textured face's display triangles are not
// (tessellate.py's orient_consistently measured 1911 disagreeing edges on a
// hex-textured cube). It is also one draw per body instead of two.
//
// A body whose tessellation is not closed (an open or scanned mesh) gets no cap:
// its parity is wrong somewhere and the cap would streak across the view. It
// stays hollow, which is how every body looked before caps. A textured face's
// T-junctions do not count as open (see isClosedSurface).
//
// Picking has to agree with all this (Viewport.pickClip): the removed half is
// not drawn, so a ray must not land on it, and a cap hides what is behind it.
// capAt() answers the second part with the same parity, for one ray.

import * as THREE from "three";

/** Above this many cut bodies, one shared cap (every writer, then ONE quad in a
 *  single colour) replaces a cap per body. The writers cost the same either way;
 *  what this saves is a quad draw and two stencil-state switches per body, which
 *  is what a cut through a large assembly pays. Bodies are no longer told apart
 *  by colour past it, which is the price.
 *
 *  Measured in headless chromium on swiftshader (a CPU rasteriser, so the ratio
 *  means more than the milliseconds): with every one of 256 small boxes cut, a
 *  cap each added 7.7 ms to an 8.2 ms frame; 257 on the shared cap added 4.0.
 *  Where the limit sits is a judgement, not a measured knee. */
export const SHARED_CAP_ABOVE = 256;

/** How much darker a cap is than its body: a factor on the LINEAR colour, so
 *  0.45 reads as roughly 70% of the body's on-screen brightness. Dark enough to
 *  read as "cut", light enough that two bodies' colours still differ. */
export const CAP_SHADE = 0.45;

/** Writers and caps draw after the bodies (renderOrder 0) and well before the
 *  handles (997-999, depth test off, so a cap drawn after one would paint over
 *  it). Body k of n takes the two slots CAP_ORDER + (2k, 2k+1) / 2n: its writer,
 *  then its cap, then the next body's writer. */
const CAP_ORDER = 1;

/** How far a body's writer plane sits past the cut, into the kept side, as a
 *  fraction of the body's size.
 *
 *  A face lying exactly ON the cut is clipped or kept fragment by fragment on
 *  float noise. The bodies have always shown that as speckle, but the parity
 *  follows it too, and with the writer on the true plane a cap filled whole
 *  tessellation triangles of EMPTY space, a different set from every camera
 *  angle (review: a cup cut on its inner wall, which the arrow's 0.5 mm steps
 *  land on for any part with round dimensions). Moved this far, a face on the
 *  cut is always outside the writer, and the cap shows the section a hair
 *  inside the kept side.
 *
 *  Per body, so it scales with what it nudges: 1e-4 of the body is a tenth of
 *  a pixel when the body fills the screen. Float32 noise in the clip distance
 *  is of order 1e-7 of the distance to the camera, so it stays under this
 *  until the body is a handful of pixels across. */
export const WRITER_NUDGE = 1e-4;

/** The bits of one body that matter here. BodyMesh satisfies it. */
export interface CappableBody {
  mesh: THREE.Mesh;
}

interface CapEntry {
  writer: THREE.Mesh;
  /** the writer's own clipping plane: the cut, moved WRITER_NUDGE of this body
   *  into the kept side */
  plane: THREE.Plane;
  cap: THREE.Mesh;
  /** the body's world box at the last sync, for capAt */
  box: THREE.Box3;
}

/** Where a pick ray meets a cap (SectionCaps.capAt). */
export interface CapHit {
  /** along the ray, to the cut */
  distance: number;
  /** the body whose cap it is */
  mesh: THREE.Mesh;
}

const closedCache = new WeakMap<THREE.BufferGeometry, boolean>();

/** Whether a tessellation is a closed surface: once coincident vertices are
 *  welded, every edge is used an EVEN number of times. A face's vertices are
 *  shared inside it but duplicated across faces, which is why the weld comes
 *  first. Winding is ignored on purpose (parity does not need it).
 *
 *  T-junctions are closed too. A textured face is remeshed on its own, so its
 *  border carries vertices its plain neighbours' edges do not: their edge a-c
 *  meets its a-b and b-c with b ON a-c. No gap, but no edge pairs either, so
 *  without this every textured body read as open and stayed hollow (measured
 *  on a hex-textured filleted box: 131 odd edges, every one a T-junction).
 *  Rasterised, a T-junction can drop or double a pixel on its line, which the
 *  cap would show as a stray dot, not the streak a real hole makes. On a real
 *  GPU that box's cut showed none in 37,653 pixels.
 *
 *  Cached per geometry: it is O(triangles) (15 ms for a 37k-triangle textured
 *  box, measured in the app), and a geometry's triangles never change after
 *  build (a rebuilt body is a new geometry). */
export function isClosedSurface(geo: THREE.BufferGeometry): boolean {
  const known = closedCache.get(geo);
  if (known !== undefined) return known;
  const closed = computeClosed(geo);
  closedCache.set(geo, closed);
  return closed;
}

function computeClosed(geo: THREE.BufferGeometry): boolean {
  const pos = geo.getAttribute("position");
  if (!pos || pos.count < 3) return false;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const box = geo.boundingBox!;
  // 2^16 weld cells along the longest side: 1.5 µm on a 100 mm part, coarse
  // enough to catch two faces' copies of a vertex that differ in the last bit,
  // fine enough never to merge real tessellation vertices. Each axis index is
  // then at most 2^16, so the three-axis key below stays an exact integer.
  const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
  const cell = span > 0 ? span / 65536 : 1;
  const R = 65537;
  const weldId = new Int32Array(pos.count);
  // one vertex standing for each welded id, to read its position back
  const rep = new Int32Array(pos.count);
  const byKey = new Map<number, number>();
  for (let v = 0; v < pos.count; v++) {
    const ix = Math.round((pos.getX(v) - box.min.x) / cell);
    const iy = Math.round((pos.getY(v) - box.min.y) / cell);
    const iz = Math.round((pos.getZ(v) - box.min.z) / cell);
    const key = (ix * R + iy) * R + iz;
    let id = byKey.get(key);
    if (id === undefined) {
      id = byKey.size;
      byKey.set(key, id);
      rep[id] = v;
    }
    weldId[v] = id;
  }
  const n = byKey.size;
  // An edge used an odd number of times so far is in the set; a second use
  // takes it out again. Closed means the set ends empty.
  const odd = new Set<number>();
  const flip = (a: number, b: number) => {
    if (a === b) return; // a sliver whose two corners welded together
    const key = a < b ? a * n + b : b * n + a;
    if (odd.has(key)) odd.delete(key);
    else odd.add(key);
  };
  const index = geo.getIndex();
  const corners = index ? index.count : pos.count;
  if (corners < 3) return false;
  for (let i = 0; i + 2 < corners; i += 3) {
    const a = weldId[index ? index.getX(i) : i]!;
    const b = weldId[index ? index.getX(i + 1) : i + 1]!;
    const c = weldId[index ? index.getX(i + 2) : i + 2]!;
    flip(a, b);
    flip(b, c);
    flip(c, a);
  }
  if (odd.size === 0) return true;
  return onlyTJunctions(odd, n, (id, out) => out.fromBufferAttribute(pos, rep[id]!), cell);
}

/** Past this many odd edges a surface is called open without looking closer:
 *  the T-junction pass below is quadratic at worst, and a texture's border is
 *  a few hundred (131 measured on a hex-textured filleted box). */
const MAX_ODD_EDGES = 20_000;

/** Whether the odd edges left by the parity pass are all T-junctions: split
 *  each one at every odd-edge vertex lying ON it, and the pieces pair up.
 *  "On it" is within two weld cells of the segment, strictly between its ends.
 *  A real hole has nothing to pair with and stays odd. */
function onlyTJunctions(
  odd: Set<number>,
  n: number,
  at: (id: number, out: THREE.Vector3) => THREE.Vector3,
  cell: number,
): boolean {
  if (odd.size > MAX_ODD_EDGES) return false;
  const edges: [number, number][] = [];
  const ids = new Set<number>();
  for (const key of odd) {
    const a = Math.floor(key / n);
    const b = key - a * n;
    edges.push([a, b]);
    ids.add(a);
    ids.add(b);
  }
  // the vertices, sorted on x so each edge only tests those in its x-range
  const verts = [...ids].map((id) => ({ id, p: at(id, new THREE.Vector3()) }));
  verts.sort((u, v) => u.p.x - v.p.x);
  const xs = verts.map((v) => v.p.x);
  const firstAtOrAbove = (x: number) => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const tol = 2 * cell;
  const left = new Set<number>();
  const flip = (a: number, b: number) => {
    const key = a < b ? a * n + b : b * n + a;
    if (left.has(key)) left.delete(key);
    else left.add(key);
  };
  const ab = new THREE.Vector3();
  const av = new THREE.Vector3();
  for (const [a, b] of edges) {
    const pa = at(a, new THREE.Vector3());
    const pb = at(b, new THREE.Vector3());
    ab.subVectors(pb, pa);
    const len2 = ab.lengthSq();
    const on: { t: number; id: number }[] = [];
    const end = firstAtOrAbove(Math.max(pa.x, pb.x) + tol);
    for (let i = firstAtOrAbove(Math.min(pa.x, pb.x) - tol); i < end; i++) {
      const v = verts[i]!;
      if (v.id === a || v.id === b) continue;
      const t = av.subVectors(v.p, pa).dot(ab) / len2;
      if (!(t > 0 && t < 1)) continue;
      if (av.addScaledVector(ab, -t).lengthSq() <= tol * tol) on.push({ t, id: v.id });
    }
    on.sort((u, v) => u.t - v.t);
    let from = a;
    for (const { id } of on) {
      flip(from, id);
      from = id;
    }
    flip(from, b);
  }
  return left.size === 0;
}

const noRaycast = () => {};
const Z = new THREE.Vector3(0, 0, 1);

/** A writer's material: its body's surface into stencil bit 0 and nowhere
 *  else, cut by `plane`. One per body, because each body's plane is nudged by
 *  its own size (WRITER_NUDGE). */
function writerMaterial(plane: THREE.Plane): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    clippingPlanes: [plane],
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilWriteMask: 1,
    stencilFail: THREE.InvertStencilOp,
    stencilZFail: THREE.InvertStencilOp,
    stencilZPass: THREE.InvertStencilOp,
  });
}

/** The caps of the current section cut. Owns everything it draws, under `root`,
 *  which is added to the scene once and never moves. Nothing here is a feature
 *  or document state: the viewport calls sync() before every frame it draws,
 *  and sync() works out what that frame needs from scratch. That is what lets
 *  the plane be moved IN PLACE by the section tool, bodies be hidden, dimmed,
 *  recoloured, rebuilt or dragged by Move, without any of them having to tell
 *  this file. */
export class SectionCaps {
  readonly root = new THREE.Object3D();
  /** What the last sync drew, for tests and diagnostics. `open` counts cut
   *  bodies left hollow because their tessellation is not closed. */
  capped = 0;
  open = 0;
  sharedMode = false;

  private entries = new Map<THREE.Mesh, CapEntry>();
  private quad = new THREE.PlaneGeometry(1, 1);
  /** the cut as the last sync saw it (the section tool moves its plane in
   *  place), so capAt answers for the frame on screen */
  private cut = new THREE.Plane();
  private capMats = new Map<THREE.ColorRepresentation, THREE.MeshBasicMaterial>();
  private sharedCap: THREE.Mesh | null = null;
  private box = new THREE.Box3();
  private union = new THREE.Box3();
  private center = new THREE.Vector3();
  private size = new THREE.Vector3();
  private probe = new THREE.Raycaster();
  private probeHits: THREE.Intersection[] = [];
  private onCut = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor() {
    this.root.name = "section-caps";
  }

  /** Bring the caps in line with `plane` and the bodies as they are right now.
   *  `colorOf(i)` is body i's own colour as the viewport shows it. A null plane
   *  (no cut, or no stencil buffer) removes every cap. */
  sync(
    plane: THREE.Plane | null,
    bodies: readonly CappableBody[],
    colorOf: (index: number) => THREE.ColorRepresentation,
    sharedColor: THREE.ColorRepresentation,
  ) {
    if (!plane) {
      this.clear();
      return;
    }
    this.cut.copy(plane);

    const cut: { body: CappableBody; index: number; box: THREE.Box3 }[] = [];
    let open = 0;
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]!;
      const mesh = body.mesh;
      // Hidden bodies have nothing to cap. A DIMMED body (the whole model goes
      // see-through while you sketch) keeps today's look: an opaque cap inside
      // a ghosted body hides the very sketch it was dimmed for.
      if (!mesh.visible || (mesh.material as THREE.Material).transparent) continue;
      const geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox || geo.boundingBox.isEmpty()) continue;
      this.box.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
      if (!plane.intersectsBox(this.box)) continue;
      if (!isClosedSurface(geo)) {
        open++;
        continue;
      }
      cut.push({ body, index: i, box: this.box.clone() });
    }

    const keep = new Set(cut.map((c) => c.body.mesh));
    for (const [mesh, e] of this.entries) {
      if (keep.has(mesh)) continue;
      this.drop(e);
      this.entries.delete(mesh);
    }

    const n = cut.length;
    const shared = n > SHARED_CAP_ABOVE;
    this.union.makeEmpty();
    cut.forEach(({ body, index, box }, k) => {
      const e = this.entries.get(body.mesh) ?? this.add(body.mesh);
      // The body's geometry, drawn where the body is drawn: matrixWorld is kept
      // current even mid-Move (setBodyMoveOffset refreshes it eagerly). Copied
      // into the writer's matrixWorld as well as its matrix, so capAt can
      // raycast the writer before the next frame would update it.
      e.writer.geometry = body.mesh.geometry;
      e.writer.matrix.copy(body.mesh.matrixWorld);
      e.writer.matrixWorld.copy(body.mesh.matrixWorld);
      e.box.copy(box);
      e.plane.copy(plane);
      e.plane.constant -= WRITER_NUDGE * box.getSize(this.size).length();
      e.writer.renderOrder = shared ? CAP_ORDER : CAP_ORDER + (2 * k) / (2 * n);
      e.cap.visible = !shared;
      if (shared) {
        this.union.union(box);
        return;
      }
      this.place(e.cap, plane, box);
      e.cap.material = this.capMaterial(colorOf(index));
      e.cap.renderOrder = CAP_ORDER + (2 * k + 1) / (2 * n);
    });

    if (shared) {
      if (!this.sharedCap) {
        this.sharedCap = this.makeCap();
        this.root.add(this.sharedCap);
      }
      this.sharedCap.visible = true;
      this.sharedCap.material = this.capMaterial(sharedColor);
      this.sharedCap.renderOrder = CAP_ORDER + 0.5;
      this.place(this.sharedCap, plane, this.union);
    } else if (this.sharedCap) {
      this.sharedCap.visible = false;
    }
    this.capped = n;
    this.open = open;
    this.sharedMode = shared;
  }

  /** Where `ray` (a pick ray from the camera) meets a cap the last sync drew:
   *  the distance along it to the cut and the body whose cap it is, or null
   *  where it crosses the cut outside every capped body. A pick has to stop
   *  there, because the cap hides everything behind it.
   *
   *  The stencil's own rule, counted on the CPU for one line: the cap shows
   *  where the body's surface crosses that line an odd number of times on the
   *  kept side of the writer's plane. */
  capAt(ray: THREE.Ray): CapHit | null {
    if (this.entries.size === 0) return null;
    const t = ray.distanceToPlane(this.cut);
    if (t === null) return null;
    const p = ray.at(t, this.onCut);
    for (const [mesh, e] of this.entries) {
      if (!e.box.containsPoint(p)) continue;
      if (this.oddOnKeptSide(e, ray)) return { distance: t, mesh };
    }
    return null;
  }

  /** Whether the line of `ray` crosses e's body an odd number of times on the
   *  kept side of e's writer plane: from where the line meets that plane, out
   *  along it into the kept side, every surface layer front or back. */
  private oddOnKeptSide(e: CapEntry, ray: THREE.Ray): boolean {
    const along = ray.direction.dot(e.plane.normal);
    if (Math.abs(along) < 1e-12) return false; // the ray runs along the cut
    this.origin.copy(ray.origin).addScaledVector(ray.direction, -e.plane.distanceToPoint(ray.origin) / along);
    this.dir.copy(ray.direction).multiplyScalar(Math.sign(along));
    this.probe.set(this.origin, this.dir);
    this.probeHits.length = 0;
    // The writer's raycast is switched off so a scene pick never lands on it;
    // the stock one, run here on purpose, sees both sides (its material is
    // DoubleSide) and uses the body's BVH (it shares the geometry).
    THREE.Mesh.prototype.raycast.call(e.writer, this.probe, this.probeHits);
    return this.probeHits.length % 2 === 1;
  }

  /** Remove every cap (the cut was cleared). Cap materials are kept for the
   *  next cut. */
  clear() {
    for (const e of this.entries.values()) this.drop(e);
    this.entries.clear();
    if (this.sharedCap) this.sharedCap.visible = false;
    this.capped = 0;
    this.open = 0;
    this.sharedMode = false;
  }

  private add(mesh: THREE.Mesh): CapEntry {
    const plane = new THREE.Plane();
    const writer = new THREE.Mesh(mesh.geometry, writerMaterial(plane));
    writer.matrixAutoUpdate = false;
    writer.raycast = noRaycast; // never picked: it is not there to be seen
    const cap = this.makeCap();
    const e = { writer, plane, cap, box: new THREE.Box3() };
    this.root.add(writer, cap);
    this.entries.set(mesh, e);
    return e;
  }

  private drop(e: CapEntry) {
    this.root.remove(e.writer, e.cap);
    (e.writer.material as THREE.Material).dispose();
  }

  private makeCap(): THREE.Mesh {
    const cap = new THREE.Mesh(this.quad);
    cap.raycast = noRaycast; // a cap is a picture of the cut, not geometry to pick
    return cap;
  }

  /** Lay a cap on the plane over `box`'s cross-section. Any point of the box is
   *  within half its diagonal of the centre, and projecting onto the plane only
   *  brings points closer, so a square of side `diagonal` centred on the
   *  projected centre covers the whole cut, whatever the plane's angle. */
  private place(cap: THREE.Mesh, plane: THREE.Plane, box: THREE.Box3) {
    plane.projectPoint(box.getCenter(this.center), cap.position);
    cap.quaternion.setFromUnitVectors(Z, plane.normal);
    const side = box.getSize(this.size).length();
    cap.scale.set(side, side, 1);
  }

  private capMaterial(color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
    let mat = this.capMats.get(color);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(CAP_SHADE),
        side: THREE.DoubleSide,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      });
      this.capMats.set(color, mat);
    }
    return mat;
  }
}
