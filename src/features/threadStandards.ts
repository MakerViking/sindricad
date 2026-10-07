// Thread standard sizes, read off the SAME JSON file the sidecar's
// thread_standards.py loads (`thread_standards.json` at the project root), so
// the panel's dropdown and the geometry it drives can never list a size the
// other side does not know, or disagree on a diameter or pitch. This side
// mirrors the Python module's own normalization (major diameter, pitch, and
// minor diameter via each family's depthFrac) so it can preselect a standard
// from a picked face's measured radius without a round trip — the sidecar
// remains the only one that turns those numbers into a cut.
//
// v1 scope (same docstring as thread_standards.py): ISO metric coarse
// M1.6-M64, ISO metric fine from M8 up, UNC/UNF #2-1" at their standard TPI,
// and the five named trapezoidal sizes. A size missing here is a size this
// tool refuses, not a bug.

import DATA from "../../thread_standards.json";
import { t } from "../i18n";

export type ThreadFamily = "metric" | "metricFine" | "unc" | "unf" | "trapezoidal";

const FAMILY_ORDER: ThreadFamily[] = ["metric", "metricFine", "unc", "unf", "trapezoidal"];

/** The label a family shows above its group of designations in the panel's
 *  standard dropdown. */
export const FAMILY_LABEL: Record<ThreadFamily, string> = {
  metric: t("feature.thread.family.metric"),
  metricFine: t("feature.thread.family.metricFine"),
  unc: t("feature.thread.family.unc"),
  unf: t("feature.thread.family.unf"),
  trapezoidal: t("feature.thread.family.trapezoidal"),
};

const _MM_PER_INCH = 25.4;

interface RawRecord {
  designation: string;
  diameter?: number;
  pitch?: number;
  diameterIn?: number;
  tpi?: number;
  starts?: number;
}

interface FamilyInfo {
  halfAngleDeg: number;
  depthFrac: number;
}

/** Normalized to mm, the same shape thread_standards.py's lookup() returns. */
export interface ThreadRecord {
  family: ThreadFamily;
  designation: string;
  majorDiameter: number;
  minorDiameter: number;
  pitch: number;
  starts: number;
}

const DATA_TYPED = DATA as unknown as Record<ThreadFamily, RawRecord[]> & { families: Record<ThreadFamily, FamilyInfo> };

function normalize(family: ThreadFamily, rec: RawRecord): ThreadRecord {
  const major = rec.diameterIn != null ? rec.diameterIn * _MM_PER_INCH : rec.diameter!;
  const pitch = rec.diameterIn != null ? _MM_PER_INCH / rec.tpi! : rec.pitch!;
  const depthFrac = DATA_TYPED.families[family].depthFrac;
  return {
    family, designation: rec.designation, majorDiameter: major,
    minorDiameter: major - 2 * depthFrac * pitch, pitch, starts: rec.starts ?? 1,
  };
}

const BY_DESIGNATION = new Map<string, ThreadRecord>();
const ALL: ThreadRecord[] = [];
for (const family of FAMILY_ORDER) {
  for (const rec of DATA_TYPED[family]) {
    const norm = normalize(family, rec);
    BY_DESIGNATION.set(rec.designation, norm);
    ALL.push(norm);
  }
}

/** The normalized record for a designation, e.g. "M6x1" or "1/4-20 UNC", or
 *  undefined if it is not one of the sizes this tool knows. */
export function lookupThread(designation: string): ThreadRecord | undefined {
  return BY_DESIGNATION.get(designation);
}

/** Every known designation, grouped by family in table order — the panel's
 *  dropdown order (and its <optgroup> boundaries). */
export function allThreadDesignations(): ThreadRecord[] {
  return ALL;
}

/** The designation whose relevant diameter is closest to `diameterMm`: for a
 *  shaft/boss, major diameter only — a shaft at nominal size is already the
 *  normal, and only, case. For a hole/bore, whichever of major (drawn at
 *  nominal, for 3D printing) or minor (tap-drill, the machinist convention)
 *  diameter is closer — the same dual rule the sidecar's `_handle_thread`
 *  matches by. Used to preselect a standard the instant a face is picked,
 *  before the sidecar round trip that authors the by:"match" selector even
 *  returns. Never undefined — the table is never empty. */
export function nearestThread(diameterMm: number, external: boolean): ThreadRecord {
  let best = ALL[0]!;
  let bestErr = Infinity;
  for (const rec of ALL) {
    const err = external
      ? Math.abs(rec.majorDiameter - diameterMm)
      : Math.min(Math.abs(rec.majorDiameter - diameterMm), Math.abs(rec.minorDiameter - diameterMm));
    if (err < bestErr) { best = rec; bestErr = err; }
  }
  return best;
}

/** The panel's size label: the bare designation for an ordinary single-start
 *  size, or e.g. "Tr8x8 (P2, 4 starts)" when `starts` says this designation
 *  is really several parallel helical grooves at a finer pitch than its name
 *  implies — the real Tr8x8 printer leadscrew, not a wrong single helix. */
export function designationLabel(rec: ThreadRecord): string {
  if (rec.starts <= 1) return rec.designation;
  return t("feature.thread.multiStartLabel", {
    designation: rec.designation,
    pitch: String(rec.pitch),
    starts: String(rec.starts),
  });
}
