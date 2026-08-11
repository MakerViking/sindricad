// Selection-filter chips for the sketch Project tool: a small floating bar shown
// while the tool is active (TextPanel's floating-DOM style — there is no shared
// FloatingPanel widget, and the Sketch Palette is a persistent checkbox list,
// the wrong shape for a mutually-exclusive mode set).

export type ProjectFilter = "edges" | "sketchCurves" | "silhouette";

const CHIPS: { key: ProjectFilter; label: string }[] = [
  { key: "edges", label: "Edges & faces" },
  { key: "sketchCurves", label: "Sketch curves" },
  { key: "silhouette", label: "Body silhouette" },
];

export class ProjectPanel {
  private root: HTMLDivElement;
  private buttons = new Map<ProjectFilter, HTMLButtonElement>();
  filter: ProjectFilter = "edges";
  onChange: ((f: ProjectFilter) => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "tool-panel";
    Object.assign(this.root.style, {
      zIndex: "40", display: "none", gap: "6px", padding: "6px 8px",
    } as CSSStyleDeclaration);
    for (const c of CHIPS) {
      const b = document.createElement("button");
      b.textContent = c.label;
      b.className = "tool-chip tool-chip-pill";
      b.addEventListener("click", () => {
        this.filter = c.key;
        this.paint();
        this.onChange?.(c.key);
      });
      this.buttons.set(c.key, b);
      this.root.appendChild(b);
    }
    this.paint();
    document.body.appendChild(this.root);
  }

  private paint() {
    for (const [key, b] of this.buttons) {
      b.classList.toggle("on", key === this.filter);
    }
  }

  /** show the bar centered near the top of `anchor` (the viewport canvas) */
  show(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    this.root.style.display = "flex";
    this.root.style.top = `${r.top + 10}px`;
    // centered: measure after display so offsetWidth is real
    this.root.style.left = `${r.left + r.width / 2 - this.root.offsetWidth / 2}px`;
  }

  hide() {
    this.root.style.display = "none";
  }
}
