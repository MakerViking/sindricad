// The dimensions of one sketch as the parameters panel LISTS them: one row per
// dimension the canvas shows a value for, each with a name a person can match
// to the drawing ("Rectangle 1 · Width", "Arc 2 · Radius").
//
// Two sources, the same two the canvas draws from. Every entity badge
// (entityDims: a rectangle's W/H, a line's length, a circle's diameter, a
// polygon's radius, a slot's L/W), and every dimension CONSTRAINT that is not
// already one of those badges (constraintDims: radius, an arc's diameter,
// angle, the point and rim distances, offset). The panel used to list only the
// first, so a dimension placed on an arc never appeared there at all (report
// cac30e98), and every row read "Width" or "Length" with nothing to say whose
// (report 9e9ae278).
//
// Pure: the panel lists a closed sketch from the document and the open one from
// the live session through the same function, so the two cannot disagree about
// what is listed or what it is called.

import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { DimField, SketchConstraint } from "../types";
import { isDriven } from "../types";
import { constraintDims, entityDims } from "./entityDims";
import { isDimConstraint } from "./id";
import { ORIGIN_X_ID, ORIGIN_Y_ID, isOriginGeometry, isOriginId } from "./origin";

/** Where an edit of a listed dimension goes. An entity badge is addressed by
 *  entity id and field (and its place in the list, for an entity saved before
 *  entities had ids); a constraint by its id when it has one, else by its
 *  index (a constraint saved before dimensions carried ids). */
export type DimRowRef =
  | { kind: "entity"; id: string; index: number; field: DimField }
  | { kind: "constraint"; index: number; id?: string };

export interface SketchDimRow {
  /** Names the same dimension on the panel and on the canvas (the label a
   *  row lights up): `e:<entity>:<field>`, `c:<constraint id>`, or `k:<index>`
   *  for a constraint with no id. */
  key: string;
  ref: DimRowRef;
  /** Whose dimension: "Rectangle 1", or "Line 1 to Line 2" for one between two. */
  subject: string;
  /** What it measures: "Width", "Radius", "Angle". */
  dim: string;
  /** Its one entity is construction geometry (the label says so). */
  construction: boolean;
  /** The entities it measures, by id: what the canvas highlights for this row,
   *  and what a canvas selection is matched against. */
  entities: string[];
  /** mm, or degrees for an angle. A reference dimension's is what it measures. */
  valueMm: number;
  kind: "length" | "angle";
  /** A reference (driven) dimension: it measures and holds nothing. */
  driven: boolean;
  /** Its value carries a sign that means something (the X/Y distances). */
  signed: boolean;
}

/** The label key of an entity badge, shared with the canvas labels. */
export const entityDimKey = (id: string, field: DimField): string => `e:${id}:${field}`;
/** The label key of a constraint dimension, shared with the canvas labels. */
export const constraintDimKey = (c: SketchConstraint, index: number): string => {
  const id = (c as { id?: string }).id;
  return id ? `c:${id}` : `k:${index}`;
};

/** Entities that are never listed or counted: the origin and its axes exist
 *  only in an open sketch, so counting them would number a reopened sketch's
 *  lines differently from the closed one. Ids the app reserves start "__". */
const unlisted = (id: string) => isOriginGeometry(id) || id.startsWith("__");

/** The catalogue key naming each entity type ("Rectangle {n}"). A record
 *  over the type, so a new entity type cannot be added without its name. */
const ENTITY_NAME: Record<ResolvedEntity["type"], string> = {
  line: "inspector.sketchDim.entity.line",
  circle: "inspector.sketchDim.entity.circle",
  arc: "inspector.sketchDim.entity.arc",
  rectangle: "inspector.sketchDim.entity.rectangle",
  polygon: "inspector.sketchDim.entity.polygon",
  slot: "inspector.sketchDim.entity.slot",
  spline: "inspector.sketchDim.entity.spline",
  point: "inspector.sketchDim.entity.point",
  text: "inspector.sketchDim.entity.text",
  projected: "inspector.sketchDim.entity.projected",
};

/** "Rectangle 1", "Line 2": each entity's type and its place among the
 *  sketch's entities of that type, in drawing order. Construction geometry is
 *  counted with the rest, so making a line construction does not renumber the
 *  others. A type this build does not know (a newer build's document) is
 *  named by its own type word. */
export function entityNames(entities: readonly ResolvedEntity[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const e of entities) {
    if (unlisted(e.id)) continue;
    const n = (seen.get(e.type) ?? 0) + 1;
    seen.set(e.type, n);
    const key = ENTITY_NAME[e.type] as string | undefined;
    out.set(e.id, key ? t(key, { n }) : `${e.type} ${n}`);
  }
  return out;
}

/** The entities a dimension constraint is between, in its own operand order. A
 *  rectangle's side (`R~2`), a polygon's or a slot's, names its shape. */
function operands(c: SketchConstraint): string[] {
  switch (c.type) {
    case "distance": return [c.line];
    case "diameter": return [c.circle];
    case "radius": return [c.e];
    case "angle": return [c.l1, c.l2];
    case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY": return [c.e1, c.e2];
    case "p2lDistance": return [c.e, c.line];
    case "radialGap": return [c.inner, c.outer];
    case "c2cDistance": return [c.c1, c.c2];
    case "c2lDistance": return [c.circle, c.line];
    case "p2cDistance": return [c.e, c.circle];
    case "offset": return c.pairs.flatMap((p) => [p.src, p.cpy]);
    default: return [];
  }
}

const shapeOf = (id: string) => (id.includes("~") ? id.slice(0, id.indexOf("~")) : id);

/** What a dimension constraint measures, in words. */
function constraintWord(c: SketchConstraint): string {
  switch (c.type) {
    case "distance": return t("common.length");
    case "diameter": return t("common.diameter");
    case "radius": return t("common.radius");
    case "angle": return t("common.angle");
    case "p2pDistanceX": return t("inspector.sketchDim.kind.horizontal");
    case "p2pDistanceY": return t("inspector.sketchDim.kind.vertical");
    case "radialGap": return t("inspector.sketchDim.kind.radialGap");
    case "offset": return t("inspector.sketchDim.kind.offset");
    case "p2pDistance": case "p2lDistance": case "c2cDistance": case "c2lDistance": case "p2cDistance":
      return t("inspector.sketchDim.kind.distance");
    default: return t("inspector.sketchDim.kind.dimension");
  }
}

/** Is this constraint already listed as an entity's badge? A line's length and
 *  a circle's diameter, and a rectangle's locked width or height (a `distance`
 *  on one of its sides), show their value on the entity's own badge, as they
 *  do on the canvas. Everything else is a row of its own. */
function shownAsBadge(c: SketchConstraint, byId: Map<string, ResolvedEntity>): boolean {
  if (c.type === "diameter") return byId.get(c.circle)?.type === "circle";
  if (c.type !== "distance") return false;
  const cut = c.line.indexOf("~");
  if (cut < 0) return byId.get(c.line)?.type === "line";
  return byId.get(c.line.slice(0, cut))?.type === "rectangle";
}

/** Every dimension of a sketch, in the order the panel lists them: the
 *  entities' badges in drawing order, then the dimension constraints in the
 *  order they were made. */
export function sketchDimRows(entities: readonly ResolvedEntity[], constraints: readonly SketchConstraint[]): SketchDimRow[] {
  const names = entityNames(entities);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nameOf = (id: string): string => {
    const base = shapeOf(id);
    if (isOriginId(base)) return t("inspector.sketchDim.origin");
    if (base === ORIGIN_X_ID) return t("inspector.sketchDim.xAxis");
    if (base === ORIGIN_Y_ID) return t("inspector.sketchDim.yAxis");
    return names.get(base) ?? base;
  };
  const rows: SketchDimRow[] = [];
  entities.forEach((e, index) => {
    if (unlisted(e.id)) return;
    for (const d of entityDims(e)) {
      rows.push({
        key: entityDimKey(e.id, d.field),
        ref: { kind: "entity", id: e.id, index, field: d.field },
        subject: nameOf(e.id),
        dim: d.label,
        construction: e.construction === true,
        entities: [e.id],
        valueMm: d.valueMm,
        kind: "length",
        driven: false,
        signed: false,
      });
    }
  });
  // What the canvas shows each constraint dimension as: a reference one's
  // MEASURED value, an offset's magnitude, an X/Y distance's sign.
  const drawn = new Map(constraintDims([...entities], [...constraints]).map((d) => [d.cIndex, d]));
  constraints.forEach((c, index) => {
    if (!isDimConstraint(c) || shownAsBadge(c, byId)) return;
    const ops = operands(c);
    const shapes = [...new Set(ops.map(shapeOf))];
    const id = (c as { id?: string }).id;
    const one = shapes.length === 1 ? byId.get(shapes[0]!) : undefined;
    const d = drawn.get(index);
    rows.push({
      key: constraintDimKey(c, index),
      ref: { kind: "constraint", index, ...(id ? { id } : {}) },
      // An offset names its first source and copy: one dimension governs the
      // whole chain, so it is one row, as it is one label on the canvas.
      subject: shapes.length === 1 ? nameOf(ops[0]!) : t("inspector.sketchDim.between", { a: nameOf(ops[0] ?? ""), b: nameOf(ops[1] ?? "") }),
      dim: constraintWord(c),
      construction: one?.construction === true,
      entities: shapes.filter((s) => byId.has(s) && !unlisted(s)),
      valueMm: d?.valueMm ?? (c.type === "offset" ? Math.abs(c.value) : c.value),
      kind: c.type === "angle" ? "angle" : "length",
      driven: isDriven(c),
      signed: d?.signed === true,
    });
  });
  return rows;
}

/** A row's label, as the panel shows it: "Rectangle 1 · Width mm", and
 *  "Line 2 · Length mm (construction)" for construction geometry. `suffix` is
 *  the unit the value is shown in (" mm", "°"). */
export function dimRowLabel(row: SketchDimRow, suffix: string): string {
  const label = t("inspector.sketchDim.label", { subject: row.subject, dim: `${row.dim}${suffix}` });
  return row.construction ? t("inspector.sketchDim.construction", { label }) : label;
}

/** The row's constraint in `constraints`: by id when it has one, else at its
 *  index. -1 when it is gone, or when the constraint now at that index is not
 *  a dimension (the list was edited since the row was made). */
export function rowConstraintAt(constraints: readonly SketchConstraint[], ref: Extract<DimRowRef, { kind: "constraint" }>): number {
  if (ref.id) return constraints.findIndex((c) => (c as { id?: string }).id === ref.id);
  const c = constraints[ref.index];
  return c && isDimConstraint(c) && !(c as { id?: string }).id ? ref.index : -1;
}
