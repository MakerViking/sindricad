// Display/input units. Geometry is ALWAYS stored in millimetres internally
// (build123d's base unit; correct for STL/STEP/3MF export and 3D printing).
// The unit setting only converts what the user sees and types — lengths shown
// in the dialog/inspector are divided by the factor, typed values multiplied
// back to mm. Angles are always degrees and never converted.

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

/** mm -> rounded display string with the unit suffix (e.g. "40 mm") */
export function fmtLength(mm: number): string {
  return `${round(toDisplay(mm))} ${current}`;
}

export function round(v: number): number {
  return Math.round(v * 1000) / 1000;
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
export type { FieldKind };

/** numeric value to show in a field: angles stay in degrees, lengths convert */
export function displayValue(mm: number, kind: FieldKind = "length"): number {
  return kind === "length" ? round(toDisplay(mm)) : round(mm); // angle/count: raw
}

/** parse a typed field back to mm (length) or degrees (angle); null if invalid */
export function parseField(raw: string, kind: FieldKind = "length"): number | null {
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return null;
  return kind === "length" ? fromDisplay(v) : v; // angle/count: raw number
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
 *  "5.0" and "-2e3" are plain; "5 mm", "width/2", "5+3" are expressions. */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
export function isPlainNumber(raw: string): boolean {
  return PLAIN_NUMBER.test(raw.trim());
}
