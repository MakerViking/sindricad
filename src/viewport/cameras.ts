// Cameras + navigation. Perspective and Orthographic kept in parallel; toggle
// preserves apparent zoom. camera-controls (yomotsu) with a MCAD-style mouse
// map: middle = orbit, right = pan, wheel = zoom; Shift+middle = pan.

import * as THREE from "three";
import CameraControls from "camera-controls";

CameraControls.install({ THREE });

const FOV = 45;
// Closest the perspective camera may sit to its pivot (mm). Kept comfortably above
// the camera's near plane (0.1) so an extreme zoom-in can't push the surface behind
// near — which used to clip the whole model away, leaving just the grid.
const MIN_PERSP_DIST = 0.5;

export interface CameraRig {
  controls: CameraControls;
  get active(): THREE.Camera;
  isOrtho(): boolean;
  /** 'auto' = Fusion's "Perspective with Ortho Faces": perspective while orbiting,
   *  orthographic whenever the view axis is world-axis-aligned — so straight-on
   *  views are truly flat (no parallax skew between bodies). */
  projectionMode(): ProjectionMode;
  setProjectionMode(mode: ProjectionMode): void;
  resize(w: number, h: number): void;
  update(dt: number): boolean;
  /** Zoom by a multiplicative factor (>1 = zoom out, <1 = zoom in). Works in BOTH
   *  projections via absolute dolly/zoom, so it's immune to the wheel-action
   *  ambiguity that left perspective unable to zoom in WebKitGTK. When `pivot`
   *  (a world point, usually under the cursor) is given, zooms TOWARD it
   *  (MCAD-style dolly-to-cursor) instead of toward the orbit target. */
  zoomBy(factor: number, pivot?: THREE.Vector3): void;
  /** Half the visible view height at the orbit target, in world units — the
   *  natural scale for making input steps (SpaceMouse pan) zoom-proportional
   *  in BOTH projections, like wheel zoom already is. */
  viewScale(): number;
  fit(box: THREE.Box3, enableTransition?: boolean): void;
  setStandardView(view: StandardView): void;
  /** orient to an arbitrary view direction (eye = target + dir·d), with a chosen
   *  world up. Used by the ViewCube for corners/edges and for redefined sides. */
  setViewDir(dir: THREE.Vector3, up: THREE.Vector3): void;
  /** Roll (bank) the view around the forward / screen-into-monitor axis by
   *  `angle` radians. camera-controls has no native roll, so we rotate the
   *  camera up-vector about the view direction and re-apply it. */
  roll(angle: number): void;
  /** Free-orbit by az/pol radians about the SCREEN axes (SpaceMouse tumble).
   *  Unlike controls.rotate(), which camera-controls clamps just short of the
   *  poles every frame (Spherical.makeSafe), this rotates the orbit up-vector
   *  along with the camera, so vertical orbit passes straight over the top —
   *  3Dconnexion-style free rotation, upside down included. */
  tumble(az: number, pol: number): void;
  /** Lock out mouse orbit (sketch "lock to plane"); middle-drag pans instead. */
  setOrbitLocked(locked: boolean): void;
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

export type ProjectionMode = "persp" | "ortho" | "auto";

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
  let mode: ProjectionMode = "auto";
  let rollAngle = 0; // persistent view bank (radians), re-applied each update()
  let orbitLocked = false; // sketch "lock to plane": disable mouse orbit
  // ortho zoom queued this frame but not yet applied by controls.update() —
  // lets same-frame wheel bursts chain correctly (see zoomBy).
  let pendingOrthoZoom: number | null = null;

  const controls = new CameraControls(persp, dom);
  // camera-controls assumes Y-up by default; tell it we orbit around +Z so the
  // ViewCube, standard views, and orbit all behave in CAD (Z-up) space.
  controls.updateCameraUp();

  // mainstream MCAD mouse map. Wheel is handled explicitly by the viewport (rig.zoomBy)
  // rather than camera-controls' built-in action: its perspective DOLLY wheel was
  // unreliable in the WebKitGTK webview, and an absolute dolly/zoom is robust.
  const A = CameraControls.ACTION;
  controls.mouseButtons.left = A.NONE; // left reserved for selection
  controls.mouseButtons.middle = A.ROTATE;
  controls.mouseButtons.right = A.TRUCK;
  controls.mouseButtons.wheel = A.NONE;

  // Shift+middle => pan (swap orbit<->truck on the middle button)
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift" && !orbitLocked) controls.mouseButtons.middle = A.TRUCK;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && !orbitLocked) controls.mouseButtons.middle = A.ROTATE;
  });

  controls.dollyToCursor = true;
  controls.setTarget(0, 0, 0, false);

  // Swap the active camera between projections, preserving apparent zoom in BOTH
  // directions. 'auto' mode swaps constantly (every axis-align / orbit-away), so
  // any scale mismatch would pop visibly: persp→ortho bakes the scale into the
  // frustum and clears residual ortho zoom; ortho→persp dollies to the distance
  // that reproduces the ortho apparent height.
  function swapProjection() {
    const from = active;
    const to = usingOrtho ? persp : ortho;
    const dist = controls.distance;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    if (!usingOrtho) {
      // persp -> ortho: match ortho frustum to the perspective frustum height
      const h = 2 * Math.tan((FOV * Math.PI) / 180 / 2) * dist;
      const aspect2 = (persp.aspect as number) || ortho.right / ortho.top || 1;
      ortho.top = h / 2;
      ortho.bottom = -h / 2;
      ortho.left = (-h * aspect2) / 2;
      ortho.right = (h * aspect2) / 2;
      ortho.updateProjectionMatrix();
      usingOrtho = true;
      active = to;
      controls.camera = to as THREE.PerspectiveCamera & THREE.OrthographicCamera;
      controls.updateCameraUp();
      controls.zoomTo(1, false); // frustum now carries the scale
    } else {
      // ortho -> persp: reproduce the ortho apparent height at the target
      const halfH = (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      const newDist = Math.max(
        MIN_PERSP_DIST,
        halfH / Math.tan((FOV * Math.PI) / 360),
      );
      usingOrtho = false;
      active = to;
      controls.camera = to as THREE.PerspectiveCamera & THREE.OrthographicCamera;
      controls.updateCameraUp();
      controls.dollyTo(newDist, false);
    }
  }

  // 'auto' snaps to ortho when the view axis is within this of a world axis.
  // 0.5°: standard-view transitions converge well inside it, while the smallest
  // deliberate orbit nudge (~0.4°/px) leaves it after a couple of pixels.
  const AXIS_SNAP_COS = Math.cos((0.5 * Math.PI) / 180);
  const tmpTarget = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  function viewAxisAligned(): boolean {
    const d = controls.getTarget(tmpTarget).sub(controls.getPosition(tmpPos));
    const len = d.length();
    if (len < 1e-9) return false;
    return Math.max(Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)) / len >= AXIS_SNAP_COS;
  }
  /** In 'auto', keep the actual projection in sync with the view axis. Returns
   *  true when a swap happened (caller should re-render). */
  function applyAutoProjection(): boolean {
    if (mode !== "auto") return false;
    if (viewAxisAligned() === usingOrtho) return false;
    swapProjection();
    return true;
  }

  const rig: CameraRig = {
    controls,
    get active() {
      return active;
    },
    isOrtho() {
      return usingOrtho;
    },
    projectionMode() {
      return mode;
    },
    setProjectionMode(m: ProjectionMode) {
      mode = m;
      const wantOrtho = m === "ortho" || (m === "auto" && viewAxisAligned());
      if (wantOrtho !== usingOrtho) swapProjection();
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
      pendingOrthoZoom = null; // camera.zoom is authoritative again after this update
      const moved = controls.update(dt);
      const swapped = applyAutoProjection();
      // Apply the persistent roll AFTER camera-controls positions the camera.
      // update() always rewrites the orientation from its own spherical state,
      // so re-banking every frame is idempotent — no drift, no position change,
      // and it never touches camera.up (so it can't fight the sketch-plane up
      // handling or desync camera-controls, which the old updateCameraUp roll did).
      if (rollAngle !== 0) {
        active.rotateZ(rollAngle); // camera local +Z is the view axis → banks in place
        active.updateMatrixWorld();
      }
      return moved || swapped || rollAngle !== 0;
    },
    viewScale() {
      if (usingOrtho) {
        return (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      }
      return controls.distance * Math.tan((FOV * Math.PI) / 360);
    },
    zoomBy(factor: number, pivot?: THREE.Vector3) {
      const f = Math.max(0.1, Math.min(10, factor));
      if (usingOrtho) {
        // ortho.zoom only commits at the next controls.update(); fast wheels
        // deliver several events per frame, so chain off the PENDING zoom or
        // each same-frame step recomputes k against a stale value (over-trucks
        // the cursor tracking and drops all but one step of zoom).
        const curZoom = pendingOrthoZoom ?? ortho.zoom;
        const newZoom = Math.max(1e-4, curZoom / f);
        pendingOrthoZoom = newZoom;
        if (pivot) {
          // keep the cursor point fixed on screen: TRUCK camera and target together
          // toward it as the frustum shrinks/grows (k = 1 − oldZoom/newZoom).
          // Moving only the target re-aims the camera at it — a rotation that
          // progressively tilted the locked sketch view ~3°/click. Translating
          // both endpoints by the same delta keeps the view direction bit-exact.
          const target = controls.getTarget(new THREE.Vector3());
          const pos = controls.getPosition(new THREE.Vector3());
          const k = 1 - curZoom / newZoom;
          const dx = (pivot.x - target.x) * k;
          const dy = (pivot.y - target.y) * k;
          const dz = (pivot.z - target.z) * k;
          controls.setLookAt(
            pos.x + dx,
            pos.y + dy,
            pos.z + dz,
            target.x + dx,
            target.y + dy,
            target.z + dz,
            false,
          );
        }
        controls.zoomTo(newZoom, false);
      } else if (pivot) {
        // Dolly at the CURSOR'S DEPTH, but strictly along the view axis. Scaling
        // about the raw cursor point also slides the camera sideways, and in
        // perspective any lateral camera move re-angles the model — one wheel click
        // visibly tilted a straight-on view. Projecting the pivot onto the view
        // axis keeps the viewing angle exactly fixed while zoom speed still tracks
        // the surface under the cursor. Clamp the final distance to MIN_PERSP_DIST
        // so it can't cross the near plane.
        const cam = controls.getPosition(new THREE.Vector3());
        const target = controls.getTarget(new THREE.Vector3());
        const dist = cam.distanceTo(target);
        let ff = f;
        if (dist * ff < MIN_PERSP_DIST) {
          if (dist <= MIN_PERSP_DIST) return; // already as close as we allow
          ff = MIN_PERSP_DIST / dist; // land exactly at the limit this step
        }
        const forward = target.clone().sub(cam).normalize();
        const depth = pivot.clone().sub(cam).dot(forward);
        // cursor point at/behind the camera (degenerate raycast) → dolly to target
        const axisPivot =
          depth > MIN_PERSP_DIST
            ? cam.clone().add(forward.multiplyScalar(depth))
            : target.clone();
        const nc = axisPivot.clone().add(cam.sub(axisPivot).multiplyScalar(ff));
        const nt = axisPivot.clone().add(target.sub(axisPivot).multiplyScalar(ff));
        controls.setLookAt(nc.x, nc.y, nc.z, nt.x, nt.y, nt.z, false);
      } else {
        // no pivot (programmatic): plain dolly toward the orbit target
        controls.dollyTo(Math.max(MIN_PERSP_DIST, controls.distance * f), false);
      }
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
      rollAngle = 0;
      // a free tumble may have left the orbit up-vector anywhere; a standard
      // view means "square me to the world" — restore Z-up first
      persp.up.set(0, 0, 1);
      ortho.up.set(0, 0, 1);
      controls.updateCameraUp();
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
    setViewDir(dir, up) {
      rollAngle = 0;
      // orient to a free direction with a chosen up. The camera keeps using +Z
      // up afterward for orbiting unless `up` differs; for the cube's axis views
      // (up = +Z) this matches setStandardView, and for top/bottom (up = ±Y) it
      // squares correctly. We set the camera up so the framing is upright.
      const d = Math.max(controls.distance, 50);
      const n = dir.clone().normalize();
      const u = up.clone().normalize();
      persp.up.copy(u);
      ortho.up.copy(u);
      controls.updateCameraUp();
      const t = controls.getTarget(new THREE.Vector3());
      controls.setLookAt(
        t.x + n.x * d,
        t.y + n.y * d,
        t.z + n.z * d,
        t.x,
        t.y,
        t.z,
        true,
      );
    },
    lookAtPlane(origin, normal, up) {
      rollAngle = 0;
      // Square the camera to a sketch plane: up = sketch +Y, look down -normal.
      // INSTANT (no transition): camera-controls aborts animated transitions on
      // any user input — a SpaceMouse twitch or an eager first click used to
      // strand the sketch view mid-flight at an oblique angle, which silently
      // ruined "draw exactly on the plane" precision. A snap is deterministic.
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
        false,
      );
    },
    restoreUp() {
      rollAngle = 0;
      // Re-seat the orbit AFTER changing up: updateCameraUp() only rebuilds the
      // internal up-basis — the stored spherical state still encodes the OLD
      // basis, so without setPosition the same numbers decode to a different
      // world position on the next tick (exiting a top-plane sketch snapped the
      // camera to a side-on view — the flat sketch "disappeared" edge-on).
      // Same getPosition→updateCameraUp→setPosition pattern as the library's
      // own applyCameraUp().
      const pos = controls.getPosition(new THREE.Vector3());
      persp.up.set(0, 0, 1);
      ortho.up.set(0, 0, 1);
      controls.updateCameraUp();
      controls.setPosition(pos.x, pos.y, pos.z, false);
    },
    roll(angle) {
      // accumulate; the bank is re-applied every frame in update(). Cheap and
      // safe — no camera-controls state is touched here.
      rollAngle += angle;
    },
    tumble(az, pol) {
      // Rotate the camera OFFSET and the orbit UP-VECTOR together about the
      // screen axes (yaw about visual up, pitch about visual right), then
      // re-seat camera-controls in the rotated up-space. Because offset and up
      // rotate by the same quaternion, the polar angle camera-controls sees
      // NEVER changes — the pole travels with the camera, so its per-frame
      // (0, π) clamp (Spherical.makeSafe) has nothing to bite. Axis signs
      // match controls.rotate(): +az orbits CCW seen from above, +pol tips
      // the camera downward.
      const target = controls.getTarget(new THREE.Vector3());
      const offset = controls.getPosition(new THREE.Vector3()).sub(target);
      active.updateMatrixWorld();
      // visual axes from the rendered orientation (roll bank included)
      const right = new THREE.Vector3().setFromMatrixColumn(active.matrixWorld, 0);
      const vup = new THREE.Vector3().setFromMatrixColumn(active.matrixWorld, 1);
      const q = new THREE.Quaternion()
        .setFromAxisAngle(vup.normalize(), az)
        .multiply(new THREE.Quaternion().setFromAxisAngle(right.normalize(), pol));
      offset.applyQuaternion(q);
      const u = persp.up.clone().applyQuaternion(q).normalize();
      persp.up.copy(u);
      ortho.up.copy(u);
      controls.updateCameraUp();
      controls.setLookAt(
        target.x + offset.x,
        target.y + offset.y,
        target.z + offset.z,
        target.x,
        target.y,
        target.z,
        false,
      );
    },
    setOrbitLocked(locked) {
      orbitLocked = locked;
      // middle-drag pans while locked (no orbit); restore orbit on unlock
      controls.mouseButtons.middle = locked ? A.TRUCK : A.ROTATE;
    },
  };

  return rig;
}
