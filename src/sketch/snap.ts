// Snapping in 2D sketch space. Candidates (endpoints/midpoints/centers from
// existing geometry) are compared to the cursor in SCREEN PIXELS so the snap
// radius is zoom-independent, like mainstream MCAD. Grid snapping is the low-priority
// fallback.

import * as THREE from "three";
import type { ProjectedCurve, ProjectedSource } from "../types";
import { circumcenter } from "./arc";

export type SnapKind =
  | "free"
  | "grid"
  | "endpoint"
  | "midpoint"
  | "center"
  | "on-x"
  | "on-y";

export interface SnapCandidate {
  p: THREE.Vector2;
  kind: SnapKind;
  priority: number; // higher wins
}

export interface SnapResult {
  point: THREE.Vector2;
  kind: SnapKind;
}

export function snap(
  raw: THREE.Vector2,
  candidates: SnapCandidate[],
  toScreen: (p: THREE.Vector2) => { x: number; y: number },
  gridStep: number,
  pixelTol = 10,
): SnapResult {
  const rawScreen = toScreen(raw);
  let best: SnapCandidate | null = null;
  let bestD = pixelTol;

  for (const c of candidates) {
    const s = toScreen(c.p);
    const d = Math.hypot(s.x - rawScreen.x, s.y - rawScreen.y);
    if (d <= pixelTol) {
      // within tolerance: prefer higher priority, then nearer
      if (
        !best ||
        c.priority > best.priority ||
        (c.priority === best.priority && d < bestD)
      ) {
        best = c;
        bestD = d;
      }
    }
  }

  if (best) return { point: best.p.clone(), kind: best.kind };

  if (gridStep <= 0) return { point: raw.clone(), kind: "free" }; // grid snap off

  // grid fallback (always available, lowest priority)
  const gx = Math.round(raw.x / gridStep) * gridStep;
  const gy = Math.round(raw.y / gridStep) * gridStep;
  const gridP = new THREE.Vector2(gx, gy);
  const gs = toScreen(gridP);
  if (Math.hypot(gs.x - rawScreen.x, gs.y - rawScreen.y) <= pixelTol) {
    return { point: gridP, kind: "grid" };
  }

  return { point: raw.clone(), kind: "free" };
}

/** snap candidates from resolved sketch entities (numbers, not params) */
export function candidatesFromEntities(
  entities: ResolvedEntity[],
): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  const add = (x: number, y: number, kind: SnapKind, priority: number) =>
    out.push({ p: new THREE.Vector2(x, y), kind, priority });

  for (const e of entities) {
    if (e.type === "line") {
      add(e.x1, e.y1, "endpoint", 100);
      add(e.x2, e.y2, "endpoint", 100);
      add((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, "midpoint", 80);
    } else if (e.type === "rectangle") {
      const hw = e.width / 2;
      const hh = e.height / 2;
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) add(e.x + sx * hw, e.y + sy * hh, "endpoint", 100);
      add(e.x, e.y, "center", 90);
      // edge midpoints
      add(e.x, e.y + hh, "midpoint", 80);
      add(e.x, e.y - hh, "midpoint", 80);
      add(e.x + hw, e.y, "midpoint", 80);
      add(e.x - hw, e.y, "midpoint", 80);
    } else if (e.type === "circle") {
      add(e.x, e.y, "center", 90);
    } else if (e.type === "arc") {
      add(e.x1, e.y1, "endpoint", 100);
      add(e.x2, e.y2, "endpoint", 100);
      add(e.mx, e.my, "midpoint", 80);
    } else if (e.type === "spline") {
      for (const p of e.points) add(p.x, p.y, "endpoint", 100); // fit points snap
    } else if (e.type === "point") {
      add(e.x, e.y, "endpoint", 110); // a placed point is a strong snap target
    } else if (e.type === "projected") {
      // projected reference curves snap like their native counterparts — that's
      // half the point of projecting. Poly interior vertices are SAMPLES, not
      // real model points, so they snap weakly (60).
      const cv = e.curve;
      if (cv.kind === "line") {
        add(cv.x1, cv.y1, "endpoint", 100);
        add(cv.x2, cv.y2, "endpoint", 100);
        add((cv.x1 + cv.x2) / 2, (cv.y1 + cv.y2) / 2, "midpoint", 80);
      } else if (cv.kind === "circle") {
        add(cv.x, cv.y, "center", 90);
      } else if (cv.kind === "arc") {
        add(cv.x1, cv.y1, "endpoint", 100);
        add(cv.x2, cv.y2, "endpoint", 100);
        add(cv.mx, cv.my, "midpoint", 80); // exact model point, same as native arcs
        const cc = circumcenter({ x: cv.x1, y: cv.y1 }, { x: cv.x2, y: cv.y2 }, { x: cv.mx, y: cv.my });
        if (cc) add(cc.x, cc.y, "center", 90);
      } else {
        const pts = cv.pts;
        pts.forEach(([x, y], i) => {
          const isEnd = i === 0 || i === pts.length - 1;
          add(x, y, "endpoint", isEnd ? 100 : 60);
        });
      }
    }
  }
  return out;
}

// `id` is the stable in-session identity constraints reference (see ./id.ts).
export type ResolvedEntity =
  | { type: "line"; id: string; x1: number; y1: number; x2: number; y2: number; construction?: boolean }
  | { type: "rectangle"; id: string; width: number; height: number; x: number; y: number; construction?: boolean }
  | { type: "circle"; id: string; radius: number; x: number; y: number; construction?: boolean }
  | { type: "arc"; id: string; x1: number; y1: number; x2: number; y2: number; mx: number; my: number; construction?: boolean }
  | { type: "spline"; id: string; points: { x: number; y: number }[]; construction?: boolean }
  | { type: "point"; id: string; x: number; y: number; construction?: boolean }
  // parametric shapes (rigid: the solver skips them; edited via their params)
  | { type: "polygon"; id: string; x: number; y: number; radius: number; sides: number; angle: number; construction?: boolean }
  | { type: "slot"; id: string; x1: number; y1: number; x2: number; y2: number; width: number; construction?: boolean }
  | { type: "text"; id: string; text: string; x: number; y: number; height: number;
      font?: string; style?: "regular" | "bold" | "italic" | "bolditalic";
      align?: "left" | "center" | "right"; angle: number;
      pathRef?: string; positionOnPath?: number; boxWidth?: number; construction?: boolean }
  // projected reference geometry (fixed/linked): the curve is already plain
  // numbers, so resolution is a structural pass-through
  | { type: "projected"; id: string; source: ProjectedSource; curve: ProjectedCurve; stale?: true; construction?: boolean };
