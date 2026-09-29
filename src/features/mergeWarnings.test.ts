// What Merge into one solid and Separate say when they BUILT with something to
// say, and when a merge fails: in the user's words, naming the body, as a
// yellow toast (one per feature) and on the amber timeline chip, exactly like a
// split's warnings (splitWarnings.ts).
//
// The numbers are the field file's: Thomas's "Skjermdeksel (11)" is 50
// overlapping solids, 87 loose zero-thickness surfaces and 1 damaged sliver;
// merged it is 8 pieces that do not touch (the cover, a U frame floating inside
// it and six small parts floating just off its walls).
import { describe, expect, it } from "vitest";
import { diagBodyName, diagnosticText, splitWarningsToShow, toastsWarnings } from "./splitWarnings";
import { featureErrorText } from "../geometry/featureErrorText";
import { t } from "../i18n";
import type { CadDocument, ResolveDiag, RebuildResult } from "../types";
import { FakeEl, installFakeDocument, byClass } from "../ui/fakeDom.testkit";
import { Timeline } from "../ui/timeline";
import type { DocumentStore } from "../document/store";
import mainSrc from "../main.ts?raw";

const BODY = "Skjermdeksel (11)";
const bodies = [{ id: "body350", name: BODY }];
// The sidecar's English `reason` is a fallback only; a key in locales/en.json
// wins. Deliberately NOT the locale's words, so a missing key shows up as this.
const note = (code: string, count: number, over: Partial<ResolveDiag> = {}): ResolveDiag => ({
  feature_id: "f343", kind: code as ResolveDiag["kind"], code, resolved: 0, confidence: 0, lossy: false,
  reason: `sidecar fallback about {body}`, body_id: "body350", subject: "Skjermdeksel (11)", count, ...over,
});

describe("the warnings, in the user's words", () => {
  it("say what was dropped, left out or left apart, and name the body", () => {
    expect(diagnosticText(note("mergeDroppedSurfaces", 87), bodies)).toBe(
      "I dropped 87 loose surfaces from Skjermdeksel (11). They had no thickness, so they cannot be printed; " +
        "if part of the shape existed only as those surfaces, it is now open or missing.",
    );
    expect(diagnosticText(note("mergeDamagedLeftOut", 1), bodies)).toBe(
      "1 solid part of Skjermdeksel (11) is damaged, so I left it out of the merge rather than repair it. " +
        "Whatever it covered is missing from the result.",
    );
    expect(diagnosticText(note("mergeDamagedLeftOut", 3), bodies)).toBe(
      "3 solid parts of Skjermdeksel (11) are damaged, so I left them out of the merge rather than repair them. " +
        "Whatever they covered is missing from the result.",
    );
    expect(diagnosticText(note("mergeSeparatePieces", 8), bodies)).toBe(
      "Skjermdeksel (11) is now 8 separate pieces that do not touch. Separate into bodies splits them apart.",
    );
    expect(diagnosticText(note("separateDroppedSurfaces", 87), bodies)).toBe(
      "I left out 87 loose surfaces of Skjermdeksel (11): they have no thickness, so they did not become bodies. " +
        "If part of the shape existed only as those surfaces, it is now open or missing.",
    );
    expect(diagnosticText(note("separateDroppedSurfaces", 1), bodies)).toBe(
      "I left out 1 loose surface of Skjermdeksel (11): it has no thickness, so it did not become a body. " +
        "If part of the shape existed only as that surface, it is now open or missing.",
    );
    expect(diagnosticText(note("mergeDroppedSurfaces", 1), bodies)).toMatch(/^I dropped 1 loose surface from Skjermdeksel \(11\)\. It had/);
  });

  it("give a surface body's Separate its own reason: its loose faces are in none of its surfaces", () => {
    // A surface body separates into its shells, and shells have no thickness
    // either, so "no thickness" is not why its bare faces were left out. The
    // sidecar says separateDroppedFaces there (test_merge_solids has both).
    expect(diagnosticText(note("separateDroppedFaces", 3), bodies)).toBe(
      "I left out 3 loose faces of Skjermdeksel (11): Separate makes a body from each of its surfaces, and these " +
        "faces are not joined into any of them, so they did not become bodies. If part of the shape existed only " +
        "as those faces, it is now open or missing.",
    );
    expect(diagnosticText(note("separateDroppedFaces", 1), bodies)).toBe(
      "I left out 1 loose face of Skjermdeksel (11): Separate makes a body from each of its surfaces, and this " +
        "face is not joined into any of them, so it did not become a body. If part of the shape existed only as " +
        "that face, it is now open or missing.",
    );
    expect(diagnosticText(note("separateDroppedFaces", 3), bodies), "the faces case claims no thickness").not.toContain("thickness");
  });

  it("use the Browser's name when the body was renamed, the sidecar's otherwise", () => {
    expect(diagBodyName(note("mergeDroppedSurfaces", 87), [{ id: "body350", name: "LCD cover" }])).toBe("LCD cover");
    expect(diagnosticText(note("mergeSeparatePieces", 2), [])).toContain(BODY);
  });

  it("never claim the result is complete: the dropped-surfaces notes say what may be missing", () => {
    // A critic measured it on the field file: the upper 32 mm of one end wall
    // exists ONLY as two loose sheets 2 mm apart, so dropping them loses wall,
    // on a merge and on a Separate alike.
    expect(diagnosticText(note("mergeDroppedSurfaces", 87), bodies)).toContain("open or missing");
    expect(diagnosticText(note("separateDroppedSurfaces", 87), bodies)).toContain("open or missing");
    expect(diagnosticText(note("separateDroppedFaces", 2), bodies)).toContain("open or missing");
  });

  it("say that damaged solids left out are GONE, not kept aside", () => {
    // The merge removes them from the body; "left out" alone reads like the
    // pieces that stay apart, which ARE kept.
    expect(diagnosticText(note("mergeDamagedLeftOut", 1), bodies)).toContain("missing from the result");
  });

  it("speak in the first person, and never repeat the toast's feature name", () => {
    // The toast is "{feature label}: {text}", so "Separate: Separate dropped"
    // said the name twice, in the third person.
    for (const code of ["mergeDroppedSurfaces", "mergeDamagedLeftOut", "separateDroppedSurfaces", "separateDroppedFaces"]) {
      const said = diagnosticText(note(code, 2), bodies);
      expect(said, code).toMatch(/\bI\b/);
      expect(said, code).not.toMatch(/^(Separate|Merge)\b/);
    }
  });
});

describe("the errors, in words", () => {
  const err = (code: string) => ({ code, message: "sidecar fallback", body_id: "body350", subject: BODY });
  it("a body that is already one solid says there is nothing to merge", () => {
    expect(featureErrorText(err("mergeNothing"), bodies)).toBe("Skjermdeksel (11) is already one solid, so there is nothing to merge.");
  });
  it("a body that is already solids apart says there is nothing to merge, and what splits them", () => {
    // A second Merge on the field file's cover (8 pieces after the first) used
    // to build, change nothing and say "is now 8 separate pieces".
    expect(featureErrorText({ ...err("mergeNothingApart"), count: 8 }, bodies)).toBe(
      "Skjermdeksel (11) is already 8 separate solids that do not touch, so there is nothing to merge. " +
        "Separate into bodies makes each of them a body of its own.",
    );
  });
  it("a fuse the kernel could not do names the body and says nothing changed", () => {
    expect(featureErrorText(err("mergeFailed"), bodies)).toBe(
      "Merge failed on Skjermdeksel (11): the geometry kernel could not fuse its solids into a sound one " +
        "that holds all of them. Nothing was changed.",
    );
  });
  // The sidecar raises three more (sidecar/errors.py): a body of surfaces
  // only, a body whose every solid is damaged, and a body that is gone.
  it("a body of surfaces only says so, and what makes a solid of one", () => {
    expect(featureErrorText(err("mergeNoSolid"), bodies)).toBe(
      "Merge changed nothing: Skjermdeksel (11) has no solid parts, only surfaces, so there is nothing to merge. Thicken turns a surface into a solid.",
    );
  });
  it("a body whose every solid is damaged counts them, and repairs none", () => {
    expect(featureErrorText({ ...err("mergeAllDamaged"), count: 1 }, bodies)).toBe(
      "Merge changed nothing: the only solid part of Skjermdeksel (11) is damaged, and I leave damaged parts out rather than repair them.",
    );
    expect(featureErrorText({ ...err("mergeAllDamaged"), count: 4 }, bodies)).toContain("all 4 solid parts of Skjermdeksel (11) are damaged");
  });
  it("a merge whose body is gone says so", () => {
    expect(featureErrorText({ code: "mergeNoBody", message: "sidecar fallback" }, bodies)).toBe(
      "Merge: the body it was made on does not exist at this point in the timeline.",
    );
  });
});

describe("the yellow toast", () => {
  const types: Record<string, string> = { f341: "datumPlane", f342: "split", f343: "mergeSolids", f344: "separate", f345: "cleanUp" };
  const toasts = (fid: string) => toastsWarnings(types[fid]);
  const text = (d: ResolveDiag) => diagnosticText(d, bodies);
  const name = (d: ResolveDiag) => diagBodyName(d, bodies);

  it("is raised for split, merge and separate, not for other features' advisories", () => {
    expect(["split", "mergeSolids", "separate"].map(toastsWarnings)).toEqual([true, true, true]);
    expect(["extrude", "cleanUp", "datumPlane", undefined].map(toastsWarnings)).toEqual([false, false, false, false]);
  });

  it("says a merge's three notes in ONE toast, in the order they came", () => {
    const merge = [note("mergeDroppedSurfaces", 87), note("mergeDamagedLeftOut", 1), note("mergeSeparatePieces", 8)];
    const w = splitWarningsToShow(merge, toasts, new Set(), text, name);
    expect(w.map((x) => x.featureId)).toEqual(["f343"]);
    expect(w[0]!.text).toBe(merge.map(text).join(" "));
  });

  it("is raised for a Separate that dropped surfaces, or a surface body's faces", () => {
    const w = splitWarningsToShow([note("separateDroppedSurfaces", 87, { feature_id: "f344" })], toasts, new Set(), text, name);
    expect(w.map((x) => x.text)).toEqual([text(note("separateDroppedSurfaces", 87))]);
    const f = splitWarningsToShow([note("separateDroppedFaces", 2, { feature_id: "f344" })], toasts, new Set(), text, name);
    expect(f.map((x) => x.text)).toEqual([text(note("separateDroppedFaces", 2))]);
  });

  it("is not raised for a merge that failed: its red toast says it", () => {
    expect(splitWarningsToShow([note("mergeDroppedSurfaces", 87)], toasts, new Set(["f343"]), text, name)).toEqual([]);
  });

  it("main.ts toasts every feature toastsWarnings names, under that feature's own label", () => {
    // main.ts cannot be imported in a test. Before, it passed `type === "split"`
    // and titled every warning toast "Split Body".
    const at = mainSrc.indexOf("splitWarningsToShow(");
    const block = mainSrc.slice(at - 400, mainSrc.indexOf("prevSplitWarnings = warned", at));
    expect(block, "main.ts does not ask toastsWarnings which features to toast").toContain("toastsWarnings(");
    expect(block, "main.ts toasts only splits again").not.toMatch(/===\s*"split"/);
    expect(block, "main.ts titles every warning toast with Split's label").not.toContain("FEATURE_META.split.label");
  });
});

describe("the amber chip", () => {
  installFakeDocument();

  it("lights on a merge that built with notes, and its tooltip says them naming the body", () => {
    const features = [{ id: "f1", type: "import" }, { id: "f343", type: "mergeSolids" }];
    const diagnostics = [note("mergeDroppedSurfaces", 87), note("mergeSeparatePieces", 8)];
    const root = new FakeEl("div");
    const store = {
      document: { features, parameters: {}, paramDefs: {} } as unknown as CadDocument,
      buildState: { building: false, result: { diagnostics, featureErrors: [] } as unknown as RebuildResult },
      busyState: { active: false, label: "", pct: null },
      rollbackIndex: features.length,
      isSuppressed: () => false,
      onDocChange: () => () => {},
      onBuild: () => () => {},
      onBusy: () => () => {},
    } as unknown as DocumentStore;
    new Timeline(root as unknown as HTMLElement, store).select(null);
    const [, chip] = byClass(root, "timeline-node");
    expect(chip!.classList.contains("warn"), "the merge's chip is not amber").toBe(true);
    expect(chip!.title).toContain(t("tool.mergeSolids"));
    expect(chip!.title).toContain("I dropped 87 loose surfaces from Skjermdeksel (11).");
    expect(chip!.title).toContain("Skjermdeksel (11) is now 8 separate pieces that do not touch.");
  });
});
