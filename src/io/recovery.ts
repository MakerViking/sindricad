// Crash-recovery autosave. Rust owns the snapshot files (app_data_dir/recovery,
// atomic writes via the recovery_* commands) — deliberately OUTSIDE the
// webview's tightened fs scope. The frontend just decides WHEN to snapshot:
// 30 s after the last change (debounced), at most 2 min behind, and only while
// the document is dirty. A successful manual save clears the slot, so a
// recovery prompt on launch ≈ "the app died with unsaved work".

import type { DocumentStore } from "../document/store";
import { toast } from "../ui/toast";

const IDLE_MS = 30_000; // quiet period after the last edit
const MAX_MS = 120_000; // never lag a busy session by more than this

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** slot name for a document path (sanitized server-side too) */
export function slotFor(path: string | null): string {
  if (!path) return "untitled";
  const base = (path.split(/[\\/]/).pop() ?? "doc").replace(/\.[^.]+$/, "");
  // tiny stable hash so same-named files in different dirs get distinct slots
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  return `${base}_${h.toString(36)}`;
}

interface Envelope {
  source: string | null; // where the document was last saved (null = untitled)
  savedAt: number;
  doc: unknown; // the full store.toJSON() payload
}

export function installAutosave(store: DocumentStore) {
  if (!isTauri()) return;
  let idleTimer: number | null = null;
  let oldestEdit: number | null = null;
  let writing = false;

  const write = async () => {
    if (idleTimer != null) window.clearTimeout(idleTimer);
    idleTimer = null;
    oldestEdit = null;
    if (!store.dirty || writing) return;
    writing = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const env: Envelope = {
        source: store.filePath,
        savedAt: Date.now(),
        doc: JSON.parse(store.toJSON()),
      };
      await invoke("recovery_write", { slot: slotFor(store.filePath), json: JSON.stringify(env) });
    } catch (e) {
      console.warn("autosave failed:", e);
    } finally {
      writing = false;
    }
  };

  const schedule = () => {
    if (!store.dirty) return;
    const now = Date.now();
    if (oldestEdit == null) oldestEdit = now;
    if (idleTimer != null) window.clearTimeout(idleTimer);
    // debounce on idle, but a busy session still snapshots every MAX_MS
    const wait = Math.min(IDLE_MS, Math.max(0, oldestEdit + MAX_MS - now));
    idleTimer = window.setTimeout(() => void write(), wait);
  };

  store.onDocChange(schedule);
  store.onMeta(schedule);
}

/** Drop the recovery snapshots for a just-saved document (called after a
 *  successful save — the on-disk file is now the truth). */
export async function clearRecovery(path: string | null) {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("recovery_clear", { slot: slotFor(path) });
    await invoke("recovery_clear", { slot: "untitled" });
  } catch {
    /* best-effort */
  }
}

/** On launch: if any snapshot exists, offer to restore the newest one. */
export async function checkRecovery(store: DocumentStore) {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const slots = await invoke<[string, number][]>("recovery_list");
    if (!slots.length) return;
    const [slot, mtime] = slots[0];
    const raw = await invoke<string | null>("recovery_read", { slot });
    if (!raw) return;
    const env = JSON.parse(raw) as Envelope;
    const age = Math.max(1, Math.round((Date.now() - (env.savedAt || mtime)) / 60000));
    const from = env.source ? env.source.split(/[\\/]/).pop() : "an unsaved document";
    const { choose } = await import("../ui/choice");
    const pick = await choose<"recover" | "discard">(
      `Recover unsaved work? (${from}, ~${age} min old)`,
      [
        { value: "recover", label: "Recover", hint: "restore the snapshot" },
        { value: "discard", label: "Discard", hint: "delete it" },
      ],
    );
    if (pick === "recover") {
      store.load(JSON.stringify(env.doc));
      toast("Recovered unsaved work — use Save As to store it where you want", { kind: "info", timeout: 8000 });
    } else if (pick === "discard") {
      await invoke("recovery_clear", { slot });
    }
    // pick === null (Esc): keep the snapshot for next launch, load nothing
  } catch (e) {
    console.warn("recovery check failed:", e);
  }
}
