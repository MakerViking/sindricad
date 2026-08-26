// Single source of truth for keyboard shortcuts. keymap.ts dispatches from this
// table, commands.ts reads its hint column, and the `?` HUD renders it — so the
// three surfaces can never disagree again (they did: M/T were emitted but never
// dispatched, the palette advertised Fit on "F" while F ran Fillet, and the
// ribbon promised sketch Offset on "O" with no binding behind it).
//
// Every entry is REBINDABLE. SHORTCUTS below holds the DEFAULTS; a persisted
// per-entry override map sits on top and `bindingOf` is the only way to ask
// what a key actually is today — which is what keeps those three surfaces
// agreeing after a user has re-keyed half the app. src/ui/shortcutSettings.ts
// is the editor.

/** A live key binding. `key` is normalized lowercase ("b", "home", "f6", "?"). */
export interface Binding {
  key: string;
  shift: boolean;
}

export interface Shortcut {
  // Stable identity for the persisted override map. Deliberately NOT derived
  // from the key or the action: changing a default key in a release must not
  // orphan a user's rebinding of that entry, and one action can legitimately
  // appear several times (Extrude in both contexts, Fit on two keys).
  id: string;
  key: string; // default key, normalized lowercase
  shift?: boolean;
  action: string; // action id fed to main's handleAction (or a special-cased id)
  context: "model" | "sketch" | "global";
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  // --- model context ---
  { id: "m.sketch", key: "s", action: "sketch", context: "model", label: "Sketch" },
  { id: "m.extrude", key: "e", action: "extrude", context: "model", label: "Extrude" },
  { id: "m.presspull", key: "q", action: "presspull", context: "model", label: "Press/Pull" },
  { id: "m.fillet", key: "f", action: "fillet", context: "model", label: "Fillet" },
  { id: "m.chamfer", key: "b", action: "chamfer", context: "model", label: "Chamfer (bevel)" },
  { id: "m.move", key: "m", action: "move", context: "model", label: "Move" },
  { id: "m.measure", key: "i", action: "measure", context: "model", label: "Measure" },
  { id: "m.split", key: "k", action: "split", context: "model", label: "Split Body" },
  { id: "m.combine", key: "j", action: "combine", context: "model", label: "Combine (join)" },
  { id: "m.cleanup", key: "u", action: "clean-up", context: "model", label: "Clean Up" },
  { id: "m.offsetplane", key: "o", action: "offset-plane", context: "model", label: "Offset Plane" },
  { id: "m.hide", key: "h", action: "hide-selected", context: "model", label: "Hide selected bodies" },
  { id: "m.showall", key: "h", shift: true, action: "show-all-bodies", context: "model", label: "Show all bodies" },
  { id: "m.selfaces", key: "1", action: "selmode-faces", context: "model", label: "Select faces" },
  { id: "m.selbodies", key: "2", action: "selmode-bodies", context: "model", label: "Select bodies" },
  // --- sketch context ---
  // S is free inside a sketch (the model-context S above starts one, and this
  // table resolves sketch entries first while sketching). Field report c9db7ec2
  // had no key at all for select, leaving Escape as the only route back.
  { id: "s.select", key: "s", action: "select", context: "sketch", label: "Select" },
  { id: "s.line", key: "l", action: "line", context: "sketch", label: "Line" },
  { id: "s.circle", key: "c", action: "circle", context: "sketch", label: "Circle" },
  { id: "s.rectangle", key: "r", action: "rectangle", context: "sketch", label: "Rectangle" },
  { id: "s.arc", key: "a", action: "arc", context: "sketch", label: "Arc" },
  { id: "s.dimension", key: "d", action: "dimension", context: "sketch", label: "Dimension" },
  { id: "s.trim", key: "t", action: "trim", context: "sketch", label: "Trim" },
  { id: "s.offset", key: "o", action: "offset", context: "sketch", label: "Offset" },
  { id: "s.fillet", key: "f", action: "fillet-sketch", context: "sketch", label: "Sketch Fillet" },
  { id: "s.project", key: "p", action: "project", context: "sketch", label: "Project" },
  // finish-and-go: E/Q inside a sketch commit it and start the 3D tool
  // (handleAction already finishes an active sketch before any 3D command)
  { id: "s.extrude", key: "e", action: "extrude", context: "sketch", label: "Finish & Extrude" },
  { id: "s.presspull", key: "q", action: "presspull", context: "sketch", label: "Finish & Press/Pull" },
  // sketch-start conveniences from model mode (L/C/R/A/P start a sketch with that tool)
  { id: "m.line", key: "l", action: "line", context: "model", label: "Sketch: Line" },
  { id: "m.circle", key: "c", action: "circle", context: "model", label: "Sketch: Circle" },
  { id: "m.rectangle", key: "r", action: "rectangle", context: "model", label: "Sketch: Rectangle" },
  { id: "m.arc", key: "a", action: "arc", context: "model", label: "Sketch: Arc" },
  { id: "m.project", key: "p", action: "project", context: "model", label: "Sketch: Project" },
  // --- global ---
  { id: "g.fit", key: "home", action: "fit", context: "global", label: "Fit view" },
  { id: "g.fit2", key: "f6", action: "fit", context: "global", label: "Fit view (alt)" },
  { id: "g.help", key: "?", action: "shortcut-help", context: "global", label: "Shortcut help" },
];

export const CONTEXT_LABELS: Record<Shortcut["context"], string> = {
  model: "Model",
  sketch: "Sketch",
  global: "Global",
};

function byId(id: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

// --- persisted overrides ---------------------------------------------------

const OVERRIDES_STORE = "sindricad.shortcuts.v1";

/** entry id → binding, or null for "deliberately unbound". An id ABSENT from
 *  the map is not overridden and follows the default, which is why every read
 *  goes through hasOwnProperty rather than a truthiness test — a stored null
 *  must not fall back to the default it was clearing. */
type OverrideMap = Record<string, Binding | null>;

let overrides: OverrideMap | null = null;

/** Loaded on first use, not at import: a persisted map is user data of unknown
 *  vintage, and a tolerant load that runs lazily also lets a headless host
 *  (tests, the node build) touch this module without a localStorage at all. */
function ov(): OverrideMap {
  if (!overrides) overrides = loadOverrides();
  return overrides;
}

function loadOverrides(): OverrideMap {
  const out: OverrideMap = {};
  try {
    const raw = localStorage.getItem(OVERRIDES_STORE);
    if (!raw) return out;
    const saved = JSON.parse(raw) as { overrides?: Record<string, unknown> };
    const map = saved?.overrides;
    if (!map || typeof map !== "object") return out;
    // Copy entry by entry against the CURRENT table: an id we no longer ship
    // (a renamed or dropped tool) is discarded rather than kept as a binding
    // nothing can ever resolve, and a malformed value falls back to the
    // default instead of leaving `.key` undefined in the resolve loop.
    for (const s of SHORTCUTS) {
      if (!Object.prototype.hasOwnProperty.call(map, s.id)) continue;
      const v = map[s.id];
      if (v === null) {
        out[s.id] = null;
      } else if (v && typeof v === "object" && typeof (v as Binding).key === "string" && (v as Binding).key) {
        out[s.id] = { key: (v as Binding).key.toLowerCase(), shift: !!(v as Binding).shift };
      }
    }
  } catch {
    /* unreadable or unparseable — ship the defaults rather than nothing */
  }
  return out;
}

function persist() {
  try {
    localStorage.setItem(OVERRIDES_STORE, JSON.stringify({ version: 1, overrides: ov() }));
  } catch {
    /* ignore (private mode, quota) — the live map still holds for this session */
  }
}

/** What this entry is bound to right now, or null if the user cleared it. */
export function bindingOf(s: Shortcut): Binding | null {
  const map = ov();
  if (Object.prototype.hasOwnProperty.call(map, s.id)) return map[s.id] ?? null;
  return { key: s.key, shift: !!s.shift };
}

export function isShortcutOverridden(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ov(), id);
}

/** Two contexts collide when ONE keystroke could reach both entries: "global"
 *  is live everywhere, while model and sketch are mutually exclusive. That
 *  exclusivity is load-bearing, not an oversight — the defaults deliberately
 *  bind E to Extrude in both, and L/C/R/A/P twice over. */
function contextsCollide(a: Shortcut["context"], b: Shortcut["context"]): boolean {
  return a === b || a === "global" || b === "global";
}

/** The entry `binding` would clash with if `id` took it, or null if it's free. */
export function findConflict(id: string, binding: Binding): Shortcut | null {
  const target = byId(id);
  if (!target) return null;
  for (const s of SHORTCUTS) {
    if (s.id === id) continue;
    if (!contextsCollide(s.context, target.context)) continue;
    const cur = bindingOf(s);
    if (cur && cur.key === binding.key && cur.shift === binding.shift) return s;
  }
  return null;
}

export type RebindResult = { ok: true } | { ok: false; conflict: Shortcut };

/**
 * Rebind an entry, or pass null to clear it.
 *
 * CONFLICT POLICY: REFUSE, never displace. Handing the key to the newcomer and
 * silently unbinding the incumbent makes a tool vanish from the keyboard with
 * no trace, and the field report that follows is "chamfer stopped working" —
 * a bug report about the wrong feature. Refusing keeps the table describable:
 * whatever the HUD shows is what the keyboard does.
 *
 * Clearing is the escape hatch that a refuse-only policy otherwise takes away.
 * Swapping two keys is clear-one, rebind, rebind — three steps, but no step
 * ever leaves a binding the user didn't ask for.
 */
export function rebindShortcut(id: string, binding: Binding | null): RebindResult {
  const target = byId(id);
  if (!target) throw new Error(`rebindShortcut: unknown shortcut id ${id}`);
  if (!binding) {
    setOverride(target, null);
    return { ok: true };
  }
  const norm: Binding = { key: binding.key.toLowerCase(), shift: !!binding.shift };
  const conflict = findConflict(id, norm);
  if (conflict) return { ok: false, conflict };
  setOverride(target, norm);
  return { ok: true };
}

function setOverride(s: Shortcut, b: Binding | null) {
  const map = ov();
  // Binding an entry back to its own default is not an override. Dropping the
  // record keeps the stored map to what the user actually changed, and lets a
  // future change of that default still reach them.
  if (b && b.key === s.key && b.shift === !!s.shift) delete map[s.id];
  else map[s.id] = b;
  persist();
}

export function resetShortcut(id: string) {
  delete ov()[id];
  persist();
}

export function resetAllShortcuts() {
  overrides = {};
  persist();
}

/** "Shift+H", "Home", "F6" — the one place a binding turns into display text. */
export function formatBinding(b: Binding): string {
  const k = b.key.length === 1 ? b.key.toUpperCase() : b.key.charAt(0).toUpperCase() + b.key.slice(1);
  return b.shift ? `Shift+${k}` : k;
}

/** first key hint for an action ("Shift+H", "Home"), for menus/palette. */
export function keyHint(action: string): string | undefined {
  for (const s of SHORTCUTS) {
    if (s.action !== action) continue;
    const b = bindingOf(s);
    if (b) return formatBinding(b); // skip an entry the user cleared
  }
  return undefined;
}

/**
 * A keydown as a binding — shared by the dispatcher and the rebind capture so
 * the two can never disagree about what a keystroke "is".
 *
 * A symbol that only exists WITH shift ("?", "!", "/") arrives as that symbol
 * with shiftKey set; recording the flag as well would make the binding
 * unmatchable, because matching it requires pressing a shift that has already
 * been spent producing the character. Letters and digits are unaffected —
 * they have a distinct unshifted form (and Shift+1 arrives as "!", not "1").
 */
export function normalizeKey(e: { key: string; shiftKey: boolean }): Binding {
  const caseless = e.key.length === 1 && e.key.toLowerCase() === e.key.toUpperCase();
  return { key: e.key.toLowerCase(), shift: e.shiftKey && !caseless };
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
    if (s.context !== "global" && s.context !== context) continue;
    const b = bindingOf(s);
    if (b && b.key === k && b.shift === shift) return s.action;
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
  // Rows come from the LIVE bindings, so a rebound key is right here too rather
  // than only in the settings panel; a cleared entry drops out entirely.
  const rows = (ctx: Shortcut["context"]) =>
    SHORTCUTS.filter((s) => s.context === ctx)
      .map((s) => ({ s, b: bindingOf(s) }))
      .filter((r): r is { s: Shortcut; b: Binding } => r.b !== null);
  const groups: [string, { s: Shortcut; b: Binding }[]][] = [
    [CONTEXT_LABELS.model, rows("model")],
    [CONTEXT_LABELS.sketch, rows("sketch")],
    [CONTEXT_LABELS.global, rows("global")],
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
            .map(
              ({ s, b }) =>
                `<div class="shortcut-hud-row"><kbd>${formatBinding(b)}</kbd><span>${s.label}</span></div>`,
            )
            .join("") +
          `</div>`,
      )
      .join("") +
    `<div class="shortcut-hud-group"><h4>Always</h4>` +
    extra
      .map(([k, l]) => `<div class="shortcut-hud-row"><kbd>${k}</kbd><span>${l}</span></div>`)
      .join("") +
    `</div>` +
    // The panel is the only way to discover that any of this is changeable, and
    // this HUD is where someone is already looking at the keys.
    `<div class="shortcut-hud-foot">Rebind any of these in Help ▸ Customize Shortcuts…</div>`;
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
