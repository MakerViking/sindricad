// viewport.faceAnchor: the reference stored beside a face-picked sketch plane.
//
// GH #52 — a sketch on a face never moved when the face did, because only the
// resolved plane was stored and nothing named the face. faceAnchor is what the
// pick path now stores alongside it. Two things have to hold, and only one of
// them is obvious:
//
//   1. a PLANAR face yields a by:"nearest" selector carrying the owning BODY.
//      Without the body stamp the sidecar resolves against its active body
//      (_group_sels_by_body), i.e. the silent wrong-body fault this repo has
//      shipped twice — and here it would move a sketch to another body.
//   2. a CURVED face yields null. pickFacePlane returns a tangent plane there
//      quite happily, so this is the only thing standing between "you picked a
//      cylinder" and a sketch that re-derives its plane from whichever triangle
//      of the barrel the tessellation put under the cursor.
//
// Constructing a Viewport needs WebGL, so the method is taken off the prototype
// and given a stand-in `this`. The method body — the planarity loop, the
// tolerance, the body stamp — is the real one.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Viewport } from "./viewport";
import type { PlaneDef, Selector } from "../types";

const TOP: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };

const tri = (...p: [number, number, number][]) =>
  new THREE.Triangle(...(p.map((q) => new THREE.Vector3(...q)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]));

/** A 20x20x20 model box, so the bbox-relative planarity tolerance is a real
 *  number rather than the no-model fallback. */
const MODEL = {
  box: new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 10)),
};

function anchorWith(tris: THREE.Triangle[], bodyId: string | null, hitPoint = [9.5, 0, 10]) {
  const self = {
    model: MODEL,
    pickFaceForPressPull: () => ({
      selector: { kind: "face", by: "nearest", point: hitPoint } as Selector,
      faceId: 7,
      normal: new THREE.Vector3(0, 0, 1),
      anchor: new THREE.Vector3(...(hitPoint as [number, number, number])),
      bodyId,
    }),
    faceTriangles: () => tris,
  };
  return Viewport.prototype.faceAnchor.call(self as never, 100, 100, TOP);
}

// The flat top of the box at z=10 — every vertex exactly on the picked plane.
const FLAT_TOP = [
  tri([-10, -10, 10], [10, -10, 10], [10, 10, 10]),
  tri([-10, -10, 10], [10, 10, 10], [-10, 10, 10]),
];

describe("faceAnchor on a planar face", () => {
  it("returns a by:'nearest' selector stamped with the owning body", () => {
    expect(anchorWith(FLAT_TOP, "body1")).toEqual({
      kind: "face",
      by: "nearest",
      point: [9.5, 0, 10],
      body: "body1",
    });
  });

  it("tolerates float-scale deviation, which a real transformed mesh has", () => {
    const noisy = [tri([-10, -10, 10 + 1e-9], [10, -10, 10 - 1e-9], [10, 10, 10])];
    expect(anchorWith(noisy, "body1")).not.toBeNull();
  });

  it("returns null when the owning body is unknown", () => {
    // An unstamped selector binds to whatever body the sidecar happens to have
    // active. No anchor is today's behaviour; a wrong anchor moves the sketch.
    expect(anchorWith(FLAT_TOP, null)).toBeNull();
  });
});

describe("faceAnchor on a curved face", () => {
  it("returns null for a cylinder barrel", () => {
    // The barrel of an r=10 cylinder, sampled around the axis: a tangent plane
    // touches it at one line and everything else is millimetres away.
    const barrel: THREE.Triangle[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const b = ((i + 1) / 16) * Math.PI * 2;
      barrel.push(
        tri(
          [10 * Math.cos(a), 10 * Math.sin(a), 0],
          [10 * Math.cos(b), 10 * Math.sin(b), 0],
          [10 * Math.cos(a), 10 * Math.sin(a), 10],
        ),
      );
    }
    // picked with the tangent plane the raycast would have produced at (10,0,·)
    const self = {
      model: MODEL,
      pickFaceForPressPull: () => ({
        selector: { kind: "face", by: "nearest", point: [10, 0, 5] } as Selector,
        faceId: 3,
        normal: new THREE.Vector3(1, 0, 0),
        anchor: new THREE.Vector3(10, 0, 5),
        bodyId: "body1",
      }),
      faceTriangles: () => barrel,
    };
    const tangent: PlaneDef = { origin: [10, 0, 0], normal: [1, 0, 0], xdir: [0, 0, 1] };
    expect(Viewport.prototype.faceAnchor.call(self as never, 100, 100, tangent)).toBeNull();
  });

  it("returns null for a face that is only SLIGHTLY off plane", () => {
    // A 0.05 mm step on a 20 mm model: far under anything a user would call
    // curved, and far over the 1e-4 x diagonal the gate allows. This is the
    // assertion that fails first if someone widens the tolerance to "fix" a
    // face that would not anchor.
    const stepped = [tri([-10, -10, 10], [10, -10, 10], [10, 10, 10.05])];
    expect(anchorWith(stepped, "body1")).toBeNull();
  });
});

describe("faceAnchor when nothing is under the cursor", () => {
  it("returns null rather than a selector with no point", () => {
    const self = { model: MODEL, pickFaceForPressPull: () => null, faceTriangles: () => [] };
    expect(Viewport.prototype.faceAnchor.call(self as never, 1, 1, TOP)).toBeNull();
  });
});
