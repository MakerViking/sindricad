// The store seams an agent's write will stand on (AI-control plan, slice W0):
// a document generation, a wait for the build that includes a given commit,
// one transaction = one undo step = one rebuild, undo steps that say who made
// them, a revert that leaves no redo behind, and the record of which features
// an agent made. Entered through the real DocumentStore, against a backend
// whose rebuilds are held until the test releases them, so "which build" is
// decided by the store and not by timing luck.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore, type RebuildState } from "./store";
import { savedVersion } from "./migrate";
import type { CadDocument, Feature, RebuildReply } from "../types";
import type { GeometryBackend } from "../geometry/client";

/** A rebuild reply told apart by its bbox: `tag` says which build answered. */
const reply = (tag: number): RebuildReply => ({
  ok: true,
  result: {
    mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
    edges: [],
    bbox: { min: [tag, 0, 0], max: [tag + 1, 1, 1] },
  },
} as unknown as RebuildReply);

/** Every rebuild waits for `release()`, in order; `sent` is what each was asked to build. */
function heldBackend() {
  const sent: CadDocument[] = [];
  const waiting: ((r: RebuildReply) => void)[] = [];
  const backend = {
    rebuild(doc: CadDocument): Promise<RebuildReply> {
      sent.push(doc);
      return new Promise((res) => waiting.push(res));
    },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
  return {
    backend,
    sent,
    get waiting() { return waiting.length; },
    release(tag: number) {
      const next = waiting.shift();
      if (!next) throw new Error("no rebuild is waiting");
      next(reply(tag));
    },
  };
}

/** A backend that answers every rebuild at once. */
function promptBackend(sent: CadDocument[] = []) {
  return {
    async rebuild(doc: CadDocument): Promise<RebuildReply> {
      sent.push(doc);
      return reply(sent.length);
    },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

const box = (id: string): Feature => ({ id, type: "box", length: 10, width: 10, height: 10 }) as Feature;
const ids = (d: CadDocument) => d.features.map((f) => f.id);
const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
/** Past the store's 120 ms rebuild debounce. */
const pastDebounce = () => flush(160);

beforeEach(() => {
  // scheduleRebuild debounces through window.setTimeout
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => void vi.unstubAllGlobals());

describe("document generation", () => {
  it("moves on every document change and not on a build settling", async () => {
    const sent: CadDocument[] = [];
    const store = new DocumentStore(promptBackend(sent), { parameters: {}, features: [] });
    const g0 = store.generation;
    store.addFeature(box("f1"));
    const g1 = store.generation;
    expect(g1).toBeGreaterThan(g0);
    await flush();
    expect(store.generation, "a build settling is not a document change").toBe(g1);
    store.undo();
    expect(store.generation).toBeGreaterThan(g1);
    const g2 = store.generation;
    store.redo();
    expect(store.generation).toBeGreaterThan(g2);
  });

  it("is stamped on the build state with the generation that build was sent", async () => {
    const sent: CadDocument[] = [];
    const store = new DocumentStore(promptBackend(sent), { parameters: {}, features: [] });
    store.addFeature(box("f1"));
    const g = store.generation;
    expect(g).toBeGreaterThan(0);
    await flush();
    expect(store.buildState.building).toBe(false);
    expect(store.buildState.generation).toBe(g);
  });
});

describe("transact", () => {
  it("lands two edits as ONE undo step and ONE rebuild", async () => {
    const sent: CadDocument[] = [];
    const store = new DocumentStore(promptBackend(sent), { parameters: {}, features: [] });
    const r = await store.transact("add two boxes", "agent:test-client", (d) => {
      d.features.push(box("f1"));
      d.features.push(box("f2"));
    });
    expect(r.committed).toBe(true);
    await pastDebounce();
    expect(sent.length, "one rebuild, not one per edit").toBe(1);
    expect(ids(sent[0]!)).toEqual(["f1", "f2"]);
    expect(store.peekUndo()).toEqual({ label: "add two boxes", actor: "agent:test-client" });
    store.undo();
    expect(ids(store.document), "one undo takes both back").toEqual([]);
    expect(store.canUndo, "and there was only the one step").toBe(false);
  });

  it("keeps the step's label and actor across undo and redo", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    store.addFeature(box("f1"));
    await store.transact("add lid", "agent:claude-code", (d) => void d.features.push(box("f2")));
    expect(store.peekUndo()).toEqual({ label: "add lid", actor: "agent:claude-code" });
    store.undo();
    expect(store.peekRedo()).toEqual({ label: "add lid", actor: "agent:claude-code" });
    expect(store.peekUndo(), "the human's add underneath").toEqual({ label: null, actor: "user" });
    store.redo();
    expect(store.peekUndo()).toEqual({ label: "add lid", actor: "agent:claude-code" });
  });

  it("commits nothing when its function throws", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    const g = store.generation;
    await expect(store.transact("bad", "agent:t", (d) => {
      d.features.push(box("f1"));
      throw new Error("refused");
    })).rejects.toThrow("refused");
    expect(ids(store.document)).toEqual([]);
    expect(store.canUndo).toBe(false);
    expect(store.generation).toBe(g);
  });

  it("refuses when the document is not the generation the caller read", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    const seen = store.generation;
    store.addFeature(box("f1")); // the human, between the agent's read and its write
    const r = await store.transact("add", "agent:t", (d) => void d.features.push(box("f2")), { ifGeneration: seen });
    expect(r).toEqual({ committed: false, reason: "staleGeneration", generation: store.generation });
    expect(ids(store.document)).toEqual(["f1"]);
  });

  it("never lands an agent's draft over an edit the human made while it was being worked out", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    let human!: () => void;
    const midway = new Promise<void>((r) => (human = r));
    const pending = store.transact("slow", "agent:t", async (d) => {
      d.features.push(box("f2"));
      await midway;
    });
    await flush();
    store.addFeature(box("f1")); // lands while the agent's function awaits
    human();
    const r = await pending;
    expect(r.committed).toBe(false);
    expect(r.committed === false && r.reason).toBe("documentMoved");
    expect(ids(store.document), "the human's edit stands, the draft is dropped").toEqual(["f1"]);
    expect(store.peekUndo()).toEqual({ label: null, actor: "user" });
  });
});

describe("awaitSettled", () => {
  it("answers with the build that INCLUDES the commit, not one queued ahead of it", async () => {
    const held = heldBackend();
    const store = new DocumentStore(held.backend, { parameters: {}, features: [] });
    store.addFeature(box("f1")); // its rebuild starts and is held
    expect(held.waiting).toBe(1);
    const r = await store.transact("add f2", "agent:t", (d) => void d.features.push(box("f2")));
    if (!r.committed) throw new Error("not committed");
    let got: RebuildState | "timeout" | undefined;
    void store.awaitSettled(r.generation, 5000).then((s) => (got = s));
    await pastDebounce(); // the commit's rebuild is now queued behind the held one

    held.release(1); // the OLDER build settles: f1 only
    await flush();
    expect(ids(held.sent[0]!)).toEqual(["f1"]);
    expect(got, "the build in flight did not include the commit").toBeUndefined();

    held.release(2); // the build that includes f2
    await flush();
    expect(ids(held.sent[1]!)).toEqual(["f1", "f2"]);
    expect(got).not.toBe("timeout");
    const s = got as RebuildState;
    expect(s.building).toBe(false);
    expect(s.generation).toBeGreaterThanOrEqual(r.generation);
    expect(s.result?.bbox.min[0], "the second build's reply").toBe(2);
  });

  it("answers at once when that build has already settled", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    store.addFeature(box("f1"));
    const g = store.generation;
    await flush();
    const s = await store.awaitSettled(g, 1000);
    expect(s).not.toBe("timeout");
    expect((s as RebuildState).generation).toBe(g);
  });

  it("says timeout rather than hanging when the build does not come back", async () => {
    const held = heldBackend();
    const store = new DocumentStore(held.backend, { parameters: {}, features: [] });
    store.addFeature(box("f1"));
    expect(await store.awaitSettled(store.generation, 30)).toBe("timeout");
  });
});

describe("undoAndForget", () => {
  it("takes the step back and leaves nothing to redo", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    store.addFeature(box("f1"));
    const r = await store.transact("add f2", "agent:t", (d) => void d.features.push(box("f2")));
    if (!r.committed) throw new Error("not committed");
    expect(store.undoAndForget(r.step)).toBe(true);
    expect(ids(store.document)).toEqual(["f1"]);
    expect(store.canRedo, "a reverted batch is not offered back").toBe(false);
    expect(store.peekUndo(), "the human's step is still there").toEqual({ label: null, actor: "user" });
  });

  it("refuses once the human has made a step on top of it", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    const r = await store.transact("add f1", "agent:t", (d) => void d.features.push(box("f1")));
    if (!r.committed) throw new Error("not committed");
    store.addFeature(box("f2"));
    expect(store.undoAndForget(r.step)).toBe(false);
    expect(ids(store.document)).toEqual(["f1", "f2"]);
  });
});

describe("agent provenance", () => {
  it("records which features an agent made, and not what the human made", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    store.addFeature(box("f1"));
    await store.transact("add f2", "agent:claude-code", (d) => void d.features.push(box("f2")));
    await store.transact("user batch", "user", (d) => void d.features.push(box("f3")));
    expect(store.featureProvenance("f1")).toBeUndefined();
    expect(store.featureProvenance("f2")?.client).toBe("claude-code");
    expect(Number.isNaN(Date.parse(store.featureProvenance("f2")!.at))).toBe(false);
    expect(store.featureProvenance("f3")).toBeUndefined();
  });

  it("is saved with the document and read back on open", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    await store.transact("add f1", "agent:codex", (d) => void d.features.push(box("f1")));
    const json = store.toJSON();
    expect(JSON.parse(json).agentProvenance.f1.client).toBe("codex");
    const reopened = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    reopened.load(json);
    expect(reopened.featureProvenance("f1")?.client).toBe("codex");
  });

  it("goes with its feature on undo, so a reused id is never badged as the agent's", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    await store.transact("add", "agent:t", (d) => void d.features.push(box(store.nextId())));
    expect(store.featureProvenance("f1")?.client).toBe("t");
    store.undo();
    store.addFeature(box(store.nextId())); // the human's feature takes the id f1 again
    expect(ids(store.document)).toEqual(["f1"]);
    expect(store.featureProvenance("f1")).toBeUndefined();
  });

  it("goes when its feature is deleted, for the same reason", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    await store.transact("add", "agent:t", (d) => void d.features.push(box("f1")));
    store.removeFeature("f1");
    store.addFeature(box(store.nextId()));
    expect(store.featureProvenance("f1")).toBeUndefined();
    expect(JSON.parse(store.toJSON()).agentProvenance).toBeUndefined();
  });

  it("does not raise the saved format version: an older build opens the file as before", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    await store.transact("add", "agent:t", (d) => void d.features.push(box("f1")));
    const saved = JSON.parse(store.toJSON()) as CadDocument;
    expect(saved.version).toBe(savedVersion(saved.features));
  });

  it("is cleared by File > New", async () => {
    const store = new DocumentStore(promptBackend(), { parameters: {}, features: [] });
    await store.transact("add", "agent:t", (d) => void d.features.push(box("f1")));
    store.newDocument();
    store.addFeature(box("f1"));
    expect(store.featureProvenance("f1")).toBeUndefined();
  });
});
