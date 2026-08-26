// Keyboard-shortcut editor: every entry in the shortcuts table, grouped by the
// context it fires in, each with a click-to-record key button. Issue #17 asked
// to "rebind custom keyboard shortcuts for every tool" — the table was already
// the single source of truth for the keymap, the HUD and the menu hints, so the
// panel only has to edit it and all three follow.
//
// Recording is modal-within-modal: the button you clicked becomes a key trap
// until the next keystroke. Conflicts are REFUSED (see rebindShortcut) and the
// refusal names the tool that already owns the key, because "nothing happened"
// is the failure mode a rebind screen must not have.

import { icon } from "./icons";
import { pushModal, popModal } from "./choice";
import {
  CONTEXT_LABELS,
  SHORTCUTS,
  bindingOf,
  formatBinding,
  isShortcutOverridden,
  normalizeKey,
  rebindShortcut,
  resetAllShortcuts,
  resetShortcut,
  type Shortcut,
} from "../input/shortcuts";

export class ShortcutSettings {
  private overlay: HTMLDivElement | null = null;
  private status: HTMLElement | null = null;
  private capturing: string | null = null; // shortcut id being recorded
  private rows = new Map<string, () => void>(); // id → repaint that row

  open() {
    if (this.overlay) return;
    this.build();
    pushModal(); // counted in main's toolBusy(), same as choose()
    window.addEventListener("keydown", this.onKey, true);
  }

  close() {
    if (!this.overlay) return;
    window.removeEventListener("keydown", this.onKey, true);
    popModal();
    this.overlay.remove();
    this.overlay = null;
    this.status = null;
    this.capturing = null;
    this.rows.clear();
  }

  // --- key handling ---------------------------------------------------------
  //
  // Capture phase on window: the app's own keymap listens in the bubble phase
  // on the same window, so stopping propagation here is what keeps "F" from
  // ALSO starting Fillet behind the panel. The keymap only skips input/textarea
  // targets, and every control on this screen is a button.
  private onKey = (e: KeyboardEvent) => {
    if (this.capturing) {
      e.preventDefault();
      e.stopPropagation();
      // a bare modifier is the user still reaching for the real key
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      if (e.key === "Escape") return this.endCapture("Recording cancelled.");
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return this.endCapture("Ctrl, Alt and Cmd combinations are reserved (undo, save, open, palette).");
      }
      this.apply(this.capturing, e);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    // Tab/Enter/Space/arrows drive focus and activation — the browser needs
    // them. Everything else is swallowed so a tool key can't fire underneath.
    if (e.key === "Tab" || e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();
  };

  private apply(id: string, e: KeyboardEvent) {
    const result = rebindShortcut(id, normalizeKey(e));
    if (!result.ok) {
      const held = result.conflict;
      this.endCapture(
        `${formatBinding(normalizeKey(e))} is already ${held.label} (${CONTEXT_LABELS[held.context]}). ` +
          `Clear that one first, then set this.`,
      );
      return;
    }
    this.endCapture("");
  }

  private beginCapture(id: string) {
    this.capturing = id;
    this.setStatus("Press the key to bind. Esc cancels.");
    this.repaintAll();
  }

  private endCapture(message: string) {
    this.capturing = null;
    this.setStatus(message);
    this.repaintAll();
  }

  private setStatus(message: string) {
    if (this.status) this.status.textContent = message;
  }

  private repaintAll() {
    for (const paint of this.rows.values()) paint();
  }

  // --- DOM ------------------------------------------------------------------
  private build() {
    const overlay = el("div", "modal-overlay") as HTMLDivElement;
    overlay.addEventListener("pointerdown", (e) => {
      // a backdrop click mid-recording should abandon the recording, not the
      // whole screen — otherwise a mis-click loses the row you were editing
      if (e.target !== overlay) return;
      if (this.capturing) this.endCapture("Recording cancelled.");
      else this.close();
    });
    const panel = el("div", "modal-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Keyboard Shortcuts");
    overlay.appendChild(panel);

    const head = el("div", "modal-head");
    head.appendChild(text("h2", "Keyboard Shortcuts"));
    const x = el("button", "modal-close") as HTMLButtonElement;
    x.setAttribute("aria-label", "Close");
    x.innerHTML = icon("close");
    x.onclick = () => this.close();
    head.appendChild(x);
    panel.appendChild(head);

    const body = el("div", "modal-body");
    body.appendChild(
      text(
        "div",
        "Click a key to record a new one. Model and Sketch keys are independent — the same key can mean different things in each — so only bindings that could fire together are refused as conflicts.",
        "ks-intro",
      ),
    );
    for (const ctx of ["model", "sketch", "global"] as const) {
      body.appendChild(text("div", CONTEXT_LABELS[ctx], "ks-section"));
      for (const s of SHORTCUTS.filter((x) => x.context === ctx)) body.appendChild(this.row(s));
    }
    panel.appendChild(body);

    const foot = el("div", "modal-foot");
    this.status = text("div", "", "ks-status");
    // A refusal is the whole point of the conflict policy, and a screen reader
    // user gets no other signal that the key they pressed didn't take.
    this.status.setAttribute("role", "status");
    const resetAll = el("button", "btn") as HTMLButtonElement;
    resetAll.textContent = "Reset all";
    resetAll.onclick = () => {
      resetAllShortcuts();
      this.endCapture("All shortcuts restored to defaults.");
    };
    const done = el("button", "btn btn-primary") as HTMLButtonElement;
    done.textContent = "Done";
    done.onclick = () => this.close();
    foot.append(this.status, resetAll, done);
    panel.appendChild(foot);

    document.body.appendChild(overlay);
    this.overlay = overlay;
    // Land the caret on the first row rather than nowhere: Tab from an unfocused
    // overlay walks the app BEHIND it, which is how a keyboard user ends up
    // driving the ribbon while a modal is on screen.
    body.querySelector<HTMLButtonElement>("button.ks-key")?.focus();
  }

  private row(s: Shortcut): HTMLElement {
    const row = el("div", "ks-row");
    row.appendChild(text("span", s.label, "ks-label"));

    const keyBtn = el("button", "ks-key") as HTMLButtonElement;
    keyBtn.onclick = () => this.beginCapture(s.id);

    const clear = el("button", "ks-icon-btn") as HTMLButtonElement;
    clear.innerHTML = icon("close");
    clear.title = "Unbind (leaves this tool with no key)";
    clear.setAttribute("aria-label", `Unbind ${s.label}`);
    clear.onclick = () => {
      rebindShortcut(s.id, null);
      this.endCapture(`${s.label} has no key. Its ribbon and menu entries still work.`);
    };

    const revert = el("button", "ks-icon-btn") as HTMLButtonElement;
    revert.innerHTML = icon("undo");
    revert.title = "Restore the default key";
    revert.setAttribute("aria-label", `Reset ${s.label} to default`);
    revert.onclick = () => {
      resetShortcut(s.id);
      this.endCapture("");
    };

    const paint = () => {
      const b = bindingOf(s);
      const recording = this.capturing === s.id;
      keyBtn.textContent = recording ? "Press a key…" : b ? formatBinding(b) : "unbound";
      keyBtn.classList.toggle("recording", recording);
      keyBtn.classList.toggle("unbound", !recording && !b);
      keyBtn.setAttribute(
        "aria-label",
        `${s.label}: ${b ? formatBinding(b) : "unbound"}. Click to record a new key.`,
      );
      clear.disabled = !b;
      // Reverting is only meaningful once something differs from the default;
      // a permanently-lit button would say "you changed this" about every row.
      revert.disabled = !isShortcutOverridden(s.id);
    };
    paint();
    this.rows.set(s.id, paint);

    row.append(keyBtn, clear, revert);
    return row;
  }
}

// One instance for the whole app: a second Help ▸ Customize click while the
// panel is already open must reach the open()-is-idempotent guard above, not
// stack a second overlay on top of the first.
const instance = new ShortcutSettings();
export function openShortcutSettings() {
  instance.open();
}

// --- tiny DOM helpers (same shape as spaceMouseSettings) ---
function el(tag: string, cls = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function text(tag: string, txt: string, cls = ""): HTMLElement {
  const e = el(tag, cls);
  e.textContent = txt;
  return e;
}
