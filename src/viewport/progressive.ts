// Progressive display: putting a chunked rebuild reply on screen as it arrives.
//
// The rest of the app only ever sees a FINISHED model. This is the one place
// that draws a partial one, and it exists because the alternative is worse:
// without it a large assembly shows the PREVIOUS document until the whole reply
// lands, which on the reference file is minutes of a frozen, wrong scene.
//
// The rule that keeps this safe: THE STREAM IS A PURE ACCELERATOR, THE COMMIT IS
// AUTHORITATIVE. Everything built here is keyed by body id and etag, exactly as
// viewport.setModel() builds it — so when the completed build finally arrives,
// setModel's ordinary etag diff finds every body already present, reuses all of
// them, and runs its whole-model passes once. If a chunk was dropped or this
// file got something wrong, setModel simply builds the missing bodies itself.
// Nothing here can produce a model the commit would not have produced anyway.

import * as THREE from "three";
import { buildBodyMesh, partitionMesh, resetBodyAppearance } from "./render";
import type { BodyMesh, MeshPartition, ModelView } from "./render";
import type { EdgeRef } from "./edgeLines";
import type { RebuildResult } from "../types";

type BodyMeta = NonNullable<RebuildResult["bodies"]>[number];

/** Dispose one body's GPU objects and take it out of the scene. Mirrors the
 *  disposal viewport.setModel does for a body that has gone away. */
type DisposeFn = (b: BodyMesh) => void;

export class ProgressiveModel {
  private slots: (BodyMesh | null)[] = [];
  private byId = new Map<string, number>();
  /** Bodies from the PREVIOUS model whose etag changed: kept on screen, and
   *  swapped only when their replacement lands, so an edit-stream never shows a
   *  hole where a body used to be. */
  private stale = new Map<string, BodyMesh>();
  private edges: EdgeRef[] = [];
  private box = new THREE.Box3();
  private remap: Int32Array | null = null;
  private view: ModelView | null = null;
  private epoch = -1;

  constructor(
    private readonly group: THREE.Group,
    private readonly dispose: DisposeFn,
  ) {}

  get current(): ModelView | null { return this.view; }
  get streaming(): boolean { return this.epoch >= 0; }
  get filled(): number { return this.slots.reduce((n, b) => n + (b ? 1 : 0), 0); }
  get total(): number { return this.slots.length; }

  /** Start a stream. `manifest` names every body of the reply in final order and
   *  is authoritative: a body of the previous model that it does not name is
   *  provably gone and is disposed now. */
  begin(
    epoch: number,
    manifest: BodyMeta[],
    result: RebuildResult,
    box: THREE.Box3,
    prev: ModelView | null,
    hidden: Set<string>,
  ): ModelView {
    this.abort();
    this.epoch = epoch;
    this.box = box;
    this.slots = new Array(manifest.length).fill(null);
    this.byId = new Map(manifest.map((m, i) => [m.id, i]));
    this.edges = [];
    // One scratch buffer for the WHOLE stream. buildBodyMesh hands it back
    // clean, so allocating and re-filling a model-sized Int32Array per chunk is
    // exactly the O(chunks x model) cost this avoids.
    this.remap = new Int32Array(result.mesh.positions.length / 3).fill(-1);

    const keptById = new Map<string, BodyMesh>();
    for (const b of prev?.bodies ?? []) keptById.set(b.id, b);
    for (const m of manifest) {
      const p = keptById.get(m.id);
      if (!p) continue;
      keptById.delete(m.id);
      if (m.etag !== undefined && p.etag === m.etag) {
        // unchanged: keep its GPU objects untouched. It never blinks.
        resetBodyAppearance(p);
        p.mesh.visible = !hidden.has(m.id);
        p.edges.setBodyVisible(p.mesh.visible);
        this.slots[this.byId.get(m.id)!] = p;
        this.edges.push(...p.edges.refs);
      } else {
        this.stale.set(m.id, p); // hold it on screen until its chunk lands
      }
    }
    // whatever the manifest never named is gone from this document
    for (const gone of keptById.values()) this.remove(gone);
    return this.snapshot();
  }

  /** Add the bodies one chunk delivered. Returns null if the chunk belongs to a
   *  stream we are no longer running. */
  append(
    epoch: number,
    result: RebuildResult,
    metas: BodyMeta[],
    edgesByBody: Map<string, RebuildResult["edges"]>,
    triRange: { triStart: number; triEnd: number },
    hidden: Set<string>,
    resolution: THREE.Vector2,
  ): ModelView | null {
    if (epoch !== this.epoch) return null;
    const wanted = metas.filter((m) => {
      const i = this.byId.get(m.id);
      return i !== undefined && this.slots[i] === null;
    });
    if (!wanted.length) return this.view;

    // Ranged, so the scan cannot wander into triangles this stream has not
    // written yet: those are still zeros, and zero is a legitimate faceId, so an
    // unranged pass would hand every unwritten triangle to whoever owns face 0.
    const partition: MeshPartition = partitionMesh(
      result, wanted.map((m) => m.id),
      { range: triRange, ...(this.remap ? { remap: this.remap } : {}) },
    );
    for (const m of wanted) {
      const body = buildBodyMesh(result, m, edgesByBody.get(m.id) ?? [], resolution, m.etag, partition);
      this.group.add(body.mesh);
      this.group.add(body.edges.object);
      const old = this.stale.get(m.id);
      if (old) { this.remove(old); this.stale.delete(m.id); } // atomic swap
      body.mesh.visible = !hidden.has(m.id);
      body.edges.setBodyVisible(body.mesh.visible);
      body.edges.flush();
      this.slots[this.byId.get(m.id)!] = body;
      this.edges.push(...body.edges.refs);
    }
    return this.snapshot();
  }

  /** Tear down everything this stream put on screen, including bodies it was
   *  holding from the previous model. Used when a stream cannot finish. */
  abort() {
    for (const b of this.slots) if (b) this.remove(b);
    for (const b of this.stale.values()) this.remove(b);
    this.slots = [];
    this.byId.clear();
    this.stale.clear();
    this.edges = [];
    this.remap = null;
    this.view = null;
    this.epoch = -1;
  }

  /** Stop tracking without disposing: the commit has taken ownership of every
   *  body this stream built. */
  finish() {
    this.slots = [];
    this.byId.clear();
    this.stale.clear();
    this.edges = [];
    this.remap = null;
    this.view = null;
    this.epoch = -1;
  }

  private remove(b: BodyMesh) {
    this.group.remove(b.mesh);
    this.group.remove(b.edges.object);
    this.dispose(b);
  }

  /** A FRESH ModelView object every time, reusing the same arrays by reference.
   *
   *  Not cosmetic. render.ts's faceIndexCache (backing bodyOfFace ->
   *  faceIdToBodyId -> hover and body select) and Highlighter.byId are both
   *  keyed on ModelView IDENTITY, and are documented as never needing
   *  invalidation precisely because a new reply always makes a new ModelView.
   *  Mutating one in place would leave hover painting the wrong body. The
   *  wrapper is one object literal; nothing is copied. */
  private snapshot(): ModelView {
    const bodies: BodyMesh[] = [];
    for (const b of this.slots) if (b) bodies.push(b);
    this.view = { bodies, edges: this.edges, orphanEdges: null, box: this.box };
    return this.view;
  }
}
