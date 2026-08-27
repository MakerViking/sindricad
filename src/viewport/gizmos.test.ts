// The extrude drag arrow, when it lands inside or behind a body.
//
// Two field reports, both Windows, both asking for the same affordance:
//   b9c77c80 — "the body covers the sketch, I try to extrude another feature on
//     the sketch but the arrow is completely hidden by the body so I can't grab
//     and pull."
//   9a959fc0 — "selected 2 of the holes from the sketch and tried to extrude,
//     there was no arrow available, just the measurement box... I think the arrow
//     was between the holes inside the body."
//
// The arrow was a bare THREE.ArrowHelper, so it took three's defaults —
// depth-tested, renderOrder 0 — and vanished inside solid material, while every
// other tool's handle in this codebase is drawn with the depth buffer off at
// renderOrder 999.
//
// What this file pins is the invariant rather than the one call site: a handle is
// visible through the model, and it does not matter what the handle is made of.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { drawOnTop } from "./gizmos";
import extrudeSrc from "../features/extrudeTool.ts?raw";

/** Every material under `obj`, flattened. */
function materials(obj: THREE.Object3D): THREE.Material[] {
  const out: THREE.Material[] = [];
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    out.push(...(Array.isArray(m) ? m : [m]));
  });
  return out;
}

describe("drawOnTop", () => {
  it("makes an ArrowHelper draw through solid material", () => {
    // The exact object extrude builds, and the exact defaults it used to keep.
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 10, 0xffd24a, 6, 3);
    const mats = materials(arrow);
    expect(mats.length, "an ArrowHelper with no materials — three's shape changed").toBeGreaterThan(0);
    expect(
      mats.every((m) => m.depthTest),
      "three's ArrowHelper no longer depth-tests by default, so this test no longer "
        + "demonstrates the bug it was written for",
    ).toBe(true);

    drawOnTop(arrow);
    for (const m of materials(arrow)) {
      expect(m.depthTest, "a handle material still depth-tests — it will hide inside a body").toBe(false);
      expect(m.depthWrite, "a handle that writes depth punches a hole in what is drawn after it").toBe(false);
    }
    arrow.traverse((o) => {
      expect(o.renderOrder, "a handle part is not ordered above the scene").toBeGreaterThan(900);
    });
  });

  it("reaches the shaft AND the head, not just the top-level object", () => {
    // An ArrowHelper carries its materials on two CHILDREN. Setting the property
    // on the helper itself changes nothing a user can see, which is the obvious
    // way to write this fix and have it do nothing.
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 10, 0xffd24a, 6, 3);
    drawOnTop(arrow);
    const kids = materials(arrow);
    expect(kids.length, "expected a material for both the line and the cone").toBeGreaterThanOrEqual(2);
    expect(kids.every((m) => !m.depthTest)).toBe(true);
  });

  it("returns the object so it can be used inline", () => {
    const g = new THREE.Group();
    expect(drawOnTop(g)).toBe(g);
  });

  it("survives an object with no material at all", () => {
    expect(() => drawOnTop(new THREE.Object3D())).not.toThrow();
  });

  it("handles a multi-material mesh", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
      new THREE.MeshBasicMaterial(),
      new THREE.MeshBasicMaterial(),
    ]);
    drawOnTop(mesh);
    expect(materials(mesh).every((m) => !m.depthTest)).toBe(true);
  });
});

describe("the extrude arrow uses it", () => {
  it("is drawn on top where it is constructed", () => {
    const at = extrudeSrc.indexOf("new THREE.ArrowHelper(");
    expect(at, "extrudeTool no longer builds an ArrowHelper — this test's slice is stale").toBeGreaterThan(-1);
    const after = extrudeSrc.slice(at, at + 300);
    expect(
      after,
      "the extrude arrow is constructed without drawOnTop, so it is depth-tested again and "
        + "disappears inside a body (field reports b9c77c80, 9a959fc0)",
    ).toContain("drawOnTop(");
  });

  it("still picks the arrow in SCREEN space, which is why the fix is visual only", () => {
    // Recorded because it is the load-bearing fact behind the whole diagnosis:
    // the handle was always grabbable while occluded, because overArrow projects
    // the shaft and measures pixel distance rather than raycasting. If this ever
    // becomes a raycast against the scene, the body WILL be hit first and these
    // two reports come straight back — as a genuinely unreachable handle.
    const at = extrudeSrc.indexOf("private overArrow(");
    expect(at, "no overArrow() in extrudeTool — this test's slice is stale").toBeGreaterThan(-1);
    const body = extrudeSrc.slice(at, extrudeSrc.indexOf("\n  }", at));
    expect(body, "overArrow no longer projects the shaft to the screen").toContain("projectToScreen(");
    expect(body, "overArrow no longer measures pixel distance to the shaft").toContain("pixelDistanceToSegment(");
    expect(
      body,
      "overArrow now raycasts — an occluded arrow would be hit-blocked by the body in "
        + "front of it, which is a worse bug than the invisibility this replaced",
    ).not.toMatch(/[Rr]aycast/);
  });
});
