// Measure (Inspect): click a face or edge to read its size, or a second one to
// read the distance + delta + angle between them. Computed from the tessellated
// model (instant, no rebuild) — exact for planar faces / straight edges, a close
// approximation for curved geometry (fine tessellation). Results show in a small
// floating panel; the picked entities highlight.

import * as THREE from "three";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";
import type { Viewport } from "../viewport/viewport";
import type { Hit } from "../viewport/picking";
import { setPrompt } from "../ui/prompt";
import { getUnit, toDisplay, round } from "../ui/units";

type Probe =
  | { kind: "face"; faceId: number; point: THREE.Vector3; dir: THREE.Vector3; area: number }
  | { kind: "edge"; line: Line2; point: THREE.Vector3; dir: THREE.Vector3; length: number };

export class MeasureTool {
  active = false;
  private probes: Probe[] = [];
  private panel: HTMLDivElement | null = null;
  private onDone: (() => void) | null = null;
  private boundDown: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(private viewport: Viewport) {
    this.boundDown = (e) => this.onDown(e);
    this.boundKey = (e) => this.onKey(e);
  }

  start(onDone?: () => void) {
    if (this.active) return;
    this.active = true;
    this.onDone = onDone ?? null;
    this.probes = [];
    this.viewport.suspendPicking = true;
    this.viewport.clearSelection();
    const el = this.viewport.domElement;
    el.addEventListener("pointerdown", this.boundDown, true);
    window.addEventListener("keydown", this.boundKey, true);
    this.buildPanel();
    this.update();
    setPrompt("Measure: click a face or edge · click a second to measure between them · Esc to exit");
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const hit = this.viewport.pickEntity(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const probe = this.toProbe(hit);
    if (!probe) return;
    if (this.probes.length >= 2) this.probes = []; // a 3rd pick starts fresh
    this.probes.push(probe);
    this.highlight();
    this.update();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.stop();
  }

  private toProbe(hit: Hit): Probe | null {
    if (hit.kind === "face") {
      const m = this.viewport.measureFace(hit.faceId);
      return { kind: "face", faceId: hit.faceId, point: m.centroid, dir: m.normal, area: m.area };
    }
    const pts = (hit.line.userData.points as [number, number, number][]).map(
      (p) => new THREE.Vector3(p[0], p[1], p[2]),
    );
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += pts[i].distanceTo(pts[i - 1]);
    const mid = pts[Math.floor(pts.length / 2)];
    const dir = pts[pts.length - 1].clone().sub(pts[0]).normalize();
    return { kind: "edge", line: hit.line, point: mid, dir, length };
  }

  private highlight() {
    const faceIds = this.probes.filter((p) => p.kind === "face").map((p) => (p as { faceId: number }).faceId);
    const lines = this.probes.filter((p) => p.kind === "edge").map((p) => (p as { line: Line2 }).line);
    this.viewport.measureHighlight(faceIds, lines);
  }

  private buildPanel() {
    const p = document.createElement("div");
    p.className = "measure-panel";
    document.body.appendChild(p);
    this.panel = p;
  }

  private update() {
    if (!this.panel) return;
    const unit = getUnit();
    const f = toDisplay(1); // display units per mm (area uses f²)
    const L = (mm: number) => `${round(toDisplay(mm))} ${unit}`;
    const A = (mm2: number) => `${round(mm2 * f * f)} ${unit}²`;
    const xyz = (v: THREE.Vector3) => `${round(toDisplay(v.x))}, ${round(toDisplay(v.y))}, ${round(toDisplay(v.z))}`;

    const rows: [string, string][] = [];
    const [a, b] = this.probes;
    if (!a) {
      rows.push(["", "Pick a face or edge"]);
    } else if (!b) {
      if (a.kind === "face") rows.push(["Area", A(a.area)]);
      else rows.push(["Length", L(a.length)]);
      rows.push(["At", xyz(a.point)]);
    } else {
      const d = a.point.distanceTo(b.point);
      const delta = b.point.clone().sub(a.point);
      rows.push(["Distance", L(d)]);
      rows.push(["ΔX ΔY ΔZ", xyz(delta)]);
      const ang = THREE.MathUtils.radToDeg(a.dir.angleTo(b.dir));
      rows.push(["Angle", `${round(ang)}°`]);
    }

    this.panel.innerHTML =
      `<div class="measure-title">Measure</div>` +
      rows
        .map(
          ([k, v]) =>
            `<div class="measure-row"><span class="measure-k">${k}</span><span class="measure-v">${v}</span></div>`,
        )
        .join("") +
      `<div class="measure-hint">Esc to exit</div>`;
  }

  stop() {
    if (!this.active) return;
    const el = this.viewport.domElement;
    el.removeEventListener("pointerdown", this.boundDown, true);
    window.removeEventListener("keydown", this.boundKey, true);
    this.panel?.remove();
    this.panel = null;
    this.viewport.clearSelection();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.probes = [];
    setPrompt(null);
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }
}
