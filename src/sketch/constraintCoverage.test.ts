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
