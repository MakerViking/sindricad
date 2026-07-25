import { describe, it, expect } from "vitest";
import type { CadDocument, ParamDef } from "../types";
import {
  boundParam, commitDeleteParam, commitFieldExpr, commitRenameParam,
  deleteBlockers, defsOf, isBound, nextDName, recompute, referencesTo, validateExpr, validateName,
} from "./engine";

/** doc with one sketch (polygon e1 + a radius dim c1) and one extrude f2 */
function fixture(defs: Record<string, ParamDef> = {}): CadDocument {
  return {
    parameters: Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.value])),
    paramDefs: defs,
    features: [
      {
        id: "f1", type: "sketch", plane: "XY",
        entities: [{ type: "polygon", id: "e1", x: 0, y: 0, radius: 10, sides: 6, angle: 0 }],
        constraints: [{ type: "radius", id: "c1", e: "e9", value: 4 }],
      },
      { id: "f2", type: "extrude", sketch: "f1", distance: 5, operation: "new" },
    ],
  };
}

describe("params engine", () => {
  it("recomputes in dependency order and writes bound fields", () => {
    const doc = fixture({
      width: { expr: "40", value: 0, unit: "mm" },
      half: { expr: "width / 2", value: 0, unit: "mm" },
      d1: { expr: "half + 5", value: 0, unit: "mm", target: { kind: "feature", feature: "f2", field: "distance" } },
    });
    const r = recompute(doc);
    expect(r.issues).toEqual({});
    expect(doc.paramDefs!["half"]!.value).toBe(20);
    expect((doc.features[1] as { distance: number }).distance).toBe(25);
    expect(doc.parameters).toEqual({ width: 40, half: 20, d1: 25 });
  });

  it("reports the sketch for constraint/entity targets", () => {
    const doc = fixture({
      r: { expr: "8", value: 0, unit: "mm", target: { kind: "constraint", sketch: "f1", constraint: "c1" } },
    });
    const r = recompute(doc);
    expect([...r.affectedSketches]).toEqual(["f1"]);
    const c = (doc.features[0] as { constraints: { value: number }[] }).constraints[0]!;
    expect(c.value).toBe(8);
  });

  it("coerces integer fields (polygon sides rounds and clamps to 3)", () => {
    const doc = fixture({
      n: { expr: "10 / 3", value: 0, unit: "count", target: { kind: "entity", sketch: "f1", entity: "e1", field: "sides" } },
    });
    recompute(doc);
    expect((doc.features[0] as { entities: { sides: number }[] }).entities[0]!.sides).toBe(3);
    doc.paramDefs!["n"]!.expr = "1.2";
    recompute(doc);
    expect((doc.features[0] as { entities: { sides: number }[] }).entities[0]!.sides).toBe(3); // min
  });

  it("keeps cached values on cycles and non-finite results, with issues", () => {
    const doc = fixture({
      a: { expr: "b + 1", value: 11, unit: "mm" },
      b: { expr: "a + 1", value: 10, unit: "mm" },
      w: { expr: "0", value: 0, unit: "mm" },
      q: { expr: "10 / w", value: 99, unit: "mm" },
    });
    const r = recompute(doc);
    expect(r.issues["a"]).toMatch(/circular/);
    expect(r.issues["b"]).toMatch(/circular/);
    expect(r.issues["q"]).toMatch(/finite/);
    expect(doc.paramDefs!["a"]!.value).toBe(11); // cache kept
    expect(doc.paramDefs!["q"]!.value).toBe(99);
  });

  it("validateExpr rejects unknown refs, self-refs, cycles, and unit suffixes in count fields", () => {
    const doc = fixture({
      a: { expr: "10", value: 10, unit: "mm" },
      b: { expr: "a * 2", value: 20, unit: "mm" },
    });
    expect(validateExpr(doc, null, "a + missing")).toMatchObject({ ok: false, error: expect.stringMatching(/unknown parameter "missing"/) });
    expect(validateExpr(doc, "a", "a + 1")).toMatchObject({ ok: false, error: expect.stringMatching(/itself/) });
    expect(validateExpr(doc, "a", "b / 2")).toMatchObject({ ok: false, error: expect.stringMatching(/circular reference: a → b → a/) });
    expect(validateExpr(doc, null, "3 mm", "count")).toMatchObject({ ok: false, error: expect.stringMatching(/unitless/) });
    expect(validateExpr(doc, null, "1 / 0")).toMatchObject({ ok: false, error: expect.stringMatching(/finite/) });
    expect(validateExpr(doc, null, "a + b")).toMatchObject({ ok: true, value: 30 });
  });

  it("binds a field lazily to the next dN and reuses the binding", () => {
    const doc = fixture({ w: { expr: "40", value: 40, unit: "mm" } });
    const target = { kind: "feature", feature: "f2", field: "distance" } as const;
    expect(boundParam(doc, target)).toBeNull();
    commitFieldExpr(doc, target, "w / 4", "length");
    recompute(doc); // in the app, store.mutate() owns this
    expect(boundParam(doc, target)).toBe("d1");
    expect((doc.features[1] as { distance: number }).distance).toBe(10);
    expect(isBound(doc, target)).toBe(true);
    commitFieldExpr(doc, target, "25", "length"); // plain literal keeps the SAME param
    recompute(doc);
    expect(boundParam(doc, target)).toBe("d1");
    expect(defsOf(doc)["d2"]).toBeUndefined();
    expect(isBound(doc, target)).toBe(false); // literal ⇒ not fx
    expect(nextDName(defsOf(doc))).toBe("d2");
  });

  it("rename rewrites expressions and legacy bare-name fields", () => {
    const doc = fixture({
      width: { expr: "40", value: 40, unit: "mm" },
      d1: { expr: "width / 2", value: 20, unit: "mm", target: { kind: "feature", feature: "f2", field: "distance" } },
    });
    (doc.features[1] as unknown as Record<string, unknown>)["distance"] = "width"; // legacy bare name
    commitRenameParam(doc, "width", "w");
    recompute(doc);
    expect(defsOf(doc)["w"]).toBeDefined();
    expect(defsOf(doc)["width"]).toBeUndefined();
    expect(defsOf(doc)["d1"]!.expr).toBe("w / 2");
    // the legacy field followed the rename, then the engine wrote the bound number back over it
    expect((doc.features[1] as { distance: number }).distance).toBe(20);
    expect(validateName(defsOf(doc), "w")).toMatch(/already exists/);
    expect(validateName(defsOf(doc), "sin")).toMatch(/reserved/);
    expect(validateName(defsOf(doc), "d7")).toMatch(/model parameters/);
    expect(validateName(defsOf(doc), "9lives")).toMatch(/letters/);
    expect(validateName(defsOf(doc), "ok_name")).toBeNull();
  });

  it("delete refuses while referenced, naming the sites", () => {
    const doc = fixture({
      width: { expr: "40", value: 40, unit: "mm" },
      d1: { expr: "width / 2", value: 20, unit: "mm", target: { kind: "feature", feature: "f2", field: "distance" } },
    });
    expect(deleteBlockers(doc, "width")).toMatch(/referenced by: d1/);
    expect(deleteBlockers(doc, "nope")).toMatch(/no parameter/);
    expect(deleteBlockers(doc, "d1")).toBeNull();
    commitDeleteParam(doc, "d1");
    recompute(doc);
    expect(defsOf(doc)["d1"]).toBeUndefined();
    expect(deleteBlockers(doc, "width")).toBeNull();
    expect(referencesTo(doc, "width")).toEqual([]);
  });

  it("GCs dangling unreferenced model params; keeps referenced ones with an issue", () => {
    const doc = fixture({
      gone: { expr: "5", value: 5, unit: "mm", target: { kind: "feature", feature: "fX", field: "distance" } },
      kept: { expr: "6", value: 6, unit: "mm", target: { kind: "constraint", sketch: "f1", constraint: "cX" } },
      user: { expr: "kept * 2", value: 12, unit: "mm" },
    });
    const r = recompute(doc);
    expect(defsOf(doc)["gone"]).toBeUndefined();
    expect(defsOf(doc)["kept"]).toBeDefined();
    expect(r.issues["kept"]).toMatch(/no longer exists/);
    expect(doc.parameters["user"]).toBe(12); // still evaluates off the kept cache
  });

  it("legacy bare-name references block delete", () => {
    const doc = fixture({ width: { expr: "40", value: 40, unit: "mm" } });
    (doc.features[1] as unknown as Record<string, unknown>)["distance"] = "width";
    expect(deleteBlockers(doc, "width")).toMatch(/extrude f2 · distance/);
  });
});
