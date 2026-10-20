// planeFromFace: the sketch frame of a planar face, as a pure function, so a
// sketch placed on a face WITHOUT a click (an agent's "sketch on this face",
// AI-control plan W0) gets the same origin, U and V as the user clicking that
// face: the same grid, and the same local coordinates for the same point.
//
// Both viewport routes to a face plane are entered for real, off the prototype
// with a stand-in `this` (constructing a Viewport needs WebGL): the raycast
// click (pickFacePlane) and the already-selected face (selectedFaceSketchPlane).
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Viewport } from "./viewport";
import { planeFromFace } from "../sketch/plane";
import type { PlaneDef } from "../types";

/** A face tilted off every axis, on a mesh that is itself moved and turned, so
 *  both the Gram-Schmidt step and the mesh's world transform are exercised. */
const n = new THREE.Vector3(1, 2, 3).normalize();
const p0 = new THREE.Vector3(4, -2, 7);
const inPlane = (u: number, v: number) => {
  const a = new THREE.Vector3(0, 0, 1).sub(n.clone().multiplyScalar(n.z)).normalize();
  const b = n.clone().cross(a);
  return p0.clone().addScaledVector(a, u).addScaledVector(b, v);
};
const WORLD = [inPlane(0, 0), inPlane(10, 0), inPlane(0, 10)];

function clickedFace(): PlaneDef | null {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  mesh.position.set(5, 6, -3);
  mesh.rotation.set(0.3, -0.7, 1.1);
  mesh.updateMatrixWorld(true);
  // the triangle stored in the mesh's LOCAL space, so the method's own
  // transformDirection is what brings its normal back to world
  const toLocal = mesh.matrixWorld.clone().invert();
  const local = WORLD.map((w) => w.clone().applyMatrix4(toLocal));
  mesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute(local.flatMap((v) => [v.x, v.y, v.z]), 3));
  const self = {
    model: {},
    modelHitsAt: () => ({ hits: [{ face: { a: 0, b: 1, c: 2 }, object: mesh, point: inPlane(3, 2) }] }),
  };
  return Viewport.prototype.pickFacePlane.call(self as never, 100, 100);
}

function selectedFace(): PlaneDef | null {
  const tri = new THREE.Triangle(WORLD[0]!.clone(), WORLD[1]!.clone(), WORLD[2]!.clone());
  const self = {
    model: { box: new THREE.Box3(new THREE.Vector3(-20, -20, -20), new THREE.Vector3(20, 20, 20)) },
    selectedFacesForPressPull: () => ({
      faceIds: [7],
      bodyId: "body1",
      selectors: [{ kind: "face", by: "nearest", point: [0, 0, 0] }],
      normal: n.clone(),
      anchor: inPlane(1, 1),
    }),
    faceTriangles: () => [tri],
  };
  return Viewport.prototype.selectedFaceSketchPlane.call(self as never)?.plane ?? null;
}

const expectSameFrame = (a: PlaneDef | null, b: PlaneDef) => {
  expect(a).not.toBeNull();
  for (const k of ["origin", "normal", "xdir"] as const) {
    a![k].forEach((x, i) => expect(x, `${k}[${i}]`).toBeCloseTo(b[k][i]!, 5));
  }
};

describe("planeFromFace", () => {
  it("gives the frame a click on the face gives", () => {
    expectSameFrame(clickedFace(), planeFromFace([n.x, n.y, n.z], [p0.x, p0.y, p0.z]));
  });

  it("gives the frame selecting the face gives", () => {
    expectSameFrame(selectedFace(), planeFromFace([n.x, n.y, n.z], [p0.x, p0.y, p0.z]));
  });

  it("puts the origin at the world origin projected onto the face, whatever point of the face it is given", () => {
    const a = planeFromFace([0, 0, 2], [3, 4, 10]);
    const b = planeFromFace([0, 0, 1], [-8, 1, 10]);
    expect(a).toEqual(b);
    expect(a.origin).toEqual([0, 0, 10]);
    expect(a.normal).toEqual([0, 0, 1]);
    expect(a.xdir).toEqual([1, 0, 0]);
  });

  it("takes world Z as the reference for U on a wall, so U runs up it", () => {
    const wall = planeFromFace([1, 0, 0], [5, 3, 2]);
    expect(wall.origin).toEqual([5, 0, 0]);
    wall.xdir.forEach((x, i) => expect(x).toBeCloseTo([0, 0, 1][i]!, 12));
  });
});
