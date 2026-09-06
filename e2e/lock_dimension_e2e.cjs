// Constraining a dimension, and who moves when you retype one — in a real
// browser, because the seam is the right-click menu and the solve it triggers.
//
// Two field reports, one design gap (a badge's border is the only signal of
// whether it drives anything):
//
//   dff87040  "Equal constraint... rectangle 50 x 100 mm, use '=' constraint on
//             2 sides and I get a square 86.899 mm... the problem is I don't
//             have any obvious way to constrain a dimension."
//             A rectangle's W/H badge could not be locked AT ALL, and rendered
//             with the solid accent border that means "this drives".
//
//   d8c5265e  "I then change the diameter of the circle... it changes the
//             dimensions of the box as well a bit. There is no obvious reason
//             for the box dimensions to change."
//             The value edit ran an UNBIASED solve, so planegcs split the
//             correction between the circle and the rectangle it sits in.
//
// The unit tests pin the pure decisions (directDims.planDimEdit) and the solver
// behaviour (real planegcs, with and without the mover bias). What only exists
// in a running app is the chain between them: a real contextmenu event on a real
// badge, the menu SketchMode renders from it, and the solve that a real value
// edit kicks off. Both halves are asserted against snapshotFeature() — the
// document the sketch would commit — not against the DOM's own numbers.
//
// Usage (from the repo root), with vite on 5173:
//   SC_TOKEN=<the sidecar token> node e2e/lock_dimension_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome);
// SC_PORT overrides the vite port.
const { chromium } = require("playwright-core");

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};
const near = (a, b, tol = 1e-6) => typeof a === "number" && Math.abs(a - b) <= tol;

// The reporter's own document (bug-reports/docs/d8c5265e.json), byte for byte:
// a circle held inside a free rectangle by two tangents, with a driving ⌀20.
const TANGENT_CIRCLE = {
  version: 5, parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [
      { x: -44.75031411997571, y: 24.922397843507845, id: "e7", type: "rectangle", width: 71.19921540795315, height: 43.80078459003447 },
      { x: -70.34992182395229, y: 36.82279013852507, id: "e8", type: "circle", radius: 10 },
    ],
    constraints: [
      { a: "e8", b: "e7~2", type: "tangent2" },
      { a: "e8", b: "e7~3", type: "tangent2" },
      { id: "c9", type: "diameter", value: 20, circle: "e8" },
    ],
  }],
};

// dff87040's shape before the Equal constraint flattened it: a plain rectangle
// with nothing holding either extent.
const PLAIN_RECT = {
  version: 5, parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [{ x: 0, y: 0, id: "e0", type: "rectangle", width: 100, height: 50 }],
  }],
};

// The same rectangle as the DIMENSION TOOL leaves it. Picking a rectangle's
// edge resolves to a p2pDistance between that edge's two corners — both
// operands the rectangle itself — which is the shape dff87040's own document
// carries. Reference Dim OFF, so it drives: the width really is held at 100,
// and a badge that calls it a free measurement is lying in the other direction.
const TOOL_DIMMED_RECT = {
  version: 5, parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [{ x: 0, y: 0, id: "e0", type: "rectangle", width: 100, height: 50 }],
    constraints: [
      { id: "c1", type: "p2pDistance", e1: "e0", p1: 0, e2: "e0", p2: 1, value: 100, place: { ox: 0, oy: -25 } },
    ],
  }],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const port = process.env.SC_PORT || "5173";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  const token = process.env.SC_TOKEN ? `?token=${process.env.SC_TOKEN}` : "";
  await page.goto(`http://localhost:${port}/${token}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal
  await page.waitForTimeout(400);

  /** load a document and open its one sketch, framed so the badges are drawn
   *  (a badge whose anchor is outside the view is hidden, and unclickable) */
  const openSketch = async (doc, badgeCount) => {
    await page.evaluate((d) => {
      const s = window.__sindri;
      if (s.sketch.active) s.sketch.finish(false);
      s.store.loadDocument(d);
    }, doc);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
    await page.waitForFunction((n) => document.querySelectorAll(".sketch-dim").length >= n,
      badgeCount, { timeout: 20000 });
    await page.evaluate(() => window.__sindri.viewport.fitView());
    await page.waitForTimeout(900); // rig.fit() transitions
    // fitView frames the GEOMETRY tightly, and a badge sits outside the shape
    // it labels (a height badge to the left of the rectangle, a diameter badge
    // above the circle), so after the fit those anchors can land just past the
    // viewport edge and be culled. Zoom out a notch at a time over bare canvas
    // until every badge is drawn. A wheel over a badge or the palette never
    // reaches the viewport, hence the elementFromPoint check.
    const allDrawn = (n) => page.evaluate((m) => {
      const dims = [...document.querySelectorAll(".sketch-dim")];
      return dims.length >= m && dims.every((el) => getComputedStyle(el).visibility !== "hidden");
    }, n);
    for (let i = 0; i < 8 && !(await allDrawn(badgeCount)); i++) {
      const spot = await page.evaluate(() => {
        const vp = document.getElementById("viewport").getBoundingClientRect();
        const canvas = document.querySelector("#viewport canvas");
        for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.6], [0.6, 0.4], [0.35, 0.35], [0.65, 0.65]]) {
          const x = vp.left + vp.width * fx, y = vp.top + vp.height * fy;
          if (document.elementFromPoint(x, y) === canvas) return { x, y };
        }
        return { x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 };
      });
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(350);
    }
    await page.waitForFunction((n) => {
      const dims = [...document.querySelectorAll(".sketch-dim")];
      return dims.length >= n && dims.every((el) => getComputedStyle(el).visibility !== "hidden");
    }, badgeCount, { timeout: 5000 });
    await page.waitForTimeout(300);
  };

  /** the badge whose text starts with `t`: where it is, how it is drawn, and
   *  whether its centre is over the CANVAS — fitView frames the geometry, but a
   *  badge offset outward can still land over a side panel, where a click at
   *  that point would go to the panel instead.
   *
   *  `nth` picks among badges reading the same number, which is normal once a
   *  dimension holds an extent: the entity's own badge and the placed
   *  dimension's badge both show it. Entity badges are rendered first
   *  (SketchDimensions.show does entities, then the constraint extras). */
  const badge = (t, nth = 0) => page.evaluate(([text, i]) => {
    const el = [...document.querySelectorAll(".sketch-dim")].filter((x) => x.textContent.startsWith(text))[i];
    if (!el || getComputedStyle(el).visibility === "hidden") return null;
    const b = el.getBoundingClientRect();
    const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
    const vp = document.getElementById("viewport").getBoundingClientRect();
    return {
      x, y, className: el.className, borderStyle: getComputedStyle(el).borderStyle,
      inView: x >= vp.left && x <= vp.right && y >= vp.top && y <= vp.bottom,
    };
  }, [t, nth]);

  /** every rendered dim badge, as text + how it is drawn */
  const allBadges = () => page.evaluate(() => [...document.querySelectorAll(".sketch-dim")].map((el) => ({
    text: el.textContent,
    measured: el.className.includes("sketch-dim-measured"),
    borderStyle: getComputedStyle(el).borderStyle,
  })));

  /** the sketch as it would be committed */
  const snapshot = () => page.evaluate(() => window.__sindri.sketch.snapshotFeature());
  const entityOf = (snap, id) => (snap.entities || []).find((e) => e.id === id) || {};

  /** the open context menu's items, in order */
  const menuItems = () => page.evaluate(() =>
    [...document.querySelectorAll(".context-menu .ctx-item")].map((el) => ({
      label: el.querySelector(".ctx-label")?.textContent ?? "",
      disabled: el.classList.contains("disabled"),
    })));
  const clickMenuItem = (label) => page.evaluate((t) => {
    const el = [...document.querySelectorAll(".context-menu .ctx-item")]
      .find((x) => x.querySelector(".ctx-label")?.textContent === t);
    if (!el || el.classList.contains("disabled")) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, label);

  // ===== d8c5265e: retyping a diameter must not resize the box =============
  console.log("\n=== a diameter edit moves the circle, not the rectangle it sits in ===");
  await openSketch(TANGENT_CIRCLE, 3);
  const before = await snapshot();
  const boxBefore = entityOf(before, "e7");
  const dia = await badge("20");
  check(!!dia && dia.inView, "the circle's ⌀ badge is on screen", JSON.stringify(dia));
  if (dia && dia.inView) {
    await page.mouse.move(dia.x, dia.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll(".sketch-dim input").length === 1,
      null, { timeout: 3000 }).catch(() => {});
    const open = await page.evaluate(() => document.querySelectorAll(".sketch-dim input").length);
    check(open === 1, "clicking it opens the value editor", `inputs=${open}`);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("30");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200); // the solve is async (pump + wasm)
    const after = await snapshot();
    const boxAfter = entityOf(after, "e7");
    const circle = entityOf(after, "e8");
    check(near(circle.radius, 15, 1e-6), "the circle grew to the typed ⌀30", `r=${circle.radius}`);
    check(near(boxAfter.width, boxBefore.width) && near(boxAfter.height, boxBefore.height),
      "the rectangle's size did NOT change", `${boxAfter.width} x ${boxAfter.height}`);
    check(near(boxAfter.x, boxBefore.x) && near(boxAfter.y, boxBefore.y),
      "the rectangle did not move either", `${boxAfter.x}, ${boxAfter.y}`);
  }

  // ===== dff87040: locking a rectangle's width from the badge menu =========
  console.log("\n=== a rectangle's width badge can be locked, and says so ===");
  await openSketch(PLAIN_RECT, 2);
  const w = await badge("100");
  check(!!w && w.inView, "the width badge is on screen", JSON.stringify(w));
  if (w && w.inView) {
    check(w.className.includes("sketch-dim-measured"),
      "it reads as a MEASUREMENT, not as a driving dimension", w.className);
    check(w.borderStyle === "dotted", "and is drawn with the measured (dotted) border", w.borderStyle);

    await page.mouse.click(w.x, w.y, { button: "right" });
    await page.waitForSelector(".context-menu", { timeout: 3000 });
    const items = await menuItems();
    check(JSON.stringify(items.map((i) => i.label)) ===
      JSON.stringify(["Lock dimension", "Unlock (reference)", "Delete dimension"]),
      "the badge menu offers Lock / Unlock / Delete", JSON.stringify(items));
    check(items[0] && !items[0].disabled, "Lock is enabled on a measured badge");
    check(!!(items[2] && items[2].disabled), "Delete is disabled — there is nothing to delete yet");

    const clicked = await clickMenuItem("Lock dimension");
    check(clicked, "Lock dimension is clickable");
    await page.waitForTimeout(900);

    const snap = await snapshot();
    const locks = (snap.constraints || []).filter((c) => c.type === "distance");
    check(locks.length === 1 && locks[0].line === "e0~0" && near(locks[0].value, 100, 1e-9),
      "it created the driving dimension that holds the width", JSON.stringify(locks));
    check(near(entityOf(snap, "e0").width, 100, 1e-9) && near(entityOf(snap, "e0").height, 50, 1e-9),
      "and nothing moved — a lock freezes what the badge already read",
      `${entityOf(snap, "e0").width} x ${entityOf(snap, "e0").height}`);

    const w2 = await badge("100");
    check(!!w2 && !w2.className.includes("sketch-dim-measured"),
      "the badge now reads as a driving dimension", w2 && w2.className);
    check(!!w2 && w2.borderStyle === "solid", "with the solid (driving) border", w2 && w2.borderStyle);

    await page.mouse.click(w2.x, w2.y, { button: "right" });
    await page.waitForSelector(".context-menu", { timeout: 3000 });
    const items2 = await menuItems();
    check(!!(items2[0] && items2[0].disabled), "Lock is now disabled — it is already locked");
    check(!!(items2[2] && !items2[2].disabled), "Delete is now enabled — that is how it unlocks");
    await page.keyboard.press("Escape"); // close the menu

    // The height is a separate dimension and must be untouched by locking the
    // width: half-locking a rectangle is a normal state, and claiming otherwise
    // is the same lie in the other direction.
    const h = await badge("50");
    check(!!h && h.className.includes("sketch-dim-measured"),
      "the height badge is still a measurement", h && h.className);
  }

  // ===== dff87040: the dimension the TOOL creates, not the one Lock does ===
  // A rectangle dimensioned the normal way is held by a corner-to-corner
  // p2pDistance, not by the rect-edge `distance` Lock writes. Reading only the
  // latter made the W badge claim nothing held it, offered a Lock that
  // over-constrains the sketch, and turned a typed value into a direct width
  // write the next solve undid.
  console.log("\n=== a rectangle the tool dimensioned reads as DRIVING ===");
  await openSketch(TOOL_DIMMED_RECT, 3);
  const drawn = await allBadges();
  const hundreds = drawn.filter((b) => b.text.startsWith("100"));
  check(hundreds.length === 2, "both badges for the held width are drawn", JSON.stringify(drawn));
  check(hundreds.every((b) => !b.measured && b.borderStyle === "solid"),
    "neither of them calls the width a free measurement", JSON.stringify(hundreds));
  check(drawn.some((b) => b.text.startsWith("50") && b.measured),
    "and the undimensioned height still reads as a measurement", JSON.stringify(drawn));

  const wt = await badge("100", 0); // the entity's own W badge, rendered first
  check(!!wt && wt.inView, "the width badge is on screen", JSON.stringify(wt));
  if (wt && wt.inView) {
    await page.mouse.click(wt.x, wt.y, { button: "right" });
    await page.waitForSelector(".context-menu", { timeout: 3000 });
    const items = await menuItems();
    check(!!(items[0] && items[0].disabled),
      "Lock is disabled — locking on top of it would over-constrain the sketch", JSON.stringify(items));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await page.mouse.move(wt.x, wt.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll(".sketch-dim input").length === 1,
      null, { timeout: 3000 }).catch(() => {});
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("60");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200); // the solve is async (pump + wasm)
    // Provoke one more solve. The silent undo is not what the edit does, it is
    // what the NEXT solve does: a direct width write leaves the constraint
    // saying 100, and the moment anything re-solves, 100 is what wins.
    await page.evaluate(() => window.__sindri.sketch.requestSolve());
    await page.waitForTimeout(1200);
    const snap = await snapshot();
    check(near(entityOf(snap, "e0").width, 60, 1e-4),
      "typing 60 survives the next solve — the constraint was retyped, not written around",
      `${entityOf(snap, "e0").width} x ${entityOf(snap, "e0").height}`);
    check(near(entityOf(snap, "e0").height, 50, 1e-4),
      "and the height it did not dimension stayed put", `${entityOf(snap, "e0").height}`);
    const dim = (snap.constraints || []).find((c) => c.type === "p2pDistance");
    check(!!dim && near(dim.value, 60, 1e-9),
      "the dimension itself now reads 60", JSON.stringify(dim));
  }

  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
