// Settings dialog: the language, keeping the sketch after Extrude, and (in the
// desktop app) whether AI agents may edit documents. Units live in the title
// bar, and shortcuts and the 3D mouse have screens of their own.
// It exists as a screen rather than a menu of radio items because a language
// switch needs words next to it: the UI is built once at boot, so the new
// language only shows after a restart, and that has to be said at the moment
// of switching, not discovered.

import { invoke } from "@tauri-apps/api/core";
import { pushModal, popModal } from "./choice";
import { LOCALES, clearStoredLocale, detectLocale, getLocale, hasStoredLocale, setLocale, setText, t, asLocale, type LocaleCode } from "../i18n";
import { esc } from "./escape";
import { getKeepSketchVisibleAfterExtrude, setKeepSketchVisibleAfterExtrude } from "../features/extrudeTool";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface LanguageSettingsDeps {
  /** Unsaved changes in the open document: a restart would lose them. */
  isDirty: () => boolean;
  /** Offer "Let AI agents edit documents": only once this build HAS agent
   *  writes (bridge.AGENT_WRITES_AVAILABLE). A switch that changes nothing is
   *  not shown, and Rust is not asked about it. */
  agentWrites: boolean;
}

export function openLanguageSettings(deps: LanguageSettingsDeps): void {
  if (document.querySelector(".settings-card")) return;
  const startedOn = getLocale();
  pushModal();
  const backdrop = document.createElement("div");
  backdrop.className = "choice-backdrop";
  const card = document.createElement("div");
  card.className = "choice-card settings-card";

  const systemName = LOCALES[detectLocale()].name;
  const options = [
    `<option value="auto"${hasStoredLocale() ? "" : " selected"}>${esc(t("settings.language.system", { name: systemName }))}</option>`,
    ...(Object.keys(LOCALES) as LocaleCode[]).map(
      (code) => `<option value="${code}"${hasStoredLocale() && code === getLocale() ? " selected" : ""}>${esc(LOCALES[code].name)}</option>`,
    ),
  ].join("");
  card.innerHTML =
    `<div class="choice-title" data-i18n="settings.title">${esc(t("settings.title"))}</div>` +
    `<label class="settings-row"><span data-i18n="settings.language.label">${esc(t("settings.language.label"))}</span>` +
    `<select class="settings-lang">${options}</select></label>` +
    `<div class="settings-note settings-lang-note"></div>` +
    `<label class="settings-row"><span data-i18n="settings.extrude.keepSketchVisible">${esc(t("settings.extrude.keepSketchVisible"))}</span>` +
    `<input type="checkbox" class="settings-keep-sketch-visible"${getKeepSketchVisibleAfterExtrude() ? " checked" : ""}></label>` +
    // Only the desktop app has an agent bridge. Disabled until Rust, which
    // owns the setting (agent_ipc.rs), has said what it is.
    (deps.agentWrites && isTauri()
      ? `<label class="settings-row settings-agent-row"><span data-i18n="settings.agent.allowEdits">${esc(t("settings.agent.allowEdits"))}</span>` +
        `<input type="checkbox" class="settings-agent-writes" disabled></label>` +
        `<div class="settings-note settings-agent-note"></div>`
      : "") +
    `<div class="choice-row"><button class="choice-btn settings-restart" hidden><span></span></button>` +
    `<button class="choice-btn settings-close"><span></span></button></div>`;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const select = card.querySelector(".settings-lang") as HTMLSelectElement;
  const note = card.querySelector(".settings-lang-note") as HTMLElement;
  const restart = card.querySelector(".settings-restart") as HTMLButtonElement;
  const closeBtn = card.querySelector(".settings-close") as HTMLButtonElement;
  const keepSketchVisible = card.querySelector(".settings-keep-sketch-visible") as HTMLInputElement;
  setText(restart.firstElementChild!, "settings.language.restartNow");
  setText(closeBtn.firstElementChild!, "common.close");
  keepSketchVisible.addEventListener("change", () => setKeepSketchVisibleAfterExtrude(keepSketchVisible.checked));
  const agentWrites = card.querySelector(".settings-agent-writes") as HTMLInputElement | null;
  if (agentWrites) wireAgentWrites(agentWrites, card.querySelector(".settings-agent-note") as HTMLElement);

  const refresh = () => {
    const changed = getLocale() !== startedOn;
    restart.hidden = !changed;
    if (!changed) {
      note.textContent = getLocale() === "qps-ploc" ? t("settings.language.pseudoHint") : "";
      return;
    }
    // Written in BOTH the old and the new language: the one the user can read
    // right now, and the one they are about to get.
    const before = t("settings.language.restartNote");
    setLocale(startedOn);
    const inOld = t("settings.language.restartNote");
    const saveFirst = deps.isDirty() ? " " + t("settings.language.saveFirst") : "";
    setLocale(asLocale(select.value) ?? getLocale());
    note.textContent = inOld === before ? before + saveFirst : `${inOld}${saveFirst} · ${before}`;
  };
  select.addEventListener("change", () => {
    if (select.value === "auto") clearStoredLocale();
    else {
      const code = asLocale(select.value);
      if (code) setLocale(code);
    }
    refresh();
  });

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
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  restart.addEventListener("click", async () => {
    if (!isTauri()) {
      window.location.reload();
      return;
    }
    // Same command the updater uses: it releases the single-instance lock and
    // kills the sidecar before relaunching, so the new process does not find
    // port 8765 held (see restart_for_update in src-tauri/src/lib.rs).
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("restart_for_update");
  });
  refresh();
}

/** "Let AI agents edit documents" (off by default). The box shows what Rust
 *  holds, and a save that fails puts it back and says so: a box reading "on"
 *  over a setting still off would tell the user something untrue. If Rust
 *  cannot be asked, the box stays disabled and off. */
function wireAgentWrites(box: HTMLInputElement, note: HTMLElement): void {
  setText(note, "settings.agent.note");
  void (async () => {
    box.checked = (await invoke<boolean>("agent_writes_get")) === true;
    box.disabled = false;
  })().catch((e) => console.warn("agent setting unavailable:", e));
  box.addEventListener("change", async () => {
    const on = box.checked;
    try {
      await invoke("agent_writes_set", { on });
      setText(note, "settings.agent.note");
    } catch (e) {
      console.warn("agent setting not saved:", e);
      box.checked = !on;
      setText(note, "settings.agent.saveFailed");
    }
  });
}
