/**
 * The lines the post-export list shows for an export reply's `warnings`.
 *
 * That array carries two different things, and the list used to render both
 * as the first:
 *
 *   - FAILED FEATURES. The sidecar builds these with `_err_entry`, so they
 *     always carry a `feature_id` key (and often a `code`, `body_id`, ...).
 *     Their geometry really is missing from the written file.
 *   - NOTES about a file that WAS written: the mesh has unmatched edges, the
 *     export is very dense, texture is not in a STEP file. These are
 *     `{message}` alone.
 *
 * Every entry went through one sentence, "⚠ {feature} failed — its result is
 * NOT in the export: {reason}", with "feature" standing in for the missing id,
 * so a note about open edges read as a failed export (field report: the Ender 3
 * Skjermdeksel split, exported as one STL, 243 unmatched edges).
 *
 * A PURE function for the same reason as featureErrorText: this repo has no
 * jsdom, so the modal in files.ts and publish.ts is not under test; this is.
 */

import { featureErrorText, type NamedBody, type SketchedFeature } from "../geometry/featureErrorText";
import { t } from "../i18n";
import type { FeatureError } from "../types";
import { FEATURE_META } from "../ui/featureMeta";

/** Where the written geometry went, which picks "NOT in the export" or
 *  "NOT in the upload" for a failed feature. */
export type ReportTarget = "export" | "upload";

/** Just enough of a feature to find it on the timeline, and to name the
 *  sketch a failed one draws from (featureErrorText's `{sketch}`). */
export type TimelineFeature = SketchedFeature;

/**
 * Did this entry come from a feature that failed?
 *
 * Tested on the KEY, not its truthiness: `_err_entry` copies `feature_id` from
 * the builder's entry, which always sets it, and a feature without an id comes
 * through as `null`. That is still a failure whose geometry is missing, so it
 * must not fall through to "note". Notes never carry the key at all.
 */
export function isFailedFeature(w: FeatureError): boolean {
  return w.feature_id !== undefined;
}

/** A failed feature as the timeline shows it ("12 · Extrude"), so it can be
 *  found there. The raw id only if the feature is not in the document, and the
 *  neutral "feature" when there is no id at all. */
export function featureTimelineLabel(
  features: readonly TimelineFeature[],
  id: string | null | undefined,
): string {
  if (!id) return t("file.export.unnamedFeature");
  const index = features.findIndex((f) => f.id === id);
  const feature = features[index];
  if (!feature) return id;
  const type = feature.type;
  // Same tolerance as the timeline's own lookup: a type this build does not
  // know (a document from a newer version) shows as its raw type name.
  const label = (FEATURE_META as Record<string, { label: string } | undefined>)[type]?.label ?? type;
  return t("timeline.chip", { index: index + 1, name: label });
}

export interface ExportReport {
  /** One line per warning, in the order the sidecar sent them. */
  lines: string[];
  /** How many of them are failed features. Zero means no feature's geometry
   *  is missing from the file, and the list's title must not say otherwise. */
  failed: number;
}

export function exportReport(
  warnings: readonly FeatureError[] | undefined,
  target: ReportTarget,
  features: readonly TimelineFeature[],
  bodies: readonly NamedBody[] | undefined,
): ExportReport {
  const missingKey = target === "upload" ? "tinkeratlas.publish.featureMissing" : "file.export.featureMissing";
  const lines: string[] = [];
  let failed = 0;
  for (const w of warnings ?? []) {
    // featureErrorText for both kinds: it translates a coded failure and fills
    // a `{body}` slot, and leaves a plain note's sentence exactly as sent.
    const text = featureErrorText(w, bodies, features);
    if (isFailedFeature(w)) {
      failed++;
      lines.push(t(missingKey, { feature: featureTimelineLabel(features, w.feature_id), reason: text }));
    } else {
      lines.push(t("file.export.note", { note: text }));
    }
  }
  return { lines, failed };
}
