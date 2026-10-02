// Trim to a TANGENCY, and trim to an arc exactly.
//
// Field request (Doug, 25): "Tangency point + trim to it". Measured on main
// 83ecd3d before the fix: a tangent touch was never a cut point, so trimming a
// curve whose only other boundary was the touch DELETED IT WHOLE. Two causes,
// both in the crossing search:
//
//  - line against circle used an exact discriminant (`disc < 0` means a miss),
//    and a solved tangency leaves it at about ±1e-10 (-1.11e-10 on the belt
//    sketch below), so a real tangency read as a miss about half the time;
//  - anything against an arc or circle was intersected with its TESSELLATION
//    (48 chords per arc, 64 per circle). A touch lies outside the chord
//    polygon, so it was not found at all, and a real crossing landed on a
//    chord: a line trimmed against an r=20 arc ended 0.009 mm off it.
//
// These enter through trimEntity / extendLine. The Extend click calls
// extendLine; the Trim click calls trimWithConstraints, whose geometry
// trimEntity returns (sketchMode.trimClick / extendClick hand them the picked
// index and the raw cursor). The belt goes through the real solver so the
// tangency carries the solver's own noise, not a hand-made exact one.

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// the wasm `?url` import resolves root-relative under vitest (see sketchSolve.test.ts)
declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
import { extendLine, trimEntity } from "./modify";
import { compileAndSolve } from "./sketchSolve";
import { originGeometry } from "./origin";
import { arcCenterRadius } from "./arc";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const D = Math.PI / 180;
const user = (es: ResolvedEntity[]) => es.filter((e) => !e.id.startsWith("__"));
type Line = Extract<ResolvedEntity, { type: "line" }>;
type Arc = Extract<ResolvedEntity, { type: "arc" }>;

/** how far an arc's two ends sit from angle `deg` on its circle, nearest first */
function arcEndAngles(a: Arc): number[] {
  const cr = arcCenterRadius(a)!;
  const ang = (x: number, y: number) => ((Math.atan2(y - cr.c.y, x - cr.c.x) / D) + 360) % 360;
  return [ang(a.x1, a.y1), ang(a.x2, a.y2)];
}

describe("a tangent touch is a cut point", () => {
  it("trims a belt: the circle's inner span and the line's overhang, through the real solver", async () => {
    // two pulleys and a belt: four tangencies, solved by planegcs
    const drawn: ResolvedEntity[] = [
      ...originGeometry(),
      { id: "cA", type: "circle", x: 0, y: 0, radius: 10 },
      { id: "cB", type: "circle", x: 40, y: 0, radius: 6 },
      { id: "l1", type: "line", x1: -5, y1: 10.3, x2: 46, y2: 6.2 },
      { id: "l2", type: "line", x1: -5, y1: -10.3, x2: 46, y2: -6.2 },
    ];
    const cons: SketchConstraint[] = [
      { type: "tangent2", a: "l1", b: "cA" }, { type: "tangent2", a: "l1", b: "cB" },
      { type: "tangent2", a: "l2", b: "cA" }, { type: "tangent2", a: "l2", b: "cB" },
    ];
    const r = await compileAndSolve(drawn, cons);
    expect(r.ok && r.conflicts.length === 0, "the belt must solve before it can be trimmed").toBe(true);
    const solved = r.entities;

    // The inner span of circle A (facing B) lies between the two touch points.
    const iA = solved.findIndex((e) => e.id === "cA");
    const a = user(trimEntity(solved, iA, v(10, 0)));
    const arc = a.find((e) => e.type === "arc") as Arc | undefined;
    expect(arc, "the circle was deleted whole: the touches were not cut points").toBeDefined();
    expect(a.some((e) => e.type === "circle" && e.id === "cA")).toBe(false);
    // what is left is the OUTER side, away from B
    const cr = arcCenterRadius(arc!)!;
    expect(arc!.mx).toBeLessThan(cr.c.x);

    // l1 overhangs circle A to the left of its touch point: trimming the
    // overhang must leave the line, ending on the circle.
    const i1 = solved.findIndex((e) => e.id === "l1");
    const l1 = solved[i1] as Line;
    const tLeft = 0.02; // well inside the overhang, left of the touch
    const out = user(trimEntity(solved, i1, v(l1.x1 + (l1.x2 - l1.x1) * tLeft, l1.y1 + (l1.y2 - l1.y1) * tLeft)));
    const kept = out.filter((e) => e.type === "line" && e !== solved.find((x) => x.id === "l2")) as Line[];
    expect(kept.length, "the line was deleted whole").toBeGreaterThan(0);
    const cA = solved[iA] as Extract<ResolvedEntity, { type: "circle" }>;
    const onA = (x: number, y: number) => Math.abs(Math.hypot(x - cA.x, y - cA.y) - cA.radius);
    expect(Math.min(...kept.map((l) => Math.min(onA(l.x1, l.y1), onA(l.x2, l.y2))))).toBeLessThan(1e-6);
  });

  it("cuts a circle where it touches another circle", () => {
    // c1 touches c2 at 77 deg, which is no tessellation vertex of either (a
    // vertex sitting on the contact is the one way the chord search found a
    // touch: by luck). A horizontal line crosses c1 at 0 and 180 deg.
    const u = v(Math.cos(77 * D), Math.sin(77 * D));
    const ents: ResolvedEntity[] = [
      { id: "c1", type: "circle", x: 0, y: 0, radius: 10 },
      { id: "c2", type: "circle", x: 16 * u.x, y: 16 * u.y, radius: 6 },
      { id: "h", type: "line", x1: -20, y1: 0, x2: 20, y2: 0 },
    ];
    // click at 40 deg, between the line (0 deg) and the touch (77 deg)
    const out = trimEntity(ents, 0, v(Math.cos(40 * D) * 10, Math.sin(40 * D) * 10));
    const arc = out.find((e) => e.type === "arc") as Arc;
    expect(arc).toBeDefined();
    // Without the touch the span around 40 deg ran from 0 to 180 and the whole
    // top half went. With it, only 0..77 goes: the arc runs from 77 round to 0.
    const ends = arcEndAngles(arc).map((a) => (a > 359.999999 ? 0 : a)).sort((p, q) => p - q);
    expect(ends[0]!).toBeCloseTo(0, 6);
    expect(ends[1]!).toBeCloseTo(77, 6);
    expect(arc.my).toBeLessThan(0); // the kept arc goes the long way, through 270
  });

  describe("a line tangent to an arc at 77 deg, which is not a tessellation vertex", () => {
    const C = { x: 60, y: 0 }, R = 8;
    const P = (deg: number) => v(C.x + R * Math.cos(deg * D), C.y + R * Math.sin(deg * D));
    const T = P(77), dir = v(-Math.sin(77 * D), Math.cos(77 * D));
    const s = P(10), e = P(150), m = P(80);
    const ents = (): ResolvedEntity[] => [
      { id: "a1", type: "arc", x1: s.x, y1: s.y, x2: e.x, y2: e.y, mx: m.x, my: m.y },
      { id: "l1", type: "line", x1: T.x - 15 * dir.x, y1: T.y - 15 * dir.y, x2: T.x + 15 * dir.x, y2: T.y + 15 * dir.y },
    ];

    it("trims the line to the touch point", () => {
      const out = trimEntity(ents(), 1, v(T.x - 10 * dir.x, T.y - 10 * dir.y));
      const line = out.find((x) => x.type === "line") as Line | undefined;
      expect(line, "the line was deleted whole").toBeDefined();
      // what is left runs from the touch to the far end
      expect(Math.hypot(line!.x1 - T.x, line!.y1 - T.y)).toBeLessThan(1e-9);
      expect(Math.hypot(line!.x2 - (T.x + 15 * dir.x), line!.y2 - (T.y + 15 * dir.y))).toBeLessThan(1e-9);
    });

    it("trims the arc to the touch point", () => {
      const out = trimEntity(ents(), 0, P(40));
      const arc = out.find((x) => x.type === "arc") as Arc | undefined;
      expect(arc, "the arc was deleted whole").toBeDefined();
      const ends = arcEndAngles(arc!).sort((p, q) => p - q);
      expect(ends[0]!).toBeCloseTo(77, 6);
      expect(ends[1]!).toBeCloseTo(150, 6);
    });
  });

  it("extends a line to a circle its extension only touches", () => {
    // tangent at 77 deg on an r=10 circle, the line lying 5e-7 mm outside it:
    // a touch to anyone looking, and a discriminant clearly below 0
    const T = v(Math.cos(77 * D) * (10 + 5e-7), Math.sin(77 * D) * (10 + 5e-7));
    const dir = v(-Math.sin(77 * D), Math.cos(77 * D));
    const ents: ResolvedEntity[] = [
      { id: "c", type: "circle", x: 0, y: 0, radius: 10 },
      { id: "l", type: "line", x1: T.x - 30 * dir.x, y1: T.y - 30 * dir.y, x2: T.x - 15 * dir.x, y2: T.y - 15 * dir.y },
    ];
    const out = extendLine(ents, 1, v(T.x - 16 * dir.x, T.y - 16 * dir.y));
    expect(out, "extend found nothing to reach").not.toBeNull();
    const line = out!.find((x) => x.type === "line") as Line;
    expect(Math.hypot(line.x2 - T.x, line.y2 - T.y)).toBeLessThan(1e-6);
  });
});

describe("a trimmed end lands ON the arc, not on a chord of it", () => {
  it("is within 1e-9 mm of an r=20 arc (it was 0.009 mm off)", () => {
    const ents: ResolvedEntity[] = [
      { id: "a1", type: "arc", x1: 20, y1: 0, x2: -20, y2: 0, mx: 0, my: 20 },
      { id: "l1", type: "line", x1: 3, y1: 0, x2: 3, y2: 30 },
    ];
    const out = trimEntity(ents, 1, v(3, 28)); // remove the part above the arc
    const line = out.find((e) => e.type === "line") as Line;
    const off = (x: number, y: number) => Math.abs(Math.hypot(x, y) - 20);
    expect(Math.min(off(line.x1, line.y1), off(line.x2, line.y2))).toBeLessThan(1e-9);
  });

  it("is ON a circle too, which was already exact, and stays exact", () => {
    const ents: ResolvedEntity[] = [
      { id: "c", type: "circle", x: 0, y: 0, radius: 20 },
      { id: "l1", type: "line", x1: 3, y1: 0, x2: 3, y2: 30 },
    ];
    const line = trimEntity(ents, 1, v(3, 28)).find((e) => e.type === "line") as Line;
    expect(Math.abs(Math.hypot(line.x2, line.y2) - 20)).toBeLessThan(1e-9);
  });
});
