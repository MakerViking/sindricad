import { describe, it, expect } from "vitest";
import { ExprError, extractRefs, isNumericLiteral, isReservedName, parseExpr, renameRefs } from "./parse";
import { evalExpr } from "./eval";

const ev = (src: string, values: Record<string, number> = {}) => evalExpr(src, values);

describe("expression evaluator", () => {
  it("arithmetic with precedence", () => {
    expect(ev("2 + 3 * 4")).toBe(14);
    expect(ev("(2 + 3) * 4")).toBe(20);
    expect(ev("10 - 4 - 3")).toBe(3); // left-assoc
    expect(ev("12 / 4 / 3")).toBe(1);
    expect(ev("2 * 3 ^ 2")).toBe(18);
    expect(ev("2 ^ 3 ^ 2")).toBe(512); // right-assoc
    expect(ev("-2 ^ 2")).toBe(-4); // math convention: -(2^2)
    expect(ev("2 ^ -2")).toBe(0.25);
    expect(ev("--3")).toBe(3);
    expect(ev("1.5e2 + .5")).toBe(150.5);
  });

  it("parameter references and PI", () => {
    expect(ev("width / 2 + 5", { width: 40 })).toBe(25);
    expect(ev("PI * d", { d: 2 })).toBeCloseTo(6.2832, 3);
    expect(ev("PI", { PI: 999 })).toBe(999); // a scope entry wins over the constant
    expect(() => ev("wdith", { width: 40 })).toThrow(/unknown parameter "wdith"/);
  });

  it("unit-suffix literals convert to canonical units", () => {
    expect(ev("1 in + 5 mm")).toBeCloseTo(30.4);
    expect(ev("2 cm")).toBe(20);
    expect(ev("30 deg")).toBe(30);
    expect(ev("1 rad")).toBeCloseTo(57.29578, 4);
    expect(ev("2*3 mm")).toBe(6); // suffix binds to the literal, not the product
  });

  it("tier-1 functions (trig in degrees, semicolon args)", () => {
    expect(ev("sin(30)")).toBeCloseTo(0.5);
    expect(ev("cos(60)")).toBeCloseTo(0.5);
    expect(ev("tan(45)")).toBeCloseTo(1);
    expect(ev("asin(0.5)")).toBeCloseTo(30);
    expect(ev("atan(1)")).toBeCloseTo(45);
    expect(ev("floor(2.7) + ceil(2.2) + round(2.5)")).toBe(8);
    expect(ev("abs(-3) + sqrt(16)")).toBe(7);
    expect(ev("min(3; 7)")).toBe(3);
    expect(ev("max(3; 7; 11)")).toBe(11);
    expect(ev("min(width; 10) * 2", { width: 4 })).toBe(8);
  });

  it("structural errors throw ExprError; arithmetic non-finites do not throw", () => {
    expect(() => ev("")).toThrow(ExprError);
    expect(() => ev("2 +")).toThrow(/unexpected end/);
    expect(() => ev("2 3")).toThrow(/unexpected/);
    expect(() => ev("(2 + 3")).toThrow(/missing "\)"/);
    expect(() => ev("blorp(3)")).toThrow(/unknown function/);
    expect(() => ev("if(1; 2; 3)")).toThrow(/not supported yet/);
    expect(() => ev("sin(1; 2)")).toThrow(/1 argument/);
    expect(() => ev("min(1)")).toThrow(/at least 2/);
    expect(() => ev("a.b", { a: 1 })).toThrow(/qualified names/);
    expect(() => ev("2 $ 3")).toThrow(/unexpected character/);
    expect(ev("1 / 0")).toBe(Infinity); // caller gates on isFinite
    expect(Number.isNaN(ev("sqrt(-1)"))).toBe(true);
  });

  it("extractRefs skips constants, functions, and unit suffixes", () => {
    expect(extractRefs("width/2 + d1*PI").sort()).toEqual(["d1", "width"]);
    expect(extractRefs("min(a; b) + 5 mm + sin(c)").sort()).toEqual(["a", "b", "c"]);
    expect(extractRefs("42")).toEqual([]);
    expect(extractRefs("a + a")).toEqual(["a"]); // deduped
  });

  it("renameRefs splices exact tokens only, preserving formatting", () => {
    expect(renameRefs("width/2 + 5", "width", "w")).toBe("w/2 + 5");
    expect(renameRefs("width + widths", "width", "w")).toBe("w + widths");
    expect(renameRefs("min(width; 2*width)", "width", "size")).toBe("min(size; 2*size)");
    expect(renameRefs("5 mm + width", "mm", "x")).toBe("5 mm + width"); // unit suffix untouched
    expect(renameRefs("a  +  b", "a", "alpha")).toBe("alpha  +  b"); // spacing kept
    expect(renameRefs("no_match", "x", "y")).toBe("no_match");
  });

  it("isNumericLiteral flags plain numbers, not formulas", () => {
    expect(isNumericLiteral("25")).toBe(true);
    expect(isNumericLiteral("-3.5")).toBe(true);
    expect(isNumericLiteral("5 mm")).toBe(true);
    expect(isNumericLiteral("width")).toBe(false);
    expect(isNumericLiteral("5+3")).toBe(false);
    expect(isNumericLiteral("not an expr $$")).toBe(false);
  });

  it("reserved names are recognized", () => {
    for (const n of ["sin", "if", "mm", "PI", "min", "random"]) expect(isReservedName(n)).toBe(true);
    for (const n of ["width", "d1", "thickness", "Sin"]) expect(isReservedName(n)).toBe(false);
  });

  it("parse keeps unit tags for a future dimensional checker", () => {
    const n = parseExpr("5 in");
    expect(n).toEqual({ t: "num", v: 127, unit: "in" });
  });
});
