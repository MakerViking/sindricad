// Floating HTML panel for the printed-Texture tool (knurl/hex/waves/ribs/voronoi/
// noise/image heightmap). Unlike TextPanel (cursor-anchored, one text object) this
// is DOCKED top-right: the tool can span a whole body, not one clicked point, so
// there's no natural anchor to follow. Mirrors TextPanel's row()/emit()
// conventions otherwise; shared chrome comes from the `.tool-panel` CSS class.
// Every edit fires onChange for a live preview;
// Add/Apply commits, Cancel dismisses. The preview is always approximate (GPU bump for
// procedural kinds, or nothing) — a note says so, permanently, so nobody mistakes
// it for the real geometry.

import { icon, type IconName } from "../ui/icons";

export type TextureKind = "knurl" | "hex" | "waves" | "ribs" | "voronoi" | "noise" | "image";
export type TextureMode = "faces" | "body";

export interface TextureValues {
  kind: TextureKind;
  depth: number;
  scale: number;
  angle: number;
  offset: number;
  sharpness: number;
  profile: "facet" | "round";
  boundaryInset: number;
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
  // Esc is NOT handled here. TextureTool owns it for its whole active lifetime,
  // which starts before this panel exists (the edit path rolls the model back
  // first) and must outlast a refused commit. A panel-scoped handler left those
  // windows with no way out.

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "tool-panel";
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

    const title = document.createElement("div");
    title.className = "tool-panel-title";
    title.textContent = "Texture";
    this.root.appendChild(title);

    this.summaryEl = document.createElement("div");
    this.summaryEl.className = "tool-panel-hint";
    this.summaryEl.style.marginBottom = "6px";
    this.summaryEl.textContent = opts.summary;
    this.root.appendChild(this.summaryEl);

    // [Faces] / [Whole Body] mode toggle — a segmented pair of buttons.
    const modeBtn = (label: string, m: TextureMode) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = "tool-chip";
      b.style.flex = "1";
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
    Object.assign(kind.style, { flex: "1" });
    for (const [v, label] of KIND_OPTIONS) kind.appendChild(new Option(label, v));
    kind.value = opts.initial.kind ?? "knurl";
    row(label("Kind"), kind);

    // Hard surface is the default: planar facets and real creases are what a
    // printer can actually reproduce. "Smooth" restores the original fields.
    const profile = document.createElement("select");
    Object.assign(profile.style, { flex: "1" });
    profile.appendChild(new Option("Faceted (hard surface)", "facet"));
    profile.appendChild(new Option("Smooth", "round"));
    profile.value = opts.initial.profile ?? "facet";
    row(label("Profile"), profile);

    const depth = numberInput(opts.initial.depth ?? 0.4, "0.01");
    const scale = numberInput(opts.initial.scale ?? 2, "0.01");
    row(label("Depth"), depth, label("Scale"), scale);

    // --- conditional: angle/sharpness/direction (lattice + wave kinds) ---
    const angle = numberInput(opts.initial.angle ?? 0, "1");
    const sharpness = numberInput(opts.initial.sharpness ?? 0.5, "0.05");
    sharpness.min = "0";
    sharpness.max = "1";
    // the same slider means different things per profile, so it says which —
    // and for one combination it means nothing at all, so it goes away rather
    // than sitting there dead: a FACETED wave is a fixed 8-join sine polyline
    // with no shape parameter (sidecar `_wave_levels` explains why). Under
    // `round` waves is a real sine and `sharpness` still crisps it.
    const sharpLabel = label("Sharp");
    const syncSharpLabel = () => {
      const facet = profile.value === "facet";
      const dead = facet && (kind.value as TextureKind) === "waves";
      sharpLabel.style.display = dead ? "none" : "";
      sharpness.style.display = dead ? "none" : "";
      sharpLabel.textContent = facet ? "Land" : "Sharp";
      sharpLabel.title = facet
        ? "Flat land on the crests: 0 = pure V-groove peaks, 1 = wide flat tops"
        : "Crispness of the smooth profile";
    };
    syncSharpLabel();
    profile.addEventListener("change", syncSharpLabel);
    const angleRow = row(label("Angle°"), angle, sharpLabel, sharpness);
    const direction = document.createElement("select");
    Object.assign(direction.style, { flex: "1" });
    direction.appendChild(new Option("Out (emboss)", "out"));
    direction.appendChild(new Option("In (deboss)", "in"));
    direction.appendChild(new Option("Both", "both"));
    direction.value = opts.initial.direction ?? "out";
    row(label("Direction"), direction);

    // --- conditional: seed + randomize (voronoi/noise) ---
    const seed = numberInput(opts.initial.seed ?? 1, "1");
    const randomize = document.createElement("button");
    randomize.className = "panel-btn panel-btn-ghost";
    randomize.innerHTML = `${icon("randomize")}<span>Randomize</span>`;
    randomize.addEventListener("click", () => {
      seed.value = String(Math.floor(Math.random() * 1_000_000));
      emit();
    });
    const seedRow = row(label("Seed"), seed, randomize);

    // --- conditional: image path + invert ---
    const imagePathLabel = document.createElement("span");
    imagePathLabel.textContent = opts.initial.imagePath ? basename(opts.initial.imagePath) : "No file chosen";
    imagePathLabel.className = "tool-panel-hint";
    Object.assign(imagePathLabel.style, { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    let imagePath = opts.initial.imagePath;
    const browse = document.createElement("button");
    browse.textContent = "Browse…";
    browse.className = "tool-chip";
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
      syncSharpLabel();  // whether the slider means anything is kind-dependent too
      // Direction is NOT an angle-kind thing: the sidecar applies it to the
      // height field itself (out = h, in = h-1, both = centred), so every kind
      // honours it. Gating it behind ANGLE_KINDS left noise/voronoi/image able
      // only to GROW the part — changing its dimensions instead of texturing
      // the surface it sits on.
      seedRow.style.display = SEED_KINDS.has(k) ? "flex" : "none";
      imageRow.style.display = k === "image" ? "flex" : "none";
      invertRow.style.display = k === "image" ? "flex" : "none";
    };
    updateVisibility();
    kind.addEventListener("change", () => { updateVisibility(); emit(); });

    // --- Inlay color: which palette slot the textured faces print in (two-tone).
    // Only shown when the caller passed a palette (i.e. in a doc with bodies).
    const colorSlot = document.createElement("select");
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
    const offsetRow = document.createElement("div");
    Object.assign(offsetRow.style, { display: "flex", gap: "6px", alignItems: "center" });
    const edgeBlend = numberInput(opts.initial.boundaryInset ?? 0, "0.05");
    edgeBlend.min = "0";
    offsetRow.append(label("Offset"), offset, label("Edge blend"), edgeBlend);
    offsetRow.title =
      "Edge blend: mm the pattern fades over at a face boundary. 0 = a clean machined cut-off.";
    details.appendChild(offsetRow);

    const note = document.createElement("div");
    note.textContent = "Preview is real geometry at display resolution — exports keep full detail.";
    note.className = "tool-panel-note";
    this.root.appendChild(note);

    this.read = (): TextureValues => ({
      kind: kind.value as TextureKind,
      depth: parseFloat(depth.value) || 0.4,
      scale: parseFloat(scale.value) || 2,
      angle: parseFloat(angle.value) || 0,
      offset: parseFloat(offset.value) || 0,
      sharpness: parseFloat(sharpness.value) || 0,
      profile: profile.value as TextureValues["profile"],
      boundaryInset: Math.max(0, parseFloat(edgeBlend.value) || 0),
      direction: direction.value as TextureValues["direction"],
      seed: parseFloat(seed.value) || 1,
      invert: invert.checked,
      ...(imagePath ? { imagePath } : {}),
      ...(colorSlot.value !== "" ? { colorSlot: Number(colorSlot.value) } : {}),
    });

    const emit = () => this.onChange?.(this.read!());
    for (const el of [depth, scale, angle, sharpness, profile, direction, seed, invert, offset, edgeBlend, colorSlot]) {
      el.addEventListener("input", emit);
      el.addEventListener("change", emit);
    }

    const ok = button(opts.editing ? "Apply" : "Add", "confirm", "check");
    ok.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.commit(); });
    const no = button("Cancel", "cancel", "close");
    no.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.cancel(); });
    const btns = row(ok, no);
    btns.style.marginBottom = "0";
    btns.style.justifyContent = "flex-end";
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
    // `.tool-chip.on` carries the selected look.
    this.modeBtns.faces.classList.toggle("on", mode === "faces");
    this.modeBtns.body.classList.toggle("on", mode === "body");
  }

  private commit() {
    if (!this.active || !this.read) return;
    // Do NOT hide here. The tool REFUSES a commit with no target (nothing
    // selected) and leaves itself active — hiding first stranded the user in an
    // invisible modal: the panel was gone, the tool still owned face-picking,
    // and toolBusy() blocked every other Esc handler. The tool's own cleanup()
    // hides the panel once the commit is actually accepted.
    this.onCommit?.(this.read());
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
