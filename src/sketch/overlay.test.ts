// Rendering contract for projected (linked) reference geometry: the ONE
// curveObjects factory feeds BOTH display paths — the open sketch's active
// curves and the committed model overlay — so asserting its material colors
// here covers stale/link rendering end to end (the stale FLAG's propagation
// into doc entities is covered by the step-4 refresh e2e).
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { curveObjects, SketchOverlay, ENDPOINT_COLOR } from "./overlay";
import { SketchPlane } from "./plane";
import type { ResolvedEntity } from "./snap";

const PROJECTED_COLOR = 0xb07fe8; // purple link color (overlay.ts)
const PROJECTED_STALE_COLOR = 0xd9a24d; // amber: source no longer resolves

const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const matColor = (o: THREE.Object3D): number => {
  // one object per entity; circles/arcs are a group of curve + center marker
  const line = (o as THREE.Group).isGroup ? (o as THREE.Group).children[0] : o;
  return ((line as THREE.Line).material as THREE.LineBasicMaterial).color.getHex();
};

describe("curveObjects — projected link colors", () => {
  const plane = new SketchPlane("XY");
  const fresh: ResolvedEntity = {
    type: "projected", id: "p1", source: SRC, curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
  };
  const stale: ResolvedEntity = { ...fresh, id: "p2", stale: true };

  it("fresh projected renders purple, stale renders amber — regardless of pass color", () => {
    const objs = curveObjects([fresh, stale], plane, 0xffffff);
    expect(objs).toHaveLength(2);
    expect(matColor(objs[0]!)).toBe(PROJECTED_COLOR);
    expect(matColor(objs[1]!)).toBe(PROJECTED_STALE_COLOR);
  });

  it("selection/hover emphasis (highlight) wins over the link color", () => {
    const objs = curveObjects([stale], plane, 0x33aaff, true);
    expect(matColor(objs[0]!)).toBe(0x33aaff);
  });

  it("a broken (now native) line renders in the pass color again", () => {
    const native: ResolvedEntity = { type: "line", id: "p1", x1: 0, y1: 0, x2: 10, y2: 0 };
    const objs = curveObjects([native], plane, 0xffffff);
    expect(matColor(objs[0]!)).toBe(0xffffff);
  });
});

// What you can CLICK must be what you can SEE. pickEndpoint gained rectangle
// corners when the constraint affordance opened; the dots did not follow, so the
// four corners — the only new click targets that change added — were addressable
// and invisible. That is the shape of GH #17, where Coincident read as a dead
// tool precisely because its targets carried no marker.
describe("curveObjects — endpoint dots mark what pickEndpoint can address", () => {
  const plane = new SketchPlane("XY");
  const R = 0.5; // dot half-size, in world units

  // A dot is the only thing drawn in ENDPOINT_COLOR; its centre is the midpoint
  // of its own square outline, so recovering it needs no knowledge of the shape.
  const dotCentres = (objs: THREE.Object3D[]): [number, number][] =>
    objs
      .filter((o) => !(o as THREE.Group).isGroup && matColor(o) === ENDPOINT_COLOR)
      .map((o) => {
        const g = (o as THREE.Line).geometry as THREE.BufferGeometry;
        g.computeBoundingBox();
        const b = g.boundingBox!;
        return [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2];
      });

  const near = (a: [number, number], b: [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

  it("a rectangle carries a dot on each of its four corners", () => {
    const rect: ResolvedEntity = { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 };
    const centres = dotCentres(curveObjects([rect], plane, 0xffffff, false, R));
    // rectCorners' CCW order, which is also dimRefPoints' p 0..3 and therefore
    // the corner indices a constraint names.
    const corners: [number, number][] = [[-20, -10], [20, -10], [20, 10], [-20, 10]];
    expect(centres).toHaveLength(4);
    for (const c of corners) {
      expect(centres.some((d) => near(d, c)), `no dot on corner ${c}`).toBe(true);
    }
  });

  it("CONTROL: a line still gets exactly its two ends, and an arc centre is not a dot", () => {
    // Proves the assertion above discriminates rather than counting whatever is
    // drawn: dimRefPoints returns an arc's CENTRE as p2 (a dimension target, not
    // an endpoint), so a blanket switch to it would put a dot in mid-air here.
    const line: ResolvedEntity = { type: "line", id: "L", x1: 0, y1: 0, x2: 10, y2: 0 };
    const arc: ResolvedEntity = {
      type: "arc", id: "A", x1: 0, y1: 0, x2: 10, y2: 0, mx: 5, my: 5,
    };
    expect(dotCentres(curveObjects([line], plane, 0xffffff, false, R))).toHaveLength(2);
    expect(dotCentres(curveObjects([arc], plane, 0xffffff, false, R))).toHaveLength(2);
  });

  it("the emphasis pass draws no dots, for a rectangle as for everything else", () => {
    const rect: ResolvedEntity = { type: "rectangle", id: "R", x: 0, y: 0, width: 40, height: 20 };
    expect(dotCentres(curveObjects([rect], plane, 0x33aaff, true, R))).toHaveLength(0);
  });
});

// The held-point markers are a POOL, because symmetric holds two points before
// it asks for its axis. Tested here as well as through the constraint flows: the
// flow tests assert what the HOST was told, and would stay green against an
// overlay that was told about two points and drew one.
describe("setPendingPoints — every held point gets a marker", () => {
  const at = (x: number, y: number) => new THREE.Vector3(x, y, 0);

  it("shows one marker per point, and grows for the second", () => {
    const o = new SketchOverlay();
    expect(o.visiblePendingCount()).toBe(0);
    o.setPendingPoints([at(0, 0)]);
    expect(o.visiblePendingCount()).toBe(1);
    o.setPendingPoints([at(0, 0), at(10, 5)]);
    expect(o.visiblePendingCount(), "the second held point drew no marker").toBe(2);
  });

  it("hides the extra marker again when the flow drops back to one point", () => {
    // The pool is reused rather than rebuilt, so a marker left visible from a
    // previous gesture would read as a point that is still held.
    const o = new SketchOverlay();
    o.setPendingPoints([at(0, 0), at(10, 5)]);
    o.setPendingPoints([at(0, 0)]);
    expect(o.visiblePendingCount(), "a stale marker outlived its point").toBe(1);
  });

  it("clears everything on []", () => {
    const o = new SketchOverlay();
    o.setPendingPoints([at(0, 0), at(10, 5)]);
    o.setPendingPoints([]);
    expect(o.visiblePendingCount()).toBe(0);
  });

  it("puts each marker AT its own point, not all at the first", () => {
    const o = new SketchOverlay();
    o.setPendingPoints([at(0, 0), at(10, 5)]);
    const shown = (o.group.children as THREE.Object3D[])
      .filter((c) => c.visible && (c as THREE.Mesh).isMesh)
      .map((c) => [c.position.x, c.position.y]);
    expect(shown).toContainEqual([0, 0]);
    expect(shown, "both markers landed on the same point").toContainEqual([10, 5]);
  });
});
