// Bottom timeline (Fusion-style): a horizontal strip of feature nodes in build
// order, plus a draggable rollback marker. Click to select, double-click to
// edit, right-click for Edit / Suppress / Roll-to-here / Delete, and drag a node
// to reorder. Features past the rollback marker are dimmed (not built); the one
// named by a failed rebuild is flagged red.

import type { DocumentStore } from "../document/store";
import { FEATURE_META } from "./featureMeta";

export class Timeline {
  private el: HTMLElement;
  onSelect: ((id: string) => void) | null = null;
  onEdit: ((id: string) => void) | null = null;
  private selectedId: string | null = null;
  private dragId: string | null = null; // node being reordered
  private menu: HTMLElement | null = null;

  constructor(container: HTMLElement, private store: DocumentStore) {
    this.el = container;
    store.onDocChange(() => this.render());
    store.onBuild(() => this.render());
    document.addEventListener("pointerdown", (e) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
    });
  }

  select(id: string | null) {
    this.selectedId = id;
    this.render();
  }

  private render() {
    const { features } = this.store.document;
    const build = this.store.buildState;
    const rollback = this.store.rollbackIndex;
    this.el.innerHTML = "";

    const track = document.createElement("div");
    track.className = "timeline-track";

    features.forEach((f, i) => {
      if (i === rollback) track.appendChild(this.marker());
      track.appendChild(this.node(f, i, i >= rollback));
    });
    if (rollback >= features.length) track.appendChild(this.marker());

    if (build.building) {
      const dot = document.createElement("div");
      dot.className = "timeline-node building";
      dot.innerHTML = `<span class="glyph">…</span><span class="t-label">building</span>`;
      track.appendChild(dot);
    }
    this.el.appendChild(track);
  }

  private node(f: { id: string; type: string }, i: number, rolledBack: boolean): HTMLElement {
    const meta = FEATURE_META[f.type as keyof typeof FEATURE_META];
    const build = this.store.buildState;
    const suppressed = this.store.isSuppressed(f.id);
    const node = document.createElement("div");
    node.className = "timeline-node";
    node.dataset.id = f.id;
    if (this.selectedId === f.id) node.classList.add("selected");
    if (build.errorFeatureId === f.id) node.classList.add("error");
    if (rolledBack) node.classList.add("rolled");
    if (suppressed) node.classList.add("suppressed");
    node.title =
      build.errorFeatureId === f.id && build.errorMessage
        ? build.errorMessage
        : `${meta.label} — double-click to edit, right-click for more`;
    node.innerHTML =
      `<span class="t-num">${i + 1}</span>` +
      `<span class="glyph">${meta.glyph}</span>` +
      `<span class="t-label">${meta.label}</span>`;

    node.addEventListener("click", () => this.onSelect?.(f.id));
    node.addEventListener("dblclick", () => this.onEdit?.(f.id));
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openMenu(e, f.id, i, suppressed);
    });

    // reorder via native drag-and-drop
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      this.dragId = f.id;
      e.dataTransfer!.effectAllowed = "move";
    });
    node.addEventListener("dragover", (e) => {
      if (this.dragId && this.dragId !== f.id) { e.preventDefault(); node.classList.add("drop-target"); }
    });
    node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
    node.addEventListener("drop", (e) => {
      e.preventDefault();
      node.classList.remove("drop-target");
      if (this.dragId && this.dragId !== f.id) this.store.moveFeature(this.dragId, i);
      this.dragId = null;
    });
    return node;
  }

  // --- rollback marker (drag to roll the model back/forward) ---
  private marker(): HTMLElement {
    const m = document.createElement("div");
    m.className = "timeline-marker";
    m.title = "Drag to roll the model back / forward";
    m.innerHTML = `<span class="marker-grip"></span>`;
    m.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      m.classList.add("dragging");
      const move = (ev: PointerEvent) => m.style.setProperty("--x", `${ev.clientX}px`);
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.store.setRollback(this.gapIndexAt(ev.clientX));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    return m;
  }

  /** which inter-feature gap (0..n) the x coordinate falls into. */
  private gapIndexAt(clientX: number): number {
    const nodes = [...this.el.querySelectorAll<HTMLElement>(".timeline-node:not(.building)")];
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return nodes.length;
  }

  // --- right-click context menu ---
  private openMenu(e: MouseEvent, id: string, i: number, suppressed: boolean) {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    const item = (label: string, fn: () => void) => {
      const it = document.createElement("div");
      it.className = "ctx-item";
      it.textContent = label;
      it.addEventListener("click", () => { this.closeMenu(); fn(); });
      menu.appendChild(it);
    };
    const sep = () => menu.appendChild(Object.assign(document.createElement("div"), { className: "ctx-sep" }));
    item("Edit", () => this.onEdit?.(id));
    item(suppressed ? "Unsuppress" : "Suppress", () => this.store.toggleSuppress(id));
    item("Roll to here", () => this.store.setRollback(i));
    item("Roll past here", () => this.store.setRollback(i + 1));
    sep();
    item("Delete", () => this.store.removeFeature(id));
    document.body.appendChild(menu);
    // keep it on-screen
    const r = menu.getBoundingClientRect();
    if (r.bottom > innerHeight) menu.style.top = `${e.clientY - r.height}px`;
    if (r.right > innerWidth) menu.style.left = `${e.clientX - r.width}px`;
    this.menu = menu;
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }
}
