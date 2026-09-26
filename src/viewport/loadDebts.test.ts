// Which build owes a loaded document its Fit and its hidden-bodies cue
// (loadDebts.ts), driven through the real DocumentStore, because the failures
// were all about the store's EVENT ORDER: when a replacement is announced, when
// the old document's reply still lands, and which build comes next.
//
// The effect under test is what main.ts hands the viewport on each committed
// build: setModel(result, due.fit), the cue toast when due.cue, and
// releaseCamera() at the opened document's first frame. The wiring that makes
// main.ts do exactly that is pinned as source at the bottom.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../document/store";
import { LoadDebts, type Debts } from "./loadDebts";
import type { CadDocument, RebuildResult } from "../types";
import type { GeometryBackend, RebuildChunk } from "../geometry/client";
import mainSrc from "../main.ts?raw";

const SKETCH_ONLY = "sketchonly";

/** A document whose rebuild answers with one body named after `tag`, or with
 *  no solid at all for SKETCH_ONLY. */
function doc(tag: string): CadDocument {
  return {
    parameters: {},
    features: [{ id: tag, type: "sketch", plane: "XY", entities: [] } as unknown as CadDocument["features"][number]],
  };
}
const EMPTY: CadDocument = { parameters: {}, features: [] };

function resultFor(d: CadDocument): RebuildResult {
  const tag = (d.features[0]?.id as string | undefined) ?? "blank";
  const solid = tag !== "blank" && tag !== SKETCH_ONLY;
  return {
    mesh: solid ? { positions: [0, 0, 0], indices: [0], faceIds: [0] } : { positions: [], indices: [], faceIds: [] },
    edges: [],
    bbox: solid ? { min: [0, 0, 0], max: [1, 1, 1] } : (null as unknown as RebuildResult["bbox"]),
    bodies: solid ? [{ id: tag, name: tag, faceStart: 0, faceCount: 1 }] : [],
  };
}

/** A backend whose every rebuild waits until the test answers it, so a test
 *  can hold the OLD document's reply in flight across a replacement. Cancel
 *  succeeds and stops nothing: the case where the worker had already returned
 *  and the reply was on its way. An answer can stream, as every real reply
 *  from the sidecar does: its begin chunk first, then the reply. */
function heldBackend() {
  const pending: { d: CadDocument; answer: (ok?: boolean) => void }[] = [];
  let chunk: ((c: RebuildChunk) => void) | null = null;
  const be = {
    rebuild(d: CadDocument) {
      return new Promise((resolve) => {
        pending.push({
          d,
          answer: (ok = true) =>
            resolve(ok ? { ok: true, result: resultFor(d) } : { ok: false, error: { message: "boom" } }),
        });
      });
    },
    async init() {},
    onRebuildChunk(fn: (c: RebuildChunk) => void) {
      chunk = fn;
      return () => {};
    },
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
  } as unknown as GeometryBackend;
  /** Answer the oldest rebuild still waiting, and let the store settle it. */
  const answer = async (ok = true, stream = false) => {
    for (let i = 0; i < 20 && !pending.length; i++) await Promise.resolve();
    const p = pending.shift();
    if (!p) throw new Error("no rebuild is waiting to be answered");
    if (ok && stream) {
      const r = resultFor(p.d);
      const manifest = r.bodies ?? [];
      chunk?.({
        phase: "begin", result: r, manifest, bodies: [], edgesByBody: new Map(),
        triRange: { triStart: 0, triEnd: 0 }, bbox: r.bbox, done: 0, total: manifest.length,
      } as unknown as RebuildChunk);
    }
    p.answer(ok);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { be, answer };
}

/** The store, with LoadDebts wired exactly as main.ts wires it, recording what
 *  each COMMITTED build was handed, and each frame the camera was released at. */
function app(initial = EMPTY) {
  const h = heldBackend();
  const store = new DocumentStore(h.be, initial);
  const owed = new LoadDebts();
  const commits: ({ body: string } & Debts)[] = [];
  const released: { at: "begin" | "commit"; body: string }[] = [];
  const nameOf = (bodies: { id: string }[] | undefined) => bodies?.[0]?.id ?? "(no solid)";
  store.onReplace((how) => owed.replaced(how));
  store.onBuildChunk((c) => {
    if (c.phase === "begin" && owed.firstFrame()) released.push({ at: "begin", body: nameOf(c.manifest) });
  });
  store.onBuild((s) => {
    const due = owed.onBuild(s);
    if (s.result && !s.building) {
      if (due.release) released.push({ at: "commit", body: nameOf(s.result.bodies) });
      commits.push({ body: nameOf(s.result.bodies), ...due });
    }
  });
  return { store, owed, commits, released, answer: h.answer };
}

const open = (store: DocumentStore, d: CadDocument) => store.load(JSON.stringify(d));

describe("the build that owes a loaded document its Fit", () => {
  it("at launch, is the blank startup document's first build, and only that one", async () => {
    const a = app();
    void a.store.rebuildNow();
    await a.answer();
    expect(a.commits.at(-1), "launch was not framed (the camera stays at its constructor default)").toEqual({
      body: "(no solid)", fit: true, cue: false, release: false,
    });
    void a.store.rebuildNow(); // any later edit
    await a.answer();
    expect(a.commits.at(-1)!.fit, "an ordinary rebuild re-fit the camera").toBe(false);
  });

  it("on Open, is the opened document's own build, which also owes the cue", async () => {
    const a = app();
    void a.store.rebuildNow();
    await a.answer();
    open(a.store, doc("B"));
    await a.answer();
    expect(a.commits.at(-1)).toEqual({ body: "B", fit: true, cue: true, release: true });
  });

  it("is never the OLD document's reply, which still lands after the Open", async () => {
    // Open A, and open B while A's reply is on its way. Cancelling cannot stop a
    // reply the worker has already returned, so the store publishes A AFTER the
    // load, then builds B. Armed at the replacement, A spent the fit and the
    // cue, and B, the document the user opened, came up unframed and silent.
    const a = app();
    void a.store.rebuildNow();
    await a.answer(); // launch
    open(a.store, doc("A"));
    await Promise.resolve(); // A's rebuild is now in flight
    open(a.store, doc("B"));
    await a.answer(); // A's reply lands, after B was opened
    expect(a.commits.at(-1)?.body, "the setup did not publish the old reply after the load").toBe("A");
    expect(a.commits.at(-1), "the old document's reply took what B was owed").toMatchObject({
      fit: false, cue: false, release: false,
    });
    await a.answer(); // B's own rebuild
    expect(a.commits.at(-1)).toEqual({ body: "B", fit: true, cue: true, release: true });
  });

  it("is forgiven when the opened document builds no solid, so a later tool preview is not yanked", async () => {
    const a = app();
    void a.store.rebuildNow();
    await a.answer();
    open(a.store, doc(SKETCH_ONLY));
    await a.answer();
    // paid right here, as the origin view (viewport.clearModel(due.fit))
    expect(a.commits.at(-1)).toMatchObject({ body: "(no solid)", fit: true });
    a.store.setPreview({ id: "p1", type: "extrude" } as unknown as Parameters<DocumentStore["setPreview"]>[0]);
    await a.answer();
    expect(a.commits.at(-1)!.fit, "the first preview after a sketch-only open re-fit the camera mid-tool").toBe(false);
    expect(a.commits.at(-1)!.cue).toBe(false);
  });

  it("is forgiven when the opened document's first rebuild fails", async () => {
    const a = app();
    void a.store.rebuildNow();
    await a.answer();
    open(a.store, doc("B"));
    await a.answer(false); // the load's own rebuild fails
    void a.store.rebuildNow(); // the user fixes something, and it builds
    await a.answer();
    expect(a.commits.at(-1)).toEqual({ body: "B", fit: false, cue: false, release: false });
  });

  it("is the blank document's build for File > New, which owes a Fit but no cue", async () => {
    // main.ts's resetView() on New runs while the viewport still holds the OLD
    // model, so it framed the document just closed and nothing framed the new
    // one: a 3 m box, then New, left the camera 7.8 m out over an empty view.
    const a = app(doc("A"));
    void a.store.rebuildNow();
    await a.answer();
    a.store.newDocument();
    await a.answer();
    expect(a.commits.at(-1), "File > New left the blank document unframed").toEqual({
      body: "(no solid)", fit: true, cue: false, release: true,
    });
  });
});

describe("a load whose build the engine connection dropped", () => {
  /** main.ts's reconnect handler: re-arm, then rebuild. */
  const reconnect = (a: ReturnType<typeof app>) => {
    a.owed.reconnected();
    void a.store.rebuildNow();
  };

  it("is still owed its Fit and cue by the reconnect's rebuild of the same document", async () => {
    // The socket drops mid-load: client.ts settles every call in flight as
    // failed ("connection lost"), and the reconnect rebuilds the very same
    // document with nothing in between. Forgiven at the failed settle, the
    // opened document came back unframed and without its cue.
    const a = app();
    void a.store.rebuildNow();
    await a.answer();
    open(a.store, doc("B"));
    await a.answer(false); // connection lost
    reconnect(a);
    await a.answer();
    expect(a.commits.at(-1), "the reconnect rebuild of the opened document paid nothing").toEqual({
      body: "B", fit: true, cue: true, release: true,
    });
  });

  it("is not owed by the reconnect once another build ran in between", async () => {
    // Anything that starts a build (a preview, an edit) is a different piece of
    // work, and the first rule holds: whatever the load left unpaid is forgiven.
    const a = app();
    void a.store.rebuildNow();
    await a.answer();
    open(a.store, doc("B"));
    await a.answer(false);
    void a.store.rebuildNow(); // the user edits something, and it fails too
    await a.answer(false);
    reconnect(a);
    await a.answer();
    expect(a.commits.at(-1)).toEqual({ body: "B", fit: false, cue: false, release: false });
  });

  it("owes nothing on a reconnect after an ordinary build", async () => {
    const a = app();
    void a.store.rebuildNow();
    await a.answer(); // launch, paid
    void a.store.rebuildNow(); // an edit, dropped by the connection
    await a.answer(false);
    reconnect(a);
    await a.answer();
    expect(a.commits.at(-1)).toMatchObject({ fit: false, cue: false, release: false });
  });
});

describe("a fit paid early", () => {
  it("is not paid again at the commit, while the cue still is", () => {
    // A stream frames the model on its first frame, before the build settles,
    // and clears the fit; the cue waits for the committed body list.
    const owed = new LoadDebts();
    owed.replaced("load");
    owed.onBuild({ building: true });
    expect(owed.fit).toBe(true);
    expect(owed.firstFrame(), "the stream's first frame did not release the camera").toBe(true);
    owed.fit = false; // main.ts, when beginProgressiveModel fitted
    expect(owed.onBuild({ building: false })).toEqual({ fit: false, cue: true, release: false });
  });
});

describe("the camera release an opened document is owed", () => {
  // The document being replaced stays on screen, and navigable, until the new
  // one draws, and a cold 340-body open spends 60 to 150 s in OCCT first.
  // Released at the replacement, any orbit or wheel notch in that minute counted
  // as steering the NEW document, and cost it its Fit: it came up unframed.

  /** Launch, then open A and let it draw: the document on screen when B opens. */
  async function withAOnScreen() {
    const a = app();
    void a.store.rebuildNow();
    await a.answer();
    open(a.store, doc("A"));
    await a.answer(true, true);
    expect(a.released.at(-1), "the setup never put A on screen").toEqual({ at: "begin", body: "A" });
    a.released.length = 0;
    return a;
  }

  it("comes at the opened document's first frame, not while the old one is still on screen", async () => {
    const a = await withAOnScreen();
    open(a.store, doc("B"));
    for (let i = 0; i < 20; i++) await Promise.resolve(); // B builds, and A is what the user sees
    expect(a.released, "released at the replacement: a move over A during B's build cost B its fit").toEqual([]);
    await a.answer(true, true);
    expect(a.released).toEqual([{ at: "begin", body: "B" }]);
  });

  it("is paid once: the commit after the stream does not release again", async () => {
    // A move made while B streams in is the user steering B, and must keep
    // the commit from narrowing the fit (setModel's gate).
    const a = await withAOnScreen();
    open(a.store, doc("B"));
    await a.answer(true, true);
    expect(a.commits.at(-1), "the commit released the camera a second time").toMatchObject({ body: "B", release: false });
    expect(a.released).toHaveLength(1);
  });

  it("comes at the commit when the reply does not stream", async () => {
    const a = await withAOnScreen();
    open(a.store, doc("B"));
    await a.answer();
    expect(a.released).toEqual([{ at: "commit", body: "B" }]);
  });

  it("is never the old document's, nor an ordinary rebuild's", async () => {
    const a = await withAOnScreen();
    open(a.store, doc("C"));
    await Promise.resolve(); // C's rebuild is in flight
    open(a.store, doc("B"));
    await a.answer(true, true); // C's reply lands after B was opened
    expect(a.commits.at(-1)?.body, "the setup did not publish the old reply after the load").toBe("C");
    expect(a.released, "the old document's reply released the camera B was owed").toEqual([]);
    await a.answer(true, true);
    expect(a.released).toEqual([{ at: "begin", body: "B" }]);
    void a.store.rebuildNow(); // an edit
    await a.answer(true, true);
    expect(a.released, "an ordinary rebuild released the camera").toHaveLength(1);
  });
});

describe("main.ts pays the debts to the viewport", () => {
  // main.ts has more than one onBuild handler: take the one that pays the debts
  const onBuildAt = mainSrc.lastIndexOf("store.onBuild((s) => {", mainSrc.indexOf("owed.onBuild(s)"));
  const onBuildBody = mainSrc.slice(onBuildAt, mainSrc.indexOf("syncDatumPlanes();", onBuildAt));

  it("tells LoadDebts about every replacement and drops the old cue, but leaves the camera to the first frame", () => {
    const at = mainSrc.indexOf("store.onReplace(");
    expect(at, "no store.onReplace in main.ts, so no opened document is ever framed").toBeGreaterThan(-1);
    const body = mainSrc.slice(at, mainSrc.indexOf("});", at));
    expect(body).toContain("owed.replaced(how)");
    expect(
      body,
      "the camera is released at the replacement, while the old document is still on screen: one move over it "
        + "during a minute-long open costs the opened one its fit",
    ).not.toContain("releaseCamera");
    expect(
      body,
      "the hidden-bodies cue outlives its document, and its Show all un-hides the next file's bodies",
    ).toContain("hiddenCue?.dismiss()");
  });

  it("re-arms the debts on a reconnect, before the reconnect's rebuild", () => {
    const at = mainSrc.indexOf("geometry.onStatus((connected)");
    expect(at, "this test's slice is stale").toBeGreaterThan(-1);
    const body = mainSrc.slice(at, mainSrc.indexOf("\n});", at));
    const rearm = body.indexOf("owed.reconnected()");
    expect(rearm, "a load failed by a dropped connection is never framed after the reconnect").toBeGreaterThan(-1);
    expect(rearm).toBeLessThan(body.indexOf("store.rebuildNow()"));
  });

  it("feeds every build state to LoadDebts before anything can return early", () => {
    expect(onBuildAt, "this test's slice is stale").toBeGreaterThan(-1);
    const first = onBuildBody.split("\n").find((l) => /^\s+[a-z]/.test(l) && !/^\s+\/\//.test(l));
    expect(first?.trim()).toBe("const due = owed.onBuild(s);");
  });

  it("hands the owed fit to the commit, with or without a solid, and the cue to the toast", () => {
    expect(onBuildBody).toContain("viewport.setModel(s.result, due.fit, hidden)");
    expect(onBuildBody).toContain("viewport.clearModel(due.fit)");
    expect(onBuildBody).toContain("hiddenBodiesCue(bodyIds,");
    expect(onBuildBody).toMatch(/due\.cue && bodyIds\.length \? hiddenNow\(\)/);
  });

  it("takes the cue down once it stops being true", () => {
    // Shift+H after an all-hidden open left "All 2 bodies ... are hidden" up.
    expect(onBuildBody).toMatch(/if \(hiddenCue && hiddenNow\(\)\?\.message !== hiddenCue\.message\) \{\s*hiddenCue\.dismiss\(\);/);
  });

  it("lets a stream's first frame pay the fit", () => {
    expect(mainSrc).toMatch(/beginProgressiveModel\([^)]*owed\.fit\)\)\s*\{\s*owed\.fit = false;/);
  });

  it("releases the camera at the first frame, before that frame's fit", () => {
    const begin = mainSrc.slice(mainSrc.indexOf("store.onBuildChunk((c) => {"), mainSrc.indexOf("viewport.appendProgressiveBodies("));
    const release = begin.indexOf("if (owed.firstFrame()) viewport.releaseCamera();");
    expect(release, "a stream's first frame no longer releases the camera").toBeGreaterThan(-1);
    expect(release, "released after the begin's fit, which a move over the OLD document has already vetoed").toBeLessThan(
      begin.indexOf("viewport.beginProgressiveModel("),
    );
    const commit = onBuildBody.indexOf("if (due.release) viewport.releaseCamera();");
    expect(commit, "a reply that does not stream never releases the camera").toBeGreaterThan(-1);
    expect(commit).toBeLessThan(onBuildBody.indexOf("viewport.setModel(s.result, due.fit, hidden)"));
    expect(commit).toBeLessThan(onBuildBody.indexOf("viewport.clearModel(due.fit)"));
    expect(commit, "released outside the commit, where no frame is drawn").toBeGreaterThan(
      onBuildBody.indexOf("if (s.result && !s.building) {"),
    );
  });
});
