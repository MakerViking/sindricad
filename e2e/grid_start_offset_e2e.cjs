// The ground grid must not float up with an extrude's Start offset, in a real app.
//
// Field report 04191fb5 (0.1.214, Windows): "When I use extrude and have a
// 'Start offset' it creates the offset on the body correctly but it moves the
// grid 'plane' with the offset, so the origin is left hanging in space. If I
// 'show' the sketch it moves the grid plane back to where I expect it to be."
//
// The grid floor (`targetGridZ = model.box.min.z`) was applied unclamped, so a
// startOffset of 5 lifted the grid 5 mm while the origin marker stayed at world
// (0,0,0). Only a running app measures this: the value comes off a rebuilt
// model's bounding box, travels through the render loop, and lands on a three
// group's position. A unit test can check the clamp; it cannot check that the
// clamp is the number the viewport actually renders with this document.
//
// The second half of the report is a PERCEPTION, and this file pins it as such:
// showing the sketch does not move the grid (it never did) — what appears at
// z=0 is the sketch's own translucent region, drawn on its XY plane where the
// user expects the grid. Asserting the grid is UNCHANGED across the toggle is
// what keeps a future "fix" from making the grid chase sketch visibility.
//
// Controls, so a pass cannot be vacuous:
//   - the offset must really be in the model (box.min.z ~ 5), so the test cannot
//     go green by the extrude silently dropping startOffset;
//   - a second document whose body hangs BELOW the origin must still pull the
//     grid down with it, so the fix cannot be "pin the grid at 0 forever".
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/grid_start_offset_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running against a side-port worktree.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// 04191fb5's document, verbatim: a 53.90 x 39.02 rectangle on XY, a datum plane
// 43.5 up, and a tapered 30 mm extrude with startOffset 5. The offset is the
// whole point — the body spans z 5..35 and nothing else in the document does.
const DOC = {
  version: 5,
  paramDefs: {}, parameters: {},
  features: [
    { id: "f1", type: "sketch", plane: "XY",
      entities: [{ id: "e0", type: "rectangle",
                   x: -4.8997177791013655, y: -3.786145556578333,
                   width: 53.89689557011506, height: 39.01957067720727 }] },
    { id: "f2", type: "datumPlane", plane: "XY", offset: 43.5 },
    { id: "f3", type: "extrude", sketch: "f1", distance: 30, taper: -5,
      startOffset: 5, operation: "new",
      regions: [[-4.8997177791013655, -3.786145556578333, 0]],
      regionEntities: [["e0"]], regionHoleEntities: [[]],
      separateBodies: true, hiddenBodies: [] },
  ],
  sketchVisibility: { f1: false },
};

// The same part pushed under the origin: the grid floor must still follow it
// down, or the fix has thrown away the feature instead of clamping it.
const BELOW = JSON.parse(JSON.stringify(DOC));
BELOW.features[2].startOffset = -40; // body spans z -40..-10

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal
  await page.waitForTimeout(400);

  // Wait on the CONDITION, never a stopwatch, and require a build to ADVANCE —
  // right after a mutation the store still holds the previous, already settled
  // build, so "not building" returns instantly and measures the model as it was.
  await page.evaluate(() => {
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
  });
  const load = async (doc) => {
    const before = await page.evaluate(() => window.__settles);
    await page.evaluate((d) => window.__sindri.store.loadDocument(d), doc);
    await page.waitForFunction(
      (b) => window.__settles > b && !window.__sindri.store.buildState.building,
      before, { timeout: 120000 },
    ).catch(() => console.log("  (warning: no rebuild settled within the timeout)"));
    // One more painted frame, so grid.update has run with the new targetGridZ.
    await page.evaluate(() => window.__sindri.viewport.requestRender());
    await page.waitForTimeout(400);
  };

  // grid.group.position.z is the rendered value; targetGridZ is what fed it.
  const read = () => page.evaluate(() => {
    const vp = window.__sindri.viewport;
    const r = (n) => (typeof n === "number" ? +n.toFixed(4) : n);
    return {
      bodies: vp.model?.bodies.length ?? 0,
      boxMinZ: r(vp.model?.box.min.z),
      gridZ: r(vp.scene.grid.group.position.z),
      sketchVisible: window.__sindri.store.sketchVisibilityOverride("f1") === true,
    };
  });

  await load(DOC);
  const hidden = await read();
  console.log("  sketch hidden:", JSON.stringify(hidden));

  check(hidden.bodies === 1, "the reporter's part built", `bodies=${hidden.bodies}`);
  // The padding on result.bbox is ~0.25 mm either end, hence the band.
  check(Math.abs(hidden.boxMinZ - 5) < 0.5,
    "the 5 mm Start offset really is in the model (or this test proves nothing)",
    `box.min.z=${hidden.boxMinZ}`);
  check(hidden.gridZ === 0,
    "the grid stayed on the XY plane, where the origin marker is",
    `grid z=${hidden.gridZ}`);

  // Showing the sketch must change nothing about the grid. It never did — the
  // reporter saw the sketch's own region fill appear at z=0. This is the path
  // the Browser's eye icon takes (tree.onToggleSketch in main.ts).
  await page.evaluate(() => {
    const { store, overlay, viewport } = window.__sindri;
    store.setSketchVisibility("f1", true);
    overlay.update(store.document);
    viewport.requestRender();
  });
  await page.waitForTimeout(400);
  const shown = await read();
  console.log("  sketch shown: ", JSON.stringify(shown));
  check(shown.sketchVisible, "the sketch is actually shown now", `visible=${shown.sketchVisible}`);
  check(shown.gridZ === hidden.gridZ,
    "showing the sketch does not move the grid",
    `${hidden.gridZ} -> ${shown.gridZ}`);

  await load(BELOW);
  const below = await read();
  console.log("  body below origin:", JSON.stringify(below));
  check(Math.abs(below.boxMinZ + 40) < 0.5,
    "the control part really is below the origin", `box.min.z=${below.boxMinZ}`);
  check(Math.abs(below.gridZ - below.boxMinZ) < 0.01,
    "the grid still drops to stay under a model below the origin",
    `grid z=${below.gridZ}`);

  await browser.close();
  console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
