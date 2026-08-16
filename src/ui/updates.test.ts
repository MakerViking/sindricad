// The "you can't update in-app" message must APPEAR, stay TRUE, and its button
// must actually open something.
//
// The old message said the .deb and .rpm "update through your package manager".
// There is no apt or dnf repository; those packages are GitHub release assets.
// Field report 383e7bfd is one of those installs, stranded on 0.1.111 for a week
// hitting three bugs already fixed in 0.1.117. The replacement offers "Open
// downloads" instead, which fails in a NEW way if the URL is not in the opener
// capability: Tauri refuses openUrl and the button does nothing, silently. That
// is worse than the wrong advice, and nothing else in the tree can see it.
//
// The first cut of these tests was TEXT-SCRAPING — a regex over `toast(` string
// literals in updates.ts — and review showed all of it passed with the entire
// toast deleted, with the action deleted, and with the exact old false sentence
// hoisted into a `const` one line above the call. A test that survives the
// removal of the thing it guards is not a guard. So the message and the button
// are now EXERCISED: checkForUpdates() is called against a stubbed Tauri with
// ./toast and ./welcome mocked, and every assertion is over the values that
// actually reached them.
//
// Still not behavioural: there is no jsdom here (deliberate, see panels.test.ts),
// so no toast is rendered and no real button is clicked — the action's onClick is
// invoked directly. The last two tests remain config guards, which is all a
// URL-scope question can be from this side; they are worth having because they
// cover the one failure the runtime test cannot see (Tauri refusing the URL at
// the IPC boundary, in a packaged build only).
import { describe, it, expect, vi, beforeEach } from "vitest";
// `?raw` rather than fs/JSON imports: tsconfig's types are ["vite/client"] with
// no @types/node and no resolveJsonModule, and vite/client declares this form.
import tauriConfSrc from "../../src-tauri/tauri.conf.json?raw";
import capabilitiesSrc from "../../src-tauri/capabilities/default.json?raw";

// vi.mock factories are hoisted above the imports, so the recorders they write
// into must be hoisted with them or they sit in the TDZ when the mock runs.
const stub = vi.hoisted(() => ({
  toasts: [] as {
    message: string;
    opts: { action?: { label: string; onClick: () => void }; timeout?: number };
  }[],
  opened: [] as string[],
  /** every Rust command the module asked for, so the gate can be proven consulted */
  invoked: [] as string[],
  /** what the Rust `updates_supported` command answers */
  supported: false,
  /** make openExternal reject, the way a refused opener scope would */
  openFails: false,
}));

vi.mock("./toast", () => ({
  toast: (message: string, opts = {}) => void stub.toasts.push({ message, opts }),
}));
vi.mock("./welcome", () => ({
  openExternal: (url: string) => {
    stub.opened.push(url);
    return stub.openFails ? Promise.reject(new Error("scope refused")) : Promise.resolve();
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    stub.invoked.push(cmd);
    return cmd === "updates_supported" ? Promise.resolve(stub.supported) : Promise.resolve(undefined);
  },
}));
// Only reached if the gate is removed or inverted. Answering "no update" makes
// that mutation fail on a readable assertion rather than an import error.
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.1.999") }));

import { RELEASES_URL, checkForUpdates } from "./updates";

/** the one toast the unsupported branch is supposed to raise */
async function unsupportedToast() {
  await checkForUpdates(true);
  // The gate must actually have been ASKED. Without this, deleting
  // updates_supported() and returning true still produces exactly one toast —
  // "SindriCAD 0.1.999 is up to date." — which satisfies every assertion below
  // about wording while the branch under test no longer runs at all. The first
  // cut checked for the string "updates_supported" in the source, which a
  // COMMENT satisfies.
  expect(
    stub.invoked,
    "updates_supported was never invoked: the gate this message lives behind is gone",
  ).toContain("updates_supported");
  expect(
    stub.toasts.length,
    "Help > Check for Updates said NOTHING on an install the updater cannot replace",
  ).toBe(1);
  return stub.toasts[0]!;
}

describe("update message for installs the updater can't replace", () => {
  beforeEach(() => {
    stub.toasts.length = 0;
    stub.opened.length = 0;
    stub.invoked.length = 0;
    stub.supported = false;
    stub.openFails = false;
    // isTauri() is `"__TAURI_INTERNALS__" in window`; there is no DOM in this
    // runner, so stand up just enough window for the packaged-app path.
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  });

  it("says something at all, rather than leaving the user with silence", async () => {
    const t = await unsupportedToast();
    expect(t.message.trim().length, "the toast message is empty").toBeGreaterThan(20);
  });

  it("does not claim a package manager will deliver updates", async () => {
    const t = await unsupportedToast();
    expect(t.message.toLowerCase()).not.toMatch(/package manager|\bapt\b|\bdnf\b|\byum\b/);
  });

  it("does not name a package format the gate cannot know it has", async () => {
    // updates_supported only tests whether $APPIMAGE is set (src-tauri/src/lib.rs),
    // so this branch also fires for `npm run tauri dev`, a raw cargo build and an
    // extracted AppDir. Naming ".deb" there is a fresh falsehood of exactly the
    // shape being fixed. Everything reaching here shares one true fact: it cannot
    // replace itself.
    const t = await unsupportedToast();
    expect(t.message.toLowerCase()).not.toMatch(/\.deb|\.rpm/);
  });

  it("offers a button that opens the releases page", async () => {
    const t = await unsupportedToast();
    expect(t.opts.action, "no action button: the message is a dead end again").toBeTruthy();
    expect(t.opts.action!.label.trim().length).toBeGreaterThan(0);
    t.opts.action!.onClick();
    await vi.waitFor(() => expect(stub.opened).toEqual([RELEASES_URL]));
  });

  it("says so when the browser will not open, instead of looking like it worked", async () => {
    // toast.ts dismisses the toast the moment the button is clicked, so a refused
    // opener scope or a missing xdg-open would be indistinguishable from success —
    // the same silent dead end, one layer down.
    stub.openFails = true;
    const t = await unsupportedToast();
    t.opts.action!.onClick();
    await vi.waitFor(() => expect(stub.toasts.length).toBe(2));
    expect(
      stub.toasts[1]!.message,
      "the fallback must carry the URL, or it is another dead end",
    ).toContain(RELEASES_URL);
  });

  it("stays quiet on the non-interactive startup check", async () => {
    await checkForUpdates(false);
    expect(stub.toasts).toEqual([]);
  });

  it("names the release page the updater itself polls", () => {
    const conf = JSON.parse(tauriConfSrc) as {
      plugins?: { updater?: { endpoints?: string[] } };
    };
    const endpoint = conf.plugins?.updater?.endpoints?.[0];
    expect(endpoint, "tauri.conf.json updater endpoint moved").toBeTruthy();
    // ".../<owner>/<repo>/releases" — the same repo, whatever it gets renamed to
    const repoOf = (u: string) => u.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+\/releases)\b/)?.[1];
    expect(repoOf(endpoint!), "updater endpoint is not a GitHub releases URL").toBeTruthy();
    expect(repoOf(RELEASES_URL)).toBe(repoOf(endpoint!));
    // and the same TAG: the repo prefix alone accepts a tag that 404s, which is
    // the same dead-end advice wearing a different surface.
    const tagOf = (u: string) => u.match(/\/releases\/(?:tag|download)\/([^/]+)/)?.[1];
    expect(tagOf(endpoint!), "updater endpoint carries no release tag").toBeTruthy();
    expect(tagOf(RELEASES_URL)).toBe(tagOf(endpoint!));
  });

  it("is inside the opener capability, so the button can actually open it", () => {
    const caps = JSON.parse(capabilitiesSrc) as {
      permissions: (
        | string
        | { identifier: string; allow?: { url?: string }[]; deny?: { url?: string }[] }
      )[];
    };
    const opener = caps.permissions.find(
      (p): p is { identifier: string; allow?: { url?: string }[]; deny?: { url?: string }[] } =>
        typeof p === "object" && p.identifier === "opener:allow-open-url",
    );
    expect(opener, "opener:allow-open-url permission is gone or renamed").toBeTruthy();
    const allow = (opener!.allow ?? []).map((a) => a.url ?? "");
    expect(allow.length).toBeGreaterThan(0);
    expect(
      allow.some((p) => openerPatternMatches(p, RELEASES_URL)),
      `no opener allow entry matches ${RELEASES_URL} (checked: ${allow.join(", ")})`,
    ).toBe(true);
    // deny wins in the plugin (scope.rs tests denied first), so an allow entry on
    // its own does not prove the button opens anything.
    const deny = (opener!.deny ?? []).map((d) => d.url ?? "");
    expect(
      deny.filter((p) => openerPatternMatches(p, RELEASES_URL)),
      `an opener DENY entry blocks ${RELEASES_URL}`,
    ).toEqual([]);
  });
});

/** the opener plugin compiles each scope entry with glob::Pattern and matches with
 *  the default MatchOptions, where `*` crosses `/` (require_literal_separator is
 *  false). Mirror that rather than comparing strings, so reformatting the list
 *  doesn't break this. ONLY `*` is emulated: `?` and `[...]` are glob
 *  metacharacters too, and rather than quietly treating them as literals (which
 *  would make this claim false) an entry using them fails here on sight. */
function openerPatternMatches(pattern: string, url: string): boolean {
  expect(
    pattern,
    "opener scope entry uses a glob feature this emulation does not model",
  ).not.toMatch(/[?[\]]/);
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(url);
}
