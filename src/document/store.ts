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
  // while building: the feature index the sidecar is currently executing
  // (-1 = tessellating), streamed ~1/s during long rebuilds; null otherwise
  progress: number | null;
}

type DocListener = (doc: CadDocument) => void;
type BuildListener = (state: RebuildState) => void;
type MetaListener = () => void;

const clone = (d: CadDocument): CadDocument =>
  JSON.parse(JSON.stringify(d)) as CadDocument;

const EMPTY_DOCUMENT: CadDocument = { parameters: {}, features: [] };

// Default filament palette (≤4 slots for the Snapmaker U1 toolchanger). Editable;
// bodies/faces reference a slot index so it maps 1:1 to a physical toolhead.
const DEFAULT_PALETTE: { name: string; color: string }[] = [
  { name: "White", color: "#e8e8e8" },
  { name: "Black", color: "#202020" },
  { name: "Red", color: "#d23b30" },
  { name: "Blue", color: "#3050c8" },
];

/** .sindri file-format version (bump when the on-disk shape changes incompatibly). */
const FORMAT_VERSION = 1;

/** A persisted display-only override map (id -> value): sketch/body/plane
 *  visibility, body names, and body colors all hand-rolled the same shape —
 *  a private Map plus a toJSON/load round-trip keyed by one CadDocument field.
 *  This only extracts that storage + serialization boilerplate; each overlay's
 *  markDirty/emit rules differ (some emit a build, some emit nothing at all —
 *  see the store methods below), so those setters stay bespoke on top. */
class Overlay<T> {
  private map = new Map<string, T>();
  constructor(private readonly jsonKey: string) {}
  get(id: string): T | undefined {
    return this.map.get(id);
  }
  set(id: string, value: T) {
    this.map.set(id, value);
  }
  delete(id: string) {
    this.map.delete(id);
  }
  clear() {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
  entries(): IterableIterator<[string, T]> {
    return this.map.entries();
  }
  /** append this overlay's toJSON branch onto `out`, iff non-empty. */
  writeJSON(out: Record<string, unknown>) {
    if (this.map.size) out[this.jsonKey] = Object.fromEntries(this.map);
  }
  /** rebuild the map from a parsed document's `[jsonKey]` field. */
  loadFrom(parsed: Record<string, unknown>, mapValue?: (v: unknown) => T) {
    const src = (parsed[this.jsonKey] as Record<string, unknown> | undefined) ?? {};
    this.map = new Map(Object.entries(src).map(([k, v]) => [k, mapValue ? mapValue(v) : (v as T)]));
  }
}

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
  private sketchVis = new Overlay<boolean>("sketchVisibility"); // explicit per-sketch show/hide overrides
  private bodyVis = new Overlay<boolean>("bodyVisibility"); // explicit per-body show/hide overrides (id → visible)
  private planeVis = new Overlay<boolean>("planeVisibility"); // explicit per-construction-plane show/hide overrides
  private bodyNames = new Overlay<string>("bodyNames"); // explicit per-body display-name overrides (id → name)
  private palette: { name: string; color: string; material?: string }[] = DEFAULT_PALETTE.map((s) => ({ ...s }));
  private bodyColors = new Overlay<number>("bodyColors"); // per-body palette-slot assignment (id → slot index)
  // static descriptor list driving toJSON/load below, in the exact on-disk key
  // order (palette piggybacks on bodyColors' condition, so isn't listed here).
  private readonly overlays: { overlay: Overlay<any>; mapValue?: (v: unknown) => any }[] = [
    { overlay: this.sketchVis },
    { overlay: this.bodyVis },
    { overlay: this.planeVis },
    { overlay: this.bodyNames },
    { overlay: this.bodyColors, mapValue: (v) => Number(v) },
  ];
  private preview: Feature | null = null; // un-committed feature shown live (fillet/chamfer drag); never recorded in undo
  private rebuildTimer: number | null = null;
  private rebuilding = false; // a rebuild round-trip is in flight
  private rebuildQueued = false; // a newer rebuild was requested while one was in flight
  private build: RebuildState = {
    building: false,
    result: null,
    errorFeatureId: null,
    errorMessage: null,
    progress: null,
  };

  constructor(
    private geometry: GeometryBackend,
    initial: CadDocument,
  ) {
    this.doc = clone(initial);
    // long-rebuild progress frames -> live "building 57/103" in the timeline
    geometry.onProgress?.((feature) => {
      if (!this.build.building) return;
      this.build = { ...this.build, progress: feature };
      this.emitBuild();
    });
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
    this.bodyVis.clear();
    this.planeVis.clear();
    this.bodyNames.clear();
    this.palette = DEFAULT_PALETTE.map((s) => ({ ...s }));
    this.bodyColors.clear();
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
  // Undo entries are FULL document clones (imports embed multi-MB BREPs), so an
  // uncapped stack grows without bound over a long session — cap it.
  private static readonly UNDO_CAP = 50;

  private pushUndo() {
    this.undoStack.push(clone(this.doc));
    if (this.undoStack.length > DocumentStore.UNDO_CAP) this.undoStack.shift();
  }

  mutate(fn: (doc: CadDocument) => void, immediate = false) {
    this.pushUndo();
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
    // new features land at the rollback marker (mainstream MCAD), which then advances past it
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
  /** true while an un-committed live-preview feature is appended to rebuilds
   *  (its transient failures must not toast). */
  get hasPreview(): boolean {
    return this.preview !== null || this.editPreview !== null;
  }

  // --- roll-to-position edit preview (re-opening a committed feature) ---
  /** While editing feature `id`, rebuilds see the timeline truncated to just
   *  BEFORE that feature plus the live edited version — the committed mesh has
   *  already consumed e.g. a fillet's member edges, so only the rolled-back
   *  model exposes them for highlighting/toggling. Later features are
   *  temporarily hidden for the duration of the edit (the tool's prompt says
   *  so). Never recorded in undo; commit goes through replaceFeature. */
  private editPreview: { id: string; feature: Feature | null } | null = null;
  beginEditPreview(id: string) {
    this.editPreview = { id, feature: null };
    this.scheduleRebuild(true);
  }
  setEditPreview(feature: Feature | null) {
    if (!this.editPreview) return;
    this.editPreview = { id: this.editPreview.id, feature };
    this.scheduleRebuild(true);
  }
  endEditPreview(rebuild = true) {
    if (!this.editPreview) return;
    this.editPreview = null;
    if (rebuild) this.scheduleRebuild(true);
  }
  get editPreviewId(): string | null {
    return this.editPreview?.id ?? null;
  }
  /** reorder: move feature `id` to position `toIndex` in the timeline. */
  moveFeature(id: string, toIndex: number) {
    this.mutate((d) => {
      const from = d.features.findIndex((f) => f.id === id);
      if (from < 0) return;
      const [f] = d.features.splice(from, 1);
      if (!f) return;
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
    this.pushUndo();
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
    this.pushUndo();
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

  // --- body visibility overrides (explicit show/hide; no geometry effect — just a
  // re-render that filters the hidden body's faces out of the mesh, MCAD-style) ---
  /** explicit show/hide override for a body, or undefined if unset. */
  bodyVisibilityOverride(id: string): boolean | undefined {
    return this.bodyVis.get(id);
  }
  /** true unless the user has hidden this body (bodies default to visible). */
  isBodyVisible(id: string): boolean {
    return this.bodyVis.get(id) ?? true;
  }
  /** show/hide a body; re-emits the build so the viewport re-renders (no rebuild). */
  setBodyVisibility(id: string, visible: boolean) {
    this.setBodiesVisibility(new Map([[id, visible]]));
  }

  /** Show/hide several bodies in one step (Isolate / Show all): apply every
   *  change, then re-emit ONCE — per-body emits would re-render the whole model
   *  N times (each emit runs setModel + the flush-seam pass). No-op entries are
   *  skipped; a call that changes nothing doesn't emit or dirty the document. */
  setBodiesVisibility(vis: Map<string, boolean>) {
    let changed = false;
    for (const [id, visible] of vis) {
      if ((this.bodyVis.get(id) ?? true) === visible) continue;
      this.bodyVis.set(id, visible);
      changed = true;
    }
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
    // With captured-visibility semantics (every extrude carries hiddenBodies),
    // an eye toggle is PURE DISPLAY — no rebuild. Only a legacy feature still
    // gated by the live map (loaded before stamping existed, in-memory) makes
    // visibility a geometry input worth a rebuild.
    const legacy = this.doc.features.some(
      (f) => f.type === "extrude" && !("hiddenBodies" in f),
    );
    if (legacy) this.scheduleRebuild(true);
  }

  /** Body ids currently hidden by the user — captured into new boolean
   *  features so later eye toggles can't rewrite what a cut touched. */
  hiddenBodyIds(): string[] {
    return [...this.bodyVis.entries()].filter(([, v]) => v === false).map(([k]) => k);
  }

  // --- construction-plane visibility overrides (display-only; datum planes are
  // synced to the viewport client-side, so a toggle just re-syncs the quads — no
  // rebuild and no emitBuild, the caller re-syncs the planes + refreshes the tree) ---
  /** true unless the user has hidden this construction plane (planes default to visible). */
  isPlaneVisible(id: string): boolean {
    return this.planeVis.get(id) ?? true;
  }
  /** show/hide a construction plane (persisted with the document). */
  setPlaneVisibility(id: string, visible: boolean) {
    this.planeVis.set(id, visible);
    this.markDirty();
  }

  // --- body name overrides (display-only; no geometry effect) -----------------
  /** display-name override for a body, or undefined (→ use the rebuilt name). */
  bodyName(id: string): string | undefined {
    return this.bodyNames.get(id);
  }
  /** rename a body (display-only override; blank clears it). Re-emits the build so
   *  the tree updates without a geometry rebuild — names don't affect geometry. */
  setBodyName(id: string, name: string) {
    const n = name.trim();
    if (n) this.bodyNames.set(id, n);
    else this.bodyNames.delete(id);
    this.markDirty();
    this.emitBuild();
  }
  /** delete a body by appending a removeBody feature at the END of the timeline
   *  (so it operates on the final body list). Undoable like any feature. */
  removeBody(bodyId: string) {
    const feat: Feature = { id: this.nextId(), type: "removeBody", bodies: [bodyId] };
    this.addFeature(feat, this.doc.features.length);
  }

  // --- color palette + per-body color (multi-color; display + export metadata) -
  /** the project's filament palette (≤4 slots map to U1 toolheads). */
  get colorPalette(): { name: string; color: string; material?: string }[] {
    return this.palette;
  }
  /** true when the palette is still the untouched default — lets the printer-sync
   *  UI skip its "overwrite?" confirmation when there's nothing to lose. */
  paletteIsDefault(): boolean {
    return (
      this.palette.length === DEFAULT_PALETTE.length &&
      this.palette.every((s, i) => {
        const d = DEFAULT_PALETTE[i];
        return d !== undefined && s.name === d.name && s.color === d.color && !s.material;
      })
    );
  }
  /** edit a palette slot's name and/or hex color; re-emits for a live repaint. */
  setPaletteSlot(i: number, patch: { name?: string; color?: string; material?: string }) {
    if (i < 0 || i >= this.palette.length) return;
    const cur = this.palette[i];
    if (!cur) return;
    this.palette[i] = { ...cur, ...patch };
    this.markDirty();
    this.emitBuild();
  }
  /** Replace slots from the printer's loaded filaments (name/color/material),
   *  by index, in ONE emit. Empty entries (undefined) leave that slot untouched
   *  — an unloaded toolhead shouldn't blank a slot. */
  applyFilamentSync(slots: ({ name: string; color: string; material?: string } | undefined)[]) {
    let changed = false;
    slots.forEach((s, i) => {
      if (!s || i >= this.palette.length) return;
      this.palette[i] = { ...this.palette[i], ...s };
      changed = true;
    });
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
  }
  /** the palette slot assigned to a body, or undefined (→ default shade). */
  bodyColorSlot(id: string): number | undefined {
    return this.bodyColors.get(id);
  }
  /** assign a body to a palette slot (null clears it); display-only re-emit. */
  setBodyColorSlot(id: string, slot: number | null) {
    if (slot == null) this.bodyColors.delete(id);
    else this.bodyColors.set(id, slot);
    this.markDirty();
    this.emitBuild();
  }
  /** body id → palette-slot index, as a plain object. For the colored-3MF export
   *  call, which must thread these side-maps explicitly (they never travel inside
   *  `document`). */
  bodyColorsMap(): Record<string, number> {
    return Object.fromEntries(this.bodyColors.entries());
  }
  /** body id → display-name override, as a plain object. Threaded through the
   *  export call so exported objects carry the sidebar names. */
  bodyNamesMap(): Record<string, string> {
    return Object.fromEntries(this.bodyNames.entries());
  }

  // --- serialization ---
  toJSON(): string {
    // Persist the geometry doc PLUS the non-geometry project state that lives in
    // the store (suppress set, rollback marker, sketch visibility) so reopening
    // restores the full session. Empty state is omitted to keep files clean.
    const out: CadDocument = { ...this.doc, version: FORMAT_VERSION };
    if (this.suppressed.size) out.suppressed = [...this.suppressed];
    if (this.rollback !== null) out.rollback = this.rollback;
    for (const { overlay } of this.overlays) overlay.writeJSON(out as unknown as Record<string, unknown>);
    if (this.bodyColors.size) out.palette = this.palette; // only meaningful alongside assignments
    return JSON.stringify(out, null, 2);
  }
  load(json: string) {
    let parsed: CadDocument;
    try {
      parsed = JSON.parse(json) as CadDocument;
    } catch (e) {
      throw new Error(`could not read document: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.pushUndo();
    this.redoStack = [];
    // split persisted project state back out of the document; keep `this.doc`
    // pure geometry (+ viewOverrides) so undo/rebuild stay unaffected by it.
    this.suppressed = new Set(parsed.suppressed ?? []);
    this.rollback = parsed.rollback ?? null;
    for (const { overlay, mapValue } of this.overlays) overlay.loadFrom(parsed as unknown as Record<string, unknown>, mapValue);
    this.palette = parsed.palette?.length ? parsed.palette.map((s) => ({ ...s })) : DEFAULT_PALETTE.map((s) => ({ ...s }));
    this.doc = {
      parameters: parsed.parameters ?? {},
      features: parsed.features ?? [],
      ...(parsed.viewOverrides ? { viewOverrides: parsed.viewOverrides } : {}),
    };
    // Migrate boolean features to captured-visibility semantics: an extrude
    // without `hiddenBodies` is gated by the LIVE eye states on every rebuild
    // (display retroactively rewriting geometry — the recurring red-features
    // trap). Stamping "nothing hidden" locks in the all-visible behavior every
    // saved document was verified against, and makes the file eye-proof.
    for (const f of this.doc.features) {
      if (f.type === "extrude" && !("hiddenBodies" in f)) {
        (f as { hiddenBodies?: string[] }).hiddenBodies = [];
      }
    }
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
    let features = this.doc.features
      .slice(0, this.rollbackIndex)
      .filter((f) => !this.suppressed.has(f.id));
    if (this.editPreview) {
      // roll to the edited feature's position (never past the rollback marker),
      // then append the live edited version if the tool has produced one.
      const idx = features.findIndex((f) => f.id === this.editPreview!.id);
      if (idx >= 0) features = features.slice(0, idx);
      if (this.editPreview.feature) features.push(this.editPreview.feature);
    }
    if (this.preview) features.push(this.preview);
    // Body visibility travels with the rebuild so the sidecar can keep hidden
    // bodies out of extrude booleans (a hidden body is protected from edits).
    const bodyVisibility = this.bodyVis.size ? Object.fromEntries(this.bodyVis.entries()) : undefined;
    return { parameters: this.doc.parameters, features, ...(bodyVisibility ? { bodyVisibility } : {}) };
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
        this.build = { ...this.build, building: true, progress: null };
        this.emitBuild();
        const reply = await this.geometry.rebuild(this.effectiveDoc());
        if (reply.ok) {
          // a partial build carries the failing feature inside the result —
          // render the surviving geometry AND surface the error
          const fe = reply.result.featureError;
          this.build = {
            building: false,
            result: reply.result,
            errorFeatureId: fe?.feature_id ?? null,
            errorMessage: fe?.message ?? null,
            progress: null,
          };
        } else {
          this.build = {
            building: false,
            result: this.build.result, // keep last good mesh on screen
            errorFeatureId: reply.error.feature_id ?? null,
            errorMessage: reply.error.message,
            progress: null,
          };
        }
        this.emitBuild();
      } while (this.rebuildQueued);
    } finally {
      this.rebuilding = false;
    }
  }

  /** MCAD-style "Compute All": bypass and rebuild EVERY cache layer (worker
   *  RAM prefix, mesh cache, this document's disk checkpoints) — the escape
   *  hatch when a cached result is suspected stale. Falls back to a plain
   *  immediate rebuild on backends without the op. */
  async computeAllNow() {
    const ca = this.geometry.computeAll?.bind(this.geometry);
    if (!ca) return this.scheduleRebuild(true);
    if (this.rebuilding) {
      this.rebuildQueued = true;
      return;
    }
    this.rebuilding = true;
    try {
      this.build = { ...this.build, building: true, progress: null };
      this.emitBuild();
      const reply = await ca(this.effectiveDoc());
      if (reply.ok) {
        const fe = reply.result.featureError;
        this.build = {
          building: false,
          result: reply.result,
          errorFeatureId: fe?.feature_id ?? null,
          errorMessage: fe?.message ?? null,
          progress: null,
        };
      } else {
        this.build = {
          building: false,
          result: this.build.result, // keep last good mesh on screen
          errorFeatureId: reply.error.feature_id ?? null,
          errorMessage: reply.error.message,
          progress: null,
        };
      }
      this.emitBuild();
    } finally {
      this.rebuilding = false;
    }
  }
}
