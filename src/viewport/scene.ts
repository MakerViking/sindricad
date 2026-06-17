// Scene setup: renderer, lights, Z-up grid + axes, sketch planes.
// CAD convention is Z-up (matches build123d/Fusion), so the ground grid lies
// in the XY plane and cameras use up = +Z.

import * as THREE from "three";

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  modelGroup: THREE.Group; // rebuilt geometry lives here
  planes: Record<"XY" | "XZ" | "YZ", THREE.Mesh>;
}

export function createScene(canvas: HTMLCanvasElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x1a1d21, 1);

  const scene = new THREE.Scene();

  // --- lighting rig (key + fill + ambient) for a clean product look ---
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(40, -60, 80);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-50, 40, 20);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202428, 0.6));

  // --- Z-up ground grid in the XY plane ---
  const grid = new THREE.GridHelper(400, 40, 0x3a4048, 0x2a2f35);
  grid.rotateX(Math.PI / 2); // GridHelper is XZ by default; lay it flat on XY
  (grid.material as THREE.Material).depthWrite = false;
  scene.add(grid);

  // axes: X red, Y green, Z blue
  const axes = new THREE.AxesHelper(20);
  scene.add(axes);

  // --- sketch planes (semi-transparent, toggled per active sketch) ---
  const planes = {
    XY: makePlane(0x4488ff, "XY"),
    XZ: makePlane(0x44ff88, "XZ"),
    YZ: makePlane(0xff8844, "YZ"),
  };
  for (const p of Object.values(planes)) {
    p.visible = false;
    scene.add(p);
  }

  const modelGroup = new THREE.Group();
  scene.add(modelGroup);

  return { renderer, scene, modelGroup, planes };
}

function makePlane(color: number, kind: "XY" | "XZ" | "YZ"): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(60, 60);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // PlaneGeometry is in XY by default.
  if (kind === "XZ") mesh.rotateX(Math.PI / 2);
  if (kind === "YZ") mesh.rotateY(Math.PI / 2);
  mesh.renderOrder = -1;
  mesh.userData.plane = kind;
  return mesh;
}
