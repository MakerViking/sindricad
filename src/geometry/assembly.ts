// Assembling one rebuild reply's per-body payloads into the single flat
// RebuildResult the rest of the app consumes.
//
// Split out of client.ts because a CHUNKED reply (sidecar/server.py's
// _stream_binary_reply) needs the same arithmetic applied incrementally: the
// head frame's manifest names every body up front, so every array offset and
// every body's global faceStart can be planned BEFORE any payload arrives.
// Planning up front is what makes chunk writes order-independent and provably
// identical to the single-shot path — the plan is the same cumulative walk the
// old single pass did, just hoisted out of the copy loop.

import type { F32Wire, RebuildResult, U32Wire } from "../types";

// --- Protocol-v2 wire shapes (see sidecar/server.py's _rebuild_job / _body_payload) ---
// One body's per-body payload: either the full mesh (positions/indices/faceIds
// etc.) or an "unchanged" stub referencing an etag the client already caches
// locally. `unchanged` is the discriminant.
export interface WireBodyFull {
  id: string;
  name: string;
  etag: string;
  unchanged?: false;
  /** "<importFeatureId>/<nodeIndex>" for a body from an imported assembly tree. */
  nodeRef?: string;
  positions: F32Wire;
  indices: U32Wire;
  faceIds: U32Wire;
  // present only for a body with texture features: analytic displaced normals
  // (plain faces carry the same accumulation the client would compute)
  normals?: F32Wire;
  faceOwners?: (string | null)[];
  textureColorSlots?: (number | null)[];
  edges?: WireEdgeList;
  faceCount?: number;
}

export interface WireBodyStub {
  id: string;
  name: string;
  etag: string;
  nodeRef?: string;
  unchanged: true;
}
export type WireBody = WireBodyFull | WireBodyStub;

/** Edge polylines, the form every consumer sees. The binary reply carries them
 *  packed instead; decodeBinaryFrame expands them before the body reaches
 *  anything else, so this stays the single downstream contract. */
export type WireEdgeList = { points: [number, number, number][]; body?: string }[];

// The sidecar's raw rebuild/computeAll result before local reassembly: a
// resync request, a protocol-v2 per-body result, or (defensively) the legacy
// single-mesh shape a backend could still return directly. Modeled as one flat
// shape with everything optional (rather than a discriminated union) so the ad
// hoc `?.resync` / `?.protocol` checks type-check without narrowing first.
export interface WireRebuildResult {
  resync?: true;
  protocol?: 2;
  bodies?: WireBody[];
  bbox?: { min: number[]; max: number[] } | null;
  diagnostics?: RebuildResult["diagnostics"];
  featureError?: RebuildResult["featureError"];
  featureErrors?: RebuildResult["featureErrors"];
  // projection refresh entries ride the top-level header as plain JSON (never
  // inside per-body payloads, so "unchanged" stubs can't drop them)
  projectionUpdates?: RebuildResult["projectionUpdates"];
  // legacy direct-mesh shape (only when `protocol` is absent)
  mesh?: RebuildResult["mesh"];
  edges?: RebuildResult["edges"];
  /** Set only by the CHUNKED path, which assembles as frames arrive rather than
   *  at the end. Carries the finished result straight through so assemble() does
   *  not redo work that is already done. */
  assembled?: RebuildResult;
}

/** One row of a chunked reply's manifest (server.py's _manifest_entry): every
 *  body of the reply, in final order, in the head frame.
 *
 *  Sizes are absent on stubs BY DESIGN — the sidecar does not have them,
 *  because those arrays live in this client's own per-body cache. That is not a
 *  gap: resolving a stub against the cache is something begin() has to do
 *  anyway, to decide whether it can still back that etag at all. */
export interface WireManifestEntry {
  id: string;
  name: string;
  etag: string;
  nodeRef?: string;
  unchanged?: true;
  faceCount?: number;
  nVerts3?: number;
  nIdx?: number;
  nTris?: number;
  nEdges?: number;
  hasNormals?: true;
}

type RebuildBody = NonNullable<RebuildResult["bodies"]>[number];

/** Where one body's data goes in the flat arrays. Every field is derived from
 *  the manifest before a single byte is copied, so a body can be written the
 *  moment it arrives, in any order. */
interface BodyPlan {
  id: string;
  vOff: number;      // into positions/normals
  nVerts3: number;
  iOff: number;      // into indices
  nIdx: number;
  tOff: number;      // into faceIds
  nTris: number;
  faceBase: number;  // this body's global faceId offset (== meta.faceStart)
  faceCount: number;
  edgeBase: number;
  nEdges: number;
}

/** Build manifest entries from a non-chunked reply's own bodies, so the single
 *  frame path and the chunked path run the same code. Sizes come off the
 *  payloads that are already in hand; stubs get none, exactly as the sidecar
 *  would have sent them. */
export function manifestFromBodies(bodies: WireBody[]): WireManifestEntry[] {
  return bodies.map((b) => {
    const e: WireManifestEntry = { id: b.id, name: b.name, etag: b.etag };
    if (b.nodeRef !== undefined) e.nodeRef = b.nodeRef;
    if (b.unchanged) {
      e.unchanged = true;
      return e;
    }
    e.faceCount = b.faceCount ?? 0;
    e.nVerts3 = b.positions.length;
    e.nIdx = b.indices.length;
    e.nTris = b.faceIds.length;
    e.nEdges = b.edges?.length ?? 0;
    if (b.normals !== undefined) e.hasNormals = true;
    return e;
  });
}

export type BeginOutcome =
  /** A stub referenced an etag we no longer hold — the caller must resync with
   *  one full request. Deliberately decided BEFORE any array is allocated. */
  | { kind: "resync" }
  /** Nothing changed: the previous result, BY REFERENCE. */
  | { kind: "noop"; result: RebuildResult }
  | { kind: "stream"; assembly: RebuildAssembly };

export class RebuildAssembly {
  /** The result being filled. Its arrays are allocated at full size up front,
   *  so a body that has arrived can be read out of them immediately — but the
   *  regions of bodies that have NOT arrived are still zeros. Anything reading
   *  this before complete() must restrict itself to written bodies. */
  readonly result: RebuildResult;
  readonly plan: BodyPlan[];
  readonly sig: string | null;
  // The concrete typed arrays behind result.mesh. RebuildResult declares those
  // fields as the looser F32Wire/U32Wire (a backend may hand back plain
  // arrays), but the ones allocated here are always typed — held separately so
  // the copy path can use .set() without casting on every write.
  private readonly positions: Float32Array;
  private readonly normals: Float32Array | undefined;
  private readonly indices: Uint32Array;
  private readonly faceIds: Uint32Array;
  private readonly index = new Map<string, number>();
  private readonly written: boolean[];
  private left: number;

  private constructor(
    result: RebuildResult,
    arrays: { positions: Float32Array; normals?: Float32Array; indices: Uint32Array; faceIds: Uint32Array },
    plan: BodyPlan[],
    sig: string | null,
  ) {
    this.result = result;
    this.positions = arrays.positions;
    this.normals = arrays.normals;
    this.indices = arrays.indices;
    this.faceIds = arrays.faceIds;
    this.plan = plan;
    this.sig = sig;
    plan.forEach((p, i) => this.index.set(p.id, i));
    this.written = new Array(plan.length).fill(false);
    this.left = plan.length;
  }

  static begin(
    head: WireRebuildResult,
    manifest: WireManifestEntry[],
    cache: Map<string, WireBodyFull>,
    lastAssembled: RebuildResult | null,
    lastSig: string | null,
  ): BeginOutcome {
    // Resolve every entry FIRST. A stub whose etag the cache cannot back means
    // the whole reply is unusable, and finding that out here — before any
    // allocation and, for a chunked reply, before any partial display — makes
    // a resync cost one round trip and nothing else.
    const sizes: WireManifestEntry[] = [];
    for (const m of manifest) {
      if (!m.unchanged) { sizes.push(m); continue; }
      const cached = cache.get(m.id);
      if (!cached || cached.etag !== m.etag) return { kind: "resync" };
      sizes.push({
        ...m,
        faceCount: cached.faceCount ?? 0,
        nVerts3: cached.positions.length,
        nIdx: cached.indices.length,
        nTris: cached.faceIds.length,
        nEdges: cached.edges?.length ?? 0,
        ...(cached.normals !== undefined ? { hasNormals: true as const } : {}),
      });
    }

    // NO-OP FAST PATH, decidable from the manifest alone. When every body
    // arrived as an `unchanged` stub and the id/etag/order/bbox signature
    // matches the previous reply, the arrays below are provably identical to
    // the ones built last time. Rebuilding them allocated ~98 MiB of fresh
    // typed arrays and cost 0.171 s on EVERY rebuild, including ones that
    // changed nothing at all.
    //
    // Returning the previous object BY REFERENCE (not a copy) is deliberate:
    // the viewport's setModel keys its own visibility-only fast path on result
    // identity, so this is what lets a no-op rebuild skip the scene rebuild
    // too. The signature includes the non-geometry extras precisely because
    // they CAN change while geometry does not — a new diagnostic or
    // featureError must still produce a fresh object.
    const sig = manifest.length === 0 ? null : JSON.stringify([
      sizes.map((m) => [m.id, m.etag, m.name, m.nodeRef, m.faceCount]),
      head.bbox,
      head.diagnostics, head.featureError, head.featureErrors, head.projectionUpdates,
    ]);
    if (
      sig !== null && sig === lastSig && lastAssembled !== null
      && manifest.every((m) => m.unchanged)
    ) {
      return { kind: "noop", result: lastAssembled };
    }

    // Plan every offset in one cumulative walk — the same arithmetic the old
    // single copy loop did inline, which is what keeps faceStart and the global
    // faceId rebasing byte-identical to the single-shot path.
    const plan: BodyPlan[] = [];
    let vOff = 0, iOff = 0, tOff = 0, faceBase = 0, edgeBase = 0;
    for (const m of sizes) {
      const nVerts3 = m.nVerts3 ?? 0, nIdx = m.nIdx ?? 0, nTris = m.nTris ?? 0;
      const faceCount = m.faceCount ?? 0, nEdges = m.nEdges ?? 0;
      plan.push({ id: m.id, vOff, nVerts3, iOff, nIdx, tOff, nTris, faceBase, faceCount, edgeBase, nEdges });
      vOff += nVerts3; iOff += nIdx; tOff += nTris; faceBase += faceCount; edgeBase += nEdges;
    }

    // sidecar sends explicit normals only for textured bodies; bodies without
    // keep their zero-initialized slice, and render.ts falls back to
    // computeVertexNormals for an all-zero slice.
    const anyNormals = sizes.some((m) => m.hasNormals);
    const arrays = {
      positions: new Float32Array(vOff),
      indices: new Uint32Array(iOff),
      faceIds: new Uint32Array(tOff),
      ...(anyNormals ? { normals: new Float32Array(vOff) } : {}),
    };
    const mesh: RebuildResult["mesh"] = { ...arrays };
    const meta: RebuildBody[] = sizes.map((m, i) => ({
      // identity from the ENVELOPE, geometry from the payload: for an
      // "unchanged" stub the cached mesh's id/name/nodeRef are whatever they
      // were when the geometry last changed. `name` was already read from the
      // wrong side once; it only looked right because a rename happens to
      // change the etag and so never arrives as a stub.
      id: m.id, name: m.name,
      faceStart: plan[i]!.faceBase, faceCount: m.faceCount ?? 0,
      ...(m.etag !== undefined ? { etag: m.etag } : {}),
      ...(m.nodeRef !== undefined ? { nodeRef: m.nodeRef } : {}),
    }));
    const out: RebuildResult = {
      mesh,
      edges: new Array(edgeBase),
      // the wire can supply `bbox: null` when nothing has built yet (no
      // bodies); preserved as-is — RebuildResult models bbox as always-present.
      bbox: head.bbox as RebuildResult["bbox"],
      bodies: meta,
    };
    if (head.diagnostics) out.diagnostics = head.diagnostics;
    if (head.featureError) out.featureError = head.featureError;
    if (head.featureErrors) out.featureErrors = head.featureErrors;
    if (head.projectionUpdates) out.projectionUpdates = head.projectionUpdates;

    const asm = new RebuildAssembly(out, arrays, plan, sig);
    // Stubs are backed by the cache, so they can be filled right now; only full
    // payloads have to wait for their chunk.
    for (const m of manifest) {
      if (m.unchanged) asm.writeBody(cache.get(m.id)!);
    }
    return { kind: "stream", assembly: asm };
  }

  /** Copy one body's payload into its planned slice. Returns false if the
   *  payload disagrees with what the manifest promised.
   *
   *  That check is load-bearing, not defensive: an over-long payload would
   *  otherwise run past its slice and overwrite the NEXT body's triangles,
   *  producing a model that is wrong but entirely believable. A false return
   *  must fail the whole rebuild, never render. */
  writeBody(p: WireBodyFull): boolean {
    const i = this.index.get(p.id);
    if (i === undefined) return false;
    const q = this.plan[i]!;
    if (
      p.positions.length !== q.nVerts3 || p.indices.length !== q.nIdx
      || p.faceIds.length !== q.nTris || (p.edges?.length ?? 0) !== q.nEdges
    ) return false;

    const { edges, bodies } = this.result;
    this.positions.set(p.positions as ArrayLike<number>, q.vOff);
    if (this.normals && p.normals !== undefined) {
      this.normals.set(p.normals as ArrayLike<number>, q.vOff);
    }
    // indices/faceIds need per-element offsets — indexed reads work on both
    // union members, and writes into a preallocated Uint32Array are cheap.
    // NOTE the two different arities: `indices` is 3 entries per triangle,
    // `faceIds` is ONE. Conflating them scatters body N>1's faceIds past the
    // end of the triangle range, which renders every body after the first as
    // edges with no surface.
    const vbase = q.vOff / 3;
    const pi = p.indices, pf = p.faceIds;
    for (let k = 0; k < pi.length; k++) this.indices[q.iOff + k] = (pi[k] as number) + vbase;
    for (let k = 0; k < pf.length; k++) this.faceIds[q.tOff + k] = (pf[k] as number) + q.faceBase;
    const pe = p.edges ?? [];
    for (let k = 0; k < pe.length; k++) {
      const e = pe[k]!;
      edges[q.edgeBase + k] = {
        id: `e${q.edgeBase + k}`, points: e.points,
        ...(e.body !== undefined ? { body: e.body } : {}),
      };
    }
    // geometry-side metadata only reachable from the payload
    const m = bodies![i]!;
    if (p.faceOwners !== undefined) m.faceOwners = p.faceOwners;
    if (p.textureColorSlots !== undefined) m.textureColorSlots = p.textureColorSlots;

    if (!this.written[i]) { this.written[i] = true; this.left--; }
    return true;
  }

  /** True once this body's slice holds real data. */
  has(id: string): boolean {
    const i = this.index.get(id);
    return i !== undefined && this.written[i]!;
  }

  /** The half-open TRIANGLE range covering the given bodies, for a ranged
   *  partitionMesh. Triangle indices, not face ids: a consumer reading the
   *  in-progress arrays must restrict its scan to what has actually been
   *  written, because the rest is still zeros and zero is a valid faceId. */
  triRange(ids: string[]): { triStart: number; triEnd: number } {
    let triStart = Infinity;
    let triEnd = 0;
    for (const id of ids) {
      const i = this.index.get(id);
      if (i === undefined) continue;
      const q = this.plan[i]!;
      triStart = Math.min(triStart, q.tOff);
      triEnd = Math.max(triEnd, q.tOff + q.nTris);
    }
    return { triStart: Number.isFinite(triStart) ? triStart : 0, triEnd };
  }

  /** One body's slice of the flat edge array. */
  edgesOf(id: string): RebuildResult["edges"] {
    const i = this.index.get(id);
    if (i === undefined) return [];
    const q = this.plan[i]!;
    return this.result.edges.slice(q.edgeBase, q.edgeBase + q.nEdges);
  }

  /** The metadata entry for one body (id/name/faceStart/faceCount/etag). */
  metaOf(id: string): RebuildBody | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.result.bodies![i];
  }

  get remaining(): number { return this.left; }

  /** The finished result, or null if any body is still missing. Returning a
   *  partially-filled result would hand on zeroed slices, which render as
   *  plausible-looking degenerate geometry rather than as an error. */
  complete(): RebuildResult | null {
    return this.left === 0 ? this.result : null;
  }
}
