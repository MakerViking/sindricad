// Central document state: the CadDocument (parameters + features), undo/redo,
// JSON load/save, and a debounced rebuild pipeline. The store owns the geometry
// client so any mutation re-runs the tree; results + errors are pushed to
// listeners (viewport, timeline, tree).

import type { CadDocument, Feature, ParamTarget, PlaneSpec, ProjectedSource, ProjectionUpdate, RebuildReply, RebuildResult, ViewCubeSide, ViewOverride } from "../types";
import { applyProjectionUpdate } from "../types";
import type { GeometryBackend, ProjectionResult } from "../geometry/client";
import { FORMAT_VERSION, migrateDocument } from "./migrate";
import * as params from "../params/engine";
import type { FieldKind } from "./numFields";
import { writeTarget } from "./numFields";

/** An expression typed on a sketch dimension while the sketch was OPEN — the
 *  dim isn't in the document until the sketch commits, so the binding travels
 *  with the commit (addFeature/replaceFeature) and lands in the same mutate. */
export interface SketchBinding {
  target: ParamTarget;
  expr: string;
  kind: FieldKind;
  /** Fusion's on-the-fly `name=expr`: bind under this chosen name instead of dN. */
  name?: string;
}

export interface RebuildState {
  building: boolean;
  result: RebuildResult | null;
  errorFeatureId: string | null;
  errorMessage: string | null;
  // while building: the feature index the sidecar is currently executing
  // (-1 = tessellating), streamed ~1/s during long rebuilds; null otherwise
  progress: number | null;
  /** During the meshing (payload) phase: bodies meshed so far and the total.
   *  Both null outside it. The feature index is -1 for that whole phase, so
   *  without these the chip has nothing to show a fraction from. */
  meshed: number | null;
  meshTotal: number | null;
  /** During a CHUNKED reply: bodies handed to the viewport so far, and the
   *  reply's total. Both null outside a stream.
   *
   *  `result` is still the PREVIOUS committed model while these are non-null.
   *  That is the whole safety property of progressive display: the partial
   *  geometry reaches the viewport on onBuildChunk and NOWHERE else, so no
   *  exporter, feature tree, or persisted document can ever observe a partial
   *  body list. */
  streamed: number | null;
  streamTotal: number | null;
}

/** One installment of a chunked reply on its way to the VIEWPORT.
 *
 *  The only legitimate subscriber is the viewport bridge in main.ts. Anything
 *  that reads document truth — export, the browser tree, a feature that bakes
 *  body ids into the document — must use onBuild, which never sees a partial. */
export interface BuildChunk {
  epoch: number;
  phase: "begin" | "bodies";
  /** the IN-PROGRESS result: only the bodies delivered so far hold real data */
  result: RebuildResult;
  manifest: NonNullable<RebuildResult["bodies"]>;
  bodies: NonNullable<RebuildResult["bodies"]>;
  edgesByBody: Map<string, RebuildResult["edges"]>;
  triRange: { triStart: number; triEnd: number };
  bbox: RebuildResult["bbox"];
  done: number;
  total: number;
}

/** A long non-rebuild operation the user can watch and stop (today: import).
 *  Deliberately NOT folded into RebuildState — an import is not a rebuild, and
 *  everything keyed on `building` (the timeline chip, the rebuild scheduler)
 *  would misread it. `id` is the sidecar request id, so a cancel targets THIS
 *  op rather than whatever ran most recently. */
export interface BusyState {
  active: boolean;
  label: string;
  id: string | null;
  /** 0-100 phase progress, or null when the backend reports none. Coarse by
   *  necessity: OCCT gives no sub-operation progress, so this advances a few
   *  times and creeps on elapsed time in between. */
  pct: number | null;
}

type DocListener = (doc: CadDocument) => void;
type BuildListener = (state: RebuildState) => void;
type BusyListener = (state: BusyState) => void;
type MetaListener = () => void;

// structuredClone beats the old JSON.parse(JSON.stringify()) round-trip on the
// multi-MB imported-BREP docs this runs on (undo snapshot + cascade draft are
// the two hot callers). Safe swap: docs are pure JSON data, and no mutator
// writes an explicit `undefined` onto a doc object (exactOptionalPropertyTypes
// forbids it), so the `"hiddenBodies" in f` gates see identical shapes.
const clone = (d: CadDocument): CadDocument => structuredClone(d);

const EMPTY_DOCUMENT: CadDocument = { parameters: {}, features: [] };

/** The features a sketch at a given timeline position may reference: everything
 *  up to the rollback marker, minus suppressed features — and, when EDITING an
 *  existing sketch, strictly before that sketch (a source created after it
 *  cannot exist yet when the sketch rebuilds). Pure so the Project tool's
 *  prefix-document rule is unit-testable; effectiveDoc() shares the base case. */
export function prefixFeatures(
  features: Feature[],
  rollbackIndex: number,
  suppressed: ReadonlySet<string>,
  beforeId: string | null = null,
): Feature[] {
  let out = features.slice(0, rollbackIndex);
  if (beforeId !== null) {
    const i = out.findIndex((f) => f.id === beforeId);
    if (i >= 0) out = out.slice(0, i);
  }
  return out.filter((f) => !suppressed.has(f.id));
}

// Default filament palette (≤4 slots for the Snapmaker U1 toolchanger). Editable;
// bodies/faces reference a slot index so it maps 1:1 to a physical toolhead.
const DEFAULT_PALETTE: { name: string; color: string }[] = [
  { name: "White", color: "#e8e8e8" },
  { name: "Black", color: "#202020" },
  { name: "Red", color: "#d23b30" },
  { name: "Blue", color: "#3050c8" },
];

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
  private busyListeners = new Set<BusyListener>();
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
  /** Bumped on every rebuild start. Chunk installments carry it so a late one
   *  from an abandoned reply can be recognised and dropped. */
  private buildEpoch = 0;
  private chunkListeners = new Set<(c: BuildChunk) => void>();
  private abortListeners = new Set<(epoch: number) => void>();
  private build: RebuildState = {
    building: false,
    result: null,
    errorFeatureId: null,
    errorMessage: null,
    streamed: null,
    streamTotal: null,
    progress: null,
    meshed: null,
    meshTotal: null,
  };

  private busy: BusyState = { active: false, label: "", id: null, pct: null };

  /** surfaced when the store hits something worth telling the user without
   *  failing (newer-version file on load, a dropped sketch binding, a param
   *  commit that failed mid-cascade). Wired to a toast in main.ts. */
  onWarning?: (msg: string) => void;

  constructor(
    private geometry: GeometryBackend,
    initial: CadDocument,
  ) {
    this.doc = clone(initial);
    migrateDocument(this.doc); // the seed doc skips load(); normalize it the same way
    // long-rebuild progress frames -> live "building 57/103" in the timeline
    geometry.onProgress?.((feature, meshed, meshTotal) => {
      if (!this.build.building) return;
      // -1/-1 means "not meshing"; keep those out of the state as null so the
      // chip can distinguish "no denominator" from "0 of N done".
      this.build = {
        ...this.build,
        progress: feature,
        meshed: meshed >= 0 ? meshed : null,
        meshTotal: meshTotal > 0 ? meshTotal : null,
      };
      this.emitBuild();
    });
    // installments of a chunked reply -> the viewport, and ONLY the viewport
    geometry.onRebuildChunk?.((c) => {
      if (!this.build.building) return;
      this.build = { ...this.build, streamed: c.done, streamTotal: c.total };
      this.emitBuild();
      const chunk: BuildChunk = { ...c, epoch: this.buildEpoch };
      for (const fn of this.chunkListeners) fn(chunk);
    });
    // coarse phase progress for a long non-rebuild op (import) -> the busy chip
    geometry.onOpProgress?.((pct, label) => {
      if (!this.busy.active) return;
      this.busy = { ...this.busy, pct, ...(label ? { label } : {}) };
      this.emitBusy();
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
  get busyState(): BusyState {
    return this.busy;
  }

  onBusy(fn: BusyListener): () => void {
    this.busyListeners.add(fn);
    fn(this.busy);
    return () => this.busyListeners.delete(fn);
  }

  /** Run a long cancellable backend op with busy state around it. `fn` receives
   *  an `onStarted` callback to hand back the request id — without it a cancel
   *  cannot name the right op, because the document stays editable during the
   *  op and any rebuild the user triggers meanwhile would claim to be "most
   *  recent". Busy state is always cleared, including on throw. */
  async runBusy<T>(label: string, fn: (onStarted: (id: string) => void) => Promise<T>): Promise<T> {
    this.busy = { active: true, label, id: null, pct: null };
    this.emitBusy();
    try {
      return await fn((id) => {
        this.busy = { ...this.busy, id };
        this.emitBusy();
      });
    } finally {
      this.busy = { active: false, label: "", id: null, pct: null };
      this.emitBusy();
    }
  }

  /** Stop the busy op, if any. Resolves to whether anything was stopped — false
   *  covers both "nothing running" and "the sidecar had already finished". */
  async cancelBusy(): Promise<boolean> {
    if (!this.busy.active) return false;
    // A rebuild never learns its request id — rebuild() takes no onStarted, so
    // runBusy's callback is never fired for it. Passing undefined lets the
    // client fall back to lastHeavyId, which is precisely the fallback it
    // documents for callers that never learned an id. Imports/exports still
    // pass their own id and are unaffected.
    return (await this.geometry.cancel?.(this.busy.id ?? undefined)) ?? false;
  }

  onBuild(fn: BuildListener): () => void {
    this.buildListeners.add(fn);
    fn(this.build);
    return () => this.buildListeners.delete(fn);
  }
  /** Installments of a chunked reply, for the VIEWPORT ONLY — see BuildChunk.
   *  Deliberately a separate channel from onBuild: every tool's onBuild handler
   *  is a one-shot on the `!building` edge (ghost seeding, selection reseeding,
   *  the new-failure toast diff), and firing those per chunk would seed against
   *  a model that is not there yet. Unlike onBuild this does NOT replay the
   *  current state to a new subscriber: there is nothing meaningful to replay. */
  onBuildChunk(fn: (c: BuildChunk) => void): () => void {
    this.chunkListeners.add(fn);
    return () => this.chunkListeners.delete(fn);
  }
  /** A chunked reply that will never finish (dropped connection, cancel, a
   *  malformed frame). The viewport must tear down whatever it has drawn. */
  onBuildAbort(fn: (epoch: number) => void): () => void {
    this.abortListeners.add(fn);
    return () => this.abortListeners.delete(fn);
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
    this.rearmProjectionValve(); // valve state must never cross documents
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
  private emitBusy() {
    for (const fn of this.busyListeners) fn(this.busy);
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
    // a user edit is the "edit the model to retry" the valve toast promises
    this.rearmProjectionValve();
    this.applyDerived(fn, immediate);
  }

  // --- parameters (engine-backed; see src/params/engine.ts) ---

  /** name → why its value is stale (cycle, unknown ref, non-finite, missing
   *  target) from the last recompute. Empty on a healthy document. */
  paramIssues: Record<string, string> = {};

  private applyRecompute(r: params.RecomputeResult) {
    this.paramIssues = r.issues;
  }

  /** Injected (main.ts): headless planegcs re-solve of one sketch feature —
   *  kept out of the store so the document layer doesn't depend on the WASM
   *  solver (and tests don't need it). */
  headlessSolve?: (sketch: Extract<Feature, { type: "sketch" }>, parameters: CadDocument["parameters"]) => Promise<{ entities: Extract<Feature, { type: "sketch" }>["entities"] } | null>;
  /** Injected: the sketch feature id currently OPEN in the sketch editor (it
   *  re-solves itself live and must not be overwritten headlessly). */
  openSketchId?: () => string | null;
  /** Fired after a value-changing parameter commit landed. Deliberately
   *  carries NO sketch set: the open sketch's pending (uncommitted) dim
   *  bindings can't appear in the draft's affected-set, so the consumer must
   *  rescan unconditionally — filtering here would be a bug. */
  onParamsApplied?: () => void;
  /** A closed sketch could not satisfy its dims after a param edit (conflict);
   *  its coordinates were left unchanged. */
  onParamSolveIssue?: (sketchId: string) => void;
  /** Injected (main.ts): deliver projection refresh entries for the OPEN sketch
   *  to the live session (SketchMode.syncProjectedCurves) — the doc copy of an
   *  open sketch is never written headlessly. */
  onProjectionsApplied?: (updates: ProjectionUpdate[]) => void;

  /** Value-changing parameter commits are serialized: each one recomputes on a
   *  DRAFT, headlessly re-solves the affected closed sketches, then lands
   *  everything (param edit + dim values + solved coordinates) in ONE mutate =
   *  one undo step = one rebuild. */
  private paramChain: Promise<void> = Promise.resolve();
  private queueParamCommit(fn: (d: CadDocument) => void) {
    this.paramChain = this.paramChain
      .then(() => this.commitWithCascade(fn))
      .catch((e) => {
        console.error("param commit failed:", e);
        this.onWarning?.("Parameter change failed to apply — see the console for details.");
      });
  }
  private async commitWithCascade(fn: (d: CadDocument) => void): Promise<void> {
    const draft = clone(this.doc);
    fn(draft);
    const r = params.recompute(draft);
    const open = this.openSketchId?.() ?? null;
    for (const sid of r.affectedSketches) {
      if (sid === open) continue;
      const f = draft.features.find((x): x is Extract<Feature, { type: "sketch" }> => x.type === "sketch" && x.id === sid);
      if (!f) continue;
      const solved = await this.solveConstrainedSketch(f, draft.parameters);
      if (solved) f.entities = solved;
    }
    this.mutate((d) => {
      d.parameters = draft.parameters;
      if (draft.paramDefs) d.paramDefs = draft.paramDefs;
      else delete d.paramDefs;
      d.features = draft.features;
    });
    this.onParamsApplied?.();
  }

  // --- associative projection refresh (plan step 4) ---
  // A rebuild whose result carries projectionUpdates means an upstream feature
  // moved geometry that projected entities are linked to. The updates land in
  // the document via a DERIVED commit (no undo entry — undo should revert the
  // user edit that caused the refresh, never the refresh itself), which
  // triggers one more rebuild; the sidecar only emits beyond-tolerance diffs,
  // so the steady state after an upstream edit is exactly 2 rebuilds.

  /** consecutive doc-changing refreshes we applied (incremented in
   *  commitProjectionRefresh — open-sketch-only deliveries don't count, their
   *  doc copy lags until finish() so the sidecar re-emits them every rebuild). */
  private projStreak = 0;
  private projValveOpen = true;

  /** Re-arm the oscillation valve. Every explicit user gesture that changes the
   *  model state (mutate/undo/redo/load/new/Compute All) earns a fresh refresh
   *  budget — this is the "edit the model or Compute All to retry" the valve
   *  toast promises; without it a tripped valve could never recover (withheld
   *  updates keep the cached curves != fresh, so a quiet rebuild is unreachable). */
  private rearmProjectionValve() {
    this.projStreak = 0;
    this.projValveOpen = true;
  }

  /** Refresh-loop entry (rebuildNow's ok-branch). Preview/edit-preview rebuilds
   *  see transient timelines — never commit from those, and never touch the
   *  streak either way (checked FIRST: an edit-preview truncated before the
   *  projected sketch yields a quiet rebuild that must not re-arm a tripped
   *  valve). The valve stops a float oscillation (a source flapping just past
   *  the 1e-4 tolerance) from rebuilding forever: after 5 consecutive applied
   *  refreshes, stop applying + warn once; a quiet rebuild or any user gesture
   *  (rearmProjectionValve) re-arms it. */
  private maybeQueueProjectionRefresh(updates: ProjectionUpdate[] | undefined) {
    if (this.hasPreview) return;
    if (!updates?.length) {
      this.rearmProjectionValve();
      return;
    }
    if (this.projStreak >= 5) {
      if (this.projValveOpen) {
        this.projValveOpen = false;
        this.onWarning?.("Projected geometry keeps changing on every rebuild — paused automatic refresh (edit the model or Compute All to retry).");
      }
      return;
    }
    this.queueProjectionRefresh(updates);
  }

  /** Chained on paramChain so refreshes and param commits serialize (both
   *  headless-solve sketches and land a whole-feature replacement). */
  private queueProjectionRefresh(updates: ProjectionUpdate[]) {
    this.paramChain = this.paramChain
      .then(() => this.commitProjectionRefresh(updates))
      .catch((e) => {
        console.error("projection refresh failed:", e);
        this.onWarning?.("Projected geometry failed to refresh — see the console for details.");
      });
  }

  private async commitProjectionRefresh(updates: ProjectionUpdate[]) {
    // Re-validate against the LIVE doc: the rebuild that produced these ran on
    // an older snapshot, so a sketch/entity may have been deleted since — drop
    // dangling entries rather than resurrecting them.
    const sketchOf = new Map<string, Extract<Feature, { type: "sketch" }>>();
    for (const f of this.doc.features) if (f.type === "sketch") sketchOf.set(f.id, f);
    const valid = updates.filter((u) => {
      const f = sketchOf.get(u.sketch);
      return !!f && f.entities.some((e) => e.type === "projected" && e.id === u.entity);
    });
    if (!valid.length) return;

    // stale transitions warn once per sketch (the sidecar only emits stale:true
    // on the not-stale -> stale transition, so every entry here is news)
    for (const sid of new Set(valid.filter((u) => u.stale).map((u) => u.sketch))) {
      const f = sketchOf.get(sid)!;
      this.onWarning?.(`Projected geometry in ${f.name ?? sid} lost its source — keeping last shape`);
    }

    const open = this.openSketchId?.() ?? null;
    const openUpdates = valid.filter((u) => u.sketch === open);
    const closedUpdates = valid.filter((u) => u.sketch !== open);
    // the OPEN sketch's doc copy is never written — the live session owns it
    // and persists the patched entities itself on finish()
    if (openUpdates.length) this.onProjectionsApplied?.(openUpdates);
    if (!closedUpdates.length) return;

    const bySketch = new Map<string, ProjectionUpdate[]>();
    for (const u of closedUpdates) {
      let list = bySketch.get(u.sketch);
      if (!list) bySketch.set(u.sketch, (list = []));
      list.push(u);
    }
    // Build every replacement feature BEFORE the single applyDerived — the
    // headless solve is async, and curves + solved coordinates must land
    // together (constrained user geometry follows the moved projections).
    const replacements = new Map<string, Extract<Feature, { type: "sketch" }>>();
    for (const [sid, list] of bySketch) {
      const f = sketchOf.get(sid)!;
      const byEntity = new Map(list.map((u) => [u.entity, u]));
      const entities = f.entities.map((e) => {
        if (e.type !== "projected" || e.id === undefined) return e;
        const u = byEntity.get(e.id);
        return u ? applyProjectionUpdate(e, u) : e;
      });
      let nf: Extract<Feature, { type: "sketch" }> = { ...f, entities };
      const solved = await this.solveConstrainedSketch(nf, this.doc.parameters);
      if (solved) nf = { ...nf, entities: solved };
      replacements.set(sid, nf);
    }
    // Drop sketches whose LIVE feature object changed while we awaited the
    // solves (plain mutate() is not serialized on paramChain — e.g. an entity
    // delete or SketchMode.finish() can land mid-solve): applying nf would
    // resurrect the pre-edit entities. Nothing is lost — that edit's rebuild
    // re-emits the diff against the new state.
    for (const sid of [...replacements.keys()]) {
      if (this.doc.features.find((x) => x.id === sid) !== sketchOf.get(sid)) replacements.delete(sid);
    }
    if (!replacements.size) return;
    this.projStreak++; // only doc-changing refreshes count toward the valve
    this.applyDerived((d) => {
      for (const [sid, nf] of replacements) {
        const i = d.features.findIndex((x) => x.id === sid);
        // REPLACE the feature object — the delta wire protocol diffs features
        // by reference, so an in-place patch would never ship to the sidecar.
        if (i >= 0) d.features[i] = nf;
      }
    });
  }

  /** Headless re-solve of one CONSTRAINED closed sketch — the param cascade and
   *  the projection refresh share these exact semantics (keep them in lockstep):
   *  returns the solved entities, or null when there was nothing to solve (a
   *  sketch with no constraints has nothing to satisfy — the value/curve
   *  write-back alone was the whole job) or the solve failed (surfaced via
   *  onParamSolveIssue; the caller keeps the coordinates unchanged). */
  private async solveConstrainedSketch(
    f: Extract<Feature, { type: "sketch" }>,
    parameters: CadDocument["parameters"],
  ): Promise<Extract<Feature, { type: "sketch" }>["entities"] | null> {
    if (!(f.constraints ?? []).length || !this.headlessSolve) return null;
    const solved = await this.headlessSolve(f, parameters);
    if (!solved) {
      this.onParamSolveIssue?.(f.id);
      return null;
    }
    return solved.entities;
  }

  /** The shared commit tail: apply `fn`, keep the parameter invariant (bound
   *  field number == cached param value) across EVERY document edit — this also
   *  GCs model params whose dim or feature was just deleted and refreshes the
   *  derived `parameters` cache — then dirty/emit/rebuild. mutate() prepends
   *  the undo entry + redo clear + valve re-arm; a DERIVED commit (projection
   *  refresh) calls this directly because machine-derived state must never
   *  occupy an undo step, and its immediate rebuild is what closes the refresh
   *  loop (steady state: a quiet rebuild). */
  private applyDerived(fn: (doc: CadDocument) => void, immediate = true) {
    fn(this.doc);
    if (this.doc.paramDefs) this.applyRecompute(params.recompute(this.doc));
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(immediate);
  }

  setParam(name: string, value: number) {
    void this.setParamExpr(name, String(value));
  }

  /** Set (or create) a parameter from an expression. Returns an error message
   *  to surface at the input, or null — the commit itself lands async via the
   *  cascade queue (validation is synchronous against the current document). */
  setParamExpr(name: string, expr: string, unit?: "mm" | "deg" | "count"): string | null {
    const v = params.validateExpr(this.doc, name, expr);
    if (!v.ok) return v.error;
    this.queueParamCommit((d) => params.commitParamExpr(d, name, expr, unit));
    return null;
  }

  /** Create a NEW user parameter (validates the name too). */
  addParam(name: string, expr: string, unit?: "mm" | "deg" | "count"): string | null {
    const bad = params.validateName(params.defsOf(this.doc), name);
    if (bad) return bad;
    return this.setParamExpr(name, expr, unit);
  }

  /** Classify raw dim expression input (incl. `name=expr`) for a (possibly
   *  not-yet-committed) binding without mutating anything — the sketch dim
   *  editor's pre-check. */
  classifyTargetExpr(boundName: string | null, pendingName: string | null, raw: string, kind: FieldKind): params.ExprInput {
    return params.classifyExprInput(this.doc, raw, kind, boundName, pendingName);
  }

  renameParam(from: string, to: string): string | null {
    const defs = params.defsOf(this.doc);
    if (!(from in defs)) return `no parameter "${from}"`;
    const bad = params.validateName(defs, to);
    if (bad) return bad;
    this.mutate((d) => void params.commitRenameParam(d, from, to));
    return null;
  }

  deleteParam(name: string): string | null {
    const blocked = params.deleteBlockers(this.doc, name);
    if (blocked) return blocked;
    this.mutate((d) => void params.commitDeleteParam(d, name));
    return null;
  }

  setParamComment(name: string, comment: string) {
    const def = params.defsOf(this.doc)[name];
    if (!def) return;
    this.mutate((d) => {
      const target = params.defsOf(d)[name];
      if (!target) return;
      if (comment) target.comment = comment;
      else delete target.comment;
    });
  }

  /** Commit raw user input into a parameter-drivable field as an EXPRESSION
   *  (canonical units — mm/deg; the edit surface converts plain display-unit
   *  numbers itself and uses setTargetValue). Supports Fusion's on-the-fly
   *  `name=expr` form, which names the field's model parameter. Returns an
   *  error or null. */
  setTargetExpr(target: ParamTarget, raw: string, kind: FieldKind): string | null {
    const bound = params.boundParam(this.doc, target);
    const c = params.classifyExprInput(this.doc, raw, kind, bound);
    if (!c.ok) return c.error;
    this.queueParamCommit((d) => {
      if (c.name) params.commitNamedFieldExpr(d, target, c.name, c.expr, kind);
      else params.commitFieldExpr(d, target, c.expr, kind);
    });
    return null;
  }

  /** Commit a plain CANONICAL number into a field. A bound field keeps its
   *  model param (the expression becomes the literal — Fusion behavior); an
   *  unbound field is written directly, no param is created. */
  setTargetValue(target: ParamTarget, canonical: number, kind: FieldKind): void {
    if (params.boundParam(this.doc, target)) {
      void this.setTargetExpr(target, String(canonical), kind);
    } else {
      this.mutate((d) => void writeTarget(d, target, canonical));
    }
  }

  /** The expression driving `target`, when a model param is bound to it. */
  boundExpr(target: ParamTarget): { name: string; expr: string; value: number } | null {
    const name = params.boundParam(this.doc, target);
    if (!name) return null;
    const def = params.defsOf(this.doc)[name]!;
    return { name, expr: def.expr, value: def.value };
  }

  /** True when `target` is driven by a non-literal expression (fx: fields —
   *  drag tools must not overwrite them). */
  isParamBound(target: ParamTarget): boolean {
    return params.isBound(this.doc, target);
  }

  /** Bindings recorded while a sketch was open (expression typed on a dim);
   *  applied in the SAME mutate as the feature commit so undo stays atomic.
   *  A binding that stopped validating (its param was deleted mid-edit) is
   *  dropped LOUDLY — the dim keeps its last value. */
  private applyBindings(d: CadDocument, bindings?: SketchBinding[]) {
    for (const b of bindings ?? []) {
      // re-validate against the final doc — the dim/entity now exists in it
      const bound = params.boundParam(d, b.target);
      const nameBad = b.name && b.name !== bound ? params.validateName(params.defsOf(d), b.name) : null;
      const v = params.validateExpr(d, bound, b.expr, b.kind);
      if (!v.ok || nameBad) {
        this.onWarning?.(`Dimension expression "${b.name ? `${b.name}=` : ""}${b.expr}" was dropped: ${nameBad ?? (v.ok ? "" : v.error)}`);
        continue;
      }
      if (b.name) params.commitNamedFieldExpr(d, b.target, b.name, b.expr, b.kind);
      else params.commitFieldExpr(d, b.target, b.expr, b.kind);
    }
  }

  addFeature(feature: Feature, atIndex?: number, bindings?: SketchBinding[]) {
    // new features land at the rollback marker (mainstream MCAD), which then advances past it
    const at = atIndex ?? this.rollbackIndex;
    if (this.rollback !== null && at <= this.rollback) this.rollback += 1;
    this.mutate((d) => {
      d.features.splice(at, 0, feature);
      this.applyBindings(d, bindings);
    }, true);
  }

  /** NOTE: a numeric field bound to a parameter is re-asserted by the recompute
   *  in mutate() — a patch that writes such a field simply won't stick. Route
   *  numeric edits through setTargetValue/setTargetExpr (drag-tool isBound
   *  guards land in the polish step of Tier 3.1). */
  updateFeature(id: string, patch: Partial<Feature>) {
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = { ...d.features[i], ...patch } as Feature;
    });
  }

  replaceFeature(id: string, feature: Feature, bindings?: SketchBinding[]) {
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = feature;
      this.applyBindings(d, bindings);
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
    this.rearmProjectionValve();
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.pushUndo();
    this.doc = next;
    this.rearmProjectionValve();
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
  /** The full persistable session as a plain object — everything toJSON()
   *  writes (geometry doc + suppress set, rollback, overlays, palette).
   *  Autosave embeds this directly in its envelope so the multi-MB document
   *  is stringified ONCE, not pretty-printed/re-parsed/re-stringified. */
  toObject(): CadDocument {
    // Persist the geometry doc PLUS the non-geometry project state that lives in
    // the store (suppress set, rollback marker, sketch visibility) so reopening
    // restores the full session. Empty state is omitted to keep files clean.
    const out: CadDocument = { ...this.doc, version: FORMAT_VERSION };
    if (this.suppressed.size) out.suppressed = [...this.suppressed];
    if (this.rollback !== null) out.rollback = this.rollback;
    for (const { overlay } of this.overlays) overlay.writeJSON(out as unknown as Record<string, unknown>);
    // Persist the palette whenever it carries information: body assignments
    // reference it, and a synced/customized palette is project state in its own
    // right (the "design in loaded colors" premise) even with zero assignments.
    if (this.bodyColors.size || !this.paletteIsDefault()) out.palette = this.palette;
    return out;
  }
  toJSON(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }
  load(json: string) {
    let parsed: CadDocument;
    try {
      parsed = JSON.parse(json) as CadDocument;
    } catch (e) {
      throw new Error(`could not read document: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const w of migrateDocument(parsed)) this.onWarning?.(w);
    this.pushUndo();
    this.redoStack = [];
    this.rearmProjectionValve(); // valve state must never cross documents
    // split persisted project state back out of the document; keep `this.doc`
    // pure geometry (+ viewOverrides) so undo/rebuild stay unaffected by it.
    this.suppressed = new Set(parsed.suppressed ?? []);
    this.rollback = parsed.rollback ?? null;
    for (const { overlay, mapValue } of this.overlays) overlay.loadFrom(parsed as unknown as Record<string, unknown>, mapValue);
    this.palette = parsed.palette?.length ? parsed.palette.map((s) => ({ ...s })) : DEFAULT_PALETTE.map((s) => ({ ...s }));
    this.doc = {
      parameters: parsed.parameters ?? {},
      ...(parsed.paramDefs ? { paramDefs: parsed.paramDefs } : {}),
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
    let features = prefixFeatures(this.doc.features, this.rollbackIndex, this.suppressed);
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

  /** Project 3D sources onto a sketch plane against the PREFIX document for the
   *  sketch being drawn: `editingId` = the open sketch's feature id when editing
   *  an existing sketch (sources must live strictly before it), null for a new
   *  sketch (which lands at the rollback marker, so everything up to it counts).
   *  Transport failure resolves to []. */
  projectGeometry(plane: PlaneSpec, sources: ProjectedSource[], editingId: string | null): Promise<ProjectionResult[]> {
    const doc: CadDocument = {
      parameters: this.doc.parameters,
      features: prefixFeatures(this.doc.features, this.rollbackIndex, this.suppressed, editingId),
    };
    return this.geometry.projectGeometry(doc, plane, sources);
  }

  /** Publish "a rebuild round-trip has started": keep whatever is on screen,
   *  clear every progress field so a stale fraction can't linger under the new
   *  build's label. */
  private emitBuildStarted() {
    // A new rebuild invalidates any stream still in flight for the old one.
    this.buildEpoch++;
    this.build = {
      ...this.build, building: true,
      progress: null, meshed: null, meshTotal: null, streamed: null, streamTotal: null,
    };
    this.emitBuild();
  }

  /** The state a FINISHED rebuild round-trip publishes. A partial build carries
   *  its failing feature inside the result, so the surviving geometry renders
   *  AND the error surfaces; an outright failure keeps the last good mesh on
   *  screen instead of blanking the viewport. Shared by rebuildNow and
   *  computeAllNow, which settle identically. */
  /** Tell the viewport to drop a partial model. Called when a build settles
   *  without the stream having completed — the reply failed, was cancelled, or
   *  came back by some path that never produced a final chunk. */
  private emitBuildAbort() {
    for (const fn of this.abortListeners) fn(this.buildEpoch);
  }

  private settledBuild(reply: RebuildReply): RebuildState {
    const done = {
      building: false, progress: null, meshed: null, meshTotal: null,
      streamed: null, streamTotal: null,
    };
    if (!reply.ok) {
      return {
        ...done,
        result: this.build.result,
        errorFeatureId: reply.error.feature_id ?? null,
        errorMessage: reply.error.message,
      };
    }
    const fe = reply.result.featureError;
    return {
      ...done,
      result: reply.result,
      errorFeatureId: fe?.feature_id ?? null,
      errorMessage: fe?.message ?? null,
    };
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
      // Wrap the whole drain in runBusy so a LONG rebuild gets the Cancel button
      // and busy label. Without this, busy.active stayed false for every rebuild
      // and timeline.ts — which gates both on it — offered no way to stop a build
      // that runs for minutes on a large assembly (measured 138.7 s on the
      // reference file). Short rebuilds are unaffected: the button only appears
      // after CANCEL_DELAY_MS (700 ms).
      await this.runBusy("Rebuilding", async () => {
        try {
          do {
            this.rebuildQueued = false;
            this.emitBuildStarted();
            const reply = await this.geometry.rebuild(this.effectiveDoc());
            // A stream that was in flight but never completed has left a PARTIAL
            // model on screen. Tell the viewport to drop it before this result —
            // which on a failure is the PREVIOUS document — renders over the top.
            if (this.build.streamed !== null && !reply.ok) this.emitBuildAbort();
            this.build = this.settledBuild(reply);
            this.emitBuild();
            // associative projection refresh: decide AFTER the result is published
            // (a queued commit lands via paramChain and triggers its own rebuild).
            // A FAILED rebuild says nothing about projections — it must neither
            // apply nor reset the streak, so only ok results reach the valve.
            if (reply.ok) this.maybeQueueProjectionRefresh(reply.result.projectionUpdates);
          } while (this.rebuildQueued);
        } finally {
          // Release the serialization flag HERE, not in the outer finally.
          // runBusy's teardown adds await points after this callback returns,
          // and a projection refresh chained on paramChain can run in that
          // window: it would see rebuilding === true, set rebuildQueued on a
          // loop that has already exited, and be dropped. That silently broke
          // the derived-commit refresh loop (2 rebuilds became 1).
          this.rebuilding = false;
        }
      });
    } finally {
      this.rebuilding = false; // belt and braces if runBusy throws before the callback
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
      this.emitBuildStarted();
      const reply = await ca(this.effectiveDoc());
      if (this.build.streamed !== null && !reply.ok) this.emitBuildAbort();
      this.build = this.settledBuild(reply);
      this.emitBuild();
      // Compute All is the explicit retry gesture the valve toast promises:
      // re-arm the valve and route the (freshly recomputed) projection updates
      // through the normal refresh path instead of dropping them.
      if (reply.ok) {
        this.rearmProjectionValve();
        this.maybeQueueProjectionRefresh(reply.result.projectionUpdates);
      }
    } finally {
      this.rebuilding = false;
    }
  }
}
