// Which feature MADE a body — the inverse of the per-face provenance the
// sidecar attaches to every build result.
//
// `faceOwners` records the LAST feature to modify each face, so it only answers
// "who made this body" when every face agrees. A box straight from the
// Primitives menu has one owner across all six faces; a body that was extruded
// and then filleted has two, and there is no honest single answer.
//
// Field report 18abd1bb (0.1.184): "create a primitive (eg. box, cylinder),
// select it and try to use the side panel to change its dimensions, the
// dimensions do not change ... certainly not intuitive". A primitive appears in
// the browser tree ONLY as a body row, and clicking that row set the viewport's
// body selection and nothing else — so the feature holding Length/Width/Height
// never reached the inspector. main.ts uses this to open the maker's values when
// the answer is unambiguous, and to leave the panel alone when it is not.

/** The shape of a body in a RebuildReply, narrowed to what provenance needs. */
export interface BodyProvenance {
  id: string;
  faceOwners?: (string | null)[];
}

/** The single feature every face of `bodyId` traces to, or null when the body
 *  has no provenance, is unknown, or was touched by more than one feature. */
export function soleFeatureForBody(
  bodies: readonly BodyProvenance[] | undefined,
  bodyId: string,
): string | null {
  const owners = bodies?.find((b) => b.id === bodyId)?.faceOwners;
  const first = owners?.[0];
  if (!owners?.length || !first) return null;
  return owners.every((o) => o === first) ? first : null;
}
