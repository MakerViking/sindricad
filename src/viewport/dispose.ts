// Single home for the "dispose geometry + material(s) + textures" GPU-hygiene
// rule. WebGL resources aren't GC'd, so every geometry/material we drop must be
// disposed explicitly. Used on every model/overlay/preview rebuild.

import * as THREE from "three";

export function disposeObject(root: THREE.Object3D) {
  root.traverse((o: any) => {
    // A BVH is a separate pair of typed arrays hanging off the geometry, and
    // geometry.dispose() does NOT free it. A rebuild happens on every document
    // change, so missing this leaks a tree per rebuild.
    if (o.geometry?.boundsTree) o.geometry.disposeBoundsTree?.();
    o.geometry?.dispose?.();

    const mats = Array.isArray(o.material)
      ? o.material
      : o.material
        ? [o.material]
        : [];
    for (const m of mats) {
      for (const k in m) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose?.();
    }
  });
}
