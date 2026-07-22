// Floating HTML panel for the printed-Texture tool (knurl/hex/waves/ribs/voronoi/
// noise/image heightmap). Unlike TextPanel (cursor-anchored, one text object) this
// is DOCKED top-right: the tool can span a whole body, not one clicked point, so
// there's no natural anchor to follow. Mirrors TextPanel's row()/inputStyle()/
// emit() conventions otherwise. Every edit fires onChange for a live preview;
// ✓ Add/Apply commits, ✕ cancels. The preview is always approximate (GPU bump for
// procedural kinds, or nothing) — a note says so, permanently, so nobody mistakes
// it for the real geometry.

export type TextureKind = "knurl" | "hex" | "waves" | "ribs" | "voronoi" | "noise" | "image";
export type TextureMode = "faces" | "body";

export interface TextureValues {
  kind: TextureKind;
  depth: number;
  scale: number;
  angle: number;
  offset: number;
  sharpness: number;
  direction: "out" | "in" | "both";
  seed: number;
  invert: boolean;
  imagePath?: string;
  colorSlot?: number; // palette slot for a two-tone inlay; undefined = body color
}

const KIND_OPTIONS: [TextureKind, string][] = [
  ["knurl", "Knurl"],
  ["hex", "Hex"],
  ["waves", "Waves"],
  ["ribs", "Ribs"],
  ["voronoi", "Voronoi"],
  ["noise", "Noise (Perlin)"],
  ["image", "Image Heightmap"],
];
// kinds that show angle/sharpness/direction (a lattice/wave orientation + crispness
// + emboss-deboss-both make sense for all of these; voronoi/noise use a seed
// instead of an orientation, and image has neither). Exported so textureTool.ts
// can trim the feature JSON to the fields that actually apply to the chosen kind.
export const ANGLE_KINDS = new Set<TextureKind>(["knurl", "hex", "waves", "ribs"]);
export const SEED_KINDS = new Set<TextureKind>(["voronoi", "noise"]);

const isTauri = () => "__TAURI_INTERNALS__" in window;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export class TexturePanel {
  private root: HTMLDivElement;
  private active = false;
  private onCommit: ((v: TextureValues) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private onChange: ((v: TextureValues) => void) | null = null;
  private onModeChange: ((mode: TextureMode) => void) | null = null;
  private read: (() => TextureValues) | null = null;
  private summaryEl: HTMLDivElement | null = null;
  private modeBtns: { faces: HTMLButtonElement; body: HTMLButtonElement } | null = null;
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
      position: "fixed", top: "60px", right: "16px", zIndex: "50", display: "none",
      padding: "8px", background: "#20242c", border: "1px solid #3a4150", borderRadius: "6px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.4)", font: "12px system-ui, sans-serif",
      color: "#dce3ee", width: "270px", maxWidth: "calc(100vw - 24px)", boxSizing: "border-box",
      maxHeight: "calc(100vh - 80px)", overflowY: "auto",
      colorScheme: "dark", // native <select>/checkbox/number-spinner render dark
    } as CSSStyleDeclaration);
    document.body.appendChild(this.root);
  }

  get isActive() {
    return this.active;
  }

  show(
    opts: {
      editing: boolean;
      mode: TextureMode;
      summary: string;
      initial: Partial<TextureValues>;
      palette?: { name: string; color: string }[];
    },
    handlers: {
      onCommit: (v: TextureValues) => void;
      onCancel: () => void;
      onChange: (v: TextureValues) => void;
      onModeChange: (mode: TextureMode) => void;
    },
  ) {
    this.hide();
    this.onCommit = handlers.onCommit;
    this.onCancel = handlers.onCancel;
    this.onChange = handlers.onChange;
    this.onModeChange = handlers.onModeChange;
    this.active = true;
    this.root.innerHTML = "";
    this.root.style.display = "block";

    const row = (...kids: HTMLElement[]) => {
      const d = document.createElement("div");
      Object.assign(d.style, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" });
      kids.forEach((k) => d.appendChild(k));
      this.root.appendChild(d);
      return d;
    };
    const inputStyle = (el: HTMLElement) =>
      Object.assign(el.style, { background: "#161a20", color: "#dce3ee", border: "1px solid #3a4150", borderRadius: "3px", padding: "3px 5px", font: "inherit" });

    const title = document.createElement("div");
    title.textContent = "Texture";
    Object.assign(title.style, { fontWeight: "600", marginBottom: "6px" });
    this.root.appendChild(title);

    this.summaryEl = document.createElement("div");
    Object.assign(this.summaryEl.style, { color: "#8b93a3", marginBottom: "6px" });
    this.summaryEl.textContent = opts.summary;
    this.root.appendChild(this.summaryEl);

    // [Faces] / [Whole Body] mode toggle — a segmented pair of buttons.
    const modeBtn = (label: string, m: TextureMode) => {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, { flex: "1", border: "1px solid #3a4150", borderRadius: "3px", padding: "4px 6px", cursor: "pointer", font: "inherit" });
      b.addEventListener("click", () => {
        this.setMode(m);
        this.onModeChange?.(m);
      });
      return b;
    };
    const facesBtn = modeBtn("Faces", "faces");
    const bodyBtn = modeBtn("Whole Body", "body");
    this.modeBtns = { faces: facesBtn, body: bodyBtn };
    row(facesBtn, bodyBtn);
    this.setMode(opts.mode);

    const kind = document.createElement("select");
    inputStyle(kind);
    Object.assign(kind.style, { flex: "1" });
    for (const [v, label] of KIND_OPTIONS) kind.appendChild(new Option(label, v));
    kind.value = opts.initial.kind ?? "knurl";
    row(label("Kind"), kind);

    const depth = numberInput(opts.initial.depth ?? 0.4, "0.01");
    inputStyle(depth);
    const scale = numberInput(opts.initial.scale ?? 2, "0.01");
    inputStyle(scale);
    row(label("Depth"), depth, label("Scale"), scale);

    // --- conditional: angle/sharpness/direction (lattice + wave kinds) ---
    const angle = numberInput(opts.initial.angle ?? 0, "1");
    inputStyle(angle);
    const sharpness = numberInput(opts.initial.sharpness ?? 0.5, "0.05");
    sharpness.min = "0";
    sharpness.max = "1";
    inputStyle(sharpness);
    const angleRow = row(label("Angle°"), angle, label("Sharp"), sharpness);
    const direction = document.createElement("select");
    inputStyle(direction);
    Object.assign(direction.style, { flex: "1" });
    direction.appendChild(new Option("Out (emboss)", "out"));
    direction.appendChild(new Option("In (deboss)", "in"));
    direction.appendChild(new Option("Both", "both"));
    direction.value = opts.initial.direction ?? "out";
    const directionRow = row(label("Direction"), direction);

    // --- conditional: seed + randomize (voronoi/noise) ---
    const seed = numberInput(opts.initial.seed ?? 1, "1");
    inputStyle(seed);
    const randomize = document.createElement("button");
    randomize.textContent = "🎲 Randomize";
    Object.assign(randomize.style, { border: "1px solid #3a4150", borderRadius: "3px", padding: "3px 8px", cursor: "pointer", font: "inherit" });
    randomize.addEventListener("click", () => {
      seed.value = String(Math.floor(Math.random() * 1_000_000));
      emit();
    });
    const seedRow = row(label("Seed"), seed, randomize);

    // --- conditional: image path + invert ---
    const imagePathLabel = document.createElement("span");
    imagePathLabel.textContent = opts.initial.imagePath ? basename(opts.initial.imagePath) : "No file chosen";
    Object.assign(imagePathLabel.style, { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#8b93a3" });
    let imagePath = opts.initial.imagePath;
    const browse = document.createElement("button");
    browse.textContent = "Browse…";
    Object.assign(browse.style, { border: "1px solid #3a4150", borderRadius: "3px", padding: "3px 8px", cursor: "pointer", font: "inherit" });
    browse.addEventListener("click", async () => {
      if (!isTauri()) {
        console.warn("texture image needs the native app (a real filesystem path)");
        return;
      }
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp"] }],
      });
      if (typeof path !== "string") return;
      imagePath = path;
      imagePathLabel.textContent = basename(path);
      emit();
    });
    const imageRow = row(browse, imagePathLabel);
    const invert = checkbox(opts.initial.invert ?? false);
    const invertRow = row(label("Invert", invert), invert);

    const updateVisibility = () => {
      const k = kind.value as TextureKind;
      angleRow.style.display = ANGLE_KINDS.has(k) ? "flex" : "none";
      directionRow.style.display = ANGLE_KINDS.has(k) ? "flex" : "none";
      seedRow.style.display = SEED_KINDS.has(k) ? "flex" : "none";
      imageRow.style.display = k === "image" ? "flex" : "none";
      invertRow.style.display = k === "image" ? "flex" : "none";
    };
    updateVisibility();
    kind.addEventListener("change", () => { updateVisibility(); emit(); });

    // --- Inlay color: which palette slot the textured faces print in (two-tone).
    // Only shown when the caller passed a palette (i.e. in a doc with bodies).
    const colorSlot = document.createElement("select");
    inputStyle(colorSlot);
    Object.assign(colorSlot.style, { flex: "1" });
    colorSlot.appendChild(new Option("Body color", ""));
    (opts.palette ?? []).forEach((s, i) => colorSlot.appendChild(new Option(`${s.name} (slot ${i + 1})`, String(i))));
    colorSlot.value = opts.initial.colorSlot != null ? String(opts.initial.colorSlot) : "";
    const colorRow = row(label("Print color"), colorSlot);
    if (!opts.palette?.length) colorRow.style.display = "none";

    // --- Advanced: offset ---
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Advanced";
    Object.assign(summary.style, { cursor: "pointer", marginBottom: "4px" });
    details.appendChild(summary);
    this.root.appendChild(details);
    const offset = numberInput(opts.initial.offset ?? 0, "0.01");
    inputStyle(offset);
    const offsetRow = document.createElement("div");
    Object.assign(offsetRow.style, { display: "flex", gap: "6px", alignItems: "center" });
    offsetRow.append(label("Offset"), offset);
    details.appendChild(offsetRow);

    const note = document.createElement("div");
    note.textContent = "Preview is real geometry at display resolution — exports keep full detail.";
    Object.assign(note.style, { color: "#8b93a3", fontStyle: "italic", margin: "8px 0" });
    this.root.appendChild(note);

    this.read = (): TextureValues => ({
      kind: kind.value as TextureKind,
      depth: parseFloat(depth.value) || 0.4,
      scale: parseFloat(scale.value) || 2,
      angle: parseFloat(angle.value) || 0,
      offset: parseFloat(offset.value) || 0,
      sharpness: parseFloat(sharpness.value) || 0,
      direction: direction.value as TextureValues["direction"],
      seed: parseFloat(seed.value) || 1,
      invert: invert.checked,
      ...(imagePath ? { imagePath } : {}),
      ...(colorSlot.value !== "" ? { colorSlot: Number(colorSlot.value) } : {}),
    });

    const emit = () => this.onChange?.(this.read!());
    for (const el of [depth, scale, angle, sharpness, direction, seed, invert, offset, colorSlot]) {
      el.addEventListener("input", emit);
      el.addEventListener("change", emit);
    }

    const ok = button(opts.editing ? "✓ Apply" : "✓ Add", "#2b6");
    ok.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.commit(); });
    const no = button("✕ Cancel", "#555");
    no.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.cancel(); });
    const btns = row(ok, no);
    btns.style.marginBottom = "0";
    btns.style.justifyContent = "flex-end";

    document.addEventListener("keydown", this.escHandler, true);
  }

  /** Live selection-summary line (rewritten every rAF tick as the ambient
   *  selection changes) — doesn't rebuild the rest of the panel, so it never
   *  steals focus from whatever field is being typed into. */
  setSummary(text: string) {
    if (this.summaryEl) this.summaryEl.textContent = text;
  }

  /** Reflect which mode is active in the toggle buttons (called both from a
   *  button click and when the tool switches mode some other way). */
  setMode(mode: TextureMode) {
    if (!this.modeBtns) return;
    const on = { background: "#2b6", borderColor: "#2b6", color: "#fff" };
    const off = { background: "transparent", borderColor: "#3a4150", color: "#dce3ee" };
    Object.assign(this.modeBtns.faces.style, mode === "faces" ? on : off);
    Object.assign(this.modeBtns.body.style, mode === "body" ? on : off);
  }

  private commit() {
    if (!this.active || !this.read) return;
    const v = this.read();
    const cb = this.onCommit;
    this.hide();
    cb?.(v);
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
    this.onCommit = this.onCancel = this.onChange = this.onModeChange = this.read = null;
    this.summaryEl = null;
    this.modeBtns = null;
    document.removeEventListener("keydown", this.escHandler, true);
  }
}

function numberInput(value: number, step: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "number";
  el.step = step;
  el.value = String(value);
  Object.assign(el.style, { width: "64px" });
  return el;
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
