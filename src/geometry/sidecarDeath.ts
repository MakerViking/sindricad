// What the user is told when the Rust shell reports the geometry engine gone
// (the `sidecar:died` event from src-tauri/src/sidecar.rs).
//
// Kept out of main.ts, and pure, because this sentence IS the bug report: field
// reports of a dead engine arrive as a screenshot of the toast, so the wording
// and the sidecar's own `err:` line have to survive into it. Reports 647aadcc /
// 91b20cce / a58966e5 (Windows 0.1.202) are the case that forced it — the engine
// exited at startup on an OpenBLAS allocation failure and the only thing the user
// ever saw was "geometry engine connection lost", over and over.

/** The `sidecar:died` payload. `kind` is "startup_failure", "port_in_use" or
 *  "crash"; anything unrecognised is treated as a crash. */
export interface SidecarDeathPayload {
  kind?: string;
  cause?: string;
}

/** The one line every call refused after the halt carries — into the status bar,
 *  and into any caller that shows `error.message`. Deliberately constant so it
 *  is breadcrumbed once, not once per attempt. */
export const ENGINE_DOWN = "the geometry engine is not running — restart SindriCAD";

/** The single sentence shown to the user, once, when the engine dies. */
export function sidecarDeathMessage(p: SidecarDeathPayload | null | undefined): string {
  const cause = typeof p?.cause === "string" ? p.cause.trim() : "";
  const detail = cause ? ` (${cause})` : "";
  switch (p?.kind) {
    case "port_in_use":
      return `SindriCAD could not start its geometry engine: ${cause || "its port is already in use"}. `
        + "Another copy of SindriCAD may still be running. Close it and open SindriCAD again.";
    case "startup_failure":
      return `The geometry engine could not start${detail}. Modelling is unavailable until you `
        + "restart SindriCAD — if it happens again, send a bug report from Help so I get the log.";
    default:
      return `The geometry engine crashed${detail}. Save your work, then restart SindriCAD.`;
  }
}
