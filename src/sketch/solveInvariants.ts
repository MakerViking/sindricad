// Post-conditions every solve result must satisfy, whatever the constraints were.
//
// The solver tests all asserted SPECIFIC expected outcomes, so nothing asserted
// the boring universal thing: that the geometry coming back is still geometry.
// A conflicting sketch was "solved" by shrinking a 65mm line to zero length —
// at zero length a line has no direction, so an impossible `parallel` becomes
// vacuously true — and that collapsed sketch reached the document because the
// only screen in place looked at circle and arc RADII (GitHub #17 follow-up,
// reproduced in the app 2026-08-15).
//
// Expressed as a blanket post-condition rather than a case, so it also covers
// constraint types nobody has written yet.
import { expect } from "vitest";
import type { ResolvedEntity } from "./snap";

/** Nothing shorter than this has a usable direction. Matches sketchSolve's own
 *  LINE_COLLAPSE_EPS — if these two ever drift, a solve can pass the guard and
 *  still fail this check, which is the signal you want. */
const MIN_LEN = 1e-7;

const isFinitePt = (...n: number[]) => n.every((x) => Number.isFinite(x));

/** Assert a solved entity list is usable geometry.
 *
 *  `before` is optional: when given, a line is only judged for collapse if it
 *  HAD length to begin with, so a degenerate entity already in the document is
 *  not reported as though this solve created it. */
export function expectSaneGeometry(
  after: ResolvedEntity[],
  where: string,
  before?: ResolvedEntity[],
) {
  const lenOf = (e: any) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  const beforeById = new Map((before ?? []).map((e) => [e.id, e as any]));

  for (const e of after as any[]) {
    switch (e.type) {
      case "line": {
        expect(isFinitePt(e.x1, e.y1, e.x2, e.y2), `${where}: line ${e.id} has a non-finite endpoint`).toBe(true);
        const prev = beforeById.get(e.id);
        if (!before || (prev && prev.type === "line" && lenOf(prev) > MIN_LEN)) {
          expect(lenOf(e), `${where}: line ${e.id} collapsed to zero length`).toBeGreaterThan(MIN_LEN);
        }
        break;
      }
      case "circle":
        expect(isFinitePt(e.x, e.y, e.radius), `${where}: circle ${e.id} has a non-finite field`).toBe(true);
        expect(e.radius, `${where}: circle ${e.id} has a non-positive radius`).toBeGreaterThan(0);
        break;
      case "arc":
        expect(isFinitePt(e.x1, e.y1, e.x2, e.y2), `${where}: arc ${e.id} has a non-finite endpoint`).toBe(true);
        if (typeof e.radius === "number") {
          expect(e.radius, `${where}: arc ${e.id} has a non-positive radius`).toBeGreaterThan(0);
        }
        break;
      case "point":
        expect(isFinitePt(e.x, e.y), `${where}: point ${e.id} is non-finite`).toBe(true);
        break;
      default:
        break; // text/projected carry their own shape; nothing universal to assert
    }
  }
}

/** The other half of the contract: a solve that is NOT ok must not have handed
 *  back changed geometry. "Keep last good on conflict" is only a guarantee if
 *  something checks it. */
export function expectUnchangedOnFailure(
  r: { ok: boolean },
  before: ResolvedEntity[],
  after: ResolvedEntity[],
  where: string,
) {
  if (r.ok) return;
  const key = (e: any) =>
    e.type === "line" ? `${e.id}:${e.x1},${e.y1},${e.x2},${e.y2}`
    : e.type === "circle" ? `${e.id}:${e.x},${e.y},${e.radius}`
    : `${e.id}`;
  expect(after.map(key).join("|"), `${where}: a failed solve still changed the geometry`)
    .toBe(before.map(key).join("|"));
}
