// Typed wrappers over the Rust printer/slicer commands (see src-tauri/src/
// printer.rs, slicer.rs). The webview addresses printers by id only — Rust owns
// the host registry, so this module never sees a LAN URL.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PrinterKind = "MoonrakerU1" | "Moonraker";

export interface PrinterConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  kind: PrinterKind;
}

export interface ToolheadFilament {
  index: number;
  vendor: string;
  material: string;
  sub_type: string;
  color: string; // "#RRGGBB"
  present: boolean;
}

export interface PrintStatus {
  state: string; // printing | paused | complete | standby | error | ...
  filename: string;
  progress: number; // 0..1
  print_duration: number;
  total_duration: number;
}

export interface ProbeInfo {
  online: boolean;
  klippy_state: string;
  moonraker_version: string;
}

export interface StartOpts {
  bedLevel: boolean;
  flowCalibrate: boolean;
  timeLapseCamera: boolean;
}

// The Rust side returns Err({code, message}); surface both so callers can toast.
export interface PrinterError {
  code: "Unreachable" | "Busy" | "NozzleMismatch" | "Rejected" | "Protocol" | "Config";
  message: string;
}

export function printersList(): Promise<PrinterConfig[]> {
  return invoke("printers_list");
}
export function printersUpsert(cfg: PrinterConfig): Promise<void> {
  return invoke("printers_upsert", { cfg });
}
export function printersRemove(id: string): Promise<void> {
  return invoke("printers_remove", { id });
}
export function printerProbe(id: string): Promise<ProbeInfo> {
  return invoke("printer_probe", { id });
}
export function printerFilaments(id: string): Promise<ToolheadFilament[]> {
  return invoke("printer_filaments", { id });
}
export function printerStatus(id: string): Promise<PrintStatus> {
  return invoke("printer_status", { id });
}
/** map_table = [logical extruder (gcode Tn), physical toolhead] pairs. */
export function printerUploadAndPrint(
  id: string,
  gcodePath: string,
  remoteName: string,
  mapTable: [number, number][],
  opts: StartOpts,
): Promise<void> {
  return invoke("printer_upload_and_print", { id, gcodePath, remoteName, mapTable, opts });
}
export function printerMonitorStart(id: string): Promise<void> {
  return invoke("printer_monitor_start", { id });
}
export function printerMonitorStop(id: string): Promise<void> {
  return invoke("printer_monitor_stop", { id });
}

/** live status frames pushed by the Rust monitor (2 s cadence while printing). */
export function onPrinterStatus(fn: (e: PrintStatus & { id: string }) => void): Promise<UnlistenFn> {
  return listen<PrintStatus & { id: string }>("printer:status", (ev) => fn(ev.payload));
}
export function onPrinterOffline(fn: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>("printer:offline", (ev) => fn(ev.payload));
}

// --- active-printer selection (display concern → localStorage) ----------------

const ACTIVE_KEY = "sindri.activePrinter";
export function activePrinterId(): string {
  return localStorage.getItem(ACTIVE_KEY) || "u1";
}
export function setActivePrinterId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

/** true when Err looks like a PrinterError (shape from the Rust command). */
export function asPrinterError(e: unknown): PrinterError | null {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as PrinterError;
  return null;
}
