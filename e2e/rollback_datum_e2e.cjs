// Field report 9ee3fb35: "if I move the timeline marker back before the offset
// plane, the plane is still there."
//
// The unit test (src/document/activeDatumPlanes.test.ts) pins the selection
// function. This file is the only oracle for the seam it sits in: that
// `syncDatumPlanes` actually re-runs when the marker moves, and that what comes
// out of it reaches `viewport.datumQuads` — the array `pickDatumAt` and the
// click handler raycast, i.e. what makes a plane clickable, sketchable, and a
// legal press/pull "up to this plane" target.
//
// The discriminating measurement is that `buildState.result.planes` and the body
// count move correctly with the marker while `datumQuads` did not: the rollback
// marker was never broken, only the client-side overlay was blind to it. So this
// asserts on BOTH, and a run where the built model does not change is not
// evidence about the quads.
//
// Control (how to see it fail): drop the `i < opts.rollbackIndex` gate from
// activeDatumPlanes in src/document/planeOf.ts. Rolled-back arms go red, the
// end-of-timeline arm stays green.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/rollback_datum_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome).
// SC_URL overrides the dev-server origin; a vite on any port other than 5173
// also needs that origin in SINDRI_EXTRA_ORIGINS on the sidecar.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// The reporter's document, as it arrived: a tapered extrude, a face-anchored
// datum plane 36 above it (f3), and a press/pull that goes up to that datum.
const DOC = {
  version: 5, units: "mm", parameters: {}, paramDefs: {},
  sketchVisibility: { f1: true },
  features: [
    { id: "f1", type: "sketch", plane: "XY",
      entities: [{ x: 0, y: 0, id: "e0", type: "circle", radius: 28.284271247461906 }] },
    { id: "f2", type: "extrude", taper: 20, sketch: "f1", distance: 10, operation: "new",
      startOffset: 2, hiddenBodies: [], separateBodies: true,
      regions: [[-8.326672684688674e-16, -1.2281842209915794e-15, 0]],
      regionEntities: [["e0"]], regionHoleEntities: [[]] },
    { id: "f3", type: "datumPlane", offset: 36,
      face: { by: "nearest", body: "body1", kind: "face",
        point: [8.838312069289294, -16.24658178191268, 11.999999999999991] },
      plane: { xdir: [1, 0, 0], normal: [0, 0, 1], origin: [0, 0, 11.999999999999991] } },
    { id: "f5", type: "press-pull", body: "body1", distance: -5, operation: "join",
      upToPlane: "f3", upToOffset: 10,
      face: { by: "nearest", kind: "face", point: [5.676980336507161, 5.937655766805013, 12] } },
  ],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  await page.goto(`${process.env.SC_URL || "http://localhost:5173"}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal
  await page.waitForTimeout(400);

  // Wait on settled BUILDS, never a stopwatch, and require the counter to
  // advance — right after a mutation the store still holds the previous build,
  // already settled, so "not building" returns instantly and every assertion
  // measures the model one edit ago.
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
    await page.waitForTimeout(250); // the doc-change repaint runs off the build event
  };

  const read = () => page.evaluate(() => ({
    quads: window.__sindri.viewport.datumQuads.map((q) => q.userData.datumId),
    planes: window.__sindri.store.buildState.result?.planes ?? null,
    bodies: window.__sindri.store.buildState.result?.bodies?.length ?? 0,
  }));

  // Hit-test where the quad sits (world 0,0,48 — source face z=12 plus offset
  // 36). This is the consequence the report is really about: `pickDatumAt` is
  // what the right-click menu and Press/Pull's "up to this plane" target pick
  // go through, so a null here is the plane no longer being a live target.
  const pickAtPlane = () => page.evaluate(() => {
    const v = window.__sindri.viewport;
    const s = v.projectToScreen({ x: 0, y: 0, z: 48 });
    return v.pickDatumAt(Math.round(s.x), Math.round(s.y));
  });

  await settle(() => page.evaluate((d) => window.__sindri.store.loadDocument(d), DOC));

  console.log("\n=== marker at the end: the plane is part of the model, so it is drawn ===");
  await settle(() => page.evaluate(() => window.__sindri.store.setRollback(4)));
  let s = await read();
  check(s.bodies === 1, "the model built", `bodies=${s.bodies}`);
  check(!!s.planes && !!s.planes.f3, "the rebuild resolved the datum", JSON.stringify(s.planes));
  check(s.quads.includes("f3"), "and its quad is in the scene", JSON.stringify(s.quads));
  // The control for every "pick returns null" below: it has to be able to hit at all.
  check(await pickAtPlane() === "f3", "and a ray at the plane hits it");

  console.log("\n=== marker rolled back before the plane — the report ===");
  for (const at of [2, 1, 0]) {
    await settle(() => page.evaluate((i) => window.__sindri.store.setRollback(i), at));
    s = await read();
    // The control: the BUILD must actually have moved, or the quad reading below
    // is not evidence of anything.
    check(s.planes === null,
      `marker ${at}: the sidecar did not build the datum`, JSON.stringify(s.planes));
    check(s.bodies === (at >= 2 ? 1 : 0),
      `marker ${at}: the built body count followed the marker`, `bodies=${s.bodies}`);
    check(!s.quads.includes("f3"),
      `marker ${at}: the quad is GONE from the scene — not drawn, not pickable`,
      JSON.stringify(s.quads));
    check(await pickAtPlane() === null,
      `marker ${at}: and a ray at the plane hits nothing — no sketch/press-pull target`);
  }

  console.log("\n=== rolling forward again brings it back ===");
  await settle(() => page.evaluate(() => window.__sindri.store.setRollback(4)));
  s = await read();
  check(s.quads.includes("f3"), "the quad is back", JSON.stringify(s.quads));

  console.log("\n=== suppressing the plane hides it too (same omission, no rollback) ===");
  await settle(() => page.evaluate(() => window.__sindri.store.toggleSuppress("f3")));
  s = await read();
  check(s.planes === null, "the suppressed datum was not built", JSON.stringify(s.planes));
  check(!s.quads.includes("f3"), "and its quad is gone", JSON.stringify(s.quads));
  await settle(() => page.evaluate(() => window.__sindri.store.toggleSuppress("f3")));
  s = await read();
  check(s.quads.includes("f3"), "unsuppressing brings it back", JSON.stringify(s.quads));

  console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILED`}`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
