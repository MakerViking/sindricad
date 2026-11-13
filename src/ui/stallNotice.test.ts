// Field report 6ddd01dc: one Mirror on a 2012 CPU ran past the sidecar's stall
// limit, the engine was restarted on every retry, the model never built again,
// and the status bar said "⚠ : the geometry engine stopped responding", naming
// nothing. Past the limit the sidecar now keeps waiting while the app is
// connected and says how long, and which step; the app asks "wait, or Stop?".
//
// These follow that signal from the socket frame to what the user reads: the
// client hands the stall on, the store holds it only while it is true, the
// toast names the TIMELINE step (not the index into the sent document), Stop is
// the busy op's cancel, and a failed build's status line names its step.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Geometry, type BuildStall, type GeometryBackend } from "../geometry/client";
import { DocumentStore } from "../document/store";
import { buildErrorStatus } from "../geometry/featureErrorText";
import { StallNotice, stallNoticeText } from "./stallNotice";
import type { ToastOptions } from "./toast";
import type { CadDocument, RebuildReply } from "../types";

class FakeSocket {
  static made: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.made.push(this);
  }
  send() {}
  close() {}
}

// Doug's timeline, cut down: four suppressed steps sit before the Mirror, so
// the sidecar's index (82) is NOT the timeline step (86). Only the id is.
const features = [
  ...Array.from({ length: 85 }, (_, i) => ({ id: `s${i}`, type: "sketch" })),
  { id: "f119", type: "mirror" },
];

describe("a long step: the client hands the stall on", () => {
  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("passes seconds and the step id past the limit, and null before it", () => {
    const g = new Geometry("ws://127.0.0.1:8765");
    (g as unknown as { connect(): void }).connect();
    const seen: (BuildStall | null)[] = [];
    g.onProgress((_f, _m, _t, stalled) => seen.push(stalled));
    const frame = (o: object) =>
      FakeSocket.made.at(-1)!.onmessage!({ data: JSON.stringify({ id: "r1", status: "building", ...o }) });
    frame({ feature: 82, meshed: -1, meshTotal: -1 });
    frame({ feature: 82, meshed: -1, meshTotal: -1, stalled: 181, featureId: "f119" });
    frame({ feature: 82, meshed: -1, meshTotal: -1, stalled: 190 });
    expect(seen).toEqual([null, { seconds: 181, featureId: "f119" }, { seconds: 190, featureId: null }]);
  });
});

describe("a long step: the store holds the stall only while it is true", () => {
  type Fn = (f: number, m: number, t: number, s: BuildStall | null) => void;
  it("records it while building and drops it when progress moves on", () => {
    const listeners: Fn[] = [];
    const be = {
      async rebuild(): Promise<RebuildReply> { return { ok: false, error: { message: "stub" } }; },
      async init() {},
      onStatus() { return () => {}; },
      onProgress(fn: Fn) { listeners.push(fn); return () => {}; },
      async cancel() { return true; },
      connected: true,
    } as unknown as GeometryBackend;
    const doc: CadDocument = { parameters: {}, features: [] };
    const store = new DocumentStore(be, doc);
    (store as unknown as { build: { building: boolean } }).build.building = true;
    listeners.forEach((fn) => fn(82, -1, -1, { seconds: 181, featureId: "f119" }));
    expect(store.buildState.stalled).toEqual({ seconds: 181, featureId: "f119" });
    listeners.forEach((fn) => fn(83, -1, -1, null));
    expect(store.buildState.stalled).toBeNull();
  });
});

describe("a long step: the question the user reads", () => {
  function notice() {
    const shown: { message: string; opts: ToastOptions; dismissed: boolean }[] = [];
    const stop = vi.fn();
    const n = new StallNotice((message, opts) => {
      const rec = { message, opts, dismissed: false };
      shown.push(rec);
      return () => { rec.dismissed = true; };
    }, stop);
    return { n, shown, stop };
  }
  const stalled = (seconds: number, featureId: string | null = "f119") => ({ building: true, stalled: { seconds, featureId } });

  it("names the timeline step and the minutes, not the sidecar's index", () => {
    const text = stallNoticeText({ seconds: 185, featureId: "f119" }, features);
    expect(text).toContain("the Mirror at step 86 in the timeline");
    expect(text).toContain("over 3 minutes");
    expect(stallNoticeText({ seconds: 185, featureId: null }, features)).toContain("one step");
    // the verification run's 10 s limit read "for over 1 minutes"
    expect(stallNoticeText({ seconds: 70, featureId: "f119" }, features)).toContain("for over a minute now");
  });

  it("asks once per stalled step, sticky, with Stop wired to the cancel", () => {
    const { n, shown, stop } = notice();
    n.update(stalled(181), features);
    n.update(stalled(182), features);
    n.update(stalled(183), features);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.opts.timeout).toBe(0);
    expect(shown[0]!.opts.action?.label).toBe("Stop");
    shown[0]!.opts.action!.onClick();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("takes the question down when the step finishes or the build ends", () => {
    const { n, shown } = notice();
    n.update(stalled(181), features);
    n.update({ building: true, stalled: null }, features); // moved on
    expect(shown[0]!.dismissed).toBe(true);
    n.update(stalled(181), features);
    n.update({ building: false, stalled: { seconds: 200, featureId: "f119" } }, features); // settled
    expect(shown[1]!.dismissed).toBe(true);
  });

  it("does not ask again after the user closed it (that is 'keep waiting')", () => {
    const { n, shown } = notice();
    n.update(stalled(181), features);
    shown[0]!.dismissed = true; // the user's own close
    n.update(stalled(240), features);
    expect(shown).toHaveLength(1);
  });

  it("asks again for a different step stalling later in the same build", () => {
    const { n, shown } = notice();
    n.update(stalled(181, "f119"), features);
    n.update(stalled(181, "s3"), features);
    expect(shown).toHaveLength(2);
    expect(shown[0]!.dismissed).toBe(true);
  });
});

describe("a failed build's status line names its step", () => {
  it("names the step as the timeline does, never the raw id", () => {
    const line = buildErrorStatus("f119", "it ran too long", features);
    expect(line).toBe("⚠ Mirror (step 86): it ran too long");
  });

  it("drops the prefix when there is no step to name (was '⚠ : ...')", () => {
    expect(buildErrorStatus(null, "the geometry engine stopped", features)).toBe("⚠ the geometry engine stopped");
    expect(buildErrorStatus("gone", "x", features)).toBe("⚠ x");
  });
});
