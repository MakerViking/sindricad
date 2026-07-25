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
    Object.assign(this.root.style, {
      position: "fixed", zIndex: "40", display: "none", gap: "6px", padding: "6px 8px",
      background: "#20242c", border: "1px solid #3a4150", borderRadius: "6px",
      boxShadow: "0 4px 14px rgba(0,0,0,0.35)", font: "12px system-ui, sans-serif",
    } as CSSStyleDeclaration);
    for (const c of CHIPS) {
      const b = document.createElement("button");
      b.textContent = c.label;
      Object.assign(b.style, {
        border: "1px solid #3a4150", borderRadius: "12px", padding: "3px 10px",
        font: "inherit", cursor: "pointer",
      } as CSSStyleDeclaration);
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
      const on = key === this.filter;
      b.style.background = on ? "#2f6fd0" : "#161a20";
      b.style.color = on ? "#ffffff" : "#aab4c4";
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
