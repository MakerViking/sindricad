// Interactive Thread: click a cylindrical face — a hole wall or a shaft — pick
// a standard and size, and get a real modeled thread cut into it (ISO metric
// coarse/fine, UNC/UNF, or metric trapezoidal; see threadStandards.ts for the
// table). Docked tool panel, same dock as Extrude's.
//
// The face pick is the plan's deliberate exception to the single-face-pick
// convention everywhere else in this codebase (Shell, Draft, Offset Face,
// Thicken all store a raw by:"nearest" selector straight off the click). A
// thread's face selector is instead turned into a STORED by:"match"
// fingerprint via store.queryReferences — the same authorRef round trip
// Extrude uses for a picked edge or face — because the sidecar's query reply
// also carries the face's measured radius and whether it is a hole or a shaft
// (QueryResult.entities[].radius/external, read only for a face resolved onto
// a full cylinder). That lets this tool preselect the nearest matching
// standard from ONE round trip, with no separate "what kind of face is this"
// query first.
//
// Everything past the pick — standard, fit, clearance, length, handedness —
// lives in the panel, and previews through the real sidecar build
// (store.setPreview/setEditPreview): a thread can't be faked client-side.
//
// A picked face whose diameter does not match the chosen standard is not
// refused here. It is refused by the sidecar's own rebuild (_handle_thread's
// diameter-mismatch ValueError), surfaced through the ordinary rebuild-failure
// toast — which is also what "editing the hole diameter re-threads or refuses
// in words" means in practice: nothing in this file watches for that case.

import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Selector } from "../types";
import { setPrompt } from "../ui/prompt";
import { t } from "../i18n";
import { isImeComposing } from "../ui/focus";
import { ToolPanel, type PanelRow } from "../ui/toolPanel";
import { allThreadDesignations, FAMILY_LABEL, nearestThread } from "./threadStandards";

type Phase = "pick" | "edit";

interface ThreadValues {
  standard: string;
  fit: "exact" | "print";
  clearance: number;
  length: number | null; // null = the picked face's own full axial length
  leftHand: boolean;
}

const PREVIEW_DEBOUNCE_MS = 400;

const CLEARANCE_KEY = "sindricad.thread.clearance";
const DEFAULT_CLEARANCE = 0.15; // mm, split between the two mating flanks

/** The print-fit clearance the user last chose, remembered as an app
 *  preference across documents (not part of any one document) — same
 *  defensive shape as units.ts's own localStorage reads. */
function readStoredClearance(): number {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_CLEARANCE;
    const raw = localStorage.getItem(CLEARANCE_KEY);
    const v = raw != null ? Number(raw) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_CLEARANCE;
  } catch {
    return DEFAULT_CLEARANCE;
  }
}

function storeClearance(mm: number) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(CLEARANCE_KEY, String(mm));
  } catch {
    // best-effort preference; a document's own chosen clearance is what rebuilds
  }
}

// Grouped once: the panel's <optgroup>-by-family dropdown, built from the same
// table threadStandards.ts normalizes off thread_standards.json. Designations
// within a family are already listed in table order (threadStandards.ts),
// which keeps every same-family run contiguous — the condition optgroup
// rendering needs (toolPanel.ts: "consecutive options sharing a group").
const STANDARD_OPTIONS: { value: string; label: string; group?: string }[] = allThreadDesignations().map((rec) => ({
  value: rec.designation,
  label: rec.designation,
  group: FAMILY_LABEL[rec.family],
}));

export class ThreadTool {
  active = false;
  private phase: Phase = "pick";
  private panel = new ToolPanel();

  private featureId = "";
  private editingId: string | null = null;
  private face: Selector | null = null;
  private bodyId: string | null = null;
  private external = true;
  private values: ThreadValues | null = null;
  private previewTimer = 0;
  private pendingSeq = 0;
  private pending: { token: number } | null = null;

  private onDone: ((id: string | null) => void) | null = null;
  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundKey = (e) => this.onKey(e);
  }

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.editingId = null;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    window.addEventListener("keydown", this.boundKey, true);
    setPrompt(t("feature.thread.pickPrompt"));
  }

  /** Re-open an existing thread for editing. Returns false when `clearance` or
   *  `length` is parameter-bound — the inspector owns those (house pattern).
   *  No backend re-query here: the diameter-mismatch note is only ever shown
   *  at the moment of a fresh pick, never on re-opening a saved feature. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "thread") return false;
    for (const k of ["clearance", "length"] as const) {
      const val = (f as Record<string, unknown>)[k];
      if (typeof val === "string" || this.store.isParamBound({ kind: "feature", feature: featureId, field: k }))
        return false;
    }
    if (this.active) return false;
    this.active = true;
    this.phase = "edit";
    this.onDone = onDone;
    this.editingId = featureId;
    this.featureId = featureId;
    this.face = f.face;
    this.bodyId = f.body ?? null;
    this.external = true; // unused on the edit path (no match-note); kept defined
    this.viewport.suspendPicking = true;
    window.addEventListener("keydown", this.boundKey, true);
    this.store.beginEditPreview(featureId);
    this.openPanel({
      standard: f.standard,
      fit: f.fit ?? "exact",
      clearance: Number(f.clearance ?? readStoredClearance()),
      length: f.length != null ? Number(f.length) : null,
      leftHand: !!f.leftHand,
    });
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase !== "pick") return;
    const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = faceId != null ? "crosshair" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "pick") return;
    const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
    if (!hit) return; // missed the body — let the click orbit
    e.preventDefault();
    e.stopImmediatePropagation();
    this.viewport.domElement.style.cursor = "default";
    this.authorFace(hit);
  }

  /** Turn a raw click into a stored by:"match" face reference, and (when the
   *  face is a full cylinder) the measured diameter and hole/shaft sense that
   *  preselect a standard before the panel opens. A reply overtaken by a newer
   *  pick, a cancel, or a close is dropped (`token`), same as authorRef. */
  private authorFace(hit: { selector: Selector; bodyId: string | null }) {
    if (!hit.bodyId) {
      this.refusePick(t("feature.thread.ref.noBody"));
      return;
    }
    const item = { kind: "face" as const, body: hit.bodyId, sel: hit.selector };
    const ask = this.store.queryReferences([item], this.editingId);
    if (!ask) {
      this.refusePick(t("feature.thread.ref.unsupported"));
      return;
    }
    const token = ++this.pendingSeq;
    this.pending = { token };
    this.viewport.clearHover();
    setPrompt(t("feature.thread.panel.reading"));
    void ask.then((res) => {
      if (!this.active || this.pending?.token !== token) return;
      this.pending = null;
      const r = res[0];
      const ent = r?.ok ? r.entities[0] : undefined;
      if (!ent) {
        this.refusePick(r?.error ? t("feature.thread.ref.failed", { why: r.error }) : t("feature.thread.ref.noReply"));
        return;
      }
      if (ent.radius == null || ent.external == null) {
        this.refusePick(t("feature.thread.ref.notCylinder"));
        return;
      }
      this.face = { ...ent.sel, body: ent.body };
      this.bodyId = ent.body;
      this.external = ent.external;
      this.featureId = this.store.nextId();
      const diameterMm = ent.radius * 2;
      const nearest = nearestThread(diameterMm, this.external);
      this.phase = "edit";
      this.openPanel(
        { standard: nearest.designation, fit: "exact", clearance: readStoredClearance(), length: null, leftHand: false },
        this.matchNote(diameterMm, nearest),
      );
    });
  }

  /** The plan's own illustrative message: what was picked, what the nearest
   *  standard's relevant diameter is, and which it preselected. Said before
   *  OK, not as a refusal — the actual diameter-mismatch check is the
   *  sidecar's, raised at rebuild if the chosen standard turns out too far off. */
  private matchNote(diameterMm: number, rec: ReturnType<typeof nearestThread>): string {
    const standardD = this.external ? rec.majorDiameter : rec.minorDiameter;
    const diameter = diameterMm.toFixed(2);
    const standard = standardD.toFixed(2);
    const designation = rec.designation;
    return this.external
      ? t("feature.thread.matchShaft", { diameter, standard, designation })
      : t("feature.thread.matchHole", { diameter, standard, designation });
  }

  /** A pick that failed to resolve: say why, and stay in the pick phase so the
   *  next click can try again. */
  private refusePick(why: string) {
    this.pending = null;
    setPrompt(why);
  }

  private openPanel(initial: ThreadValues, note?: string) {
    this.values = initial;
    const rows: PanelRow[] = [
      { kind: "select", id: "standard", label: t("feature.thread.panel.standard"), options: STANDARD_OPTIONS },
      {
        kind: "choice", id: "fit", label: t("feature.thread.panel.fit"),
        options: [
          { value: "exact", label: t("feature.thread.panel.fitExact") },
          { value: "print", label: t("feature.thread.panel.fitPrint"), title: t("feature.thread.panel.fitPrintTitle") },
        ],
      },
      { kind: "number", id: "clearance", label: t("feature.thread.panel.clearance"), title: t("feature.thread.panel.clearanceTitle") },
      { kind: "number", id: "length", label: t("feature.thread.panel.length"), title: t("feature.thread.panel.lengthTitle") },
      {
        kind: "choice", id: "handedness", label: t("feature.thread.panel.handedness"),
        options: [
          { value: "right", label: t("feature.thread.panel.right") },
          { value: "left", label: t("feature.thread.panel.left") },
        ],
      },
    ];
    this.panel.show(this.editingId ? t("feature.thread.editTitle") : t("tool.thread"), rows, {
      onSelect: (id, v) => this.onPanelSelect(id, v),
      onChoice: (id, v) => this.onPanelChoice(id, v),
      onNumber: (id, v, raw) => this.onPanelNumber(id, v, raw),
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
    this.panel.setSelect("standard", initial.standard);
    this.panel.setChoice("fit", initial.fit);
    this.panel.setNumber("clearance", initial.clearance);
    this.panel.setVisible("clearance", initial.fit === "print");
    this.panel.setNumber("length", initial.length ?? "");
    this.panel.setChoice("handedness", initial.leftHand ? "left" : "right");
    setPrompt(note ?? null);
    this.updatePreview();
  }

  private onPanelSelect(id: string, v: string) {
    if (id !== "standard" || !this.values) return;
    this.values.standard = v;
    this.updatePreview();
  }

  private onPanelChoice(id: string, v: string) {
    if (!this.values) return;
    if (id === "fit") {
      this.values.fit = v === "print" ? "print" : "exact";
      this.panel.setVisible("clearance", this.values.fit === "print");
    } else if (id === "handedness") {
      this.values.leftHand = v === "left";
    } else {
      return;
    }
    this.updatePreview();
  }

  private onPanelNumber(id: string, v: number | null, raw: string) {
    if (!this.values) return;
    if (id === "clearance") {
      if (v === null && raw !== "") return; // the field shows red; OK refuses it
      this.values.clearance = v ?? 0;
    } else if (id === "length") {
      if (v === null && raw !== "") return;
      this.values.length = raw === "" ? null : v;
    } else {
      return;
    }
    this.updatePreview();
  }

  private buildFeature(v: ThreadValues): Feature {
    return {
      id: this.featureId,
      type: "thread",
      face: this.face!,
      standard: v.standard,
      // Omitted at their defaults, so a thread saved with the ordinary case
      // (exact fit, full-length, right-hand) stays byte-identical to how a
      // future reader would expect a minimal thread feature to look.
      ...(v.fit === "print" ? { fit: "print" as const, clearance: v.clearance } : {}),
      ...(v.length != null ? { length: v.length } : {}),
      ...(v.leftHand ? { leftHand: true } : {}),
      ...(this.bodyId ? { body: this.bodyId } : {}),
    };
  }

  private updatePreview() {
    window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      if (!this.active || !this.values || !this.face) return;
      const f = this.buildFeature(this.values);
      if (this.editingId) this.store.setEditPreview(f);
      else this.store.setPreview(f);
    }, PREVIEW_DEBOUNCE_MS);
  }

  private commit() {
    if (!this.values || !this.face) return;
    if (this.pending) {
      this.panel.setWarning(t("feature.thread.panel.reading"));
      return;
    }
    if (this.panel.numberUnreadable("clearance") || this.panel.numberUnreadable("length")) {
      this.panel.setWarning(t("feature.badNumber"));
      return;
    }
    window.clearTimeout(this.previewTimer);
    const feature = this.buildFeature(this.values);
    if (this.editingId) {
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(this.editingId, feature);
    } else {
      this.store.setPreview(null);
      this.store.addFeature(feature);
    }
    if (this.values.fit === "print") storeClearance(this.values.clearance);
    const id = feature.id;
    this.cleanup();
    this.onDone?.(id);
  }

  private onKey(e: KeyboardEvent) {
    if (isImeComposing(e)) return;
    if (this.panel.owns(e.target)) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
        return;
      }
      if (e.key === "Enter" && e.target !== this.panel.cancelButton) {
        e.preventDefault();
        e.stopPropagation();
        this.commit();
      }
      return;
    }
    if (e.key === "Escape") this.cancel();
  }

  cancel() {
    if (!this.active) return;
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    window.clearTimeout(this.previewTimer);
    this.pending = null;
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    this.viewport.clearHover();
    this.panel.hide();
    if (this.editingId) this.store.endEditPreview(true);
    else this.store.setPreview(null);
    this.viewport.suspendPicking = false;
    setPrompt(null);
    this.active = false;
    this.phase = "pick";
    this.editingId = null;
    this.values = null;
    this.face = null;
    this.bodyId = null;
  }
}
