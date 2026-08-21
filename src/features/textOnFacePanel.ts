// Parameter panel for Text on Face — the click-a-face text tool.
//
// Modelled on TexturePanel rather than the sketch TextPanel: docked top-right
// instead of cursor-anchored (the text lands where you clicked, so a panel over
// that spot would hide the thing you are editing), and Esc belongs to the TOOL,
// not the panel — the tool is alive from before the panel exists until cleanup,
// and a refused commit must leave the panel up and recoverable.

import { icon, type IconName } from "../ui/icons";

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
  /** Placement offsets in the face plane's own frame, millimetres. `u` runs
   *  horizontally across the face and `v` up it — see textFrame() in
   *  textOnFaceTool, which is what makes those two directions predictable
   *  rather than "whatever axis the picker happened to choose". Seeded from the
   *  click, then editable here so a placement can be typed exactly. */
  u: number;
  v: number;
  /** Palette slot for the glyphs, or null to inherit the body's colour. */
  colorSlot: number | null;
}

export class TextOnFacePanel {
  private root: HTMLDivElement | null = null;
  private read: (() => TextOnFaceValues) | null = null;
  private onCommit: ((v: TextOnFaceValues) => void) | null = null;
  private onChange: ((v: TextOnFaceValues) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private setUV: ((u: number, v: number) => void) | null = null;

  /** Push a placement in from the viewport (a drag), so the numeric fields and
   *  the model never disagree about where the text is. Deliberately does NOT
   *  re-emit onChange: the drag is already driving the preview, and echoing
   *  would queue a second rebuild per pointer move. */
  setPlacement(u: number, v: number) {
    this.setUV?.(u, v);
  }

  get isActive() {
    return !!this.root;
  }

  /** The panel's current values, or null when it is closed. Lets the tool draw
   *  a preview the moment the panel opens instead of waiting for the first
   *  edit — the edit path never fires an onChange on its own. */
  get values(): TextOnFaceValues | null {
    return this.read ? this.read() : null;
  }

  /** Does this element belong to the panel? The tool's capture-phase key handler
   *  asks before treating a keystroke as a shortcut — otherwise typing "T" in
   *  the text box fires the Text tool and closes the panel (the exact bug the
   *  sketch Text tool hit, fixed there with ui/focus.ts isEditableTarget). */
  ownsTarget(el: EventTarget | null): boolean {
    return !!this.root && el instanceof Node && this.root.contains(el);
  }

  show(
    opts: {
      editing: boolean;
      fonts: string[];
      initial: Partial<TextOnFaceValues>;
      /** the document palette, for the glyph-colour chips */
      palette?: { name: string; color: string; material?: string }[];
    },
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
    root.className = "tool-panel";
    Object.assign(root.style, {
      top: "60px", right: "16px", width: "300px", zIndex: "60",
    });
    document.body.appendChild(root);

    const row = (...kids: HTMLElement[]) => {
      const d = document.createElement("div");
      Object.assign(d.style, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" });
      kids.forEach((k) => d.appendChild(k));
      root.appendChild(d);
      return d;
    };
    const label = (t: string) => {
      const l = document.createElement("label");
      l.textContent = t;
      // nowrap: a two-word label ("Across mm") otherwise wraps to two lines and
      // shoves the rest of its row sideways.
      Object.assign(l.style, {
        opacity: ".75", minWidth: "62px", whiteSpace: "nowrap", flex: "0 0 auto",
      });
      return l;
    };
    const num = (v: number, step: string, min?: string) => {
      const i = document.createElement("input");
      i.type = "number"; i.value = String(v); i.step = step;
      if (min !== undefined) i.min = min;
      // FLEXIBLE, not a fixed 70px. The paired rows (Size/Depth, Across/Up,
      // Angle/Wrap) put label+input+label+input in one flex row: at fixed widths
      // that is 62+70+62+70 plus three 6px gaps = 282px against the 252px this
      // panel actually has inside its padding, so the second input of every pair
      // hung outside the panel and off the window — reported with Depth, Up and
      // Wrap all unreachable. Letting the inputs share what is left makes the row
      // fit whatever the panel is.
      Object.assign(i.style, { flex: "1 1 0", minWidth: "0", boxSizing: "border-box" });
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
    Object.assign(text.style, { width: "100%", resize: "vertical", boxSizing: "border-box" });
    root.appendChild(text);
    root.appendChild(document.createElement("div")).style.height = "6px";

    const font = document.createElement("select");
    font.style.flex = "1";
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

    // Placement. Seeded from where the click landed, so these open showing the
    // spot the user already chose rather than 0/0 — a field that disagrees with
    // what is on screen is worse than no field.
    const offU = num(init.u ?? 0, "0.5");
    const offV = num(init.v ?? 0, "0.5");
    row(label("Across mm"), offU, label("Up"), offV);

    const op = document.createElement("select");
    op.style.flex = "1";
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
    Object.assign(align.style, { flex: "1 1 0", minWidth: "0" });
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
    Object.assign(bevelStyle.style, { flex: "1 1 0", minWidth: "0" });
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

    // Filament slot for the letters. Chips rather than a <select> because the
    // thing being chosen IS a colour — the same swatch vocabulary the body
    // colour menu uses (browserTree.bodyColorMenuItems). "—" is inherit, which
    // is the default and what every text before this had.
    let emitLater = () => {};
    let slot: number | null = init.colorSlot ?? null;
    const chips: HTMLButtonElement[] = [];
    const paintChips = () => {
      chips.forEach((c, i) => {
        const on = (i === 0 && slot === null) || i - 1 === slot;
        c.style.outline = on ? "2px solid var(--accent, #6cf)" : "1px solid var(--line-strong)";
        c.style.outlineOffset = on ? "1px" : "0";
      });
    };
    const chip = (bg: string, title: string, value: number | null) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = title;
      Object.assign(b.style, {
        width: "22px", height: "18px", padding: "0", borderRadius: "3px",
        background: bg, border: "none", cursor: "pointer", flex: "0 0 auto",
      });
      // pointerdown + preventDefault so choosing a colour never blurs the text
      // area mid-sentence — the same reason the OK/Cancel buttons do it.
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        slot = value;
        paintChips();
        emitLater();
      });
      chips.push(b);
      return b;
    };
    const slotRow = row(label("Color"));
    slotRow.appendChild(chip("transparent", "Use the body's colour", null));
    chips[0]!.textContent = "—";
    Object.assign(chips[0]!.style, { color: "var(--text)", fontSize: "11px", lineHeight: "18px" });
    (opts.palette ?? []).forEach((sl, i) => {
      slotRow.appendChild(chip(sl.color, `${sl.name} (slot ${i + 1})`, i));
    });
    paintChips();
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
        u: Number(offU.value) || 0,
        v: Number(offV.value) || 0,
        colorSlot: slot,
      };
      if (font.value) v.font = font.value;
      if (Number(boxWidth.value) > 0) v.boxWidth = Number(boxWidth.value);
      return v;
    };

    this.setUV = (u, v) => {
      offU.value = String(Math.round(u * 1000) / 1000);
      offV.value = String(Math.round(v * 1000) / 1000);
    };

    const emit = () => this.onChange?.(this.read!());
    // The chips fire before `read` exists during construction, so defer through
    // the same emit the inputs use rather than calling onChange directly.
    emitLater = () => emit();
    for (const el of [text, font, height, depth, op, bold, italic, align, angle, boxWidth, bevel, bevelStyle, offU, offV]) {
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

    const btn = (t: string, variant: "confirm" | "cancel", iconName: IconName) => {
      const b = document.createElement("button");
      b.className = `panel-btn panel-btn-${variant}`;
      b.innerHTML = `${icon(iconName)}<span></span>`;
      b.querySelector("span")!.textContent = t;
      b.style.flex = "1";
      return b;
    };
    const ok = btn(opts.editing ? "Apply" : "Add", "confirm", "check");
    const no = btn("Cancel", "cancel", "close");
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
