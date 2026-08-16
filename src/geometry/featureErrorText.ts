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

/** The token the sidecar leaves where a body's name belongs. Mirrors
 *  `errors.BODY_SLOT` in the sidecar; the contract is in docs/PROTOCOL.md. */
export const BODY_SLOT = "{body}";

/** Matches sidecar `untrusted.MAX_SUBJECT`, so a name substituted here is bounded
 *  the same way one that arrived as `subject` already is. */
const MAX_NAME = 120;

export interface FeatureErrorLike {
  message: string;
  body_id?: string;
  subject?: string;
}

/** Just enough of a body to name it. */
export interface NamedBody {
  id: string;
  name: string;
}

/**
 * `e.message` with its `{body}` slot filled in.
 *
 * Resolution order is live name -> `subject` -> a neutral phrase. The live name
 * wins because a body can be renamed after the error was cached, and `subject`
 * is only ever the name as it stood when the failure happened.
 *
 * A message with no slot is returned untouched: it is not about a body, and
 * appending one would invent a claim.
 */
export function featureErrorText(
  e: FeatureErrorLike,
  bodies: readonly NamedBody[] | undefined,
): string {
  const msg = e.message ?? "";
  if (!msg.includes(BODY_SLOT)) return msg;

  const live = e.body_id ? bodies?.find((b) => b.id === e.body_id)?.name : undefined;
  // Trim each candidate BEFORE choosing, not after: a body named "   " is
  // truthy, so trimming downstream let it win the fallback chain and then
  // collapse to nothing, skipping `subject` entirely.
  const name = (live?.trim() || e.subject?.trim() || "").slice(0, MAX_NAME).trim() || "this body";

  // The replacement MUST go through a function. A plain string replacement
  // interprets $&, $`, $' and $$ as patterns, so a body named `$&` would splice
  // the matched token back into its own substitution — a name is data, not a
  // format string.
  return msg.replaceAll(BODY_SLOT, () => name);
}
