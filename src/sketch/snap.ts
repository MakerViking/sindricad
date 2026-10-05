// Snapping in 2D sketch space. Candidates (endpoints/midpoints/centers from
// existing geometry) are compared to the cursor in SCREEN PIXELS so the snap
// radius is zoom-independent, like mainstream MCAD. Grid snapping is the low-priority
// fallback.

import * as THREE from "three";
import type { DimPlace, ProjectedCurve, ProjectedSource, SketchConstraint } from "../types";
import { RECT_CENTRE, asRound, dimRefPoints, refPoint } from "./entityDims";
import { polygonPoints, rectCorners } from "./region";

export type SnapKind =
  | "free"
  | "grid"
  | "endpoint"
  | "midpoint"
  | "center"
  // where two curves a Tangent names touch (modify's tangencyPoints): on both
  // of them, and no solver point, so it snaps the coordinate only
  | "tangent"
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
 *  `idx` is the `p` that entityDims' `dimRefPoints` gives the point, and
 *  nothing else: that one list is what the dimension picker, the label renderer
 *  and sketchSolve's `endpointPoint` all agree on (line ends 0/1, arc ends 0/1
 *  and centre 2, a circle's or point's single point 0, rectangle corners 0..3 in
 *  `rectCorners` order and its centre 4, polygon corners 0..n-1 and its centre
 *  -1, a slot's centres 0/1, spline and projected-poly ends 0/1). A wrong index still
 *  SOLVES, it just joins the wrong point, so candidatesFromEntities looks every
 *  index up there instead of writing the convention out a second time.
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
  /** absent when the solver cannot address this point. A line's MIDPOINT, an
   *  arc's through-point and a rectangle side's middle are real snap targets
   *  but not points `dimRefPoints` lists, so they snap the coordinate and emit
   *  nothing. */
  ref?: PointRef;
}

export interface SnapResult {
  point: THREE.Vector2;
  kind: SnapKind;
  ref?: PointRef;
}

/** How far a drawn end may sit from the point it snapped to and still count as
 *  ON it. A snap copies the coordinate exactly; what is left is the float noise
 *  of rebuilding the end from a length and an angle (computeGeometry), around
 *  1e-13 mm. Anything the user could see is far above this, and so is the
 *  solver's own 0.001 mm merge bucket (sketchSolve's coincKey). */
export const JOIN_TOL = 1e-6;

/** The `coincident` constraints a freshly drawn entity owes to the snaps that
 *  PLACED it — `startRef`/`endRef` being whatever its first and second clicks
 *  landed on, or null where they landed on nothing. A chained line's start is
 *  the previous segment's end, so commitFromCursor hands that end in as its
 *  `startRef` whether or not anything was snapped there.
 *
 *  Emitted only for the solver points a click actually PUTS somewhere:
 *   - a LINE or ARC: its start (idx 0) and end (idx 1);
 *   - an ARC's centre (idx 2) too, from `centerRef`, which only the centre-point
 *     arc passes: its first click places the centre. (The end click of that
 *     tool only picks an angle, so its ref joins only where the end really
 *     landed on the point, like a typed length below.)
 *   - a RECTANGLE's corners. Corner to corner, both clicks are corners; drawn
 *     from the centre, only the second is, and the first, passed as
 *     `centerRef`, is its centre (point 4). WHICH corner a click is depends on
 *     the way the drag went, so it is the one of `dimRefPoints` that sits on
 *     the snapped point, never an assumed 0: the two corner orders in this
 *     codebase agree on corner 0 and nowhere else.
 *  A CIRCLE is not emitted for: its second click lands on the rim, which is no
 *  solver point. SPLINES are excluded for a duller reason — their ends carry
 *  refs (see candidatesFromEntities) but `finishSpline` commits them by a path
 *  that never reaches here. Revisit if a user reports a spline micro-gap.
 *
 *  Refuses the three ways a coincident can be nonsense, matching what the manual
 *  Coincident tool already refuses: the same entity on both sides (it would
 *  collapse the shape), a reference to an entity that no longer exists, and a
 *  duplicate of a constraint already present.
 *
 *  And refuses a ref the end did not actually land on. The refs are what the
 *  CURSOR snapped to, which is the entity's end only when nothing else placed
 *  it: a typed length or angle puts the end somewhere along the cursor's ray,
 *  and the hovered point's ref then names a point the line never reached. A
 *  coincident there makes the next solve drag the end onto it (a typed 10 mm
 *  line solved to 20 mm). So the join is emitted only where the end sits on
 *  the ref's point, within JOIN_TOL.
 *
 *  Pure, and separate from SketchMode, because constructing a real SketchMode
 *  boots the viewport and solver — which is how arcs came to have an emission
 *  branch that nothing could reach and no test could see. */
export function snapCoincidences(
  entity: ResolvedEntity,
  startRef: PointRef | null,
  endRef: PointRef | null,
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  centerRef: PointRef | null = null,
): SketchConstraint[] {
  const corners = [0, 1, 2, 3];
  /** each click's ref, and the solver points of `entity` that click can have placed */
  const placed: [PointRef | null, number[]][] =
    entity.type === "line" ? [[startRef, [0]], [endRef, [1]]]
    : entity.type === "arc" ? [[startRef, [0]], [endRef, [1]], [centerRef, [2]]]
    : entity.type === "rectangle" ? [[startRef, corners], [endRef, corners], [centerRef, [RECT_CENTRE]]]
    : [];
  const out: SketchConstraint[] = [];
  for (const [ref, candidates] of placed) {
    if (!ref) continue;
    if (ref.id === entity.id) continue; // cannot join a thing to itself
    const target = entities.find((e) => e.id === ref.id);
    if (!target) continue; // target is gone
    const there = refPoint(target, ref.idx);
    if (!there) continue;
    const idx = candidates.find((k) => {
      const here = refPoint(entity, k);
      return !!here && there.distanceTo(here) <= JOIN_TOL;
    });
    if (idx === undefined) continue; // the point landed elsewhere
    const joins = (c: SketchConstraint) =>
      c.type === "coincident"
      && ((c.e1 === ref.id && c.p1 === ref.idx && c.e2 === entity.id && c.p2 === idx)
        || (c.e2 === ref.id && c.p2 === ref.idx && c.e1 === entity.id && c.p1 === idx));
    if (constraints.some(joins)) continue;
    out.push({ type: "coincident", e1: ref.id, p1: ref.idx, e2: entity.id, p2: idx });
  }
  return out;
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

  for (const e of entities) {
    // A candidate's solver index is looked up, never written out here: it is
    // the `p` of whichever of the entity's dimRefPoints sits on it, and a
    // candidate none of them sits on (a midpoint) gets no ref. Hand-written indices covered lines, arcs, points and rectangle
    // corners and silently left circle centres and projected endpoints out,
    // though the solver resolves both.
    const refs = dimRefPoints(e);
    const add = (x: number, y: number, kind: SnapKind, priority: number) => {
      const r = refs.find((q) => Math.abs(q.pos.x - x) <= JOIN_TOL && Math.abs(q.pos.y - y) <= JOIN_TOL);
      out.push({ p: new THREE.Vector2(x, y), kind, priority, ...(r ? { ref: { id: e.id, idx: r.p } } : {}) });
    };
    if (e.type === "line") {
      add(e.x1, e.y1, "endpoint", 100);
      add(e.x2, e.y2, "endpoint", 100);
      add((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, "midpoint", 80);
    } else if (e.type === "rectangle") {
      const hw = e.width / 2;
      const hh = e.height / 2;
      // rectCorners, NOT a nested sx/sy loop. The loop this replaces walked
      // bl, tl, br, tr while the solver indexes corners bl, br, tr, tl. The
      // index now comes from dimRefPoints whatever order these are added in,
      // but one corner order in the file is still the one to keep.
      for (const c of rectCorners(e.x, e.y, e.width, e.height)) add(c.x, c.y, "endpoint", 100);
      add(e.x, e.y, "center", 90);
      // edge midpoints
      add(e.x, e.y + hh, "midpoint", 80);
      add(e.x, e.y - hh, "midpoint", 80);
      add(e.x + hw, e.y, "midpoint", 80);
      add(e.x - hw, e.y, "midpoint", 80);
    } else if (e.type === "circle") {
      add(e.x, e.y, "center", 90);
    } else if (e.type === "polygon") {
      // A polygon's centre and corners, and a slot's two arc centres, are where
      // a Rotate or Move wants its pivot, and none of them was offered: rotating
      // a polygon in place meant guessing its centre (reports a237de6b,
      // ffae1a6e). They are solver points too now (dimRefPoints), so a line
      // drawn from one records the join, as from a rectangle's corner.
      add(e.x, e.y, "center", 90);
      for (const v of polygonPoints(e.x, e.y, e.radius, e.sides, (e.angle * Math.PI) / 180)) {
        add(v.x, v.y, "endpoint", 100);
      }
    } else if (e.type === "slot") {
      add(e.x1, e.y1, "center", 90);
      add(e.x2, e.y2, "center", 90);
    } else if (e.type === "arc") {
      add(e.x1, e.y1, "endpoint", 100);
      add(e.x2, e.y2, "endpoint", 100);
      add(e.mx, e.my, "midpoint", 80); // the through-point is not a solver point
    } else if (e.type === "spline") {
      // Only the ENDS get a ref: endpointPoint maps idx 0 to the first fit
      // point and anything else to the LAST, so an interior fit point has no
      // index of its own. Interior points still snap, silently.
      // NOTE: nothing consumes spline refs yet. finishSpline commits by a path
      // that never reaches snapCoincidences.
      for (const p of e.points) add(p.x, p.y, "endpoint", 100);
    } else if (e.type === "point") {
      add(e.x, e.y, "endpoint", 110); // a placed point is a strong snap target
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
