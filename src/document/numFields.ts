// The single inventory of parameter-drivable numeric fields: which fields on a
// feature (and on the solver-rigid sketch entities) hold a `Num`, what kind of
// quantity each is, and how the inspector labels it. Consumed by the inspector
// (field editors), the load migration (bare-name → model-param conversion), and
// the parameters engine (target read/write + unit coercion).

import type { CadDocument, Feature, ParamTarget, ParamUnit, SketchEntity, SketchPattern } from "../types";
import { isDimConstraint } from "../sketch/id";

/** What kind of quantity a numeric field holds — drives display-unit conversion
 *  (lengths mm↔display), suffixes (° / mm), and parameter unit coercion.
 *  Defined here (document layer); ui/units.ts re-exports it for its consumers. */
export type FieldKind = "length" | "angle" | "count";

/** [field, label, kind] rows per feature type. */
export const FEATURE_NUM_FIELDS: Partial<Record<Feature["type"], [string, string, FieldKind][]>> = {
  extrude: [["distance", "Distance", "length"]],
  fillet: [["radius", "Radius", "length"]],
  chamfer: [["distance", "Length", "length"]],
  "press-pull": [["distance", "Distance", "length"]],
  revolve: [["angle", "Angle", "angle"]],
  datumPlane: [["offset", "Offset", "length"]],
  box: [["length", "Length", "length"], ["width", "Width", "length"], ["height", "Height", "length"]],
  cylinder: [["radius", "Radius", "length"], ["height", "Height", "length"]],
  sphere: [["radius", "Radius", "length"]],
  shell: [["thickness", "Thickness", "length"]],
  draft: [["angle", "Angle", "angle"]],
  patternRect: [["countX", "Count X", "count"], ["countY", "Count Y", "count"], ["spacingX", "Spacing X", "length"], ["spacingY", "Spacing Y", "length"]],
  patternCircular: [["count", "Count", "count"], ["angle", "Angle", "angle"]],
  simplifyMesh: [["tolerance", "Angle tol", "angle"]],
  cleanUp: [["tolerance", "Tolerance", "length"]],
  scale: [["factor", "Factor", "count"]],
  move: [["dx", "Move X", "length"], ["dy", "Move Y", "length"], ["dz", "Move Z", "length"], ["rx", "Rotate X", "angle"], ["ry", "Rotate Y", "angle"], ["rz", "Rotate Z", "angle"]],
  texture: [["depth", "Depth", "length"], ["scale", "Scale", "length"], ["angle", "Angle", "angle"], ["offset", "Offset", "length"], ["sharpness", "Sharpness", "count"], ["seed", "Seed", "count"]],
};

/** Numeric fields on the solver-RIGID parametric shapes (the solver never writes
 *  these, so a parameter may own them directly). Solved geometry (lines, circles,
 *  rectangles…) is parameter-driven through a dimension constraint instead — the
 *  solver overwrites raw coordinates every pump. */
export const RIGID_ENTITY_NUM_FIELDS: Partial<Record<SketchEntity["type"], [string, FieldKind][]>> = {
  polygon: [["x", "length"], ["y", "length"], ["radius", "length"], ["sides", "count"], ["angle", "angle"]],
  slot: [["x1", "length"], ["y1", "length"], ["x2", "length"], ["y2", "length"], ["width", "length"]],
  text: [["x", "length"], ["y", "length"], ["height", "length"], ["angle", "angle"], ["positionOnPath", "count"], ["boxWidth", "length"]],
};

/** Canonical unit of a field kind (lengths mm, angles degrees, counts raw). */
export function kindUnit(kind: FieldKind): ParamUnit {
  return kind === "length" ? "mm" : kind === "angle" ? "deg" : "count";
}

/** Numeric fields on sketch patterns. */
export const PATTERN_NUM_FIELDS: Record<SketchPattern["type"], [string, FieldKind][]> = {
  patternRect: [["countX", "count"], ["countY", "count"], ["spacingX", "length"], ["spacingY", "length"]],
  patternCircular: [["cx", "length"], ["cy", "length"], ["count", "count"], ["angle", "angle"]],
  hexHoles: [["cx", "length"], ["cy", "length"], ["diameter", "length"], ["spacing", "length"], ["rings", "count"]],
  honeycomb: [["cx", "length"], ["cy", "length"], ["diameter", "length"], ["spacing", "length"], ["rings", "count"]],
  boltCircle: [["cx", "length"], ["cy", "length"], ["bcd", "length"], ["count", "count"], ["diameter", "length"]],
  gridHoles: [["cx", "length"], ["cy", "length"], ["diameter", "length"], ["countX", "count"], ["countY", "count"], ["spacingX", "length"], ["spacingY", "length"]],
};

/** Integer-only fields (a subset of the "count" kind — which also holds real-
 *  valued unitless fields like texture sharpness or a scale factor) and their
 *  minimum legal value. A parameter write coerces through this. */
export const INT_FIELDS: Record<string, number> = {
  sides: 3,
  count: 1,
  countX: 1,
  countY: 1,
  rings: 1,
  seed: -Infinity,
};

/** String-typed Feature/SketchEntity fields that can NEVER hold a bare
 *  parameter name — the skip-set for the legacy bare-name scans in the params
 *  engine. Keep in sync when a new string field lands on either union. */
export const NON_NUM_STRING_FIELDS = new Set([
  "id", "type", "name", "operation", "font", "style", "align", "text", "pathRef",
  "plane", "sketch", "axis", "profile", "path", "direction", "body", "imagePath", "solid",
]);

/** A parameter target resolved to the live object holding the number. */
export interface ResolvedTarget {
  holder: Record<string, unknown>;
  field: string;
  kind: FieldKind;
  /** id of the sketch feature this value lives in (undefined for feature fields
   *  outside sketches) — the re-solve cascade keys off it. */
  sketch?: string;
}

/** Find the object+field a ParamTarget points at, or null if it no longer
 *  exists (deleted feature/entity/constraint — the caller decides what a
 *  dangling binding means). */
export function resolveTarget(doc: CadDocument, target: ParamTarget): ResolvedTarget | null {
  const sketchOf = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    return f && f.type === "sketch" ? f : null;
  };
  switch (target.kind) {
    case "feature": {
      const f = doc.features.find((x) => x.id === target.feature);
      const row = f && FEATURE_NUM_FIELDS[f.type]?.find(([field]) => field === target.field);
      if (!f || !row) return null;
      return { holder: f as unknown as Record<string, unknown>, field: target.field, kind: row[2] };
    }
    case "constraint": {
      const f = sketchOf(target.sketch);
      const c = f?.constraints?.find((k) => isDimConstraint(k) && k.id === target.constraint);
      if (!c) return null;
      return {
        holder: c as unknown as Record<string, unknown>,
        field: "value",
        kind: c.type === "angle" ? "angle" : "length",
        sketch: target.sketch,
      };
    }
    case "entity": {
      const f = sketchOf(target.sketch);
      const e = f?.entities.find((x) => x.id === target.entity);
      const row = e && RIGID_ENTITY_NUM_FIELDS[e.type]?.find(([field]) => field === target.field);
      if (!e || !row) return null;
      return { holder: e as unknown as Record<string, unknown>, field: target.field, kind: row[1], sketch: target.sketch };
    }
    case "pattern": {
      const f = sketchOf(target.sketch);
      const p = f?.patterns?.find((x) => x.id === target.pattern);
      const row = p && PATTERN_NUM_FIELDS[p.type]?.find(([field]) => field === target.field);
      if (!p || !row) return null;
      return { holder: p as unknown as Record<string, unknown>, field: target.field, kind: row[1], sketch: target.sketch };
    }
  }
}

/** Coerce an evaluated value for its destination field (integer fields round
 *  and clamp to their minimum). */
export function coerceForField(field: string, value: number): number {
  const min = INT_FIELDS[field];
  if (min === undefined) return value;
  return Math.max(min, Math.round(value));
}

/** Write an evaluated parameter value into its target field. Returns the
 *  affected sketch id (for the re-solve cascade) or null when the target is
 *  gone or the value didn't change. Non-finite values are never written. */
export function writeTarget(doc: CadDocument, target: ParamTarget, value: number): { sketch?: string } | null {
  if (!Number.isFinite(value)) return null;
  const rt = resolveTarget(doc, target);
  if (!rt) return null;
  const v = coerceForField(rt.field, value);
  if (rt.holder[rt.field] === v) return null;
  rt.holder[rt.field] = v;
  return rt.sketch !== undefined ? { sketch: rt.sketch } : {};
}
