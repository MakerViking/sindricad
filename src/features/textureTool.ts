// Texture tool: printed surface texture (knurl/hex/waves/ribs/voronoi/noise/image
// heightmap). Unlike Fillet/Chamfer/Press-Pull, this tool has NO drag gizmo — it
// rides the ambient viewport selection (click / Ctrl-click toggles faces, or a
// whole body in Bodies mode) and drives a docked TexturePanel for the kind +
// numeric knobs. An rAF tick diffs the ambient selection each frame (rather than
// hijacking viewport.onSelectionChange, which main.ts owns) and refreshes the
// panel's summary line + live preview when it changes. The preview is the REAL
// sidecar-computed displacement at viewport density, debounced like Fillet/
// PressPull (store.setPreview()/setEditPreview()). Commit promotes the preview
// to a real feature (records undo); Esc (via the panel) or Cancel reverts.

import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Num, Selector } from "../types";
import { TexturePanel, ANGLE_KINDS, SEED_KINDS, type TextureMode, type TextureValues } from "./texturePanel";
import { setPrompt } from "../ui/prompt";

// Warm texture ticks are ~10-70ms sidecar-side (geometry-skeleton cache), so a
// short debounce keeps scrubbing responsive while still coalescing keystrokes.
const PREVIEW_DEBOUNCE_MS = 150;

const defaultValues = (): TextureValues => ({
  kind: "knurl",
  depth: 0.4,
  scale: 2,
  angle: 0,
  offset: 0,
  sharpness: 0.5,
  direction: "out",
  seed: 1,
  invert: false,
});

function sameSet<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

export class TextureTool {
  active = false;
  private mode: TextureMode = "faces";
  private values: TextureValues = defaultValues();
  private previewId = "";
  private onDone: ((id: string | null) => void) | null = null;

  // --- edit mode (re-opening a committed texture) ---
  private editId: string | null = null;
  private savedFaceSelectors: Selector[] = [];
  private savedBodyId: string | null = null;
  private awaitingRollback = false;
  private unsubBuild: (() => void) | null = null;

  // --- ambient-selection diffing (rAF tick, not viewport.onSelectionChange —
  // that single callback slot belongs to main.ts) ---
  private lastFaceIds: number[] = [];
  private lastBodyIds: string[] = [];
  private raf = 0;
  private boundTick: () => void;
  private previewDebounce = 0;
  // setModel() clears the ambient selection on every rebuild — including the
  // tool's OWN preview rebuilds. Membership IS the ambient selection here, so
  // a landed preview would silently empty it (and Apply would no-op). A
  // build-completion flag lets the next tick tell "rebuild wiped it" (restore
  // the members) from "the user clicked empty space" (legit deselect-all).
  private rebuildLanded = false;

  private panel = new TexturePanel();

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {
    this.boundTick = () => this.tick();
  }

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.onDone = onDone;
    this.editId = null;
    this.previewId = this.store.nextId();
    this.values = defaultValues();
    // don't clobber the mode the user's already browsing in (e.g. came from
    // Select: Bodies with something pre-selected)
    this.mode = this.viewport.selecting === "bodies" ? "body" : "faces";
    this.viewport.setSelectionMode(this.mode === "body" ? "bodies" : "faces");
    this.lastFaceIds = [];
    this.lastBodyIds = [];
    this.rebuildLanded = false;
    this.unsubBuild = this.store.onBuild((s) => {
      if (!s.building && s.result) this.rebuildLanded = true;
    });
    this.openPanel(false);
    setPrompt("Select faces (or switch to Whole Body) for the texture · Esc to cancel");
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** Re-open a committed texture for editing: the model rolls back to just
   *  before the feature, its saved member faces/body are re-selected in the
   *  ambient selection (best-effort — a stale reference just shows as an empty
   *  selection, the same way a moved fillet edge can miss), the panel seeds from
   *  the saved values, and commit REPLACES the feature in place (same id, one
   *  undo step). Returns false when a numeric field holds a parameter
   *  expression (not tool-editable) — the caller falls back to the inspector. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "texture") return false;
    const numeric = [f.depth, f.scale, f.angle, f.offset, f.sharpness, f.seed];
    if (numeric.some((v) => v !== undefined && typeof v !== "number")) return false; // parameter — inspector's job

    this.active = true;
    this.onDone = onDone;
    this.editId = featureId;
    this.previewId = featureId; // keep the SAME id through preview and commit
    this.mode = f.faces ? "faces" : "body";
    this.savedFaceSelectors = f.faces ? (Array.isArray(f.faces) ? f.faces : [f.faces]) : [];
    this.savedBodyId = f.body ?? null;
    this.values = {
      kind: f.kind,
      depth: (f.depth as number) ?? 0.4,
      scale: (f.scale as number) ?? 2,
      angle: (f.angle as number) ?? 0,
      offset: (f.offset as number) ?? 0,
      sharpness: (f.sharpness as number) ?? 0.5,
      direction: f.direction ?? "out",
      seed: (f.seed as number) ?? 1,
      invert: f.invert ?? false,
      ...(f.imagePath ? { imagePath: f.imagePath } : {}),
      ...(typeof f.colorSlot === "number" ? { colorSlot: f.colorSlot } : {}),
    };
    this.awaitingRollback = true;
    this.lastFaceIds = [];
    this.lastBodyIds = [];
    this.viewport.setSelectionMode(this.mode === "body" ? "bodies" : "faces");
    setPrompt("Rolling back to edit… (later features are hidden while editing)");

    this.store.beginEditPreview(featureId);
    this.unsubBuild = this.store.onBuild((s) => {
      if (s.building || !s.result) return;
      if (this.awaitingRollback) {
        this.awaitingRollback = false;
        this.seedSelectionFromSaved();
        this.openPanel(true);
        this.pushPreview();
        this.raf = requestAnimationFrame(this.boundTick);
      } else {
        this.rebuildLanded = true; // an edit-preview rebuild wipes the selection too
      }
    });
    return true;
  }

  /** Re-select the saved member faces/body in the ambient selection so the
   *  drag-free "membership" (which IS the ambient selection for this tool)
   *  starts where the committed feature left off. Best-effort: a face whose
   *  saved point no longer matches anything within tolerance is just not
   *  re-highlighted (same risk a moved fillet edge accepts on re-anchor). */
  private seedSelectionFromSaved() {
    if (this.mode === "body") {
      if (this.savedBodyId) this.viewport.setSelectedBodies([this.savedBodyId]);
    } else {
      const ids: number[] = [];
      for (const sel of this.savedFaceSelectors) {
        if (!("point" in sel)) continue;
        const fid = this.viewport.faceIdNear(sel.point as [number, number, number]);
        if (fid != null) ids.push(fid);
      }
      this.viewport.selectFaces(ids);
    }
  }

  private openPanel(editing: boolean) {
    this.panel.show(
      { editing, mode: this.mode, summary: this.currentSummary(), initial: this.values, palette: this.store.colorPalette },
      {
        onCommit: (v) => { this.values = v; this.commit(); },
        onCancel: () => this.cancel(),
        onChange: (v) => { this.values = v; this.pushPreview(); },
        onModeChange: (m) => this.setMode(m),
      },
    );
  }

  private setMode(m: TextureMode) {
    if (this.mode === m) return;
    this.mode = m;
    // switching clears the OTHER kind of selection (setSelectionMode's job), so
    // the member set for the new mode always starts empty, not a stale mix.
    this.viewport.setSelectionMode(m === "body" ? "bodies" : "faces");
    this.lastFaceIds = [];
    this.lastBodyIds = [];
    this.panel.setMode(m);
    this.refreshSummary();
    this.pushPreview();
  }

  /** rAF tick: diff the ambient selection (not viewport.onSelectionChange —
   *  that single slot belongs to main.ts) and refresh the panel + preview when
   *  it moves, so clicking faces in the viewport feels live. */
  private tick() {
    if (!this.active) return;
    if (this.awaitingRollback) {
      this.raf = requestAnimationFrame(this.boundTick);
      return;
    }
    if (this.mode === "faces") {
      const cur = this.viewport.selectedFacesForPressPull()?.faceIds ?? [];
      // a rebuild (our own preview landing, usually) wiped the selection — the
      // members are still the tool's; restore them instead of treating the
      // wipe as a user deselect. Face ids are stable here: displacement never
      // adds or removes B-rep faces.
      if (this.rebuildLanded) {
        this.rebuildLanded = false;
        if (!cur.length && this.lastFaceIds.length) {
          this.viewport.selectFaces(this.lastFaceIds);
          this.raf = requestAnimationFrame(this.boundTick);
          return;
        }
      }
      if (!sameSet(cur, this.lastFaceIds)) {
        this.lastFaceIds = cur;
        this.refreshSummary();
        this.pushPreview();
      }
    } else {
      const cur = this.viewport.getSelectedBodies();
      if (this.rebuildLanded) {
        this.rebuildLanded = false;
        if (!cur.length && this.lastBodyIds.length) {
          this.viewport.setSelectedBodies(this.lastBodyIds);
          this.raf = requestAnimationFrame(this.boundTick);
          return;
        }
      }
      if (!sameSet(cur, this.lastBodyIds)) {
        this.lastBodyIds = cur;
        this.refreshSummary();
        this.pushPreview();
      }
    }
    this.raf = requestAnimationFrame(this.boundTick);
  }

  private currentSummary(): string {
    if (this.mode === "body") {
      const ids = this.viewport.getSelectedBodies();
      const id = ids[0];
      if (!id) return "Whole body: nothing selected — click a body";
      const b = (this.store.buildState.result?.bodies ?? []).find((x) => x.id === id);
      const name = this.store.bodyName(id) ?? b?.name ?? id;
      return ids.length > 1 ? `Whole body: ${name} (using first of ${ids.length} selected)` : `Whole body: ${name}`;
    }
    const n = this.viewport.selectedFacesForPressPull()?.faceIds.length ?? 0;
    return n ? `${n} face${n === 1 ? "" : "s"} selected` : "No faces selected — click one or more faces";
  }

  private refreshSummary() {
    this.panel.setSummary(this.currentSummary());
  }

  /** Live preview: every change (selection or params, any kind) debounces into
   *  the same sidecar-preview pipeline Fillet/PressPull use — the REAL
   *  displaced mesh at viewport density, ~half a second behind the slider.
   *  (A GPU vertex-shader preview was tried and dropped: it can only move
   *  vertices that already exist — invisible on a 2-triangle flat face — and
   *  without normal recomputation the shading never changes, so even dense
   *  meshes barely showed it.) An empty selection cancels any pending preview
   *  and clears an uncommitted one. */
  private pushPreview() {
    if (this.hasTarget()) {
      this.schedulePreview();
      return;
    }
    if (this.previewDebounce) {
      clearTimeout(this.previewDebounce);
      this.previewDebounce = 0;
    }
    if (!this.editId) this.store.setPreview(null);
  }

  private hasTarget(): boolean {
    if (this.mode === "body") return this.viewport.getSelectedBodies().length > 0;
    return (this.viewport.selectedFacesForPressPull()?.faceIds.length ?? 0) > 0;
  }

  private schedulePreview() {
    if (this.previewDebounce) clearTimeout(this.previewDebounce);
    this.previewDebounce = window.setTimeout(() => {
      this.previewDebounce = 0;
      const feature = this.buildFeature();
      if (this.editId) this.store.setEditPreview(feature);
      else this.store.setPreview(feature);
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** kind-specific extra fields — only the ones that apply to the chosen kind,
   *  so the emitted JSON stays a clean match for the sidecar's per-kind reader
   *  instead of every kind carrying every other kind's leftover defaults. */
  private kindFields(v: TextureValues): Partial<Record<string, Num | boolean | string>> {
    const extra: Partial<Record<string, Num | boolean | string>> = {};
    if (v.offset) extra.offset = v.offset;
    if (ANGLE_KINDS.has(v.kind)) {
      if (v.angle) extra.angle = v.angle;
      if (v.sharpness) extra.sharpness = v.sharpness;
      extra.direction = v.direction;
    }
    if (SEED_KINDS.has(v.kind)) extra.seed = v.seed;
    if (v.kind === "image") {
      if (v.imagePath) extra.imagePath = v.imagePath;
      extra.invert = v.invert;
    }
    return extra;
  }

  private buildFeature(): Feature | null {
    const v = this.values;
    const base = {
      id: this.previewId,
      type: "texture" as const,
      kind: v.kind,
      depth: v.depth,
      scale: v.scale,
      ...(v.colorSlot != null ? { colorSlot: v.colorSlot } : {}), // two-tone inlay slot (any kind)
      ...this.kindFields(v),
    };
    if (this.mode === "faces") {
      const sel = this.viewport.selectedFacesForPressPull();
      if (!sel || !sel.faceIds.length) return null;
      // Bind the target body. Without it the sidecar falls back to the ACTIVE
      // (last-created) body and resolves the face selector against the wrong
      // shape — so with >1 body the texture lands on a random face of the last
      // body, not the one clicked. A texture applies to a single body, so if the
      // selection spans bodies keep only faces on the bound (first) one rather
      // than silently resolving the rest against the wrong shape.
      const body = sel.bodyId ?? undefined;
      const selectors = body
        ? sel.selectors.filter((_, i) => this.viewport.faceIdToBodyId(sel.faceIds[i]!) === body)
        : sel.selectors;
      if (!selectors.length) return null;
      return { ...base, ...(body ? { body } : {}), faces: selectors.length === 1 ? selectors[0]! : selectors } as Feature;
    }
    const body = this.viewport.getSelectedBodies()[0];
    if (!body) return null;
    return { ...base, body } as Feature;
  }

  private commit() {
    if (!this.active) return;
    const feature = this.buildFeature();
    if (!feature) {
      setPrompt(
        this.mode === "faces"
          ? "No faces selected — click one or more faces · Esc to cancel"
          : "No body selected — click a body · Esc to cancel",
      );
      return;
    }
    if (this.editId) {
      const id = this.editId;
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(id, feature);
    } else {
      this.store.setPreview(null);
      this.store.addFeature(feature);
    }
    const id = feature.id;
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
    if (!this.active) return;
    if (this.editId) this.store.endEditPreview();
    else this.store.setPreview(null);
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.previewDebounce) clearTimeout(this.previewDebounce);
    this.previewDebounce = 0;
    this.panel.hide();
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.editId = null;
    this.awaitingRollback = false;
    this.savedFaceSelectors = [];
    this.savedBodyId = null;
    this.lastFaceIds = [];
    this.lastBodyIds = [];
    this.rebuildLanded = false;
    // consumed members would dangle in the next tool's selection (same reason
    // Combine clears it after consuming the tool bodies) — clear both kinds.
    this.viewport.clearSelection();
    this.viewport.setSelectedBodies([]);
    this.active = false;
    setPrompt(null);
  }
}
