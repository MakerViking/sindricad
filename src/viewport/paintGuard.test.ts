// setBodyPaint/setTexturePaint skip their (expensive) colour re-upload when the
// map is unchanged — 0.39 s of a 0.63 s no-op rebuild on the reference assembly.
// The guard has to be exact: a false "same" silently leaves the wrong colours on
// screen, because setModel painted with the PREVIOUS map before these run.
import { describe, it, expect } from "vitest";
import { sameStringMap } from "./viewport";

describe("sameStringMap", () => {
  it("treats identical content as same", () => {
    expect(sameStringMap({ a: "#fff", b: "#000" }, { a: "#fff", b: "#000" })).toBe(true);
  });
  it("is order-insensitive", () => {
    expect(sameStringMap({ a: "#fff", b: "#000" }, { b: "#000", a: "#fff" })).toBe(true);
  });
  it("catches a changed value", () => {
    expect(sameStringMap({ a: "#fff" }, { a: "#eee" })).toBe(false);
  });
  it("catches an added key", () => {
    expect(sameStringMap({ a: "#fff" }, { a: "#fff", b: "#000" })).toBe(false);
  });
  it("catches a removed key", () => {
    expect(sameStringMap({ a: "#fff", b: "#000" }, { a: "#fff" })).toBe(false);
  });
  it("catches a same-size key swap (length check alone is not enough)", () => {
    expect(sameStringMap({ a: "#fff" }, { b: "#fff" })).toBe(false);
  });
  it("handles both empty", () => {
    expect(sameStringMap({}, {})).toBe(true);
  });
  it("does not treat a missing key as equal to undefined", () => {
    expect(sameStringMap({ a: "#fff", b: "#000" }, { a: "#fff", c: "#000" })).toBe(false);
  });
});
