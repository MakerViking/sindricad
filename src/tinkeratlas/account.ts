// TinkerAtlas sign-in / sign-out UI. The flow is deliberately paste-based: the
// system browser opens tinkeratlas.com/sindricad/connect where the user (with
// their normal web session) mints a desktop token shown once; pasting it here
// hands it to Rust (ta_sign_in), which validates against /api/desktop/me and
// stores it in app data. The webview never talks to tinkeratlas.com.

import { pushModal, popModal, choose } from "../ui/choice";
import { toast } from "../ui/toast";
import { openExternal } from "../ui/welcome";
import { TA_CONNECT_URL, taSignIn, taSignOut, asTaError, currentAccount, type TaUser } from "./client";

export function openSignInDialog(): Promise<TaUser | null> {
  return new Promise((resolve) => {
    pushModal();
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card ta-signin";
    card.innerHTML =
      `<div class="choice-title">Sign in with TinkerAtlas</div>` +
      `<p class="ta-signin-hint">SindriCAD signs in with a desktop token. Get one from your` +
      ` TinkerAtlas account, then paste it below.</p>`;

    const getBtn = document.createElement("button");
    getBtn.className = "choice-btn";
    getBtn.innerHTML = "<span>Open tinkeratlas.com to get a token</span>";
    getBtn.onclick = () => void openExternal(TA_CONNECT_URL);
    card.appendChild(getBtn);

    const input = document.createElement("input");
    input.className = "ta-signin-input";
    input.type = "password";
    input.placeholder = "ta_scad_…";
    input.autocomplete = "off";
    input.spellcheck = false;
    card.appendChild(input);

    const err = document.createElement("div");
    err.className = "ta-signin-error";
    card.appendChild(err);

    const row = document.createElement("div");
    row.className = "choice-row";
    const cancel = document.createElement("button");
    cancel.className = "choice-btn";
    cancel.innerHTML = "<span>Cancel</span>";
    const ok = document.createElement("button");
    ok.className = "choice-btn choice-primary";
    ok.innerHTML = "<span>Sign in</span>";
    row.append(cancel, ok);
    card.appendChild(row);

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    input.focus();

    const submit = async () => {
      const token = input.value.trim();
      if (!token) {
        err.textContent = "Paste the token first.";
        return;
      }
      ok.disabled = true;
      err.textContent = "";
      ok.innerHTML = "<span>Signing in…</span>";
      try {
        const user = await taSignIn(token);
        done(user);
      } catch (e) {
        const ta = asTaError(e);
        err.textContent =
          ta?.code === "Unauthorized"
            ? "That token wasn't accepted — copy it again from tinkeratlas.com."
            : ta?.code === "Unreachable"
              ? "Can't reach TinkerAtlas — check your connection and retry."
              : `Sign-in failed: ${ta?.message ?? String(e)}`;
        ok.disabled = false;
        ok.innerHTML = "<span>Sign in</span>";
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(null);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        void submit();
        return;
      }
      // let typing/paste reach the input, but keep global single-key shortcuts
      // from firing underneath (the pushModal gate covers tool starters).
      e.stopPropagation();
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    window.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => void submit());

    function done(user: TaUser | null) {
      window.removeEventListener("keydown", onKey, true);
      popModal();
      backdrop.remove();
      if (user) toast(`Signed in as ${user.display_name || user.username}`, { kind: "info" });
      resolve(user);
    }
  });
}

export async function signOutFlow(): Promise<void> {
  const user = currentAccount();
  if (!user) return;
  const pick = await choose<"out" | "stay">(`Sign out of TinkerAtlas (${user.username})?`, [
    { value: "out", label: "Sign out" },
    { value: "stay", label: "Cancel" },
  ]);
  if (pick !== "out") return;
  try {
    await taSignOut();
    toast("Signed out of TinkerAtlas", { kind: "info" });
  } catch (e) {
    toast(`Sign-out failed: ${asTaError(e)?.message ?? String(e)}`, { kind: "error" });
  }
}
