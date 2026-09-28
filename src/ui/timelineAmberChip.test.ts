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

  it("lists every distinct reason, not just the first, and caps a long list", () => {
    // A split over many bodies reports one warning per body, and its toast only
    // counts them (splitWarnings.ts), so the chip is where the user reads WHICH
    // bodies. First-reason-only showed one body out of 73 on the field file.
    const per = (i: number): ResolveDiag => ({ ...sealedVoid, reason: `note ${i}` });
    const [, two] = renderChips(FEATURES, [per(1), per(2), per(1)]);
    expect(two!.title).toContain("note 1");
    expect(two!.title, "the second body's reason never reaches the tooltip").toContain("note 2");
    expect(two!.title.split("note 1").length - 1, "a repeated reason is listed once").toBe(1);
    // the same sentence about two DIFFERENT bodies (two bodies both named "Box") is two lines
    const box = (b: string): ResolveDiag => ({ ...sealedVoid, reason: "cut on Box", body_id: b });
    const [, same] = renderChips(FEATURES, [box("body1"), box("body5"), box("body1")]);
    expect(same!.title.split("cut on Box").length - 1, "two bodies with one name collapsed into one line").toBe(2);
    const [, many] = renderChips(FEATURES, Array.from({ length: 20 }, (_x, i) => per(i)));
    expect(many!.title).toContain("note 11");
    expect(many!.title).not.toContain("note 12");
    expect(many!.title).toContain("and 8 more");
  });

  it("a split over many bodies names EVERY body in its tooltip, not the first twelve", () => {
    // The field file's "All visible" cut: 62 bodies with damaged parts left
    // whole and 11 only separated, one warning each. One line per warning cut
    // off after 12 left the toast's count ("62 bodies have damaged parts...")
    // the only trace of the other 50, and Q3 promised to NAME them.
    const split = { id: "sp", type: "split" };
    const note = (code: string, i: number, count?: number): ResolveDiag => ({
      feature_id: "sp", kind: code as ResolveDiag["kind"], code, resolved: 0, confidence: 0, lossy: false,
      reason: "r", body_id: `body${i}`, subject: `Part${i}`, ...(count === undefined ? {} : { count }),
    });
    const diags = [
      ...Array.from({ length: 62 }, (_x, i) => note("splitDamagedParts", i, 2)),
      ...Array.from({ length: 11 }, (_x, i) => note("splitSeparated", 100 + i)),
    ];
    const [, chip] = renderChips([FEATURES[0]!, split], diags);
    expect(chip!.classList.contains("warn")).toBe(true);
    for (let i = 0; i < 62; i++) expect(chip!.title, `Part${i}'s damaged parts are not named`).toContain(`2 in Part${i}`);
    for (let i = 100; i < 111; i++) expect(chip!.title, `Part${i} is not named`).toContain(`Part${i}`);
    expect(chip!.title, "the tooltip cut the list short").not.toMatch(/\d+ more/);
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
