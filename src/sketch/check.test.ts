// Unit tests for the sketch geometry checker (src/sketch/check.ts).
//
// The feature exists because a broken profile currently says nothing: the
// extrude just finds no closed region. That makes the FALSE POSITIVE the
// failure mode worth guarding hardest, because a panel that flags a correct
// sketch is worse than the silence it replaces. The "raises nothing" cases
// below are as load-bearing as the ones that find a defect.
//
// AND THAT IS WHY THE ORACLE BLOCK AT THE BOTTOM EXISTS. Two critical false
// positives (T-junctions read as free ends; a shared boundary edge read as an
// overlap error) shipped with every test here green, because every "raises
// nothing" case asserted against a HAND-WRITTEN expectation. Hand-written
// expectations only ever encode what the author already believed. checkSketch
// claims to be a second opinion on detectRegions, so detectRegions is the only
// honest oracle: if it traces a region, no row may be an error. Add a fixture
// there for any sketch shape a user reports, before touching the code.
import { describe, it, expect } from "vitest";
import { checkSketch } from "./check";
import type { SketchIssue } from "./check";
import { circleLoop, detectRegions } from "./region";
import type { ResolvedEntity } from "./snap";

const line = (id: string, x1: number, y1: number, x2: number, y2: number, construction?: true): ResolvedEntity =>
  construction ? { type: "line", id, x1, y1, x2, y2, construction } : { type: "line", id, x1, y1, x2, y2 };
const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity =>
  ({ type: "rectangle", id, x, y, width, height });
const circle = (id: string, x: number, y: number, radius: number): ResolvedEntity =>
  ({ type: "circle", id, x, y, radius });
const spline = (id: string, points: [number, number][]): ResolvedEntity =>
  ({ type: "spline", id, points: points.map(([x, y]) => ({ x, y })) });

/** three sides of a 10x10 square, drawn as separate lines. The fourth side is
 *  the variable under test: where its far end stops decides whether the profile
 *  closes. */
const threeSides = (): ResolvedEntity[] => [
  line("l1", 0, 0, 10, 0),
  line("l2", 10, 0, 10, 10),
  line("l3", 10, 10, 0, 10),
];
const kinds = (issues: SketchIssue[]) => issues.map((i) => i.kind);

describe("checkSketch — open ends", () => {
  it("a corner drawn 0.4 mm short is one error, and the measured gap is 0.4 mm", () => {
    // The reported symptom: it looks shut at any sane zoom and the extrude
    // still finds nothing.
    const issues = checkSketch([...threeSides(), line("l4", 0, 10, 0, 0.4)]);
    expect(issues).toHaveLength(1);
    const [only] = issues;
    expect(only!.kind).toBe("open");
    expect(only!.severity).toBe("error");
    expect(only!.measuredMm).toBeCloseTo(0.4, 9);
    // the NUMBER lives in measuredMm and nowhere else. The panel renders that
    // through the user's display unit, so a "0.4 mm" baked into the sentence
    // would read "0.4 mm apart" beside a chip saying "0.016 in".
    expect(only!.message).not.toMatch(/\d|\bmm\b/);
    // one row for the gap, naming BOTH dangling curves and pointing at the
    // middle of it rather than at either end
    expect([...only!.entityIds].sort()).toEqual(["l1", "l4"]);
    expect(only!.at.x).toBeCloseTo(0, 9);
    expect(only!.at.y).toBeCloseTo(0.2, 9);
  });

  it("the same gap at 8 mm is information, because a deliberately open chain is legitimate", () => {
    const issues = checkSketch([...threeSides(), line("l4", 0, 10, 0, 8)]);
    expect(kinds(issues)).toEqual(["open", "open"]);
    expect(issues.map((i) => i.severity)).toEqual(["info", "info"]);
    // nothing was measured, because nothing was found within the 1 mm the
    // checker searches — an info row that invented a distance would be a guess
    expect(issues.every((i) => i.measuredMm === undefined)).toBe(true);
  });

  it("a loop that really is closed raises nothing at all", () => {
    expect(checkSketch([...threeSides(), line("l4", 0, 10, 0, 0)])).toEqual([]);
  });

  it("a plate with a hole raises nothing: closed primitives have no free ends", () => {
    expect(checkSketch([rect("plate", 0, 0, 100, 60), circle("hole", 20, 10, 5)])).toEqual([]);
  });
});

describe("checkSketch — overlaps", () => {
  it("a line drawn twice on the same spot is an error naming both copies", () => {
    const issues = checkSketch([line("a", 0, 0, 10, 0), line("b", 0, 0, 10, 0)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("overlap");
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.entityIds).toEqual(["a", "b"]);
  });

  it("a duplicate drawn end-for-end is still the same curve", () => {
    const issues = checkSketch([line("a", 0, 0, 10, 0), line("b", 10, 0, 0, 0)]);
    expect(kinds(issues)).toEqual(["overlap"]);
  });

  it("two collinear lines that share a 5 mm stretch measure that stretch, as information", () => {
    // NOT an error. traceLoops keeps one undirected edge per coincident segment
    // (region.ts:668-679), so a shared run is traced correctly — see the rib/
    // plate fixture in the oracle block. This assertion USED to demand "error",
    // which is exactly the belief that let the false positive ship.
    const issues = checkSketch([line("a", 0, 0, 10, 0), line("b", 5, 0, 15, 0)]);
    const [ov, ...rest] = issues.filter((i) => i.kind === "overlap");
    expect(rest).toHaveLength(0);
    expect(ov!.severity).toBe("info");
    expect(ov!.measuredMm).toBeCloseTo(5, 9);
    expect(ov!.at.x).toBeCloseTo(7.5, 9); // the middle of the shared run
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("collinear lines laid END TO END share only a point, which is a polyline, not a defect", () => {
    const issues = checkSketch([line("a", 0, 0, 10, 0), line("b", 10, 0, 20, 0)]);
    expect(issues.filter((i) => i.kind === "overlap")).toEqual([]);
    // the chain's own two far ends are still open, but nothing here is an error
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("a T-junction is not an overlap, and the end sitting on the other curve is not free", () => {
    // pointOnSegInterior fires once here and the overlap rule needs two hits.
    // Region tracing splits at a T on purpose (region.ts:567-571), so b's start
    // is a JOIN, not a dangling end — this test used to filter to
    // kind === "overlap" and silently tolerate the bogus "open" rows underneath.
    const issues = checkSketch([line("a", 0, 0, 10, 0), line("b", 5, 0, 5, 8)]);
    expect(issues.filter((i) => i.kind === "overlap")).toEqual([]);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    // three genuinely loose ends remain: a's two, and b's far end. b's start at
    // (5, 0) is NOT among them.
    expect(issues.map((i) => `${i.kind}@${i.at.x},${i.at.y}`)).toEqual([
      "open@0,0", "open@10,0", "open@5,8",
    ]);
  });

  it("two T-junction ends within the 1 mm gap radius are not an error either", () => {
    // The reported critical: two dividers dropped onto a plate's edge 0.5 mm
    // apart both read as degree 1, so they paired up and raised an ERROR on a
    // sketch that traces perfectly.
    const issues = checkSketch([
      rect("plate", 0, 0, 40, 20),
      line("d1", 0, -10, 0, 10),
      line("d2", 0.5, -10, 0.5, 10),
    ]);
    expect(issues.filter((i) => i.kind === "open")).toEqual([]);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("an end landing on a CLOSED primitive is joined, not free", () => {
    // Closed curves used to be skipped entirely when the degree map was built,
    // so they contributed no node at all and anything touching one dangled.
    const onCircle = checkSketch([circle("c", 0, 0, 10), line("spoke", 0, 0, 10, 0)]);
    expect(onCircle.filter((i) => i.at.x === 10 && i.at.y === 0)).toEqual([]);
    // the rectangle CORNER case: a vertex match rather than a segment interior
    const onCorner = checkSketch([rect("r", 0, 0, 20, 20), line("tail", 10, 10, 20, 20)]);
    expect(onCorner.filter((i) => i.at.x === 10 && i.at.y === 10)).toEqual([]);
  });
});

describe("checkSketch — tiny segments", () => {
  it("a 1e-5 mm line is an error, and it is not also reported as an open chain", () => {
    const issues = checkSketch([line("t", 0, 0, 1e-5, 0)]);
    expect(kinds(issues)).toEqual(["tiny"]);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.measuredMm).toBeCloseTo(1e-5, 12);
    expect(issues[0]!.at.x).toBeCloseTo(5e-6, 12);
  });

  it.each([1e-5, 5e-5, 1.5e-4, 3e-4, 9e-4])(
    "a %d mm line is ONE defect, not [open, tiny]",
    (len) => {
      // Whether a sub-threshold segment ALSO looked open depended purely on
      // which 1e-4 grid cells its two ends rounded into, not on its length:
      // 1e-5 keyed both ends to one node and reported [tiny], while 5e-5,
      // 1.5e-4, 3e-4 and 9e-4 straddled a cell boundary and reported
      // [open, tiny] — two rows, two different accounts, one defect.
      expect(kinds(checkSketch([line("t", 0, 0, len, 0)]))).toEqual(["tiny"]);
    },
  );

  it("a 2 mm line is not tiny", () => {
    expect(checkSketch([line("s", 0, 0, 2, 0)]).filter((i) => i.kind === "tiny")).toEqual([]);
  });
});

describe("checkSketch — self crossings", () => {
  it("a figure-eight spline crosses itself", () => {
    // fit points that send the curve up-right, back left, then down-right: the
    // first leg and the last leg must meet somewhere near the middle
    const issues = checkSketch([spline("s", [[0, 0], [10, 10], [0, 10], [10, 0]])]);
    const self = issues.filter((i) => i.kind === "selfCross");
    expect(self).toHaveLength(1);
    expect(self[0]!.severity).toBe("error");
    expect(self[0]!.entityIds).toEqual(["s"]);
    // where exactly the knot lands is the Catmull-Rom sampling's business
    // (measured (5, 4.4376) at the current 16 segments per span), so this
    // asserts only that the row points into the middle of it, not at an end
    for (const c of [self[0]!.at.x, self[0]!.at.y]) {
      expect(c).toBeGreaterThan(3);
      expect(c).toBeLessThan(7);
    }
  });

  it("a spline that does not double back raises no error", () => {
    const issues = checkSketch([spline("s", [[0, 0], [5, 4], [10, 0], [15, 4]])]);
    expect(issues.filter((i) => i.kind === "selfCross")).toEqual([]);
    // its two ends are open, and being open is information, not a defect
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });
});

describe("checkSketch — crossings between different entities", () => {
  it("two genuinely overlapping circles are INFORMATION, because the split is intended", () => {
    // region.ts:175-186 planarizes crossing curves into separately selectable
    // sub-regions on purpose. Calling shipped, intended behaviour an error
    // would be a lie, so this must never come back "error".
    const issues = checkSketch([circle("c1", 0, 0, 10), circle("c2", 12, 0, 10)]);
    expect(kinds(issues)).toEqual(["cross"]);
    expect(issues[0]!.severity).toBe("info");
    expect(issues[0]!.entityIds).toEqual(["c1", "c2"]);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("a line laid across a square is ONE crossing row, not one per crossing point", () => {
    // The line enters and leaves, so it crosses the rectangle's outline twice.
    // That is a single fact about the pair, and two rows saying it would be
    // noise. The line's own two ends stick out past the square, so they are
    // reported as the free ends they are.
    const issues = checkSketch([rect("sq", 0, 0, 100, 100), line("cut", -60, 0, 60, 0)]);
    expect(kinds(issues)).toEqual(["open", "open", "cross"]);
    expect(issues.every((i) => i.severity === "info")).toBe(true);
  });

  it("curves that merely touch at a shared endpoint do not cross", () => {
    expect(checkSketch([line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 10)])
      .filter((i) => i.kind === "cross")).toEqual([]);
  });
});

describe("checkSketch — construction geometry", () => {
  it("a construction line on top of a real one is invisible to the checker", () => {
    // Without the filter this pair is an exact duplicate, i.e. an error. A
    // construction line is reference-only and never forms a profile
    // (region.ts:165), so it cannot be the reason one failed to close.
    const withRef = checkSketch([line("real", 0, 0, 10, 0), line("ref", 0, 0, 10, 0, true)]);
    expect(withRef.filter((i) => i.kind === "overlap")).toEqual([]);
    // and the report is the same one the real line gets on its own
    expect(withRef).toEqual(checkSketch([line("real", 0, 0, 10, 0)]));
  });
});

describe("checkSketch — ordering", () => {
  it("errors come first, then kinds in open / overlap / tiny / selfCross / cross order", () => {
    // four independent defects, placed far enough apart that no two interact,
    // and deliberately listed in the sketch in the WRONG order
    const issues = checkSketch([
      circle("c1", 300, 0, 10),           // cross, info
      circle("c2", 312, 0, 10),
      line("t", 200, 0, 200.00001, 0),    // tiny, error
      line("d1", 100, 0, 110, 0),         // overlap, error
      line("d2", 100, 0, 110, 0),
      ...threeSides(),                    // open, error
      line("l4", 0, 10, 0, 0.4),
    ]);
    expect(kinds(issues)).toEqual(["open", "overlap", "tiny", "cross"]);
    expect(issues.map((i) => i.severity)).toEqual(["error", "error", "error", "info"]);
  });
});

// --- the oracle ---------------------------------------------------------
//
// checkSketch exists to give a NAME to the reason detectRegions came back
// empty. So the contract is exactly one sentence, and it is mechanical:
//
//     if detectRegions traces a region, checkSketch raises no error.
//
// Every fixture below is a sketch that traces. Anything the checker calls an
// error here is a lie about geometry the user can already see shaded on
// screen. This is the guard the two shipped criticals needed; the hand-written
// "raises nothing" cases above could not catch them, because they asserted the
// author's belief rather than the tracer's behaviour.

/** a 20x10 outline with a 0.8 mm wide, 2 mm deep notch in the top edge, drawn
 *  as eight lines with exactly coincident corners. The notch's two walls are
 *  0.8 mm apart, i.e. INSIDE the 1 mm radius the open-end check searches. */
const notchedPlate = (): ResolvedEntity[] => {
  const pts: [number, number][] = [
    [0, 0], [20, 0], [20, 10], [12.4, 10], [12.4, 8], [11.6, 8], [11.6, 10], [0, 10], [0, 0],
  ];
  return pts.slice(0, -1).map((p, i) => {
    const q = pts[i + 1]!;
    return line(`n${i}`, p[0], p[1], q[0], q[1]);
  });
};

const tracesCleanly: { name: string; ents: ResolvedEntity[] }[] = [
  {
    name: "a square split by two internal dividers (four T-junctions)",
    ents: [
      rect("sq", 0, 0, 100, 100),
      line("d1", -50, -20, 50, -20),
      line("d2", -50, 20, 50, 20),
    ],
  },
  {
    // The T-junction critical only became an ERROR when two bogus free ends
    // landed within OPEN_GAP_MM of each other, so a fixture whose T's are far
    // apart passes even with the junction test disabled. This one bites.
    name: "a plate crossed by two dividers half a millimetre apart",
    ents: [
      rect("plate", 0, 0, 40, 20),
      line("d1", 0, -10, 0, 10),
      line("d2", 0.5, -10, 0.5, 10),
    ],
  },
  {
    // and the same trap against a CLOSED curve: two spokes landing on adjacent
    // sampled vertices of a 5 mm circle are 0.49 mm apart
    name: "two spokes landing on adjacent vertices of a circle",
    ents: (() => {
      const [v0, v1] = circleLoop(0, 0, 5);
      return [
        circle("hub", 0, 0, 5),
        line("s1", 30, -10, v0!.x, v0!.y),
        line("s2", 30, 10, v1!.x, v1!.y),
      ];
    })(),
  },
  {
    name: "a rib rectangle sharing part of one edge with a plate",
    ents: [rect("plate", 50, 5, 100, 10), rect("rib", 30, 20, 20, 20)],
  },
  {
    name: "a boss on a plate",
    ents: [rect("plate", 0, 0, 100, 60), circle("boss", 0, 0, 10)],
  },
  {
    name: "a line running along part of a rectangle's edge",
    ents: [rect("sq", 0, 0, 100, 100), line("l", -30, -50, 30, -50)],
  },
  {
    name: "a rectangle with a 0.8 mm notch that still traces",
    ents: notchedPlate(),
  },
  {
    name: "a closed loop of four lines with exactly coincident corners",
    ents: [...threeSides(), line("l4", 0, 10, 0, 0)],
  },
  {
    name: "a hexagon corner sitting on a boundary rectangle's edge",
    ents: [
      rect("bound", 0, 0, 100, 100),
      { type: "polygon", id: "hex", x: 0, y: -40, radius: 10, sides: 6, angle: 90 },
    ],
  },
  {
    name: "two crossing lines inside a square (the classic X-in-a-box)",
    ents: [
      rect("sq", 0, 0, 100, 100),
      line("a", -50, -50, 50, 50),
      line("b", -50, 50, 50, -50),
    ],
  },
];

describe("checkSketch — detectRegions is the oracle", () => {
  it.each(tracesCleanly)("$name traces, so nothing may be an error", ({ ents }) => {
    // guard the guard: a fixture that stopped tracing would make the assertion
    // below vacuously true, which is how a dead test looks from the outside
    expect(detectRegions("s", ents).length).toBeGreaterThanOrEqual(1);
    const errors = checkSketch(ents).filter((i) => i.severity === "error");
    // mapped to strings so a failure prints WHAT was wrongly flagged
    expect(errors.map((e) => `${e.kind}: ${e.message}`)).toEqual([]);
  });
});

describe("checkSketch — message copy", () => {
  it("no message states a length: measuredMm is the only number", () => {
    // The panel renders measuredMm through the user's display unit
    // (checkPanel.formatMeasurement), so prose carrying its own "0.4 mm" would
    // sit beside a chip reading "0.016 in" and contradict it.
    const everyKind = checkSketch([
      ...threeSides(), line("l4", 0, 10, 0, 0.4),   // open, error
      line("t", 200, 0, 200.00005, 0),              // tiny
      line("d1", 100, 0, 110, 0),                   // overlap, exact duplicate
      line("d2", 100, 0, 110, 0),
      line("o1", 400, 0, 410, 0),                   // overlap, partial run
      line("o2", 405, 0, 415, 0),
      spline("fig8", [[0, 500], [10, 510], [0, 510], [10, 500]]), // selfCross
      circle("c1", 300, 0, 10), circle("c2", 312, 0, 10),         // cross
    ]);
    expect(new Set(kinds(everyKind))).toEqual(
      new Set(["open", "overlap", "tiny", "selfCross", "cross"]),
    );
    for (const i of everyKind) expect(i.message).not.toMatch(/\d|\bmm\b|\binch/);
  });
});

describe("checkSketch — pathological input", () => {
  it("the list is capped, with one row saying how many were left off", () => {
    // 200 mutually overlapping circles produced 20,431 rows, which no panel can
    // render and no user can read.
    const circles = Array.from({ length: 200 }, (_, i) => circle(`c${i}`, i * 0.05, 0, 10));
    const issues = checkSketch(circles);
    expect(issues).toHaveLength(201);
    const last = issues[200]!;
    expect(last.kind).toBe("more");
    expect(last.severity).toBe("info");
    expect(last.message).toMatch(/further findings are not listed/);
    // the cap is applied after the sort, so nothing serious is dropped in
    // favour of a note
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("a long spline is checked for self-crossings without a quadratic sweep", () => {
    // 1000 fit points is 15,985 segments, i.e. 127 million naive pairs (measured
    // 554 ms). The bbox grid must find the SAME single knot, not fewer.
    const pts: [number, number][] = Array.from({ length: 1000 }, (_, i) => [i * 0.5, Math.sin(i / 7) * 20]);
    const clean = checkSketch([spline("long", pts)]);
    expect(clean.filter((i) => i.kind === "selfCross")).toEqual([]);
    // and the knot is still found once the curve doubles back
    const knotted = checkSketch([spline("s", [[0, 0], [10, 10], [0, 10], [10, 0]])]);
    expect(knotted.filter((i) => i.kind === "selfCross")).toHaveLength(1);
  });
});
