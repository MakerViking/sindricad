// On-canvas heads-up dimension input — the signature Fusion interaction.
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
  ) {
    this.hide();
    this.onCommit = onCommit;
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
    // focus first field so typing goes straight to it
    this.fields[0]?.input.focus();
  }

  private onKey(e: KeyboardEvent, field: Field) {
    if (e.key === "Tab") {
      e.preventDefault();
      field.userDriven = true; // Tab locks the current field
      const i = this.fields.indexOf(field);
      const next = this.fields[(i + 1) % this.fields.length];
      next.input.focus();
      next.input.select();
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
      if (!f.userDriven && values[f.def.name] != null) {
        f.input.value = String(displayValue(values[f.def.name], f.def.kind));
      }
    }
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
  }
}
