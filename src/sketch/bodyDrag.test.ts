// The select tool's BODY drag — press on an entity's body (not a vertex) and
// move it. Three field reports, one code path.
//
//  d0b008cb "Fix constraint does nothing": a circle pinned with Fix moved
//           anyway, silently, when grabbed by its RIM. A rim click is radius
//           away from the centre, so it never becomes a point drag (which the
//           solver does refuse) — it becomes a body drag, and the body drag ran
//           no solver at all. Worse, `fix` is POSITIONLESS: the post-drag solve
//           re-pins the point at wherever the drag left it and reports ok.
//  c0bf7020 "Tangency ignored while dragging a side": the body drag translated
//           the grabbed line and shifted its neighbours' endpoints by pure
//           arithmetic, so every fillet joint tore open until the button came up.
//  41dc3246 the same, plus: a fillet's radius is not shown or editable, and an
//           arc's centre cannot be grabbed.
//  69d5231f "make one corner of the rectangle coincident with the origin, click
//           on an edge and drag it, it moves the rectangle" — and afterwards the
//           origin could not be picked: the drag had carried the ORIGIN along.
//  3f16187e "I can't see how to select multiple sketch lines / shapes and drag
//           them somewhere together".
//
// The fixtures are the reporters' own sketches (bug-reports/docs/*.json is not
// in the repo, so the two sketch features are inlined verbatim).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));

import { bodyDragFrame, bodyDragBlocked, fixPinnedIds, pickDragPoint, pickEntity, filletCorner, attachmentPoints, FIXED_POINT_MSG } from "./modify";
import { liveSketch } from "./liveSketch.testkit";
import { ORIGIN_ID, originGeometry } from "./origin";
import { rectCorners } from "./region";
import { MAX_BIAS_ANCHORS } from "./sketchSolve";
import { toast } from "../ui/toast";
import { t } from "../i18n";
import { compileAndSolve } from "./sketchSolve";
import { circumcenter } from "./arc";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import sketchModeSrc from "./sketchMode.ts?raw";

// --- the reporters' sketches ------------------------------------------------

/** d0b008cb: two circles pinned with `fix`, plus a filleted profile. */
const fixDoc = (): { ents: ResolvedEntity[]; cons: SketchConstraint[] } => ({
  ents: [
    { type: "rectangle", id: "e1", x: 1.0132081911709392, y: 2.215388601942106, width: 115.8277142653384, height: 55.84160220064344 },
    { type: "circle", id: "e2", x: -57.31526626254479, y: 71.60739298703358, radius: 13.300770981357736 },
    { type: "circle", id: "e3", x: 32.68061256456497, y: 4.656155380829633, radius: 15.967819512259634 },
    { type: "line", id: "e6", x1: -4.652038992853125, y1: 8.937941678353857, x2: -44.52298640053698, y2: -18.9422542302899 },
    { type: "arc", id: "e8", x1: -40.236840740765146, y1: 13.777062314846315, x2: -44.50367352629992, y2: 9.718526527900927, mx: -43.03112065156729, my: 12.44257556253902 },
    { type: "arc", id: "e9", x1: -8.169042843830754, y1: 17.992864191649122, x2: -4.652038992853125, y2: 8.937941678353857, mx: -2.8565426923548536, my: 14.845804084631588 },
    { type: "arc", id: "e10", x1: -49.19329190056506, y1: -15.944416796702743, x2: -44.52298640053698, y2: -18.9422542302899, mx: -47.86271358664694, my: -19.00835350330518 },
    { type: "line", id: "e15", x1: -40.236840740765146, y1: 13.777062314846315, x2: -8.169042843830754, y2: 17.992864191649122 },
    { type: "line", id: "e16", x1: -44.50367352629992, y1: 9.718526527900927, x2: -49.19329190056506, y2: -15.944416796702743 },
  ],
  cons: [
    { type: "radius", id: "c12", e: "e9", value: 5 },
    { type: "tangent2", a: "e9", b: "e6" },
    { type: "tangent2", a: "e6", b: "e10" },
    { type: "radius", id: "c13", e: "e8", value: 5 },
    { type: "radius", id: "c14", e: "e10", value: 3 },
    { type: "tangent2", a: "e16", b: "e8" },
    { type: "tangent2", a: "e15", b: "e8" },
    { type: "tangent2", a: "e15", b: "e9" },
    { type: "tangent2", a: "e16", b: "e10" },
    { type: "fix", e: "e2", p: 0 },
    { type: "fix", e: "e3", p: 0 },
  ],
});

/** c0bf7020: the same profile, no `fix`, six tangencies + one distance. */
const tangentDoc = (): { ents: ResolvedEntity[]; cons: SketchConstraint[] } => ({
  ents: [
    { type: "rectangle", id: "e1", x: 0, y: 1.1397493668952308, width: 115.8277144353254, height: 66.43628250811071 },
    { type: "circle", id: "e2", x: -57.91387233975098, y: 34.35789280380732, radius: 13.300770981357736 },
    { type: "circle", id: "e3", x: 28.281856136784345, y: 3.306585170221054, radius: 15.967819512259634 },
    { type: "line", id: "e6", x1: -3.8303737226431984, y1: 8.563539650569542, x2: -50.330365259060684, y2: -30.191163558102986 },
    { type: "arc", id: "e8", x1: -49.911645341684206, y1: 17.452782577292243, x2: -56.7252570063512, y2: 10.32972215474263, mx: -54.73369388148158, my: 15.24501235791418 },
    { type: "arc", id: "e9", x1: -8.144758491702225, y1: 19.589999139649123, x2: -3.8303737226431984, y2: 8.563539650569542, mx: -2.014227168001174, my: 15.6314400506009 },
    { type: "arc", id: "e10", x1: -56.97664756369172, y1: -27.05115250493374, x2: -50.330365259060684, y2: -30.191163558102986, mx: -54.65557855369911, my: -30.742186981620865 },
    { type: "line", id: "e12", x1: -49.911645341684206, y1: 17.452782577292243, x2: -8.144758491702225, y2: 19.589999139649123 },
    { type: "line", id: "e13", x1: -56.7252570063512, y1: 10.32972215474263, x2: -56.97664756369172, y2: -27.05115250493374 },
  ],
  cons: [
    { type: "p2lDistance", id: "c11", e: "e10", p: 2, line: "e1~0", value: 5, place: { ox: -37.9618, oy: 0.5247 } },
    { type: "tangent2", a: "e12", b: "e8" },
    { type: "tangent2", a: "e12", b: "e9" },
    { type: "tangent2", a: "e9", b: "e6" },
    { type: "tangent2", a: "e6", b: "e10" },
    { type: "tangent2", a: "e10", b: "e13" },
    { type: "tangent2", a: "e13", b: "e8" },
  ],
});

const at = (ents: ResolvedEntity[], id: string) => ents.findIndex((e) => e.id === id);
const byId = (ents: ResolvedEntity[], id: string) => ents.find((e) => e.id === id)!;

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });

/** The worst tangency error, in degrees, over every `tangent2` pair that joins a
 *  line to an arc: the angle between the line and the arc's tangent at the
 *  endpoint they share. This is the kink the reporter sees. */
function worstTangencyDeg(ents: ResolvedEntity[], cons: SketchConstraint[]): number {
  let worst = 0;
  for (const c of cons) {
    if (c.type !== "tangent2") continue;
    const A = byId(ents, c.a), B = byId(ents, c.b);
    const ln = A.type === "line" ? A : B.type === "line" ? B : null;
    const ar = A.type === "arc" ? A : B.type === "arc" ? B : null;
    if (!ln || !ar || ln.type !== "line" || ar.type !== "arc") continue;
    const cc = circumcenter({ x: ar.x1, y: ar.y1 }, { x: ar.x2, y: ar.y2 }, { x: ar.mx, y: ar.my });
    if (!cc) continue;
    // the endpoint pair they share (nearest of the four combinations)
    const lp = [new THREE.Vector2(ln.x1, ln.y1), new THREE.Vector2(ln.x2, ln.y2)];
    const ap = [new THREE.Vector2(ar.x1, ar.y1), new THREE.Vector2(ar.x2, ar.y2)];
    let best = ap[0]!, bestD = Infinity;
    for (const a of ap) for (const l of lp) {
      const d = a.distanceTo(l);
      if (d < bestD) { bestD = d; best = a; }
    }
    const r = new THREE.Vector2(best.x - cc.x, best.y - cc.y);
    const tangent = new THREE.Vector2(-r.y, r.x).normalize();
    const dir = new THREE.Vector2(ln.x2 - ln.x1, ln.y2 - ln.y1).normalize();
    const cos = Math.min(1, Math.abs(tangent.dot(dir)));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
}

// --- d0b008cb: a Fix constraint must survive a body drag --------------------

describe("Fix pins geometry against the body drag (d0b008cb)", () => {
  it("a rim grab lands on the circle BODY, which is why the solver never saw it", () => {
    // Not the fix — the link in the chain. `pickPoint` only offers the CENTRE as
    // a drag handle, and the rim is a radius away from it, so a rim press falls
    // through to the body drag.
    const { ents } = fixDoc();
    const c = byId(ents, "e2") as Extract<ResolvedEntity, { type: "circle" }>;
    const idx = pickEntity(ents, new THREE.Vector2(c.x + c.radius, c.y), 0.3);
    expect(ents[idx]?.id).toBe("e2");
  });

  it("refuses to translate a fix-pinned circle, and leaves it exactly where it was", () => {
    const { ents, cons } = fixDoc();
    expect(bodyDragFrame(ents, at(ents, "e2"), 20, 10, cons)).toBeNull();
    const c = byId(ents, "e2") as Extract<ResolvedEntity, { type: "circle" }>;
    expect(c.x).toBe(-57.31526626254479);
    expect(c.y).toBe(71.60739298703358);
  });

  it("moves the same circle by exactly the drag once the Fix is deleted", () => {
    // guards against a guard that refuses everything
    const { ents, cons } = fixDoc();
    const free = cons.filter((c) => c.type !== "fix");
    const out = bodyDragFrame(ents, at(ents, "e2"), 20, 10, free);
    expect(out).not.toBeNull();
    const c = byId(out!, "e2") as Extract<ResolvedEntity, { type: "circle" }>;
    expect(c.x).toBeCloseTo(-37.31526626254479, 9);
    expect(c.y).toBeCloseTo(81.60739298703358, 9);
  });

  it("is not circle-specific: a fix-pinned LINE is refused too", () => {
    const ents = [line("L", 0, 0, 10, 0), line("M", 40, 40, 50, 40)];
    const cons: SketchConstraint[] = [{ type: "fix", e: "L", p: 0 }];
    expect(bodyDragFrame(ents, 0, 5, 5, cons)).toBeNull();
    const out = bodyDragFrame(ents, 1, 5, 5, cons); // a free entity still drags
    expect(out).not.toBeNull();
    expect((out![1] as Extract<ResolvedEntity, { type: "line" }>).x1).toBeCloseTo(45);
  });

  it("refuses when the drag would carry a NEIGHBOUR's fix-pinned endpoint along", () => {
    // Dropping just that one mutator would tear the joint instead: merged-by-
    // position points have nothing pulling them back together.
    const ents = [line("L", 0, 0, 10, 0), line("M", 10, 0, 10, 20)];
    const cons: SketchConstraint[] = [{ type: "fix", e: "L", p: 1 }]; // the shared corner
    expect(bodyDragBlocked(ents, 1, cons)).toBe(true);
    expect(bodyDragFrame(ents, 1, 3, 0, cons)).toBeNull();
  });

  it("fixPinnedIds names exactly the entities a `fix` pins", () => {
    const { cons } = fixDoc();
    expect([...fixPinnedIds(cons)].sort()).toEqual(["e2", "e3"]);
  });

  it("the select tool refuses the gesture before anything moves, and can say so twice", () => {
    // Source-asserted: a live SketchMode needs viewport, overlay and solver.
    // Both halves matter — the check sits in the `!md.started` arming branch
    // (nothing has moved yet), and the arming sites clear the one-toast latch or
    // every refusal after the first is silent, which is the same class of bug.
    const arm = sketchModeSrc.indexOf("if (md.group.some((i) => this.guardProjected(this.entities[i])))");
    expect(arm).toBeGreaterThan(-1);
    const started = sketchModeSrc.indexOf("md.started = true;", arm);
    expect(sketchModeSrc.slice(arm, started)).toContain("bodyDragBlocked(");
    expect(sketchModeSrc.slice(arm, started)).toContain("FIXED_POINT_MSG");
    // two moveDrag arming sites (text and entity body), both clearing the latch
    const armed = sketchModeSrc.split("this.moveDrag = {");
    expect(armed.length).toBe(3);
    for (const after of armed.slice(1)) {
      expect(after.slice(0, 400)).toContain("this.dragRefusedToast = false;");
    }
  });

  it("Move/Rotate/Scale refuse a fix-pinned selection with the same message", () => {
    const tf = sketchModeSrc.indexOf("private transformSelection(");
    expect(tf).toBeGreaterThan(-1);
    const body = sketchModeSrc.slice(tf, tf + 1600);
    expect(body).toContain("if (this.refusePinnedSelection()) return;");
    const rp = sketchModeSrc.indexOf("private refusePinnedSelection(");
    expect(rp).toBeGreaterThan(-1);
    const check = sketchModeSrc.slice(rp, rp + 400);
    expect(check).toContain("fixPinnedIds(");
    // the WHOLE gesture, not just the pinned entities: transforming the rest of
    // the selection around a held entity tears every joint they share, which is
    // what bodyDragBlocked refuses a whole gesture to avoid
    expect(check).toContain("toast(FIXED_POINT_MSG);");
  });
});

// --- c0bf7020: every body-drag frame is solved -----------------------------

describe("a body-drag frame is solved with the dragged entity pinned (c0bf7020)", () => {
  const DX = 3, DY = 3;

  it("CONTROL: the raw frame tears the fillet joints open", () => {
    // What the reporter sees today, and why a per-frame solve is needed at all.
    const { ents, cons } = tangentDoc();
    expect(worstTangencyDeg(ents, cons)).toBeLessThan(0.01); // the doc is tangent at rest
    const raw = bodyDragFrame(ents, at(ents, "e6"), DX, DY, cons)!;
    expect(worstTangencyDeg(raw, cons)).toBeGreaterThan(10);
  });

  it("solving the frame with the dragged side pinned keeps it tangent AND under the cursor", async () => {
    const { ents, cons } = tangentDoc();
    const before = byId(ents, "e6") as Extract<ResolvedEntity, { type: "line" }>;
    const want = { x1: before.x1 + DX, y1: before.y1 + DY, x2: before.x2 + DX, y2: before.y2 + DY };

    const frame = bodyDragFrame(ents, at(ents, "e6"), DX, DY, cons)!;
    const pins = attachmentPoints(byId(frame, "e6"), cons).map((q) => ({ x: q.x, y: q.y }));
    const r = await compileAndSolve(frame, cons, undefined, undefined, pins);

    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(worstTangencyDeg(r.entities, cons)).toBeLessThan(0.01);
    const after = byId(r.entities, "e6") as Extract<ResolvedEntity, { type: "line" }>;
    expect(Math.hypot(after.x1 - want.x1, after.y1 - want.y1)).toBeLessThan(0.05);
    expect(Math.hypot(after.x2 - want.x2, after.y2 - want.y2)).toBeLessThan(0.05);
  });

  it("CONTROL: without the pins the same solve slides the side off the cursor", async () => {
    // The sketch is under-constrained, so an unpinned solve is free to rotate the
    // whole profile — which is why "just call compileAndSolve every frame" is not
    // the fix on its own.
    const { ents, cons } = tangentDoc();
    const before = byId(ents, "e6") as Extract<ResolvedEntity, { type: "line" }>;
    const frame = bodyDragFrame(ents, at(ents, "e6"), DX, DY, cons)!;
    const r = await compileAndSolve(frame, cons);
    const after = byId(r.entities, "e6") as Extract<ResolvedEntity, { type: "line" }>;
    const drift = Math.hypot(after.x1 - (before.x1 + DX), after.y1 - (before.y1 + DY));
    expect(drift).toBeGreaterThan(0.5);
  });

  it("the pointermove branch runs the frame through the solve pump", () => {
    const mv = sketchModeSrc.indexOf("if (this.moveDrag) {");
    expect(mv).toBeGreaterThan(-1);
    // The branch ends at the frame request: the redraw now runs once per frame
    // with the solve (queueDragFrame, GH #17), not once per pointermove here.
    const call = "this.queueBodyDrag(md.group);";
    const end = sketchModeSrc.indexOf(call, mv) + call.length;
    expect(end).toBeGreaterThan(call.length);
    const body = sketchModeSrc.slice(mv, end);
    expect(body).toContain("bodyDragFrame(");
    expect(body).toContain("this.queueBodyDrag(");
    // ...and the pump's drag branch must not bail on a body drag (dragFrom is
    // null throughout one), or the solve is queued and never runs. It must also
    // CONTINUE rather than break when it does discard a result: endDrag's settle
    // sets solveDirty while the last frame solve is in flight, and breaking out
    // of the loop leaves that settle queued with nothing to consume it (the
    // release-lands-mid-solve regression; e2e measures the effect).
    expect(sketchModeSrc).toContain("if (!this.active || (forBody ? !this.moveDrag : !this.dragFrom)) continue;");
    // one undo step per gesture, not per frame: the per-frame solve must not go
    // through requestSolve (which banks)
    expect(body).not.toContain("this.requestSolve()");
  });
});

// --- 41dc3246: the fillet's radius, and the arc centre ----------------------

describe("a sketch fillet persists its radius (41dc3246)", () => {
  it("returns the tangencies and the radius alongside the geometry", () => {
    const ents = [line("A", 0, 0, 40, 0), line("B", 40, 0, 40, 40)];
    const out = filletCorner(ents, 0, 1, 8);
    expect(out).not.toBeNull();
    const kinds = out!.constraints.map((c) => c.type).sort();
    expect(kinds).toEqual(["radius", "tangent2", "tangent2"]);
  });

  it("the constraints it adds solve clean, at the typed radius", async () => {
    const ents = [line("A", 0, 0, 40, 0), line("B", 40, 0, 40, 40)];
    const out = filletCorner(ents, 0, 1, 8)!;
    const r = await compileAndSolve(out.entities, out.constraints);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const arc = r.entities[r.entities.length - 1] as Extract<ResolvedEntity, { type: "arc" }>;
    const cc = circumcenter({ x: arc.x1, y: arc.y1 }, { x: arc.x2, y: arc.y2 }, { x: arc.mx, y: arc.my })!;
    expect(Math.hypot(arc.x1 - cc.x, arc.y1 - cc.y)).toBeCloseTo(8, 4);
  });

  it("the tool puts them on trial, so a conflict withdraws them instead of the fillet", () => {
    const af = sketchModeSrc.indexOf("private applyFillet(");
    expect(af).toBeGreaterThan(-1);
    const body = sketchModeSrc.slice(af, af + 1600);
    expect(body).toContain("this.trial = {");
  });
});

describe("an arc's centre is a drag handle (41dc3246)", () => {
  const arcOnly = (): ResolvedEntity[] => [
    { type: "arc", id: "a1", x1: 0, y1: 10, x2: 10, y2: 0, mx: 7.0710678, my: 7.0710678 },
  ];

  it("picks the centre when the cursor is on it", () => {
    const got = pickDragPoint(arcOnly(), new THREE.Vector2(0.3, -0.2), 2);
    expect(got).not.toBeNull();
    expect(got!.idx).toBe(0);
    expect(got!.x).toBeCloseTo(0, 5);
    expect(got!.y).toBeCloseTo(0, 5);
  });

  it("never steals a click from a closer endpoint", () => {
    // a fillet's centre can sit inside pick tolerance of its own tangent points
    const got = pickDragPoint(arcOnly(), new THREE.Vector2(0, 9.8), 12);
    expect(got!.x).toBeCloseTo(0, 5);
    expect(got!.y).toBeCloseTo(10, 5);
  });

  it("the select tool picks through it", () => {
    expect(sketchModeSrc).toContain("pickDragPoint(this.entities,");
  });
});

// --- 69d5231f: a body drag never carries the origin -------------------------

/** 69d5231f: the reporter's own sketch, verbatim as saved. A 60x50 rectangle,
 *  both sides dimensioned, its top-left corner (p3) coincident with the origin.
 *  As SAVED it violates that coincident: the drag had carried the origin off
 *  0,0, and the origin only goes back there when a sketch is reopened, which is
 *  the solve each test below starts with. */
const originDoc = (): { ents: ResolvedEntity[]; cons: SketchConstraint[] } => ({
  ents: [{ type: "rectangle", id: "e0", x: 66.26166937919658, y: -34.80045118356664, width: 60, height: 50 }],
  cons: [
    { id: "c1", line: "e0~3", type: "distance", value: 50 },
    { id: "c2", line: "e0~0", type: "distance", value: 60 },
    { e1: "__origin__", e2: "e0", p1: 0, p2: 3, type: "coincident" },
  ],
});

/** the rectangle's top-left corner, the one the coincident names (p3) */
const topLeft = (e: ResolvedEntity | undefined) => {
  if (e?.type !== "rectangle") throw new Error("rectangle lost");
  return rectCorners(e.x, e.y, e.width, e.height)[3]!;
};
const originAt = (ents: ResolvedEntity[]) => {
  const o = ents.find((e) => e.id === ORIGIN_ID);
  if (o?.type !== "point") throw new Error("origin lost");
  return { x: o.x, y: o.y };
};

describe("a body drag never carries the origin (69d5231f)", () => {
  /** reopen the reporter's sketch: one solve, which snaps the corner to 0,0 */
  const reopened = async () => {
    const { ents, cons } = originDoc();
    const live = liveSketch(ents, cons);
    live.s.requestSolve();
    await live.settle();
    const tl = topLeft(live.ent("e0"));
    expect(Math.hypot(tl.x, tl.y), "reopening should put the corner back on the origin").toBeLessThan(1e-6);
    return live;
  };

  it("an edge drag leaves the dimensioned rectangle exactly where the coincident holds it", async () => {
    const live = await reopened();
    // the bottom edge, midway: 30 mm from either corner, so a BODY press
    live.press(30, -50);
    expect(live.s.moveDrag, "the edge press did not arm a body drag").not.toBeNull();
    for (let i = 1; i <= 6; i++) {
      live.move(30 + 3 * i, -50 + 2 * i); // six frames of (3, 2), the replay's gesture
      await live.settle();
    }
    live.release();
    await live.settle();

    const o = originAt(live.s.entities);
    expect(Math.hypot(o.x, o.y), `origin moved to (${o.x}, ${o.y})`).toBeLessThan(1e-9);
    const tl = topLeft(live.ent("e0"));
    expect(Math.hypot(tl.x, tl.y), `corner left the origin: (${tl.x}, ${tl.y})`).toBeLessThan(1e-4);
    const r = live.ent("e0") as Extract<ResolvedEntity, { type: "rectangle" }>;
    expect(r.width).toBeCloseTo(60, 4);
    expect(r.height).toBeCloseTo(50, 4);
  });

  it("the origin can still be picked at 0,0 afterwards (the report's second half)", async () => {
    const live = await reopened();
    await live.drag([30, -50], [48, -38]);
    live.s.setTool("coincident");
    live.click(0, 0);
    const held = live.held();
    expect(held, "Coincident's first click at 0,0 picked nothing").toHaveLength(1);
    expect(Math.hypot(held[0]!.x, held[0]!.y)).toBeLessThan(1e-6);
  });

  it("a fast drag, frames piling up behind one solve, ends in the same place", async () => {
    const live = await reopened();
    await live.drag([30, -50], [48, -38], 6, false);
    const o = originAt(live.s.entities);
    expect(Math.hypot(o.x, o.y)).toBeLessThan(1e-9);
    const tl = topLeft(live.ent("e0"));
    expect(Math.hypot(tl.x, tl.y)).toBeLessThan(1e-4);
  });

  it("an anchored rectangle with free sides STRETCHES, its corner staying on the origin", async () => {
    // The decision this fix makes: the coincident is a real constraint and the
    // drag's pins are soft, so the corner holds and the far side follows the
    // cursor. A `fix` pin refuses instead; an origin coincident does not.
    const live = liveSketch(
      [{ type: "rectangle", id: "e0", x: 30, y: -25, width: 60, height: 50 }],
      [{ type: "coincident", e1: "__origin__", p1: 0, e2: "e0", p2: 3 }],
    );
    await live.drag([30, -50], [48, -38]);
    const o = originAt(live.s.entities);
    expect(Math.hypot(o.x, o.y)).toBeLessThan(1e-9);
    const tl = topLeft(live.ent("e0"));
    expect(Math.hypot(tl.x, tl.y)).toBeLessThan(1e-4);
    const r = live.ent("e0") as Extract<ResolvedEntity, { type: "rectangle" }>;
    expect(r.width).toBeCloseTo(78, 1);
    expect(r.height).toBeCloseTo(38, 1);
  });

  it("a line merely drawn from the origin leaves the origin at 0,0", async () => {
    // No constraint holds this line to the origin; it only shares the point. It
    // used to take the origin with it. Where the LINE ends up is deliberately
    // not asserted: today it moves off the origin rigidly, and whether a joint
    // held only by position should instead stretch, refuse the drag, or never
    // exist (the draw tools adding a coincident on the origin snap) is an open
    // decision, not something this test should settle.
    const live = liveSketch([line("L", 0, 0, 20, 10)]);
    await live.drag([10, 5], [15, 10]);
    const o = originAt(live.s.entities);
    expect(Math.hypot(o.x, o.y), `origin moved to (${o.x}, ${o.y})`).toBeLessThan(1e-9);
  });

  it("bodyDragFrame leaves origin geometry alone even when asked to move it", () => {
    const ents = [...originGeometry(), line("L", 0, 0, 20, 10)];
    const all = ents.map((_, i) => i);
    const out = bodyDragFrame(ents, all, 4, 4, [])!;
    for (const id of ["__origin__", "__originX__", "__originY__"]) {
      expect(out.find((e) => e.id === id)).toBe(ents.find((e) => e.id === id));
    }
  });
});

// --- 3f16187e: dragging a selection ------------------------------------------

describe("dragging a selection moves all of it (3f16187e)", () => {
  beforeEach(() => { vi.mocked(toast).mockClear(); });
  const L = (live: ReturnType<typeof liveSketch>, id: string) =>
    live.ent(id) as Extract<ResolvedEntity, { type: "line" }>;

  it("two separate lines, Shift-selected, move together by the drag", async () => {
    const live = liveSketch([line("A", 10, 10, 30, 10), line("B", 10, 30, 30, 40)]);
    live.click(20, 10);
    live.click(20, 35, true);
    expect([...live.s.selected].sort()).toEqual(["A", "B"]);
    await live.drag([20, 10], [25, 13]);
    expect(L(live, "A").x1).toBeCloseTo(15, 6);
    expect(L(live, "A").y1).toBeCloseTo(13, 6);
    expect(L(live, "B").x1).toBeCloseTo(15, 6);
    expect(L(live, "B").y1).toBeCloseTo(33, 6);
    expect(L(live, "B").x2).toBeCloseTo(35, 6);
    expect(L(live, "B").y2).toBeCloseTo(43, 6);
  });

  it("a marquee selection drags together too", async () => {
    const live = liveSketch([line("A", 10, 10, 30, 10), line("B", 10, 30, 30, 40)]);
    // window box from empty space round both lines
    live.press(5, 5);
    live.move(35, 45);
    live.release();
    expect([...live.s.selected].sort()).toEqual(["A", "B"]);
    await live.drag([20, 35], [20, 45]);
    expect(L(live, "A").y1).toBeCloseTo(20, 6);
    expect(L(live, "B").y1).toBeCloseTo(40, 6);
  });

  it("CONTROL: grabbing a line OUTSIDE the selection drags only that line", async () => {
    const live = liveSketch([line("A", 10, 10, 30, 10), line("B", 10, 30, 30, 40), line("C", 50, 0, 50, 20)]);
    live.click(20, 10);
    live.click(20, 35, true);
    await live.drag([50, 10], [55, 10]);
    expect(L(live, "C").x1).toBeCloseTo(55, 6);
    expect(L(live, "A").x1).toBeCloseTo(10, 9);
    expect(L(live, "B").x1).toBeCloseTo(10, 9);
  });

  it("geometry joined to the selection is carried along at the joint", async () => {
    // C is not selected but shares A's right end: it stretches with the drag,
    // the same rule the single-entity drag has always had.
    const live = liveSketch([line("A", 10, 10, 30, 10), line("B", 10, 30, 30, 40), line("C", 30, 10, 40, 0)]);
    live.click(20, 10);
    live.click(20, 35, true);
    await live.drag([20, 10], [20, 15]);
    expect(L(live, "B").y1).toBeCloseTo(35, 6);
    expect(L(live, "C").x1).toBeCloseTo(30, 6);
    expect(L(live, "C").y1).toBeCloseTo(15, 6);
    expect(L(live, "C").x2).toBeCloseTo(40, 9);
    expect(L(live, "C").y2).toBeCloseTo(0, 9);
  });

  it("grabbing a Shift-selected origin axis is still refused, and moves none of the selection", async () => {
    // The marquee leaves origin geometry out, but Shift-click does not. The
    // group drops the origin, so if the GRABBED axis were treated like any other
    // member, dragging the X axis would quietly move line A instead of refusing.
    const live = liveSketch([line("A", 10, 10, 30, 10)]);
    live.click(20, 10);
    live.click(60, 0, true); // the X axis
    expect([...live.s.selected].sort()).toEqual(["A", "__originX__"]);
    await live.drag([70, 0], [70, 5]);
    expect(L(live, "A").y1).toBeCloseTo(10, 9);
    expect(L(live, "A").y2).toBeCloseTo(10, 9);
    expect(vi.mocked(toast)).toHaveBeenCalledWith(t("sketch.guard.originFixed"));
  });

  it("one fix-pinned member refuses the whole gesture, and says why", async () => {
    const live = liveSketch(
      [line("A", 10, 10, 30, 10), line("B", 10, 30, 30, 40)],
      [{ type: "fix", e: "A", p: 0 }],
    );
    live.click(20, 10);
    live.click(20, 35, true);
    await live.drag([20, 35], [25, 40]); // grab the FREE one
    expect(L(live, "A").x1).toBeCloseTo(10, 9);
    expect(L(live, "B").x1).toBeCloseTo(10, 9);
    expect(L(live, "B").y1).toBeCloseTo(30, 9);
    expect(vi.mocked(toast)).toHaveBeenCalledWith(FIXED_POINT_MSG);
  });

  it("the whole move is ONE undo step", async () => {
    const live = liveSketch([line("A", 10, 10, 30, 10), line("B", 10, 30, 30, 40)]);
    live.click(20, 10);
    live.click(20, 35, true);
    const depth = live.s.history.depth;
    await live.drag([20, 10], [25, 13]);
    expect(live.s.history.depth).toBe(depth + 1);
    live.s.undoEdit();
    expect(L(live, "A").x1).toBeCloseTo(10, 9);
    expect(L(live, "B").x1).toBeCloseTo(10, 9);
  });

  it("a selection with more pins than the solver's anchor budget moves without a solve per frame", async () => {
    // Every pin is a solver anchor, and past a few hundred the planegcs heap can
    // abort (measured: 200 lines parallel to one, 402 pins, Aborted(OOM)), which
    // turns constraint solving off for the session. Past the budget the frames
    // are plain translations and the release settles once.
    //
    // Ids like the app's own (e0, e1...): a `P<n>` entity id collides with the
    // solver's own point ids and fails the solve for an unrelated reason.
    const n = Math.ceil(MAX_BIAS_ANCHORS / 2) + 5; // two pins per line
    const ents = Array.from({ length: n }, (_, k) => line(`e${k}`, 10, 10 + k, 15, 10 + k));
    const live = liveSketch(ents);
    for (const e of ents) live.s.selected.add(e.id);
    live.press(12, 10);
    live.move(14, 10);
    // pump() takes the queued pins synchronously, so a frame solve shows up as
    // a solve in flight rather than as anything still queued
    expect(live.s.solveBusy, "a frame solve ran past the anchor budget").toBe(false);
    for (let i = 1; i <= 3; i++) { live.move(12 + i, 10); }
    live.release();
    await live.settle();
    expect(live.s.solverDead).toBe(false);
    for (const e of ents) expect(L(live, e.id).x1).toBeCloseTo(13, 6);
  });
});
