// A TRIPWIRE, not proof. localizeStaticChrome() translates the labels index.html
// ships as markup (SOLID, ISO/Top/Front/Right, Fit, Units), and from the day it
// was written until PR #59's review nothing called it: every locale, the
// pseudo-locale included, showed those labels in English. A DOM test of the
// function on its own is exactly the shape that stayed green the whole time.
// The proof is e2e/locale_boot_e2e.cjs, which boots the app in a browser; this
// only fails fast in vitest if the call is removed or moved too late.
//
// Too late means after the connection starts: the function writes "connecting…"
// into the status pill, and after a connect it would overwrite "ready".
import { describe, it, expect } from "vitest";
import mainSrc from "../main.ts?raw";

describe("main.ts translates the static chrome at boot", () => {
  const call = mainSrc.indexOf("localizeStaticChrome();");
  const statusEl = mainSrc.indexOf("const statusEl");
  // `geometry.init()` is kept as a promise (geometryReady), not voided: the
  // DEV-only VITE_OPEN_DOC hook waits on it.
  const connect = mainSrc.indexOf("geometry.init()");

  it("anchors exist, so a rename fails here instead of passing with a hole", () => {
    expect(statusEl).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(-1);
  });

  it("imports and calls localizeStaticChrome", () => {
    expect(mainSrc).toMatch(/import \{[^}]*\blocalizeStaticChrome\b[^}]*\} from "\.\/i18n";/);
    expect(call).toBeGreaterThan(-1);
  });

  it("calls it before the status pill is bound and before the socket opens", () => {
    expect(call).toBeLessThan(statusEl);
    expect(call).toBeLessThan(connect);
  });
});
