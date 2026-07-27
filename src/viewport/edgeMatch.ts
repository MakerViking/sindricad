// Pure geometry helpers for matching saved edge selectors (world-space
// midpoints) back to rendered edge polylines. Edge ids are NOT stable across
// rebuilds (the client assigns e0,e1,... per assembly), so geometry is the only
// rebuild-stable edge identity — the same convention selectors already use.
// Kept DOM/three-free so vitest covers it headlessly.

export type Vec3 = [number, number, number];

/** The point an edge selector is built from: the polyline's ARC-LENGTH midpoint.
 *
 *  This used to be the index-middle sample, `points[floor(len/2)]` — which is
 *  the true middle only when the polyline has an odd number of samples. A
 *  STRAIGHT edge is sampled as just its two endpoints (tessellate._line_endpoints),
 *  so `floor(2/2)` returned the END POINT, and the sidecar's nearest-edge
 *  resolution then measured from a CORNER: on a 20×20×35 box, clicking a 35mm
 *  vertical edge stored its top corner and resolved to a 20mm TOP edge, whose
 *  centre is nearer. Picking one edge and filleting another was the visible
 *  symptom.
 *
 *  Every site that builds or matches a selector must use this one function, or
 *  saved selectors won't re-match their own edge. */
export function polylineMid(points: Vec3[]): Vec3 | undefined {
  const first = points[0];
  if (!first) return undefined;
  if (points.length === 1) return first;
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.sqrt(d2(points[i - 1]!, points[i]!));
    seg.push(d);
    total += d;
  }
  if (total <= 0) return first; // degenerate (all samples coincident)
  let want = total / 2;
  for (let i = 0; i < seg.length; i++) {
    const s = seg[i]!;
    if (want <= s || i === seg.length - 1) {
      const t = s > 0 ? want / s : 0;
      const a = points[i]!, b = points[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    want -= s;
  }
  return points[points.length - 1];
}

/** The pre-fix convention, kept ONLY so documents saved before it still re-match
 *  their edges when a fillet/chamfer is reopened for editing. Selector points
 *  live in the .sindri file, so old files carry old-convention points forever;
 *  matching against both is what stops an existing fillet losing its ghosts.
 *  Never build a NEW selector from this. */
function legacyPolylineMid(points: Vec3[]): Vec3 | undefined {
  return points[Math.floor(points.length / 2)];
}

const d2 = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

/** Index of the edge whose polyline midpoint is nearest to `mid`, or null when
 *  none lands within `tol` (world units). Ties resolve to the first nearest.
 *  Accepts BOTH midpoint conventions so a fillet saved before the arc-length
 *  fix still finds its edges on reopen (see legacyPolylineMid). */
export function nearestEdgeByMid(
  edges: { points: Vec3[] }[],
  mid: Vec3,
  tol: number,
): number | null {
  let best = -1;
  let bestD = tol * tol;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e) continue;
    for (const m of [polylineMid(e.points), legacyPolylineMid(e.points)]) {
      if (!m) continue;
      const dd = d2(m, mid);
      if (dd < bestD) { bestD = dd; best = i; }
    }
  }
  return best >= 0 ? best : null;
}

/** Toggle membership of a nearest-point edge selector in a selector list:
 *  a selector whose point lies within `tol` of `mid` is removed; otherwise a
 *  fresh `{kind:"edge", by:"nearest", point: mid}` is appended. Returns a new
 *  array (input untouched). */
export function toggleSelectorByMid<S extends { point?: number[] }>(
  selectors: S[],
  mid: Vec3,
  tol: number,
): (S | { kind: "edge"; by: "nearest"; point: Vec3 })[] {
  const t2 = tol * tol;
  const kept = selectors.filter(
    (s) => !(s.point && s.point.length === 3 && d2(s.point as Vec3, mid) <= t2),
  );
  if (kept.length !== selectors.length) return kept;
  return [...selectors, { kind: "edge", by: "nearest", point: mid }];
}

/** Edit-mode matching tolerance: generous enough to absorb the sidecar's 3dp
 *  rounding and polyline-vs-curve midpoint drift on coarse tessellation, but
 *  bounded so nearby parallel edges don't cross-match. */
export function midMatchTol(bboxDiag: number): number {
  return Math.max(0.5, 0.005 * bboxDiag);
}

/** Build the selector for a picked edge, stamped with the body that owns it.
 *
 *  EVERY site that mints an edge selector from a rendered edge must go through
 *  here. Without the body, the sidecar falls back to the active (last-created)
 *  body, and because `by:"nearest"` always returns SOME winner it then blends an
 *  edge of the wrong body with no error at all — the ring/hexagon bug.
 *
 *  `body` is omitted rather than set to undefined when the edge has none, so a
 *  saved document gains no `"body": null` noise and stays byte-stable. */
export function edgeSelectorFrom(edge: { points: Vec3[]; body?: string | undefined }):
  | { kind: "edge"; by: "nearest"; point: Vec3; body?: string }
  | undefined {
  const mid = polylineMid(edge.points);
  if (!mid) return undefined;
  const sel = { kind: "edge" as const, by: "nearest" as const, point: mid };
  return edge.body ? { ...sel, body: edge.body } : sel;
}
