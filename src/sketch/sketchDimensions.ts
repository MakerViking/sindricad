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
import { entityDims, type DimField } from "./entityDims";
import { fmtLength, parseField, displayValue, isPlainNumber } from "../ui/units";

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
}

/** an extra, non-entity label (e.g. a distance constraint's value) */
export interface ExtraDim {
  anchor: THREE.Vector2;
  valueMm: number; // degrees when kind==="angle"
  commit: (mm: number) => void;
  kind?: "length" | "angle";
  driven?: boolean;
  conflict?: boolean;
  over?: boolean;
  expr?: string;
  commitExpr?: (raw: string) => string | null;
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
    entities.forEach((e, i) => {
      for (const d of entityDims(e)) {
        const expr = this.entityExprOf?.(i, d.field);
        this.addLabel({
          anchor: d.labelPos,
          valueMm: d.valueMm,
          commit: (mm) => this.onEdit(i, d.field, mm),
          ...(this.onEditExpr ? { commitExpr: (raw: string) => this.onEditExpr!(i, d.field, raw) } : {}),
          ...(expr ? { expr } : {}),
        });
      }
    });
    for (const x of extras) {
      this.addLabel({ anchor: x.anchor, valueMm: x.valueMm, commit: x.commit, ...(x.kind ? { kind: x.kind } : {}), ...(x.driven ? { driven: true } : {}), ...(x.conflict ? { conflict: true } : {}), ...(x.over ? { over: true } : {}), ...(x.expr ? { expr: x.expr } : {}), ...(x.commitExpr ? { commitExpr: x.commitExpr } : {}) });
    }
    this.lastCamHash = ""; // force a reposition on the next frame
    if (!this.raf) this.loop();
  }

  hide() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.plane = null;
    this.clear();
  }

  /** Labels accept clicks only in the select tool. While a drawing or dimension
   *  tool is active they stay visible but pointer-transparent — a label floating
   *  over a circle's center must not swallow the pick underneath it. */
  setInteractive(on: boolean) {
    this.root.classList.toggle("dims-passive", !on);
  }

  private clear() {
    this.root.innerHTML = "";
    this.labels = [];
  }

  private addLabel(d: Omit<DimLabel, "el">) {
    const el = document.createElement("div");
    const fx = !!d.expr && !isPlainNumber(d.expr);
    const cls = ["sketch-dim"];
    if (d.driven) cls.push("sketch-dim-driven");
    if (fx) cls.push("sketch-dim-fx");
    if (d.conflict) cls.push("conflict");
    else if (d.over) cls.push("over");
    el.className = cls.join(" ");
    el.textContent = fmtDim(d.valueMm, d.kind, d.driven, fx);
    const label: DimLabel = { el, ...d };
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      label.suppressEdit = this.onOverlapPick?.(e) ?? false;
    });
    if (d.driven) {
      el.title = "Reference dimension (measured, not driving)";
    } else {
      el.title = fx ? `= ${d.expr} · click to edit` : "Click to edit";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (label.suppressEdit) {
          label.suppressEdit = false;
          return;
        }
        this.beginEdit(label);
      });
    }
    this.root.appendChild(el);
    this.labels.push(label);
  }

  private beginEdit(label: DimLabel) {
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
    input.addEventListener("input", () => input.classList.remove("input-error"));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
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
        // lengths must be positive; angles may be any finite (signed) value
        const ok = val != null && (label.kind === "angle" ? Number.isFinite(val) : val > 0);
        if (ok) label.commit(val);
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
