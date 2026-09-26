// What a document that opens mostly hidden says about it (hiddenBodiesCue.ts).
import { describe, it, expect } from "vitest";
import { hiddenBodiesCue } from "./hiddenBodiesCue";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `body${i}`);
const hiddenFirst = (k: number) => (id: string) => Number(id.slice(4)) >= k;

describe("the hidden-bodies note on open", () => {
  it("warns when every body is hidden, because the view is empty", () => {
    const cue = hiddenBodiesCue(ids(340), () => false);
    expect(cue?.kind).toBe("warning");
    expect(cue?.message).toContain("340");
  });

  it("says so in the singular for a one-body document", () => {
    const cue = hiddenBodiesCue(ids(1), () => false);
    expect(cue?.kind).toBe("warning");
    expect(cue?.message).not.toMatch(/\b1 bodies\b/);
  });

  it("gives the numbers when more than half are hidden", () => {
    const cue = hiddenBodiesCue(ids(340), hiddenFirst(333)); // 333 hidden, 7 shown
    expect(cue?.kind).toBe("info");
    expect(cue?.message).toContain("333");
    expect(cue?.message).toContain("340");
  });

  it("says nothing about ordinary work: half or fewer hidden", () => {
    expect(hiddenBodiesCue(ids(4), hiddenFirst(2)), "exactly half").toBeNull();
    expect(hiddenBodiesCue(ids(10), hiddenFirst(1))).toBeNull();
    expect(hiddenBodiesCue(ids(10), () => true)).toBeNull();
    expect(hiddenBodiesCue([], () => false), "no bodies, nothing hidden").toBeNull();
  });

  it("counts only the bodies the build produced", () => {
    // A saved visibility entry for a body that no longer exists hides nothing,
    // so it must not tip the count. The caller passes the RESULT's ids; this
    // pins that the count is taken over exactly those.
    const visible = new Set(["body0", "body1"]);
    expect(hiddenBodiesCue(["body0", "body1", "body2"], (id) => visible.has(id))).toBeNull();
  });

  it("follows the copy rules: first person, no em-dash", () => {
    for (const cue of [hiddenBodiesCue(ids(3), () => false), hiddenBodiesCue(ids(1), () => false), hiddenBodiesCue(ids(5), hiddenFirst(4))]) {
      expect(cue).not.toBeNull();
      expect(cue!.message).not.toContain("—");
      expect(cue!.message).not.toMatch(/\bwe\b/i);
    }
  });
});
