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
export const ORIGIN_X_ID = "__originX__";
export const ORIGIN_Y_ID = "__originY__";

/** Half-length of the origin axes, in mm.
 *
 *  An axis is conceptually infinite and this is the finite stand-in. 10 m is
 *  chosen to be past any plausible printed part, so the axes read as "lines
 *  across the view" at every realistic zoom rather than as two long sticks that
 *  stop somewhere. It costs nothing: they compile to two pinned endpoints each,
 *  and nothing in the app frames the camera on sketch entities, so an axis this
 *  long cannot drag a Fit out to 10 m. */
const AXIS_HALF = 10_000;

export const isOriginId = (id: string | undefined | null): boolean => id === ORIGIN_ID;

/** The origin POINT, the origin AXES, or neither. All three are synthetic:
 *  never saved, never deleted, always pinned. */
export const isOriginGeometry = (id: string | undefined | null): boolean =>
  id === ORIGIN_ID || id === ORIGIN_X_ID || id === ORIGIN_Y_ID;

export const originEntity = (): ResolvedEntity => ({
  type: "point",
  id: ORIGIN_ID,
  x: 0,
  y: 0,
});

/** The X and Y axes, as CONSTRUCTION lines through the origin.
 *
 *  Construction on purpose: `detectRegions` filters construction geometry out
 *  (region.ts), so an axis lying along the bottom edge of a rectangle can never
 *  split the profile or turn one area into two. They are still fully
 *  selectable, so "make this line collinear with the X axis" works, which is the
 *  thing they exist for. */
export const originAxisEntities = (): ResolvedEntity[] => [
  { type: "line", id: ORIGIN_X_ID, x1: -AXIS_HALF, y1: 0, x2: AXIS_HALF, y2: 0, construction: true },
  { type: "line", id: ORIGIN_Y_ID, x1: 0, y1: -AXIS_HALF, x2: 0, y2: AXIS_HALF, construction: true },
];

/** Origin point + axes, in the order they should be inserted. */
export const originGeometry = (): ResolvedEntity[] => [originEntity(), ...originAxisEntities()];
