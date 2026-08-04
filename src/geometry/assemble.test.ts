// Regression: protocol-v2 assembly of MULTI-BODY replies.
//
// `mesh.indices` carries 3 entries per triangle but `mesh.faceIds` carries ONE.
// A single shared write cursor for both (the bug this suite pins) sized faceIds
// 3x too large and scattered every body after the first past the end of the
// triangle range — so buildBodyMesh's `fid >= faceStart && fid < faceEnd` filter
// matched nothing for them and they rendered as edges with no surface.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Geometry } from "./client";
import { buildBodyMesh } from "../viewport/render";
import type { RebuildResult } from "../types";

/** A body payload with `tris` triangles, each on the faceId given by `faceIds`.
 *  Geometry is throwaway (a fan off vertex 0) — only the array arities matter. */
function wireBody(id: string, faceIds: number[]) {
  const tris = faceIds.length;
  const vcount = tris + 2;
  const positions: number[] = [];
  for (let v = 0; v < vcount; v++) positions.push(v, v * 2, v * 3);
  const indices: number[] = [];
  for (let t = 0; t < tris; t++) indices.push(0, t + 1, t + 2);
  return {
    id,
    name: id,
    etag: `etag-${id}`,
    positions,
    indices,
    faceIds,
    faceCount: Math.max(...faceIds) + 1,
    edges: [],
  };
}

/** assemble() is private (no socket is opened by the constructor, so this is a
 *  pure function call on a fresh instance). */
function assemble(bodies: ReturnType<typeof wireBody>[]): RebuildResult {
  const g = new Geometry();
  const out = (
    g as unknown as { assemble(r: unknown): RebuildResult | null }
  ).assemble({ protocol: 2, bodies, bbox: { min: [0, 0, 0], max: [1, 1, 1] } });
  expect(out).not.toBeNull();
  return out as RebuildResult;
}

const A = wireBody("bodyA", [0, 0, 1]); // 3 tris over 2 faces
const B = wireBody("bodyB", [0, 1, 1, 2]); // 4 tris over 3 faces

describe("assemble (protocol v2, multi-body)", () => {
  it("emits one faceId per triangle, not one per index", () => {
    const r = assemble([A, B]);
    expect(r.mesh.indices.length).toBe(21); // 7 triangles x 3
    expect(r.mesh.faceIds.length).toBe(7);
    expect(r.mesh.positions.length).toBe(33); // 11 vertices x 3 (5 + 6)
  });

  it("offsets each body's faceIds by the running face base, contiguously", () => {
    const r = assemble([A, B]);
    // A keeps 0..1; B's local 0,1,1,2 shift by A's faceCount (2) to 2,3,3,4
    expect(Array.from(r.mesh.faceIds)).toEqual([0, 0, 1, 2, 3, 3, 4]);
    expect(r.bodies).toEqual([
      expect.objectContaining({ id: "bodyA", faceStart: 0, faceCount: 2 }),
      expect.objectContaining({ id: "bodyB", faceStart: 2, faceCount: 3 }),
    ]);
  });

  it("offsets each body's vertex indices by the running vertex base", () => {
    const r = assemble([A, B]);
    // B's 6 vertices start at 5 (A has 5), so its fan reads 5,6,7 / 5,7,8 / ...
    expect(Array.from(r.mesh.indices.slice(9))).toEqual([5, 6, 7, 5, 7, 8, 5, 8, 9, 5, 9, 10]);
  });

  it("gives EVERY body a non-empty mesh, accounting for all triangles", () => {
    const r = assemble([A, B]);
    const res = new THREE.Vector2(800, 600);
    const built = (r.bodies ?? []).map((m) => buildBodyMesh(r, m, [], res, m.etag));
    const tris = built.map((b) => (b.mesh.geometry.getIndex()?.count ?? 0) / 3);
    expect(tris).toEqual([3, 4]);
    // no triangle is dropped or double-counted across the bodies
    expect(tris.reduce((a, b) => a + b, 0)).toBe(r.mesh.faceIds.length);
    for (const b of built) expect(b.mesh.geometry.getAttribute("position").count).toBeGreaterThan(0);
  });

  it("keeps each body's faceId -> local triangle map inside its own buffers", () => {
    const r = assemble([A, B]);
    const res = new THREE.Vector2(800, 600);
    const b = buildBodyMesh(r, (r.bodies ?? [])[1]!, [], res, undefined);
    // bodyB owns global faces 2,3,4 and its triangle indices are body-local
    expect([...b.faceTriangles.keys()].sort()).toEqual([2, 3, 4]);
    expect(b.faceTriangles.get(3)).toEqual([1, 2]);
    expect(b.faceIds).toEqual([2, 3, 3, 4]);
  });

  it("still assembles a lone body correctly (the case that masked the bug)", () => {
    const r = assemble([A]);
    expect(r.mesh.faceIds.length).toBe(3);
    expect(Array.from(r.mesh.faceIds)).toEqual([0, 0, 1]);
  });
});

// Regression: an "unchanged" stub carries its OWN identity.
//
// assemble() backs a stub with the CACHED mesh for that etag, then used to read
// id/name straight off that cached payload — so anything the sidecar changed
// without changing the geometry was discarded. `name` was already wrong this
// way and only looked right because a rename changes the etag, which turns the
// body back into a full payload. `nodeRef` (the imported assembly tree) has no
// such luck: on an assembly rebuild almost every body arrives as a stub.
describe("assemble (protocol v2, unchanged stubs)", () => {
  /** Prime the client's per-body mesh cache, then feed it a stub. */
  function assembleWithCache(
    first: ReturnType<typeof wireBody>[],
    second: unknown[],
  ): RebuildResult {
    const g = new Geometry();
    const call = (r: unknown) =>
      (g as unknown as { assemble(r: unknown): RebuildResult | null }).assemble(r);
    const bbox = { min: [0, 0, 0], max: [1, 1, 1] };
    expect(call({ protocol: 2, bodies: first, bbox })).not.toBeNull();
    const out = call({ protocol: 2, bodies: second, bbox });
    expect(out).not.toBeNull();
    return out as RebuildResult;
  }

  it("takes id, name and nodeRef from the stub, not from the cached mesh", () => {
    const cached = { ...wireBody("bodyA", [0, 0, 1]), name: "Old Name", nodeRef: "f1/7" };
    const r = assembleWithCache(
      [cached],
      [{ id: "bodyA", name: "M3 Nut (x3) 1", etag: "etag-bodyA", nodeRef: "f1/2", unchanged: true }],
    );
    const body = (r.bodies ?? [])[0]!;
    expect(body.name).toBe("M3 Nut (x3) 1");
    expect(body.nodeRef).toBe("f1/2");
    // the geometry still comes from the cache
    expect(r.mesh.faceIds.length).toBe(3);
  });

  it("carries nodeRef through a rebuild where every body is unchanged", () => {
    const a = { ...wireBody("bodyA", [0, 0, 1]), nodeRef: "f1/1" };
    const b = { ...wireBody("bodyB", [0, 1, 1, 2]), nodeRef: "f1/2" };
    const r = assembleWithCache(
      [a, b],
      [
        { id: "bodyA", name: "bodyA", etag: "etag-bodyA", nodeRef: "f1/1", unchanged: true },
        { id: "bodyB", name: "bodyB", etag: "etag-bodyB", nodeRef: "f1/2", unchanged: true },
      ],
    );
    expect((r.bodies ?? []).map((x) => x.nodeRef)).toEqual(["f1/1", "f1/2"]);
  });

  it("omits nodeRef entirely for a body that has none", () => {
    const r = assembleWithCache(
      [wireBody("bodyA", [0, 0, 1])],
      [{ id: "bodyA", name: "bodyA", etag: "etag-bodyA", unchanged: true }],
    );
    expect("nodeRef" in ((r.bodies ?? [])[0]!)).toBe(false);
  });
});
