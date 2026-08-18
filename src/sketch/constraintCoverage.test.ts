// COVERAGE RATCHET for the constraint tools, not a set of hand-written cases.
//
// The tools had nine passing tests and still shipped a silent no-op: clicking a
// line body with Coincident did nothing at all — no constraint, no message, no
// marker — which a field reporter (GitHub #17) and then Thomas both read as
// "sketch lines cannot be selected". Every one of those nine tests clicked a
// VALID target, so none of them could see it.
//
// This file asserts one property instead, over every tool in CONSTRAINT_TOOLS:
//
//     an armed constraint tool must either APPLY something or SAY something.
//     A click that does neither is a bug, whatever the tool.
//
// It enumerates the CONSTRAINT_TOOLS set itself rather than a list copied here,
// so a tool added later is covered the day it is added and coverage cannot decay
// quietly — the same reason the sidecar's op coverage is a ratchet.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ConstraintTools, CONSTRAINT_TOOLS, type ConstraintHost } from "./constraintTools";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { SketchTool } from "./sketchMode";

class Host implements ConstraintHost {
  _tool: SketchTool = "select";
  _ents: ResolvedEntity[] = [];
  _cons: SketchConstraint[] = [];
  _fillet: number | null = null;
  warnings: string[] = [];
  pending: { x: number; y: number } | null = null;
  tool() { return this._tool; }
  entities() { return this._ents; }
  constraints() { return this._cons; }
  pickTol() { return 1; }
  getFilletFirst() { return this._fillet; }
  setFilletFirst(i: number | null) { this._fillet = i; }
  requestSolve() {}
  warn(m: string) { this.warnings.push(m); }
  setPendingPoint(p: { x: number; y: number } | null) { this.pending = p; }
  addConstraint(c: SketchConstraint) { this._cons.push(c); }
}

/** A sketch with a valid target for every tool: two perpendicular lines sharing a
 *  corner, two circles, and an arc. Deliberately NOT uniform — a fixture where
 *  everything looks alike hides the bugs that only appear when things differ. */
const fixture = (): ResolvedEntity[] => [
  { type: "line", id: "L1", x1: 0, y1: 0, x2: 40, y2: 0 } as ResolvedEntity,
  { type: "line", id: "L2", x1: 0, y1: 0, x2: 0, y2: -30 } as ResolvedEntity,
  { type: "line", id: "L3", x1: 60, y1: 0, x2: 100, y2: 3 } as ResolvedEntity,
  { type: "circle", id: "C1", x: 0, y: 60, radius: 10 } as ResolvedEntity,
  { type: "circle", id: "C2", x: 40, y: 60, radius: 6 } as ResolvedEntity,
  { type: "arc", id: "A1", x1: 98, y1: 60, x2: 90, y2: 68, mx: 96, my: 66 } as unknown as ResolvedEntity,
];

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const TOOLS = [...CONSTRAINT_TOOLS];

describe("every constraint tool answers a click that hits nothing", () => {
  // The universal case: empty space. Whatever a tool wants, a click on bare
  // canvas can never satisfy it, so the tool must say so rather than look dead.
  it.each(TOOLS)("%s says something when clicked on empty space", (tool) => {
    const h = new Host();
    h._ents = fixture();
    h._tool = tool;
    const ct = new ConstraintTools(h);
    ct.click(v(500, 500)); // nowhere near any entity
    const didSomething = h._cons.length > 0 || h.warnings.length > 0;
    expect(didSomething, `${tool}: click on empty space was a silent no-op`).toBe(true);
  });

  it.each(TOOLS)("%s says something when the first pick is a wrong-type target", (tool) => {
    const h = new Host();
    h._ents = fixture();
    h._tool = tool;
    const ct = new ConstraintTools(h);
    // A circle is the wrong target for every line-only tool, and a line is wrong
    // for the round-only ones; clicking the circle covers the larger group and
    // leaves the round tools a legitimate target (so they must ACT, not warn).
    ct.click(v(10, 60)); // on C1's rim
    const didSomething = h._cons.length > 0 || h.warnings.length > 0 || h.pending !== null
      || h.getFilletFirst() !== null;
    expect(didSomething, `${tool}: a wrong-type pick was a silent no-op`).toBe(true);
  });
});

describe("the ratchet itself", () => {
  it("covers every tool the app exposes, so a new one cannot slip through", () => {
    // If this fails, a tool was added to CONSTRAINT_TOOLS and this file did not
    // notice. It iterates the set directly, so the only way to fail is an empty
    // or unexported set — which would silently disable the whole matrix above.
    expect(TOOLS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(TOOLS).size).toBe(TOOLS.length); // no duplicates
  });
});

// The hover highlight, which is the other half of GH #17. That report was a
// target you could hit but not SEE; rectangle corners were the same thing until
// this release. A highlight fixes it only while it agrees with the click — a dot
// on a point the flow would not take is a fresh lie, not a fix.
describe("hoverPoint — the highlight cannot disagree with the click", () => {
  const points = (): { name: string; ents: ResolvedEntity[]; at: [number, number] }[] => [
    {
      name: "a line's start",
      ents: [{ type: "line", id: "L", x1: 5, y1: 5, x2: 40, y2: 5 } as ResolvedEntity],
      at: [5, 5],
    },
    {
      name: "a line's end",
      ents: [{ type: "line", id: "L", x1: 5, y1: 5, x2: 40, y2: 5 } as ResolvedEntity],
      at: [40, 5],
    },
    {
      name: "an arc's end",
      ents: [{ type: "arc", id: "A", x1: 98, y1: 60, x2: 90, y2: 68, mx: 96, my: 66 } as unknown as ResolvedEntity],
      at: [90, 68],
    },
    {
      name: "a standalone point",
      ents: [{ type: "point", id: "P", x: -12, y: 7 } as ResolvedEntity],
      at: [-12, 7],
    },
    {
      name: "a rectangle corner (0)",
      ents: [{ type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 } as ResolvedEntity],
      at: [-20, -10],
    },
    {
      name: "a rectangle corner (2), the opposite one",
      ents: [{ type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 } as ResolvedEntity],
      at: [20, 10],
    },
  ];

  for (const c of points()) {
    it(`marks ${c.name}, at the coordinates the click would take`, () => {
      const h = new Host();
      h._ents = c.ents;
      const t = new ConstraintTools(h);
      const cursor = v(c.at[0], c.at[1]);

      const hover = t.hoverPoint(cursor);
      expect(hover, `${c.name}: nothing highlighted where a point is`).not.toBeNull();
      expect(hover!.x).toBeCloseTo(c.at[0], 9);
      expect(hover!.y).toBeCloseTo(c.at[1], 9);

      // and now the half that makes it worth having: drive the real click flow
      // and compare against the marker it sets for its own pending pick.
      h._tool = "coincident";
      t.click(cursor);
      expect(h.pending, `${c.name}: the click took no point the hover promised`).not.toBeNull();
      expect(h.pending!.x).toBeCloseTo(hover!.x, 9);
      expect(h.pending!.y).toBeCloseTo(hover!.y, 9);
    });
  }

  it("stays dark on empty space, and on a curve away from its ends", () => {
    const h = new Host();
    h._ents = [{ type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 0 } as ResolvedEntity];
    const t = new ConstraintTools(h);
    expect(t.hoverPoint(v(500, 500)), "highlighted empty space").toBeNull();
    // mid-span: a real target for the LINE tools, but not a point, so a point
    // highlight there would say the wrong thing about what a click takes
    expect(t.hoverPoint(v(20, 0)), "highlighted a curve body as if it were a point").toBeNull();
  });

  it("picks the NEAREST point when two are in reach, like the click does", () => {
    // teeth: a hover that returned the first match rather than the nearest would
    // pass every single-point case above and still light the wrong corner here
    const h = new Host();
    h._ents = [{ type: "rectangle", id: "R", x: 0, y: 0, width: 4, height: 4 } as ResolvedEntity];
    const t = new ConstraintTools(h);
    const near = t.hoverPoint(v(1.9, 1.9)); // closest to corner 2 at (2,2)
    expect(near).not.toBeNull();
    expect(near!.x).toBeCloseTo(2, 9);
    expect(near!.y).toBeCloseTo(2, 9);
  });
});
