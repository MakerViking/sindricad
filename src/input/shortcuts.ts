// Single source of truth for keyboard shortcuts. keymap.ts dispatches from this
// table, commands.ts reads its hint column, and the `?` HUD renders it — so the
// three surfaces can never disagree again (they did: M/T were emitted but never
// dispatched, the palette advertised Fit on "F" while F ran Fillet, and the
// ribbon promised sketch Offset on "O" with no binding behind it).

export interface Shortcut {
  key: string; // normalized lowercase key ("b", "home", "f6", "?")
  shift?: boolean;
  action: string; // action id fed to main's handleAction (or a special-cased id)
  context: "model" | "sketch" | "global";
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  // --- model context ---
  { key: "s", action: "sketch", context: "model", label: "Sketch" },
  { key: "e", action: "extrude", context: "model", label: "Extrude" },
  { key: "q", action: "presspull", context: "model", label: "Press/Pull" },
  { key: "f", action: "fillet", context: "model", label: "Fillet" },
  { key: "b", action: "chamfer", context: "model", label: "Chamfer (bevel)" },
  { key: "m", action: "move", context: "model", label: "Move" },
  { key: "i", action: "measure", context: "model", label: "Measure" },
  { key: "k", action: "split", context: "model", label: "Split Body" },
  { key: "j", action: "combine", context: "model", label: "Combine (join)" },
  { key: "u", action: "clean-up", context: "model", label: "Clean Up" },
  { key: "o", action: "offset-plane", context: "model", label: "Offset Plane" },
  { key: "h", action: "hide-selected", context: "model", label: "Hide selected bodies" },
  { key: "h", shift: true, action: "show-all-bodies", context: "model", label: "Show all bodies" },
  { key: "1", action: "selmode-faces", context: "model", label: "Select faces" },
  { key: "2", action: "selmode-bodies", context: "model", label: "Select bodies" },
  // --- sketch context ---
  { key: "l", action: "line", context: "sketch", label: "Line" },
  { key: "c", action: "circle", context: "sketch", label: "Circle" },
  { key: "r", action: "rectangle", context: "sketch", label: "Rectangle" },
  { key: "a", action: "arc", context: "sketch", label: "Arc" },
  { key: "d", action: "dimension", context: "sketch", label: "Dimension" },
  { key: "t", action: "trim", context: "sketch", label: "Trim" },
  { key: "o", action: "offset", context: "sketch", label: "Offset" },
  { key: "f", action: "fillet-sketch", context: "sketch", label: "Sketch Fillet" },
  // sketch-start conveniences from model mode (L/C/R/A start a sketch with that tool)
  { key: "l", action: "line", context: "model", label: "Sketch: Line" },
  { key: "c", action: "circle", context: "model", label: "Sketch: Circle" },
  { key: "r", action: "rectangle", context: "model", label: "Sketch: Rectangle" },
  { key: "a", action: "arc", context: "model", label: "Sketch: Arc" },
  // --- global ---
  { key: "home", action: "fit", context: "global", label: "Fit view" },
  { key: "f6", action: "fit", context: "global", label: "Fit view" },
  { key: "?", action: "shortcut-help", context: "global", label: "Shortcut help" },
];

/** first key hint for an action ("Shift+H", "Home"), for menus/palette. */
export function keyHint(action: string): string | undefined {
  const s = SHORTCUTS.find((x) => x.action === action);
  if (!s) return undefined;
  const k = s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1);
  return s.shift ? `Shift+${k}` : k;
}

/** Resolve a keydown to an action for the current context (sketch keys win
 *  while sketching; model keys otherwise; global always). */
export function resolveShortcut(
  key: string,
  shift: boolean,
  context: "model" | "sketch",
): string | null {
  const k = key.toLowerCase();
  for (const s of SHORTCUTS) {
    if (s.key !== k || !!s.shift !== shift) continue;
    if (s.context === "global" || s.context === context) return s.action;
  }
  return null;
}

// --- the `?` cheat-sheet HUD: auto-generated, dismissed by any key/click ---
let hud: HTMLDivElement | null = null;

export function toggleShortcutHUD() {
  if (hud) {
    hud.remove();
    hud = null;
    return;
  }
  const groups: [string, Shortcut[]][] = [
    ["Model", SHORTCUTS.filter((s) => s.context === "model")],
    ["Sketch", SHORTCUTS.filter((s) => s.context === "sketch")],
    ["Global", SHORTCUTS.filter((s) => s.context === "global")],
  ];
  const extra = [
    ["Ctrl+K", "Command palette"],
    ["Ctrl+Z / Ctrl+Y", "Undo / Redo"],
    ["Ctrl+S / Ctrl+Shift+S", "Save / Save As"],
    ["Ctrl+N / Ctrl+O / Ctrl+E", "New / Open / Export"],
    ["Del", "Delete face (heal) / feature"],
    ["Esc", "Cancel / clear selection"],
  ];
  hud = document.createElement("div");
  hud.className = "shortcut-hud";
  const card = document.createElement("div");
  card.className = "shortcut-hud-card";
  card.innerHTML =
    `<div class="shortcut-hud-title">Keyboard shortcuts</div>` +
    groups
      .map(
        ([name, list]) =>
          `<div class="shortcut-hud-group"><h4>${name}</h4>` +
          list
            .map((s) => {
              const k = s.shift ? `Shift+${s.key.toUpperCase()}` : s.key.toUpperCase();
              return `<div class="shortcut-hud-row"><kbd>${k}</kbd><span>${s.label}</span></div>`;
            })
            .join("") +
          `</div>`,
      )
      .join("") +
    `<div class="shortcut-hud-group"><h4>Always</h4>` +
    extra
      .map(([k, l]) => `<div class="shortcut-hud-row"><kbd>${k}</kbd><span>${l}</span></div>`)
      .join("") +
    `</div>`;
  hud.appendChild(card);
  document.body.appendChild(hud);
  const dismiss = () => {
    hud?.remove();
    hud = null;
    window.removeEventListener("keydown", onAny, true);
    window.removeEventListener("pointerdown", onAny, true);
  };
  const onAny = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  };
  // defer so the `?` keydown that opened it doesn't instantly close it
  setTimeout(() => {
    window.addEventListener("keydown", onAny, true);
    window.addEventListener("pointerdown", onAny, true);
  }, 0);
}
