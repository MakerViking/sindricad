// Box selection, and the two things it must get right.
//
// GH #17: "Add box/rectangle selection to easily select and delete multiple
// elements at once."
//
// 1. WINDOW vs CROSSING by drag direction (left→right / right→left), the
//    convention every mainstream CAD shares. Without it the user needs a
//    modifier for the other half of the job.
// 2. Window containment tested on the SAMPLED CURVE, not on endpoints. An arc
//    whose two ends sit inside the box can bulge entirely out of it, and
//    endpoint-only testing calls that "fully inside" — the kind of wrong that
//    only shows up on curved geometry and looks like a random mis-selection.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { boxFromDrag, entityInBox, entitiesInBox } from "./boxSelect";
import type { ResolvedEntity } from "./snap";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 }) as ResolvedEntity;
const circle = (id: string, x: number, y: number, radius: number): ResolvedEntity =>
  ({ type: "circle", id, x, y, radius }) as ResolvedEntity;

describe("drag direction picks the mode", () => {
  it("left to right is a WINDOW box", () => {
    expect(boxFromDrag(v(0, 0), v(50, 40)).mode).toBe("window");
  });
  it("right to left is a CROSSING box", () => {
    expect(boxFromDrag(v(50, 40), v(0, 0)).mode).toBe("crossing");
  });
  it("normalises the corners either way round", () => {
    const a = boxFromDrag(v(50, 40), v(0, 0));
    expect([a.min.x, a.min.y, a.max.x, a.max.y]).toEqual([0, 0, 50, 40]);
  });
});

describe("window box — only what is entirely inside", () => {
  const b = boxFromDrag(v(0, 0), v(100, 100));

  it("takes a line fully inside", () => {
    expect(entityInBox(line("l", 10, 10, 90, 90), b)).toBe(true);
  });
  it("rejects a line that pokes out", () => {
    expect(entityInBox(line("l", 10, 10, 190, 90), b)).toBe(false);
  });
  it("rejects a line entirely outside", () => {
    expect(entityInBox(line("l", 200, 200, 300, 300), b)).toBe(false);
  });
  it("rejects a CURVE that bulges out even though its ends are inside", () => {
    // THE ONE THAT MATTERS. A big circle centred in the box has no endpoints at
    // all; a naive endpoint test would say "nothing outside, so it's inside".
    expect(entityInBox(circle("c", 50, 50, 400), b)).toBe(false);
    // and a circle that genuinely fits is taken
    expect(entityInBox(circle("c", 50, 50, 20), b)).toBe(true);
  });
});

describe("crossing box — anything it touches", () => {
  const b = boxFromDrag(v(100, 100), v(0, 0)); // right→left

  it("takes a line that merely passes through", () => {
    expect(entityInBox(line("l", -50, 50, 150, 50), b)).toBe(true);
  });
  it("takes a line with one end inside", () => {
    expect(entityInBox(line("l", 50, 50, 500, 500), b)).toBe(true);
  });
  it("still rejects one that misses entirely", () => {
    expect(entityInBox(line("l", 200, 200, 300, 300), b)).toBe(false);
  });
  it("takes a circle whose RIM cuts the box, and not one that merely surrounds it", () => {
    // Geometry worth stating: the box is 100x100 centred at (50,50), so its
    // edges are 50 from the centre and its corners 70.7. Only a rim BETWEEN
    // those two actually crosses an edge.
    expect(entityInBox(circle("c", 50, 50, 60), b)).toBe(true); // cuts all four edges
    // r=80 ENCLOSES the box without touching it — a crossing box selects what it
    // touches, so this is correctly not selected. (I first wrote this case
    // expecting true; the arithmetic says otherwise.)
    expect(entityInBox(circle("c", 50, 50, 80), b)).toBe(false);
    expect(entityInBox(circle("c", 50, 50, 400), b)).toBe(false);
  });
});

describe("entitiesInBox", () => {
  it("returns the ids the box selects, and only those", () => {
    const ents = [
      line("in", 10, 10, 20, 20),
      line("out", 500, 500, 600, 600),
      line("half", 50, 50, 500, 500),
    ];
    expect(entitiesInBox(ents, boxFromDrag(v(0, 0), v(100, 100)))).toEqual(["in"]);
    expect(entitiesInBox(ents, boxFromDrag(v(100, 100), v(0, 0))).sort()).toEqual(["half", "in"]);
  });

  it("takes a sketch POINT by position", () => {
    const pt = { type: "point", id: "p", x: 30, y: 30 } as ResolvedEntity;
    expect(entitiesInBox([pt], boxFromDrag(v(0, 0), v(100, 100)))).toEqual(["p"]);
    expect(entitiesInBox([pt], boxFromDrag(v(200, 200), v(300, 300)))).toEqual([]);
  });
});
