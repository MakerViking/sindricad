// What a split's diagnostics say, in the toast after a build and in the
// timeline chip's tooltip.
//
// A split that BUILT can still have something to say: a plane lying between
// the parts of a body only separated them, it left damaged parts whole rather
// than repair them, or it left a body the user picked unchanged. Those arrive
// as diagnostics carrying a `reason` (the sidecar's warnings), and the amber
// timeline chip alone is too quiet for "you asked for a cut and got two
// bodies, here is why".
//
// ONE TOAST PER SPLIT, never one per body. The toast stack holds 3 and drops
// the oldest, so a split over many bodies that raised one toast per body
// pushed out the note that mattered, and any red error toasted in the same
// build. Measured on the field file: "All visible" at its datum gives 73
// warnings (62 bodies with damaged parts left whole, 11 separated), and the
// user saw only the last three damaged-part notes, never the one about
// Skjermdeksel. A split whose warnings are all about ONE body keeps their own
// sentences, which name it (Q3: the warning names the body and the count).
// Warnings about several bodies are counted by kind, and each kind NAMES its
// bodies: the toast the first few ("and 59 more"), the chip's tooltip all of
// them. Before, the toast only counted ("62 bodies have damaged parts...") and
// the tooltip listed one sentence per body cut off after 12, so which bodies
// had parts left uncut could not be read anywhere past the twelfth.
//
// A body an "All visible" cut MISSED is recorded with a code and NO reason: a
// plane through an assembly misses most of it, and none of that is news. The
// missing `reason` is the rule, never the code: the same `splitMissed` code
// carries a reason when the user picked the body (the sidecar decides).
//
// Merge into one solid and Separate toast their warnings the same way
// (toastsWarnings): both act on a body the user picked, and what they did that
// was not asked for (loose surfaces dropped, damaged solids left out, pieces
// that stayed apart) is news of the same weight as a split that only separated.
// They are one-body features, so their notes always keep their own sentences.
//
// A join that left some of the user's pieces out toasts too, from whichever
// feature did the join, picked by its code (TOASTED_CODES) rather than by
// feature type. It is material left out, and on the chip alone it was an amber
// outline on one icon among dozens, its reason only on hover. A join that kept
// pieces apart in the body (`joinPiecesApart`) does NOT toast: nothing was
// lost, and in a run of Combines a piece apart after one step is often joined
// by the next, so a toast for each step would be noise. It stays on the chip.
//
// Pure, so it is tested without main.ts, which cannot be imported in a test.

import { hasKey, localeTag, t } from "../i18n";
import { BODY_SLOT, featureErrorText, type NamedBody } from "../geometry/featureErrorText";
import type { FeatureType, ResolveDiag } from "../types";

/** The feature types whose warnings get a toast as well as the amber chip.
 *  Every other feature's advisory (a sealed void, a Clean Up fit) stays on its
 *  chip: those describe a result the user can inspect, not material the
 *  feature removed or left out. */
const TOASTED: ReadonlySet<string> = new Set<FeatureType>(["split", "mergeSolids", "separate"]);

/** Warnings toasted whichever feature raised them, by code: material a feature
 *  left out, from feature types whose other notes stay on the chip. A join that
 *  left the user's pieces out can come from a Combine or a Join-mode extrude,
 *  revolve, sweep, loft or thicken; toasting those TYPES would toast their
 *  reference notes too. A cut that removed nothing because the only material it
 *  reaches was hidden when it was made is material the feature left out too, and
 *  it was a red error before it was a warning: on the chip alone it reads as "I
 *  cut and nothing happened". */
const TOASTED_CODES: ReadonlySet<string> = new Set(["cutOnlyHidden", "joinPiecesLeftOut"]);

export function toastsWarnings(type: string | undefined): boolean {
  return type !== undefined && TOASTED.has(type);
}

export interface SplitWarning {
  featureId: string;
  text: string;
  /** What the toast is ABOUT, to say it once: the feature, and per note its
   *  code, body and count. Not the text: renaming a body after the split
   *  changes the words, not the news, and keyed on the words the same warning
   *  toasted again on every rename. */
  key: string;
}

/** Bodies a toast names per kind before "and N more": it is three lines tall. */
const TOAST_NAMES = 3;
/** Bodies the chip's tooltip names per kind. The field file's worst split has
 *  62 of one kind; the cap only stops an assembly-wide cut on a 3,000-body
 *  file growing a tooltip taller than the window. */
export const TOOLTIP_NAMES = 100;

/** A diagnostic in the user's words: featureErrorText's translation by code
 *  and `{body}` filling, except that a code which is ALSO a red error says what
 *  it means as a warning. `splitMissed` is the error of a one-body split the
 *  plane misses ("Split changed nothing: ..."); on one body of several that
 *  sentence is false, the others were cut. `engine.warning.<code>` is that
 *  warning's sentence, and wins where it exists. */
export function diagnosticText(d: ResolveDiag, bodies: readonly NamedBody[] | undefined): string {
  const key = `engine.warning.${d.code}`;
  if (d.code && hasKey(key)) {
    const params = typeof d.count === "number" ? { body: BODY_SLOT, count: d.count } : { body: BODY_SLOT };
    const { code: _code, ...rest } = d;
    return featureErrorText({ ...rest, message: t(key, params) }, bodies);
  }
  return featureErrorText({ ...d, message: d.reason ?? "" }, bodies);
}

/** The name a diagnostic's body goes by, in featureErrorText's order: the
 *  Browser's name, then the one the sidecar sent, then "this body". */
export function diagBodyName(d: ResolveDiag, bodies: readonly NamedBody[] | undefined): string {
  const { code: _code, ...rest } = d;
  return featureErrorText({ ...rest, message: BODY_SLOT }, bodies);
}

export function splitWarningsToShow(
  diagnostics: readonly ResolveDiag[] | undefined,
  /** the features whose warnings are toasted (toastsWarnings on its type); any
   *  other feature toasts only its warnings whose code TOASTED_CODES names */
  toasts: (featureId: string) => boolean,
  /** features that FAILED this build: their red toast says it all */
  failed: ReadonlySet<string>,
  /** the diagnostic in the user's words (diagnosticText, Browser names) */
  text: (d: ResolveDiag) => string,
  /** the name of the diagnostic's body (diagBodyName, Browser names) */
  name: (d: ResolveDiag) => string,
): SplitWarning[] {
  const out: SplitWarning[] = [];
  for (const [featureId, all] of reasonedByFeature(diagnostics, (fid) => !failed.has(fid))) {
    const list = toasts(featureId) ? all : all.filter((d) => d.code !== undefined && TOASTED_CODES.has(d.code));
    if (!list.length) continue;
    const said = splitNoteLines(list, text, name, TOAST_NAMES).join(" ");
    const key = [featureId, ...list.map((d) => `${d.code ?? d.kind}:${d.body_id ?? ""}:${d.count ?? ""}`)].join("\u0000");
    if (said) out.push({ featureId, text: said, key });
  }
  return out;
}

/** The diagnostics that carry a reason, per feature, in the order they came. */
export function reasonedByFeature(
  diagnostics: readonly ResolveDiag[] | undefined,
  keep: (featureId: string) => boolean,
): Map<string, ResolveDiag[]> {
  const byFeature = new Map<string, ResolveDiag[]>();
  for (const d of diagnostics ?? []) {
    const fid = d.feature_id;
    if (!fid || !d.reason || !keep(fid)) continue;
    const list = byFeature.get(fid) ?? [];
    list.push(d);
    byFeature.set(fid, list);
  }
  return byFeature;
}

/** The kinds a split over several bodies counts, and how each says it. `names`
 *  is the list of bodies (with their part counts for damaged parts). */
const KINDS: [code: string, say: (count: number, names: string, parts: number) => string][] = [
  ["splitSeparated", (count, names) => t("feature.split.summary.separated", { count, names })],
  ["splitSeparatedKept", (count, names) => t("feature.split.summary.separatedKept", { count, names })],
  ["splitDamagedParts", (count, names, parts) => t("feature.split.summary.damaged", { count, names, parts })],
  ["splitMissed", (count, names) => t("feature.split.summary.missed", { count, names })],
  ["splitLegacyVolume", (count, names) => t("feature.split.summary.legacyVolume", { count, names })],
];

/** One split's notes as lines. Notes about ONE body keep their own sentences,
 *  which name it. Notes about several bodies are counted by kind, one line per
 *  kind naming up to `limit` of its bodies ("and N more" after that); a kind
 *  this build does not know (a newer sidecar) is said once in its own words
 *  rather than dropped. */
export function splitNoteLines(
  list: readonly ResolveDiag[],
  text: (d: ResolveDiag) => string,
  name: (d: ResolveDiag) => string,
  limit: number,
): string[] {
  const oneBody = list.every((d) => d.body_id !== undefined && d.body_id === list[0]!.body_id);
  if (list.length === 1 || oneBody) return list.map(text).filter(Boolean);
  const groups = new Map<string, ResolveDiag[]>();
  const other: string[] = [];
  for (const d of list) {
    if (d.body_id !== undefined && KINDS.some(([code]) => code === d.code)) {
      const g = groups.get(d.code!) ?? [];
      g.push(d);
      groups.set(d.code!, g);
      continue;
    }
    const said = text(d);
    if (said && !other.includes(said)) other.push(said);
  }
  const lines: string[] = [];
  for (const [code, say] of KINDS) {
    const g = groups.get(code);
    if (!g) continue;
    const damaged = code === "splitDamagedParts";
    const partsOf = (d: ResolveDiag) => (typeof d.count === "number" ? d.count : 1);
    const items = g.map((d) => (damaged ? t("feature.split.summary.partsIn", { count: partsOf(d), name: name(d) }) : name(d)));
    const parts = damaged ? g.reduce((n, d) => n + partsOf(d), 0) : 0;
    lines.push(say(g.length, listOf(items, limit), parts));
  }
  return [...lines, ...other];
}

/** "A, B, C, and 4 more", in the language's own list form. */
function listOf(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit);
  if (items.length > limit) shown.push(t("feature.split.summary.more", { count: items.length - limit }));
  return new Intl.ListFormat(localeTag()).format(shown);
}
