// Settings dialog. Today it holds one thing, the language, because units live
// in the title bar and shortcuts and the 3D mouse have screens of their own.
// It exists as a screen rather than a menu of radio items because a language
// switch needs words next to it: the UI is built once at boot, so the new
// language only shows after a restart, and that has to be said at the moment
// of switching, not discovered.

import { pushModal, popModal } from "./choice";
import { LOCALES, clearStoredLocale, detectLocale, getLocale, hasStoredLocale, setLocale, setText, t, asLocale, type LocaleCode } from "../i18n";
import { esc } from "./escape";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface LanguageSettingsDeps {
  /** Unsaved changes in the open document: a restart would lose them. */
  isDirty: () => boolean;
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
    `<div class="settings-note"></div>` +
    `<div class="choice-row"><button class="choice-btn settings-restart" hidden><span></span></button>` +
    `<button class="choice-btn settings-close"><span></span></button></div>`;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const select = card.querySelector(".settings-lang") as HTMLSelectElement;
  const note = card.querySelector(".settings-note") as HTMLElement;
  const restart = card.querySelector(".settings-restart") as HTMLButtonElement;
  const closeBtn = card.querySelector(".settings-close") as HTMLButtonElement;
  setText(restart.firstElementChild!, "settings.language.restartNow");
  setText(closeBtn.firstElementChild!, "common.close");

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
