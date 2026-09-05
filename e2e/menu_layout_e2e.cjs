// Do the dropdown menus fit their own contents? Measured in a real browser.
//
// Two Windows 11 reports (dda4fa30, 19ff37b0): every menu had "a big empty
// space/margin on the right side", and longer entries wrapped onto a second
// line. `.menu-popup` is absolutely positioned inside `.menu`, which is only as
// wide as its "File"/"Edit" button (~50px), and for an absolutely positioned box
// shrink-to-fit is min(max(min-content, available), max-content) — with
// `available` ~50px that always resolves to MIN-CONTENT, i.e. the longest single
// WORD. A fixed `min-width` was the only thing holding the menus open, so how
// much dead space was left on the right, or whether labels wrapped instead, came
// down to whichever font the platform substituted for the (unbundled) Inter.
//
// Unit tests cannot see this: the repo has no jsdom, and jsdom does no layout
// anyway. Only a real engine measures a wrapped row, which is why this file
// exists alongside e2e/webgl_fallback_e2e.cjs.
//
// The three letter-spacing metrics stand in for platform font substitution. They
// are deliberately font-agnostic — a CI runner has neither Segoe UI Variable nor
// Inter, so injecting a metric is the only way to behave the same everywhere.
//
// Usage (from the repo root; NO sidecar needed — the menubar is built during
// module evaluation, long before geometry connects):
//   npx vite --port 5199 &
//   SC_URL=http://localhost:5199 node e2e/menu_layout_e2e.cjs
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

// One text line is ~18px inside 7px of padding top and bottom, so a single-line
// row measures ~32px and a wrapped one ~50px.
const MAX_ROW_HEIGHT = 36;
// 10px item padding + 4px popup padding + 1px border = 15px of legitimate inset.
const MAX_DEAD_MARGIN = 24;

const setup = `
  localStorage.setItem("sindri.welcomeOnStartup", "false");
  addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("style");
    // The pop-in keyframe starts at scale(.98). Every rect read mid-animation is
    // 2% small, which is enough to turn a real overflow into a pass.
    s.textContent = ".menu-popup { animation: none !important; }";
    document.head.appendChild(s);
  });
`;

/** Runs in the page. Tallest row, and the gap from the widest row's text INK
 *  (not its box — a flex child stretches past its glyphs) to the popup's right
 *  edge. */
function measure(popup) {
  let tallest = 0, ink = -Infinity, widestText = "";
  for (const row of popup.querySelectorAll(".menu-item")) {
    tallest = Math.max(tallest, row.getBoundingClientRect().height);
    for (const el of row.querySelectorAll(".menu-label, .menu-shortcut")) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (!r.width) continue;
      if (r.right > ink) { ink = r.right; widestText = row.textContent; }
    }
  }
  const box = popup.getBoundingClientRect();
  return { tallest, margin: box.right - ink, width: box.width, widestText };
}

async function boot(browser, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(setup);
  await page.goto(URL, { waitUntil: "load" });
  // Generous: the first page load against a cold vite pays for dependency
  // optimisation (three, the planegcs wasm) before any module evaluates.
  await page.waitForSelector("#menubar .menu-btn", { timeout: 60000 });
  await page.waitForTimeout(500);
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

  // --- A: every menubar popup, at three font metrics. -----------------------
  {
    const { page } = await boot(browser);
    const names = await page.$$eval("#menubar .menu-btn", (b) => b.map((x) => x.textContent));
    check("A: the menubar built", names.length >= 5, names.join(", "));

    for (const spacing of [-0.6, 0, 0.9]) {
      const tag = spacing < 0 ? "narrow font" : spacing > 0 ? "wide font" : "this box's font";
      await page.addStyleTag({
        content: `.menu-popup, .menu-popup * { letter-spacing: ${spacing}px; }`,
      });
      for (let i = 0; i < names.length; i++) {
        const btn = (await page.$$("#menubar .menu-btn"))[i];
        await btn.click();
        const popup = await page.$(".menu-popup:not(.hidden)");
        const m = popup ? await popup.evaluate(measure) : null;
        if (!m) {
          check(`A: ${names[i]} opens (${tag})`, false);
          continue;
        }
        check(`A: ${names[i]} keeps every row on one line (${tag})`,
          m.tallest <= MAX_ROW_HEIGHT, `tallest row ${m.tallest.toFixed(1)}px`);
        check(`A: ${names[i]} has no dead margin on the right (${tag})`,
          m.margin <= MAX_DEAD_MARGIN,
          `${m.margin.toFixed(1)}px past "${m.widestText.trim()}", popup ${m.width.toFixed(1)}px`);
      }
      await page.keyboard.press("Escape");
    }
    await page.close();
  }

  // --- B: the view cube's own popup stays inside the window. ----------------
  // src/viewport/viewCube.ts reuses the .menu-popup class as a position:fixed
  // box placed at the raw right-click coordinate, and the cube lives in the
  // TOP-RIGHT corner, so nothing but its own clamp bounds the right edge. In
  // today's layout the 252px inspector column happens to keep the cube that far
  // from the window edge; this squeezes that column to zero so the guard is
  // exercised rather than taken on trust.
  {
    const { page } = await boot(browser);
    await page.addStyleTag({ content: "#main { grid-template-columns: 232px 1fr 0px !important; }" });
    await page.waitForTimeout(300);
    const out = await page.evaluate(() => {
      const c = document.getElementById("canvas");
      if (!c) return { reason: "no canvas" };
      const r = c.getBoundingClientRect();
      const SIZE = 120, MARGIN = 14;
      const left = r.right - SIZE - MARGIN, top = r.top + MARGIN;
      // Right-click the cube. Which pixel lands on a FACE (rather than an edge
      // or corner nub) depends on the camera, so sweep the corner box until one
      // opens a menu.
      for (let dy = 10; dy < SIZE; dy += 10) {
        for (let dx = 10; dx < SIZE; dx += 10) {
          c.dispatchEvent(new MouseEvent("contextmenu", {
            clientX: left + dx, clientY: top + dy, bubbles: true, cancelable: true,
          }));
          const m = document.querySelector(".viewcube-menu");
          if (m) {
            const b = m.getBoundingClientRect();
            return { left: b.left, right: b.right, width: b.width,
                     innerWidth: window.innerWidth, label: m.textContent };
          }
        }
      }
      return { reason: "no face hit" };
    });
    check("B: right-clicking a cube face opens its menu", !out.reason, out.reason);
    if (!out.reason) {
      check("B: the view cube menu stays inside the window",
        out.right <= out.innerWidth && out.left >= 0,
        `left ${out.left.toFixed(1)} right ${out.right.toFixed(1)} of ${out.innerWidth}`);
    }
    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
