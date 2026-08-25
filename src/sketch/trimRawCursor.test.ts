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

// --- trimming a RECTANGLE ---------------------------------------------------
//
// Field report (2026-08-25, Thomas): "When I clicked the bottom line of the
// rectangle, the whole rectangle disappeared when I had Trim selected."
//
// Pre-existing, and the code said so: `if (e.type !== "line") return del()`, with
// a comment reading "defer: trim/break/offset on rigid polygon/slot no-op or
// explode; revisit when a user hits it". A user hit it. A rectangle is ONE
// entity to the code and four lines to the person looking at it, and trim has to
// answer to the person.

const rect = (id: string, x: number, y: number, width: number, height: number) =>
  ({ type: "rectangle", id, x, y, width, height }) as never;

/** surviving lines as [x1,y1,x2,y2], rounded */
function survivors(out: unknown[]): number[][] {
  return (out as { type: string; x1: number; y1: number; x2: number; y2: number }[])
    .filter((e) => e.type === "line")
    .map((e) => [e.x1, e.y1, e.x2, e.y2].map(Math.round));
}

describe("trimming a rectangle", () => {
  // 100 x 150 centred at (50,75): edges on x=0, x=100, y=0, y=150
  const R = () => [rect("r", 50, 75, 100, 150)];

  it("removes only the edge you clicked, not the whole rectangle", () => {
    const out = trimEntity(R(), 0, v(50, 0));
    const kept = survivors(out);
    expect(kept).toHaveLength(3); // was 0 — the entire rectangle vanished
    // and the bottom edge (y=0 at both ends) is the one that went
    expect(kept.some((l) => l[1] === 0 && l[3] === 0)).toBe(false);
  });

  it("splits the clicked edge at a crossing, keeping the rest of the rectangle", () => {
    const ents = [rect("r", 50, 75, 100, 150), line("v", 30, -20, 30, 20)];
    const kept = survivors(trimEntity(ents, 0, v(50, 0)));
    // the 30..100 span of the bottom edge goes; 0..30 stays, as do the other
    // three edges and the crossing line
    expect(kept).toContainEqual([0, 0, 30, 0]);
    expect(kept.some((l) => l[0] === 0 && l[1] === 0 && l[2] === 100)).toBe(false);
  });

  it("still deletes shapes that genuinely have no edges", () => {
    // a polygon/slot is a rigid parametric shape — a trimmed hexagon is not a
    // hexagon — so those keep the delete-whole behaviour deliberately.
    const poly = { type: "polygon", id: "p", x: 0, y: 0, radius: 10, sides: 6, angle: 0 } as never;
    expect(survivors(trimEntity([poly], 0, v(10, 0)))).toHaveLength(0);
  });
});
