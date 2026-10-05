// Right inspector: the parameters table (edit a value -> rebuild, the whole
// parametric story) plus an editor for the selected feature's numeric fields.
// Numeric fields accept a literal OR a parameter name (per the document model).
//
// Geometry is stored in mm; length values are shown/typed in the user's display
// unit (params are treated as lengths). Angles stay in degrees.

import type { DocumentStore } from "../document/store";
import type { Feature, Num, ParamTarget } from "../types";
import { FEATURE_META, planeLabel, refLabel } from "./featureMeta";
import { getUnit, onUnitChange, round, fieldText, isPlainNumber, parseField, fmtNumber, canonicalDecimal, dimValueOk, storedDimExpr } from "./units";
import { validatedInput, keystrokeGuard } from "./liveInputs";
import { isImeComposing } from "./focus";
import { resolveRealEntities } from "../sketch/resolve";
import { dimRowLabel, sketchDimRows, type SketchDimRow } from "../sketch/dimRows";
import { isNumericLiteral } from "../params/parse";
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

/** A sketch's dimensions as the panel lists and edits them: the OPEN sketch's
 *  through its session (main.ts wires SketchMode in), a closed one's through
 *  the store (Inspector.closedSketchDims). The rows render the same either
 *  way. */
export interface SketchDimSource {
  /** null for an open sketch that has not been saved yet */
  sketchId: string | null;
  rows: SketchDimRow[];
  /** what is selected on the canvas, by entity id (empty for a closed sketch) */
  selected: ReadonlySet<string>;
  /** the parameter a row's dimension carries: its name (none yet for a formula
   *  an open sketch will name dN at Finish) and its expression */
  binding(row: SketchDimRow): { name?: string; expr: string } | null;
  /** text typed into the row (a number, a formula, `name=formula`) */
  commit(row: SketchDimRow, raw: string): string | null;
  /** a name given on the row's label */
  rename(row: SketchDimRow, name: string): string | null;
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

  /** The sketch open in the sketcher, when one is: while it is, the panel lists
   *  ITS dimensions, live, whatever is selected (main.ts points it at
   *  SketchMode). Edits go to the session, the copy Finish writes. */
  liveSketch: () => SketchDimSource | null = () => null;
  /** A sketch dimension's row was hovered or focused, or left (null): main.ts
   *  lights up the geometry it measures and its label on the canvas. */
  onDimHover: (sketchId: string | null, row: SketchDimRow | null) => void = () => {};

  /** render(), unless a value is being typed in this panel (keystrokeGuard) */
  private guardedRender: () => void;
  /** the sketch dimension rows on screen, for marking the canvas selection */
  private dimRowEls: { row: SketchDimRow; el: HTMLElement }[] = [];

  constructor(container: HTMLElement, private store: DocumentStore) {
    this.el = container;
    // async param commits can land mid-edit — same re-render guard as the
    // params dialog (keystrokeGuard)
    this.guardedRender = keystrokeGuard(container, () => this.render());
    store.onDocChange(this.guardedRender);
    onUnitChange(() => this.render());
    // a re-render can take a hovered row away without a mouseleave
    container.addEventListener("mouseleave", () => this.onDimHover(null, null));
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
    this.onDimHover(null, null); // the rows it pointed at are going
    this.render();
    if (focus) this.focusFeatureEditor();
  }

  /** Draw again with the same selection: a tool started or stopped, so
   *  lockReason may have changed. */
  refresh() {
    this.render();
  }

  /** The open sketch changed (its geometry, dimensions or bindings, or it
   *  opened or closed): list its dimensions again, unless one is being typed. */
  sketchChanged() {
    this.guardedRender();
  }

  /** The canvas selection changed to `selected` (entity ids): mark the rows
   *  of the dimensions on it, and bring the first into view (report
   *  9e9ae278). The rows on screen are marked as they are; nothing is listed
   *  again for a click. */
  sketchSelectionChanged(selected: ReadonlySet<string>) {
    const first = this.markSelectedRows(selected);
    first?.scrollIntoView({ block: "nearest" });
  }

  /** Mark the rows whose geometry is in `sel`; returns the first marked. */
  private markSelectedRows(sel: ReadonlySet<string>): HTMLElement | null {
    let first: HTMLElement | null = null;
    for (const { row, el } of this.dimRowEls) {
      const on = row.entities.some((id) => sel.has(id));
      el.classList.toggle("param-row-linked", on);
      if (on) first ??= el;
    }
    return first;
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
    this.dimRowEls = [];

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

    // --- the open sketch, whatever is selected: its dimensions are what the
    // user is working on, and the ones drawn since it opened are in the
    // session only (report cac30e98: a new dimension on an arc never listed) ---
    const live = this.liveSketch();
    if (live) {
      const box = document.createElement("div");
      this.featureBox = box;
      this.el.appendChild(box);
      box.appendChild(title(
        live.sketchId ? t("inspector.featureTitle", { label: t("tool.sketch"), id: live.sketchId }) : t("inspector.sketchDim.newSketch"),
        true,
      ));
      this.renderSketchDims(box, live, locked);
      return;
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

    // sketch: every dimension the canvas shows a value for (sketch/dimRows),
    // named for whose it is. The store applies a value with the SAME semantics
    // as the canvas editor — a length/diameter becomes a driving constraint
    // and the sketch re-solves (field report 8b49c06e) — and binds a formula
    // or a name the way the canvas label does.
    if (f.type === "sketch") {
      box.appendChild(title(t("inspector.featureTitle", { label: t("tool.sketch"), id: f.id }), true));
      box.appendChild(this.failureBlock());
      this.renderSketchDims(box, this.closedSketchDims(f), locked);
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

  /** A closed sketch's dimensions, edited through the store. A plain number
   *  is the value in the display unit; anything else is a formula, stored as
   *  the canvas label stores it (units.storedDimExpr). */
  private closedSketchDims(f: Extract<Feature, { type: "sketch" }>): SketchDimSource {
    const doc = this.store.document;
    return {
      sketchId: f.id,
      rows: sketchDimRows(resolveRealEntities(f, doc.parameters), f.constraints ?? []),
      selected: new Set(),
      binding: this.store.sketchDimBindings(f.id),
      commit: (row, raw) => {
        if (isPlainNumber(raw)) {
          const v = parseField(raw, row.kind);
          if (!dimValueOk(v, row.kind, row.signed)) return t("sketch.dimension.error.invalidValue");
          this.store.setSketchDimValue(f.id, row, v);
          return null;
        }
        const accept = (v: number) =>
          dimValueOk(v, row.kind, row.signed)
            ? null
            : t(row.signed ? "sketch.dimension.error.mustBeNonZero" : "sketch.dimension.error.mustBePositive");
        return this.store.setSketchDimExpr(f.id, row, storedDimExpr(canonicalDecimal(raw), row.kind), accept);
      },
      rename: (row, name) => this.store.nameSketchDim(f.id, row, name),
    };
  }

  /** One row per sketch dimension: "Rectangle 1 · Width mm", the parameter's
   *  name above it once it has one, and the value, a formula, or `name=formula`
   *  typed beside it. Double-clicking the label names the dimension, which is
   *  what makes it a parameter (decision B10). Pointing at a row lights up its
   *  geometry on the canvas (onDimHover). */
  private renderSketchDims(box: HTMLElement, src: SketchDimSource, locked: boolean) {
    if (!src.rows.length) {
      const hint = document.createElement("div");
      hint.className = "empty-state";
      setText(hint, "inspector.sketchDim.none");
      box.appendChild(hint);
      return;
    }
    const unit = getUnit();
    for (const row of src.rows) {
      const b = src.binding(row);
      const fx = !!b && !isNumericLiteral(b.expr);
      const value = fieldText(row.valueMm, row.kind);
      // a formula shows as typed; a number, bound or not, in the display unit
      // (the canvas label's rule, SketchDimensions.beginEdit)
      const shown = row.driven ? t("sketch.dimension.drivenValue", { value }) : fx ? b!.expr : value;
      const label = dimRowLabel(row, row.kind === "angle" ? "°" : ` ${unit}`);
      const el = dimRow(label, b?.name ?? null, shown, (raw) => {
        const lock = this.lockReason();
        if (lock) return lock;
        // the text it was given is the value rounded for display: unchanged
        // text is not an edit (the feature rows' rule)
        if (raw === shown) return null;
        return src.commit(row, raw);
      }, locked || row.driven);
      if (fx) {
        el.classList.add("fx-row");
        el.title = `${b!.name ?? ""}${b!.name ? " = " : ""}${b!.expr} = ${fmtNumber(round(row.valueMm))}`;
      }
      if (row.driven) el.title = t("sketch.dimension.title.reference");
      const lab = el.children[0] as HTMLElement;
      if (!row.driven && !locked) {
        setTitle(lab, "inspector.sketchDim.renameHint");
        lab.addEventListener("dblclick", () => this.beginRename(lab, row, b?.name ?? null, label, src));
      }
      const point = (on: boolean) => this.onDimHover(src.sketchId, on ? row : null);
      el.addEventListener("mouseenter", () => point(true));
      el.addEventListener("mouseleave", () => point(false));
      el.addEventListener("focusin", () => point(true));
      el.addEventListener("focusout", () => point(false));
      this.dimRowEls.push({ row, el });
      box.appendChild(el);
    }
    this.markSelectedRows(src.selected);
  }

  /** The label turned into a name box: Enter, Tab or a click elsewhere names
   *  the dimension, as every other box in the panel commits on leaving it;
   *  Escape puts the label back. A refused name stays in the box, red, saying
   *  why. */
  private beginRename(lab: HTMLElement, row: SketchDimRow, name: string | null, label: string, src: SketchDimSource) {
    if (lab.querySelector("input")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "param-dim-rename";
    input.value = name ?? "";
    input.setAttribute("aria-label", t("inspector.sketchDim.renameAria", { label }));
    lab.textContent = "";
    lab.appendChild(input);
    input.focus();
    input.select();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      // leaving the box first ends the panel's typing guard (keystrokeGuard),
      // so the next document change draws the panel again
      if ((document as { activeElement?: unknown }).activeElement === input) input.blur();
      this.render();
    };
    const commit = () => {
      const next = input.value.trim();
      if (!next || next === name) return close();
      const err = this.lockReason() ?? src.rename(row, next);
      if (!err) return close();
      input.classList.add("input-error");
      input.title = err;
    };
    input.addEventListener("input", () => input.classList.remove("input-error"));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
      if (isImeComposing(e)) return;
      if (e.key === "Escape") close();
      if (e.key === "Enter") commit();
    });
    // Leaving the box names it too (the value boxes' and Modify > Parameters'
    // rule): a name typed and then clicked away from was thrown away. A name
    // refused on Enter is asked again and refused again, so it stays red.
    input.addEventListener("blur", () => {
      if (!closed) commit();
    });
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

/** A sketch dimension's row: a text row whose label also carries the name of
 *  the parameter the dimension is, when it is one. */
function dimRow(label: string, name: string | null, value: string, commit: (raw: string) => string | null, locked: boolean): HTMLElement {
  const row = textRow(label, value, commit, locked);
  row.className = "param-row param-row-dim";
  const lab = row.children[0] as HTMLElement;
  lab.textContent = "";
  if (name) {
    const n = document.createElement("span");
    n.className = "param-dim-name";
    n.textContent = name;
    lab.appendChild(n);
  }
  const what = document.createElement("span");
  what.className = "param-dim-what";
  what.textContent = label;
  lab.appendChild(what);
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
