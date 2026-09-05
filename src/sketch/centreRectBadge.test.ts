// A dimension badge on a shape centred on the ORIGIN was uneditable.
//
// Reported: a rectangle drawn around the origin, and "clicking the vertical
// dimension does nothing except turn the horizontal origin axis dotted".
// entityDims puts a rectangle's HEIGHT badge to the left at mid-height — for a
// rect centred on 0,0 that is exactly ON the X axis — and its WIDTH badge below
// at mid-width, exactly on the Y axis. The badge's pointerdown asks the host
// "does geometry under the cursor claim this click?", and pickEntity falls back
// to REFERENCE geometry when none of the user's own is in range. None ever is:
// every badge is laid out at least LABEL_CLEAR_PX (18 px) off the geometry it
// labels, twice the 9 px pick tolerance. So the axis, at distance 0, won every
// time: the selection was replaced by the axis, the badges were rebuilt, and no
// editor ever opened.
//
// These drive the REAL labelOverlapSelect / labelOverlapDimension off
// SketchMode.prototype (a real SketchMode needs WebGL), with the real
// entityDims layout and the real pickEntity underneath — what is stubbed is the
// screen→plane conversion and the pick tolerance, never the arbitration.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SketchMode } from "./sketchMode";
import { originGeometry } from "./origin";
import { entityDims, setDimPixelScale } from "./entityDims";
import type { ResolvedEntity } from "./snap";

// 0.1 mm per pixel: the scale SketchMode feeds entityDims each refresh, so the
// badge clearance and the pick tolerance below are the ones the app uses.
setDimPixelScale(0.1);
const TOL = 0.9; // pickTol() = 9 px in mm

/** the reporter's own entity, from bug-reports/docs/d1515ecd.json */
const RECT: ResolvedEntity = {
  type: "rectangle", id: "r1", x: 0, y: 0, width: 80, height: 50.04310507196191,
};

const anchorOf = (e: ResolvedEntity, field: string): THREE.Vector2 => {
  const d = entityDims(e).find((x) => x.field === field);
  if (!d) throw new Error(`no ${field} dim`);
  return d.labelPos;
};

/** A SketchMode whose collaborators are stubs, so the two arbitration methods
 *  can run. `planePoint` returns the badge's own anchor — a badge is centred on
 *  its anchor (translate(-50%,-50%)), so a click on it maps to that point. */
function makeMode(entities: ResolvedEntity[], at: THREE.Vector2, tool = "select") {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const calls = { dimensionClick: 0 };
  Object.assign(s, {
    entities,
    tool,
    selected: new Set<string>(),
    dimPicks: [],
    planePoint: () => at.clone(),
    pickTol: () => TOL,
    refreshActive: () => {},
    dimensionClick: () => { calls.dimensionClick++; },
  });
  return { s, calls, selected: () => [...(s as unknown as { selected: Set<string> }).selected] };
}

const press = { button: 0, shiftKey: false, clientX: 0, clientY: 0 } as unknown as PointerEvent;
const claim = (s: unknown, e = press): boolean =>
  (s as { labelOverlapSelect: (e: PointerEvent) => boolean }).labelOverlapSelect(e);

describe("a badge over an ORIGIN AXIS keeps its own click", () => {
  it("the height badge of a rectangle centred on the origin sits on the X axis", () => {
    // the premise, so a layout change can't quietly make the rest vacuous
    const a = anchorOf(RECT, "height");
    expect(a.y).toBeCloseTo(0, 6);
    expect(a.x).toBeCloseTo(-48.007, 3);
  });

  it("does not hand the height badge's click to the X axis", () => {
    const { s, selected } = makeMode([...originGeometry(), RECT], anchorOf(RECT, "height"));
    expect(claim(s)).toBe(false);
    expect(selected()).toEqual([]);
  });

  it("does not hand the width badge's click to the Y axis", () => {
    const { s, selected } = makeMode([...originGeometry(), RECT], anchorOf(RECT, "width"));
    expect(claim(s)).toBe(false);
    expect(selected()).toEqual([]);
  });

  it("does not hand a centred circle's diameter badge to the Y axis", () => {
    const circle: ResolvedEntity = { type: "circle", id: "c1", x: 0, y: 0, radius: 5 };
    const { s, selected } = makeMode([...originGeometry(), circle], anchorOf(circle, "diameter"));
    expect(claim(s)).toBe(false);
    expect(selected()).toEqual([]);
  });

  it("still hands a badge's click to geometry the user DREW underneath it", () => {
    // the rule this fix must not break: a badge floating over a real line at low
    // zoom must not swallow the click meant to select that line
    const line: ResolvedEntity = { type: "line", id: "l1", x1: -60, y1: 0, x2: -40, y2: 0 };
    const { s, selected } = makeMode([...originGeometry(), RECT, line], anchorOf(RECT, "height"));
    expect(claim(s)).toBe(true);
    expect(selected()).toEqual(["l1"]);
  });

  it("leaves the click with the badge in the DIMENSION tool too", () => {
    const { s, calls } = makeMode([...originGeometry(), RECT], anchorOf(RECT, "height"), "dimension");
    expect(claim(s)).toBe(false);
    expect(calls.dimensionClick).toBe(0);
  });

  it("still starts a dimension on geometry the user drew", () => {
    const line: ResolvedEntity = { type: "line", id: "l1", x1: -60, y1: 0, x2: -40, y2: 0 };
    const { s, calls } = makeMode([...originGeometry(), RECT, line], anchorOf(RECT, "height"), "dimension");
    expect(claim(s)).toBe(true);
    expect(calls.dimensionClick).toBe(1);
  });
});
