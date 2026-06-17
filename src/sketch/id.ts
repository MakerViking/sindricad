// Stable per-entity identity for the sketcher. Constraints reference entities by
// id (never array index), so modify operations that reorder/split/remove
// entities can't silently repoint a constraint at the wrong geometry.
//
// Ids are a monotonic per-session counter (`e0`, `e1`, …). When a sketch is
// loaded, noteEntityId() bumps the counter past any saved ids so freshly drawn
// entities never collide with persisted ones.

let counter = 0;

export function newEntityId(): string {
  return `e${counter++}`;
}

/** Reserve a loaded id so future newEntityId() calls won't reuse it. */
export function noteEntityId(id: string | undefined): void {
  if (!id) return;
  const m = /^e(\d+)$/.exec(id);
  if (m) counter = Math.max(counter, Number(m[1]) + 1);
}
