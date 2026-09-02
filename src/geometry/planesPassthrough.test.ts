// The `planes` header field must survive reassembly.
//
// GH #52: the sidecar re-derives a face-anchored sketch's plane every rebuild
// and reports the frame it used in `RebuildResult.planes`, keyed by feature id.
// It rides the reply HEADER, like `diagnostics` — and everything the app then
// does with it (drawing the sketch curves at the right height, and reopening the
// sketch there so closing it does not re-bake the stale plane) reads it off the
// assembled result. Dropped in reassembly, the whole fix is invisible: geometry
// is correct, the overlay is a height behind, and one re-edit silently reverts
// the anchor. Nothing raises.
//
// Two properties, both of which the sibling header fields already needed:
//   1. it reaches the assembled result at all;
//   2. it is part of the no-op signature, so a rebuild where ONLY the resolved
//      plane moved still produces a fresh object rather than the previous one by
//      reference (which setModel's identity fast path would then skip).

import { describe, expect, it } from "vitest";
import { RebuildAssembly, manifestFromBodies } from "./assembly";
import type { WireBody, WireBodyFull } from "./assembly";

const HEAD = { protocol: 2 as const, bbox: { min: [0, 0, 0], max: [1, 1, 1] } };
const PLANES = { s1: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] } };

const BODY: WireBodyFull = {
  id: "bodyA", name: "bodyA", etag: "etag-A",
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], faceIds: [0], faceCount: 1,
  edges: [],
};

function assembled(head: unknown, bodies: WireBody[]) {
  const b = RebuildAssembly.begin(head as never, manifestFromBodies(bodies), new Map(), null, null);
  if (b.kind !== "stream") throw new Error(`expected stream, got ${b.kind}`);
  for (const nb of bodies) if (!nb.unchanged) expect(b.assembly.writeBody(nb as WireBodyFull)).toBe(true);
  return b.assembly.complete()!;
}

describe("RebuildResult.planes over the wire", () => {
  it("lands on the assembled result", () => {
    expect(assembled({ ...HEAD, planes: PLANES }, [BODY]).planes).toEqual(PLANES);
  });

  it("is absent when the reply carries none", () => {
    expect("planes" in assembled(HEAD, [BODY])).toBe(false);
  });

  it("defeats the unchanged-bodies fast path on its own", () => {
    const stubs: WireBody[] = [{ id: "bodyA", name: "bodyA", etag: "etag-A", unchanged: true as const }];
    const cache = new Map<string, WireBodyFull>([["bodyA", BODY]]);
    const first = RebuildAssembly.begin(HEAD as never, manifestFromBodies(stubs), cache, null, null);
    if (first.kind !== "stream") throw new Error("expected stream");
    const prev = first.assembly.complete()!;

    // Same bodies, same etags, same bbox — only the resolved plane moved, which
    // is exactly what a height edit under an anchored sketch produces.
    const moved = { ...HEAD, planes: PLANES };
    const again = RebuildAssembly.begin(moved as never, manifestFromBodies(stubs), cache, prev, first.assembly.sig);
    expect(again.kind).toBe("stream");
  });
});
