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
import { resolveEntities } from "../sketch/resolve";
import { entityDims } from "../sketch/entityDims";
import { FEATURE_NUM_FIELDS as NUM_FIELDS, hasUpToTarget } from "../document/numFields";
import type { FieldKind } from "../document/numFields";
import { icon } from "./icons";

/** Whether selecting this feature type actually opens an editor (numeric fields
 *  here, or the sketch editor). The context menu labels "Edit" honestly — a
 *  type without an editor gets "Select" instead. */
export function isInspectorEditable(type: Feature["type"]): boolean {
  return type === "sketch" || type in NUM_FIELDS;
}

/** What to say when an EDIT gesture (double-click a timeline chip, tree
 *  edit-feature) lands on the inspector rather than on an interactive tool.
 *  Keyed on the same predicate as the timeline's "double-click to edit" tooltip
 *  so the promise and the message cannot drift apart — a cylinder used to reach
 *  editFeature's bare `default:` arm and say nothing at all, which read as "the
 *  row is broken" (field report c8531ceb).
 *
 *  The not-editable wording stays NEUTRAL on purpose: "delete it and re-run the
 *  tool" is true for loft/sweep/combine/split/mirror/removeBody/deleteFace and
 *  false for `import`, which has no tool to re-run. */
export function editHint(type: Feature["type"]): string {
  const label = labelOf(type);
  return isInspectorEditable(type)
    ? `Edit ${label} values in the inspector (right panel)`
    : `${label} has no editable values in the inspector`;
}

/** Label for a feature type, tolerating a type this build does not know (a
 *  document written by a newer version): the timeline guards its own lookup the
 *  same way rather than throwing mid-render. */
function labelOf(type: Feature["type"]): string {
  return (FEATURE_META[type] as { label: string } | undefined)?.label ?? type;
}

export class Inspector {
  private el: HTMLElement;
  private selectedId: string | null = null;
  /** the FEATURE editor's own container (see render) — null until first render */
  private featureBox: HTMLElement | null = null;

  constructor(container: HTMLElement, private store: DocumentStore) {
    this.el = container;
    // async param commits can land mid-edit — same re-render guard as the
    // params dialog (keystrokeGuard)
    store.onDocChange(keystrokeGuard(container, () => this.render()));
    onUnitChange(() => this.render());
  }

  /** `focus` is passed ONLY by the edit gesture (double-click / edit-feature),
   *  never by plain selection — otherwise every click in the timeline would
   *  steal the caret out of whatever the user was typing in. */
  select(id: string | null, focus = false) {
    this.selectedId = id;
    this.render();
    if (focus) this.focusFeatureEditor();
  }

  /** Put the caret on the selected feature's first field, so the double-click
   *  delivers what the tooltip promises. Scoped to featureBox rather than the
   *  panel: the panel's first input is a global "Parameters (mm)" row, i.e.
   *  editing a cylinder would type into an unrelated parameter. A no-op when
   *  nothing is selected or the type has no fields (there is no input). */
  private focusFeatureEditor() {
    const box = this.featureBox;
    if (!box) return;
    box.scrollIntoView({ block: "nearest" });
    box.querySelector<HTMLInputElement>("input")?.focus();
  }

  private render() {
    const doc = this.store.document;
    const unit = getUnit();
    this.el.innerHTML = "";
    this.featureBox = null;

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

    // The feature's rows get their OWN container: focusFeatureEditor scopes its
    // input lookup to this box, so the edit gesture cannot land on a global
    // parameter row above.
    const box = document.createElement("div");
    this.featureBox = box;
    this.el.appendChild(box);

    // sketch: editable per-entity dimensions (same descriptors as the in-canvas
    // labels). The store applies the value with the SAME semantics as the canvas
    // editor — a length/diameter becomes a driving constraint and the sketch
    // re-solves — and owns the open-sketch case; this panel only reports the
    // gesture (field report 8b49c06e).
    if (f.type === "sketch") {
      box.appendChild(title(`Sketch · ${f.id}`, true));
      const resolved = resolveEntities(f, doc.parameters);
      resolved.forEach((e, i) => {
        for (const d of entityDims(e)) {
          box.appendChild(
            numberRow(`${d.label} ${unit}`, displayValue(d.valueMm), (v) => {
              this.store.setSketchDimension(f.id, i, d.field, fromDisplay(v));
            }),
          );
        }
      });
      return;
    }

    const fields = NUM_FIELDS[f.type];
    // A type with no numeric fields used to render NOTHING — a blank panel is
    // indistinguishable from a broken one, and the timeline still told the user
    // to double-click the row (field report c8531ceb). Name the feature and say
    // there is nothing to edit.
    box.appendChild(title(`${labelOf(f.type)} · ${f.id}`, true));
    if (!fields) {
      const hint = document.createElement("div");
      hint.className = "empty-state";
      hint.textContent = "No editable values on this feature.";
      box.appendChild(hint);
      return;
    }

    for (const [field, label, kind, applies] of fields) {
      // a row that doesn't apply to THIS feature's shape (press/pull's target
      // offset without an up-to target) is not rendered at all — an input the
      // sidecar ignores reads as "I typed a number and nothing happened".
      if (applies && !applies(f)) continue;
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
      box.appendChild(row);
    }

    // The up-to target is not a number, so it cannot live in FEATURE_NUM_FIELDS
    // with the rows above — and until this row existed nothing in the app could
    // delete one. An extrude or press/pull committed with "up to that face" was
    // aimed at it forever, which also meant Taper (hidden while a target exists)
    // was out of reach forever. GH #41.
    if (hasUpToTarget(f)) {
      const planeId = (f as { upToPlane?: string }).upToPlane;
      const target = planeId === undefined ? "Picked face" : planeLabel(this.store.document.features, planeId);
      box.appendChild(
        targetRow(target, () => {
          this.store.clearUpToTarget(f.id);
          this.render();
        }),
      );
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

/** The name the browser tree shows for an up-to plane: "XY plane" for an origin
 *  plane, a datum's own name (a rename wins) or "PlaneN" by its position among
 *  the datums, and the raw id only if nothing in the document matches — a
 *  deleted datum must never make the inspector throw mid-render. */
function planeLabel(features: readonly Feature[], id: string): string {
  if (id === "XY" || id === "XZ" || id === "YZ") return `${id} plane`;
  const datums = features.filter((f) => f.type === "datumPlane");
  const i = datums.findIndex((f) => f.id === id);
  if (i < 0) return id;
  return (datums[i] as { name?: string }).name || `Plane${i + 1}`;
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

/** The "Up to" row: what this feature is aimed at, and the only control that
 *  un-aims it. Read-only text rather than an input — the value is a datum id or
 *  a picked face, neither of which can be typed. The row keeps the panel's
 *  two-column grid: the name and the button share the second column, which
 *  `.param-row-target` widens for them. Without that the fixed 84px input track
 *  left 58px for the text, and "Picked face" needs 68.5px — measured, the
 *  button wrapped onto a second line under the name and the row rendered 38px
 *  tall against its neighbours' 29px. */
function targetRow(value: string, onClear: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row param-row-target";
  const lab = document.createElement("label");
  lab.textContent = "Up to";
  const cell = document.createElement("span");
  cell.className = "param-target";
  const name = document.createElement("span");
  name.textContent = value;
  name.title = value;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "params-del";
  clear.title = "Clear the up-to target and extrude by distance instead";
  // icon-only control: the accessible name has to come from the button itself
  clear.setAttribute("aria-label", "Clear the up-to target");
  clear.innerHTML = icon("close");
  clear.addEventListener("click", onClear);
  cell.append(name, clear);
  row.append(lab, cell);
  return row;
}
