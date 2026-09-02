// A feature that BUILT but reported a diagnostic gets an amber chip, distinct
// from the red one a failing feature gets.
//
// Why this needs its own test: `regionStale` has been emitted by the sidecar for
// months and read by nothing in src/ (auto-memory: "emitted for months and read
// by nothing"). A diagnostic with no affordance behind it is indistinguishable
// from no diagnostic at all — the sealed-void backstop would have shipped
// invisible. The tier is keyed on "has diagnostics && no error" rather than on a
// list of codes, so the next batch (referenceNotFound / planeTilted /
// ambiguousReference / matchImplausible on kind:"face") lights the chip the day
// it lands; the last case here pins that generality against someone narrowing it
// to `code === "sealedVoid"`.
//
// Renders a REAL Timeline against the element stub (fakeDom.testkit) and reads
// the classes and hover text back off the chip, for the reason spelled out in
// featureEditReachable.test.ts: a source regex on the render call passes happily
// with the argument hard-coded at the call site.
import { describe, it, expect } from "vitest";
import { FakeEl, installFakeDocument, byClass } from "./fakeDom.testkit";
import { Timeline } from "./timeline";
import type { DocumentStore } from "../document/store";
import type { CadDocument, ResolveDiag, RebuildResult } from "../types";

installFakeDocument();

function renderChips(
  features: { id: string; type: string }[],
  diagnostics: ResolveDiag[],
  featureErrors: { feature_id?: string; message: string }[] = [],
): FakeEl[] {
  const root = new FakeEl("div");
  const store = {
    document: { features, parameters: {}, paramDefs: {} } as unknown as CadDocument,
    buildState: {
      building: false,
      result: { diagnostics, featureErrors } as unknown as RebuildResult,
    },
    busyState: { active: false, label: "", pct: null },
    rollbackIndex: features.length,
    isSuppressed: () => false,
    onDocChange: () => () => {},
    onBuild: () => () => {},
    onBusy: () => () => {},
  } as unknown as DocumentStore;
  const timeline = new Timeline(root as unknown as HTMLElement, store);
  timeline.select(null);
  return byClass(root, "timeline-node");
}

const sealedVoid: ResolveDiag = {
  feature_id: "x1",
  kind: "sealedVoid",
  resolved: 0,
  confidence: 0,
  lossy: false,
  reason: "This cut closed a cavity inside the body.",
  code: "sealedVoid",
  at: [0, 0, 2.5],
};

const FEATURES = [
  { id: "s1", type: "sketch" },
  { id: "x1", type: "extrude" },
];

describe("the timeline's amber diagnostic tier", () => {
  it("paints a diagnosed-but-successful feature amber, not red", () => {
    const chips = renderChips(FEATURES, [sealedVoid]);
    expect(chips.length, "the timeline rendered no chips — the store shim is wrong").toBe(2);
    const [sketch, extrude] = chips;
    expect(extrude!.classList.contains("warn"), "the diagnosed extrude is not amber").toBe(true);
    expect(
      extrude!.classList.contains("error"),
      "the build SUCCEEDED — an amber diagnostic must not paint the chip as a failure",
    ).toBe(false);
    expect(
      sketch!.classList.contains("warn"),
      "a feature with no diagnostic went amber — the tier is keyed on the wrong thing",
    ).toBe(false);
  });

  it("puts the diagnostic's own reason in the hover text", () => {
    // Without this the chip changes colour and says nothing, which is a worse
    // affordance than staying grey: the user can see something is wrong and has
    // no way to learn what.
    const [, extrude] = renderChips(FEATURES, [sealedVoid]);
    expect(extrude!.title, "the reason never reaches the tooltip the user hovers")
      .toContain("This cut closed a cavity inside the body.");
  });

  it("red wins: a failing feature stays red even when it also diagnosed", () => {
    const chips = renderChips(FEATURES, [sealedVoid], [{ feature_id: "x1", message: "boom" }]);
    const extrude = chips[1]!;
    expect(extrude.classList.contains("error"), "the failing chip lost its red").toBe(true);
    expect(
      extrude.classList.contains("warn"),
      "a failing feature must not also be amber — two tiers on one chip is not a tier",
    ).toBe(false);
    expect(extrude.title, "the error message is the useful one and must win the tooltip")
      .toContain("boom");
  });

  it("no diagnostics at all leaves every chip plain", () => {
    // The control. An unconditional `add(\"warn\")` passes the first case.
    for (const chip of renderChips(FEATURES, [])) {
      expect(chip.classList.contains("warn"), "a clean build painted a chip amber").toBe(false);
      expect(chip.classList.contains("error")).toBe(false);
    }
  });

  it("is generic: any diagnostic code lights it, not just sealedVoid", () => {
    // The tier exists ahead of the codes that will use it. Narrowing it to the
    // one code that ships today is the failure this pins.
    const planeTilted: ResolveDiag = {
      feature_id: "s1",
      kind: "face",
      resolved: 0,
      confidence: 0,
      lossy: true,
      reason: "Sketch: the face this sketch sits on has tilted.",
      code: "planeTilted",
      at: [0, 0, 5],
    };
    const [sketch, extrude] = renderChips(FEATURES, [planeTilted]);
    expect(
      sketch!.classList.contains("warn"),
      "a diagnostic the timeline has never heard of must still light the chip",
    ).toBe(true);
    expect(sketch!.title).toContain("has tilted");
    expect(extrude!.classList.contains("warn")).toBe(false);
  });

  it("a diagnostic with no feature_id is dropped rather than smeared", () => {
    // Guard against `find`-style code attaching an unattributed diagnostic to
    // the first (or every) chip. `feature_id` is OMITTED, not set to undefined —
    // exactOptionalPropertyTypes makes those two different types.
    const { feature_id: _dropped, ...orphan } = sealedVoid;
    for (const chip of renderChips(FEATURES, [orphan])) {
      expect(chip.classList.contains("warn"), "an unattributed diagnostic landed on a chip").toBe(false);
    }
  });
});
