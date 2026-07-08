// Single command registry — the source of truth for the Cmd-K command palette
// (and a searchable list of everything you can do). Built from the ribbon's tool
// groups plus the global File/View commands that live in menus / view controls.
// Key hints come from the shortcut table (src/input/shortcuts.ts) so the palette
// can never advertise a key the keymap doesn't actually bind (it used to claim
// Fit was on "F" while F ran Fillet).

import { MODEL, SKETCH, leavesOf, type Group } from "./ribbon";
import { keyHint } from "../input/shortcuts";

export interface Command {
  id: string; // the action id passed to the central dispatcher (handleAction)
  label: string;
  group: string; // shown as a subtle category in the palette
  context: "model" | "sketch" | "global";
  key?: string; // display hint
}

// File + View commands that aren't in the ribbon (menus / floating view controls).
const GLOBAL: Command[] = [
  { id: "new", label: "New", group: "File", context: "global", key: "Ctrl+N" },
  { id: "open", label: "Open…", group: "File", context: "global", key: "Ctrl+O" },
  { id: "save", label: "Save", group: "File", context: "global", key: "Ctrl+S" },
  { id: "saveas", label: "Save As…", group: "File", context: "global", key: "Ctrl+Shift+S" },
  { id: "export", label: "Export…", group: "File", context: "global", key: "Ctrl+E" },
  { id: "import", label: "Import Mesh…", group: "File", context: "global" },
  { id: "undo", label: "Undo", group: "Edit", context: "global", key: "Ctrl+Z" },
  { id: "redo", label: "Redo", group: "Edit", context: "global", key: "Ctrl+Y" },
  { id: "fit", label: "Fit View", group: "View", context: "global", key: "Home / F6" },
  { id: "iso", label: "Isometric View", group: "View", context: "global" },
  { id: "top", label: "Top View", group: "View", context: "global" },
  { id: "front", label: "Front View", group: "View", context: "global" },
  { id: "right", label: "Right View", group: "View", context: "global" },
  { id: "persp", label: "Toggle Perspective / Orthographic", group: "View", context: "global" },
  { id: "selmode", label: "Toggle Faces / Bodies selection", group: "View", context: "global" },
  { id: "show-all-bodies", label: "Show All Bodies", group: "View", context: "global", key: "Shift+H" },
  { id: "shortcut-help", label: "Keyboard Shortcuts…", group: "Help", context: "global", key: "?" },
  // pinned ribbon groups (FINISH/PALETTE) live outside the SKETCH const, so the
  // palette must list them explicitly — "Finish Sketch" was unsearchable before
  { id: "finish", label: "Finish Sketch", group: "SKETCH", context: "sketch" },
  { id: "palette", label: "Sketch Palette", group: "SKETCH", context: "sketch" },
];

function fromGroups(groups: Group[], context: "model" | "sketch"): Command[] {
  const out: Command[] = [];
  for (const g of groups) {
    for (const it of g.items) {
      // a split button's tools live in `children` — flatten via leavesOf or
      // the palette loses every tool folded into a dropdown
      for (const leaf of leavesOf(it)) {
        if (leaf.action === "palette" || leaf.kind === "toggle") continue; // not palette commands
        out.push({
          id: leaf.action,
          label: leaf.label,
          group: g.label,
          context,
          key: keyHint(leaf.action) ?? leaf.key,
        });
      }
    }
  }
  return out;
}

/** Every command (model + sketch + global), for the palette to search. */
export function allCommands(): Command[] {
  return [...fromGroups(MODEL, "model"), ...fromGroups(SKETCH, "sketch"), ...GLOBAL];
}
