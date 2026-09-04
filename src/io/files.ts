// File I/O: save/open the document JSON and export STEP/STL/3MF. Uses Tauri
// native dialogs + fs when running in the app; falls back to browser
// download/upload in a plain dev browser. Export always writes server-side: we
// get a path from the native save dialog and hand it to the sidecar, which
// writes the file directly (no fs round-trip through the webview).

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, ExportFormat, Feature, ImportFormat } from "../types";
import { clearRecovery } from "./recovery";
import { noteRecent } from "./recentFiles";

const isTauri = () => "__TAURI_INTERNALS__" in window;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every geometry hash the document references, and the mesh keys worth
 *  carrying. Rust turns these into container entries; the frontend collects them
 *  because it is the one that owns the document. */
function referencedHashes(store: DocumentStore): string[] {
  const out = new Set<string>();
  for (const f of store.document.features ?? []) {
    if (f.type === "import" && f.geom) out.add(f.geom);
  }
  return [...out];
}

/** Write the document as a container at `path`. Returns an error message, or
 *  null on success.
 *
 *  Goes through Rust, NOT the sidecar: `sidecar.rs` does not auto-respawn, so a
 *  save that needed the geometry engine would be impossible for the whole rest
 *  of the session once it died — with unsaved work on screen. Saving needs no
 *  geometry anyway; the blobs are already bytes on disk. */
async function writeContainer(store: DocumentStore, path: string): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("container_save", {
      path,
      documentJson: store.toJSON(),
      hashes: referencedHashes(store),
      meshKeys: [],
    });
    return null;
  } catch (e) {
    return errMsg(e);
  }
}

/** Save: write to the current path if known, else behave like Save As. */
export async function saveDocument(store: DocumentStore) {
  if (isTauri() && store.filePath) {
    const err = await writeContainer(store, store.filePath);
    if (err) {
      await reportError(`Couldn't save ${store.filePath}: ${err}`);
      return;
    }
    store.markSaved(store.filePath);
    noteRecent(store.filePath);
    void clearRecovery(store.filePath); // the on-disk file is now the truth
  } else {
    await saveDocumentAs(store);
  }
}

/** Save As: always prompt for a path (or download in a plain browser). */
export async function saveDocumentAs(store: DocumentStore) {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      filters: [{ name: "SindriCAD Document", extensions: ["sindri"] }],
      defaultPath: store.filePath ?? `${store.fileName}.sindri`,
    });
    if (path) {
      const err = await writeContainer(store, path);
      if (err) {
        await reportError(`Couldn't save ${path}: ${err}`);
        return;
      }
      store.markSaved(path);
      noteRecent(path);
      void clearRecovery(path);
    }
  } else {
    // Plain dev browser: no Tauri, so no container. Geometry lives in the
    // sidecar's blob store either way, so this download is the document only —
    // useful for inspecting a feature tree, NOT a portable file.
    downloadText(`${store.fileName}.sindri`, store.toJSON());
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
        { name: "All supported", extensions: ["sindri", "json", "stl", "3mf", "step", "stp", "obj", "glb"] },
        { name: "SindriCAD Document", extensions: ["sindri", "json"] },
        { name: "Mesh / CAD", extensions: ["stl", "3mf", "step", "stp", "obj", "glb"] },
      ],
    });
    if (typeof path !== "string") return;
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "sindri" || ext === "json") {
      await openDocumentAtPath(store, path, geometry);
    } else {
      await importPath(store, geometry, path); // a mesh / CAD file → import as a body
    }
  } else {
    const text = await uploadText();
    if (text) {
      try {
        store.load(text);
      } catch (e) {
        await reportError(`Couldn't open document: ${errMsg(e)}`);
      }
    }
  }
}

/** What happened when we tried to open a document.
 *  "unreadable" means the file is gone or corrupt — callers may forget it.
 *  "newerFormat" means the file is fine and this build is too old, so the
 *  recent-files entry must SURVIVE: dropping it would delete the one affordance
 *  the user has for finding the file again, in the same breath as telling them
 *  to upgrade. */
export type OpenOutcome = "ok" | "unreadable" | "newerFormat";

/** True if `text` is a ZIP archive rather than JSON — i.e. a v5 packaged
 *  document this build cannot read.
 *
 *  `readTextFile` decodes with a NON-FATAL TextDecoder, so a zip's invalid bytes
 *  become U+FFFD instead of throwing: the read SUCCEEDS and `JSON.parse` is what
 *  fails. The local-file header is pure ASCII ("PK" followed by two control
 *  bytes), so it survives that decode intact and we can diagnose from the text
 *  we already hold — no second read, and no binary fs permission (the webview
 *  has none, by design). Matching on "PK" alone is deliberate: it also catches
 *  the empty and spanned-archive headers, and anything starting "PK" is not a
 *  JSON document regardless. */
export function looksLikeContainer(text: string): boolean {
  return text.startsWith("PK");
}

/** Rewrite a pre-v5 document's inline base64 BREP into blob-store references.
 *  Returns the original text unchanged on ANY failure — this is an optimisation
 *  of the on-disk format, never a precondition for opening a file. */
async function migrateInlineGeometry(text: string, geometry: GeometryBackend): Promise<string> {
  try {
    const doc = JSON.parse(text) as CadDocument;
    const legacy = (doc.features ?? []).filter(
      (f): f is Extract<Feature, { type: "import" }> =>
        f.type === "import" && typeof f.brep === "string" && !f.geom,
    );
    if (!legacy.length) return text;

    const migrated = await geometry.migrateGeometry(
      legacy.map((f) => ({ id: f.id, brep: f.brep as string })),
    );
    if (!migrated.length) return text;

    const byId = new Map(migrated.map((m) => [m.id, m.geom]));
    for (const f of doc.features ?? []) {
      if (f.type !== "import") continue;
      const geom = byId.get(f.id);
      // Only drop the inline copy for features that actually got a hash; a body
      // that failed to migrate keeps its base64 and still rebuilds.
      if (geom) {
        f.geom = geom;
        delete f.brep;
      }
    }
    return JSON.stringify(doc);
  } catch {
    return text;
  }
}

/** Open a .sindri/.json document at a known path (no dialog) — shared by Open…
 *  and the welcome screen's recent-files list.
 *
 *  A v5 document is a ZIP and is read by Rust, which also extracts its geometry
 *  into the blob store before returning. A pre-v5 document is plain JSON and is
 *  read as text exactly as it always was.
 *
 *  NOTE on ordering: `store.load()` ends by firing a rebuild SYNCHRONOUSLY,
 *  before `markSaved(path)` below has run — so that first rebuild sees the
 *  PREVIOUS document's path. That is harmless here only because geometry is
 *  resolved by content hash out of the blob store, which needs no path at all.
 *  Do not add anything to the rebuild path that depends on `store.filePath`. */
export async function openDocumentAtPath(
  store: DocumentStore,
  path: string,
  geometry?: GeometryBackend,
): Promise<OpenOutcome> {
  const base = path.split(/[\\/]/).pop();
  const { invoke } = await import("@tauri-apps/api/core");
  let text: string;
  let wasContainer = false;
  try {
    wasContainer = await invoke<boolean>("container_is_container", { path });
    text = wasContainer
      ? await invoke<string>("container_open", { path })
      : await (await import("@tauri-apps/plugin-fs")).readTextFile(path);
  } catch (e) {
    // Rust's container errors are already user-facing sentences (a newer
    // container format, a damaged archive, geometry that does not match its
    // manifest), so pass them through rather than wrapping them in ours.
    await reportError(`Couldn't open ${base}: ${errMsg(e)}`);
    return "unreadable";
  }
  // One-way v4 -> v5, done on the PARSED text before `load()` rather than by
  // patching the store afterwards: patching would record an undo entry, mark a
  // freshly-opened document dirty, and fire a second rebuild. If anything here
  // fails — a dead sidecar, an unreadable legacy body — `text` is untouched and
  // the document opens exactly as it did before, still carrying its inline copy.
  if (!wasContainer && geometry) text = await migrateInlineGeometry(text, geometry);

  try {
    // Throws before mutating anything: load() parses first (store.ts), so a
    // file we can't read leaves the open document untouched.
    store.load(text);
  } catch (e) {
    if (looksLikeContainer(text)) {
      await reportError(
        `${base} was saved by a newer version of SindriCAD, which stores geometry in a ` +
          `packaged document this build can't read. Update SindriCAD to open it.`,
      );
      return "newerFormat";
    }
    await reportError(`Couldn't open ${base}: ${errMsg(e)}`);
    return "unreadable";
  }
  store.markSaved(path); // freshly opened == clean, with a known path
  noteRecent(path);
  return "ok";
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
      { name: "GLB (glTF)", extensions: ["glb"] },
    ],
    // "separate" derives one file per body as "<base>-<body>.<ext>", so name the base.
    defaultPath: opts.separate ? "parts.step" : "part.step",
  });
  if (!path) return;
  const fmt = extToFormat(path);
  // GLB carries one material per body, so it needs the palette and each body's
  // slot; the other formats ignore both.
  // Wrapped exactly like importPath's runBusy below, and for the same reason:
  // an export replays the whole feature history, so on a large document it runs
  // for as long as an import does with nothing on screen to show it and nothing
  // for Cancel to attach to. onStarted hands back the request id so a cancel
  // targets THIS export — the document stays editable meanwhile, so any rebuild
  // the user triggers would otherwise be the "most recent" op.
  const res = await store.runBusy(
    `Exporting ${path.split(/[\\/]/).pop() ?? "file"}`,
    (onStarted) => geometry.export(store.document, fmt, path, {
      ...opts,
      palette: store.colorPalette,
      bodyColors: store.bodyColorsMap(),
    }, onStarted),
  );
  if (!res.ok) {
    // The user stopped it: they know, so say nothing. Reporting their own
    // action back as "Export failed: cancelled" is the bug this avoids.
    if (res.cancelled) return;
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

export function extToFormat(path: string): ExportFormat {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "stl") return "stl";
  if (ext === "3mf") return "3mf";
  // NOTE: this function is TOTAL — an unrecognised extension falls through to
  // STEP rather than erroring. Miss a format here and the user gets a STEP file
  // wearing the extension they asked for, with no error anywhere.
  if (ext === "glb") return "glb";
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

  if (!(await confirmUnassignedPalette(store, bodies.map((b) => b.id)))) return null;

  // Same busy/cancel treatment as exportModel and importPath — this path
  // tessellates every body at export grade before writing the project, so it is
  // every bit as long-running as a plain export on a large document.
  const res = await store.runBusy(
    `Exporting ${path.split(/[\\/]/).pop() ?? "project"}`,
    (onStarted) => geometry.exportProject!(store.document, path, {
      palette: store.colorPalette,
      bodyColors: store.bodyColorsMap(),
      bodyNames: store.bodyNamesMap(),
      settings: { ...U1_PROJECT_SETTINGS, ...(opts.settings ?? {}) },
    }, onStarted),
  );
  if (!res.ok) {
    if (res.cancelled) return null;  // the user stopped it — not an error
    await reportError(`Print export failed: ${res.message ?? "unknown error"}`);
    return null;
  }
  void warnPrintAssignments(store, bodies.map((b) => b.id));
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

/** Ask before exporting a project that curates colors but assigns none.
 *
 *  A palette entry paints nothing on its own: color is per BODY, bound by
 *  right-clicking a body (Browser row or viewport) and picking a slot. Someone
 *  who has built a four-slot palette has plainly said "I want multi-color", so
 *  exporting that as one object on extruder 1 is worth a question — the toast
 *  after the fact arrives once Orca is already open, which is where this was
 *  field-reported.
 *
 *  Gated on a CUSTOMISED palette so it cannot nag the ordinary single-color
 *  export: an untouched default palette with no assignments is just a plain
 *  print, not a mistake. Returns false only if the user cancels. */
async function confirmUnassignedPalette(store: DocumentStore, bodyIds: string[]): Promise<boolean> {
  if (!needsUnassignedConfirm(store, bodyIds)) return true;
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(
    "No body is assigned to a palette slot, so this will print in a single color.\n\n" +
      "Assign colors by right-clicking a body — in the Browser list or in the viewport — and picking a slot.",
    { title: "Export without colors?", kind: "warning", okLabel: "Export anyway", cancelLabel: "Cancel" },
  );
}

/** Does any built face carry a palette slot of its own? Today that means a
 *  texture feature's `colorSlot`, surfaced per face by the sidecar as
 *  `textureColorSlots` and painted in the viewport by main.ts's
 *  computeTexturePaint. */
function hasFacePaint(store: DocumentStore): boolean {
  for (const b of store.buildState.result?.bodies ?? []) {
    if (b.textureColorSlots?.some((s) => s != null)) return true;
  }
  return false;
}

/** The decision behind that prompt, split out so it is testable without a
 *  dialog: a curated palette, and no color assigned ANYWHERE.
 *
 *  Face-level color counts. A texture feature's `colorSlot` is a real assignment
 *  that the viewport paints and — since the project writer learned per-triangle
 *  `paint_color` — the export now carries too, so a document colored entirely
 *  that way must not be told it "will print in a single color". Warning on it
 *  would be this prompt's own defect pointing the other way. */
export function needsUnassignedConfirm(store: DocumentStore, bodyIds: string[]): boolean {
  if (store.paletteIsDefault()) return false;
  if (!bodyIds.length) return false;
  if (hasFacePaint(store)) return false;
  return slotUsage(store, bodyIds).unassigned === bodyIds.length;
}

/** Which palette slots this set of bodies prints on, and how many bodies carry
 *  no assignment at all (project3mf sends those to slot 0 / extruder 1). Pure
 *  local state — no printer, no await. */
function slotUsage(store: DocumentStore, bodyIds: string[]): { usedSlots: Set<number>; unassigned: number } {
  const assigned = store.bodyColorsMap();
  const usedSlots = new Set<number>();
  let unassigned = 0;
  for (const id of bodyIds) {
    const slot = assigned[id];
    if (slot == null) {
      unassigned++;
      usedSlots.add(0); // project3mf defaults unassigned bodies to slot 0
    } else {
      usedSlots.add(slot);
    }
  }
  return { usedSlots, unassigned };
}

/** Used slots whose toolhead has no filament loaded. Best-effort and bounded to
 *  1.5s client-side (the shared Rust HTTP client has a 10s timeout — a warning
 *  arriving that late is worse than none). An unreachable, slow or unconfigured
 *  printer yields [] meaning UNKNOWN, never "empty". */
async function emptyPrinterSlots(usedSlots: Set<number>): Promise<number[]> {
  try {
    const { activePrinterId, printerFilaments } = await import("../print/printerClient");
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500));
    const filaments = await Promise.race([printerFilaments(activePrinterId()), timeout]);
    return [...usedSlots].filter((s) => !filaments[s]?.present).sort((a, b) => a - b);
  } catch {
    return []; // printer offline/slow/unconfigured — best-effort by design
  }
}

/** Post-export check: warn when bodies went out unassigned (they print as
 *  extruder 1), or when a used slot has no filament loaded on the printer.
 *
 *  The two halves are deliberately INDEPENDENT. The unassigned count is pure
 *  local state and must be reported whether or not a printer answers. It used to
 *  be computed inside the printer probe's `try`, after an `await` that rejects
 *  on a 1.5s timeout, so an offline, slow or unconfigured U1 swallowed the one
 *  warning that needs no printer at all — the export went out monochrome and
 *  said nothing. Field-reported: a curated four-slot palette, zero assignments,
 *  one object on extruder 1, no warning anywhere. Never blocks or fails the
 *  export itself. */
export async function warnPrintAssignments(store: DocumentStore, bodyIds: string[]) {
  const { usedSlots, unassigned } = slotUsage(store, bodyIds);
  const empty = await emptyPrinterSlots(usedSlots);
  if (!empty.length && !unassigned) return;
  const parts: string[] = [];
  if (empty.length) {
    parts.push(`slot${empty.length > 1 ? "s" : ""} ${empty.map((s) => s + 1).join(", ")} ha${empty.length > 1 ? "ve" : "s"} no filament loaded on the printer`);
  }
  if (unassigned) parts.push(`${unassigned} bod${unassigned > 1 ? "ies are" : "y is"} unassigned (defaulting to slot 1)`);
  const { toast } = await import("../ui/toast");
  toast(`Exported, but ${parts.join("; ")}.`, { kind: "warning" });
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
      { name: "All supported", extensions: ["stl", "3mf", "step", "stp", "obj", "glb"] },
      { name: "STL", extensions: ["stl"] },
      { name: "3MF", extensions: ["3mf"] },
      { name: "STEP", extensions: ["step", "stp"] },
      { name: "OBJ", extensions: ["obj"] },
      { name: "GLB (glTF)", extensions: ["glb"] },
    ],
  });
  if (typeof path !== "string") return;
  await importPath(store, geometry, path);
}

/** Nearest palette slot to a '#RRGGBB' colour, by squared RGB distance, or null
 *  when the palette is empty or the colour is unparseable.
 *
 *  Deliberately MATCHES rather than extends. The palette is the U1's filament
 *  list — four physical slots — not a display palette, so a slot means "print
 *  this in filament N". Auto-adding an imported model's colour would claim a
 *  filament the printer doesn't have loaded. */
export function nearestPaletteSlot(
  hex: string,
  palette: { name: string; color: string }[],
): number | null {
  const rgb = (s: string): [number, number, number] | null => {
    const t = s.trim().replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(t)) return null;
    return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
  };
  const want = rgb(hex);
  if (!want || !palette.length) return null;
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const got = rgb(palette[i]?.color ?? "");
    if (!got) continue;
    const d = (want[0] - got[0]) ** 2 + (want[1] - got[1]) ** 2 + (want[2] - got[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The path of the most recently CANCELLED import, so a retry is one click.
 *  Session state on purpose — it never touches the document, so nothing about a
 *  cancelled import can be saved, shared, or opened on another machine. */
let lastCancelledImport: string | null = null;

/** The path a cancelled import used, or null. */
export function cancelledImportPath(): string | null {
  return lastCancelledImport;
}

// Viewport capability, MEASURED post-Phase-A on real WebKitGTK: about 60 fps at
// 1,000 bodies, falling to 27-37 fps at 3,060. The residual is draw-call bound
// at 2 calls per body, which is why the threshold is a BODY count and not a
// triangle count. Merging draw calls across bodies is the only lever left and it
// breaks three shipped invariants (per-body `.visible`, etag reuse, move-ghost
// translation), so these numbers are the honest limit rather than a bug.
const SMOOTH_BODY_LIMIT = 1000;
const SLOW_BODY_LIMIT = 3000;

/** What to tell the user about a document this size, or null when it will be
 *  fine. Separated from the import flow so the thresholds can be tested without
 *  a dialog, a backend or a viewport.
 *
 *  The point is to say what the document will be like BEFORE the viewport is
 *  built. The counts are known at import time, so the alternative to saying it
 *  is letting the user discover it as a freeze and conclude the app is broken. */
export function describeImportCapability(bodies: number): string | null {
  if (!Number.isFinite(bodies) || bodies <= SMOOTH_BODY_LIMIT) return null;
  const n = bodies.toLocaleString();
  if (bodies <= SLOW_BODY_LIMIT) {
    return `Imported ${n} bodies. The 3D view is smooth to about ${SMOOTH_BODY_LIMIT.toLocaleString()} bodies, so orbiting may lag a little. Everything still works.`;
  }
  return `Imported ${n} bodies. Expect the 3D view to be slow: measured 27-37 fps at ${SLOW_BODY_LIMIT.toLocaleString()} bodies against 60 at ${SMOOTH_BODY_LIMIT.toLocaleString()}. Modelling, export and printing are unaffected.`;
}

/** Bodies an import feature will produce: one per assembly leaf, or a single
 *  body when the file carried no tree. */
export function importedBodyCount(res: { parts?: { node: number; faces: number }[] }): number {
  return res.parts?.length ?? 1;
}

// Why the sidecar did not fit curved surfaces, in the user's words. Kept as a
// map so an unknown reason (a sidecar newer than this build) stays SILENT rather
// than surfacing as a half-sentence about a reason this build cannot name.
//
// ONLY "checks" IS REACHABLE TODAY. The sidecar's `_fit_surfaces` writes that
// one reason and no other: a fit that simply found nothing curved returns the
// body unchanged and says nothing, because "there was nothing to recognise" is
// not news. The other two are the plan's reason set, kept here so a newer
// sidecar that grows a density screen renders correctly with no frontend
// change. Neither has ever been sent, so neither has been seen by a user; if
// one is wired up, re-check its wording against what that screen actually does
// before shipping it.
const FIT_SKIP_REASONS: Record<string, string> = {
  // forward compatibility only, see above
  dense: "This mesh is too dense for me to look for curved surfaces, so every face stayed faceted.",
  coarse: "This mesh is too coarse to tell a curve from a corner, so every face stayed faceted.",
  // the fit built, then failed a geometry gate (volume, watertightness, validity)
  checks: "I found curved surfaces here, but the rebuilt body did not pass its checks, so I kept the faceted import.",
};

function isCount(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** What to tell the user about surface fitting on a mesh import, or null when
 *  there is nothing to say. Pure, so the wording can be tested without a
 *  backend, a file or a toast.
 *
 *  Fitting is invisible otherwise: a faceted import and a fitted one both "work",
 *  and the user only finds out which they got when press/pull refuses on a wall
 *  that is still tessellation. So an import that came back partly faceted has to
 *  say so, with both counts, and one that recognised nothing at all has to stay
 *  quiet rather than announcing a zero on the path that has not changed.
 *
 *  THE SILENCE IS DELIBERATE AND THE RELEASE NOTES SAY SO. A mesh whose curves
 *  are all cones or spheres comes back with fitted 0, no skip reason, and no
 *  toast, on a body where most faces will refuse Press/Pull. The CHANGELOG used
 *  to promise "a message after the import" flat, which was untrue for exactly
 *  that import; it now promises one only when something was recognised. If this
 *  is ever changed to speak up on fitted 0, the branch belongs AFTER the
 *  fitSkipped lookup below, not before it: a declined fit has faceted > 0 too,
 *  and preempting it would replace a true sentence with a false one. */
export function describeSurfaceFit(res: { fitted?: number; faceted?: number; fitSkipped?: string }): string | null {
  if (isCount(res.fitted) && res.fitted > 0) {
    const n = res.fitted.toLocaleString();
    const found = res.fitted === 1 ? `Recognised 1 curved surface.` : `Recognised ${n} curved surfaces.`;
    // A leftover count the sidecar did not send (or sent as nonsense) is not
    // worth guessing at: say what was recognised and stop.
    if (!isCount(res.faceted)) return found;
    if (res.faceted === 0) return `${found} No faces stayed faceted.`;
    const m = res.faceted.toLocaleString();
    const rest = res.faceted === 1 ? `1 face stayed faceted.` : `${m} faces stayed faceted.`;
    return `${found} ${rest}`;
  }
  return res.fitSkipped ? FIT_SKIP_REASONS[res.fitSkipped] ?? null : null;
}


async function importPath(store: DocumentStore, geometry: GeometryBackend, path: string) {
  const fmt = extToImportFormat(path);
  // runBusy is what makes the operation VISIBLE and stoppable: an import used to
  // run with no busy state at all, so the timeline showed nothing and there was
  // nothing for a Cancel button to attach to. onStarted hands back the request
  // id so a cancel targets this import specifically.
  const res = await store.runBusy(
    `Importing ${path.split(/[\\/]/).pop() ?? "file"}`,
    (onStarted) => geometry.importGeometry(path, fmt, onStarted),
  );
  if (!res.ok) {
    if (res.cancelled) {
      // The user stopped it: say nothing (they know) and add NOTHING to the
      // document. The path is remembered in SESSION state only — a placeholder
      // feature would persist into the saved .sindri and reference a path that
      // may not exist on another machine.
      lastCancelledImport = path;
      return;
    }
    await reportError(`Couldn't import ${path.split(/[\\/]/).pop()}: ${res.message ?? "unreadable file"}`);
    return;
  }
  lastCancelledImport = null;
  const id = store.nextId();
  store.addFeature({
    id,
    type: "import",
    format: fmt,
    name: res.name,
    geom: res.geom,
    source: path,
    solid: res.solid,
    ...(res.color !== undefined ? { color: res.color } : {}),
    // the file's assembly tree, when it had one. Spread the same way `color` is,
    // so an import with no tree produces exactly the feature it always did.
    ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
    ...(res.parts !== undefined ? { parts: res.parts } : {}),
  });

  // Say what the document will be like while the user is still deciding what to
  // do with it, rather than letting them discover it as a freeze and conclude
  // the app is broken. Non-blocking on purpose: this is a heads-up about a
  // measured limit, not a refusal, and everything except orbiting is unaffected.
  const capability = describeImportCapability(importedBodyCount(res));
  // What the fitter made of the mesh. Second toast rather than one merged
  // sentence: the two are about different things (how the document will FEEL vs
  // what it is made of), and either can be absent.
  const surfaces = describeSurfaceFit(res);
  if (capability || surfaces) {
    const { toast } = await import("../ui/toast");
    if (capability) toast(capability, { kind: "info" });
    if (surfaces) toast(surfaces, { kind: "info" });
  }

  // Carry the file's own colour onto the body it produced. The body doesn't
  // exist until the rebuild runs, and its id is positional, so wait for the
  // build and find the bodies this feature owns via faceOwners. setBodyColorSlot
  // is a display-only overlay write, so this adds no second undo step.
  if (res.color === undefined) return;
  const slot = nearestPaletteSlot(res.color, store.colorPalette);
  if (slot === null) return;
  await store.rebuildNow();
  for (const b of store.buildState.result?.bodies ?? []) {
    if (b.faceOwners?.some((owner) => owner === id)) store.setBodyColorSlot(b.id, slot);
  }
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

export function extToImportFormat(path: string): ImportFormat {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "stl") return "stl";
  if (ext === "3mf") return "3mf";
  if (ext === "obj") return "obj";
  if (ext === "brep") return "brep";
  if (ext === "glb") return "glb";
  return "step";  // TOTAL, like extToFormat above — see the note there
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
