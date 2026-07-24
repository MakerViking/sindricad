// The single inventory of parameter-drivable numeric fields: which fields on a
// feature (and on the solver-rigid sketch entities) hold a `Num`, what kind of
// quantity each is, and how the inspector labels it. Consumed by the inspector
// (field editors), the load migration (bare-name → model-param conversion), and
// the parameters engine (target read/write + unit coercion).

import type { Feature, ParamUnit, SketchEntity } from "../types";

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
