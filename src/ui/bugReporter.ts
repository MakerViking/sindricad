// In-app bug reporter: a floating bug button (bottom-right) opening a small
// report dialog. Sends description + auto-collected diagnostics through the
// native ta_bug_report command (webview never dials out; redaction happens in
// Rust before anything leaves the machine). Works with the sidecar DEAD and
// signed out — that's the primary use case. On ANY failed submit (network,
// rejection, endpoint not deployed yet) the report is offered to the
// clipboard so it is never lost.

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { esc } from "./escape";
import { toast } from "./toast";
import { pushModal, popModal } from "./choice";
import { appVersion } from "./updates";
import { breadcrumbs } from "../diagnostics/breadcrumbs";
import { taBugReport, asTaError } from "../tinkeratlas/client";
import type { Viewport } from "../viewport/viewport";
import type { SketchMode } from "../sketch/sketchMode";
import type { Feature } from "../types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export function createBugReporter(deps: {
  store: DocumentStore;
  geometry: GeometryBackend;
  viewport: Viewport;
  sketch: SketchMode;
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
    return `sketch OPEN when reported (${isEdit ? `editing ${live.id}` : "new, uncommitted"}): ` +
      `${ents} entities, ${cons} constraints`;
  }

  const btn = document.createElement("button");
  btn.className = "bug-report-btn";
  btn.title = "Report a bug";
  btn.setAttribute("aria-label", "Report a bug");
  btn.textContent = "🐞";
  document.body.appendChild(btn);
  btn.addEventListener("click", () => void openDialog());

  async function openDialog() {
    if (document.querySelector(".bug-report-card")) return; // one at a time
    const version = await appVersion();
    const connected = geometry.connected;
    // Scene stats FIRST: they answer the questions a performance report always
    // raises (how many triangles, how big the canvas, what frame rate), and
    // leading the list keeps them inside the server's breadcrumb cap.
    const crumbs = [...viewport.sceneStats(), ...breadcrumbs()];

    pushModal();
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card bug-report-card";
    card.innerHTML =
      `<div class="choice-title">Report a bug</div>` +
      `<textarea class="bug-desc" rows="4" placeholder="What happened? What did you expect?"></textarea>` +
      `<label class="bug-check"><input type="checkbox" class="bug-log" checked> Include geometry-engine log (recommended — usernames are removed)</label>` +
      `<label class="bug-check"><input type="checkbox" class="bug-doc"> Include current document (contains your design)</label>` +
      `<details class="bug-preview"><summary>What will be sent</summary><pre>${esc(
        [
          `SindriCAD ${version} · ${navigator.userAgent.slice(0, 80)}`,
          `geometry engine connected: ${connected}`,
          `recent events (${crumbs.length}):`,
          ...crumbs.slice(-5).map((c) => `  ${c}`),
          `+ sidecar log tail (if checked), usernames/paths redacted`,
          `+ current document (only if checked)`,
        ].join("\n"),
      )}</pre></details>` +
      `<div class="choice-row"><button class="choice-btn bug-send"><span>Send report</span></button>` +
      `<button class="choice-btn bug-cancel"><span>Cancel</span></button></div>`;
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const desc = card.querySelector(".bug-desc") as HTMLTextAreaElement;
    const logCb = card.querySelector(".bug-log") as HTMLInputElement;
    const docCb = card.querySelector(".bug-doc") as HTMLInputElement;
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
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });

    (card.querySelector(".bug-send") as HTMLButtonElement).addEventListener("click", async () => {
      const description = desc.value.trim();
      if (!description) {
        desc.focus();
        return;
      }
      const live = sketch.snapshotFeature();
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
        ...(docCb.checked ? { documentJson: documentWithOpenSketch(live) } : {}),
      };
      if (!isTauri()) {
        await copyFallback(description, version, connected, crumbList);
        close();
        return;
      }
      try {
        const res = await taBugReport(payload);
        close();
        toast(
          res.deduplicated
            ? "Thanks — this matches a known report; the existing one was updated."
            : "Bug report sent. Thank you!",
          { kind: "info" },
        );
      } catch (e) {
        // ANY failure (unreachable, rejected, endpoint missing): never lose
        // the report — offer the clipboard path.
        const te = asTaError(e);
        const copied = await copyFallback(description, version, connected, crumbList);
        toast(
          `Couldn't send the report${te ? `: ${te.message}` : ""}.` +
            (copied ? " A copy is on your clipboard — paste it in the SindriCAD Discord." : ""),
          { kind: "error", timeout: 10000 },
        );
      }
    });
  }

  async function copyFallback(
    description: string,
    version: string,
    connected: boolean,
    crumbs: string[],
  ): Promise<boolean> {
    const text = [
      `SindriCAD bug report`,
      `version: ${version} · ${navigator.userAgent.slice(0, 80)}`,
      `geometry engine connected: ${connected}`,
      ``,
      description,
      ``,
      `recent events:`,
      ...crumbs.map((c) => `  ${c}`),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
