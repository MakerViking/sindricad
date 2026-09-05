// End-to-end check that a sketch profile area can be pre-selected for Extrude
// on a document that has NO SOLID in it yet, in a real browser.
//
// Field report 91b20cce praised this gesture ("select area ... so this is nice")
// and it was dead on exactly the document where it is most useful. Every
// successful reply is chunked, so even a build whose mesh is EMPTY (a sketch and
// nothing else) opens a stream and raises viewport.streaming — and main.ts
// answers an empty mesh with clearModel(), which did not clear that flag.
// pickSuppressed stayed true, so handleClick returned before it ever reached
// regionPickAt: clicking the profile selected nothing, silently, for the whole
// life of the document until a build WITH geometry landed.
//
// This has to be a browser test. Viewport needs WebGL2, and the flag is only
// reachable through a real chunked reply from a real sidecar — no vitest can
// stand in for either.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<token> node e2e/region_preselect_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const BASE = process.env.SC_URL || "http://localhost:5173";
const OUT = "/tmp/region_preselect_shots";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The reporter's document: one rectangle on XY, no extrude, no solid.
const doc = (w, h) => ({
  parameters: {},
  features: [
    {
      id: "f1",
      type: "sketch",
      plane: "XY",
      entities: [{ type: "rectangle", id: "e1", width: w, height: h, x: 0, y: 0 }],
    },
  ],
});

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
  const esc = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(400); };
  const clickAt = async (p) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };

  /** Load a sketch-only document and wait for its build to settle. */
  const loadSketchOnly = async (d) => {
    await page.evaluate((doc) => {
      const s = window.__sindri;
      s.store.loadDocument(doc);
      s.store.setSketchVisibility("f1", true);
      s.overlay.update(s.store.document);
    }, d);
    // Wait on the CONDITION, not a stopwatch: a shared CI runner is far slower
    // than a dev box, and a fixed sleep here would make a release gate flaky.
    await page.waitForFunction(
      () => {
        const s = window.__sindri;
        return s.overlay.regions.length > 0 && !s.store.buildState.building && !!s.store.buildState.result;
      },
      null,
      { timeout: 120000 },
    ).catch(() => {});
    await page.waitForTimeout(600); // let a build that started late settle too
  };

  /** Screen position of the first profile area's interior point. */
  const profilePoint = () => page.evaluate(() => {
    const s = window.__sindri;
    const wr = s.overlay.regions[0];
    if (!wr) return null;
    const p = s.viewport.projectToScreen(wr.interior3D);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });

  /** What the user can see after a click: the selection and the prompt banner. */
  const picked = () => page.evaluate(() => {
    const el = document.getElementById("prompt");
    return {
      selected: window.__sindri.overlay.selectedRegions().length,
      prompt: el && !el.classList.contains("hidden") ? (el.textContent ?? "") : "",
    };
  });

  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  check("the app booted with no uncaught error", errors.length === 0, errors.slice(0, 2).join(" | "));

  // The welcome screen is a modal and isChoiceOpen() is part of toolBusy(), so
  // regionPickAt returns early while it is up.
  await esc();
  check("the welcome modal is closed", (await busy()).choice === false);

  await loadSketchOnly(doc(80, 50));

  const setup = await page.evaluate(() => ({
    regions: window.__sindri.overlay.regions.length,
    edges: window.__sindri.viewport.visibleEdgeLines().length,
    status: document.getElementById("status")?.textContent ?? "",
  }));
  check("the sketch built", !/fail|error/i.test(setup.status), setup.status);
  check("a profile area is on screen", setup.regions >= 1, `${setup.regions} region(s)`);
  // The whole point of the case: no solid anywhere in the document.
  check("the document holds no solid", setup.edges === 0, `${setup.edges} edge line(s)`);
  if (!setup.regions) {
    await page.screenshot({ path: `${OUT}/setup-failed.png` });
    await browser.close();
    process.exit(1);
  }

  const pt = await profilePoint();
  check("the profile's interior point is on screen", pt != null, JSON.stringify(pt));

  // Control: the app agrees a region is under that pixel, so a failure below is
  // the pick being suppressed and not a bad aim.
  const underCursor = await page.evaluate((p) => {
    const s = window.__sindri;
    return !!s.overlay.committedRegionAtRay(s.viewport.rayFrom(p.x, p.y).ray);
  }, pt);
  check("a region really is under that pixel", underCursor === true);

  await clickAt(pt);
  const after = await picked();
  check("clicking the profile area selects it", after.selected === 1, `${after.selected} selected`);
  check("the prompt says so", /^1 profile area selected/.test(after.prompt), JSON.stringify(after.prompt));
  await page.screenshot({ path: `${OUT}/01-region-selected.png` });

  // A SECOND build with no geometry. Every empty build raises the flag again, so
  // clearing it once is not enough: this is the check that a document you keep
  // editing before the first solid exists stays pickable.
  await esc(); // drop the selection
  await loadSketchOnly(doc(60, 40));
  const pt2 = await profilePoint();
  check("the second sketch has a profile area", pt2 != null, JSON.stringify(pt2));
  await clickAt(pt2);
  const after2 = await picked();
  check("it still picks after a second empty build", after2.selected === 1, `${after2.selected} selected`);
  check("and the prompt still says so", /^1 profile area selected/.test(after2.prompt),
    JSON.stringify(after2.prompt));
  await page.screenshot({ path: `${OUT}/02-region-selected-again.png` });

  if (errors.length) console.log(`\npage errors:\n${errors.slice(0, 5).join("\n")}`);
  console.log(`\nscreenshots in ${OUT}`);
  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall profile pre-selection checks passed");
  process.exit(failures ? 1 : 0);
})();
