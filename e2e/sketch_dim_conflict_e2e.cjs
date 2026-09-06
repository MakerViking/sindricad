// A dimension edit the sketch cannot satisfy, in a real browser.
//
// Field report 886da4e5 (0.1.211): "a circle is constrained by tangents inside a
// rectangle, the rectangle has it's corners fixed with the "fix" constraint, I
// then fix the circle centre with the Fix constraint... then I try to edit the
// circle diameter... it turned all the sketch element lines red... did not give
// any warning about not being able to change the circle diameter because it is
// already fully constrained."
//
// Why this file and not a unit test: the two things the reporter actually saw —
// every active curve turning red, and nothing being said — live in SketchMode,
// which no unit test constructs (vitest.config.ts). The pure pieces (the wording
// and the withdraw rule) are covered in src/sketch/dimConflict.test.ts and the
// solver behaviour in src/sketch/dimEditConflict.test.ts; this is the only place
// the WIRING between them is exercised: the trial armed by setDrivingDimension,
// the pump's withdraw branch, and the colour that comes out the other end.
//
// The circle is tangent to two edges of a FIXED rectangle, so those two
// tangencies plus the diameter already determine its x, y and r. Fixing its
// centre as well is consistent at 30 mm (planegcs calls it merely redundant,
// which is why the Fix was accepted in silence) and unsatisfiable the instant
// the diameter moves.
//
// No sidecar geometry is involved — the document is a sketch and nothing else.
//
// Usage (from the repo root), with vite on 5173:
//   SC_TOKEN=<the sidecar token> node e2e/sketch_dim_conflict_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome);
// SC_PORT overrides the vite port.
const { chromium } = require("playwright-core");

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// The reporter's own document (bug-reports/docs/886da4e5.json), minus the datum
// plane it also carried: e18 is the small rectangle with three corners Fixed,
// e17 the circle tangent to two of its edges, e11 a second rectangle that is
// still loose — which is why the sketch keeps 3 DOF throughout and "is it fully
// constrained" is NOT available as a test for this refusal.
const REPORTED = {
  version: 5,
  parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [
      { x: -7.649130461954812, y: 27.027137507924373, id: "e11", type: "rectangle", width: 86.88949115816148, height: 86.88949115816148 },
      { x: 74.69540203063235, y: -20.462819640218413, id: "e17", type: "circle", radius: 15 },
      { x: 89.69540203063235, y: -10.462819640218406, id: "e18", type: "rectangle", width: 60, height: 50 },
    ],
    constraints: [
      { e1: "e11", e2: "e11", id: "c14", p1: 3, p2: 0, type: "p2pDistance", value: 50, driven: true },
      { e1: "e11", e2: "e11", id: "c15", p1: 0, p2: 1, type: "p2pDistance", value: 100, driven: true },
      { l1: "e11~3", l2: "e11~0", type: "equal" },
      { e: "e18", p: 3, type: "fix" },
      { e: "e18", p: 0, type: "fix" },
      { e: "e18", p: 1, type: "fix" },
      { a: "e17", b: "e18~0", type: "tangent2" },
      { a: "e17", b: "e18~3", type: "tangent2" },
      { id: "c20", type: "diameter", value: 30, circle: "e17" },
      // the Fix the reporter then put on the circle's CENTRE (p 0 is the centre
      // for a circle — dimRefPoints)
      { e: "e17", p: 0, type: "fix" },
    ],
  }],
};

// viewport/colors3d.ts CONFLICT. Hard-coded on purpose: this asserts the colour
// the USER sees, so importing the constant would let a change to it pass here.
const CONFLICT = 0xff4444;

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const port = process.env.SC_PORT || "5173";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  const token = process.env.SC_TOKEN ? `?token=${process.env.SC_TOKEN}` : "";
  await page.goto(`http://localhost:${port}/${token}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal
  await page.waitForTimeout(400);

  /** Every colour currently painted on the active sketch's curves. This is the
   *  reported symptom itself, read off the scene rather than inferred. */
  const curveColours = () => page.evaluate(() => {
    const out = [];
    window.__sindri.overlay.activeSketch.traverse((o) => {
      const m = o.material;
      if (m && m.color) out.push(m.color.getHex());
    });
    return out;
  });

  const sketchState = () => page.evaluate(() => ({
    dof: window.__sindri.sketch.dof,
    toasts: [...document.querySelectorAll(".toast-msg")].map((el) => el.textContent),
  }));

  await page.evaluate((d) => {
    const s = window.__sindri;
    if (s.sketch.active) s.sketch.finish(false);
    s.store.loadDocument(d);
  }, REPORTED);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
  // wait for the first solve to land (dof is -1 until one has run)
  await page.waitForFunction(() => window.__sindri.sketch.dof >= 0, null, { timeout: 20000 });
  await page.waitForTimeout(300);

  console.log("\n=== before the edit: the reporter's sketch is not red ===");
  let colours = await curveColours();
  check(colours.length > 0, "the active sketch has curves to colour", `n=${colours.length}`);
  check(!colours.includes(CONFLICT), "no curve is red before the edit",
    `colours=${JSON.stringify([...new Set(colours)].map((c) => c.toString(16)))}`);

  console.log("\n=== the edit that cannot be satisfied ===");
  // The same seam the badge's editor uses: editDimension -> drivingDimFor ->
  // setDrivingDimension. Driven through the public entry so the harness does not
  // have to hunt a badge that may be culled at whatever zoom the sketch opened at.
  await page.evaluate(() => window.__sindri.sketch.applyDimensionEdit("e17", "diameter", 40));
  // the refusal is a solve away: poll for the toast rather than sleeping
  await page.waitForFunction(() => document.querySelectorAll(".toast-msg").length > 0,
    null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500); // let the restore's re-solve land

  const st = await sketchState();
  const said = st.toasts.join(" | ");
  check(st.toasts.length > 0, "the refusal SAYS something", `toasts=${JSON.stringify(st.toasts)}`);
  check(/could not change this diameter/.test(said), "it names what it could not change", said);
  check(/centre is fixed/.test(said), "it names the fixed centre", said);
  check(/Tangent/.test(said), "it names the tangents the solver blamed", said);
  check(/30 mm/.test(said), "it says what the dimension was left at", said);

  colours = await curveColours();
  check(!colours.includes(CONFLICT), "THE REPORT: no curve is left red after the refusal",
    `colours=${JSON.stringify([...new Set(colours)].map((c) => c.toString(16)))}`);

  console.log("\n=== and the sketch still holds the dimension it had ===");
  const after = await page.evaluate(() => {
    const s = window.__sindri;
    s.sketch.finish(true);
    const f = s.store.document.features.find((x) => x.id === "f1");
    const circle = f.entities.find((e) => e.id === "e17");
    const dim = (f.constraints || []).find((c) => c.type === "diameter");
    return { radius: circle && circle.radius, dim: dim && dim.value,
      dims: (f.constraints || []).filter((c) => c.type === "diameter").length };
  });
  check(after.dim === 30, "the committed diameter is still 30", `value=${after.dim}`);
  check(after.dims === 1, "the circle did not lose its dimension in the withdraw", `count=${after.dims}`);
  check(Math.abs(after.radius - 15) < 1e-3, "the circle is still where it was", `radius=${after.radius}`);

  // CONTROL. Every dimension edit now goes on trial, so a refusal that fired too
  // eagerly would break ordinary dimensioning — and every check above would still
  // pass. This is the same edit on a circle nothing is holding.
  console.log("\n=== control: an ordinary diameter edit still applies ===");
  await page.evaluate(() => {
    const s = window.__sindri;
    if (s.sketch.active) s.sketch.finish(false);
    s.store.loadDocument({
      version: 5, parameters: {},
      features: [{ id: "f1", type: "sketch", plane: "XY",
        entities: [{ x: 0, y: 0, id: "c1", type: "circle", radius: 15 }] }],
    });
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
  await page.waitForTimeout(400);
  // clear the refusal above out of the stack: toasts linger for seconds, and a
  // leftover one would read as this edit having been refused too
  await page.evaluate(() => { for (const el of document.querySelectorAll(".toast")) el.remove(); });
  await page.evaluate(() => window.__sindri.sketch.applyDimensionEdit("c1", "diameter", 40));
  await page.waitForTimeout(800);
  const ctrl = await page.evaluate(() => {
    const s = window.__sindri;
    const toasts = [...document.querySelectorAll(".toast-msg")].map((el) => el.textContent);
    s.sketch.finish(true);
    const f = s.store.document.features.find((x) => x.id === "f1");
    return { radius: f.entities.find((e) => e.id === "c1").radius, toasts };
  });
  check(Math.abs(ctrl.radius - 20) < 1e-3, "a circle nothing holds still grows to the typed diameter",
    `radius=${ctrl.radius}`);
  check(ctrl.toasts.length === 0, "and nothing is said about it", JSON.stringify(ctrl.toasts));

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})();
