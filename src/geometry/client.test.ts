import { describe, expect, it } from "vitest";
import { expandPackedEdges } from "./client";

// The sidecar packs edge polylines into binary buffers (server.py's _pack_edges)
// because they are the largest tolerance-INVARIANT part of a large assembly's
// reply — 97.1 MiB across 1,726,523 points on the 356 MiB reference file, the
// same at every tolerance. server's test_ws.py proves the encoder; this proves
// the client half that has to put them back together.

describe("expandPackedEdges", () => {
  it("re-splits a packed buffer into per-edge point triples", () => {
    // two edges: one of 2 points, one of 3
    const pts = new Float32Array([
      0, 0, 0, 1, 2, 3,
      4, 5, 6, 7, 8, 9, 1.5, -2.5, 0.25,
    ]);
    const counts = new Uint32Array([2, 3]);

    expect(expandPackedEdges(pts, counts, "b1")).toEqual([
      { points: [[0, 0, 0], [1, 2, 3]], body: "b1" },
      { points: [[4, 5, 6], [7, 8, 9], [1.5, -2.5, 0.25]], body: "b1" },
    ]);
  });

  it("omits body entirely when the frame carried none", () => {
    const out = expandPackedEdges(new Float32Array([1, 2, 3]), new Uint32Array([1]), undefined);
    expect(out).toEqual([{ points: [[1, 2, 3]] }]);
    expect("body" in out[0]!).toBe(false);
  });

  it("handles an empty edge list and a zero-point edge", () => {
    expect(expandPackedEdges(new Float32Array(0), new Uint32Array(0), "b1")).toEqual([]);
    expect(expandPackedEdges(new Float32Array(0), new Uint32Array([0]), "b1")).toEqual([
      { points: [], body: "b1" },
    ]);
  });

  it("consumes the buffer exactly, so edge N starts where edge N-1 ended", () => {
    // a wrong stride would still produce the right SHAPE but shifted values —
    // this pins the offsets rather than just the counts
    const pts = new Float32Array(30);
    for (let i = 0; i < 30; i++) pts[i] = i;
    const out = expandPackedEdges(pts, new Uint32Array([1, 4, 5]), "b");
    expect(out.map((e) => e.points.length)).toEqual([1, 4, 5]);
    expect(out[0]!.points[0]).toEqual([0, 1, 2]);
    expect(out[1]!.points[0]).toEqual([3, 4, 5]);
    expect(out[2]!.points[0]).toEqual([15, 16, 17]);
    expect(out[2]!.points[4]).toEqual([27, 28, 29]);
  });
});
