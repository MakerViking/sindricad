import { describe, it, expect } from "vitest";
import { findSelectorAt, replaceSelectorAt, repairableDiagFor } from "./repickReference";
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

  // GH #52. The field is called `face` on a sketch DELIBERATELY, so the shipped
  // repair covers a face-anchored sketch with no new plumbing. That name is the
  // whole mechanism: SELECTOR_FIELDS is a fixed list, and a sketch that stored
  // its anchor under any other key would report "re-pick the face" with nothing
  // able to find the selector to swap. The RED control for this is renaming the
  // field — see the sibling case below.
  const anchoredSketch = (field: string, sel: Selector): Feature =>
    ({ id: "s2", type: "sketch", plane: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] },
       [field]: sel, entities: [] }) as unknown as Feature;

  it("finds a face-anchored SKETCH's selector by the diagnostic's point", () => {
    const f = anchoredSketch("face", { ...near([9.5, 0, 5]), body: "body1" } as Selector);
    expect(findSelectorAt(f, [9.5, 0, 5])).toEqual({ field: "face", index: null });
  });

  it("finds a face-anchored DATUM PLANE's selector the same way", () => {
    const f = { id: "dp1", type: "datumPlane", plane: "XY", offset: 3,
                face: { ...near([9.5, 0, 5]), body: "body1" } } as unknown as Feature;
    expect(findSelectorAt(f, [9.5, 0, 5])).toEqual({ field: "face", index: null });
  });

  it("cannot find the anchor under any other field name", () => {
    // The name is load-bearing, not cosmetic: this is what the sketch arm would
    // look like if `face` were spelled `faceRef`, and the repair goes dead.
    const f = anchoredSketch("faceRef", { ...near([9.5, 0, 5]), body: "body1" } as Selector);
    expect(findSelectorAt(f, [9.5, 0, 5])).toBeNull();
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

describe("repairableDiagFor", () => {
  const diags = [
    { feature_id: "f1", reason: "low confidence", kind: "face" },
    { feature_id: "f73", reason: "ambiguous nearest pick", kind: "face", at: [1, 2, 3] as [number, number, number] },
  ];
  it("picks only the ambiguous diagnostic for that feature", () => {
    expect(repairableDiagFor(diags, "f73")?.at).toEqual([1, 2, 3]);
    expect(repairableDiagFor(diags, "f1")).toBeUndefined();
    expect(repairableDiagFor(undefined, "f73")).toBeUndefined();
  });

  it("matches the machine-readable code, whatever the prose says", () => {
    // the sidecar is free to reword a message; that must not disable Re-pick
    const coded = [
      { feature_id: "f9", code: "ambiguousReference", reason: "some entirely new wording", kind: "edge", at: [4, 5, 6] as [number, number, number] },
    ];
    expect(repairableDiagFor(coded, "f9")?.at).toEqual([4, 5, 6]);
  });

  it("still matches a legacy diagnostic that carries only the old prose", () => {
    // an older sidecar (server.py run by hand from another checkout) emits no
    // code at all — the fallback is what keeps Re-pick working against it
    const legacy = [
      { feature_id: "f7", reason: "ambiguous nearest pick", kind: "face", at: [7, 8, 9] as [number, number, number] },
    ];
    expect(repairableDiagFor(legacy, "f7")?.at).toEqual([7, 8, 9]);
  });

  it("ignores a coded diagnostic with no point to re-pick at", () => {
    const noAt = [{ feature_id: "f5", code: "ambiguousReference", kind: "edge" }];
    expect(repairableDiagFor(noAt, "f5")).toBeUndefined();
  });

  // GH #52: a face-anchored sketch FALLS BACK rather than failing the build, and
  // says why. Those codes are answered by the same gesture — pick the face again
  // — so they must offer the button. Before the rename only `ambiguousReference`
  // did, which would have left the sidecar writing "Re-pick the face." with
  // nothing behind it: another regionStale.
  it.each(["referenceNotFound", "matchImplausible"])(
    "offers the repair for a build-green %s diagnostic",
    (code) => {
      const d = [{ feature_id: "s2", code, kind: "face", reason: "…", at: [9.5, 0, 5] as [number, number, number] }];
      expect(repairableDiagFor(d, "s2")?.code).toBe(code);
    },
  );

  it("does not offer it for planeTilted, which a re-pick cannot clear", () => {
    // The sidecar filters candidate faces by the CACHED plane's normal and the
    // repair writes only the selector, so picking the tilted face reproduces the
    // identical diagnostic. Verified end to end in
    // sidecar/test_sketch_on_face.py; the prose for that code asks for the
    // gesture that does work instead of "Re-pick the face".
    const d = [{ feature_id: "s3", code: "planeTilted", kind: "face", reason: "…", at: [9.5, 0, 5] as [number, number, number] }];
    expect(repairableDiagFor(d, "s3")).toBeUndefined();
  });

  it("does not offer it for a diagnostic nobody can repair by picking a face", () => {
    // sealedVoid describes the RESULT of a cut. There is no reference to swap,
    // so a Re-pick button would be a lie.
    const d = [{ feature_id: "f4", code: "sealedVoid", kind: "sealedVoid", at: [0, 0, 0] as [number, number, number] }];
    expect(repairableDiagFor(d, "f4")).toBeUndefined();
  });
});
