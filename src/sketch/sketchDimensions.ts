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
import type { SketchPlane } from "./plane";
import type { ResolvedEntity } from "./snap";
import { entityDims, type DimField } from "./entityDims";
import { fmtLength, parseField, displayValue } from "../ui/units";

interface DimLabel {
  el: HTMLDivElement;
  anchor: THREE.Vector2;
  index: number;
  field: DimField;
  valueMm: number;
}

export class SketchDimensions {
  private root: HTMLDivElement;
  private labels: DimLabel[] = [];
  private plane: SketchPlane | null = null;
  private raf = 0; // non-zero while the position loop is running
  private scratch = new THREE.Vector3();
  private lastCamHash = "";

  constructor(
    private viewport: Viewport,
    private onEdit: (index: number, field: DimField, mm: number) => void,
  ) {
    this.root = document.createElement("div");
    this.root.className = "sketch-dims";
    document.body.appendChild(this.root);
  }

  show(entities: ResolvedEntity[], plane: SketchPlane) {
    this.clear();
    this.plane = plane;
    entities.forEach((e, i) => {
      for (const d of entityDims(e)) {
        this.addLabel({ anchor: d.labelPos, index: i, field: d.field, valueMm: d.valueMm });
      }
    });
    this.lastCamHash = ""; // force a reposition on the next frame
    if (!this.raf) this.loop();
  }

  hide() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.plane = null;
    this.clear();
  }

  private clear() {
    this.root.innerHTML = "";
    this.labels = [];
  }

  private addLabel(d: Omit<DimLabel, "el">) {
    const el = document.createElement("div");
    el.className = "sketch-dim";
    el.textContent = fmtLength(d.valueMm);
    el.title = "Click to edit";
    const label: DimLabel = { el, ...d };
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      this.beginEdit(label);
    });
    this.root.appendChild(el);
    this.labels.push(label);
  }

  private beginEdit(label: DimLabel) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = String(displayValue(label.valueMm));
    label.el.textContent = "";
    label.el.appendChild(input);
    input.focus();
    input.select();
    const revert = () => { label.el.textContent = fmtLength(label.valueMm); };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const mm = parseField(input.value, "length");
        if (mm != null && mm > 0) this.onEdit(label.index, label.field, mm);
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

function camHash(cam: THREE.Camera): string {
  const p = cam.position;
  const q = cam.quaternion;
  return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`;
}
