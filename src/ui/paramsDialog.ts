// Modify → Parameters: the Change Parameters dialog. User parameters (add /
// rename / re-express / comment / delete-with-named-blockers) and model
// parameters (dN — expression + target readout, renamable). Values are shown
// in display units for lengths; EXPRESSIONS are always canonical (mm / deg) —
// same rule as every other expression surface.

import type { DocumentStore } from "../document/store";
import type { CadDocument, ParamDef, ParamTarget, ParamUnit } from "../types";
import { FloatingPanel } from "./panels";
import { FEATURE_META } from "./featureMeta";
import { getUnit, toDisplay, round } from "./units";

const panel = new FloatingPanel();
let unsubscribe: (() => void) | null = null;

export function openParamsDialog(store: DocumentStore): void {
  const el = panel.open(`<div class="measure-title">Parameters</div><div class="params-body"></div>`, {
    closeOnEsc: true,
    onClose: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
  el.classList.add("params-dialog");
  render(store, el);
  // live refresh (async commits landing, undo, load) — but never clobber an
  // edit in progress. Focus alone is the wrong guard (commits land async while
  // the dialog keeps focus); track uncommitted KEYSTROKES instead: typing sets
  // the flag, the change event (Enter/blur = commit or revert) clears it.
  let editing = false;
  el.addEventListener("input", () => (editing = true), true);
  el.addEventListener("change", () => (editing = false), true);
  unsubscribe = store.onDocChange(() => {
    if (!editing) render(store, el);
  });
}

function render(store: DocumentStore, el: HTMLDivElement): void {
  const body = el.querySelector(".params-body")!;
  body.innerHTML = "";
  const doc = store.document;
  const defs = doc.paramDefs ?? {};
  const entries = Object.entries(defs);
  const user = entries.filter(([, d]) => !d.target);
  const model = entries.filter(([, d]) => d.target);

  body.appendChild(sectionTitle("User Parameters"));
  body.appendChild(headerRow());
  for (const [name, def] of user) body.appendChild(paramRow(store, doc, name, def));
  body.appendChild(addRow(store));

  if (model.length) {
    body.appendChild(sectionTitle("Model Parameters"));
    body.appendChild(headerRow());
    for (const [name, def] of model) body.appendChild(paramRow(store, doc, name, def));
  }

  const hint = document.createElement("div");
  hint.className = "measure-hint";
  hint.textContent = "Expressions are in mm / degrees; suffixes mm cm in deg rad allowed · Esc to close";
  body.appendChild(hint);
}

function sectionTitle(text: string): HTMLElement {
  const t = document.createElement("div");
  t.className = "params-section";
  t.textContent = text;
  return t;
}

function headerRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "params-row params-head";
  for (const h of ["Name", "Expression", "Value", "Comment / drives", ""]) {
    const c = document.createElement("span");
    c.textContent = h;
    row.appendChild(c);
  }
  return row;
}

/** input helper: commits on change; a returned error marks the input red and
 *  keeps the rejected text so the user can fix it. */
function cell(value: string, commit: (raw: string) => string | null, title = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  if (title) input.title = title;
  input.addEventListener("input", () => input.classList.remove("input-error"));
  input.addEventListener("change", () => {
    const err = commit(input.value.trim());
    if (err) {
      input.classList.add("input-error");
      input.title = err;
    }
  });
  return input;
}

function paramRow(store: DocumentStore, doc: CadDocument, name: string, def: ParamDef): HTMLElement {
  const row = document.createElement("div");
  row.className = "params-row";
  const issue = store.paramIssues[name];
  if (issue) {
    row.classList.add("param-stale");
    row.title = issue;
  }

  row.appendChild(cell(name, (raw) => (raw === name ? null : store.renameParam(name, raw))));
  row.appendChild(cell(def.expr, (raw) => store.setParamExpr(name, raw)));

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
    row.appendChild(cell(def.comment ?? "", (raw) => (store.setParamComment(name, raw), null)));
    const del = document.createElement("button");
    del.className = "params-del";
    del.textContent = "×";
    del.title = `Delete ${name}`;
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
  name.placeholder = "name";
  const expr = document.createElement("input");
  expr.type = "text";
  expr.placeholder = "expression";
  const unit = document.createElement("select");
  for (const u of ["mm", "deg", "count"] as ParamUnit[]) {
    const o = document.createElement("option");
    o.value = u;
    o.textContent = u === "count" ? "unitless" : u;
    unit.appendChild(o);
  }
  const add = document.createElement("button");
  add.textContent = "+ Add";
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
function targetLabel(doc: CadDocument, t: ParamTarget): string {
  const featureName = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    return f ? `${FEATURE_META[f.type]?.label ?? f.type} ${id}` : id;
  };
  switch (t.kind) {
    case "feature":
      return `${featureName(t.feature)} · ${t.field}`;
    case "constraint":
      return `dimension in ${featureName(t.sketch)}`;
    case "entity":
      return `${t.field} in ${featureName(t.sketch)}`;
    case "pattern":
      return `pattern ${t.field} in ${featureName(t.sketch)}`;
  }
}
