// In-app bug reporter: a floating bug button (bottom-right) opening a small
// report dialog. Sends description + auto-collected diagnostics through the
// native ta_bug_report command (webview never dials out; redaction happens in
// Rust before anything leaves the machine). Works with the sidecar DEAD and
// signed out — that's the primary use case. On ANY failed submit (network,
// rejection, endpoint not deployed yet) the report is offered to the
// clipboard so it is never lost.

import type { DocumentStore } from "../document/store";
import { icon } from "./icons";
import type { GeometryBackend } from "../geometry/client";
import { esc } from "./escape";
import { toast } from "./toast";
import { pushModal, popModal } from "./choice";
import { appVersion } from "./updates";
import { breadcrumbs, stickyFact } from "../diagnostics/breadcrumbs";
import { getLocale, hoveredKey, t } from "../i18n";
import { taBugReport, asTaError } from "../tinkeratlas/client";
import type { Viewport } from "../viewport/viewport";
import type { SketchMode } from "../sketch/sketchMode";
import type { Feature } from "../types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** What the user has typed and not yet sent. `openDialog()` rebuilds the
 *  markup from scratch every time, so before this existed the text died with
 *  the card: an Escape, a Cancel or (0.1.193, Windows) letting go of the
 *  resize grip outside the dialog threw the whole report away with nothing to
 *  recover it from. Module scope so it outlives the dialog; cleared only once
 *  a report has actually been sent. */
let draft = "";

export function createBugReporter(deps: {
  store: DocumentStore;
  geometry: GeometryBackend;
  // OPTIONAL, and the reason is the report that needs this button most: when the
  // 3D context fails there is no Viewport and no SketchMode to hand it, and that
  // machine is the only source of its own GL strings. See ui/gpuFatal.ts.
  viewport?: Viewport;
  sketch?: SketchMode;
}) {
  const { store, geometry, viewport, sketch } = deps;

  /** The document as the user sees it, including a sketch still being drawn.
   *  `store.toJSON()` alone is the COMMITTED document: an open sketch has not
   *  reached it yet, so a report filed from inside the sketcher carried a stale
   *  sketch, or none at all when it was the first. */
  function documentWithOpenSketch(live: Feature | null): string {
    if (!live) return store.toJSON();
    const doc = JSON.parse(store.toJSON());
    const i = doc.features.findIndex((f: Feature) => f.id === live.id);
    if (i >= 0) doc.features[i] = live;
    else doc.features.push(live);
    return JSON.stringify(doc);
  }

  /** Says the report came from inside the sketcher. Worth recording even when
   *  the document is NOT attached: it tells the triager the repro starts by
   *  opening a sketch, which no other field carries. */
  function openSketchCrumb(live: Feature | null): string | null {
    if (!live) return null;
    const isEdit = JSON.parse(store.toJSON()).features.some((f: Feature) => f.id === live.id);
    const ents = live.type === "sketch" ? live.entities.length : 0;
    const cons = live.type === "sketch" ? (live.constraints?.length ?? 0) : 0;
    // i18n-ignore breadcrumb for the triager, English on purpose
    return `sketch OPEN when reported (${isEdit ? `editing ${live.id}` : "new, uncommitted"}): ` +
      `${ents} entities, ${cons} constraints`;
  }

  // The active locale rides in the report's metadata AND as a sticky fact, so
  // it survives into the database even if the server ignores the field. Plain
  // English on purpose: breadcrumbs are for the triager, not the user.
  stickyFact(`locale: ${getLocale()}`);

  const btn = document.createElement("button");
  btn.className = "bug-report-btn";
  btn.title = t("bug.button");
  btn.dataset.i18nTitle = "bug.button";
  btn.setAttribute("aria-label", t("bug.button"));
  btn.innerHTML = icon("bug");
  document.body.appendChild(btn);
  btn.addEventListener("click", () => void openDialog());

  async function openDialog() {
    if (document.querySelector(".bug-report-card")) return; // one at a time
    const version = await appVersion();
    const connected = geometry.connected;
    // Scene stats FIRST: they answer the questions a performance report always
    // raises (how many triangles, how big the canvas, what frame rate), and
    // leading the list keeps them inside the server's breadcrumb cap.
    const crumbs = [...(viewport?.sceneStats() ?? []), ...breadcrumbs()];
    // Captured BEFORE the dialog opens, because opening it moves the pointer
    // onto the dialog's own translated elements.
    const lookedAt = hoveredKey();

    pushModal();
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card bug-report-card";
    const categories = ["bug", "translation", "other"] as const;
    card.innerHTML =
      `<div class="choice-title" data-i18n="bug.title">${esc(t("bug.title"))}</div>` +
      `<label class="bug-category"><span data-i18n="bug.category.label">${esc(t("bug.category.label"))}</span><select class="bug-cat">${categories
        .map((c) => `<option value="${c}" data-i18n="bug.category.${c}">${esc(t(`bug.category.${c}`))}</option>`)
        .join("")}</select></label>` +
      `<label class="bug-key" hidden><span data-i18n="bug.stringKey">${esc(t("bug.stringKey"))}</span><input class="bug-key-input" type="text" value="${esc(lookedAt ?? "")}"></label>` +
      `<textarea class="bug-desc" rows="4" placeholder="${esc(t("bug.placeholder"))}"></textarea>` +
      `<label class="bug-check"><input type="checkbox" class="bug-log" checked> <span data-i18n="bug.includeLog">${esc(t("bug.includeLog"))}</span></label>` +
      `<label class="bug-check"><input type="checkbox" class="bug-doc"> <span data-i18n="bug.includeDoc">${esc(t("bug.includeDoc"))}</span></label>` +
      `<details class="bug-preview"><summary data-i18n="bug.preview">${esc(t("bug.preview"))}</summary><pre>${esc(
        [
          `SindriCAD ${version} · ${navigator.userAgent.slice(0, 80)}`,
          // i18n-ignore the preview shows the report as it will be SENT: English
          `geometry engine connected: ${connected}`,
          `locale: ${getLocale()}`,
          `recent events (${crumbs.length}):`,
          ...crumbs.slice(-5).map((c) => `  ${c}`),
          `+ sidecar log tail (if checked), usernames/paths redacted`,
          `+ current document (only if checked)`,
        ].join("\n"),
      )}</pre></details>` +
      `<div class="choice-row"><button class="choice-btn bug-send"><span data-i18n="bug.send">${esc(t("bug.send"))}</span></button>` +
      `<button class="choice-btn bug-cancel"><span data-i18n="common.cancel">${esc(t("common.cancel"))}</span></button></div>`;
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const desc = card.querySelector(".bug-desc") as HTMLTextAreaElement;
    const logCb = card.querySelector(".bug-log") as HTMLInputElement;
    const docCb = card.querySelector(".bug-doc") as HTMLInputElement;
    const catSel = card.querySelector(".bug-cat") as HTMLSelectElement;
    const keyRow = card.querySelector(".bug-key") as HTMLElement;
    const keyInput = card.querySelector(".bug-key-input") as HTMLInputElement;
    const category = () => (categories as readonly string[]).includes(catSel.value) ? catSel.value : "bug";
    catSel.addEventListener("change", () => {
      const tr = category() === "translation";
      keyRow.hidden = !tr;
      desc.placeholder = t(tr ? "bug.translationPlaceholder" : "bug.placeholder");
    });
    desc.value = draft;
    desc.addEventListener("input", () => {
      draft = desc.value;
    });
    desc.focus();

    const close = () => {
      backdrop.remove();
      window.removeEventListener("keydown", onKey, true);
      popModal();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    (card.querySelector(".bug-cancel") as HTMLButtonElement).addEventListener("click", close);
    // Close on a click that is a click on the BACKDROP, not merely one the DOM
    // reported there. `click` is dispatched at the nearest common ancestor of
    // the press and the release, so a drag that starts in the card and ends
    // outside it — stretching the textarea by its resize grip is the easy way
    // to do that, since the card is flex-centred and its bottom edge only
    // moves half as fast as the cursor — arrives here with target === backdrop
    // and used to close the dialog mid-gesture. Requiring both ends of the
    // gesture to be on the backdrop leaves an honest click closing it and
    // nothing else. Still on `click`, not `pointerup`: closing on release
    // would let the trailing click land on whatever the removed backdrop was
    // covering.
    let pressedOnBackdrop = false;
    backdrop.addEventListener("pointerdown", (e) => {
      pressedOnBackdrop = e.target === backdrop;
    });
    backdrop.addEventListener("pointerup", (e) => {
      pressedOnBackdrop = pressedOnBackdrop && e.target === backdrop;
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && pressedOnBackdrop) close();
    });

    (card.querySelector(".bug-send") as HTMLButtonElement).addEventListener("click", async () => {
      let description = desc.value.trim();
      if (!description) {
        desc.focus();
        return;
      }
      // A translation report names the string in the description too, so it is
      // searchable even where the structured fields are not stored.
      if (category() === "translation") {
        const key = keyInput.value.trim();
        description = `[translation] locale=${getLocale()}${key ? ` key=${key}` : ""}\n${description}`;
      }
      const live = sketch?.snapshotFeature() ?? null;
      const sketchCrumb = openSketchCrumb(live);
      // prepended, not appended: the server caps the breadcrumb list, and the
      // same reasoning that puts scene stats first applies here. Used by the
      // clipboard fallback too, so an offline report keeps the context.
      const crumbList = sketchCrumb ? [sketchCrumb, ...crumbs] : crumbs;
      const payload = {
        description,
        appVersion: version,
        sidecarConnected: connected,
        includeLog: logCb.checked,
        breadcrumbs: crumbList,
        locale: getLocale(),
        category: category(),
        ...(docCb.checked ? { documentJson: documentWithOpenSketch(live) } : {}),
      };
      if (!isTauri()) {
        await copyFallback(description, version, connected, crumbList);
        close();
        return;
      }
      try {
        const res = await taBugReport(payload);
        draft = ""; // sent, so there is nothing left to restore
        close();
        toast(t(res.deduplicated ? "bug.sentDuplicate" : "bug.sent"), { kind: "info" });
      } catch (e) {
        // ANY failure (unreachable, rejected, endpoint missing): never lose
        // the report — offer the clipboard path.
        const te = asTaError(e);
        const copied = await copyFallback(description, version, connected, crumbList);
        toast(t("bug.failed", { reason: te ? `: ${te.message}` : "" }) + (copied ? t("bug.copied") : ""), {
          kind: "error",
          timeout: 10000,
        });
      }
    });
  }

  async function copyFallback(
    description: string,
    version: string,
    connected: boolean,
    crumbs: string[],
  ): Promise<boolean> {
    // i18n-ignore-start the clipboard fallback IS the bug report; every line of
    // it stays English so support can grep a report filed in any language.
    const text = [
      `SindriCAD bug report`,
      `version: ${version} · ${navigator.userAgent.slice(0, 80)}`,
      `geometry engine connected: ${connected}`,
      `locale: ${getLocale()}`,
      ``,
      description,
      ``,
      `recent events:`,
      ...crumbs.map((c) => `  ${c}`),
    ].join("\n");
    // i18n-ignore-end
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
