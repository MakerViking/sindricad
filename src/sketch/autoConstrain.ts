// Auto horizontal/vertical inference for a freshly drawn line — and, more to the
// point, when NOT to apply it.
//
// Drawing a line within a few degrees of an axis silently makes it exact and
// records the constraint (mainstream MCAD's auto-constrain). Making it exact
// means MOVING an endpoint, and the old code always moved the SECOND one:
//
//     if (nearly horizontal) { e.y2 = e.y1; constraints.push(horizontal) }
//
// If that second endpoint had just been snapped onto an existing endpoint, the
// snap was destroyed on the spot — by exactly the angular error the user's hand
// left, which at ordinary zoom is hundredths of a millimetre. And because
// nothing emits a coincident CONSTRAINT on an endpoint snap, there was nothing
// to pull it back:
//
//   "What appears to be automatic coincidence constraint detection between lines
//    does not work properly. Instead of making their endpoints perfectly
//    coincident, the tool creates a very small gap of a few hundredths of a
//    millimetre. These micro-gaps prevent the lines from being truly joined and
//    can subsequently cause cracks during extrusion, as well as undetected or
//    missing regions." (field report ecc3e0d6)
//
// The rule here: never move a point the user placed on existing geometry. Move
// the free end instead, and when both ends are pinned, leave the line alone —
// its angle is a consequence of two deliberate placements and is not ours to
// round off.
//
// NOTE, because a green test file should not imply more than it covers: this
// stops auto-H/V from BREAKING a join. It does not create the coincident
// constraint that would make the join survive later edits — snapping still only
// copies coordinates. That remains open.

/** A line's two endpoints, as plain numbers. */
export interface LineEnds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface AutoHVResult {
  /** the constraint to record, or null to record none */
  kind: "horizontal" | "vertical" | null;
  /** endpoints after the correction (unchanged when kind is null) */
  ends: LineEnds;
  /** which endpoint was moved to make the line exact — for tests and for anyone
   *  wondering why a point shifted */
  moved: "start" | "end" | null;
}

export interface AutoHVOptions {
  /** the line's START was placed on existing geometry and must not move */
  startPinned?: boolean;
  /** the line's END was placed on existing geometry and must not move */
  endPinned?: boolean;
  /** how close to an axis counts, in degrees */
  toleranceDeg?: number;
}

const DEFAULT_TOL_DEG = 3;

/** Decide whether a line should be made exactly horizontal or vertical, and
 *  which end to move to do it. */
export function inferHorizontalVertical(e: LineEnds, opts: AutoHVOptions = {}): AutoHVResult {
  const tol = opts.toleranceDeg ?? DEFAULT_TOL_DEG;
  const unchanged: AutoHVResult = { kind: null, ends: { ...e }, moved: null };

  // Both ends deliberately placed: the angle is what the user asked for, and
  // there is no end left that is free to move.
  if (opts.startPinned && opts.endPinned) return unchanged;

  const deg = (Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180) / Math.PI;
  const norm = ((deg % 180) + 180) % 180; // 0..180
  const horizontal = Math.min(norm, 180 - norm) <= tol;
  const vertical = Math.abs(norm - 90) <= tol;
  if (!horizontal && !vertical) return unchanged;

  // A zero-length line has no meaningful angle; atan2(0,0) is 0, which would
  // read as "horizontal" and add a constraint to a degenerate segment.
  if (e.x1 === e.x2 && e.y1 === e.y2) return unchanged;

  // Move the end that is NOT pinned. Default (neither pinned) keeps the old
  // behaviour of moving the second point, so an ordinary free-hand draw feels
  // exactly as it did.
  const moveStart = !!opts.startPinned === false && !!opts.endPinned === true;
  const ends = { ...e };
  if (horizontal) {
    if (moveStart) ends.y1 = e.y2;
    else ends.y2 = e.y1;
  } else {
    if (moveStart) ends.x1 = e.x2;
    else ends.x2 = e.x1;
  }
  return { kind: horizontal ? "horizontal" : "vertical", ends, moved: moveStart ? "start" : "end" };
}

/** Snap kinds that mean "this point sits on existing geometry". A grid or free
 *  point is the user's hand, not a join, so auto-H/V may still move it. */
export function isGeometrySnap(kind: string): boolean {
  return kind === "endpoint" || kind === "midpoint" || kind === "center";
}
