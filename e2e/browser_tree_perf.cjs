// Browser-tree render cost: does the assembly tree actually pay for itself?
//
// Phase C shipped the nested Browser "correct-but-slow" by an explicit decision,
// on the arithmetic that assembly nodes are collapsed by default so a 3,000-part
// import paints its ROOTS instead of 3,000 rows. That is arithmetic, not
// observation, so this measures it. Two claims are under test:
//
//   1. the collapsed tree is not SLOWER than the flat list it replaces
//   2. the N at which a render crosses 100ms — which is what expanding a node
//      with N children costs, the case collapsing does NOT help
//
// Both documents hold the SAME bodies; only the manifest differs, so the
// difference measured is the tree and nothing else.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> node e2e/browser_tree_perf.cjs
const { chromium } = require("playwright-core");
const fs = require("fs");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const SIZES = [100, 1000, 3000];
const REPEATS = 7;

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  // SUBSTITUTE the token into the sidecar URL — the app already builds `?token=`
  // (empty outside Tauri), and the override must be scoped to 8765 or vite's own
  // HMR socket breaks and fills the run with red herrings.
  await page.addInitScript((t) => {
    const N = window.WebSocket;
    // must be a real subclass: a plain function wrapper breaks `new.target` and
    // the app ends up with a socket it cannot send on ("reading 'send' of null")
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
  await page.waitForFunction(() => !!window.store && !!window.tree, null, { timeout: 60000 });

  const results = [];
  for (const n of SIZES) {
    for (const kind of ["flat", "tree"]) {
      const doc = JSON.parse(fs.readFileSync(`/tmp/perf_${kind}_${n}.sindri`, "utf8"));
      const stat = await page.evaluate(
        async ({ doc, repeats }) => {
          window.store.loadDocument(doc);
          const t0 = Date.now();
          while (Date.now() - t0 < 300000) {
            if (!window.store.buildState.building && window.store.buildState.result) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          const bodies = (window.store.buildState.result?.bodies ?? []).length;
          // time the tree render ALONE: refresh() clears the signature guard and
          // rebuilds the panel synchronously, so this excludes viewport work.
          const samples = [];
          for (let i = 0; i < repeats; i++) {
            const a = performance.now();
            window.tree.refresh();
            samples.push(performance.now() - a);
          }
          samples.sort((x, y) => x - y);
          return {
            bodies,
            rows: document.querySelectorAll("#browser .feature-row").length,
            folders: document.querySelectorAll("#browser .tree-folder").length,
            median: samples[Math.floor(samples.length / 2)],
            max: samples[samples.length - 1],
          };
        },
        { doc, repeats: REPEATS },
      );
      results.push({ n, kind, ...stat });
      console.log(
        `${String(n).padStart(5)} bodies  ${kind.padEnd(5)}  ` +
          `built=${String(stat.bodies).padStart(4)}  rows=${String(stat.rows).padStart(4)}  ` +
          `folders=${String(stat.folders).padStart(4)}  ` +
          `render median=${stat.median.toFixed(2)}ms max=${stat.max.toFixed(2)}ms`,
      );
    }
  }

  console.log("\n--- verdict ---");
  let ok = true;
  for (const n of SIZES) {
    const flat = results.find((r) => r.n === n && r.kind === "flat");
    const tree = results.find((r) => r.n === n && r.kind === "tree");
    if (!flat || !tree) continue;
    const faster = tree.median <= flat.median;
    if (!faster) ok = false;
    console.log(
      `${String(n).padStart(5)} bodies: tree ${tree.median.toFixed(2)}ms vs flat ` +
        `${flat.median.toFixed(2)}ms -> ${faster ? "OK" : "SLOWER — STOP"} ` +
        `(${flat.rows} rows -> ${tree.rows})`,
    );
  }
  const over = results.filter((r) => r.median > 100);
  console.log(
    over.length
      ? `crosses 100ms at: ${over.map((r) => `${r.n}/${r.kind}`).join(", ")}`
      : "nothing crossed 100ms at any size measured",
  );
  console.log(ok ? "PASS: the collapsed tree is no worse than the flat list" : "FAIL");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
