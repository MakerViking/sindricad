import { describe, it, expect } from "vitest";
import { FORMAT_VERSION, migrateDocument } from "./migrate";
import type { CadDocument } from "../types";

const v1 = (doc: Partial<CadDocument>): CadDocument =>
  ({ parameters: {}, features: [], ...doc }) as CadDocument; // no version field = v1

describe("migrateDocument", () => {
  it("converts polygon.angle radians → degrees for v1 docs only", () => {
    const doc = v1({
      features: [{ id: "f1", type: "sketch", plane: "XY", entities: [
        { type: "polygon", id: "e1", x: 0, y: 0, radius: 10, sides: 6, angle: Math.PI / 2 },
      ] }],
    });
    migrateDocument(doc);
    const poly = (doc.features[0] as { entities: { angle: number }[] }).entities[0]!;
    expect(poly.angle).toBeCloseTo(90);

    const already = v1({ version: 2, features: [{ id: "f1", type: "sketch", plane: "XY", entities: [
      { type: "polygon", id: "e1", x: 0, y: 0, radius: 10, sides: 6, angle: 90 },
    ] }] });
    migrateDocument(already);
    expect((already.features[0] as { entities: { angle: number }[] }).entities[0]!.angle).toBe(90);
  });

  it("warns and leaves newer-version docs untouched", () => {
    const doc = v1({ version: FORMAT_VERSION + 1, parameters: { w: 4 } });
    const warnings = migrateDocument(doc);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/newer version/);
    expect(doc.paramDefs).toBeUndefined();
  });

  it("converts bare-name feature fields to dN model params and seeds user params", () => {
    const doc = v1({
      parameters: { thickness: 5 },
      features: [
        { id: "f2", type: "extrude", sketch: "f1", distance: "thickness", operation: "new" },
        { id: "f4", type: "extrude", sketch: "f1", distance: "thickness", operation: "cut" },
      ],
    });
    migrateDocument(doc);
    expect((doc.features[0] as { distance: number }).distance).toBe(5);
    expect((doc.features[1] as { distance: number }).distance).toBe(5);
    expect(doc.paramDefs!["thickness"]).toEqual({ expr: "5", value: 5, unit: "mm" });
    expect(doc.paramDefs!["d1"]).toEqual({
      expr: "thickness", value: 5, unit: "mm",
      target: { kind: "feature", feature: "f2", field: "distance" },
    });
    expect(doc.paramDefs!["d2"]!.target).toEqual({ kind: "feature", feature: "f4", field: "distance" });
  });

  it("binds rigid-entity fields but leaves solved geometry on the legacy path", () => {
    const doc = v1({
      parameters: { r: 8, width: 40 },
      features: [{ id: "f1", type: "sketch", plane: "XY", entities: [
        { type: "polygon", id: "e1", x: 0, y: 0, radius: "r", sides: 6, angle: 0 },
        { type: "rectangle", id: "e2", width: "width", height: 20, x: 0, y: 0 },
      ] }],
    });
    migrateDocument(doc);
    const [poly, rect] = (doc.features[0] as { entities: Record<string, unknown>[] }).entities;
    expect(poly!["radius"]).toBe(8); // bound: solver never writes rigid shapes
    expect(rect!["width"]).toBe("width"); // NOT bound: the solver owns rectangles
    const dPoly = Object.values(doc.paramDefs!).find((d) => d.target?.kind === "entity");
    expect(dPoly?.target).toEqual({ kind: "entity", sketch: "f1", entity: "e1", field: "radius" });
  });

  it("stamps ids on dimension constraints and keeps existing ones", () => {
    const doc = v1({
      features: [{ id: "f1", type: "sketch", plane: "XY", entities: [], constraints: [
        { type: "distance", id: "c7", line: "e1", value: 10 },
        { type: "radius", e: "e2", value: 4 },
        { type: "horizontal", line: "e1" }, // not a dim: no id
      ] }],
    });
    migrateDocument(doc);
    const cs = (doc.features[0] as { constraints: Record<string, unknown>[] }).constraints;
    expect(cs[0]!["id"]).toBe("c7");
    expect(cs[1]!["id"]).toMatch(/^c\d+$/);
    expect(cs[1]!["id"]).not.toBe("c7"); // loaded ids are reserved before stamping
    expect(cs[2]!["id"]).toBeUndefined();
  });

  it("is idempotent and leaves empty docs without a paramDefs key", () => {
    const doc = v1({
      parameters: { thickness: 5 },
      features: [{ id: "f2", type: "extrude", sketch: "f1", distance: "thickness", operation: "new" }],
    });
    migrateDocument(doc);
    const once = JSON.stringify(doc);
    migrateDocument(doc);
    expect(JSON.stringify(doc)).toBe(once);

    const empty = v1({});
    migrateDocument(empty);
    expect("paramDefs" in empty).toBe(false);
  });

  it("v3 (projected entities) is a no-op stamp: v3 docs pass through unchanged, twice", () => {
    // Pins the current format so a version bump has to come past these tests.
    // v5 moved geometry OUT of the document (inline base64 `brep` -> the `geom`
    // content hash carried in the container), but a v3 document still passes
    // through migrateDocument untouched: `brep` is still READ, so nothing here
    // rewrites it.
    expect(FORMAT_VERSION).toBe(5);
    const doc = v1({
      version: 3,
      features: [{ id: "f1", type: "sketch", plane: "XY", entities: [
        { type: "projected", id: "p1",
          source: { kind: "edge", body: "body1",
            sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
          curve: { kind: "line", x1: 0, y1: 0, x2: 20, y2: 0 } },
      ] }],
    });
    const before = JSON.stringify(doc);
    expect(migrateDocument(doc)).toEqual([]); // in-format: no warnings
    expect(JSON.stringify(doc)).toBe(before);
    migrateDocument(doc); // idempotent
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("v4 (offset constraint + sketch planeId) is a no-op stamp too", () => {
    const doc = v1({
      version: 4,
      features: [
        { id: "dp", type: "datumPlane", plane: "XY", offset: 12 },
        // planeId keeps the datum link; plane stays as the resolved cache
        { id: "f1", type: "sketch", planeId: "dp",
          plane: { origin: [0, 0, 12], normal: [0, 0, 1], xdir: [1, 0, 0] },
          entities: [{ type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
                     { type: "circle", id: "c2", radius: 7, x: 0, y: 0 }],
          constraints: [{ type: "offset", id: "k1", pairs: [{ src: "c1", cpy: "c2" }], value: 2 }] },
      ],
    });
    const before = JSON.stringify(doc);
    expect(migrateDocument(doc)).toEqual([]); // in-format: no warnings
    expect(JSON.stringify(doc)).toBe(before);
    migrateDocument(doc); // idempotent
    expect(JSON.stringify(doc)).toBe(before);
  });
});
