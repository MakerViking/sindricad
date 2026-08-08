import { describe, expect, it, vi } from "vitest";
import { Geometry, decodeBinaryFrame } from "./client";

// The client half of the chunked rebuild reply (sidecar/server.py's
// _stream_binary_reply). test_ws.py proves the encoder and that a stream
// reassembles to the same reply the single-frame encoder produces; this proves
// the reader, and especially the failure paths — a stream that cannot finish
// MUST settle its pending call, because a rebuild left pending forever leaves
// DocumentStore.rebuildNow()'s `rebuilding` flag set and silently no-ops every
// later rebuild for the life of the session.

/** Lay out one frame exactly as server.py's _frame_bytes does. */
function frame(env: object, buffers: (Float32Array | Uint32Array)[] = []): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify(env));
  const pad = (4 - (header.length % 4)) % 4;
  let total = 4 + header.length + pad;
  for (const b of buffers) total += b.byteLength;
  const out = new ArrayBuffer(total);
  const u8 = new Uint8Array(out);
  new DataView(out).setUint32(0, header.length, true);
  u8.set(header, 4);
  let off = 4 + header.length + pad;
  for (const b of buffers) {
    u8.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
    off += b.byteLength;
  }
  return out;
}

/** One full body's wire payload plus the buffers it references, numbered from
 *  `base` — buffer indices are FRAME-local, so each chunk restarts at 0. */
function fullBody(id: string, base: number) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const faceIds = new Uint32Array([0]);
  const pts = new Float32Array([0, 0, 0, 1, 0, 0]);
  const counts = new Uint32Array([2]);
  return {
    body: {
      id, name: id, etag: `etag-${id}`, faceCount: 1,
      positions: { $buf: base }, indices: { $buf: base + 1 },
      faceIds: { $buf: base + 2 },
      edges: { $pts: { $buf: base + 3 }, $counts: { $buf: base + 4 }, body: id },
    },
    buffers: [positions, indices, faceIds, pts, counts],
  };
}

function manifestOf(ids: string[]) {
  return ids.map((id) => ({
    id, name: id, etag: `etag-${id}`, faceCount: 1,
    nVerts3: 9, nIdx: 3, nTris: 1, nEdges: 1,
  }));
}

function headFrame(id: string, sid: string, ids: string[], extra: object = {}) {
  return frame({
    id,
    stream: { sid, seq: 0, final: ids.length === 0 },
    ...(ids.length === 0 ? { ok: true } : { status: "chunk" }),
    result: {
      protocol: 2,
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      manifest: manifestOf(ids),
      ...extra,
    },
  });
}

function chunkFrame(id: string, sid: string, seq: number, final: boolean, ids: string[]) {
  const parts = ids.map((bid, i) => fullBody(bid, i * 5));
  return frame({
    id,
    stream: { sid, seq, final },
    ...(final ? { ok: true } : { status: "chunk" }),
    result: { bodies: parts.map((p) => p.body), $buffers: parts.flatMap(() => [
      { dtype: "f32", len: 9 }, { dtype: "u32", len: 3 }, { dtype: "u32", len: 1 },
      { dtype: "f32", len: 6 }, { dtype: "u32", len: 1 },
    ]) },
  }, parts.flatMap((p) => p.buffers));
}

interface Inner {
  pending: Map<string, (m: unknown) => void>;
  streams: Map<string, unknown>;
  handleBinaryReply(buf: ArrayBuffer): void;
}

/** A Geometry with one call in flight. The constructor opens no socket, so this
 *  drives the frame reader as a pure function. */
function pendingGeom(id = "rq") {
  const g = new Geometry();
  const inner = g as unknown as Inner;
  const replies: any[] = [];
  inner.pending.set(id, (m) => replies.push(m));
  return { g, inner, replies };
}

describe("decodeBinaryFrame", () => {
  it("resolves frame-local buffer indices, so each chunk decodes alone", () => {
    const f = chunkFrame("rq", "s1", 1, true, ["a", "b"]);
    const h = decodeBinaryFrame(f);
    const [a, b] = h.result.bodies as any[];
    // b's buffers are indices 5..9 of ITS OWN table — a global table would have
    // made this read a's data back
    expect(Array.from(a.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(b.indices)).toEqual([0, 1, 2]);
    expect(a.edges).toEqual([{ points: [[0, 0, 0], [1, 0, 0]], body: "a" }]);
    expect(b.edges).toEqual([{ points: [[0, 0, 0], [1, 0, 0]], body: "b" }]);
    expect("$buffers" in (h.result as object)).toBe(false);
  });
});

describe("chunked reply reassembly", () => {
  it("resolves once, on the final frame, with the bodies in manifest order", () => {
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", ["a", "b", "c"]));
    expect(replies).toHaveLength(0);
    inner.handleBinaryReply(chunkFrame("rq", "s1", 1, false, ["a", "b"]));
    expect(replies).toHaveLength(0); // an interim chunk must never settle the call
    inner.handleBinaryReply(chunkFrame("rq", "s1", 2, true, ["c"]));

    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(true);
    // the stream assembles as it goes, so the reply carries the FINISHED result
    expect(replies[0].result.assembled.bodies.map((b: any) => b.id)).toEqual(["a", "b", "c"]);
    expect(inner.streams.size).toBe(0);
    expect(inner.pending.size).toBe(0);
  });

  it("carries the head's non-body fields onto the reassembled result", () => {
    // projectionUpdates/diagnostics ride the head. Dropping any of them would
    // also drift assemble()'s no-op signature, silently costing the
    // visibility-only fast path on every eye toggle.
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", ["a"], {
      diagnostics: [{ kind: "note" }],
      projectionUpdates: [{ feature: "f1" }],
      featureErrors: [{ feature_id: "f2", message: "bad" }],
    }));
    inner.handleBinaryReply(chunkFrame("rq", "s1", 1, true, ["a"]));

    const r = replies[0].result.assembled;
    expect(r.bbox).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(r.diagnostics).toEqual([{ kind: "note" }]);
    expect(r.projectionUpdates).toEqual([{ feature: "f1" }]);
    expect(r.featureErrors).toEqual([{ feature_id: "f2", message: "bad" }]);
    expect("manifest" in r).toBe(false); // framing detail, not part of the reply
  });

  it("resolves a bodiless reply from the head frame alone", () => {
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", []));
    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(true);
    expect(replies[0].result.assembled.bodies).toEqual([]);
    expect(inner.streams.size).toBe(0);
  });

  it("fails the call when the stream ends short of its manifest", () => {
    // The load-bearing case: assemble() PRUNES bodyMesh to the ids it is given,
    // so silently accepting a short stream would evict the missing body from
    // the cache and corrupt the NEXT rebuild's `known` map too.
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", ["a", "b", "c"]));
    inner.handleBinaryReply(chunkFrame("rq", "s1", 1, true, ["a", "b"]));

    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(false);
    expect(replies[0].error.message).toMatch(/incomplete/);
    expect(inner.streams.size).toBe(0);
    expect(inner.pending.size).toBe(0);
  });

  it("fails the call on a gap in the sequence", () => {
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", ["a", "b"]));
    inner.handleBinaryReply(chunkFrame("rq", "s1", 2, true, ["b"])); // seq 1 lost

    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(false);
    expect(replies[0].error.message).toMatch(/out of order/);
    expect(inner.streams.size).toBe(0);
  });

  it("fails the call when the stream id changes mid-send", () => {
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", ["a", "b"]));
    inner.handleBinaryReply(chunkFrame("rq", "OTHER", 1, false, ["a"]));

    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(false);
    expect(inner.streams.size).toBe(0);
  });

  it("starts clean when a new head arrives for a half-received stream", () => {
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", ["a", "b"]));
    inner.handleBinaryReply(chunkFrame("rq", "s1", 1, false, ["a"]));
    inner.handleBinaryReply(headFrame("rq", "s2", ["c"]));  // restart
    inner.handleBinaryReply(chunkFrame("rq", "s2", 1, true, ["c"]));

    expect(replies).toHaveLength(1);
    expect(replies[0].result.assembled.bodies.map((b: any) => b.id)).toEqual(["c"]);
  });

  it("ignores a late chunk of a stream it already abandoned", () => {
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", ["a", "b"]));
    inner.handleBinaryReply(chunkFrame("rq", "s1", 5, true, ["a"])); // aborts
    expect(replies).toHaveLength(1);
    inner.handleBinaryReply(chunkFrame("rq", "s1", 6, true, ["b"])); // stragglers
    expect(replies).toHaveLength(1); // still exactly one settlement
  });

  it("settles the call when a stream goes silent", () => {
    vi.useFakeTimers();
    try {
      const { inner, replies } = pendingGeom();
      inner.handleBinaryReply(headFrame("rq", "s1", ["a", "b"]));
      inner.handleBinaryReply(chunkFrame("rq", "s1", 1, false, ["a"]));
      expect(replies).toHaveLength(0);
      vi.advanceTimersByTime(30_000);

      expect(replies).toHaveLength(1);
      expect(replies[0].ok).toBe(false);
      expect(inner.streams.size).toBe(0);
      expect(inner.pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm the watchdog once the stream has finished", () => {
    vi.useFakeTimers();
    try {
      const { inner, replies } = pendingGeom();
      inner.handleBinaryReply(headFrame("rq", "s1", ["a"]));
      inner.handleBinaryReply(chunkFrame("rq", "s1", 1, true, ["a"]));
      vi.advanceTimersByTime(120_000);
      expect(replies).toHaveLength(1); // a stray abort would make this 2
      expect(replies[0].ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a terminal reply supersede a half-received stream", () => {
    // Two real paths reach here: the sidecar aborting mid-send (a cancel, or a
    // single body over the frame cap, both sent as terminal TEXT), and the
    // encoder failing mid-loop and falling back to a whole single frame. Either
    // way the caller must get exactly one answer, and the partial stream must
    // not linger holding a watchdog.
    const { inner, replies } = pendingGeom();
    inner.handleBinaryReply(headFrame("rq", "s1", ["a", "b"]));
    inner.handleBinaryReply(chunkFrame("rq", "s1", 1, false, ["a"]));
    expect(inner.streams.size).toBe(1);

    const parts = [fullBody("a", 0)];
    inner.handleBinaryReply(frame({
      id: "rq", ok: true,
      result: {
        protocol: 2, bbox: { min: [0, 0, 0], max: [1, 1, 1] },
        bodies: parts.map((p) => p.body),
        $buffers: [
          { dtype: "f32", len: 9 }, { dtype: "u32", len: 3 }, { dtype: "u32", len: 1 },
          { dtype: "f32", len: 6 }, { dtype: "u32", len: 1 },
        ],
      },
    }, parts[0]!.buffers));

    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(true);
    expect(inner.streams.size).toBe(0);
    expect(inner.pending.size).toBe(0);
  });

  it("leaves an unchunked single-frame reply on its old path", () => {
    const { inner, replies } = pendingGeom();
    const parts = [fullBody("a", 0)];
    inner.handleBinaryReply(frame({
      id: "rq", ok: true,
      result: {
        protocol: 2, bbox: { min: [0, 0, 0], max: [1, 1, 1] },
        bodies: parts.map((p) => p.body),
        $buffers: [
          { dtype: "f32", len: 9 }, { dtype: "u32", len: 3 }, { dtype: "u32", len: 1 },
          { dtype: "f32", len: 6 }, { dtype: "u32", len: 1 },
        ],
      },
    }, parts[0]!.buffers));

    expect(replies).toHaveLength(1);
    expect(replies[0].ok).toBe(true);
    expect(replies[0].result.bodies[0].id).toBe("a");
    expect(inner.streams.size).toBe(0);
  });
});
