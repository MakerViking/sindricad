// Manipulator handles are always visible, whatever is in front of them.
//
// A drag handle is not part of the model — it is chrome you aim at, and chrome
// that hides behind geometry is chrome the user cannot use. Every interactive
// tool in this app already draws its arrow with the depth buffer switched off
// and a renderOrder above the scene (edgeFeatureTool, pressPullTool,
// planeOffsetTool, sectionTool all set the same three properties by hand).
//
// Extrude's arrow was a bare THREE.ArrowHelper, which takes three's defaults —
// depth-tested, renderOrder 0 — so it disappeared inside solid material. Two
// reports, both Windows, both asking for the same thing:
//
//   "I have a sketch and a body, the body covers the sketch, I try to extrude
//    another feature on the sketch but the arrow is completely hidden by the
//    body so I can't grab and pull." (b9c77c80)
//
//   "...selected 2 of the holes from the sketch and tried to extrude, there was
//    no arrow available, just the measurement box... I think the arrow was
//    between the holes inside the body... I think you need some way to make the
//    yellow arrow visible/accessible when it is 'inside' a body." (9a959fc0)
//
// Worth recording because it changes what the fix had to be: extrude's arrow was
// always GRABBABLE while occluded. Its hit test (extrudeTool.overArrow) projects
// the shaft to screen space and measures pixel distance — it never raycasts, so
// a body in front of it was never in the way. The handle was only ever invisible,
// and both reporters described losing it, not failing to grab it.
import type * as THREE from "three";

/** Above every scene object; matches the other tools' hand-set handle values. */
const HANDLE_RENDER_ORDER = 999;

/** Draw `obj` and everything under it in front of the model, regardless of depth.
 *  Returns `obj` so it can be used inline at construction. */
export function drawOnTop<T extends THREE.Object3D>(obj: T, renderOrder = HANDLE_RENDER_ORDER): T {
  obj.traverse((o) => {
    o.renderOrder = renderOrder;
    // ArrowHelper's line and cone each carry their own material, and a material
    // may legitimately be an array (multi-material meshes) — handle both rather
    // than assuming the shape of whatever gets passed in later.
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      m.depthTest = false;
      m.depthWrite = false;
      m.needsUpdate = true;
    }
  });
  return obj;
}
