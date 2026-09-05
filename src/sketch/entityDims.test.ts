import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  constraintDims, dimensionSegments, entityDims, lineOperand, lineRimPoints,
  staggeredDefaults,
  pointRimPoints, rimGap, rimGapPoints, rimNesting,
} from "./entityDims";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { isPlacedDim } from "../types";

describe("entityDims", () => {
  it("gives width + height for a rectangle, writable in place", () => {
    const e: ResolvedEntity = { type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0 };
    const dims = entityDims(e);
    expect(dims.map((d) => d.field)).toEqual(["width", "height"]);
    expect(dims[0]!.valueMm).toBe(20);
    expect(dims[1]!.valueMm).toBe(10);
    dims[0]!.write(30);
    expect(e.width).toBe(30);
  });
  it("gives diameter for a circle and writes back the radius", () => {
    const e: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0 };
    const [d] = entityDims(e);
    expect(d!.field).toBe("diameter");
    expect(d!.valueMm).toBe(10);
    d!.write(8);
    expect(e.radius).toBe(4);
  });
  it("gives length for a line and rescales the endpoint on write", () => {
    const e: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 3, y2: 4 };
    const [d] = entityDims(e);
    expect(d!.field).toBe("length");
    expect(d!.valueMm).toBeCloseTo(5);
    d!.write(10);
    expect(e.x2).toBeCloseTo(6);
    expect(e.y2).toBeCloseTo(8);
  });
  it("has no editable dimensions for arc/spline/point", () => {
    expect(entityDims({ type: "arc", id: "a", x1: 0, y1: 0, x2: 4, y2: 0, mx: 2, my: 2 })).toEqual([]);
    expect(entityDims({ type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toEqual([]);
    expect(entityDims({ type: "point", id: "p", x: 1, y: 1 })).toEqual([]);
  });
});

describe("dimensionSegments", () => {
  it("collects annotation segments and skips construction geometry", () => {
    const real: ResolvedEntity = { type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0 };
    const constr: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0, construction: true };
    const segs = dimensionSegments([real, constr]);
    expect(segs.length).toBeGreaterThan(0);
    // construction circle contributes nothing
    expect(dimensionSegments([constr])).toEqual([]);
  });
});

describe("constraintDims (radius + angle driving dims)", () => {
  it("renders a radius dim for a circle with a radial line", () => {
    const circle: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0 };
    const cons: SketchConstraint[] = [{ type: "radius", e: "c", value: 5 }];
    const dims = constraintDims([circle], cons);
    expect(dims.length).toBe(1);
    expect(dims[0]!.cIndex).toBe(0);
    expect(dims[0]!.valueMm).toBe(5);
    expect(dims[0]!.lines.length).toBe(1); // one radial line center→rim
    expect(dims[0]!.kind).toBeUndefined(); // radius is a length
  });

  it("renders a radius dim for an arc (via circumcenter)", () => {
    const arc: ResolvedEntity = { type: "arc", id: "a", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 };
    const cons: SketchConstraint[] = [{ type: "radius", e: "a", value: 5 }];
    const dims = constraintDims([arc], cons);
    expect(dims.length).toBe(1);
    expect(dims[0]!.valueMm).toBe(5);
  });

  it("renders an angle dim tagged kind='angle' with the value in degrees", () => {
    const l1: ResolvedEntity = { type: "line", id: "a", x1: 0, y1: 0, x2: 10, y2: 0 };
    const l2: ResolvedEntity = { type: "line", id: "b", x1: 0, y1: 0, x2: 0, y2: 10 };
    const cons: SketchConstraint[] = [{ type: "angle", l1: "a", l2: "b", value: 90 }];
    const dims = constraintDims([l1, l2], cons);
    expect(dims.length).toBe(1);
    expect(dims[0]!.kind).toBe("angle");
    expect(dims[0]!.valueMm).toBe(90);
  });

  it("skips a radius dim whose entity is missing", () => {
    const cons: SketchConstraint[] = [{ type: "radius", e: "gone", value: 3 }];
    expect(constraintDims([], cons)).toEqual([]);
  });

  it("driving p2pDistance shows the stored value; driven shows the measured value", () => {
    const l: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 };
    const driving = constraintDims([l], [{ type: "p2pDistance", e1: "l", p1: 0, e2: "l", p2: 1, value: 7 }]);
    expect(driving[0]!.driven).toBeFalsy();
    expect(driving[0]!.valueMm).toBe(7); // stored driving value

    const driven = constraintDims([l], [{ type: "p2pDistance", e1: "l", p1: 0, e2: "l", p2: 1, value: 999, driven: true }]);
    expect(driven[0]!.driven).toBe(true);
    expect(driven[0]!.valueMm).toBeCloseTo(10); // live measurement, not the stale 999
  });

  it("driven radius reports the measured radius", () => {
    const c: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0 };
    const dims = constraintDims([c], [{ type: "radius", e: "c", value: 99, driven: true }]);
    expect(dims[0]!.driven).toBe(true);
    expect(dims[0]!.valueMm).toBeCloseTo(5);
  });
});

// The smart-dimension horizontal/vertical distances (GH #17) are created by the
// dimension tool and solved, but constraintDims had no branch for them: they
// fell through its final `else return`, so a DX/DY dimension rendered NO badge
// at all — invisible, uneditable and undeletable from the moment it was placed.
describe("constraintDims: the horizontal/vertical (DX/DY) distances", () => {
  const a: ResolvedEntity = { type: "line", id: "a", x1: 0, y1: 0, x2: 0, y2: 0 };
  const b: ResolvedEntity = { type: "line", id: "b", x1: 30, y1: 20, x2: 30, y2: 20 };
  const ents = [a, b];

  it("renders a badge for p2pDistanceX, anchored on the X gap not the diagonal", () => {
    const dims = constraintDims(ents, [{ type: "p2pDistanceX", e1: "a", p1: 0, e2: "b", p2: 0, value: 30 }]);
    expect(dims).toHaveLength(1);
    expect(dims[0]!.cIndex).toBe(0);
    expect(dims[0]!.valueMm).toBe(30);
    // the dimension line spans the X gap at one Y — a diagonal one would be the
    // p2pDistance layout, showing a slanted annotation labelled with a
    // horizontal number
    const dimLine = dims[0]!.lines[2]!;
    expect(dimLine[0].y).toBeCloseTo(dimLine[1].y, 6);
    expect(Math.abs(dimLine[1].x - dimLine[0].x)).toBeCloseTo(30, 6);
    expect(dims[0]!.labelPos.x).toBeCloseTo(15, 6);
  });

  it("renders a badge for p2pDistanceY, anchored on the Y gap", () => {
    const dims = constraintDims(ents, [{ type: "p2pDistanceY", e1: "a", p1: 0, e2: "b", p2: 0, value: 20 }]);
    expect(dims).toHaveLength(1);
    expect(dims[0]!.valueMm).toBe(20);
    const dimLine = dims[0]!.lines[2]!;
    expect(dimLine[0].x).toBeCloseTo(dimLine[1].x, 6);
    expect(Math.abs(dimLine[1].y - dimLine[0].y)).toBeCloseTo(20, 6);
    expect(dims[0]!.labelPos.y).toBeCloseTo(10, 6);
  });

  it("keeps the SIGN — a leftward DX reads negative, never absolutised", () => {
    const driving = constraintDims(ents, [{ type: "p2pDistanceX", e1: "b", p1: 0, e2: "a", p2: 0, value: -30 }]);
    expect(driving[0]!.valueMm).toBe(-30);
    const driven = constraintDims(ents, [
      { type: "p2pDistanceX", e1: "b", p1: 0, e2: "a", p2: 0, value: 999, driven: true },
    ]);
    expect(driven[0]!.driven).toBe(true);
    expect(driven[0]!.valueMm).toBeCloseTo(-30, 6); // measured e2 - e1 along X
  });

  // The sign has to travel to the BADGE, not just to the readout: the label
  // editor gates a typed value on it (a length must be positive, a signed
  // distance may be either way round), so without this flag the badge shows
  // "-30" and then rejects "-30" when the user types it back.
  it("marks the badge SIGNED, so the editor accepts the value it shows", () => {
    const dims = constraintDims(ents, [{ type: "p2pDistanceX", e1: "b", p1: 0, e2: "a", p2: 0, value: -30 }]);
    expect(dims[0]!.signed).toBe(true);
    const y = constraintDims(ents, [{ type: "p2pDistanceY", e1: "b", p1: 0, e2: "a", p2: 0, value: -20 }]);
    expect(y[0]!.signed).toBe(true);
  });

  it("an ALIGNED distance is a magnitude and is not signed", () => {
    const dims = constraintDims(ents, [{ type: "p2pDistance", e1: "a", p1: 0, e2: "b", p2: 0, value: 36 }]);
    expect(dims[0]!.signed).toBeFalsy();
  });

  it("is placeable and draggable like every other placed dim", () => {    const dims = constraintDims(ents, [
      { type: "p2pDistanceY", e1: "a", p1: 0, e2: "b", p2: 0, value: 20, place: { ox: 8, oy: 0 } },
    ]);
    expect(dims[0]!.place).toBeTruthy();
    expect(isPlacedDim({ type: "p2pDistanceX", e1: "a", p1: 0, e2: "b", p2: 0, value: 30 })).toBe(true);
    expect(isPlacedDim({ type: "p2pDistanceY", e1: "a", p1: 0, e2: "b", p2: 0, value: 20 })).toBe(true);
  });
});

describe("lineOperand (rect-edge line operands)", () => {
  const r: ResolvedEntity = { type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0 };
  const l: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 3, y2: 4 };
  const byId = new Map([r, l].map((e) => [e.id, e]));

  it("resolves a plain line entity id", () => {
    expect(lineOperand(byId, "l")).toMatchObject({ x1: 0, y1: 0, x2: 3, y2: 4 });
  });
  it("resolves each of a rectangle's 4 edges in rectCorners CCW order", () => {
    expect(lineOperand(byId, "r~0")).toEqual({ x1: -10, y1: -5, x2: 10, y2: -5 }); // bottom
    expect(lineOperand(byId, "r~1")).toEqual({ x1: 10, y1: -5, x2: 10, y2: 5 }); // right
    expect(lineOperand(byId, "r~2")).toEqual({ x1: 10, y1: 5, x2: -10, y2: 5 }); // top
    expect(lineOperand(byId, "r~3")).toEqual({ x1: -10, y1: 5, x2: -10, y2: -5 }); // left
  });
  it("rejects a bad edge index, a non-rectangle base, and a missing entity", () => {
    expect(lineOperand(byId, "r~4")).toBeNull();
    expect(lineOperand(byId, "r~x")).toBeNull();
    expect(lineOperand(byId, "l~0")).toBeNull();
    expect(lineOperand(byId, "gone~0")).toBeNull();
    expect(lineOperand(byId, "gone")).toBeNull();
  });
});

describe("constraintDims with rect-edge operands + placement", () => {
  const r: ResolvedEntity = { type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0 };
  const c: ResolvedEntity = { type: "circle", id: "c", radius: 2, x: 0, y: 20 };

  it("renders a p2lDistance whose line operand is a rectangle edge", () => {
    const dims = constraintDims([r, c], [{ type: "p2lDistance", e: "c", p: 0, line: "r~0", value: 25 }]);
    expect(dims.length).toBe(1);
    expect(dims[0]!.valueMm).toBe(25);
    expect(dims[0]!.lines.length).toBeGreaterThan(0);
  });

  it("renders an angle between two rectangle edges", () => {
    const dims = constraintDims([r], [{ type: "angle", l1: "r~0", l2: "r~1", value: 90 }]);
    expect(dims.length).toBe(1);
    expect(dims[0]!.kind).toBe("angle");
  });

  it("`place` flips the dimension line to the other side of the geometry", () => {
    const base: SketchConstraint = { type: "p2pDistance", e1: "r", p1: 0, e2: "r", p2: 1, value: 20 };
    const up = constraintDims([r], [{ ...base, place: { ox: 0, oy: 8 } }])[0]!;
    const down = constraintDims([r], [{ ...base, place: { ox: 0, oy: -8 } }])[0]!;
    expect(up.labelPos.y).toBeGreaterThan(-5);
    expect(down.labelPos.y).toBeLessThan(-5);
    expect(up.labelPos.y).toBeCloseTo(-5 + 8);
    expect(down.labelPos.y).toBeCloseTo(-5 - 8);
  });

  it("`place` picks the radial direction of a radius dim", () => {
    const circ: ResolvedEntity = { type: "circle", id: "c", radius: 10, x: 0, y: 0 };
    const d = constraintDims([circ], [{ type: "radius", e: "c", value: 10, place: { ox: -50, oy: 0 } }])[0]!;
    expect(d.labelPos.x).toBeCloseTo(-6); // −1 radial × r × 0.6
    expect(d.labelPos.y).toBeCloseTo(0);
  });

  it("`place` offsets an angle dim's bare label", () => {
    const l1: ResolvedEntity = { type: "line", id: "a", x1: 0, y1: 0, x2: 10, y2: 0 };
    const l2: ResolvedEntity = { type: "line", id: "b", x1: 0, y1: 0, x2: 0, y2: 10 };
    const plain = constraintDims([l1, l2], [{ type: "angle", l1: "a", l2: "b", value: 90 }])[0]!;
    const moved = constraintDims([l1, l2], [{ type: "angle", l1: "a", l2: "b", value: 90, place: { ox: 3, oy: 4 } }])[0]!;
    expect(moved.labelPos.x - plain.labelPos.x).toBeCloseTo(3);
    expect(moved.labelPos.y - plain.labelPos.y).toBeCloseTo(4);
  });
});

// --- rim (edge-to-edge) measures --------------------------------------------
// These lock the exact two-branch measure planegcs's c2cdistance uses (verified
// against the installed wasm with a non-driving probe). The dimension tool, the
// label renderer and sketchSolve's solve guard all read them.

describe("rim measures", () => {
  const R = (x: number, y: number, r: number) => ({ x, y, r });

  it("rimGap: separated rims give the signed external clearance", () => {
    expect(rimGap(R(0, 0, 5), R(20, 0, 3))).toBeCloseTo(12);
    expect(rimGap(R(0, 0, 5), R(8, 0, 3))).toBeCloseTo(0); // externally tangent
    expect(rimGap(R(0, 0, 5), R(6, 0, 5))).toBeCloseTo(-4); // overlapping ⇒ negative
  });

  it("rimGap: nested rims give the annular minimum gap", () => {
    expect(rimGap(R(0, 0, 10), R(2, 0, 3))).toBeCloseTo(5);
    expect(rimGap(R(2, 0, 3), R(0, 0, 10))).toBeCloseTo(5); // order-independent
    expect(rimGap(R(0, 0, 5), R(0, 0, 12))).toBeCloseTo(7); // concentric
  });

  it("rimNesting names which rim is inside, or null when neither is", () => {
    expect(rimNesting(R(0, 0, 10), R(2, 0, 3))).toBe("c2");
    expect(rimNesting(R(2, 0, 3), R(0, 0, 10))).toBe("c1");
    expect(rimNesting(R(0, 0, 5), R(20, 0, 3))).toBeNull();
    expect(rimNesting(R(0, 0, 5), R(6, 0, 5))).toBeNull(); // overlapping, not nested
  });

  it("rimGapPoints spans the two facing rim points of a separated pair", () => {
    const { a, b } = rimGapPoints(R(0, 0, 5), R(20, 0, 3), new THREE.Vector2(1, 0));
    expect(a.x).toBeCloseTo(5);
    expect(b.x).toBeCloseTo(17);
    expect(a.distanceTo(b)).toBeCloseTo(12);
  });

  it("rimGapPoints spans the minimum wall of a nested pair", () => {
    const { a, b } = rimGapPoints(R(0, 0, 10), R(2, 0, 3), new THREE.Vector2(1, 0));
    expect(a.distanceTo(b)).toBeCloseTo(5);
  });

  it("rimGapPoints falls back to the given direction when the centres coincide", () => {
    const { a, b } = rimGapPoints(R(0, 0, 5), R(0, 0, 12), new THREE.Vector2(0, 3));
    expect(a.y).toBeCloseTo(5);
    expect(b.y).toBeCloseTo(12);
  });

  it("pointRimPoints reaches the NEAREST rim point from either side", () => {
    const out = pointRimPoints(new THREE.Vector2(20, 0), R(0, 0, 5))!;
    expect(out.b.x).toBeCloseTo(5);
    expect(out.a.distanceTo(out.b)).toBeCloseTo(15);
    const inside = pointRimPoints(new THREE.Vector2(2, 0), R(0, 0, 5))!;
    expect(inside.a.distanceTo(inside.b)).toBeCloseTo(3);
    expect(pointRimPoints(new THREE.Vector2(0, 0), R(0, 0, 5))).toBeNull();
  });

  it("lineRimPoints spans the facing rim point and the foot of the perpendicular", () => {
    const seg = { x1: -10, y1: 0, x2: 10, y2: 0 };
    const out = lineRimPoints(seg, R(0, 10, 3))!;
    expect(out.a.y).toBeCloseTo(7);
    expect(out.b.y).toBeCloseTo(0);
    expect(lineRimPoints(seg, R(0, 0, 3))).toBeNull(); // centre on the line
  });
});

describe("constraintDims — rim dims", () => {
  const inner: ResolvedEntity = { type: "circle", id: "i", x: 0, y: 0, radius: 5 };
  const outer: ResolvedEntity = { type: "circle", id: "o", x: 0, y: 0, radius: 12 };
  const far: ResolvedEntity = { type: "circle", id: "q", x: 40, y: 0, radius: 4 };
  const ln: ResolvedEntity = { type: "line", id: "l", x1: -50, y1: -30, x2: 50, y2: -30 };
  const pt: ResolvedEntity = { type: "point", id: "p", x: 0, y: 40 };

  it("renders a radialGap along the placement direction", () => {
    const [d] = constraintDims([inner, outer], [
      { type: "radialGap", inner: "i", outer: "o", value: 7, place: { ox: 0, oy: 9 } },
    ]);
    expect(d?.valueMm).toBe(7);
    expect(d?.lines.length).toBeGreaterThan(0);
    expect(d!.labelPos.y).toBeGreaterThan(0); // followed the +Y placement
  });

  it("renders a c2cDistance and measures it live when driven", () => {
    const [d] = constraintDims([outer, far], [
      { type: "c2cDistance", c1: "o", c2: "q", value: 999, driven: true },
    ]);
    expect(d?.driven).toBe(true);
    expect(d?.valueMm).toBeCloseTo(24); // 40 - 12 - 4, not the stored 999
  });

  it("renders a c2lDistance", () => {
    const [d] = constraintDims([far, ln], [{ type: "c2lDistance", circle: "q", line: "l", value: 26 }]);
    expect(d?.valueMm).toBe(26);
    expect(d?.lines.length).toBeGreaterThan(0);
  });

  it("renders a p2cDistance", () => {
    const [d] = constraintDims([outer, pt], [{ type: "p2cDistance", e: "p", p: 0, circle: "o", value: 28 }]);
    expect(d?.valueMm).toBe(28);
    expect(d?.lines.length).toBeGreaterThan(0);
  });

  it("renders a diameter dim on an ARC only (a circle keeps its own badge)", () => {
    const a: ResolvedEntity = { type: "arc", id: "a", x1: 8, y1: 0, x2: -8, y2: 0, mx: 0, my: 8 };
    expect(constraintDims([a], [{ type: "diameter", circle: "a", value: 16 }])).toHaveLength(1);
    expect(constraintDims([inner], [{ type: "diameter", circle: "i", value: 10 }])).toHaveLength(0);
  });

  it("skips a rim dim whose operand is gone", () => {
    expect(constraintDims([inner], [{ type: "c2cDistance", c1: "i", c2: "gone", value: 5 }])).toHaveLength(0);
  });
});

// --- label placement (drag) --------------------------------------------------
// The maths a label drag rides on: `place` is the label's current offset from
// the dim's natural anchor, so "new place = old place + cursor delta" holds for
// every dim kind, and the renderers honour a stored placement.

describe("badge label placement", () => {
  const at = (d: { labelPos: THREE.Vector2 }) => [d.labelPos.x, d.labelPos.y];

  it("reports place as the offset that reproduces the label position", () => {
    // the invariant a drag composes with: anchor + place === labelPos, for each
    // dim's own natural anchor
    const c: ResolvedEntity = { type: "circle", id: "c", radius: 10, x: 3, y: 7 };
    const [d] = entityDims(c); // anchor = the centre
    expect(d!.labelPos.x).toBeCloseTo(3 + d!.place.x);
    expect(d!.labelPos.y).toBeCloseTo(7 + d!.place.y);

    const l: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 };
    const [ld] = entityDims(l); // anchor = the segment midpoint
    expect(ld!.labelPos.x).toBeCloseTo(5 + ld!.place.x);
    expect(ld!.labelPos.y).toBeCloseTo(0 + ld!.place.y);
  });

  it("an unplaced circle keeps the historical horizontal chord + label above", () => {
    const e: ResolvedEntity = { type: "circle", id: "c", radius: 10, x: 0, y: 0 };
    const [d] = entityDims(e);
    expect(d!.labelPos.x).toBeCloseTo(0);
    expect(d!.labelPos.y).toBeGreaterThan(0);
    expect(at({ labelPos: d!.lines[0]![0] })).toEqual([-10, 0]); // chord runs -r..+r on X
    expect(at({ labelPos: d!.lines[0]![1] })).toEqual([10, 0]);
  });

  it("a circle's placement sets BOTH the diameter line's angle and the label distance", () => {
    // straight up: the chord rotates 90° from its default, and the label sits on
    // it at exactly the placed distance
    const e: ResolvedEntity = { type: "circle", id: "c", radius: 10, x: 0, y: 0, dimPlace: { diameter: { ox: 0, oy: 6 } } };
    const [d] = entityDims(e);
    expect(at(d!)).toEqual([0, 6]);
    const [a, b] = d!.lines[0]!;
    expect(a.x).toBeCloseTo(0); expect(a.y).toBeCloseTo(-10);
    expect(b.x).toBeCloseTo(0); expect(b.y).toBeCloseTo(10);
    expect(d!.place.x).toBeCloseTo(0);
    expect(d!.place.y).toBeCloseTo(6);
  });

  it("a diameter label dragged past the rim pulls a leader out to itself", () => {
    const e: ResolvedEntity = { type: "circle", id: "c", radius: 10, x: 0, y: 0, dimPlace: { diameter: { ox: 25, oy: 0 } } };
    const [d] = entityDims(e);
    expect(at(d!)).toEqual([25, 0]);
    expect(d!.lines[0]![1].x).toBeCloseTo(25); // line reaches the label
    expect(d!.lines[0]![0].x).toBeCloseTo(-10); // …but still starts at the rim
  });

  it("two concentric circles are dimensioned in different directions by default", () => {
    // the user-visible bug: both diameter badges landed on the shared centre
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "outer", radius: 30, x: 0, y: 0 },
      { type: "circle", id: "inner", radius: 17, x: 0, y: 0 },
    ];
    const defs = staggeredDefaults(ents);
    const [o] = entityDims(ents[0]!, defs.get("outer"));
    const [i] = entityDims(ents[1]!, defs.get("inner"));
    expect(o!.labelPos.distanceTo(i!.labelPos)).toBeGreaterThan(10);
    // and neither label may land ON a rim — a badge over geometry hands its
    // clicks to that geometry
    for (const d of [o!, i!]) {
      for (const r of [17, 30]) expect(Math.abs(d.labelPos.length() - r)).toBeGreaterThan(2);
    }
  });

  it("a lone circle is not staggered, and a user placement beats the default", () => {
    const lone: ResolvedEntity = { type: "circle", id: "c", radius: 10, x: 0, y: 0 };
    expect(staggeredDefaults([lone]).size).toBe(0);
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "a", radius: 30, x: 0, y: 0, dimPlace: { diameter: { ox: 5, oy: 0 } } },
      { type: "circle", id: "b", radius: 17, x: 0, y: 0 },
    ];
    const defs = staggeredDefaults(ents);
    expect(at(entityDims(ents[0]!, defs.get("a"))[0]!)).toEqual([5, 0]);
  });

  it("a linear badge only moves perpendicular — the along-segment part is ignored", () => {
    const base: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 };
    const off = entityDims(base)[0]!.place;
    // the line's normal is +Y (left of a +X segment): only oy can matter
    const moved: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0, dimPlace: { length: { ox: 40, oy: 9 } } };
    const [d] = entityDims(moved);
    expect(d!.labelPos.x).toBeCloseTo(5); // stayed centred despite ox: 40
    expect(d!.labelPos.y).toBeCloseTo(9);
    expect(off.x).toBeCloseTo(0);
  });

  it("a negative perpendicular placement flips the linear dim to the other side", () => {
    const e: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0, dimPlace: { length: { ox: 0, oy: -9 } } };
    const [d] = entityDims(e);
    expect(d!.labelPos.y).toBeCloseTo(-9);
  });

  it("rectangle W and H carry independent placements", () => {
    // each one is anchored on the EDGE it measures (bottom / left), not on the
    // rectangle's centre, and its placement offsets it from there
    const e: ResolvedEntity = {
      type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0,
      dimPlace: { width: { ox: 0, oy: -12 }, height: { ox: -14, oy: 0 } },
    };
    const [w, h] = entityDims(e);
    expect(w!.labelPos.y).toBeCloseTo(-5 - 12); // 12 below the bottom edge
    expect(w!.labelPos.x).toBeCloseTo(0);
    expect(h!.labelPos.x).toBeCloseTo(-10 - 14); // 14 left of the left edge
    expect(h!.labelPos.y).toBeCloseTo(0);
    // and moving one leaves the other exactly where an unplaced one sits
    const plain = entityDims({ type: "rectangle", id: "r2", width: 20, height: 10, x: 0, y: 0, dimPlace: { width: { ox: 0, oy: -12 } } });
    expect(plain[1]!.labelPos.x).toBeCloseTo(entityDims({ type: "rectangle", id: "r3", width: 20, height: 10, x: 0, y: 0 })[1]!.labelPos.x);
  });

  it("a polygon radius label only slides along its own radial line", () => {
    const e: ResolvedEntity = {
      type: "polygon", id: "p", x: 0, y: 0, radius: 10, sides: 6, angle: 0,
      dimPlace: { radius: { ox: 8, oy: 50 } }, // the 50 is across the line — ignored
    };
    const [d] = entityDims(e);
    expect(d!.labelPos.y).toBeCloseTo(0);
    expect(d!.labelPos.x).toBeCloseTo(8);
  });

  it("a slot's length and width placements don't cross-talk", () => {
    const e: ResolvedEntity = {
      type: "slot", id: "s", x1: 0, y1: 0, x2: 20, y2: 0, width: 6,
      dimPlace: { length: { ox: 0, oy: 15 } },
    };
    const [len, wid] = entityDims(e);
    expect(len!.labelPos.y).toBeCloseTo(15);
    expect(wid!.labelPos.y).toBeCloseTo(0); // untouched: its own offset runs along -X
    expect(wid!.labelPos.x).toBeLessThan(0);
  });

  it("labels and their annotation lines are laid out from the same defaults", () => {
    // dimensionSegments must stagger exactly as the labels do, or a concentric
    // pair's chords and badges disagree
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "outer", radius: 30, x: 0, y: 0 },
      { type: "circle", id: "inner", radius: 17, x: 0, y: 0 },
    ];
    const defs = staggeredDefaults(ents);
    const segs = dimensionSegments(ents);
    const own = ents.flatMap((e) => entityDims(e, defs.get(e.id)).flatMap((d) => d.lines));
    expect(segs.map(([a, b]) => [a.x, a.y, b.x, b.y]))
      .toEqual(own.map(([a, b]) => [a.x, a.y, b.x, b.y]));
  });
});

describe("constraint dim placement", () => {
  const p1: ResolvedEntity = { type: "point", id: "p1", x: 0, y: 0 };
  const p2: ResolvedEntity = { type: "point", id: "p2", x: 10, y: 0 };

  it("reports place as the offset from the measured segment's midpoint", () => {
    const [d] = constraintDims([p1, p2], [{ type: "p2pDistance", e1: "p1", p1: 0, e2: "p2", p2: 0, value: 10 }]);
    expect(d!.place).toBeDefined();
    expect(d!.labelPos.x).toBeCloseTo(5 + d!.place!.x);
    expect(d!.labelPos.y).toBeCloseTo(0 + d!.place!.y);
  });

  it("honours a stored place, perpendicular-only", () => {
    const c: SketchConstraint = { type: "p2pDistance", e1: "p1", p1: 0, e2: "p2", p2: 0, value: 10, place: { ox: 30, oy: 9 } };
    const [d] = constraintDims([p1, p2], [c]);
    expect(d!.labelPos.x).toBeCloseTo(5); // the 30 along the segment is ignored
    expect(d!.labelPos.y).toBeCloseTo(9);
  });

  it("an angle dim takes a free 2D placement", () => {
    const l1: ResolvedEntity = { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 };
    const l2: ResolvedEntity = { type: "line", id: "l2", x1: 0, y1: 0, x2: 0, y2: 10 };
    const base = constraintDims([l1, l2], [{ type: "angle", l1: "l1", l2: "l2", value: 90 }])[0]!;
    const moved = constraintDims([l1, l2], [{ type: "angle", l1: "l1", l2: "l2", value: 90, place: { ox: 7, oy: -4 } }])[0]!;
    expect(moved.labelPos.x).toBeCloseTo(base.labelPos.x + 7);
    expect(moved.labelPos.y).toBeCloseTo(base.labelPos.y - 4);
    expect(moved.place!.x).toBeCloseTo(7);
  });

  it("an arc's diameter dim reports no place (that constraint has no slot for one)", () => {
    const a: ResolvedEntity = { type: "arc", id: "a", x1: 8, y1: 0, x2: -8, y2: 0, mx: 0, my: 8 };
    const [d] = constraintDims([a], [{ type: "diameter", circle: "a", value: 16 }]);
    expect(d!.place).toBeUndefined();
  });
});
