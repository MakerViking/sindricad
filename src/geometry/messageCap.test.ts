// GH #4, "Release build cannot open files larger than 245 MB".
//
// The sidecar's websockets server answers any frame past `max_size` with a 1009
// close instead of an error reply. That took the whole session down rather than
// one operation: the oversized body stays in the document, so every following
// rebuild re-sent it and re-killed the socket, and the only thing the user was
// shown was "geometry engine connection lost" — which points at the connection,
// not at the file they just opened.
//
// The client therefore has to refuse the payload BEFORE sending it. This pins
// the boundary and, more importantly, that the message names the real limit:
// the reporter explicitly asked for "a clear error explaining the limit".
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, tooLargeToSend } from "./client";

describe("oversized-payload guard", () => {
  it("passes anything at or under the cap", () => {
    expect(tooLargeToSend(0)).toBeNull();
    expect(tooLargeToSend(1024)).toBeNull();
    expect(tooLargeToSend(MAX_MESSAGE_BYTES - 1)).toBeNull();
    // exactly at the cap is still accepted: the server compares with >, so an
    // off-by-one here would reject payloads that would have gone through fine
    expect(tooLargeToSend(MAX_MESSAGE_BYTES)).toBeNull();
  });

  it("rejects one byte past the cap", () => {
    expect(tooLargeToSend(MAX_MESSAGE_BYTES + 1)).not.toBeNull();
  });

  it("names both the payload size and the limit, in units a human reads", () => {
    // the size the field report was filed about
    const msg = tooLargeToSend(245 * 1000 * 1000)!;
    expect(msg).not.toBeNull();
    expect(msg).toContain("128 MiB"); // the limit
    expect(msg).toContain("234 MiB"); // 245 MB expressed as MiB
    // and it has to say what to DO, not just what went wrong
    expect(msg.toLowerCase()).toContain("remove or simplify");
  });

  it("mirrors the sidecar's max_size", () => {
    // sidecar/server.py: websockets.serve(..., max_size=128 * 1024 * 1024).
    // If that changes and this does not, oversized frames go back to killing
    // the socket with no explanation.
    expect(MAX_MESSAGE_BYTES).toBe(128 * 1024 * 1024);
  });
});
