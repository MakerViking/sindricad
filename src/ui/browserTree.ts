// Left browser, MCAD-style: object-oriented, collapsible folders rather than
// a flat feature list. Origin (the three base planes — click to start a sketch
// on one), Sketches (all sketch features grouped together), and Bodies (shown
// when the document produces a solid). The chronological operations
// (extrude/fillet/...) live in the bottom Timeline, as in mainstream MCAD.

import type { DocumentStore } from "../document/store";
import type { Plane3 } from "../types";
import { contextMenu, type CtxItem } from "./menu";
import { esc } from "./escape";

/** Palette → menu items for assigning a body's color slot. Shared by the
 *  browser-tree row menu and the viewport's right-click body menu so the two
 *  surfaces can't drift (swatch chips, current slot disabled). */
export function bodyColorMenuItems(store: DocumentStore, bodyId: string): CtxItem[] {
  const slot = store.bodyColorSlot(bodyId);
  return [
    ...store.colorPalette.map((s, i) => ({
      label: s.name,
      swatch: s.color,
      disabled: slot === i,
      onClick: () => store.setBodyColorSlot(bodyId, i),
    })),
    { label: "None", disabled: slot == null, onClick: () => store.setBodyColorSlot(bodyId, null) },
  ];
}

/** One node of an imported assembly tree, as the browser renders it. */
interface AsmGroup {
  key: string; // namespaced collapse key, "n:<featureId>/<nodeIndex>"
  label: string;
  children: AsmGroup[];
  bodies: { id: string; name: string }[];
  total: number; // bodies at or below this node — what the count badge shows
}

/** Every body id at or below `g`. */
function collectBodyIds(g: AsmGroup, out: string[] = []): string[] {
  for (const b of g.bodies) out.push(b.id);
  for (const c of g.children) collectBodyIds(c, out);
  return out;
}

/** Shape imported-assembly bodies into the tree the browser renders.
 *
 *  Pure on purpose — this is the part with real logic (chain walking, sibling
 *  identity, malformed manifests), so it is unit-tested directly rather than
 *  through the DOM. Returns null when no body belongs to an assembly, which is
 *  every document without one; the caller then renders the flat list unchanged.
 *
 *  A body whose `nodeRef` does not resolve goes to `loose` rather than being
 *  dropped: a body missing from the browser is invisible AND unselectable, which
 *  is far worse than one shown at the top level.
 */
export function buildAssemblyGroups(
  bodies: readonly { id: string; name: string; nodeRef?: string }[],
  trees: ReadonlyMap<string, readonly { name: string; parent: number | null }[]>,
): {
  roots: AsmGroup[];
  loose: { id: string; name: string }[];
  ancestors: Map<string, string[]>;
} | null {
  if (!bodies.some((b) => b.nodeRef)) return null;

  const roots: AsmGroup[] = [];
  const byKey = new Map<string, AsmGroup>();
  const loose: { id: string; name: string }[] = [];
  const ancestors = new Map<string, string[]>();

  for (const b of bodies) {
    const slash = b.nodeRef ? b.nodeRef.lastIndexOf("/") : -1;
    const featureId = slash > 0 ? b.nodeRef!.slice(0, slash) : "";
    const nodes = featureId ? trees.get(featureId) : undefined;
    const leafIndex = slash > 0 ? Number(b.nodeRef!.slice(slash + 1)) : NaN;
    if (!nodes || !Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= nodes.length) {
      loose.push({ id: b.id, name: b.name });
      continue;
    }
    // walk leaf -> root, guarding against a cyclic `parent` in a hand-edited file
    const chain: number[] = [];
    const seen = new Set<number>();
    for (let i: number | null = leafIndex; i !== null && i >= 0 && i < nodes.length && !seen.has(i); i = nodes[i]!.parent) {
      seen.add(i);
      chain.unshift(i);
    }
    let siblings = roots;
    let group: AsmGroup | undefined;
    const chainKeys: string[] = [];
    for (const index of chain) {
      const key = `n:${featureId}/${index}`;
      let next = byKey.get(key);
      if (!next) {
        next = { key, label: nodes[index]!.name || "Part", children: [], bodies: [], total: 0 };
        byKey.set(key, next);
        siblings.push(next);
      }
      chainKeys.push(key);
      group = next;
      siblings = next.children;
    }
    if (!group) {
      loose.push({ id: b.id, name: b.name });
      continue;
    }
    group.bodies.push({ id: b.id, name: b.name });
    ancestors.set(b.id, chainKeys);
  }

  const total = (g: AsmGroup): number =>
    (g.total = g.bodies.length + g.children.reduce((n, c) => n + total(c), 0));
  for (const r of roots) total(r);
  return { roots, loose, ancestors };
}

export class BrowserTree {
  private el: HTMLElement;
  private selectedId: string | null = null;
  // Collapsed sections, by NAMESPACED key: "f:<folder name>" for the built-in
  // folders, "n:<featureId>/<nodeIndex>" for assembly-tree nodes. Namespacing is
  // not cosmetic — assembly node labels come from a STEP file, so two
  // subassemblies sharing a product name would otherwise collapse as one, and a
  // product named "Bodies" would collide with a built-in folder.
  private collapsed = new Set<string>();
  // Assembly nodes default to COLLAPSED: a 3,000-part import must not paint
  // 3,000 rows on arrival. A key is seeded into `collapsed` the first time it is
  // seen, so the user's own expand/collapse then persists.
  private seenNodes = new Set<string>();
  // body id → the assembly node keys enclosing it, so beginRename can open the
  // whole chain before looking for the row.
  private bodyAncestors = new Map<string, string[]>();
  private printerOnline: boolean | null = null; // last printer-sync outcome (null = unknown → grey dot)
  // passive printer checks (F1): one-shot probe + a single 30s staleness poll.
  // BOTH are guarded by these fields — render() fires on every doc edit, so an
  // unguarded re-arm here would probe the LAN per keystroke.
  private probedOnce = false;
  private pollTimer: number | null = null;
  private staleSlots = new Set<number>(); // palette slots that differ from the printer (render-only)
  private lastSig = ""; // skip redundant rebuilds (doc + build both fire)
  // per-render map of row id → start-inline-rename, for programmatic rename
  // (right-click a body in the viewport → Rename…). Rebuilt on every real render.
  private renameHooks = new Map<string, () => void>();

  onSelect: ((id: string) => void) | null = null;
  onEditSketch: ((id: string) => void) | null = null;
  onSketchOnPlane: ((plane: Plane3) => void) | null = null;
  onToggleSketch: ((id: string) => void) | null = null;
  isSketchVisible: ((id: string) => boolean) | null = null;
  onToggleBody: ((id: string) => void) | null = null;
  isBodyVisible: ((id: string) => boolean) | null = null;
  // per-construction-plane show/hide (eye toggle), mirroring bodies.
  onTogglePlane: ((id: string) => void) | null = null;
  isPlaneVisible: ((id: string) => boolean) | null = null;
  // body multi-selection (for Move): click selects, Ctrl/Cmd-click adds.
  onSelectBody: ((id: string, additive: boolean) => void) | null = null;
  isBodySelected: ((id: string) => boolean) | null = null;
  /** All selected body ids at once. Preferred over per-body `isBodySelected`,
   *  which the viewport backs with `getSelectedBodies().includes(id)` — a fresh
   *  array allocation plus a linear scan PER BODY, paid on every doc change and
   *  every build even when the signature guard then bails. */
  selectedBodyIds: (() => string[]) | null = null;
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

  /** Begin the inline rename of a row by id (right-click a body → Rename…).
   *  Expands the Bodies folder and any enclosing assembly nodes first, so the
   *  row exists on screen — rename hooks are only registered for rows that were
   *  actually emitted. */
  beginRename(id: string) {
    let opened = false;
    for (const key of ["f:Bodies", ...(this.bodyAncestors.get(id) ?? [])]) {
      if (this.collapsed.delete(key)) opened = true;
    }
    if (opened) this.render();
    this.renameHooks.get(id)?.();
  }

  private toggle(key: string) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.render();
  }

  private render() {
    const doc = this.store.document;
    const errId = this.store.buildState.errorFeatureId;
    const result = this.store.buildState.result;
    const hasSolid = (result?.mesh.positions.length ?? 0) > 0;
    // real per-body list from the rebuild; fall back to a single implicit body
    // when the backend didn't send body metadata but a solid exists.
    const bodies: { id: string; name: string; nodeRef?: string }[] = result?.bodies?.length
      ? result.bodies.map((b) => ({
          id: b.id, name: b.name,
          ...(b.nodeRef !== undefined ? { nodeRef: b.nodeRef } : {}),
        }))
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
    const pLabels = datums.map((f, i) => `${f.id}=${planeLabel(f, i)}${(this.isPlaneVisible?.(f.id) ?? true) ? "" : ":h"}`).join(",");
    // one lookup per render instead of one per body (see selectedBodyIds)
    const selectedIds = this.selectedBodyIds ? new Set(this.selectedBodyIds()) : null;
    const isSelected = (id: string) =>
      selectedIds ? selectedIds.has(id) : (this.isBodySelected?.(id) ?? false);
    const bLabels = bodies
      .map((b) => `${b.id}=${bodyLabel(b)}${(this.isBodyVisible?.(b.id) ?? true) ? "" : ":h"}${isSelected(b.id) ? ":s" : ""}#${this.store.bodyColorSlot(b.id) ?? ""}${b.nodeRef ? `@${b.nodeRef}` : ""}`)
      .join(",");
    const palSig = this.store.colorPalette.map((s) => `${s.name}:${s.color}:${s.material ?? ""}`).join(",");
    // The assembly tree is read from the DOCUMENT, not from the bodies, so it has
    // to be in the signature too. Two documents can produce identical bodies (same
    // ids, names and nodeRefs) while their product NAMES differ — without this the
    // guard below sees no change and the panel keeps painting the old tree. Costs
    // nothing for a document with no imported assembly, which is the common case.
    const treeSig = doc.features
      .map((f) => {
        const nodes = (f as { nodes?: { name: string }[] }).nodes;
        return nodes ? `${f.id}#${nodes.map((n) => n.name).join("")}` : "";
      })
      .join("");
    const sig = `${sLabels}|${pLabels}|${bLabels}|${palSig}|${treeSig}|${errId}|${this.selectedId}|${[...this.collapsed].join(",")}|${this.printerOnline}|${[...this.staleSlots].join(",")}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.renameHooks.clear(); // rebuilt below with the fresh rows

    // #browser is the scrolling container, and this wipe throws its scroll
    // position away — so every eye toggle used to jump the panel back to the top
    // (main.ts calls refresh() on each one, bypassing the signature guard).
    const scroll = this.el.scrollTop;
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
          visible: this.isPlaneVisible?.(f.id) ?? true,
          onClick: () => this.onSelect?.(f.id),
          onToggleVis: this.onTogglePlane ? () => this.onTogglePlane!(f.id) : undefined,
          extraMenu: [{ label: "Cut all bodies", onClick: () => this.onCutPlane?.(f.id) }],
          rename: this.onRenamePlane ? (name: string) => this.onRenamePlane!(f.id, name) : undefined,
          onDelete: this.onDeletePlane ? () => this.onDeletePlane!(f.id) : undefined,
          title: "Construction plane — select then Split Body cuts by it · right-click for Cut / Rename / Delete · eye to show/hide",
        })),
      );
    }

    // --- Palette + Bodies ---
    if (bodies.length) this.renderPalette();
    const bodyItem = (b: { id: string; name: string }) => {
      const slot = this.store.bodyColorSlot(b.id);
      const pal = this.store.colorPalette;
      return {
        id: b.id,
        label: bodyLabel(b),
        icon: "◆",
        swatch: slot != null && pal[slot] ? pal[slot].color : undefined,
        selected: selectedIds ? selectedIds.has(b.id) : (this.isBodySelected?.(b.id) ?? false),
        visible: this.isBodyVisible?.(b.id) ?? true,
        onClick: (e: MouseEvent) => this.onSelectBody?.(b.id, e.ctrlKey || e.metaKey),
        onToggleVis: this.onToggleBody ? () => this.onToggleBody!(b.id) : undefined,
        extraMenu: [{ label: "Color", children: bodyColorMenuItems(this.store, b.id) }],
        rename: this.onRenameBody ? (name: string) => this.onRenameBody!(b.id, name) : undefined,
        onDelete: this.onDeleteBody ? () => this.onDeleteBody!(b.id) : undefined,
        title: "Click to select (Ctrl+click adds) · double-click to rename · right-click for Color / Rename / Delete · eye to show/hide",
      };
    };
    this.bodyAncestors.clear();
    const groups = this.assemblyGroups(bodies, doc);
    if (!groups) {
      // no imported assembly tree in this document — exactly the flat list as before
      this.folder("Bodies", "◆", bodies.map(bodyItem));
    } else if (!this.renderHead("f:Bodies", "Bodies", "◆", bodies.length, 0)) {
      for (const b of groups.loose) this.renderRow(bodyItem(b), 0);
      for (const n of groups.roots) this.renderAssemblyNode(n, 0, bodyItem);
    }

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

    if (scroll) this.el.scrollTop = scroll;
  }

  /** The filament palette: editable color slots (≤4 → the U1's toolheads). Click a
   *  swatch to recolor a slot; double-click its name to rename. Bodies are assigned
   *  to a slot, so editing one recolors everything using it. The header carries a
   *  connection dot + "sync from printer" button (Stage C). */
  private renderPalette() {
    this.armPrinterChecks();
    const pal = this.store.colorPalette;
    const collapsed = this.collapsed.has("Palette");
    const head = document.createElement("div");
    head.className = "tree-folder";
    const stale = this.printerOnline === true && this.staleSlots.size > 0;
    const dotColor = this.printerOnline == null ? "#888" : !this.printerOnline ? "#d23b30" : stale ? "#d2a83b" : "#3ba55d";
    const dotTitle = stale
      ? `Printer filaments changed since sync (slot${this.staleSlots.size > 1 ? "s" : ""} ${[...this.staleSlots].map((i) => i + 1).join(", ")}) — click ⇅ to re-sync`
      : "Printer connection";
    head.innerHTML =
      `<span class="tree-caret">${collapsed ? "▸" : "▾"}</span><span class="feature-icon">◳</span><span>Palette</span>` +
      `<span style="flex:1"></span>` +
      `<span class="pal-dot" title="${esc(dotTitle)}" style="width:8px;height:8px;border-radius:50%;background:${dotColor};display:inline-block;margin-right:6px"></span>` +
      `<button class="pal-sync" title="Sync filaments from printer" style="background:none;border:none;color:inherit;cursor:pointer;font-size:13px;padding:0 4px;margin-right:6px">⇅</button>` +
      `<span class="tree-count">${pal.length}</span>`;
    head.addEventListener("click", (e) => {
      // the sync button lives in the header but must not also toggle the folder
      if ((e.target as HTMLElement).closest(".pal-sync")) return;
      this.toggle("Palette");
    });
    head.querySelector(".pal-sync")!.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.syncFilamentsFromPrinter();
    });
    this.el.appendChild(head);
    if (collapsed) return;
    pal.forEach((slot, i) => {
      const row = document.createElement("div");
      row.className = "feature-row tree-child";
      row.title = `Filament slot ${i + 1} → toolhead ${i + 1}${slot.material ? ` (${slot.material})` : ""}`;
      row.innerHTML =
        `<input type="color" value="${esc(slot.color)}" class="pal-swatch" style="width:18px;height:18px;border:none;background:none;padding:0;cursor:pointer;vertical-align:middle">` +
        `<span class="tree-label" style="margin-left:7px">${esc(slot.name)}</span>` +
        (slot.material ? `<span class="pal-material" style="margin-left:6px;opacity:0.55;font-size:11px">${esc(slot.material)}</span>` : "");
      const input = row.querySelector(".pal-swatch") as HTMLInputElement;
      input.addEventListener("change", () => this.store.setPaletteSlot(i, { color: input.value }));
      const label = row.querySelector(".tree-label") as HTMLElement;
      label.addEventListener("dblclick", () =>
        this.startInlineRename(label, slot.name, (name) => this.store.setPaletteSlot(i, { name })),
      );
      this.el.appendChild(row);
    });
  }

  /** Passive printer checks, armed ONCE from the first renderPalette reach:
   *  a one-shot probe (lights the dot without a sync click) and a single 30s
   *  staleness poll (re-diffs printer filaments vs the palette WITHOUT applying;
   *  skipped while the tab is hidden or the folder is collapsed). The tree
   *  lives for the app's lifetime, so the interval is never torn down. */
  private armPrinterChecks() {
    if (!("__TAURI_INTERNALS__" in window)) return;
    if (!this.probedOnce) {
      this.probedOnce = true;
      void (async () => {
        try {
          const { activePrinterId, printerProbe } = await import("../print/printerClient");
          const info = await printerProbe(activePrinterId());
          this.printerOnline = info.online;
        } catch {
          this.printerOnline = false; // passive — no toast
        }
        this.render();
      })();
    }
    if (this.pollTimer == null) {
      this.pollTimer = window.setInterval(() => void this.pollStaleness(), 30_000);
    }
  }

  private async pollStaleness() {
    if (document.visibilityState !== "visible" || this.collapsed.has("Palette")) return;
    try {
      const { activePrinterId, printerFilaments } = await import("../print/printerClient");
      const filaments = await printerFilaments(activePrinterId());
      this.printerOnline = true;
      this.staleSlots = this.filamentDiffSlots(filaments);
    } catch {
      this.printerOnline = false;
      this.staleSlots.clear();
    }
    this.render();
  }

  /** Slots where the printer's loaded filament differs from the palette — the
   *  same name/color criteria the sync-confirm dialog diffs on. */
  private filamentDiffSlots(filaments: { index: number; present: boolean; vendor: string; material: string; color: string }[]): Set<number> {
    const cur = this.store.colorPalette;
    const out = new Set<number>();
    filaments.forEach((f, i) => {
      if (!f.present || i >= cur.length) return;
      const name = `${f.vendor} ${f.material}`.trim() || `Toolhead ${f.index + 1}`;
      if (cur[i]?.name !== name || cur[i]?.color !== f.color) out.add(i);
    });
    return out;
  }

  /** Pull the printer's loaded filaments into the palette, 1:1 by toolhead index.
   *  Read-only sync (printer → palette); the printer is the source of truth for
   *  what's physically loaded. Confirms before overwriting a customized palette. */
  private async syncFilamentsFromPrinter() {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const { activePrinterId, printerFilaments, asPrinterError } = await import("../print/printerClient");
    const { toast } = await import("./toast");
    let filaments;
    try {
      filaments = await printerFilaments(activePrinterId());
    } catch (e) {
      this.printerOnline = false;
      this.render();
      const pe = asPrinterError(e);
      toast(pe ? `Can't reach the printer: ${pe.message}` : `Printer error: ${String(e)}`, { kind: "error" });
      return;
    }
    this.printerOnline = true;

    // one proposed slot per loaded toolhead; empty toolheads leave the slot alone.
    const proposed = filaments.map((f) =>
      f.present
        ? { name: `${f.vendor} ${f.material}`.trim() || `Toolhead ${f.index + 1}`, color: f.color, material: f.material }
        : undefined,
    );
    if (!proposed.some(Boolean)) {
      this.render();
      toast("No filament loaded on the printer.", { kind: "info" });
      return;
    }

    if (!this.store.paletteIsDefault()) {
      const { choose } = await import("./choice");
      const cur = this.store.colorPalette;
      const diff = proposed
        .map((p, i) => (p && (cur[i]?.name !== p.name || cur[i]?.color !== p.color) ? `Slot ${i + 1}: ${cur[i]?.name ?? "—"} → ${p.name}` : null))
        .filter(Boolean) as string[];
      const go = await choose<"apply" | "cancel">(
        diff.length ? `Overwrite palette from printer?\n${diff.join("\n")}` : "Sync palette from printer?",
        [
          { value: "apply", label: "Overwrite", hint: `${diff.length} slot${diff.length === 1 ? "" : "s"}` },
          { value: "cancel", label: "Cancel" },
        ],
      );
      if (go !== "apply") {
        this.render();
        return;
      }
    }

    this.store.applyFilamentSync(proposed);
    this.staleSlots.clear(); // palette now matches the printer by construction
    this.render();
    toast("Palette synced from printer.", { kind: "info" });
  }

  private folder(
    name: string,
    icon: string,
    items: {
      id?: string; // stable id — registers a programmatic-rename hook (beginRename)
      label: string;
      icon: string;
      swatch?: string | undefined; // a small colored chip before the label (assigned body color)
      dim?: boolean;
      selected?: boolean;
      error?: boolean;
      visible?: boolean;
      title?: string;
      onClick?: (e: MouseEvent) => void;
      onToggleVis?: (() => void) | undefined;
      onEdit?: (() => void) | undefined; // "Edit" action (sketches) — also double-click
      rename?: ((name: string) => void) | undefined; // "Rename" — also double-click when there's no onEdit
      onDelete?: (() => void) | undefined; // "Delete" action
      extraMenu?: CtxItem[]; // prepended menu items (e.g. Cut all bodies, Color ▸)
    }[],
  ) {
    const key = `f:${name}`;
    if (this.renderHead(key, name, icon, items.length, 0)) return;
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state tree-child";
      empty.textContent = name === "Bodies" ? "No bodies yet" : `No ${name.toLowerCase()} yet`;
      this.el.appendChild(empty);
      return;
    }
    for (const it of items) this.renderRow(it, 0);
  }

  /** Indentation for a row/head nested `depth` levels inside its folder. Capped:
   *  the panel is a fixed 232px with no resizer, and the reference assembly is 12
   *  levels deep, so an uncapped step would spend the whole width on whitespace. */
  private static indent(depth: number, base: number) {
    return base + Math.min(depth, 6) * 8;
  }

  /** Group bodies by the imported assembly tree they came from, and fold the
   *  result into this panel's view state (default-collapsed seeding, rename
   *  ancestry). The shaping itself lives in `buildAssemblyGroups`. */
  private assemblyGroups(
    bodies: { id: string; name: string; nodeRef?: string }[],
    doc: { features: readonly { id: string; type: string }[] },
  ): { roots: AsmGroup[]; loose: { id: string; name: string }[] } | null {
    const trees = new Map<string, { name: string; parent: number | null }[]>();
    for (const f of doc.features) {
      const nodes = (f as { nodes?: { name: string; parent: number | null }[] }).nodes;
      if (f.type === "import" && nodes) trees.set(f.id, nodes);
    }
    const built = buildAssemblyGroups(bodies, trees);
    if (!built) return null;
    for (const [bodyId, keys] of built.ancestors) this.bodyAncestors.set(bodyId, keys);
    // Assembly nodes start COLLAPSED: a 3,000-part import must not paint 3,000
    // rows on arrival. Seeded on first sight, so the user's own expand/collapse
    // then persists across renders.
    const seed = (g: AsmGroup) => {
      if (!this.seenNodes.has(g.key)) {
        this.seenNodes.add(g.key);
        this.collapsed.add(g.key);
      }
      for (const c of g.children) seed(c);
    };
    for (const r of built.roots) seed(r);
    return built;
  }

  /** Render one assembly node and everything under it.
   *
   *  A node that owns exactly one body and no children is emitted as that body's
   *  ROW, not as a folder wrapping a single entry — the body already carries the
   *  product's name, so a folder there would just say everything twice. */
  private renderAssemblyNode(
    g: AsmGroup,
    depth: number,
    bodyItem: (b: { id: string; name: string }) => Parameters<BrowserTree["renderRow"]>[0],
  ) {
    if (g.children.length === 0 && g.bodies.length === 1) {
      this.renderRow(bodyItem(g.bodies[0]!), depth);
      return;
    }
    const ids = collectBodyIds(g);
    const anyVisible = ids.some((id) => this.isBodyVisible?.(id) ?? true);
    const toggle = this.onToggleBody
      ? () => {
          // one batched write: a per-body loop would re-render the whole model
          // once per body (setModel + the flush-seam pass each time)
          this.store.setBodiesVisibility(new Map(ids.map((id) => [id, !anyVisible])));
          this.refresh();
        }
      : undefined;
    if (this.renderHead(g.key, g.label, "▣", g.total, depth, toggle, anyVisible)) return;
    for (const child of g.children) this.renderAssemblyNode(child, depth + 1, bodyItem);
    for (const b of g.bodies) this.renderRow(bodyItem(b), depth + 1);
  }

  /** A collapsible section head. Returns true when the section is COLLAPSED, so
   *  the caller can skip emitting its contents. */
  private renderHead(
    key: string,
    label: string,
    icon: string,
    count: number,
    depth: number,
    onToggleVis?: (() => void) | undefined,
    visible?: boolean,
    menu?: CtxItem[],
  ): boolean {
    const collapsed = this.collapsed.has(key);
    const head = document.createElement("div");
    head.className = "tree-folder";
    if (depth > 0) head.style.paddingLeft = `${BrowserTree.indent(depth, 8)}px`;
    // esc() on BOTH label and icon: assembly node labels are product names read
    // straight out of an untrusted STEP file.
    head.innerHTML =
      `<span class="tree-caret">${collapsed ? "▸" : "▾"}</span>` +
      `<span class="feature-icon">${esc(icon)}</span>` +
      `<span class="tree-label">${esc(label)}</span>` +
      `<span style="flex:1"></span>` +
      `<span class="tree-count">${count || ""}</span>` +
      (onToggleVis ? `<span class="tree-eye" title="Show/hide">${visible === false ? "○" : "◉"}</span>` : "");
    head.addEventListener("click", () => this.toggle(key));
    if (onToggleVis) {
      head.querySelector(".tree-eye")!.addEventListener("click", (e) => {
        e.stopPropagation(); // don't collapse the section
        onToggleVis();
      });
    }
    if (menu?.length) {
      head.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, menu);
      });
    }
    this.el.appendChild(head);
    return collapsed;
  }

  private renderRow(
    it: {
      id?: string;
      label: string;
      icon: string;
      swatch?: string | undefined;
      dim?: boolean;
      selected?: boolean;
      error?: boolean;
      visible?: boolean;
      title?: string;
      onClick?: (e: MouseEvent) => void;
      onToggleVis?: (() => void) | undefined;
      onEdit?: (() => void) | undefined;
      rename?: ((name: string) => void) | undefined;
      onDelete?: (() => void) | undefined;
      extraMenu?: CtxItem[];
    },
    depth: number,
  ) {
    {
      const row = document.createElement("div");
      row.className = "feature-row tree-child";
      if (depth > 0) row.style.paddingLeft = `${BrowserTree.indent(depth, 26)}px`;
      if (it.selected) row.classList.add("selected");
      if (it.error) row.classList.add("error");
      if (it.dim) row.style.opacity = "0.7";
      if (it.title) row.title = it.title;
      const hidden = it.onToggleVis && it.visible === false;
      const swatch = it.swatch
        ? `<span class="tree-swatch" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${esc(it.swatch)};border:1px solid #0007;margin-right:5px;vertical-align:middle"></span>`
        : "";
      row.innerHTML =
        `<span class="feature-icon">${esc(it.icon)}</span>` +
        swatch +
        `<span class="tree-label"${hidden ? ' style="opacity:.45"' : ""}>${esc(it.label)}</span>` +
        `<span style="flex:1"></span>` +
        (it.onToggleVis ? `<span class="tree-eye" title="Show/hide">${it.visible === false ? "○" : "◉"}</span>` : "");

      // inline rename bound to THIS row's label element
      const labelEl = row.querySelector(".tree-label") as HTMLElement;
      const startRename = it.rename
        ? () => this.startInlineRename(labelEl, it.label, it.rename!)
        : null;
      if (it.id && startRename) this.renameHooks.set(it.id, startRename);

      // structured right-click menu: [extra…] · Edit · Rename · Delete
      const menu: CtxItem[] = [];
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
