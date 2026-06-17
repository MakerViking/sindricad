// Cameras + navigation. Perspective and Orthographic kept in parallel; toggle
// preserves apparent zoom. camera-controls (yomotsu) with a Fusion-style mouse
// map: middle = orbit, right = pan, wheel = zoom; Shift+middle = pan.

import * as THREE from "three";
import CameraControls from "camera-controls";

CameraControls.install({ THREE });

const FOV = 45;

export interface CameraRig {
  controls: CameraControls;
  get active(): THREE.Camera;
  isOrtho(): boolean;
  toggleProjection(): void;
  resize(w: number, h: number): void;
  update(dt: number): boolean;
  fit(box: THREE.Box3, enableTransition?: boolean): void;
  setStandardView(view: StandardView): void;
  lookAtPlane(
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    up: THREE.Vector3,
  ): void;
  restoreUp(): void;
}

export type StandardView =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "iso";

export function createCameraRig(
  dom: HTMLElement,
  aspect: number,
): CameraRig {
  const persp = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 10000);
  persp.up.set(0, 0, 1); // Z-up
  persp.position.set(80, -120, 90);

  const frustum = 100;
  const ortho = new THREE.OrthographicCamera(
    (-frustum * aspect) / 2,
    (frustum * aspect) / 2,
    frustum / 2,
    -frustum / 2,
    -10000,
    10000,
  );
  ortho.up.set(0, 0, 1);
  ortho.position.copy(persp.position);

  let usingOrtho = false;
  let active: THREE.Camera = persp;

  const controls = new CameraControls(persp, dom);
  // camera-controls assumes Y-up by default; tell it we orbit around +Z so the
  // ViewCube, standard views, and orbit all behave in CAD (Z-up) space.
  controls.updateCameraUp();

  // Fusion mouse map
  const A = CameraControls.ACTION;
  controls.mouseButtons.left = A.NONE; // left reserved for selection
  controls.mouseButtons.middle = A.ROTATE;
  controls.mouseButtons.right = A.TRUCK;
  controls.mouseButtons.wheel = A.DOLLY;

  // Shift+middle => pan (swap orbit<->truck on the middle button)
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") controls.mouseButtons.middle = A.TRUCK;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") controls.mouseButtons.middle = A.ROTATE;
  });

  controls.dollyToCursor = true;
  controls.setTarget(0, 0, 0, false);

  function setWheelForProjection() {
    controls.mouseButtons.wheel = usingOrtho
      ? CameraControls.ACTION.ZOOM
      : CameraControls.ACTION.DOLLY;
  }

  const rig: CameraRig = {
    controls,
    get active() {
      return active;
    },
    isOrtho() {
      return usingOrtho;
    },
    toggleProjection() {
      const from = active;
      const to = usingOrtho ? persp : ortho;
      // preserve apparent size: match ortho frustum to the perspective frustum
      // height at the target distance (and vice versa).
      const dist = controls.distance;
      if (!usingOrtho) {
        // persp -> ortho
        const h = 2 * Math.tan((FOV * Math.PI) / 180 / 2) * dist;
        const aspect2 =
          (persp.aspect as number) || ortho.right / ortho.top || 1;
        ortho.top = h / 2;
        ortho.bottom = -h / 2;
        ortho.left = (-h * aspect2) / 2;
        ortho.right = (h * aspect2) / 2;
        ortho.updateProjectionMatrix();
      }
      to.position.copy(from.position);
      to.quaternion.copy(from.quaternion);
      usingOrtho = !usingOrtho;
      active = to;
      controls.camera = to as THREE.PerspectiveCamera & THREE.OrthographicCamera;
      controls.updateCameraUp();
      setWheelForProjection();
    },
    resize(w: number, h: number) {
      const aspect2 = w / h;
      persp.aspect = aspect2;
      persp.updateProjectionMatrix();
      const halfH = (ortho.top - ortho.bottom) / 2;
      ortho.left = -halfH * aspect2;
      ortho.right = halfH * aspect2;
      ortho.updateProjectionMatrix();
    },
    update(dt: number) {
      return controls.update(dt);
    },
    fit(box: THREE.Box3, enableTransition = true) {
      // Manual fit that PRESERVES the current view direction. (camera-controls'
      // fitToBox resets the orbit to an axis view under a Z-up camera.)
      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere(center.clone()));
      const r = sphere.radius * 1.15; // padding
      const dir = controls
        .getPosition(new THREE.Vector3())
        .sub(controls.getTarget(new THREE.Vector3()))
        .normalize();
      if (dir.lengthSq() < 1e-6) dir.set(1, -1, 0.8).normalize();

      let dist: number;
      if (usingOrtho) {
        // frame the sphere by setting the ortho zoom via frustum height
        const aspect2 = (ortho.right - ortho.left) / (ortho.top - ortho.bottom);
        const halfH = Math.max(r, r / Math.max(aspect2, 1e-3));
        ortho.top = halfH;
        ortho.bottom = -halfH;
        ortho.left = -halfH * aspect2;
        ortho.right = halfH * aspect2;
        ortho.updateProjectionMatrix();
        dist = Math.max(controls.distance, r * 2);
      } else {
        dist = r / Math.sin((FOV * Math.PI) / 180 / 2);
      }
      controls.setTarget(center.x, center.y, center.z, enableTransition);
      controls.setPosition(
        center.x + dir.x * dist,
        center.y + dir.y * dist,
        center.z + dir.z * dist,
        enableTransition,
      );
    },
    setStandardView(view: StandardView) {
      const d = Math.max(controls.distance, 50);
      const dirs: Record<StandardView, [number, number, number]> = {
        front: [0, -1, 0],
        back: [0, 1, 0],
        left: [-1, 0, 0],
        right: [1, 0, 0],
        top: [0, 0, 1],
        bottom: [0, 0, -1],
        iso: [1, -1, 0.8],
      };
      const [x, y, z] = dirs[view];
      const t = controls.getTarget(new THREE.Vector3());
      const n = new THREE.Vector3(x, y, z).normalize().multiplyScalar(d);
      controls.setPosition(t.x + n.x, t.y + n.y, t.z + n.z, true);
    },
    lookAtPlane(origin, normal, up) {
      // Square the camera to a sketch plane: up = sketch +Y, look down -normal.
      persp.up.copy(up);
      ortho.up.copy(up);
      controls.updateCameraUp();
      const dist = Math.max(controls.distance, 120);
      const eye = origin.clone().addScaledVector(normal, dist);
      controls.setLookAt(
        eye.x,
        eye.y,
        eye.z,
        origin.x,
        origin.y,
        origin.z,
        true,
      );
    },
    restoreUp() {
      persp.up.set(0, 0, 1);
      ortho.up.set(0, 0, 1);
      controls.updateCameraUp();
    },
  };

  return rig;
}
