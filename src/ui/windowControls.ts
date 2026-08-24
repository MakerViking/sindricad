// The window buttons SindriCAD draws for itself.
//
// The window is undecorated (`"decorations": false` in tauri.conf.json), so the
// OS contributes no title bar: #titlebar IS the title bar. That was the point —
// the KDE decoration was a second ~65px strip sitting above a row that already
// showed the brand, the menus and the document name, and its height belongs to
// the window manager, so the only way to reclaim it was to stop asking for it.
//
// What we take on in exchange, and where each half lives:
//   - DRAGGING and double-click-to-maximize: Tauri's own drag.js, driven by the
//     `data-tauri-drag-region` attributes in index.html. Nothing here.
//   - MINIMIZE / MAXIMIZE / CLOSE: the buttons below.
//   - RESIZING: `mountResizeEdges`, and it is NOT optional on Linux. tao's
//     Linux backend implements set_decorations as a bare
//     `gtk_window_set_decorated(false)` (platform_impl/linux/event_loop.rs), and
//     Tauri ships no resize script of its own, so GTK's client-side resize
//     border goes away with the titlebar and the window becomes immovably sized.
//     Tauri 2 handles this natively on Windows and NSWindow does on macOS, hence
//     the platform gate.
//
// Every command here needs a capability that `core:default` does NOT grant —
// see src-tauri/capabilities/default.json. `core:window:default` covers only
// read-only introspection plus internal-toggle-maximize; without the explicit
// allow-minimize / allow-toggle-maximize / allow-close / allow-start-dragging /
// allow-start-resize-dragging the buttons fail silently, which is the failure
// mode to remember if this ever "does nothing".
import { getCurrentWindow } from "@tauri-apps/api/window";

import { icon } from "./icons";

/** Running inside Tauri? The browser harnesses load the same bundle and must not
 *  grow three buttons that cannot work. Same probe as io/recovery.ts. */
const isTauri = () => "__TAURI_INTERNALS__" in window;

/** The eight directions, as the CSS class suffix and the value
 *  `startResizeDragging` expects. */
const EDGES = [
  ["n", "North"], ["s", "South"], ["e", "East"], ["w", "West"],
  ["ne", "NorthEast"], ["nw", "NorthWest"], ["se", "SouthEast"], ["sw", "SouthWest"],
] as const;

/** Invisible grab strips around the window, one per direction. */
function mountResizeEdges(host: HTMLElement) {
  const win = getCurrentWindow();
  for (const [dir, direction] of EDGES) {
    const grip = document.createElement("div");
    grip.className = `resize-edge resize-${dir}`;
    // pointerdown, not mousedown: the drag has to start before any click
    // completes, and preventDefault stops the press also landing on whatever
    // sits under the strip (the ribbon's top row runs right up to it).
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void win.startResizeDragging(direction);
    });
    host.appendChild(grip);
  }
}

/**
 * Append minimize / maximize / close to the title bar, and the resize edges to
 * the document. No-op outside Tauri.
 */
export function mountWindowControls(titlebar: HTMLElement) {
  if (!isTauri()) return;
  const win = getCurrentWindow();

  const group = document.createElement("div");
  group.className = "window-controls";

  const btn = (name: "minimize" | "maximize" | "close", label: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = `win-btn win-${name}`;
    b.type = "button";
    // Icon-only, so it carries its own accessible name — icon() marks the glyph
    // aria-hidden precisely because the label belongs to the control.
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = icon(name);
    b.addEventListener("click", onClick);
    group.appendChild(b);
    return b;
  };

  btn("minimize", "Minimize", () => void win.minimize());
  const maxBtn = btn("maximize", "Maximize", () => void win.toggleMaximize());
  btn("close", "Close", () => void win.close());

  // Keep the middle button honest about what it will do. Driven off the window's
  // own resize event rather than off our click, so a maximize from the WM — a
  // double-click on the bar, a keyboard shortcut, tiling — updates it too.
  const syncMaxIcon = async () => {
    const max = await win.isMaximized();
    maxBtn.innerHTML = icon(max ? "restore" : "maximize");
    const label = max ? "Restore" : "Maximize";
    maxBtn.setAttribute("aria-label", label);
    maxBtn.title = label;
  };
  void syncMaxIcon();
  void win.onResized(() => void syncMaxIcon());

  titlebar.appendChild(group);

  // Windows resizes undecorated windows natively (Tauri 2), and macOS never lost
  // the ability; only Linux needs the strips. Adding them everywhere would put a
  // second, competing handler over the platform's own.
  if (navigator.userAgent.includes("Linux")) mountResizeEdges(document.body);
}
