// Unit tests for closed-region detection (src/sketch/region.ts): entityPolyline,
// detectRegions, pointInLoop/pointInRegion.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  detectRegions,
  entityPolyline,
  glyphRegion,
  pointInRegion,
  regionsByEntities,
} from "./region";
import type { ResolvedEntity } from "./snap";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });
const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity =>
  ({ type: "rectangle", id, x, y, width, height });
const circle = (id: string, x: number, y: number, radius: number): ResolvedEntity =>
  ({ type: "circle", id, x, y, radius });
const slot = (id: string, x1: number, y1: number, x2: number, y2: number, width: number): ResolvedEntity =>
  ({ type: "slot", id, x1, y1, x2, y2, width });
const polygon = (id: string, x: number, y: number, radius: number, sides: number, angle = 0): ResolvedEntity =>
  ({ type: "polygon", id, x, y, radius, sides, angle });

/** shoelace area of a loop stored the way Region stores one: closed by wrapping,
 *  with no repeated final vertex. Sign-free — callers here only compare sizes. */
const loopArea = (pts: readonly THREE.Vector2[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

describe("entityPolyline", () => {
  it("a line is its two endpoints, open (no closing vertex)", () => {
    const p = entityPolyline(line("l1", 0, 0, 5, 0));
    expect(p).toEqual([new THREE.Vector2(0, 0), new THREE.Vector2(5, 0)]);
  });

  it("a rectangle's polyline repeats its first corner to close the loop", () => {
    const p = entityPolyline(rect("r1", 0, 0, 10, 4));
    expect(p).toHaveLength(5); // 4 corners + repeated first
    expect(p[0]).toEqual(p[4]);
  });

  it("a circle's polyline repeats its first sampled point to close the loop", () => {
    const p = entityPolyline(circle("c1", 0, 0, 3));
    expect(p[0]).toEqual(p[p.length - 1]);
    expect(p.length).toBeGreaterThan(3);
  });
});

describe("glyphRegion — a tessellated glyph face becomes an extrudable profile", () => {
  it("a square outer with a square hole yields a ring whose interior avoids the hole", () => {
    // 10×10 outer, 4×4 centered hole (like the counter of an 'O')
    const outer: [number, number][] = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const holes: [number, number][][] = [[[-2, -2], [2, -2], [2, 2], [-2, 2]]];
    const region = glyphRegion("s1", outer, holes);

    expect(region.sketchId).toBe("s1");
    expect(region.loop).toHaveLength(4);
    expect(region.holes).toHaveLength(1);
    // the selection anchor must sit in the material — inside the outer, outside the hole
    expect(pointInRegion(region.interior, region)).toBe(true);
    // a point in the counter (hole) is NOT part of the material
    expect(pointInRegion(new THREE.Vector2(0, 0), region)).toBe(false);
  });

  it("a solid glyph face (no holes) keeps its whole area", () => {
    const outer: [number, number][] = [[0, 0], [6, 0], [6, 4], [0, 4]];
    const region = glyphRegion("s1", outer, []);
    expect(region.holes).toHaveLength(0);
    expect(pointInRegion(new THREE.Vector2(3, 2), region)).toBe(true);
  });
});

describe("detectRegions — simple closed rectangle", () => {
  it("a single rectangle entity yields exactly one region with no holes", () => {
    const regions = detectRegions("s1", [rect("r1", 0, 0, 10, 6)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.holes).toHaveLength(0);
    // loop is the 4 rectangle corners (unclosed, no repeated last point)
    expect(regions[0]?.loop).toHaveLength(4);
  });

  it("a 4-line closed loop (chained by shared endpoints) also yields one region", () => {
    const entities = [
      line("l1", -5, -5, 5, -5),
      line("l2", 5, -5, 5, 5),
      line("l3", 5, 5, -5, 5),
      line("l4", -5, 5, -5, -5),
    ];
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.holes).toHaveLength(0);
  });

  it("an open 3-line chain (missing the closing side) yields no region", () => {
    const entities = [
      line("l1", -5, -5, 5, -5),
      line("l2", 5, -5, 5, 5),
      line("l3", 5, 5, -5, 5),
      // no l4 closing back to (-5, -5): the chain never closes
    ];
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(0);
  });
});

describe("detectRegions — circle-inside-rectangle hole handling", () => {
  // Non-crossing (circle entirely inside, not touching the rectangle boundary):
  // the fast path treats each as its own loop, then nests by containment —
  // a ring (rect w/ hole=circle) AND the disk (circle, no holes), per the code's
  // own comment at region.ts:131-132.
  const entities = [rect("r1", 0, 0, 20, 20), circle("c1", 0, 0, 3)];

  it("yields two regions: the outer ring (hole=circle) and the inner disk", () => {
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(2);
    const ring = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;
    expect(ring).toBeDefined();
    expect(disk).toBeDefined();
    expect(ring.holes).toHaveLength(1);
    expect(ring.loop).toHaveLength(4); // the rectangle
    expect(disk.loop.length).toBeGreaterThan(4); // the sampled circle
  });

  it("pointInRegion: material of the ring excludes the hole's interior", () => {
    const regions = detectRegions("s1", entities);
    const ring = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;

    // center of the circle: inside the disk, but excluded from the ring's material
    expect(pointInRegion(new THREE.Vector2(0, 0), disk)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(0, 0), ring)).toBe(false);

    // a point between the circle and the rectangle boundary: in the ring's
    // material, but outside the disk
    expect(pointInRegion(new THREE.Vector2(8, 8), ring)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(8, 8), disk)).toBe(false);

    // a point outside the rectangle entirely: in neither region
    expect(pointInRegion(new THREE.Vector2(100, 100), ring)).toBe(false);
    expect(pointInRegion(new THREE.Vector2(100, 100), disk)).toBe(false);
  });
});

describe("detectRegions — thin-ring interior anchor (field bug: outer ring selects inner circle)", () => {
  // Two concentric circles with a thin ring (inner_r/outer_r = 0.914 > 0.9), the
  // exact Test1.sindri geometry. The region's `interior` anchor MUST land in the
  // ring material — not in the hole. When it fell in the hole (0,0), selecting the
  // ring stored an anchor inside the disk, so the disk highlighted/extruded instead.
  it("the annulus anchor is inside its own material, not the hole", () => {
    const regions = detectRegions("s1", [circle("outer", 0, 0, 27.5), circle("inner", 0, 0, 25.123885645485018)]);
    expect(regions).toHaveLength(2);
    const annulus = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;
    // the anchor must be in the annulus material and NOT in the disk (the hole)
    expect(pointInRegion(annulus.interior, annulus)).toBe(true);
    expect(pointInRegion(annulus.interior, disk)).toBe(false);
  });
});

describe("detectRegions — projected reference geometry forms profiles", () => {
  const pline = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
    type: "projected", id,
    source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
    curve: { kind: "line", x1, y1, x2, y2 },
  });

  it("a square of 4 projected lines chains into one region", () => {
    const regions = detectRegions("s1", [
      pline("p1", 0, 0, 20, 0),
      pline("p2", 20, 0, 20, 20),
      pline("p3", 20, 20, 0, 20),
      pline("p4", 0, 20, 0, 0),
    ]);
    expect(regions).toHaveLength(1);
    expect(pointInRegion(new THREE.Vector2(10, 10), regions[0]!)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(30, 10), regions[0]!)).toBe(false);
  });

  it("a projected circle is its own closed loop (fast path, like a native circle)", () => {
    const pc: ResolvedEntity = {
      type: "projected", id: "pc",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "circle", x: 0, y: 0, r: 5 },
    };
    const regions = detectRegions("s1", [pc]);
    expect(regions).toHaveLength(1);
    expect(pointInRegion(new THREE.Vector2(0, 0), regions[0]!)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(6, 0), regions[0]!)).toBe(false);
  });

  it("a construction projected entity never forms a profile", () => {
    const pc: ResolvedEntity = {
      type: "projected", id: "pc",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "circle", x: 0, y: 0, r: 5 },
      construction: true,
    };
    expect(detectRegions("s1", [pc])).toHaveLength(0);
  });
});

// Field report c2a97cee (0.1.128), "The slot is not recognized as a closed area."
// The non-crossing fast path in detectRegions listed the closed primitives by
// name — rectangle, circle, projected circle — and `slot`/`polygon` matched
// neither that list nor the free-segment list feeding the chain tracer, so they
// fell through both branches in silence. The sidecar never had the bug
// (builder.py: `elif et in ("line","arc","spline","polygon","slot")`), so the
// model builds a slot face fine; only the frontend refused to offer one.
describe("detectRegions — parametric closed primitives (field c2a97cee)", () => {
  it("a slot alone is one region, named by its own entity id", () => {
    const regions = detectRegions("s1", [slot("sl1", -10, 0, 10, 0, 6)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.entityIds).toEqual(["sl1"]);
    expect(regions[0]?.holes).toHaveLength(0);
    // a point on the centreline is material; one past the end cap is not
    expect(pointInRegion(new THREE.Vector2(0, 0), regions[0]!)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(14, 0), regions[0]!)).toBe(false);
  });

  it("the slot loop carries NO repeated closing vertex, unlike its polyline", () => {
    // Every loop in `traced` is stored open — rectCorners and circleLoop return
    // no repeat. entityPolyline is the wrong source for a traced loop for
    // exactly that reason: it wraps the outline in closed(), and `centroidOf` is
    // a plain vertex average, so the repeat weights that vertex twice and drags
    // the label and the `interiorPoint` seed off-centre (measured on this slot:
    // (-0.3030, -0.0909) becomes (-0.5882, 0)).
    const [region] = detectRegions("s1", [slot("sl1", -10, 0, 10, 0, 6)]);
    const loop = region!.loop;
    expect(loop).toHaveLength(entityPolyline(slot("sl1", -10, 0, 10, 0, 6)).length - 1);
    expect(loop[0]!.equals(loop[loop.length - 1]!)).toBe(false);
  });

  it("a polygon alone is one region, named by its own entity id", () => {
    const regions = detectRegions("s1", [polygon("pg1", 0, 0, 10, 6)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.entityIds).toEqual(["pg1"]);
    expect(regions[0]?.loop).toHaveLength(6);
    expect(pointInRegion(new THREE.Vector2(0, 0), regions[0]!)).toBe(true);
  });

  it("a polygon's stored angle is read as DEGREES, not radians", () => {
    // Every other polygon in this file uses angle 0 — the ONE value where the two
    // readings coincide — so the `(e.angle * Math.PI) / 180` in the new branch was
    // asserted by nothing: replacing it with a bare `e.angle` left all 34 tests
    // green. Measured both ways on this pentagon: at 30 degrees the first vertex
    // is (8.6603, 5.0000); read as 30 RADIANS (= 278.87 degrees) it is
    // (1.5425, -9.8803), a differently-oriented pentagon entirely.
    const [region] = detectRegions("s1", [polygon("pg1", 0, 0, 10, 5, 30)]);
    expect(region!.loop[0]!.x).toBeCloseTo(10 * Math.cos(Math.PI / 6), 6);
    expect(region!.loop[0]!.y).toBeCloseTo(5, 6);
    // And behaviourally, so this still bites if the vertex ORDER ever changes:
    // (8.227, 4.750) is 0.95r along the 30-degree vertex ray. The radians
    // pentagon has an edge facing that direction, 8.102 out, so the point falls
    // outside it — measured false under the mutation, true here.
    expect(pointInRegion(new THREE.Vector2(8.227, 4.75), region!)).toBe(true);
  });

  it("a slot fully inside a rectangle is a HOLE in it, not invisible", () => {
    // The reported consequence: extruding the surrounding profile gave a solid
    // block with no slot cut in it, because the slot contributed no loop at all
    // and so could never be nested as a hole.
    const regions = detectRegions("s1", [rect("r1", 0, 0, 100, 60), slot("sl1", -10, 0, 10, 0, 6)]);
    expect(regions).toHaveLength(2);
    const ring = regions.find((r) => r.holes.length > 0)!;
    const inner = regions.find((r) => r.holes.length === 0)!;
    expect(ring.entityIds).toEqual(["r1"]);
    expect(ring.holeEntityIds).toEqual([["sl1"]]);
    expect(inner.entityIds).toEqual(["sl1"]);
    // the ring's material excludes the slot; the slot's own cell is the slot
    expect(pointInRegion(new THREE.Vector2(0, 0), ring)).toBe(false);
    expect(pointInRegion(new THREE.Vector2(0, 0), inner)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(40, 0), ring)).toBe(true);
  });

  // The part of this fix that changes an EXISTING saved document, pinned here so
  // the decision is visible rather than discovered.
  //
  // Any file written before this fix whose profile contained a slot or polygon
  // has a region reference naming the outer entity with NO holes, because the
  // slot contributed no loop and so could not be nested as one. Re-open that
  // extrude and commit anything — a bare depth change is enough — and commit
  // rewrites regionEntities/regionHoleEntities from what the detector now says,
  // so the feature's hole ids appear and the solid changes. That is deliberate:
  // it is a CONVERGENCE, and the FRONTEND was the half that was wrong.
  //
  // Reviewer's fixture and every number below measured on this tree — the
  // frontend halves by running detectRegions against HEAD's region.ts and this
  // one, the sidecar halves by calling builder.rebuild() in-process on the saved
  // document (`regions:[[0,0,0]]`, `regionEntities:[["r1"]]`, distance 10):
  //
  //   PRE-FIX   frontend: ONE region, entityIds ["r1"], no holes, area 800.0000
  //             sidecar:  1482.7433 mm^3 == the SLOT cell (148.2743) x 10
  //   POST-FIX  frontend: ring, entityIds ["r1"], holes [["s1"]], area 652.4834
  //             sidecar:  6517.2567 mm^3 == the ring cell (651.7257) x 10
  //
  // The old pair disagreed by 5.4x and NEITHER half was the rectangle the user
  // picked. Nothing in region.ts moved that build number: the sidecar has always
  // subdivided a slot into its own cell, so the stored point (0,0,0) — the
  // rectangle's centroid at pick time — has always landed in the slot's cell and
  // extruded it. Suppressing this fix would leave that intact, just unexplained.
  // CHANGELOG.md says so out loud, because a saved file changes shape.
  it("a pre-fix reference naming only the rectangle now resolves to the RING", () => {
    const regions = detectRegions("f1", [rect("r1", 0, 0, 40, 20), slot("s1", -10, 0, 10, 0, 6)]);
    // exactly what a pre-fix document recorded for the area: the outer entity,
    // and `[]` for holes — recorded, and claiming there are none.
    const [hit, ...rest] = regionsByEntities(regions, ["r1"], []);
    expect(rest).toHaveLength(0);
    expect(hit!.holeEntityIds).toEqual([["s1"]]);

    // 0.116% under the kernel's ring, and all of that gap is the frontend's
    // polyline standing in for two exact arcs. Both parts measured: 0.1813 mm^2
    // is honest sampling (16 segments per cap: 9*pi = 28.2743 becomes
    // 144*sin(pi/16) = 28.0930), and 0.5764 mm^2 is slotOutline starting its
    // first cap at i=1, which skips the straight top edge and cuts the corner —
    // a separate, pre-existing defect in code this fix did not touch, and it
    // affects the drawn outline too. 0.1813 + 0.5764 = 0.7577, the whole gap.
    const RING_MM3 = 6517.2567; // sidecar rebuild of the re-committed document
    const netArea = loopArea(hit!.loop) - loopArea(hit!.holes[0]!);
    expect(netArea).toBeCloseTo(652.4834, 4); // and so NOT the pre-fix 800
    expect(Math.abs(netArea * 10 - RING_MM3) / RING_MM3).toBeLessThan(0.0012);
  });

  // The ratchet. This is the SECOND type whitelist to drift from the entity
  // union (233e4ae added polygon and slot to the union and to the sidecar, and
  // its commit message claims region.ts too — false for this path), so the next
  // parametric primitive must fail a test rather than ship invisible.
  //
  // TypeScript types are erased, so the union cannot be enumerated at runtime.
  // The enforcement is therefore two-sided: the Record below is keyed by
  // `ResolvedEntity["type"]`, so ADDING a member to the union makes `tsc
  // --noEmit` fail until the author declares it here; and every non-null sample
  // is then asserted at runtime to yield a region when placed alone. What it
  // cannot catch is an author who declares a genuinely closed primitive `null`
  // — that is an explicit false claim rather than the silent omission this
  // exists to stop.
  const soleEntity: Record<ResolvedEntity["type"], ResolvedEntity | null> = {
    rectangle: rect("k", 0, 0, 10, 6),
    circle: circle("k", 0, 0, 5),
    polygon: polygon("k", 0, 0, 10, 5),
    slot: slot("k", -8, 0, 8, 0, 5),
    projected: {
      type: "projected", id: "k",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "circle", x: 0, y: 0, r: 5 },
    },
    // Open on their own: a single line/arc/spline needs other entities to chain
    // with, and a point has no extent at all.
    line: null,
    arc: null,
    spline: null,
    point: null,
    // Text is never part of line/arc region detection — its faces arrive
    // pre-tessellated from the sidecar and become regions via glyphRegion.
    text: null,
  };

  for (const [kind, e] of Object.entries(soleEntity)) {
    if (!e) continue;
    it(`a lone ${kind} yields at least one region`, () => {
      expect(detectRegions("s1", [e]).length).toBeGreaterThanOrEqual(1);
    });
  }
});

// regionsByEntities is how a stored region reference is resolved once the sketch
// has moved: `interior` is a world point and stays behind (field a20cca53), and
// on a holed profile that stale point lands inside the HOLE (field 19314fdc).
// These run against the real tracer, so the id sets under test are the ones the
// tracer actually emits rather than hand-written stand-ins.
describe("regionsByEntities", () => {
  // 100x100 outer / 80x80 inner: two cells, the wall and the inner disk
  const shell = () =>
    detectRegions("s1", [rect("outer", 0, 0, 100, 100), rect("inner", 0, 0, 80, 80)]);

  it("names the WALL by its outer ids, not the cell the stale point would hit", () => {
    const hit = regionsByEntities(shell(), ["outer"], [["inner"]]);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.holes).toHaveLength(1);
  });

  it("the inner disk is a different reference entirely", () => {
    const hit = regionsByEntities(shell(), ["inner"]);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.holes).toHaveLength(0);
  });

  it("id ORDER does not matter — the tracer sorts, the fast path does not", () => {
    // a line across a square: both halves carry {sq, cut} in tracer order
    const regions = detectRegions("s1", [rect("sq", 0, 0, 100, 100), line("cut", -60, 0, 60, 0)]);
    expect(regionsByEntities(regions, ["cut", "sq"])).toHaveLength(2);
    expect(regionsByEntities(regions, ["sq", "cut"])).toHaveLength(2);
  });

  it("holes break a tie but never rule the only candidate out", () => {
    // the wall's holes really are [["inner"]]; claiming otherwise must NOT drop
    // it, because a legacy reference records no holes and one that does may have
    // had a hole added or removed since — and dropping it means falling back to
    // the stored point, which is the corruption.
    expect(regionsByEntities(shell(), ["outer"], [])).toHaveLength(1);
    expect(regionsByEntities(shell(), ["outer"], [["gone"]])).toHaveLength(1);
    expect(regionsByEntities(shell(), ["outer"], undefined)).toHaveLength(1);
  });

  it("hole ORDER does not matter — it follows loop discovery, not the document", () => {
    const regions = detectRegions("s1", [
      rect("outer", 0, 0, 100, 100),
      circle("a", -25, 0, 8),
      circle("b", 25, 0, 8),
    ]);
    const wall = regionsByEntities(regions, ["outer"], [["b"], ["a"]]);
    expect(wall).toHaveLength(1);
    expect(wall[0]!.holes).toHaveLength(2);
  });

  it("hole order does not matter WHERE IT DECIDES — two candidates, two holes each", () => {
    // The test above cannot fail on order: one candidate carries {outer}, so the
    // hole comparison never runs (`narrow` returns early below two candidates).
    // This is the arrangement where the comparison IS the decision — a square
    // split in two, each half carrying TWO circles — so comparing the groups
    // positionally instead of as a set picks the wrong half or neither. Both
    // orderings are asserted: one of them is not loop-discovery order, whichever
    // that happens to be.
    const regions = detectRegions("s1", [
      rect("sq", 0, 0, 200, 200),
      line("cut", -120, 0, 120, 0),
      circle("ha1", -50, 50, 10),
      circle("ha2", 50, 50, 10),
      circle("hb1", -50, -50, 10),
      circle("hb2", 50, -50, 10),
    ]);
    expect(regionsByEntities(regions, ["cut", "sq"])).toHaveLength(2); // the ids tie
    for (const holes of [[["ha1"], ["ha2"]], [["ha2"], ["ha1"]]]) {
      const top = regionsByEntities(regions, ["cut", "sq"], holes);
      expect(top).toHaveLength(1);
      expect(top[0]!.centroid.y).toBeGreaterThan(0);
    }
    for (const holes of [[["hb1"], ["hb2"]], [["hb2"], ["hb1"]]]) {
      const bottom = regionsByEntities(regions, ["cut", "sq"], holes);
      expect(bottom).toHaveLength(1);
      expect(bottom[0]!.centroid.y).toBeLessThan(0);
    }
  });

  it("ids that name nothing live resolve to nothing (the sketch really changed)", () => {
    expect(regionsByEntities(shell(), ["deleted"])).toEqual([]);
    expect(regionsByEntities(shell(), [])).toEqual([]);
  });

  it("a reference naming only SOME of a cell's boundary still matches it", () => {
    // Not set equality: the sidecar's rule is "these edges bound exactly one
    // face", which a partial reference satisfies, and it says so outright
    // ("A reference that names only SOME of its boundary entities also rebuilds
    // bigger than its cell, and there the anchor is right"). Refusing here made
    // drawing ONE line across a saved profile un-reopenable while the model went
    // on building it. Both halves qualify, so the caller's point breaks the tie.
    const regions = detectRegions("s1", [rect("sq", 0, 0, 100, 100), line("cut", -60, 0, 60, 0)]);
    expect(regionsByEntities(regions, ["sq"])).toHaveLength(2);
  });

  it("an EXACT match wins over cells that merely contain the named ids", () => {
    // A big square with a smaller one inside it and one line crossing both. The
    // arrangement traces four cells: two halves of the inner square, bounded by
    // {cut, sq}, and two pieces of the surrounding ring, bounded by
    // {big, cut, sq} — the ring pieces CONTAIN the reference's ids too. A
    // reference saved on the inner square must resolve to the inner square, so
    // the containment tier is only consulted when nothing matches exactly.
    // Without that order the reference can land on a piece of the ring, which is
    // a different profile of a different size.
    const regions = detectRegions("s1", [
      rect("big", 0, 0, 300, 300),
      rect("sq", 0, 0, 100, 100),
      line("cut", -200, 0, 200, 0),
    ]);
    expect(regions.map((r) => r.entityIds)).toEqual([
      ["big", "cut", "sq"],
      ["big", "cut", "sq"],
      ["cut", "sq"],
      ["cut", "sq"],
    ]);
    const hit = regionsByEntities(regions, ["cut", "sq"]);
    expect(hit).toHaveLength(2);
    for (const r of hit) expect(r.entityIds).not.toContain("big");
  });

  it("ids the region no longer carries do NOT match, in either tier", () => {
    // the stored reference names {sq, cut} but `cut` has since been deleted, so
    // the one live cell carries {sq} alone. Neither equal (different sets) nor
    // covering (the cell does not include `cut`), so this refuses — matching a
    // cell bounded by FEWER entities than the reference names would resolve a
    // reference to a profile that is no longer the one it described.
    const regions = detectRegions("s1", [rect("sq", 0, 0, 100, 100)]);
    expect(regions[0]!.entityIds).toEqual(["sq"]);
    expect(regionsByEntities(regions, ["sq", "cut"])).toEqual([]);
  });

  it("holes DISCRIMINATE two cells that share an outer id set", () => {
    // A square split in two, each half carrying its own circular hole. Both
    // halves are bounded by {cut, sq}, so the outer ids cannot tell them apart
    // and the hole ids are the only thing that can — this is the tie the hole
    // rule exists for, and without it both halves come back.
    const regions = detectRegions("s1", [
      rect("sq", 0, 0, 100, 100),
      line("cut", -60, 0, 60, 0),
      circle("ha", 0, 25, 10),
      circle("hb", 0, -25, 10),
    ]);
    expect(regionsByEntities(regions, ["cut", "sq"])).toHaveLength(2);

    const top = regionsByEntities(regions, ["cut", "sq"], [["ha"]]);
    expect(top).toHaveLength(1);
    expect(top[0]!.centroid.y).toBeGreaterThan(0);

    const bottom = regionsByEntities(regions, ["cut", "sq"], [["hb"]]);
    expect(bottom).toHaveLength(1);
    expect(bottom[0]!.centroid.y).toBeLessThan(0);
  });
});
