// Section: the check keeps the cut and says so, and the box reads where the
// cut is, from the origin. In a real browser, because the half of this that
// decides what Esc does lives in main.ts's key handlers, where a unit test can
// only read the source.
//
// Two field reports from the same tester:
//   1a28cd21: "I create a section drag it to where I want it... click the
//     tick... nothing happens, I expected it to close the section"
//   983f5f56: "it placed the section in the middle of the solid and called the
//     offset 0... perhaps it should show the distance the section plane is from
//     the X or Y or Z plane - depending which is selected"
//
// What only a running app can check:
//   - the box reads 20 on a model whose middle is z = 20 (it used to read 0),
//     and a real drag of the arrow moves that number;
//   - the check puts the arrow away and keeps the cut, with its chip in the
//     viewport's top-left corner and the hint said once;
//   - Esc with a body selected clears the selection and keeps the cut, and the
//     next Esc removes it;
//   - Esc that closes ANOTHER tool, or a context menu, does not take the cut
//     too. The first version decided in the bubble phase and failed exactly
//     here: Measure had already closed on that Esc, so nothing looked busy and
//     the cut went with it.
//   - nor does Esc that closes Properties, Change Parameters, a menubar
//     dropdown, or the ViewCube's menu or face pick. None of those stops its
//     Esc, and the second version's decision did not ask about them.
//
// Controls, so a pass cannot be vacuous: the model's extent is checked before
// anything is asserted about the number, nothing may be busy at the start, and
// the context menu must really be open before its Esc is pressed.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/section_chip_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running against a side-port worktree.
const fs = require("fs");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== undefined ? `  ${JSON.stringify(extra)}` : ""}`);
  if (!ok) fails++;
};

// The box primitive is CENTRED, so a 40x40x10 box moved 20 up spans z 15..25:
// its middle, where a Z section opens, is z = 20.
const DOC = {
  version: 5, units: "mm", parameters: {},
  features: [
    { id: "b1", type: "box", length: 40, width: 40, height: 10 },
    { id: "m1", type: "move", dx: 0, dy: 0, dz: 20, rx: 0, ry: 0, rz: 0 },
  ],
};
const HINT = "The section stays on";

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    // WebGL2 is MANDATORY: the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(`localStorage.setItem("sindri.welcomeOnStartup", "false");`);
  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.waitForFunction(() => !window.__sindri.store.buildState.building, null, { timeout: 60000 });

  // Wait on the CONDITION, and count settled builds so the wait cannot return
  // on the build that had already finished.
  await page.evaluate(() => {
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
  });
  const settled = await page.evaluate(() => window.__settles);
  await page.evaluate((d) => window.__sindri.store.load(JSON.stringify(d)), DOC);
  await page.waitForFunction((b) => window.__settles > b && !window.__sindri.store.buildState.building, settled, { timeout: 120000 });
  await page.waitForTimeout(300);

  const box = await page.evaluate(() => {
    const b = window.__sindri.viewport.modelBox();
    return b && [b.min.z, b.max.z].map((v) => Math.round(v * 1000) / 1000);
  });
  check(JSON.stringify(box) === "[15,25]", "precondition: the model spans z 15..25", box);
  const idle = () => page.evaluate(() => Object.values(window.__sindri.busyWhy()).every((v) => !v));
  check(await idle(), "precondition: nothing is busy (no welcome modal, no tool)");

  const cut = () => page.evaluate(() => {
    const p = window.__sindri.viewport.clipPlane;
    return p ? { n: p.normal.toArray().map((v) => Math.round(v * 1e6) / 1e6 + 0), at: Math.round(-p.constant * 1e6) / 1e6 + 0 } : null;
  });
  const chip = () => page.evaluate(() => {
    const c = document.querySelector(".section-chip");
    if (!c || getComputedStyle(c).display === "none") return null;
    const r = c.getBoundingClientRect();
    const vp = document.getElementById("viewport").getBoundingClientRect();
    return { text: c.querySelector(".section-chip-label").textContent, left: Math.round(r.left - vp.left), top: Math.round(r.top - vp.top) };
  });
  // every tool owns a box; the one on screen is the section's
  const field = () => page.evaluate(() => {
    const root = [...document.querySelectorAll(".dim-input")].find((r) => getComputedStyle(r).display !== "none");
    const i = root?.querySelector("input");
    return i ? { value: i.value, label: i.parentElement.firstChild.textContent.trim() } : null;
  });
  const hints = () => page.evaluate((h) => [...document.querySelectorAll(".toast-msg")].filter((e) => e.textContent.startsWith(h)).length, HINT);
  const sectionUp = () => page.evaluate(() => window.__sindri.busyWhy().section);
  const centreOf = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, sel);
  const click = async (sel) => {
    const at = await centreOf(sel);
    if (!at) throw new Error(`nothing on screen at ${sel}`);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
  };
  const esc = async () => {
    await page.mouse.move(700, 880); // off every field
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  };
  /** Inspect > Section, then the axis button in the chooser, by mouse. */
  const openSection = async (axis) => {
    await page.evaluate(() => window.__sindri.handleAction("section"));
    await page.waitForTimeout(300);
    const at = await page.evaluate((a) => {
      // a chooser button's text is its label AND its hint ("Zhorizontal cut")
      const b = [...document.querySelectorAll(".modal-overlay button, .choice-backdrop button")]
        .find((x) => (x.textContent || "").startsWith(a));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, axis);
    if (!at) throw new Error(`no ${axis} button in the axis chooser`);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(400);
  };

  // --- 983f5f56: the box reads where the cut is ---------------------------------
  await openSection("Z");
  const f0 = await field();
  check(f0?.value === "20" && f0?.label === "Z mm", "a Z section through the middle reads 20 (it read 0), labelled Z", f0);
  check((await cut())?.at === 20, "and the cut is at z = 20", await cut());

  // a real drag of the arrow, up the screen
  const arrow = await page.evaluate(() => {
    const vp = window.__sindri.viewport;
    const c = vp.modelBox().getCenter(vp.modelBox().min.clone());
    const p = vp.projectToScreen(c.clone().setZ(c.z + 25 * vp.pixelWorldSize(c)));
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(arrow.x, arrow.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(arrow.x, arrow.y - i * 4);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const f1 = await field();
  const dragged = Number(f1?.value);
  check(dragged > 20 && Number.isInteger(dragged * 10), "dragging the arrow up moves the number up from 20, in round steps", f1);
  check((await cut())?.at === dragged, "and the cut is where the box says", await cut());

  // --- 1a28cd21: the check keeps the cut, and says how to remove it -------------
  await click(".dim-input .dim-ok");
  check(!(await sectionUp()), "the check puts the arrow away");
  check((await cut())?.at === dragged, "and keeps the cut", await cut());
  const c1 = await chip();
  check(c1?.text === `Section Z ${dragged} mm`, "a chip names the kept cut", c1);
  check(!!c1 && c1.left < 40 && c1.top < 40, "in the viewport's top-left corner", c1);
  check((await hints()) === 1, "the hint says the cut stays until removed", await hints());

  await click(".section-chip .section-chip-remove");
  check((await cut()) === null && (await chip()) === null, "the chip's cross removes the cut and the chip");

  // reopen (Enter on the chooser puts it back), type a position, Enter keeps it
  await page.evaluate(() => window.__sindri.handleAction("section"));
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check((await field())?.value === String(dragged), "reopening puts the cut back where it was", await field());
  await page.keyboard.press("Control+a");
  await page.keyboard.type("17.5");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check(!(await sectionUp()) && (await cut())?.at === 17.5, "typing 17.5 and Enter keeps the cut at z = 17.5", await cut());
  check((await chip())?.text === "Section Z 17.5 mm", "the chip follows", await chip());
  check((await hints()) <= 1, "the hint is not said a second time", await hints());

  // --- what Esc does to a kept cut ----------------------------------------------
  const bodyId = await page.evaluate(() => window.__sindri.store.buildState.result.bodies[0].id);
  await page.evaluate((id) => window.__sindri.viewport.setSelectedBodies([id]), bodyId);
  await esc();
  check((await page.evaluate(() => window.__sindri.viewport.getSelectedBodies().length)) === 0, "Esc with a body selected clears the selection");
  check((await chip()) !== null, "and keeps the cut");

  // a context menu's Esc is the menu's
  const onBody = await page.evaluate(() => {
    const vp = window.__sindri.viewport;
    const p = vp.projectToScreen(vp.modelBox().getCenter(vp.modelBox().min.clone()).setZ(25));
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(onBody.x, onBody.y, { button: "right" });
  await page.waitForTimeout(300);
  const menuOpen = await page.evaluate(() => !!document.querySelector(".context-menu"));
  check(menuOpen, "precondition: a right-click on the body opened its menu");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(!(await page.evaluate(() => !!document.querySelector(".context-menu"))), "Esc closes the menu");
  check((await chip()) !== null, "and keeps the cut");
  // the right-click may have picked something; clear that first, as Esc would
  await page.evaluate(() => window.__sindri.viewport.clearSelection());

  // A panel, a menubar dropdown or the ViewCube's menu: that Esc is theirs.
  // None of them stops the key and nothing is selected, so only the decision in
  // main.ts can tell; before it asked, each of these took the cut with it.
  const shown = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
  // Each case starts from a kept cut, so one that loses it cannot make the next
  // fail too, and a control run names every case that fails on its own.
  const keepAgain = async () => {
    if ((await chip()) !== null) return;
    console.log("      (putting the cut back for the next case)");
    await page.evaluate(() => window.__sindri.handleAction("section"));
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter"); // the chooser offers the last axis first
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter"); // and Enter keeps the cut
    await page.waitForTimeout(300);
  };
  for (const [action, sel, name] of [
    ["properties", ".measure-panel", "Inspect > Properties"],
    ["change-parameters", ".params-dialog", "Change Parameters"],
  ]) {
    await keepAgain();
    await page.evaluate((a) => window.__sindri.handleAction(a), action);
    await page.waitForTimeout(300);
    check(await shown(sel), `precondition: ${name} is open`);
    await esc();
    check(!(await shown(sel)), `Esc closes ${name}`);
    check((await chip()) !== null, "and keeps the cut");
  }
  await keepAgain();
  await click(".menubar .menu-btn");
  check(await shown(".menubar .menu-popup:not(.hidden)"), "precondition: the File menu is open");
  await esc();
  check(!(await shown(".menubar .menu-popup:not(.hidden)")), "Esc closes the File menu");
  check((await chip()) !== null, "and keeps the cut");
  // Right-click a cube face. Which pixel lands on a FACE rather than an edge or
  // corner nub depends on the camera, so sweep the corner box (as
  // menu_layout_e2e.cjs does).
  const cubeMenu = () => page.evaluate(() => {
    const c = document.getElementById("canvas");
    const r = c.getBoundingClientRect();
    const SIZE = 120, MARGIN = 14;
    const left = r.right - SIZE - MARGIN, top = r.top + MARGIN;
    for (let dy = 10; dy < SIZE; dy += 10) {
      for (let dx = 10; dx < SIZE; dx += 10) {
        c.dispatchEvent(new MouseEvent("contextmenu", { clientX: left + dx, clientY: top + dy, bubbles: true, cancelable: true }));
        if (document.querySelector(".viewcube-menu")) return true;
      }
    }
    return false;
  });
  await keepAgain();
  check(await cubeMenu(), "precondition: right-clicking a ViewCube face opened its menu");
  await page.waitForTimeout(100); // its Esc listener goes on after a tick
  await esc();
  check(!(await shown(".viewcube-menu")), "Esc closes the ViewCube's menu");
  check((await chip()) !== null, "and keeps the cut");
  // its first item waits for a model face to redefine that side; Esc cancels it
  await keepAgain();
  check(await cubeMenu(), "precondition: the ViewCube's menu opened again");
  await click(".viewcube-menu .menu-item");
  check(await page.evaluate(() => window.__sindri.viewport.cubeOwnsEscape), "precondition: the cube waits for a face");
  await esc();
  check(!(await page.evaluate(() => window.__sindri.viewport.cubeOwnsEscape)), "Esc cancels the face pick");
  check((await chip()) !== null, "and keeps the cut");

  await keepAgain();
  await esc();
  check((await cut()) === null && (await chip()) === null, "Esc with nothing else to let go of removes the cut");

  // another tool takes the arrow down; that tool's Esc is the tool's
  await openSection("X");
  check((await field())?.label === "X mm", "an X section's box is labelled X", await field());
  await page.evaluate(() => window.__sindri.handleAction("measure"));
  await page.waitForTimeout(300);
  check(!(await sectionUp()) && (await chip())?.text === "Section X 0 mm", "starting Measure keeps the cut and shows the chip", await chip());
  await esc();
  check(!(await page.evaluate(() => window.__sindri.busyWhy().measure)), "precondition: Esc closed Measure");
  check((await chip()) !== null, "Esc that closes Measure does not take the cut too");
  // Section again, with the cut kept, removes it through the tool
  await page.evaluate(() => window.__sindri.handleAction("section"));
  await page.waitForTimeout(300);
  check((await cut()) === null && (await chip()) === null, "Section again removes a kept cut, chip and all");
  check(await idle(), "nothing is left busy");

  await browser.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
