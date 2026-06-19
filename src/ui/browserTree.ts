// Left browser, Fusion-style: object-oriented, collapsible folders rather than
// a flat feature list. Origin (the three base planes — click to start a sketch
// on one), Sketches (all sketch features grouped together), and Bodies (shown
// when the document produces a solid). The chronological operations
// (extrude/fillet/...) live in the bottom Timeline, as in Fusion.

import type { DocumentStore } from "../document/store";
import type { Plane3 } from "../types";

export class BrowserTree {
  private el: HTMLElement;
  private selectedId: string | null = null;
  private collapsed = new Set<string>(); // folder names that are collapsed
  private lastSig = ""; // skip redundant rebuilds (doc + build both fire)

  onSelect: ((id: string) => void) | null = null;
  onEditSketch: ((id: string) => void) | null = null;
  onSketchOnPlane: ((plane: Plane3) => void) | null = null;
  onToggleSketch: ((id: string) => void) | null = null;
  isSketchVisible: ((id: string) => boolean) | null = null;

  constructor(container: HTMLElement, private store: DocumentStore) {
    this.el = container;
    store.onDocChange(() => this.render());
    store.onBuild(() => this.render());
  }

  select(id: string | null) {
    this.selectedId = id;
    this.render();
  }

  /** force a re-render (e.g. after a visibility toggle). */
  refresh() {
    this.lastSig = "";
    this.render();
  }

  private toggle(folder: string) {
    if (this.collapsed.has(folder)) this.collapsed.delete(folder);
    else this.collapsed.add(folder);
    this.render();
  }

  private render() {
    const doc = this.store.document;
    const errId = this.store.buildState.errorFeatureId;
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;

    // the tree only depends on these — onDocChange + onBuild both fire per edit,
    // so bail when nothing visible changed instead of rebuilding the DOM twice.
    const sketchIds = doc.features.filter((f) => f.type === "sketch").map((f) => f.id);
    const vis = sketchIds.map((id) => (this.isSketchVisible?.(id) ?? true) ? "1" : "0").join("");
    const sig = `${sketchIds.join(",")}|${vis}|${hasSolid}|${errId}|${this.selectedId}|${[...this.collapsed].join(",")}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    this.el.innerHTML = `<div class="panel-title">Browser</div>`;

    // --- Origin ---
    this.folder("Origin", "⌖", [
      ...(["XY", "XZ", "YZ"] as Plane3[]).map((p) => ({
        label: `${p} plane`,
        icon: "▱",
        dim: true,
        onClick: () => this.onSketchOnPlane?.(p),
        title: `Start a sketch on the ${p} plane`,
      })),
    ]);

    // --- Bodies ---
    this.folder("Bodies", "◆", hasSolid ? [{ label: "Body1", icon: "◆" }] : []);

    // --- Sketches ---
    const sketches = doc.features.filter((f) => f.type === "sketch");
    this.folder(
      "Sketches",
      "✎",
      sketches.map((f, i) => ({
        label: `Sketch${i + 1}`,
        icon: "✎",
        selected: this.selectedId === f.id,
        error: errId === f.id,
        visible: this.isSketchVisible?.(f.id) ?? true,
        onClick: () => this.onSelect?.(f.id),
        onDouble: () => this.onEditSketch?.(f.id),
        onToggleVis: this.onToggleSketch ? () => this.onToggleSketch!(f.id) : undefined,
        title: "Double-click to edit · click the eye to show/hide",
      })),
    );
  }

  private folder(
    name: string,
    icon: string,
    items: {
      label: string;
      icon: string;
      dim?: boolean;
      selected?: boolean;
      error?: boolean;
      visible?: boolean;
      title?: string;
      onClick?: () => void;
      onDouble?: () => void;
      onToggleVis?: () => void;
    }[],
  ) {
    const collapsed = this.collapsed.has(name);
    const head = document.createElement("div");
    head.className = "tree-folder";
    head.innerHTML = `<span class="tree-caret">${collapsed ? "▸" : "▾"}</span><span class="feature-icon">${icon}</span><span>${name}</span><span style="flex:1"></span><span class="tree-count">${items.length || ""}</span>`;
    head.addEventListener("click", () => this.toggle(name));
    this.el.appendChild(head);

    if (collapsed) return;
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state tree-child";
      empty.textContent = name === "Bodies" ? "No bodies yet" : `No ${name.toLowerCase()} yet`;
      this.el.appendChild(empty);
      return;
    }
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "feature-row tree-child";
      if (it.selected) row.classList.add("selected");
      if (it.error) row.classList.add("error");
      if (it.dim) row.style.opacity = "0.7";
      if (it.title) row.title = it.title;
      const hidden = it.onToggleVis && it.visible === false;
      row.innerHTML =
        `<span class="feature-icon">${it.icon}</span>` +
        `<span class="tree-label"${hidden ? ' style="opacity:.45"' : ""}>${it.label}</span>` +
        `<span style="flex:1"></span>` +
        (it.onToggleVis ? `<span class="tree-eye" title="Show/hide">${it.visible === false ? "○" : "◉"}</span>` : "");
      if (it.onClick) row.addEventListener("click", it.onClick);
      if (it.onDouble) row.addEventListener("dblclick", it.onDouble);
      if (it.onToggleVis) {
        const eye = row.querySelector(".tree-eye")!;
        eye.addEventListener("click", (e) => {
          e.stopPropagation(); // don't select/edit the sketch
          it.onToggleVis!();
        });
      }
      this.el.appendChild(row);
    }
  }
}
