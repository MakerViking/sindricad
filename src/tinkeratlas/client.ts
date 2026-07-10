// Typed wrappers over the Rust TinkerAtlas commands (src-tauri/src/
// tinkeratlas.rs). The webview never talks to tinkeratlas.com itself (CSP
// connect-src is localhost-only); Rust owns the network and the desktop token.
// Same privilege split as printerClient.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const TA_WELCOME_URL =
  import.meta.env.VITE_TA_WELCOME_URL ?? "https://tinkeratlas.com/sindricad/welcome";
export const TA_CONNECT_URL =
  import.meta.env.VITE_TA_CONNECT_URL ?? "https://tinkeratlas.com/sindricad/connect";

export interface TaUser {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
}

// The Rust side returns Err({code, message}); surface both so callers can toast.
export interface TaError {
  code: "Unreachable" | "Unauthorized" | "Rejected" | "Protocol" | "Config";
  message: string;
}

export function asTaError(e: unknown): TaError | null {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as TaError;
  return null;
}

// --- account cache -------------------------------------------------------------
// One in-memory copy of the signed-in identity so the menu, welcome screen and
// publish flow stay in sync without each re-invoking Rust. Rust's on-disk file
// stays the truth; this mirrors it.

let account: TaUser | null = null;
const listeners = new Set<(user: TaUser | null) => void>();

export function currentAccount(): TaUser | null {
  return account;
}

/** Fires immediately with the current value, then on every sign-in/out. */
export function onAccountChange(fn: (user: TaUser | null) => void): () => void {
  listeners.add(fn);
  fn(account);
  return () => listeners.delete(fn);
}

function setAccount(user: TaUser | null) {
  account = user;
  for (const fn of listeners) fn(account);
}

/** Load the cached identity from disk (no network — offline-safe at startup). */
export async function taAccount(): Promise<TaUser | null> {
  const user = await invoke<TaUser | null>("ta_account");
  setAccount(user);
  return user;
}

/** Validate a pasted desktop token and persist it. Throws TaError on failure. */
export async function taSignIn(token: string): Promise<TaUser> {
  const user = await invoke<TaUser>("ta_sign_in", { token });
  setAccount(user);
  return user;
}

export async function taSignOut(): Promise<void> {
  await invoke("ta_sign_out");
  setAccount(null);
}

/** Is tinkeratlas.com reachable? Drives the welcome iframe-vs-fallback choice. */
export function taPing(): Promise<boolean> {
  return invoke("ta_ping");
}

/** Staging path under app_data/publish/ for the sidecar to export into. */
export function taStagingPath(name: string, ext: string): Promise<string> {
  return invoke("ta_staging_path", { name, ext });
}

export interface TaPublishResult {
  url: string;
}

export function taPublish(args: {
  title: string;
  description: string;
  publish: boolean;
  modelPath: string;
  coverPngBase64: string;
}): Promise<TaPublishResult> {
  return invoke("ta_publish", {
    title: args.title,
    description: args.description,
    publish: args.publish,
    modelPath: args.modelPath,
    coverPngBase64: args.coverPngBase64,
  });
}

/** The signed-in user's avatar as a data: URL (rides through Rust because the
 *  webview CSP img-src excludes tinkeratlas.com), or null. Never throws. */
export async function taAvatar(): Promise<string | null> {
  try {
    return await invoke<string | null>("ta_avatar");
  } catch {
    return null;
  }
}

export function onPublishProgress(fn: (stage: string) => void): Promise<UnlistenFn> {
  return listen<{ stage: string }>("ta:publish", (ev) => fn(ev.payload.stage));
}
