// Pressing T in Extrude, in a real browser, with the caret really in the depth
// box — field report 88c9bdf0.
//
// "Pressing T types a T into the dimension box instead of arming the target
// pick." His document is the failure frozen: a datum plane built 60 mm above XY
// to extrude up to, and an extrude carrying a blind 18.037 mm distance and no
// target at all.
//
// onKey opened with a blanket bail-out for any key aimed at an input while the
// box was up, and the box owns focus for the whole drag phase (beginDrag calls
// dim.show, which focuses the first field and re-asserts focus next frame), so
// T and Shift-T were dead keys in practice. The unit tests could not see it:
// they press with target: null against a dim stub reporting isActive false.
//
// This is the only place the OTHER half is observable at all — that an
// unswallowed letter is inserted into the field by the browser's own default
// action. No handler on the path called preventDefault; nothing but a real
// WebView shows what that costs. Both directions are asserted below: T on an
// untouched box arms the pick and leaves no letter behind, and T after a typed
// value stays text.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<token> node e2e/extrude_target_hotkey_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const BASE = process.env.SC_BASE || process.env.SC_URL || "http://localhost:5173";
const OUT = "/tmp/extrude_target_hotkey_shots";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The reporter's document, minus the extrude he ended up with: one rectangle on
// XY and the offset plane he meant to aim at.
const DOC = {
  parameters: {},
  features: [
    {
      id: "f1", type: "sketch", plane: "XY",
      entities: [{ type: "rectangle", id: "e1", width: 40, height: 40, x: 0, y: 0 }],
    },
    { id: "f2", type: "datumPlane", plane: "XY", offset: 60 },
  ],
};

(async () => {
  require("fs").mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const busy = () => page.evaluate(() => window.__sindri.busyWhy());
  const promptText = () => page.evaluate(() => document.getElementById("prompt")?.textContent ?? "");
  /** What the depth field holds, or null while T mode has the box hidden. Every
   *  tool builds its own .dim-input at construction and leaves it in the DOM
   *  display:none, so the VISIBLE one is the only one that means anything. */
  const depthField = () => page.evaluate(() => {
    const box = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none");
    return box ? (box.querySelector("input")?.value ?? null) : null;
  });
  const boxFocused = () => page.evaluate(() => document.activeElement?.closest(".dim-input") != null);
  const esc = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(500); };
  // The DRAG prompt also mentions "T = extrude up to a face or plane", so only
  // the pick prompt's own sentence can tell the two states apart.
  const AIMING = /Click the face or plane to extrude UP TO/;

  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  check("the app booted with no uncaught error", errors.length === 0, errors.slice(0, 2).join(" | "));
  await esc(); // the welcome modal is part of toolBusy()

  await page.evaluate((doc) => {
    const s = window.__sindri;
    s.store.loadDocument(doc);
    s.store.setSketchVisibility("f1", true);
    s.overlay.update(s.store.document);
  }, DOC);
  const built = await page.waitForFunction(
    () => {
      const s = window.__sindri;
      return s.overlay.regions.length > 0 && !s.store.buildState.building && !!s.store.buildState.result;
    },
    null,
    { timeout: 120000 },
  ).then(() => true, () => false);
  await page.waitForTimeout(600);
  check("the geometry engine answered the build", built === true);
  if (!built) {
    await page.screenshot({ path: `${OUT}/setup-failed.png` });
    await browser.close();
    process.exit(1);
  }

  // Select the profile area, then start Extrude. With a region preselected the
  // tool goes straight to the drag phase — which is why the box has focus
  // before the user can press anything, and why this bug bit immediately.
  const pt = await page.evaluate(() => {
    const s = window.__sindri;
    const wr = s.overlay.regions[0];
    const p = s.viewport.projectToScreen(wr.interior3D);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(700);
  check("the profile area is selected", await page.evaluate(
    () => window.__sindri.overlay.selectedRegions().length === 1));

  await page.evaluate(() => window.__sindri.handleAction("extrude"));
  await page.waitForTimeout(800);
  check("the extrude tool is open", (await busy()).extrude === true);
  // Nothing below means anything if the caret is not really in the box.
  check("the depth box really has focus", (await boxFocused()) === true);
  const seeded = await depthField();
  check("the depth box is seeded with a distance", /^[0-9.]+$/.test(seeded ?? ""), JSON.stringify(seeded));

  // --- 1. T on an untouched box arms the pick, and leaves no letter ---------
  await page.keyboard.press("t");
  await page.waitForTimeout(500);
  const armed = await promptText();
  check("T armed the up-to target pick", AIMING.test(armed), armed.slice(0, 90));
  // T mode hides the box, so the letter has nowhere to hide either: any field
  // still on screen holding a non-number would be the reported symptom.
  const afterT = await depthField();
  check("no letter was typed into the depth box", afterT === null || /^[0-9.-]*$/.test(afterT),
    JSON.stringify(afterT));
  await page.screenshot({ path: `${OUT}/01-target-armed.png` });

  // --- 2. once a value is typed, T is TEXT ---------------------------------
  await esc(); // out of T mode, back to the depth gesture with the box restored
  check("Escape returned to the depth gesture rather than cancelling",
    (await busy()).extrude === true);
  check("the depth box has focus again", (await boxFocused()) === true);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("25");
  await page.waitForTimeout(300);
  await page.keyboard.press("t");
  await page.waitForTimeout(500);
  const typed = await depthField();
  const stillDragging = await promptText();
  check("T after a typed value stays in the field", typed === "25t", JSON.stringify(typed));
  check("and does not arm the target pick", !AIMING.test(stillDragging),
    stillDragging.slice(0, 90));
  await page.screenshot({ path: `${OUT}/02-letter-is-text.png` });

  await esc();
  check("no uncaught error over the whole run", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(`\nscreenshots in ${OUT}`);
  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall extrude target hotkey checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log(`  FAIL  the run finished — ${(e && e.message) || e}`);
  console.log("\n1 check(s) FAILED");
  process.exit(1);
});
