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
  pendingAll: { x: number; y: number }[] = [];
  tool() { return this._tool; }
  entities() { return this._ents; }
  constraints() { return this._cons; }
  pickTol() { return 1; }
  getFilletFirst() { return this._fillet; }
  setFilletFirst(i: number | null) { this._fillet = i; }
  requestSolve() {}
  warn(m: string) { this.warnings.push(m); }
  setPendingPoints(ps: { x: number; y: number }[]) { this.pending = ps[0] ?? null; this.pendingAll = ps; }
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

// Three ways a tool that WORKS could still read as broken. All three survived
// the first affordance pass because each satisfies "did something" in the
// ratchet above — by saying the wrong thing, or by consuming a click that the
// ratchet's single-click property never looks past.
describe("a working tool must not report itself as a miss", () => {
  const RECT = { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 } as ResolvedEntity;

  it.each(["tangent", "equal", "concentric"] as SketchTool[])(
    "%s stays quiet on the click that ARMS it, rather than crying miss",
    (tool) => {
      const h = new Host();
      h._ents = fixture();
      h._tool = tool;
      const ct = new ConstraintTools(h);
      ct.click(v(10, 60)); // dead on C1's rim: a valid first operand for all three
      expect(h.getFilletFirst(), `${tool}: the pick was not held`).not.toBeNull();
      expect(h.warnings, `${tool}: a landed first pick was reported as a miss`).toEqual([]);
    },
  );

  it("equal on a line and a circle says why, instead of eating both clicks", () => {
    // Both picks are valid targets, so "nothing to constrain there" would be a
    // lie — but a length and a radius are not comparable, so there is nothing to
    // emit either. This used to fall off the end of the method: two clicks
    // consumed, no constraint, no message.
    const h = new Host();
    h._ents = fixture();
    h._tool = "equal";
    const ct = new ConstraintTools(h);
    ct.click(v(80, 1.5)); // on L3
    ct.click(v(10, 60)); // on C1's rim
    expect(h._cons, "a line and a circle cannot be made equal").toEqual([]);
    expect(h.warnings.length, "both clicks were consumed in silence").toBeGreaterThan(0);
    expect(h.warnings.join(" ")).toMatch(/two lines|two circles|radius/i);
  });

  it("coincident on two corners of ONE rectangle refuses out loud", () => {
    // Newly reachable: both corners carry the rectangle's own id, so the old
    // `if (a.id !== ep.id)` skipped them — no constraint, no message, and the
    // pending marker wiped. Refusing is right (that pair annihilates the
    // rectangle in a single solve); refusing silently is not.
    const h = new Host();
    h._ents = [RECT];
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(-20, -10)); // corner 0
    expect(h.pending, "the first corner was not held").not.toBeNull();
    ct.click(v(20, 10)); // corner 2, same rectangle
    expect(h._cons, "a self-annihilating pair was applied").toEqual([]);
    expect(h.warnings.length, "the refusal was silent").toBeGreaterThan(0);
    expect(h.warnings.join(" ")).toMatch(/same shape|collapse/i);
  });

  it("CONTROL: two corners of DIFFERENT shapes still apply", () => {
    // Proves the refusal above is scoped to one entity rather than to rectangle
    // corners in general, which would close the door this release just opened.
    const h = new Host();
    h._ents = [RECT, { type: "point", id: "P", x: 60, y: 60 } as ResolvedEntity];
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(-20, -10)); // a rectangle corner
    ct.click(v(60, 60)); // a separate point
    expect(h._cons, "a legitimate corner-to-point coincident was refused").toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });
});

// The first-pick highlight has to know WHICH of a rectangle's four line operands
// was armed, or it lights all four sides for a constraint that will apply to one.
// filletFirst carries an ENTITY index and cannot express that; this is the half
// that can. (What sketchMode then DRAWS with it is not unit-testable — that file
// is scoped out as e2e territory — so this pins the seam, not the pixels.)
describe("heldOperandId — which operand a two-pick flow is holding", () => {
  const RECT = { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 } as ResolvedEntity;

  it("names the rectangle EDGE that was picked, not the rectangle", () => {
    const h = new Host();
    h._ents = [RECT];
    h._tool = "parallel";
    const ct = new ConstraintTools(h);
    ct.click(v(0, -10)); // the bottom edge
    expect(h.getFilletFirst(), "the pick was not armed").not.toBeNull();
    expect(ct.heldOperandId()).toBe("R~0");
    // and the OTHER edges are distinguishable, which is the whole point
    const h2 = new Host();
    h2._ents = [RECT];
    h2._tool = "parallel";
    const ct2 = new ConstraintTools(h2);
    ct2.click(v(20, 0)); // the right edge
    expect(ct2.heldOperandId()).toBe("R~1");
  });

  it("is null when nothing is held, so a stale id cannot outlive the pick", () => {
    const h = new Host();
    h._ents = [RECT];
    h._tool = "parallel";
    const ct = new ConstraintTools(h);
    expect(ct.heldOperandId()).toBeNull();
    ct.click(v(0, -10));
    expect(ct.heldOperandId()).toBe("R~0");
    ct.resetPending(); // Escape / tool switch
    h.setFilletFirst(null);
    expect(ct.heldOperandId(), "the id outlived the pick it belonged to").toBeNull();
  });

  it("stays null for a plain line, where the entity id already says it all", () => {
    const h = new Host();
    h._ents = [{ type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 0 } as ResolvedEntity];
    h._tool = "parallel";
    const ct = new ConstraintTools(h);
    ct.click(v(20, 0));
    expect(ct.heldOperandId()).toBe("L"); // same as the entity: the caller draws the entity
  });
});

// Symmetric is a THREE-click gesture — point, point, axis — and only the first
// click used to leave a marker. The middle of the gesture showed nothing at all,
// which on a tool whose first click was already invisible once (GH #17) is the
// same failure wearing a different hat.
describe("symmetric marks BOTH points it is holding", () => {
  const L1 = { type: "line", id: "L1", x1: 0, y1: 0, x2: 40, y2: 0 } as ResolvedEntity;
  const L2 = { type: "line", id: "L2", x1: 0, y1: 20, x2: 40, y2: 20 } as ResolvedEntity;
  const AX = { type: "line", id: "AX", x1: -10, y1: 10, x2: 50, y2: 10 } as ResolvedEntity;
  const armed = () => {
    const h = new Host();
    h._ents = [L1, L2, AX];
    h._tool = "symmetric";
    return { h, ct: new ConstraintTools(h) };
  };

  it("holds one marker after the first pick and TWO after the second", () => {
    const { h, ct } = armed();
    ct.click(v(0, 0)); // L1 start
    expect(h.pendingAll, "the first pick was not marked").toHaveLength(1);
    ct.click(v(0, 20)); // L2 start
    expect(h.pendingAll, "the second pick left no marker").toHaveLength(2);
    expect(h.pendingAll).toContainEqual({ x: 0, y: 0 });
    expect(h.pendingAll).toContainEqual({ x: 0, y: 20 });
  });

  it("clears both once the axis completes the constraint", () => {
    const { h, ct } = armed();
    ct.click(v(0, 0));
    ct.click(v(0, 20));
    ct.click(v(25, 10)); // the axis line, away from any endpoint
    expect(h._cons, "the symmetric constraint was not applied").toHaveLength(1);
    expect(h._cons[0]!.type).toBe("symmetric");
    expect(h.pendingAll, "the markers outlived the completed gesture").toEqual([]);
  });

  it("says so when the second pick is the point already held", () => {
    // This used to return having done and said nothing, leaving a pick held that
    // the user had no way to tell was still held.
    const { h, ct } = armed();
    ct.click(v(0, 0));
    ct.click(v(0, 0)); // the same point again
    expect(h._cons).toEqual([]);
    expect(h.warnings.length, "the repeat pick was swallowed").toBeGreaterThan(0);
    expect(h.warnings.join(" ")).toMatch(/already picked/i);
    expect(h.pendingAll, "the first pick was dropped").toHaveLength(1);
  });

  it("clears every marker when the gesture is abandoned", () => {
    const { h, ct } = armed();
    ct.click(v(0, 0));
    ct.click(v(0, 20));
    expect(h.pendingAll).toHaveLength(2);
    ct.resetPending(); // Escape / tool switch
    expect(h.pendingAll, "markers survived an abandoned gesture").toEqual([]);
  });
});
