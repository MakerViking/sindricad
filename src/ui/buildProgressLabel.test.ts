// What the timeline chip calls a build it cannot describe.
//
// Field report a0a76571: "the meshing never finishes". Nothing was meshing. The
// sidecar publishes feature = -1 for "no feature is in progress", and until now
// nothing reset that between jobs and nothing announced a feature until AFTER it
// had finished — so a slow chamfer appended to a cached prefix ran its whole
// length with the previous job's -1 on the wire, and the chip called it
// "meshing…" at 0%. The user is watching a stage the kernel has not reached and
// a bar that cannot move, which is a fair reading of "never finishes".
//
// The sidecar half of that fix is in test_heartbeat.py (the running feature is
// now published before it runs). This is the fallback the frontend keeps for the
// case it cannot name: with no body counts to show, the honest word is
// "building".
import { describe, it, expect } from "vitest";
import { buildProgress } from "./timeline";

describe("the building chip's label", () => {
  it("says building, not meshing, when the sidecar has not said what it is on", () => {
    const { label, pct } = buildProgress(-1, -1, -1, 6);
    expect(
      label,
      "an un-named phase is reported as meshing — the user waits for a stage the " +
        "kernel may not have reached (a0a76571)",
    ).toBe("building…");
    expect(pct, "there is no denominator, so any bar position would be invented").toBe(0);
  });

  it("still counts bodies while meshing really is in flight", () => {
    // The control: the honest fallback must not cost the real meshing readout,
    // which is what the -1/-1 sentinel exists to be distinguishable from.
    expect(buildProgress(-1, 3, 12, 6)).toEqual({ label: "meshing 3/12", pct: 25 });
  });

  it("names the feature being built when the sidecar knows it", () => {
    expect(buildProgress(2, -1, -1, 6)).toEqual({ label: "building 3/6", pct: 50 });
  });
});
