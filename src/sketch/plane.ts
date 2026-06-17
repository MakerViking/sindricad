// A sketch plane as origin + orthonormal basis (u, v, n). u = sketch +X, v =
// sketch +Y, n = normal. This lets us convert a 3D hit into stable 2D sketch
// coordinates and back, uniformly for any plane (base planes now, faces later).

import * as THREE from "three";
import type { Plane3, PlaneSpec } from "../types";

export class SketchPlane {
  origin = new THREE.Vector3();
  u = new THREE.Vector3(1, 0, 0);
  v = new THREE.Vector3(0, 1, 0);
  n = new THREE.Vector3(0, 0, 1);
  readonly spec: PlaneSpec; // base-plane id or a PlaneDef, for serialization + cache key
  private math = new THREE.Plane();

  constructor(spec: PlaneSpec) {
    this.spec = spec;
    if (typeof spec === "string") {
      switch (spec) {
        case "XY":
          this.u.set(1, 0, 0);
          this.v.set(0, 1, 0);
          break;
        case "XZ":
          this.u.set(1, 0, 0);
          this.v.set(0, 0, 1);
          break;
        case "YZ":
          this.u.set(0, 1, 0);
          this.v.set(0, 0, 1);
          break;
      }
      this.n.copy(this.u).cross(this.v).normalize();
    } else {
      this.origin.set(...spec.origin);
      this.n.set(...spec.normal).normalize();
      this.u.set(...spec.xdir).normalize();
      this.v.copy(this.n).cross(this.u).normalize();
    }
    this.math.setFromNormalAndCoplanarPoint(this.n, this.origin);
  }

  /** the document value for this plane (base-plane id or PlaneDef) */
  serialize(): PlaneSpec {
    return this.spec;
  }

  /** stable cache key */
  get key(): string {
    return typeof this.spec === "string" ? this.spec : JSON.stringify(this.spec);
  }

  /** is this a base origin plane (vs a derived face/offset plane)? */
  get base(): Plane3 | null {
    return typeof this.spec === "string" ? this.spec : null;
  }

  get plane(): THREE.Plane {
    return this.math;
  }

  /** world point -> 2D sketch coords */
  to2D(p: THREE.Vector3, out = new THREE.Vector2()): THREE.Vector2 {
    const d = p.clone().sub(this.origin);
    return out.set(d.dot(this.u), d.dot(this.v));
  }

  /** 2D sketch coords -> world point */
  to3D(x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.origin).addScaledVector(this.u, x).addScaledVector(this.v, y);
  }

  /** quaternion that orients local XY onto this plane (local +Z -> n) */
  orientation(): THREE.Quaternion {
    return new THREE.Quaternion().setFromRotationMatrix(this.basisMatrix());
  }

  /**
   * Matrix that maps local sketch space (XY plane, +Z out) into world: local
   * X->u, Y->v, Z->normal, positioned at the origin. Pass a `normalSign` of -1
   * to flip the out-of-plane axis (e.g. extruding to the other side).
   */
  basisMatrix(normalSign = 1): THREE.Matrix4 {
    const n = normalSign === 1 ? this.n : this.n.clone().multiplyScalar(normalSign);
    const m = new THREE.Matrix4().makeBasis(this.u, this.v, n);
    m.setPosition(this.origin);
    return m;
  }
}
