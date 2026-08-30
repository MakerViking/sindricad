// Snapping in 2D sketch space. Candidates (endpoints/midpoints/centers from
// existing geometry) are compared to the cursor in SCREEN PIXELS so the snap
// radius is zoom-independent, like mainstream MCAD. Grid snapping is the low-priority
// fallback.

import * as THREE from "three";
import type { DimPlace, ProjectedCurve, ProjectedSource } from "../types";
import { asRound } from "./entityDims";
import { rectCorners } from "./region";

export type SnapKind =
  | "free"
  | "grid"
  | "endpoint"
  | "midpoint"
  | "center"
  | "on-x"
  | "on-y";

/** WHICH solver point a snap candidate IS, when the solver can address it.
 *
 *  Snapping has always copied the coordinate and stopped there, so two points
 *  that coincided the moment you drew them could be driven apart by any later
 *  solve — the deeper half of field report ecc3e0d6 ("the lines should
 *  automatically be constrained"). Carrying the identity is what lets the commit
 *  emit a real `coincident` constraint instead.
 *
 *  `idx` follows sketchSolve's `endpointPoint` EXACTLY, because that is what
 *  resolves a coincident constraint's operands:
 *    line     0 = (x1,y1), 1 = (x2,y2)
 *    arc      0 = start, anything else = end
 *    spline   0 = first fit point, anything else = last
 *    point    the point itself, index ignored
 *    rectangle 0..3 in `rectCorners` CCW order (bl, br, tr, tl)
 *
 *  Use the entity's OWN id with a corner index, NEVER the `R~k` edge spelling:
 *  `endpointPoint` consults `rectMap` first, `dimPoint` agrees, and every
 *  dimension and `fix` already record it that way. `R~k` also solves and prunes
 *  identically, but nothing emits it deliberately and it historically rendered
 *  no glyph. */
export interface PointRef {
  id: string;
  idx: number;
}

export interface SnapCandidate {
  p: THREE.Vector2;
  kind: SnapKind;
  priority: number; // higher wins
  /** absent when the solver cannot address this point — a line's MIDPOINT and a
   *  circle's CENTRE are real snap targets but not solver points that
   *  `endpointPoint` can resolve, so they snap the coordinate and emit nothing. */
  ref?: PointRef;
}

export interface SnapResult {
  point: THREE.Vector2;
  kind: SnapKind;
  ref?: PointRef;
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

  if (best) return { point: best.p.clone(), kind: best.kind, ...(best.ref ? { ref: best.ref } : {}) };

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
  const add = (x: number, y: number, kind: SnapKind, priority: number, ref?: PointRef) =>
    out.push({ p: new THREE.Vector2(x, y), kind, priority, ...(ref ? { ref } : {}) });

  for (const e of entities) {
    if (e.type === "line") {
      add(e.x1, e.y1, "endpoint", 100, { id: e.id, idx: 0 });
      add(e.x2, e.y2, "endpoint", 100, { id: e.id, idx: 1 });
      add((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, "midpoint", 80);
    } else if (e.type === "rectangle") {
      const hw = e.width / 2;
      const hh = e.height / 2;
      // rectCorners, NOT a nested sx/sy loop. The loop this replaces walked
      // bl, tl, br, tr while the solver indexes corners bl, br, tr, tl — so an
      // index taken from it would name the WRONG corner, silently, and the
      // constraint would drag the rectangle inside out. One source of truth.
      rectCorners(e.x, e.y, e.width, e.height).forEach((c, i) =>
        add(c.x, c.y, "endpoint", 100, { id: e.id, idx: i }),
      );
      add(e.x, e.y, "center", 90);
      // edge midpoints
      add(e.x, e.y + hh, "midpoint", 80);
      add(e.x, e.y - hh, "midpoint", 80);
      add(e.x + hw, e.y, "midpoint", 80);
      add(e.x - hw, e.y, "midpoint", 80);
    } else if (e.type === "circle") {
      add(e.x, e.y, "center", 90);
    } else if (e.type === "arc") {
      add(e.x1, e.y1, "endpoint", 100, { id: e.id, idx: 0 });
      add(e.x2, e.y2, "endpoint", 100, { id: e.id, idx: 1 });
      add(e.mx, e.my, "midpoint", 80); // the through-point is not a solver point
    } else if (e.type === "spline") {
      // Only the ENDS are addressable: endpointPoint maps idx 0 to the first fit
      // point and anything else to the LAST, so an interior fit point would
      // resolve to the wrong end. Interior points still snap, silently.
      const last = e.points.length - 1;
      e.points.forEach((p, i) =>
        add(p.x, p.y, "endpoint", 100, i === 0 || i === last ? { id: e.id, idx: i === 0 ? 0 : 1 } : undefined),
      );
    } else if (e.type === "point") {
      add(e.x, e.y, "endpoint", 110, { id: e.id, idx: 0 }); // a placed point is a strong snap target
    } else if (e.type === "projected") {
      // projected reference curves snap like their native counterparts — that's
      // half the point of projecting. Centers come from asRound (the one
      // circumcenter-for-projected-arc rule). Poly interior vertices are
      // SAMPLES, not real model points, so they snap weakly (60).
      const round = asRound(e);
      if (round) add(round.x, round.y, "center", 90);
      const cv = e.curve;
      if (cv.kind === "line") {
        add(cv.x1, cv.y1, "endpoint", 100);
        add(cv.x2, cv.y2, "endpoint", 100);
        add((cv.x1 + cv.x2) / 2, (cv.y1 + cv.y2) / 2, "midpoint", 80);
      } else if (cv.kind === "arc") {
        add(cv.x1, cv.y1, "endpoint", 100);
        add(cv.x2, cv.y2, "endpoint", 100);
        add(cv.mx, cv.my, "midpoint", 80); // exact model point, same as native arcs
      } else if (cv.kind === "poly") {
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
// `dimPlace` mirrors SketchEntity's badge-label placement (see types.ts) — it's
// plain numbers already, so it survives resolution as a structural copy.
export type ResolvedEntity =
  | { type: "line"; id: string; x1: number; y1: number; x2: number; y2: number; construction?: boolean; dimPlace?: DimPlace }
  | { type: "rectangle"; id: string; width: number; height: number; x: number; y: number; construction?: boolean; dimPlace?: DimPlace }
  | { type: "circle"; id: string; radius: number; x: number; y: number; construction?: boolean; dimPlace?: DimPlace }
  | { type: "arc"; id: string; x1: number; y1: number; x2: number; y2: number; mx: number; my: number; construction?: boolean }
  | { type: "spline"; id: string; points: { x: number; y: number }[]; construction?: boolean }
  | { type: "point"; id: string; x: number; y: number; construction?: boolean }
  // parametric shapes (rigid: the solver skips them; edited via their params)
  | { type: "polygon"; id: string; x: number; y: number; radius: number; sides: number; angle: number; construction?: boolean; dimPlace?: DimPlace }
  | { type: "slot"; id: string; x1: number; y1: number; x2: number; y2: number; width: number; construction?: boolean; dimPlace?: DimPlace }
  | { type: "text"; id: string; text: string; x: number; y: number; height: number;
      font?: string; style?: "regular" | "bold" | "italic" | "bolditalic";
      align?: "left" | "center" | "right"; angle: number;
      pathRef?: string; positionOnPath?: number; boxWidth?: number; construction?: boolean }
  // projected reference geometry (fixed/linked): the curve is already plain
  // numbers, so resolution is a structural pass-through
  | { type: "projected"; id: string; source: ProjectedSource; curve: ProjectedCurve; stale?: true; construction?: boolean };
