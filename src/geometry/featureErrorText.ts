/**
 * Compose the human sentence for a failed feature.
 *
 * The sidecar no longer writes a body's name into the error message. The name
 * came out of the document — on an import, out of the STEP file — and prose is
 * the one place untrusted text cannot be told apart from the sidecar's own
 * words, which matters the moment a language model reads the same reply
 * (sidecar/untrusted.py has the full reasoning). The message carries a `{body}`
 * slot instead, plus `body_id` (the sidecar's own id) and `subject` (the name,
 * already capped and control-stripped on the Python side).
 *
 * Substituting is the frontend's job because the frontend is where the human
 * is, and it already holds every live body's name.
 *
 * A PURE function, deliberately: this repo has no jsdom, so the DOM patching in
 * timeline.ts and the toast in main.ts are NOT covered by tests — only this is.
 * Precedent: buildAssemblyGroups.
 */

import { sketchLabel } from "../document/sketchLabel";
import { hasKey, type Params, t } from "../i18n";

/** The token the sidecar leaves where a body's name belongs. Mirrors
 *  `errors.BODY_SLOT` in the sidecar; the contract is in docs/PROTOCOL.md. */
export const BODY_SLOT = "{body}";

/** The token a translation leaves where the failing feature's sketch is named
 *  (`cutLostProjection`). The sidecar never writes it: a sketch's name is
 *  document text too, and the frontend holds every sketch, so the coded
 *  sentence carries the slot and the name goes in here, as {body}'s does. */
export const SKETCH_SLOT = "{sketch}";
/** The token a translation leaves where ANOTHER feature the sentence is about
 *  is named (`blendCornerTaken`: the earlier fillet in the way). The sidecar
 *  sends that feature's id as `feature_ref`; the name is the timeline's. */
export const FEATURE_SLOT = "{feature}";
const SLOTS = /\{body\}|\{sketch\}|\{feature\}/g;

/** Matches sidecar `untrusted.MAX_SUBJECT`, so a name substituted here is bounded
 *  the same way one that arrived as `subject` already is. */
const MAX_NAME = 120;

export interface FeatureErrorLike {
  message: string;
  /** The failing feature: whose sketch a `{sketch}` slot names. */
  feature_id?: string;
  /** A stable code from the sidecar or the shell. When the UI has a
   *  translation for it (`engine.error.<code>`), that replaces the English
   *  message; codes whose message carries specifics (which edge, which
   *  candidates) have no such key and keep the sidecar's own sentence. */
  code?: string;
  body_id?: string;
  subject?: string;
  /** A number the coded sentence counts, e.g. how many damaged parts a split
   *  left whole (`splitDamagedParts`). Passed to the translation as `{count}`,
   *  which also picks its plural form. Ours, never document text. */
  count?: number;
  /** A second number beside `count`, e.g. the damaged parts in all when
   *  `count` is the bodies they are in (`splitDamagedAllMore`). Passed as
   *  `{parts}`; it picks no plural form. Ours, never document text. */
  parts?: number;
  /** Another feature the sentence names through `{feature}`, by id. */
  feature_ref?: string;
}

/** Just enough of a body to name it. */
export interface NamedBody {
  id: string;
  name: string;
}

/** Just enough of a document feature to name the sketch a feature draws from:
 *  every feature, in document order, so a sketch's place among them is the
 *  Browser's (sketchLabel). */
export interface SketchedFeature {
  id: string;
  type: string;
  name?: string;
  sketch?: unknown;
}

/** What the Browser calls the sketch feature `featureId` draws from, or
 *  undefined when it has none or it is gone. */
function sketchNameOf(features: readonly SketchedFeature[] | undefined, featureId: string | undefined): string | undefined {
  if (!features || !featureId) return undefined;
  const sid = features.find((f) => f.id === featureId)?.sketch;
  if (typeof sid !== "string") return undefined;
  const sketches = features.filter((f) => f.type === "sketch");
  const i = sketches.findIndex((f) => f.id === sid);
  const sketch = sketches[i];
  return sketch ? sketchLabel(sketch, i) : undefined;
}

/** Feature `featureId` as the timeline shows it: its tool's name and its step,
 *  or undefined when it is not in `features`. */
export function featureNameOf(features: readonly SketchedFeature[] | undefined, featureId: string | undefined): string | undefined {
  const step = featureStep(features, featureId);
  return step && t("engine.featureAt", step);
}

/** Feature `featureId`'s tool name and its 1-based step in `features` (the
 *  WHOLE document's, so the step is the one the timeline shows), or undefined
 *  when it is not there. */
export function featureStep(
  features: readonly SketchedFeature[] | undefined,
  featureId: string | null | undefined,
): { name: string; index: number } | undefined {
  if (!features || !featureId) return undefined;
  const i = features.findIndex((f) => f.id === featureId);
  const type = features[i]?.type;
  if (type === undefined) return undefined;
  return { name: hasKey(`tool.${type}`) ? t(`tool.${type}`) : type, index: i + 1 };
}

/** The status-bar line for a failed build. It printed the raw feature id
 *  ("⚠ f119: ...") and, for a stall that carried no id, "⚠ : the geometry
 *  engine stopped responding" (field report 6ddd01dc): name the step the way
 *  the timeline does, and drop the prefix when there is no step to name. */
export function buildErrorStatus(
  featureId: string | null | undefined,
  message: string,
  features: readonly SketchedFeature[] | undefined,
): string {
  const step = featureStep(features, featureId);
  return step ? t("status.buildError", { ...step, message }) : t("status.buildErrorNoStep", { message });
}

/**
 * `e.message` with its `{body}` and `{sketch}` slots filled in.
 *
 * A body's resolution order is live name -> `subject` -> a neutral phrase. The
 * live name wins because a body can be renamed after the error was cached, and
 * `subject` is only ever the name as it stood when the failure happened. A
 * sketch is named as the Browser lists it, from `features` (the document's),
 * or by a neutral phrase.
 *
 * A message with no slot is returned untouched: it is not about a body, and
 * appending one would invent a claim.
 */
export function featureErrorText(
  e: FeatureErrorLike,
  bodies: readonly NamedBody[] | undefined,
  features?: readonly SketchedFeature[],
): string {
  const codeText = `engine.error.${e.code}`;
  // `{body}` is handed back to t() as itself: the split codes are the first
  // translations to carry the slot, and t() warns on any placeholder it is not
  // given a value for. The name goes in below, by function, not through t().
  const params: Params = { body: BODY_SLOT, sketch: SKETCH_SLOT, feature: FEATURE_SLOT };
  if (typeof e.count === "number") params.count = e.count;
  if (typeof e.parts === "number") params.parts = e.parts;
  const coded = e.code && hasKey(codeText) ? t(codeText, params) : undefined;
  const msg = coded ?? e.message ?? "";
  if (!msg.includes(BODY_SLOT) && !msg.includes(SKETCH_SLOT) && !msg.includes(FEATURE_SLOT)) return msg;

  const live = e.body_id ? bodies?.find((b) => b.id === e.body_id)?.name : undefined;
  // Trim each candidate BEFORE choosing, not after: a body named "   " is
  // truthy, so trimming downstream let it win the fallback chain and then
  // collapse to nothing, skipping `subject` entirely.
  const name = (live?.trim() || e.subject?.trim() || "").slice(0, MAX_NAME).trim() || t("common.thisBody");
  const sketch = (sketchNameOf(features, e.feature_id)?.trim() ?? "").slice(0, MAX_NAME).trim() || t("common.itsSketch");
  const feature = featureNameOf(features, e.feature_ref) ?? t("common.anEarlierBlend");

  // The replacement MUST go through a function. A plain string replacement
  // interprets $&, $`, $' and $$ as patterns, so a body named `$&` would splice
  // the matched token back into its own substitution — a name is data, not a
  // format string. Every slot in ONE pass, so a name holding another slot's
  // token is never read as a slot.
  return msg.replace(SLOTS, (slot) => (slot === BODY_SLOT ? name : slot === SKETCH_SLOT ? sketch : feature));
}

/** What featureErrorMessages reads off a build: the reply's failing features
 *  and the legacy single-error fields (DocumentStore's RebuildState). */
export interface BuildErrorsLike {
  result: { featureErrors?: readonly FeatureErrorLike[] } | null;
  errorFeatureId: string | null;
  errorMessage: string | null;
}

/**
 * Every failing feature in a build: id -> the sentence to show for it.
 *
 * Continue-past-errors can fail several; a reply that only carries the legacy
 * single error falls back to that. One source for the timeline's red chips and
 * the Inspector, so the two can never tell the user different things.
 */
export function featureErrorMessages(
  build: BuildErrorsLike,
  bodies: readonly NamedBody[] | undefined,
  features?: readonly SketchedFeature[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of build.result?.featureErrors ?? []) {
    if (e.feature_id) m.set(e.feature_id, featureErrorText(e, bodies, features));
  }
  if (build.errorFeatureId && !m.has(build.errorFeatureId)) {
    m.set(build.errorFeatureId, build.errorMessage ?? t("timeline.failed"));
  }
  return m;
}
