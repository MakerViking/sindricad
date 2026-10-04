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
import { applicableConstraints, menuOperands, soleOperand, constraintLabel } from "./constraintMenu";
import type { ResolvedEntity } from "./snap";

/** What the menu offers for `sel`, each selected whole unless `keys` names
 *  points (`e@p`) or sides (`e~k`) of them (selection.ts). */
const offered = (sel: ResolvedEntity[], keys: string[] = sel.map((e) => e.id)) =>
  applicableConstraints(menuOperands(keys, new Map(sel.map((e) => [e.id, e]))) ?? []);

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
    expect(offered([line()])).toEqual(["horizontal", "vertical"]);
  });

  it("one circle: nothing — its size is a DIMENSION, not a constraint", () => {
    expect(offered([circle()])).toEqual([]);
  });

  it("two lines: the everyday pair first, collinear last", () => {
    const got = offered([line("a"), line("b")]);
    expect(got).toEqual(["parallel", "perpendicular", "equal", "collinear"]);
    expect(got.indexOf("parallel")).toBeLessThan(got.indexOf("collinear"));
  });

  it("two rounds: concentric, equal, tangent", () => {
    expect(offered([circle("a"), arc("b")])).toEqual(["concentric", "equal", "tangent"]);
  });

  it("a line and a round: tangent, and nothing that makes no sense", () => {
    expect(offered([line(), circle()])).toEqual(["tangent"]);
    expect(offered([circle(), line()])).toEqual(["tangent"]);
  });

  it("offers NOTHING when any member is ambiguous", () => {
    // THE ONE THAT MATTERS: a rectangle in the selection disqualifies the set
    // rather than having an edge guessed for it.
    expect(offered([rect(), line()])).toEqual([]);
    expect(offered([line(), rect()])).toEqual([]);
    expect(offered([rect()])).toEqual([]);
  });

  it("three or more lines, or circles and arcs: Equal, which holds them all to one size", () => {
    // GH #17: "several circles, then Equal: the menu is limited to pairs"
    expect(offered([line("a"), line("b"), line("c")])).toEqual(["equal"]);
    expect(offered([circle("a"), circle("b"), arc("c"), circle("d")])).toEqual(["equal"]);
  });

  it("three of mixed kinds: nothing", () => {
    expect(offered([line("a"), line("b"), circle("c")])).toEqual([]);
  });
});

describe("points and sides picked on their own (GH #17 point-level selection)", () => {
  it("a point and a side of the SAME shape, or two of its corners: nothing, it would fold the shape", () => {
    expect(offered([rect()], ["r@0", "r~1"])).toEqual([]);
    expect(offered([rect()], ["r@0", "r@2"])).toEqual([]);
    expect(offered([line()], ["l@0", "l@1"])).toEqual([]);
  });

  it("two sides of one rectangle: Equal when they meet, nothing when they are opposite", () => {
    expect(offered([rect()], ["r~0", "r~1"])).toEqual(["equal"]);
    expect(offered([rect()], ["r~3", "r~0"])).toEqual(["equal"]);
    expect(offered([rect()], ["r~0", "r~2"])).toEqual([]);
  });

  it("two points and a line of something else: Symmetric; about one of the points' own lines: nothing", () => {
    expect(offered([line("a"), rect(), line("ax")], ["a@1", "r@0", "ax"])).toEqual(["symmetric"]);
    expect(offered([line("a"), rect()], ["a@1", "r@0", "r~1"])).toEqual([]);
  });

  it("a projected point alone is fixed already: no Fix", () => {
    const pr = { type: "projected", id: "p", source: {}, curve: { kind: "line", x1: 0, y1: 0, x2: 5, y2: 0 } } as unknown as ResolvedEntity;
    expect(offered([pr], ["p@0"])).toEqual([]);
    expect(offered([line()], ["l@0"])).toEqual(["fix"]);
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
