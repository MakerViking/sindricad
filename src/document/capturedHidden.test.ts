// A revolve, loft, sweep or thicken leaves alone the bodies hidden when it is
// made, like an extrude (field report 05f53ee7).
//
// These four used to read the LIVE eye states while nothing that decides when to
// rebuild knew they did: hiding the target body neither rebuilt nor invalidated
// the cache, so an old revolve cut a hidden shroud or did not depending on cache
// history, and the reporter saw "Cut removed nothing" only after a reopen. The
// sidecar now reads the set the feature carries (sidecar/test_smoke.py covers
// that side); this is the half that writes it: the store stamps it on every
// preview and commit, and stamps "nothing hidden" on documents saved before the
// field existed, which is how each of those features was made.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DocumentStore } from "./store";
import { diagBodyName, diagnosticText, splitWarningsToShow, toastsWarnings } from "../features/splitWarnings";
import type { CadDocument, Feature, RebuildReply, ResolveDiag } from "../types";
import type { GeometryBackend } from "../geometry/client";

function stubBackend(rebuilds: CadDocument[]): GeometryBackend {
  return {
    async rebuild(doc: CadDocument): Promise<RebuildReply> {
      rebuilds.push(doc);
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

const base = (): CadDocument => ({
  parameters: {},
  features: [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new", hiddenBodies: [] },
  ] as Feature[],
});

/** one of each, as their tools commit them (no hiddenBodies of their own) */
const made = (): Feature[] => [
  { id: "rv", type: "revolve", sketch: "s1", axis: "Z", angle: 360, operation: "cut" },
  { id: "lf", type: "loft", operation: "cut", profiles: [] },
  { id: "sw", type: "sweep", profile: "s1", path: "s1", operation: "cut" },
  { id: "th", type: "thicken", thickness: 2, operation: "join", body: "body1" },
] as Feature[];

const hiddenOf = (store: DocumentStore, id: string) =>
  (store.document.features.find((f) => f.id === id) as { hiddenBodies?: string[] } | undefined)?.hiddenBodies;

describe("revolve, loft, sweep and thicken capture the hidden bodies", () => {
  let rebuilds: CadDocument[];
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    rebuilds = [];
    store = new DocumentStore(stubBackend(rebuilds), base());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stamps the bodies hidden when each is made, and an eye toggle afterwards rebuilds nothing", async () => {
    store.setBodiesVisibility(new Map([["body2", false]]));
    for (const f of made()) store.addFeature(f);
    for (const f of made()) expect(hiddenOf(store, f.id), f.type).toEqual(["body2"]);
    await vi.runAllTimersAsync();
    const before = rebuilds.length;
    store.setBodiesVisibility(new Map([["body2", true]]));
    await vi.runAllTimersAsync();
    expect(rebuilds.length, "showing body2 is display only for stamped features").toBe(before);
    for (const f of made()) expect(hiddenOf(store, f.id), f.type).toEqual(["body2"]);
  });

  it("keeps a set the feature already carries", () => {
    store.setBodiesVisibility(new Map([["body2", false]]));
    store.addFeature({ ...made()[0]!, hiddenBodies: ["body7"] } as Feature);
    expect(hiddenOf(store, "rv")).toEqual(["body7"]);
  });

  it("stamps a preview the way its commit will be, so the preview cuts what the feature will", async () => {
    store.setBodiesVisibility(new Map([["body2", false]]));
    store.setPreview(made()[3]!);
    await vi.runAllTimersAsync();
    const sent = rebuilds[rebuilds.length - 1]!.features.find((f) => f.id === "th") as { hiddenBodies?: string[] };
    expect(sent.hiddenBodies).toEqual(["body2"]);
  });

  it("leaves other features alone (an extrude's tool stamps its own)", () => {
    store.setBodiesVisibility(new Map([["body2", false]]));
    store.addFeature({ id: "e2", type: "extrude", sketch: "s1", distance: 5, operation: "cut" } as Feature);
    store.addFeature({ id: "f1", type: "fillet", edges: [], radius: 1 } as unknown as Feature);
    expect(hiddenOf(store, "e2")).toBeUndefined();
    expect(hiddenOf(store, "f1")).toBeUndefined();
  });

  it("stamps nothing hidden on a document saved before the field existed, and keeps a saved set", () => {
    const old: CadDocument = { ...base(), features: [...base().features, ...made(), { ...made()[0]!, id: "rv2", hiddenBodies: ["body3"] } as Feature] };
    store.load(JSON.stringify({ ...old, bodyVisibility: { body1: false } }));
    for (const f of made()) expect(hiddenOf(store, f.id), f.type).toEqual([]);
    expect(hiddenOf(store, "rv2")).toEqual(["body3"]);
  });
});

describe("a cut that only reaches hidden bodies says so", () => {
  const diag = (count: number): ResolveDiag => ({
    feature_id: "rv", kind: "cutOnlyHidden", code: "cutOnlyHidden", resolved: 0, confidence: 0,
    lossy: false, body_id: "body1", subject: "Body1", count, reason: "sidecar English",
  });

  // It was a red error toast; a warning on the amber chip alone reads as
  // "I cut and nothing happened". Toasted from a revolve, a feature type whose
  // other warnings stay on the chip, exactly as main.ts asks.
  it("is toasted, whatever feature made the cut", () => {
    const bodies = [{ id: "body1", name: "Shroud" }];
    const sealed: ResolveDiag = { ...diag(1), kind: "sealedVoid", code: "sealedVoid", reason: "a void" };
    const w = splitWarningsToShow([diag(1), sealed], (fid) => toastsWarnings(fid === "rv" ? "revolve" : undefined),
      new Set(), (d) => diagnosticText(d, bodies), (d) => diagBodyName(d, bodies));
    expect(w.map((x) => x.featureId)).toEqual(["rv"]);
    expect(w[0]!.text).toBe(diagnosticText(diag(1), bodies));
    // a cut that FAILED says so in red, and is not toasted twice
    expect(splitWarningsToShow([diag(1)], () => false, new Set(["rv"]), (d) => diagnosticText(d, bodies), (d) => diagBodyName(d, bodies))).toEqual([]);
  });

  it("names the body by its Browser name, in the warning's own words", () => {
    expect(diagnosticText(diag(1), [{ id: "body1", name: "Shroud" }])).toBe(
      "This cut removed nothing: the only body it reaches is Shroud, which was hidden when you made the cut, so I left it alone. To cut it, delete this cut, show Shroud and make the cut again.");
    expect(diagnosticText(diag(3), [{ id: "body1", name: "Shroud" }])).toBe(
      "This cut removed nothing: the only bodies it reaches, Shroud and others (3 in all), were hidden when you made the cut, so I left them alone. To cut them, delete this cut, show them and make the cut again.");
  });
});

// Field report 14f32f87: a Join whose only candidates were hidden when it was
// made still adds a new body (a Join with nothing to act on always has), but
// that used to happen with no word said. Mirrors the cutOnlyHidden block
// above: same toast rule, same {body}-filling, different sentence because a
// join keeps the new body rather than removing nothing.
describe("a join that only reaches hidden bodies says so", () => {
  const diag = (count: number): ResolveDiag => ({
    feature_id: "e2", kind: "joinOnlyHidden", code: "joinOnlyHidden", resolved: 0, confidence: 0,
    lossy: false, body_id: "body1", subject: "Body1", count, reason: "sidecar English",
  });

  it("is toasted, whatever feature made the join", () => {
    const bodies = [{ id: "body1", name: "Shroud" }];
    const sealed: ResolveDiag = { ...diag(1), kind: "sealedVoid", code: "sealedVoid", reason: "a void" };
    const w = splitWarningsToShow([diag(1), sealed], (fid) => toastsWarnings(fid === "e2" ? "extrude" : undefined),
      new Set(), (d) => diagnosticText(d, bodies), (d) => diagBodyName(d, bodies));
    expect(w.map((x) => x.featureId)).toEqual(["e2"]);
    expect(w[0]!.text).toBe(diagnosticText(diag(1), bodies));
    // a join that FAILED says so in red, and is not toasted twice
    expect(splitWarningsToShow([diag(1)], () => false, new Set(["e2"]), (d) => diagnosticText(d, bodies), (d) => diagBodyName(d, bodies))).toEqual([]);
  });

  it("names the body by its Browser name, in the warning's own words", () => {
    expect(diagnosticText(diag(1), [{ id: "body1", name: "Shroud" }])).toBe(
      "This join added a new body instead of merging: the only body it reaches is Shroud, which was hidden when you made the join, so I left it alone. To join it, delete this join, show Shroud and make the join again.");
    expect(diagnosticText(diag(3), [{ id: "body1", name: "Shroud" }])).toBe(
      "This join added a new body instead of merging: the only bodies it reaches, Shroud and others (3 in all), were hidden when you made the join, so I left them alone. To join them, delete this join, show them and make the join again.");
  });
});
