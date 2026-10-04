import { describe, it, expect } from "vitest";
import { FORMAT_VERSION, migrateDocument, savedVersion } from "./migrate";
import type { CadDocument, Feature, SketchConstraint, SketchEntity } from "../types";
import { t } from "../i18n";

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
    // rewrites it. v6 (shape operands) is a stamp too, and only on a document
    // that uses them.
    expect(FORMAT_VERSION).toBe(6);
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

  it("the sketch/datum `face` anchor does NOT bump FORMAT_VERSION", () => {
    // GH #52 adds one optional key to two feature arms — the same shape as the
    // v3->v4 `planeId` addition above, and it gets the same answer: no bump.
    // A bump costs every OLDER build the "made by a newer version — unknown data
    // may be lost" warning on EVERY document the new build saves, including the
    // overwhelming majority that carry no anchor at all. `plane` stays written
    // as the resolved cache, so an old build still places the sketch correctly;
    // it simply stops following the face. (v6 does not undo this: it is
    // stamped only on a document that names a shape's corner, centre or side,
    // savedVersion below.)
    const doc = v1({
      version: 5,
      features: [
        { id: "b1", type: "box", length: 20, width: 20, height: 10 },
        { id: "s1", type: "sketch",
          plane: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] },
          face: { kind: "face", by: "nearest", point: [9.5, 0, 5], body: "body1" },
          entities: [{ type: "circle", id: "c1", radius: 3, x: 0, y: 0 }] },
        { id: "dp1", type: "datumPlane", plane: "XY", offset: 4,
          face: { kind: "face", by: "nearest", point: [9.5, 0, 5], body: "body1" } },
      ],
    });
    expect(savedVersion(doc.features)).toBe(5);
    const before = JSON.stringify(doc);
    expect(migrateDocument(doc)).toEqual([]); // in-format: no warnings
    expect(JSON.stringify(doc)).toBe(before); // and not one byte rewritten
    migrateDocument(doc); // idempotent
    expect(JSON.stringify(doc)).toBe(before);
  });
});

// Round 3 decision R1. What the tools make is pinned in io/olderBuildFormat
// (clicks, Finish, Save); this is every other spelling the document allows,
// against the sketch it sits in.
describe("savedVersion: v6 only for a sketch that names a shape's corner, centre or side", () => {
  const ents: SketchEntity[] = [
    { type: "polygon", id: "H", x: 0, y: 0, radius: 10, sides: 6, angle: 0 },
    { type: "slot", id: "S", x1: 10, y1: 0, x2: 40, y2: 0, width: 6 },
    { type: "rectangle", id: "R", x: 10, y: 5, width: 40, height: 20 },
    { type: "line", id: "l", x1: 30, y1: 20, x2: 40, y2: 30 },
    { type: "circle", id: "c", x: 0, y: 30, radius: 4 },
  ];
  const sketch = (...constraints: SketchConstraint[]): Feature[] =>
    [{ id: "f1", type: "sketch", plane: "XY", entities: ents, constraints }];

  it.each<[string, SketchConstraint]>([
    ["a polygon's corner dimensioned", { type: "p2pDistance", e1: "H", p1: 2, e2: "l", p2: 0, value: 12 }],
    ["a REFERENCE dimension to a polygon's centre", { type: "p2pDistance", e1: "H", p1: -1, e2: "l", p2: 0, value: 12, driven: true }],
    ["a slot side's end (the only spelling it has)", { type: "p2lDistance", e: "S~0", p: 0, line: "l", value: 5 }],
    ["a slot's axis", { type: "vertical", line: "S~2" }],
    ["a polygon's side in an offset", { type: "offset", pairs: [{ src: "H~1", cpy: "l" }], value: 2 }],
    ["a point on a polygon's side", { type: "pointOn", e: "l", p: 0, curve: "H~3" }],
    ["a point on a rectangle's side", { type: "pointOn", e: "l", p: 0, curve: "R~1" }],
    ["a rectangle's centre, second operand", { type: "coincident", e1: "l", p1: 1, e2: "R", p2: 4 }],
    ["a rectangle's centre fixed", { type: "fix", e: "R", p: 4 }],
  ])("%s", (_name, c) => {
    expect(savedVersion(sketch(c))).toBe(6);
  });

  it.each<[string, SketchConstraint[]]>([
    ["no constraints, polygon and slot drawn", []],
    ["a rectangle's corners and sides", [
      { type: "coincident", e1: "R", p1: 3, e2: "l", p2: 0 },
      { type: "parallel", l1: "R~0", l2: "l" },
      { type: "p2pDistance", e1: "R", p1: 0, e2: "R", p2: 2, value: 20 },
    ]],
    // an older build keeps a pointOn it does not know in the file (its
    // pruneConstraints' default arm): it stops holding it, it does not lose it
    ["a point on a plain line or circle", [
      { type: "pointOn", e: "l", p: 0, curve: "c" },
      { type: "pointOn", e: "c", p: 0, curve: "l" },
    ]],
  ])("%s stays v5", (_name, cs) => {
    expect(savedVersion(sketch(...cs))).toBe(5);
  });

  it("a polygon's number a parameter sets is no constraint: v5", () => {
    // the rigid-shape numbers bind through paramDefs, not through a constraint
    const poly: SketchEntity = { type: "polygon", id: "H", x: 0, y: 0, radius: "r", sides: 6, angle: 0 };
    expect(savedVersion([{ id: "f1", type: "sketch", plane: "XY", entities: [poly] }])).toBe(5);
  });

  it("this build reads v6 without a word; the build before it warns", () => {
    const doc = (): CadDocument => ({ version: 6, parameters: {}, features: sketch({ type: "fix", e: "H", p: -1 }) });
    expect(migrateDocument(doc())).toEqual([]);
    expect(migrateDocument(doc(), 5)).toEqual([t("file.warning.newerVersion")]);
  });
});
