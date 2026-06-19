// Right inspector: the parameters table (edit a value -> rebuild, the whole
// parametric story) plus an editor for the selected feature's numeric fields.
// Numeric fields accept a literal OR a parameter name (per the document model).
//
// Geometry is stored in mm; length values are shown/typed in the user's display
// unit (params are treated as lengths). Angles stay in degrees.

import type { DocumentStore } from "../document/store";
import type { Feature, Num } from "../types";
import { FEATURE_META } from "./featureMeta";
import { getUnit, onUnitChange, toDisplay, fromDisplay, round, displayValue } from "./units";
import { resolveEntities, toSketchEntity } from "../sketch/resolve";
import { entityDims } from "../sketch/entityDims";

type FieldKind = "length" | "angle";
// editable numeric fields per feature type: [field, label, kind]
const NUM_FIELDS: Partial<Record<Feature["type"], [string, string, FieldKind][]>> = {
  extrude: [["distance", "Distance", "length"]],
  fillet: [["radius", "Radius", "length"]],
  chamfer: [["distance", "Length", "length"]],
  "press-pull": [["distance", "Distance", "length"]],
  revolve: [["angle", "Angle", "angle"]],
};

export class Inspector {
  private el: HTMLElement;
  private selectedId: string | null = null;

  constructor(container: HTMLElement, private store: DocumentStore) {
    this.el = container;
    store.onDocChange(() => this.render());
    onUnitChange(() => this.render());
  }

  select(id: string | null) {
    this.selectedId = id;
    this.render();
  }

  private render() {
    const doc = this.store.document;
    const unit = getUnit();
    this.el.innerHTML = "";

    // --- parameters (treated as lengths in mm) ---
    this.el.appendChild(title(`Parameters (${unit})`));
    for (const [name, value] of Object.entries(doc.parameters)) {
      this.el.appendChild(
        numberRow(name, round(toDisplay(value)), (v) =>
          this.store.setParam(name, fromDisplay(v)),
        ),
      );
    }

    // --- selected feature editor ---
    if (!this.selectedId) {
      const hint = document.createElement("div");
      hint.className = "empty-state";
      hint.textContent = "Select a feature in the timeline or browser to edit its values.";
      this.el.appendChild(hint);
      return;
    }
    const f = doc.features.find((x) => x.id === this.selectedId);
    if (!f) return;

    // sketch: editable per-entity dimensions (same descriptors as the in-canvas
    // labels). Editing entity i serializes just that entity back to numbers and
    // leaves the others (and their parameter references) untouched.
    if (f.type === "sketch") {
      this.el.appendChild(title(`Sketch · ${f.id}`, true));
      const resolved = resolveEntities(f, doc.parameters);
      resolved.forEach((e, i) => {
        for (const d of entityDims(e)) {
          this.el.appendChild(
            numberRow(`${d.label} ${unit}`, displayValue(d.valueMm), (v) => {
              const copy = resolveEntities(f, doc.parameters)[i];
              entityDims(copy).find((x) => x.field === d.field)?.write(fromDisplay(v));
              const entities = f.entities.map((ent, j) => (j === i ? toSketchEntity(copy) : ent));
              this.store.updateFeature(f.id, { entities } as Partial<Feature>);
            }),
          );
        }
      });
      return;
    }

    const fields = NUM_FIELDS[f.type];
    if (!fields) return;

    this.el.appendChild(title(`${FEATURE_META[f.type].label} · ${f.id}`, true));
    for (const [field, label, kind] of fields) {
      const cur = (f as any)[field] as Num | undefined;
      const suffix = kind === "angle" ? "°" : ` ${unit}`;
      // show converted number for literals; keep parameter-name strings as-is
      const shown =
        typeof cur === "number"
          ? String(kind === "angle" ? cur : round(toDisplay(cur)))
          : (cur ?? "");
      this.el.appendChild(
        textRow(`${label}${suffix}`, String(shown), (raw) => {
          const asNum = parseFloat(raw);
          const isNum = raw !== "" && !Number.isNaN(asNum) && String(asNum) === raw;
          const val: Num = isNum
            ? kind === "angle"
              ? asNum
              : fromDisplay(asNum)
            : raw; // a parameter name
          this.store.updateFeature(f.id, { [field]: val } as Partial<Feature>);
        }),
      );
    }
  }
}

function title(text: string, spaced = false): HTMLElement {
  const t = document.createElement("div");
  t.className = "panel-title";
  if (spaced) t.style.marginTop = "14px";
  t.textContent = text;
  return t;
}

function numberRow(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row";
  const lab = document.createElement("label");
  lab.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = String(value);
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) onChange(v);
  });
  row.append(lab, input);
  return row;
}

function textRow(label: string, value: string, onChange: (raw: string) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row";
  const lab = document.createElement("label");
  lab.textContent = label;
  const input = document.createElement("input");
  input.type = "text"; // text so a parameter name is allowed
  input.value = value;
  input.title = "number or parameter name";
  input.addEventListener("change", () => onChange(input.value.trim()));
  row.append(lab, input);
  return row;
}
