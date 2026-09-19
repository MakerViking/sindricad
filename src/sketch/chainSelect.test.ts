// CHAIN SELECT in a sketch: double-click one entity, get the whole contiguous
// string of them.
//
// Field report (Doug Smith, #15): "Chain select — to be able to select a
// contiguous string of elements in a sketch all together. I know this works for
// a sweep path, but would be handy in other situations."
//
// The walk is CONNECTIVITY, not tangency. edgeFeatureTool's 3D chain requires G1
// continuity because OCCT cannot terminate a fillet mid-tangency — a kernel
// constraint that has no bearing on selection. A sketched profile's sharp corner
// is still one contour to the user, so the chain crosses it. The tests below pin
// that difference, because "reuse the edge chain" is the obvious wrong fix.
//
// entityChain is exercised directly: it is the whole of the geometry decision,
// and the double-click that calls it is one `if` in the pointer handler that the
// doublePress tests already cover as a gesture.

import { describe, it, expect } from "vitest";
import { SketchMode } from "./sketchMode";
import { originGeometry } from "./origin";
import type { ResolvedEntity } from "./snap";

/** A SketchMode carrying nothing but an entity list — entityChain reads only
 *  `this.entities`, through ownEntities(). */
function withEntities(entities: ResolvedEntity[]) {
  const s = Object.create(SketchMode.prototype) as Record<string, unknown>;
  s.entities = [...originGeometry(), ...entities];
  return (id: string): string[] =>
    (s as unknown as { entityChain(i: string): string[] }).entityChain(id).sort();
}

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 }) as ResolvedEntity;

describe("chain select walks connected endpoints", () => {
  it("crosses a sharp corner, which a tangency walk would refuse", () => {
    // an L: (0,0)->(10,0)->(10,10). The joint is 90°, nowhere near G1.
    const chain = withEntities([line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 10)]);
    expect(chain("a")).toEqual(["a", "b"]);
    expect(chain("b")).toEqual(["a", "b"]);
  });

  it("walks a whole open polyline from any member", () => {
    const chain = withEntities([
      line("a", 0, 0, 10, 0),
      line("b", 10, 0, 10, 10),
      line("c", 10, 10, 0, 10),
      line("d", 0, 10, 0, 0),
    ]);
    expect(chain("c")).toEqual(["a", "b", "c", "d"]);
  });

  it("stops at a gap", () => {
    const chain = withEntities([
      line("a", 0, 0, 10, 0),
      line("b", 10, 0, 10, 10),
      line("far", 500, 500, 600, 600),
    ]);
    expect(chain("a")).toEqual(["a", "b"]);
    expect(chain("far")).toEqual(["far"]);
  });

  // The origin exclusion, tested where it actually bites. NOTE the coordinates:
  // this walk matches endpoint to endpoint, and the X axis's ends are at
  // ±10 000 mm, so only a line drawn out to the axis TIP can reach it. The
  // obvious version of this test — two short lines near (0,0) — passes whether
  // or not the exclusion exists, and proves nothing.
  it("never chains through the origin axes, even at the axis tip", () => {
    const chain = withEntities([
      line("a", 10_000, 0, 10_000, 50), // endpoint lands exactly on the X axis end
      line("b", -10_000, 0, -10_000, 50), // and on its other end
    ]);
    expect(chain("a")).toEqual(["a"]);
    expect(chain("b")).toEqual(["b"]);
  });

  // Two lines that genuinely meet at the origin ARE contiguous and do chain —
  // the exclusion removes the synthetic entities, not the user's.
  it("chains user geometry that meets at the origin, without the origin in it", () => {
    const chain = withEntities([line("a", 0, 0, 0, 5), line("b", 0, 0, 5, 0)]);
    expect(chain("a")).toEqual(["a", "b"]);
  });

  it("returns a closed entity on its own", () => {
    const chain = withEntities([
      { type: "circle", id: "c", x: 0, y: 0, radius: 5 } as ResolvedEntity,
      { type: "rectangle", id: "r", x: 50, y: 50, width: 10, height: 10 } as ResolvedEntity,
    ]);
    expect(chain("c")).toEqual(["c"]);
    expect(chain("r")).toEqual(["r"]);
  });

  // A circle tangent to a rail shares a point with it. It is still its own
  // contour, and dragging it into the rail's chain would surprise.
  it("does not pull a closed entity into a chain it merely touches", () => {
    const chain = withEntities([
      line("a", -10, 0, 0, 0), // ends exactly on the circle's rightmost point
      line("b", -20, 0, -10, 0),
      { type: "circle", id: "c", x: 5, y: 0, radius: 5 } as ResolvedEntity,
    ]);
    expect(chain("a")).toEqual(["a", "b"]);
    expect(chain("c")).toEqual(["c"]);
  });

  it("returns the entity alone when nothing touches it", () => {
    const chain = withEntities([line("only", 1, 1, 2, 2)]);
    expect(chain("only")).toEqual(["only"]);
  });

  // Three entities meeting at one point (a T). All of them are contiguous with
  // the pick, so all of them come; the walk does not try to pick a "best" branch.
  it("takes every branch at a junction", () => {
    const chain = withEntities([
      line("a", 0, 5, 10, 5),
      line("b", 10, 5, 20, 5),
      line("t", 10, 5, 10, 15),
    ]);
    expect(chain("a")).toEqual(["a", "b", "t"]);
  });
});
