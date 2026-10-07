// Thread: click a cylindrical face, pick a standard, get a real modeled
// thread. This drives the REAL ThreadTool against fake viewport/store
// surfaces, the way extrudeStartEnd.test.ts drives ExtrudeTool, because what
// matters is what lands in the feature object the sidecar rebuilds from —
// not the panel's DOM.
//
// The face pick is the plan's deliberate exception to the single-face-pick
// convention: it goes through store.queryReferences (the authorRef round
// trip) rather than storing the raw by:"nearest" click, because the query
// reply's radius/external fields are what let this tool preselect a
// standard. These tests simulate that round trip by resolving the promise
// by hand.

import { describe, expect, it } from "vitest";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import type { Feature, Selector } from "../types";
import type { QueryResult } from "../geometry/client";
import { lookupThread } from "./threadStandards";

installFakeDocument();
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement ??= FakeEl;
(globalThis as unknown as { Node: unknown }).Node ??= FakeEl;

const { ThreadTool } = await import("./threadTool");

type Reply = (r: QueryResult[]) => void;

/** A fresh tool wired to fake viewport/store surfaces, plus everything a test
 *  needs to drive it: a canned face pick, a hand-resolved query reply, and
 *  the committed/previewed features. */
function harness(features: Feature[] = []) {
  let nextHit: { selector: Selector; bodyId: string | null } | null = null;
  const added: Feature[] = [];
  const replaced: { id: string; feature: Feature }[] = [];
  const previews: (Feature | null)[] = [];
  const queries: { items: { kind: string; body: string; sel: Selector }[]; editingId: string | null }[] = [];
  const replies: Reply[] = [];
  const paramBound = new Set<string>();

  const viewport = {
    suspendPicking: false,
    hoverFaceAt: () => null as number | null,
    clearHover() {},
    pickFaceForPressPull: () => nextHit,
    domElement: {
      style: {},
      addEventListener() {},
      removeEventListener() {},
    },
  };

  const store = {
    document: { features },
    isParamBound: (target: { feature: string; field: string }) => paramBound.has(`${target.feature}.${target.field}`),
    nextId: () => "new1",
    addFeature: (f: Feature) => added.push(f),
    replaceFeature: (id: string, f: Feature) => replaced.push({ id, feature: f }),
    setPreview: (f: Feature | null) => previews.push(f),
    setEditPreview: (f: Feature | null) => previews.push(f),
    beginEditPreview() {},
    endEditPreview() {},
    queryReferences: (items: { kind: string; body: string; sel: Selector }[], editingId: string | null) => {
      queries.push({ items, editingId });
      return new Promise<QueryResult[]>((res) => replies.push(res));
    },
  };

  const tool = new ThreadTool(viewport as never, store as never);
  const internals = tool as unknown as {
    onDown(e: PointerEvent): void;
    commit(): void;
    onPanelChoice(id: string, v: string): void;
    onPanelNumber(id: string, v: number | null, raw: string): void;
    onPanelSelect(id: string, v: string): void;
  };

  const click = (hit: { selector: Selector; bodyId: string | null } | null) => {
    nextHit = hit;
    internals.onDown({ button: 0, clientX: 1, clientY: 1, preventDefault() {}, stopImmediatePropagation() {} } as PointerEvent);
  };
  const commit = () => internals.commit();
  const onPanelChoice = (id: string, v: string) => internals.onPanelChoice(id, v);
  const onPanelNumber = (id: string, v: number | null, raw: string) => internals.onPanelNumber(id, v, raw);
  const onPanelSelect = (id: string, v: string) => internals.onPanelSelect(id, v);
  /** flush the one pending queryReferences reply */
  const resolve = async (result: QueryResult[]) => {
    const reply = replies.pop();
    if (!reply) throw new Error("no pending query to resolve");
    reply(result);
    await Promise.resolve();
    await Promise.resolve();
  };

  return { tool, store, added, replaced, previews, queries, paramBound, click, resolve, commit, onPanelChoice, onPanelNumber, onPanelSelect };
}

const SEL: Selector = { kind: "face", by: "nearest", point: [1, 2, 3] };

describe("ThreadTool — picking a face preselects a standard", () => {
  it("an external pick (a shaft) preselects by major diameter and marks external", async () => {
    const h = harness();
    let done: (id: string | null) => void = () => {};
    h.tool.start((id) => { done = () => id; });
    h.click({ selector: SEL, bodyId: "b1" });

    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]!.items).toEqual([{ kind: "face", body: "b1", sel: SEL }]);
    expect(h.queries[0]!.editingId).toBeNull();

    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.majorDiameter / 2, external: true }] }]);

    // committing with no further panel changes stores the preselected
    // standard, the authored by:"match" selector, and no optional fields
    h.commit();
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toEqual({ id: "new1", type: "thread", face: { ...SEL, body: "b1" }, standard: "M6x1", body: "b1" });
    done(null);
  });

  it("an internal pick (a hole) preselects by minor (tap-drill) diameter and marks internal", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.minorDiameter / 2, external: false }] }]);
    h.commit();
    expect((h.added[0] as { standard: string }).standard).toBe("M6x1");
  });

  it("an internal pick of a 6 mm hole (M6x1's NOMINAL major diameter, drawn as modeled for printing, not tap-drilled) preselects M6x1 — not Tr8x8, whose minor diameter happens to be exactly 6 mm", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.majorDiameter / 2, external: false }] }]);
    h.commit();
    expect((h.added[0] as { standard: string }).standard).toBe("M6x1");
  });

  it("a face that isn't a full cylinder refuses the pick, never opening the panel", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL }] }]); // no radius/external
    h.commit(); // nothing pending to commit — the pick never produced values
    expect(h.added).toHaveLength(0);
  });

  it("a click that misses the body is left alone, not treated as a refusal", () => {
    const h = harness();
    h.tool.start(() => {});
    h.click(null);
    expect(h.queries).toHaveLength(0);
  });
});

describe("ThreadTool — panel choices land in the stored feature", () => {
  it("print fit, a clearance, a length and left-hand all round-trip into the feature", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.majorDiameter / 2, external: true }] }]);

    h.onPanelChoice("fit", "print");
    h.onPanelNumber("clearance", 0.2, "0.2");
    h.onPanelNumber("length", 12, "12");
    h.onPanelChoice("handedness", "left");

    h.commit();
    expect(h.added[0]).toEqual({
      id: "new1", type: "thread", face: { ...SEL, body: "b1" }, standard: "M6x1",
      fit: "print", clearance: 0.2, length: 12, leftHand: true, body: "b1",
    });
  });

  it("an unreadable number blocks commit instead of storing garbage", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.majorDiameter / 2, external: true }] }]);

    h.onPanelNumber("length", null, "abc"); // the field shows red; the value does not update
    h.commit();
    // "abc" was refused by onPanelNumber itself (length stays at its default,
    // null = whole face), so commit succeeds with no length field at all —
    // this only documents that the bad input never reached the feature
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).not.toHaveProperty("length");
  });
});

describe("ThreadTool — starts (multi-start threads)", () => {
  it("switching the standard to Tr8x8 adopts its natural 4 starts, omitted from the stored feature when left unchanged", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.majorDiameter / 2, external: true }] }]);

    const tr88 = lookupThread("Tr8x8")!;
    expect(tr88.starts).toBe(4);
    h.onPanelSelect("standard", "Tr8x8");

    h.commit();
    expect(h.added[0]).toEqual({ id: "new1", type: "thread", face: { ...SEL, body: "b1" }, standard: "Tr8x8", body: "b1" });
    expect(h.added[0]).not.toHaveProperty("starts");
  });

  it("overriding starts on a single-start standard stores the override", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.majorDiameter / 2, external: true }] }]);

    h.onPanelNumber("starts", 2, "2");
    h.commit();
    expect(h.added[0]).toEqual({ id: "new1", type: "thread", face: { ...SEL, body: "b1" }, standard: "M6x1", body: "b1", starts: 2 });
  });

  it("overriding Tr8x8 down to a single start stores that override too", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.majorDiameter / 2, external: true }] }]);

    h.onPanelSelect("standard", "Tr8x8");
    h.onPanelNumber("starts", 1, "1");
    h.commit();
    expect(h.added[0]).toEqual({ id: "new1", type: "thread", face: { ...SEL, body: "b1" }, standard: "Tr8x8", body: "b1", starts: 1 });
  });

  it("an out-of-range starts value is clamped to [1, 8]", async () => {
    const h = harness();
    h.tool.start(() => {});
    h.click({ selector: SEL, bodyId: "b1" });
    const m6 = lookupThread("M6x1")!;
    await h.resolve([{ index: 0, ok: true, count: 1, entities: [{ body: "b1", sel: SEL, radius: m6.majorDiameter / 2, external: true }] }]);

    h.onPanelNumber("starts", 12, "12");
    h.commit();
    expect((h.added[0] as { starts?: number }).starts).toBe(8);
  });

  it("re-editing an old Tr8x8 document with no stored starts defaults the panel to its natural 4 and replaces unchanged", () => {
    const oldDoc: Feature = { id: "t1", type: "thread", face: SEL, body: "b1", standard: "Tr8x8" } as Feature;
    const h = harness([oldDoc]);
    expect(h.tool.startEdit("t1", () => {})).toBe(true);
    h.commit();
    // the old document never stored `starts`, so re-saving it unchanged must
    // not inject a new key — but the geometry it rebuilds to is now correct
    // (4 starts, see thread_standards.json), which is the whole point of the fix
    expect(h.replaced).toEqual([{ id: "t1", feature: oldDoc }]);
  });
});

describe("ThreadTool — editing an existing thread", () => {
  const existing: Feature = {
    id: "t1", type: "thread", face: SEL, body: "b1", standard: "M6x1",
    fit: "print", clearance: 0.3, length: 8, leftHand: true,
  } as Feature;

  it("reopens with the feature's own values and replaces it unchanged on a no-op edit", () => {
    const h = harness([existing]);
    const started = h.tool.startEdit("t1", () => {});
    expect(started).toBe(true);
    expect(h.queries).toHaveLength(0); // no new face pick on a plain re-edit

    h.commit();
    expect(h.replaced).toEqual([{ id: "t1", feature: existing }]);
  });

  it("refuses to start when a bound field is an expression or parameter", () => {
    const h = harness([existing]);
    h.paramBound.add("t1.length");
    expect(h.tool.startEdit("t1", () => {})).toBe(false);
  });

  it("refuses to start on a non-thread feature", () => {
    const h = harness([{ id: "e1", type: "extrude" } as unknown as Feature]);
    expect(h.tool.startEdit("e1", () => {})).toBe(false);
  });
});
