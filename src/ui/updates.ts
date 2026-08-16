// In-app updates via tauri-plugin-updater: the packaged app checks the rolling
// beta release's latest.json (assembled by the release job in
// .github/workflows/build.yml) and offers a one-click restart-and-update.
// Only meaningful where the updater can actually replace the install — the NSIS
// install on Windows, the .app on macOS, the AppImage on Linux — so the Rust
// `updates_supported` command gates deb/rpm installs (and plain-browser dev) out.
//
// What the gated-out installs are TOLD matters as much as the gate. This used to
// say "This install updates through your package manager, not in-app", which is
// not true: there is no apt or dnf repository. The .deb and .rpm exist only as
// GitHub release assets, so that advice sent people to a package manager with
// nothing to offer. Field report 383e7bfd is one of those installs (its sidecar
// spawns from /usr/lib/SindriCAD/, where an AppImage would run from /tmp/.mount_*)
// and sat on 0.1.111 for a week hitting three bugs already fixed in 0.1.117.

import { choose } from "./choice";
import { toast } from "./toast";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** The rolling beta release page: the only durable thing to send a human to.
 *  Asset filenames carry the stamped version (0.1.<run>), so no download link can
 *  be hardcoded, and the updater's own feed (releases/download/beta/latest.json,
 *  see tauri.conf.json) can't be read from the webview either because the CSP
 *  keeps connect-src on localhost. The tag is what stays put.
 *
 *  Opening it needs a matching entry in `opener:allow-open-url` in
 *  src-tauri/capabilities/default.json, or openUrl is refused and the button does
 *  nothing at all — advice that goes nowhere, one layer down. updates.test.ts
 *  pins that entry, and pins this repo against the updater endpoint. */
export const RELEASES_URL = "https://github.com/MakerViking/sindricad/releases/tag/beta";

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

/** the packaged app's version ("dev" in a plain-browser session). CI stamps
 *  packaged builds 0.1.<run>; local builds carry tauri.conf.json's 0.1.0. */
export async function appVersion(): Promise<string> {
  if (!isTauri()) return "dev";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown";
  }
}

/** Help → About: the one place to read off which version is running. */
export async function showAbout(): Promise<void> {
  const { listModal } = await import("./choice");
  await listModal("About SindriCAD", [`Version ${await appVersion()}`]);
}

/** Check the beta feed and prompt to install when an update exists. An available
 *  update always prompts; `interactive` additionally surfaces "up to date",
 *  "not applicable here", and failures (the quiet startup check stays silent). */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!isTauri()) {
    if (interactive) toast("Update checks need the packaged app");
    return;
  }
  if (!(await updatesSupported())) {
    if (interactive) {
      // Longer than the 3500ms default: two lines to read and a button to reach.
      toast(
        "The .deb and .rpm can't update in-app. Download the current build, or switch to the AppImage, which updates itself.",
        {
          timeout: 10000,
          // Imported here rather than at the top so this module keeps loading in
          // plain node (welcome.ts pulls in the TinkerAtlas client and an SVG at
          // module scope); that is what lets updates.test.ts import RELEASES_URL.
          action: {
            label: "Open downloads",
            onClick: () => void import("./welcome").then((m) => m.openExternal(RELEASES_URL)),
          },
        },
      );
    }
    return;
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (interactive) toast(`SindriCAD ${await appVersion()} is up to date.`);
      return;
    }
    const pick = await choose(`Update ${update.version} is available`, [
      { value: "install", label: "Restart & update" },
      { value: "later", label: "Later" },
    ]);
    if (pick !== "install") return;
    toast("Downloading the update…");
    await update.downloadAndInstall();
    // NOT the process plugin's relaunch(): it restarts without releasing the
    // single-instance lock, and the replacement process can start while this one
    // is still exiting, find the lock held, and quit on the spot. This command
    // drops the lock first (see restart_for_update in src-tauri/src/lib.rs).
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("restart_for_update");
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
