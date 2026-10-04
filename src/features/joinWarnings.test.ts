// What a join says when it left some of the pieces being joined out of the
// body: in the user's words, in a toast after the build and on the feature's
// amber timeline chip. Field report 9728490b: a Combine joined 135 small ribs
// onto a knob and 66 of them, floating microns off it, went with no word said.
import { describe, expect, it } from "vitest";
import { diagBodyName, diagnosticText, splitWarningsToShow, toastsWarnings } from "./splitWarnings";
import type { CadDocument, ResolveDiag, RebuildResult } from "../types";
import { FakeEl, installFakeDocument, byClass } from "../ui/fakeDom.testkit";
import { Timeline } from "../ui/timeline";
import type { DocumentStore } from "../document/store";

const bodies = [{ id: "body1", name: "Knob" }];
// The sidecar's English `reason` is a fallback only; the locale key wins.
// Deliberately NOT the locale's words, so a missing key shows up as this.
const note = (count: number, over: Partial<ResolveDiag> = {}): ResolveDiag => ({
  feature_id: "f45", kind: "joinPiecesLeftOut", code: "joinPiecesLeftOut", resolved: 0, confidence: 0, lossy: false,
  reason: "sidecar fallback about {body}", body_id: "body1", subject: "Body1", count, ...over,
});

describe("a join that left pieces out", () => {
  it("says how many, and why: tiny next to the joined body and not touching it", () => {
    expect(diagnosticText(note(66), bodies)).toBe(
      "I left 66 pieces out of the join because each is under a thousandth of the joined body's size and does " +
        "not touch it. Any gap counts, however small: make them overlap the body to keep them.",
    );
    expect(diagnosticText(note(1), bodies)).toBe(
      "I left 1 piece out of the join because it is under a thousandth of the joined body's size and does not " +
        "touch it. Any gap counts, however small: make it overlap the body to keep it.",
    );
  });

  it("never names the body: the joined body can go by the name of the piece that went", () => {
    // A Combine keeps the target's name and a Join extrude takes its first
    // hit's. When the target pin "Cylinder" is the piece left out, the result is
    // still called Cylinder, and "does not touch Cylinder" said the piece did not
    // touch itself. The same went for a target's own pieces ("ddr 2").
    const gone = [{ id: "body1", name: "Cylinder" }];
    expect(diagnosticText(note(1), gone)).not.toContain("Cylinder");
    expect(diagnosticText(note(66), bodies)).not.toContain("Knob");
  });

  it("lights the Combine's chip amber, not red, and its tooltip says it", () => {
    installFakeDocument();
    const features = [{ id: "f1", type: "box" }, { id: "f45", type: "combine" }];
    const root = new FakeEl("div");
    const store = {
      document: { features, parameters: {}, paramDefs: {} } as unknown as CadDocument,
      buildState: { building: false, result: { diagnostics: [note(66)], featureErrors: [] } as unknown as RebuildResult },
      busyState: { active: false, label: "", pct: null },
      rollbackIndex: features.length,
      isSuppressed: () => false,
      onDocChange: () => () => {},
      onBuild: () => () => {},
      onBusy: () => () => {},
    } as unknown as DocumentStore;
    new Timeline(root as unknown as HTMLElement, store).select(null);
    const [, chip] = byClass(root, "timeline-node");
    expect(chip!.classList.contains("warn"), "the Combine's chip is not amber").toBe(true);
    expect(chip!.classList.contains("error"), "the Combine's chip is red").toBe(false);
    expect(chip!.title).toContain(diagnosticText(note(66), bodies));
  });
});

describe("the toast after the build", () => {
  // main.ts (which cannot be imported in a test) calls splitWarningsToShow with
  // toastsWarnings on each feature's type; that is what decides the toast.
  const types: Record<string, string> = { f45: "combine", f7: "extrude", f8: "revolve" };
  const toasts = (fid: string) => toastsWarnings(types[fid]);
  const show = (list: ResolveDiag[], failed = new Set<string>()) =>
    splitWarningsToShow(list, toasts, failed, (d) => diagnosticText(d, bodies), (d) => diagBodyName(d, bodies));

  it("is raised for a Combine and for a Join-mode extrude or revolve that left pieces out", () => {
    const w = show([note(66), note(1, { feature_id: "f7" }), note(3, { feature_id: "f8" })]);
    expect(w.map((x) => x.featureId)).toEqual(["f45", "f7", "f8"]);
    expect(w[0]!.text).toBe(diagnosticText(note(66), bodies));
  });

  it("says only the pieces left out, not the feature's other notes, which stay on the chip", () => {
    const other: ResolveDiag = {
      feature_id: "f45", kind: "face", resolved: 1, confidence: 0.2, lossy: true, reason: "a reference note",
    };
    expect(show([other])).toEqual([]);
    const w = show([other, note(66)]);
    expect(w.map((x) => x.text)).toEqual([diagnosticText(note(66), bodies)]);
  });

  it("is not raised for a join that failed: its red toast says it", () => {
    expect(show([note(66)], new Set(["f45"]))).toEqual([]);
  });

  it("is said once per news: the same count again keys the same, another count does not", () => {
    const [a] = show([note(66)]);
    const [b] = show([note(66)]);
    const [c] = show([note(65)]);
    expect(b!.key).toBe(a!.key);
    expect(c!.key).not.toBe(a!.key);
  });
});

// A join stamped `joinTouchingOnly` drops nothing: a piece that touches nothing
// it joins stays in the body as a piece of its own (GH #41, and 9728490b's ribs
// on a new document), and the feature's chip says how many. Not a toast:
// nothing was lost, and in a run of Combines a piece apart after one step is
// often joined by the next.
describe("a join that kept pieces apart in the body", () => {
  const apart = (count: number, over: Partial<ResolveDiag> = {}): ResolveDiag =>
    note(count, { kind: "joinPiecesApart", code: "joinPiecesApart", ...over });
  const types: Record<string, string> = { f45: "combine", f7: "extrude" };
  const show = (list: ResolveDiag[]) =>
    splitWarningsToShow(list, (fid) => toastsWarnings(types[fid]), new Set(), (d) => diagnosticText(d, bodies), (d) =>
      diagBodyName(d, bodies),
    );

  it("says how many pieces are apart after this step, that any gap counts, and what to do about it", () => {
    expect(diagnosticText(apart(66), bodies)).toBe(
      "66 pieces I joined into Knob do not touch the rest of it, so after this step they are separate pieces of " +
        "the body. A gap too small to see still counts. Make them overlap to fuse them in, or use Separate into " +
        "bodies to give each a body of its own.",
    );
    expect(diagnosticText(apart(1), bodies)).toBe(
      "1 piece I joined into Knob does not touch the rest of it, so after this step it is a separate piece of the " +
        "body. A gap too small to see still counts. Make it overlap to fuse it in, or use Separate into bodies to " +
        "give it a body of its own.",
    );
  });

  it("is not toasted, from a Combine or a Join extrude", () => {
    expect(show([apart(66), apart(1, { feature_id: "f7" })])).toEqual([]);
    // ...while a join that left pieces out, in the same build, still is
    expect(show([apart(66), note(3, { feature_id: "f7" })]).map((x) => x.featureId)).toEqual(["f7"]);
  });

  it("lights the Combine's chip amber, not red, and its tooltip says it", () => {
    installFakeDocument();
    const features = [{ id: "f1", type: "box" }, { id: "f45", type: "combine" }];
    const root = new FakeEl("div");
    const store = {
      document: { features, parameters: {}, paramDefs: {} } as unknown as CadDocument,
      buildState: { building: false, result: { diagnostics: [apart(66)], featureErrors: [] } as unknown as RebuildResult },
      busyState: { active: false, label: "", pct: null },
      rollbackIndex: features.length,
      isSuppressed: () => false,
      onDocChange: () => () => {},
      onBuild: () => () => {},
      onBusy: () => () => {},
    } as unknown as DocumentStore;
    new Timeline(root as unknown as HTMLElement, store).select(null);
    const [, chip] = byClass(root, "timeline-node");
    expect(chip!.classList.contains("warn"), "the Combine's chip is not amber").toBe(true);
    expect(chip!.classList.contains("error"), "the Combine's chip is red").toBe(false);
    // the fake store knows no Browser names, so the body goes by the sidecar's
    expect(chip!.title).toContain(diagnosticText(apart(66), undefined));
    expect(chip!.title).toContain("66 pieces I joined into Body1");
  });
});
