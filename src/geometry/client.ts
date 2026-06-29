// WebSocket client to the Python geometry sidecar.
// One request/response per message, matched by `id`. Calls made before the
// socket opens are queued and flushed on connect; the socket auto-reconnects.

import type { CadDocument, ExportFormat, ImportFormat, ImportReply, RebuildReply } from "../types";

type Pending = (msg: any) => void;
type StatusListener = (connected: boolean) => void;

// The surface the rest of the app depends on. Both the websocket `Geometry`
// and the in-process `TauriGeometry` implement this, so callers stay agnostic
// to which backend is wired up (see VITE_GEOM in main.ts).
export interface GeometryBackend {
  rebuild(doc: CadDocument, tolerance?: number): Promise<RebuildReply>;
  export(
    doc: CadDocument,
    format: ExportFormat,
    path: string,
  ): Promise<{ ok: boolean; path?: string; message?: string }>;
  // Read an external geometry file into an embeddable BREP payload (for an
  // `import` feature). Path-based: the sidecar reads the file directly.
  importGeometry(path: string, format: ImportFormat): Promise<ImportReply>;
  onStatus(fn: StatusListener): () => void;
  readonly connected: boolean;
}

export class Geometry implements GeometryBackend {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private pending = new Map<string, Pending>();
  private outbox: string[] = [];
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer: number | null = null;

  constructor(url = "ws://127.0.0.1:8765") {
    this.url = url;
    this.connect();
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.connected);
    return () => this.statusListeners.delete(fn);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private emitStatus() {
    for (const fn of this.statusListeners) fn(this.connected);
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.emitStatus();
      for (const raw of this.outbox) ws.send(raw);
      this.outbox = [];
    };

    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
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
    }, 500);
  }

  private call(op: string, extra: object): Promise<any> {
    const id = crypto.randomUUID();
    const raw = JSON.stringify({ id, op, ...extra });
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      if (this.connected) {
        this.ws!.send(raw);
      } else {
        this.outbox.push(raw);
      }
    });
  }

  async rebuild(doc: CadDocument, tolerance = 0.1): Promise<RebuildReply> {
    const msg = await this.call("rebuild", { document: doc, tolerance });
    if (msg.ok) return { ok: true, result: msg.result };
    return { ok: false, error: msg.error };
  }

  async export(
    doc: CadDocument,
    format: ExportFormat,
    path: string,
  ): Promise<{ ok: boolean; path?: string; message?: string }> {
    const msg = await this.call("export", { document: doc, format, path });
    if (msg.ok) return { ok: true, path: msg.result.path };
    return { ok: false, message: msg.error?.message };
  }

  async importGeometry(path: string, format: ImportFormat): Promise<ImportReply> {
    const msg = await this.call("import", { path, format });
    if (msg.ok) {
      const r = msg.result;
      return { ok: true, brep: r.brep, name: r.name, solid: r.solid, faces: r.faces };
    }
    return { ok: false, message: msg.error?.message ?? "import failed" };
  }
}
