// What a split's diagnostics say: the yellow toast after a build and the
// chip's tooltip lines (splitWarnings.ts).
import { describe, expect, it } from "vitest";
import { diagBodyName, diagnosticText, splitNoteLines, splitWarningsToShow } from "./splitWarnings";
import { featureErrorText } from "../geometry/featureErrorText";
import { t } from "../i18n";
import type { ResolveDiag } from "../types";
import mainSrc from "../main.ts?raw";

const diag = (over: Partial<ResolveDiag>): ResolveDiag => ({
  kind: "splitSeparated", resolved: 0, confidence: 0, lossy: false, feature_id: "f5", ...over,
});
const isSplit = (id: string) => id === "f5" || id === "f6";
// stands in for diagnosticText: every coded diagnostic has SOME translation,
// including the reason-less per-body miss record (its code is the red error's)
const text = (d: ResolveDiag) => (d.code ? `text for ${d.code}` : d.reason ?? "");
const name = (d: ResolveDiag) => `N${d.body_id ?? "?"}`;
const show = (list: ResolveDiag[], failed = new Set<string>(), nameOf = name) =>
  splitWarningsToShow(list, isSplit, failed, text, nameOf).map(({ featureId, text }) => ({ featureId, text }));

describe("split warnings", () => {
  it("a warning with a reason on a split is shown", () => {
    const w = show([diag({ code: "splitSeparated", reason: "Nothing solid was cut through on {body}" })]);
    expect(w).toEqual([{ featureId: "f5", text: "text for splitSeparated" }]);
  });

  it("an All-visible cut's per-body 'missed' RECORD (no reason) is not, even though its code translates", () => {
    const records = ["body1", "body2", "body3"].map((b) => diag({ kind: "splitMissed", code: "splitMissed", body_id: b }));
    expect(show(records)).toEqual([]);
  });

  it("a feature that failed gets its red toast, not a yellow one as well", () => {
    expect(show([diag({ code: "splitDamagedParts", reason: "2 parts…" })], new Set(["f5"]))).toEqual([]);
  });

  it("many warnings on one split are ONE toast that counts them AND names the first bodies of each kind", () => {
    // The field file's "All visible" at its datum: 62 bodies with damaged parts
    // left whole and 11 separated. The toast stack holds 3, so one toast per
    // body showed only the last three and pushed out everything before them.
    // Counted without names, the toast never said which bodies (Q3).
    const many: ResolveDiag[] = [];
    for (let i = 0; i < 62; i++) many.push(diag({ kind: "splitDamagedParts", code: "splitDamagedParts", count: 2, body_id: `body${i}`, reason: "r" }));
    for (let i = 0; i < 11; i++) many.push(diag({ code: "splitSeparated", body_id: `body${100 + i}`, reason: "r" }));
    many.push(diag({ feature_id: "f6", code: "splitSeparated", body_id: "body7", reason: "r" }));
    const w = show(many);
    expect(w.map((x) => x.featureId)).toEqual(["f5", "f6"]);
    expect(w[0]!.text).toBe(
      "Nothing solid was cut through on 11 bodies, the plane only separated their parts: Nbody100, Nbody101, Nbody102, and 8 more. " +
        "62 bodies have damaged parts crossing the plane (124 in all), so I left those parts whole: 2 in Nbody0, 2 in Nbody1, 2 in Nbody2, and 59 more.",
    );
    // a split with ONE warning keeps that warning's own sentence, which names the body
    expect(w[1]!.text).toBe("text for splitSeparated");
  });

  it("the tooltip's lines name EVERY body of a kind, up to its limit", () => {
    const many = Array.from({ length: 62 }, (_x, i) => diag({ kind: "splitDamagedParts", code: "splitDamagedParts", count: 1, body_id: `body${i}`, reason: "r" }));
    const [line] = splitNoteLines(many, text, name, 100);
    for (let i = 0; i < 62; i++) expect(line, `body${i} is not named`).toContain(`1 in Nbody${i}`);
    expect(line).not.toContain("more");
  });

  it("several warnings about ONE body keep their own sentences, which name it", () => {
    // Q3: the warning names the body and how many parts were left uncut. Counted
    // as a summary, a plane that separated Skjermdeksel's parts AND crossed a
    // damaged one read "1 body has damaged parts crossing the plane (1 in all)",
    // and Skjermdeksel was named nowhere but the chip's tooltip.
    const two = [
      diag({ code: "splitSeparated", body_id: "body1", reason: "r" }),
      diag({ kind: "splitDamagedParts", code: "splitDamagedParts", count: 1, body_id: "body1", reason: "r" }),
    ];
    expect(show(two)).toEqual([{ featureId: "f5", text: "text for splitSeparated text for splitDamagedParts" }]);
  });

  it("a warning with no body (some named bodies are gone) is never merged as 'one body'", () => {
    const two = [
      diag({ kind: "splitBodiesGone", code: "splitBodiesGone", count: 2, reason: "r" }),
      diag({ kind: "splitBodiesGone", code: "splitBodiesGone", count: 2, reason: "r" }),
    ];
    // no body_id on either: a kind the summary does not count is said once in its own words
    expect(show(two)).toEqual([{ featureId: "f5", text: "text for splitBodiesGone" }]);
  });

  it("only splits: another feature's advisory stays on its amber chip", () => {
    expect(show([diag({ feature_id: "f2", kind: "sealedVoid", reason: "closed a cavity" })])).toEqual([]);
  });

  it("is said once per NEWS, not per wording: a renamed body does not toast it again", () => {
    // main.ts dedupes on SplitWarning.key. Keyed on the rendered text, the same
    // warning toasted again as soon as its body was renamed.
    const list = [diag({ kind: "splitDamagedParts", code: "splitDamagedParts", count: 2, body_id: "body1", reason: "r" })];
    const named = (n: string) => (d: ResolveDiag) => `${n} for ${d.code}`;
    const before = splitWarningsToShow(list, isSplit, new Set(), named("Bracket"), name)[0]!;
    const after = splitWarningsToShow(list, isSplit, new Set(), named("Holder"), name)[0]!;
    expect(before.text).not.toBe(after.text);
    expect(after.key, "a rename changed the key, so the toast fires again").toBe(before.key);
    // new news does change it: another body, or another count
    const other = splitWarningsToShow([{ ...list[0]!, body_id: "body2" }], isSplit, new Set(), text, name)[0]!;
    const more = splitWarningsToShow([{ ...list[0]!, count: 3 }], isSplit, new Set(), text, name)[0]!;
    expect(new Set([before.key, other.key, more.key]).size).toBe(3);
    // and main.ts (which cannot be imported in a test) dedupes on the key
    const at = mainSrc.indexOf("splitWarningsToShow(");
    const block = mainSrc.slice(at, mainSrc.indexOf("prevSplitWarnings = warned", at));
    expect(block, "main.ts no longer says each split warning once by its key").toContain("prevSplitWarnings.has(w.key)");
    expect(block, "main.ts keys the toast on its rendered words again").not.toMatch(/w\.text\}|\$\{w\.text/);
  });
});

describe("a body of a split over several that the split left unchanged", () => {
  // The sidecar reports it as `splitMissed` WITH a reason when the user picked
  // the body (not an All-visible cut). The same code is the red error of a
  // one-body split that misses: "Split changed nothing: ...". On one body of
  // several, the others WERE cut, so that sentence is false.
  const bodies = [{ id: "body2", name: "Bracket" }];
  const missed = diag({ kind: "splitMissed", code: "splitMissed", body_id: "body2", subject: "Body2", reason: "The plane does not pass through {body}." });

  it("says so as a warning, naming the body by its Browser name", () => {
    expect(diagnosticText(missed, bodies)).toBe(t("engine.warning.splitMissed", { body: "Bracket" }));
    // the control: read as the error it also is, it claims the split changed nothing
    expect(featureErrorText({ ...missed, message: missed.reason! }, bodies)).toBe(t("engine.error.splitMissed", { body: "Bracket" }));
    expect(diagnosticText(missed, bodies)).not.toContain("changed nothing");
  });

  it("lights a toast of its own, which names it", () => {
    const w = splitWarningsToShow([missed], isSplit, new Set(), (d) => diagnosticText(d, bodies), (d) => diagBodyName(d, bodies));
    expect(w.map((x) => x.text)).toEqual([t("engine.warning.splitMissed", { body: "Bracket" })]);
  });

  it("several are one line that names them", () => {
    const three = ["body2", "body3", "body4"].map((b) => ({ ...missed, body_id: b, subject: `S${b}` }));
    const [line] = splitNoteLines(three, (d) => diagnosticText(d, bodies), (d) => diagBodyName(d, bodies), 3);
    // a live name where the Browser has one, the sidecar's name otherwise
    expect(line).toBe(t("feature.split.summary.missed", { count: 3, names: "Bracket, Sbody3, and Sbody4" }));
  });

  it("other warnings keep their own translation (a code that is not also an error)", () => {
    const sep = diag({ code: "splitSeparated", body_id: "body2", reason: "r" });
    expect(diagnosticText(sep, bodies)).toBe(t("engine.error.splitSeparated", { body: "Bracket" }));
  });
});
