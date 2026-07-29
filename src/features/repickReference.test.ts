import { describe, it, expect } from "vitest";
import { findSelectorAt, replaceSelectorAt, ambiguousDiagFor } from "./repickReference";
import type { Feature, Selector } from "../types";

const near = (p: [number, number, number]): Selector =>
  ({ kind: "face", by: "nearest", point: p }) as Selector;

const pressPull = (face: Selector | Selector[]): Feature =>
  ({ id: "f73", type: "press-pull", face, distance: 1, operation: "join" }) as Feature;

describe("findSelectorAt", () => {
  it("finds the selector in an array field by its stored point", () => {
    const f = { id: "f1", type: "shell", thickness: 2, faces: [near([0, 0, 0]), near([10, 2, 3])] } as Feature;
    expect(findSelectorAt(f, [10, 2, 3])).toEqual({ field: "faces", index: 1 });
  });

  it("finds a scalar selector field", () => {
    expect(findSelectorAt(pressPull(near([1, 2, 3])), [1, 2, 3])).toEqual({
      field: "face",
      index: null,
    });
  });

  // The sidecar rounds `at` to 6 decimals; the document keeps what the pick gave.
  it("tolerates the sidecar's rounding of the reported point", () => {
    const f = pressPull(near([-65.8189741234, 0.9, 7.0857141234]));
    expect(findSelectorAt(f, [-65.818974, 0.9, 7.085714])).not.toBeNull();
  });

  // Not an error: the user may have re-picked or edited since the failed build.
  it("returns null when no selector matches", () => {
    expect(findSelectorAt(pressPull(near([1, 2, 3])), [9, 9, 9])).toBeNull();
  });

  it("ignores non-nearest selectors", () => {
    const f = { id: "f1", type: "draft", angle: 3, axis: "Z", faces: [{ kind: "face", by: "normal", dir: [0, 0, 1] }] } as unknown as Feature;
    expect(findSelectorAt(f, [0, 0, 1])).toBeNull();
  });
});

describe("replaceSelectorAt", () => {
  it("preserves array arity and leaves siblings untouched", () => {
    const f = { id: "f1", type: "fillet", radius: 2, edges: [near([0, 0, 0]), near([1, 1, 1])] } as Feature;
    const patch = replaceSelectorAt(f, { field: "edges", index: 1 }, near([5, 5, 5])) as { edges: Selector[] };
    expect(patch.edges).toHaveLength(2);
    expect(patch.edges[0]).toEqual(near([0, 0, 0]));
    expect(patch.edges[1]).toEqual(near([5, 5, 5]));
  });

  it("keeps a scalar field scalar", () => {
    const patch = replaceSelectorAt(pressPull(near([1, 2, 3])), { field: "face", index: null }, near([4, 5, 6]));
    expect(patch).toEqual({ face: near([4, 5, 6]) });
  });
});

describe("ambiguousDiagFor", () => {
  const diags = [
    { feature_id: "f1", reason: "low confidence", kind: "face" },
    { feature_id: "f73", reason: "ambiguous nearest pick", kind: "face", at: [1, 2, 3] as [number, number, number] },
  ];
  it("picks only the ambiguous diagnostic for that feature", () => {
    expect(ambiguousDiagFor(diags, "f73")?.at).toEqual([1, 2, 3]);
    expect(ambiguousDiagFor(diags, "f1")).toBeUndefined();
    expect(ambiguousDiagFor(undefined, "f73")).toBeUndefined();
  });
});
