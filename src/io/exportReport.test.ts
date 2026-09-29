// What the post-export list says for each entry of an export reply's
// `warnings` (exportReport.ts): a failed feature, or a note about a file that
// was written in full.
import { describe, expect, it } from "vitest";
import { exportReport, featureTimelineLabel, isFailedFeature } from "./exportReport";
import { t } from "../i18n";
import type { FeatureError } from "../types";
import filesSrc from "./files.ts?raw";
import publishSrc from "../tinkeratlas/publish.ts?raw";
import serverSrc from "../../sidecar/server.py?raw";

// The sidecar's own sentences (server.py _open_edge_warning, _budget_warning,
// and the STEP texture note), as sent: `{message}` and nothing else.
const OPEN_EDGES = "the mesh has 243 unmatched edges — it is not fully closed, so a slicer may report it as non-manifold";
const DENSE = "export is very dense (2,400,000 triangles)";
const STEP_TEXTURE = "texture is not represented in STEP exports";

const features = [
  { id: "f1", type: "sketch" },
  { id: "f2", type: "extrude" },
  { id: "f3", type: "split" },
];

describe("export report", () => {
  it("CONTROL: the old line called the open-edge note a failed feature, word for word what the user saw", () => {
    // The line files.ts built for EVERY warning before this change.
    const oldLine = (w: FeatureError) =>
      t("file.export.featureMissing", { feature: w.feature_id ?? t("file.export.unnamedFeature"), reason: w.message });
    expect(oldLine({ message: OPEN_EDGES })).toBe(
      "⚠ feature failed — its result is NOT in the export: the mesh has 243 unmatched edges — it is not fully closed, so a slicer may report it as non-manifold",
    );
  });

  it("the open-edge note is a note: no 'failed', no 'NOT in the export', and nothing failed", () => {
    const r = exportReport([{ message: OPEN_EDGES }], "export", features, []);
    expect(r).toEqual({ lines: [t("file.export.note", { note: OPEN_EDGES })], failed: 0 });
    expect(r.lines[0]).toBe(`Note: ${OPEN_EDGES}`);
    expect(r.lines[0]).not.toMatch(/failed|NOT in the/);
  });

  it("every note the sidecar sends stays a note, on both targets", () => {
    for (const target of ["export", "upload"] as const) {
      const r = exportReport([{ message: OPEN_EDGES }, { message: DENSE }, { message: STEP_TEXTURE }], target, features, []);
      expect(r.failed).toBe(0);
      expect(r.lines).toEqual([`Note: ${OPEN_EDGES}`, `Note: ${DENSE}`, `Note: ${STEP_TEXTURE}`]);
    }
  });

  it("a failed feature keeps its NOT-in-the-export line, named as the timeline names it", () => {
    const r = exportReport([{ feature_id: "f2", message: "extrude failed (ValueError)" }], "export", features, []);
    expect(r.failed).toBe(1);
    expect(r.lines).toEqual([
      t("file.export.featureMissing", { feature: "2 · Extrude", reason: "extrude failed (ValueError)" }),
    ]);
    expect(r.lines[0]).toContain("NOT in the export");
    expect(r.lines[0]).not.toContain("f2");
  });

  it("a failed feature in an upload says it is not in the upload", () => {
    const r = exportReport([{ feature_id: "f2", message: "boom" }], "upload", features, []);
    expect(r.lines[0]).toBe(t("tinkeratlas.publish.featureMissing", { feature: "2 · Extrude", reason: "boom" }));
    expect(r.lines[0]).toContain("NOT in the upload");
  });

  it("a coded failure is translated and its {body} slot filled, where the old line printed the raw sentence", () => {
    const w: FeatureError = {
      feature_id: "f3",
      code: "splitMissed",
      body_id: "body7",
      message: "the plane does not pass through {body}",
    };
    const r = exportReport([w], "export", features, [{ id: "body7", name: "Skjermdeksel" }]);
    expect(r.lines[0]).toBe(
      t("file.export.featureMissing", { feature: "3 · Split Body", reason: t("engine.error.splitMissed", { body: "Skjermdeksel" }) }),
    );
    expect(r.lines[0]).not.toContain("{body}");
  });

  it("failures and notes together: order kept, only the failures counted", () => {
    const r = exportReport([{ feature_id: "f2", message: "boom" }, { message: OPEN_EDGES }], "export", features, []);
    expect(r.failed).toBe(1);
    expect(r.lines[0]).toContain("2 · Extrude");
    expect(r.lines[1]).toBe(`Note: ${OPEN_EDGES}`);
  });

  it("no warnings, no lines", () => {
    expect(exportReport(undefined, "export", features, [])).toEqual({ lines: [], failed: 0 });
    expect(exportReport([], "upload", features, [])).toEqual({ lines: [], failed: 0 });
  });
});

describe("telling a failure from a note", () => {
  it("goes by the feature_id KEY: a null id is still a failure", () => {
    // _err_entry copies feature_id from a builder entry that always sets it; a
    // feature with no id arrives as null, and its geometry is still missing.
    const nullId = { feature_id: null, message: "boom" } as unknown as FeatureError;
    expect(isFailedFeature(nullId)).toBe(true);
    expect(isFailedFeature({ message: OPEN_EDGES })).toBe(false);
    const r = exportReport([nullId], "export", features, []);
    expect(r.failed).toBe(1);
    expect(r.lines[0]).toBe(t("file.export.featureMissing", { feature: t("file.export.unnamedFeature"), reason: "boom" }));
  });

  it("names a feature missing from the document by its id, and an unknown type by its type", () => {
    expect(featureTimelineLabel(features, "f9")).toBe("f9");
    expect(featureTimelineLabel([{ id: "a", type: "fromTheFuture" }], "a")).toBe("1 · fromTheFuture");
  });

  it("the sidecar keeps its side: notes carry only a message, failures come from _err_entry", () => {
    // The whole classification rests on this. A note appended WITH a
    // feature_id would be announced as a failed feature again.
    const appends = [...serverSrc.matchAll(/\b(?:warnings|notes)\.append\((.*)\)\s*$/gm)].map((m) => m[1] ?? "");
    expect(appends.length).toBeGreaterThanOrEqual(4);
    for (const a of appends) {
      expect(a.startsWith('{"message": ')).toBe(true);
      expect(a).not.toContain("feature_id");
    }
    expect(serverSrc).toContain("warnings = [_err_entry(e) for e in errors]");
    expect(serverSrc).toContain("notes = [_err_entry(e) for e in errors]");
  });
});

describe("the dialogs use it", () => {
  // The modals need Tauri and a DOM, which this suite has neither of, so what
  // is checked here is that the three callers go through exportReport and no
  // longer build the NOT-in-the-export sentence themselves.
  it("File > Export, the per-body export and the print project", () => {
    expect(filesSrc).not.toContain('t("file.export.featureMissing"');
    expect(filesSrc.match(/exportReport\(res\.warnings, "export"/g)?.length).toBe(2);
    expect(filesSrc).toContain('report.failed\n      ? t("file.export.doneTitleWarnings"');
    expect(filesSrc).toContain('report.failed ? t("file.export.projectDoneWarnings") : t("file.export.projectDone")');
  });

  it("Publish to TinkerAtlas", () => {
    expect(publishSrc).not.toContain('t("tinkeratlas.publish.featureMissing"');
    expect(publishSrc).toContain('exportReport(res.warnings, "upload"');
    expect(publishSrc).toContain('report.failed ? t("tinkeratlas.publish.warningsTitle") : t("tinkeratlas.publish.notesTitle")');
  });
});
