// The chamfer tool's two silences, in a real browser.
//
// Field report a0a76571 (0.1.193): "the chamfer appears to have the same size
// regardless of the value I enter ... the meshing never finishes ... even Undo
// does not work."
//
// Two of those are things the app failed to SAY, and neither is visible to a
// unit test:
//
//   1. OCCT refuses a chamfer it cannot build ("try a smaller length value(s)").
//      main.ts suppresses the feature-error toast for the whole time a tool
//      preview is live, so the model just sat there unchanged at every value the
//      user typed. The tool now puts the kernel's own sentence in its prompt.
//
//   2. Ctrl+Z did nothing while the tool was open. The tool focuses its
//      dimension box and re-asserts focus every frame; DimInput stopped every
//      keystroke from propagating and keymap.ts ignored anything aimed at an
//      input, so the WebView's text-undo ate it. An untouched box now lets
//      undo/redo through, and the app cancels the tool before undoing.
//
// Unit tests pin both rules with fakes (src/features/edgeFeatureToolPreview.test.ts,
// src/input/undoInDimBox.test.ts). This is the one that presses the key with a
// real focused input, a real sidecar refusal and a real undo stack — the layer
// where both defects actually lived.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<token> node e2e/chamfer_feedback_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const BASE = process.env.SC_BASE || "http://localhost:5173";
const OUT = "/tmp/chamfer_feedback_shots";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A 60x60x10 plate. Its top edges chamfer happily at 2 mm and are refused at
// 50 mm, which is the whole point: the same tool, the same gesture, one value
// the kernel takes and one it will not.
const DOC = {
  parameters: {},
  features: [
    {
      id: "f1", type: "sketch", plane: "XY",
      entities: [{ type: "rectangle", id: "e1", width: 60, height: 60, x: 0, y: 0 }],
    },
    { id: "f2", type: "extrude", sketch: "f1", distance: 10, operation: "new", hiddenBodies: [] },
  ],
};

(async () => {
  require("fs").mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const busy = () => page.evaluate(() => window.__sindri.busyWhy());
  const featureCount = () => page.evaluate(() => window.__sindri.store.document.features.length);
  const promptText = () => page.evaluate(() => document.getElementById("prompt")?.textContent ?? "");
  const settled = () => page.waitForFunction(
    () => !window.__sindri.store.buildState.building, null, { timeout: 120000 },
  ).catch(() => {});
  const esc = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(400); };

  /** Screen position of the midpoint of a TOP edge of the plate (z = 10). */
  const topEdgePoint = (skip) => page.evaluate((n) => {
    const s = window.__sindri;
    const tops = s.viewport.visibleEdgeLines().filter((l) => l.points.every((p) => p[2] > 9.9));
    const l = tops[n];
    if (!l) return null;
    const a = l.points[0], b = l.points[l.points.length - 1];
    const m = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2 };
    const p = s.viewport.projectToScreen(m);
    return { x: Math.round(p.x), y: Math.round(p.y), tops: tops.length };
  }, skip);

  const clickAt = async (p) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(600);
  };

  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  check("the app booted with no uncaught error", errors.length === 0, errors.slice(0, 2).join(" | "));
  await esc(); // the welcome modal is part of toolBusy()

  await page.evaluate((doc) => window.__sindri.store.loadDocument(doc), DOC);
  await page.waitForFunction(
    () => window.__sindri.viewport.visibleEdgeLines().length > 0, null, { timeout: 120000 },
  ).catch(() => {});
  const edge = await topEdgePoint(0);
  check("the plate built and its top edges are on screen", !!edge && edge.tops >= 4,
    edge ? `${edge.tops} top edge(s)` : "no edges");
  if (!edge) { await page.screenshot({ path: `${OUT}/setup-failed.png` }); await browser.close(); process.exit(1); }

  // --- 1. a size the kernel refuses says so ---------------------------------
  await page.evaluate(() => window.__sindri.handleAction("chamfer"));
  check("the chamfer tool armed", (await busy()).edgeFeature === true);
  await clickAt(edge);
  await settled();
  const armedPrompt = await promptText();
  check("picking an edge opens the drag phase", /Drag the arrow/.test(armedPrompt), armedPrompt.slice(0, 60));

  // Type a distance five times the plate's thickness. The box is already
  // focused — the tool put the caret there — so this is exactly the keystrokes
  // the reporter described.
  await page.keyboard.type("50");
  await page.waitForTimeout(600);
  await settled();
  await page.waitForTimeout(600);
  const refused = await promptText();
  check("the refused chamfer says why, in the kernel's own words",
    /smaller length|chamfer failed/i.test(refused), refused.slice(0, 120));
  await page.screenshot({ path: `${OUT}/01-refused.png` });

  // ...and a value it accepts takes the message back down.
  await page.keyboard.press("Control+a");
  await page.keyboard.type("2");
  await page.waitForTimeout(600);
  await settled();
  await page.waitForTimeout(600);
  const accepted = await promptText();
  check("a value that builds clears the warning",
    !/smaller length/i.test(accepted) && /Drag the arrow|edge/i.test(accepted), accepted.slice(0, 120));

  // Enter commits it: one more feature, and an undo step to reach for below.
  await page.keyboard.press("Enter");
  await settled();
  const committed = await featureCount();
  check("Enter committed the chamfer", committed === 3, `${committed} features`);
  check("the tool stood down", (await busy()).edgeFeature === false);

  // --- 2. Ctrl+Z reaches the app while the tool is open ---------------------
  const edge2 = await topEdgePoint(1);
  await page.evaluate(() => window.__sindri.handleAction("chamfer"));
  await clickAt(edge2);
  await settled();
  const inTool = await busy();
  check("the chamfer tool is open again, caret in its dimension box",
    inTool.edgeFeature === true,
    JSON.stringify(inTool));
  const focused = await page.evaluate(() => document.activeElement?.closest(".dim-input") !== null);
  check("the dimension box really has focus (nothing below is meaningful otherwise)", focused);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600);
  await settled();
  const afterUndo = await featureCount();
  const afterBusy = await busy();
  check("Ctrl+Z undid the document instead of being swallowed by the input",
    afterUndo === 2, `${afterUndo} features (want 2)`);
  check("the open tool was cancelled first, not left previewing over the undo",
    afterBusy.edgeFeature === false, JSON.stringify(afterBusy));
  await page.screenshot({ path: `${OUT}/02-after-undo.png` });

  check("no uncaught error over the whole run", errors.length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall chamfer feedback checks passed");
  process.exit(failures ? 1 : 0);
})();
