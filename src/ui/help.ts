// Help menu links out to the documentation that already exists. Eight tutorial
// clips and the README were both written and published, and until now nothing
// inside the app pointed at either: Help offered Keyboard Shortcuts, Check for
// Updates and About, so a tester who wanted a reference manual had no way to
// learn one was there. This routes to what exists; it does not write anything new.
//
// Both pages open in the SYSTEM BROWSER, not the webview. That is not a
// preference — tauri.conf.json's shipped CSP allows frame-src on the TinkerAtlas
// origin and nothing else, so neither of these could be embedded without
// widening it.

import { toast } from "./toast";

/** The tutorial playlist, verbatim from README.md's Tutorials section (eight
 *  clips). The playlist id is the durable part: individual video URLs are not
 *  linked here so the list can grow without a code change. */
export const TUTORIALS_URL = "https://www.youtube.com/playlist?list=PLS7xEtXRFd1A";

/** The README, which is the closest thing to a manual today. The repo root
 *  anchor rather than blob/main/README.md: the repo home page renders the README
 *  regardless of what the default branch is called, so a branch rename can't
 *  turn this into a 404. */
export const GUIDE_URL = "https://github.com/MakerViking/sindricad#readme";

/** Open a help page in the system browser, and say so if that fails.
 *
 *  The catch is the whole point. `opener:allow-open-url` in
 *  src-tauri/capabilities/default.json scopes which URLs Tauri will open, and a
 *  URL outside that scope is refused at the IPC boundary with no UI of any kind,
 *  so a menu item that opens nothing looks identical to one that worked. Same
 *  dead end as the updater's "Open downloads" button (see updates.ts:88). The
 *  URL goes in the fallback message so the user can still type it in by hand.
 *
 *  ./welcome is imported lazily, not at the top: it pulls in the TinkerAtlas
 *  client and an SVG at module scope, and that would stop help.test.ts from
 *  importing the URL constants under plain node (same reason as updates.ts:84). */
export async function openHelp(url: string): Promise<void> {
  try {
    const { openExternal } = await import("./welcome");
    await openExternal(url);
  } catch (err) {
    console.error("[help] couldn't open", url, err);
    toast(`Couldn't open a browser. The page is ${url}`, { kind: "error", timeout: 15000 });
  }
}
