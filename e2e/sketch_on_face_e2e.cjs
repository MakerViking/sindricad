// A sketch drawn on a body FACE, in a real browser: does it stay on the grid,
// and does it FOLLOW the face when the body changes?
//
// Two field reports, one file, because they are the same pick. A third arrived
// later (fe6513f9, section (e)): selecting the face first and pressing Sketch
// ignored the selection and demanded the same face again.
//
// (1) Grid. Reported 2026-08-02 (0.1.77, Windows), with the document attached:
//     "center is getting off from grid, sketch #1 was snapped to grid, went to
//      draw #2 and the center of 1 was not on grid anymore"
//     That sketch was stored with plane origin (3.4797646, 1.0501546, 10) where
//     it should be (0, 0, 10). Grid snapping rounds in plane-LOCAL coordinates
//     (snap.ts), so the plane origin decides where the lattice lands in world
//     space, and an origin off by a fraction of a millimetre gives that sketch a
//     grid of its own. The pick below is deliberately OFF-CENTRE: the origin
//     must depend on neither where you clicked nor how the face tessellated.
//
// (2) GH #52. A sketch on a face stored only its resolved plane, so raising the
//     body under it left the sketch behind — and a cut from that sketch then
//     closed a cavity INSIDE the solid instead of opening a pocket. Silent: same
//     volume, same solid count, no error. The sketch now also stores `face`, the
//     selector naming the face it was picked off, and the sidecar re-derives the
//     plane from the live face every rebuild.
//
// The two interact, which is why they are checked together: the frame rule
// (origin = n * (n . F.center()), the WORLD origin projected onto the face's
// plane) is what lets a sketch follow its face WITHOUT losing the shared grid
// lattice. Re-deriving from the face's own centroid — the obvious move — passes
// #52 and re-breaks the 2026-08-02 report.
//
// The trap this file exists for is (c): open the sketch for edit, change
// nothing, close it. snapshotFeature bakes whatever plane the session was
// ENTERED with straight back into the document, so opening at the stale cached
// plane silently reverts the follow on the very next commit. Nothing raises,
// the geometry keeps building, and the only symptom is that the model is a
// height behind. Its control is to revert planeOf() at main.ts's sketch-edit
// arm and watch this go red while every other check here stays green.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/sketch_on_face_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running it beside another checkout on side ports.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
const URL = process.env.SC_URL || "http://localhost:5173";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// The original report's document: a circle r15 on XY, extruded 10. Kept exactly
// as it arrived, because the grid claim is about THIS geometry.
const CYL = {
  version: 4, units: "mm", parameters: {},
  features: [
    { id: "f1", type: "sketch", plane: "XY", constraints: [],
      entities: [{ type: "circle", id: "e6", x: 0, y: 0, radius: 15 }] },
    { id: "f2", type: "extrude", sketch: "f1", distance: 10, operation: "new" },
  ],
};

// GH #52's own shape: a plain box. The primitive is CENTRED, so its top face is
// at z = +height/2 — 5 at height 10, 10 at height 20.
const BOX = {
  version: 5, units: "mm", parameters: {},
  features: [{ id: "b1", type: "box", length: 40, width: 40, height: 10 }],
};

const EMPTY = { version: 5, units: "mm", parameters: {}, features: [] };

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it, before
    // any chrome exists, and the page is then a black screen with a logo.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // the welcome modal is part of toolBusy()
  await page.waitForTimeout(400);

  // Wait on the CONDITION, never a stopwatch — a shared CI runner is far slower
  // than a dev box and a fixed sleep here is how an e2e gate goes flaky.
  //
  // "not building any more" is NOT that condition, and reading it that way cost
  // a run: right after a mutation the store still holds the PREVIOUS build,
  // already settled, so the wait returns instantly and every assertion measures
  // the model as it was one edit ago. Count settled builds instead and require
  // the counter to ADVANCE — independent of what the edit was supposed to
  // change, so it cannot accidentally assert the thing under test.
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

  const load = (doc) => settle(() => page.evaluate((d) => window.__sindri.store.loadDocument(d), doc));

  /** screen position of a world point */
  const screenOf = (w) => page.evaluate((pt) => {
    const s = window.__sindri.viewport.projectToScreen({ x: pt[0], y: pt[1], z: pt[2] });
    return { x: Math.round(s.x), y: Math.round(s.y) };
  }, w);

  const clickAt = async (p) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };

  // ===== (d) the 2026-08-02 grid claim, unchanged =========================
  console.log("\n=== the grid claim: an off-centre pick still lands on the model lattice ===");
  await load(EMPTY);
  await load(CYL);
  await page.evaluate(() => window.__sindri.viewport.fit?.());
  await page.waitForTimeout(600);

  const built = await page.evaluate(() => ({
    bodies: window.__sindri.store.buildState.result?.bodies?.length ?? 0,
  }));
  check(built.bodies > 0, "the cylinder built", `bodies=${built.bodies}`);

  // (6, 3, 10): on the top face (r=15) but well away from its centre, so a
  // click-anchored or centroid-anchored origin cannot coincidentally pass.
  const offCentre = await screenOf([6, 3, 10]);
  const got = await page.evaluate((p) => {
    const def = window.__sindri.viewport.pickFacePlane(p.x, p.y);
    return { def };
  }, offCentre);

  check(!!got.def, "a face plane came back from the pick", JSON.stringify(offCentre));
  if (got.def) {
    const [ox, oy, oz] = got.def.origin;
    const [, , nz] = got.def.normal;
    const near = (v, want, tol = 1e-6) => Math.abs(v - want) <= tol;
    check(near(Math.abs(nz), 1), "picked the flat top face", `normal.z=${nz}`);
    check(near(ox, 0) && near(oy, 0),
      "origin sits on the model axis, not the click or the centroid",
      `origin=(${ox}, ${oy}, ${oz})`);
    check(near(oz, 10), "origin is on the face plane (z=10)", `z=${oz}`);
    const step = 1;
    const worldFromLocal = (u) => ox + u; // xdir is +X for a Z-normal face
    check(Math.abs(worldFromLocal(3 * step) % step) < 1e-9,
      "a grid point on this sketch lands on the model grid",
      `world x=${worldFromLocal(3 * step)}`);
  }

  // ===== (a) the pick STORES the face reference ===========================
  console.log("\n=== (a) sketching on a face stores the face it was picked off ===");
  await load(BOX);
  await page.evaluate(() => window.__sindri.viewport.fit?.());
  await page.waitForTimeout(600);

  const topPt = await screenOf([12, 7, 5]); // off-centre on the 40x40 top face
  await page.evaluate(() => window.__sindri.handleAction("sketch"));
  await page.waitForTimeout(300);
  await clickAt(topPt);
  const entered = await page.evaluate(() => ({
    active: window.__sindri.sketch.active,
    z: window.__sindri.sketch.plane?.origin?.z,
  }));
  check(entered.active === true, "the click entered a sketch on the top face",
    `plane z=${entered.z}`);

  // Draw a rectangle with two clicks (a NEW sketch opens armed with Rectangle),
  // then commit. Real pointer events, not SketchMode calls: the anchor is
  // captured in the pick dispatch, which method calls would bypass.
  if (entered.active) {
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
    await settle(() => page.evaluate(() => window.__sindri.sketch.finish(true)));
  }

  const sk = await page.evaluate(() => {
    const f = window.__sindri.store.document.features.filter((x) => x.type === "sketch").at(-1);
    return f ? { id: f.id, face: f.face, plane: f.plane, n: f.entities.length } : null;
  });
  check(!!sk, "the sketch was committed", sk ? `${sk.n} entities` : "no sketch feature");
  check(!!sk?.face, "it carries a `face` anchor", JSON.stringify(sk?.face));
  check(sk?.face?.by === "nearest", "authored as by:'nearest'", `by=${sk?.face?.by}`);
  check(typeof sk?.face?.body === "string" && sk.face.body.length > 0,
    "stamped with the owning body — an unstamped selector binds the ACTIVE body",
    `body=${sk?.face?.body}`);
  check(Math.abs((sk?.plane?.origin?.[2] ?? 0) - 5) < 1e-6,
    "the cached plane is the top face at z=5", `z=${sk?.plane?.origin?.[2]}`);

  if (!sk?.face) {
    console.log(`\n${fails} FAILED — nothing anchored, the rest cannot be judged`);
    await browser.close();
    process.exit(1);
  }

  // A cut from that sketch: this is the feature that GH #52 turned into a
  // sealed internal void when the sketch stayed behind.
  await settle(() => page.evaluate((sid) => {
    const s = window.__sindri;
    s.store.addFeature({ id: "cut1", type: "extrude", sketch: sid, distance: -5, operation: "cut" });
  }, sk.id));

  // ===== (b) raising the body moves the resolved plane ====================
  console.log("\n=== (b) the sketch follows the face when the body grows ===");
  await settle(() => page.evaluate(() => window.__sindri.store.updateFeature("b1", { height: 20 })));

  const after = await page.evaluate((sid) => {
    const s = window.__sindri;
    const r = s.store.buildState.result;
    return {
      planes: r?.planes ?? null,
      resolved: r?.planes?.[sid] ?? null,
      errors: r?.featureErrors ?? [],
      diags: (r?.diagnostics ?? []).map((d) => d.code ?? d.reason),
      bodies: r?.bodies?.length ?? 0,
    };
  }, sk.id);
  check(after.planes !== null, "the rebuild reported the planes it used",
    after.planes ? `${Object.keys(after.planes).length} entr(ies)` : "no `planes` field at all");
  check(Math.abs((after.resolved?.origin?.[2] ?? -1) - 10) < 1e-6,
    "the resolved plane moved to the NEW top face (z=10)",
    `z=${after.resolved?.origin?.[2]}`);
  check(Math.abs(after.resolved?.origin?.[0] ?? 9) < 1e-6 && Math.abs(after.resolved?.origin?.[1] ?? 9) < 1e-6,
    "and it is still the WORLD-origin projection, not the face centroid",
    `origin=${JSON.stringify(after.resolved?.origin)}`);
  check(after.errors.length === 0, "the build stayed green", JSON.stringify(after.errors));
  check(after.bodies === 1, "still one body", `${after.bodies}`);
  // The backstop is the oracle for #52 on documents that CANNOT follow. Here the
  // sketch did follow, so the cut breaks the surface and the backstop must stay
  // silent — if it fires, the follow did not actually happen and the pocket is a
  // sealed cavity again, at a volume and body count identical to the good case.
  check(!after.diags.includes("sealedVoid"),
    "the cut opened a pocket, not a sealed cavity — no sealedVoid backstop",
    JSON.stringify(after.diags));
  check(after.diags.length === 0, "and no fallback diagnostic was raised at all",
    JSON.stringify(after.diags));

  // ===== (c) the re-bake trap ============================================
  console.log("\n=== (c) opening the sketch and closing it unchanged must not revert the follow ===");
  const opened = await page.evaluate((sid) => {
    const node = document.querySelector(`.timeline-node[data-id="${sid}"]`);
    if (!node) return { found: false };
    node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return { found: true };
  }, sk.id);
  check(opened.found, "the sketch has a timeline node to double-click");
  await page.waitForTimeout(600);
  const inSession = await page.evaluate(() => ({
    active: window.__sindri.sketch.active,
    z: window.__sindri.sketch.plane?.origin?.z,
  }));
  check(inSession.active === true, "it reopened for edit");
  check(Math.abs((inSession.z ?? 0) - 10) < 1e-6,
    "it opened at the FOLLOWED plane, not the cached one",
    `session plane z=${inSession.z} (cached says 5)`);

  // close, unchanged
  await settle(() => page.evaluate(() => window.__sindri.sketch.finish(true)));

  const reclosed = await page.evaluate((sid) => {
    const s = window.__sindri;
    const f = s.store.document.features.find((x) => x.id === sid);
    return {
      z: f?.plane?.origin?.[2],
      face: f?.face ?? null,
      resolved: s.store.buildState.result?.planes?.[sid] ?? null,
      errors: s.store.buildState.result?.featureErrors ?? [],
      diags: (s.store.buildState.result?.diagnostics ?? []).map((d) => d.code ?? d.reason),
    };
  }, sk.id);
  check(Math.abs((reclosed.z ?? 0) - 10) < 1e-6,
    "the re-baked cache is the followed plane, not the stale one",
    `plane z=${reclosed.z}`);
  check(!!reclosed.face && reclosed.face.by === "nearest",
    "the `face` anchor survived the round-trip", JSON.stringify(reclosed.face));
  check(Math.abs((reclosed.resolved?.origin?.[2] ?? -1) - 10) < 1e-6,
    "and the pocket is still resolved at the new height",
    `z=${reclosed.resolved?.origin?.[2]}`);
  check(reclosed.errors.length === 0, "still green after the re-edit",
    JSON.stringify(reclosed.errors));
  check(reclosed.diags.length === 0,
    "and still silent — the re-baked plane did not re-seal the cavity",
    JSON.stringify(reclosed.diags));

  // ===== the legacy arm, and the CONTROL for every "no diagnostic" above ===
  // Existing .sindri files carry no `face` and therefore keep #52 forever; the
  // sealed-void backstop is the only thing that helps them. Load that shape
  // directly — a plane baked at z=5 under a body whose top is now z=10, exactly
  // what an old document looks like after the user raised the box.
  //
  // This is ALSO why the checks above are worth anything: `diagnostics` being
  // empty proves nothing unless a diagnostic can be shown to arrive at all, and
  // the backstop's own suite only ever ran inside the kernel. This is the one
  // place the wire, client.ts's copy and the store are in the path.
  console.log("\n=== the legacy arm: no anchor, so the backstop has to catch it ===");
  await load({
    version: 5, units: "mm", parameters: {},
    features: [
      { id: "b1", type: "box", length: 40, width: 40, height: 20 },
      { id: "s1", type: "sketch",
        plane: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] },
        constraints: [], entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: 3 }] },
      { id: "x1", type: "extrude", sketch: "s1", distance: -5, operation: "cut" },
    ],
  });
  const legacy = await page.evaluate(() => {
    const r = window.__sindri.store.buildState.result;
    return {
      diags: r?.diagnostics ?? [],
      errors: r?.featureErrors ?? [],
      planes: r?.planes ?? null,
      bodies: r?.bodies?.length ?? 0,
    };
  });
  const sealed = legacy.diags.filter((d) => d.code === "sealedVoid");
  check(sealed.length === 1,
    "the sealed cavity is REPORTED to the client, not just detected in the kernel",
    JSON.stringify(legacy.diags));
  check(sealed[0]?.reason === "This cut closed a cavity inside the body.",
    "with the exact user-facing text the amber chip shows", sealed[0]?.reason);
  check(sealed[0]?.feature_id === "x1" && Array.isArray(sealed[0]?.at),
    "carrying the feature it happened in and where", JSON.stringify(sealed[0]?.at));
  // A diagnostic, never an error: a deliberate hollow is legal geometry.
  check(legacy.errors.length === 0 && legacy.bodies === 1,
    "and the build is still green with its body intact",
    `${legacy.bodies} bod(ies), errors ${JSON.stringify(legacy.errors)}`);
  check(legacy.planes === null,
    "no `planes` entry, because nothing in this document is anchored",
    JSON.stringify(legacy.planes));

  // ===== (e) the Sketch button honours a face that is ALREADY selected =====
  // Reported (fe6513f9): "I select a face, hit Sketch, and it asks me to select
  // the face" — Press/Pull two buttons away already works off the selection.
  // The unit tests can only see which branch startSketch takes; this is the
  // only place the real click, the real selection and the real sidecar are in
  // the path, and the payoff check is the last one: a sketch entered this way
  // has to be ANCHORED like a clicked one, or face-first sketching would have
  // quietly re-introduced GH #52 for everybody who uses it.
  console.log("\n=== (e) select a face, press Sketch: no second pick ===");
  await load(EMPTY);
  await load(BOX); // top face at z = 5
  await page.evaluate(() => window.__sindri.viewport.fit?.());
  await page.waitForTimeout(600);

  const preFacePt = await screenOf([12, 7, 5]); // off-centre on the top face
  await clickAt(preFacePt);
  const selCount = await page.evaluate(() => window.__sindri.viewport.getSelectedFaceIds().length);
  check(selCount === 1, "a plain click selected exactly one face", `${selCount} selected`);

  await page.evaluate(() => window.__sindri.handleAction("sketch"));
  await page.waitForTimeout(400);
  const preEntered = await page.evaluate(() => ({
    active: window.__sindri.sketch.active,
    origin: window.__sindri.sketch.plane?.origin,
    prompt: document.getElementById("prompt")?.textContent ?? "",
    stillSelected: window.__sindri.viewport.getSelectedFaceIds().length,
  }));
  check(preEntered.active === true,
    "Sketch entered on the selected face with NO second click",
    `prompt=${JSON.stringify(preEntered.prompt)}`);
  check(!/Select a plane/.test(preEntered.prompt),
    "and it did not arm the plane picker as well", JSON.stringify(preEntered.prompt));
  check(Math.abs((preEntered.origin?.z ?? -1) - 5) < 1e-6,
    "on the top face's plane (z=5)", `origin=${JSON.stringify(preEntered.origin)}`);
  check(Math.abs(preEntered.origin?.x ?? 9) < 1e-6 && Math.abs(preEntered.origin?.y ?? 9) < 1e-6,
    "with the shared grid lattice — origin is the world-origin projection, not the face centroid",
    `origin=${JSON.stringify(preEntered.origin)}`);
  check(preEntered.stillSelected === 0,
    "and the face was released, not left armed for the next tool",
    `${preEntered.stillSelected} still selected`);

  if (preEntered.active) {
    const a2 = await page.evaluate(() => {
      const s = window.__sindri;
      const p = s.viewport.projectToScreen(s.sketch.plane.to3D(-6, -6));
      return { x: Math.round(p.x), y: Math.round(p.y) };
    });
    const b2 = await page.evaluate(() => {
      const s = window.__sindri;
      const p = s.viewport.projectToScreen(s.sketch.plane.to3D(6, 6));
      return { x: Math.round(p.x), y: Math.round(p.y) };
    });
    await clickAt(a2);
    await clickAt(b2);
    await settle(() => page.evaluate(() => window.__sindri.sketch.finish(true)));
  }

  const preSk = await page.evaluate(() => {
    const f = window.__sindri.store.document.features.filter((x) => x.type === "sketch").at(-1);
    return f ? { id: f.id, face: f.face ?? null, n: f.entities.length } : null;
  });
  check(!!preSk?.face, "the committed sketch carries a `face` anchor too",
    JSON.stringify(preSk?.face));
  check(typeof preSk?.face?.body === "string" && preSk.face.body.length > 0,
    "stamped with the owning body", `body=${preSk?.face?.body}`);

  await settle(() => page.evaluate(() => window.__sindri.store.updateFeature("b1", { height: 20 })));
  const preFollowed = await page.evaluate((sid) => {
    const r = window.__sindri.store.buildState.result;
    return { resolved: r?.planes?.[sid] ?? null, errors: r?.featureErrors ?? [] };
  }, preSk?.id);
  check(Math.abs((preFollowed.resolved?.origin?.[2] ?? -1) - 10) < 1e-6,
    "and it FOLLOWS the face when the box grows, like a clicked one",
    `z=${preFollowed.resolved?.origin?.[2]}`);
  check(preFollowed.errors.length === 0, "build still green",
    JSON.stringify(preFollowed.errors));

  console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILED`}`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
