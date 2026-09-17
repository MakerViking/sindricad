// Real browser -> websocket -> worker edit/undo/redo benchmark. Not a CI timing
// gate. Run against an isolated DEV stack and temporary sidecar caches:
//   SC_TOKEN=<token> SC_URL=http://127.0.0.1:5197 node e2e/cache_history_perf.cjs
// Uses software rendering for repeatability; frame times are NOT desktop GPU
// performance. Does not open/save user files. Feature IDs isolate cold histories.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
const RUNS = Number(process.env.SC_RUNS || 3);
if (!TOKEN || !Number.isInteger(RUNS) || RUNS < 1) {
  console.error("Set SC_TOKEN and optionally SC_RUNS (a positive integer).");
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => pageErrors.push(error.message));
    // The welcome overlay (and its remote iframe) is not part of editing.
    // This is an ephemeral browser profile, not the user's preferences.
    await page.addInitScript(() => localStorage.setItem("sindri.welcomeOnStartup", "false"));
    const url = new URL(process.env.SC_URL || "http://127.0.0.1:5173");
    url.searchParams.set("token", TOKEN);
    await page.goto(url.toString());
    await page.waitForFunction(() => window.geometry?.connected && window.store && !window.store.buildState.building);
    const rows = await page.evaluate(async runs => {
      const { store, geometry, viewport } = window;
      let current = null;
      // Includes response decoding, assembly and progressive viewport callbacks;
      // it is deliberately NOT labelled pure transport or kernel time.
      const rebuild = geometry.rebuild.bind(geometry);
      geometry.rebuild = async (...args) => {
        const start = performance.now();
        try { return await rebuild(...args); }
        finally { if (current) current.rebuild_ms = performance.now() - start; }
      };
      for (const name of ["setModel", "beginProgressiveModel", "appendProgressiveBodies"]) {
        const method = viewport[name].bind(viewport);
        viewport[name] = (...args) => {
          const start = performance.now();
          try { return method(...args); }
          finally { if (current) current[name + "_ms"] = (current[name + "_ms"] || 0) + performance.now() - start; }
        };
      }
      const rows = [];
      const measure = async (run, phase, edited, action) => {
        const row = { run, phase };
        let armed = false;
        let started = false;
        let unsubscribe;
        let timeout;
        const start = performance.now();
        const settled = new Promise((resolve, reject) => {
          timeout = setTimeout(() => { unsubscribe(); reject(new Error("Build timeout: " + phase)); }, 60000);
          unsubscribe = store.onBuild(state => {
            if (!armed) return; // onBuild immediately replays the existing state
            if (state.building) { started = true; return; }
            if (!started) return;
            clearTimeout(timeout);
            unsubscribe();
            if (state.errorMessage || state.result?.featureErrors?.length) {
              reject(new Error(state.errorMessage || JSON.stringify(state.result.featureErrors)));
              return;
            }
            const bodies = state.result?.bodies;
            if (bodies?.length !== 1 || bodies[0].faceCount !== 55 ||
                bodies[0].faceOwners?.length !== 55 || !state.result.mesh.positions.length) {
              reject(new Error("Missing geometry or provenance: " + phase));
              return;
            }
            // Registered after the application's build listeners: their
            // synchronous UI/viewport updates have completed at this point.
            row.settled_ms = performance.now() - start;
            resolve();
          });
        });
        current = row;
        armed = true;
        try {
          action();
          await settled;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          row.two_frames_ms = performance.now() - start;
        } finally {
          current = null;
          clearTimeout(timeout);
          unsubscribe();
        }
        // A render opportunity, not proof of physical screen presentation.
        // Exact geometry checks are outside the timing window. This operation
        // uses the read-only rebuild path, preserving the editing RAM cache.
        const mass = await geometry.massProperties(store.buildDocument(), { checks: true });
        const body = mass.result?.bodies?.[0];
        const volume = 100000 - Math.PI * 10 * (49 * 4 + (edited ? 0.41 : 0));
        if (!mass.ok || mass.result?.bodies?.length !== 1 || mass.result?.warnings?.length ||
            !body?.measured || !body.valid || !body.watertight || body.counts.faces !== 55 ||
            Math.abs(body.volume - volume) > 1e-6) {
          throw new Error("Geometry check failed for " + phase + ": " + JSON.stringify(mass));
        }
        row.volume = body.volume;
        rows.push(row);
        await new Promise(resolve => setTimeout(resolve, 0));
      };
      for (let run = 0; run < runs; run++) {
        const prefix = crypto.randomUUID() + "-";
        const features = [
          { id: prefix + "outline", type: "sketch", plane: "XY", entities: [
            { type: "rectangle", width: 100, height: 100, x: 0, y: 0 }] },
          { id: prefix + "base", type: "extrude", sketch: prefix + "outline", distance: 10, operation: "new" },
        ];
        for (let i = 0; i < 49; i++) features.push(
          { id: prefix + "s" + i, type: "sketch", plane: "XY", entities: [
            { type: "circle", radius: 2, x: -36 + 12 * (i % 7), y: -36 + 12 * Math.floor(i / 7) }] },
          { id: prefix + "h" + i, type: "extrude", sketch: prefix + "s" + i, distance: 12, operation: "cut" },
        );
        await measure(run, "cold", false, () => store.loadDocument({ version: 5, parameters: {}, features }));
        await measure(run, "unchanged", false, () => void store.rebuildNow());
        const original = store.document.features[62];
        const edited = { ...original, entities: original.entities.map(e => ({ ...e, radius: 2.1 })) };
        await measure(run, "edit", true, () => store.replaceFeature(original.id, edited));
        await measure(run, "undo", false, () => store.undo());
        await measure(run, "after_undo", false, () => void store.rebuildNow());
        await measure(run, "redo", true, () => store.redo());
        await measure(run, "after_redo", true, () => void store.rebuildNow());
      }
      return rows;
    }, RUNS);
    if (process.env.SC_SCREENSHOT) await page.screenshot({ path: process.env.SC_SCREENSHOT });
    if (pageErrors.length) throw new Error(pageErrors.join("\n"));
    const median = values => {
      values.sort((a, b) => a - b);
      const mid = Math.floor(values.length / 2);
      return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    };
    const summary = [...new Set(rows.map(row => row.phase))].map(phase => ({
      phase,
      ...Object.fromEntries(["rebuild_ms", "settled_ms", "two_frames_ms", "setModel_ms",
        "beginProgressiveModel_ms", "appendProgressiveBodies_ms"].map(key =>
        [key, median(rows.filter(row => row.phase === phase).map(row => row[key] || 0))])),
    }));
    console.log(JSON.stringify({ renderer: "SwiftShader", runs: RUNS, rows, summary, geometry_checks: "passed" }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
