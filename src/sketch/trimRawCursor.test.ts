// Trim must act on the piece UNDER THE CURSOR.
//
// Field report (2026-08-24, Thomas): "we need to be able to cut lines, points
// etc. in sketches" — trim was present, reachable on T and in the MODIFY group,
// and its geometry was correct. What was wrong was the point it was handed.
//
// sketchMode's click dispatch derives `p` from `snapAt(...)`, and trim used it
// like every other tool. But trim is not like every other tool: the whole
// gesture is "which side of the crossings am I pointing at", and the strongest
// snap targets near a line you are trimming ARE those crossings. So the click
// landed exactly on a span boundary — which belongs to the span on either side
// of it — and the span search took the earlier one. Trim then deleted the piece
// NEXT TO the one under the cursor.
//
// The first describe below is the ROOT CAUSE, pinned as a property of
// trimEntity: a boundary point genuinely cannot say which side was meant. That
// is why the fix is at the CALL SITE (raw cursor, not snapped) and not a
// tie-break in here — a tie-break cannot recover information the snap destroyed,
// and a guard that looks like protection while changing nothing is worse than
// none. The second describe pins the call site.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { trimEntity } from "./modify";
import sketchSrc from "./sketchMode.ts?raw";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const line = (id: string, x1: number, y1: number, x2: number, y2: number) =>
  ({ type: "line", id, x1, y1, x2, y2 }) as never;

/** horizontal line -20..20 crossed at x=-5 and x=+5 → spans [-20,-5] [-5,5] [5,20] */
const crossed = () => [
  line("h", -20, 0, 20, 0),
  line("v1", -5, -10, -5, 10),
  line("v2", 5, -10, 5, 10),
];

/** the surviving pieces of the trimmed line, as [x1,x2] pairs */
function kept(click: THREE.Vector2): [number, number][] {
  const out = trimEntity(crossed(), 0, click) as unknown as {
    type: string; id: string; x1: number; x2: number;
  }[];
  return out
    .filter((e) => e.type === "line" && e.id !== "v1" && e.id !== "v2")
    .map((e) => [Math.round(e.x1), Math.round(e.x2)] as [number, number]);
}

describe("trimEntity given the RAW cursor", () => {
  it("removes the middle span when the cursor is inside it", () => {
    expect(kept(v(0, 0))).toEqual([[-20, -5], [5, 20]]);
  });

  it("removes the right span when the cursor is inside it", () => {
    expect(kept(v(12, 0))).toEqual([[-20, 5]]);
  });

  it("removes the left span when the cursor is inside it", () => {
    expect(kept(v(-12, 0))).toEqual([[-5, 20]]);
  });
});

describe("why a SNAPPED point cannot work", () => {
  it("a click on a crossing removes the span on the wrong side", () => {
    // This is the BUG, preserved as a fact about the input rather than as
    // desired behaviour. Aiming at the middle span but snapping to its left
    // boundary removes the LEFT span instead — the piece next to the cursor.
    expect(kept(v(-5, 0))).toEqual([[-5, 20]]);
    // ...which is the very same result as genuinely aiming at the left span.
    // The two gestures are indistinguishable once the point has been snapped,
    // which is why the call site must not snap.
    expect(kept(v(-5, 0))).toEqual(kept(v(-12, 0)));
  });
});

describe("the trim call site (sketchMode source)", () => {
  // Source text, not an import: constructing a real SketchMode boots the
  // viewport, overlay and solver. Same reason featureEditReachable.test.ts does
  // it, and the same limitation — so this pins the EXPRESSION, not an identifier.
  it("hands trimClick the raw plane point, never the snapped one", () => {
    const at = sketchSrc.indexOf('if (this.tool === "trim") {');
    expect(at, "the trim carve-out is gone from the click dispatch — trim is snapped again").toBeGreaterThan(-1);
    const block = sketchSrc.slice(at, at + 400);
    expect(block).toContain("this.planePoint(e)");
    expect(block).toContain("this.trimClick(raw)");
  });

  it("runs BEFORE the snap, so a click with nothing to snap to still trims", () => {
    const trimAt = sketchSrc.indexOf('if (this.tool === "trim") {');
    const snapAt = sketchSrc.indexOf("const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);\n    if (!hit) return;");
    expect(snapAt).toBeGreaterThan(-1);
    expect(trimAt).toBeLessThan(snapAt);
  });

  it("no longer dispatches trim from the snapped point further down", () => {
    expect(sketchSrc).not.toContain('if (this.tool === "trim") return this.trimClick(p);');
  });
});
