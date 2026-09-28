// The Split Body panel's decisions, off the DOM: which field takes the next
// click, what a preselection fills, what each pick does, and exactly which
// feature OK writes. The feature shape is the contract the sidecar reads
// (types.ts `split`), so it is asserted field by field rather than by snapshot.
import { describe, expect, it } from "vitest";
import {
  activate, buildSplitFeature, chooseToolHit, clearField, editedSplit, firstEmptyField, initialSplitState, isLegacySplit,
  pickBody, pickTool, planeBoxSection, planeMissesBox, resultingPieces, setAllVisible, stateFromFeature,
  type SplitFeatureShape, type SplitState,
} from "./splitState";
import type { PlaneDef, Selector } from "../types";

const LIVE = ["body1", "body2", "body3"];
const FACE_PLANE: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };
const FACE: Selector = { kind: "face", by: "nearest", point: [1, 2, 10], body: "body1" };

const open = (over: Partial<Parameters<typeof initialSplitState>[0]> = {}) =>
  initialSplitState({ selectedBodies: [], liveBodies: LIVE, selectedDatum: null, selectedFace: null, ...over });

describe("preselection", () => {
  it("opens on Body when nothing is selected", () => {
    const s = open();
    expect(s.bodies).toEqual([]);
    expect(s.tool).toBeNull();
    expect(s.active).toBe("body");
    expect(s.keep).toBe("both");
    expect(s.offset).toBe(0);
  });

  it("fills Body from the selected bodies and moves on to Tool", () => {
    const s = open({ selectedBodies: ["body2", "body3"] });
    expect(s.bodies).toEqual(["body2", "body3"]);
    expect(s.active).toBe("tool");
  });

  it("fills Tool from a selected datum plane, and Body stays the active field", () => {
    const s = open({ selectedDatum: "f7" });
    expect(s.tool).toEqual({ kind: "datum", id: "f7" });
    expect(s.active).toBe("body");
  });

  it("does NOT turn a selected datum into 'cut every visible body' (the old trap)", () => {
    const s = open({ selectedDatum: "f7" });
    expect(s.allVisible).toBe(false);
    expect(s.bodies).toEqual([]);
    expect(buildSplitFeature(s, { id: "f9", visibleBodies: LIVE, groupSides: true })).toEqual({ missing: "body" });
  });

  it("fills Tool from ONE selected flat face", () => {
    const s = open({ selectedFace: { plane: FACE_PLANE, face: FACE } });
    expect(s.tool).toEqual({ kind: "face", plane: FACE_PLANE, face: FACE });
  });

  it("a datum wins over a selected face for the Tool field", () => {
    const s = open({ selectedDatum: "f7", selectedFace: { plane: FACE_PLANE, face: FACE } });
    expect(s.tool).toEqual({ kind: "datum", id: "f7" });
  });

  it("with both fields filled, no field is armed: a stray click changes nothing", () => {
    const s = open({ selectedBodies: ["body1"], selectedDatum: "f7" });
    expect(firstEmptyField(s)).toBeNull();
    expect(s.active).toBeNull();
  });

  it("a right-click seed wins over the ambient selection for its own field", () => {
    const s = open({ seed: { bodies: ["body3"], planeId: "f2" }, selectedBodies: ["body1"], selectedDatum: "f7" });
    expect(s.bodies).toEqual(["body3"]);
    expect(s.tool).toEqual({ kind: "datum", id: "f2" });
  });

  it("drops ids the last build does not know, and duplicates", () => {
    const s = open({ selectedBodies: ["body1", "gone", "body1"] });
    expect(s.bodies).toEqual(["body1"]);
  });
});

describe("the field state machine", () => {
  const base = (): SplitState => open();

  it("a plain body click replaces the targets and advances to an empty Tool", () => {
    let s = pickBody(base(), "body1", false);
    expect(s.bodies).toEqual(["body1"]);
    expect(s.active).toBe("tool");
    s = pickBody(s, "body2", false);
    expect(s.bodies).toEqual(["body2"]);
  });

  it("Ctrl toggles one body and stays on Body", () => {
    let s = pickBody(base(), "body1", true);
    s = pickBody(s, "body2", true);
    expect(s.bodies).toEqual(["body1", "body2"]);
    expect(s.active).toBe("body");
    s = pickBody(s, "body1", true);
    expect(s.bodies).toEqual(["body2"]);
  });

  it("Ctrl adds a body WHATEVER field is active, and leaves that field active", () => {
    // A plain click moved on to Tool; the next Ctrl-click is still "this body
    // too", and the click after it still picks the tool.
    let s = pickBody(base(), "body1", false);
    expect(s.active).toBe("tool");
    s = pickBody(s, "body2", true);
    expect(s.bodies).toEqual(["body1", "body2"]);
    expect(s.tool).toBeNull();
    expect(s.active).toBe("tool");
    // toggled down to nothing, Body is the field to fill again
    s = pickBody(pickBody(s, "body1", true), "body2", true);
    expect(s.bodies).toEqual([]);
    expect(s.active).toBe("body");
  });

  it("a plain body click with the tool already chosen disarms both fields", () => {
    const s = pickBody({ ...base(), tool: { kind: "origin", plane: "XY" } }, "body1", false);
    expect(s.active).toBeNull();
  });

  it("an explicit body pick ends All visible", () => {
    const s = pickBody(setAllVisible(base(), true), "body2", false);
    expect(s.allVisible).toBe(false);
    expect(s.bodies).toEqual(["body2"]);
  });

  it("picking the tool moves to an empty Body, else disarms; the offset survives", () => {
    const s0 = { ...base(), offset: 4 };
    const a = pickTool(s0, { kind: "origin", plane: "XZ" });
    expect(a.active).toBe("body");
    expect(a.offset).toBe(4);
    const b = pickTool({ ...s0, bodies: ["body1"] }, { kind: "origin", plane: "XZ" });
    expect(b.active).toBeNull();
  });

  it("All visible counts as filling Body", () => {
    const s = setAllVisible(base(), true);
    expect(firstEmptyField(s)).toBe("tool");
    expect(s.active).toBe("tool");
  });

  it("clearing a field empties it and makes it active", () => {
    const full = { ...base(), bodies: ["body1"], tool: { kind: "origin" as const, plane: "XY" as const }, active: "tool" as const };
    expect(clearField(full, "body")).toMatchObject({ bodies: [], active: "body" });
    expect(clearField(full, "tool")).toMatchObject({ tool: null, active: "tool" });
    expect(activate(full, "body").active).toBe("body");
  });
});

describe("the feature OK writes", () => {
  const ready = (over: Partial<SplitState>): SplitState => ({
    bodies: ["body1"], allVisible: false, tool: { kind: "origin", plane: "XY" }, active: "body", offset: 0, keep: "both", ...over,
  });

  it("one body, a face tool: body + plane + face anchor + numeric offset + groupSides", () => {
    const r = buildSplitFeature(ready({ tool: { kind: "face", plane: FACE_PLANE, face: FACE }, offset: -2.5, keep: "top" }), { id: "f9", visibleBodies: LIVE, groupSides: true });
    expect(r).toEqual({
      feature: { id: "f9", type: "split", keep: "top", groupSides: true, body: "body1", plane: FACE_PLANE, face: FACE, offset: -2.5 },
    });
  });

  it("a datum tool writes planeId and nothing else about the plane", () => {
    const r = buildSplitFeature(ready({ tool: { kind: "datum", id: "f3" } }), { id: "f9", visibleBodies: LIVE, groupSides: true });
    expect(r).toEqual({ feature: { id: "f9", type: "split", keep: "both", groupSides: true, body: "body1", planeId: "f3", offset: 0 } });
  });

  it("several bodies are `bodies`, in pick order", () => {
    const r = buildSplitFeature(ready({ bodies: ["body3", "body1"] }), { id: "f9", visibleBodies: LIVE, groupSides: true });
    expect(r).toMatchObject({ feature: { bodies: ["body3", "body1"], plane: "XY" } });
    expect((r as { feature: SplitFeatureShape }).feature.body).toBeUndefined();
  });

  it("All visible writes the visible ids as they stand at OK, even just one, and says it was All visible", () => {
    const r = buildSplitFeature(ready({ bodies: [], allVisible: true }), { id: "f9", visibleBodies: ["body2"], groupSides: true });
    expect(r).toEqual({ feature: { id: "f9", type: "split", keep: "both", groupSides: true, bodies: ["body2"], allVisible: true, plane: "XY", offset: 0 } });
  });

  it("explicit picks never write allVisible: the sidecar names a picked body the plane leaves unchanged", () => {
    // The contract: `allVisible: true` ONLY for "All visible bodies (N)". A
    // split over bodies picked one by one that carried it would say nothing
    // about a picked body the plane misses.
    for (const bodies of [["body1"], ["body3", "body1"]]) {
      const r = buildSplitFeature(ready({ bodies }), { id: "f9", visibleBodies: LIVE, groupSides: true }) as { feature: SplitFeatureShape };
      expect("allVisible" in r.feature, `${bodies.length} picked bodies wrote allVisible`).toBe(false);
    }
    // ticked then unticked is a pick again
    const s = setAllVisible(setAllVisible(ready({ bodies: ["body1", "body2"] }), true), false);
    expect("allVisible" in (buildSplitFeature(s, { id: "f9", visibleBodies: LIVE, groupSides: true }) as { feature: SplitFeatureShape }).feature).toBe(false);
  });

  it("says which field is missing instead of writing a half feature", () => {
    expect(buildSplitFeature(ready({ bodies: [] }), { id: "f9", visibleBodies: LIVE, groupSides: true })).toEqual({ missing: "body" });
    expect(buildSplitFeature(ready({ tool: null }), { id: "f9", visibleBodies: LIVE, groupSides: true })).toEqual({ missing: "tool" });
    expect(buildSplitFeature(ready({ bodies: [], allVisible: true }), { id: "f9", visibleBodies: [], groupSides: true })).toEqual({ missing: "body" });
  });

  it("an edit of an old split keeps it WITHOUT groupSides (positional body ids)", () => {
    const r = buildSplitFeature(ready({}), { id: "f4", visibleBodies: LIVE, groupSides: undefined });
    expect("groupSides" in (r as { feature: SplitFeatureShape }).feature).toBe(false);
    const off = buildSplitFeature(ready({}), { id: "f4", visibleBodies: LIVE, groupSides: false });
    expect((off as { feature: SplitFeatureShape }).feature.groupSides).toBe(false);
  });
});

describe("re-opening a saved split", () => {
  it("round-trips what OK wrote", () => {
    const s: SplitState = { bodies: ["body1", "body2"], allVisible: false, tool: { kind: "face", plane: FACE_PLANE, face: FACE }, active: null, offset: 3, keep: "bottom" };
    const r = buildSplitFeature(s, { id: "f9", visibleBodies: LIVE, groupSides: true }) as { feature: SplitFeatureShape };
    expect(stateFromFeature(r.feature)).toEqual(s);
  });

  it("reads an OLD ribbon split: a baked plane, no face, no offset", () => {
    const s = stateFromFeature({ id: "f4", type: "split", keep: "both", plane: FACE_PLANE, body: "body2", groupSides: true });
    expect(s).toMatchObject({ bodies: ["body2"], tool: { kind: "fixed", plane: FACE_PLANE }, offset: 0 });
  });

  it("reads an old 'Cut all bodies' split AS All visible", () => {
    // Before the panel, `bodies` was written only by "Cut all bodies". Re-opened
    // as that many explicit picks, an edited one was written back as picks and
    // every body its plane misses (most of an assembly) became a warning.
    const s = stateFromFeature({ id: "f4", type: "split", keep: "top", planeId: "f2", bodies: ["body1", "body3"] });
    expect(s).toMatchObject({ bodies: ["body1", "body3"], allVisible: true, tool: { kind: "datum", id: "f2" }, keep: "top" });
  });

  it("re-opens an All-visible split as All visible, and a panel split over picked bodies as picks", () => {
    const all = stateFromFeature({ id: "f4", type: "split", keep: "both", planeId: "f2", bodies: ["body1", "body3"], allVisible: true, offset: 0 });
    expect(all?.allVisible).toBe(true);
    const picks = stateFromFeature({ id: "f4", type: "split", keep: "both", planeId: "f2", bodies: ["body1", "body3"], offset: 0 });
    expect(picks?.allVisible).toBe(false);
    // and OK on the All-visible one writes it back as All visible
    const r = buildSplitFeature(all!, { id: "f4", visibleBodies: ["body1", "body3"], groupSides: true }) as { feature: SplitFeatureShape };
    expect(r.feature).toMatchObject({ bodies: ["body1", "body3"], allVisible: true });
  });

  it("reads the tool the sidecar cuts by: a face wins over a planeId beside it", () => {
    // builder._split_plane follows `face` first. Read as the datum instead, OK
    // would write the feature back without its face and the cut would move.
    const s = stateFromFeature({ id: "f4", type: "split", keep: "both", plane: FACE_PLANE, face: FACE, planeId: "f2", body: "body1" });
    expect(s?.tool).toEqual({ kind: "face", plane: FACE_PLANE, face: FACE });
  });

  it("declines an offset held by a parameter expression (the inspector's job)", () => {
    expect(stateFromFeature({ id: "f4", type: "split", keep: "both", plane: "XY", offset: "gap/2" })).toBeNull();
  });
});

describe("which surface a Tool click takes", () => {
  it("a datum lying ON the face wins the tie", () => {
    expect(chooseToolHit(120.0, 120.0, 0.01)).toBe("datum");
    expect(chooseToolHit(120.0, 120.004, 0.01)).toBe("datum");
  });
  it("otherwise the nearest wins", () => {
    expect(chooseToolHit(100, 150, 0.01)).toBe("face");
    expect(chooseToolHit(150, 100, 0.01)).toBe("datum");
    expect(chooseToolHit(null, 100, 0.01)).toBe("datum");
    expect(chooseToolHit(100, null, 0.01)).toBe("face");
    expect(chooseToolHit(null, null, 0.01)).toBeNull();
  });
});

describe("the plane against the targets' box", () => {
  const box = { min: [0, 0, 0] as const, max: [10, 20, 30] as const };
  const up = [0, 0, 1] as const;

  it("a plane through the box cuts it; one past it misses", () => {
    expect(planeMissesBox([0, 0, 15], up, box, 1e-6)).toBe(false);
    expect(planeMissesBox([0, 0, 31], up, box, 1e-6)).toBe(true);
    expect(planeMissesBox([0, 0, -1], up, box, 1e-6)).toBe(true);
  });

  it("a plane ON a face of the box is not a miss (Q1: it separates, and says so)", () => {
    expect(planeMissesBox([0, 0, 30], up, box, 1e-6)).toBe(false);
    expect(planeMissesBox([0, 0, 0], up, box, 1e-6)).toBe(false);
  });

  it("the section of an axis plane is the box's cross-section, in order", () => {
    const pts = planeBoxSection([0, 0, 15], up, box);
    expect(pts).toHaveLength(4);
    for (const p of pts) expect(p[2]).toBeCloseTo(15);
    const xs = pts.map((p) => p[0]).sort((a, b) => a - b);
    const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
    expect(xs).toEqual([0, 0, 10, 10]);
    expect(ys).toEqual([0, 0, 20, 20]);
    // ordered around the centre: consecutive corners share an x or a y
    for (let i = 0; i < 4; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % 4]!;
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
    }
  });

  it("an oblique plane through a corner region gives a triangle; a miss gives nothing", () => {
    const n = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)] as const;
    expect(planeBoxSection([1, 0, 0], n, box)).toHaveLength(3);
    expect(planeBoxSection([0, 0, 40], up, box)).toEqual([]);
  });
});

describe("after the split builds", () => {
  const stamps = (...ids: string[]) => ids.map((id) => ({ id, etag: `${id}@0` }));

  it("selects the targets the split changed plus every new body", () => {
    const after = [...stamps("body1", "body3"), { id: "body2", etag: "body2@1" }, ...stamps("body4", "body5")];
    expect(resultingPieces(["body2"], stamps("body1", "body2", "body3"), after)).toEqual(["body2", "body4", "body5"]);
  });

  it("does NOT select a target the plane missed: it is not a piece", () => {
    // "All visible" on the 340-body field file selected all 583 bodies after
    // the cut, the 193 the plane missed included.
    const after = [{ id: "body1", etag: "body1@1" }, ...stamps("body2", "body3"), ...stamps("body4")];
    expect(resultingPieces(["body1", "body2", "body3"], stamps("body1", "body2", "body3"), after)).toEqual(["body1", "body4"]);
  });

});

describe("re-opening a split", () => {
  const PLANE: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };
  const old: SplitFeatureShape = { id: "f5", type: "split", keep: "both", groupSides: true, body: "body1", plane: PLANE };

  it("an old split OK'd unchanged is written back exactly as it was (no offset: it stays an old split)", () => {
    // The sidecar rebuilds a split without `offset`/`face` the old way, which is
    // what keeps its pieces behind the same positional ids.
    const next = { ...old, offset: 0 };
    expect(editedSplit(old, next, null)).toBe(old);
    // one that cut "the active body": the body the panel filled in is not a change
    const { body: _b, ...noBody }: SplitFeatureShape = old;
    expect(editedSplit(noBody, { ...noBody, body: "body3", offset: 0 }, "body3")).toBe(noBody);
  });

  it("an old 'Cut all bodies' OK'd on All visible, nothing else changed, is written back as it was, whatever is visible now", () => {
    // It re-opens as All visible (stateFromFeature), and All visible lists the
    // bodies visible when OK is pressed. A body hidden since (or one shown
    // since) made an untouched OK a new target list: the split left the old
    // path, and the hidden body was not cut at all any more.
    const cutAll: SplitFeatureShape = { id: "f5", type: "split", keep: "top", groupSides: true, bodies: ["body1", "body2"], planeId: "d1" };
    const onAll = (bodies: string[], over: Partial<SplitFeatureShape> = {}): SplitFeatureShape =>
      ({ id: "f5", type: "split", keep: "top", groupSides: true, bodies, allVisible: true, planeId: "d1", offset: 0, ...over });
    expect(editedSplit(cutAll, onAll(["body1"]), null), "a body hidden since").toBe(cutAll);
    expect(editedSplit(cutAll, onAll(["body1", "body2", "body3"]), null), "a body shown since").toBe(cutAll);
    expect(editedSplit(cutAll, onAll(["body2", "body1"]), null), "the same bodies in another order").toBe(cutAll);
    // a real change is still a change
    for (const next of [onAll(["body1"], { keep: "both" }), onAll(["body1"], { offset: 2 }), onAll(["body1"], { planeId: "d2" })]) {
      expect(editedSplit(cutAll, next, null)).toBe(next);
    }
    // bodies picked one by one are compared as the list they are
    const picked: SplitFeatureShape = { id: "f5", type: "split", keep: "top", groupSides: true, bodies: ["body1"], planeId: "d1", offset: 0 };
    expect(editedSplit(cutAll, picked, null)).toBe(picked);
  });

  it("an old split whose old way failed is converted on OK, changed or not", () => {
    // splitLegacyFailed / splitLegacyVolume say "edit the split and press OK to
    // cut it part by part": OK has to do that even when nothing was changed.
    const next = { ...old, offset: 0 };
    expect(editedSplit(old, next, null, true)).toBe(next);
  });

  it("isLegacySplit: no offset and no face", () => {
    expect(isLegacySplit(old)).toBe(true);
    expect(isLegacySplit({ ...old, offset: 0 })).toBe(false);
    expect(isLegacySplit({ ...old, face: FACE })).toBe(false);
  });

  it("a real change to an old split gives a panel split", () => {
    for (const next of [
      { ...old, keep: "top", offset: 0 } as SplitFeatureShape,
      { ...old, body: "body2", offset: 0 },
      { ...old, offset: 2 },
      { id: "f5", type: "split", keep: "both", groupSides: true, body: "body1", planeId: "d1", offset: 0 } as SplitFeatureShape,
    ]) {
      expect(editedSplit(old, next, null)).toBe(next);
    }
    // a panel split is always written as edited
    const panel = { ...old, offset: 0 };
    const edited: SplitFeatureShape = { ...panel, keep: "top" };
    expect(editedSplit(panel, { ...panel }, null)).not.toBe(panel);
    expect(editedSplit(panel, edited, null)).toBe(edited);
  });

  it("a face-anchored split re-opens on where its face IS, not where it was picked", () => {
    const moved: PlaneDef = { origin: [0, 0, 35], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const f = { ...old, face: { kind: "face" as const, by: "nearest" as const, point: [1, 1, 10] as [number, number, number], body: "body1" }, offset: -5 };
    const st = stateFromFeature(f as never, moved);
    expect(st?.tool).toMatchObject({ kind: "face", plane: moved });
    expect(stateFromFeature(f as never)?.tool).toMatchObject({ kind: "face", plane: PLANE });
  });
});
