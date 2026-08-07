// The meshing phase reports feature = -1 for its whole duration, so the timeline
// chip has to get its fraction from the separate meshed/meshTotal channel. Before
// that channel existed the bar sat at 0% for the entire phase — measured at 136 s
// on the 3,071-body reference assembly, the largest feel defect on the open path.
// These tests pin the store half of that contract: the counts reach RebuildState,
// the "not meshing" sentinel (-1) is normalised to null, and they are cleared when
// a build ends so a finished rebuild can't leave a stale fraction on screen.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "./store";
import type { CadDocument, RebuildReply } from "../types";
import type { GeometryBackend } from "../geometry/client";

type ProgressFn = (feature: number, meshed: number, meshTotal: number) => void;

function backend(onRebuild?: () => void) {
  const listeners: ProgressFn[] = [];
  const be = {
    async rebuild(): Promise<RebuildReply> {
      onRebuild?.();
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() { return () => {}; },
    onProgress(fn: ProgressFn) { listeners.push(fn); return () => {}; },
    async cancel() { return true; },
    connected: true,
  } as unknown as GeometryBackend;
  return { be, emit: (f: number, m: number, t: number) => listeners.forEach((fn) => fn(f, m, t)) };
}

const emptyDoc = (): CadDocument => ({ parameters: {}, features: [] });

describe("meshing progress reaches the build state", () => {
  it("records meshed/meshTotal while building", () => {
    const { be, emit } = backend();
    const store = new DocumentStore(be, emptyDoc());
    // emit is ignored unless a build is in flight, so fake that flag
    (store as unknown as { build: { building: boolean } }).build.building = true;
    emit(-1, 812, 3071);
    expect(store.buildState.meshed).toBe(812);
    expect(store.buildState.meshTotal).toBe(3071);
    expect(store.buildState.progress).toBe(-1);
  });

  it("normalises the -1/-1 'not meshing' sentinel to null", () => {
    const { be, emit } = backend();
    const store = new DocumentStore(be, emptyDoc());
    (store as unknown as { build: { building: boolean } }).build.building = true;
    emit(-1, 5, 10);
    expect(store.buildState.meshed).toBe(5);
    emit(3, -1, -1); // back to a real feature index; no meshing in flight
    expect(store.buildState.meshed).toBeNull();
    expect(store.buildState.meshTotal).toBeNull();
    expect(store.buildState.progress).toBe(3);
  });

  it("ignores progress when no build is in flight", () => {
    const { be, emit } = backend();
    const store = new DocumentStore(be, emptyDoc());
    emit(-1, 900, 3071);
    expect(store.buildState.meshed).toBeNull();
  });

  it("clears the counts when the rebuild finishes", async () => {
    const { be, emit } = backend(() => emit(-1, 400, 3071));
    const store = new DocumentStore(be, emptyDoc());
    await store.rebuildNow();
    expect(store.buildState.building).toBe(false);
    expect(store.buildState.meshed).toBeNull();
    expect(store.buildState.meshTotal).toBeNull();
  });
});

describe("a long rebuild is cancellable", () => {
  it("marks the store busy for the duration of a rebuild", async () => {
    let busyDuring = false;
    const { be } = backend();
    const store = new DocumentStore(be, emptyDoc());
    store.onBusy((b) => { if (b.active) busyDuring = true; });
    await store.rebuildNow();
    // busy.active must have been true at some point (that is what gates the
    // Cancel button in timeline.ts) and must be cleared afterwards
    expect(busyDuring).toBe(true);
    expect(store.busyState.active).toBe(false);
  });

  it("cancelBusy still works without a request id (rebuild never learns one)", async () => {
    const { be } = backend();
    const store = new DocumentStore(be, emptyDoc());
    let cancelled = false;
    await store.runBusy("Rebuilding", async () => {
      cancelled = await store.cancelBusy();
    });
    expect(cancelled).toBe(true);
  });
});
