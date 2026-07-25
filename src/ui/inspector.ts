// Right inspector: the parameters table (edit a value -> rebuild, the whole
// parametric story) plus an editor for the selected feature's numeric fields.
// Numeric fields accept a literal OR a parameter name (per the document model).
//
// Geometry is stored in mm; length values are shown/typed in the user's display
// unit (params are treated as lengths). Angles stay in degrees.

import type { DocumentStore } from "../document/store";
import type { Feature, Num, ParamTarget } from "../types";
import { FEATURE_META } from "./featureMeta";
import { getUnit, onUnitChange, toDisplay, round, displayValue, isPlainNumber, parseField, fromDisplay } from "./units";
import { validatedInput, keystrokeGuard } from "./liveInputs";
import { resolveEntities, toSketchEntity } from "../sketch/resolve";
import { entityDims } from "../sketch/entityDims";
import { FEATURE_NUM_FIELDS as NUM_FIELDS } from "../document/numFields";
import type { FieldKind } from "../document/numFields";

/** Whether selecting this feature type actually opens an editor (numeric fields
 *  here, or the sketch editor). The context menu labels "Edit" honestly — a
 *  type without an editor gets "Select" instead. */
export function isInspectorEditable(type: Feature["type"]): boolean {
  return type === "sketch" || type in NUM_FIELDS;
}

export class Inspector {
  private el: HTMLElement;
  private selectedId: string | null = null;

  constructor(container: HTMLElement, private store: DocumentStore) {
    this.el = container;
    // async param commits can land mid-edit — same re-render guard as the
    // params dialog (keystrokeGuard)
    store.onDocChange(keystrokeGuard(container, () => this.render()));
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

    // --- parameters (user params only; model params dN live in the dialog) ---
    this.el.appendChild(title(`Parameters (${unit})`));
    const defs = doc.paramDefs ?? {};
    for (const [name, value] of Object.entries(doc.parameters)) {
      if (defs[name]?.target) continue; // model param — edited via its field/dim
      const issue = this.store.paramIssues[name];
      const row = numberRow(name, round(toDisplay(value)), (v) =>
        this.store.setParam(name, fromDisplay(v)),
      );
      if (issue) {
        row.classList.add("param-stale");
        row.title = issue;
      }
      this.el.appendChild(row);
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
              if (!copy) return;
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
      const target: ParamTarget = { kind: "feature", feature: f.id, field };
      const bound = this.store.boundExpr(target);
      const suffix = kind === "length" ? ` ${unit}` : kind === "angle" ? "°" : "";
      // a bound field edits its EXPRESSION (canonical units); a plain field
      // shows its number in display units (lengths convert, angles/counts raw)
      const shown = bound
        ? bound.expr
        : typeof cur === "number"
          ? String(kind === "length" ? round(toDisplay(cur)) : cur)
          : (cur ?? "");
      const row = textRow(`${label}${suffix}`, String(shown), (raw) => {
        const err = this.commitField(target, kind, raw);
        if (!err) this.render(); // re-read: fx badge, computed value, canonical rounding
        return err;
      });
      if (bound && this.store.isParamBound(target)) {
        row.classList.add("fx-row");
        row.title = `${bound.name} = ${bound.expr} = ${round(bound.value)}`;
      }
      this.el.appendChild(row);
    }
  }

  /** Route raw field input: plain number → display-unit value write (keeps a
   *  bound field's model param as a literal); anything else → expression in
   *  CANONICAL units (mm/deg) via the params engine. Deliberate semantics fork
   *  (plan decision R4): bare literals in expressions are canonical so the same
   *  file evaluates identically on every machine — unit suffixes (0.5 in) are
   *  the display-unit spelling inside expressions. */
  private commitField(target: ParamTarget, kind: FieldKind, raw: string): string | null {
    if (isPlainNumber(raw)) {
      this.store.setTargetValue(target, parseField(raw, kind)!, kind);
      return null;
    }
    return this.store.setTargetExpr(target, raw, kind);
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

function textRow(label: string, value: string, commit: (raw: string) => string | null): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row";
  const lab = document.createElement("label");
  lab.textContent = label;
  // text input so an expression / parameter name is allowed
  const input = validatedInput(value, commit, "number, parameter name, or expression (e.g. width/2 + 5)");
  row.append(lab, input);
  return row;
}
