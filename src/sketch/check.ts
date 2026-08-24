// Sketch geometry checker. Today the only feedback a broken profile gives is an
// extrude that silently finds no closed region, so every check below is a NAMED
// reason detectRegions came back empty (or came back with more cells than the
// user drew).
//
// All of the geometry is region.ts's own: `entityPolyline` is the one place an
// entity becomes points (region.ts:49-52), `segCross`/`pointOnSegInterior` are
// the primitives its arrangement pass already trusts, and the node key below is
// literally the tracer's. That is the point of the file — a checker that
// measured with its own maths would eventually contradict the shading the user
// is looking at, and then the report is a second opinion rather than a reason.

import type * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import {
  EPS,
  boxesOverlap,
  entityPolyline,
  entitySegments,
  pointOnSegInterior,
  segCross,
  segsBBox,
} from "./region";
import { paramOnSeg } from "./geom2d";

export type SketchIssueKind = "open" | "overlap" | "tiny" | "selfCross" | "cross" | "more";

export interface SketchIssue {
  kind: SketchIssueKind;
  severity: "error" | "info";
  /** One sentence, user-facing, and deliberately UNIT-FREE: the panel renders
   *  `measuredMm` through the user's display unit (checkPanel.formatMeasurement),
   *  so a number baked into the prose would be a second, contradicting copy of
   *  it — "0.4 mm apart" beside a chip reading "0.016 in". Say what is wrong
   *  here; `measuredMm` is the only place a length is stated. */
  message: string;
  entityIds: string[];          // what to select when the row is clicked
  at: { x: number; y: number }; // sketch-plane mm, where to point
  measuredMm?: number;          // the gap/overlap/length that was measured
}

/** Two free ends closer than this LOOK joined at any sane zoom, which is the
 *  reported symptom: the drawing appears closed and the extrude disagrees.
 *  Further apart than this and an open chain is a legitimate thing to draw, so
 *  it is reported as information rather than as a defect. */
const OPEN_GAP_MM = 1.0;

/** Ten times the tracer's own node-merge grid (EPS, region.ts:37). What drops an
 *  edge outright is not its LENGTH but its ROUNDING: region.ts:676-677 keys both
 *  ends onto the EPS grid and skips the edge when the two keys match. A 5e-5 mm
 *  segment that straddles a cell boundary therefore survives as an edge, while
 *  one sitting inside a single cell collapses — so anything under the grid is
 *  unpredictable rather than reliably dropped, and the decade above it is still
 *  not geometry anyone drew on purpose. */
const TINY_MM = 1e-3;

/** No panel can render twenty thousand rows, and 200 mutually overlapping
 *  circles produce exactly that. Past this many the list is truncated and one
 *  "more" row says how many were left off. */
const MAX_ISSUES = 200;

/** Rows are already ordered errors-first then by kind, so a panel can render
 *  the array as it stands. "more" is last because it is the truncation notice,
 *  not a finding. */
const KIND_ORDER: SketchIssueKind[] = ["open", "overlap", "tiny", "selfCross", "cross", "more"];

type Seg2 = { x1: number; y1: number; x2: number; y2: number };
type Box2 = { minx: number; miny: number; maxx: number; maxy: number };
type Checked = {
  e: ResolvedEntity;
  pts: THREE.Vector2[];
  segs: Seg2[];
  box: ReturnType<typeof segsBBox>;
};

/** already grown by EPS on every side, so a reject is a strict miss even for
 *  two segments that touch */
const segBox = (s: Seg2): Box2 => ({
  minx: Math.min(s.x1, s.x2) - EPS, miny: Math.min(s.y1, s.y2) - EPS,
  maxx: Math.max(s.x1, s.x2) + EPS, maxy: Math.max(s.y1, s.y2) + EPS,
});
const box2Overlap = (a: Box2, b: Box2) =>
  a.minx <= b.maxx && b.minx <= a.maxx && a.miny <= b.maxy && b.miny <= a.maxy;

/** Report every reason this sketch will not shade or extrude the way it looks.
 *  Pure: no document, no store, no selection. */
export function checkSketch(entities: ResolvedEntity[]): SketchIssue[] {
  // The same filter detectRegions applies (region.ts:165): construction
  // geometry is reference-only and text is its own filled overlay, so neither
  // can be the reason a profile failed to close.
  const per: Checked[] = [];
  for (const e of entities) {
    if (e.construction || e.type === "text") continue;
    const segs = entitySegments(e).map(([a, b]) => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
    if (!segs.length) continue; // a point has no extent, and neither has an empty curve
    per.push({ e, pts: entityPolyline(e), segs, box: segsBBox(segs) });
  }

  // tiny runs FIRST because it silences "open" for the same entity. A segment
  // under the node grid is ONE defect, but its two ends may still round into
  // different grid cells, in which case it is also a dangling pair a millimetre
  // apart — so the same 5e-5 mm line used to be reported twice, as [open, tiny],
  // with two different accounts of what to do about it.
  const tiny = tinySegments(per);
  const tinyIds = new Set(tiny.flatMap((i) => i.entityIds));

  const issues = [
    ...openEnds(per, tinyIds),
    ...tiny,
    ...selfCrossings(per),
    ...pairIssues(per),
  ];

  // Array#sort is stable, so within one severity and kind the rows keep the
  // order the checks found them in, which is the order the entities appear in
  // the sketch.
  issues.sort(
    (p, q) =>
      severityRank(p) - severityRank(q) ||
      KIND_ORDER.indexOf(p.kind) - KIND_ORDER.indexOf(q.kind),
  );

  // Cap AFTER the sort, so what survives is the most serious end of the list
  // rather than whichever check happened to run first.
  if (issues.length <= MAX_ISSUES) return issues;
  const head = issues.slice(0, MAX_ISSUES);
  head.push({
    kind: "more", severity: "info",
    message: `${issues.length - MAX_ISSUES} further findings are not listed. Fix these first, then run the check again.`,
    entityIds: [],
    at: head[0]?.at ?? { x: 0, y: 0 },
  });
  return head;
}

const severityRank = (i: SketchIssue) => (i.severity === "error" ? 0 : 1);

/** The tracer's node key, character for character (region.ts:655-656). Building
 *  the SAME key is what makes an "open" row honest: a free end here is the same
 *  free end that made the half-edge walk fail to close at region.ts:714. */
const nodeKey = (x: number, y: number) => `${Math.round(x / EPS)},${Math.round(y / EPS)}`;

// --- open ends ---

/** `onOther`: this end sits on another curve's INTERIOR (a T-junction). Not a
 *  gap on its own, but it stops being an excuse the moment another loose end
 *  turns up within reach — see openEnds. */
type FreeEnd = { p: THREE.Vector2; eid: string; onOther: boolean };

/** Is this endpoint picked up by some OTHER entity, so the tracer has a junction
 *  there rather than a loose end?
 *
 *  Two ways, and they are region.ts's own two, in the order it asks them
 *  (region.ts:599-602 / 630-631):
 *    (a) another entity has a polyline VERTEX on the same node key — including
 *        a CLOSED one. A line landing on a rectangle's corner or on a circle's
 *        sampled vertex joins there just as surely as it joins another line's
 *        endpoint, and the half-edge walk sees one node either way.
 *    (b) it lies on the INTERIOR of another entity's segment — the T-junction,
 *        which is how most real sketches join. `planarize` splits that segment
 *        at exactly this point, so the profile closes perfectly.
 *  Reporting either of these as a free end was the checker's worst false
 *  positive: two of them within OPEN_GAP_MM read as an ERROR on a sketch that
 *  shades and extrudes correctly.
 *
 *  Entity-bbox broad phase for (b), the same one anyCrossing uses
 *  (region.ts:589-595), so a plate with a grid of holes never reaches the
 *  segment loop. */
/** Is this endpoint met by another curve, so that it is not a loose end?
 *
 *  THE TWO CLAUSES ARE NOT EQUALLY SAFE and `trustJunctions` is what separates
 *  them.
 *
 *  (a) Another entity has a VERTEX on the same tracer node key. That is a real
 *      join by construction: region.ts merges both onto one node whatever else
 *      is in the sketch, so it is trusted unconditionally. Three exactly
 *      coincident corners of a rectangle drawn as four lines are this case, and
 *      calling them defects would flag the most ordinary sketch there is.
 *
 *  (b) The endpoint lies on another entity's segment INTERIOR: a T-junction.
 *      There is a node there only once the tracer planarizes, and — the part
 *      that matters — a junction is not a closure. Running onto a dead-end bar
 *      puts a node under your endpoint and still goes nowhere. Measured: a
 *      rectangle 0.4 mm short at one corner reports `error/open/0.4`, and laying
 *      an unrelated bar across that corner turned it into three `info/open`
 *      rows with no measurement, because clause (b) excused the short end. So
 *      (b) is only believed when the tracer got at least one closed region out
 *      of this sketch; when nothing closed, nothing here is evidence of closure. */
function endIsJoined(
  p: THREE.Vector2,
  eid: string,
  vertexOwners: Map<string, Set<string>>,
  per: Checked[],
  trustJunctions: boolean,
): boolean {
  for (const owner of vertexOwners.get(nodeKey(p.x, p.y)) ?? [])
    if (owner !== eid) return true;
  if (!trustJunctions) return false;
  for (const { e, segs, box } of per) {
    if (e.id === eid) continue;
    if (p.x < box.minx - EPS || p.x > box.maxx + EPS) continue;
    if (p.y < box.miny - EPS || p.y > box.maxy + EPS) continue;
    for (const s of segs) if (pointOnSegInterior(p.x, p.y, s) !== null) return true;
  }
  return false;
}

function openEnds(per: Checked[], tinyIds: Set<string>): SketchIssue[] {
  // Every polyline vertex of every entity, closed ones included — see
  // endIsJoined(a). Keyed on the tracer's grid, so "same node" here means the
  // same node there.
  const vertexOwners = new Map<string, Set<string>>();
  for (const { e, pts } of per)
    for (const p of pts) {
      const k = nodeKey(p.x, p.y);
      const owners = vertexOwners.get(k);
      if (owners) owners.add(e.id);
      else vertexOwners.set(k, new Set([e.id]));
    }

  const free: FreeEnd[] = [];
  for (const { e, pts } of per) {
    // An entity already reported as "tiny" gets no open row: same defect, and
    // whether its ends land in one grid cell or two is rounding, not a second
    // problem for the user to act on.
    if (tinyIds.has(e.id)) continue;
    const first = pts[0], last = pts[pts.length - 1];
    if (!first || !last) continue;
    // A curve whose polyline closes on itself has no free end to report:
    // rectangle/circle/polygon/slot repeat their first vertex, and so does a
    // spline or projected poly the user closed. Skipping them mirrors the fast
    // path at region.ts:246-250, which feeds only open curves to the tracer.
    if (nodeKey(first.x, first.y) === nodeKey(last.x, last.y)) continue;
    for (const p of [first, last])
      // Clause (a) is absolute and settles the end here. Clause (b) only
      // MARKS it, because whether a T-junction excuses the end depends on
      // something not known until every end is in: see below.
      if (!endIsJoined(p, e.id, vertexOwners, per, false))
        free.push({ p, eid: e.id, onOther: endIsJoined(p, e.id, vertexOwners, per, true) });
  }
  const nearest = nearestFreeEnds(free);

  const out: SketchIssue[] = [];
  free.forEach((n, i) => {
    const near = nearest[i];
    // A T-junction end is not a gap, so it is normally not reported at all.
    // The one exception is a near miss against a GENUINELY loose end: a
    // rectangle 0.4 mm short at one corner is still 0.4 mm short when an
    // unrelated bar happens to lie across that corner, and excusing it there
    // cost the real defect both its severity and its measurement (measured:
    // `error/open/0.4` became three `info/open` rows carrying no number).
    //
    // The partner has to be loose for that to mean anything. Two dividers
    // landing on a plate half a millimetre apart are both junctions, both
    // properly joined, and the tracer closes the sketch — so a pair of
    // junctions excuses itself, and only a junction facing a loose end does not.
    if (n.onOther && (near === undefined || free[near.idx]?.onOther)) return;
    const other = near === undefined ? undefined : free[near.idx];
    if (near === undefined || other === undefined) {
      out.push({
        kind: "open", severity: "info",
        message: "This endpoint joins nothing, so the chain stays open.",
        entityIds: [n.eid], at: { x: n.p.x, y: n.p.y },
      });
      return;
    }
    // A mutual nearest pair is ONE defect seen from both ends (the corner of a
    // rectangle drawn short), so the lower index speaks for both and the panel
    // gets a single row pointing at the gap itself. Where the relation is not
    // mutual, because three ends are clustered, each end still gets its own row
    // rather than being folded silently into someone else's.
    const mutual = nearest[near.idx]?.idx === i;
    if (mutual && near.idx < i) return;
    out.push({
      kind: "open", severity: "error",
      message: mutual
        ? "These two endpoints stop short of each other, so the profile never closes."
        : "This endpoint stops short of the nearest one, so the profile never closes.",
      entityIds: mutual ? [...new Set([n.eid, other.eid])] : [n.eid],
      at: mutual
        ? { x: (n.p.x + other.p.x) / 2, y: (n.p.y + other.p.y) / 2 }
        : { x: n.p.x, y: n.p.y },
      measuredMm: near.dist,
    });
  });
  return out;
}

/** For each free end, the nearest OTHER free end within OPEN_GAP_MM, or
 *  undefined. Bucketed at exactly OPEN_GAP_MM so the 3x3 neighbourhood provably
 *  holds every candidate: two ends that close cannot differ by more than one
 *  cell on either axis. Nothing further than OPEN_GAP_MM is reported, which is
 *  why an "info" row carries no number: the nearest end beyond the search
 *  radius was never looked for, so quoting a distance there would be a guess. */
function nearestFreeEnds(free: FreeEnd[]): ({ idx: number; dist: number } | undefined)[] {
  const grid = new Map<string, number[]>();
  const cellOf = (p: THREE.Vector2) =>
    `${Math.floor(p.x / OPEN_GAP_MM)},${Math.floor(p.y / OPEN_GAP_MM)}`;
  free.forEach((n, i) => {
    const c = cellOf(n.p);
    const bucket = grid.get(c);
    if (bucket) bucket.push(i);
    else grid.set(c, [i]);
  });
  return free.map((n, i) => {
    const cx = Math.floor(n.p.x / OPEN_GAP_MM), cy = Math.floor(n.p.y / OPEN_GAP_MM);
    let idx = -1, dist = OPEN_GAP_MM;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const o = free[j];
          if (j === i || !o) continue;
          const d = n.p.distanceTo(o.p);
          if (d <= dist) { dist = d; idx = j; }
        }
    return idx < 0 ? undefined : { idx, dist };
  });
}

// --- tiny segments ---

function tinySegments(per: Checked[]): SketchIssue[] {
  const out: SketchIssue[] = [];
  for (const { e, segs } of per) {
    // One row per entity, reporting its shortest segment. A curve that is too
    // small is too small along its WHOLE length, and 64 rows for one 0.02 mm
    // circle would bury everything else in the report.
    let worst: Seg2 | undefined;
    let worstLen = TINY_MM;
    for (const s of segs) {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len < worstLen) { worstLen = len; worst = s; }
    }
    if (!worst) continue;
    out.push({
      kind: "tiny", severity: "error",
      message: "This segment is short enough that it may be dropped when the profile is traced.",
      entityIds: [e.id],
      at: { x: (worst.x1 + worst.x2) / 2, y: (worst.y1 + worst.y2) / 2 },
      measuredMm: worstLen,
    });
  }
  return out;
}

// --- self crossings ---

/** Curves whose vertices the user placed one by one. A circle, arc, rectangle,
 *  polygon or slot outline comes from a formula in region.ts and cannot cross
 *  itself, and proving that for a 64-vertex circle costs 2016 segment pairs. */
const userVertexed = (e: ResolvedEntity) =>
  e.type === "spline" || (e.type === "projected" && e.curve.kind === "poly");

/** Every index pair of `segs` whose bounding boxes could possibly touch, once
 *  each, via a uniform grid.
 *
 *  Cell size is the LONGEST segment's bbox extent, which is what makes the grid
 *  correct AND cheap: no segment's box can then span more than a 2x2 block of
 *  cells, and two boxes that overlap must contain a common point, whose cell
 *  both of them registered in. Missing a pair is therefore impossible.
 *
 *  Without this, one 1000-fit-point spline was 499,500 segment-pair tests
 *  (measured 554 ms, on its own, freezing the UI while the panel opened).
 *  Curves are locally connected, so nearly all of those pairs are nowhere near
 *  each other. */
function forEachNearbyPair(segs: Seg2[], visit: (i: number, j: number) => void): void {
  const n = segs.length;
  if (n < 2) return;
  let cell = 0;
  for (const s of segs)
    cell = Math.max(cell, Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  if (!(cell > 0)) return; // every segment is a point: nothing can cross

  const grid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const cx0 = Math.floor(Math.min(s.x1, s.x2) / cell), cx1 = Math.floor(Math.max(s.x1, s.x2) / cell);
    const cy0 = Math.floor(Math.min(s.y1, s.y2) / cell), cy1 = Math.floor(Math.max(s.y1, s.y2) / cell);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = `${cx},${cy}`;
        const bucket = grid.get(k);
        if (bucket) bucket.push(i);
        else grid.set(k, [i]);
      }
  });

  // A pair sharing more than one cell would otherwise be visited more than once.
  const seen = new Set<number>();
  for (const bucket of grid.values())
    for (let a = 0; a < bucket.length; a++)
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a]!, j = bucket[b]!;
        const lo = Math.min(i, j), hi = Math.max(i, j);
        const id = lo * n + hi;
        if (seen.has(id)) continue;
        seen.add(id);
        visit(lo, hi);
      }
}

function selfCrossings(per: Checked[]): SketchIssue[] {
  const out: SketchIssue[] = [];
  for (const { e, segs } of per) {
    if (!userVertexed(e)) continue;
    forEachNearbyPair(segs, (i, j) => {
      const a = segs[i], b = segs[j];
      if (!a || !b) return;
      // segCross is strict-interior, so the shared endpoint every consecutive
      // pair has is not a hit. geom2d's segIntersect would report all of them.
      const p = segCross(a, b);
      if (!p) return;
      out.push({
        kind: "selfCross", severity: "error",
        message: "This curve crosses itself here, so it does not bound a single area.",
        entityIds: [e.id], at: { x: p.x, y: p.y },
      });
    });
  }
  return out;
}

// --- overlaps and crossings between two entities ---

function pairIssues(per: Checked[]): SketchIssue[] {
  const out: SketchIssue[] = [];
  // Nothing to pair, and a 1,000-point spline on its own should not pay for
  // 16,000 bounding boxes it will never be asked about.
  if (per.length < 2) return out;
  const segBoxes = per.map((p) => p.segs.map(segBox));
  for (let i = 0; i < per.length; i++) {
    const A = per[i];
    if (!A) continue;
    for (let j = i + 1; j < per.length; j++) {
      const B = per[j];
      // Entity-bbox broad phase, the same one anyCrossing uses (region.ts:589).
      // A plate with a grid of holes never reaches the segment loops below,
      // because no two holes' boxes touch.
      if (!B || !boxesOverlap(A.box, B.box)) continue;

      const start = A.pts[0];
      if (samePolyline(A.pts, B.pts) && start) {
        // Every segment pair of a duplicate is a collinear overlap too, so the
        // measured loop below would emit one row per segment. Say it once.
        out.push({
          kind: "overlap", severity: "error",
          message: "This curve is an exact duplicate of another one drawn on top of it.",
          entityIds: [A.e.id, B.e.id], at: { x: start.x, y: start.y },
        });
        continue;
      }

      let worstLen = EPS;
      let overlapAt: { x: number; y: number } | undefined;
      let crossAt: { x: number; y: number } | undefined;
      // SEGMENT-bbox reject before the real tests. The entity-bbox phase above
      // only says the two curves are in the same neighbourhood; two circles that
      // merely overlap still put 4,096 segment pairs through segCross AND
      // collinearOverlap, and 200 of them measured 3.3 s — long enough that the
      // panel opens on a frozen window. Neither test can fire across separated
      // boxes, so this is a pure filter, not an approximation.
      const aBoxes = segBoxes[i]!, bBoxes = segBoxes[j]!;
      for (let ai = 0; ai < A.segs.length; ai++) {
        const a = A.segs[ai]!, abox = aBoxes[ai]!;
        for (let bi = 0; bi < B.segs.length; bi++) {
          if (!box2Overlap(abox, bBoxes[bi]!)) continue;
          const b = B.segs[bi]!;
          if (!crossAt) {
            const p = segCross(a, b);
            if (p) crossAt = { x: p.x, y: p.y };
          }
          const ov = collinearOverlap(a, b);
          if (ov && ov.len > worstLen) { worstLen = ov.len; overlapAt = ov.at; }
        }
      }

      // A partially shared run between two DIFFERENT entities is not a defect
      // and must never be an error. traceLoops keeps one undirected edge per
      // coincident segment on purpose (region.ts:668-679: "a shared boundary
      // genuinely belongs to both"), so a rib sitting on part of a plate's edge
      // — the most ordinary sketch in CAD — traces into exactly the two regions
      // the user drew. Flagging it was this checker's second false positive.
      // Kept as INFORMATION because the same geometry is also what a curve
      // accidentally drawn twice at a slight offset looks like, and the wording
      // says what the tracer will actually do with it.
      if (overlapAt)
        out.push({
          kind: "overlap", severity: "info",
          message: "These two curves run along each other here. The tracer keeps a single shared edge, so the areas on either side of it still close.",
          entityIds: [A.e.id, B.e.id], at: overlapAt, measuredMm: worstLen,
        });
      // One row per PAIR, not per crossing point: two overlapping circles cross
      // twice and that is a single fact about the pair. `at` is the first
      // crossing found, which is enough to steer the view to it.
      if (crossAt)
        out.push({
          kind: "cross", severity: "info",
          message: "These two curves cross here, so any area they bound is split into separate regions.",
          entityIds: [A.e.id, B.e.id], at: crossAt,
        });
    }
  }
  return out;
}

/** Two curves drawn on top of each other, vertex for vertex. Both directions,
 *  because a line drawn the other way round is the same line. */
function samePolyline(a: THREE.Vector2[], b: THREE.Vector2[]): boolean {
  if (!a.length || a.length !== b.length) return false;
  const same = (p: THREE.Vector2 | undefined, q: THREE.Vector2 | undefined) =>
    !!p && !!q && Math.abs(p.x - q.x) <= EPS && Math.abs(p.y - q.y) <= EPS;
  return (
    a.every((p, i) => same(p, b[i])) ||
    a.every((p, i) => same(p, b[a.length - 1 - i]))
  );
}

/** How far two segments run along each other, or null if they only touch at a
 *  point, cross, or miss.
 *
 *  Collinearity is decided by `pointOnSegInterior` alone, which is already a
 *  within-EPS on-the-curve test: it takes TWO endpoint-inside-the-other hits to
 *  be an overlap, where the T-junction it was written for gives exactly one and
 *  an X crossing gives none. Extent is then read off in a's parameter space
 *  with `paramOnSeg`. No new intersection maths, deliberately. */
function collinearOverlap(a: Seg2, b: Seg2): { len: number; at: { x: number; y: number } } | null {
  let hits = 0;
  if (pointOnSegInterior(b.x1, b.y1, a) !== null) hits++;
  if (pointOnSegInterior(b.x2, b.y2, a) !== null) hits++;
  if (pointOnSegInterior(a.x1, a.y1, b) !== null) hits++;
  if (pointOnSegInterior(a.x2, a.y2, b) !== null) hits++;
  if (hits < 2) return null;

  const p1 = { x: a.x1, y: a.y1 }, p2 = { x: a.x2, y: a.y2 };
  const t1 = paramOnSeg(p1, p2, { x: b.x1, y: b.y1 });
  const t2 = paramOnSeg(p1, p2, { x: b.x2, y: b.y2 });
  const lo = Math.max(0, Math.min(t1, t2));
  const hi = Math.min(1, Math.max(t1, t2));
  // "more than a point": collinear segments laid end to end share exactly one,
  // and a polyline is full of those.
  const len = (hi - lo) * Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
  if (hi <= lo || len <= EPS) return null;

  const mid = (lo + hi) / 2;
  return { len, at: { x: a.x1 + (a.x2 - a.x1) * mid, y: a.y1 + (a.y2 - a.y1) * mid } };
}
