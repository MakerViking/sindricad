// Bottom timeline (MCAD-style): a compact strip of icon chips in build order,
// plus a draggable rollback marker, transport buttons (roll to start / step /
// roll to end) and an error badge that jumps to failing features. Number, name
// and error text live in the tooltip — chips stay ~28px so a 100+-feature
// document spans screens, not screen-miles. The scroller is a persistent
// element: re-renders rebuild only the track, so scroll position survives, the
// wheel scrolls horizontally, and dragging a chip near an edge auto-scrolls.

import type { DocumentStore } from "../document/store";
import { FEATURE_META } from "./featureMeta";
import { contextMenu } from "./menu";
import { esc } from "./escape";

export class Timeline {
  private el: HTMLElement;
  private scroller: HTMLElement;
  private track: HTMLElement;
  private transport: HTMLElement;
  private errBadge: HTMLElement;
  onSelect: ((id: string) => void) | null = null;
  onEdit: ((id: string) => void) | null = null;
  private selectedId: string | null = null;
  private dragId: string | null = null; // node being reordered
  private lastCount = -1; // feature count at last render (append → follow)
  private errCycle = 0; // which error the badge jumps to next

  constructor(container: HTMLElement, private store: DocumentStore) {
    this.el = container;
    this.el.classList.add("timeline-shell");

    this.transport = document.createElement("div");
    this.transport.className = "timeline-transport";
    this.el.appendChild(this.transport);

    this.scroller = document.createElement("div");
    this.scroller.className = "timeline-scroll";
    this.track = document.createElement("div");
    this.track.className = "timeline-track";
    this.scroller.appendChild(this.track);
    this.el.appendChild(this.scroller);

    this.errBadge = document.createElement("button");
    this.errBadge.className = "timeline-errbadge hidden";
    this.errBadge.title = "Failing features — click to jump to the next one";
    this.errBadge.addEventListener("click", () => this.jumpToNextError());
    this.el.appendChild(this.errBadge);

    // the wheel scrubs the strip horizontally (vertical wheels are useless here)
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.scroller.scrollLeft += d;
        e.preventDefault();
      },
      { passive: false },
    );
    // dragging a chip near either edge auto-scrolls (a reorder across a long
    // document is impossible otherwise)
    this.scroller.addEventListener("dragover", (e) => {
      const r = this.scroller.getBoundingClientRect();
      if (e.clientX < r.left + 48) this.scroller.scrollLeft -= 14;
      else if (e.clientX > r.right - 48) this.scroller.scrollLeft += 14;
    });

    store.onDocChange(() => this.render());
    store.onBuild(() => this.render());
  }

  select(id: string | null) {
    this.selectedId = id;
    this.render();
  }

  /** every failing feature this build: id -> message (continue-past-errors can
   *  yield several; fall back to the single legacy error field). */
  private errorMap(): Map<string, string> {
    const b = this.store.buildState;
    const m = new Map<string, string>();
    for (const e of b.result?.featureErrors ?? []) {
      if (e.feature_id) m.set(e.feature_id, e.message);
    }
    if (b.errorFeatureId && !m.has(b.errorFeatureId)) {
      m.set(b.errorFeatureId, b.errorMessage ?? "failed");
    }
    return m;
  }

  private render() {
    const { features } = this.store.document;
    const build = this.store.buildState;
    const rollback = this.store.rollbackIndex;
    const errors = this.errorMap();
    const keepScroll = this.scroller.scrollLeft;

    this.renderTransport(rollback, features.length);
    this.track.innerHTML = "";

    if (features.length === 0 && !build.building) {
      const empty = document.createElement("div");
      empty.className = "timeline-empty";
      empty.textContent = "Your modeling history will appear here. Start with a Sketch.";
      this.track.appendChild(empty);
      this.errBadge.classList.add("hidden");
      this.lastCount = 0;
      return;
    }

    features.forEach((f, i) => {
      if (i === rollback) this.track.appendChild(this.marker());
      this.track.appendChild(this.node(f, i, i >= rollback, errors.get(f.id)));
    });
    if (rollback >= features.length) this.track.appendChild(this.marker());

    if (build.building) this.track.appendChild(this.buildingChip(features.length));

    // error badge: count + jump
    if (errors.size > 0) {
      this.errBadge.textContent = `⚠ ${errors.size}`;
      this.errBadge.classList.remove("hidden");
    } else {
      this.errBadge.classList.add("hidden");
      this.errCycle = 0;
    }

    // scroll: follow appends to the end; otherwise stay exactly where the user was
    if (this.lastCount >= 0 && features.length > this.lastCount) {
      this.scroller.scrollLeft = this.scroller.scrollWidth;
    } else {
      this.scroller.scrollLeft = keepScroll;
    }
    this.lastCount = features.length;
  }

  private renderTransport(rollback: number, count: number) {
    this.transport.innerHTML = "";
    const btn = (glyph: string, title: string, disabled: boolean, go: () => void) => {
      const b = document.createElement("button");
      b.className = "tl-btn";
      b.textContent = glyph;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener("click", go);
      this.transport.appendChild(b);
    };
    btn("⏮", "Roll back to the start", rollback <= 0, () => this.store.setRollback(0));
    btn("◂", "Step one feature back", rollback <= 0, () =>
      this.store.setRollback(Math.max(0, rollback - 1)));
    btn("▸", "Step one feature forward", rollback >= count, () =>
      this.store.setRollback(Math.min(count, rollback + 1)));
    btn("⏭", "Roll forward to the end", rollback >= count, () =>
      this.store.setRollback(count));
  }

  private buildingChip(total: number): HTMLElement {
    const p = this.store.buildState.progress;
    const dot = document.createElement("div");
    dot.className = "timeline-node building";
    const label =
      p === null ? "building…" : p < 0 ? "meshing…" : `building ${Math.min(p + 1, total)}/${total}`;
    const pct = p === null || p < 0 || total === 0 ? 0 : Math.round(((p + 1) / total) * 100);
    dot.innerHTML =
      `<span class="t-build">${esc(label)}</span>` +
      `<span class="t-bar"><i style="width:${pct}%"></i></span>`;
    return dot;
  }

  private node(
    f: { id: string; type: string },
    i: number,
    rolledBack: boolean,
    errMsg: string | undefined,
  ): HTMLElement {
    // Unknown feature types must render, not crash: a document from a newer
    // version (or a migration tool) with a type this build doesn't know would
    // otherwise throw mid-render and make File→Open silently do nothing.
    const meta = FEATURE_META[f.type as keyof typeof FEATURE_META] ?? {
      glyph: "•",
      label: f.type,
    };
    const suppressed = this.store.isSuppressed(f.id);
    const node = document.createElement("div");
    node.className = "timeline-node";
    node.dataset.id = f.id;
    if (this.selectedId === f.id) node.classList.add("selected");
    if (errMsg) node.classList.add("error");
    if (rolledBack) node.classList.add("rolled");
    if (suppressed) node.classList.add("suppressed");
    node.title =
      `${i + 1} · ${meta.label}` +
      (errMsg ? `\n⚠ ${errMsg}` : "") +
      "\ndouble-click to edit · right-click for more";
    node.innerHTML = `<span class="glyph">${esc(meta.glyph)}</span>`;

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

  private jumpToNextError() {
    const ids = [...this.errorMap().keys()];
    if (!ids.length) return;
    const id = ids[this.errCycle % ids.length];
    if (id === undefined) return;
    this.errCycle++;
    const chip = this.track.querySelector<HTMLElement>(`.timeline-node[data-id="${CSS.escape(id)}"]`);
    chip?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    this.onSelect?.(id);
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
    const nodes = [...this.track.querySelectorAll<HTMLElement>(".timeline-node:not(.building)")];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n) continue;
      const r = n.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return nodes.length;
  }

  // --- right-click context menu (shared engine in ui/menu.ts) ---
  private openMenu(e: MouseEvent, id: string, i: number, suppressed: boolean) {
    contextMenu(e.clientX, e.clientY, [
      { label: "Edit", onClick: () => this.onEdit?.(id) },
      { label: suppressed ? "Unsuppress" : "Suppress", onClick: () => this.store.toggleSuppress(id) },
      { label: "Roll to here", onClick: () => this.store.setRollback(i) },
      { label: "Roll past here", onClick: () => this.store.setRollback(i + 1) },
      { separator: true, label: "" },
      { label: "Delete", danger: true, onClick: () => this.store.removeFeature(id) },
    ]);
  }
}
