// A construction plane has to react to the cursor in the ORDINARY model view.
//
// Field report 50b719a3: "Offset/datum planes give no hover feedback in the
// normal viewport, unlike the origin planes." The plane was already clickable —
// handleClick raycasts the quads when the picker misses, and right-click opens
// the plane menu — but nothing about the picture changed as the cursor crossed
// it, because the hoveredDatum channel added in 0.1.211 was driven only by
// press/pull's and extrude's "up to" target pick. The viewport's own per-frame
// hover never touched it.
//
// Why this needs a browser: the unit test drives handleHover directly with a
// stubbed picker. The path a user actually travels is pointermove ->
// queueHover -> requestAnimationFrame -> handleHover, on a document whose model
// is NULL (main.ts calls clearModel when a rebuild carries no triangles, and
// the reporter's document is a sketch and a plane with no solid at all). Both
// of those — the rAF hop and the null model — are app facts, not unit facts.
//
// It carries its own controls. "The plane lights up" would also pass if every
// quad were bright all the time, so the same read is repeated with the cursor
// OFF the quad, and again over a SOLID that must win; and every hover point is
// required to be over bare canvas, so a pointer landing on a panel cannot count
// as "not hovering".
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/datum_hover_highlight_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running against a side-port worktree.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";

const W = 1280, H = 800;
const IDLE = 0.12, HOVERED = 0.24, SELECTED = 0.32; // viewport.paintDatums

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// 50b719a3's document as it arrived: one XY sketch with a rectangle, one datum
// plane offset 58, and NO solid — which is the point. The quad falls back to
// its 80 mm minimum, so the plane is a large, obvious, previously mute target.
const DOC = {
  version: 5,
  parameters: {},
  features: [
    { id: "f1", type: "sketch", plane: "XY",
      entities: [{ id: "e10", type: "rectangle", x: -18.99120747812234,
                   y: -2.4054590463894776, width: 77.98241495624467,
                   height: 55.18908190722105 }] },
    { id: "f2", type: "datumPlane", plane: "XY", offset: 58 },
  ],
};
const QZ = 58; // the quad's world z in DOC

// A second document that puts a SOLID under the plane, to check the precedence
// the highlight promises: a body face under the cursor wins over the plane
// behind it. Same part as e2e/datum_plane_quad_e2e.cjs — an 83.72 x 39.59
// block 21.858 tall, with the plane 48 above its top face.
const DOC_SOLID = {
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
  ],
};
const SOLID_QZ = 21.857999801635746 + 48;

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

  // Wait on the CONDITION, and require a build to ADVANCE: right after a
  // mutation the store still holds the previous, already settled build.
  await page.evaluate(() => {
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
  });
  const settle = async (mutate) => {
    const before = await page.evaluate(() => window.__settles);
    await mutate();
    await page.waitForFunction(
      (b) => window.__settles > b && !window.__sindri.store.buildState.building,
      before, { timeout: 120000 },
    ).catch(() => console.log("  (warning: no rebuild settled within the timeout)"));
    await page.waitForTimeout(400); // the doc-change repaint runs off the build event
  };

  /** Put the real cursor on a world point and let the rAF-throttled hover run.
   *  Returns whether that pixel is BARE CANVAS: a pointer that landed on a
   *  panel proves nothing either way, so every call below asserts it. */
  const hoverWorld = async (p) => {
    const s = await page.evaluate((p) => {
      const t = window.__sindri.viewport.projectToScreen(p);
      const x = Math.round(t.x), y = Math.round(t.y);
      return { x, y, onCanvas: document.elementFromPoint(x, y) === window.__sindri.viewport.domElement };
    }, p);
    await page.mouse.move(s.x, s.y);
    await page.waitForTimeout(200);
    return s;
  };
  const read = () => page.evaluate(() => {
    const vp = window.__sindri.viewport;
    return {
      hovered: vp.hoveredDatum ?? null,
      bodies: vp.model ? vp.model.bodies.length : -1, // -1 = no ModelView at all
      quads: vp.datumQuads.length,
      opacity: vp.datumQuads.map((q) => +q.material.opacity.toFixed(3)),
    };
  });
  const topView = async () => {
    // Straight down the plane's normal, so the pixel a point projects to really
    // is over that point. A view change is an ANIMATED transition.
    await page.evaluate(() => window.__sindri.viewport.setStandardView("top"));
    await page.waitForTimeout(1200);
  };

  console.log("\n=== the reporter's document: a plane, a sketch, no solid ===");
  await settle(() => page.evaluate((d) => window.__sindri.store.loadDocument(d), DOC));
  await topView();

  let s = await read();
  check(s.quads === 1, "the offset plane is drawn as a quad", `quads=${s.quads}`);
  check(s.bodies <= 0, "and the document really has no solid", `bodies=${s.bodies}`);
  check(s.opacity[0] === IDLE, "it starts idle", `opacity=${s.opacity[0]}`);

  // (30,30) is on the 80 mm quad and clear of the sketch rectangle beneath it
  // (that rectangle spans x -58..20, y -30..25), so the plane is the only thing
  // under this pixel.
  let at = await hoverWorld({ x: 30, y: 30, z: QZ });
  check(at.onCanvas, "the on-quad pixel is bare canvas", `${at.x},${at.y}`);
  s = await read();
  check(s.hovered === "f2", "the cursor over it lights it", `hovered=${s.hovered}`);
  check(s.opacity[0] === HOVERED, "and the quad really brightened", `opacity=${s.opacity[0]}`);

  // The control: a quad that is bright everywhere would pass the two above.
  at = await hoverWorld({ x: 60, y: 0, z: QZ }); // past the quad's 40 mm edge
  check(at.onCanvas, "the off-quad pixel is bare canvas too", `${at.x},${at.y}`);
  s = await read();
  check(s.hovered === null, "moving off it goes back to idle", `hovered=${s.hovered}`);
  check(s.opacity[0] === IDLE, "and the quad dimmed again", `opacity=${s.opacity[0]}`);

  // The two channels must not fight: a SELECTED plane keeps its own brightness
  // while the cursor wanders on and off it.
  await page.evaluate(() => window.__sindri.viewport.highlightDatum("f2"));
  await hoverWorld({ x: 30, y: 30, z: QZ });
  s = await read();
  check(s.opacity[0] === SELECTED, "hovering the selected plane keeps it selected-bright",
    `opacity=${s.opacity[0]}`);
  await hoverWorld({ x: 60, y: 0, z: QZ });
  s = await read();
  check(s.opacity[0] === SELECTED, "and leaving it does not dim the selection",
    `opacity=${s.opacity[0]}`);
  await page.evaluate(() => window.__sindri.viewport.highlightDatum(null));

  console.log("\n=== with a solid under it: the body wins ===");
  await settle(() => page.evaluate((d) => window.__sindri.store.loadDocument(d), DOC_SOLID));
  await topView();

  s = await read();
  check(s.bodies === 1, "the block built", `bodies=${s.bodies}`);
  check(s.quads === 1, "and the plane above it is drawn", `quads=${s.quads}`);

  // Dead centre: from the top view the quad is between the camera and the top
  // face, and the FACE is what a click would take.
  at = await hoverWorld({ x: 0, y: 0, z: SOLID_QZ });
  check(at.onCanvas, "the over-the-body pixel is bare canvas", `${at.x},${at.y}`);
  s = await read();
  check(s.hovered === null, "a face under the cursor leaves the plane behind it idle",
    `hovered=${s.hovered}`);
  check(s.opacity[0] === IDLE, "the quad stayed idle over the body", `opacity=${s.opacity[0]}`);

  // ...and clear of the body the same plane still lights, so the check above is
  // not passing because hover is simply dead on this document.
  at = await hoverWorld({ x: 60, y: 0, z: SOLID_QZ }); // body ends at x 41.86
  check(at.onCanvas, "the clear-of-the-body pixel is bare canvas", `${at.x},${at.y}`);
  s = await read();
  check(s.hovered === "f3", "clear of the body it lights again", `hovered=${s.hovered}`);
  check(s.opacity[0] === HOVERED, "and that quad brightened", `opacity=${s.opacity[0]}`);

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall good");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
