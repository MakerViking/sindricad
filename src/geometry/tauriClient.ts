// In-process Rust geometry backend, used when VITE_GEOM=rust.
// Mirrors the public surface of `Geometry` (the Python websocket client) but
// calls a Tauri command on the Rust side instead of round-tripping over a
// socket. Being in-process, it is always "connected" — there is nothing to
// reconnect to. This is a spike; the websocket client remains the default.

import { invoke } from "@tauri-apps/api/core";
import type { CadDocument, ExportFormat, RebuildReply, RebuildResult } from "../types";
import type { GeometryBackend } from "./client";

type StatusListener = (connected: boolean) => void;

export class TauriGeometry implements GeometryBackend {
  private statusListeners = new Set<StatusListener>();

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.connected); // in-process: always connected
    return () => this.statusListeners.delete(fn);
  }

  get connected(): boolean {
    return true;
  }

  async rebuild(doc: CadDocument, _tolerance = 0.1): Promise<RebuildReply> {
    try {
      const result = await invoke<RebuildResult>("geom_rebuild", { document: doc });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: { message: String(e) } };
    }
  }

  async export(
    _doc: CadDocument,
    _format: ExportFormat,
    _path: string,
  ): Promise<{ ok: boolean; path?: string; message?: string }> {
    throw new Error("export not supported in the Rust geometry spike");
  }
}
