// Closing a spline on itself (TA 848b5ed1: "Cannot close a spline on itself").
//
// The spline tool finished only on the LAST point (or Enter), and the points
// being placed were no snap target, so a spline closed only when a click
// happened to land exactly on its start, and then with a kink: the curve was
// open, its first and last points merely equal. Now the start is offered to
// the snap once a click there can close, that click closes it, and the curve
// wraps round with no kink (`closed`), in the drawing, the profile shading and
// the model alike.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import * as THREE from "three";
import { liveSketch, PX } from "./liveSketch.testkit";
import type { ResolvedEntity, SnapCandidate } from "./snap";
import { SketchMode } from "./sketchMode";
import { splinePolyline } from "./spline";
import { detectRegions, entityPolyline } from "./region";
import { dimRefPoints } from "./entityDims";
import { checkSketch } from "./check";
import { bodyDragFrame, offsetEntity, signedOffsetAt } from "./modify";
import { translated } from "./pattern";
import { compileAndSolve } from "./sketchSolve";

type Spline = Extract<ResolvedEntity, { type: "spline" }>;
const shoelace = (pts: { x: number; y: number }[]) =>
  Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]!; return a + p.x * q.y - q.x * p.y; }, 0)) / 2;

/** A live sketch whose snapping is the real one: SketchMode's own snapAt,
 *  over the candidates it offers, on a screen that is the plane scaled by PX.
 *  The testkit swaps snapAt for one that never snaps; this puts the real one
 *  back and gives it the two viewport calls it makes. */
function drawingSketch() {
  const live = liveSketch([]);
  const s = live.s as unknown as {
    candidates: SnapCandidate[];
    splinePts: THREE.Vector2[];
    snapAt: unknown;
    viewport: object;
    gridSnap: boolean;
    tool: string;
  };
  s.candidates = [];
  s.splinePts = []; // a field initialiser the testkit does not run
  s.gridSnap = false;
  s.snapAt = (SketchMode.prototype as unknown as { snapAt: unknown }).snapAt;
  Object.assign(s.viewport, {
    screenToPlane: (cx: number, cy: number) => new THREE.Vector3(cx / PX, cy / PX, 0),
    projectToScreen: (w: THREE.Vector3) => ({ x: w.x * PX, y: w.y * PX }),
  });
  s.tool = "spline";
  return live;
}
const drawn = (live: ReturnType<typeof liveSketch>) =>
  live.s.entities.filter((e): e is Spline => e.type === "spline");

describe("the spline tool closes on its first point", () => {
  it("a click NEAR the first point, once there are three, snaps onto it and closes the spline", async () => {
    const live = drawingSketch();
    live.click(0, 0);
    live.click(20, 0);
    live.click(10, 15);
    live.click(0.3, -0.2); // 3-4 px off the start: the snap takes it there
    await live.settle();
    const [sp, ...more] = drawn(live);
    expect(more).toEqual([]);
    expect(sp).toMatchObject({ closed: true, asDrawn: true });
    expect(sp!.points, "the start is not repeated at the end").toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 15 }]);
  });

  it("with only two points the start is no target: the click is a third point", async () => {
    const live = drawingSketch();
    live.click(0, 0);
    live.click(20, 0);
    live.click(0.3, -0.2);
    // the last point again: finish, open. It is within snap reach of the
    // start too, which must not steal the click it is further from.
    live.click(0.32, -0.21);
    await live.settle();
    const [sp] = drawn(live);
    expect(sp?.closed).toBeUndefined();
    expect(sp?.points).toHaveLength(3);
    expect(sp?.points[2]).toEqual({ x: 0.3, y: -0.2 });
  });

  it("an open spline still finishes on its last point, built as drawn", async () => {
    const live = drawingSketch();
    live.click(0, 0);
    live.click(20, 0);
    live.click(30, 10);
    live.click(30, 10);
    await live.settle();
    const [sp] = drawn(live);
    expect(sp).toEqual({ type: "spline", id: sp!.id, asDrawn: true, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 10 }] });
  });
});

describe("a closed spline is one smooth loop everywhere it is read", () => {
  const blob: Spline = { type: "spline", id: "b", asDrawn: true, closed: true, points: [
    { x: 0, y: 0 }, { x: 20, y: -4 }, { x: 34, y: 8 }, { x: 22, y: 22 }, { x: 2, y: 16 },
  ] };
  /** the same points, not closed */
  const openBlob: Spline = { type: "spline", id: "b", asDrawn: true, points: blob.points };

  it("its polyline runs through every point, back to the first, with no kink there", () => {
    const poly = splinePolyline(blob.points, 16, true);
    expect(poly).toHaveLength(blob.points.length * 16 + 1);
    expect(poly.at(-1)!.equals(poly[0]!)).toBe(true);
    for (const p of blob.points) expect(poly.some((q) => q.x === p.x && q.y === p.y)).toBe(true);
    // the way in to the start and the way out of it, sampled finely
    const turnAtStart = (pts: THREE.Vector2[]) => {
      const into = pts.at(-1)!.clone().sub(pts.at(-2)!).normalize();
      const out = pts[1]!.clone().sub(pts[0]!).normalize();
      return into.angleTo(out);
    };
    expect(turnAtStart(splinePolyline(blob.points, 512, true))).toBeLessThan(0.01);
    // the old way to close one, an open spline back onto its start, kinks there
    const c0 = splinePolyline([...blob.points, blob.points[0]!], 512, false);
    expect(turnAtStart(c0)).toBeGreaterThan(0.5);
  });

  it("is a profile on its own, and the area the sketch shades is the model's", () => {
    const regions = detectRegions("s", [blob]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.entityIds).toEqual(["b"]);
    // the sidecar's exact area for this curve (test_spline_as_drawn.py, BLOB):
    // 732.6667 mm2, which 16 samples a span get to within 0.1%
    expect(shoelace(regions[0]!.loop)).toBeCloseTo(731.956, 2);
    expect(Math.abs(shoelace(regions[0]!.loop) - 732.6667) / 732.6667).toBeLessThan(1e-3);
  });

  it("Sketch > Check finds no open end on it, and no crossing at its seam", () => {
    expect(checkSketch([blob])).toEqual([]);
    // the same points left open DO have two open ends
    expect(checkSketch([openBlob]).length).toBeGreaterThan(0);
  });

  it("a line from its first point leaves the loop whole", () => {
    const regions = detectRegions("s", [blob, { type: "line", id: "l", x1: 0, y1: 0, x2: -20, y2: -10 }]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.entityIds).toEqual(["b"]);
  });

  it("exposes ONE point, its first, and no ends to chain or drag apart", () => {
    expect(dimRefPoints(blob).map((r) => r.p)).toEqual([0]);
    expect(dimRefPoints(openBlob).map((r) => r.p)).toEqual([0, 1]);
  });

  it("keeps closed and as-drawn through a solve, a drag, a move and an offset", async () => {
    const r = await compileAndSolve([blob], [{ type: "fix", e: "b", p: 0 }]);
    expect(r.entities[0]).toMatchObject({ closed: true, asDrawn: true });
    const dragged = bodyDragFrame([blob], 0, 5, 5, []);
    expect(dragged?.[0]).toMatchObject({ closed: true, asDrawn: true });
    expect(translated(blob, 1, 1, "c")).toMatchObject({ closed: true, asDrawn: true });
    const off = offsetEntity([blob], 0, 2);
    expect(off?.entities.at(-1)).toMatchObject({ type: "spline", closed: true, asDrawn: true });
  });

  it("the Offset tool measures a closed spline's closing span too", () => {
    // just outside the span from the last point (2,16) back to the first
    // (0,0): 3.97 mm from it, and 8.5 from the nearest OTHER chord
    const d = signedOffsetAt(blob, new THREE.Vector2(-3, 8))!;
    expect(Math.abs(d)).toBeCloseTo(3.969, 3);
    // and offsetting by it grows the loop out to the cursor (the blob runs
    // CCW, so outside is its right, the negative side)
    expect(d).toBeLessThan(0);
    const copy = offsetEntity([blob], 0, d)!.entities.at(-1) as Spline;
    expect(shoelace(entityPolyline(copy))).toBeGreaterThan(shoelace(entityPolyline(blob)));
  });

  it("its last fit point is an interior point: nothing that ends there is fused to it", async () => {
    // an open spline's last point is an END, which merges with whatever ends
    // on it; a closed spline's last is just one more point along the curve,
    // like any interior one (sketchSolve's header). Drag it: the line stays.
    const line: ResolvedEntity = { type: "line", id: "l", x1: 2, y1: 16, x2: -10, y2: 30 };
    const r = await compileAndSolve([blob, line], [], { fromX: 2, fromY: 16, toX: 0, toY: 20 });
    const sp = r.entities[0] as Spline;
    expect(sp.points[0]).toEqual({ x: 0, y: 0 });
    expect(sp.points[4]!.x).toBeCloseTo(0, 6);
    expect(sp.points[4]!.y).toBeCloseTo(20, 6);
    expect(r.entities[1]).toEqual(line);
  });
});
