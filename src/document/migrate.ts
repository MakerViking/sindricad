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

import type { CadDocument, ParamDef, ParamTarget } from "../types";
import { FEATURE_NUM_FIELDS, RIGID_ENTITY_NUM_FIELDS, kindUnit } from "./numFields";
import { isDimConstraint, newConstraintId, noteConstraintId } from "../sketch/id";
import { nextDName } from "../params/engine";

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

/** .sindri file-format version (bump when the on-disk shape changes incompatibly). */
export const FORMAT_VERSION = 5;

export function migrateDocument(parsed: CadDocument): string[] {
  const version = parsed.version ?? 1;
  if (version > FORMAT_VERSION) {
    // Best effort: load what we understand, but don't rewrite shapes we don't.
    return [
      "This file was made by a newer version of SindriCAD — unknown data (e.g. parameter expressions) may be lost if you save it here.",
    ];
  }

  const features = parsed.features ?? [];
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

  // --- stamp dimension-constraint ids (reserve all loaded ones first) ---
  const dims = features.flatMap((f) => (f.type === "sketch" ? (f.constraints ?? []).filter(isDimConstraint) : []));
  for (const c of dims) noteConstraintId(c.id);
  for (const c of dims) c.id ??= newConstraintId();

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
