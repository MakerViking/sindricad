// A construction plane must not draw a line ACROSS the body, in a real browser.
//
// Field report f45fe95c (Linux, 0.1.203): "there were some lines overlaying the
// surface of the body … they were in space because they moved as I rotated the
// body". His geometry was clean — 1 body, 12 edges, nothing stray. What he saw
// was the datum quad: it was a hardcoded 80x80 mm and his part is 83.72 mm
// across, so the quad's boundary STOPPED 1.86 mm inside each end of the top
// face. The plane floats 20 mm above that face, so the boundary's projection
// walked across the face as the camera orbited.
//
// This is the only oracle for that. Nothing about it is visible to a unit test:
// the quad geometry is correct at every size, and whether its edge lands on the
// solid depends on the camera. The sizing constant is a rendered-result value —
// a quad of 1.25 x the model diagonal passes a "covers the footprint" assertion
// and still cut the top face at the iso view (measured: 434 edge pixels).
//
// What it measures, per camera view:
//   silhouette  pixels that are the solid (frame with the model shown vs hidden)
//   tinted      of those, the ones the datum group changes — plane over solid
//   edge        of those, the ones with an untinted solid neighbour — i.e. the
//               plane's boundary landing ON the body. THAT is the reported line.
//
// The control matters as much as the assertion: the same measurement is repeated
// with the pre-fix 80x80 forced back on, and is required to be RED. Without it
// "0 edge pixels" would also pass if datum planes stopped being drawn at all.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/datum_plane_quad_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running against a side-port worktree.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";

const W = 1280, H = 800;
// Antialiasing puts a handful of pixels either side of any silhouette, so the
// gate is a band, not a hard zero. Measured on this document, the two sides of
// it are far apart — 0 with the sized quad, 236-410 with the old one — so
// nothing hinges on where in the band the line is drawn.
const EDGE_BUDGET = 25;

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// f45fe95c's document, as it arrived: an 83.72 x 39.59 rectangle centred on the
// origin, extruded 21.858, a datum plane 48 above the top face, and a press/pull
// up to that plane less 20 — which leaves the body 49.858 tall with the plane
// floating 20 mm over it. The exact numbers are the point: the part is WIDER
// than the 80 mm quad that used to be drawn.
const DOC = {
  version: 5,
  paramDefs: {}, parameters: {},
  features: [
    { id: "f1", type: "sketch", plane: "XY",
      entities: [{ id: "e0", type: "rectangle", x: 0, y: 0,
                   width: 83.72094366902493, height: 39.58804622063894 }] },
    { id: "f2", type: "extrude", sketch: "f1", distance: 21.858, operation: "new",
      regions: [[0, 0, 0]], regionEntities: [["e0"]], regionHoleEntities: [[]],
      separateBodies: true, hiddenBodies: [] },
    { id: "f3", type: "datumPlane", offset: 48,
      face: { by: "nearest", body: "body1", kind: "face",
              point: [23.161933836300214, -12.57192361964036, 21.857999801635746] },
      plane: { origin: [0, 0, 21.857999801635746], normal: [0, 0, 1], xdir: [1, 0, 0] } },
    { id: "f4", type: "press-pull", body: "body1", distance: 0, operation: "join",
      face: { by: "nearest", kind: "face",
              point: [-13.9534912109375, 6.5980078379313145, 21.857999801635746] },
      upToPlane: "f3", upToOffset: -20 },
  ],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
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
  const before = await page.evaluate(() => window.__settles);
  await page.evaluate((d) => window.__sindri.store.loadDocument(d), DOC);
  await page.waitForFunction(
    (b) => window.__settles > b && !window.__sindri.store.buildState.building,
    before, { timeout: 120000 },
  ).catch(() => console.log("  (warning: no rebuild settled within the timeout)"));

  const built = await page.evaluate(() => ({
    bodies: window.__sindri.viewport.model?.bodies.length ?? 0,
    quads: window.__sindri.viewport.datumQuads.length,
    quadMm: (() => {
      const q = window.__sindri.viewport.datumQuads[0];
      if (!q) return 0;
      q.geometry.computeBoundingBox();
      const bb = q.geometry.boundingBox;
      return +(bb.max.x - bb.min.x).toFixed(2);
    })(),
    bodyX: (() => {
      const b = window.__sindri.viewport.model?.box;
      return b ? +(b.max.x - b.min.x).toFixed(2) : 0;
    })(),
  }));
  check(built.bodies === 1, "the reporter's part built", `bodies=${built.bodies}`);
  check(built.quads === 1, "and its construction plane is drawn", `quads=${built.quads}`);
  check(built.quadMm > built.bodyX,
    "the quad is wider than the part it hovers over",
    `quad ${built.quadMm} mm vs body ${built.bodyX} mm`);

  const setVis = async (datum, model) => {
    await page.evaluate(({ datum, model }) => {
      const vp = window.__sindri.viewport;
      vp.datumGroup.visible = datum;
      vp.scene.modelGroup.visible = model;
      // The body's own edge lines are drawn OVER its faces and the plane's tint
      // alike, so they read as untinted solid pixels and put a floor of ~80 px
      // under the edge count that has nothing to do with the plane (measured:
      // identical at a 184 mm and a 263 mm quad). They are not what is being
      // measured, so they are off for the whole comparison.
      for (const b of vp.model.bodies) b.edges.object.visible = false;
      if (vp.model.orphanEdges) vp.model.orphanEdges.object.visible = false;
      vp.requestRender();
    }, { datum, model });
    await page.waitForTimeout(700);
  };
  // Screenshotting a software-rasterised WebGL page occasionally comes back
  // "Unable to capture screenshot" on a loaded machine; it succeeds on a retry,
  // and a flaky capture must not read as a passing measurement.
  const shot = async () => {
    for (let i = 0; ; i++) {
      try {
        return (await page.screenshot({ type: "png" })).toString("base64");
      } catch (e) {
        if (i >= 3) throw e;
        await page.waitForTimeout(1000);
      }
    }
  };

  /** Count solid pixels the datum group paints, and how many of those sit on the
   *  boundary of that paint — a tinted solid pixel next to an untinted one. */
  async function measure() {
    await setVis(false, true);
    const a1 = await shot();
    const a2 = await shot(); // the fps HUD animates; anything that moved is masked out
    await setVis(false, false);
    const bg = await shot();
    await setVis(true, true);
    const d = await shot();
    return page.evaluate(async ([a1, a2, bg, d, W, H]) => {
      const px = async (b64) => {
        const blob = await (await fetch("data:image/png;base64," + b64)).blob();
        const bm = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bm.width, bm.height);
        c.getContext("2d").drawImage(bm, 0, 0);
        return c.getContext("2d").getImageData(0, 0, bm.width, bm.height).data;
      };
      const [A, A2, BG, D] = await Promise.all([px(a1), px(a2), px(bg), px(d)]);
      const differs = (X, Y, i) => Math.abs(X[i] - Y[i]) > 6
        || Math.abs(X[i + 1] - Y[i + 1]) > 6 || Math.abs(X[i + 2] - Y[i + 2]) > 6;
      const body = new Uint8Array(W * H);
      const tint = new Uint8Array(W * H);
      let silhouette = 0, tinted = 0;
      for (let p = 0; p < W * H; p++) {
        const i = p * 4;
        if (differs(A, A2, i)) continue;   // unstable pixel (animated HUD)
        if (!differs(A, BG, i)) continue;  // not the solid
        body[p] = 1; silhouette++;
        if (differs(D, A, i)) { tint[p] = 1; tinted++; }
      }
      let edge = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const p = y * W + x;
          if (!body[p] || !tint[p]) continue;
          if ((body[p - 1] && !tint[p - 1]) || (body[p + 1] && !tint[p + 1])
            || (body[p - W] && !tint[p - W]) || (body[p + W] && !tint[p + W])) edge++;
        }
      }
      return { silhouette, tinted, edge };
    }, [a1, a2, bg, d, W, H]);
  }

  // A view change is an ANIMATED transition, and setStandardView reuses whatever
  // distance the controls happen to hold when it is called — so firing it after
  // an unfinished fit frames the part at an arbitrary scale and every pixel count
  // moves with it. Turn the view first, let it land, and only then snap the
  // distance with a NON-animated fit, which is deterministic.
  const stillCamera = () => page.waitForFunction(() => {
    const p = window.__sindri.viewport.camera.position;
    const now = `${p.x},${p.y},${p.z}`;
    if (window.__lastCam === now) window.__camStill = (window.__camStill || 0) + 1;
    else { window.__camStill = 0; window.__lastCam = now; }
    return window.__camStill >= 8;
  }, null, { timeout: 30000, polling: 120 });

  const setView = async (v) => {
    await page.evaluate((v) => {
      window.__camStill = 0; window.__lastCam = "";
      // Pin the projection. In "auto" the rig switches to ortho for an
      // axis-aligned view and back for iso, and a fit taken on either side of
      // that switch frames the part at a different scale — which is a second way
      // this measurement went non-deterministic. Pinned to what auto would
      // choose, so the frames are the ones the user actually gets: ortho looking
      // straight down, perspective for iso. It matters here — under perspective
      // the quad is 20 mm nearer the eye than the face, so it is magnified just
      // enough to hide the old 80x80's boundary in a top view.
      window.__sindri.viewport.rig.setProjectionMode(v === "iso" ? "persp" : "ortho");
      window.__sindri.viewport.setStandardView(v);
    }, v);
    await stillCamera();
    await page.evaluate(() => {
      const vp = window.__sindri.viewport;
      vp.rig.fit(vp.model.box, false); // no transition: same framing every run
      vp.requestRender();
    });
    await page.waitForTimeout(500);
  };

  // top: straight down the plane's normal, where an undersized quad cuts the top
  // face at ANY precision. iso: the view the app opens at, and the one a quad
  // that merely covers the footprint still fails.
  const shipping = {};
  for (const v of ["top", "iso"]) {
    await setView(v);
    shipping[v] = await measure();
    check(shipping[v].silhouette > 10000, `${v}: the body fills the frame`,
      `silhouette=${shipping[v].silhouette}`);
    check(shipping[v].edge <= EDGE_BUDGET,
      `${v}: the plane draws no boundary across the body`,
      `edge=${shipping[v].edge} of ${shipping[v].tinted} tinted`);
  }

  // --- control: put the pre-fix 80x80 quad back and require it to be RED ---
  await page.evaluate(() => {
    for (const q of window.__sindri.viewport.datumQuads) {
      const PlaneGeometry = q.geometry.constructor;
      q.geometry.dispose();
      q.geometry = new PlaneGeometry(80, 80);
    }
    window.__sindri.viewport.requestRender();
  });
  await page.waitForTimeout(700);
  for (const v of ["top", "iso"]) {
    await setView(v);
    const old = await measure();
    check(old.edge > EDGE_BUDGET,
      `${v}: control — the old 80x80 quad DOES cut across the body`,
      `edge=${old.edge} (shipping ${shipping[v].edge})`);
  }

  console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILED`}`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
