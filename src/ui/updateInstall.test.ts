// Once the user presses "Restart & update", the app says what is happening until
// it restarts, and says so if it fails (field report 1b0fd475: "Screen flashed
// update being downloaded, but nothing changed", about fifteen minutes before
// the restart). The startup prompt runs the check NON-interactively, and a
// failure after Install used to reach only the console. The "downloading" note
// was a 3.5 s toast over a download that can take minutes.
//
// checkForUpdates(false) is the startup path. Tauri and the dialog are stubbed;
// every assertion is over what reached toast().
import { describe, it, expect, vi, beforeEach } from "vitest";

const stub = vi.hoisted(() => ({
  shown: [] as { message: string; timeout: number | undefined; kind: string | undefined; open: boolean }[],
  invoked: [] as string[],
  /** what the fake download does after reporting its progress */
  ending: "finish" as "finish" | "fail",
}));

vi.mock("./toast", () => ({
  toast: (message: string, opts: { timeout?: number; kind?: string } = {}) => {
    const rec = { message, timeout: opts.timeout, kind: opts.kind, open: true };
    stub.shown.push(rec);
    return () => { rec.open = false; };
  },
}));
vi.mock("./choice", () => ({ choose: () => Promise.resolve("install") }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    stub.invoked.push(cmd);
    return Promise.resolve(cmd === "updates_supported" ? true : undefined);
  },
}));
type Ev = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => Promise.resolve({
    version: "0.1.300",
    downloadAndInstall: async (cb: (e: Ev) => void) => {
      cb({ event: "Started", data: { contentLength: 1000 } });
      for (let i = 0; i < 10; i++) cb({ event: "Progress", data: { chunkLength: 100 } });
      if (stub.ending === "fail") throw new Error("signature mismatch");
      cb({ event: "Finished" });
    },
  }),
}));

(globalThis as unknown as { window: unknown }).window ??= { __TAURI_INTERNALS__: {} };
(globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ ??= {};

import { checkForUpdates } from "./updates";

beforeEach(() => {
  stub.shown.length = 0;
  stub.invoked.length = 0;
});

describe("installing an update from the startup prompt", () => {
  it("keeps a downloading note up, with progress, until the download ends, then restarts", async () => {
    stub.ending = "finish";
    await checkForUpdates(false);
    const notes = stub.shown.filter((s) => s.message.startsWith("Downloading the update"));
    expect(notes.length).toBeGreaterThan(1);
    expect(notes.every((n) => n.timeout === 0)).toBe(true); // sticky, not a 3.5 s flash
    expect(notes.some((n) => n.message.includes("50%"))).toBe(true);
    expect(notes.filter((n) => n.open)).toEqual([]); // none left behind
    expect(stub.invoked).toContain("restart_for_update");
  });

  it("says so when the install fails, though the check was not interactive", async () => {
    stub.ending = "fail";
    await checkForUpdates(false);
    const errors = stub.shown.filter((s) => s.kind === "error");
    expect(errors.map((e) => e.message)).toEqual(["The update could not be installed: signature mismatch"]);
    expect(stub.shown.filter((s) => s.open && s.message.startsWith("Downloading"))).toEqual([]);
    expect(stub.invoked).not.toContain("restart_for_update");
  });
});
