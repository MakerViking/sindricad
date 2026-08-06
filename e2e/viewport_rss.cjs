// Post-Phase-A viewport RSS: what a large document ACTUALLY costs in memory.
//
// WHY THIS EXISTS: the number the assemblies plan was built on — 12.2 GiB peak
// RSS at 3,060 bodies — is the PRE-optimisation figure. `src/viewport/
// edgeLines.ts` says so in as many words. Phase A replaced the per-body
// LineSegments2 + per-edge material scheme that produced it, and nobody has
// measured what replaced it. "The viewport OOMs at 3,060 bodies" therefore
// describes deleted code, and every capability claim resting on it is
// unanchored.
//
// Measures RSS of the WHOLE browser process tree (browser + renderers + GPU),
// because a WebGL scene's cost is spread across all three and the renderer's
// JS heap alone would under-report badly. Read from /proc, so Linux only —
// which matches where the original 12.2 GiB was measured.
//
// A MEASUREMENT ORACLE, like the other evals: it prints numbers and exits 0.
// Deliberately not a CI gate — RSS on a shared runner is not reproducible
// enough to ratchet.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   sidecar/.venv/bin/python e2e/gen_perf_docs.py
//   SC_TOKEN=<sidecar token> node e2e/viewport_rss.cjs
const { chromium } = require("playwright-core");
const fs = require("fs");

const CHROME = process.env.SC_CHROME || "/usr/bin/chromium";
// The launcher is usually a symlink (/usr/bin/chromium -> /usr/lib/chromium/
// chromium), so the pids carry the RESOLVED path. Match on the basename and
// subtract whatever was already running.
const CHROME_MATCH = process.env.SC_CHROME_MATCH || "chromium";

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const SIZES = (process.env.SC_RSS_SIZES || "100,1000,3000").split(",").map(Number);
const DOCS = process.env.SC_PERF_DIR || "/tmp";

/** Pids of every process whose cmdline mentions `needle`. */
function pidsMatching(needle) {
  const out = new Set();
  for (const e of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${e}/cmdline`, "utf8");
      if (cmd.includes(needle)) out.add(Number(e));
    } catch { /* vanished */ }
  }
  return out;
}

/** RSS in MiB summed over the given pids. Browser + renderers + GPU together:
 *  a WebGL scene's cost is spread across all three, and the renderer's JS heap
 *  alone under-reports it badly. */
function rssMiB(pids) {
  let total = 0, n = 0;
  for (const pid of pids) {
    try {
      const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
      if (m) { total += Number(m[1]); n += 1; }
    } catch { /* gone */ }
  }
  return { mib: total / 1024, procs: n };
}

(async () => {
  const preExisting = pidsMatching(CHROME_MATCH);
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  // Chromium exposes no pid on this playwright build, so identify OUR processes
  // by subtracting the ones that already existed before launch.
  const ours = () => new Set([...pidsMatching(CHROME_MATCH)].filter((p) => !preExisting.has(p)));
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.addInitScript((t) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, TOKEN);

  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(3500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store, null, { timeout: 60000 });
  await page.waitForTimeout(1500);

  const base = rssMiB(ours());
  console.log(`baseline (empty document): ${base.mib.toFixed(0)} MiB across ${base.procs} processes\n`);
  console.log("bodies    RSS MiB   over baseline   MiB/body   fps");

  const rows = [];
  for (const n of SIZES) {
    const file = `${DOCS}/perf_tree_${n}.sindri`;
    if (!fs.existsSync(file)) { console.log(`${n}: no ${file} — run gen_perf_docs.py`); continue; }
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    await page.evaluate(async (d) => {
      window.store.loadDocument(d);
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (!window.store.buildState.building && window.store.buildState.result) break;
      }
    }, doc);
    // let the viewport actually build and settle before reading
    await page.waitForTimeout(6000);

    // fps WHILE ORBITING, not while idle. requestAnimationFrame on a static
    // scene reports ~60 whatever the body count, because nothing is being
    // redrawn — it measures the vsync clock, not the renderer. The number that
    // matters is the one the user feels when dragging, so the camera is
    // actually moved for the whole sample window.
    const box = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.evaluate(() => {
      window.__frames = 0; window.__t0 = performance.now();
      const tick = () => { window.__frames += 1; window.__raf = requestAnimationFrame(tick); };
      window.__raf = requestAnimationFrame(tick);
    });
    const camBefore = await page.evaluate(() => {
      const c = window.viewport?.camera;
      return c ? [c.position.x, c.position.y, c.position.z] : [0, 0, 0];
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down({ button: "middle" });  // middle = orbit (Fusion convention)
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(box.x + Math.round(80 * Math.sin(i / 4)), box.y + (i % 7) * 3);
      await page.waitForTimeout(50);
    }
    await page.mouse.up({ button: "middle" });
    // Prove the drag ROTATED something. A drag the app ignores would leave the
    // camera still and this whole fps column would be measuring an idle scene
    // dressed up as an interactive one.
    const moved = await page.evaluate((c0) => {
      const c = window.viewport?.camera;
      if (!c) return null;
      const d = Math.hypot(c.position.x - c0[0], c.position.y - c0[1], c.position.z - c0[2]);
      return d;
    }, camBefore);
    if (moved === null) console.log("    (no camera handle — fps unverified)");
    else if (moved < 1e-6) console.log(`    WARNING: camera did not move (${moved}) — fps is an IDLE number`);
    const fps = await page.evaluate(() => {
      cancelAnimationFrame(window.__raf);
      return window.__frames / ((performance.now() - window.__t0) / 1000);
    });

    const r = rssMiB(ours());
    const over = r.mib - base.mib;
    rows.push({ n, mib: r.mib, over, fps });
    console.log(
      `${String(n).padEnd(9)} ${r.mib.toFixed(0).padStart(7)} ${over.toFixed(0).padStart(13)} ` +
      `${(over / n).toFixed(3).padStart(10)} ${fps.toFixed(1).padStart(6)}`
    );
  }

  console.log("\n--- verdict ---");
  const big = rows[rows.length - 1];
  if (big) {
    console.log(`At ${big.n} bodies the whole browser tree holds ${big.mib.toFixed(0)} MiB.`);
    console.log(`The pre-Phase-A figure the plan was built on was 12,492 MiB (12.2 GiB).`);
    const ratio = 12492 / big.mib;
    console.log(`Post-Phase-A is ${ratio.toFixed(1)}x smaller on this measurement.`);
    console.log(big.mib > 4096
      ? "STILL heavy: a 16 GB machine is at risk."
      : "Comfortable on a 16 GB machine; the OOM framing no longer applies.");
  }
  await browser.close();
})();
