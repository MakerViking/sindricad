// Fusion-style keymap. Maps single keys to named actions; the app decides what
// each does. Ignores keystrokes while typing in inputs. Ctrl/Cmd combos handle
// undo/redo/save.

export type KeyAction =
  | "extrude"
  | "line"
  | "circle"
  | "rectangle"
  | "arc"
  | "fillet"
  | "chamfer"
  | "dimension"
  | "move"
  | "presspull"
  | "trim"
  | "palette"
  | "sketch"
  | "fit"
  | "escape"
  | "undo"
  | "redo"
  | "save";

const KEYS: Record<string, KeyAction> = {
  e: "extrude",
  l: "line",
  c: "circle",
  r: "rectangle",
  a: "arc",
  f: "fillet",
  d: "dimension",
  m: "move",
  q: "presspull",
  t: "trim",
  s: "sketch",
};

export function installKeymap(onAction: (a: KeyAction) => void) {
  window.addEventListener("keydown", (e) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable)
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
    if (k === "f" && e.shiftKey) return; // reserve
    if (k === "f") {
      // F is Fillet in Fusion; we also expose Fit on the dedicated button.
      e.preventDefault();
      return onAction("fillet");
    }
    const action = KEYS[k];
    if (action) {
      // Stop the keystroke from also landing in any input a tool focuses in
      // response (e.g. Press/Pull's dimension box) — otherwise "q" types into it.
      e.preventDefault();
      onAction(action);
    }
  });
}
