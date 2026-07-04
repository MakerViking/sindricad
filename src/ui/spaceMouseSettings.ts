// 3D-Mouse settings modal: calibrate the SpaceMouse without guessing the
// hardware. Shows a LIVE raw-axis readout (push/twist the puck → see which axis
// moves), lets you bind each camera action to any axis + invert + set
// sensitivity, and a TEST CUBE driven by the puck (with the current mapping) so
// you can confirm the feel. All edits apply live and persist.

import * as THREE from "three";
import {
  AXIS_LABELS,
  AXIS_NAMES,
  ACTION_LABELS,
  getLatestMotion,
  getSpaceMouseConfig,
  onSpaceMouseMotion,
  resetSpaceMouseConfig,
  setSpaceMouseConfig,
  type ActionName,
  type AxisName,
  type Motion,
} from "../input/spacemouse";

export class SpaceMouseSettings {
  private overlay: HTMLDivElement | null = null;
  private bars = new Map<AxisName, HTMLDivElement>();
  private unsub: (() => void) | null = null;
  private raf = 0;
  private three: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    cam: THREE.PerspectiveCamera;
    cube: THREE.Group;
    right: THREE.Vector3;
    up: THREE.Vector3;
  } | null = null;
  private lastMotion: Motion = getLatestMotion();
  private lastT = 0;
  private clock = 0;

  open() {
    if (this.overlay) return;
    this.build();
    this.unsub = onSpaceMouseMotion((m) => {
      this.lastMotion = m;
      this.clock = performance.now();
      this.updateBars(m);
    });
    this.lastT = performance.now();
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.tickTest();
    };
    this.raf = requestAnimationFrame(tick);
  }

  close() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.unsub?.();
    this.unsub = null;
    if (this.three) {
      this.three.renderer.dispose();
      this.three = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.bars.clear();
  }

  private build() {
    const cfg = getSpaceMouseConfig();
    const overlay = el("div", "modal-overlay") as HTMLDivElement;
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) this.close();
    });
    const panel = el("div", "modal-panel");
    overlay.appendChild(panel);

    const head = el("div", "modal-head");
    head.appendChild(text("h2", "3D Mouse Settings"));
    const x = el("button", "modal-close") as HTMLButtonElement;
    x.textContent = "✕";
    x.onclick = () => this.close();
    head.appendChild(x);
    panel.appendChild(head);

    const body = el("div", "modal-body sm-grid");
    panel.appendChild(body);

    // --- left column: live axes + test cube ---
    const left = el("div", "sm-col");
    left.appendChild(text("div", "Live axes — move the puck", "sm-section"));
    const hint = text("div", "Push/tilt/twist and watch which bar reacts, then map it below.", "sm-hint");
    left.appendChild(hint);
    for (const a of AXIS_NAMES) {
      const row = el("div", "sm-axis-row");
      row.appendChild(text("span", AXIS_LABELS[a], "sm-axis-label"));
      const track = el("div", "sm-axis-track");
      const bar = el("div", "sm-axis-bar") as HTMLDivElement;
      track.appendChild(bar);
      row.appendChild(track);
      this.bars.set(a, bar);
      left.appendChild(row);
    }
    left.appendChild(text("div", "Test — rotate the cube", "sm-section"));
    const testCanvas = el("canvas", "sm-test") as HTMLCanvasElement;
    testCanvas.width = 240;
    testCanvas.height = 170;
    left.appendChild(testCanvas);
    body.appendChild(left);

    // --- right column: mode, sensitivities, mappings ---
    const right = el("div", "sm-col");

    right.appendChild(text("div", "Mode", "sm-section"));
    const modeRow = el("div", "sm-row");
    for (const m of ["object", "camera"] as const) {
      const lab = el("label", "sm-radio");
      const r = el("input") as HTMLInputElement;
      r.type = "radio";
      r.name = "sm-mode";
      r.checked = cfg.mode === m;
      r.onchange = () => setSpaceMouseConfig({ mode: m });
      lab.append(r, document.createTextNode(m === "object" ? " Move object" : " Move camera"));
      modeRow.appendChild(lab);
    }
    right.appendChild(modeRow);

    right.appendChild(text("div", "Sensitivity", "sm-section"));
    right.appendChild(this.slider("Pan", cfg.panSens, 0, 0.000003, (v) => setSpaceMouseConfig({ panSens: v })));
    right.appendChild(this.slider("Zoom", cfg.zoomSens, 0, 0.0000035, (v) => setSpaceMouseConfig({ zoomSens: v })));
    right.appendChild(this.slider("Rotate", cfg.orbitSens, 0, 0.00001, (v) => setSpaceMouseConfig({ orbitSens: v })));
    right.appendChild(this.slider("Deadzone", cfg.deadzone, 0, 200, (v) => setSpaceMouseConfig({ deadzone: v }), 1));

    right.appendChild(text("div", "Axis mapping", "sm-section"));
    for (const action of Object.keys(ACTION_LABELS) as ActionName[]) {
      right.appendChild(this.mappingRow(action));
    }

    const foot = el("div", "modal-foot");
    const reset = el("button", "btn") as HTMLButtonElement;
    reset.textContent = "Reset to defaults";
    reset.onclick = () => {
      resetSpaceMouseConfig();
      this.close();
      this.open(); // rebuild from defaults
    };
    const done = el("button", "btn btn-primary") as HTMLButtonElement;
    done.textContent = "Done";
    done.onclick = () => this.close();
    foot.append(reset, done);

    body.appendChild(right);
    panel.appendChild(foot);
    document.body.appendChild(overlay);
    this.overlay = overlay;

    this.initTest(testCanvas);
  }

  private slider(
    label: string,
    value: number,
    min: number,
    max: number,
    onInput: (v: number) => void,
    step?: number,
  ): HTMLElement {
    const row = el("div", "sm-row");
    row.appendChild(text("span", label, "sm-slabel"));
    const r = el("input") as HTMLInputElement;
    r.type = "range";
    r.min = String(min);
    r.max = String(max);
    r.step = String(step ?? (max - min) / 100);
    r.value = String(value);
    const out = text("span", fmt(value), "sm-sval");
    r.oninput = () => {
      const v = parseFloat(r.value);
      out.textContent = fmt(v);
      onInput(v);
    };
    row.append(r, out);
    return row;
  }

  private mappingRow(action: ActionName): HTMLElement {
    const cfg = getSpaceMouseConfig();
    const b = cfg.bind[action];
    const row = el("div", "sm-map-row");
    row.appendChild(text("span", ACTION_LABELS[action], "sm-map-label"));
    const sel = el("select", "sm-select") as HTMLSelectElement;
    for (const a of AXIS_NAMES) {
      const o = document.createElement("option");
      o.value = a;
      o.textContent = AXIS_LABELS[a];
      if (a === b.src) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () =>
      setSpaceMouseConfig({ bind: { [action]: { ...cfg.bind[action], src: sel.value as AxisName } } as any });
    const inv = el("label", "sm-inv");
    const c = el("input") as HTMLInputElement;
    c.type = "checkbox";
    c.checked = b.invert;
    c.onchange = () =>
      setSpaceMouseConfig({ bind: { [action]: { ...cfg.bind[action], invert: c.checked } } as any });
    inv.append(c, document.createTextNode(" flip"));
    row.append(sel, inv);
    return row;
  }

  // --- live axis bars ---
  private updateBars(m: Motion) {
    const SCALE = 350; // raw axis range is roughly +/-350
    for (const a of AXIS_NAMES) {
      const bar = this.bars.get(a);
      if (!bar) continue;
      const v = Math.max(-1, Math.min(1, m[a] / SCALE));
      bar.style.width = `${Math.abs(v) * 50}%`;
      bar.style.left = v >= 0 ? "50%" : `${50 - Math.abs(v) * 50}%`;
      const dead = Math.abs(m[a]) < getSpaceMouseConfig().deadzone;
      bar.style.background = dead ? "var(--text-mute, #6b7280)" : "var(--accent, #ff7a3c)";
    }
  }

  // --- test cube ---
  private initTest(canvas: HTMLCanvasElement) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.width, canvas.height, false);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, 0.1, 100);
    cam.up.set(0, 0, 1);
    cam.position.set(4, -5, 3.5);
    cam.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202428, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, -4, 6);
    scene.add(key);
    const cube = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshStandardMaterial({ color: 0x9aa3af, metalness: 0.1, roughness: 0.6 }),
    );
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box.geometry),
      new THREE.LineBasicMaterial({ color: 0xff7a3c }),
    );
    cube.add(box, edges);
    // a marker on +X so rotation is obvious
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xff7a3c }),
    );
    dot.position.set(1, 0, 0);
    cube.add(dot);
    scene.add(cube);
    this.three = {
      renderer,
      scene,
      cam,
      cube,
      right: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 0, 1),
    };
  }

  private tickTest() {
    const t = this.three;
    if (!t) return;
    const now = performance.now();
    const dt = Math.min(50, now - this.lastT);
    this.lastT = now;
    const cfg = getSpaceMouseConfig();
    const stale = now - this.clock > cfg.staleMs;
    const m = stale ? { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 } : this.lastMotion;
    const dz = (v: number) => (Math.abs(v) < cfg.deadzone ? 0 : v);
    const val = (a: ActionName) => {
      const b = cfg.bind[a];
      if (!b) return 0; // tolerate a missing binding instead of crashing the loop
      return (b.invert ? -1 : 1) * dz(m[b.src]);
    };

    // Drive the cube with EVERY mapped action so any gesture gives feedback:
    // rotate accumulates (the thing being tested); pan/zoom nudge then spring
    // back so they read as "live while held". Gains are scaled up from the
    // camera sensitivities so motion is visible at this small size.
    // Rotate — sign mirrors object mode (the cube IS the object).
    // The cube shows what the MODEL appears to do = the inverse of the camera
    // motion the real loop applies (which carries modeSign). So the cube
    // coefficient is -modeSign: +1 in object mode, -1 in camera mode. Verified
    // against the real viewport so the cube and model move the same screen way.
    const ms = cfg.mode === "object" ? 1 : -1;
    const kr = cfg.orbitSens * dt * 50;
    const az = ms * val("orbitAz") * kr;
    const pol = ms * val("orbitPolar") * kr;
    const fwd = t.cam.getWorldDirection(new THREE.Vector3());
    const right = fwd.clone().cross(t.up).normalize();
    const screenUp = right.clone().cross(fwd).normalize();
    if (az) t.cube.rotateOnWorldAxis(t.up, az);
    if (pol) t.cube.rotateOnWorldAxis(right, pol);
    const rollc = ms * val("roll") * kr;
    if (rollc) t.cube.rotateOnWorldAxis(fwd, rollc); // bank around the view axis

    // Pan — nudge in the screen plane, then spring back. Gentle gain + a hard
    // clamp so the cube can never leave the little preview (this is a feel test,
    // not a 1:1 move).
    const kp = cfg.panSens * dt * 30; // v2 sens are ~100× smaller (view-proportional)
    t.cube.position
      .addScaledVector(right, ms * val("panX") * kp)
      // vertical pan is inverted vs the model's truck convention (Pan ←→ isn't)
      .addScaledVector(screenUp, -ms * val("panY") * kp);
    const PAN_LIMIT = 1.3;
    if (t.cube.position.length() > PAN_LIMIT) t.cube.position.setLength(PAN_LIMIT);
    // Zoom — scale gently; bound the per-frame step so a hard push can't invert
    // the cube (negative scale).
    const zd = THREE.MathUtils.clamp(val("zoom") * cfg.zoomSens * dt * 430, -0.08, 0.08);
    if (zd) t.cube.scale.multiplyScalar(1 + zd); // +zoom dollies in on the model → cube grows

    // Spring pan + zoom back toward home so they read as "live while held".
    const decay = Math.min(1, 0.07 * (dt / 16));
    t.cube.position.multiplyScalar(1 - decay);
    const s = THREE.MathUtils.clamp(t.cube.scale.x + (1 - t.cube.scale.x) * decay, 0.6, 1.6);
    t.cube.scale.setScalar(s);

    t.renderer.render(t.scene, t.cam);
  }
}

// --- tiny DOM helpers ---
function el(tag: string, cls = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function text(tag: string, txt: string, cls = ""): HTMLElement {
  const e = el(tag, cls);
  e.textContent = txt;
  return e;
}
function fmt(v: number): string {
  if (v === 0) return "0";
  if (Math.abs(v) >= 1) return String(Math.round(v));
  return v.toPrecision(2);
}
