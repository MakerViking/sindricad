import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SketchPlane } from "./plane";

describe("SketchPlane base planes", () => {
  it("XY has the identity basis and a Z normal", () => {
    const p = new SketchPlane("XY");
    expect([p.u.x, p.u.y, p.u.z]).toEqual([1, 0, 0]);
    expect([p.v.x, p.v.y, p.v.z]).toEqual([0, 1, 0]);
    expect([p.n.x, p.n.y, p.n.z]).toEqual([0, 0, 1]);
    expect(p.key).toBe("XY");
    expect(p.base).toBe("XY");
    expect(p.serialize()).toBe("XY");
  });
  it("XZ normal points along -Y", () => {
    const n = new SketchPlane("XZ").n;
    expect(n.x).toBeCloseTo(0);
    expect(n.y).toBeCloseTo(-1);
    expect(n.z).toBeCloseTo(0);
  });
  it("YZ normal points along +X", () => {
    const n = new SketchPlane("YZ").n;
    expect(n.x).toBeCloseTo(1);
    expect(n.y).toBeCloseTo(0);
  });
  it("to2D and to3D round-trip", () => {
    const p = new SketchPlane("XY");
    const world = p.to3D(3, 4);
    expect([world.x, world.y, world.z]).toEqual([3, 4, 0]);
    const flat = p.to2D(world);
    expect(flat.x).toBeCloseTo(3);
    expect(flat.y).toBeCloseTo(4);
  });
});

describe("SketchPlane from a PlaneDef", () => {
  const spec = { origin: [1, 2, 3] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xdir: [1, 0, 0] as [number, number, number] };
  it("builds an orthonormal basis at the given origin", () => {
    const p = new SketchPlane(spec);
    expect([p.origin.x, p.origin.y, p.origin.z]).toEqual([1, 2, 3]);
    expect(p.v.y).toBeCloseTo(1); // n x u = (0,0,1)x(1,0,0) = (0,1,0)
    expect(p.base).toBeNull();
    expect(p.key).toBe(JSON.stringify(spec));
  });
  it("to2D is relative to the origin", () => {
    const flat = new SketchPlane(spec).to2D(new THREE.Vector3(4, 2, 3));
    expect(flat.x).toBeCloseTo(3); // 4-1 along u
    expect(flat.y).toBeCloseTo(0); // 2-2 along v
  });
  it("basisMatrix and orientation are callable and place the origin", () => {
    const m = new SketchPlane(spec).basisMatrix();
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    expect([pos.x, pos.y, pos.z]).toEqual([1, 2, 3]);
    expect(new SketchPlane(spec).basisMatrix(-1)).not.toBe(m); // flipped normal path
    expect(new SketchPlane(spec).orientation()).toBeInstanceOf(THREE.Quaternion);
  });
});
