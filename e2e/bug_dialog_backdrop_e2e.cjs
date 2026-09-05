// Does stretching the bug report box throw the report away?
//
// Field report (0.1.193, Windows): "I resized the bug report window to be
// bigger... I let go of the mouse outside the dialog and it closed the dialog
// and I lost my report."
//
// The textarea is `resize: vertical`, so it has a native grip at its bottom
// right. The card is flex-centred, so growing the box by d moves the card's
// bottom edge down by only d/2 while the cursor moves down by d: past about
// 320 px of stretch the cursor has overtaken the card and the release lands on
// the backdrop. The DOM then dispatches `click` at the nearest common ancestor
// of the press and the release — the backdrop — and the old
// `if (e.target === backdrop) close()` took that for a click on the
// background, removed the card, and destroyed the typed text with it.
//
// This can only be seen in a real engine: the behaviour under test IS the
// browser's click retargeting, and the repo has no jsdom, so a unit test would
// have to fake the very thing that is broken and would only assert its own
// fake back at itself.
//
// Usage (from the repo root; NO sidecar and no token needed — the dialog is
// designed to work with the geometry engine dead):
//   npx vite --port 5173 &
//   SC_URL=http://localhost:5173 node e2e/bug_dialog_backdrop_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome).
const fs = require("fs");
const { chromium } = require("playwright-core");

const URL = process.env.SC_URL || "http://localhost:5173";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
  if (!ok) fails++;
};

const SENTINEL = "MY LONG REPORT THAT MUST NOT BE LOST";

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    // WebGL2 is mandatory: the Viewport constructor throws without it and the
    // page never builds any chrome, bug button included.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(`localStorage.setItem("sindri.welcomeOnStartup", "false");`);
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForSelector(".bug-report-btn", { timeout: 20000 });

  const open = () => page.$(".bug-report-card").then((el) => !!el);
  const text = () => page.$eval(".bug-desc", (el) => el.value).catch(() => null);
  const descBox = () => page.$eval(".bug-desc", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  async function openDialog() {
    await page.click(".bug-report-btn");
    await page.waitForSelector(".bug-report-card", { timeout: 10000 });
  }
  /** So that a failure earlier in the file leaves the later checks meaningful
   *  instead of throwing on a card that an unfixed close() already removed. */
  async function ensureOpen() {
    if (!(await open())) await openDialog();
  }
  /** Press the textarea's native resize grip and drag straight down by dy. */
  async function dragGrip(dy) {
    const b = await descBox();
    await page.mouse.move(b.x + b.w - 3, b.y + b.h - 3);
    await page.mouse.down();
    await page.mouse.move(b.x + b.w - 3, b.y + b.h - 3 + dy, { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  }

  // --- A: the reporter's gesture. Stretch the box far enough that the release
  //        lands on the backdrop. The dialog must survive with the text in it. ---
  await openDialog();
  await page.fill(".bug-desc", SENTINEL);
  const before = (await descBox()).h;
  await dragGrip(450);
  const stillOpen = await open();
  check(stillOpen, "A: a big grip stretch does not close the dialog");
  check((await text()) === SENTINEL, "A: the typed report survives the stretch", await text());
  const after = stillOpen ? (await descBox()).h : 0;
  check(after > before + 100, "A: the drag really resized the box", `${before} -> ${after}`);

  // --- B: the control. A genuine click on the background still closes. ---
  await ensureOpen();
  await page.mouse.click(20, 20);
  await page.waitForTimeout(100);
  check(!(await open()), "B: a real click on the background still closes the dialog");

  // --- C: whatever closed it, the draft comes back on reopen. Losing the text
  //        was the injury; the guard alone would still lose it to Escape. ---
  await openDialog();
  check((await text()) === SENTINEL, "C: reopening refills the unsent report", await text());

  // --- D: press on the backdrop, release inside the card. Also a click
  //        retargeted to the backdrop, and also not a click on the background. ---
  const card = await page.$eval(".bug-report-card", (el) => {
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  await page.mouse.move(20, 20);
  await page.mouse.down();
  await page.mouse.move(card.cx, card.cy, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  check(await open(), "D: a drag from the background into the card does not close it");

  // --- E: Escape still closes, and the draft still survives that too. ---
  await ensureOpen();
  await page.fill(".bug-desc", "SECOND DRAFT");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  check(!(await open()), "E: Escape still closes the dialog");
  await openDialog();
  check((await text()) === "SECOND DRAFT", "E: the newer draft is the one that comes back",
    await text());

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
