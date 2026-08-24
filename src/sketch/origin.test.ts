// A sketch has a fixed ORIGIN you can build from.
//
// Field report (2026-08-24, Doug): "if I use a point on what I assume to be
// X0,Y0, when I dimension to that point, it moves. I must be doing something
// wrong or am assuming something that does not hold true."
//
// He was assuming an origin existed. It did not. The Browser's Origin folder
// holds the three PLANES and nothing else; a sketch had no origin point and no
// axes, so a point drawn at 0,0 was an ordinary free entity and the solver was
// entitled to move it to satisfy a dimension.
//
// The tests below are in two groups, and the second group is the one that
// matters. "There is an entity at 0,0" is worth almost nothing on its own — the
// whole complaint is that the thing at 0,0 MOVED. So the load-bearing assertions
// are that it is pinned in the solver and that geometry attached to it is
// anchored by it.

import { describe, it, expect } from "vitest";
import { ORIGIN_ID, isOriginId, originEntity } from "./origin";
import sketchModeSrc from "./sketchMode.ts?raw";
import sketchSolveSrc from "./sketchSolve.ts?raw";

describe("the origin entity", () => {
  it("sits at 0,0 in plane coordinates", () => {
    const o = originEntity() as { type: string; id: string; x: number; y: number };
    expect(o.type).toBe("point");
    expect(o.x).toBe(0);
    expect(o.y).toBe(0);
    expect(o.id).toBe(ORIGIN_ID);
  });

  it("uses a reserved id that generated ids cannot collide with", () => {
    // newEntityId() produces short unprefixed ids; the double underscore is the
    // same guard TEXT_PREVIEW_ID uses.
    expect(ORIGIN_ID.startsWith("__")).toBe(true);
    expect(isOriginId(ORIGIN_ID)).toBe(true);
    expect(isOriginId("e1")).toBe(false);
    expect(isOriginId(undefined)).toBe(false);
  });

  it("is a `point`, so every existing picker handles it", () => {
    // Deliberately not a new entity type: `point` is already snappable
    // (snap.ts), a dimension reference (entityDims.dimRefPoints), a constraint
    // target (constraintTools.pickEndpoint), drawn (overlay), and ignored by
    // region detection. A new type would have needed all five taught about it.
    expect(originEntity().type).toBe("point");
  });
});

/** Exactly the `point` compile branch, bounded by the next `else if` — a fixed
 *  character count ran into the `projected` branch and read its code as this
 *  one's. */
function pointBranch(): string {
  const at = sketchSolveSrc.indexOf('} else if (e.type === "point") {');
  expect(at, "the point compile branch moved — this test no longer sees the pin").toBeGreaterThan(-1);
  const end = sketchSolveSrc.indexOf('} else if (', at + 10);
  expect(end).toBeGreaterThan(at);
  return sketchSolveSrc.slice(at, end);
}

describe("the origin is PINNED, which is the whole point", () => {
  // Source assertions: compiling a real solve needs the planegcs wasm, and what
  // is being pinned here is one line in the compile step. These pin the
  // EXPRESSION, and the ablation for them is that removing the pin fails them.
  it("is added to fixedPts when the solver compiles it", () => {
    expect(pointBranch()).toMatch(/if\s*\(isOriginId\(e\.id\)\)\s*fixedPts\.add\(/);
  });

  it("stays MERGEABLE as well as fixed", () => {
    // getPoint(..., true) is the mergeable flag. Fixed alone would be a point
    // nothing can attach to; mergeable alone is what it was before and is
    // exactly the bug. It has to be both: a user endpoint made coincident with
    // the origin FUSES onto a fixed point and is anchored by it.
    expect(pointBranch()).toMatch(/getPoint\(e\.x,\s*e\.y,\s*true\)/);
  });

  it("is not reported as projected geometry when it refuses a drag", () => {
    // projPts drives a "that is projected reference geometry" message. The
    // origin is not projected, and saying so would send the user looking for a
    // Project feature that does not exist.
    // Matched as CALLS, not as bare words: the code comment beside the pin names
    // projPts to explain why it is not used, and a `toContain("projPts")` check
    // was satisfied by that comment. Same trap featureEditReachable.test.ts
    // documents — a source test must pin the expression, not the identifier.
    const branch = pointBranch().replace(/\/\/[^\n]*/g, ""); // strip line comments
    expect(branch).not.toMatch(/pinProjected\s*\(/);
    expect(branch).not.toMatch(/projPts\s*\.\s*add\s*\(/);
  });
});

describe("the origin never reaches the document", () => {
  it("is stripped in snapshotFeature, beside the text preview", () => {
    const at = sketchModeSrc.indexOf("snapshotFeature(): Feature | null {");
    expect(at).toBeGreaterThan(-1);
    const body = sketchModeSrc.slice(at, at + 900);
    expect(body).toContain("isOriginId(e.id)");
    // If this ever stops holding, the origin starts being written into saved
    // documents as a real point entity, and every reopen adds another one.
    expect(body).toMatch(/entities:\s*this\.entities[\s\S]{0,120}?filter/);
  });

  it("is injected once per session, after the edit branch loads entities", () => {
    // After, so a document saved before the origin existed gains one on open.
    const inject = sketchModeSrc.indexOf("this.entities.unshift(originEntity());");
    const load = sketchModeSrc.indexOf("this.entities = resolveRealEntities(f, store.document.parameters);");
    expect(inject).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(-1);
    expect(inject).toBeGreaterThan(load);
  });

  it("survives a delete-selection", () => {
    const at = sketchModeSrc.indexOf("private deleteSelected(");
    const body = sketchModeSrc.slice(at > -1 ? at : 0);
    expect(body).toMatch(/!this\.selected\.has\(en\.id\)\s*\|\|\s*isOriginId\(en\.id\)/);
  });
});
