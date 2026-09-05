// Field reports 647aadcc / 91b20cce / a58966e5 (Windows, 0.1.202): the sidecar
// died at startup ("OpenBLAS error: Memory allocation still failed after 10
// retries"), so nothing ever listened on the socket. The client then reconnected
// forever, and every failed attempt settled the queued rebuild with "geometry
// engine connection lost" — the reporter's breadcrumbs are nine of those and no
// word about the engine having failed to start. Extrudes looked like they
// "disappeared" because the model could never be rebuilt.
//
// So: once the Rust shell says the engine is gone, the client must STOP dialling
// and refuse calls with one steady message, until the user asks it to try again.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Geometry } from "./client";
import { ENGINE_DOWN, sidecarDeathMessage } from "./sidecarDeath";
import { EMPTY_DOCUMENT } from "../document/store";
import { installFakeDocument, byClass, type FakeEl } from "../ui/fakeDom.testkit";
import { createBugReporter } from "../ui/bugReporter";
import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "./client";
// The stylesheet is what makes "bottom-right corner" true. Read as text: there
// is no jsdom here and no layout engine (see chromeLegibility.test.ts:17).
import css from "../styles.css?raw";

/** A WebSocket that connects to nothing and records every construction, which
 *  is the thing under test: a retry is a NEW socket. */
class FakeSocket {
  static made: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0; // CONNECTING — nothing ever accepts
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.made.push(this);
  }
  send(raw: string) {
    this.sent.push(raw);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

interface Inner {
  connect(): void;
}

beforeEach(() => {
  FakeSocket.made = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  // client.ts schedules its reconnect through `window`, which a node-env test
  // does not have; forward at call time so the fake timers are honoured.
  vi.stubGlobal("window", {
    setTimeout: (...a: unknown[]) => (globalThis.setTimeout as never as (...x: unknown[]) => number)(...a),
    clearTimeout: (...a: unknown[]) => (globalThis.clearTimeout as never as (...x: unknown[]) => void)(...a),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A Geometry dialling a socket nobody answers, one failed attempt in. */
function dialling() {
  const g = new Geometry("ws://127.0.0.1:8765");
  (g as unknown as Inner).connect();
  FakeSocket.made[0]!.close(); // nothing listening
  return g;
}

describe("engine-down halt", () => {
  it("retries forever while nothing has told it the engine is gone", () => {
    dialling();
    // the pre-existing behaviour this fix keeps for an ordinary blip
    vi.advanceTimersByTime(600);
    expect(FakeSocket.made.length).toBe(2);
    FakeSocket.made[1]!.close();
    vi.advanceTimersByTime(1200);
    expect(FakeSocket.made.length).toBe(3);
  });

  it("opens no further socket once the shell reports the engine dead", () => {
    const g = dialling();
    const before = FakeSocket.made.length;

    g.haltReconnect(ENGINE_DOWN);

    // a full minute is six of the reporter's ~12 s cycles
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made.length).toBe(before);
  });

  it("settles a call made while halted instead of queueing it forever", async () => {
    const g = dialling();
    g.haltReconnect(ENGINE_DOWN);

    // DocumentStore.rebuildNow() awaits this; a promise that never settles
    // leaves `rebuilding` set and silently no-ops every later rebuild.
    const reply = await g.rebuild(EMPTY_DOCUMENT);
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.error.message).toBe(ENGINE_DOWN);
    expect(FakeSocket.made[0]!.sent).toEqual([]); // nothing went out
  });

  it("settles the rebuild already queued when the halt arrives", async () => {
    const g = dialling();
    const inFlight = g.rebuild(EMPTY_DOCUMENT); // queued: no socket is open

    g.haltReconnect(ENGINE_DOWN);

    const reply = await inFlight;
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.error.message).toBe(ENGINE_DOWN);
  });

  it("dials again, once, when the user asks", () => {
    const g = dialling();
    g.haltReconnect(ENGINE_DOWN);
    vi.advanceTimersByTime(60_000);
    const before = FakeSocket.made.length;

    g.resumeReconnect();
    vi.advanceTimersByTime(600);
    expect(FakeSocket.made.length).toBe(before + 1);

    // and it is a live client again: the next call reaches the socket instead
    // of being refused on the spot
    const ws = FakeSocket.made.at(-1)!;
    ws.readyState = FakeSocket.OPEN;
    void g.rebuild(EMPTY_DOCUMENT);
    expect(ws.sent).toHaveLength(1);
  });
});

describe("sidecarDeathMessage", () => {
  it("says the engine could not START, and repeats the sidecar's own words", () => {
    const m = sidecarDeathMessage({
      kind: "startup_failure",
      cause: "OpenBLAS error: Memory allocation still failed after 10 retries, giving up.",
    });
    expect(m.toLowerCase()).toContain("could not start");
    // the err: line is the whole diagnostic value of the message — a screenshot
    // of the toast is often the only thing a report carries
    expect(m).toContain("OpenBLAS");
    expect(m).toContain("restart SindriCAD");
    // the sidecar's line ends in a full stop and so does the sentence around it
    expect(m, "the cause's own full stop doubled up").not.toContain(".).");
  });

  it("sends the user to a bug button that exists, not to a Help menu item that does not", () => {
    // THIS is the deliverable: a field report of a dead engine arrives as a
    // screenshot of this toast, so the one action the sentence names has to be
    // findable. It named "Help", and the Help menu (src/main.ts) has no
    // bug-report item — reporting is the floating button below, which
    // ui/bugReporter.ts is explicitly built to work with the sidecar dead.
    const m = sidecarDeathMessage({ kind: "startup_failure", cause: "OpenBLAS error: giving up" });
    expect(m, "the Help menu has no bug-report item").not.toMatch(/\bHelp\b/);

    // The control the sentence names, mounted for real and read back.
    installFakeDocument();
    const doc = globalThis as unknown as { document: { body: FakeEl } };
    // Neither dep is touched until the dialog opens; mounting the button is all
    // this asks of the reporter.
    createBugReporter({ store: {} as DocumentStore, geometry: {} as GeometryBackend });
    const btn = byClass(doc.document.body, "bug-report-btn")[0];
    expect(btn, "createBugReporter no longer mounts .bug-report-btn").toBeTruthy();

    // It is an icon-only circle, so the word the sentence uses has to match what
    // the button calls itself in its tooltip and to a screen reader.
    const name = (btn!.getAttribute("aria-label") ?? btn!.title).toLowerCase();
    expect(name).toContain("bug");
    expect(m.toLowerCase()).toContain("bug button");

    // ...and the corner the sentence sends them to is the corner the stylesheet
    // pins it in. A rule change here silently turns the directions into a lie.
    const rule = css.slice(css.indexOf(".bug-report-btn {"));
    const block = rule.slice(0, rule.indexOf("}"));
    expect(block, ".bug-report-btn is no longer pinned to a corner").toMatch(/position:\s*fixed/);
    expect(block).toMatch(/bottom:/);
    expect(block).toMatch(/right:/);
    expect(m.toLowerCase()).toContain("bottom-right");
  });

  it("still says something usable when the cause is empty", () => {
    const m = sidecarDeathMessage({ kind: "startup_failure", cause: "" });
    expect(m.toLowerCase()).toContain("could not start");
    expect(m).not.toContain("()");
    expect(m).not.toContain(": .");
  });

  it("keeps calling a crash a crash, and a taken port a taken port", () => {
    const crash = sidecarDeathMessage({ kind: "crash", cause: "killed by SIGSEGV (11)" });
    expect(crash).toContain("crashed");
    expect(crash).toContain("SIGSEGV");

    const port = sidecarDeathMessage({
      kind: "port_in_use",
      cause: "cannot open port 8765 on 127.0.0.1",
    });
    expect(port).toContain("8765");
    expect(port.toLowerCase()).toContain("another copy");
    expect(port.toLowerCase()).not.toContain("crashed");
  });
});
