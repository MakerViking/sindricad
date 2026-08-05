// WebSocket client to the Python geometry sidecar.
// One request/response per message, matched by `id`. Calls made before the
// socket opens are queued and flushed on connect; the socket auto-reconnects.

import type { CadDocument, EdgeFingerprint, ExportFormat, F32Wire, Feature, ImportFormat, ImportReply, PlaneSpec, ProjectedCurve, ProjectedSource, RebuildReply, RebuildResult, U32Wire } from "../types";

// The sidecar's wire-level reply envelope (see sidecar/server.py's _ok/_err):
// every call resolves to one of these two shapes; `result`'s type is per-op,
// supplied as call<T>()'s generic parameter at each call site.
interface WireError {
  message: string;
  feature_id?: string;
}
type RawReply<T> =
  | { id: string; ok: true; result: T }
  // `cancelled` marks a failure the USER caused by pressing Cancel. It stays
  // ok:false so nothing that only checks `ok` can mistake it for a result, but
  // callers can tell "you stopped it" apart from "it broke" — the difference
  // between a quiet dismissal and an error banner.
  | { id: string; ok: false; cancelled?: boolean; error: WireError };

type Pending = (msg: RawReply<unknown>) => void;
type StatusListener = (connected: boolean) => void;

/** One tessellated glyph face: an outer contour + zero or more hole contours (the
 *  counters in o/a/e), each a closed 2D polyline in final sketch coordinates. */
export type TextFace = { outer: [number, number][]; holes: [number, number][][] };

/** Per-source outcome of a projectGeometry call. `curves` carries one entry per
 *  resolved edge (a face boundary yields several); `fp` is the sidecar-authored
 *  edge fingerprint for body-edge sources — the caller wraps it into a
 *  by:"match" selector — and absent for sketch-curve sources (stable ids).
 *  `ok: false` + `error` = strict resolution refused (missing/ambiguous source). */
export interface ProjectionResult {
  source_index: number;
  ok: boolean;
  curves: { fp?: EdgeFingerprint; curve: ProjectedCurve }[];
  error?: string;
}

// One overlapping body pair from an interference check.
export interface ClashPair {
  a: string;
  b: string;
  aName: string;
  bName: string;
  volume: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

// The surface the rest of the app depends on. Both the websocket `Geometry`
// and the in-process `TauriGeometry` implement this, so callers stay agnostic
// to which backend is wired up (see VITE_GEOM in main.ts).
export interface GeometryBackend {
  rebuild(doc: CadDocument, tolerance?: number): Promise<RebuildReply>;
  /** Per-glyph 2D outlines for a sketch text entity (the sidecar owns fonts, so
   *  preview outlines come from it and match the extruded solid exactly). */
  tessellateText(entity: object, pathEntity?: object): Promise<TextFace[]>;
  /** Project 3D sources (body edges / face boundaries / cross-sketch curves)
   *  onto a sketch plane. `doc` is the timeline PREFIX for that sketch (the
   *  caller truncates). Sources are the persisted ProjectedSource shapes:
   *  pick-time edge/face sources use a by:"nearest" selector, refresh-time
   *  ones the stored by:"match" fingerprint selector, and silhouette sources
   *  carry just the body id (the whole-body HLR outline needs no selector).
   *  Strict per-source resolution; whole-call transport failure returns []. */
  projectGeometry(doc: CadDocument, plane: PlaneSpec, sources: ProjectedSource[]): Promise<ProjectionResult[]>;
  /** System font family names for the text tool's font picker. */
  listFonts(): Promise<string[]>;
  /** One-way v4 -> v5: turn a pre-container document's inline base64 BREP into
   *  blobs in the durable store, returning the content hash for each feature.
   *  Best-effort by design — the document keeps its inline copy, so a failure
   *  (or a dead sidecar) costs nothing. */
  migrateGeometry(items: { id: string; brep: string }[]): Promise<{ id: string; geom: string }[]>;
  export(
    doc: CadDocument,
    format: ExportFormat,
    path: string,
    // palette/bodyColors are only read by formats that can carry colour (GLB);
    // the others ignore them.
    opts?: {
      body?: string;
      separate?: boolean;
      palette?: { name: string; color: string; material?: string }[];
      bodyColors?: Record<string, number>;
    },
  ): Promise<{
    ok: boolean;
    path?: string;
    paths?: string[];
    message?: string;
    // features that FAILED during the export rebuild: their bodies are absent
    // from the written files (export-what-built, never silently)
    warnings?: { message: string; feature_id?: string }[];
  }>;
  // Read an external geometry file into an embeddable BREP payload (for an
  // `import` feature). Path-based: the sidecar reads the file directly.
  // `onStarted` receives the request id, so a caller that may later cancel
  // can target THIS op rather than whatever ran most recently.
  importGeometry(path: string, format: ImportFormat, onStarted?: (id: string) => void): Promise<ImportReply>;
  // Pairwise interference (clash) check among the document's bodies.
  interference(doc: CadDocument): Promise<{ ok: boolean; pairs?: ClashPair[]; message?: string }>;
  /** Colored multi-material 3MF PROJECT export (Orca format: one object per body,
   *  palette slot → extruder). Optional — only the Python sidecar authors it; the
   *  Rust spike backend omits it. Palette/bodyColors/bodyNames live in store
   *  side-maps, NOT in `document`, so they're passed explicitly here. */
  exportProject?(
    doc: CadDocument,
    path: string,
    opts: {
      palette: { name: string; color: string; material?: string }[];
      bodyColors: Record<string, number>;
      bodyNames: Record<string, string>;
      settings?: Record<string, unknown>;
    },
  ): Promise<{
    ok: boolean;
    path?: string;
    message?: string;
    warnings?: { message: string; feature_id?: string }[];
  }>;
  // Fetch the per-launch sidecar auth token from the Rust shell (Tauri) and
  // open the socket. Must be called once before any backend op; the store
  // queues into the outbox until the socket opens, so ordering is non-critical.
  init(): Promise<void>;
  onStatus(fn: StatusListener): () => void;
  /** Interim build progress: fires with the feature index the sidecar is
   *  currently building (-1 = tessellating) roughly once a second during a
   *  long rebuild. Optional — the in-process backend doesn't stream. */
  onProgress?(fn: (feature: number) => void): () => void;
  /** MCAD-style "Compute All": rebuild bypassing every cache layer. Optional. */
  computeAll?(doc: CadDocument, tolerance?: number): Promise<RebuildReply>;
  /** Stop an op in flight. `target` is the request id to cancel — pass the id
   *  the busy state owns, NOT the most recent one. Optional (the in-process
   *  backend has nothing to cancel). Resolves to whether anything stopped. */
  cancel?(target?: string): Promise<boolean>;
  /** Coarse phase progress for a long op (import). Optional. */
  onOpProgress?(fn: (pct: number, label: string) => void): () => void;
  readonly connected: boolean;
}

// --- Protocol-v2 wire shapes (see sidecar/server.py's _rebuild_job / _body_payload) ---
// One body's per-body payload: either the full mesh (positions/indices/faceIds
// etc.) or an "unchanged" stub referencing an etag the client already caches
// locally (see assemble() below). `unchanged` is the discriminant.
interface WireBodyFull {
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
  edges?: { points: [number, number, number][]; body?: string }[];
  faceCount?: number;
}
interface WireBodyStub {
  id: string;
  name: string;
  etag: string;
  nodeRef?: string;
  unchanged: true;
}
type WireBody = WireBodyFull | WireBodyStub;

// The sidecar's raw rebuild/computeAll result before local reassembly: a
// resync request, a protocol-v2 per-body result, or (defensively) the legacy
// single-mesh shape a backend could still return directly. Modeled as one flat
// shape with everything optional (rather than a discriminated union) so the ad
// hoc `?.resync` / `?.protocol` checks below type-check without narrowing first.
interface WireRebuildResult {
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
}

type RebuildBody = NonNullable<RebuildResult["bodies"]>[number];
type RebuildEdge = RebuildResult["edges"][number];

// Delta wire protocol's request payload (see rebuild()'s comment below) vs a
// full-document send.
interface RebuildDeltaPayload {
  baseRevision: number;
  revision: number;
  ops: {
    length: number;
    set: [number, Feature][];
    parameters?: CadDocument["parameters"];
    bodyVisibility?: CadDocument["bodyVisibility"];
  };
}
interface RebuildFullPayload {
  document: CadDocument;
  revision: number;
}
type RebuildPayload = RebuildDeltaPayload | RebuildFullPayload;

/** Largest message the sidecar will accept, mirroring `max_size` on
 *  `websockets.serve` in sidecar/server.py. Keep the two in step: anything past
 *  it is answered with a 1009 close rather than an error reply, so the client
 *  has to catch it BEFORE sending. */
export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

/** The user-facing message for an over-cap payload, or null when it fits.
 *  Pure and exported so the boundary can be tested without allocating a 128 MiB
 *  string. `len` is `raw.length` (UTF-16 units), which slightly UNDER-counts a
 *  document carrying non-ASCII text — acceptable because the payload is
 *  overwhelmingly base64 and ASCII JSON, and measuring UTF-8 exactly would mean
 *  copying a 100+ MiB string on every single call. */
export function tooLargeToSend(len: number): string | null {
  if (len <= MAX_MESSAGE_BYTES) return null;
  const mib = (n: number) => `${Math.round(n / (1024 * 1024))} MiB`;
  return (
    `This model is too large for the geometry engine: ${mib(len)}, ` +
    `and the limit is ${mib(MAX_MESSAGE_BYTES)}. ` +
    `Remove or simplify the imported body, then try again.`
  );
}

export class Geometry implements GeometryBackend {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private token = ""; // per-launch shared secret fetched from the Rust shell
  private pending = new Map<string, Pending>();
  // The heavy op most recently sent, for cancel() to target. The sidecar
  // serializes heavy ops, so at most one is actually running; targeting by id
  // keeps a late Cancel click from killing the NEXT op instead.
  private lastHeavyId: string | null = null;
  private outbox: string[] = [];
  private statusListeners = new Set<StatusListener>();
  private opProgressListeners = new Set<(pct: number, label: string) => void>();
  private progressListeners = new Set<(feature: number) => void>();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500; // ms; doubles on each failed attempt, capped, reset on open
  // Protocol-v2 per-body mesh cache: the sidecar answers unchanged bodies with
  // an etag stub instead of re-sending their (multi-MB) mesh; we keep the last
  // full payload per body and reassemble the merged RebuildResult locally, so
  // everything downstream (render/picking/store) sees the same shape as before.
  private bodyMesh = new Map<string, WireBodyFull>();
  // Delta wire protocol: the sidecar worker holds the last document; we send
  // {baseRevision, revision, ops} with only the CHANGED features (reference
  // inequality against the last sent feature list — effectiveDoc() reuses
  // feature objects, so an untouched feature is the same object). Any doubt
  // (worker respawn, missed reply, too many changes) falls back to a full send.
  private lastSent: { features: Feature[]; parameters: string; bodyVisibility: string } | null = null;
  private revision = 0;

  constructor(url = "ws://127.0.0.1:8765") {
    this.url = url;
    // Does NOT connect — call init() once so the per-launch auth token is
    // fetched from the Rust shell before the first socket open.
  }

  async init(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      this.token = await invoke<string>("sidecar_token");
    } catch {
      this.token = ""; // plain browser dev (no Tauri) — no sidecar anyway
    }
    this.connect();
  }

  private wsUrl(): string {
    return `${this.url}/?token=${encodeURIComponent(this.token)}`;
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.connected);
    return () => this.statusListeners.delete(fn);
  }

  /** Coarse progress for a long non-rebuild op (today: import). Phase-level
   *  only — OCCT exposes no usable sub-operation progress in this OCP build. */
  onOpProgress(fn: (pct: number, label: string) => void): () => void {
    this.opProgressListeners.add(fn);
    return () => this.opProgressListeners.delete(fn);
  }

  onProgress(fn: (feature: number) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private emitStatus() {
    for (const fn of this.statusListeners) fn(this.connected);
  }

  private connect() {
    const ws = new WebSocket(this.wsUrl());
    ws.binaryType = "arraybuffer"; // binary mesh frames (default "blob" would need async reads)
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500; // healthy connection — reset backoff
      this.emitStatus();
      for (const raw of this.outbox) ws.send(raw);
      this.outbox = [];
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        this.handleBinaryReply(e.data as ArrayBuffer);
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        console.error("[geometry] bad JSON from sidecar:", err, "payload:", String(e.data).slice(0, 200));
        return;
      }
      if (msg && typeof msg.status === "string") {
        // ANY interim status frame is informational and must NEVER resolve the
        // pending call — the real reply follows. Guarding on "building" alone
        // was a trap for the next frame type: an unrecognised status fell
        // through to the pending map and resolved the caller's promise with a
        // frame carrying no `ok`, so the caller reported failure while the
        // sidecar happily kept working for another minute.
        if (msg.status === "building") {
          const f = typeof msg.feature === "number" ? msg.feature : -1;
          for (const fn of this.progressListeners) fn(f);
        } else if (msg.status === "importing") {
          const pct = typeof msg.pct === "number" ? msg.pct : 0;
          const label = typeof msg.label === "string" ? msg.label : "";
          for (const fn of this.opProgressListeners) fn(pct, label);
        }
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    };

    ws.onclose = (ev) => {
      this.emitStatus();
      // 1009 = "message too big": the sidecar refused a frame past its max_size.
      // The pre-flight guard in call() should have caught it, so reaching here
      // means the two limits have drifted apart — say so rather than blaming the
      // connection, which is what sent GH #4's reporter looking in the wrong place.
      const tooBig = ev.code === 1009;
      const message = tooBig
        ? "That model is too large for the geometry engine to accept. "
          + "Remove or simplify the imported body, then try again."
        : "geometry engine connection lost";
      // Settle every in-flight call with a synthetic error reply shaped like a
      // real sidecar error, matching the `msg.ok === false` contract every
      // caller already checks (rebuild/export/etc). Without this, a call made
      // before the drop just hangs forever — e.g. DocumentStore.rebuildNow()'s
      // `await this.geometry.rebuild(...)` never returns, so its finally-block
      // never clears `rebuilding`, so the reconnect-triggered rebuild in
      // main.ts's onStatus() silently no-ops (rebuildNow sees rebuilding===true
      // and just sets rebuildQueued, forever).
      for (const [id, resolve] of this.pending) {
        resolve({ id, ok: false, error: { message } });
      }
      this.pending.clear();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    // back off for next time; a successful onopen resets this to the floor
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }

  /** Decode a binary mesh reply (see server.py's _encode_binary_reply for the
   *  layout: [u32 LE header_len][JSON header][pad to 4][buf0][buf1]...). The
   *  header is the normal {id, ok, result} envelope with each big mesh array
   *  replaced by {"$buf": i} into result.$buffers ({dtype, len} in wire
   *  order); buffers become TypedArray VIEWS over this frame's ArrayBuffer —
   *  zero copy, no JSON number parsing. Resolves the same pending map the
   *  JSON path does; a malformed frame is logged like a JSON parse failure. */
  private handleBinaryReply(buf: ArrayBuffer) {
    try {
      const dv = new DataView(buf);
      const headerLen = dv.getUint32(0, true);
      const header = JSON.parse(
        new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
      ) as { id: string; ok: boolean; result: WireRebuildResult & { $buffers?: { dtype: string; len: number }[] } };
      let offset = 4 + headerLen + ((4 - (headerLen % 4)) % 4);
      const views: (Float32Array | Uint32Array)[] = [];
      for (const meta of header.result.$buffers ?? []) {
        views.push(
          meta.dtype === "f32"
            ? new Float32Array(buf, offset, meta.len)
            : new Uint32Array(buf, offset, meta.len),
        );
        offset += meta.len * 4;
      }
      const resolveBuf = (v: unknown) => views[(v as { $buf: number }).$buf]!;
      for (const b of header.result.bodies ?? []) {
        if (b.unchanged) continue;
        const fb = b as WireBodyFull;
        fb.positions = resolveBuf(fb.positions) as Float32Array;
        if (fb.normals !== undefined) fb.normals = resolveBuf(fb.normals) as Float32Array;
        fb.indices = resolveBuf(fb.indices) as Uint32Array;
        fb.faceIds = resolveBuf(fb.faceIds) as Uint32Array;
      }
      delete header.result.$buffers;
      const resolve = this.pending.get(header.id);
      if (resolve) {
        this.pending.delete(header.id);
        resolve(header as RawReply<unknown>);
      }
    } catch (err) {
      // as unrecoverable as a bad JSON frame: we may not even have a valid id
      // to resolve — log and let onclose/reconnect settle the pending call
      console.error("[geometry] bad binary frame from sidecar:", err);
    }
  }

  private call<T>(op: string, extra: object, onId?: (id: string) => void): Promise<RawReply<T>> {
    const id = crypto.randomUUID();
    const raw = JSON.stringify({ id, op, ...extra });
    return new Promise((resolve) => {
      // Refuse an over-cap message rather than let the sidecar close the socket
      // on it. websockets answers anything past `max_size` with a 1009 close,
      // which took the WHOLE session down: the oversized body stays in the
      // document, so every following rebuild re-sent it and re-killed the
      // connection, and all the user got was "connection lost" (GH #4, reported
      // as "cannot open files larger than 245 MB").
      const tooLarge = tooLargeToSend(raw.length);
      if (tooLarge) {
        resolve({ id, ok: false, error: { message: tooLarge } } as RawReply<T>);
        return;
      }
      // the pending map is heterogeneous across calls with different T, so
      // storing this call's typed resolver erases to Pending here — the one
      // type-erasing cast the generic requires.
      // Recorded only once the call is actually going out: an id set before
      // the refusal above would name a request the sidecar never saw, and
      // cancelling it would silently no-op.
      if (op !== "cancel" && op !== "ping") this.lastHeavyId = id;
      onId?.(id);
      this.pending.set(id, resolve as Pending);
      if (this.connected) {
        this.ws!.send(raw);
      } else {
        this.outbox.push(raw);
      }
    });
  }

  async rebuild(doc: CadDocument, tolerance = 0.1): Promise<RebuildReply> {
    const known: Record<string, string> = {};
    for (const [id, p] of this.bodyMesh) known[id] = p.etag;

    const pJson = JSON.stringify(doc.parameters ?? null);
    const vJson = JSON.stringify(doc.bodyVisibility ?? null);
    let payload: RebuildPayload | null = null;
    if (this.lastSent) {
      const set: [number, Feature][] = [];
      for (let i = 0; i < doc.features.length; i++) {
        const f = doc.features[i];
        if (f !== undefined && this.lastSent.features[i] !== f) set.push([i, f]);
      }
      // delta only when it's actually small — a reordered/rewritten timeline
      // ships fewer bytes as a full document
      if (set.length <= Math.max(8, doc.features.length / 2)) {
        const ops: RebuildDeltaPayload["ops"] = { length: doc.features.length, set };
        if (pJson !== this.lastSent.parameters) ops.parameters = doc.parameters;
        if (vJson !== this.lastSent.bodyVisibility) ops.bodyVisibility = doc.bodyVisibility;
        payload = { baseRevision: this.revision, revision: this.revision + 1, ops };
      }
    }
    if (!payload) payload = { document: doc, revision: this.revision + 1 };

    let msg = await this.call<WireRebuildResult>("rebuild", { ...payload, tolerance, known, binary: true });
    if (msg.ok && msg.result?.resync) {
      // worker respawned or lost sync — one full resend recovers everything
      this.lastSent = null;
      this.bodyMesh.clear();
      payload = { document: doc, revision: this.revision + 1 };
      msg = await this.call<WireRebuildResult>("rebuild", { ...payload, tolerance, binary: true });
    }
    if (msg.ok && !msg.result?.resync) {
      this.revision = payload.revision;
      this.lastSent = { features: doc.features.slice(), parameters: pJson, bodyVisibility: vJson };
    }
    if (msg.ok && msg.result?.protocol === 2) {
      let assembled = this.assemble(msg.result);
      if (assembled === null) {
        // we claimed an etag the cache no longer backs (e.g. page kept state
        // across a worker respawn race) — resync with a full request
        this.bodyMesh.clear();
        msg = await this.call<WireRebuildResult>("rebuild", { document: doc, revision: ++this.revision, tolerance, binary: true });
        if (msg.ok && msg.result?.protocol === 2) assembled = this.assemble(msg.result);
      }
      if (msg.ok && assembled !== null) return { ok: true, result: assembled };
    }
    if (msg.ok) {
      const legacy = this.legacyResult(msg.result);
      if (legacy) return { ok: true, result: legacy };
      return { ok: false, error: { message: "geometry engine returned no mesh" } };
    }
    return { ok: false, error: msg.error };
  }

  /** MCAD-style "Compute All": bypass and rebuild every cache layer (RAM,
   *  mesh, disk checkpoints) server-side, and drop our own mesh cache. */
  async computeAll(doc: CadDocument, tolerance = 0.1): Promise<RebuildReply> {
    this.bodyMesh.clear();
    this.lastSent = null;
    const msg = await this.call<WireRebuildResult>("computeAll", { document: doc, revision: ++this.revision, tolerance, binary: true });
    if (msg.ok && msg.result?.protocol === 2) {
      const assembled = this.assemble(msg.result);
      if (assembled !== null) return { ok: true, result: assembled };
    }
    if (msg.ok) {
      const legacy = this.legacyResult(msg.result);
      if (legacy) return { ok: true, result: legacy };
      return { ok: false, error: { message: "geometry engine returned no mesh" } };
    }
    return { ok: false, error: msg.error };
  }

  /** Merge protocol-v2 per-body payloads into the legacy RebuildResult shape.
   *  Returns null if an "unchanged" stub references a body we don't hold. */
  private assemble(r: WireRebuildResult): RebuildResult | null {
    const bodies: WireBody[] = r.bodies ?? [];
    const live = new Set<string>();
    // first pass: resolve payloads + prune. Each entry keeps the wire item
    // (`nb`) alongside the mesh (`p`), because for an "unchanged" stub the mesh
    // is the CACHED one, whose id/name/nodeRef are whatever they were when the
    // geometry last changed. Identity must come from the envelope. `name` was
    // already read from the wrong side; it only looked right because a rename
    // happens to change the etag and so never arrives as a stub.
    const items: { p: WireBodyFull; nb: WireBody }[] = [];
    for (const nb of bodies) {
      live.add(nb.id);
      let p: WireBodyFull;
      if (nb.unchanged) {
        const cached = this.bodyMesh.get(nb.id);
        if (!cached || cached.etag !== nb.etag) return null; // stub we can't back — resync
        p = cached;
      } else {
        p = nb;
        this.bodyMesh.set(nb.id, nb);
      }
      items.push({ p, nb });
    }
    for (const id of this.bodyMesh.keys()) if (!live.has(id)) this.bodyMesh.delete(id);

    // second pass: preallocated typed arrays (total sizes are known), filled
    // with .set() for the float arrays — accepts number[] AND typed-array
    // sources alike, so mixed cached-stub/JSON-fallback bodies need no branch.
    // Replaces the old per-element push loops (~1M elements on big documents).
    // NOTE the two different arities: `indices` is 3 entries per triangle,
    // `faceIds` is ONE. They must be sized and cursored separately — conflating
    // them scatters body N>1's faceIds past the end of the triangle range,
    // which renders every body after the first as edges with no surface.
    let totalVerts3 = 0;
    let totalIdx = 0;
    let totalTris = 0;
    for (const { p } of items) {
      totalVerts3 += p.positions.length;
      totalIdx += p.indices.length;
      totalTris += p.faceIds.length;
    }
    // sidecar sends explicit normals only for textured bodies; bodies without
    // keep their zero-initialized slice, and render.ts falls back to
    // computeVertexNormals for an all-zero slice.
    const anyNormals = items.some(({ p }) => p.normals !== undefined);
    const positions = new Float32Array(totalVerts3);
    const normals = anyNormals ? new Float32Array(totalVerts3) : undefined;
    const indices = new Uint32Array(totalIdx);
    const faceIds = new Uint32Array(totalTris);
    const edges: RebuildEdge[] = [];
    const meta: RebuildBody[] = [];
    let faceBase = 0;
    let ek = 0;
    let vOff = 0;
    let iOff = 0;
    let tOff = 0;
    for (const { p, nb } of items) {
      const vbase = vOff / 3;
      positions.set(p.positions, vOff);
      if (normals && p.normals !== undefined) normals.set(p.normals, vOff);
      vOff += p.positions.length;
      // indices/faceIds need per-element offsets — indexed reads work on both
      // union members, and writes into a preallocated Uint32Array are cheap
      const pi = p.indices, pf = p.faceIds;
      for (let k = 0; k < pi.length; k++) indices[iOff + k] = (pi[k] as number) + vbase;
      for (let k = 0; k < pf.length; k++) faceIds[tOff + k] = (pf[k] as number) + faceBase;
      iOff += pi.length;
      tOff += pf.length;
      for (const e of p.edges ?? []) edges.push({ id: `e${ek++}`, points: e.points, ...(e.body !== undefined ? { body: e.body } : {}) });
      meta.push({
        // identity from the envelope, geometry from the payload
        id: nb.id, name: nb.name, faceStart: faceBase,
        faceCount: p.faceCount ?? 0,
        ...(p.faceOwners !== undefined ? { faceOwners: p.faceOwners } : {}),
        ...(p.textureColorSlots !== undefined ? { textureColorSlots: p.textureColorSlots } : {}),
        ...(nb.etag !== undefined ? { etag: nb.etag } : {}),
        ...(nb.nodeRef !== undefined ? { nodeRef: nb.nodeRef } : {}),
      });
      faceBase += p.faceCount ?? 0;
    }
    const out: RebuildResult = {
      mesh: { positions, indices, faceIds, ...(normals ? { normals } : {}) },
      edges,
      // the wire can supply `bbox: null` when nothing has built yet (no
      // bodies); preserved as-is — RebuildResult models bbox as always-present.
      bbox: r.bbox as RebuildResult["bbox"],
      bodies: meta,
    };
    if (r.diagnostics) out.diagnostics = r.diagnostics;
    if (r.featureError) out.featureError = r.featureError;
    if (r.featureErrors) out.featureErrors = r.featureErrors;
    if (r.projectionUpdates) out.projectionUpdates = r.projectionUpdates;
    return out;
  }

  /** Build the legacy single-mesh RebuildResult from a protocol-v1 reply (no
   *  per-body payload — mesh/edges inline). Returns null if the reply carries no
   *  direct mesh, so the caller can route it to its error path rather than
   *  fabricating an empty result. */
  private legacyResult(r: WireRebuildResult): RebuildResult | null {
    if (!r.mesh || !r.edges) return null;
    const out: RebuildResult = {
      mesh: r.mesh,
      edges: r.edges,
      // the wire can supply `bbox: null` when nothing has built yet (no bodies);
      // preserved as-is — RebuildResult models bbox as always-present.
      bbox: r.bbox as RebuildResult["bbox"],
    };
    if (r.diagnostics) out.diagnostics = r.diagnostics;
    if (r.featureError) out.featureError = r.featureError;
    if (r.featureErrors) out.featureErrors = r.featureErrors;
    if (r.projectionUpdates) out.projectionUpdates = r.projectionUpdates;
    return out;
  }

  async export(
    doc: CadDocument,
    format: ExportFormat,
    path: string,
    opts: {
      body?: string;
      separate?: boolean;
      palette?: { name: string; color: string; material?: string }[];
      bodyColors?: Record<string, number>;
    } = {},
  ): Promise<{ ok: boolean; path?: string; paths?: string[]; message?: string; warnings?: { message: string; feature_id?: string }[] }> {
    const msg = await this.call<{ path?: string; paths?: string[]; warnings?: { message: string; feature_id?: string }[] }>(
      "export",
      {
        document: doc, format, path, body: opts.body, separate: opts.separate,
        // GLB writes one material per body from these; the sidecar defaults both
        // to empty, so other formats are unaffected by sending them.
        palette: opts.palette, bodyColors: opts.bodyColors,
      },
    );
    if (msg.ok) {
      const r = msg.result;
      return {
        ok: true,
        ...(r.path !== undefined ? { path: r.path } : {}),
        ...(r.paths !== undefined ? { paths: r.paths } : {}),
        ...(r.warnings !== undefined ? { warnings: r.warnings } : {}),
      };
    }
    return { ok: false, message: msg.error?.message };
  }

  async exportProject(
    doc: CadDocument,
    path: string,
    opts: {
      palette: { name: string; color: string; material?: string }[];
      bodyColors: Record<string, number>;
      bodyNames: Record<string, string>;
      settings?: Record<string, unknown>;
    },
  ): Promise<{ ok: boolean; path?: string; message?: string; warnings?: { message: string; feature_id?: string }[] }> {
    const msg = await this.call<{ path?: string; warnings?: { message: string; feature_id?: string }[] }>("exportProject", {
      document: doc,
      path,
      palette: opts.palette,
      bodyColors: opts.bodyColors,
      bodyNames: opts.bodyNames,
      settings: opts.settings ?? {},
    });
    if (msg.ok) {
      const r = msg.result;
      return {
        ok: true,
        ...(r.path !== undefined ? { path: r.path } : {}),
        ...(r.warnings !== undefined ? { warnings: r.warnings } : {}),
      };
    }
    return { ok: false, message: msg.error?.message };
  }

  async importGeometry(path: string, format: ImportFormat, onStarted?: (id: string) => void): Promise<ImportReply> {
    const msg = await this.call<{
      geom: string; name: string; solid: boolean; faces: number; color?: string;
      nodes?: { name: string; parent: number | null; color?: string }[];
      parts?: { node: number; faces: number }[];
    }>("import", { path, format }, onStarted);
    if (msg.ok) {
      const r = msg.result;
      return {
        ok: true, geom: r.geom, name: r.name, solid: r.solid, faces: r.faces,
        ...(r.color !== undefined ? { color: r.color } : {}),
        ...(r.nodes !== undefined ? { nodes: r.nodes } : {}),
        ...(r.parts !== undefined ? { parts: r.parts } : {}),
      };
    }
    if (!msg.ok && msg.cancelled) return { ok: false, cancelled: true, message: "import cancelled" };
    return { ok: false, message: msg.error?.message ?? "import failed" };
  }

  /** Stop the geometry op in flight. Answered on the sidecar's READ path, so it
   *  is heard DURING a long job rather than queued behind it — that is the whole
   *  reason it exists. Resolves to whether anything was actually stopped; the
   *  cancelled op settles separately, with `cancelled: true` on its own reply.
   *
   *  A pool job cannot be interrupted, so the sidecar kills the worker and
   *  brings up a fresh one. Geometry keeps working; the next call pays a pool
   *  respawn. */
  async cancel(target?: string): Promise<boolean> {
    // ALWAYS prefer an explicit target. The document stays editable during a
    // long import, so any rebuild the user triggers meanwhile overwrites
    // lastHeavyId — and the sidecar, which matches the running id against the
    // target, would then refuse to cancel the very import the user is waiting
    // on. lastHeavyId is only a fallback for callers that never learned an id.
    const id = target ?? this.lastHeavyId;
    if (!id) return false;
    const msg = await this.call<{ cancelled: boolean }>("cancel", { target: id });
    return msg.ok ? msg.result.cancelled : false;
  }

  async interference(doc: CadDocument): Promise<{ ok: boolean; pairs?: ClashPair[]; message?: string }> {
    const msg = await this.call<{ pairs?: ClashPair[] }>("interference", { document: doc });
    if (msg.ok) {
      const r = msg.result;
      return { ok: true, ...(r.pairs !== undefined ? { pairs: r.pairs } : {}) };
    }
    return { ok: false, message: msg.error?.message };
  }

  async tessellateText(entity: object, pathEntity?: object): Promise<TextFace[]> {
    const msg = await this.call<{ faces: TextFace[] }>("tessellateText", {
      entity,
      ...(pathEntity ? { pathEntity } : {}),
    });
    return msg.ok ? (msg.result.faces ?? []) : [];
  }

  async projectGeometry(doc: CadDocument, plane: PlaneSpec, sources: ProjectedSource[]): Promise<ProjectionResult[]> {
    const msg = await this.call<{ results: ProjectionResult[] }>("projectGeometry", {
      document: doc,
      plane,
      sources,
    });
    return msg.ok ? (msg.result.results ?? []) : [];
  }

  async listFonts(): Promise<string[]> {
    const msg = await this.call<{ families: string[] }>("listFonts", {});
    return msg.ok ? (msg.result.families ?? []) : [];
  }

  async migrateGeometry(
    items: { id: string; brep: string }[],
  ): Promise<{ id: string; geom: string }[]> {
    if (!items.length) return [];
    const msg = await this.call<{
      items: { id: string; geom: string }[];
      failed?: { id: string; message: string }[];
    }>("migrateGeometry", { items });
    if (!msg.ok) return []; // keep the inline copy; nothing is lost
    for (const f of msg.result.failed ?? []) {
      console.warn(`could not migrate geometry for ${f.id}: ${f.message}`);
    }
    return msg.result.items ?? [];
  }
}
