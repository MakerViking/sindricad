// Modify → Parameters: the Change Parameters dialog. User parameters (add /
// rename / re-express / comment / delete-with-named-blockers) and model
// parameters (dN — expression + target readout, renamable). Values are shown
// in display units for lengths; EXPRESSIONS are always canonical (mm / deg) —
// same rule as every other expression surface.

import type { DocumentStore } from "../document/store";
import { icon } from "./icons";
import type { CadDocument, ParamDef, ParamTarget, ParamUnit } from "../types";
import { FloatingPanel } from "./panels";
import { FEATURE_META } from "./featureMeta";
import { getUnit, toDisplay, round } from "./units";
import { validatedInput, keystrokeGuard } from "./liveInputs";
import { t, setText, setTitle } from "../i18n";
import { esc } from "./escape";

const panel = new FloatingPanel();
let unsubscribe: (() => void) | null = null;

export function openParamsDialog(store: DocumentStore): void {
  const el = panel.open(`<div class="measure-title" data-i18n="params.title">${esc(t("params.title"))}</div><div class="params-body"></div>`, {
    closeOnEsc: true,
    onClose: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
  el.classList.add("params-dialog");
  render(store, el);
  // live refresh (async commits landing, undo, load) — but never clobber an
  // edit in progress (keystrokeGuard).
  unsubscribe = store.onDocChange(keystrokeGuard(el, () => render(store, el)));
}

function render(store: DocumentStore, el: HTMLDivElement): void {
  const body = el.querySelector(".params-body")!;
  body.innerHTML = "";
  const doc = store.document;
  const defs = doc.paramDefs ?? {};
  const entries = Object.entries(defs);
  const user = entries.filter(([, d]) => !d.target);
  const model = entries.filter(([, d]) => d.target);

  body.appendChild(sectionTitle("params.userSection"));
  body.appendChild(headerRow());
  for (const [name, def] of user) body.appendChild(paramRow(store, doc, name, def));
  body.appendChild(addRow(store));

  if (model.length) {
    body.appendChild(sectionTitle("params.modelSection"));
    body.appendChild(headerRow());
    for (const [name, def] of model) body.appendChild(paramRow(store, doc, name, def));
  }

  const hint = document.createElement("div");
  hint.className = "measure-hint";
  setText(hint, "params.hint");
  body.appendChild(hint);
}

function sectionTitle(key: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "params-section";
  setText(el, key);
  return el;
}

function headerRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "params-row params-head";
  for (const key of ["params.header.name", "params.header.expression", "params.header.value", "params.header.comment", null]) {
    const c = document.createElement("span");
    if (key) setText(c, key);
    row.appendChild(c);
  }
  return row;
}

function paramRow(store: DocumentStore, doc: CadDocument, name: string, def: ParamDef): HTMLElement {
  const row = document.createElement("div");
  row.className = "params-row";
  const issue = store.paramIssues[name];
  if (issue) {
    row.classList.add("param-stale");
    row.title = issue;
  }

  row.appendChild(validatedInput(name, (raw) => (raw === name ? null : store.renameParam(name, raw))));
  row.appendChild(validatedInput(def.expr, (raw) => store.setParamExpr(name, raw)));

  const value = document.createElement("span");
  value.className = "params-value";
  value.textContent = formatValue(def);
  row.appendChild(value);

  if (def.target) {
    const drives = document.createElement("span");
    drives.className = "params-drives";
    drives.textContent = targetLabel(doc, def.target);
    drives.title = drives.textContent;
    row.appendChild(drives);
    row.appendChild(document.createElement("span")); // no delete: dN dies with its target
  } else {
    row.appendChild(validatedInput(def.comment ?? "", (raw) => (store.setParamComment(name, raw), null)));
    const del = document.createElement("button");
    del.className = "params-del";
    del.setAttribute("aria-label", t("params.deleteParam", { name }));
    del.innerHTML = icon("close");
    setTitle(del, "params.deleteParam", { name });
    del.addEventListener("click", () => {
      const err = store.deleteParam(name);
      if (err) {
        del.title = err;
        del.classList.add("input-error");
      }
    });
    row.appendChild(del);
  }
  return row;
}

function addRow(store: DocumentStore): HTMLElement {
  const row = document.createElement("div");
  row.className = "params-row params-add";
  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = t("params.placeholder.name");
  const expr = document.createElement("input");
  expr.type = "text";
  expr.placeholder = t("params.placeholder.expression");
  const unit = document.createElement("select");
  for (const u of ["mm", "deg", "count"] as ParamUnit[]) {
    const o = document.createElement("option");
    o.value = u;
    o.textContent = u === "count" ? t("params.unitless") : u;
    unit.appendChild(o);
  }
  const add = document.createElement("button");
  setText(add, "params.add");
  const commit = () => {
    if (!name.value.trim() || !expr.value.trim()) return;
    const err = store.addParam(name.value.trim(), expr.value.trim(), unit.value as ParamUnit);
    if (err) {
      add.title = err;
      add.classList.add("input-error");
    } else {
      add.title = "";
      add.classList.remove("input-error");
      name.value = "";
      expr.value = "";
      name.focus();
    }
  };
  add.addEventListener("click", commit);
  expr.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  row.append(name, expr, unit, add);
  return row;
}

function formatValue(def: ParamDef): string {
  if (def.unit === "mm") return `${round(toDisplay(def.value))} ${getUnit()}`;
  if (def.unit === "deg") return `${round(def.value)}°`;
  return String(round(def.value));
}

/** Human label for what a model parameter drives. */
function targetLabel(doc: CadDocument, target: ParamTarget): string {
  const featureName = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    return f ? t("params.target.featureName", { label: FEATURE_META[f.type]?.label ?? f.type, id }) : id;
  };
  switch (target.kind) {
    case "feature":
      return t("params.target.featureField", { feature: featureName(target.feature), field: target.field });
    case "constraint":
      return t("params.target.dimensionIn", { feature: featureName(target.sketch) });
    case "entity":
      return t("params.target.entityField", { field: target.field, feature: featureName(target.sketch) });
    case "pattern":
      return t("params.target.patternField", { field: target.field, feature: featureName(target.sketch) });
  }
}
