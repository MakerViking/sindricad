// Properties panel: the pure pieces of the mesh-then-exact refine path.
//
// SCOPE, stated rather than implied: this repo has no jsdom, so the DOM patching
// in applyExact() and the seq-guard wiring inside createPanels() are NOT covered
// here. What IS covered is the two places the logic can be silently wrong —
// the exact-row formatting (units, the derived Mass row, the deliberately absent
// bbox row) and the priming-call guard. Both were extracted as pure functions
// for exactly this reason, the same call the assembly-tree tests made.
import { describe, expect, it } from "vitest";
import { exactPropsRows, afterFirstCall } from "./panels";
import type { MassPropertiesResult } from "../types";

// A cylinder r5 h20 — curved on purpose. The display mesh under-reports its
// volume by 0.97% (1555.55 against 1570.80), which is the entire reason this
// path exists; a box would agree to ~1e-9 and prove nothing.
const EXACT_VOLUME = 1570.796326794897;
const EXACT_AREA = 785.398163397448;
const MESH_VOLUME = 1555.551818;

function total(over: Partial<MassPropertiesResult["total"]> = {}): MassPropertiesResult["total"] {
  return {
    bodies: 1,
    volume: EXACT_VOLUME,
    area: EXACT_AREA,
    com: [1, 2, 3],
    bbox: { min: [-5, -5, -10], max: [5, 5, 10] },
    counts: {},
    ...over,
  };
}

function asMap(rows: [string, string][]) {
  return Object.fromEntries(rows);
}

describe("exactPropsRows", () => {
  it("formats the exact volume and area, not the tessellated ones", () => {
    const m = asMap(exactPropsRows(total()));
    expect(m.volume).toContain("1570.79");
    expect(m.volume).not.toContain("1555");
    expect(m.area).toContain("785.39");
  });

  it("recomputes Mass from the exact volume", () => {
    // Mass is derived client-side and absent from the reply. Left alone it keeps
    // the mesh figure under a hint claiming every row is exact — the worst case,
    // because it looks corrected. Compared numerically so the assertion does not
    // depend on the formatter's precision.
    const m = asMap(exactPropsRows(total()));
    const grams = Number.parseFloat(m.mass ?? "");
    expect(grams).toBeCloseTo(EXACT_VOLUME / 1000, 2);
    expect(Math.abs(grams - MESH_VOLUME / 1000)).toBeGreaterThan(0.01);
  });

  it("omits the bounding box row", () => {
    // Deliberate: that row shows DIMENSIONS derived from the same triangulation
    // the sidecar measured, so there is nothing to correct. Patching it would
    // rewrite a correct value with an identical one and imply it had been wrong.
    const m = asMap(exactPropsRows(total()));
    expect(m.bbox).toBeUndefined();
  });

  it("omits the centre row when there is no centre to report", () => {
    // com is null when the total volume is zero — nothing to weight the mean by.
    const m = asMap(exactPropsRows(total({ com: null, volume: 0 })));
    expect(m.com).toBeUndefined();
    expect(m.volume).toBeDefined();
  });

  it("carries a unit suffix on every dimensional row", () => {
    // The reply is always mm. If a value is substituted raw, someone working in
    // inches silently reads millimetres.
    const m = asMap(exactPropsRows(total()));
    expect(m.volume).toMatch(/[³]/);
    expect(m.area).toMatch(/[²]/);
    expect(m.mass).toMatch(/ g$/);
  });
});

describe("afterFirstCall", () => {
  it("swallows the first invocation and runs every one after it", () => {
    // store.onDocChange invokes its listener SYNCHRONOUSLY at subscribe time. A
    // staleness guard registered naively fires during setup, supersedes every
    // request made afterwards, and the exact values never land — silently, in a
    // way indistinguishable from the sidecar being down.
    let n = 0;
    const g = afterFirstCall(() => { n++; });
    g();
    expect(n).toBe(0); // the priming call
    g();
    g();
    expect(n).toBe(2);
  });

  it("primes independently per wrapper", () => {
    let a = 0, b = 0;
    const ga = afterFirstCall(() => { a++; });
    const gb = afterFirstCall(() => { b++; });
    ga(); ga();
    expect(a).toBe(1);
    expect(b).toBe(0); // gb has not been primed by ga
    gb(); gb();
    expect(b).toBe(1);
  });
});
