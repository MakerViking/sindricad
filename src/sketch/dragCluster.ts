// The constraint-connected cluster a point drag can possibly move — "solve
// only what the drag can reach" (GH #17 drag speed). Everything outside the
// cluster has no path to the dragged point, through a shared position or a
// constraint, so a full-sketch solve would leave it exactly where it was
// anyway; restricting the solve's entity list to the cluster gets the same
// result for a fraction of the solver's work on a large sketch.
//
// Deliberately entity-level, not solver-point-level: it mirrors the two
// devices sketchSolve.ts itself uses to tie entities together (attachmentPoints
// + coincKey for a touching join, and a constraint naming more than one entity)
// rather than re-deriving them from a compiled model. Over-including an entity
// (e.g. because a position bucket collides at the 0.001mm coincKey tolerance)
// only costs a little of the speedup; under-including one would move it
// without solving it, so every linking rule here matches sketchSolve's own.

import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { attachmentPoints } from "./modify";
import { coincKey } from "./sketchSolve";

/** Every entity id a constraint names, sub-id stripped (`R~2` -> `R`, the same
 *  convention sketchSolve's own entityRefs uses for a compiled constraint) --
 *  what the constraint TIES TOGETHER, not what it solves. Point-index fields
 *  (`p1`, `p2`, etc.) and numeric values never match a string entity id, so
 *  they fall out of the walk on their own. */
function constraintEntityRefs(c: SketchConstraint): string[] {
  const out: string[] = [];
  const take = (v: unknown): void => {
    if (typeof v === "string") {
      const cut = v.lastIndexOf("~");
      out.push(cut < 0 ? v : v.slice(0, cut));
    } else if (Array.isArray(v)) {
      v.forEach(take);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(take);
    }
  };
  for (const [k, v] of Object.entries(c)) if (k !== "type") take(v);
  return out;
}

/** The connected component reachable from the entities touching (x,y) — the
 *  position a drag just grabbed or just put an endpoint at (detachFrame's
 *  pull re-seeds from the new position, since the pulled end's connectivity
 *  just changed). Empty when nothing has an attachment point there (the drag
 *  grabbed something with no solver point, e.g. an un-named polygon/slot): the
 *  caller should treat that as "no cluster" and fall back to the whole sketch. */
export function dragCluster(
  entities: readonly ResolvedEntity[],
  constraints: readonly SketchConstraint[],
  x: number,
  y: number,
): Set<string> {
  // position bucket -> entity ids with an attachment point there
  const byPos = new Map<string, string[]>();
  for (const e of entities) {
    for (const p of attachmentPoints(e, constraints)) {
      const k = coincKey(p.x, p.y);
      const arr = byPos.get(k);
      if (arr) arr.push(e.id); else byPos.set(k, [e.id]);
    }
  }
  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    let s = neighbors.get(a);
    if (!s) neighbors.set(a, (s = new Set()));
    s.add(b);
    s = neighbors.get(b);
    if (!s) neighbors.set(b, (s = new Set()));
    s.add(a);
  };
  for (const ids of byPos.values()) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) link(ids[i]!, ids[j]!);
  }
  for (const c of constraints) {
    const refs = constraintEntityRefs(c);
    for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) link(refs[i]!, refs[j]!);
  }

  const seeds = byPos.get(coincKey(x, y)) ?? [];
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const id = queue.pop()!;
    for (const n of neighbors.get(id) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}
