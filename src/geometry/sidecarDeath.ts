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

/** The one line every call refused after the halt carries: into the status bar,
 *  and into any caller that shows `error.message`. Deliberately constant so it
 *  is breadcrumbed once, not once per attempt. */
export const ENGINE_DOWN = "the geometry engine is not running; restart SindriCAD";

/** Where the user actually files a report, in the words the sentence below uses.
 *  NOT the Help menu: reporting is the floating round bug button that
 *  ui/bugReporter.ts mounts (`.bug-report-btn`, fixed to the bottom-right corner
 *  in styles.css), and its header says in so many words that it works with the
 *  sidecar dead, which is the only state this message is ever shown in. Naming
 *  Help instead sent the one person who most needs to be heard through a menu
 *  that has no such item. Pinned by engineDown.test.ts against the real button. */
const REPORT_HERE = "click the bug button in the bottom-right corner so I get the log";

/** The single sentence shown to the user, once, when the engine dies. */
export function sidecarDeathMessage(p: SidecarDeathPayload | null | undefined): string {
  // The sidecar's own `err:` line usually ends in a full stop, and this sentence
  // adds one after the parenthesis; without the trim the toast reads "giving up.).".
  const cause = (typeof p?.cause === "string" ? p.cause.trim() : "").replace(/\s*\.$/, "");
  const detail = cause ? ` (${cause})` : "";
  switch (p?.kind) {
    case "port_in_use":
      return `SindriCAD could not start its geometry engine: ${cause || "its port is already in use"}. `
        + "Another copy of SindriCAD may still be running. Close it and open SindriCAD again.";
    case "startup_failure":
      return `The geometry engine could not start${detail}. Modelling is unavailable until you `
        + `restart SindriCAD. If it happens again, ${REPORT_HERE}.`;
    default:
      return `The geometry engine crashed${detail}. Save your work, then restart SindriCAD.`;
  }
}
