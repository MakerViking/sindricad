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

import { SketchPlane } from "../sketch/plane";
import type { Feature, PlaneDef, PlaneSpec } from "../types";

type DatumFeature = Extract<Feature, { type: "datumPlane" }>;

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

/** A datum plane's world placement (source spec + offset along its normal) as a
 *  PlaneDef — lets "Sketch on plane" / "Offset plane" work straight off the quad. */
export function datumPlaneDef(
  f: DatumFeature,
  resolvedPlanes: Record<string, PlaneDef> | undefined,
): PlaneDef {
  // A face-anchored datum (GH #52) is re-derived by the sidecar every rebuild
  // and comes back in `planes` as its FINAL placement — source face plus the
  // offset already applied — so use it verbatim; re-applying `offset` here would
  // double it. Without this the quad, "Sketch on plane" and "Offset plane" all
  // draw and bake the pre-edit position while the geometry sits at the new one.
  const resolved = resolvedPlanes?.[f.id];
  if (resolved) return resolved;
  const sp = new SketchPlane(f.plane);
  const off = f.offset ?? 0;
  return {
    origin: [sp.origin.x + sp.n.x * off, sp.origin.y + sp.n.y * off, sp.origin.z + sp.n.z * off],
    normal: [sp.n.x, sp.n.y, sp.n.z],
    xdir: [sp.u.x, sp.u.y, sp.u.z],
  };
}

/** The construction-plane quads the viewport should be showing right now.
 *
 *  This is the datum half of `effectiveDoc()` (document/store): the model the
 *  user is looking at is the feature list up to the rollback marker minus the
 *  suppressed features, and a datum plane is part of that model. Built from the
 *  WHOLE document instead, the quad for a plane the rebuild never made stays on
 *  screen and stays a live pick target — selectable, sketchable, and usable as a
 *  press/pull "up to this plane" target — which is field report 9ee3fb35. */
export function activeDatumPlanes(
  features: Feature[],
  opts: {
    rollbackIndex: number;
    isSuppressed: (id: string) => boolean;
    isVisible: (id: string) => boolean;
    resolvedPlanes: Record<string, PlaneDef> | undefined;
  },
): { id: string; origin: [number, number, number]; normal: [number, number, number] }[] {
  return features
    // The two gates that were missing, and they must be read against the
    // ORIGINAL index: `rollbackIndex` counts features, not datum planes.
    .filter((f, i) => i < opts.rollbackIndex && !opts.isSuppressed(f.id))
    .filter((f): f is DatumFeature => f.type === "datumPlane")
    .filter((f) => opts.isVisible(f.id)) // hidden planes: not drawn, not pickable
    .map((f) => {
      const def = datumPlaneDef(f, opts.resolvedPlanes); // one formula for quad, sketch and offset targets
      return { id: f.id, origin: def.origin, normal: def.normal };
    });
}
