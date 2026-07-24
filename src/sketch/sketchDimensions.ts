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
import { fmtLength, parseField, displayValue } from "../ui/units";

/** format a dim value for display: length in the display unit, angle in degrees;
 *  driven (reference) dims are wrapped in brackets. */
const fmtDim = (mm: number, kind?: "length" | "angle", driven?: boolean) => {
  const s = kind === "angle" ? `${displayValue(mm, "angle")}°` : fmtLength(mm);
  return driven ? `(${s})` : s;
};

interface DimLabel {
  el: HTMLDivElement;
  anchor: THREE.Vector2;
  valueMm: number;
  commit: (mm: number) => void; // writes the value (entity field or constraint)
  kind?: "length" | "angle"; // default length; angle → degrees, no unit scaling
  driven?: boolean; // reference dim: bracketed + read-only
  suppressEdit?: boolean; // pointerdown was forwarded to geometry underneath
}

/** an extra, non-entity label (e.g. a distance constraint's value) */
export interface ExtraDim {
  anchor: THREE.Vector2;
  valueMm: number; // degrees when kind==="angle"
  commit: (mm: number) => void;
  kind?: "length" | "angle";
  driven?: boolean;
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
        this.addLabel({ anchor: d.labelPos, valueMm: d.valueMm, commit: (mm) => this.onEdit(i, d.field, mm) });
      }
    });
    for (const x of extras) {
      this.addLabel({ anchor: x.anchor, valueMm: x.valueMm, commit: x.commit, ...(x.kind ? { kind: x.kind } : {}), ...(x.driven ? { driven: true } : {}) });
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
    el.className = d.driven ? "sketch-dim sketch-dim-driven" : "sketch-dim";
    el.textContent = fmtDim(d.valueMm, d.kind, d.driven);
    const label: DimLabel = { el, ...d };
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      label.suppressEdit = this.onOverlapPick?.(e) ?? false;
    });
    if (d.driven) {
      el.title = "Reference dimension (measured, not driving)";
    } else {
      el.title = "Click to edit";
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
    input.value = String(displayValue(label.valueMm, label.kind));
    label.el.textContent = "";
    label.el.appendChild(input);
    input.focus();
    input.select();
    const revert = () => { label.el.textContent = fmtDim(label.valueMm, label.kind); };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const val = parseField(input.value, label.kind ?? "length");
        // lengths must be positive; angles may be any finite (signed) value
        const ok = val != null && (label.kind === "angle" ? Number.isFinite(val) : val > 0);
        if (ok) label.commit(val);
        else revert();
      } else if (e.key === "Escape") revert();
    });
    input.addEventListener("blur", revert); // edit committed -> show() rebuilds anyway
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
