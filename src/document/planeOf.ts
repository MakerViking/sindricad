// Where a plane-carrying feature ACTUALLY sits after the last rebuild.
//
// A sketch or datum plane anchored to a body face (`face`, GH #52) has its
// placement re-derived by the sidecar every rebuild, and the resolved frame
// comes back in `RebuildResult.planes` keyed by feature id. The feature's own
// `plane` is only the cache written when the sketch was last closed, so reading
// it directly draws the curves at the OLD position while the cut lands at the
// new one — the two halves of the same model disagreeing on screen.
//
// One function, imported by every consumer, because the failure mode of having
// two is that one of them keeps reading `f.plane` and nobody notices which.
// READ-ONLY: nothing here is written back into the document.

import type { PlaneDef, PlaneSpec } from "../types";

export function planeOf(
  f: { id: string; plane: PlaneSpec; planeId?: string },
  planes: Record<string, PlaneDef> | undefined,
): PlaneSpec {
  // `planeId` second: a sketch made by "Offset plane" carries no `face` of its
  // own (the anchor rides on the DATUM — featureStarters.offsetPlane), so the
  // sidecar has no entry under this feature's id, while the datum it is bound to
  // does move. _sketch_plane_ref resolves that link when it BUILDS the sketch,
  // so without this the geometry follows and only the drawing stays behind — the
  // same split, one indirection further out. The datum's entry is already the
  // final placement (offset applied), which is exactly what the sketch sits on.
  return planes?.[f.id] ?? (f.planeId ? planes?.[f.planeId] : undefined) ?? f.plane;
}
