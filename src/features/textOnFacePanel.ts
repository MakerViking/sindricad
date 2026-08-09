// Parameter panel for Text on Face — the click-a-face text tool.
//
// Modelled on TexturePanel rather than the sketch TextPanel: docked top-right
// instead of cursor-anchored (the text lands where you clicked, so a panel over
// that spot would hide the thing you are editing), and Esc belongs to the TOOL,
// not the panel — the tool is alive from before the panel exists until cleanup,
// and a refused commit must leave the panel up and recoverable.

export interface TextOnFaceValues {
  text: string;
  font?: string;
  height: number;
  style: "regular" | "bold" | "italic" | "bolditalic";
  align: "left" | "center" | "right";
  angle: number;
  depth: number;
  operation: "emboss" | "engrave";
  bevel: number;
  bevelStyle: "auto" | "chamfer" | "fillet" | "taper";
  boxWidth?: number;
}

export class TextOnFacePanel {
  private root: HTMLDivElement | null = null;
  private read: (() => TextOnFaceValues) | null = null;
  private onCommit: ((v: TextOnFaceValues) => void) | null = null;
  private onChange: ((v: TextOnFaceValues) => void) | null = null;
  private onCancel: (() => void) | null = null;

  get isActive() {
    return !!this.root;
  }

  /** Does this element belong to the panel? The tool's capture-phase key handler
   *  asks before treating a keystroke as a shortcut — otherwise typing "T" in
   *  the text box fires the Text tool and closes the panel (the exact bug the
   *  sketch Text tool hit, fixed there with ui/focus.ts isEditableTarget). */
  ownsTarget(el: EventTarget | null): boolean {
    return !!this.root && el instanceof Node && this.root.contains(el);
  }

  show(
    opts: { editing: boolean; fonts: string[]; initial: Partial<TextOnFaceValues> },
    handlers: {
      onCommit: (v: TextOnFaceValues) => void;
      onChange: (v: TextOnFaceValues) => void;
      onCancel: () => void;
    },
  ) {
    this.hide();
    this.onCommit = handlers.onCommit;
    this.onChange = handlers.onChange;
    this.onCancel = handlers.onCancel;
    const init = opts.initial;

    const root = document.createElement("div");
    this.root = root;
    Object.assign(root.style, {
      position: "fixed", top: "60px", right: "16px", width: "270px",
      background: "#20242c", color: "#dce3ee", border: "1px solid #3a4150",
      borderRadius: "6px", padding: "8px", zIndex: "60",
      font: "12px/1.4 system-ui, sans-serif", colorScheme: "dark",
      boxShadow: "0 6px 20px rgba(0,0,0,.45)",
    });
    document.body.appendChild(root);

    const row = (...kids: HTMLElement[]) => {
      const d = document.createElement("div");
      Object.assign(d.style, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" });
      kids.forEach((k) => d.appendChild(k));
      root.appendChild(d);
      return d;
    };
    const style = (el: HTMLElement) =>
      Object.assign(el.style, {
        background: "#161a20", color: "#dce3ee", border: "1px solid #3a4150",
        borderRadius: "3px", padding: "3px 5px", font: "inherit",
      });
    const label = (t: string) => {
      const l = document.createElement("label");
      l.textContent = t;
      Object.assign(l.style, { opacity: ".75", minWidth: "62px" });
      return l;
    };
    const num = (v: number, step: string, min?: string) => {
      const i = document.createElement("input");
      i.type = "number"; i.value = String(v); i.step = step;
      if (min !== undefined) i.min = min;
      style(i); i.style.width = "70px";
      return i;
    };

    const title = document.createElement("div");
    title.textContent = opts.editing ? "Edit text on face" : "Text on face";
    Object.assign(title.style, { fontWeight: "600", marginBottom: "6px" });
    root.appendChild(title);

    const text = document.createElement("textarea");
    text.value = init.text ?? "";
    text.rows = 2;
    text.placeholder = "Type your text";
    style(text);
    Object.assign(text.style, { width: "100%", resize: "vertical", boxSizing: "border-box" });
    root.appendChild(text);
    root.appendChild(document.createElement("div")).style.height = "6px";

    const font = document.createElement("select");
    style(font); font.style.flex = "1";
    const def = document.createElement("option");
    def.value = ""; def.textContent = "Default font";
    font.appendChild(def);
    for (const f of opts.fonts) {
      const o = document.createElement("option");
      o.value = f; o.textContent = f;
      font.appendChild(o);
    }
    font.value = init.font ?? "";
    row(label("Font"), font);

    const height = num(init.height ?? 6, "0.5", "0.01");
    const depth = num(init.depth ?? 0.6, "0.1", "0.01");
    row(label("Size mm"), height, label("Depth"), depth);

    const op = document.createElement("select");
    style(op); op.style.flex = "1";
    for (const [v, t] of [["emboss", "Emboss (raised)"], ["engrave", "Engrave (cut)"]] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      op.appendChild(o);
    }
    op.value = init.operation ?? "emboss";
    row(label("Style"), op);

    const bold = document.createElement("input");
    bold.type = "checkbox";
    bold.checked = (init.style ?? "regular").includes("bold");
    const italic = document.createElement("input");
    italic.type = "checkbox";
    italic.checked = (init.style ?? "regular").includes("italic");
    const align = document.createElement("select");
    style(align);
    for (const a of ["left", "center", "right"] as const) {
      const o = document.createElement("option");
      o.value = a; o.textContent = a;
      align.appendChild(o);
    }
    align.value = init.align ?? "left";
    row(label("B / I"), bold, italic, align);

    const angle = num(init.angle ?? 0, "5");
    const boxWidth = num(init.boxWidth ?? 0, "1", "0");
    boxWidth.title = "0 = no wrapping";
    row(label("Angle °"), angle, label("Wrap"), boxWidth);

    const bevel = num(init.bevel ?? 0, "0.05", "0");
    bevel.title = "0 = sharp edges. Measured in mm, not degrees.";
    const bevelStyle = document.createElement("select");
    style(bevelStyle);
    for (const [v, t] of [["auto", "auto"], ["chamfer", "chamfer"], ["fillet", "round"], ["taper", "sloped"]] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      bevelStyle.appendChild(o);
    }
    bevelStyle.value = init.bevelStyle ?? "auto";
    bevelStyle.title =
      "Which edges the bevel uses. 'auto' picks whichever one this font can " +
      "actually manage on every letter — that differs by font, so it is usually " +
      "the right choice.";
    const bevelRow = row(label("Bevel mm"), bevel, bevelStyle);
    const syncBevel = () => {
      bevelStyle.style.visibility = Number(bevel.value) > 0 ? "visible" : "hidden";
    };
    bevel.addEventListener("input", syncBevel);
    syncBevel();
    void bevelRow;

    this.read = () => {
      const s =
        bold.checked && italic.checked ? "bolditalic" : bold.checked ? "bold" : italic.checked ? "italic" : "regular";
      const v: TextOnFaceValues = {
        text: text.value,
        height: Number(height.value) || 0,
        style: s,
        align: align.value as TextOnFaceValues["align"],
        angle: Number(angle.value) || 0,
        depth: Number(depth.value) || 0,
        operation: op.value as TextOnFaceValues["operation"],
        bevel: Number(bevel.value) || 0,
        bevelStyle: bevelStyle.value as TextOnFaceValues["bevelStyle"],
      };
      if (font.value) v.font = font.value;
      if (Number(boxWidth.value) > 0) v.boxWidth = Number(boxWidth.value);
      return v;
    };

    const emit = () => this.onChange?.(this.read!());
    for (const el of [text, font, height, depth, op, bold, italic, align, angle, boxWidth, bevel, bevelStyle]) {
      el.addEventListener("input", emit);
      el.addEventListener("change", emit);
    }
    // Plain Enter inserts a newline (multi-line text is a real use); Ctrl/Cmd+Enter commits.
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commit();
      }
    });

    const btn = (t: string, bg: string) => {
      const b = document.createElement("button");
      b.textContent = t;
      Object.assign(b.style, {
        flex: "1", border: "1px solid #3a4150", borderRadius: "3px",
        padding: "4px 6px", cursor: "pointer", font: "inherit", background: bg, color: "#0f1216",
      });
      return b;
    };
    const ok = btn(opts.editing ? "✓ Apply" : "✓ Add", "#7fd18a");
    const no = btn("✕ Cancel", "#3a4150");
    no.style.color = "#dce3ee";
    // pointerdown + preventDefault so the button never blurs the field being
    // typed into, and never reaches the canvas underneath
    ok.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.commit(); });
    no.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.onCancel?.(); });
    row(ok, no);

    text.focus();
    text.select();
  }

  /** Deliberately does NOT hide: the tool may refuse an empty commit, and the
   *  panel has to stay up so the user can fix it. */
  private commit() {
    if (!this.read) return;
    this.onCommit?.(this.read());
  }

  hide() {
    this.root?.remove();
    this.root = null;
    this.read = null;
    this.onCommit = this.onChange = null;
    this.onCancel = null;
  }
}
