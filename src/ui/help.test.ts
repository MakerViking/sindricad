// Help > Tutorials and Help > Guide are two menu items whose entire job is to
// leave the app. The failure they can have that nothing else in the tree can see
// is Tauri REFUSING the URL: `opener:allow-open-url` scopes what openUrl may
// open, a URL outside that scope is rejected at the IPC boundary with no UI at
// all, and a menu item that opens nothing looks exactly like one that worked.
// That refusal only happens in a packaged build, so the last two tests here are
// config guards over the capability file — which is all a URL-scope question can
// be from this side, and is the same shape updates.test.ts settled on for the
// same reason (see its header for why the first cut, text-scraping, was thrown
// away).
//
// The rest is EXERCISED rather than scraped: openHelp() runs with ./welcome and
// ./toast mocked, and the assertions are over the values that actually reached
// them. There is no jsdom in this repo (deliberate, see panels.test.ts), so no
// menu is rendered; openHelp is called directly, the way the menu item calls it.
import { describe, it, expect, vi, beforeEach } from "vitest";
// `?raw` rather than fs/JSON imports: tsconfig's types are ["vite/client"] with
// no @types/node and no resolveJsonModule, and vite/client declares this form.
import capabilitiesSrc from "../../src-tauri/capabilities/default.json?raw";
import readmeSrc from "../../README.md?raw";

// vi.mock factories are hoisted above the imports, so the recorders they write
// into must be hoisted with them or they sit in the TDZ when the mock runs.
const stub = vi.hoisted(() => ({
  toasts: [] as { message: string; opts: { kind?: string } }[],
  opened: [] as string[],
  /** flipped by the ./welcome mock factory, which vitest runs on FIRST import */
  welcomeLoaded: false,
  /** make openExternal reject, the way a refused opener scope would */
  openFails: false,
}));

vi.mock("./toast", () => ({
  toast: (message: string, opts = {}) => void stub.toasts.push({ message, opts }),
}));
vi.mock("./welcome", () => {
  stub.welcomeLoaded = true;
  return {
    openExternal: (url: string) => {
      stub.opened.push(url);
      return stub.openFails ? Promise.reject(new Error("scope refused")) : Promise.resolve();
    },
  };
});

import { TUTORIALS_URL, GUIDE_URL, openHelp } from "./help";

// Snapshotted at module load, before any test body runs, so this cannot be
// invalidated by test ordering. See the laziness test below for what it proves.
const welcomeLoadedAtImport = stub.welcomeLoaded;

describe("Help menu links to the docs that already exist", () => {
  beforeEach(() => {
    stub.toasts.length = 0;
    stub.opened.length = 0;
    stub.openFails = false;
    // openHelp logs the underlying error before toasting; keep it out of the run.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("hands the tutorial playlist to the system browser", async () => {
    await openHelp(TUTORIALS_URL);
    // openExternal is the system-browser path (Tauri's opener, window.open in a
    // plain-browser session); nothing here should load a page into the webview,
    // which the CSP's frame-src would refuse anyway.
    expect(stub.opened).toEqual([TUTORIALS_URL]);
  });

  it("hands the guide to the system browser", async () => {
    await openHelp(GUIDE_URL);
    expect(stub.opened).toEqual([GUIDE_URL]);
  });

  it("says so when the browser will not open, instead of looking like it worked", async () => {
    // A refused opener scope, a missing xdg-open or a failed chunk load all land
    // here, and the menu closes on click either way, so silence is
    // indistinguishable from success.
    stub.openFails = true;
    await openHelp(GUIDE_URL);
    expect(stub.toasts.length, "the menu item failed in silence").toBe(1);
    expect(
      stub.toasts[0]!.message,
      "the fallback must carry the URL, or it is another dead end",
    ).toContain(GUIDE_URL);
  });

  it("stays silent when the browser did open", async () => {
    await openHelp(TUTORIALS_URL);
    expect(stub.toasts).toEqual([]);
  });

  it("does not drag the TinkerAtlas client in just to hold two URLs", () => {
    // ./welcome imports the TinkerAtlas client and an SVG at module scope. If
    // help.ts imported it at the top rather than inside openHelp, the mock
    // factory above would have run during this file's own import, and the real
    // module would be unimportable from plain node — the same trap updates.ts:84
    // records. Nothing about the menu item breaks visibly when that regresses,
    // which is why it is pinned here.
    expect(
      welcomeLoadedAtImport,
      "help.ts imported ./welcome at module scope; make it a dynamic import inside openHelp",
    ).toBe(false);
  });

  it("points at the playlist the README advertises", () => {
    // Two published surfaces naming the same playlist. If the README's link is
    // updated and this constant is not, the menu sends people to a dead list and
    // nothing else notices.
    expect(readmeSrc, `README.md no longer links ${TUTORIALS_URL}`).toContain(TUTORIALS_URL);
  });

  it("keeps both pages inside the opener capability, so the menu items open something", () => {
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
    // deny wins in the plugin (is_url_allowed tests denied first), so an allow
    // entry on its own does not prove the menu item opens anything.
    const deny = (opener!.deny ?? []).map((d) => d.url ?? "");
    for (const url of [TUTORIALS_URL, GUIDE_URL]) {
      expect(
        allow.some((p) => openerPatternMatches(p, url)),
        `no opener allow entry matches ${url} (checked: ${allow.join(", ")})`,
      ).toBe(true);
      expect(
        deny.filter((p) => openerPatternMatches(p, url)),
        `an opener DENY entry blocks ${url}`,
      ).toEqual([]);
    }
  });
});

/** the opener plugin compiles each scope entry with glob::Pattern and matches the
 *  raw URL string with the default MatchOptions, where `*` crosses `/`
 *  (scope.rs matches_url in tauri-plugin-opener 2.5.4). Mirror that rather than
 *  comparing strings, so reformatting the list doesn't break this. Duplicated
 *  from updates.test.ts rather than shared: two copies of eight lines beats a
 *  test-helper module, and the day there is a third is the day to extract it.
 *  ONLY `*` is emulated: `?` and `[...]` are glob metacharacters too, and rather
 *  than quietly treating them as literals (which would make this claim false) an
 *  entry using them fails here on sight. That is also why the playlist entry in
 *  default.json spells its `?` as `*`. */
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
