// The WORDING of a refused dimension edit, and the withdraw that puts the
// sketch back. Reported 2026-09-05 (886da4e5): editing the diameter of a circle
// that cannot change size turned every curve red and said nothing.
//
// Pure, so it covers the sentence itself rather than "a handler ran". The
// end-to-end effect (the sketch actually solving clean again afterwards) is in
// dimEditConflict.test.ts, against the real solver.
import { describe, it, expect } from "vitest";
import { CONSTRAINT_NAMES, dimConflictMsg, withdrawTrial, type SketchTrial } from "./dimConflict";
import { getUnit, setUnit } from "../ui/units";
import type { SketchConstraint } from "../types";

/** The reporter's constraint list as the solver saw it: the rectangle's three
 *  corner fixes, the two tangencies from the circle to that fixed rectangle,
 *  the Fix the user then put on the circle's centre, and the diameter being
 *  edited (last, as setDrivingDimension leaves it). */
function reporterList(): SketchConstraint[] {
  return [
    { type: "p2pDistance", e1: "e11", p1: 3, e2: "e11", p2: 0, value: 50, driven: true },
    { type: "p2pDistance", e1: "e11", p1: 0, e2: "e11", p2: 1, value: 100, driven: true },
    { type: "equal", l1: "e11~3", l2: "e11~0" },
    { type: "fix", e: "e18", p: 3 },
    { type: "fix", e: "e18", p: 0 },
    { type: "fix", e: "e18", p: 1 },
    { type: "tangent2", a: "e17", b: "e18~0" },
    { type: "tangent2", a: "e17", b: "e18~3" },
    { type: "fix", e: "e17", p: 0 },
    { type: "diameter", circle: "e17", value: 40 },
  ] as SketchConstraint[];
}

describe("dimConflictMsg", () => {
  it("names the fixed centre and the tangents the solver blamed", () => {
    const cons = reporterList();
    const edited = cons[9]!;
    // exactly what the solver blames on this sketch: the two tangencies and the
    // diameter itself. It does NOT blame the Fix the user just added.
    const msg = dimConflictMsg(edited, new Set([6, 7, 9]), cons, 30);
    expect(msg).toContain("its centre is fixed");
    expect(msg).toContain("2 Tangent constraints");
    expect(msg).toContain("The dimension was left at 30 mm.");
    // the dimension being edited is not a reason for its own refusal
    expect(msg).not.toContain("Diameter constraint");
    // first person, and no "we"/"team" (copy voice)
    expect(msg.startsWith("I could not change this diameter")).toBe(true);
    expect(msg).not.toMatch(/\bwe\b/i);
  });

  it("says nothing about a fixed centre when there is no Fix on the circle", () => {
    const cons = reporterList().filter((c) => !(c.type === "fix" && c.e === "e17"));
    const edited = cons[cons.length - 1]!;
    const msg = dimConflictMsg(edited, new Set([6, 7]), cons, 30);
    expect(msg).not.toContain("fixed");
    expect(msg).toContain("it is held by 2 Tangent constraints");
  });

  it("uses the singular for a single blamed constraint", () => {
    const cons = reporterList();
    const msg = dimConflictMsg(cons[9]!, new Set([6]), cons, 30);
    expect(msg).toContain("a Tangent constraint");
    expect(msg).not.toContain("1 Tangent");
  });

  it("still says what happened when every conflict id was implicit", () => {
    // parseConflictIdx drops rect-edge ids like "e18~h0", so the blamed set can
    // come back empty on a sketch that genuinely conflicts.
    const cons = reporterList().filter((c) => !(c.type === "fix" && c.e === "e17"));
    const msg = dimConflictMsg(cons[cons.length - 1]!, new Set(), cons, 30);
    expect(msg).toContain("conflicts with the constraints already on this sketch");
    expect(msg).toContain("The dimension was left at 30 mm.");
  });

  it("names the edited dimension by kind, not always 'diameter'", () => {
    const cons: SketchConstraint[] = [
      { type: "horizontal", line: "L1" },
      { type: "distance", line: "L1", value: 40 },
    ] as SketchConstraint[];
    const msg = dimConflictMsg(cons[1]!, new Set([0]), cons, 25);
    expect(msg).toContain("I could not change this length");
    expect(msg).toContain("a Horizontal constraint");
  });

  it("says 'one of its points is fixed' for a dimension that is not a size", () => {
    const cons: SketchConstraint[] = [
      { type: "fix", e: "L1", p: 0 },
      { type: "p2pDistance", e1: "L1", p1: 0, e2: "L2", p2: 1, value: 40 },
    ] as SketchConstraint[];
    const msg = dimConflictMsg(cons[1]!, new Set([0]), cons);
    expect(msg).toContain("one of its points is fixed");
    // no previous value passed: no dangling "left at" clause
    expect(msg).not.toContain("left at");
  });

  it("says ADD, not change, when there was no dimension there to replace", () => {
    // the same seam places a brand-new dimension; "I could not change this
    // distance" would be a lie about that case
    const cons: SketchConstraint[] = [
      { type: "fix", e: "L1", p: 0 },
      { type: "p2pDistance", e1: "L1", p1: 0, e2: "L2", p2: 1, value: 40 },
    ] as SketchConstraint[];
    expect(dimConflictMsg(cons[1]!, new Set([0]), cons)).toContain("I could not add this distance");
    expect(dimConflictMsg(cons[1]!, new Set([0]), cons, 25)).toContain("I could not change this distance");
  });

  it("leaves an ANGLE at degrees, not millimetres", () => {
    // types.ts: an angle constraint stores DEGREES, every other dimension mm.
    // Re-dimensioning a pair that already carries an angle dim populates the
    // previous value from that degrees field (sketchMode's sameTarget has an
    // explicit angle branch), so a length format here reports 30° as "30 mm".
    const cons: SketchConstraint[] = [
      { type: "perpendicular", l1: "L1", l2: "L2" },
      { type: "angle", l1: "L1", l2: "L2", value: 45 },
    ] as SketchConstraint[];
    const msg = dimConflictMsg(cons[1]!, new Set([0]), cons, 30);
    expect(msg).toContain("The dimension was left at 30°.");
    expect(msg).not.toContain("mm");
  });

  it("does not convert an angle's previous value when the display unit is inches", () => {
    const cons: SketchConstraint[] = [
      { type: "perpendicular", l1: "L1", l2: "L2" },
      { type: "angle", l1: "L1", l2: "L2", value: 45 },
    ] as SketchConstraint[];
    const before = getUnit();
    try {
      setUnit("in");
      // a length dim DOES convert: that is the control for the angle assertion
      expect(dimConflictMsg({ type: "distance", line: "L1", value: 40 } as SketchConstraint, new Set(), [], 25.4))
        .toContain("left at 1 in.");
      const msg = dimConflictMsg(cons[1]!, new Set([0]), cons, 30);
      expect(msg).toContain("The dimension was left at 30°.");
      expect(msg).not.toContain(" in.");
    } finally {
      setUnit(before);
    }
  });

  // COVERAGE RATCHET: the Record<> typing already fails the build if a constraint
  // type joins the union without a name, so this only guards against a name that
  // is present but useless.
  it("has a usable human name for every constraint type", () => {
    for (const [type, name] of Object.entries(CONSTRAINT_NAMES)) {
      expect(name.length, `${type} has no name`).toBeGreaterThan(0);
      expect(name, `${type}'s name is still the raw type`).not.toBe(type);
      expect(name[0], `${type}'s name should read as a label`).toBe(name[0]!.toUpperCase());
    }
  });
});

describe("withdrawTrial", () => {
  const A = { type: "horizontal", line: "L1" } as SketchConstraint;
  const B = { type: "vertical", line: "L2" } as SketchConstraint;
  const C = { type: "parallel", l1: "L1", l2: "L3" } as SketchConstraint;

  it("splices out the trial constraints when there is nothing to restore", () => {
    const current = [A, B, C];
    const { constraints } = withdrawTrial(current, { cons: [C], msg: "no" }, new Set());
    expect(constraints).toEqual([A, B]);
    expect(current, "must not mutate the list it was handed").toEqual([A, B, C]);
  });

  it("puts back the whole pre-edit list when the trial carries one", () => {
    // the dimension case: the edit DROPPED the dim it replaced, so splicing out
    // only the new one would leave the entity with no dimension at all
    const before = [A, { type: "diameter", circle: "e17", value: 30 } as SketchConstraint];
    const newDim = { type: "diameter", circle: "e17", value: 40 } as SketchConstraint;
    const current = [A, newDim];
    const trial: SketchTrial = { cons: [newDim], msg: "no", restore: before };
    const { constraints } = withdrawTrial(current, trial, new Set());
    expect(constraints).toBe(before);
    expect(constraints.find((c) => c.type === "diameter")).toMatchObject({ value: 30 });
  });

  it("resolves a message function against the list that was solved", () => {
    const current = [A, B, C];
    const seen: { blamed: Set<number>; cons: SketchConstraint[] }[] = [];
    const { msg } = withdrawTrial(
      current,
      { cons: [C], msg: (blamed, cons) => { seen.push({ blamed, cons }); return `blamed ${[...blamed].join(",")}`; } },
      new Set([0, 1]),
    );
    expect(msg).toBe("blamed 0,1");
    expect(seen[0]!.cons).toBe(current);
  });
});
