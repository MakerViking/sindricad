// Load-time document migration to the current FORMAT_VERSION.
// Mutates the parsed document in place and returns user-facing warnings.
// Everything here is idempotent, so it can safely run on every load.
//
// v1 → v2 changes:
//  - polygon.angle was stored in RADIANS (the lone outlier — every other angle
//    field is degrees); v2 stores DEGREES.
//  - dimension constraints gain a stable `id` ("c" prefix, sketch/id.ts).
//  - bare parameter NAMES stored in numeric fields ("distance": "thickness")
//    become model parameters (dN rows in `paramDefs` with a target binding) and
//    the field is rewritten to the cached number — loss-free, same geometry.
//  - plain user parameters get a paramDefs row (expr = the literal).
//
// v2 → v3: the "projected" sketch entity (linked reference geometry). A pure
// ADDITION — no data rewrite, the stamp alone marks the format. Older builds
// opening a v3 file hit the newer-version warning below and degrade gracefully
// (unknown entity types are skipped, not crashed on).
//
// v3 → v4: the "offset" sketch constraint (the associative link the Offset tool
// creates) and the sketch feature's `planeId` (a by-id datum-plane reference, so
// an offset plane's distance stays editable instead of being baked into the
// plane's origin). Both pure ADDITIONS — no data rewrite, the stamp alone marks
// the format. `plane` is still written alongside `planeId` as a resolved cache,
// so an older build opening a v4 file still places the sketch correctly.

import type { CadDocument, Feature, ParamDef, ParamTarget, SketchEntity } from "../types";
import { FEATURE_NUM_FIELDS, RIGID_ENTITY_NUM_FIELDS, kindUnit } from "./numFields";
import { isDimConstraint, newConstraintId, noteConstraintId } from "../sketch/id";
import { RECT_CENTRE, constraintEntityIds } from "../sketch/entityDims";
import { nextDName } from "../params/engine";
import { t } from "../i18n";

// v4 → v5: geometry left the document. An `import` feature used to carry the
// whole shape inline as base64 ASCII BREP (`brep`); it now carries `geom`, the
// content hash of the same geometry stored as binary BREP inside the `.sindri`
// container. On the 356 MiB reference assembly that inline field alone was
// 541.8 MiB — 4.2x over the websocket frame cap and 6.4x over the 64 MiB
// embedded-BREP cap re-checked on every rebuild, which is why an assembly that
// size could not be opened at all.
//
// The stamp alone marks the format: `brep` is still READ, so a v4 document keeps
// rebuilding untouched, and it is rewritten to `geom` when the document is
// migrated on open. The file itself also changes shape (JSON → ZIP), which is
// the first migration that is not purely a data rewrite — older builds get an
// explicit "update SindriCAD" message rather than a JSON syntax error.

// v5 → v6: the corners, centres and sides of rectangles, polygons and slots
// became constraint operands (2026-10, types.ts). An older build opens such a
// sketch but holds nothing there, and its pruneConstraints DROPS every
// constraint naming a polygon's or a slot's corner, centre or side the next
// time that sketch is edited, without a word. The version stamp is the one
// signal every older build already acts on: on open it says the file was
// made by a newer version and that saving it there may lose data
// (file.warning.newerVersion). It does not stop the edit, and the prune still
// happens at the next edit there.
//
// The stamp costs something in that build too. 0.1.232's migrateDocument
// returns at that gate, before it reserves the loaded dimension ids, and
// nothing else there reserves them: the next dimension added in a sketch can
// take an id another one in it already has, and a parameter bound to that id
// then finds the first of the two. It saves the twins as v5. So this build
// reserves the ids before its own gate, and gives the later of two twins in a
// sketch a fresh id on open (migrateDocument below).
//
// Unlike every bump before it, v6 is stamped only on a document that USES
// what it adds (savedVersion): one that does not is still saved as v5, so an
// older build keeps opening it without the warning. A point put on a plain
// line, circle or arc (pointOn, also new) does not stamp the document: an
// older build keeps that constraint in the file and only stops holding it.
// That includes the ones Explode, and Fillet or Chamfer on a polygon, write to
// keep a shape's form, so exploding the shape a document was stamped for can
// save it as v5 again.
//
// A projected POINT (a body corner or another sketch's point, also 2026-10)
// stamps v6 too: an older build has no such curve kind, and drawing, snapping,
// finding the areas of, checking or solving a sketch that holds one throws
// there. A smooth projected curve does not: an older build builds it in
// straight pieces, as it always did, and its link keeps the flag, so this
// build makes it smooth again.

/** .sindri file-format version: the newest this build reads (bump when the
 *  on-disk shape changes incompatibly). A document is SAVED as the oldest
 *  version that holds what it uses: savedVersion. */
export const FORMAT_VERSION = 6;

/** The version a document is saved as: v6 when a sketch names a shape's
 *  corner, centre or side or holds a projected point (see v5 → v6 above),
 *  else v5. */
export function savedVersion(features: readonly Feature[]): number {
  return features.some((f) => usesShapeOperands(f) || usesProjectedPoints(f)) ? 6 : 5;
}

/** True if a sketch holds a projected point (v5 → v6 above). */
function usesProjectedPoints(f: Feature): boolean {
  return f.type === "sketch" && f.entities.some((e) => e.type === "projected" && e.curve.kind === "point");
}

/** Point fields a constraint names together with its entity (types.ts). */
const POINT_FIELDS = [["e", "p"], ["e1", "p1"], ["e2", "p2"]] as const;

/** True if a sketch's constraints name a shape's corner, centre or side: any
 *  point or side of a polygon or a slot, a rectangle's centre, or a shape's
 *  side for a point to lie on (a rectangle's: a polygon's or a slot's is
 *  caught as naming that shape). A reference dimension counts too: an older
 *  build drops it all the same. */
function usesShapeOperands(f: Feature): boolean {
  if (f.type !== "sketch" || !f.constraints?.length) return false;
  const kinds = new Map<string, SketchEntity["type"]>();
  for (const e of f.entities) if (e.id) kinds.set(e.id, e.type);
  return f.constraints.some((c) => {
    if (c.type === "pointOn" && c.curve.includes("~")) return true;
    if (constraintEntityIds(c).some((id) => kinds.get(id) === "polygon" || kinds.get(id) === "slot")) return true;
    const rec = c as unknown as Record<string, unknown>;
    return POINT_FIELDS.some(([e, p]) => {
      const id = rec[e];
      return typeof id === "string" && kinds.get(id) === "rectangle" && rec[p] === RECT_CENTRE;
    });
  });
}

/** `readsUpTo` is the newest version the loader reads: this build's
 *  FORMAT_VERSION, or an older build's when a test stands in for its gate
 *  (only the gate: what runs before and after it is this build's). */
export function migrateDocument(parsed: CadDocument, readsUpTo = FORMAT_VERSION): string[] {
  const version = parsed.version ?? 1;
  const features = parsed.features ?? [];
  // Reserve every loaded dimension id first, whatever the version: a build
  // that skips this for a newer file hands a new dimension an id one already
  // has (v5 → v6 above).
  const dims = features.flatMap((f) => (f.type === "sketch" ? (f.constraints ?? []).filter(isDimConstraint) : []));
  for (const c of dims) noteConstraintId(c.id);
  if (version > readsUpTo) {
    // Best effort: load what we understand, but don't rewrite shapes we don't.
    return [t("file.warning.newerVersion")];
  }

  const params = parsed.parameters ?? {};
  const defs: Record<string, ParamDef> = parsed.paramDefs ?? {};

  // --- v1: polygon.angle radians → degrees ---
  if (version < 2) {
    for (const f of features) {
      if (f.type !== "sketch") continue;
      for (const e of f.entities) {
        if (e.type === "polygon" && typeof e.angle === "number") {
          e.angle = (e.angle * 180) / Math.PI;
        }
      }
    }
  }

  // --- stamp dimension-constraint ids (all loaded ones reserved above) ---
  // A dimension whose id an earlier one in its sketch already has (an older
  // build's twin, v5 → v6 above) gets a fresh one too: a parameter finds a
  // dimension by its id within its sketch, so only the first of two twins
  // could ever be driven. The first keeps the id its bindings name.
  for (const f of features) {
    if (f.type !== "sketch") continue;
    const seen = new Set<string>();
    for (const c of (f.constraints ?? []).filter(isDimConstraint)) {
      if (c.id == null || seen.has(c.id)) c.id = newConstraintId();
      seen.add(c.id);
    }
  }

  // --- seed paramDefs rows for plain user parameters ---
  for (const [name, value] of Object.entries(params)) {
    if (!defs[name]) defs[name] = { expr: String(value), value, unit: "mm" };
  }

  // --- bare-name numeric fields → model parameters (dN) ---
  const bind = (holder: object, field: string, unit: ParamDef["unit"], target: ParamTarget) => {
    const h = holder as Record<string, unknown>;
    const raw = h[field];
    if (typeof raw !== "string") return;
    const value = params[raw];
    if (value === undefined) return; // not a known param — leave for the legacy path
    h[field] = value;
    defs[nextDName(defs)] = { expr: raw, value, unit, target };
  };
  for (const f of features) {
    for (const [field, , kind] of FEATURE_NUM_FIELDS[f.type] ?? []) {
      bind(f, field, kindUnit(kind), { kind: "feature", feature: f.id, field });
    }
    if (f.type !== "sketch") continue;
    for (const e of f.entities) {
      // Only solver-rigid shapes may be owned by a parameter; other entities'
      // bare names stay on the legacy resolveNum/val() path untouched.
      const fields = RIGID_ENTITY_NUM_FIELDS[e.type];
      if (!fields || !e.id) continue;
      for (const [field, kind] of fields) {
        bind(e, field, kindUnit(kind), { kind: "entity", sketch: f.id, entity: e.id, field });
      }
    }
  }

  // keep files clean: don't persist an empty table
  if (Object.keys(defs).length > 0) parsed.paramDefs = defs;
  else delete parsed.paramDefs;

  return [];
}
