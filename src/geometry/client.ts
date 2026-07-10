// WebSocket client to the Python geometry sidecar.
// One request/response per message, matched by `id`. Calls made before the
// socket opens are queued and flushed on connect; the socket auto-reconnects.

import type { CadDocument, ExportFormat, Feature, ImportFormat, ImportReply, RebuildReply, RebuildResult } from "../types";

// The sidecar's wire-level reply envelope (see sidecar/server.py's _ok/_err):
// every call resolves to one of these two shapes; `result`'s type is per-op,
// supplied as call<T>()'s generic parameter at each call site.
interface WireError {
  message: string;
  feature_id?: string;
}
type RawReply<T> =
  | { id: string; ok: true; result: T }
  | { id: string; ok: false; error: WireError };

type Pending = (msg: RawReply<unknown>) => void;
type StatusListener = (connected: boolean) => void;

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
  export(
    doc: CadDocument,
    format: ExportFormat,
    path: string,
    opts?: { body?: string; separate?: boolean },
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
  importGeometry(path: string, format: ImportFormat): Promise<ImportReply>;
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
  positions: number[];
  indices: number[];
  faceIds: number[];
  faceOwners?: (string | null)[];
  edges?: { points: [number, number, number][]; body?: string }[];
  faceCount?: number;
}
interface WireBodyStub {
  id: string;
  name: string;
  etag: string;
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

export class Geometry implements GeometryBackend {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private token = ""; // per-launch shared secret fetched from the Rust shell
  private pending = new Map<string, Pending>();
  private outbox: string[] = [];
  private statusListeners = new Set<StatusListener>();
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
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500; // healthy connection — reset backoff
      this.emitStatus();
      for (const raw of this.outbox) ws.send(raw);
      this.outbox = [];
    };

    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        console.error("[geometry] bad JSON from sidecar:", err, "payload:", String(e.data).slice(0, 200));
        return;
      }
      if (msg && msg.status === "building") {
        // interim progress frame from a long rebuild — informational only,
        // must NEVER resolve the pending call (the real reply follows)
        const f = typeof msg.feature === "number" ? msg.feature : -1;
        for (const fn of this.progressListeners) fn(f);
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    };

    ws.onclose = () => {
      this.emitStatus();
      // Settle every in-flight call with a synthetic error reply shaped like a
      // real sidecar error, matching the `msg.ok === false` contract every
      // caller already checks (rebuild/export/etc). Without this, a call made
      // before the drop just hangs forever — e.g. DocumentStore.rebuildNow()'s
      // `await this.geometry.rebuild(...)` never returns, so its finally-block
      // never clears `rebuilding`, so the reconnect-triggered rebuild in
      // main.ts's onStatus() silently no-ops (rebuildNow sees rebuilding===true
      // and just sets rebuildQueued, forever).
      for (const [id, resolve] of this.pending) {
        resolve({ id, ok: false, error: { message: "geometry engine connection lost" } });
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

  private call<T>(op: string, extra: object): Promise<RawReply<T>> {
    const id = crypto.randomUUID();
    const raw = JSON.stringify({ id, op, ...extra });
    return new Promise((resolve) => {
      // the pending map is heterogeneous across calls with different T, so
      // storing this call's typed resolver erases to Pending here — the one
      // type-erasing cast the generic requires.
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
        if (this.lastSent.features[i] !== doc.features[i]) set.push([i, doc.features[i]]);
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

    let msg = await this.call<WireRebuildResult>("rebuild", { ...payload, tolerance, known });
    if (msg.ok && msg.result?.resync) {
      // worker respawned or lost sync — one full resend recovers everything
      this.lastSent = null;
      this.bodyMesh.clear();
      payload = { document: doc, revision: this.revision + 1 };
      msg = await this.call<WireRebuildResult>("rebuild", { ...payload, tolerance });
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
        msg = await this.call<WireRebuildResult>("rebuild", { document: doc, revision: ++this.revision, tolerance });
        if (msg.ok && msg.result?.protocol === 2) assembled = this.assemble(msg.result);
      }
      if (msg.ok && assembled !== null) return { ok: true, result: assembled };
    }
    if (msg.ok) return { ok: true, result: msg.result as RebuildResult };
    return { ok: false, error: msg.error };
  }

  /** MCAD-style "Compute All": bypass and rebuild every cache layer (RAM,
   *  mesh, disk checkpoints) server-side, and drop our own mesh cache. */
  async computeAll(doc: CadDocument, tolerance = 0.1): Promise<RebuildReply> {
    this.bodyMesh.clear();
    this.lastSent = null;
    const msg = await this.call<WireRebuildResult>("computeAll", { document: doc, revision: ++this.revision, tolerance });
    if (msg.ok && msg.result?.protocol === 2) {
      const assembled = this.assemble(msg.result);
      if (assembled !== null) return { ok: true, result: assembled };
    }
    if (msg.ok) return { ok: true, result: msg.result as RebuildResult };
    return { ok: false, error: msg.error };
  }

  /** Merge protocol-v2 per-body payloads into the legacy RebuildResult shape.
   *  Returns null if an "unchanged" stub references a body we don't hold. */
  private assemble(r: WireRebuildResult): RebuildResult | null {
    const bodies: WireBody[] = r.bodies ?? [];
    const live = new Set<string>();
    // first pass: resolve payloads + prune
    const payloads: WireBodyFull[] = [];
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
      payloads.push(p);
    }
    for (const id of this.bodyMesh.keys()) if (!live.has(id)) this.bodyMesh.delete(id);

    const positions: number[] = [];
    const indices: number[] = [];
    const faceIds: number[] = [];
    const edges: RebuildEdge[] = [];
    const meta: RebuildBody[] = [];
    let faceBase = 0;
    let ek = 0;
    for (const p of payloads) {
      const vbase = positions.length / 3;
      // explicit loops: Array.push(...huge) overflows the stack
      for (let i = 0; i < p.positions.length; i++) positions.push(p.positions[i]);
      for (let i = 0; i < p.indices.length; i++) indices.push(p.indices[i] + vbase);
      for (let i = 0; i < p.faceIds.length; i++) faceIds.push(p.faceIds[i] + faceBase);
      for (const e of p.edges ?? []) edges.push({ id: `e${ek++}`, points: e.points, body: e.body });
      meta.push({
        id: p.id, name: p.name, faceStart: faceBase,
        faceCount: p.faceCount ?? 0, faceOwners: p.faceOwners, etag: p.etag,
      });
      faceBase += p.faceCount ?? 0;
    }
    const out: RebuildResult = {
      mesh: { positions, indices, faceIds },
      edges,
      // the wire can supply `bbox: null` when nothing has built yet (no
      // bodies); preserved as-is — RebuildResult models bbox as always-present.
      bbox: r.bbox as RebuildResult["bbox"],
      bodies: meta,
    };
    if (r.diagnostics) out.diagnostics = r.diagnostics;
    if (r.featureError) out.featureError = r.featureError;
    if (r.featureErrors) out.featureErrors = r.featureErrors;
    return out;
  }

  async export(
    doc: CadDocument,
    format: ExportFormat,
    path: string,
    opts: { body?: string; separate?: boolean } = {},
  ): Promise<{ ok: boolean; path?: string; paths?: string[]; message?: string; warnings?: { message: string; feature_id?: string }[] }> {
    const msg = await this.call<{ path?: string; paths?: string[]; warnings?: { message: string; feature_id?: string }[] }>(
      "export",
      { document: doc, format, path, body: opts.body, separate: opts.separate },
    );
    if (msg.ok) return { ok: true, path: msg.result.path, paths: msg.result.paths, warnings: msg.result.warnings };
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
    if (msg.ok) return { ok: true, path: msg.result.path, warnings: msg.result.warnings };
    return { ok: false, message: msg.error?.message };
  }

  async importGeometry(path: string, format: ImportFormat): Promise<ImportReply> {
    const msg = await this.call<{ brep: string; name: string; solid: boolean; faces: number }>("import", { path, format });
    if (msg.ok) {
      const r = msg.result;
      return { ok: true, brep: r.brep, name: r.name, solid: r.solid, faces: r.faces };
    }
    return { ok: false, message: msg.error?.message ?? "import failed" };
  }

  async interference(doc: CadDocument): Promise<{ ok: boolean; pairs?: ClashPair[]; message?: string }> {
    const msg = await this.call<{ pairs?: ClashPair[] }>("interference", { document: doc });
    if (msg.ok) return { ok: true, pairs: msg.result.pairs };
    return { ok: false, message: msg.error?.message };
  }
}
