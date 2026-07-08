// Scene setup: renderer, lights, Z-up grid + axes, sketch planes.
// CAD convention is Z-up (matches build123d), so the ground grid lies
// in the XY plane and cameras use up = +Z.

import * as THREE from "three";
import { niceStep } from "../ui/units";

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  modelGroup: THREE.Group; // rebuilt geometry lives here
  planes: Record<"XY" | "XZ" | "YZ", THREE.Mesh>;
  grid: AdaptiveGrid;
}

/** A ground grid (XY plane) whose spacing snaps to nice 1/2/5×10ⁿ mm values and
 *  rescales with zoom, recentred on the camera target so it always fills the view
 *  with round-number lines. Two layers: dim minor + brighter major (every 5th). */
export class AdaptiveGrid {
  readonly group = new THREE.Group();
  step = 1; // current minor-line spacing in mm
  private minor: THREE.GridHelper | null = null;
  private major: THREE.GridHelper | null = null;
  private key = "";

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** worldPerPixel = world mm covered by one screen pixel at the target.
   *  gridZ = the height the grid sits at (the model's floor, or 0 when empty). */
  update(targetX: number, targetY: number, worldPerPixel: number, gridZ = 0) {
    this.group.position.z = gridZ; // track the model floor every frame, even if x/y/cell are cached
    const cell = niceStep(worldPerPixel * 64); // ~64px minor cells
    const majorCell = cell * 5;
    const cx = Math.round(targetX / majorCell) * majorCell;
    const cy = Math.round(targetY / majorCell) * majorCell;
    const k = `${cell}:${cx}:${cy}`;
    if (k === this.key) return;
    this.key = k;
    this.step = cell;
    this.rebuild(cell);
    this.group.position.set(cx, cy, gridZ);
  }

  private rebuild(cell: number) {
    this.dispose();
    const cells = 100; // extent = cell*100 (covers several screens)
    // center-line color == grid color so GridHelper draws no misplaced axes
    // (the world AxesHelper shows the real origin axes).
    this.minor = new THREE.GridHelper(cell * cells, cells, 0x23272e, 0x23272e);
    this.major = new THREE.GridHelper(cell * cells, cells / 5, 0x3a4048, 0x3a4048);
    for (const g of [this.minor, this.major]) {
      g.rotateX(Math.PI / 2); // GridHelper is XZ by default → lay flat on XY
      (g.material as THREE.Material).depthWrite = false;
      g.renderOrder = -2;
      this.group.add(g);
    }
  }

  private dispose() {
    for (const g of [this.minor, this.major]) {
      if (!g) continue;
      this.group.remove(g);
      g.geometry.dispose();
      (g.material as THREE.Material).dispose();
    }
    this.minor = this.major = null;
  }
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

  // --- Z-up adaptive ground grid in the XY plane (rescales with zoom) ---
  const grid = new AdaptiveGrid(scene);

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

  return { renderer, scene, modelGroup, planes, grid };
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
