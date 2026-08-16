// Roll-to-position edit preview: while editing feature f, rebuilds must see the
// timeline truncated to just BEFORE f (so e.g. a fillet's member edges exist
// again) plus the live edited version. These tests drive DocumentStore against
// a stub backend that records every document it is asked to rebuild.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DocumentStore, prefixFeatures } from "./store";
import type { CadDocument, Feature, RebuildReply } from "../types";
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

const doc = (): CadDocument => ({
  parameters: {},
  features: [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
    { id: "f1", type: "fillet", edges: { kind: "edge", by: "nearest", point: [0, 0, 0] }, radius: 2 },
    { id: "c1", type: "chamfer", edges: { kind: "edge", by: "nearest", point: [1, 0, 0] }, distance: 1 },
  ] as Feature[],
});

describe("edit preview (roll-to-position)", () => {
  let rebuilds: CadDocument[];
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    rebuilds = [];
    store = new DocumentStore(stubBackend(rebuilds), doc());
  });
  afterEach(() => void vi.useRealTimers());

  const lastIds = async () => {
    await vi.runAllTimersAsync(); // drain the scheduled rebuild
    const last = rebuilds[rebuilds.length - 1];
    return last ? last.features.map((f) => f.id) : [];
  };

  it("beginEditPreview rolls to just before the edited feature", async () => {
    store.beginEditPreview("f1");
    expect(await lastIds()).toEqual(["s1", "e1"]); // f1 and later c1 excluded
    expect(store.hasPreview).toBe(true);
    expect(store.editPreviewId).toBe("f1");
  });

  it("setEditPreview appends the live edited feature at the roll point", async () => {
    store.beginEditPreview("f1");
    const live: Feature = { id: "f1", type: "fillet", edges: [], radius: 5 } as unknown as Feature;
    store.setEditPreview(live);
    const ids = await lastIds();
    expect(ids).toEqual(["s1", "e1", "f1"]);
    const last = rebuilds[rebuilds.length - 1];
    const sent = last?.features.find((f) => f.id === "f1") as { radius?: number } | undefined;
    expect(sent?.radius).toBe(5); // the LIVE version, not the committed one
  });

  it("endEditPreview restores the full committed timeline", async () => {
    store.beginEditPreview("f1");
    await vi.runAllTimersAsync();
    store.endEditPreview();
    expect(await lastIds()).toEqual(["s1", "e1", "f1", "c1"]);
    expect(store.hasPreview).toBe(false);
    expect(store.editPreviewId).toBe(null);
  });

  it("editing document state is untouched (undo/serialize see the committed doc)", async () => {
    const before = store.toJSON();
    store.beginEditPreview("f1");
    store.setEditPreview({ id: "f1", type: "fillet", edges: [], radius: 99 } as unknown as Feature);
    await vi.runAllTimersAsync();
    expect(store.toJSON()).toBe(before);
    store.endEditPreview(false);
  });

  it("never resurrects features past the rollback marker", async () => {
    store.setRollback(2); // only s1, e1 build; f1 is rolled off
    store.beginEditPreview("f1"); // f1 not in the effective slice -> no truncation
    expect(await lastIds()).toEqual(["s1", "e1"]);
    store.endEditPreview(false);
  });
});

describe("palette persistence", () => {
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new DocumentStore(stubBackend([]), doc());
  });
  afterEach(() => void vi.useRealTimers());

  it("a synced palette survives save/reload even with zero body assignments", () => {
    const synced = [
      { name: "Polymaker PLA", color: "#ff8800", material: "PLA" },
      { name: "eSun PETG", color: "#0044ff", material: "PETG" },
    ];
    store.applyFilamentSync(synced);
    const reloaded = new DocumentStore(stubBackend([]), doc());
    reloaded.load(store.toJSON());
    expect(reloaded.colorPalette[0]).toMatchObject(synced[0]!);
    expect(reloaded.colorPalette[1]).toMatchObject(synced[1]!);
  });

  it("an untouched default palette is still omitted from the saved doc (byte stability)", () => {
    const json = store.toJSON();
    expect(json).not.toContain('"palette"'); // same bytes an old build wrote
    // load() applies the hiddenBodies migration once, so compare two saves
    // AFTER a load cycle: a re-opened doc must re-save byte-identically.
    const reloaded = new DocumentStore(stubBackend([]), doc());
    reloaded.load(json);
    const migrated = reloaded.toJSON();
    expect(migrated).not.toContain('"palette"');
    const again = new DocumentStore(stubBackend([]), doc());
    again.load(migrated);
    expect(again.toJSON()).toBe(migrated);
  });
});

describe("projected-entity persistence (byte stability)", () => {
  it("a doc with a projected entity round-trips byte-identically, stale omitted when false", () => {
    vi.useFakeTimers();
    const withProjected = (): CadDocument => ({
      parameters: {},
      features: [
        { id: "s1", type: "sketch", plane: "XY", entities: [
          { type: "projected", id: "p1",
            source: { kind: "edge", body: "body1",
              sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
            curve: { kind: "line", x1: 0, y1: 0, x2: 20, y2: 0 } },
        ] },
      ] as Feature[],
    });
    const store = new DocumentStore(stubBackend([]), withProjected());
    const json = store.toJSON();
    expect(json).toContain('"projected"');
    expect(json).not.toContain('"stale"'); // omit-when-false, like every persisted flag
    // load() runs migration once; a re-opened doc must re-save byte-identically
    const reloaded = new DocumentStore(stubBackend([]), withProjected());
    reloaded.load(json);
    const migrated = reloaded.toJSON();
    const again = new DocumentStore(stubBackend([]), withProjected());
    again.load(migrated);
    expect(again.toJSON()).toBe(migrated);
    vi.useRealTimers();
  });
});

describe("prefixFeatures (Project tool's prefix-document rule)", () => {
  const feats = (): Feature[] => [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
    { id: "s2", type: "sketch", plane: "XY", entities: [] },
    { id: "e2", type: "extrude", sketch: "s2", distance: 5, operation: "join" },
  ] as Feature[];
  const none = new Set<string>();

  it("new sketch: everything up to the rollback marker", () => {
    expect(prefixFeatures(feats(), 4, none).map((f) => f.id)).toEqual(["s1", "e1", "s2", "e2"]);
    expect(prefixFeatures(feats(), 2, none).map((f) => f.id)).toEqual(["s1", "e1"]);
  });

  it("editing an existing sketch: strictly before the edited feature", () => {
    expect(prefixFeatures(feats(), 4, none, "s2").map((f) => f.id)).toEqual(["s1", "e1"]);
    // the edited feature itself is never included
    expect(prefixFeatures(feats(), 4, none, "s1").map((f) => f.id)).toEqual([]);
  });

  it("suppressed features are excluded", () => {
    expect(prefixFeatures(feats(), 4, new Set(["e1"]), "e2").map((f) => f.id)).toEqual(["s1", "s2"]);
  });

  it("edited feature past the rollback marker: the marker still truncates", () => {
    // rolled back to 2, editing s2 (which sits at index 2, outside the build)
    expect(prefixFeatures(feats(), 2, none, "s2").map((f) => f.id)).toEqual(["s1", "e1"]);
  });
});

// The CHANGELOG for the holed-region fix (field 19314fdc) names the inspector as
// the ONE surface that can change a holed extrude's depth without re-targeting
// it. That is only true while a numeric field edit writes the named field and
// nothing else: the timeline's Edit re-derives `regions`/`regionEntities`/
// `regionHoleEntities` from a fresh pick (extrudeTool.ts:410-418), so if the
// inspector ever grew the same habit the release note would be sending users
// into the exact trap it warns about. Lock the note's claim down here.
describe("inspector numeric edit leaves an extrude's region anchors alone", () => {
  const holedExtrude = (): CadDocument => ({
    parameters: {},
    features: [
      { id: "s1", type: "sketch", plane: "XY", entities: [] },
      {
        id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new",
        regions: [[5, 5, 0]],
        regionEntities: [["l1", "l2", "l3", "l4"]],
        regionHoleEntities: [[["c1"]]],
      },
    ] as Feature[],
  });

  it("writes distance only", async () => {
    vi.useFakeTimers();
    // this store path schedules its rebuild off `window` (store.ts:1203) and the
    // suite runs in node with no jsdom, so hand it the timers vitest is faking
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    try {
      const store = new DocumentStore(stubBackend([]), holedExtrude());
      // exactly what inspector.ts does for a plain number in FEATURE_NUM_FIELDS
      store.setTargetValue({ kind: "feature", feature: "e1", field: "distance" }, 25, "length");
      await vi.runAllTimersAsync();

      const before = holedExtrude().features[1] as any;
      const after = store.document.features.find((f) => f.id === "e1") as any;
      expect(after.distance).toBe(25);
      expect(after.regions).toEqual(before.regions);
      expect(after.regionEntities).toEqual(before.regionEntities);
      expect(after.regionHoleEntities).toEqual(before.regionHoleEntities);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
