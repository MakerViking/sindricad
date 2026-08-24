// End-to-end check of what happens when there is NO 3D context, in a real browser.
//
// Field report, Debian Bookworm on an NVIDIA G105M (a 2009 card, so nouveau, so
// no WebGL2): "it just comes up with a black screen with the logo in the top
// left. There is no menu or other features." three r180 asks only for a "webgl2"
// context and throws if it is null, and `new Viewport` used to be the fourth
// statement of main.ts — so the throw ended module evaluation and left
// index.html's static shell and nothing else.
//
// This is the only test that can see the fix, and it exists because nobody here
// has hardware without WebGL2. Unit tests cannot reach it: the panel is built
// with innerHTML and the repo has no jsdom, so the assertions that matter (does
// the panel appear, does it say the RIGHT thing, can the user still close the
// window, can they still file the report) need a real engine.
//
// It patches getContext rather than the driver, which is a fair simulation of
// exactly one thing: what the page sees. It cannot tell you whether
// LIBGL_ALWAYS_SOFTWARE fixes a real nouveau box.
//
// Usage (from the repo root; NO sidecar needed, the panel appears long before
// geometry connects):
//   npx vite --port 5199 &
//   SC_URL=http://localhost:5199 node e2e/webgl_fallback_e2e.cjs
const { chromium } = require("playwright-core");

const URL = process.env.SC_URL || "http://localhost:5173";
// Playwright's own download is not required: any recent Chromium speaks CDP, and
// this test only needs getContext patched and the DOM read back. Point SC_CHROME
// at a binary if the default is wrong for your machine.
const fs = require("fs");
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Break getContext the way a driver does: return null for the types named.
 *  Runs before any page script, so main.ts sees it from its first line. */
const breakGl = (kinds) => `
  const dead = ${JSON.stringify(kinds)};
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (dead.includes(type)) return null;
    return real.call(this, type, ...rest);
  };
  // the welcome screen would sit over everything we want to look at
  localStorage.setItem("sindri.welcomeOnStartup", "false");
`;

async function boot(browser, kinds) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(breakGl(kinds));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(1500); // module eval + the panel's own DOM writes
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

  // --- A: WebGL2 missing, WebGL1 present. The reporter's most likely case. ---
  {
    const { page } = await boot(browser, ["webgl2"]);
    const panel = await page.$(".gpu-fatal");
    check("A: the panel replaces the dead window", !!panel);
    const copy = panel ? await panel.innerText() : "";
    check("A: it names the actual limit, not a generic error",
      /OpenGL ES 2\.0/.test(copy) && /WebGL 2/.test(copy));
    check("A: it shows both workarounds",
      copy.includes("LIBGL_ALWAYS_SOFTWARE=1") && copy.includes("WEBKIT_DISABLE_DMABUF_RENDERER=1"));
    check("A: it reports what the machine said", /webgl2: no/.test(copy));

    // the whole point of the panel: this machine can still tell me what it is
    check("A: the bug reporter mounted with no Viewport and no SketchMode",
      !!(await page.$(".bug-report-btn")));

    // The window is undecorated in the packaged app, so the title bar is the only
    // close/minimise there is, and the panel must not swallow it. The buttons
    // themselves cannot be asserted here: mountWindowControls deliberately
    // no-ops outside Tauri, because a browser tab has its own chrome. What IS
    // observable is the CSS carve-out that keeps that row reachable, which is
    // the half that was actually broken.
    const barLive = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, 18);
      return !!el?.closest("#titlebar");
    });
    check("A: the panel leaves the title bar reachable", barLive);

    // the generic 8-second toast is what the reporter got INSTEAD of any of this
    check("A: the useless generic toast is suppressed",
      !(await page.$(".toast")) || !/Something went wrong/.test(await page.innerText(".toast-stack")));
    await page.close();
  }

  // --- B: no GL of any kind. Must say something DIFFERENT from A. ---
  {
    const { page } = await boot(browser, ["webgl2", "webgl", "experimental-webgl"]);
    const copy = (await page.$(".gpu-fatal")) ? await page.innerText(".gpu-fatal") : "";
    check("B: the panel appears with no GL at all", !!copy);
    check("B: the taxonomy discriminates rather than always saying one thing",
      /of any kind/.test(copy), copy.slice(0, 80));
    await page.close();
  }

  // --- C: the control. Proves the probe did not brick the working path. ---
  {
    const { page, errors } = await boot(browser, []);
    check("C: no panel on a machine that works", !(await page.$(".gpu-fatal")));
    check("C: the ribbon built", (await page.$$(".ribbon-btn")).length > 0,
      `${(await page.$$(".ribbon-btn")).length} buttons`);
    check("C: the menubar built", (await page.$$("#menubar > *")).length > 0);
    check("C: no uncaught errors", errors.length === 0, errors[0]);

    // The regression an adversarial review caught by hit-test: the fixed
    // resize strips painted over the statically-positioned title bar and took
    // the corner of the Close button with them.
    const corner = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth - 2, 2);
      return el ? el.className || el.tagName : "none";
    });
    check("C: the top-right corner belongs to the Close button, not a resize strip",
      !/resize-/.test(String(corner)), `hit ${corner}`);

    // Toasts used to render UNDER the fatal panel, hiding the very feedback it
    // exists to produce.
    // Read the RULE, not an element: the stack is created lazily by the first
    // toast, so querySelector finds nothing on a quiet startup.
    const z = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = Array.from(sheet.cssRules); } catch { continue; }
        for (const r of rules) {
          if (r.selectorText === ".toast-stack" && r.style.zIndex) return r.style.zIndex;
        }
      }
      return "missing";
    });
    check("C: toasts sit above every modal layer", Number(z) >= 6000, `z-index ${z}`);
    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
