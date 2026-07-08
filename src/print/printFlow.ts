// Print-pipeline flows wired to ribbon actions:
//   openInOrca   — export a colored project 3MF to staging, open it in OrcaSlicer
//                  (Stage D.v1). The user slices + Upload&Prints from Orca, whose
//                  U1 preset already carries the printer host.
//   sendToPrinter — pick a sliced .gcode, map its filaments to the U1's loaded
//                  toolheads, upload + start, and monitor progress (Stage D direct
//                  send). In-app slicing (model→gcode) is a later round.

import { invoke } from "@tauri-apps/api/core";
import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { exportPrintProject } from "../io/files";
import { toast } from "../ui/toast";
import { filamentMappingDialog, type LogicalSlot } from "./printDialog";
import {
  activePrinterId,
  asPrinterError,
  onPrinterOffline,
  onPrinterStatus,
  printerFilaments,
  printerMonitorStart,
  printerUploadAndPrint,
  type ToolheadFilament,
} from "./printerClient";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** Stage D.v1: colored project 3MF → staging → OrcaSlicer GUI. */
export async function openInOrca(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) return;
  const stem = store.fileName.replace(/\.sindri$/i, "") || "part";
  let stagingPath: string;
  try {
    stagingPath = await invoke<string>("print_staging_path", { name: stem, ext: "3mf" });
  } catch (e) {
    toast(`Couldn't prepare export: ${String(e)}`, { kind: "error" });
    return;
  }
  // Flatten the user's active OrcaSlicer machine preset so the project OPENS on
  // the U1 (with its print host), not on "-". Non-fatal: without it the export
  // still carries the colors, but Orca won't bind the printer preset.
  let settings: Record<string, unknown> | undefined;
  try {
    settings = await invoke<Record<string, unknown>>("slicer_project_settings", {
      filamentCount: store.colorPalette.length,
    });
  } catch (e) {
    console.warn("slicer_project_settings failed — falling back to minimal settings:", e);
  }
  const written = await exportPrintProject(store, geometry, { path: stagingPath, settings });
  if (!written) return; // exportPrintProject already surfaced any error
  try {
    await invoke("slicer_open", { path: written });
    toast(
      settings
        ? "Opened in OrcaSlicer on your U1 preset — slice, then Upload & Print."
        : "Opened in OrcaSlicer — pick your U1 printer, slice, then Upload & Print.",
    );
  } catch (e) {
    toast(`Couldn't launch OrcaSlicer: ${String(e)}`, { kind: "error" });
  }
}

/** the palette slots this document actually prints (logical gcode tools). */
function usedSlots(store: DocumentStore): LogicalSlot[] {
  const palette = store.colorPalette as { name: string; color: string; material?: string }[];
  const used = new Set<number>();
  for (const v of Object.values(store.bodyColorsMap())) used.add(v);
  if (store.buildState.result?.bodies?.length) used.add(0); // unassigned → extruder 1
  if (!used.size) used.add(0);
  return [...used]
    .sort((a, b) => a - b)
    .map((i) => ({
      index: i,
      name: palette[i]?.name ?? `Filament ${i + 1}`,
      color: palette[i]?.color ?? "#808080",
      material: palette[i]?.material,
    }));
}

let statusUnlisten: (() => void) | null = null;

/** Stage D direct send: pick a sliced .gcode, map filaments, upload + start. */
export async function sendToPrinter(store: DocumentStore, _geometry: GeometryBackend) {
  if (!isTauri()) return;
  const id = activePrinterId();

  // pick the sliced gcode (from Orca) — the native dialog is the trust boundary.
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ filters: [{ name: "G-code", extensions: ["gcode"] }] });
  if (!picked || typeof picked !== "string") return;

  let toolheads: ToolheadFilament[];
  try {
    toolheads = await printerFilaments(id);
  } catch (e) {
    const pe = asPrinterError(e);
    toast(pe ? `Can't reach the printer: ${pe.message}` : `Printer error: ${String(e)}`, { kind: "error" });
    return;
  }

  const mapping = await filamentMappingDialog(usedSlots(store), toolheads);
  if (!mapping) return;

  const remoteName = picked.split(/[\\/]/).pop() || "part.gcode";
  try {
    await printerUploadAndPrint(id, picked, remoteName, mapping.mapTable, mapping.opts);
  } catch (e) {
    const pe = asPrinterError(e);
    if (pe?.code === "Busy") toast("Printer is busy — job not sent.", { kind: "error" });
    else if (pe?.code === "NozzleMismatch") toast(`Nozzle mismatch — ${pe.message}`, { kind: "error" });
    else if (pe?.code === "Unreachable") toast("Printer not reachable — is it on?", { kind: "error" });
    else toast(pe ? `Print rejected: ${pe.message}` : `Send failed: ${String(e)}`, { kind: "error" });
    return;
  }

  toast(`Sent ${remoteName} — printing`, { kind: "info" });
  void startMonitoring(id);
}

/** subscribe to Rust status frames → status line + terminal toast. Idempotent. */
async function startMonitoring(id: string) {
  const { setPrinterStatusText } = await import("./printStatusLine");
  statusUnlisten?.();
  const offStatus = await onPrinterStatus((s) => {
    if (s.id !== id) return;
    if (s.state === "printing" || s.state === "paused") {
      setPrinterStatusText(`${s.state === "paused" ? "Paused" : "Printing"} ${s.filename} — ${Math.round(s.progress * 100)}%`);
    } else {
      setPrinterStatusText(null);
      if (s.state === "complete") toast(`Print complete: ${s.filename}`, { kind: "info" });
      else if (s.state === "error") toast(`Print error on ${s.filename}`, { kind: "error" });
      cleanup();
    }
  });
  const offOffline = await onPrinterOffline((oid) => {
    if (oid !== id) return;
    setPrinterStatusText(null);
    toast("Lost connection to the printer.", { kind: "error" });
    cleanup();
  });
  const cleanup = () => {
    offStatus();
    offOffline();
    statusUnlisten = null;
  };
  statusUnlisten = cleanup;
  await printerMonitorStart(id);
}
