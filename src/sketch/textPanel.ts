// Floating HTML panel for the sketch Text tool. DimInput is numeric-only, so text
// gets its own small panel: a multi-line string, a system-font picker (fonts come
// from the sidecar's listFonts op), size, bold/italic, alignment and rotation. On
// every edit it fires onChange for a live preview; ✓/Enter commits, ✕/Esc cancels.

export interface TextValues {
  text: string;
  font?: string;
  height: number;
  style: "regular" | "bold" | "italic" | "bolditalic";
  align: "left" | "center" | "right";
  angle: number;
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
  private escHandler = (e: KeyboardEvent) => {
    if (this.active && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    }
  };

  constructor() {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", zIndex: "50", display: "none", padding: "8px",
      background: "#20242c", border: "1px solid #3a4150", borderRadius: "6px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.4)", font: "12px system-ui, sans-serif",
      color: "#dce3ee", width: "300px", maxWidth: "calc(100vw - 24px)", boxSizing: "border-box",
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
    const inputStyle = (el: HTMLElement) =>
      Object.assign(el.style, { background: "#161a20", color: "#dce3ee", border: "1px solid #3a4150", borderRadius: "3px", padding: "3px 5px", font: "inherit" });

    const ta = document.createElement("textarea");
    ta.value = initial.text ?? "";
    ta.rows = 2;
    ta.placeholder = "Text…";
    Object.assign(ta.style, { width: "100%", resize: "vertical" });
    inputStyle(ta);
    this.root.appendChild(ta);
    this.root.appendChild(Object.assign(document.createElement("div"), { style: "height:6px" }));

    const font = document.createElement("select");
    inputStyle(font);
    Object.assign(font.style, { flex: "1", minWidth: "0", maxWidth: "100%" });
    const def = new Option("Default font", "");
    font.appendChild(def);
    for (const f of fonts) font.appendChild(new Option(f, f));
    font.value = initial.font ?? "";
    row(font);

    const size = document.createElement("input");
    size.type = "number";
    size.value = String(initial.height ?? 10);
    size.min = "0.1";
    Object.assign(size.style, { width: "56px" });
    inputStyle(size);
    const angle = document.createElement("input");
    angle.type = "number";
    angle.value = String(initial.angle ?? 0);
    Object.assign(angle.style, { width: "56px" });
    inputStyle(angle);
    row(label("Size"), size, label("Angle°"), angle);

    const bold = checkbox(String(initial.style ?? "regular").includes("bold"));
    const italic = checkbox(String(initial.style ?? "regular").includes("italic"));
    const align = document.createElement("select");
    inputStyle(align);
    for (const a of ["left", "center", "right"]) align.appendChild(new Option(a, a));
    align.value = initial.align ?? "left";
    row(label("B", bold), bold, label("I", italic), italic, align);

    this.read = (): TextValues => ({
      text: ta.value,
      ...(font.value ? { font: font.value } : {}),
      height: parseFloat(size.value) || 10,
      style: styleOf(bold.checked, italic.checked),
      align: align.value as TextValues["align"],
      angle: parseFloat(angle.value) || 0,
    });

    const emit = () => this.onChange?.(this.read!());
    for (const el of [ta, font, size, angle, bold, italic, align]) {
      el.addEventListener("input", emit);
      el.addEventListener("change", emit);
    }

    const ok = button("✓ Add", "#2b6");
    ok.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.commit(); });
    const no = button("✕", "#555");
    no.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.cancel(); });
    const btns = row(ok, no);
    btns.style.marginBottom = "0";
    btns.style.justifyContent = "flex-end";

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(); }
    });
    document.addEventListener("keydown", this.escHandler, true);
    ta.focus();
  }

  private commit() {
    if (!this.active || !this.read) return;
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

function button(text: string, bg: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  Object.assign(b.style, { background: bg, color: "#fff", border: "none", borderRadius: "4px", padding: "4px 10px", cursor: "pointer", font: "inherit" });
  return b;
}
