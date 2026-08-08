// Real-app check of the CHUNKED rebuild reply on the reference assembly.
//
// Drives the real client (src/geometry/client.ts) in a real browser against a
// real sidecar, over the real socket — the only thing faked is the Tauri file
// dialog, which a browser harness cannot reach anyway. Counts the frames that
// actually cross the wire by adding a passive "message" listener to every
// WebSocket the app opens (it fires alongside the app's own onmessage, so the
// app is untouched), and peeks each binary frame's JSON header to tell a
// chunked stream from a single frame.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<token> node e2e/chunked_reference.cjs [--tag NAME]
const { chromium } = require("playwright-core");
const fs = require("fs");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const FILE = process.env.SC_FILE || "/mnt/intel335/Enderwire/FT Enderwire V2-0.step";
const TAG = (process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "run");
const BUDGET_MS = 15 * 60 * 1000;

(async () => {
  if (!fs.existsSync(FILE)) { console.error(`reference file missing: ${FILE}`); process.exit(1); }
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--no-sandbox", "--js-flags=--max-old-space-size=8192"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });

  await page.addInitScript((t) => {
    window.__wire = { frames: [], status: 0 };
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
        // Passive observer: runs in ADDITION to the app's onmessage handler, so
        // nothing about the client's own decoding changes.
        this.addEventListener("message", (e) => {
          if (typeof e.data === "string") {
            try { if (JSON.parse(e.data).status) window.__wire.status++; } catch {}
            return;
          }
          const buf = e.data;
          const rec = { bytes: buf.byteLength };
          try {
            const hlen = new DataView(buf).getUint32(0, true);
            const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
            if (h.stream) {
              rec.seq = h.stream.seq;
              rec.final = h.stream.final;
              rec.manifest = h.result && h.result.manifest ? h.result.manifest.length : undefined;
              rec.bodies = h.result && h.result.bodies ? h.result.bodies.length : 0;
            } else {
              rec.single = true;
              rec.bodies = h.result && h.result.bodies ? h.result.bodies.length : 0;
            }
          } catch (err) { rec.headerError = String(err); }
          window.__wire.frames.push(rec);
        });
      }
    }
    window.WebSocket = P;
  }, TOKEN);

  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(3500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.geometry && !!window.viewport,
    null, { timeout: 60000 });

  console.log(`\n=== ${TAG}: importing ${FILE} ===`);
  const t0 = Date.now();
  const out = await page.evaluate(async ({ file, budget }) => {
    const mark = {};
    // Record progressive display as it happens: every installment, and how many
    // bodies the VIEWPORT actually held at that moment.
    const steps = [];
    const t00 = Date.now();
    window.store.onBuildChunk((c) => {
      steps.push({
        t: Date.now() - t00, phase: c.phase, done: c.done, total: c.total,
        drawn: window.viewport.model ? window.viewport.model.bodies.length : 0,
      });
    });
    let aborts = 0;
    window.store.onBuildAbort(() => { aborts++; });
    const ti = Date.now();
    const res = await window.geometry.importGeometry(file, "step");
    mark.importMs = Date.now() - ti;
    if (!res.ok) return { ok: false, message: res.message, mark };
    // exactly as src/io/files.ts builds it
    window.store.addFeature({
      id: window.store.nextId(), type: "import", format: "step",
      name: res.name, geom: res.geom, source: file, solid: res.solid,
      ...(res.color !== undefined ? { color: res.color } : {}),
      ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
      ...(res.parts !== undefined ? { parts: res.parts } : {}),
    });
    const tb = Date.now();
    while (Date.now() - tb < budget) {
      const b = window.store.buildState;
      if (!b.building && b.result) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    mark.buildMs = Date.now() - tb;
    const b = window.store.buildState;
    if (!b.result) return { ok: false, message: "build never settled", mark, wire: window.__wire };

    // What the VIEWPORT actually holds, not just what arrived on the wire.
    const view = window.viewport.model;
    let tris = 0, verts = 0;
    for (const body of view ? view.bodies : []) {
      const g = body.mesh.geometry;
      tris += (g.index ? g.index.count : 0) / 3;
      verts += g.attributes.position.count;
    }
    return {
      ok: true, mark, steps, aborts,
      wire: window.__wire,
      nodes: res.nodes ? res.nodes.length : 0,
      parts: res.parts ? res.parts.length : 0,
      doc: {
        bodies: (b.result.bodies || []).length,
        meshTris: b.result.mesh.faceIds.length,
        meshVerts: b.result.mesh.positions.length / 3,
        edges: b.result.edges.length,
        bbox: b.result.bbox,
      },
      scene: { bodies: view ? view.bodies.length : 0, tris, verts,
               objects: window.viewport.scene ? undefined : undefined },
    };
  }, { file: FILE, budget: BUDGET_MS });

  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  if (!out.ok) {
    console.error(`FAILED after ${wall}s: ${out.message}`);
    console.error("wire:", JSON.stringify(out.wire, null, 1).slice(0, 4000));
    await browser.close();
    process.exit(1);
  }

  const f = out.wire.frames;
  const big = f.filter((x) => x.bytes > 4096);
  const streamed = f.filter((x) => x.seq !== undefined);
  const singles = f.filter((x) => x.single);
  const total = big.reduce((s, x) => s + x.bytes, 0);
  const max = big.reduce((s, x) => Math.max(s, x.bytes), 0);
  const MiB = (n) => (n / 1048576).toFixed(1);

  console.log(`\n--- ${TAG} ---`);
  console.log(`import ${(out.mark.importMs / 1000).toFixed(1)}s, build ${(out.mark.buildMs / 1000).toFixed(1)}s, wall ${wall}s`);
  console.log(`tree: ${out.nodes} nodes, ${out.parts} parts`);
  console.log(`frames: ${f.length} total, ${streamed.length} stream, ${singles.length} single, ${out.wire.status} status`);
  console.log(`bytes:  ${MiB(total)} MiB across frames >4KiB, largest ${MiB(max)} MiB (cap 128.0 MiB)`);
  if (streamed.length) {
    const head = streamed.find((x) => x.seq === 0);
    console.log(`head:   manifest ${head ? head.manifest : "?"} bodies; seqs ${streamed.map((x) => x.seq).join(",")}`);
  }
  console.log(`doc:    ${out.doc.bodies} bodies, ${out.doc.meshTris} tris, ${out.doc.meshVerts} verts, ${out.doc.edges} edges`);
  console.log(`scene:  ${out.scene.bodies} bodies, ${out.scene.tris} tris, ${out.scene.verts} verts`);
  console.log(`bbox:   ${JSON.stringify(out.doc.bbox)}`);
  const st = out.steps || [];
  const bodyChunks = st.filter((s) => s.phase === "bodies");
  console.log(`stream: ${st.length} installments (${bodyChunks.length} carrying bodies), aborts ${out.aborts}`);
  if (bodyChunks.length) {
    console.log(`drawn:  ${bodyChunks.map((s) => s.drawn).join(" -> ")}`);
    console.log(`first bodies on screen at +${bodyChunks[0].t}ms of the reply; last at +${bodyChunks[bodyChunks.length - 1].t}ms`);
  }

  fs.writeFileSync(`/tmp/chunked_${TAG}.json`, JSON.stringify(out, null, 1));
  console.log(`\nwrote /tmp/chunked_${TAG}.json`);
  await page.screenshot({ path: `/tmp/chunked_${TAG}.png` });
  await browser.close();
})();
