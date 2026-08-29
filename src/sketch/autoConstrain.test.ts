// Auto horizontal/vertical must not undo a snap.
//
// Field report ecc3e0d6 (0.1.181, linux): "What appears to be automatic
// coincidence constraint detection between lines does not work properly. Instead
// of making their endpoints perfectly coincident, the tool creates a very small
// gap of a few hundredths of a millimetre. These micro-gaps prevent the lines
// from being truly joined and can subsequently cause cracks during extrusion, as
// well as undetected or missing regions."
//
// The snap itself was never wrong — `snap()` returns the candidate point exactly,
// so an endpoint snap lands bit-for-bit on its neighbour. What broke it was the
// auto-constrain pass that runs immediately afterwards: a line within 3° of an
// axis is made exact, and "made exact" meant `e.y2 = e.y1`, moving the second
// endpoint. Off the join, by exactly the angular error the user's hand left.
//
// Hence the size in the report. A 3° tolerance over a 40 mm line permits up to
// 2 mm of correction, but a user drawing what they intend to be a horizontal
// line is off by a fraction of a degree, which over a short segment is
// hundredths of a millimetre — small enough to look like a rounding bug and
// large enough for OCCT to refuse the profile.
//
// SCOPE, stated so a green file does not imply more than it covers: this stops
// auto-H/V from breaking a join. It does NOT emit the coincident CONSTRAINT that
// would make a join survive later edits — snapping still only copies
// coordinates, so two points that coincide today can still be driven apart by a
// subsequent solve. That half is unfixed.
import { describe, it, expect } from "vitest";
import { inferHorizontalVertical, isGeometrySnap, type LineEnds } from "./autoConstrain";
import sketchModeSrc from "./sketchMode.ts?raw";
import glyphRendererSrc from "./sketchGlyphs.ts?raw";
import cssSrc from "../styles.css?raw";

/** A line 40 mm long, off horizontal by `deg` degrees. */
function nearlyHorizontal(deg: number, len = 40): LineEnds {
  const r = (deg * Math.PI) / 180;
  return { x1: 0, y1: 0, x2: Math.cos(r) * len, y2: Math.sin(r) * len };
}
function nearlyVertical(deg: number, len = 40): LineEnds {
  const r = ((90 + deg) * Math.PI) / 180;
  return { x1: 0, y1: 0, x2: Math.cos(r) * len, y2: Math.sin(r) * len };
}

describe("auto horizontal/vertical, when nothing is pinned", () => {
  it("still makes a nearly-horizontal line exact, moving the second point", () => {
    const r = inferHorizontalVertical(nearlyHorizontal(0.4));
    expect(r.kind).toBe("horizontal");
    expect(r.moved, "the free-hand case must behave exactly as it always did").toBe("end");
    expect(r.ends.y2).toBe(r.ends.y1);
  });

  it("still makes a nearly-vertical line exact", () => {
    const r = inferHorizontalVertical(nearlyVertical(-0.8));
    expect(r.kind).toBe("vertical");
    expect(r.ends.x2).toBe(r.ends.x1);
  });

  it("leaves a line that is not near an axis alone", () => {
    const line = nearlyHorizontal(20);
    const r = inferHorizontalVertical(line);
    expect(r.kind).toBeNull();
    expect(r.moved).toBeNull();
    expect(r.ends).toEqual(line);
  });

  it("respects the tolerance at its edge", () => {
    expect(inferHorizontalVertical(nearlyHorizontal(2.9)).kind).toBe("horizontal");
    expect(inferHorizontalVertical(nearlyHorizontal(3.1)).kind).toBeNull();
  });

  it("does not constrain a zero-length line", () => {
    // atan2(0, 0) is 0, which reads as horizontal — a constraint on a degenerate
    // segment, which the solver then has to carry.
    const r = inferHorizontalVertical({ x1: 5, y1: 5, x2: 5, y2: 5 });
    expect(r.kind, "a zero-length line was given a horizontal constraint").toBeNull();
  });
});

describe("a snapped endpoint is never moved", () => {
  it("moves the START when the END was snapped onto existing geometry", () => {
    // The reported case: draw from empty space to an existing endpoint. The end
    // must stay exactly where it was snapped.
    const line = nearlyHorizontal(0.4);
    const endBefore = { x: line.x2, y: line.y2 };
    const r = inferHorizontalVertical(line, { endPinned: true });
    expect(r.kind, "the line should still be recognised as horizontal").toBe("horizontal");
    expect(r.moved, "the pinned end was moved — the join is broken").toBe("start");
    expect(r.ends.x2).toBe(endBefore.x);
    expect(r.ends.y2, "the snapped endpoint drifted off its join").toBe(endBefore.y);
    expect(r.ends.y1, "the line was not actually made horizontal").toBe(r.ends.y2);
  });

  it("moves the END when only the START was snapped", () => {
    const line = nearlyHorizontal(0.4);
    const startBefore = { x: line.x1, y: line.y1 };
    const r = inferHorizontalVertical(line, { startPinned: true });
    expect(r.moved).toBe("end");
    expect(r.ends.x1).toBe(startBefore.x);
    expect(r.ends.y1).toBe(startBefore.y);
  });

  it("leaves a line alone when BOTH ends were placed on geometry", () => {
    // Two deliberate placements. Its angle is a consequence of them, and there
    // is no free end left to move — asserting horizontal here would either break
    // a join or hand the solver a constraint that fights the geometry.
    const line = nearlyHorizontal(0.4);
    const r = inferHorizontalVertical(line, { startPinned: true, endPinned: true });
    expect(r.kind, "a line joined at both ends was given an axis constraint anyway").toBeNull();
    expect(r.ends).toEqual(line);
  });

  it("keeps a vertical join intact too", () => {
    const line = nearlyVertical(0.5);
    const endBefore = { x: line.x2, y: line.y2 };
    const r = inferHorizontalVertical(line, { endPinned: true });
    expect(r.kind).toBe("vertical");
    expect(r.ends.x2).toBe(endBefore.x);
    expect(r.ends.y2).toBe(endBefore.y);
    expect(r.ends.x1).toBe(r.ends.x2);
  });

  it("measures the gap the old behaviour left, so the size in the report checks out", () => {
    // Reconstruct the bug: what the previous code did was unconditionally
    // `y2 = y1`. Over 40 mm at 0.05°, that is ~0.035 mm — "a few hundredths of a
    // millimetre", exactly as reported.
    const line = nearlyHorizontal(0.05);
    const oldGap = Math.abs(line.y2 - line.y1);
    expect(oldGap).toBeGreaterThan(0.01);
    expect(oldGap).toBeLessThan(0.1);
    // and the fix leaves no gap at the pinned end at all
    const r = inferHorizontalVertical(line, { endPinned: true });
    expect(Math.abs(r.ends.y2 - line.y2)).toBe(0);
  });
});

describe("which snaps count as a join", () => {
  it("geometry snaps pin the point", () => {
    for (const k of ["endpoint", "midpoint", "center"]) {
      expect(isGeometrySnap(k), `${k} should pin the point`).toBe(true);
    }
  });

  it("the grid and a free cursor do not", () => {
    // These are the user's hand, not a join to existing geometry, so auto-H/V is
    // still free to tidy them up — which is the behaviour that makes it useful.
    for (const k of ["free", "grid", "on-x", "on-y"]) {
      expect(isGeometrySnap(k), `${k} should not pin the point`).toBe(false);
    }
  });
});

// The pre-click badge for a line constraint (field report 636afdcb): "when
// working with lines, there is no visual feedback indicating that a constraint
// will be applied before clicking. The visual feedback appears to work only with
// points."
//
// The badge is DOM under a live sketch session, so what is pinned here is the
// property that makes it trustworthy — the preview runs the SAME inference the
// commit runs, with the same pinning — plus the two things that would make it
// misleading if they regressed: a pending badge that offers to delete a
// constraint that does not exist, or one that looks identical to a real one.
describe("the pre-click constraint badge", () => {
  it("cannot promise a constraint the commit would decline", () => {
    // Both call inferHorizontalVertical with the same arguments; if the preview
    // ever grows its own copy of the 3° rule, the two drift and the badge lies.
    const previewAt = sketchModeSrc.indexOf("previewPendingGlyph(");
    expect(previewAt, "no previewPendingGlyph in sketchMode — this test's anchor is stale").toBeGreaterThan(-1);
    const body = sketchModeSrc.slice(sketchModeSrc.indexOf("private previewPendingGlyph("));
    const fn = body.slice(0, body.indexOf("\n  }"));
    expect(fn, "the preview no longer uses the shared inference").toContain("inferHorizontalVertical(");
    expect(fn, "the preview ignores whether the line's start is pinned").toContain("startPinned: this.basePinned");
    expect(fn, "the preview ignores whether the cursor is on geometry").toContain("isGeometrySnap(cursorSnap)");
    expect(
      fn,
      "the preview no longer honours a typed angle, so it would promise an inference that "
        + "commitFromCursor skips",
    ).toContain('isUserDriven("angle")');
  });

  it("marks the badge as pending rather than as a real constraint", () => {
    const fn = sketchModeSrc.slice(sketchModeSrc.indexOf("private previewPendingGlyph("));
    expect(fn.slice(0, fn.indexOf("\n  }")), "the preview badge is not flagged pending").toContain("pending: true");
  });

  it("a pending badge is inert — there is nothing to delete", () => {
    // Offering a delete target for a constraint that does not exist yet is worse
    // than no affordance: clicking it would call onDelete with cIndex -1.
    const at = glyphRendererSrc.indexOf("if (g.pending)");
    expect(at, "SketchGlyphs no longer distinguishes a pending glyph").toBeGreaterThan(-1);
    const branch = glyphRendererSrc.slice(at, glyphRendererSrc.indexOf("continue;", at));
    expect(branch, "the pending badge does not carry its own class").toContain('"sketch-glyph pending"');
    expect(branch, "the pending badge wires a click handler — it must not be deletable").not.toContain("onDelete");
    expect(branch, "the pending badge does not say what it means").toContain("title");
  });

  it("looks different from a constraint that has actually been applied", () => {
    const at = cssSrc.indexOf(".sketch-glyph.pending {");
    expect(at, "no .sketch-glyph.pending rule — the badge is indistinguishable from a real one").toBeGreaterThan(-1);
    const r = cssSrc.slice(at, cssSrc.indexOf("}", at));
    expect(r, "the pending badge is not visually distinct").toMatch(/border-style:\s*dashed/);
    expect(r, "the pending badge still swallows pointer events").toContain("pointer-events: none");
  });
});
