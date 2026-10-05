import { describe, expect, it } from "vitest";

import { setMissingKeyReporter } from "../i18n";
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

// The split codes are the first TRANSLATIONS with a `{body}` slot in them, so
// these go through the real catalogue (locales/en.json), not a mock: the key
// has to exist, the plural has to pick, and the name has to land.
describe("featureErrorText on a coded split message", () => {
  // The sidecar's English, which the translation replaces.
  const english = (n: number) => `${n} parts of ${BODY_SLOT} cross the plane but are damaged, so I left them whole.`;

  it("translates, picks the plural from `count`, and names the body", () => {
    const d = (count: number) => ({ message: english(count), code: "splitDamagedParts", count, body_id: "body2" });
    expect(featureErrorText(d(1), BODIES)).toBe("1 part of Plate crosses the plane but is damaged, so I left it whole.");
    expect(featureErrorText(d(3), BODIES)).toBe("3 parts of Plate cross the plane but are damaged, so I left them whole.");
  });

  it("fills the slot in a translated error from the live name, then subject", () => {
    const e = { message: "x", code: "splitMissed", body_id: "body1", subject: "Built Name" };
    expect(featureErrorText(e, BODIES)).toBe("Split changed nothing: the plane does not pass through Bracket Left.");
    expect(featureErrorText(e, [])).toBe("Split changed nothing: the plane does not pass through Built Name.");
  });

  it("does not report the slot as a placeholder t() was never given", () => {
    // t() warns once per unfilled `{name}`, which in DEV is a console line on
    // every split error. The slot is filled HERE, after t(), so t() must be
    // handed it back as itself.
    const missing: string[] = [];
    setMissingKeyReporter((key) => missing.push(key));
    try {
      featureErrorText({ message: "x", code: "splitSeparated", body_id: "body2" }, BODIES);
    } finally {
      setMissingKeyReporter(() => {});
    }
    expect(missing).toEqual([]);
  });
});

// Field report 66d7eb71: once a lost projection's stale flag is saved, the
// Cut's error is the one message a reopened file shows, and it sends the user
// to a sketch. It names that sketch the way the Browser lists it.
describe("featureErrorText on a Cut placed by a lost projection", () => {
  const FEATURES = [
    { id: "f1", type: "sketch" },
    { id: "f2", type: "extrude", sketch: "f1" },
    { id: "f5", type: "sketch" },
    { id: "f6", type: "extrude", sketch: "f5" },
    { id: "f7", type: "sketch", name: "Holes" },
    { id: "f8", type: "extrude", sketch: "f7" },
  ];
  const cut = (feature_id: string) => ({ message: "x", code: "cutLostProjection", feature_id });

  it("names the failing feature's sketch as the Browser does", () => {
    const text = featureErrorText(cut("f6"), BODIES, FEATURES);
    expect(text).toMatch(/^Cut removed nothing: its profile is placed by a projected edge in Sketch2 that lost/);
    expect(text).toContain("Edit Sketch2, delete the amber edge, pick the edge again with Project");
    expect(text).toMatch(/If the profile is already where you meant it, drag the other way, or use Join\.$/);
    expect(featureErrorText(cut("f8"), BODIES, FEATURES)).toContain("Edit Holes, delete");
  });

  it("says 'its sketch' when it cannot tell which", () => {
    expect(featureErrorText(cut("f6"), BODIES)).toContain("in its sketch that lost");
    expect(featureErrorText(cut("gone"), BODIES, FEATURES)).toContain("Edit its sketch, delete");
  });

  it("reads a name holding the other slot's token as data", () => {
    const features = [{ id: "s", type: "sketch", name: `${BODY_SLOT} $&` }, { id: "x", type: "extrude", sketch: "s" }];
    expect(featureErrorText(cut("x"), BODIES, features)).toContain(`Edit ${BODY_SLOT} $&, delete`);
  });
});
