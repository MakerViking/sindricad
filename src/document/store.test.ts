// Roll-to-position edit preview: while editing feature f, rebuilds must see the
// timeline truncated to just BEFORE f (so e.g. a fillet's member edges exist
// again) plus the live edited version. These tests drive DocumentStore against
// a stub backend that records every document it is asked to rebuild.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DocumentStore } from "./store";
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
    return rebuilds[rebuilds.length - 1].features.map((f) => f.id);
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
    const sent = rebuilds[rebuilds.length - 1].features.find((f) => f.id === "f1") as { radius?: number };
    expect(sent.radius).toBe(5); // the LIVE version, not the committed one
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
