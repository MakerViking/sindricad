// TinkerAtlas sign-in / sign-out UI. Primary flow: "Sign in" / "Create
// account" open the system browser at tinkeratlas.com's own login or signup
// (Google login and all), and the app completes automatically when the user
// clicks Authorize (loopback callback — see tinkeratlas.rs). No tokens are
// shown to the user; pasting a desktop token remains a tucked-away fallback
// for machines where the browser handoff can't work.

import { pushModal, popModal, choose } from "../ui/choice";
import { toast } from "../ui/toast";
import { esc } from "../ui/escape";
import { setText, t } from "../i18n";
import {
  taSignIn,
  taBrowserSignIn,
  taSignOut,
  taAccount,
  asTaError,
  currentAccount,
  type TaUser,
} from "./client";

export function openSignInDialog(): Promise<TaUser | null> {
  return new Promise((resolve) => {
    pushModal();
    let waiting = false;

    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card ta-signin";
    card.innerHTML =
      `<div class="choice-title" data-i18n="tinkeratlas.signIn.title">${esc(t("tinkeratlas.signIn.title"))}</div>` +
      `<p class="ta-signin-hint" data-i18n="tinkeratlas.signIn.hint">${esc(t("tinkeratlas.signIn.hint"))}</p>`;
    backdrop.appendChild(card);

    // --- main view: two big actions + hidden token fallback ---
    const main = document.createElement("div");
    card.appendChild(main);

    const signInBtn = document.createElement("button");
    signInBtn.className = "choice-btn choice-primary";
    signInBtn.innerHTML = `<span data-i18n="tinkeratlas.signIn.button">${esc(t("tinkeratlas.signIn.button"))}</span>`;
    main.appendChild(signInBtn);

    const registerBtn = document.createElement("button");
    registerBtn.className = "choice-btn";
    registerBtn.innerHTML = `<span data-i18n="tinkeratlas.signIn.register">${esc(t("tinkeratlas.signIn.register"))}</span>`;
    main.appendChild(registerBtn);

    const err = document.createElement("div");
    err.className = "ta-signin-error";
    main.appendChild(err);

    // token fallback, folded away behind a small link
    const fallbackToggle = document.createElement("button");
    fallbackToggle.className = "ta-signin-alt";
    setText(fallbackToggle, "tinkeratlas.signIn.tokenToggle");
    main.appendChild(fallbackToggle);

    const tokenRow = document.createElement("div");
    tokenRow.className = "ta-signin-tokenrow";
    tokenRow.hidden = true;
    const input = document.createElement("input");
    input.className = "ta-signin-input";
    input.type = "password";
    input.placeholder = "ta_scad_…";
    input.autocomplete = "off";
    input.spellcheck = false;
    const tokenBtn = document.createElement("button");
    tokenBtn.className = "choice-btn";
    tokenBtn.innerHTML = `<span data-i18n="tinkeratlas.signIn.useToken">${esc(t("tinkeratlas.signIn.useToken"))}</span>`;
    tokenRow.append(input, tokenBtn);
    main.appendChild(tokenRow);
    fallbackToggle.onclick = () => {
      tokenRow.hidden = !tokenRow.hidden;
      if (!tokenRow.hidden) input.focus();
    };

    // --- waiting view: shown while the browser round-trip is in flight ---
    const waitingView = document.createElement("div");
    waitingView.className = "ta-signin-waiting";
    waitingView.hidden = true;
    // The two hint sentences are separate keys so each stays whole for a
    // translator; the inline emphasis the English used to carry is gone with it.
    waitingView.innerHTML =
      `<p data-i18n="tinkeratlas.signIn.waiting">${esc(t("tinkeratlas.signIn.waiting"))}</p>` +
      `<p class="ta-signin-hint">${esc(t("tinkeratlas.signIn.waitingAuthorize"))} ${esc(t("tinkeratlas.signIn.waitingSignup"))}</p>`;
    card.appendChild(waitingView);

    const row = document.createElement("div");
    row.className = "choice-row";
    const cancel = document.createElement("button");
    cancel.className = "choice-btn";
    cancel.innerHTML = `<span data-i18n="common.cancel">${esc(t("common.cancel"))}</span>`;
    row.append(cancel);
    card.appendChild(row);

    document.body.appendChild(backdrop);
    signInBtn.focus();

    const showError = (e: unknown) => {
      const ta = asTaError(e);
      err.textContent =
        ta?.code === "Unauthorized"
          ? t("tinkeratlas.signIn.unauthorized")
          : ta?.code === "Unreachable"
            ? t("tinkeratlas.error.unreachableRetry")
            : t("tinkeratlas.signIn.failed", { reason: ta?.message ?? String(e) });
    };

    const setWaiting = (on: boolean) => {
      waiting = on;
      main.hidden = on;
      waitingView.hidden = !on;
    };

    const browserFlow = async (signup: boolean) => {
      err.textContent = "";
      setWaiting(true);
      try {
        const user = await taBrowserSignIn(signup);
        if (waiting) done(user);
      } catch (e) {
        if (!waiting) return; // dialog already cancelled — ignore the timeout
        setWaiting(false);
        showError(e);
      }
    };
    signInBtn.onclick = () => void browserFlow(false);
    registerBtn.onclick = () => void browserFlow(true);

    const tokenFlow = async () => {
      const token = input.value.trim();
      if (!token) {
        err.textContent = t("tinkeratlas.signIn.pasteFirst");
        return;
      }
      tokenBtn.disabled = true;
      err.textContent = "";
      try {
        done(await taSignIn(token));
      } catch (e) {
        showError(e);
        tokenBtn.disabled = false;
      }
    };
    tokenBtn.onclick = () => void tokenFlow();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(null);
        return;
      }
      if (e.key === "Enter" && !tokenRow.hidden && document.activeElement === input) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void tokenFlow();
        return;
      }
      // typing reaches the input; global shortcuts stay gated by pushModal.
      e.stopPropagation();
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    window.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => done(null));

    function done(user: TaUser | null) {
      const wasWaiting = waiting;
      waiting = false;
      window.removeEventListener("keydown", onKey, true);
      popModal();
      backdrop.remove();
      if (user) {
        toast(t("tinkeratlas.signedInAs", { name: user.display_name || user.username }), { kind: "info" });
      } else if (wasWaiting) {
        // the browser round-trip may still complete after cancel — pick the
        // account up from disk so the UI stays truthful either way.
        setTimeout(() => void taAccount().catch(() => {}), 2000);
      }
      resolve(user);
    }
  });
}

export async function signOutFlow(): Promise<void> {
  const user = currentAccount();
  if (!user) return;
  const pick = await choose<"out" | "stay">(t("tinkeratlas.signOut.prompt", { user: user.username }), [
    { value: "out", label: t("tinkeratlas.signOut.confirm") },
    { value: "stay", label: t("common.cancel") },
  ]);
  if (pick !== "out") return;
  try {
    await taSignOut();
    toast(t("tinkeratlas.signOut.done"), { kind: "info" });
  } catch (e) {
    toast(t("tinkeratlas.signOut.failed", { reason: asTaError(e)?.message ?? String(e) }), { kind: "error" });
  }
}
