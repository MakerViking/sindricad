// On-canvas heads-up dimension input — the signature mainstream MCAD interaction.
// A small floating cluster of <input>s positioned near the cursor. Fields that
// are "tracking" update live from the cursor; typing makes a field hold your
// value; Tab locks the field and moves to the next; Enter commits everything.
//
// Values cross this boundary in MILLIMETRES (the tools work in mm); length
// fields are shown/parsed in the user's display unit, angles always in degrees.

import { getUnit, displayValue, parseField } from "../ui/units";

export interface DimFieldDef {
  name: string;
  label: string;
  kind?: "length" | "angle"; // default length
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

  show(
    defs: DimFieldDef[],
    onCommit: (values: Record<string, number>) => void,
    onCancel?: () => void,
  ) {
    this.hide();
    this.onCommit = onCommit;
    this.onCancel = onCancel ?? null;
    this.active = true;
    this.root.style.display = "flex";
    this.fields = defs.map((def) => {
      const wrap = document.createElement("label");
      wrap.className = "dim-field";
      wrap.textContent =
        def.kind === "angle" ? `${def.label}°` : `${def.label} ${getUnit()}`;
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      wrap.appendChild(input);
      this.root.appendChild(wrap);
      const field: Field = { def, input, userDriven: false };

      input.addEventListener("keydown", (e) => this.onKey(e, field));
      input.addEventListener("input", () => {
        field.userDriven = true; // typing freezes the field from cursor tracking
      });
      return field;
    });
    // Visible confirm/cancel — Enter/Esc equivalents for mouse-first work (the
    // Enter-only flow read as "no way to confirm"). pointerdown+preventDefault
    // so pressing them never blurs the input first.
    const ok = document.createElement("button");
    ok.className = "dim-btn dim-ok";
    ok.title = "Confirm (Enter)";
    ok.textContent = "✓";
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
      no.textContent = "✕";
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
    const focusFirst = () => {
      const f = this.fields[0];
      if (f && this.active) { f.input.focus(); f.input.select(); }
    };
    focusFirst();
    requestAnimationFrame(focusFirst);
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
    }
    // Escape is handled by the owning tool's capture-phase keydown listener.
    e.stopPropagation(); // never let drawing shortcuts fire while typing
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

  /** returns the field value in MM (length fields converted from display unit) */
  getValue(name: string): number | null {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return null;
    return parseField(f.input.value, f.def.kind);
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
