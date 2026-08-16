// The "you can't update in-app" message must stay TRUE and its button must
// actually open something.
//
// The old message said the .deb and .rpm "update through your package manager".
// There is no apt or dnf repository; those packages are GitHub release assets.
// Field report 383e7bfd is one of those installs, stranded on 0.1.111 for a week
// hitting three bugs already fixed in 0.1.117. The replacement offers "Open
// downloads" instead, which fails in a NEW way if the URL is not in the opener
// capability: Tauri refuses openUrl and the button does nothing, silently. That
// is worse than the wrong advice, and nothing else in the tree can see it.
//
// There is no jsdom here (deliberate, see panels.test.ts), so the toast is never
// rendered and these are text/config guards, not behavioural ones. What they can
// see: the false claim is gone, the link points at the repo the updater actually
// polls, and the opener scope admits it. Each also asserts the shape it depends
// on, so a reshaped config fails loudly rather than passing with a hole.
import { describe, it, expect } from "vitest";
import { RELEASES_URL } from "./updates";
// `?raw` rather than fs/JSON imports: tsconfig's types are ["vite/client"] with
// no @types/node and no resolveJsonModule, and vite/client declares this form.
import updatesSrc from "./updates.ts?raw";
import tauriConfSrc from "../../src-tauri/tauri.conf.json?raw";
import capabilitiesSrc from "../../src-tauri/capabilities/default.json?raw";

/** the opener plugin compiles each allow entry with glob::Pattern and matches
 *  with the default MatchOptions, where `*` crosses `/` (require_literal_separator
 *  is false). Mirror that rather than comparing strings, so reformatting the
 *  allow list doesn't break this. */
function openerPatternMatches(pattern: string, url: string): boolean {
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

describe("update message for installs the updater can't replace", () => {
  it("does not claim a package manager will deliver updates", () => {
    // assert the branch this is guarding still EXISTS before trusting its absence
    expect(updatesSrc).toContain("updates_supported");
    // the executable strings only: the header comment quotes the old line on purpose
    const strings = [...updatesSrc.matchAll(/toast\(\s*(?:"([^"]*)"|`([^`]*)`)/g)].map(
      (m) => m[1] ?? m[2] ?? "",
    );
    expect(strings.length).toBeGreaterThan(3);
    for (const s of strings) {
      expect(s.toLowerCase()).not.toMatch(/package manager|\bapt\b|\bdnf\b|\byum\b/);
    }
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
  });

  it("is inside the opener capability, so the button can actually open it", () => {
    const caps = JSON.parse(capabilitiesSrc) as {
      permissions: (string | { identifier: string; allow?: { url?: string }[] })[];
    };
    const opener = caps.permissions.find(
      (p): p is { identifier: string; allow?: { url?: string }[] } =>
        typeof p === "object" && p.identifier === "opener:allow-open-url",
    );
    expect(opener, "opener:allow-open-url permission is gone or renamed").toBeTruthy();
    const patterns = (opener!.allow ?? []).map((a) => a.url ?? "");
    expect(patterns.length).toBeGreaterThan(0);
    expect(
      patterns.some((p) => openerPatternMatches(p, RELEASES_URL)),
      `no opener allow entry matches ${RELEASES_URL} (checked: ${patterns.join(", ")})`,
    ).toBe(true);
  });
});
