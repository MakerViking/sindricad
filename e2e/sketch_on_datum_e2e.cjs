// Sketch, then click a construction plane: the sketch must land ON that plane.
//
// Field reports 82e8d565 (0.1.265) and bcbee3fe (0.1.269), both from Doug:
//   "I used a couple primitives to create a random Reference Plane. I expected
//    to be able to create a sketch on that plane. I cannot select the plane
//    for the sketch."
//   "I am able to create an offset surface and sketch on it. Am I
//    misunderstanding the purpose of a reference plane?"
// He cut one box with a tilted second box, put a Datum Plane on the slanted
// cut face, removed the body, then pressed Sketch and clicked the plane. The
// Sketch command's plane pick only ever offered body faces and the three base
// planes, so the click on the plane did nothing at all; Offset Plane worked
// because it makes its plane AND enters the sketch in one go. The only way in
// was a right-click on the plane, which nothing pointed him to.
//
// Entered where he entered: the Sketch command, then a real click on the
// plane's quad. The effect read back is the stored sketch: it must carry the
// datum's id (so it follows the plane's Offset) and sit on the tilted plane.
// Two controls keep the pass honest: a click on bare canvas next to the quad
// still enters nothing, and in the second document a body face in front of a
// plane still wins over the plane behind it.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/sketch_on_datum_e2e.cjs
// SC_CHROME overrides the browser binary, and SC_URL the dev server, for
// running against a side-port worktree.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// 82e8d565's document exactly as it arrived: the datum f5 sits on the slanted
// face the cut left on body1, and f6 then removes body1, so nothing but the
// plane is left on screen.
const DOUG = {
  version: 7, paramDefs: {}, parameters: {},
  features: [
    { x: 0, y: 0, z: 19.049999999999997, id: "f1", type: "box", width: 38.099999999999994,
      height: 38.099999999999994, length: 38.099999999999994, onGrid: true },
    { x: 0, y: 0, z: 10, id: "f2", type: "box", width: 50.8, height: 20, length: 50.8, onGrid: true },
    { dx: 25.4, dy: 0, dz: 25.4, id: "f3", rx: 15, ry: 25, rz: 0, type: "move", pivot: [0, 0, 10], bodies: ["body2"] },
    { id: "f4", type: "combine", tools: ["body2"], target: "body1", operation: "cut", joinTouchingOnly: true },
    { id: "f5", type: "datumPlane", offset: 0,
      face: { by: "nearest", body: "body1", kind: "face",
              point: [13.096758595521363, 11.821203120150171, 33.08395032129729] },
      plane: { xdir: [-0.7654278009434211, 0.4248424860291852, 0.4833519872799327],
               normal: [0.4226182526954875, -0.2345697254465585, 0.8754260999036638],
               origin: [13.407389298248408, -7.441627536402987, 27.772530997880985] } },
    { id: "f6", type: "removeBody", bodies: ["body1"] },
  ],
  sketchVisibility: { f2: true, f3: true },
};
const N = [0.4226182526954875, -0.2345697254465585, 0.8754260999036638];

// A plain 40 mm box (centred, top at z=5) with a datum 30 above its top face:
// from the top view the box's face is in front of the plane's middle.
const BOX_UNDER = {
  version: 7, paramDefs: {}, parameters: {},
  features: [
    { id: "b1", type: "box", length: 40, width: 40, height: 10 },
    { id: "d1", type: "datumPlane", plane: "XY", offset: 35 },
  ],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY: the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // the welcome modal is part of toolBusy()
  await page.waitForTimeout(400);

  // Wait on a build that ADVANCES: right after a mutation the store still
  // holds the previous, already settled build.
  await page.evaluate(() => {
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
  });
  const settle = async (act) => {
    const before = await page.evaluate(() => window.__settles);
    await act();
    await page.waitForFunction(
      (b) => window.__settles > b && !window.__sindri.store.buildState.building,
      before, { timeout: 120000 },
    ).catch(() => console.log("  (warning: no rebuild settled within the timeout)"));
    await page.waitForTimeout(400);
  };
  const load = (doc) => settle(() => page.evaluate((d) => window.__sindri.store.loadDocument(d), doc));

  /** Screen pixel of the quad's centre nudged `frac` of its size along its own
   *  local x, and whether that pixel is bare canvas over the quad. */
  const quadPixel = (id, frac) => page.evaluate(([id, frac]) => {
    const vp = window.__sindri.viewport;
    const q = vp.datumQuads.find((m) => m.userData.datumId === id);
    if (!q) return null;
    q.updateMatrixWorld(true);
    q.geometry.computeBoundingBox();
    const bb = q.geometry.boundingBox;
    const local = { x: (bb.min.x + bb.max.x) / 2 + frac * (bb.max.x - bb.min.x), y: (bb.min.y + bb.max.y) / 2, z: 0 };
    const w = q.localToWorld(new q.position.constructor(local.x, local.y, local.z));
    const s = vp.projectToScreen({ x: w.x, y: w.y, z: w.z });
    const x = Math.round(s.x), y = Math.round(s.y);
    return { x, y, onCanvas: document.elementFromPoint(x, y) === vp.domElement };
  }, [id, frac]);

  const sketchState = () => page.evaluate(() => {
    const sk = window.__sindri.sketch;
    const p = sk.plane;
    return {
      active: !!sk.active,
      planeId: sk.planeId ?? null,
      normal: p ? [p.n.x, p.n.y, p.n.z] : null,
      origin: p ? [p.origin.x, p.origin.y, p.origin.z] : null,
    };
  });

  const click = async (p) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(500);
  };

  console.log("\n=== 82e8d565: Sketch, then click the reference plane ===");
  await load(DOUG);
  await page.evaluate(() => window.__sindri.viewport.fit?.());
  await page.waitForTimeout(1200);
  const pre = await page.evaluate(() => ({
    quads: window.__sindri.viewport.datumQuads.map((q) => q.userData.datumId),
    bodies: window.__sindri.store.buildState.result?.bodies?.length ?? 0,
    errors: (window.__sindri.store.buildState.result?.errors ?? []).length,
  }));
  check(pre.quads.includes("f5"), "the reference plane is drawn", `quads=${pre.quads}`);
  check(pre.bodies === 0 && pre.errors === 0, "and the body it came from is gone, cleanly",
    `bodies=${pre.bodies} errors=${pre.errors}`);

  // control first: Sketch, then bare canvas off to the side enters nothing
  await page.evaluate(() => window.__sindri.handleAction("sketch"));
  await page.waitForTimeout(300);
  await click({ x: 60, y: 760 });
  let s = await sketchState();
  check(!s.active, "a click on bare canvas enters no sketch (control)", `active=${s.active}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const at = await quadPixel("f5", 0.3);
  check(!!at && at.onCanvas, "a pixel on the plane is bare canvas", JSON.stringify(at));
  await page.evaluate(() => window.__sindri.handleAction("sketch"));
  await page.waitForTimeout(300);
  await click(at);
  s = await sketchState();
  check(s.active, "Sketch + click on the plane enters a sketch", `active=${s.active}`);
  check(s.planeId === "f5", "linked to the plane by id", `planeId=${s.planeId}`);
  const dot = s.normal ? Math.abs(s.normal[0] * N[0] + s.normal[1] * N[1] + s.normal[2] * N[2]) : 0;
  check(dot > 0.999999, "on the tilted plane, not a base plane behind it", `|n.n_datum|=${dot}`);

  if (s.active) {
    // draw a rectangle and close the sketch, then read what was STORED
    const corner = (u, v) => page.evaluate(([u, v]) => {
      const sk = window.__sindri.sketch;
      const p = window.__sindri.viewport.projectToScreen(sk.plane.to3D(u, v));
      return { x: Math.round(p.x), y: Math.round(p.y) };
    }, [u, v]);
    await click(await corner(-5, -5));
    await click(await corner(5, 5));
    await settle(() => page.evaluate(() => window.__sindri.sketch.finish(true)));
    const stored = await page.evaluate(() => {
      const fs = window.__sindri.store.document.features;
      const f = fs[fs.length - 1];
      return { type: f.type, planeId: f.planeId ?? null, entities: (f.entities ?? []).length,
               errors: (window.__sindri.store.buildState.result?.errors ?? []).map((e) => e.message ?? String(e)) };
    });
    check(stored.type === "sketch" && stored.planeId === "f5" && stored.entities > 0,
      "the stored sketch holds its rectangle on plane f5", JSON.stringify(stored));
    check(stored.errors.length === 0, "and the document rebuilds without errors", JSON.stringify(stored.errors));
  }

  console.log("\n=== a body face in front of a plane still wins ===");
  await page.keyboard.press("Escape");
  await load(BOX_UNDER);
  await page.evaluate(() => window.__sindri.viewport.setStandardView("top"));
  await page.waitForTimeout(1200);
  const mid = await page.evaluate(() => {
    const s = window.__sindri.viewport.projectToScreen({ x: 3, y: 4, z: 5 });
    return { x: Math.round(s.x), y: Math.round(s.y) };
  });
  await page.evaluate(() => window.__sindri.handleAction("sketch"));
  await page.waitForTimeout(300);
  await click(mid);
  s = await sketchState();
  check(s.active && s.planeId === null && s.origin && Math.abs(s.origin[2] - 5) < 1e-6,
    "over the box the top face is taken, not the plane in front of it", JSON.stringify(s));
  await page.evaluate(() => window.__sindri.sketch.finish?.(false));

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall good");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
