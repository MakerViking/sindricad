// MCAD-style keymap, driven by the single shortcut table in shortcuts.ts —
// the app decides what each action does (main.ts dispatch). Ignores keystrokes
// while typing in inputs, with one exception: undo/redo aimed at an untouched
// tool dimension box (see undoBelongsToTheApp). Ctrl/Cmd combos handle
// undo/redo (file shortcuts are handled centrally in main.ts).

import { normalizeKey, resolveShortcut } from "./shortcuts";

/** Ctrl+Z / Ctrl+Y aimed at a 3D tool's on-canvas dimension box whose text has
 *  not changed since it took focus (DimInput marks it). There is no typing in
 *  there for the WebView's text history to undo, so the keystroke is the app's.
 *
 *  Without this exception undo was unreachable for the whole time a fillet,
 *  chamfer or extrude was open: those tools focus the box and re-assert focus on
 *  the next frame, and everything below ignores keystrokes aimed at an input —
 *  field report a0a76571, "even Undo does not work". */
function undoBelongsToTheApp(e: KeyboardEvent): boolean {
  if (!e.ctrlKey && !e.metaKey) return false;
  const k = e.key.toLowerCase();
  if (k !== "z" && k !== "y") return false;
  return (
    e.target instanceof HTMLInputElement &&
    e.target.getAttribute("data-undo-passthrough") === "1"
  );
}

export function installKeymap(
  onAction: (a: string) => void,
  context: () => "model" | "sketch",
) {
  window.addEventListener("keydown", (e) => {
    if (
      (e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)) &&
      !undoBelongsToTheApp(e)
    ) {
      return;
    }
    const k = e.key.toLowerCase();

    if (e.ctrlKey || e.metaKey) {
      if (k === "z" && !e.shiftKey) return onAction("undo"), e.preventDefault();
      if (k === "z" && e.shiftKey) return onAction("redo"), e.preventDefault();
      if (k === "y") return onAction("redo"), e.preventDefault();
      // file shortcuts (Ctrl+S/N/O/E) are handled centrally in main.ts
      return;
    }

    if (e.key === "Escape") return onAction("escape");

    // normalizeKey (shared with the rebind capture, so a key the settings panel
    // recorded is the same key this looks up) drops the shift flag on symbols
    // like "?" that only exist shifted.
    const { key, shift } = normalizeKey(e);
    const action = resolveShortcut(key, shift, context());
    if (action) {
      // Stop the keystroke from also landing in any input a tool focuses in
      // response (e.g. Press/Pull's dimension box) — otherwise "q" types into it.
      e.preventDefault();
      onAction(action);
    }
  });
}
