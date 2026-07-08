// The Sketch Palette (mainstream MCAD's right-docked panel shown while sketching).
// Toggles control drawing/display options; "Look At" re-squares the camera.

export type PaletteToggle = "lockView" | "construction" | "grid" | "snap" | "profile" | "dimensions";

interface ToggleDef {
  key: PaletteToggle;
  label: string;
  default: boolean;
}
const TOGGLES: ToggleDef[] = [
  { key: "lockView", label: "Lock to Plane", default: true },
  { key: "construction", label: "Construction", default: false },
  { key: "grid", label: "Sketch Grid", default: true },
  { key: "snap", label: "Snap", default: true },
  { key: "profile", label: "Show Profile", default: true },
  { key: "dimensions", label: "Show Dimensions", default: true },
];

export class SketchPalette {
  private el: HTMLElement;
  private state: Record<PaletteToggle, boolean>;
  onToggle: ((key: PaletteToggle, value: boolean) => void) | null = null;
  onLookAt: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.el = container;
    this.state = Object.fromEntries(
      TOGGLES.map((t) => [t.key, t.default]),
    ) as Record<PaletteToggle, boolean>;
    this.render();
  }

  setVisible(on: boolean) {
    this.el.classList.toggle("hidden", !on);
  }

  get(key: PaletteToggle): boolean {
    return this.state[key];
  }

  /** push every toggle's current value to listeners (call on sketch enter) */
  emitAll() {
    for (const t of TOGGLES) this.onToggle?.(t.key, this.state[t.key]);
  }

  private render() {
    this.el.innerHTML = `<div class="palette-title">SKETCH PALETTE</div><div class="palette-section">Options</div>`;

    const lookAt = document.createElement("button");
    lookAt.className = "palette-btn";
    lookAt.textContent = "Look At";
    lookAt.title = "Square the view to the sketch plane";
    lookAt.addEventListener("click", () => this.onLookAt?.());
    this.el.appendChild(lookAt);

    for (const t of TOGGLES) {
      const row = document.createElement("label");
      row.className = "palette-row";
      const span = document.createElement("span");
      span.textContent = t.label;
      const sw = document.createElement("input");
      sw.type = "checkbox";
      sw.className = "palette-switch";
      sw.checked = this.state[t.key];
      sw.addEventListener("change", () => {
        this.state[t.key] = sw.checked;
        this.onToggle?.(t.key, sw.checked);
      });
      row.append(span, sw);
      this.el.appendChild(row);
    }
  }
}
