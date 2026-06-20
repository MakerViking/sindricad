// Central document state: the CadDocument (parameters + features), undo/redo,
// JSON load/save, and a debounced rebuild pipeline. The store owns the geometry
// client so any mutation re-runs the tree; results + errors are pushed to
// listeners (viewport, timeline, tree).

import type { CadDocument, Feature, RebuildResult, ViewCubeSide, ViewOverride } from "../types";
import type { GeometryBackend } from "../geometry/client";

export interface RebuildState {
  building: boolean;
  result: RebuildResult | null;
  errorFeatureId: string | null;
  errorMessage: string | null;
}

type DocListener = (doc: CadDocument) => void;
type BuildListener = (state: RebuildState) => void;
type MetaListener = () => void;

const clone = (d: CadDocument): CadDocument =>
  JSON.parse(JSON.stringify(d)) as CadDocument;

const EMPTY_DOCUMENT: CadDocument = { parameters: {}, features: [] };

/** .sindri file-format version (bump when the on-disk shape changes incompatibly). */
const FORMAT_VERSION = 1;

export class DocumentStore {
  private doc: CadDocument;
  private undoStack: CadDocument[] = [];
  private redoStack: CadDocument[] = [];
  private docListeners = new Set<DocListener>();
  private buildListeners = new Set<BuildListener>();
  private metaListeners = new Set<MetaListener>();
  private path: string | null = null; // current file path (null = unsaved)
  private isDirty = false; // unsaved changes since last save/open/new
  private rollback: number | null = null; // # of active features (null = all); timeline marker
  private suppressed = new Set<string>(); // feature ids skipped on rebuild (suppress)
  private sketchVis = new Map<string, boolean>(); // explicit per-sketch show/hide overrides
  private preview: Feature | null = null; // un-committed feature shown live (fillet/chamfer drag); never recorded in undo
  private rebuildTimer: number | null = null;
  private rebuilding = false; // a rebuild round-trip is in flight
  private rebuildQueued = false; // a newer rebuild was requested while one was in flight
  private build: RebuildState = {
    building: false,
    result: null,
    errorFeatureId: null,
    errorMessage: null,
  };

  constructor(
    private geometry: GeometryBackend,
    initial: CadDocument,
  ) {
    this.doc = clone(initial);
  }

  // --- access ---
  get document(): CadDocument {
    return this.doc;
  }
  get buildState(): RebuildState {
    return this.build;
  }

  onDocChange(fn: DocListener): () => void {
    this.docListeners.add(fn);
    fn(this.doc);
    return () => this.docListeners.delete(fn);
  }
  onBuild(fn: BuildListener): () => void {
    this.buildListeners.add(fn);
    fn(this.build);
    return () => this.buildListeners.delete(fn);
  }
  /** notified when the file path or dirty flag changes (for the titlebar). */
  onMeta(fn: MetaListener): () => void {
    this.metaListeners.add(fn);
    fn();
    return () => this.metaListeners.delete(fn);
  }

  // --- file identity ---
  get filePath(): string | null {
    return this.path;
  }
  get dirty(): boolean {
    return this.isDirty;
  }
  /** display name: the file's basename, or "Untitled". */
  get fileName(): string {
    if (!this.path) return "Untitled";
    return this.path.split(/[\\/]/).pop() || this.path;
  }
  /** mark the document as saved/opened at `path` (clears the dirty flag). */
  markSaved(path: string) {
    this.path = path;
    this.isDirty = false;
    this.emitMeta();
  }
  /** reset to a blank document (New). */
  newDocument() {
    this.undoStack = [];
    this.redoStack = [];
    this.doc = clone(EMPTY_DOCUMENT);
    this.rollback = null;
    this.suppressed.clear();
    this.sketchVis.clear();
    this.path = null;
    this.isDirty = false;
    this.emitDoc();
    this.emitMeta();
    this.scheduleRebuild(true);
  }

  private emitDoc() {
    for (const fn of this.docListeners) fn(this.doc);
  }
  private emitBuild() {
    for (const fn of this.buildListeners) fn(this.build);
  }
  private emitMeta() {
    for (const fn of this.metaListeners) fn();
  }
  private markDirty() {
    if (this.isDirty) return;
    this.isDirty = true;
    this.emitMeta();
  }

  // --- mutation (records undo, triggers rebuild) ---
  mutate(fn: (doc: CadDocument) => void, immediate = false) {
    this.undoStack.push(clone(this.doc));
    this.redoStack = [];
    fn(this.doc);
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(immediate);
  }

  setParam(name: string, value: number) {
    this.mutate((d) => {
      d.parameters[name] = value;
    });
  }

  addFeature(feature: Feature, atIndex?: number) {
    // new features land at the rollback marker (Fusion), which then advances past it
    const at = atIndex ?? this.rollbackIndex;
    if (this.rollback !== null && at <= this.rollback) this.rollback += 1;
    this.mutate((d) => {
      d.features.splice(at, 0, feature);
    }, true);
  }

  updateFeature(id: string, patch: Partial<Feature>) {
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = { ...d.features[i], ...patch } as Feature;
    });
  }

  replaceFeature(id: string, feature: Feature) {
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = feature;
    }, true);
  }

  /** next unused feature id (f1, f2, ...) */
  nextId(): string {
    const ids = new Set(this.doc.features.map((f) => f.id));
    let n = ids.size + 1;
    while (ids.has(`f${n}`)) n++;
    return `f${n}`;
  }

  removeFeature(id: string) {
    const idx = this.doc.features.findIndex((f) => f.id === id);
    if (this.rollback !== null && idx >= 0 && idx < this.rollback) this.rollback -= 1;
    this.suppressed.delete(id);
    this.mutate((d) => {
      d.features = d.features.filter((f) => f.id !== id);
    }, true);
  }

  // --- timeline: rollback marker, suppress, reorder ---
  /** number of features built (features[0..rollbackIndex-1] are active). */
  get rollbackIndex(): number {
    return this.rollback ?? this.doc.features.length;
  }
  isSuppressed(id: string): boolean {
    return this.suppressed.has(id);
  }
  /** roll the model back/forward to build only the first `i` features. */
  setRollback(i: number) {
    const n = this.doc.features.length;
    this.rollback = i >= n ? null : Math.max(0, i);
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  /** skip/unskip a feature on rebuild without deleting it. */
  toggleSuppress(id: string) {
    if (this.suppressed.has(id)) this.suppressed.delete(id);
    else this.suppressed.add(id);
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(true);
  }

  // --- live preview (un-committed feature, e.g. a fillet being dragged) ---
  /** Show `feature` appended to the built tree without recording undo or marking
   *  dirty. Pass null to clear it (reverts to the committed model). Rebuilds
   *  immediately and coalesces in-flight requests so a drag stays live (no
   *  debounce wait) without flooding OCCT. */
  setPreview(feature: Feature | null) {
    this.preview = feature;
    this.scheduleRebuild(true);
  }
  /** reorder: move feature `id` to position `toIndex` in the timeline. */
  moveFeature(id: string, toIndex: number) {
    this.mutate((d) => {
      const from = d.features.findIndex((f) => f.id === id);
      if (from < 0) return;
      const [f] = d.features.splice(from, 1);
      d.features.splice(Math.max(0, Math.min(d.features.length, toIndex)), 0, f);
    }, true);
  }

  // --- undo / redo ---
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(clone(this.doc));
    this.doc = prev;
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.doc));
    this.doc = next;
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  // --- ViewCube side redefinitions (don't affect geometry, so no rebuild) ---
  /** the current per-side overrides (live object on the document; treat as read-only). */
  get viewOverrides(): Partial<Record<ViewCubeSide, ViewOverride>> {
    return this.doc.viewOverrides ?? {};
  }
  /** redefine a cube side from a model face (null clears it). Records undo, marks
   *  dirty + emits doc-change so the titlebar and listeners update. No rebuild:
   *  overrides don't affect geometry (effectiveDoc ignores them). */
  setViewOverride(side: ViewCubeSide, override: ViewOverride | null) {
    this.undoStack.push(clone(this.doc));
    this.redoStack = [];
    if (override) {
      (this.doc.viewOverrides ??= {})[side] = override;
    } else if (this.doc.viewOverrides) {
      delete this.doc.viewOverrides[side];
      if (Object.keys(this.doc.viewOverrides).length === 0) delete this.doc.viewOverrides;
    }
    this.markDirty();
    this.emitDoc();
  }

  // --- sketch visibility overrides (explicit show/hide; no geometry effect) ---
  /** explicit show/hide override for a sketch, or undefined if the user hasn't set one. */
  sketchVisibilityOverride(id: string): boolean | undefined {
    return this.sketchVis.get(id);
  }
  /** set an explicit show/hide override for a sketch (persisted with the document). */
  setSketchVisibility(id: string, visible: boolean) {
    this.sketchVis.set(id, visible);
    this.markDirty();
  }

  // --- serialization ---
  toJSON(): string {
    // Persist the geometry doc PLUS the non-geometry project state that lives in
    // the store (suppress set, rollback marker, sketch visibility) so reopening
    // restores the full session. Empty state is omitted to keep files clean.
    const out: CadDocument = { ...this.doc, version: FORMAT_VERSION };
    if (this.suppressed.size) out.suppressed = [...this.suppressed];
    if (this.rollback !== null) out.rollback = this.rollback;
    if (this.sketchVis.size) out.sketchVisibility = Object.fromEntries(this.sketchVis);
    return JSON.stringify(out, null, 2);
  }
  load(json: string) {
    const parsed = JSON.parse(json) as CadDocument;
    this.undoStack.push(clone(this.doc));
    this.redoStack = [];
    // split persisted project state back out of the document; keep `this.doc`
    // pure geometry (+ viewOverrides) so undo/rebuild stay unaffected by it.
    this.suppressed = new Set(parsed.suppressed ?? []);
    this.rollback = parsed.rollback ?? null;
    this.sketchVis = new Map(Object.entries(parsed.sketchVisibility ?? {}));
    this.doc = {
      parameters: parsed.parameters ?? {},
      features: parsed.features ?? [],
      ...(parsed.viewOverrides ? { viewOverrides: parsed.viewOverrides } : {}),
    };
    this.markDirty(); // openDocument clears this via markSaved() once the path is known
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  loadDocument(doc: CadDocument) {
    this.load(JSON.stringify(doc));
  }

  // --- rebuild pipeline ---
  private scheduleRebuild(immediate: boolean) {
    if (this.rebuildTimer != null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    const run = () => {
      this.rebuildTimer = null;
      void this.rebuildNow();
    };
    if (immediate) run();
    else this.rebuildTimer = window.setTimeout(run, 120);
  }

  /** the document actually sent to build: features up to the rollback marker,
   *  minus suppressed ones. The full document is what we save/serialize. */
  private effectiveDoc(): CadDocument {
    const features = this.doc.features
      .slice(0, this.rollbackIndex)
      .filter((f) => !this.suppressed.has(f.id));
    if (this.preview) features.push(this.preview);
    return { parameters: this.doc.parameters, features };
  }

  async rebuildNow() {
    // Serialize rebuilds: if one is already in flight, just mark that another is
    // wanted. When the current one finishes it drains to the LATEST effectiveDoc.
    // This keeps live previews (fillet drag) responsive without overlapping or
    // out-of-order sidecar round-trips.
    if (this.rebuilding) {
      this.rebuildQueued = true;
      return;
    }
    this.rebuilding = true;
    try {
      do {
        this.rebuildQueued = false;
        this.build = { ...this.build, building: true };
        this.emitBuild();
        const reply = await this.geometry.rebuild(this.effectiveDoc());
        if (reply.ok) {
          this.build = {
            building: false,
            result: reply.result,
            errorFeatureId: null,
            errorMessage: null,
          };
        } else {
          this.build = {
            building: false,
            result: this.build.result, // keep last good mesh on screen
            errorFeatureId: reply.error.feature_id ?? null,
            errorMessage: reply.error.message,
          };
        }
        this.emitBuild();
      } while (this.rebuildQueued);
    } finally {
      this.rebuilding = false;
    }
  }
}
