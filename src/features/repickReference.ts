// Ambiguous-reference repair: find the selector a rebuild refused, and produce
// the patch that replaces it with a freshly picked one.
//
// Kept DOM-free and free of viewport/store imports so it can be tested directly
// — the interactive half (highlight a face, click it) lives in featureStarters,
// which already owns picking. This module is only the part that is easy to get
// quietly wrong: deciding WHICH of a feature's selectors the sidecar was
// complaining about.
//
// The sidecar reports the failing selector by its own stored POINT (ResolveDiag
// `at`), not by an index, because a selector's position in the feature is not
// stable across the sidecar's own grouping (see _group_sels_by_body). Matching
// on the point is what keeps the two sides from having to agree on an ordering.

import type { Feature, Selector } from "../types";

// Every feature field that can carry selectors, each `Selector | Selector[]`.
// fillet/chamfer use `edges`; press-pull/deleteFace use `face` (+ `upTo`);
// shell/offsetFace/thicken/draft use `faces`.
const SELECTOR_FIELDS = ["edges", "face", "faces", "upTo"] as const;
type SelectorField = (typeof SELECTOR_FIELDS)[number];

/** Where a selector lives inside a feature. `index` is null for a scalar field. */
export interface SelectorSite {
  field: SelectorField;
  index: number | null;
}

// The sidecar rounds `at` to 6 decimals; the document keeps full precision. A
// tolerance well below any real modelling distance, but above that rounding.
const MATCH_TOL = 1e-4;

function isNearestAt(sel: unknown, at: readonly number[]): boolean {
  if (!sel || typeof sel !== "object") return false;
  const s = sel as { by?: string; point?: unknown };
  if (s.by !== "nearest" || !Array.isArray(s.point) || s.point.length !== 3) return false;
  return s.point.every((v, i) => typeof v === "number" && Math.abs(v - (at[i] ?? NaN)) <= MATCH_TOL);
}

/**
 * Locate the `by:"nearest"` selector whose stored point is `at`, or null when the
 * feature no longer has one — which happens legitimately: the user may have
 * already re-picked it, or edited the feature, since the rebuild that failed.
 * Callers must treat null as "nothing to repair", not as an error.
 */
export function findSelectorAt(feature: Feature, at: readonly number[]): SelectorSite | null {
  for (const field of SELECTOR_FIELDS) {
    const val = (feature as unknown as Record<string, unknown>)[field];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      const index = val.findIndex((s) => isNearestAt(s, at));
      if (index >= 0) return { field, index };
    } else if (isNearestAt(val, at)) {
      return { field, index: null };
    }
  }
  return null;
}

/**
 * The patch that swaps in `next` at `site`, preserving the field's shape (scalar
 * stays scalar, array stays an array of the same length) so nothing downstream
 * has to cope with a field changing arity.
 */
export function replaceSelectorAt(
  feature: Feature,
  site: SelectorSite,
  next: Selector,
): Partial<Feature> {
  if (site.index === null) return { [site.field]: next } as Partial<Feature>;
  const cur = (feature as unknown as Record<string, unknown>)[site.field];
  const arr = Array.isArray(cur) ? [...(cur as Selector[])] : [];
  arr[site.index] = next;
  return { [site.field]: arr } as Partial<Feature>;
}

/** The ambiguous-reference diagnostic for a feature, if this build reported one.
 *
 *  Matches the machine-readable `code` first. The prose fallback is DELIBERATE
 *  and stays: matching `reason === "ambiguous nearest pick"` across the language
 *  boundary is what this used to do, so a sidecar older than the code field —
 *  most commonly `server.py` run by hand from another checkout, which is a
 *  routine workflow here — would otherwise silently lose the Re-pick affordance
 *  with no error to explain it. Drop the fallback only once the bundled sidecar
 *  is version-locked to the app. */
export function ambiguousDiagFor(
  diagnostics: { feature_id?: string; reason?: string; code?: string; at?: [number, number, number]; kind?: string; candidates?: string[] }[] | undefined,
  featureId: string,
) {
  return (diagnostics ?? []).find(
    (d) =>
      d.feature_id === featureId &&
      (d.code === "ambiguousReference" || d.reason === "ambiguous nearest pick") &&
      Array.isArray(d.at),
  );
}
