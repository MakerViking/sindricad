// A face that is selected on a body stays LIT when the body's own selection is
// dropped. The body's paint covers the whole buffer and the restore used to
// write the base colours back over all of it, so the face stayed in the
// selection with nothing on screen to show it. Split Body reaches this: it
// paints its targets as the body selection, and now leaves a face it did not
// use selected (only the face that filled its Tool field is taken).
//
// A real Highlighter over a one-body view: two faces, one triangle each.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Highlighter } from "./highlight";
import { SELECT } from "./colors3d";

function view() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Array(18).fill(0), 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(new Array(18).fill(0.5), 3));
  geo.setIndex([0, 1, 2, 3, 4, 5]);
  const body = {
    id: "body1", name: "Body1", faceStart: 10, faceCount: 2, mesh: new THREE.Mesh(geo), faceIds: [10, 11],
    edges: {}, baseColors: new Float32Array(18).fill(0.5), faceTriangles: new Map([[10, [0]], [11, [1]]]),
  };
  const h = new Highlighter({ bodies: [body], edges: [], orphanEdges: null, box: new THREE.Box3() } as never);
  const color = geo.getAttribute("color") as THREE.BufferAttribute;
  const rgb = (v: number) => [color.getX(v), color.getY(v), color.getZ(v)];
  return { h, rgb };
}

describe("a face selected under a body selection", () => {
  it("is lit again when the body is deselected, and only it", () => {
    const { h, rgb } = view();
    const sel = new THREE.Color(SELECT);
    const lit = [sel.r, sel.g, sel.b];
    h.toggleSelectFace(10);
    h.toggleSelectBody("body1"); // the whole body painted over it
    h.clearBodySelection();
    expect(h.getSelectedFaces()).toEqual([10]);
    // the buffer is Float32: compare at its precision
    for (const v of [0, 1, 2]) rgb(v).forEach((c, i) => expect(c, "the selected face lost its paint").toBeCloseTo(lit[i]!, 6));
    for (const v of [3, 4, 5]) expect(rgb(v), "an unselected face kept the body's paint").toEqual([0.5, 0.5, 0.5]);
  });
});
