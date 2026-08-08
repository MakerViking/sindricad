// The chunk channel must stay disjoint from the completed-build channel.
//
// Progressive display draws a PARTIAL model. Every tool's onBuild handler is a
// one-shot on the `!building` edge — fillet/chamfer ghost seeding, the texture
// tool's selection reseed, the context-menu dismissal, the new-failure toast
// diff — and roughly twenty other places read store.buildState.result directly,
// two of which BAKE it into a persisted document (a split feature's body id
// list, and post-import colour assignment). If a partial model could reach any
// of them the result would be a wrong saved document, not just a wrong frame.
//
// So: chunks travel on onBuildChunk, buildState.result keeps pointing at the
// PREVIOUS committed model for the whole stream, and the completed branch fires
// exactly once. These pin that.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "./store";
import type { BuildChunk } from "./store";
import type { CadDocument, RebuildReply, RebuildResult } from "../types";
import type { GeometryBackend } from "../geometry/client";
import type { RebuildChunk } from "../geometry/client";

const DOC: CadDocument = { parameters: {}, features: [] };

function result(ids: string[]): RebuildResult {
  return {
    mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
    edges: [],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    bodies: ids.map((id, i) => ({ id, name: id, faceStart: i, faceCount: 1, etag: `e-${id}` })),
  };
}

function backend(reply: RebuildReply) {
  const chunkFns: ((c: RebuildChunk) => void)[] = [];
  const be = {
    async rebuild(): Promise<RebuildReply> { return reply; },
    async init() {},
    onStatus() { return () => {}; },
    onRebuildChunk(fn: (c: RebuildChunk) => void) { chunkFns.push(fn); return () => {}; },
    async cancel() { return true; },
    connected: true,
  } as unknown as GeometryBackend;
  const emit = (c: Partial<RebuildChunk>) => {
    const full: RebuildChunk = {
      phase: "bodies", result: result(["a"]), manifest: [], bodies: [],
      edgesByBody: new Map(), triRange: { triStart: 0, triEnd: 0 },
      bbox: { min: [0, 0, 0], max: [1, 1, 1] }, done: 1, total: 2,
      ...c,
    } as RebuildChunk;
    chunkFns.forEach((fn) => fn(full));
  };
  return { be, emit };
}

describe("chunk channel vs completed build", () => {
  it("never fires the completed branch for a chunk", async () => {
    // The test that protects edgeFeatureTool's seedGhosts, textureTool's
    // seedSelectionFromSaved, the context-menu dismissal and the toast diff.
    const { be, emit } = backend({ ok: true, result: result(["a", "b"]) });
    const store = new DocumentStore(be, DOC);
    let completed = 0;
    store.onBuild((s) => { if (!s.building && s.result) completed++; });
    completed = 0; // onBuild replays current state on subscribe; start from there

    const done = store.rebuildNow();
    emit({ phase: "begin", done: 0, total: 2 });
    emit({ phase: "bodies", done: 1, total: 2 });
    emit({ phase: "bodies", done: 2, total: 2 });
    await done;

    expect(completed).toBe(1);
  });

  it("keeps buildState.result on the PREVIOUS model for the whole stream", async () => {
    const first = result(["old"]);
    const { be, emit } = backend({ ok: true, result: first });
    const store = new DocumentStore(be, DOC);
    await store.rebuildNow();
    expect(store.buildState.result).toBe(first);

    const next = result(["a", "b"]);
    (be as unknown as { rebuild: () => Promise<RebuildReply> }).rebuild =
      async () => ({ ok: true, result: next });
    const done = store.rebuildNow();
    emit({ phase: "begin", done: 0, total: 2 });
    // mid-stream: the document still describes the OLD model, by identity
    expect(store.buildState.result).toBe(first);
    emit({ phase: "bodies", done: 2, total: 2 });
    expect(store.buildState.result).toBe(first);
    await done;
    expect(store.buildState.result).toBe(next); // only now
  });

  it("publishes streamed/streamTotal and clears them when the build settles", async () => {
    const { be, emit } = backend({ ok: true, result: result(["a", "b"]) });
    const store = new DocumentStore(be, DOC);
    const seen: (number | null)[] = [];
    store.onBuild((s) => seen.push(s.streamed));

    const done = store.rebuildNow();
    emit({ phase: "begin", done: 0, total: 2 });
    emit({ phase: "bodies", done: 2, total: 2 });
    expect(store.buildState.streamed).toBe(2);
    expect(store.buildState.streamTotal).toBe(2);
    await done;
    expect(store.buildState.streamed).toBeNull();
    expect(store.buildState.streamTotal).toBeNull();
    expect(seen).toContain(2);
  });

  it("delivers chunks to onBuildChunk subscribers, stamped with the epoch", async () => {
    const { be, emit } = backend({ ok: true, result: result(["a"]) });
    const store = new DocumentStore(be, DOC);
    const got: BuildChunk[] = [];
    store.onBuildChunk((c) => got.push(c));

    const done = store.rebuildNow();
    emit({ phase: "begin", done: 0, total: 1 });
    emit({ phase: "bodies", done: 1, total: 1 });
    await done;

    expect(got.map((c) => c.phase)).toEqual(["begin", "bodies"]);
    expect(new Set(got.map((c) => c.epoch)).size).toBe(1); // one stream, one epoch
  });

  it("drops chunks that arrive when no build is running", async () => {
    const { be, emit } = backend({ ok: true, result: result(["a"]) });
    const store = new DocumentStore(be, DOC);
    await store.rebuildNow();
    const got: BuildChunk[] = [];
    store.onBuildChunk((c) => got.push(c));
    emit({ phase: "bodies", done: 1, total: 1 }); // nothing is building
    expect(got).toEqual([]);
  });

  it("tells the viewport to abort when a streamed rebuild fails", async () => {
    // The partial model on screen has to come down before the retained previous
    // result is rendered over the top of it.
    const { be, emit } = backend({ ok: false, error: { message: "boom" } });
    const store = new DocumentStore(be, DOC);
    const aborts: number[] = [];
    store.onBuildAbort((e) => aborts.push(e));

    const done = store.rebuildNow();
    emit({ phase: "begin", done: 0, total: 2 });
    await done;
    expect(aborts).toHaveLength(1);
  });

  it("does not abort when nothing was streamed", async () => {
    const { be } = backend({ ok: false, error: { message: "boom" } });
    const store = new DocumentStore(be, DOC);
    const aborts: number[] = [];
    store.onBuildAbort((e) => aborts.push(e));
    await store.rebuildNow();
    expect(aborts).toEqual([]);
  });

  it("works with a backend that does not stream at all", async () => {
    // The in-process Tauri backend and every existing test stub omit
    // onRebuildChunk; the optional call must simply not fire.
    const be = {
      async rebuild(): Promise<RebuildReply> { return { ok: true, result: result(["a"]) }; },
      async init() {},
      onStatus() { return () => {}; },
      connected: true,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(be, DOC);
    const got: BuildChunk[] = [];
    store.onBuildChunk((c) => got.push(c));
    await store.rebuildNow();
    expect(got).toEqual([]);
    expect(store.buildState.result?.bodies?.[0]?.id).toBe("a");
    expect(store.buildState.streamed).toBeNull();
  });
});
