// Single command registry — the source of truth for the Cmd-K command palette
// (and a searchable list of everything you can do). Built from the ribbon's tool
// groups plus the global File/View commands that live in menus / view controls.
// Key hints come from the shortcut table (src/input/shortcuts.ts) so the palette
// can never advertise a key the keymap doesn't actually bind (it used to claim
// Fit was on "F" while F ran Fillet).

import { MODEL, SKETCH, leavesOf, type Group } from "./ribbon";
import { keyHint } from "../input/shortcuts";
import { t } from "../i18n";

export interface Command {
  id: string; // the action id passed to the central dispatcher (handleAction)
  label: string;
  group: string; // shown as a subtle category in the palette
  context: "model" | "sketch" | "global";
  key?: string; // display hint
}

// File + View commands that aren't in the ribbon (menus / floating view controls).
// Labels share their keys with the menubar in main.ts: one string, two places.
const GLOBAL: Command[] = [
  { id: "new", label: t("menu.file.new"), group: t("menu.file.title"), context: "global", key: "Ctrl+N" },
  { id: "open", label: t("menu.file.open"), group: t("menu.file.title"), context: "global", key: "Ctrl+O" },
  { id: "save", label: t("menu.file.save"), group: t("menu.file.title"), context: "global", key: "Ctrl+S" },
  { id: "saveas", label: t("menu.file.saveAs"), group: t("menu.file.title"), context: "global", key: "Ctrl+Shift+S" },
  { id: "export", label: t("menu.file.export"), group: t("menu.file.title"), context: "global", key: "Ctrl+E" },
  { id: "import", label: t("menu.file.importMesh"), group: t("menu.file.title"), context: "global" },
  { id: "ta-publish", label: t("menu.tinkeratlas.publish"), group: t("menu.file.title"), context: "global" },
  { id: "welcome", label: t("menu.tinkeratlas.welcome"), group: t("menu.help.title"), context: "global" },
  { id: "undo", label: t("menu.edit.undo"), group: t("menu.edit.title"), context: "global", key: "Ctrl+Z" },
  { id: "redo", label: t("menu.edit.redo"), group: t("menu.edit.title"), context: "global", key: "Ctrl+Y" },
  { id: "fit", label: t("menu.view.fit"), group: t("menu.view.title"), context: "global", key: "Home / F6" },
  { id: "iso", label: t("menu.view.iso"), group: t("menu.view.title"), context: "global" },
  { id: "top", label: t("menu.view.top"), group: t("menu.view.title"), context: "global" },
  { id: "front", label: t("menu.view.front"), group: t("menu.view.title"), context: "global" },
  { id: "right", label: t("menu.view.right"), group: t("menu.view.title"), context: "global" },
  { id: "persp", label: t("menu.view.cycleProjection"), group: t("menu.view.title"), context: "global" },
  { id: "selmode", label: t("menu.view.toggleSelectMode"), group: t("menu.view.title"), context: "global" },
  { id: "show-all-bodies", label: t("menu.view.showAllBodies"), group: t("menu.view.title"), context: "global", key: "Shift+H" },
  { id: "shortcut-help", label: t("palette.shortcutHelp"), group: t("menu.help.title"), context: "global", key: "?" },
  // pinned ribbon groups (FINISH/PALETTE) live outside the SKETCH const, so the
  // palette must list them explicitly — "Finish Sketch" was unsearchable before
  { id: "finish", label: t("tool.finishSketch"), group: t("ribbon.context.sketch"), context: "sketch" },
  { id: "palette", label: t("palette.sketchPalette"), group: t("ribbon.context.sketch"), context: "sketch" },
];

function fromGroups(groups: Group[], context: "model" | "sketch"): Command[] {
  const out: Command[] = [];
  for (const g of groups) {
    for (const it of g.items) {
      // a split button's tools live in `children` — flatten via leavesOf or
      // the palette loses every tool folded into a dropdown
      for (const leaf of leavesOf(it)) {
        if (leaf.action === "palette" || leaf.kind === "toggle") continue; // not palette commands
        const key = keyHint(leaf.action) ?? leaf.key;
        out.push({
          id: leaf.action,
          label: leaf.label,
          group: g.label,
          context,
          ...(key !== undefined ? { key } : {}),
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
