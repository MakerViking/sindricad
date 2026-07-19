// Welcome screen — opens at startup (unless turned off) and from the
// TinkerAtlas menu. Left column: local actions (New / Open / recent files) and
// the TinkerAtlas account row. Right pane: the remote
// tinkeratlas.com/sindricad/welcome page in an iframe — the ONLY remote content
// the webview embeds (CSP frame-src allows exactly that origin; connect-src
// stays localhost-only, so reachability is probed through Rust's ta_ping).

import { pushModal, popModal } from "./choice";
import { esc } from "./escape";
import { getRecentFiles, forgetRecent } from "../io/recentFiles";
import logoUrl from "../../assets/brand/sindricad-lockup-app.svg";
import {
  TA_WELCOME_URL,
  currentAccount,
  onAccountChange,
  taAvatar,
  taPing,
} from "../tinkeratlas/client";

const SHOW_KEY = "sindri.welcomeOnStartup";
export function welcomeOnStartup(): boolean {
  return localStorage.getItem(SHOW_KEY) !== "false";
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** Open a URL in the system browser (Tauri opener; new tab in plain dev). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export interface WelcomeCallbacks {
  onNew: () => void;
  onOpen: () => void;
  onOpenPath: (path: string) => Promise<boolean>;
  onSignIn: () => void;
  onSignOut: () => void;
}

export class WelcomeScreen {
  private overlay: HTMLDivElement | null = null;
  private unsubAccount: (() => void) | null = null;
  private onMessage = this.handleMessage.bind(this);
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
    }
  };

  constructor(private cb: WelcomeCallbacks) {}

  open(): void {
    if (this.overlay) return;
    pushModal();
    this.build();
    window.addEventListener("message", this.onMessage);
    window.addEventListener("keydown", this.onKey, true);
  }

  close(): void {
    if (!this.overlay) return;
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("keydown", this.onKey, true);
    this.unsubAccount?.();
    this.unsubAccount = null;
    this.overlay.remove();
    this.overlay = null;
    popModal();
  }

  // --- iframe → app link opening (cross-repo contract) -------------------------
  // The embedded page can't open windows (the Tauri shell blocks new-window
  // requests), so its links post {type:"open-url", url} to the parent. Trust
  // gate: the message must come from the welcome page's own origin and the URL
  // must lead back into that origin — anything else is dropped.
  private handleMessage(e: MessageEvent): void {
    const welcomeOrigin = new URL(TA_WELCOME_URL).origin;
    if (e.origin !== welcomeOrigin) return;
    const data = e.data as { type?: string; url?: string } | null;
    if (!data || data.type !== "open-url" || typeof data.url !== "string") return;
    if (data.url !== welcomeOrigin && !data.url.startsWith(`${welcomeOrigin}/`)) return;
    void openExternal(data.url);
  }

  private build(): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) this.close();
    });

    const panel = document.createElement("div");
    panel.className = "modal-panel welcome-panel";
    overlay.appendChild(panel);

    const head = document.createElement("div");
    head.className = "modal-head";
    const h2 = document.createElement("h2");
    const logo = document.createElement("img");
    logo.src = logoUrl;
    logo.alt = "SindriCAD";
    logo.className = "welcome-logo";
    h2.appendChild(logo);
    head.appendChild(h2);
    const x = document.createElement("button");
    x.className = "modal-close";
    x.textContent = "✕";
    x.onclick = () => this.close();
    head.appendChild(x);
    panel.appendChild(head);

    const body = document.createElement("div");
    body.className = "modal-body welcome-body";
    panel.appendChild(body);

    body.appendChild(this.buildLeft());
    body.appendChild(this.buildRight());

    const foot = document.createElement("div");
    foot.className = "welcome-foot";
    const lab = document.createElement("label");
    lab.className = "welcome-startup";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = welcomeOnStartup();
    cb.onchange = () => localStorage.setItem(SHOW_KEY, cb.checked ? "true" : "false");
    lab.append(cb, document.createTextNode(" Show this screen on startup"));
    foot.appendChild(lab);
    panel.appendChild(foot);

    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  private buildLeft(): HTMLElement {
    const left = document.createElement("div");
    left.className = "welcome-left";

    const actions = document.createElement("div");
    actions.className = "welcome-actions";
    const mk = (label: string, onClick: () => void, primary = false) => {
      const b = document.createElement("button");
      b.className = primary ? "choice-btn choice-primary" : "choice-btn";
      b.innerHTML = `<span>${esc(label)}</span>`;
      b.onclick = onClick;
      actions.appendChild(b);
    };
    mk("New Document", () => {
      this.close();
      this.cb.onNew();
    }, true);
    mk("Open…", () => {
      this.close();
      this.cb.onOpen();
    });
    left.appendChild(actions);

    // recent files (paths only exist in the native app)
    const recents = getRecentFiles();
    if (recents.length) {
      const title = document.createElement("div");
      title.className = "welcome-section";
      title.textContent = "Recent";
      left.appendChild(title);
      const list = document.createElement("div");
      list.className = "welcome-recents";
      for (const r of recents) {
        const parts = r.path.split(/[\\/]/);
        const base = parts.pop() ?? r.path;
        const row = document.createElement("button");
        row.className = "welcome-recent";
        row.title = r.path;
        row.innerHTML = `<span class="welcome-recent-name">${esc(base)}</span><span class="welcome-recent-dir">${esc(parts.join("/"))}</span>`;
        row.onclick = async () => {
          const ok = await this.cb.onOpenPath(r.path);
          if (ok) {
            this.close();
          } else {
            forgetRecent(r.path); // gone from disk — drop it so it stops teasing
            row.remove();
          }
        };
        list.appendChild(row);
      }
      left.appendChild(list);
    }

    // account row — kept live via the client's account cache
    const account = document.createElement("div");
    account.className = "welcome-account";
    left.appendChild(account);
    this.unsubAccount = onAccountChange((user) => {
      account.innerHTML = "";
      if (!user) {
        const b = document.createElement("button");
        b.className = "choice-btn";
        b.innerHTML = "<span>Sign in with TinkerAtlas</span>";
        b.onclick = () => this.cb.onSignIn();
        account.appendChild(b);
        return;
      }
      const row = document.createElement("div");
      row.className = "welcome-user";
      const img = document.createElement("img");
      img.className = "welcome-avatar";
      img.alt = "";
      if (isTauri()) {
        void taAvatar().then((dataUrl) => {
          if (dataUrl) img.src = dataUrl;
        });
      }
      const name = document.createElement("span");
      name.textContent = user.display_name || user.username;
      const out = document.createElement("button");
      out.className = "welcome-signout";
      out.textContent = "Sign out";
      out.onclick = () => this.cb.onSignOut();
      row.append(img, name, out);
      account.appendChild(row);
    });

    return left;
  }

  private buildRight(): HTMLElement {
    const right = document.createElement("div");
    right.className = "welcome-remote";

    const showFrame = () => {
      right.innerHTML = "";
      const frame = document.createElement("iframe");
      frame.className = "welcome-frame";
      frame.src = TA_WELCOME_URL;
      // the page runs with its own (cross-)origin; no popups, no top-navigation.
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      right.appendChild(frame);
    };
    const showFallback = () => {
      right.innerHTML = "";
      const box = document.createElement("div");
      box.className = "welcome-offline";
      box.innerHTML = `<p>TinkerAtlas is unreachable — you're offline or the service is down.</p>`;
      const retry = document.createElement("button");
      retry.className = "choice-btn";
      retry.innerHTML = "<span>Retry</span>";
      retry.onclick = () => void probe();
      box.appendChild(retry);
      right.appendChild(box);
    };
    const probe = async () => {
      right.innerHTML = `<div class="welcome-offline"><p>Connecting to TinkerAtlas…</p></div>`;
      // a cross-origin iframe never reports load failures, so reachability is
      // probed natively (Rust) before committing to the frame.
      if (await taPing()) showFrame();
      else showFallback();
    };

    if (isTauri()) {
      void probe();
    } else {
      showFrame(); // plain vite dev: best-effort, no Rust to ask
    }
    return right;
  }
}

/** Warm the account cache from disk at startup (Tauri only, never throws). */
export async function warmAccount(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { taAccount } = await import("../tinkeratlas/client");
    await taAccount();
  } catch {
    // cache stays signed-out; the welcome screen just shows "Sign in"
  }
}

/** True when the signed-in account row should offer publish etc. */
export function signedIn(): boolean {
  return currentAccount() !== null;
}
