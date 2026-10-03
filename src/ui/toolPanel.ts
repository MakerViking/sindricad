// A docked, row-based tool panel: a title, a column of rows, a warning line and
// OK / Cancel, top right under the ribbon. The Split Body panel (splitPanel.ts)
// is where this shape was worked out; this is the same dock and chrome with
// the rows made generic, so a tool describes its rows instead of building DOM.
// Extrude is the first user. Split, Texture and Text on Face still build their
// own panels and could move onto this one; they have not been rewritten here.
//
// Three kinds of row, which between them cover every panel so far:
//   - number: a length, angle or count typed in the display unit. It takes an
//     expression as readily as a number (`31.53+2*1.62`, `wall*2`), read the
//     way every dimension box reads one (units.parseFieldExpr).
//   - choice: a segmented set of chips, one of them on.
//   - pick: a box the user makes ACTIVE so the next click in the model fills
//     it, with a clear button. Split's Body and Tool fields are this.
//
// DOM only. What a value means, and which rows apply, is the tool's business;
// the tool owns Enter and Escape too (a capture-phase listener, asking `owns`).
//
// The update calls rewrite text and classes in place and never rebuild an
// input, so a field keeps its caret while an arrow is dragged or a target is
// picked (the Split panel lesson).

import { icon, type IconName } from "./icons";
import { t } from "../i18n";
import { fieldParams, fieldText, getUnit, numericInput, parseFieldExpr, type FieldKind } from "./units";

export type PanelRow =
  | { kind: "number"; id: string; label: string; field?: FieldKind; title?: string }
  | { kind: "choice"; id: string; label: string; options: { value: string; label: string; title?: string }[] }
  | { kind: "pick"; id: string; label: string; clearTitle: string };

export interface ToolPanelHandlers {
  /** Typed into a number row: its value in mm (a length) or as typed (an angle
   *  or a count), null while the text cannot be read, plus the raw text so a
   *  tool can treat an EMPTY field as its default. */
  onNumber?: (id: string, value: number | null, raw: string) => void;
  onChoice?: (id: string, value: string) => void;
  /** a pick box was clicked: make it the active one */
  onPick?: (id: string) => void;
  onClear?: (id: string) => void;
  onOk: () => void;
  onCancel: () => void;
}

interface NumberEls {
  kind: "number";
  row: HTMLElement;
  input: HTMLInputElement;
  field: FieldKind;
}
interface ChoiceEls {
  kind: "choice";
  row: HTMLElement;
  chips: Map<string, HTMLButtonElement>;
}
interface PickEls {
  kind: "pick";
  row: HTMLElement;
  value: HTMLSpanElement;
  clear: HTMLButtonElement;
}
type RowEls = NumberEls | ChoiceEls | PickEls;

export class ToolPanel {
  private root: HTMLDivElement;
  private active = false;
  private rows = new Map<string, RowEls>();
  /** Every element of the panel a key can be aimed at (its inputs and
   *  buttons): what `owns` answers from. */
  private focusable = new Set<EventTarget>();
  /** number rows whose text cannot be read right now */
  private unreadable = new Set<string>();
  private warnEl: HTMLDivElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;

  /** `className` is added beside `tool-panel`, for a tool's own styling hook. */
  constructor(className = "") {
    this.root = document.createElement("div");
    this.root.className = className ? `tool-panel ${className}` : "tool-panel";
    Object.assign(this.root.style, {
      top: "60px", right: "16px", display: "none",
      width: "270px", maxWidth: "calc(100vw - 24px)",
      maxHeight: "calc(100vh - 80px)", overflowY: "auto",
    } as CSSStyleDeclaration);
    document.body.appendChild(this.root);
  }

  get isActive() {
    return this.active;
  }

  /** True when `target` is the panel or inside it: its own fields keep Enter
   *  as OK, while a text field anywhere else keeps its own Enter and Escape. */
  owns(target: EventTarget | null): boolean {
    return !!target && this.focusable.has(target);
  }

  /** The Cancel button, so a tool's Enter handler can let a focused Cancel
   *  mean cancel rather than OK. */
  get cancelButton(): HTMLButtonElement | null {
    return this.cancelBtn;
  }

  show(title: string, rows: PanelRow[], h: ToolPanelHandlers) {
    this.hide();
    this.active = true;
    this.root.innerHTML = "";
    this.root.style.display = "block";
    dockBelowRibbon(this.root);

    const head = document.createElement("div");
    head.className = "tool-panel-title";
    head.textContent = title;
    this.root.appendChild(head);

    for (const def of rows) {
      if (def.kind === "number") this.rows.set(def.id, this.numberRow(def, h));
      else if (def.kind === "choice") this.rows.set(def.id, this.choiceRow(def, h));
      else this.rows.set(def.id, this.pickRow(def, h));
    }

    this.warnEl = document.createElement("div");
    this.warnEl.className = "tool-panel-warn";
    this.warnEl.style.display = "none";
    this.root.appendChild(this.warnEl);

    const btns = document.createElement("div");
    btns.className = "tool-panel-buttons";
    const ok = panelButton(t("common.ok"), "confirm", "check");
    ok.addEventListener("click", () => h.onOk());
    const no = panelButton(t("common.cancel"), "cancel", "close");
    no.addEventListener("click", () => h.onCancel());
    btns.appendChild(ok);
    btns.appendChild(no);
    this.root.appendChild(btns);
    this.focusable.add(ok).add(no);
    this.cancelBtn = no;
  }

  private numberRow(def: Extract<PanelRow, { kind: "number" }>, h: ToolPanelHandlers): NumberEls {
    const field = def.field ?? "length";
    const row = document.createElement("label");
    row.className = "tool-panel-row";
    const label = document.createElement("span");
    label.className = "tool-panel-label";
    label.textContent = def.label;
    const input = numericInput(document.createElement("input"), 1);
    input.className = "tool-panel-number";
    if (def.title) input.title = def.title;
    const unit = document.createElement("span");
    unit.className = "tool-panel-hint";
    // unit abbreviations are not translated (docs/I18N.md)
    unit.textContent = field === "length" ? getUnit() : field === "angle" ? "°" : "";
    const emit = () => {
      const raw = input.value.trim();
      const v = raw === "" ? null : parseFieldExpr(raw, field, fieldParams());
      const bad = raw !== "" && v === null;
      input.classList.toggle("invalid", bad);
      if (bad) this.unreadable.add(def.id);
      else this.unreadable.delete(def.id);
      h.onNumber?.(def.id, v, raw);
    };
    input.addEventListener("input", emit);
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(unit);
    this.root.appendChild(row);
    this.focusable.add(input);
    return { kind: "number", row, input, field };
  }

  private choiceRow(def: Extract<PanelRow, { kind: "choice" }>, h: ToolPanelHandlers): ChoiceEls {
    const row = document.createElement("div");
    row.className = "tool-panel-choice";
    const label = document.createElement("span");
    label.className = "tool-panel-label";
    label.textContent = def.label;
    const set = document.createElement("div");
    set.className = "tool-panel-chips";
    const chips = new Map<string, HTMLButtonElement>();
    for (const o of def.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool-chip";
      b.textContent = o.label;
      if (o.title) b.title = o.title;
      b.addEventListener("click", () => h.onChoice?.(def.id, o.value));
      chips.set(o.value, b);
      set.appendChild(b);
      this.focusable.add(b);
    }
    row.appendChild(label);
    row.appendChild(set);
    this.root.appendChild(row);
    return { kind: "choice", row, chips };
  }

  private pickRow(def: Extract<PanelRow, { kind: "pick" }>, h: ToolPanelHandlers): PickEls {
    const row = document.createElement("div");
    row.className = "tool-panel-pick";
    // The whole box is the target, not just its text: a label-sized hit area
    // inside a 270px panel is a miss waiting to happen.
    row.addEventListener("click", () => h.onPick?.(def.id));
    const label = document.createElement("div");
    label.className = "tool-panel-pick-label";
    label.textContent = def.label;
    const line = document.createElement("div");
    line.className = "tool-panel-pick-line";
    const value = document.createElement("span");
    value.className = "tool-panel-pick-value";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tool-panel-pick-clear";
    clear.innerHTML = icon("close");
    clear.title = def.clearTitle;
    clear.setAttribute("aria-label", def.clearTitle);
    clear.addEventListener("click", (e) => {
      e.stopPropagation(); // clearing is not also a click on the box
      h.onClear?.(def.id);
    });
    line.appendChild(value);
    line.appendChild(clear);
    row.appendChild(label);
    row.appendChild(line);
    this.root.appendChild(row);
    this.focusable.add(clear);
    return { kind: "pick", row, value, clear };
  }

  /** Show `value` in a number row: a number (mm for a length) in the display
   *  unit, or text verbatim (a parameter-bound value shows its formula).
   *
   *  Text that already MEANS this number is left alone, so an expression the
   *  user typed (`1/16`) is not rewritten to its value the moment the tool
   *  echoes it back, and the caret stays where it was. */
  setNumber(id: string, value: number | string) {
    const r = this.rows.get(id);
    if (r?.kind !== "number") return;
    if (typeof value === "string") {
      r.input.value = value;
    } else {
      const raw = r.input.value.trim();
      if (raw !== "" && parseFieldExpr(raw, r.field, fieldParams()) === value) return;
      r.input.value = fieldText(value, r.field);
    }
    r.input.classList.remove("invalid");
    this.unreadable.delete(id);
  }

  /** True when the row holds text the app cannot read ("3.14.15", "wall*" with
   *  no such parameter). OK refuses it rather than using the last good value. */
  numberUnreadable(id: string): boolean {
    return this.unreadable.has(id);
  }

  setChoice(id: string, value: string) {
    const r = this.rows.get(id);
    if (r?.kind !== "choice") return;
    for (const [v, b] of r.chips) b.classList.toggle("on", v === value);
  }

  setPick(id: string, text: string, opts: { empty: boolean; active: boolean }) {
    const r = this.rows.get(id);
    if (r?.kind !== "pick") return;
    r.value.textContent = text;
    r.value.title = text;
    r.value.classList.toggle("empty", opts.empty);
    r.row.classList.toggle("active", opts.active);
    r.clear.style.visibility = opts.empty ? "hidden" : "visible";
  }

  /** Rows that do not apply are hidden, not disabled: an input the geometry
   *  ignores reads as "I typed a number and nothing happened". */
  setVisible(id: string, on: boolean) {
    const r = this.rows.get(id);
    if (r) r.row.style.display = on ? "" : "none";
  }

  /** A number row the user may look at but not type into, with the reason as
   *  its tooltip (a value bound to a parameter is changed in Parameters). */
  setReadOnly(id: string, reason: string | null) {
    const r = this.rows.get(id);
    if (r?.kind !== "number") return;
    r.input.disabled = reason !== null;
    r.input.title = reason ?? "";
  }

  /** Something that will stop OK, said before OK is pressed; null = nothing. */
  setWarning(text: string | null) {
    if (!this.warnEl) return;
    this.warnEl.textContent = text ?? "";
    this.warnEl.style.display = text ? "block" : "none";
  }

  hide() {
    if (!this.active) return;
    this.active = false;
    this.root.style.display = "none";
    this.root.innerHTML = "";
    this.rows.clear();
    this.focusable.clear();
    this.unreadable.clear();
    this.warnEl = null;
    this.cancelBtn = null;
  }
}

/** Put a docked panel just below the ribbon, measured, not at a fixed 60 px:
 *  the ribbon is about 89 px tall and grows with its captions, so at 60 px a
 *  panel sat over its right end (found on the Split panel). */
export function dockBelowRibbon(root: HTMLElement) {
  const ribbon = document.getElementById("ribbon")?.getBoundingClientRect();
  const top = ribbon ? Math.round(ribbon.bottom) + 8 : 60;
  root.style.top = `${top}px`;
  root.style.maxHeight = `calc(100vh - ${top + 20}px)`;
}

/** An OK / Cancel style button for a tool panel: an icon, then the text. */
export function panelButton(text: string, variant: "confirm" | "cancel", iconName: IconName): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = icon(iconName);
  const span = document.createElement("span");
  span.textContent = text;
  b.appendChild(span);
  b.className = `panel-btn panel-btn-${variant}`;
  return b;
}
