// The sketch ORIGIN: a fixed point at (0,0) in plane coordinates.
//
// Field report (2026-08-24, Doug): "if I use a point on what I assume to be
// X0,Y0, when I dimension to that point, it moves." It moved because there was
// nothing there. A sketch had no origin and no axes, so a point drawn at 0,0 was
// an ordinary free entity and the solver was entitled to move it to satisfy a
// dimension. Every other CAD package gives you a fixed origin to build from, and
// that is the assumption Doug was reasonably making.
//
// It is a SYNTHETIC entity, the same trick the text preview uses: it lives in
// SketchMode's live entity list so that every existing picker, snapper,
// dimension target and constraint target finds it for free, and it is filtered
// out at the save boundary so it never reaches the document. That choice is what
// keeps this from being a file-format change: no migration, nothing to write,
// and every sketch ever saved gains an origin the moment it is reopened. It also
// cannot be deleted, because it is not in the list that gets saved.
//
// It is pinned in the solver exactly the way projected geometry is (see
// sketchSolve's `fixedPts`), which means a user endpoint made COINCIDENT with it
// fuses onto a fixed point and is thereby anchored. That is the whole point: the
// origin is not decoration, it is the thing you attach to so the rest stops
// drifting.

import type { ResolvedEntity } from "./snap";

/** Reserved id. Double-underscored like TEXT_PREVIEW_ID so it cannot collide
 *  with `newEntityId()` output. */
export const ORIGIN_ID = "__origin__";

export const isOriginId = (id: string | undefined | null): boolean => id === ORIGIN_ID;

/** True for the synthetic entities that must never be saved, deleted or dragged. */
export const originEntity = (): ResolvedEntity => ({
  type: "point",
  id: ORIGIN_ID,
  x: 0,
  y: 0,
});
