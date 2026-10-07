// The Sketch Palette, driven the way a user drives it: real clicks on its boxes,
// on the canvas, and on the keys. Paul's three reports from 2026-10-03:
//
//   9b764625  "In a sketch, I have a construction line, in the 'Sketch Palette'
//             panel the 'construction' check box does not do anything, the
//             'Sketch grid' tickbox does not appear to do anything. I don't know
//             what a 'reference dim' or 'show profile' do, tooltip text may help
//             users understand what sketch palette items do."
//   1bf12403  "A line with a dimension value... turn it into 'construction' and
//             the dimension disappears, if the dimension is first locked then the
//             dimension box shows but not the dimension marker lines"
//   34bede7e  "When I create a 'tangent' between an arc and a line the tangent
//             constraint 'icon' is a long way from the point of tangency"
//
// Why this has to be an e2e. The viewport draws ON DEMAND, so "the grid went
// away" is only true once a frame is drawn, and nothing but a real click on a
// real palette tells you whether one is. The grid and profile checks therefore
// read the PIXELS the page is showing, from a screenshot, without moving the
// mouse over the canvas (a pointermove would draw a frame and hide the bug).
// The Construction box only changes through main.ts's wiring between the
// palette and the sketch, which no unit test loads, and whether a clicked box
// hands the keyboard back to the sketch is up to the browser's focus rules.
//
// Usage (from the repo root; NO sidecar needed: the documents are sketches and
// no assertion goes near geometry):
//   npx vite --port 5199 &
//   SC_URL=http://localhost:5199 node e2e/sketch_palette_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome).
const { chromium } = require("playwright-core");
const fs = require("fs");

const URL = process.env.SC_URL || "http://localhost:5173";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const sketchDoc = (entities, constraints = []) => ({
  version: 5, parameters: {},
  features: [{ id: "f1", type: "sketch", plane: "XY", entities, ...(constraints.length ? { constraints } : {}) }],
});
const S2 = Math.SQRT1_2;

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(() => localStorage.setItem("sindri.welcomeOnStartup", "false"));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal if it came up anyway
  await page.waitForTimeout(300);

  /** load `doc` and open its sketch, framed on its geometry */
  const openSketch = async (doc) => {
    await page.evaluate((d) => {
      const s = window.__sindri;
      if (s.sketch.active) s.sketch.finish(false);
      s.store.loadDocument(d);
    }, doc);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
    await page.waitForFunction(() => {
      const p = document.getElementById("palette");
      return p && !p.classList.contains("hidden");
    }, null, { timeout: 20000 });
    await page.evaluate(() => window.__sindri.viewport.fitView());
    await page.waitForTimeout(900); // rig.fit() transitions
    await page.evaluate(() => { window.__sindri.viewport.rig.zoomBy(1.6); window.__sindri.viewport.requestRender(); });
    await page.waitForTimeout(700);
  };
  /** client point of sketch-plane (x, y) */
  const scr = (x, y) => page.evaluate(([x, y]) => {
    const s = window.__sindri;
    return s.viewport.projectToScreen(s.sketch.plane.to3D(x, y));
  }, [x, y]);
  const clickAt = async (x, y) => { const p = await scr(x, y); await page.mouse.click(p.x, p.y); await page.waitForTimeout(150); };
  /** the palette row labelled `label`: its box's state, tooltip and centre */
  const row = (label) => page.evaluate((l) => {
    const r = [...document.querySelectorAll("#palette .palette-row")].find((x) => x.textContent.trim() === l);
    if (!r) return null;
    const box = r.querySelector("input");
    const b = box.getBoundingClientRect();
    return { checked: box.checked, mixed: box.indeterminate, title: r.title, x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, label);
  const clickRow = async (label) => {
    const r = await row(label);
    await page.mouse.click(r.x, r.y);
    await page.waitForTimeout(250);
  };
  const ent = (id) => page.evaluate((i) => window.__sindri.sketch.snapshotFeature().entities.find((e) => e.id === i), id);
  const selected = () => page.evaluate(() => [...window.__sindri.sketch.selected]);
  const constructionMode = () => page.evaluate(() => window.__sindri.sketch.constructionMode);
  /** what holds the keyboard: the sketch's keys skip a focused input */
  const focused = () => page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName}${a.type ? `/${a.type}` : ""}` : "none";
  });
  /** profile areas picked in the open sketch */
  const regionsPicked = () => page.evaluate(() => window.__sindri.overlay.selectedRegionPoints.length);
  /** Pixels of `clip` that are not its most common colour, and that colour.
   *  From a real screenshot: what the page is SHOWING, not what the scene holds. */
  const pixels = async (clip) => {
    const png = await page.screenshot({ clip });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const counts = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let mode = 0, n = 0;
      for (const [k, v] of counts) if (v > n) { n = v; mode = k; }
      return { off: d.length / 4 - n, mode };
    }, png.toString("base64"));
  };
  /** frames the viewport has drawn so far */
  const frames = () => page.evaluate(() => window.__sindri.viewport.scene.renderer.info.render.frame);

  // ===== tooltips ==========================================================
  console.log("\n=== every palette item says what it does (9b764625) ===");
  await openSketch(sketchDoc([{ id: "r1", type: "rectangle", x: 25, y: 15, width: 30, height: 20 }]));
  const tips = await page.evaluate(() => [...document.querySelectorAll("#palette .palette-row, #palette .palette-btn")]
    .map((el) => ({ label: el.textContent.trim(), title: el.title })));
  check("the palette has its Look At button and nine switches", tips.length === 10, `${tips.length}`);
  const untitled = tips.filter((x) => !x.title || x.title === x.label);
  check("every one has a tooltip that is not just its name", untitled.length === 0,
    untitled.map((x) => x.label).join(", ") || tips.map((x) => `${x.label}: ${x.title.slice(0, 30)}…`).join(" | "));

  // ===== Sketch Grid and Show Profile draw a frame ==========================
  // Clips in canvas space, in the lower-left quadrant where nothing is drawn
  // but the grid, and inside the rectangle where its profile fill is.
  console.log("\n=== Sketch Grid and Show Profile change what is on screen (9b764625) ===");
  const o = await scr(0, 0);
  const vp = await page.evaluate(() => { const b = document.getElementById("viewport").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const empty = { x: Math.round(vp.x + 30), y: Math.round(o.y + 40), width: 160, height: 140 };
  check("the empty clip sits clear of the axes, on the canvas", empty.x + empty.width < o.x - 20 && empty.y + empty.height < vp.y + vp.h - 70,
    JSON.stringify({ empty, origin: o }));
  const inA = await scr(20, 12), inB = await scr(30, 18);
  const inside = { x: Math.round(Math.min(inA.x, inB.x)), y: Math.round(Math.min(inA.y, inB.y)), width: 24, height: 24 };

  const gridOn = await pixels(empty);
  check("precondition: the grid is drawn in the empty clip", gridOn.off > 150, `${gridOn.off} grid pixels`);
  const bg = gridOn.mode;
  const fillOn = await pixels(inside);
  check("precondition: the rectangle's profile is shaded", fillOn.mode !== bg,
    `inside #${fillOn.mode.toString(16)} vs canvas #${bg.toString(16)}`);

  // Park the cursor on the box and let the frames that arriving there asked for
  // drain first (the palette sits inside the viewport, and a pointermove over
  // it draws one). From here nothing may move the mouse over the canvas, which
  // would draw a frame and hide the bug.
  const gridBox = await row("Sketch Grid");
  await page.mouse.move(gridBox.x, gridBox.y);
  await page.waitForTimeout(500);
  let f0 = await frames();
  await clickRow("Sketch Grid");
  const gridOff = await pixels(empty);
  check("unticking Sketch Grid takes the grid off the screen", gridOff.off < 20,
    `${gridOn.off} -> ${gridOff.off} non-background pixels; ${(await frames()) - f0} frame(s) drawn`);
  f0 = await frames();
  await clickRow("Sketch Grid");
  check("ticking it puts it back", (await pixels(empty)).off > 150, `${(await frames()) - f0} frame(s) drawn`);

  // Someone walking the palette with Tab and Space keeps their place: only a
  // box clicked with the pointer hands the keyboard back to the sketch.
  await page.evaluate(() => [...document.querySelectorAll("#palette .palette-row")]
    .find((r) => r.textContent.trim() === "Sketch Grid").querySelector("input").focus());
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  check("Space on a focused box toggles it, and the box keeps the keyboard", !(await row("Sketch Grid")).checked
    && (await focused()) === "INPUT/checkbox", `focus on ${await focused()}`);
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  check("...and Space again toggles it back", (await row("Sketch Grid")).checked);

  await clickRow("Show Profile");
  const fillOff = await pixels(inside);
  check("unticking Show Profile takes the open sketch's own profile shading away", fillOff.mode === bg,
    `inside #${fillOn.mode.toString(16)} -> #${fillOff.mode.toString(16)}, canvas #${bg.toString(16)}`);
  // An area you cannot see is not one you can pick, or the click selects
  // something invisible and carries it on to Extrude. Off-centre (20, 12),
  // not the rectangle's centroid (25, 15): a press dead on a shape's centre
  // takes its centre HANDLE instead (the same path a circle's centre always
  // took), which selects the entity, not the region, and regionsPicked stays
  // 0 no matter what Show Profile is set to.
  await clickAt(20, 12);
  check("with it off, a click inside the area picks no area", (await regionsPicked()) === 0,
    `${await regionsPicked()} area(s) picked`);
  await clickRow("Show Profile");
  check("ticking it brings the shading back", (await pixels(inside)).mode === fillOn.mode);
  await clickAt(20, 12);
  check("...and the same click picks the area again", (await regionsPicked()) === 1,
    `${await regionsPicked()} area(s) picked`);

  // ===== the Construction box ==============================================
  console.log("\n=== the Construction box follows and acts on the selection (9b764625) ===");
  await openSketch(sketchDoc([
    { id: "c1", type: "line", x1: 0, y1: 40, x2: 40, y2: 40, construction: true },
    { id: "c2", type: "line", x1: 0, y1: 20, x2: 40, y2: 20, construction: true },
    { id: "n1", type: "line", x1: 0, y1: 0, x2: 40, y2: 0 },
  ]));
  let box = await row("Construction");
  check("nothing selected: the box shows the drawing mode, off", !box.checked && !box.mixed);
  await clickAt(10, 40); // 25% along: a line's badge sits at its midpoint
  box = await row("Construction");
  check("a selected construction line ticks the box", box.checked && !box.mixed,
    `checked=${box.checked} mixed=${box.mixed}, selected ${JSON.stringify(await page.evaluate(() => [...window.__sindri.sketch.selected]))}`);
  await clickRow("Construction");
  check("unticking it makes that line normal", !("construction" in (await ent("c1"))), JSON.stringify(await ent("c1")));
  box = await row("Construction");
  check("...and the box shows it", !box.checked && !box.mixed);
  await clickRow("Construction");
  check("ticking it again makes it construction again", (await ent("c1")).construction === true);

  // The box hands the keyboard back. Every sketch key skips a focused input,
  // so while the clicked box kept focus, Escape, Delete and Ctrl+Z did nothing
  // until the canvas was clicked.
  check("a click on the box leaves no input holding the keyboard", !(await focused()).startsWith("INPUT"),
    `focus on ${await focused()}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape straight after a click on the box clears the selection", (await selected()).length === 0,
    `selected ${JSON.stringify(await selected())}`);

  await clickAt(10, 20);
  await page.keyboard.down("Shift");
  await clickAt(10, 0);
  await page.keyboard.up("Shift");
  box = await row("Construction");
  check("a part-construction selection shows as mixed", box.mixed,
    `checked=${box.checked} mixed=${box.mixed}`);
  await clickRow("Construction");
  const both = [await ent("c2"), await ent("n1")];
  check("clicking it makes the whole selection construction, like right-click > Make construction",
    both.every((e) => e.construction === true), JSON.stringify(both));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  const undone = [await ent("c2"), await ent("n1")];
  check("Ctrl+Z straight after a click on the box undoes it",
    undone[0].construction === true && !("construction" in undone[1]), JSON.stringify(undone));

  // That click also set the drawing mode (2fc27cf1), so now the mode (on) and
  // a selected normal line disagree: the box can pass the next two checks only
  // by showing the selection while there is one and the mode once there is not.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await clickAt(10, 0); // n1, normal again
  box = await row("Construction");
  check("a selected normal line reads unticked, though the drawing mode is on",
    !box.checked && !box.mixed && (await constructionMode()) === true,
    `selected ${JSON.stringify(await selected())}, checked=${box.checked}, mode=${await constructionMode()}`);
  await clickAt(20, -20); // empty canvas, clear of every line and both axes
  box = await row("Construction");
  check("deselected by a click on empty canvas, the box shows the drawing mode again",
    (await selected()).length === 0 && box.checked && !box.mixed,
    `selected ${JSON.stringify(await selected())}, checked=${box.checked}, mode=${await constructionMode()}`);
  await clickRow("Construction"); // back to drawing normal geometry
  check("with nothing selected, the box switches the drawing mode", (await constructionMode()) === false
    && !(await row("Construction")).checked);

  // ===== Reference Dim, switched from the Dimension tool's own menu ==========
  console.log("\n=== Reference Dim follows the Dimension tool's menu ===");
  check("precondition: Reference Dim starts unticked", !(await row("Reference Dim")).checked);
  await page.evaluate(() => window.__sindri.sketch.setTool("dimension"));
  await page.waitForTimeout(150);
  const blank = await scr(-30, 30);
  await page.mouse.click(blank.x, blank.y, { button: "right" });
  await page.waitForTimeout(250);
  const picked = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".context-menu .ctx-item")]
      .find((x) => (x.querySelector(".ctx-label")?.textContent ?? "").includes("Driven (reference)"));
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  check("the Dimension tool's right-click menu offers Driven (reference)", picked);
  await page.waitForTimeout(200);
  check("turning it on there ticks Reference Dim in the palette", (await row("Reference Dim")).checked,
    `sketch.referenceDim=${await page.evaluate(() => window.__sindri.sketch.referenceDim)}`);
  await page.keyboard.press("Escape");
  await clickRow("Reference Dim"); // and off again, from the palette
  check("the palette switches it back off", !(await page.evaluate(() => window.__sindri.sketch.referenceDim)));

  // ===== a dimensioned line made construction keeps its dimension ============
  console.log("\n=== a dimensioned line made construction keeps its dimension (1bf12403) ===");
  await openSketch(sketchDoc([
    { id: "m", type: "line", x1: 0, y1: 0, x2: 40, y2: 10 }, // measured
    { id: "k", type: "line", x1: 0, y1: 25, x2: 40, y2: 35 }, // locked
  ], [{ type: "distance", line: "k", value: Math.hypot(40, 10) }]));
  const dims = () => page.evaluate(() => {
    let segs = 0;
    window.__sindri.overlay.activeSketch.traverse((o) => {
      if (o.isLineSegments && o.material.color.getHex() === 0x8fa4bd) segs += o.geometry.attributes.position.count / 2;
    });
    const badges = [...document.querySelectorAll(".sketch-dim")].filter((el) => getComputedStyle(el).visibility !== "hidden").length;
    return { segs, badges };
  });
  const before = await dims();
  check("precondition: both lines are dimensioned, with lines", before.badges === 2 && before.segs > 0, JSON.stringify(before));
  await clickAt(10, 2.5);
  await page.keyboard.down("Shift");
  await clickAt(10, 27.5);
  await page.keyboard.up("Shift");
  await page.keyboard.press("x");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("both are construction now", (await ent("m")).construction === true && (await ent("k")).construction === true);
  const after = await dims();
  check("measured and locked alike keep their value AND their dimension lines", after.badges === before.badges && after.segs === before.segs,
    `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);

  // ===== the tangent badge at the point of tangency ========================
  console.log("\n=== the tangent badge sits at the point of tangency (34bede7e) ===");
  // an arc drawn off the end of a 100 mm line, joined and made tangent there
  await openSketch(sketchDoc([
    { id: "l", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 },
    { id: "a", type: "arc", x1: 100, y1: 0, x2: 120, y2: 20, mx: 100 + 20 * S2, my: 20 - 20 * S2 },
  ], [
    { type: "coincident", e1: "l", p1: 1, e2: "a", p2: 0 },
    { type: "tangent2", a: "l", b: "a" },
  ]));
  const joint = await scr(100, 0);
  const oneMm = await scr(101, 0);
  const pxPerMm = Math.hypot(oneMm.x - joint.x, oneMm.y - joint.y);
  const glyphs = await page.evaluate(() => [...document.querySelectorAll(".sketch-glyph")].map((el) => {
    const b = el.getBoundingClientRect();
    return { t: el.textContent, x: b.x + b.width / 2, y: b.y + b.height / 2, l: b.left, r: b.right, top: b.top, bot: b.bottom };
  }));
  const T = glyphs.find((g) => g.t === "T"), C = glyphs.find((g) => g.t === "⊙");
  // where it used to be: halfway between the line's midpoint and the arc's
  const old = { x: (50 + 100 + 20 * S2) / 2, y: (20 - 20 * S2) / 2 };
  const oldPx = Math.hypot(old.x - 100, old.y) * pxPerMm;
  check("precondition: the old spot is well clear of the joint at this zoom", oldPx > 60, `${oldPx.toFixed(0)} px`);
  const dT = T ? Math.hypot(T.x - joint.x, T.y - joint.y) : Infinity;
  check("the T badge is at the joint (beside the ⊙ that is on it)", dT <= 24, `${dT.toFixed(1)} px from the joint`);
  check("...and not on top of the ⊙", !!(T && C) && (T.l >= C.r || C.l >= T.r || T.top >= C.bot || C.top >= T.bot),
    JSON.stringify({ T, C }));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
