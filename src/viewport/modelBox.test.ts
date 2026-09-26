// The box the camera is allowed to aim at (modelBox.ts).
//
// Field case, 2026-09: a 340-body Ender 3 assembly whose document box came back
// from the sidecar as ±1e100 mm, because seven imported bodies each had a
// conical face the mesher left untriangulated and OCCT reports an unbounded
// cone's box as open. The viewport made that its model box: Fit put the camera
// ~5.2e100 mm out and the grid at z = -1e100, and the whole view went blank.
// Measured on the BLTouch body (body82): the triangles it DID get span
// ±2.0 x ±2.0 x ±2.5 mm. The ±4.96 mm part below is a stand-in of that order,
// not a measurement.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  MAX_MODEL_COORD_MM,
  boxOfPositions,
  documentBox,
  framingBox,
  isSaneBox,
} from "./modelBox";

const OPEN = 1e100; // what an open OCCT Bnd_Box's Get() returns
const box = (a: number[], b: number[]) =>
  new THREE.Box3(new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(b[0], b[1], b[2]));

/** A mesh whose triangles span exactly `lo`..`hi`, like a body the viewport built. */
function bodyMesh(lo: number[], hi: number[], visible = true): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([lo[0]!, lo[1]!, lo[2]!, hi[0]!, lo[1]!, lo[2]!, hi[0]!, hi[1]!, hi[2]!], 3),
  );
  const m = new THREE.Mesh(geo);
  m.visible = visible;
  return m;
}

describe("which boxes the camera may aim at", () => {
  it("refuses the open box an untriangulated cone face produced", () => {
    // The whole bug in one assertion: ±1e100 is FINITE, so the old
    // Number.isFinite guards all waved it through.
    expect(Number.isFinite(OPEN), "the field value is finite, which is why it got through").toBe(true);
    expect(isSaneBox(box([-OPEN, -OPEN, -OPEN], [OPEN, OPEN, OPEN]))).toBe(false);
    expect(isSaneBox(box([-5, -5, -5], [5, 5, OPEN])), "one open side is enough").toBe(false);
  });

  it("refuses the other ways a box can be junk", () => {
    expect(isSaneBox(null)).toBe(false);
    expect(isSaneBox(new THREE.Box3()), "an empty Box3 (min +Infinity)").toBe(false);
    expect(isSaneBox(box([NaN, 0, 0], [1, 1, 1]))).toBe(false);
    expect(isSaneBox(box([0, 0, 0], [Infinity, 1, 1]))).toBe(false);
    expect(isSaneBox(box([2, 0, 0], [1, 1, 1])), "inside out").toBe(false);
  });

  it("accepts real models, from a single point up to the limit", () => {
    expect(isSaneBox(box([-4.96, -4.96, -4.96], [4.96, 4.96, 4.96]))).toBe(true);
    expect(isSaneBox(box([0, 0, 0], [0, 0, 0])), "a point is degenerate, not junk").toBe(true);
    // a 500 mm printer frame sitting far from the origin
    expect(isSaneBox(box([1200, -300, 0], [1700, 200, 500]))).toBe(true);
    const L = MAX_MODEL_COORD_MM;
    expect(isSaneBox(box([-L, -L, -L], [L, L, L]))).toBe(true);
    expect(isSaneBox(box([-L, -L, -L], [L * 1.0001, L, L]))).toBe(false);
  });

  it("accepts a real part far from the origin, and keeps its triangles", () => {
    // Site coordinates: a 1 m part 20 km out. A first version of this guard
    // capped coordinates at 1e7 mm, so the box was refused, every vertex was
    // skipped as junk, and Fit could never reach the part.
    const far = box([2e7 - 500, -500, -500], [2e7 + 500, 500, 500]);
    expect(isSaneBox(far), "a far but real box was taken for OCCT's sentinel").toBe(true);
    const b = boxOfPositions([2e7 - 500, -500, -500, 2e7 + 500, 500, 500]);
    expect(b.isEmpty(), "the far part's vertices were skipped as junk").toBe(false);
    expect(b.max.x).toBe(2e7 + 500);
  });
});

describe("the model box a finished reply gets", () => {
  // Two triangles' worth of positions, for a small part like the BLTouch body.
  const positions = new Float32Array([-4.96, -4.96, 0, 4.96, -4.96, 0, 4.96, 4.96, 9.5]);

  it("is measured from the triangles when the sidecar's box is open", () => {
    const { box: b, fromMesh } = documentBox(
      { min: [-OPEN, -OPEN, -OPEN], max: [OPEN, OPEN, OPEN] },
      positions,
    );
    expect(fromMesh).toBe(true);
    expect(isSaneBox(b), "the model box is still ±1e100: the camera would be thrown out").toBe(true);
    expect(b.min.x).toBeCloseTo(-4.96, 4);
    expect(b.max.x).toBeCloseTo(4.96, 4);
    expect(b.max.z).toBeCloseTo(9.5, 4);
  });

  it("is measured from the triangles when there is no box at all", () => {
    // The wire sends `bbox: null` for an empty build; typed as always present.
    const { box: b, fromMesh } = documentBox(null, positions);
    expect(fromMesh).toBe(true);
    expect(b.max.y).toBeCloseTo(4.96, 4);
  });

  it("is the sidecar's own box, untouched, whenever that box is sane", () => {
    // The scan is O(vertices); a healthy reply must not pay it, and must not
    // have its (padded) box second-guessed either.
    const { box: b, fromMesh } = documentBox({ min: [-5.2, -5.2, -0.25], max: [5.2, 5.2, 9.75] }, positions);
    expect(fromMesh).toBe(false);
    expect(b.min.toArray()).toEqual([-5.2, -5.2, -0.25]);
    expect(b.max.toArray()).toEqual([5.2, 5.2, 9.75]);
  });

  it("skips a junk vertex rather than letting it stretch the box", () => {
    const b = boxOfPositions([1, 2, 3, 1e100, 0, 0, NaN, 0, 0, -1, -2, -3]);
    expect(b.min.toArray()).toEqual([-1, -2, -3]);
    expect(b.max.toArray()).toEqual([1, 2, 3]);
  });
});

describe("what Fit frames", () => {
  it("frames only the visible bodies, the way Fit after Isolate should", () => {
    const isolated = bodyMesh([0, 0, 0], [10, 10, 10]);
    const hidden = [bodyMesh([500, 500, 0], [600, 600, 50], false), bodyMesh([-900, 0, 0], [-800, 5, 5], false)];
    const b = framingBox([isolated, ...hidden]);
    expect(b.min.toArray(), "Fit framed hidden bodies too").toEqual([0, 0, 0]);
    expect(b.max.toArray()).toEqual([10, 10, 10]);
  });

  it("frames every body when none is visible, so Fit still goes somewhere", () => {
    const b = framingBox([bodyMesh([0, 0, 0], [1, 1, 1], false), bodyMesh([5, 5, 5], [6, 6, 6], false)]);
    expect(b.min.toArray()).toEqual([0, 0, 0]);
    expect(b.max.toArray()).toEqual([6, 6, 6]);
  });

  it("frames a body where it is drawn, not where its triangles were built", () => {
    // A Move ghost offsets the mesh, not its vertices.
    const moved = bodyMesh([0, 0, 0], [1, 1, 1]);
    moved.position.set(100, 0, 0);
    const b = framingBox([moved]);
    expect(b.min.x).toBe(100);
    expect(b.max.x).toBe(101);
  });

  it("ignores a body whose own box is junk", () => {
    const b = framingBox([bodyMesh([0, 0, 0], [2, 2, 2]), bodyMesh([0, 0, 0], [OPEN, 0, 0])]);
    expect(b.max.x).toBe(2);
  });

  it("is empty when there is nothing to frame", () => {
    expect(framingBox([]).isEmpty()).toBe(true);
    expect(framingBox([new THREE.Mesh(new THREE.BufferGeometry())]).isEmpty(), "a body with no triangles").toBe(true);
  });
});
