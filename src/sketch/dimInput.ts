// On-canvas heads-up dimension input — the signature mainstream MCAD interaction.
// A small floating cluster of <input>s positioned near the cursor. Fields that
// are "tracking" update live from the cursor; typing makes a field hold your
// value; Tab locks the field and moves to the next; Enter commits everything.
//
// Values cross this boundary in MILLIMETRES (the tools work in mm); length
// fields are shown/parsed in the user's display unit, angles always in degrees.

import { getUnit, displayValue, parseField } from "../ui/units";
import { icon } from "../ui/icons";

export interface DimFieldDef {
  name: string;
  label: string;
  kind?: "length" | "angle" | "count"; // default length; count = raw number, no unit
}

interface Field {
  def: DimFieldDef;
  input: HTMLInputElement;
  // false = follows the cursor; true = holds the user's typed/locked value
  userDriven: boolean;
}

export class DimInput {
  private root: HTMLDivElement;
  private fields: Field[] = [];
  private onCommit: ((values: Record<string, number>) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private active = false;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "dim-input";
    this.root.style.display = "none";
    document.body.appendChild(this.root);
  }

  get isActive() {
    return this.active;
  }

  /** true when `el` is one of THIS dim box's inputs — lets the owning tool's
   *  capture-phase key handler act on Escape for its own box without stealing
   *  Esc from other editors (e.g. a dimension label's inline value input). */
  ownsTarget(el: EventTarget | null): boolean {
    return el instanceof Node && this.root.contains(el);
  }

  /** While a tool is still deciding WHERE to drop something, the box is a
   *  heads-up readout sitting over the canvas, not a widget — a click aimed at
   *  the canvas underneath must reach it instead of hitting ✓. Typing is
   *  unaffected: keystrokes go to the focused input regardless of pointer-events.
   *  Turn it back off once the click-to-place is done, or ✓/✕ become unclickable. */
  setClickThrough(on: boolean) {
    this.root.style.pointerEvents = on ? "none" : "";
  }

  show(
    defs: DimFieldDef[],
    onCommit: (values: Record<string, number>) => void,
    onCancel?: () => void,
  ) {
    this.hide();
    this.setClickThrough(false); // every other tool wants a clickable box
    this.onCommit = onCommit;
    this.onCancel = onCancel ?? null;
    this.active = true;
    this.root.style.display = "flex";
    this.fields = defs.map((def) => {
      const wrap = document.createElement("label");
      wrap.className = "dim-field";
      wrap.textContent =
        def.kind === "angle" ? `${def.label}°` : def.kind === "count" ? def.label : `${def.label} ${getUnit()}`;
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      // Ctrl+Z/Ctrl+Y with the caret in here used to be swallowed: keymap.ts
      // ignores every keystroke aimed at an input, and a modal 3D tool focuses
      // this box and re-asserts focus on the next frame — so for the whole time
      // a fillet/chamfer/extrude was open the app's undo was unreachable and the
      // WebView applied its own text undo instead (field report a0a76571, "even
      // Undo does not work"). While the text is UNCHANGED since it took focus
      // there IS no text edit to undo, so the keystroke belongs to the app; this
      // attribute is how keymap.ts tells the two apart.
      input.setAttribute("data-undo-passthrough", "1");
      let atFocus = input.value;
      const markUndoTarget = () => {
        input.setAttribute("data-undo-passthrough", input.value === atFocus ? "1" : "0");
      };
      input.addEventListener("focus", () => {
        atFocus = input.value;
        markUndoTarget();
      });
      wrap.appendChild(input);
      this.root.appendChild(wrap);
      const field: Field = { def, input, userDriven: false };

      input.addEventListener("keydown", (e) => this.onKey(e, field));
      input.addEventListener("input", () => {
        field.userDriven = true; // typing freezes the field from cursor tracking
        markUndoTarget();
      });
      return field;
    });
    // Visible confirm/cancel — Enter/Esc equivalents for mouse-first work (the
    // Enter-only flow read as "no way to confirm"). pointerdown+preventDefault
    // so pressing them never blurs the input first.
    const ok = document.createElement("button");
    ok.className = "dim-btn dim-ok";
    ok.title = "Confirm (Enter)";
    ok.setAttribute("aria-label", "Confirm");
    ok.innerHTML = icon("check");
    ok.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.commit();
    });
    this.root.appendChild(ok);
    if (this.onCancel) {
      const no = document.createElement("button");
      no.className = "dim-btn dim-no";
      no.title = "Cancel (Esc)";
      no.setAttribute("aria-label", "Cancel");
      no.innerHTML = icon("close");
      no.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onCancel?.();
      });
      this.root.appendChild(no);
    }
    // focus first field so typing goes straight to it. show() is often called from
    // a pointerdown handler (e.g. extrude's pick→drag), where the browser moves
    // focus to the click target AFTER this handler returns — so re-focus next frame
    // too, or the field silently never holds focus and typing/Tab do nothing.
    this.focus();
    requestAnimationFrame(() => this.focus());
  }

  /** Focus + select the first field. show() calls it; tools whose flow keeps
   *  clicking the canvas while the box stays open must call it again after each
   *  click (the click blurs the input, and typing would silently go nowhere). */
  focus() {
    const f = this.fields[0];
    if (f && this.active) { f.input.focus(); f.input.select(); }
  }

  private onKey(e: KeyboardEvent, field: Field) {
    if (e.key === "Tab") {
      e.preventDefault();
      field.userDriven = true; // Tab locks the current field
      const i = this.fields.indexOf(field);
      const next = this.fields[(i + 1) % this.fields.length];
      if (next) {
        next.input.focus();
        next.input.select();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.commit();
    } else if (this.isAppUndo(e, field)) {
      // Let it bubble to keymap.ts, which routes it to the app's undo. Without
      // this the stopPropagation below hid Ctrl+Z from the app for the whole
      // time a tool held focus in this box (see the show() comment).
      return;
    }
    // Escape is handled by the owning tool's capture-phase keydown listener.
    e.stopPropagation(); // never let drawing shortcuts fire while typing
  }

  /** Ctrl+Z / Ctrl+Y that belongs to the APP rather than to this box: the
   *  combo, on a field whose text is unchanged since it took focus — so there
   *  is no typing here for the WebView's text history to undo. */
  private isAppUndo(e: KeyboardEvent, field: Field): boolean {
    if (!e.ctrlKey && !e.metaKey) return false;
    const k = e.key.toLowerCase();
    if (k !== "z" && k !== "y") return false;
    return field.input.getAttribute("data-undo-passthrough") === "1";
  }

  /** tool pushes cursor-derived values in MM; only tracking fields accept them */
  updateFromCursor(values: Record<string, number>) {
    for (const f of this.fields) {
      const v = values[f.def.name];
      if (!f.userDriven && v != null) {
        f.input.value = String(displayValue(v, f.def.kind));
        // Keep the live value SELECTED while it tracks the cursor (Fusion-style), so
        // typing a number at any moment replaces it instead of appending.
        if (document.activeElement === f.input) f.input.select();
      }
    }
  }

  /** Pre-fill a field AND lock it (userDriven) so cursor tracking can't clobber
   *  the value — used when re-opening a feature for editing, where the saved
   *  value must hold until the user deliberately retypes or drags a handle. */
  seed(name: string, value: number) {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return;
    f.input.value = String(displayValue(value, f.def.kind));
    f.userDriven = true;
  }

  isUserDriven(name: string): boolean {
    const f = this.fields.find((x) => x.def.name === name);
    return !!f && f.userDriven;
  }

  /** Hand a field back to cursor tracking — the inverse of `seed`, for a tool
   *  whose 3D handle has just been GRABBED. Taking hold of a manipulator is as
   *  deliberate a statement of the value as typing one, so it has to win over a
   *  typed or seeded number; otherwise the box sits frozen at the old figure
   *  while the geometry moves under it. Typing re-locks the field on the next
   *  keystroke (the `input` listener), so this cannot strand a value. */
  unlock(name: string) {
    const f = this.fields.find((x) => x.def.name === name);
    if (f) f.userDriven = false;
  }

  /** returns the field value in MM (length fields converted from display unit) */
  getValue(name: string): number | null {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return null;
    return parseField(f.input.value, f.def.kind);
  }

  /** the field's RAW text, untouched — for callers that route input through the
   *  expression evaluator (`w/2`, `name=expr`) instead of a bare parseField, and
   *  that must be able to tell "empty" from "unparseable". "" when there is no
   *  such field. */
  getRaw(name: string): string {
    return this.fields.find((x) => x.def.name === name)?.input.value ?? "";
  }

  position(screenX: number, screenY: number) {
    this.root.style.left = `${screenX + 16}px`;
    this.root.style.top = `${screenY + 16}px`;
  }

  private commit() {
    const out: Record<string, number> = {};
    for (const f of this.fields) {
      const v = this.getValue(f.def.name); // already mm-converted
      if (v != null) out[f.def.name] = v;
    }
    this.onCommit?.(out);
  }

  hide() {
    this.active = false;
    this.root.style.display = "none";
    this.root.innerHTML = "";
    this.fields = [];
    this.onCommit = null;
    this.onCancel = null;
  }
}
