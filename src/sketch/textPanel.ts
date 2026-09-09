// Floating HTML panel for the sketch Text tool. DimInput is numeric-only, so text
// gets its own small panel: a multi-line string, a system-font picker (fonts come
// from the sidecar's listFonts op), size, bold/italic, alignment and rotation. On
// every edit it fires onChange for a live preview; Add/Enter commits, Cancel/Esc dismisses.

import { t } from "../i18n";
import { isImeComposing } from "../ui/focus";
import { icon, type IconName } from "../ui/icons";
import { setPrompt } from "../ui/prompt";
import { badNumberField, fmtNumber, numericInput, parseNumber, typedNumber } from "../ui/units";

/** True when the user typed something into `el` that the app cannot read
 *  ("3.14.15", "1.2.3" — ui/units refuses those rather than guessing 314.15 and
 *  12.3). Empty is NOT bad: a cleared field means "leave it at the default". */
export interface TextValues {
  text: string;
  font?: string;
  height: number;
  style: "regular" | "bold" | "italic" | "bolditalic";
  align: "left" | "center" | "right";
  angle: number;
  boxWidth?: number; // wrap width (mm) — text fits inside this box
}

function styleOf(bold: boolean, italic: boolean): TextValues["style"] {
  return bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "regular";
}

export class TextPanel {
  private root: HTMLDivElement;
  private active = false;
  private onCommit: ((v: TextValues) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private onChange: ((v: TextValues) => void) | null = null;
  private read: (() => TextValues) | null = null;
  /** The numeric inputs, for the commit guard. Rebuilt by every show(). */
  private numFields: HTMLInputElement[] = [];
  /** The one field whose value must be > 0 — see the commit guard. */
  private sizeField: HTMLInputElement | null = null;
  private escHandler = (e: KeyboardEvent) => {
    // NOT while an IME is composing: Escape is how a Japanese, Chinese or
    // Korean IME CANCELS A CONVERSION, and this panel is the likeliest place in
    // the app to be mid-conversion. Cancelling here threw away the sentence
    // being typed, one keystroke into it. (ui/focus owns the two-signal test.)
    if (this.active && e.key === "Escape" && !isImeComposing(e)) {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    }
  };

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "tool-panel";
    Object.assign(this.root.style, {
      display: "none", width: "300px", maxWidth: "calc(100vw - 24px)",
    } as CSSStyleDeclaration);
    document.body.appendChild(this.root);
  }

  get isActive() {
    return this.active;
  }

  show(
    screen: { x: number; y: number },
    fonts: string[],
    initial: Partial<TextValues>,
    handlers: { onCommit: (v: TextValues) => void; onCancel: () => void; onChange: (v: TextValues) => void },
  ) {
    this.hide();
    this.onCommit = handlers.onCommit;
    this.onCancel = handlers.onCancel;
    this.onChange = handlers.onChange;
    this.active = true;
    this.root.innerHTML = "";
    this.root.style.display = "block";
    this.root.style.left = `${Math.max(8, Math.min(screen.x, window.innerWidth - 316))}px`;
    this.root.style.top = `${Math.max(8, Math.min(screen.y, window.innerHeight - 240))}px`;

    const row = (...kids: HTMLElement[]) => {
      const d = document.createElement("div");
      Object.assign(d.style, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" });
      kids.forEach((k) => d.appendChild(k));
      this.root.appendChild(d);
      return d;
    };

    const ta = document.createElement("textarea");
    ta.value = initial.text ?? "";
    ta.rows = 2;
    ta.placeholder = t("sketch.text.placeholder");
    Object.assign(ta.style, { width: "100%", resize: "vertical" });
    this.root.appendChild(ta);
    this.root.appendChild(Object.assign(document.createElement("div"), { style: "height:6px" }));

    const font = document.createElement("select");
    Object.assign(font.style, { flex: "1", minWidth: "0", maxWidth: "100%" });
    const def = new Option(t("sketch.text.defaultFont"), "");
    font.appendChild(def);
    for (const f of fonts) font.appendChild(new Option(f, f));
    font.value = initial.font ?? "";
    row(font);

    const size = numericInput(document.createElement("input"));
    size.value = fmtNumber(initial.height ?? 10);
    size.min = "0.1";
    Object.assign(size.style, { width: "56px" });
    const angle = numericInput(document.createElement("input"));
    angle.value = fmtNumber(initial.angle ?? 0);
    Object.assign(angle.style, { width: "56px" });
    row(label(t("common.size")), size, label(t("sketch.text.angleDeg")), angle);

    const bold = checkbox(String(initial.style ?? "regular").includes("bold"));
    const italic = checkbox(String(initial.style ?? "regular").includes("italic"));
    const align = document.createElement("select");
    for (const a of ["left", "center", "right"] as const) align.appendChild(new Option(t(`sketch.text.align.${a}`), a));
    align.value = initial.align ?? "left";
    row(label(t("sketch.text.bold"), bold), bold, label(t("sketch.text.italic"), italic), italic, align);

    const boxW = numericInput(document.createElement("input"), 0.5);
    boxW.min = "0";
    boxW.step = "0.5";
    boxW.value = initial.boxWidth ? fmtNumber(initial.boxWidth) : "";
    boxW.placeholder = t("sketch.text.noBox");
    Object.assign(boxW.style, { flex: "1", minWidth: "0" });
    row(label(t("sketch.text.boxWidth")), boxW);

    this.read = (): TextValues => ({
      text: ta.value,
      ...(font.value ? { font: font.value } : {}),
      // parseNumber, not parseFloat: parseFloat("12,5") is 12, so a
      // comma-decimal size silently shrank the text (ui/units). An EMPTY field
      // still means "use the default"; text the parser refuses shows the
      // default in the live preview and is refused at commit(), never modelled.
      height: typedNumber(size, 10),
      style: styleOf(bold.checked, italic.checked),
      align: align.value as TextValues["align"],
      angle: typedNumber(angle, 0),
      ...((parseNumber(boxW.value) ?? 0) > 0 ? { boxWidth: parseNumber(boxW.value)! } : {}),
    });

    const emit = () => this.onChange?.(this.read!());
    for (const el of [ta, font, size, angle, bold, italic, align, boxW]) {
      el.addEventListener("input", emit);
      el.addEventListener("change", emit);
    }

    const ok = button(t("common.add"), "confirm", "check");
    ok.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.commit(); });
    const no = button(t("common.cancel"), "cancel", "close");
    no.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.cancel(); });
    const btns = row(ok, no);
    btns.style.marginBottom = "0";
    btns.style.justifyContent = "flex-end";

    this.numFields = [size, angle, boxW];
    this.sizeField = size;

    ta.addEventListener("keydown", (e) => {
      // Enter belongs to the IME while a conversion is open — it CONFIRMS the
      // candidate, and committing the panel out from under that loses the text.
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !isImeComposing(e)) { e.preventDefault(); this.commit(); }
    });
    document.addEventListener("keydown", this.escHandler, true);
    ta.focus();
  }

  private commit() {
    if (!this.active || !this.read) return;
    // A field the app cannot read must not commit as its default: a size typed
    // "3.14.15" used to model 10mm text with nothing said anywhere. Same
    // refusal the sketch dimension fields and press/pull give.
    // `size` is passed as must-be-positive: a height of 0 or less segfaults the
    // geometry engine through the live preview (sidecar/builder.py _text_faces),
    // and the sidecar refuses it too — this is the half that can say why.
    if (this.numFields.some((el) => badNumberField(el, el === this.sizeField))) {
      setPrompt(t("feature.badNumber"));
      return;
    }
    const v = this.read();
    const cb = this.onCommit;
    this.hide();
    if (v.text.trim()) cb?.(v);
  }

  private cancel() {
    const cb = this.onCancel;
    this.hide();
    cb?.();
  }

  hide() {
    if (!this.active) return;
    this.active = false;
    this.root.style.display = "none";
    this.onCommit = this.onCancel = this.onChange = this.read = null;
    this.numFields = [];
    document.removeEventListener("keydown", this.escHandler, true);
  }
}

function label(text: string, forEl?: HTMLElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.textContent = text;
  l.style.whiteSpace = "nowrap";
  if (forEl) l.style.cursor = "pointer";
  return l;
}

function checkbox(checked: boolean): HTMLInputElement {
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = checked;
  return c;
}

function button(text: string, variant: "confirm" | "cancel", iconName?: IconName): HTMLButtonElement {
  const b = document.createElement("button");
  if (iconName) {
    b.innerHTML = `${icon(iconName)}<span></span>`;
    b.querySelector("span")!.textContent = text;
  } else {
    b.textContent = text;
  }
  b.className = `panel-btn panel-btn-${variant}`;
  return b;
}
