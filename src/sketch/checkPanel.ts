// The Sketch Check results panel: what checkSketch() found, as a list you can
// click into.
//
// Deliberately knows nothing about SketchMode, the overlay or the viewport — it
// takes an already-computed SketchIssue[] and hands clicks back through `deps`.
// That is not ceremony: this repo has no jsdom, so anything reaching into the
// live sketch session can only ever be exercised by hand, and the panel is the
// half of this feature that has to keep working while the geometry under it
// changes.
//
// Docked top-right like TextOnFacePanel rather than cursor-anchored: every row
// points AT a spot in the sketch, so a panel that follows the cursor would sit
// on top of the thing it is pointing at.

import { esc } from "../ui/escape";
import { icon, type IconName } from "../ui/icons";
import { getUnit, toDisplay } from "../ui/units";
import type { SketchIssue } from "./check";

export interface CheckPanelDeps {
  /** Select the entities a row names, and point at where the problem is
   *  (sketch-plane mm). */
  onSelect(ids: string[], at: { x: number; y: number }): void;
  /** The user dismissed the panel — Escape or the close button. Deliberately
   *  NOT fired by hideCheckPanel(), so an owner closing the panel itself cannot
   *  re-enter its own teardown. */
  onClose(): void;
}

/** A measured gap / overlap / length as a display string.
 *
 *  Not ui/units' fmtLength: that rounds to three decimals, and a "tiny" issue
 *  is raised for anything under 1e-3 mm — so every single one of them would
 *  render as "0 mm", a number that says the segment is fine. Exported and pure
 *  because with no jsdom in this repo it is the only part of this file a test
 *  can reach. */
export function formatMeasurement(mm: number): string {
  const v = toDisplay(mm);
  const mag = Math.abs(v);
  const text = mag > 0 && mag < 0.001 ? v.toExponential(1) : String(Math.round(v * 1000) / 1000);
  return `${text} ${getUnit()}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

let root: HTMLDivElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function isCheckPanelOpen(): boolean {
  return !!root;
}

/** Take the panel down. Idempotent, and silent — see CheckPanelDeps.onClose. */
export function hideCheckPanel(): void {
  root?.remove();
  root = null;
  if (onKey) {
    window.removeEventListener("keydown", onKey, true);
    onKey = null;
  }
}

function rowHtml(issue: SketchIssue, index: number): string {
  const glyph: IconName = issue.severity === "error" ? "warning" : "point";
  const measured = issue.measuredMm === undefined ? "" : `<span class="check-mm">${esc(formatMeasurement(issue.measuredMm))}</span>`;
  return (
    `<button type="button" class="check-row is-${issue.severity}" data-i="${index}" title="${esc(issue.message)}">` +
    `<span class="check-row-icon">${icon(glyph)}</span>` +
    `<span class="check-msg">${esc(issue.message)}</span>` +
    measured +
    `</button>`
  );
}

function groupHtml(head: string, glyph: IconName, severity: "error" | "info", rows: string): string {
  return (
    `<div class="check-group">` +
    `<div class="check-group-head is-${severity}">${icon(glyph)}<span>${esc(head)}</span></div>` +
    rows +
    `</div>`
  );
}

/**
 * Mount the results panel over the viewport. One panel exists at a time; a
 * second call replaces the first.
 *
 * `issues` is rendered in the order checkSketch returned it (errors first, then
 * by kind) — the panel adds no sorting of its own, so the two can never
 * disagree about which problem is the top one.
 */
export function showCheckPanel(issues: SketchIssue[], deps: CheckPanelDeps): void {
  hideCheckPanel();

  const errors = issues.filter((i) => i.severity === "error");
  const infos = issues.filter((i) => i.severity !== "error");
  const ordered = [...errors, ...infos];

  const el = document.createElement("div");
  root = el;
  el.className = "tool-panel check-panel";
  el.tabIndex = -1;
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "Sketch check results");
  // Position and width inline, chrome in the stylesheet — the convention the
  // .tool-panel block states, because the position is the one thing that
  // genuinely differs per panel.
  Object.assign(el.style, { top: "60px", right: "16px", width: "300px", zIndex: "60" });

  const head =
    `<div class="check-head">` +
    `<span class="check-title">Sketch check</span>` +
    `<button type="button" class="check-close panel-btn panel-btn-ghost" aria-label="Close sketch check">${icon("close")}</button>` +
    `</div>`;

  // The empty state is the reading most runs produce, so it has to say what it
  // means on its own: a green tick and a plain sentence, never the neutral
  // grey box that is indistinguishable from "the check did not run".
  const body = ordered.length
    ? (errors.length
        ? groupHtml(plural(errors.length, "problem", "problems"), "warning", "error", errors.map((e, i) => rowHtml(e, i)).join(""))
        : "") +
      (infos.length
        ? groupHtml(plural(infos.length, "note", "notes"), "point", "info", infos.map((n, i) => rowHtml(n, errors.length + i)).join(""))
        : "")
    : `<div class="check-empty">` +
      `<span class="check-empty-icon">${icon("check")}</span>` +
      `<span class="check-empty-text">` +
      `<span class="check-empty-title">No problems found</span>` +
      `<span class="check-empty-sub">Nothing open, overlapping, crossing itself or too small to build.</span>` +
      `</span>` +
      `</div>`;

  const hint = ordered.length
    ? `<div class="check-hint">Click a row to select it · Esc to close</div>`
    : `<div class="check-hint">Esc to close</div>`;

  el.innerHTML = `${head}<div class="check-scroll">${body}</div>${hint}`;
  document.body.appendChild(el);

  const dismiss = () => {
    hideCheckPanel();
    deps.onClose();
  };

  el.querySelector<HTMLButtonElement>(".check-close")!.addEventListener("click", dismiss);
  el.querySelectorAll<HTMLButtonElement>(".check-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const issue = ordered[Number(btn.dataset.i)];
      if (issue) deps.onSelect(issue.entityIds, issue.at);
    });
  });

  // Capture phase, like FloatingPanel. Note SketchMode registers its own
  // capture-phase key handler in enter() (sketchMode.ts:434) — earlier than
  // this one, so it runs first and an idle Esc will also clear the sketch
  // selection. That is coherent rather than a bug: the panel goes and the
  // highlight it put on screen goes with it.
  onKey = (e) => {
    if (e.key === "Escape") dismiss();
  };
  window.addEventListener("keydown", onKey, true);

  // Focus the container, not the first row: it puts the list one Tab away
  // without a focus ring sitting on a row the user never chose.
  el.focus();
}
