// End-to-end check of what the user is left with when the GPU takes the 3D
// context away, in a real browser.
//
// Field report 2f0dfd2d: enlarging the window on a memory-starved Windows box
// left the viewport blank. The blank half of that is reproducible here — a lost
// context is silent (three calls preventDefault(), logs to the console and sets
// a flag), the render loop is render-on-demand so nothing repaints when the
// browser hands the context back, and three's initGLContext drops the clear
// colour set at startup, so the first frame after a recovery is black.
//
// Unit tests cannot reach any of this: it needs a real GL context and a real
// compositor, and the repo has no jsdom (same reasoning as
// e2e/webgl_fallback_e2e.cjs). The assertions here are effects — what the DOM
// says, whether a frame was drawn with nobody touching the app, and what colour
// the composited viewport actually is.
//
// It cannot see the REPORTED colour: white came from the WebView2 surface below
// the page during a native Windows resize, which is fixed in
// src-tauri/tauri.conf.json and is invisible to any browser test on Linux.
//
// Usage (from the repo root; NO sidecar needed, nothing here draws geometry):
//   npx vite --port 5199 &
//   SC_URL=http://localhost:5199 node e2e/webgl_context_loss_e2e.cjs
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

/** The clear colour set in src/viewport/scene.ts (0x1a1d21). */
const CLEAR = [26, 29, 33];

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // the welcome screen would sit over the viewport we want to photograph
  await page.addInitScript(`localStorage.setItem("sindri.welcomeOnStartup", "false");`);
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => !!(window.__sindri && window.__sindri.viewport), null,
    { timeout: 20000 });
  await page.waitForTimeout(1200); // let the first frames land

  // Arm: record the frame counter at the instant the context comes back, BEFORE
  // anything has had a chance to repaint (our listener is added last, so it runs
  // after three's re-init, and drawing only happens on a later animation frame).
  const armed = await page.evaluate(() => {
    const r = window.__sindri.viewport.scene.renderer;
    window.__ctx = { restoredAtFrame: -1, ext: r.getContext().getExtension("WEBGL_lose_context") };
    r.domElement.addEventListener("webglcontextrestored", () => {
      window.__ctx.restoredAtFrame = r.info.render.frame;
    });
    return !!window.__ctx.ext;
  });
  check("the harness can take the context away", armed);

  await page.evaluate(() => window.__ctx.ext.loseContext());
  await page.waitForTimeout(400);
  check("the context really is lost",
    await page.evaluate(() => window.__sindri.viewport.scene.renderer.getContext().isContextLost()));

  // 1. The user is told, instead of staring at a dead rectangle.
  const said = await page.evaluate(() => document.body.innerText);
  check("1: the user is told the graphics context went away",
    /graphics context/i.test(said), said.replace(/\s+/g, " ").slice(0, 140));

  // 2. It comes back on its own. NO input of any kind between here and the read:
  //    render-on-demand means a restored context draws nothing until something
  //    dirties the scene, and "move the camera to wake it up" is not a fix.
  await page.evaluate(() => window.__ctx.ext.restoreContext());
  await page.waitForTimeout(1500);
  const frames = await page.evaluate(() => ({
    at: window.__ctx.restoredAtFrame,
    now: window.__sindri.viewport.scene.renderer.info.render.frame,
  }));
  check("2: the viewport repaints itself once the context is back, with no user input",
    frames.at >= 0 && frames.now > frames.at, `frame ${frames.at} -> ${frames.now}`);

  // 3. And it comes back the right colour. three's initGLContext rebuilds its
  //    background module on restore and drops setClearColor, which composites
  //    black; a dead canvas composites the page's own dark gradient. Neither is
  //    the viewport.
  const shot = (await page.screenshot()).toString("base64");
  const patch = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}`; });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const rect = document.getElementById("viewport").getBoundingClientRect();
    const s = img.width / window.innerWidth; // the shot may be in device pixels
    const cx = Math.round((rect.left + rect.width / 2) * s);
    const cy = Math.round((rect.top + rect.height / 2) * s);
    // The exact centre can land on the origin axes or a grid line, so take the
    // most common colour of the patch around it — that is the background.
    const half = 24;
    const d = g.getImageData(cx - half, cy - half, half * 2, half * 2).data;
    const tally = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    return [...tally].sort((a, b) => b[1] - a[1])[0][0];
  }, shot);
  const rgb = patch.split(",").map(Number);
  check("3: the recovered viewport is the app's own colour again, not black",
    rgb.every((v, i) => Math.abs(v - CLEAR[i]) <= 2),
    `rgb(${patch}), want rgb(${CLEAR.join(",")})`);

  await page.close();
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
