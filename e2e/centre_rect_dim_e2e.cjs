// A dimension badge on a shape centred on the ORIGIN, in a real browser.
//
// Field report d1515ecd (0.1.202): a rectangle drawn around the origin, and
// "clicking the vertical dimension does nothing except turn the horizontal
// origin axis dotted". entityDims lays a rectangle's HEIGHT badge to the left
// at mid-height — for a rect centred on 0,0 that is exactly ON the X axis — and
// its WIDTH badge below at mid-width, exactly on the Y axis. The badge's
// pointerdown asks the host whether geometry under the cursor claims the click,
// and pickEntity falls back to REFERENCE geometry when none of the user's own
// is in range; under a badge none ever is. So the axis took every click, the
// selection was replaced by the axis, and the badges were rebuilt from under
// the press.
//
// This file exists because the SEAM is only real in a browser. Two measured
// Chromium behaviours make it, and no unit test can show either: `dblclick`
// never fires once a pointerdown handler detaches the pressed element (so the
// documented double-click escape hatch was dead exactly when it was needed),
// and `PointerEvent.detail` is 0 on pointerdown (so `e.detail >= 2` gates never
// fire). Both are load-bearing here.
//
// No sidecar geometry is involved — the document is a sketch and nothing else,
// and every assertion is about the sketch overlay and its DOM badges.
//
// Usage (from the repo root), with vite on 5173:
//   SC_TOKEN=<the sidecar token> node e2e/centre_rect_dim_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome);
// SC_PORT overrides the vite port.
const { chromium } = require("playwright-core");

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// The reporter's own document, byte for byte (bug-reports/docs/d1515ecd.json).
const REPORTED = {
  version: 5, parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [{ x: 0, y: 0, id: "e0", type: "rectangle", width: 80, height: 50.04310507196191 }],
  }],
};

// The same trap one step away from the origin: a rectangle at (30,40) whose
// height badge lands on a LINE the user drew. Geometry the user drew must still
// win the single click — that is why the arbitration exists — so this is the
// case the double-press hatch has to rescue.
const OVER_OWN_LINE = {
  version: 5, parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [
      { x: 30, y: 40, id: "e0", type: "rectangle", width: 80, height: 50 },
      { id: "e1", type: "line", x1: -38, y1: 40, x2: 2, y2: 40 },
    ],
  }],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const port = process.env.SC_PORT || "5173";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  const token = process.env.SC_TOKEN ? `?token=${process.env.SC_TOKEN}` : "";
  await page.goto(`http://localhost:${port}/${token}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal
  await page.waitForTimeout(400);

  /** load a document and open its one sketch for edit, then wait for badges */
  const openSketch = async (doc) => {
    await page.evaluate((d) => {
      const s = window.__sindri;
      if (s.sketch.active) s.sketch.finish(false);
      s.store.loadDocument(d);
    }, doc);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
    await page.waitForFunction(() => document.querySelectorAll(".sketch-dim").length >= 2,
      null, { timeout: 20000 });
    // Frame the sketch before touching anything. On the CI runner the sketch
    // opened at whatever zoom the camera happened to be at, the height badge's
    // anchor fell outside the view and the badge was culled: its empty box sat
    // at the viewport's corner, "on screen" by coordinates and unclickable in
    // fact. fitView() frames the model; then wait until every badge is drawn
    // inside the view (rig.fit() transitions, so poll rather than sleep).
    await page.evaluate(() => window.__sindri.viewport.fitView());
    await page.waitForFunction(() => {
      const vp = document.getElementById("viewport").getBoundingClientRect();
      const dims = [...document.querySelectorAll(".sketch-dim")];
      return dims.length >= 2 && dims.every((el) => {
        if (getComputedStyle(el).visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.left >= vp.left && r.right <= vp.right && r.top >= vp.top && r.bottom <= vp.bottom;
      });
    }, null, { timeout: 5000 });
    await page.waitForTimeout(300);
  };

  /** the badge showing `text`, at the centre of where it is drawn */
  const badgeAt = (text) => page.evaluate((t) => {
    const el = [...document.querySelectorAll(".sketch-dim")].find((x) => x.textContent.startsWith(t));
    if (!el || getComputedStyle(el).visibility === "hidden") return null; // culled = not on screen
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  }, text);

  /** what the user can see: is a value editor open, and what is selected */
  const state = () => page.evaluate(() => ({
    editing: document.querySelectorAll(".sketch-dim input").length,
    selected: [...window.__sindri.sketch.selected],
  }));

  const pressAt = async (p) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
  };

  // ===== the report: a rectangle centred on the origin ====================
  console.log("\n=== the reported document: both badges must open their editor ===");
  await openSketch(REPORTED);

  for (const [what, text] of [["height", "50.043"], ["width", "80"]]) {
    const p = await badgeAt(text);
    check(!!p, `the ${what} badge is on screen`, JSON.stringify(p));
    if (!p) continue;
    await pressAt(p);
    // Poll rather than sleep a fixed 250 ms: on the CI runner the first badge's
    // editor took longer than that to appear (the width badge right after it
    // passed), and a fixed wait turns runner load into a red run.
    await page.waitForFunction(() => document.querySelectorAll(".sketch-dim input").length === 1, null, { timeout: 2000 }).catch(() => {});
    const s = await state();
    check(s.editing === 1, `a click on the ${what} badge opens its value editor`,
      `inputs=${s.editing}`);
    check(s.selected.length === 0,
      `the click did not select an origin axis instead`, `selected=${JSON.stringify(s.selected)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  // ===== the rule the fix must not break, and its escape hatch ============
  console.log("\n=== a badge over the user's OWN line: single click selects the line ===");
  await openSketch(OVER_OWN_LINE);
  const hp = await badgeAt("50");
  check(!!hp, "the height badge is on screen", JSON.stringify(hp));
  if (hp) {
    // Tag the badge before pressing it: the press selects the line underneath
    // and REBUILDS every badge, so the second press below must land on the new
    // element, not on the old one mid-removal. Waiting for the untagged
    // replacement is the exact settle the old fixed 250 ms sleep stood in for,
    // and it stays short enough to keep the second press inside the
    // double-press window measured from this first press.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".sketch-dim")) if (el.textContent.includes("50")) el.dataset.e2eFirst = "1";
    });
    await pressAt(hp);
    // ...and wait until that replacement has been LAID OUT where the old badge
    // was: the double-press rule is 4 px, and a badge pressed before its
    // transform settles sits a few pixels off and reads as a fresh single press.
    await page.waitForFunction(
      (p) => [...document.querySelectorAll(".sketch-dim")].some((el) => {
        if (!el.textContent.includes("50") || el.dataset.e2eFirst) return false;
        const b = el.getBoundingClientRect();
        return Math.abs(b.x + b.width / 2 - p.x) <= 1.5 && Math.abs(b.y + b.height / 2 - p.y) <= 1.5;
      }),
      hp, { timeout: 300 }).catch(() => {});
    let s = await state();
    check(s.selected.includes("e1"), "the line underneath took the single click",
      `selected=${JSON.stringify(s.selected)}`);
    check(s.editing === 0, "no editor opened on that click", `inputs=${s.editing}`);

    // The second press, within the double-press window, at the same point. The
    // badge was rebuilt by the first press, so this is a NEW element and no
    // `dblclick` will ever arrive — the editor has to open from the press.
    console.log("\n=== ... and a double-press still edits it ===");
    const again = await badgeAt("50");
    check(!!again, "the badge came back after the rebuild", JSON.stringify(again));
    if (again) {
      await pressAt(again);
      await page.waitForFunction(() => document.querySelectorAll(".sketch-dim input").length === 1, null, { timeout: 2000 }).catch(() => {});
      s = await state();
      check(s.editing === 1, "the second press opened the value editor", `inputs=${s.editing}`);
    }
  }

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})();
