// store.mergeSolids writes the exact feature the sidecar's contract reads,
// { id, type: "mergeSolids", body }, at the END of the timeline.
//
// The end matters because body ids are POSITIONAL: a feature inserted mid-
// timeline acts on the body list as it stood there, and one that changes the
// body count renumbers every body after it. Appended at the end, like separate
// and removeBody, it acts on the bodies the user is looking at and moves no id.
import { describe, expect, it, vi } from "vitest";
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
    { id: "f1", type: "box", length: 10, width: 10, height: 10 },
    { id: "f2", type: "box", length: 5, width: 5, height: 5 },
    { id: "f3", type: "separate", body: "body1" },
  ] as Feature[],
});

describe("store.mergeSolids", () => {
  it("appends the contract's feature at the end, and undo takes it back", async () => {
    vi.useFakeTimers();
    try {
      const rebuilds: CadDocument[] = [];
      const store = new DocumentStore(stubBackend(rebuilds), doc());
      store.mergeSolids(["body2"]);
      const features = store.document.features;
      expect(features.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4"]);
      // exactly these keys: the sidecar reads `body`, and nothing else rides along
      expect(features.at(-1)).toEqual({ id: "f4", type: "mergeSolids", body: "body2" });
      await vi.runAllTimersAsync();
      expect(rebuilds.at(-1)?.features.at(-1), "the rebuild never saw the merge").toEqual(features.at(-1));
      store.undo();
      expect(store.document.features.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges each body of a selection, one feature per body in order, as ONE undo step", async () => {
    // The body menus act on the selection they were opened over, as Split,
    // Move and Combine do; each body's solids become a solid of that body's
    // own, so it is one merge per body, never one merge of several bodies.
    vi.useFakeTimers();
    try {
      const rebuilds: CadDocument[] = [];
      const store = new DocumentStore(stubBackend(rebuilds), doc());
      store.mergeSolids(["body2", "body1"]);
      expect(store.document.features.slice(3)).toEqual([
        { id: "f4", type: "mergeSolids", body: "body2" },
        { id: "f5", type: "mergeSolids", body: "body1" },
      ]);
      await vi.runAllTimersAsync();
      expect(rebuilds.at(-1)?.features.slice(3), "the rebuild never saw both merges").toEqual(store.document.features.slice(3));
      store.undo();
      expect(store.document.features.map((f) => f.id), "one undo did not take both back").toEqual(["f1", "f2", "f3"]);
      expect(store.canUndo).toBe(false);

      // control: the same two merges made one at a time are two undo steps
      store.mergeSolids(["body2"]);
      store.mergeSolids(["body1"]);
      store.undo();
      expect(store.document.features.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing, and records no undo step, for no bodies", () => {
    const store = new DocumentStore(stubBackend([]), doc());
    store.mergeSolids([]);
    expect(store.document.features).toHaveLength(3);
    expect(store.canUndo).toBe(false);
  });

  it("goes at the END even with the rollback marker earlier, like separateBody", () => {
    // addFeature's default lands a feature at the rollback marker. Mid-timeline,
    // a merge would act on the bodies as they stood there, not on the body the
    // user right-clicked. The control is separateBody, which already does this.
    // KNOWN GAP, shared with separateBody and removeBody: a feature past the
    // marker is not built until the marker is rolled forward, so this merge
    // shows as a greyed chip and nothing else happens yet. Whether to roll
    // forward, refuse, or insert at the marker is a product decision for all
    // three; this test pins only where the feature goes.
    const store = new DocumentStore(stubBackend([]), doc());
    store.setRollback(1);
    store.mergeSolids(["body1"]);
    store.separateBody("body1");
    const types = store.document.features.map((f) => f.type);
    expect(types).toEqual(["box", "box", "separate", "mergeSolids", "separate"]);
  });
});
