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

function readStored(): Unit {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(KEY)) as Unit | null;
  return v === "mm" || v === "cm" || v === "in" ? v : "mm";
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

export type FieldKind = "length" | "angle";

/** numeric value to show in a field: angles stay in degrees, lengths convert */
export function displayValue(mm: number, kind: FieldKind = "length"): number {
  return kind === "angle" ? round(mm) : round(toDisplay(mm));
}

/** parse a typed field back to mm (length) or degrees (angle); null if invalid */
export function parseField(raw: string, kind: FieldKind = "length"): number | null {
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return null;
  return kind === "angle" ? v : fromDisplay(v);
}
