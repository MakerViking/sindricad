// The floating bug-report button must never sit on the timeline's Cancel.
//
// Two field reports, two testers, the same corner:
//   8c510bd3: "the Bug report button covers the Cancel button of the
//     Rebuilding / loading indicator, bottom right"
//   5c73a8a9: "Bug report button covers the cancel button for loading meshes
//     (just a layout adjustment)"
//
// The button is position:fixed 14px from the bottom-right corner, 36 px across,
// over the timeline strip; the strip's last children are the busy label, Cancel
// and the red failing-features badge, and the strip kept only 8 px of padding
// at its right end. So 64% of Cancel, its centre included, was under the
// button: a click on Cancel opened the bug report and the import kept running.
//
// This is a hit-testing question ("what would a click on this pixel reach"),
// so only a real layout engine can answer it. Each check asks it the way the
// user does: a real mouse click at the control's centre, then what happened.
// Sizes: this tester's 1436x1012, the other's 796x625, and two common ones.
//
// Controls, so a pass cannot be vacuous: Cancel and the badge must really be on
// screen (non-zero boxes, inside the window) before anything is asserted about
// them, and the click must reach the store's cancel.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/bug_button_cancel_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running against a side-port worktree.
const fs = require("fs");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// A box, and an extrude of a sketch that does not exist: one failing feature,
// so the strip shows its red badge.
const FAILING = {
  version: 5, paramDefs: {}, parameters: {},
  features: [
    { id: "b1", type: "box", length: 40, width: 40, height: 10 },
    { id: "x1", type: "extrude", sketch: "nope", distance: 5, operation: "join",
      regions: [[0, 0, 0]], regionEntities: [["e0"]], regionHoleEntities: [[]], hiddenBodies: [] },
  ],
};

const SIZES = [
  { width: 1436, height: 1012 },
  { width: 796, height: 625 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
];

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    // WebGL2 is MANDATORY: the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: SIZES[0] });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(`localStorage.setItem("sindri.welcomeOnStartup", "false");`);
  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.waitForSelector(".bug-report-btn", { timeout: 20000 });
  // let the blank document's first build settle, so nothing else holds busy
  await page.waitForFunction(() => !window.__sindri.store.buildState.building, null, { timeout: 60000 });

  // Count what a click on Cancel reaches. Wrapped on the instance the timeline
  // calls (this.store.cancelBusy), so it is the click path, not a shortcut.
  await page.evaluate(() => {
    const store = window.__sindri.store;
    const real = store.cancelBusy.bind(store);
    window.__cancels = 0;
    store.cancelBusy = () => { window.__cancels++; return real(); };
  });

  /** What a click at the centre of `sel` would reach, plus the boxes. */
  const probe = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    const bug = document.querySelector(".bug-report-btn");
    if (!el || !bug) return null;
    const r = el.getBoundingClientRect();
    const b = bug.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      cx, cy,
      box: { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) },
      onScreen: r.width > 0 && r.height > 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      hitsItself: !!hit && !!hit.closest(s),
      hit: hit ? hit.getAttribute("class") || hit.tagName : null,
      overlap: Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left))
        * Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top)),
    };
  }, sel);
  const dialogOpen = () => page.$(".bug-report-card").then((el) => !!el);

  for (const size of SIZES) {
    const tag = `${size.width}x${size.height}`;
    await page.setViewportSize(size);
    await page.waitForTimeout(150);

    // --- A long operation is running: hold the store busy the way an import
    //     does, until the test lets go. Cancel shows after 700 ms. ---
    await page.evaluate(() => {
      window.__sindri.store.runBusy("Importing scan.stl", () => new Promise((r) => { window.__release = r; }));
    });
    await page.waitForSelector(".timeline-cancel:not(.hidden)", { timeout: 5000 });
    const cancel = await probe(".timeline-cancel");
    check(!!cancel && cancel.onScreen, `${tag}: Cancel is on screen while busy`, JSON.stringify(cancel?.box));
    if (cancel) {
      check(cancel.overlap === 0, `${tag}: the bug button covers none of Cancel`, `overlap=${cancel.overlap}px2`);
      check(cancel.hitsItself, `${tag}: Cancel's centre hit-tests to Cancel`, `hit=${cancel.hit}`);
      const before = await page.evaluate(() => window.__cancels);
      await page.mouse.click(cancel.cx, cancel.cy);
      await page.waitForTimeout(200);
      check(!(await dialogOpen()), `${tag}: clicking Cancel does not open the bug report`);
      check((await page.evaluate(() => window.__cancels)) === before + 1, `${tag}: clicking Cancel reaches the store's cancel`);
      if (await dialogOpen()) await page.keyboard.press("Escape");
    }
    await page.evaluate(() => window.__release?.());
    await page.waitForSelector(".timeline-cancel.hidden", { state: "attached", timeout: 5000 });
  }

  // --- Features are failing: the red badge is the strip's last child. ---
  await page.setViewportSize(SIZES[1]); // the narrow window, where room is tightest
  await page.evaluate((d) => window.__sindri.store.loadDocument(d), FAILING);
  await page.waitForSelector(".timeline-errbadge:not(.hidden)", { timeout: 120000 })
    .catch(() => console.log("  (warning: the badge never appeared)"));
  const badge = await probe(".timeline-errbadge");
  check(!!badge && badge.onScreen, "failing features: the red badge is on screen", JSON.stringify(badge?.box));
  if (badge) {
    check(badge.overlap === 0, "failing features: the bug button covers none of the badge", `overlap=${badge.overlap}px2`);
    check(badge.hitsItself, "failing features: the badge's centre hit-tests to the badge", `hit=${badge.hit}`);
  }

  // --- The bug button itself is still where it was, and still opens the report. ---
  await page.click(".bug-report-btn");
  check(await page.waitForSelector(".bug-report-card", { timeout: 5000 }).then(() => true).catch(() => false),
    "the bug button still opens the report");

  await browser.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
