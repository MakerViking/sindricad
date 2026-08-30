// Which constraints are OFFERED for a selection.
//
// GH #17: "The current constraint bar lacks visibility. Desired workflow: select
// points/lines to constrain, then a small menu showing ONLY the valid/possible
// constraints for that selection, ordered by likelihood of use."
//
// The sharp assertion here is the NEGATIVE one. A rectangle presents four line
// operands and none of its own, so "make these two parallel" has no answer until
// an edge is named. Offering it anyway would apply a constraint to an edge the
// user never chose — geometry silently wrong, with a green result. So an
// ambiguous member disqualifies the whole selection and those keep the
// click-driven tools.

import { describe, it, expect } from "vitest";
import { applicableConstraints, soleOperand, constraintLabel } from "./constraintMenu";
import type { ResolvedEntity } from "./snap";

const line = (id = "l"): ResolvedEntity =>
  ({ type: "line", id, x1: 0, y1: 0, x2: 10, y2: 0 }) as ResolvedEntity;
const circle = (id = "c"): ResolvedEntity =>
  ({ type: "circle", id, x: 0, y: 0, radius: 5 }) as ResolvedEntity;
const arc = (id = "a"): ResolvedEntity =>
  ({ type: "arc", id, x1: 0, y1: 0, x2: 10, y2: 0, mx: 5, my: 5 }) as ResolvedEntity;
const rect = (id = "r"): ResolvedEntity =>
  ({ type: "rectangle", id, x: 0, y: 0, width: 10, height: 5 }) as ResolvedEntity;

describe("operand kinds", () => {
  it("a line is a line and a round is a round", () => {
    expect(soleOperand(line())).toBe("line");
    expect(soleOperand(circle())).toBe("round");
    expect(soleOperand(arc())).toBe("round");
  });
  it("a rectangle has NO sole operand — it has four", () => {
    expect(soleOperand(rect())).toBeNull();
  });
});

describe("what gets offered", () => {
  it("one line: square it to an axis", () => {
    expect(applicableConstraints([line()])).toEqual(["horizontal", "vertical"]);
  });

  it("one circle: nothing — its size is a DIMENSION, not a constraint", () => {
    expect(applicableConstraints([circle()])).toEqual([]);
  });

  it("two lines: the everyday pair first, collinear last", () => {
    const got = applicableConstraints([line("a"), line("b")]);
    expect(got).toEqual(["parallel", "perpendicular", "equal", "collinear"]);
    expect(got.indexOf("parallel")).toBeLessThan(got.indexOf("collinear"));
  });

  it("two rounds: concentric, equal, tangent", () => {
    expect(applicableConstraints([circle("a"), arc("b")])).toEqual(["concentric", "equal", "tangent"]);
  });

  it("a line and a round: tangent, and nothing that makes no sense", () => {
    expect(applicableConstraints([line(), circle()])).toEqual(["tangent"]);
    expect(applicableConstraints([circle(), line()])).toEqual(["tangent"]);
  });

  it("offers NOTHING when any member is ambiguous", () => {
    // THE ONE THAT MATTERS: a rectangle in the selection disqualifies the set
    // rather than having an edge guessed for it.
    expect(applicableConstraints([rect(), line()])).toEqual([]);
    expect(applicableConstraints([line(), rect()])).toEqual([]);
    expect(applicableConstraints([rect()])).toEqual([]);
  });

  it("offers nothing for three or more", () => {
    expect(applicableConstraints([line("a"), line("b"), line("c")])).toEqual([]);
  });
});

describe("labels come from the ribbon, not a second list", () => {
  it("uses the ribbon's own names", () => {
    // Two lists of the same names drift. The split-button tooltips already
    // taught this lesson once, when a hand-written string outlived the tools it
    // described.
    expect(constraintLabel("parallel")).toBe("Parallel");
    expect(constraintLabel("horizontal")).toBe("Horizontal");
    expect(constraintLabel("concentric")).toBe("Concentric");
  });
});
