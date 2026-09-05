// Field report ab855a5b (0.1.193, Windows): "the sketch dimension labels and the
// constraint icons are drawn on top of the panels and the menus, and clicking
// one of the panels sometimes opens a dimension box instead."
//
// Both sketch label layers were mounted on <body>, positioned in WINDOW
// coordinates by Viewport.projectToScreen, and rewritten every frame with
// whatever came back — no clip, no bounds test — while carrying
// pointer-events: auto. So a label whose anchor projected past the edge of the
// canvas painted over the ribbon, the browser tree and the inspector AND took
// their clicks. Zoom only pushes more anchors out; the first badge lands on the
// ribbon at the document's default view, before any wheel input.
//
// Only a real browser can answer this: it is a question about stacking, hit
// testing and layout, and every unit around it passes while the bug is live.
// Three things are asserted, at the opening view and at four zoom steps:
//   (a) every drawn label is anchored inside #viewport,
//   (b) no point over #browser, #inspector, #ribbon or the sketch palette
//       hit-tests to a label (the palette is the second half of the same bug:
//       .sketch-dims sat at z-index 150, above every piece of chrome there is),
//   (c) a real click on the browser panel does not open a dimension editor.
// (b) is also what proves the clip itself: a badge straddling the viewport edge
// is legitimate and stays in the list for (a), and the sweep says the half of
// it hanging over the ribbon paints nothing and takes no click.
//
// Then a fourth, from a RESET view rather than wherever the zoom loop stopped:
// the one badge holding an open value editor is exempt from the cull AND stays
// wholly inside the viewport, because the clip would otherwise leave it
// off-screen while it still holds the caret and still commits on Enter.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/sketch_label_clip_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running against a second vite on another port.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const BASE = process.env.SC_URL || "http://localhost:5173";

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// The reporter's own document, kept as it arrived: one sketch on XY with nine
// entities and eleven constraints (three radius dims, six tangents, two fixes).
// It matters that it is this one — the dimension badges and the tangent glyphs
// are spread wide enough that a couple of zoom notches push several of them off
// each side of the canvas at once.
const DOC = {
  version: 5,
  paramDefs: {},
  parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [
      { id: "e1", type: "rectangle", x: 1.0132081911709392, y: 2.215388601942106, width: 115.8277142653384, height: 55.84160220064344 },
      { id: "e2", type: "circle", x: -57.31526626254479, y: 71.60739298703358, radius: 13.301 },
      { id: "e3", type: "circle", x: 32.68061256456497, y: 4.656155380829633, radius: 15.968 },
      { id: "e6", type: "line", x1: -4.652038992853125, y1: 8.937941678353857, x2: -45.34266559292678, y2: -19.515423867629956 },
      { id: "e8", type: "arc", mx: -43.03112065156718, my: 12.442575562538948, x1: -40.236840740765146, y1: 13.777062314846315, x2: -44.50367352629992, y2: 9.718526527900927 },
      { id: "e9", type: "arc", mx: -2.8565426923548536, my: 14.845804084631588, x1: -8.169042843830754, y1: 17.992864191649122, x2: -4.652038992853125, y2: 8.937941678353857 },
      { id: "e10", type: "arc", mx: -47.862713586646905, my: -19.008353503305237, x1: -49.19329190056506, y1: -15.944416796702743, x2: -44.52298640053698, y2: -18.9422542302899 },
      { id: "e15", type: "line", x1: -40.236840740765146, y1: 13.777062314846315, x2: -8.169042843830754, y2: 17.992864191649122 },
      { id: "e16", type: "line", x1: -44.50367352629992, y1: 9.718526527900927, x2: -49.19329190056506, y2: -15.944416796702743 },
    ],
    constraints: [
      { id: "c12", type: "radius", e: "e9", value: 5 },
      { type: "tangent2", a: "e9", b: "e6" },
      { type: "tangent2", a: "e6", b: "e10" },
      { id: "c13", type: "radius", e: "e8", value: 5 },
      { id: "c14", type: "radius", e: "e10", value: 3 },
      { type: "tangent2", a: "e16", b: "e8" },
      { type: "tangent2", a: "e15", b: "e8" },
      { type: "tangent2", a: "e15", b: "e9" },
      { type: "tangent2", a: "e16", b: "e10" },
      { type: "fix", e: "e2", p: 0 },
      { type: "fix", e: "e3", p: 0 },
    ],
  }],
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

  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal
  await page.waitForTimeout(400);

  // Wait on the CONDITION, never a stopwatch — a CI runner is much slower than
  // a dev box. Count SETTLED builds and require the counter to advance.
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

  await settle(() => page.evaluate((d) => window.__sindri.store.loadDocument(d), DOC));
  await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
  await page.waitForTimeout(800); // the label layers build on the next frames

  const opened = await page.evaluate(() => ({
    active: window.__sindri.sketch.active,
    dims: document.querySelectorAll(".sketch-dim").length,
    glyphs: document.querySelectorAll(".sketch-glyph").length,
    palette: !!document.querySelector(".palette:not(.hidden)"),
  }));
  check(opened.active === true, "the reporter's sketch opened for edit");
  check(opened.dims > 0 && opened.glyphs > 0,
    "it drew dimension badges and constraint glyphs",
    `${opened.dims} dims, ${opened.glyphs} glyphs`);
  // otherwise the palette half of the sweep below asserts nothing
  check(opened.palette, "the sketch palette is on screen");

  /** Everything a check needs about the labels and the chrome, in one pass. */
  const probe = () => page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const vp = box(document.getElementById("viewport"));
    const labels = [...document.querySelectorAll(".sketch-dim, .sketch-glyph")]
      // a label the code decided not to draw is not on screen and cannot be
      // clicked; getBoundingClientRect still reports its last placement
      .filter((el) => getComputedStyle(el).visibility !== "hidden" && el.offsetWidth > 0)
      .map((el) => ({ cls: el.className, text: (el.textContent || "").slice(0, 20), ...box(el) }));
    // A badge is drawn only where its ANCHOR is still on the canvas. One
    // straddling the edge is legitimate and gets trimmed by the clip — that
    // half is what the panel sweep below proves never paints or hit-tests.
    const escaped = labels.filter((n) => {
      const cx = (n.l + n.r) / 2, cy = (n.t + n.b) / 2;
      return cx < vp.l || cx > vp.r || cy < vp.t || cy > vp.b;
    });

    // Sweep the panels: is a sketch label the TOPMOST thing anywhere over them?
    // elementFromPoint skips pointer-events:none, so a hit here is also a hit
    // the panel underneath will never see.
    const stolen = [];
    const palette = document.querySelector(".palette:not(.hidden)");
    const zones = [document.getElementById("browser"), document.getElementById("inspector"),
      document.getElementById("ribbon"), palette].filter(Boolean);
    for (const el of zones) {
      const id = el.id || el.className;
      const p = box(el);
      for (let x = p.l + 4; x < p.r - 4; x += 12) {
        for (let y = p.t + 4; y < p.b - 4; y += 12) {
          const hit = document.elementFromPoint(x, y);
          const lab = hit && hit.closest && hit.closest(".sketch-dim, .sketch-glyph");
          if (lab) stolen.push({ panel: id, x, y, text: (lab.textContent || "").slice(0, 20) });
        }
      }
    }
    const browserBox = box(document.getElementById("browser"));
    return { vp, labels: labels.length, escaped, stolen, browserBox };
  });

  /** one wheel notch in, over the middle of the viewport */
  const zoomIn = async (vp) => {
    await page.mouse.move((vp.l + vp.r) / 2, (vp.t + vp.b) / 2);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(350);
  };

  const editorCount = () => page.evaluate(() => document.querySelectorAll(".sketch-dim input").length);

  for (let step = 0; step <= 4; step++) {
    const label = step === 0 ? "at the opening view" : `after ${step} zoom notch(es)`;
    const s = await probe();
    check(s.escaped.length === 0,
      `${label}: every drawn label is anchored inside the viewport`,
      s.escaped.length ? JSON.stringify(s.escaped.slice(0, 4)) : `${s.labels} drawn`);
    check(s.stolen.length === 0,
      `${label}: no label hit-tests over the ribbon, the panels or the palette`,
      s.stolen.length ? JSON.stringify(s.stolen.slice(0, 4)) : "swept clean");

    // The reported symptom itself: a real click on the browser panel. Aim it at
    // a point a label was found sitting on when there is one (that is exactly
    // the click the user lost), otherwise at the panel's own middle.
    const target = s.stolen.find((h) => h.panel === "browser")
      ?? { x: (s.browserBox.l + s.browserBox.r) / 2, y: s.browserBox.t + 60 };
    const before = await editorCount();
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(250);
    const after = await editorCount();
    check(after <= before,
      `${label}: clicking the browser panel does not open a dimension editor`,
      `(${Math.round(target.x)}, ${Math.round(target.y)}) editors ${before} -> ${after}`);
    await page.keyboard.press("Escape"); // close an editor if one did open

    if (step < 4) await zoomIn(s.vp);
  }

  // ===== the one label that must survive leaving the canvas ===============
  // Culling an off-canvas label is right until the label is the one you are
  // typing in: hiding an open editor mid-keystroke drops the caret and the
  // half-typed value, and merely exempting it from the cull leaves it parked
  // outside the clip — invisible, still focused, still committing on Enter. It
  // has to stay ON SCREEN, which means pinned inside the canvas.
  //
  // Do NOT run this from wherever the zoom loop happened to stop. Four notches
  // in, this document can have no dimension badge left on the canvas at all,
  // and how many survive varies between machines — so the view is reset first
  // and the zoom depth is MEASURED here rather than assumed.
  console.log("\n=== the badge being edited stays put when it leaves the canvas ===");

  /** back to the framed startup view, without changing the sketch orientation */
  const refit = async () => {
    await page.evaluate(() => window.__sindri.viewport.fitView());
    await page.waitForTimeout(900); // rig.fit() transitions
  };
  const visibleDims = () => page.evaluate(() =>
    [...document.querySelectorAll(".sketch-dim")]
      .filter((el) => getComputedStyle(el).visibility !== "hidden").length);

  await refit();
  const backOnScreen = await visibleDims();
  check(backOnScreen > 0, "the view resets to somewhere badges are on screen",
    `${backOnScreen} dims visible`);

  // Tag the badge furthest from the middle: it is the first to leave.
  const tagged = await page.evaluate(() => {
    const vp = document.getElementById("viewport").getBoundingClientRect();
    const mid = { x: (vp.left + vp.right) / 2, y: (vp.top + vp.bottom) / 2 };
    let best = null;
    for (const el of document.querySelectorAll(".sketch-dim")) {
      if (getComputedStyle(el).visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const c = { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
      const d = (c.cx - mid.x) ** 2 + (c.cy - mid.y) ** 2;
      if (!best || d > best.d) best = { d, el, text: el.textContent };
    }
    if (!best) return null;
    best.el.dataset.e2e = "watched";
    return { text: best.text, mid };
  });
  check(!!tagged, "found a dimension badge to watch");

  if (tagged) {
    const watched = () => page.evaluate(() => {
      const el = document.querySelector('.sketch-dim[data-e2e="watched"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const vp = document.getElementById("viewport").getBoundingClientRect();
      const inp = el.querySelector("input");
      return {
        hidden: getComputedStyle(el).visibility === "hidden",
        inside: r.left >= vp.left && r.right <= vp.right && r.top >= vp.top && r.bottom <= vp.bottom,
        rect: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) },
        vp: { l: Math.round(vp.left), t: Math.round(vp.top), r: Math.round(vp.right), b: Math.round(vp.bottom) },
        hasInput: !!inp,
        focused: !!inp && document.activeElement === inp,
        othersHidden: [...document.querySelectorAll(".sketch-dim")]
          .filter((n) => n !== el && getComputedStyle(n).visibility === "hidden").length,
      };
    });
    const zoomAt = async (pt) => {
      await page.mouse.move(pt.x, pt.y);
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(350);
    };

    // (1) With no editor open, how far in does this badge's anchor leave the
    //     canvas? That the badge is CULLED is the proof that it did.
    // Up to 40 notches: the CI runner's window and font metrics put the badge
    // further from the edge than this box does, and 10 was not enough there.
    let notches = 0;
    for (let i = 1; i <= 40; i++) {
      await zoomAt(tagged.mid);
      notches = i;
      if ((await watched())?.hidden) break;
    }
    const culled = (await watched())?.hidden === true;
    check(culled, "with no editor open, that badge is culled once its anchor leaves the canvas",
      `after ${notches} notch(es) on "${tagged.text}"`);

    // (2) Same view, same zoom — this time with its value editor open.
    if (culled) {
      await refit();
      const back = await watched();
      check(back && !back.hidden, "and it is drawn again once the view is reset");

      const spot = await page.evaluate(() => {
        const r = document.querySelector('.sketch-dim[data-e2e="watched"]').getBoundingClientRect();
        return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
      });
      await page.mouse.dblclick(spot.x, spot.y);
      await page.waitForTimeout(250);
      const opened2 = await watched();
      check(!!opened2 && opened2.hasInput && opened2.focused,
        "double-clicking it opened its value editor", `on "${tagged.text}"`);

      for (let i = 0; i < notches; i++) await zoomAt(tagged.mid);

      const after = await watched();
      check(!!after && !after.hidden && after.hasInput && after.focused,
        "at the same zoom it is still drawn, still an input, still holding the caret",
        JSON.stringify(after && { hidden: after.hidden, hasInput: after.hasInput, focused: after.focused }));
      // exempting it from the cull is not enough: #viewport-overlay clips, so a
      // badge left at its projected pixel is off-screen while still typeable
      check(!!after && after.inside,
        "and the whole badge is inside the viewport, not clipped away past its edge",
        after ? `badge ${JSON.stringify(after.rect)} in ${JSON.stringify(after.vp)}` : "");
      check(!!after && after.othersHidden > 0,
        "while the badges NOT being edited were culled — only the editor is spared",
        after ? `${after.othersHidden} hidden` : "");
      await page.keyboard.press("Escape");
    }
  }

  console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILED`}`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
