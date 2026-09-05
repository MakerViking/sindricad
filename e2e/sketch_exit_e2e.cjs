// Getting OUT of a sketch, in a real browser.
//
// Two field reports (d911463c, 40c85f97). Creating an Offset Plane drops you
// straight into a sketch on the new plane, and until this landed there was no
// way out of that sketch that was not a commit: Escape only returns to the
// select tool, and every 3D command finishes the sketch first. A user who
// wanted just the plane pressed the green Finish Sketch and got an empty sketch
// row in the Browser, which he then had to tick, select and delete by hand.
//
// Two things are checked here, and only a running app can check either:
//   (1) Finish on a sketch nobody drew in adds NOTHING — no feature, and no row
//       in the Browser's Sketches folder. The guard for this existed in
//       snapshotFeature() and was DEAD, because entering a sketch injects three
//       synthetic origin entities (origin.ts), so `entities.length` is never 0.
//       Unit tests cover the store; this file is the only place the BROWSER ROW
//       — the thing the reporter actually had to delete — is observed.
//   (2) The sketch ribbon now carries a Cancel Sketch button next to Finish, and
//       clicking it leaves the sketch without committing anything.
//
// The control for (1) is to revert the emptiness test in SketchMode.finish():
// run against that, "no sketch feature was added" and "the Browser lists no
// sketch" both go red, and the Browser row it prints is literally "Sketch1" —
// the row 40c85f97 had to hunt down and delete.
//
// NOT covered: the confirm dialog that Cancel Sketch raises when you HAVE drawn
// something. It is @tauri-apps/plugin-dialog, which has no host to answer it in
// a plain browser, so this file only ever cancels an untouched sketch — which is
// exactly the case both reports were stuck in.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/sketch_exit_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome).
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// The box primitive is CENTRED, so a 40x40x10 box has its top face at z = +5.
const BOX = {
  version: 5, units: "mm", parameters: {},
  features: [{ id: "b1", type: "box", length: 40, width: 40, height: 10 }],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  await page.goto(`http://localhost:5173/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // the welcome modal is part of toolBusy()
  await page.waitForTimeout(400);

  // Wait on the CONDITION, never a stopwatch, and count SETTLED builds so the
  // wait cannot return on the build that was already finished before the edit.
  await page.evaluate(() => {
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
  });
  const settle = async (act) => {
    const before = await page.evaluate(() => window.__settles);
    if (act) await act();
    await page.waitForFunction(
      (b) => window.__settles > b && !window.__sindri.store.buildState.building,
      before, { timeout: 120000 },
    ).catch(() => { console.log("  (warning: no rebuild settled within the timeout)"); });
  };

  const screenOf = (w) => page.evaluate((pt) => {
    const s = window.__sindri.viewport.projectToScreen({ x: pt[0], y: pt[1], z: pt[2] });
    return { x: Math.round(s.x), y: Math.round(s.y) };
  }, w);

  const clickAt = async (p) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(600);
  };

  /** Click a ribbon button the way the user does — through its own listener. */
  const clickRibbon = async (action) => {
    const found = await page.evaluate((a) => {
      const btn = document.querySelector(`#ribbon [data-action="${a}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    }, action);
    await page.waitForTimeout(600);
    return found;
  };

  /** What the Browser panel shows under Sketches — the rows a user would have
   *  to hunt down and delete. Reads the DOM, not the document. */
  const sketchRows = () => page.evaluate(() =>
    [...document.querySelectorAll("#browser .tree-label")]
      .map((e) => e.textContent || "")
      .filter((t) => /^Sketch\d+$/.test(t)));

  const sketchFeatures = () => page.evaluate(() =>
    window.__sindri.store.document.features.filter((f) => f.type === "sketch").map((f) => f.id));

  /** Enter a sketch on the box's top face, the way a user does: the ribbon's
   *  Sketch button, then a click on the face. Reports the plane it landed on, so
   *  a click that missed the body and fell through to the XY base plane quad
   *  cannot pass for a face pick. */
  const enterSketch = async () => {
    const topPt = await screenOf([12, 7, 5]);
    await page.evaluate(() => window.__sindri.handleAction("sketch"));
    await page.waitForTimeout(300);
    await clickAt(topPt);
    return page.evaluate(() => ({
      active: window.__sindri.sketch.active,
      z: window.__sindri.sketch.plane?.origin?.z,
    }));
  };
  const enteredOnTopFace = async () => {
    const e = await enterSketch();
    return e.active === true && Math.abs((e.z ?? 0) - 5) < 1e-6;
  };

  // The sidecar socket comes up after the page does. Loading before it connects
  // means the first settle() waits out its whole timeout for a rebuild that was
  // never requested — minutes of a CI job, for nothing. The status bar goes
  // `connected` on the first successful build, so wait on that instead.
  await page.waitForFunction(
    () => document.getElementById("status")?.className.includes("connected"),
    null, { timeout: 60000 },
  ).catch(() => console.log("  (warning: the geometry engine never reported connected)"));

  await settle(() => page.evaluate((d) => window.__sindri.store.loadDocument(d), BOX));
  await page.evaluate(() => window.__sindri.viewport.fit?.());
  await page.waitForTimeout(600);

  // ===== (1) Finish with nothing drawn leaves nothing behind ==============
  console.log("\n=== Finish on a sketch nobody drew in commits nothing ===");
  check(await enteredOnTopFace(), "the click entered a sketch on the box's top face");
  check(await page.evaluate(() =>
    !!document.querySelector('#ribbon [data-action="cancel-sketch"]')),
    "the sketch ribbon offers a way out that is not Finish");

  check(await clickRibbon("finish"), "clicked the green Finish Sketch button");
  check(await page.evaluate(() => window.__sindri.sketch.active) === false,
    "the sketch closed");
  const afterFinish = await sketchFeatures();
  check(afterFinish.length === 0, "no sketch feature was added to the document",
    JSON.stringify(afterFinish));
  const rowsAfterFinish = await sketchRows();
  check(rowsAfterFinish.length === 0,
    "and the Browser lists no sketch to hunt down and delete",
    JSON.stringify(rowsAfterFinish));

  // ===== (2) a sketch you DID draw in still commits =======================
  console.log("\n=== a sketch with geometry in it is still committed ===");
  check(await enteredOnTopFace(), "entered a second sketch on the same face");
  // A NEW sketch opens armed with Rectangle: two clicks draw one.
  const a = await page.evaluate(() => {
    const s = window.__sindri;
    const p = s.viewport.projectToScreen(s.sketch.plane.to3D(-8, -8));
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  const b = await page.evaluate(() => {
    const s = window.__sindri;
    const p = s.viewport.projectToScreen(s.sketch.plane.to3D(8, 8));
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  await clickAt(a);
  await clickAt(b);
  await settle(() => clickRibbon("finish"));
  const drawn = await sketchFeatures();
  check(drawn.length === 1, "the drawn sketch WAS committed", JSON.stringify(drawn));
  check((await sketchRows()).length === 1, "and it shows up in the Browser");

  // ===== (3) Cancel Sketch leaves without committing ======================
  console.log("\n=== Cancel Sketch leaves the sketch behind ===");
  const before = await page.evaluate(() =>
    JSON.stringify(window.__sindri.store.document.features.map((f) => f.id)));
  check(await enteredOnTopFace(), "entered a third sketch");
  check(await clickRibbon("cancel-sketch"), "clicked Cancel Sketch");
  check(await page.evaluate(() => window.__sindri.sketch.active) === false,
    "the sketch closed without a commit");
  const afterCancel = await sketchFeatures();
  check(afterCancel.length === 1,
    "the document still holds only the sketch that was drawn in",
    JSON.stringify(afterCancel));
  // The document, not the build: whether the geometry engine is still connected
  // has nothing to do with whether Cancel wrote anything.
  const after = await page.evaluate(() =>
    JSON.stringify(window.__sindri.store.document.features.map((f) => f.id)));
  check(after === before, "the whole feature list is unchanged", `${before} -> ${after}`);

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})();
