import { describe, expect, it } from "vitest";

import { BODY_SLOT, featureErrorText } from "./featureErrorText";

/**
 * The sidecar leaves a `{body}` slot where a body's name belongs, because the
 * name is document text and prose is the one channel untrusted text cannot be
 * picked back out of (sidecar/untrusted.py). Filling it is this function's job.
 *
 * NOT COVERED: the DOM patching in timeline.ts and the toast in main.ts. This
 * repo has no jsdom, deliberately, so the composition is extracted and tested
 * and the rendering is not. Same split as buildAssemblyGroups.
 */

const BODIES = [
  { id: "body1", name: "Bracket Left" },
  { id: "body2", name: "Plate" },
];

describe("featureErrorText", () => {
  it("fills the slot from the live body name", () => {
    expect(
      featureErrorText(
        { message: `no face found to shell on ${BODY_SLOT}`, body_id: "body1" },
        BODIES,
      ),
    ).toBe("no face found to shell on Bracket Left");
  });

  it("keeps the name where the sentence puts it, not at the end", () => {
    // The whole reason this is a slot and not an appended suffix: the name is
    // mid-sentence here, and no append-the-name rule reproduces that.
    expect(
      featureErrorText(
        { message: `Fillet failed on ${BODY_SLOT}: BOPAlgo_AlertSolidBuilderFailed`, body_id: "body2" },
        BODIES,
      ),
    ).toBe("Fillet failed on Plate: BOPAlgo_AlertSolidBuilderFailed");
  });

  it("prefers the live name over the subject the error was built with", () => {
    // `subject` is the name as it stood when the build failed; the body may have
    // been renamed since, and the user is looking at the current tree.
    expect(
      featureErrorText(
        { message: `x on ${BODY_SLOT}`, body_id: "body2", subject: "Old Name" },
        BODIES,
      ),
    ).toBe("x on Plate");
  });

  it("falls back to subject when the body is gone, then to a neutral phrase", () => {
    expect(
      featureErrorText({ message: `x on ${BODY_SLOT}`, body_id: "gone", subject: "Consumed" }, BODIES),
    ).toBe("x on Consumed");
    expect(featureErrorText({ message: `x on ${BODY_SLOT}`, body_id: "gone" }, BODIES)).toBe(
      "x on this body",
    );
    expect(featureErrorText({ message: `x on ${BODY_SLOT}` }, undefined)).toBe("x on this body");
  });

  it("leaves a message with no slot completely alone", () => {
    // Appending a body to a message that never claimed one would invent a claim.
    const msg = "Shell: thickness must not be 0";
    expect(featureErrorText({ message: msg, body_id: "body1" }, BODIES)).toBe(msg);
  });

  it("treats the name as data, not as a replacement pattern", () => {
    // String.replace interprets $&, $` and $' in the REPLACEMENT. A body named
    // `$&` would otherwise splice the matched token back into its own
    // substitution. Names come from STEP files; they are not format strings.
    expect(
      featureErrorText({ message: `on ${BODY_SLOT}`, body_id: "b" }, [{ id: "b", name: "$& $` $'" }]),
    ).toBe("on $& $` $'");
  });

  it("fills every occurrence of the slot", () => {
    expect(
      featureErrorText({ message: `${BODY_SLOT} vs ${BODY_SLOT}`, body_id: "body2" }, BODIES),
    ).toBe("Plate vs Plate");
  });

  it("bounds a name that arrived unbounded", () => {
    const long = "P".repeat(500);
    const out = featureErrorText({ message: `on ${BODY_SLOT}`, body_id: "b" }, [{ id: "b", name: long }]);
    expect(out.length).toBeLessThan(140);
    expect(out.startsWith("on PPP")).toBe(true);
  });

  it("does not treat a blank name as a name", () => {
    expect(
      featureErrorText({ message: `on ${BODY_SLOT}`, body_id: "b", subject: "Fallback" }, [
        { id: "b", name: "   " },
      ]),
    ).toBe("on Fallback");
  });
});
