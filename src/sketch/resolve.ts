// Resolve a sketch feature's entities (whose numeric fields may be parameter
// names) into plain-number entities for rendering/snapping/region detection.

import type { Feature, Num, Params, SketchEntity } from "../types";
import type { ResolvedEntity } from "./snap";
import { newEntityId, noteEntityId } from "./id";
import { expandPattern } from "./pattern";

export function resolveNum(x: Num, params: Params): number {
  if (typeof x === "number") return x;
  const v = params[x];
  if (typeof v === "number") return v;
  const n = parseFloat(x);
  return Number.isNaN(n) ? 0 : n;
}

/** Resolve ONLY the sketch's real (persisted) entities — no pattern expansion.
 *  Use this wherever the result feeds back into edits/persistence (e.g. the
 *  sketch-editor session); see resolveEntities for the render/detect variant
 *  that also includes derived pattern copies. */
export function resolveRealEntities(
  sketch: Extract<Feature, { type: "sketch" }>,
  params: Params,
): ResolvedEntity[] {
  // reserve every saved id first so generated ids for any id-less entities
  // can't collide with persisted ones (or with later-drawn geometry)
  for (const e of sketch.entities) noteEntityId(e.id);

  const out: ResolvedEntity[] = [];
  for (const e of sketch.entities) {
    const c = e.construction ? { construction: true } : {};
    const id = e.id ?? newEntityId();
    if (e.type === "rectangle") {
      out.push({
        type: "rectangle", id,
        width: resolveNum(e.width, params),
        height: resolveNum(e.height, params),
        x: resolveNum(e.x ?? 0, params),
        y: resolveNum(e.y ?? 0, params),
        ...c,
      });
    } else if (e.type === "circle") {
      out.push({
        type: "circle", id,
        radius: resolveNum(e.radius, params),
        x: resolveNum(e.x ?? 0, params),
        y: resolveNum(e.y ?? 0, params),
        ...c,
      });
    } else if (e.type === "line") {
      out.push({
        type: "line", id,
        x1: resolveNum(e.x1, params),
        y1: resolveNum(e.y1, params),
        x2: resolveNum(e.x2, params),
        y2: resolveNum(e.y2, params),
        ...c,
      });
    } else if (e.type === "arc") {
      out.push({
        type: "arc", id,
        x1: resolveNum(e.x1, params),
        y1: resolveNum(e.y1, params),
        x2: resolveNum(e.x2, params),
        y2: resolveNum(e.y2, params),
        mx: resolveNum(e.mx, params),
        my: resolveNum(e.my, params),
        ...c,
      });
    } else if (e.type === "spline") {
      out.push({
        type: "spline", id,
        points: e.points.map((p) => ({ x: resolveNum(p.x, params), y: resolveNum(p.y, params) })),
        ...c,
      });
    } else if (e.type === "point") {
      out.push({
        type: "point", id,
        x: resolveNum(e.x, params),
        y: resolveNum(e.y, params),
        ...c,
      });
    }
  }
  return out;
}

/** Resolve a sketch's real entities AND every pattern's derived copies, in one
 *  flat array — for callers that only render/inspect (never persist) the
 *  result: committed-sketch overlay rendering, region detection for those
 *  sketches, and the inspector's per-entity dimension list. The copies are
 *  derived here, never stored as real entities — do NOT feed this back into
 *  `sketch.entities` (see resolveRealEntities for the editable, persist-safe
 *  subset; that's what the sketch-editor session uses). */
export function resolveEntities(
  sketch: Extract<Feature, { type: "sketch" }>,
  params: Params,
): ResolvedEntity[] {
  const out = resolveRealEntities(sketch, params);
  if (sketch.patterns?.length) {
    const byId = new Map(out.map((e) => [e.id, e]));
    for (const pat of sketch.patterns) out.push(...expandPattern(pat, byId, params));
  }
  return out;
}

/** serialize a resolved (numeric) entity back to a document SketchEntity */
export function toSketchEntity(e: ResolvedEntity): SketchEntity {
  const c = e.construction ? { construction: true } : {};
  if (e.type === "rectangle")
    return { type: "rectangle", id: e.id, width: e.width, height: e.height, x: e.x, y: e.y, ...c };
  if (e.type === "circle") return { type: "circle", id: e.id, radius: e.radius, x: e.x, y: e.y, ...c };
  if (e.type === "arc")
    return { type: "arc", id: e.id, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, mx: e.mx, my: e.my, ...c };
  if (e.type === "spline")
    return { type: "spline", id: e.id, points: e.points.map((p) => ({ x: p.x, y: p.y })), ...c };
  if (e.type === "point") return { type: "point", id: e.id, x: e.x, y: e.y, ...c };
  return { type: "line", id: e.id, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, ...c };
}
