// End-to-end check of the imported-assembly Browser tree, in a real browser.
//
// Everything else about Phase C is unit tests, sidecar tests and row COUNTS.
// This is the one that actually looks at the panel: real sidecar import of
// asm_nested.step, real store, real BrowserTree, real DOM — then screenshots
// it, expands it, toggles a subassembly's eye, and round-trips the document
// through save/load to prove the tree survives.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<token> node e2e/assembly_tree_e2e.cjs
const { chromium } = require("playwright-core");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const FIXTURE = path.resolve(__dirname, "../sidecar/fixtures/asm_nested.step");
const OUT = "/tmp/assembly_tree_shots";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  require("fs").mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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
  await page.waitForFunction(() => !!window.store && !!window.tree && !!window.geometry, null, { timeout: 60000 });

  // --- import exactly the way src/io/files.ts does -------------------------
  const imported = await page.evaluate(async (file) => {
    const res = await window.geometry.importGeometry(file, "step");
    if (!res.ok) return { ok: false, message: res.message };
    window.store.addFeature({
      id: window.store.nextId(), type: "import", format: "step",
      name: res.name, brep: res.brep, source: file, solid: res.solid,
      ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
      ...(res.parts !== undefined ? { parts: res.parts } : {}),
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!window.store.buildState.building && window.store.buildState.result) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: true, nodes: res.nodes?.length ?? 0, parts: res.parts?.length ?? 0,
             bodies: (window.store.buildState.result?.bodies ?? []).map((b) => [b.name, b.nodeRef]) };
  }, FIXTURE);
  if (!imported.ok) { console.error("import failed:", imported.message); process.exit(1); }
  console.log(`\nimported: ${imported.nodes} nodes, ${imported.parts} parts, ${imported.bodies.length} bodies`);
  console.log("bodies:", JSON.stringify(imported.bodies));

  const panel = () => page.evaluate(() =>
    [...document.querySelectorAll("#browser .tree-folder, #browser .feature-row")].map((el) => ({
      kind: el.className.includes("tree-folder") ? "folder" : "row",
      text: el.querySelector(".tree-label")?.textContent ?? el.textContent?.trim() ?? "",
      indent: parseInt(getComputedStyle(el).paddingLeft) || 0,
      caret: el.querySelector(".tree-caret")?.textContent ?? "",
    })));

  // --- 1. collapsed by default ---------------------------------------------
  await page.screenshot({ path: `${OUT}/1-collapsed.png` });
  let rows = await panel();
  const robot = rows.find((r) => r.text === "Robot");
  check("the assembly root appears in the Browser", !!robot, robot && `caret ${robot.caret}`);
  check("assembly nodes start COLLAPSED", !!robot && robot.caret === "▸");
  check("no part rows are painted while collapsed",
    !rows.some((r) => r.kind === "row" && ["MCU", "Chassis"].includes(r.text)),
    `${rows.filter((r) => r.kind === "row").length} rows total`);

  // --- 2. expand the whole chain -------------------------------------------
  // click through the DOM, re-querying each time: the panel rebuilds its
  // innerHTML on every toggle, so a held ElementHandle detaches immediately.
  for (const label of ["Robot", "Electronics", "Board"]) {
    for (let i = 0; i < 4; i++) {
      const clicked = await page.evaluate((want) => {
        for (const el of document.querySelectorAll("#browser .tree-folder")) {
          if (el.querySelector(".tree-label")?.textContent === want &&
              el.querySelector(".tree-caret")?.textContent === "\u25b8") { el.click(); return true; }
        }
        return false;
      }, label);
      if (!clicked) break;
      await page.waitForTimeout(150);
    }
  }
  await page.screenshot({ path: `${OUT}/2-expanded.png` });
  rows = await panel();
  console.log("\nexpanded panel:");
  for (const r of rows) console.log(`   ${" ".repeat(Math.max(0, (r.indent - 8) / 2))}${r.kind === "folder" ? "▸" : "·"} ${r.text}  (indent ${r.indent})`);

  check("the file's own names are shown verbatim",
    rows.some((r) => r.text === "Header (x2)"), "looking for 'Header (x2)'");
  check("both occurrences of the twice-instanced subassembly are present",
    rows.filter((r) => r.text === "Board").length === 2,
    `${rows.filter((r) => r.text === "Board").length} 'Board' nodes`);
  const depths = rows.filter((r) => ["Robot", "Electronics", "Board"].includes(r.text)).map((r) => r.indent);
  check("nesting is visibly indented by depth", new Set(depths).size >= 3, `indents ${depths}`);
  check("a single-solid product renders as a ROW, not a folder wrapping one entry",
    rows.some((r) => r.kind === "row" && r.text === "Chassis"));

  // --- 3. the eye on a subassembly hides everything inside it ---------------
  const before = await page.evaluate(() =>
    (window.store.buildState.result?.bodies ?? []).filter((b) => window.store.isBodyVisible(b.id)).length);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("#browser .tree-folder")) {
      if (el.querySelector(".tree-label")?.textContent === "Electronics") el.querySelector(".tree-eye")?.click();
    }
  });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() =>
    (window.store.buildState.result?.bodies ?? []).filter((b) => window.store.isBodyVisible(b.id)).length);
  await page.screenshot({ path: `${OUT}/3-subassembly-hidden.png` });
  check("the eye on a subassembly hides every body under it", before - after === 6,
    `visible ${before} -> ${after} (expected 6 hidden)`);

  // --- 4. save + reload keeps the tree --------------------------------------
  const round = await page.evaluate(async () => {
    const doc = JSON.parse(JSON.stringify(window.store.document));
    window.store.loadDocument({ version: 1, parameters: {}, features: [] });
    await new Promise((r) => setTimeout(r, 500));
    window.store.loadDocument(doc);
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!window.store.buildState.building && window.store.buildState.result) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return (window.store.buildState.result?.bodies ?? []).map((b) => [b.name, b.nodeRef]);
  });
  await page.screenshot({ path: `${OUT}/4-after-reload.png` });
  check("the tree survives a save/reload round trip",
    JSON.stringify(round) === JSON.stringify(imported.bodies),
    `${round.length} bodies back`);

  // --- 5. a product name containing markup renders as TEXT ------------------
  const escaped = await page.evaluate(async () => {
    const doc = JSON.parse(JSON.stringify(window.store.document));
    const f = doc.features.find((x) => x.type === "import");
    f.nodes[0].name = "<img src=x onerror=alert(1)>";
    window.store.loadDocument(doc);
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!window.store.buildState.building && window.store.buildState.result) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const labels = [...document.querySelectorAll("#browser .tree-label")].map((e) => e.textContent);
    return { injected: document.querySelectorAll("#browser img").length, labels,
             folders: [...document.querySelectorAll("#browser .tree-folder .tree-label")].map((e) => e.textContent) };
  });
  console.log("\nfolder labels after injection attempt:", JSON.stringify(escaped.folders));
  check("markup in a product name creates no elements",
    escaped.injected === 0, `${escaped.injected} <img> elements in the panel`);
  check("markup in a product name is shown as literal text",
    escaped.folders.some((l) => l && l.includes("<img")),
    `labels: ${JSON.stringify(escaped.folders)}`);

  console.log(`\nscreenshots in ${OUT}`);
  console.log(failures ? `FAILED (${failures})` : "all end-to-end checks passed");
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
