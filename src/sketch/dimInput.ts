// On-canvas heads-up dimension input — the signature mainstream MCAD interaction.
// A small floating cluster of <input>s positioned near the cursor. Fields that
// are "tracking" update live from the cursor; typing makes a field hold your
// value; Tab locks the field and moves to the next; Enter commits everything.
//
// Values cross this boundary in MILLIMETRES (the tools work in mm); length
// fields are shown/parsed in the user's display unit, angles always in degrees.

import { setTitle, t } from "../i18n";
import { getUnit, fieldParams, fieldText, parseFieldExpr } from "../ui/units";
import { icon } from "../ui/icons";
import { isImeComposing } from "../ui/focus";

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
  /** The last value the APP put in this field (cursor tracking or a seed) and
   *  the text it wrote for it. That text is rounded for display, so until the
   *  user types, the value is `mm`, not the parse of it. Typing clears it. */
  wrote?: { text: string; mm: number } | undefined;
}

export class DimInput {
  private root: HTMLDivElement;
  private fields: Field[] = [];
  private onCommit: ((values: Record<string, number>) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private onInput: (() => void) | null = null;
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

  /** Arbitrates a single-letter TOOL hotkey pressed while this box is up, and
   *  answers: should the tool act on it? A modal 3D tool focuses this box (and
   *  re-asserts focus next frame) so typing a depth works, which used to mean
   *  its own hotkeys were unreachable for as long as it was open — pressing T
   *  in Extrude to aim at a plane typed a "t" over the seeded depth instead
   *  (field report 88c9bdf0).
   *
   *  The rule is the one keymap.ts already applies to Ctrl+Z: while the text is
   *  UNCHANGED since it took focus there is nothing being typed for the letter
   *  to interrupt, so it belongs to the tool — and the keystroke is swallowed
   *  here so the letter does not ALSO land in the field. Once the user has
   *  typed, letters stay text. The box reads parameter names and functions
   *  (`wall*2`), so a letter claimed here is one no value can START with in
   *  this box: claim as few as the tool can.
   *  A key aimed anywhere else — another editor, the canvas — is not mine to
   *  arbitrate and passes straight through. `ownsTarget` is what keeps this
   *  from claiming e.g. a dimension label's inline value input. */
  claimToolHotkey(e: KeyboardEvent): boolean {
    // Mid-conversion the letter is part of the reading the IME is assembling,
    // whatever the field's undo state says (a composition need not have fired
    // an `input` event yet). Claiming it would fire the tool AND swallow the
    // keystroke the input method was waiting for, so the tool stands down and
    // the key passes through untouched.
    if (isImeComposing(e)) return false;
    const el = e.target;
    if (!this.active || !(el instanceof HTMLInputElement) || !this.ownsTarget(el)) return true;
    if (el.getAttribute("data-undo-passthrough") !== "1") return false; // the user is typing
    e.preventDefault();
    return true;
  }

  /** While a tool is still deciding WHERE to drop something, the box is a
   *  heads-up readout sitting over the canvas, not a widget — a click aimed at
   *  the canvas underneath must reach it instead of hitting ✓. Typing is
   *  unaffected: keystrokes go to the focused input regardless of pointer-events.
   *  Turn it back off once the click-to-place is done, or ✓/✕ become unclickable. */
  setClickThrough(on: boolean) {
    this.root.style.pointerEvents = on ? "none" : "";
  }

  /** `onInput` runs after every keystroke that changes a field, once the field
   *  has frozen to the typed text. A tool previews from the cursor on pointer
   *  moves, so without it a typed value reached the preview only when the mouse
   *  next moved (report be869d55: a polygon's typed side count showed nothing
   *  until the tick). */
  show(
    defs: DimFieldDef[],
    onCommit: (values: Record<string, number>) => void,
    onCancel?: () => void,
    onInput?: () => void,
  ) {
    this.hide();
    this.setClickThrough(false); // every other tool wants a clickable box
    this.onCommit = onCommit;
    this.onCancel = onCancel ?? null;
    this.onInput = onInput ?? null;
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
        // Anything typed is the user's number, even the very digits the app
        // showed: "50" typed over a 49.99999 measurement means 50.
        field.wrote = undefined;
        markUndoTarget();
        this.onInput?.();
      });
      return field;
    });
    // Visible confirm/cancel — Enter/Esc equivalents for mouse-first work (the
    // Enter-only flow read as "no way to confirm"). pointerdown+preventDefault
    // so pressing them never blurs the input first.
    const ok = document.createElement("button");
    ok.className = "dim-btn dim-ok";
    setTitle(ok, "sketch.dimension.confirmEnter");
    ok.setAttribute("aria-label", t("common.confirm"));
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
      setTitle(no, "sketch.dimension.cancelEsc");
      no.setAttribute("aria-label", t("common.cancel"));
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
    // Mid-IME-conversion the keystroke belongs to the input method (Enter
    // confirms a candidate, Tab walks the candidate list), not to this box —
    // committing there ends the whole tool on half-typed text. Still swallowed,
    // so no drawing shortcut fires either. These fields are numeric but
    // type="text", and fullwidth digits are composed like any other text.
    if (isImeComposing(e)) {
      e.stopPropagation();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      field.userDriven = true; // Tab locks the current field
      const i = this.fields.indexOf(field);
      const next = this.fields[(i + 1) % this.fields.length];
      if (next) {
        next.input.focus();
        next.input.select();
      }
      // Tab is one of the two ways a field's value can go user-driven without
      // a pointer move (the other is typing, which the "input" listener below
      // already reports). Without this, locking via Tab left the preview and
      // side prompt showing the cursor's last position until the mouse moved
      // again (field report 8159018e).
      this.onInput?.();
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
        f.input.value = fieldText(v, f.def.kind);
        f.wrote = { text: f.input.value, mm: v };
        f.input.classList.remove("invalid");
        // Keep the live value SELECTED while it tracks the cursor (Fusion-style), so
        // typing a number at any moment replaces it instead of appending.
        if (document.activeElement === f.input) f.input.select();
      }
    }
  }

  /** Pre-fill a field AND lock it (userDriven) so cursor tracking can't clobber
   *  the value — used when re-opening a feature for editing, where the saved
   *  value must hold until the user deliberately retypes or drags a handle.
   *  Text goes in verbatim: a parameter-bound field reopens its formula. */
  seed(name: string, value: number | string) {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return;
    if (typeof value === "string") {
      // a text seed has no number behind it: read back as shown, like typing
      f.input.value = value;
      f.wrote = undefined;
    } else {
      f.input.value = fieldText(value, f.def.kind);
      f.wrote = { text: f.input.value, mm: value };
    }
    f.input.classList.remove("invalid");
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

  /** returns the field value in MM (length fields converted from display unit).
   *  `parseFieldExpr` is the ONE numeric entry point: it takes "12,5" as readily
   *  as "12.5", and arithmetic as readily as a number (`31.53+2*1.62`, `1/16`,
   *  `wall*2`; the unit rule is ui/units.fieldExpr's), so this box — extrude,
   *  press/pull, fillet, chamfer, move, offset, section and every sketch
   *  primitive — needs no rule of its own. null for text it cannot evaluate;
   *  commit() drops such a field rather than committing a guess.
   *
   *  Text the user has not typed into since the app wrote it returns the value
   *  it was written FOR. Re-opening an extrude 1/32" deep in inches seeds
   *  "0.0313"; parsing that back on Enter re-cut the feature 1.3 um deeper than
   *  it was. */
  getValue(name: string): number | null {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return null;
    if (f.wrote && f.input.value === f.wrote.text) return f.wrote.mm;
    return parseFieldExpr(f.input.value, f.def.kind, fieldParams());
  }

  /** True when the field holds text the user TYPED, as opposed to the text the
   *  app last wrote — for callers that read `getRaw`. Keyed on typing, not on
   *  the text: typing the digits already shown is still the user's number. */
  isEdited(name: string): boolean {
    const f = this.fields.find((x) => x.def.name === name);
    return !!f && (!f.wrote || f.input.value !== f.wrote.text);
  }

  /** Show a field as holding text the tool cannot read (red), or not. A
   *  value the app writes into it (`seed`, cursor tracking) clears it. */
  markInvalid(name: string, on: boolean) {
    this.fields.find((x) => x.def.name === name)?.input.classList.toggle("invalid", on);
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

  /** Put the box's top-left corner exactly here: for a tool that keeps the box
   *  AWAY from what it measures (the section cut) instead of beside a cursor. */
  placeAt(left: number, top: number) {
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  /** The box's size on screen, for a caller placing it with placeAt. */
  get size(): { width: number; height: number } {
    return { width: this.root.offsetWidth, height: this.root.offsetHeight };
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
    this.onInput = null;
  }
}
