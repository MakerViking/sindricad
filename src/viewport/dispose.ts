// Single home for the "dispose geometry + material(s) + textures" GPU-hygiene
// rule. WebGL resources aren't GC'd, so every geometry/material we drop must be
// disposed explicitly. Used on every model/overlay/preview rebuild.

import * as THREE from "three";

export function disposeObject(root: THREE.Object3D) {
  root.traverse((o: any) => {
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
