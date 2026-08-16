// End-to-end check of the Press/Pull DISPATCHER, in a real browser.
//
// Field report: a tester wanted to press/pull a single hole in a bolt circle
// and could not — Press/Pull understood body faces and nothing else, so a click
// on a sketch profile fell through pickFaceForPressPull and orbited the camera.
// Press/Pull now dispatches: face -> Press/Pull, sketch profile -> Extrude,
// edge -> Fillet.
//
// Unit tests (src/features/pressPullTool.test.ts) pin the decision table with
// fakes. This is the one that presses the key and clicks the pixel: a real
// sidecar build, a real Picker over real geometry, real pointer events. The
// unit tests cannot see EDGE_NEAR_PX, the depth cutoff, or whether the region
// under the cursor is the one the user aimed at.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<token> node e2e/presspull_dispatch_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const OUT = "/tmp/presspull_dispatch_shots";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A 60x60 plate with a centred hole, extruded 10mm: the shape the reporter
// described. The sketch stays in the document so its profiles can be clicked
// while the solid is also on screen — which is exactly the ambiguous case.
const DOC = {
  parameters: {},
  features: [
    {
      id: "f1",
      type: "sketch",
      plane: "XY",
      entities: [
        { type: "rectangle", id: "e1", width: 60, height: 60, x: 0, y: 0 },
        { type: "circle", id: "e2", radius: 8, x: 0, y: 0 },
      ],
    },
    {
      id: "f2",
      type: "extrude",
      sketch: "f1",
      distance: 10,
      operation: "new",
      regions: [[-25, -25, 0]], // inside the plate, outside the hole
      hiddenBodies: [],
    },
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
  const esc = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(400); };
  const clickAt = async (p) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  /** screen position of a world point */
  const screenOf = (w) => page.evaluate((pt) => {
    const s = window.__sindri.viewport.projectToScreen({ x: pt[0], y: pt[1], z: pt[2] });
    return { x: Math.round(s.x), y: Math.round(s.y) };
  }, w);

  await page.goto(`http://localhost:5173/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });

  // A module-init abort is the failure mode that once shipped a dead keyboard;
  // __sindri existing at all proves main.ts ran to the end.
  check("the app booted with no uncaught error", errors.length === 0, errors.slice(0, 2).join(" | "));

  // The welcome screen is a modal and isChoiceOpen() is part of toolBusy(), so
  // every start* returns early while it is up.
  await esc();
  check("the welcome modal is closed", (await busy()).choice === false);

  await page.evaluate((doc) => {
    const s = window.__sindri;
    s.store.loadDocument(doc);
    s.store.setSketchVisibility("f1", true); // an extrude normally consumes its sketch
    s.overlay.update(s.store.document);
  }, DOC);

  // Wait on the CONDITION, not a stopwatch: a shared CI runner is far slower
  // than a dev box, and this job gates the release — a fixed sleep here would
  // make it flaky, and a flaky gate gets un-gated sooner or later.
  await page.waitForFunction(
    () => window.__sindri.overlay.regions.length > 0
      && window.__sindri.viewport.visibleEdgeLines().length > 0,
    null,
    { timeout: 120000 },
  ).catch(() => {});

  const built = await page.evaluate(() => ({
    regions: window.__sindri.overlay.regions.length,
    bodies: window.__sindri.viewport.visibleEdgeLines().length > 0,
    status: document.getElementById("status")?.textContent ?? "",
  }));
  check("the document built", !/fail|error/i.test(built.status), built.status);
  check("profiles and a solid are both on screen", built.regions >= 1 && built.bodies,
    `${built.regions} region(s), edges=${built.bodies}`);
  if (!built.regions || !built.bodies) {
    await page.screenshot({ path: `${OUT}/setup-failed.png` });
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({ path: `${OUT}/01-setup.png` });

  // --- profile -> Extrude (the reported gesture) ----------------------------
  const profilePt = await page.evaluate(() => {
    const s = window.__sindri;
    const wr = s.overlay.regions[0];
    const p = s.viewport.projectToScreen(wr.interior3D);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  await page.evaluate(() => window.__sindri.handleAction("presspull"));
  check("Press/Pull arms with nothing selected", (await busy()).pressPull === true);

  await clickAt(profilePt);
  const afterProfile = await page.evaluate(() => ({
    busy: window.__sindri.busyWhy(),
    regions: window.__sindri.overlay.selectedRegions().length,
  }));
  check("clicking a sketch profile hands off to Extrude", afterProfile.busy.extrude === true,
    JSON.stringify(afterProfile.busy));
  check("Press/Pull stood down", afterProfile.busy.pressPull === false);
  check("Extrude got exactly the clicked profile", afterProfile.regions === 1, `${afterProfile.regions} selected`);
  await page.screenshot({ path: `${OUT}/02-profile-to-extrude.png` });

  await esc();
  const released = await page.evaluate(() => ({
    busy: window.__sindri.busyWhy(),
    suspendPicking: window.__sindri.viewport.suspendPicking,
  }));
  check("Esc releases every tool", Object.values(released.busy).every((v) => !v), JSON.stringify(released.busy));
  // A handoff that skipped cleanup() would leave this raised and the viewport
  // would never pick again for the rest of the session.
  check("the viewport picks again afterwards", released.suspendPicking === false);

  // --- a pre-selected FACE still wins ---------------------------------------
  // The right-click "Press/Pull face" menu selects a face and dispatches through
  // startPressPull, and selectOnlyFace clears only the highlighter — NOT the
  // overlay's region selection. Checking regions first would break that menu for
  // anyone with a profile still selected, so this pins the order.
  const sidePt = await screenOf([30, 0, 5]); // +X side wall, no profile over it
  const faceId = await page.evaluate((p) => {
    const hit = window.__sindri.viewport.pickFaceForPressPull(p.x, p.y);
    return hit ? hit.faceId : null;
  }, sidePt);
  check("a side face is pickable for the menu case", faceId != null, `faceId=${faceId}`);

  if (faceId != null) {
    await page.evaluate((fid) => {
      const s = window.__sindri;
      s.overlay.toggleRegionSelection(s.overlay.regions[0], false); // a profile IS selected
      s.viewport.selectOnlyFace(fid);                               // as the context menu does
      s.handleAction("presspull");
    }, faceId);
    await page.waitForTimeout(500);
    const menu = await busy();
    check("a selected face beats a selected profile", menu.pressPull === true, JSON.stringify(menu));
    check("it did not divert to Extrude", menu.extrude === false);
    await esc();
    await page.evaluate(() => window.__sindri.overlay.clearRegionSelection());
  }

  // --- with the sketch hidden: face -> Press/Pull, edge -> Fillet -----------
  await page.evaluate(() => {
    const s = window.__sindri;
    s.viewport.clearSelection();
    s.store.setSketchVisibility("f1", false);
    s.overlay.update(s.store.document);
  });
  await page.waitForTimeout(600);
  check("hiding the sketch removes its profiles",
    (await page.evaluate(() => window.__sindri.overlay.regions.length)) === 0);

  const topPt = await screenOf([20, 20, 10]); // top face, well clear of the hole
  await page.evaluate(() => window.__sindri.handleAction("presspull"));
  await clickAt(topPt);
  const afterFace = await busy();
  // The whole point of the change is that this case is UNTOUCHED.
  check("clicking a body face still Press/Pulls it", afterFace.pressPull === true,
    JSON.stringify(afterFace));
  check("it did not divert to Extrude or Fillet",
    afterFace.extrude === false && afterFace.edgeFeature === false);
  await page.screenshot({ path: `${OUT}/03-face-to-presspull.png` });
  await esc();

  // An edge of the top rim: take a real edge from the model and aim at its
  // midpoint, so the click lands inside EDGE_NEAR_PX the way a user's would.
  const edgePt = await page.evaluate(() => {
    const s = window.__sindri;
    const lines = s.viewport.visibleEdgeLines();
    let best = null, bestLen = -1;
    for (const e of lines) {
      const pts = e.points;
      if (!pts || pts.length < 2) continue;
      const a = pts[0], b = pts[pts.length - 1];
      const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (len > bestLen) { bestLen = len; best = e; }
    }
    if (!best) return null;
    const pts = best.points;
    const m = pts[Math.floor(pts.length / 2)];
    const p = s.viewport.projectToScreen({ x: m[0], y: m[1], z: m[2] });
    return { x: Math.round(p.x), y: Math.round(p.y), len: bestLen };
  });
  check("an edge midpoint is addressable", edgePt != null, edgePt ? `len=${edgePt.len.toFixed(1)}mm` : "no edges");

  if (edgePt) {
    // Confirm the app itself agrees an edge is under that pixel, so a failure
    // below is the dispatch and not a bad aim.
    const isEdge = await page.evaluate((p) => {
      const h = window.__sindri.viewport.pickEntity(p.x, p.y);
      return h ? h.kind : null;
    }, edgePt);
    check("the app sees an edge under that pixel", isEdge === "edge", `pickEntity -> ${isEdge}`);

    await page.evaluate(() => window.__sindri.handleAction("presspull"));
    await clickAt(edgePt);
    const afterEdge = await busy();
    check("clicking an edge hands off to Fillet", afterEdge.edgeFeature === true, JSON.stringify(afterEdge));
    check("Press/Pull stood down for the edge", afterEdge.pressPull === false);
    await page.screenshot({ path: `${OUT}/04-edge-to-fillet.png` });
    await esc();
  }

  const end = await page.evaluate(() => ({
    busy: window.__sindri.busyWhy(),
    suspendPicking: window.__sindri.viewport.suspendPicking,
  }));
  check("nothing is left armed at the end", Object.values(end.busy).every((v) => !v), JSON.stringify(end.busy));
  check("the viewport is still pickable at the end", end.suspendPicking === false);

  if (errors.length) console.log(`\npage errors:\n${errors.slice(0, 5).join("\n")}`);
  console.log(`\nscreenshots in ${OUT}`);
  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall Press/Pull dispatch checks passed");
  process.exit(failures ? 1 : 0);
})();
