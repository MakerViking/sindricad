// Parameter panel for Text on Face — the click-a-face text tool.
//
// Modelled on TexturePanel rather than the sketch TextPanel: docked top-right
// instead of cursor-anchored (the text lands where you clicked, so a panel over
// that spot would hide the thing you are editing), and Esc belongs to the TOOL,
// not the panel — the tool is alive from before the panel exists until cleanup,
// and a refused commit must leave the panel up and recoverable.

import { icon, type IconName } from "../ui/icons";
import { t, setText, setTitle } from "../i18n";
import { isImeComposing } from "../ui/focus";
import { setPrompt } from "../ui/prompt";
import {
  badNumberField, dimValueOk, fieldParams, fieldText, fmtNumber, getUnit, numericInput, parseFieldExpr,
  typedNumber, type FieldKind,
} from "../ui/units";

/** The number in a length field, honouring the document unit and accepting a
 *  fraction or arithmetic ("1/16", "wall*2") exactly like a sketch dimension
 *  box does — `dflt` (in mm) when the field is EMPTY or unreadable, same `??`
 *  contract as `typedNumber` (ui/units). X-doug-text-inches: this panel used
 *  to read every field as a bare millimetre with `typedNumber`/`parseNumber`,
 *  so an inch user's "1/16" was refused outright. */
function typedLen(el: { value: string }, dflt: number): number {
  return parseFieldExpr(el.value, "length", fieldParams()) ?? dflt;
}

/** Like `badNumberField`, but for a length field: readable text that is not a
 *  bare number (a fraction, an expression) must not count as bad. */
function badLenField(el: { value: string }, positive = false): boolean {
  const raw = el.value.trim();
  if (raw === "") return false;
  const v = parseFieldExpr(raw, "length", fieldParams());
  if (v === null) return true;
  return positive && !dimValueOk(v, "length");
}

/** True when the user typed something into `el` that the app cannot read
 *  ("3.14.15", "1.2.3" — ui/units refuses those rather than guessing 314.15 and
 *  12.3). Empty is NOT bad: a cleared field means "leave it at the default". */
/** Which filament a flat text should take when the user hasn't chosen one.
 *
 *  Flat glyphs are imprinted flush with the face, so inheriting the body's
 *  colour makes them invisible — and nothing else in the app can colour a face,
 *  so the only way back is to reopen this panel. Picking the first slot that
 *  ISN'T the body's own is what makes the letters appear the moment the style is
 *  chosen. Falls back to slot 0 when the body already holds every alternative
 *  (a one-colour palette), and to null when there is no palette at all — better
 *  an uncoloured text than a slot index that indexes nothing.
 *
 *  Exported and pure so it can be tested on its own; the panel around it is
 *  driven through the fakeDom stub (textOnFacePanel.test.ts). */
export function autoGlyphSlot(paletteLength: number, bodySlot: number | null): number | null {
  for (let i = 0; i < paletteLength; i++) if (i !== bodySlot) return i;
  return paletteLength ? 0 : null;
}

export interface TextOnFaceValues {
  text: string;
  font?: string;
  height: number;
  style: "regular" | "bold" | "italic" | "bolditalic";
  align: "left" | "center" | "right";
  angle: number;
  depth: number;
  operation: "emboss" | "engrave" | "flat";
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
  /** The numeric inputs, for the commit guard. Rebuilt by every show(). */
  private numFields: HTMLInputElement[] = [];
  /** The one field whose value must be > 0 — see the commit guard. */
  private heightField: HTMLInputElement | null = null;
  /** The one field read as a bare angle (degrees), not a length — see the
   *  commit guard, which parses every other numeric field as a length. */
  private angleField: HTMLInputElement | null = null;
  private onCommit: ((v: TextOnFaceValues) => void) | null = null;
  private onChange: ((v: TextOnFaceValues) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private onRepick: (() => void) | null = null;
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
      /** the target body's own slot, so a flat text can auto-pick one that will
       *  actually read against it */
      bodySlot?: number | null;
    },
    handlers: {
      onCommit: (v: TextOnFaceValues) => void;
      onChange: (v: TextOnFaceValues) => void;
      onCancel: () => void;
      /** Editing only: put the text on another face (report 048ec84f). */
      onRepick?: () => void;
    },
  ) {
    this.hide();
    this.onCommit = handlers.onCommit;
    this.onChange = handlers.onChange;
    this.onCancel = handlers.onCancel;
    this.onRepick = handlers.onRepick ?? null;
    const init = opts.initial;

    // Which mm value a length field's CURRENT text came from, so an untouched
    // field can be read back exactly instead of re-parsed. fieldText() rounds
    // to lengthDecimals() for display (4 decimals in inches), and that is a
    // lossy round trip: 6mm -> "0.2362"in -> reparsed is 5.99948mm. Re-deriving
    // a field the user never touched would silently drift it on every commit
    // while the document unit isn't mm — the exact trap ui/units.ts's fieldText
    // doc comment names ("an editor that prefilled this text must not write
    // the text back when the user left it alone"), and the one inspector.ts's
    // commitField avoids with `raw === shown` (X-doug-text-inches).
    const shownLen = new Map<HTMLInputElement, { value: number; text: string }>();

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
    // Live document unit, baked into a length label's text once at open — this
    // panel is not kept open across a unit change, same as the rest of its DOM.
    const unit = getUnit();
    const label = (key: string, kind?: FieldKind) => {
      const l = document.createElement("label");
      setText(l, key);
      // A length label gets the live unit appended (X-doug-text-inches: these
      // used to say "mm" baked into the English string, regardless of the
      // document unit). Angle stays whatever its own key already says
      // ("Angle °") — angles never convert.
      if (kind === "length") l.textContent = `${l.textContent} ${unit}`;
      // nowrap: a two-word label ("Across mm") otherwise wraps to two lines and
      // shoves the rest of its row sideways.
      Object.assign(l.style, {
        opacity: ".75", minWidth: "62px", whiteSpace: "nowrap", flex: "0 0 auto",
      });
      return l;
    };
    const num = (v: number, step: string, min?: string, kind: FieldKind = "length") => {
      const i = numericInput(document.createElement("input"), Number(step));
      // A length shows (and, in read()/badLenField, parses) in the DISPLAY
      // unit, same as a sketch dimension box; angle stays raw degrees.
      i.value = kind === "length" ? fieldText(v, "length") : fmtNumber(v);
      if (kind === "length") shownLen.set(i, { value: v, text: i.value });
      i.step = step;
      // `min` is a hint only now that these are text inputs (it always was: a
      // number input marks an out-of-range value invalid, it does not refuse it,
      // and read() never asked). Kept so the intent stays visible.
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
    setText(title, opts.editing ? "feature.text.editTitle" : "feature.text.title");
    Object.assign(title.style, { fontWeight: "600", marginBottom: "6px" });
    root.appendChild(title);

    const text = document.createElement("textarea");
    text.value = init.text ?? "";
    text.rows = 2;
    text.placeholder = t("feature.text.placeholder");
    Object.assign(text.style, { width: "100%", resize: "vertical", boxSizing: "border-box" });
    root.appendChild(text);
    root.appendChild(document.createElement("div")).style.height = "6px";

    const font = document.createElement("select");
    font.style.flex = "1";
    const def = document.createElement("option");
    def.value = ""; def.textContent = t("feature.text.defaultFont");
    font.appendChild(def);
    for (const f of opts.fonts) {
      const o = document.createElement("option");
      o.value = f; o.textContent = f;
      font.appendChild(o);
    }
    font.value = init.font ?? "";
    row(label("feature.text.font"), font);

    const height = num(init.height ?? 6, "0.5", "0.01");
    const depth = num(init.depth ?? 0.6, "0.1", "0.01");
    const depthLabel = label("feature.text.depth", "length");
    row(label("feature.text.size", "length"), height, depthLabel, depth);

    // Placement. Seeded from where the click landed, so these open showing the
    // spot the user already chose rather than 0/0 — a field that disagrees with
    // what is on screen is worse than no field.
    const offU = num(init.u ?? 0, "0.5");
    const offV = num(init.v ?? 0, "0.5");
    row(label("feature.text.across", "length"), offU, label("feature.text.up", "length"), offV);

    const op = document.createElement("select");
    op.style.flex = "1";
    for (const [v, key] of [
      ["emboss", "feature.text.emboss"],
      ["engrave", "feature.text.engrave"],
      ["flat", "feature.text.flat"],
    ] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t(key);
      op.appendChild(o);
    }
    op.value = init.operation ?? "emboss";
    row(label("feature.text.style"), op);

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
      o.value = a; o.textContent = t(`feature.text.align.${a}`);
      align.appendChild(o);
    }
    align.value = init.align ?? "left";
    row(label("feature.text.boldItalic"), bold, italic, align);

    const angle = num(init.angle ?? 0, "5", undefined, "angle");
    const boxWidth = num(init.boxWidth ?? 0, "1", "0");
    setTitle(boxWidth, "feature.text.wrapTitle");
    row(label("feature.text.angle"), angle, label("feature.text.wrap", "length"), boxWidth);

    const bevel = num(init.bevel ?? 0, "0.05", "0");
    setTitle(bevel, "feature.text.bevelTitle");
    const bevelStyle = document.createElement("select");
    Object.assign(bevelStyle.style, { flex: "1 1 0", minWidth: "0" });
    for (const v of ["auto", "chamfer", "fillet", "taper"] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t(`feature.text.bevelStyle.${v}`);
      bevelStyle.appendChild(o);
    }
    bevelStyle.value = init.bevelStyle ?? "auto";
    setTitle(bevelStyle, "feature.text.bevelStyleTitle");
    const bevelRow = row(label("feature.text.bevel", "length"), bevel, bevelStyle);

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
    const slotRow = row(label("feature.text.color"));
    slotRow.appendChild(chip("transparent", t("feature.text.inheritColor"), null));
    chips[0]!.textContent = "—";
    Object.assign(chips[0]!.style, { color: "var(--text)", fontSize: "11px", lineHeight: "18px" });
    (opts.palette ?? []).forEach((sl, i) => {
      slotRow.appendChild(chip(sl.color, t("common.paletteSlot", { name: sl.name, n: i + 1 }), i));
    });
    paintChips();
    const syncBevel = () => {
      bevelStyle.style.visibility = (parseFieldExpr(bevel.value, "length", fieldParams()) ?? 0) > 0 ? "visible" : "hidden";
    };
    bevel.addEventListener("input", syncBevel);
    syncBevel();

    // Flat text is imprinted flush with the face, so depth and bevel do nothing
    // to it — hide them rather than leave live-looking numbers on screen that
    // the sidecar ignores.
    //
    // And PICK IT A FILAMENT. Flat glyphs that inherit the body's colour are
    // invisible: the silhouette is unchanged by design, and there is no
    // "colour this face" action anywhere else in the app, so the only way back
    // is to reopen this panel. Choosing the first slot that isn't the body's
    // own means the letters show up the moment the style is chosen.
    const syncStyle = () => {
      const flat = op.value === "flat";
      for (const el of [depthLabel, depth]) el.style.display = flat ? "none" : "";
      bevelRow.style.display = flat ? "none" : "";
      if (flat && slot === null) {
        slot = autoGlyphSlot((opts.palette ?? []).length, opts.bodySlot ?? null);
        paintChips();
      }
    };
    op.addEventListener("change", syncStyle);
    syncStyle();

    // Unchanged-text guard: if the field's text still reads exactly as it was
    // shown, return the mm value it was shown FROM rather than re-parsing the
    // rounded display text (see the shownLen comment above).
    const typedLenField = (el: HTMLInputElement, dflt: number): number => {
      const shown = shownLen.get(el);
      if (shown && el.value === shown.text) return shown.value;
      return typedLen(el, dflt);
    };

    this.read = () => {
      const s =
        bold.checked && italic.checked ? "bolditalic" : bold.checked ? "bold" : italic.checked ? "italic" : "regular";
      const v: TextOnFaceValues = {
        text: text.value,
        // typedLen/typedNumber, not Number(): Number("12,5") is NaN, so a
        // comma-decimal size silently became the 0 below. An EMPTY field still
        // means "use the default"; text the parser refuses shows the default
        // in the live preview and is refused at commit(), never modelled.
        // The lengths read through the document unit and accept a fraction or
        // expression (X-doug-text-inches); angle stays raw degrees. An
        // untouched field reads back its original mm value (typedLenField),
        // not a re-parse of its rounded display text.
        height: typedLenField(height, 0),
        style: s,
        align: align.value as TextOnFaceValues["align"],
        angle: typedNumber(angle, 0),
        depth: typedLenField(depth, 0),
        operation: op.value as TextOnFaceValues["operation"],
        bevel: typedLenField(bevel, 0),
        bevelStyle: bevelStyle.value as TextOnFaceValues["bevelStyle"],
        u: typedLenField(offU, 0),
        v: typedLenField(offV, 0),
        colorSlot: slot,
      };
      if (font.value) v.font = font.value;
      const box = parseFieldExpr(boxWidth.value, "length", fieldParams());
      if (box !== null && box > 0) v.boxWidth = box;
      return v;
    };

    // Every field commit() has to be able to read. Depth and bevel are in here
    // even while a FLAT text hides them: which fields a style ignores is the
    // tool's business, and one rule for all of them beats a panel that refuses
    // one unreadable number and quietly defaults another.
    this.numFields = [height, depth, angle, boxWidth, bevel, offU, offV];
    this.heightField = height;
    this.angleField = angle;

    this.setUV = (u, v) => {
      offU.value = fieldText(u, "length");
      shownLen.set(offU, { value: u, text: offU.value });
      offV.value = fieldText(v, "length");
      shownLen.set(offV, { value: v, text: offV.value });
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
      // ...but not while an IME is composing: there Enter CONFIRMS the
      // candidate, and committing the panel out from under it loses the text
      // being typed (ui/focus owns the two-signal test).
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !isImeComposing(e)) {
        e.preventDefault();
        this.commit();
      }
    });

    const btn = (caption: string, variant: "confirm" | "cancel", iconName: IconName) => {
      const b = document.createElement("button");
      b.className = `panel-btn panel-btn-${variant}`;
      b.innerHTML = `${icon(iconName)}<span></span>`;
      b.querySelector("span")!.textContent = caption;
      b.style.flex = "1";
      return b;
    };
    const ok = btn(t(opts.editing ? "common.apply" : "common.add"), "confirm", "check");
    const no = btn(t("common.cancel"), "cancel", "close");
    // pointerdown + preventDefault so the button never blurs the field being
    // typed into, and never reaches the canvas underneath
    ok.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.commit(); });
    no.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.onCancel?.(); });
    row(ok, no);
    // A text whose face is gone (an edit upstream renumbered the bodies, report
    // 048ec84f) could only be deleted and typed again. This keeps every setting
    // and asks for the face only.
    if (opts.editing && this.onRepick) {
      const again = btn(t("feature.text.repickFace"), "cancel", "select");
      again.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.onRepick?.(); });
      row(again);
    }

    text.focus();
    text.select();
  }

  /** Deliberately does NOT hide: the tool may refuse an empty commit, and the
   *  panel has to stay up so the user can fix it. */
  private commit() {
    if (!this.read) return;
    // A field the app cannot read must not commit as its default: a size typed
    // "3.14.15" used to commit as 0. Same refusal press/pull and the sketch
    // dimension fields give, and the panel stays up so it can be fixed.
    // `height` is passed as must-be-positive for the same reason the sketch text
    // panel does: 0 or less segfaults the geometry engine through the preview.
    // Every field but `angle` is a length, parsed in the document unit and
    // accepting a fraction (X-doug-text-inches).
    if (this.numFields.some((el) =>
      el === this.angleField ? badNumberField(el) : badLenField(el, el === this.heightField),
    )) {
      setPrompt(t("feature.badNumber"));
      return;
    }
    this.onCommit?.(this.read());
  }

  hide() {
    this.root?.remove();
    this.root = null;
    this.read = null;
    this.numFields = [];
    this.onCommit = this.onChange = null;
    this.onCancel = null;
    this.onRepick = null;
  }
}
