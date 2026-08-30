// The sketch grid must rescale with zoom, and you must snap to the lines you see.
//
// Field report (2026-08-24, Doug, via Thomas): the grid was being treated as a
// visual aid only. It was worse than that. `addGrid()` built one
// `GridHelper(400, 80)` on sketch entry and never touched it again: 5 mm cells
// over a 400 mm square, fixed forever. Zoom out past 400 mm and the grid simply
// ran out. Zoom in to draw a 2 mm feature and the cells were still 5 mm, so the
// finest thing you could snap to was 5 mm no matter how close you got.
//
// It also made grid snapping behave completely differently at different zooms
// without anything saying so: `snap()` only accepts a grid point within 10 px of
// the cursor, so at high zoom the 5 mm points were too far apart to ever catch,
// and at low zoom they were sub-pixel dense and caught everything.
//
// Two invariants below, and the second is the one that is invisible if it breaks:
// the visual grid is recentred on the view, and if it were recentred by anything
// other than a whole multiple of the cell it would draw lines that are NOT the
// lines snap() rounds to. You would see a grid, snap "to it", and land somewhere
// else — with no error and nothing on screen to explain it.

import { describe, it, expect } from "vitest";
import { gridScaleFor } from "./sketchMode";
import { niceStep } from "../ui/units";

describe("sketch grid scale", () => {
  it("uses the same cell expression as the ground grid", () => {
    // If these two ever disagree, the lattice appears to jump the moment a
    // sketch closes and the world grid comes back.
    for (const wpp of [0.001, 0.01, 0.05, 0.2, 1, 5, 20]) {
      expect(gridScaleFor(wpp, 0, 0).cell).toBe(niceStep(wpp * 64));
    }
  });

  it("gets FINER as you zoom in", () => {
    const zoomedOut = gridScaleFor(2, 0, 0).cell;
    const mid = gridScaleFor(0.2, 0, 0).cell;
    const zoomedIn = gridScaleFor(0.01, 0, 0).cell;
    expect(zoomedIn).toBeLessThan(mid);
    expect(mid).toBeLessThan(zoomedOut);
    // the old behaviour: 5 mm at every zoom, forever
    expect(new Set([zoomedOut, mid, zoomedIn]).size).toBe(3);
  });

  it("keeps the drawn lines ON the snap lattice, wherever the view is", () => {
    // THE INVARIANT. snap() rounds plane-local coords to multiples of the cell
    // off the plane origin. So the grid's centre must itself be a multiple of
    // the cell, or every line on screen is offset from every point you can snap
    // to — visible as a grid you cannot land on, with no error.
    for (const wpp of [0.005, 0.03, 0.4, 3]) {
      for (const [x, y] of [[0, 0], [1, -1], [37.213, -812.7], [-0.4, 0.4], [1e4, 1e4]]) {
        const { cell, cx, cy } = gridScaleFor(wpp, x!, y!);
        const offBy = (v: number) => Math.abs(v / cell - Math.round(v / cell));
        expect(offBy(cx), `cx ${cx} is not a whole multiple of cell ${cell}`).toBeLessThan(1e-9);
        expect(offBy(cy), `cy ${cy} is not a whole multiple of cell ${cell}`).toBeLessThan(1e-9);
      }
    }
  });

  it("tracks the view rather than staying pinned at the plane origin", () => {
    // The old grid sat at the plane origin with a 400 mm extent, so panning far
    // enough left you with no grid at all.
    const near = gridScaleFor(0.2, 0, 0);
    const far = gridScaleFor(0.2, 5000, -5000);
    expect(far.cx).not.toBe(near.cx);
    expect(far.cy).not.toBe(near.cy);
    expect(far.cell).toBe(near.cell); // panning is not zooming
  });

  it("is memoised, because the render loop calls it every frame", () => {
    const a = gridScaleFor(0.2, 10, 10);
    const b = gridScaleFor(0.2, 10.4, 9.6); // same cell, same rounded centre
    expect(b.key).toBe(a.key);
    // and changes when it must
    expect(gridScaleFor(0.02, 10, 10).key).not.toBe(a.key);
  });
});
