// Measure (Inspect): click a face or edge to read its size, or a second one to
// read the distance between them. While aiming, whatever would be picked lights
// up under the cursor. Between two picks the tool reports the TRUE SHORTEST
// distance (min over vertex↔triangle both ways + segment↔segment — exact for
// planar faces / straight edges at any tessellation), draws a marker line
// between the closest pair, and lists the closest-approach ΔX/ΔY/ΔZ + angle.
// Computed from the tessellated model: instant, no rebuild round-trip.

import * as THREE from "three";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";
import type { Viewport } from "../viewport/viewport";
import type { Hit } from "../viewport/picking";
import { setPrompt } from "../ui/prompt";
import { getUnit, toDisplay, round } from "../ui/units";
import { esc } from "../ui/escape";

type Probe =
  | { kind: "face"; faceId: number; point: THREE.Vector3; dir: THREE.Vector3; area: number }
  | { kind: "edge"; line: Line2; point: THREE.Vector3; dir: THREE.Vector3; length: number };

/** Geometry soup for shortest-distance: triangles (faces only), segments, points. */
interface Soup {
  tris: THREE.Triangle[];
  segs: [THREE.Vector3, THREE.Vector3][];
  pts: THREE.Vector3[];
}

export class MeasureTool {
  active = false;
  private probes: Probe[] = [];
  private panel: HTMLDivElement | null = null;
  private onDone: (() => void) | null = null;
  private boundDown: (e: PointerEvent) => void;
  private boundMove: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(private viewport: Viewport) {
    this.boundDown = (e) => this.onDown(e);
    this.boundMove = (e) => this.onMove(e);
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
    el.addEventListener("pointermove", this.boundMove, true);
    window.addEventListener("keydown", this.boundKey, true);
    this.buildPanel();
    this.update();
    setPrompt("Measure: click a face or edge · click a second to measure between them · Esc to exit");
  }

  /** Start measuring with the first probe already picked (right-click →
   *  "Measure from here"): same as start() + one click on `hit`. */
  startWith(hit: Hit, onDone?: () => void) {
    if (this.active) return;
    this.start(onDone);
    const probe = this.toProbe(hit);
    if (!probe) return;
    this.probes.push(probe);
    this.highlight();
    this.update();
    setPrompt("Measure: click a second face or edge for the distance · Esc to exit");
  }

  private onMove(e: PointerEvent) {
    // live aiming feedback: light up exactly what a click would pick
    this.viewport.hoverEntity(this.viewport.pickEntity(e.clientX, e.clientY));
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const hit = this.viewport.pickEntity(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const probe = this.toProbe(hit);
    if (!probe) return;
    if (this.probes.length >= 2) {
      this.probes = []; // a 3rd pick starts fresh
      this.viewport.setMeasureMarker(null);
    }
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

  private soupOf(p: Probe): Soup {
    if (p.kind === "face") {
      const tris = this.viewport.faceTriangles(p.faceId);
      const segs: [THREE.Vector3, THREE.Vector3][] = [];
      const pts: THREE.Vector3[] = [];
      for (const t of tris) {
        segs.push([t.a, t.b], [t.b, t.c], [t.c, t.a]);
        pts.push(t.a, t.b, t.c);
      }
      return { tris, segs, pts };
    }
    const pts = (p.line.userData.points as [number, number, number][]).map(
      (q) => new THREE.Vector3(q[0], q[1], q[2]),
    );
    const segs: [THREE.Vector3, THREE.Vector3][] = [];
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
    return { tris: [], segs, pts };
  }

  /** True shortest distance between two probes: min over vertex↔triangle (both
   *  directions) and segment↔segment. Exact for planar faces and straight
   *  edges; a fine-tessellation approximation on curved geometry. */
  private closestPair(a: Probe, b: Probe): { d: number; pa: THREE.Vector3; pb: THREE.Vector3 } {
    const A = this.soupOf(a);
    const B = this.soupOf(b);
    let best = { d: Infinity, pa: a.point.clone(), pb: b.point.clone() };
    const tmp = new THREE.Vector3();

    const ptsVsTris = (pts: THREE.Vector3[], tris: THREE.Triangle[], flip: boolean) => {
      for (const p of pts) {
        for (const t of tris) {
          t.closestPointToPoint(p, tmp);
          const d = p.distanceTo(tmp);
          if (d < best.d) {
            best = flip
              ? { d, pa: tmp.clone(), pb: p.clone() }
              : { d, pa: p.clone(), pb: tmp.clone() };
          }
        }
      }
    };
    ptsVsTris(A.pts, B.tris, false);
    ptsVsTris(B.pts, A.tris, true);

    for (const [p1, q1] of A.segs) {
      for (const [p2, q2] of B.segs) {
        const [sa, sb] = closestOnSegments(p1, q1, p2, q2);
        const d = sa.distanceTo(sb);
        if (d < best.d) best = { d, pa: sa, pb: sb };
      }
    }
    return best;
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
      const near = this.closestPair(a, b);
      const delta = near.pb.clone().sub(near.pa);
      rows.push(["Distance", L(near.d)]);
      rows.push(["ΔX ΔY ΔZ", xyz(delta)]);
      rows.push(["Centers", L(a.point.distanceTo(b.point))]);
      const ang = THREE.MathUtils.radToDeg(a.dir.angleTo(b.dir));
      rows.push(["Angle", `${round(ang)}°`]);
      this.viewport.setMeasureMarker(near.pa, near.pb);
    }

    this.panel.innerHTML =
      `<div class="measure-title">Measure</div>` +
      rows
        .map(
          ([k, v]) =>
            `<div class="measure-row"><span class="measure-k">${esc(k)}</span><span class="measure-v">${esc(v)}</span></div>`,
        )
        .join("") +
      `<div class="measure-hint">Esc to exit</div>`;
  }

  stop() {
    if (!this.active) return;
    const el = this.viewport.domElement;
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointermove", this.boundMove, true);
    window.removeEventListener("keydown", this.boundKey, true);
    this.panel?.remove();
    this.panel = null;
    this.viewport.setMeasureMarker(null);
    this.viewport.hoverEntity(null);
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

/** Closest points between segments [p1,q1] and [p2,q2] (Ericson, Real-Time
 *  Collision Detection §5.1.9), robust for parallel/degenerate segments. */
function closestOnSegments(
  p1: THREE.Vector3,
  q1: THREE.Vector3,
  p2: THREE.Vector3,
  q2: THREE.Vector3,
): [THREE.Vector3, THREE.Vector3] {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const EPS = 1e-12;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const bb = d1.dot(d2);
      const denom = a * e - bb * bb;
      s = denom > EPS ? THREE.MathUtils.clamp((bb * f - c * e) / denom, 0, 1) : 0;
      t = (bb * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((bb - c) / a, 0, 1);
      }
    }
  }
  return [p1.clone().addScaledVector(d1, s), p2.clone().addScaledVector(d2, t)];
}
