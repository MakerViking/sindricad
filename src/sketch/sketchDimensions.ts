// Persistent, editable dimension annotations shown on committed sketch geometry
// while in the sketch environment (MCAD-style). Each label is a DOM element
// projected onto the geometry; click it to type a new value (in the current
// display unit) and the entity updates. This is the "edit the length later"
// half of the workflow — the live W/H boxes handle it during creation.
//
// The dimension set (which fields an entity has, where each label sits, the
// value) comes from entityDims() so there's one source of truth shared with the
// inspector and SketchMode.editDimension.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { camHash } from "../viewport/camHash";
import type { SketchPlane } from "./plane";
import type { ResolvedEntity } from "./snap";
import { entityDims, staggeredDefaults, type DimField, type ConstraintDim } from "./entityDims";
import { isOriginGeometry } from "./origin";
import { fmtLength, parseField, displayValue, isPlainNumber, dimValueOk } from "../ui/units";

/** format a dim value for display: length in the display unit, angle in degrees;
 *  driven (reference) dims are wrapped in brackets, param-driven get fx:. */
const fmtDim = (mm: number, kind?: "length" | "angle", driven?: boolean, fx?: boolean) => {
  const s = kind === "angle" ? `${displayValue(mm, "angle")}°` : fmtLength(mm);
  return driven ? `(${s})` : fx ? `fx: ${s}` : s;
};

interface DimLabel {
  el: HTMLDivElement;
  anchor: THREE.Vector2;
  valueMm: number;
  commit: (mm: number) => void; // writes the value (entity field or constraint)
  kind?: "length" | "angle"; // default length; angle → degrees, no unit scaling
  driven?: boolean; // reference dim: bracketed + read-only
  conflict?: boolean; // solver flagged it inconsistent (red)
  over?: boolean; // solver flagged it redundant / over-defining (amber)
  suppressEdit?: boolean; // pointerdown was forwarded to geometry underneath
  /** the driving expression when this dim is parameter-bound — editing reopens
   *  it, the label renders `fx: <value>` when it's not a plain literal */
  expr?: string;
  /** expression-capable commit: gets the RAW input (number or formula) and
   *  returns an error to show, or null. Formulas — and any edit on an
   *  already-bound dim — route through this; a plain number on an unbound dim
   *  keeps the legacy numeric `commit` (non-bindable fields reject formulas). */
  commitExpr?: (raw: string) => string | null;
  /** The label's current offset from its dimension's natural anchor, in sketch
   *  mm — the basis a drag adds its cursor delta to (see EntityDim.place).
   *  Present together with `placeCommit` on every draggable label. */
  place?: THREE.Vector2;
  /** Persist a dragged placement (sketch mm). `done` = the drag ended, so the
   *  host may rebuild everything; while false it must keep this label's DOM
   *  alive. Returns the dim's recomputed label anchor — the label follows THAT,
   *  not the raw cursor, so a dim that only moves perpendicular (or radially)
   *  never jumps on release. */
  placeCommit?: (ox: number, oy: number, done: boolean) => THREE.Vector2 | null;
  /** Remove the constraint this label drives. Present ONLY on constraint-backed
   *  dims: an entity dim (a rectangle's width) is an intrinsic property of the
   *  entity with no constraint to delete, so its label offers the action
   *  disabled rather than not at all. */
  onDelete?: () => void;
  /** This badge's value COULD be governed by a driving constraint and isn't —
   *  it is a live measurement of the geometry. Renders muted so a measured ⌀
   *  and a driving ⌀ stop being pixel-identical (report fd7dcc5f). Still
   *  editable: typing a value is what creates the driving constraint. */
  measured?: boolean;
  /** This dim's value is SIGNED (the smart tool's DX/DY: the sign says which
   *  side), so the editor must take a negative back — see units.dimValueOk.
   *  Absent on every other dim, which are magnitudes. */
  signed?: boolean;
}

/** an extra, non-entity label (e.g. a distance constraint's value); valueMm
 *  is degrees when kind === "angle" */
export type ExtraDim = Omit<DimLabel, "el" | "suppressEdit">;

/** What a rendered constraint dim hands its badge, straight from constraintDims'
 *  output. One function rather than a spread at the call site so a field that
 *  changes how the badge BEHAVES reaches it by being added to ConstraintDim: the
 *  `signed` flag arrived that way, and a DX badge that displays "-30 mm" while
 *  its editor still refuses "-30" is exactly the failure a forgotten forward
 *  looks like. The caller adds the behaviour (commit, delete, drag). */
export function dimBadgeFields(d: ConstraintDim): Pick<ExtraDim, "anchor" | "valueMm" | "kind" | "driven" | "signed"> {
  return {
    anchor: d.labelPos,
    valueMm: d.valueMm,
    ...(d.kind ? { kind: d.kind } : {}),
    ...(d.driven ? { driven: true } : {}),
    ...(d.signed ? { signed: true } : {}),
  };
}

export class SketchDimensions {
  private root: HTMLDivElement;
  private labels: DimLabel[] = [];
  private plane: SketchPlane | null = null;
  private raf = 0; // non-zero while the position loop is running
  private scratch = new THREE.Vector3();
  private lastCamHash = "";
  /** Geometry-beats-label: a badge can sit ON the entity it labels (low zoom),
   *  and since it's a DOM element above the canvas it would swallow the click
   *  meant to SELECT that entity. The owner installs this hook; return true =
   *  "geometry under the cursor claimed the click" — the label then skips its
   *  value-edit for that click. */
  onOverlapPick: ((e: PointerEvent) => boolean) | null = null;
  /** Screen px → sketch-plane mm. The owner installs it (SketchMode's own
   *  unsnapped cursor→plane routine), so a label drag converts through the REAL
   *  plane — no guessed scale factor, and correct on an XZ/YZ/datum plane whose
   *  +Y need not run the same way as the screen's. Without it, labels aren't
   *  draggable. */
  onPlanePoint: ((clientX: number, clientY: number) => THREE.Vector2 | null) | null = null;
  /** Persist a dragged ENTITY badge placement (rect W/H, circle diameter,
   *  polygon radius, slot L/W, line length) — those have no backing constraint,
   *  so their placement lives on the entity. Same contract as
   *  DimLabel.placeCommit; `index` indexes the array passed to show(). */
  onEntityPlace:
    | ((index: number, field: DimField, ox: number, oy: number, done: boolean) => THREE.Vector2 | null)
    | null = null;
  /** Right-click on a label. The owner renders the menu (this class owns no menu
   *  UI); `del` is the label's delete action, or null when the label is an entity
   *  dim and there is nothing to delete. */
  onLabelMenu: ((e: MouseEvent, del: (() => void) | null) => void) | null = null;
  /** The driving constraint behind an ENTITY dim, resolved by the owner against
   *  the live constraint list. Three answers, because the badge has three
   *  states:
   *    a function → a driving constraint governs this field; the badge deletes
   *                 it (report ad6f8d54: a line's length and a circle's
   *                 diameter render through the entity badge, which offered no
   *                 delete at all, so those two dims were unremovable)
   *    "free"     → the field CAN be governed and nothing governs it: the badge
   *                 is a measurement, and renders as one
   *    null       → the field is intrinsic (a rectangle's width): no constraint
   *                 exists for it either way. */
  onEntityConstraint: ((index: number, field: DimField) => (() => void) | "free" | null) | null = null;

  /** The label the Delete key acts on. Set by a click or a right-click, dropped
   *  on the next rebuild — a selection whose element no longer exists must not
   *  keep a stale delete armed. */
  private selectedLabel: DimLabel | null = null;

  /** in-flight label drag; `moved` flips once the cursor passes the click
   *  threshold, and only then does a release count as a placement */
  private drag: {
    label: DimLabel;
    startClient: { x: number; y: number };
    from: THREE.Vector2; // grab point on the plane, in sketch mm
    base: THREE.Vector2; // the label's placement when the drag started
    last: THREE.Vector2 | null; // the last placement that resolved on the plane
    moved: boolean;
  } | null = null;
  /** a drag's release must not also open the value editor (the browser still
   *  fires `click` after `pointerup`). Cleared on the next pointerdown, so a
   *  normal click on any label right after a drag still edits. */
  private suppressClick = false;

  constructor(
    private viewport: Viewport,
    private onEdit: (index: number, field: DimField, mm: number) => void,
    /** expression-capable entity-dim commit (raw input → error | null); when
     *  set, entity labels accept formulas too. */
    private onEditExpr?: (index: number, field: DimField, raw: string) => string | null,
    /** the driving expression for an entity dim, when parameter-bound. */
    private entityExprOf?: (index: number, field: DimField) => string | undefined,
  ) {
    this.root = document.createElement("div");
    this.root.className = "sketch-dims";
    document.body.appendChild(this.root);
  }

  show(entities: ResolvedEntity[], plane: SketchPlane, extras: ExtraDim[] = []) {
    this.clear();
    this.plane = plane;
    // neighbour-aware default placements (concentric circles fan their diameter
    // badges out instead of stacking) — the same call dimensionSegments makes,
    // so a label and its own annotation lines never disagree
    const defaults = staggeredDefaults(entities);
    entities.forEach((e, i) => {
      // The origin carries no dimensions. Its axes are conceptually INFINITE and
      // their 20 m length is an implementation stand-in, so labelling it put two
      // "20000 mm" badges over the origin of every sketch. dimensionSegments
      // already skips these (via its construction filter); this is the other
      // half of the same rule.
      if (isOriginGeometry(e.id)) return;
      for (const d of entityDims(e, defaults.get(e.id))) {
        const expr = this.entityExprOf?.(i, d.field);
        const field = d.field;
        const backing = this.onEntityConstraint?.(i, field) ?? null;
        this.addLabel({
          anchor: d.labelPos,
          valueMm: d.valueMm,
          commit: (mm) => this.onEdit(i, field, mm),
          place: d.place,
          placeCommit: (ox, oy, done) => this.onEntityPlace?.(i, field, ox, oy, done) ?? null,
          ...(this.onEditExpr ? { commitExpr: (raw: string) => this.onEditExpr!(i, field, raw) } : {}),
          ...(expr ? { expr } : {}),
          ...(typeof backing === "function" ? { onDelete: backing } : {}),
          ...(backing === "free" ? { measured: true } : {}),
        });
      }
    });
    for (const x of extras) this.addLabel(x);
    this.lastCamHash = ""; // force a reposition on the next frame
    if (!this.raf) this.loop();
  }

  hide() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.plane = null;
    this.clear();
  }

  /** Labels accept clicks in the select AND dimension tools. While a DRAWING tool
   *  is active they stay visible but pointer-transparent — a label floating over a
   *  circle's center must not swallow the pick underneath it. The dimension tool
   *  is live despite that same risk because it re-arms after every commit, so
   *  labels were unreachable for as long as anyone was dimensioning; SketchMode's
   *  labelOverlapDimension arbitrates, giving the tool any click that lands on
   *  geometry or that belongs to a part-placed dimension. */
  setInteractive(on: boolean) {
    this.root.classList.toggle("dims-passive", !on);
  }

  private clear() {
    this.selectedLabel = null;
    // a rebuild destroys the element a drag is riding on — drop the drag so its
    // (now orphaned) move/up handlers can't write a placement afterwards
    this.drag = null;
    this.root.innerHTML = "";
    this.labels = [];
  }

  private addLabel(d: Omit<DimLabel, "el">) {
    const el = document.createElement("div");
    const fx = !!d.expr && !isPlainNumber(d.expr);
    const cls = ["sketch-dim"];
    if (d.driven) cls.push("sketch-dim-driven");
    if (d.measured) cls.push("sketch-dim-measured");
    if (fx) cls.push("sketch-dim-fx");
    if (d.conflict) cls.push("conflict");
    else if (d.over) cls.push("over");
    el.className = cls.join(" ");
    el.textContent = fmtDim(d.valueMm, d.kind, d.driven, fx);
    const label: DimLabel = { el, ...d };
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      // Primary button only. A badge sits ON the geometry it labels (a line's
      // length badge lands at the midpoint, exactly where a user aims to
      // right-click that line), and onOverlapPick REPLACES the selection with
      // the single entity under the cursor — so an unguarded right press ate a
      // two-entity selection before its constraint menu was ever built, and
      // rebuilt the badge out from under its own contextmenu handler. A
      // secondary press selects nothing, starts no drag, and leaves this
      // element alive for the contextmenu below; middle-drag stays camera pan.
      if (e.button !== 0) return;
      this.suppressClick = false;
      label.suppressEdit = this.onOverlapPick?.(e) ?? false;
      // onOverlapPick rebuilds every label when geometry claims the pick, so
      // `el` may already be detached — never start a drag on top of that.
      if (label.suppressEdit) return;
      this.selectLabel(label);
      this.beginDrag(label, e);
    });
    // Right-click is the discoverable half of deleting a dimension; the Delete
    // key below is the shortcut. A dimensional constraint has no constraint
    // glyph (glyphs.ts deliberately skips them, since they already draw as
    // dimension badges), so without these two there is no way to remove one
    // short of deleting the geometry under it. Reported 2026-08-02.
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.selectLabel(label);
      this.onLabelMenu?.(e, label.onDelete ? () => label.onDelete!() : null);
    });
    if (d.driven) {
      el.title = "Reference dimension (measured, not driving)";
    } else {
      el.title = fx ? `= ${d.expr} · click to edit`
        : d.measured ? "Measured — click to set a driving dimension, drag to move"
        : "Click to edit, drag to move";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (label.suppressEdit || this.suppressClick) {
          label.suppressEdit = false;
          this.suppressClick = false;
          return;
        }
        this.beginEdit(label);
      });
      // Escape hatch. A label that floats over its own geometry loses every
      // single click to the pick underneath (onOverlapPick), which would leave
      // it permanently uneditable — and in the dimension tool an in-progress
      // dimension claims clicks too. A double-click is unambiguous, so it edits
      // regardless of who won the singles.
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        label.suppressEdit = false;
        this.suppressClick = false;
        this.beginEdit(label);
      });
    }
    // a driven (reference) label is read-only but still placeable — its drag
    // handlers live on pointerdown above, which runs for both kinds
    this.root.appendChild(el);
    this.labels.push(label);
  }

  // --- label drag (placement) ---------------------------------------------
  // A label is a click target first: under DRAG_PX of movement the release must
  // still open the value editor, exactly as before this existed. Past it, the
  // label follows the cursor and the release freezes the placement. Matches the
  // 4 px / `dragMoved` idiom SketchMode's body-drag and moveDrag already use.
  private static readonly DRAG_PX = 4;

  private beginDrag(label: DimLabel, e: PointerEvent) {
    if (!label.placeCommit || !label.place || !this.onPlanePoint) return;
    const from = this.onPlanePoint(e.clientX, e.clientY);
    if (!from) return; // cursor ray misses the sketch plane (grazing view)
    this.drag = { label, startClient: { x: e.clientX, y: e.clientY }, from, base: label.place.clone(), last: null, moved: false };
    label.el.setPointerCapture(e.pointerId);
    label.el.addEventListener("pointermove", this.onDragMove);
    label.el.addEventListener("pointerup", this.onDragEnd);
    label.el.addEventListener("pointercancel", this.onDragEnd);
  }

  /** the drag's placement at the current cursor: the grab-time placement plus
   *  the cursor delta measured ON THE SKETCH PLANE (never in screen px) */
  private placeAt(clientX: number, clientY: number): THREE.Vector2 | null {
    const d = this.drag;
    const now = d && this.onPlanePoint?.(clientX, clientY);
    if (!d || !now) return null;
    return d.base.clone().add(now).sub(d.from);
  }

  private onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!d.moved) {
      const dx = e.clientX - d.startClient.x, dy = e.clientY - d.startClient.y;
      if (dx * dx + dy * dy < SketchDimensions.DRAG_PX ** 2) return; // still a click
      d.moved = true;
    }
    e.stopPropagation();
    const p = this.placeAt(e.clientX, e.clientY);
    if (!p) return;
    d.last = p;
    // the host re-lays-out the dim and hands back where its label really goes —
    // a perpendicular-only or radial-only dim tracks the cursor's useful
    // component and ignores the rest, with no jump when the drag ends
    const anchor = d.label.placeCommit!(p.x, p.y, false);
    if (anchor) {
      d.label.anchor.copy(anchor);
      this.lastCamHash = ""; // the camera didn't move; force the reposition pass
    }
  };

  private onDragEnd = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    this.endDrag(d.label, e.pointerId);
    if (!d.moved) return; // a plain click: leave it to the click handler
    e.stopPropagation();
    this.suppressClick = true; // the click that follows this release is not an edit
    // a release whose cursor misses the plane (grazing view) falls back to the
    // last placement that did resolve, so the final rebuild still happens and
    // the labels can't be left showing a half-finished drag
    const p = this.placeAt(e.clientX, e.clientY) ?? d.last;
    if (p) d.label.placeCommit!(p.x, p.y, true);
  };

  private endDrag(label: DimLabel, pointerId: number) {
    this.drag = null;
    label.el.removeEventListener("pointermove", this.onDragMove);
    label.el.removeEventListener("pointerup", this.onDragEnd);
    label.el.removeEventListener("pointercancel", this.onDragEnd);
    if (label.el.hasPointerCapture(pointerId)) label.el.releasePointerCapture(pointerId);
  }

  /** Mark the label the Delete key will remove, and show it as selected. */
  private selectLabel(label: DimLabel) {
    if (this.selectedLabel === label) return;
    this.selectedLabel?.el.classList.remove("is-selected");
    this.selectedLabel = label;
    label.el.classList.add("is-selected");
  }

  /** Drop the selection (the owner calls this when the click landed elsewhere). */
  clearSelection() {
    this.selectedLabel?.el.classList.remove("is-selected");
    this.selectedLabel = null;
  }

  /** Delete the selected dimension. Returns false when nothing is selected, or
   *  when the selected label is an entity dim with no constraint behind it, so
   *  the caller can fall through to its own Delete handling. */
  deleteSelected(): boolean {
    const del = this.selectedLabel?.onDelete;
    if (!del) return false;
    this.clearSelection();
    del();
    return true;
  }

  private beginEdit(label: DimLabel) {
    if (label.el.querySelector("input")) return; // already editing — a dblclick
    const input = document.createElement("input");
    input.type = "text";
    // a param-driven dim reopens its EXPRESSION (Fusion behavior); a plain dim
    // opens its value in display units
    const fx = !!label.expr && !isPlainNumber(label.expr);
    input.value = fx ? label.expr! : String(displayValue(label.valueMm, label.kind));
    label.el.textContent = "";
    label.el.appendChild(input);
    input.focus();
    input.select();
    const revert = () => { label.el.textContent = fmtDim(label.valueMm, label.kind, label.driven, fx); };
    // Nothing typed since focus AND the whole value still selected the way
    // select() left it, so a Delete would wipe the text anyway — which is what
    // makes it free to mean "delete this dimension" instead. Report ad6f8d54:
    // "trying to delete a dimension... nothing happens" — a left-click opens
    // this editor and focuses it, so the Delete that follows lands on an
    // editable target, SketchMode.onKey bails, and all the key did was clear
    // the (fully selected) input text.
    //
    // The selection half is not decoration: a user who clicks a caret into the
    // open editor fires no `input` event, and Backspace there means the
    // character before the caret. Deleting their dimension instead destroys
    // work they never put at risk.
    let pristine = true;
    const untouched = () =>
      pristine && input.selectionStart === 0 && input.selectionEnd === input.value.length;
    input.addEventListener("input", () => {
      pristine = false;
      input.classList.remove("input-error");
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (untouched() && (e.key === "Delete" || e.key === "Backspace") && label.onDelete) {
        e.preventDefault();
        label.onDelete();
        return;
      }
      if (e.key === "Enter") {
        const raw = input.value.trim();
        if (label.commitExpr && (!isPlainNumber(raw) || label.expr !== undefined)) {
          // formulas — and any edit to an already-bound dim — go through the
          // expression path so the binding stays consistent
          const err = label.commitExpr(raw);
          if (err) {
            input.classList.add("input-error");
            input.title = err;
          }
          return; // success: refreshActive() rebuilds the labels
        }
        const val = parseField(raw, label.kind ?? "length");
        // lengths are magnitudes and must be positive; angles may be any finite
        // (signed) value; a signed distance may be either way round but not zero
        if (dimValueOk(val, label.kind ?? "length", label.signed)) label.commit(val);
        else revert();
      } else if (e.key === "Escape") revert();
    });
    input.addEventListener("blur", () => {
      // edit committed -> show() rebuilds anyway; keep a rejected expression
      // visible only while focused
      if (!input.classList.contains("input-error")) revert();
    });
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.plane) return;
    // skip the per-label projection + DOM writes when the camera hasn't moved
    const cam = this.viewport.camera;
    const hash = camHash(cam);
    if (hash === this.lastCamHash) return;
    this.lastCamHash = hash;
    for (const l of this.labels) {
      this.plane.to3D(l.anchor.x, l.anchor.y, this.scratch);
      const s = this.viewport.projectToScreen(this.scratch);
      l.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
    }
  };
}
