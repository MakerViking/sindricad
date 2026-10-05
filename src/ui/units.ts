// Display/input units. Geometry is ALWAYS stored in millimetres internally
// (build123d's base unit; correct for STL/STEP/3MF export and 3D printing).
// The unit setting only converts what the user sees and types — lengths shown
// in the dialog/inspector are divided by the factor, typed values multiplied
// back to mm. Angles are always degrees and never converted.

import { localeTag } from "../i18n";

export type Unit = "mm" | "cm" | "in";

const FACTOR: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4 };
const KEY = "sindricad.unit";

let current: Unit = readStored();
const listeners = new Set<() => void>();

/** Narrow an untrusted string — a `<select>` value, a stored setting — to a Unit,
 *  or null. Every boundary that feeds `current` MUST come through here instead of
 *  casting: the unit is interpolated raw into innerHTML markup downstream (the
 *  properties and interference panels), so an unchecked value is a script-injection
 *  path into the privileged webview. */
export function asUnit(v: unknown): Unit | null {
  return v === "mm" || v === "cm" || v === "in" ? v : null;
}

function readStored(): Unit {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  return asUnit(raw) ?? "mm";
}

export function getUnit(): Unit {
  return current;
}

export function setUnit(u: Unit) {
  if (u === current) return;
  current = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

export function onUnitChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** mm -> current display unit */
export function toDisplay(mm: number): number {
  return mm / FACTOR[current];
}

/** current display unit -> mm */
export function fromDisplay(v: number): number {
  return v * FACTOR[current];
}

/** How many decimals a LENGTH is rounded and shown to, per display unit.
 *
 *  Three decimals of a millimetre is 1 um. Three decimals of an INCH is 0.001"
 *  (25.4 um), which cannot even hold the fractions an inch user types: 1/16"
 *  (0.0625) read "0.063" and 1/32" read "0.031", and because a field reads its
 *  own text back, that rounded figure was what got written. Four decimals is
 *  0.0001" (2.5 um) and holds every sixteenth exactly. cm keeps the three it
 *  always had. */
const DECIMALS: Record<Unit, number> = { mm: 3, cm: 3, in: 4 };

/** Decimals a length in the CURRENT display unit is shown to. */
export function lengthDecimals(): number {
  return DECIMALS[current];
}

/** mm -> rounded display string with the unit suffix (e.g. "40 mm").
 *  The unit abbreviation is NOT translated (docs/I18N.md); only the number
 *  follows the locale. */
export function fmtLength(mm: number): string {
  return `${fieldText(mm)} ${current}`;
}

/** Round to `decimals` places (three unless told otherwise — angles, counts,
 *  and anything already in mm). A length in the display unit wants
 *  `lengthDecimals()`, which is what displayValue/fieldText/fmtLength pass. */
export function round(v: number, decimals = 3): number {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
}

/** Nearest "nice" step (1/2/5 × 10ⁿ) to a rough magnitude — used for the adaptive
 *  grid spacing and for snapping drag/cursor values to clean numbers. */
export function niceStep(rough: number): number {
  if (!(rough > 0) || !isFinite(rough)) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = rough / Math.pow(10, exp); // 1..10
  const nice = base < 1.5 ? 1 : base < 3.5 ? 2 : base < 7.5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

/** Snap a value to a step, then strip float fuzz so it reads as a clean number
 *  (e.g. 0.30000001 → 0.3). */
export function snap(v: number, step: number): number {
  if (!(step > 0)) return round(v);
  return round(Math.round(v / step) * step);
}

// FieldKind lives in the document layer (numFields.ts); re-exported here for
// the input-side consumers that historically import it from units.
import type { FieldKind } from "../document/numFields";
import { isImeComposing } from "./focus";
import { UNITS, parseExpr, refsOfNode, tokenize, type ExprNode } from "../params/parse";
import { evalExpr, evalNode } from "../params/eval";
import { splitNameValue } from "../params/engine";
export type { FieldKind };

/** numeric value to show in a field: angles stay in degrees, lengths convert */
export function displayValue(mm: number, kind: FieldKind = "length"): number {
  return kind === "length" ? round(toDisplay(mm), lengthDecimals()) : round(mm); // angle/count: raw
}

/** The text to PUT IN AN INPUT for a value in mm — `displayValue` written the
 *  way the active locale writes numbers. Always paired with `parseField` on the
 *  way back, and the pair round-trips to the display precision (see fmtNumber).
 *
 *  To the display precision, NOT exactly: a 1/32" reads "0.0313" and parses
 *  back 1.3 um long. So an editor that prefilled this text must not write the
 *  text back when the user left it alone — it commits the value it was given
 *  instead (the dimension label editor, DimInput, the inspector). */
export function fieldText(mm: number, kind: FieldKind = "length"): string {
  return fmtNumber(displayValue(mm, kind), kind === "length" ? lengthDecimals() : 3);
}

/** Arrow-key steps round to this many places — only enough to strip float fuzz. */
const STEP_DECIMALS = 9;

/** Turn an `<input>` into the app's numeric field.
 *
 *  TEXT, not `type="number"`: a number input whose text is not a valid
 *  dot-decimal literal reports its value as the EMPTY STRING, so "12,5" typed
 *  under an English webview never reaches the app at all — the field reads as
 *  cleared and the panel falls back to its default. `inputMode` keeps the
 *  numeric keypad on touch, and Arrow Up/Down keep the stepping that
 *  `type="number"` provided (its spinner buttons are the one thing lost).
 *
 *  Read the field back with `parseNumber` / `parseField`, never `parseFloat`. */
export function numericInput(el: HTMLInputElement, step = 1): HTMLInputElement {
  el.type = "text";
  el.inputMode = "decimal";
  el.autocomplete = "off";
  el.addEventListener("keydown", (e) => {
    // Arrow keys belong to the IME while a conversion is open — they walk the
    // candidate list. Stepping the value there would both change the number and
    // eat the keystroke the candidate list was waiting for.
    if (isImeComposing(e)) return;
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (!dir || e.ctrlKey || e.metaKey || e.altKey) return;
    const v = parseNumber(el.value);
    if (v === null) return;
    e.preventDefault();
    // Rounded only to strip float fuzz (0.1 + 0.2), never to three places: that
    // turned an inch field's 0.0625 into 1.063 on a single press.
    el.value = fmtNumber(round(v + dir * step, STEP_DECIMALS), STEP_DECIMALS);
    // The panels drive their live preview off these; a stepped value that never
    // announced itself would show one number and model another.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return el;
}

// --- display formatting ------------------------------------------------------
//
// Numbers are formatted for the ACTIVE LOCALE (Intl), but conservatively,
// because nearly every number this app shows is one the user can type straight
// back into the field it came from:
//
//   - NO GROUPING. `fmtNumber(1500)` is "1500", never "1,500" — a grouped
//     number read back through `parseNumber` would come out as 1.5, since one
//     separator in a dimension field is ALWAYS a decimal separator. Grouping is
//     for counts in prose, which is what `fmtCount` is for.
//   - LATIN DIGITS. The decimal separator follows the locale ("12,5" in de/fr);
//     the digit shapes do not. A field shows a value the user edits with an
//     ordinary keypad, and `parseNumber` reads Latin digits — printing
//     Arabic-Indic digits into it would break the round-trip.
//   - THREE DECIMALS by default, the same tolerance `round()` uses everywhere
//     else. A length in inches asks for four (see DECIMALS) by passing them.
//
// Formatters are cached: constructing an Intl.NumberFormat costs far more than
// using one, and these run per label per frame on the dimension overlay.

let fmtTag: string | null = null;
const plainFmts = new Map<number, Intl.NumberFormat>(); // keyed by max decimals
let countFmt: Intl.NumberFormat | null = null;

function formats(decimals = 3): { plain: Intl.NumberFormat; count: Intl.NumberFormat } {
  const tag = localeTag();
  if (tag !== fmtTag || !countFmt) {
    fmtTag = tag;
    plainFmts.clear();
    countFmt = new Intl.NumberFormat(tag, { maximumFractionDigits: 3 });
  }
  let plain = plainFmts.get(decimals);
  if (!plain) {
    plain = new Intl.NumberFormat(tag, { useGrouping: false, maximumFractionDigits: decimals, numberingSystem: "latn" });
    plainFmts.set(decimals, plain);
  }
  return { plain, count: countFmt };
}

/** A measurement/dimension as the active locale writes it: no grouping, Latin
 *  digits, up to `decimals` decimals (three by default). Use this for anything
 *  the user might type back — a field, a dimension badge, a measured length. */
export function fmtNumber(v: number, decimals = 3): string {
  if (!Number.isFinite(v)) return String(v); // NaN/Infinity: a diagnostic, not a number
  // -0 formats as "-0"; a dimension of minus nothing is not a thing.
  return formats(decimals).plain.format(v === 0 ? 0 : v);
}

/** A COUNT in a sentence — bodies, minutes, triangles. Grouped, because it is
 *  prose and nobody types it back. */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return formats().count.format(n === 0 ? 0 : n);
}

// --- input parsing -----------------------------------------------------------

// Space-like group separators (fr uses U+202F, several locales U+00A0) sitting
// BETWEEN digits. Dropped before parsing so a pasted "1 234,5" reads.
const INNER_SPACE = /(\d)[\s\u00a0\u202f\u2009](?=\d)/g;
const NUMERIC = /^([+-]?)([\d.,]+)(?:[eE]([+-]?\d+))?$/;
/** every separator followed by exactly three digits, e.g. "1.234.567" */
const ALL_GROUPS = /^\d{1,3}(?:[.,]\d{3})+$/;
/** a grouped INTEGER: one consistent separator, a first group of 1-3 digits and
 *  every later group exactly 3 — "1,234" and "1.234.567", not "1.2" or "1,23".
 *  This is everything that may sit before a decimal separator. */
const GROUPED_INT = /^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/;

/** Parse a typed number accepting EITHER decimal separator, in every locale.
 *  Returns null for anything that is not a bare number (an expression, a unit
 *  suffix, empty, garbage) — the callers that allow expressions ask
 *  `isPlainNumber` first and route the rest to the params engine.
 *
 *  THE RULES, and why:
 *
 *  - One separator is the DECIMAL separator, always. "12,5" and "12.5" are both
 *    12.5, and "1,500" is 1.5 — NOT 1500. A dimension field is where somebody
 *    types "1,5" a hundred times a day and where a thousands separator is
 *    vanishingly rare, so the ambiguity is resolved toward the common case.
 *    Guessing "group separator" there would silently multiply a value by 1000.
 *  - A TRAILING separator is dropped before any of this: nothing follows it, so
 *    it cannot be a decimal point. "1.5." is 1.5 and "12,5," is 12.5 — the
 *    answers parseFloat used to give. Dropping it first also means "1,500,"
 *    still takes the one-separator rule and reads 1.5.
 *  - Two or more separators can only be grouping plus (maybe) a decimal, since
 *    no number has two decimal points: the LAST one is the decimal separator
 *    ("1,234.5" and "1.234,5" are both 1234.5), unless every one of them is
 *    followed by exactly three digits, in which case they are all grouping
 *    ("1.234.567" is 1234567). Everything before that last separator must be a
 *    well-formed grouped integer, or the text is not a number in any locale and
 *    is REFUSED: "1.2.3", "3.14.15" and ",,5" return null rather than 12.3,
 *    314.15 and 0.5. Refusing matters as much as parsing — isPlainNumber is
 *    this function, so anything it accepts skips the params engine's checks.
 *  - Nothing this app DISPLAYS in an editable place is grouped (see fmtNumber),
 *    so read-back of a value the app printed always takes the first rule and
 *    always round-trips. The multi-separator rule is for text pasted in from
 *    somewhere else. */
export function parseNumber(raw: string): number | null {
  // NFKC first, and this is the whole reason it is here: with a Japanese IME in
  // kana mode, typing 12 produces the FULLWIDTH digits "１２" (U+FF11 U+FF12),
  // and a fullwidth comma or full stop for the separator. They look like digits
  // on screen and are not, so every one of these fields refused a number the
  // user could see they had typed. NFKC maps the fullwidth forms to ASCII and
  // leaves ordinary input untouched.
  const m = NUMERIC.exec(raw.normalize("NFKC").trim().replace(INNER_SPACE, "$1"));
  if (!m) return null;
  const [, sign = "", typed = "", exp] = m;
  if (!/\d/.test(typed)) return null; // "." / ",." — separators only
  // Trailing separators go first, before anything counts them: a separator with
  // no digits after it cannot be a decimal point, so "1.5." is 1.5, not 15.
  const body = typed.replace(/[.,]+$/, "");
  const seps = body.replace(/\d/g, "");
  let mantissa: string;
  if (seps.length === 0) mantissa = body;
  else if (seps.length === 1) mantissa = body.replace(",", ".");
  else if (seps === seps[0]!.repeat(seps.length) && ALL_GROUPS.test(body)) mantissa = body.replace(/[.,]/g, "");
  else {
    const cut = Math.max(body.lastIndexOf("."), body.lastIndexOf(","));
    const head = body.slice(0, cut);
    // What precedes the decimal separator has to be grouping, and grouping has a
    // shape. Without this test "1.2.3" reads as 12.3 and "3.14.15" as 314.15 —
    // silently, and 100x too deep once it reaches a feature.
    const grouped = GROUPED_INT.exec(head);
    if (!grouped) return null;
    // ...and the decimal separator has to be the OTHER character. No locale
    // writes a group and a decimal with the same mark, so "1.234.56" is not a
    // number in any of them — it is a slip. Reading it as 1234.56 (which the
    // shape test alone allows, because "1.234" is a perfectly good group) is a
    // silent 1000x on a dimension, the exact failure this whole rule exists to
    // prevent.
    if (grouped[1] === body[cut]) return null;
    mantissa = `${head.replace(/[.,]/g, "")}.${body.slice(cut + 1)}`;
  }
  const v = Number(`${sign}${mantissa}${exp ? `e${exp}` : ""}`);
  return Number.isFinite(v) ? v : null;
}

/** parse a typed field back to mm (length) or degrees (angle); null if invalid */
export function parseField(raw: string, kind: FieldKind = "length"): number | null {
  const v = parseNumber(raw);
  if (v == null) return null;
  return kind === "length" ? fromDisplay(v) : v; // angle/count: raw number
}

/** The document's parameters, for expressions typed into a field (`wall*2`).
 *  Set once from main.ts rather than threaded through the dozen tools that
 *  open a dimension box or a panel; unset means "no names", so bare arithmetic
 *  still works and a named expression is refused. */
let paramsProvider: () => Record<string, number> = () => ({});
export function setFieldParams(fn: () => Record<string, number>) {
  paramsProvider = fn;
}
export function fieldParams(): Record<string, number> {
  return paramsProvider();
}

/** A typed field that may be an EXPRESSION (`31.53+2*1.62`, `1/16`,
 *  `wall*2`), back to mm/deg. Null when it is not a number the app can read.
 *
 *  This exists because a dimension box used to read only a bare number: an
 *  expression was refused (or, before parseNumber, silently truncated to its
 *  leading number, so `31.53+2*1.62` became 31.53). A wrong dimension is worse
 *  than a refused one, so anything this cannot evaluate is null, never a guess.
 *
 *  The unit rule is fieldExpr's; see there. */
export function parseFieldExpr(
  raw: string,
  kind: FieldKind = "length",
  params: Record<string, number> = {},
): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (isPlainNumber(s)) return parseField(s, kind);
  const expr = fieldExpr(s, kind);
  if (expr === null) return null;
  try {
    const v = evalExpr(expr, params);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null; // unknown name, bad arity: "not a number", like any other typo
  }
}

/** Typed field text as the expression the parameters engine must evaluate to
 *  get what the user MEANT. Null for text that does not parse at all. A comma
 *  decimal is normalised first (canonicalDecimal).
 *
 *  THE UNIT RULE. The parameters engine is canonical: a bare literal is mm or
 *  degrees, so a saved expression means the same on every machine. A field the
 *  user types into is not: a plain `2` there is 2 of the DISPLAY unit. Arithmetic
 *  has to agree with the plain number typed into the same box a moment earlier,
 *  or an inch user typing `1/16` gets a sixteenth of a MILLIMETRE (0.0625 mm,
 *  found in the sketch dimension editor 2026-10-02). So:
 *
 *   - Arithmetic that names no parameter reads in the DISPLAY unit: `1/16` in
 *     inches is 1/16 inch, `2+3` in cm is 5 cm. Functions and PI are arithmetic.
 *   - A unit written once at the END applies to the WHOLE of that arithmetic:
 *     `1/16 in` is a sixteenth of an inch. The engine binds a suffix to the
 *     literal before it, which made that 1/(16 in), a reciprocal length.
 *   - Anything naming a parameter (`wall*2`) reads CANONICAL, as the engine
 *     does: a parameter's value is already in mm, and converting the literals
 *     around it would scale half the expression and not the other half. So
 *     does arithmetic whose literals carry their own units (`1 in + 2 mm`).
 *
 *  What comes back is always something the ENGINE evaluates to that reading,
 *  because a sketch dimension STORES what is typed as a parameter expression
 *  and re-evaluates it on every rebuild. Where the engine already reads the typed
 *  text the same way (every millimetre case, `5 in`) the text is kept as
 *  typed; otherwise it is rewritten with the unit made explicit, `1/16` in
 *  inches becoming `(1/16)*1 in`. */
export function fieldExpr(raw: string, kind: FieldKind = "length"): string | null {
  const s = canonicalDecimal(raw.trim());
  const bare = bareArithmetic(s, kind);
  if (!bare) {
    try {
      parseExpr(s);
    } catch {
      return null;
    }
    return s;
  }
  const unit = bare.unit ?? (kind === "length" ? current : null);
  if (unit === null) return s; // an angle or count: nothing to convert
  const factor = UNITS[unit]!.factor;
  const meant = evalNode(bare.ast, {}) * factor;
  let asTyped = NaN;
  try {
    asTyped = evalExpr(s, {});
  } catch {
    /* the engine cannot read it as typed, `(1+1) in` say: rewrite */
  }
  // The engine computes (body) * (1 * factor), which is the same two IEEE
  // operations as `meant`, so the rewrite evaluates to `meant` exactly.
  if (asTyped === meant) return s;
  return `(${bare.body})*1 ${unit}`;
}

/** Typed dimension text as the expression a sketch STORES for it: what the
 *  user meant, spelled so the parameters engine evaluates it the same on every
 *  rebuild (fieldExpr). In inches `1/16` was a sixteenth of a MILLIMETRE,
 *  because the engine reads a bare literal in mm, and `1/16 in` was 1/(16 in).
 *  A `name=` prefix is kept; text that does not parse goes through untouched,
 *  so the engine's own message is the one shown. Shared by the canvas label
 *  and the parameters panel, which store the same dimension. */
export function storedDimExpr(raw: string, kind: FieldKind): string {
  const nv = splitNameValue(raw);
  const expr = fieldExpr(nv ? nv.expr : raw, kind);
  if (expr === null) return raw;
  return nv ? `${nv.name}=${expr}` : expr;
}

/** `s` as arithmetic that names no parameter: the AST of everything before an
 *  optional trailing unit suffix, that suffix, and the text it applies to. Null
 *  when `s` names a parameter, carries a unit anywhere but the end, carries a
 *  unit of the wrong kind for the field, or does not parse. */
function bareArithmetic(s: string, kind: FieldKind): { ast: ExprNode; body: string; unit: string | null } | null {
  let toks;
  try {
    toks = tokenize(s);
  } catch {
    return null;
  }
  const last = toks[toks.length - 1];
  let body = s;
  let unit: string | null = null;
  if (last?.kind === "ident" && last.name in UNITS && toks.length > 1) {
    const before = toks[toks.length - 2]!;
    // `2*in` is not a sixteenth of anything; only a suffix directly after a
    // number or a closing bracket is one
    if (before.kind === "op" && before.op !== ")") return null;
    unit = last.name;
    body = s.slice(0, last.start).trim();
    const want = kind === "angle" ? "angle" : kind === "length" ? "length" : null;
    if (UNITS[unit]!.dim !== want) return null;
  }
  let ast: ExprNode;
  try {
    ast = parseExpr(body);
  } catch {
    return null;
  }
  if (refsOfNode(ast).length || hasUnitTag(ast)) return null;
  return { ast, body, unit };
}

function hasUnitTag(n: ExprNode): boolean {
  switch (n.t) {
    case "num": return n.unit !== undefined;
    case "ref": return false;
    case "call": return n.args.some(hasUnitTag);
    case "bin": return hasUnitTag(n.l) || hasUnitTag(n.r);
    case "neg": return hasUnitTag(n.e);
  }
}

/** Is a typed dimension value one this dim can hold? A length is a magnitude
 *  and must be positive; an angle may be any finite value.
 *
 *  `signed` is the third case, and the reason this lives in one place rather
 *  than at each input: the smart tool's horizontal/vertical distances store the
 *  SIGN of the gap (types.ts — the operand order IS the sign), so their badge
 *  really reads "-30 mm" and the user must be able to type that back, and to
 *  type "30" to move the point to the other side (dimensionTool.p2pPlan). Zero
 *  is still refused, for these harder than for a plain length: constraintDims
 *  drops a dim whose two anchors coincide, so a committed 0 leaves a dimension
 *  with no badge — invisible, and back to being undeletable.
 *
 *  Both edit paths ask this — the plain-number one in the label editor and the
 *  expression one in SketchMode — because a dim that accepts "-30" typed and
 *  rejects the parameter that evaluates to it is worse than either rule alone. */
export function dimValueOk(v: number | null | undefined, kind: FieldKind, signed = false): v is number {
  if (v == null || !Number.isFinite(v)) return false;
  if (kind === "angle") return true;
  return signed ? v !== 0 : v > 0;
}

/** A plain numeric literal (display-unit semantics at input surfaces) as
 *  opposed to an expression (canonical-unit semantics via the params engine).
 *  "5.0", "5,0" and "-2e3" are plain; "5 mm", "width/2", "5+3" are expressions.
 *  One predicate, one parser: whatever `parseNumber` can read is plain. */
export function isPlainNumber(raw: string): boolean {
  return parseNumber(raw) !== null;
}

/** A typed string rewritten with the "." the EXPRESSION language uses.
 *
 *  The params grammar is deliberately dot-only and semicolon-separated
 *  (params/parse.ts) so a saved document means the same thing on every machine.
 *  Fields that accept an expression still have to accept "12,5" from a
 *  comma-decimal user, so the comma is normalised here, at the input boundary,
 *  and never inside the grammar. A comma cannot mean anything else in an
 *  expression — it is not an operator and not an argument separator — so a
 *  comma between two digits is unambiguously a decimal point. */
export function canonicalDecimal(raw: string): string {
  const plain = parseNumber(raw);
  if (plain !== null) return String(plain);
  return raw.replace(/(\d),(?=\d)/g, "$1.");
}

// --- typed-field helpers, shared by the tool panels --------------------------
//
// These lived in three copies (texturePanel, sketch textPanel, textOnFacePanel)
// the day they were written, which is the point at which they belong here
// instead. They encode ONE rule between them: a field the user typed into and
// the app cannot read must never quietly become a default.

/** The number in `el`, or `dflt` when the field is EMPTY.
 *
 *  `??`, never `||`: with `||` a typed zero is falsy and takes the default, so
 *  "0" silently became 10, and the user had no way to type a zero at all. */
export function typedNumber(el: { value: string }, dflt: number): number {
  return parseNumber(el.value) ?? dflt;
}

/** True when the user typed something into `el` that must not reach geometry.
 *
 *  Two cases, and empty is neither: a cleared field means "leave it at the
 *  default", which is what a default is for.
 *   - unreadable ("3.14.15", "1.2.3" — parseNumber refuses those rather than
 *     guessing 314.15 and 12.3), or
 *   - readable but not legal for the field. `positive` is the case that
 *     matters: a text height of 0 or less SEGFAULTS OCCT (exit 139, uncatchable
 *     — see _text_faces in sidecar/builder.py), and the live preview calls into
 *     it on every render, so "0" typed as the first character of "0.5" used to
 *     take the geometry engine down. */
export function badNumberField(el: { value: string }, positive = false): boolean {
  const raw = el.value.trim();
  if (raw === "") return false;
  const v = parseNumber(raw);
  if (v === null) return true;
  return positive && !(v > 0);
}
