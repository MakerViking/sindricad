// In-process Rust geometry backend, used when VITE_GEOM=rust.
// Mirrors the public surface of `Geometry` (the Python websocket client) but
// calls a Tauri command on the Rust side instead of round-tripping over a
// socket. Being in-process, it is always "connected" — there is nothing to
// reconnect to. This is a spike; the websocket client remains the default.

import { invoke } from "@tauri-apps/api/core";
import type { CadDocument, ExportFormat, ImportFormat, ImportReply, RebuildReply, RebuildResult } from "../types";
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
    doc: CadDocument,
    format: ExportFormat,
    path: string,
  ): Promise<{ ok: boolean; path?: string; message?: string }> {
    try {
      const written = await invoke<string>("geom_export", {
        document: doc,
        format,
        path,
      });
      return { ok: true, path: written };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  // Geometry import is not yet wired into the Rust kernel (STL read / sewing need
  // new opencascade-rs FFI). Use the default Python sidecar to import for now.
  async importGeometry(_path: string, _format: ImportFormat): Promise<ImportReply> {
    return { ok: false, message: "geometry import isn't supported by the Rust backend yet — run without VITE_GEOM=rust" };
  }
}
