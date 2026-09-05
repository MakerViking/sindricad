// An inspector edit has to reach the sidecar (field reports c2cac5f3, f39f6e08,
// ed1d4d98, 8d09f11b — "typed a target offset / sphere radius, nothing changed
// until I scrubbed the timeline or hit Compute All").
//
// The wire delta in geometry/client.ts ships a feature only when its OBJECT
// REFERENCE differs from the one last sent. writeTarget used to poke the new
// number into the existing feature object, so the store rebuilt against a
// document the encoder saw as unchanged: no feature in the delta, and the
// sidecar kept building the old value. Both writers go through writeTarget —
// the inspector's plain-number path and the parameter recompute that runs
// inside every mutate — so the contract is tested at that level: after a
// value-changing write, the owning feature is a NEW object.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DocumentStore } from "./store";
import { writeTarget } from "./numFields";
import type { CadDocument, Feature, ParamDef, RebuildReply } from "../types";
import type { GeometryBackend } from "../geometry/client";

function stubBackend(): GeometryBackend {
  return {
    async rebuild(): Promise<RebuildReply> {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
}

function makeStore(features: Feature[], paramDefs?: Record<string, ParamDef>) {
  const doc = { parameters: {}, features, ...(paramDefs ? { paramDefs } : {}) } as unknown as CadDocument;
  return new DocumentStore(stubBackend(), doc);
}

const sphere = { id: "p1", type: "sphere", radius: 10 } as unknown as Feature;
const pressPull = {
  id: "e1", type: "extrude", sketch: "s1", operation: "join", upToPlane: "d1", upToOffset: 0,
} as unknown as Feature;
// A chamfer's Length is on the same path (numFields maps chamfer -> distance),
// so it went the same way. Pinned here as its own case because a0a76571 named
// the chamfer and every other case here is a different feature type — NOT as a
// claim that this file fixes that report, whose chamfer never reached the
// document at all: OCCT refused it. See edgeFeatureToolPreview.test.ts.
const chamfer = {
  id: "ch1", type: "chamfer", edges: { kind: "edge", point: [0, 0, 5] }, distance: 1,
} as unknown as Feature;

describe("writeTarget replaces the owning feature object", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // the store schedules its debounced rebuild off `window`
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a plain-number inspector edit yields a new feature reference", () => {
    const store = makeStore([sphere]);
    const before = store.document.features[0];
    store.setTargetValue({ kind: "feature", feature: "p1", field: "radius" }, 25, "length");
    const after = store.document.features[0];
    expect((after as unknown as { radius: number }).radius).toBe(25);
    expect(after).not.toBe(before);
  });

  it("a target-offset edit on a press/pull yields a new feature reference", () => {
    const store = makeStore([pressPull]);
    const before = store.document.features[0];
    store.setTargetValue({ kind: "feature", feature: "e1", field: "upToOffset" }, -5, "length");
    const after = store.document.features[0];
    expect((after as unknown as { upToOffset: number }).upToOffset).toBe(-5);
    expect(after).not.toBe(before);
  });

  it("a parameter edit re-asserted into a bound field yields a new feature reference", () => {
    const defs: Record<string, ParamDef> = {
      r: { expr: "10", value: 10, unit: "mm", target: { kind: "feature", feature: "p1", field: "radius" } },
    } as unknown as Record<string, ParamDef>;
    const store = makeStore([sphere], defs);
    const before = store.document.features[0];
    expect(store.setParamExpr("r", "30")).toBeNull();
    vi.runAllTimers();
    return Promise.resolve().then(() => {
      const after = store.document.features[0];
      expect((after as unknown as { radius: number }).radius).toBe(30);
      expect(after).not.toBe(before);
    });
  });

  it("a chamfer Length edit yields a new feature reference", () => {
    const store = makeStore([chamfer]);
    const before = store.document.features[0];
    store.setTargetValue({ kind: "feature", feature: "ch1", field: "distance" }, 5, "length");
    const after = store.document.features[0];
    expect((after as unknown as { distance: number }).distance).toBe(5);
    expect(after, "the panel would show 5 mm and the sidecar would keep building 1")
      .not.toBe(before);
  });

  it("a no-op write keeps the reference (nothing to ship)", () => {
    const doc = { parameters: {}, features: [{ ...sphere }] } as unknown as CadDocument;
    const before = doc.features[0];
    expect(writeTarget(doc, { kind: "feature", feature: "p1", field: "radius" }, 10)).toBeNull();
    expect(doc.features[0]).toBe(before);
  });
});
