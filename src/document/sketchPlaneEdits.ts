// The two document edits behind a sketch's right-click: "Copy sketch to
// plane…" (Doug 27) and "Move sketch plane…" (Doug L3).
//
// Pure functions over a CadDocument. The store runs each inside ONE mutate, so
// each is one undo step, and a test can drive them without a viewport.
//
// Neither adds a field to the file. A copy is an ordinary sketch. A moved
// sketch sits on an ordinary datum plane through `planeId`, the link an Offset
// Plane sketch has always had, so every build that opens the file builds it,
// and from then on the datum's Offset row (or a parameter) moves it.

import type {
  CadDocument,
  Feature,
  ParamDef,
  ParamTarget,
  PlaneDef,
  PlaneSpec,
  Selector,
  SketchConstraint,
  SketchEntity,
  SketchPattern,
  Vec3,
} from "../types";
import { isDimConstraint, newConstraintId, newEntityId, newPatternId } from "../sketch/id";
import { breakLink } from "../sketch/modify";
import { toSketchEntity } from "../sketch/resolve";
import type { ResolvedEntity } from "../sketch/snap";
import * as params from "../params/engine";
import { renameRefs } from "../params/parse";
import { t } from "../i18n";

type SketchFeature = Extract<Feature, { type: "sketch" }>;
type DatumFeature = Extract<Feature, { type: "datumPlane" }>;

/** Where a copied sketch goes: the plane the pick returned, plus the datum id
 *  or the face selector that keeps it there when the model changes upstream. */
export interface SketchTarget {
  plane: PlaneSpec;
  planeId?: string;
  face?: Selector;
}

// --- Copy sketch to plane ---------------------------------------------------

/** Every entity id a constraint names, rewritten through `op`. One arm per
 *  constraint type and no default, so a constraint type added later fails the
 *  type check here instead of being copied pointing at the SOURCE sketch's ids
 *  (which the copy does not have, so the sketcher's prune would drop it). */
function remapConstraint(c: SketchConstraint, op: (id: string) => string): SketchConstraint {
  switch (c.type) {
    case "horizontal": case "vertical": case "distance":
      return { ...c, line: op(c.line) };
    case "parallel": case "perpendicular": case "equal": case "collinear": case "angle":
      return { ...c, l1: op(c.l1), l2: op(c.l2) };
    case "diameter":
      return { ...c, circle: op(c.circle) };
    case "tangent":
      return { ...c, line: op(c.line), circle: op(c.circle) };
    case "tangent2": case "equalRadius":
      return { ...c, a: op(c.a), b: op(c.b) };
    case "coincident": case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY":
      return { ...c, e1: op(c.e1), e2: op(c.e2) };
    case "concentric": case "c2cDistance":
      return { ...c, c1: op(c.c1), c2: op(c.c2) };
    case "midpoint": case "p2lDistance":
      return { ...c, e: op(c.e), line: op(c.line) };
    case "pointOn":
      return { ...c, e: op(c.e), curve: op(c.curve) };
    case "symmetric":
      return { ...c, e1: op(c.e1), e2: op(c.e2), line: op(c.line) };
    case "radius": case "fix":
      return { ...c, e: op(c.e) };
    case "radialGap":
      return { ...c, inner: op(c.inner), outer: op(c.outer) };
    case "c2lDistance":
      return { ...c, circle: op(c.circle), line: op(c.line) };
    case "p2cDistance":
      return { ...c, e: op(c.e), circle: op(c.circle) };
    case "offset":
      return { ...c, pairs: c.pairs.map((p) => ({ src: op(p.src), cpy: op(p.cpy) })) };
    default:
      return c satisfies never;
  }
}

/** A projected entity as the native curve Break Link makes of it: the copy
 *  has no business following the SOURCE sketch's references, and on another
 *  plane the cached 2D shape is not a projection of anything anyway. */
function breakLinked(e: Extract<SketchEntity, { type: "projected" }>, id: string): SketchEntity {
  const resolved = { ...e, id } as ResolvedEntity;
  return toSketchEntity(breakLink([resolved], new Set([id]))[0]!);
}

/** Splice a copy of sketch `srcId` into `d` at index `at`, on `target`, under
 *  feature id `newId`. Returns false when there is no such sketch.
 *
 *  Every id inside is new: entities, dimensions and patterns, and every
 *  constraint operand, pattern source and text path is rewritten to match,
 *  including a rectangle edge named as `<rectId>~<k>`. An operand that names
 *  something outside the sketch (the synthetic origin axes) passes through.
 *
 *  A dimension driven by a parameter stays driven by it (decision B4,
 *  "parameter expressions kept"). The copy's dimension gets a model parameter
 *  of its own, because a parameter drives one field:
 *  - under a name the user TYPED (`width = 40`), it follows that name, so the
 *    copy's `width` dimension and its `width / 2` agree with each other, and
 *    with the source, when `width` changes;
 *  - under an auto name (dN), it holds the source's expression, with every
 *    reference to another of the source sketch's dN pointed at the copy's own,
 *    so a relation inside the sketch (circle = d1 / 4) holds inside the copy
 *    instead of tying the copy's circle to the source's width. */
export function copySketch(d: CadDocument, srcId: string, newId: string, target: SketchTarget, at: number): boolean {
  const found = d.features.find((f): f is SketchFeature => f.id === srcId && f.type === "sketch");
  if (!found) return false;
  // A deep copy first: label placements and pattern fields are objects, and
  // sharing them between two features would let an edit of one move the other.
  const src = structuredClone(found);

  const entIds = new Map<string, string>();
  for (const e of src.entities) if (e.id) entIds.set(e.id, newEntityId());
  const op = (id: string): string => {
    const k = id.indexOf("~");
    const to = entIds.get(k < 0 ? id : id.slice(0, k));
    if (to === undefined) return id;
    return k < 0 ? to : to + id.slice(k);
  };

  const entities = src.entities.map((e): SketchEntity => {
    const id = (e.id && entIds.get(e.id)) || newEntityId();
    if (e.type === "projected") return breakLinked(e, id);
    if (e.type === "text" && e.pathRef !== undefined) return { ...e, id, pathRef: op(e.pathRef) };
    return { ...e, id };
  });

  const dimIds = new Map<string, string>();
  const constraints = (src.constraints ?? []).map((c0) => {
    const c = remapConstraint(c0, op);
    if (isDimConstraint(c) && c.id) {
      const id = newConstraintId();
      dimIds.set(c.id, id);
      c.id = id;
    }
    return c;
  });

  const patIds = new Map<string, string>();
  const patterns = (src.patterns ?? []).map((p): SketchPattern => {
    const id = newPatternId();
    patIds.set(p.id, id);
    return "sources" in p ? { ...p, id, sources: p.sources.map(op) } : { ...p, id };
  });

  const copy: SketchFeature = {
    id: newId,
    type: "sketch",
    plane: target.plane,
    ...(target.planeId ? { planeId: target.planeId } : {}),
    ...(target.face ? { face: target.face } : {}),
    ...(src.name ? { name: t("sketch.copyName", { name: src.name }) } : {}),
    entities,
    ...(constraints.length ? { constraints } : {}),
    ...(patterns.length ? { patterns } : {}),
  };
  d.features.splice(at, 0, copy);

  // The binding is copied AFTER the splice: recompute (inside the store's
  // mutate) drops any model parameter whose target does not resolve.
  const retarget = (tg: ParamTarget): ParamTarget | null => {
    if (tg.kind === "feature" || tg.sketch !== srcId) return null;
    switch (tg.kind) {
      case "constraint": {
        const id = dimIds.get(tg.constraint);
        return id ? { ...tg, sketch: newId, constraint: id } : null;
      }
      case "entity": {
        const id = entIds.get(tg.entity);
        return id ? { ...tg, sketch: newId, entity: id } : null;
      }
      case "pattern": {
        const id = patIds.get(tg.pattern);
        return id ? { ...tg, sketch: newId, pattern: id } : null;
      }
    }
  };
  // Snapshot the entries first: the loop adds to the same table. And read
  // `paramDefs` directly, so a document without a parameter table does not
  // gain an empty one.
  const renamed = new Map<string, string>(); // the source's dN -> the copy's
  const ownExprs: ParamDef[] = [];
  for (const [name, def] of Object.entries(d.paramDefs ?? {})) {
    const to = def.target ? retarget(def.target) : null;
    if (!to) continue;
    const defs = params.defsOf(d);
    const dn = params.nextDName(defs);
    if (params.isAutoName(name)) {
      const own: ParamDef = { expr: def.expr, value: def.value, unit: def.unit, ...(def.comment ? { comment: def.comment } : {}), target: to };
      defs[dn] = own;
      renamed.set(name, dn);
      ownExprs.push(own);
    } else {
      defs[dn] = { expr: name, value: def.value, unit: def.unit, target: to };
    }
  }
  // One pair at a time is safe: every copy's name is past every name the table
  // had (nextDName), so a rewritten reference never reads as a source name.
  for (const def of ownExprs) {
    for (const [from, to] of renamed) {
      try {
        def.expr = renameRefs(def.expr, from, to);
      } catch {
        // an unparsable expression references nothing; it keeps its text
      }
    }
  }
  return true;
}

// --- Move sketch plane ------------------------------------------------------

/** Ids of every feature that names datum `id` as its plane: a sketch or a
 *  split sitting on it, an extrude or press/pull going up to it. */
function datumUsers(features: readonly Feature[], id: string): string[] {
  return features
    .filter((f) => (f as { planeId?: string }).planeId === id || (f as { upToPlane?: string }).upToPlane === id)
    .map((f) => f.id);
}

/** The datum plane sketch `sketchId` sits on, when nothing else uses it. Moving
 *  the sketch's plane then IS moving that datum, so the move edits its offset
 *  in place rather than stacking a second datum on top of it. Null for a
 *  sketch on a base plane or a face, and for a datum shared with other
 *  features (those must not move with this sketch). */
export function ownDatumOf(features: readonly Feature[], sketchId: string): DatumFeature | null {
  const s = features.find((f): f is SketchFeature => f.id === sketchId && f.type === "sketch");
  // `face` outranks `planeId` on rebuild (_sketch_plane_ref), so it does here
  if (!s || s.face || !s.planeId) return null;
  const datum = features.find((f): f is DatumFeature => f.id === s.planeId && f.type === "datumPlane");
  if (!datum) return null;
  const users = datumUsers(features, datum.id);
  return users.length === 1 && users[0] === sketchId ? datum : null;
}

/** Why Move sketch plane cannot move this sketch, or null when it can: the
 *  sketch's own datum has its offset set by an expression, and a drag must not
 *  overwrite what a parameter drives (the same rule as fillet and the datum's
 *  own Offset arrow). Names the parameter so the user knows what to change. */
export function moveSketchPlaneBlocker(d: CadDocument, sketchId: string): string | null {
  const own = ownDatumOf(d.features, sketchId);
  if (!own) return null;
  const target: ParamTarget = { kind: "feature", feature: own.id, field: "offset" };
  if (!params.isBound(d, target)) return null;
  return t("feature.starters.sketchPlaneByParam", { name: params.boundParam(d, target) ?? "" });
}

/** What Move sketch plane did: the datum the sketch now sits on (the caller
 *  selects it, so its Offset row is on screen), whether that datum is new,
 *  and whether the sketch left a datum other features still use. */
export interface SketchPlaneMove {
  datumId: string;
  inserted: boolean;
  leftShared: boolean;
}

/** Move sketch `sketchId` by `delta` mm along the normal of `from`, the plane
 *  it sits on now (as the last rebuild resolved it, see planeOf).
 *
 *  - On a datum nothing else uses: that datum's offset grows by `delta`.
 *  - Anywhere else: a new datum is spliced in IMMEDIATELY BEFORE the sketch
 *    and the sketch is linked to it by `planeId`. The datum starts from the
 *    sketch's own source, so it keeps following it: a base plane, or the face
 *    the sketch was picked on (`face` moves from the sketch to the datum, as
 *    Offset Plane already does). A datum shared with other features is the one
 *    exception: the new datum starts from where the sketch IS, because
 *    starting from the shared datum's own source would re-resolve its face
 *    anchor at a later point in the timeline and could land somewhere else.
 *
 *  The sketch's local frame is unchanged, only shifted along its normal, so
 *  every entity keeps its 2D coordinates. What does NOT come along by itself
 *  is a 3D point: an extrude or loft stores each picked profile area as a
 *  WORLD point on the plane, and one left behind binds to nothing, or to the
 *  wrong area. Those points are shifted with the plane. */
export function moveSketchPlane(
  d: CadDocument,
  sketchId: string,
  delta: number,
  from: PlaneDef,
  newDatumId: string,
): SketchPlaneMove | null {
  const at = d.features.findIndex((f) => f.id === sketchId && f.type === "sketch");
  if (at < 0) return null;
  const s = d.features[at] as SketchFeature;
  const len = Math.hypot(...from.normal) || 1;
  const n = from.normal.map((c) => (c / len) * delta) as Vec3;
  const shift = (p: Vec3): Vec3 => [p[0] + n[0], p[1] + n[1], p[2] + n[2]];

  // the resolved placement it moves to, as the cache every frontend reader uses
  const moved: SketchFeature = { ...s, plane: { origin: shift(from.origin), normal: [...from.normal], xdir: [...from.xdir] } };
  let out: SketchPlaneMove;
  const own = ownDatumOf(d.features, sketchId);
  if (own) {
    const offset = (own.offset ?? 0) + delta;
    d.features[d.features.indexOf(own)] = { ...own, offset };
    // A field bound to a LITERAL parameter is rewritten from it by the
    // recompute inside the same mutate, so the literal has to change too.
    // (A real expression never gets here: moveSketchPlaneBlocker refused it.)
    const bound = params.boundParam(d, { kind: "feature", feature: own.id, field: "offset" });
    if (bound) params.defsOf(d)[bound]!.expr = String(offset);
    out = { datumId: own.id, inserted: false, leftShared: false };
  } else {
    const shared = !s.face && !!s.planeId && d.features.some((f) => f.id === s.planeId && f.type === "datumPlane");
    const datum: DatumFeature = shared
      ? { id: newDatumId, type: "datumPlane", plane: structuredClone(from), offset: delta }
      : { id: newDatumId, type: "datumPlane", plane: s.plane, ...(s.face ? { face: s.face } : {}), offset: delta };
    delete moved.face;
    moved.planeId = newDatumId;
    d.features.splice(at, 0, datum);
    out = { datumId: newDatumId, inserted: true, leftShared: shared };
  }
  d.features[d.features.indexOf(s)] = moved;

  // Replace, never patch in place: the wire protocol diffs features by reference.
  d.features = d.features.map((f) => {
    if (f.type === "extrude" && f.sketch === sketchId) {
      return {
        ...f,
        ...(f.regions ? { regions: f.regions.map(shift) } : {}),
        ...(f.region ? { region: shift(f.region) } : {}),
      };
    }
    if (f.type === "loft" && f.profiles?.some((p) => p.sketch === sketchId)) {
      return { ...f, profiles: f.profiles.map((p) => (p.sketch === sketchId ? { ...p, region: shift(p.region) } : p)) };
    }
    return f;
  });
  return out;
}
