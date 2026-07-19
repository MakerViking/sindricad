// In-app updates via tauri-plugin-updater: the packaged app checks the rolling
// beta release's latest.json (assembled by the release job in
// .github/workflows/build.yml) and offers a one-click restart-and-update.
// Only meaningful where the updater can actually replace the install — the NSIS
// install on Windows, the .app on macOS, the AppImage on Linux — so the Rust
// `updates_supported` command gates deb/rpm installs (and plain-browser dev) out.

import { choose } from "./choice";
import { toast } from "./toast";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** false outside Tauri, and on Linux unless running as an AppImage */
async function updatesSupported(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("updates_supported");
  } catch {
    return false;
  }
}

/** Check the beta feed and prompt to install when an update exists. An available
 *  update always prompts; `interactive` additionally surfaces "up to date",
 *  "not applicable here", and failures (the quiet startup check stays silent). */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!(await updatesSupported())) {
    if (interactive) toast("This install updates through your package manager, not in-app.");
    return;
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (interactive) toast("SindriCAD is up to date.");
      return;
    }
    const pick = await choose(`Update ${update.version} is available`, [
      { value: "install", label: "Restart & update" },
      { value: "later", label: "Later" },
    ]);
    if (pick !== "install") return;
    toast("Downloading the update…");
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    console.error("[updates] check/install failed:", err);
    if (interactive) {
      toast(`Update check failed: ${err instanceof Error ? err.message : String(err)}`, { kind: "error" });
    }
  }
}

/** Quiet startup check. Packaged builds only: dev builds carry version 0.1.0,
 *  which is always older than the rolling feed and would prompt on every run. */
export function scheduleStartupUpdateCheck(): void {
  if (import.meta.env.DEV) return;
  setTimeout(() => void checkForUpdates(false), 8000);
}
