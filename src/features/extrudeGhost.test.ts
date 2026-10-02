// The extrude ghost must not hide which areas are being extruded.
//
// Field report ed91af03 (0.1.226): "When I am extruding multiple sections of
// the same sketch, it colours/highlights the sections that I am extruding, I
// then start the extrude and the highlights disappear and are replaced by a
// ghosted object ... if I save and then edit the extrude there is the same
// issue."
//
// The cause was render state, not selection state: the selected fills keep
// their orange material the whole time. The ghost was transparent but still
// WROTE DEPTH, and it sorts before the sketch overlay (the overlay is a group at
// order 10, the ghost's group is at 0), so once beginDrag tilts the camera the
// ghost's cap stands in front of the fills at its base and every one of them
// fails the depth test. Measured in a minimal scene with exactly these
// materials: the selected area's centre went from orange [108,77,48] to
// [34,52,79], next to an unselected fill at [37,52,74].
//
// These run the REAL SketchOverlay and the REAL ExtrudeTool (start and
// startEdit, through the real beginDrag and updatePreview) and read the
// scene the tool actually built. The draw order is computed the way three.js
// r180 computes it (see drawOrder); the pixels themselves were checked in the
// running app, which this file cannot do.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { installFakeDocument } from "../ui/fakeDom.testkit";
import { SELECT_COLOR, SketchOverlay } from "../sketch/overlay";
import { ExtrudeTool } from "./extrudeTool";
import type { CadDocument } from "../types";

// DimInput (beginDrag opens it) builds and focuses real elements, and re-focuses
// on the next frame; the tool's listeners go on window.
installFakeDocument();
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;

/** Two separate 20x20 areas on XY: A centred at x = -30, B at x = +30.
 *  `ex1` extrudes A, so the edit path reopens on A alone. */
function doc(): CadDocument {
  return {
    features: [
      {
        id: "s1",
        type: "sketch",
        plane: "XY",
        entities: [
          { id: "ra", type: "rectangle", x: -30, y: 0, width: 20, height: 20 },
          { id: "rb", type: "rectangle", x: 30, y: 0, width: 20, height: 20 },
        ],
      },
      {
        id: "ex1",
        type: "extrude",
        sketch: "s1",
        distance: 15,
        operation: "new",
        regions: [[-30, 0, 0]],
        regionEntities: [["ra"]],
        regionHoleEntities: [[]],
      },
    ],
    parameters: {},
  } as unknown as CadDocument;
}

function harness() {
  const d = doc();
  const overlay = new SketchOverlay();
  overlay.update(d);
  const scene = new THREE.Scene();
  scene.add(overlay.group); // as main.ts does
  const viewport = {
    suspendPicking: false,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    projectToScreen: () => ({ x: 400, y: 300 }),
    tiltOffAxis: () => true,
    pointInSolid: () => false,
    clearHover() {},
    hoverDatum() {},
    domElement: {
      style: {},
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    },
  };
  const store = {
    document: d,
    isParamBound: () => false,
    beginEditPreview() {},
    endEditPreview() {},
    buildState: {},
    hiddenBodyIds: () => [],
    nextId: () => "new1",
  };
  const tool = new ExtrudeTool(viewport as never, overlay, store as never);
  return { tool, overlay, scene };
}

/** Area A, the one being extruded in every test below. */
function areaA(overlay: SketchOverlay) {
  const a = overlay.regions.find((wr) => wr.region.entityIds.includes("ra"));
  if (!a) throw new Error("fixture: area A was not traced");
  return a;
}

/** The order three.js r180 draws a scene in. Opaque before transparent; within
 *  each, by GROUP order (the renderOrder of the nearest THREE.Group above the
 *  object, which WebGLRenderer.projectObject hands down), then the object's own
 *  renderOrder (WebGLRenderLists' painter sorts). Depth is left out because
 *  every comparison below is decided before three would reach it. */
function drawOrder(scene: THREE.Object3D): THREE.Object3D[] {
  type Item = { o: THREE.Object3D; transparent: boolean; group: number; order: number; seq: number };
  const items: Item[] = [];
  const walk = (o: THREE.Object3D, group: number) => {
    if (!o.visible) return;
    const g = (o as THREE.Group).isGroup ? o.renderOrder : group;
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (mat && ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine)) {
      items.push({ o, transparent: mat.transparent, group: g, order: o.renderOrder, seq: items.length });
    }
    for (const c of o.children) walk(c, g);
  };
  walk(scene, 0);
  const byOrder = (a: Item, b: Item) => a.group - b.group || a.order - b.order || a.seq - b.seq;
  return [
    ...items.filter((i) => !i.transparent).sort(byOrder),
    ...items.filter((i) => i.transparent).sort(byOrder),
  ].map((i) => i.o);
}

/** The ghost's solid volumes: the only lit (MeshStandardMaterial) meshes. */
function ghosts(scene: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material instanceof THREE.MeshStandardMaterial) out.push(o as THREE.Mesh);
  });
  return out;
}

/** Lines in the selection colour that ignore depth: the outline of the
 *  selected areas, and nothing the sketch draws for itself (its curves are
 *  depth-tested and blue). */
function outlines(scene: THREE.Object3D): Line2[] {
  const out: Line2[] = [];
  scene.traverse((o) => {
    if (!(o instanceof Line2)) return;
    const m = o.material as LineMaterial;
    if (m.color.getHex() === SELECT_COLOR && m.depthTest === false) out.push(o);
  });
  return out;
}

/** What the user must be able to see, whichever way the tool was opened. */
function expectSelectionVisibleOverGhost(scene: THREE.Scene, overlay: SketchOverlay) {
  const g = ghosts(scene);
  expect(g.length, "the tool built no ghost at all").toBe(1);
  for (const m of g) {
    const mat = m.material as THREE.MeshStandardMaterial;
    expect(mat.depthWrite, "the ghost writes depth, so every fill behind its cap fails the depth test").toBe(false);
    expect(mat.opacity, "the ghost is too opaque to read the fills through").toBeLessThanOrEqual(0.35);
  }

  const fill = areaA(overlay).fill;
  expect(fill, "area A has no fill mesh").toBeTruthy();
  expect(overlay.isRegionSelected(areaA(overlay)), "fixture: area A should be the selected one").toBe(true);

  const lines = outlines(scene);
  expect(lines.length, "no outline of the selected area is drawn").toBe(1);
  // It outlines A and only A: x in [-40, -20], y in [-10, 10], on the plane.
  lines[0]!.geometry.computeBoundingBox();
  const box = lines[0]!.geometry.boundingBox!;
  expect([box.min.x, box.max.x, box.min.y, box.max.y, box.min.z, box.max.z].map((v) => Math.round(v * 1000) / 1000))
    .toEqual([-40, -20, -10, 10, 0, 0]);

  const order = drawOrder(scene);
  const last = (os: THREE.Object3D[]) => Math.max(...os.map((o) => order.indexOf(o)));
  const ghostAt = last(g);
  expect(order.indexOf(fill!), "the selected fill is drawn BEFORE the ghost, so the ghost veils it").toBeGreaterThan(ghostAt);
  expect(order.indexOf(lines[0]!), "the outline is drawn before the ghost").toBeGreaterThan(ghostAt);
  expect(order.indexOf(lines[0]!), "the outline is drawn under the fills").toBeGreaterThan(order.indexOf(fill!));
}

describe("the extrude ghost leaves the selected areas visible", () => {
  it("while creating", () => {
    const { tool, overlay, scene } = harness();
    overlay.toggleRegionSelection(areaA(overlay), false);
    tool.start(() => {});
    expectSelectionVisibleOverGhost(scene, overlay);
  });

  it("while editing a saved extrude", () => {
    // startEdit restores the saved areas and goes straight to the depth step,
    // with the same ghost: the reporter's second sentence.
    const { tool, overlay, scene } = harness();
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expectSelectionVisibleOverGhost(scene, overlay);
  });

  it("takes the outline down with the ghost when the tool closes", () => {
    const { tool, overlay, scene } = harness();
    overlay.toggleRegionSelection(areaA(overlay), false);
    tool.start(() => {});
    tool.cancel();
    expect(ghosts(scene)).toEqual([]);
    expect(outlines(scene)).toEqual([]);
  });
});
