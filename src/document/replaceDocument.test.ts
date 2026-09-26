// A document replacement (File → New, File → Open) has to take the old model off
// screen and stop whatever is still building for the document being discarded.
//
// Reported 2026-08-08: File → New during a 3,000-body rebuild left the previous
// model on screen over an empty document, with no message, and hiding the body
// did nothing — because there was no body in the document to hide. Two causes,
// both pinned here. rebuildNow keeps the last good result when a rebuild does not
// produce a new one, which is right within a document and wrong across a
// replacement; and a rebuild already in flight holds the queue, so the
// replacement's own rebuild could not start for as long as the old one ran.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "./store";
import type { CadDocument, RebuildResult } from "../types";
import type { GeometryBackend } from "../geometry/client";

const RESULT: RebuildResult = {
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: "b1", name: "Body1", faceStart: 0, faceCount: 1 }],
};

const DOC: CadDocument = {
  parameters: {},
  features: [{ id: "f1", type: "sketch", plane: "XY", entities: [] } as unknown as CadDocument["features"][number]],
};

/** First rebuild succeeds; every later one hangs, standing in for the long
 *  rebuild that was holding the queue in the field. */
function backend() {
  let calls = 0;
  let cancels = 0;
  const be = {
    async rebuild() {
      calls++;
      if (calls === 1) return { ok: true as const, result: RESULT };
      return new Promise<never>(() => {}); // never settles
    },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { cancels++; return true; },
  } as unknown as GeometryBackend;
  return { be, calls: () => calls, cancels: () => cancels };
}

async function storeWithModelAndHangingRebuild() {
  const h = backend();
  const store = new DocumentStore(h.be, DOC);
  await store.rebuildNow(); // 1st: lands a real result on screen
  expect(store.buildState.result).not.toBeNull();
  void store.rebuildNow(); // 2nd: hangs, exactly as a huge rebuild would
  await Promise.resolve();
  return { store, h };
}

describe("replacing the document", () => {
  it("takes the old model off screen on File → New", async () => {
    const { store } = await storeWithModelAndHangingRebuild();
    store.newDocument();
    // the shape on screen belonged to the document that was just discarded
    expect(store.buildState.result).toBeNull();
  });

  it("stops the in-flight rebuild on File → New", async () => {
    const { store, h } = await storeWithModelAndHangingRebuild();
    expect(h.cancels()).toBe(0);
    store.newDocument();
    // without this the queued rebuild of the NEW document waits for the old one
    expect(h.cancels()).toBe(1);
  });

  it("does the same on File → Open", async () => {
    const { store, h } = await storeWithModelAndHangingRebuild();
    store.load(JSON.stringify({ parameters: {}, features: [] }));
    expect(store.buildState.result).toBeNull();
    expect(h.cancels()).toBe(1);
  });

  it("clears the progress counters with the model", async () => {
    const { store } = await storeWithModelAndHangingRebuild();
    store.newDocument();
    const s = store.buildState;
    // a stale fraction outliving its document is the same class of bug
    expect(s.building).toBe(false);
    expect(s.progress).toBeNull();
    expect(s.meshed).toBeNull();
    expect(s.meshTotal).toBeNull();
    expect(s.streamed).toBeNull();
    expect(s.streamTotal).toBeNull();
    expect(s.errorMessage).toBeNull();
    expect(s.errorFeatureId).toBeNull();
  });

  it("is harmless when nothing is building", async () => {
    const h = backend();
    const store = new DocumentStore(h.be, DOC);
    await store.rebuildNow();
    store.newDocument(); // no rebuild in flight
    expect(store.buildState.result).toBeNull();
    // cancelBusy short-circuits when nothing is running, so no pool is killed
    expect(h.cancels()).toBe(0);
  });
});

// The viewport has to know a replacement happened, not just see the model go:
// Open/Recover owe the new document a Fit, and since ee204bc the one fit armed
// at launch was spent on the blank startup document's empty reply, so no opened
// file was ever framed. main.ts re-arms on this event. It must fire on every
// replacement, BEFORE the replacement's rebuild is requested (or the reply could
// land unarmed), and never on an ordinary edit (or every edit would re-fit and
// yank the camera).
describe("announcing a replacement", () => {
  function recording() {
    const events: string[] = [];
    const be = {
      async rebuild() {
        events.push("rebuild");
        return { ok: true as const, result: RESULT };
      },
      async init() {},
      onStatus() { return () => {}; },
      onProgress() { return () => {}; },
      async cancel() { return true; },
    } as unknown as GeometryBackend;
    const store = new DocumentStore(be, DOC);
    store.onReplace((how) => events.push(how));
    return { store, events };
  }

  it("says 'load' for Open and Recover, before the rebuild of what was loaded", async () => {
    const { store, events } = recording();
    store.load(JSON.stringify({ parameters: {}, features: [] }));
    expect(events.slice(0, 2)).toEqual(["load", "rebuild"]);
  });

  it("says 'new' for File > New and Close", async () => {
    const { store, events } = recording();
    store.newDocument();
    expect(events.slice(0, 2)).toEqual(["new", "rebuild"]);
  });

  it("says nothing for a file it could not read, which replaces nothing", () => {
    const { store, events } = recording();
    expect(() => store.load("{ not json")).toThrow();
    expect(events).toEqual([]);
  });

  it("says nothing for an ordinary edit and rebuild", async () => {
    const { store, events } = recording();
    await store.rebuildNow();
    store.setBodiesVisibility(new Map([["b1", false]]));
    await store.rebuildNow();
    expect(events.filter((e) => e !== "rebuild")).toEqual([]);
  });
});
