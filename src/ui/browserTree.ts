// Left browser, Fusion-style: object-oriented, collapsible folders rather than
// a flat feature list. Origin (the three base planes — click to start a sketch
// on one), Sketches (all sketch features grouped together), and Bodies (shown
// when the document produces a solid). The chronological operations
// (extrude/fillet/...) live in the bottom Timeline, as in Fusion.

import type { DocumentStore } from "../document/store";
import type { Plane3 } from "../types";
import { contextMenu } from "./menu";

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
  onToggleBody: ((id: string) => void) | null = null;
  isBodyVisible: ((id: string) => boolean) | null = null;
  // body multi-selection (for Move): click selects, Ctrl/Cmd-click adds.
  onSelectBody: ((id: string, additive: boolean) => void) | null = null;
  isBodySelected: ((id: string) => boolean) | null = null;
  // right-click a construction plane → cut all bodies by it.
  onCutPlane: ((id: string) => void) | null = null;

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
    const result = this.store.buildState.result;
    const hasSolid = (result?.mesh.positions.length ?? 0) > 0;
    // real per-body list from the rebuild; fall back to a single implicit body
    // when the backend didn't send body metadata but a solid exists.
    const bodies: { id: string; name: string }[] = result?.bodies?.length
      ? result.bodies.map((b) => ({ id: b.id, name: b.name }))
      : hasSolid
        ? [{ id: "body1", name: "Body1" }]
        : [];

    // the tree only depends on these — onDocChange + onBuild both fire per edit,
    // so bail when nothing visible changed instead of rebuilding the DOM twice.
    const sketchIds = doc.features.filter((f) => f.type === "sketch").map((f) => f.id);
    const datumIds = doc.features.filter((f) => f.type === "datumPlane").map((f) => f.id);
    const vis = sketchIds.map((id) => (this.isSketchVisible?.(id) ?? true) ? "1" : "0").join("");
    const bvis = bodies.map((b) => `${b.name}${(this.isBodyVisible?.(b.id) ?? true) ? "" : ":h"}`).join(",");
    const bsel = bodies.map((b) => (this.isBodySelected?.(b.id) ? "1" : "0")).join("");
    const sig = `${sketchIds.join(",")}|${datumIds.join(",")}|${vis}|${bvis}|${bsel}|${errId}|${this.selectedId}|${[...this.collapsed].join(",")}`;
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

    // --- Construction / datum planes (only when present) ---
    const datums = doc.features.filter((f) => f.type === "datumPlane");
    if (datums.length) {
      this.folder(
        "Planes",
        "▱",
        datums.map((f, i) => ({
          label: (f as { name?: string }).name || `Plane${i + 1}`,
          icon: "▱",
          selected: this.selectedId === f.id,
          error: errId === f.id,
          onClick: () => this.onSelect?.(f.id),
          onContext: (e: MouseEvent) =>
            contextMenu(e.clientX, e.clientY, [
              { label: "Cut all bodies", onClick: () => this.onCutPlane?.(f.id) },
            ]),
          title: "Construction plane — select it, then Split Body cuts by it · right-click to Cut",
        })),
      );
    }

    // --- Bodies ---
    this.folder(
      "Bodies",
      "◆",
      bodies.map((b) => ({
        label: b.name,
        icon: "◆",
        selected: this.isBodySelected?.(b.id) ?? false,
        visible: this.isBodyVisible?.(b.id) ?? true,
        onClick: (e) => this.onSelectBody?.(b.id, e.ctrlKey || e.metaKey),
        onToggleVis: this.onToggleBody ? () => this.onToggleBody!(b.id) : undefined,
        title: "Click to select (Ctrl+click adds) · click the eye to show/hide",
      })),
    );

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
      onClick?: (e: MouseEvent) => void;
      onDouble?: () => void;
      onToggleVis?: () => void;
      onContext?: (e: MouseEvent) => void;
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
      if (it.onClick) row.addEventListener("click", (e) => it.onClick!(e));
      if (it.onDouble) row.addEventListener("dblclick", it.onDouble);
      if (it.onContext)
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          it.onContext!(e);
        });
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
