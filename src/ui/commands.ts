// Single command registry — the source of truth for the Cmd-K command palette
// (and a searchable list of everything you can do). Built from the ribbon's tool
// groups plus the global File/View commands that live in menus / view controls.

import { MODEL, SKETCH, type Group } from "./ribbon";

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
  { id: "fit", label: "Fit View", group: "View", context: "global", key: "F" },
  { id: "iso", label: "Isometric View", group: "View", context: "global" },
  { id: "top", label: "Top View", group: "View", context: "global" },
  { id: "front", label: "Front View", group: "View", context: "global" },
  { id: "right", label: "Right View", group: "View", context: "global" },
  { id: "persp", label: "Toggle Perspective / Orthographic", group: "View", context: "global" },
  { id: "selmode", label: "Toggle Faces / Bodies selection", group: "View", context: "global" },
];

function fromGroups(groups: Group[], context: "model" | "sketch"): Command[] {
  const out: Command[] = [];
  for (const g of groups) {
    for (const it of g.items) {
      if (it.action === "palette" || it.kind === "toggle") continue; // not palette commands
      out.push({ id: it.action, label: it.label, group: g.label, context, key: it.key });
    }
  }
  return out;
}

/** Every command (model + sketch + global), for the palette to search. */
export function allCommands(): Command[] {
  return [...fromGroups(MODEL, "model"), ...fromGroups(SKETCH, "sketch"), ...GLOBAL];
}
