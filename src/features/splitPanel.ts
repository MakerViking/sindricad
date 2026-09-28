// The docked Split Body panel: two selection fields, an offset, which side to
// keep, OK / Cancel. DOM only — every decision about what a click or a field
// means is in splitState.ts, and the tool (splitTool.ts) owns the canvas, the
// Browser hook, Enter and Escape.
//
// Same chrome and dock as the texture panel (`.tool-panel`, top-right): a split
// can span every visible body, so there is no one point on screen for a
// cursor-anchored box to follow.
//
// update() rewrites text and classes in place and never rebuilds the inputs,
// so the offset field keeps its caret while the arrow is dragged or a body is
// clicked.

import { icon, type IconName } from "../ui/icons";
import { t, setText, setTitle } from "../i18n";
import { badNumberField, fmtNumber, numericInput, parseNumber, round, toDisplay, fromDisplay, getUnit } from "../ui/units";
import type { SplitField, SplitKeep } from "./splitState";

export interface SplitPanelView {
  editing: boolean;
  bodyText: string;
  bodyEmpty: boolean;
  toolText: string;
  toolEmpty: boolean;
  /** null once both fields are filled: neither is lit (SplitState.active) */
  active: SplitField | null;
  allVisible: boolean;
  visibleCount: number;
  keep: SplitKeep;
  /** something that will stop OK, said before OK is pressed; null = nothing */
  warning: string | null;
}

export interface SplitPanelHandlers {
  onActivate: (field: SplitField) => void;
  onClear: (field: SplitField) => void;
  onAllVisible: (on: boolean) => void;
  /** a readable offset typed into the field, in mm */
  onOffset: (mm: number) => void;
  onKeep: (keep: SplitKeep) => void;
  onOk: () => void;
  onCancel: () => void;
}

interface FieldEls {
  box: HTMLDivElement;
  value: HTMLSpanElement;
  clear: HTMLButtonElement;
}

export class SplitPanel {
  private root: HTMLDivElement;
  private active = false;
  private fields: Record<SplitField, FieldEls> | null = null;
  private allVisible: HTMLInputElement | null = null;
  private allVisibleLabel: HTMLSpanElement | null = null;
  private offset: HTMLInputElement | null = null;
  private keepBtns: Record<SplitKeep, HTMLButtonElement> | null = null;
  private warnEl: HTMLDivElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "tool-panel split-panel";
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
    return !!target && this.root.contains(target as Node);
  }

  /** The panel's Cancel button, so the tool's Enter handler can let a focused
   *  Cancel mean cancel rather than OK. */
  get cancelButton(): HTMLButtonElement | null {
    return this.cancelBtn;
  }

  show(view: SplitPanelView, offsetMm: number, h: SplitPanelHandlers) {
    this.hide();
    this.active = true;
    this.root.innerHTML = "";
    this.root.style.display = "block";
    // Just below the ribbon, measured, not at a fixed 60 px: the ribbon is
    // about 89 px tall and grows with its captions, so at 60 px the panel sat
    // over its right end (the PRINT group).
    const ribbon = document.getElementById("ribbon")?.getBoundingClientRect();
    const top = ribbon ? Math.round(ribbon.bottom) + 8 : 60;
    this.root.style.top = `${top}px`;
    this.root.style.maxHeight = `calc(100vh - ${top + 20}px)`;

    const title = document.createElement("div");
    title.className = "tool-panel-title";
    setText(title, "tool.split");
    this.root.appendChild(title);

    const body = this.field("body", "feature.split.bodyField", h);
    const allRow = document.createElement("label");
    allRow.className = "split-all-visible";
    // Inside the Body box, whose own click makes Body the active field and
    // redraws the panel from the state; letting the checkbox's click reach it
    // put the box back to unticked before its `change` could land (found by
    // the headless drive: the tick never stuck).
    allRow.addEventListener("click", (e) => e.stopPropagation());
    const all = document.createElement("input");
    all.type = "checkbox";
    all.addEventListener("change", () => h.onAllVisible(all.checked));
    const allText = document.createElement("span");
    allRow.append(all, allText);
    body.box.appendChild(allRow);
    this.allVisible = all;
    this.allVisibleLabel = allText;

    const tool = this.field("tool", "feature.split.toolField", h);
    this.fields = { body, tool };

    // Offset, in the display unit like every other length field; the tool
    // stores mm.
    const offRow = row(this.root);
    const offLabel = document.createElement("label");
    setText(offLabel, "inspector.field.offset");
    const off = numericInput(document.createElement("input"), 1);
    off.style.width = "80px";
    off.value = fmtNumber(round(toDisplay(offsetMm)));
    const unit = document.createElement("span");
    unit.className = "tool-panel-hint";
    unit.textContent = getUnit(); // unit abbreviations are not translated (docs/I18N.md)
    const emitOffset = () => {
      off.classList.toggle("invalid", badNumberField(off));
      const v = off.value.trim() === "" ? 0 : parseNumber(off.value);
      if (v !== null) h.onOffset(fromDisplay(v));
    };
    off.addEventListener("input", emitOffset);
    off.addEventListener("change", emitOffset);
    offRow.append(offLabel, off, unit);
    this.offset = off;

    // Label above the chips, not beside them: three chips and a label on one
    // line overflowed the panel once the words grew (measured in the headless
    // drive with untranslated keys, and the pseudo-locale grows text ~35%).
    const keepLabel = document.createElement("div");
    keepLabel.className = "split-field-label";
    setText(keepLabel, "feature.split.keep");
    this.root.appendChild(keepLabel);
    const keepRow = row(this.root);
    const chip = (k: SplitKeep, key: string, titleKey: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool-chip";
      b.style.flex = "1";
      setText(b, key);
      setTitle(b, titleKey);
      b.addEventListener("click", () => h.onKeep(k));
      keepRow.appendChild(b);
      return b;
    };
    this.keepBtns = {
      both: chip("both", "feature.split.keepBoth", "feature.split.keepBothTitle"),
      top: chip("top", "feature.split.keepAbove", "feature.split.keepAboveTitle"),
      bottom: chip("bottom", "feature.split.keepBelow", "feature.split.keepBelowTitle"),
    };

    this.warnEl = document.createElement("div");
    this.warnEl.className = "tool-panel-warn";
    this.root.appendChild(this.warnEl);

    const btns = row(this.root);
    btns.style.marginBottom = "0";
    btns.style.justifyContent = "flex-end";
    const ok = button(t("common.ok"), "confirm", "check");
    ok.addEventListener("click", () => h.onOk());
    const no = button(t("common.cancel"), "cancel", "close");
    no.addEventListener("click", () => h.onCancel());
    btns.append(ok, no);
    this.cancelBtn = no;

    this.update(view);
  }

  private field(which: SplitField, labelKey: string, h: SplitPanelHandlers): FieldEls {
    const box = document.createElement("div");
    box.className = "split-field";
    // The whole box is the target, not just its text: the field is what the
    // user makes active, and a label-sized hit area inside a 270px panel is a
    // miss waiting to happen.
    box.addEventListener("click", () => h.onActivate(which));
    const label = document.createElement("div");
    label.className = "split-field-label";
    setText(label, labelKey);
    const line = document.createElement("div");
    line.className = "split-field-line";
    const value = document.createElement("span");
    value.className = "split-field-value";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "split-field-clear";
    clear.innerHTML = icon("close");
    setTitle(clear, "feature.split.clearField");
    clear.setAttribute("aria-label", t("feature.split.clearField"));
    clear.addEventListener("click", (e) => {
      e.stopPropagation(); // clearing is not also a click on the field
      h.onClear(which);
    });
    line.append(value, clear);
    box.append(label, line);
    this.root.appendChild(box);
    return { box, value, clear };
  }

  update(view: SplitPanelView) {
    if (!this.active || !this.fields) return;
    for (const which of ["body", "tool"] as const) {
      const f = this.fields[which];
      const empty = which === "body" ? view.bodyEmpty : view.toolEmpty;
      f.box.classList.toggle("active", view.active === which);
      f.value.classList.toggle("empty", empty);
      f.value.textContent = which === "body" ? view.bodyText : view.toolText;
      f.value.title = f.value.textContent;
      f.clear.style.visibility = empty ? "hidden" : "visible";
    }
    if (this.allVisible) this.allVisible.checked = view.allVisible;
    if (this.allVisibleLabel) setText(this.allVisibleLabel, "feature.split.allVisible", { count: view.visibleCount });
    if (this.keepBtns) for (const k of ["both", "top", "bottom"] as const) this.keepBtns[k].classList.toggle("on", view.keep === k);
    if (this.warnEl) {
      this.warnEl.textContent = view.warning ?? "";
      this.warnEl.style.display = view.warning ? "block" : "none";
    }
  }

  /** The arrow was dragged: show its value, focused field or not. The arrow's
   *  press does not take focus from the field, and a field left holding the
   *  number typed BEFORE the drag sent that stale number back on blur, so the
   *  cut jumped back from where the preview had it (or OK cut at the dragged
   *  value while the field showed the typed one). A drag and typing cannot
   *  happen at once, so nothing typed is lost. */
  setOffset(mm: number) {
    const off = this.offset;
    if (!off) return;
    off.value = fmtNumber(round(toDisplay(mm)));
    off.classList.remove("invalid");
  }

  /** True when the offset field holds text the app cannot read ("3.14.15"). OK
   *  refuses it rather than cutting at the last readable value. */
  offsetUnreadable(): boolean {
    return !!this.offset && badNumberField(this.offset);
  }

  hide() {
    if (!this.active) return;
    this.active = false;
    this.root.style.display = "none";
    this.root.innerHTML = "";
    this.fields = null;
    this.allVisible = this.allVisibleLabel = null;
    this.offset = null;
    this.keepBtns = null;
    this.warnEl = null;
    this.cancelBtn = null;
  }
}

function row(parent: HTMLElement): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "split-row";
  parent.appendChild(d);
  return d;
}

function button(text: string, variant: "confirm" | "cancel", iconName: IconName): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = `${icon(iconName)}<span></span>`;
  b.querySelector("span")!.textContent = text;
  b.className = `panel-btn panel-btn-${variant}`;
  return b;
}
