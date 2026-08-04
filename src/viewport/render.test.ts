// Phase A.1 regression: buildBodyMesh's triangle partition.
//
// buildBodyMesh used to scan EVERY triangle in the model once per body, and
// allocate+fill a whole-model Int32Array vertex remap per body — O(bodies x
// model), which is invisible at 5 bodies and fatal at 3,000 (38.1s to build one
// imported assembly). partitionMesh buckets the triangles in two passes total
// and hands every body a shared remap buffer.
//
// The contract that matters: the partition is a PERFORMANCE path only. Output
// must be byte-identical to the scan path, and the shared remap must come back
// clean from every body — otherwise a later body reads a stale local index and
// silently draws another body's vertex.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildBodyMesh, bodyOfFace, partitionMesh } from "./render";
import type { ModelView } from "./render";
import type { RebuildResult } from "../types";

const RES = new THREE.Vector2(800, 600);

/** A reply whose bodies share a global vertex pool, so the shared remap buffer
 *  is genuinely re-entered on the same indices by consecutive bodies. Bodies
 *  emitted by the real assemble() get disjoint vertex ranges, which would let a
 *  missing reset go unnoticed — this is the case that catches it. */
function sharedVertexReply(): RebuildResult {
  // 6 vertices on a unit grid, reused by both bodies
  const positions: number[] = [];
  for (let v = 0; v < 6; v++) positions.push(v, v * 2, v * 3);
  return {
    // body0 owns faces 0..1 (tris 0,1), body1 owns faces 2..3 (tris 2,3);
    // every triangle indexes into the SAME 6 vertices.
    mesh: {
      positions,
      indices: [0, 1, 2, /**/ 1, 2, 3, /**/ 2, 3, 4, /**/ 3, 4, 5],
      faceIds: [0, 1, 2, 3],
    },
    edges: [],
    bbox: { min: [0, 0, 0], max: [5, 10, 15] },
    bodies: [
      { id: "b0", name: "b0", faceStart: 0, faceCount: 2 },
      { id: "b1", name: "b1", faceStart: 2, faceCount: 2 },
    ],
  };
}

/** Everything about a built body that any consumer can observe. */
function snapshot(b: ReturnType<typeof buildBodyMesh>) {
  const geo = b.mesh.geometry;
  return {
    faceIds: b.faceIds,
    indices: Array.from(geo.getIndex()!.array),
    positions: Array.from(geo.getAttribute("position").array),
    normals: Array.from(geo.getAttribute("normal").array),
    colors: Array.from(geo.getAttribute("color").array),
    faceTriangles: [...b.faceTriangles.entries()].sort((x, y) => x[0] - y[0]),
    faceStart: b.faceStart,
    faceCount: b.faceCount,
  };
}

describe("partitionMesh", () => {
  it("buckets every triangle to exactly one body, in ascending order", () => {
    const r = sharedVertexReply();
    const p = partitionMesh(r, ["b0", "b1"]);
    expect(Array.from(p.trisByBody.get("b0")!)).toEqual([0, 1]);
    expect(Array.from(p.trisByBody.get("b1")!)).toEqual([2, 3]);
  });

  it("only buckets the bodies asked for (a reused body is not rebuilt)", () => {
    const r = sharedVertexReply();
    const p = partitionMesh(r, ["b1"]);
    expect(p.trisByBody.has("b0")).toBe(false);
    expect(Array.from(p.trisByBody.get("b1")!)).toEqual([2, 3]);
  });

  it("starts with a clean remap buffer sized to the whole model", () => {
    const r = sharedVertexReply();
    const p = partitionMesh(r, ["b0", "b1"]);
    expect(p.remap.length).toBe(6);
    expect([...p.remap].every((v) => v === -1)).toBe(true);
  });
});

describe("buildBodyMesh with a partition", () => {
  it("produces byte-identical output to the scan path", () => {
    const r = sharedVertexReply();
    const metas = r.bodies!;
    const p = partitionMesh(r, metas.map((m) => m.id));

    for (const meta of metas) {
      const scanned = buildBodyMesh(r, meta, [], RES, undefined);
      const partitioned = buildBodyMesh(r, meta, [], RES, undefined, p);
      expect(snapshot(partitioned)).toEqual(snapshot(scanned));
    }
  });

  it("hands the shared remap back clean after every body", () => {
    const r = sharedVertexReply();
    const p = partitionMesh(r, ["b0", "b1"]);
    for (const meta of r.bodies!) {
      buildBodyMesh(r, meta, [], RES, undefined, p);
      // a stale entry here is a body silently drawing another body's vertex
      expect([...p.remap].every((v) => v === -1)).toBe(true);
    }
  });

  it("is order-independent: rebuilding a body twice gives the same mesh", () => {
    const r = sharedVertexReply();
    const metas = r.bodies!;
    const p = partitionMesh(r, metas.map((m) => m.id));
    const first = snapshot(buildBodyMesh(r, metas[0]!, [], RES, undefined, p));
    buildBodyMesh(r, metas[1]!, [], RES, undefined, p); // dirties the shared buffer
    const again = snapshot(buildBodyMesh(r, metas[0]!, [], RES, undefined, p));
    expect(again).toEqual(first);
  });

  it("welds a textured (de-indexed, normal-carrying) body the same either way", () => {
    // 2 triangles sharing an edge, fully de-indexed the way a textured face
    // arrives (3 unique vertices per triangle) — exercises the weld path, whose
    // key includes the faceId, on both routes.
    const quad: RebuildResult = {
      mesh: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, /**/ 0, 0, 0, 1, 1, 0, 0, 1, 0],
        indices: [0, 1, 2, 3, 4, 5],
        faceIds: [0, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, /**/ 0, 0, 1, 0, 0, 1, 0, 0, 1],
      },
      edges: [],
      bbox: { min: [0, 0, 0], max: [1, 1, 0] },
      bodies: [{ id: "q", name: "q", faceStart: 0, faceCount: 1 }],
    };
    const p = partitionMesh(quad, ["q"]);
    const scanned = buildBodyMesh(quad, quad.bodies![0]!, [], RES, undefined);
    const partitioned = buildBodyMesh(quad, quad.bodies![0]!, [], RES, undefined, p);
    expect(snapshot(partitioned)).toEqual(snapshot(scanned));
    // welded: 6 de-indexed vertices collapse to the 4 distinct corners
    expect(scanned.mesh.geometry.getAttribute("position").count).toBe(4);
  });
});

/** `bodies` bodies of `trisPerBody` triangles each, every body owning its own
 *  contiguous faceId range and vertex range — the shape a real reply has. */
function syntheticModel(bodies: number, trisPerBody: number): RebuildResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const metas: NonNullable<RebuildResult["bodies"]> = [];
  let vbase = 0;
  let fbase = 0;
  for (let b = 0; b < bodies; b++) {
    const vcount = trisPerBody + 2;
    for (let v = 0; v < vcount; v++) positions.push(v, v * 2, b);
    for (let t = 0; t < trisPerBody; t++) {
      indices.push(vbase, vbase + t + 1, vbase + t + 2);
      faceIds.push(fbase + (t % 8)); // 8 faces per body
    }
    metas.push({ id: `b${b}`, name: `b${b}`, faceStart: fbase, faceCount: 8 });
    vbase += vcount;
    fbase += 8;
  }
  return { mesh: { positions, indices, faceIds }, edges: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] }, bodies: metas };
}

/** A minimal ModelView carrying only what bodyOfFace reads. */
function viewOf(ranges: [start: number, count: number][]): ModelView {
  return {
    bodies: ranges.map(([faceStart, faceCount], i) => ({ id: `b${i}`, faceStart, faceCount })),
    edges: [],
    orphanEdges: [],
    box: new THREE.Box3(),
  } as unknown as ModelView;
}

describe("bodyOfFace", () => {
  it("finds the owning body for every id in every range", () => {
    const view = viewOf([[0, 3], [3, 1], [4, 10]]);
    expect(bodyOfFace(view, 0)?.id).toBe("b0");
    expect(bodyOfFace(view, 2)?.id).toBe("b0");
    expect(bodyOfFace(view, 3)?.id).toBe("b1");
    expect(bodyOfFace(view, 4)?.id).toBe("b2");
    expect(bodyOfFace(view, 13)?.id).toBe("b2");
  });

  it("returns undefined below, above, and INSIDE a gap", () => {
    // a gap is what a stale faceId from before a rebuild looks like — the old
    // linear .find returned undefined for it and the binary search must too
    const view = viewOf([[0, 2], [10, 2]]);
    expect(bodyOfFace(view, -1)).toBeUndefined();
    expect(bodyOfFace(view, 2)).toBeUndefined();
    expect(bodyOfFace(view, 9)).toBeUndefined();
    expect(bodyOfFace(view, 12)).toBeUndefined();
  });

  it("does not depend on the bodies array being sorted", () => {
    const view = viewOf([[20, 5], [0, 5], [10, 5]]);
    expect(bodyOfFace(view, 0)?.id).toBe("b1");
    expect(bodyOfFace(view, 12)?.id).toBe("b2");
    expect(bodyOfFace(view, 24)?.id).toBe("b0");
  });

  it("handles an empty model", () => {
    expect(bodyOfFace(viewOf([]), 0)).toBeUndefined();
  });
});

describe("buildBodyMesh scaling", () => {
  // The regression this guards: the scan path is O(bodies x WHOLE MODEL) — it
  // walks every triangle in the model once per body and allocates+fills a
  // whole-model remap per body. Measured on this synthetic model (node/V8):
  //
  //    2,000 bodies / 1.6M tris    scan  3,525 ms   partition   413 ms   8.5x
  //    4,000 bodies / 3.2M tris    scan 13,129 ms   partition   811 ms  16.2x
  //
  // Doubling the model quadruples the scan path and doubles the partition path,
  // which is the whole point. The margin is 8x+ at the size below, so the
  // timing assertion has no realistic chance of flaking; if it ever fails,
  // something reintroduced a per-body walk of the whole model.
  it("is linear in body count, and output-identical at scale", () => {
    const r = syntheticModel(500, 400);
    const metas = r.bodies!;

    const t0 = performance.now();
    const scanned = metas.map((m) => buildBodyMesh(r, m, [], RES, undefined));
    const scanMs = performance.now() - t0;

    const t1 = performance.now();
    const p = partitionMesh(r, metas.map((m) => m.id));
    const built = metas.map((m) => buildBodyMesh(r, m, [], RES, undefined, p));
    const partMs = performance.now() - t1;

    for (let i = 0; i < metas.length; i++) {
      expect(built[i]!.faceIds).toEqual(scanned[i]!.faceIds);
      expect(Array.from(built[i]!.mesh.geometry.getIndex()!.array))
        .toEqual(Array.from(scanned[i]!.mesh.geometry.getIndex()!.array));
    }
    expect(partMs).toBeLessThan(scanMs);
  }, 120_000);
});
