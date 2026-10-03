// Solid section caps (field report 5effc008: "Section view implies all the
// bodies are hollow, would be good to see the solid section").
//
// WHAT THIS OBSERVES: the scene objects and materials the renderer reads, built
// from real three geometry. There is no WebGL here, so the stencil itself never
// runs: whether the caps actually fill the cut on screen was checked by driving
// the app headless (pixels inside and outside a cut body, with and without the
// change), which is not in CI. The user's path through the section tool is in
// sectionTool.test.ts; this file pins the pieces it rests on.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SectionCaps, isClosedSurface, CAP_SHADE, SHARED_CAP_ABOVE, WRITER_NUDGE } from "./sectionCaps";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import viewportSrc from "./viewport.ts?raw";
import sceneSrc from "./scene.ts?raw";

/** A closed box body centred at (x, y, z), as render.ts builds one: its own
 *  geometry and an opaque material. */
function box(x: number, y = 0, z = 0, size = 10): { mesh: THREE.Mesh } {
  const geo = new THREE.BoxGeometry(size, size, size);
  geo.translate(x, y, z);
  return { mesh: new THREE.Mesh(geo, new THREE.MeshStandardMaterial()) };
}

/** An open sheet standing on edge across z = 0: a scanned or unclosed mesh. */
function sheet(x: number): { mesh: THREE.Mesh } {
  const geo = new THREE.PlaneGeometry(10, 10);
  geo.rotateX(Math.PI / 2);
  geo.translate(x, 0, 0);
  return { mesh: new THREE.Mesh(geo, new THREE.MeshStandardMaterial()) };
}

const Z_CUT = () => new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // keeps z >= 0

type P3 = [number, number, number];
/** A triangle soup, each triangle its own three vertices: the weld has to find
 *  every shared corner, as it does on the sidecar's per-face tessellation. */
function soup(tris: P3[][]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(tris.flat(2), 3));
  return geo;
}

/** The unit cube [0,1]^3 as twelve triangles, except that its TOP face is
 *  remeshed through `m`, a point on its front edge (y = 0) that the front face
 *  never sees: a T-junction, the way a textured face meets a plain one. */
function tJunctionCube(m: P3): THREE.BufferGeometry {
  const q = (a: P3, b: P3, c: P3, d: P3): P3[][] => [[a, b, c], [a, c, d]];
  return soup([
    ...q([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]), // bottom
    ...q([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]), // front: one edge along the top
    ...q([0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]), // back
    ...q([0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]), // left
    ...q([1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]), // right
    // top, three triangles fanned from m
    [[0, 0, 1], m, [0, 1, 1]],
    [m, [1, 0, 1], [1, 1, 1]],
    [m, [1, 1, 1], [0, 1, 1]],
  ]);
}

/** A closed box 10 x 10 x 10 at the origin with a closed 6 x 6 x 6 void inside
 *  it: two surfaces, both closed, so parity says solid between them and empty
 *  inside the void (a shelled part, or a cup with a lid on). */
function hollowBox(): { mesh: THREE.Mesh } {
  const geo = mergeGeometries([new THREE.BoxGeometry(10, 10, 10), new THREE.BoxGeometry(6, 6, 6)])!;
  return { mesh: new THREE.Mesh(geo, new THREE.MeshStandardMaterial()) };
}

/** A pick ray straight up the z axis from below, through (x, y). */
const upAt = (x: number, y: number) => new THREE.Ray(new THREE.Vector3(x, y, -100), new THREE.Vector3(0, 0, 1));
const GREY = 0x9aa7b4;

function visibleCaps(caps: SectionCaps): THREE.Mesh[] {
  return caps.root.children.filter(
    (o): o is THREE.Mesh => o instanceof THREE.Mesh && o.visible && (o.material as THREE.Material).colorWrite,
  );
}
function writers(caps: SectionCaps): THREE.Mesh[] {
  return caps.root.children.filter(
    (o): o is THREE.Mesh => o instanceof THREE.Mesh && !(o.material as THREE.Material).colorWrite,
  );
}
function capColor(m: THREE.Mesh): number {
  return (m.material as THREE.MeshBasicMaterial).color.getHex();
}
const shade = (hex: number) => new THREE.Color(hex).multiplyScalar(CAP_SHADE).getHex();

describe("which tessellations can be capped", () => {
  it("a box is closed, even though its faces do not share vertices", () => {
    // BoxGeometry duplicates every corner per face, the way the sidecar's
    // per-face tessellation does, so this only passes through the weld.
    expect(isClosedSurface(new THREE.BoxGeometry(4, 5, 6))).toBe(true);
    expect(isClosedSurface(new THREE.BoxGeometry(4, 5, 6).toNonIndexed())).toBe(true);
  });

  it("a sheet, or a box with a triangle missing, is not", () => {
    expect(isClosedSurface(new THREE.PlaneGeometry(4, 4))).toBe(false);
    const holed = new THREE.BoxGeometry(4, 5, 6);
    const idx = Array.from(holed.getIndex()!.array).slice(3); // drop one triangle
    holed.setIndex(idx);
    expect(isClosedSurface(holed)).toBe(false);
  });

  it("winding does not matter: a face wound the wrong way is still closed", () => {
    // A textured face's display triangles do disagree with their neighbours;
    // parity does not care, which is why the caps use it.
    const geo = new THREE.BoxGeometry(4, 5, 6);
    const idx = Array.from(geo.getIndex()!.array);
    for (let t = 0; t < 6; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2]!, idx[t + 1]!];
    geo.setIndex(idx);
    expect(isClosedSurface(geo)).toBe(true);
  });

  it("a T-junction is closed: a textured face's border meets its plain neighbours that way", () => {
    // The review found every textured body left hollow: the texture remeshes
    // its face, so its border has vertices its neighbours' edges do not.
    expect(isClosedSurface(tJunctionCube([0.5, 0, 1]))).toBe(true);
    expect(isClosedSurface(tJunctionCube([0.25, 0, 1]))).toBe(true);
  });

  it("but a vertex OFF its neighbour's edge leaves a real gap, and that is open", () => {
    expect(isClosedSurface(tJunctionCube([0.5, 0.01, 1])), "a 0.01 mm sliver of a gap").toBe(false);
    expect(isClosedSurface(tJunctionCube([0.5, 0, 1.01])), "a notch above the edge").toBe(false);
  });
});

describe("SectionCaps", () => {
  it("caps each closed body the plane crosses, in its own colour darkened", () => {
    const caps = new SectionCaps();
    const bodies = [box(0), box(20), box(0, 0, 30), sheet(40)];
    const colours = [0xff0000, 0x00ff00, 0x0000ff, GREY];
    caps.sync(Z_CUT(), bodies, (i) => colours[i]!, GREY);

    expect(caps.capped).toBe(2); // the two boxes on z = 0; the one at z = 30 is not cut
    expect(caps.open, "the open sheet is cut but left hollow").toBe(1);
    const shown = visibleCaps(caps);
    expect(shown.map(capColor).sort()).toEqual([shade(0xff0000), shade(0x00ff00)].sort());
    for (const c of shown) expect(c.position.z).toBeCloseTo(0, 9);
    // each writer draws its own body's geometry, nobody else's
    expect(writers(caps).map((w) => w.geometry)).toEqual([bodies[0]!.mesh.geometry, bodies[1]!.mesh.geometry]);
  });

  it("a cap covers its body's whole cross-section", () => {
    const caps = new SectionCaps();
    const tilted = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(1, 1, 1).normalize(),
      new THREE.Vector3(20, 0, 0),
    );
    caps.sync(tilted, [box(20)], () => GREY, GREY);
    const [cap] = visibleCaps(caps);
    cap!.updateMatrixWorld();
    // The square, in the plane, reaches past every box corner's projection.
    const corners = new THREE.Box3().setFromObject(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10).translate(20, 0, 0)));
    const inv = cap!.matrixWorld.clone().invert();
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(
        i & 1 ? corners.max.x : corners.min.x,
        i & 2 ? corners.max.y : corners.min.y,
        i & 4 ? corners.max.z : corners.min.z,
      );
      const local = tilted.projectPoint(p, new THREE.Vector3()).applyMatrix4(inv);
      expect(Math.abs(local.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(local.y)).toBeLessThanOrEqual(0.5);
    }
  });

  it("draws each body's writer, then its cap, before the next body's writer", () => {
    // The cap writes 0 back where it draws; another body's writer squeezed in
    // between would have its bits wiped, or leave them for the wrong cap.
    const caps = new SectionCaps();
    const bodies = [box(0), box(20), box(40)];
    caps.sync(Z_CUT(), bodies, () => GREY, GREY);
    const order: number[] = [];
    for (const b of bodies) {
      const w = writers(caps).find((m) => m.geometry === b.mesh.geometry)!;
      order.push(w.renderOrder);
    }
    const capOrders = visibleCaps(caps).map((c) => c.renderOrder).sort((a, b) => a - b);
    const all = [...order, ...capOrders].sort((a, b) => a - b);
    expect(all).toEqual([order[0], capOrders[0], order[1], capOrders[1], order[2], capOrders[2]]);
    // after the bodies (0), before the drag handles (997-999, which do not depth-test)
    for (const o of all) expect(o > 0 && o < 997).toBe(true);
  });

  it("the stencil settings that make a cap fill exactly the inside", () => {
    const caps = new SectionCaps();
    const plane = Z_CUT();
    caps.sync(plane, [box(0)], () => GREY, GREY);
    const w = writers(caps)[0]!.material as THREE.MeshBasicMaterial;
    const [cut] = w.clippingPlanes!;
    expect(cut!.normal.toArray(), "the writer is cut along the body's own cut").toEqual(plane.normal.toArray());
    // ...moved a hair into the kept side, see "a face lying exactly on the cut"
    expect(cut!.constant).toBeCloseTo(plane.constant - WRITER_NUDGE * Math.sqrt(300), 12);
    expect([w.colorWrite, w.depthWrite, w.depthTest]).toEqual([false, false, false]);
    expect(w.side).toBe(THREE.DoubleSide);
    expect([w.stencilWrite, w.stencilFunc, w.stencilWriteMask]).toEqual([true, THREE.AlwaysStencilFunc, 1]);
    expect([w.stencilFail, w.stencilZFail, w.stencilZPass]).toEqual(Array(3).fill(THREE.InvertStencilOp));
    const c = visibleCaps(caps)[0]!.material as THREE.MeshBasicMaterial;
    expect([c.stencilWrite, c.stencilFunc, c.stencilRef]).toEqual([true, THREE.NotEqualStencilFunc, 0]);
    expect([c.stencilFail, c.stencilZFail, c.stencilZPass]).toEqual(Array(3).fill(THREE.ReplaceStencilOp));
    expect(c.depthTest, "a cap is hidden by whatever is in front of it").toBe(true);
  });

  it("follows a plane moved in place, and a body hidden or dimmed since", () => {
    const caps = new SectionCaps();
    const plane = Z_CUT();
    const bodies = [box(0), box(0, 0, 30)];
    caps.sync(plane, bodies, () => GREY, GREY);
    expect(caps.capped).toBe(1);
    plane.constant = -30; // the section tool's drag: same object, new position
    caps.sync(plane, bodies, () => GREY, GREY);
    expect(caps.capped).toBe(1);
    expect(visibleCaps(caps)[0]!.position.z).toBeCloseTo(30, 9);
    expect(writers(caps).map((w) => w.geometry)).toEqual([bodies[1]!.mesh.geometry]);

    bodies[1]!.mesh.visible = false;
    caps.sync(plane, bodies, () => GREY, GREY);
    expect(caps.capped, "a hidden body has nothing to cap").toBe(0);
    bodies[1]!.mesh.visible = true;
    (bodies[1]!.mesh.material as THREE.Material).transparent = true; // dimmed while sketching
    caps.sync(plane, bodies, () => GREY, GREY);
    expect(caps.capped, "a dimmed body keeps the see-through look").toBe(0);
  });

  it("follows a body that Move is dragging", () => {
    const caps = new SectionCaps();
    const b = box(0, 0, 30); // not cut where it is
    caps.sync(Z_CUT(), [b], () => GREY, GREY);
    expect(caps.capped).toBe(0);
    b.mesh.position.set(0, 0, -30); // the move ghost: a transform, no new vertices
    b.mesh.updateMatrixWorld();
    caps.sync(Z_CUT(), [b], () => GREY, GREY);
    expect(caps.capped).toBe(1);
    const w = writers(caps)[0]!;
    expect(w.matrix.equals(b.mesh.matrixWorld), "the writer draws where the body is drawn").toBe(true);
  });

  it("a cleared cut leaves nothing behind", () => {
    const caps = new SectionCaps();
    caps.sync(Z_CUT(), [box(0), box(20)], () => GREY, GREY);
    caps.sync(null, [box(0), box(20)], () => GREY, GREY);
    expect(caps.capped).toBe(0);
    expect(visibleCaps(caps)).toEqual([]);
    expect(writers(caps)).toEqual([]);
  });

  it("past the limit, one shared cap in one colour, after every writer", () => {
    const caps = new SectionCaps();
    const many = Array.from({ length: SHARED_CAP_ABOVE + 1 }, (_, i) => box(i * 12, 0, 0, 2));
    caps.sync(Z_CUT(), many, () => 0xff0000, GREY);
    expect(caps.sharedMode).toBe(true);
    const shown = visibleCaps(caps);
    expect(shown.length).toBe(1);
    expect(capColor(shown[0]!)).toBe(shade(GREY));
    const last = Math.max(...writers(caps).map((w) => w.renderOrder));
    expect(writers(caps).length).toBe(many.length);
    expect(shown[0]!.renderOrder).toBeGreaterThan(last);
    // and back to a cap per body once the cut crosses fewer
    caps.sync(Z_CUT(), many.slice(0, 3), () => 0xff0000, GREY);
    expect(caps.sharedMode).toBe(false);
    expect(visibleCaps(caps).map(capColor)).toEqual(Array(3).fill(shade(0xff0000)));
  });

  it("is never picked", () => {
    const caps = new SectionCaps();
    caps.sync(Z_CUT(), [box(0)], () => GREY, GREY);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 50), new THREE.Vector3(0, 0, -1));
    caps.root.updateMatrixWorld(true);
    expect(ray.intersectObject(caps.root, true)).toEqual([]);
  });
});

describe("a face lying exactly on the cut", () => {
  // Review, real GPU: a cup cut exactly on its inner wall (the arrow's 0.5 mm
  // steps land there on any part with round dimensions). That wall is clipped
  // or kept pixel by pixel on float noise, the parity followed it, and the cap
  // filled whole tessellation triangles of the EMPTY cavity, different ones
  // from every camera angle. The writer's own plane now sits a hair inside the
  // kept side, so a face on the cut is outside it, every pixel.
  it("is outside the writer's plane, whichever side is kept", () => {
    for (const keep of [1, -1]) {
      const caps = new SectionCaps();
      // the void's floor is at z = -3: cut there, keeping above, then below
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, keep), 3 * keep);
      caps.sync(plane, [hollowBox()], () => GREY, GREY);
      const [writerPlane] = (writers(caps)[0]!.material as THREE.Material).clippingPlanes!;
      const onFloor = new THREE.Vector3(1, 1, -3);
      expect(plane.distanceToPoint(onFloor), "the floor really is on the cut").toBeCloseTo(0, 12);
      expect(writerPlane!.distanceToPoint(onFloor)).toBeLessThan(0);
      // and the nudge is a hair: 0.01 mm into the kept side is inside it
      expect(writerPlane!.distanceToPoint(onFloor.clone().addScaledVector(plane.normal, 0.01))).toBeGreaterThan(0);
    }
  });

  it("so the empty void is not capped, and the wall around it is", () => {
    const caps = new SectionCaps();
    caps.sync(new THREE.Plane(new THREE.Vector3(0, 0, 1), 3), [hollowBox()], () => GREY, GREY);
    // from below, through the cut at z = -3
    // (0.5, 1), not the centre: the centre is on the floor's diagonal, where
    // two triangles meet and a ray counts both
    expect(caps.capAt(upAt(0.5, 1)), "the void: nothing there to fill").toBeNull();
    expect(caps.capAt(upAt(4, 0))?.distance, "the wall").toBeCloseTo(97, 9);
  });
});

describe("where a pick ray meets a cap (capAt)", () => {
  it("where it crosses the cut inside a capped body, at the cut, with that body", () => {
    const caps = new SectionCaps();
    const bodies = [box(0), box(20)];
    caps.sync(Z_CUT(), bodies, () => GREY, GREY);
    expect(caps.capAt(upAt(1, 2))).toEqual({ distance: 100, mesh: bodies[0]!.mesh });
    expect(caps.capAt(upAt(21, -2))?.mesh).toBe(bodies[1]!.mesh);
    expect(caps.capAt(upAt(10, 0)), "between the bodies").toBeNull();
    // from above, on the kept side, the line crosses the same cap
    const down = new THREE.Ray(new THREE.Vector3(1, 2, 50), new THREE.Vector3(0, 0, -1));
    expect(caps.capAt(down)?.distance).toBeCloseTo(50, 9);
  });

  it("on a tilted ray too, and in shared mode, and never once the cut is cleared", () => {
    const caps = new SectionCaps();
    const many = Array.from({ length: SHARED_CAP_ABOVE + 1 }, (_, i) => box(i * 12, 0, 0, 2));
    caps.sync(Z_CUT(), many, () => GREY, GREY);
    expect(caps.sharedMode).toBe(true);
    // crosses the cut at (23.6, 0.5, 0), inside the third box, and leaves it
    // through its top, clear of any edge
    const slant = new THREE.Ray(new THREE.Vector3(23.6 - 30, 0.5, -30), new THREE.Vector3(1, 0, 1).normalize());
    expect(caps.capAt(slant)?.mesh).toBe(many[2]!.mesh);
    caps.sync(null, many, () => GREY, GREY);
    expect(caps.capAt(slant)).toBeNull();
  });

  it("an open body is never capped, so never stops a pick", () => {
    const caps = new SectionCaps();
    caps.sync(Z_CUT(), [sheet(0)], () => GREY, GREY);
    expect(caps.capAt(upAt(1, 0))).toBeNull();
  });
});

// The wiring a headless run cannot execute. If any of these stops holding, the
// tests above keep passing and no cap is ever drawn.
describe("the wiring that puts caps on screen", () => {
  it("every frame the viewport draws brings the caps up to date first", () => {
    const draws = [...viewportSrc.matchAll(/this\.scene\.renderer\.render\(this\.scene\.scene/g)];
    expect(draws.length).toBeGreaterThan(0);
    for (const d of draws) {
      const before = viewportSrc.slice(Math.max(0, d.index! - 200), d.index);
      expect(before).toMatch(/this\.syncSectionCaps\(\);\s*$/);
    }
  });

  it("the caps hang off the scene, and only draw with a stencil buffer", () => {
    expect(viewportSrc).toContain("this.scene.scene.add(this.caps.root)");
    expect(viewportSrc).toMatch(/const plane = this\.scene\.stencil \? this\.clipPlane : null;/);
  });

  it("the renderer asks for a stencil buffer and reports whether it got one", () => {
    expect(sceneSrc).toMatch(/new THREE\.WebGLRenderer\(\{ canvas, antialias: true, stencil: true \}\)/);
    expect(sceneSrc).toMatch(/getContextAttributes\(\)\?\.stencil === true/);
  });
});
