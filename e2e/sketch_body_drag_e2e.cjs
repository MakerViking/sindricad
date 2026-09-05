// The select tool's BODY drag, in a real browser: press an entity's body (not a
// vertex) and move it.
//
// Three field reports live on this one path, and every layer under it is
// unit-tested while the gesture is broken — which is why this file exists.
//
//  d0b008cb "Fix constraint does nothing": a circle pinned with Fix moved anyway
//           when grabbed by its RIM. The rim is a radius from the centre, so the
//           press never becomes a point drag (which the solver does refuse) — it
//           becomes a body drag, which consulted no solver at all.
//  c0bf7020 "Tangency is ignored while I drag a side": the fillet joints tore
//           open for the whole gesture and snapped back on release.
//  41dc3246 the same, plus: an arc's centre could not be grabbed.
//
// The mid-drag assertion is why this is done in a browser at all. Everything
// here is observable AFTER the button comes up in either version of the code,
// because release has always re-solved; only a live pointer, held down, can tell
// the two apart.
//
// One check goes the other way, and it exists because solving every frame is
// what made it possible: the release itself must still settle when it lands
// while a frame solve is in flight. That gesture is dispatched synchronously
// inside the page, since playwright's mouse helpers leave a round trip between
// the last move and the up and the solve lands in that gap.
//
// Every gesture asserts that it ARMED, and every press position is checked
// against the element actually under it. Both exist because the failure mode of
// a test like this is the vacuous pass: a press that lands on the inspector
// panel moves nothing, which reads exactly like a Fix constraint working.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/sketch_body_drag_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome);
// SC_URL overrides the app origin.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// A circle pinned with Fix, and a free one beside it as the control: a guard
// that refuses EVERY body drag would pass the first check and fail the second.
const FIXED = {
  version: 5, units: "mm", parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [
      { type: "circle", id: "c1", x: 0, y: 0, radius: 15 },
      { type: "circle", id: "c2", x: -45, y: 0, radius: 10 },
    ],
    constraints: [{ type: "fix", e: "c1", p: 0 }],
  }],
};

// c0bf7020's own sketch: a side (e6) running between two tangent fillet arcs.
const PROFILE = {
  version: 5, units: "mm", parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [
      { type: "line", id: "e6", x1: -3.8303737226431984, y1: 8.563539650569542, x2: -50.330365259060684, y2: -30.191163558102986 },
      { type: "arc", id: "e8", x1: -49.911645341684206, y1: 17.452782577292243, x2: -56.7252570063512, y2: 10.32972215474263, mx: -54.73369388148158, my: 15.24501235791418 },
      { type: "arc", id: "e9", x1: -8.144758491702225, y1: 19.589999139649123, x2: -3.8303737226431984, y2: 8.563539650569542, mx: -2.014227168001174, my: 15.6314400506009 },
      { type: "arc", id: "e10", x1: -56.97664756369172, y1: -27.05115250493374, x2: -50.330365259060684, y2: -30.191163558102986, mx: -54.65557855369911, my: -30.742186981620865 },
      { type: "line", id: "e12", x1: -49.911645341684206, y1: 17.452782577292243, x2: -8.144758491702225, y2: 19.589999139649123 },
      { type: "line", id: "e13", x1: -56.7252570063512, y1: 10.32972215474263, x2: -56.97664756369172, y2: -27.05115250493374 },
    ],
    constraints: [
      { type: "tangent2", a: "e12", b: "e8" },
      { type: "tangent2", a: "e12", b: "e9" },
      { type: "tangent2", a: "e9", b: "e6" },
      { type: "tangent2", a: "e6", b: "e10" },
      { type: "tangent2", a: "e10", b: "e13" },
      { type: "tangent2", a: "e13", b: "e8" },
    ],
  }],
};

/** The worst tangency error in degrees over the sketch's `tangent2` pairs,
 *  measured INSIDE the page against the live entity list. An IIFE string so it
 *  can be handed to page.evaluate whole. */
const WORST_TANGENCY = `(() => {
  const s = window.__sindri.sketch;
  const ents = s.entities, cons = s.constraints;
  const by = (id) => ents.find((e) => e.id === id);
  const centre = (a) => {
    const ax = a.x1, ay = a.y1, bx = a.x2, byy = a.y2, cx = a.mx, cy = a.my;
    const d = 2 * (ax * (byy - cy) + bx * (cy - ay) + cx * (ay - byy));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + byy * byy, c2 = cx * cx + cy * cy;
    return { x: (a2 * (byy - cy) + b2 * (cy - ay) + c2 * (ay - byy)) / d,
             y: (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d };
  };
  let worst = 0;
  for (const c of cons) {
    if (c.type !== "tangent2") continue;
    const A = by(c.a), B = by(c.b);
    if (!A || !B) continue;
    const ln = A.type === "line" ? A : B.type === "line" ? B : null;
    const ar = A.type === "arc" ? A : B.type === "arc" ? B : null;
    if (!ln || !ar) continue;
    const cc = centre(ar);
    if (!cc) continue;
    let best = null, bestD = Infinity;
    for (const p of [[ar.x1, ar.y1], [ar.x2, ar.y2]]) {
      for (const q of [[ln.x1, ln.y1], [ln.x2, ln.y2]]) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    const rx = best[0] - cc.x, ry = best[1] - cc.y, rl = Math.hypot(rx, ry) || 1;
    const tx = -ry / rl, ty = rx / rl;
    const dx = ln.x2 - ln.x1, dy = ln.y2 - ln.y1, dl = Math.hypot(dx, dy) || 1;
    const cos = Math.min(1, Math.abs(tx * (dx / dl) + ty * (dy / dl)));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
})()`;

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  // Reload on a miss rather than failing outright: a dev server sharing its
  // dependency cache with another checkout answers the first load with a 504
  // "Outdated Optimize Dep" while it re-optimises, and the module graph never
  // evaluates. Harmless on a clean machine, where the first attempt takes.
  let live = false;
  for (let i = 0; i < 4 && !live; i++) {
    await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    live = await page.waitForFunction(() => !!window.__sindri, null, { timeout: 20000 })
      .then(() => true, () => false);
  }
  if (!live) { console.error("the app never came up"); process.exit(1); }
  await page.keyboard.press("Escape"); // the welcome modal is part of toolBusy()
  await page.waitForTimeout(400);

  const openSketch = async (doc) => {
    await page.evaluate((d) => {
      const s = window.__sindri;
      if (s.sketch.active) s.sketch.finish(false);
      s.store.loadDocument(d);
    }, doc);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const s = window.__sindri;
      s.sketch.enter("XY", s.store, "f1");
      s.viewport.fitView?.();
    });
    await page.waitForTimeout(1000); // camera settle + the sketch's first solve
  };

  /** screen position of a sketch-plane point */
  const screenOf = (x, y) => page.evaluate(([px, py]) => {
    const s = window.__sindri;
    const p = s.viewport.projectToScreen(s.sketch.plane.to3D(px, py));
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }, [x, y]);

  const ent = (id) => page.evaluate(
    (i) => JSON.parse(JSON.stringify(window.__sindri.sketch.entities.find((e) => e.id === i) ?? null)),
    id,
  );

  /** Is this pixel actually the 3D canvas, or a panel floating over it? The
   *  inspector covers the right of the window; a press there is swallowed, and
   *  "nothing moved" is what a working Fix constraint looks like too. */
  const onCanvas = (p) => page.evaluate(
    (q) => (document.elementFromPoint(q.x, q.y) || {}).tagName === "CANVAS", p,
  );

  /** Press at `from`, walk to `to` in steps (a drag only ARMS past 4 px), run
   *  `mid` with the button still down, then release. Reports whether the press
   *  armed a gesture at all. */
  const drag = async (from, to, mid) => {
    const reachable = (await onCanvas(from)) && (await onCanvas(to));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const armed = await page.evaluate(() => {
      const s = window.__sindri.sketch;
      return { body: !!s.moveDrag, point: !!s.dragFrom };
    });
    const N = 6;
    for (let i = 1; i <= N; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / N, from.y + ((to.y - from.y) * i) / N);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(700); // let the in-flight frame solve land
    const out = mid ? await mid() : undefined;
    await page.mouse.up();
    await page.waitForTimeout(700);
    return { reachable, armed, out };
  };

  /** The same gesture, dispatched SYNCHRONOUSLY inside the page: no await
   *  anywhere between the last pointermove (which queues a frame solve) and the
   *  pointerup, so the release is guaranteed to land while that solve is still
   *  in flight. playwright's own mouse helpers cannot express this — each call
   *  is a round trip, and the solve settles in the gap. Returns whether the
   *  press armed, and whether a solve really was in flight at release (a false
   *  there makes the check below vacuous). */
  const syncDrag = (from, to) => page.evaluate(([a, b]) => {
    const s = window.__sindri, sk = s.sketch;
    const cv = s.viewport.domElement;
    const ev = (type, p, buttons) => cv.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: "mouse", bubbles: true, cancelable: true,
      clientX: p.x, clientY: p.y, buttons, button: 0,
    }));
    ev("pointerdown", a, 1);
    const armed = { body: !!sk.moveDrag, point: !!sk.dragFrom };
    for (let i = 1; i <= 6; i++)
      ev("pointermove", { x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 }, 1);
    const busyAtRelease = !!sk.solveBusy;
    ev("pointerup", b, 0);
    return { armed, busyAtRelease };
  }, [from, to]);

  // ===== d0b008cb: a Fix survives a rim grab =============================
  console.log("\n=== a Fix constraint holds against a body drag (d0b008cb) ===");
  await openSketch(FIXED);
  check(await page.evaluate(() => window.__sindri.sketch.active) === true, "the sketch opened for edit");

  // 45 degrees round the rim, so the press cannot land on an origin axis
  const R = 15 / Math.SQRT2;
  const pinned = await drag(await screenOf(R, R), await screenOf(R + 20, R + 12));
  check(pinned.reachable && pinned.armed.body, "the rim press armed a BODY drag on the pinned circle",
    JSON.stringify(pinned.armed));
  const c1 = await ent("c1");
  check(c1 && Math.hypot(c1.x, c1.y) < 0.01, "...and the fix-pinned circle did not move",
    `centre=(${c1 && c1.x.toFixed(4)}, ${c1 && c1.y.toFixed(4)})`);

  const r2 = 10 / Math.SQRT2;
  const free = await drag(await screenOf(-45 + r2, r2), await screenOf(-45 + r2 + 20, r2 + 12));
  check(free.reachable && free.armed.body, "the control press armed a body drag too", JSON.stringify(free.armed));
  const c2 = await ent("c2");
  check(c2 && Math.hypot(c2.x + 45, c2.y) > 5, "...and the UNpinned circle beside it still drags",
    `centre=(${c2 && c2.x.toFixed(3)}, ${c2 && c2.y.toFixed(3)})`);

  // Move/Rotate/Scale have the same hole and get the same answer: the WHOLE
  // gesture is refused. Both circles are selected and only one is pinned, so
  // "transform the rest and hold the pinned one" would move c2 — and a
  // partly-moved selection tears whatever the two shared.
  console.log("\n--- ...and Move refuses a selection containing a pinned entity ---");
  await openSketch(FIXED);
  const sel = await page.evaluate(([a, b]) => {
    const s = window.__sindri, sk = s.sketch, cv = s.viewport.domElement;
    const click = (p, shift) => {
      for (const type of ["pointerdown", "pointerup"])
        cv.dispatchEvent(new PointerEvent(type, {
          pointerId: 1, pointerType: "mouse", bubbles: true, cancelable: true,
          clientX: p.x, clientY: p.y, buttons: type === "pointerdown" ? 1 : 0, button: 0, shiftKey: !!shift,
        }));
    };
    click(a, false);
    click(b, true); // shift: add to the selection (playwright's own modifiers never reach pointerdown)
    return [...sk.selected];
  }, [await screenOf(R, R), await screenOf(-45 + r2, r2)]);
  check(sel.length === 2 && sel.includes("c1") && sel.includes("c2"),
    "both circles are selected, one of them pinned", JSON.stringify(sel));
  await page.evaluate(([a, b]) => {
    const s = window.__sindri, sk = s.sketch, cv = s.viewport.domElement;
    sk.setTool("move");
    for (const p of [a, b]) // Move takes two clicks: base point, then destination
      cv.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 1, pointerType: "mouse", bubbles: true, cancelable: true,
        clientX: p.x, clientY: p.y, buttons: 1, button: 0,
      }));
  }, [await screenOf(0, -30), await screenOf(30, -30)]);
  await page.waitForTimeout(800);
  const [m1, m2] = [await ent("c1"), await ent("c2")];
  check(m1 && Math.hypot(m1.x, m1.y) < 0.01, "Move left the pinned circle where it was",
    `centre=(${m1 && m1.x.toFixed(4)}, ${m1 && m1.y.toFixed(4)})`);
  check(m2 && Math.hypot(m2.x + 45, m2.y) < 0.01, "...and did not move the free one either",
    `centre=(${m2 && m2.x.toFixed(4)}, ${m2 && m2.y.toFixed(4)})`);
  await page.evaluate(() => window.__sindri.sketch.setTool("select"));

  // ===== c0bf7020: the joints hold DURING the drag ======================
  console.log("\n=== dragging a side keeps its fillets tangent, mid-gesture (c0bf7020) ===");
  await openSketch(PROFILE);
  const atRest = await page.evaluate(WORST_TANGENCY);
  check(atRest < 0.1, "the profile starts tangent", `worst=${atRest.toFixed(4)} deg`);

  const before = await ent("e6");
  const midX = (before.x1 + before.x2) / 2, midY = (before.y1 + before.y2) / 2;
  const side = await drag(
    await screenOf(midX, midY), await screenOf(midX + 4, midY + 4),
    () => page.evaluate(WORST_TANGENCY),
  );
  check(side.reachable && side.armed.body, "the mid-side press armed a body drag", JSON.stringify(side.armed));
  check(side.out < 1, "still tangent with the button STILL DOWN", `worst=${(side.out ?? NaN).toFixed(4)} deg`);

  const after = await ent("e6");
  const moved = Math.hypot(after.x1 - before.x1, after.y1 - before.y1);
  check(moved > 0.5, "...and the side actually followed the cursor", `moved=${moved.toFixed(3)} mm`);

  // ===== the release must settle even when it lands mid-solve ============
  // Solving every frame put a solve in flight for the whole gesture, which the
  // release then has to get past: endDrag's requestSolve only marks the sketch
  // dirty when one is running, so the in-flight frame's own completion is what
  // must carry the settle. Discarding that frame's result WITHOUT looping left
  // the settle queued and never run — the sketch stayed torn after the button
  // came up, which is the reported symptom moved past the release.
  console.log("\n=== releasing mid-solve still settles the sketch ===");
  await openSketch(PROFILE);
  const rested = await page.evaluate(WORST_TANGENCY);
  check(rested < 0.1, "the profile starts tangent again", `worst=${rested.toFixed(4)} deg`);

  const e6 = await ent("e6");
  const mx = (e6.x1 + e6.x2) / 2, my = (e6.y1 + e6.y2) / 2;
  const fromP = await screenOf(mx, my), toP = await screenOf(mx + 4, my + 4);
  const reachable = (await onCanvas(fromP)) && (await onCanvas(toP));
  check(reachable, "the press positions are on the canvas");
  const sync = await syncDrag(fromP, toP);
  check(sync.armed.body, "the synchronous gesture armed a body drag", JSON.stringify(sync.armed));
  check(sync.busyAtRelease, "...and a frame solve really was in flight at the release");
  await page.waitForTimeout(3000);
  const settled = await page.evaluate(WORST_TANGENCY);
  check(settled < 1, "tangent again 3 s AFTER the button came up", `worst=${settled.toFixed(4)} deg`);
  const pumpState = await page.evaluate(() => {
    const sk = window.__sindri.sketch;
    return { solveDirty: !!sk.solveDirty, solveBusy: !!sk.solveBusy };
  });
  check(!pumpState.solveDirty && !pumpState.solveBusy, "...with no solve left stuck in the pump",
    JSON.stringify(pumpState));

  // ===== 41dc3246: an arc's centre is grabbable =========================
  console.log("\n=== an arc's centre is a drag handle (41dc3246) ===");
  await openSketch(PROFILE); // from rest: a torn profile above would move the centre out from under the press
  const arc = await ent("e9");
  const cc = await page.evaluate((a) => {
    const d = 2 * (a.x1 * (a.y2 - a.my) + a.x2 * (a.my - a.y1) + a.mx * (a.y1 - a.y2));
    const s1 = a.x1 * a.x1 + a.y1 * a.y1, s2 = a.x2 * a.x2 + a.y2 * a.y2, s3 = a.mx * a.mx + a.my * a.my;
    return { x: (s1 * (a.y2 - a.my) + s2 * (a.my - a.y1) + s3 * (a.y1 - a.y2)) / d,
             y: (s1 * (a.mx - a.x2) + s2 * (a.x1 - a.mx) + s3 * (a.x2 - a.x1)) / d };
  }, arc);
  const centreDrag = await drag(
    await screenOf(cc.x, cc.y), await screenOf(cc.x + 3, cc.y + 3),
    () => page.evaluate(() => {
      const s = window.__sindri.sketch;
      return s.dragFrom ? { x: s.dragFrom.x, y: s.dragFrom.y } : null;
    }),
  );
  check(centreDrag.reachable && centreDrag.armed.point,
    "pressing on the arc's centre starts a POINT drag, not a body drag",
    JSON.stringify(centreDrag.armed));
  check(centreDrag.out !== null && Math.hypot(centreDrag.out.x - cc.x, centreDrag.out.y - cc.y) < 5,
    "...from the centre itself",
    `grabbed=${JSON.stringify(centreDrag.out)} centre=(${cc.x.toFixed(3)}, ${cc.y.toFixed(3)})`);

  await browser.close();
  console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
