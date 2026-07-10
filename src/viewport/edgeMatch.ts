// Pure geometry helpers for matching saved edge selectors (world-space
// midpoints) back to rendered edge polylines. Edge ids are NOT stable across
// rebuilds (the client assigns e0,e1,... per assembly), so geometry is the only
// rebuild-stable edge identity — the same convention selectors already use.
// Kept DOM/three-free so vitest covers it headlessly.

export type Vec3 = [number, number, number];

/** The polyline point selectors are built from: the INDEX-middle sample, NOT
 *  the arc-length midpoint — must stay identical to picking.ts's pickEdge
 *  (`pts[floor(len/2)]`) or saved selectors won't re-match their own edge. */
export function polylineMid(points: Vec3[]): Vec3 {
  return points[Math.floor(points.length / 2)];
}

const d2 = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

/** Index of the edge whose polyline midpoint is nearest to `mid`, or null when
 *  none lands within `tol` (world units). Ties resolve to the first nearest. */
export function nearestEdgeByMid(
  edges: { points: Vec3[] }[],
  mid: Vec3,
  tol: number,
): number | null {
  let best = -1;
  let bestD = tol * tol;
  for (let i = 0; i < edges.length; i++) {
    const dd = d2(polylineMid(edges[i].points), mid);
    if (dd < bestD) { bestD = dd; best = i; }
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
