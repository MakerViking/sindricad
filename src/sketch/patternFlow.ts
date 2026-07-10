// Pattern placement/edit flow: click to place, drag to size, type counts, click
// to commit. Each pattern persists as an editable (associative) definition —
// entity patterns (rect/circular) replicate the current selection, presets emit
// holes. Operates through the PatternHost accessor SketchMode provides — the
// pending/center/edit-original state below is this collaborator's own (moved
// out of SketchMode entirely), everything else is a live reference back into it.

import * as THREE from "three";
import type { SketchPattern } from "../types";
import type { DimInput } from "./dimInput";
import { newPatternId } from "./id";
import { setPrompt } from "../ui/prompt";
import type { SketchTool } from "./sketchMode";

// preset hole patterns: self-contained (click a center, no source selection)
export const PRESET_PATTERNS = new Set<SketchTool>(["hexHoles", "honeycomb", "boltCircle", "gridHoles"]);
// patterns that replicate the current selection (MCAD-style)
export const ENTITY_PATTERNS = new Set<SketchTool>(["patternRect", "patternCircular"]);
// every pattern tool (presets + entity patterns)
export const PATTERN_TOOLS = new Set<SketchTool>([...PRESET_PATTERNS, ...ENTITY_PATTERNS]);

/** The slice of SketchMode this flow reads/writes — live accessors, not copies. */
export interface PatternHost {
  /** current active sketch tool (which pattern is being placed) */
  tool(): SketchTool;
  /** raw tool assignment, bypassing setTool()'s reset side-effects — editPattern
   *  needs the active tool switched to match the pattern being edited without
   *  wiping the placement state it just set up */
  setActiveTool(t: SketchTool): void;
  /** the full tool switch (used once placement commits, to return to "select") */
  setTool(t: SketchTool): void;
  /** live multi-selection — never copied */
  selected(): Set<string>;
  /** live pattern list — never copied; placement/edit push/splice it directly */
  patterns(): SketchPattern[];
  /** the shared on-canvas dimension input */
  dim(): DimInput;
  refreshActive(): void;
  onState(): void;
}

export class PatternFlow {
  private pendingPattern: SketchPattern | null = null; // one being placed (live)
  private patternCenter: THREE.Vector2 | null = null; // its center (first click)
  private editOriginal: SketchPattern | null = null; // when editing, the pre-edit copy (Esc restores)

  constructor(private host: PatternHost) {}

  /** the pattern currently being placed/edited (live), for preview/derivedEntities */
  get pending(): SketchPattern | null {
    return this.pendingPattern;
  }
  hasPending(): boolean {
    return this.pendingPattern != null;
  }

  /** fresh sketch session: drop any placement state (mirrors enter()'s original
   *  scope — editOriginal is intentionally left alone, as before: it's always
   *  overwritten before it's next read, by editPattern()). */
  resetForEnter() {
    this.pendingPattern = null;
    this.patternCenter = null;
  }

  /** push any in-progress pattern into the committed list, nulling only the
   *  pending pattern itself (used by finish()). */
  flushOnFinish() {
    if (this.pendingPattern) {
      this.host.patterns().push(this.pendingPattern);
      this.pendingPattern = null;
    }
  }

  /** don't lose an in-progress pattern when the tool changes: keep it, then
   *  fully clear the placement/edit UI state (used by setTool()). */
  flushPending() {
    if (this.pendingPattern) this.host.patterns().push(this.pendingPattern);
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
  }

  /** Delete/Backspace while a pattern is pending: remove it outright. */
  deletePending() {
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.host.dim().hide();
    setPrompt(null);
    this.host.refreshActive();
    this.host.onState();
  }

  /** Escape while a pattern is pending: restore the pre-edit pattern (editing) or
   *  keep the fresh placement at its current values (new). */
  cancelPending() {
    if (!this.pendingPattern) return;
    if (this.editOriginal) this.host.patterns().push(this.editOriginal); // restore the pre-edit pattern
    else this.host.patterns().push(this.pendingPattern); // a fresh placement: keep it at its current values
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.host.dim().hide();
    setPrompt(null);
    this.host.refreshActive();
    this.host.onState();
  }

  click(p: THREE.Vector2) {
    if (!this.patternCenter) {
      if (ENTITY_PATTERNS.has(this.host.tool()) && this.host.selected().size === 0) {
        setPrompt("Select entities first, then choose a pattern tool");
        return;
      }
      this.patternCenter = p.clone();
      this.pendingPattern = this.defaultPattern(this.host.tool(), p);
      this.host.dim().show(this.patternDimDefs(this.pendingPattern.type), () => this.commit());
      this.host.refreshActive();
      return;
    }
    this.commit(); // second click commits
  }

  private defaultPattern(tool: SketchTool, c: THREE.Vector2): SketchPattern {
    const id = newPatternId();
    const sources = [...this.host.selected()];
    if (tool === "boltCircle") return { id, type: "boltCircle", cx: c.x, cy: c.y, bcd: 40, count: 6, diameter: 6 };
    if (tool === "gridHoles") return { id, type: "gridHoles", cx: c.x, cy: c.y, diameter: 6, countX: 3, countY: 3, spacingX: 12, spacingY: 12 };
    if (tool === "hexHoles") return { id, type: "hexHoles", cx: c.x, cy: c.y, diameter: 6, spacing: 12, rings: 2 };
    if (tool === "honeycomb") return { id, type: "honeycomb", cx: c.x, cy: c.y, diameter: 12, spacing: 13, rings: 2 };
    if (tool === "patternCircular") return { id, type: "patternCircular", sources, cx: c.x, cy: c.y, count: 6, angle: 360 };
    return { id, type: "patternRect", sources, countX: 3, countY: 1, spacingX: 15, spacingY: 15 }; // patternRect
  }

  private patternDimDefs(type: SketchPattern["type"]) {
    if (type === "boltCircle") return [{ name: "count", label: "N" }, { name: "diameter", label: "⌀" }];
    if (type === "gridHoles") return [{ name: "countX", label: "Nx" }, { name: "countY", label: "Ny" }, { name: "diameter", label: "⌀" }];
    if (type === "hexHoles" || type === "honeycomb") return [{ name: "rings", label: "Rings" }, { name: "diameter", label: "⌀" }];
    if (type === "patternCircular") return [{ name: "count", label: "N" }, { name: "angle", label: "∠", kind: "angle" as const }];
    return [{ name: "countX", label: "Nx" }, { name: "countY", label: "Ny" }]; // patternRect
  }

  /** Live sizing: cursor offset/distance from the start point drives the spatial
   *  param (bolt dia / spacing / grid-step); typed fields drive counts/angle. */
  move(p: THREE.Vector2, e: PointerEvent) {
    if (!this.patternCenter || !this.pendingPattern) return;
    const pat = this.pendingPattern;
    const dim = this.host.dim();
    const dx = p.x - this.patternCenter.x, dy = p.y - this.patternCenter.y;
    const r = Math.hypot(dx, dy);
    const dimN = (name: string, fallback: number) => Math.round(dim.getValue(name) ?? fallback);
    if (pat.type === "boltCircle") {
      if (r > 1) pat.bcd = Math.round(2 * r * 10) / 10;
      pat.count = Math.max(1, dimN("count", pat.count as number));
      pat.diameter = dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "gridHoles") {
      if (r > 1) pat.spacingX = pat.spacingY = Math.round((r / 1.5) * 10) / 10;
      pat.countX = Math.max(1, dimN("countX", pat.countX as number));
      pat.countY = Math.max(1, dimN("countY", pat.countY as number));
      pat.diameter = dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "hexHoles" || pat.type === "honeycomb") {
      if (r > 1) pat.spacing = Math.round((r / 2) * 10) / 10;
      pat.rings = Math.max(0, dimN("rings", pat.rings as number));
      pat.diameter = dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "patternRect") {
      // cursor offset from the start point = the spacing vector (the second instance)
      if (Math.abs(dx) > 1) pat.spacingX = Math.round(dx * 10) / 10;
      if (Math.abs(dy) > 1) pat.spacingY = Math.round(dy * 10) / 10;
      pat.countX = Math.max(1, dimN("countX", pat.countX as number));
      pat.countY = Math.max(1, dimN("countY", pat.countY as number));
    } else if (pat.type === "patternCircular") {
      pat.count = Math.max(1, dimN("count", pat.count as number));
      pat.angle = dim.getValue("angle") ?? (pat.angle as number);
    }
    dim.position(e.clientX, e.clientY);
    this.host.refreshActive();
  }

  commit() {
    if (!this.pendingPattern) return;
    this.host.patterns().push(this.pendingPattern);
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.host.dim().hide();
    setPrompt(null);
    const selected = this.host.selected();
    if (selected.size) selected.clear(); // the pattern now owns the copies
    this.host.setTool("select"); // finish: one pattern per invocation (refreshes + notifies)
  }

  /** Associative editing: re-open an existing pattern's placement flow with its
   *  current values, so dragging/typing re-derives it live. Esc restores it. */
  edit(patId: string) {
    const patterns = this.host.patterns();
    const i = patterns.findIndex((p) => p.id === patId);
    if (i < 0) return;
    const pat = patterns[i];
    patterns.splice(i, 1); // pull it out; commit/cancel puts it back
    this.editOriginal = { ...pat };
    this.pendingPattern = pat;
    this.patternCenter = new THREE.Vector2(
      "cx" in pat ? (pat.cx as number) : 0,
      "cy" in pat ? (pat.cy as number) : 0,
    );
    this.host.setActiveTool(pat.type);
    const cur: Record<string, number> = {};
    for (const d of this.patternDimDefs(pat.type)) cur[d.name] = (pat as unknown as Record<string, number>)[d.name];
    this.host.dim().show(this.patternDimDefs(pat.type), () => this.commit());
    this.host.dim().updateFromCursor(cur);
    setPrompt("Edit the pattern — drag/type to change · click to commit · Delete to remove · Esc to keep");
    this.host.refreshActive();
    this.host.onState();
  }
}
