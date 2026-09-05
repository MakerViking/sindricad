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
//
// The fixtures are the reporters' own sketches (bug-reports/docs/*.json is not
// in the repo, so the two sketch features are inlined verbatim).

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { bodyDragFrame, bodyDragBlocked, fixPinnedIds, pickDragPoint, pickEntity, filletCorner, attachmentPoints } from "./modify";
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
    const arm = sketchModeSrc.indexOf("if (this.guardProjected(this.entities[md.idx]))");
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
    expect(body).toContain("fixPinnedIds(");
    expect(body).toContain("FIXED_POINT_MSG");
    // the WHOLE gesture, not just the pinned entities: transforming the rest of
    // the selection around a held entity tears every joint they share, which is
    // what bodyDragBlocked refuses a whole gesture to avoid
    expect(body).toContain("{ toast(FIXED_POINT_MSG); return; }");
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
    const pins = attachmentPoints(byId(frame, "e6")).map((q) => ({ x: q.x, y: q.y }));
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
    const end = sketchModeSrc.indexOf("this.refreshDragGeometry();", mv);
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
