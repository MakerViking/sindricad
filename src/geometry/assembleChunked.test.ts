// Incremental (chunked) assembly must be indistinguishable from single-shot.
//
// A chunked reply (sidecar/server.py's _stream_binary_reply) names every body in
// the head frame's manifest, then delivers payloads across later frames.
// RebuildAssembly plans every array offset from that manifest up front, so a
// body can be written the moment it arrives. This suite pins the two properties
// that makes safe: the output is byte-identical to assembling in one pass, and
// an assembly that is short a body FAILS rather than handing on zeroed slices.
import { describe, expect, it } from "vitest";
import { RebuildAssembly, manifestFromBodies } from "./assembly";
import type { WireBody, WireBodyFull } from "./assembly";
import type { RebuildResult } from "../types";

/** A body payload with `tris` triangles on the given faceIds — same shape as
 *  assemble.test.ts's helper, plus edges, since edge ids are also assigned by
 *  cumulative position and so are order-sensitive. */
function wireBody(id: string, faceIds: number[], edges = 1): WireBodyFull {
  const tris = faceIds.length;
  const vcount = tris + 2;
  const positions: number[] = [];
  for (let v = 0; v < vcount; v++) positions.push(v, v * 2, v * 3);
  const indices: number[] = [];
  for (let t = 0; t < tris; t++) indices.push(0, t + 1, t + 2);
  return {
    id, name: id, etag: `etag-${id}`,
    positions, indices, faceIds,
    faceCount: Math.max(...faceIds) + 1,
    faceOwners: faceIds.map((f) => `feat-${id}-${f}`),
    edges: Array.from({ length: edges }, (_, k) => ({
      points: [[k, k, k], [k + 1, k + 1, k + 1]] as [number, number, number][],
      body: id,
    })),
  };
}

const HEAD = { protocol: 2 as const, bbox: { min: [0, 0, 0], max: [1, 1, 1] } };

/** Assemble in one pass, the way a single-frame reply does. */
function singleShot(bodies: WireBody[], cache = new Map<string, WireBodyFull>()) {
  const b = RebuildAssembly.begin(HEAD, manifestFromBodies(bodies), cache, null, null);
  if (b.kind !== "stream") throw new Error(`expected stream, got ${b.kind}`);
  for (const nb of bodies) if (!nb.unchanged) expect(b.assembly.writeBody(nb)).toBe(true);
  return b.assembly;
}

/** Assemble from a manifest, writing bodies in `order` (indices into bodies). */
function chunked(bodies: WireBody[], order: number[], cache = new Map<string, WireBodyFull>()) {
  const b = RebuildAssembly.begin(HEAD, manifestFromBodies(bodies), cache, null, null);
  if (b.kind !== "stream") throw new Error(`expected stream, got ${b.kind}`);
  for (const i of order) {
    const nb = bodies[i]!;
    if (!nb.unchanged) expect(b.assembly.writeBody(nb)).toBe(true);
  }
  return b.assembly;
}

function snapshot(r: RebuildResult) {
  return {
    positions: Array.from(r.mesh.positions as Float32Array),
    indices: Array.from(r.mesh.indices as Uint32Array),
    faceIds: Array.from(r.mesh.faceIds as Uint32Array),
    edges: r.edges,
    bodies: r.bodies,
  };
}

const A = wireBody("bodyA", [0, 0, 1]);
const B = wireBody("bodyB", [0, 1, 1, 2], 2);
const C = wireBody("bodyC", [0, 1]);

describe("RebuildAssembly, incremental", () => {
  it("is byte-identical to single-shot assembly", () => {
    const one = singleShot([A, B, C]).complete()!;
    const many = chunked([A, B, C], [0, 1, 2]).complete()!;
    expect(snapshot(many)).toEqual(snapshot(one));
  });

  it("does not depend on the order bodies arrive in", () => {
    // The whole point of planning offsets from the manifest. Chunks arrive in
    // order today, but nothing downstream should depend on that.
    const one = singleShot([A, B, C]).complete()!;
    for (const order of [[2, 1, 0], [1, 0, 2], [1, 2, 0]]) {
      expect(snapshot(chunked([A, B, C], order).complete()!)).toEqual(snapshot(one));
    }
  });

  it("globalises faceIds and faceStart by manifest position, not arrival", () => {
    const r = chunked([A, B, C], [2, 0, 1]).complete()!;
    // A: faces 0,0,1 -> 0,0,1 | B: 0,1,1,2 -> +2 | C: 0,1 -> +5
    expect(Array.from(r.mesh.faceIds as Uint32Array)).toEqual([0, 0, 1, 2, 3, 3, 4, 5, 6]);
    expect(r.bodies!.map((b) => [b.id, b.faceStart, b.faceCount]))
      .toEqual([["bodyA", 0, 2], ["bodyB", 2, 3], ["bodyC", 5, 2]]);
  });

  it("numbers edges by manifest position, not arrival", () => {
    const r = chunked([A, B, C], [1, 2, 0]).complete()!;
    expect(r.edges.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3"]);
    expect(r.edges.map((e) => e.body)).toEqual(["bodyA", "bodyB", "bodyB", "bodyC"]);
  });

  it("rebases indices per body regardless of arrival order", () => {
    const one = singleShot([A, B, C]).complete()!;
    const many = chunked([A, B, C], [2, 1, 0]).complete()!;
    expect(Array.from(many.mesh.indices as Uint32Array))
      .toEqual(Array.from(one.mesh.indices as Uint32Array));
  });

  it("refuses to complete while a body is missing", () => {
    // The load-bearing guard. Returning the partially-filled result would hand
    // on zeroed slices, which render as plausible degenerate geometry — far
    // worse than an error, because nothing downstream would question it.
    const asm = chunked([A, B, C], [0, 2]);
    expect(asm.remaining).toBe(1);
    expect(asm.complete()).toBeNull();
    expect(asm.has("bodyB")).toBe(false);
    expect(asm.has("bodyA")).toBe(true);
    asm.writeBody(B);
    expect(asm.complete()).not.toBeNull();
  });

  it("is idempotent when a body is written twice", () => {
    const one = singleShot([A, B, C]).complete()!;
    const asm = chunked([A, B, C], [0, 1, 1, 2, 2]);
    expect(asm.remaining).toBe(0);
    expect(snapshot(asm.complete()!)).toEqual(snapshot(one));
  });

  it("rejects a payload whose length disagrees with the manifest", () => {
    // Without this the extra elements run past the slice and silently overwrite
    // the NEXT body's triangles.
    const asm = chunked([A, B, C], [0]);
    const fat = { ...B, faceIds: [...B.faceIds as number[], 9] };
    expect(asm.writeBody(fat as WireBodyFull)).toBe(false);
    expect(asm.has("bodyB")).toBe(false);
    // and the neighbouring body is untouched
    expect(Array.from(asm.result.mesh.faceIds as Uint32Array).slice(0, 3)).toEqual([0, 0, 1]);
  });

  it("rejects a body the manifest never named", () => {
    const asm = chunked([A, B, C], [0, 1, 2]);
    expect(asm.writeBody(wireBody("ghost", [0]))).toBe(false);
  });

  it("fills cache-backed stubs at begin, before any chunk arrives", () => {
    const cache = new Map<string, WireBodyFull>([["bodyB", B]]);
    const stub: WireBody = { id: "bodyB", name: "bodyB", etag: "etag-bodyB", unchanged: true };
    const b = RebuildAssembly.begin(HEAD, manifestFromBodies([A, stub, C]), cache, null, null);
    if (b.kind !== "stream") throw new Error("expected stream");
    expect(b.assembly.has("bodyB")).toBe(true);   // no chunk needed for it
    expect(b.assembly.remaining).toBe(2);
    b.assembly.writeBody(A);
    b.assembly.writeBody(C);
    // and the mixed result matches the all-full one exactly
    expect(snapshot(b.assembly.complete()!)).toEqual(snapshot(singleShot([A, B, C]).complete()!));
  });

  it("asks for a resync on an unbacked stub, before allocating anything", () => {
    const stub: WireBody = { id: "bodyB", name: "bodyB", etag: "etag-bodyB", unchanged: true };
    expect(RebuildAssembly.begin(HEAD, manifestFromBodies([A, stub]), new Map(), null, null))
      .toEqual({ kind: "resync" });
    // a STALE etag is just as unbacked as a missing one
    const stale = new Map<string, WireBodyFull>([["bodyB", { ...B, etag: "old" }]]);
    expect(RebuildAssembly.begin(HEAD, manifestFromBodies([A, stub]), stale, null, null))
      .toEqual({ kind: "resync" });
  });

  it("takes the no-op fast path from the manifest alone, by reference", () => {
    // This identity is what lets viewport.setModel skip a full scene rebuild on
    // an eye toggle — 0.63 s per toggle at 3,071 bodies.
    const stubs: WireBody[] = [A, B].map((b) => ({
      id: b.id, name: b.name, etag: b.etag, unchanged: true as const,
    }));
    const cache = new Map<string, WireBodyFull>([["bodyA", A], ["bodyB", B]]);
    const first = RebuildAssembly.begin(HEAD, manifestFromBodies(stubs), cache, null, null);
    if (first.kind !== "stream") throw new Error("expected stream");
    const prev = first.assembly.complete()!;

    const again = RebuildAssembly.begin(HEAD, manifestFromBodies(stubs), cache, prev, first.assembly.sig);
    expect(again.kind).toBe("noop");
    if (again.kind === "noop") expect(again.result).toBe(prev); // identity, not a copy
  });

  it("does NOT take the fast path when a non-geometry field changed", () => {
    const stubs: WireBody[] = [A].map((b) => ({
      id: b.id, name: b.name, etag: b.etag, unchanged: true as const,
    }));
    const cache = new Map<string, WireBodyFull>([["bodyA", A]]);
    const first = RebuildAssembly.begin(HEAD, manifestFromBodies(stubs), cache, null, null);
    if (first.kind !== "stream") throw new Error("expected stream");
    const prev = first.assembly.complete()!;

    const withDiag = { ...HEAD, diagnostics: [{ kind: "ambiguous nearest pick" }] } as never;
    const again = RebuildAssembly.begin(withDiag, manifestFromBodies(stubs), cache, prev, first.assembly.sig);
    expect(again.kind).toBe("stream"); // a fresh object, so setModel re-runs
  });
});
