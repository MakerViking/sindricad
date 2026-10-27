// The rule that turns a measured polygon offset into "stop trusting it", and the
// line a bug report carries. Healthy readings are the ones measured on a GPU and
// on llvmpipe (WebKitGTK 2.52.6): units 2^-24, slope x0.5 (the scan halves, so
// the true factor sits in 0.5..1).
import { describe as group, it, expect } from "vitest";
import { describe, offsetIsWrong, type SelfTest } from "./gpuSelfTest";

const healthy: SelfTest = { draw: "ok", less: "ok", clearDepthOnly: "ok", bits: 24, unitsK: 24, slopeRatio: 0.5, fragDepth: "ok" };

group("offsetIsWrong", () => {
  it("leaves a healthy 24-bit or 16-bit offset alone", () => {
    expect(offsetIsWrong(healthy)).toBe(false);
    expect(offsetIsWrong({ ...healthy, bits: 16, unitsK: 16 })).toBe(false);
    expect(offsetIsWrong({ ...healthy, slopeRatio: 1 })).toBe(false);
  });

  it("flags a push far bigger than any depth step, or a slope term far off", () => {
    expect(offsetIsWrong({ ...healthy, unitsK: 8 })).toBe(true);
    expect(offsetIsWrong({ ...healthy, slopeRatio: 16 })).toBe(true);
    expect(offsetIsWrong({ ...healthy, slopeRatio: 0.0625 })).toBe(true);
  });

  it("treats unknown as not wrong", () => {
    expect(offsetIsWrong({ ...healthy, unitsK: null, slopeRatio: null })).toBe(false);
  });
});

group("describe", () => {
  it("is one searchable line, with the error when there is one", () => {
    expect(describe(healthy)).toBe(
      "draw ok, less ok, depth-only clear ok, resolves 24 bits, offset units 2^-24, offset slope x0.5, fragDepth ok",
    );
    expect(describe({ ...healthy, bits: null, unitsK: null, error: "link: boom" })).toMatch(/resolves \? bits, offset units \?.*error: link: boom$/);
  });
});
