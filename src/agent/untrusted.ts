/**
 * The TypeScript half of the untrusted-text contract in docs/PROTOCOL.md.
 *
 * `sidecar/untrusted.py` bounds and de-fangs document text on its way out of the
 * kernel. This does the same on its way into an agent's context, and adds the
 * half the sidecar deliberately does not apply: the delimiter-wrapped marker.
 *
 * Why the wrapping lives HERE and not in the sidecar: the sidecar's replies are
 * also what the app renders for a human, and bracketing every body name in a
 * toast would make the product worse for the reader it was already correct for.
 * The agent boundary is the only place the wrapping is right, and this module is
 * that boundary.
 *
 * These constants MUST track sidecar/untrusted.py. They are duplicated rather
 * than shared because there is no runtime seam between Python and TypeScript to
 * share them across; `untrusted.test.ts` pins the cases both sides must agree on.
 */

/** Mirrors `untrusted._OPEN` / `_CLOSE`. Mathematical white square brackets,
 *  chosen because they are effectively absent from real product names, so
 *  stripping them from a payload costs nothing a user would miss. */
const OPEN = "⟦";
const CLOSE = "⟧";

/** Mirrors `untrusted.MAX_SUBJECT`. */
export const MAX_SUBJECT = 120;
/** Mirrors `untrusted.MAX_MESSAGE`. */
export const MAX_MESSAGE = 2000;

/** Control characters that MEAN a space, and would otherwise be deleted with the
 *  rest — gluing words together. Same list as the Python side. */
const AS_SPACE = /[\t\n\r\f\v]/g;
/** Unicode "Other": control, format, surrogate, private-use, unassigned. Takes
 *  out bidi overrides and zero-width joiners, which is the point. */
const OTHER = /\p{C}/gu;

/**
 * Bound and de-fang one untrusted string. The TS twin of `untrusted.clean`.
 *
 * Truncation counts CODE POINTS, not UTF-16 units. `"🙂".length` is 2 in
 * JavaScript, so a plain `.slice()` can cut an emoji in half and leave a lone
 * surrogate — which survives every length check and then throws at JSON
 * encoding. This is the JS shape of the same trap the Python side documents for
 * bytes.
 */
export function clean(text: unknown, limit = MAX_MESSAGE): string {
  if (limit <= 0) return "";
  const raw = text === null || text === undefined ? "" : String(text);
  const stripped = raw.replace(AS_SPACE, " ").replace(OTHER, "").replace(/\s+/g, " ").trim();
  const points = [...stripped];
  if (points.length <= limit) return stripped;
  return points.slice(0, limit - 1).join("").trimEnd() + "…";
}

/**
 * Wrap one untrusted string in an explicit, unforgeable marker.
 *
 * The load-bearing property is that a payload cannot emit its own closing
 * marker: both delimiters are removed from the text, so nothing inside can
 * escape into trusted context. That is structural, not a guess about which
 * strings are dangerous — a denylist of "ignore previous instructions" phrasings
 * would be theatre.
 *
 * `kind` is whitelisted for the same reason, even though every caller passes a
 * literal: an escape through the LABEL is still an escape.
 */
export function envelope(text: unknown, kind = "text", limit = MAX_SUBJECT): string {
  const body = clean(text, limit).split(OPEN).join("").split(CLOSE).join("");
  const k = kind.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32) || "text";
  return `${OPEN}untrusted:${k}${CLOSE}${body}${OPEN}/untrusted${CLOSE}`;
}
