// viewport.selectedFaceSketchPlane: the sketch plane of a face the user has
// ALREADY selected, so the Sketch button can honour a pre-selection instead of
// asking for the same face a second time (reported: "select the face, hit
// Sketch, and it wants me to pick the face again").
//
// Three things have to hold, and only the first is obvious:
//
//   1. the plane's origin is the GLOBAL origin projected onto the face plane,
//      NOT the face's own centroid. Grid snapping rounds in plane-local
//      coordinates, so anchoring on the face gives that sketch its own lattice,
//      offset from the model's by a tessellation-dependent fraction of a
//      millimetre (the 2026-08-02 report quoted at pickFacePlane). The faces
//      below are deliberately OFF-CENTRE, so a centroid origin fails here.
//   2. a curved face, more than one face, or an unknown owning body yields
//      null — the caller then falls back to the interactive pick, which prompts.
//      A tangent plane has no frame to follow (see faceAnchor) and an unstamped
//      face selector resolves against the sidecar's ACTIVE body.
//   3. pre-selecting a face and CLICKING it produce the same plane. Two recipes
//      for one frame is how the two routes drift into different U/V axes and
//      different grids for the same face, which the user reads as a bug.
//
// Constructing a Viewport needs WebGL, so the methods are taken off the
// prototype and given a stand-in `this` (same style as faceAnchor.test.ts). The
// bodies — the planarity gate, the origin projection, the gram-schmidt xdir —
// are the real ones.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Viewport } from "./viewport";
import type { Selector } from "../types";

const tri = (...p: [number, number, number][]) =>
  new THREE.Triangle(...(p.map((q) => new THREE.Vector3(...q)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]));

/** A 20x20x20 model box, so the bbox-relative planarity tolerance is a real
 *  number rather than the no-model fallback. */
const MODEL = {
  box: new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 10)),
  bodies: [],
};

/** A flat face at z=10 sitting in the +x/+y quadrant: its centroid is (5,5,10),
 *  which is NOT the projected global origin (0,0,10). */
const OFF_CENTRE_TOP = [
  tri([0, 0, 10], [10, 0, 10], [10, 10, 10]),
  tri([0, 0, 10], [10, 10, 10], [0, 10, 10]),
];

/** A slice of a barrel: the vertices are nowhere near one plane. */
const BARREL = [
  tri([10, 0, 0], [9.24, 3.83, 0], [10, 0, 10]),
  tri([9.24, 3.83, 0], [7.07, 7.07, 0], [9.24, 3.83, 10]),
];

function planeWith(opts: {
  tris: THREE.Triangle[];
  bodyId?: string | null;
  faceIds?: number[];
  normal?: [number, number, number];
  anchor?: [number, number, number];
  selected?: boolean;
}) {
  const anchor = opts.anchor ?? [5, 5, 10];
  const self = {
    model: MODEL,
    selectedFacesForPressPull: () =>
      opts.selected === false
        ? null
        : {
            selectors: (opts.faceIds ?? [7]).map(
              () => ({ kind: "face", by: "nearest", point: anchor }) as Selector,
            ),
            faceIds: opts.faceIds ?? [7],
            normal: new THREE.Vector3(...(opts.normal ?? [0, 0, 1])),
            anchor: new THREE.Vector3(...anchor),
            bodyId: opts.bodyId === undefined ? "body1" : opts.bodyId,
          },
    faceTriangles: () => opts.tris,
  };
  return Viewport.prototype.selectedFaceSketchPlane.call(self as never);
}

describe("selectedFaceSketchPlane with one planar face selected", () => {
  it("puts the plane origin on the projected global origin, not the face centroid", () => {
    const got = planeWith({ tris: OFF_CENTRE_TOP });
    expect(got?.plane).toEqual({
      origin: [0, 0, 10],
      normal: [0, 0, 1],
      xdir: [1, 0, 0],
    });
  });

  it("returns the face selector stamped with the owning body", () => {
    expect(planeWith({ tris: OFF_CENTRE_TOP })?.face).toEqual({
      kind: "face",
      by: "nearest",
      point: [5, 5, 10],
      body: "body1",
    });
  });

  it("tolerates float-scale deviation, which a real transformed mesh has", () => {
    const noisy = [tri([0, 0, 10 + 1e-9], [10, 0, 10 - 1e-9], [10, 10, 10])];
    expect(planeWith({ tris: noisy })).not.toBeNull();
  });
});

describe("selectedFaceSketchPlane declines, so the caller can fall back to the pick", () => {
  it("returns null with nothing selected", () => {
    expect(planeWith({ tris: OFF_CENTRE_TOP, selected: false })).toBeNull();
  });

  it("returns null with more than one face selected", () => {
    // Two faces name two planes; picking the first silently would be a guess.
    expect(planeWith({ tris: OFF_CENTRE_TOP, faceIds: [7, 8] })).toBeNull();
  });

  it("returns null on a curved face", () => {
    expect(planeWith({ tris: BARREL, anchor: [10, 0, 5] })).toBeNull();
  });

  it("returns null when the owning body is unknown", () => {
    // An unstamped selector binds to whatever body the sidecar has active.
    expect(planeWith({ tris: OFF_CENTRE_TOP, bodyId: null })).toBeNull();
  });
});

describe("pre-selecting a face and clicking it agree", () => {
  // A tilted face in the plane y + z = 20, so origin/xdir are non-trivial and a
  // disagreement in either shows up.
  const A: [number, number, number] = [0, 0, 20];
  const B: [number, number, number] = [10, 0, 20];
  const C: [number, number, number] = [10, 10, 10];
  const D: [number, number, number] = [0, 10, 10];
  const TILTED = [tri(A, B, C), tri(A, C, D)];
  // what faceNormalWorld/faceCentroidWorld would report for it
  const NORMAL: [number, number, number] = [0, Math.SQRT1_2, Math.SQRT1_2];
  const CENTROID: [number, number, number] = [20 / 3, 10 / 3, 50 / 3];

  /** pickFacePlane's own path, fed one hit triangle (A,B,C) and a hit point on
   *  the face — the click route, unmodified. */
  function clickedPlane() {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([...A, ...B, ...C, ...D], 3),
    );
    const mesh = new THREE.Mesh(geom);
    mesh.updateMatrixWorld(true);
    const hit = {
      object: mesh,
      face: { a: 0, b: 1, c: 2 },
      point: new THREE.Vector3(2, 4, 16), // on the face: y + z = 20
    };
    const self = {
      model: MODEL,
      rayFrom: () => ({ intersectObjects: () => [hit] }),
    };
    return Viewport.prototype.pickFacePlane.call(self as never, 100, 100);
  }

  it("yields the same plane through both routes", () => {
    const clicked = clickedPlane();
    const preselected = planeWith({ tris: TILTED, normal: NORMAL, anchor: CENTROID })?.plane;
    expect(clicked).not.toBeNull();
    expect(preselected).toBeDefined();
    // Within a tolerance, not equal: the two normals come from different sums
    // (one hit triangle's winding vs an area-weighted average of all of them).
    for (const key of ["origin", "normal", "xdir"] as const) {
      for (let i = 0; i < 3; i++) {
        expect(preselected![key][i]!).toBeCloseTo(clicked![key][i]!, 6);
      }
    }
  });
});
