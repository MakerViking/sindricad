// Right inspector: the parameters table (edit a value -> rebuild, the whole
// parametric story) plus an editor for the selected feature's numeric fields.
// Numeric fields accept a literal OR a parameter name (per the document model).
//
// Geometry is stored in mm; length values are shown/typed in the user's display
// unit (params are treated as lengths). Angles stay in degrees.

import type { DocumentStore } from "../document/store";
import type { Feature, Num, ParamTarget } from "../types";
import { FEATURE_META, planeLabel, refLabel } from "./featureMeta";
import { getUnit, onUnitChange, round, fieldText, isPlainNumber, parseField, fmtNumber, canonicalDecimal } from "./units";
import { validatedInput, keystrokeGuard } from "./liveInputs";
import { resolveEntities } from "../sketch/resolve";
import { entityDims } from "../sketch/entityDims";
import { FEATURE_NUM_FIELDS as NUM_FIELDS, hasUpToTarget, isHelixSweep } from "../document/numFields";
import type { FieldKind } from "../document/numFields";
import { icon } from "./icons";
import { t, setText, setTitle } from "../i18n";
import { isLegacySplit } from "../features/splitState";
import { featureErrorMessages } from "../geometry/featureErrorText";

/** Whether selecting this feature type actually opens an editor (numeric fields
 *  here, or the sketch editor). The context menu labels "Edit" honestly — a
 *  type without an editor gets "Select" instead.
 *
 *  Pass the feature itself when there is one: a sweep has values to edit only
 *  when its path is a helix, so for a sweep the TYPE cannot answer. */
export function isInspectorEditable(type: Feature["type"], f?: Feature): boolean {
  if (type === "sketch") return true;
  const fields = NUM_FIELDS[type];
  if (!fields) return false;
  return !f || fields.some(([, , , applies]) => !applies || applies(f));
}

/** What to say when an EDIT gesture (double-click a timeline chip, tree
 *  edit-feature) lands on the inspector rather than on an interactive tool.
 *  Keyed on the same predicate as the timeline's "double-click to edit" tooltip
 *  so the promise and the message cannot drift apart — a cylinder used to reach
 *  editFeature's bare `default:` arm and say nothing at all, which read as "the
 *  row is broken" (field report c8531ceb).
 *
 *  The not-editable wording stays NEUTRAL on purpose: "delete it and re-run the
 *  tool" is true for loft/sweep/combine/mirror/removeBody/deleteFace and
 *  false for `import`, which has no tool to re-run. */
export function editHint(type: Feature["type"], f?: Feature): string {
  const label = labelOf(type);
  return isInspectorEditable(type, f) ? t("inspector.editHint.editable", { label }) : t("inspector.editHint.none", { label });
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
  /** the selected feature's failure text (see renderFailure) */
  private failureBox: HTMLElement | null = null;

  /** Why the panel is read-only right now, or null when it is not. main.ts
   *  points it at "a modeling tool is running": every value on screen then
   *  belongs to some OTHER feature than the one being made or re-opened. Field
   *  637278a9 typed a Start offset while extruding a side face, and it rewrote
   *  the FIRST extrude, because the face click had put that extrude here; during
   *  an extrude edit the same kind of write was undone by the tool's commit.
   *
   *  Read again at every write, not only at render: a panel drawn just before a
   *  tool started must still refuse. */
  lockReason: () => string | null = () => null;

  constructor(container: HTMLElement, private store: DocumentStore) {
    this.el = container;
    // async param commits can land mid-edit — same re-render guard as the
    // params dialog (keystrokeGuard)
    store.onDocChange(keystrokeGuard(container, () => this.render()));
    onUnitChange(() => this.render());
    // A build can start or stop the selected feature failing without touching
    // the document. Only the failure text follows it, never the editor rows: a
    // build must not take the caret out of a field. Optional-called, like the
    // timeline's namedBodies: a stub store in a test need not carry it.
    store.onBuild?.((b) => {
      if (!b.building) this.renderFailure();
    });
  }

  /** `focus` is passed ONLY by the edit gesture (double-click / edit-feature),
   *  never by plain selection — otherwise every click in the timeline would
   *  steal the caret out of whatever the user was typing in. */
  select(id: string | null, focus = false) {
    this.selectedId = id;
    this.render();
    if (focus) this.focusFeatureEditor();
  }

  /** Draw again with the same selection: a tool started or stopped, so
   *  lockReason may have changed. */
  refresh() {
    this.render();
  }

  /** Run one write from this panel, unless it is locked. Returns the lock's
   *  reason for the row to show, so a refusal is never silent. */
  private whenUnlocked(write: () => void): string | null {
    const lock = this.lockReason();
    if (lock) return lock;
    write();
    return null;
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
    this.failureBox = null;

    // Said once, at the top, rather than per row: the rows below are disabled
    // and this is the only place that says why.
    const lock = this.lockReason();
    const locked = lock !== null;
    if (lock) {
      const hint = document.createElement("div");
      hint.className = "empty-state";
      hint.textContent = lock;
      this.el.appendChild(hint);
    }

    // --- parameters (user params only; model params dN live in the dialog) ---
    this.el.appendChild(title(t("inspector.parametersTitle", { unit })));
    const defs = doc.paramDefs ?? {};
    for (const [name, value] of Object.entries(doc.parameters)) {
      if (defs[name]?.target) continue; // model param — edited via its field/dim
      const issue = this.store.paramIssues[name];
      const row = numberRow(name, value, (mm) => this.whenUnlocked(() => this.store.setParam(name, mm)), locked);
      if (issue) {
        row.classList.add("param-stale");
        row.title = issue;
      }
      this.el.appendChild(row);
    }

    // --- selected feature editor ---
    if (!this.selectedId) {
      // "Select a feature to edit its values" would contradict the lock hint
      // above, which is the one that is true while a tool runs.
      if (locked) return;
      const hint = document.createElement("div");
      hint.className = "empty-state";
      setText(hint, "inspector.emptyHint");
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
      box.appendChild(title(t("inspector.featureTitle", { label: t("tool.sketch"), id: f.id }), true));
      box.appendChild(this.failureBlock());
      const resolved = resolveEntities(f, doc.parameters);
      resolved.forEach((e, i) => {
        for (const d of entityDims(e)) {
          box.appendChild(
            numberRow(
              `${d.label} ${unit}`,
              d.valueMm,
              (mm) => this.whenUnlocked(() => this.store.setSketchDimension(f.id, i, d.field, mm)),
              locked,
            ),
          );
        }
      });
      return;
    }

    const fields = NUM_FIELDS[f.type];
    // A type with no numeric fields used to render NOTHING — a blank panel is
    // indistinguishable from a broken one, and the timeline still told the user
    // to double-click the row (field report c8531ceb). Name the feature and say
    // there is nothing to edit. The same goes for a feature whose rows all
    // belong to some other shape of it (a sweep that is not a helix).
    box.appendChild(title(t("inspector.featureTitle", { label: labelOf(f.type), id: f.id }), true));
    box.appendChild(this.failureBlock());
    if (!isInspectorEditable(f.type, f)) {
      const hint = document.createElement("div");
      hint.className = "empty-state";
      setText(hint, "inspector.noFields");
      box.appendChild(hint);
      return;
    }

    for (const [field, label, kind, applies] of fields ?? []) {
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
      const shown = String(
        bound
          ? bound.expr
          : typeof cur === "number"
            ? fieldText(cur, kind)
            : (cur ?? ""),
      );
      const row = textRow(
        `${label}${suffix}`,
        shown,
        (raw) => {
          // A lock answers first, so a refused row always says why, even when
          // its text is unchanged (commitField asks again).
          const lock = this.lockReason();
          if (lock) return lock;
          // The text this row was GIVEN is the stored value rounded for display;
          // committing it would write the rounding into the feature (a 1/32" depth
          // came back 0.0313"). Unchanged text means nothing was edited.
          if (raw === shown) return null;
          const err = this.commitField(target, kind, raw);
          if (!err) this.render(); // re-read: fx badge, computed value, canonical rounding
          return err;
        },
        locked,
      );
      if (bound && this.store.isParamBound(target)) {
        row.classList.add("fx-row");
        row.title = `${bound.name} = ${bound.expr} = ${fmtNumber(round(bound.value))}`;
      }
      box.appendChild(row);
    }

    // A helix's two flags are not numbers either. Written through
    // setFeatureFlag, which deletes a flag turned off rather than storing
    // false, so a sweep toggled on and off again saves as it was.
    if (isHelixSweep(f)) {
      const sweep = f as { leftHand?: boolean; flip?: boolean };
      for (const [flag, key] of [["leftHand", "inspector.field.leftHand"], ["flip", "inspector.field.flipDirection"]] as const) {
        box.appendChild(
          toggleRow(key, sweep[flag] === true, (on) => this.whenUnlocked(() => this.store.setFeatureFlag(f.id, flag, on)), locked),
        );
      }
    }

    // Symmetric is a yes/no, so it is not a FEATURE_NUM_FIELDS row either.
    // Without it a symmetric extrude showed a Distance with nothing saying it
    // is split half each side. Not offered with an up-to target, which the
    // sidecar refuses alongside it.
    if (f.type === "extrude" && !hasUpToTarget(f)) {
      box.appendChild(
        switchRow(t("feature.extrude.panel.symmetric"), f.symmetric === true, (on) => {
          this.whenUnlocked(() => this.store.setExtrudeSymmetric(f.id, on));
          this.render(); // a refused write puts the switch back, and the lock says why
        }, locked),
      );
    }
    // Where it starts, when that is an object (GH #41 a): named, and cleared
    // here like the Up-to row, which puts the extrude back on its sketch plane
    // with any start offset kept.
    if (f.type === "extrude" && f.startFrom) {
      box.appendChild(
        targetRow(
          refLabel(f.startFrom, this.store.document.features),
          () => {
            this.whenUnlocked(() => this.store.clearExtrudeStart(f.id));
            this.render();
          },
          locked,
          START_ROW,
        ),
      );
    }
    // The up-to target is not a number, so it cannot live in FEATURE_NUM_FIELDS
    // with the rows above — and until this row existed nothing in the app could
    // delete one. An extrude or press/pull committed with "up to that face" was
    // aimed at it forever, which also meant Taper (hidden while a target exists)
    // was out of reach forever. GH #41.
    if (hasUpToTarget(f)) {
      const planeId = (f as { upToPlane?: string }).upToPlane;
      const ref = f.type === "extrude" ? f.upToRef : undefined;
      const target = ref
        ? refLabel(ref, this.store.document.features)
        : planeId === undefined
          ? t("inspector.upTo.pickedFace")
          : planeLabel(this.store.document.features, planeId);
      box.appendChild(
        targetRow(
          target,
          () => {
            // Drawn again either way: a button has no error state of its own, so
            // a refused clear is answered by the lock hint at the top.
            this.whenUnlocked(() => this.store.clearUpToTarget(f.id));
            this.render();
          },
          locked,
        ),
      );
    }
  }

  /** The block under the selected feature's title that says why it failed. */
  private failureBlock(): HTMLElement {
    const el = document.createElement("div");
    el.className = "inspector-failure";
    this.failureBox = el;
    this.renderFailure();
    return el;
  }

  /** The selected feature's failure, as TEXT: the same sentence its toast
   *  showed, where it can be read at leisure, selected and copied. Its only
   *  other home was the red chip's tooltip, and the toast went after 8 s ("I
   *  don't get time to read and understand it or copy it", 4875dacc). The
   *  toast's Show selects the feature, which is what brings it here. */
  private renderFailure() {
    const el = this.failureBox;
    if (!el) return;
    const build = this.store.buildState;
    const f = this.store.document.features.find((x) => x.id === this.selectedId);
    const bodies = build?.result?.bodies;
    const reason = f && build ? featureErrorMessages(build, this.store.namedBodies?.(bodies) ?? bodies, this.store.document.features).get(f.id) : undefined;
    if (!f || !reason) {
      el.textContent = "";
      el.classList.add("hidden");
      return;
    }
    // Unchanged text is left alone: every build lands here, and rewriting the
    // node would drop a selection the user is making in it.
    const text = t("feature.failed", { name: labelOf(f.type), reason });
    if (el.textContent !== text) el.textContent = text;
    el.classList.remove("hidden");
  }

  /** Route raw field input: plain number → display-unit value write (keeps a
   *  bound field's model param as a literal); anything else → expression in
   *  CANONICAL units (mm/deg) via the params engine. Deliberate semantics fork
   *  (plan decision R4): bare literals in expressions are canonical so the same
   *  file evaluates identically on every machine — unit suffixes (0.5 in) are
   *  the display-unit spelling inside expressions. */
  private commitField(target: ParamTarget, kind: FieldKind, raw: string): string | null {
    const lock = this.lockReason();
    if (lock) return lock;
    if (isPlainNumber(raw)) {
      const value = parseField(raw, kind)!;
      if (value === 0 && this.isOldSplitOffset(target)) return null;
      this.store.setTargetValue(target, value, kind);
      return null;
    }
    // The expression is stored dot-decimal whatever the user typed, so the
    // document means the same thing on every machine (ui/units.canonicalDecimal).
    return this.store.setTargetExpr(target, canonicalDecimal(raw), kind);
  }

  /** An offset of 0 typed into a split saved before the Split Body panel.
   *  Such a split has no `offset` key (the field shows blank), and the key's
   *  absence is what makes the sidecar rebuild it the old way
   *  (splitState.isLegacySplit): written, `offset: 0` moved the cut nowhere and
   *  still re-ordered its pieces, so a later removeBody deleted a different
   *  piece. The Split Body panel refuses the same no-op edit (editedSplit). */
  private isOldSplitOffset(target: ParamTarget): boolean {
    if (target.kind !== "feature" || target.field !== "offset") return false;
    const f = this.store.document.features.find((x) => x.id === target.feature);
    return f?.type === "split" && isLegacySplit(f);
  }
}

/** A yes/no row: the label, and a switch where the inputs above end. */
function switchRow(label: string, on: boolean, onChange: (on: boolean) => void, locked: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row param-row-switch";
  const lab = document.createElement("label");
  lab.textContent = label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = on;
  input.disabled = locked;
  input.addEventListener("change", () => onChange(input.checked));
  row.append(lab, input);
  return row;
}

function title(text: string, spaced = false): HTMLElement {
  const t = document.createElement("div");
  t.className = "panel-title";
  if (spaced) t.style.marginTop = "14px";
  t.textContent = text;
  return t;
}

/** A length row: shows `mm` in the display unit, reports an edit back in mm.
 *  `onChange` answers like validatedInput's commit: an error message to show
 *  (the row turns red and says it), or null when the value was taken. */
function numberRow(label: string, mm: number, onChange: (mm: number) => string | null, locked: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row";
  const lab = document.createElement("label");
  lab.textContent = label;
  const input = document.createElement("input");
  // TEXT, not `type="number"`, and the reason is the comma: a number input
  // whose text is not a valid dot-decimal literal reports its value as the
  // EMPTY STRING, so "1,5" typed under an English webview reaches this handler
  // as "" — indistinguishable from a cleared field. Text plus inputMode keeps
  // the numeric keypad on touch and lets parseNumber apply the app's one rule.
  input.type = "text";
  input.inputMode = "decimal";
  const shown = fieldText(mm);
  input.value = shown;
  input.disabled = locked;
  input.addEventListener("input", () => input.classList.remove("input-error"));
  input.addEventListener("change", () => {
    // unchanged text is the display rounding of `mm`, not an edit — the same
    // rule as the feature rows in render()
    if (input.value === shown) return;
    const v = parseField(input.value);
    if (v === null) return;
    const err = onChange(v);
    if (err) {
      input.classList.add("input-error");
      input.title = err;
    }
  });
  row.append(lab, input);
  return row;
}

function textRow(label: string, value: string, commit: (raw: string) => string | null, locked: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row";
  const lab = document.createElement("label");
  lab.textContent = label;
  // text input so an expression / parameter name is allowed
  const input = validatedInput(value, commit, t("inspector.exprInputHint"));
  input.disabled = locked;
  row.append(lab, input);
  return row;
}

/** An on/off row: the label, and a checkbox where an input would sit. `key` is
 *  a catalogue key (setText stamps data-i18n too). A refused write unticks the
 *  box again and says why in its tooltip. */
function toggleRow(key: string, checked: boolean, onChange: (on: boolean) => string | null, locked: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row param-row-toggle";
  const lab = document.createElement("label");
  setText(lab, key);
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = locked;
  box.setAttribute("aria-label", t(key));
  box.addEventListener("change", () => {
    const err = onChange(box.checked);
    if (err) {
      box.checked = !box.checked;
      box.title = err;
    }
  });
  row.append(lab, box);
  return row;
}

/** The words of a target row: the Up-to row's by default, the Start-from
 *  row's for where an extrude starts. */
interface TargetRowKeys {
  label: string;
  clearTitle: string;
  clearAria: string;
}
const UP_TO_ROW: TargetRowKeys = {
  label: "inspector.upTo.label",
  clearTitle: "inspector.upTo.clearTitle",
  clearAria: "inspector.upTo.clearAria",
};
const START_ROW: TargetRowKeys = {
  label: "inspector.startFrom.label",
  clearTitle: "inspector.startFrom.clearTitle",
  clearAria: "inspector.startFrom.clearAria",
};

/** The "Up to" row: what this feature is aimed at, and the only control that
 *  un-aims it. Read-only text rather than an input — the value is a datum id or
 *  a picked face, neither of which can be typed. The row keeps the panel's
 *  two-column grid: the name and the button share the second column, which
 *  `.param-row-target` widens for them. Without that the fixed 84px input track
 *  left 58px for the text, and "Picked face" needs 68.5px — measured, the
 *  button wrapped onto a second line under the name and the row rendered 38px
 *  tall against its neighbours' 29px. */
function targetRow(value: string, onClear: () => void, locked: boolean, keys: TargetRowKeys = UP_TO_ROW): HTMLElement {
  const row = document.createElement("div");
  row.className = "param-row param-row-target";
  const lab = document.createElement("label");
  setText(lab, keys.label);
  const cell = document.createElement("span");
  cell.className = "param-target";
  const name = document.createElement("span");
  name.textContent = value;
  name.title = value;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "params-del";
  setTitle(clear, keys.clearTitle);
  // icon-only control: the accessible name has to come from the button itself
  clear.setAttribute("aria-label", t(keys.clearAria));
  clear.innerHTML = icon("close");
  clear.disabled = locked;
  clear.addEventListener("click", onClear);
  cell.append(name, clear);
  row.append(lab, cell);
  return row;
}
