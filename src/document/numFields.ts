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

/** [field, label, kind] — plus an optional `applies` predicate for a row that
 *  only exists in some shapes of the feature. The inspector skips a row whose
 *  predicate says no; every other consumer (migration, the params engine) reads
 *  the first three slots and is unaffected. */
export type NumFieldRow = [string, string, FieldKind] | [string, string, FieldKind, (f: Feature) => boolean];

/** The depth a fresh extrude starts at, in mm — and the depth a feature falls
 *  back to when its up-to target is cleared (an up-to extrude never read
 *  `distance`, so it can legitimately be 0, and the sidecar refuses a blind
 *  extrude of 0). It lives here, in the document layer, so the extrude tool and
 *  the store can share ONE number: the store cannot import the tool without
 *  pulling the whole viewport stack into the document layer. */
export const DEFAULT_EXTRUDE_DISTANCE = 10;

/** A press/pull or an extrude only honours `upToOffset` when it HAS an up-to
 *  target — without one the sidecar extrudes the plain distance and the offset is
 *  ignored, so the row was an input that swallowed the number and changed nothing
 *  (field report, bug #88). The wire refuses that combination too; this keeps the
 *  user from typing into it in the first place.
 *
 *  Exported because the inspector also decides from it whether to offer the
 *  "Up to" row and its clear button (GH #41). */
export function hasUpToTarget(f: Feature): boolean {
  return (
    (f.type === "press-pull" || f.type === "extrude") &&
    (f.upTo !== undefined || f.upToPlane !== undefined)
  );
}

/** A taper is only swept when the extrude goes a DISTANCE. With an up-to target
 *  the end face IS the target plane, so the sidecar does not apply one — and an
 *  input that swallows a number and changes nothing is the defect this file's
 *  `applies` predicate exists to prevent. */
function isBlindExtrude(f: Feature): boolean {
  return f.type === "extrude" && f.upTo === undefined && f.upToPlane === undefined;
}

/** [field, label, kind] rows per feature type. */
export const FEATURE_NUM_FIELDS: Partial<Record<Feature["type"], NumFieldRow[]>> = {
  // "Start offset" lifts the profile off its sketch plane before the sweep;
  // "Target offset" is measured along the EXTRUDE direction and only means
  // anything with an up-to target (see hasUpToTarget). Distance stays offered
  // even with a target set — the sidecar ignores it there, but clearing the
  // target has to restore a depth rather than drop the user at 0.
  extrude: [
    ["distance", "Distance", "length"],
    ["startOffset", "Start offset", "length"],
    ["taper", "Taper", "angle", isBlindExtrude],
    ["upToOffset", "Target offset", "length", hasUpToTarget],
  ],
  fillet: [["radius", "Radius", "length"]],
  chamfer: [["distance", "Length", "length"]],
  // "Target offset" is measured along the EXTRUDE direction, not the target's
  // normal: positive pushes past the up-to target, negative stops short.
  "press-pull": [["distance", "Distance", "length"], ["upToOffset", "Target offset", "length", hasUpToTarget]],
  revolve: [["angle", "Angle", "angle"]],
  datumPlane: [["offset", "Offset", "length"]],
  box: [["length", "Length", "length"], ["width", "Width", "length"], ["height", "Height", "length"]],
  cylinder: [["radius", "Radius", "length"], ["height", "Height", "length"]],
  sphere: [["radius", "Radius", "length"]],
  shell: [["thickness", "Thickness", "length"]],
  offsetFace: [["distance", "Distance", "length"]],
  thicken: [["thickness", "Thickness", "length"]],
  draft: [["angle", "Angle", "angle"]],
  patternRect: [["countX", "Count X", "count"], ["countY", "Count Y", "count"], ["spacingX", "Spacing X", "length"], ["spacingY", "Spacing Y", "length"]],
  patternCircular: [["count", "Count", "count"], ["angle", "Angle", "angle"]],
  simplifyMesh: [["tolerance", "Angle tol", "angle"]],
  cleanUp: [["tolerance", "Tolerance", "length"]],
  scale: [["factor", "Factor", "count"]],
  move: [["dx", "Move X", "length"], ["dy", "Move Y", "length"], ["dz", "Move Z", "length"], ["rx", "Rotate X", "angle"], ["ry", "Rotate Y", "angle"], ["rz", "Rotate Z", "angle"]],
  texture: [["depth", "Depth", "length"], ["scale", "Scale", "length"], ["angle", "Angle", "angle"], ["offset", "Offset", "length"], ["sharpness", "Sharpness", "count"], ["boundaryInset", "Edge blend", "length"], ["seed", "Seed", "count"]],
  textOnFace: [["height", "Text size", "length"], ["depth", "Depth", "length"], ["bevel", "Bevel", "length"], ["angle", "Angle", "angle"], ["boxWidth", "Box width", "length"], ["u", "Across", "length"], ["v", "Up", "length"]],
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
  "bevelStyle", "upToPlane",
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

/** Fields the document does not HAVE when their row's `applies` predicate is
 *  false, as opposed to merely hiding. The distinction is the sidecar's: it
 *  REFUSES an `upToOffset` with no target to offset from, while it silently
 *  ignores a `taper` under one — so only the first is a dangling binding when
 *  its predicate turns false. `resolveTarget` is what params.recompute uses to
 *  decide whether to garbage-collect a parameter, so widening this set deletes
 *  user-authored bindings. */
const ILLEGAL_WHEN_INAPPLICABLE = new Set<string>(["upToOffset"]);

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
      // A row whose value is ILLEGAL without its predicate is not a field the
      // document has — matching on the name alone let a parameter bound to
      // `upToOffset` keep resolving after the up-to target was cleared, and the
      // recompute inside every mutate then wrote the orphan offset straight
      // back onto the feature (which the sidecar refuses to build).
      //
      // Scoped to those fields rather than to every row with a predicate. An
      // `applies` predicate is a RENDER gate — most of them mean "hidden right
      // now", not "gone". `taper` carries one, and treating it as an existence
      // test made params.recompute read a taper binding as dangling the moment
      // the extrude gained a target: it deleted the user's parameter silently,
      // clearing the target again did not bring it back, and a parameter that
      // something else referenced was stamped "its dimension or feature no
      // longer exists" about a feature sitting in the timeline. A taper under
      // an up-to target is merely IGNORED by the sidecar, never refused, so the
      // binding is free to keep resolving.
      if (ILLEGAL_WHEN_INAPPLICABLE.has(target.field)) {
        const applies = row[3];
        if (applies && !applies(f)) return null;
      }
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
 *  gone or the value didn't change. Non-finite values are never written.
 *
 *  A value-changing write REPLACES the owning feature in `doc.features` with a
 *  shallow copy. The wire delta (geometry/client.ts) ships a feature only when
 *  its object reference differs from the one last sent, so a number poked into
 *  the existing object rebuilt against a document the encoder saw as
 *  unchanged: the sidecar kept the old value until a timeline scrub or Compute
 *  All forced a full send (field reports c2cac5f3, f39f6e08, ed1d4d98,
 *  8d09f11b). Every writer of a numeric field goes through here, the inspector
 *  and the parameter recompute alike, so this is the one place the contract
 *  has to hold. */
export function writeTarget(doc: CadDocument, target: ParamTarget, value: number): { sketch?: string } | null {
  if (!Number.isFinite(value)) return null;
  const rt = resolveTarget(doc, target);
  if (!rt) return null;
  const v = coerceForField(rt.field, value);
  if (rt.holder[rt.field] === v) return null;
  rt.holder[rt.field] = v;
  const ownerId = target.kind === "feature" ? target.feature : target.sketch;
  const i = doc.features.findIndex((f) => f.id === ownerId);
  if (i >= 0) doc.features[i] = { ...doc.features[i] } as Feature;
  return rt.sketch !== undefined ? { sketch: rt.sketch } : {};
}
