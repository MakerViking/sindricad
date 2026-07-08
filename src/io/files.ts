// File I/O: save/open the document JSON and export STEP/STL/3MF. Uses Tauri
// native dialogs + fs when running in the app; falls back to browser
// download/upload in a plain dev browser. Export always writes server-side: we
// get a path from the native save dialog and hand it to the sidecar, which
// writes the file directly (no fs round-trip through the webview).

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { ExportFormat, ImportFormat } from "../types";
import { clearRecovery } from "./recovery";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** Save: write to the current path if known, else behave like Save As. */
export async function saveDocument(store: DocumentStore) {
  if (isTauri() && store.filePath) {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(store.filePath, store.toJSON());
    store.markSaved(store.filePath);
    void clearRecovery(store.filePath); // the on-disk file is now the truth
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
      filters: [{ name: "SindriCAD Document", extensions: ["sindri"] }],
      defaultPath: store.filePath ?? `${store.fileName}.sindri`,
    });
    if (path) {
      await writeTextFile(path, json);
      store.markSaved(path);
      void clearRecovery(path);
    }
  } else {
    downloadText(`${store.fileName}.sindri`, json);
  }
}

export async function openDocument(store: DocumentStore, geometry: GeometryBackend) {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      // MCAD-style: Open takes our document AND mesh/CAD files (imported as a
      // body), routed by extension below — so users can just "open" an STL.
      filters: [
        { name: "All supported", extensions: ["sindri", "json", "stl", "3mf", "step", "stp", "obj"] },
        { name: "SindriCAD Document", extensions: ["sindri", "json"] },
        { name: "Mesh / CAD", extensions: ["stl", "3mf", "step", "stp", "obj"] },
      ],
    });
    if (typeof path !== "string") return;
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "sindri" || ext === "json") {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      store.load(await readTextFile(path));
      store.markSaved(path); // freshly opened == clean, with a known path
    } else {
      await importPath(store, geometry, path); // a mesh / CAD file → import as a body
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
  // With several bodies, ask what to export: all merged, each as its own file, or
  // one specific body. A single-body doc skips straight to the save dialog.
  const bodies = store.buildState.result?.bodies ?? [];
  const opts: { body?: string; separate?: boolean } = {};
  if (bodies.length > 1) {
    const { choose } = await import("../ui/choice");
    const scope = await choose<"all" | "separate" | "one">("Export — which bodies?", [
      { value: "all", label: "All in one file", hint: `${bodies.length} bodies merged` },
      { value: "separate", label: "Each body separately", hint: `${bodies.length} files` },
      { value: "one", label: "A specific body", hint: "pick one" },
    ]);
    if (!scope) return;
    if (scope === "separate") {
      opts.separate = true;
    } else if (scope === "one") {
      const picked = await choose<string>(
        "Which body to export?",
        bodies.map((b) => ({ value: b.id, label: store.bodyName(b.id) ?? b.name })),
      );
      if (!picked) return;
      opts.body = picked;
    }
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    filters: [
      { name: "STEP", extensions: ["step", "stp"] },
      { name: "STL", extensions: ["stl"] },
      { name: "3MF", extensions: ["3mf"] },
    ],
    // "separate" derives one file per body as "<base>-<body>.<ext>", so name the base.
    defaultPath: opts.separate ? "parts.step" : "part.step",
  });
  if (!path) return;
  const fmt = extToFormat(path);
  const res = await geometry.export(store.document, fmt, path, opts);
  if (!res.ok) {
    await reportError(`Export failed: ${res.message ?? "unknown error"}`);
    return;
  }
  // Confirm what was written — list every file for "separate", the single path
  // otherwise — and NAME any features whose geometry is missing from the export
  // (export-what-built: one red feature no longer blocks the whole print loop).
  const written = res.paths?.length ? res.paths : res.path ? [res.path] : [];
  const lines = [...written];
  for (const w of res.warnings ?? []) {
    lines.push(`⚠ ${w.feature_id ?? "feature"} failed — its result is NOT in the export: ${w.message}`);
  }
  if (lines.length) {
    const { listModal } = await import("../ui/choice");
    const title = res.warnings?.length
      ? `Exported ${written.length} file${written.length === 1 ? "" : "s"} — with warnings`
      : `Exported ${written.length} file${written.length === 1 ? "" : "s"}`;
    await listModal(title, lines);
  }
}

function extToFormat(path: string): ExportFormat {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "stl") return "stl";
  if (ext === "3mf") return "3mf";
  return "step";
}

// The slicer preset the exported project should land on — minimal keys Orca needs
// to select the user's Snapmaker U1 machine on "open as project". Stage D.v2 (CLI)
// overrides these with a fully-flattened config via `opts.settings`.
const U1_PROJECT_SETTINGS: Record<string, unknown> = {
  printer_model: "Snapmaker U1",
  printer_variant: "0.4",
  version: "2.4.0.0",
};

/** Export a colored multi-material 3MF PROJECT (Orca format): one object per body,
 *  palette slot → toolhead, so the multi-color palette actually prints. With
 *  `opts.path` it writes there silently (Stage D staging → open in Orca); without,
 *  it prompts with a save dialog. Returns the written path, or null (cancelled /
 *  error). Palette/bodyColors/bodyNames are threaded explicitly — they live in
 *  store side-maps, never inside `document`. */
export async function exportPrintProject(
  store: DocumentStore,
  geometry: GeometryBackend,
  opts: { path?: string; settings?: Record<string, unknown> } = {},
): Promise<string | null> {
  if (!isTauri()) {
    console.warn("print export needs the native app (a real filesystem path)");
    return null;
  }
  if (!geometry.exportProject) {
    await reportError("Colored 3MF export needs the Python sidecar backend (run without VITE_GEOM=rust).");
    return null;
  }
  const bodies = store.buildState.result?.bodies ?? [];
  if (!bodies.length) {
    await reportError("Nothing to export yet — build a body first.");
    return null;
  }

  let path = opts.path;
  if (!path) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const base = store.fileName.replace(/\.sindri$/i, "") || "part";
    const picked = await save({
      filters: [{ name: "3MF project", extensions: ["3mf"] }],
      defaultPath: `${base}.3mf`,
    });
    if (!picked) return null;
    path = picked;
  }

  const res = await geometry.exportProject(store.document, path, {
    palette: store.colorPalette,
    bodyColors: store.bodyColorsMap(),
    bodyNames: store.bodyNamesMap(),
    settings: { ...U1_PROJECT_SETTINGS, ...(opts.settings ?? {}) },
  });
  if (!res.ok) {
    await reportError(`Print export failed: ${res.message ?? "unknown error"}`);
    return null;
  }
  // Only surface a modal when there are warnings (features that didn't build) —
  // the silent-staging path (Stage D) shouldn't pop a dialog on the happy path.
  if (res.warnings?.length) {
    const lines = res.warnings.map(
      (w) => `⚠ ${w.feature_id ?? "feature"} failed — its result is NOT in the export: ${w.message}`,
    );
    const { listModal } = await import("../ui/choice");
    await listModal("Exported project — with warnings", [res.path ?? path, ...lines]);
  }
  return res.path ?? path;
}


/** Import an external mesh / B-rep file (STL / 3MF / STEP / OBJ) as a new body.
 *  The sidecar reads the file by path and returns an embeddable BREP payload, so
 *  this needs the native app (a real filesystem path), like export. */
export async function importModel(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) {
    console.warn("import needs the native app (a real filesystem path)");
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    filters: [
      { name: "All supported", extensions: ["stl", "3mf", "step", "stp", "obj"] },
      { name: "STL", extensions: ["stl"] },
      { name: "3MF", extensions: ["3mf"] },
      { name: "STEP", extensions: ["step", "stp"] },
      { name: "OBJ", extensions: ["obj"] },
    ],
  });
  if (typeof path !== "string") return;
  await importPath(store, geometry, path);
}

/** Import a specific mesh / CAD file path as a new body. Shared by the Import
 *  Mesh command and by Open (when the chosen file isn't a .sindri document). */
async function importPath(store: DocumentStore, geometry: GeometryBackend, path: string) {
  const fmt = extToImportFormat(path);
  const res = await geometry.importGeometry(path, fmt);
  if (!res.ok) {
    await reportError(`Couldn't import ${path.split(/[\\/]/).pop()}: ${res.message ?? "unreadable file"}`);
    return;
  }
  store.addFeature({
    id: store.nextId(),
    type: "import",
    format: fmt,
    name: res.name,
    brep: res.brep,
    source: path,
    solid: res.solid,
  });
}

/** Surface an error to the user — a native dialog in the app, console otherwise.
 *  (Import used to fail silently, which read as "nothing happened".) */
async function reportError(msg: string) {
  if (isTauri()) {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(msg, { title: "SindriCAD", kind: "error" });
  } else {
    console.error(msg);
  }
}

function extToImportFormat(path: string): ImportFormat {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "stl") return "stl";
  if (ext === "3mf") return "3mf";
  if (ext === "obj") return "obj";
  if (ext === "brep") return "brep";
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
    input.accept = ".sindri,.json,application/json";
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
