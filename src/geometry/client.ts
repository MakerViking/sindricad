// WebSocket client to the Python geometry sidecar.
// One request/response per message, matched by `id`. Calls made before the
// socket opens are queued and flushed on connect; the socket auto-reconnects.

import type { CadDocument, EdgeFingerprint, ExportFormat, F32Wire, Feature, GeomErrorCode, ImportFormat, ImportReply, MassPropertiesResult, PlaneSpec, ProjectedCurve, ProjectedSource, RebuildReply, RebuildResult, U32Wire } from "../types";
import { RebuildAssembly, manifestFromBodies } from "./assembly";
import type {
  WireBody, WireBodyFull, WireEdgeList, WireManifestEntry, WireRebuildResult,
} from "./assembly";

// The sidecar's wire-level reply envelope (see sidecar/server.py's _ok/_err):
// every call resolves to one of these two shapes; `result`'s type is per-op,
// supplied as call<T>()'s generic parameter at each call site.
interface WireError {
  message: string;
  feature_id?: string;
  /** Machine-readable classification (sidecar/errors.py). Optional: an older
   *  sidecar omits it, and an unrecognised value is expected to degrade to
   *  "unclassified" rather than break. */
  code?: GeomErrorCode;
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
    // Same contract as importGeometry's: hands back the request id so a Cancel
    // targets THIS export rather than whatever ran most recently. The document
    // stays editable while an export runs, so "most recent" is not this one.
    onStarted?: (id: string) => void,
  ): Promise<{
    ok: boolean;
    path?: string;
    paths?: string[];
    message?: string;
    // the user stopped it — distinct from a failure, so the caller can stay
    // silent instead of reporting their own action back to them as an error
    cancelled?: boolean;
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
  /** Exact kernel mass properties per body plus a document total. OPTIONAL, and
   *  deliberately so: the in-process Rust backend does not implement it, and an
   *  optional member lets a caller guard the call instead of forcing a stub that
   *  always fails. `checks` adds validity and watertightness, which cost far more
   *  than everything else combined — leave it off unless something reads them.
   *
   *  `doc` must be the BUILT document (store.buildDocument()), never the raw one:
   *  body ids are positional per rebuild, so measuring the wrong feature list
   *  returns exact-looking numbers for the wrong body. */
  massProperties?(
    doc: CadDocument,
    opts?: { bodies?: string[]; checks?: boolean },
    onStarted?: (id: string) => void,
  ): Promise<{ ok: boolean; result?: MassPropertiesResult; message?: string }>;
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
    onStarted?: (id: string) => void,
  ): Promise<{
    ok: boolean;
    path?: string;
    message?: string;
    cancelled?: boolean;
    warnings?: { message: string; feature_id?: string }[];
  }>;
  // Fetch the per-launch sidecar auth token from the Rust shell (Tauri) and
  // open the socket. Must be called once before any backend op; the store
  // queues into the outbox until the socket opens, so ordering is non-critical.
  init(): Promise<void>;
  onStatus(fn: StatusListener): () => void;
  /** Interim build progress: fires with the feature index the sidecar is
   *  currently building (-1 = tessellating) roughly once a second during a
   *  long rebuild. Optional — the in-process backend doesn't stream.
   *
   *  `meshed`/`meshTotal` are -1 except during the payload (meshing) phase,
   *  where they carry its real per-body denominator. Without them the phase
   *  reported only feature=-1, which the timeline rendered as a bar pinned at
   *  0% for its whole duration — 136 s of it on the reference assembly. */
  onProgress?(fn: (feature: number, meshed: number, meshTotal: number) => void): () => void;
  /** Installments of a chunked rebuild reply, for progressive display. Optional:
   *  the in-process backend answers in one piece and never streams. */
  onRebuildChunk?(fn: (c: RebuildChunk) => void): () => void;
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

/** Edge polylines packed into binary buffers (see server.py's _pack_edges):
 *  every point triple flattened, plus a per-edge POINT count to re-split them.
 *  Exists only between reading a binary frame and expanding it. */
interface WireEdgesPacked {
  $pts: F32Wire;
  $counts: U32Wire;
  body?: string;
}

/** Re-split a packed edge buffer into the per-edge point triples every consumer
 *  expects. `counts` holds each edge's POINT count; `pts` is every triple of
 *  every edge, flattened, in the same order.
 *
 *  Exported for its own test: this is the client half of the wire change that
 *  keeps a large assembly's reply under the frame cap, and the sidecar-side
 *  test can only prove the encoder. */
export function expandPackedEdges(
  pts: Float32Array,
  counts: Uint32Array,
  body: string | undefined,
): WireEdgeList {
  const list: WireEdgeList = [];
  let o = 0;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i]!;
    const points: [number, number, number][] = new Array(n) as [number, number, number][];
    for (let k = 0; k < n; k++, o += 3) points[k] = [pts[o]!, pts[o + 1]!, pts[o + 2]!];
    list.push(body !== undefined ? { points, body } : { points });
  }
  return list;
}


/** The framing envelope a chunked reply adds. Non-final frames carry
 *  `status: "chunk"` and no `ok`, so a peer that does not understand them
 *  treats them as informational rather than as the reply. */
interface WireStreamEnvelope {
  sid: string;
  seq: number;
  final: boolean;
}

/** A decoded binary frame: the JSON envelope with every {"$buf": i} already
 *  swapped for a TypedArray view over the frame's own ArrayBuffer. */
interface BinaryHeader {
  id: string;
  ok?: boolean;
  status?: string;
  stream?: WireStreamEnvelope;
  result: WireRebuildResult & { $buffers?: { dtype: string; len: number }[] };
}

/** Longest gap tolerated between two frames of one chunked reply before the
 *  client gives up on it. Chunks are sent back to back off a result the sidecar
 *  already holds in full, so any real gap is a sidecar bug — this exists so
 *  that bug surfaces as one failed rebuild instead of a permanently wedged UI. */
type RebuildBodyMeta = NonNullable<RebuildResult["bodies"]>[number];

/** One installment of a chunked rebuild reply, for RENDERERS ONLY.
 *
 *  `result` is the IN-PROGRESS RebuildResult: its arrays are allocated at full
 *  size but only the bodies delivered so far hold real data — the rest is still
 *  zeros. Never retain it, and never read it as document truth. Anything that
 *  needs the finished, authoritative model waits for the ordinary completed
 *  build (store.onBuild), which is why store.build.result keeps pointing at the
 *  PREVIOUS document for the whole stream.
 *
 *  `triRange` is the half-open triangle span this installment filled; pass it to
 *  partitionMesh so the scan cannot wander into unwritten (zeroed) triangles,
 *  which would otherwise read as faceId 0. */
export interface RebuildChunk {
  phase: "begin" | "bodies";
  result: RebuildResult;
  /** metadata for EVERY body of the reply, in final order, known from frame 0 */
  manifest: RebuildBodyMeta[];
  /** just the bodies this installment filled */
  bodies: RebuildBodyMeta[];
  edgesByBody: Map<string, RebuildResult["edges"]>;
  triRange: { triStart: number; triEnd: number };
  /** final for the whole reply, known from frame 0 — so the camera can settle
   *  once, before any geometry arrives, and never move again */
  bbox: RebuildResult["bbox"];
  done: number;
  total: number;
}

const STREAM_IDLE_MS = 30_000;

/** Decode ONE binary frame: [u32 LE header_len][JSON header][pad to 4][bufs...].
 *  Mesh arrays become zero-copy TypedArray views over `buf`, and packed edges
 *  are expanded to the list every consumer expects.
 *
 *  Buffer indices are FRAME-local, which is what lets a chunked reply reuse this
 *  unchanged: each chunk carries its own header, pad and $buffers table and is
 *  independently decodable.
 *
 *  Exported for its own test, like expandPackedEdges — the sidecar-side test can
 *  only prove the encoder. */
export function decodeBinaryFrame(buf: ArrayBuffer): BinaryHeader {
  const dv = new DataView(buf);
  const headerLen = dv.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as BinaryHeader;
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
    // Edges arrive packed (server.py's _pack_edges) — expand them back to the
    // plain list every consumer expects, here at the one point the raw frame is
    // interpreted. Rebuilding the triples is still cheaper than the JSON text it
    // replaces: on a large assembly that was 97.1 MiB to parse, and the frame it
    // saves is what keeps the reply under the cap.
    const rawEdges = (fb as { edges?: WireEdgeList | WireEdgesPacked }).edges;
    if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
      fb.edges = expandPackedEdges(
        resolveBuf(rawEdges.$pts) as Float32Array,
        resolveBuf(rawEdges.$counts) as Uint32Array,
        rawEdges.body,
      );
    }
  }
  delete header.result.$buffers;
  return header;
}



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
  private progressListeners = new Set<(feature: number, meshed: number, meshTotal: number) => void>();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500; // ms; doubles on each failed attempt, capped, reset on open
  // Protocol-v2 per-body mesh cache: the sidecar answers unchanged bodies with
  // an etag stub instead of re-sending their (multi-MB) mesh; we keep the last
  // full payload per body and reassemble the merged RebuildResult locally, so
  // everything downstream (render/picking/store) sees the same shape as before.
  private bodyMesh = new Map<string, WireBodyFull>();
  /** Chunked replies in flight, by request id (see server.py's
   *  _stream_binary_reply). INVARIANT: an entry here implies a live entry in
   *  `pending` for the same id — every teardown clears both or neither, which
   *  is what keeps a broken stream from wedging rebuildNow()'s `rebuilding`
   *  flag forever. In practice there is at most one: both sides serialize
   *  rebuilds, and the map is keyed by id so a stale one cannot be mistaken for
   *  the live one. */
  private streams = new Map<string, {
    sid: string;
    nextSeq: number;
    manifest: WireManifestEntry[];
    assembly: RebuildAssembly;
    ids: string[];
    timer: number;
  }>();
  private chunkListeners = new Set<(c: RebuildChunk) => void>();
  /** The last RebuildResult assemble() produced, plus the reply signature that
   *  produced it. A rebuild whose bodies all arrive as unchanged stubs with the
   *  same signature returns this object by reference instead of rebuilding
   *  ~98 MiB of typed arrays — see the fast path in assemble(). */
  private lastAssembled: RebuildResult | null = null;
  private lastAssembledSig: string | null = null;
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
      // Plain browser, no Tauri. DEV builds accept a token on the URL so the app
      // can be driven against a hand-started sidecar (demo capture, e2e); a
      // production bundle keeps the old "" and simply has no sidecar.
      this.token = import.meta.env.DEV
        ? (new URLSearchParams(location.search).get("token") ?? "")
        : "";
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

  /** Installments of a chunked rebuild reply, so the viewport can draw bodies as
   *  they arrive instead of showing the previous document until the whole reply
   *  lands. The ONLY legitimate subscriber is the viewport bridge in main.ts;
   *  anything reading document truth uses store.onBuild. */
  onRebuildChunk(fn: (c: RebuildChunk) => void): () => void {
    this.chunkListeners.add(fn);
    return () => this.chunkListeners.delete(fn);
  }

  onProgress(fn: (feature: number, meshed: number, meshTotal: number) => void): () => void {
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
          const m = typeof msg.meshed === "number" ? msg.meshed : -1;
          const mt = typeof msg.meshTotal === "number" ? msg.meshTotal : -1;
          for (const fn of this.progressListeners) fn(f, m, mt);
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
        // A terminal TEXT reply for an id with a stream in flight is how the
        // sidecar aborts one mid-send (cancel, or a single body over the frame
        // cap). Drop the partial stream — this reply supersedes it.
        this.dropStream(msg.id);
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
      // Every pending call has just been settled, so no stream can still have
      // its partner entry — clear them (and their watchdogs) to keep the
      // streams/pending invariant true rather than merely usually true.
      for (const s of this.streams.values()) clearTimeout(s.timer);
      this.streams.clear();
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

  /** Decode ONE binary frame (see server.py's _encode_binary_reply / _frame_bytes
   *  for the layout: [u32 LE header_len][JSON header][pad to 4][buf0][buf1]...).
   *  The header is the normal {id, ok, result} envelope with each big mesh array
   *  replaced by {"$buf": i} into result.$buffers ({dtype, len} in wire order);
   *  buffers become TypedArray VIEWS over this frame's ArrayBuffer — zero copy,
   *  no JSON number parsing.
   *
   *  Buffer indices are FRAME-local, which is what lets a chunked reply reuse
   *  this unchanged: every chunk carries its own header, pad and $buffers table
   *  and is independently decodable.
   *
   *  Exported for its own test, like expandPackedEdges. */
  private handleBinaryReply(buf: ArrayBuffer) {
    let header: BinaryHeader | null = null;
    try {
      header = decodeBinaryFrame(buf);
      if (header.stream) {
        this.routeStreamFrame(header);
        return;
      }
      const resolve = this.pending.get(header.id);
      if (resolve) {
        this.pending.delete(header.id);
        // a single-frame reply supersedes any stream for the same id
        this.dropStream(header.id);
        resolve(header as RawReply<unknown>);
      }
    } catch (err) {
      // A frame we cannot read is as unrecoverable as bad JSON. If we got far
      // enough to know the id, settle the caller: leaving it pending is worse
      // than an error, because rebuildNow()'s `rebuilding` flag never clears
      // and every later rebuild silently no-ops (see the onclose comment).
      console.error("[geometry] bad binary frame from sidecar:", err);
      const id = header?.id;
      if (id !== undefined) this.abortStream(id, "the geometry engine sent an unreadable reply");
    }
  }

  /** Accumulate one frame of a chunked reply, and resolve the caller on the
   *  final one. See server.py's _stream_binary_reply for the framing.
   *
   *  Every exit that drops a stream also settles its pending call — INVARIANT:
   *  an entry in `streams` implies a live entry in `pending` for the same id.
   *  That pairing is the whole leak surface. */
  private routeStreamFrame(header: BinaryHeader) {
    const st = header.stream!;
    const id = header.id;
    if (st.seq === 0) {
      // A head frame always starts a fresh stream, replacing any half-received
      // one for the same id. Cannot happen (rebuilds are serialized on both
      // sides) — but a silent body splice is a far worse failure than a reset.
      const prev = this.streams.get(id);
      if (prev) clearTimeout(prev.timer);
      const result = header.result as WireRebuildResult & { manifest?: WireManifestEntry[] };
      const manifest = result.manifest ?? [];
      delete result.manifest;
      // Plan the whole reply NOW, from the manifest, so each body can be written
      // the moment its chunk lands and the viewport can draw it without waiting
      // for the rest. This is also where an unbacked stub is caught — before any
      // allocation and before any partial display, so a resync costs one round
      // trip and no visual damage.
      const begun = RebuildAssembly.begin(
        result, manifest, this.bodyMesh, this.lastAssembled, this.lastAssembledSig,
      );
      if (begun.kind === "resync") {
        this.settleStream(id, { id, ok: true, result: { resync: true } } as RawReply<unknown>);
        return;
      }
      if (begun.kind === "noop") {
        this.settleStream(id, {
          id, ok: true, result: { protocol: 2, assembled: begun.result },
        } as RawReply<unknown>);
        return;
      }
      this.streams.set(id, {
        sid: st.sid, nextSeq: 1, manifest, assembly: begun.assembly, ids: [], timer: 0,
      });
      this.emitChunk({
        phase: "begin", result: begun.assembly.result,
        manifest: begun.assembly.result.bodies ?? [], bodies: [],
        edgesByBody: new Map(), triRange: { triStart: 0, triEnd: 0 },
        bbox: begun.assembly.result.bbox,
        done: 0, total: manifest.length,
      });
    } else {
      const s = this.streams.get(id);
      if (!s) return; // a late chunk of a stream we already abandoned
      if (st.sid !== s.sid) {
        this.abortStream(id, "the geometry engine restarted its reply mid-send");
        return;
      }
      if (st.seq !== s.nextSeq) {
        this.abortStream(id, "the geometry engine's reply arrived out of order");
        return;
      }
      s.nextSeq++;
      const arrived: string[] = [];
      for (const b of header.result.bodies ?? []) {
        if (b.unchanged) { arrived.push(b.id); continue; }
        this.bodyMesh.set(b.id, b);
        if (!s.assembly.writeBody(b)) {
          // The payload disagrees with what the manifest promised. Writing it
          // would run past this body's slice and corrupt the NEXT body's
          // triangles, producing a wrong-but-believable model.
          this.abortStream(id, "the geometry engine sent a body that did not match its manifest");
          return;
        }
        arrived.push(b.id);
      }
      s.ids.push(...arrived);
      if (arrived.length) {
        const edgesByBody = new Map<string, RebuildResult["edges"]>();
        const metas: RebuildBodyMeta[] = [];
        for (const bid of arrived) {
          const m = s.assembly.metaOf(bid);
          if (m) metas.push(m);
          edgesByBody.set(bid, s.assembly.edgesOf(bid));
        }
        this.emitChunk({
          phase: "bodies", result: s.assembly.result,
          manifest: s.assembly.result.bodies ?? [], bodies: metas, edgesByBody,
          triRange: s.assembly.triRange(arrived),
          bbox: s.assembly.result.bbox,
          done: s.ids.length, total: s.manifest.length,
        });
      }
    }
    const s = this.streams.get(id)!;
    clearTimeout(s.timer);
    if (!st.final) {
      // Chunks are sent back to back with no worker involvement, so this can
      // only fire on a sidecar bug — but without it that bug wedges the UI
      // permanently, since nothing else will ever settle the pending call.
      s.timer = setTimeout(
        () => this.abortStream(id, "the geometry engine stopped part-way through its reply"),
        STREAM_IDLE_MS,
      );
      return;
    }
    this.streams.delete(id);
    // Every body the manifest named must have arrived. Checking is not belt and
    // braces: finishAssembly PRUNES bodyMesh to the ids this reply named, so a
    // stream that ended one body short would evict that body from the cache and
    // corrupt the NEXT rebuild's `known` map too — a failure that outlives the
    // bad stream, with nothing on screen to show for it. complete() enforces the
    // same thing from the other side, and returns null rather than hand on a
    // zero-filled slice.
    const out = this.finishAssembly(s.assembly, s.manifest.map((m) => m.id));
    if (out === null) {
      this.abortStream(id, "the geometry engine's reply was incomplete");
      return;
    }
    this.settleStream(id, {
      id, ok: true, result: { protocol: 2, assembled: out },
    } as RawReply<unknown>);
  }

  /** Resolve a stream's pending call and drop any state it left behind. */
  private settleStream(id: string, reply: RawReply<unknown>) {
    this.dropStream(id);
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(reply);
  }

  private emitChunk(c: RebuildChunk) {
    for (const fn of this.chunkListeners) {
      try { fn(c); } catch (err) { console.error("[geometry] chunk listener threw:", err); }
    }
  }

  /** Drop a stream WITHOUT settling its call — only safe when the caller is
   *  about to settle it another way (a terminal single-frame reply). */
  private dropStream(id: string) {
    const s = this.streams.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    this.streams.delete(id);
  }

  /** The single teardown path for a stream that cannot finish: drop it AND
   *  settle its pending call with an error shaped like a real sidecar one. */
  private abortStream(id: string, message: string) {
    this.dropStream(id);
    const resolve = this.pending.get(id);
    if (resolve) {
      this.pending.delete(id);
      resolve({ id, ok: false, error: { message } } as RawReply<unknown>);
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

  /** Every rebuild/computeAll request goes through here, so the wire opt-in
   *  flags are set in exactly one place. They were easy to get wrong scattered:
   *  of the four call sites, the two that matter most are the RESYNC paths,
   *  which re-request the whole document with no `known` map — i.e. the largest
   *  reply the sidecar can produce, and precisely the one that must not fall
   *  back to a single frame. */
  private rebuildCall(op: "rebuild" | "computeAll", extra: object) {
    return this.call<WireRebuildResult>(op, { ...extra, binary: true, chunked: true });
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

    let msg = await this.rebuildCall("rebuild", { ...payload, tolerance, known });
    if (msg.ok && msg.result?.resync) {
      // worker respawned or lost sync — one full resend recovers everything
      this.lastSent = null;
      this.bodyMesh.clear();
      payload = { document: doc, revision: this.revision + 1 };
      msg = await this.rebuildCall("rebuild", { ...payload, tolerance });
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
        // the assemble cache is keyed on payloads that just went away
        this.lastAssembled = null;
        this.lastAssembledSig = null;
        msg = await this.rebuildCall("rebuild", { document: doc, revision: ++this.revision, tolerance });
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
    const msg = await this.rebuildCall("computeAll", { document: doc, revision: ++this.revision, tolerance });
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
   *  Returns null if an "unchanged" stub references a body we don't hold.
   *
   *  A thin wrapper over RebuildAssembly, which is the same logic in a form
   *  that can also be driven incrementally by a chunked reply. The single-frame
   *  path derives the manifest from the bodies it already has, so both paths
   *  run identical code and assemble.test.ts / assembleNoop.test.ts cover both. */
  private assemble(r: WireRebuildResult): RebuildResult | null {
    // A chunked reply was assembled as its frames arrived (routeStreamFrame),
    // including the cache prune and the no-op baseline. Nothing left to do.
    if (r.assembled) return r.assembled;
    const bodies: WireBody[] = r.bodies ?? [];
    const begun = RebuildAssembly.begin(
      r, manifestFromBodies(bodies), this.bodyMesh, this.lastAssembled, this.lastAssembledSig,
    );
    if (begun.kind === "resync") return null;
    if (begun.kind === "noop") return begun.result;
    for (const nb of bodies) {
      if (nb.unchanged) continue;
      this.bodyMesh.set(nb.id, nb);
      if (!begun.assembly.writeBody(nb)) return null;
    }
    return this.finishAssembly(begun.assembly, bodies.map((b) => b.id));
  }

  /** Common tail of both assembly paths: prune the per-body cache to the bodies
   *  this reply actually named, then publish the result as the no-op fast
   *  path's new baseline. Returns null on an incomplete assembly — a
   *  partially-filled result would hand on zeroed slices, which render as
   *  plausible-looking degenerate geometry rather than as an error. */
  private finishAssembly(assembly: RebuildAssembly, live: string[]): RebuildResult | null {
    const out = assembly.complete();
    if (out === null) return null;
    const keep = new Set(live);
    for (const id of this.bodyMesh.keys()) if (!keep.has(id)) this.bodyMesh.delete(id);
    this.lastAssembledSig = assembly.sig;
    this.lastAssembled = out;
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
    onStarted?: (id: string) => void,
  ): Promise<{ ok: boolean; path?: string; paths?: string[]; message?: string; cancelled?: boolean; warnings?: { message: string; feature_id?: string }[] }> {
    const msg = await this.call<{ path?: string; paths?: string[]; warnings?: { message: string; feature_id?: string }[] }>(
      "export",
      {
        document: doc, format, path, body: opts.body, separate: opts.separate,
        // GLB writes one material per body from these; the sidecar defaults both
        // to empty, so other formats are unaffected by sending them.
        palette: opts.palette, bodyColors: opts.bodyColors,
      },
      onStarted,
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
    if (msg.cancelled) return { ok: false, cancelled: true, message: "export cancelled" };
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
    onStarted?: (id: string) => void,
  ): Promise<{ ok: boolean; path?: string; message?: string; cancelled?: boolean; warnings?: { message: string; feature_id?: string }[] }> {
    const msg = await this.call<{ path?: string; warnings?: { message: string; feature_id?: string }[] }>("exportProject", {
      document: doc,
      path,
      palette: opts.palette,
      bodyColors: opts.bodyColors,
      bodyNames: opts.bodyNames,
      settings: opts.settings ?? {},
    }, onStarted);
    if (msg.ok) {
      const r = msg.result;
      return {
        ok: true,
        ...(r.path !== undefined ? { path: r.path } : {}),
        ...(r.warnings !== undefined ? { warnings: r.warnings } : {}),
      };
    }
    if (msg.cancelled) return { ok: false, cancelled: true, message: "export cancelled" };
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

  /** Exact kernel mass properties. Uses the shared `call<T>` like every other aux
   *  op — no bespoke plumbing. `onStarted` hands back the request id so a caller
   *  that wraps this in a busy state can target THIS op with a cancel rather than
   *  whatever ran most recently. */
  async massProperties(
    doc: CadDocument,
    opts?: { bodies?: string[]; checks?: boolean },
    onStarted?: (id: string) => void,
  ): Promise<{ ok: boolean; result?: MassPropertiesResult; message?: string }> {
    const msg = await this.call<MassPropertiesResult>(
      "massProperties",
      {
        document: doc,
        ...(opts?.bodies ? { bodies: opts.bodies } : {}),
        ...(opts?.checks ? { checks: true } : {}),
      },
      onStarted,
    );
    return msg.ok ? { ok: true, result: msg.result } : { ok: false, message: msg.error?.message };
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
