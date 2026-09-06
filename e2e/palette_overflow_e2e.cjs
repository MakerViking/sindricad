// A ribbon dropdown must not be drawn on top of the Sketch Palette.
//
// Field report e50b83c7 (0.1.211, Windows): "the Sketch Palette panel in the top
// right is in the area where the menu dropdown happens for tools that don't fit
// on the toolbar... when you dropdown the menu e.g. constraints, it looks really
// messy overlaid on the sketch palette".
//
// Both ribbon popups — the "⋯ More" overflow list and a split button's ▾ — are
// `position: fixed` children of document.body at z-index 3000, hung under the
// ribbon and anchored to their button's right edge. `#palette` is docked
// top-right INSIDE #viewport at z-index 20, a few pixels below the ribbon. The
// two occupy the same vertical band, and nothing coordinates them, so on a
// narrow enough window the popup paints over the palette and takes its clicks.
// Measured at HEAD, 1280x800: the popup covered 58,058 px2 = 76% of the palette,
// `elementFromPoint` at the centre of all NINE palette controls returned a
// `.ribbon-overflow-item`, and a real press where "Look At" was drawn armed the
// Trim tool. At 2560, where nothing collapses and there is no ⋯ button at all,
// the CONSTRAINTS group's `Constrain ▾` dropdown lands on the palette instead —
// which is why this file tests both popups, not just the overflow one.
//
// This can only be an e2e. The question is "what is drawn where, and what does a
// click at that pixel hit" — the repo has no jsdom, and jsdom lays nothing out
// anyway, so there is no unit oracle for a stacking-and-hit-testing bug. Every
// unit around this passes while it is broken.
//
// The precondition check below is load-bearing: it asserts the popup's rect
// genuinely overlaps the palette's docked rect at the width being tested. At
// 1920 they do not overlap and every other assertion here would pass on the
// unfixed code.
//
// Usage (from the repo root; NO sidecar needed — the document is a sketch and
// nothing else, and no assertion goes near geometry):
//   npx vite --port 5199 &
//   SC_URL=http://localhost:5199 node e2e/palette_overflow_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome).
const { chromium } = require("playwright-core");
const fs = require("fs");

const URL = process.env.SC_URL || "http://localhost:5173";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The reporter's own document (bug-reports/docs/e50b83c7.json), inlined because
// bug-reports/ is not in the repo. Its contents are incidental — the collision
// is between two pieces of chrome — but a sketch has to be OPEN for the palette
// to exist at all, and this is the sketch the reporter had open.
const REPORTED = {
  version: 5, rollback: 1, parameters: {},
  features: [
    { id: "f1", type: "sketch", plane: "XY", entities: [
      { x: -7.649130461954815, y: 38.91662866608586, id: "e11", type: "rectangle",
        width: 55.42264703135676, height: 54.21488958999548 },
    ] },
    { id: "f2", type: "datumPlane", plane: "XY", offset: 60 },
  ],
};

/** Runs in the page. Where each palette control is drawn, whether the palette is
 *  showing at all, and — for every control that IS drawn — what a click at its
 *  centre would actually hit. */
function readPalette() {
  const pal = document.getElementById("palette");
  const r = pal.getBoundingClientRect();
  const shown = !pal.classList.contains("hidden") && r.width > 0 && r.height > 0;
  const controls = [];
  for (const el of pal.querySelectorAll(".palette-btn, .palette-row")) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue; // not drawn
    const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
    const hit = document.elementFromPoint(x, y);
    controls.push({
      label: (el.textContent || "").trim(),
      hitsPalette: !!hit && pal.contains(hit),
      hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}`.slice(0, 60) : "null",
    });
  }
  return {
    shown, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, controls,
    popups: document.querySelectorAll(".ribbon-overflow-popup").length,
  };
}

/** Runs in the page. The open popup's rect, or null. */
function readPopup() {
  const p = document.querySelector(".ribbon-overflow-popup");
  if (!p) return null;
  const b = p.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

const overlapArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? Math.round(w * h) : 0;
};

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(() => localStorage.setItem("sindri.welcomeOnStartup", "false"));

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal if it came up anyway
  await page.waitForTimeout(300);
  await page.evaluate((d) => window.__sindri.store.loadDocument(d), REPORTED);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
  await page.waitForFunction(() => {
    const p = document.getElementById("palette");
    return p && !p.classList.contains("hidden");
  }, null, { timeout: 20000 });
  // Let the ribbon settle before touching it. Its ResizeObserver reflow() closes
  // and REBUILDS an open overflow popup, and installDismiss registers the
  // outside-pointerdown listener a tick after the popup appears — so a popup
  // opened while the layout is still moving can end up with no dismiss listener
  // at all, and then the outside click below silently does nothing.
  await page.waitForTimeout(600);

  /** the palette, with the popup shut, so we know where its controls are docked */
  const dockedRect = async () => (await page.evaluate(readPalette)).rect;

  const popupCount = () => page.evaluate(() => document.querySelectorAll(".ribbon-overflow-popup").length);
  /** click something that opens a popup, and wait until the popup is settled.
   *  The settle is not padding: `installDismiss` registers the outside-pointerdown
   *  listener a tick AFTER the popup appears, and a reflow that rebuilds the
   *  popup cancels the pending registration. Measured here — with no settle, a
   *  click on bare canvas left the popup open; with 300 ms it closed every time. */
  const openPopup = async (locator) => {
    await locator.click();
    await page.waitForSelector(".ribbon-overflow-popup", { timeout: 5000 });
    await page.waitForTimeout(300);
  };
  /** wait for the popup to actually go away, so a close path that quietly did
   *  nothing fails HERE rather than as a confusing palette assertion later */
  const awaitClosed = async (how) => {
    await page.waitForFunction(() => !document.querySelector(".ribbon-overflow-popup"),
      null, { timeout: 3000 }).catch(() => {});
    check(`${how} closed the popup`, await popupCount() === 0);
  };

  /** assert the state the report is about: while `open`, nothing is drawn as a
   *  palette control and clicked as something else; while shut, every control
   *  is back and hit-tests to itself. */
  const assertPalette = async (when, expectShown) => {
    const p = await page.evaluate(readPalette);
    check(`${when}: the palette is ${expectShown ? "showing" : "out of the way"}`,
      p.shown === expectShown, `shown=${p.shown}, ${p.controls.length} controls drawn, ${p.popups} popup(s) open`);
    const stolen = p.controls.filter((c) => !c.hitsPalette);
    check(`${when}: no palette control is drawn under something else`,
      stolen.length === 0,
      stolen.length ? stolen.map((c) => `${c.label} -> ${c.hit}`).join(", ") : "none");
    if (expectShown) {
      check(`${when}: all nine palette controls are back`, p.controls.length === 9,
        `${p.controls.length} drawn`);
    }
    return p;
  };

  // ===== 1280x800: the "⋯ More" overflow popup ============================
  console.log("\n=== 1280x800, the ⋯ More overflow popup ===");
  const docked1280 = await dockedRect();
  await assertPalette("before the popup opens", true);

  const overflow = page.locator(".ribbon-context:not(.hidden) .ribbon-overflow:not(.hidden)");
  check("the ⋯ overflow button is showing at 1280", await overflow.count() === 1,
    `${await overflow.count()} found`);
  await openPopup(overflow.first());

  // Precondition: this width actually collides. Without it every assertion
  // below passes on the unfixed code at, say, 1920.
  const pop1280 = await readPopupIn(page);
  check("the popup really lands on the palette's dock at this width",
    overlapArea(pop1280, docked1280) > 0,
    `overlap ${overlapArea(pop1280, docked1280)} px2 of ${Math.round(docked1280.w * docked1280.h)}`);

  await assertPalette("with the ⋯ popup open", false);

  // ...and it comes back on each of the three ways a popup closes.
  console.log("\n--- it comes back: outside click ---");
  await page.mouse.click(640, 600); // bare canvas, clear of both
  await awaitClosed("an outside click");
  await assertPalette("after an outside click", true);

  console.log("\n--- it comes back: Escape ---");
  await openPopup(overflow.first());
  await assertPalette("with the ⋯ popup open again", false);
  await page.keyboard.press("Escape");
  await awaitClosed("Escape");
  check("Escape still left the sketch open",
    await page.evaluate(() => window.__sindri.sketch.active));
  await assertPalette("after Escape", true);

  console.log("\n--- it comes back: picking a tool from the popup ---");
  await openPopup(overflow.first());
  await page.locator(".ribbon-overflow-popup .ribbon-overflow-item").first().click();
  await awaitClosed("picking a tool");
  check("picking a tool left the sketch open",
    await page.evaluate(() => window.__sindri.sketch.active));
  await assertPalette("after picking a tool", true);

  // The palette must stay out of the way ACROSS a resize. reflow() closes and
  // rebuilds an open overflow popup on every resize frame, so the close half of
  // that pair must not put the palette back underneath the rebuilt popup.
  console.log("\n--- and stays away across a resize, which rebuilds the popup ---");
  await openPopup(overflow.first());
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.waitForTimeout(500);
  check("the popup survived the resize", await popupCount() === 1);
  await assertPalette("after resizing with the popup open", false);
  await page.keyboard.press("Escape");
  await awaitClosed("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await assertPalette("back at 1280", true);

  // Leaving the sketch with a popup open goes setContext -> closePopup -> the
  // same callback. It must NOT hand the palette back: there is no sketch.
  console.log("\n--- leaving the sketch with a popup open does not resurrect it ---");
  await openPopup(overflow.first());
  // finish(false) rather than the Cancel Sketch action: cancelling rebuilds the
  // document through the Tauri bridge, which does not exist in a plain browser.
  // Either way this is the path that matters — leaving fires sketch.onState ->
  // ribbon.setContext -> closePopup, i.e. a close with no sketch to go back to.
  await page.evaluate(() => window.__sindri.sketch.finish(false));
  await page.waitForTimeout(500);
  check("the sketch is closed",
    await page.evaluate(() => !window.__sindri.sketch.active));
  await awaitClosed("leaving the sketch");
  await assertPalette("after leaving the sketch", false);

  // ...and back in, for the split-dropdown half below.
  await page.evaluate((d) => window.__sindri.store.loadDocument(d), REPORTED);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
  await page.waitForTimeout(600);

  // ===== 2560 wide: no overflow button at all, but a split ▾ still lands ===
  console.log("\n=== 2560x900, the Constrain ▾ split dropdown ===");
  await page.setViewportSize({ width: 2560, height: 900 });
  await page.waitForTimeout(600); // the reflow that un-collapses the groups
  const docked2560 = await dockedRect();
  await assertPalette("before the dropdown opens", true);

  const arrow = page.locator(".ribbon-context:not(.hidden) .ribbon-group:not(.collapsed) .ribbon-split-arrow");
  const arrows = await arrow.count();
  check("a split ▾ is reachable without collapsing anything", arrows >= 1, `${arrows} found`);
  await openPopup(arrow.last()); // the rightmost one — CONSTRAINTS' Constrain ▾

  const pop2560 = await readPopupIn(page);
  check("the split dropdown really lands on the palette's dock",
    overlapArea(pop2560, docked2560) > 0,
    `overlap ${overlapArea(pop2560, docked2560)} px2 of ${Math.round(docked2560.w * docked2560.h)}`);

  await assertPalette("with the split ▾ open", false);
  await page.keyboard.press("Escape");
  await awaitClosed("Escape");
  await assertPalette("after the split ▾ closes", true);

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();

async function readPopupIn(page) {
  const r = await page.evaluate(readPopup);
  if (!r) throw new Error("no .ribbon-overflow-popup open");
  return r;
}
