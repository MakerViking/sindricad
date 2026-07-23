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

const isTauri = () => "__TAURI_INTERNALS__" in window;

export function createBugReporter(deps: { store: DocumentStore; geometry: GeometryBackend }) {
  const { store, geometry } = deps;

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
    const crumbs = breadcrumbs();

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
      const payload = {
        description,
        appVersion: version,
        sidecarConnected: connected,
        includeLog: logCb.checked,
        breadcrumbs: crumbs,
        ...(docCb.checked ? { documentJson: store.toJSON() } : {}),
      };
      if (!isTauri()) {
        await copyFallback(description, version, connected, crumbs);
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
        const copied = await copyFallback(description, version, connected, crumbs);
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
