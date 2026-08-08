// Progressive display must be a pure accelerator.
//
// The commit (viewport.setModel with the finished result) is authoritative. What
// the stream builds only counts if it is INDISTINGUISHABLE from what the commit
// would have built on its own — same bodies, same order, same geometry, same
// etags, so setModel's etag diff reuses all of it and rebuilds nothing.
//
// Headless like render.test.ts: ProgressiveModel takes a THREE.Group and a
// dispose callback, so no canvas or WebGL context is involved.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ProgressiveModel } from "./progressive";
import { buildBodyMesh, partitionMesh } from "./render";
import type { BodyMesh } from "./render";
import type { RebuildResult } from "../types";

const RES = new THREE.Vector2(800, 600);

/** A reply of `n` bodies, 2 triangles and 1 edge each, on disjoint vertices. */
function reply(n: number): RebuildResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const edges: RebuildResult["edges"] = [];
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  for (let b = 0; b < n; b++) {
    const v0 = b * 4;
    for (let v = 0; v < 4; v++) positions.push(v0 + v, v, b);
    indices.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 2, v0 + 3);
    faceIds.push(b * 2, b * 2 + 1);
    edges.push({ id: `e${b}`, points: [[b, 0, 0], [b, 1, 0]], body: `b${b}` });
    bodies.push({ id: `b${b}`, name: `b${b}`, faceStart: b * 2, faceCount: 2, etag: `etag-${b}` });
  }
  return {
    mesh: { positions, indices, faceIds },
    edges,
    bbox: { min: [0, 0, 0], max: [n, 1, 1] },
    bodies,
  };
}

function edgesByBody(r: RebuildResult, ids: string[]) {
  const m = new Map<string, RebuildResult["edges"]>();
  for (const id of ids) m.set(id, r.edges.filter((e) => e.body === id));
  return m;
}

/** Everything about a built body any consumer can observe. */
function snap(b: BodyMesh) {
  const g = b.mesh.geometry;
  return {
    id: b.id, name: b.name, etag: b.etag,
    faceStart: b.faceStart, faceCount: b.faceCount,
    faceIds: b.faceIds,
    indices: Array.from(g.getIndex()!.array),
    positions: Array.from(g.getAttribute("position").array),
    faceTriangles: [...b.faceTriangles.entries()].sort((x, y) => x[0] - y[0]),
    edgeRefs: b.edges.refs.length,
  };
}

/** What viewport.setModel builds in one shot, for the same reply. */
function commitBuild(r: RebuildResult): BodyMesh[] {
  const ids = r.bodies!.map((m) => m.id);
  const partition = partitionMesh(r, ids);
  const by = edgesByBody(r, ids);
  return r.bodies!.map((m) => buildBodyMesh(r, m, by.get(m.id) ?? [], RES, m.etag, partition));
}

/** Drive a whole stream: begin, then one append per chunk of `size` bodies. */
function stream(r: RebuildResult, size: number, prev = null, hidden = new Set<string>()) {
  const group = new THREE.Group();
  const disposed: string[] = [];
  const pm = new ProgressiveModel(group, (b) => disposed.push(b.id));
  const metas = r.bodies!;
  const box = new THREE.Box3(
    new THREE.Vector3(...r.bbox.min), new THREE.Vector3(...r.bbox.max),
  );
  pm.begin(0, metas, r, box, prev, hidden);
  const views = [];
  for (let i = 0; i < metas.length; i += size) {
    const slice = metas.slice(i, i + size);
    const ids = slice.map((m) => m.id);
    const triRange = { triStart: slice[0]!.faceStart, triEnd: slice[slice.length - 1]!.faceStart + slice[slice.length - 1]!.faceCount };
    views.push(pm.append(0, r, slice, edgesByBody(r, ids), triRange, hidden, RES));
  }
  return { pm, group, disposed, views };
}

describe("ProgressiveModel", () => {
  it("builds exactly what a one-shot commit builds", () => {
    const r = reply(6);
    const { pm } = stream(r, 2);
    expect(pm.current!.bodies.map(snap)).toEqual(commitBuild(r).map(snap));
  });

  it("keeps bodies in manifest order however they are chunked", () => {
    // applyAnalysis's "component" mode assigns hue by array INDEX, so a
    // reordered bodies array would recolour the whole model at the commit.
    const r = reply(6);
    for (const size of [1, 2, 3, 6]) {
      expect(stream(r, size).pm.current!.bodies.map((b) => b.id))
        .toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
    }
  });

  it("hands out a FRESH ModelView per installment, never a mutated one", () => {
    // render.ts's faceIndexCache and Highlighter.byId are keyed on ModelView
    // IDENTITY and documented as never needing invalidation, precisely because a
    // new reply always makes a new one. Mutating in place makes hover paint the
    // wrong body.
    const { views } = stream(reply(6), 2);
    const seen = new Set(views);
    expect(seen.size).toBe(views.length);
    expect(views.every((v) => v !== null)).toBe(true);
  });

  it("adds two scene objects per body and no more", () => {
    const { group } = stream(reply(5), 2);
    expect(group.children.length).toBe(10); // one Mesh + one LineSegments2 each
  });

  it("only counts a body once, however many times its chunk repeats", () => {
    const r = reply(3);
    const { pm, group } = stream(r, 3);
    const metas = r.bodies!;
    pm.append(0, r, metas, edgesByBody(r, metas.map((m) => m.id)),
      { triStart: 0, triEnd: 6 }, new Set(), RES);
    expect(pm.current!.bodies.length).toBe(3);
    expect(group.children.length).toBe(6);
  });

  it("ignores an installment from a stream it is no longer running", () => {
    const r = reply(4);
    const { pm } = stream(r, 4);
    const stale = pm.append(9, r, r.bodies!, new Map(), { triStart: 0, triEnd: 8 }, new Set(), RES);
    expect(stale).toBeNull();
  });

  it("respects hidden bodies as they arrive", () => {
    const r = reply(4);
    const { pm } = stream(r, 2, null, new Set(["b1", "b3"]));
    const vis = Object.fromEntries(pm.current!.bodies.map((b) => [b.id, b.mesh.visible]));
    expect(vis).toEqual({ b0: true, b1: false, b2: true, b3: false });
  });

  describe("against a previous model", () => {
    function previous(r: RebuildResult) {
      const group = new THREE.Group();
      const bodies = commitBuild(r);
      for (const b of bodies) { group.add(b.mesh); group.add(b.edges.object); }
      return { bodies, edges: [], orphanEdges: null, box: new THREE.Box3() };
    }

    it("reuses an etag-unchanged body's GPU objects untouched", () => {
      const r = reply(3);
      const prev = previous(r);
      const before = prev.bodies.map((b) => b.mesh.uuid);
      const group = new THREE.Group();
      const pm = new ProgressiveModel(group, () => {});
      pm.begin(0, r.bodies!, r, new THREE.Box3(), prev, new Set());
      // every etag matches, so nothing needs a chunk at all
      expect(pm.current!.bodies.map((b) => b.mesh.uuid)).toEqual(before);
    });

    it("disposes only bodies the manifest no longer names", () => {
      const four = reply(4);
      const prev = previous(four);
      const three = reply(3); // b3 is gone
      const disposed: string[] = [];
      const pm = new ProgressiveModel(new THREE.Group(), (b) => disposed.push(b.id));
      pm.begin(0, three.bodies!, three, new THREE.Box3(), prev, new Set());
      expect(disposed).toEqual(["b3"]);
    });

    it("holds a changed body on screen until its replacement lands", () => {
      // Otherwise an edit-stream shows a HOLE where the body used to be, for as
      // long as its chunk takes to arrive.
      const r = reply(3);
      const prev = previous(r);
      const edited = reply(3);
      edited.bodies![1]!.etag = "etag-CHANGED";
      const disposed: string[] = [];
      const group = new THREE.Group();
      const pm = new ProgressiveModel(group, (b) => disposed.push(b.id));
      pm.begin(0, edited.bodies!, edited, new THREE.Box3(), prev, new Set());

      expect(disposed).toEqual([]);              // nothing thrown away yet
      expect(group.children.length).toBe(0);     // the old one is still in prev's group
      const m = edited.bodies![1]!;
      pm.append(0, edited, [m], edgesByBody(edited, ["b1"]),
        { triStart: m.faceStart, triEnd: m.faceStart + m.faceCount }, new Set(), RES);
      expect(disposed).toEqual(["b1"]);          // swapped only once ready
      expect(pm.current!.bodies.map((b) => b.id)).toEqual(["b0", "b1", "b2"]);
    });

    it("abort tears down everything it drew, including bodies it was holding", () => {
      const r = reply(3);
      const prev = previous(r);
      const edited = reply(3);
      edited.bodies![0]!.etag = "etag-CHANGED";
      const disposed: string[] = [];
      const pm = new ProgressiveModel(new THREE.Group(), (b) => disposed.push(b.id));
      pm.begin(0, edited.bodies!, edited, new THREE.Box3(), prev, new Set());
      pm.abort();
      expect(disposed.sort()).toEqual(["b0", "b1", "b2"]);
      expect(pm.current).toBeNull();
      expect(pm.streaming).toBe(false);
    });

    it("finish() releases without disposing — the commit owns them now", () => {
      const r = reply(3);
      const disposed: string[] = [];
      const group = new THREE.Group();
      const pm = new ProgressiveModel(group, (b) => disposed.push(b.id));
      pm.begin(0, r.bodies!, r, new THREE.Box3(), null, new Set());
      pm.append(0, r, r.bodies!, edgesByBody(r, ["b0", "b1", "b2"]),
        { triStart: 0, triEnd: 6 }, new Set(), RES);
      pm.finish();
      expect(disposed).toEqual([]);
      expect(group.children.length).toBe(6); // still in the scene, now the model's
      expect(pm.streaming).toBe(false);
    });
  });
});
