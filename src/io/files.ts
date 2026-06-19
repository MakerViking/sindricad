// File I/O: save/open the document JSON and export STEP/STL/3MF. Uses Tauri
// native dialogs + fs when running in the app; falls back to browser
// download/upload in a plain dev browser. Export always writes server-side: we
// get a path from the native save dialog and hand it to the sidecar, which
// writes the file directly (no fs round-trip through the webview).

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { ExportFormat } from "../types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** Save: write to the current path if known, else behave like Save As. */
export async function saveDocument(store: DocumentStore) {
  if (isTauri() && store.filePath) {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(store.filePath, store.toJSON());
    store.markSaved(store.filePath);
  } else {
    await saveDocumentAs(store);
  }
}

/** Save As: always prompt for a path (or download in a plain browser). */
export async function saveDocumentAs(store: DocumentStore) {
  const json = store.toJSON();
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      filters: [{ name: "SindriCAD Document", extensions: ["json"] }],
      defaultPath: store.filePath ?? `${store.fileName}.json`,
    });
    if (path) {
      await writeTextFile(path, json);
      store.markSaved(path);
    }
  } else {
    downloadText(`${store.fileName}.json`, json);
  }
}

export async function openDocument(store: DocumentStore) {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({
      multiple: false,
      filters: [{ name: "SindriCAD Document", extensions: ["json"] }],
    });
    if (typeof path === "string") {
      store.load(await readTextFile(path));
      store.markSaved(path); // freshly opened == clean, with a known path
    }
  } else {
    const text = await uploadText();
    if (text) store.load(text);
  }
}

export async function exportModel(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) {
    console.warn("export needs the native app (a real filesystem path)");
    return;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    filters: [
      { name: "STEP", extensions: ["step", "stp"] },
      { name: "STL", extensions: ["stl"] },
      { name: "3MF", extensions: ["3mf"] },
    ],
    defaultPath: "part.step",
  });
  if (!path) return;
  const fmt = extToFormat(path);
  const res = await geometry.export(store.document, fmt, path);
  if (!res.ok) console.error("export failed:", res.message);
}

function extToFormat(path: string): ExportFormat {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "stl") return "stl";
  if (ext === "3mf") return "3mf";
  return "step";
}

// --- browser fallbacks ---
function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function uploadText(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
