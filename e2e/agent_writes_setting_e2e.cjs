// "Let AI agents edit documents" (AI-control plan, decision 1): a Settings
// toggle, OFF until the user turns it on, kept by the Rust side (agent_ipc.rs
// reads it for every agent request), so the dialog only asks and tells.
//
// Boots the REAL app bundle with a fake Tauri IPC floor installed before any
// app script runs (as unsaved_changes_guard_e2e.cjs does). The floor keeps the
// setting the way Rust does: `agent_writes_get` answers it, `agent_writes_set`
// stores it. The menu, the dialog and the checkbox are the real ones.
//
// What it proves: off by default, the click reaches Rust as {on: true}, the
// dialog shows what Rust holds when it is opened again, a failed save does not
// leave the box saying something Rust did not store, and in a plain browser
// (no shell, so no agents) the row is not offered at all.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/agent_writes_setting_e2e.cjs
// SC_CHROME overrides the browser binary, SC_URL the dev server.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, "../locales/en.json"), "utf8"));

let fails = 0;
const check = (label, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

/** Runs in the page before any app script: the fake shell. */
function installFloor({ token }) {
  const floor = { log: [], writes: false, failSet: false, callbacks: new Map(), nextId: 1 };
  window.__floor = floor;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) { const id = floor.nextId++; floor.callbacks.set(id, cb); return id; },
    unregisterCallback(id) { floor.callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      floor.log.push({ cmd, args });
      switch (cmd) {
        case "sidecar_token": return token;
        case "plugin:event|listen": return floor.nextId++;
        case "agent_writes_get": return floor.writes;
        case "agent_writes_set":
          if (floor.failSet) throw new Error("disk full");
          floor.writes = args.on;
          return null;
        case "recovery_list": return [];
        case "ta_ping": return false;
        default: return null; // everything else the shell does is not under test here
      }
    },
  };
}

async function boot(browser, shell) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  if (shell) await page.addInitScript(installFloor, { token: TOKEN });
  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // the startup welcome
  await page.waitForTimeout(400);
  return page;
}

async function openSettings(page) {
  const edit = await page.$(`#menubar .menu-btn >> text="${EN.menu.edit.title}"`);
  await edit.click();
  await page.click(`.menu-popup:not(.hidden) .menu-item >> text="${EN.settings.menuItem}"`);
  await page.waitForSelector(".settings-card");
  // the toggle is filled in from Rust after the dialog opens
  await page.waitForFunction(() => {
    const box = document.querySelector(".settings-agent-writes");
    return !box || !box.disabled;
  });
}

const closeSettings = (page) => page.click(".settings-close");
const box = (page) => page.$(".settings-agent-writes");
const isChecked = (page) => page.$eval(".settings-agent-writes", (b) => b.checked);
const sets = (page) => page.evaluate(() => window.__floor.log.filter((l) => l.cmd === "agent_writes_set").map((l) => l.args));

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });

  {
    const page = await boot(browser, true);
    await openSettings(page);
    const label = await page.$eval(".settings-agent-row", (r) => r.textContent.trim()).catch(() => null);
    check("the row is offered, in the user's words", label === EN.settings.agent?.allowEdits, String(label));
    check("off until the user turns it on", (await box(page)) !== null && (await isChecked(page)) === false);
    const note = await page.$eval(".settings-agent-note", (n) => n.textContent.trim()).catch(() => null);
    check("says what agents can do with it off", note === EN.settings.agent?.note, String(note));

    await page.click(".settings-agent-writes");
    await page.waitForTimeout(200);
    check("the click reaches Rust as {on: true}", JSON.stringify(await sets(page)) === JSON.stringify([{ on: true }]),
      JSON.stringify(await sets(page)));
    await closeSettings(page);

    await openSettings(page);
    check("opened again, it shows what Rust holds", (await isChecked(page)) === true);

    // a save that fails leaves the box as Rust has it, and says so
    await page.evaluate(() => { window.__floor.failSet = true; });
    await page.click(".settings-agent-writes");
    await page.waitForTimeout(200);
    check("a failed save puts the box back", (await isChecked(page)) === true);
    check("Rust still holds on", await page.evaluate(() => window.__floor.writes) === true);
    const failed = await page.$eval(".settings-agent-note", (n) => n.textContent.trim());
    check("and the note says it did not change", failed === EN.settings.agent?.saveFailed, failed);
    await closeSettings(page);
    await page.close();
  }

  {
    const page = await boot(browser, false);
    await openSettings(page);
    check("a plain browser has no agents, so no row", (await box(page)) === null);
    await page.close();
  }

  await browser.close();
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
