// One worker builds for every connection, so another connection's cancel, stall
// or timeout kills it under whatever this one had running or queued. That op
// came back as "the geometry kernel crashed on this operation", which sent the
// user looking for a fault in a model that was fine. The sidecar now codes it
// (`stoppedByOther`), and the code is what puts it in the user's language. These
// enter where a rebuild's reply lands: DocumentStore.rebuildNow().
import { afterEach, describe, expect, it } from "vitest";
import { DocumentStore } from "./store";
import { setLocale, t } from "../i18n";
import type { GeometryBackend } from "../geometry/client";
import type { RebuildReply } from "../types";

// The sidecar's reply, word for word (server._stopped_by_other_result).
const STOPPED: RebuildReply = {
  ok: false,
  error: { message: "stopped because another operation was cancelled, try again", code: "stoppedByOther" },
};

function storeAnswering(reply: RebuildReply) {
  const backend = {
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async rebuild() { return reply; },
    async cancel() { return true; },
    connected: true,
  } as unknown as GeometryBackend;
  return new DocumentStore(backend, { parameters: {}, features: [] });
}

afterEach(() => setLocale("en"));

describe("a rebuild stopped by another operation", () => {
  it("says so, and is shown rather than hidden like a cancel the user asked for", async () => {
    const store = storeAnswering(STOPPED);
    await store.rebuildNow();
    expect(store.buildState.errorMessage).toBe("stopped because another operation was cancelled, try again");
    expect(store.buildState.cancelled).toBe(false);
    expect(store.buildState.errorFeatureId).toBeNull();
  });

  it("is translated by its code, not passed through in English", async () => {
    setLocale("qps-ploc");
    const store = storeAnswering(STOPPED);
    await store.rebuildNow();
    const shown = store.buildState.errorMessage ?? "";
    expect(shown).toBe(t("engine.error.stoppedByOther"));
    expect(shown, "the English came through untranslated").not.toContain("another operation");
  });
});
