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
  // rename / delete from the tree (context menu + double-click).
  onRenameSketch: ((id: string, name: string) => void) | null = null;
  onDeleteSketch: ((id: string) => void) | null = null;
  onRenamePlane: ((id: string, name: string) => void) | null = null;
  onDeletePlane: ((id: string) => void) | null = null;
  onRenameBody: ((id: string, name: string) => void) | null = null;
  onDeleteBody: ((id: string) => void) | null = null;

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
    const sketches = doc.features.filter((f) => f.type === "sketch");
    const datums = doc.features.filter((f) => f.type === "datumPlane");

    // resolve display labels once (rename overrides) — reused by the signature
    // (so a rename forces a re-render) and the rows below.
    const bodyLabel = (b: { id: string; name: string }) => this.store.bodyName(b.id) ?? b.name;
    const sketchLabel = (f: { name?: string }, i: number) => f.name || `Sketch${i + 1}`;
    const planeLabel = (f: { name?: string }, i: number) => f.name || `Plane${i + 1}`;

    // the tree only depends on these — onDocChange + onBuild both fire per edit,
    // so bail when nothing visible changed instead of rebuilding the DOM twice.
    const sLabels = sketches.map((f, i) => `${f.id}=${sketchLabel(f, i)}:${(this.isSketchVisible?.(f.id) ?? true) ? "1" : "0"}`).join(",");
    const pLabels = datums.map((f, i) => `${f.id}=${planeLabel(f, i)}`).join(",");
    const bLabels = bodies
      .map((b) => `${b.id}=${bodyLabel(b)}${(this.isBodyVisible?.(b.id) ?? true) ? "" : ":h"}${this.isBodySelected?.(b.id) ? ":s" : ""}`)
      .join(",");
    const sig = `${sLabels}|${pLabels}|${bLabels}|${errId}|${this.selectedId}|${[...this.collapsed].join(",")}`;
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
    if (datums.length) {
      this.folder(
        "Planes",
        "▱",
        datums.map((f, i) => ({
          label: planeLabel(f as { name?: string }, i),
          icon: "▱",
          selected: this.selectedId === f.id,
          error: errId === f.id,
          onClick: () => this.onSelect?.(f.id),
          extraMenu: [{ label: "Cut all bodies", onClick: () => this.onCutPlane?.(f.id) }],
          rename: this.onRenamePlane ? (name: string) => this.onRenamePlane!(f.id, name) : undefined,
          onDelete: this.onDeletePlane ? () => this.onDeletePlane!(f.id) : undefined,
          title: "Construction plane — select then Split Body cuts by it · right-click for Cut / Rename / Delete",
        })),
      );
    }

    // --- Bodies ---
    this.folder(
      "Bodies",
      "◆",
      bodies.map((b) => ({
        label: bodyLabel(b),
        icon: "◆",
        selected: this.isBodySelected?.(b.id) ?? false,
        visible: this.isBodyVisible?.(b.id) ?? true,
        onClick: (e: MouseEvent) => this.onSelectBody?.(b.id, e.ctrlKey || e.metaKey),
        onToggleVis: this.onToggleBody ? () => this.onToggleBody!(b.id) : undefined,
        rename: this.onRenameBody ? (name: string) => this.onRenameBody!(b.id, name) : undefined,
        onDelete: this.onDeleteBody ? () => this.onDeleteBody!(b.id) : undefined,
        title: "Click to select (Ctrl+click adds) · double-click to rename · right-click for Rename / Delete · eye to show/hide",
      })),
    );

    // --- Sketches ---
    this.folder(
      "Sketches",
      "✎",
      sketches.map((f, i) => ({
        label: sketchLabel(f as { name?: string }, i),
        icon: "✎",
        selected: this.selectedId === f.id,
        error: errId === f.id,
        visible: this.isSketchVisible?.(f.id) ?? true,
        onClick: () => this.onSelect?.(f.id),
        onEdit: () => this.onEditSketch?.(f.id),
        onToggleVis: this.onToggleSketch ? () => this.onToggleSketch!(f.id) : undefined,
        rename: this.onRenameSketch ? (name: string) => this.onRenameSketch!(f.id, name) : undefined,
        onDelete: this.onDeleteSketch ? () => this.onDeleteSketch!(f.id) : undefined,
        title: "Double-click to edit · right-click for Edit / Rename / Delete · eye to show/hide",
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
      onToggleVis?: () => void;
      onEdit?: () => void; // "Edit" action (sketches) — also double-click
      rename?: (name: string) => void; // "Rename" — also double-click when there's no onEdit
      onDelete?: () => void; // "Delete" action
      extraMenu?: { label: string; onClick: () => void }[]; // prepended menu items (e.g. Cut all bodies)
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

      // inline rename bound to THIS row's label element
      const labelEl = row.querySelector(".tree-label") as HTMLElement;
      const startRename = it.rename
        ? () => this.startInlineRename(labelEl, it.label, it.rename!)
        : null;

      // structured right-click menu: [extra…] · Edit · Rename · Delete
      const menu: { label: string; onClick: () => void }[] = [];
      if (it.extraMenu) menu.push(...it.extraMenu);
      if (it.onEdit) menu.push({ label: "Edit", onClick: it.onEdit });
      if (startRename) menu.push({ label: "Rename", onClick: startRename });
      if (it.onDelete) menu.push({ label: "Delete", onClick: it.onDelete });

      if (it.onClick) row.addEventListener("click", (e) => it.onClick!(e));
      // double-click: Edit if available, else Rename
      if (it.onEdit) row.addEventListener("dblclick", it.onEdit);
      else if (startRename) row.addEventListener("dblclick", startRename);
      if (menu.length)
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, menu);
        });
      if (it.onToggleVis) {
        const eye = row.querySelector(".tree-eye")!;
        eye.addEventListener("click", (e) => {
          e.stopPropagation(); // don't select/edit the row
          it.onToggleVis!();
        });
      }
      this.el.appendChild(row);
    }
  }

  /** Inline-edit a row's label: contentEditable, select-all, commit on Enter/blur,
   *  cancel on Esc. stopPropagation keeps typing from firing app shortcuts. */
  private startInlineRename(labelEl: HTMLElement, current: string, commit: (name: string) => void) {
    labelEl.style.opacity = "";
    labelEl.setAttribute("contenteditable", "true");
    labelEl.textContent = current;
    labelEl.classList.add("renaming");
    labelEl.focus();
    const range = document.createRange();
    range.selectNodeContents(labelEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      labelEl.removeAttribute("contenteditable");
      labelEl.classList.remove("renaming");
      const name = (labelEl.textContent ?? "").trim();
      if (save && name && name !== current) commit(name);
      else labelEl.textContent = current; // a re-render will overwrite this anyway
    };
    labelEl.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep keystrokes out of the global keymap while editing
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    labelEl.addEventListener("blur", () => finish(true));
  }
}
